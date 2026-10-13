import {
  BadGatewayException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { TemplateReviewClient } from './template-review.client';

const KEY = 'super-secret-admin-key-value';

function client(
  overrides: Partial<{ adminKey: string; adminBaseUrl: string }> = {},
) {
  const config = {
    get: () => ({
      apiCore: {
        adminKey: KEY,
        adminBaseUrl: 'http://api-core:3001/v1/',
        timeoutMs: 1000,
        ...overrides,
      },
    }),
  };
  return new TemplateReviewClient(config as never);
}

function reply(status: number, body: unknown) {
  return Promise.resolve(
    new Response(body === null ? '' : JSON.stringify(body), { status }),
  );
}

describe('TemplateReviewClient', () => {
  const fetchSpy = jest.spyOn(global, 'fetch');
  afterEach(() => fetchSpy.mockReset());

  it('refuses to call api-core when the key is not configured', async () => {
    await expect(
      client({ adminKey: '' }).queue('IN_REVIEW'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends the key as x-admin-key and builds the url without a double slash', async () => {
    fetchSpy.mockReturnValue(reply(200, []));
    await client().queue('IN_REVIEW');
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(
      'http://api-core:3001/v1/admin/templates/queue?status=IN_REVIEW',
    );
    expect((init!.headers as Record<string, string>)['x-admin-key']).toBe(KEY);
  });

  it('puts the reviewer and decision where api-core reads them', async () => {
    fetchSpy.mockReturnValue(reply(200, { id: 't1', status: 'REJECTED' }));
    await client().decide('t 1', 'console:abc', {
      approve: false,
      reason: 'No.',
    });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(
      'http://api-core:3001/v1/admin/templates/t%201/decision?reviewer=console%3Aabc',
    );
    expect(init!.method).toBe('POST');
    expect(JSON.parse(init!.body as string)).toEqual({
      approve: false,
      reason: 'No.',
    });
  });

  it('maps api-core errors to the right status', async () => {
    fetchSpy.mockReturnValueOnce(reply(404, { message: 'Template not found' }));
    await expect(client().get('x')).rejects.toBeInstanceOf(NotFoundException);
    fetchSpy.mockReturnValueOnce(reply(400, { message: ['bad', 'worse'] }));
    await expect(client().get('x')).rejects.toThrow('bad; worse');
    fetchSpy.mockReturnValueOnce(reply(409, { message: 'already' }));
    await expect(client().get('x')).rejects.toBeInstanceOf(ConflictException);
    fetchSpy.mockReturnValueOnce(reply(500, { message: 'boom' }));
    await expect(client().get('x')).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('never repeats api-core’s credential wording or the key to the console', async () => {
    fetchSpy.mockReturnValue(
      reply(403, { message: `Invalid admin credentials ${KEY}` }),
    );
    const error = await client()
      .queue('IN_REVIEW')
      .catch((e: Error) => e);
    expect(error).toBeInstanceOf(BadGatewayException);
    expect(
      JSON.stringify((error as BadGatewayException).getResponse()),
    ).not.toContain(KEY);
    expect((error as Error).message).not.toMatch(/Invalid admin credentials/);
  });

  it('reports an unreachable api-core without exposing the cause', async () => {
    fetchSpy.mockRejectedValue(new Error(`connect ECONNREFUSED ${KEY}`));
    const error = await client()
      .queue('IN_REVIEW')
      .catch((e: Error) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(
      JSON.stringify((error as ServiceUnavailableException).getResponse()),
    ).not.toContain(KEY);
  });
});

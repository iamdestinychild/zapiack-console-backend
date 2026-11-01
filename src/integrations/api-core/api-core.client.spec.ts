import { ServiceUnavailableException } from '@nestjs/common';
import { ApiCoreClient } from './api-core.client';

const build = (apiCore: Record<string, unknown>) =>
  new ApiCoreClient({ get: () => ({ apiCore }) } as never);

const realFetch = global.fetch;
const ctx = { actorId: 's1', actorEmail: 'a@b.c' };

describe('ApiCoreClient configuration', () => {
  it('says what is missing instead of sending an unsigned command', async () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy;
    const client = build({
      baseUrl: 'http://api-core',
      serviceToken: '',
      signingSecret: '',
      timeoutMs: 1000,
    });

    const attempt = client.forceLogout('acc', ctx);

    await expect(attempt).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(attempt).rejects.toThrow('API_CORE_SERVICE_TOKEN');
    expect(fetchSpy).not.toHaveBeenCalled();
    global.fetch = realFetch;
  });
});

describe('ApiCoreClient missing routes', () => {
  it('reports an unbuilt endpoint as unsupported, not as a raw 404', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          message: 'Cannot POST /internal/v1/accounts/a/force-logout',
        }),
        { status: 404 },
      ),
    );
    const client = build({
      baseUrl: 'http://api-core',
      serviceToken: 't',
      signingSecret: 's',
      timeoutMs: 1000,
    });

    await expect(client.forceLogout('a', ctx)).rejects.toMatchObject({
      status: 501,
    });
    global.fetch = realFetch;
  });
});

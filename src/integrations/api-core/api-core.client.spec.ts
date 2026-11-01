import { ServiceUnavailableException } from '@nestjs/common';
import { ApiCoreClient } from './api-core.client';

const build = (apiCore: Record<string, unknown>) =>
  new ApiCoreClient({ get: () => ({ apiCore }) } as never);

const ctx = { actorId: 's1', actorEmail: 'a@b.c' };

describe('ApiCoreClient configuration', () => {
  it('says what is missing instead of sending an unsigned command', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
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
    fetchSpy.mockRestore();
  });
});

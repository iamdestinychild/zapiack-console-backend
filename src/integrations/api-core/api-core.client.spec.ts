import { createHmac } from 'node:crypto';
import { ApiCoreClient } from './api-core.client';

const SECRET = 'shh';
const build = () =>
  new ApiCoreClient({ get: () => ({ apiCore: { signingSecret: SECRET } }) } as never);
const sign = (timestamp: string, method: string, path: string, body: string) =>
  createHmac('sha256', SECRET).update(`${timestamp}.${method}.${path}.${body}`).digest('hex');

describe('ApiCoreClient inbound signatures', () => {
  const body = '{"a":1}';

  it('accepts a fresh, correctly signed request', () => {
    const ts = Date.now().toString();
    expect(build().verifySignature(ts, 'POST', '/events', body, sign(ts, 'POST', '/events', body))).toBe(true);
  });

  it('refuses a changed body, a wrong secret and a stale timestamp', () => {
    const ts = Date.now().toString();
    const good = sign(ts, 'POST', '/events', body);
    expect(build().verifySignature(ts, 'POST', '/events', '{"a":2}', good)).toBe(false);
    expect(build().verifySignature(ts, 'POST', '/events', body, 'x'.repeat(good.length))).toBe(false);
    const old = (Date.now() - 10 * 60_000).toString();
    expect(build().verifySignature(old, 'POST', '/events', body, sign(old, 'POST', '/events', body))).toBe(false);
  });
});

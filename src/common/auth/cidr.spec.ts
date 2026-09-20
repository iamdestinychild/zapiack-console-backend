import { ipInCidr } from './cidr';

describe('role IP allowlist matching', () => {
  it('matches inside a /24', () => {
    expect(ipInCidr('102.89.23.14', '102.89.23.0/24')).toBe(true);
    expect(ipInCidr('102.89.24.14', '102.89.23.0/24')).toBe(false);
  });

  it('treats a bare address as /32', () => {
    expect(ipInCidr('102.89.23.14', '102.89.23.14')).toBe(true);
    expect(ipInCidr('102.89.23.15', '102.89.23.14')).toBe(false);
  });

  it('matches everything on /0', () => {
    expect(ipInCidr('8.8.8.8', '0.0.0.0/0')).toBe(true);
  });

  it('handles the high-bit addresses that break naive shifts', () => {
    expect(ipInCidr('255.255.255.255', '255.255.255.0/24')).toBe(true);
    expect(ipInCidr('200.0.0.1', '128.0.0.0/1')).toBe(true);
  });

  it('rejects malformed input rather than matching it', () => {
    expect(ipInCidr('not-an-ip', '10.0.0.0/8')).toBe(false);
    expect(ipInCidr('10.0.0.1', 'garbage')).toBe(false);
    expect(ipInCidr('10.0.0.1', '10.0.0.0/33')).toBe(false);
    expect(ipInCidr('300.1.1.1', '300.1.1.0/24')).toBe(false);
  });
});

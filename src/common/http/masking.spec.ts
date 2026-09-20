import {
  maskApiKeyPrefix,
  maskDestination,
  maskEmail,
  maskIp,
  maskPhone,
} from './masking';

describe('PII masking', () => {
  it('keeps the domain but hides the mailbox', () => {
    expect(maskEmail('adeola@zapiack.com')).toBe('ad****@zapiack.com');
  });

  it('never returns the original email unchanged', () => {
    for (const email of ['a@b.com', 'ab@b.com', 'abc@b.com']) {
      expect(maskEmail(email)).not.toBe(email);
    }
  });

  it('leaves only the last three digits of a phone number', () => {
    expect(maskPhone('+2348012345678')).toBe('***********678');
  });

  it('reduces IPv4 to a network-level hint', () => {
    expect(maskIp('102.89.23.14')).toBe('102.89.x.x');
  });

  it('masks an IPv4-mapped address as the IPv4 address it is', () => {
    // Dual-stack sockets report IPv4 clients this way; treating it as IPv6 would
    // discard the two octets the ops team actually reads.
    expect(maskIp('::ffff:102.89.23.14')).toBe('102.89.x.x');
  });

  it('reduces IPv6 to its routing prefix', () => {
    expect(maskIp('2001:db8:85a3:8d3:1319:8a2e:370:7348')).toBe(
      '2001:db8:85a3::/48',
    );
  });

  it('passes null through rather than inventing a value', () => {
    expect(maskEmail(null)).toBeNull();
    expect(maskPhone(undefined)).toBeNull();
    expect(maskIp(null)).toBeNull();
  });

  it('picks the right mask for a campaign destination', () => {
    expect(maskDestination('adeola@zapiack.com')).toContain('@zapiack.com');
    expect(maskDestination('+2348012345678')).toBe('***********678');
  });

  it('shows enough of an API key to identify it and no more', () => {
    expect(maskApiKeyPrefix('zpk_live_9f3a7c2b1d')).toBe('zpk_live…');
  });
});

import { riskLevel, riskScore } from './customers.service';

describe('risk score', () => {
  it('is zero and low with no open flags', () => {
    expect(riskScore([])).toBe(0);
    expect(riskLevel([])).toBe('low');
  });

  it('grows with severity and never passes 100', () => {
    expect(riskLevel(['LOW'])).toBe('low');
    expect(riskLevel(['MEDIUM'])).toBe('medium');
    expect(riskLevel(['HIGH'])).toBe('high');
    expect(riskScore(['CRITICAL', 'CRITICAL'])).toBe(100);
  });
});

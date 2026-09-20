import { PasswordService } from './password.service';

describe('PasswordService', () => {
  const service = new PasswordService();

  it('verifies a password it hashed', async () => {
    const hash = await service.hash('Correct-Horse-Battery-9!');
    await expect(
      service.verify('Correct-Horse-Battery-9!', hash),
    ).resolves.toBe(true);
  });

  it('rejects the wrong password', async () => {
    const hash = await service.hash('Correct-Horse-Battery-9!');
    await expect(
      service.verify('correct-horse-battery-9!', hash),
    ).resolves.toBe(false);
  });

  it('salts, so the same password hashes differently each time', async () => {
    const [a, b] = await Promise.all([
      service.hash('Sa3me-Password!'),
      service.hash('Sa3me-Password!'),
    ]);
    expect(a).not.toBe(b);
  });

  it('encodes its parameters so they can be raised later', async () => {
    expect(await service.hash('Sa3me-Password!')).toMatch(
      /^scrypt\$65536\$8\$1\$/,
    );
  });

  it('refuses a hash in an unknown format rather than trusting it', async () => {
    await expect(service.verify('anything', 'bcrypt$whatever')).resolves.toBe(
      false,
    );
  });

  it('names every strength rule a weak password breaks', () => {
    expect(service.validateStrength('short')).toEqual([
      'must be at least 12 characters',
      'must contain an uppercase letter',
      'must contain a digit',
      'must contain a symbol',
    ]);
    expect(service.validateStrength('Correct-Horse-Battery-9!')).toEqual([]);
  });
});

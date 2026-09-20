import { Injectable } from '@nestjs/common';
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

// OWASP-recommended scrypt parameters. Encoded into the hash so they can be raised
// later without invalidating existing passwords.
const PARAMS = { N: 2 ** 16, r: 8, p: 1, maxmem: 128 * 2 ** 16 * 8 * 2 };
const KEY_LENGTH = 64;

/** Password hashing for staff accounts. Staff are the only principals with passwords here. */
@Injectable()
export class PasswordService {
  async hash(password: string): Promise<string> {
    const salt = randomBytes(16);
    const derived = await scrypt(password, salt, KEY_LENGTH, PARAMS);
    return [
      'scrypt',
      PARAMS.N,
      PARAMS.r,
      PARAMS.p,
      salt.toString('base64'),
      derived.toString('base64'),
    ].join('$');
  }

  async verify(password: string, stored: string): Promise<boolean> {
    const [scheme, n, r, p, saltB64, hashB64] = stored.split('$');
    if (scheme !== 'scrypt') return false;

    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const derived = await scrypt(password, salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 128 * Number(n) * Number(r) * 2,
    });
    return (
      derived.length === expected.length && timingSafeEqual(derived, expected)
    );
  }

  /** Rejects the passwords that make a staff console worth attacking. */
  validateStrength(password: string): string[] {
    const problems: string[] = [];
    if (password.length < 12) problems.push('must be at least 12 characters');
    if (!/[a-z]/.test(password))
      problems.push('must contain a lowercase letter');
    if (!/[A-Z]/.test(password))
      problems.push('must contain an uppercase letter');
    if (!/\d/.test(password)) problems.push('must contain a digit');
    if (!/[^\w\s]/.test(password)) problems.push('must contain a symbol');
    return problems;
  }
}

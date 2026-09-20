import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { generateSecret, generateURI, verify } from 'otplib';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import * as QRCode from 'qrcode';
import type { AdminConfig } from '../../common/config/configuration';

/** One 30-second step of drift either way: covers clock skew without widening the window. */
const EPOCH_TOLERANCE_SECONDS = 30;

/**
 * TOTP is mandatory for every staff account. Secrets are encrypted at rest with a key
 * derived from the admin JWT secret, so a database dump alone does not hand an
 * attacker working second factors.
 */
@Injectable()
export class TotpService {
  private readonly key: Buffer;
  private readonly issuer: string;

  constructor(config: ConfigService<{ admin: AdminConfig }, true>) {
    const admin = config.get('admin', { infer: true });
    this.issuer = admin.auth.totpIssuer;
    this.key = createHash('sha256')
      .update(`totp:${admin.session.jwtSecret}`)
      .digest();
  }

  generateSecret(): string {
    return generateSecret();
  }

  async verify(secretPlaintext: string, token: string): Promise<boolean> {
    try {
      const result = await verify({
        secret: secretPlaintext,
        token: token.replace(/\s/g, ''),
        epochTolerance: EPOCH_TOLERANCE_SECONDS,
      });
      return result.valid;
    } catch {
      return false;
    }
  }

  async enrolmentQrCode(email: string, secret: string): Promise<string> {
    const uri = generateURI({ issuer: this.issuer, label: email, secret });
    return QRCode.toDataURL(uri);
  }

  encrypt(secret: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return [
      iv.toString('base64'),
      cipher.getAuthTag().toString('base64'),
      enc.toString('base64'),
    ].join('.');
  }

  decrypt(stored: string): string {
    const [ivB64, tagB64, dataB64] = stored.split('.');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key,
      Buffer.from(ivB64, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }
}

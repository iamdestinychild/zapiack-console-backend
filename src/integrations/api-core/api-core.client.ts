import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AdminConfig } from '../../common/config/configuration';

/**
 * Verifies the signed requests api-core sends to admin-core (the inbound events route): an HMAC over
 * timestamp + method + path + body, which stops a leaked token alone from being replayable.
 *
 * It used to also send commands to api-core's `/internal/v1/...`, a surface api-core never built. Every console action
 * that needs api-core now goes through its admin routes (see TemplateReviewClient), so those methods are gone.
 */
@Injectable()
export class ApiCoreClient {
  private readonly cfg: AdminConfig['apiCore'];

  constructor(config: ConfigService<{ admin: AdminConfig }, true>) {
    this.cfg = config.get('admin', { infer: true }).apiCore;
  }

  private sign(
    timestamp: string,
    method: string,
    path: string,
    body: string,
  ): string {
    return createHmac('sha256', this.cfg.signingSecret)
      .update(`${timestamp}.${method}.${path}.${body}`)
      .digest('hex');
  }

  /** Exposed for the inbound webhook route, which verifies signatures the same way. */
  verifySignature(
    timestamp: string,
    method: string,
    path: string,
    body: string,
    presented: string,
  ) {
    const expected = Buffer.from(this.sign(timestamp, method, path, body));
    const actual = Buffer.from(presented);
    if (expected.length !== actual.length) return false;
    if (Math.abs(Date.now() - Number(timestamp)) > 5 * 60_000) return false;
    return timingSafeEqual(expected, actual);
  }
}

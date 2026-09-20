import {
  BadGatewayException,
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AdminConfig } from '../../common/config/configuration';

/**
 * Every change to product data goes through api-core, so ledger, idempotency and
 * balance rules live in exactly one place. admin-core never writes the Zapiack DB.
 *
 * Requests carry a service token plus an HMAC over timestamp + method + path + body,
 * which stops a leaked token alone from being replayable.
 */
@Injectable()
export class ApiCoreClient {
  private readonly logger = new Logger(ApiCoreClient.name);
  private readonly cfg: AdminConfig['apiCore'];

  constructor(config: ConfigService<{ admin: AdminConfig }, true>) {
    this.cfg = config.get('admin', { infer: true }).apiCore;
  }

  // -------------------------------------------------------------- customer actions

  suspendAccount(accountId: string, reason: string, ctx: CommandContext) {
    return this.post(`/accounts/${accountId}/suspend`, { reason }, ctx);
  }

  reactivateAccount(accountId: string, reason: string, ctx: CommandContext) {
    return this.post(`/accounts/${accountId}/reactivate`, { reason }, ctx);
  }

  forceLogout(accountId: string, ctx: CommandContext) {
    return this.post<{ revokedSessions: number }>(
      `/accounts/${accountId}/force-logout`,
      {},
      ctx,
    );
  }

  revokeApiKey(
    accountId: string,
    apiKeyId: string,
    reason: string,
    ctx: CommandContext,
  ) {
    return this.post(
      `/accounts/${accountId}/api-keys/${apiKeyId}/revoke`,
      { reason },
      ctx,
    );
  }

  changePlan(
    accountId: string,
    planId: string,
    reason: string,
    ctx: CommandContext,
  ) {
    return this.post<{ subscriptionId: string }>(
      `/accounts/${accountId}/plan`,
      { planId, reason },
      ctx,
    );
  }

  resetRateLimits(accountId: string, ctx: CommandContext) {
    return this.post(`/accounts/${accountId}/rate-limits/reset`, {}, ctx);
  }

  // -------------------------------------------------------------- ledger

  /**
   * Applies a credit or debit. The idempotency key is the adjustment row's own key,
   * so a retry after a timeout can never double-post to the ledger.
   */
  adjustCredit(
    accountId: string,
    input: {
      direction: 'CREDIT' | 'DEBIT';
      amountNgn: string;
      reason: string;
      adjustmentId: string;
    },
    ctx: CommandContext,
  ) {
    return this.post<{ transactionId: string; balanceAfter: string }>(
      `/accounts/${accountId}/credit-adjustments`,
      input,
      ctx,
    );
  }

  // -------------------------------------------------------------- pricing

  upsertChannelPricing(
    input: {
      channel: string;
      planId?: string;
      accountId?: string;
      country?: string;
      network?: string;
      unitPriceNgn: string;
      effectiveFrom: string;
      effectiveTo?: string;
    },
    ctx: CommandContext,
  ) {
    return this.post<{ id: string }>('/pricing', input, ctx);
  }

  upsertPlan(input: Record<string, unknown>, ctx: CommandContext) {
    return this.post<{ id: string }>('/plans', input, ctx);
  }

  // -------------------------------------------------------------- sender IDs

  setSenderIdStatus(
    applicationId: string,
    input: { status: string; reason?: string },
    ctx: CommandContext,
  ) {
    return this.post(`/sender-ids/${applicationId}/status`, input, ctx);
  }

  // -------------------------------------------------------------- notifications

  /** In-app notifications are written as customer inbox rows by api-core, not by us. */
  createInAppNotifications(
    input: {
      accountIds: string[];
      title: string;
      body: string;
      link?: string;
      campaignId: string;
    },
    ctx: CommandContext,
  ) {
    return this.post<{ created: number }>('/notifications/in-app', input, ctx);
  }

  // -------------------------------------------------------------- transport

  private async post<T = unknown>(
    path: string,
    body: Record<string, unknown>,
    ctx: CommandContext,
  ): Promise<T> {
    const url = `${this.cfg.baseUrl}${path}`;
    const payload = JSON.stringify(body);
    const timestamp = Date.now().toString();
    const idempotencyKey = ctx.idempotencyKey ?? randomUUID();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.cfg.serviceToken}`,
          'x-admin-signature': this.sign(timestamp, 'POST', path, payload),
          'x-admin-timestamp': timestamp,
          'x-idempotency-key': idempotencyKey,
          // api-core records which staff member stood behind the command.
          'x-actor-id': ctx.actorId,
          'x-actor-email': ctx.actorEmail,
          'x-request-id': ctx.requestId ?? randomUUID(),
        },
        body: payload,
      });

      const text = await response.text();
      const parsed = text ? safeJson(text) : null;

      if (!response.ok) {
        this.logger.warn(
          `api-core ${path} -> ${response.status}: ${text.slice(0, 500)}`,
        );
        throw new HttpException(
          {
            message:
              (parsed as { message?: string })?.message ??
              `api-core rejected the command`,
            upstreamStatus: response.status,
          },
          // 4xx from api-core is a problem with what we sent; 5xx is an upstream outage.
          response.status >= 400 && response.status < 500
            ? response.status
            : 502,
        );
      }

      return parsed as T;
    } catch (err) {
      if (err instanceof HttpException) throw err;
      if ((err as Error).name === 'AbortError') {
        throw new ServiceUnavailableException(
          `api-core timed out after ${this.cfg.timeoutMs}ms`,
        );
      }
      throw new BadGatewayException(
        `api-core unreachable: ${(err as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }
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

export interface CommandContext {
  actorId: string;
  actorEmail: string;
  idempotencyKey?: string;
  requestId?: string;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

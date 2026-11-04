import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AdminConfig } from '../../common/config/configuration';

/** A template as api-core presents it to a reviewer. */
export interface ApiCoreTemplate {
  id: string;
  templateId: string;
  name: string;
  slug: string;
  category: string;
  subject: string | null;
  projectId: string;
  variables: unknown;
  status: string;
  rejectionReason: string | null;
  reviewNotes: string | null;
  submittedAt: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
  accountId?: string;
  project?: { id: string; name: string } | null;
  /** Only on the single-template read: the rendered body, from S3. */
  html?: string | null;
}

/** A row of api-core's service availability table. */
export interface ApiCoreAvailabilityRule {
  id: string;
  accountCountry: string;
  service: string;
  destinationCountry: string;
  enabled: boolean;
  note: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * api-core's template review routes (`/v1/admin/templates/*`).
 *
 * Template review stays in api-core because that is where a decision has to be made
 * correctly: it enforces the lifecycle, reads the body from S3, and tells the
 * customer's open dashboard that their template changed. admin-core adds who may
 * review, an audit trail and the request shape the console wants.
 *
 * These routes are guarded by a shared key sent as `x-admin-key`, not by the signed
 * service token the other api-core calls use. The key is never logged and never
 * appears in an error message returned to the console.
 */
@Injectable()
export class TemplateReviewClient {
  private readonly logger = new Logger(TemplateReviewClient.name);
  private readonly cfg: AdminConfig['apiCore'];

  constructor(config: ConfigService<{ admin: AdminConfig }, true>) {
    this.cfg = config.get('admin', { infer: true }).apiCore;
  }

  get configured(): boolean {
    return Boolean(this.cfg.adminKey && this.cfg.adminBaseUrl);
  }

  /** One status at a time: that is what api-core's queue accepts. */
  queue(status: string): Promise<ApiCoreTemplate[]> {
    return this.call<ApiCoreTemplate[]>(
      'GET',
      `/admin/templates/queue?status=${encodeURIComponent(status)}`,
    );
  }

  get(id: string): Promise<ApiCoreTemplate> {
    return this.call<ApiCoreTemplate>(
      'GET',
      `/admin/templates/${encodeURIComponent(id)}`,
    );
  }

  /** `reviewer` is recorded on the template as who decided. */
  decide(
    id: string,
    reviewer: string,
    input: { approve: boolean; reason?: string },
  ): Promise<ApiCoreTemplate> {
    return this.call<ApiCoreTemplate>(
      'POST',
      `/admin/templates/${encodeURIComponent(id)}/decision?reviewer=${encodeURIComponent(reviewer)}`,
      input,
    );
  }

  /**
   * Asks api-core to write the letters to the networks for a sender-ID application, from what it already holds. api-core
   * writes them only when nothing a letter needs is missing, and answers with what is when something is.
   */
  generateSenderIdLetters(
    applicationId: string,
    force = false,
  ): Promise<{
    generated: boolean;
    reason: 'MISSING_FIELDS' | 'ALREADY_HAVE_LETTERS' | null;
    missing: string[];
    networks: string[];
  }> {
    return this.call(
      'POST',
      `/admin/sender-ids/${encodeURIComponent(applicationId)}/letters`,
      { force },
    );
  }

  /**
   * A customer paid outside the app. api-core puts the payment in their wallet, pays the plan from it and starts the
   * subscription, all in one transaction. The bank reference makes a repeat harmless.
   */
  recordPlanPayment(
    accountId: string,
    input: {
      planId: string;
      amountReceivedNgn: string;
      reference: string;
      reason: string;
      recordedBy: string;
    },
  ): Promise<{
    alreadyApplied: boolean;
    subscriptionId?: string;
    creditReference: string;
    credited?: string;
    charged?: string;
    currentPeriodEnd?: string;
  }> {
    return this.call(
      'POST',
      `/admin/accounts/${encodeURIComponent(accountId)}/plan-payment`,
      input,
    );
  }

  /** Adds to or charges a wallet by hand. The key makes a repeat return what was done the first time. */
  adjustBalance(
    accountId: string,
    input: {
      direction: 'CREDIT' | 'DEBIT';
      amount: string;
      reason: string;
      idempotencyKey: string;
      recordedBy: string;
    },
  ): Promise<{
    alreadyApplied: boolean;
    transactionId: string;
    balanceAfter: string | null;
  }> {
    return this.call(
      'POST',
      `/admin/accounts/${encodeURIComponent(accountId)}/balance-adjustment`,
      input,
    );
  }

  // -------------------------------------------------------------- availability

  listAvailability(): Promise<ApiCoreAvailabilityRule[]> {
    return this.call('GET', '/admin/service-availability');
  }

  setAvailability(input: {
    accountCountry: string;
    service: string;
    destinationCountry: string;
    enabled: boolean;
    note?: string;
    updatedBy: string;
  }): Promise<ApiCoreAvailabilityRule> {
    return this.call('PUT', '/admin/service-availability', input);
  }

  deleteAvailability(id: string): Promise<ApiCoreAvailabilityRule> {
    return this.call(
      'DELETE',
      `/admin/service-availability/${encodeURIComponent(id)}`,
    );
  }

  private async call<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    if (!this.configured) {
      throw new ServiceUnavailableException(
        'Template review is not configured: set API_CORE_ADMIN_KEY on admin-core.',
      );
    }

    const url = `${this.cfg.adminBaseUrl.replace(/\/$/, '')}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          accept: 'application/json',
          'x-admin-key': this.cfg.adminKey,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      // The URL carries no secret, but the cause might name the host: log it here, say
      // only that api-core could not be reached to the caller.
      this.logger.error(
        `api-core ${method} ${path.split('?')[0]} failed: ${(err as Error).name}`,
      );
      throw new ServiceUnavailableException('Could not reach api-core');
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    const payload = text ? safeJson(text) : null;

    if (response.ok) return payload as T;

    const message =
      (payload as { message?: string | string[] } | null)?.message ??
      `api-core answered ${response.status}`;
    const detail = Array.isArray(message) ? message.join('; ') : message;

    if (response.status === 404) throw new NotFoundException(detail);
    if (response.status === 400) throw new BadRequestException(detail);
    if (response.status === 409) throw new ConflictException(detail);
    // 401 and 403 mean the shared key is wrong or unset on the api-core side. That is
    // an operator's problem, not the reviewer's, and the console should not see the
    // product's wording about credentials.
    if (response.status === 401 || response.status === 403) {
      this.logger.error(
        `api-core refused the admin key (${response.status}); check API_CORE_ADMIN_KEY matches ADMIN_API_KEY`,
      );
      throw new BadGatewayException(
        'api-core rejected admin-core’s credentials for template review',
      );
    }
    this.logger.error(
      `api-core ${method} ${path.split('?')[0]} answered ${response.status}`,
    );
    throw new BadGatewayException('api-core could not complete the request');
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

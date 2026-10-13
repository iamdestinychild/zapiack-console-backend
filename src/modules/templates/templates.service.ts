import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import type { StaffPrincipal } from '../../common/auth/staff-principal';
import {
  TemplateReviewClient,
  type ApiCoreTemplate,
} from '../../integrations/api-core/template-review.client';
import {
  TEMPLATE_STATUSES,
  allowedActions,
  assertAllowed,
  auditAction,
  flagsOf,
  type TemplateAction,
} from './template-rules';
import type { ListTemplatesDto } from './dto/templates.dto';

/** api-core's queue returns at most this many per status, so a count can be a floor. */
const API_CORE_PAGE = 200;
/** The tabs and the list share one fetch; this keeps a busy console from repeating it. */
const CACHE_MS = 15_000;

@Injectable()
export class TemplatesService {
  private cache?: { at: number; rows: ApiCoreTemplate[] };

  constructor(
    private readonly client: TemplateReviewClient,
    private readonly audit: AuditService,
  ) {}

  /**
   * Templates by review status, with a count per status for the tabs.
   *
   * api-core's queue answers one status at a time and returns up to 200 of it, so all
   * five are fetched together and filtered here. A count that reaches 200 is a floor:
   * `countsCapped` says which, so the console can show "200+" instead of a wrong total.
   */
  async list(query: ListTemplatesDto) {
    const rows = await this.everything();
    const status = query.status ?? 'PENDING';
    const needle = query.q?.trim().toLowerCase();

    const counts: Record<string, number> = {};
    for (const s of TEMPLATE_STATUSES) counts[s] = 0;
    for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
    counts.PENDING = (counts.SUBMITTED ?? 0) + (counts.IN_REVIEW ?? 0);
    const countsCapped = TEMPLATE_STATUSES.filter(
      (s) => (counts[s] ?? 0) >= API_CORE_PAGE,
    );

    const wanted = rows.filter((row) => {
      if (status === 'PENDING') {
        if (row.status !== 'SUBMITTED' && row.status !== 'IN_REVIEW') {
          return false;
        }
      } else if (status !== 'ALL' && row.status !== status) {
        return false;
      }
      if (!needle) return true;
      return [
        row.name,
        row.slug,
        row.subject,
        row.templateId,
        row.accountId,
        row.project?.name,
      ].some((field) => field?.toLowerCase().includes(needle));
    });

    // Waiting work oldest first, since a template in the queue is a customer who
    // cannot send; everything else newest first, as a normal list reads.
    const waiting = status === 'PENDING';
    wanted.sort((a, b) => {
      const ta = Date.parse(
        (waiting ? a.submittedAt : a.updatedAt) ?? a.updatedAt,
      );
      const tb = Date.parse(
        (waiting ? b.submittedAt : b.updatedAt) ?? b.updatedAt,
      );
      return waiting ? ta - tb : tb - ta;
    });

    const limit = query.limit ?? 50;
    const offset = decodeOffset(query.cursor);
    const page = wanted.slice(offset, offset + limit);
    const more = offset + limit < wanted.length;

    return {
      counts,
      countsCapped,
      data: page.map((row) => this.summary(row)),
      hasMore: more,
      nextCursor: more ? encodeOffset(offset + limit) : null,
    };
  }

  /** The template and its body, so the reviewer reads what they are judging. */
  async get(id: string) {
    const template = await this.client.get(id);
    return this.detail(template);
  }

  async approve(actor: StaffPrincipal, id: string, reason: string) {
    return this.decide(actor, id, 'approve', reason);
  }

  async reject(actor: StaffPrincipal, id: string, reason: string) {
    return this.decide(actor, id, 'reject', reason);
  }

  async revoke(actor: StaffPrincipal, id: string, reason: string) {
    return this.decide(actor, id, 'revoke', reason);
  }

  private async decide(
    actor: StaffPrincipal,
    id: string,
    action: TemplateAction,
    reason: string,
  ) {
    // Read first: the lifecycle rules depend on the status as it is now, not as the
    // list showed it a minute ago.
    const before = await this.client.get(id);
    if (!before) throw new NotFoundException('Template not found');
    const hasContent = Boolean(before.html);
    assertAllowed(action, before.status, hasContent);

    // For a rejection or a revoke the reason is shown to the customer. For an
    // approval api-core has nowhere to keep it, so it lives in the audit log only.
    const after = await this.client.decide(before.id, `console:${actor.id}`, {
      approve: action === 'approve',
      reason: action === 'approve' ? undefined : reason,
    });
    this.cache = undefined;

    await this.audit.record({
      actor,
      action: auditAction(action),
      targetType: 'template',
      targetId: before.id,
      reason,
      before: { status: before.status },
      after: { status: after.status },
      metadata: {
        templateId: before.templateId,
        name: before.name,
        accountId: before.accountId,
        automatedFlags: flagsOf(before.reviewNotes),
        // An approval of something never filed bypassed the customer's own submit and
        // the automated checks; record that it did.
        approvedFromDraft: action === 'approve' && before.status === 'DRAFT',
      },
    });

    return {
      id: after.id,
      templateId: after.templateId,
      status: after.status,
      previousStatus: before.status,
      rejectionReason: after.rejectionReason,
      reviewedAt: after.reviewedAt,
    };
  }

  // ---------------------------------------------------------------- shapes

  private summary(row: ApiCoreTemplate) {
    return {
      id: row.id,
      templateId: row.templateId,
      name: row.name,
      slug: row.slug,
      category: row.category,
      subject: row.subject,
      status: row.status,
      accountId: row.accountId ?? null,
      project: row.project ?? null,
      flags: flagsOf(row.reviewNotes),
      rejectionReason: row.rejectionReason,
      submittedAt: row.submittedAt,
      reviewedAt: row.reviewedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private detail(row: ApiCoreTemplate) {
    const hasContent = Boolean(row.html);
    return {
      ...this.summary(row),
      variables: row.variables,
      /**
       * The customer's HTML, exactly as stored. It is untrusted: render it only inside
       * a sandboxed iframe (`srcdoc`, `sandbox=""`), never straight into the page.
       */
      html: row.html ?? null,
      hasContent,
      /** What the reviewer may do now. Offer exactly these buttons. */
      allowedActions: allowedActions(row.status, hasContent),
      /** True when approving would skip the customer's submit and the automated checks. */
      approvalSkipsChecks: row.status === 'DRAFT',
    };
  }

  private async everything(): Promise<ApiCoreTemplate[]> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) {
      return this.cache.rows;
    }
    const lists = await Promise.all(
      TEMPLATE_STATUSES.map((status) => this.client.queue(status)),
    );
    const rows = lists.flat();
    this.cache = { at: Date.now(), rows };
    return rows;
  }
}

function encodeOffset(offset: number): string {
  return Buffer.from(String(offset)).toString('base64url');
}

function decodeOffset(cursor?: string): number {
  if (!cursor) return 0;
  const n = Number(Buffer.from(cursor, 'base64url').toString('utf8'));
  return Number.isInteger(n) && n > 0 ? n : 0;
}

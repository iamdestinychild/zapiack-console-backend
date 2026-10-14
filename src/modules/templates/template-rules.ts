import { BadRequestException, ConflictException } from '@nestjs/common';

export const TEMPLATE_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'IN_REVIEW',
  'APPROVED',
  'REJECTED',
] as const;
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];

export type TemplateAction = 'approve' | 'reject' | 'revoke';

/**
 * What a reviewer may do to a template in each status.
 *
 *  - SUBMITTED and IN_REVIEW are the review queue proper: the customer filed it and
 *    the automated checks either hold it for a person (IN_REVIEW) or are still to run.
 *  - DRAFT has not been filed. Approving one skips the customer's own submit and the
 *    automated checks, so it is allowed (support often needs it) but only if there is
 *    a body to approve; the console shows the same warning the reviewer must accept.
 *  - APPROVED can only be revoked, which is a rejection that must say why.
 *  - REJECTED can be overturned by approving it, for a decision that was wrong.
 */
export function allowedActions(
  status: string,
  hasContent: boolean,
): TemplateAction[] {
  switch (status) {
    case 'DRAFT':
      return hasContent ? ['approve', 'reject'] : ['reject'];
    case 'SUBMITTED':
    case 'IN_REVIEW':
      return hasContent ? ['approve', 'reject'] : ['reject'];
    case 'APPROVED':
      return ['revoke'];
    case 'REJECTED':
      return hasContent ? ['approve'] : [];
    default:
      return [];
  }
}

/** Throws the specific, actionable error rather than a generic "not allowed". */
export function assertAllowed(
  action: TemplateAction,
  status: string,
  hasContent: boolean,
): void {
  if (allowedActions(status, hasContent).includes(action)) return;

  if (action === 'approve') {
    if (status === 'APPROVED') {
      throw new ConflictException('This template is already approved.');
    }
    if (!hasContent) {
      throw new BadRequestException(
        'This template has no content to approve. The customer has not written a body yet.',
      );
    }
  }
  if (action === 'reject' && status === 'APPROVED') {
    throw new ConflictException(
      'This template is approved. Use revoke to withdraw an approval.',
    );
  }
  if (action === 'reject' && status === 'REJECTED') {
    throw new ConflictException('This template is already rejected.');
  }
  if (action === 'revoke') {
    throw new ConflictException(
      `Only an approved template can be revoked; this one is ${status}.`,
    );
  }
  throw new ConflictException(`A ${status} template cannot be ${action}d.`);
}

/** What the automated review found, one finding per line, as api-core stores it. */
export function flagsOf(reviewNotes: string | null | undefined): string[] {
  return (reviewNotes ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/** The audit trail names the action by what actually happened to the template. */
export function auditAction(action: TemplateAction): string {
  return action === 'approve'
    ? 'templates.approved'
    : action === 'revoke'
      ? 'templates.revoked'
      : 'templates.rejected';
}

/**
 * The names a template expects, as the console shows them. api-core stores each variable as
 * an object ({ key, type, required, ... }); the console wants plain names, and an array
 * of objects reads as `items[]`. A plain string (an older row) passes through.
 */
export function variableNames(variables: unknown): string[] {
  if (!Array.isArray(variables)) return [];
  const names: string[] = [];
  for (const entry of variables) {
    if (typeof entry === 'string') {
      names.push(entry);
    } else if (entry && typeof entry === 'object') {
      const { key, type } = entry as { key?: unknown; type?: unknown };
      if (typeof key === 'string')
        names.push(type === 'array' ? `${key}[]` : key);
    }
  }
  return names;
}

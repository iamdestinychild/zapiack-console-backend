import { ConflictException } from '@nestjs/common';

/**
 * What the console stores on a review. This is an Admin DB enum and is wider than the
 * product's, for historical reasons; only SUBMITTED, APPROVED and REJECTED are written
 * now. Everything the console shows and sends is expressed in the product's own words
 * (see ProductStatus), through the mapping below.
 */
export type SenderIdStatus =
  | 'SUBMITTED'
  | 'IN_REVIEW'
  | 'CHANGES_REQUESTED'
  | 'REJECTED'
  | 'APPROVED'
  | 'SUBMITTED_TO_OPERATORS'
  | 'ACTIVE'
  | 'OPERATOR_REJECTED'
  | 'SUSPENDED';

/**
 * The only statuses a sender ID application has in the product. The customer app, the
 * sender ID resolver and the letters all branch on these four, so the console shows
 * exactly these and never writes anything else: an unknown status in that column is not
 * a label, it is a project that stops finding its application.
 *
 *  - DRAFT: the customer has not submitted it. Nothing for a reviewer to do.
 *  - PENDING_REVIEW: submitted and waiting. This is the review queue.
 *  - APPROVED: the project sends under its own sender ID.
 *  - REJECTED: refused, with a reason. The customer can edit it and submit again.
 */
export const PRODUCT_STATUSES = [
  'DRAFT',
  'PENDING_REVIEW',
  'APPROVED',
  'REJECTED',
] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

/** A review's stored status, as the product would name it. */
const AS_PRODUCT: Record<SenderIdStatus, ProductStatus> = {
  SUBMITTED: 'PENDING_REVIEW',
  // "Someone picked it up" is the assignee, not a status of the application.
  IN_REVIEW: 'PENDING_REVIEW',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  // Console-only statuses the product never had. Nothing writes them any more; they
  // are mapped to their nearest real meaning so an old row still reads sensibly.
  CHANGES_REQUESTED: 'REJECTED',
  SUBMITTED_TO_OPERATORS: 'APPROVED',
  ACTIVE: 'APPROVED',
  OPERATOR_REJECTED: 'REJECTED',
  SUSPENDED: 'REJECTED',
};

export function presentStatus(status: string): ProductStatus {
  return AS_PRODUCT[status as SenderIdStatus] ?? 'PENDING_REVIEW';
}

/**
 * The status to store on a review for a product status, or null when there is no
 * review to have: a draft is not in the queue, and an unrecognised status is left out
 * rather than guessed at.
 */
export function toReviewStatus(productStatus: string): SenderIdStatus | null {
  switch (productStatus.trim().toUpperCase()) {
    case 'PENDING_REVIEW':
      return 'SUBMITTED';
    case 'APPROVED':
      return 'APPROVED';
    case 'REJECTED':
      return 'REJECTED';
    default:
      return null;
  }
}

/** The stored review statuses that present as this product status. */
export function reviewStatusesFor(status: ProductStatus): SenderIdStatus[] {
  return (Object.keys(AS_PRODUCT) as SenderIdStatus[]).filter(
    (s) => AS_PRODUCT[s] === status,
  );
}

export type Decision = 'APPROVED' | 'REJECTED';

/**
 * What a reviewer may decide. An application awaiting review can be approved or
 * rejected. An approved one can only be rejected, which withdraws the approval. A
 * rejected one can only be approved, which overturns a wrong refusal; otherwise the
 * customer's route is to edit it and submit again.
 */
export function allowedDecisions(status: string): Decision[] {
  switch (presentStatus(status)) {
    case 'PENDING_REVIEW':
      return ['APPROVED', 'REJECTED'];
    case 'APPROVED':
      return ['REJECTED'];
    case 'REJECTED':
      return ['APPROVED'];
    default:
      return [];
  }
}

export function assertDecision(current: string, decision: Decision): void {
  if (allowedDecisions(current).includes(decision)) return;

  const now = presentStatus(current);
  throw new ConflictException(
    now === decision
      ? `This application is already ${decision.toLowerCase()}.`
      : `A ${now.toLowerCase().replace('_', ' ')} application cannot be ${decision.toLowerCase()}.`,
  );
}

/** Whether a decision needs the reviewer to say why. The customer is shown it. */
export const REASON_REQUIRED: Decision[] = ['REJECTED'];

/**
 * What the applicant is told, in the product's own notification vocabulary
 * (severity: INFO | PENDING | SUCCESS | ERROR).
 */
export function customerNotice(
  decision: Decision,
  senderId: string,
  reason?: string | null,
): { severity: 'SUCCESS' | 'ERROR'; title: string; body: string } {
  return decision === 'APPROVED'
    ? {
        severity: 'SUCCESS',
        title: `Sender ID ${senderId} approved`,
        body: `Your sender ID ${senderId} has been approved. Messages from your project now go out under it.`,
      }
    : {
        severity: 'ERROR',
        title: `Sender ID ${senderId} was not approved`,
        body: `${reason?.trim() ?? 'Your application was not approved.'} You can edit your application and submit it again.`,
      };
}

/** The per-application checklist a reviewer works through. */
export const CHECKLIST = [
  {
    key: 'business_registration_matches',
    label: 'Business registration matches the applicant',
  },
  { key: 'loa_signed', label: 'Letter of authorisation is signed' },
  { key: 'matches_brand', label: 'Sender ID matches the brand' },
  { key: 'sample_content_ok', label: 'Sample message content is acceptable' },
] as const;

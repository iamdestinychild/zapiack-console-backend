import { BadRequestException } from '@nestjs/common';

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
 * The review lifecycle, encoded once. Humans decide the outcome; this only stops the
 * console recording a transition that cannot happen, such as approving a rejected
 * application without it going back through review.
 */
const TRANSITIONS: Record<SenderIdStatus, SenderIdStatus[]> = {
  SUBMITTED: ['IN_REVIEW'],
  IN_REVIEW: ['CHANGES_REQUESTED', 'REJECTED', 'APPROVED'],
  CHANGES_REQUESTED: ['SUBMITTED'],
  REJECTED: [],
  APPROVED: ['SUBMITTED_TO_OPERATORS'],
  SUBMITTED_TO_OPERATORS: ['ACTIVE', 'OPERATOR_REJECTED'],
  ACTIVE: ['SUSPENDED'],
  OPERATOR_REJECTED: ['IN_REVIEW'],
  SUSPENDED: ['ACTIVE'],
};

/** Outcomes that cannot be recorded without the reviewer writing why. */
export const REASON_REQUIRED: SenderIdStatus[] = [
  'REJECTED',
  'CHANGES_REQUESTED',
  'SUSPENDED',
  'OPERATOR_REJECTED',
];

export function assertTransition(
  from: SenderIdStatus,
  to: SenderIdStatus,
): void {
  if (!TRANSITIONS[from]?.includes(to)) {
    throw new BadRequestException(
      `A ${from.toLowerCase().replace('_', ' ')} application cannot move to ${to.toLowerCase().replace('_', ' ')}`,
    );
  }
}

export function allowedNext(from: SenderIdStatus): SenderIdStatus[] {
  return TRANSITIONS[from] ?? [];
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

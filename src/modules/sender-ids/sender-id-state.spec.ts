import { ConflictException } from '@nestjs/common';
import {
  PRODUCT_STATUSES,
  allowedDecisions,
  assertDecision,
  customerNotice,
  presentStatus,
  reviewStatusesFor,
  toReviewStatus,
} from './sender-id-state';

describe('the product’s statuses', () => {
  it('are exactly four, and these are the only values the console may write', () => {
    expect([...PRODUCT_STATUSES]).toEqual([
      'DRAFT',
      'PENDING_REVIEW',
      'APPROVED',
      'REJECTED',
    ]);
  });
});

describe('presentStatus (what the console shows)', () => {
  it('shows submitted and picked-up applications as pending review', () => {
    expect(presentStatus('SUBMITTED')).toBe('PENDING_REVIEW');
    expect(presentStatus('IN_REVIEW')).toBe('PENDING_REVIEW');
  });

  it('passes the real outcomes through', () => {
    expect(presentStatus('APPROVED')).toBe('APPROVED');
    expect(presentStatus('REJECTED')).toBe('REJECTED');
  });

  it('maps console-only statuses onto the nearest real one, so an old row still reads right', () => {
    expect(presentStatus('CHANGES_REQUESTED')).toBe('REJECTED');
    expect(presentStatus('ACTIVE')).toBe('APPROVED');
    expect(presentStatus('SUBMITTED_TO_OPERATORS')).toBe('APPROVED');
    expect(presentStatus('OPERATOR_REJECTED')).toBe('REJECTED');
    expect(presentStatus('SUSPENDED')).toBe('REJECTED');
  });

  it('keeps an unknown status visible in the queue rather than hiding it', () => {
    expect(presentStatus('SOMETHING_NEW')).toBe('PENDING_REVIEW');
  });
});

describe('toReviewStatus (what a product status becomes on a review)', () => {
  it('queues only what is waiting, plus the outcomes', () => {
    expect(toReviewStatus('PENDING_REVIEW')).toBe('SUBMITTED');
    expect(toReviewStatus('APPROVED')).toBe('APPROVED');
    expect(toReviewStatus('REJECTED')).toBe('REJECTED');
  });

  it('has no review for a draft, and does not guess at an unknown status', () => {
    expect(toReviewStatus('DRAFT')).toBeNull();
    expect(toReviewStatus('IN_REVIEW')).toBeNull();
    expect(toReviewStatus('SUBMITTED')).toBeNull();
    expect(toReviewStatus('')).toBeNull();
  });

  it('tolerates case and spacing', () => {
    expect(toReviewStatus(' pending_review ')).toBe('SUBMITTED');
  });
});

describe('reviewStatusesFor (filter by what the console shows)', () => {
  it('finds every stored status that presents as pending review', () => {
    expect(reviewStatusesFor('PENDING_REVIEW').sort()).toEqual([
      'IN_REVIEW',
      'SUBMITTED',
    ]);
  });

  it('has none for a draft, which is not a review', () => {
    expect(reviewStatusesFor('DRAFT')).toEqual([]);
  });

  it('round-trips with presentStatus', () => {
    for (const status of PRODUCT_STATUSES) {
      for (const stored of reviewStatusesFor(status)) {
        expect(presentStatus(stored)).toBe(status);
      }
    }
  });
});

describe('decisions', () => {
  it('lets a pending application be approved or rejected', () => {
    expect(allowedDecisions('SUBMITTED')).toEqual(['APPROVED', 'REJECTED']);
    expect(allowedDecisions('IN_REVIEW')).toEqual(['APPROVED', 'REJECTED']);
  });

  it('lets an approval be withdrawn, and a refusal be overturned', () => {
    expect(allowedDecisions('APPROVED')).toEqual(['REJECTED']);
    expect(allowedDecisions('REJECTED')).toEqual(['APPROVED']);
  });

  it('refuses a decision that changes nothing, in plain words', () => {
    expect(() => assertDecision('APPROVED', 'APPROVED')).toThrow(
      /already approved/,
    );
    expect(() => assertDecision('REJECTED', 'REJECTED')).toThrow(
      /already rejected/,
    );
    expect(() => assertDecision('APPROVED', 'APPROVED')).toThrow(
      ConflictException,
    );
  });

  it('allows a legitimate decision', () => {
    expect(() => assertDecision('SUBMITTED', 'APPROVED')).not.toThrow();
    expect(() => assertDecision('APPROVED', 'REJECTED')).not.toThrow();
  });
});

describe('customerNotice', () => {
  it('congratulates on approval, in the product’s severity vocabulary', () => {
    const n = customerNotice('APPROVED', 'KANOLOG');
    expect(n).toMatchObject({
      severity: 'SUCCESS',
      title: 'Sender ID KANOLOG approved',
    });
    expect(n.body).toMatch(/now go out under it/);
  });

  it('gives the reviewer’s reason on refusal, and the way forward', () => {
    const n = customerNotice(
      'REJECTED',
      'SWIFTPAY',
      'Sample reads as a promotion.',
    );
    expect(n.severity).toBe('ERROR');
    expect(n.body).toBe(
      'Sample reads as a promotion. You can edit your application and submit it again.',
    );
  });
});

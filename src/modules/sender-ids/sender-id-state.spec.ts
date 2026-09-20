import { BadRequestException } from '@nestjs/common';
import {
  REASON_REQUIRED,
  allowedNext,
  assertTransition,
} from './sender-id-state';

describe('sender ID lifecycle', () => {
  it('walks the happy path from submission to active', () => {
    expect(() => assertTransition('SUBMITTED', 'IN_REVIEW')).not.toThrow();
    expect(() => assertTransition('IN_REVIEW', 'APPROVED')).not.toThrow();
    expect(() =>
      assertTransition('APPROVED', 'SUBMITTED_TO_OPERATORS'),
    ).not.toThrow();
    expect(() =>
      assertTransition('SUBMITTED_TO_OPERATORS', 'ACTIVE'),
    ).not.toThrow();
  });

  it('sends a change request back round for resubmission', () => {
    expect(() =>
      assertTransition('IN_REVIEW', 'CHANGES_REQUESTED'),
    ).not.toThrow();
    expect(() =>
      assertTransition('CHANGES_REQUESTED', 'SUBMITTED'),
    ).not.toThrow();
  });

  it('refuses to approve without passing back through review', () => {
    expect(() => assertTransition('SUBMITTED', 'APPROVED')).toThrow(
      BadRequestException,
    );
    expect(() => assertTransition('REJECTED', 'APPROVED')).toThrow(
      BadRequestException,
    );
  });

  it('treats rejection as terminal', () => {
    expect(allowedNext('REJECTED')).toEqual([]);
  });

  it('lets an operator rejection re-enter review', () => {
    expect(() =>
      assertTransition('SUBMITTED_TO_OPERATORS', 'OPERATOR_REJECTED'),
    ).not.toThrow();
    expect(() =>
      assertTransition('OPERATOR_REJECTED', 'IN_REVIEW'),
    ).not.toThrow();
  });

  it('allows an active sender ID to be suspended and restored', () => {
    expect(() => assertTransition('ACTIVE', 'SUSPENDED')).not.toThrow();
    expect(() => assertTransition('SUSPENDED', 'ACTIVE')).not.toThrow();
  });

  it('requires a written reason for every negative outcome', () => {
    expect(REASON_REQUIRED).toEqual(
      expect.arrayContaining([
        'REJECTED',
        'CHANGES_REQUESTED',
        'SUSPENDED',
        'OPERATOR_REJECTED',
      ]),
    );
    expect(REASON_REQUIRED).not.toContain('APPROVED');
  });
});

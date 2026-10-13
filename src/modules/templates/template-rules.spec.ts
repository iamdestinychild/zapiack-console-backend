import {
  allowedActions,
  assertAllowed,
  flagsOf,
  auditAction,
} from './template-rules';

describe('allowedActions', () => {
  it('lets a reviewer approve or reject anything awaiting review', () => {
    expect(allowedActions('IN_REVIEW', true)).toEqual(['approve', 'reject']);
    expect(allowedActions('SUBMITTED', true)).toEqual(['approve', 'reject']);
  });

  it('lets a reviewer approve a draft, but only if it has a body', () => {
    expect(allowedActions('DRAFT', true)).toEqual(['approve', 'reject']);
    expect(allowedActions('DRAFT', false)).toEqual(['reject']);
  });

  it('offers only revoke on an approved template', () => {
    expect(allowedActions('APPROVED', true)).toEqual(['revoke']);
  });

  it('lets a wrong rejection be overturned', () => {
    expect(allowedActions('REJECTED', true)).toEqual(['approve']);
    expect(allowedActions('REJECTED', false)).toEqual([]);
  });

  it('offers nothing for an unknown status', () => {
    expect(allowedActions('WHATEVER', true)).toEqual([]);
  });
});

describe('assertAllowed', () => {
  it('passes a permitted action', () => {
    expect(() => assertAllowed('approve', 'IN_REVIEW', true)).not.toThrow();
  });

  it('explains each refusal specifically', () => {
    expect(() => assertAllowed('approve', 'APPROVED', true)).toThrow(
      /already approved/,
    );
    expect(() => assertAllowed('approve', 'DRAFT', false)).toThrow(
      /no content to approve/,
    );
    expect(() => assertAllowed('reject', 'APPROVED', true)).toThrow(
      /use revoke/i,
    );
    expect(() => assertAllowed('reject', 'REJECTED', true)).toThrow(
      /already rejected/,
    );
    expect(() => assertAllowed('revoke', 'IN_REVIEW', true)).toThrow(
      /Only an approved template can be revoked/,
    );
  });
});

describe('flagsOf', () => {
  it('splits the automated findings, one per line', () => {
    expect(
      flagsOf('Uses a link shortener\n\n  No variables found  \n'),
    ).toEqual(['Uses a link shortener', 'No variables found']);
  });

  it('is empty when there are none', () => {
    expect(flagsOf(null)).toEqual([]);
    expect(flagsOf('')).toEqual([]);
  });
});

describe('auditAction', () => {
  it('names the action by what happened', () => {
    expect(auditAction('approve')).toBe('templates.approved');
    expect(auditAction('reject')).toBe('templates.rejected');
    expect(auditAction('revoke')).toBe('templates.revoked');
  });
});

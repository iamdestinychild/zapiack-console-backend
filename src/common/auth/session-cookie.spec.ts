import type { Request } from 'express';
import { cookieValues } from './session-cookie';

const req = (cookie?: string) =>
  ({ headers: { cookie } }) as unknown as Request;

describe('cookieValues', () => {
  it('returns every value for the name, in order', () => {
    expect(cookieValues(req('a=1; zpk=old; b=2; zpk=new'), 'zpk')).toEqual([
      'old',
      'new',
    ]);
  });

  it('ignores other names, including ones that merely contain it', () => {
    expect(cookieValues(req('zpk_csrf=x; xzpk=y'), 'zpk')).toEqual([]);
  });

  it('copes with no header and with malformed encoding', () => {
    expect(cookieValues(req(undefined), 'zpk')).toEqual([]);
    expect(cookieValues(req('zpk=%E0%A4%A'), 'zpk')).toEqual(['%E0%A4%A']);
  });
});

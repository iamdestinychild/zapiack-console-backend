import { Transform } from 'class-transformer';

/**
 * Booleans arriving as query strings.
 *
 * `@Type(() => Boolean)` is wrong here: query values are strings, and
 * `Boolean('false')` is `true`, so `?overdueOnly=false` would filter to overdue only.
 * An absent value stays undefined so the caller can tell "not asked" from "asked false".
 */
export const BooleanQuery = () =>
  Transform(({ value }: { value: unknown }) => {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value === 'boolean') return value;
    // Query values arrive as strings; anything else is a malformed request.
    if (typeof value !== 'string') return undefined;
    const text = value.toLowerCase();
    if (['true', '1', 'yes'].includes(text)) return true;
    if (['false', '0', 'no'].includes(text)) return false;
    return undefined;
  });

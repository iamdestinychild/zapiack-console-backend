import type { Request } from 'express';

/**
 * Every value the browser sent for a cookie name, in the order it sent them.
 *
 * A browser can hold two cookies with one name when they were set with different
 * `Domain` attributes (one scoped to the parent domain, one to the API host alone),
 * and it sends both. `cookie-parser` keeps only the first, which is the older, so a
 * stale session id would shadow the live one and every request would look signed out.
 */
export function cookieValues(req: Request, name: string): string[] {
  const header = req.headers.cookie;
  if (!header) return [];
  const values: string[] = [];
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      values.push(decodeURIComponent(raw));
    } catch {
      values.push(raw);
    }
  }
  return values;
}

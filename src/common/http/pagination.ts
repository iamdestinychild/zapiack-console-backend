/**
 * Cursor pagination everywhere. Offsets drift while staff page through a list that
 * new events keep pushing rows into, so the cursor encodes the sort key of the last
 * row seen.
 */
export interface CursorPage<T> {
  data: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface CursorKey {
  createdAt: string;
  id: string;
}

export function encodeCursor(key: CursorKey): string {
  return Buffer.from(JSON.stringify(key)).toString('base64url');
}

export function decodeCursor(cursor?: string): CursorKey | null {
  if (!cursor) return null;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    );
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as CursorKey).id === 'string' &&
      typeof (parsed as CursorKey).createdAt === 'string'
    ) {
      return parsed as CursorKey;
    }
    return null;
  } catch {
    // A cursor the client mangled is treated as no cursor, not as an error.
    return null;
  }
}

/**
 * Builds a page from `limit + 1` rows fetched by the caller, using (createdAt, id)
 * as a stable tiebroken sort key.
 */
export function buildPage<T extends { id: string; createdAt: Date }>(
  rows: T[],
  limit: number,
): CursorPage<T> {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data.at(-1);
  return {
    data,
    hasMore,
    nextCursor:
      hasMore && last
        ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
        : null,
  };
}

/** Prisma `where` fragment for "strictly older than the cursor". */
export function cursorWhere(cursor: CursorKey | null) {
  if (!cursor) return {};
  return {
    OR: [
      { createdAt: { lt: new Date(cursor.createdAt) } },
      { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
    ],
  };
}

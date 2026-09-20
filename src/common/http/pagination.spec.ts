import {
  buildPage,
  cursorWhere,
  decodeCursor,
  encodeCursor,
} from './pagination';

const row = (id: string, iso: string) => ({ id, createdAt: new Date(iso) });

describe('cursor pagination', () => {
  it('round-trips a cursor', () => {
    const key = { createdAt: '2026-09-20T10:00:00.000Z', id: 'abc' };
    expect(decodeCursor(encodeCursor(key))).toEqual(key);
  });

  it('treats a malformed cursor as no cursor rather than throwing', () => {
    expect(decodeCursor('not-base64!!')).toBeNull();
    expect(
      decodeCursor(Buffer.from('{"nope":1}').toString('base64url')),
    ).toBeNull();
    expect(decodeCursor(undefined)).toBeNull();
  });

  it('trims the lookahead row and emits a cursor when more remain', () => {
    const rows = [
      row('a', '2026-09-20T10:00:00Z'),
      row('b', '2026-09-20T09:00:00Z'),
      row('c', '2026-09-20T08:00:00Z'),
    ];
    const page = buildPage(rows, 2);

    expect(page.data.map((r) => r.id)).toEqual(['a', 'b']);
    expect(page.hasMore).toBe(true);
    // The cursor points at the last row returned, not the lookahead one.
    expect(decodeCursor(page.nextCursor!)?.id).toBe('b');
  });

  it('reports the end of the list', () => {
    const page = buildPage([row('a', '2026-09-20T10:00:00Z')], 2);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it('breaks ties on id so rows sharing a timestamp are never skipped', () => {
    const where = cursorWhere({
      createdAt: '2026-09-20T10:00:00.000Z',
      id: 'm',
    });
    expect(where).toEqual({
      OR: [
        { createdAt: { lt: new Date('2026-09-20T10:00:00.000Z') } },
        { createdAt: new Date('2026-09-20T10:00:00.000Z'), id: { lt: 'm' } },
      ],
    });
  });
});

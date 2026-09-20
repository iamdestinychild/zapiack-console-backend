import {
  CallHandler,
  ConflictException,
  ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, of, throwError } from 'rxjs';
import type { AdminPrismaService } from '../prisma/admin-prisma.service';
import { IdempotencyInterceptor } from './idempotency.interceptor';

interface FakeRecord {
  id: string;
  key: string;
  staffId: string;
  route: string;
  requestHash: string;
  completedAt: Date | null;
  responseBody: unknown;
}

interface UniqueWhere {
  key_staffId_route: { key: string; staffId: string; route: string };
}

/**
 * An in-memory stand-in for the idempotency_records table, including the unique
 * index on (key, staffId, route) — which is what settles a race between two
 * simultaneous requests carrying the same key.
 */
function fakePrisma() {
  const rows = new Map<string, FakeRecord>();
  const byId = new Map<string, FakeRecord>();
  const uniq = (k: { key: string; staffId: string; route: string }) =>
    `${k.key}|${k.staffId}|${k.route}`;
  let seq = 0;

  const idempotencyRecord = {
    findUnique: ({
      where,
    }: {
      where: UniqueWhere;
    }): Promise<FakeRecord | null> =>
      Promise.resolve(rows.get(uniq(where.key_staffId_route)) ?? null),

    findUniqueOrThrow: ({
      where,
    }: {
      where: UniqueWhere;
    }): Promise<FakeRecord> => {
      const row = rows.get(uniq(where.key_staffId_route));
      if (!row) throw new Error('not found');
      return Promise.resolve(row);
    },

    create: ({
      data,
    }: {
      data: Omit<FakeRecord, 'id' | 'completedAt' | 'responseBody'>;
    }) => {
      const k = uniq(data);
      if (rows.has(k)) {
        // Mirrors the Postgres unique violation Prisma surfaces as P2002.
        throw Object.assign(new Error('unique violation'), { code: 'P2002' });
      }
      const row: FakeRecord = {
        id: `rec_${++seq}`,
        ...data,
        completedAt: null,
        responseBody: null,
      };
      rows.set(k, row);
      byId.set(row.id, row);
      return Promise.resolve(row);
    },

    update: ({
      where,
      data,
    }: {
      where: { id: string };
      data: Partial<FakeRecord>;
    }) => {
      const row = byId.get(where.id);
      if (!row) throw new Error('not found');
      return Promise.resolve(Object.assign(row, data));
    },

    delete: ({ where }: { where: { id: string } }) => {
      const row = byId.get(where.id);
      if (!row) throw new Error('not found');
      byId.delete(where.id);
      rows.delete(uniq(row));
      return Promise.resolve(row);
    },
  };

  return { rows, idempotencyRecord };
}

type FakePrisma = ReturnType<typeof fakePrisma>;

function ctx(body: unknown, key?: string): ExecutionContext {
  const request = {
    method: 'POST',
    url: '/admin/v1/customers/acc_1/reactivate',
    route: { path: '/admin/v1/customers/:id/reactivate' },
    body,
    staff: { id: 'staff_1' },
    get: (h: string) => (h === 'idempotency-key' ? key : undefined),
  };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

const handlerReturning = (value: unknown): CallHandler => ({
  handle: () => of(value),
});

/** The interceptor touches one model; the cast keeps the double small on purpose. */
const asPrisma = (fake: FakePrisma) => fake as unknown as AdminPrismaService;

describe('IdempotencyInterceptor', () => {
  let prisma: FakePrisma;
  let interceptor: IdempotencyInterceptor;

  beforeEach(() => {
    prisma = fakePrisma();
    const reflector = { getAllAndOverride: () => true } as unknown as Reflector;
    interceptor = new IdempotencyInterceptor(reflector, asPrisma(prisma));
  });

  it('requires the header on a route marked idempotent', () => {
    expect(() => interceptor.intercept(ctx({}), handlerReturning({}))).toThrow(
      /Idempotency-Key header is required/,
    );
  });

  it('runs the handler on the first call', async () => {
    const handler = { handle: jest.fn(() => of({ ok: true })) };
    const result = await firstValueFrom(
      interceptor.intercept(ctx({ a: 1 }, 'k1'), handler),
    );

    expect(result).toEqual({ ok: true });
    expect(handler.handle).toHaveBeenCalledTimes(1);
  });

  /**
   * The regression this class exists for: the completion record must be written
   * before the response is emitted. A client that retries the instant it gets a
   * reply — the retry-on-timeout client this whole mechanism serves — must see a
   * replay, not "still in flight".
   */
  it('marks the record complete before emitting, so an immediate retry replays', async () => {
    await firstValueFrom(
      interceptor.intercept(
        ctx({ a: 1 }, 'k1'),
        handlerReturning({ ok: true }),
      ),
    );

    const stored = [...prisma.rows.values()][0];
    expect(stored.completedAt).toBeInstanceOf(Date);
    expect(stored.responseBody).toEqual({ ok: true });

    const handler = { handle: jest.fn(() => of({ ok: 'should not run' })) };
    const replay = await firstValueFrom(
      interceptor.intercept(ctx({ a: 1 }, 'k1'), handler),
    );

    expect(replay).toEqual({ ok: true });
    expect(handler.handle).not.toHaveBeenCalled();
  });

  it('runs the handler once when requests race on the same key', async () => {
    const handler = { handle: jest.fn(() => of({ ok: true })) };

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        firstValueFrom(interceptor.intercept(ctx({ a: 1 }, 'race'), handler)),
      ),
    );

    // The guarantee is about the handler, not about who gets which answer: the
    // effect happens once. A loser either replays the winner's response or, if it
    // arrives while the winner is still running, is told the request is in flight.
    expect(handler.handle).toHaveBeenCalledTimes(1);

    const answers = results.filter((r) => r.status === 'fulfilled');
    expect(answers.length).toBeGreaterThan(0);
    for (const answer of answers) {
      expect(answer.value).toEqual({
        ok: true,
      });
    }
    for (const rejected of results.filter((r) => r.status === 'rejected')) {
      expect(rejected.reason).toBeInstanceOf(ConflictException);
    }
  });

  it('treats the same key with a different payload as a client bug', async () => {
    await firstValueFrom(
      interceptor.intercept(
        ctx({ a: 1 }, 'k1'),
        handlerReturning({ ok: true }),
      ),
    );

    await expect(
      firstValueFrom(
        interceptor.intercept(
          ctx({ a: 999 }, 'k1'),
          handlerReturning({ ok: true }),
        ),
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('releases the key when the handler fails, so the caller can retry', async () => {
    const failing: CallHandler = {
      handle: () => throwError(() => new Error('api-core down')),
    };

    await expect(
      firstValueFrom(interceptor.intercept(ctx({ a: 1 }, 'k1'), failing)),
    ).rejects.toThrow('api-core down');
    expect(prisma.rows.size).toBe(0);

    const retry = await firstValueFrom(
      interceptor.intercept(
        ctx({ a: 1 }, 'k1'),
        handlerReturning({ ok: true }),
      ),
    );
    expect(retry).toEqual({ ok: true });
  });

  it('passes through untouched when the route is not idempotent', async () => {
    const reflector = {
      getAllAndOverride: () => false,
    } as unknown as Reflector;
    const plain = new IdempotencyInterceptor(reflector, asPrisma(prisma));

    const result = await firstValueFrom(
      plain.intercept(ctx({}, undefined), handlerReturning('x')),
    );
    expect(result).toBe('x');
    expect(prisma.rows.size).toBe(0);
  });
});

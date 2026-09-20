import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash } from 'node:crypto';
import { Observable, catchError, concatMap, from, of, throwError } from 'rxjs';
import { IDEMPOTENT_KEY } from '../auth/decorators';
import { Prisma } from '../../generated/admin/client';
import type { AuthenticatedRequest } from '../http/admin-request';
import { AdminPrismaService } from '../prisma/admin-prisma.service';

/** Postgres unique-violation, surfaced by Prisma when two requests race on one key. */
const UNIQUE_VIOLATION = 'P2002';

/**
 * Write routes take an Idempotency-Key header. A repeat of the same key by the same
 * staff member on the same route replays the stored response; the same key with a
 * different body is a conflict, because that is a client bug rather than a retry.
 *
 * The completion record is written *before* the response is emitted. Fire-and-forget
 * would leave a window in which a client that retries on timeout — the exact client
 * this exists for — arrives back before the record is marked complete and is told its
 * request is still in flight.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: AdminPrismaService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const required = this.reflector.getAllAndOverride<boolean>(IDEMPOTENT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return next.handle();

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const key = request.get('idempotency-key');
    if (!key)
      throw new BadRequestException('Idempotency-Key header is required');

    const staff = request.staff;
    const routePath = (request.route as { path?: string } | undefined)?.path;
    const route = `${request.method} ${routePath ?? request.url}`;
    const requestHash = createHash('sha256')
      .update(JSON.stringify(request.body ?? {}))
      .digest('hex');
    const where = { key_staffId_route: { key, staffId: staff.id, route } };

    return from(
      this.claim(where, { key, staffId: staff.id, route, requestHash }),
    ).pipe(
      concatMap((claim) => {
        if (claim.replay) return of(claim.responseBody);

        return next.handle().pipe(
          // Await the completion write, so the caller cannot outrun it on a retry.
          concatMap((result) =>
            from(
              this.prisma.idempotencyRecord.update({
                where: { id: claim.id },
                data: {
                  completedAt: new Date(),
                  statusCode: 200,
                  responseBody: JSON.parse(
                    JSON.stringify(result ?? null),
                  ) as Prisma.InputJsonValue,
                },
              }),
            ).pipe(concatMap(() => of(result))),
          ),
          // A failure releases the key so the caller can retry the same request.
          catchError((err: unknown) =>
            from(
              this.prisma.idempotencyRecord
                .delete({ where: { id: claim.id } })
                .catch(() => undefined),
            ).pipe(concatMap(() => throwError(() => err))),
          ),
        );
      }),
    );
  }

  /**
   * Takes ownership of the key, or reports that this is a replay. The unique index is
   * what settles a race between two simultaneous requests: exactly one create wins,
   * and the loser is treated as a duplicate rather than running the handler twice.
   */
  private async claim(
    where: {
      key_staffId_route: { key: string; staffId: string; route: string };
    },
    data: { key: string; staffId: string; route: string; requestHash: string },
  ): Promise<
    | { id: string; replay: true; responseBody: unknown }
    | { id: string; replay: false }
  > {
    const existing = await this.prisma.idempotencyRecord.findUnique({ where });
    if (existing) return this.asReplay(existing, data.requestHash);

    try {
      const created = await this.prisma.idempotencyRecord.create({ data });
      return { id: created.id, replay: false };
    } catch (err) {
      if ((err as { code?: string }).code !== UNIQUE_VIOLATION) throw err;
      const raced = await this.prisma.idempotencyRecord.findUniqueOrThrow({
        where,
      });
      return this.asReplay(raced, data.requestHash);
    }
  }

  private asReplay(
    record: {
      id: string;
      requestHash: string;
      completedAt: Date | null;
      responseBody: unknown;
    },
    requestHash: string,
  ): { id: string; replay: true; responseBody: unknown } {
    if (record.requestHash !== requestHash) {
      throw new ConflictException(
        'Idempotency-Key already used with a different payload',
      );
    }
    if (!record.completedAt) {
      throw new ConflictException(
        'A request with this Idempotency-Key is still in flight',
      );
    }
    return { id: record.id, replay: true, responseBody: record.responseBody };
  }
}

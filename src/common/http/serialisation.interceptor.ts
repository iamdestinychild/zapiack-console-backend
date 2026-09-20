import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';

/**
 * Prisma hands back BigInt counters and Decimal money, neither of which JSON knows.
 * Counts become numbers; money stays a decimal string so naira never round-trips
 * through a float.
 */
@Injectable()
export class SerialisationInterceptor implements NestInterceptor {
  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    return next.handle().pipe(map(normalise));
  }
}

function normalise(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalise);

  if (typeof value === 'object') {
    // Prisma Decimal instances expose toFixed; keep full precision as a string.
    const maybeDecimal = value as { toFixed?: unknown; toString(): string };
    if (
      typeof maybeDecimal.toFixed === 'function' &&
      !(value instanceof Date)
    ) {
      return maybeDecimal.toString();
    }
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) out[key] = normalise(val);
    return out;
  }

  return value;
}

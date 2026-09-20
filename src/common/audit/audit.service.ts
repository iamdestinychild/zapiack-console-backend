import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../../generated/admin/client';
import { AdminPrismaService } from '../prisma/admin-prisma.service';
import type { StaffPrincipal } from '../auth/staff-principal';

export interface AuditEntry {
  actor?: Pick<StaffPrincipal, 'id' | 'email' | 'ip' | 'userAgent'> | null;
  action: string;
  targetType?: string;
  targetId?: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
  metadata?: Record<string, unknown>;
  requestId?: string;
}

/**
 * Append-only log of everything staff do. Written for every write, every PII reveal,
 * every export and every document download or preview.
 *
 * A failed audit write must not silently swallow the action it was recording, so
 * `record` throws; callers that genuinely cannot fail (read paths) use `recordSafe`.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: AdminPrismaService) {}

  async record(entry: AuditEntry): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        actorId: entry.actor?.id ?? null,
        actorEmail: entry.actor?.email ?? null,
        action: entry.action,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        before: toJson(entry.before),
        after: toJson(entry.after),
        reason: entry.reason ?? null,
        metadata: toJson(entry.metadata),
        ip: entry.actor?.ip ?? null,
        userAgent: entry.actor?.userAgent ?? null,
        requestId: entry.requestId ?? null,
      },
    });
  }

  async recordSafe(entry: AuditEntry): Promise<void> {
    try {
      await this.record(entry);
    } catch (err) {
      this.logger.error(
        `Failed to write audit entry ${entry.action}: ${(err as Error).message}`,
      );
    }
  }
}

/** Prisma Decimal, and anything else that prints itself rather than serialising. */
function isStringifiable(value: unknown): value is { toString(): string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { toFixed?: unknown }).toFixed === 'function'
  );
}

function toJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  // Decimal and BigInt do not survive JSON.stringify; normalise before storing.
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === 'bigint') return item.toString();
      if (isStringifiable(item)) return item.toString();
      return item;
    }),
  ) as Prisma.InputJsonValue;
}

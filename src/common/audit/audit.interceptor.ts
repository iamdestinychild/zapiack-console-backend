import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, tap } from 'rxjs';
import { AUDIT_KEY, REASON_KEY, type AuditSpec } from '../auth/decorators';
import type { AdminRequest, ReasonedBody } from '../http/admin-request';
import { AuditService } from './audit.service';

/**
 * Enforces the written-reason rule and writes the audit entry after the handler
 * succeeds, so a rejected action leaves no misleading "done" record. Handlers that
 * need before/after snapshots write their own entry and omit @Audited.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const targets = [context.getHandler(), context.getClass()];
    const spec = this.reflector.getAllAndOverride<AuditSpec>(
      AUDIT_KEY,
      targets,
    );
    const reasonRequired = this.reflector.getAllAndOverride<boolean>(
      REASON_KEY,
      targets,
    );

    const request = context.switchToHttp().getRequest<AdminRequest>();
    const staff = request.staff;
    const reason = (request.body as ReasonedBody | undefined)?.reason?.trim();

    if (reasonRequired && !reason) {
      throw new BadRequestException('This action requires a written reason');
    }

    if (!spec) return next.handle();

    return next.handle().pipe(
      tap((result) => {
        void this.audit.recordSafe({
          actor: staff,
          action: spec.action,
          targetType: spec.targetType,
          targetId: spec.targetParam
            ? String(request.params?.[spec.targetParam] ?? '')
            : undefined,
          reason,
          metadata: {
            method: request.method,
            path: request.originalUrl ?? request.url,
            result: summarise(result),
          },
          requestId: request.id,
        });
      }),
    );
  }
}

/** Keep audit metadata small: identifiers and counts, not whole payloads. */
function summarise(result: unknown): unknown {
  if (result === null || typeof result !== 'object') return result;
  const obj = result as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const key of [
    'id',
    'status',
    'count',
    'total',
    'applicationId',
    'accountId',
  ]) {
    if (key in obj) picked[key] = obj[key];
  }
  return Object.keys(picked).length
    ? picked
    : { keys: Object.keys(obj).slice(0, 10) };
}

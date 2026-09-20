import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
  applyDecorators,
} from '@nestjs/common';
import type { Permission } from './permissions';
import type { StaffPrincipal } from './staff-principal';

export const PERMISSIONS_KEY = 'admin:permissions';
export const PUBLIC_KEY = 'admin:public';
export const AUDIT_KEY = 'admin:audit';
export const REASON_KEY = 'admin:reason-required';
export const IDEMPOTENT_KEY = 'admin:idempotent';

/** No session required. Used only by login and health. */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/** Every permission listed must be held; the guard checks against the DB-hydrated set. */
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

export interface AuditSpec {
  action: string;
  targetType?: string;
  /** Route param holding the target id, e.g. 'id'. */
  targetParam?: string;
}

/** Writes an audit entry once the handler succeeds. */
export const Audited = (spec: AuditSpec) => SetMetadata(AUDIT_KEY, spec);

/** Rejects the request unless the body carries a non-empty `reason`. */
export const RequireReason = () => SetMetadata(REASON_KEY, true);

/** Requires an Idempotency-Key header and replays the stored response on repeat. */
export const Idempotent = () => SetMetadata(IDEMPOTENT_KEY, true);

/** Shorthand for a sensitive write: permission + reason + idempotency + audit. */
export const SensitiveWrite = (spec: AuditSpec, ...permissions: Permission[]) =>
  applyDecorators(
    RequirePermissions(...permissions),
    RequireReason(),
    Idempotent(),
    Audited(spec),
  );

export const CurrentStaff = createParamDecorator(
  (field: keyof StaffPrincipal | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<{ staff?: StaffPrincipal }>();
    const staff = request.staff;
    return field && staff ? staff[field] : staff;
  },
);

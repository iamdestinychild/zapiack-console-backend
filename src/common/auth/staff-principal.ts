import type { Permission } from './permissions';

/**
 * The authenticated staff member on a request. Permissions are hydrated from the
 * Admin DB on every request, never trusted from the session payload — a role change
 * takes effect immediately rather than at next login.
 */
export interface StaffPrincipal {
  id: string;
  email: string;
  name: string;
  roleId: string;
  roleKey: string;
  permissions: Permission[];
  sessionId: string;
  sessionEpoch: number;
  ip?: string;
  userAgent?: string;
  /** Set while "view as customer" is active; every read is scoped and audited. */
  impersonating?: { accountId: string; expiresAt: Date };
}

export function hasPermission(
  principal: StaffPrincipal,
  permission: Permission,
): boolean {
  return principal.permissions.includes(permission);
}

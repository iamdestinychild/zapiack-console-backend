import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AdminRequest } from '../http/admin-request';
import { PERMISSIONS_KEY } from './decorators';
import type { Permission } from './permissions';

/** Checks the DB-hydrated permission set the SessionGuard attached. */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required?.length) return true;

    const request = context.switchToHttp().getRequest<AdminRequest>();
    const staff = request.staff;
    if (!staff) throw new ForbiddenException('No staff principal on request');

    const missing = required.filter((p) => !staff.permissions.includes(p));
    if (missing.length) {
      throw new ForbiddenException(`Missing permission: ${missing.join(', ')}`);
    }

    // Impersonation is read-only, whatever the staff member's own permissions say.
    if (staff.impersonating && request.method !== 'GET') {
      throw new ForbiddenException('View-as-customer sessions are read-only');
    }

    return true;
  }
}

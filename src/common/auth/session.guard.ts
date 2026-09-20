import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { AdminPrismaService } from '../prisma/admin-prisma.service';
import type { AdminRequest } from '../http/admin-request';
import type { AdminConfig } from '../config/configuration';
import { PUBLIC_KEY } from './decorators';
import { SessionService } from './session.service';
import type { Permission } from './permissions';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Resolves the session cookie into a StaffPrincipal, enforcing CSRF on
 * cookie-authenticated writes and re-reading permissions from the Admin DB on
 * every request.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly prisma: AdminPrismaService,
    private readonly config: ConfigService<{ admin: AdminConfig }, true>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AdminRequest>();
    const cfg = this.config.get('admin', { infer: true });

    const sessionId = (request.cookies as Record<string, string> | undefined)?.[
      cfg.session.accessCookie
    ];
    if (!sessionId) throw new UnauthorizedException('No admin session');

    const record = await this.sessions.get(sessionId);
    if (!record) throw new UnauthorizedException('Session expired');
    if (!record.mfaVerified)
      throw new UnauthorizedException('Two-factor verification required');

    if (!SAFE_METHODS.has(request.method)) {
      const presented = request.get('x-csrf-token') ?? undefined;
      if (!this.sessions.verifyCsrf(record, presented)) {
        throw new ForbiddenException('CSRF token missing or invalid');
      }
    }

    const staff = await this.prisma.staff.findUnique({
      where: { id: record.staffId },
      include: { role: true },
    });
    if (!staff || staff.status !== 'ACTIVE') {
      await this.sessions.revoke(record.sessionId, 'staff_inactive');
      throw new UnauthorizedException('Staff account is not active');
    }

    // Role changes bump the epoch, which invalidates sessions minted before them.
    if (staff.sessionEpoch !== record.sessionEpoch) {
      await this.sessions.revoke(record.sessionId, 'session_epoch_changed');
      throw new UnauthorizedException('Permissions changed; sign in again');
    }

    await this.sessions.touch(record);

    const permissions = [
      ...new Set([...staff.role.permissions, ...staff.extraPermissions]),
    ] as Permission[];

    request.staff = {
      id: staff.id,
      email: staff.email,
      name: staff.name,
      roleId: staff.roleId,
      roleKey: staff.role.key,
      permissions,
      sessionId: record.sessionId,
      sessionEpoch: record.sessionEpoch,
      ip: request.ip,
      userAgent: request.get('user-agent') ?? undefined,
      impersonating:
        record.impersonation && record.impersonation.expiresAt > Date.now()
          ? {
              accountId: record.impersonation.accountId,
              expiresAt: new Date(record.impersonation.expiresAt),
            }
          : undefined,
    };

    return true;
  }
}

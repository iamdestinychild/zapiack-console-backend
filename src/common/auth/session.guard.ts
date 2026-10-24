import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '../../generated/admin/client';
import { TtlCache } from '../cache/ttl-cache';
import { cookieValues } from './session-cookie';
import { Reflector } from '@nestjs/core';
import { AdminPrismaService } from '../prisma/admin-prisma.service';
import type { AdminRequest } from '../http/admin-request';
import type { AdminConfig } from '../config/configuration';
import { PUBLIC_KEY } from './decorators';
import { SessionService } from './session.service';
import type { Permission } from './permissions';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const STAFF_TTL_MS = 10_000;

type StaffWithRole = Prisma.StaffGetPayload<{ include: { role: true } }>;

/**
 * Resolves the session cookie into a StaffPrincipal, enforcing CSRF on
 * cookie-authenticated writes and reading permissions from the Admin DB.
 *
 * The staff row and its role are held in memory for STAFF_TTL_MS, so a screen that
 * fires a dozen requests costs one lookup rather than a dozen. The session itself is
 * still read from Redis on every request, so a revoked session ends at once; a role
 * change or deactivation reaches an instance within STAFF_TTL_MS.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  private readonly staffCache = new TtlCache<StaffWithRole | null>(
    STAFF_TTL_MS,
    500,
  );

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

    const sessionIds = cookieValues(request, cfg.session.accessCookie);
    if (!sessionIds.length) throw new UnauthorizedException('No admin session');

    const record = await this.sessions.firstLive(sessionIds);
    if (!record) throw new UnauthorizedException('Session expired');
    if (!record.mfaVerified)
      throw new UnauthorizedException('Two-factor verification required');

    if (!SAFE_METHODS.has(request.method)) {
      const presented = request.get('x-csrf-token') ?? undefined;
      if (!this.sessions.verifyCsrf(record, presented)) {
        throw new ForbiddenException('CSRF token missing or invalid');
      }
    }

    const staff = await this.staffCache.get(record.staffId, () =>
      this.prisma.staff.findUnique({
        where: { id: record.staffId },
        include: { role: true },
      }),
    );
    if (!staff || staff.status !== 'ACTIVE') {
      this.staffCache.delete(record.staffId);
      await this.sessions.revoke(record.sessionId, 'staff_inactive');
      throw new UnauthorizedException('Staff account is not active');
    }

    // Role changes bump the epoch, which invalidates sessions minted before them.
    if (staff.sessionEpoch !== record.sessionEpoch) {
      // Possibly a stale copy: drop it so the next attempt reads the database.
      this.staffCache.delete(record.staffId);
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

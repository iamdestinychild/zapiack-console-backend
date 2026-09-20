import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { DateTime } from 'luxon';
import { AdminPrismaService } from '../../common/prisma/admin-prisma.service';
import {
  SessionService,
  type SessionRecord,
} from '../../common/auth/session.service';
import { AuditService } from '../../common/audit/audit.service';
import { GeoIpService } from '../../integrations/geoip/geoip.service';
import type { AdminConfig } from '../../common/config/configuration';
import type { StaffPrincipal } from '../../common/auth/staff-principal';
import { PasswordService } from './password.service';
import { TotpService } from './totp.service';

export interface LoginContext {
  ip?: string;
  userAgent?: string;
}

export interface LoginResult {
  session: SessionRecord;
  /** Set when the staff member has not yet enrolled a second factor. */
  enrolment?: { qrCode: string; secret: string };
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly cfg: AdminConfig;

  constructor(
    private readonly prisma: AdminPrismaService,
    private readonly sessions: SessionService,
    private readonly passwords: PasswordService,
    private readonly totp: TotpService,
    private readonly audit: AuditService,
    private readonly geoip: GeoIpService,
    config: ConfigService<{ admin: AdminConfig }, true>,
  ) {
    this.cfg = config.get('admin', { infer: true });
  }

  /**
   * Step one of two. A correct password yields a session that is not yet usable:
   * the SessionGuard rejects it until TOTP has been verified.
   */
  async login(
    email: string,
    password: string,
    ctx: LoginContext,
  ): Promise<LoginResult> {
    const staff = await this.prisma.staff.findUnique({
      where: { email: email.toLowerCase().trim() },
      include: { role: true },
    });

    // Hash regardless of whether the account exists, so timing does not enumerate staff.
    const stored = staff?.passwordHash ?? 'scrypt$65536$8$1$AAAA$AAAA';
    const passwordOk = await this.passwords.verify(password, stored);

    if (!staff) {
      await this.recordAttempt(email, ctx, false, 'unknown_email');
      throw new UnauthorizedException('Invalid credentials');
    }

    if (staff.lockedUntil && staff.lockedUntil > new Date()) {
      await this.recordAttempt(email, ctx, false, 'locked');
      throw new ForbiddenException(
        `Account locked until ${staff.lockedUntil.toISOString()} after repeated failed sign-ins`,
      );
    }

    if (staff.status !== 'ACTIVE') {
      await this.recordAttempt(
        email,
        ctx,
        false,
        `status_${staff.status.toLowerCase()}`,
      );
      throw new ForbiddenException('This staff account is not active');
    }

    if (!passwordOk) {
      await this.registerFailure(staff.id, email, ctx);
      throw new UnauthorizedException('Invalid credentials');
    }

    await this.prisma.staff.update({
      where: { id: staff.id },
      data: { failedLoginCount: 0, lockedUntil: null },
    });

    const session = await this.sessions.create({
      staffId: staff.id,
      sessionEpoch: staff.sessionEpoch,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      mfaVerified: false,
    });

    // First sign-in: hand back an enrolment QR. 2FA is not optional, so the session
    // stays unusable until the staff member proves they scanned it.
    let enrolment: LoginResult['enrolment'];
    if (!staff.totpEnabled) {
      const secret = this.totp.generateSecret();
      await this.prisma.staff.update({
        where: { id: staff.id },
        data: { totpSecret: this.totp.encrypt(secret) },
      });
      enrolment = {
        qrCode: await this.totp.enrolmentQrCode(staff.email, secret),
        secret,
      };
    }

    return { session, enrolment };
  }

  /** Step two. On success the session becomes usable and the sign-in is geo-located. */
  async verifyTotp(
    sessionId: string,
    code: string,
    ctx: LoginContext,
  ): Promise<SessionRecord> {
    const session = await this.sessions.get(sessionId);
    if (!session)
      throw new UnauthorizedException('Session expired; sign in again');
    if (session.mfaVerified) return session;

    const staff = await this.prisma.staff.findUnique({
      where: { id: session.staffId },
    });
    if (!staff?.totpSecret)
      throw new UnauthorizedException('No second factor enrolled');

    if (!(await this.totp.verify(this.totp.decrypt(staff.totpSecret), code))) {
      await this.registerFailure(staff.id, staff.email, ctx, 'bad_totp');
      throw new UnauthorizedException('Invalid two-factor code');
    }

    session.mfaVerified = true;
    await this.sessions.update(session);

    const geo = this.geoip.lookup(ctx.ip);

    await this.prisma.$transaction([
      this.prisma.staff.update({
        where: { id: staff.id },
        data: {
          totpEnabled: true,
          lastLoginAt: new Date(),
          lastLoginIp: ctx.ip ?? null,
        },
      }),
      this.prisma.staffSession.create({
        data: {
          id: session.sessionId,
          staffId: staff.id,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
          country: geo.country,
          city: geo.city,
          latitude: geo.latitude,
          longitude: geo.longitude,
          absoluteExpiresAt: new Date(session.absoluteExpiresAt),
        },
      }),
      // Console sign-ins land in the same table as customer-app sign-ins so the map
      // and the risk rules see one picture.
      this.prisma.signInEvent.create({
        data: {
          surface: 'ADMIN_CONSOLE',
          staffId: staff.id,
          email: staff.email,
          success: true,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
          country: geo.country,
          region: geo.region,
          city: geo.city,
          latitude: geo.latitude,
          longitude: geo.longitude,
        },
      }),
    ]);

    await this.recordAttempt(staff.email, ctx, true);
    await this.audit.recordSafe({
      actor: {
        id: staff.id,
        email: staff.email,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      },
      action: 'auth.login',
      targetType: 'staff',
      targetId: staff.id,
      metadata: { country: geo.country, city: geo.city },
    });

    return session;
  }

  async logout(staff: StaffPrincipal): Promise<void> {
    await this.sessions.revoke(staff.sessionId, 'logout');
    await this.prisma.staffSession
      .update({
        where: { id: staff.sessionId },
        data: { revokedAt: new Date(), revokedReason: 'logout' },
      })
      .catch(() => undefined);
    await this.audit.recordSafe({
      actor: staff,
      action: 'auth.logout',
      targetType: 'staff',
      targetId: staff.id,
    });
  }

  async me(staff: StaffPrincipal) {
    const record = await this.prisma.staff.findUniqueOrThrow({
      where: { id: staff.id },
      include: { role: true },
    });
    const session = await this.sessions.get(staff.sessionId);

    return {
      id: record.id,
      email: record.email,
      name: record.name,
      role: {
        id: record.role.id,
        key: record.role.key,
        name: record.role.name,
      },
      permissions: staff.permissions,
      totpEnabled: record.totpEnabled,
      lastLoginAt: record.lastLoginAt,
      /** The frontend echoes this back in x-csrf-token on every write. */
      csrfToken: session?.csrfToken ?? null,
      sessionExpiresAt: session ? new Date(session.absoluteExpiresAt) : null,
      impersonating: staff.impersonating ?? null,
    };
  }

  async changePassword(staff: StaffPrincipal, current: string, next: string) {
    const record = await this.prisma.staff.findUniqueOrThrow({
      where: { id: staff.id },
    });
    if (!(await this.passwords.verify(current, record.passwordHash))) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    const problems = this.passwords.validateStrength(next);
    if (problems.length)
      throw new BadRequestException(`Password ${problems.join(', ')}`);

    await this.prisma.staff.update({
      where: { id: staff.id },
      data: {
        passwordHash: await this.passwords.hash(next),
        sessionEpoch: { increment: 1 },
      },
    });
    // Every other session dies with the old password.
    await this.sessions.revokeAllForStaff(staff.id, 'password_changed');
    await this.audit.record({
      actor: staff,
      action: 'auth.password_changed',
      targetType: 'staff',
      targetId: staff.id,
    });
  }

  // -------------------------------------------------------------- invites

  async acceptInvite(token: string, password: string, ctx: LoginContext) {
    const invite = await this.prisma.staffInvite.findUnique({
      where: { tokenHash: SessionService.hashToken(token) },
      include: { role: true },
    });

    if (!invite || invite.revokedAt)
      throw new BadRequestException('Invite is not valid');
    if (invite.acceptedAt)
      throw new BadRequestException('Invite has already been used');
    if (invite.expiresAt < new Date())
      throw new BadRequestException('Invite has expired');

    const problems = this.passwords.validateStrength(password);
    if (problems.length)
      throw new BadRequestException(`Password ${problems.join(', ')}`);

    const staff = await this.prisma.$transaction(async (tx) => {
      const created = await tx.staff.create({
        data: {
          email: invite.email.toLowerCase(),
          name: invite.name,
          passwordHash: await this.passwords.hash(password),
          roleId: invite.roleId,
          status: 'ACTIVE',
        },
      });
      await tx.staffInvite.update({
        where: { id: invite.id },
        data: { acceptedAt: new Date() },
      });
      return created;
    });

    await this.audit.recordSafe({
      actor: {
        id: staff.id,
        email: staff.email,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      },
      action: 'staff.invite_accepted',
      targetType: 'staff',
      targetId: staff.id,
      metadata: { roleKey: invite.role.key },
    });

    return { id: staff.id, email: staff.email };
  }

  // -------------------------------------------------------------- impersonation

  /** Read-only "view as customer", time-boxed and audited. */
  async startImpersonation(
    staff: StaffPrincipal,
    accountId: string,
    reason: string,
  ) {
    const expiresAt = DateTime.now()
      .plus({ minutes: this.cfg.auth.impersonationMinutes })
      .toJSDate();

    const session = await this.sessions.get(staff.sessionId);
    if (!session) throw new UnauthorizedException('Session expired');

    session.impersonation = { accountId, expiresAt: expiresAt.getTime() };
    await this.sessions.update(session);

    const record = await this.prisma.impersonationSession.create({
      data: { staffId: staff.id, accountId, reason, expiresAt },
    });

    await this.audit.record({
      actor: staff,
      action: 'customers.impersonate',
      targetType: 'account',
      targetId: accountId,
      reason,
      metadata: { expiresAt, readOnly: true },
    });

    return { id: record.id, accountId, expiresAt, readOnly: true };
  }

  async endImpersonation(staff: StaffPrincipal) {
    const session = await this.sessions.get(staff.sessionId);
    if (session?.impersonation) {
      delete session.impersonation;
      await this.sessions.update(session);
    }
    await this.prisma.impersonationSession.updateMany({
      where: { staffId: staff.id, endedAt: null },
      data: { endedAt: new Date() },
    });
    await this.audit.recordSafe({
      actor: staff,
      action: 'customers.impersonate_end',
    });
  }

  // -------------------------------------------------------------- internals

  private async registerFailure(
    staffId: string,
    email: string,
    ctx: LoginContext,
    reason = 'bad_password',
  ) {
    const updated = await this.prisma.staff.update({
      where: { id: staffId },
      data: { failedLoginCount: { increment: 1 } },
      select: { failedLoginCount: true },
    });

    if (updated.failedLoginCount >= this.cfg.auth.maxFailedLogins) {
      await this.prisma.staff.update({
        where: { id: staffId },
        data: {
          lockedUntil: DateTime.now()
            .plus({ minutes: this.cfg.auth.lockoutMinutes })
            .toJSDate(),
          failedLoginCount: 0,
        },
      });
      this.logger.warn(
        `Locked staff ${email} after ${this.cfg.auth.maxFailedLogins} failed attempts`,
      );
    }

    await this.recordAttempt(email, ctx, false, reason);
  }

  private async recordAttempt(
    email: string,
    ctx: LoginContext,
    success: boolean,
    reason?: string,
  ) {
    await this.prisma.loginAttempt.create({
      data: { email, ip: ctx.ip, userAgent: ctx.userAgent, success, reason },
    });
  }

  static newInviteToken() {
    return randomBytes(32).toString('base64url');
  }
}

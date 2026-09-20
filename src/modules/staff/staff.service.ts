import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DateTime } from 'luxon';
import { AdminPrismaService } from '../../common/prisma/admin-prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { SessionService } from '../../common/auth/session.service';
import { MailerService } from '../../integrations/mailer/mailer.service';
import {
  buildPage,
  cursorWhere,
  decodeCursor,
} from '../../common/http/pagination';
import { ALL_PERMISSIONS } from '../../common/auth/permissions';
import type { AdminConfig } from '../../common/config/configuration';
import type { StaffPrincipal } from '../../common/auth/staff-principal';
import { AuthService } from '../auth/auth.service';
import type {
  InviteStaffDto,
  ListStaffDto,
  UpdateStaffDto,
  UpsertRoleDto,
} from './dto/staff.dto';

/**
 * Staff accounts exist only in the Admin DB and are invite-only. Customers can never
 * sign in here; there is no self-registration path at all.
 */
@Injectable()
export class StaffService {
  private readonly cfg: AdminConfig;

  constructor(
    private readonly prisma: AdminPrismaService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
    private readonly mailer: MailerService,
    config: ConfigService<{ admin: AdminConfig }, true>,
  ) {
    this.cfg = config.get('admin', { infer: true });
  }

  async list(query: ListStaffDto) {
    const limit = query.limit ?? 50;
    const rows = await this.prisma.staff.findMany({
      where: {
        ...cursorWhere(decodeCursor(query.cursor)),
        ...(query.status ? { status: query.status } : {}),
        ...(query.roleKey ? { role: { key: query.roleKey } } : {}),
        ...(query.q
          ? {
              OR: [
                { email: { contains: query.q, mode: 'insensitive' as const } },
                { name: { contains: query.q, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      include: { role: { select: { id: true, key: true, name: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    return buildPage(
      rows.map((s) => ({
        id: s.id,
        createdAt: s.createdAt,
        email: s.email,
        name: s.name,
        status: s.status,
        role: s.role,
        totpEnabled: s.totpEnabled,
        lastLoginAt: s.lastLoginAt,
        locked: Boolean(s.lockedUntil && s.lockedUntil > new Date()),
      })),
      limit,
    );
  }

  async invite(actor: StaffPrincipal, dto: InviteStaffDto) {
    const email = dto.email.toLowerCase().trim();

    if (await this.prisma.staff.findUnique({ where: { email } })) {
      throw new ConflictException(
        'A staff account with that email already exists',
      );
    }
    const role = await this.prisma.role.findUnique({
      where: { id: dto.roleId },
    });
    if (!role) throw new NotFoundException('Role not found');

    const token = AuthService.newInviteToken();
    const expiresAt = DateTime.now()
      .plus({ hours: this.cfg.auth.inviteTtlHours })
      .toJSDate();

    const invite = await this.prisma.staffInvite.create({
      data: {
        email,
        name: dto.name,
        roleId: role.id,
        tokenHash: SessionService.hashToken(token),
        invitedById: actor.id,
        expiresAt,
      },
    });

    const link = `${this.cfg.corsOrigin[0]}/invite?token=${token}`;
    await this.mailer.send({
      to: email,
      subject: 'Your Zapiack Admin Console invitation',
      html: `<p>Hello ${escapeHtml(dto.name)},</p>
<p>${escapeHtml(actor.name)} has invited you to the Zapiack Admin Console as <strong>${escapeHtml(role.name)}</strong>.</p>
<p><a href="${link}">Set your password and enrol two-factor authentication</a></p>
<p>This invitation expires in ${this.cfg.auth.inviteTtlHours} hours.</p>`,
    });

    await this.audit.record({
      actor,
      action: 'staff.invited',
      targetType: 'staff_invite',
      targetId: invite.id,
      after: { email, roleKey: role.key, expiresAt },
    });

    // The raw token leaves in the email and is never stored or returned.
    return { id: invite.id, email, roleKey: role.key, expiresAt };
  }

  async revokeInvite(actor: StaffPrincipal, inviteId: string) {
    const invite = await this.prisma.staffInvite.update({
      where: { id: inviteId },
      data: { revokedAt: new Date() },
    });
    await this.audit.record({
      actor,
      action: 'staff.invite_revoked',
      targetType: 'staff_invite',
      targetId: invite.id,
    });
    return { id: invite.id, revokedAt: invite.revokedAt };
  }

  async update(actor: StaffPrincipal, staffId: string, dto: UpdateStaffDto) {
    const before = await this.prisma.staff.findUnique({
      where: { id: staffId },
      include: { role: true },
    });
    if (!before) throw new NotFoundException('Staff member not found');

    // A super admin cannot quietly demote or lock out the last one.
    if (before.role.key === 'super_admin' && (dto.roleId || dto.status)) {
      const remaining = await this.prisma.staff.count({
        where: {
          role: { key: 'super_admin' },
          status: 'ACTIVE',
          id: { not: staffId },
        },
      });
      if (remaining === 0) {
        throw new BadRequestException(
          'At least one active super admin must remain',
        );
      }
    }

    const roleChanged = Boolean(dto.roleId && dto.roleId !== before.roleId);
    const permissionsChanged =
      roleChanged || dto.extraPermissions !== undefined;

    const after = await this.prisma.staff.update({
      where: { id: staffId },
      data: {
        name: dto.name,
        roleId: dto.roleId,
        status: dto.status,
        extraPermissions: dto.extraPermissions,
        emailNotificationPrefs: dto.emailNotificationPrefs,
        ...(dto.resetTotp ? { totpSecret: null, totpEnabled: false } : {}),
        // Bumping the epoch invalidates live sessions immediately.
        ...(permissionsChanged || dto.status
          ? { sessionEpoch: { increment: 1 } }
          : {}),
      },
      include: { role: true },
    });

    if (permissionsChanged || dto.status) {
      await this.sessions.revokeAllForStaff(staffId, 'permissions_changed');
    }

    await this.audit.record({
      actor,
      action: 'staff.updated',
      targetType: 'staff',
      targetId: staffId,
      reason: dto.reason,
      before: {
        roleKey: before.role.key,
        status: before.status,
        extraPermissions: before.extraPermissions,
      },
      after: {
        roleKey: after.role.key,
        status: after.status,
        extraPermissions: after.extraPermissions,
      },
    });

    return { id: after.id, status: after.status, roleKey: after.role.key };
  }

  // ---------------------------------------------------------------- roles

  listRoles() {
    return this.prisma.role.findMany({
      orderBy: { key: 'asc' },
      include: { _count: { select: { staff: true } } },
    });
  }

  /** The catalogue the console renders the permission picker from. */
  permissionCatalogue() {
    return { permissions: ALL_PERMISSIONS };
  }

  async upsertRole(actor: StaffPrincipal, dto: UpsertRoleDto) {
    const before = await this.prisma.role.findUnique({
      where: { key: dto.key },
    });

    if (before?.isSystem && !arraysEqual(before.permissions, dto.permissions)) {
      // System roles are the documented defaults; changing them silently would make
      // the PRD's role table wrong. Cloning keeps both the default and the variant.
      throw new BadRequestException(
        `${dto.key} is a system role. Create a new role instead of editing its permissions.`,
      );
    }

    const role = await this.prisma.role.upsert({
      where: { key: dto.key },
      create: {
        key: dto.key,
        name: dto.name,
        description: dto.description,
        permissions: dto.permissions,
        ipAllowlist: dto.ipAllowlist ?? [],
      },
      update: {
        name: dto.name,
        description: dto.description,
        permissions: dto.permissions,
        ipAllowlist: dto.ipAllowlist ?? [],
      },
    });

    // Anyone holding this role loses their session, so a narrowed role cannot be
    // used for the rest of the working day.
    if (before) {
      const holders = await this.prisma.staff.findMany({
        where: { roleId: role.id },
        select: { id: true },
      });
      await this.prisma.staff.updateMany({
        where: { roleId: role.id },
        data: { sessionEpoch: { increment: 1 } },
      });
      await Promise.all(
        holders.map((s) =>
          this.sessions.revokeAllForStaff(s.id, 'role_permissions_changed'),
        ),
      );
    }

    await this.audit.record({
      actor,
      action: before ? 'roles.updated' : 'roles.created',
      targetType: 'role',
      targetId: role.id,
      before: before
        ? { permissions: before.permissions, ipAllowlist: before.ipAllowlist }
        : undefined,
      after: { permissions: role.permissions, ipAllowlist: role.ipAllowlist },
    });

    return role;
  }
}

function arraysEqual(a: string[], b: string[]) {
  return (
    a.length === b.length &&
    [...a].sort().every((v, i) => v === [...b].sort()[i])
  );
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

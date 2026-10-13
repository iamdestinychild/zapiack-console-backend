import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { AdminPrismaService } from '../../common/prisma/admin-prisma.service';
import { ALL_PERMISSIONS } from '../../common/auth/permissions';

/**
 * Keeps the super admin role complete across releases.
 *
 * Roles live in the Admin database, so a release that adds a permission does not reach
 * a role that already exists. The seed would refresh it, but it also rewrites every
 * system role, discarding changes made to them in the console. The super admin is
 * defined as "everything", so topping up that one role is always right; every other
 * role is left exactly as it is, and grants for them are a decision for a super admin.
 *
 * Only ever adds. It never removes a permission, and never touches a role's network
 * allowlist.
 */
@Injectable()
export class SuperAdminSyncService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SuperAdminSyncService.name);

  constructor(private readonly prisma: AdminPrismaService) {}

  async onApplicationBootstrap() {
    try {
      const role = await this.prisma.role.findUnique({
        where: { key: 'super_admin' },
        select: { id: true, permissions: true },
      });
      if (!role) return; // Not seeded yet; the seed creates it complete.

      const missing = ALL_PERMISSIONS.filter(
        (permission) => !role.permissions.includes(permission),
      );
      if (!missing.length) return;

      await this.prisma.role.update({
        where: { id: role.id },
        data: { permissions: [...role.permissions, ...missing] },
      });
      this.logger.log(
        `super_admin gained ${missing.length} permission(s): ${missing.join(', ')}`,
      );
    } catch (err) {
      // A courtesy at start-up; failing it must never stop the service.
      this.logger.error(`super_admin sync skipped: ${(err as Error).message}`);
    }
  }
}

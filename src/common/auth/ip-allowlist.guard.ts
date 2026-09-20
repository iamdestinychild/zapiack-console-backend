import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { AdminPrismaService } from '../prisma/admin-prisma.service';
import type { AdminRequest } from '../http/admin-request';
import { ipInCidr, normaliseIp } from './cidr';

/**
 * Optional per-role network restriction, e.g. Finance only from the office or VPN.
 * An empty allowlist on the role means no restriction.
 */
@Injectable()
export class IpAllowlistGuard implements CanActivate {
  constructor(private readonly prisma: AdminPrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AdminRequest>();
    const staff = request.staff;
    if (!staff) return true;

    const role = await this.prisma.role.findUnique({
      where: { id: staff.roleId },
      select: { ipAllowlist: true, key: true },
    });
    if (!role?.ipAllowlist.length) return true;

    const ip = normaliseIp(request.ip);
    if (!ip || !role.ipAllowlist.some((cidr) => ipInCidr(ip, cidr))) {
      throw new ForbiddenException(
        `Role ${role.key} may not be used from this network`,
      );
    }
    return true;
  }
}

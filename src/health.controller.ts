import { Controller, Get } from '@nestjs/common';
import { Public } from './common/auth/decorators';
import { AdminPrismaService } from './common/prisma/admin-prisma.service';
import { ZapiackPrismaService } from './common/prisma/zapiack-prisma.service';
import { RedisService } from './common/redis/redis.service';
import { GeoIpService } from './integrations/geoip/geoip.service';

/** Liveness for the load balancer, readiness for a deploy gate. */
@Controller('health')
export class HealthController {
  constructor(
    private readonly admin: AdminPrismaService,
    private readonly zapiack: ZapiackPrismaService,
    private readonly redis: RedisService,
    private readonly geoip: GeoIpService,
  ) {}

  @Public()
  @Get()
  live() {
    return { status: 'ok', service: 'admin-core' };
  }

  @Public()
  @Get('ready')
  async ready() {
    const checks = await Promise.allSettled([
      this.admin.$queryRaw`SELECT 1`,
      this.zapiack.read.$queryRaw`SELECT 1`,
      this.redis.client.ping(),
    ]);

    const [adminDb, zapiackDb, redis] = checks.map(
      (c) => c.status === 'fulfilled',
    );

    return {
      // GeoIP missing degrades location accuracy but does not stop the service, so it
      // is reported without failing readiness.
      status: adminDb && zapiackDb && redis ? 'ready' : 'degraded',
      checks: { adminDb, zapiackDb, redis, geoip: this.geoip.ready },
    };
  }
}

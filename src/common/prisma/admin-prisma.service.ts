import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/admin/client';
import type { AdminConfig } from '../config/configuration';

/** Read/write client for the Admin DB. admin-core owns this database outright. */
@Injectable()
export class AdminPrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(AdminPrismaService.name);

  constructor(config: ConfigService<{ admin: AdminConfig }, true>) {
    const db = config.get('admin', { infer: true }).database;
    super({
      adapter: new PrismaPg({ connectionString: db.adminUrl, max: db.poolMax }),
    });
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log('Admin DB connected');
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}

import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/zapiack/client';
import type { AdminConfig } from '../config/configuration';

/**
 * Read-only client for the Zapiack DB replica.
 *
 * Two lines of defence stop a stray write: the database role has SELECT only, and
 * the extension below rejects mutating operations before they leave the process, so
 * a mistake shows up as a clear error instead of a permission-denied at runtime.
 * Every product write goes through api-core so ledger, idempotency and balance rules
 * live in exactly one place.
 */
const MUTATING = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
  'executeRaw',
  'executeRawUnsafe',
  '$executeRaw',
  '$executeRawUnsafe',
]);

@Injectable()
export class ZapiackPrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ZapiackPrismaService.name);

  constructor(config: ConfigService<{ admin: AdminConfig }, true>) {
    const db = config.get('admin', { infer: true }).database;
    super({
      adapter: new PrismaPg({
        connectionString: db.zapiackReadUrl,
        max: db.poolMax,
      }),
    });
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log('Zapiack read replica connected (read-only)');
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  private guarded?: ReturnType<typeof guard>;

  /**
   * Guarded client; use this everywhere instead of the raw instance.
   *
   * Built once. It used to be built on every access, and the live-map poll alone
   * touches it every three seconds, so each use paid for a new extended client.
   */
  get read() {
    return (this.guarded ??= guard(this));
  }
}

function guard(client: PrismaClient) {
  return client.$extends({
    query: {
      $allOperations({ operation, model, args, query }) {
        if (MUTATING.has(operation)) {
          throw new Error(
            `Refused ${operation} on ${model ?? 'raw SQL'}: the Zapiack DB is read-only from admin-core. Route the write through api-core.`,
          );
        }
        return query(args);
      },
    },
  });
}

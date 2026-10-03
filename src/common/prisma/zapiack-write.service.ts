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
 * The narrow write path into the Zapiack DB.
 *
 * admin-core reads the product database through a SELECT-only role. This is the one
 * exception: a separate connection, on a role granted write access to the catalogue,
 * account status and sender ID tables and nothing else.
 *
 * **The credit ledger is deliberately not here.** `tab_transactions` and
 * `accounts.creditBalance` stay with api-core so balance arithmetic and idempotency
 * have a single owner; the extension below refuses them even if a caller tries, and
 * the database grant should refuse them again.
 *
 * Every write is expected to be audited by its caller. This service does not audit on
 * its own behalf, because the caller knows the reason and the before/after shape.
 */
/**
 * Compared case-insensitively: Prisma reports the model to an extension in the case
 * it was declared (`TabTransaction`), not the camelCase used to call it. Matching on
 * the wrong one makes this guard silently allow everything.
 */
export const FORBIDDEN_WRITE_MODELS = new Set([
  'tabtransaction',
  'transactions',
]);

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
]);

/** Exported so the guard is testable without a database. */
export function isLedgerWrite(operation: string, model?: string): boolean {
  if (!model || !MUTATING.has(operation)) return false;
  return FORBIDDEN_WRITE_MODELS.has(model.toLowerCase());
}

@Injectable()
export class ZapiackWriteService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ZapiackWriteService.name);
  private readonly configured: boolean;

  constructor(config: ConfigService<{ admin: AdminConfig }, true>) {
    const db = config.get('admin', { infer: true }).database;
    super({
      adapter: new PrismaPg({
        connectionString: db.zapiackWriteUrl,
        max: db.poolMax,
      }),
    });
    this.configured = Boolean(
      process.env.ZAPIACK_WRITE_DATABASE_URL &&
      process.env.ZAPIACK_WRITE_DATABASE_URL !== db.zapiackReadUrl,
    );
  }

  async onModuleInit() {
    await this.$connect();
    if (this.configured) {
      this.logger.log(
        'Zapiack write connection ready (catalogue, status, reviews)',
      );
    } else {
      // Loud on purpose: writes would otherwise fail one by one at the first attempt,
      // in production, with a permission error nobody expects.
      this.logger.warn(
        'ZAPIACK_WRITE_DATABASE_URL is not set; product writes will use the read-only role and fail',
      );
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  /** Guarded client. Use this rather than the instance, so the ledger stays out. */
  get write() {
    return this.$extends({
      query: {
        $allOperations({ operation, model, args, query }) {
          if (isLedgerWrite(operation, model)) {
            throw new Error(
              `Refused ${operation} on ${model}: the credit ledger belongs to api-core. ` +
                'Route balance changes through the credit adjustment flow.',
            );
          }
          return query(args);
        },
      },
    });
  }
}

import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';

import configuration, { type AdminConfig } from './common/config/configuration';
import { runsBackgroundWork } from './common/config/role';
import { validateEnv } from './common/config/env.validation';
import { PrismaModule } from './common/prisma/prisma.module';
import { RedisModule } from './common/redis/redis.module';
import { RedisService } from './common/redis/redis.service';
import { AuditModule } from './common/audit/audit.module';
import { AuditInterceptor } from './common/audit/audit.interceptor';
import { IdempotencyInterceptor } from './common/idempotency/idempotency.interceptor';
import { SerialisationInterceptor } from './common/http/serialisation.interceptor';
import { AllExceptionsFilter } from './common/http/all-exceptions.filter';
import { RequestIdMiddleware } from './common/http/request-id.middleware';
import { SseModule } from './common/sse/sse.module';
import { SessionGuard } from './common/auth/session.guard';
import { PermissionsGuard } from './common/auth/permissions.guard';
import { IpAllowlistGuard } from './common/auth/ip-allowlist.guard';
import { IntegrationsModule } from './integrations/integrations.module';

import { HealthController } from './health.controller';
import { AuthModule } from './modules/auth/auth.module';
import { StaffModule } from './modules/staff/staff.module';
import { CustomersModule } from './modules/customers/customers.module';
import { CreditsModule } from './modules/credits/credits.module';
import { PlansModule } from './modules/plans/plans.module';
import { FinanceModule } from './modules/finance/finance.module';
import { ServicesModule } from './modules/services/services.module';
import { MemoryReporter } from './common/diagnostics/memory-reporter.service';
import { MessagesModule } from './modules/messages/messages.module';
import { TemplatesModule } from './modules/templates/templates.module';
import { GeoModule } from './modules/geo/geo.module';
import { SenderIdsModule } from './modules/sender-ids/sender-ids.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { InboxModule } from './modules/inbox/inbox.module';
import { AuditQueryModule } from './modules/audit/audit-query.module';
import { OverviewModule } from './modules/overview/overview.module';
import { EventsModule } from './modules/events/events.module';
import { RiskModule } from './modules/risk/risk.module';
import { RollupsModule } from './modules/rollups/rollups.module';
import { JobsModule } from './modules/jobs/jobs.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [() => ({ admin: configuration() })],
      validate: validateEnv,
      cache: true,
    }),
    BullModule.forRootAsync({
      inject: [RedisService],
      useFactory: (redis: RedisService) => ({
        connection: redis.bullConnection,
        // BullMQ manages its own connections and never sees ioredis' keyPrefix, so
        // its namespace is set here. Without it, queues land under a bare `bull:`
        // shared with anything else on this Redis.
        prefix: `${redis.prefix}bull`,
      }),
    }),
    PrismaModule,
    RedisModule,
    SseModule,
    AuditModule,
    IntegrationsModule,

    AuthModule,
    StaffModule,
    CustomersModule,
    CreditsModule,
    PlansModule,
    FinanceModule,
    ServicesModule,
    MessagesModule,
    TemplatesModule,
    GeoModule,
    SenderIdsModule,
    NotificationsModule,
    InboxModule,
    AuditQueryModule,
    OverviewModule,
    EventsModule,
    RiskModule,
    RollupsModule,

    // Timers and queue consumers run only where they are wanted. A `web` process
    // enqueues work; a `worker` process performs it.
    ...(runsBackgroundWork() ? [JobsModule] : []),
  ],
  controllers: [HealthController],
  providers: [
    // Order matters: the session must resolve before permissions are checked, and the
    // network restriction applies to an already-identified staff member.
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_GUARD, useClass: IpAllowlistGuard },

    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    { provide: APP_INTERCEPTOR, useClass: SerialisationInterceptor },

    { provide: APP_FILTER, useClass: AllExceptionsFilter },

    MemoryReporter,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}

export type { AdminConfig };

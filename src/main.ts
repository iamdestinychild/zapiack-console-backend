import { Logger, ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import type { AdminConfig } from './common/config/configuration';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // The event ingest route verifies an HMAC over the exact bytes received, so the
    // raw body has to survive JSON parsing.
    rawBody: true,
  });

  const config = app.get(ConfigService<{ admin: AdminConfig }, true>);
  const cfg = config.get('admin', { infer: true });
  const logger = new Logger('bootstrap');

  app.setGlobalPrefix('admin/v1', { exclude: ['health', 'health/ready'] });
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: false as never,
  });

  app.use(cookieParser());
  app.use(
    helmet({
      // The console is an API only; a restrictive CSP costs nothing here and closes
      // off any accidental HTML response being useful to an attacker.
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
        },
      },
      hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: true },
      frameguard: { action: 'deny' },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );

  // Strictly the console origin. Credentials are on, so a wildcard is not an option.
  app.enableCors({
    origin: cfg.corsOrigin,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'content-type',
      'x-csrf-token',
      'idempotency-key',
      'x-request-id',
    ],
    maxAge: 600,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  // Behind a load balancer, req.ip must be the client's — the IP allowlist, the geo
  // map and the audit trail all depend on it.
  app.set('trust proxy', 1);
  app.enableShutdownHooks();

  await app.listen(cfg.port);
  logger.log(
    `admin-core listening on ${cfg.port} (${cfg.env}), console origin ${cfg.corsOrigin.join(', ')}`,
  );
}

void bootstrap();

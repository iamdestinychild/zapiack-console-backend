import { INestApplication } from '@nestjs/common';
import {
  DocumentBuilder,
  SwaggerModule,
  type OpenAPIObject,
} from '@nestjs/swagger';

/**
 * The API description the console is built against, derived from the controllers and
 * DTOs rather than maintained by hand, so it cannot drift from what the service
 * actually accepts.
 *
 *   GET /admin/v1/docs        browsable reference
 *   GET /admin/v1/docs-json   OpenAPI 3 document, for type generation
 *
 * Served outside production by default. `ADMIN_EXPOSE_DOCS=true` turns it on
 * elsewhere; it exposes no data, only the shape of the API.
 */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Zapiack Admin Console API')
    .setDescription(
      [
        'Backend for the Zapiack Admin Console.',
        '',
        '**Authentication is two steps.** `POST /auth/login` returns `totp_required` and',
        'sets a session cookie that every guarded route rejects until',
        '`POST /auth/2fa/verify` succeeds. Send `credentials: "include"` on every request.',
        '',
        '**Writes need `x-csrf-token`**, echoing the value from `/auth/2fa/verify` or',
        '`/auth/me`. Some also need an `Idempotency-Key` header and a written `reason`;',
        'each operation says which.',
        '',
        '**Every list returns `{ data, hasMore, nextCursor }`.** Extra context sits beside',
        '`data`, never instead of it.',
        '',
        '**Money is a decimal string** (`"125000.0000"`), never a number. Dates are',
        'Africa/Lagos calendar days. Unknown query or body fields are rejected with 400.',
      ].join('\n'),
    )
    .setVersion('1.0')
    .addCookieAuth('zpk_admin_at', {
      type: 'apiKey',
      in: 'cookie',
      name: 'zpk_admin_at',
      description:
        'Session cookie, set by the login flow. Not readable from JavaScript.',
    })
    .addGlobalParameters(
      {
        name: 'x-csrf-token',
        in: 'header',
        required: false,
        description:
          'Required on every non-GET request. Read it from /auth/me.',
        schema: { type: 'string' },
      },
      {
        name: 'Idempotency-Key',
        in: 'header',
        required: false,
        description:
          'Required on the write routes marked idempotent. One UUID per user intent, reused on every retry of that intent: the first call runs, later calls replay its response.',
        schema: { type: 'string', format: 'uuid' },
      },
    )
    .addTag('Auth', 'Sign in, two-factor, sessions and impersonation')
    .addTag('Overview', 'Landing-screen KPIs, timeseries and rollup freshness')
    .addTag('Customers', 'Search, Customer 360, actions and PII reveal')
    .addTag('Credits', 'Credit adjustments and the two-approver threshold')
    .addTag(
      'Plans',
      'Plans, customer pricing, provider costs and margin targets',
    )
    .addTag('Finance', 'Revenue, profit, cash, reconciliation and exports')
    .addTag('Services', 'Per-channel metrics and provider health')
    .addTag('Geo', "God's-eye map, sign-ins, destinations and the request log")
    .addTag('Sender IDs', 'Review queue, checklist, decisions and documents')
    .addTag('Notifications', 'Campaigns, segments and templates')
    .addTag('Inbox', 'Staff notifications')
    .addTag('Staff', 'Staff accounts, invites and roles')
    .addTag('Audit', 'The append-only audit log')
    .build();

  return SwaggerModule.createDocument(app, config);
}

export function mountOpenApi(
  app: INestApplication,
  document: OpenAPIObject,
): void {
  SwaggerModule.setup('admin/v1/docs', app, document, {
    jsonDocumentUrl: 'admin/v1/docs-json',
    swaggerOptions: {
      persistAuthorization: true,
      tagsSorter: 'alpha',
      operationsSorter: 'alpha',
      // The browsable docs run against the live service, so requests carry the
      // session cookie and actually work while you are signed in.
      withCredentials: true,
    },
    customSiteTitle: 'Zapiack Admin API',
  });
}

# admin-core

Backend for the Zapiack Admin Console: the internal staff app for customers, plans,
money, channel health, sender ID compliance and a live map of where users and API
traffic come from.

It is a separate service from the customer product. It owns its own **Admin DB**, reads
the **Zapiack DB** through a replica, and never writes product data directly — every
change goes through `api-core`, so ledger, idempotency and balance rules live in one
place.

## How the pieces fit

```
Admin frontend ──► admin-core ──┬──► Zapiack DB replica   (read-only role, SELECT only)
                                ├──► Admin DB             (read/write, owned outright)
                                ├──► api-core             (signed internal API, all writes)
                                ├──► Redis                (sessions, BullMQ, SSE fan-out)
                                └──► S3                   (sender ID docs, exports)
```

Two Prisma schemas, two generated clients:

| Schema | Purpose | Migrated from here? |
| --- | --- | --- |
| `prisma/admin/schema.prisma` | Staff, roles, audit, reviews, campaigns, request log, rollups | Yes |
| `prisma/zapiack/schema.prisma` | Hand-maintained read-only mirror of the product schema | **No** |

The Zapiack client refuses mutating operations in process as well as at the database
role, so a stray write fails with a clear error rather than a permission denial.

## Running it

```bash
npm install
cp .env.example .env          # fill in the database URLs at minimum
docker compose up -d          # Postgres and Redis for local development
npm run prisma:generate       # both clients
npm run prisma:migrate        # Admin DB only
npm run build
ADMIN_SEED_EMAIL=you@zapiack.com ADMIN_SEED_PASSWORD='...' npm run prisma:seed
npm run start:dev
```

`docker-compose.yml` reads `DB_USERNAME`, `DB_PASSWORD`, `DB_NAME`, `DB_PORT`,
`REDIS_PORT` and `REDIS_PASSWORD` from the same `.env`; keep them consistent with the
connection strings beside them.

It runs on **5433 and 6380**, under the names `zapiack_admin_postgres` and
`zapiack_admin_redis`. The `zapiack-backend` stack holds 5432, 6379 and the plain
`zapiack_postgres` / `zapiack_redis` names, and the admin console has to run beside the
product rather than instead of it.

admin-core needs two databases. `POSTGRES_DB` creates the Admin DB;
`docker/postgres-init/` creates the `zapiack` mirror next to it on first start, so the
console is developable without the product stack. To work against real product data,
point `ZAPIACK_READ_DATABASE_URL` at the `zapiack-backend` Postgres on 5432 instead. In
production that variable points at the read replica, through a SELECT-only role.

The seed creates the seven system roles and one super admin. Staff are invite-only
after that; there is no self-registration and customers can never sign in.

`GET /health` and `GET /health/ready` are the only routes outside `/admin/v1`.

### Migrations

Two ship together and must be applied in order. The second does things Prisma's schema
language cannot express:

- makes `audit_log` append-only with a database trigger, so no role — including a
  super admin holding the connection string — can edit or delete history;
- rebuilds `request_logs` as a daily-partitioned table, so 90-day retention is a
  `DROP TABLE` rather than an unaffordable `DELETE`;
- adds `create_request_log_partition`, which the maintenance job calls each night.

That second migration **drops and recreates `request_logs`**. It is written for install
time, when the table is empty. See the comment at the top of the file before applying
it to a database whose request log is already in use.

## Security model

- **Sessions.** Email + password then mandatory TOTP. The session is unusable until the
  second factor is verified. Opaque session id in an httpOnly cookie, state in Redis
  under an admin-only key prefix, with distinct cookie names, secret and prefix from the
  customer app — a customer token can never satisfy an admin guard. 12-hour absolute
  lifetime, 30-minute idle timeout.
- **Permissions** are granular strings (`customers.read`, `credits.adjust`,
  `senderid.documents.download`…) bundled into roles stored in the Admin DB, so a new
  role is data rather than a deploy. They are re-read from the database on every
  request and never trusted from the session payload; a role change bumps an epoch that
  invalidates live sessions immediately.
- **CSRF** double-submit on every cookie-authenticated write. **Strict CORS** to the
  console origin. Optional per-role IP allowlist.
- **PII** — emails, phone numbers and IPs — is masked by default everywhere, including
  in exports. Unmasking needs `pii.reveal`, a written reason, and is audited field by
  field. Rate limited per staff member.
- **Sensitive actions** need a written reason; credit adjustments above ₦100,000 need a
  second approver who is not the requester; broadcasts above 1,000 accounts need Super
  admin approval. "View as customer" is read-only and time-boxed.
- **Audit** is written for every write, every PII reveal, every export and every
  document download or preview, and cannot be edited by anyone.

## Two details worth knowing before you change things

**Rollups are recomputed, not incremented.** Every job upserts a
`(date, hour, channel, accountId, country, provider)` bucket from the source rows, so
re-running a window is safe and late delivery receipts self-heal. `hour = -1` is the
finalised daily row; the hourly rows use `0-23`. Sum one or the other, never both.

**Idempotency completes before responding.** Write routes take an `Idempotency-Key`.
The completion record is written *before* the response is emitted — fire-and-forget
leaves a window where a client retrying on timeout is wrongly told its request is still
in flight. Concurrent duplicates are settled by the unique index: one runs, the rest
replay. Note that BullMQ rejects `:` in a custom job id, so deterministic ids use `-`.

## Money

All figures are NGN over Africa/Lagos days.

```
Gross profit = recognised revenue − provider cost − payment processing fees
```

Recognised revenue counts credits when they are **consumed**. Cash collected is reported
separately, because a prepaid top-up is a liability until it is spent. Customer-facing
prices live in the Zapiack DB and provider costs in the Admin DB; both are versioned by
effective-from date and never overwritten, so last month's profit does not move when
this month's price changes.

## Jobs

| Cadence | Work |
| --- | --- |
| 5 min | Roll up the current Lagos day; roll up API requests |
| 10 min | Provider health sampling; sender ID SLA sweep |
| 30 min | Risk scan (volume spikes, failure rates, destination spread, pumping) |
| Nightly | Finalise the previous day, then reconcile against Paystack and provider costs |
| Nightly | Create tomorrow's partitions, drop expired ones, expire export links |
| Weekly | Refresh the GeoLite2 database |

Cron only enqueues; BullMQ processors do the work, with deterministic job ids so two
instances ticking together enqueue one job between them.

Inbound events (`usage.recorded`, `request.logged`, `auth.signin`, `payment.*`,
`senderid.submitted`, `delivery.receipt`) are persisted first and processed through a
job keyed by event id. A sweep re-queues anything stuck, which is the reason for
persisting first.

## Testing

```bash
npm run typecheck
npm test
```

The unit suite covers the logic that carries real risk and needs no infrastructure:
the sender ID state machine, PII masking, CIDR matching, Lagos day boundaries, cursor
pagination, password hashing and the idempotency interceptor. Anything needing
Postgres, Redis and S3 belongs in `test/` behind `npm run test:e2e`.

## Where things are

```
src/
  common/        config, both Prisma clients, Redis, guards, audit, idempotency, SSE
  integrations/  api-core, S3, GeoIP, SES, sms-core
  modules/
    auth/        password, TOTP, sessions, invites, impersonation
    staff/       staff and role management
    customers/   search, Customer 360, actions, PII reveal
    credits/     adjustments and the approval threshold
    plans/       plans, customer pricing, provider costs, margin targets
    finance/     revenue, profit, cash, reconciliation, exports
    services/    per-channel metrics and provider health
    geo/         request ingest worker, live map, request log
    sender-ids/  review queue, checklist, decisions, S3 documents
    notifications/ segments, templates, campaigns
    inbox/       staff notifications over SSE
    risk/        automatic risk flags
    rollups/     the aggregation SQL
    events/      inbound event ingest
    jobs/        scheduler and processors
```

## Not built here

Per the PRD's non-goals: no customer-facing features, no ad-hoc SQL console, no
automated sender ID approval (humans decide), and no multi-currency reporting.

Still open, and worth settling before the relevant screens are built: whether video,
audio, liveness and mapping are customer products or console tooling; which liveness
and mapping vendors provide per-call cost; which sender ID documents are required per
applicant type; the retention period for sender ID documents; whether ₦100,000 is the
right approval threshold; and whether subscription revenue should be recognised daily
across the period rather than on the payment date, which is what
`snapshotFinance` currently does.

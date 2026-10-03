# Deploying admin-core on Render

Two Blueprints, one per repo. Render builds from GitHub, and **GitHub Actions gates it**:
the web service uses `autoDeployTrigger: checksPass`, so a push deploys only after the CI
run for that commit is green. There is no SSH, no registry and no deploy secret to manage.

| Piece | Where | Cost |
| --- | --- | --- |
| admin-core (API + schedulers + queue consumers, one process) | Render web service | free, or the cheapest paid plan |
| Redis (sessions, queues, live-stream fan-out) | Render Key Value | free |
| Console frontend | Render static site | free |
| **Admin DB** | **a durable Postgres you bring** | free tier of Neon or similar |
| Zapiack product DB | where it already lives | unchanged |

## The three limits that shaped this, and what they cost you

These come from Render's documentation, read on 3 Oct 2026. Check them again before relying
on them; pricing pages change.

**A free web service sleeps after 15 minutes without traffic** and takes about a minute to
wake. Everything in admin-core's schedule (five-minute rollups, the nightly finalise, SLA
alerts) is in-process, so none of it runs while asleep. Two things soften this: on every
start admin-core looks at how far the nightly finalise got and re-queues any days it missed
(`catch-up.service.ts`), so a sleep or a deploy over midnight loses nothing durable; and the
live map and staff inbox simply reconnect. What it cannot do is *act* while asleep, so SLA
breach alerts will be late. Free instances also get 750 hours a month per workspace.
If that matters, set `plan: 0.5c-512mb` in `render.yaml` (the cheapest paid plan).

**Render's free Postgres is deleted 30 days after creation** (with a 14-day grace period).
The Admin DB holds staff, roles, the append-only audit log and every sender ID decision,
none of it recoverable from the product database. Do not put it there. Use a database that
does not expire, and set `ADMIN_DATABASE_URL` to it.

**Pre-deploy commands are paid-only**, so migrations run when the container starts
(`ADMIN_RUN_MIGRATIONS=true`, see `docker-entrypoint.sh`). `migrate deploy` is idempotent
and takes an advisory lock. A failed migration stops the container, and Render keeps the
previous deploy serving until the new one passes its health check.

Free Key Value is in-memory only, so a restart signs everyone out and drops queued jobs.
Rollups recompute from source, so nothing durable is lost.

## First-time setup

**1. A durable Admin DB.** Create a Postgres that does not expire (Neon's free tier works)
and keep its connection string for step 3. It needs the `uuid`-free defaults only; the
migrations create everything, including the audit-log triggers.

**2. Push both repos to GitHub.** The dashboard is not a git repository yet:
`git init`, commit, and push it to its own repo.

**3. Create the two database roles on the product DB.** admin-core must not connect with
the product's owner credentials. Run `prisma/grants/zapiack-roles.sql` once, as the owner,
after replacing its two placeholder passwords (Neon: SQL Editor). It creates `admin_reader`
(SELECT on only the columns the console uses) and `admin_writer` (the narrow writes the
console makes). It withholds `api_keys."keyHash"`, message `content` and `recipient`, and
the gateway fields on `transactions`, and it gives the writer no access to the credit
ledger or `accounts."creditBalance"`. Those grants were tested by running the whole API
under the two roles. Build the two connection strings from them.

**4. Create the backend from the Blueprint.** Render dashboard, New, Blueprint, choose
`zapiack-console-backend`. Render creates the web service and the Key Value instance and
prompts for every value marked `sync: false` in `render.yaml`:

| Variable | Value |
| --- | --- |
| `ADMIN_DATABASE_URL` | the durable Postgres from step 1 |
| `ZAPIACK_READ_DATABASE_URL` | the product DB, through a SELECT-only role |
| `ZAPIACK_WRITE_DATABASE_URL` | the product DB, through a role that can write `products`, `product_pricing`, `plans`, `accounts`, `api_keys`, `projects` and `sender_id_applications`, and **nothing else** |
| `API_CORE_BASE_URL`, `API_CORE_SERVICE_TOKEN`, `API_CORE_SIGNING_SECRET` | shared with api-core |
| `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_EXPORT_BUCKET`, `SES_FROM_ADDRESS` | exports and email |
| `ADMIN_CORS_ORIGIN` | the console's exact origin, e.g. `https://console.example.com` |
| `ADMIN_COOKIE_DOMAIN` | the shared parent domain, e.g. `example.com` |

`.env.render.example` has every value with its format and where it comes from. Neon's
connection strings include `&channel_binding=require`; drop it, since the Node driver does
not negotiate channel binding and the connection can be refused. Use the pooled (`-pooler`)
host. If you ever see prepared-statement errors, switch that one URL to the direct host.

`ADMIN_JWT_SECRET` is generated for you. The product database must accept connections from
Render: allow its outbound addresses (Render lists them per region) wherever that database
is firewalled.

**5. Create the console.** New, Blueprint, choose the dashboard repo. Set
`VITE_API_BASE_URL` to the API's public URL. It is baked into the bundle at build time, so
changing it means a rebuild.

**6. Custom domains, on the same parent.** Add `api.example.com` to the web service and
`console.example.com` to the static site, and create the CNAME records Render shows you.
Hobby workspaces include two custom domains, which is exactly this. **This is not
optional**: the session cookie is `SameSite=Strict`, so a console on one site and an API on
another never stays signed in. The `*.onrender.com` addresses will not work with each other.

**7. Seed the first super admin, once.** From Render's Shell tab on the web service:

```bash
ADMIN_SEED_EMAIL=you@example.com ADMIN_SEED_PASSWORD='<a long one>' node dist/seed.js
```

(Render's Shell is available on paid instances. On free, run the seed from your own machine
against the Admin DB: `ADMIN_DATABASE_URL=... node dist/seed.js` after `npm run build`.)

## What a deploy does

1. You push. GitHub Actions runs lint, typecheck, tests, the migration replay and the
   Blueprint checks.
2. Render waits for that run. Green: it builds the Docker image from `Dockerfile`.
3. The new container starts, applies pending migrations, boots, and must pass `/health`.
4. Render switches traffic. If any step fails, the previous deploy keeps serving.

Roll back from the Render dashboard: Events, then Rollback on a previous deploy. **Code
rolls back; migrations do not** (`migrate deploy` only moves forward). A destructive schema
change needs a compensating migration. Add the column, deploy, backfill, and drop the old
one in a later release.

## Operating it

**Is it healthy?** `GET /health/ready` reports each dependency separately.
`GET /admin/v1/overview/health` reports rollup lag per job; past 15 minutes the schedulers
are not running, which on the free plan usually just means it was asleep.

**Logs** are in the Render dashboard, structured, with a `requestId` that matches what the
API returns to the console and what api-core logs.

**Backups.** Nothing here backs up the Admin DB. Use your Postgres host's backups and test
a restore; a backup nobody has restored is a hypothesis.

**GeoIP.** Free instances have no persistent disk, so there is no GeoLite2 file and
locations read as unknown. `/health/ready` reports `geoip: false`; everything else works.

## Things that will catch you out

- **A sleeping API looks like an outage.** The first request after 15 idle minutes takes
  about a minute. Staff will notice. A paid plan removes it.
- **`VITE_API_BASE_URL` is compile-time.** Change it and you must redeploy the console.
- **A new migration plus a long-running deploy over midnight** is safe, because the catch-up
  re-queues anything the nightly job missed.
- **The Blueprint's `sync: false` values are prompted once.** Changing them later is done in
  the Render dashboard, not by editing `render.yaml`.

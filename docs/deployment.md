# Deploying admin-core

One DigitalOcean droplet running five containers behind Caddy, deployed by GitHub
Actions on every push to `main`.

```
                    :443 / :80
                        │
                   ┌────▼────┐
                   │  Caddy  │  automatic TLS, security headers, SSE passthrough
                   └────┬────┘
                        │ admin_net (nothing else is published)
        ┌───────────────┼───────────────┬──────────────┐
   ┌────▼────┐    ┌─────▼─────┐   ┌─────▼────┐   ┌─────▼────┐
   │   web   │    │  worker   │   │ postgres │   │  redis   │
   │ :3001   │    │  :3002    │   │          │   │          │
   └─────────┘    └───────────┘   └──────────┘   └──────────┘
```

`web` serves HTTP. `worker` runs the schedulers, queue processors and the
request-ingest loop. They are the same image with a different `ADMIN_ROLE`, so a
five-minute rollup cannot slow a staff member's request. A one-shot `migrate`
container runs `prisma migrate deploy` to completion before either starts.

## Sizing

A 2 vCPU / 4 GB droplet is enough for an internal console at the PRD's 99.5% target.
Postgres and Redis share it. The thing that will outgrow the box first is the raw
request log at high traffic — the PRD's own guidance is to move it to ClickHouse past
roughly 20 million requests a day, and the read path is already isolated behind
`GET /geo/*` so that swap does not touch the API.

## First-time setup

**1. DNS before anything else.** Point `ADMIN_DOMAIN` at the droplet's IPv4 and let it
propagate. Caddy requests a certificate the moment it starts; if the record is wrong
it will fail and back off, and Let's Encrypt rate-limits repeated failures. While
testing, uncomment the staging CA line at the top of the `Caddyfile`.

**2. Prepare the droplet.**

```bash
ssh root@<droplet>

# Docker
curl -fsSL https://get.docker.com | sh

# A non-root deploy user
adduser --disabled-password --gecos "" deploy
usermod -aG docker deploy
mkdir -p /home/deploy/.ssh && cp ~/.ssh/authorized_keys /home/deploy/.ssh/
chown -R deploy:deploy /home/deploy/.ssh && chmod 700 /home/deploy/.ssh

# Only SSH and HTTP(S). Postgres and Redis are not published by compose, but a
# firewall is the thing that makes that true rather than merely intended.
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
```

**3. Lay out the app directory** at whatever you set `DROPLET_PATH` to, e.g.
`/srv/admin-core`, owned by `deploy`:

```
/srv/admin-core/
├── docker-compose.prod.yml   # from the repo
├── Caddyfile                 # from the repo
├── .env                      # NOT from the repo — see below
└── data/
    └── GeoLite2-City.mmdb    # licensed, downloaded separately
```

**4. Write `.env` on the droplet.** Copy `.env.example` and set real values. Never
commit it. The ones with no safe default:

| Variable | Notes |
| --- | --- |
| `ADMIN_DOMAIN` | the console API hostname, e.g. `admin-api.zapiack.com` |
| `ACME_EMAIL` | where Let's Encrypt sends expiry warnings |
| `ADMIN_CORS_ORIGIN` | the console frontend origin, exactly — no wildcard |
| `ADMIN_JWT_SECRET` | `openssl rand -base64 48` |
| `DB_PASSWORD`, `REDIS_PASSWORD` | generate, do not reuse |
| `API_CORE_SERVICE_TOKEN`, `API_CORE_SIGNING_SECRET` | shared with api-core |
| `S3_*`, `SES_*`, `SMS_CORE_*` | the real buckets and credentials |
| `ADMIN_SECURE_COOKIES` | `true` |
| `NODE_ENV` | `production` — boot fails fast if required secrets are missing |

The connection hosts inside compose are service names, not `localhost`:

```
ADMIN_DATABASE_URL=postgresql://<user>:<pass>@postgres:5432/zapiack_admin
ZAPIACK_READ_DATABASE_URL=postgresql://<user>:<pass>@<product replica host>:5432/zapiack
REDIS_URL=redis://:<pass>@redis:6379
```

`ZAPIACK_READ_DATABASE_URL` is the one that points **off** this droplet, at the product
read replica, through a role holding `SELECT` and nothing else.

**5. GeoLite2.** Download `GeoLite2-City.mmdb` into `./data/`. Without it the service
still runs; locations read as unknown and `/health/ready` reports `geoip: false`. A
weekly job reloads it in place, so refreshing the file needs no restart.

**6. First deploy.** Push to `main`, or run the workflow manually. Then seed the roles
and the first super admin, once:

```bash
docker compose -f docker-compose.prod.yml run --rm \
  -e ADMIN_SEED_EMAIL=you@zapiack.com \
  -e ADMIN_SEED_PASSWORD='<a long one>' \
  admin-core node dist/seed.js
```

Everyone else is invited from the console. There is no self-registration.

## GitHub secrets

Set under Settings → Secrets → Actions. The `deploy` job also uses a `production`
environment, so you can require a reviewer there if you want a manual gate.

| Secret | Value |
| --- | --- |
| `DROPLET_HOST` | IPv4 or hostname |
| `DROPLET_USER` | `deploy` |
| `DROPLET_SSH_KEY` | private key whose public half is in `~deploy/.ssh/authorized_keys` |
| `DROPLET_PATH` | e.g. `/srv/admin-core` |

`GITHUB_TOKEN` is provided automatically and is what pushes to and pulls from GHCR.

## What a deploy does

1. Builds the image and pushes it to GHCR tagged with the commit SHA and `latest`.
2. SSHes in, pins `ADMIN_IMAGE` in `.env` to that exact SHA, and pulls.
3. `docker compose up -d` — the `migrate` container runs to completion first; `web` and
   `worker` only start once it exits cleanly.
4. Polls `/health/ready` for up to 150 seconds and fails the run if it never reports
   ready, printing the last 80 log lines.

Pinning to the SHA rather than `latest` is what makes a restart reproducible and a
rollback exact.

## Rolling back

```bash
ssh deploy@<droplet> && cd /srv/admin-core
sed -i 's|^ADMIN_IMAGE=.*|ADMIN_IMAGE=ghcr.io/<org>/<repo>:<previous-sha>|' .env
docker compose -f docker-compose.prod.yml up -d
```

Code rolls back cleanly. **Migrations do not** — `migrate deploy` only moves forward.
A release that changes the schema destructively needs a compensating migration, not a
rollback. The expand-then-contract habit is worth keeping: add the column, deploy,
backfill, drop the old one in a later release.

## Backups

Nothing here backs up the database; set that up before the console holds anything you
care about. The Admin DB is the source of truth for staff, roles, the audit log and
every review decision — none of it is reconstructible from the product database.

```bash
# Nightly dump, 30 days, matching the PRD's recovery target.
0 2 * * * docker exec admin_postgres pg_dump -U <user> zapiack_admin \
  | gzip > /srv/backups/admin-$(date +\%F).sql.gz
```

Ship those off the droplet — DigitalOcean Spaces or S3 — and test a restore. A backup
nobody has restored is a hypothesis. DigitalOcean's own droplet snapshots are a useful
second layer but are not point-in-time.

## Operating it

**Logs.** `docker compose -f docker-compose.prod.yml logs -f admin-core`. JSON, with a
`requestId` that matches the one the API returns to the console and the one api-core
logs, so a staff member quoting an error id is enough to find the request end to end.
Caddy's access log is in the `caddy_logs` volume, rolled at 50 MiB.

**Is it healthy?** `/health/ready` reports each dependency separately. `GET
/admin/v1/overview/health` reports rollup lag per job — past 15 minutes, something is
wrong with the worker rather than with the data.

**Certificates** renew themselves. The `caddy_data` volume holds them; losing it means
re-issuing on next start, which is rate limited, so keep it.

**Scaling past one droplet.** Web and worker already run as separate containers, so the
first move is more web containers behind Caddy. The scheduler uses deterministic job
ids and the rollups are idempotent, so a second worker is safe, but there is no reason
to run one until the queue actually backs up.

## Things that will catch you out

- **Caddy needs DNS first.** Starting before the record resolves burns Let's Encrypt
  attempts. Use the staging CA while you are still moving things.
- **`.env` lives only on the droplet.** It is gitignored and nothing in CI writes it. A
  fresh droplet with no `.env` will fail at boot with a list of missing variables,
  which is the intended behaviour.
- **The worker binds HTTP too**, on 3002, purely so its container healthcheck has
  something to answer. Nothing routes to it and its port is not published.
- **Compose volumes are named after the directory.** Running `docker-compose.yml` and
  `docker-compose.prod.yml` from the same folder shares `postgres_data` between them.
  On the droplet only the production file is ever used; locally, be aware the dev stack
  and a local production run are looking at the same disk.

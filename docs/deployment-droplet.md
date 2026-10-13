# Deploying admin-core on the droplet

admin-core runs as one container on the **app droplet**, next to the main Zapiack stack. It
uses the **Caddy that is already there** for HTTPS, and the **Postgres and Redis that are
already on the data droplet**. It adds no database, no Redis and no second Caddy.

```
                      Cloudflare
                          │
              ┌───────────▼─────────────┐   private network (VPC)   ┌───────────────────────┐
 APP droplet  │ zapiack_caddy  :80/:443 │                           │ DATA droplet           │
 1 vCPU 2 GB  │   api.zapiack.com ───▶ api-core                     │ Postgres :5432         │
              │   admin-api.…    ───▶ admin-core ─────────────────────▶  zapiack        (product)
              │ sms / mailing / automation                          │     zapiack_admin  (new)│
              └─────────────────────────┘                           │ Redis :6379            │
                                                                    │     db 0 main app, db 1 admin │
                                                                    └───────────────────────┘
```

| Piece | Where | Who owns it |
|---|---|---|
| admin-core container | `/opt/zapiack-admin` on the app droplet | this repo's `deploy.yml` |
| Caddy and its `Caddyfile` | `/opt/zapiack` on the app droplet | the **monorepo's** deploy |
| `zapiack_admin` database | the data droplet's Postgres | you, once (below) |
| Redis database 1 | the data droplet's Redis | you, nothing to create |

## Will it fit?

The droplet has 2 GB and the main stack already uses about 1.4 GB of it, with 2 GB of swap.
**It fits, but not by much.** Measured on the production image: admin-core settles at about
**280 MB resident** (Docker's `stats` shows closer to 315 MB because it counts reclaimable file
cache). That leaves roughly 250 MB of the droplet's RAM free, with swap behind it.

It is capped at **420 MB** (`mem_limit`) with V8 held to 288 MB, so a leak restarts this
container instead of starving the main API. It runs the web server and the background workers
in **one process** for the same reason. Check after a day:

```bash
docker stats --no-stream zapiack_admin_core zapiack_api
free -m
```

If swap use keeps climbing, resize the app droplet before anything else. One vCPU is the other
limit: the nightly rollups are the heaviest thing admin-core does, and they run at 00:15 Lagos.

## One-time setup

### 1. DNS

Point `admin-api.zapiack.com` at the app droplet (`134.209.177.140`), the same way
`api.zapiack.com` is set up (Cloudflare proxied is fine: the existing Caddy already trusts
Cloudflare's ranges). The console stays at `console.zapiack.com`. They share `zapiack.com`, so
the session cookie works with the default strict settings.

### 2. The Admin database (on the data droplet)

```bash
# On the data droplet, as root. Pick a long password, letters and digits only.
docker exec -i zapiack_postgres psql -U zapiack -d postgres \
  -v admin_pw="'<password>'" < admin-db.sql        # deploy/data-droplet/admin-db.sql
```

Then create the two least-privilege roles on the **product** database, from
`prisma/grants/zapiack-roles.sql`. Change the two `CHANGE_ME_*` passwords first:

```bash
docker exec -i zapiack_postgres psql -U zapiack -d zapiack < zapiack-roles.sql
```

`admin_reader` can read only the tables and columns the console shows. `admin_writer` adds the
narrow writes (sender ID decisions, plans, products, account status). Neither can write the
credit ledger, which belongs to api-core.

The data droplet's cloud firewall already lets the **app droplet** reach 5432 and 6379, and
admin-core runs on that droplet, so nothing needs opening.

### 3. The app directory and its environment

```bash
# On the app droplet, as root
mkdir -p /opt/zapiack-admin/data && cd /opt/zapiack-admin
# Copy .env.production.example from the repo to here as .env.production, fill every <...>:
chmod 600 .env.production
```

The data droplet's **private IP** and the **Redis password** are the same ones in
`/opt/zapiack/.env.production`. Open that file to copy them; do not paste it anywhere.

### 4. Route Caddy to it (a change in the monorepo)

The droplet's `Caddyfile` is rewritten from the monorepo on every deploy of the main app, so
editing it on the server is lost within a day. Add the block in
[`deploy/caddy/admin-core.caddy`](../deploy/caddy/admin-core.caddy) to **`zapiack-backend/Caddyfile`**
and let that repo's deploy ship it. The block is validated against the real Caddyfile. It uses
the existing `real_client_ip` snippet and the Cloudflare settings already in that file, so the
IP allowlist, the live map and the audit log see the visitor's real address.

Until that deploy runs, admin-core is up but unreachable from the internet. That is safe, and
it also lets you check the container first.

### 5. GitHub secrets

In the repo's **Settings → Environments → production**, add:

| Secret | Value |
|---|---|
| `DROPLET_HOST` | `134.209.177.140` |
| `DROPLET_USER` | `root` (or a deploy user in the `docker` group) |
| `DROPLET_PATH` | `/opt/zapiack-admin` |
| `DROPLET_SSH_KEY` | a private key whose public half is in the droplet's `authorized_keys` |

Use a **dedicated deploy key**, not your personal one. Delete it from the droplet if you ever
stop using this workflow. The repository is public, so keep every value in secrets, never in
the workflow file.

### 6. First deploy

Push to `main` (CI must pass), or run **Actions → Deploy to droplet → Run workflow**. It builds
the image, copies the compose file, pulls, starts the container and waits for it to report
healthy. The first start also creates the Admin database's tables.

Then seed the first administrator, once. The password is typed into your shell, so clear it
from the history afterwards (`history -d` or `unset HISTFILE` first), and change it at first sign-in:

```bash
cd /opt/zapiack-admin
docker exec -it \
  -e ADMIN_SEED_EMAIL=you@zapiack.com \
  -e ADMIN_SEED_NAME='Your Name' \
  -e ADMIN_SEED_PASSWORD='<a long passphrase>' \
  zapiack_admin_core node dist/seed.js
```

At first sign-in the console shows a QR code for two-factor authentication. Scan the one from
your **latest** sign-in attempt only: each attempt before 2FA is confirmed makes a new secret.

## What a deploy does

1. **CI passes** for a commit on `main` (a deploy never runs on a red build or a fork's PR).
2. The image is built and pushed to `ghcr.io/<repo>:<commit-sha>`.
3. The compose file is copied, the image pulled, and `docker compose up -d` recreates the
   container. On start it applies pending migrations (with retries), then listens.
4. The workflow waits for the container to be **healthy**, then checks `/health/ready`
   (Admin DB, product DB and Redis all reachable).
5. If it never gets healthy, the logs are printed and the **previous image is restored**.

There are about 30 to 60 seconds of downtime per deploy, while migrations run. Caddy's health
check stops sending traffic to the container meanwhile.

## Operating it

```bash
cd /opt/zapiack-admin
export ADMIN_IMAGE=$(cat .image)

docker logs -f --tail 100 zapiack_admin_core        # live logs
docker compose -f docker-compose.prod.yml ps        # health
docker compose -f docker-compose.prod.yml restart   # restart in place

# Roll back to the previous release
cp .image.prev .image && export ADMIN_IMAGE=$(cat .image)
docker compose -f docker-compose.prod.yml up -d
```

Reset a staff member's password (and optionally their 2FA) without the console:

```bash
docker exec -it zapiack_admin_core node dist/cli/reset-password.js someone@zapiack.com [--reset-2fa]
```

Useful health checks:

```bash
curl -s https://admin-api.zapiack.com/health          # {"status":"ok"}
docker exec zapiack_admin_core curl -s localhost:3001/health/ready
```

On startup the logs print one `session:` line and one `Redis memory …` line. If sign-in ever
misbehaves, those two lines are the first thing to read.

## Things that will catch you out

- **Do not edit `/opt/zapiack/Caddyfile` on the server.** It is overwritten by the main app's
  deploy. Change it in the monorepo.
- **`ADMIN_DATABASE_URL` must be the `zapiack_admin` database**, not `zapiack`. admin-core
  writes tables when it starts. Pointing it at the product database would create them there.
- **Redis is shared, with a separate database.** The `/1` at the end of `REDIS_URL` is what
  keeps the two apps' keys apart. Redis has one memory limit (384 MB) for both. If it fills,
  writes fail, so watch it: `docker exec zapiack_redis redis-cli -a "$REDIS_PASSWORD" info memory`.
- **`sslmode=disable` is only safe on the private network.** If the data droplet is ever
  reached over a public address, switch to TLS first.
- **`DB_POOL_MAX`** multiplies by three (admin DB, product read, product write). Raising it
  eats the connections the main app needs; the data droplet's limit is 100.
- **The admin database is not backed up by anything the main app already runs.** Add it to
  the data droplet's nightly dump, or it is the one database you cannot restore. It holds
  staff accounts, roles and the audit log.
- **api-core's internal endpoints** (credit adjustments, force-logout, plan changes) are not
  built yet, so those three actions return an error. Everything else works.

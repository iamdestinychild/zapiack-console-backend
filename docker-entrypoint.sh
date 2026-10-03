#!/bin/sh
# Container entrypoint.
#
# Render only runs a pre-deploy command on paid instances, so on the free tier the
# schema has to be brought up to date at start instead. `migrate deploy` is idempotent
# and takes a Postgres advisory lock, so a restart, or two instances starting together,
# cannot apply a migration twice.
#
# A failed migration stops the container: serving traffic against a schema this code
# does not match is worse than being down, and Render keeps the previous deploy live
# until the new one reports healthy.
set -eu

if [ "${ADMIN_RUN_MIGRATIONS:-false}" = "true" ]; then
  echo "[entrypoint] applying Admin DB migrations"
  # Retried: a managed database that has just woken from idle can miss the first
  # attempt. A real migration error fails all three and still stops the container.
  attempt=1
  until npx prisma migrate deploy --config prisma.admin.config.ts; do
    if [ "$attempt" -ge 3 ]; then
      echo "[entrypoint] migrations failed after $attempt attempts" >&2
      exit 1
    fi
    echo "[entrypoint] migration attempt $attempt failed, retrying"
    attempt=$((attempt + 1))
    sleep 5
  done
fi

exec node dist/main.js

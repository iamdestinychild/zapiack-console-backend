-- Hardening that Prisma's schema language cannot express.
--
-- Run after the generated baseline migration:
--   npx prisma migrate dev --config prisma.admin.config.ts
--
-- Three things live here:
--   1. the audit log is made genuinely append-only, in the database
--   2. the request log becomes a partitioned table so 90-day retention is a DROP
--   3. a helper the maintenance job calls to create tomorrow's partition

-- ---------------------------------------------------------------- 1. audit log

-- Application code already refuses to update or delete audit rows. This makes it
-- true for anyone holding the connection string, including a super admin with psql.
CREATE OR REPLACE FUNCTION audit_log_is_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not permitted', TG_OP
    USING HINT = 'Audit history cannot be edited or deleted by any role.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_update ON "audit_log";
CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();

-- TRUNCATE bypasses row triggers, so it needs its own statement-level guard.
DROP TRIGGER IF EXISTS audit_log_no_truncate ON "audit_log";
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON "audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_is_append_only();

-- ---------------------------------------------------------------- 2. request log

-- Prisma creates request_logs as an ordinary table. Rebuild it as a partitioned one:
-- at 20 million rows a day, deleting by date is unaffordable and dropping a partition
-- is instant.
--
-- DESTRUCTIVE: this drops and recreates request_logs. It ships alongside the baseline
-- migration and is meant to run at install time, when the table is empty. Do not
-- apply it to a database whose request log is already in use without copying the
-- rows across first — renaming will not do, because the table's primary key and
-- indexes keep their old names and collide with the new ones.
DROP TABLE IF EXISTS "request_logs" CASCADE;

-- The primary key is composite because Postgres requires the partition key to be
-- part of every unique constraint on a partitioned table.
CREATE TABLE "request_logs" (
  "id"         TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "accountId"  TEXT,
  "apiKeyId"   TEXT,
  "endpoint"   TEXT NOT NULL,
  "method"     TEXT NOT NULL,
  "statusCode" INTEGER NOT NULL,
  "latencyMs"  INTEGER NOT NULL,
  "ip"         TEXT,
  "userAgent"  TEXT,
  "country"    TEXT,
  "region"     TEXT,
  "city"       TEXT,
  "latitude"   DOUBLE PRECISION,
  "longitude"  DOUBLE PRECISION,
  "requestId"  TEXT,
  CONSTRAINT "request_logs_pkey" PRIMARY KEY ("id", "occurredAt")
) PARTITION BY RANGE ("occurredAt");

CREATE INDEX "request_logs_occurredAt_idx"           ON "request_logs" ("occurredAt");
CREATE INDEX "request_logs_accountId_occurredAt_idx" ON "request_logs" ("accountId", "occurredAt");
CREATE INDEX "request_logs_country_occurredAt_idx"   ON "request_logs" ("country", "occurredAt");

-- Anything landing outside a created partition goes here rather than failing the
-- insert, which would cost us the log line entirely.
CREATE TABLE IF NOT EXISTS "request_logs_default" PARTITION OF "request_logs" DEFAULT;

-- ---------------------------------------------------------------- 3. partition helper

-- Called daily by the maintenance worker. Idempotent, so running it repeatedly (or
-- from two instances at once) is safe.
CREATE OR REPLACE FUNCTION create_request_log_partition(
  partition_name TEXT,
  range_start    TIMESTAMP,
  range_end      TIMESTAMP
) RETURNS VOID AS $$
BEGIN
  IF to_regclass(format('%I', partition_name)) IS NOT NULL THEN
    RETURN;
  END IF;

  EXECUTE format(
    'CREATE TABLE %I PARTITION OF "request_logs" FOR VALUES FROM (%L) TO (%L)',
    partition_name, range_start, range_end
  );
EXCEPTION
  -- Another instance won the race; that is the desired end state either way.
  WHEN duplicate_table THEN RETURN;
  WHEN invalid_object_definition THEN RETURN;
END;
$$ LANGUAGE plpgsql;

import 'dotenv/config';
import path from 'node:path';
import { defineConfig } from 'prisma/config';

/**
 * Neon serves a database on two hosts: `ep-xxx-pooler.…` (PgBouncer) and `ep-xxx.…`
 * (direct). Migrations hold a session-level advisory lock, which the pooler cannot
 * keep, so they time out there with P1002. When no explicit migration URL is set and
 * the URL is a pooled one, use the direct host: same credentials, same database.
 */
function migrationUrl(): string | undefined {
  const explicit = process.env.ADMIN_MIGRATION_DATABASE_URL;
  if (explicit) return explicit;
  const url = process.env.ADMIN_DATABASE_URL;
  if (!url) return url;
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes('-pooler.')) return url;
    parsed.hostname = parsed.hostname.replace('-pooler.', '.');
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Admin DB — the only database admin-core migrates.
 * Usage: npx prisma migrate dev --config prisma.admin.config.ts
 */
export default defineConfig({
  schema: path.join('prisma', 'admin', 'schema.prisma'),
  migrations: {
    path: path.join('prisma', 'admin', 'migrations'),
    seed: 'node dist/seed.js',
  },
  datasource: {
    // Migrations take a session-level advisory lock, which a pooled (PgBouncer) endpoint
    // cannot hold reliably. Set ADMIN_MIGRATION_DATABASE_URL to the direct, non-pooler URL.
    url: migrationUrl(),
    // Needed to replay the migrations directory, which is how CI checks that
    // schema.prisma and the migrations have not drifted apart. Optional locally.
    shadowDatabaseUrl: process.env.ADMIN_SHADOW_DATABASE_URL,
  },
});

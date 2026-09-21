import 'dotenv/config';
import path from 'node:path';
import { defineConfig } from 'prisma/config';

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
    url: process.env.ADMIN_DATABASE_URL,
    // Needed to replay the migrations directory, which is how CI checks that
    // schema.prisma and the migrations have not drifted apart. Optional locally.
    shadowDatabaseUrl: process.env.ADMIN_SHADOW_DATABASE_URL,
  },
});

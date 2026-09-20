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
  },
});

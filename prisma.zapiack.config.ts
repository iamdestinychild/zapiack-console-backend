import 'dotenv/config';
import path from 'node:path';
import { defineConfig } from 'prisma/config';

/**
 * Zapiack DB — read-only mirror. Generate the client only; never migrate from here.
 * The role behind ZAPIACK_READ_DATABASE_URL has SELECT and nothing else.
 */
export default defineConfig({
  schema: path.join('prisma', 'zapiack', 'schema.prisma'),
  datasource: {
    url: process.env.ZAPIACK_READ_DATABASE_URL,
  },
});

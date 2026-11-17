// Prisma 7 reads its CLI configuration from this file.
// Prisma no longer loads .env automatically, so we import dotenv here.
import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    // `npm run db:seed` runs this. It creates the first ADMIN user.
    seed: 'node --env-file=.env prisma/seed.js',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});

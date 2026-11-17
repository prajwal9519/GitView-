// The ONE PrismaClient for the whole app. Creating several would open several
// connection pools and exhaust the database's connection limit.
//
// Prisma 7 needs a "driver adapter": a small bridge between Prisma and the
// node-postgres (pg) driver that actually talks to PostgreSQL.
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.ts';
import { env } from '../config/env.js';

const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });

export const prisma = new PrismaClient({ adapter });

// Runs before every test file, BEFORE the app is imported, so that
// src/config/env.js sees these values.
import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import { afterAll } from 'vitest';

if (existsSync('.env.test')) process.loadEnvFile('.env.test');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set. Copy .env.test.example to .env.test and edit it.');
}

// SAFETY: the tests delete every user. Refuse to run unless the database name
// says "test", so a wrong DATABASE_URL can never wipe your development data.
const databaseName = new URL(process.env.DATABASE_URL).pathname.slice(1);
if (!/test/i.test(databaseName)) {
  throw new Error(`Refusing to run tests against database "${databaseName}": its name must contain "test".`);
}

process.env.NODE_ENV = 'test';
process.env.FRONTEND_URL = 'http://localhost:5173';
process.env.BCRYPT_COST = '4'; // the minimum: keeps tests fast (production uses 12)
process.env.AUTH_RATE_LIMIT_MAX = '1000'; // out of the way (rateLimit.test.js lowers it)

// Fresh random secrets on every run: no secret is ever stored in the repo.
process.env.JWT_ACCESS_SECRET = crypto.randomBytes(32).toString('hex');
process.env.JWT_REFRESH_SECRET = crypto.randomBytes(32).toString('hex');
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.GITHUB_CLIENT_ID = 'test_github_client_id';
process.env.GITHUB_CLIENT_SECRET = 'test_github_client_secret';

afterAll(async () => {
  const { prisma } = await import('../src/lib/prisma.js');
  await prisma.$disconnect();
});

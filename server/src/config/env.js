// Reads and validates process.env ONCE, at startup.
//
// Why: a missing secret should crash the server immediately with a clear
// message, not surface later as a confusing "secretOrPrivateKey must have a
// value" error on the first login. No secret is ever written in source code;
// they all come from the environment (.env locally, host settings in production).
import { z } from 'zod';

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    DATABASE_URL: z.string('is required').min(1, 'is required'),
    FRONTEND_URL: z.url('must be a full URL, e.g. http://localhost:5173'),

    // HS256 secrets: at least 32 characters, and different from each other so
    // a refresh token can never be accepted as an access token (or vice versa).
    JWT_ACCESS_SECRET: z.string('is required').min(32, 'must be at least 32 characters'),
    JWT_REFRESH_SECRET: z.string('is required').min(32, 'must be at least 32 characters'),

    BCRYPT_COST: z.coerce.number().int().min(4).max(15).default(12),
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  })
  .refine((e) => e.JWT_ACCESS_SECRET !== e.JWT_REFRESH_SECRET, {
    path: ['JWT_REFRESH_SECRET'],
    message: 'must be different from JWT_ACCESS_SECRET',
  });

const result = schema.safeParse(process.env);

if (!result.success) {
  console.error('Invalid environment configuration:');
  for (const issue of result.error.issues) {
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  }
  console.error('Copy .env.example to .env and fill in the missing values.');
  process.exit(1);
}

export const env = Object.freeze(result.data);
export const isProduction = env.NODE_ENV === 'production';

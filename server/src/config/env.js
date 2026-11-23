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

    // GitHub OAuth App credentials (optional until configured)
    GITHUB_CLIENT_ID: z.string().optional().default(''),
    GITHUB_CLIENT_SECRET: z.string().optional().default(''),
    GITHUB_CALLBACK_URL: z.string().default('http://localhost:3000/api/v1/auth/github/callback'),

    // Optional server-side GitHub Personal Access Token for rate-limit resilience on public repos
    GITHUB_TOKEN: z.string().optional().default(''),

    // AES-256-GCM encryption key for GitHub access tokens (32 bytes / 64 hex characters)
    ENCRYPTION_KEY: z
      .string()
      .min(32, 'must be at least 32 characters')
      .default('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'),

    // Dedicated AES-256-GCM encryption key for preview tokens (32 bytes / 64 hex characters)
    PREVIEW_TOKEN_ENCRYPTION_KEY: z
      .string()
      .min(32, 'must be at least 32 characters')
      .default('fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210'),

    // Dedicated HMAC-SHA256 secret for gateway-to-sidecar handshake (canonical 64 hex chars = 32 bytes)
    GITVIEW_SIDECAR_HANDSHAKE_KEY: z
      .string()
      .min(32, 'must be at least 32 characters')
      .regex(/^[0-9a-fA-F]{64}$/, 'must be a 64-character hex string (32 bytes)')
      .default('0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b'),

    // Milestone 7: Production Preview Gateway & Redis Ticket Registry
    REDIS_URL: z.string().url('must be a valid redis URL, e.g. redis://127.0.0.1:6379').optional(),
    PREVIEW_DOMAIN: z.string().optional().default(''),
    PREVIEW_BASE_URL: z.string().url().optional(),
    PREVIEW_HTTPS: z.enum(['true', 'false']).default('false'),
  })
  .refine((e) => e.JWT_ACCESS_SECRET !== e.JWT_REFRESH_SECRET, {
    path: ['JWT_REFRESH_SECRET'],
    message: 'must be different from JWT_ACCESS_SECRET',
  })
  .refine((e) => !e.PREVIEW_TOKEN_ENCRYPTION_KEY || e.PREVIEW_TOKEN_ENCRYPTION_KEY !== e.ENCRYPTION_KEY, {
    path: ['PREVIEW_TOKEN_ENCRYPTION_KEY'],
    message: 'must be different from ENCRYPTION_KEY',
  })
  .refine((e) => !e.GITVIEW_SIDECAR_HANDSHAKE_KEY || e.GITVIEW_SIDECAR_HANDSHAKE_KEY !== e.ENCRYPTION_KEY, {
    path: ['GITVIEW_SIDECAR_HANDSHAKE_KEY'],
    message: 'must be different from ENCRYPTION_KEY',
  })
  .refine(
    (e) =>
      !e.GITVIEW_SIDECAR_HANDSHAKE_KEY ||
      e.GITVIEW_SIDECAR_HANDSHAKE_KEY !== e.PREVIEW_TOKEN_ENCRYPTION_KEY,
    {
      path: ['GITVIEW_SIDECAR_HANDSHAKE_KEY'],
      message: 'must be different from PREVIEW_TOKEN_ENCRYPTION_KEY',
    }
  )
  .refine((e) => e.NODE_ENV !== 'production' || Boolean(e.REDIS_URL), {
    path: ['REDIS_URL'],
    message: 'is required in production environment',
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

export const envSchema = schema;
export const env = Object.freeze(result.data);
export const isProduction = env.NODE_ENV === 'production';

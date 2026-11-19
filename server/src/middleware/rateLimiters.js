// RATE LIMITING middleware: slows down password guessing and mass sign-ups.
//
// Counters live in this process's memory. That is fine for one server; with
// several instances you would move them to Redis (a "Later" item).
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { env } from '../config/env.js';
import { TooManyRequestsError } from '../utils/AppError.js';

const FIFTEEN_MINUTES = 15 * 60 * 1000;
const ONE_MINUTE = 60 * 1000;

// Hand the rejection to our errorHandler so the 429 has the same JSON shape
// as every other error.
const handler = (_req, _res, next) => next(new TooManyRequestsError());

const common = { windowMs: FIFTEEN_MINUTES, standardHeaders: 'draft-7', legacyHeaders: false, handler };

// Login and register: the brute-force targets. `skipSuccessfulRequests` means
// only FAILED attempts count, so a whole classroom behind one campus IP can
// log in normally, while someone guessing passwords is stopped quickly.
export const credentialsLimiter = rateLimit({
  ...common,
  limit: env.AUTH_RATE_LIMIT_MAX, // default 10 per 15 minutes per IP
  skipSuccessfulRequests: true,
});

// Refresh is called automatically by the frontend, so it needs a roomier limit
// than login. It is still capped to stop abuse.
export const refreshLimiter = rateLimit({ ...common, limit: 60 });

// Repository imports make upstream GitHub API calls; rate limit to prevent abuse
export const importRepoLimiter = rateLimit({ ...common, limit: 30 });

// Milestone 7 Preview Rate Limiters (scoped per user ID with IP fallback)
const userKeyGenerator = (req) => req.user?.id || ipKeyGenerator(req.ip);

// Starts a new preview: 5 requests / minute / user
export const previewCreateLimiter = rateLimit({
  windowMs: ONE_MINUTE,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: userKeyGenerator,
  handler,
});

// Polls preview session status: 60 requests / minute / user
export const previewStatusLimiter = rateLimit({
  windowMs: ONE_MINUTE,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: userKeyGenerator,
  handler,
});

// Stops an active preview session: 10 requests / minute / user
export const previewStopLimiter = rateLimit({
  windowMs: ONE_MINUTE,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: userKeyGenerator,
  handler,
});

// Generates single-use bootstrap ticket: 10 requests / minute / user
export const previewTicketLimiter = rateLimit({
  windowMs: ONE_MINUTE,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: userKeyGenerator,
  handler,
});

// What valid input looks like for each auth endpoint (one zod schema each).
// Fields not listed here (such as "role") are silently dropped by zod.
import { z } from 'zod';

// Emails and usernames are stored in ONE canonical form (trimmed, lowercase),
// so "Alice@x.com" and "alice@x.com" cannot become two accounts, and the
// database's unique constraints actually do their job.
const email = z
  .string('Email is required')
  .trim()
  .toLowerCase()
  .pipe(z.email('Enter a valid email address').max(254, 'Email is too long'));

const username = z
  .string('Username is required')
  .trim()
  .toLowerCase()
  .min(3, 'Username must be at least 3 characters')
  .max(30, 'Username must be at most 30 characters')
  .regex(/^[a-z0-9_-]+$/, 'Username may only contain letters, numbers, "_" and "-"');

// bcrypt silently ignores everything after the first 72 BYTES, so two long
// passwords sharing a 72-byte prefix would be "equal". We reject such
// passwords instead. (Counting bytes, not characters: "é" is 2 bytes.)
const newPassword = z
  .string('Password is required')
  .min(8, 'Password must be at least 8 characters')
  .refine((value) => Buffer.byteLength(value, 'utf8') <= 72, 'Password is too long (maximum 72 bytes)');

export const registerSchema = z.object({ email, username, password: newPassword });

// On login we don't re-apply the strength rules; we only bound the size.
export const loginSchema = z.object({
  email,
  password: z.string('Password is required').min(1, 'Password is required').max(128, 'Password is too long'),
});

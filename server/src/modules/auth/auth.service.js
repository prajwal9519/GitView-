// Business rules for authentication. Plain functions: no req, no res, no cookies.
// (Cookies are an HTTP concern, so the controller sets them.)
import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { ConflictError, UnauthorizedError } from '../../utils/AppError.js';
import {
  REFRESH_TOKEN_TTL_SECONDS,
  hashToken,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from '../../utils/tokens.js';
import { toPublicUser } from '../../utils/toPublicUser.js';

// A throwaway hash, used so that logging in with an unknown email takes as
// long as a real attempt (see login). It is a promise, so startup isn't blocked.
const dummyHash = bcrypt.hash('not-a-real-password', env.BCRYPT_COST);

const tokenErrorCode = (err) => (err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID');

/**
 * Creates an access + refresh token pair and records the refresh token in the DB.
 * `familyId` identifies one login session: a fresh login starts a new family,
 * and every rotation keeps the same one (that is how reuse detection works).
 */
async function issueTokens(user, familyId = crypto.randomUUID()) {
  const tokenId = crypto.randomUUID();
  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken({ userId: user.id, tokenId, familyId });

  await prisma.refreshToken.create({
    data: {
      id: tokenId, // equals the JWT's jti, so we can find the row from the token
      userId: user.id,
      familyId,
      tokenHash: hashToken(refreshToken), // never store the token itself
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000),
    },
  });

  return { accessToken, refreshToken };
}

/** Revokes every still-active token of one login session. */
function revokeFamily(familyId) {
  return prisma.refreshToken.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function register({ email, username, password }) {
  // Friendly pre-check. The unique indexes in the database are the real
  // guarantee; errorHandler maps their violation (P2002) to the same 409.
  const existing = await prisma.user.findFirst({
    where: { OR: [{ email }, { username }] },
    select: { email: true },
  });
  if (existing) {
    throw new ConflictError(existing.email === email ? 'Email is already registered' : 'Username is already taken');
  }

  // bcrypt generates a random salt and stores it inside the hash string.
  const passwordHash = await bcrypt.hash(password, env.BCRYPT_COST);

  // Fields are listed explicitly (never spread req.body), so a client cannot
  // choose its own role. New accounts are always USER; admins come from the seed script.
  const user = await prisma.user.create({ data: { email, username, passwordHash } });

  const tokens = await issueTokens(user);
  return { user: toPublicUser(user), tokens };
}

export async function login({ email, password }) {
  const user = await prisma.user.findUnique({ where: { email } });

  // Always do exactly ONE bcrypt comparison, even for an unknown email.
  // Otherwise "unknown email" returns instantly and "wrong password" takes
  // ~250 ms, and an attacker could use that difference to find real emails.
  const hash = user?.passwordHash ?? (await dummyHash);
  const passwordMatches = await bcrypt.compare(password, hash);

  // Unknown email, wrong password and GitHub-only account (no password) all
  // produce the SAME error, so the response never reveals which emails exist.
  if (!user || !user.passwordHash || !passwordMatches) throw new UnauthorizedError('INVALID_CREDENTIALS');

  const tokens = await issueTokens(user); // new family: a fresh login session
  return { user: toPublicUser(user), tokens };
}

/**
 * Refresh-token rotation. Every refresh token works exactly ONCE: using it
 * revokes it and hands out a new one from the same family.
 */
export async function refresh(rawToken) {
  if (!rawToken) throw new UnauthorizedError('TOKEN_MISSING');

  // 1. Is it really our token and still within its 7 days?
  let payload;
  try {
    payload = verifyRefreshToken(rawToken);
  } catch (err) {
    throw new UnauthorizedError(tokenErrorCode(err));
  }
  if (typeof payload.jti !== 'string') throw new UnauthorizedError('TOKEN_INVALID');

  // 2. Do we know it? The stored hash must match this exact token string.
  const row = await prisma.refreshToken.findUnique({ where: { id: payload.jti }, include: { user: true } });
  if (!row || row.userId !== payload.sub || row.tokenHash !== hashToken(rawToken)) {
    throw new UnauthorizedError('TOKEN_INVALID');
  }

  // 3. "Claim" it: mark revoked ONLY IF it is not revoked yet. This is one
  //    atomic UPDATE, so if two requests present the same token at the same
  //    moment, the database lets exactly one win (count 1) and the other lose (count 0).
  const claimed = await prisma.refreshToken.updateMany({
    where: { id: row.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  // 4. Claim failed: this token was already used or revoked. A legitimate client
  //    never does that, so assume it was stolen. Revoke the WHOLE family: the
  //    thief and the real user are both logged out and must sign in again.
  if (claimed.count === 0) {
    await revokeFamily(row.familyId);
    throw new UnauthorizedError('TOKEN_REUSED');
  }

  // 5. Issue the next token in the same family. We use the user row loaded
  //    just now, so a changed role takes effect at the next refresh.
  const tokens = await issueTokens(row.user, row.familyId);
  return { user: toPublicUser(row.user), tokens };
}

/**
 * Ends the login session this refresh token belongs to. Never throws: if the
 * token is missing, expired or unknown, the user is effectively logged out already.
 */
export async function logout(rawToken) {
  if (!rawToken) return;

  let payload;
  try {
    // ignoreExpiration: an expired token should still be revocable.
    payload = verifyRefreshToken(rawToken, { ignoreExpiration: true });
  } catch {
    return; // forged or garbage: nothing of ours to revoke
  }
  if (typeof payload.jti !== 'string') return;

  const row = await prisma.refreshToken.findUnique({ where: { id: payload.jti } });
  if (row && row.tokenHash === hashToken(rawToken)) await revokeFamily(row.familyId);
}

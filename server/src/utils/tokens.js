// Everything about creating and checking tokens lives here, so the rest of the
// code never touches the jsonwebtoken library or the secrets directly.
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes
export const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

// We always name the algorithm explicitly, both when signing and when
// verifying. Without the allow-list, an attacker could craft a token that
// claims "alg: none" (no signature) and some libraries would accept it.
const ALGORITHM = 'HS256';

/** Access token: proves identity on every API call. Short-lived, stateless. */
export function signAccessToken(user) {
  return jwt.sign({ role: user.role }, env.JWT_ACCESS_SECRET, {
    algorithm: ALGORITHM,
    subject: user.id, // "sub" claim = who this is
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
  });
}

/**
 * Refresh token: only used to get a new access token. It carries:
 *   sub = user id, jti = id of its row in the RefreshToken table,
 *   fam = "family" id shared by every token descended from one login.
 */
export function signRefreshToken({ userId, tokenId, familyId }) {
  return jwt.sign({ fam: familyId }, env.JWT_REFRESH_SECRET, {
    algorithm: ALGORITHM,
    subject: userId,
    jwtid: tokenId,
    expiresIn: REFRESH_TOKEN_TTL_SECONDS,
  });
}

// Both verify functions throw jsonwebtoken errors (TokenExpiredError,
// JsonWebTokenError). Callers translate those into our own error codes.
export function verifyAccessToken(token) {
  return jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: [ALGORITHM] });
}

export function verifyRefreshToken(token, { ignoreExpiration = false } = {}) {
  return jwt.verify(token, env.JWT_REFRESH_SECRET, { algorithms: [ALGORITHM], ignoreExpiration });
}

/**
 * SHA-256 hex digest. We store this instead of the refresh token itself, so a
 * leaked database does not hand out working tokens. A fast hash is fine here
 * (unlike passwords) because the token is long and random, so it cannot be
 * guessed by brute force.
 */
export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

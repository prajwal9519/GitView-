// OPTIONAL AUTHENTICATION middleware.
// Reads the access-token cookie if present.
// If valid, sets req.user = { id, role }.
// If missing or invalid/expired, sets req.user = null and continues without error.
import { ACCESS_COOKIE } from '../utils/cookies.js';
import { verifyAccessToken } from '../utils/tokens.js';

export function optionalAuth(req, _res, next) {
  const token = req.cookies?.[ACCESS_COOKIE];
  if (!token) {
    req.user = null;
    return next();
  }

  try {
    const payload = verifyAccessToken(token);
    req.user = { id: payload.sub, role: payload.role };
  } catch {
    req.user = null;
  }

  next();
}

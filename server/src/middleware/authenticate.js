// AUTHENTICATION middleware: "who are you?"
//
// Reads the access-token cookie, checks the signature and expiry, and puts
// { id, role } on req.user. It needs NO database call, because the token is
// signed with our secret: if the signature checks out, we issued it.
//
// Failure is always 401, with a code the frontend can act on:
//   TOKEN_MISSING -> not logged in
//   TOKEN_EXPIRED -> call POST /auth/refresh once, then retry
//   TOKEN_INVALID -> tampered, forged, wrong type: send to login
import { ACCESS_COOKIE } from '../utils/cookies.js';
import { verifyAccessToken } from '../utils/tokens.js';
import { UnauthorizedError } from '../utils/AppError.js';

export function authenticate(req, _res, next) {
  const token = req.cookies?.[ACCESS_COOKIE];
  if (!token) throw new UnauthorizedError('TOKEN_MISSING');

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch (err) {
    throw new UnauthorizedError(err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID');
  }

  req.user = { id: payload.sub, role: payload.role };
  // next() is outside the try block on purpose: an error thrown later by
  // another handler must not be mislabelled as a bad token.
  next();
}

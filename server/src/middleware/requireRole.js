// AUTHORIZATION middleware: "are you allowed to do this?"
//
// Usage: router.get('/admin/users', authenticate, requireRole('ADMIN'), handler)
// Must run AFTER authenticate, which is what sets req.user.
// 401 = we don't know who you are. 403 = we know, and the answer is no.
import { ForbiddenError, UnauthorizedError } from '../utils/AppError.js';

export const requireRole =
  (...allowedRoles) =>
  (req, _res, next) => {
    // Guards against a developer mounting this without authenticate.
    if (!req.user) throw new UnauthorizedError('TOKEN_MISSING');
    if (!allowedRoles.includes(req.user.role)) throw new ForbiddenError();
    next();
  };

// Catches any request that matched no route, so unknown URLs get our JSON
// error shape instead of Express's default HTML page.
import { NotFoundError } from '../utils/AppError.js';

export const notFound = (req, _res, next) =>
  next(new NotFoundError(`Route ${req.method} ${req.path} not found`));

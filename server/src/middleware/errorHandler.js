// The ONE place where errors become HTTP responses. Registered last in app.js.
//
// Every error response has the same shape the frontend can rely on:
//   { "error": { "code": "...", "message": "...", "details": ... } }
//
// Expected errors (AppError, validation, known database errors) explain
// themselves. Anything else is a bug: we log the real error on the server and
// send a generic message, so stack traces and SQL never reach the client.
import { ZodError } from 'zod';
import { env } from '../config/env.js';
import { AppError, BadRequestError, ConflictError, NotFoundError } from '../utils/AppError.js';

function toAppError(err) {
  if (err instanceof AppError) return err;

  if (err instanceof ZodError) {
    const details = err.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message }));
    return new BadRequestError('VALIDATION_ERROR', 'Invalid input', details);
  }

  // Errors raised by express.json() for bad request bodies.
  if (err?.type === 'entity.parse.failed') {
    return new BadRequestError('INVALID_JSON', 'Request body is not valid JSON');
  }
  if (err?.type === 'entity.too.large') {
    return new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
  }

  // Prisma: P2002 = unique constraint violated. This is the safety net for the
  // race where two identical registrations pass the "is it free?" check at once.
  if (err?.code === 'P2002') return new ConflictError('Resource already exists');
  // Prisma: P2025 = record required for the operation was not found.
  if (err?.code === 'P2025') return new NotFoundError();

  return null; // unknown: a bug
}

// Express recognises error middleware by its FOUR parameters; do not remove `next`.
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  const known = toAppError(err);

  if (!known) {
    if (env.NODE_ENV !== 'test') console.error(err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
  }

  const body = { code: known.code, message: known.message };
  if (known.details) body.details = known.details;
  res.status(known.statusCode).json({ error: body });
}

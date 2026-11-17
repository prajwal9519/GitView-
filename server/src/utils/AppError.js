// One error class for every failure we EXPECT (wrong password, not found...).
// Services throw these; middleware/errorHandler.js turns them into JSON.
// Anything that is not an AppError is a bug and becomes a generic 500.
export class AppError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code; // stable machine-readable string the frontend can switch on
    this.details = details; // optional extra info, e.g. per-field validation errors
  }
}

export class BadRequestError extends AppError {
  constructor(code = 'BAD_REQUEST', message = 'Bad request', details) {
    super(400, code, message, details);
  }
}

const UNAUTHORIZED_MESSAGES = {
  TOKEN_MISSING: 'Authentication required',
  TOKEN_EXPIRED: 'Token has expired',
  TOKEN_INVALID: 'Token is invalid',
  TOKEN_REUSED: 'Refresh token reuse detected. Please log in again',
  INVALID_CREDENTIALS: 'Invalid email or password',
};

export class UnauthorizedError extends AppError {
  constructor(code = 'UNAUTHORIZED', message) {
    super(401, code, message ?? UNAUTHORIZED_MESSAGES[code] ?? 'Authentication required');
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to do this') {
    super(403, 'FORBIDDEN', message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(404, 'NOT_FOUND', message);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Resource already exists') {
    super(409, 'CONFLICT', message);
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message = 'Too many attempts. Please try again later') {
    super(429, 'TOO_MANY_REQUESTS', message);
  }
}

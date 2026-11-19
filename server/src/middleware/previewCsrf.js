/**
 * GitView Phase 5 — Milestone 7: Preview CSRF & Host Authority Middleware
 *
 * Implements strict CSRF defenses and Host header integrity:
 * 1. Rejection of duplicate Host headers in req.rawHeaders (HTTP 400 DUPLICATE_HOST_HEADER)
 * 2. Exact Origin allowlisting against new URL(env.FRONTEND_URL).origin (HTTP 403 CSRF_ORIGIN_INVALID)
 * 3. Fallback to exact Referer origin if Origin header is omitted
 * 4. Content-Type: application/json enforcement on mutating requests (HTTP 400 INVALID_CONTENT_TYPE)
 */

import { env } from '../config/env.js';
import { AppError, BadRequestError } from '../utils/AppError.js';

/**
 * Validates that the incoming request does not contain duplicate or comma-separated Host headers.
 * Protects against HTTP request smuggling and Host header spoofing.
 */
export function validateHostHeader(req, _res, next) {
  if (Array.isArray(req.rawHeaders)) {
    let hostCount = 0;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (typeof req.rawHeaders[i] === 'string' && req.rawHeaders[i].toLowerCase() === 'host') {
        hostCount++;
      }
    }
    if (hostCount > 1) {
      throw new BadRequestError('DUPLICATE_HOST_HEADER', 'Duplicate Host header detected');
    }
  }

  if (typeof req.headers?.host === 'string' && req.headers.host.includes(',')) {
    throw new BadRequestError('DUPLICATE_HOST_HEADER', 'Duplicate Host header detected');
  }

  if (next) next();
}

/**
 * CSRF and Origin verification middleware for preview endpoints.
 * Validates Origin/Referer and Content-Type on mutating HTTP methods.
 */
export function previewCsrf(req, _res, next) {
  // Always inspect Host header integrity first
  validateHostHeader(req);

  const isMutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
  if (!isMutating) {
    return next();
  }

  // 1. Enforce Content-Type: application/json on mutating requests
  const contentType = req.headers['content-type'];
  if (!contentType || !req.is('application/json')) {
    throw new BadRequestError('INVALID_CONTENT_TYPE', "Content-Type must be 'application/json'");
  }

  // 2. Exact Origin validation against env.FRONTEND_URL
  const expectedOrigin = new URL(env.FRONTEND_URL).origin;
  const originHeader = req.headers['origin'];

  if (originHeader) {
    let parsedOrigin;
    try {
      parsedOrigin = new URL(originHeader).origin;
    } catch {
      throw new AppError(403, 'CSRF_ORIGIN_INVALID', 'Invalid Origin header format');
    }

    if (parsedOrigin !== expectedOrigin) {
      throw new AppError(403, 'CSRF_ORIGIN_INVALID', 'Cross-origin request forbidden');
    }
  } else {
    // Fallback to Referer header if Origin is omitted
    const refererHeader = req.headers['referer'];
    if (!refererHeader) {
      throw new AppError(403, 'CSRF_ORIGIN_INVALID', 'Missing Origin and Referer headers');
    }

    let parsedRefererOrigin;
    try {
      parsedRefererOrigin = new URL(refererHeader).origin;
    } catch {
      throw new AppError(403, 'CSRF_ORIGIN_INVALID', 'Invalid Referer header format');
    }

    if (parsedRefererOrigin !== expectedOrigin) {
      throw new AppError(403, 'CSRF_ORIGIN_INVALID', 'Cross-origin request forbidden');
    }
  }

  next();
}

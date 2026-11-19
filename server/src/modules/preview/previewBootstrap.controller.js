/**
 * GitView Phase 5 — Milestone 7, Task 2.1: Secure Browser Bootstrap Controller
 *
 * Implements GET /__gitview_bootstrap endpoint:
 * - Direct req.rawHeaders Host header integrity validation (rejects duplicate or missing Host)
 * - Canonical WHATWG Host authority normalization matching §3.3
 * - Single-use ticket redemption via atomic fail-closed Lua script in ticket store
 * - Server-side PreviewSession retrieval and token recovery (AES-256-GCM decrypt)
 * - Partitioned __Host- cookie issuance (RFC 6265bis + CHIPS)
 * - Defensive headers: Cache-Control: no-store, Referrer-Policy: no-referrer
 * - Immediate 302 redirect to / with 0-byte empty body
 */

import { prisma as defaultPrisma } from '../../lib/prisma.js';
import { BadRequestError, UnauthorizedError } from '../../utils/AppError.js';
import { PreviewStatus } from './sessionConstants.js';
import { recoverSessionToken } from './sessionService.js';
import { getTicketStore } from './ticketStore.js';
import { verifyHostAuthority, canonicalizeHostAuthority } from './hostAuthority.js';
import { setPreviewCookie } from './previewCookie.js';
import {
  buildErrorCspPolicy,
  PERMISSIONS_POLICY_DEFAULT,
  REFERRER_POLICY_DEFAULT,
  X_CONTENT_TYPE_OPTIONS_DEFAULT,
} from './previewCsp.js';

/**
 * Validates Host header integrity directly from raw socket headers before any store lookup.
 * Protects against Host header injection, HTTP request smuggling, and duplicate Host attacks.
 *
 * @param {import('express').Request} req
 * @returns {string} Singular validated host header
 */
export function validateBootstrapHost(req) {
  let hostCount = 0;
  if (Array.isArray(req.rawHeaders)) {
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (typeof req.rawHeaders[i] === 'string' && req.rawHeaders[i].toLowerCase() === 'host') {
        hostCount++;
      }
    }
  }

  if (hostCount === 0 || !req.headers?.host) {
    throw new BadRequestError('MISSING_HOST_HEADER', 'Host header is required');
  }

  if (hostCount > 1) {
    throw new BadRequestError('DUPLICATE_HOST_HEADER', 'Duplicate Host header detected');
  }

  const hostHeader = req.headers.host;
  if (typeof hostHeader !== 'string' || hostHeader.includes(',')) {
    throw new BadRequestError('DUPLICATE_HOST_HEADER', 'Duplicate or comma-separated Host header detected');
  }

  return hostHeader;
}

/**
 * Handles single-use ticket exchange and browser bootstrap.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export async function handleBootstrap(req, res, next) {
  try {
    // 1. Direct rawHeaders Host validation: reject duplicate/missing Host BEFORE touching ticket store
    const hostHeader = validateBootstrapHost(req);

    // 2. Validate ticket format (strictly 64 hex characters)
    const ticket = req.query.ticket;
    if (!ticket || typeof ticket !== 'string' || !/^[0-9a-fA-F]{64}$/.test(ticket)) {
      throw new BadRequestError(
        'INVALID_TICKET',
        'Ticket query parameter is required and must be a 64-character hex string'
      );
    }

    // 3. Normalize incoming host authority to canonical format (${hostname}:${port})
    const reqProtocol = req.socket?.encrypted || req.protocol === 'https' ? 'https:' : 'http:';
    const incomingCanonicalHost = canonicalizeHostAuthority(hostHeader, reqProtocol);
    if (!incomingCanonicalHost) {
      throw new BadRequestError('HOST_AUTHORITY_MALFORMED', 'Malformed Host header authority');
    }

    // 4. Atomically consume ticket from ticket store using canonical authority
    const ticketStore = getTicketStore();
    const ticketData = await ticketStore.consumeTicket(ticket, incomingCanonicalHost);

    if (!ticketData || ticketData === 'NOT_FOUND') {
      throw new UnauthorizedError('INVALID_OR_EXPIRED_TICKET', 'Bootstrap ticket expired or invalid');
    }

    if (ticketData === 'INVALID_METADATA' || ticketData?.error === 'INVALID_METADATA') {
      throw new UnauthorizedError('INVALID_METADATA', 'Bootstrap ticket metadata is malformed');
    }

    if (ticketData === 'HOST_MISMATCH' || ticketData?.error === 'HOST_MISMATCH') {
      throw new UnauthorizedError('HOST_AUTHORITY_MISMATCH', 'Host authority mismatch');
    }

    // 5. Verify canonical Host authority against ticket target origin
    const hostValidation = verifyHostAuthority(hostHeader, ticketData.targetOrigin);
    if (!hostValidation.valid) {
      throw new UnauthorizedError('HOST_AUTHORITY_MISMATCH', `Host authority mismatch: ${hostValidation.reason}`);
    }

    // 6. Retrieve PreviewSession from database
    const session = await defaultPrisma.previewSession.findUnique({
      where: { id: ticketData.sessionId },
    });

    if (!session) {
      throw new UnauthorizedError('SESSION_NOT_FOUND', 'Preview session not found');
    }

    if (session.status !== PreviewStatus.RUNNING || !session.isActive) {
      throw new UnauthorizedError('SESSION_INACTIVE', 'Preview session is not running or inactive');
    }

    if (new Date() >= new Date(session.expiresAt)) {
      throw new UnauthorizedError('SESSION_EXPIRED', 'Preview session has expired');
    }

    // 7. Recover raw capability token server-side
    const rawToken = recoverSessionToken(session);
    const remainingLifetimeSeconds = Math.max(
      0,
      Math.floor((new Date(session.expiresAt).getTime() - Date.now()) / 1000)
    );

    // 8. Set partitioned __Host- cookie
    setPreviewCookie(res, rawToken, remainingLifetimeSeconds);

    // 9. Injected defensive security headers
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Referrer-Policy', REFERRER_POLICY_DEFAULT);
    res.setHeader('X-Content-Type-Options', X_CONTENT_TYPE_OPTIONS_DEFAULT);
    res.setHeader('Permissions-Policy', PERMISSIONS_POLICY_DEFAULT);
    res.setHeader('Content-Security-Policy', buildErrorCspPolicy());

    // 10. Immediate 302 Found redirect with empty body (0 bytes)
    return res.status(302).location('/').end();
  } catch (err) {
    next(err);
  }
}

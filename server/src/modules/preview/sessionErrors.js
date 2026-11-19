/**
 * GitView Phase 5 — Milestone 3: Live Preview Domain Errors
 */

import { AppError } from '../../utils/AppError.js';

export class ActiveSessionConflictError extends AppError {
  constructor(userId, message) {
    super(
      409,
      'ACTIVE_SESSION_CONFLICT',
      message ?? 'You already have an active live preview session. Only one concurrent preview is permitted.'
    );
    this.name = 'ActiveSessionConflictError';
    this.userId = userId;
  }
}

export class SessionTransitionConflictError extends AppError {
  constructor(sessionId, expectedStatus, message) {
    super(
      409,
      'SESSION_TRANSITION_CONFLICT',
      message ?? `Session transition conflict: session '${sessionId}' is not in expected status '${expectedStatus}'.`
    );
    this.name = 'SessionTransitionConflictError';
    this.sessionId = sessionId;
    this.expectedStatus = expectedStatus;
  }
}

export class SessionNotFoundError extends AppError {
  constructor(sessionId) {
    super(404, 'SESSION_NOT_FOUND', `Preview session '${sessionId}' was not found.`);
    this.name = 'SessionNotFoundError';
    this.sessionId = sessionId;
  }
}

export class InvalidPreviewTokenError extends AppError {
  constructor(message = 'Invalid or corrupted preview token.') {
    super(401, 'INVALID_PREVIEW_TOKEN', message);
    this.name = 'InvalidPreviewTokenError';
  }
}

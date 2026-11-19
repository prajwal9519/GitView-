/**
 * GitView Phase 5 — Milestone 3: Live Preview State Machine Domain Logic
 */

import {
  PreviewStatus,
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  ALLOWED_TRANSITIONS,
  IDLE_SESSION_TIMEOUT_MS,
} from './sessionConstants.js';

export class InvalidStateTransitionError extends Error {
  constructor(currentStatus, targetStatus, message) {
    super(
      message ??
      `Invalid preview session transition from '${currentStatus}' to '${targetStatus}'.`
    );
    this.name = 'InvalidStateTransitionError';
    this.currentStatus = currentStatus;
    this.targetStatus = targetStatus;
    this.statusCode = 400;
  }
}

/**
 * Checks if a status string is a recognized PreviewStatus.
 *
 * @param {string} status
 * @returns {boolean}
 */
export function isValidStatus(status) {
  return typeof status === 'string' && Object.prototype.hasOwnProperty.call(PreviewStatus, status);
}

/**
 * Checks if a status represents an active session (isActive = true).
 *
 * @param {string} status
 * @returns {boolean}
 */
export function isActiveStatus(status) {
  return ACTIVE_STATUSES.has(status);
}

/**
 * Checks if a status represents a terminal state (isActive = false).
 *
 * @param {string} status
 * @returns {boolean}
 */
export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

/**
 * Evaluates whether transitioning from currentStatus to targetStatus is allowed.
 *
 * @param {string} currentStatus
 * @param {string} targetStatus
 * @returns {boolean}
 */
export function canTransition(currentStatus, targetStatus) {
  if (!isValidStatus(currentStatus) || !isValidStatus(targetStatus)) {
    return false;
  }
  const allowedTargets = ALLOWED_TRANSITIONS[currentStatus] || [];
  return allowedTargets.includes(targetStatus);
}

/**
 * Asserts that a state transition is legal, throwing InvalidStateTransitionError if not.
 *
 * @param {string} currentStatus
 * @param {string} targetStatus
 * @throws {InvalidStateTransitionError}
 */
export function assertValidTransition(currentStatus, targetStatus) {
  if (!isValidStatus(currentStatus)) {
    throw new InvalidStateTransitionError(currentStatus, targetStatus, `Unknown current preview status: '${currentStatus}'`);
  }
  if (!isValidStatus(targetStatus)) {
    throw new InvalidStateTransitionError(currentStatus, targetStatus, `Unknown target preview status: '${targetStatus}'`);
  }
  if (!canTransition(currentStatus, targetStatus)) {
    const allowed = (ALLOWED_TRANSITIONS[currentStatus] || []).join(', ') || 'none (terminal)';
    throw new InvalidStateTransitionError(
      currentStatus,
      targetStatus,
      `Illegal transition from '${currentStatus}' to '${targetStatus}'. Allowed target states: [${allowed}]`
    );
  }
}

/**
 * Evaluates whether a session has exceeded its hard maximum lifetime or its idle timeout.
 *
 * @param {{ isActive: boolean, expiresAt: Date|string, lastActiveAt: Date|string }} session
 * @param {Date} [now]
 * @returns {boolean}
 */
export function isSessionExpired(session, now = new Date()) {
  if (!session || !session.isActive) {
    return false;
  }
  const currentTime = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const expiresAtTime = new Date(session.expiresAt).getTime();
  const lastActiveTime = new Date(session.lastActiveAt).getTime();

  // 1. Hard maximum lifetime cap reached
  if (currentTime >= expiresAtTime) {
    return true;
  }

  // 2. Idle timeout reached
  if (currentTime - lastActiveTime >= IDLE_SESSION_TIMEOUT_MS) {
    return true;
  }

  return false;
}

/**
 * Returns the specific reason why a session is considered expired.
 *
 * @param {{ isActive: boolean, expiresAt: Date|string, lastActiveAt: Date|string }} session
 * @param {Date} [now]
 * @returns {'HARD_LIFETIME_EXCEEDED' | 'IDLE_TIMEOUT' | null}
 */
export function getExpirationReason(session, now = new Date()) {
  if (!isSessionExpired(session, now)) {
    return null;
  }
  const currentTime = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const expiresAtTime = new Date(session.expiresAt).getTime();

  if (currentTime >= expiresAtTime) {
    return 'HARD_LIFETIME_EXCEEDED';
  }
  return 'IDLE_TIMEOUT';
}

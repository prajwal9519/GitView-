/**
 * GitView Phase 5 — Milestone 3: Live Preview Session Constants & Transition Rules
 */

export const PreviewStatus = Object.freeze({
  PENDING: 'PENDING',
  FETCHING: 'FETCHING',
  BUILDING: 'BUILDING',
  STARTING: 'STARTING',
  RUNNING: 'RUNNING',
  STOPPING: 'STOPPING',
  STOPPED: 'STOPPED',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED',
});

export const FrameworkType = Object.freeze({
  STATIC: 'STATIC',
  VITE_REACT: 'VITE_REACT',
  VITE_VANILLA: 'VITE_VANILLA',
  REACT: 'REACT',
  UNKNOWN: 'UNKNOWN',
});

/**
 * Active statuses where a container/session occupies the user's single active slot.
 * Enforced at the database level: isActive = true
 */
export const ACTIVE_STATUSES = Object.freeze(new Set([
  PreviewStatus.PENDING,
  PreviewStatus.FETCHING,
  PreviewStatus.BUILDING,
  PreviewStatus.STARTING,
  PreviewStatus.RUNNING,
  PreviewStatus.STOPPING,
]));

/**
 * Terminal statuses where a session is permanently closed and releases the user's active slot.
 * Enforced at the database level: isActive = false
 */
export const TERMINAL_STATUSES = Object.freeze(new Set([
  PreviewStatus.STOPPED,
  PreviewStatus.FAILED,
  PreviewStatus.EXPIRED,
]));

/**
 * Hard ceiling on total session duration (1 hour) from session creation.
 * Prevents runaway resource consumption regardless of user interaction.
 */
export const MAX_SESSION_LIFETIME_MS = 60 * 60 * 1000; // 60 minutes

/**
 * Dynamic idle timeout from last recorded activity (15 minutes).
 * Reset on user interaction / proxy traffic / workspace heartbeat.
 */
export const IDLE_SESSION_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Explicit state transition table.
 * Maps [currentStatus] -> Array of allowed [targetStatus].
 */
export const ALLOWED_TRANSITIONS = Object.freeze({
  [PreviewStatus.PENDING]: [
    PreviewStatus.FETCHING,
    PreviewStatus.STOPPED,   // Immediate user cancellation before fetch starts
    PreviewStatus.FAILED,    // Initial validation / port allocation failure
    PreviewStatus.EXPIRED,   // Hard TTL expiration while queued
  ],
  [PreviewStatus.FETCHING]: [
    PreviewStatus.BUILDING,  // Fetched repo requires build step
    PreviewStatus.STARTING,  // Pure static site; skips build step straight to container startup
    PreviewStatus.STOPPING,  // User cancellation during repository download
    PreviewStatus.FAILED,    // GitHub API error, size limit exceeded, extraction failure
    PreviewStatus.EXPIRED,   // Hard TTL expiration
  ],
  [PreviewStatus.BUILDING]: [
    PreviewStatus.STARTING,  // Build succeeded
    PreviewStatus.STOPPING,  // User cancellation during build
    PreviewStatus.FAILED,    // Build failure, syntax error, memory exceeded
    PreviewStatus.EXPIRED,   // Hard TTL expiration
  ],
  [PreviewStatus.STARTING]: [
    PreviewStatus.RUNNING,   // Containers spawned, healthy, proxy verified
    PreviewStatus.STOPPING,  // User cancellation during startup
    PreviewStatus.FAILED,    // Startup timeout, healthcheck failure, runner crash
    PreviewStatus.EXPIRED,   // Hard TTL expiration
  ],
  [PreviewStatus.RUNNING]: [
    PreviewStatus.STOPPING,  // User graceful stop
    PreviewStatus.FAILED,    // Container crash loop, runner OOM killed at runtime
    PreviewStatus.EXPIRED,   // Idle timeout or hard TTL exceeded
  ],
  [PreviewStatus.STOPPING]: [
    PreviewStatus.STOPPED,   // Teardown of containers, volume, network complete
    PreviewStatus.FAILED,    // Teardown / cleanup error
  ],
  // Terminal states cannot transition to anything
  [PreviewStatus.STOPPED]: [],
  [PreviewStatus.FAILED]: [],
  [PreviewStatus.EXPIRED]: [],
});

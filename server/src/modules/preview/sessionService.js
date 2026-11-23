/**
 * GitView Phase 5 — Milestone 3: Live Preview Session Service
 *
 * Implements atomic, race-free session lifecycle domain operations,
 * token cryptographic operations, and concurrency enforcement.
 */

import { prisma as defaultPrisma } from '../../lib/prisma.js';
import {
  PreviewStatus,
  FrameworkType,
  MAX_SESSION_LIFETIME_MS,
  IDLE_SESSION_TIMEOUT_MS,
} from './sessionConstants.js';
import {
  assertValidTransition,
  isTerminalStatus,
} from './sessionStateMachine.js';
import {
  generatePreviewToken,
  hashPreviewToken,
  encryptPreviewToken,
  decryptPreviewToken,
} from '../../utils/previewTokens.js';
import {
  ActiveSessionConflictError,
  SessionTransitionConflictError,
  SessionNotFoundError,
  InvalidPreviewTokenError,
} from './sessionErrors.js';
import { invalidateSessionGatewayCache } from './previewGateway.js';

/**
 * Creates a new PreviewSession for a user with atomic concurrency guarantees.
 * Enforces MVP policy: max 1 active preview per user via partial unique index.
 *
 * @param {Object} params
 * @param {string} params.userId
 * @param {string} params.repositoryId
 * @param {string} params.commitSha
 * @param {string} params.branch
 * @param {string} [params.framework]
 * @param {import('@prisma/client').PrismaClient} [client]
 * @returns {Promise<{ session: Object, rawToken: string }>}
 */
export async function createPreviewSession(
  {
    userId,
    repositoryId,
    commitSha,
    branch,
    framework = FrameworkType.UNKNOWN,
    projectRoot = null,
  },
  client = defaultPrisma
) {
  if (!userId || !repositoryId || !commitSha || !branch) {
    throw new Error('userId, repositoryId, commitSha, and branch are required to create a preview session');
  }

  // 1. Generate cryptographically secure preview token (32 random bytes = 256 bits)
  const rawToken = generatePreviewToken();
  const tokenHash = hashPreviewToken(rawToken);
  const previewTokenEnc = encryptPreviewToken(rawToken);

  // 2. Compute hard maximum lifetime ceiling
  const now = new Date();
  const expiresAt = new Date(now.getTime() + MAX_SESSION_LIFETIME_MS);

  try {
    const session = await client.previewSession.create({
      data: {
        userId,
        repositoryId,
        commitSha,
        branch,
        framework,
        projectRoot: projectRoot || null,
        status: PreviewStatus.PENDING,
        isActive: true,
        tokenHash,
        previewTokenEnc,
        expiresAt,
        lastActiveAt: now,
      },
    });

    return { session, rawToken };
  } catch (err) {
    // Prisma P2002: Unique constraint failed
    if (err.code === 'P2002') {
      throw new ActiveSessionConflictError(
        userId,
        'You already have an active live preview session. Only one concurrent preview is permitted.'
      );
    }
    throw err;
  }
}

/**
 * Performs an atomic, conditional state transition against the expected current status.
 * Prevents race conditions and guarantees that concurrent transitions fail predictably.
 *
 * @param {string} sessionId
 * @param {string} expectedCurrentStatus
 * @param {string} targetStatus
 * @param {Object} [updateData] Optional additional fields to update (e.g. runnerContainerId, proxyPort)
 * @param {import('@prisma/client').PrismaClient} [client]
 * @returns {Promise<Object>} Updated session record
 */
export async function transitionSession(
  sessionId,
  expectedCurrentStatus,
  targetStatus,
  updateData = {},
  client = defaultPrisma
) {
  // 1. Verify that transition is legally defined in state machine
  assertValidTransition(expectedCurrentStatus, targetStatus);

  const isTargetTerminal = isTerminalStatus(targetStatus);
  const now = new Date();

  const dataToUpdate = {
    status: targetStatus,
    isActive: !isTargetTerminal,
    ...updateData,
  };

  // Automatically record lifecycle timestamps
  if (targetStatus === PreviewStatus.RUNNING && !dataToUpdate.startedAt) {
    dataToUpdate.startedAt = now;
  }
  if (isTargetTerminal && !dataToUpdate.stoppedAt) {
    dataToUpdate.stoppedAt = now;
  }

  // 2. Perform conditional update against expected current status
  const updateResult = await client.previewSession.updateMany({
    where: {
      id: sessionId,
      status: expectedCurrentStatus,
    },
    data: dataToUpdate,
  });

  if (updateResult.count === 0) {
    // Determine exact cause of failure for informative, actionable error response
    const existing = await client.previewSession.findUnique({
      where: { id: sessionId },
    });

    if (!existing) {
      throw new SessionNotFoundError(sessionId);
    }

    throw new SessionTransitionConflictError(
      sessionId,
      expectedCurrentStatus,
      `Cannot transition session '${sessionId}' to '${targetStatus}': current status is '${existing.status}', expected '${expectedCurrentStatus}'.`
    );
  }

  invalidateSessionGatewayCache(sessionId);

  return client.previewSession.findUnique({
    where: { id: sessionId },
  });
}

/**
 * Cancels an active preview session.
 * If in PENDING, transitions directly to STOPPED (immediate slot release).
 * If in progress (FETCHING, BUILDING, STARTING, RUNNING), transitions to STOPPING.
 *
 * @param {string} sessionId
 * @param {string} expectedCurrentStatus
 * @param {import('@prisma/client').PrismaClient} [client]
 * @returns {Promise<Object>}
 */
export async function cancelSession(
  sessionId,
  expectedCurrentStatus,
  client = defaultPrisma
) {
  const targetStatus = expectedCurrentStatus === PreviewStatus.PENDING
    ? PreviewStatus.STOPPED
    : PreviewStatus.STOPPING;

  return transitionSession(sessionId, expectedCurrentStatus, targetStatus, {}, client);
}

/**
 * Transitions an active preview session to FAILED, recording error metadata.
 *
 * @param {string} sessionId
 * @param {string} expectedCurrentStatus
 * @param {Object} errorMeta
 * @param {string} [errorMeta.errorCode]
 * @param {string} [errorMeta.errorMessage]
 * @param {import('@prisma/client').PrismaClient} [client]
 * @returns {Promise<Object>}
 */
export async function failSession(
  sessionId,
  expectedCurrentStatus,
  { errorCode = 'INTERNAL_ERROR', errorMessage = 'An unexpected preview error occurred.' } = {},
  client = defaultPrisma
) {
  const boundedMessage = errorMessage ? String(errorMessage).slice(0, 1000) : null;
  return transitionSession(
    sessionId,
    expectedCurrentStatus,
    PreviewStatus.FAILED,
    {
      errorCode,
      errorMessage: boundedMessage,
    },
    client
  );
}

/**
 * Transitions an active preview session to EXPIRED.
 *
 * @param {string} sessionId
 * @param {string} expectedCurrentStatus
 * @param {string} [reason]
 * @param {import('@prisma/client').PrismaClient} [client]
 * @returns {Promise<Object>}
 */
export async function expireSession(
  sessionId,
  expectedCurrentStatus,
  reason = 'SESSION_EXPIRED',
  client = defaultPrisma
) {
  return transitionSession(
    sessionId,
    expectedCurrentStatus,
    PreviewStatus.EXPIRED,
    {
      errorCode: reason,
      errorMessage: 'Live preview session expired due to timeout.',
    },
    client
  );
}

/**
 * Updates lastActiveAt timestamp to prevent idle timeout.
 * Operates only on currently active sessions.
 *
 * @param {string} sessionId
 * @param {import('@prisma/client').PrismaClient} [client]
 * @returns {Promise<boolean>} True if activity was updated, false if session is inactive or not found
 */
export async function touchSessionActivity(sessionId, client = defaultPrisma) {
  const result = await client.previewSession.updateMany({
    where: {
      id: sessionId,
      isActive: true,
    },
    data: {
      lastActiveAt: new Date(),
    },
  });

  return result.count > 0;
}

/**
 * Recovers the raw plaintext preview token for an authorized session on workspace refresh.
 * Decrypts AES-256-GCM ciphertext and validates against SHA-256 tokenHash.
 *
 * @param {Object} session
 * @param {string} [overrideKey]
 * @returns {string} Plaintext preview token
 */
export function recoverSessionToken(session, overrideKey) {
  if (!session || !session.previewTokenEnc || !session.tokenHash) {
    throw new InvalidPreviewTokenError('Session record does not contain encrypted token data');
  }

  const rawToken = decryptPreviewToken(session.previewTokenEnc, overrideKey);
  const computedHash = hashPreviewToken(rawToken);

  if (computedHash !== session.tokenHash) {
    throw new InvalidPreviewTokenError('Recovered token failed SHA-256 integrity verification');
  }

  return rawToken;
}

/**
 * Looks up a preview session by its raw token (via indexed SHA-256 hash lookup).
 *
 * @param {string} token
 * @param {import('@prisma/client').PrismaClient} [client]
 * @returns {Promise<Object|null>}
 */
export async function findSessionByToken(token, client = defaultPrisma) {
  if (!token || typeof token !== 'string') {
    return null;
  }
  const tokenHash = hashPreviewToken(token);
  return client.previewSession.findUnique({
    where: { tokenHash },
  });
}

/**
 * Retrieves the currently active preview session for a user, if one exists.
 *
 * @param {string} userId
 * @param {import('@prisma/client').PrismaClient} [client]
 * @returns {Promise<Object|null>}
 */
export async function getActiveSessionForUser(userId, client = defaultPrisma) {
  return client.previewSession.findFirst({
    where: {
      userId,
      isActive: true,
    },
  });
}

/**
 * Finds all active sessions eligible for TTL or idle expiration.
 * Utilizes composite indexes: [isActive, expiresAt] and [isActive, lastActiveAt].
 *
 * @param {import('@prisma/client').PrismaClient} [client]
 * @param {Date} [now]
 * @returns {Promise<Array<Object>>}
 */
export async function findExpiredSessions(client = defaultPrisma, now = new Date()) {
  const idleCutoff = new Date(now.getTime() - IDLE_SESSION_TIMEOUT_MS);

  return client.previewSession.findMany({
    where: {
      isActive: true,
      OR: [
        { expiresAt: { lte: now } },
        { lastActiveAt: { lte: idleCutoff } },
      ],
    },
  });
}

/**
 * Sanitizes a PreviewSession database record for safe transmission to the client frontend.
 * Strictly excludes container IDs, Docker network metadata, internal proxy ports, and token hashes.
 *
 * @param {Object} session
 * @returns {Object} Client-safe session DTO
 */
export function sanitizeSessionForClient(session) {
  if (!session) return null;

  return {
    id: session.id,
    repositoryId: session.repositoryId,
    status: session.status,
    framework: session.framework,
    projectRoot: session.projectRoot || '',
    isActive: session.isActive,
    commitSha: session.commitSha,
    branch: session.branch,
    createdAt: session.createdAt,
    startedAt: session.startedAt,
    stoppedAt: session.stoppedAt,
    expiresAt: session.expiresAt,
    lastActiveAt: session.lastActiveAt,
    errorCode: session.errorCode,
    errorMessage: session.errorMessage,
  };
}

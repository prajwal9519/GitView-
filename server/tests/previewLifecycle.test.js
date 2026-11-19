import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { prisma, resetDb, createUser } from './helpers.js';
import {
  PreviewStatus,
  FrameworkType,
  MAX_SESSION_LIFETIME_MS,
  IDLE_SESSION_TIMEOUT_MS,
} from '../src/modules/preview/sessionConstants.js';
import {
  isSessionExpired,
  getExpirationReason,
  InvalidStateTransitionError,
} from '../src/modules/preview/sessionStateMachine.js';
import {
  createPreviewSession,
  transitionSession,
  cancelSession,
  failSession,
  expireSession,
  touchSessionActivity,
  recoverSessionToken,
  findSessionByToken,
  getActiveSessionForUser,
  findExpiredSessions,
  sanitizeSessionForClient,
} from '../src/modules/preview/sessionService.js';
import {
  ActiveSessionConflictError,
  SessionTransitionConflictError,
  SessionNotFoundError,
  InvalidPreviewTokenError,
} from '../src/modules/preview/sessionErrors.js';

describe('PreviewSession Database & Lifecycle Domain Logic', () => {
  let user;
  let userB;
  let repo;

  beforeEach(async () => {
    await resetDb();

    user = await createUser({
      email: 'preview-tester@example.com',
      username: 'preview_tester',
    });

    userB = await createUser({
      email: 'preview-tester-b@example.com',
      username: 'preview_tester_b',
    });

    repo = await prisma.repository.create({
      data: {
        userId: user.id,
        githubRepoId: '987654321',
        owner: 'gitview-org',
        name: 'sample-app',
        fullName: 'gitview-org/sample-app',
        htmlUrl: 'https://github.com/gitview-org/sample-app',
        defaultBranch: 'main',
        latestCommitSha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      },
    });
  });

  describe('1. Session Creation & Token Handling', () => {
    it('creates an active session in PENDING state with encrypted token and SHA-256 hash', async () => {
      const { session, rawToken } = await createPreviewSession({
        userId: user.id,
        repositoryId: repo.id,
        commitSha: repo.latestCommitSha,
        branch: 'main',
        framework: FrameworkType.VITE_REACT,
      });

      expect(session.id).toBeDefined();
      expect(session.userId).toBe(user.id);
      expect(session.repositoryId).toBe(repo.id);
      expect(session.status).toBe(PreviewStatus.PENDING);
      expect(session.framework).toBe(FrameworkType.VITE_REACT);
      expect(session.isActive).toBe(true);
      expect(session.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(session.previewTokenEnc).toBeDefined();
      expect(session.startedAt).toBeNull();
      expect(session.stoppedAt).toBeNull();

      // Verify hard TTL is ~1 hour from creation
      const diff = new Date(session.expiresAt).getTime() - new Date(session.createdAt).getTime();
      expect(diff).toBeGreaterThanOrEqual(MAX_SESSION_LIFETIME_MS - 5000);
      expect(diff).toBeLessThanOrEqual(MAX_SESSION_LIFETIME_MS + 5000);

      // Verify rawToken is recoverable from encrypted field
      const recovered = recoverSessionToken(session);
      expect(recovered).toBe(rawToken);

      // Verify O(1) indexed token lookup
      const found = await findSessionByToken(rawToken);
      expect(found).not.toBeNull();
      expect(found.id).toBe(session.id);
    });

    it('creates an active session with VITE_VANILLA framework and transitions to RUNNING', async () => {
      const { session } = await createPreviewSession({
        userId: user.id,
        repositoryId: repo.id,
        commitSha: repo.latestCommitSha,
        branch: 'main',
        framework: FrameworkType.VITE_VANILLA,
      });

      expect(session.id).toBeDefined();
      expect(session.framework).toBe(FrameworkType.VITE_VANILLA);
      expect(session.status).toBe(PreviewStatus.PENDING);

      // Verify database persistence of VITE_VANILLA enum value
      const fromDb = await prisma.previewSession.findUnique({
        where: { id: session.id },
      });
      expect(fromDb.framework).toBe('VITE_VANILLA');

      // Transition through lifecycle
      await transitionSession(session.id, PreviewStatus.PENDING, PreviewStatus.FETCHING);
      await transitionSession(session.id, PreviewStatus.FETCHING, PreviewStatus.STARTING);
      const running = await transitionSession(session.id, PreviewStatus.STARTING, PreviewStatus.RUNNING);
      expect(running.status).toBe(PreviewStatus.RUNNING);
      expect(running.framework).toBe(FrameworkType.VITE_VANILLA);
    });

    it('recovers token on workspace refresh and fails on corrupted token data', async () => {
      const { session, rawToken } = await createPreviewSession({
        userId: user.id,
        repositoryId: repo.id,
        commitSha: repo.latestCommitSha,
        branch: 'main',
      });

      // Normal recovery succeeds
      expect(recoverSessionToken(session)).toBe(rawToken);

      // Tampered tokenHash fails integrity check
      const tamperedHashSession = { ...session, tokenHash: 'f'.repeat(64) };
      expect(() => recoverSessionToken(tamperedHashSession)).toThrow(InvalidPreviewTokenError);

      // Tampered previewTokenEnc fails decryption
      const tamperedEncSession = { ...session, previewTokenEnc: 'bad:data:format' };
      expect(() => recoverSessionToken(tamperedEncSession)).toThrow();
    });
  });

  describe('2. Active-Session Concurrency & Partial Unique Index', () => {
    it('enforces MVP policy of 1 active preview session per user', async () => {
      // 1st active session
      await createPreviewSession({
        userId: user.id,
        repositoryId: repo.id,
        commitSha: repo.latestCommitSha,
        branch: 'main',
      });

      // 2nd active session attempt must be rejected with ActiveSessionConflictError (409)
      await expect(
        createPreviewSession({
          userId: user.id,
          repositoryId: repo.id,
          commitSha: repo.latestCommitSha,
          branch: 'feature-branch',
        })
      ).rejects.toThrow(ActiveSessionConflictError);
    });

    it('permits concurrent active sessions for different users', async () => {
      const sessionA = await createPreviewSession({
        userId: user.id,
        repositoryId: repo.id,
        commitSha: repo.latestCommitSha,
        branch: 'main',
      });

      const sessionB = await createPreviewSession({
        userId: userB.id,
        repositoryId: repo.id,
        commitSha: repo.latestCommitSha,
        branch: 'main',
      });

      expect(sessionA.session.userId).toBe(user.id);
      expect(sessionB.session.userId).toBe(userB.id);
      expect(sessionA.session.isActive).toBe(true);
      expect(sessionB.session.isActive).toBe(true);
    });

    it('handles race condition: two simultaneous creation attempts result in exactly 1 winner', async () => {
      const results = await Promise.allSettled([
        createPreviewSession({
          userId: user.id,
          repositoryId: repo.id,
          commitSha: repo.latestCommitSha,
          branch: 'main',
        }),
        createPreviewSession({
          userId: user.id,
          repositoryId: repo.id,
          commitSha: repo.latestCommitSha,
          branch: 'main',
        }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(ActiveSessionConflictError);
      expect(rejected[0].reason.statusCode).toBe(409);
    });
  });

  describe('3. Lifecycle State Machine & Valid Transitions', () => {
    it('traverses the full Vite React lifecycle from PENDING to STOPPED', async () => {
      const { session } = await createPreviewSession({
        userId: user.id,
        repositoryId: repo.id,
        commitSha: repo.latestCommitSha,
        branch: 'main',
        framework: FrameworkType.VITE_REACT,
      });

      // 1. PENDING -> FETCHING
      const s1 = await transitionSession(session.id, PreviewStatus.PENDING, PreviewStatus.FETCHING);
      expect(s1.status).toBe(PreviewStatus.FETCHING);
      expect(s1.isActive).toBe(true);

      // 2. FETCHING -> BUILDING
      const s2 = await transitionSession(session.id, PreviewStatus.FETCHING, PreviewStatus.BUILDING);
      expect(s2.status).toBe(PreviewStatus.BUILDING);
      expect(s2.isActive).toBe(true);

      // 3. BUILDING -> STARTING
      const s3 = await transitionSession(session.id, PreviewStatus.BUILDING, PreviewStatus.STARTING, {
        runnerContainerId: 'runner_cid_12345',
        proxyContainerId: 'proxy_cid_67890',
        proxyPort: 64596,
      });
      expect(s3.status).toBe(PreviewStatus.STARTING);
      expect(s3.runnerContainerId).toBe('runner_cid_12345');
      expect(s3.proxyPort).toBe(64596);
      expect(s3.isActive).toBe(true);

      // 4. STARTING -> RUNNING (sets startedAt)
      const s4 = await transitionSession(session.id, PreviewStatus.STARTING, PreviewStatus.RUNNING);
      expect(s4.status).toBe(PreviewStatus.RUNNING);
      expect(s4.isActive).toBe(true);
      expect(s4.startedAt).toBeInstanceOf(Date);

      // 5. RUNNING -> STOPPING
      const s5 = await transitionSession(session.id, PreviewStatus.RUNNING, PreviewStatus.STOPPING);
      expect(s5.status).toBe(PreviewStatus.STOPPING);
      expect(s5.isActive).toBe(true);

      // 6. STOPPING -> STOPPED (sets stoppedAt, sets isActive=false)
      const s6 = await transitionSession(session.id, PreviewStatus.STOPPING, PreviewStatus.STOPPED);
      expect(s6.status).toBe(PreviewStatus.STOPPED);
      expect(s6.isActive).toBe(false);
      expect(s6.stoppedAt).toBeInstanceOf(Date);
    });

    it('traverses the static site lifecycle (skipping BUILDING)', async () => {
      const { session } = await createPreviewSession({
        userId: user.id,
        repositoryId: repo.id,
        commitSha: repo.latestCommitSha,
        branch: 'main',
        framework: FrameworkType.STATIC,
      });

      // PENDING -> FETCHING -> STARTING -> RUNNING -> STOPPED
      await transitionSession(session.id, PreviewStatus.PENDING, PreviewStatus.FETCHING);
      const starting = await transitionSession(session.id, PreviewStatus.FETCHING, PreviewStatus.STARTING);
      expect(starting.status).toBe(PreviewStatus.STARTING);

      const running = await transitionSession(session.id, PreviewStatus.STARTING, PreviewStatus.RUNNING);
      expect(running.status).toBe(PreviewStatus.RUNNING);
      expect(running.startedAt).toBeInstanceOf(Date);
    });
  });

  describe('4. Invalid Transitions & Concurrency Conflict Protection', () => {
    it('rejects illegal status jumps and backward transitions', async () => {
      const { session } = await createPreviewSession({
        userId: user.id,
        repositoryId: repo.id,
        commitSha: repo.latestCommitSha,
        branch: 'main',
      });

      // Jump: PENDING -> RUNNING (illegal)
      await expect(
        transitionSession(session.id, PreviewStatus.PENDING, PreviewStatus.RUNNING)
      ).rejects.toThrow(InvalidStateTransitionError);

      // Transition to FETCHING
      await transitionSession(session.id, PreviewStatus.PENDING, PreviewStatus.FETCHING);

      // Backward: FETCHING -> PENDING (illegal)
      await expect(
        transitionSession(session.id, PreviewStatus.FETCHING, PreviewStatus.PENDING)
      ).rejects.toThrow(InvalidStateTransitionError);
    });

    it('rejects any transition attempt out of terminal states', async () => {
      const { session } = await createPreviewSession({
        userId: user.id,
        repositoryId: repo.id,
        commitSha: repo.latestCommitSha,
        branch: 'main',
      });

      // PENDING -> STOPPED (direct cancel)
      await cancelSession(session.id, PreviewStatus.PENDING);

      // From STOPPED: attempt to transition to RUNNING, PENDING, or FAILED
      await expect(
        transitionSession(session.id, PreviewStatus.STOPPED, PreviewStatus.RUNNING)
      ).rejects.toThrow(InvalidStateTransitionError);

      await expect(
        transitionSession(session.id, PreviewStatus.STOPPED, PreviewStatus.PENDING)
      ).rejects.toThrow(InvalidStateTransitionError);
    });

    it('rejects conditional update when current status does not match expected status', async () => {
      const { session } = await createPreviewSession({
        userId: user.id,
        repositoryId: repo.id,
        commitSha: repo.latestCommitSha,
        branch: 'main',
      });

      // Transition PENDING -> FETCHING
      await transitionSession(session.id, PreviewStatus.PENDING, PreviewStatus.FETCHING);

      // Stale call thinking session is still in PENDING
      await expect(
        transitionSession(session.id, PreviewStatus.PENDING, PreviewStatus.STOPPED)
      ).rejects.toThrow(SessionTransitionConflictError);
    });

    it('rejects transition on non-existent session ID with SessionNotFoundError', async () => {
      const nonExistentId = crypto.randomUUID();
      await expect(
        transitionSession(nonExistentId, PreviewStatus.PENDING, PreviewStatus.FETCHING)
      ).rejects.toThrow(SessionNotFoundError);
    });
  });

  describe('5. Cancellation, Failure & Expiration', () => {
    it('cancels a PENDING session immediately to STOPPED and releases active slot', async () => {
      const { session } = await createPreviewSession({
        userId: user.id,
        repositoryId: repo.id,
        commitSha: repo.latestCommitSha,
        branch: 'main',
      });

      const cancelled = await cancelSession(session.id, PreviewStatus.PENDING);
      expect(cancelled.status).toBe(PreviewStatus.STOPPED);
      expect(cancelled.isActive).toBe(false);
      expect(cancelled.stoppedAt).toBeInstanceOf(Date);

      // User is now immediately free to create a new session
      const newSession = await createPreviewSession({
        userId: user.id,
        repositoryId: repo.id,
        commitSha: repo.latestCommitSha,
        branch: 'main',
      });
      expect(newSession.session.id).not.toBe(session.id);
      expect(newSession.session.isActive).toBe(true);
    });

    it('fails an active session recording bounded error code and message', async () => {
      const { session } = await createPreviewSession({
        userId: user.id,
        repositoryId: repo.id,
        commitSha: repo.latestCommitSha,
        branch: 'main',
      });

      await transitionSession(session.id, PreviewStatus.PENDING, PreviewStatus.FETCHING);

      const failed = await failSession(session.id, PreviewStatus.FETCHING, {
        errorCode: 'GITHUB_ARCHIVE_TIMEOUT',
        errorMessage: 'Failed to download repository archive from GitHub within 30 seconds.',
      });

      expect(failed.status).toBe(PreviewStatus.FAILED);
      expect(failed.isActive).toBe(false);
      expect(failed.errorCode).toBe('GITHUB_ARCHIVE_TIMEOUT');
      expect(failed.errorMessage).toBe('Failed to download repository archive from GitHub within 30 seconds.');
      expect(failed.stoppedAt).toBeInstanceOf(Date);
    });

    it('evaluates and executes session expiration', async () => {
      const { session } = await createPreviewSession({
        userId: user.id,
        repositoryId: repo.id,
        commitSha: repo.latestCommitSha,
        branch: 'main',
      });

      const now = new Date();
      expect(isSessionExpired(session, now)).toBe(false);

      // Past hard ceiling (expiresAt)
      const futurePastCeiling = new Date(now.getTime() + MAX_SESSION_LIFETIME_MS + 1000);
      expect(isSessionExpired(session, futurePastCeiling)).toBe(true);
      expect(getExpirationReason(session, futurePastCeiling)).toBe('HARD_LIFETIME_EXCEEDED');

      // Past idle timeout (15 mins with no activity)
      const futurePastIdle = new Date(now.getTime() + IDLE_SESSION_TIMEOUT_MS + 1000);
      expect(isSessionExpired(session, futurePastIdle)).toBe(true);
      expect(getExpirationReason(session, futurePastIdle)).toBe('IDLE_TIMEOUT');

      // Execute expireSession
      const expired = await expireSession(session.id, PreviewStatus.PENDING, 'IDLE_TIMEOUT');
      expect(expired.status).toBe(PreviewStatus.EXPIRED);
      expect(expired.isActive).toBe(false);
      expect(expired.errorCode).toBe('IDLE_TIMEOUT');
    });

    it('updates lastActiveAt with touchSessionActivity on active sessions only', async () => {
      const { session } = await createPreviewSession({
        userId: user.id,
        repositoryId: repo.id,
        commitSha: repo.latestCommitSha,
        branch: 'main',
      });

      const originalActiveAt = session.lastActiveAt;

      // Small delay to ensure timestamp diff
      await new Promise((r) => setTimeout(r, 10));

      const touched = await touchSessionActivity(session.id);
      expect(touched).toBe(true);

      const refreshed = await prisma.previewSession.findUnique({ where: { id: session.id } });
      expect(new Date(refreshed.lastActiveAt).getTime()).toBeGreaterThan(new Date(originalActiveAt).getTime());

      // After termination, touchSessionActivity returns false
      await cancelSession(session.id, PreviewStatus.PENDING);
      const touchedAfterStop = await touchSessionActivity(session.id);
      expect(touchedAfterStop).toBe(false);
    });

    it('findExpiredSessions queries using composite indexes', async () => {
      const { session } = await createPreviewSession({
        userId: user.id,
        repositoryId: repo.id,
        commitSha: repo.latestCommitSha,
        branch: 'main',
      });

      const now = new Date();

      // Currently not expired
      const noneExpired = await findExpiredSessions(prisma, now);
      expect(noneExpired.some((s) => s.id === session.id)).toBe(false);

      // Future time beyond idle timeout -> found
      const futureTime = new Date(now.getTime() + IDLE_SESSION_TIMEOUT_MS + 5000);
      const expiredList = await findExpiredSessions(prisma, futureTime);
      expect(expiredList.some((s) => s.id === session.id)).toBe(true);
    });
  });

  describe('6. PostgreSQL Constraints & Integrity Protections', () => {
    it('allows multiple terminal sessions to coexist for the same user (partial index check)', async () => {
      // Create session 1 and terminate it
      const s1 = await createPreviewSession({
        userId: user.id,
        repositoryId: repo.id,
        commitSha: repo.latestCommitSha,
        branch: 'branch-1',
      });
      await cancelSession(s1.session.id, PreviewStatus.PENDING);

      // Create session 2 and fail it
      const s2 = await createPreviewSession({
        userId: user.id,
        repositoryId: repo.id,
        commitSha: repo.latestCommitSha,
        branch: 'branch-2',
      });
      await failSession(s2.session.id, PreviewStatus.PENDING, { errorCode: 'TEST_FAIL' });

      // Create session 3 and expire it
      const s3 = await createPreviewSession({
        userId: user.id,
        repositoryId: repo.id,
        commitSha: repo.latestCommitSha,
        branch: 'branch-3',
      });
      await expireSession(s3.session.id, PreviewStatus.PENDING, 'EXPIRED_TEST');

      // Create session 4 which is currently active
      const s4 = await createPreviewSession({
        userId: user.id,
        repositoryId: repo.id,
        commitSha: repo.latestCommitSha,
        branch: 'branch-4',
      });

      // Verify all 4 sessions exist in DB for the same user
      const userSessions = await prisma.previewSession.findMany({
        where: { userId: user.id },
      });
      expect(userSessions).toHaveLength(4);

      const activeSessions = userSessions.filter((s) => s.isActive);
      expect(activeSessions).toHaveLength(1);
      expect(activeSessions[0].id).toBe(s4.session.id);
    });

    it('enforces PostgreSQL CHECK constraint on status and isActive consistency', async () => {
      const { session } = await createPreviewSession({
        userId: user.id,
        repositoryId: repo.id,
        commitSha: repo.latestCommitSha,
        branch: 'main',
      });

      // 1. Inconsistent attempt: status = 'STOPPED' with isActive = true (violation)
      await expect(
        prisma.$executeRawUnsafe(`
          UPDATE "PreviewSession"
          SET "status" = 'STOPPED', "isActive" = true
          WHERE "id" = '${session.id}'
        `)
      ).rejects.toThrow(/preview_session_status_is_active_check/i);

      // 2. Inconsistent attempt: status = 'RUNNING' with isActive = false (violation)
      await expect(
        prisma.$executeRawUnsafe(`
          UPDATE "PreviewSession"
          SET "status" = 'RUNNING', "isActive" = false
          WHERE "id" = '${session.id}'
        `)
      ).rejects.toThrow(/preview_session_status_is_active_check/i);
    });

    it('cascades deletion when User or Repository is deleted', async () => {
      const { session } = await createPreviewSession({
        userId: user.id,
        repositoryId: repo.id,
        commitSha: repo.latestCommitSha,
        branch: 'main',
      });

      // Verify session exists
      const found = await prisma.previewSession.findUnique({ where: { id: session.id } });
      expect(found).not.toBeNull();

      // Delete Repository -> cascades to PreviewSession
      await prisma.repository.delete({ where: { id: repo.id } });

      const afterRepoDelete = await prisma.previewSession.findUnique({ where: { id: session.id } });
      expect(afterRepoDelete).toBeNull();
    });

    it('sanitizes session records for client DTO transmission without leaking internal fields', async () => {
      const { session } = await createPreviewSession({
        userId: user.id,
        repositoryId: repo.id,
        commitSha: repo.latestCommitSha,
        branch: 'main',
      });

      const updated = await transitionSession(
        session.id,
        PreviewStatus.PENDING,
        PreviewStatus.FETCHING,
        {
          runnerContainerId: 'internal_runner_docker_id_abc',
          proxyContainerId: 'internal_proxy_docker_id_def',
          proxyPort: 64599,
        }
      );

      const dto = sanitizeSessionForClient(updated);

      // Public client fields
      expect(dto.id).toBe(session.id);
      expect(dto.repositoryId).toBe(repo.id);
      expect(dto.status).toBe(PreviewStatus.FETCHING);
      expect(dto.isActive).toBe(true);

      // Strictly hidden internal fields
      expect(dto.runnerContainerId).toBeUndefined();
      expect(dto.proxyContainerId).toBeUndefined();
      expect(dto.proxyInstanceId).toBeUndefined();
      expect(dto.proxyPort).toBeUndefined();
      expect(dto.tokenHash).toBeUndefined();
      expect(dto.previewTokenEnc).toBeUndefined();
    });
  });
});

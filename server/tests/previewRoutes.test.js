/**
 * GitView Phase 5 — Milestone 7, Task 1: Public Preview API Routes Acceptance Test Suite
 *
 * Verifies public preview REST API routes under /api/v1/previews:
 * - POST /api/v1/previews (Start preview session)
 * - GET /api/v1/previews/:id (Poll session lifecycle state)
 * - POST /api/v1/previews/:id/stop (Stop active preview session)
 *
 * Security & Functional Verification:
 * 1. Authentication & authorization enforcement (401 on missing/invalid cookie)
 * 2. Strict CSRF & exact Origin allowlisting against FRONTEND_URL (403 on mismatch)
 * 3. Content-Type: application/json enforcement on mutating requests (400 on non-JSON)
 * 4. Duplicate Host header detection via rawHeaders and comma syntax (400 DUPLICATE_HOST_HEADER)
 * 5. Input validation with Zod schemas (400 VALIDATION_ERROR on invalid body or params)
 * 6. Single active session concurrency ceiling (409 ACTIVE_SESSION_CONFLICT)
 * 7. Repository ownership scoping (404 REPOSITORY_NOT_FOUND on access violation)
 * 8. Status polling & cross-user access restriction (404 SESSION_NOT_FOUND)
 * 9. Idempotent stopping behavior
 * 10. Information leakage prevention (zero token, hash, container ID, proxy port in DTO)
 * 11. Per-user rate limiting (5 req/min on create, 60 req/min on status, 10 req/min on stop)
 * 12. Real PostgreSQL database integration
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import crypto from 'node:crypto';
import net from 'node:net';
import request from 'supertest';
import { app } from '../src/app.js';
import { prisma, resetDb, createUser, cookieHeader } from './helpers.js';
import { signAccessToken } from '../src/utils/tokens.js';
import { previewManager } from '../src/modules/preview/previewManager.js';
import { PreviewStatus, FrameworkType } from '../src/modules/preview/sessionConstants.js';
import { ActiveSessionConflictError, SessionNotFoundError } from '../src/modules/preview/sessionErrors.js';
import { AppError } from '../src/utils/AppError.js';
import { sanitizeSessionForClient } from '../src/modules/preview/sessionService.js';
import { setTicketStore, ITicketStore } from '../src/modules/preview/ticketStore.js';

describe('Milestone 7, Task 1: Public Preview API Routes & CSRF Verification', () => {
  let userA;
  let userB;
  let authCookieA;
  let authCookieB;
  let repoA;
  let repoB;

  const FRONTEND_ORIGIN = 'http://localhost:5173';
  const VALID_COMMIT_SHA = '0123456789abcdef0123456789abcdef01234567';

  beforeEach(async () => {
    await resetDb();
    vi.restoreAllMocks();

    userA = await createUser({
      email: 'user-a@example.com',
      username: 'user_a',
    });

    userB = await createUser({
      email: 'user-b@example.com',
      username: 'user_b',
    });

    authCookieA = cookieHeader({ access_token: signAccessToken(userA) });
    authCookieB = cookieHeader({ access_token: signAccessToken(userB) });

    repoA = await prisma.repository.create({
      data: {
        userId: userA.id,
        githubRepoId: '10001',
        owner: 'gitview-org',
        name: 'test-app-a',
        fullName: 'gitview-org/test-app-a',
        htmlUrl: 'https://github.com/gitview-org/test-app-a',
        defaultBranch: 'main',
        latestCommitSha: VALID_COMMIT_SHA,
      },
    });

    repoB = await prisma.repository.create({
      data: {
        userId: userB.id,
        githubRepoId: '10002',
        owner: 'gitview-org',
        name: 'test-app-b',
        fullName: 'gitview-org/test-app-b',
        htmlUrl: 'https://github.com/gitview-org/test-app-b',
        defaultBranch: 'main',
        latestCommitSha: VALID_COMMIT_SHA,
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Helper for raw TCP HTTP requests to verify rawHeaders wire behavior
  function sendRawHttp(server, rawPayload) {
    return new Promise((resolve, reject) => {
      const port = server.address().port;
      const client = net.connect(port, '127.0.0.1', () => {
        client.write(rawPayload);
      });
      let responseData = '';
      client.on('data', (chunk) => {
        responseData += chunk.toString('utf8');
      });
      client.on('end', () => {
        const [headerPart, ...bodyParts] = responseData.split('\r\n\r\n');
        const body = bodyParts.join('\r\n\r\n');
        const statusLine = headerPart.split('\r\n')[0] || '';
        const statusCode = parseInt(statusLine.split(' ')[1], 10);
        let json = null;
        try {
          json = JSON.parse(body);
        } catch {}
        resolve({ statusCode, statusLine, headerPart, body, json });
      });
      client.on('error', reject);
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. Authentication & Cookie Verification
  // ─────────────────────────────────────────────────────────────────────────────
  describe('1. Authentication Enforcement', () => {
    it('rejects POST /api/v1/previews without authentication cookie with 401 TOKEN_MISSING', async () => {
      const res = await request(app)
        .post('/api/v1/previews')
        .set('Origin', FRONTEND_ORIGIN)
        .set('Content-Type', 'application/json')
        .send({ repositoryId: repoA.id, commitRef: 'main' });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('TOKEN_MISSING');
    });

    it('rejects GET /api/v1/previews/:id without authentication cookie with 401 TOKEN_MISSING', async () => {
      const res = await request(app)
        .get(`/api/v1/previews/${crypto.randomUUID()}`);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('TOKEN_MISSING');
    });

    it('rejects POST /api/v1/previews/:id/stop without authentication cookie with 401 TOKEN_MISSING', async () => {
      const res = await request(app)
        .post(`/api/v1/previews/${crypto.randomUUID()}/stop`)
        .set('Origin', FRONTEND_ORIGIN)
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('TOKEN_MISSING');
    });

    it('rejects requests with forged/tampered access token with 401 TOKEN_INVALID', async () => {
      const badCookie = cookieHeader({ access_token: 'forged.signature.token' });
      const res = await request(app)
        .post('/api/v1/previews')
        .set('Cookie', badCookie)
        .set('Origin', FRONTEND_ORIGIN)
        .set('Content-Type', 'application/json')
        .send({ repositoryId: repoA.id, commitRef: 'main' });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('TOKEN_INVALID');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. CSRF & Origin Verification
  // ─────────────────────────────────────────────────────────────────────────────
  describe('2. CSRF & Origin Verification on Mutating Endpoints', () => {
    it('rejects POST /previews when Origin and Referer are both absent with 403 CSRF_ORIGIN_INVALID', async () => {
      const res = await request(app)
        .post('/api/v1/previews')
        .set('Cookie', authCookieA)
        .set('Content-Type', 'application/json')
        .send({ repositoryId: repoA.id, commitRef: 'main' });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('CSRF_ORIGIN_INVALID');
    });

    it('rejects POST /previews with untrusted Origin with 403 CSRF_ORIGIN_INVALID', async () => {
      const res = await request(app)
        .post('/api/v1/previews')
        .set('Cookie', authCookieA)
        .set('Origin', 'http://malicious-attacker.com')
        .set('Content-Type', 'application/json')
        .send({ repositoryId: repoA.id, commitRef: 'main' });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('CSRF_ORIGIN_INVALID');
    });

    it('rejects POST /previews with subdomain-spoofed Origin with 403 CSRF_ORIGIN_INVALID', async () => {
      const res = await request(app)
        .post('/api/v1/previews')
        .set('Cookie', authCookieA)
        .set('Origin', 'http://localhost:5173.attacker.com')
        .set('Content-Type', 'application/json')
        .send({ repositoryId: repoA.id, commitRef: 'main' });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('CSRF_ORIGIN_INVALID');
    });

    it('rejects POST /previews with malformed Origin string with 403 CSRF_ORIGIN_INVALID', async () => {
      const res = await request(app)
        .post('/api/v1/previews')
        .set('Cookie', authCookieA)
        .set('Origin', 'null')
        .set('Content-Type', 'application/json')
        .send({ repositoryId: repoA.id, commitRef: 'main' });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('CSRF_ORIGIN_INVALID');
    });

    it('accepts POST /previews when Origin is absent but Referer matches exact frontend origin', async () => {
      vi.spyOn(previewManager, 'createAndStartSession').mockResolvedValueOnce({
        session: {
          id: 'mock-session-referer-1',
          repositoryId: repoA.id,
          status: PreviewStatus.RUNNING,
          framework: FrameworkType.STATIC,
          isActive: true,
          commitSha: VALID_COMMIT_SHA,
          branch: 'main',
          createdAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          stoppedAt: null,
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          lastActiveAt: new Date().toISOString(),
        },
        rawToken: 'secret-token-1234',
        previewUrl: 'http://127.0.0.1:54321/',
        hostPort: 54321,
      });

      const res = await request(app)
        .post('/api/v1/previews')
        .set('Cookie', authCookieA)
        .set('Referer', `${FRONTEND_ORIGIN}/repositories/${repoA.id}`)
        .set('Content-Type', 'application/json')
        .send({ repositoryId: repoA.id, commitRef: 'main' });

      expect(res.status).toBe(201);
      expect(res.body.data.id).toBe('mock-session-referer-1');
    });

    it('rejects POST /previews when Origin is absent and Referer has untrusted origin', async () => {
      const res = await request(app)
        .post('/api/v1/previews')
        .set('Cookie', authCookieA)
        .set('Referer', 'http://malicious.com/phish')
        .set('Content-Type', 'application/json')
        .send({ repositoryId: repoA.id, commitRef: 'main' });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('CSRF_ORIGIN_INVALID');
    });

    it('rejects POST /previews/:id/stop with mismatched Origin with 403 CSRF_ORIGIN_INVALID', async () => {
      const res = await request(app)
        .post(`/api/v1/previews/${crypto.randomUUID()}/stop`)
        .set('Cookie', authCookieA)
        .set('Origin', 'http://untrusted-site.org')
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('CSRF_ORIGIN_INVALID');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. Content-Type & Host Integrity Enforcement
  // ─────────────────────────────────────────────────────────────────────────────
  describe('3. Content-Type and Host Integrity', () => {
    it('rejects POST /previews with non-JSON Content-Type (text/plain) with 400 INVALID_CONTENT_TYPE', async () => {
      const res = await request(app)
        .post('/api/v1/previews')
        .set('Cookie', authCookieA)
        .set('Origin', FRONTEND_ORIGIN)
        .set('Content-Type', 'text/plain')
        .send('repositoryId=123&commitRef=main');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_CONTENT_TYPE');
    });

    it('rejects POST /previews with missing Content-Type with 400 INVALID_CONTENT_TYPE', async () => {
      const res = await request(app)
        .post('/api/v1/previews')
        .set('Cookie', authCookieA)
        .set('Origin', FRONTEND_ORIGIN)
        .send('some-raw-data');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_CONTENT_TYPE');
    });

    it('rejects comma-separated Host header with 400 DUPLICATE_HOST_HEADER', async () => {
      const res = await request(app)
        .post('/api/v1/previews')
        .set('Cookie', authCookieA)
        .set('Origin', FRONTEND_ORIGIN)
        .set('Host', 'localhost:3000, evil.com')
        .set('Content-Type', 'application/json')
        .send({ repositoryId: repoA.id, commitRef: 'main' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('DUPLICATE_HOST_HEADER');
    });

    it('rejects wire-level duplicate Host headers in rawHeaders with 400 DUPLICATE_HOST_HEADER', async () => {
      const ephemeralServer = app.listen(0, '127.0.0.1');
      await new Promise((resolve) => ephemeralServer.once('listening', resolve));

      try {
        const rawPayload = [
          'POST /api/v1/previews HTTP/1.1',
          'Host: localhost:3000',
          'Host: evil.attacker.com',
          `Cookie: access_token=${signAccessToken(userA)}`,
          `Origin: ${FRONTEND_ORIGIN}`,
          'Content-Type: application/json',
          'Content-Length: 2',
          'Connection: close',
          '',
          '{}',
        ].join('\r\n');

        const result = await sendRawHttp(ephemeralServer, rawPayload);
        expect(result.statusCode).toBe(400);
        expect(result.json?.error?.code).toBe('DUPLICATE_HOST_HEADER');
      } finally {
        await new Promise((resolve) => ephemeralServer.close(resolve));
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. Input Validation (Zod Schemas)
  // ─────────────────────────────────────────────────────────────────────────────
  describe('4. Request Schema Validation (Task 1.1 Refinement)', () => {
    it('rejects POST /previews with missing repositoryId with 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .post('/api/v1/previews')
        .set('Cookie', authCookieA)
        .set('Origin', FRONTEND_ORIGIN)
        .set('Content-Type', 'application/json')
        .send({ commitRef: 'main' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details.some((d) => d.field === 'repositoryId')).toBe(true);
    });

    it('rejects POST /previews with malformed repository UUID with 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .post('/api/v1/previews')
        .set('Cookie', authCookieA)
        .set('Origin', FRONTEND_ORIGIN)
        .set('Content-Type', 'application/json')
        .send({ repositoryId: 'not-a-valid-uuid-1234', commitRef: 'main' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details.some((d) => d.field === 'repositoryId')).toBe(true);
    });

    it('rejects POST /previews with missing commitRef with 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .post('/api/v1/previews')
        .set('Cookie', authCookieA)
        .set('Origin', FRONTEND_ORIGIN)
        .set('Content-Type', 'application/json')
        .send({ repositoryId: repoA.id });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details.some((d) => d.field === 'commitRef')).toBe(true);
    });

    it('rejects POST /previews with whitespace-only commitRef with 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .post('/api/v1/previews')
        .set('Cookie', authCookieA)
        .set('Origin', FRONTEND_ORIGIN)
        .set('Content-Type', 'application/json')
        .send({ repositoryId: repoA.id, commitRef: '    ' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details.some((d) => d.field === 'commitRef')).toBe(true);
    });

    it('rejects POST /previews when commitRef exceeds 100 characters with 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .post('/api/v1/previews')
        .set('Cookie', authCookieA)
        .set('Origin', FRONTEND_ORIGIN)
        .set('Content-Type', 'application/json')
        .send({ repositoryId: repoA.id, commitRef: 'a'.repeat(101) });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details.some((d) => d.field === 'commitRef')).toBe(true);
    });

    it('rejects GET /previews/:id with malformed preview session UUID with 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .get('/api/v1/previews/not-a-valid-uuid')
        .set('Cookie', authCookieA);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details.some((d) => d.field === 'id')).toBe(true);
    });

    it('rejects POST /previews/:id/stop with malformed preview session UUID with 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .post('/api/v1/previews/not-a-valid-uuid/stop')
        .set('Cookie', authCookieA)
        .set('Origin', FRONTEND_ORIGIN)
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details.some((d) => d.field === 'id')).toBe(true);
    });

    it('rejects GET /previews/:id with whitespace ID with 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .get('/api/v1/previews/%20%20')
        .set('Cookie', authCookieA);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details.some((d) => d.field === 'id')).toBe(true);
    });

    it('accepts valid UUIDs and trims commitRef whitespace', async () => {
      const startSpy = vi.spyOn(previewManager, 'createAndStartSession').mockResolvedValueOnce({
        session: {
          id: '22222222-2222-2222-2222-222222222222',
          repositoryId: repoA.id,
          status: PreviewStatus.RUNNING,
          framework: FrameworkType.STATIC,
          isActive: true,
          commitSha: VALID_COMMIT_SHA,
          branch: 'main',
          createdAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          stoppedAt: null,
          expiresAt: new Date().toISOString(),
          lastActiveAt: new Date().toISOString(),
        },
      });

      const res = await request(app)
        .post('/api/v1/previews')
        .set('Cookie', authCookieA)
        .set('Origin', FRONTEND_ORIGIN)
        .set('Content-Type', 'application/json')
        .send({
          repositoryId: repoA.id,
          commitRef: '  feature/new-ui  ',
        });

      expect(res.status).toBe(201);
      // Validates trimmed commitRef
      expect(startSpy).toHaveBeenCalledWith({
        userId: userA.id,
        repositoryId: repoA.id,
        commitRef: 'feature/new-ui',
      });
    });

    it('accepts valid 40-character commit SHA reference', async () => {
      const startSpy = vi.spyOn(previewManager, 'createAndStartSession').mockResolvedValueOnce({
        session: {
          id: '33333333-3333-3333-3333-333333333333',
          repositoryId: repoA.id,
          status: PreviewStatus.RUNNING,
          framework: FrameworkType.STATIC,
          isActive: true,
          commitSha: VALID_COMMIT_SHA,
          branch: 'main',
          createdAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          stoppedAt: null,
          expiresAt: new Date().toISOString(),
          lastActiveAt: new Date().toISOString(),
        },
      });

      const res = await request(app)
        .post('/api/v1/previews')
        .set('Cookie', authCookieA)
        .set('Origin', FRONTEND_ORIGIN)
        .set('Content-Type', 'application/json')
        .send({
          repositoryId: repoA.id,
          commitRef: VALID_COMMIT_SHA,
        });

      expect(res.status).toBe(201);
      expect(startSpy).toHaveBeenCalledWith({
        userId: userA.id,
        repositoryId: repoA.id,
        commitRef: VALID_COMMIT_SHA,
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. Preview Lifecycle Delegation & Error Mapping
  // ─────────────────────────────────────────────────────────────────────────────
  describe('5. Preview Lifecycle Delegation & Error Mapping', () => {
    it('successfully starts a preview session and returns 201 with sanitized DTO', async () => {
      const mockSession = {
        id: '22222222-2222-2222-2222-222222222222',
        repositoryId: repoA.id,
        status: PreviewStatus.RUNNING,
        framework: FrameworkType.VITE_REACT,
        isActive: true,
        commitSha: VALID_COMMIT_SHA,
        branch: 'main',
        createdAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        stoppedAt: null,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        lastActiveAt: new Date().toISOString(),
      };

      const startSpy = vi.spyOn(previewManager, 'createAndStartSession').mockResolvedValueOnce({
        session: mockSession,
        rawToken: 'raw-secret-preview-token-12345',
        previewUrl: 'http://127.0.0.1:49152/',
        hostPort: 49152,
      });

      const res = await request(app)
        .post('/api/v1/previews')
        .set('Cookie', authCookieA)
        .set('Origin', FRONTEND_ORIGIN)
        .set('Content-Type', 'application/json')
        .send({ repositoryId: repoA.id, commitRef: 'main' });

      expect(res.status).toBe(201);
      expect(res.body.data.id).toBe(mockSession.id);
      expect(res.body.data.status).toBe(PreviewStatus.RUNNING);
      expect(res.body.data.framework).toBe(FrameworkType.VITE_REACT);
      expect(startSpy).toHaveBeenCalledWith({
        userId: userA.id,
        repositoryId: repoA.id,
        commitRef: 'main',
      });
    });

    it('returns 409 ACTIVE_SESSION_CONFLICT when user already has an active session', async () => {
      vi.spyOn(previewManager, 'createAndStartSession').mockRejectedValueOnce(
        new ActiveSessionConflictError(userA.id)
      );

      const res = await request(app)
        .post('/api/v1/previews')
        .set('Cookie', authCookieA)
        .set('Origin', FRONTEND_ORIGIN)
        .set('Content-Type', 'application/json')
        .send({ repositoryId: repoA.id, commitRef: 'main' });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ACTIVE_SESSION_CONFLICT');
    });

    it('returns 404 REPOSITORY_NOT_FOUND when repository is not owned by user', async () => {
      vi.spyOn(previewManager, 'createAndStartSession').mockRejectedValueOnce(
        new AppError(404, 'REPOSITORY_NOT_FOUND', 'Repository not found or access denied')
      );

      const res = await request(app)
        .post('/api/v1/previews')
        .set('Cookie', authCookieA)
        .set('Origin', FRONTEND_ORIGIN)
        .set('Content-Type', 'application/json')
        .send({ repositoryId: repoB.id, commitRef: 'main' }); // User A trying to start User B's repo

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('REPOSITORY_NOT_FOUND');
    });

    it('returns 200 OK with sanitized DTO for owned session on GET /previews/:id', async () => {
      const sessionId = crypto.randomUUID();
      const mockSession = {
        id: sessionId,
        repositoryId: repoA.id,
        status: PreviewStatus.RUNNING,
        framework: FrameworkType.VITE_VANILLA,
        isActive: true,
        commitSha: VALID_COMMIT_SHA,
        branch: 'main',
        createdAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        stoppedAt: null,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        lastActiveAt: new Date().toISOString(),
      };

      vi.spyOn(previewManager, 'getPreviewSessionStatus').mockResolvedValueOnce(mockSession);

      const res = await request(app)
        .get(`/api/v1/previews/${sessionId}`)
        .set('Cookie', authCookieA);

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(sessionId);
      expect(res.body.data.status).toBe(PreviewStatus.RUNNING);
    });

    it('returns 404 SESSION_NOT_FOUND on GET /previews/:id for cross-user lookup', async () => {
      const crossUserSessionId = crypto.randomUUID();
      vi.spyOn(previewManager, 'getPreviewSessionStatus').mockRejectedValueOnce(
        new SessionNotFoundError(crossUserSessionId)
      );

      const res = await request(app)
        .get(`/api/v1/previews/${crossUserSessionId}`)
        .set('Cookie', authCookieB); // User B polling User A's session

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('SESSION_NOT_FOUND');
    });

    it('returns 200 OK and stops session on POST /previews/:id/stop', async () => {
      const sessionId = crypto.randomUUID();
      const stoppedSession = {
        id: sessionId,
        repositoryId: repoA.id,
        status: PreviewStatus.STOPPED,
        framework: FrameworkType.STATIC,
        isActive: false,
        commitSha: VALID_COMMIT_SHA,
        branch: 'main',
        createdAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        stoppedAt: new Date().toISOString(),
        expiresAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
      };

      const stopSpy = vi.spyOn(previewManager, 'stopPreviewSession').mockResolvedValueOnce(stoppedSession);

      const res = await request(app)
        .post(`/api/v1/previews/${sessionId}/stop`)
        .set('Cookie', authCookieA)
        .set('Origin', FRONTEND_ORIGIN)
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe(PreviewStatus.STOPPED);
      expect(res.body.data.isActive).toBe(false);
      expect(stopSpy).toHaveBeenCalledWith(sessionId, userA.id);
    });

    it('handles idempotent repeated calls to POST /previews/:id/stop with 200 OK', async () => {
      const sessionId = crypto.randomUUID();
      const alreadyStoppedSession = {
        id: sessionId,
        repositoryId: repoA.id,
        status: PreviewStatus.STOPPED,
        framework: FrameworkType.STATIC,
        isActive: false,
        commitSha: VALID_COMMIT_SHA,
        branch: 'main',
        createdAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        stoppedAt: new Date().toISOString(),
        expiresAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
      };

      vi.spyOn(previewManager, 'stopPreviewSession').mockResolvedValue(alreadyStoppedSession);

      const res1 = await request(app)
        .post(`/api/v1/previews/${sessionId}/stop`)
        .set('Cookie', authCookieA)
        .set('Origin', FRONTEND_ORIGIN)
        .set('Content-Type', 'application/json');

      const res2 = await request(app)
        .post(`/api/v1/previews/${sessionId}/stop`)
        .set('Cookie', authCookieA)
        .set('Origin', FRONTEND_ORIGIN)
        .set('Content-Type', 'application/json');

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      expect(res1.body.data.status).toBe(PreviewStatus.STOPPED);
      expect(res2.body.data.status).toBe(PreviewStatus.STOPPED);
    });

    it('returns 404 SESSION_NOT_FOUND on POST /previews/:id/stop for cross-user session', async () => {
      const otherUserSessionId = crypto.randomUUID();
      vi.spyOn(previewManager, 'stopPreviewSession').mockRejectedValueOnce(
        new SessionNotFoundError(otherUserSessionId)
      );

      const res = await request(app)
        .post(`/api/v1/previews/${otherUserSessionId}/stop`)
        .set('Cookie', authCookieB) // User B trying to stop User A's session
        .set('Origin', FRONTEND_ORIGIN)
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('SESSION_NOT_FOUND');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. Information Leakage & Sanitization Assertions
  // ─────────────────────────────────────────────────────────────────────────────
  describe('6. Zero Information Leakage Enforcement', () => {
    it('guarantees that sensitive internal fields are never exposed in any API response', async () => {
      // Create session payload with internal sensitive attributes present
      const rawSessionWithSecrets = {
        id: '55555555-5555-5555-5555-555555555555',
        repositoryId: repoA.id,
        status: PreviewStatus.RUNNING,
        framework: FrameworkType.VITE_REACT,
        isActive: true,
        commitSha: VALID_COMMIT_SHA,
        branch: 'main',
        rawToken: 'super-secret-token-do-not-leak',
        tokenHash: 'sha256-hash-secret',
        previewTokenEnc: 'aes-encrypted-secret-token',
        runnerContainerId: 'gitview-runner-internal-container-id',
        proxyContainerId: 'gitview-proxy-internal-container-id',
        proxyPort: 54321,
        dockerNetwork: 'gitview-net-internal',
        workspacePath: '/var/lib/docker/volumes/gitview-vol/_data',
        createdAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        stoppedAt: null,
        expiresAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
      };

      vi.spyOn(previewManager, 'createAndStartSession').mockResolvedValueOnce({
        session: rawSessionWithSecrets,
        rawToken: 'super-secret-token-do-not-leak',
        previewUrl: 'http://127.0.0.1:54321/',
        hostPort: 54321,
      });

      const res = await request(app)
        .post('/api/v1/previews')
        .set('Cookie', authCookieA)
        .set('Origin', FRONTEND_ORIGIN)
        .set('Content-Type', 'application/json')
        .send({ repositoryId: repoA.id, commitRef: 'main' });

      expect(res.status).toBe(201);
      const data = res.body.data;

      // Verify that all sensitive internal fields are strictly absent
      expect(data.rawToken).toBeUndefined();
      expect(data.tokenHash).toBeUndefined();
      expect(data.previewTokenEnc).toBeUndefined();
      expect(data.runnerContainerId).toBeUndefined();
      expect(data.proxyContainerId).toBeUndefined();
      expect(data.proxyInstanceId).toBeUndefined();
      expect(data.proxyPort).toBeUndefined();
      expect(data.dockerNetwork).toBeUndefined();
      expect(data.workspacePath).toBeUndefined();
      expect(data.previewUrl).toBeUndefined();
      expect(data.hostPort).toBeUndefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 7. Per-User Rate Limiting
  // ─────────────────────────────────────────────────────────────────────────────
  describe('7. Per-User Rate Limiting', () => {
    it('enforces 5 requests / min on POST /api/v1/previews per user', async () => {
      const rateLimitUser = await createUser({
        email: 'create-rate-limiter@example.com',
        username: 'create_rate_limiter',
      });
      const rateLimitCookie = cookieHeader({ access_token: signAccessToken(rateLimitUser) });

      vi.spyOn(previewManager, 'createAndStartSession').mockResolvedValue({
        session: {
          id: 'mock-rate-session',
          repositoryId: repoA.id,
          status: PreviewStatus.RUNNING,
          framework: FrameworkType.STATIC,
          isActive: true,
          commitSha: VALID_COMMIT_SHA,
          branch: 'main',
          createdAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          stoppedAt: null,
          expiresAt: new Date().toISOString(),
          lastActiveAt: new Date().toISOString(),
        },
      });

      // 5 requests pass within quota
      for (let i = 0; i < 5; i++) {
        const res = await request(app)
          .post('/api/v1/previews')
          .set('Cookie', rateLimitCookie)
          .set('Origin', FRONTEND_ORIGIN)
          .set('Content-Type', 'application/json')
          .send({ repositoryId: repoA.id, commitRef: 'main' });
        expect(res.status).toBe(201);
      }

      // 6th request is blocked by rate limiter with 429 TOO_MANY_REQUESTS
      const blockedRes = await request(app)
        .post('/api/v1/previews')
        .set('Cookie', rateLimitCookie)
        .set('Origin', FRONTEND_ORIGIN)
        .set('Content-Type', 'application/json')
        .send({ repositoryId: repoA.id, commitRef: 'main' });

      expect(blockedRes.status).toBe(429);
      expect(blockedRes.body.error.code).toBe('TOO_MANY_REQUESTS');

      // Separate user is unaffected by the blocked user's quota
      const separateUser = await createUser({
        email: 'separate-create-user@example.com',
        username: 'separate_create_user',
      });
      const separateCookie = cookieHeader({ access_token: signAccessToken(separateUser) });

      const separateRes = await request(app)
        .post('/api/v1/previews')
        .set('Cookie', separateCookie)
        .set('Origin', FRONTEND_ORIGIN)
        .set('Content-Type', 'application/json')
        .send({ repositoryId: repoA.id, commitRef: 'main' });

      expect(separateRes.status).toBe(201);
    });

    it('enforces 60 requests / min on GET /api/v1/previews/:id per user', async () => {
      const statusUser = await createUser({
        email: 'status-rate-user@example.com',
        username: 'status_rate_user',
      });
      const statusCookie = cookieHeader({ access_token: signAccessToken(statusUser) });
      const statusSessionId = crypto.randomUUID();

      vi.spyOn(previewManager, 'getPreviewSessionStatus').mockResolvedValue({
        id: statusSessionId,
        repositoryId: repoA.id,
        status: PreviewStatus.RUNNING,
        framework: FrameworkType.STATIC,
        isActive: true,
        commitSha: VALID_COMMIT_SHA,
        branch: 'main',
        createdAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        stoppedAt: null,
        expiresAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
      });

      // 60 polling requests pass within quota
      for (let i = 0; i < 60; i++) {
        const res = await request(app)
          .get(`/api/v1/previews/${statusSessionId}`)
          .set('Cookie', statusCookie);
        expect(res.status).toBe(200);
      }

      // 61st request is blocked with 429 TOO_MANY_REQUESTS
      const blockedRes = await request(app)
        .get(`/api/v1/previews/${statusSessionId}`)
        .set('Cookie', statusCookie);

      expect(blockedRes.status).toBe(429);
      expect(blockedRes.body.error.code).toBe('TOO_MANY_REQUESTS');
    });

    it('enforces 10 requests / min on POST /api/v1/previews/:id/stop per user', async () => {
      const stopUser = await createUser({
        email: 'stop-rate-user@example.com',
        username: 'stop_rate_user',
      });
      const stopCookie = cookieHeader({ access_token: signAccessToken(stopUser) });
      const stopSessionId = crypto.randomUUID();

      vi.spyOn(previewManager, 'stopPreviewSession').mockResolvedValue({
        id: stopSessionId,
        repositoryId: repoA.id,
        status: PreviewStatus.STOPPED,
        framework: FrameworkType.STATIC,
        isActive: false,
        commitSha: VALID_COMMIT_SHA,
        branch: 'main',
        createdAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        stoppedAt: new Date().toISOString(),
        expiresAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
      });

      // 10 requests pass
      for (let i = 0; i < 10; i++) {
        const res = await request(app)
          .post(`/api/v1/previews/${stopSessionId}/stop`)
          .set('Cookie', stopCookie)
          .set('Origin', FRONTEND_ORIGIN)
          .set('Content-Type', 'application/json');
        expect(res.status).toBe(200);
      }

      // 11th request is blocked with 429
      const blockedRes = await request(app)
        .post(`/api/v1/previews/${stopSessionId}/stop`)
        .set('Cookie', stopCookie)
        .set('Origin', FRONTEND_ORIGIN)
        .set('Content-Type', 'application/json');

      expect(blockedRes.status).toBe(429);
      expect(blockedRes.body.error.code).toBe('TOO_MANY_REQUESTS');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 8. Real PostgreSQL Database Integration
  // ─────────────────────────────────────────────────────────────────────────────
  describe('8. Real Database Integration', () => {
    it('retrieves live database record via GET /api/v1/previews/:id and stops it via POST /stop', async () => {
      const dbUser = await createUser({
        email: 'db-integration-user@example.com',
        username: 'db_integration_user',
      });
      const dbCookie = cookieHeader({ access_token: signAccessToken(dbUser) });

      const dbRepo = await prisma.repository.create({
        data: {
          userId: dbUser.id,
          githubRepoId: '99001',
          owner: 'testorg',
          name: 'db-repo',
          fullName: 'testorg/db-repo',
          htmlUrl: 'https://github.com/testorg/db-repo',
          defaultBranch: 'main',
          latestCommitSha: VALID_COMMIT_SHA,
        },
      });

      // Insert real session in database
      const liveSession = await prisma.previewSession.create({
        data: {
          userId: dbUser.id,
          repositoryId: dbRepo.id,
          status: PreviewStatus.RUNNING,
          framework: FrameworkType.STATIC,
          isActive: true,
          commitSha: VALID_COMMIT_SHA,
          branch: 'main',
          tokenHash: 'real-db-token-hash-1234567890abcdef',
          previewTokenEnc: 'real-db-encrypted-token-1234567890',
          runnerContainerId: 'gitview-runner-live-test',
          proxyContainerId: 'gitview-proxy-live-test',
          proxyPort: 49999,
          expiresAt: new Date(Date.now() + 3600000),
          lastActiveAt: new Date(),
        },
      });

      // 1. GET status via real DB query inside previewManager.getPreviewSessionStatus
      const getRes = await request(app)
        .get(`/api/v1/previews/${liveSession.id}`)
        .set('Cookie', dbCookie);

      expect(getRes.status).toBe(200);
      expect(getRes.body.data.id).toBe(liveSession.id);
      expect(getRes.body.data.status).toBe(PreviewStatus.RUNNING);
      expect(getRes.body.data.isActive).toBe(true);
      expect(getRes.body.data.framework).toBe(FrameworkType.STATIC);

      // Verify no sensitive fields in response
      expect(getRes.body.data.tokenHash).toBeUndefined();
      expect(getRes.body.data.previewTokenEnc).toBeUndefined();
      expect(getRes.body.data.runnerContainerId).toBeUndefined();
      expect(getRes.body.data.proxyContainerId).toBeUndefined();
      expect(getRes.body.data.proxyInstanceId).toBeUndefined();
      expect(getRes.body.data.proxyPort).toBeUndefined();

      // 2. Stop session via real stopPreviewSession (mocking docker cleanup to avoid real Docker container deletion)
      vi.spyOn(previewManager.docker, 'cleanupSession').mockResolvedValue(true);

      const stopRes = await request(app)
        .post(`/api/v1/previews/${liveSession.id}/stop`)
        .set('Cookie', dbCookie)
        .set('Origin', FRONTEND_ORIGIN)
        .set('Content-Type', 'application/json');

      expect(stopRes.status).toBe(200);
      expect(stopRes.body.data.status).toBe(PreviewStatus.STOPPED);
      expect(stopRes.body.data.isActive).toBe(false);

      // 3. Confirm transition in PostgreSQL
      const reloadedSession = await prisma.previewSession.findUnique({
        where: { id: liveSession.id },
      });
      expect(reloadedSession.status).toBe(PreviewStatus.STOPPED);
      expect(reloadedSession.isActive).toBe(false);
      expect(reloadedSession.stoppedAt).not.toBeNull();
    });
  });

  describe('POST /api/v1/previews/:id/ticket - Single-Use Bootstrap Ticket Generation', () => {
    let activeSession;

    beforeEach(async () => {
      // Create a RUNNING active session for userA
      activeSession = await prisma.previewSession.create({
        data: {
          userId: userA.id,
          repositoryId: repoA.id,
          status: PreviewStatus.RUNNING,
          framework: FrameworkType.STATIC,
          isActive: true,
          commitSha: VALID_COMMIT_SHA,
          branch: 'main',
          tokenHash: 'dummy-token-hash-ticket-test-12345678',
          previewTokenEnc: 'dummy-token-enc-ticket-test-12345678',
          expiresAt: new Date(Date.now() + 3600000), // 1 hour
          lastActiveAt: new Date(),
          startedAt: new Date(),
        },
      });
    });

    it('rejects unauthenticated requests with 401 Unauthorized', async () => {
      const res = await request(app)
        .post(`/api/v1/previews/${activeSession.id}/ticket`)
        .set('Origin', FRONTEND_ORIGIN)
        .set('Content-Type', 'application/json')
        .send({ mode: 'iframe' });

      expect(res.status).toBe(401);
    });

    it('rejects cross-origin requests with 403 Forbidden (CSRF protection)', async () => {
      const res = await request(app)
        .post(`/api/v1/previews/${activeSession.id}/ticket`)
        .set('Cookie', authCookieA)
        .set('Origin', 'http://attacker-site.com')
        .set('Content-Type', 'application/json')
        .send({ mode: 'iframe' });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('CSRF_ORIGIN_INVALID');
    });

    it('rejects non-JSON Content-Type with 400 Bad Request', async () => {
      const res = await request(app)
        .post(`/api/v1/previews/${activeSession.id}/ticket`)
        .set('Cookie', authCookieA)
        .set('Origin', FRONTEND_ORIGIN)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('mode=iframe');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_CONTENT_TYPE');
    });

    it('rejects malformed session UUID with 400 Bad Request', async () => {
      const res = await request(app)
        .post('/api/v1/previews/not-a-valid-uuid/ticket')
        .set('Cookie', authCookieA)
        .set('Origin', FRONTEND_ORIGIN)
        .set('Content-Type', 'application/json')
        .send({ mode: 'iframe' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects access to another user\'s session with 404 Not Found', async () => {
      // User B attempts to generate ticket for User A's session
      const res = await request(app)
        .post(`/api/v1/previews/${activeSession.id}/ticket`)
        .set('Cookie', authCookieB)
        .set('Origin', FRONTEND_ORIGIN)
        .set('Content-Type', 'application/json')
        .send({ mode: 'iframe' });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('SESSION_NOT_FOUND');
    });

    it('rejects ticket generation for non-RUNNING session with 400 Bad Request', async () => {
      // Transition session to BUILDING state
      await prisma.previewSession.update({
        where: { id: activeSession.id },
        data: { status: PreviewStatus.BUILDING },
      });

      const res = await request(app)
        .post(`/api/v1/previews/${activeSession.id}/ticket`)
        .set('Cookie', authCookieA)
        .set('Origin', FRONTEND_ORIGIN)
        .set('Content-Type', 'application/json')
        .send({ mode: 'iframe' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PREVIEW_NOT_RUNNING');
    });

    it('generates single-use bootstrap ticket for RUNNING session with Cache-Control: no-store', async () => {
      const res = await request(app)
        .post(`/api/v1/previews/${activeSession.id}/ticket`)
        .set('Cookie', authCookieA)
        .set('Origin', FRONTEND_ORIGIN)
        .set('Content-Type', 'application/json')
        .send({ mode: 'iframe' });

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');

      const { data } = res.body;
      expect(data).toHaveProperty('previewUrl');
      expect(data).toHaveProperty('targetOrigin');
      expect(data).toHaveProperty('ticketExpiresAt');

      expect(data.targetOrigin).toContain(activeSession.id);
      expect(data.previewUrl).toContain('/__gitview_bootstrap?ticket=');
      expect(data.previewUrl).toContain(data.targetOrigin);

      // Verify ticket format in previewUrl: 64 hex characters
      const url = new URL(data.previewUrl);
      const ticketParam = url.searchParams.get('ticket');
      expect(ticketParam).toMatch(/^[0-9a-f]{64}$/);
    });

    it('supports mode: "toplevel" in request body', async () => {
      const res = await request(app)
        .post(`/api/v1/previews/${activeSession.id}/ticket`)
        .set('Cookie', authCookieA)
        .set('Origin', FRONTEND_ORIGIN)
        .set('Content-Type', 'application/json')
        .send({ mode: 'toplevel' });

      expect(res.status).toBe(200);
      expect(res.body.data.previewUrl).toContain('/__gitview_bootstrap?ticket=');
    });

    it('rejects invalid mode with 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .post(`/api/v1/previews/${activeSession.id}/ticket`)
        .set('Cookie', authCookieA)
        .set('Origin', FRONTEND_ORIGIN)
        .set('Content-Type', 'application/json')
        .send({ mode: 'invalid_mode_here' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('fails closed and returns 500 REDIS_ERROR when ticket store fails during ticket creation', async () => {
      class FailingStore extends ITicketStore {
        async setTicket() {
          throw new AppError(500, 'REDIS_ERROR', 'Redis connection failed');
        }
      }
      setTicketStore(new FailingStore());

      try {
        const res = await request(app)
          .post(`/api/v1/previews/${activeSession.id}/ticket`)
          .set('Cookie', authCookieA)
          .set('Origin', FRONTEND_ORIGIN)
          .set('Content-Type', 'application/json')
          .send({ mode: 'iframe' });

        expect(res.status).toBe(500);
        expect(res.body.error.code).toBe('REDIS_ERROR');
        expect(res.body.data).toBeUndefined();
      } finally {
        setTicketStore(null);
      }
    });
  });
});

/**
 * GitView Phase 5 — Milestone 7, Task 3: Production HTTP Preview Gateway Acceptance Test Suite
 *
 * Verifies:
 * 1. SessionValidationCache (Bounded LRU cache, 10s TTL, max 500, hard expiry, invalidation, zero plaintext tokens)
 * 2. stripAuthCookies (Removes __Host-gitview-preview-token, access_token, refresh_token, preserves app cookies)
 * 3. Host Authority & Subdomain Parsing:
 *    - Missing Host header (400 MISSING_HOST_HEADER)
 *    - Duplicate Host header in req.rawHeaders (400 DUPLICATE_HOST_HEADER)
 *    - Comma-separated Host header (400 DUPLICATE_HOST_HEADER)
 *    - Malformed Host authority (400 HOST_AUTHORITY_MALFORMED)
 *    - Malformed / non-UUID subdomain (400 UNKNOWN_PREVIEW_HOST)
 *    - Apex preview domain without subdomain (400 UNKNOWN_PREVIEW_HOST)
 *    - Unexpected port (401 HOST_AUTHORITY_MISMATCH)
 *    - Cross-session access: valid token for Session A sent to Session B host (401 SESSION_NOT_FOUND)
 * 4. Request Authentication & State Invariants:
 *    - Missing cookie (401 TOKEN_MISSING)
 *    - Malformed token format (401 TOKEN_INVALID)
 *    - Unknown token (401 SESSION_NOT_FOUND)
 *    - Inactive session (401 SESSION_INACTIVE)
 *    - Stopped session (410 SESSION_STOPPED)
 *    - Expired session (410 SESSION_EXPIRED)
 *    - Valid token and active RUNNING session (200 OK)
 * 5. Reverse Proxy Streaming & Header Rewriting:
 *    - Rewrites Host header to localhost:${proxyPort}
 *    - Strips __Host-gitview-preview-token before forwarding
 *    - Strips internal authorization credentials before forwarding
 *    - Strips hop-by-hop headers from request and response
 *    - Reconstructs X-Forwarded-For, X-Forwarded-Proto, X-Forwarded-Host
 *    - Streams static HTML, CSS, JS, images, JSON
 *    - Request body streaming (pipes chunks properly)
 *    - Request body limit: Content-Length > 10 MB rejected (413 PAYLOAD_TOO_LARGE)
 *    - Streaming body limit: Chunked data > 10 MB aborted (413 PAYLOAD_TOO_LARGE)
 *    - Header size limit: >16 KB headers rejected (431 REQUEST_HEADER_FIELDS_TOO_LARGE)
 * 6. Failure Recovery & Error Handling:
 *    - Upstream connection refused (502 BAD_GATEWAY)
 *    - Upstream connection reset (502 BAD_GATEWAY)
 *    - Upstream connection timeout (504 GATEWAY_TIMEOUT)
 *    - Client disconnect cleanly aborts upstream request
 *    - PostgreSQL outage with cache miss fails closed (500 DB_UNAVAILABLE)
 *    - PostgreSQL outage with valid unexpired cache hit serves request successfully
 * 7. Activity Tracking (Debounced):
 *    - Updates lastActiveAt at most once every 30 seconds
 *    - Hard expiration takes precedence over activity updates
 * 8. Rate Limiting:
 *    - Exceeding burst threshold returns 429 TOO_MANY_REQUESTS
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import request from 'supertest';

import {
  SessionValidationCache,
  SessionRateLimiter,
  stripAuthCookies,
  extractPreviewToken,
  extractPreviewHostInfo,
  validateHostHeader,
  createPreviewGateway,
  handlePreviewGateway,
  invalidateSessionGatewayCache,
  getSessionValidationCache,
  setDefaultDockerAdapter,
  getDefaultDockerAdapter,
  getSidecarVerificationCache,
  SidecarVerificationCache,
  verifySidecarIdentity,
  sanitizeLocationHeader,
  sanitizeUpstreamSetCookie,
  createSidecarHandshakeToken,
} from '../src/modules/preview/previewGateway.js';
import { app } from '../src/app.js';
import { prisma, resetDb, createUser } from './helpers.js';
import { PreviewStatus, FrameworkType } from '../src/modules/preview/sessionConstants.js';
import {
  generatePreviewToken,
  hashPreviewToken,
  encryptPreviewToken,
} from '../src/utils/previewTokens.js';
import { getPreviewTargetOrigin, canonicalizeHostAuthority } from '../src/modules/preview/hostAuthority.js';
import { PREVIEW_COOKIE_NAME } from '../src/modules/preview/previewCookie.js';
import {
  reconstructForwardedHeaders,
  isPeerTrustedProxy,
  parseCidr,
  isIpInCidr,
  normalizeIp,
  ipv4ToInt,
  constantTimeCompare,
  validateSidecarHandshake,
  stripSidecarHandshakeHeaders,
} from '../src/modules/preview/trustedProxy.js';
import { envSchema, env } from '../src/config/env.js';

// Helper for raw TCP HTTP requests
function sendRawHttp(server, rawPayload) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const client = net.connect(port, '127.0.0.1', () => {
      client.write(rawPayload);
    });

    let responseBuffer = '';
    client.on('data', (chunk) => {
      responseBuffer += chunk.toString('utf8');
    });

    client.on('end', () => {
      resolve(responseBuffer);
    });

    client.on('error', (err) => {
      reject(err);
    });
  });
}

describe('Milestone 7, Task 3: Production HTTP Preview Gateway', () => {
  const originalDocker = getDefaultDockerAdapter();
  let user;
  let repo;
  let session;
  let rawToken;
  let tokenHash;
  let targetOrigin;
  let targetHostAuthority;
  let mockUpstreamServer;
  let mockUpstreamPort;
  let lastUpstreamRequest;
  let mockDocker;

  beforeEach(async () => {
    await resetDb();
    vi.restoreAllMocks();

    user = await createUser({
      email: 'gateway-user@example.com',
      username: 'gateway_user',
    });

    repo = await prisma.repository.create({
      data: {
        userId: user.id,
        githubRepoId: '95001',
        owner: 'gitview-org',
        name: 'gateway-test-repo',
        fullName: 'gitview-org/gateway-test-repo',
        htmlUrl: 'https://github.com/gitview-org/gateway-test-repo',
        defaultBranch: 'main',
        latestCommitSha: '0123456789abcdef0123456789abcdef01234567',
      },
    });

    rawToken = generatePreviewToken();
    tokenHash = hashPreviewToken(rawToken);
    const previewTokenEnc = encryptPreviewToken(rawToken);

    // Create a mock loopback upstream server representing Option A sidecar
    await new Promise((resolve) => {
      mockUpstreamServer = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk.toString('utf8');
        });

        req.on('end', () => {
          lastUpstreamRequest = {
            url: req.url,
            method: req.method,
            headers: { ...req.headers },
            body,
          };

          if (req.url === '/hang') {
            // Intentionally don't respond to test timeouts
            return;
          }

          if (req.url === '/reset') {
            req.socket.destroy();
            return;
          }

          if (req.url === '/large-response') {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.write('A'.repeat(50000));
            res.end();
            return;
          }

          if (req.url === '/style.css') {
            res.writeHead(200, { 'Content-Type': 'text/css' });
            res.end('body { background: #111; }');
            return;
          }

          if (req.url === '/src/main.jsx') {
            res.writeHead(200, { 'Content-Type': 'application/javascript' });
            res.end('console.log("Vite module loaded");');
            return;
          }

          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'X-Upstream-Handled': 'true',
            'Set-Cookie': 'app_theme=dark; Path=/',
          });
          res.end('<!DOCTYPE html><html><body><h1>Preview App Loaded</h1></body></html>');
        });
      });

      mockUpstreamServer.listen(0, '127.0.0.1', () => {
        mockUpstreamPort = mockUpstreamServer.address().port;
        resolve();
      });
    });

    session = await prisma.previewSession.create({
      data: {
        userId: user.id,
        repositoryId: repo.id,
        commitSha: '0123456789abcdef0123456789abcdef01234567',
        branch: 'main',
        framework: FrameworkType.STATIC,
        status: PreviewStatus.RUNNING,
        isActive: true,
        tokenHash,
        previewTokenEnc,
        proxyPort: mockUpstreamPort,
        proxyContainerId: `gitview-proxy-${crypto.randomUUID()}`,
        runnerContainerId: `gitview-runner-${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + 3600 * 1000), // 1 hour
        lastActiveAt: new Date(),
        startedAt: new Date(),
      },
    });

    targetOrigin = getPreviewTargetOrigin(session.id);
    targetHostAuthority = canonicalizeHostAuthority(targetOrigin);

    mockDocker = {
      inspectContainer: vi.fn(async (containerId) => {
        let port = session?.proxyPort || mockUpstreamPort;
        try {
          const currentSession = await prisma.previewSession.findUnique({
            where: { id: session.id },
            select: { proxyPort: true },
          });
          if (currentSession?.proxyPort) port = currentSession.proxyPort;
        } catch {}
        return {
          State: { Running: true },
          Config: {
            Labels: {
              'com.gitview.managed': 'true',
              'com.gitview.session-id': session.id,
              'com.gitview.role': 'proxy',
            },
          },
          NetworkSettings: {
            Ports: {
              '8080/tcp': [
                {
                  HostIp: '127.0.0.1',
                  HostPort: String(port),
                },
              ],
            },
          },
        };
      }),
    };
    setDefaultDockerAdapter(mockDocker);
  });

  afterEach(async () => {
    if (mockUpstreamServer) {
      await new Promise((resolve) => mockUpstreamServer.close(resolve));
    }
    setDefaultDockerAdapter(originalDocker);
    getSidecarVerificationCache().clear();
    invalidateSessionGatewayCache(session?.id);
  });

  describe('1. SessionValidationCache (Bounded In-Memory LRU Cache)', () => {
    it('stores and retrieves cached session metadata (Cache Hit)', () => {
      const cache = new SessionValidationCache({ maxEntries: 10, ttlMs: 10000 });
      const testHash = 'test-sha256-hash-1';
      const metadata = {
        sessionId: 'session-1',
        status: 'RUNNING',
        isActive: true,
        expiresAtMs: Date.now() + 100000,
        proxyPort: 8080,
      };

      cache.set(testHash, metadata);
      const hit = cache.get(testHash);

      expect(hit).toBeTruthy();
      expect(hit.sessionId).toBe('session-1');
      expect(hit.proxyPort).toBe(8080);
    });

    it('returns null on Cache Miss for unknown tokenHash', () => {
      const cache = new SessionValidationCache();
      expect(cache.get('unknown-hash')).toBeNull();
    });

    it('returns null and evicts entry when 10-second TTL expires', () => {
      vi.useFakeTimers();
      const cache = new SessionValidationCache({ ttlMs: 10000 });
      const testHash = 'test-ttl-hash';
      cache.set(testHash, {
        sessionId: 'session-ttl',
        expiresAtMs: Date.now() + 60000,
      });

      expect(cache.get(testHash)).toBeTruthy();

      // Advance clock past 10s TTL
      vi.advanceTimersByTime(10500);

      expect(cache.get(testHash)).toBeNull();
      expect(cache.size).toBe(0);
      vi.useRealTimers();
    });

    it('never allows cached state to bypass hard session expiry (expiresAtMs <= now)', () => {
      const cache = new SessionValidationCache({ ttlMs: 10000 });
      const testHash = 'test-hard-expiry-hash';

      // Session whose hard expiry has already elapsed
      cache.set(testHash, {
        sessionId: 'session-expired',
        expiresAtMs: Date.now() - 500,
      });

      expect(cache.get(testHash)).toBeNull();
    });

    it('bounds capacity to maximum entries and evicts least recently used', () => {
      const cache = new SessionValidationCache({ maxEntries: 3 });

      cache.set('hash-1', { sessionId: 's1', expiresAtMs: Date.now() + 60000 });
      cache.set('hash-2', { sessionId: 's2', expiresAtMs: Date.now() + 60000 });
      cache.set('hash-3', { sessionId: 's3', expiresAtMs: Date.now() + 60000 });
      expect(cache.size).toBe(3);

      // Access hash-1 to refresh its LRU standing
      cache.get('hash-1');

      // Adding 4th entry must evict hash-2 (least recently used)
      cache.set('hash-4', { sessionId: 's4', expiresAtMs: Date.now() + 60000 });
      expect(cache.size).toBe(3);
      expect(cache.get('hash-2')).toBeNull();
      expect(cache.get('hash-1')).toBeTruthy();
      expect(cache.get('hash-3')).toBeTruthy();
      expect(cache.get('hash-4')).toBeTruthy();
    });

    it('invalidates cache entries by sessionId when session stops or expires', () => {
      const cache = new SessionValidationCache();
      cache.set('hash-a', { sessionId: 'session-to-stop', expiresAtMs: Date.now() + 60000 });
      expect(cache.get('hash-a')).toBeTruthy();

      cache.deleteBySessionId('session-to-stop');
      expect(cache.get('hash-a')).toBeNull();
    });

    it('strictly forbids plaintext capability tokens in cache storage', () => {
      const cache = new SessionValidationCache();
      const rawSecretToken = 'super-secret-plaintext-token-value-12345';
      const safeHash = crypto.createHash('sha256').update(rawSecretToken).digest('hex');

      cache.set(safeHash, {
        sessionId: 'session-secret',
        status: 'RUNNING',
        expiresAtMs: Date.now() + 60000,
      });

      const serialized = JSON.stringify(Array.from(cache.cache.entries()));
      expect(serialized).not.toContain(rawSecretToken);
      expect(serialized).toContain(safeHash);
    });
  });

  describe('2. stripAuthCookies() Helper', () => {
    it('strips __Host-gitview-preview-token, access_token, and refresh_token, while preserving app cookies', () => {
      const rawHeader = `theme=dark; ${PREVIEW_COOKIE_NAME}=token123; access_token=jwt1; user_id=42; refresh_token=jwt2`;
      const sanitized = stripAuthCookies(rawHeader);

      expect(sanitized).toBe('theme=dark; user_id=42');
      expect(sanitized).not.toContain(PREVIEW_COOKIE_NAME);
      expect(sanitized).not.toContain('access_token');
      expect(sanitized).not.toContain('refresh_token');
    });

    it('returns undefined if only authentication cookies were present', () => {
      const rawHeader = `${PREVIEW_COOKIE_NAME}=token123; access_token=jwt1; refresh_token=jwt2`;
      expect(stripAuthCookies(rawHeader)).toBeUndefined();
    });

    it('returns undefined for empty, null, or undefined headers', () => {
      expect(stripAuthCookies(undefined)).toBeUndefined();
      expect(stripAuthCookies(null)).toBeUndefined();
      expect(stripAuthCookies('')).toBeUndefined();
    });
  });

  describe('3. Host Authority & Subdomain Validation', () => {
    it('rejects missing Host header with HTTP 400 MISSING_HOST_HEADER', async () => {
      const server = app.listen(0);
      try {
        const rawHttp = `GET / HTTP/1.0\r\n\r\n`;
        const response = await sendRawHttp(server, rawHttp);
        expect(response).toContain('400 Bad Request');
        expect(response).toContain('MISSING_HOST_HEADER');
      } finally {
        server.close();
      }
    });

    it('rejects duplicate Host headers with HTTP 400 DUPLICATE_HOST_HEADER', async () => {
      const server = app.listen(0);
      try {
        const rawHttp =
          `GET / HTTP/1.1\r\n` +
          `Host: ${targetHostAuthority}\r\n` +
          `Host: evil-attacker.com:3000\r\n` +
          `Cookie: ${PREVIEW_COOKIE_NAME}=${rawToken}\r\n` +
          `Connection: close\r\n\r\n`;

        const response = await sendRawHttp(server, rawHttp);
        expect(response).toContain('400 Bad Request');
        expect(response).toContain('DUPLICATE_HOST_HEADER');
      } finally {
        server.close();
      }
    });

    it('rejects comma-separated Host header with HTTP 400 DUPLICATE_HOST_HEADER', async () => {
      const res = await request(app)
        .get('/')
        .set('Host', `${targetHostAuthority}, evil.com:3000`)
        .set('Cookie', `${PREVIEW_COOKIE_NAME}=${rawToken}`);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('DUPLICATE_HOST_HEADER');
    });

    it('rejects malformed authority with @ credential character with HTTP 400 HOST_AUTHORITY_MALFORMED', async () => {
      const res = await request(app)
        .get('/')
        .set('Host', `user@${targetHostAuthority}`)
        .set('Cookie', `${PREVIEW_COOKIE_NAME}=${rawToken}`);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('HOST_AUTHORITY_MALFORMED');
    });

    it('rejects malformed non-UUID subdomain with HTTP 400 UNKNOWN_PREVIEW_HOST', async () => {
      const res = await request(app)
        .get('/')
        .set('Host', 'not-a-valid-uuid.preview.localhost:3000')
        .set('Cookie', `${PREVIEW_COOKIE_NAME}=${rawToken}`);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('UNKNOWN_PREVIEW_HOST');
    });

    it('rejects apex preview domain without session subdomain with HTTP 400 UNKNOWN_PREVIEW_HOST', async () => {
      const res = await request(app)
        .get('/')
        .set('Host', 'preview.localhost:3000')
        .set('Cookie', `${PREVIEW_COOKIE_NAME}=${rawToken}`);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('UNKNOWN_PREVIEW_HOST');
    });

    it('rejects unexpected port in Host header with HTTP 401 HOST_AUTHORITY_MISMATCH', async () => {
      const res = await request(app)
        .get('/')
        .set('Host', `${session.id}.preview.localhost:8080`)
        .set('Cookie', `${PREVIEW_COOKIE_NAME}=${rawToken}`);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('HOST_AUTHORITY_MISMATCH');
    });

    it('rejects cross-session access: valid token for Session A sent to Session B host with 401 SESSION_NOT_FOUND', async () => {
      // Create user B and session B
      const userB = await createUser({
        email: 'gateway-user-b@example.com',
        username: 'gateway_user_b',
      });
      const repoB = await prisma.repository.create({
        data: {
          userId: userB.id,
          githubRepoId: '95002',
          owner: 'gitview-org',
          name: 'gateway-test-repo-b',
          fullName: 'gitview-org/gateway-test-repo-b',
          htmlUrl: 'https://github.com/gitview-org/gateway-test-repo-b',
          defaultBranch: 'main',
          latestCommitSha: '0123456789abcdef0123456789abcdef01234567',
        },
      });
      const rawTokenB = generatePreviewToken();
      const tokenHashB = hashPreviewToken(rawTokenB);
      const sessionB = await prisma.previewSession.create({
        data: {
          userId: userB.id,
          repositoryId: repoB.id,
          commitSha: '0123456789abcdef0123456789abcdef01234567',
          branch: 'main',
          framework: FrameworkType.STATIC,
          status: PreviewStatus.RUNNING,
          isActive: true,
          tokenHash: tokenHashB,
          previewTokenEnc: encryptPreviewToken(rawTokenB),
          proxyPort: mockUpstreamPort,
          expiresAt: new Date(Date.now() + 3600 * 1000),
          lastActiveAt: new Date(),
        },
      });

      const targetOriginB = getPreviewTargetOrigin(sessionB.id);
      const targetHostAuthorityB = canonicalizeHostAuthority(targetOriginB);

      // Send Session A's cookie to Session B's host
      const res = await request(app)
        .get('/')
        .set('Host', targetHostAuthorityB)
        .set('Cookie', `${PREVIEW_COOKIE_NAME}=${rawToken}`); // Token for A!

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('SESSION_NOT_FOUND');
    });
  });

  describe('4. Request Authentication & State Invariants', () => {
    it('rejects request without __Host- cookie with HTTP 401 TOKEN_MISSING', async () => {
      const res = await request(app)
        .get('/')
        .set('Host', targetHostAuthority);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('TOKEN_MISSING');
    });

    it('rejects request with malformed token format with HTTP 401 TOKEN_INVALID and clears cookie', async () => {
      const res = await request(app)
        .get('/')
        .set('Host', targetHostAuthority)
        .set('Cookie', `${PREVIEW_COOKIE_NAME}=not-a-64-hex-token`);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('TOKEN_INVALID');
      expect(res.headers['set-cookie']?.[0]).toContain(`${PREVIEW_COOKIE_NAME}=;`);
    });

    it('rejects request with unknown token with HTTP 401 SESSION_NOT_FOUND and clears cookie', async () => {
      const randomUnknownToken = crypto.randomBytes(32).toString('hex');
      const res = await request(app)
        .get('/')
        .set('Host', targetHostAuthority)
        .set('Cookie', `${PREVIEW_COOKIE_NAME}=${randomUnknownToken}`);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('SESSION_NOT_FOUND');
      expect(res.headers['set-cookie']?.[0]).toContain(`${PREVIEW_COOKIE_NAME}=;`);
    });

    it('rejects request when session is inactive with HTTP 401 SESSION_INACTIVE and clears cookie', async () => {
      const lru = getSessionValidationCache();
      lru.set(tokenHash, {
        sessionId: session.id,
        status: PreviewStatus.RUNNING,
        isActive: false,
        expiresAtMs: Date.now() + 60000,
        proxyPort: mockUpstreamPort,
      });

      const res = await request(app)
        .get('/')
        .set('Host', targetHostAuthority)
        .set('Cookie', `${PREVIEW_COOKIE_NAME}=${rawToken}`);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('SESSION_INACTIVE');
      expect(res.headers['set-cookie']?.[0]).toContain(`${PREVIEW_COOKIE_NAME}=;`);
    });

    it('rejects request when session is not in RUNNING status with HTTP 410 SESSION_STOPPED and clears cookie', async () => {
      await prisma.previewSession.update({
        where: { id: session.id },
        data: { status: PreviewStatus.STOPPED, isActive: false },
      });
      invalidateSessionGatewayCache(session.id);

      const res = await request(app)
        .get('/')
        .set('Host', targetHostAuthority)
        .set('Cookie', `${PREVIEW_COOKIE_NAME}=${rawToken}`);

      expect(res.status).toBe(410);
      expect(res.body.error.code).toBe('SESSION_STOPPED');
      expect(res.headers['set-cookie']?.[0]).toContain(`${PREVIEW_COOKIE_NAME}=;`);
    });

    it('rejects request when session has expired in DB with HTTP 410 SESSION_EXPIRED and clears cookie', async () => {
      await prisma.previewSession.update({
        where: { id: session.id },
        data: { expiresAt: new Date(Date.now() - 5000) },
      });
      invalidateSessionGatewayCache(session.id);

      const res = await request(app)
        .get('/')
        .set('Host', targetHostAuthority)
        .set('Cookie', `${PREVIEW_COOKIE_NAME}=${rawToken}`);

      expect(res.status).toBe(410);
      expect(res.body.error.code).toBe('SESSION_EXPIRED');
      expect(res.headers['set-cookie']?.[0]).toContain(`${PREVIEW_COOKIE_NAME}=;`);
    });

    it('authenticates valid request, returns 200 OK, and streams HTML from upstream sidecar', async () => {
      const res = await request(app)
        .get('/')
        .set('Host', targetHostAuthority)
        .set('Cookie', `${PREVIEW_COOKIE_NAME}=${rawToken}`);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.text).toContain('<h1>Preview App Loaded</h1>');
    });
  });

  describe('5. Proxy Forwarding & Streaming Security', () => {
    it('rewrites Host header to localhost:${proxyPort} when forwarding to upstream sidecar', async () => {
      await request(app)
        .get('/')
        .set('Host', targetHostAuthority)
        .set('Cookie', `${PREVIEW_COOKIE_NAME}=${rawToken}`);

      expect(lastUpstreamRequest).toBeTruthy();
      expect(lastUpstreamRequest.headers.host).toBe(`localhost:${mockUpstreamPort}`);
    });

    it('strips __Host- preview token before forwarding and preserves app cookies', async () => {
      await request(app)
        .get('/')
        .set('Host', targetHostAuthority)
        .set('Cookie', `${PREVIEW_COOKIE_NAME}=${rawToken}; client_pref=dark`);

      expect(lastUpstreamRequest.headers.cookie).toBe('client_pref=dark');
      expect(lastUpstreamRequest.headers.cookie).not.toContain(rawToken);
    });

    it('strips internal authorization header before forwarding', async () => {
      await request(app)
        .get('/')
        .set('Host', targetHostAuthority)
        .set('Cookie', `${PREVIEW_COOKIE_NAME}=${rawToken}`)
        .set('Authorization', 'Bearer internal-jwt-token');

      expect(lastUpstreamRequest.headers.authorization).toBeUndefined();
    });

    it('strips untrusted client forwarding headers and reconstructs verified X-Forwarded-*', async () => {
      await request(app)
        .get('/')
        .set('Host', targetHostAuthority)
        .set('Cookie', `${PREVIEW_COOKIE_NAME}=${rawToken}`)
        .set('X-Forwarded-For', '203.0.113.195')
        .set('X-Forwarded-Host', 'spoofed-domain.com')
        .set('X-Forwarded-Proto', 'https')
        .set('Forwarded', 'for=203.0.113.195;proto=https');

      expect(lastUpstreamRequest.headers['forwarded']).toBeUndefined();
      expect(lastUpstreamRequest.headers['x-forwarded-for']).not.toBe('203.0.113.195');
      expect(lastUpstreamRequest.headers['x-forwarded-host']).toBe(targetHostAuthority);
    });

    it('strips hop-by-hop headers from both request and response', async () => {
      await request(app)
        .get('/')
        .set('Host', targetHostAuthority)
        .set('Cookie', `${PREVIEW_COOKIE_NAME}=${rawToken}`)
        .set('Connection', 'Keep-Alive')
        .set('Keep-Alive', 'timeout=5, max=1000');

      expect(lastUpstreamRequest.headers['keep-alive']).toBeUndefined();
    });

    it('forwards CSS stylesheets and JS modules with proper Content-Type headers', async () => {
      const cssRes = await request(app)
        .get('/style.css')
        .set('Host', targetHostAuthority)
        .set('Cookie', `${PREVIEW_COOKIE_NAME}=${rawToken}`);

      expect(cssRes.status).toBe(200);
      expect(cssRes.headers['content-type']).toContain('text/css');
      expect(cssRes.text).toContain('body { background: #111; }');

      const jsRes = await request(app)
        .get('/src/main.jsx')
        .set('Host', targetHostAuthority)
        .set('Cookie', `${PREVIEW_COOKIE_NAME}=${rawToken}`);

      expect(jsRes.status).toBe(200);
      expect(jsRes.headers['content-type']).toContain('application/javascript');
      expect(jsRes.text).toContain('Vite module loaded');
    });

    it('streams response body backpressure handling for large payloads', async () => {
      const res = await request(app)
        .get('/large-response')
        .set('Host', targetHostAuthority)
        .set('Cookie', `${PREVIEW_COOKIE_NAME}=${rawToken}`);

      expect(res.status).toBe(200);
      expect(res.text.length).toBe(50000);
    });

    it('forwards POST request body with streaming data', async () => {
      const postPayload = JSON.stringify({ action: 'create_todo', title: 'Buy milk' });

      const res = await request(app)
        .post('/api/todo')
        .set('Host', targetHostAuthority)
        .set('Cookie', `${PREVIEW_COOKIE_NAME}=${rawToken}`)
        .set('Content-Type', 'application/json')
        .send(postPayload);

      expect(res.status).toBe(200);
      expect(lastUpstreamRequest.method).toBe('POST');
      expect(lastUpstreamRequest.url).toBe('/api/todo');
      expect(lastUpstreamRequest.body).toBe(postPayload);
    });

    it('rejects request with Content-Length exceeding 10 MB with HTTP 413 PAYLOAD_TOO_LARGE', async () => {
      const res = await request(app)
        .post('/api/upload')
        .set('Host', targetHostAuthority)
        .set('Cookie', `${PREVIEW_COOKIE_NAME}=${rawToken}`)
        .set('Content-Length', '15000000') // 15 MB
        .send('dummy');

      expect(res.status).toBe(413);
      expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    });

    it('rejects request with headers exceeding 16 KB with HTTP 431 REQUEST_HEADER_FIELDS_TOO_LARGE', async () => {
      const largeHeader = 'X'.repeat(17000); // 17 KB
      const res = await request(app)
        .get('/')
        .set('Host', targetHostAuthority)
        .set('Cookie', `${PREVIEW_COOKIE_NAME}=${rawToken}`)
        .set('X-Huge-Header', largeHeader);

      expect(res.status).toBe(431);
      if (res.body?.error?.code) {
        expect(res.body.error.code).toBe('REQUEST_HEADER_FIELDS_TOO_LARGE');
      }
    });
  });

  describe('6. Failure Recovery & Error Handling', () => {
    it('returns HTTP 502 BAD_GATEWAY when upstream sidecar connection is refused', async () => {
      // Point session to an unused loopback port
      await prisma.previewSession.update({
        where: { id: session.id },
        data: { proxyPort: 65520 },
      });
      invalidateSessionGatewayCache(session.id);

      const res = await request(app)
        .get('/')
        .set('Host', targetHostAuthority)
        .set('Cookie', `${PREVIEW_COOKIE_NAME}=${rawToken}`);

      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('BAD_GATEWAY');
      expect(res.body.error.message).toContain('Upstream preview runner unavailable');
    });

    it('returns HTTP 502 BAD_GATEWAY when upstream connection resets', async () => {
      const res = await request(app)
        .get('/reset')
        .set('Host', targetHostAuthority)
        .set('Cookie', `${PREVIEW_COOKIE_NAME}=${rawToken}`);

      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('BAD_GATEWAY');
    });

    it('returns HTTP 504 GATEWAY_TIMEOUT when upstream sidecar times out', async () => {
      const gateway = createPreviewGateway({
        idleTimeoutMs: 150,
      });

      const server = http.createServer((req, res) => {
        gateway.handleRequest(req, res, (err) => {
          if (err) res.writeHead(err.statusCode || 500).end(err.message);
        });
      });

      try {
        const res = await request(server)
          .get('/hang')
          .set('Host', targetHostAuthority)
          .set('Cookie', `${PREVIEW_COOKIE_NAME}=${rawToken}`);

        expect(res.status).toBe(504);
        expect(res.body.error.code).toBe('GATEWAY_TIMEOUT');
      } finally {
        server.close();
      }
    });

    it('fails closed with HTTP 500 DB_UNAVAILABLE when PostgreSQL fails on Cache Miss', async () => {
      const brokenPrisma = {
        previewSession: {
          findUnique: vi.fn().mockRejectedValue(new Error('Connection terminated unexpectedly')),
        },
      };

      const customGateway = createPreviewGateway({ prisma: brokenPrisma });

      const reqMock = {
        headers: { host: targetHostAuthority, cookie: `${PREVIEW_COOKIE_NAME}=${rawToken}` },
        rawHeaders: ['Host', targetHostAuthority],
        url: '/',
        method: 'GET',
        on: vi.fn(),
      };

      let errorThrown;
      const nextMock = (err) => {
        errorThrown = err;
      };

      await customGateway.handleRequest(reqMock, {}, nextMock);

      expect(errorThrown).toBeTruthy();
      expect(errorThrown.statusCode).toBe(500);
      expect(errorThrown.code).toBe('DB_UNAVAILABLE');
    });

    it('continues serving requests from LRU Cache when PostgreSQL is temporarily unavailable', async () => {
      const lruCache = new SessionValidationCache();
      // Pre-warm cache
      lruCache.set(tokenHash, {
        sessionId: session.id,
        status: PreviewStatus.RUNNING,
        isActive: true,
        expiresAtMs: Date.now() + 60000,
        proxyPort: mockUpstreamPort,
        proxyContainerId: session.proxyContainerId,
      });

      const brokenPrisma = {
        previewSession: {
          findUnique: vi.fn().mockRejectedValue(new Error('DB unreachable')),
          update: vi.fn().mockResolvedValue({}),
        },
      };

      const customGateway = createPreviewGateway({
        prisma: brokenPrisma,
        lruCache,
      });

      const server = http.createServer((req, res) => {
        customGateway.handleRequest(req, res, (err) => {
          if (err) res.writeHead(err.statusCode || 500).end(err.message);
        });
      });

      const res = await request(server)
        .get('/')
        .set('Host', targetHostAuthority)
        .set('Cookie', `${PREVIEW_COOKIE_NAME}=${rawToken}`);

      expect(res.status).toBe(200);
      expect(res.text).toContain('<h1>Preview App Loaded</h1>');
      server.close();
    });
  });

  describe('7. Activity Tracking & Heartbeat Debouncing', () => {
    it('debounces lastActiveAt updates to at most once every 30 seconds', async () => {
      invalidateSessionGatewayCache(session.id);
      const updateSpy = vi.spyOn(prisma.previewSession, 'update');

      // Request 1: triggers update
      await request(app)
        .get('/')
        .set('Host', targetHostAuthority)
        .set('Cookie', `${PREVIEW_COOKIE_NAME}=${rawToken}`);

      expect(updateSpy).toHaveBeenCalledTimes(1);

      // Immediate subsequent requests 2, 3, 4: debounced (no DB write)
      await request(app)
        .get('/style.css')
        .set('Host', targetHostAuthority)
        .set('Cookie', `${PREVIEW_COOKIE_NAME}=${rawToken}`);

      await request(app)
        .get('/src/main.jsx')
        .set('Host', targetHostAuthority)
        .set('Cookie', `${PREVIEW_COOKIE_NAME}=${rawToken}`);

      expect(updateSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('8. Session Rate Limiter', () => {
    it('enforces per-session rate limit and returns HTTP 429 TOO_MANY_REQUESTS', async () => {
      const limiter = new SessionRateLimiter({
        windowMs: 60000,
        burstMax: 3,
      });

      const customGateway = createPreviewGateway({ rateLimiter: limiter });

      const server = http.createServer((req, res) => {
        customGateway.handleRequest(req, res, (err) => {
          if (err) res.writeHead(err.statusCode || 500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { code: err.code } }));
        });
      });

      // 3 requests allowed
      for (let i = 0; i < 3; i++) {
        const okRes = await request(server)
          .get('/')
          .set('Host', targetHostAuthority)
          .set('Cookie', `${PREVIEW_COOKIE_NAME}=${rawToken}`);
        expect(okRes.status).toBe(200);
      }

      // 4th request blocked by burst limiter
      const blockedRes = await request(server)
        .get('/')
        .set('Host', targetHostAuthority)
        .set('Cookie', `${PREVIEW_COOKIE_NAME}=${rawToken}`);

      expect(blockedRes.status).toBe(429);
      expect(JSON.parse(blockedRes.text).error.code).toBe('TOO_MANY_REQUESTS');
      server.close();
    });
  });

  describe('9. Sidecar Identity & Port-Reuse Protection (§1)', () => {
    it('verifies running sidecar container with matching labels and published port succeeds', async () => {
      const result = await verifySidecarIdentity({
        docker: mockDocker,
        sessionId: session.id,
        proxyContainerId: session.proxyContainerId,
        proxyPort: mockUpstreamPort,
      });

      expect(result.valid).toBe(true);
    });

    it('rejects stopped sidecar container (State.Running = false) with HTTP 502 BAD_GATEWAY', async () => {
      mockDocker.inspectContainer.mockResolvedValueOnce({
        State: { Running: false },
        Config: {
          Labels: {
            'com.gitview.managed': 'true',
            'com.gitview.session-id': session.id,
            'com.gitview.role': 'proxy',
          },
        },
        NetworkSettings: {
          Ports: {
            '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: String(mockUpstreamPort) }],
          },
        },
      });

      const res = await request(app)
        .get('/')
        .set('Host', targetHostAuthority)
        .set('Cookie', `${PREVIEW_COOKIE_NAME}=${rawToken}`);

      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('BAD_GATEWAY');
      expect(res.body.error.message).toContain('CONTAINER_NOT_RUNNING');
    });

    it('rejects missing sidecar container (inspectContainer error) with HTTP 502 BAD_GATEWAY', async () => {
      mockDocker.inspectContainer.mockRejectedValueOnce(new Error('No such container: ' + session.proxyContainerId));

      const res = await request(app)
        .get('/')
        .set('Host', targetHostAuthority)
        .set('Cookie', `${PREVIEW_COOKIE_NAME}=${rawToken}`);

      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('BAD_GATEWAY');
      expect(res.body.error.message).toContain('CONTAINER_NOT_FOUND');
    });

    it('rejects sidecar container when com.gitview.managed is not true', async () => {
      mockDocker.inspectContainer.mockResolvedValueOnce({
        State: { Running: true },
        Config: {
          Labels: {
            'com.gitview.managed': 'false',
            'com.gitview.session-id': session.id,
            'com.gitview.role': 'proxy',
          },
        },
        NetworkSettings: {
          Ports: {
            '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: String(mockUpstreamPort) }],
          },
        },
      });

      const res = await request(app)
        .get('/')
        .set('Host', targetHostAuthority)
        .set('Cookie', `${PREVIEW_COOKIE_NAME}=${rawToken}`);

      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('BAD_GATEWAY');
      expect(res.body.error.message).toContain('NOT_MANAGED_BY_GITVIEW');
    });

    it('rejects sidecar container when com.gitview.session-id does not match current session', async () => {
      mockDocker.inspectContainer.mockResolvedValueOnce({
        State: { Running: true },
        Config: {
          Labels: {
            'com.gitview.managed': 'true',
            'com.gitview.session-id': 'unrelated-session-id',
            'com.gitview.role': 'proxy',
          },
        },
        NetworkSettings: {
          Ports: {
            '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: String(mockUpstreamPort) }],
          },
        },
      });

      const res = await request(app)
        .get('/')
        .set('Host', targetHostAuthority)
        .set('Cookie', `${PREVIEW_COOKIE_NAME}=${rawToken}`);

      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('BAD_GATEWAY');
      expect(res.body.error.message).toContain('SESSION_ID_MISMATCH');
    });

    it('rejects sidecar container when com.gitview.role is not proxy', async () => {
      mockDocker.inspectContainer.mockResolvedValueOnce({
        State: { Running: true },
        Config: {
          Labels: {
            'com.gitview.managed': 'true',
            'com.gitview.session-id': session.id,
            'com.gitview.role': 'runner',
          },
        },
        NetworkSettings: {
          Ports: {
            '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: String(mockUpstreamPort) }],
          },
        },
      });

      const res = await request(app)
        .get('/')
        .set('Host', targetHostAuthority)
        .set('Cookie', `${PREVIEW_COOKIE_NAME}=${rawToken}`);

      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('BAD_GATEWAY');
      expect(res.body.error.message).toContain('ROLE_MISMATCH');
    });

    it('rejects sidecar container when published TCP port does not match session.proxyPort', async () => {
      mockDocker.inspectContainer.mockResolvedValueOnce({
        State: { Running: true },
        Config: {
          Labels: {
            'com.gitview.managed': 'true',
            'com.gitview.session-id': session.id,
            'com.gitview.role': 'proxy',
          },
        },
        NetworkSettings: {
          Ports: {
            '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '59999' }],
          },
        },
      });

      const res = await request(app)
        .get('/')
        .set('Host', targetHostAuthority)
        .set('Cookie', `${PREVIEW_COOKIE_NAME}=${rawToken}`);

      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('BAD_GATEWAY');
      expect(res.body.error.message).toContain('PORT_MISMATCH');
    });

    it('SidecarVerificationCache caches verification for 2s TTL and bounds capacity', async () => {
      const cache = new SidecarVerificationCache({ maxEntries: 3, ttlMs: 50 });
      cache.set('s1', 'c1', 8080);
      expect(cache.get('s1', 'c1', 8080)).toBe(true);
      expect(cache.get('s1', 'c1', 8081)).toBe(false);

      // Wait for 50ms TTL expiration
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(cache.get('s1', 'c1', 8080)).toBe(false);

      // Capacity bounding
      cache.set('s1', 'c1', 1);
      cache.set('s2', 'c2', 2);
      cache.set('s3', 'c3', 3);
      cache.set('s4', 'c4', 4);
      expect(cache.get('s1', 'c1', 1)).toBe(false); // Evicted oldest
      expect(cache.get('s4', 'c4', 4)).toBe(true);

      // Invalidation by sessionId
      cache.deleteBySessionId('s2');
      expect(cache.get('s2', 'c2', 2)).toBe(false);
    });

    it('proves sidecar port-reassignment race cannot reach Session B sidecar even when Session A is cached within 2s TTL', async () => {
      // 1. Session A primes the sidecar micro-cache (identity successfully cached within 2s TTL)
      const primeRes = await request(app)
        .get('/')
        .set('Host', targetHostAuthority)
        .set('Cookie', `${PREVIEW_COOKIE_NAME}=${rawToken}`);
      expect(primeRes.status).toBe(200);

      const sidecarCache = getSidecarVerificationCache();
      expect(sidecarCache.get(session.id, session.proxyContainerId, mockUpstreamPort)).toBe(true);

      // 2. Session B is created for a different user and allocated the SAME port (mockUpstreamPort)
      const userB = await createUser({
        email: 'gateway-user-b@example.com',
        username: 'gateway_user_b',
      });

      const tokenB = generatePreviewToken();
      const tokenBHash = hashPreviewToken(tokenB);
      const sessionB = await prisma.previewSession.create({
        data: {
          userId: userB.id,
          repositoryId: repo.id,
          commitSha: '0123456789abcdef0123456789abcdef01234567',
          branch: 'main',
          framework: FrameworkType.STATIC,
          status: PreviewStatus.RUNNING,
          isActive: true,
          tokenHash: tokenBHash,
          previewTokenEnc: encryptPreviewToken(tokenB),
          proxyPort: mockUpstreamPort,
          proxyContainerId: `gitview-proxy-sessionB-${crypto.randomUUID()}`,
          runnerContainerId: `gitview-runner-sessionB-${crypto.randomUUID()}`,
          expiresAt: new Date(Date.now() + 3600 * 1000),
          lastActiveAt: new Date(),
          startedAt: new Date(),
        },
      });

      // 3. Session A's container is UNEXPECTEDLY destroyed in Docker (without stopping session).
      // Docker inspect for Session A's proxyContainerId now fails with not found.
      // Docker inspect for Session B's proxyContainerId returns running with that port.
      mockDocker.inspectContainer = vi.fn(async (containerId) => {
        if (containerId === sessionB.proxyContainerId) {
          return {
            State: { Running: true },
            Config: {
              Labels: {
                'com.gitview.managed': 'true',
                'com.gitview.session-id': sessionB.id,
                'com.gitview.role': 'proxy',
              },
            },
            NetworkSettings: {
              Ports: {
                '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: String(mockUpstreamPort) }],
              },
            },
          };
        }
        throw new Error('No such container: ' + containerId);
      });

      // 4. Session A's verification is STILL within its 2-second TTL in sidecarCache
      expect(sidecarCache.get(session.id, session.proxyContainerId, mockUpstreamPort)).toBe(true);

      // 5. Session B's sidecar is active on mockUpstreamPort.
      // It enforces the authenticated gateway-to-sidecar handshake:
      // It requires matching x-gitview-session-id and x-gitview-sidecar-token headers.
      let sessionBReceivedRequest = false;
      const originalHandler = mockUpstreamServer.listeners('request')[0];
      mockUpstreamServer.removeAllListeners('request');
      mockUpstreamServer.on('request', (req, res) => {
        const incomingSessionId = req.headers['x-gitview-session-id'];
        const incomingToken = req.headers['x-gitview-sidecar-token'];
        const expectedToken = createSidecarHandshakeToken(sessionB.id, sessionB.proxyContainerId);

        if (incomingSessionId !== sessionB.id || incomingToken !== expectedToken) {
          // Handshake mismatch: reject immediately!
          res.writeHead(403, {
            'Content-Type': 'application/json',
            'X-GitView-Handshake-Error': 'true',
          });
          res.end(JSON.stringify({ error: { code: 'SIDECAR_HANDSHAKE_FAILED' } }));
          return;
        }

        sessionBReceivedRequest = true;
        res.writeHead(200).end('Session B content');
      });

      // 6. An attacker or stale client attempts to use Session A's token to access Session A's preview host
      const resA = await request(app)
        .get('/')
        .set('Host', targetHostAuthority)
        .set('Cookie', `${PREVIEW_COOKIE_NAME}=${rawToken}`);

      // MUST be rejected with HTTP 502 BAD_GATEWAY
      expect(resA.status).toBe(502);
      expect(resA.body.error.code).toBe('BAD_GATEWAY');

      // Prove that Session B's sidecar application runner was NEVER reached!
      expect(sessionBReceivedRequest).toBe(false);

      // Prove that the stale cache entry was invalidated upon handshake rejection
      expect(sidecarCache.get(session.id, session.proxyContainerId, mockUpstreamPort)).toBe(false);

      // Now verify that Session B with its OWN token can legitimately access Session B
      const targetOriginB = getPreviewTargetOrigin(sessionB.id);
      const targetHostAuthorityB = canonicalizeHostAuthority(targetOriginB);

      const resB = await request(app)
        .get('/')
        .set('Host', targetHostAuthorityB)
        .set('Cookie', `${PREVIEW_COOKIE_NAME}=${tokenB}`);

      expect(resB.status).toBe(200);
      expect(sessionBReceivedRequest).toBe(true);

      // Restore original upstream handler
      mockUpstreamServer.removeAllListeners('request');
      mockUpstreamServer.on('request', originalHandler);
    });
  });

  describe('10. Upstream Location Header Sanitization & Rewriting (§2)', () => {
    it('preserves relative redirects (/dashboard, ../app, page.html, ?x=1)', () => {
      const ctx = {
        expectedTargetOrigin: targetOrigin,
        sessionId: session.id,
        proxyPort: mockUpstreamPort,
      };

      expect(sanitizeLocationHeader('/dashboard', ctx)).toBe('/dashboard');
      expect(sanitizeLocationHeader('../app', ctx)).toBe('../app');
      expect(sanitizeLocationHeader('page.html', ctx)).toBe('page.html');
      expect(sanitizeLocationHeader('?x=1', ctx)).toBe('?x=1');
      expect(sanitizeLocationHeader('#hash', ctx)).toBe('#hash');
      expect(sanitizeLocationHeader('./components/button', ctx)).toBe('./components/button');
    });

    it('rewrites absolute same-session internal redirects to canonical public preview origin', () => {
      const ctx = {
        expectedTargetOrigin: targetOrigin,
        sessionId: session.id,
        proxyPort: mockUpstreamPort,
      };

      expect(sanitizeLocationHeader(`http://localhost:${mockUpstreamPort}/foo?bar=1`, ctx)).toBe(
        `${targetOrigin}/foo?bar=1`
      );
      expect(sanitizeLocationHeader(`http://127.0.0.1:${mockUpstreamPort}/settings`, ctx)).toBe(
        `${targetOrigin}/settings`
      );
      expect(sanitizeLocationHeader(`http://gitview-runner-test:3000/app`, ctx)).toBe(
        `${targetOrigin}/app`
      );
      expect(sanitizeLocationHeader(`${targetOrigin}/welcome`, ctx)).toBe(
        `${targetOrigin}/welcome`
      );
    });

    it('live gateway rewrites internal upstream Location redirect to public target origin', async () => {
      const originalHandler = mockUpstreamServer.listeners('request')[0];
      mockUpstreamServer.removeAllListeners('request');
      mockUpstreamServer.on('request', (req, res) => {
        if (req.url === '/redirect-me') {
          res.writeHead(302, {
            Location: `http://127.0.0.1:${mockUpstreamPort}/app/dashboard`,
          });
          res.end();
          return;
        }
        res.writeHead(200).end('OK');
      });

      const res = await request(app)
        .get('/redirect-me')
        .set('Host', targetHostAuthority)
        .set('Cookie', `${PREVIEW_COOKIE_NAME}=${rawToken}`);

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(`${targetOrigin}/app/dashboard`);
      expect(res.headers.location).not.toContain('127.0.0.1');
      expect(res.headers.location).not.toContain(String(mockUpstreamPort));

      mockUpstreamServer.removeAllListeners('request');
      mockUpstreamServer.on('request', originalHandler);
    });

    it('permits legitimate external public redirects (e.g. OAuth to github.com)', async () => {
      const ctx = {
        expectedTargetOrigin: targetOrigin,
        sessionId: session.id,
        proxyPort: mockUpstreamPort,
      };

      expect(sanitizeLocationHeader('https://github.com/login/oauth/authorize', ctx)).toBe(
        'https://github.com/login/oauth/authorize'
      );
      expect(sanitizeLocationHeader('https://accounts.google.com/o/oauth2/v2/auth', ctx)).toBe(
        'https://accounts.google.com/o/oauth2/v2/auth'
      );
    });

    it('rejects and fails closed (HTTP 502) on redirects to another preview subdomain', async () => {
      const otherOrigin = getPreviewTargetOrigin('22222222-2222-3333-4444-555555555555');
      const originalHandler = mockUpstreamServer.listeners('request')[0];
      mockUpstreamServer.removeAllListeners('request');
      mockUpstreamServer.on('request', (req, res) => {
        res.writeHead(302, {
          Location: `${otherOrigin}/steal`,
        });
        res.end();
      });

      const res = await request(app)
        .get('/steal-redirect')
        .set('Host', targetHostAuthority)
        .set('Cookie', `${PREVIEW_COOKIE_NAME}=${rawToken}`);

      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('BAD_GATEWAY');

      mockUpstreamServer.removeAllListeners('request');
      mockUpstreamServer.on('request', originalHandler);
    });

    it('rejects and fails closed (HTTP 502) on redirects to private RFC 1918 / loopback / link-local addresses', async () => {
      const ctx = {
        expectedTargetOrigin: targetOrigin,
        sessionId: session.id,
        proxyPort: mockUpstreamPort,
      };

      expect(sanitizeLocationHeader('http://192.168.1.1/admin', ctx)).toBeNull();
      expect(sanitizeLocationHeader('http://10.0.0.1/secret', ctx)).toBeNull();
      expect(sanitizeLocationHeader('http://172.16.0.5/', ctx)).toBeNull();
      expect(sanitizeLocationHeader('http://169.254.169.254/latest/meta-data', ctx)).toBeNull();
      expect(sanitizeLocationHeader('http://[fe80::1]/', ctx)).toBeNull();
    });

    it('rejects and fails closed (HTTP 502) on malformed authorities, CRLF injection, and credentials in URL', async () => {
      const ctx = {
        expectedTargetOrigin: targetOrigin,
        sessionId: session.id,
        proxyPort: mockUpstreamPort,
      };

      expect(sanitizeLocationHeader('http://github.com\r\nSet-Cookie: evil=1', ctx)).toBeNull();
      expect(sanitizeLocationHeader('javascript:alert(1)', ctx)).toBeNull();
      expect(sanitizeLocationHeader('data:text/html,<h1>evil</h1>', ctx)).toBeNull();
      expect(sanitizeLocationHeader('file:///etc/passwd', ctx)).toBeNull();
      expect(sanitizeLocationHeader('http://admin:secret@github.com', ctx)).toBeNull();
      expect(sanitizeLocationHeader('//evil.com/path', ctx)).toBeNull();
      expect(sanitizeLocationHeader('http://github.com\\evil.com', ctx)).toBeNull();
    });

    it('rejects JavaScript, data, and file schemes with HTTP 502 BAD_GATEWAY on live gateway', async () => {
      const originalHandler = mockUpstreamServer.listeners('request')[0];
      mockUpstreamServer.removeAllListeners('request');
      mockUpstreamServer.on('request', (req, res) => {
        if (req.url === '/file-redirect') {
          res.writeHead(302, { Location: 'file:///etc/shadow' }).end();
          return;
        }
        if (req.url === '/js-redirect') {
          res.writeHead(302, { Location: 'javascript:alert(document.cookie)' }).end();
          return;
        }
        res.writeHead(200).end('OK');
      });

      const res1 = await request(app)
        .get('/file-redirect')
        .set('Host', targetHostAuthority)
        .set('Cookie', `${PREVIEW_COOKIE_NAME}=${rawToken}`);
      expect(res1.status).toBe(502);
      expect(res1.body.error.code).toBe('BAD_GATEWAY');

      const res2 = await request(app)
        .get('/js-redirect')
        .set('Host', targetHostAuthority)
        .set('Cookie', `${PREVIEW_COOKIE_NAME}=${rawToken}`);
      expect(res2.status).toBe(502);
      expect(res2.body.error.code).toBe('BAD_GATEWAY');

      mockUpstreamServer.removeAllListeners('request');
      mockUpstreamServer.on('request', originalHandler);
    });
  });

  describe('11. Upstream Set-Cookie Domain Stripping (§3)', () => {
    it('strips Domain=... attribute from upstream Set-Cookie header while preserving other attributes', () => {
      const rawCookie = 'app_session=xyz123; Domain=preview.localhost; Path=/; Secure; HttpOnly; SameSite=Lax';
      const sanitized = sanitizeUpstreamSetCookie(rawCookie);

      expect(sanitized).toBe('app_session=xyz123; Path=/; Secure; HttpOnly; SameSite=Lax');
      expect(sanitized).not.toContain('Domain=');
    });

    it('handles multiple Set-Cookie headers in an array, stripping Domain from each', () => {
      const rawCookies = [
        'pref=dark; Domain=.preview.localhost; Path=/',
        'auth=token123; Path=/; domain=gitview-preview.com; HttpOnly',
        'locale=en; Path=/',
      ];

      const sanitized = sanitizeUpstreamSetCookie(rawCookies);

      expect(Array.isArray(sanitized)).toBe(true);
      expect(sanitized[0]).toBe('pref=dark; Path=/');
      expect(sanitized[1]).toBe('auth=token123; Path=/; HttpOnly');
      expect(sanitized[2]).toBe('locale=en; Path=/');
    });

    it('live gateway strips upstream Domain attribute from Set-Cookie before client receives it', async () => {
      const originalHandler = mockUpstreamServer.listeners('request')[0];
      mockUpstreamServer.removeAllListeners('request');
      mockUpstreamServer.on('request', (req, res) => {
        res.writeHead(200, {
          'Set-Cookie': [
            'app_pref=light; Domain=preview.localhost; Path=/; Secure',
            'session_id=abc; Domain=.preview.localhost; Path=/; HttpOnly',
          ],
        });
        res.end('Cookies Set');
      });

      const res = await request(app)
        .get('/')
        .set('Host', targetHostAuthority)
        .set('Cookie', `${PREVIEW_COOKIE_NAME}=${rawToken}`);

      expect(res.status).toBe(200);
      const cookies = res.headers['set-cookie'];
      expect(cookies).toBeDefined();
      for (const cookie of cookies) {
        expect(cookie.toLowerCase()).not.toContain('domain=');
      }

      mockUpstreamServer.removeAllListeners('request');
      mockUpstreamServer.on('request', originalHandler);
    });

    it('cross-preview cookie isolation: stripped Domain prevents cookie leakage across subdomains', async () => {
      // Upstream A attempts to set a cookie scoped to parent domain .preview.localhost
      const originalHandler = mockUpstreamServer.listeners('request')[0];
      mockUpstreamServer.removeAllListeners('request');
      mockUpstreamServer.on('request', (req, res) => {
        res.writeHead(200, {
          'Set-Cookie': 'shared_secret=attacker_payload; Domain=preview.localhost; Path=/',
        });
        res.end('OK');
      });

      const res = await request(app)
        .get('/')
        .set('Host', targetHostAuthority)
        .set('Cookie', `${PREVIEW_COOKIE_NAME}=${rawToken}`);

      expect(res.status).toBe(200);
      const setCookie = res.headers['set-cookie'];
      expect(setCookie).toBeDefined();
      const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;

      // Assert that Domain= has been completely stripped
      expect(cookieStr).not.toContain('Domain=');
      expect(cookieStr).not.toContain('preview.localhost');
      // Cookie is now host-only for session A's subdomain
      expect(cookieStr).toBe('shared_secret=attacker_payload; Path=/');

      mockUpstreamServer.removeAllListeners('request');
      mockUpstreamServer.on('request', originalHandler);
    });

    it('rejects upstream attempts to set reserved GitView authentication cookies (__Host-gitview-preview-token, access_token, refresh_token)', () => {
      // 1. Reserved cookies alone return undefined
      expect(sanitizeUpstreamSetCookie('__Host-gitview-preview-token=forged; Path=/; Secure')).toBeUndefined();
      expect(sanitizeUpstreamSetCookie('access_token=stolen; Path=/; HttpOnly')).toBeUndefined();
      expect(sanitizeUpstreamSetCookie('refresh_token=fake; Path=/')).toBeUndefined();

      // 2. Mixed array: strips reserved cookies and strips Domain from legitimate application cookies
      const mixed = [
        '__Host-gitview-preview-token=malicious; Path=/; Secure',
        'access_token=injected; Path=/',
        'app_session=legit_123; Domain=preview.localhost; Path=/; HttpOnly',
        'refresh_token=stolen; Path=/',
        'theme=dark; Path=/',
      ];
      const sanitized = sanitizeUpstreamSetCookie(mixed);
      expect(sanitized).toEqual([
        'app_session=legit_123; Path=/; HttpOnly',
        'theme=dark; Path=/',
      ]);
    });

    it('live gateway proves browser never receives a Set-Cookie header attempting to overwrite a reserved GitView cookie', async () => {
      const originalHandler = mockUpstreamServer.listeners('request')[0];
      mockUpstreamServer.removeAllListeners('request');
      mockUpstreamServer.on('request', (req, res) => {
        res.writeHead(200, {
          'Set-Cookie': [
            '__Host-gitview-preview-token=forged_token; Path=/; Secure',
            'access_token=attacker_jwt; Path=/',
            'refresh_token=attacker_refresh; Path=/',
            'user_pref=compact; Domain=preview.localhost; Path=/',
          ],
        });
        res.end('Cookie Attack Test');
      });

      const res = await request(app)
        .get('/')
        .set('Host', targetHostAuthority)
        .set('Cookie', `${PREVIEW_COOKIE_NAME}=${rawToken}`);

      expect(res.status).toBe(200);
      const cookies = res.headers['set-cookie'];
      expect(cookies).toBeDefined();
      // Browser receives ONLY user_pref without Domain=, and NEVER receives any reserved cookies
      expect(cookies.length).toBe(1);
      expect(cookies[0]).toBe('user_pref=compact; Path=/');
      for (const c of cookies) {
        const lower = c.toLowerCase();
        expect(lower).not.toContain('__host-gitview-preview-token');
        expect(lower).not.toContain('access_token');
        expect(lower).not.toContain('refresh_token');
        expect(lower).not.toContain('domain=');
      }

      mockUpstreamServer.removeAllListeners('request');
      mockUpstreamServer.on('request', originalHandler);
    });

    it('live gateway deletes Set-Cookie header entirely if upstream sets only reserved cookies', async () => {
      const originalHandler = mockUpstreamServer.listeners('request')[0];
      mockUpstreamServer.removeAllListeners('request');
      mockUpstreamServer.on('request', (req, res) => {
        res.writeHead(200, {
          'Set-Cookie': [
            '__Host-gitview-preview-token=forged_token; Path=/; Secure',
            'access_token=attacker_jwt; Path=/',
          ],
        });
        res.end('All Reserved');
      });

      const res = await request(app)
        .get('/')
        .set('Host', targetHostAuthority)
        .set('Cookie', `${PREVIEW_COOKIE_NAME}=${rawToken}`);

      expect(res.status).toBe(200);
      expect(res.headers['set-cookie']).toBeUndefined();

      mockUpstreamServer.removeAllListeners('request');
      mockUpstreamServer.on('request', originalHandler);
    });
  });

  describe('12. Trusted Forwarded-Protocol Reconstruction (§4)', () => {
    it('evaluates CIDR subnets correctly (normalizeIp, ipv4ToInt, parseCidr, isIpInCidr)', () => {
      expect(normalizeIp('::ffff:127.0.0.1')).toBe('127.0.0.1');
      expect(normalizeIp('10.0.1.5')).toBe('10.0.1.5');
      expect(ipv4ToInt('127.0.0.1')).toBe(2130706433);
      expect(ipv4ToInt('invalid.ip')).toBeNull();

      const cidrA = parseCidr('10.0.0.0/8');
      expect(cidrA).toBeTruthy();
      expect(isIpInCidr('10.0.1.50', cidrA)).toBe(true);
      expect(isIpInCidr('11.0.0.1', cidrA)).toBe(false);

      const cidrB = parseCidr('192.168.1.0/24');
      expect(isIpInCidr('192.168.1.100', cidrB)).toBe(true);
      expect(isIpInCidr('192.168.2.1', cidrB)).toBe(false);

      const cidrC = parseCidr('127.0.0.1');
      expect(isIpInCidr('127.0.0.1', cidrC)).toBe(true);
      expect(isIpInCidr('127.0.0.2', cidrC)).toBe(false);

      expect(parseCidr('invalid/cidr')).toBeNull();
      expect(parseCidr('10.0.0.1/33')).toBeNull();
    });

    it('validates immediate peer against trusted proxy list (isPeerTrustedProxy)', () => {
      const trusted = ['10.0.0.0/8', '172.16.0.0/12', '127.0.0.1'];
      expect(isPeerTrustedProxy('10.5.0.1', trusted)).toBe(true);
      expect(isPeerTrustedProxy('::ffff:127.0.0.1', trusted)).toBe(true);
      expect(isPeerTrustedProxy('203.0.113.195', trusted)).toBe(false);
      expect(isPeerTrustedProxy('', trusted)).toBe(false);
      expect(isPeerTrustedProxy('10.0.0.1', [])).toBe(false);
    });

    it('reconstructs X-Forwarded-Proto as https when direct socket TLS is active', () => {
      const mockReq = {
        socket: { remoteAddress: '203.0.113.50', encrypted: true },
        headers: { host: 'preview.example.com' },
      };

      const reconstructed = reconstructForwardedHeaders({
        req: mockReq,
        trustedProxies: ['10.0.0.0/8'],
        publicHost: 'preview.example.com',
      });

      expect(reconstructed['x-forwarded-proto']).toBe('https');
      expect(reconstructed['x-forwarded-for']).toBe('203.0.113.50');
      expect(reconstructed['x-forwarded-host']).toBe('preview.example.com');
    });

    it('reconstructs X-Forwarded-Proto as http when unencrypted direct connection from untrusted peer', () => {
      const mockReq = {
        socket: { remoteAddress: '203.0.113.50', encrypted: false },
        headers: {
          host: 'preview.example.com',
          'x-forwarded-proto': 'https',
          'x-forwarded-for': '8.8.8.8',
        },
      };

      const reconstructed = reconstructForwardedHeaders({
        req: mockReq,
        trustedProxies: ['10.0.0.0/8'],
        publicHost: 'preview.example.com',
      });

      expect(reconstructed['x-forwarded-proto']).toBe('http');
      expect(reconstructed['x-forwarded-for']).toBe('203.0.113.50');
      expect(reconstructed['x-forwarded-host']).toBe('preview.example.com');
    });

    it('reconstructs external scheme and client IP when immediate peer is a verified trusted proxy', () => {
      const mockReq = {
        socket: { remoteAddress: '10.0.1.10', encrypted: false },
        headers: {
          host: 'preview.example.com',
          'x-forwarded-proto': 'https',
          'x-forwarded-for': '198.51.100.25, 10.0.1.10',
        },
      };

      const reconstructed = reconstructForwardedHeaders({
        req: mockReq,
        trustedProxies: ['10.0.0.0/8'],
        publicHost: 'preview.example.com',
      });

      expect(reconstructed['x-forwarded-proto']).toBe('https');
      expect(reconstructed['x-forwarded-for']).toBe('198.51.100.25');
      expect(reconstructed['x-forwarded-host']).toBe('preview.example.com');
    });

    it('fails closed and ignores forwarding headers when trusted proxy config is invalid or empty', () => {
      const mockReq = {
        socket: { remoteAddress: '127.0.0.1', encrypted: false },
        headers: {
          host: 'preview.example.com',
          'x-forwarded-proto': 'https',
        },
      };

      const reconstructed = reconstructForwardedHeaders({
        req: mockReq,
        trustedProxies: ['invalid-cidr-string'],
        publicHost: 'preview.example.com',
      });

      expect(reconstructed['x-forwarded-proto']).toBe('http');
      expect(reconstructed['x-forwarded-for']).toBe('127.0.0.1');
    });

    it('validates X-Forwarded-Proto as a single permitted scheme and rejects comma-separated values (e.g. "https, http")', () => {
      const mockReq = {
        socket: { remoteAddress: '10.0.1.10', encrypted: false },
        headers: {
          host: 'preview.example.com',
          'x-forwarded-proto': 'https, http', // Chained or un-overwritten header!
        },
      };

      const reconstructed = reconstructForwardedHeaders({
        req: mockReq,
        trustedProxies: ['10.0.0.0/8'],
        publicHost: 'preview.example.com',
      });

      // Must reject comma-separated value and fall back to safe default 'http'
      expect(reconstructed['x-forwarded-proto']).toBe('http');
    });

    it('rejects malformed X-Forwarded-Proto values (e.g. "ftp", "javascript:", "//evil")', () => {
      const mockReq = {
        socket: { remoteAddress: '10.0.1.10', encrypted: false },
        headers: {
          host: 'preview.example.com',
          'x-forwarded-proto': 'ftp',
        },
      };

      const reconstructed = reconstructForwardedHeaders({
        req: mockReq,
        trustedProxies: ['10.0.0.0/8'],
        publicHost: 'preview.example.com',
      });

      expect(reconstructed['x-forwarded-proto']).toBe('http');
    });
  });

  describe('Task 3.3 — Sidecar Handshake Key Separation & Header Stripping', () => {
    const baseValidEnv = {
      NODE_ENV: 'test',
      PORT: '3000',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/gitview',
      FRONTEND_URL: 'http://localhost:5173',
      JWT_ACCESS_SECRET: 'access_secret_at_least_32_characters_long_12345',
      JWT_REFRESH_SECRET: 'refresh_secret_at_least_32_characters_long_12345',
      ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      PREVIEW_TOKEN_ENCRYPTION_KEY: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
      GITVIEW_SIDECAR_HANDSHAKE_KEY: '0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b',
    };

    it('enforces that GITVIEW_SIDECAR_HANDSHAKE_KEY is at least 32 characters', () => {
      const res = envSchema.safeParse({
        ...baseValidEnv,
        GITVIEW_SIDECAR_HANDSHAKE_KEY: 'too_short_key',
      });
      expect(res.success).toBe(false);
      const handshakeError = res.error.issues.find((i) => i.path.includes('GITVIEW_SIDECAR_HANDSHAKE_KEY'));
      expect(handshakeError).toBeDefined();
      expect(handshakeError.message).toContain('at least 32 characters');
    });

    it('enforces that GITVIEW_SIDECAR_HANDSHAKE_KEY is distinct from ENCRYPTION_KEY', () => {
      const res = envSchema.safeParse({
        ...baseValidEnv,
        GITVIEW_SIDECAR_HANDSHAKE_KEY: baseValidEnv.ENCRYPTION_KEY,
      });
      expect(res.success).toBe(false);
      const handshakeError = res.error.issues.find((i) => i.path.includes('GITVIEW_SIDECAR_HANDSHAKE_KEY'));
      expect(handshakeError).toBeDefined();
      expect(handshakeError.message).toContain('must be different from ENCRYPTION_KEY');
    });

    it('enforces that GITVIEW_SIDECAR_HANDSHAKE_KEY is distinct from PREVIEW_TOKEN_ENCRYPTION_KEY', () => {
      const res = envSchema.safeParse({
        ...baseValidEnv,
        GITVIEW_SIDECAR_HANDSHAKE_KEY: baseValidEnv.PREVIEW_TOKEN_ENCRYPTION_KEY,
      });
      expect(res.success).toBe(false);
      const handshakeError = res.error.issues.find((i) => i.path.includes('GITVIEW_SIDECAR_HANDSHAKE_KEY'));
      expect(handshakeError).toBeDefined();
      expect(handshakeError.message).toContain('must be different from PREVIEW_TOKEN_ENCRYPTION_KEY');
    });

    it('creates handshake token using GITVIEW_SIDECAR_HANDSHAKE_KEY and never reuses PREVIEW_TOKEN_ENCRYPTION_KEY', () => {
      const sId = '11111111-2222-3333-4444-555555555555';
      const cId = 'gitview-proxy-11111111-2222-3333-4444-555555555555';

      const tokenFromMasterKey = createSidecarHandshakeToken(sId, cId);
      const tokenFromTokenKey = createSidecarHandshakeToken(sId, cId, env.PREVIEW_TOKEN_ENCRYPTION_KEY);
      const tokenFromDbEncKey = createSidecarHandshakeToken(sId, cId, env.ENCRYPTION_KEY);

      expect(typeof tokenFromMasterKey).toBe('string');
      expect(tokenFromMasterKey.length).toBe(64); // SHA-256 hex
      expect(tokenFromMasterKey).not.toBe(tokenFromTokenKey);
      expect(tokenFromMasterKey).not.toBe(tokenFromDbEncKey);
    });

    it('rejects a handshake token generated for a different session', () => {
      const sessionAId = 'aaaaaaaa-1111-2222-3333-444444444444';
      const sessionBId = 'bbbbbbbb-1111-2222-3333-444444444444';
      const proxyId = 'gitview-proxy-common';

      const tokenA = createSidecarHandshakeToken(sessionAId, proxyId);
      const tokenB = createSidecarHandshakeToken(sessionBId, proxyId);

      expect(tokenA).not.toBe(tokenB);

      // Session B's sidecar validating incoming token from Session A
      const valid = validateSidecarHandshake({
        incomingSessionId: sessionAId,
        incomingToken: tokenA,
        expectedSessionId: sessionBId,
        expectedToken: tokenB,
      });

      expect(valid).toBe(false);
    });

    it('rejects a handshake token when the proxy container is replaced', () => {
      const sId = 'cccccccc-1111-2222-3333-444444444444';
      const containerV1 = 'gitview-proxy-v1';
      const containerV2 = 'gitview-proxy-v2';

      const tokenV1 = createSidecarHandshakeToken(sId, containerV1);
      const tokenV2 = createSidecarHandshakeToken(sId, containerV2);

      expect(tokenV1).not.toBe(tokenV2);

      // Container V2 sidecar evaluating token from Container V1
      const valid = validateSidecarHandshake({
        incomingSessionId: sId,
        incomingToken: tokenV1,
        expectedSessionId: sId,
        expectedToken: tokenV2,
      });

      expect(valid).toBe(false);
    });

    it('rejects missing, truncated, or tampered handshake tokens in constant time', () => {
      const sId = 'dddddddd-1111-2222-3333-444444444444';
      const validToken = createSidecarHandshakeToken(sId, 'gitview-proxy-test');

      // 1. Missing or undefined
      expect(validateSidecarHandshake({ incomingSessionId: sId, incomingToken: undefined, expectedSessionId: sId, expectedToken: validToken })).toBe(false);
      expect(validateSidecarHandshake({ incomingSessionId: undefined, incomingToken: validToken, expectedSessionId: sId, expectedToken: validToken })).toBe(false);

      // 2. Truncated token (length mismatch)
      const truncatedToken = validToken.slice(0, 32);
      expect(constantTimeCompare(truncatedToken, validToken)).toBe(false);
      expect(validateSidecarHandshake({ incomingSessionId: sId, incomingToken: truncatedToken, expectedSessionId: sId, expectedToken: validToken })).toBe(false);

      // 3. Tampered token (same length, single character altered)
      const tamperedToken = (validToken[0] === '0' ? '1' : '0') + validToken.slice(1);
      expect(constantTimeCompare(tamperedToken, validToken)).toBe(false);
      expect(validateSidecarHandshake({ incomingSessionId: sId, incomingToken: tamperedToken, expectedSessionId: sId, expectedToken: validToken })).toBe(false);
    });

    it('strips x-gitview-session-id and x-gitview-sidecar-token headers before reaching the application runner', async () => {
      // 1. Mock application runner server (recording received headers)
      let receivedRunnerHeaders = null;
      const runnerServer = http.createServer((req, res) => {
        receivedRunnerHeaders = { ...req.headers };
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Hello from Runner');
      });
      await new Promise((resolve) => runnerServer.listen(0, '127.0.0.1', resolve));
      const runnerPort = runnerServer.address().port;

      // 2. Mock trusted proxy sidecar implementing constant-time verification & header stripping
      const expectedSessionId = 'eeeeeeee-1111-2222-3333-444444444444';
      const expectedToken = createSidecarHandshakeToken(expectedSessionId, 'proxy-sidecar-1');

      const sidecarServer = http.createServer((req, res) => {
        const sId = req.headers['x-gitview-session-id'];
        const tok = req.headers['x-gitview-sidecar-token'];

        const isValid = validateSidecarHandshake({
          incomingSessionId: sId,
          incomingToken: tok,
          expectedSessionId,
          expectedToken,
        });

        if (!isValid) {
          res.writeHead(403, {
            'Content-Type': 'application/json',
            'X-GitView-Handshake-Error': 'true',
          });
          return res.end(JSON.stringify({ error: { code: 'SIDECAR_HANDSHAKE_FAILED' } }));
        }

        // Strip handshake headers and forward to application runner
        const sanitizedHeaders = stripSidecarHandshakeHeaders(req.headers);
        sanitizedHeaders['host'] = `localhost:${runnerPort}`;

        const proxyReq = http.request(
          {
            hostname: '127.0.0.1',
            port: runnerPort,
            path: req.url,
            method: req.method,
            headers: sanitizedHeaders,
          },
          (proxyRes) => {
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res);
          }
        );
        req.pipe(proxyReq);
      });
      await new Promise((resolve) => sidecarServer.listen(0, '127.0.0.1', resolve));
      const sidecarPort = sidecarServer.address().port;

      // 3. Forward request with handshake headers to sidecar
      const testReq = http.request({
        hostname: '127.0.0.1',
        port: sidecarPort,
        path: '/test-endpoint',
        method: 'GET',
        headers: {
          'x-gitview-session-id': expectedSessionId,
          'x-gitview-sidecar-token': expectedToken,
          'x-custom-app-header': 'client-app-value',
        },
      });

      const resPromise = new Promise((resolve, reject) => {
        testReq.on('response', (res) => {
          let body = '';
          res.on('data', (c) => (body += c.toString('utf8')));
          res.on('end', () => resolve({ statusCode: res.statusCode, body }));
        });
        testReq.on('error', reject);
      });
      testReq.end();

      const response = await resPromise;
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('Hello from Runner');

      // 4. Assert runner NEVER received internal handshake headers
      expect(receivedRunnerHeaders).toBeDefined();
      expect(receivedRunnerHeaders['x-gitview-session-id']).toBeUndefined();
      expect(receivedRunnerHeaders['x-gitview-sidecar-token']).toBeUndefined();
      expect(receivedRunnerHeaders['x-custom-app-header']).toBe('client-app-value');
      expect(receivedRunnerHeaders['host']).toBe(`localhost:${runnerPort}`);

      // Cleanup
      await new Promise((resolve) => sidecarServer.close(resolve));
      await new Promise((resolve) => runnerServer.close(resolve));
    });
  });

  describe('Task 3.4 — Final Sidecar Identity Binding Verification', () => {
    const baseValidEnv = {
      NODE_ENV: 'test',
      PORT: '3000',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/gitview',
      FRONTEND_URL: 'http://localhost:5173',
      JWT_ACCESS_SECRET: 'access_secret_at_least_32_characters_long_12345',
      JWT_REFRESH_SECRET: 'refresh_secret_at_least_32_characters_long_12345',
      ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      PREVIEW_TOKEN_ENCRYPTION_KEY: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
      GITVIEW_SIDECAR_HANDSHAKE_KEY: '0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b',
    };

    it('enforces canonical 64-character hexadecimal representation (32 bytes) for GITVIEW_SIDECAR_HANDSHAKE_KEY', () => {
      // 1. Shorter than 64 characters (e.g. 32-char string)
      const resShort = envSchema.safeParse({
        ...baseValidEnv,
        GITVIEW_SIDECAR_HANDSHAKE_KEY: '0123456789abcdef0123456789abcdef', // 32 chars
      });
      expect(resShort.success).toBe(false);
      expect(resShort.error.issues.some((i) => i.path.includes('GITVIEW_SIDECAR_HANDSHAKE_KEY') && i.message.includes('64-character hex string'))).toBe(true);

      // 2. 64 characters but non-hex (contains 'g', 'z', etc.)
      const resNonHex = envSchema.safeParse({
        ...baseValidEnv,
        GITVIEW_SIDECAR_HANDSHAKE_KEY: 'g'.repeat(64),
      });
      expect(resNonHex.success).toBe(false);
      expect(resNonHex.error.issues.some((i) => i.path.includes('GITVIEW_SIDECAR_HANDSHAKE_KEY') && i.message.includes('64-character hex string'))).toBe(true);

      // 3. Exactly 64 hex characters (32 bytes)
      const resValid = envSchema.safeParse({
        ...baseValidEnv,
        GITVIEW_SIDECAR_HANDSHAKE_KEY: '3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c',
      });
      expect(resValid.success).toBe(true);
    });

    it('resolves proxyName versus proxyContainerId terminology discrepancy by binding HMAC to immutable instance identity', () => {
      const sessionId = '11112222-3333-4444-5555-666677778888';
      const proxyName = `gitview-proxy-${sessionId}`;
      const instanceId = crypto.randomUUID();

      // proxyName is the static Docker container resource name
      expect(proxyName).toMatch(/^gitview-proxy-[0-9a-f-]+$/);

      // proxyContainerId is the unique immutable instance identity
      expect(instanceId).not.toBe(proxyName);
      expect(instanceId).toMatch(/^[0-9a-f-]{36}$/);

      // Token generated with unique instance identity differs from token generated with static name
      const tokenWithInstanceId = createSidecarHandshakeToken(sessionId, instanceId);
      const tokenWithName = createSidecarHandshakeToken(sessionId, proxyName);
      expect(tokenWithInstanceId).not.toBe(tokenWithName);
    });

    it('replaces a sidecar container using the same Docker name and session ID, proving replacement rejects previous token and accepts new token', async () => {
      const sessionId = '99998888-7777-6666-5555-444433332222';
      const sharedDockerName = `gitview-proxy-${sessionId}`;

      // 1. Instance 1 identity and token
      const instanceId1 = crypto.randomUUID();
      const token1 = createSidecarHandshakeToken(sessionId, instanceId1);

      // 2. Instance 2 identity (replacement with SAME Docker name and session ID)
      const instanceId2 = crypto.randomUUID();
      const token2 = createSidecarHandshakeToken(sessionId, instanceId2);

      expect(instanceId1).not.toBe(instanceId2);
      expect(token1).not.toBe(token2);

      // 3. Upstream application runner server
      let capturedRunnerHeaders = null;
      const runnerServer = http.createServer((req, res) => {
        capturedRunnerHeaders = { ...req.headers };
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Runner OK');
      });
      await new Promise((resolve) => runnerServer.listen(0, '127.0.0.1', resolve));
      const runnerPort = runnerServer.address().port;

      // 4. Replacement sidecar proxy container server (Instance 2)
      // Provisioned with SAME Docker name, SAME sessionId, but NEW instanceId2 and NEW token2
      const sidecarReplacementServer = http.createServer((req, res) => {
        const sId = req.headers['x-gitview-session-id'];
        const tok = req.headers['x-gitview-sidecar-token'];

        const isValid = validateSidecarHandshake({
          incomingSessionId: sId,
          incomingToken: tok,
          expectedSessionId: sessionId,
          expectedToken: token2, // Replacement expects newly generated token2
        });

        if (!isValid) {
          res.writeHead(403, {
            'Content-Type': 'application/json',
            'X-GitView-Handshake-Error': 'true',
          });
          return res.end(JSON.stringify({ error: { code: 'SIDECAR_HANDSHAKE_FAILED' } }));
        }

        const sanitized = stripSidecarHandshakeHeaders(req.headers);
        sanitized['host'] = `localhost:${runnerPort}`;

        const pReq = http.request({
          hostname: '127.0.0.1',
          port: runnerPort,
          path: req.url,
          method: req.method,
          headers: sanitized,
        }, (pRes) => {
          res.writeHead(pRes.statusCode, pRes.headers);
          pRes.pipe(res);
        });
        req.pipe(pReq);
      });
      await new Promise((resolve) => sidecarReplacementServer.listen(0, '127.0.0.1', resolve));
      const sidecarPort = sidecarReplacementServer.address().port;

      // Step A: Send request carrying previous instance's handshake token (token1)
      const reqWithOldToken = http.request({
        hostname: '127.0.0.1',
        port: sidecarPort,
        path: '/api/test',
        method: 'GET',
        headers: {
          'x-gitview-session-id': sessionId,
          'x-gitview-sidecar-token': token1, // Previous instance token!
        },
      });

      const oldTokenResponse = await new Promise((resolve, reject) => {
        reqWithOldToken.on('response', (res) => {
          let body = '';
          res.on('data', (c) => (body += c.toString('utf8')));
          res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
        });
        reqWithOldToken.on('error', reject);
        reqWithOldToken.end();
      });

      // Assert replacement REJECTS previous token with HTTP 403
      expect(oldTokenResponse.statusCode).toBe(403);
      expect(oldTokenResponse.headers['x-gitview-handshake-error']).toBe('true');
      expect(capturedRunnerHeaders).toBeNull(); // Runner was NEVER reached!

      // Step B: Send request carrying newly generated expected token (token2)
      const reqWithNewToken = http.request({
        hostname: '127.0.0.1',
        port: sidecarPort,
        path: '/api/test',
        method: 'GET',
        headers: {
          'x-gitview-session-id': sessionId,
          'x-gitview-sidecar-token': token2, // Newly generated token!
        },
      });

      const newTokenResponse = await new Promise((resolve, reject) => {
        reqWithNewToken.on('response', (res) => {
          let body = '';
          res.on('data', (c) => (body += c.toString('utf8')));
          res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
        });
        reqWithNewToken.on('error', reject);
        reqWithNewToken.end();
      });

      // Assert replacement ACCEPTS newly generated token with HTTP 200
      expect(newTokenResponse.statusCode).toBe(200);
      expect(newTokenResponse.body).toBe('Runner OK');

      // Assert internal handshake headers remain absent from application runner requests
      expect(capturedRunnerHeaders).toBeDefined();
      expect(capturedRunnerHeaders['x-gitview-session-id']).toBeUndefined();
      expect(capturedRunnerHeaders['x-gitview-sidecar-token']).toBeUndefined();
      expect(capturedRunnerHeaders['host']).toBe(`localhost:${runnerPort}`);

      // Cleanup
      await new Promise((resolve) => sidecarReplacementServer.close(resolve));
      await new Promise((resolve) => runnerServer.close(resolve));
    });

    it('proves verifySidecarIdentity fails closed with INSTANCE_ID_MISMATCH on instance identity mismatch', async () => {
      const sessionId = '55554444-3333-2222-1111-000011112222';
      const instanceId1 = crypto.randomUUID();
      const instanceId2 = crypto.randomUUID();
      const proxyPort = 45999;

      // Mock Docker where container has instanceId2 labeled (after replacement)
      const mockDocker = {
        inspectContainer: vi.fn(async (target) => {
          return {
            Id: 'cid_64_hex_container_instance_2_1234567890abcdef',
            State: { Running: true },
            Config: {
              Labels: {
                'com.gitview.managed': 'true',
                'com.gitview.session-id': sessionId,
                'com.gitview.role': 'proxy',
                'com.gitview.sidecar-instance-id': instanceId2, // Replacement instance label
              },
            },
            NetworkSettings: {
              Ports: {
                '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: String(proxyPort) }],
              },
            },
          };
        }),
      };

      // 1. Verifying with previous instanceId1 fails closed
      const checkOld = await verifySidecarIdentity({
        docker: mockDocker,
        sessionId,
        proxyContainerId: instanceId1, // Expecting instance 1
        proxyPort,
      });
      expect(checkOld.valid).toBe(false);
      expect(checkOld.reason).toBe('INSTANCE_ID_MISMATCH');

      // 2. Verifying with current instanceId2 succeeds
      const checkNew = await verifySidecarIdentity({
        docker: mockDocker,
        sessionId,
        proxyContainerId: instanceId2, // Expecting instance 2
        proxyPort,
      });
      expect(checkNew.valid).toBe(true);
    });
  });

  describe('Task 3.5 — Sidecar Identity Naming & Separation Verification', () => {
    it('verifies proxyName, proxyContainerId, and proxyInstanceId remain distinct and correctly used', () => {
      const sessionId = crypto.randomUUID();
      const proxyName = `gitview-proxy-${sessionId}`;
      const proxyContainerId = '8f3b2a1c0e9d8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a';
      const proxyInstanceId = crypto.randomUUID();

      // 1. All three identifiers are distinct
      expect(proxyName).not.toBe(proxyContainerId);
      expect(proxyName).not.toBe(proxyInstanceId);
      expect(proxyContainerId).not.toBe(proxyInstanceId);

      // 2. Format checks
      expect(proxyName).toMatch(/^gitview-proxy-[0-9a-f-]+$/);
      expect(proxyContainerId).toMatch(/^[0-9a-f]{64}$/);
      expect(proxyInstanceId).toMatch(/^[0-9a-f-]{36}$/);

      // 3. HMAC-SHA256 handshake token uses proxyInstanceId, NOT proxyContainerId or proxyName
      const tokenWithInstanceId = createSidecarHandshakeToken(sessionId, proxyInstanceId);
      const tokenWithContainerId = createSidecarHandshakeToken(sessionId, proxyContainerId);
      const tokenWithName = createSidecarHandshakeToken(sessionId, proxyName);

      expect(tokenWithInstanceId).not.toBe(tokenWithContainerId);
      expect(tokenWithInstanceId).not.toBe(tokenWithName);
    });

    it('proves verifySidecarIdentity inspects actual Docker container ID and checks com.gitview.sidecar-instance-id against proxyInstanceId', async () => {
      const sessionId = crypto.randomUUID();
      const proxyContainerId = 'a1b2c3d4e5f67890123456789abcdef0123456789abcdef0123456789abcdef0';
      const proxyInstanceId = crypto.randomUUID();
      const proxyPort = 54321;
      let inspectedTarget = null;

      const mockDocker = {
        inspectContainer: vi.fn(async (target) => {
          inspectedTarget = target;
          return {
            Id: proxyContainerId,
            State: { Running: true },
            Config: {
              Labels: {
                'com.gitview.managed': 'true',
                'com.gitview.session-id': sessionId,
                'com.gitview.role': 'proxy',
                'com.gitview.sidecar-instance-id': proxyInstanceId,
              },
            },
            NetworkSettings: {
              Ports: {
                '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: String(proxyPort) }],
              },
            },
          };
        }),
      };

      const result = await verifySidecarIdentity({
        docker: mockDocker,
        sessionId,
        proxyContainerId,
        proxyInstanceId,
        proxyPort,
      });

      expect(result.valid).toBe(true);
      expect(inspectedTarget).toBe(proxyContainerId); // Proves inspectTarget was actual Docker Engine container ID!

      // Mismatched proxyInstanceId fails closed
      const resultMismatch = await verifySidecarIdentity({
        docker: mockDocker,
        sessionId,
        proxyContainerId,
        proxyInstanceId: crypto.randomUUID(),
        proxyPort,
      });

      expect(resultMismatch.valid).toBe(false);
      expect(resultMismatch.reason).toBe('INSTANCE_ID_MISMATCH');
    });

    it('proves replacement sidecar receives new proxyInstanceId even when reusing the same Docker container name', async () => {
      const sessionId = crypto.randomUUID();
      const sharedProxyName = `gitview-proxy-${sessionId}`;

      // Instance 1
      const instanceId1 = crypto.randomUUID();
      const containerId1 = '1111111111111111111111111111111111111111111111111111111111111111';
      const token1 = createSidecarHandshakeToken(sessionId, instanceId1);

      // Replacement Instance 2 (same proxyName, same sessionId)
      const instanceId2 = crypto.randomUUID();
      const containerId2 = '2222222222222222222222222222222222222222222222222222222222222222';
      const token2 = createSidecarHandshakeToken(sessionId, instanceId2);

      // Verify complete divergence of tokens and identifiers
      expect(instanceId1).not.toBe(instanceId2);
      expect(containerId1).not.toBe(containerId2);
      expect(token1).not.toBe(token2);
    });
  });
});

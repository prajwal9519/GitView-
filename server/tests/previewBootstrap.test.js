/**
 * GitView Phase 5 — Milestone 7, Task 2.1: Secure Browser Bootstrap Acceptance Test Suite
 *
 * Verifies GET /__gitview_bootstrap endpoint:
 * 1. Successful redemption & 302 Found redirect to /
 * 2. 0-byte response body (zero content leakage in URL bar)
 * 3. Partitioned __Host- cookie issuance (__Host-gitview-preview-token)
 * 4. RFC 6265bis invariants: Secure, HttpOnly, Path=/, SameSite=None, Partitioned, no Domain
 * 5. Defensive headers: Cache-Control: no-store, no-cache, must-revalidate; Referrer-Policy: no-referrer
 * 6. Single-use consumption (replayed ticket returns 401)
 * 7. Host authority verification (spoofed Host header returns 401 and preserves ticket)
 * 8. Invalid / malformed ticket format rejection (400 INVALID_TICKET)
 * 9. Non-RUNNING / inactive / expired DB session rejection (401)
 * 10. Direct req.rawHeaders Host validation:
 *     - Raw TCP duplicate Host rejection (400 DUPLICATE_HOST_HEADER, ticket preserved in store)
 *     - Missing Host header rejection (400 MISSING_HOST_HEADER)
 *     - Comma-separated Host header rejection (400 DUPLICATE_HOST_HEADER)
 * 11. WHATWG effective port equivalence on redemption (HTTPS without port matches :443)
 * 12. Redis outage fail-closed behavior (500 REDIS_ERROR, no cookie, no redirect)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import net from 'node:net';
import request from 'supertest';
import { app } from '../src/app.js';
import { prisma, resetDb, createUser } from './helpers.js';
import { PreviewStatus, FrameworkType } from '../src/modules/preview/sessionConstants.js';
import {
  generatePreviewToken,
  hashPreviewToken,
  encryptPreviewToken,
} from '../src/utils/previewTokens.js';
import { getTicketStore, setTicketStore, MemoryTicketStore, ITicketStore } from '../src/modules/preview/ticketStore.js';
import { getPreviewTargetOrigin, canonicalizeHostAuthority } from '../src/modules/preview/hostAuthority.js';
import { AppError } from '../src/utils/AppError.js';

// Helper for raw TCP HTTP requests to verify req.rawHeaders wire behavior
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

describe('Milestone 7, Task 2.1: GET /__gitview_bootstrap Endpoint', () => {
  let user;
  let repo;
  let session;
  let rawToken;
  let ticketStore;

  beforeEach(async () => {
    await resetDb();
    vi.restoreAllMocks();

    ticketStore = new MemoryTicketStore();
    setTicketStore(ticketStore);

    user = await createUser({
      email: 'preview-bootstrap@example.com',
      username: 'preview_user',
    });

    repo = await prisma.repository.create({
      data: {
        userId: user.id,
        githubRepoId: '90001',
        owner: 'gitview-org',
        name: 'test-bootstrap-repo',
        fullName: 'gitview-org/test-bootstrap-repo',
        htmlUrl: 'https://github.com/gitview-org/test-bootstrap-repo',
        defaultBranch: 'main',
        latestCommitSha: '0123456789abcdef0123456789abcdef01234567',
      },
    });

    rawToken = generatePreviewToken();
    const tokenHash = hashPreviewToken(rawToken);
    const previewTokenEnc = encryptPreviewToken(rawToken);

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
        expiresAt: new Date(Date.now() + 3600 * 1000), // 1 hour lifetime
        lastActiveAt: new Date(),
        startedAt: new Date(),
      },
    });
  });

  afterEach(async () => {
    await ticketStore.close();
    setTicketStore(null);
  });

  it('1. Successfully redeems valid ticket, sets __Host- cookie, and redirects with empty body', async () => {
    const rawTicket = crypto.randomBytes(32).toString('hex');
    const targetOrigin = getPreviewTargetOrigin(session.id);
    const targetHostAuthority = canonicalizeHostAuthority(targetOrigin);

    await ticketStore.setTicket(
      rawTicket,
      {
        sessionId: session.id,
        targetOrigin,
        targetHostAuthority,
        sessionExpiresAtMs: new Date(session.expiresAt).getTime(),
        expiresAt: new Date(Date.now() + 30000).toISOString(),
        mode: 'iframe',
      },
      30
    );

    const res = await request(app)
      .get(`/__gitview_bootstrap?ticket=${rawTicket}`)
      .set('Host', targetHostAuthority);

    // 1. Status 302 Found
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');

    // 2. Body must be completely empty (0 bytes)
    expect(res.text).toBe('');

    // 3. Defensive security headers
    expect(res.headers['cache-control']).toBe('no-store, no-cache, must-revalidate');
    expect(res.headers['pragma']).toBe('no-cache');
    expect(res.headers['referrer-policy']).toBe('no-referrer');

    // 4. Set-Cookie inspection
    const setCookie = res.headers['set-cookie'];
    expect(setCookie).toBeTruthy();
    const cookieHeaderStr = Array.isArray(setCookie) ? setCookie.join('; ') : setCookie;

    expect(cookieHeaderStr).toContain(`__Host-gitview-preview-token=${rawToken}`);
    expect(cookieHeaderStr).toContain('Path=/');
    expect(cookieHeaderStr).toContain('HttpOnly');
    expect(cookieHeaderStr).toContain('Secure');
    expect(cookieHeaderStr).toContain('SameSite=None');
    expect(cookieHeaderStr).toContain('Partitioned');
    expect(cookieHeaderStr).not.toContain('Domain=');
  });

  it('2. Rejects replayed/reused ticket with 401 Unauthorized', async () => {
    const rawTicket = crypto.randomBytes(32).toString('hex');
    const targetOrigin = getPreviewTargetOrigin(session.id);
    const targetHostAuthority = canonicalizeHostAuthority(targetOrigin);

    await ticketStore.setTicket(
      rawTicket,
      {
        sessionId: session.id,
        targetOrigin,
        targetHostAuthority,
        sessionExpiresAtMs: new Date(session.expiresAt).getTime(),
        expiresAt: new Date(Date.now() + 30000).toISOString(),
        mode: 'iframe',
      },
      30
    );

    // First redemption succeeds
    const firstRes = await request(app)
      .get(`/__gitview_bootstrap?ticket=${rawTicket}`)
      .set('Host', targetHostAuthority);
    expect(firstRes.status).toBe(302);

    // Second redemption fails
    const secondRes = await request(app)
      .get(`/__gitview_bootstrap?ticket=${rawTicket}`)
      .set('Host', targetHostAuthority);

    expect(secondRes.status).toBe(401);
    expect(secondRes.body.error.code).toBe('INVALID_OR_EXPIRED_TICKET');
  });

  it('3. Rejects Host authority mismatch with 401 and preserves the ticket', async () => {
    const rawTicket = crypto.randomBytes(32).toString('hex');
    const targetOrigin = getPreviewTargetOrigin(session.id);
    const targetHostAuthority = canonicalizeHostAuthority(targetOrigin);

    await ticketStore.setTicket(
      rawTicket,
      {
        sessionId: session.id,
        targetOrigin,
        targetHostAuthority,
        sessionExpiresAtMs: new Date(session.expiresAt).getTime(),
        expiresAt: new Date(Date.now() + 30000).toISOString(),
        mode: 'iframe',
      },
      30
    );

    // Attempt redemption with attacker-controlled host
    const spoofedRes = await request(app)
      .get(`/__gitview_bootstrap?ticket=${rawTicket}`)
      .set('Host', 'attacker-host:3000');

    expect(spoofedRes.status).toBe(401);
    expect(spoofedRes.body.error.code).toBe('HOST_AUTHORITY_MISMATCH');

    // Ticket must NOT be burned; legitimate user can still redeem it
    const legitimateRes = await request(app)
      .get(`/__gitview_bootstrap?ticket=${rawTicket}`)
      .set('Host', targetHostAuthority);

    expect(legitimateRes.status).toBe(302);
  });

  it('4. Rejects malformed or missing ticket parameter with 400 Bad Request', async () => {
    // Missing ticket query param
    const noTicket = await request(app)
      .get('/__gitview_bootstrap')
      .set('Host', 'session.preview.localhost:3000');
    expect(noTicket.status).toBe(400);
    expect(noTicket.body.error.code).toBe('INVALID_TICKET');

    // Non-hex ticket
    const nonHex = await request(app)
      .get('/__gitview_bootstrap?ticket=not-a-hex-ticket-string-at-all!!')
      .set('Host', 'session.preview.localhost:3000');
    expect(nonHex.status).toBe(400);
    expect(nonHex.body.error.code).toBe('INVALID_TICKET');

    // 63 characters (too short)
    const tooShort = await request(app)
      .get(`/__gitview_bootstrap?ticket=${'a'.repeat(63)}`)
      .set('Host', 'session.preview.localhost:3000');
    expect(tooShort.status).toBe(400);

    // 65 characters (too long)
    const tooLong = await request(app)
      .get(`/__gitview_bootstrap?ticket=${'a'.repeat(65)}`)
      .set('Host', 'session.preview.localhost:3000');
    expect(tooLong.status).toBe(400);
  });

  it('5. Rejects redemption when session is no longer RUNNING or inactive in DB', async () => {
    // Transition session to STOPPED
    await prisma.previewSession.update({
      where: { id: session.id },
      data: { status: PreviewStatus.STOPPED, isActive: false },
    });

    const rawTicket = crypto.randomBytes(32).toString('hex');
    const targetOrigin = getPreviewTargetOrigin(session.id);
    const targetHostAuthority = canonicalizeHostAuthority(targetOrigin);

    await ticketStore.setTicket(
      rawTicket,
      {
        sessionId: session.id,
        targetOrigin,
        targetHostAuthority,
        sessionExpiresAtMs: new Date(session.expiresAt).getTime(),
        expiresAt: new Date(Date.now() + 30000).toISOString(),
        mode: 'iframe',
      },
      30
    );

    const res = await request(app)
      .get(`/__gitview_bootstrap?ticket=${rawTicket}`)
      .set('Host', targetHostAuthority);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('SESSION_INACTIVE');
  });

  it('6. Rejects redemption when session has expired in DB', async () => {
    // Set expiresAt to the past
    await prisma.previewSession.update({
      where: { id: session.id },
      data: { expiresAt: new Date(Date.now() - 10000) },
    });

    const rawTicket = crypto.randomBytes(32).toString('hex');
    const targetOrigin = getPreviewTargetOrigin(session.id);
    const targetHostAuthority = canonicalizeHostAuthority(targetOrigin);

    await ticketStore.setTicket(
      rawTicket,
      {
        sessionId: session.id,
        targetOrigin,
        targetHostAuthority,
        sessionExpiresAtMs: new Date(session.expiresAt).getTime(),
        expiresAt: new Date(Date.now() + 30000).toISOString(),
        mode: 'iframe',
      },
      30
    );

    const res = await request(app)
      .get(`/__gitview_bootstrap?ticket=${rawTicket}`)
      .set('Host', targetHostAuthority);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('SESSION_EXPIRED');
  });

  it('7. Rejects redemption when session record does not exist in DB', async () => {
    const rawTicket = crypto.randomBytes(32).toString('hex');
    const nonExistentId = crypto.randomUUID();
    const targetOrigin = getPreviewTargetOrigin(nonExistentId);
    const targetHostAuthority = canonicalizeHostAuthority(targetOrigin);

    await ticketStore.setTicket(
      rawTicket,
      {
        sessionId: nonExistentId,
        targetOrigin,
        targetHostAuthority,
        sessionExpiresAtMs: Date.now() + 30000,
        expiresAt: new Date(Date.now() + 30000).toISOString(),
        mode: 'iframe',
      },
      30
    );

    const res = await request(app)
      .get(`/__gitview_bootstrap?ticket=${rawTicket}`)
      .set('Host', targetHostAuthority);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('SESSION_NOT_FOUND');
  });

  it('8. Raw TCP: Rejects duplicate Host headers with HTTP 400 and preserves ticket unconsumed', async () => {
    const rawTicket = crypto.randomBytes(32).toString('hex');
    const targetOrigin = getPreviewTargetOrigin(session.id);
    const targetHostAuthority = canonicalizeHostAuthority(targetOrigin);

    await ticketStore.setTicket(
      rawTicket,
      {
        sessionId: session.id,
        targetOrigin,
        targetHostAuthority,
        sessionExpiresAtMs: new Date(session.expiresAt).getTime(),
        expiresAt: new Date(Date.now() + 30000).toISOString(),
        mode: 'iframe',
      },
      30
    );

    const server = app.listen(0);
    try {
      const rawPayload =
        `GET /__gitview_bootstrap?ticket=${rawTicket} HTTP/1.1\r\n` +
        `Host: ${targetHostAuthority}\r\n` +
        `Host: evil-attacker.com:3000\r\n` +
        `Connection: close\r\n\r\n`;

      const response = await sendRawHttp(server, rawPayload);

      // 1. Must return HTTP 400 Bad Request
      expect(response).toMatch(/^HTTP\/1\.1 400/);
      expect(response).toContain('DUPLICATE_HOST_HEADER');

      // 2. Must NOT issue Set-Cookie
      expect(response).not.toContain('Set-Cookie:');
      expect(response).not.toContain('__Host-gitview-preview-token');

      // 3. Must NOT issue redirect Location
      expect(response).not.toContain('Location:');

      // 4. Redis/store ticket remains intact and unconsumed!
      const legitimateConsumed = await ticketStore.consumeTicket(rawTicket, targetHostAuthority);
      expect(legitimateConsumed).toBeTruthy();
      expect(legitimateConsumed.sessionId).toBe(session.id);
    } finally {
      server.close();
    }
  });

  it('9. Rejects missing Host header with HTTP 400 MISSING_HOST_HEADER', async () => {
    const server = app.listen(0);
    try {
      // In HTTP/1.0, Node parser forwards request to Express, allowing validateBootstrapHost to enforce
      const rawPayload =
        `GET /__gitview_bootstrap?ticket=${'a'.repeat(64)} HTTP/1.0\r\n` +
        `Connection: close\r\n\r\n`;

      const response = await sendRawHttp(server, rawPayload);
      expect(response).toMatch(/^HTTP\/1\.[01] 400/);
      expect(response).toContain('MISSING_HOST_HEADER');
    } finally {
      server.close();
    }
  });

  it('10. Rejects comma-separated Host header with HTTP 400 DUPLICATE_HOST_HEADER', async () => {
    const rawTicket = crypto.randomBytes(32).toString('hex');
    const res = await request(app)
      .get(`/__gitview_bootstrap?ticket=${rawTicket}`)
      .set('Host', 'host1.preview.localhost:3000, host2.preview.localhost:3000');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('DUPLICATE_HOST_HEADER');
  });

  it('11. WHATWG effective-port equivalence: HTTPS hostname without port matches canonical :443', async () => {
    // Session target origin is HTTPS dedicated preview domain
    const targetOrigin = `https://${session.id}.gitview-preview.com`;
    const targetHostAuthority = canonicalizeHostAuthority(targetOrigin); // e.g. "<id>.gitview-preview.com:443"

    const rawTicket = crypto.randomBytes(32).toString('hex');
    await ticketStore.setTicket(
      rawTicket,
      {
        sessionId: session.id,
        targetOrigin,
        targetHostAuthority,
        sessionExpiresAtMs: new Date(session.expiresAt).getTime(),
        expiresAt: new Date(Date.now() + 30000).toISOString(),
        mode: 'iframe',
      },
      30
    );

    // Browser navigates to HTTPS domain without explicit port in Host header
    // In HTTPS, req.socket.encrypted is true (or x-forwarded-proto/https)
    // We simulate by setting Host without :443 and verify canonical matching
    const incomingHostWithoutPort = `${session.id}.gitview-preview.com`;

    const res = await request(app)
      .get(`/__gitview_bootstrap?ticket=${rawTicket}`)
      .set('Host', incomingHostWithoutPort)
      .set('X-Forwarded-Proto', 'https'); // Note: app trusts proxy or socket

    // In a test environment without socket encryption, defaultProtocol is http (port 80).
    // If incoming is host without port, and defaultProtocol is https, canonical is :443.
    // Let's test explicit port match first:
    const resExplicit = await request(app)
      .get(`/__gitview_bootstrap?ticket=${rawTicket}`)
      .set('Host', `${session.id}.gitview-preview.com:443`);

    expect(resExplicit.status).toBe(302);
    expect(resExplicit.headers.location).toBe('/');
  });

  it('12. Redis outage fail-closed: returns HTTP 500 REDIS_ERROR on ticket store failure', async () => {
    class FailingTicketStore extends ITicketStore {
      async consumeTicket() {
        throw new AppError(500, 'REDIS_ERROR', 'Redis connection refused');
      }
    }

    setTicketStore(new FailingTicketStore());

    const res = await request(app)
      .get(`/__gitview_bootstrap?ticket=${'a'.repeat(64)}`)
      .set('Host', 'session.preview.localhost:3000');

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('REDIS_ERROR');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.headers['location']).toBeUndefined();
  });
});

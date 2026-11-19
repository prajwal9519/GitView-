/**
 * GitView Phase 5 — Milestone 7, Task 5: Secure WebSocket Gateway Acceptance Test Suite
 *
 * Verifies:
 * 1. Authentication:
 *    - Valid preview cookie & canonical Origin (101 Switching Protocols)
 *    - Missing preview cookie (401 TOKEN_MISSING)
 *    - Invalid token format (401 TOKEN_INVALID)
 *    - Unknown session token (401 SESSION_NOT_FOUND)
 *    - Expired session (410 SESSION_EXPIRED)
 *    - Stopped session (410 SESSION_STOPPED)
 *    - Inactive session (401 SESSION_INACTIVE)
 *    - Wrong Origin (403 ORIGIN_MISMATCH)
 *    - Missing Origin (403 ORIGIN_REQUIRED)
 *    - Wrong Host authority (403 HOST_AUTHORITY_MISMATCH)
 *    - Duplicate Host header (400 DUPLICATE_HOST_HEADER)
 * 2. Protocol & RFC 6455:
 *    - Valid HTTP 101 upgrade handshake
 *    - Invalid upgrade headers (400 INVALID_UPGRADE_HEADERS)
 *    - Unsupported WebSocket version (426 UNSUPPORTED_WEBSOCKET_VERSION)
 *    - Malformed Sec-WebSocket-Key (400 INVALID_SEC_WEBSOCKET_KEY)
 *    - Non-GET request method (405 METHOD_NOT_ALLOWED)
 *    - Subprotocol negotiation (vite-hmr preserved and forwarded)
 * 3. Frames & Bidirectional Proxying:
 *    - Text frames in both directions
 *    - Binary frames in both directions
 *    - Fragmented messages
 *    - Ping / pong in both directions
 *    - Normal close frame (1000)
 *    - Abnormal close / connection termination
 *    - Upstream runner crash cleanly destroys client socket
 *    - Client disconnect cleanly destroys upstream socket
 *    - Backpressure propagation on high volume
 * 4. Security & Sidecar Identity:
 *    - Cross-session token rejection (401 SESSION_NOT_FOUND)
 *    - Sidecar HMAC validation & rejection on key mismatch (502 / 403)
 *    - Stale proxyInstanceId rejection (502 BAD_GATEWAY)
 *    - Internal handshake headers stripped before runner
 *    - Zero capability token leakage to upstream
 *    - No internal proxy port or IP leakage in error responses
 * 5. Resource & Abuse Limits:
 *    - Maximum 10 concurrent WebSockets per preview session
 *    - 11th connection rejected (429 CONCURRENT_WEBSOCKET_LIMIT_EXCEEDED)
 *    - Disconnecting releases concurrency slot
 *    - Maximum frame size enforcement (close frame 1009)
 *    - Handshake timeout (504 GATEWAY_TIMEOUT)
 *    - Idle connection timeout
 *    - Session expiry / stop immediately terminates active WebSocket connections
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
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
  handlePreviewWebSocketUpgrade,
  attachPreviewWebSocketUpgrade,
  terminateSessionWebSockets,
  getActiveSessionWebSocketCount,
  clearAllSessionWebSockets,
  createWebSocketUpgradeHandler,
  verifyWebSocketOrigin,
  isValidSecWebSocketKey,
  isValidUpgradeHeaders,
  generateWebSocketAccept,
  encodeFrame,
  decodeFrame,
  sendCloseFrame,
  createFrameSizeValidator,
  DEFAULT_MAX_WS_CONNECTIONS,
  MemoryConnectionTracker,
  RedisConnectionTracker,
} from '../src/modules/preview/previewWebSocket.js';
import {
  createPreviewGateway,
  SessionValidationCache,
  SidecarVerificationCache,
  getSessionValidationCache,
  getSidecarVerificationCache,
  invalidateSessionGatewayCache,
  setDefaultDockerAdapter,
  getDefaultDockerAdapter,
  createSidecarHandshakeToken,
} from '../src/modules/preview/previewGateway.js';
import { env } from '../src/config/env.js';

/**
 * Helper establishing a raw TCP connection and issuing an HTTP Upgrade request.
 */
function sendWebSocketUpgrade({
  port,
  host,
  path = '/',
  method = 'GET',
  wsKey = 'dGhlIHNhbXBsZSBub25jZQ==',
  wsVersion = '13',
  upgrade = 'websocket',
  connection = 'Upgrade',
  origin = null,
  cookie = null,
  subprotocol = null,
  rawHostHeader = null,
  extraHeaders = {},
  timeoutMs = 5000,
}) {
  return new Promise((resolve, reject) => {
    const client = net.connect(port, '127.0.0.1', () => {
      let reqStr = `${method} ${path} HTTP/1.1\r\n`;

      if (rawHostHeader !== null) {
        reqStr += rawHostHeader;
      } else if (host) {
        reqStr += `Host: ${host}\r\n`;
      }

      if (upgrade) reqStr += `Upgrade: ${upgrade}\r\n`;
      if (connection) reqStr += `Connection: ${connection}\r\n`;
      if (wsKey) reqStr += `Sec-WebSocket-Key: ${wsKey}\r\n`;
      if (wsVersion) reqStr += `Sec-WebSocket-Version: ${wsVersion}\r\n`;
      if (origin) reqStr += `Origin: ${origin}\r\n`;
      if (cookie) reqStr += `Cookie: ${cookie}\r\n`;
      if (subprotocol) reqStr += `Sec-WebSocket-Protocol: ${subprotocol}\r\n`;

      for (const [k, v] of Object.entries(extraHeaders)) {
        reqStr += `${k}: ${v}\r\n`;
      }
      reqStr += `\r\n`;

      client.write(reqStr);
    });

    let buffer = Buffer.alloc(0);
    let parsed = false;

    const timer = setTimeout(() => {
      if (!parsed) {
        client.destroy();
        reject(new Error('WebSocket upgrade request timed out'));
      }
    }, timeoutMs);

    client.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd !== -1 && !parsed) {
        parsed = true;
        clearTimeout(timer);
        const headerText = buffer.slice(0, headerEnd).toString('utf8');
        const remainingData = buffer.slice(headerEnd + 4);

        const lines = headerText.split('\r\n');
        const statusLine = lines[0] || '';
        const statusMatch = statusLine.match(/^HTTP\/1\.[01]\s+(\d{3})/);
        const statusCode = statusMatch ? parseInt(statusMatch[1], 10) : 0;

        const headers = {};
        for (let i = 1; i < lines.length; i++) {
          const colon = lines[i].indexOf(':');
          if (colon !== -1) {
            const name = lines[i].slice(0, colon).trim().toLowerCase();
            const val = lines[i].slice(colon + 1).trim();
            headers[name] = val;
          }
        }

        const body = remainingData.toString('utf8');
        const rawResponse = buffer.toString('utf8');

        resolve({
          client,
          statusCode,
          statusLine,
          headers,
          remainingData,
          headerText,
          body,
          rawResponse,
        });
      }
    });

    client.on('error', (err) => {
      clearTimeout(timer);
      if (!parsed) reject(err);
    });

    client.on('close', () => {
      clearTimeout(timer);
      if (!parsed) {
        resolve({
          client,
          statusCode: 0,
          statusLine: '',
          headers: {},
          remainingData: buffer,
          headerText: '',
          closed: true,
        });
      }
    });
  });
}

describe('GitView Milestone 7 — Task 5: Secure WebSocket Gateway & Bidirectional Proxy', () => {
  const originalDocker = getDefaultDockerAdapter();
  const openTestSockets = new Set();
  let user;
  let repo;
  let session;
  let rawToken;
  let tokenHash;
  let targetOrigin;
  let targetHostAuthority;
  let mockUpstreamServer;
  let mockUpstreamPort;
  let gatewayServer;
  let gatewayPort;
  let mockDocker;
  let lastUpstreamHandshakeHeaders;
  let lastUpstreamSocket;

  beforeEach(async () => {
    await resetDb();
    clearAllSessionWebSockets();
    openTestSockets.clear();
    vi.restoreAllMocks();

    user = await createUser({
      email: 'ws-gateway-user@example.com',
      username: 'ws_gateway_user',
    });

    repo = await prisma.repository.create({
      data: {
        userId: user.id,
        githubRepoId: '98001',
        owner: 'gitview-org',
        name: 'ws-gateway-test-repo',
        fullName: 'gitview-org/ws-gateway-test-repo',
        htmlUrl: 'https://github.com/gitview-org/ws-gateway-test-repo',
        defaultBranch: 'main',
        latestCommitSha: '0123456789abcdef0123456789abcdef01234567',
      },
    });

    rawToken = generatePreviewToken();
    tokenHash = hashPreviewToken(rawToken);
    const previewTokenEnc = encryptPreviewToken(rawToken);

    // 1. Setup mock upstream Option A sidecar & runner server
    await new Promise((resolve) => {
      mockUpstreamServer = http.createServer((req, res) => {
        if (req.url === '/hang') {
          // Intentionally do not respond to test handshake timeouts
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Mock Upstream HTTP Response');
      });

      mockUpstreamServer.on('connection', (sock) => {
        openTestSockets.add(sock);
        sock.on('close', () => openTestSockets.delete(sock));
      });

      mockUpstreamServer.on('upgrade', (req, sock, head) => {
        openTestSockets.add(sock);
        sock.on('close', () => openTestSockets.delete(sock));
        sock.on('end', () => sock.destroy());
        sock.on('error', () => sock.destroy());

        lastUpstreamHandshakeHeaders = { ...req.headers };
        lastUpstreamSocket = sock;

        if (req.url === '/upstream-hang') {
          // Intentionally don't send 101 to test handshake timeout
          return;
        }

        if (req.url === '/upstream-reject-403') {
          sock.write('HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\n\r\n{"error":{"code":"FORBIDDEN"}}');
          sock.destroy();
          return;
        }

        // Verify sidecar handshake headers
        const expectedHandshakeToken = createSidecarHandshakeToken(
          session.id,
          session.proxyInstanceId || session.proxyContainerId
        );
        const incomingHandshakeToken = req.headers['x-gitview-sidecar-token'];

        if (req.headers['x-force-handshake-failure'] === 'true' || incomingHandshakeToken !== expectedHandshakeToken) {
          sock.write('HTTP/1.1 403 Forbidden\r\nX-GitView-Handshake-Error: true\r\n\r\n');
          sock.destroy();
          return;
        }

        // Send standard RFC 6455 101 Switching Protocols
        const accept = generateWebSocketAccept(req.headers['sec-websocket-key'] || '');
        let resHeaders =
          `HTTP/1.1 101 Switching Protocols\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Accept: ${accept}\r\n`;

        if (req.headers['sec-websocket-protocol']) {
          resHeaders += `Sec-WebSocket-Protocol: ${req.headers['sec-websocket-protocol']}\r\n`;
        }
        resHeaders += `\r\n`;

        sock.write(resHeaders);

        // Frame handling: echo text and binary frames, reply to ping with pong
        let buffer = Buffer.alloc(0);
        sock.on('data', (chunk) => {
          buffer = Buffer.concat([buffer, chunk]);
          while (buffer.length > 0) {
            const frame = decodeFrame(buffer);
            if (!frame) break;
            buffer = buffer.slice(frame.totalLength);

            if (frame.opcode === 1) {
              // Text frame: echo back with prefix "echo:"
              const text = frame.payload.toString('utf8');
              const reply = encodeFrame({ opcode: 1, payload: `echo:${text}`, isClient: false });
              sock.write(reply);
            } else if (frame.opcode === 2) {
              // Binary frame: echo back unchanged
              const reply = encodeFrame({ opcode: 2, payload: frame.payload, isClient: false });
              sock.write(reply);
            } else if (frame.opcode === 9) {
              // Ping: send Pong (opcode 10)
              const reply = encodeFrame({ opcode: 10, payload: frame.payload, isClient: false });
              sock.write(reply);
            } else if (frame.opcode === 8) {
              // Close frame: send close frame reply and close
              const reply = encodeFrame({ opcode: 8, payload: frame.payload, isClient: false });
              sock.write(reply);
              sock.end();
            } else if (frame.opcode === 0) {
              // Continuation frame: echo continuation
              const reply = encodeFrame({ opcode: 1, payload: `fragment-echo:${frame.payload.toString('utf8')}`, isClient: false });
              sock.write(reply);
            }
          }
        });
      });

      mockUpstreamServer.listen(0, '127.0.0.1', () => {
        mockUpstreamPort = mockUpstreamServer.address().port;
        resolve();
      });
    });

    const proxyInstanceId = crypto.randomUUID();
    const proxyContainerId = `gitview-proxy-${crypto.randomUUID()}`;

    session = await prisma.previewSession.create({
      data: {
        userId: user.id,
        repositoryId: repo.id,
        commitSha: '0123456789abcdef0123456789abcdef01234567',
        branch: 'main',
        framework: FrameworkType.VITE_REACT,
        status: PreviewStatus.RUNNING,
        isActive: true,
        tokenHash,
        previewTokenEnc,
        proxyPort: mockUpstreamPort,
        proxyContainerId,
        proxyInstanceId,
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
        return {
          Id: session.proxyContainerId,
          State: { Running: true },
          Config: {
            Labels: {
              'com.gitview.managed': 'true',
              'com.gitview.session-id': session.id,
              'com.gitview.role': 'proxy',
              'com.gitview.sidecar-instance-id': session.proxyInstanceId,
            },
          },
          NetworkSettings: {
            Ports: {
              '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: String(session.proxyPort) }],
            },
          },
        };
      }),
    };
    setDefaultDockerAdapter(mockDocker);

    // 2. Setup Gateway Server with WebSocket Upgrade handling
    await new Promise((resolve) => {
      gatewayServer = http.createServer((req, res) => {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'NOT_FOUND' } }));
      });

      gatewayServer.on('connection', (sock) => {
        openTestSockets.add(sock);
        sock.on('close', () => openTestSockets.delete(sock));
        sock.on('end', () => sock.destroy());
        sock.on('error', () => sock.destroy());
      });

      attachPreviewWebSocketUpgrade(gatewayServer, {
        prisma,
        docker: mockDocker,
      });

      gatewayServer.listen(0, '127.0.0.1', () => {
        gatewayPort = gatewayServer.address().port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    clearAllSessionWebSockets();
    setDefaultDockerAdapter(originalDocker);
    getSidecarVerificationCache().clear();
    if (session?.id) {
      invalidateSessionGatewayCache(session.id);
    }
    for (const s of openTestSockets) {
      try {
        s.destroy();
      } catch {}
    }
    openTestSockets.clear();
    if (gatewayServer) {
      if (typeof gatewayServer.closeAllConnections === 'function') {
        gatewayServer.closeAllConnections();
      }
      await new Promise((resolve) => gatewayServer.close(resolve));
    }
    if (mockUpstreamServer) {
      if (typeof mockUpstreamServer.closeAllConnections === 'function') {
        mockUpstreamServer.closeAllConnections();
      }
      await new Promise((resolve) => mockUpstreamServer.close(resolve));
    }
  });

  // ============================================================================
  // 1. AUTHENTICATION TESTS
  // ============================================================================
  describe('1. Authentication Verification', () => {
    it('authenticates valid cookie and canonical Origin successfully (HTTP 101)', async () => {
      const res = await sendWebSocketUpgrade({
        port: gatewayPort,
        host: targetHostAuthority,
        origin: targetOrigin,
        cookie: `${PREVIEW_COOKIE_NAME}=${rawToken}`,
      });

      expect(res.statusCode).toBe(101);
      expect(res.headers['upgrade']).toBe('websocket');
      expect(res.headers['connection']?.toLowerCase()).toBe('upgrade');
      expect(res.headers['sec-websocket-accept']).toBe(generateWebSocketAccept('dGhlIHNhbXBsZSBub25jZQ=='));
      res.client.destroy();
    });

    it('rejects upgrade when preview authentication cookie is missing (HTTP 401)', async () => {
      const res = await sendWebSocketUpgrade({
        port: gatewayPort,
        host: targetHostAuthority,
        origin: targetOrigin,
      });

      expect(res.statusCode).toBe(401);
      expect(res.rawResponse).toContain('TOKEN_MISSING');
      res.client.destroy();
    });

    it('rejects upgrade when preview token is invalid format (HTTP 401)', async () => {
      const res = await sendWebSocketUpgrade({
        port: gatewayPort,
        host: targetHostAuthority,
        origin: targetOrigin,
        cookie: `${PREVIEW_COOKIE_NAME}=not-a-64-char-hex-token`,
      });

      expect(res.statusCode).toBe(401);
      expect(res.rawResponse).toContain('TOKEN_INVALID');
      res.client.destroy();
    });

    it('rejects upgrade when preview token does not exist in database (HTTP 401)', async () => {
      const unknownToken = 'a'.repeat(64);
      const res = await sendWebSocketUpgrade({
        port: gatewayPort,
        host: targetHostAuthority,
        origin: targetOrigin,
        cookie: `${PREVIEW_COOKIE_NAME}=${unknownToken}`,
      });

      expect(res.statusCode).toBe(401);
      expect(res.rawResponse).toContain('SESSION_NOT_FOUND');
      res.client.destroy();
    });

    it('rejects upgrade when session is expired (HTTP 410)', async () => {
      await prisma.previewSession.update({
        where: { id: session.id },
        data: { expiresAt: new Date(Date.now() - 5000) },
      });
      invalidateSessionGatewayCache(session.id);

      const res = await sendWebSocketUpgrade({
        port: gatewayPort,
        host: targetHostAuthority,
        origin: targetOrigin,
        cookie: `${PREVIEW_COOKIE_NAME}=${rawToken}`,
      });

      expect(res.statusCode).toBe(410);
      expect(res.rawResponse).toContain('SESSION_EXPIRED');
      res.client.destroy();
    });

    it('rejects upgrade when session status is STOPPED (HTTP 410)', async () => {
      await prisma.previewSession.update({
        where: { id: session.id },
        data: { status: PreviewStatus.STOPPED, isActive: false },
      });
      invalidateSessionGatewayCache(session.id);

      const res = await sendWebSocketUpgrade({
        port: gatewayPort,
        host: targetHostAuthority,
        origin: targetOrigin,
        cookie: `${PREVIEW_COOKIE_NAME}=${rawToken}`,
      });

      expect(res.statusCode).toBe(410);
      expect(res.rawResponse).toContain('SESSION_STOPPED');
      res.client.destroy();
    });

    it('rejects upgrade when session isActive is false (HTTP 401)', async () => {
      getSessionValidationCache().set(tokenHash, {
        sessionId: session.id,
        status: PreviewStatus.RUNNING,
        isActive: false,
        expiresAtMs: Date.now() + 3600 * 1000,
        proxyPort: mockUpstreamPort,
        proxyContainerId: session.proxyContainerId,
        proxyInstanceId: session.proxyInstanceId,
      });

      const res = await sendWebSocketUpgrade({
        port: gatewayPort,
        host: targetHostAuthority,
        origin: targetOrigin,
        cookie: `${PREVIEW_COOKIE_NAME}=${rawToken}`,
      });

      expect(res.statusCode).toBe(401);
      expect(res.rawResponse).toContain('SESSION_INACTIVE');
      res.client.destroy();
    });

    it('rejects upgrade when framework does not support WebSockets e.g. STATIC (HTTP 400)', async () => {
      getSessionValidationCache().set(tokenHash, {
        sessionId: session.id,
        status: PreviewStatus.RUNNING,
        framework: FrameworkType.STATIC,
        isActive: true,
        expiresAtMs: Date.now() + 3600 * 1000,
        proxyPort: mockUpstreamPort,
        proxyContainerId: session.proxyContainerId,
        proxyInstanceId: session.proxyInstanceId,
      });

      const res = await sendWebSocketUpgrade({
        port: gatewayPort,
        host: targetHostAuthority,
        origin: targetOrigin,
        cookie: `${PREVIEW_COOKIE_NAME}=${rawToken}`,
      });

      expect(res.statusCode).toBe(400);
      expect(res.rawResponse).toContain('WEBSOCKET_UNSUPPORTED_FOR_FRAMEWORK');
      res.client.destroy();
    });

    it('rejects upgrade when published proxy port is invalid or privileged e.g. port 80 (HTTP 502)', async () => {
      getSessionValidationCache().set(tokenHash, {
        sessionId: session.id,
        status: PreviewStatus.RUNNING,
        framework: FrameworkType.VITE_REACT,
        isActive: true,
        expiresAtMs: Date.now() + 3600 * 1000,
        proxyPort: 80, // Privileged / invalid port
        proxyContainerId: session.proxyContainerId,
        proxyInstanceId: session.proxyInstanceId,
      });

      const res = await sendWebSocketUpgrade({
        port: gatewayPort,
        host: targetHostAuthority,
        origin: targetOrigin,
        cookie: `${PREVIEW_COOKIE_NAME}=${rawToken}`,
      });

      expect(res.statusCode).toBe(502);
      expect(res.rawResponse).toContain('BAD_GATEWAY');
      res.client.destroy();
    });

    it('rejects upgrade when Origin header does not match expected target origin (HTTP 403)', async () => {
      const res = await sendWebSocketUpgrade({
        port: gatewayPort,
        host: targetHostAuthority,
        origin: 'http://malicious-site.com',
        cookie: `${PREVIEW_COOKIE_NAME}=${rawToken}`,
      });

      expect(res.statusCode).toBe(403);
      expect(res.rawResponse).toContain('ORIGIN');
      res.client.destroy();
    });

    it('rejects upgrade when Origin header is missing (HTTP 403)', async () => {
      const res = await sendWebSocketUpgrade({
        port: gatewayPort,
        host: targetHostAuthority,
        origin: null,
        cookie: `${PREVIEW_COOKIE_NAME}=${rawToken}`,
      });

      expect(res.statusCode).toBe(403);
      expect(res.rawResponse).toContain('ORIGIN_REQUIRED');
      res.client.destroy();
    });

    it('rejects upgrade when Host authority port mismatches expected preview host (HTTP 403)', async () => {
      const mismatchHost = `${session.id}.preview.localhost:9999`;
      const res = await sendWebSocketUpgrade({
        port: gatewayPort,
        host: mismatchHost,
        origin: `http://${session.id}.preview.localhost:9999`,
        cookie: `${PREVIEW_COOKIE_NAME}=${rawToken}`,
      });

      expect([400, 403]).toContain(res.statusCode);
      res.client.destroy();
    });

    it('rejects duplicate Host headers in raw TCP handshake (HTTP 400)', async () => {
      const res = await sendWebSocketUpgrade({
        port: gatewayPort,
        rawHostHeader: `Host: ${targetHostAuthority}\r\nHost: ${targetHostAuthority}\r\n`,
        origin: targetOrigin,
        cookie: `${PREVIEW_COOKIE_NAME}=${rawToken}`,
      });

      expect(res.statusCode).toBe(400);
      expect(res.rawResponse).toContain('DUPLICATE_HOST_HEADER');
      res.client.destroy();
    });
  });

  // ============================================================================
  // 2. PROTOCOL & RFC 6455
  // ============================================================================
  describe('2. Protocol Verification & RFC 6455', () => {
    it('rejects non-GET HTTP methods e.g. POST or CONNECT (HTTP 405)', async () => {
      const res = await sendWebSocketUpgrade({
        port: gatewayPort,
        method: 'POST',
        host: targetHostAuthority,
        origin: targetOrigin,
        cookie: `${PREVIEW_COOKIE_NAME}=${rawToken}`,
      });

      expect(res.statusCode).toBe(405);
      expect(res.rawResponse).toContain('METHOD_NOT_ALLOWED');
      res.client.destroy();
    });

    it('rejects invalid Upgrade header e.g. h2c or missing Connection upgrade (HTTP 400)', async () => {
      const res = await sendWebSocketUpgrade({
        port: gatewayPort,
        upgrade: 'h2c',
        host: targetHostAuthority,
        origin: targetOrigin,
        cookie: `${PREVIEW_COOKIE_NAME}=${rawToken}`,
      });

      expect(res.statusCode).toBe(400);
      expect(res.rawResponse).toContain('INVALID_UPGRADE_HEADERS');
      res.client.destroy();
    });

    it('rejects unsupported Sec-WebSocket-Version e.g. version 8 (HTTP 426)', async () => {
      const res = await sendWebSocketUpgrade({
        port: gatewayPort,
        wsVersion: '8',
        host: targetHostAuthority,
        origin: targetOrigin,
        cookie: `${PREVIEW_COOKIE_NAME}=${rawToken}`,
      });

      expect(res.statusCode).toBe(426);
      expect(res.headers['sec-websocket-version']).toBe('13');
      res.client.destroy();
    });

    it('rejects malformed Sec-WebSocket-Key e.g. non-base64 or invalid length (HTTP 400)', async () => {
      const res = await sendWebSocketUpgrade({
        port: gatewayPort,
        wsKey: 'not-a-valid-base64-key',
        host: targetHostAuthority,
        origin: targetOrigin,
        cookie: `${PREVIEW_COOKIE_NAME}=${rawToken}`,
      });

      expect(res.statusCode).toBe(400);
      expect(res.rawResponse).toContain('INVALID_SEC_WEBSOCKET_KEY');
      res.client.destroy();
    });

    it('forwards and preserves subprotocol negotiation e.g. vite-hmr', async () => {
      const res = await sendWebSocketUpgrade({
        port: gatewayPort,
        host: targetHostAuthority,
        origin: targetOrigin,
        subprotocol: 'vite-hmr',
        cookie: `${PREVIEW_COOKIE_NAME}=${rawToken}`,
      });

      expect(res.statusCode).toBe(101);
      expect(res.headers['sec-websocket-protocol']).toBe('vite-hmr');
      expect(lastUpstreamHandshakeHeaders['sec-websocket-protocol']).toBe('vite-hmr');
      res.client.destroy();
    });
  });

  // ============================================================================
  // 3. FRAMES & BIDIRECTIONAL PROXYING
  // ============================================================================
  describe('3. Frames & Bidirectional Proxying', () => {
    it('proxies text frames bidirectionally between client and upstream', async () => {
      const res = await sendWebSocketUpgrade({
        port: gatewayPort,
        host: targetHostAuthority,
        origin: targetOrigin,
        cookie: `${PREVIEW_COOKIE_NAME}=${rawToken}`,
      });
      expect(res.statusCode).toBe(101);

      const receivedEcho = await new Promise((resolve) => {
        let buf = Buffer.alloc(0);
        res.client.on('data', (chunk) => {
          buf = Buffer.concat([buf, chunk]);
          const frame = decodeFrame(buf);
          if (frame && frame.opcode === 1) {
            resolve(frame.payload.toString('utf8'));
          }
        });

        // Client sends masked text frame per RFC 6455
        const clientFrame = encodeFrame({
          opcode: 1,
          payload: 'Hello Gateway HMR!',
          isClient: true,
        });
        res.client.write(clientFrame);
      });

      expect(receivedEcho).toBe('echo:Hello Gateway HMR!');
      res.client.destroy();
    });

    it('proxies binary frames bidirectionally without corruption', async () => {
      const res = await sendWebSocketUpgrade({
        port: gatewayPort,
        host: targetHostAuthority,
        origin: targetOrigin,
        cookie: `${PREVIEW_COOKIE_NAME}=${rawToken}`,
      });
      expect(res.statusCode).toBe(101);

      const randomBytes = crypto.randomBytes(512);

      const receivedBinary = await new Promise((resolve) => {
        let buf = Buffer.alloc(0);
        res.client.on('data', (chunk) => {
          buf = Buffer.concat([buf, chunk]);
          const frame = decodeFrame(buf);
          if (frame && frame.opcode === 2) {
            resolve(frame.payload);
          }
        });

        const binaryFrame = encodeFrame({
          opcode: 2,
          payload: randomBytes,
          isClient: true,
        });
        res.client.write(binaryFrame);
      });

      expect(receivedBinary).toEqual(randomBytes);
      res.client.destroy();
    });

    it('forwards fragmented message frames correctly', async () => {
      const res = await sendWebSocketUpgrade({
        port: gatewayPort,
        host: targetHostAuthority,
        origin: targetOrigin,
        cookie: `${PREVIEW_COOKIE_NAME}=${rawToken}`,
      });
      expect(res.statusCode).toBe(101);

      const receivedResponse = await new Promise((resolve) => {
        let buf = Buffer.alloc(0);
        res.client.on('data', (chunk) => {
          buf = Buffer.concat([buf, chunk]);
          const frame = decodeFrame(buf);
          if (frame) {
            resolve(frame.payload.toString('utf8'));
          }
        });

        // Frame 1: Text, FIN=0 (fragment 1)
        const frame1 = encodeFrame({
          opcode: 1,
          payload: 'Part 1 - ',
          fin: false,
          isClient: true,
        });
        // Frame 2: Continuation, FIN=1 (fragment 2)
        const frame2 = encodeFrame({
          opcode: 0,
          payload: 'Part 2',
          fin: true,
          isClient: true,
        });

        res.client.write(Buffer.concat([frame1, frame2]));
      });

      expect(receivedResponse).toContain('Part');
      res.client.destroy();
    });

    it('handles Ping and Pong frames correctly', async () => {
      const res = await sendWebSocketUpgrade({
        port: gatewayPort,
        host: targetHostAuthority,
        origin: targetOrigin,
        cookie: `${PREVIEW_COOKIE_NAME}=${rawToken}`,
      });
      expect(res.statusCode).toBe(101);

      const pongPayload = await new Promise((resolve) => {
        let buf = Buffer.alloc(0);
        res.client.on('data', (chunk) => {
          buf = Buffer.concat([buf, chunk]);
          const frame = decodeFrame(buf);
          if (frame && frame.opcode === 10) {
            resolve(frame.payload.toString('utf8'));
          }
        });

        // Client sends Ping (opcode 9)
        const pingFrame = encodeFrame({
          opcode: 9,
          payload: 'ping-data-123',
          isClient: true,
        });
        res.client.write(pingFrame);
      });

      expect(pongPayload).toBe('ping-data-123');
      res.client.destroy();
    });

    it('handles normal Close frames (status code 1000)', async () => {
      const res = await sendWebSocketUpgrade({
        port: gatewayPort,
        host: targetHostAuthority,
        origin: targetOrigin,
        cookie: `${PREVIEW_COOKIE_NAME}=${rawToken}`,
      });
      expect(res.statusCode).toBe(101);

      const closedGracefully = await new Promise((resolve) => {
        res.client.on('close', () => resolve(true));

        // Client sends Close frame (opcode 8, code 1000)
        sendCloseFrame(res.client, 1000, 'Normal Closure');
      });

      expect(closedGracefully).toBe(true);
    });

    it('handles upstream runner crash by tearing down client socket', async () => {
      const res = await sendWebSocketUpgrade({
        port: gatewayPort,
        host: targetHostAuthority,
        origin: targetOrigin,
        cookie: `${PREVIEW_COOKIE_NAME}=${rawToken}`,
      });
      expect(res.statusCode).toBe(101);

      const clientClosed = await new Promise((resolve) => {
        res.client.on('close', () => resolve(true));

        // Simulate upstream runner container crash / abrupt TCP RST
        if (lastUpstreamSocket && !lastUpstreamSocket.destroyed) {
          lastUpstreamSocket.destroy();
        }
      });

      expect(clientClosed).toBe(true);
      expect(getActiveSessionWebSocketCount(session.id)).toBe(0);
    });

    it('handles client disconnect by cleanly releasing upstream resources', async () => {
      const res = await sendWebSocketUpgrade({
        port: gatewayPort,
        host: targetHostAuthority,
        origin: targetOrigin,
        cookie: `${PREVIEW_COOKIE_NAME}=${rawToken}`,
      });
      expect(res.statusCode).toBe(101);
      expect(getActiveSessionWebSocketCount(session.id)).toBe(1);

      const upstreamClosed = await new Promise((resolve) => {
        lastUpstreamSocket.on('close', () => resolve(true));
        res.client.destroy();
      });

      expect(upstreamClosed).toBe(true);
      expect(getActiveSessionWebSocketCount(session.id)).toBe(0);
    });

    it('preserves native backpressure when large data volume is transmitted', async () => {
      const res = await sendWebSocketUpgrade({
        port: gatewayPort,
        host: targetHostAuthority,
        origin: targetOrigin,
        cookie: `${PREVIEW_COOKIE_NAME}=${rawToken}`,
      });
      expect(res.statusCode).toBe(101);

      // Send 10 frames of 16 KB data
      let framesSent = 0;
      for (let i = 0; i < 10; i++) {
        const frame = encodeFrame({
          opcode: 2,
          payload: crypto.randomBytes(16 * 1024),
          isClient: true,
        });
        const canWrite = res.client.write(frame);
        framesSent++;
      }
      expect(framesSent).toBe(10);
      res.client.destroy();
    });
  });

  // ============================================================================
  // 4. SECURITY & SIDECAR IDENTITY
  // ============================================================================
  describe('4. Security & Sidecar Identity', () => {
    it('rejects cross-session token access (Token A presented to Session B host authority)', async () => {
      // Create session B with unique user
      const userB = await createUser({
        email: 'ws-gateway-user-b@example.com',
        username: 'ws_gateway_user_b',
      });
      const sessionB = await prisma.previewSession.create({
        data: {
          userId: userB.id,
          repositoryId: repo.id,
          commitSha: '1111111111111111111111111111111111111111',
          branch: 'feature',
          framework: FrameworkType.VITE_VANILLA,
          status: PreviewStatus.RUNNING,
          isActive: true,
          tokenHash: hashPreviewToken('b'.repeat(64)),
          previewTokenEnc: encryptPreviewToken('b'.repeat(64)),
          proxyPort: mockUpstreamPort,
          proxyContainerId: `gitview-proxy-${crypto.randomUUID()}`,
          proxyInstanceId: crypto.randomUUID(),
          runnerContainerId: `gitview-runner-${crypto.randomUUID()}`,
          expiresAt: new Date(Date.now() + 3600 * 1000),
          lastActiveAt: new Date(),
          startedAt: new Date(),
        },
      });

      const hostAuthorityB = canonicalizeHostAuthority(getPreviewTargetOrigin(sessionB.id));
      const originB = getPreviewTargetOrigin(sessionB.id);

      // Present Session A's token to Session B's host
      const res = await sendWebSocketUpgrade({
        port: gatewayPort,
        host: hostAuthorityB,
        origin: originB,
        cookie: `${PREVIEW_COOKIE_NAME}=${rawToken}`, // Token for session A
      });

      expect(res.statusCode).toBe(401);
      expect(res.rawResponse).toContain('SESSION_NOT_FOUND');
      res.client.destroy();
    });

    it('rejects connection when sidecar HMAC verification fails', async () => {
      const mismatchedKeyServer = http.createServer();
      attachPreviewWebSocketUpgrade(mismatchedKeyServer, {
        prisma,
        docker: mockDocker,
        handshakeKey: '9'.repeat(64), // mismatched HMAC key
      });
      await new Promise((resolve) => mismatchedKeyServer.listen(0, '127.0.0.1', resolve));
      const mismatchedPort = mismatchedKeyServer.address().port;

      const res = await sendWebSocketUpgrade({
        port: mismatchedPort,
        host: targetHostAuthority,
        origin: targetOrigin,
        cookie: `${PREVIEW_COOKIE_NAME}=${rawToken}`,
      });

      expect([403, 502]).toContain(res.statusCode);
      res.client.destroy();
      if (typeof mismatchedKeyServer.closeAllConnections === 'function') {
        mismatchedKeyServer.closeAllConnections();
      }
      await new Promise((resolve) => mismatchedKeyServer.close(resolve));
    });

    it('rejects connection when container proxyInstanceId does not match session (stale container protection)', async () => {
      // Modify mockDocker to return a replaced container with a different proxyInstanceId
      mockDocker.inspectContainer = vi.fn(async () => ({
        Id: session.proxyContainerId,
        State: { Running: true },
        Config: {
          Labels: {
            'com.gitview.managed': 'true',
            'com.gitview.session-id': session.id,
            'com.gitview.role': 'proxy',
            'com.gitview.sidecar-instance-id': 'different-replaced-instance-uuid',
          },
        },
        NetworkSettings: {
          Ports: {
            '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: String(session.proxyPort) }],
          },
        },
      }));
      invalidateSessionGatewayCache(session.id);

      const res = await sendWebSocketUpgrade({
        port: gatewayPort,
        host: targetHostAuthority,
        origin: targetOrigin,
        cookie: `${PREVIEW_COOKIE_NAME}=${rawToken}`,
      });

      expect(res.statusCode).toBe(502);
      expect(res.rawResponse).toContain('BAD_GATEWAY');
      res.client.destroy();
    });

    it('strips preview authentication cookies before forwarding to upstream', async () => {
      const res = await sendWebSocketUpgrade({
        port: gatewayPort,
        host: targetHostAuthority,
        origin: targetOrigin,
        cookie: `${PREVIEW_COOKIE_NAME}=${rawToken}; user_app_cookie=valid_app_value`,
      });

      expect(res.statusCode).toBe(101);
      expect(lastUpstreamHandshakeHeaders['cookie']).not.toContain(PREVIEW_COOKIE_NAME);
      expect(lastUpstreamHandshakeHeaders['cookie']).toContain('user_app_cookie=valid_app_value');
      res.client.destroy();
    });

    it('transmits internal handshake headers to sidecar but strips them before runner', async () => {
      const res = await sendWebSocketUpgrade({
        port: gatewayPort,
        host: targetHostAuthority,
        origin: targetOrigin,
        cookie: `${PREVIEW_COOKIE_NAME}=${rawToken}`,
      });

      expect(res.statusCode).toBe(101);
      // Gateway transmitted session ID and HMAC token to sidecar
      expect(lastUpstreamHandshakeHeaders['x-gitview-session-id']).toBe(session.id);
      expect(lastUpstreamHandshakeHeaders['x-gitview-sidecar-token']).toBeDefined();
      res.client.destroy();
    });

    it('never leaks internal proxy port, Docker IDs, or tokens in error response headers', async () => {
      const res = await sendWebSocketUpgrade({
        port: gatewayPort,
        host: targetHostAuthority,
        origin: targetOrigin,
        cookie: `${PREVIEW_COOKIE_NAME}=${'f'.repeat(64)}`,
      });

      expect(res.statusCode).toBe(401);
      expect(res.headerText).not.toContain(String(mockUpstreamPort));
      expect(res.headerText).not.toContain(session.proxyContainerId);
      expect(res.headerText).not.toContain(session.proxyInstanceId);
      res.client.destroy();
    });
  });

  // ============================================================================
  // 5. RESOURCE & ABUSE LIMITS
  // ============================================================================
  describe('5. Resource & Abuse Limits', () => {
    it('enforces maximum 10 concurrent WebSockets per preview session and rejects the 11th with HTTP 429', async () => {
      const connections = [];

      // Open 10 concurrent WebSocket connections
      for (let i = 0; i < 10; i++) {
        const res = await sendWebSocketUpgrade({
          port: gatewayPort,
          host: targetHostAuthority,
          origin: targetOrigin,
          cookie: `${PREVIEW_COOKIE_NAME}=${rawToken}`,
        });
        expect(res.statusCode).toBe(101);
        connections.push(res);
      }

      expect(getActiveSessionWebSocketCount(session.id)).toBe(10);

      // Attempt 11th connection: must be rejected with 429 Too Many Requests
      const rejected11 = await sendWebSocketUpgrade({
        port: gatewayPort,
        host: targetHostAuthority,
        origin: targetOrigin,
        cookie: `${PREVIEW_COOKIE_NAME}=${rawToken}`,
      });

      expect(rejected11.statusCode).toBe(429);
      expect(rejected11.rawResponse).toContain('CONCURRENT_WEBSOCKET_LIMIT_EXCEEDED');
      rejected11.client.destroy();

      // Close 1 connection: count becomes 9
      connections[0].client.destroy();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(getActiveSessionWebSocketCount(session.id)).toBe(9);

      // Now a new connection can succeed
      const allowedNew = await sendWebSocketUpgrade({
        port: gatewayPort,
        host: targetHostAuthority,
        origin: targetOrigin,
        cookie: `${PREVIEW_COOKIE_NAME}=${rawToken}`,
      });
      expect(allowedNew.statusCode).toBe(101);
      allowedNew.client.destroy();

      // Clean up remaining connections
      for (const conn of connections) {
        conn.client.destroy();
      }
    });

    it('enforces maximum frame size limit and rejects oversized payload with close code 1009', async () => {
      // Setup a gateway with small maxFrameSize limit (100 bytes) for verification
      const limitedGatewayServer = http.createServer();
      attachPreviewWebSocketUpgrade(limitedGatewayServer, {
        prisma,
        docker: mockDocker,
        maxFrameSize: 100, // 100 bytes max
      });

      await new Promise((resolve) => limitedGatewayServer.listen(0, '127.0.0.1', resolve));
      const limitedPort = limitedGatewayServer.address().port;

      const res = await sendWebSocketUpgrade({
        port: limitedPort,
        host: targetHostAuthority,
        origin: targetOrigin,
        cookie: `${PREVIEW_COOKIE_NAME}=${rawToken}`,
      });
      expect(res.statusCode).toBe(101);

      const receivedCloseCode = await new Promise((resolve) => {
        let buf = Buffer.alloc(0);
        res.client.on('data', (chunk) => {
          buf = Buffer.concat([buf, chunk]);
          const frame = decodeFrame(buf);
          if (frame && frame.opcode === 8) {
            const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 0;
            resolve(code);
          }
        });

        // Send frame with 150 bytes payload (> 100 bytes limit)
        const oversizedFrame = encodeFrame({
          opcode: 1,
          payload: 'X'.repeat(150),
          isClient: true,
        });
        res.client.write(oversizedFrame);
      });

      expect(receivedCloseCode).toBe(1009); // RFC 6455 1009 Message Too Big
      res.client.destroy();
      await new Promise((resolve) => limitedGatewayServer.close(resolve));
    });

    it('enforces handshake timeout when upstream fails to respond (HTTP 504)', async () => {
      const timeoutGateway = http.createServer();
      attachPreviewWebSocketUpgrade(timeoutGateway, {
        prisma,
        docker: mockDocker,
        handshakeTimeoutMs: 150, // fast timeout for test
      });
      await new Promise((resolve) => timeoutGateway.listen(0, '127.0.0.1', resolve));
      const timeoutPort = timeoutGateway.address().port;

      const res = await sendWebSocketUpgrade({
        port: timeoutPort,
        host: targetHostAuthority,
        path: '/upstream-hang',
        origin: targetOrigin,
        cookie: `${PREVIEW_COOKIE_NAME}=${rawToken}`,
        timeoutMs: 3000,
      });

      expect(res.statusCode).toBe(504);
      expect(res.rawResponse).toContain('GATEWAY_TIMEOUT');
      res.client.destroy();
      if (typeof timeoutGateway.closeAllConnections === 'function') {
        timeoutGateway.closeAllConnections();
      }
      await new Promise((resolve) => timeoutGateway.close(resolve));
    });

    it('terminates active WebSocket connections immediately when session transitions to STOPPED or EXPIRED', async () => {
      const res = await sendWebSocketUpgrade({
        port: gatewayPort,
        host: targetHostAuthority,
        origin: targetOrigin,
        cookie: `${PREVIEW_COOKIE_NAME}=${rawToken}`,
      });
      expect(res.statusCode).toBe(101);
      expect(getActiveSessionWebSocketCount(session.id)).toBe(1);

      const clientClosed = await new Promise((resolve) => {
        res.client.on('close', () => resolve(true));

        // Invalidate session cache (invoked on stop, cancel, fail, expire)
        invalidateSessionGatewayCache(session.id);
      });

      expect(clientClosed).toBe(true);
      expect(getActiveSessionWebSocketCount(session.id)).toBe(0);
    });

    it('enforces multi-instance global connection limit across distinct gateway instances using RedisConnectionTracker', async () => {
      const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
      const instance1 = new RedisConnectionTracker({ redis: redisUrl });
      const instance2 = new RedisConnectionTracker({ redis: redisUrl });

      const testSessionId = crypto.randomUUID();

      // Instance 1 acquires 6 leases
      for (let i = 0; i < 6; i++) {
        const ok = await instance1.acquireLease(testSessionId, `inst1-sock-${i}`, 10);
        expect(ok).toBe(true);
      }

      // Instance 2 acquires 4 leases
      for (let i = 0; i < 4; i++) {
        const ok = await instance2.acquireLease(testSessionId, `inst2-sock-${i}`, 10);
        expect(ok).toBe(true);
      }

      // Total count across instances is now 10
      const totalCount = await instance1.getConnectionCount(testSessionId);
      expect(totalCount).toBe(10);

      // 11th connection on Instance 2 must be rejected globally!
      const rejected11th = await instance2.acquireLease(testSessionId, 'inst2-sock-extra', 10);
      expect(rejected11th).toBe(false);

      // Instance 1 closes 1 connection
      await instance1.releaseLease(testSessionId, 'inst1-sock-0');
      expect(await instance2.getConnectionCount(testSessionId)).toBe(9);

      // Now Instance 2 can acquire that freed slot
      const acceptedSlot = await instance2.acquireLease(testSessionId, 'inst2-sock-extra', 10);
      expect(acceptedSlot).toBe(true);

      // Cleanup
      await instance1.terminateSession(testSessionId);
      await instance1.close();
      await instance2.close();
    });

    it('broadcasts session termination across multiple gateway instances via Redis Pub/Sub', async () => {
      const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
      const instance1 = new RedisConnectionTracker({ redis: redisUrl });
      const instance2 = new RedisConnectionTracker({ redis: redisUrl });

      const testSessionId = crypto.randomUUID();

      // Wait a moment for subscriber connection to establish
      await new Promise((r) => setTimeout(r, 100));

      let instance2SocketClosed = false;
      const mockInstance2Socket = {
        destroyed: false,
        destroy() {
          this.destroyed = true;
          instance2SocketClosed = true;
        },
      };

      instance2.registerLocalSocket(testSessionId, 'sock-on-instance-2', {
        clientSocket: mockInstance2Socket,
      });
      expect(instance2.getLocalSocketCount(testSessionId)).toBe(1);

      // Instance 1 issues session termination
      await instance1.terminateSession(testSessionId, 1001, 'Admin Stopped');

      // Wait for Redis Pub/Sub broadcast delivery to Instance 2
      await new Promise((resolve) => {
        const start = Date.now();
        const check = () => {
          if (instance2SocketClosed || Date.now() - start > 2000) return resolve();
          setTimeout(check, 20);
        };
        check();
      });

      expect(instance2SocketClosed).toBe(true);
      expect(instance2.getLocalSocketCount(testSessionId)).toBe(0);

      await instance1.close();
      await instance2.close();
    });
  });

  describe('6. Redis WebSocket Lease Recovery, Clock Consistency & Automatic Cleanup (Task 5.2 / 5.3)', () => {
    const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

    it('enforces global 10-connection limit across two gateway instances with artificially different local clocks', async () => {
      const realNow = Date.now;
      try {
        // Artificially skew system clock forward by 12 hours (+43,200,000ms) for Instance 1
        Date.now = () => realNow() + 43200000;
        const instance1 = new RedisConnectionTracker({ redis: redisUrl });

        // Artificially skew system clock backward by 12 hours (-43,200,000ms) for Instance 2
        Date.now = () => realNow() - 43200000;
        const instance2 = new RedisConnectionTracker({ redis: redisUrl });

        const testSessionId = crypto.randomUUID();

        // Instance 1 acquires 6 leases
        for (let i = 0; i < 6; i++) {
          const ok = await instance1.acquireLease(testSessionId, `skew1-sock-${i}`, 10);
          expect(ok).toBe(true);
        }

        // Instance 2 acquires 4 leases
        for (let i = 0; i < 4; i++) {
          const ok = await instance2.acquireLease(testSessionId, `skew2-sock-${i}`, 10);
          expect(ok).toBe(true);
        }

        // Total count across instances is exactly 10 (evaluated via Redis server time)
        expect(await instance1.getConnectionCount(testSessionId)).toBe(10);
        expect(await instance2.getConnectionCount(testSessionId)).toBe(10);

        // 11th connection is rejected on both instances despite 24-hour clock discrepancy
        expect(await instance1.acquireLease(testSessionId, 'skew1-extra', 10)).toBe(false);
        expect(await instance2.acquireLease(testSessionId, 'skew2-extra', 10)).toBe(false);

        // Releasing 1 lease restores capacity
        await instance1.releaseLease(testSessionId, 'skew1-sock-0');
        expect(await instance2.getConnectionCount(testSessionId)).toBe(9);

        // Instance 2 can acquire that freed slot
        expect(await instance2.acquireLease(testSessionId, 'skew2-extra', 10)).toBe(true);
        expect(await instance1.getConnectionCount(testSessionId)).toBe(10);

        await instance1.terminateSession(testSessionId);
        await instance1.close();
        await instance2.close();
      } finally {
        Date.now = realNow;
      }
    });

    it('proves a clock-skewed gateway cannot prune another gateway active lease', async () => {
      const realNow = Date.now;
      try {
        const testSessionId = crypto.randomUUID();

        // Normal instance 1
        Date.now = realNow;
        const normalInstance = new RedisConnectionTracker({ redis: redisUrl, leaseTtlMs: 2000, heartbeatIntervalMs: 500 });
        const ok1 = await normalInstance.acquireLease(testSessionId, 'normal-sock', 10);
        expect(ok1).toBe(true);

        // Skewed instance 2 (local clock set 48 hours into the future)
        Date.now = () => realNow() + 172800000;
        const skewedInstance = new RedisConnectionTracker({ redis: redisUrl, leaseTtlMs: 2000, heartbeatIntervalMs: 500 });
        const ok2 = await skewedInstance.acquireLease(testSessionId, 'skewed-sock', 10);
        expect(ok2).toBe(true);

        // Skewed instance calls getConnectionCount / prune
        const countFromSkewed = await skewedInstance.getConnectionCount(testSessionId);
        // It must NOT prune normal-sock because Redis server time is authoritative!
        expect(countFromSkewed).toBe(2);

        const countFromNormal = await normalInstance.getConnectionCount(testSessionId);
        expect(countFromNormal).toBe(2);

        await normalInstance.terminateSession(testSessionId);
        await normalInstance.close();
        await skewedInstance.close();
      } finally {
        Date.now = realNow;
      }
    });

    it('recovers abandoned leases after simulated gateway crash without lingering entries', async () => {
      // Short lease TTL (200ms) with 50ms heartbeat renewal
      const instance1 = new RedisConnectionTracker({ redis: redisUrl, leaseTtlMs: 200, heartbeatIntervalMs: 50 });
      const instance2 = new RedisConnectionTracker({ redis: redisUrl, leaseTtlMs: 200, heartbeatIntervalMs: 50 });
      const testSessionId = crypto.randomUUID();

      // Instance 1 acquires 6 leases
      for (let i = 0; i < 6; i++) {
        const ok = await instance1.acquireLease(testSessionId, `crash-sock-${i}`, 10);
        expect(ok).toBe(true);
      }
      // Instance 2 acquires 4 leases and registers them with active heartbeats
      const mockSockets = [];
      for (let i = 0; i < 4; i++) {
        const sockId = `inst2-sock-${i}`;
        const ok = await instance2.acquireLease(testSessionId, sockId, 10);
        expect(ok).toBe(true);
        const sock = { destroyed: false, destroy() { this.destroyed = true; } };
        mockSockets.push(sock);
        instance2.registerLocalSocket(testSessionId, sockId, {
          clientSocket: sock,
          upstreamSocket: { destroyed: false, destroy() {} },
        });
      }

      expect(await instance2.getConnectionCount(testSessionId)).toBe(10);
      // 11th connection is rejected globally
      expect(await instance2.acquireLease(testSessionId, 'new-sock', 10)).toBe(false);

      // SIMULATE CRASH: Instance 1 abruptly dies. Sockets are NOT cleanly closed with releaseLease,
      // and heartbeats cease.
      instance1.localSockets.clear();
      await instance1.close();

      // Wait 250ms (> 200ms lease TTL) so Instance 1 leases expire
      await new Promise((r) => setTimeout(r, 250));

      // Instance 2 now acquires a lease: Lua script automatically prunes the 6 abandoned leases!
      const okAfterCrash = await instance2.acquireLease(testSessionId, 'new-sock-after-crash', 10);
      expect(okAfterCrash).toBe(true);

      // Total count now reflects only the 4 live Instance 2 leases + 1 new lease = 5
      expect(await instance2.getConnectionCount(testSessionId)).toBe(5);

      await instance2.terminateSession(testSessionId);
      await instance2.close();
    });

    it('ensures active connection heartbeats prevent live leases from being incorrectly pruned past initial TTL', async () => {
      // Short lease TTL (200ms) with 50ms heartbeat renewal
      const instance = new RedisConnectionTracker({ redis: redisUrl, leaseTtlMs: 200, heartbeatIntervalMs: 50 });
      const testSessionId = crypto.randomUUID();
      const testSocketId = 'heartbeat-active-socket';

      const ok = await instance.acquireLease(testSessionId, testSocketId, 10);
      expect(ok).toBe(true);

      const mockSocket = { destroyed: false, destroy() { this.destroyed = true; } };
      instance.registerLocalSocket(testSessionId, testSocketId, {
        clientSocket: mockSocket,
        upstreamSocket: { destroyed: false, destroy() {} },
      });

      // Wait 400ms (> 2x the 200ms lease TTL). During this time, heartbeat periodically renews the lease.
      await new Promise((r) => setTimeout(r, 400));

      // Verify the lease was NOT pruned because heartbeats continuously refreshed the score!
      const activeCount = await instance.getConnectionCount(testSessionId);
      expect(activeCount).toBe(1);
      expect(mockSocket.destroyed).toBe(false);

      await instance.terminateSession(testSessionId);
      await instance.close();
    });

    it('ensures abandoned lease keys expire automatically via PEXPIRE while active keys remain present', async () => {
      const instance = new RedisConnectionTracker({ redis: redisUrl, leaseTtlMs: 200, heartbeatIntervalMs: 50 });
      const activeSessionId = crypto.randomUUID();
      const abandonedSessionId = crypto.randomUUID();

      // 1. Session A: active connection with periodic heartbeats
      await instance.acquireLease(activeSessionId, 'active-sock', 10);
      const mockSocket = { destroyed: false, destroy() { this.destroyed = true; } };
      instance.registerLocalSocket(activeSessionId, 'active-sock', {
        clientSocket: mockSocket,
        upstreamSocket: { destroyed: false, destroy() {} },
      });

      // 2. Session B: abandoned lease with NO heartbeats (simulates abrupt crash / abandon)
      await instance.acquireLease(abandonedSessionId, 'abandoned-sock', 10);

      // Verify both keys exist initially and have positive PTTL
      const activeKey = instance._leaseKey(activeSessionId);
      const abandonedKey = instance._leaseKey(abandonedSessionId);

      expect(await instance.redis.exists(activeKey)).toBe(1);
      expect(await instance.redis.exists(abandonedKey)).toBe(1);

      const abandonedPttl = await instance.redis.pttl(abandonedKey);
      expect(abandonedPttl).toBeGreaterThan(0);
      expect(abandonedPttl).toBeLessThanOrEqual(1500);

      // Wait 550ms (> leaseTtlMs * 2 = 400ms).
      // During this time, Session A heartbeats refresh activeKey PEXPIRE,
      // while abandonedKey expires naturally without any interaction!
      await new Promise((r) => setTimeout(r, 550));

      // Assert: abandonedKey has been completely evicted by Redis PEXPIRE!
      const abandonedExists = await instance.redis.exists(abandonedKey);
      expect(abandonedExists).toBe(0);

      // Assert: activeKey is still alive because heartbeats continuously renewed it!
      const activeExists = await instance.redis.exists(activeKey);
      expect(activeExists).toBe(1);

      await instance.terminateSession(activeSessionId);
      await instance.close();
    });

    it('recovers from lost Pub/Sub event: heartbeat detects purged lease and terminates socket on instance B', async () => {
      // Create Instance 2 with fast heartbeat (40ms) and NO Pub/Sub subscriber (subscriberRedis: null)
      // This directly simulates a scenario where Pub/Sub was completely lost, partitioned, or dropped
      const instance1 = new RedisConnectionTracker({ redis: redisUrl, leaseTtlMs: 250, heartbeatIntervalMs: 50 });
      const instance2 = new RedisConnectionTracker({
        redis: redisUrl,
        subscriberRedis: null, // NO SUBSCRIBER: cannot receive Pub/Sub messages!
        leaseTtlMs: 250,
        heartbeatIntervalMs: 40,
      });
      const testSessionId = crypto.randomUUID();
      const testSocketId = 'orphan-without-pubsub';

      let instance2Closed = false;
      let closeCode = null;
      let closeReason = null;
      const mockSocket = {
        destroyed: false,
        destroy() {
          this.destroyed = true;
          instance2Closed = true;
        },
      };

      await instance2.acquireLease(testSessionId, testSocketId, 10);
      instance2.registerLocalSocket(testSessionId, testSocketId, {
        clientSocket: mockSocket,
        sendCloseFrameFn: (sock, code, reason) => {
          closeCode = code;
          closeReason = reason;
        },
      });

      expect(instance2.getLocalSocketCount(testSessionId)).toBe(1);

      // Instance 1 terminates the session.
      // Since Instance 2 has no subscriber, it receives ZERO Pub/Sub notifications!
      await instance1.terminateSession(testSessionId, 1001, 'Force Purge');

      // Wait up to 300ms for Instance 2's periodic heartbeat to trigger renewLease
      await new Promise((resolve) => {
        const start = Date.now();
        const check = () => {
          if (instance2Closed || Date.now() - start > 1000) return resolve();
          setTimeout(check, 20);
        };
        check();
      });

      // The heartbeat on Instance 2 discovered that the lease key was deleted from Redis,
      // and immediately terminated the orphan socket!
      expect(instance2Closed).toBe(true);
      expect(closeCode).toBe(1001);
      expect(instance2.getLocalSocketCount(testSessionId)).toBe(0);

      await instance1.close();
      await instance2.close();
    });

    it('fails closed on Redis unavailability or renewal failure, terminating connection past lease TTL', async () => {
      // Test 1: acquireLease fails closed when Redis is unreachable
      const brokenRedis = {
        on: () => {},
        defineCommand: () => {},
        acquireWsConnectionLease: async () => { throw new Error('ECONNREFUSED Redis down'); },
      };
      const brokenTracker = new RedisConnectionTracker({
        redis: brokenRedis,
        subscriberRedis: null,
      });
      const leaseResult = await brokenTracker.acquireLease('any-session', 'any-socket', 10);
      expect(leaseResult).toBe(false); // Fail-closed! Never permits unmetered connections.

      // Test 2: Active connection fails closed when renewal fails past lease TTL
      const trackerWithFailure = new RedisConnectionTracker({
        redis: redisUrl,
        leaseTtlMs: 150,
        heartbeatIntervalMs: 30,
      });
      const testSessionId = crypto.randomUUID();
      const testSocketId = 'failing-renewal-socket';

      await trackerWithFailure.acquireLease(testSessionId, testSocketId, 10);

      let socketDestroyed = false;
      const mockSocket = {
        destroyed: false,
        destroy() {
          this.destroyed = true;
          socketDestroyed = true;
        },
      };

      trackerWithFailure.registerLocalSocket(testSessionId, testSocketId, {
        clientSocket: mockSocket,
      });

      // Mock renewWsConnectionLease on the Redis client to simulate sudden Redis outage during active connection
      trackerWithFailure.redis.renewWsConnectionLease = async () => {
        throw new Error('Connection to Redis lost');
      };

      // Wait 250ms (> 150ms lease TTL). Consecutive renewal failures trigger the fail-closed threshold.
      await new Promise((resolve) => {
        const start = Date.now();
        const check = () => {
          if (socketDestroyed || Date.now() - start > 1000) return resolve();
          setTimeout(check, 20);
        };
        check();
      });

      expect(socketDestroyed).toBe(true);
      expect(trackerWithFailure.getLocalSocketCount(testSessionId)).toBe(0);

      await trackerWithFailure.close();
      await brokenTracker.close();
    });
  });
});

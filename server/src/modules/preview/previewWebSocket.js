/**
 * GitView Phase 5 — Milestone 7, Task 5: Secure WebSocket Gateway & Bidirectional Proxy
 *
 * Implements RFC 6455 compliant WebSocket upgrade routing, authentication, and bounded bidirectional proxying:
 * - Direct req.rawHeaders Host header integrity validation (rejects duplicate, comma-separated, or missing Host)
 * - Server-authoritative preview subdomain extraction and WHATWG authority normalization
 * - Cookie authentication via __Host-gitview-preview-token with SHA-256 tokenHash lookup
 * - Strict Origin header verification against canonical expected target origin (rejects missing or mismatched Origin)
 * - Session state invariants enforcement (RUNNING, isActive === true, hard expiry check)
 * - Upstream sidecar container identity & port-reuse verification (inspects Docker engine ID, proxyInstanceId, and port)
 * - HMAC-SHA256 handshake token generation bound to sessionId and proxyInstanceId using GITVIEW_SIDECAR_HANDSHAKE_KEY
 * - Constant-time comparison & internal credential stripping before forwarding to runner
 * - Transparent bounded bidirectional proxying for text, binary, fragmented, ping/pong, and close frames
 * - Bounded resource limits: max 10 concurrent WebSockets per preview session (11th rejected with 429)
 * - Maximum frame size enforcement (rejects oversized payloads with close code 1009)
 * - Handshake timeout (10s) and idle connection timeout (10m)
 * - Active connection tracking per session with immediate termination on session stop, cancel, fail, or hard expiry
 * - Vite HMR compatibility (bidirectional frame exchange with Vite dev servers)
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { prisma as defaultPrisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { hashPreviewToken } from '../../utils/previewTokens.js';
import { verifyHostAuthority, getPreviewTargetOrigin } from './hostAuthority.js';
import { PreviewStatus, FrameworkType } from './sessionConstants.js';
import { dockerAdapter as defaultDockerAdapter } from './dockerAdapter.js';
import { reconstructForwardedHeaders } from './trustedProxy.js';
import {
  validateHostHeader,
  extractPreviewHostInfo,
  extractPreviewToken,
  stripAuthCookies,
  verifySidecarIdentity,
  createSidecarHandshakeToken,
  getSessionValidationCache,
  getSidecarVerificationCache,
} from './previewGateway.js';
import {
  getConnectionTracker,
  setConnectionTracker,
  resetConnectionTracker,
  MemoryConnectionTracker,
  RedisConnectionTracker,
} from './previewConnectionTracker.js';

export const DEFAULT_MAX_WS_CONNECTIONS = 10;
export const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes per §9
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10 * 1000; // 10 seconds
export const DEFAULT_MAX_FRAME_SIZE = 16 * 1024 * 1024; // 16 MB
export const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const TOKEN_HEX_REGEX = /^[0-9a-fA-F]{64}$/;

/**
 * Returns the current active WebSocket connection count for a preview session.
 *
 * @param {string} sessionId
 * @param {Object} [tracker]
 * @returns {number}
 */
export function getActiveSessionWebSocketCount(sessionId, tracker = null) {
  if (!sessionId) return 0;
  const activeTracker = tracker || getConnectionTracker();
  if (typeof activeTracker.getLocalSocketCount === 'function') {
    return activeTracker.getLocalSocketCount(sessionId);
  }
  return 0;
}

/**
 * Terminates all active WebSocket connections for a preview session.
 * Invoked on session state transitions (STOPPING, STOPPED, FAILED, EXPIRED) or cache invalidation.
 *
 * @param {string} sessionId
 * @param {number} [code=1001] RFC 6455 close status code
 * @param {string} [reason='Session Terminated']
 * @param {Object} [tracker]
 */
export async function terminateSessionWebSockets(sessionId, code = 1001, reason = 'Session Terminated', tracker = null) {
  if (!sessionId) return;
  const activeTracker = tracker || getConnectionTracker();
  return activeTracker.terminateSession(sessionId, code, reason);
}

/**
 * Clears and terminates all active WebSocket connections across all sessions.
 * Intended for test teardown and process shutdown.
 */
export function clearAllSessionWebSockets() {
  const activeTracker = getConnectionTracker();
  activeTracker.clear();
}

/**
 * Validates that the client's Sec-WebSocket-Key is a valid base64-encoded 16-byte nonce (RFC 6455 §4.2.1).
 *
 * @param {string|undefined} key
 * @returns {boolean}
 */
export function isValidSecWebSocketKey(key) {
  if (!key || typeof key !== 'string') return false;
  const trimmed = key.trim();
  if (trimmed.length !== 24) return false;
  if (!/^[A-Za-z0-9+/]{22}==$/.test(trimmed)) return false;
  try {
    const buf = Buffer.from(trimmed, 'base64');
    return buf.length === 16;
  } catch {
    return false;
  }
}

/**
 * Computes the RFC 6455 Sec-WebSocket-Accept header value from the client key.
 *
 * @param {string} key
 * @returns {string} Base64 accept digest
 */
export function generateWebSocketAccept(key) {
  return crypto
    .createHash('sha1')
    .update(key.trim() + WEBSOCKET_GUID)
    .digest('base64');
}

/**
 * Validates Upgrade and Connection headers for RFC 6455 compliance.
 *
 * @param {Object} headers
 * @returns {boolean}
 */
export function isValidUpgradeHeaders(headers) {
  if (!headers || typeof headers !== 'object') return false;
  const upgrade = headers.upgrade;
  const connection = headers.connection;
  if (!upgrade || typeof upgrade !== 'string' || upgrade.trim().toLowerCase() !== 'websocket') {
    return false;
  }
  if (!connection || typeof connection !== 'string') {
    return false;
  }
  const tokens = connection.toLowerCase().split(',').map((s) => s.trim());
  return tokens.includes('upgrade');
}

/**
 * Verifies that the Origin header strictly matches the canonical target preview origin.
 * Rejects missing, null, or mismatched origins.
 *
 * @param {string|undefined} originHeader
 * @param {string} expectedTargetOrigin e.g. "http://<id>.preview.localhost:3000"
 * @returns {{ valid: boolean, reason?: string }}
 */
export function verifyWebSocketOrigin(originHeader, expectedTargetOrigin) {
  if (!originHeader || typeof originHeader !== 'string') {
    return { valid: false, reason: 'ORIGIN_REQUIRED' };
  }
  const trimmed = originHeader.trim();
  if (!trimmed || trimmed === 'null') {
    return { valid: false, reason: 'ORIGIN_NULL_OR_EMPTY' };
  }

  let originUrl;
  let expectedUrl;
  try {
    originUrl = new URL(trimmed);
    expectedUrl = new URL(expectedTargetOrigin);
  } catch {
    return { valid: false, reason: 'ORIGIN_MALFORMED' };
  }

  if (originUrl.protocol !== expectedUrl.protocol) {
    return { valid: false, reason: 'ORIGIN_PROTOCOL_MISMATCH' };
  }

  if (originUrl.hostname.toLowerCase() !== expectedUrl.hostname.toLowerCase()) {
    return { valid: false, reason: 'ORIGIN_HOST_MISMATCH' };
  }

  const originPort = originUrl.port || (originUrl.protocol === 'https:' ? '443' : '80');
  const expectedPort = expectedUrl.port || (expectedUrl.protocol === 'https:' ? '443' : '80');
  if (originPort !== expectedPort) {
    return { valid: false, reason: 'ORIGIN_PORT_MISMATCH' };
  }

  return { valid: true };
}

/**
 * Writes an HTTP error response on the raw TCP socket and destroys it.
 *
 * @param {import('net').Socket} socket
 * @param {number} statusCode
 * @param {string} statusText
 * @param {string} errorCode
 * @param {string} errorMessage
 * @param {Object} [extraHeaders]
 */
function sendUpgradeError(socket, statusCode, statusText, errorCode, errorMessage, extraHeaders = {}) {
  if (socket && !socket.destroyed && socket.writable) {
    const body = JSON.stringify({ error: { code: errorCode, message: errorMessage } });
    let headerStr =
      `HTTP/1.1 ${statusCode} ${statusText}\r\n` +
      `Content-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      `Connection: close\r\n` +
      `Cache-Control: no-store\r\n`;

    for (const [k, v] of Object.entries(extraHeaders)) {
      headerStr += `${k}: ${v}\r\n`;
    }
    headerStr += `\r\n`;

    try {
      socket.end(headerStr + body);
      return;
    } catch {}
  }
  if (socket && !socket.destroyed) {
    socket.destroy();
  }
}

/**
 * Encodes an RFC 6455 WebSocket frame to a Buffer.
 *
 * @param {Object} params
 * @param {number} [params.opcode=1] 1=text, 2=binary, 8=close, 9=ping, 10=pong
 * @param {string|Buffer} [params.payload='']
 * @param {boolean} [params.isClient=false]
 * @param {boolean} [params.fin=true]
 * @param {Buffer} [params.mask=null]
 * @returns {Buffer}
 */
export function encodeFrame({ opcode = 1, payload = '', isClient = false, fin = true, mask = null }) {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : (payload || Buffer.alloc(0));
  const length = data.length;

  let headerLength = 2;
  let lenIndicator = length;
  if (length >= 126 && length <= 65535) {
    headerLength += 2;
    lenIndicator = 126;
  } else if (length > 65535) {
    headerLength += 8;
    lenIndicator = 127;
  }
  if (isClient) {
    headerLength += 4;
  }

  const header = Buffer.alloc(headerLength);
  header[0] = (fin ? 0x80 : 0x00) | (opcode & 0x0f);
  header[1] = (isClient ? 0x80 : 0x00) | (lenIndicator & 0x7f);

  let offset = 2;
  if (lenIndicator === 126) {
    header.writeUInt16BE(length, offset);
    offset += 2;
  } else if (lenIndicator === 127) {
    header.writeBigUInt64BE(BigInt(length), offset);
    offset += 8;
  }

  if (isClient) {
    const maskKey = mask || crypto.randomBytes(4);
    maskKey.copy(header, offset);
    offset += 4;

    const maskedData = Buffer.alloc(length);
    for (let i = 0; i < length; i++) {
      maskedData[i] = data[i] ^ maskKey[i % 4];
    }
    return Buffer.concat([header, maskedData]);
  }

  return Buffer.concat([header, data]);
}

/**
 * Decodes the first RFC 6455 frame from a Buffer.
 *
 * @param {Buffer} buffer
 * @returns {{ fin: boolean, opcode: number, payload: Buffer, totalLength: number } | null}
 */
export function decodeFrame(buffer) {
  if (!buffer || buffer.length < 2) return null;
  const fin = (buffer[0] & 0x80) !== 0;
  const opcode = buffer[0] & 0x0f;
  const hasMask = (buffer[1] & 0x80) !== 0;
  const lenIndicator = buffer[1] & 0x7f;
  let offset = 2;

  let payloadLen = lenIndicator;
  if (lenIndicator === 126) {
    if (buffer.length < 4) return null;
    payloadLen = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (lenIndicator === 127) {
    if (buffer.length < 10) return null;
    payloadLen = Number(buffer.readBigUInt64BE(offset));
    offset += 8;
  }

  let maskKey = null;
  if (hasMask) {
    if (buffer.length < offset + 4) return null;
    maskKey = buffer.slice(offset, offset + 4);
    offset += 4;
  }

  if (buffer.length < offset + payloadLen) return null;
  const rawPayload = buffer.slice(offset, offset + payloadLen);
  let payload = rawPayload;
  if (hasMask && maskKey) {
    payload = Buffer.alloc(payloadLen);
    for (let i = 0; i < payloadLen; i++) {
      payload[i] = rawPayload[i] ^ maskKey[i % 4];
    }
  }

  return {
    fin,
    opcode,
    payload,
    totalLength: offset + payloadLen,
  };
}

/**
 * Sends an RFC 6455 Close frame (opcode 8) with status code and reason string.
 *
 * @param {import('net').Socket} socket
 * @param {number} [code=1000] Status code (e.g. 1000 Normal, 1001 Going Away, 1009 Message Too Big)
 * @param {string} [reason='']
 */
export function sendCloseFrame(socket, code = 1000, reason = '') {
  if (!socket || socket.destroyed || !socket.writable) return;
  const reasonBuf = Buffer.from(reason, 'utf8');
  const payload = Buffer.alloc(2 + reasonBuf.length);
  payload.writeUInt16BE(code, 0);
  reasonBuf.copy(payload, 2);

  const frame = encodeFrame({ opcode: 8, payload, isClient: false, fin: true });
  try {
    socket.write(frame);
  } catch {}
}

/**
 * Creates a lightweight pass-through Transform stream that inspects frame headers for maximum payload size.
 * Rejects frames exceeding maxFrameSize without buffering the full message in memory.
 *
 * @param {number} maxFrameSize Maximum allowed frame payload bytes
 * @param {Function} onExceeded Callback when a frame exceeds maxFrameSize: (payloadLen) => void
 * @returns {Transform}
 */
export function createFrameSizeValidator(maxFrameSize, onExceeded) {
  let pendingBuffer = Buffer.alloc(0);
  let expectedPayloadRemaining = 0;
  let inPayload = false;

  return new Transform({
    transform(chunk, encoding, callback) {
      let data = pendingBuffer.length > 0 ? Buffer.concat([pendingBuffer, chunk]) : chunk;
      pendingBuffer = Buffer.alloc(0);

      while (data.length > 0) {
        if (inPayload) {
          if (data.length <= expectedPayloadRemaining) {
            expectedPayloadRemaining -= data.length;
            if (expectedPayloadRemaining === 0) {
              inPayload = false;
            }
            break;
          } else {
            data = data.slice(expectedPayloadRemaining);
            expectedPayloadRemaining = 0;
            inPayload = false;
          }
        } else {
          if (data.length < 2) {
            pendingBuffer = data;
            break;
          }
          const b1 = data[1];
          const hasMask = (b1 & 0x80) !== 0;
          const lenIndicator = b1 & 0x7f;
          let headerLen = 2 + (hasMask ? 4 : 0);
          if (lenIndicator === 126) headerLen += 2;
          else if (lenIndicator === 127) headerLen += 8;

          if (data.length < headerLen) {
            pendingBuffer = data;
            break;
          }

          let payloadLen = lenIndicator;
          let offset = 2;
          if (lenIndicator === 126) {
            payloadLen = data.readUInt16BE(offset);
            offset += 2;
          } else if (lenIndicator === 127) {
            payloadLen = Number(data.readBigUInt64BE(offset));
            offset += 8;
          }

          if (payloadLen > maxFrameSize) {
            if (typeof onExceeded === 'function') {
              onExceeded(payloadLen);
            }
            return callback(
              new Error(`FRAME_TOO_LARGE: WebSocket frame payload (${payloadLen}) exceeds maximum limit (${maxFrameSize})`)
            );
          }

          data = data.slice(headerLen);
          if (payloadLen > 0) {
            inPayload = true;
            expectedPayloadRemaining = payloadLen;
          }
        }
      }

      this.push(chunk);
      callback();
    },
  });
}

/**
 * Handles incoming WebSocket upgrade requests on preview subdomains.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('net').Socket} socket
 * @param {Buffer} head
 * @param {Object} [options]
 */
export async function handlePreviewWebSocketUpgrade(req, socket, head, options = {}) {
  const prisma = options.prisma || defaultPrisma;
  const lruCache = options.lruCache || getSessionValidationCache();
  const sidecarCache = options.sidecarCache || getSidecarVerificationCache();
  const docker = options.docker || defaultDockerAdapter;
  const maxConnections = options.maxConnectionsPerSession ?? DEFAULT_MAX_WS_CONNECTIONS;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const maxFrameSize = options.maxFrameSize ?? DEFAULT_MAX_FRAME_SIZE;

  try {
    // 1. HTTP Method validation (RFC 6455 §4.1: Must be GET)
    if (req.method !== 'GET') {
      return sendUpgradeError(
        socket,
        405,
        'Method Not Allowed',
        'METHOD_NOT_ALLOWED',
        'WebSocket upgrade requests must use GET method'
      );
    }

    // 2. Direct rawHeaders Host validation (rejects duplicate or missing Host)
    let hostHeader;
    try {
      hostHeader = validateHostHeader(req);
    } catch (err) {
      return sendUpgradeError(
        socket,
        err.statusCode || 400,
        'Bad Request',
        err.code || 'BAD_REQUEST',
        err.message || 'Host header validation failed'
      );
    }

    // 3. Protocol and header validation
    if (!isValidUpgradeHeaders(req.headers)) {
      return sendUpgradeError(
        socket,
        400,
        'Bad Request',
        'INVALID_UPGRADE_HEADERS',
        'Invalid Upgrade or Connection header for WebSocket handshake'
      );
    }

    const wsVersion = req.headers['sec-websocket-version'];
    if (wsVersion !== '13') {
      return sendUpgradeError(
        socket,
        426,
        'Upgrade Required',
        'UNSUPPORTED_WEBSOCKET_VERSION',
        'Only WebSocket RFC 6455 version 13 is supported',
        { 'Sec-WebSocket-Version': '13' }
      );
    }

    const wsKey = req.headers['sec-websocket-key'];
    if (!isValidSecWebSocketKey(wsKey)) {
      return sendUpgradeError(
        socket,
        400,
        'Bad Request',
        'INVALID_SEC_WEBSOCKET_KEY',
        'Missing or malformed Sec-WebSocket-Key header'
      );
    }

    // 4. Subdomain and session ID extraction
    const hostInfo = extractPreviewHostInfo(hostHeader, options);
    if (!hostInfo.isPreview || !hostInfo.validSessionId || !hostInfo.sessionId) {
      return sendUpgradeError(
        socket,
        400,
        'Bad Request',
        'UNKNOWN_PREVIEW_HOST',
        'Unknown or malformed preview host authority'
      );
    }

    const candidateSessionId = hostInfo.sessionId;

    // 5. Host authority verification
    const expectedTargetOrigin = getPreviewTargetOrigin(candidateSessionId, options);
    const hostCheck = verifyHostAuthority(hostHeader, expectedTargetOrigin);
    if (!hostCheck.valid) {
      return sendUpgradeError(
        socket,
        403,
        'Forbidden',
        'HOST_AUTHORITY_MISMATCH',
        `Host authority mismatch: ${hostCheck.reason || 'UNAUTHORIZED'}`
      );
    }

    // 6. Strict Origin header verification (RFC 6455 browser defense)
    const originCheck = verifyWebSocketOrigin(req.headers.origin, expectedTargetOrigin);
    if (!originCheck.valid) {
      return sendUpgradeError(
        socket,
        403,
        'Forbidden',
        originCheck.reason || 'ORIGIN_FORBIDDEN',
        `WebSocket Origin header verification failed: ${originCheck.reason || 'MISMATCH'}`
      );
    }

    // 7. Preview authentication cookie verification
    const rawToken = extractPreviewToken(req);
    if (!rawToken) {
      return sendUpgradeError(
        socket,
        401,
        'Unauthorized',
        'TOKEN_MISSING',
        'Missing preview authentication cookie (__Host-gitview-preview-token)'
      );
    }

    if (!TOKEN_HEX_REGEX.test(rawToken)) {
      return sendUpgradeError(
        socket,
        401,
        'Unauthorized',
        'TOKEN_INVALID',
        'Invalid preview authentication token format'
      );
    }

    const tokenHash = hashPreviewToken(rawToken);

    // 8. Session resolution (LRU cache or PostgreSQL)
    let sessionData = lruCache.get(tokenHash);

    if (!sessionData) {
      let dbSession;
      try {
        dbSession = await prisma.previewSession.findUnique({
          where: { tokenHash },
        });
      } catch (err) {
        return sendUpgradeError(
          socket,
          500,
          'Internal Server Error',
          'DB_UNAVAILABLE',
          `Database error during session lookup: ${err.message}`
        );
      }

      if (!dbSession) {
        return sendUpgradeError(
          socket,
          401,
          'Unauthorized',
          'SESSION_NOT_FOUND',
          'Preview session not found or access denied'
        );
      }

      sessionData = {
        sessionId: dbSession.id,
        status: dbSession.status,
        framework: dbSession.framework,
        isActive: dbSession.isActive,
        expiresAtMs: new Date(dbSession.expiresAt).getTime(),
        proxyPort: dbSession.proxyPort,
        proxyContainerId: dbSession.proxyContainerId,
        proxyInstanceId: dbSession.proxyInstanceId,
      };

      lruCache.set(tokenHash, sessionData);
    }

    // Cross-session check
    if (sessionData.sessionId !== candidateSessionId) {
      return sendUpgradeError(
        socket,
        401,
        'Unauthorized',
        'SESSION_NOT_FOUND',
        'Preview session not found or access denied'
      );
    }

    // 9. State machine invariants
    if (sessionData.status !== PreviewStatus.RUNNING) {
      return sendUpgradeError(
        socket,
        410,
        'Gone',
        'SESSION_STOPPED',
        `Preview session is in status '${sessionData.status}'. Session must be RUNNING.`
      );
    }

    if (!sessionData.isActive) {
      return sendUpgradeError(
        socket,
        401,
        'Unauthorized',
        'SESSION_INACTIVE',
        'Preview session is not active'
      );
    }

    if (Date.now() >= sessionData.expiresAtMs) {
      return sendUpgradeError(
        socket,
        410,
        'Gone',
        'SESSION_EXPIRED',
        'Preview session has expired'
      );
    }

    // Framework WebSocket support check:
    // STATIC framework runs static file server without WebSocket/HMR support.
    if (sessionData.framework === FrameworkType.STATIC || sessionData.framework === 'STATIC') {
      return sendUpgradeError(
        socket,
        400,
        'Bad Request',
        'WEBSOCKET_UNSUPPORTED_FOR_FRAMEWORK',
        'WebSocket upgrades are not supported for STATIC preview sites'
      );
    }

    if (
      !sessionData.proxyPort ||
      typeof sessionData.proxyPort !== 'number' ||
      sessionData.proxyPort < 1024 ||
      sessionData.proxyPort > 65535
    ) {
      return sendUpgradeError(
        socket,
        502,
        'Bad Gateway',
        'BAD_GATEWAY',
        'Upstream preview runner port is invalid or not assigned'
      );
    }

    // 10. Concurrency limit per session (Max 10 connections globally or locally)
    const socketId = crypto.randomUUID();
    const connectionTracker = options.connectionTracker || getConnectionTracker(options);
    const leaseAcquired = await connectionTracker.acquireLease(
      sessionData.sessionId,
      socketId,
      maxConnections
    );
    if (!leaseAcquired) {
      return sendUpgradeError(
        socket,
        429,
        'Too Many Requests',
        'CONCURRENT_WEBSOCKET_LIMIT_EXCEEDED',
        `Maximum concurrent WebSocket connections (${maxConnections}) exceeded for this preview session`
      );
    }

    // 11. Sidecar identity and port-reuse verification
    const sidecarCheck = await verifySidecarIdentity({
      docker,
      sessionId: sessionData.sessionId,
      proxyContainerId: sessionData.proxyContainerId,
      proxyInstanceId: sessionData.proxyInstanceId,
      proxyPort: sessionData.proxyPort,
      sidecarCache,
    });

    if (!sidecarCheck.valid) {
      await connectionTracker.releaseLease(sessionData.sessionId, socketId);
      return sendUpgradeError(
        socket,
        502,
        'Bad Gateway',
        'BAD_GATEWAY',
        `Upstream proxy sidecar verification failed: ${sidecarCheck.reason || 'UNKNOWN'}`
      );
    }

    // 12. Upstream connection & handshake preparation
    const sanitizedCookie = stripAuthCookies(req.headers.cookie);
    const defaultTrustedProxies = process.env.TRUSTED_PROXIES
      ? process.env.TRUSTED_PROXIES.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    const trustedProxies = options.trustedProxies ?? defaultTrustedProxies;
    const reconstructed = reconstructForwardedHeaders({
      req,
      trustedProxies,
      publicHost: hostHeader,
    });

    const upstreamHeaders = {
      host: `localhost:${sessionData.proxyPort}`,
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-key': wsKey,
      'sec-websocket-version': '13',
      'x-gitview-session-id': sessionData.sessionId,
      'x-gitview-sidecar-token': createSidecarHandshakeToken(
        sessionData.sessionId,
        sessionData.proxyInstanceId || sessionData.proxyContainerId,
        options.handshakeKey
      ),
      ...reconstructed,
    };

    if (sanitizedCookie) {
      upstreamHeaders.cookie = sanitizedCookie;
    }
    if (req.headers['sec-websocket-protocol']) {
      upstreamHeaders['sec-websocket-protocol'] = req.headers['sec-websocket-protocol'];
    }
    if (req.headers['sec-websocket-extensions']) {
      upstreamHeaders['sec-websocket-extensions'] = req.headers['sec-websocket-extensions'];
    }

    // Create upstream request
    const upstreamReq = http.request({
      hostname: '127.0.0.1',
      port: sessionData.proxyPort,
      method: 'GET',
      path: req.url || '/',
      headers: upstreamHeaders,
    });

    let upgradeHandled = false;
    let entry = null;

    const handshakeTimer = setTimeout(() => {
      if (!upgradeHandled) {
        upgradeHandled = true;
        connectionTracker.releaseLease(sessionData.sessionId, socketId);
        try {
          upstreamReq.destroy(new Error('Handshake timed out'));
        } catch {}
        sendUpgradeError(
          socket,
          504,
          'Gateway Timeout',
          'GATEWAY_TIMEOUT',
          'Upstream WebSocket upgrade handshake timed out'
        );
      }
    }, handshakeTimeoutMs);

    upstreamReq.on('error', (err) => {
      if (!upgradeHandled) {
        upgradeHandled = true;
        clearTimeout(handshakeTimer);
        connectionTracker.releaseLease(sessionData.sessionId, socketId);
        sendUpgradeError(
          socket,
          502,
          'Bad Gateway',
          'BAD_GATEWAY',
          `Failed to connect to upstream preview runner: ${err.message}`
        );
      }
    });

    upstreamReq.on('response', (upstreamRes) => {
      // Upstream responded with an HTTP status code other than 101 Switching Protocols
      if (!upgradeHandled) {
        upgradeHandled = true;
        clearTimeout(handshakeTimer);
        connectionTracker.releaseLease(sessionData.sessionId, socketId);

        let body = '';
        upstreamRes.on('data', (c) => (body += c.toString('utf8')));
        upstreamRes.on('end', () => {
          const status = upstreamRes.statusCode || 502;
          let statusText = upstreamRes.statusMessage || (status === 403 ? 'Forbidden' : 'Bad Gateway');
          let parsed;
          try {
            parsed = JSON.parse(body);
          } catch {}
          let code = parsed?.error?.code || (status === 403 ? 'FORBIDDEN' : 'BAD_GATEWAY');
          let message = parsed?.error?.message || `Upstream returned HTTP ${status}`;

          // If upstream returned 200 OK to an Upgrade request, the upstream ignored the Upgrade header.
          let finalStatus = status;
          if (status >= 200 && status < 300) {
            finalStatus = 400;
            statusText = 'Bad Request';
            code = 'UPSTREAM_UPGRADE_REJECTED';
            message = `Upstream server does not support WebSocket upgrades (returned HTTP ${status})`;
          }

          sendUpgradeError(socket, finalStatus, statusText, code, message);
        });
      }
    });

    upstreamReq.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
      if (upgradeHandled) {
        try {
          upstreamSocket.destroy();
        } catch {}
        return;
      }
      upgradeHandled = true;
      clearTimeout(handshakeTimer);

      if (upstreamRes.statusCode !== 101) {
        connectionTracker.releaseLease(sessionData.sessionId, socketId);
        upstreamSocket.destroy();
        return sendUpgradeError(
          socket,
          502,
          'Bad Gateway',
          'BAD_GATEWAY',
          `Upstream responded with HTTP ${upstreamRes.statusCode} instead of 101`
        );
      }

      // Build 101 response to client
      let response101 =
        `HTTP/1.1 101 Switching Protocols\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Accept: ${upstreamRes.headers['sec-websocket-accept'] || generateWebSocketAccept(wsKey)}\r\n`;

      if (upstreamRes.headers['sec-websocket-protocol']) {
        response101 += `Sec-WebSocket-Protocol: ${upstreamRes.headers['sec-websocket-protocol']}\r\n`;
      }
      if (upstreamRes.headers['sec-websocket-extensions']) {
        response101 += `Sec-WebSocket-Extensions: ${upstreamRes.headers['sec-websocket-extensions']}\r\n`;
      }
      response101 += `\r\n`;

      try {
        socket.write(response101);
      } catch (err) {
        connectionTracker.releaseLease(sessionData.sessionId, socketId);
        upstreamSocket.destroy();
        socket.destroy();
        return;
      }

      // Forward initial buffered head frames if present
      if (upstreamHead && upstreamHead.length > 0) {
        try {
          socket.write(upstreamHead);
        } catch {}
      }
      if (head && head.length > 0) {
        try {
          upstreamSocket.write(head);
        } catch {}
      }

      // 13. Register active connection for accounting
      entry = {
        sessionId: sessionData.sessionId,
        socketId,
        clientSocket: socket,
        upstreamSocket,
        expiryTimer: null,
        sendCloseFrameFn: sendCloseFrame,
      };

      connectionTracker.registerLocalSocket(sessionData.sessionId, socketId, entry);

      // Cleanup helper
      const cleanupConnection = (code = 1000, reason = '') => {
        if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
        connectionTracker.releaseLease(sessionData.sessionId, socketId);

        if (!socket.destroyed) {
          try {
            if (code) sendCloseFrame(socket, code, reason);
            socket.destroy();
          } catch {}
        }
        if (!upstreamSocket.destroyed) {
          try {
            upstreamSocket.destroy();
          } catch {}
        }
      };

      // Set hard expiry timer
      const msToExpiry = sessionData.expiresAtMs - Date.now();
      if (msToExpiry > 0) {
        entry.expiryTimer = setTimeout(() => {
          cleanupConnection(1001, 'Session Expired');
        }, msToExpiry);
        if (entry.expiryTimer.unref) entry.expiryTimer.unref();
      }

      // Set idle timeouts
      socket.setTimeout(idleTimeoutMs, () => {
        cleanupConnection(1000, 'Idle Timeout');
      });
      upstreamSocket.setTimeout(idleTimeoutMs, () => {
        cleanupConnection(1000, 'Idle Timeout');
      });

      // Socket lifecycle events
      socket.on('error', () => cleanupConnection());
      socket.on('close', () => cleanupConnection());
      socket.on('end', () => cleanupConnection());
      upstreamSocket.on('error', () => cleanupConnection());
      upstreamSocket.on('close', () => cleanupConnection());
      upstreamSocket.on('end', () => cleanupConnection());

      // 14. Bounded frame size validator & bidirectional piping
      const clientValidator = createFrameSizeValidator(maxFrameSize, (len) => {
        cleanupConnection(1009, 'Message Too Big');
      });
      clientValidator.on('error', () => cleanupConnection(1009, 'Message Too Big'));

      socket.pipe(clientValidator).pipe(upstreamSocket);
      upstreamSocket.pipe(socket);
    });

    upstreamReq.end();
  } catch (err) {
    return sendUpgradeError(
      socket,
      err.statusCode || 500,
      'Internal Server Error',
      err.code || 'INTERNAL_ERROR',
      err.message || 'WebSocket upgrade processing error'
    );
  }
}

/**
 * Attaches the preview WebSocket upgrade listener to an http.Server instance.
 *
 * @param {import('http').Server} server
 * @param {Object} [options]
 */
export function attachPreviewWebSocketUpgrade(server, options = {}) {
  server.on('upgrade', (req, socket, head) => {
    handlePreviewWebSocketUpgrade(req, socket, head, options);
  });
}

/**
 * Factory creating a configurable WebSocket upgrade handler.
 *
 * @param {Object} [options]
 * @returns {{ handleUpgrade: Function, attach: Function }}
 */
export function createWebSocketUpgradeHandler(options = {}) {
  return {
    handleUpgrade: (req, socket, head) => handlePreviewWebSocketUpgrade(req, socket, head, options),
    attach: (server) => attachPreviewWebSocketUpgrade(server, options),
  };
}

export {
  getConnectionTracker,
  setConnectionTracker,
  resetConnectionTracker,
  MemoryConnectionTracker,
  RedisConnectionTracker,
};

/**
 * GitView Phase 5 — Milestone 7, Task 3: Production HTTP Preview Gateway
 *
 * Implements dedicated streaming HTTP preview reverse proxy:
 * - Direct req.rawHeaders Host header integrity validation (rejects duplicate or missing Host)
 * - Server-authoritative preview subdomain extraction and WHATWG authority normalization
 * - Cookie authentication via __Host-gitview-preview-token with SHA-256 tokenHash lookup
 * - Bounded in-memory LRU cache (TTL: 10s, max 500 entries, no plaintext tokens)
 * - Fixed upstream loopback routing to Option A trusted proxy sidecar (127.0.0.1:${session.proxyPort})
 * - Host header rewriting to localhost:${session.proxyPort}
 * - Hop-by-hop header removal and untrusted forwarding header stripping/reconstruction
 * - Auth cookie and internal credential stripping before upstream forwarding
 * - Streaming request and response piping with native backpressure handling
 * - Request limits: 10 MB body size, 16 KB header size, 60s idle timeout
 * - Debounced activity tracking on PostgreSQL lastActiveAt (at most once every 30s)
 * - Strict error sanitation (zero leakage of container IDs, internal ports, or tokens)
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { prisma as defaultPrisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import {
  AppError,
  BadRequestError,
  UnauthorizedError,
  TooManyRequestsError,
} from '../../utils/AppError.js';
import { hashPreviewToken } from '../../utils/previewTokens.js';
import { verifyHostAuthority, getPreviewTargetOrigin } from './hostAuthority.js';
import { clearPreviewCookie, PREVIEW_COOKIE_NAME } from './previewCookie.js';
import { PreviewStatus } from './sessionConstants.js';
import { dockerAdapter as defaultDockerAdapter } from './dockerAdapter.js';
import { reconstructForwardedHeaders } from './trustedProxy.js';
import {
  buildCspPolicy,
  buildErrorCspPolicy,
  combineCspHeaders,
  getFrameAncestors,
  getPreviewSecurityHeaders,
  sanitizeUpstreamHeadersForClient,
  FRAME_ANCESTORS_DEV,
  FRAME_ANCESTORS_PROD,
} from './previewCsp.js';
import {
  terminateSessionWebSockets,
  handlePreviewWebSocketUpgrade,
  attachPreviewWebSocketUpgrade,
  createWebSocketUpgradeHandler,
  getActiveSessionWebSocketCount,
  clearAllSessionWebSockets,
} from './previewWebSocket.js';

/**
 * Standard RFC 2616 / RFC 7230 / RFC 9110 hop-by-hop headers to strip from proxy requests and responses.
 */
const HOP_BY_HOP_HEADERS = Object.freeze(
  new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
  ])
);

/**
 * Untrusted forwarding headers to strip unconditionally from incoming requests.
 */
const FORWARDED_HEADERS_TO_STRIP = Object.freeze([
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'forwarded',
]);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_HEX_REGEX = /^[0-9a-fA-F]{64}$/;
const SCHEME_REGEX = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * Strips GitView authentication cookies (__Host-gitview-preview-token, access_token, refresh_token)
 * from the Cookie header, retaining user application cookies.
 *
 * @param {string|undefined} cookieHeader
 * @returns {string|undefined} Sanitized cookie string or undefined if empty
 */
export function stripAuthCookies(cookieHeader) {
  if (!cookieHeader || typeof cookieHeader !== 'string') return undefined;
  const cookies = cookieHeader.split(';').map((c) => c.trim()).filter(Boolean);
  const retained = cookies.filter((c) => {
    const name = c.split('=')[0].trim().toLowerCase();
    return (
      name !== '__host-gitview-preview-token' &&
      name !== 'access_token' &&
      name !== 'refresh_token'
    );
  });
  return retained.length > 0 ? retained.join('; ') : undefined;
}

/**
 * Extracts raw preview token from request cookies.
 *
 * @param {import('express').Request} req
 * @returns {string|null}
 */
export function extractPreviewToken(req) {
  if (req.cookies && typeof req.cookies === 'object' && req.cookies[PREVIEW_COOKIE_NAME]) {
    return req.cookies[PREVIEW_COOKIE_NAME];
  }
  const cookieHeader = req.headers?.cookie;
  if (!cookieHeader || typeof cookieHeader !== 'string') return null;
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const [name, ...val] = part.trim().split('=');
    if (name === PREVIEW_COOKIE_NAME) {
      return val.join('=');
    }
  }
  return null;
}

/**
 * Validates Host header integrity directly from raw socket headers before processing.
 *
 * @param {import('express').Request} req
 * @returns {string} Singular validated host header
 */
export function validateHostHeader(req) {
  let hostCount = 0;
  if (Array.isArray(req.rawHeaders)) {
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (typeof req.rawHeaders[i] === 'string' && req.rawHeaders[i].toLowerCase() === 'host') {
        hostCount++;
      }
    }
  }

  if (hostCount === 0 || !req.headers?.host) {
    throw new BadRequestError('MISSING_HOST_HEADER', 'Host header is required');
  }

  if (hostCount > 1) {
    throw new BadRequestError('DUPLICATE_HOST_HEADER', 'Duplicate Host header detected');
  }

  const hostHeader = req.headers.host;
  if (typeof hostHeader !== 'string' || hostHeader.includes(',')) {
    throw new BadRequestError('DUPLICATE_HOST_HEADER', 'Duplicate or comma-separated Host header detected');
  }

  if (/[\/@\\?#\s]/.test(hostHeader)) {
    throw new BadRequestError('HOST_AUTHORITY_MALFORMED', 'Malformed Host header authority');
  }

  return hostHeader;
}

/**
 * Parses and validates an incoming Host header against the preview domain structure.
 *
 * @param {string} hostHeader
 * @param {Object} [options]
 * @returns {{ isPreview: boolean, validSessionId: boolean, sessionId?: string, hostname?: string, port?: string, reason?: string }}
 */
export function extractPreviewHostInfo(hostHeader, options = {}) {
  if (!hostHeader || typeof hostHeader !== 'string') return { isPreview: false, reason: 'MISSING' };
  if (hostHeader.includes(',')) return { isPreview: false, reason: 'DUPLICATE' };
  if (/[\/@\\?#\s]/.test(hostHeader)) return { isPreview: false, reason: 'MALFORMED' };

  let hostname;
  let port;

  if (hostHeader.startsWith('[')) {
    const end = hostHeader.indexOf(']');
    if (end === -1) return { isPreview: false, reason: 'INVALID_IPV6' };
    hostname = hostHeader.slice(0, end + 1).toLowerCase();
    const rem = hostHeader.slice(end + 1);
    if (rem.startsWith(':')) {
      port = rem.slice(1);
    } else if (rem.length > 0) {
      return { isPreview: false, reason: 'INVALID_IPV6_PORT' };
    }
  } else {
    const colon = hostHeader.lastIndexOf(':');
    if (colon !== -1) {
      hostname = hostHeader.slice(0, colon).toLowerCase();
      port = hostHeader.slice(colon + 1);
    } else {
      hostname = hostHeader.toLowerCase();
    }
  }

  if (port !== undefined) {
    if (!/^\d+$/.test(port)) return { isPreview: false, reason: 'PORT_NON_NUMERIC' };
    const p = parseInt(port, 10);
    if (p <= 0 || p > 65535) return { isPreview: false, reason: 'PORT_OUT_OF_RANGE' };
  }

  // Determine expected preview domain suffix
  let previewSuffix = options.previewSuffix;
  if (!previewSuffix) {
    const previewDomain = options.previewDomain ?? env?.PREVIEW_DOMAIN;
    if (previewDomain) {
      previewSuffix = `.${previewDomain.toLowerCase()}`;
    } else if (env?.PREVIEW_BASE_URL) {
      try {
        const u = new URL(env.PREVIEW_BASE_URL);
        previewSuffix = `.${u.hostname.toLowerCase()}`;
      } catch {
        previewSuffix = '.preview.localhost';
      }
    } else {
      previewSuffix = '.preview.localhost';
    }
  }

  if (!hostname.endsWith(previewSuffix)) {
    // Also check if hostname is the apex preview domain itself
    const apexDomain = previewSuffix.startsWith('.') ? previewSuffix.slice(1) : previewSuffix;
    if (hostname === apexDomain) {
      return { isPreview: true, validSessionId: false, reason: 'APEX_PREVIEW_DOMAIN' };
    }
    return { isPreview: false, reason: 'NOT_PREVIEW_DOMAIN' };
  }

  const prefix = hostname.slice(0, hostname.length - previewSuffix.length);
  if (!prefix || prefix.includes('.')) {
    return { isPreview: true, validSessionId: false, reason: 'MALFORMED_SUBDOMAIN' };
  }

  if (!UUID_REGEX.test(prefix)) {
    return { isPreview: true, validSessionId: false, sessionId: prefix, reason: 'INVALID_UUID' };
  }

  return { isPreview: true, validSessionId: true, sessionId: prefix.toLowerCase(), hostname, port };
}

/**
 * Determines whether an incoming HTTP request is targeted at the preview domain.
 *
 * @param {import('express').Request} req
 * @param {Object} [options]
 * @returns {boolean}
 */
export function isCandidatePreviewRequest(req, options = {}) {
  // Check Host header
  const host = req.headers?.host;
  if (typeof host === 'string') {
    const lower = host.toLowerCase();
    if (lower.includes('preview.localhost')) return true;
    const domain = options.previewDomain ?? env?.PREVIEW_DOMAIN;
    if (domain && lower.includes(domain.toLowerCase())) return true;
    const baseUrl = options.previewBaseUrl ?? env?.PREVIEW_BASE_URL;
    if (baseUrl) {
      try {
        const u = new URL(baseUrl);
        if (lower.includes(u.hostname.toLowerCase())) return true;
      } catch {}
    }
  }

  // Check rawHeaders if Host header parsing failed
  if (Array.isArray(req.rawHeaders)) {
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (typeof req.rawHeaders[i] === 'string' && req.rawHeaders[i].toLowerCase() === 'host') {
        const val = (req.rawHeaders[i + 1] || '').toLowerCase();
        if (val.includes('preview.localhost')) return true;
        const domain = options.previewDomain ?? env?.PREVIEW_DOMAIN;
        if (domain && val.includes(domain.toLowerCase())) return true;
      }
    }
  }

  return false;
}

/**
 * Bounded In-Memory LRU Cache for Preview Token Validation
 *
 * Invariants:
 * - Max 500 entries
 * - 10-second TTL (maximum revocation propagation window is at most 10s)
 * - Key is strictly SHA-256(rawToken) — never plaintext token!
 * - Hard session expiry (now >= expiresAtMs) always takes precedence
 * - Invalidation support on stop, expire, cancel, or fail
 */
export class SessionValidationCache {
  constructor(options = {}) {
    this.maxEntries = options.maxEntries ?? 500;
    this.ttlMs = options.ttlMs ?? 10 * 1000; // 10 seconds max
    this.cache = new Map(); // tokenHash -> entry
    this.sessionToTokenHash = new Map(); // sessionId -> Set of tokenHashes
  }

  get(tokenHash) {
    if (!tokenHash || typeof tokenHash !== 'string') return null;
    const entry = this.cache.get(tokenHash);
    if (!entry) return null;

    const now = Date.now();

    // 1. Check LRU TTL (10s)
    if (now - entry.cachedAt > this.ttlMs) {
      this.delete(tokenHash);
      return null;
    }

    // 2. Hard session expiry check (NEVER allow cached state to bypass hard expiry)
    if (now >= entry.expiresAtMs) {
      this.delete(tokenHash);
      return null;
    }

    // Refresh LRU order (delete & re-insert)
    this.cache.delete(tokenHash);
    this.cache.set(tokenHash, entry);

    return entry;
  }

  set(tokenHash, metadata) {
    if (!tokenHash || typeof tokenHash !== 'string') return;
    if (!metadata || typeof metadata !== 'object') return;

    // Evict oldest entry if capacity reached
    if (this.cache.size >= this.maxEntries && !this.cache.has(tokenHash)) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        this.delete(oldestKey);
      }
    }

    const now = Date.now();
    const entry = {
      sessionId: metadata.sessionId,
      status: metadata.status,
      framework: metadata.framework,
      isActive: metadata.isActive,
      expiresAtMs: metadata.expiresAtMs,
      proxyPort: metadata.proxyPort,
      proxyContainerId: metadata.proxyContainerId,
      proxyInstanceId: metadata.proxyInstanceId,
      cachedAt: now,
    };

    this.cache.set(tokenHash, entry);

    if (metadata.sessionId) {
      let hashes = this.sessionToTokenHash.get(metadata.sessionId);
      if (!hashes) {
        hashes = new Set();
        this.sessionToTokenHash.set(metadata.sessionId, hashes);
      }
      hashes.add(tokenHash);
    }
  }

  delete(tokenHash) {
    const entry = this.cache.get(tokenHash);
    if (entry?.sessionId) {
      const hashes = this.sessionToTokenHash.get(entry.sessionId);
      if (hashes) {
        hashes.delete(tokenHash);
        if (hashes.size === 0) {
          this.sessionToTokenHash.delete(entry.sessionId);
        }
      }
    }
    return this.cache.delete(tokenHash);
  }

  deleteBySessionId(sessionId) {
    if (!sessionId) return;
    const hashes = this.sessionToTokenHash.get(sessionId);
    if (hashes) {
      for (const h of hashes) {
        this.cache.delete(h);
      }
      this.sessionToTokenHash.delete(sessionId);
    }
  }

  clear() {
    this.cache.clear();
    this.sessionToTokenHash.clear();
  }

  get size() {
    return this.cache.size;
  }
}

/**
 * Per-Session Request Rate Limiter (Sliding Window)
 * Enforces §9: 180 req/min (burst allowance: 300) per preview session.
 */
export class SessionRateLimiter {
  constructor(options = {}) {
    this.windowMs = options.windowMs ?? 60 * 1000;
    this.maxRequests = options.maxRequests ?? 180;
    this.burstMax = options.burstMax ?? 300;
    this.sessions = new Map(); // sessionId -> number[] timestamps
  }

  check(sessionId) {
    if (!sessionId) return true;
    const now = Date.now();
    let timestamps = this.sessions.get(sessionId);
    if (!timestamps) {
      timestamps = [];
      this.sessions.set(sessionId, timestamps);
    }

    const cutoff = now - this.windowMs;
    while (timestamps.length > 0 && timestamps[0] < cutoff) {
      timestamps.shift();
    }

    if (timestamps.length >= this.burstMax) {
      return false;
    }

    timestamps.push(now);
    return true;
  }

  clear() {
    this.sessions.clear();
  }
}

let activeGatewayCache = new SessionValidationCache();
let activeRateLimiter = new SessionRateLimiter();
const sessionActivityMap = new Map(); // sessionId -> lastReportedMs

export function getSessionValidationCache() {
  return activeGatewayCache;
}

export function setSessionValidationCache(cache) {
  activeGatewayCache = cache;
}

export function getSessionRateLimiter() {
  return activeRateLimiter;
}

export function setSessionRateLimiter(limiter) {
  activeRateLimiter = limiter;
}

/**
 * Bounded In-Memory Cache for Verified Sidecar Container Identities (§1)
 *
 * Invariants:
 * - Max 500 entries
 * - 2-second TTL (bounded re-verification window)
 * - Keyed by `${sessionId}:${proxyContainerId}:${proxyPort}`
 * - Immediate invalidation on session teardown or verification failure
 */
export class SidecarVerificationCache {
  constructor(options = {}) {
    this.maxEntries = options.maxEntries ?? 500;
    this.ttlMs = options.ttlMs ?? 2000;
    this.cache = new Map();
  }

  get(sessionId, proxyContainerId, proxyPort, proxyInstanceId = '') {
    const key = proxyInstanceId
      ? `${sessionId}:${proxyContainerId}:${proxyPort}:${proxyInstanceId}`
      : `${sessionId}:${proxyContainerId}:${proxyPort}`;
    const legacyKey = `${sessionId}:${proxyContainerId}:${proxyPort}`;
    const entry = this.cache.get(key) || this.cache.get(legacyKey);
    if (!entry) return false;
    if (Date.now() - entry.verifiedAt > this.ttlMs) {
      this.cache.delete(key);
      this.cache.delete(legacyKey);
      return false;
    }
    return true;
  }

  set(sessionId, proxyContainerId, proxyPort, proxyInstanceId = '') {
    const key = proxyInstanceId
      ? `${sessionId}:${proxyContainerId}:${proxyPort}:${proxyInstanceId}`
      : `${sessionId}:${proxyContainerId}:${proxyPort}`;
    if (this.cache.size >= this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }
    this.cache.set(key, { verifiedAt: Date.now() });
  }

  deleteBySessionId(sessionId) {
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${sessionId}:`)) {
        this.cache.delete(key);
      }
    }
  }

  clear() {
    this.cache.clear();
  }
}

let activeSidecarCache = new SidecarVerificationCache();
let activeDockerAdapter = defaultDockerAdapter;

export function getSidecarVerificationCache() {
  return activeSidecarCache;
}

export function setSidecarVerificationCache(cache) {
  activeSidecarCache = cache;
}

export function getDefaultDockerAdapter() {
  return activeDockerAdapter;
}

export function setDefaultDockerAdapter(adapter) {
  activeDockerAdapter = adapter;
}

/**
 * Verifies that the upstream port belongs strictly to the expected session's trusted proxy container.
 * Enforces sidecar identity and port-reuse protection:
 * - Inspects expected proxyContainerId
 * - Verifies container is running (State.Running === true)
 * - Verifies com.gitview.managed === 'true'
 * - Verifies com.gitview.session-id === sessionId
 * - Verifies com.gitview.role === 'proxy'
 * - Verifies actual published TCP port matches session.proxyPort on 127.0.0.1
 * - Rejects stopped, missing, or mismatched containers
 * - Fails closed rather than forwarding to an unexpected process
 *
 * @param {Object} params
 * @param {Object} params.docker DockerAdapter or mock
 * @param {string} params.sessionId
 * @param {string} params.proxyContainerId
 * @param {number} params.proxyPort
 * @param {SidecarVerificationCache} [params.sidecarCache]
 * @returns {Promise<{ valid: boolean, reason?: string }>}
 */
export async function verifySidecarIdentity({
  docker,
  sessionId,
  proxyContainerId,
  proxyInstanceId = null,
  proxyPort,
  sidecarCache,
}) {
  if (!proxyContainerId || !proxyPort) {
    return { valid: false, reason: 'MISSING_SIDECAR_METADATA' };
  }

  if (sidecarCache && sidecarCache.get(sessionId, proxyContainerId, proxyPort, proxyInstanceId)) {
    return { valid: true, cached: true };
  }

  if (!docker || typeof docker.inspectContainer !== 'function') {
    return { valid: false, reason: 'DOCKER_UNAVAILABLE' };
  }

  let inspectTarget = proxyContainerId;
  // If proxyContainerId is a raw UUID, the Docker container is named gitview-proxy-${sessionId}
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(proxyContainerId)) {
    inspectTarget = `gitview-proxy-${sessionId}`;
  }

  let inspectData;
  try {
    inspectData = await docker.inspectContainer(inspectTarget);
  } catch (err) {
    return { valid: false, reason: 'CONTAINER_NOT_FOUND' };
  }

  if (!inspectData?.State?.Running) {
    return { valid: false, reason: 'CONTAINER_NOT_RUNNING' };
  }

  const labels = inspectData?.Config?.Labels || {};
  if (labels['com.gitview.managed'] !== 'true') {
    return { valid: false, reason: 'NOT_MANAGED_BY_GITVIEW' };
  }
  if (labels['com.gitview.session-id'] !== sessionId) {
    return { valid: false, reason: 'SESSION_ID_MISMATCH' };
  }
  if (labels['com.gitview.role'] !== 'proxy') {
    return { valid: false, reason: 'ROLE_MISMATCH' };
  }

  // Sidecar instance identity verification:
  // Verify com.gitview.sidecar-instance-id matches proxyInstanceId (or proxyContainerId if proxyInstanceId not set)
  const sidecarInstanceId = labels['com.gitview.sidecar-instance-id'] || labels['com.gitview.instance-id'];
  const expectedInstanceId = proxyInstanceId || proxyContainerId;
  if (sidecarInstanceId && sidecarInstanceId !== expectedInstanceId) {
    return { valid: false, reason: 'INSTANCE_ID_MISMATCH' };
  }

  // If inspectData has Id, and proxyContainerId is a hex container ID, verify it matches
  if (inspectData.Id && /^[0-9a-fA-F]{12,64}$/.test(proxyContainerId) && !inspectData.Id.startsWith(proxyContainerId)) {
    return { valid: false, reason: 'CONTAINER_ID_MISMATCH' };
  }

  // Check published port matches proxyPort on 127.0.0.1
  const ports = inspectData?.NetworkSettings?.Ports || {};
  let portMatched = false;

  for (const bindings of Object.values(ports)) {
    if (Array.isArray(bindings)) {
      for (const b of bindings) {
        if (b.HostIp === '127.0.0.1' && parseInt(b.HostPort, 10) === proxyPort) {
          portMatched = true;
          break;
        }
      }
    }
    if (portMatched) break;
  }

  if (!portMatched) {
    return { valid: false, reason: 'PORT_MISMATCH' };
  }

  if (sidecarCache) {
    sidecarCache.set(sessionId, proxyContainerId, proxyPort, proxyInstanceId);
  }

  return { valid: true };
}

/**
 * Checks whether a hostname or IP represents a loopback, link-local, private RFC 1918,
 * or internal network address that must never be target of external redirect.
 *
 * @param {string} hostname
 * @returns {boolean}
 */
export function isPrivateOrLocalIp(hostname) {
  if (!hostname || typeof hostname !== 'string') return true;
  const h = hostname.toLowerCase();

  // Local names
  if (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h.endsWith('.internal') ||
    h.startsWith('gitview-')
  ) {
    return true;
  }

  // IPv6 loopback / link-local / unique-local
  if (
    h === '::1' ||
    h === '[::1]' ||
    h.startsWith('fe80:') ||
    h.startsWith('[fe80:') ||
    h.startsWith('fc00:') ||
    h.startsWith('fd00:') ||
    h.startsWith('[fc00:') ||
    h.startsWith('[fd00:')
  ) {
    return true;
  }

  // IPv4 checks
  const cleanIp = h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(cleanIp)) {
    const parts = cleanIp.split('.').map((p) => parseInt(p, 10));
    if (parts.some((p) => isNaN(p) || p < 0 || p > 255)) return true;

    // 0.0.0.0/8
    if (parts[0] === 0) return true;
    // 10.0.0.0/8
    if (parts[0] === 10) return true;
    // 127.0.0.0/8
    if (parts[0] === 127) return true;
    // 169.254.0.0/16
    if (parts[0] === 169 && parts[1] === 254) return true;
    // 172.16.0.0/12
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    // 192.168.0.0/16
    if (parts[0] === 192 && parts[1] === 168) return true;
  }

  return false;
}

/**
 * Safely sanitizes and rewrites upstream HTTP Location headers (§2):
 * - Preserves relative redirects (/path, ./path, ../path, path, ?query, #hash)
 * - Rewrites absolute same-session internal redirects (e.g. http://localhost:PORT/foo,
 *   http://127.0.0.1:PORT/foo, http://gitview-runner-*:PORT/foo) to the canonical public preview origin.
 * - Never exposes 127.0.0.1, internal proxy ports, Docker addresses, or unrelated session upstreams.
 * - Permits legitimate external redirects to public external domains (https://... or http://...),
 *   blocking redirects to private RFC 1918 / loopback / link-local addresses.
 * - Rejects malformed redirect authorities, CRLF injection, and control characters.
 *
 * @param {string|undefined} locationHeader
 * @param {Object} ctx
 * @param {string} ctx.expectedTargetOrigin e.g. "http://<id>.preview.localhost:3000"
 * @param {string} ctx.sessionId
 * @param {number} ctx.proxyPort
 * @returns {string|null} Sanitized Location header value or null if rejected
 */
export function sanitizeLocationHeader(locationHeader, ctx = {}) {
  if (!locationHeader || typeof locationHeader !== 'string') return null;

  const trimmed = locationHeader.trim();
  if (!trimmed) return null;

  // 1. CRLF / control character injection prevention (and backslash prevention)
  if (/[\r\n\x00-\x1f\x7f\\]/.test(trimmed)) {
    return null;
  }

  // Reject protocol-relative redirects (//evil.com)
  if (trimmed.startsWith('//')) {
    return null;
  }

  // 2. Relative redirects: path-absolute or document-relative
  // Must NOT have a scheme (e.g. javascript:, data:, etc.)
  if (!SCHEME_REGEX.test(trimmed)) {
    return trimmed;
  }

  // 3. Absolute or protocol-relative redirect: parse with WHATWG URL
  let parsedUrl;
  try {
    parsedUrl = new URL(trimmed, ctx.expectedTargetOrigin);
  } catch {
    return null;
  }

  // Protocol must be http: or https:
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return null;
  }

  // Reject URL credentials
  if (parsedUrl.username || parsedUrl.password) {
    return null;
  }

  const hostname = parsedUrl.hostname.toLowerCase();
  const port = parsedUrl.port
    ? parseInt(parsedUrl.port, 10)
    : (parsedUrl.protocol === 'https:' ? 443 : 80);

  // Check if target is an internal upstream authority:
  // - loopback (localhost, 127.0.0.1, 0.0.0.0, [::1])
  // - internal Docker container name (starts with gitview-)
  // - port matches sidecar proxyPort or internal runner port (3000, 8080)
  const isLoopbackOrLocal =
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '0.0.0.0' ||
    hostname === '[::1]' ||
    hostname === '::1';

  const isInternalDockerHost =
    hostname.startsWith('gitview-') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.local');

  const matchesInternalPort =
    (ctx.proxyPort && port === ctx.proxyPort) ||
    port === 3000 ||
    port === 8080;

  if (isLoopbackOrLocal || isInternalDockerHost || (isLoopbackOrLocal && matchesInternalPort)) {
    // Rewrite same-session internal redirect to canonical public preview origin
    const publicOrigin = (ctx.expectedTargetOrigin || '').replace(/\/+$/, '');
    const pathAndQuery = `${parsedUrl.pathname}${parsedUrl.search}${parsedUrl.hash}`;
    return `${publicOrigin}${pathAndQuery.startsWith('/') ? pathAndQuery : `/${pathAndQuery}`}`;
  }

  // Check if target is on the preview domain
  let publicHostname = '';
  if (ctx.expectedTargetOrigin) {
    try {
      publicHostname = new URL(ctx.expectedTargetOrigin).hostname.toLowerCase();
    } catch {}
  }

  if (publicHostname && hostname === publicHostname) {
    // Same session explicit public hostname: normalize
    const publicOrigin = ctx.expectedTargetOrigin.replace(/\/+$/, '');
    const pathAndQuery = `${parsedUrl.pathname}${parsedUrl.search}${parsedUrl.hash}`;
    return `${publicOrigin}${pathAndQuery.startsWith('/') ? pathAndQuery : `/${pathAndQuery}`}`;
  }

  // Check if target is attempting to redirect to another preview subdomain
  // e.g. another-session.preview.localhost or another-session.gitview-preview.com
  if (
    hostname.endsWith('.preview.localhost') ||
    (publicHostname.includes('.') && hostname.endsWith(publicHostname.slice(publicHostname.indexOf('.'))))
  ) {
    // Redirect to another session's preview host is forbidden!
    return null;
  }

  // 4. External redirect policy:
  // Reject private RFC 1918, loopback, link-local
  if (isPrivateOrLocalIp(hostname)) {
    return null;
  }

  // Permitted external public redirect (e.g. OAuth to github.com, accounts.google.com, etc.)
  return parsedUrl.toString();
}

const RESERVED_COOKIE_NAMES = Object.freeze(
  new Set(['__host-gitview-preview-token', 'access_token', 'refresh_token'])
);

/**
 * Creates an unexposed, per-session HMAC handshake token used to authenticate gateway-to-sidecar forwarding.
 * Uses dedicated GITVIEW_SIDECAR_HANDSHAKE_KEY (never PREVIEW_TOKEN_ENCRYPTION_KEY or ENCRYPTION_KEY).
 *
 * @param {string} sessionId
 * @param {string} proxyContainerId
 * @param {string} [overrideKey]
 * @returns {string}
 */
export function createSidecarHandshakeToken(sessionId, proxyContainerId, overrideKey = null) {
  const secret = overrideKey || env?.GITVIEW_SIDECAR_HANDSHAKE_KEY || process.env.GITVIEW_SIDECAR_HANDSHAKE_KEY;
  if (!secret) {
    throw new Error('GITVIEW_SIDECAR_HANDSHAKE_KEY is required for sidecar handshake token generation');
  }
  return crypto
    .createHmac('sha256', secret)
    .update(`${sessionId}:${proxyContainerId || ''}`)
    .digest('hex');
}

/**
 * Sanitizes upstream Set-Cookie response headers (§2):
 * - Rejects upstream attempts to overwrite or set reserved GitView authentication cookies
 *   (__Host-gitview-preview-token, access_token, refresh_token).
 * - Preserves legitimate application cookies (e.g. app_session, theme).
 * - Strips Domain=... attribute so cookies cannot be scoped to parent or sibling preview subdomains.
 *
 * @param {string|Array<string>|undefined} setCookieHeader
 * @returns {string|Array<string>|undefined}
 */
export function sanitizeUpstreamSetCookie(setCookieHeader) {
  if (!setCookieHeader) return undefined;
  const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  const sanitized = [];

  for (const cookieStr of cookies) {
    if (typeof cookieStr !== 'string') continue;
    const eqIdx = cookieStr.indexOf('=');
    const cookieName = (eqIdx !== -1 ? cookieStr.slice(0, eqIdx) : cookieStr).trim().toLowerCase();

    // Reject upstream attempts to overwrite or set reserved GitView authentication cookies
    if (RESERVED_COOKIE_NAMES.has(cookieName)) {
      continue;
    }

    // Strip Domain=... attribute to enforce host-only application cookies
    const cleaned = cookieStr.replace(/;\s*domain=[^;]*/gi, '');
    sanitized.push(cleaned);
  }

  if (sanitized.length === 0) return undefined;
  return Array.isArray(setCookieHeader) ? sanitized : sanitized[0];
}

/**
 * Invalidates gateway validation cache when a session is stopped, cancelled, expired, or failed.
 *
 * @param {string} sessionId
 */
export function invalidateSessionGatewayCache(sessionId) {
  if (activeGatewayCache && sessionId) {
    activeGatewayCache.deleteBySessionId(sessionId);
  }
  if (activeSidecarCache && sessionId) {
    activeSidecarCache.deleteBySessionId(sessionId);
  }
  sessionActivityMap.delete(sessionId);
  if (sessionId) {
    try {
      terminateSessionWebSockets(sessionId);
    } catch {}
  }
}

/**
 * Helper to reliably respond with JSON error across both Express Response and native http.ServerResponse.
 * Unconditionally injects defensive security headers (strict error CSP, Referrer-Policy, nosniff, no-store).
 */
function sendJsonError(res, statusCode, code, message, options = {}) {
  const isProd = options.isProduction ?? (env.NODE_ENV === 'production');
  const frameAncestors = options.frameAncestors;
  const secHeaders = getPreviewSecurityHeaders({
    isProduction: isProd,
    frameAncestors,
    isError: true,
  });

  if (typeof res.set === 'function') {
    res.set(secHeaders);
    return res.status(statusCode).json({ error: { code, message } });
  }
  if (typeof res.writeHead === 'function' && !res.headersSent) {
    res.writeHead(statusCode, {
      'Content-Type': 'application/json',
      ...secHeaders,
    });
    return res.end(JSON.stringify({ error: { code, message } }));
  }
  if (typeof res.status === 'function' && typeof res.json === 'function') {
    return res.status(statusCode).json({ error: { code, message } });
  }
}

/**
 * Core streaming HTTP reverse proxy forwarding requests to the trusted Option A sidecar.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {Object} targetSession Validated session metadata { sessionId, proxyPort, ... }
 * @param {Object} [options]
 */
export function forwardHttpPreviewRequest(req, res, targetSession, options = {}) {
  // 1. Verify header size bounds (16 KB max)
  let headerSize = 0;
  if (Array.isArray(req.rawHeaders)) {
    for (let i = 0; i < req.rawHeaders.length; i++) {
      headerSize += req.rawHeaders[i].length + 2;
    }
  } else {
    for (const [k, v] of Object.entries(req.headers || {})) {
      headerSize += k.length + (typeof v === 'string' ? v.length : JSON.stringify(v).length) + 4;
    }
  }

  if (headerSize > 16 * 1024) {
    return sendJsonError(res, 431, 'REQUEST_HEADER_FIELDS_TOO_LARGE', 'Request header fields exceed 16 KB maximum limit');
  }

  // 2. Verify Content-Length bounds (10 MB max)
  const contentLength = req.headers['content-length'];
  if (contentLength) {
    const clNum = parseInt(contentLength, 10);
    if (!isNaN(clNum) && clNum > 10 * 1024 * 1024) {
      return sendJsonError(res, 413, 'PAYLOAD_TOO_LARGE', 'Request body exceeds 10 MB maximum limit');
    }
  }

  const upstreamPort = targetSession.proxyPort;
  const upstreamHost = options.upstreamHost || '127.0.0.1';
  const upstreamPath = req.url || '/';
  const upstreamMethod = req.method;

  // 3. Prepare sanitized upstream headers
  const outgoingHeaders = { ...req.headers };

  // Strip Hop-by-Hop headers
  for (const h of HOP_BY_HOP_HEADERS) {
    delete outgoingHeaders[h];
  }
  if (req.headers['connection']) {
    const customHops = req.headers['connection'].split(',').map((s) => s.trim().toLowerCase());
    for (const h of customHops) {
      delete outgoingHeaders[h];
    }
  }

  // Strip untrusted client forwarding headers
  for (const f of FORWARDED_HEADERS_TO_STRIP) {
    delete outgoingHeaders[f];
  }

  // Strip GitView capability tokens and auth cookies
  const cleanCookie = stripAuthCookies(req.headers['cookie']);
  if (cleanCookie) {
    outgoingHeaders['cookie'] = cleanCookie;
  } else {
    delete outgoingHeaders['cookie'];
  }

  // Strip internal authorization header
  delete outgoingHeaders['authorization'];

  // Rewrite Host to trusted sidecar required upstream authority
  outgoingHeaders['host'] = `localhost:${upstreamPort}`;

  // Per-session authenticated gateway-to-sidecar handshake (§1)
  outgoingHeaders['x-gitview-session-id'] = targetSession.sessionId;
  outgoingHeaders['x-gitview-sidecar-token'] = createSidecarHandshakeToken(
    targetSession.sessionId,
    targetSession.proxyInstanceId || targetSession.proxyContainerId
  );

  // Reconstruct trusted forwarding headers (§4)
  const defaultTrustedProxies = process.env.TRUSTED_PROXIES
    ? process.env.TRUSTED_PROXIES.split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  const trustedProxies = options.trustedProxies ?? defaultTrustedProxies;
  const reconstructed = reconstructForwardedHeaders({
    req,
    trustedProxies,
    publicHost: req.headers['host'],
  });
  for (const [k, v] of Object.entries(reconstructed)) {
    outgoingHeaders[k] = v;
  }

  // 4. Create upstream HTTP request
  const connectTimeoutMs = options.connectTimeoutMs ?? 5000;
  const idleTimeoutMs = options.idleTimeoutMs ?? 60 * 1000;

  const proxyReq = http.request({
    hostname: upstreamHost,
    port: upstreamPort,
    path: upstreamPath,
    method: upstreamMethod,
    headers: outgoingHeaders,
    timeout: idleTimeoutMs,
  });

  let isComplete = false;
  let connectTimer = setTimeout(() => {
    if (!isComplete) {
      proxyReq.destroy(new Error('CONNECT_TIMEOUT'));
    }
  }, connectTimeoutMs);

  proxyReq.on('socket', (socket) => {
    socket.on('connect', () => {
      clearTimeout(connectTimer);
    });
  });

  proxyReq.on('error', (err) => {
    clearTimeout(connectTimer);
    if (activeSidecarCache && targetSession?.sessionId) {
      activeSidecarCache.deleteBySessionId(targetSession.sessionId);
    }
    if (isComplete) return;
    isComplete = true;

    if (res.headersSent) {
      // Stream started: destroy socket so client detects error rather than silent truncation
      res.destroy();
      return;
    }

    if (err.message === 'CONNECT_TIMEOUT' || err.code === 'ETIMEDOUT') {
      return sendJsonError(res, 504, 'GATEWAY_TIMEOUT', 'Upstream preview runner timed out');
    }

    if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET') {
      return sendJsonError(res, 502, 'BAD_GATEWAY', 'Upstream preview runner unavailable');
    }

    return sendJsonError(res, 502, 'BAD_GATEWAY', 'Upstream preview runner error');
  });

  proxyReq.on('timeout', () => {
    clearTimeout(connectTimer);
    proxyReq.destroy(new Error('CONNECT_TIMEOUT'));
  });

  // Client aborted / closed connection before response finished
  res.on('close', () => {
    if (!isComplete && !res.writableEnded) {
      proxyReq.destroy();
    }
  });

  // 5. Stream request body with 10 MB cumulative meter
  let bytesStreamed = 0;
  const MAX_BYTES = 10 * 1024 * 1024;

  req.on('data', (chunk) => {
    bytesStreamed += chunk.length;
    if (bytesStreamed > MAX_BYTES) {
      isComplete = true;
      proxyReq.destroy();
      req.destroy();
      if (!res.headersSent) {
        sendJsonError(res, 413, 'PAYLOAD_TOO_LARGE', 'Request body exceeds 10 MB maximum limit');
      }
    }
  });

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    req.pipe(proxyReq);
  } else {
    proxyReq.end();
  }

  // 6. Upstream response streaming
  proxyReq.on('response', (proxyRes) => {
    clearTimeout(connectTimer);

    // Filter hop-by-hop headers from upstream response
    let resHeaders = { ...proxyRes.headers };
    for (const h of HOP_BY_HOP_HEADERS) {
      delete resHeaders[h];
    }
    if (proxyRes.headers['connection']) {
      const customHops = proxyRes.headers['connection'].split(',').map((s) => s.trim().toLowerCase());
      for (const h of customHops) {
        delete resHeaders[h];
      }
    }

    // Task 3.1: Upstream Location header handling (§2)
    if (resHeaders['location']) {
      const sanitizedLocation = sanitizeLocationHeader(resHeaders['location'], {
        expectedTargetOrigin: options.expectedTargetOrigin,
        sessionId: targetSession.sessionId,
        proxyPort: targetSession.proxyPort,
      });

      if (!sanitizedLocation) {
        // Reject unsafe or prohibited redirect by failing closed with HTTP 502
        isComplete = true;
        proxyRes.destroy();
        return sendJsonError(
          res,
          502,
          'BAD_GATEWAY',
          'Upstream preview runner returned an invalid or prohibited Location redirect'
        );
      }

      resHeaders['location'] = sanitizedLocation;
    }

    // Task 3.2: Check for sidecar handshake failure / rejection (§1)
    if (proxyRes.statusCode === 403 && proxyRes.headers['x-gitview-handshake-error']) {
      if (activeSidecarCache && targetSession?.sessionId) {
        activeSidecarCache.deleteBySessionId(targetSession.sessionId);
      }
      isComplete = true;
      proxyRes.destroy();
      return sendJsonError(res, 502, 'BAD_GATEWAY', 'Upstream proxy sidecar handshake failed');
    }

    // Task 3.1 & 3.2: Upstream Set-Cookie sanitization & reserved cookie protection (§2 & §3)
    if (resHeaders['set-cookie']) {
      const sanitized = sanitizeUpstreamSetCookie(resHeaders['set-cookie']);
      if (sanitized) {
        resHeaders['set-cookie'] = sanitized;
      } else {
        delete resHeaders['set-cookie'];
      }
    }

    // Task 4: Content Security Policy & Defensive Security Headers (§6)
    // 1. Sanitize upstream headers (strip conflicting X-Frame-Options)
    resHeaders = sanitizeUpstreamHeadersForClient(resHeaders);

    // 2. Extract any upstream Content-Security-Policy (from rawHeaders or headers)
    let upstreamCsp = null;
    if (Array.isArray(proxyRes.rawHeaders)) {
      const found = [];
      for (let i = 0; i < proxyRes.rawHeaders.length; i += 2) {
        if (proxyRes.rawHeaders[i]?.toLowerCase() === 'content-security-policy') {
          found.push(proxyRes.rawHeaders[i + 1]);
        }
      }
      if (found.length > 0) {
        upstreamCsp = found;
      }
    }
    if (!upstreamCsp && resHeaders['content-security-policy']) {
      upstreamCsp = resHeaders['content-security-policy'];
    }

    // 3. Compute and apply defensive security headers
    const isProd = options.isProduction ?? (env.NODE_ENV === 'production');
    const secHeaders = getPreviewSecurityHeaders({
      framework: targetSession.framework,
      isProduction: isProd,
      frameAncestors: options.frameAncestors,
      contentType: resHeaders['content-type'],
      upstreamHeaders: {
        ...resHeaders,
        ...(upstreamCsp ? { 'content-security-policy': upstreamCsp } : {}),
      },
    });

    // Delete existing casings before setting canonical headers
    delete resHeaders['content-security-policy'];
    delete resHeaders['Content-Security-Policy'];
    delete resHeaders['x-frame-options'];
    delete resHeaders['X-Frame-Options'];

    for (const [k, v] of Object.entries(secHeaders)) {
      resHeaders[k] = v;
    }

    res.writeHead(proxyRes.statusCode, proxyRes.statusMessage, resHeaders);

    proxyRes.pipe(res);

    proxyRes.on('end', () => {
      isComplete = true;
    });

    proxyRes.on('error', (err) => {
      isComplete = true;
      res.destroy(err);
    });
  });
}

/**
 * Handles incoming preview HTTP requests:
 * 1. Validates Host authority
 * 2. Extracts candidate session ID
 * 3. Authenticates __Host- cookie
 * 4. Checks LRU cache or queries DB
 * 5. Verifies state machine invariants
 * 6. Debounces lastActiveAt updates
 * 7. Proxies to trusted upstream sidecar
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @param {Object} [options]
 */
export async function handlePreviewGateway(req, res, next, options = {}) {
  try {
    const prisma = options.prisma || defaultPrisma;
    const lruCache = options.lruCache || activeGatewayCache;
    const rateLimiter = options.rateLimiter || activeRateLimiter;

    // 1. Direct rawHeaders Host validation (reject duplicate or missing Host)
    const hostHeader = validateHostHeader(req);

    // 2. Parse Host against preview domain structure
    const hostInfo = extractPreviewHostInfo(hostHeader, options);
    if (!hostInfo.isPreview) {
      // Not a preview domain request: pass to next middleware (main API routes)
      return next();
    }

    if (!hostInfo.validSessionId || !hostInfo.sessionId) {
      throw new BadRequestError('UNKNOWN_PREVIEW_HOST', 'Unknown or malformed preview host');
    }

    const candidateSessionId = hostInfo.sessionId;

    // 3. Verify canonical Host authority matches server-generated target origin
    const expectedTargetOrigin = getPreviewTargetOrigin(candidateSessionId, options);
    const hostCheck = verifyHostAuthority(hostHeader, expectedTargetOrigin);
    if (!hostCheck.valid) {
      throw new UnauthorizedError('HOST_AUTHORITY_MISMATCH', `Host authority mismatch: ${hostCheck.reason}`);
    }

    // 4. Extract and validate __Host- cookie
    const rawToken = extractPreviewToken(req);
    if (!rawToken) {
      throw new UnauthorizedError('TOKEN_MISSING', 'Missing preview authentication cookie');
    }

    if (!TOKEN_HEX_REGEX.test(rawToken)) {
      clearPreviewCookie(res);
      throw new UnauthorizedError('TOKEN_INVALID', 'Invalid preview authentication token format');
    }

    // 5. Hash token using SHA-256
    const tokenHash = hashPreviewToken(rawToken);

    // 6. Token cache lookup or PostgreSQL lookup
    let sessionData = lruCache.get(tokenHash);

    if (!sessionData) {
      let dbSession;
      try {
        dbSession = await prisma.previewSession.findUnique({
          where: { tokenHash },
        });
      } catch (err) {
        // Fail closed on PostgreSQL outage
        throw new AppError(500, 'DB_UNAVAILABLE', `Database error during session lookup: ${err.message}`);
      }

      if (!dbSession) {
        clearPreviewCookie(res);
        throw new UnauthorizedError('SESSION_NOT_FOUND', 'Preview session not found or access denied');
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

    // 7. Verify session-to-host match (Cross-session defense)
    if (sessionData.sessionId !== candidateSessionId) {
      clearPreviewCookie(res);
      throw new UnauthorizedError('SESSION_NOT_FOUND', 'Preview session not found or access denied');
    }

    // 8. Verify session state invariants
    if (sessionData.status !== PreviewStatus.RUNNING) {
      clearPreviewCookie(res);
      throw new AppError(
        410,
        'SESSION_STOPPED',
        `Preview session is in status '${sessionData.status}'. Session must be RUNNING.`
      );
    }

    if (!sessionData.isActive) {
      clearPreviewCookie(res);
      throw new UnauthorizedError('SESSION_INACTIVE', 'Preview session is not active');
    }

    if (Date.now() >= sessionData.expiresAtMs) {
      clearPreviewCookie(res);
      throw new AppError(410, 'SESSION_EXPIRED', 'Preview session has expired');
    }

    if (!sessionData.proxyPort || typeof sessionData.proxyPort !== 'number' || sessionData.proxyPort <= 0) {
      throw new AppError(502, 'BAD_GATEWAY', 'Upstream preview runner port not assigned');
    }

    // Verify sidecar container identity and port-reuse protection (§1)
    const docker = options.docker || activeDockerAdapter;
    const sidecarCache = options.sidecarCache || activeSidecarCache;

    const sidecarCheck = await verifySidecarIdentity({
      docker,
      sessionId: sessionData.sessionId,
      proxyContainerId: sessionData.proxyContainerId,
      proxyInstanceId: sessionData.proxyInstanceId,
      proxyPort: sessionData.proxyPort,
      sidecarCache,
    });

    if (!sidecarCheck.valid) {
      throw new AppError(
        502,
        'BAD_GATEWAY',
        `Upstream proxy sidecar verification failed: ${sidecarCheck.reason || 'UNKNOWN'}`
      );
    }

    // 9. Enforce per-session rate limit (§9: 180 req/min, burst 300)
    if (!rateLimiter.check(sessionData.sessionId)) {
      throw new TooManyRequestsError('Preview request rate limit exceeded');
    }

    // 10. Debounced lastActiveAt update (at most once every 30s)
    const now = Date.now();
    const lastActivity = sessionActivityMap.get(sessionData.sessionId) || 0;
    if (now - lastActivity > 30 * 1000) {
      sessionActivityMap.set(sessionData.sessionId, now);
      prisma.previewSession
        .update({
          where: { id: sessionData.sessionId },
          data: { lastActiveAt: new Date(now) },
        })
        .catch(() => {});
    }

    // 11. Stream HTTP request to trusted upstream Option A sidecar
    return forwardHttpPreviewRequest(req, res, sessionData, {
      ...options,
      expectedTargetOrigin,
    });
  } catch (err) {
    if (typeof next === 'function') {
      return next(err);
    }
    const known = err instanceof AppError ? err : null;
    const statusCode = known?.statusCode || err.statusCode || (err.status ? err.status : 500);
    const code = known?.code || err.code || (statusCode === 500 ? 'INTERNAL_ERROR' : 'ERROR');
    const message = known?.message || err.message || 'Preview gateway error';
    return sendJsonError(res, statusCode, code, message, options);
  }
}

/**
 * Express gateway middleware that intercepts preview domain requests and forwards them to handlePreviewGateway.
 * Non-preview requests pass through immediately to subsequent Express middlewares.
 */
export function previewGatewayMiddleware(req, res, next) {
  // If the path is the bootstrap endpoint, let the dedicated bootstrap controller handle it
  if (req.path === '/__gitview_bootstrap') {
    return next();
  }

  // Validate Host header integrity on all incoming HTTP requests
  try {
    validateHostHeader(req);
  } catch (err) {
    return sendJsonError(res, err.statusCode || 400, err.code || 'BAD_REQUEST', err.message);
  }

  if (isCandidatePreviewRequest(req)) {
    return handlePreviewGateway(req, res, next);
  }

  return next();
}

/**
 * Factory creating a configurable gateway instance for integration testing.
 *
 * @param {Object} [options]
 * @returns {{ handleRequest: Function, middleware: Function, lruCache: SessionValidationCache, rateLimiter: SessionRateLimiter }}
 */
export function createPreviewGateway(options = {}) {
  const lruCache = options.lruCache || activeGatewayCache;
  const rateLimiter = options.rateLimiter || new SessionRateLimiter(options);
  const sidecarCache = options.sidecarCache || activeSidecarCache;
  const docker = options.docker || activeDockerAdapter;

  return {
    handleRequest: (req, res, next) =>
      handlePreviewGateway(req, res, next, { ...options, lruCache, rateLimiter, sidecarCache, docker }),
    handleUpgrade: (req, socket, head) =>
      handlePreviewWebSocketUpgrade(req, socket, head, { ...options, lruCache, rateLimiter, sidecarCache, docker }),
    attach: (server) =>
      attachPreviewWebSocketUpgrade(server, { ...options, lruCache, rateLimiter, sidecarCache, docker }),
    middleware: (req, res, next) => {
      if (req.path === '/__gitview_bootstrap') return next();
      try {
        validateHostHeader(req);
      } catch (err) {
        return sendJsonError(res, err.statusCode || 400, err.code || 'BAD_REQUEST', err.message, options);
      }
      if (isCandidatePreviewRequest(req, options)) {
        return handlePreviewGateway(req, res, next, { ...options, lruCache, rateLimiter, sidecarCache, docker });
      }
      return next();
    },
    invalidate: (sessionId) => {
      if (sessionId) {
        lruCache.deleteBySessionId(sessionId);
        sidecarCache.deleteBySessionId(sessionId);
        terminateSessionWebSockets(sessionId);
      }
    },
    lruCache,
    rateLimiter,
    sidecarCache,
    docker,
  };
}

export {
  buildCspPolicy,
  buildErrorCspPolicy,
  combineCspHeaders,
  getFrameAncestors,
  getPreviewSecurityHeaders,
  sanitizeUpstreamHeadersForClient,
  FRAME_ANCESTORS_DEV,
  FRAME_ANCESTORS_PROD,
  terminateSessionWebSockets,
  handlePreviewWebSocketUpgrade,
  attachPreviewWebSocketUpgrade,
  createWebSocketUpgradeHandler,
  getActiveSessionWebSocketCount,
  clearAllSessionWebSockets,
};

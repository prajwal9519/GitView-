/**
 * GitView Phase 5 — Milestone 7: Canonical WHATWG Host Authority Verification
 *
 * Implements strict host authority parsing and validation matching MILESTONE_7_ARCHITECTURE.md §3.3:
 * - Parses expectedTargetOrigin using Node.js WHATWG URL parser
 * - Canonical comparison of lowercase hostnames and ports
 * - Handles IPv6 bracketed literals ([::1]:3000)
 * - Rejects malformed authorities, user credentials (@), path separators (/ or \), query/hash (? or #)
 * - Rejects duplicate or comma-separated Host headers
 * - Rejects non-numeric or out-of-range ports
 * - Rejects missing or non-string Host headers
 * - Never constructs target origin from client-supplied forwarding headers
 */

import { env } from '../../config/env.js';

/**
 * Validates that an incoming HTTP Host header strictly matches the canonical authority
 * of the expected server-generated target origin.
 *
 * @param {string} incomingHostHeader Value of req.headers['host']
 * @param {string} expectedTargetOrigin Fully qualified server-generated target origin
 * @returns {{ valid: boolean, reason?: string }}
 */
export function verifyHostAuthority(incomingHostHeader, expectedTargetOrigin) {
  // 1. Guard against missing, non-string, or duplicate Host headers
  if (!incomingHostHeader || typeof incomingHostHeader !== 'string' || Array.isArray(incomingHostHeader)) {
    return { valid: false, reason: 'HOST_HEADER_INVALID_TYPE' };
  }
  if (incomingHostHeader.includes(',')) {
    return { valid: false, reason: 'HOST_HEADER_DUPLICATE_OR_MULTIPLE' };
  }

  // 2. Reject credentials, whitespace, path separators, or query markers
  if (/[\/@\\?#\s]/.test(incomingHostHeader)) {
    return { valid: false, reason: 'HOST_HEADER_MALFORMED_CHARACTERS' };
  }

  // 3. Parse expected target origin using Node.js WHATWG URL parser
  let targetUrl;
  try {
    targetUrl = new URL(expectedTargetOrigin);
  } catch {
    return { valid: false, reason: 'TARGET_ORIGIN_MALFORMED' };
  }

  const expectedHostname = targetUrl.hostname.toLowerCase();
  const expectedDefaultPort = targetUrl.protocol === 'https:' ? '443' : '80';
  const expectedPort = targetUrl.port || expectedDefaultPort;

  // 4. Parse incoming Host authority into hostname and port
  let incomingHostname;
  let incomingPort;

  if (incomingHostHeader.startsWith('[')) {
    // IPv6 literal: e.g. "[::1]:3000" or "[::1]"
    const closingBracket = incomingHostHeader.indexOf(']');
    if (closingBracket === -1) {
      return { valid: false, reason: 'HOST_HEADER_INVALID_IPV6' };
    }
    incomingHostname = incomingHostHeader.slice(0, closingBracket + 1).toLowerCase();
    const remainder = incomingHostHeader.slice(closingBracket + 1);
    if (remainder.startsWith(':')) {
      incomingPort = remainder.slice(1);
    } else if (remainder.length > 0) {
      return { valid: false, reason: 'HOST_HEADER_INVALID_IPV6_PORT' };
    }
  } else {
    const colonIdx = incomingHostHeader.lastIndexOf(':');
    if (colonIdx !== -1) {
      incomingHostname = incomingHostHeader.slice(0, colonIdx).toLowerCase();
      incomingPort = incomingHostHeader.slice(colonIdx + 1);
    } else {
      incomingHostname = incomingHostHeader.toLowerCase();
    }
  }

  // 5. Validate port numeric bounds if explicitly supplied
  if (incomingPort !== undefined) {
    if (!/^\d+$/.test(incomingPort)) {
      return { valid: false, reason: 'HOST_HEADER_PORT_NON_NUMERIC' };
    }
    const portNum = parseInt(incomingPort, 10);
    if (portNum <= 0 || portNum > 65535) {
      return { valid: false, reason: 'HOST_HEADER_PORT_OUT_OF_RANGE' };
    }
  }

  const effectiveIncomingPort = incomingPort || expectedDefaultPort;

  // 6. Strict equality comparison of normalized hostname and port
  if (incomingHostname !== expectedHostname) {
    return { valid: false, reason: 'HOST_HEADER_HOSTNAME_MISMATCH' };
  }
  if (effectiveIncomingPort !== expectedPort) {
    return { valid: false, reason: 'HOST_HEADER_PORT_MISMATCH' };
  }

  return { valid: true };
}

/**
 * Computes the server-authoritative preview target origin for a session.
 *
 * Priority order:
 * 1. PREVIEW_BASE_URL (explicit override)
 * 2. Dedicated PREVIEW_DOMAIN (e.g. *.gitview-preview.com)
 * 3. Default local development (*.preview.localhost:PORT)
 *
 * @param {string} sessionId
 * @param {Object} [options]
 * @param {string} [options.previewBaseUrl]
 * @param {string} [options.previewDomain]
 * @param {boolean} [options.isHttps]
 * @param {number} [options.port]
 * @returns {string} Fully qualified canonical origin (e.g. "http://<id>.preview.localhost:3000")
 */
export function getPreviewTargetOrigin(sessionId, options = {}) {
  if (!sessionId || typeof sessionId !== 'string') {
    throw new Error('sessionId is required to determine preview target origin');
  }

  const previewBaseUrl = options.previewBaseUrl ?? env?.PREVIEW_BASE_URL;
  if (previewBaseUrl) {
    const base = new URL(previewBaseUrl);
    const protocol = base.protocol;
    const hostname = `${sessionId}.${base.hostname}`;
    const port = base.port ? `:${base.port}` : '';
    return `${protocol}//${hostname}${port}`;
  }

  const previewDomain = options.previewDomain ?? env?.PREVIEW_DOMAIN;
  const isHttps = options.isHttps ?? (env?.PREVIEW_HTTPS === 'true' || env?.NODE_ENV === 'production');

  if (previewDomain) {
    const protocol = isHttps ? 'https:' : 'http:';
    const port = !isHttps && env?.PORT && env.PORT !== 80 ? `:${env.PORT}` : '';
    return `${protocol}//${sessionId}.${previewDomain}${port}`;
  }

  // Default local development: http://<sessionId>.preview.localhost:3000
  const protocol = isHttps ? 'https:' : 'http:';
  const portNum = options.port ?? env?.PORT ?? 3000;
  const portPart = (protocol === 'https:' && portNum === 443) || (protocol === 'http:' && portNum === 80)
    ? ''
    : `:${portNum}`;

  return `${protocol}//${sessionId}.preview.localhost${portPart}`;
}

/**
 * Extracts and normalizes the host authority from a URL or Host string.
 *
 * @param {string} hostOrUrl
 * @returns {string|null} Lowercase normalized host authority (e.g. "preview.localhost:3000")
 */
export function normalizeHostAuthority(hostOrUrl) {
  if (!hostOrUrl || typeof hostOrUrl !== 'string') return null;
  try {
    if (hostOrUrl.includes('://')) {
      const u = new URL(hostOrUrl);
      return u.host.toLowerCase();
    }
    const dummy = new URL(`http://${hostOrUrl}`);
    return dummy.host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Canonicalizes a URL, target origin, or incoming Host header into:
 * `${lowercase_hostname}:${explicit_numeric_port}`
 *
 * Enforces WHATWG effective port equivalence:
 * - "https://session-1.gitview-preview.com" -> "session-1.gitview-preview.com:443"
 * - "https://session-1.gitview-preview.com:443" -> "session-1.gitview-preview.com:443"
 * - "http://session-1.preview.localhost:3000" -> "session-1.preview.localhost:3000"
 * - "http://session-1.preview.localhost" -> "session-1.preview.localhost:80"
 * - "session-1.gitview-preview.com" with defaultProtocol='https:' -> "session-1.gitview-preview.com:443"
 * - "[::1]:3000" -> "[::1]:3000"
 * - "[::1]" with defaultProtocol='http:' -> "[::1]:80"
 *
 * @param {string} hostOrUrl
 * @param {string} [defaultProtocol='http:']
 * @returns {string|null} Canonical authority string or null if invalid/malformed
 */
export function canonicalizeHostAuthority(hostOrUrl, defaultProtocol = 'http:') {
  if (!hostOrUrl || typeof hostOrUrl !== 'string') return null;

  const proto = (defaultProtocol || 'http:').endsWith(':') ? defaultProtocol : `${defaultProtocol}:`;
  const defaultPort = proto === 'https:' ? '443' : '80';

  if (hostOrUrl.includes('://')) {
    try {
      const u = new URL(hostOrUrl);
      const port = u.port || (u.protocol === 'https:' ? '443' : '80');
      return `${u.hostname.toLowerCase()}:${port}`;
    } catch {
      return null;
    }
  }

  // Reject malformed characters or user credentials in Host header authority
  if (/[\/@\\?#\s]/.test(hostOrUrl)) return null;

  let hostname;
  let port;

  if (hostOrUrl.startsWith('[')) {
    const closingBracket = hostOrUrl.indexOf(']');
    if (closingBracket === -1) return null;
    hostname = hostOrUrl.slice(0, closingBracket + 1).toLowerCase();
    const remainder = hostOrUrl.slice(closingBracket + 1);
    if (remainder.startsWith(':')) {
      port = remainder.slice(1);
    } else if (remainder.length === 0) {
      port = defaultPort;
    } else {
      return null;
    }
  } else {
    const colonIdx = hostOrUrl.lastIndexOf(':');
    if (colonIdx !== -1) {
      hostname = hostOrUrl.slice(0, colonIdx).toLowerCase();
      port = hostOrUrl.slice(colonIdx + 1);
    } else {
      hostname = hostOrUrl.toLowerCase();
      port = defaultPort;
    }
  }

  if (!/^\d+$/.test(port)) return null;
  const portNum = parseInt(port, 10);
  if (portNum <= 0 || portNum > 65535) return null;

  return `${hostname}:${portNum}`;
}

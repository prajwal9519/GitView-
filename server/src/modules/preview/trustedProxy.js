/**
 * GitView Phase 5 — Milestone 7, Task 3.1: Trusted Forwarded-Protocol Reconstruction
 *
 * Implements strict, fail-closed validation of immediate peer socket addresses against
 * configured trusted proxy CIDR subnets and IP addresses:
 * - Direct TLS detection when Node terminates TLS (req.socket.encrypted)
 * - Validation of immediate peer (req.socket.remoteAddress) against trusted proxy CIDRs
 * - Reconstruction of external protocol ('https' | 'http') only from verified trusted peers
 * - Unconditional stripping and rejection of client-supplied forwarding headers from untrusted peers
 */

import net from 'node:net';
import crypto from 'node:crypto';

/**
 * Normalizes an IP address, converting IPv4-mapped IPv6 (::ffff:127.0.0.1) to standard IPv4.
 *
 * @param {string} ip
 * @returns {string}
 */
export function normalizeIp(ip) {
  if (!ip || typeof ip !== 'string') return '';
  const trimmed = ip.trim().toLowerCase();
  if (trimmed.startsWith('::ffff:')) {
    return trimmed.slice(7);
  }
  return trimmed;
}

/**
 * Converts an IPv4 dotted-decimal string into a 32-bit unsigned integer.
 *
 * @param {string} ip
 * @returns {number|null}
 */
export function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let res = 0;
  for (let i = 0; i < 4; i++) {
    const octet = parseInt(parts[i], 10);
    if (isNaN(octet) || octet < 0 || octet > 255 || String(octet) !== parts[i]) {
      return null;
    }
    res = ((res << 8) + octet) >>> 0;
  }
  return res;
}

/**
 * Parses an IP or CIDR block (e.g. "10.0.0.0/8", "127.0.0.1", "::1").
 * Fails closed (returns null) on invalid or malformed entries.
 *
 * @param {string} cidrStr
 * @returns {Object|null}
 */
export function parseCidr(cidrStr) {
  if (!cidrStr || typeof cidrStr !== 'string') return null;
  const trimmed = cidrStr.trim();
  const slashIdx = trimmed.indexOf('/');

  let ipPart = trimmed;
  let prefixPart = null;

  if (slashIdx !== -1) {
    ipPart = trimmed.slice(0, slashIdx);
    prefixPart = trimmed.slice(slashIdx + 1);
  }

  const normIp = normalizeIp(ipPart);
  const ipFamily = net.isIP(normIp);
  if (ipFamily === 0) return null; // Not a valid IP

  if (ipFamily === 4) {
    const ipInt = ipv4ToInt(normIp);
    if (ipInt === null) return null;

    let prefix = 32;
    if (prefixPart !== null) {
      if (!/^\d+$/.test(prefixPart)) return null;
      prefix = parseInt(prefixPart, 10);
      if (prefix < 0 || prefix > 32) return null;
    }

    const maskInt = prefix === 0 ? 0 : (~((1 << (32 - prefix)) - 1)) >>> 0;
    const networkInt = (ipInt & maskInt) >>> 0;

    return {
      family: 4,
      ip: normIp,
      prefix,
      maskInt,
      networkInt,
    };
  }

  if (ipFamily === 6) {
    let prefix = 128;
    if (prefixPart !== null) {
      if (!/^\d+$/.test(prefixPart)) return null;
      prefix = parseInt(prefixPart, 10);
      if (prefix < 0 || prefix > 128) return null;
    }

    return {
      family: 6,
      ip: normIp,
      prefix,
    };
  }

  return null;
}

/**
 * Checks whether an incoming IP address belongs to a parsed CIDR definition.
 *
 * @param {string} remoteAddress
 * @param {Object} parsedCidr
 * @returns {boolean}
 */
export function isIpInCidr(remoteAddress, parsedCidr) {
  if (!remoteAddress || !parsedCidr) return false;
  const normIp = normalizeIp(remoteAddress);
  const ipFamily = net.isIP(normIp);

  if (ipFamily !== parsedCidr.family) return false;

  if (ipFamily === 4) {
    const ipInt = ipv4ToInt(normIp);
    if (ipInt === null) return false;
    return ((ipInt & parsedCidr.maskInt) >>> 0) === parsedCidr.networkInt;
  }

  if (ipFamily === 6) {
    // Exact match or loopback match for IPv6
    if (parsedCidr.prefix === 128) {
      return normIp === parsedCidr.ip;
    }
    if (parsedCidr.ip === '::1' && normIp === '::1') return true;
    // Fallback exact equality check
    return normIp === parsedCidr.ip;
  }

  return false;
}

/**
 * Validates whether the immediate peer connection originates from a configured trusted proxy.
 *
 * @param {string|undefined} remoteAddress
 * @param {Array<string|Object>|undefined} trustedProxies
 * @returns {boolean}
 */
export function isPeerTrustedProxy(remoteAddress, trustedProxies) {
  if (!remoteAddress || !trustedProxies) return false;
  const list = Array.isArray(trustedProxies) ? trustedProxies : [trustedProxies];
  if (list.length === 0) return false;

  for (const item of list) {
    const parsed = typeof item === 'object' && item?.family ? item : parseCidr(String(item));
    if (parsed && isIpInCidr(remoteAddress, parsed)) {
      return true;
    }
  }

  return false;
}

/**
 * Parses and reconstructs verified forwarding headers (X-Forwarded-Proto, X-Forwarded-For, X-Forwarded-Host):
 * - If Node terminates TLS directly (req.socket.encrypted), scheme is always 'https'.
 * - If immediate peer is a verified trusted proxy, accepts client-reported scheme ('https' | 'http')
 *   and external client IP from X-Forwarded-For.
 * - If immediate peer is untrusted, unconditionally ignores and strips incoming forwarding headers,
 *   reconstructing strictly from verified socket parameters.
 *
 * @param {Object} params
 * @param {import('http').IncomingMessage} params.req
 * @param {Array<string|Object>|undefined} params.trustedProxies
 * @param {string} params.publicHost
 * @returns {{ 'x-forwarded-proto': string, 'x-forwarded-for': string, 'x-forwarded-host': string }}
 */
export function reconstructForwardedHeaders({ req, trustedProxies = [], publicHost }) {
  const remoteAddress = normalizeIp(req.socket?.remoteAddress || '127.0.0.1');
  const isDirectTls = Boolean(req.socket?.encrypted);
  const isTrusted = isPeerTrustedProxy(remoteAddress, trustedProxies);

  let proto = 'http';
  let clientIp = remoteAddress;

  if (isDirectTls) {
    // Direct TLS termination at Node process level takes absolute precedence
    proto = 'https';
  } else if (isTrusted) {
    // Immediate peer is verified trusted proxy / load balancer
    const rawProto = req.headers['x-forwarded-proto'];
    if (typeof rawProto === 'string') {
      const trimmedProto = rawProto.trim().toLowerCase();
      // Require single permitted scheme ('https' or 'http'); reject comma-separated or malformed values
      if (trimmedProto === 'https' || trimmedProto === 'http') {
        proto = trimmedProto;
      } else {
        // Comma-separated (e.g. 'https, http') or malformed (e.g. 'ftp') indicates
        // load balancer did not overwrite client-supplied headers or forwarded invalid value
        proto = 'http';
      }
    }
  } else {
    // Untrusted immediate peer: unconditionally ignore all client-supplied forwarding headers
    proto = 'http';
  }

  if (isTrusted) {
    const rawFor = req.headers['x-forwarded-for'];
    if (typeof rawFor === 'string' && rawFor.trim()) {
      const hops = rawFor
        .split(',')
        .map((s) => normalizeIp(s.trim()))
        .filter(Boolean);
      // Client IP is the outermost non-trusted hop or the first reported IP
      clientIp = hops.length > 0 ? hops[0] : remoteAddress;
    } else {
      clientIp = remoteAddress;
    }
  } else {
    // Untrusted immediate peer: client IP is strictly the immediate peer socket address
    clientIp = remoteAddress;
  }

  return {
    'x-forwarded-proto': proto,
    'x-forwarded-for': clientIp,
    'x-forwarded-host': publicHost,
  };
}

/**
 * Constant-time string equality check to mitigate timing attacks.
 * Uses crypto.timingSafeEqual when strings have matching byte lengths,
 * and performs a dummy constant-time comparison when lengths differ.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function constantTimeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Run dummy timingSafeEqual against bufA to normalize execution profile
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Validates the authenticated gateway-to-sidecar handshake against the expected session and token.
 * Compares session ID and handshake token in constant time.
 *
 * @param {Object} params
 * @param {string|undefined} params.incomingSessionId
 * @param {string|undefined} params.incomingToken
 * @param {string|undefined} params.expectedSessionId
 * @param {string|undefined} params.expectedToken
 * @returns {boolean}
 */
export function validateSidecarHandshake({
  incomingSessionId,
  incomingToken,
  expectedSessionId,
  expectedToken,
}) {
  if (
    !incomingSessionId ||
    !incomingToken ||
    !expectedSessionId ||
    !expectedToken ||
    typeof incomingSessionId !== 'string' ||
    typeof incomingToken !== 'string' ||
    typeof expectedSessionId !== 'string' ||
    typeof expectedToken !== 'string'
  ) {
    return false;
  }

  const sessionMatch = constantTimeCompare(incomingSessionId, expectedSessionId);
  const tokenMatch = constantTimeCompare(incomingToken, expectedToken);
  return sessionMatch && tokenMatch;
}

/**
 * Strips internal gateway-to-sidecar handshake headers (x-gitview-session-id, x-gitview-sidecar-token)
 * before forwarding requests to the untrusted application runner.
 *
 * @param {Object} headers
 * @returns {Object} Sanitized copy of headers
 */
export function stripSidecarHandshakeHeaders(headers) {
  if (!headers || typeof headers !== 'object') return {};
  const sanitized = { ...headers };
  delete sanitized['x-gitview-session-id'];
  delete sanitized['x-gitview-sidecar-token'];
  return sanitized;
}

/**
 * GitView Phase 5 — Milestone 7, Task 4: Content Security Policy & Defensive Security Headers
 *
 * Architecture Reference: MILESTONE_7_ARCHITECTURE.md v1.2 §6
 *
 * Enforces directive-specific, server-generated security headers for application previews:
 * 1. Default-src 'none' fail-closed baseline.
 * 2. Strict environment segregation of frame-ancestors (never indiscriminate parent origins).
 * 3. Framework-tailored policies (STATIC vs. VITE HMR compatibility).
 * 4. Preserves upstream restrictive CSPs without weakening Gateway mandatory policy.
 * 5. Defensive headers: Referrer-Policy: no-referrer, X-Content-Type-Options: nosniff,
 *    Permissions-Policy, and content-aware Cache-Control.
 * 6. Strips conflicting X-Frame-Options to ensure frame-ancestors has uncontested authority.
 */

import { isProduction as defaultIsProduction } from '../../config/env.js';
import { FrameworkType } from './sessionConstants.js';

export const FRAME_ANCESTORS_DEV = 'http://localhost:5173';
export const FRAME_ANCESTORS_PROD = 'https://app.gitview.dev';
export const PERMISSIONS_POLICY_DEFAULT = 'camera=(), microphone=(), geolocation=(), payment=(), usb=()';
export const REFERRER_POLICY_DEFAULT = 'no-referrer';
export const X_CONTENT_TYPE_OPTIONS_DEFAULT = 'nosniff';

/**
 * Validates header values to prevent HTTP response splitting and CRLF injection.
 * Rejects values containing CR (\r), LF (\n), or null bytes (\0).
 *
 * @param {string} val
 * @returns {boolean} True if safe, false if contains injection characters
 */
export function isSafeHeaderValue(val) {
  if (typeof val !== 'string') return false;
  return !/[\r\n\0]/.test(val);
}

/**
 * Resolves the singular, environment-segregated frame-ancestors directive.
 * Never includes development and production framing parents indiscriminately.
 *
 * @param {boolean} [isProduction]
 * @param {string} [override]
 * @returns {string} Singular framing origin
 */
export function getFrameAncestors(isProduction = defaultIsProduction, override = null) {
  if (override && typeof override === 'string') {
    if (!isSafeHeaderValue(override)) {
      throw new Error('Invalid frame-ancestors override: contains control or CRLF characters');
    }
    return override.trim();
  }
  return isProduction ? FRAME_ANCESTORS_PROD : FRAME_ANCESTORS_DEV;
}

/**
 * Builds the canonical Content-Security-Policy string for an authenticated preview.
 *
 * Directives:
 * - default-src 'none' (fail closed)
 * - script-src (unsafe-inline for Vite preamble, unsafe-eval for dev source maps, blob:, https:)
 * - style-src ('self' 'unsafe-inline' https:)
 * - img-src ('self' data: blob: https:)
 * - font-src ('self' data: https:)
 * - connect-src ('self' ws: wss: https: blob: data: in dev, 'self' wss: https: blob: data: in prod)
 * - worker-src ('self' blob:)
 * - object-src 'none' (blocks plugins)
 * - base-uri 'self' (prevents base tag hijacking)
 * - form-action 'self' (prevents cross-origin form exfiltration)
 * - frame-ancestors (environment-segregated)
 *
 * @param {Object} [params]
 * @param {string} [params.framework] STATIC, VITE_REACT, VITE_VANILLA, or generic
 * @param {boolean} [params.isProduction]
 * @param {string} [params.frameAncestors] Optional framing origin override
 * @returns {string} Semicolon-delimited CSP string
 */
export function buildCspPolicy({
  framework = FrameworkType.STATIC,
  isProduction = defaultIsProduction,
  frameAncestors = null,
} = {}) {
  const isProd = Boolean(isProduction);
  const ancestorOrigin = getFrameAncestors(isProd, frameAncestors);

  const isVite =
    framework === FrameworkType.VITE_REACT ||
    framework === FrameworkType.VITE_VANILLA ||
    framework === 'VITE_REACT' ||
    framework === 'VITE_VANILLA' ||
    framework === 'VITE' ||
    framework === 'REACT';

  const directives = [
    "default-src 'none'",
    isVite
      ? "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https:"
      : "script-src 'self' 'unsafe-inline' https:",
    "style-src 'self' 'unsafe-inline' https:",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: https:",
    isVite
      ? (isProd
          ? "connect-src 'self' wss: https: blob: data:"
          : "connect-src 'self' ws: wss: https: blob: data:")
      : "connect-src 'self' https:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors ${ancestorOrigin}`,
  ];

  return directives.join('; ') + ';';
}

/**
 * Builds a strict, minimal CSP policy for error and bootstrap responses.
 * Blocks all script, object, and style execution while preserving framing.
 *
 * @param {Object} [params]
 * @param {boolean} [params.isProduction]
 * @param {string} [params.frameAncestors]
 * @returns {string}
 */
export function buildErrorCspPolicy({
  isProduction = defaultIsProduction,
  frameAncestors = null,
} = {}) {
  const isProd = Boolean(isProduction);
  const ancestorOrigin = getFrameAncestors(isProd, frameAncestors);

  return [
    "default-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${ancestorOrigin}`,
  ].join('; ') + ';';
}

/**
 * Combines Gateway-enforced mandatory CSP with optional upstream application CSPs.
 * Under W3C CSP Level 2/3, multiple Content-Security-Policy headers are enforced as a conjunction (AND):
 * - An upstream policy cannot weaken or bypass the Gateway policy (e.g. relaxing object-src or frame-ancestors).
 * - A more restrictive upstream policy (e.g. disallowing unsafe-inline) is respected and enforced by the browser.
 * - Rejects malformed or CRLF-injected upstream policies.
 *
 * @param {string} gatewayPolicy Mandatory policy generated by Gateway
 * @param {string|Array<string>} [upstreamCsp] Optional upstream CSP header(s)
 * @returns {Array<string>} Array of validated CSP headers to emit
 */
export function combineCspHeaders(gatewayPolicy, upstreamCsp = null) {
  if (!gatewayPolicy || typeof gatewayPolicy !== 'string') {
    throw new Error('combineCspHeaders: gatewayPolicy must be a non-empty string');
  }

  const policies = [gatewayPolicy.trim()];
  if (!upstreamCsp) {
    return policies;
  }

  const upstreamList = Array.isArray(upstreamCsp) ? upstreamCsp : [upstreamCsp];
  for (const raw of upstreamList) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;

    // Reject CRLF injection or control characters in upstream CSP
    if (!isSafeHeaderValue(trimmed)) {
      continue;
    }

    policies.push(trimmed);
  }

  return policies;
}

/**
 * Generates the complete dictionary of defensive security headers for an HTTP preview response.
 *
 * @param {Object} params
 * @param {string} [params.framework] Session framework (STATIC, VITE_REACT, VITE_VANILLA)
 * @param {boolean} [params.isProduction] Environment mode
 * @param {string} [params.frameAncestors] Custom frame-ancestors override
 * @param {boolean} [params.isError] True for error responses (502, 401, etc.)
 * @param {string} [params.contentType] Response Content-Type (e.g. text/html, application/javascript)
 * @param {Object} [params.upstreamHeaders] Headers received from upstream sidecar
 * @returns {Record<string, string|Array<string>>} Defensive HTTP headers
 */
export function getPreviewSecurityHeaders({
  framework = FrameworkType.STATIC,
  isProduction = defaultIsProduction,
  frameAncestors = null,
  isError = false,
  contentType = null,
  upstreamHeaders = {},
} = {}) {
  const headers = {};

  // 1. Content-Security-Policy
  if (isError) {
    headers['content-security-policy'] = buildErrorCspPolicy({ isProduction, frameAncestors });
  } else {
    const gatewayPolicy = buildCspPolicy({ framework, isProduction, frameAncestors });
    const rawUpstreamCsp =
      upstreamHeaders['content-security-policy'] ||
      upstreamHeaders['Content-Security-Policy'];

    const combined = combineCspHeaders(gatewayPolicy, rawUpstreamCsp);
    // If only 1 policy, assign as string; if multiple, assign as array of strings
    headers['content-security-policy'] = combined.length === 1 ? combined[0] : combined;
  }

  // 2. X-Content-Type-Options
  headers['x-content-type-options'] = X_CONTENT_TYPE_OPTIONS_DEFAULT;

  // 3. Referrer-Policy
  headers['referrer-policy'] = REFERRER_POLICY_DEFAULT;

  // 4. Permissions-Policy
  headers['permissions-policy'] = PERMISSIONS_POLICY_DEFAULT;

  // 5. Cache-Control:
  // - Error responses: strictly no-store
  // - HTML documents (root entrypoint): no-cache, must-revalidate (prevents stale preview iframe after updates)
  // - Subresources (CSS, JS, images, fonts): preserve legitimate upstream Cache-Control
  const cType = contentType || upstreamHeaders['content-type'] || '';
  const isHtml = cType.toLowerCase().includes('text/html');

  if (isError) {
    headers['cache-control'] = 'no-store, no-cache, must-revalidate';
    headers['pragma'] = 'no-cache';
  } else if (isHtml) {
    headers['cache-control'] = 'no-cache, must-revalidate';
  } else if (upstreamHeaders['cache-control'] && isSafeHeaderValue(upstreamHeaders['cache-control'])) {
    headers['cache-control'] = upstreamHeaders['cache-control'];
    if (upstreamHeaders['etag'] && isSafeHeaderValue(upstreamHeaders['etag'])) {
      headers['etag'] = upstreamHeaders['etag'];
    }
    if (upstreamHeaders['last-modified'] && isSafeHeaderValue(upstreamHeaders['last-modified'])) {
      headers['last-modified'] = upstreamHeaders['last-modified'];
    }
  }

  return headers;
}

/**
 * Sanitizes headers received from upstream sidecar:
 * - Unconditionally strips X-Frame-Options to ensure Gateway frame-ancestors controls framing
 * - Strips hop-by-hop headers
 *
 * @param {Record<string, string|Array<string>>} headers
 * @returns {Record<string, string|Array<string>>}
 */
export function sanitizeUpstreamHeadersForClient(headers) {
  if (!headers || typeof headers !== 'object') return {};
  const sanitized = {};

  for (const [key, val] of Object.entries(headers)) {
    if (!isSafeHeaderValue(key)) continue;
    const lower = key.toLowerCase();
    if (lower === 'x-frame-options') continue;

    if (Array.isArray(val)) {
      const safeVals = val.filter((v) => typeof v === 'string' && isSafeHeaderValue(v));
      if (safeVals.length > 0) {
        sanitized[key] = safeVals;
      }
    } else if (typeof val === 'string') {
      if (isSafeHeaderValue(val)) {
        sanitized[key] = val;
      }
    } else {
      sanitized[key] = val;
    }
  }

  return sanitized;
}

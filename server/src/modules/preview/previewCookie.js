/**
 * GitView Phase 5 — Milestone 7: __Host- Partitioned Cookie Management
 *
 * Implements RFC 6265bis __Host- cookie issuance and clearing with CHIPS partitioning:
 * - __Host- prefix mandates Secure: true, Path: '/', and NO Domain attribute
 * - HttpOnly: true prevents client-side script inspection
 * - SameSite: None + Partitioned: true permits cross-site iframe embedding
 * - Max-Age is strictly capped at remaining session lifetime (max 3600 seconds)
 */

export const PREVIEW_COOKIE_NAME = '__Host-gitview-preview-token';

/**
 * Sets the partitioned __Host- preview capability cookie on the response.
 *
 * @param {import('express').Response} res
 * @param {string} rawToken Plaintext preview token
 * @param {number} remainingLifetimeSeconds Remaining session lifetime in seconds
 */
export function setPreviewCookie(res, rawToken, remainingLifetimeSeconds) {
  if (!res || typeof res.cookie !== 'function') {
    throw new Error('Valid Express response object is required to set preview cookie');
  }
  if (!rawToken || typeof rawToken !== 'string') {
    throw new Error('rawToken is required to set preview cookie');
  }

  // Max-Age capped at 3600 seconds (1 hour), minimum 0
  const maxAgeSeconds = Math.max(0, Math.min(Math.floor(remainingLifetimeSeconds || 0), 3600));

  res.cookie(PREVIEW_COOKIE_NAME, rawToken, {
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'none',
    partitioned: true,
    maxAge: maxAgeSeconds * 1000,
    // CRITICAL: Explicitly NO Domain attribute!
  });
}

/**
 * Clears the __Host- preview cookie.
 *
 * @param {import('express').Response} res
 */
export function clearPreviewCookie(res) {
  if (!res || typeof res.clearCookie !== 'function') {
    throw new Error('Valid Express response object is required to clear preview cookie');
  }

  res.clearCookie(PREVIEW_COOKIE_NAME, {
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'none',
    partitioned: true,
  });
}

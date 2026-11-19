import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { encryptToken, decryptToken, getEncryptionKey } from './encryption.js';

/**
 * Retrieves and validates the dedicated 32-byte PREVIEW_TOKEN_ENCRYPTION_KEY.
 * Allows overrideKey for isolated unit tests.
 *
 * @param {string|Buffer} [overrideKey]
 * @returns {Buffer} 32-byte encryption key buffer
 */
export function getPreviewEncryptionKey(overrideKey) {
  const rawKey = overrideKey ?? env?.PREVIEW_TOKEN_ENCRYPTION_KEY;
  if (!rawKey) {
    throw new Error('PREVIEW_TOKEN_ENCRYPTION_KEY is required for preview token encryption');
  }
  return getEncryptionKey(rawKey);
}

/**
 * Generates a cryptographically secure random preview token.
 * 32 random bytes = 256 bits of cryptographic entropy, encoded as 64 hex characters.
 *
 * @returns {string} 64-character hex token string
 */
export function generatePreviewToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Computes the SHA-256 hash of a preview token.
 * Used for O(1) indexed lookups without exposing or storing plaintext tokens.
 *
 * @param {string} token
 * @returns {string} 64-character SHA-256 hex digest
 */
export function hashPreviewToken(token) {
  if (!token || typeof token !== 'string') {
    throw new Error('hashPreviewToken requires a non-empty string token');
  }
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Encrypts a plaintext preview token using AES-256-GCM with a dedicated key.
 * Produces a colon-delimited string: `${ivHex}:${authTagHex}:${ciphertextHex}`.
 *
 * @param {string} token
 * @param {string|Buffer} [overrideKey]
 * @returns {string} Encrypted token string
 */
export function encryptPreviewToken(token, overrideKey) {
  if (!token || typeof token !== 'string') {
    throw new Error('encryptPreviewToken requires a non-empty string token');
  }
  const key = getPreviewEncryptionKey(overrideKey);
  return encryptToken(token, key);
}

/**
 * Decrypts an AES-256-GCM encrypted preview token using the dedicated key.
 * Validates the authentication tag to guarantee integrity and authenticity.
 *
 * @param {string} encryptedData
 * @param {string|Buffer} [overrideKey]
 * @returns {string} Decrypted plaintext token
 */
export function decryptPreviewToken(encryptedData, overrideKey) {
  if (!encryptedData || typeof encryptedData !== 'string') {
    throw new Error('decryptPreviewToken requires a non-empty string');
  }
  const key = getPreviewEncryptionKey(overrideKey);
  return decryptToken(encryptedData, key);
}

/**
 * Compares two tokens in constant time using crypto.timingSafeEqual.
 * Prevents timing side-channel attacks on token verification.
 *
 * @param {string} tokenA
 * @param {string} tokenB
 * @returns {boolean} True if tokens are identical
 */
export function timingSafeCompareTokens(tokenA, tokenB) {
  if (typeof tokenA !== 'string' || typeof tokenB !== 'string') {
    return false;
  }
  const bufA = Buffer.from(tokenA, 'utf8');
  const bufB = Buffer.from(tokenB, 'utf8');

  if (bufA.length !== bufB.length) {
    return false;
  }

  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Sanitizes/masks a preview token for safe operational logging.
 * Never logs plaintext tokens or URLs containing raw tokens.
 *
 * @param {string} token
 * @returns {string} Masked token identifier (e.g. "prev_...1a2b")
 */
export function maskToken(token) {
  if (!token || typeof token !== 'string') {
    return '[INVALID_TOKEN]';
  }
  if (token.length <= 8) {
    return '[REDACTED]';
  }
  return `prev_...${token.slice(-4)}`;
}

import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  generatePreviewToken,
  hashPreviewToken,
  encryptPreviewToken,
  decryptPreviewToken,
  timingSafeCompareTokens,
  maskToken,
  getPreviewEncryptionKey,
} from '../src/utils/previewTokens.js';

describe('Preview Tokens Utility (Cryptographic Foundation)', () => {
  const testKeyA = crypto.randomBytes(32).toString('hex');
  const testKeyB = crypto.randomBytes(32).toString('hex');

  it('1. Generates cryptographically secure 256-bit hex tokens', () => {
    const token1 = generatePreviewToken();
    const token2 = generatePreviewToken();

    expect(token1).toHaveLength(64);
    expect(token2).toHaveLength(64);
    expect(token1).toMatch(/^[0-9a-f]{64}$/);
    expect(token2).toMatch(/^[0-9a-f]{64}$/);
    expect(token1).not.toBe(token2);
  });

  it('2. Computes deterministic SHA-256 hash for O(1) indexed lookup', () => {
    const token = generatePreviewToken();
    const hash1 = hashPreviewToken(token);
    const hash2 = hashPreviewToken(token);

    expect(hash1).toHaveLength(64);
    expect(hash1).toBe(hash2);

    const manualSha = crypto.createHash('sha256').update(token, 'utf8').digest('hex');
    expect(hash1).toBe(manualSha);
  });

  it('3. Rejects invalid or empty tokens in hashPreviewToken', () => {
    expect(() => hashPreviewToken('')).toThrow(/non-empty string/);
    expect(() => hashPreviewToken(null)).toThrow(/non-empty string/);
    expect(() => hashPreviewToken(12345)).toThrow(/non-empty string/);
  });

  it('4. Encrypts and decrypts tokens using AES-256-GCM', () => {
    const token = generatePreviewToken();
    const encrypted = encryptPreviewToken(token, testKeyA);

    // Format check: iv:authTag:ciphertext
    const parts = encrypted.split(':');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toHaveLength(24); // 12-byte IV in hex
    expect(parts[1]).toHaveLength(32); // 16-byte AuthTag in hex

    // Decrypt back to original
    const decrypted = decryptPreviewToken(encrypted, testKeyA);
    expect(decrypted).toBe(token);
  });

  it('5. Uses random IV for each encryption (semantic security)', () => {
    const token = generatePreviewToken();
    const enc1 = encryptPreviewToken(token, testKeyA);
    const enc2 = encryptPreviewToken(token, testKeyA);

    expect(enc1).not.toBe(enc2);
    expect(enc1.split(':')[0]).not.toBe(enc2.split(':')[0]); // different IVs
    expect(decryptPreviewToken(enc1, testKeyA)).toBe(token);
    expect(decryptPreviewToken(enc2, testKeyA)).toBe(token);
  });

  it('6. Rejects decryption with wrong encryption key', () => {
    const token = generatePreviewToken();
    const encrypted = encryptPreviewToken(token, testKeyA);

    expect(() => decryptPreviewToken(encrypted, testKeyB)).toThrow();
  });

  it('7. Detects and rejects tampered ciphertext or authentication tag', () => {
    const token = generatePreviewToken();
    const encrypted = encryptPreviewToken(token, testKeyA);
    const [iv, tag, ciphertext] = encrypted.split(':');

    // Tamper with ciphertext
    const tamperedCipher = ciphertext.slice(0, -2) + (ciphertext.slice(-2) === 'aa' ? 'bb' : 'aa');
    const tamperedEnc = `${iv}:${tag}:${tamperedCipher}`;
    expect(() => decryptPreviewToken(tamperedEnc, testKeyA)).toThrow();

    // Tamper with auth tag
    const tamperedTag = tag.slice(0, -2) + (tag.slice(-2) === '00' ? '11' : '00');
    const tamperedTagEnc = `${iv}:${tamperedTag}:${ciphertext}`;
    expect(() => decryptPreviewToken(tamperedTagEnc, testKeyA)).toThrow();
  });

  it('8. Compares tokens in constant time using timingSafeCompareTokens', () => {
    const token = generatePreviewToken();
    const identical = `${token}`;
    const different = generatePreviewToken();

    expect(timingSafeCompareTokens(token, identical)).toBe(true);
    expect(timingSafeCompareTokens(token, different)).toBe(false);
    expect(timingSafeCompareTokens(token, token.slice(0, 32))).toBe(false);
    expect(timingSafeCompareTokens(null, token)).toBe(false);
    expect(timingSafeCompareTokens(token, undefined)).toBe(false);
  });

  it('9. Masks tokens for safe operational logging without leaks', () => {
    const token = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const masked = maskToken(token);

    expect(masked).toBe('prev_...cdef');
    expect(masked).not.toContain('1234567890abcdef1234');

    expect(maskToken('')).toBe('[INVALID_TOKEN]');
    expect(maskToken('short')).toBe('[REDACTED]');
  });

  it('10. Validates key lengths and formats in getPreviewEncryptionKey', () => {
    // 32-byte Buffer
    const bufKey = crypto.randomBytes(32);
    expect(getPreviewEncryptionKey(bufKey)).toEqual(bufKey);

    // 64-hex string
    const hexKey = crypto.randomBytes(32).toString('hex');
    expect(getPreviewEncryptionKey(hexKey)).toEqual(Buffer.from(hexKey, 'hex'));

    // Invalid short key
    expect(() => getPreviewEncryptionKey('short-key')).toThrow(/must be exactly 32 bytes/);
  });
});

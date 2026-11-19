import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptToken, encryptToken, getEncryptionKey } from '../src/utils/encryption.js';

describe('AES-256-GCM Token Encryption', () => {
  const testKeyHex = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const alternativeKeyHex = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

  it('encrypts and decrypts plaintext tokens successfully', () => {
    const originalToken = 'gho_16C7e42F292c6912E7710c838347Ae178B4a';
    const encrypted = encryptToken(originalToken, testKeyHex);

    expect(encrypted).toBeTypeOf('string');
    expect(encrypted).not.toContain(originalToken);

    // Format must be iv:tag:ciphertext
    const parts = encrypted.split(':');
    expect(parts.length).toBe(3);
    expect(parts[0].length).toBe(24); // 12 bytes = 24 hex chars (IV)
    expect(parts[1].length).toBe(32); // 16 bytes = 32 hex chars (Auth tag)

    const decrypted = decryptToken(encrypted, testKeyHex);
    expect(decrypted).toBe(originalToken);
  });

  it('generates a unique IV for each encryption call (probabilistic encryption)', () => {
    const token = 'gho_secret_github_access_token';
    const enc1 = encryptToken(token, testKeyHex);
    const enc2 = encryptToken(token, testKeyHex);

    expect(enc1).not.toBe(enc2);
    expect(enc1.split(':')[0]).not.toBe(enc2.split(':')[0]); // different IVs

    expect(decryptToken(enc1, testKeyHex)).toBe(token);
    expect(decryptToken(enc2, testKeyHex)).toBe(token);
  });

  it('fails decryption when ciphertext is tampered', () => {
    const token = 'gho_secret_github_access_token';
    const encrypted = encryptToken(token, testKeyHex);
    const [iv, tag, cipher] = encrypted.split(':');

    // Flip bits in ciphertext
    const tamperedCipher = 'ff' + cipher.slice(2);
    const tamperedPayload = `${iv}:${tag}:${tamperedCipher}`;

    expect(() => decryptToken(tamperedPayload, testKeyHex)).toThrow();
  });

  it('fails decryption when auth tag is tampered', () => {
    const token = 'gho_secret_github_access_token';
    const encrypted = encryptToken(token, testKeyHex);
    const [iv, tag, cipher] = encrypted.split(':');

    const tamperedTag = tag.startsWith('00') ? 'ff' + tag.slice(2) : '00' + tag.slice(2);
    const tamperedPayload = `${iv}:${tamperedTag}:${cipher}`;

    expect(() => decryptToken(tamperedPayload, testKeyHex)).toThrow();
  });

  it('fails decryption when IV is tampered', () => {
    const token = 'gho_secret_github_access_token';
    const encrypted = encryptToken(token, testKeyHex);
    const [iv, tag, cipher] = encrypted.split(':');

    const tamperedIv = iv.startsWith('aa') ? 'bb' + iv.slice(2) : 'aa' + iv.slice(2);
    const tamperedPayload = `${tamperedIv}:${tag}:${cipher}`;

    expect(() => decryptToken(tamperedPayload, testKeyHex)).toThrow();
  });

  it('fails decryption when using a different encryption key', () => {
    const token = 'gho_secret_github_access_token';
    const encrypted = encryptToken(token, testKeyHex);

    expect(() => decryptToken(encrypted, alternativeKeyHex)).toThrow();
  });

  it('enforces 32-byte key length requirement', () => {
    const shortKey = 'too_short_key';
    expect(() => getEncryptionKey(shortKey)).toThrow(/must be exactly 32 bytes/i);

    const valid32ByteRawKey = '12345678901234567890123456789012'; // 32 chars
    expect(getEncryptionKey(valid32ByteRawKey).length).toBe(32);
  });

  it('rejects invalid or empty plaintext and ciphertext inputs', () => {
    expect(() => encryptToken('')).toThrow();
    expect(() => encryptToken(null)).toThrow();
    expect(() => decryptToken('')).toThrow();
    expect(() => decryptToken('invalid_string')).toThrow();
  });
});

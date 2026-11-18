import crypto from 'node:crypto';
import { env } from '../config/env.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits recommended for AES-GCM
const TAG_LENGTH = 16; // 128-bit authentication tag

export function getEncryptionKey(overrideKey) {
  const rawKey = overrideKey ?? env?.ENCRYPTION_KEY;
  if (!rawKey) {
    throw new Error('ENCRYPTION_KEY is required for token encryption');
  }

  let keyBuffer;
  if (Buffer.isBuffer(rawKey)) {
    keyBuffer = rawKey;
  } else if (typeof rawKey === 'string') {
    if (rawKey.length === 64 && /^[0-9a-fA-F]+$/.test(rawKey)) {
      keyBuffer = Buffer.from(rawKey, 'hex');
    } else if (rawKey.length === 32) {
      keyBuffer = Buffer.from(rawKey, 'utf8');
    } else {
      const b64 = Buffer.from(rawKey, 'base64');
      if (b64.length === 32) {
        keyBuffer = b64;
      }
    }
  }

  if (!keyBuffer || keyBuffer.length !== 32) {
    throw new Error('ENCRYPTION_KEY must be exactly 32 bytes (e.g. 64 hex characters or 32 characters)');
  }

  return keyBuffer;
}

/**
 * Encrypts a string using AES-256-GCM.
 * Stores IV, AuthTag and Ciphertext together as colon-separated hex strings.
 */
export function encryptToken(plaintext, overrideKey) {
  if (!plaintext || typeof plaintext !== 'string') {
    throw new Error('encryptToken requires a non-empty string');
  }

  const key = getEncryptionKey(overrideKey);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final()
  ]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
}

/**
 * Decrypts an AES-256-GCM encrypted string.
 * Verifies authenticity with AuthTag; throws if data or tag is tampered.
 */
export function decryptToken(encryptedData, overrideKey) {
  if (!encryptedData || typeof encryptedData !== 'string') {
    throw new Error('decryptToken requires a non-empty string');
  }

  const parts = encryptedData.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted token format');
  }

  const [ivHex, tagHex, ciphertextHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(tagHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');

  if (iv.length !== IV_LENGTH || authTag.length !== TAG_LENGTH) {
    throw new Error('Invalid IV or auth tag length in encrypted token');
  }

  const key = getEncryptionKey(overrideKey);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final()
  ]);

  return decrypted.toString('utf8');
}

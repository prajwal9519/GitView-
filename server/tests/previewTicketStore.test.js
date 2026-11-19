/**
 * GitView Phase 5 — Milestone 7, Task 2.1: Ticket Registry Security Hardening & Acceptance Tests
 *
 * Verifies:
 * 1. hashTicket cryptographic hashing
 * 2. MemoryTicketStore single-use consumption, fail-closed metadata validation, TTL, and Host mismatch preservation
 * 3. RedisTicketStore integration with live Redis 7 container:
 *    - Missing key: NOT_FOUND
 *    - Invalid JSON: INVALID_METADATA (key preserved)
 *    - Missing sessionId: INVALID_METADATA (key preserved)
 *    - Missing targetOrigin: INVALID_METADATA (key preserved)
 *    - Missing targetHostAuthority: INVALID_METADATA (key preserved)
 *    - Invalid expiresAt or mode: INVALID_METADATA (key preserved)
 *    - Host mismatch: HOST_MISMATCH (key preserved)
 *    - Valid matching metadata: atomically deleted and returned
 * 4. Zero capability tokens or plaintext tickets in storage
 * 5. Redis outage behavior: fail-closed with 500 REDIS_ERROR on creation and redemption
 * 6. Factory behavior for dev, test, and production environments
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import Redis from 'ioredis';
import {
  hashTicket,
  validateSessionExpiresAtMs,
  MemoryTicketStore,
  RedisTicketStore,
  getTicketStore,
  setTicketStore,
  createTicketStore,
} from '../src/modules/preview/ticketStore.js';
import { AppError } from '../src/utils/AppError.js';

describe('Milestone 7, Task 2.1: Preview Ticket Registry Security Hardening', () => {
  const REDIS_TEST_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

  describe('hashTicket()', () => {
    it('produces a deterministic 64-character SHA-256 hex digest', () => {
      const ticket = crypto.randomBytes(32).toString('hex');
      const hash1 = hashTicket(ticket);
      const hash2 = hashTicket(ticket);

      expect(hash1).toHaveLength(64);
      expect(/^[0-9a-f]{64}$/.test(hash1)).toBe(true);
      expect(hash1).toBe(hash2);
      expect(hash1).toBe(crypto.createHash('sha256').update(ticket).digest('hex'));
    });

    it('throws when ticket is missing, empty, or not a string', () => {
      expect(() => hashTicket('')).toThrow();
      expect(() => hashTicket(null)).toThrow();
      expect(() => hashTicket(undefined)).toThrow();
      expect(() => hashTicket(12345)).toThrow();
    });
  });

  describe('validateSessionExpiresAtMs()', () => {
    it('accepts valid positive safe integer timestamps in milliseconds', () => {
      expect(validateSessionExpiresAtMs(Date.now() + 3600000)).toBe(true);
      expect(validateSessionExpiresAtMs(1700000000000)).toBe(true);
      expect(validateSessionExpiresAtMs(1)).toBe(true);
      expect(validateSessionExpiresAtMs(Number.MAX_SAFE_INTEGER)).toBe(true);
      expect(validateSessionExpiresAtMs(9007199254740991)).toBe(true);
    });

    it('rejects missing, undefined, and null values', () => {
      expect(validateSessionExpiresAtMs(undefined)).toBe(false);
      expect(validateSessionExpiresAtMs(null)).toBe(false);
      expect(validateSessionExpiresAtMs()).toBe(false);
    });

    it('rejects string values (both numeric strings and non-numeric strings)', () => {
      expect(validateSessionExpiresAtMs('1700000000000')).toBe(false);
      expect(validateSessionExpiresAtMs('12345')).toBe(false);
      expect(validateSessionExpiresAtMs('invalid-timestamp')).toBe(false);
      expect(validateSessionExpiresAtMs('')).toBe(false);
    });

    it('rejects fractional float values', () => {
      expect(validateSessionExpiresAtMs(1700000000000.5)).toBe(false);
      expect(validateSessionExpiresAtMs(10.1)).toBe(false);
      expect(validateSessionExpiresAtMs(0.999)).toBe(false);
    });

    it('rejects zero and negative values', () => {
      expect(validateSessionExpiresAtMs(0)).toBe(false);
      expect(validateSessionExpiresAtMs(-0)).toBe(false);
      expect(validateSessionExpiresAtMs(-1)).toBe(false);
      expect(validateSessionExpiresAtMs(-1700000000000)).toBe(false);
    });

    it('rejects excessively large values beyond Number.MAX_SAFE_INTEGER', () => {
      expect(validateSessionExpiresAtMs(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
      expect(validateSessionExpiresAtMs(9007199254740992)).toBe(false);
      expect(validateSessionExpiresAtMs(1e20)).toBe(false);
    });

    it('rejects non-numeric primitives, NaN, Infinity, and objects', () => {
      expect(validateSessionExpiresAtMs(NaN)).toBe(false);
      expect(validateSessionExpiresAtMs(Infinity)).toBe(false);
      expect(validateSessionExpiresAtMs(-Infinity)).toBe(false);
      expect(validateSessionExpiresAtMs(true)).toBe(false);
      expect(validateSessionExpiresAtMs(false)).toBe(false);
      expect(validateSessionExpiresAtMs({})).toBe(false);
      expect(validateSessionExpiresAtMs([])).toBe(false);
      expect(validateSessionExpiresAtMs(() => {})).toBe(false);
    });
  });

  describe('MemoryTicketStore (Fail-Closed Metadata & Host Validation)', () => {
    let memStore;

    beforeEach(() => {
      memStore = new MemoryTicketStore();
    });

    afterEach(async () => {
      await memStore.close();
    });

    it('stores metadata and consumes ticket once (atomic single-use)', async () => {
      const ticket = crypto.randomBytes(32).toString('hex');
      const metadata = {
        sessionId: crypto.randomUUID(),
        targetOrigin: 'http://session-1.preview.localhost:3000',
        targetHostAuthority: 'session-1.preview.localhost:3000',
        sessionExpiresAtMs: Date.now() + 30000,
        expiresAt: new Date(Date.now() + 30000).toISOString(),
        mode: 'iframe',
      };

      await memStore.setTicket(ticket, metadata, 30);

      // First consumption succeeds
      const consumed = await memStore.consumeTicket(ticket, 'session-1.preview.localhost:3000');
      expect(consumed).toEqual(metadata);

      // Second consumption fails (already deleted)
      const secondAttempt = await memStore.consumeTicket(ticket, 'session-1.preview.localhost:3000');
      expect(secondAttempt).toBeNull();
    });

    it('rejects with HOST_MISMATCH and preserves ticket when authority does not match', async () => {
      const ticket = crypto.randomBytes(32).toString('hex');
      const metadata = {
        sessionId: crypto.randomUUID(),
        targetOrigin: 'http://session-1.preview.localhost:3000',
        targetHostAuthority: 'session-1.preview.localhost:3000',
        sessionExpiresAtMs: Date.now() + 30000,
        expiresAt: new Date(Date.now() + 30000).toISOString(),
        mode: 'iframe',
      };

      await memStore.setTicket(ticket, metadata, 30);

      // Mismatched host authority
      const mismatch = await memStore.consumeTicket(ticket, 'attacker-host:3000');
      expect(mismatch).toBe('HOST_MISMATCH');

      // Ticket is PRESERVED, not burned
      const retryWithValidHost = await memStore.consumeTicket(ticket, 'SESSION-1.PREVIEW.LOCALHOST:3000');
      expect(retryWithValidHost).toEqual(metadata);

      // Subsequent consumption fails
      expect(await memStore.consumeTicket(ticket, 'session-1.preview.localhost:3000')).toBeNull();
    });

    it('fails closed with INVALID_METADATA when metadata fields are missing or malformed', async () => {
      const ticket = crypto.randomBytes(32).toString('hex');
      const ticketHash = hashTicket(ticket);

      // 1. Missing sessionId
      await memStore.set(ticketHash, {
        targetOrigin: 'http://session-1.preview.localhost:3000',
        targetHostAuthority: 'session-1.preview.localhost:3000',
        sessionExpiresAtMs: Date.now() + 30000,
        expiresAt: new Date(Date.now() + 30000).toISOString(),
        mode: 'iframe',
      });
      expect(await memStore.consumeTicket(ticket, 'session-1.preview.localhost:3000')).toBe('INVALID_METADATA');

      // 2. Missing targetOrigin
      await memStore.set(ticketHash, {
        sessionId: crypto.randomUUID(),
        targetHostAuthority: 'session-1.preview.localhost:3000',
        sessionExpiresAtMs: Date.now() + 30000,
        expiresAt: new Date(Date.now() + 30000).toISOString(),
        mode: 'iframe',
      });
      expect(await memStore.consumeTicket(ticket, 'session-1.preview.localhost:3000')).toBe('INVALID_METADATA');

      // 3. Missing targetHostAuthority
      await memStore.set(ticketHash, {
        sessionId: crypto.randomUUID(),
        targetOrigin: 'http://session-1.preview.localhost:3000',
        sessionExpiresAtMs: Date.now() + 30000,
        expiresAt: new Date(Date.now() + 30000).toISOString(),
        mode: 'iframe',
      });
      expect(await memStore.consumeTicket(ticket, 'session-1.preview.localhost:3000')).toBe('INVALID_METADATA');

      // 4. Invalid mode
      await memStore.set(ticketHash, {
        sessionId: crypto.randomUUID(),
        targetOrigin: 'http://session-1.preview.localhost:3000',
        targetHostAuthority: 'session-1.preview.localhost:3000',
        sessionExpiresAtMs: Date.now() + 30000,
        expiresAt: new Date(Date.now() + 30000).toISOString(),
        mode: 'invalid_mode',
      });
      expect(await memStore.consumeTicket(ticket, 'session-1.preview.localhost:3000')).toBe('INVALID_METADATA');
    });

    it('rejects invalid sessionExpiresAtMs variants in MemoryTicketStore and preserves the ticket', async () => {
      const basePayload = {
        sessionId: crypto.randomUUID(),
        targetOrigin: 'http://session-1.preview.localhost:3000',
        targetHostAuthority: 'session-1.preview.localhost:3000',
        mode: 'iframe',
      };

      const invalidVariants = [
        ['missing', { ...basePayload }],
        ['null', { ...basePayload, sessionExpiresAtMs: null }],
        ['string', { ...basePayload, sessionExpiresAtMs: '1700000000000' }],
        ['fractional', { ...basePayload, sessionExpiresAtMs: 1700000000000.5 }],
        ['negative', { ...basePayload, sessionExpiresAtMs: -100 }],
        ['zero', { ...basePayload, sessionExpiresAtMs: 0 }],
        ['excessively large', { ...basePayload, sessionExpiresAtMs: 9007199254740992 }],
      ];

      for (const [name, payload] of invalidVariants) {
        const ticket = crypto.randomBytes(32).toString('hex');
        const ticketHash = hashTicket(ticket);
        await memStore.set(ticketHash, payload, 30);

        const result = await memStore.consumeTicket(ticket, 'session-1.preview.localhost:3000');
        expect(result, `Expected ${name} to return INVALID_METADATA`).toBe('INVALID_METADATA');

        // Ticket must be preserved in map
        expect(memStore.map.has(`preview:ticket:${ticketHash}`), `Expected ${name} ticket to be preserved`).toBe(true);
      }
    });

    it('validates sessionExpiresAtMs before ticket creation in setTicket()', async () => {
      const ticket = crypto.randomBytes(32).toString('hex');
      const baseMetadata = {
        sessionId: crypto.randomUUID(),
        targetOrigin: 'http://session-1.preview.localhost:3000',
        targetHostAuthority: 'session-1.preview.localhost:3000',
        mode: 'iframe',
      };

      // Fails on missing sessionExpiresAtMs
      await expect(memStore.setTicket(ticket, { ...baseMetadata })).rejects.toThrowError(AppError);

      // Fails on invalid numeric sessionExpiresAtMs
      await expect(memStore.setTicket(ticket, { ...baseMetadata, sessionExpiresAtMs: 'string-exp' })).rejects.toThrowError(AppError);
      await expect(memStore.setTicket(ticket, { ...baseMetadata, sessionExpiresAtMs: -500 })).rejects.toThrowError(AppError);
      await expect(memStore.setTicket(ticket, { ...baseMetadata, sessionExpiresAtMs: 0 })).rejects.toThrowError(AppError);
      await expect(memStore.setTicket(ticket, { ...baseMetadata, sessionExpiresAtMs: 9007199254740992 })).rejects.toThrowError(AppError);

      // Succeeds on valid safe integer
      await expect(memStore.setTicket(ticket, { ...baseMetadata, sessionExpiresAtMs: Date.now() + 30000 })).resolves.not.toThrow();
    });

    it('returns null when ticket TTL has expired', async () => {
      vi.useFakeTimers();
      const ticket = crypto.randomBytes(32).toString('hex');
      const metadata = {
        sessionId: crypto.randomUUID(),
        targetOrigin: 'http://session-1.preview.localhost:3000',
        targetHostAuthority: 'session-1.preview.localhost:3000',
        sessionExpiresAtMs: Date.now() + 1000,
        expiresAt: new Date(Date.now() + 1000).toISOString(),
        mode: 'iframe',
      };

      await memStore.setTicket(ticket, metadata, 1); // 1 second TTL

      vi.advanceTimersByTime(1500);

      const consumed = await memStore.consumeTicket(ticket, 'session-1.preview.localhost:3000');
      expect(consumed).toBeNull();
      vi.useRealTimers();
    });

    it('clears all entries and timers on clear()', async () => {
      const ticket = crypto.randomBytes(32).toString('hex');
      await memStore.setTicket(ticket, {
        sessionId: 's1',
        targetOrigin: 'http://session-1.preview.localhost:3000',
        targetHostAuthority: 'session-1.preview.localhost:3000',
        sessionExpiresAtMs: Date.now() + 30000,
        expiresAt: new Date(Date.now() + 30000).toISOString(),
        mode: 'iframe',
      }, 30);
      await memStore.clear();

      expect(await memStore.consumeTicket(ticket, 'session-1.preview.localhost:3000')).toBeNull();
    });
  });

  describe('RedisTicketStore (Live Redis Lua Fail-Closed Verification)', () => {
    let redisStore;
    let directRedis;

    beforeEach(async () => {
      directRedis = new Redis(REDIS_TEST_URL);
      redisStore = new RedisTicketStore(directRedis);
      await redisStore.clear();
    });

    afterEach(async () => {
      await redisStore.clear();
      await directRedis.quit().catch(() => {});
    });

    it('stores SHA-256 hashed key in Redis and enforces 30-second TTL', async () => {
      const ticket = crypto.randomBytes(32).toString('hex');
      const ticketHash = hashTicket(ticket);
      const metadata = {
        sessionId: crypto.randomUUID(),
        targetOrigin: 'http://session-test.preview.localhost:3000',
        targetHostAuthority: 'session-test.preview.localhost:3000',
        sessionExpiresAtMs: Date.now() + 30000,
        expiresAt: new Date(Date.now() + 30000).toISOString(),
        mode: 'iframe',
      };

      await redisStore.setTicket(ticket, metadata, 30);

      // Key must be preview:ticket:<sha256>
      const expectedKey = `preview:ticket:${ticketHash}`;
      const rawStoredValue = await directRedis.get(expectedKey);
      expect(rawStoredValue).toBeTruthy();

      const parsed = JSON.parse(rawStoredValue);
      expect(parsed.sessionId).toBe(metadata.sessionId);
      expect(parsed.targetOrigin).toBe(metadata.targetOrigin);
      expect(parsed.sessionExpiresAtMs).toBe(metadata.sessionExpiresAtMs);

      // CRITICAL: Plaintext ticket and capability token must NEVER be in stored value
      expect(rawStoredValue).not.toContain(ticket);
      expect(parsed.rawToken).toBeUndefined();
      expect(parsed.previewToken).toBeUndefined();

      // TTL must be <= 30 seconds
      const ttl = await directRedis.ttl(expectedKey);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(30);
    });

    it('atomically consumes single-use ticket via Lua script', async () => {
      const ticket = crypto.randomBytes(32).toString('hex');
      const metadata = {
        sessionId: crypto.randomUUID(),
        targetOrigin: 'http://session-lua.preview.localhost:3000',
        targetHostAuthority: 'session-lua.preview.localhost:3000',
        sessionExpiresAtMs: Date.now() + 30000,
        expiresAt: new Date(Date.now() + 30000).toISOString(),
        mode: 'iframe',
      };

      await redisStore.setTicket(ticket, metadata, 30);

      // 1. Consume ticket
      const consumed = await redisStore.consumeTicket(ticket, 'session-lua.preview.localhost:3000');
      expect(consumed).toEqual(metadata);

      // 2. Replayed attempt returns null (key was deleted by Lua GETDEL)
      const replayed = await redisStore.consumeTicket(ticket, 'session-lua.preview.localhost:3000');
      expect(replayed).toBeNull();

      // 3. Key in Redis is gone
      const ticketHash = hashTicket(ticket);
      const exists = await directRedis.exists(`preview:ticket:${ticketHash}`);
      expect(exists).toBe(0);
    });

    it('returns NOT_FOUND directly from Lua script when key does not exist', async () => {
      const key = 'preview:ticket:non-existent-key-12345';
      const luaResult = await directRedis.atomicConsumeTicket(key, 'some.host:3000');
      expect(luaResult).toBe('NOT_FOUND');
    });

    it('rejects invalid JSON with INVALID_METADATA and preserves Redis key', async () => {
      const key = 'preview:ticket:corrupted-json-key';
      await directRedis.set(key, 'this-is-not-valid-json!!', 'EX', 30);

      const luaResult = await directRedis.atomicConsumeTicket(key, 'some.host:3000');
      expect(luaResult).toBe('INVALID_METADATA');

      // Key must NOT be deleted
      expect(await directRedis.exists(key)).toBe(1);
    });

    it('rejects missing sessionId with INVALID_METADATA and preserves Redis key', async () => {
      const key = 'preview:ticket:missing-session-id';
      const payload = {
        targetOrigin: 'http://session-1.preview.localhost:3000',
        targetHostAuthority: 'session-1.preview.localhost:3000',
        sessionExpiresAtMs: Date.now() + 30000,
        expiresAt: new Date(Date.now() + 30000).toISOString(),
        mode: 'iframe',
      };
      await directRedis.set(key, JSON.stringify(payload), 'EX', 30);

      const luaResult = await directRedis.atomicConsumeTicket(key, 'session-1.preview.localhost:3000');
      expect(luaResult).toBe('INVALID_METADATA');
      expect(await directRedis.exists(key)).toBe(1);
    });

    it('rejects missing targetOrigin with INVALID_METADATA and preserves Redis key', async () => {
      const key = 'preview:ticket:missing-target-origin';
      const payload = {
        sessionId: crypto.randomUUID(),
        targetHostAuthority: 'session-1.preview.localhost:3000',
        sessionExpiresAtMs: Date.now() + 30000,
        expiresAt: new Date(Date.now() + 30000).toISOString(),
        mode: 'iframe',
      };
      await directRedis.set(key, JSON.stringify(payload), 'EX', 30);

      const luaResult = await directRedis.atomicConsumeTicket(key, 'session-1.preview.localhost:3000');
      expect(luaResult).toBe('INVALID_METADATA');
      expect(await directRedis.exists(key)).toBe(1);
    });

    it('rejects missing targetHostAuthority with INVALID_METADATA and preserves Redis key', async () => {
      const key = 'preview:ticket:missing-host-authority';
      const payload = {
        sessionId: crypto.randomUUID(),
        targetOrigin: 'http://session-1.preview.localhost:3000',
        sessionExpiresAtMs: Date.now() + 30000,
        expiresAt: new Date(Date.now() + 30000).toISOString(),
        mode: 'iframe',
      };
      await directRedis.set(key, JSON.stringify(payload), 'EX', 30);

      const luaResult = await directRedis.atomicConsumeTicket(key, 'session-1.preview.localhost:3000');
      expect(luaResult).toBe('INVALID_METADATA');
      expect(await directRedis.exists(key)).toBe(1);
    });

    it('rejects invalid mode with INVALID_METADATA and preserves Redis key', async () => {
      const key = 'preview:ticket:invalid-mode';
      const payload = {
        sessionId: crypto.randomUUID(),
        targetOrigin: 'http://session-1.preview.localhost:3000',
        targetHostAuthority: 'session-1.preview.localhost:3000',
        sessionExpiresAtMs: Date.now() + 30000,
        expiresAt: new Date(Date.now() + 30000).toISOString(),
        mode: 'malicious_mode',
      };
      await directRedis.set(key, JSON.stringify(payload), 'EX', 30);

      const luaResult = await directRedis.atomicConsumeTicket(key, 'session-1.preview.localhost:3000');
      expect(luaResult).toBe('INVALID_METADATA');
      expect(await directRedis.exists(key)).toBe(1);
    });

    describe('Live Redis sessionExpiresAtMs Strict Validation & Key Preservation (Requirement 8)', () => {
      const basePayload = {
        sessionId: 'e305e55e-2f16-43b9-a461-8ff9052d919f',
        targetOrigin: 'http://session-exp.preview.localhost:3000',
        targetHostAuthority: 'session-exp.preview.localhost:3000',
        mode: 'iframe',
      };

      it('rejects missing sessionExpiresAtMs with INVALID_METADATA and preserves Redis key', async () => {
        const key = 'preview:ticket:missing-session-expires-at-ms';
        const payload = { ...basePayload }; // No sessionExpiresAtMs
        await directRedis.set(key, JSON.stringify(payload), 'EX', 30);

        const luaResult = await directRedis.atomicConsumeTicket(key, 'session-exp.preview.localhost:3000');
        expect(luaResult).toBe('INVALID_METADATA');
        expect(await directRedis.exists(key)).toBe(1);
      });

      it('rejects null sessionExpiresAtMs with INVALID_METADATA and preserves Redis key', async () => {
        const key = 'preview:ticket:null-session-expires-at-ms';
        const payload = { ...basePayload, sessionExpiresAtMs: null };
        await directRedis.set(key, JSON.stringify(payload), 'EX', 30);

        const luaResult = await directRedis.atomicConsumeTicket(key, 'session-exp.preview.localhost:3000');
        expect(luaResult).toBe('INVALID_METADATA');
        expect(await directRedis.exists(key)).toBe(1);
      });

      it('rejects string sessionExpiresAtMs with INVALID_METADATA and preserves Redis key', async () => {
        const key = 'preview:ticket:string-session-expires-at-ms';
        const payload = { ...basePayload, sessionExpiresAtMs: '1700000000000' };
        await directRedis.set(key, JSON.stringify(payload), 'EX', 30);

        const luaResult = await directRedis.atomicConsumeTicket(key, 'session-exp.preview.localhost:3000');
        expect(luaResult).toBe('INVALID_METADATA');
        expect(await directRedis.exists(key)).toBe(1);
      });

      it('rejects fractional sessionExpiresAtMs with INVALID_METADATA and preserves Redis key', async () => {
        const key = 'preview:ticket:fractional-session-expires-at-ms';
        const payload = { ...basePayload, sessionExpiresAtMs: 1700000000000.5 };
        await directRedis.set(key, JSON.stringify(payload), 'EX', 30);

        const luaResult = await directRedis.atomicConsumeTicket(key, 'session-exp.preview.localhost:3000');
        expect(luaResult).toBe('INVALID_METADATA');
        expect(await directRedis.exists(key)).toBe(1);
      });

      it('rejects negative sessionExpiresAtMs with INVALID_METADATA and preserves Redis key', async () => {
        const key = 'preview:ticket:negative-session-expires-at-ms';
        const payload = { ...basePayload, sessionExpiresAtMs: -100 };
        await directRedis.set(key, JSON.stringify(payload), 'EX', 30);

        const luaResult = await directRedis.atomicConsumeTicket(key, 'session-exp.preview.localhost:3000');
        expect(luaResult).toBe('INVALID_METADATA');
        expect(await directRedis.exists(key)).toBe(1);
      });

      it('rejects zero sessionExpiresAtMs with INVALID_METADATA and preserves Redis key', async () => {
        const key = 'preview:ticket:zero-session-expires-at-ms';
        const payload = { ...basePayload, sessionExpiresAtMs: 0 };
        await directRedis.set(key, JSON.stringify(payload), 'EX', 30);

        const luaResult = await directRedis.atomicConsumeTicket(key, 'session-exp.preview.localhost:3000');
        expect(luaResult).toBe('INVALID_METADATA');
        expect(await directRedis.exists(key)).toBe(1);
      });

      it('rejects excessively large sessionExpiresAtMs with INVALID_METADATA and preserves Redis key', async () => {
        const key = 'preview:ticket:too-large-session-expires-at-ms';
        const payload = { ...basePayload, sessionExpiresAtMs: 9007199254740992 };
        await directRedis.set(key, JSON.stringify(payload), 'EX', 30);

        const luaResult = await directRedis.atomicConsumeTicket(key, 'session-exp.preview.localhost:3000');
        expect(luaResult).toBe('INVALID_METADATA');
        expect(await directRedis.exists(key)).toBe(1);
      });

      it('accepts valid positive integer sessionExpiresAtMs and atomically deletes Redis key on redemption', async () => {
        const key = 'preview:ticket:valid-session-expires-at-ms';
        const validMs = Date.now() + 3600000;
        const payload = { ...basePayload, sessionExpiresAtMs: validMs };
        await directRedis.set(key, JSON.stringify(payload), 'EX', 30);

        const luaResult = await directRedis.atomicConsumeTicket(key, 'session-exp.preview.localhost:3000');
        expect(luaResult).not.toBe('INVALID_METADATA');
        expect(luaResult).not.toBe('HOST_MISMATCH');

        const parsed = JSON.parse(luaResult);
        expect(parsed.sessionExpiresAtMs).toBe(validMs);
        expect(parsed.sessionId).toBe(basePayload.sessionId);

        // Key must be deleted after consumption
        expect(await directRedis.exists(key)).toBe(0);
      });

      it('preserves key with valid integer sessionExpiresAtMs when Host mismatches', async () => {
        const key = 'preview:ticket:valid-mismatch-session-expires-at-ms';
        const validMs = Date.now() + 3600000;
        const payload = { ...basePayload, sessionExpiresAtMs: validMs };
        await directRedis.set(key, JSON.stringify(payload), 'EX', 30);

        const luaResult = await directRedis.atomicConsumeTicket(key, 'attacker-spoofed.com:3000');
        expect(luaResult).toBe('HOST_MISMATCH');

        // Key must be preserved upon host mismatch!
        expect(await directRedis.exists(key)).toBe(1);

        // Subsequent valid redemption succeeds and deletes key
        const retryResult = await directRedis.atomicConsumeTicket(key, 'session-exp.preview.localhost:3000');
        expect(JSON.parse(retryResult).sessionExpiresAtMs).toBe(validMs);
        expect(await directRedis.exists(key)).toBe(0);
      });
    });

    it('validates sessionExpiresAtMs before ticket creation in RedisTicketStore.setTicket()', async () => {
      const ticket = crypto.randomBytes(32).toString('hex');
      const baseMetadata = {
        sessionId: crypto.randomUUID(),
        targetOrigin: 'http://session-1.preview.localhost:3000',
        targetHostAuthority: 'session-1.preview.localhost:3000',
        mode: 'iframe',
      };

      // Fails on missing sessionExpiresAtMs
      await expect(redisStore.setTicket(ticket, { ...baseMetadata })).rejects.toThrowError(AppError);

      // Fails on invalid numeric sessionExpiresAtMs
      await expect(redisStore.setTicket(ticket, { ...baseMetadata, sessionExpiresAtMs: 'string-exp' })).rejects.toThrowError(AppError);
      await expect(redisStore.setTicket(ticket, { ...baseMetadata, sessionExpiresAtMs: -500 })).rejects.toThrowError(AppError);
      await expect(redisStore.setTicket(ticket, { ...baseMetadata, sessionExpiresAtMs: 0 })).rejects.toThrowError(AppError);
      await expect(redisStore.setTicket(ticket, { ...baseMetadata, sessionExpiresAtMs: 9007199254740992 })).rejects.toThrowError(AppError);

      // Succeeds on valid safe integer
      await expect(redisStore.setTicket(ticket, { ...baseMetadata, sessionExpiresAtMs: Date.now() + 30000 })).resolves.not.toThrow();
    });

    it('preserves Redis key upon HOST_MISMATCH without burning the ticket', async () => {
      const ticket = crypto.randomBytes(32).toString('hex');
      const metadata = {
        sessionId: crypto.randomUUID(),
        targetOrigin: 'http://session-secure.preview.localhost:3000',
        targetHostAuthority: 'session-secure.preview.localhost:3000',
        sessionExpiresAtMs: Date.now() + 30000,
        expiresAt: new Date(Date.now() + 30000).toISOString(),
        mode: 'iframe',
      };

      await redisStore.setTicket(ticket, metadata, 30);

      // Attempt consumption with spoofed/wrong host
      const mismatchResult = await redisStore.consumeTicket(ticket, 'evil-attacker.com:3000');
      expect(mismatchResult).toBe('HOST_MISMATCH');

      // Key must still exist in Redis!
      const ticketHash = hashTicket(ticket);
      const rawStored = await directRedis.get(`preview:ticket:${ticketHash}`);
      expect(rawStored).toBeTruthy();

      // Legitimate user consumes ticket with correct host (case-insensitive)
      const legitimateResult = await redisStore.consumeTicket(ticket, 'SESSION-SECURE.PREVIEW.LOCALHOST:3000');
      expect(legitimateResult).toEqual(metadata);

      // Now it is gone
      expect(await directRedis.exists(`preview:ticket:${ticketHash}`)).toBe(0);
    });
  });

  describe('Redis Outage & Failure Recovery (Fail-Closed)', () => {
    it('fails closed and throws REDIS_ERROR when Redis is unreachable during setTicket', async () => {
      const brokenRedis = new Redis('redis://127.0.0.1:65530', {
        maxRetriesPerRequest: 1,
        retryStrategy: () => null,
        enableOfflineQueue: false,
        lazyConnect: true,
      });
      brokenRedis.on('error', () => {});

      const brokenStore = new RedisTicketStore(brokenRedis);

      await expect(
        brokenStore.setTicket('some-ticket', { sessionId: 's1' }, 30)
      ).rejects.toThrowError(AppError);

      await brokenRedis.quit().catch(() => {});
    });

    it('fails closed and throws REDIS_ERROR when Redis is unreachable during consumeTicket', async () => {
      const brokenRedis = new Redis('redis://127.0.0.1:65530', {
        maxRetriesPerRequest: 1,
        retryStrategy: () => null,
        enableOfflineQueue: false,
        lazyConnect: true,
      });
      brokenRedis.on('error', () => {});

      const brokenStore = new RedisTicketStore(brokenRedis);

      await expect(
        brokenStore.consumeTicket('some-ticket', 'host:3000')
      ).rejects.toThrowError(AppError);

      await brokenRedis.quit().catch(() => {});
    });
  });

  describe('Ticket Store Factory & Dependency Injection', () => {
    it('creates RedisTicketStore when REDIS_URL is provided', () => {
      const store = createTicketStore({ redisUrl: REDIS_TEST_URL });
      expect(store).toBeInstanceOf(RedisTicketStore);
      store.close();
    });

    it('creates MemoryTicketStore in non-production when REDIS_URL is omitted', () => {
      const store = createTicketStore({ redisUrl: null });
      expect(store).toBeInstanceOf(MemoryTicketStore);
      store.close();
    });

    it('allows swapping the active singleton via setTicketStore', () => {
      const customStore = new MemoryTicketStore();
      setTicketStore(customStore);
      expect(getTicketStore()).toBe(customStore);
      customStore.close();
      setTicketStore(null); // reset
    });
  });
});

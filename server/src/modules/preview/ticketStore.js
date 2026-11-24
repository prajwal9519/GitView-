/**
 * GitView Phase 5 — Milestone 7, Task 2: Single-Use Preview Ticket Registry
 *
 * Implements ITicketStore interface with production Redis and local Memory adapters:
 * - Production: Redis 6.2+ atomic GETDEL / Lua script with host authority validation
 * - Development: In-memory Map adapter with TTL cleanup and single-process warning
 * - Keys: preview:ticket:${sha256(rawTicket)}
 * - Zero preview capability tokens stored in Redis / memory
 * - 30-second strict TTL
 */

import crypto from 'node:crypto';
import Redis from 'ioredis';
import { env } from '../../config/env.js';
import { AppError } from '../../utils/AppError.js';

/**
 * Computes SHA-256 hash of a raw ticket string.
 * Used for Redis key hashing to prevent plaintext ticket leakage in keyspaces.
 *
 * @param {string} ticket
 * @returns {string} 64-character hex hash
 */
export function hashTicket(ticket) {
  if (!ticket || typeof ticket !== 'string') {
    throw new Error('hashTicket requires a non-empty string ticket');
  }
  return crypto.createHash('sha256').update(ticket, 'utf8').digest('hex');
}

/**
 * Validates that sessionExpiresAtMs is a positive safe integer Unix timestamp in milliseconds.
 * Rejects missing, null, string, non-numeric, fractional, negative, zero, and excessively large values (> Number.MAX_SAFE_INTEGER).
 *
 * @param {any} exp
 * @returns {boolean}
 */
export function validateSessionExpiresAtMs(exp) {
  return typeof exp === 'number' && Number.isSafeInteger(exp) && exp > 0;
}

/**
 * Common Ticket Store Interface
 */
export class ITicketStore {
  async setTicket(_ticket, _metadata, _ttlSeconds = 30) {
    throw new Error('ITicketStore.setTicket() must be implemented');
  }

  async set(_ticketHash, _metadata, _ttlSeconds = 30) {
    throw new Error('ITicketStore.set() must be implemented');
  }

  async consumeTicket(_ticket, _expectedHost = null) {
    throw new Error('ITicketStore.consumeTicket() must be implemented');
  }

  async consume(_ticketHash, _expectedHost = null) {
    throw new Error('ITicketStore.consume() must be implemented');
  }

  async clear() {
    throw new Error('ITicketStore.clear() must be implemented');
  }

  async invalidateSessionTickets(_sessionId) {
    throw new Error('ITicketStore.invalidateSessionTickets() must be implemented');
  }

  async close() {
    // Optional cleanup
  }
}

/**
 * Production Redis-Backed Ticket Store
 * Utilizes atomic Lua script to verify Host authority before consumption,
 * preventing valid tickets from being burned by attacker-controlled hosts.
 */
export class RedisTicketStore extends ITicketStore {
  constructor(redisClientOrUrl) {
    super();

    if (typeof redisClientOrUrl === 'string') {
      this.redis = new Redis(redisClientOrUrl, {
        maxRetriesPerRequest: 2,
        enableReadyCheck: true,
        lazyConnect: false,
      });
      this.redis.on('error', () => {
        // Suppress unhandled EventEmitter crash; operations reject cleanly
      });
      this.ownsClient = true;
    } else if (redisClientOrUrl) {
      this.redis = redisClientOrUrl;
      this.redis.on('error', () => {
        // Suppress unhandled EventEmitter crash; operations reject cleanly
      });
      this.ownsClient = false;
    } else {
      throw new Error('RedisTicketStore requires a Redis client instance or connection URL');
    }

    this._registerLuaCommands();
  }

  _registerLuaCommands() {
    this.redis.defineCommand('atomicConsumeTicket', {
      numberOfKeys: 1,
      lua: `
        local key = KEYS[1]
        local expectedHost = ARGV[1]

        local val = redis.call('GET', key)
        if not val then
          return 'NOT_FOUND'
        end

        local ok, decoded = pcall(cjson.decode, val)
        if not ok or type(decoded) ~= 'table' then
          return 'INVALID_METADATA'
        end

        -- Validate required fields (fail-closed)
        if not decoded.sessionId or type(decoded.sessionId) ~= 'string' or decoded.sessionId == '' then
          return 'INVALID_METADATA'
        end

        if not decoded.targetOrigin or type(decoded.targetOrigin) ~= 'string' or decoded.targetOrigin == '' then
          return 'INVALID_METADATA'
        end

        if not decoded.targetHostAuthority or type(decoded.targetHostAuthority) ~= 'string' or decoded.targetHostAuthority == '' then
          return 'INVALID_METADATA'
        end

        -- Validate sessionExpiresAtMs: positive safe integer timestamp in milliseconds
        local exp = decoded.sessionExpiresAtMs
        if not exp or type(exp) ~= 'number' or exp ~= exp or exp == math.huge or exp == -math.huge then
          return 'INVALID_METADATA'
        end

        if exp <= 0 or exp > 9007199254740991 or math.floor(exp) ~= exp then
          return 'INVALID_METADATA'
        end

        if not decoded.mode or (decoded.mode ~= 'iframe' and decoded.mode ~= 'toplevel') then
          return 'INVALID_METADATA'
        end

        -- Validate Host authority
        if not expectedHost or expectedHost == '' then
          return 'HOST_MISMATCH'
        end

        if string.lower(decoded.targetHostAuthority) ~= string.lower(expectedHost) then
          return 'HOST_MISMATCH'
        end

        -- All validations passed: atomically delete and return JSON string
        redis.call('DEL', key)
        return val
      `,
    });
  }

  /**
   * Stores a single-use ticket in Redis with SHA-256 hashed key and 30s TTL.
   *
   * @param {string} ticket Raw 64-char hex ticket
   * @param {Object} metadata { sessionId, targetOrigin, targetHostAuthority, sessionExpiresAtMs, mode }
   * @param {number} [ttlSeconds=30]
   */
  async setTicket(ticket, metadata, ttlSeconds = 30) {
    if (!metadata || !validateSessionExpiresAtMs(metadata.sessionExpiresAtMs)) {
      throw new AppError(400, 'INVALID_METADATA', 'sessionExpiresAtMs must be a positive safe integer');
    }
    const ticketHash = hashTicket(ticket);
    return this.set(ticketHash, metadata, ttlSeconds);
  }

  async set(ticketHash, metadata, ttlSeconds = 30) {
    const key = `preview:ticket:${ticketHash}`;
    const value = JSON.stringify(metadata);
    try {
      await this.redis.set(key, value, 'EX', ttlSeconds);
      if (metadata?.sessionId) {
        const sessionKey = `preview:session:tickets:${metadata.sessionId}`;
        await this.redis.sadd(sessionKey, ticketHash);
        await this.redis.expire(sessionKey, ttlSeconds * 2);
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError(500, 'REDIS_ERROR', `Failed to write bootstrap ticket to Redis: ${err.message}`);
    }
  }

  async invalidateSessionTickets(sessionId) {
    if (!sessionId) return;
    try {
      const sessionKey = `preview:session:tickets:${sessionId}`;
      const ticketHashes = await this.redis.smembers(sessionKey);
      if (ticketHashes && ticketHashes.length > 0) {
        const ticketKeys = ticketHashes.map((h) => `preview:ticket:${h}`);
        await this.redis.del(...ticketKeys, sessionKey);
      } else {
        await this.redis.del(sessionKey);
      }
    } catch {
      // Non-fatal cleanup
    }
  }

  /**
   * Atomically consumes a single-use ticket.
   * If expectedHost is provided and does not match targetHostAuthority,
   * returns 'HOST_MISMATCH' without deleting the ticket.
   *
   * @param {string} ticket Raw ticket
   * @param {string} [expectedHost=null] Incoming Host header authority
   * @returns {Promise<Object|string|null>} Parsed metadata, 'HOST_MISMATCH', or null
   */
  async consumeTicket(ticket, expectedHost = null) {
    const ticketHash = hashTicket(ticket);
    return this.consume(ticketHash, expectedHost);
  }

  async consume(ticketHash, expectedHost = null) {
    const key = `preview:ticket:${ticketHash}`;
    try {
      const result = await this.redis.atomicConsumeTicket(key, expectedHost || '');
      if (!result || result === 'NOT_FOUND') {
        return null;
      }
      if (result === 'INVALID_METADATA') {
        return 'INVALID_METADATA';
      }
      if (result === 'HOST_MISMATCH') {
        return 'HOST_MISMATCH';
      }
      return JSON.parse(result);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError(500, 'REDIS_ERROR', `Failed to consume bootstrap ticket from Redis: ${err.message}`);
    }
  }

  async clear() {
    try {
      const keys = await this.redis.keys('preview:ticket:*');
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
    } catch {
      // Ignore during test cleanup
    }
  }

  async close() {
    if (this.ownsClient && this.redis) {
      await this.redis.quit().catch(() => {});
    }
  }
}

/**
 * Local Development In-Memory Ticket Store Adapter
 * Retained for single-process local development and unit tests.
 */
export class MemoryTicketStore extends ITicketStore {
  constructor() {
    super();
    this.map = new Map();
    this.sessionTickets = new Map();
  }

  async setTicket(ticket, metadata, ttlSeconds = 30) {
    if (!metadata || !validateSessionExpiresAtMs(metadata.sessionExpiresAtMs)) {
      throw new AppError(400, 'INVALID_METADATA', 'sessionExpiresAtMs must be a positive safe integer');
    }
    const ticketHash = hashTicket(ticket);
    return this.set(ticketHash, metadata, ttlSeconds);
  }

  async set(ticketHash, metadata, ttlSeconds = 30) {
    const key = `preview:ticket:${ticketHash}`;
    const existing = this.map.get(key);
    if (existing?.timer) {
      clearTimeout(existing.timer);
    }

    const expiresAt = Date.now() + ttlSeconds * 1000;
    const timer = setTimeout(() => {
      this.map.delete(key);
    }, ttlSeconds * 1000);

    if (typeof timer.unref === 'function') {
      timer.unref();
    }

    this.map.set(key, {
      metadata: { ...metadata },
      expiresAt,
      timer,
    });

    if (metadata?.sessionId) {
      if (!this.sessionTickets.has(metadata.sessionId)) {
        this.sessionTickets.set(metadata.sessionId, new Set());
      }
      this.sessionTickets.get(metadata.sessionId).add(ticketHash);
    }
  }

  async invalidateSessionTickets(sessionId) {
    if (!sessionId) return;
    const hashes = this.sessionTickets.get(sessionId);
    if (hashes) {
      for (const hash of hashes) {
        const key = `preview:ticket:${hash}`;
        const entry = this.map.get(key);
        if (entry?.timer) clearTimeout(entry.timer);
        this.map.delete(key);
      }
      this.sessionTickets.delete(sessionId);
    }
  }

  async consumeTicket(ticket, expectedHost = null) {
    const ticketHash = hashTicket(ticket);
    return this.consume(ticketHash, expectedHost);
  }

  async consume(ticketHash, expectedHost = null) {
    const key = `preview:ticket:${ticketHash}`;
    const entry = this.map.get(key);
    if (!entry) {
      return null;
    }

    if (Date.now() > entry.expiresAt) {
      if (entry.timer) clearTimeout(entry.timer);
      this.map.delete(key);
      return null;
    }

    const metadata = entry.metadata;
    if (!metadata || typeof metadata !== 'object') {
      return 'INVALID_METADATA';
    }

    if (!metadata.sessionId || typeof metadata.sessionId !== 'string' || metadata.sessionId === '') {
      return 'INVALID_METADATA';
    }

    if (!metadata.targetOrigin || typeof metadata.targetOrigin !== 'string' || metadata.targetOrigin === '') {
      return 'INVALID_METADATA';
    }

    if (!metadata.targetHostAuthority || typeof metadata.targetHostAuthority !== 'string' || metadata.targetHostAuthority === '') {
      return 'INVALID_METADATA';
    }

    if (!validateSessionExpiresAtMs(metadata.sessionExpiresAtMs)) {
      return 'INVALID_METADATA';
    }

    if (!metadata.mode || (metadata.mode !== 'iframe' && metadata.mode !== 'toplevel')) {
      return 'INVALID_METADATA';
    }

    if (!expectedHost || typeof expectedHost !== 'string' || expectedHost === '') {
      return 'HOST_MISMATCH';
    }

    if (metadata.targetHostAuthority.toLowerCase() !== expectedHost.toLowerCase()) {
      return 'HOST_MISMATCH';
    }

    if (entry.timer) clearTimeout(entry.timer);
    this.map.delete(key);
    return entry.metadata;
  }

  async clear() {
    for (const entry of this.map.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.map.clear();
    if (this.sessionTickets) {
      this.sessionTickets.clear();
    }
  }

  async close() {
    await this.clear();
  }
}

let activeStore = null;

/**
 * Returns the active ticket store singleton.
 *
 * @returns {ITicketStore}
 */
export function getTicketStore() {
  if (!activeStore) {
    activeStore = createTicketStore();
  }
  return activeStore;
}

/**
 * Overrides the active ticket store (e.g. for testing).
 *
 * @param {ITicketStore|null} store
 */
export function setTicketStore(store) {
  activeStore = store;
}

/**
 * Factory creating an ITicketStore instance based on environment configuration.
 *
 * @param {Object} [options]
 * @param {string} [options.redisUrl]
 * @returns {ITicketStore}
 */
export function createTicketStore(options = {}) {
  const redisUrl = options.redisUrl ?? env?.REDIS_URL;

  if (redisUrl) {
    return new RedisTicketStore(redisUrl);
  }

  if (env?.NODE_ENV === 'production') {
    throw new Error('REDIS_URL is mandatory for ticket store in production environment');
  }

  if (env?.NODE_ENV !== 'test') {
    console.warn(
      '[TicketStore] Using MemoryTicketStore. Note: MemoryTicketStore is single-process only and must not be used in multi-process production.'
    );
  }

  return new MemoryTicketStore();
}

/**
 * Invalidates all bootstrap tickets associated with a preview session.
 *
 * @param {string} sessionId
 */
export async function invalidateSessionTickets(sessionId) {
  if (!sessionId) return;
  try {
    const store = getTicketStore();
    if (typeof store.invalidateSessionTickets === 'function') {
      await store.invalidateSessionTickets(sessionId);
    }
  } catch {
    // Non-fatal cleanup
  }
}

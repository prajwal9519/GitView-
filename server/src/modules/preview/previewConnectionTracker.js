/**
 * GitView Milestone 7 — Task 5.2: Redis WebSocket Lease Recovery & Distributed Accounting
 *
 * Implements reliable per-lease expiration, stale-lease pruning, and cross-instance termination:
 * - Redis Sorted Set (ZSET) tracks individual connection leases with millisecond heartbeat timestamps.
 * - Atomic Lua scripts prune expired leases before enforcing the global 10-connection limit.
 * - Active connections maintain heartbeat renewal; unrenewed/abandoned leases expire automatically.
 * - Fail-closed safeguard: Redis unavailability or failed renewals terminate connections before
 *   exceeding lease TTL, preventing unmetered connections.
 * - Lost Pub/Sub safeguard: Session termination sets a Redis tombstone and purges the sorted set;
 *   any surviving socket discovers the termination on its next heartbeat and cleanly terminates.
 * - MemoryConnectionTracker: High-speed in-process fallback for single-instance / test environments.
 */

import crypto from 'node:crypto';
import Redis from 'ioredis';
import { env } from '../../config/env.js';

export const WS_TERMINATE_CHANNEL = 'gitview:preview:terminate-ws';
export const DEFAULT_LEASE_TTL_MS = 30000; // 30-second lease lifetime
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 5000; // 5-second heartbeat renewal
export const DEFAULT_TOMBSTONE_TTL_SECONDS = 300; // 5-minute session termination tombstone
export const MAX_GLOBAL_CONNECTIONS_PER_SESSION = 10;

/**
 * Base connection tracker interface.
 */
export class IConnectionTracker {
  async acquireLease(sessionId, socketId, maxConnections = MAX_GLOBAL_CONNECTIONS_PER_SESSION) {
    throw new Error('Not implemented');
  }

  async releaseLease(sessionId, socketId) {
    throw new Error('Not implemented');
  }

  async renewLease(sessionId, socketId) {
    throw new Error('Not implemented');
  }

  async getConnectionCount(sessionId) {
    throw new Error('Not implemented');
  }

  async terminateSession(sessionId, code = 1001, reason = 'Session Terminated') {
    throw new Error('Not implemented');
  }

  registerLocalSocket(sessionId, socketId, entry) {
    throw new Error('Not implemented');
  }

  unregisterLocalSocket(sessionId, socketId) {
    throw new Error('Not implemented');
  }

  getLocalSocketCount(sessionId) {
    throw new Error('Not implemented');
  }

  clear() {
    throw new Error('Not implemented');
  }

  async close() {
    // Optional teardown
  }
}

/**
 * Single-instance in-memory connection tracker.
 */
export class MemoryConnectionTracker extends IConnectionTracker {
  constructor(options = {}) {
    super();
    /** @type {Map<string, Map<string, Object>>} sessionId -> Map<socketId, entry> */
    this.sessionMap = new Map();
    this.leaseTtlMs = options.leaseTtlMs || (options.leaseTtlSeconds ? options.leaseTtlSeconds * 1000 : DEFAULT_LEASE_TTL_MS);
  }

  _pruneStale(sessionId) {
    const socketMap = this.sessionMap.get(sessionId);
    if (!socketMap) return;
    const nowMono = performance.now();
    const threshold = nowMono - this.leaseTtlMs;
    for (const [socketId, entry] of socketMap.entries()) {
      if (entry.lastRenewedMono && entry.lastRenewedMono <= threshold) {
        socketMap.delete(socketId);
      }
    }
    if (socketMap.size === 0) {
      this.sessionMap.delete(sessionId);
    }
  }

  async acquireLease(sessionId, socketId, maxConnections = MAX_GLOBAL_CONNECTIONS_PER_SESSION) {
    if (!sessionId || !socketId) return false;

    this._pruneStale(sessionId);
    const nowMono = performance.now();

    let socketMap = this.sessionMap.get(sessionId);
    if (!socketMap) {
      socketMap = new Map();
      this.sessionMap.set(sessionId, socketMap);
    }

    if (socketMap.has(socketId)) {
      const existing = socketMap.get(socketId);
      existing.lastRenewedMono = nowMono;
      return true;
    }

    if (socketMap.size >= maxConnections) {
      return false;
    }

    socketMap.set(socketId, { socketId, lastRenewedMono: nowMono });
    return true;
  }

  async releaseLease(sessionId, socketId) {
    if (!sessionId || !socketId) return;
    const socketMap = this.sessionMap.get(sessionId);
    if (socketMap) {
      socketMap.delete(socketId);
      if (socketMap.size === 0) {
        this.sessionMap.delete(sessionId);
      }
    }
  }

  async renewLease(sessionId, socketId) {
    if (!sessionId || !socketId) return 0;

    this._pruneStale(sessionId);
    const socketMap = this.sessionMap.get(sessionId);
    if (!socketMap || !socketMap.has(socketId)) {
      return 0;
    }

    const entry = socketMap.get(socketId);
    entry.lastRenewedMono = performance.now();
    return 1;
  }

  async getConnectionCount(sessionId) {
    if (!sessionId) return 0;
    this._pruneStale(sessionId);
    const socketMap = this.sessionMap.get(sessionId);
    return socketMap ? socketMap.size : 0;
  }

  getLocalSocketCount(sessionId) {
    if (!sessionId) return 0;
    const socketMap = this.sessionMap.get(sessionId);
    return socketMap ? socketMap.size : 0;
  }

  registerLocalSocket(sessionId, socketId, entry) {
    if (!sessionId || !socketId) return;
    let socketMap = this.sessionMap.get(sessionId);
    if (!socketMap) {
      socketMap = new Map();
      this.sessionMap.set(sessionId, socketMap);
    }
    const existing = socketMap.get(socketId) || {};
    socketMap.set(socketId, { ...existing, ...entry, lastRenewedMono: performance.now() });
  }

  unregisterLocalSocket(sessionId, socketId) {
    this.releaseLease(sessionId, socketId);
  }

  async terminateSession(sessionId, code = 1001, reason = 'Session Terminated') {
    if (!sessionId) return;
    const socketMap = this.sessionMap.get(sessionId);
    if (!socketMap || socketMap.size === 0) return;

    const entries = Array.from(socketMap.values());
    this.sessionMap.delete(sessionId);

    for (const entry of entries) {
      try {
        if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
        if (entry.handshakeTimer) clearTimeout(entry.handshakeTimer);
        if (entry.idleTimer) clearTimeout(entry.idleTimer);
        if (entry.heartbeatTimer) clearInterval(entry.heartbeatTimer);

        if (entry.clientSocket && !entry.clientSocket.destroyed) {
          if (entry.sendCloseFrameFn) {
            entry.sendCloseFrameFn(entry.clientSocket, code, reason);
          }
          entry.clientSocket.destroy();
        }
        if (entry.upstreamSocket && !entry.upstreamSocket.destroyed) {
          entry.upstreamSocket.destroy();
        }
      } catch {}
    }
  }

  clear() {
    for (const sessionId of Array.from(this.sessionMap.keys())) {
      this.terminateSession(sessionId);
    }
    this.sessionMap.clear();
  }

  async close() {
    this.clear();
  }
}

/**
 * Distributed Redis-backed connection tracker supporting multi-instance deployments.
 * Uses a Redis Sorted Set (ZSET) with atomic Lua scripts for connection lease tracking,
 * heartbeats for per-lease renewal, fail-closed timeouts for Redis outages, and Pub/Sub
 * + session tombstones for reliable cross-instance termination.
 */
export class RedisConnectionTracker extends IConnectionTracker {
  /**
   * @param {Object} params
   * @param {string|Object} params.redis Redis URL or existing Redis client
   * @param {string|Object} [params.subscriberRedis] Optional dedicated Redis client for Pub/Sub
   * @param {number} [params.leaseTtlMs=30000] Lease TTL in milliseconds (default: 30s)
   * @param {number} [params.leaseTtlSeconds] Backwards-compatible TTL in seconds
   * @param {number} [params.heartbeatIntervalMs] Heartbeat interval (default: leaseTtlMs / 3)
   * @param {number} [params.tombstoneTtlSeconds=300] Session termination tombstone TTL in seconds
   */
  constructor({
    redis,
    subscriberRedis = null,
    leaseTtlMs = null,
    leaseTtlSeconds = null,
    heartbeatIntervalMs = null,
    tombstoneTtlSeconds = DEFAULT_TOMBSTONE_TTL_SECONDS,
  }) {
    super();
    this.instanceId = crypto.randomUUID();

    if (leaseTtlMs) {
      this.leaseTtlMs = leaseTtlMs;
    } else if (leaseTtlSeconds) {
      this.leaseTtlMs = leaseTtlSeconds * 1000;
    } else {
      this.leaseTtlMs = DEFAULT_LEASE_TTL_MS;
    }

    this.heartbeatIntervalMs = heartbeatIntervalMs || Math.max(Math.floor(this.leaseTtlMs / 3), 50);
    this.tombstoneTtlSeconds = tombstoneTtlSeconds;

    /** @type {Map<string, Map<string, Object>>} Local sockets for this gateway instance: sessionId -> socketId -> entry */
    this.localSockets = new Map();

    // Primary command client
    if (typeof redis === 'string') {
      this.redis = new Redis(redis, {
        maxRetriesPerRequest: 2,
        enableReadyCheck: true,
        lazyConnect: false,
      });
      this.ownsClient = true;
    } else if (redis) {
      this.redis = redis;
      this.ownsClient = false;
    } else {
      throw new Error('RedisConnectionTracker requires a Redis client instance or connection URL');
    }
    if (typeof this.redis?.on === 'function') {
      this.redis.on('error', () => {});
    }

    // Pub/Sub subscriber client
    if (subscriberRedis) {
      this.sub = typeof subscriberRedis === 'string' ? new Redis(subscriberRedis) : subscriberRedis;
      this.ownsSub = typeof subscriberRedis === 'string';
    } else if (typeof redis === 'string') {
      this.sub = new Redis(redis);
      this.ownsSub = true;
    } else if (this.redis?.duplicate) {
      this.sub = this.redis.duplicate();
      this.ownsSub = true;
    } else {
      this.sub = null;
      this.ownsSub = false;
    }

    if (this.sub && typeof this.sub.on === 'function') {
      this.sub.on('error', () => {});
      this._initSubscriber();
    }

    if (typeof this.redis?.defineCommand === 'function') {
      this._registerLuaCommands();
    }
  }

  _registerLuaCommands() {
    // 1. acquireWsConnectionLease:
    // Atomic sorted set lease acquisition with authoritative Redis server time and PEXPIRE
    this.redis.defineCommand('acquireWsConnectionLease', {
      numberOfKeys: 1,
      lua: `
        local key = KEYS[1]
        local socketId = ARGV[1]
        local leaseTtlMs = tonumber(ARGV[2])
        local maxLimit = tonumber(ARGV[3])

        -- Authoritative Redis server timestamp in milliseconds
        local rtime = redis.call('TIME')
        local now = tonumber(rtime[1]) * 1000 + math.floor(tonumber(rtime[2]) / 1000)

        -- Step 1: Prune stale leases whose heartbeat is older than (now - leaseTtlMs)
        local staleThreshold = now - leaseTtlMs
        redis.call('ZREMRANGEBYSCORE', key, '-inf', staleThreshold)

        -- Step 2: Check if socketId already has an active lease (re-acquisition/renewal)
        local existingScore = redis.call('ZSCORE', key, socketId)
        if existingScore then
          redis.call('ZADD', key, now, socketId)
          local pexpireMs = math.ceil(leaseTtlMs * 2)
          redis.call('PEXPIRE', key, pexpireMs)
          return 1
        end

        -- Step 3: Check current active count against global limit
        local currentCount = redis.call('ZCARD', key)
        if currentCount >= maxLimit then
          return 0
        end

        -- Step 4: Register new lease with server timestamp score
        redis.call('ZADD', key, now, socketId)
        local pexpireMs = math.ceil(leaseTtlMs * 2)
        redis.call('PEXPIRE', key, pexpireMs)
        return 1
      `,
    });

    // 2. renewWsConnectionLease:
    // Atomic heartbeat renewal using Redis server time and refreshed PEXPIRE; returns 0 if pruned/missing/key deleted, 1 on success
    this.redis.defineCommand('renewWsConnectionLease', {
      numberOfKeys: 1,
      lua: `
        local key = KEYS[1]
        local socketId = ARGV[1]
        local leaseTtlMs = tonumber(ARGV[2])

        -- Authoritative Redis server timestamp in milliseconds
        local rtime = redis.call('TIME')
        local now = tonumber(rtime[1]) * 1000 + math.floor(tonumber(rtime[2]) / 1000)

        -- Step 1: Prune stale leases
        local staleThreshold = now - leaseTtlMs
        redis.call('ZREMRANGEBYSCORE', key, '-inf', staleThreshold)

        -- Step 2: Check if this lease is still present in the sorted set
        local existingScore = redis.call('ZSCORE', key, socketId)
        if not existingScore then
          return 0
        end

        -- Step 3: Refresh heartbeat score to current server timestamp
        redis.call('ZADD', key, now, socketId)
        local pexpireMs = math.ceil(leaseTtlMs * 2)
        redis.call('PEXPIRE', key, pexpireMs)
        return 1
      `,
    });

    // 3. releaseWsConnectionLease:
    // Atomic release of a specific lease from the sorted set
    this.redis.defineCommand('releaseWsConnectionLease', {
      numberOfKeys: 1,
      lua: `
        local key = KEYS[1]
        local socketId = ARGV[1]

        redis.call('ZREM', key, socketId)
        local remaining = redis.call('ZCARD', key)
        if remaining == 0 then
          redis.call('DEL', key)
        end
        return remaining
      `,
    });

    // 4. pruneAndCountWsConnectionLeases:
    // Atomic stale pruning and counting using Redis server time and PEXPIRE
    this.redis.defineCommand('pruneAndCountWsConnectionLeases', {
      numberOfKeys: 1,
      lua: `
        local key = KEYS[1]
        local leaseTtlMs = tonumber(ARGV[1])

        -- Authoritative Redis server timestamp in milliseconds
        local rtime = redis.call('TIME')
        local now = tonumber(rtime[1]) * 1000 + math.floor(tonumber(rtime[2]) / 1000)

        local staleThreshold = now - leaseTtlMs
        redis.call('ZREMRANGEBYSCORE', key, '-inf', staleThreshold)
        local count = redis.call('ZCARD', key)
        if count == 0 then
          redis.call('DEL', key)
        else
          local pexpireMs = math.ceil(leaseTtlMs * 2)
          redis.call('PEXPIRE', key, pexpireMs)
        end
        return count
      `,
    });
  }

  _initSubscriber() {
    this.sub.subscribe(WS_TERMINATE_CHANNEL, (err) => {
      if (err) {
        // Handled silently
      }
    });

    this.sub.on('message', (channel, message) => {
      if (channel !== WS_TERMINATE_CHANNEL) return;
      try {
        const payload = JSON.parse(message);
        if (payload.sessionId) {
          // Terminate local sockets on this instance
          this._terminateLocalSessionSockets(
            payload.sessionId,
            payload.code || 1001,
            payload.reason || 'Session Terminated'
          );
        }
      } catch {}
    });
  }

  _leaseKey(sessionId) {
    return `preview:ws:leases:${sessionId}`;
  }

  async acquireLease(sessionId, socketId, maxConnections = MAX_GLOBAL_CONNECTIONS_PER_SESSION) {
    if (!sessionId || !socketId) return false;
    const key = this._leaseKey(sessionId);
    try {
      const result = await this.redis.acquireWsConnectionLease(
        key,
        socketId,
        this.leaseTtlMs.toString(),
        maxConnections.toString()
      );
      return Number(result) === 1;
    } catch (err) {
      // Fail-closed on Redis outage: never permit unmetered connections
      return false;
    }
  }

  async renewLease(sessionId, socketId) {
    if (!sessionId || !socketId) return 0;
    const key = this._leaseKey(sessionId);
    try {
      const result = await this.redis.renewWsConnectionLease(
        key,
        socketId,
        this.leaseTtlMs.toString()
      );
      return Number(result);
    } catch (err) {
      throw err;
    }
  }

  async releaseLease(sessionId, socketId) {
    if (!sessionId || !socketId) return;
    this.unregisterLocalSocket(sessionId, socketId);
    const key = this._leaseKey(sessionId);
    try {
      await this.redis.releaseWsConnectionLease(key, socketId);
    } catch {}
  }

  async getConnectionCount(sessionId) {
    if (!sessionId) return 0;
    const key = this._leaseKey(sessionId);
    try {
      const count = await this.redis.pruneAndCountWsConnectionLeases(
        key,
        this.leaseTtlMs.toString()
      );
      return Number(count);
    } catch {
      return this.getLocalSocketCount(sessionId);
    }
  }

  getLocalSocketCount(sessionId) {
    if (!sessionId) return 0;
    const socketMap = this.localSockets.get(sessionId);
    return socketMap ? socketMap.size : 0;
  }

  registerLocalSocket(sessionId, socketId, entry) {
    if (!sessionId || !socketId) return;
    let socketMap = this.localSockets.get(sessionId);
    if (!socketMap) {
      socketMap = new Map();
      this.localSockets.set(sessionId, socketMap);
    }

    const nowMono = performance.now();
    const socketEntry = {
      ...entry,
      createdMono: nowMono,
      lastRenewedMono: nowMono,
      consecutiveFailedRenewals: 0,
      heartbeatTimer: null,
    };

    // Start heartbeat timer for active lease renewal and stale/tombstone detection
    const heartbeatTimer = setInterval(async () => {
      await this._performHeartbeat(sessionId, socketId, socketEntry);
    }, this.heartbeatIntervalMs);
    if (heartbeatTimer.unref) heartbeatTimer.unref();

    socketEntry.heartbeatTimer = heartbeatTimer;
    socketMap.set(socketId, socketEntry);
  }

  async _performHeartbeat(sessionId, socketId, entry) {
    // If sockets are already destroyed, unregister and clear
    if (!entry || (entry.clientSocket?.destroyed && entry.upstreamSocket?.destroyed)) {
      this.unregisterLocalSocket(sessionId, socketId);
      return;
    }

    const nowMono = performance.now();
    try {
      const renewResult = await this.renewLease(sessionId, socketId);
      if (renewResult <= 0) {
        // renewResult === 0: lease pruned/expired from set or key deleted
        this._terminateLocalSocket(
          sessionId,
          socketId,
          1001,
          'Lease Expired'
        );
        return;
      }
      entry.lastRenewedMono = nowMono;
      entry.consecutiveFailedRenewals = 0;
    } catch (err) {
      entry.consecutiveFailedRenewals = (entry.consecutiveFailedRenewals || 0) + 1;
      const lastSuccessMono = entry.lastRenewedMono ?? entry.createdMono ?? nowMono;
      // Fail-closed safeguard: if elapsed monotonic time exceeds lease TTL, terminate connection
      if (nowMono - lastSuccessMono >= this.leaseTtlMs) {
        this._terminateLocalSocket(
          sessionId,
          socketId,
          1001,
          'Redis Lease Expired (Renewal Failed)'
        );
      }
    }
  }

  unregisterLocalSocket(sessionId, socketId) {
    if (!sessionId || !socketId) return;
    const socketMap = this.localSockets.get(sessionId);
    if (socketMap) {
      const entry = socketMap.get(socketId);
      if (entry?.heartbeatTimer) {
        clearInterval(entry.heartbeatTimer);
        entry.heartbeatTimer = null;
      }
      socketMap.delete(socketId);
      if (socketMap.size === 0) {
        this.localSockets.delete(sessionId);
      }
    }
  }

  _terminateLocalSocket(sessionId, socketId, code = 1001, reason = 'Session Terminated') {
    const socketMap = this.localSockets.get(sessionId);
    if (!socketMap) return;
    const entry = socketMap.get(socketId);
    if (!entry) return;

    if (entry.heartbeatTimer) {
      clearInterval(entry.heartbeatTimer);
      entry.heartbeatTimer = null;
    }
    if (entry.expiryTimer) {
      clearTimeout(entry.expiryTimer);
      entry.expiryTimer = null;
    }
    if (entry.handshakeTimer) {
      clearTimeout(entry.handshakeTimer);
      entry.handshakeTimer = null;
    }
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }

    socketMap.delete(socketId);
    if (socketMap.size === 0) {
      this.localSockets.delete(sessionId);
    }

    try {
      if (entry.clientSocket && !entry.clientSocket.destroyed) {
        if (entry.sendCloseFrameFn) {
          entry.sendCloseFrameFn(entry.clientSocket, code, reason);
        }
        entry.clientSocket.destroy();
      }
    } catch {}

    try {
      if (entry.upstreamSocket && !entry.upstreamSocket.destroyed) {
        entry.upstreamSocket.destroy();
      }
    } catch {}
  }

  _terminateLocalSessionSockets(sessionId, code = 1001, reason = 'Session Terminated') {
    const socketMap = this.localSockets.get(sessionId);
    if (!socketMap || socketMap.size === 0) return;

    const socketIds = Array.from(socketMap.keys());
    for (const socketId of socketIds) {
      this._terminateLocalSocket(sessionId, socketId, code, reason);
    }
  }

  async terminateSession(sessionId, code = 1001, reason = 'Session Terminated') {
    if (!sessionId) return;

    // 1. Terminate all local sockets on this instance immediately
    this._terminateLocalSessionSockets(sessionId, code, reason);

    // 2. Delete Redis sorted set lease key
    const key = this._leaseKey(sessionId);
    try {
      await this.redis.del(key);
    } catch {}

    // 3. Broadcast termination event to all other gateway instances via Pub/Sub
    try {
      const payload = JSON.stringify({
        sessionId,
        code,
        reason,
        senderInstanceId: this.instanceId,
        timestamp: Date.now(),
      });
      await this.redis.publish(WS_TERMINATE_CHANNEL, payload);
    } catch {}
  }

  clear() {
    for (const sessionId of Array.from(this.localSockets.keys())) {
      this._terminateLocalSessionSockets(sessionId);
    }
    this.localSockets.clear();
  }

  async close() {
    this.clear();
    if (this.sub && this.ownsSub) {
      try {
        await this.sub.quit();
      } catch {}
    }
    if (this.redis && this.ownsClient) {
      try {
        await this.redis.quit();
      } catch {}
    }
  }
}

let activeTrackerInstance = null;

/**
 * Returns or initializes the active connection tracker.
 *
 * @param {Object} [options]
 * @param {string} [options.redisUrl]
 * @param {Object} [options.redisClient]
 * @param {number} [options.leaseTtlMs]
 * @param {number} [options.heartbeatIntervalMs]
 * @returns {IConnectionTracker}
 */
export function getConnectionTracker(options = {}) {
  if (activeTrackerInstance) {
    return activeTrackerInstance;
  }

  const redisUrl = options.redisUrl ?? env?.REDIS_URL;
  const redisClient = options.redisClient;

  if (redisClient || redisUrl) {
    activeTrackerInstance = new RedisConnectionTracker({
      redis: redisClient || redisUrl,
      leaseTtlMs: options.leaseTtlMs,
      heartbeatIntervalMs: options.heartbeatIntervalMs,
    });
  } else {
    activeTrackerInstance = new MemoryConnectionTracker(options);
  }

  return activeTrackerInstance;
}

/**
 * Sets the active global connection tracker (for dependency injection or testing).
 *
 * @param {IConnectionTracker} tracker
 */
export function setConnectionTracker(tracker) {
  activeTrackerInstance = tracker;
}

/**
 * Resets the active connection tracker to default.
 */
export function resetConnectionTracker() {
  if (activeTrackerInstance && typeof activeTrackerInstance.clear === 'function') {
    activeTrackerInstance.clear();
  }
  activeTrackerInstance = null;
}

/**
 * GitView Phase 5 — Milestone 7, Task 6: Preview API Service Layer
 *
 * Implements client-side service for live preview lifecycle management:
 * - createPreview: Initiates preview session for repository + commit
 * - getPreviewStatus: Queries lifecycle state (PENDING, FETCHING, BUILDING, STARTING, RUNNING, etc.)
 * - stopPreview: Explicitly terminates preview session and releases resources
 * - createPreviewTicket: Generates single-use bootstrap ticket (mode: 'iframe' | 'toplevel')
 * - pollPreviewStatus: Bounded-backoff polling utility with auto-cancellation
 *
 * Strict Security Guarantees:
 * - Raw tokens and tickets are NEVER written to localStorage or sessionStorage.
 * - Secret tokens and tickets are NEVER logged to browser console.
 * - Dedicated mode isolation: 'iframe' tickets for embedded iframe, 'toplevel' for new tabs.
 */

import api, { formatApiError } from './api';

export const PreviewFramework = {
  STATIC: 'STATIC',
  VITE_VANILLA: 'VITE_VANILLA',
  VITE_REACT: 'VITE_REACT',
  UNKNOWN: 'UNKNOWN',
};

export const PreviewStatus = {
  IDLE: 'IDLE',
  PENDING: 'PENDING',
  FETCHING: 'FETCHING',
  BUILDING: 'BUILDING',
  STARTING: 'STARTING',
  RUNNING: 'RUNNING',
  STOPPING: 'STOPPING',
  STOPPED: 'STOPPED',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED',
};

export const TERMINAL_STATUSES = new Set([
  PreviewStatus.RUNNING,
  PreviewStatus.STOPPED,
  PreviewStatus.FAILED,
  PreviewStatus.EXPIRED,
]);

export const previewService = {
  /**
   * Retrieves active preview session for authenticated user, if one exists.
   *
   * @returns {Promise<{ session: Object, repository: Object }|null>}
   */
  async getActivePreview() {
    try {
      const res = await api.get('/previews/active');
      return res.data?.data || null;
    } catch (err) {
      throw formatApiError(err);
    }
  },
  /**
   * Starts a new preview session for a repository.
   *
   * @param {string} repositoryId
   * @param {string} [commitRef] Commit SHA or branch name (e.g. 'main')
   * @returns {Promise<Object>} Sanitized preview session
   */
  async createPreview(repositoryId, commitRef) {
    if (!repositoryId) {
      throw new Error('repositoryId is required to start a preview');
    }
    try {
      const payload = { repositoryId };
      if (commitRef) {
        payload.commitRef = commitRef;
      }
      const res = await api.post('/previews', payload);
      return res.data?.data;
    } catch (err) {
      throw formatApiError(err);
    }
  },

  /**
   * Retrieves the current lifecycle status of a preview session.
   *
   * @param {string} previewId
   * @returns {Promise<Object>} Sanitized preview session
   */
  async getPreviewStatus(previewId) {
    if (!previewId) {
      throw new Error('previewId is required to get preview status');
    }
    try {
      const res = await api.get(`/previews/${encodeURIComponent(previewId)}`);
      return res.data?.data;
    } catch (err) {
      throw formatApiError(err);
    }
  },

  /**
   * Explicitly stops an active preview session.
   *
   * @param {string} previewId
   * @returns {Promise<Object>} Sanitized stopped session
   */
  async stopPreview(previewId) {
    if (!previewId) {
      throw new Error('previewId is required to stop preview');
    }
    try {
      const res = await api.post(`/previews/${encodeURIComponent(previewId)}/stop`, {});
      return res.data?.data;
    } catch (err) {
      throw formatApiError(err);
    }
  },

  /**
   * Generates a single-use bootstrap ticket for iframe or top-level navigation.
   *
   * @param {string} previewId
   * @param {'iframe'|'toplevel'} [mode='iframe']
   * @returns {Promise<{ previewUrl: string, targetOrigin: string, ticketExpiresAt: string }>}
   */
  async createPreviewTicket(previewId, mode = 'iframe') {
    if (!previewId) {
      throw new Error('previewId is required to create bootstrap ticket');
    }
    if (mode !== 'iframe' && mode !== 'toplevel') {
      throw new Error("mode must be either 'iframe' or 'toplevel'");
    }
    try {
      const res = await api.post(
        `/previews/${encodeURIComponent(previewId)}/ticket`,
        { mode },
        { headers: { 'Cache-Control': 'no-store' } }
      );
      return res.data?.data;
    } catch (err) {
      throw formatApiError(err);
    }
  },

  /**
   * Polls preview session status with bounded backoff until terminal status reached or cancelled.
   *
   * @param {string} previewId
   * @param {Function} onUpdate Callback invoked with updated session object
   * @param {Object} [options]
   * @param {AbortSignal} [options.signal] AbortSignal to cancel polling
   * @param {number} [options.initialIntervalMs=1000]
   * @param {number} [options.maxIntervalMs=3000]
   * @param {number} [options.backoffMultiplier=1.25]
   * @param {number} [options.maxAttempts=90] (approx 3 minutes max)
   * @returns {Promise<Object>} Final session object
   */
  async pollPreviewStatus(previewId, onUpdate, options = {}) {
    const {
      signal,
      initialIntervalMs = 1000,
      maxIntervalMs = 3000,
      backoffMultiplier = 1.25,
      maxAttempts = 90,
    } = options;

    let delay = initialIntervalMs;
    let attempts = 0;

    while (attempts < maxAttempts) {
      if (signal?.aborted) {
        throw new Error('Polling aborted');
      }

      attempts++;
      const session = await this.getPreviewStatus(previewId);

      if (typeof onUpdate === 'function') {
        onUpdate(session);
      }

      if (TERMINAL_STATUSES.has(session.status)) {
        return session;
      }

      if (signal?.aborted) {
        throw new Error('Polling aborted');
      }

      // Wait bounded backoff delay
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (signal?.removeEventListener) {
            signal.removeEventListener('abort', onAbort);
          }
          resolve();
        }, delay);

        const onAbort = () => {
          clearTimeout(timer);
          reject(new Error('Polling aborted'));
        };

        if (signal?.addEventListener) {
          signal.addEventListener('abort', onAbort, { once: true });
        }
      });

      delay = Math.min(Math.round(delay * backoffMultiplier), maxIntervalMs);
    }

    throw new Error(`Preview polling timed out after ${maxAttempts} attempts`);
  },
};

export default previewService;

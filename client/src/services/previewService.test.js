import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import api from './api';
import {
  previewService,
  PreviewStatus,
  PreviewFramework,
  TERMINAL_STATUSES,
} from './previewService';

vi.mock('./api', () => ({
  default: {
    post: vi.fn(),
    get: vi.fn(),
  },
  formatApiError: vi.fn((err) => ({
    code: err.code || 'API_ERROR',
    message: err.message || 'Error occurred',
    status: err.response?.status,
    raw: err,
  })),
}));

describe('previewService Unit Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createPreview', () => {
    it('throws when repositoryId is missing', async () => {
      await expect(previewService.createPreview()).rejects.toThrow('repositoryId is required');
      expect(api.post).not.toHaveBeenCalled();
    });

    it('posts to /previews with repositoryId and optional commitRef', async () => {
      api.post.mockResolvedValueOnce({
        data: {
          data: {
            id: 'session-123',
            repositoryId: 'repo-abc',
            status: PreviewStatus.FETCHING,
            framework: PreviewFramework.STATIC,
          },
        },
      });

      const result = await previewService.createPreview('repo-abc', 'commit-sha-1');
      expect(api.post).toHaveBeenCalledWith('/previews', {
        repositoryId: 'repo-abc',
        commitRef: 'commit-sha-1',
      });
      expect(result.id).toBe('session-123');
      expect(result.status).toBe(PreviewStatus.FETCHING);
    });

    it('omits commitRef when not provided', async () => {
      api.post.mockResolvedValueOnce({
        data: {
          data: { id: 'session-456', repositoryId: 'repo-xyz', status: PreviewStatus.PENDING },
        },
      });

      const result = await previewService.createPreview('repo-xyz');
      expect(api.post).toHaveBeenCalledWith('/previews', {
        repositoryId: 'repo-xyz',
      });
      expect(result.id).toBe('session-456');
    });
  });

  describe('getPreviewStatus', () => {
    it('throws when previewId is missing', async () => {
      await expect(previewService.getPreviewStatus()).rejects.toThrow('previewId is required');
      expect(api.get).not.toHaveBeenCalled();
    });

    it('gets /previews/:id', async () => {
      api.get.mockResolvedValueOnce({
        data: {
          data: {
            id: 'session-123',
            status: PreviewStatus.RUNNING,
            framework: PreviewFramework.VITE_REACT,
          },
        },
      });

      const result = await previewService.getPreviewStatus('session-123');
      expect(api.get).toHaveBeenCalledWith('/previews/session-123');
      expect(result.status).toBe(PreviewStatus.RUNNING);
    });
  });

  describe('stopPreview', () => {
    it('throws when previewId is missing', async () => {
      await expect(previewService.stopPreview()).rejects.toThrow('previewId is required');
      expect(api.post).not.toHaveBeenCalled();
    });

    it('posts to /previews/:id/stop', async () => {
      api.post.mockResolvedValueOnce({
        data: {
          data: { id: 'session-123', status: PreviewStatus.STOPPED, isActive: false },
        },
      });

      const result = await previewService.stopPreview('session-123');
      expect(api.post).toHaveBeenCalledWith('/previews/session-123/stop', {});
      expect(result.status).toBe(PreviewStatus.STOPPED);
    });
  });

  describe('createPreviewTicket', () => {
    it('throws when previewId is missing', async () => {
      await expect(previewService.createPreviewTicket()).rejects.toThrow('previewId is required');
    });

    it('throws on invalid mode', async () => {
      await expect(
        previewService.createPreviewTicket('session-123', 'invalid_mode')
      ).rejects.toThrow("mode must be either 'iframe' or 'toplevel'");
    });

    it('posts with mode: iframe by default and sets Cache-Control: no-store', async () => {
      api.post.mockResolvedValueOnce({
        data: {
          data: {
            previewUrl: 'http://session-123.preview.localhost:3000/__gitview_bootstrap?ticket=hex123',
            targetOrigin: 'http://session-123.preview.localhost:3000',
            ticketExpiresAt: '2026-11-20T00:00:00.000Z',
          },
        },
      });

      const result = await previewService.createPreviewTicket('session-123');
      expect(api.post).toHaveBeenCalledWith(
        '/previews/session-123/ticket',
        { mode: 'iframe' },
        { headers: { 'Cache-Control': 'no-store' } }
      );
      expect(result.previewUrl).toContain('__gitview_bootstrap?ticket=hex123');
    });

    it('posts with mode: toplevel when requested', async () => {
      api.post.mockResolvedValueOnce({
        data: {
          data: {
            previewUrl: 'http://session-123.preview.localhost:3000/__gitview_bootstrap?ticket=hex456',
            targetOrigin: 'http://session-123.preview.localhost:3000',
            ticketExpiresAt: '2026-11-20T00:00:00.000Z',
          },
        },
      });

      const result = await previewService.createPreviewTicket('session-123', 'toplevel');
      expect(api.post).toHaveBeenCalledWith(
        '/previews/session-123/ticket',
        { mode: 'toplevel' },
        { headers: { 'Cache-Control': 'no-store' } }
      );
      expect(result.previewUrl).toContain('__gitview_bootstrap?ticket=hex456');
    });
  });

  describe('pollPreviewStatus', () => {
    it('polls with backoff and stops upon terminal status RUNNING', async () => {
      const updates = [];
      api.get
        .mockResolvedValueOnce({
          data: { data: { id: 's1', status: PreviewStatus.FETCHING } },
        })
        .mockResolvedValueOnce({
          data: { data: { id: 's1', status: PreviewStatus.BUILDING } },
        })
        .mockResolvedValueOnce({
          data: { data: { id: 's1', status: PreviewStatus.RUNNING } },
        });

      const final = await previewService.pollPreviewStatus(
        's1',
        (s) => updates.push(s.status),
        { initialIntervalMs: 10, maxIntervalMs: 50, backoffMultiplier: 2 }
      );

      expect(updates).toEqual([
        PreviewStatus.FETCHING,
        PreviewStatus.BUILDING,
        PreviewStatus.RUNNING,
      ]);
      expect(final.status).toBe(PreviewStatus.RUNNING);
      expect(api.get).toHaveBeenCalledTimes(3);
    });

    it('cancels polling when AbortSignal triggers', async () => {
      const controller = new AbortController();
      api.get.mockResolvedValueOnce({
        data: { data: { id: 's1', status: PreviewStatus.BUILDING } },
      });

      const pollPromise = previewService.pollPreviewStatus(
        's1',
        () => {
          // Trigger abort on first update
          controller.abort();
        },
        { signal: controller.signal, initialIntervalMs: 500 }
      );

      await expect(pollPromise).rejects.toThrow('Polling aborted');
    });

    it('stops immediately when session enters FAILED status', async () => {
      api.get.mockResolvedValueOnce({
        data: {
          data: {
            id: 's1',
            status: PreviewStatus.FAILED,
            errorCode: 'BUILD_FAILED',
            errorMessage: 'Syntax error in App.jsx',
          },
        },
      });

      const final = await previewService.pollPreviewStatus('s1', () => {});
      expect(final.status).toBe(PreviewStatus.FAILED);
      expect(api.get).toHaveBeenCalledTimes(1);
    });
  });

  describe('Security invariants', () => {
    it('never writes capability tokens or tickets to localStorage or sessionStorage', async () => {
      const setItemSpyLocal = vi.spyOn(Storage.prototype, 'setItem');

      api.post.mockResolvedValueOnce({
        data: {
          data: {
            previewUrl: 'http://test.preview.localhost:3000/__gitview_bootstrap?ticket=topsecret123',
            targetOrigin: 'http://test.preview.localhost:3000',
            ticketExpiresAt: '2026-11-20T00:00:00.000Z',
          },
        },
      });

      await previewService.createPreviewTicket('s1', 'iframe');

      expect(setItemSpyLocal).not.toHaveBeenCalled();
      setItemSpyLocal.mockRestore();
    });
  });
});

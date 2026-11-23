import { describe, it, expect, vi, beforeEach } from 'vitest';
import { repoService } from './repoService';
import api from './api';

describe('Frontend Explorer & Code Viewer Service Tests', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('getDirectoryTree', () => {
    it('calls GET /repositories/:id/tree with path and ref parameters', async () => {
      const mockTreeResponse = {
        data: {
          data: {
            path: 'src',
            ref: 'main',
            entries: [
              { name: 'components', path: 'src/components', type: 'dir', size: 0, sha: '1' },
              { name: 'App.jsx', path: 'src/App.jsx', type: 'file', size: 1200, sha: '2' },
            ],
          },
        },
      };

      const getSpy = vi.spyOn(api, 'get').mockResolvedValue(mockTreeResponse);

      const result = await repoService.getDirectoryTree('repo-uuid-123', 'src', 'main');

      expect(getSpy).toHaveBeenCalledWith('/repositories/repo-uuid-123/tree', {
        params: { path: 'src', ref: 'main' },
      });
      expect(result.path).toBe('src');
      expect(result.entries).toHaveLength(2);
      expect(result.entries[0].type).toBe('dir');
    });

    it('formats and propagates errors when directory tree request fails', async () => {
      vi.spyOn(api, 'get').mockRejectedValue({
        response: {
          status: 404,
          data: {
            error: {
              code: 'NOT_FOUND',
              message: 'Repository not found',
            },
          },
        },
      });

      await expect(repoService.getDirectoryTree('bad-repo-id')).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message: 'Repository not found',
      });
    });
  });

  describe('getFileContent', () => {
    it('calls GET /repositories/:id/file and retrieves decoded source file', async () => {
      const mockFileResponse = {
        data: {
          data: {
            path: 'src/App.jsx',
            name: 'App.jsx',
            size: 1200,
            sha: 'sha123',
            language: 'javascript',
            content: 'export default function App() {}',
            isBinary: false,
            tooLarge: false,
            htmlUrl: 'https://github.com/facebook/react/blob/main/src/App.jsx',
          },
        },
      };

      const getSpy = vi.spyOn(api, 'get').mockResolvedValue(mockFileResponse);

      const result = await repoService.getFileContent('repo-uuid-123', 'src/App.jsx', 'main');

      expect(getSpy).toHaveBeenCalledWith('/repositories/repo-uuid-123/file', {
        params: { path: 'src/App.jsx', ref: 'main' },
      });
      expect(result.name).toBe('App.jsx');
      expect(result.content).toBe('export default function App() {}');
      expect(result.isBinary).toBe(false);
      expect(result.tooLarge).toBe(false);
    });

    it('handles binary files correctly with isBinary: true and null content', async () => {
      const mockBinaryResponse = {
        data: {
          data: {
            path: 'assets/logo.png',
            name: 'logo.png',
            size: 24000,
            sha: 'sha_logo',
            isBinary: true,
            tooLarge: false,
            htmlUrl: 'https://github.com/facebook/react/blob/main/assets/logo.png',
            content: null,
          },
        },
      };

      vi.spyOn(api, 'get').mockResolvedValue(mockBinaryResponse);

      const result = await repoService.getFileContent('repo-uuid-123', 'assets/logo.png');

      expect(result.isBinary).toBe(true);
      expect(result.content).toBeNull();
      expect(result.htmlUrl).toBeDefined();
    });

    it('handles large files (> 512 KB) correctly with tooLarge: true and external URL', async () => {
      const mockLargeResponse = {
        data: {
          data: {
            path: 'data/dataset.json',
            name: 'dataset.json',
            size: 600000,
            sha: 'sha_large',
            tooLarge: true,
            isBinary: false,
            htmlUrl: 'https://github.com/facebook/react/blob/main/data/dataset.json',
            content: null,
          },
        },
      };

      vi.spyOn(api, 'get').mockResolvedValue(mockLargeResponse);

      const result = await repoService.getFileContent('repo-uuid-123', 'data/dataset.json');

      expect(result.tooLarge).toBe(true);
      expect(result.content).toBeNull();
      expect(result.size).toBe(600000);
      expect(result.htmlUrl).toBe('https://github.com/facebook/react/blob/main/data/dataset.json');
    });

    it('propagates NOT_A_FILE error when path is a directory', async () => {
      vi.spyOn(api, 'get').mockRejectedValue({
        response: {
          status: 400,
          data: {
            error: {
              code: 'NOT_A_FILE',
              message: 'The requested path is a directory, not a file',
            },
          },
        },
      });

      await expect(repoService.getFileContent('repo-uuid-123', 'src')).rejects.toMatchObject({
        code: 'NOT_A_FILE',
      });
    });
  });

  describe('getRepositoryById & getHistorySessions', () => {
    it('returns repository by ID from API', async () => {
      vi.spyOn(api, 'get').mockResolvedValue({
        data: {
          data: {
            repository: { id: 'repo-1', name: 'Sample-App' },
          },
        },
      });

      const repo = await repoService.getRepositoryById('repo-1');
      expect(repo).toEqual({ id: 'repo-1', name: 'Sample-App' });
    });

    it('returns null when repository is not found and not a mock ID', async () => {
      vi.spyOn(api, 'get').mockRejectedValue(new Error('404 Not Found'));

      const repo = await repoService.getRepositoryById('non-existent-uuid');
      expect(repo).toBeNull();
    });

    it('fetches history sessions from /repositories/history', async () => {
      const mockHistory = [
        { id: 'sess-1', repoFullName: 'dzsodzso63/Sample-React-App-with-Vite', status: 'running' },
      ];
      vi.spyOn(api, 'get').mockResolvedValue({
        data: {
          data: mockHistory,
        },
      });

      const sessions = await repoService.getHistorySessions();
      expect(sessions).toEqual(mockHistory);
    });

    it('calls GET /repositories/:id/detect and returns detection profile including projectRoot', async () => {
      const mockDetection = {
        supported: true,
        framework: 'VITE_FRONTEND',
        variant: 'REACT',
        projectRoot: 'vite-project',
      };
      vi.spyOn(api, 'get').mockResolvedValue({
        data: {
          data: mockDetection,
        },
      });

      const res = await repoService.detectRepository('repo-skynav', 'main');
      expect(res).toEqual(mockDetection);
      expect(res.projectRoot).toBe('vite-project');
    });
  });
});

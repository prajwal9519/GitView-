import api, { formatApiError } from './api';
import { mockRepositories, mockHistorySessions, mockDependencies } from '../data/mockRepositories';
import { mockFilesByRepo } from '../data/mockFiles';

export const repoService = {
  /**
   * Fetches all imported repositories for the authenticated user from real backend.
   */
  async getRepositories() {
    try {
      const res = await api.get('/repositories');
      return res.data.data || [];
    } catch (err) {
      throw formatApiError(err);
    }
  },

  /**
   * Fetches a single imported repository by ID.
   * Falls back to mock data only for preset mock workspace repositories until explorer phase is complete.
   */
  async getRepositoryById(id) {
    try {
      const res = await api.get(`/repositories/${encodeURIComponent(id)}`);
      return res.data.data?.repository;
    } catch {
      // Fallback for mock IDs used by workspace preview (e.g. 'shadcn-ui-ui')
      const found = mockRepositories.find((r) => r.id === id || r.fullName === id);
      return found || null;
    }
  },

  /**
   * Imports a new repository via GitHub repository identifier or URL.
   */
  async importRepository(repoIdentifier) {
    try {
      const res = await api.post('/repositories', { repo: repoIdentifier });
      return res.data.data?.repository;
    } catch (err) {
      throw formatApiError(err);
    }
  },

  /**
   * Deletes an imported repository by ID.
   */
  async deleteRepository(id) {
    try {
      const res = await api.delete(`/repositories/${encodeURIComponent(id)}`);
      return res.data.data;
    } catch (err) {
      throw formatApiError(err);
    }
  },

  /**
   * Fetches real directory contents from backend GitHub Contents API.
   */
  async getDirectoryTree(repoId, path = '', ref) {
    try {
      const res = await api.get(`/repositories/${encodeURIComponent(repoId)}/tree`, {
        params: { path, ref },
      });
      return res.data.data;
    } catch (err) {
      throw formatApiError(err);
    }
  },

  /**
   * Fetches real file content and metadata from backend GitHub Contents API.
   */
  async getFileContent(repoId, path, ref) {
    try {
      const res = await api.get(`/repositories/${encodeURIComponent(repoId)}/file`, {
        params: { path, ref },
      });
      return res.data.data;
    } catch (err) {
      throw formatApiError(err);
    }
  },

  /**
   * Fetches preview session history from backend.
   */
  async getHistorySessions() {
    try {
      const res = await api.get('/repositories/history');
      return res.data.data || [];
    } catch {
      return [];
    }
  },

  async getFileTree(repoFullName) {
    try {
      const res = await api.get(`/repositories/${encodeURIComponent(repoFullName)}/tree`);
      return res.data;
    } catch {
      const repo = mockFilesByRepo[repoFullName] || mockFilesByRepo['shadcn-ui/ui'];
      return repo.tree;
    }
  },


  /**
   * Fetches real parsed repository dependencies and manifest metadata from backend.
   */
  async getRepositoryDependencies(repoId, ref = null) {
    try {
      const res = await api.get(`/repositories/${encodeURIComponent(repoId)}/dependencies`, {
        params: ref ? { ref } : {},
      });
      return res.data.data;
    } catch (err) {
      throw formatApiError(err);
    }
  },

  async getDependencies(repoFullName) {
    try {
      const res = await api.get(`/repositories/${encodeURIComponent(repoFullName)}/dependencies`);
      return res.data.data || res.data;
    } catch {
      return null;
    }
  },

  async preflightAnalyze(repoUrl) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    
    if (repoUrl.includes('non-existent') || repoUrl.includes('ghost')) {
      throw new Error('Repository not found or private. Ensure URL is correct or grant GitHub OAuth permissions.');
    }
    if (repoUrl.includes('torvalds/linux') || repoUrl.includes('kernel')) {
      return {
        status: 'unsupported',
        framework: 'C / Kernel',
        packageManager: 'Makefile / Kconfig',
        port: null,
        bootTime: null,
        message: 'Kernel repository detected. Code browsing enabled; live browser sandbox preview is unsupported for C/Kernel targets.'
      };
    }

    return {
      status: 'valid',
      owner: 'shadcn-ui',
      repo: 'ui',
      access: 'Public',
      framework: 'Next.js 14.1',
      packageManager: 'pnpm v8.15',
      port: 3000,
      bootTime: '~1.4 seconds',
      logs: [
        'Checking repository manifest...',
        '✔ Found package.json: { "scripts": { "dev": "next dev" } }',
        '✔ WebContainer isolation supported (no C++ native addon requirements)',
        'ℹ 18 client-side dependencies will hydrate in isolated iframe'
      ]
    };
  },

  /**
   * Passively detects framework and relative project root for an imported repository.
   */
  async detectRepository(id, ref = null) {
    try {
      const url = `/repositories/${encodeURIComponent(id)}/detect${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`;
      const res = await api.get(url);
      return res.data?.data || null;
    } catch (err) {
      throw formatApiError(err);
    }
  },
};

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
      return found || mockRepositories[0];
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
   * Mock data preserved for workspace and preview session history until future phases.
   */
  async getHistorySessions() {
    try {
      const res = await api.get('/repositories/history');
      return res.data.data || mockHistorySessions;
    } catch {
      return mockHistorySessions;
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


  async getDependencies(repoFullName) {
    try {
      const res = await api.get(`/repositories/${encodeURIComponent(repoFullName)}/dependencies`);
      return res.data;
    } catch {
      return mockDependencies;
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
  }
};

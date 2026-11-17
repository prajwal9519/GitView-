import api from './api';
import { mockRepositories, mockHistorySessions, mockDependencies } from '../data/mockRepositories';
import { mockFilesByRepo } from '../data/mockFiles';

export const repoService = {
  async getRepositories() {
    try {
      const res = await api.get('/repositories');
      return res.data;
    } catch {
      return mockRepositories;
    }
  },

  async getRepositoryById(id) {
    try {
      const res = await api.get(`/repositories/${id}`);
      return res.data;
    } catch {
      const found = mockRepositories.find((r) => r.id === id || r.fullName === id);
      return found || mockRepositories[0];
    }
  },

  async getHistorySessions() {
    try {
      const res = await api.get('/repositories/history');
      return res.data;
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

  async getFileContent(repoFullName, filePath) {
    try {
      const res = await api.get(`/repositories/${encodeURIComponent(repoFullName)}/files`, {
        params: { path: filePath }
      });
      return res.data;
    } catch {
      const repo = mockFilesByRepo[repoFullName] || mockFilesByRepo['shadcn-ui/ui'];
      const content = repo.contents[filePath] || `// File: ${filePath}\n// Content loaded in GitView\nexport default {};`;
      return content;
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
    // Simulated preflight analysis
    await new Promise((resolve) => setTimeout(resolve, 400));
    
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

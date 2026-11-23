import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, cookieHeader, createUser, prisma, resetDb, registerAndGetTokens } from './helpers.js';
import { encryptToken } from '../src/utils/encryption.js';

describe('Phase 3: GitHub Repository Management', () => {
  beforeEach(async () => {
    await resetDb();
    vi.restoreAllMocks();
  });

  // Helper to link a mock GitHub OAuth account to a user
  async function linkGitHubAccount(userId, { githubId = '999888', token = 'gho_valid_mock_token' } = {}) {
    return prisma.oAuthAccount.create({
      data: {
        userId,
        provider: 'GITHUB',
        providerAccountId: String(githubId),
        accessTokenEnc: encryptToken(token),
        scope: 'read:user user:email',
      },
    });
  }

  // Sample GitHub API repository payload
  const mockReactRepo = {
    id: 10270250,
    name: 'react',
    full_name: 'facebook/react',
    owner: { login: 'facebook', id: 69631 },
    private: false,
    html_url: 'https://github.com/facebook/react',
    description: 'The library for web and native user interfaces.',
    default_branch: 'main',
    language: 'JavaScript',
    updated_at: '2026-11-18T00:00:00Z',
    stargazers_count: 220000,
    forks_count: 45000,
  };

  const mockNextRepo = {
    id: 70107786,
    name: 'next.js',
    full_name: 'vercel/next.js',
    owner: { login: 'vercel', id: 14985020 },
    private: false,
    html_url: 'https://github.com/vercel/next.js',
    description: 'The React Framework',
    default_branch: 'canary',
    language: 'TypeScript',
    updated_at: '2026-11-18T01:00:00Z',
    stargazers_count: 120000,
    forks_count: 26000,
  };

  describe('1 & 2: GitHub Repository Listing (GET /api/v1/github/repos)', () => {
    it('returns 400 GITHUB_NOT_CONNECTED if user has no connected GitHub account', async () => {
      const { accessToken } = await registerAndGetTokens();

      const res = await api()
        .get('/api/v1/github/repos')
        .set('Cookie', cookieHeader({ access_token: accessToken }));

      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe('GITHUB_NOT_CONNECTED');
    });

    it('returns user repositories with pagination and imported status', async () => {
      const { res: regRes, accessToken } = await registerAndGetTokens();
      const userId = regRes.body.data.user.id;
      await linkGitHubAccount(userId);

      // Pre-import one repository so we can verify isImported flag
      await prisma.repository.create({
        data: {
          userId,
          githubRepoId: String(mockReactRepo.id),
          owner: mockReactRepo.owner.login,
          name: mockReactRepo.name,
          fullName: mockReactRepo.full_name,
          htmlUrl: mockReactRepo.html_url,
          defaultBranch: 'main',
          latestCommitSha: 'abc123sha',
          primaryLanguage: 'JavaScript',
        },
      });

      // Stub GitHub API fetch
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('/user/repos')) {
          return new Response(JSON.stringify([mockReactRepo, mockNextRepo]), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('Not found', { status: 404 });
      });

      const res = await api()
        .get('/api/v1/github/repos?page=1&perPage=10')
        .set('Cookie', cookieHeader({ access_token: accessToken }));

      expect(res.status).toBe(200);
      expect(res.body.meta).toEqual({ page: 1, perPage: 10 });
      expect(res.body.data).toHaveLength(2);

      // Verify react is marked as imported
      const reactItem = res.body.data.find((r) => r.name === 'react');
      expect(reactItem).toBeDefined();
      expect(reactItem.isImported).toBe(true);
      expect(reactItem.githubRepoId).toBe(String(mockReactRepo.id));
      expect(reactItem.owner).toBe('facebook');
      expect(reactItem.fullName).toBe('facebook/react');

      // Verify next.js is not imported yet
      const nextItem = res.body.data.find((r) => r.name === 'next.js');
      expect(nextItem).toBeDefined();
      expect(nextItem.isImported).toBe(false);
    });
  });

  describe('3: Successful Repository Import (POST /api/v1/repositories)', () => {
    it('imports public repo via "owner/repo" and stores metadata in PostgreSQL', async () => {
      const { res: regRes, accessToken } = await registerAndGetTokens();
      const userId = regRes.body.data.user.id;
      await linkGitHubAccount(userId);

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('/repos/facebook/react/commits/main')) {
          return new Response(JSON.stringify({ sha: 'commit_sha_998877' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (urlStr.includes('/repos/facebook/react')) {
          return new Response(JSON.stringify(mockReactRepo), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('Not found', { status: 404 });
      });

      const res = await api()
        .post('/api/v1/repositories')
        .set('Cookie', cookieHeader({ access_token: accessToken }))
        .send({ repo: 'facebook/react' });

      expect(res.status).toBe(201);
      expect(res.body.data?.repository).toBeDefined();

      const repo = res.body.data.repository;
      expect(repo.fullName).toBe('facebook/react');
      expect(repo.githubRepoId).toBe(String(mockReactRepo.id));
      expect(repo.owner).toBe('facebook');
      expect(repo.name).toBe('react');
      expect(repo.defaultBranch).toBe('main');
      expect(repo.latestCommitSha).toBe('commit_sha_998877');
      expect(repo.primaryLanguage).toBe('JavaScript');
      expect(repo.userId).toBe(userId);

      // Verify in database
      const dbRepo = await prisma.repository.findUnique({
        where: {
          userId_githubRepoId: {
            userId,
            githubRepoId: String(mockReactRepo.id),
          },
        },
      });
      expect(dbRepo).toBeDefined();
      expect(dbRepo.fullName).toBe('facebook/react');
    });

    it('supports full GitHub URL format for import', async () => {
      const { res: regRes, accessToken } = await registerAndGetTokens();
      const userId = regRes.body.data.user.id;
      await linkGitHubAccount(userId);

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('/repos/vercel/next.js/commits/canary')) {
          return new Response(JSON.stringify({ sha: 'next_canary_sha_123' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (urlStr.includes('/repos/vercel/next.js')) {
          return new Response(JSON.stringify(mockNextRepo), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('Not found', { status: 404 });
      });

      const res = await api()
        .post('/api/v1/repositories')
        .set('Cookie', cookieHeader({ access_token: accessToken }))
        .send({ repo: 'https://github.com/vercel/next.js.git' });

      expect(res.status).toBe(201);
      expect(res.body.data?.repository?.fullName).toBe('vercel/next.js');
      expect(res.body.data?.repository?.defaultBranch).toBe('canary');
      expect(res.body.data?.repository?.latestCommitSha).toBe('next_canary_sha_123');
    });
  });

  describe('4: Invalid Repository URL validation', () => {
    it('returns 400 for malformed repository identifier', async () => {
      const { accessToken } = await registerAndGetTokens();

      const res = await api()
        .post('/api/v1/repositories')
        .set('Cookie', cookieHeader({ access_token: accessToken }))
        .send({ repo: 'invalid-single-word' });

      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe('INVALID_REPO_IDENTIFIER');
    });

    it('returns 400 for non-GitHub repository URL', async () => {
      const { accessToken } = await registerAndGetTokens();

      const res = await api()
        .post('/api/v1/repositories')
        .set('Cookie', cookieHeader({ access_token: accessToken }))
        .send({ repo: 'https://gitlab.com/owner/project' });

      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe('INVALID_REPO_IDENTIFIER');
    });
  });

  describe('5: Nonexistent Repository Handling', () => {
    it('returns 404 NOT_FOUND when GitHub reports repository does not exist', async () => {
      const { accessToken } = await registerAndGetTokens();

      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        return new Response(JSON.stringify({ message: 'Not Found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const res = await api()
        .post('/api/v1/repositories')
        .set('Cookie', cookieHeader({ access_token: accessToken }))
        .send({ repo: 'nonexistent-user/nonexistent-repo' });

      expect(res.status).toBe(404);
      expect(res.body.error?.code).toBe('NOT_FOUND');
    });
  });

  describe('6: Private Repository Rejection', () => {
    it('returns 400 PRIVATE_REPO_UNSUPPORTED when importing a private repository', async () => {
      const { accessToken } = await registerAndGetTokens();

      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        return new Response(
          JSON.stringify({
            ...mockReactRepo,
            private: true,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });

      const res = await api()
        .post('/api/v1/repositories')
        .set('Cookie', cookieHeader({ access_token: accessToken }))
        .send({ repo: 'facebook/react' });

      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe('PRIVATE_REPO_UNSUPPORTED');
    });
  });

  describe('7: Duplicate Import Prevention', () => {
    it('returns 409 CONFLICT if the user attempts to import the same repository twice', async () => {
      const { accessToken } = await registerAndGetTokens();

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('/commits/main')) {
          return new Response(JSON.stringify({ sha: 'sha123' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify(mockReactRepo), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      // First import succeeds
      const firstRes = await api()
        .post('/api/v1/repositories')
        .set('Cookie', cookieHeader({ access_token: accessToken }))
        .send({ repo: 'facebook/react' });
      expect(firstRes.status).toBe(201);

      // Second import fails with 409
      const secondRes = await api()
        .post('/api/v1/repositories')
        .set('Cookie', cookieHeader({ access_token: accessToken }))
        .send({ repo: 'facebook/react' });
      expect(secondRes.status).toBe(409);
      expect(secondRes.body.error?.code).toBe('CONFLICT');
    });
  });

  describe('8: Repository Listing (GET /api/v1/repositories)', () => {
    it('lists all imported repositories for the authenticated user ordered by importedAt desc', async () => {
      const { res: regRes, accessToken } = await registerAndGetTokens();
      const userId = regRes.body.data.user.id;

      await prisma.repository.createMany({
        data: [
          {
            userId,
            githubRepoId: '111',
            owner: 'facebook',
            name: 'react',
            fullName: 'facebook/react',
            htmlUrl: 'https://github.com/facebook/react',
            defaultBranch: 'main',
            importedAt: new Date(Date.now() - 10000),
          },
          {
            userId,
            githubRepoId: '222',
            owner: 'vercel',
            name: 'next.js',
            fullName: 'vercel/next.js',
            htmlUrl: 'https://github.com/vercel/next.js',
            defaultBranch: 'canary',
            importedAt: new Date(),
          },
        ],
      });

      const res = await api()
        .get('/api/v1/repositories')
        .set('Cookie', cookieHeader({ access_token: accessToken }));

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data).toHaveLength(2);
      // Descending order: next.js imported more recently
      expect(res.body.data[0].fullName).toBe('vercel/next.js');
      expect(res.body.data[1].fullName).toBe('facebook/react');
    });
  });

  describe('9: Repository Details (GET /api/v1/repositories/:id)', () => {
    it('returns repository details for existing repository owned by user', async () => {
      const { res: regRes, accessToken } = await registerAndGetTokens();
      const userId = regRes.body.data.user.id;

      const created = await prisma.repository.create({
        data: {
          userId,
          githubRepoId: '111',
          owner: 'facebook',
          name: 'react',
          fullName: 'facebook/react',
          htmlUrl: 'https://github.com/facebook/react',
          defaultBranch: 'main',
          latestCommitSha: 'sha_test_123',
        },
      });

      const res = await api()
        .get(`/api/v1/repositories/${created.id}`)
        .set('Cookie', cookieHeader({ access_token: accessToken }));

      expect(res.status).toBe(200);
      expect(res.body.data?.repository?.id).toBe(created.id);
      expect(res.body.data?.repository?.fullName).toBe('facebook/react');
      expect(res.body.data?.repository?.latestCommitSha).toBe('sha_test_123');
    });
  });

  describe('10: Repository Deletion (DELETE /api/v1/repositories/:id)', () => {
    it('deletes repository from database and returns success', async () => {
      const { res: regRes, accessToken } = await registerAndGetTokens();
      const userId = regRes.body.data.user.id;

      const created = await prisma.repository.create({
        data: {
          userId,
          githubRepoId: '111',
          owner: 'facebook',
          name: 'react',
          fullName: 'facebook/react',
          htmlUrl: 'https://github.com/facebook/react',
        },
      });

      const deleteRes = await api()
        .delete(`/api/v1/repositories/${created.id}`)
        .set('Cookie', cookieHeader({ access_token: accessToken }));

      expect(deleteRes.status).toBe(200);
      expect(deleteRes.body.data?.success).toBe(true);

      // Verify deletion in database
      const dbCheck = await prisma.repository.findUnique({ where: { id: created.id } });
      expect(dbCheck).toBeNull();
    });
  });

  describe('11: Ownership Protection Between Two Users', () => {
    it('returns 404 NOT_FOUND when User B attempts to access or delete User A repository', async () => {
      // User A creates repository
      const { res: aliceReg, accessToken: aliceToken } = await registerAndGetTokens({
        email: 'alice@example.com',
        username: 'alice',
        password: 'password123',
      });
      const aliceId = aliceReg.body.data.user.id;

      const aliceRepo = await prisma.repository.create({
        data: {
          userId: aliceId,
          githubRepoId: '111',
          owner: 'facebook',
          name: 'react',
          fullName: 'facebook/react',
          htmlUrl: 'https://github.com/facebook/react',
        },
      });

      // User B logs in
      const { accessToken: bobToken } = await registerAndGetTokens({
        email: 'bob@example.com',
        username: 'bob',
        password: 'password123',
      });

      // User B attempts to GET User A's repo -> must return 404
      const getRes = await api()
        .get(`/api/v1/repositories/${aliceRepo.id}`)
        .set('Cookie', cookieHeader({ access_token: bobToken }));
      expect(getRes.status).toBe(404);
      expect(getRes.body.error?.code).toBe('NOT_FOUND');

      // User B attempts to DELETE User A's repo -> must return 404
      const deleteRes = await api()
        .delete(`/api/v1/repositories/${aliceRepo.id}`)
        .set('Cookie', cookieHeader({ access_token: bobToken }));
      expect(deleteRes.status).toBe(404);
      expect(deleteRes.body.error?.code).toBe('NOT_FOUND');

      // Verify repository still safely exists for User A
      const aliceGetRes = await api()
        .get(`/api/v1/repositories/${aliceRepo.id}`)
        .set('Cookie', cookieHeader({ access_token: aliceToken }));
      expect(aliceGetRes.status).toBe(200);
    });
  });

  describe('12: GitHub API Failure Mapping', () => {
    it('maps GitHub 401 response to 401 GITHUB_TOKEN_REVOKED', async () => {
      const { res: regRes, accessToken } = await registerAndGetTokens();
      const userId = regRes.body.data.user.id;
      await linkGitHubAccount(userId);

      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        return new Response(JSON.stringify({ message: 'Bad credentials' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const res = await api()
        .get('/api/v1/github/repos')
        .set('Cookie', cookieHeader({ access_token: accessToken }));

      expect(res.status).toBe(401);
      expect(res.body.error?.code).toBe('GITHUB_TOKEN_REVOKED');
    });

    it('maps GitHub 429/403 rate limit to 429 GITHUB_RATE_LIMITED', async () => {
      const { res: regRes, accessToken } = await registerAndGetTokens();
      const userId = regRes.body.data.user.id;
      await linkGitHubAccount(userId);

      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        return new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
          status: 403,
          headers: {
            'Content-Type': 'application/json',
            'x-ratelimit-remaining': '0',
          },
        });
      });

      const res = await api()
        .get('/api/v1/github/repos')
        .set('Cookie', cookieHeader({ access_token: accessToken }));

      expect(res.status).toBe(429);
      expect(res.body.error?.code).toBe('GITHUB_RATE_LIMITED');
    });

    it('maps GitHub 500 upstream server error to 502 GITHUB_UPSTREAM_ERROR', async () => {
      const { res: regRes, accessToken } = await registerAndGetTokens();
      const userId = regRes.body.data.user.id;
      await linkGitHubAccount(userId);

      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        return new Response('Internal Server Error', {
          status: 500,
        });
      });

      const res = await api()
        .get('/api/v1/github/repos')
        .set('Cookie', cookieHeader({ access_token: accessToken }));

      expect(res.status).toBe(502);
      expect(res.body.error?.code).toBe('GITHUB_UPSTREAM_ERROR');
    });
  });

  describe('Phase 6 History Endpoint: GET /api/v1/repositories/history', () => {
    it('returns empty array when user has no preview history', async () => {
      const { accessToken } = await registerAndGetTokens();

      const res = await api()
        .get('/api/v1/repositories/history')
        .set('Cookie', cookieHeader({ access_token: accessToken }));

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it('returns user preview sessions formatted for dashboard history', async () => {
      const { res: regRes, accessToken } = await registerAndGetTokens();
      const userId = regRes.body.data.user.id;

      const repo = await prisma.repository.create({
        data: {
          userId,
          githubRepoId: '987654',
          owner: 'testowner',
          name: 'testrepo',
          fullName: 'testowner/testrepo',
          defaultBranch: 'main',
          htmlUrl: 'https://github.com/testowner/testrepo',
        },
      });

      await prisma.previewSession.create({
        data: {
          userId,
          repositoryId: repo.id,
          status: 'RUNNING',
          framework: 'VITE_REACT',
          isActive: true,
          tokenHash: 'dummy_hash_1',
          previewTokenEnc: 'dummy_enc_1',
          commitSha: '0123456789abcdef0123456789abcdef01234567',
          branch: 'main',
          expiresAt: new Date(Date.now() + 3600000),
        },
      });

      const res = await api()
        .get('/api/v1/repositories/history')
        .set('Cookie', cookieHeader({ access_token: accessToken }));

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].repoFullName).toBe('testowner/testrepo');
      expect(res.body.data[0].status).toBe('running');
      expect(res.body.data[0].statusLabel).toBe('Live Preview');
      expect(res.body.data[0].actionLink).toBe(`/workspace/${repo.id}`);
    });

    it('requires authentication and rejects unauthenticated requests with 401', async () => {
      const res = await api().get('/api/v1/repositories/history');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/v1/repositories/:id/detect', () => {
    it('detects framework and project root for repository', async () => {
      const { res: regRes, accessToken } = await registerAndGetTokens();
      const userId = regRes.body.data.user.id;

      const repo = await prisma.repository.create({
        data: {
          userId,
          githubRepoId: '55443322',
          owner: 'gitview-fixtures',
          name: 'vite-react',
          fullName: 'gitview-fixtures/vite-react',
          defaultBranch: 'main',
          htmlUrl: 'https://github.com/gitview-fixtures/vite-react',
        },
      });

      const res = await api()
        .get(`/api/v1/repositories/${repo.id}/detect`)
        .set('Cookie', cookieHeader({ access_token: accessToken }));

      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.supported).toBe(true);
    });

    it('returns 404 if repository does not exist', async () => {
      const { accessToken } = await registerAndGetTokens();
      const res = await api()
        .get('/api/v1/repositories/non-existent-uuid/detect')
        .set('Cookie', cookieHeader({ access_token: accessToken }));

      expect(res.status).toBe(404);
    });
  });
});

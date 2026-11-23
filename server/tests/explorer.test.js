import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, cookieHeader, prisma, resetDb, registerAndGetTokens } from './helpers.js';
import { encryptToken } from '../src/utils/encryption.js';

describe('Phase 4: Repository Explorer & Code Viewer', () => {
  beforeEach(async () => {
    await resetDb();
    vi.restoreAllMocks();
  });

  // Helper to link a mock GitHub OAuth account to a user
  async function linkGitHubAccount(userId, { githubId = '123456', token = 'gho_mock_token_for_explorer' } = {}) {
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

  // Helper to create an imported repository in DB
  async function createTestRepository(userId, {
    owner = 'facebook',
    name = 'react',
    fullName = 'facebook/react',
    defaultBranch = 'main',
    isPrivate = false,
  } = {}) {
    return prisma.repository.create({
      data: {
        userId,
        githubRepoId: '10270250',
        owner,
        name,
        fullName,
        htmlUrl: `https://github.com/${fullName}`,
        defaultBranch,
        latestCommitSha: 'commit_sha_abc123',
        primaryLanguage: 'JavaScript',
        isPrivate,
      },
    });
  }

  describe('1, 2, 3: Directory Tree API (GET /api/v1/repositories/:id/tree)', () => {
    it('1. successfully retrieves root directory contents', async () => {
      const { res: regRes, accessToken } = await registerAndGetTokens();
      const userId = regRes.body.data.user.id;
      await linkGitHubAccount(userId);
      const repo = await createTestRepository(userId);

      const mockRootEntries = [
        { name: 'package.json', path: 'package.json', type: 'file', size: 1200, sha: 'sha_pkg' },
        { name: 'src', path: 'src', type: 'dir', size: 0, sha: 'sha_src' },
        { name: 'README.md', path: 'README.md', type: 'file', size: 3400, sha: 'sha_readme' },
      ];

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('/contents?ref=main')) {
          return new Response(JSON.stringify(mockRootEntries), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('Not found', { status: 404 });
      });

      const res = await api()
        .get(`/api/v1/repositories/${repo.id}/tree`)
        .set('Cookie', cookieHeader({ access_token: accessToken }));

      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.path).toBe('');
      expect(res.body.data.ref).toBe('main');
      expect(res.body.data.entries).toHaveLength(3);
    });

    it('2. successfully retrieves nested directory contents', async () => {
      const { res: regRes, accessToken } = await registerAndGetTokens();
      const userId = regRes.body.data.user.id;
      await linkGitHubAccount(userId);
      const repo = await createTestRepository(userId);

      const mockNestedEntries = [
        { name: 'Button.jsx', path: 'src/components/Button.jsx', type: 'file', size: 850, sha: 'sha_btn' },
        { name: 'Header.jsx', path: 'src/components/Header.jsx', type: 'file', size: 1100, sha: 'sha_hdr' },
      ];

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('/contents/src/components?ref=main')) {
          return new Response(JSON.stringify(mockNestedEntries), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('Not found', { status: 404 });
      });

      const res = await api()
        .get(`/api/v1/repositories/${repo.id}/tree?path=src/components&ref=main`)
        .set('Cookie', cookieHeader({ access_token: accessToken }));

      expect(res.status).toBe(200);
      expect(res.body.data.path).toBe('src/components');
      expect(res.body.data.entries).toHaveLength(2);
      expect(res.body.data.entries[0].name).toBe('Button.jsx');
    });

    it('3. sorts directories before files, and alphabetically within each group', async () => {
      const { res: regRes, accessToken } = await registerAndGetTokens();
      const userId = regRes.body.data.user.id;
      await linkGitHubAccount(userId);
      const repo = await createTestRepository(userId);

      const unsorted = [
        { name: 'zebra.js', path: 'zebra.js', type: 'file', size: 10, sha: '1' },
        { name: 'assets', path: 'assets', type: 'dir', size: 0, sha: '2' },
        { name: 'alpha.js', path: 'alpha.js', type: 'file', size: 20, sha: '3' },
        { name: 'components', path: 'components', type: 'dir', size: 0, sha: '4' },
      ];

      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        return new Response(JSON.stringify(unsorted), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const res = await api()
        .get(`/api/v1/repositories/${repo.id}/tree`)
        .set('Cookie', cookieHeader({ access_token: accessToken }));

      expect(res.status).toBe(200);
      const names = res.body.data.entries.map((e) => e.name);
      // Directories first (assets, components), then files (alpha.js, zebra.js)
      expect(names).toEqual(['assets', 'components', 'alpha.js', 'zebra.js']);
    });
  });

  describe('4, 5, 6, 7: File Content API (GET /api/v1/repositories/:id/file)', () => {
    it('4 & 5. successfully retrieves and decodes Base64 source code and detects language', async () => {
      const { res: regRes, accessToken } = await registerAndGetTokens();
      const userId = regRes.body.data.user.id;
      await linkGitHubAccount(userId);
      const repo = await createTestRepository(userId);

      const rawSource = 'export default function App() {\n  return <h1>Hello GitView</h1>;\n}\n';
      const base64Content = Buffer.from(rawSource).toString('base64');

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('/contents/src/App.jsx')) {
          return new Response(
            JSON.stringify({
              name: 'App.jsx',
              path: 'src/App.jsx',
              sha: 'sha_app_jsx',
              size: Buffer.byteLength(rawSource),
              type: 'file',
              content: base64Content,
              encoding: 'base64',
              html_url: 'https://github.com/facebook/react/blob/main/src/App.jsx',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response('Not found', { status: 404 });
      });

      const res = await api()
        .get(`/api/v1/repositories/${repo.id}/file?path=src/App.jsx`)
        .set('Cookie', cookieHeader({ access_token: accessToken }));

      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('App.jsx');
      expect(res.body.data.path).toBe('src/App.jsx');
      expect(res.body.data.language).toBe('javascript');
      expect(res.body.data.content).toBe(rawSource);
      expect(res.body.data.isBinary).toBe(false);
      expect(res.body.data.tooLarge).toBe(false);
    });

    it('6. safely handles binary files without sending decoded text', async () => {
      const { res: regRes, accessToken } = await registerAndGetTokens();
      const userId = regRes.body.data.user.id;
      await linkGitHubAccount(userId);
      const repo = await createTestRepository(userId);

      const fakeBinaryBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]); // PNG header with nulls
      const base64Binary = fakeBinaryBytes.toString('base64');

      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        return new Response(
          JSON.stringify({
            name: 'logo.png',
            path: 'public/logo.png',
            sha: 'sha_logo_png',
            size: 15400,
            type: 'file',
            content: base64Binary,
            encoding: 'base64',
            html_url: 'https://github.com/facebook/react/blob/main/public/logo.png',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });

      const res = await api()
        .get(`/api/v1/repositories/${repo.id}/file?path=public/logo.png`)
        .set('Cookie', cookieHeader({ access_token: accessToken }));

      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('logo.png');
      expect(res.body.data.isBinary).toBe(true);
      expect(res.body.data.content).toBeNull();
      expect(res.body.data.htmlUrl).toBeDefined();
    });

    it('7. safely handles files larger than 512 KB without sending content', async () => {
      const { res: regRes, accessToken } = await registerAndGetTokens();
      const userId = regRes.body.data.user.id;
      await linkGitHubAccount(userId);
      const repo = await createTestRepository(userId);

      const largeSize = 650 * 1024; // 650 KB > 512 KB limit

      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        return new Response(
          JSON.stringify({
            name: 'dataset.json',
            path: 'data/dataset.json',
            sha: 'sha_large',
            size: largeSize,
            type: 'file',
            content: '',
            encoding: 'base64',
            html_url: 'https://github.com/facebook/react/blob/main/data/dataset.json',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });

      const res = await api()
        .get(`/api/v1/repositories/${repo.id}/file?path=data/dataset.json`)
        .set('Cookie', cookieHeader({ access_token: accessToken }));

      expect(res.status).toBe(200);
      expect(res.body.data.tooLarge).toBe(true);
      expect(res.body.data.content).toBeNull();
      expect(res.body.data.size).toBe(largeSize);
      expect(res.body.data.htmlUrl).toBe('https://github.com/facebook/react/blob/main/data/dataset.json');
    });
  });

  describe('8 & 9: Type Mismatch Handling (File vs Directory)', () => {
    it('8. returns 400 NOT_A_FILE when requesting a directory as a file', async () => {
      const { res: regRes, accessToken } = await registerAndGetTokens();
      const userId = regRes.body.data.user.id;
      await linkGitHubAccount(userId);
      const repo = await createTestRepository(userId);

      // GitHub returns array when path is a directory
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        return new Response(
          JSON.stringify([
            { name: 'index.js', path: 'src/index.js', type: 'file' },
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });

      const res = await api()
        .get(`/api/v1/repositories/${repo.id}/file?path=src`)
        .set('Cookie', cookieHeader({ access_token: accessToken }));

      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe('NOT_A_FILE');
    });

    it('9. returns 400 NOT_A_DIRECTORY when requesting a file as a directory tree', async () => {
      const { res: regRes, accessToken } = await registerAndGetTokens();
      const userId = regRes.body.data.user.id;
      await linkGitHubAccount(userId);
      const repo = await createTestRepository(userId);

      // GitHub returns an object when path is a file
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        return new Response(
          JSON.stringify({
            name: 'package.json',
            path: 'package.json',
            type: 'file',
            size: 500,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });

      const res = await api()
        .get(`/api/v1/repositories/${repo.id}/tree?path=package.json`)
        .set('Cookie', cookieHeader({ access_token: accessToken }));

      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe('NOT_A_DIRECTORY');
    });
  });

  describe('10 & 11: Security & Path Validation', () => {
    it('10. rejects paths exceeding maximum length limit', async () => {
      const { res: regRes, accessToken } = await registerAndGetTokens();
      const userId = regRes.body.data.user.id;
      await linkGitHubAccount(userId);
      const repo = await createTestRepository(userId);

      const oversizedPath = 'a/'.repeat(300); // 600 characters > 500

      const res = await api()
        .get(`/api/v1/repositories/${repo.id}/file?path=${oversizedPath}`)
        .set('Cookie', cookieHeader({ access_token: accessToken }));

      expect(res.status).toBe(400);
      expect(res.body.error?.code).toMatch(/VALIDATION_ERROR|INVALID_PATH/);
    });

    it('11. strictly rejects path traversal attempts (..)', async () => {
      const { res: regRes, accessToken } = await registerAndGetTokens();
      const userId = regRes.body.data.user.id;
      await linkGitHubAccount(userId);
      const repo = await createTestRepository(userId);

      const res = await api()
        .get(`/api/v1/repositories/${repo.id}/file?path=src/../../etc/passwd`)
        .set('Cookie', cookieHeader({ access_token: accessToken }));

      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe('INVALID_PATH');
    });
  });

  describe('12: Public & Private Repository Access & Token Strategies', () => {
    it('12a. allows email/password user to browse public repository without GitHub OAuth', async () => {
      const { res: regRes, accessToken } = await registerAndGetTokens();
      const userId = regRes.body.data.user.id;
      // No linked GitHub account
      const repo = await createTestRepository(userId, { isPrivate: false });

      const mockEntries = [
        { name: 'README.md', path: 'README.md', type: 'file', size: 500, sha: 'sha1' },
      ];

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, opts) => {
        // Assert no Authorization header sent when no token configured
        expect(opts?.headers?.Authorization).toBeUndefined();
        return new Response(JSON.stringify(mockEntries), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const res = await api()
        .get(`/api/v1/repositories/${repo.id}/tree`)
        .set('Cookie', cookieHeader({ access_token: accessToken }));

      expect(res.status).toBe(200);
      expect(res.body.data.entries).toHaveLength(1);
    });

    it('12b. allows email/password user to read a file from public repository without GitHub OAuth', async () => {
      const { res: regRes, accessToken } = await registerAndGetTokens();
      const userId = regRes.body.data.user.id;
      const repo = await createTestRepository(userId, { isPrivate: false });

      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        return new Response(JSON.stringify({
          name: 'README.md',
          path: 'README.md',
          size: 14,
          content: Buffer.from('# Hello Public').toString('base64'),
          encoding: 'base64',
          sha: 'sha_readme',
          html_url: 'https://github.com/facebook/react/blob/main/README.md',
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const res = await api()
        .get(`/api/v1/repositories/${repo.id}/file?path=README.md`)
        .set('Cookie', cookieHeader({ access_token: accessToken }));

      expect(res.status).toBe(200);
      expect(res.body.data.content).toBe('# Hello Public');
    });

    it('12c. uses configured system GITHUB_TOKEN when user has no OAuth account', async () => {
      const originalEnvToken = process.env.GITHUB_TOKEN;
      process.env.GITHUB_TOKEN = 'ghp_system_fallback_token_12345';

      try {
        const { res: regRes, accessToken } = await registerAndGetTokens();
        const userId = regRes.body.data.user.id;
        const repo = await createTestRepository(userId, { isPrivate: false });

        let sentAuthHeader = null;
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, opts) => {
          sentAuthHeader = opts?.headers?.Authorization;
          return new Response(JSON.stringify([]), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        });

        const res = await api()
          .get(`/api/v1/repositories/${repo.id}/tree`)
          .set('Cookie', cookieHeader({ access_token: accessToken }));

        expect(res.status).toBe(200);
        expect(sentAuthHeader).toBe('Bearer ghp_system_fallback_token_12345');
      } finally {
        if (originalEnvToken !== undefined) {
          process.env.GITHUB_TOKEN = originalEnvToken;
        } else {
          delete process.env.GITHUB_TOKEN;
        }
      }
    });

    it('12d. prioritizes user OAuth token over system token', async () => {
      const originalEnvToken = process.env.GITHUB_TOKEN;
      process.env.GITHUB_TOKEN = 'ghp_system_token_to_be_overridden';

      try {
        const { res: regRes, accessToken } = await registerAndGetTokens();
        const userId = regRes.body.data.user.id;
        await linkGitHubAccount(userId, { token: 'gho_user_personal_oauth_token' });
        const repo = await createTestRepository(userId, { isPrivate: false });

        let sentAuthHeader = null;
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, opts) => {
          sentAuthHeader = opts?.headers?.Authorization;
          return new Response(JSON.stringify([]), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        });

        const res = await api()
          .get(`/api/v1/repositories/${repo.id}/tree`)
          .set('Cookie', cookieHeader({ access_token: accessToken }));

        expect(res.status).toBe(200);
        expect(sentAuthHeader).toBe('Bearer gho_user_personal_oauth_token');
      } finally {
        if (originalEnvToken !== undefined) {
          process.env.GITHUB_TOKEN = originalEnvToken;
        } else {
          delete process.env.GITHUB_TOKEN;
        }
      }
    });

    it('12e. rejects private repository access with 400 GITHUB_NOT_CONNECTED if user has no OAuth account', async () => {
      const originalEnvToken = process.env.GITHUB_TOKEN;
      process.env.GITHUB_TOKEN = 'ghp_system_token_must_not_bypass';

      try {
        const { res: regRes, accessToken } = await registerAndGetTokens();
        const userId = regRes.body.data.user.id;
        // Repository marked as private
        const repo = await createTestRepository(userId, { isPrivate: true });

        const res = await api()
          .get(`/api/v1/repositories/${repo.id}/tree`)
          .set('Cookie', cookieHeader({ access_token: accessToken }));

        // System token must NOT bypass private repo check
        expect(res.status).toBe(400);
        expect(res.body.error?.code).toBe('GITHUB_NOT_CONNECTED');
      } finally {
        if (originalEnvToken !== undefined) {
          process.env.GITHUB_TOKEN = originalEnvToken;
        } else {
          delete process.env.GITHUB_TOKEN;
        }
      }
    });
  });

  describe('13: Repository Ownership Protection', () => {
    it('13. returns 404 NOT_FOUND when User B attempts to access User A repository tree or files', async () => {
      // User A
      const { res: aliceReg } = await registerAndGetTokens({
        email: 'alice@example.com',
        username: 'alice',
        password: 'password123',
      });
      const aliceId = aliceReg.body.data.user.id;
      await linkGitHubAccount(aliceId);
      const aliceRepo = await createTestRepository(aliceId);

      // User B
      const { res: bobReg, accessToken: bobToken } = await registerAndGetTokens({
        email: 'bob@example.com',
        username: 'bob',
        password: 'password123',
      });
      const bobId = bobReg.body.data.user.id;
      await linkGitHubAccount(bobId, { githubId: '654321' });

      // User B requests User A's directory tree
      const treeRes = await api()
        .get(`/api/v1/repositories/${aliceRepo.id}/tree`)
        .set('Cookie', cookieHeader({ access_token: bobToken }));
      expect(treeRes.status).toBe(404);
      expect(treeRes.body.error?.code).toBe('NOT_FOUND');

      // User B requests User A's file content
      const fileRes = await api()
        .get(`/api/v1/repositories/${aliceRepo.id}/file?path=README.md`)
        .set('Cookie', cookieHeader({ access_token: bobToken }));
      expect(fileRes.status).toBe(404);
      expect(fileRes.body.error?.code).toBe('NOT_FOUND');
    });
  });

  describe('14, 15, 16: Upstream GitHub Error Mapping', () => {
    it('14. maps GitHub rate limit response to 429 GITHUB_RATE_LIMITED', async () => {
      const { res: regRes, accessToken } = await registerAndGetTokens();
      const userId = regRes.body.data.user.id;
      await linkGitHubAccount(userId);
      const repo = await createTestRepository(userId);

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
        .get(`/api/v1/repositories/${repo.id}/tree`)
        .set('Cookie', cookieHeader({ access_token: accessToken }));

      expect(res.status).toBe(429);
      expect(res.body.error?.code).toBe('GITHUB_RATE_LIMITED');
    });

    it('15. maps GitHub 401 response to 401 GITHUB_TOKEN_REVOKED', async () => {
      const { res: regRes, accessToken } = await registerAndGetTokens();
      const userId = regRes.body.data.user.id;
      await linkGitHubAccount(userId);
      const repo = await createTestRepository(userId);

      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        return new Response(JSON.stringify({ message: 'Bad credentials' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const res = await api()
        .get(`/api/v1/repositories/${repo.id}/file?path=package.json`)
        .set('Cookie', cookieHeader({ access_token: accessToken }));

      expect(res.status).toBe(401);
      expect(res.body.error?.code).toBe('GITHUB_TOKEN_REVOKED');
    });

    it('16. maps GitHub fetch timeout to 504 GITHUB_TIMEOUT', async () => {
      const { res: regRes, accessToken } = await registerAndGetTokens();
      const userId = regRes.body.data.user.id;
      await linkGitHubAccount(userId);
      const repo = await createTestRepository(userId);

      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        const timeoutErr = new Error('The operation was aborted');
        timeoutErr.name = 'AbortError';
        throw timeoutErr;
      });

      const res = await api()
        .get(`/api/v1/repositories/${repo.id}/tree`)
        .set('Cookie', cookieHeader({ access_token: accessToken }));

      expect(res.status).toBe(504);
      expect(res.body.error?.code).toBe('GITHUB_TIMEOUT');
    });
  });
});

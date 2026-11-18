import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, cookieHeader, cookieValue, createUser, prisma, rawCookie, resetDb, registerAndGetTokens } from './helpers.js';
import { decryptToken } from '../src/utils/encryption.js';

describe('GitHub OAuth Integration', () => {
  beforeEach(async () => {
    await resetDb();
    vi.restoreAllMocks();
  });

  describe('GET /api/v1/auth/github (OAuth Initiation)', () => {
    it('validates whether GitHub OAuth is configured', async () => {
      const { isGitHubOAuthConfigured } = await import('../src/modules/auth/githubOAuth.service.js');
      expect(isGitHubOAuthConfigured()).toBe(true);
    });

    it('redirects to GitHub authorization with correct client_id, scope, and state', async () => {
      const res = await api().get('/api/v1/auth/github');

      expect(res.status).toBe(302);
      const location = res.headers.location;
      expect(location).toContain('https://github.com/login/oauth/authorize');

      const url = new URL(location);
      expect(url.searchParams.get('client_id')).toBe('test_github_client_id');
      expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:3000/api/v1/auth/github/callback');
      expect(url.searchParams.get('scope')).toBe('read:user user:email');
      expect(url.searchParams.get('state')).toBeTypeOf('string');
      expect(url.searchParams.get('state')?.length).toBe(64); // 32 bytes hex
    });

    it('sets a secure, short-lived HTTP-only state cookie', async () => {
      const res = await api().get('/api/v1/auth/github');

      const stateCookieRaw = rawCookie(res, 'github_oauth_state');
      expect(stateCookieRaw).toBeDefined();
      expect(stateCookieRaw).toMatch(/HttpOnly/i);
      expect(stateCookieRaw).toMatch(/SameSite=Lax/i);
      expect(stateCookieRaw).toMatch(/Path=\/api\/v1\/auth/i);
      expect(stateCookieRaw).toMatch(/Max-Age=600/); // 10 minutes

      const url = new URL(res.headers.location);
      const stateInUrl = url.searchParams.get('state');
      const stateInCookie = cookieValue(res, 'github_oauth_state');
      expect(stateInUrl).toBe(stateInCookie);
    });
  });

  describe('GET /api/v1/auth/github/callback (Security & State Validation)', () => {
    it('redirects to /login with error=oauth_state_invalid when state is missing', async () => {
      const res = await api().get('/api/v1/auth/github/callback?code=some_code');
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('/login?error=oauth_state_invalid');
    });

    it('redirects to /login with error=oauth_state_invalid when state does not match cookie', async () => {
      const res = await api()
        .get('/api/v1/auth/github/callback?code=some_code&state=forged_state')
        .set('Cookie', cookieHeader({ github_oauth_state: 'legitimate_state' }));

      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('/login?error=oauth_state_invalid');
      // State cookie should be cleared on failure
      expect(rawCookie(res, 'github_oauth_state')).toMatch(/Expires=Thu, 01 Jan 1970/i);
    });

    it('handles GitHub authorization denial / cancellation by redirecting to /login with error=github_denied', async () => {
      const res = await api()
        .get('/api/v1/auth/github/callback?error=access_denied&error_description=The+user+has+denied+your+application')
        .set('Cookie', cookieHeader({ github_oauth_state: 'any_state' }));

      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('/login?error=github_denied');
      expect(rawCookie(res, 'github_oauth_state')).toMatch(/Expires=Thu, 01 Jan 1970/i);
    });
  });

  describe('GET /api/v1/auth/github/callback (Account Flows)', () => {
    const mockState = 'a'.repeat(64);
    const mockCode = 'valid_oauth_code_123';
    const mockAccessToken = 'gho_secret_access_token_xyz987';

    function setupGitHubFetchMock({
      githubId = 1234567,
      login = 'octocat',
      email = 'octocat@example.com',
      avatar_url = 'https://avatars.githubusercontent.com/u/1234567',
    } = {}) {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('github.com/login/oauth/access_token')) {
          return new Response(
            JSON.stringify({
              access_token: mockAccessToken,
              token_type: 'bearer',
              scope: 'read:user,user:email',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (urlStr.includes('api.github.com/user/emails')) {
          return new Response(
            JSON.stringify([
              { email, primary: true, verified: true, visibility: 'public' },
            ]),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (urlStr.includes('api.github.com/user')) {
          return new Response(
            JSON.stringify({
              id: githubId,
              login,
              name: 'Octo Cat',
              email,
              avatar_url,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        throw new Error(`Unhandled fetch URL: ${urlStr}`);
      });
    }

    it('CASE 3: New GitHub user registration (creates User, OAuthAccount, sets cookies and redirects to /dashboard)', async () => {
      setupGitHubFetchMock({
        githubId: 888111,
        login: 'octo_newbie',
        email: 'octonewbie@example.com',
      });

      const res = await api()
        .get(`/api/v1/auth/github/callback?code=${mockCode}&state=${mockState}`)
        .set('Cookie', cookieHeader({ github_oauth_state: mockState }));

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('http://localhost:5173/dashboard');

      // GitView authentication cookies must be issued
      const accessCookie = rawCookie(res, 'access_token');
      const refreshCookie = rawCookie(res, 'refresh_token');
      expect(accessCookie).toBeDefined();
      expect(refreshCookie).toBeDefined();

      // User must exist in database with passwordHash null
      const user = await prisma.user.findUnique({
        where: { email: 'octonewbie@example.com' },
        include: { oauthAccounts: true },
      });
      expect(user).toBeDefined();
      expect(user.username).toBe('octo_newbie');
      expect(user.passwordHash).toBeNull();
      expect(user.avatarUrl).toBe('https://avatars.githubusercontent.com/u/1234567');

      // OAuthAccount must be created with encrypted token
      expect(user.oauthAccounts.length).toBe(1);
      const oauth = user.oauthAccounts[0];
      expect(oauth.provider).toBe('GITHUB');
      expect(oauth.providerAccountId).toBe('888111');
      expect(oauth.accessTokenEnc).not.toContain(mockAccessToken);
      expect(decryptToken(oauth.accessTokenEnc)).toBe(mockAccessToken);

      // Tokens or secrets must never appear in redirect location or body
      expect(res.headers.location).not.toContain(mockAccessToken);
      expect(JSON.stringify(res.body)).not.toContain(mockAccessToken);
    });

    it('CASE 1: Returning GitHub user login (finds account, refreshes token, issues cookies, redirects to /dashboard)', async () => {
      // Setup existing user and OAuthAccount
      const existingUser = await createUser({
        email: 'returning@example.com',
        username: 'returning_user',
        withPassword: false,
      });

      await prisma.oAuthAccount.create({
        data: {
          userId: existingUser.id,
          provider: 'GITHUB',
          providerAccountId: '555222',
          accessTokenEnc: 'old_encrypted_token',
        },
      });

      const newAccessToken = 'gho_new_refreshed_token_456';
      setupGitHubFetchMock({
        githubId: 555222,
        login: 'returning_user',
        email: 'returning@example.com',
      });
      // Override fetch to return new token
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        if (String(url).includes('access_token')) {
          return new Response(
            JSON.stringify({ access_token: newAccessToken, scope: 'read:user' }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response(
          JSON.stringify({ id: 555222, login: 'returning_user', email: 'returning@example.com' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });

      const res = await api()
        .get(`/api/v1/auth/github/callback?code=${mockCode}&state=${mockState}`)
        .set('Cookie', cookieHeader({ github_oauth_state: mockState }));

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('http://localhost:5173/dashboard');

      expect(rawCookie(res, 'access_token')).toBeDefined();
      expect(rawCookie(res, 'refresh_token')).toBeDefined();

      // Check updated encrypted token in DB
      const updatedOAuth = await prisma.oAuthAccount.findUnique({
        where: {
          provider_providerAccountId: {
            provider: 'GITHUB',
            providerAccountId: '555222',
          },
        },
      });
      expect(decryptToken(updatedOAuth.accessTokenEnc)).toBe(newAccessToken);
    });

    it('CASE 2: Existing GitView user connecting GitHub to an active authenticated session', async () => {
      // 1. Log in / register as Alice
      const { accessToken: aliceAccess } = await registerAndGetTokens({
        email: 'alice@company.com',
        username: 'alice_dev',
        password: 'Password123!',
      });

      setupGitHubFetchMock({
        githubId: 777333,
        login: 'alice_github',
        email: 'alice.gh@example.com',
      });

      // 2. Callback request includes Alice's access_token cookie
      const res = await api()
        .get(`/api/v1/auth/github/callback?code=${mockCode}&state=${mockState}`)
        .set('Cookie', cookieHeader({ github_oauth_state: mockState, access_token: aliceAccess }));

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('http://localhost:5173/settings?github=connected');

      // Verify OAuthAccount is linked to Alice's account
      const alice = await prisma.user.findUnique({
        where: { email: 'alice@company.com' },
        include: { oauthAccounts: true },
      });
      expect(alice.oauthAccounts.length).toBe(1);
      expect(alice.oauthAccounts[0].providerAccountId).toBe('777333');
      expect(decryptToken(alice.oauthAccounts[0].accessTokenEnc)).toBe(mockAccessToken);
    });

    it('CASE 2 Prevention: Prevents duplicate account linking when GitHub is already linked to another user', async () => {
      // Bob has GitHub ID 777333 linked
      const bob = await createUser({ email: 'bob@example.com', username: 'bob_user' });
      await prisma.oAuthAccount.create({
        data: {
          userId: bob.id,
          provider: 'GITHUB',
          providerAccountId: '777333',
          accessTokenEnc: 'enc_token',
        },
      });

      // Alice tries to connect the same GitHub account
      const { accessToken: aliceAccess } = await registerAndGetTokens({
        email: 'alice2@example.com',
        username: 'alice2',
        password: 'Password123!',
      });

      setupGitHubFetchMock({
        githubId: 777333,
        login: 'bob_github',
        email: 'shared@example.com',
      });

      const res = await api()
        .get(`/api/v1/auth/github/callback?code=${mockCode}&state=${mockState}`)
        .set('Cookie', cookieHeader({ github_oauth_state: mockState, access_token: aliceAccess }));

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('http://localhost:5173/settings?error=github_conflict');

      // Bob remains the sole owner of that link
      const bobOAuth = await prisma.oAuthAccount.findUnique({
        where: { provider_providerAccountId: { provider: 'GITHUB', providerAccountId: '777333' } },
      });
      expect(bobOAuth.userId).toBe(bob.id);
    });

    it('SECURITY RULE: Prevents automatic email-based merging when email exists and user is unauthenticated', async () => {
      // Local user Alice already exists with password
      await createUser({
        email: 'alice@local.dev',
        username: 'alice_local',
        password: 'LocalPassword123',
      });

      // Attacker or unauthenticated user tries to log in with GitHub having Alice's email
      setupGitHubFetchMock({
        githubId: 999999,
        login: 'alice_attacker',
        email: 'alice@local.dev',
      });

      const res = await api()
        .get(`/api/v1/auth/github/callback?code=${mockCode}&state=${mockState}`)
        .set('Cookie', cookieHeader({ github_oauth_state: mockState }));

      expect(res.status).toBe(302);
      // Must NOT log in and must NOT merge; must redirect to login with account_exists error
      expect(res.headers.location).toBe('http://localhost:5173/login?error=account_exists');

      // No auth cookies should be issued
      expect(rawCookie(res, 'access_token')).toBeUndefined();
      expect(rawCookie(res, 'refresh_token')).toBeUndefined();

      // Alice's account should have NO OAuthAccount attached
      const alice = await prisma.user.findUnique({
        where: { email: 'alice@local.dev' },
        include: { oauthAccounts: true },
      });
      expect(alice.oauthAccounts.length).toBe(0);
    });
  });
});

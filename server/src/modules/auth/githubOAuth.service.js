import crypto from 'node:crypto';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { encryptToken } from '../../utils/encryption.js';
import { issueTokens } from './auth.service.js';

const GITHUB_AUTH_ENDPOINT = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_ENDPOINT = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_ENDPOINT = 'https://api.github.com/user';
const GITHUB_EMAILS_ENDPOINT = 'https://api.github.com/user/emails';

// Only request read:user and user:email for MVP (no private repo scope)
export const GITHUB_OAUTH_SCOPES = 'read:user user:email';

/**
 * Checks if GitHub OAuth is properly configured in environment variables.
 */
export function isGitHubOAuthConfigured() {
  return Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
}

/**
 * Initiates GitHub OAuth flow: generates state and constructs authorization URL.
 */
export function createGitHubAuthInitiation() {
  if (!isGitHubOAuthConfigured()) {
    throw new Error('GITHUB_OAUTH_NOT_CONFIGURED');
  }

  const state = crypto.randomBytes(32).toString('hex');
  const params = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: env.GITHUB_CALLBACK_URL,
    scope: GITHUB_OAUTH_SCOPES,
    state,
  });

  return {
    url: `${GITHUB_AUTH_ENDPOINT}?${params.toString()}`,
    state,
  };
}

/**
 * Securely compares state strings using constant-time comparison to prevent timing attacks.
 */
export function verifyOAuthState(stateQuery, stateCookie) {
  if (!stateQuery || !stateCookie) return false;
  if (typeof stateQuery !== 'string' || typeof stateCookie !== 'string') return false;

  const bufA = Buffer.from(stateQuery);
  const bufB = Buffer.from(stateCookie);

  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Exchanges authorization code for a GitHub access token.
 */
export async function exchangeCodeForGitHubToken(code) {
  const response = await fetch(GITHUB_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'GitView-App',
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: env.GITHUB_CALLBACK_URL,
    }),
  });

  if (!response.ok) {
    throw new Error(`GitHub token exchange failed with status ${response.status}`);
  }

  const data = await response.json();
  if (data.error) {
    throw new Error(data.error_description || data.error);
  }

  return {
    accessToken: data.access_token,
    scope: data.scope || GITHUB_OAUTH_SCOPES,
  };
}

/**
 * Fetches user profile and verified primary email from GitHub.
 */
export async function fetchGitHubUserData(accessToken) {
  const userResponse = await fetch(GITHUB_USER_ENDPOINT, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'GitView-App',
    },
  });

  if (!userResponse.ok) {
    throw new Error(`GitHub profile fetch failed with status ${userResponse.status}`);
  }

  const githubUser = await userResponse.json();

  let primaryEmail = githubUser.email ? githubUser.email.toLowerCase().trim() : null;

  // If email is null (private email setting on GitHub), fetch user/emails
  if (!primaryEmail) {
    try {
      const emailResponse = await fetch(GITHUB_EMAILS_ENDPOINT, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'GitView-App',
        },
      });

      if (emailResponse.ok) {
        const emails = await emailResponse.json();
        if (Array.isArray(emails)) {
          const primaryObj = emails.find((e) => e.primary && e.verified) || emails.find((e) => e.verified) || emails[0];
          if (primaryObj?.email) {
            primaryEmail = primaryObj.email.toLowerCase().trim();
          }
        }
      }
    } catch {
      // Fallback: email remains null if private and unresolvable
    }
  }

  return {
    githubUser,
    primaryEmail,
  };
}

/**
 * Resolves account linking according to the 3 approved cases.
 */
export async function resolveGitHubAccount({ githubUser, primaryEmail, accessToken, scope, authenticatedUser }) {
  const providerAccountId = String(githubUser.id);
  const encryptedToken = encryptToken(accessToken);

  // Check if an OAuthAccount already exists for this GitHub user ID
  const existingOAuth = await prisma.oAuthAccount.findUnique({
    where: {
      provider_providerAccountId: {
        provider: 'GITHUB',
        providerAccountId,
      },
    },
    include: { user: true },
  });

  // CASE 2: Existing GitView user connecting GitHub from Settings / active session
  if (authenticatedUser) {
    if (existingOAuth && existingOAuth.userId !== authenticatedUser.id) {
      // This GitHub identity is already linked to another GitView user
      return {
        action: 'ERROR',
        error: 'github_conflict',
        redirectUrl: `${env.FRONTEND_URL}/settings?error=github_conflict`,
      };
    }

    if (existingOAuth) {
      // Update token for this user
      await prisma.oAuthAccount.update({
        where: { id: existingOAuth.id },
        data: { accessTokenEnc: encryptedToken, scope },
      });
    } else {
      // Link GitHub account to current authenticated user
      // First check if user already has a different GitHub account linked
      const existingUserGitHub = await prisma.oAuthAccount.findUnique({
        where: {
          userId_provider: {
            userId: authenticatedUser.id,
            provider: 'GITHUB',
          },
        },
      });

      if (existingUserGitHub) {
        await prisma.oAuthAccount.update({
          where: { id: existingUserGitHub.id },
          data: { providerAccountId, accessTokenEnc: encryptedToken, scope },
        });
      } else {
        await prisma.oAuthAccount.create({
          data: {
            userId: authenticatedUser.id,
            provider: 'GITHUB',
            providerAccountId,
            accessTokenEnc: encryptedToken,
            scope,
          },
        });
      }
    }

    return {
      action: 'LINKED',
      redirectUrl: `${env.FRONTEND_URL}/settings?github=connected`,
    };
  }

  // CASE 1: Returning GitHub user
  if (existingOAuth) {
    // Refresh the stored encrypted GitHub token
    await prisma.oAuthAccount.update({
      where: { id: existingOAuth.id },
      data: { accessTokenEnc: encryptedToken, scope },
    });

    const tokens = await issueTokens(existingOAuth.user);
    return {
      action: 'LOGIN',
      user: existingOAuth.user,
      tokens,
      redirectUrl: `${env.FRONTEND_URL}/dashboard`,
    };
  }

  // CASE 3: New GitHub user
  // SECURITY RULE: If GitHub email matches existing local account but user is NOT authenticated,
  // DO NOT automatically merge accounts! Send user to login with account_exists error.
  if (primaryEmail) {
    const existingLocalUser = await prisma.user.findUnique({
      where: { email: primaryEmail },
    });

    if (existingLocalUser) {
      return {
        action: 'ERROR',
        error: 'account_exists',
        redirectUrl: `${env.FRONTEND_URL}/login?error=account_exists`,
      };
    }
  }

  // Generate unique username based on GitHub login (3-30 chars, lowercase alphanumeric, -, _)
  const baseLogin = (githubUser.login || 'dev')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_')
    .slice(0, 30);
  const prefix = baseLogin.length < 3 ? `gh_${baseLogin}`.slice(0, 30) : baseLogin;

  let finalUsername = prefix;
  let attempt = 1;
  while (await prisma.user.findUnique({ where: { username: finalUsername } })) {
    const suffix = `_${attempt++}`;
    finalUsername = `${prefix.slice(0, 30 - suffix.length)}${suffix}`;
  }

  // Create User and OAuthAccount in a single transaction
  const user = await prisma.$transaction(async (tx) => {
    const newUser = await tx.user.create({
      data: {
        email: primaryEmail,
        username: finalUsername,
        passwordHash: null, // GitHub-only accounts have no local password
        avatarUrl: githubUser.avatar_url || null,
        role: 'USER',
      },
    });

    await tx.oAuthAccount.create({
      data: {
        userId: newUser.id,
        provider: 'GITHUB',
        providerAccountId,
        accessTokenEnc: encryptedToken,
        scope,
      },
    });

    return newUser;
  });

  const tokens = await issueTokens(user);
  return {
    action: 'REGISTER',
    user,
    tokens,
    redirectUrl: `${env.FRONTEND_URL}/dashboard`,
  };
}

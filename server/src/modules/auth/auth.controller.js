// HTTP only: read the request, call ONE service function, set cookies, choose
// the status code, send { data } or redirect. No business rules and no Prisma in here.
import {
  REFRESH_COOKIE,
  OAUTH_STATE_COOKIE,
  clearAuthCookies,
  setAuthCookies,
  setOAuthStateCookie,
  clearOAuthStateCookie,
} from '../../utils/cookies.js';
import { env } from '../../config/env.js';
import { UnauthorizedError } from '../../utils/AppError.js';
import * as authService from './auth.service.js';
import * as githubOAuthService from './githubOAuth.service.js';

export const register = async (req, res) => {
  const { user, tokens } = await authService.register(req.body);
  setAuthCookies(res, tokens);
  res.status(201).json({ data: { user } });
};

export const login = async (req, res) => {
  const { user, tokens } = await authService.login(req.body);
  setAuthCookies(res, tokens);
  res.status(200).json({ data: { user } });
};

export const refresh = async (req, res) => {
  try {
    const { user, tokens } = await authService.refresh(req.cookies?.[REFRESH_COOKIE]);
    setAuthCookies(res, tokens);
    res.status(200).json({ data: { user } });
  } catch (err) {
    // A failed refresh means this session is over, so remove the dead cookies.
    // (Only for 401s: a temporary database error must not log people out.)
    if (err instanceof UnauthorizedError) clearAuthCookies(res);
    throw err;
  }
};

export const logout = async (req, res) => {
  await authService.logout(req.cookies?.[REFRESH_COOKIE]);
  clearAuthCookies(res);
  res.status(204).end();
};

/**
 * Initiates the GitHub OAuth authorization flow.
 * Generates CSRF state, stores it in an HTTP-only cookie, and redirects to GitHub.
 */
export const githubAuth = (req, res) => {
  if (!githubOAuthService.isGitHubOAuthConfigured()) {
    return res.status(500).json({
      error: {
        code: 'OAUTH_NOT_CONFIGURED',
        message: 'GitHub OAuth is not configured. Please set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET in server/.env.',
      },
    });
  }

  const { url, state } = githubOAuthService.createGitHubAuthInitiation();
  setOAuthStateCookie(res, state);
  res.redirect(url);
};

/**
 * Handles the redirect back from GitHub after authorization.
 * Verifies state, exchanges code for token, and delegates to resolveGitHubAccount.
 */
export const githubCallback = async (req, res) => {
  const { code, state, error } = req.query;

  // Handle GitHub cancellation or access denial
  if (error) {
    clearOAuthStateCookie(res);
    return res.redirect(`${env.FRONTEND_URL}/login?error=github_denied`);
  }

  const stateCookie = req.cookies?.[OAUTH_STATE_COOKIE];

  // Validate state to prevent CSRF
  if (!state || !stateCookie || !githubOAuthService.verifyOAuthState(state, stateCookie)) {
    clearOAuthStateCookie(res);
    return res.redirect(`${env.FRONTEND_URL}/login?error=oauth_state_invalid`);
  }

  // Clear state cookie now that it has been used
  clearOAuthStateCookie(res);

  if (!code || typeof code !== 'string') {
    return res.redirect(`${env.FRONTEND_URL}/login?error=oauth_state_invalid`);
  }

  try {
    const { accessToken, scope } = await githubOAuthService.exchangeCodeForGitHubToken(code);
    const { githubUser, primaryEmail } = await githubOAuthService.fetchGitHubUserData(accessToken);

    const result = await githubOAuthService.resolveGitHubAccount({
      githubUser,
      primaryEmail,
      accessToken,
      scope,
      authenticatedUser: req.user || null,
    });

    if (result.action === 'ERROR') {
      return res.redirect(result.redirectUrl);
    }

    if (result.tokens) {
      setAuthCookies(res, result.tokens);
    }

    return res.redirect(result.redirectUrl);
  } catch {
    return res.redirect(`${env.FRONTEND_URL}/login?error=github_error`);
  }
};

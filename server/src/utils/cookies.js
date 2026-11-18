// The only place that knows how auth cookies are shaped.
//
// Why cookies instead of localStorage? An "httpOnly" cookie cannot be read by
// JavaScript, so even if an attacker injects a script into our frontend (XSS),
// they cannot steal the tokens.
import { isProduction } from '../config/env.js';
import { ACCESS_TOKEN_TTL_SECONDS, REFRESH_TOKEN_TTL_SECONDS } from './tokens.js';

export const ACCESS_COOKIE = 'access_token';
export const REFRESH_COOKIE = 'refresh_token';
export const OAUTH_STATE_COOKIE = 'github_oauth_state';
export const OAUTH_STATE_TTL_SECONDS = 10 * 60; // 10 minutes

// The refresh and OAuth state cookies are only sent to /api/v1/auth/*, not on every API call,
// which shrinks the window in which they can leak or be abused.
export const AUTH_COOKIE_PATH = '/api/v1/auth';
export const REFRESH_COOKIE_PATH = AUTH_COOKIE_PATH;

const baseOptions = {
  httpOnly: true, // invisible to JavaScript (defence against XSS token theft)
  secure: isProduction, // HTTPS only in production (browsers allow http on localhost)
  sameSite: 'lax', // not sent on cross-site POST/PUT/DELETE (defence against CSRF)
};

export function setAuthCookies(res, { accessToken, refreshToken }) {
  res.cookie(ACCESS_COOKIE, accessToken, {
    ...baseOptions,
    path: '/',
    maxAge: ACCESS_TOKEN_TTL_SECONDS * 1000, // Express wants milliseconds
  });
  res.cookie(REFRESH_COOKIE, refreshToken, {
    ...baseOptions,
    path: REFRESH_COOKIE_PATH,
    maxAge: REFRESH_TOKEN_TTL_SECONDS * 1000,
  });
}

// A cookie is only removed if the clearing header repeats the same path
// (and domain) it was set with. That is why `path` appears again here.
export function clearAuthCookies(res) {
  res.clearCookie(ACCESS_COOKIE, { ...baseOptions, path: '/' });
  res.clearCookie(REFRESH_COOKIE, { ...baseOptions, path: REFRESH_COOKIE_PATH });
}

export function setOAuthStateCookie(res, state) {
  res.cookie(OAUTH_STATE_COOKIE, state, {
    ...baseOptions,
    path: AUTH_COOKIE_PATH,
    maxAge: OAUTH_STATE_TTL_SECONDS * 1000,
  });
}

export function clearOAuthStateCookie(res) {
  res.clearCookie(OAUTH_STATE_COOKIE, {
    ...baseOptions,
    path: AUTH_COOKIE_PATH,
  });
}

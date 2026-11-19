import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

export { prisma };

export const api = () => request(app); // one request, no cookie memory
export const agent = () => request.agent(app); // like a browser: remembers cookies

export const credentials = { email: 'alice@example.com', username: 'alice', password: 'correct horse battery' };

// Deletes all rows (PreviewSession, Repository, OAuthAccount and RefreshToken first: they point at User/Repository).
export async function resetDb() {
  await prisma.previewSession.deleteMany();
  await prisma.repository.deleteMany();
  await prisma.oAuthAccount.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.user.deleteMany();
}

// Inserts a user straight into the DB (faster than going through /register).
export async function createUser({ email = credentials.email, username = credentials.username, password = credentials.password, role = 'USER', withPassword = true } = {}) {
  return prisma.user.create({
    data: { email, username, role, passwordHash: withPassword ? await bcrypt.hash(password, 4) : null },
  });
}

// Reads the raw "Set-Cookie" header line for one cookie, e.g.
// "refresh_token=abc; Max-Age=604800; Path=/api/v1/auth; HttpOnly; SameSite=Lax"
export function rawCookie(res, name) {
  return (res.headers['set-cookie'] ?? []).find((line) => line.startsWith(`${name}=`));
}

export function cookieValue(res, name) {
  const line = rawCookie(res, name);
  return line ? line.split(';')[0].slice(name.length + 1) : undefined;
}

// A cookie is "cleared" when the server sets it to empty with a past expiry.
export function isCleared(res, name) {
  const line = rawCookie(res, name);
  return Boolean(line) && line.startsWith(`${name}=;`) && /Expires=Thu, 01 Jan 1970/i.test(line);
}

// Builds a Cookie request header (what a browser would send).
export const cookieHeader = (cookies) => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');

// Signs a token exactly like the server does, but with overrides, so tests can
// create expired / forged / wrong-secret tokens.
export function signTestToken(payload, { secret, ...options }) {
  return jwt.sign(payload, secret, { algorithm: 'HS256', ...options });
}

export const secrets = () => ({
  access: process.env.JWT_ACCESS_SECRET,
  refresh: process.env.JWT_REFRESH_SECRET,
});

// Registers through the real endpoint and returns the raw tokens from the cookies.
export async function registerAndGetTokens(user = credentials) {
  const res = await api().post('/api/v1/auth/register').send(user);
  return { res, accessToken: cookieValue(res, 'access_token'), refreshToken: cookieValue(res, 'refresh_token') };
}

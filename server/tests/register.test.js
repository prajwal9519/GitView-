import bcrypt from 'bcrypt';
import { beforeEach, describe, expect, it } from 'vitest';
import { api, cookieValue, createUser, credentials, prisma, rawCookie, resetDb } from './helpers.js';

const register = (body) => api().post('/api/v1/auth/register').send(body);

describe('POST /api/v1/auth/register', () => {
  beforeEach(resetDb);

  it('creates the account, returns the public user and sets both auth cookies', async () => {
    const res = await register(credentials);

    expect(res.status).toBe(201);
    expect(res.body.data.user).toMatchObject({ email: 'alice@example.com', username: 'alice', role: 'USER' });
    expect(res.body.data.user.id).toBeTypeOf('string');

    const access = rawCookie(res, 'access_token');
    const refresh = rawCookie(res, 'refresh_token');
    for (const cookie of [access, refresh]) {
      expect(cookie).toMatch(/HttpOnly/i); // JavaScript cannot read it
      expect(cookie).toMatch(/SameSite=Lax/i); // not sent on cross-site POST
    }
    expect(access).toMatch(/Path=\/(;|$)/);
    expect(access).toMatch(/Max-Age=900/); // 15 minutes
    expect(refresh).toMatch(/Path=\/api\/v1\/auth/); // only sent to /auth/*
    expect(refresh).toMatch(/Max-Age=604800/); // 7 days
  });

  it('never exposes the password or its hash in the response', async () => {
    const res = await register(credentials);
    const text = JSON.stringify(res.body);

    expect(text).not.toMatch(/passwordHash/i);
    expect(text).not.toContain(credentials.password);
    expect(text).not.toContain('$2'); // bcrypt hashes start with $2
  });

  it('stores a bcrypt hash, never the plaintext password', async () => {
    await register(credentials);
    const user = await prisma.user.findUnique({ where: { email: credentials.email } });

    expect(user.passwordHash).not.toBe(credentials.password);
    expect(user.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(await bcrypt.compare(credentials.password, user.passwordHash)).toBe(true);
  });

  it('stores only a SHA-256 hash of the refresh token', async () => {
    const res = await register(credentials);
    const token = cookieValue(res, 'refresh_token');
    const rows = await prisma.refreshToken.findMany();

    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].tokenHash).not.toBe(token);
    expect(rows[0].revokedAt).toBeNull();
  });

  it('normalises the email to lowercase and trims it', async () => {
    const res = await register({ ...credentials, email: '  Alice@Example.COM ', username: '  ALICE ' });

    expect(res.status).toBe(201);
    expect(res.body.data.user).toMatchObject({ email: 'alice@example.com', username: 'alice' });
  });

  it('ignores a client-supplied role (mass assignment protection)', async () => {
    const res = await register({ ...credentials, role: 'ADMIN' });

    expect(res.status).toBe(201);
    expect(res.body.data.user.role).toBe('USER');
    expect((await prisma.user.findUnique({ where: { email: credentials.email } })).role).toBe('USER');
  });

  it('rejects an email that is already registered (even in a different case) with 409', async () => {
    await createUser();
    const res = await register({ ...credentials, email: 'ALICE@example.com', username: 'someone-else' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('rejects a username that is already taken with 409', async () => {
    await createUser();
    const res = await register({ ...credentials, email: 'other@example.com' });

    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/username/i);
  });

  it('lets only one of two simultaneous identical registrations win', async () => {
    const [a, b] = await Promise.all([register(credentials), register(credentials)]);

    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(await prisma.user.count()).toBe(1);
  });

  describe('validation (400 VALIDATION_ERROR with per-field details)', () => {
    const cases = [
      ['a password shorter than 8 characters', { password: 'short' }, 'password'],
      ['a password over 72 bytes (bcrypt would silently truncate it)', { password: 'é'.repeat(40) }, 'password'],
      ['an invalid email', { email: 'not-an-email' }, 'email'],
      ['a username with illegal characters', { username: 'bad name!' }, 'username'],
      ['a username that is too short', { username: 'ab' }, 'username'],
      ['a missing password', { password: undefined }, 'password'],
    ];

    it.each(cases)('rejects %s', async (_label, override, field) => {
      const res = await register({ ...credentials, ...override });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details.map((d) => d.field)).toContain(field);
      expect(await prisma.user.count()).toBe(0);
    });

    it('rejects a request with no body at all', async () => {
      const res = await api().post('/api/v1/auth/register');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });
});

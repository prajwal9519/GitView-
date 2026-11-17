import { beforeEach, describe, expect, it } from 'vitest';
import { api, createUser, credentials, prisma, rawCookie, resetDb } from './helpers.js';

const login = (body) => api().post('/api/v1/auth/login').send(body);

describe('POST /api/v1/auth/login', () => {
  beforeEach(async () => {
    await resetDb();
    await createUser();
  });

  it('logs in with correct credentials, sets cookies and returns the public user', async () => {
    const res = await login({ email: credentials.email, password: credentials.password });

    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({ email: credentials.email, username: 'alice', role: 'USER' });
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash/i);
    expect(rawCookie(res, 'access_token')).toMatch(/HttpOnly/i);
    expect(rawCookie(res, 'refresh_token')).toMatch(/HttpOnly/i);
  });

  it('accepts the email in any letter case', async () => {
    const res = await login({ email: 'ALICE@Example.com', password: credentials.password });
    expect(res.status).toBe(200);
  });

  it('starts a new token family for every login', async () => {
    await login(credentials);
    await login(credentials);
    const rows = await prisma.refreshToken.findMany();

    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.familyId)).size).toBe(2);
  });

  it('gives an identical 401 for a wrong password and for an unknown email (no user enumeration)', async () => {
    const wrongPassword = await login({ email: credentials.email, password: 'wrong password!' });
    const unknownEmail = await login({ email: 'nobody@example.com', password: credentials.password });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body).toEqual(unknownEmail.body);
    expect(wrongPassword.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(rawCookie(wrongPassword, 'access_token')).toBeUndefined();
  });

  it('treats a GitHub-only account (no password) as invalid credentials', async () => {
    await createUser({ email: 'octo@example.com', username: 'octocat', withPassword: false });
    const res = await login({ email: 'octo@example.com', password: 'anything at all' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('rejects malformed input with 400 before touching the database', async () => {
    const res = await login({ email: 'not-an-email' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

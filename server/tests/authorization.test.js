import { beforeEach, describe, expect, it } from 'vitest';
import { api, cookieHeader, cookieValue, createUser, credentials, resetDb, secrets, signTestToken } from './helpers.js';

const asCookie = (accessToken) => cookieHeader({ access_token: accessToken });

async function loginAs(user) {
  const res = await api().post('/api/v1/auth/login').send({ email: user.email, password: credentials.password });
  return cookieValue(res, 'access_token');
}

describe('authenticate middleware (GET /api/v1/users/me)', () => {
  beforeEach(resetDb);

  it('returns 401 TOKEN_MISSING without a cookie', async () => {
    const res = await api().get('/api/v1/users/me');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_MISSING');
  });

  it('returns the current user for a valid access token, without the password hash', async () => {
    const user = await createUser();
    const res = await api().get('/api/v1/users/me').set('Cookie', asCookie(await loginAs(user)));

    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({ id: user.id, email: credentials.email, role: 'USER' });
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash/i);
  });

  it('returns 401 TOKEN_EXPIRED for an expired access token', async () => {
    const user = await createUser();
    const expired = signTestToken({ role: 'USER' }, { secret: secrets().access, subject: user.id, expiresIn: -10 });
    const res = await api().get('/api/v1/users/me').set('Cookie', asCookie(expired));

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_EXPIRED');
  });

  it('returns 401 TOKEN_INVALID for a token signed with the wrong secret (forged)', async () => {
    const user = await createUser();
    const forged = signTestToken({ role: 'ADMIN' }, { secret: 'x'.repeat(40), subject: user.id, expiresIn: 60 });
    const res = await api().get('/api/v1/users/me').set('Cookie', asCookie(forged));

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_INVALID');
  });

  it('rejects an unsigned token that claims alg "none"', async () => {
    const user = await createUser();
    const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const unsigned = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: user.id, role: 'ADMIN', exp: Math.floor(Date.now() / 1000) + 600 })}.`;
    const res = await api().get('/api/v1/users/me').set('Cookie', asCookie(unsigned));

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_INVALID');
  });

  it('rejects a payload edited after signing (role escalation attempt)', async () => {
    const user = await createUser();
    const token = await loginAs(user);
    const [header, , signature] = token.split('.');
    const evilPayload = Buffer.from(JSON.stringify({ sub: user.id, role: 'ADMIN', exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url');
    const res = await api().get('/api/v1/admin/users').set('Cookie', asCookie(`${header}.${evilPayload}.${signature}`));

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_INVALID');
  });

  it('rejects a refresh token used as an access token', async () => {
    const res = await api().post('/api/v1/auth/register').send(credentials);
    const refreshToken = cookieValue(res, 'refresh_token');
    const out = await api().get('/api/v1/users/me').set('Cookie', asCookie(refreshToken));

    expect(out.status).toBe(401);
    expect(out.body.error.code).toBe('TOKEN_INVALID');
  });

  it('returns 401 for a valid token whose user has been deleted', async () => {
    const user = await createUser();
    const token = await loginAs(user);
    await resetDb();
    const res = await api().get('/api/v1/users/me').set('Cookie', asCookie(token));

    expect(res.status).toBe(401);
  });
});

describe('requireRole middleware (GET /api/v1/admin/users)', () => {
  beforeEach(resetDb);

  it('returns 401 when not logged in', async () => {
    expect((await api().get('/api/v1/admin/users')).status).toBe(401);
  });

  it('returns 403 FORBIDDEN for a normal USER', async () => {
    const user = await createUser();
    const res = await api().get('/api/v1/admin/users').set('Cookie', asCookie(await loginAs(user)));

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('returns the user list for an ADMIN, with pagination meta and no password hashes', async () => {
    const admin = await createUser({ email: 'admin@example.com', username: 'admin', role: 'ADMIN' });
    await createUser({ email: 'b@example.com', username: 'bob' });
    const res = await api().get('/api/v1/admin/users?perPage=1').set('Cookie', asCookie(await loginAs(admin)));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.meta).toEqual({ page: 1, perPage: 1, total: 2 });
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash/i);
  });

  it('validates query parameters (perPage above 100 is a 400)', async () => {
    const admin = await createUser({ email: 'admin@example.com', username: 'admin', role: 'ADMIN' });
    const res = await api().get('/api/v1/admin/users?perPage=1000').set('Cookie', asCookie(await loginAs(admin)));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

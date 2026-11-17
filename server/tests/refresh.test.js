import { beforeEach, describe, expect, it } from 'vitest';
import { api, cookieHeader, cookieValue, credentials, isCleared, prisma, rawCookie, registerAndGetTokens, resetDb, secrets, signTestToken } from './helpers.js';

const refreshWith = (refreshToken) =>
  api().post('/api/v1/auth/refresh').set('Cookie', cookieHeader({ refresh_token: refreshToken }));

describe('POST /api/v1/auth/refresh (rotation)', () => {
  beforeEach(resetDb);

  it('issues a new token pair and revokes the old refresh token', async () => {
    const { refreshToken: first } = await registerAndGetTokens();
    const res = await refreshWith(first);

    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe(credentials.email);

    const second = cookieValue(res, 'refresh_token');
    expect(second).toBeTruthy();
    expect(second).not.toBe(first); // rotated, not reused
    expect(cookieValue(res, 'access_token')).toBeTruthy();

    const rows = await prisma.refreshToken.findMany({ orderBy: { createdAt: 'asc' } });
    expect(rows).toHaveLength(2);
    expect(rows[0].revokedAt).not.toBeNull(); // old one is dead
    expect(rows[1].revokedAt).toBeNull(); // new one is live
    expect(rows[1].familyId).toBe(rows[0].familyId); // same login session
  });

  it('gives an access token that works on a protected route', async () => {
    const { refreshToken } = await registerAndGetTokens();
    const res = await refreshWith(refreshToken);
    const me = await api().get('/api/v1/users/me').set('Cookie', cookieHeader({ access_token: cookieValue(res, 'access_token') }));

    expect(me.status).toBe(200);
  });

  it('allows a chain of rotations (each new token works once)', async () => {
    let { refreshToken } = await registerAndGetTokens();
    for (let i = 0; i < 3; i++) {
      const res = await refreshWith(refreshToken);
      expect(res.status).toBe(200);
      refreshToken = cookieValue(res, 'refresh_token');
    }
  });

  it('detects reuse: replaying an old token returns TOKEN_REUSED and kills the whole family', async () => {
    const { refreshToken: stolen } = await registerAndGetTokens();
    const legit = await refreshWith(stolen); // the real user rotates normally
    const newest = cookieValue(legit, 'refresh_token');

    const replay = await refreshWith(stolen); // the thief replays the old token
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('TOKEN_REUSED');

    // Safe outcome: the newest token is revoked too, so the real user must log in again.
    const afterwards = await refreshWith(newest);
    expect(afterwards.status).toBe(401);
    expect(await prisma.refreshToken.count({ where: { revokedAt: null } })).toBe(0);
  });

  it('does not touch other login sessions when reuse is detected', async () => {
    const { refreshToken: sessionA } = await registerAndGetTokens();
    const loginB = await api().post('/api/v1/auth/login').send(credentials); // second device
    const sessionB = cookieValue(loginB, 'refresh_token');

    await refreshWith(sessionA);
    await refreshWith(sessionA); // replay -> family A revoked

    expect((await refreshWith(sessionB)).status).toBe(200); // device B unaffected
  });

  it('lets only one of two simultaneous refreshes with the same token succeed', async () => {
    const { refreshToken } = await registerAndGetTokens();
    const results = await Promise.all([refreshWith(refreshToken), refreshWith(refreshToken)]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
    expect(results.find((r) => r.status === 401).body.error.code).toBe('TOKEN_REUSED');
  });

  it('clears the cookies when a refresh fails with 401', async () => {
    const res = await refreshWith('garbage');

    expect(res.status).toBe(401);
    expect(isCleared(res, 'access_token')).toBe(true);
    expect(isCleared(res, 'refresh_token')).toBe(true);
  });

  it('returns TOKEN_MISSING when there is no refresh cookie', async () => {
    const res = await api().post('/api/v1/auth/refresh');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_MISSING');
  });

  it('returns TOKEN_INVALID for garbage and for a token signed with the wrong secret', async () => {
    expect((await refreshWith('not.a.jwt')).body.error.code).toBe('TOKEN_INVALID');

    // An ACCESS token must never be accepted as a refresh token (different secrets).
    const { accessToken } = await registerAndGetTokens({ ...credentials, email: 'b@example.com', username: 'bob' });
    const res = await refreshWith(accessToken);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_INVALID');
  });

  it('returns TOKEN_EXPIRED for an expired refresh token', async () => {
    const { res } = await registerAndGetTokens();
    const user = res.body.data.user;
    const expired = signTestToken({ fam: 'f' }, { secret: secrets().refresh, subject: user.id, jwtid: 'x', expiresIn: -10 });

    const out = await refreshWith(expired);
    expect(out.status).toBe(401);
    expect(out.body.error.code).toBe('TOKEN_EXPIRED');
  });

  it('rejects a correctly signed token that has no row in the database', async () => {
    const { res } = await registerAndGetTokens();
    const orphan = signTestToken({ fam: 'f' }, { secret: secrets().refresh, subject: res.body.data.user.id, jwtid: crypto.randomUUID(), expiresIn: 60 });

    expect((await refreshWith(orphan)).body.error.code).toBe('TOKEN_INVALID');
  });

  it('rejects a token whose stored hash does not match', async () => {
    const { refreshToken } = await registerAndGetTokens();
    await prisma.refreshToken.updateMany({ data: { tokenHash: 'f'.repeat(64) } });

    expect((await refreshWith(refreshToken)).body.error.code).toBe('TOKEN_INVALID');
  });

  it('applies a changed role at the next refresh', async () => {
    const { refreshToken, res } = await registerAndGetTokens();
    await prisma.user.update({ where: { id: res.body.data.user.id }, data: { role: 'ADMIN' } });

    const out = await refreshWith(refreshToken);
    const admin = await api().get('/api/v1/admin/users').set('Cookie', cookieHeader({ access_token: cookieValue(out, 'access_token') }));

    expect(admin.status).toBe(200);
  });
});

describe('POST /api/v1/auth/logout', () => {
  beforeEach(resetDb);

  it('revokes the session, clears both cookies and returns 204', async () => {
    const { refreshToken } = await registerAndGetTokens();
    const res = await api().post('/api/v1/auth/logout').set('Cookie', cookieHeader({ refresh_token: refreshToken }));

    expect(res.status).toBe(204);
    expect(isCleared(res, 'access_token')).toBe(true);
    expect(isCleared(res, 'refresh_token')).toBe(true);
    expect(await prisma.refreshToken.count({ where: { revokedAt: null } })).toBe(0);
  });

  it('makes the old refresh token unusable', async () => {
    const { refreshToken } = await registerAndGetTokens();
    await api().post('/api/v1/auth/logout').set('Cookie', cookieHeader({ refresh_token: refreshToken }));

    const res = await refreshWith(refreshToken);
    expect(res.status).toBe(401);
  });

  it('succeeds even with no cookies or a garbage cookie (the goal is already met)', async () => {
    expect((await api().post('/api/v1/auth/logout')).status).toBe(204);
    const res = await api().post('/api/v1/auth/logout').set('Cookie', cookieHeader({ refresh_token: 'garbage' }));
    expect(res.status).toBe(204);
    expect(rawCookie(res, 'refresh_token')).toBeTruthy();
  });

  it('only ends its own session, not the user\'s other devices', async () => {
    const { refreshToken: a } = await registerAndGetTokens();
    const b = cookieValue(await api().post('/api/v1/auth/login').send(credentials), 'refresh_token');

    await api().post('/api/v1/auth/logout').set('Cookie', cookieHeader({ refresh_token: a }));

    expect((await refreshWith(b)).status).toBe(200);
  });
});

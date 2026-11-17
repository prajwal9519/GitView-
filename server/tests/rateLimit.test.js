import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.hoisted code runs BEFORE the imports, so the limiter is built with a tiny
// limit (3). Every other test file keeps the generous default from setup.js.
vi.hoisted(() => {
  process.env.AUTH_RATE_LIMIT_MAX = '3';
});

const { api, createUser, credentials, resetDb } = await import('./helpers.js');

const login = (password) => api().post('/api/v1/auth/login').send({ email: credentials.email, password });

describe('login rate limiting', () => {
  beforeEach(async () => {
    await resetDb();
    await createUser();
  });

  it('counts only FAILED attempts, then blocks the IP with a 429 in the standard error shape', async () => {
    // Successful logins are not counted, so normal users are never locked out
    // (6 successes > the limit of 3, and all pass).
    for (let i = 0; i < 6; i++) expect((await login(credentials.password)).status).toBe(200);

    // Three failures use up the allowance...
    for (let i = 0; i < 3; i++) expect((await login('wrong password')).status).toBe(401);

    // ...and the next attempt is blocked, even with the correct password.
    const blocked = await login(credentials.password);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('TOO_MANY_REQUESTS');
  });
});

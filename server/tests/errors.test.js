import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, credentials, prisma, resetDb } from './helpers.js';

describe('error handling', () => {
  beforeEach(resetDb);
  afterEach(() => vi.restoreAllMocks());

  it('answers unknown routes with a JSON 404 in the standard error shape', async () => {
    const res = await api().get('/api/v1/nope');

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('answers malformed JSON with 400 INVALID_JSON', async () => {
    const res = await api().post('/api/v1/auth/login').set('Content-Type', 'application/json').send('{"email": ');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });

  it('rejects bodies over 100 kb with 413', async () => {
    const res = await api().post('/api/v1/auth/login').send({ email: 'a@example.com', password: 'x'.repeat(150_000) });

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('hides internal details of unexpected errors behind a generic 500', async () => {
    vi.spyOn(prisma.user, 'findUnique').mockRejectedValueOnce(new Error('connection to db-host-7 failed: password=hunter2'));
    const res = await api().post('/api/v1/auth/login').send(credentials);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
    expect(JSON.stringify(res.body)).not.toMatch(/hunter2|db-host/);
  });

  it('sets security headers and does not advertise Express', async () => {
    const res = await api().get('/api/v1/health');

    expect(res.status).toBe(200);
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('only allows the configured frontend origin in CORS, with credentials', async () => {
    const allowed = await api().options('/api/v1/auth/login').set('Origin', 'http://localhost:5173').set('Access-Control-Request-Method', 'POST');
    const denied = await api().options('/api/v1/auth/login').set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'POST');

    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');
    expect(denied.headers['access-control-allow-origin']).not.toBe('https://evil.example');
  });
});

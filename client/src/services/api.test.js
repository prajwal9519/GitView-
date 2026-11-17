import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import api, { AUTH_EXCLUDED_ENDPOINTS, isExcludedAuthEndpoint, formatApiError } from './api';

describe('Axios API Client & Refresh Interceptor', () => {
  let originalAdapter;
  let dispatchedEvents = [];

  beforeEach(() => {
    originalAdapter = api.defaults.adapter;
    dispatchedEvents = [];

    // Ensure window.dispatchEvent mock is in place
    if (typeof window === 'undefined') {
      globalThis.window = {
        dispatchEvent: (event) => {
          dispatchedEvents.push(event);
          return true;
        }
      };
    } else {
      vi.spyOn(window, 'dispatchEvent').mockImplementation((event) => {
        dispatchedEvents.push(event);
        return true;
      });
    }
  });

  afterEach(() => {
    api.defaults.adapter = originalAdapter;
    vi.restoreAllMocks();
  });

  describe('AUTH_EXCLUDED_ENDPOINTS & helper', () => {
    it('should correctly identify excluded endpoints', () => {
      expect(isExcludedAuthEndpoint('/auth/login')).toBe(true);
      expect(isExcludedAuthEndpoint('/auth/register')).toBe(true);
      expect(isExcludedAuthEndpoint('/auth/logout')).toBe(true);
      expect(isExcludedAuthEndpoint('/auth/refresh')).toBe(true);
      expect(isExcludedAuthEndpoint('http://localhost:3000/api/v1/auth/refresh')).toBe(true);

      expect(isExcludedAuthEndpoint('/users/me')).toBe(false);
      expect(isExcludedAuthEndpoint('/repos')).toBe(false);
      expect(isExcludedAuthEndpoint(null)).toBe(false);
      expect(isExcludedAuthEndpoint(undefined)).toBe(false);
    });

    it('contains all required auth endpoints', () => {
      expect(AUTH_EXCLUDED_ENDPOINTS).toContain('/auth/login');
      expect(AUTH_EXCLUDED_ENDPOINTS).toContain('/auth/register');
      expect(AUTH_EXCLUDED_ENDPOINTS).toContain('/auth/logout');
      expect(AUTH_EXCLUDED_ENDPOINTS).toContain('/auth/refresh');
    });
  });

  describe('formatApiError', () => {
    it('extracts backend error code, message and details', () => {
      const mockAxiosError = {
        response: {
          status: 400,
          data: {
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Invalid input',
              details: [{ field: 'username', message: 'Too short' }]
            }
          }
        }
      };

      const formatted = formatApiError(mockAxiosError);
      expect(formatted.status).toBe(400);
      expect(formatted.code).toBe('VALIDATION_ERROR');
      expect(formatted.message).toBe('Invalid input');
      expect(formatted.details).toEqual([{ field: 'username', message: 'Too short' }]);
      expect(formatted.raw).toBe(mockAxiosError);
    });

    it('provides fallback values for network or unknown errors', () => {
      const genericError = new Error('Network failed');
      const formatted = formatApiError(genericError);
      expect(formatted.status).toBeUndefined();
      expect(formatted.code).toBe('UNKNOWN_ERROR');
      expect(formatted.message).toBe('Network failed');
      expect(formatted.details).toEqual([]);
    });
  });

  describe('401 Token Refresh Handling', () => {
    it('should refresh token and retry original request when receiving 401 TOKEN_EXPIRED', async () => {
      let usersMeCalls = 0;
      let refreshCalls = 0;

      api.defaults.adapter = async (config) => {
        if (config.url === '/users/me') {
          usersMeCalls++;
          if (usersMeCalls === 1) {
            const err = new Error('Token expired');
            err.response = {
              status: 401,
              data: { error: { code: 'TOKEN_EXPIRED', message: 'Token has expired' } }
            };
            err.config = config;
            throw err;
          }
          return {
            data: { data: { user: { id: 'u1', username: 'alex' } } },
            status: 200,
            statusText: 'OK',
            headers: {},
            config
          };
        }

        if (config.url === '/auth/refresh') {
          refreshCalls++;
          return {
            data: { data: { user: { id: 'u1', username: 'alex' } } },
            status: 200,
            statusText: 'OK',
            headers: {},
            config
          };
        }

        throw new Error(`Unexpected URL: ${config.url}`);
      };

      const response = await api.get('/users/me');

      expect(usersMeCalls).toBe(2); // Initial failed call + 1 retry
      expect(refreshCalls).toBe(1); // Single refresh call
      expect(response.data.data.user.username).toBe('alex');
    });

    it('should refresh token and retry original request when receiving 401 TOKEN_MISSING', async () => {
      let usersMeCalls = 0;
      let refreshCalls = 0;

      api.defaults.adapter = async (config) => {
        if (config.url === '/users/me') {
          usersMeCalls++;
          if (usersMeCalls === 1) {
            const err = new Error('Token missing');
            err.response = {
              status: 401,
              data: { error: { code: 'TOKEN_MISSING', message: 'Authentication required' } }
            };
            err.config = config;
            throw err;
          }
          return {
            data: { data: { user: { id: 'u2', username: 'sarah' } } },
            status: 200,
            statusText: 'OK',
            headers: {},
            config
          };
        }

        if (config.url === '/auth/refresh') {
          refreshCalls++;
          return {
            data: { data: { user: { id: 'u2', username: 'sarah' } } },
            status: 200,
            statusText: 'OK',
            headers: {},
            config
          };
        }

        throw new Error(`Unexpected URL: ${config.url}`);
      };

      const response = await api.get('/users/me');

      expect(usersMeCalls).toBe(2); // Initial failed call + 1 retry
      expect(refreshCalls).toBe(1); // Single refresh call
      expect(response.data.data.user.username).toBe('sarah');
    });

    it('should attempt only ONE refresh request at a time and queue simultaneous failed requests', async () => {
      let usersMeCalls = 0;
      let reposCalls = 0;
      let refreshCalls = 0;

      let resolveRefresh;
      const refreshPromise = new Promise((resolve) => {
        resolveRefresh = resolve;
      });

      api.defaults.adapter = async (config) => {
        if (config.url === '/users/me') {
          usersMeCalls++;
          if (usersMeCalls === 1) {
            const err = new Error('Token expired');
            err.response = {
              status: 401,
              data: { error: { code: 'TOKEN_EXPIRED', message: 'Token has expired' } }
            };
            err.config = config;
            throw err;
          }
          return {
            data: { data: { user: { id: 'u1' } } },
            status: 200,
            statusText: 'OK',
            headers: {},
            config
          };
        }

        if (config.url === '/repos') {
          reposCalls++;
          if (reposCalls === 1) {
            const err = new Error('Token missing');
            err.response = {
              status: 401,
              data: { error: { code: 'TOKEN_MISSING', message: 'Authentication required' } }
            };
            err.config = config;
            throw err;
          }
          return {
            data: { data: { repos: ['repo-1', 'repo-2'] } },
            status: 200,
            statusText: 'OK',
            headers: {},
            config
          };
        }

        if (config.url === '/auth/refresh') {
          refreshCalls++;
          await refreshPromise;
          return {
            data: { data: { user: { id: 'u1' } } },
            status: 200,
            statusText: 'OK',
            headers: {},
            config
          };
        }

        throw new Error(`Unexpected URL: ${config.url}`);
      };

      // Launch both requests concurrently
      const request1Promise = api.get('/users/me');
      const request2Promise = api.get('/repos');

      // Allow microtasks to run so request1 initiates refresh and request2 queues
      await new Promise((r) => setTimeout(r, 10));

      expect(refreshCalls).toBe(1);

      // Complete the refresh
      resolveRefresh();

      const [res1, res2] = await Promise.all([request1Promise, request2Promise]);

      expect(res1.data.data.user.id).toBe('u1');
      expect(res2.data.data.repos).toEqual(['repo-1', 'repo-2']);
      expect(refreshCalls).toBe(1); // Only 1 refresh call was made for both
      expect(usersMeCalls).toBe(2);
      expect(reposCalls).toBe(2);
    });

    it('should retry each original request only once and prevent refresh loops', async () => {
      let usersMeCalls = 0;
      let refreshCalls = 0;

      api.defaults.adapter = async (config) => {
        if (config.url === '/users/me') {
          usersMeCalls++;
          // Always return 401 TOKEN_EXPIRED
          const err = new Error('Token expired');
          err.response = {
            status: 401,
            data: { error: { code: 'TOKEN_EXPIRED', message: 'Token has expired' } }
          };
          err.config = config;
          throw err;
        }

        if (config.url === '/auth/refresh') {
          refreshCalls++;
          return {
            data: { data: { user: { id: 'u1' } } },
            status: 200,
            statusText: 'OK',
            headers: {},
            config
          };
        }

        throw new Error(`Unexpected URL: ${config.url}`);
      };

      await expect(api.get('/users/me')).rejects.toMatchObject({
        status: 401,
        code: 'TOKEN_EXPIRED'
      });

      // Retried once and stopped; did not loop
      expect(usersMeCalls).toBe(2);
      expect(refreshCalls).toBe(1);
    });

    it('should NOT trigger refresh for excluded endpoint /auth/login', async () => {
      let loginCalls = 0;
      let refreshCalls = 0;

      api.defaults.adapter = async (config) => {
        if (config.url === '/auth/login') {
          loginCalls++;
          const err = new Error('Invalid credentials');
          err.response = {
            status: 401,
            data: { error: { code: 'INVALID_CREDENTIALS', message: 'Invalid credentials' } }
          };
          err.config = config;
          throw err;
        }

        if (config.url === '/auth/refresh') {
          refreshCalls++;
          return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
        }

        throw new Error(`Unexpected URL: ${config.url}`);
      };

      await expect(api.post('/auth/login', { email: 'a@b.com', password: 'bad' })).rejects.toMatchObject({
        status: 401,
        code: 'INVALID_CREDENTIALS'
      });

      expect(loginCalls).toBe(1);
      expect(refreshCalls).toBe(0);
    });

    it('should NOT trigger refresh for excluded endpoint /auth/register', async () => {
      let registerCalls = 0;
      let refreshCalls = 0;

      api.defaults.adapter = async (config) => {
        if (config.url === '/auth/register') {
          registerCalls++;
          const err = new Error('Unauthorized');
          err.response = {
            status: 401,
            data: { error: { code: 'TOKEN_MISSING', message: 'Unauthorized' } }
          };
          err.config = config;
          throw err;
        }

        if (config.url === '/auth/refresh') {
          refreshCalls++;
          return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
        }

        throw new Error(`Unexpected URL: ${config.url}`);
      };

      await expect(api.post('/auth/register', {})).rejects.toMatchObject({
        status: 401,
        code: 'TOKEN_MISSING'
      });

      expect(registerCalls).toBe(1);
      expect(refreshCalls).toBe(0);
    });

    it('should NOT trigger refresh for excluded endpoint /auth/logout', async () => {
      let logoutCalls = 0;
      let refreshCalls = 0;

      api.defaults.adapter = async (config) => {
        if (config.url === '/auth/logout') {
          logoutCalls++;
          const err = new Error('Unauthorized');
          err.response = {
            status: 401,
            data: { error: { code: 'TOKEN_MISSING', message: 'Unauthorized' } }
          };
          err.config = config;
          throw err;
        }

        if (config.url === '/auth/refresh') {
          refreshCalls++;
          return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
        }

        throw new Error(`Unexpected URL: ${config.url}`);
      };

      await expect(api.post('/auth/logout')).rejects.toMatchObject({
        status: 401,
        code: 'TOKEN_MISSING'
      });

      expect(logoutCalls).toBe(1);
      expect(refreshCalls).toBe(0);
    });

    it('should NOT recursively trigger refresh when /auth/refresh itself fails with 401', async () => {
      let refreshCalls = 0;

      api.defaults.adapter = async (config) => {
        if (config.url === '/auth/refresh') {
          refreshCalls++;
          const err = new Error('Refresh token expired');
          err.response = {
            status: 401,
            data: { error: { code: 'REFRESH_TOKEN_EXPIRED', message: 'Refresh token expired' } }
          };
          err.config = config;
          throw err;
        }

        throw new Error(`Unexpected URL: ${config.url}`);
      };

      await expect(api.post('/auth/refresh')).rejects.toMatchObject({
        status: 401,
        code: 'REFRESH_TOKEN_EXPIRED'
      });

      expect(refreshCalls).toBe(1); // Called only once, no infinite recursion
    });

    it('should reject all queued requests and dispatch auth:session-expired when refresh fails', async () => {
      let refreshCalls = 0;

      api.defaults.adapter = async (config) => {
        if (config.url === '/users/me') {
          const err = new Error('Token expired');
          err.response = {
            status: 401,
            data: { error: { code: 'TOKEN_EXPIRED', message: 'Token has expired' } }
          };
          err.config = config;
          throw err;
        }

        if (config.url === '/repos') {
          const err = new Error('Token missing');
          err.response = {
            status: 401,
            data: { error: { code: 'TOKEN_MISSING', message: 'Authentication required' } }
          };
          err.config = config;
          throw err;
        }

        if (config.url === '/auth/refresh') {
          refreshCalls++;
          const err = new Error('Refresh token invalid');
          err.response = {
            status: 401,
            data: { error: { code: 'TOKEN_REUSED', message: 'Token reuse detected' } }
          };
          err.config = config;
          throw err;
        }

        throw new Error(`Unexpected URL: ${config.url}`);
      };

      const req1 = api.get('/users/me');
      const req2 = api.get('/repos');

      await expect(req1).rejects.toMatchObject({
        status: 401,
        code: 'TOKEN_REUSED'
      });

      await expect(req2).rejects.toMatchObject({
        status: 401,
        code: 'TOKEN_REUSED'
      });

      expect(refreshCalls).toBe(1);
      expect(dispatchedEvents.some((e) => e.type === 'auth:session-expired')).toBe(true);
    });
  });
});

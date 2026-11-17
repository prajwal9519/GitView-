import axios from 'axios';

export const AUTH_EXCLUDED_ENDPOINTS = [
  '/auth/login',
  '/auth/register',
  '/auth/logout',
  '/auth/refresh'
];

export const isExcludedAuthEndpoint = (url) => {
  if (!url) return false;
  return AUTH_EXCLUDED_ENDPOINTS.some((endpoint) => url.includes(endpoint));
};

const api = axios.create({
  baseURL: import.meta.env?.VITE_API_BASE_URL || 'http://localhost:3000/api/v1',
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json'
  }
});

let isRefreshing = false;
let failedQueue = [];

const processQueue = (error) => {
  failedQueue.forEach((promise) => {
    if (error) {
      promise.reject(error);
    } else {
      promise.resolve();
    }
  });
  failedQueue = [];
};

export const formatApiError = (error) => {
  if (error && error.code && error.status !== undefined && error.raw) {
    return error;
  }
  const backendError = error?.response?.data?.error;
  return {
    code: backendError?.code || 'UNKNOWN_ERROR',
    message: backendError?.message || error?.message || 'An unexpected error occurred',
    details: backendError?.details || [],
    status: error?.response?.status,
    raw: error
  };
};

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error?.config;

    if (!originalRequest) {
      return Promise.reject(formatApiError(error));
    }

    const status = error.response?.status;
    const errorCode = error.response?.data?.error?.code;

    // Both TOKEN_EXPIRED and TOKEN_MISSING can be recovered with a valid refresh_token cookie
    const isAuthError =
      status === 401 && (errorCode === 'TOKEN_EXPIRED' || errorCode === 'TOKEN_MISSING');
    const isExcluded = isExcludedAuthEndpoint(originalRequest.url);

    if (isAuthError && !originalRequest._retry && !isExcluded) {
      originalRequest._retry = true;

      if (isRefreshing) {
        // Queue simultaneous failed requests while a refresh is in progress
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        })
          .then(() => api(originalRequest))
          .catch((err) => Promise.reject(err));
      }

      isRefreshing = true;

      try {
        await api.post('/auth/refresh');
        // Notify any waiting queued requests that refresh succeeded
        processQueue(null);
        // Retry the original request once
        return api(originalRequest);
      } catch (refreshError) {
        // Refresh failed (e.g. REFRESH_TOKEN_EXPIRED, TOKEN_REUSED, or missing refresh token)
        const formattedRefreshError = formatApiError(refreshError);
        processQueue(formattedRefreshError);

        // Notify app that session has expired
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
          window.dispatchEvent(
            new CustomEvent('auth:session-expired', { detail: formattedRefreshError })
          );
        }

        return Promise.reject(formattedRefreshError);
      } finally {
        isRefreshing = false;
      }
    }

    return Promise.reject(formatApiError(error));
  }
);

export { api };
export default api;

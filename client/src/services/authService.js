import api from './api';

export const authService = {
  /**
   * Fetch current authenticated user session
   * Endpoint: GET /users/me
   */
  async getCurrentUser() {
    const response = await api.get('/users/me');
    return response.data.data.user;
  },

  /**
   * Log in an existing user with email and password
   * Endpoint: POST /auth/login
   */
  async login({ email, password }) {
    const response = await api.post('/auth/login', { email, password });
    return response.data.data.user;
  },

  /**
   * Register a new user
   * Endpoint: POST /auth/register
   * Payload: { email, username, password }
   */
  async register({ email, username, password }) {
    const response = await api.post('/auth/register', { email, username, password });
    return response.data.data.user;
  },

  /**
   * Manually trigger refresh token rotation
   * Endpoint: POST /auth/refresh
   */
  async refresh() {
    const response = await api.post('/auth/refresh');
    return response.data.data.user;
  },

  /**
   * Log out user and revoke refresh token family
   * Endpoint: POST /auth/logout
   */
  async logout() {
    await api.post('/auth/logout');
    return { success: true };
  },

  /**
   * Helper URL for future GitHub OAuth integration
   */
  getGitHubAuthUrl() {
    return `${import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000/api/v1'}/auth/github`;
  }
};

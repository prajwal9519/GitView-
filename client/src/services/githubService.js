import api, { formatApiError } from './api';

export const githubService = {
  /**
   * Fetches public repositories for the authenticated user from GitHub
   * @param {number} page
   * @param {number} perPage
   */
  async getUserRepositories(page = 1, perPage = 30) {
    try {
      const res = await api.get('/github/repos', {
        params: { page, perPage },
      });
      return res.data;
    } catch (err) {
      throw formatApiError(err);
    }
  },
};

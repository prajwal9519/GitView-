import * as githubService from './github.service.js';

export async function listUserGitHubRepos(req, res, next) {
  try {
    const { page, perPage } = req.query;
    const result = await githubService.listUserGitHubRepositories(req.user.id, { page, perPage });
    res.json(result);
  } catch (err) {
    next(err);
  }
}

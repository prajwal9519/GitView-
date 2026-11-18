import { prisma } from '../../lib/prisma.js';
import { decryptToken } from '../../utils/encryption.js';
import { BadRequestError } from '../../utils/AppError.js';
import { fetchUserRepositories } from '../../integrations/githubClient.js';

export async function listUserGitHubRepositories(userId, { page = 1, perPage = 30 } = {}) {
  const oauth = await prisma.oAuthAccount.findUnique({
    where: {
      userId_provider: {
        userId,
        provider: 'GITHUB',
      },
    },
  });

  if (!oauth) {
    throw new BadRequestError('GITHUB_NOT_CONNECTED', 'No connected GitHub account found. Please connect your GitHub account.');
  }

  const token = decryptToken(oauth.accessTokenEnc);
  const githubRepos = await fetchUserRepositories(token, { page, perPage });

  // Public repositories only for MVP
  const publicRepos = Array.isArray(githubRepos)
    ? githubRepos.filter((repo) => !repo.private)
    : [];

  // Fetch already-imported repository IDs for this user
  const imported = await prisma.repository.findMany({
    where: { userId },
    select: { githubRepoId: true, id: true },
  });
  const importedMap = new Map(imported.map((r) => [r.githubRepoId, r.id]));

  const data = publicRepos.map((repo) => ({
    githubRepoId: String(repo.id),
    owner: repo.owner?.login || '',
    name: repo.name,
    fullName: repo.full_name,
    description: repo.description || null,
    htmlUrl: repo.html_url,
    defaultBranch: repo.default_branch || 'main',
    primaryLanguage: repo.language || null,
    updatedAt: repo.updated_at,
    isImported: importedMap.has(String(repo.id)),
    importedRepoId: importedMap.get(String(repo.id)) || null,
    stars: repo.stargazers_count ?? 0,
    forks: repo.forks_count ?? 0,
  }));

  return {
    data,
    meta: {
      page: Number(page),
      perPage: Number(perPage),
    },
  };
}

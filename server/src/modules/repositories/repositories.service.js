import { prisma } from '../../lib/prisma.js';
import { decryptToken } from '../../utils/encryption.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../utils/AppError.js';
import {
  parseGitHubRepoIdentifier,
  fetchRepository,
  fetchDefaultBranchCommit,
  fetchContents,
  validatePath,
  detectLanguage,
  isBinaryFile,
} from '../../integrations/githubClient.js';

const MAX_FILE_SIZE = 512 * 1024; // 512 KB

/**
 * Imports a public GitHub repository for the authenticated user.
 */
export async function importRepository(userId, repoInput) {
  const { owner, repo } = parseGitHubRepoIdentifier(repoInput);

  // Retrieve user's GitHub OAuth token if connected, for authenticated GitHub API calls
  const oauth = await prisma.oAuthAccount.findUnique({
    where: {
      userId_provider: {
        userId,
        provider: 'GITHUB',
      },
    },
  });
  const token = oauth ? decryptToken(oauth.accessTokenEnc) : null;

  // Fetch repository metadata from GitHub
  const githubData = await fetchRepository(token, owner, repo);

  // Validate public accessibility: private repositories rejected in MVP
  if (githubData.private) {
    throw new BadRequestError('PRIVATE_REPO_UNSUPPORTED', 'Private repositories are not supported in the MVP');
  }

  const githubRepoId = String(githubData.id);

  // Prevent duplicate imports for this user
  const existing = await prisma.repository.findUnique({
    where: {
      userId_githubRepoId: {
        userId,
        githubRepoId,
      },
    },
  });

  if (existing) {
    throw new ConflictError('Repository has already been imported');
  }

  // Fetch latest commit SHA of default branch
  const defaultBranch = githubData.default_branch || 'main';
  const latestCommitSha = await fetchDefaultBranchCommit(token, owner, repo, defaultBranch);

  const repository = await prisma.repository.create({
    data: {
      userId,
      githubRepoId,
      owner: githubData.owner?.login || owner,
      name: githubData.name,
      fullName: githubData.full_name,
      description: githubData.description || null,
      htmlUrl: githubData.html_url,
      defaultBranch,
      latestCommitSha,
      primaryLanguage: githubData.language || null,
      isPrivate: false,
    },
  });

  return repository;
}

/**
 * Lists all imported repositories for the authenticated user.
 */
export async function listRepositories(userId) {
  return await prisma.repository.findMany({
    where: { userId },
    orderBy: { importedAt: 'desc' },
  });
}

/**
 * Retrieves a single imported repository for the authenticated user.
 * Returns 404 if not found or belongs to another user.
 */
export async function getRepositoryById(userId, repositoryId) {
  const repository = await prisma.repository.findFirst({
    where: {
      id: repositoryId,
      userId,
    },
  });

  if (!repository) {
    throw new NotFoundError('Repository not found');
  }

  return repository;
}

/**
 * Deletes an imported repository for the authenticated user.
 * Returns 404 if not found or belongs to another user.
 */
export async function deleteRepository(userId, repositoryId) {
  const repository = await prisma.repository.findFirst({
    where: {
      id: repositoryId,
      userId,
    },
  });

  if (!repository) {
    throw new NotFoundError('Repository not found');
  }

  await prisma.repository.delete({
    where: { id: repository.id },
  });

  return { success: true, message: 'Repository removed successfully' };
}

/**
 * Retrieves directory tree for an imported repository at the specified path and ref.
 */
export async function getDirectoryTree(userId, repositoryId, { path = '', ref } = {}) {
  const repository = await prisma.repository.findFirst({
    where: {
      id: repositoryId,
      userId,
    },
  });

  if (!repository) {
    throw new NotFoundError('Repository not found');
  }

  const cleanPath = validatePath(path);

  // Retrieve user's decrypted GitHub token
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
  const gitRef = ref || repository.defaultBranch || 'main';

  const data = await fetchContents(token, repository.owner, repository.name, cleanPath, gitRef);

  if (!Array.isArray(data)) {
    throw new BadRequestError('NOT_A_DIRECTORY', 'The requested path is a file, not a directory');
  }

  // Sort directories first, then files alphabetically within each group
  const entries = data.map((item) => ({
    name: item.name,
    path: item.path,
    type: item.type === 'dir' ? 'dir' : 'file',
    size: item.size ?? 0,
    sha: item.sha,
  })).sort((a, b) => {
    if (a.type === 'dir' && b.type !== 'dir') return -1;
    if (a.type !== 'dir' && b.type === 'dir') return 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  return {
    path: cleanPath,
    ref: gitRef,
    entries,
  };
}

/**
 * Retrieves file content and metadata for an imported repository at the specified path and ref.
 */
export async function getFileContent(userId, repositoryId, { path, ref } = {}) {
  const repository = await prisma.repository.findFirst({
    where: {
      id: repositoryId,
      userId,
    },
  });

  if (!repository) {
    throw new NotFoundError('Repository not found');
  }

  if (!path) {
    throw new BadRequestError('INVALID_PATH', 'File path is required');
  }

  const cleanPath = validatePath(path);
  if (!cleanPath) {
    throw new BadRequestError('INVALID_PATH', 'File path cannot be empty or root');
  }

  // Retrieve user's decrypted GitHub token
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
  const gitRef = ref || repository.defaultBranch || 'main';

  const data = await fetchContents(token, repository.owner, repository.name, cleanPath, gitRef);

  if (Array.isArray(data) || data.type === 'dir') {
    throw new BadRequestError('NOT_A_FILE', 'The requested path is a directory, not a file');
  }

  // Large file handling: for files larger than 512 KB, return tooLarge: true without content
  if (data.size > MAX_FILE_SIZE) {
    return {
      path: data.path,
      name: data.name,
      size: data.size,
      sha: data.sha,
      tooLarge: true,
      isBinary: false,
      htmlUrl: data.html_url,
      content: null,
    };
  }

  const buffer = Buffer.from(data.content || '', 'base64');

  // Binary file handling: check binary extensions or null characters in content
  if (isBinaryFile(data.name, buffer)) {
    return {
      path: data.path,
      name: data.name,
      size: data.size,
      sha: data.sha,
      isBinary: true,
      tooLarge: false,
      htmlUrl: data.html_url,
      content: null,
    };
  }

  const content = buffer.toString('utf8');
  const language = detectLanguage(data.name);

  return {
    path: data.path,
    name: data.name,
    size: data.size,
    sha: data.sha,
    language,
    content,
    isBinary: false,
    tooLarge: false,
    htmlUrl: data.html_url,
  };
}

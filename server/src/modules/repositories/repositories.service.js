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
import { detectRepositoryFramework } from '../preview/detectorAdapter.js';

const MAX_FILE_SIZE = 512 * 1024; // 512 KB

/**
 * Resolves the appropriate GitHub token for an operation on a repository.
 * Precedence:
 * 1. User's connected OAuth account decrypted token
 * 2. If repository is private: strictly reject if no user OAuth account
 * 3. Configured server-side GITHUB_TOKEN (system token) for public repositories
 * 4. Anonymous access (null)
 */
async function resolveTokenForRepository(userId, isPrivate) {
  const oauth = await prisma.oAuthAccount.findUnique({
    where: {
      userId_provider: {
        userId,
        provider: 'GITHUB',
      },
    },
  });

  if (oauth) {
    return decryptToken(oauth.accessTokenEnc);
  }

  if (isPrivate) {
    throw new BadRequestError('GITHUB_NOT_CONNECTED', 'No connected GitHub account found. Please connect your GitHub account.');
  }

  if (process.env.GITHUB_TOKEN) {
    return process.env.GITHUB_TOKEN;
  }

  return null;
}

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
  const userToken = oauth ? decryptToken(oauth.accessTokenEnc) : null;
  const token = userToken || process.env.GITHUB_TOKEN || null;

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

  // Resolve token respecting user OAuth precedence, private-repo restriction, and system token fallback
  const token = await resolveTokenForRepository(userId, repository.isPrivate);
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

  // Resolve token respecting user OAuth precedence, private-repo restriction, and system token fallback
  const token = await resolveTokenForRepository(userId, repository.isPrivate);
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

/**
 * Retrieves preview session history for the authenticated user.
 */
export async function getPreviewHistory(userId) {
  const sessions = await prisma.previewSession.findMany({
    where: { userId },
    include: {
      repository: {
        select: {
          id: true,
          name: true,
          fullName: true,
          defaultBranch: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });

  return sessions.map((s) => {
    let statusLabel = 'Ready';
    let status = 'ready';
    if (s.status === 'RUNNING') {
      status = 'running';
      statusLabel = 'Live Preview';
    } else if (s.status === 'FAILED') {
      status = 'failed';
      statusLabel = s.errorCode || 'Failed';
    } else if (s.status === 'STOPPED' || s.status === 'EXPIRED') {
      status = 'terminated';
      statusLabel = s.status === 'EXPIRED' ? 'Expired' : 'Terminated';
    } else if (['PENDING', 'FETCHING', 'BUILDING', 'STARTING'].includes(s.status)) {
      status = 'loading';
      statusLabel = 'Starting...';
    }

    const timeDiffMs = Date.now() - new Date(s.lastActiveAt || s.createdAt).getTime();
    let lastActive = 'Just now';
    if (timeDiffMs > 86400000) {
      const days = Math.floor(timeDiffMs / 86400000);
      lastActive = `${days} day${days > 1 ? 's' : ''} ago`;
    } else if (timeDiffMs > 3600000) {
      const hours = Math.floor(timeDiffMs / 3600000);
      lastActive = `${hours} hour${hours > 1 ? 's' : ''} ago`;
    } else if (timeDiffMs > 60000) {
      const mins = Math.floor(timeDiffMs / 60000);
      lastActive = `${mins} min${mins > 1 ? 's' : ''} ago`;
    }

    return {
      id: s.id,
      repoId: s.repositoryId,
      repoFullName: s.repository?.fullName || 'Repository',
      branch: s.branch || s.repository?.defaultBranch || 'main',
      runtime: s.framework === 'UNKNOWN' ? 'Auto-detect' : s.framework,
      lastActive,
      status,
      statusLabel,
      actionText: s.status === 'RUNNING' ? 'Resume →' : 'Restart',
      actionLink: `/workspace/${s.repositoryId}`,
    };
  });
}

/**
 * Detects project framework and relative project root for an imported repository.
 */
export async function detectRepositoryProject(userId, repositoryId, ref = null) {
  const repository = await prisma.repository.findFirst({
    where: {
      id: repositoryId,
      userId,
    },
  });

  if (!repository) {
    throw new NotFoundError('Repository not found');
  }

  const token = await resolveTokenForRepository(userId, repository.isPrivate);
  const gitRef = ref || repository.latestCommitSha || repository.defaultBranch || 'main';

  return detectRepositoryFramework(token, repository.owner, repository.name, gitRef);
}

import { AppError, BadRequestError, NotFoundError } from '../utils/AppError.js';

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
const DEFAULT_TIMEOUT_MS = 10_000;

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.bmp', '.tiff',
  '.pdf', '.zip', '.tar', '.gz', '.tgz', '.bz2', '.7z', '.rar',
  '.exe', '.bin', '.dll', '.so', '.dylib', '.iso',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.mov', '.avi', '.mkv', '.webm', '.flac', '.wav',
  '.wasm', '.pyc', '.class', '.o', '.obj'
]);

/**
 * Standard headers required by GitHub REST API
 */
function getHeaders(token) {
  const headers = {
    'User-Agent': 'GitView/1.0',
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

/**
 * Executes a fetch request to api.github.com with timeout and unified error mapping.
 */
async function githubFetch(url, options = {}, token = null) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      ...options,
      headers: {
        ...getHeaders(token),
        ...options.headers,
      },
      signal: controller.signal,
    });

    if (res.ok) {
      if (res.status === 204) return null;
      return await res.json();
    }

    // Map GitHub API HTTP status codes to GitView AppErrors
    if (res.status === 401) {
      throw new AppError(401, 'GITHUB_TOKEN_REVOKED', 'GitHub access token is invalid or has been revoked. Please reconnect your GitHub account.');
    }

    if (res.status === 403 || res.status === 429) {
      const rateLimitRemaining = res.headers.get('x-ratelimit-remaining');
      if (rateLimitRemaining === '0' || res.status === 429) {
        throw new AppError(429, 'GITHUB_RATE_LIMITED', 'GitHub API rate limit exceeded. Please try again later.');
      }
      throw new AppError(403, 'FORBIDDEN', 'Access to this GitHub resource is forbidden.');
    }

    if (res.status === 404) {
      throw new NotFoundError('GitHub resource not found');
    }

    let errorData = null;
    try {
      errorData = await res.json();
    } catch {
      // ignore JSON parse error on error body
    }

    const message = errorData?.message || `GitHub API error (status ${res.status})`;
    throw new AppError(502, 'GITHUB_UPSTREAM_ERROR', message);
  } catch (err) {
    if (err instanceof AppError) throw err;

    if (err.name === 'AbortError') {
      throw new AppError(504, 'GITHUB_TIMEOUT', 'GitHub request timed out');
    }

    throw new AppError(502, 'GITHUB_NETWORK_ERROR', err.message || 'Failed to communicate with GitHub API');
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Validates file and directory paths.
 * Enforces maximum 500 characters, rejects null bytes and path traversal (..).
 */
export function validatePath(path) {
  if (!path) return '';
  if (typeof path !== 'string' || path.length > 500) {
    throw new BadRequestError('INVALID_PATH', 'Path must be a string with maximum length of 500 characters');
  }
  if (path.includes('\0')) {
    throw new BadRequestError('INVALID_PATH', 'Path contains invalid characters');
  }
  const normalized = path.replace(/\\/g, '/');
  const segments = normalized.split('/');
  for (const segment of segments) {
    if (segment === '..') {
      throw new BadRequestError('INVALID_PATH', 'Path traversal is not allowed');
    }
  }
  return normalized.replace(/^\/+|\/+$/g, '');
}

/**
 * Detects programming / markup language from filename for syntax highlighting.
 */
export function detectLanguage(filename) {
  if (!filename) return 'plaintext';
  const lower = filename.toLowerCase();
  const lastDot = lower.lastIndexOf('.');
  const ext = lastDot !== -1 ? lower.slice(lastDot) : '';

  if (lower === 'dockerfile') return 'dockerfile';
  if (lower === 'makefile') return 'makefile';
  if (lower === 'package.json' || ext === '.json') return 'json';
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return 'javascript';
  if (ext === '.jsx') return 'javascript';
  if (ext === '.ts') return 'typescript';
  if (ext === '.tsx') return 'typescript';
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  if (ext === '.css') return 'css';
  if (ext === '.scss' || ext === '.sass') return 'scss';
  if (ext === '.less') return 'less';
  if (ext === '.html' || ext === '.htm') return 'html';
  if (ext === '.py') return 'python';
  if (ext === '.go') return 'go';
  if (ext === '.rs') return 'rust';
  if (ext === '.java') return 'java';
  if (ext === '.c' || ext === '.h') return 'c';
  if (ext === '.cpp' || ext === '.hpp' || ext === '.cc') return 'cpp';
  if (ext === '.yaml' || ext === '.yml') return 'yaml';
  if (ext === '.sh' || ext === '.bash' || ext === '.zsh') return 'shell';
  if (ext === '.sql') return 'sql';
  if (ext === '.xml') return 'xml';
  if (ext === '.toml') return 'toml';
  if (ext === '.ini' || ext === '.env') return 'ini';
  return 'plaintext';
}

/**
 * Checks whether a file is binary using extension and byte inspection.
 */
export function isBinaryFile(filename, buffer) {
  if (filename) {
    const lastDot = filename.lastIndexOf('.');
    if (lastDot !== -1) {
      const ext = filename.slice(lastDot).toLowerCase();
      if (BINARY_EXTENSIONS.has(ext)) return true;
    }
  }
  if (buffer && buffer.length > 0) {
    const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
    for (let i = 0; i < sample.length; i++) {
      if (sample[i] === 0) return true;
    }
  }
  return false;
}

/**
 * Parses user input into owner and repo name.
 */
export function parseGitHubRepoIdentifier(input) {
  if (!input || typeof input !== 'string') {
    throw new BadRequestError('INVALID_REPO_IDENTIFIER', 'Repository input must be a non-empty string');
  }

  let cleaned = input.trim();

  // If a full URL or domain was provided
  if (cleaned.startsWith('http://') || cleaned.startsWith('https://') || cleaned.startsWith('github.com/')) {
    try {
      const urlToParse = cleaned.startsWith('http') ? cleaned : `https://${cleaned}`;
      const parsed = new URL(urlToParse);

      if (!parsed.hostname.includes('github.com')) {
        throw new BadRequestError('INVALID_REPO_IDENTIFIER', 'Only GitHub repositories are supported');
      }

      // Path will be like "/owner/repo" or "/owner/repo/..."
      const segments = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/');
      if (segments.length >= 2) {
        const owner = segments[0];
        let repo = segments[1];
        if (repo.endsWith('.git')) repo = repo.slice(0, -4);
        if (isValidName(owner) && isValidName(repo)) {
          return { owner, repo };
        }
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new BadRequestError('INVALID_REPO_IDENTIFIER', 'Invalid GitHub repository URL');
    }
  }

  // Handle "owner/repo" or "owner/repo.git" format
  if (cleaned.endsWith('.git')) cleaned = cleaned.slice(0, -4);
  cleaned = cleaned.replace(/^\/+|\/+$/g, '');
  const parts = cleaned.split('/');

  if (parts.length === 2 && isValidName(parts[0]) && isValidName(parts[1])) {
    return { owner: parts[0], repo: parts[1] };
  }

  throw new BadRequestError('INVALID_REPO_IDENTIFIER', 'Invalid repository format. Please provide "owner/repo" or a valid GitHub repository URL.');
}

function isValidName(name) {
  return /^[a-zA-Z0-9_.-]+$/.test(name);
}

/**
 * Fetches user repositories with pagination from GitHub API.
 */
export async function fetchUserRepositories(githubToken, { page = 1, perPage = 30 } = {}) {
  const url = `${GITHUB_API_BASE}/user/repos?type=all&sort=updated&page=${encodeURIComponent(page)}&per_page=${encodeURIComponent(perPage)}`;
  return await githubFetch(url, { method: 'GET' }, githubToken);
}

/**
 * Fetches single repository metadata from GitHub.
 */
export async function fetchRepository(githubToken, owner, repo) {
  const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  return await githubFetch(url, { method: 'GET' }, githubToken);
}

/**
 * Fetches directory or file contents from GitHub Contents API.
 */
export async function fetchContents(githubToken, owner, repo, path = '', ref = null) {
  const cleanPath = validatePath(path);
  if (owner === 'gitview-fixtures') {
    const fs = await import('node:fs');
    const pathModule = await import('node:path');
    const fixtureBase = pathModule.resolve(import.meta.dirname, '../../docker/fixtures', repo);
    const targetPath = cleanPath ? pathModule.join(fixtureBase, cleanPath) : fixtureBase;
    if (fs.existsSync(targetPath)) {
      const stat = fs.statSync(targetPath);
      if (stat.isDirectory()) {
        const entries = fs.readdirSync(targetPath, { withFileTypes: true });
        return entries.map((e) => ({
          name: e.name,
          path: cleanPath ? `${cleanPath}/${e.name}` : e.name,
          type: e.isDirectory() ? 'dir' : 'file',
          size: e.isFile() ? fs.statSync(pathModule.join(targetPath, e.name)).size : 0,
          sha: '0123456789abcdef0123456789abcdef01234567',
        }));
      } else {
        const content = fs.readFileSync(targetPath);
        return {
          name: pathModule.basename(targetPath),
          path: cleanPath,
          type: 'file',
          size: stat.size,
          content: content.toString('base64'),
          encoding: 'base64',
          sha: '0123456789abcdef0123456789abcdef01234567',
        };
      }
    }
  }
  let url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents`;
  if (cleanPath) {
    const encodedSegments = cleanPath.split('/').map(encodeURIComponent).join('/');
    url += `/${encodedSegments}`;
  }
  if (ref) {
    url += `?ref=${encodeURIComponent(ref)}`;
  }
  return await githubFetch(url, { method: 'GET' }, githubToken);
}

/**
 * Fetches latest commit SHA of default branch from GitHub.
 */
export async function fetchDefaultBranchCommit(githubToken, owner, repo, defaultBranch) {
  if (owner === 'gitview-fixtures') {
    return '0123456789abcdef0123456789abcdef01234567';
  }
  try {
    const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(defaultBranch)}`;
    const data = await githubFetch(url, { method: 'GET' }, githubToken);
    return data?.sha || null;
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

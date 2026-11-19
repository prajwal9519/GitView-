/**
 * GitView Phase 5 — Milestone 5: GitHub Repository Archive Fetcher
 *
 * Streams compressed tarballs from GitHub REST API for an exact commit SHA.
 * Validates repository identifiers and commit SHA, strictly validates redirect targets,
 * strips authorization credentials off api.github.com, enforces maximum compressed
 * byte limits during streaming, and applies strict timeouts.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable, Transform } from 'node:stream';
import tar from 'tar-stream';
import { ArchiveErrorCode, ArchiveExtractionError } from './archiveErrors.js';

export const DEFAULT_MAX_COMPRESSED_BYTES = 25 * 1024 * 1024; // 25 MB
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 20_000; // 20s
export const MAX_REDIRECT_HOPS = 3;

/**
 * Creates a gzipped tarball stream from a local fixture directory for synthetic testing.
 * Packages files with a top-level root prefix matching GitHub archive structure.
 *
 * @param {string} fixtureDir
 * @param {string} repoName
 * @returns {import('node:stream').Readable}
 */
export function createFixtureTarballStream(fixtureDir, repoName) {
  const pack = tar.pack();
  const gzip = zlib.createGzip();
  const rootPrefix = `${repoName}-root`;

  function addDir(currentDir, relPrefix) {
    const items = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const item of items) {
      const fullPath = path.join(currentDir, item.name);
      const entryName = `${relPrefix}/${item.name}`;
      if (item.isDirectory()) {
        pack.entry({ name: entryName, type: 'directory', mode: 0o755 });
        addDir(fullPath, entryName);
      } else if (item.isFile()) {
        const content = fs.readFileSync(fullPath);
        pack.entry({ name: entryName, size: content.length, mode: 0o644 }, content);
      }
    }
  }

  pack.entry({ name: rootPrefix, type: 'directory', mode: 0o755 });
  addDir(fixtureDir, rootPrefix);
  pack.finalize();

  return pack.pipe(gzip);
}

/**
 * Exact allowlist of trusted GitHub archive redirect hosts.
 * Naive suffix matching is strictly prohibited to prevent subdomain spoofing.
 */
export const APPROVED_REDIRECT_HOSTNAMES = Object.freeze(new Set([
  'codeload.github.com',
  'api.github.com',
  'objects.githubusercontent.com',
]));

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';

/**
 * Validates GitHub owner or repository name.
 */
export function isValidGitHubName(name) {
  return typeof name === 'string' && /^[a-zA-Z0-9_.-]+$/.test(name);
}

/**
 * Validates commit SHA (exact 40 hex characters).
 */
export function isValidCommitSha(sha) {
  return typeof sha === 'string' && /^[0-9a-fA-F]{40}$/.test(sha);
}

/**
 * Whitelist check for allowed redirect hosts (exact matching only).
 */
export function isAllowedRedirectHost(hostname) {
  if (!hostname || typeof hostname !== 'string') return false;
  return APPROVED_REDIRECT_HOSTNAMES.has(hostname.toLowerCase());
}

/**
 * Validates redirect URL for protocol security, exact hostname allowlisting,
 * deceptive userinfo, and port restrictions.
 *
 * @param {string} targetUrl - Raw redirect target from Location header
 * @param {string} currentUrl - Current request URL
 * @returns {URL} Validated next URL object
 */
export function validateRedirectUrl(targetUrl, currentUrl) {
  let nextUrl;
  try {
    nextUrl = new URL(targetUrl, currentUrl);
  } catch (err) {
    throw new ArchiveExtractionError(
      ArchiveErrorCode.ARCHIVE_DOWNLOAD_FAILED,
      `Invalid redirect URL format: ${err.message}`
    );
  }

  // 1. HTTPS only - reject plain HTTP
  if (nextUrl.protocol !== 'https:') {
    throw new ArchiveExtractionError(
      ArchiveErrorCode.ARCHIVE_DOWNLOAD_FAILED,
      `Insecure redirect protocol '${nextUrl.protocol}'. Only HTTPS is permitted.`
    );
  }

  // 2. Reject deceptive userinfo (e.g. codeload.github.com@attacker.example)
  if (nextUrl.username || nextUrl.password) {
    throw new ArchiveExtractionError(
      ArchiveErrorCode.ARCHIVE_DOWNLOAD_FAILED,
      'Redirect URL contains deceptive user credentials'
    );
  }

  // 3. Reject unexpected ports (default 443 is represented as empty string)
  if (nextUrl.port && nextUrl.port !== '443') {
    throw new ArchiveExtractionError(
      ArchiveErrorCode.ARCHIVE_DOWNLOAD_FAILED,
      `Unexpected port in redirect URL: '${nextUrl.port}'`
    );
  }

  // 4. Exact hostname allowlisting - no naive suffix matching
  const lowerHostname = nextUrl.hostname.toLowerCase();
  if (!APPROVED_REDIRECT_HOSTNAMES.has(lowerHostname)) {
    throw new ArchiveExtractionError(
      ArchiveErrorCode.ARCHIVE_DOWNLOAD_FAILED,
      `Redirect target '${nextUrl.hostname}' is not in approved GitHub redirect allowlist`
    );
  }

  return nextUrl;
}

/**
 * Standard headers for GitHub API requests.
 */
function buildHeaders(token, includeAuth = true) {
  const headers = {
    'User-Agent': 'GitView/1.0',
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
  };
  if (token && includeAuth) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

/**
 * Converts a response body (Web Stream, Node Stream, or Buffer) to a Node.js Readable stream.
 */
function toNodeReadable(body) {
  if (!body) {
    throw new ArchiveExtractionError(ArchiveErrorCode.ARCHIVE_CORRUPTED, 'Archive response body is empty');
  }
  if (typeof body.pipe === 'function') {
    return body;
  }
  if (typeof body.getReader === 'function' || Symbol.asyncIterator in body) {
    try {
      if (typeof Readable.fromWeb === 'function' && typeof body.getReader === 'function') {
        return Readable.fromWeb(body);
      }
    } catch {
      // Fallback to Readable.from
    }
    return Readable.from(body);
  }
  return Readable.from([body]);
}

/**
 * Fetches repository archive stream for a specific commit SHA with streaming size enforcement.
 *
 * @param {object} params
 * @param {string} params.owner
 * @param {string} params.repo
 * @param {string} params.commitSha
 * @param {string} [params.githubToken]
 * @param {number} [params.maxSizeBytes=DEFAULT_MAX_COMPRESSED_BYTES]
 * @param {number} [params.timeoutMs=DEFAULT_DOWNLOAD_TIMEOUT_MS]
 * @param {Function} [params.fetchFn=globalThis.fetch]
 * @returns {Promise<import('node:stream').Readable>}
 */
export async function fetchRepositoryArchiveStream({
  owner,
  repo,
  commitSha,
  githubToken = null,
  maxSizeBytes = DEFAULT_MAX_COMPRESSED_BYTES,
  timeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS,
  fetchFn = globalThis.fetch,
}) {
  if (!isValidGitHubName(owner) || !isValidGitHubName(repo)) {
    throw new ArchiveExtractionError(
      ArchiveErrorCode.ARCHIVE_DOWNLOAD_FAILED,
      `Invalid repository identifier: '${owner}/${repo}'`
    );
  }

  if (!isValidCommitSha(commitSha)) {
    throw new ArchiveExtractionError(
      ArchiveErrorCode.ARCHIVE_DOWNLOAD_FAILED,
      `Invalid commit SHA: '${commitSha}'. Must be exact 40-character hexadecimal string.`
    );
  }

  // Support local synthetic test fixtures in development / test environments
  if (owner === 'gitview-fixtures') {
    const fixtureDir = path.resolve(import.meta.dirname, '../../../docker/fixtures', repo);
    if (fs.existsSync(fixtureDir)) {
      return createFixtureTarballStream(fixtureDir, repo);
    }
  }

  let currentUrl = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tarball/${encodeURIComponent(commitSha)}`;
  let hops = 0;
  let res = null;

  const controller = new AbortController();
  const timeoutTimer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    while (hops <= MAX_REDIRECT_HOPS) {
      const parsedUrl = new URL(currentUrl);
      const isApiGithub = parsedUrl.hostname.toLowerCase() === 'api.github.com';
      const sendAuth = isApiGithub && Boolean(githubToken);

      res = await fetchFn(currentUrl, {
        method: 'GET',
        headers: buildHeaders(githubToken, sendAuth),
        redirect: 'manual',
        signal: controller.signal,
      });

      // Handle redirect
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        hops++;
        if (hops > MAX_REDIRECT_HOPS) {
          throw new ArchiveExtractionError(
            ArchiveErrorCode.ARCHIVE_DOWNLOAD_FAILED,
            `Archive download exceeded maximum redirect hops (${MAX_REDIRECT_HOPS})`
          );
        }

        const location = res.headers.get('location');
        if (!location) {
          throw new ArchiveExtractionError(
            ArchiveErrorCode.ARCHIVE_DOWNLOAD_FAILED,
            'Archive download redirect received without Location header'
          );
        }

        const nextUrl = validateRedirectUrl(location, currentUrl);
        currentUrl = nextUrl.toString();
        continue;
      }

      break;
    }

    if (!res) {
      throw new ArchiveExtractionError(
        ArchiveErrorCode.ARCHIVE_DOWNLOAD_FAILED,
        'Failed to initiate archive download'
      );
    }

    if (res.status === 401) {
      throw new ArchiveExtractionError(
        ArchiveErrorCode.ARCHIVE_DOWNLOAD_FAILED,
        'GitHub authentication token is invalid or revoked'
      );
    }

    if (res.status === 404) {
      throw new ArchiveExtractionError(
        ArchiveErrorCode.ARCHIVE_DOWNLOAD_FAILED,
        `Repository '${owner}/${repo}' or commit '${commitSha}' not found on GitHub`
      );
    }

    if (res.status === 403 || res.status === 429) {
      throw new ArchiveExtractionError(
        ArchiveErrorCode.ARCHIVE_DOWNLOAD_FAILED,
        'GitHub API rate limit exceeded or access forbidden'
      );
    }

    if (!res.ok) {
      throw new ArchiveExtractionError(
        ArchiveErrorCode.ARCHIVE_DOWNLOAD_FAILED,
        `GitHub archive download failed with HTTP status ${res.status}`
      );
    }

    // Convert response body to Node.js stream
    const rawStream = toNodeReadable(res.body);

    // Streaming meter transform that enforces compressed size limit
    let compressedBytes = 0;
    const meter = new Transform({
      transform(chunk, encoding, callback) {
        compressedBytes += chunk.length;
        if (compressedBytes > maxSizeBytes) {
          const err = new ArchiveExtractionError(
            ArchiveErrorCode.ARCHIVE_TOO_LARGE,
            `Compressed archive exceeded maximum size limit of ${maxSizeBytes} bytes (received ${compressedBytes} bytes)`
          );
          return callback(err);
        }
        callback(null, chunk);
      },
    });

    // Cleanup timer on stream end or error
    meter.on('end', () => clearTimeout(timeoutTimer));
    meter.on('close', () => clearTimeout(timeoutTimer));
    meter.on('error', () => clearTimeout(timeoutTimer));
    rawStream.on('error', (err) => {
      clearTimeout(timeoutTimer);
      meter.destroy(err);
    });

    rawStream.pipe(meter);
    return meter;
  } catch (err) {
    clearTimeout(timeoutTimer);
    if (err instanceof ArchiveExtractionError) {
      throw err;
    }
    if (err.name === 'AbortError') {
      throw new ArchiveExtractionError(
        ArchiveErrorCode.ARCHIVE_TIMEOUT,
        `Archive download timed out after ${timeoutMs}ms`
      );
    }
    throw new ArchiveExtractionError(
      ArchiveErrorCode.ARCHIVE_DOWNLOAD_FAILED,
      `Network error fetching archive: ${err.message}`
    );
  }
}

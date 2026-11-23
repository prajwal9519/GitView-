/**
 * GitView Phase 5 — Milestone 4: GitHub Metadata Detection Adapter
 *
 * Fetches only the required root-level repository items from GitHub API
 * and pipes them into the pure detectFramework function.
 * Does not download or inspect the entire repository.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fetchContents } from '../../integrations/githubClient.js';
import { detectFramework, normalizeProjectRoot, MAX_PACKAGE_JSON_SIZE_BYTES } from './detector.js';

// Directories ignored during nested project-root discovery
const IGNORED_NESTED_DIRS = new Set([
  '.git',
  '.github',
  '.vscode',
  '.idea',
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'release',
  'public',
  'assets',
  'static',
  'docs',
  'test',
  'tests',
  'coverage',
  '.vercel',
  '.turbo',
  '.next',
  '.nuxt',
  'temp',
  'tmp',
]);

/**
 * Passively detects framework support for a remote GitHub repository.
 * Inspects repository root first, then candidate nested directories if no root app exists.
 *
 * @param {string|null} githubToken User's GitHub OAuth token if available
 * @param {string} owner GitHub repository owner
 * @param {string} repo GitHub repository name
 * @param {string} [ref] Git commit SHA or branch ref
 * @returns {Promise<Object>} Detection profile response
 */
export async function detectRepositoryFramework(githubToken, owner, repo, ref = null) {
  const token = githubToken || process.env.GITHUB_TOKEN || null;

  // Support local synthetic test fixtures in development / test environments
  if (owner === 'gitview-fixtures') {
    const fixtureDir = path.resolve(import.meta.dirname, '../../../docker/fixtures', repo);
    if (fs.existsSync(fixtureDir)) {
      const inspectLocalDir = (dirPath, relDir = '') => {
        const items = fs.readdirSync(dirPath, { withFileTypes: true });
        const fileItems = items.map((d) => ({
          name: d.name,
          type: d.isDirectory() ? 'dir' : 'file',
          size: d.isFile() ? fs.statSync(path.join(dirPath, d.name)).size : 0,
        }));
        let packageJsonRaw = null;
        const pkgPath = path.join(dirPath, 'package.json');
        if (fs.existsSync(pkgPath)) {
          packageJsonRaw = fs.readFileSync(pkgPath, 'utf8');
        }
        return detectFramework({
          rootFiles: fileItems,
          packageJsonRaw,
          projectRoot: relDir,
        });
      };

      const rootRes = inspectLocalDir(fixtureDir, '');
      if (rootRes && rootRes.supported) return rootRes;

      const subdirs = fs.readdirSync(fixtureDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !IGNORED_NESTED_DIRS.has(d.name.toLowerCase()));
      for (const sub of subdirs) {
        const subRes = inspectLocalDir(path.join(fixtureDir, sub.name), sub.name);
        if (subRes && subRes.supported) return subRes;
      }
      return rootRes;
    }
  }

  // 1. Fetch root directory items only (never recursive)
  let rootItems;
  try {
    rootItems = await fetchContents(token, owner, repo, '', ref);
  } catch (err) {
    if (err.statusCode === 404) {
      return {
        supported: false,
        framework: 'UNSUPPORTED',
        reasonCode: 'EMPTY_REPOSITORY',
        message: 'The repository is empty or does not exist.',
      };
    }
    throw err;
  }

  if (!Array.isArray(rootItems) || rootItems.length === 0) {
    return {
      supported: false,
      framework: 'UNSUPPORTED',
      reasonCode: 'EMPTY_REPOSITORY',
      message: 'The repository is empty.',
    };
  }

  // Helper to evaluate a list of items within a directory as a candidate application root
  async function evaluateCandidateDirectory(dirPath, items) {
    if (!Array.isArray(items) || items.length === 0) return null;

    const hasIndexHtml = items.some(
      (item) => item.name && item.name.toLowerCase() === 'index.html' && item.type === 'file'
    );
    const pkgMeta = items.find(
      (item) => item.name && item.name.toLowerCase() === 'package.json' && item.type === 'file'
    );

    // If neither index.html nor package.json is present, it is not an application root
    if (!hasIndexHtml && !pkgMeta) {
      return null;
    }

    let packageJsonRaw = null;
    let packageJsonSize = pkgMeta?.size ?? null;

    if (pkgMeta) {
      if (packageJsonSize && packageJsonSize > MAX_PACKAGE_JSON_SIZE_BYTES) {
        return detectFramework({
          rootFiles: items,
          packageJsonRaw: null,
          packageJsonSize,
          projectRoot: dirPath,
        });
      }

      try {
        const pkgFilePath = dirPath ? path.posix.join(dirPath, 'package.json') : 'package.json';
        const fileData = await fetchContents(token, owner, repo, pkgFilePath, ref);
        if (fileData && fileData.content && fileData.encoding === 'base64') {
          packageJsonRaw = Buffer.from(fileData.content, 'base64').toString('utf8');
        } else if (fileData && typeof fileData === 'string') {
          packageJsonRaw = fileData;
        }
      } catch {
        packageJsonRaw = null;
      }
    }

    return detectFramework({
      rootFiles: items,
      packageJsonRaw,
      packageJsonSize,
      projectRoot: dirPath,
    });
  }

  // Step 1: Check root directory first (preserves 100% of existing behavior and zero extra calls for root projects)
  const rootResult = await evaluateCandidateDirectory('', rootItems);
  if (rootResult && rootResult.supported) {
    return rootResult;
  }

  // Step 2: If root is not supported, inspect reasonable candidate nested directories
  const candidateDirs = rootItems
    .filter(
      (item) =>
        item.type === 'dir' &&
        !IGNORED_NESTED_DIRS.has(item.name.toLowerCase()) &&
        !item.name.startsWith('.')
    )
    .slice(0, 8); // Bound to at most 8 candidate directories to prevent rate quota spikes

  const detectedCandidates = [];

  for (const dir of candidateDirs) {
    const dirName = dir.name;
    try {
      const nestedItems = await fetchContents(token, owner, repo, dirName, ref);
      if (Array.isArray(nestedItems) && nestedItems.length > 0) {
        const result = await evaluateCandidateDirectory(dirName, nestedItems);
        if (result && result.supported) {
          detectedCandidates.push({ dirName, result });
        }
      }
    } catch {
      // Ignore individual directory read failure
    }
  }

  // Exactly one candidate root detected
  if (detectedCandidates.length === 1) {
    return detectedCandidates[0].result;
  }

  // Multiple candidate roots detected — resolve deterministically or report ambiguity
  if (detectedCandidates.length > 1) {
    const PRIORITY_ORDER = ['client', 'frontend', 'app', 'web', 'ui', 'vite-project'];
    for (const priority of PRIORITY_ORDER) {
      const match = detectedCandidates.find((c) => c.dirName.toLowerCase() === priority);
      if (match) return match.result;
    }
    const candidateNames = detectedCandidates.map((c) => c.dirName).join(', ');
    return {
      supported: false,
      framework: 'UNSUPPORTED',
      reasonCode: 'MULTIPLE_PROJECT_ROOTS',
      message: `Multiple application roots detected (${candidateNames}). Ambiguous project structure.`,
    };
  }

  // No nested candidate succeeded; return root evaluation (or default MISSING_INDEX_HTML)
  return (
    rootResult || {
      supported: false,
      framework: 'UNSUPPORTED',
      reasonCode: 'MISSING_INDEX_HTML',
      message: 'Root index.html is required for live application preview.',
    }
  );
}

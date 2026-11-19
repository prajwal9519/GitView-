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
import { detectFramework, MAX_PACKAGE_JSON_SIZE_BYTES } from './detector.js';

/**
 * Passively detects framework support for a remote GitHub repository.
 *
 * @param {string|null} githubToken User's GitHub OAuth token if available
 * @param {string} owner GitHub repository owner
 * @param {string} repo GitHub repository name
 * @param {string} [ref] Git commit SHA or branch ref
 * @returns {Promise<Object>} Detection profile response
 */
export async function detectRepositoryFramework(githubToken, owner, repo, ref = null) {
  // Support local synthetic test fixtures in development / test environments
  if (owner === 'gitview-fixtures') {
    const fixtureDir = path.resolve(import.meta.dirname, '../../../docker/fixtures', repo);
    if (fs.existsSync(fixtureDir)) {
      const items = fs.readdirSync(fixtureDir, { withFileTypes: true });
      const rootItems = items.map((d) => ({
        name: d.name,
        type: d.isDirectory() ? 'dir' : 'file',
        size: d.isFile() ? fs.statSync(path.join(fixtureDir, d.name)).size : 0,
      }));
      let packageJsonRaw = null;
      const pkgPath = path.join(fixtureDir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        packageJsonRaw = fs.readFileSync(pkgPath, 'utf8');
      }
      return detectFramework({
        rootFiles: rootItems,
        packageJsonRaw,
      });
    }
  }

  // 1. Fetch root directory items only (never recursive)
  let rootItems;
  try {
    rootItems = await fetchContents(githubToken, owner, repo, '', ref);
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

  // 2. Identify if package.json is present at root
  const pkgMeta = rootItems.find(
    (item) => item.name && item.name.toLowerCase() === 'package.json' && item.type === 'file'
  );

  let packageJsonRaw = null;
  let packageJsonSize = null;

  if (pkgMeta) {
    packageJsonSize = pkgMeta.size ?? null;

    // Fast-path: If package.json is oversized (> 256 KB), do not fetch full content
    if (packageJsonSize && packageJsonSize > MAX_PACKAGE_JSON_SIZE_BYTES) {
      return detectFramework({
        rootFiles: rootItems,
        packageJsonRaw: null,
        packageJsonSize,
      });
    }

    // Fetch package.json content specifically
    try {
      const fileData = await fetchContents(githubToken, owner, repo, 'package.json', ref);
      if (fileData && fileData.content && fileData.encoding === 'base64') {
        packageJsonRaw = Buffer.from(fileData.content, 'base64').toString('utf8');
      } else if (fileData && typeof fileData === 'string') {
        packageJsonRaw = fileData;
      }
    } catch {
      packageJsonRaw = null;
    }
  }

  // 3. Evaluate passively with pure detection engine
  return detectFramework({
    rootFiles: rootItems,
    packageJsonRaw,
    packageJsonSize,
  });
}

/**
 * GitView Phase 5 — Milestone 5: Tar & Gzip Extraction Engine
 *
 * Implements pure streaming tar/gzip parsing, POSIX path normalization,
 * root prefix stripping, strict entry type validation, resource limits,
 * sensitive file exclusion, and clean rollback on failure.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import tar from 'tar-stream';
import { ArchiveErrorCode, ArchiveExtractionError } from './archiveErrors.js';

export const DEFAULT_MAX_ENTRIES = 2000;
export const DEFAULT_MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024; // 100 MB
export const DEFAULT_MAX_PATH_LENGTH = 500;

/**
 * Checks if a relative file path matches sensitive patterns.
 *
 * @param {string} relPath
 * @returns {boolean}
 */
export function isSensitiveFile(relPath) {
  const norm = relPath.replace(/\\/g, '/').toLowerCase();
  const segments = norm.split('/').filter(Boolean);
  const basename = segments[segments.length - 1];

  // .env or .env.*
  if (basename === '.env' || basename.startsWith('.env.')) {
    return true;
  }
  // .npmrc
  if (basename === '.npmrc') {
    return true;
  }
  // .git or .git/**
  if (segments.includes('.git')) {
    return true;
  }
  // node_modules or node_modules/**
  if (segments.includes('node_modules')) {
    return true;
  }
  return false;
}

/**
 * Validates entry path for security violations.
 *
 * @param {string} rawName
 * @param {string|null} expectedRootPrefix
 * @param {number} maxPathLength
 * @returns {{ valid: boolean, code?: string, message?: string, normalized?: string }}
 */
export function validateEntryPath(rawName, expectedRootPrefix, maxPathLength = DEFAULT_MAX_PATH_LENGTH) {
  if (!rawName || typeof rawName !== 'string') {
    return { valid: false, code: ArchiveErrorCode.ARCHIVE_PATH_TRAVERSAL, message: 'Entry path is missing or invalid' };
  }
  if (rawName.length > maxPathLength) {
    return { valid: false, code: ArchiveErrorCode.ARCHIVE_PATH_TRAVERSAL, message: `Entry path exceeds ${maxPathLength} characters` };
  }
  if (rawName.includes('\0')) {
    return { valid: false, code: ArchiveErrorCode.ARCHIVE_PATH_TRAVERSAL, message: 'Entry path contains null bytes' };
  }
  if (rawName.includes('\\')) {
    return { valid: false, code: ArchiveErrorCode.ARCHIVE_PATH_TRAVERSAL, message: 'Entry path contains backslashes' };
  }

  // URL-encoded traversal check
  if (/%2e/i.test(rawName) || /%2f/i.test(rawName)) {
    return { valid: false, code: ArchiveErrorCode.ARCHIVE_PATH_TRAVERSAL, message: 'Entry path contains URL-encoded characters' };
  }

  // Absolute path check
  if (rawName.startsWith('/')) {
    return { valid: false, code: ArchiveErrorCode.ARCHIVE_PATH_TRAVERSAL, message: 'Absolute paths are prohibited in archive' };
  }

  // Traversal segment check
  const segments = rawName.split('/');
  for (const seg of segments) {
    if (seg === '..') {
      return { valid: false, code: ArchiveErrorCode.ARCHIVE_PATH_TRAVERSAL, message: 'Path traversal (..) segment detected' };
    }
  }

  // Normalized path
  const normalized = path.posix.normalize(rawName).replace(/^\/+|\/+$/g, '');

  // Expected root prefix check
  if (expectedRootPrefix) {
    if (normalized !== expectedRootPrefix && !normalized.startsWith(expectedRootPrefix + '/')) {
      return {
        valid: false,
        code: ArchiveErrorCode.ARCHIVE_UNSAFE_ENTRY,
        message: `Archive entry '${rawName}' does not belong to expected root directory '${expectedRootPrefix}'`,
      };
    }
  }

  return { valid: true, normalized };
}

/**
 * Removes all files and directories in destDir on failure.
 *
 * @param {string} dir
 */
export function cleanWorkspace(dir) {
  try {
    if (fs.existsSync(dir)) {
      const items = fs.readdirSync(dir);
      for (const item of items) {
        const full = path.join(dir, item);
        try {
          fs.rmSync(full, { recursive: true, force: true });
        } catch {}
      }
    }
  } catch {}
}

/**
 * Streams, validates, and extracts a gzip-compressed tar archive into destDir.
 *
 * @param {import('stream').Readable} inputStream
 * @param {string} destDir Destination directory
 * @param {Object} [options]
 * @param {number} [options.maxEntries]
 * @param {number} [options.maxUncompressedBytes]
 * @param {number} [options.maxPathLength]
 * @returns {Promise<{ success: boolean, entryCount: number, totalBytes: number, excludedFiles: Array<string> }>}
 */
export async function extractArchiveStream(inputStream, destDir, options = {}) {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxUncompressedBytes = options.maxUncompressedBytes ?? DEFAULT_MAX_UNCOMPRESSED_BYTES;
  const maxPathLength = options.maxPathLength ?? DEFAULT_MAX_PATH_LENGTH;

  const destRoot = path.resolve(destDir);
  if (!fs.existsSync(destRoot)) {
    fs.mkdirSync(destRoot, { recursive: true, mode: 0o755 });
  }

  return new Promise((resolve, reject) => {
    let entryCount = 0;
    let totalBytes = 0;
    let expectedRootPrefix = null;
    const seenPaths = new Set();
    const excludedFiles = [];
    let isSettled = false;

    const extract = tar.extract();
    const gunzip = zlib.createGunzip();

    function fail(code, message) {
      if (isSettled) return;
      isSettled = true;

      try {
        inputStream.destroy();
      } catch {}
      try {
        gunzip.destroy();
      } catch {}
      try {
        extract.destroy();
      } catch {}

      cleanWorkspace(destRoot);
      reject(new ArchiveExtractionError(code, message));
    }

    gunzip.on('error', (err) => {
      fail(ArchiveErrorCode.ARCHIVE_CORRUPTED, `Gzip decompression error: ${err.message}`);
    });

    extract.on('error', (err) => {
      fail(ArchiveErrorCode.ARCHIVE_CORRUPTED, `Tar stream error: ${err.message}`);
    });

    inputStream.on('error', (err) => {
      fail(ArchiveErrorCode.ARCHIVE_DOWNLOAD_FAILED, `Archive input stream error: ${err.message}`);
    });

    extract.on('entry', (header, stream, next) => {
      if (isSettled) {
        stream.resume();
        return;
      }

      entryCount++;
      if (entryCount > maxEntries) {
        stream.resume();
        fail(ArchiveErrorCode.ARCHIVE_ENTRY_LIMIT_EXCEEDED, `Archive exceeds maximum entry limit of ${maxEntries}`);
        return;
      }

      // Determine expected root prefix from the first entry
      if (expectedRootPrefix === null) {
        const rawFirst = (header.name || '').replace(/\\/g, '/').replace(/^\/+/, '');
        const firstSegment = rawFirst.split('/')[0];
        if (!firstSegment || firstSegment === '..' || firstSegment === '.') {
          stream.resume();
          fail(ArchiveErrorCode.ARCHIVE_PATH_TRAVERSAL, 'Invalid archive root directory');
          return;
        }
        expectedRootPrefix = firstSegment;
      }

      // Path validation
      const pathCheck = validateEntryPath(header.name, expectedRootPrefix, maxPathLength);
      if (!pathCheck.valid) {
        stream.resume();
        fail(pathCheck.code, pathCheck.message);
        return;
      }

      const normalized = pathCheck.normalized;

      // If entry is the root directory itself, skip it
      if (normalized === expectedRootPrefix) {
        stream.resume();
        stream.on('end', next);
        return;
      }

      // Strip the single top-level root directory
      const strippedRelPath = normalized.slice(expectedRootPrefix.length + 1);
      if (!strippedRelPath) {
        stream.resume();
        stream.on('end', next);
        return;
      }

      // Containment check
      const targetPath = path.resolve(destRoot, strippedRelPath);
      if (!targetPath.startsWith(destRoot + path.sep)) {
        stream.resume();
        fail(ArchiveErrorCode.ARCHIVE_PATH_TRAVERSAL, `Path traversal attempt detected: '${strippedRelPath}'`);
        return;
      }

      // Entry type validation
      if (header.type === 'symlink' || header.type === 'link' || header.linkname) {
        stream.resume();
        fail(ArchiveErrorCode.ARCHIVE_UNSAFE_ENTRY, `Prohibited link entry: '${header.name}'`);
        return;
      }

      if (header.type !== 'file' && header.type !== 'directory') {
        stream.resume();
        fail(ArchiveErrorCode.ARCHIVE_UNSAFE_ENTRY, `Prohibited entry type '${header.type}': '${header.name}'`);
        return;
      }

      // Duplicate entry check
      if (seenPaths.has(targetPath)) {
        stream.resume();
        fail(ArchiveErrorCode.ARCHIVE_UNSAFE_ENTRY, `Duplicate archive entry detected: '${strippedRelPath}'`);
        return;
      }
      seenPaths.add(targetPath);

      // Sensitive file exclusion policy
      if (isSensitiveFile(strippedRelPath)) {
        excludedFiles.push(strippedRelPath);
        stream.on('data', (chunk) => {
          totalBytes += chunk.length;
          if (totalBytes > maxUncompressedBytes) {
            stream.resume();
            fail(
              ArchiveErrorCode.ARCHIVE_UNCOMPRESSED_LIMIT_EXCEEDED,
              `Uncompressed archive data exceeded maximum limit of ${maxUncompressedBytes} bytes`
            );
          }
        });
        stream.on('end', next);
        stream.resume();
        return;
      }

      // Handle directory entry
      if (header.type === 'directory') {
        try {
          if (fs.existsSync(targetPath) && !fs.statSync(targetPath).isDirectory()) {
            stream.resume();
            fail(ArchiveErrorCode.ARCHIVE_UNSAFE_ENTRY, `Directory entry '${strippedRelPath}' conflicts with existing file`);
            return;
          }
          fs.mkdirSync(targetPath, { recursive: true, mode: 0o755 });
        } catch (err) {
          stream.resume();
          fail(ArchiveErrorCode.ARCHIVE_EXTRACTION_FAILED, `Failed to create directory '${strippedRelPath}': ${err.message}`);
          return;
        }
        stream.resume();
        stream.on('end', next);
        return;
      }

      // Handle regular file entry
      if (header.type === 'file') {
        const parentDir = path.dirname(targetPath);
        try {
          if (fs.existsSync(parentDir) && !fs.statSync(parentDir).isDirectory()) {
            stream.resume();
            fail(ArchiveErrorCode.ARCHIVE_UNSAFE_ENTRY, `Parent path '${parentDir}' conflicts with existing file`);
            return;
          }
          fs.mkdirSync(parentDir, { recursive: true, mode: 0o755 });
        } catch (err) {
          stream.resume();
          fail(ArchiveErrorCode.ARCHIVE_EXTRACTION_FAILED, `Failed to create parent directory for '${strippedRelPath}': ${err.message}`);
          return;
        }

        if (fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory()) {
          stream.resume();
          fail(ArchiveErrorCode.ARCHIVE_UNSAFE_ENTRY, `File entry '${strippedRelPath}' conflicts with existing directory`);
          return;
        }

        let writeStream;
        try {
          writeStream = fs.createWriteStream(targetPath, { flags: 'wx', mode: 0o644 });
        } catch (err) {
          stream.resume();
          fail(ArchiveErrorCode.ARCHIVE_EXTRACTION_FAILED, `Failed to open file '${strippedRelPath}': ${err.message}`);
          return;
        }

        writeStream.on('error', (err) => {
          if (isSettled) return;
          stream.resume();
          fail(ArchiveErrorCode.ARCHIVE_EXTRACTION_FAILED, `Write error on '${strippedRelPath}': ${err.message}`);
        });

        stream.on('data', (chunk) => {
          totalBytes += chunk.length;
          if (totalBytes > maxUncompressedBytes) {
            writeStream.destroy();
            stream.resume();
            fail(
              ArchiveErrorCode.ARCHIVE_UNCOMPRESSED_LIMIT_EXCEEDED,
              `Uncompressed archive data exceeded maximum limit of ${maxUncompressedBytes} bytes`
            );
          }
        });

        stream.pipe(writeStream);

        writeStream.on('finish', () => {
          next();
        });
      }
    });

    extract.on('finish', () => {
      if (isSettled) return;
      if (entryCount === 0) {
        fail(ArchiveErrorCode.ARCHIVE_CORRUPTED, 'Archive contains zero valid entries');
        return;
      }

      isSettled = true;
      resolve({
        success: true,
        entryCount,
        totalBytes,
        excludedFiles,
      });
    });

    inputStream.pipe(gunzip).pipe(extract);
  });
}

export const extractTarGzStream = extractArchiveStream;


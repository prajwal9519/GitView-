#!/usr/bin/env node
/**
 * GitView Phase 5 — Milestone 5: Safe In-Container Archive Extractor
 *
 * Reads gzip-compressed tarball from process.stdin, applies strict security validation
 * on every entry, strips the single GitHub root directory, enforces streaming size/entry limits,
 * excludes sensitive files, and writes sanitized files to destination directory.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Deterministic dependency resolution for tar-stream:
// 1. Standard module resolution (checks /workspace/node_modules, /node_modules, etc.)
// 2. Global fallback to /usr/local/lib/node_modules/tar-stream
let tar;
try {
  tar = require('tar-stream');
} catch {
  try {
    tar = require('/usr/local/lib/node_modules/tar-stream');
  } catch (err) {
    const errorObj = {
      success: false,
      errorCode: 'ARCHIVE_EXTRACTION_FAILED',
      message: `Failed to resolve tar-stream dependency: ${err.message}`,
    };
    process.stderr.write(JSON.stringify(errorObj) + '\n');
    process.exit(1);
  }
}

const MAX_ENTRIES = 2000;
const MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024; // 100 MB
const MAX_PATH_LENGTH = 500;

// Parse --dest argument
let destRoot = '/workspace';
const destIdx = process.argv.indexOf('--dest');
if (destIdx !== -1 && process.argv[destIdx + 1]) {
  destRoot = process.argv[destIdx + 1];
}
destRoot = path.resolve(destRoot);

/**
 * Checks if a relative file path matches sensitive patterns.
 */
function isSensitiveFile(relPath) {
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
 */
function validateEntryPath(rawName, expectedRootPrefix) {
  if (!rawName || typeof rawName !== 'string') {
    return { valid: false, code: 'ARCHIVE_PATH_TRAVERSAL', message: 'Entry path is missing or invalid' };
  }
  if (rawName.length > MAX_PATH_LENGTH) {
    return { valid: false, code: 'ARCHIVE_PATH_TRAVERSAL', message: `Entry path exceeds ${MAX_PATH_LENGTH} characters` };
  }
  if (rawName.includes('\0')) {
    return { valid: false, code: 'ARCHIVE_PATH_TRAVERSAL', message: 'Entry path contains null bytes' };
  }
  if (rawName.includes('\\')) {
    return { valid: false, code: 'ARCHIVE_PATH_TRAVERSAL', message: 'Entry path contains backslashes' };
  }

  // URL-encoded traversal check
  if (/%2e/i.test(rawName) || /%2f/i.test(rawName)) {
    return { valid: false, code: 'ARCHIVE_PATH_TRAVERSAL', message: 'Entry path contains URL-encoded characters' };
  }

  // Absolute path check
  if (rawName.startsWith('/')) {
    return { valid: false, code: 'ARCHIVE_PATH_TRAVERSAL', message: 'Absolute paths are prohibited in archive' };
  }

  // Traversal segment check
  const segments = rawName.split('/');
  for (const seg of segments) {
    if (seg === '..' || seg === '.') {
      if (seg === '..') {
        return { valid: false, code: 'ARCHIVE_PATH_TRAVERSAL', message: 'Path traversal (..) segment detected' };
      }
    }
  }

  // Normalized path
  const normalized = path.posix.normalize(rawName).replace(/^\/+|\/+$/g, '');

  // Expected root prefix check
  if (expectedRootPrefix) {
    if (normalized !== expectedRootPrefix && !normalized.startsWith(expectedRootPrefix + '/')) {
      return {
        valid: false,
        code: 'ARCHIVE_UNSAFE_ENTRY',
        message: `Archive entry '${rawName}' does not belong to expected root directory '${expectedRootPrefix}'`,
      };
    }
  }

  return { valid: true, normalized };
}

/**
 * Removes all files and directories in destRoot on failure.
 */
function cleanWorkspace(dir) {
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

function exitWithError(code, message) {
  cleanWorkspace(destRoot);
  const errorObj = {
    success: false,
    errorCode: code,
    message: message || 'Archive extraction failed',
  };
  process.stderr.write(JSON.stringify(errorObj) + '\n');
  process.exit(1);
}

function runExtractor() {
  let entryCount = 0;
  let totalBytes = 0;
  let expectedRootPrefix = null;
  const seenPaths = new Set();
  const excludedFiles = [];
  let isFinished = false;

  const extract = tar.extract();
  const gunzip = zlib.createGunzip();

  gunzip.on('error', (err) => {
    if (isFinished) return;
    isFinished = true;
    exitWithError('ARCHIVE_CORRUPTED', `Gzip decompression error: ${err.message}`);
  });

  extract.on('error', (err) => {
    if (isFinished) return;
    isFinished = true;
    exitWithError('ARCHIVE_CORRUPTED', `Tar stream error: ${err.message}`);
  });

  process.stdin.on('error', (err) => {
    if (isFinished) return;
    isFinished = true;
    exitWithError('ARCHIVE_DOWNLOAD_FAILED', `Stdin stream error: ${err.message}`);
  });

  extract.on('entry', (header, stream, next) => {
    if (isFinished) {
      stream.resume();
      return;
    }

    entryCount++;
    if (entryCount > MAX_ENTRIES) {
      isFinished = true;
      stream.resume();
      exitWithError('ARCHIVE_ENTRY_LIMIT_EXCEEDED', `Archive exceeds maximum entry limit of ${MAX_ENTRIES}`);
      return;
    }

    // Determine expected root prefix from the first entry
    if (expectedRootPrefix === null) {
      const rawFirst = (header.name || '').replace(/\\/g, '/').replace(/^\/+/, '');
      const firstSegment = rawFirst.split('/')[0];
      if (!firstSegment || firstSegment === '..' || firstSegment === '.') {
        isFinished = true;
        stream.resume();
        exitWithError('ARCHIVE_PATH_TRAVERSAL', 'Invalid archive root directory');
        return;
      }
      expectedRootPrefix = firstSegment;
    }

    // Path validation
    const pathCheck = validateEntryPath(header.name, expectedRootPrefix);
    if (!pathCheck.valid) {
      isFinished = true;
      stream.resume();
      exitWithError(pathCheck.code, pathCheck.message);
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
      isFinished = true;
      stream.resume();
      exitWithError('ARCHIVE_PATH_TRAVERSAL', `Path traversal attempt detected: '${strippedRelPath}'`);
      return;
    }

    // Entry type validation
    if (header.type === 'symlink' || header.type === 'link' || header.linkname) {
      isFinished = true;
      stream.resume();
      exitWithError('ARCHIVE_UNSAFE_ENTRY', `Prohibited link entry: '${header.name}'`);
      return;
    }

    if (header.type !== 'file' && header.type !== 'directory') {
      isFinished = true;
      stream.resume();
      exitWithError('ARCHIVE_UNSAFE_ENTRY', `Prohibited entry type '${header.type}': '${header.name}'`);
      return;
    }

    // Duplicate entry check
    if (seenPaths.has(targetPath)) {
      isFinished = true;
      stream.resume();
      exitWithError('ARCHIVE_UNSAFE_ENTRY', `Duplicate archive entry detected: '${strippedRelPath}'`);
      return;
    }
    seenPaths.add(targetPath);

    // Sensitive file exclusion policy
    if (isSensitiveFile(strippedRelPath)) {
      excludedFiles.push(strippedRelPath);
      stream.on('data', (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_UNCOMPRESSED_BYTES) {
          isFinished = true;
          stream.resume();
          exitWithError(
            'ARCHIVE_UNCOMPRESSED_LIMIT_EXCEEDED',
            `Uncompressed archive data exceeded maximum limit of ${MAX_UNCOMPRESSED_BYTES} bytes`
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
          isFinished = true;
          stream.resume();
          exitWithError('ARCHIVE_UNSAFE_ENTRY', `Conflicting directory entry '${strippedRelPath}' conflicts with existing file`);
          return;
        }
        fs.mkdirSync(targetPath, { recursive: true, mode: 0o755 });
      } catch (err) {
        isFinished = true;
        stream.resume();
        exitWithError('ARCHIVE_EXTRACTION_FAILED', `Failed to create directory '${strippedRelPath}': ${err.message}`);
        return;
      }
      stream.resume();
      stream.on('end', next);
      return;
    }

    // Handle regular file entry
    if (header.type === 'file') {
      // Ensure parent directory exists
      const parentDir = path.dirname(targetPath);
      try {
        if (fs.existsSync(parentDir) && !fs.statSync(parentDir).isDirectory()) {
          isFinished = true;
          stream.resume();
          exitWithError('ARCHIVE_UNSAFE_ENTRY', `Parent directory '${parentDir}' is an existing file`);
          return;
        }
        fs.mkdirSync(parentDir, { recursive: true, mode: 0o755 });
      } catch (err) {
        isFinished = true;
        stream.resume();
        exitWithError('ARCHIVE_EXTRACTION_FAILED', `Failed to create parent directory for '${strippedRelPath}': ${err.message}`);
        return;
      }

      // Check if target already exists as a directory
      if (fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory()) {
        isFinished = true;
        stream.resume();
        exitWithError('ARCHIVE_UNSAFE_ENTRY', `File entry '${strippedRelPath}' conflicts with existing directory`);
        return;
      }

      let writeStream;
      try {
        writeStream = fs.createWriteStream(targetPath, { flags: 'wx', mode: 0o644 });
      } catch (err) {
        isFinished = true;
        stream.resume();
        exitWithError('ARCHIVE_EXTRACTION_FAILED', `Failed to open file '${strippedRelPath}': ${err.message}`);
        return;
      }

      writeStream.on('error', (err) => {
        if (isFinished) return;
        isFinished = true;
        stream.resume();
        exitWithError('ARCHIVE_EXTRACTION_FAILED', `Write error on '${strippedRelPath}': ${err.message}`);
      });

      stream.on('data', (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_UNCOMPRESSED_BYTES) {
          isFinished = true;
          writeStream.destroy();
          stream.resume();
          exitWithError(
            'ARCHIVE_UNCOMPRESSED_LIMIT_EXCEEDED',
            `Uncompressed archive data exceeded maximum limit of ${MAX_UNCOMPRESSED_BYTES} bytes`
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
    if (isFinished) return;
    if (entryCount === 0) {
      exitWithError('ARCHIVE_CORRUPTED', 'Archive contains zero valid entries');
      return;
    }

    const result = {
      success: true,
      entryCount,
      totalBytes,
      excludedFiles,
    };
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(0);
  });

  process.stdin.pipe(gunzip).pipe(extract);
}

runExtractor();

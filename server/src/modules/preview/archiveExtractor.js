/**
 * GitView Phase 5 — Milestone 5: Archive Extractor Orchestrator
 *
 * Spawns a disposable, unprivileged Docker container running gitview-preview-extractor:v1.0.0
 * with --network none, --read-only, --cap-drop ALL, and strict resource limits to extract
 * a streaming gzip tarball directly into a per-session named volume.
 */

import { spawn } from 'node:child_process';
import { ArchiveErrorCode, ArchiveExtractionError } from './archiveErrors.js';
import { extractTarGzStream } from './tarExtractorEngine.js';

export const DEFAULT_EXTRACTION_TIMEOUT_MS = 20_000;
export const DEFAULT_EXTRACTOR_IMAGE = 'gitview-preview-extractor:v1.0.0';

/**
 * Validates volume name against strict naming pattern.
 */
export function isValidVolumeName(name) {
  return typeof name === 'string' && /^gitview-(?:vol|ws)-[a-zA-Z0-9_-]+$/.test(name);
}

/**
 * Validates session ID.
 */
export function isValidSessionId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(id);
}

/**
 * Safely removes a per-session Docker named volume.
 *
 * @param {string} volumeName
 * @param {Function} [spawnFn=spawn]
 * @returns {Promise<boolean>}
 */
export async function removeSessionVolume(volumeName, spawnFn = spawn) {
  if (!isValidVolumeName(volumeName)) {
    throw new ArchiveExtractionError(
      ArchiveErrorCode.ARCHIVE_EXTRACTION_FAILED,
      `Invalid volume name for cleanup: '${volumeName}'`
    );
  }

  return new Promise((resolve) => {
    try {
      const child = spawnFn('docker', ['volume', 'rm', '-f', volumeName], {
        stdio: 'ignore',
        shell: false,
      });
      child.on('close', (code) => resolve(code === 0));
      child.on('error', () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}

/**
 * Extracts a tar.gz stream directly into a destination directory in-process.
 * Useful for local filesystem operations and synthetic unit testing.
 */
export async function extractArchiveToDirectory(archiveStream, destDir, options = {}) {
  return extractTarGzStream(archiveStream, destDir, options);
}

/**
 * Orchestrates a disposable Docker extractor container to extract an archive stream into a named volume.
 *
 * @param {import('node:stream').Readable} archiveStream - Readable stream of tar.gz data
 * @param {object} options
 * @param {string} options.sessionId - Preview session ID
 * @param {string} options.volumeName - Per-session named volume (gitview-vol-${sessionId})
 * @param {number} [options.timeoutMs=DEFAULT_EXTRACTION_TIMEOUT_MS] - Maximum execution time
 * @param {string} [options.dockerImage=DEFAULT_EXTRACTOR_IMAGE] - Docker extractor image
 * @param {boolean} [options.removeVolumeOnFailure=false] - Whether to delete volume on failure
 * @param {Function} [options.spawnFn=spawn] - Child process spawn function (for dependency injection/testing)
 * @returns {Promise<{ success: boolean, entryCount: number, totalBytes: number, excludedFiles: string[] }>}
 */
export function extractArchiveToVolume(archiveStream, {
  sessionId,
  volumeName,
  timeoutMs = DEFAULT_EXTRACTION_TIMEOUT_MS,
  dockerImage = DEFAULT_EXTRACTOR_IMAGE,
  removeVolumeOnFailure = false,
  spawnFn = spawn,
}) {
  return new Promise((resolve, reject) => {
    if (!isValidSessionId(sessionId)) {
      return reject(
        new ArchiveExtractionError(
          ArchiveErrorCode.ARCHIVE_EXTRACTION_FAILED,
          `Invalid session ID: '${sessionId}'`
        )
      );
    }

    if (!isValidVolumeName(volumeName)) {
      return reject(
        new ArchiveExtractionError(
          ArchiveErrorCode.ARCHIVE_EXTRACTION_FAILED,
          `Invalid volume name: '${volumeName}'. Must match 'gitview-vol-[a-zA-Z0-9_-]+'.`
        )
      );
    }

    const containerName = `gitview-extractor-${sessionId}-${Date.now()}`;
    const dockerArgs = [
      'run',
      '-i',
      '--rm',
      '--name', containerName,
      '--network', 'none',
      '--read-only',
      '--mount', `type=volume,source=${volumeName},destination=/workspace`,
      '--mount', `type=tmpfs,destination=/tmp,tmpfs-mode=1777`,
      '--cpus', '1.0',
      '--memory', '256m',
      '--pids-limit', '64',
      '--security-opt', 'no-new-privileges:true',
      '--cap-drop', 'ALL',
      dockerImage,
      'node', '/usr/local/bin/gitview-extract.js', '--dest', '/workspace',
    ];

    let child;
    try {
      child = spawnFn('docker', dockerArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      });
    } catch (err) {
      return reject(
        new ArchiveExtractionError(
          ArchiveErrorCode.ARCHIVE_EXTRACTION_FAILED,
          `Failed to spawn Docker extractor process: ${err.message}`
        )
      );
    }

    let stdoutData = '';
    let stderrData = '';
    let isSettled = false;
    let timer = null;

    function cleanupContainer() {
      try {
        const cleanupChild = spawn('docker', ['rm', '-f', containerName], {
          stdio: 'ignore',
          shell: false,
        });
        cleanupChild.unref();
      } catch {
        // Ignore errors during emergency cleanup
      }
    }

    function handleFailure(error) {
      if (isSettled) return;
      isSettled = true;
      if (timer) clearTimeout(timer);

      try {
        child.kill('SIGKILL');
      } catch {}

      cleanupContainer();

      if (removeVolumeOnFailure) {
        removeSessionVolume(volumeName, spawnFn).catch(() => {});
      }

      reject(error);
    }

    timer = setTimeout(() => {
      handleFailure(
        new ArchiveExtractionError(
          ArchiveErrorCode.ARCHIVE_TIMEOUT,
          `Archive extraction container timed out after ${timeoutMs}ms`
        )
      );
    }, timeoutMs);

    // Capture output
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutData += chunk;
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderrData += chunk;
    });

    // Pipe archive stream into container stdin
    child.stdin.on('error', (err) => {
      // EPIPE can occur if the container exits early on validation failure
      if (err.code !== 'EPIPE') {
        handleFailure(
          new ArchiveExtractionError(
            ArchiveErrorCode.ARCHIVE_EXTRACTION_FAILED,
            `Container stdin pipe error: ${err.message}`
          )
        );
      }
    });

    archiveStream.on('error', (err) => {
      handleFailure(
        err instanceof ArchiveExtractionError
          ? err
          : new ArchiveExtractionError(
              ArchiveErrorCode.ARCHIVE_DOWNLOAD_FAILED,
              `Archive stream error: ${err.message}`
            )
      );
    });

    archiveStream.pipe(child.stdin);

    child.on('error', (err) => {
      handleFailure(
        new ArchiveExtractionError(
          ArchiveErrorCode.ARCHIVE_EXTRACTION_FAILED,
          `Docker process execution error: ${err.message}`
        )
      );
    });

    child.on('close', (code, signal) => {
      if (isSettled) return;
      isSettled = true;
      if (timer) clearTimeout(timer);

      if (code === 0) {
        try {
          const result = JSON.parse(stdoutData.trim());
          return resolve(result);
        } catch (err) {
          return reject(
            new ArchiveExtractionError(
              ArchiveErrorCode.ARCHIVE_EXTRACTION_FAILED,
              `Failed to parse extractor output: ${err.message}. Raw output: ${stdoutData}`
            )
          );
        }
      }

      function failWith(err) {
        if (removeVolumeOnFailure) {
          removeSessionVolume(volumeName, spawnFn).catch(() => {});
        }
        return reject(err);
      }

      // If non-zero exit code, parse stderr for structured error JSON
      let parsedError = null;
      try {
        const lines = stderrData.trim().split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i].trim();
          if (line.startsWith('{') && line.endsWith('}')) {
            parsedError = JSON.parse(line);
            break;
          }
        }
      } catch {}

      if (parsedError && parsedError.errorCode) {
        const validCode = ArchiveErrorCode[parsedError.errorCode] || ArchiveErrorCode.ARCHIVE_EXTRACTION_FAILED;
        return failWith(new ArchiveExtractionError(validCode, parsedError.message));
      }

      if (signal === 'SIGKILL' || signal === 'SIGTERM') {
        return failWith(
          new ArchiveExtractionError(
            ArchiveErrorCode.ARCHIVE_TIMEOUT,
            `Extractor container was terminated by signal ${signal}`
          )
        );
      }

      return failWith(
        new ArchiveExtractionError(
          ArchiveErrorCode.ARCHIVE_EXTRACTION_FAILED,
          `Extractor container exited with code ${code}: ${stderrData.trim() || 'Unknown error'}`
        )
      );
    });
  });
}

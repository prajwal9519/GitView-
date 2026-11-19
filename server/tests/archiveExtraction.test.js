import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { Readable, PassThrough } from 'node:stream';
import tar from 'tar-stream';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  ArchiveErrorCode,
  ArchiveExtractionError,
  fetchRepositoryArchiveStream,
  extractArchiveToDirectory,
  extractArchiveToVolume,
  extractTarGzStream,
  isSensitiveFile,
  validateEntryPath,
  isValidVolumeName,
  isValidSessionId,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_UNCOMPRESSED_BYTES,
  DEFAULT_MAX_PATH_LENGTH,
} from '../src/modules/preview/index.js';

/**
 * Creates a synthetic gzipped tarball from a list of entry specifications.
 *
 * @param {Array<{ name: string, type?: string, content?: string|Buffer, mode?: number, linkname?: string }>} entries
 * @param {object} options
 * @param {string} [options.rootPrefix='user-repo-c0ffee1234567890/']
 * @param {boolean} [options.gzip=true]
 * @returns {Buffer}
 */
function createSyntheticArchiveBuffer(entries, { rootPrefix = 'user-repo-c0ffee1234567890/', gzip = true } = {}) {
  const pack = tar.pack();

  for (const entry of entries) {
    const entryName = rootPrefix ? `${rootPrefix}${entry.name}` : entry.name;
    const header = {
      name: entryName,
      type: entry.type || 'file',
      size: entry.content ? Buffer.byteLength(entry.content) : 0,
      mode: entry.mode || (entry.type === 'directory' ? 0o755 : 0o644),
      mtime: new Date(),
    };
    if (entry.linkname) {
      header.linkname = entry.linkname;
    }
    if (entry.type === 'directory') {
      pack.entry(header);
    } else {
      pack.entry(header, entry.content || Buffer.alloc(0));
    }
  }
  pack.finalize();

  const chunks = [];
  return new Promise((resolve, reject) => {
    let outStream = pack;
    if (gzip) {
      outStream = pack.pipe(zlib.createGzip());
    }
    outStream.on('data', (c) => chunks.push(c));
    outStream.on('end', () => resolve(Buffer.concat(chunks)));
    outStream.on('error', reject);
  });
}

describe('GitView Phase 5 — Milestone 5: Secure Archive Extraction Pipeline', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitview-archive-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
    vi.restoreAllMocks();
  });

  describe('Mandatory 25 Archive Extraction Adversarial Tests', () => {
    it('1. Valid static website archive', async () => {
      const buffer = await createSyntheticArchiveBuffer([
        { name: 'index.html', content: '<!DOCTYPE html><html><body><h1>GitView</h1></body></html>' },
        { name: 'styles.css', content: 'body { margin: 0; }' },
        { name: 'assets/logo.svg', content: '<svg></svg>' },
      ]);

      const result = await extractArchiveToDirectory(Readable.from([buffer]), tmpDir);

      expect(result.success).toBe(true);
      expect(result.entryCount).toBe(3);
      expect(result.excludedFiles).toEqual([]);
      expect(fs.existsSync(path.join(tmpDir, 'index.html'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'styles.css'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'assets/logo.svg'))).toBe(true);
      expect(fs.readFileSync(path.join(tmpDir, 'index.html'), 'utf8')).toContain('<h1>GitView</h1>');
    });

    it('2. Valid Vite React archive', async () => {
      const buffer = await createSyntheticArchiveBuffer([
        { name: 'package.json', content: JSON.stringify({ dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' }, devDependencies: { vite: '^6.0.0' } }) },
        { name: 'index.html', content: '<div id="root"></div><script type="module" src="/src/main.jsx"></script>' },
        { name: 'vite.config.js', content: 'export default {}' },
        { name: 'src/main.jsx', content: 'import React from "react";' },
        { name: 'src/App.jsx', content: 'export default function App() { return <h1>App</h1>; }' },
      ]);

      const result = await extractArchiveToDirectory(Readable.from([buffer]), tmpDir);

      expect(result.success).toBe(true);
      expect(result.entryCount).toBe(5);
      expect(fs.existsSync(path.join(tmpDir, 'package.json'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'src/App.jsx'))).toBe(true);
    });

    it('3. Valid Vite Vanilla archive', async () => {
      const buffer = await createSyntheticArchiveBuffer([
        { name: 'package.json', content: JSON.stringify({ devDependencies: { vite: '^6.0.0' } }) },
        { name: 'index.html', content: '<script type="module" src="/main.js"></script>' },
        { name: 'main.js', content: 'console.log("vanilla");' },
        { name: 'counter.js', content: 'export function setupCounter() {}' },
      ]);

      const result = await extractArchiveToDirectory(Readable.from([buffer]), tmpDir);

      expect(result.success).toBe(true);
      expect(result.entryCount).toBe(4);
      expect(fs.existsSync(path.join(tmpDir, 'main.js'))).toBe(true);
    });

    it('4. Path traversal ../../etc/shadow', async () => {
      const buffer = await createSyntheticArchiveBuffer([
        { name: '../../etc/shadow', content: 'root:x:0:0::' },
      ]);

      await expect(
        extractArchiveToDirectory(Readable.from([buffer]), tmpDir)
      ).rejects.toMatchObject({
        errorCode: ArchiveErrorCode.ARCHIVE_PATH_TRAVERSAL,
      });

      expect(fs.readdirSync(tmpDir)).toHaveLength(0);
    });

    it('5. URL-encoded traversal (%2e%2e/etc/passwd)', async () => {
      const buffer = await createSyntheticArchiveBuffer([
        { name: '%2e%2e/etc/passwd', content: 'root:x:0:0::' },
      ]);

      await expect(
        extractArchiveToDirectory(Readable.from([buffer]), tmpDir)
      ).rejects.toMatchObject({
        errorCode: ArchiveErrorCode.ARCHIVE_PATH_TRAVERSAL,
      });

      expect(fs.readdirSync(tmpDir)).toHaveLength(0);
    });

    it('6. Absolute paths (/etc/passwd)', async () => {
      const buffer = await createSyntheticArchiveBuffer([
        { name: '/etc/passwd', content: 'root:x:0:0::' },
      ], { rootPrefix: '' });

      await expect(
        extractArchiveToDirectory(Readable.from([buffer]), tmpDir)
      ).rejects.toMatchObject({
        errorCode: ArchiveErrorCode.ARCHIVE_PATH_TRAVERSAL,
      });

      expect(fs.readdirSync(tmpDir)).toHaveLength(0);
    });

    it('7. Symlink targeting /etc', async () => {
      const buffer = await createSyntheticArchiveBuffer([
        { name: 'evil-link', type: 'symlink', linkname: '/etc' },
      ]);

      await expect(
        extractArchiveToDirectory(Readable.from([buffer]), tmpDir)
      ).rejects.toMatchObject({
        errorCode: ArchiveErrorCode.ARCHIVE_UNSAFE_ENTRY,
      });

      expect(fs.readdirSync(tmpDir)).toHaveLength(0);
    });

    it('8. Symlink targeting another workspace file', async () => {
      const buffer = await createSyntheticArchiveBuffer([
        { name: 'index.html', content: '<h1>Safe</h1>' },
        { name: 'link-to-index.html', type: 'symlink', linkname: 'index.html' },
      ]);

      await expect(
        extractArchiveToDirectory(Readable.from([buffer]), tmpDir)
      ).rejects.toMatchObject({
        errorCode: ArchiveErrorCode.ARCHIVE_UNSAFE_ENTRY,
      });

      expect(fs.readdirSync(tmpDir)).toHaveLength(0);
    });

    it('9. Hardlink entries', async () => {
      const buffer = await createSyntheticArchiveBuffer([
        { name: 'fileA.txt', content: 'A' },
        { name: 'hardlink.txt', type: 'link', linkname: 'fileA.txt' },
      ]);

      await expect(
        extractArchiveToDirectory(Readable.from([buffer]), tmpDir)
      ).rejects.toMatchObject({
        errorCode: ArchiveErrorCode.ARCHIVE_UNSAFE_ENTRY,
      });

      expect(fs.readdirSync(tmpDir)).toHaveLength(0);
    });

    it('10. Character / block devices', async () => {
      const buffer = await createSyntheticArchiveBuffer([
        { name: 'my-char-device', type: 'character-device' },
      ]);

      await expect(
        extractArchiveToDirectory(Readable.from([buffer]), tmpDir)
      ).rejects.toMatchObject({
        errorCode: ArchiveErrorCode.ARCHIVE_UNSAFE_ENTRY,
      });

      expect(fs.readdirSync(tmpDir)).toHaveLength(0);
    });

    it('11. FIFO entries', async () => {
      const buffer = await createSyntheticArchiveBuffer([
        { name: 'my-fifo-pipe', type: 'fifo' },
      ]);

      await expect(
        extractArchiveToDirectory(Readable.from([buffer]), tmpDir)
      ).rejects.toMatchObject({
        errorCode: ArchiveErrorCode.ARCHIVE_UNSAFE_ENTRY,
      });

      expect(fs.readdirSync(tmpDir)).toHaveLength(0);
    });

    it('12. Gzip decompression bomb', async () => {
      // Create a highly compressible 2 MB chunk of repeated text, configured with a low limit (e.g. 100 KB)
      const bigContent = Buffer.alloc(2 * 1024 * 1024, 'A');
      const buffer = await createSyntheticArchiveBuffer([
        { name: 'bomb.txt', content: bigContent },
      ]);

      await expect(
        extractTarGzStream(Readable.from([buffer]), tmpDir, {
          maxUncompressedBytes: 100 * 1024, // 100 KB limit for test
        })
      ).rejects.toMatchObject({
        errorCode: ArchiveErrorCode.ARCHIVE_UNCOMPRESSED_LIMIT_EXCEEDED,
      });

      expect(fs.readdirSync(tmpDir)).toHaveLength(0);
    });

    it('13. Compressed archive exceeding 25 MB', async () => {
      // Mock fetch providing a stream that produces > 25 MB of chunks
      const largeChunk = Buffer.alloc(10 * 1024 * 1024, 0x1f); // 10 MB chunk
      const mockStream = new Readable({
        read() {
          this.push(largeChunk);
          this.push(largeChunk);
          this.push(largeChunk); // 30 MB total
          this.push(null);
        },
      });

      const mockFetch = vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        body: mockStream,
        headers: new Headers(),
      });

      const stream = await fetchRepositoryArchiveStream({
        owner: 'testowner',
        repo: 'testrepo',
        commitSha: 'a'.repeat(40),
        fetchFn: mockFetch,
        maxSizeBytes: 25 * 1024 * 1024,
      });

      const consumeStream = async () => {
        for await (const _ of stream) {
          // consuming
        }
      };

      await expect(consumeStream()).rejects.toMatchObject({
        errorCode: ArchiveErrorCode.ARCHIVE_TOO_LARGE,
      });
    });

    it('14. Uncompressed output exceeding 100 MB', async () => {
      const buffer = await createSyntheticArchiveBuffer([
        { name: 'big-data.bin', content: Buffer.alloc(1024 * 1024, 0x01) },
      ]);

      await expect(
        extractTarGzStream(Readable.from([buffer]), tmpDir, {
          maxUncompressedBytes: 512 * 1024, // 512 KB limit to trigger error
        })
      ).rejects.toMatchObject({
        errorCode: ArchiveErrorCode.ARCHIVE_UNCOMPRESSED_LIMIT_EXCEEDED,
      });

      expect(fs.readdirSync(tmpDir)).toHaveLength(0);
    });

    it('15. More than 2,000 entries', async () => {
      const entries = [];
      for (let i = 0; i < 25; i++) {
        entries.push({ name: `file_${i}.txt`, content: `content_${i}` });
      }
      const buffer = await createSyntheticArchiveBuffer(entries);

      await expect(
        extractTarGzStream(Readable.from([buffer]), tmpDir, {
          maxEntries: 20, // Low limit to test enforcement
        })
      ).rejects.toMatchObject({
        errorCode: ArchiveErrorCode.ARCHIVE_ENTRY_LIMIT_EXCEEDED,
      });

      expect(fs.readdirSync(tmpDir)).toHaveLength(0);
    });

    it('16. Excessively long archive path (> 500 chars)', async () => {
      const longName = 'sub/' + 'a'.repeat(510) + '.txt';
      const buffer = await createSyntheticArchiveBuffer([
        { name: longName, content: 'too long' },
      ]);

      await expect(
        extractArchiveToDirectory(Readable.from([buffer]), tmpDir)
      ).rejects.toMatchObject({
        errorCode: ArchiveErrorCode.ARCHIVE_PATH_TRAVERSAL,
      });

      expect(fs.readdirSync(tmpDir)).toHaveLength(0);
    });

    it('17. Duplicate archive entries', async () => {
      const buffer = await createSyntheticArchiveBuffer([
        { name: 'duplicate.txt', content: 'first' },
        { name: 'duplicate.txt', content: 'second' },
      ]);

      await expect(
        extractArchiveToDirectory(Readable.from([buffer]), tmpDir)
      ).rejects.toMatchObject({
        errorCode: ArchiveErrorCode.ARCHIVE_UNSAFE_ENTRY,
      });

      expect(fs.readdirSync(tmpDir)).toHaveLength(0);
    });

    it('18. Conflicting file/directory entries', async () => {
      const buffer = await createSyntheticArchiveBuffer([
        { name: 'data', content: 'I am a file' },
        { name: 'data/nested.txt', content: 'I am nested inside a file' },
      ]);

      await expect(
        extractArchiveToDirectory(Readable.from([buffer]), tmpDir)
      ).rejects.toMatchObject({
        errorCode: ArchiveErrorCode.ARCHIVE_UNSAFE_ENTRY,
      });

      expect(fs.readdirSync(tmpDir)).toHaveLength(0);
    });

    it('19. Corrupted gzip', async () => {
      const garbage = Buffer.from('This is not a gzip compressed tar archive at all');

      await expect(
        extractArchiveToDirectory(Readable.from([garbage]), tmpDir)
      ).rejects.toMatchObject({
        errorCode: ArchiveErrorCode.ARCHIVE_CORRUPTED,
      });

      expect(fs.readdirSync(tmpDir)).toHaveLength(0);
    });

    it('20. Truncated tar archive', async () => {
      const validBuffer = await createSyntheticArchiveBuffer([
        { name: 'file1.txt', content: 'Hello World' },
        { name: 'file2.txt', content: 'Truncated mid tar' },
      ]);

      // Cut archive in half
      const truncated = validBuffer.subarray(0, Math.floor(validBuffer.length / 2));

      await expect(
        extractArchiveToDirectory(Readable.from([truncated]), tmpDir)
      ).rejects.toMatchObject({
        errorCode: ArchiveErrorCode.ARCHIVE_CORRUPTED,
      });

      expect(fs.readdirSync(tmpDir)).toHaveLength(0);
    });

    it('21. Incorrect archive root directory', async () => {
      const buffer = await createSyntheticArchiveBuffer([
        { name: 'root-A/index.html', content: 'A' },
        { name: 'root-B/index.html', content: 'B' },
      ], { rootPrefix: '' });

      await expect(
        extractArchiveToDirectory(Readable.from([buffer]), tmpDir)
      ).rejects.toMatchObject({
        errorCode: ArchiveErrorCode.ARCHIVE_UNSAFE_ENTRY,
      });

      expect(fs.readdirSync(tmpDir)).toHaveLength(0);
    });

    it('22. Extraction timeout', async () => {
      // Mock child process that does not exit before timeout
      const fakeChild = {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(),
        on: vi.fn(),
      };

      const mockSpawn = vi.fn().mockReturnValue(fakeChild);

      const promise = extractArchiveToVolume(new PassThrough(), {
        sessionId: 'test-session-timeout',
        volumeName: 'gitview-vol-test-session-timeout',
        timeoutMs: 50, // fast timeout
        spawnFn: mockSpawn,
      });

      await expect(promise).rejects.toMatchObject({
        errorCode: ArchiveErrorCode.ARCHIVE_TIMEOUT,
      });
      expect(fakeChild.kill).toHaveBeenCalledWith('SIGKILL');
    });

    it('23. Docker extractor process interruption', async () => {
      const fakeChild = {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(),
        on: vi.fn((event, handler) => {
          if (event === 'close') {
            setTimeout(() => handler(137, 'SIGKILL'), 10);
          }
        }),
      };

      const mockSpawn = vi.fn().mockReturnValue(fakeChild);

      const promise = extractArchiveToVolume(new PassThrough(), {
        sessionId: 'test-session-sigkill',
        volumeName: 'gitview-vol-test-session-sigkill',
        timeoutMs: 5000,
        spawnFn: mockSpawn,
      });

      await expect(promise).rejects.toMatchObject({
        errorCode: ArchiveErrorCode.ARCHIVE_TIMEOUT,
      });
    });

    it('24. Cleanup after partial failure', async () => {
      // Create an archive with 3 valid files followed by an unsafe symlink
      const buffer = await createSyntheticArchiveBuffer([
        { name: 'valid1.txt', content: 'valid1' },
        { name: 'valid2.txt', content: 'valid2' },
        { name: 'valid3.txt', content: 'valid3' },
        { name: 'bad-symlink', type: 'symlink', linkname: '/etc/passwd' },
      ]);

      await expect(
        extractArchiveToDirectory(Readable.from([buffer]), tmpDir)
      ).rejects.toMatchObject({
        errorCode: ArchiveErrorCode.ARCHIVE_UNSAFE_ENTRY,
      });

      // Verify all previously created files were rolled back and deleted
      expect(fs.readdirSync(tmpDir)).toHaveLength(0);
      expect(fs.existsSync(path.join(tmpDir, 'valid1.txt'))).toBe(false);
      expect(fs.existsSync(path.join(tmpDir, 'valid2.txt'))).toBe(false);
    });

    it('25. Sensitive file exclusion policy (.env, .npmrc, .git, node_modules)', async () => {
      const buffer = await createSyntheticArchiveBuffer([
        { name: 'index.html', content: '<h1>Public</h1>' },
        { name: '.env', content: 'SECRET_KEY=supersecret' },
        { name: '.env.local', content: 'LOCAL_SECRET=12345' },
        { name: '.npmrc', content: '//registry.npmjs.org/:_authToken=npm_secret' },
        { name: '.git/config', content: '[core]\nrepositoryformatversion = 0' },
        { name: 'node_modules/my-lib/index.js', content: 'module.exports = {};' },
      ]);

      const result = await extractArchiveToDirectory(Readable.from([buffer]), tmpDir);

      expect(result.success).toBe(true);
      expect(result.entryCount).toBe(6);
      expect(result.excludedFiles).toEqual(
        expect.arrayContaining([
          '.env',
          '.env.local',
          '.npmrc',
          '.git/config',
          'node_modules/my-lib/index.js',
        ])
      );

      // Verify only index.html is on disk
      expect(fs.existsSync(path.join(tmpDir, 'index.html'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, '.env'))).toBe(false);
      expect(fs.existsSync(path.join(tmpDir, '.env.local'))).toBe(false);
      expect(fs.existsSync(path.join(tmpDir, '.npmrc'))).toBe(false);
      expect(fs.existsSync(path.join(tmpDir, '.git'))).toBe(false);
      expect(fs.existsSync(path.join(tmpDir, 'node_modules'))).toBe(false);
    });
  });

  describe('Archive Fetcher Unit Tests', () => {
    const validSha = 'd'.repeat(40);

    it('rejects invalid owner or repo', async () => {
      await expect(
        fetchRepositoryArchiveStream({
          owner: 'bad owner!',
          repo: 'repo',
          commitSha: validSha,
        })
      ).rejects.toMatchObject({
        errorCode: ArchiveErrorCode.ARCHIVE_DOWNLOAD_FAILED,
      });
    });

    it('rejects invalid commit SHA format', async () => {
      await expect(
        fetchRepositoryArchiveStream({
          owner: 'validowner',
          repo: 'validrepo',
          commitSha: 'not-a-40-char-hex-sha',
        })
      ).rejects.toMatchObject({
        errorCode: ArchiveErrorCode.ARCHIVE_DOWNLOAD_FAILED,
      });
    });

    it('follows HTTP 302 redirect to codeload.github.com and strips Authorization header', async () => {
      const calls = [];
      const mockFetch = vi.fn().mockImplementation(async (url, opts) => {
        calls.push({ url, headers: opts.headers });
        if (calls.length === 1) {
          return {
            status: 302,
            headers: new Headers({
              Location: 'https://codeload.github.com/owner/repo/legacy.tar.gz/sha',
            }),
          };
        }
        return {
          status: 200,
          ok: true,
          body: Readable.from([Buffer.from('archive-bytes')]),
          headers: new Headers(),
        };
      });

      const stream = await fetchRepositoryArchiveStream({
        owner: 'owner',
        repo: 'repo',
        commitSha: validSha,
        githubToken: 'gho_secret_token_12345',
        fetchFn: mockFetch,
      });

      expect(stream).toBeDefined();
      expect(calls).toHaveLength(2);
      // Initial call to api.github.com has Authorization header
      expect(calls[0].headers.Authorization).toBe('Bearer gho_secret_token_12345');
      // Redirected call to codeload.github.com MUST NOT have Authorization header
      expect(calls[1].headers.Authorization).toBeUndefined();
    });

    it('rejects redirect to untrusted external host', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        status: 302,
        headers: new Headers({
          Location: 'https://malicious-site.com/evil.tar.gz',
        }),
      });

      await expect(
        fetchRepositoryArchiveStream({
          owner: 'owner',
          repo: 'repo',
          commitSha: validSha,
          fetchFn: mockFetch,
        })
      ).rejects.toMatchObject({
        errorCode: ArchiveErrorCode.ARCHIVE_DOWNLOAD_FAILED,
      });
    });

    it('rejects if redirect hop count exceeds maximum (3 hops)', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        status: 302,
        headers: new Headers({
          Location: 'https://codeload.github.com/loop',
        }),
      });

      await expect(
        fetchRepositoryArchiveStream({
          owner: 'owner',
          repo: 'repo',
          commitSha: validSha,
          fetchFn: mockFetch,
        })
      ).rejects.toMatchObject({
        errorCode: ArchiveErrorCode.ARCHIVE_DOWNLOAD_FAILED,
      });
    });

    it('handles GitHub 401 unauthorized', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        status: 401,
        ok: false,
        headers: new Headers(),
      });

      await expect(
        fetchRepositoryArchiveStream({
          owner: 'owner',
          repo: 'repo',
          commitSha: validSha,
          fetchFn: mockFetch,
        })
      ).rejects.toMatchObject({
        errorCode: ArchiveErrorCode.ARCHIVE_DOWNLOAD_FAILED,
      });
    });

    it('handles GitHub 404 not found', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        status: 404,
        ok: false,
        headers: new Headers(),
      });

      await expect(
        fetchRepositoryArchiveStream({
          owner: 'owner',
          repo: 'repo',
          commitSha: validSha,
          fetchFn: mockFetch,
        })
      ).rejects.toMatchObject({
        errorCode: ArchiveErrorCode.ARCHIVE_DOWNLOAD_FAILED,
      });
    });

    describe('Milestone 5.1: Targeted Redirect Security Negative Tests', () => {
      const negativeHosts = [
        { label: 'github.com.attacker.example', url: 'https://github.com.attacker.example/archive.tar.gz' },
        { label: 'evilgithub.com', url: 'https://evilgithub.com/archive.tar.gz' },
        { label: 'codeload.github.com.attacker.example', url: 'https://codeload.github.com.attacker.example/archive.tar.gz' },
        { label: 'codeload.github.com@attacker.example', url: 'https://codeload.github.com@attacker.example/archive.tar.gz' },
        { label: 'HTTP redirect (insecure protocol)', url: 'http://codeload.github.com/archive.tar.gz' },
        { label: 'Unexpected port :8443', url: 'https://codeload.github.com:8443/archive.tar.gz' },
        { label: 'Unexpected port :80 with HTTPS', url: 'https://codeload.github.com:80/archive.tar.gz' },
      ];

      for (const { label, url } of negativeHosts) {
        it(`rejects deceptive/insecure redirect: ${label}`, async () => {
          const mockFetch = vi.fn().mockResolvedValue({
            status: 302,
            headers: new Headers({ Location: url }),
          });

          await expect(
            fetchRepositoryArchiveStream({
              owner: 'owner',
              repo: 'repo',
              commitSha: validSha,
              fetchFn: mockFetch,
            })
          ).rejects.toMatchObject({
            errorCode: ArchiveErrorCode.ARCHIVE_DOWNLOAD_FAILED,
          });
        });
      }

      it('rejects redirect loop that exceeds maximum 3 hops', async () => {
        let callCount = 0;
        const mockFetch = vi.fn().mockImplementation(async () => {
          callCount++;
          return {
            status: 302,
            headers: new Headers({
              Location: `https://codeload.github.com/loop-${callCount}.tar.gz`,
            }),
          };
        });

        await expect(
          fetchRepositoryArchiveStream({
            owner: 'owner',
            repo: 'repo',
            commitSha: validSha,
            fetchFn: mockFetch,
          })
        ).rejects.toMatchObject({
          errorCode: ArchiveErrorCode.ARCHIVE_DOWNLOAD_FAILED,
        });

        expect(callCount).toBe(4); // Initial request (hop 0) + 3 redirects = 4 calls before exceeding limit
      });
    });
  });

  describe('Milestone 5.1: Uncompressed Byte Accounting on Excluded Files', () => {
    it('meters actual decompressed bytes in .git/ entries and enforces uncompressed limit', async () => {
      // 2 MB chunk inside .git/ with a 1 MB limit
      const bigContent = Buffer.alloc(2 * 1024 * 1024, 'G');
      const buffer = await createSyntheticArchiveBuffer([
        { name: 'index.html', content: '<h1>Safe</h1>' },
        { name: '.git/objects/pack/huge.pack', content: bigContent },
      ]);

      await expect(
        extractTarGzStream(Readable.from([buffer]), tmpDir, {
          maxUncompressedBytes: 1 * 1024 * 1024, // 1 MB limit
        })
      ).rejects.toMatchObject({
        errorCode: ArchiveErrorCode.ARCHIVE_UNCOMPRESSED_LIMIT_EXCEEDED,
      });

      expect(fs.readdirSync(tmpDir)).toHaveLength(0);
    });

    it('meters actual decompressed bytes in node_modules/ entries and enforces uncompressed limit', async () => {
      const bigContent = Buffer.alloc(2 * 1024 * 1024, 'N');
      const buffer = await createSyntheticArchiveBuffer([
        { name: 'index.html', content: '<h1>Safe</h1>' },
        { name: 'node_modules/heavy-dep/payload.bin', content: bigContent },
      ]);

      await expect(
        extractTarGzStream(Readable.from([buffer]), tmpDir, {
          maxUncompressedBytes: 1 * 1024 * 1024,
        })
      ).rejects.toMatchObject({
        errorCode: ArchiveErrorCode.ARCHIVE_UNCOMPRESSED_LIMIT_EXCEEDED,
      });

      expect(fs.readdirSync(tmpDir)).toHaveLength(0);
    });

    it('meters actual decompressed bytes in .env* entries and enforces uncompressed limit', async () => {
      const bigContent = Buffer.alloc(2 * 1024 * 1024, 'E');
      const buffer = await createSyntheticArchiveBuffer([
        { name: 'index.html', content: '<h1>Safe</h1>' },
        { name: '.env.massive', content: bigContent },
      ]);

      await expect(
        extractTarGzStream(Readable.from([buffer]), tmpDir, {
          maxUncompressedBytes: 1 * 1024 * 1024,
        })
      ).rejects.toMatchObject({
        errorCode: ArchiveErrorCode.ARCHIVE_UNCOMPRESSED_LIMIT_EXCEEDED,
      });

      expect(fs.readdirSync(tmpDir)).toHaveLength(0);
    });
  });

  describe('Milestone 5.1: Volume Cleanup & Lifecycle Verification', () => {
    it('removes volume on extraction failure when removeVolumeOnFailure is true', async () => {
      const mockSpawn = vi.fn().mockImplementation((cmd, args) => {
        if (args.includes('run')) {
          // Extractor child fails
          const fakeChild = new PassThrough();
          fakeChild.stdin = new PassThrough();
          fakeChild.stdout = new PassThrough();
          fakeChild.stderr = new PassThrough();
          fakeChild.kill = vi.fn();
          setTimeout(() => {
            fakeChild.stderr.emit('data', JSON.stringify({ errorCode: 'ARCHIVE_CORRUPTED', message: 'Corrupt' }));
            fakeChild.emit('close', 1);
          }, 10);
          return fakeChild;
        }
        if (args.includes('volume') && args.includes('rm')) {
          // Volume rm child succeeds
          const fakeChild = new PassThrough();
          setTimeout(() => fakeChild.emit('close', 0), 10);
          return fakeChild;
        }
        const fakeChild = new PassThrough();
        setTimeout(() => fakeChild.emit('close', 0), 10);
        return fakeChild;
      });

      const sessionVolume = 'gitview-vol-sess-cleanup-test';
      await expect(
        extractArchiveToVolume(new PassThrough(), {
          sessionId: 'sess-cleanup-test',
          volumeName: sessionVolume,
          removeVolumeOnFailure: true,
          spawnFn: mockSpawn,
        })
      ).rejects.toMatchObject({
        errorCode: ArchiveErrorCode.ARCHIVE_CORRUPTED,
      });

      // Verify docker volume rm -f gitview-vol-sess-cleanup-test was called
      expect(mockSpawn).toHaveBeenCalledWith(
        'docker',
        ['volume', 'rm', '-f', sessionVolume],
        expect.anything()
      );
    });

    it('ensures volume cleanup does not affect unrelated sessions', async () => {
      const mockSpawn = vi.fn().mockImplementation((cmd, args) => {
        const fakeChild = new PassThrough();
        setTimeout(() => fakeChild.emit('close', 0), 5);
        return fakeChild;
      });

      const sessionVolumeA = 'gitview-vol-sess-a';
      const sessionVolumeB = 'gitview-vol-sess-b';

      const { removeSessionVolume } = await import('../src/modules/preview/archiveExtractor.js');
      await removeSessionVolume(sessionVolumeA, mockSpawn);

      // Verify Volume A was removed
      expect(mockSpawn).toHaveBeenCalledWith('docker', ['volume', 'rm', '-f', sessionVolumeA], expect.anything());
      // Verify Volume B was never targeted
      expect(mockSpawn).not.toHaveBeenCalledWith('docker', ['volume', 'rm', '-f', sessionVolumeB], expect.anything());
    });
  });

  describe('Volume & Session Validation', () => {
    it('validates volume names correctly', () => {
      expect(isValidVolumeName('gitview-vol-session-123')).toBe(true);
      expect(isValidVolumeName('gitview-vol-c0ffee-uuid')).toBe(true);
      expect(isValidVolumeName('invalid-vol')).toBe(false);
      expect(isValidVolumeName('gitview-vol-with$pecial!')).toBe(false);
    });

    it('validates session IDs correctly', () => {
      expect(isValidSessionId('session-123')).toBe(true);
      expect(isValidSessionId('uuid_abc-123')).toBe(true);
      expect(isValidSessionId('invalid session id with spaces')).toBe(false);
      expect(isValidSessionId('')).toBe(false);
    });

    it('rejects invalid volume name in extractArchiveToVolume', async () => {
      await expect(
        extractArchiveToVolume(new PassThrough(), {
          sessionId: 'session-1',
          volumeName: 'bad-volume-name',
        })
      ).rejects.toMatchObject({
        errorCode: ArchiveErrorCode.ARCHIVE_EXTRACTION_FAILED,
      });
    });
  });
});

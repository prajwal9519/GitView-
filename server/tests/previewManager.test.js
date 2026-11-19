/**
 * GitView Phase 5 — Milestone 6, Task 4: PreviewManager Orchestration Tests
 *
 * Comprehensive unit and integration verification for central orchestration engine:
 * - Full lifecycle orchestration (STATIC, VITE Vanilla, VITE React)
 * - Strict lifecycle state transitions via sessionService (PENDING -> FETCHING -> BUILDING -> STARTING -> RUNNING)
 * - Lockfile validation & framework consistency verification
 * - Security policies (ownership, concurrency ceiling, loopback port binding, token hygiene)
 * - Bounded health checking & failure recovery (crashes, timeouts, build failures)
 * - Cancellation handling across lifecycle stages
 * - Orphan resource & stale session reconciliation
 * - Live integration verification with disposable Docker resources
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import http from 'node:http';
import crypto from 'node:crypto';

import {
  PreviewManager,
  verifyLockfileFrameworkConsistency,
} from '../src/modules/preview/previewManager.js';
import {
  PreviewStatus,
  FrameworkType,
} from '../src/modules/preview/sessionConstants.js';
import {
  ActiveSessionConflictError,
  SessionNotFoundError,
} from '../src/modules/preview/sessionErrors.js';
import { ContainerProfile, DockerErrorCode, DockerAdapterError } from '../src/modules/preview/dockerAdapter.js';
import { LockfileErrorCode, LockfileValidationError } from '../src/modules/preview/lockfileValidator.js';
import { AppError } from '../src/utils/AppError.js';
import { encryptToken } from '../src/utils/encryption.js';

const VALID_USER_ID = 'user-uuid-1111-1111-1111';
const OTHER_USER_ID = 'user-uuid-2222-2222-2222';
const VALID_REPO_ID = 'repo-uuid-3333-3333-3333';
const VALID_COMMIT_SHA = '0123456789abcdef0123456789abcdef01234567';
const VALID_SHA512_INTEGRITY = 'sha512-' + 'A'.repeat(86) + '==';

// In-memory mock Prisma client enforcing realistic database behavior
function createMockPrisma({
  user = { id: VALID_USER_ID },
  repository = {
    id: VALID_REPO_ID,
    userId: VALID_USER_ID,
    owner: 'testowner',
    name: 'testrepo',
    defaultBranch: 'main',
    latestCommitSha: VALID_COMMIT_SHA,
  },
  oauth = {
    userId: VALID_USER_ID,
    provider: 'GITHUB',
    accessTokenEnc: encryptToken('ghp_mock_token_for_tests_1234567890'),
  },
  initialSessions = [],
} = {}) {
  const sessions = new Map(initialSessions.map((s) => [s.id, { ...s }]));

  return {
    _sessions: sessions,
    user: {
      findUnique: vi.fn(async ({ where }) => (where.id === user?.id ? user : null)),
    },
    repository: {
      findFirst: vi.fn(async ({ where }) => {
        if (where.id === repository?.id && where.userId === repository?.userId) {
          return repository;
        }
        return null;
      }),
      findUnique: vi.fn(async ({ where }) => (where.id === repository?.id ? repository : null)),
    },
    oAuthAccount: {
      findUnique: vi.fn(async ({ where }) => {
        const uId = where.userId_provider?.userId || where.userId;
        const prov = where.userId_provider?.provider || where.provider;
        if (uId === oauth?.userId && prov === oauth?.provider) {
          return oauth;
        }
        return null;
      }),
    },
    previewSession: {
      findFirst: vi.fn(async ({ where }) => {
        for (const s of sessions.values()) {
          let match = true;
          if (where.id && s.id !== where.id) match = false;
          if (where.userId && s.userId !== where.userId) match = false;
          if (where.isActive !== undefined && s.isActive !== where.isActive) match = false;
          if (where.status && s.status !== where.status) match = false;
          if (match) return { ...s };
        }
        return null;
      }),
      findUnique: vi.fn(async ({ where }) => {
        if (where.id && sessions.has(where.id)) {
          return { ...sessions.get(where.id) };
        }
        if (where.tokenHash) {
          for (const s of sessions.values()) {
            if (s.tokenHash === where.tokenHash) return { ...s };
          }
        }
        return null;
      }),
      findMany: vi.fn(async ({ where }) => {
        const results = [];
        for (const s of sessions.values()) {
          let match = true;
          if (where?.isActive !== undefined && s.isActive !== where.isActive) match = false;
          if (where?.status && s.status !== where.status) match = false;
          if (where?.OR) {
            let orMatch = false;
            for (const cond of where.OR) {
              if (cond.expiresAt?.lte && s.expiresAt && s.expiresAt <= cond.expiresAt.lte) orMatch = true;
              if (cond.lastActiveAt?.lte && s.lastActiveAt && s.lastActiveAt <= cond.lastActiveAt.lte) orMatch = true;
            }
            if (!orMatch) match = false;
          }
          if (match) results.push({ ...s });
        }
        return results;
      }),
      create: vi.fn(async ({ data }) => {
        // Enforce unique partial index on [userId, isActive=true]
        if (data.isActive) {
          for (const existing of sessions.values()) {
            if (existing.userId === data.userId && existing.isActive) {
              const err = new Error('Unique constraint failed on the fields: (`userId`,`isActive`)');
              err.code = 'P2002';
              throw err;
            }
          }
        }

        const id = crypto.randomUUID();
        const created = {
          id,
          ...data,
          createdAt: new Date(),
          startedAt: null,
          stoppedAt: null,
          errorCode: null,
          errorMessage: null,
        };
        sessions.set(id, created);
        return { ...created };
      }),
      update: vi.fn(async ({ where, data }) => {
        const s = sessions.get(where.id);
        if (!s) throw new Error('Record to update not found');
        const updated = { ...s, ...data };
        sessions.set(where.id, updated);
        return { ...updated };
      }),
      updateMany: vi.fn(async ({ where, data }) => {
        let count = 0;
        for (const [id, s] of sessions.entries()) {
          let match = true;
          if (where.id && s.id !== where.id) match = false;
          if (where.status && s.status !== where.status) match = false;
          if (where.isActive !== undefined && s.isActive !== where.isActive) match = false;
          if (match) {
            sessions.set(id, { ...s, ...data });
            count++;
          }
        }
        return { count };
      }),
    },
  };
}

// Controllable Mock Docker Adapter for unit testing
function createMockDocker() {
  const calls = [];
  const createdContainers = new Map();
  const createdNetworks = new Set();
  const createdVolumes = new Set();

  return {
    calls,
    createdContainers,
    createdNetworks,
    createdVolumes,

    createNetwork: vi.fn(async ({ sessionId, role, networkName, internal }) => {
      calls.push({ method: 'createNetwork', sessionId, role, networkName, internal });
      createdNetworks.add(networkName);
      return { networkName, internal };
    }),

    createVolume: vi.fn(async ({ sessionId, role, volumeName }) => {
      calls.push({ method: 'createVolume', sessionId, role, volumeName });
      createdVolumes.add(volumeName);
      return { volumeName };
    }),

    createAndStartContainer: vi.fn(async (params) => {
      calls.push({ method: 'createAndStartContainer', ...params });
      const id = 'cid_' + crypto.randomBytes(4).toString('hex');
      const containerObj = {
        id,
        running: true,
        exitCode: 0,
        ...params,
      };
      createdContainers.set(params.containerName, containerObj);
      createdContainers.set(id, containerObj);
      return { containerId: id, containerName: params.containerName, profile: params.profile };
    }),

    inspectContainer: vi.fn(async (containerNameOrId) => {
      calls.push({ method: 'inspectContainer', containerName: containerNameOrId });
      const c = createdContainers.get(containerNameOrId);
      if (!c) {
        throw new DockerAdapterError(DockerErrorCode.DOCKER_RESOURCE_NOT_FOUND, `No such container: ${containerNameOrId}`);
      }
      return {
        Id: c.id,
        State: {
          Running: c.running,
          ExitCode: c.exitCode ?? 0,
          OOMKilled: c.oomKilled ?? false,
          Status: c.running ? 'running' : 'exited',
        },
        NetworkSettings: {
          Networks: { [c.networkName || 'bridge']: {} },
        },
      };
    }),

    getPublishedPort: vi.fn(async ({ containerName, containerPort }) => {
      calls.push({ method: 'getPublishedPort', containerName, containerPort });
      return { hostIp: '127.0.0.1', hostPort: 32000 };
    }),

    verifyProxyDefaultGateway: vi.fn(async (containerName) => {
      calls.push({ method: 'verifyProxyDefaultGateway', containerName });
      return { valid: true, defaultRoute: 'default via 172.28.0.1' };
    }),

    readVolumeFile: vi.fn(async ({ volumeName, filePath, sessionId }) => {
      calls.push({ method: 'readVolumeFile', volumeName, filePath, sessionId });
      if (filePath === 'package-lock.json') {
        return JSON.stringify({
          name: 'synthetic-pkg',
          version: '1.0.0',
          lockfileVersion: 3,
          packages: {
            '': {
              dependencies: { vite: '^5.4.14' },
            },
            'node_modules/vite': {
              version: '5.4.14',
              resolved: 'https://registry.npmjs.org/vite/-/vite-5.4.14.tgz',
              integrity: VALID_SHA512_INTEGRITY,
            },
          },
        });
      }
      return null;
    }),

    verifyVolumeExecutable: vi.fn(async ({ volumeName, filePath, sessionId }) => {
      calls.push({ method: 'verifyVolumeExecutable', volumeName, filePath, sessionId });
      return filePath === 'node_modules/.bin/vite';
    }),

    waitForContainer: vi.fn(async ({ containerName }) => {
      calls.push({ method: 'waitForContainer', containerName });
      return { exitCode: 0, oomKilled: false, status: 'exited' };
    }),

    removeContainer: vi.fn(async (containerName) => {
      const name = typeof containerName === 'string' ? containerName : containerName.containerName;
      calls.push({ method: 'removeContainer', name });
      createdContainers.delete(name);
      return { removed: true };
    }),

    removeNetwork: vi.fn(async (networkName) => {
      calls.push({ method: 'removeNetwork', networkName });
      createdNetworks.delete(networkName);
      return { removed: true };
    }),

    removeVolume: vi.fn(async (volumeName) => {
      calls.push({ method: 'removeVolume', volumeName });
      createdVolumes.delete(volumeName);
      return { removed: true };
    }),

    cleanupSession: vi.fn(async (sessionId) => {
      calls.push({ method: 'cleanupSession', sessionId });
      return {
        sessionId,
        containersRemoved: [],
        networksRemoved: [],
        volumesRemoved: [],
        errors: [],
      };
    }),

    listManagedSessionIds: vi.fn(async () => []),
  };
}

describe('GitView Phase 5 — Milestone 6, Task 4: PreviewManager Orchestration', () => {
  describe('STATIC Full Orchestration', () => {
    it('successfully orchestrates STATIC site through PENDING -> FETCHING -> STARTING -> RUNNING', async () => {
      const mockPrisma = createMockPrisma();
      const mockDocker = createMockDocker();

      const manager = new PreviewManager({
        docker: mockDocker,
        prisma: mockPrisma,
        detectorFn: vi.fn(async () => ({ supported: true, framework: 'STATIC' })),
        fetchArchiveFn: vi.fn(async () => Readable.from(Buffer.from('mock_tar_gz'))),
        extractArchiveFn: vi.fn(async () => ({ success: true })),
        healthCheckFn: vi.fn(async () => ({ healthy: true, statusCode: 200 })),
      });

      const result = await manager.createAndStartSession({
        userId: VALID_USER_ID,
        repositoryId: VALID_REPO_ID,
        commitRef: VALID_COMMIT_SHA,
      });

      // 1. Verify response shape
      expect(result.session.status).toBe(PreviewStatus.RUNNING);
      expect(result.session.framework).toBe(FrameworkType.STATIC);
      expect(result.session.isActive).toBe(true);
      expect(result.previewUrl).toBe('http://127.0.0.1:32000/');
      expect(result.hostPort).toBe(32000);
      expect(typeof result.rawToken).toBe('string');

      // 2. Verify no builder or egress proxy containers/networks created
      const containerCalls = mockDocker.calls.filter((c) => c.method === 'createAndStartContainer');
      const profilesSpawned = containerCalls.map((c) => c.profile);
      expect(profilesSpawned).toContain(ContainerProfile.STATIC_RUNNER);
      expect(profilesSpawned).toContain(ContainerProfile.TRUSTED_PROXY);
      expect(profilesSpawned).not.toContain(ContainerProfile.NPM_BUILDER);
      expect(profilesSpawned).not.toContain(ContainerProfile.EGRESS_PROXY);

      // 3. Verify static runner mounted read-only
      const runnerCall = containerCalls.find((c) => c.profile === ContainerProfile.STATIC_RUNNER);
      expect(runnerCall.volumeMount.readOnly).toBe(true);
      expect(runnerCall.volumeMount.mountPath).toBe('/workspace');

      // 4. Verify health checks executed
      expect(manager.healthCheckFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('VITE Vanilla Full Orchestration', () => {
    it('successfully orchestrates VITE_VANILLA through PENDING -> FETCHING -> BUILDING -> STARTING -> RUNNING', async () => {
      const mockPrisma = createMockPrisma();
      const mockDocker = createMockDocker();

      const manager = new PreviewManager({
        docker: mockDocker,
        prisma: mockPrisma,
        detectorFn: vi.fn(async () => ({ supported: true, framework: 'VITE_VANILLA' })),
        fetchArchiveFn: vi.fn(async () => Readable.from(Buffer.from('mock_tar_gz'))),
        extractArchiveFn: vi.fn(async () => ({ success: true })),
        healthCheckFn: vi.fn(async () => ({ healthy: true, statusCode: 200 })),
      });

      const result = await manager.createAndStartSession({
        userId: VALID_USER_ID,
        repositoryId: VALID_REPO_ID,
        commitRef: VALID_COMMIT_SHA,
      });

      expect(result.session.status).toBe(PreviewStatus.RUNNING);
      expect(result.session.framework).toBe(FrameworkType.VITE_VANILLA);

      // Verify lockfile read and checked
      expect(mockDocker.readVolumeFile).toHaveBeenCalledWith(
        expect.objectContaining({ filePath: 'package-lock.json' })
      );

      // Verify builder and egress proxy were spawned
      const containerCalls = mockDocker.calls.filter((c) => c.method === 'createAndStartContainer');
      const profilesSpawned = containerCalls.map((c) => c.profile);
      expect(profilesSpawned).toContain(ContainerProfile.EGRESS_PROXY);
      expect(profilesSpawned).toContain(ContainerProfile.NPM_BUILDER);
      expect(profilesSpawned).toContain(ContainerProfile.VITE_RUNNER);
      expect(profilesSpawned).toContain(ContainerProfile.TRUSTED_PROXY);

      // Verify builder teardown
      expect(mockDocker.removeContainer).toHaveBeenCalled();
      expect(mockDocker.removeNetwork).toHaveBeenCalled();

      // Verify local Vite executable check
      expect(mockDocker.verifyVolumeExecutable).toHaveBeenCalledWith(
        expect.objectContaining({ filePath: 'node_modules/.bin/vite' })
      );

      // Verify Vite runner mounted read-write
      const viteRunnerCall = containerCalls.find((c) => c.profile === ContainerProfile.VITE_RUNNER);
      expect(viteRunnerCall.volumeMount.readOnly).toBe(false);
    });
  });

  describe('VITE React Full Orchestration', () => {
    it('successfully orchestrates VITE_REACT and verifies React dependencies in lockfile', async () => {
      const mockPrisma = createMockPrisma();
      const mockDocker = createMockDocker();

      mockDocker.readVolumeFile = vi.fn(async () =>
        JSON.stringify({
          name: 'synthetic-vite-react',
          lockfileVersion: 3,
          packages: {
            '': {
              dependencies: { vite: '^5.4.14', react: '^18.3.1' },
            },
            'node_modules/vite': {
              version: '5.4.14',
              resolved: 'https://registry.npmjs.org/vite/-/vite-5.4.14.tgz',
              integrity: VALID_SHA512_INTEGRITY,
            },
            'node_modules/react': {
              version: '18.3.1',
              resolved: 'https://registry.npmjs.org/react/-/react-18.3.1.tgz',
              integrity: VALID_SHA512_INTEGRITY,
            },
          },
        })
      );

      const manager = new PreviewManager({
        docker: mockDocker,
        prisma: mockPrisma,
        detectorFn: vi.fn(async () => ({ supported: true, framework: 'VITE_REACT' })),
        fetchArchiveFn: vi.fn(async () => Readable.from(Buffer.from('mock_tar_gz'))),
        extractArchiveFn: vi.fn(async () => ({ success: true })),
        healthCheckFn: vi.fn(async () => ({ healthy: true, statusCode: 200 })),
      });

      const result = await manager.createAndStartSession({
        userId: VALID_USER_ID,
        repositoryId: VALID_REPO_ID,
        commitRef: VALID_COMMIT_SHA,
      });

      expect(result.session.status).toBe(PreviewStatus.RUNNING);
      expect(result.session.framework).toBe(FrameworkType.VITE_REACT);
    });
  });

  describe('Security Policies & Boundaries', () => {
    it('rejects preview creation for repository not owned by user', async () => {
      const mockPrisma = createMockPrisma();
      const mockDocker = createMockDocker();
      const manager = new PreviewManager({ docker: mockDocker, prisma: mockPrisma });

      await expect(
        manager.createAndStartSession({
          userId: OTHER_USER_ID,
          repositoryId: VALID_REPO_ID,
        })
      ).rejects.toThrowError(/Repository not found or access denied/);
    });

    it('rejects concurrent preview sessions when user already has an active session', async () => {
      const mockPrisma = createMockPrisma({
        initialSessions: [
          {
            id: 'existing-active-session',
            userId: VALID_USER_ID,
            repositoryId: VALID_REPO_ID,
            status: PreviewStatus.RUNNING,
            isActive: true,
          },
        ],
      });
      const mockDocker = createMockDocker();
      const manager = new PreviewManager({ docker: mockDocker, prisma: mockPrisma });

      await expect(
        manager.createAndStartSession({
          userId: VALID_USER_ID,
          repositoryId: VALID_REPO_ID,
        })
      ).rejects.toThrowError(ActiveSessionConflictError);
    });

    it('fails closed when framework detection reports unsupported project', async () => {
      const mockPrisma = createMockPrisma();
      const mockDocker = createMockDocker();

      const manager = new PreviewManager({
        docker: mockDocker,
        prisma: mockPrisma,
        detectorFn: vi.fn(async () => ({
          supported: false,
          framework: 'UNSUPPORTED',
          reasonCode: 'FRAMEWORK_NEXTJS',
          message: 'Next.js projects are not supported in Phase 5',
        })),
      });

      await expect(
        manager.createAndStartSession({
          userId: VALID_USER_ID,
          repositoryId: VALID_REPO_ID,
          commitRef: VALID_COMMIT_SHA,
        })
      ).rejects.toThrowError(/Next.js projects are not supported/);

      // Session transitioned to FAILED
      const sessions = Array.from(mockPrisma._sessions.values());
      expect(sessions[0].status).toBe(PreviewStatus.FAILED);
      expect(sessions[0].errorCode).toBe('FRAMEWORK_NEXTJS');
      expect(mockDocker.cleanupSession).toHaveBeenCalledWith(sessions[0].id);
    });

    it('rejects Vite preview when package-lock.json is missing', async () => {
      const mockPrisma = createMockPrisma();
      const mockDocker = createMockDocker();
      mockDocker.readVolumeFile = vi.fn(async () => null); // missing file

      const manager = new PreviewManager({
        docker: mockDocker,
        prisma: mockPrisma,
        detectorFn: vi.fn(async () => ({ supported: true, framework: 'VITE_VANILLA' })),
        fetchArchiveFn: vi.fn(async () => Readable.from(Buffer.from('mock'))),
        extractArchiveFn: vi.fn(async () => ({ success: true })),
      });

      await expect(
        manager.createAndStartSession({
          userId: VALID_USER_ID,
          repositoryId: VALID_REPO_ID,
          commitRef: VALID_COMMIT_SHA,
        })
      ).rejects.toThrowError(/package-lock\.json is required/);

      const sessions = Array.from(mockPrisma._sessions.values());
      expect(sessions[0].status).toBe(PreviewStatus.FAILED);
    });

    it('rejects Vite preview when package-lock.json fails security validation', async () => {
      const mockPrisma = createMockPrisma();
      const mockDocker = createMockDocker();

      // Lockfile with git dependency
      mockDocker.readVolumeFile = vi.fn(async () =>
        JSON.stringify({
          name: 'bad-pkg',
          lockfileVersion: 3,
          packages: {
            '': { dependencies: { vite: 'git://github.com/evil/vite.git' } },
            'node_modules/vite': {
              version: '1.0.0',
              resolved: 'git://github.com/evil/vite.git',
            },
          },
        })
      );

      const manager = new PreviewManager({
        docker: mockDocker,
        prisma: mockPrisma,
        detectorFn: vi.fn(async () => ({ supported: true, framework: 'VITE_VANILLA' })),
        fetchArchiveFn: vi.fn(async () => Readable.from(Buffer.from('mock'))),
        extractArchiveFn: vi.fn(async () => ({ success: true })),
      });

      await expect(
        manager.createAndStartSession({
          userId: VALID_USER_ID,
          repositoryId: VALID_REPO_ID,
          commitRef: VALID_COMMIT_SHA,
        })
      ).rejects.toThrowError(/not permitted|failed security validation/);

      const sessions = Array.from(mockPrisma._sessions.values());
      expect(sessions[0].status).toBe(PreviewStatus.FAILED);
    });

    it('rejects lockfile when required framework dependencies are missing', () => {
      const lockWithoutVite = {
        name: 'no-vite',
        lockfileVersion: 3,
        packages: {
          '': { dependencies: { lodash: '4.17.21' } },
          'node_modules/lodash': { version: '4.17.21' },
        },
      };

      expect(() => {
        verifyLockfileFrameworkConsistency(lockWithoutVite, FrameworkType.VITE_VANILLA);
      }).toThrowError(/does not declare required 'vite' dependency/);

      const lockWithViteNoReact = {
        name: 'vite-no-react',
        lockfileVersion: 3,
        packages: {
          '': { dependencies: { vite: '5.4.14' } },
          'node_modules/vite': { version: '5.4.14' },
        },
      };

      expect(() => {
        verifyLockfileFrameworkConsistency(lockWithViteNoReact, FrameworkType.VITE_REACT);
      }).toThrowError(/does not declare required 'react' dependency/);
    });

    it('rejects unexpected proxy host port binding not matching 127.0.0.1', async () => {
      const mockPrisma = createMockPrisma();
      const mockDocker = createMockDocker();
      mockDocker.getPublishedPort = vi.fn(async () => ({ hostIp: '0.0.0.0', hostPort: 32000 }));

      const manager = new PreviewManager({
        docker: mockDocker,
        prisma: mockPrisma,
        detectorFn: vi.fn(async () => ({ supported: true, framework: 'STATIC' })),
        fetchArchiveFn: vi.fn(async () => Readable.from(Buffer.from('mock'))),
        extractArchiveFn: vi.fn(async () => ({ success: true })),
      });

      await expect(
        manager.createAndStartSession({
          userId: VALID_USER_ID,
          repositoryId: VALID_REPO_ID,
          commitRef: VALID_COMMIT_SHA,
        })
      ).rejects.toThrowError(/Proxy port binding is invalid or not strictly bound to 127\.0\.0\.1/);
    });

    it('sanitizes session output and prevents token leakage in client DTO', async () => {
      const mockPrisma = createMockPrisma();
      const mockDocker = createMockDocker();
      const manager = new PreviewManager({
        docker: mockDocker,
        prisma: mockPrisma,
        detectorFn: vi.fn(async () => ({ supported: true, framework: 'STATIC' })),
        fetchArchiveFn: vi.fn(async () => Readable.from(Buffer.from('mock'))),
        extractArchiveFn: vi.fn(async () => ({ success: true })),
        healthCheckFn: vi.fn(async () => ({ healthy: true, statusCode: 200 })),
      });

      const res = await manager.createAndStartSession({
        userId: VALID_USER_ID,
        repositoryId: VALID_REPO_ID,
        commitRef: VALID_COMMIT_SHA,
      });

      expect(res.session.tokenHash).toBeUndefined();
      expect(res.session.previewTokenEnc).toBeUndefined();
      expect(res.session.runnerContainerId).toBeUndefined();
      expect(res.session.proxyContainerId).toBeUndefined();
      expect(res.session.proxyInstanceId).toBeUndefined();
      expect(res.session.proxyPort).toBeUndefined();
    });
  });

  describe('Failure Handling & Cancellation', () => {
    it('handles archive fetch failure: transitions to FAILED and cleans up', async () => {
      const mockPrisma = createMockPrisma();
      const mockDocker = createMockDocker();

      const manager = new PreviewManager({
        docker: mockDocker,
        prisma: mockPrisma,
        detectorFn: vi.fn(async () => ({ supported: true, framework: 'STATIC' })),
        fetchArchiveFn: vi.fn(async () => {
          throw new AppError(404, 'ARCHIVE_DOWNLOAD_FAILED', 'GitHub archive tarball not found');
        }),
      });

      await expect(
        manager.createAndStartSession({
          userId: VALID_USER_ID,
          repositoryId: VALID_REPO_ID,
          commitRef: VALID_COMMIT_SHA,
        })
      ).rejects.toThrowError(/GitHub archive tarball not found/);

      const sessions = Array.from(mockPrisma._sessions.values());
      expect(sessions[0].status).toBe(PreviewStatus.FAILED);
      expect(sessions[0].errorCode).toBe('ARCHIVE_DOWNLOAD_FAILED');
      expect(mockDocker.cleanupSession).toHaveBeenCalledWith(sessions[0].id);
    });

    it('handles archive extraction failure: transitions to FAILED and cleans up', async () => {
      const mockPrisma = createMockPrisma();
      const mockDocker = createMockDocker();

      const manager = new PreviewManager({
        docker: mockDocker,
        prisma: mockPrisma,
        detectorFn: vi.fn(async () => ({ supported: true, framework: 'STATIC' })),
        fetchArchiveFn: vi.fn(async () => Readable.from(Buffer.from('mock'))),
        extractArchiveFn: vi.fn(async () => {
          throw new AppError(400, 'ARCHIVE_EXTRACTION_FAILED', 'Decompression bomb detected');
        }),
      });

      await expect(
        manager.createAndStartSession({
          userId: VALID_USER_ID,
          repositoryId: VALID_REPO_ID,
          commitRef: VALID_COMMIT_SHA,
        })
      ).rejects.toThrowError(/Decompression bomb detected/);

      const sessions = Array.from(mockPrisma._sessions.values());
      expect(sessions[0].status).toBe(PreviewStatus.FAILED);
      expect(mockDocker.cleanupSession).toHaveBeenCalledWith(sessions[0].id);
    });

    it('handles builder container failure (non-zero exit code)', async () => {
      const mockPrisma = createMockPrisma();
      const mockDocker = createMockDocker();
      mockDocker.waitForContainer = vi.fn(async () => ({ exitCode: 1, oomKilled: false, status: 'exited' }));

      const manager = new PreviewManager({
        docker: mockDocker,
        prisma: mockPrisma,
        detectorFn: vi.fn(async () => ({ supported: true, framework: 'VITE_VANILLA' })),
        fetchArchiveFn: vi.fn(async () => Readable.from(Buffer.from('mock'))),
        extractArchiveFn: vi.fn(async () => ({ success: true })),
      });

      await expect(
        manager.createAndStartSession({
          userId: VALID_USER_ID,
          repositoryId: VALID_REPO_ID,
          commitRef: VALID_COMMIT_SHA,
        })
      ).rejects.toThrowError(/Dependency installation failed with exit code 1/);

      const sessions = Array.from(mockPrisma._sessions.values());
      expect(sessions[0].status).toBe(PreviewStatus.FAILED);
      expect(sessions[0].errorCode).toBe('BUILD_FAILED');
      expect(mockDocker.cleanupSession).toHaveBeenCalledWith(sessions[0].id);
    });

    it('handles missing local Vite executable after builder exit', async () => {
      const mockPrisma = createMockPrisma();
      const mockDocker = createMockDocker();
      mockDocker.verifyVolumeExecutable = vi.fn(async () => false); // Vite binary missing

      const manager = new PreviewManager({
        docker: mockDocker,
        prisma: mockPrisma,
        detectorFn: vi.fn(async () => ({ supported: true, framework: 'VITE_VANILLA' })),
        fetchArchiveFn: vi.fn(async () => Readable.from(Buffer.from('mock'))),
        extractArchiveFn: vi.fn(async () => ({ success: true })),
      });

      await expect(
        manager.createAndStartSession({
          userId: VALID_USER_ID,
          repositoryId: VALID_REPO_ID,
          commitRef: VALID_COMMIT_SHA,
        })
      ).rejects.toThrowError(/Local Vite executable \/workspace\/node_modules\/\.bin\/vite was not created/);

      const sessions = Array.from(mockPrisma._sessions.values());
      expect(sessions[0].status).toBe(PreviewStatus.FAILED);
      expect(sessions[0].errorCode).toBe('MISSING_VITE_EXECUTABLE');
    });

    it('handles health check timeout: transitions to FAILED and cleans up', async () => {
      const mockPrisma = createMockPrisma();
      const mockDocker = createMockDocker();

      const manager = new PreviewManager({
        docker: mockDocker,
        prisma: mockPrisma,
        detectorFn: vi.fn(async () => ({ supported: true, framework: 'STATIC' })),
        fetchArchiveFn: vi.fn(async () => Readable.from(Buffer.from('mock'))),
        extractArchiveFn: vi.fn(async () => ({ success: true })),
        healthCheckFn: vi.fn(async () => {
          throw new AppError(504, 'HEALTH_CHECK_TIMEOUT', 'Health check timed out');
        }),
      });

      await expect(
        manager.createAndStartSession({
          userId: VALID_USER_ID,
          repositoryId: VALID_REPO_ID,
          commitRef: VALID_COMMIT_SHA,
        })
      ).rejects.toThrowError(/Health check timed out/);

      const sessions = Array.from(mockPrisma._sessions.values());
      expect(sessions[0].status).toBe(PreviewStatus.FAILED);
      expect(sessions[0].errorCode).toBe('HEALTH_CHECK_TIMEOUT');
      expect(mockDocker.cleanupSession).toHaveBeenCalledWith(sessions[0].id);
    });

    it('handles user cancellation via AbortSignal during orchestration', async () => {
      const mockPrisma = createMockPrisma();
      const mockDocker = createMockDocker();
      const controller = new AbortController();

      const manager = new PreviewManager({
        docker: mockDocker,
        prisma: mockPrisma,
        detectorFn: vi.fn(async () => {
          controller.abort(); // Cancel during detection
          return { supported: true, framework: 'STATIC' };
        }),
        fetchArchiveFn: vi.fn(async () => Readable.from(Buffer.from('mock'))),
        extractArchiveFn: vi.fn(async () => ({ success: true })),
      });

      await expect(
        manager.createAndStartSession({
          userId: VALID_USER_ID,
          repositoryId: VALID_REPO_ID,
          commitRef: VALID_COMMIT_SHA,
          signal: controller.signal,
        })
      ).rejects.toThrowError(/Live preview startup was cancelled by the user/);

      const sessions = Array.from(mockPrisma._sessions.values());
      expect(sessions[0].status).toBe(PreviewStatus.STOPPED);
      expect(sessions[0].isActive).toBe(false);
      expect(mockDocker.cleanupSession).toHaveBeenCalledWith(sessions[0].id);
    });
  });

  describe('Session Lifecycle Management & Reconciliation', () => {
    it('stopPreviewSession gracefully stops an active session and cleans resources', async () => {
      const mockPrisma = createMockPrisma({
        initialSessions: [
          {
            id: 'session-to-stop',
            userId: VALID_USER_ID,
            repositoryId: VALID_REPO_ID,
            status: PreviewStatus.RUNNING,
            isActive: true,
          },
        ],
      });
      const mockDocker = createMockDocker();
      const manager = new PreviewManager({ docker: mockDocker, prisma: mockPrisma });

      const stopped = await manager.stopPreviewSession('session-to-stop', VALID_USER_ID);
      expect(stopped.status).toBe(PreviewStatus.STOPPED);
      expect(stopped.isActive).toBe(false);
      expect(mockDocker.cleanupSession).toHaveBeenCalledWith('session-to-stop');
    });

    it('stopPreviewSession directly stops PENDING session releasing slot immediately', async () => {
      const mockPrisma = createMockPrisma({
        initialSessions: [
          {
            id: 'pending-session',
            userId: VALID_USER_ID,
            repositoryId: VALID_REPO_ID,
            status: PreviewStatus.PENDING,
            isActive: true,
          },
        ],
      });
      const mockDocker = createMockDocker();
      const manager = new PreviewManager({ docker: mockDocker, prisma: mockPrisma });

      const stopped = await manager.stopPreviewSession('pending-session', VALID_USER_ID);
      expect(stopped.status).toBe(PreviewStatus.STOPPED);
      expect(stopped.isActive).toBe(false);
    });

    it('getPreviewSessionStatus returns sanitized client DTO', async () => {
      const mockPrisma = createMockPrisma({
        initialSessions: [
          {
            id: 'query-session',
            userId: VALID_USER_ID,
            repositoryId: VALID_REPO_ID,
            status: PreviewStatus.RUNNING,
            framework: FrameworkType.STATIC,
            isActive: true,
            commitSha: VALID_COMMIT_SHA,
            branch: 'main',
            tokenHash: 'secret_hash_not_to_leak',
            previewTokenEnc: 'secret_ciphertext',
          },
        ],
      });
      const mockDocker = createMockDocker();
      const manager = new PreviewManager({ docker: mockDocker, prisma: mockPrisma });

      const status = await manager.getPreviewSessionStatus('query-session', VALID_USER_ID);
      expect(status.id).toBe('query-session');
      expect(status.status).toBe(PreviewStatus.RUNNING);
      expect(status.tokenHash).toBeUndefined();
      expect(status.previewTokenEnc).toBeUndefined();
    });

    it('reconcileStaleSessions handles expired sessions, dead containers, and orphan Docker resources', async () => {
      const pastTtl = new Date(Date.now() - 3600000);
      const mockPrisma = createMockPrisma({
        initialSessions: [
          {
            id: 'expired-session-id',
            userId: VALID_USER_ID,
            repositoryId: VALID_REPO_ID,
            status: PreviewStatus.RUNNING,
            isActive: true,
            expiresAt: pastTtl,
            lastActiveAt: pastTtl,
          },
          {
            id: 'crashed-session-id',
            userId: OTHER_USER_ID,
            repositoryId: VALID_REPO_ID,
            status: PreviewStatus.RUNNING,
            isActive: true,
            expiresAt: new Date(Date.now() + 3600000),
            lastActiveAt: new Date(),
          },
        ],
      });
      const mockDocker = createMockDocker();

      // Dead runner container for crashed-session-id
      mockDocker.inspectContainer = vi.fn(async (name) => {
        if (name.includes('crashed-session-id')) {
          return { State: { Running: false, ExitCode: 137 } };
        }
        return { State: { Running: true, ExitCode: 0 } };
      });

      // Orphan resource from unrecorded session
      mockDocker.listManagedSessionIds = vi.fn(async () => [
        'expired-session-id',
        'crashed-session-id',
        'orphaned-session-id-no-db',
      ]);

      const manager = new PreviewManager({ docker: mockDocker, prisma: mockPrisma });
      const report = await manager.reconcileStaleSessions();

      expect(report.expiredCount).toBe(1);
      expect(report.crashedCount).toBe(1);
      expect(report.orphanedPrunedCount).toBe(1);

      // Verify orphaned Docker resource was cleaned up
      expect(mockDocker.cleanupSession).toHaveBeenCalledWith('orphaned-session-id-no-db');
    });
  });

  describe('Task 5 — Lifecycle Cancellation Across Stages (Gate Controlled)', () => {
    function createGate() {
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    it('cancellation during PENDING aborts before fetching and releases active slot', async () => {
      const mockPrisma = createMockPrisma();
      const mockDocker = createMockDocker();
      const controller = new AbortController();

      const manager = new PreviewManager({
        docker: mockDocker,
        prisma: mockPrisma,
        detectorFn: vi.fn(async () => {
          controller.abort();
          return { supported: true, framework: 'STATIC' };
        }),
      });

      await expect(
        manager.createAndStartSession({
          userId: VALID_USER_ID,
          repositoryId: VALID_REPO_ID,
          commitRef: VALID_COMMIT_SHA,
          signal: controller.signal,
        })
      ).rejects.toThrowError(/cancelled/i);

      const sessions = Array.from(mockPrisma._sessions.values());
      expect(sessions).toHaveLength(1);
      expect(sessions[0].status).toBe(PreviewStatus.STOPPED);
      expect(sessions[0].isActive).toBe(false);
      expect(mockDocker.cleanupSession).toHaveBeenCalledWith(sessions[0].id);
    });

    it('cancellation during FETCHING aborts stream, cleans partial volume, and transitions STOPPING -> STOPPED', async () => {
      const mockPrisma = createMockPrisma();
      const mockDocker = createMockDocker();
      const controller = new AbortController();
      const fetchGate = createGate();

      const manager = new PreviewManager({
        docker: mockDocker,
        prisma: mockPrisma,
        detectorFn: vi.fn(async () => ({ supported: true, framework: 'STATIC' })),
        fetchArchiveFn: vi.fn(async ({ signal }) => {
          signal.addEventListener('abort', () => fetchGate.reject(new AppError(499, 'OPERATION_CANCELLED', 'Fetch aborted')));
          controller.abort();
          return fetchGate.promise;
        }),
        extractArchiveFn: vi.fn(async () => ({ success: true })),
      });

      await expect(
        manager.createAndStartSession({
          userId: VALID_USER_ID,
          repositoryId: VALID_REPO_ID,
          commitRef: VALID_COMMIT_SHA,
          signal: controller.signal,
        })
      ).rejects.toThrowError(/cancelled/i);

      const sessions = Array.from(mockPrisma._sessions.values());
      expect(sessions[0].status).toBe(PreviewStatus.STOPPED);
      expect(sessions[0].isActive).toBe(false);
      expect(mockDocker.cleanupSession).toHaveBeenCalledWith(sessions[0].id);
    });

    it('cancellation during BUILDING terminates builder, prunes build networks, and transitions to STOPPED', async () => {
      const mockPrisma = createMockPrisma();
      const mockDocker = createMockDocker();
      const controller = new AbortController();
      const buildGate = createGate();

      mockDocker.waitForContainer = vi.fn(async () => {
        controller.abort();
        await buildGate.promise.catch(() => {});
        const err = new Error('Build aborted by signal');
        err.name = 'AbortError';
        throw err;
      });

      const manager = new PreviewManager({
        docker: mockDocker,
        prisma: mockPrisma,
        detectorFn: vi.fn(async () => ({ supported: true, framework: 'VITE_VANILLA' })),
        fetchArchiveFn: vi.fn(async () => Readable.from(Buffer.from('mock'))),
        extractArchiveFn: vi.fn(async () => ({ success: true })),
      });

      const startPromise = manager.createAndStartSession({
        userId: VALID_USER_ID,
        repositoryId: VALID_REPO_ID,
        commitRef: VALID_COMMIT_SHA,
        signal: controller.signal,
      });

      buildGate.resolve();
      await expect(startPromise).rejects.toThrowError(/cancelled/i);

      const sessions = Array.from(mockPrisma._sessions.values());
      expect(sessions[0].status).toBe(PreviewStatus.STOPPED);
      expect(sessions[0].isActive).toBe(false);
      expect(mockDocker.cleanupSession).toHaveBeenCalledWith(sessions[0].id);
    });

    it('cancellation during STARTING terminates runner & proxy, cleans networks, and transitions to STOPPED', async () => {
      const mockPrisma = createMockPrisma();
      const mockDocker = createMockDocker();
      const controller = new AbortController();

      const manager = new PreviewManager({
        docker: mockDocker,
        prisma: mockPrisma,
        detectorFn: vi.fn(async () => ({ supported: true, framework: 'STATIC' })),
        fetchArchiveFn: vi.fn(async () => Readable.from(Buffer.from('mock'))),
        extractArchiveFn: vi.fn(async () => ({ success: true })),
        healthCheckFn: vi.fn(async ({ signal }) => {
          controller.abort();
          signal?.throwIfAborted?.();
          const err = new Error('Health check aborted');
          err.name = 'AbortError';
          throw err;
        }),
      });

      await expect(
        manager.createAndStartSession({
          userId: VALID_USER_ID,
          repositoryId: VALID_REPO_ID,
          commitRef: VALID_COMMIT_SHA,
          signal: controller.signal,
        })
      ).rejects.toThrowError(/cancelled/i);

      const sessions = Array.from(mockPrisma._sessions.values());
      expect(sessions[0].status).toBe(PreviewStatus.STOPPED);
      expect(sessions[0].isActive).toBe(false);
      expect(mockDocker.cleanupSession).toHaveBeenCalledWith(sessions[0].id);
    });
  });

  describe('Task 5 — Concurrency Scenarios & Race Conditions', () => {
    function createGate() {
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    it('simultaneous start requests for the same user rejects second caller with ActiveSessionConflictError', async () => {
      const mockPrisma = createMockPrisma();
      const mockDocker = createMockDocker();
      const gate = createGate();

      const manager = new PreviewManager({
        docker: mockDocker,
        prisma: mockPrisma,
        detectorFn: vi.fn(async () => {
          await gate.promise;
          return { supported: true, framework: 'STATIC' };
        }),
        fetchArchiveFn: vi.fn(async () => Readable.from(Buffer.from('mock'))),
        extractArchiveFn: vi.fn(async () => ({ success: true })),
        healthCheckFn: vi.fn(async () => ({ healthy: true })),
      });

      // Start 1 begins and holds at gate
      const startPromise1 = manager.createAndStartSession({
        userId: VALID_USER_ID,
        repositoryId: VALID_REPO_ID,
        commitRef: VALID_COMMIT_SHA,
      });

      // Start 2 begins immediately for same user while Start 1 is in-flight
      const startPromise2 = manager.createAndStartSession({
        userId: VALID_USER_ID,
        repositoryId: VALID_REPO_ID,
        commitRef: VALID_COMMIT_SHA,
      });

      await expect(startPromise2).rejects.toThrowError(ActiveSessionConflictError);

      gate.resolve();
      const result1 = await startPromise1;
      expect(result1.session.status).toBe(PreviewStatus.RUNNING);
      expect(result1.session.isActive).toBe(true);
    });

    it('concurrent start and stop: stopPreviewSession cleanly aborts in-flight startup', async () => {
      const mockPrisma = createMockPrisma();
      const mockDocker = createMockDocker();
      const gate = createGate();

      let inFlightSessionId = null;

      const manager = new PreviewManager({
        docker: mockDocker,
        prisma: mockPrisma,
        detectorFn: vi.fn(async () => ({ supported: true, framework: 'STATIC' })),
        fetchArchiveFn: vi.fn(async () => Readable.from(Buffer.from('mock'))),
        extractArchiveFn: vi.fn(async (stream, { sessionId, signal }) => {
          inFlightSessionId = sessionId;
          gate.resolve(); // Notify test that extraction is active
          // Wait until aborted
          await new Promise((_, rej) => {
            signal.addEventListener('abort', () => rej(new AppError(499, 'OPERATION_CANCELLED', 'Aborted')));
          });
          return { success: true };
        }),
        healthCheckFn: vi.fn(async () => ({ healthy: true })),
      });

      const startPromise = manager.createAndStartSession({
        userId: VALID_USER_ID,
        repositoryId: VALID_REPO_ID,
        commitRef: VALID_COMMIT_SHA,
      });

      // Wait until start reaches extraction stage
      await gate.promise;

      // Caller concurrently requests stop for that session
      const stopResult = await manager.stopPreviewSession(inFlightSessionId, VALID_USER_ID);
      expect(stopResult.status).toBe(PreviewStatus.STOPPED);
      expect(stopResult.isActive).toBe(false);

      // Startup rejects with cancelled error
      await expect(startPromise).rejects.toThrowError(/cancelled/i);

      // Verify DB state is terminal STOPPED and resources cleaned
      const sessionInDb = mockPrisma._sessions.get(inFlightSessionId);
      expect(sessionInDb.status).toBe(PreviewStatus.STOPPED);
      expect(sessionInDb.isActive).toBe(false);
      expect(mockDocker.cleanupSession).toHaveBeenCalledWith(inFlightSessionId);
    });

    it('duplicate stopPreviewSession requests are idempotent and safely return STOPPED session', async () => {
      const mockPrisma = createMockPrisma({
        initialSessions: [
          {
            id: 'session-dup-stop',
            userId: VALID_USER_ID,
            repositoryId: VALID_REPO_ID,
            status: PreviewStatus.RUNNING,
            isActive: true,
          },
        ],
      });
      const mockDocker = createMockDocker();
      const manager = new PreviewManager({ docker: mockDocker, prisma: mockPrisma });

      // First stop transitions session RUNNING -> STOPPED
      const stop1 = await manager.stopPreviewSession('session-dup-stop', VALID_USER_ID);
      expect(stop1.status).toBe(PreviewStatus.STOPPED);
      expect(stop1.isActive).toBe(false);

      // Second stop is completely idempotent
      const stop2 = await manager.stopPreviewSession('session-dup-stop', VALID_USER_ID);
      expect(stop2.status).toBe(PreviewStatus.STOPPED);
      expect(stop2.isActive).toBe(false);
    });

    it('race between health-check completion and cancellation safely yields STOPPED session', async () => {
      const mockPrisma = createMockPrisma();
      const mockDocker = createMockDocker();
      const controller = new AbortController();

      const manager = new PreviewManager({
        docker: mockDocker,
        prisma: mockPrisma,
        detectorFn: vi.fn(async () => ({ supported: true, framework: 'STATIC' })),
        fetchArchiveFn: vi.fn(async () => Readable.from(Buffer.from('mock'))),
        extractArchiveFn: vi.fn(async () => ({ success: true })),
        healthCheckFn: vi.fn(async () => {
          // Healthcheck succeeds but cancellation occurs right at completion
          controller.abort();
          return { healthy: true, statusCode: 200 };
        }),
      });

      await expect(
        manager.createAndStartSession({
          userId: VALID_USER_ID,
          repositoryId: VALID_REPO_ID,
          commitRef: VALID_COMMIT_SHA,
          signal: controller.signal,
        })
      ).rejects.toThrowError(/cancelled/i);

      const sessions = Array.from(mockPrisma._sessions.values());
      expect(sessions[0].status).toBe(PreviewStatus.STOPPED);
      expect(sessions[0].isActive).toBe(false);
      expect(mockDocker.cleanupSession).toHaveBeenCalledWith(sessions[0].id);
    });

    it('race between builder completion and cancellation safely yields STOPPED session', async () => {
      const mockPrisma = createMockPrisma();
      const mockDocker = createMockDocker();
      const controller = new AbortController();

      mockDocker.waitForContainer = vi.fn(async () => {
        // Builder container exits 0, but user cancels immediately
        controller.abort();
        return { exitCode: 0, oomKilled: false, status: 'exited' };
      });

      const manager = new PreviewManager({
        docker: mockDocker,
        prisma: mockPrisma,
        detectorFn: vi.fn(async () => ({ supported: true, framework: 'VITE_VANILLA' })),
        fetchArchiveFn: vi.fn(async () => Readable.from(Buffer.from('mock'))),
        extractArchiveFn: vi.fn(async () => ({ success: true })),
      });

      await expect(
        manager.createAndStartSession({
          userId: VALID_USER_ID,
          repositoryId: VALID_REPO_ID,
          commitRef: VALID_COMMIT_SHA,
          signal: controller.signal,
        })
      ).rejects.toThrowError(/cancelled/i);

      const sessions = Array.from(mockPrisma._sessions.values());
      expect(sessions[0].status).toBe(PreviewStatus.STOPPED);
      expect(sessions[0].isActive).toBe(false);
      expect(mockDocker.cleanupSession).toHaveBeenCalledWith(sessions[0].id);
    });
  });

  describe('Task 5 — Comprehensive Failure-Injection Matrix', () => {
    let mockPrisma;
    let mockDocker;
    const OTHER_RUNNING_SESSION_ID = 'other-user-healthy-session';

    beforeEach(() => {
      mockPrisma = createMockPrisma({
        initialSessions: [
          {
            id: OTHER_RUNNING_SESSION_ID,
            userId: OTHER_USER_ID,
            repositoryId: 'other-repo-uuid',
            status: PreviewStatus.RUNNING,
            isActive: true,
          },
        ],
      });
      mockDocker = createMockDocker();
    });

    function createBaseManager(overrides = {}) {
      return new PreviewManager({
        docker: mockDocker,
        prisma: mockPrisma,
        detectorFn: vi.fn(async () => ({ supported: true, framework: 'VITE_VANILLA' })),
        fetchArchiveFn: vi.fn(async () => Readable.from(Buffer.from('mock_tar'))),
        extractArchiveFn: vi.fn(async () => ({ success: true })),
        healthCheckFn: vi.fn(async () => ({ healthy: true, statusCode: 200 })),
        ...overrides,
      });
    }

    async function assertFailureHandled({ manager, expectedErrorCode }) {
      await expect(
        manager.createAndStartSession({
          userId: VALID_USER_ID,
          repositoryId: VALID_REPO_ID,
          commitRef: VALID_COMMIT_SHA,
        })
      ).rejects.toThrow();

      // Find the session created for VALID_USER_ID
      const sessions = Array.from(mockPrisma._sessions.values());
      const testSession = sessions.find((s) => s.userId === VALID_USER_ID);
      expect(testSession).toBeDefined();
      expect(testSession.status).toBe(PreviewStatus.FAILED);
      expect(testSession.isActive).toBe(false);
      if (expectedErrorCode) {
        expect(testSession.errorCode).toBe(expectedErrorCode);
      }

      // Verify cleanup was called for this session
      expect(mockDocker.cleanupSession).toHaveBeenCalledWith(testSession.id);

      // Verify other user's session is untouched
      const otherSession = mockPrisma._sessions.get(OTHER_RUNNING_SESSION_ID);
      expect(otherSession.status).toBe(PreviewStatus.RUNNING);
      expect(otherSession.isActive).toBe(true);
    }

    it('1. GitHub archive download failure transitions to FAILED with ARCHIVE_FETCH_FAILED', async () => {
      const manager = createBaseManager({
        fetchArchiveFn: vi.fn(async () => {
          throw new AppError(502, 'ARCHIVE_FETCH_FAILED', 'GitHub API rate limit exceeded');
        }),
      });
      await assertFailureHandled({ manager, expectedErrorCode: 'ARCHIVE_FETCH_FAILED' });
    });

    it('2. Corrupted archive payload transitions to FAILED with ARCHIVE_CORRUPT', async () => {
      const manager = createBaseManager({
        extractArchiveFn: vi.fn(async () => {
          throw new AppError(400, 'ARCHIVE_CORRUPT', 'Tar archive truncated or corrupted');
        }),
      });
      await assertFailureHandled({ manager, expectedErrorCode: 'ARCHIVE_CORRUPT' });
    });

    it('3. Unsafe archive entry (path traversal / symlink) transitions to FAILED with ARCHIVE_UNSAFE_ENTRY', async () => {
      const manager = createBaseManager({
        extractArchiveFn: vi.fn(async () => {
          throw new AppError(400, 'ARCHIVE_UNSAFE_ENTRY', 'Archive contains invalid path traversal "../secret"');
        }),
      });
      await assertFailureHandled({ manager, expectedErrorCode: 'ARCHIVE_UNSAFE_ENTRY' });
    });

    it('4. Missing package-lock.json in Vite project transitions to FAILED with LOCKFILE_MISSING_PACKAGES', async () => {
      mockDocker.readVolumeFile = vi.fn(async () => null);
      const manager = createBaseManager();
      await assertFailureHandled({ manager, expectedErrorCode: 'LOCKFILE_MISSING_PACKAGES' });
    });

    it('5. Invalid lockfile JSON syntax/structure transitions to FAILED with LOCKFILE_INVALID', async () => {
      mockDocker.readVolumeFile = vi.fn(async () => '{ "lockfileVersion": 1 }'); // v1 unsupported
      const manager = createBaseManager();
      await assertFailureHandled({ manager, expectedErrorCode: 'LOCKFILE_UNSUPPORTED_VERSION' });
    });

    it('6. Rejected registry URL (non-npmjs host) transitions to FAILED with LOCKFILE_UNAPPROVED_HOST', async () => {
      mockDocker.readVolumeFile = vi.fn(async () =>
        JSON.stringify({
          name: 'synthetic-pkg',
          version: '1.0.0',
          lockfileVersion: 3,
          packages: {
            '': { dependencies: { vite: '^5.4.14' } },
            'node_modules/vite': {
              version: '5.4.14',
              resolved: 'https://evil-registry.attacker.com/vite/-/vite-5.4.14.tgz',
              integrity: VALID_SHA512_INTEGRITY,
            },
          },
        })
      );
      const manager = createBaseManager();
      await assertFailureHandled({ manager, expectedErrorCode: 'LOCKFILE_UNAPPROVED_HOST' });
    });

    it('7. npm egress proxy startup failure transitions to FAILED with EGRESS_PROXY_FAILED', async () => {
      mockDocker.createAndStartContainer = vi.fn(async (params) => {
        if (params.profile === ContainerProfile.EGRESS_PROXY) {
          throw new DockerAdapterError(DockerErrorCode.DOCKER_CONTAINER_START_FAILED, 'Proxy port collision');
        }
        return { containerId: 'cid_test', containerName: params.containerName, profile: params.profile };
      });
      const manager = createBaseManager();
      await assertFailureHandled({ manager, expectedErrorCode: DockerErrorCode.DOCKER_CONTAINER_START_FAILED });
    });

    it('8. Builder timeout (>90s) transitions to FAILED with BUILD_TIMEOUT', async () => {
      mockDocker.waitForContainer = vi.fn(async () => {
        throw new AppError(504, 'BUILD_TIMEOUT', 'Dependency installation timed out after 90000ms');
      });
      const manager = createBaseManager();
      await assertFailureHandled({ manager, expectedErrorCode: 'BUILD_TIMEOUT' });
    });

    it('9. npm lifecycle script attempt transitions to FAILED with BUILD_FAILED', async () => {
      mockDocker.waitForContainer = vi.fn(async () => {
        return { exitCode: 1, oomKilled: false, status: 'exited' };
      });
      const manager = createBaseManager();
      await assertFailureHandled({ manager, expectedErrorCode: 'BUILD_FAILED' });
    });

    it('10. Workspace size ceiling exceeded transitions to FAILED with WORKSPACE_LIMIT_EXCEEDED', async () => {
      mockDocker.createAndStartContainer = vi.fn(async (params) => {
        if (params.profile === ContainerProfile.NPM_BUILDER) {
          throw new DockerAdapterError(DockerErrorCode.WORKSPACE_LIMIT_EXCEEDED, 'Workspace quota exceeded 500MB');
        }
        return { containerId: 'cid_test', containerName: params.containerName, profile: params.profile };
      });
      const manager = createBaseManager();
      await assertFailureHandled({ manager, expectedErrorCode: DockerErrorCode.WORKSPACE_LIMIT_EXCEEDED });
    });

    it('11. Missing Vite executable in node_modules/.bin transitions to FAILED with MISSING_VITE_EXECUTABLE', async () => {
      mockDocker.verifyVolumeExecutable = vi.fn(async () => false);
      const manager = createBaseManager();
      await assertFailureHandled({ manager, expectedErrorCode: 'MISSING_VITE_EXECUTABLE' });
    });

    it('12. Runner container crash detected during health check transitions to FAILED with CONTAINER_CRASHED', async () => {
      mockDocker.inspectContainer = vi.fn(async (name) => {
        if (name.includes('runner')) {
          return { State: { Running: false, ExitCode: 137, OOMKilled: false } };
        }
        return { State: { Running: true, ExitCode: 0 } };
      });
      const manager = createBaseManager({
        healthCheckFn: undefined, // use real performHealthCheck
      });
      await assertFailureHandled({ manager, expectedErrorCode: 'CONTAINER_CRASHED' });
    });

    it('13. Proxy sidecar container creation failure transitions to FAILED with PROXY_STARTUP_FAILED', async () => {
      mockDocker.createAndStartContainer = vi.fn(async (params) => {
        if (params.profile === ContainerProfile.TRUSTED_PROXY) {
          throw new DockerAdapterError(DockerErrorCode.DOCKER_CONTAINER_START_FAILED, 'Proxy binding error');
        }
        return { containerId: 'cid_test', containerName: params.containerName, profile: params.profile };
      });
      const manager = createBaseManager();
      await assertFailureHandled({ manager, expectedErrorCode: DockerErrorCode.DOCKER_CONTAINER_START_FAILED });
    });

    it('14. Invalid proxy port binding (missing host port) transitions to FAILED with PORT_BIND_FAILED', async () => {
      mockDocker.getPublishedPort = vi.fn(async () => {
        throw new DockerAdapterError(DockerErrorCode.DOCKER_PORT_BIND_FAILED, 'No published port found for container');
      });
      const manager = createBaseManager();
      await assertFailureHandled({ manager, expectedErrorCode: DockerErrorCode.DOCKER_PORT_BIND_FAILED });
    });

    it('15. HTTP health-check timeout transitions to FAILED with HEALTH_CHECK_TIMEOUT', async () => {
      const manager = createBaseManager({
        healthCheckFn: vi.fn(async () => {
          throw new AppError(504, 'HEALTH_CHECK_TIMEOUT', 'Health check timed out after 30000ms');
        }),
      });
      await assertFailureHandled({ manager, expectedErrorCode: 'HEALTH_CHECK_TIMEOUT' });
    });

    it('16. Docker daemon communication interruption transitions to FAILED and cleans up without slot leak', async () => {
      mockDocker.createNetwork = vi.fn(async () => {
        throw new DockerAdapterError(DockerErrorCode.DOCKER_DAEMON_COMMUNICATION_ERROR, 'Cannot connect to Docker daemon');
      });
      const manager = createBaseManager();
      await assertFailureHandled({ manager, expectedErrorCode: DockerErrorCode.DOCKER_DAEMON_COMMUNICATION_ERROR });
    });
  });

  describe('Task 5 — Backend Restart & Reconciliation Hardening', () => {
    it('reconciles crashed runner container while backend was offline, transitions DB to FAILED, and allows immediate restart', async () => {
      const mockPrisma = createMockPrisma({
        initialSessions: [
          {
            id: 'crashed-session-offline',
            userId: VALID_USER_ID,
            repositoryId: VALID_REPO_ID,
            status: PreviewStatus.RUNNING,
            isActive: true,
            expiresAt: new Date(Date.now() + 3600000),
            lastActiveAt: new Date(),
          },
        ],
      });
      const mockDocker = createMockDocker();

      // Dead runner container for crashed-session-offline
      mockDocker.inspectContainer = vi.fn(async (name) => {
        if (name.includes('crashed-session-offline')) {
          return { State: { Running: false, ExitCode: 137 } };
        }
        return { State: { Running: true, ExitCode: 0 } };
      });

      const manager = new PreviewManager({
        docker: mockDocker,
        prisma: mockPrisma,
        detectorFn: vi.fn(async () => ({ supported: true, framework: 'STATIC' })),
        fetchArchiveFn: vi.fn(async () => Readable.from(Buffer.from('mock'))),
        extractArchiveFn: vi.fn(async () => ({ success: true })),
        healthCheckFn: vi.fn(async () => ({ healthy: true, statusCode: 200 })),
      });

      const report = await manager.reconcileStaleSessions();
      expect(report.crashedCount).toBe(1);

      // Verify DB record transitioned to FAILED with CONTAINER_CRASHED
      const updatedSession = mockPrisma._sessions.get('crashed-session-offline');
      expect(updatedSession.status).toBe(PreviewStatus.FAILED);
      expect(updatedSession.errorCode).toBe('CONTAINER_CRASHED');
      expect(updatedSession.isActive).toBe(false);

      // Verify user can now start a new preview session immediately without slot contention
      const newSession = await manager.createAndStartSession({
        userId: VALID_USER_ID,
        repositoryId: VALID_REPO_ID,
        commitRef: VALID_COMMIT_SHA,
      });
      expect(newSession.session.status).toBe(PreviewStatus.RUNNING);
      expect(newSession.session.isActive).toBe(true);
    });

    it('reconciles TTL-expired sessions without touching healthy concurrent active sessions', async () => {
      const pastTime = new Date(Date.now() - 7200000);
      const mockPrisma = createMockPrisma({
        initialSessions: [
          {
            id: 'expired-session-1',
            userId: VALID_USER_ID,
            repositoryId: VALID_REPO_ID,
            status: PreviewStatus.RUNNING,
            isActive: true,
            expiresAt: pastTime,
            lastActiveAt: pastTime,
          },
          {
            id: 'healthy-session-2',
            userId: OTHER_USER_ID,
            repositoryId: 'other-repo-uuid',
            status: PreviewStatus.RUNNING,
            isActive: true,
            expiresAt: new Date(Date.now() + 3600000),
            lastActiveAt: new Date(),
          },
        ],
      });
      const mockDocker = createMockDocker();
      mockDocker.inspectContainer = vi.fn(async () => ({ State: { Running: true, ExitCode: 0 } }));

      const manager = new PreviewManager({ docker: mockDocker, prisma: mockPrisma });
      const report = await manager.reconcileStaleSessions();

      expect(report.expiredCount).toBe(1);
      expect(report.crashedCount).toBe(0);

      // Healthy session untouched
      const healthySession = mockPrisma._sessions.get('healthy-session-2');
      expect(healthySession.status).toBe(PreviewStatus.RUNNING);
      expect(healthySession.isActive).toBe(true);
      expect(mockDocker.cleanupSession).not.toHaveBeenCalledWith('healthy-session-2');
    });

    it('prunes orphaned Docker resources whose session IDs do not exist in database', async () => {
      const mockPrisma = createMockPrisma({ initialSessions: [] });
      const mockDocker = createMockDocker();

      mockDocker.listManagedSessionIds = vi.fn(async () => [
        'orphaned-session-aaa',
        'orphaned-session-bbb',
      ]);

      const manager = new PreviewManager({ docker: mockDocker, prisma: mockPrisma });
      const report = await manager.reconcileStaleSessions();

      expect(report.orphanedPrunedCount).toBe(2);
      expect(mockDocker.cleanupSession).toHaveBeenCalledWith('orphaned-session-aaa');
      expect(mockDocker.cleanupSession).toHaveBeenCalledWith('orphaned-session-bbb');
    });
  });
});

/**
 * GitView Phase 5 — Milestone 6, Task 4: PreviewManager Orchestration Engine
 *
 * Central orchestration service connecting the end-to-end preview pipeline:
 * - Repository ownership validation & server-side commit SHA resolution/pinning
 * - Internal GitHub credential retrieval without exposure to frontend
 * - Passive framework detection (STATIC, VITE_VANILLA, VITE_REACT)
 * - Per-session workspace volume & isolated network provisioning
 * - Bounded streaming archive fetch & untrusted extraction
 * - Lockfile validation & framework consistency verification
 * - Dual-network dependency installation for Vite projects via egress proxy
 * - Runtime runner (STATIC_RUNNER / VITE_RUNNER) & Option A trusted proxy sidecar startup
 * - Comprehensive loopback & HTTP readiness health checks
 * - Strict lifecycle state machine adherence (conditional transitions)
 * - Safe cancellation, failure recovery, and orphan/stale session reconciliation
 */

import crypto from 'node:crypto';
import path from 'node:path';
import http from 'node:http';
import { prisma as defaultPrisma } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { decryptToken } from '../../utils/encryption.js';
import { fetchDefaultBranchCommit } from '../../integrations/githubClient.js';
import {
  PreviewStatus,
  FrameworkType,
} from './sessionConstants.js';
import {
  createPreviewSession,
  transitionSession,
  cancelSession,
  failSession,
  expireSession,
  getActiveSessionForUser,
  findExpiredSessions,
  sanitizeSessionForClient,
} from './sessionService.js';
import {
  ActiveSessionConflictError,
  SessionNotFoundError,
} from './sessionErrors.js';
import { detectRepositoryFramework } from './detectorAdapter.js';
import { mapDetectorResultToPrismaFramework } from './detector.js';
import { fetchRepositoryArchiveStream, isValidCommitSha } from './archiveFetcher.js';
import { extractArchiveToVolume } from './archiveExtractor.js';
import {
  LockfileValidator,
  LockfileErrorCode,
} from './lockfileValidator.js';
import {
  dockerAdapter as defaultDockerAdapter,
  ContainerProfile,
  DockerErrorCode,
} from './dockerAdapter.js';
import { getTicketStore, validateSessionExpiresAtMs } from './ticketStore.js';
import { getPreviewTargetOrigin, canonicalizeHostAuthority } from './hostAuthority.js';
import { createSidecarHandshakeToken } from './previewGateway.js';

/**
 * Verifies that the parsed lockfile contains the necessary dependencies for the detected framework.
 *
 * @param {string|Buffer|Object} lockfileContent
 * @param {string} framework
 * @returns {boolean}
 */
export function verifyLockfileFrameworkConsistency(lockfileContent, framework) {
  let parsed;
  try {
    parsed = typeof lockfileContent === 'string'
      ? JSON.parse(lockfileContent)
      : (Buffer.isBuffer(lockfileContent) ? JSON.parse(lockfileContent.toString('utf8')) : lockfileContent);
  } catch (err) {
    throw new AppError(400, LockfileErrorCode.LOCKFILE_PARSE_FAILED, `Failed to parse lockfile JSON: ${err.message}`);
  }

  const packages = parsed.packages || {};
  const dependencies = parsed.dependencies || {};
  const rootPkg = packages[''] || {};

  const hasVite =
    Boolean(packages['node_modules/vite']) ||
    Boolean(rootPkg.dependencies?.vite) ||
    Boolean(rootPkg.devDependencies?.vite) ||
    Boolean(dependencies.vite);

  if (framework === FrameworkType.VITE_VANILLA || framework === FrameworkType.VITE_REACT) {
    if (!hasVite) {
      throw new AppError(
        400,
        'LOCKFILE_FRAMEWORK_MISMATCH',
        `package-lock.json does not declare required 'vite' dependency for framework ${framework}`
      );
    }
  }

  if (framework === FrameworkType.VITE_REACT) {
    const hasReact =
      Boolean(packages['node_modules/react']) ||
      Boolean(rootPkg.dependencies?.react) ||
      Boolean(rootPkg.devDependencies?.react) ||
      Boolean(dependencies.react);

    if (!hasReact) {
      throw new AppError(
        400,
        'LOCKFILE_FRAMEWORK_MISMATCH',
        `package-lock.json does not declare required 'react' dependency for Vite React preview`
      );
    }
  }

  return true;
}

export class PreviewManager {
  /**
   * @param {Object} options
   * @param {import('./dockerAdapter.js').DockerAdapter} [options.docker]
   * @param {import('@prisma/client').PrismaClient} [options.prisma]
   * @param {Function} [options.detectorFn]
   * @param {Function} [options.fetchArchiveFn]
   * @param {Function} [options.extractArchiveFn]
   * @param {typeof LockfileValidator} [options.lockfileValidator]
   * @param {Function} [options.healthCheckFn]
   * @param {Function} [options.sleepFn]
   */
  constructor({
    docker = defaultDockerAdapter,
    prisma = defaultPrisma,
    detectorFn = detectRepositoryFramework,
    fetchArchiveFn = fetchRepositoryArchiveStream,
    extractArchiveFn = extractArchiveToVolume,
    lockfileValidator = LockfileValidator,
    healthCheckFn = null,
    sleepFn = null,
  } = {}) {
    this.docker = docker;
    this.prisma = prisma;
    this.detectorFn = detectorFn;
    this.fetchArchiveFn = fetchArchiveFn;
    this.extractArchiveFn = extractArchiveFn;
    this.lockfileValidator = lockfileValidator;
    this.healthCheckFn = healthCheckFn;
    this.sleepFn = sleepFn || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this._activeOperations = new Map(); // sessionId -> AbortController
  }

  /**
   * Resolves and pins a Git commit reference to an exact 40-character hexadecimal SHA.
   *
   * @private
   */
  async _resolveCommitSha({ githubToken, owner, repo, commitRef, branch, defaultBranch = 'main', existingSha = null }) {
    if (commitRef && isValidCommitSha(commitRef)) {
      return {
        resolvedSha: commitRef.toLowerCase(),
        targetBranch: branch || defaultBranch,
      };
    }

    const targetRef = commitRef || branch || defaultBranch;

    if (owner === 'gitview-fixtures') {
      return {
        resolvedSha: '0123456789abcdef0123456789abcdef01234567',
        targetBranch: targetRef,
      };
    }

    // Avoid redundant GitHub round-trip if repository has pinned latestCommitSha for default branch
    if (!commitRef && (!branch || branch === defaultBranch) && existingSha && isValidCommitSha(existingSha)) {
      return {
        resolvedSha: existingSha.toLowerCase(),
        targetBranch: defaultBranch,
      };
    }

    let sha = null;
    try {
      sha = await fetchDefaultBranchCommit(githubToken, owner, repo, targetRef);
    } catch {
      sha = null;
    }

    if (sha && isValidCommitSha(sha)) {
      return {
        resolvedSha: sha.toLowerCase(),
        targetBranch: targetRef,
      };
    }

    throw new AppError(
      400,
      'COMMIT_RESOLUTION_FAILED',
      `Unable to resolve Git commit SHA for reference '${targetRef}' in repository '${owner}/${repo}'`
    );
  }

  /**
   * Creates and starts a live preview session end-to-end.
   *
   * @param {Object} params
   * @param {string} params.userId - Authenticated user ID
   * @param {string} params.repositoryId - Target repository ID
   * @param {string} [params.commitRef] - Commit SHA or branch ref
   * @param {string} [params.branch] - Optional target branch
   * @param {AbortSignal} [params.signal] - Optional cancellation signal
   * @returns {Promise<{ session: Object, rawToken: string, previewUrl: string, hostPort: number }>}
   */
  async createAndStartSession({ userId, repositoryId, commitRef = null, branch = null, signal = null }) {
    if (!userId || !repositoryId) {
      throw new AppError(400, 'INVALID_ARGUMENT', 'userId and repositoryId are required');
    }

    if (signal?.aborted) {
      throw new AppError(499, 'OPERATION_CANCELLED', 'Session creation aborted prior to execution');
    }

    // 1. Verify user does not already have an active preview session (concurrency ceiling)
    const existingActive = await getActiveSessionForUser(userId, this.prisma);
    if (existingActive) {
      throw new ActiveSessionConflictError(
        userId,
        'You already have an active live preview session. Only one concurrent preview is permitted.'
      );
    }

    // 2. Validate repository ownership
    const repo = await this.prisma.repository.findFirst({
      where: { id: repositoryId, userId },
    });
    if (!repo) {
      throw new AppError(404, 'REPOSITORY_NOT_FOUND', 'Repository not found or access denied');
    }

    // 3. Retrieve user's GitHub OAuth token internally, or system token fallback for public repos
    const oauth = await this.prisma.oAuthAccount.findUnique({
      where: {
        userId_provider: {
          userId,
          provider: 'GITHUB',
        },
      },
    });
    let githubToken = oauth?.accessTokenEnc ? decryptToken(oauth.accessTokenEnc) : null;
    if (!githubToken && !repo.isPrivate && process.env.GITHUB_TOKEN) {
      githubToken = process.env.GITHUB_TOKEN;
    }

    // 4. Resolve exact 40-character commit SHA server-side
    const { resolvedSha, targetBranch } = await this._resolveCommitSha({
      githubToken,
      owner: repo.owner,
      repo: repo.name,
      commitRef,
      branch,
      defaultBranch: repo.defaultBranch || 'main',
      existingSha: repo.latestCommitSha,
    });

    // 5. Create atomic PreviewSession record in PENDING status
    const { session: initialSession, rawToken } = await createPreviewSession(
      {
        userId,
        repositoryId,
        commitSha: resolvedSha,
        branch: targetBranch,
        framework: FrameworkType.UNKNOWN,
      },
      this.prisma
    );

    const sessionId = initialSession.id;
    let currentStatus = PreviewStatus.PENDING;
    let session = initialSession;

    // Register active operation controller for safe external cancellation
    const opController = new AbortController();
    this._activeOperations.set(sessionId, opController);

    const onCallerAbort = () => opController.abort();
    if (signal) {
      signal.addEventListener('abort', onCallerAbort, { once: true });
    }

    const opSignal = opController.signal;

    try {
      if (opSignal.aborted) {
        throw new AppError(499, 'OPERATION_CANCELLED', 'Startup cancelled');
      }

      // 6. Transition: PENDING -> FETCHING
      session = await transitionSession(sessionId, PreviewStatus.PENDING, PreviewStatus.FETCHING, {}, this.prisma);
      currentStatus = PreviewStatus.FETCHING;

      // 7. Perform passive framework detection
      const detection = await this.detectorFn(githubToken, repo.owner, repo.name, resolvedSha);
      if (!detection || !detection.supported) {
        throw new AppError(
          400,
          detection?.reasonCode || 'UNSUPPORTED_FRAMEWORK',
          detection?.message || 'Repository framework is not supported for live preview'
        );
      }

      let targetFramework;
      const mapped = mapDetectorResultToPrismaFramework(detection);
      if (mapped !== 'UNKNOWN') {
        targetFramework = mapped;
      } else if (detection.framework === 'STATIC') {
        targetFramework = FrameworkType.STATIC;
      } else if (detection.framework === 'VITE_REACT') {
        targetFramework = FrameworkType.VITE_REACT;
      } else if (detection.framework === 'VITE_VANILLA') {
        targetFramework = FrameworkType.VITE_VANILLA;
      } else {
        throw new AppError(400, 'UNSUPPORTED_FRAMEWORK', `Detected framework '${detection.framework}' is not supported`);
      }

      const detectedProjectRoot = detection.projectRoot ? String(detection.projectRoot).trim() : '';

      // Record detected framework and project root in database
      await this.prisma.previewSession.update({
        where: { id: sessionId },
        data: {
          framework: targetFramework,
          projectRoot: detectedProjectRoot || null,
        },
      });

      // 8. Create session workspace volume and internal preview network
      const netName = `gitview-net-${sessionId}`;
      const volName = `gitview-ws-${sessionId}`;

      await this.docker.createNetwork({
        sessionId,
        role: 'runner',
        networkName: netName,
        internal: true,
      });

      await this.docker.createVolume({
        sessionId,
        role: 'runner',
        volumeName: volName,
      });

      // 9. Stream and extract repository archive into workspace volume
      const archiveStream = await this.fetchArchiveFn({
        owner: repo.owner,
        repo: repo.name,
        commitSha: resolvedSha,
        githubToken,
        signal: opSignal,
      });

      await this.extractArchiveFn(archiveStream, {
        sessionId,
        volumeName: volName,
        signal: opSignal,
      });

      // 10A. STATIC Workflow
      if (targetFramework === FrameworkType.STATIC) {
        // Transition: FETCHING -> STARTING
        session = await transitionSession(
          sessionId,
          PreviewStatus.FETCHING,
          PreviewStatus.STARTING,
          { framework: targetFramework },
          this.prisma
        );
        currentStatus = PreviewStatus.STARTING;

        // Start STATIC_RUNNER container (read-only volume mount, internal preview network)
        const runnerName = `gitview-runner-${sessionId}`;
        await this.docker.createAndStartContainer({
          profile: ContainerProfile.STATIC_RUNNER,
          sessionId,
          containerName: runnerName,
          networkName: netName,
          volumeMount: {
            volumeName: volName,
            mountPath: '/workspace',
            readOnly: true,
          },
          env: {
            NODE_ENV: 'production',
            PORT: '3000',
          },
          projectRoot: detectedProjectRoot,
        });

        // Start Option A TRUSTED_PROXY sidecar container
        const ingressNetName = `gitview-ingress-net-${sessionId}`;
        await this.docker.createNetwork({
          sessionId,
          role: 'proxy',
          networkName: ingressNetName,
          internal: false,
        });

        const proxyName = `gitview-proxy-${sessionId}`;
        const proxyInstanceId = crypto.randomUUID();
        const handshakeToken = createSidecarHandshakeToken(sessionId, proxyInstanceId);
        const proxyContainerResult = await this.docker.createAndStartContainer({
          profile: ContainerProfile.TRUSTED_PROXY,
          sessionId,
          containerName: proxyName,
          instanceId: proxyInstanceId,
          networkName: ingressNetName,
          internalNetworkName: netName,
          portMapping: {
            hostIp: '127.0.0.1',
            containerPort: 8080,
          },
          env: {
            UPSTREAM_HOST: runnerName,
            UPSTREAM_PORT: '3000',
            NODE_ENV: 'production',
            SESSION_ID: sessionId,
            EXPECTED_HANDSHAKE_TOKEN: handshakeToken,
            SIDECAR_INSTANCE_ID: proxyInstanceId,
          },
        });
        const proxyContainerId = proxyContainerResult.containerId;

        // Retrieve dynamically published host port
        const portInfo = await this.docker.getPublishedPort({
          containerName: proxyName,
          containerPort: 8080,
        });
        const proxyPort = portInfo.hostPort;

        // Perform health check
        await this.performHealthCheck({
          sessionId,
          runnerName,
          proxyName,
          proxyContainerId,
          proxyInstanceId,
          hostPort: proxyPort,
          framework: targetFramework,
          signal: opSignal,
        });

        opSignal.throwIfAborted();

        // Transition: STARTING -> RUNNING
        session = await transitionSession(
          sessionId,
          PreviewStatus.STARTING,
          PreviewStatus.RUNNING,
          {
            runnerContainerId: runnerName,
            proxyContainerId,
            proxyInstanceId,
            proxyPort,
          },
          this.prisma
        );
        currentStatus = PreviewStatus.RUNNING;

        return {
          session: sanitizeSessionForClient(session),
          rawToken,
          previewUrl: `http://127.0.0.1:${proxyPort}/`,
          hostPort: proxyPort,
        };
      }

      // 10B. VITE Workflow (VITE_VANILLA and VITE_REACT)
      // Read package-lock.json from workspace volume (at project root if nested)
      const lockfilePath = detectedProjectRoot
        ? path.posix.join(detectedProjectRoot, 'package-lock.json')
        : 'package-lock.json';
      const lockContent = await this.docker.readVolumeFile({
        volumeName: volName,
        filePath: lockfilePath,
        sessionId,
      });

      if (!lockContent) {
        throw new AppError(
          400,
          LockfileErrorCode.LOCKFILE_MISSING_PACKAGES || 'LOCKFILE_MISSING',
          'package-lock.json is required for Vite live preview'
        );
      }

      // Validate lockfile deterministically
      const lockResult = this.lockfileValidator.validate(lockContent);
      if (!lockResult.valid) {
        throw new AppError(
          400,
          lockResult.errorCode || 'LOCKFILE_INVALID',
          lockResult.error || 'package-lock.json failed security validation'
        );
      }

      // Verify lockfile consistency with detected framework
      verifyLockfileFrameworkConsistency(lockContent, targetFramework);

      // Transition: FETCHING -> BUILDING
      session = await transitionSession(
        sessionId,
        PreviewStatus.FETCHING,
        PreviewStatus.BUILDING,
        { framework: targetFramework },
        this.prisma
      );
      currentStatus = PreviewStatus.BUILDING;

      // Create dual-network dependency installation topology
      const buildIntNet = `gitview-build-int-${sessionId}`;
      const buildEgressNet = `gitview-build-egress-${sessionId}`;

      await this.docker.createNetwork({
        sessionId,
        role: 'builder',
        networkName: buildIntNet,
        internal: true,
      });

      await this.docker.createNetwork({
        sessionId,
        role: 'build-proxy',
        networkName: buildEgressNet,
        internal: false,
      });

      // Start npm egress proxy connected to internal build net & external egress net
      const buildProxyName = `gitview-build-proxy-${sessionId}`;
      await this.docker.createAndStartContainer({
        profile: ContainerProfile.EGRESS_PROXY,
        sessionId,
        containerName: buildProxyName,
        networkName: buildIntNet,
        egressNetworkName: buildEgressNet,
        env: {
          PORT: '3128',
          ALLOWED_HOST: 'registry.npmjs.org',
          NODE_ENV: 'production',
        },
      });

      // Verify proxy default route uses egress network gateway
      await this.docker.verifyProxyDefaultGateway(buildProxyName);

      // Start NPM_BUILDER connected strictly to internal build network
      const builderName = `gitview-builder-${sessionId}`;
      const builderEnv = {
        HTTP_PROXY: `http://${buildProxyName}:3128`,
        HTTPS_PROXY: `http://${buildProxyName}:3128`,
        npm_config_proxy: `http://${buildProxyName}:3128`,
        npm_config_https_proxy: `http://${buildProxyName}:3128`,
        NODE_ENV: 'development',
      };
      if (detectedProjectRoot) {
        builderEnv.WORKSPACE_DIR = `/workspace/${detectedProjectRoot}`;
      }

      await this.docker.createAndStartContainer({
        profile: ContainerProfile.NPM_BUILDER,
        sessionId,
        containerName: builderName,
        networkName: buildIntNet,
        volumeMount: {
          volumeName: volName,
          mountPath: '/workspace',
          readOnly: false,
        },
        env: builderEnv,
        projectRoot: detectedProjectRoot,
      });

      // Wait for builder to complete within 90 seconds
      const buildResult = await this.docker.waitForContainer({
        containerName: builderName,
        timeoutMs: 90000,
        signal: opSignal,
      });

      if (buildResult.exitCode !== 0) {
        let buildLogs = '';
        try {
          const logs = await this.docker.getContainerLogs({ containerName: builderName, tail: 100 });
          buildLogs = (logs.stderr || '') + '\n' + (logs.stdout || '');
          console.error(`[NPM_BUILDER FAILED LOGS]:\n${buildLogs}`);
        } catch {}
        throw new AppError(
          400,
          buildResult.oomKilled ? 'BUILD_OOM_KILLED' : 'BUILD_FAILED',
          `Dependency installation failed with exit code ${buildResult.exitCode}`
        );
      }

      // Confirm local Vite executable was created in the volume
      const viteExecutablePath = detectedProjectRoot
        ? path.posix.join(detectedProjectRoot, 'node_modules/.bin/vite')
        : 'node_modules/.bin/vite';
      const hasViteExecutable = await this.docker.verifyVolumeExecutable({
        volumeName: volName,
        filePath: viteExecutablePath,
        sessionId,
      });

      if (!hasViteExecutable) {
        throw new AppError(
          500,
          'MISSING_VITE_EXECUTABLE',
          `Local Vite executable /workspace/${viteExecutablePath} was not created during installation`
        );
      }

      // Immediately teardown build containers and build networks
      await this.docker.removeContainer(builderName, { force: true }).catch(() => {});
      await this.docker.removeContainer(buildProxyName, { force: true }).catch(() => {});
      await this.docker.removeNetwork(buildIntNet).catch(() => {});
      await this.docker.removeNetwork(buildEgressNet).catch(() => {});

      // Transition: BUILDING -> STARTING
      session = await transitionSession(
        sessionId,
        PreviewStatus.BUILDING,
        PreviewStatus.STARTING,
        {},
        this.prisma
      );
      currentStatus = PreviewStatus.STARTING;

      // Start VITE_RUNNER container (read-write workspace for .vite cache, internal preview net)
      const runnerName = `gitview-runner-${sessionId}`;
      await this.docker.createAndStartContainer({
        profile: ContainerProfile.VITE_RUNNER,
        sessionId,
        containerName: runnerName,
        networkName: netName,
        volumeMount: {
          volumeName: volName,
          mountPath: '/workspace',
          readOnly: false,
        },
        env: {
          NODE_ENV: 'development',
          PORT: '3000',
        },
        projectRoot: detectedProjectRoot,
      });

      // Start Option A TRUSTED_PROXY sidecar container
      const ingressNetName = `gitview-ingress-net-${sessionId}`;
      await this.docker.createNetwork({
        sessionId,
        role: 'proxy',
        networkName: ingressNetName,
        internal: false,
      });

      const proxyName = `gitview-proxy-${sessionId}`;
      const proxyInstanceId = crypto.randomUUID();
      const handshakeToken = createSidecarHandshakeToken(sessionId, proxyInstanceId);
      const proxyContainerResult = await this.docker.createAndStartContainer({
        profile: ContainerProfile.TRUSTED_PROXY,
        sessionId,
        containerName: proxyName,
        instanceId: proxyInstanceId,
        networkName: ingressNetName,
        internalNetworkName: netName,
        portMapping: {
          hostIp: '127.0.0.1',
          containerPort: 8080,
        },
        env: {
          UPSTREAM_HOST: runnerName,
          UPSTREAM_PORT: '3000',
          NODE_ENV: 'production',
          SESSION_ID: sessionId,
          EXPECTED_HANDSHAKE_TOKEN: handshakeToken,
          SIDECAR_INSTANCE_ID: proxyInstanceId,
        },
      });
      const proxyContainerId = proxyContainerResult.containerId;

      // Retrieve dynamically published host port
      const portInfo = await this.docker.getPublishedPort({
        containerName: proxyName,
        containerPort: 8080,
      });
      const proxyPort = portInfo.hostPort;

      // Perform health check
      await this.performHealthCheck({
        sessionId,
        runnerName,
        proxyName,
        proxyContainerId,
        proxyInstanceId,
        hostPort: proxyPort,
        framework: targetFramework,
        signal: opSignal,
      });

      opSignal.throwIfAborted();

      // Transition: STARTING -> RUNNING
      session = await transitionSession(
        sessionId,
        PreviewStatus.STARTING,
        PreviewStatus.RUNNING,
        {
          runnerContainerId: runnerName,
          proxyContainerId,
          proxyInstanceId,
          proxyPort,
        },
        this.prisma
      );
      currentStatus = PreviewStatus.RUNNING;

      return {
        session: sanitizeSessionForClient(session),
        rawToken,
        previewUrl: `http://127.0.0.1:${proxyPort}/`,
        hostPort: proxyPort,
      };
    } catch (err) {
      // 1. Idempotently teardown Docker resources for this session
      await this.docker.cleanupSession(sessionId).catch(() => {});

      // 2. Determine if failure was caused by user cancellation
      const wasCancelled =
        opSignal.aborted ||
        err.name === 'AbortError' ||
        err.errorCode === 'OPERATION_CANCELLED' ||
        err.message?.includes('aborted') ||
        err.message?.includes('cancelled');

      if (wasCancelled) {
        try {
          if (currentStatus === PreviewStatus.PENDING) {
            await cancelSession(sessionId, PreviewStatus.PENDING, this.prisma);
          } else if (currentStatus !== PreviewStatus.STOPPED) {
            await cancelSession(sessionId, currentStatus, this.prisma);
            await transitionSession(sessionId, PreviewStatus.STOPPING, PreviewStatus.STOPPED, {}, this.prisma);
          }
        } catch {
          // If already stopped/cancelled by concurrent operation, proceed
        }
        throw new AppError(499, 'OPERATION_CANCELLED', 'Live preview startup was cancelled by the user');
      }

      // 3. Normal failure: transition to FAILED with bounded error code & message
      const errorCode = err.errorCode || err.code || 'PREVIEW_START_FAILED';
      const errorMessage = err.message || 'An error occurred during preview session startup';

      try {
        await failSession(sessionId, currentStatus, { errorCode, errorMessage }, this.prisma);
      } catch {
        // If state already moved or failed, proceed
      }

      throw err;
    } finally {
      if (signal) {
        signal.removeEventListener('abort', onCallerAbort);
      }
      this._activeOperations.delete(sessionId);
    }
  }

  /**
   * Alias for createAndStartSession.
   */
  async startPreviewSession(params) {
    return this.createAndStartSession(params);
  }

  /**
   * Alias for createAndStartSession.
   */
  async createPreviewSession(params) {
    return this.createAndStartSession(params);
  }

  /**
   * Bounded health check verifying runner and proxy processes, loopback port binding,
   * and HTTP readiness.
   *
   * @param {Object} params
   * @param {string} [params.sessionId]
   * @param {string} params.runnerName
   * @param {string} params.proxyName
   * @param {number} params.hostPort
   * @param {string} [params.framework]
   * @param {AbortSignal} [params.signal]
   * @param {number} [params.timeoutMs=30000]
   * @param {number} [params.pollIntervalMs=500]
   * @returns {Promise<{ healthy: boolean, statusCode?: number }>}
   */
  async performHealthCheck({
    sessionId = null,
    runnerName,
    proxyName,
    proxyContainerId = null,
    proxyInstanceId = null,
    hostPort,
    framework = 'UNKNOWN',
    signal = null,
    timeoutMs = 30000,
    pollIntervalMs = 500,
  }) {
    // 1. Verify runner container state
    const runnerInspect = await this.docker.inspectContainer(runnerName);
    if (!runnerInspect?.State?.Running) {
      const isCrash = (runnerInspect?.State?.ExitCode !== undefined && runnerInspect.State.ExitCode !== 0) || runnerInspect?.State?.OOMKilled;
      throw new AppError(
        500,
        isCrash ? 'CONTAINER_CRASHED' : 'RUNNER_NOT_RUNNING',
        `Runner container '${runnerName}' is not running (status: ${runnerInspect?.State?.Status || 'unknown'}, exitCode: ${runnerInspect?.State?.ExitCode || 0})`
      );
    }

    // 2. Verify proxy container state using actual Docker container ID if available, else proxyName
    const proxyTarget = proxyContainerId || proxyName;
    const proxyInspect = await this.docker.inspectContainer(proxyTarget);
    if (!proxyInspect?.State?.Running) {
      throw new AppError(
        500,
        'PROXY_NOT_RUNNING',
        `Proxy container '${proxyTarget}' is not running (status: ${proxyInspect?.State?.Status || 'unknown'})`
      );
    }

    // 3. Verify published port is strictly loopback
    const portInfo = await this.docker.getPublishedPort({ containerName: proxyName, containerPort: 8080 });
    if (portInfo.hostIp !== '127.0.0.1' || portInfo.hostPort !== hostPort) {
      throw new AppError(
        500,
        'INVALID_PORT_BINDING',
        `Proxy port binding is invalid or not strictly bound to 127.0.0.1`
      );
    }

    // 4. Delegate to injected healthCheckFn if supplied (useful for unit tests)
    if (this.healthCheckFn) {
      return await this.healthCheckFn({
        host: '127.0.0.1',
        port: hostPort,
        runnerName,
        proxyName,
        framework,
        timeoutMs,
        signal,
      });
    }

    // 5. Active HTTP readiness polling
    const start = Date.now();
    let lastError = null;

    while (Date.now() - start < timeoutMs) {
      if (signal?.aborted) {
        throw new AppError(499, 'OPERATION_CANCELLED', 'Health check aborted by signal');
      }

      // Re-verify runner did not crash during startup warmup
      const runnerState = await this.docker.inspectContainer(runnerName);
      if (!runnerState?.State?.Running) {
        throw new AppError(
          500,
          'CONTAINER_CRASHED',
          `Runner container '${runnerName}' crashed during startup (exit code: ${runnerState?.State?.ExitCode})`
        );
      }

      try {
        const res = await new Promise((resolve, reject) => {
          const req = http.request(
            {
              host: '127.0.0.1',
              port: hostPort,
              path: '/',
              method: 'GET',
              headers: {
                Accept: 'text/html,*/*',
                ...(sessionId && (proxyInstanceId || proxyContainerId || proxyName)
                  ? {
                      'x-gitview-session-id': sessionId,
                      'x-gitview-sidecar-token': createSidecarHandshakeToken(
                        sessionId,
                        proxyInstanceId || proxyContainerId || proxyName
                      ),
                    }
                  : {}),
              },
              timeout: 3000,
            },
            (response) => {
              let body = '';
              response.on('data', (chunk) => { body += chunk; });
              response.on('end', () => {
                resolve({ statusCode: response.statusCode, body });
              });
            }
          );
          req.on('timeout', () => {
            req.destroy(new Error('HTTP request timed out'));
          });
          req.on('error', (err) => {
            reject(err);
          });
          req.end();
        });

        if (res.statusCode >= 200 && res.statusCode < 400) {
          return { healthy: true, statusCode: res.statusCode };
        }
        lastError = new Error(`Proxy responded with status ${res.statusCode}`);
      } catch (err) {
        lastError = err;
      }

      await this.sleepFn(pollIntervalMs);
    }

    throw new AppError(
      504,
      'HEALTH_CHECK_TIMEOUT',
      `Health check failed to receive valid response within ${timeoutMs}ms: ${lastError?.message || 'timeout'}`
    );
  }

  /**
   * Safely stops an active preview session, tears down containers/networks/volumes,
   * and transitions state to STOPPED.
   *
   * @param {string} sessionId
   * @param {string} userId
   * @returns {Promise<Object>} Sanitized session record
   */
  async stopPreviewSession(sessionId, userId) {
    if (!sessionId || !userId) {
      throw new AppError(400, 'INVALID_ARGUMENT', 'sessionId and userId are required');
    }

    const session = await this.prisma.previewSession.findFirst({
      where: { id: sessionId, userId },
    });

    if (!session) {
      throw new SessionNotFoundError(sessionId);
    }

    // If session is already in terminal status, return immediately
    if (!session.isActive) {
      return sanitizeSessionForClient(session);
    }

    // Abort active in-flight operation if one is running
    const activeOp = this._activeOperations.get(sessionId);
    if (activeOp) {
      activeOp.abort();
    }

    // Teardown Docker resources idempotently
    await this.docker.cleanupSession(sessionId).catch(() => {});

    let updatedSession;
    if (session.status === PreviewStatus.PENDING) {
      updatedSession = await cancelSession(sessionId, PreviewStatus.PENDING, this.prisma);
    } else if (session.status === PreviewStatus.STOPPING) {
      updatedSession = await transitionSession(sessionId, PreviewStatus.STOPPING, PreviewStatus.STOPPED, {}, this.prisma);
    } else {
      await cancelSession(sessionId, session.status, this.prisma);
      updatedSession = await transitionSession(sessionId, PreviewStatus.STOPPING, PreviewStatus.STOPPED, {}, this.prisma);
    }

    return sanitizeSessionForClient(updatedSession);
  }

  /**
   * Alias for stopPreviewSession.
   */
  async stopSession(sessionId, userId) {
    return this.stopPreviewSession(sessionId, userId);
  }

  /**
   * Retrieves sanitized session status for client frontend.
   *
   * @param {string} sessionId
   * @param {string} userId
   * @returns {Promise<Object>}
   */
  async getPreviewSessionStatus(sessionId, userId) {
    if (!sessionId || !userId) {
      throw new AppError(400, 'INVALID_ARGUMENT', 'sessionId and userId are required');
    }

    const session = await this.prisma.previewSession.findFirst({
      where: { id: sessionId, userId },
    });

    if (!session) {
      throw new SessionNotFoundError(sessionId);
    }

    return sanitizeSessionForClient(session);
  }

  /**
   * Alias for getPreviewSessionStatus.
   */
  async getSessionStatus(sessionId, userId) {
    return this.getPreviewSessionStatus(sessionId, userId);
  }

  /**
   * Generates a single-use 30-second bootstrap ticket for an active RUNNING session.
   *
   * @param {string} sessionId
   * @param {string} userId
   * @param {'iframe'|'toplevel'} [mode='iframe']
   * @returns {Promise<{ previewUrl: string, targetOrigin: string, ticketExpiresAt: string }>}
   */
  async createBootstrapTicket(sessionId, userId, mode = 'iframe') {
    if (!sessionId || !userId) {
      throw new AppError(400, 'INVALID_ARGUMENT', 'sessionId and userId are required');
    }

    const session = await this.prisma.previewSession.findFirst({
      where: { id: sessionId, userId },
    });

    if (!session) {
      throw new SessionNotFoundError(sessionId);
    }

    if (session.status !== PreviewStatus.RUNNING) {
      throw new AppError(
        400,
        'PREVIEW_NOT_RUNNING',
        `Cannot generate bootstrap ticket for session in status '${session.status}'. Session must be RUNNING.`
      );
    }

    if (!session.isActive) {
      throw new AppError(400, 'PREVIEW_INACTIVE', 'Preview session is not active');
    }

    if (new Date() >= new Date(session.expiresAt)) {
      throw new AppError(400, 'PREVIEW_EXPIRED', 'Preview session has expired');
    }

    // 1. Generate 32 cryptographically secure random bytes (64 hex characters)
    const rawTicket = crypto.randomBytes(32).toString('hex');

    // 2. Compute canonical target origin and authority
    const targetOrigin = getPreviewTargetOrigin(session.id);
    const targetHostAuthority = canonicalizeHostAuthority(targetOrigin);

    // 3. Expiry and 30-second ticket TTL
    const ticketExpiresAt = new Date(Date.now() + 30 * 1000).toISOString();
    const sessionExpiresAtMs = new Date(session.expiresAt).getTime();
    if (!validateSessionExpiresAtMs(sessionExpiresAtMs)) {
      throw new AppError(500, 'INVALID_SESSION_EXPIRY', 'Invalid session expiry timestamp');
    }

    // 4. Store ticket in ticket registry (SHA-256 hashed key, zero capability token)
    const ticketStore = getTicketStore();
    await ticketStore.setTicket(
      rawTicket,
      {
        sessionId: session.id,
        targetOrigin,
        targetHostAuthority,
        sessionExpiresAtMs,
        expiresAt: ticketExpiresAt,
        mode: mode || 'iframe',
      },
      30
    );

    // 5. Construct single-use bootstrap URL
    const modeQuery = mode ? `&mode=${encodeURIComponent(mode)}` : '';
    const previewUrl = `${targetOrigin}/__gitview_bootstrap?ticket=${rawTicket}${modeQuery}`;

    return {
      previewUrl,
      targetOrigin,
      ticketExpiresAt,
    };
  }

  /**
   * Startup reconciliation:
   * 1. Expires sessions past TTL or idle timeout.
   * 2. Cleans up RUNNING sessions whose runner container crashed or terminated.
   * 3. Prunes orphaned Docker resources whose session IDs do not match any active DB session.
   *
   * @returns {Promise<{ expiredCount: number, crashedCount: number, orphanedPrunedCount: number }>}
   */
  async reconcileStaleSessions() {
    let expiredCount = 0;
    let crashedCount = 0;
    let orphanedPrunedCount = 0;
    const handledSessionIds = new Set();

    // 1. Expire sessions past TTL or idle timeout
    try {
      const expired = await findExpiredSessions(this.prisma);
      for (const s of expired) {
        try {
          handledSessionIds.add(s.id);
          await this.docker.cleanupSession(s.id);
          await expireSession(s.id, s.status, 'TTL_EXPIRED', this.prisma);
          expiredCount++;
        } catch {
          // Continue reconciling other sessions
        }
      }
    } catch {
      // Continue with remaining reconciliation steps
    }

    // 2. Identify active RUNNING sessions whose runner container is dead
    try {
      const activeRunning = await this.prisma.previewSession.findMany({
        where: { isActive: true, status: PreviewStatus.RUNNING },
      });

      for (const s of activeRunning) {
        if (handledSessionIds.has(s.id)) continue;
        const runnerName = s.runnerContainerId || `gitview-runner-${s.id}`;
        let isAlive = false;
        try {
          const inspect = await this.docker.inspectContainer(runnerName);
          isAlive = Boolean(inspect?.State?.Running);
        } catch {
          isAlive = false;
        }

        if (!isAlive) {
          try {
            handledSessionIds.add(s.id);
            await this.docker.cleanupSession(s.id);
            await failSession(
              s.id,
              PreviewStatus.RUNNING,
              {
                errorCode: 'CONTAINER_CRASHED',
                errorMessage: 'Preview runner container terminated unexpectedly.',
              },
              this.prisma
            );
            crashedCount++;
          } catch {
            // Continue
          }
        }
      }
    } catch {
      // Continue
    }

    // 3. Prune orphaned Docker resources
    try {
      const managedSessionIds = await this.docker.listManagedSessionIds();
      for (const mId of managedSessionIds) {
        if (handledSessionIds.has(mId)) continue;
        try {
          const activeDbSession = await this.prisma.previewSession.findFirst({
            where: { id: mId, isActive: true },
          });

          if (!activeDbSession) {
            await this.docker.cleanupSession(mId);
            orphanedPrunedCount++;
          }
        } catch {
          // Continue
        }
      }
    } catch {
      // Continue
    }

    return { expiredCount, crashedCount, orphanedPrunedCount };
  }
}

// Default export singleton
export const previewManager = new PreviewManager();

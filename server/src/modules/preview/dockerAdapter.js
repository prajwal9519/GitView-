/**
 * GitView Phase 5 — Milestone 6, Task 2.1: Docker CLI Adapter Security Hardening
 *
 * Secure, profile-governed Docker adapter for backend orchestration of GitView-owned resources.
 * Enforces immutable image allowlisting, fixed container profiles (STATIC_RUNNER, VITE_RUNNER,
 * EXTRACTOR, NPM_BUILDER, TRUSTED_PROXY, EGRESS_PROXY), strict network attachment policies,
 * mandatory labels, dynamic loopback port verification, and idempotent session-scoped cleanup.
 */

import childProcess from 'node:child_process';
import { AppError } from '../../utils/AppError.js';

export const DockerErrorCode = Object.freeze({
  DOCKER_INVALID_ARGUMENT: 'DOCKER_INVALID_ARGUMENT',
  DOCKER_SECURITY_POLICY_VIOLATION: 'DOCKER_SECURITY_POLICY_VIOLATION',
  DOCKER_IMAGE_UNAVAILABLE: 'DOCKER_IMAGE_UNAVAILABLE',
  DOCKER_DAEMON_UNAVAILABLE: 'DOCKER_DAEMON_UNAVAILABLE',
  DOCKER_COMMAND_TIMEOUT: 'DOCKER_COMMAND_TIMEOUT',
  DOCKER_COMMAND_ABORTED: 'DOCKER_COMMAND_ABORTED',
  DOCKER_RESOURCE_NOT_FOUND: 'DOCKER_RESOURCE_NOT_FOUND',
  DOCKER_PORT_NOT_FOUND: 'DOCKER_PORT_NOT_FOUND',
  DOCKER_INVALID_PORT_BINDING: 'DOCKER_INVALID_PORT_BINDING',
  DOCKER_CONTAINER_NOT_RUNNING: 'DOCKER_CONTAINER_NOT_RUNNING',
  DOCKER_EXECUTION_FAILED: 'DOCKER_EXECUTION_FAILED',
});

export class DockerAdapterError extends AppError {
  constructor(code, message, details = null) {
    const statusCode =
      code === DockerErrorCode.DOCKER_INVALID_ARGUMENT ||
      code === DockerErrorCode.DOCKER_SECURITY_POLICY_VIOLATION
        ? 400
        : 500;
    super(statusCode, code, message);
    this.name = 'DockerAdapterError';
    this.errorCode = code;
    this.details = details;
  }
}

export const APPROVED_ROLES = Object.freeze([
  'runner',
  'proxy',
  'builder',
  'build-proxy',
  'extractor',
]);

/**
 * Immutable image allowlist.
 * Mutable tags (:latest, :edge, :main, unversioned) are strictly rejected.
 */
export const APPROVED_IMAGES = Object.freeze([
  'gitview-preview-runner:v1.0.0',
  'gitview-preview-extractor:v1.0.0',
  'gitview-preview-builder:v1.0.0',
  'gitview-npm-egress-proxy:v1.0.0',
]);

export const APPROVED_MOUNT_TARGETS = Object.freeze([
  '/app/workspace',
  '/workspace',
]);

// Strict UUID regex (standard 8-4-4-4-12 hex string)
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Strict resource name regex (must start with gitview-[a-z0-9] and be bounded)
const RESOURCE_NAME_REGEX = /^gitview-[a-z0-9][a-z0-9_-]{1,80}$/;

/**
 * Approved Container Profiles
 */
export const ContainerProfile = Object.freeze({
  STATIC_RUNNER: 'STATIC_RUNNER',
  VITE_RUNNER: 'VITE_RUNNER',
  EXTRACTOR: 'EXTRACTOR',
  NPM_BUILDER: 'NPM_BUILDER',
  TRUSTED_PROXY: 'TRUSTED_PROXY',
  EGRESS_PROXY: 'EGRESS_PROXY',
});

/**
 * Profile Specifications:
 * Defines fixed image references, security opts, caps, resource limits,
 * mount rules, network policies, port publishing policies, and allowed env keys.
 */
export const CONTAINER_PROFILES = Object.freeze({
  [ContainerProfile.STATIC_RUNNER]: Object.freeze({
    role: 'runner',
    image: 'gitview-preview-runner:v1.0.0',
    containerPrefix: 'gitview-runner-',
    user: '10001:10001',
    securityOpt: ['no-new-privileges'],
    capDrop: ['ALL'],
    readOnlyRoot: true,
    tmpfs: Object.freeze(['/tmp:rw,noexec,nosuid,size=256m']),
    resourceLimits: Object.freeze({
      memory: '512m',
      cpus: '1.0',
      pidsLimit: 64,
    }),
    mountPolicy: Object.freeze({
      allowedDestinations: ['/workspace', '/app/workspace'],
      readOnly: true,
      required: true,
    }),
    networkPolicy: Object.freeze({
      requireInternal: true,
      mode: 'internal',
    }),
    portPolicy: Object.freeze({
      allowPublishing: false,
    }),
    allowedEnv: Object.freeze(['NODE_ENV', 'PORT', 'WORKSPACE_DIR', 'PROJECT_ROOT']),
    command: Object.freeze(['node', '/usr/local/bin/gitview-serve.js', '--port', '3000', '--root', '/workspace']),
  }),

  [ContainerProfile.VITE_RUNNER]: Object.freeze({
    role: 'runner',
    image: 'gitview-preview-runner:v1.0.0',
    containerPrefix: 'gitview-runner-',
    user: '10001:10001',
    securityOpt: ['no-new-privileges'],
    capDrop: ['ALL'],
    readOnlyRoot: true,
    workdir: '/workspace',
    tmpfs: Object.freeze([
      '/tmp:rw,noexec,nosuid,size=256m',
      '/home/gitview/.npm:rw,noexec,nosuid,size=256m',
      '/home/gitview/.cache:rw,noexec,nosuid,size=256m',
    ]),
    resourceLimits: Object.freeze({
      memory: '512m',
      cpus: '1.0',
      pidsLimit: 64,
    }),
    mountPolicy: Object.freeze({
      allowedDestinations: ['/workspace', '/app/workspace'],
      readOnly: false,
      required: true,
    }),
    networkPolicy: Object.freeze({
      requireInternal: true,
      mode: 'internal',
    }),
    portPolicy: Object.freeze({
      allowPublishing: false,
    }),
    allowedEnv: Object.freeze(['NODE_ENV', 'PORT', 'WORKSPACE_DIR', 'PROJECT_ROOT']),
    command: Object.freeze([
      '/workspace/node_modules/.bin/vite',
      '--host',
      '0.0.0.0',
      '--port',
      '3000',
      '--strictPort',
      '/workspace',
    ]),
  }),

  [ContainerProfile.EXTRACTOR]: Object.freeze({
    role: 'extractor',
    image: 'gitview-preview-extractor:v1.0.0',
    containerPrefix: 'gitview-extractor-',
    user: '10001:10001',
    securityOpt: ['no-new-privileges'],
    capDrop: ['ALL'],
    resourceLimits: Object.freeze({
      memory: '512m',
      cpus: '1.0',
      pidsLimit: 64,
    }),
    mountPolicy: Object.freeze({
      allowedDestinations: ['/workspace'],
      readOnly: false,
      required: true,
    }),
    networkPolicy: Object.freeze({
      mode: 'none',
    }),
    portPolicy: Object.freeze({
      allowPublishing: false,
    }),
    allowedEnv: Object.freeze(['GITVIEW_MAX_ENTRIES', 'GITVIEW_MAX_TOTAL_BYTES', 'GITVIEW_STRIP_COMPONENTS']),
    command: Object.freeze(['node', '/app/gitview-extract.js']),
  }),

  [ContainerProfile.TRUSTED_PROXY]: Object.freeze({
    role: 'proxy',
    image: 'gitview-preview-runner:v1.0.0',
    containerPrefix: 'gitview-proxy-',
    user: '10001:10001',
    securityOpt: ['no-new-privileges'],
    capDrop: ['ALL'],
    resourceLimits: Object.freeze({
      memory: '256m',
      cpus: '0.5',
      pidsLimit: 64,
    }),
    mountPolicy: Object.freeze({
      allowedDestinations: [],
      required: false,
    }),
    networkPolicy: Object.freeze({
      mode: 'dual-proxy',
    }),
    portPolicy: Object.freeze({
      allowPublishing: true,
      requireLoopback: true,
      defaultContainerPort: 8080,
    }),
    allowedEnv: Object.freeze([
      'UPSTREAM_HOST',
      'UPSTREAM_PORT',
      'PROXY_PORT',
      'NODE_ENV',
      'SESSION_ID',
      'EXPECTED_HANDSHAKE_TOKEN',
      'GITVIEW_SESSION_ID',
      'GITVIEW_EXPECTED_HANDSHAKE_TOKEN',
      'SIDECAR_INSTANCE_ID',
      'GITVIEW_SIDECAR_INSTANCE_ID',
    ]),
    command: Object.freeze([
      'node',
      '-e',
      "const http=require('http');const net=require('net');const crypto=require('crypto');const H=process.env.UPSTREAM_HOST||'127.0.0.1';const P=parseInt(process.env.UPSTREAM_PORT||'3000',10);const expectedToken=process.env.EXPECTED_HANDSHAKE_TOKEN||process.env.GITVIEW_EXPECTED_HANDSHAKE_TOKEN;const expectedSession=process.env.SESSION_ID||process.env.GITVIEW_SESSION_ID;function verifyHandshake(req){if(!expectedToken)return true;const sId=req.headers['x-gitview-session-id'];const tok=req.headers['x-gitview-sidecar-token'];if(!sId||!tok||typeof sId!=='string'||typeof tok!=='string')return false;if(expectedSession&&sId!==expectedSession)return false;const b1=Buffer.from(tok);const b2=Buffer.from(expectedToken);if(b1.length!==b2.length){crypto.timingSafeEqual(b1,b1);return false;}return crypto.timingSafeEqual(b1,b2);}function sanitizeHeaders(headers){const h={...headers,host:'localhost:'+P};delete h['x-gitview-session-id'];delete h['x-gitview-sidecar-token'];return h;}const s=http.createServer((req,res)=>{if(req.method==='CONNECT'){res.writeHead(405);return res.end('Method Not Allowed');}if(!verifyHandshake(req)){res.writeHead(403,{'Content-Type':'application/json','X-GitView-Handshake-Error':'true'});return res.end(JSON.stringify({error:{code:'SIDECAR_HANDSHAKE_FAILED'}}));}const opt={hostname:H,port:P,path:req.url,method:req.method,headers:sanitizeHeaders(req.headers)};const pr=http.request(opt,r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});pr.on('error',()=>res.writeHead(502).end('Bad Gateway'));req.pipe(pr);});s.on('upgrade',(req,sock,head)=>{if(!verifyHandshake(req)){sock.write('HTTP/1.1 403 Forbidden\\r\\nX-GitView-Handshake-Error: true\\r\\n\\r\\n');return sock.destroy();}const clean=sanitizeHeaders(req.headers);let h=req.method+' '+req.url+' HTTP/'+req.httpVersion+'\\r\\n';for(const[k,v]of Object.entries(clean)){h+=k+': '+v+'\\r\\n';}h+='\\r\\n';const ps=net.connect(P,H,()=>{ps.write(h);if(head&&head.length)ps.write(head);ps.pipe(sock);sock.pipe(ps);});ps.on('error',()=>sock.destroy());sock.on('error',()=>ps.destroy());});s.listen(8080,'0.0.0.0');",
    ]),
  }),

  [ContainerProfile.NPM_BUILDER]: Object.freeze({
    role: 'builder',
    image: 'gitview-preview-builder:v1.0.0',
    containerPrefix: 'gitview-builder-',
    user: '10001:10001',
    securityOpt: ['no-new-privileges'],
    capDrop: ['ALL'],
    readOnlyRoot: true,
    tmpfs: Object.freeze(['/tmp:rw,noexec,nosuid,size=256m', '/home/gitview/.npm:rw,noexec,nosuid,size=256m']),
    resourceLimits: Object.freeze({
      memory: '1024m',
      cpus: '1.0',
      pidsLimit: 128,
    }),
    mountPolicy: Object.freeze({
      allowedDestinations: ['/workspace'],
      readOnly: false,
      required: true,
    }),
    networkPolicy: Object.freeze({
      requireInternal: true,
      mode: 'internal',
    }),
    portPolicy: Object.freeze({
      allowPublishing: false,
    }),
    allowedEnv: Object.freeze(['HTTP_PROXY', 'HTTPS_PROXY', 'npm_config_proxy', 'npm_config_https_proxy', 'WORKSPACE_DIR', 'NODE_ENV']),
    command: Object.freeze(['node', '/usr/local/bin/gitview-build.js']),
  }),

  [ContainerProfile.EGRESS_PROXY]: Object.freeze({
    role: 'build-proxy',
    image: 'gitview-npm-egress-proxy:v1.0.0',
    containerPrefix: 'gitview-build-proxy-',
    user: '10001:10001',
    securityOpt: ['no-new-privileges'],
    capDrop: ['ALL'],
    readOnlyRoot: true,
    resourceLimits: Object.freeze({
      memory: '256m',
      cpus: '0.5',
      pidsLimit: 64,
    }),
    mountPolicy: Object.freeze({
      allowedDestinations: [],
      required: false,
    }),
    networkPolicy: Object.freeze({
      mode: 'dual-proxy',
    }),
    portPolicy: Object.freeze({
      allowPublishing: false,
      defaultContainerPort: 3128,
    }),
    allowedEnv: Object.freeze(['PORT', 'ALLOWED_HOST', 'EGRESS_PROXY_DNS_SERVER', 'NODE_ENV']),
    command: Object.freeze(['node', '/usr/local/bin/gitview-egress-proxy.js']),
  }),
});

/**
 * Sanitizes command output and error messages to prevent leakage of credentials or tokens.
 *
 * @param {string} text
 * @returns {string}
 */
export function sanitizeOutput(text) {
  if (!text) return '';
  return text
    .replace(/ghp_[a-zA-Z0-9]{36}/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/gho_[a-zA-Z0-9]{36}/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/Bearer\s+[a-zA-Z0-9._-]+/gi, 'Bearer [REDACTED_BEARER_TOKEN]')
    .replace(/[0-9a-f]{64}/g, (match) => match.slice(0, 8) + '...[REDACTED_HASH]');
}

/**
 * Core Docker child process executor using spawn with shell: false.
 */
function executeDockerCommand(spawnFn, args, { timeoutMs = 30000, maxBufferBytes = 1048576, signal } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let timeoutTimer = null;
    let killTimer = null;

    if (signal?.aborted) {
      return reject(new DockerAdapterError(DockerErrorCode.DOCKER_COMMAND_ABORTED, 'Docker command aborted prior to execution'));
    }

    let child;
    try {
      child = spawnFn('docker', args, { shell: false });
    } catch (err) {
      return reject(new DockerAdapterError(DockerErrorCode.DOCKER_EXECUTION_FAILED, `Failed to spawn docker process: ${err.message}`));
    }

    const abortHandler = () => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
      }, 2000);
      reject(new DockerAdapterError(DockerErrorCode.DOCKER_COMMAND_ABORTED, 'Docker command was aborted by signal'));
    };

    if (signal) {
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch {}
        }, 2000);
      }, timeoutMs);
    }

    child.stdout?.on('data', (chunk) => {
      if (stdoutBytes < maxBufferBytes) {
        const remaining = maxBufferBytes - stdoutBytes;
        stdout += chunk.toString('utf8', 0, remaining);
      }
      stdoutBytes += chunk.length;
    });

    child.stderr?.on('data', (chunk) => {
      if (stderrBytes < maxBufferBytes) {
        const remaining = maxBufferBytes - stderrBytes;
        stderr += chunk.toString('utf8', 0, remaining);
      }
      stderrBytes += chunk.length;
    });

    child.on('error', (err) => {
      cleanup();
      if (err.code === 'ENOENT') {
        return reject(new DockerAdapterError(DockerErrorCode.DOCKER_DAEMON_UNAVAILABLE, 'Docker executable not found on host system'));
      }
      return reject(new DockerAdapterError(DockerErrorCode.DOCKER_EXECUTION_FAILED, `Docker process error: ${err.message}`));
    });

    child.on('close', (code) => {
      cleanup();
      if (timedOut) {
        return reject(new DockerAdapterError(DockerErrorCode.DOCKER_COMMAND_TIMEOUT, `Docker command timed out after ${timeoutMs}ms`));
      }

      if (code === 0) {
        return resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 });
      }

      const sanitizedStderr = sanitizeOutput(stderr.trim());

      if (
        sanitizedStderr.includes('Cannot connect to the Docker daemon') ||
        sanitizedStderr.includes('Is the docker daemon running?') ||
        sanitizedStderr.includes('connection refused')
      ) {
        return reject(new DockerAdapterError(DockerErrorCode.DOCKER_DAEMON_UNAVAILABLE, 'Docker daemon is unavailable or not running: ' + sanitizedStderr));
      }

      if (
        sanitizedStderr.includes('No such') ||
        sanitizedStderr.includes('not found') ||
        sanitizedStderr.includes('no such volume')
      ) {
        return reject(new DockerAdapterError(DockerErrorCode.DOCKER_RESOURCE_NOT_FOUND, sanitizedStderr));
      }

      return reject(new DockerAdapterError(DockerErrorCode.DOCKER_EXECUTION_FAILED, `Docker command failed (exit code ${code}): ${sanitizedStderr}`));
    });

    function cleanup() {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (signal) signal.removeEventListener('abort', abortHandler);
    }
  });
}

/**
 * DockerAdapter
 * Secure, strongly-typed wrapper for Docker CLI management of GitView resources.
 */
export class DockerAdapter {
  constructor({ spawnFn = childProcess.spawn, defaultTimeoutMs = 30000 } = {}) {
    this.spawnFn = spawnFn;
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  // --- Validation Helpers ---

  validateSessionId(sessionId) {
    if (typeof sessionId !== 'string' || !UUID_REGEX.test(sessionId)) {
      throw new DockerAdapterError(
        DockerErrorCode.DOCKER_INVALID_ARGUMENT,
        `Invalid session ID '${sessionId}': must be a valid standard UUID`
      );
    }
    return sessionId;
  }

  validateResourceName(name) {
    if (typeof name !== 'string' || !RESOURCE_NAME_REGEX.test(name)) {
      throw new DockerAdapterError(
        DockerErrorCode.DOCKER_INVALID_ARGUMENT,
        `Invalid resource name '${name}': must match pattern ${RESOURCE_NAME_REGEX}`
      );
    }
    return name;
  }

  validateRole(role) {
    if (!APPROVED_ROLES.includes(role)) {
      throw new DockerAdapterError(
        DockerErrorCode.DOCKER_INVALID_ARGUMENT,
        `Unapproved resource role '${role}'. Approved roles: ${APPROVED_ROLES.join(', ')}`
      );
    }
    return role;
  }

  validateImage(image) {
    if (typeof image !== 'string') {
      throw new DockerAdapterError(DockerErrorCode.DOCKER_INVALID_ARGUMENT, 'Image must be a string');
    }

    // Reject mutable image tags
    if (
      image.endsWith(':latest') ||
      image.endsWith(':edge') ||
      image.endsWith(':main') ||
      image.endsWith(':master') ||
      !image.includes(':')
    ) {
      throw new DockerAdapterError(
        DockerErrorCode.DOCKER_SECURITY_POLICY_VIOLATION,
        `Mutable image tag is forbidden: '${image}'. Only immutable versioned tags or pinned digests are permitted.`
      );
    }

    // Must be in approved list or pinned by digest
    if (!APPROVED_IMAGES.includes(image) && !image.includes('@sha256:')) {
      throw new DockerAdapterError(
        DockerErrorCode.DOCKER_INVALID_ARGUMENT,
        `Unapproved container image '${image}'. Approved images: ${APPROVED_IMAGES.join(', ')}`
      );
    }
    return image;
  }

  validatePort(port) {
    const num = typeof port === 'number' ? port : parseInt(port, 10);
    if (isNaN(num) || num < 1024 || num > 65535) {
      throw new DockerAdapterError(
        DockerErrorCode.DOCKER_INVALID_ARGUMENT,
        `Invalid port '${port}': must be an integer between 1024 and 65535`
      );
    }
    return num;
  }

  validateProfile(profile) {
    if (!Object.values(ContainerProfile).includes(profile)) {
      throw new DockerAdapterError(
        DockerErrorCode.DOCKER_INVALID_ARGUMENT,
        `Invalid container profile '${profile}'. Approved profiles: ${Object.values(ContainerProfile).join(', ')}`
      );
    }
    return profile;
  }

  buildStandardLabels(sessionId, role) {
    const validatedSession = this.validateSessionId(sessionId);
    const validatedRole = this.validateRole(role);
    return [
      'com.gitview.managed=true',
      `com.gitview.session-id=${validatedSession}`,
      `com.gitview.role=${validatedRole}`,
      `com.gitview.created-at=${new Date().toISOString()}`,
    ];
  }

  /**
   * Private executor internal to the adapter.
   */
  async #execute(args, options = {}) {
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    return executeDockerCommand(this.spawnFn, args, { ...options, timeoutMs });
  }

  // --- Network Management ---

  async createNetwork({ sessionId, role = 'runner', networkName = null, internal = false } = {}) {
    if (internal) {
      return this.createInternalNetwork({ sessionId, role, networkName });
    }
    return this.createBridgeNetwork({ sessionId, role, networkName });
  }

  async createInternalNetwork({ sessionId, role = 'runner', networkName = null }) {
    this.validateSessionId(sessionId);
    this.validateRole(role);
    const name = networkName ? this.validateResourceName(networkName) : `gitview-net-${sessionId}`;

    const args = ['network', 'create', '--internal'];
    const labels = this.buildStandardLabels(sessionId, role);
    for (const label of labels) {
      args.push('--label', label);
    }
    args.push(name);

    await this.#execute(args);
    return { networkName: name, internal: true };
  }

  async createBridgeNetwork({ sessionId, role = 'proxy', networkName = null }) {
    this.validateSessionId(sessionId);
    this.validateRole(role);
    const name = networkName ? this.validateResourceName(networkName) : `gitview-ingress-net-${sessionId}`;

    const args = ['network', 'create'];
    const labels = this.buildStandardLabels(sessionId, role);
    for (const label of labels) {
      args.push('--label', label);
    }
    args.push(name);

    await this.#execute(args);
    return { networkName: name, internal: false };
  }

  async connectContainerToNetwork({ containerName, networkName, sessionId = null, role = null, gwPriority = null }) {
    this.validateResourceName(containerName);
    this.validateResourceName(networkName);

    // If role and sessionId provided, verify attachment policy before connecting
    if (role && sessionId) {
      await this.enforceNetworkPolicy(role, networkName, sessionId);
    }

    const args = ['network', 'connect'];
    if (gwPriority !== null && gwPriority !== undefined) {
      const p = parseInt(gwPriority, 10);
      if (isNaN(p) || p < 0 || p > 1000) {
        throw new DockerAdapterError(DockerErrorCode.DOCKER_INVALID_ARGUMENT, 'Invalid gwPriority: must be an integer between 0 and 1000');
      }
      args.push('--gw-priority', String(p));
    }
    args.push(networkName, containerName);

    await this.#execute(args);
    return { connected: true };
  }

  async disconnectContainerFromNetwork({ containerName, networkName }) {
    this.validateResourceName(containerName);
    this.validateResourceName(networkName);
    await this.#execute(['network', 'disconnect', networkName, containerName]);
    return { disconnected: true };
  }

  async inspectNetwork(networkName) {
    this.validateResourceName(networkName);
    const res = await this.#execute(['network', 'inspect', networkName]);
    try {
      const parsed = JSON.parse(res.stdout);
      return Array.isArray(parsed) ? parsed[0] : parsed;
    } catch (err) {
      throw new DockerAdapterError(DockerErrorCode.DOCKER_EXECUTION_FAILED, `Failed to parse network inspect JSON: ${err.message}`);
    }
  }

  async removeNetwork(networkName) {
    this.validateResourceName(networkName);
    try {
      await this.#execute(['network', 'rm', networkName]);
      return { removed: true };
    } catch (err) {
      if (err.errorCode === DockerErrorCode.DOCKER_RESOURCE_NOT_FOUND) {
        return { removed: false };
      }
      throw err;
    }
  }

  // --- Volume Management ---

  async createVolume({ sessionId, role = 'runner', volumeName = null }) {
    this.validateSessionId(sessionId);
    this.validateRole(role);
    const name = volumeName ? this.validateResourceName(volumeName) : `gitview-ws-${sessionId}`;

    const args = ['volume', 'create'];
    const labels = this.buildStandardLabels(sessionId, role);
    for (const label of labels) {
      args.push('--label', label);
    }
    args.push(name);

    await this.#execute(args);
    return { volumeName: name };
  }

  async inspectVolume(volumeName) {
    this.validateResourceName(volumeName);
    const res = await this.#execute(['volume', 'inspect', volumeName]);
    try {
      const parsed = JSON.parse(res.stdout);
      return Array.isArray(parsed) ? parsed[0] : parsed;
    } catch (err) {
      throw new DockerAdapterError(DockerErrorCode.DOCKER_EXECUTION_FAILED, `Failed to parse volume inspect JSON: ${err.message}`);
    }
  }

  async removeVolume(volumeName) {
    this.validateResourceName(volumeName);
    try {
      await this.#execute(['volume', 'rm', volumeName]);
      return { removed: true };
    } catch (err) {
      if (err.errorCode === DockerErrorCode.DOCKER_RESOURCE_NOT_FOUND) {
        return { removed: false };
      }
      throw err;
    }
  }

  // --- Network Policy Enforcement ---

  /**
   * Enforces role-based network policy:
   * - RUNNER: internal network only (Internal === true).
   * - BUILDER: internal build network only (Internal === true).
   * - EXTRACTOR: no network permitted.
   * - BUILD_PROXY / TRUSTED_PROXY: approved proxy networks only.
   */
  async enforceNetworkPolicy(role, networkName, sessionId) {
    if (role === 'extractor') {
      throw new DockerAdapterError(
        DockerErrorCode.DOCKER_SECURITY_POLICY_VIOLATION,
        `EXTRACTOR container cannot be connected to any network. Network mode must be 'none'.`
      );
    }

    const netInspect = await this.inspectNetwork(networkName);

    // Verify session label
    const netSessionId = netInspect.Labels?.['com.gitview.session-id'];
    if (netSessionId && netSessionId !== sessionId) {
      throw new DockerAdapterError(
        DockerErrorCode.DOCKER_SECURITY_POLICY_VIOLATION,
        `Network '${networkName}' belongs to session '${netSessionId}', not requesting session '${sessionId}'. Cross-session network attachment is forbidden.`
      );
    }

    const isInternal = Boolean(netInspect.Internal);

    if (role === 'runner') {
      if (!isInternal) {
        throw new DockerAdapterError(
          DockerErrorCode.DOCKER_SECURITY_POLICY_VIOLATION,
          `RUNNER container cannot attach to external network '${networkName}'. Runners must be connected strictly to an internal network with zero external egress.`
        );
      }
    } else if (role === 'builder') {
      if (!isInternal) {
        throw new DockerAdapterError(
          DockerErrorCode.DOCKER_SECURITY_POLICY_VIOLATION,
          `BUILDER container cannot attach to external network '${networkName}'. Builders must be connected strictly to an internal build network.`
        );
      }
    }
  }

  // --- Container Management (Governed by Profiles) ---

  validateProjectRoot(projectRoot) {
    if (projectRoot === null || projectRoot === undefined || projectRoot === '') {
      return '';
    }
    if (typeof projectRoot !== 'string') {
      throw new DockerAdapterError(DockerErrorCode.DOCKER_INVALID_ARGUMENT, 'projectRoot must be a string');
    }
    const trimmed = projectRoot.trim().replace(/\\/g, '/');
    if (!trimmed || trimmed === '.') return '';

    if (trimmed.startsWith('/') || trimmed.includes('\0') || trimmed.includes('..') || /%2e/i.test(trimmed)) {
      throw new DockerAdapterError(
        DockerErrorCode.DOCKER_SECURITY_POLICY_VIOLATION,
        `Invalid or unsafe projectRoot '${projectRoot}': path traversal or absolute path detected`
      );
    }

    const clean = trimmed.replace(/^\/+|\/+$/g, '');
    if (!clean || clean === '.') return '';

    if (!/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(clean)) {
      throw new DockerAdapterError(
        DockerErrorCode.DOCKER_SECURITY_POLICY_VIOLATION,
        `Invalid characters in projectRoot '${projectRoot}'`
      );
    }

    return clean;
  }

  /**
   * Spawns a container governed strictly by its approved ContainerProfile.
   * Rejects caller-controlled arbitrary commands or unapproved environment variables.
   */
  async createAndStartContainer({
    profile,
    sessionId,
    containerName = null,
    instanceId = null,
    networkName = null,
    ingressNetworkName = null,
    egressNetworkName = null,
    internalNetworkName = null,
    volumeMount = null,
    portMapping = null,
    env = null,
    command = null,
    projectRoot = null,
  }) {
    this.validateSessionId(sessionId);
    this.validateProfile(profile);
    const cleanProjectRoot = this.validateProjectRoot(projectRoot);

    const spec = CONTAINER_PROFILES[profile];

    // Check image availability
    if (!spec.image) {
      throw new DockerAdapterError(
        DockerErrorCode.DOCKER_IMAGE_UNAVAILABLE,
        `Container profile '${profile}' image is not yet implemented or verified (gated behind Task 3).`
      );
    }

    this.validateImage(spec.image);

    // Arbitrary command rejection
    if (command !== null && command !== undefined) {
      throw new DockerAdapterError(
        DockerErrorCode.DOCKER_SECURITY_POLICY_VIOLATION,
        `Arbitrary command execution is forbidden for profile '${profile}'. Commands are fixed by profile.`
      );
    }

    // Default container name from profile prefix
    const name = containerName
      ? this.validateResourceName(containerName)
      : `${spec.containerPrefix}${sessionId}`;

    const args = ['run', '-d', '--name', name];

    // Apply security options from profile
    for (const opt of spec.securityOpt) {
      args.push(`--security-opt=${opt}`);
    }

    // Apply capability drops
    for (const cap of spec.capDrop) {
      args.push(`--cap-drop=${cap}`);
    }

    // Apply read-only root if specified by profile
    if (spec.readOnlyRoot) {
      args.push('--read-only');
    }

    // Apply tmpfs mounts if specified by profile
    if (spec.tmpfs && Array.isArray(spec.tmpfs)) {
      for (const tmpfsPath of spec.tmpfs) {
        args.push('--tmpfs', tmpfsPath);
      }
    }

    // Apply user
    if (spec.user) {
      args.push('--user', spec.user);
    }

    // Apply workdir if specified by profile or customized by projectRoot
    if (profile === ContainerProfile.VITE_RUNNER && cleanProjectRoot) {
      args.push('--workdir', `/workspace/${cleanProjectRoot}`);
    } else if (spec.workdir) {
      args.push('--workdir', spec.workdir);
    }

    // Apply resource limits
    if (spec.resourceLimits?.memory) {
      args.push('--memory', spec.resourceLimits.memory);
    }
    if (spec.resourceLimits?.cpus) {
      args.push('--cpus', spec.resourceLimits.cpus);
    }
    if (spec.resourceLimits?.pidsLimit) {
      args.push('--pids-limit', String(spec.resourceLimits.pidsLimit));
    }

    // Network attachment & policy enforcement
    if (spec.networkPolicy.mode === 'none') {
      if (networkName && networkName !== 'none') {
        throw new DockerAdapterError(
          DockerErrorCode.DOCKER_SECURITY_POLICY_VIOLATION,
          `Network attachment is forbidden for profile '${profile}'. Network mode must be 'none'.`
        );
      }
      args.push('--network', 'none');
    } else if (spec.networkPolicy.mode === 'dual-proxy') {
      const primaryNet = profile === ContainerProfile.EGRESS_PROXY
        ? (internalNetworkName || networkName)
        : (ingressNetworkName || networkName);

      if (!primaryNet) {
        throw new DockerAdapterError(
          DockerErrorCode.DOCKER_INVALID_ARGUMENT,
          `Primary network must be specified for profile '${profile}'`
        );
      }
      this.validateResourceName(primaryNet);
      args.push('--network', primaryNet);
    } else {
      if (!networkName) {
        throw new DockerAdapterError(
          DockerErrorCode.DOCKER_INVALID_ARGUMENT,
          `Network must be specified for profile '${profile}'`
        );
      }
      this.validateResourceName(networkName);
      if (spec.networkPolicy.requireInternal) {
        await this.enforceNetworkPolicy(spec.role, networkName, sessionId);
      }
      args.push('--network', networkName);
    }

    // Volume mount & policy enforcement
    if (volumeMount) {
      if (!spec.mountPolicy.allowedDestinations.includes(volumeMount.mountPath)) {
        throw new DockerAdapterError(
          DockerErrorCode.DOCKER_SECURITY_POLICY_VIOLATION,
          `Invalid mount destination '${volumeMount.mountPath}' for profile '${profile}'. Allowed destinations: ${spec.mountPolicy.allowedDestinations.join(', ')}`
        );
      }
      this.validateResourceName(volumeMount.volumeName);

      // Enforce read-only constraint if specified by profile
      const ro = spec.mountPolicy.readOnly ? true : Boolean(volumeMount.readOnly);
      if (spec.mountPolicy.readOnly && !ro) {
        throw new DockerAdapterError(
          DockerErrorCode.DOCKER_SECURITY_POLICY_VIOLATION,
          `Profile '${profile}' requires mount to be read-only (:ro)`
        );
      }
      const roFlag = ro ? ':ro' : ':rw';
      args.push('-v', `${volumeMount.volumeName}:${volumeMount.mountPath}${roFlag}`);
    } else if (spec.mountPolicy.required) {
      throw new DockerAdapterError(
        DockerErrorCode.DOCKER_INVALID_ARGUMENT,
        `Volume mount is required for profile '${profile}'`
      );
    }

    // Port publishing policy
    if (portMapping) {
      if (!spec.portPolicy.allowPublishing) {
        throw new DockerAdapterError(
          DockerErrorCode.DOCKER_SECURITY_POLICY_VIOLATION,
          `Port publishing is forbidden for profile '${profile}'. Only trusted proxy containers may publish ports.`
        );
      }

      const hostIp = portMapping.hostIp ?? '127.0.0.1';
      if (hostIp !== '127.0.0.1') {
        throw new DockerAdapterError(
          DockerErrorCode.DOCKER_SECURITY_POLICY_VIOLATION,
          `Host port exposure on '${hostIp}' is forbidden. All published ports must bind strictly to 127.0.0.1.`
        );
      }

      const containerPort = this.validatePort(portMapping.containerPort ?? spec.portPolicy.defaultContainerPort);
      args.push('-p', `127.0.0.1::${containerPort}`);
    }

    // Standard labels
    const labels = this.buildStandardLabels(sessionId, spec.role);
    for (const label of labels) {
      args.push('--label', label);
    }
    if (instanceId && typeof instanceId === 'string' && /^[0-9a-zA-Z_-]{1,64}$/.test(instanceId)) {
      args.push('--label', `com.gitview.sidecar-instance-id=${instanceId}`);
    }

    // Environment variables (strict allowlist per profile)
    if (env && typeof env === 'object') {
      for (const [key, val] of Object.entries(env)) {
        if (!spec.allowedEnv.includes(key)) {
          throw new DockerAdapterError(
            DockerErrorCode.DOCKER_SECURITY_POLICY_VIOLATION,
            `Arbitrary environment variable '${key}' is forbidden for profile '${profile}'. Allowed variables: ${spec.allowedEnv.join(', ')}`
          );
        }
        args.push('-e', `${key}=${String(val)}`);
      }
    }

    // Immutable image
    args.push(spec.image);

    // Fixed command defined by profile (adapted safely for validated projectRoot)
    let profileCommand = spec.command;
    if (cleanProjectRoot) {
      if (profile === ContainerProfile.VITE_RUNNER) {
        profileCommand = [
          `/workspace/${cleanProjectRoot}/node_modules/.bin/vite`,
          '--host',
          '0.0.0.0',
          '--port',
          '3000',
          '--strictPort',
          `/workspace/${cleanProjectRoot}`,
        ];
      } else if (profile === ContainerProfile.STATIC_RUNNER) {
        profileCommand = [
          'node',
          '/usr/local/bin/gitview-serve.js',
          '--port',
          '3000',
          '--root',
          `/workspace/${cleanProjectRoot}`,
        ];
      }
    }

    for (const cmdItem of profileCommand) {
      args.push(cmdItem);
    }

    const res = await this.#execute(args);
    const containerId = res.stdout.trim();

    // If dual-proxy profile, attach secondary network
    if (spec.networkPolicy.mode === 'dual-proxy') {
      if (profile === ContainerProfile.EGRESS_PROXY && egressNetworkName) {
        this.validateResourceName(egressNetworkName);
        // Connect egress network with priority 1 for default gateway
        await this.connectContainerToNetwork({
          containerName: name,
          networkName: egressNetworkName,
          gwPriority: 1,
        });
      } else if (profile === ContainerProfile.TRUSTED_PROXY && internalNetworkName) {
        this.validateResourceName(internalNetworkName);
        await this.enforceNetworkPolicy('runner', internalNetworkName, sessionId);
        await this.connectContainerToNetwork({
          containerName: name,
          networkName: internalNetworkName,
        });
      }
    }

    return { containerId, containerName: name, profile };
  }

  /**
   * Retrieves and parses the kernel routing table inside a running container.
   *
   * @param {string} containerName
   * @returns {Promise<string[]>} Array of route lines
   */
  async getContainerRoutes(containerName) {
    this.validateResourceName(containerName);
    const res = await this.#execute(['exec', containerName, 'ip', 'route']);
    return res.stdout.trim().split('\n').map((s) => s.trim()).filter(Boolean);
  }

  /**
   * Verifies that the default gateway in a proxy container points to the egress network.
   *
   * @param {string} containerName
   * @param {string} [expectedGatewayIp]
   * @returns {Promise<{ valid: boolean, defaultRoute: string }>}
   */
  async verifyProxyDefaultGateway(containerName, expectedGatewayIp = null) {
    const routes = await this.getContainerRoutes(containerName);
    const defaultRoute = routes.find((r) => r.startsWith('default via'));
    if (!defaultRoute) {
      throw new DockerAdapterError(
        DockerErrorCode.DOCKER_SECURITY_POLICY_VIOLATION,
        `No default route found in proxy container '${containerName}'`
      );
    }
    if (expectedGatewayIp && !defaultRoute.includes(expectedGatewayIp)) {
      throw new DockerAdapterError(
        DockerErrorCode.DOCKER_SECURITY_POLICY_VIOLATION,
        `Default route in '${containerName}' (${defaultRoute}) does not match expected egress gateway '${expectedGatewayIp}'`
      );
    }
    return { valid: true, defaultRoute };
  }

  validateContainerTarget(target) {
    if (typeof target !== 'string') {
      throw new DockerAdapterError(DockerErrorCode.DOCKER_INVALID_ARGUMENT, 'Container target must be a string');
    }
    if (RESOURCE_NAME_REGEX.test(target) || /^[0-9a-fA-F]{12,64}$/.test(target)) {
      return target;
    }
    throw new DockerAdapterError(
      DockerErrorCode.DOCKER_INVALID_ARGUMENT,
      `Invalid container target '${target}': must match resource name pattern or valid hex container ID`
    );
  }

  async inspectContainer(containerName) {
    this.validateContainerTarget(containerName);
    const res = await this.#execute(['inspect', containerName]);
    try {
      const parsed = JSON.parse(res.stdout);
      return Array.isArray(parsed) ? parsed[0] : parsed;
    } catch (err) {
      throw new DockerAdapterError(DockerErrorCode.DOCKER_EXECUTION_FAILED, `Failed to parse container inspect JSON: ${err.message}`);
    }
  }

  async getPublishedPort({ containerName, containerPort }) {
    this.validateResourceName(containerName);
    const validatedPort = this.validatePort(containerPort);

    const inspectData = await this.inspectContainer(containerName);
    if (!inspectData?.State?.Running) {
      throw new DockerAdapterError(
        DockerErrorCode.DOCKER_CONTAINER_NOT_RUNNING,
        `Container '${containerName}' is not running (state: ${inspectData?.State?.Status || 'unknown'})`
      );
    }

    const portKey = `${validatedPort}/tcp`;
    const portBindings = inspectData?.NetworkSettings?.Ports?.[portKey];

    if (!portBindings || !Array.isArray(portBindings) || portBindings.length === 0) {
      throw new DockerAdapterError(
        DockerErrorCode.DOCKER_PORT_NOT_FOUND,
        `No published port found for container port ${validatedPort}/tcp on '${containerName}'`
      );
    }

    const primaryBinding = portBindings[0];
    const hostIp = primaryBinding.HostIp;

    if (hostIp !== '127.0.0.1') {
      throw new DockerAdapterError(
        DockerErrorCode.DOCKER_INVALID_PORT_BINDING,
        `Unapproved host IP binding '${hostIp}' on container '${containerName}'. Only '127.0.0.1' is allowed`
      );
    }

    const hostPort = parseInt(primaryBinding.HostPort, 10);
    if (isNaN(hostPort) || hostPort < 1024 || hostPort > 65535) {
      throw new DockerAdapterError(
        DockerErrorCode.DOCKER_INVALID_PORT_BINDING,
        `Invalid published host port '${primaryBinding.HostPort}' for container '${containerName}'`
      );
    }

    return { hostIp: '127.0.0.1', hostPort };
  }

  async getContainerLogs({ containerName, tail = 100, maxBytes = 100000 }) {
    this.validateResourceName(containerName);
    const tailNum = typeof tail === 'number' ? tail : parseInt(tail, 10);
    if (isNaN(tailNum) || tailNum <= 0 || tailNum > 1000) {
      throw new DockerAdapterError(DockerErrorCode.DOCKER_INVALID_ARGUMENT, 'Tail must be an integer between 1 and 1000');
    }

    const res = await this.#execute(['logs', '--tail', String(tailNum), containerName], {
      maxBufferBytes: maxBytes,
    });
    return {
      stdout: res.stdout,
      stderr: res.stderr,
    };
  }

  async stopContainer({ containerName, timeoutSec = 5 }) {
    this.validateResourceName(containerName);
    const tNum = typeof timeoutSec === 'number' ? timeoutSec : parseInt(timeoutSec, 10);
    if (isNaN(tNum) || tNum < 1 || tNum > 60) {
      throw new DockerAdapterError(DockerErrorCode.DOCKER_INVALID_ARGUMENT, 'Stop timeoutSec must be between 1 and 60');
    }

    try {
      await this.#execute(['stop', '-t', String(tNum), containerName]);
      return { stopped: true };
    } catch (err) {
      if (err.errorCode === DockerErrorCode.DOCKER_RESOURCE_NOT_FOUND) {
        return { stopped: false };
      }
      throw err;
    }
  }

  async removeContainer(target, options = {}) {
    let containerName;
    let force = true;
    if (typeof target === 'string') {
      containerName = target;
      if (typeof options?.force === 'boolean') force = options.force;
    } else if (target && typeof target === 'object') {
      containerName = target.containerName;
      if (typeof target.force === 'boolean') force = target.force;
    }
    this.validateResourceName(containerName);
    const args = ['rm'];
    if (force) args.push('-f');
    args.push(containerName);

    try {
      await this.#execute(args);
      return { removed: true };
    } catch (err) {
      if (err.errorCode === DockerErrorCode.DOCKER_RESOURCE_NOT_FOUND) {
        return { removed: false };
      }
      throw err;
    }
  }

  // --- Volume File & Executable Verification Helpers ---

  /**
   * Reads a single file from a Docker named volume in an isolated, network-less container.
   *
   * @param {Object} params
   * @param {string} params.volumeName - Volume to read from
   * @param {string} params.filePath - Relative path inside the volume workspace
   * @param {string} params.sessionId - Associated preview session ID
   * @param {number} [params.maxBytes=1048576] - Maximum allowed file size (default 1MB)
   * @returns {Promise<string|null>} File contents or null if not found
   */
  async readVolumeFile({ volumeName, filePath, sessionId, maxBytes = 1048576 } = {}) {
    this.validateSessionId(sessionId);
    this.validateResourceName(volumeName);

    if (typeof filePath !== 'string' || !filePath.trim()) {
      throw new DockerAdapterError(DockerErrorCode.DOCKER_INVALID_ARGUMENT, 'filePath must be a non-empty string');
    }

    const normalized = filePath.replace(/^\/+/, '');
    if (normalized.includes('..') || !/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(normalized)) {
      throw new DockerAdapterError(
        DockerErrorCode.DOCKER_SECURITY_POLICY_VIOLATION,
        `Invalid or unsafe filePath '${filePath}' for volume reading`
      );
    }

    const args = [
      'run', '--rm',
      '--network', 'none',
      '--read-only',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '-u', '10001:10001',
      '--label', 'com.gitview.managed=true',
      `--label=com.gitview.session-id=${sessionId}`,
      '--label', 'com.gitview.role=runner',
      '-v', `${volumeName}:/workspace:ro`,
      'gitview-preview-runner:v1.0.0',
      'cat', `/workspace/${normalized}`,
    ];

    try {
      const res = await this.#execute(args, { timeoutMs: 15000, maxBufferBytes: maxBytes + 1 });
      if (res.stdout.length > maxBytes) {
        throw new DockerAdapterError(
          DockerErrorCode.DOCKER_SECURITY_POLICY_VIOLATION,
          `File '${normalized}' exceeded maximum size limit of ${maxBytes} bytes`
        );
      }
      return res.stdout;
    } catch (err) {
      if (
        err.errorCode === DockerErrorCode.DOCKER_RESOURCE_NOT_FOUND ||
        err.message?.includes('No such file') ||
        err.message?.includes('not found')
      ) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Verifies that a specific file exists and is executable in a Docker named volume.
   *
   * @param {Object} params
   * @param {string} params.volumeName
   * @param {string} params.filePath
   * @param {string} params.sessionId
   * @returns {Promise<boolean>}
   */
  async verifyVolumeExecutable({ volumeName, filePath, sessionId } = {}) {
    this.validateSessionId(sessionId);
    this.validateResourceName(volumeName);

    if (typeof filePath !== 'string' || !filePath.trim()) {
      throw new DockerAdapterError(DockerErrorCode.DOCKER_INVALID_ARGUMENT, 'filePath must be a non-empty string');
    }

    const normalized = filePath.replace(/^\/+/, '');
    if (normalized.includes('..') || !/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(normalized)) {
      throw new DockerAdapterError(
        DockerErrorCode.DOCKER_SECURITY_POLICY_VIOLATION,
        `Invalid or unsafe filePath '${filePath}'`
      );
    }

    const args = [
      'run', '--rm',
      '--network', 'none',
      '--read-only',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '-u', '10001:10001',
      '--label', 'com.gitview.managed=true',
      `--label=com.gitview.session-id=${sessionId}`,
      '--label', 'com.gitview.role=runner',
      '-v', `${volumeName}:/workspace:ro`,
      'gitview-preview-runner:v1.0.0',
      'test', '-x', `/workspace/${normalized}`,
    ];

    try {
      await this.#execute(args, { timeoutMs: 15000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Waits for a container to exit within a specified timeout.
   *
   * @param {Object} params
   * @param {string} params.containerName
   * @param {number} [params.timeoutMs=90000]
   * @param {number} [params.pollIntervalMs=500]
   * @param {AbortSignal} [params.signal]
   * @returns {Promise<{ exitCode: number, oomKilled: boolean, status: string }>}
   */
  async waitForContainer({ containerName, timeoutMs = 90000, pollIntervalMs = 500, signal = null } = {}) {
    this.validateResourceName(containerName);
    const start = Date.now();

    while (true) {
      if (signal?.aborted) {
        throw new DockerAdapterError(DockerErrorCode.DOCKER_COMMAND_ABORTED, 'Wait aborted by signal');
      }

      const inspect = await this.inspectContainer(containerName);
      if (!inspect?.State?.Running) {
        return {
          exitCode: inspect?.State?.ExitCode ?? -1,
          oomKilled: Boolean(inspect?.State?.OOMKilled),
          status: inspect?.State?.Status ?? 'exited',
        };
      }

      if (Date.now() - start >= timeoutMs) {
        throw new DockerAdapterError(
          DockerErrorCode.DOCKER_COMMAND_TIMEOUT,
          `Container '${containerName}' did not exit within ${timeoutMs}ms`
        );
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  // --- Scoped Session Cleanup ---

  async cleanupSession(sessionId) {
    this.validateSessionId(sessionId);

    const report = {
      sessionId,
      containersRemoved: [],
      networksRemoved: [],
      volumesRemoved: [],
      errors: [],
    };

    // 1. Enumerate and force-remove session containers
    try {
      const psRes = await this.#execute([
        'ps', '-aq',
        '--filter', 'label=com.gitview.managed=true',
        '--filter', `label=com.gitview.session-id=${sessionId}`,
      ]);
      const containerIds = psRes.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
      for (const cId of containerIds) {
        try {
          await this.#execute(['rm', '-f', cId]);
          report.containersRemoved.push(cId);
        } catch (err) {
          report.errors.push(`Failed to remove container ${cId}: ${err.message}`);
        }
      }
    } catch (err) {
      report.errors.push(`Failed to enumerate containers: ${err.message}`);
    }

    // 2. Enumerate and remove session networks
    try {
      const netRes = await this.#execute([
        'network', 'ls', '-q',
        '--filter', 'label=com.gitview.managed=true',
        '--filter', `label=com.gitview.session-id=${sessionId}`,
      ]);
      const networkIds = netRes.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
      for (const nId of networkIds) {
        try {
          await this.#execute(['network', 'rm', nId]);
          report.networksRemoved.push(nId);
        } catch (err) {
          report.errors.push(`Failed to remove network ${nId}: ${err.message}`);
        }
      }
    } catch (err) {
      report.errors.push(`Failed to enumerate networks: ${err.message}`);
    }

    // 3. Enumerate and remove session volumes
    try {
      const volRes = await this.#execute([
        'volume', 'ls', '-q',
        '--filter', 'label=com.gitview.managed=true',
        '--filter', `label=com.gitview.session-id=${sessionId}`,
      ]);
      const volumeIds = volRes.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
      for (const vId of volumeIds) {
        try {
          await this.#execute(['volume', 'rm', vId]);
          report.volumesRemoved.push(vId);
        } catch (err) {
          report.errors.push(`Failed to remove volume ${vId}: ${err.message}`);
        }
      }
    } catch (err) {
      report.errors.push(`Failed to enumerate volumes: ${err.message}`);
    }

    return report;
  }

  /**
   * Discovers all distinct session IDs across active and stopped GitView-managed Docker resources.
   * Useful for orphan resource reconciliation.
   *
   * @returns {Promise<string[]>}
   */
  async listManagedSessionIds() {
    const sessionIds = new Set();
    try {
      const psRes = await this.#execute([
        'ps', '-aq',
        '--filter', 'label=com.gitview.managed=true',
        '--format', '{{.Labels}}',
      ]);
      const lines = psRes.stdout.split('\n').filter(Boolean);
      for (const line of lines) {
        const match = line.match(/com\.gitview\.session-id=([a-zA-Z0-9_-]+)/);
        if (match) sessionIds.add(match[1]);
      }

      const netRes = await this.#execute([
        'network', 'ls', '-q',
        '--filter', 'label=com.gitview.managed=true',
        '--format', '{{.Labels}}',
      ]);
      const netLines = netRes.stdout.split('\n').filter(Boolean);
      for (const line of netLines) {
        const match = line.match(/com\.gitview\.session-id=([a-zA-Z0-9_-]+)/);
        if (match) sessionIds.add(match[1]);
      }

      const volRes = await this.#execute([
        'volume', 'ls', '-q',
        '--filter', 'label=com.gitview.managed=true',
        '--format', '{{.Labels}}',
      ]);
      const volLines = volRes.stdout.split('\n').filter(Boolean);
      for (const line of volLines) {
        const match = line.match(/com\.gitview\.session-id=([a-zA-Z0-9_-]+)/);
        if (match) sessionIds.add(match[1]);
      }
    } catch {
      // Gracefully handle daemon execution errors
    }
    return Array.from(sessionIds);
  }
}

// Export default singleton instance
export const dockerAdapter = new DockerAdapter();

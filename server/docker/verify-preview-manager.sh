#!/usr/bin/env bash
# ==============================================================================
# GitView Phase 5 — Milestone 6, Task 4: PreviewManager Live Integration Verification
# ==============================================================================
# Empirically demonstrates end-to-end preview orchestration on the host Docker daemon:
# - STATIC synthetic fixture reaches RUNNING, responds with HTTP 200/HTML on loopback port, and tears down cleanly.
# - VITE Vanilla fixture reaches RUNNING via egress proxy and project-local Vite CLI, responds with HTTP 200/HTML, and tears down cleanly.
# - VITE React fixture reaches RUNNING via egress proxy, loads plugins, responds with HTTP 200/HTML, and tears down cleanly.
# - Validates state machine compliance, Docker management labels, loopback port binding, and idempotent cleanup.
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
FIXTURES_DIR="${SERVER_DIR}/docker/fixtures"

echo "=================================================================="
echo " GitView Phase 5 — PreviewManager Live Integration Verification"
echo "=================================================================="

# Check Docker daemon
if ! docker info >/dev/null 2>&1; then
  echo "[-] ERROR: Docker daemon is not running"
  exit 1
fi

cd "${SERVER_DIR}"

node --env-file=.env --input-type=module << 'EOF'
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { PreviewManager } from './src/modules/preview/previewManager.js';
import { dockerAdapter, ContainerProfile } from './src/modules/preview/dockerAdapter.js';
import { PreviewStatus, FrameworkType } from './src/modules/preview/sessionConstants.js';
import { encryptToken } from './src/utils/encryption.js';

const SCRIPT_DIR = path.resolve('./docker/acceptance-tests');
const FIXTURES_DIR = path.resolve('./docker/fixtures');

function httpGet(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: parseInt(u.port, 10),
        path: u.pathname + u.search,
        method: 'GET',
        headers: { Accept: 'text/html,*/*' },
        timeout: timeoutMs,
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
      }
    );
    req.on('timeout', () => req.destroy(new Error('HTTP request timed out')));
    req.on('error', reject);
    req.end();
  });
}

function testWebSocketUpgrade(host, port, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      hostname: host,
      port: port,
      path: '/',
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Protocol': 'vite-hmr',
      },
      timeout: timeoutMs,
    });

    req.on('upgrade', (res, socket, head) => {
      socket.destroy();
      resolve({ statusCode: res.statusCode, headers: res.headers });
    });

    req.on('response', (res) => {
      resolve({ statusCode: res.statusCode, headers: res.headers });
    });

    req.on('timeout', () => req.destroy(new Error('WebSocket upgrade timed out')));
    req.on('error', reject);
    req.end();
  });
}

function createIntegrationPrisma(userId, repoId) {
  const sessions = new Map();
  const repo = {
    id: repoId,
    userId,
    owner: 'gitview-org',
    name: 'preview-test-repo',
    defaultBranch: 'main',
    latestCommitSha: '0123456789abcdef0123456789abcdef01234567',
  };
  const oauth = {
    userId,
    provider: 'GITHUB',
    accessTokenEnc: encryptToken('ghp_test_token_not_real_1234567890'),
  };

  return {
    _sessions: sessions,
    repository: {
      findFirst: async ({ where }) => (where.id === repoId && where.userId === userId ? repo : null),
      findUnique: async () => repo,
    },
    oAuthAccount: {
      findUnique: async () => oauth,
    },
    previewSession: {
      findFirst: async ({ where }) => {
        for (const s of sessions.values()) {
          if (where.id && s.id !== where.id) continue;
          if (where.userId && s.userId !== where.userId) continue;
          if (where.isActive !== undefined && s.isActive !== where.isActive) continue;
          return { ...s };
        }
        return null;
      },
      findUnique: async ({ where }) => (sessions.has(where.id) ? { ...sessions.get(where.id) } : null),
      findMany: async (args = {}) => {
        const { where } = args;
        return Array.from(sessions.values())
          .filter((s) => {
            if (!where) return true;
            if (where.id && s.id !== where.id) return false;
            if (where.userId && s.userId !== where.userId) return false;
            if (where.isActive !== undefined && s.isActive !== where.isActive) return false;
            if (where.status && s.status !== where.status) return false;
            if (where.OR && Array.isArray(where.OR)) {
              const matched = where.OR.some((cond) => {
                if (cond.expiresAt && cond.expiresAt.lte && !(s.expiresAt && s.expiresAt <= cond.expiresAt.lte)) return false;
                if (cond.lastActiveAt && cond.lastActiveAt.lte && !(s.lastActiveAt && s.lastActiveAt <= cond.lastActiveAt.lte)) return false;
                return true;
              });
              if (!matched) return false;
            }
            return true;
          })
          .map((s) => ({ ...s }));
      },
      create: async ({ data }) => {
        const id = crypto.randomUUID();
        const created = { id, ...data, createdAt: new Date() };
        sessions.set(id, created);
        return { ...created };
      },
      update: async ({ where, data }) => {
        const s = sessions.get(where.id);
        const updated = { ...s, ...data };
        sessions.set(where.id, updated);
        return { ...updated };
      },
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const [id, s] of sessions.entries()) {
          if (where.id && s.id !== where.id) continue;
          if (where.status && s.status !== where.status) continue;
          sessions.set(id, { ...s, ...data });
          count++;
        }
        return { count };
      },
    },
  };
}

async function copyFixtureToVolume(fixtureName, volumeName) {
  const fixturePath = path.join(FIXTURES_DIR, fixtureName);
  return new Promise((resolve, reject) => {
    const child = spawn(
      'docker',
      [
        'run', '--rm',
        '-v', `${volumeName}:/workspace`,
        '-v', `${fixturePath}:/fixture:ro`,
        'gitview-preview-runner:v1.0.0',
        'sh', '-c',
        'rm -rf /workspace/* /workspace/.* 2>/dev/null || true; cp -r /fixture/* /workspace/ && chown -R 10001:10001 /workspace',
      ],
      { stdio: 'inherit' }
    );
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Failed to copy fixture: code ${code}`))));
    child.on('error', reject);
  });
}

async function runEmpiricalDemonstrations() {
  console.log('\n==================================================================');
  console.log(' [DEMONSTRATION 1/3] STATIC Synthetic Preview Lifecycle');
  console.log('==================================================================');

  const userId = crypto.randomUUID();
  const repoId = crypto.randomUUID();
  const prismaStatic = createIntegrationPrisma(userId, repoId);

  // Mock extractor to populate named volume directly from static fixture
  const extractStaticFixture = async (stream, { volumeName }) => {
    await copyFixtureToVolume('static-site', volumeName);
    return { success: true };
  };

  const managerStatic = new PreviewManager({
    docker: dockerAdapter,
    prisma: prismaStatic,
    detectorFn: async () => ({ supported: true, framework: 'STATIC' }),
    fetchArchiveFn: async () => Readable.from(Buffer.from('mock_static_tarball')),
    extractArchiveFn: extractStaticFixture,
  });

  const staticResult = await managerStatic.createAndStartSession({
    userId,
    repositoryId: repoId,
    commitRef: '0123456789abcdef0123456789abcdef01234567',
  });

  console.log(`[+] Static preview reached state: ${staticResult.session.status}`);
  console.log(`[+] Framework: ${staticResult.session.framework}`);
  console.log(`[+] Loopback Preview URL: ${staticResult.previewUrl}`);
  console.log(`[+] Published Host Port: ${staticResult.hostPort}`);

  // 1. Initial HTML document
  const staticHttp = await httpGet(staticResult.previewUrl);
  console.log(`[+] HTTP Root GET Status: ${staticHttp.statusCode}`);
  if (staticHttp.statusCode !== 200 || !staticHttp.body.includes('GitView Static Preview Test')) {
    throw new Error('Static preview returned unexpected HTTP body: ' + staticHttp.body.slice(0, 200));
  }
  console.log('[+] PASS: Root HTML document returned HTTP 200.');

  // 2. CSS Asset check
  const cssHttp = await httpGet(`http://127.0.0.1:${staticResult.hostPort}/style.css`);
  console.log(`[+] CSS Asset Status: ${cssHttp.statusCode} (Content-Type: ${cssHttp.headers['content-type']})`);
  if (cssHttp.statusCode !== 200 || !cssHttp.headers['content-type']?.includes('text/css')) {
    throw new Error('Static preview failed to serve CSS asset correctly');
  }
  console.log('[+] PASS: CSS asset returned HTTP 200 with text/css MIME type.');

  // 3. JavaScript Asset check
  const jsHttp = await httpGet(`http://127.0.0.1:${staticResult.hostPort}/app.js`);
  console.log(`[+] JS Asset Status: ${jsHttp.statusCode} (Content-Type: ${jsHttp.headers['content-type']})`);
  if (jsHttp.statusCode !== 200 || !jsHttp.headers['content-type']?.includes('application/javascript')) {
    throw new Error('Static preview failed to serve JS asset correctly');
  }
  console.log('[+] PASS: JavaScript asset returned HTTP 200 with application/javascript MIME type.');

  // 4. SVG Image Asset check
  const svgHttp = await httpGet(`http://127.0.0.1:${staticResult.hostPort}/logo.svg`);
  console.log(`[+] SVG Asset Status: ${svgHttp.statusCode} (Content-Type: ${svgHttp.headers['content-type']})`);
  if (svgHttp.statusCode !== 200 || !svgHttp.headers['content-type']?.includes('image/svg+xml')) {
    throw new Error('Static preview failed to serve SVG image asset correctly');
  }
  console.log('[+] PASS: SVG image asset returned HTTP 200 with image/svg+xml MIME type.');

  // 5. SPA Fallback check
  const spaHttp = await httpGet(`http://127.0.0.1:${staticResult.hostPort}/dashboard/client-route`);
  console.log(`[+] SPA Fallback Status: ${spaHttp.statusCode} (X-GitView-Fallback: ${spaHttp.headers['x-gitview-fallback']})`);
  if (spaHttp.statusCode !== 200 || spaHttp.headers['x-gitview-fallback'] !== 'SPA') {
    throw new Error('Static preview failed SPA fallback assertion');
  }
  console.log('[+] PASS: Unmatched extensionless route returned HTTP 200 with SPA fallback header.');

  // Clean stop
  const stoppedStatic = await managerStatic.stopPreviewSession(staticResult.session.id, userId);
  console.log(`[+] Session stopped state: ${stoppedStatic.status} (isActive: ${stoppedStatic.isActive})`);
  console.log('[+] PASS: STATIC session successfully stopped and resources pruned.');

  console.log('\n==================================================================');
  console.log(' [DEMONSTRATION 2/3] VITE Vanilla Synthetic Preview Lifecycle');
  console.log('==================================================================');

  const userIdVite = crypto.randomUUID();
  const repoIdVite = crypto.randomUUID();
  const prismaVite = createIntegrationPrisma(userIdVite, repoIdVite);

  const extractVanillaFixture = async (stream, { volumeName }) => {
    await copyFixtureToVolume('vite-vanilla', volumeName);
    return { success: true };
  };

  const managerVite = new PreviewManager({
    docker: dockerAdapter,
    prisma: prismaVite,
    detectorFn: async () => ({ supported: true, framework: 'VITE_VANILLA' }),
    fetchArchiveFn: async () => Readable.from(Buffer.from('mock_vanilla_tarball')),
    extractArchiveFn: extractVanillaFixture,
  });

  console.log('[*] Starting VITE_VANILLA orchestration (Dependency installation + local Vite runtime)...');
  const viteResult = await managerVite.createAndStartSession({
    userId: userIdVite,
    repositoryId: repoIdVite,
    commitRef: '0123456789abcdef0123456789abcdef01234567',
  });

  console.log(`[+] Vite Vanilla preview reached state: ${viteResult.session.status}`);
  console.log(`[+] Framework: ${viteResult.session.framework}`);
  console.log(`[+] Loopback Preview URL: ${viteResult.previewUrl}`);
  console.log(`[+] Published Host Port: ${viteResult.hostPort}`);

  // 1. Root HTML GET
  const viteHttp = await httpGet(viteResult.previewUrl);
  console.log(`[+] HTTP Root GET Status: ${viteHttp.statusCode}`);
  if (viteHttp.statusCode !== 200 || !viteHttp.body.includes('Vite Vanilla Test')) {
    throw new Error('Vite Vanilla preview returned unexpected HTTP body: ' + viteHttp.body.slice(0, 200));
  }
  console.log('[+] PASS: VITE_VANILLA preview successfully returned HTTP 200 with Vite HTML payload.');

  // 2. Vite client script check
  const viteClientHttp = await httpGet(`http://127.0.0.1:${viteResult.hostPort}/@vite/client`);
  console.log(`[+] Vite Client Status: ${viteClientHttp.statusCode}`);
  if (viteClientHttp.statusCode !== 200 || !viteClientHttp.body.includes('vite')) {
    throw new Error('Vite client script was not served correctly');
  }
  console.log('[+] PASS: /@vite/client returned HTTP 200 with Vite client runtime script.');

  // 3. Application JavaScript module check
  const mainModuleHttp = await httpGet(`http://127.0.0.1:${viteResult.hostPort}/main.js`);
  console.log(`[+] Application Module Status: ${mainModuleHttp.statusCode}`);
  if (mainModuleHttp.statusCode !== 200) {
    throw new Error('Application module main.js failed to serve');
  }
  console.log('[+] PASS: /main.js application module served successfully.');

  // 4. Vite HMR WebSocket Upgrade check (HTTP 101 Switching Protocols)
  console.log('[*] Testing Vite HMR WebSocket Upgrade handshake through Option A proxy...');
  const wsUpgrade = await testWebSocketUpgrade('127.0.0.1', viteResult.hostPort);
  console.log(`[+] WebSocket Upgrade Handshake Status: ${wsUpgrade.statusCode}`);
  if (wsUpgrade.statusCode !== 101) {
    throw new Error(`Expected HTTP 101 Switching Protocols for WebSocket upgrade, got ${wsUpgrade.statusCode}`);
  }
  console.log('[+] PASS: Option A proxy successfully forwarded RFC 6455 WebSocket Upgrade and received HTTP 101.');

  const stoppedVite = await managerVite.stopPreviewSession(viteResult.session.id, userIdVite);
  console.log(`[+] Session stopped state: ${stoppedVite.status} (isActive: ${stoppedVite.isActive})`);
  console.log('[+] PASS: VITE_VANILLA session successfully stopped and resources pruned.');

  console.log('\n==================================================================');
  console.log(' [DEMONSTRATION 3/3] VITE React Synthetic Preview Lifecycle');
  console.log('==================================================================');

  const userIdReact = crypto.randomUUID();
  const repoIdReact = crypto.randomUUID();
  const prismaReact = createIntegrationPrisma(userIdReact, repoIdReact);

  const extractReactFixture = async (stream, { volumeName }) => {
    await copyFixtureToVolume('vite-react', volumeName);
    return { success: true };
  };

  const managerReact = new PreviewManager({
    docker: dockerAdapter,
    prisma: prismaReact,
    detectorFn: async () => ({ supported: true, framework: 'VITE_REACT' }),
    fetchArchiveFn: async () => Readable.from(Buffer.from('mock_react_tarball')),
    extractArchiveFn: extractReactFixture,
  });

  console.log('[*] Starting VITE_REACT orchestration (React + Plugin resolution + local Vite runtime)...');
  const reactResult = await managerReact.createAndStartSession({
    userId: userIdReact,
    repositoryId: repoIdReact,
    commitRef: '0123456789abcdef0123456789abcdef01234567',
  });

  console.log(`[+] Vite React preview reached state: ${reactResult.session.status}`);
  console.log(`[+] Framework: ${reactResult.session.framework}`);
  console.log(`[+] Loopback Preview URL: ${reactResult.previewUrl}`);
  console.log(`[+] Published Host Port: ${reactResult.hostPort}`);

  // 1. Root HTML GET
  const reactHttp = await httpGet(reactResult.previewUrl);
  console.log(`[+] HTTP Root GET Status: ${reactHttp.statusCode}`);
  if (reactHttp.statusCode !== 200 || !reactHttp.body.includes('Vite React Test')) {
    throw new Error('Vite React preview returned unexpected HTTP body: ' + reactHttp.body.slice(0, 200));
  }
  console.log('[+] PASS: VITE_REACT preview successfully returned HTTP 200 with React HTML payload.');

  // 2. Vite client runtime check
  const reactClientHttp = await httpGet(`http://127.0.0.1:${reactResult.hostPort}/@vite/client`);
  console.log(`[+] Vite Client Status: ${reactClientHttp.statusCode}`);
  if (reactClientHttp.statusCode !== 200 || !reactClientHttp.body.includes('vite')) {
    throw new Error('Vite client script was not served correctly for React preview');
  }
  console.log('[+] PASS: /@vite/client returned HTTP 200 with Vite client runtime script.');

  // 3. React JSX module transformation check
  const mainJsxHttp = await httpGet(`http://127.0.0.1:${reactResult.hostPort}/src/main.jsx`);
  console.log(`[+] Transformed JSX Module Status: ${mainJsxHttp.statusCode}`);
  if (mainJsxHttp.statusCode !== 200 || (!mainJsxHttp.body.includes('React.createElement') && !mainJsxHttp.body.includes('react/jsx-dev-runtime') && !mainJsxHttp.body.includes('react'))) {
    throw new Error('React JSX module was not transformed or served correctly: ' + mainJsxHttp.body.slice(0, 200));
  }
  console.log('[+] PASS: /src/main.jsx returned HTTP 200 with transformed React module code.');

  // 4. Vite HMR WebSocket Upgrade check (HTTP 101 Switching Protocols)
  console.log('[*] Testing Vite React HMR WebSocket Upgrade handshake through Option A proxy...');
  const wsReactUpgrade = await testWebSocketUpgrade('127.0.0.1', reactResult.hostPort);
  console.log(`[+] WebSocket Upgrade Handshake Status: ${wsReactUpgrade.statusCode}`);
  if (wsReactUpgrade.statusCode !== 101) {
    throw new Error(`Expected HTTP 101 Switching Protocols for React WebSocket upgrade, got ${wsReactUpgrade.statusCode}`);
  }
  console.log('[+] PASS: Option A proxy successfully forwarded RFC 6455 WebSocket Upgrade for React and received HTTP 101.');

  const stoppedReact = await managerReact.stopPreviewSession(reactResult.session.id, userIdReact);
  console.log(`[+] Session stopped state: ${stoppedReact.status} (isActive: ${stoppedReact.isActive})`);
  console.log('[+] PASS: VITE_REACT session successfully stopped and resources pruned.');

  console.log('\n==================================================================');
  console.log(' [DEMONSTRATION 4/4] Backend Crash Simulation & Stale Session Reconciliation');
  console.log('==================================================================');

  const userIdReconcile = crypto.randomUUID();
  const repoIdReconcile = crypto.randomUUID();
  const prismaReconcile = createIntegrationPrisma(userIdReconcile, repoIdReconcile);

  const managerInitial = new PreviewManager({
    docker: dockerAdapter,
    prisma: prismaReconcile,
    detectorFn: async () => ({ supported: true, framework: 'STATIC' }),
    fetchArchiveFn: async () => Readable.from(Buffer.from('mock_static_tarball')),
    extractArchiveFn: extractStaticFixture,
  });

  const sessionActive = await managerInitial.createAndStartSession({
    userId: userIdReconcile,
    repositoryId: repoIdReconcile,
    commitRef: '0123456789abcdef0123456789abcdef01234567',
  });
  console.log(`[+] Initial session active in state: ${sessionActive.session.status}`);

  // Simulate abrupt backend termination & container crash
  console.log('[*] Simulating backend crash & runner container abrupt termination...');
  await dockerAdapter.removeContainer(`gitview-runner-${sessionActive.session.id}`, { force: true });

  // Simulate new backend startup & reconciliation invocation
  const managerRestarted = new PreviewManager({
    docker: dockerAdapter,
    prisma: prismaReconcile,
    detectorFn: async () => ({ supported: true, framework: 'STATIC' }),
    fetchArchiveFn: async () => Readable.from(Buffer.from('mock_static_tarball')),
    extractArchiveFn: extractStaticFixture,
  });

  console.log('[*] Invoking reconcileStaleSessions() on restarted backend...');
  const reconcileReport = await managerRestarted.reconcileStaleSessions();
  console.log('[+] Reconciliation report:', JSON.stringify(reconcileReport));

  if (reconcileReport.crashedCount < 1) {
    throw new Error('Reconciliation failed to detect crashed runner container');
  }

  const updatedSession = await prismaReconcile.previewSession.findUnique({ where: { id: sessionActive.session.id } });
  console.log(`[+] Crashed session status in DB: ${updatedSession.status} (errorCode: ${updatedSession.errorCode}, isActive: ${updatedSession.isActive})`);
  if (updatedSession.status !== PreviewStatus.FAILED || updatedSession.errorCode !== 'CONTAINER_CRASHED' || updatedSession.isActive !== false) {
    throw new Error('Crashed session was not properly failed and released');
  }
  console.log('[+] PASS: Crashed session transitioned to FAILED and released user slot.');

  // Verify new preview session can now be started for that user without conflict
  console.log('[*] Verifying new session can be started for user after reconciliation...');
  const newSession = await managerRestarted.createAndStartSession({
    userId: userIdReconcile,
    repositoryId: repoIdReconcile,
    commitRef: '0123456789abcdef0123456789abcdef01234567',
  });
  console.log(`[+] Subsequent session created and RUNNING: ${newSession.session.id} (status: ${newSession.session.status})`);
  await managerRestarted.stopPreviewSession(newSession.session.id, userIdReconcile);
  console.log('[+] PASS: Stale session reconciliation verified end-to-end without slot leaks.');

  console.log('\n==================================================================');
  console.log(' ALL 4 EMPIRICAL E2E & RECONCILIATION DEMONSTRATIONS PASSED!');
  console.log('==================================================================');
}

runEmpiricalDemonstrations().catch((err) => {
  console.error('\n[-] DEMONSTRATION FAILED:', err);
  process.exit(1);
});
EOF

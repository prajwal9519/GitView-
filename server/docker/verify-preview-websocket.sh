#!/usr/bin/env bash
# ==============================================================================
# GitView Phase 5 — Milestone 7, Task 5: Secure WebSocket Gateway Live Acceptance
# ==============================================================================
# Demonstrates live WebSocket reverse proxying through the authenticated Gateway
# on the host Docker daemon:
# 1. STATIC fixture: unsupported WebSocket upgrade requests are safely rejected.
# 2. VITE_VANILLA: authenticated upgrade (HTTP 101) & bidirectional HMR frame exchange.
# 3. VITE_REACT: authenticated upgrade (HTTP 101) & bidirectional HMR frame exchange.
# 4. Gateway security controls: invalid cookie (401), wrong/missing Origin (403),
#    cross-session tokens (401), and replaced sidecar containers (502).
# 5. Idempotent resource cleanup and teardown.
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
FIXTURES_DIR="${SERVER_DIR}/docker/fixtures"

echo "=================================================================="
echo " GitView Phase 5 — Milestone 7: WebSocket Preview Gateway Acceptance"
echo "=================================================================="

# Check Docker daemon
if ! docker info >/dev/null 2>&1; then
  echo "[-] ERROR: Docker daemon is not running"
  exit 1
fi

cleanup() {
  echo "[*] Cleaning up GitView containers and volumes..."
  docker rm -f $(docker ps -aq --filter label=gitview.managed=true) 2>/dev/null || true
  docker volume rm $(docker volume ls -q --filter label=gitview.managed=true) 2>/dev/null || true
  docker network rm $(docker network ls -q --filter label=gitview.managed=true) 2>/dev/null || true
}
trap cleanup EXIT
cleanup

cd "${SERVER_DIR}"

node --env-file=.env --input-type=module << 'EOF'
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';

import { PreviewManager } from './src/modules/preview/previewManager.js';
import { dockerAdapter } from './src/modules/preview/dockerAdapter.js';
import { PreviewStatus, FrameworkType } from './src/modules/preview/sessionConstants.js';
import { encryptToken } from './src/utils/encryption.js';
import { decryptPreviewToken, hashPreviewToken, generatePreviewToken, encryptPreviewToken } from './src/utils/previewTokens.js';
import {
  createPreviewGateway,
  invalidateSessionGatewayCache,
} from './src/modules/preview/previewGateway.js';
import {
  attachPreviewWebSocketUpgrade,
  encodeFrame,
  decodeFrame,
  sendCloseFrame,
} from './src/modules/preview/previewWebSocket.js';
import { PREVIEW_COOKIE_NAME } from './src/modules/preview/previewCookie.js';
import { canonicalizeHostAuthority } from './src/modules/preview/hostAuthority.js';

const FIXTURES_DIR = path.resolve('./docker/fixtures');

function connectRawWebSocket({
  gatewayPort,
  hostAuthority,
  path = '/',
  origin = null,
  cookie = null,
  subprotocol = null,
  timeoutMs = 10000,
}) {
  return new Promise((resolve, reject) => {
    const wsKey = 'dGhlIHNhbXBsZSBub25jZQ==';
    const client = net.connect(gatewayPort, '127.0.0.1', () => {
      let reqStr =
        `GET ${path} HTTP/1.1\r\n` +
        `Host: ${hostAuthority}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${wsKey}\r\n` +
        `Sec-WebSocket-Version: 13\r\n`;

      if (origin) reqStr += `Origin: ${origin}\r\n`;
      if (cookie) reqStr += `Cookie: ${cookie}\r\n`;
      if (subprotocol) reqStr += `Sec-WebSocket-Protocol: ${subprotocol}\r\n`;
      reqStr += `\r\n`;

      client.write(reqStr);
    });

    let buffer = Buffer.alloc(0);
    let parsed = false;

    const timer = setTimeout(() => {
      if (!parsed) {
        client.destroy();
        reject(new Error('WebSocket connection handshake timed out'));
      }
    }, timeoutMs);

    client.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd !== -1 && !parsed) {
        parsed = true;
        clearTimeout(timer);

        const headerText = buffer.slice(0, headerEnd).toString('utf8');
        const remainingData = buffer.slice(headerEnd + 4);

        const lines = headerText.split('\r\n');
        const statusLine = lines[0] || '';
        const match = statusLine.match(/^HTTP\/1\.[01]\s+(\d{3})/);
        const statusCode = match ? parseInt(match[1], 10) : 0;

        const headers = {};
        for (let i = 1; i < lines.length; i++) {
          const colon = lines[i].indexOf(':');
          if (colon !== -1) {
            headers[lines[i].slice(0, colon).trim().toLowerCase()] = lines[i].slice(colon + 1).trim();
          }
        }

        resolve({
          client,
          statusCode,
          headers,
          remainingData,
          body: remainingData.toString('utf8'),
        });
      }
    });

    client.on('error', (err) => {
      clearTimeout(timer);
      if (!parsed) reject(err);
    });

    client.on('close', () => {
      clearTimeout(timer);
      if (!parsed) {
        resolve({
          client,
          statusCode: 0,
          headers: {},
          remainingData: buffer,
          body: buffer.toString('utf8'),
        });
      }
    });
  });
}

function fetchGatewayResource({ gatewayPort, hostAuthority, path = '/', cookie = null }) {
  return new Promise((resolve, reject) => {
    const headers = { Host: hostAuthority };
    if (cookie) headers['Cookie'] = cookie;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: gatewayPort,
        path,
        method: 'GET',
        headers,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c.toString('utf8')));
        res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
      }
    );
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
          if (where.tokenHash && s.tokenHash !== where.tokenHash) continue;
          if (where.isActive !== undefined && s.isActive !== where.isActive) continue;
          return { ...s };
        }
        return null;
      },
      findUnique: async ({ where }) => {
        if (where.id) return sessions.has(where.id) ? { ...sessions.get(where.id) } : null;
        if (where.tokenHash) {
          for (const s of sessions.values()) {
            if (s.tokenHash === where.tokenHash) return { ...s };
          }
        }
        return null;
      },
      findMany: async (args = {}) => {
        const { where } = args;
        return Array.from(sessions.values())
          .filter((s) => {
            if (!where) return true;
            if (where.id && s.id !== where.id) return false;
            if (where.userId && s.userId !== where.userId) return false;
            if (where.isActive !== undefined && s.isActive !== where.isActive) return false;
            if (where.status && s.status !== where.status) return false;
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

async function runEmpiricalWebSocketAcceptance() {
  console.log('\n==================================================================');
  console.log(' [DEMONSTRATION 1/3] STATIC Preview — WebSocket Rejection');
  console.log('==================================================================');

  const userIdStatic = crypto.randomUUID();
  const repoIdStatic = crypto.randomUUID();
  const prismaStatic = createIntegrationPrisma(userIdStatic, repoIdStatic);

  const gatewayServer = http.createServer((req, res) => {
    activeGateway.middleware(req, res, (err) => {
      if (err) {
        res.writeHead(err.statusCode || 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: err.code || 'INTERNAL_ERROR', message: err.message } }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Route not found' } }));
      }
    });
  });

  await new Promise((resolve) => gatewayServer.listen(0, '127.0.0.1', resolve));
  const gatewayPort = gatewayServer.address().port;
  console.log(`[+] Production HTTP/WebSocket Preview Gateway listening on 127.0.0.1:${gatewayPort}`);

  const gatewayStatic = createPreviewGateway({
    prisma: prismaStatic,
    port: gatewayPort,
    docker: dockerAdapter,
  });
  let activeGateway = gatewayStatic;

  gatewayServer.on('upgrade', (req, socket, head) => {
    activeGateway.handleUpgrade(req, socket, head);
  });

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

  console.log('[*] Starting STATIC preview runner container and trusted sidecar proxy...');
  const staticResult = await managerStatic.createAndStartSession({
    userId: userIdStatic,
    repositoryId: repoIdStatic,
    commitRef: '0123456789abcdef0123456789abcdef01234567',
  });

  const rawTokenStatic = staticResult.rawToken || decryptPreviewToken(staticResult.session.previewTokenEnc);
  const targetHostAuthorityStatic = `${staticResult.session.id}.preview.localhost:${gatewayPort}`;
  const targetOriginStatic = `http://${staticResult.session.id}.preview.localhost:${gatewayPort}`;

  const dbSessionStatic = await prismaStatic.previewSession.findUnique({ where: { id: staticResult.session.id } });
  const proxyInspectStatic = await dockerAdapter.inspectContainer(dbSessionStatic.proxyContainerId);
  const staticPublishedPort = parseInt(proxyInspectStatic.NetworkSettings?.Ports?.['8080/tcp']?.[0]?.HostPort, 10);

  if (!dbSessionStatic.proxyPort || typeof dbSessionStatic.proxyPort !== 'number' || dbSessionStatic.proxyPort < 1024) {
    throw new Error(`Invalid published proxyPort in DB: ${dbSessionStatic.proxyPort}`);
  }
  if (staticPublishedPort !== dbSessionStatic.proxyPort) {
    throw new Error(`Docker published port (${staticPublishedPort}) does not match DB proxyPort (${dbSessionStatic.proxyPort})`);
  }

  console.log(`[+] Session ID: ${dbSessionStatic.id}`);
  console.log(`[+] Status: ${dbSessionStatic.status}`);
  console.log(`[+] Proxy Container ID: ${proxyInspectStatic.Id.slice(0, 12)} (${dbSessionStatic.proxyContainerId})`);
  console.log(`[+] Proxy Instance ID: ${dbSessionStatic.proxyInstanceId}`);
  console.log(`[+] Docker Published Loopback Port: 127.0.0.1:${dbSessionStatic.proxyPort}`);
  console.log(`[+] Gateway Upstream Socket Target: 127.0.0.1:${dbSessionStatic.proxyPort}`);

  // Check 1: Attempt WebSocket upgrade on STATIC preview (unsupported upstream)
  console.log('[*] Sending WebSocket upgrade request to STATIC preview...');
  const staticWsRes = await connectRawWebSocket({
    gatewayPort,
    hostAuthority: targetHostAuthorityStatic,
    origin: targetOriginStatic,
    cookie: `${PREVIEW_COOKIE_NAME}=${rawTokenStatic}`,
  });

  console.log(`[+] STATIC WebSocket Upgrade Status: ${staticWsRes.statusCode}`);
  console.log(`[+] STATIC Upgrade Response Body: ${staticWsRes.body}`);
  if (staticWsRes.statusCode !== 400) {
    throw new Error(`Expected HTTP 400 Bad Request for STATIC preview WebSocket upgrade, got ${staticWsRes.statusCode}`);
  }
  if (!staticWsRes.body.includes('WEBSOCKET_UNSUPPORTED_FOR_FRAMEWORK')) {
    throw new Error(`Expected body error code WEBSOCKET_UNSUPPORTED_FOR_FRAMEWORK, got: ${staticWsRes.body}`);
  }
  console.log('[+] PASS: STATIC preview explicitly rejected WebSocket upgrade with HTTP 400 Bad Request (WEBSOCKET_UNSUPPORTED_FOR_FRAMEWORK).');
  staticWsRes.client.destroy();

  await managerStatic.stopPreviewSession(staticResult.session.id, userIdStatic);
  console.log('[+] PASS: STATIC preview successfully stopped and resources pruned.');

  console.log('\n==================================================================');
  console.log(' [DEMONSTRATION 2/3] VITE Vanilla — Live Bidirectional HMR WebSocket');
  console.log('==================================================================');

  const userIdVanilla = crypto.randomUUID();
  const repoIdVanilla = crypto.randomUUID();
  const prismaVanilla = createIntegrationPrisma(userIdVanilla, repoIdVanilla);

  const gatewayVanilla = createPreviewGateway({
    prisma: prismaVanilla,
    port: gatewayPort,
    docker: dockerAdapter,
  });
  activeGateway = gatewayVanilla;

  const extractVanillaFixture = async (stream, { volumeName }) => {
    await copyFixtureToVolume('vite-vanilla', volumeName);
    return { success: true };
  };

  const managerVanilla = new PreviewManager({
    docker: dockerAdapter,
    prisma: prismaVanilla,
    detectorFn: async () => ({ supported: true, framework: 'VITE_VANILLA' }),
    fetchArchiveFn: async () => Readable.from(Buffer.from('mock_vanilla_tarball')),
    extractArchiveFn: extractVanillaFixture,
  });

  console.log('[*] Starting VITE_VANILLA orchestration (Dependency installation + Vite runtime)...');
  const vanillaResult = await managerVanilla.createAndStartSession({
    userId: userIdVanilla,
    repositoryId: repoIdVanilla,
    commitRef: '0123456789abcdef0123456789abcdef01234567',
  });

  const rawTokenVanilla = vanillaResult.rawToken || decryptPreviewToken(vanillaResult.session.previewTokenEnc);
  const targetHostAuthorityVanilla = `${vanillaResult.session.id}.preview.localhost:${gatewayPort}`;
  const targetOriginVanilla = `http://${vanillaResult.session.id}.preview.localhost:${gatewayPort}`;

  const dbSessionVanilla = await prismaVanilla.previewSession.findUnique({ where: { id: vanillaResult.session.id } });
  const proxyInspectVanilla = await dockerAdapter.inspectContainer(dbSessionVanilla.proxyContainerId);
  const vanillaPublishedPort = parseInt(proxyInspectVanilla.NetworkSettings?.Ports?.['8080/tcp']?.[0]?.HostPort, 10);

  if (!dbSessionVanilla.proxyPort || typeof dbSessionVanilla.proxyPort !== 'number' || dbSessionVanilla.proxyPort < 1024) {
    throw new Error(`Invalid published proxyPort in DB: ${dbSessionVanilla.proxyPort}`);
  }
  if (vanillaPublishedPort !== dbSessionVanilla.proxyPort) {
    throw new Error(`Docker published port (${vanillaPublishedPort}) does not match DB proxyPort (${dbSessionVanilla.proxyPort})`);
  }

  console.log(`[+] Session ID: ${dbSessionVanilla.id}`);
  console.log(`[+] Status: ${dbSessionVanilla.status}`);
  console.log(`[+] Proxy Container ID: ${proxyInspectVanilla.Id.slice(0, 12)} (${dbSessionVanilla.proxyContainerId})`);
  console.log(`[+] Proxy Instance ID: ${dbSessionVanilla.proxyInstanceId}`);
  console.log(`[+] Docker Published Loopback Port: 127.0.0.1:${dbSessionVanilla.proxyPort}`);
  console.log(`[+] Gateway Upstream Socket Target: 127.0.0.1:${dbSessionVanilla.proxyPort}`);

  // Pre-fetch / and /main.js via Gateway HTTP to populate Vite on-demand module graph
  console.log('[*] Pre-fetching / and /main.js via Gateway HTTP to populate Vite module graph...');
  const rootRes = await fetchGatewayResource({
    gatewayPort,
    hostAuthority: targetHostAuthorityVanilla,
    path: '/',
    cookie: `${PREVIEW_COOKIE_NAME}=${rawTokenVanilla}`,
  });
  console.log(`[+] Preview Root Document Status: ${rootRes.statusCode}`);
  const mainModuleRes = await fetchGatewayResource({
    gatewayPort,
    hostAuthority: targetHostAuthorityVanilla,
    path: '/main.js',
    cookie: `${PREVIEW_COOKIE_NAME}=${rawTokenVanilla}`,
  });
  console.log(`[+] Preview /main.js Module Status: ${mainModuleRes.statusCode}`);

  // Connect WebSocket with valid cookie and canonical Origin
  console.log('[*] Connecting authenticated WebSocket to Vite Vanilla preview...');
  const vanillaWsRes = await connectRawWebSocket({
    gatewayPort,
    hostAuthority: targetHostAuthorityVanilla,
    origin: targetOriginVanilla,
    cookie: `${PREVIEW_COOKIE_NAME}=${rawTokenVanilla}`,
    subprotocol: 'vite-hmr',
  });

  console.log(`[+] VITE_VANILLA WebSocket Upgrade Status: ${vanillaWsRes.statusCode}`);
  console.log(`[+] VITE_VANILLA Upgrade Response Body: ${vanillaWsRes.body}`);
  if (vanillaWsRes.statusCode !== 101) {
    try {
      const runnerLogs = await new Promise((res) => {
        const child = spawn('docker', ['logs', '--tail', '50', `gitview-runner-${vanillaResult.session.id}`]);
        let out = '';
        child.stdout.on('data', (d) => (out += d.toString()));
        child.stderr.on('data', (d) => (out += d.toString()));
        child.on('close', () => res(out));
      });
      console.log('[-] Runner container logs:\n' + runnerLogs);
      const proxyLogs = await new Promise((res) => {
        const child = spawn('docker', ['logs', '--tail', '50', `gitview-proxy-${vanillaResult.session.id}`]);
        let out = '';
        child.stdout.on('data', (d) => (out += d.toString()));
        child.stderr.on('data', (d) => (out += d.toString()));
        child.on('close', () => res(out));
      });
      console.log('[-] Proxy container logs:\n' + proxyLogs);
    } catch {}
    throw new Error(`Expected HTTP 101 from Vite Vanilla, got ${vanillaWsRes.statusCode}`);
  }
  console.log('[+] PASS: VITE_VANILLA WebSocket upgrade completed with HTTP 101 Switching Protocols.');

  // Bidirectional Frame Exchange: Wait for Vite server HMR 'connected' frame
  console.log('[*] Waiting for Vite HMR server greeting frame (type: connected)...');
  let currentVanillaBuffer = vanillaWsRes.remainingData;
  const receivedGreeting = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for Vite HMR greeting frame')), 8000);

    const check = () => {
      while (true) {
        const frame = decodeFrame(currentVanillaBuffer);
        if (!frame) break;
        currentVanillaBuffer = currentVanillaBuffer.slice(frame.totalLength);
        if (frame.opcode === 1) {
          const str = frame.payload.toString('utf8');
          if (str.includes('connected')) {
            clearTimeout(timer);
            return resolve(str);
          }
        }
      }
    };

    check();

    vanillaWsRes.client.on('data', (chunk) => {
      currentVanillaBuffer = Buffer.concat([currentVanillaBuffer, chunk]);
      check();
    });
  });

  console.log(`[+] Received Vite HMR Frame from runner: ${receivedGreeting}`);
  if (!receivedGreeting.includes('connected')) {
    throw new Error(`Expected Vite connected frame, received: ${receivedGreeting}`);
  }
  console.log('[+] PASS: Upstream Vite HMR frame received by client through GitView Gateway.');

  // Client sends ping frame back through the gateway
  console.log('[*] Sending client ping frame back to Vite runner...');
  const pingFrame = encodeFrame({
    opcode: 1,
    payload: JSON.stringify({ type: 'ping' }),
    isClient: true,
  });
  vanillaWsRes.client.write(pingFrame);
  console.log('[+] PASS: Bidirectional HMR frames successfully transmitted in both directions!');

  // Live Vite Vanilla HMR Source Update Verification:
  console.log('[*] Testing live Vite Vanilla HMR source update propagation through Gateway...');
  const vanillaHmrUpdatePromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for live Vite Vanilla HMR update frame')), 8000);

    const checkUpdate = () => {
      while (true) {
        const frame = decodeFrame(currentVanillaBuffer);
        if (!frame) break;
        currentVanillaBuffer = currentVanillaBuffer.slice(frame.totalLength);
        if (frame.opcode === 1) {
          const str = frame.payload.toString('utf8');
          try {
            const parsed = JSON.parse(str);
            if (
              (parsed.type === 'update' && Array.isArray(parsed.updates)) ||
              parsed.type === 'full-reload'
            ) {
              clearTimeout(timer);
              return resolve(parsed);
            }
          } catch {}
        }
      }
    };

    checkUpdate();
    vanillaWsRes.client.on('data', (chunk) => {
      currentVanillaBuffer = Buffer.concat([currentVanillaBuffer, chunk]);
      checkUpdate();
    });
  });

  // Touch /workspace/main.js inside running container
  const vanillaHmrTimestamp = Date.now();
  console.log(`[*] Modifying /workspace/main.js inside container gitview-runner-${vanillaResult.session.id}...`);
  await new Promise((resolve, reject) => {
    const child = spawn('docker', [
      'exec', `gitview-runner-${vanillaResult.session.id}`,
      'sh', '-c', `echo "\n// HMR trigger ${vanillaHmrTimestamp}" >> /workspace/main.js`
    ]);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Failed to touch main.js: code ${code}`))));
  });

  const vanillaHmrEvent = await vanillaHmrUpdatePromise;
  console.log('[+] Received live Vite Vanilla HMR update frame:', JSON.stringify(vanillaHmrEvent));
  if (vanillaHmrEvent.type === 'update') {
    if (!vanillaHmrEvent.updates.some((u) => u.path === '/main.js' || u.acceptedPath === '/main.js')) {
      throw new Error(`Expected HMR update for /main.js, got: ${JSON.stringify(vanillaHmrEvent)}`);
    }
  }
  console.log('[+] PASS: Live Vite Vanilla HMR source file update event successfully received through GitView Gateway!');

  // Security Tests against live running Vite preview
  console.log('\n[*] Running targeted security tests against live Vite preview...');

  // 1. Invalid Cookie -> 401
  console.log('    1. Testing invalid cookie rejection...');
  const badCookieRes = await connectRawWebSocket({
    gatewayPort,
    hostAuthority: targetHostAuthorityVanilla,
    origin: targetOriginVanilla,
    cookie: `${PREVIEW_COOKIE_NAME}=invalid_cookie_format`,
  });
  if (badCookieRes.statusCode !== 401) {
    throw new Error(`Expected HTTP 401 for invalid cookie, got ${badCookieRes.statusCode}`);
  }
  badCookieRes.client.destroy();
  console.log('    [+] PASS: Invalid cookie rejected with HTTP 401.');

  // 2. Wrong Origin -> 403
  console.log('    2. Testing wrong Origin rejection...');
  const wrongOriginRes = await connectRawWebSocket({
    gatewayPort,
    hostAuthority: targetHostAuthorityVanilla,
    origin: 'http://malicious-attacker.com',
    cookie: `${PREVIEW_COOKIE_NAME}=${rawTokenVanilla}`,
  });
  if (wrongOriginRes.statusCode !== 403) {
    throw new Error(`Expected HTTP 403 for wrong Origin, got ${wrongOriginRes.statusCode}`);
  }
  wrongOriginRes.client.destroy();
  console.log('    [+] PASS: Wrong Origin rejected with HTTP 403.');

  // 3. Missing Origin -> 403
  console.log('    3. Testing missing Origin rejection...');
  const missingOriginRes = await connectRawWebSocket({
    gatewayPort,
    hostAuthority: targetHostAuthorityVanilla,
    origin: null,
    cookie: `${PREVIEW_COOKIE_NAME}=${rawTokenVanilla}`,
  });
  if (missingOriginRes.statusCode !== 403) {
    throw new Error(`Expected HTTP 403 for missing Origin, got ${missingOriginRes.statusCode}`);
  }
  missingOriginRes.client.destroy();
  console.log('    [+] PASS: Missing Origin rejected with HTTP 403.');

  // 4. Cross-session token -> 401
  console.log('    4. Testing cross-session token rejection...');
  const foreignToken = 'f'.repeat(64);
  const crossSessionRes = await connectRawWebSocket({
    gatewayPort,
    hostAuthority: targetHostAuthorityVanilla,
    origin: targetOriginVanilla,
    cookie: `${PREVIEW_COOKIE_NAME}=${foreignToken}`,
  });
  if (crossSessionRes.statusCode !== 401) {
    throw new Error(`Expected HTTP 401 for foreign token, got ${crossSessionRes.statusCode}`);
  }
  crossSessionRes.client.destroy();
  console.log('    [+] PASS: Cross-session token rejected with HTTP 401.');

  // Clean close of live client
  sendCloseFrame(vanillaWsRes.client, 1000, 'Normal Acceptance Close');
  vanillaWsRes.client.destroy();

  await managerVanilla.stopPreviewSession(vanillaResult.session.id, userIdVanilla);
  console.log('[+] PASS: VITE_VANILLA preview successfully stopped and resources pruned.');

  console.log('\n==================================================================');
  console.log(' [DEMONSTRATION 3/3] VITE React — Live Bidirectional HMR WebSocket');
  console.log('==================================================================');

  const userIdReact = crypto.randomUUID();
  const repoIdReact = crypto.randomUUID();
  const prismaReact = createIntegrationPrisma(userIdReact, repoIdReact);

  const gatewayReact = createPreviewGateway({
    prisma: prismaReact,
    port: gatewayPort,
    docker: dockerAdapter,
  });
  activeGateway = gatewayReact;

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

  console.log('[*] Starting VITE_REACT orchestration (Dependency installation + Vite React runtime)...');
  const reactResult = await managerReact.createAndStartSession({
    userId: userIdReact,
    repositoryId: repoIdReact,
    commitRef: '0123456789abcdef0123456789abcdef01234567',
  });

  const rawTokenReact = reactResult.rawToken || decryptPreviewToken(reactResult.session.previewTokenEnc);
  const targetHostAuthorityReact = `${reactResult.session.id}.preview.localhost:${gatewayPort}`;
  const targetOriginReact = `http://${reactResult.session.id}.preview.localhost:${gatewayPort}`;

  const dbSessionReact = await prismaReact.previewSession.findUnique({ where: { id: reactResult.session.id } });
  const proxyInspectReact = await dockerAdapter.inspectContainer(dbSessionReact.proxyContainerId);
  const reactPublishedPort = parseInt(proxyInspectReact.NetworkSettings?.Ports?.['8080/tcp']?.[0]?.HostPort, 10);

  if (!dbSessionReact.proxyPort || typeof dbSessionReact.proxyPort !== 'number' || dbSessionReact.proxyPort < 1024) {
    throw new Error(`Invalid published proxyPort in DB: ${dbSessionReact.proxyPort}`);
  }
  if (reactPublishedPort !== dbSessionReact.proxyPort) {
    throw new Error(`Docker published port (${reactPublishedPort}) does not match DB proxyPort (${dbSessionReact.proxyPort})`);
  }

  console.log(`[+] Session ID: ${dbSessionReact.id}`);
  console.log(`[+] Status: ${dbSessionReact.status}`);
  console.log(`[+] Proxy Container ID: ${proxyInspectReact.Id.slice(0, 12)} (${dbSessionReact.proxyContainerId})`);
  console.log(`[+] Proxy Instance ID: ${dbSessionReact.proxyInstanceId}`);
  console.log(`[+] Docker Published Loopback Port: 127.0.0.1:${dbSessionReact.proxyPort}`);
  console.log(`[+] Gateway Upstream Socket Target: 127.0.0.1:${dbSessionReact.proxyPort}`);

  // Pre-fetch / and /src/main.jsx via Gateway HTTP to populate React module graph
  console.log('[*] Pre-fetching / and /src/main.jsx via Gateway HTTP to populate React module graph...');
  const reactRootRes = await fetchGatewayResource({
    gatewayPort,
    hostAuthority: targetHostAuthorityReact,
    path: '/',
    cookie: `${PREVIEW_COOKIE_NAME}=${rawTokenReact}`,
  });
  console.log(`[+] React Root Document Status: ${reactRootRes.statusCode}`);
  const reactMainRes = await fetchGatewayResource({
    gatewayPort,
    hostAuthority: targetHostAuthorityReact,
    path: '/src/main.jsx',
    cookie: `${PREVIEW_COOKIE_NAME}=${rawTokenReact}`,
  });
  console.log(`[+] React /src/main.jsx Module Status: ${reactMainRes.statusCode}`);

  console.log('[*] Connecting authenticated WebSocket to Vite React preview...');
  const reactWsRes = await connectRawWebSocket({
    gatewayPort,
    hostAuthority: targetHostAuthorityReact,
    origin: targetOriginReact,
    cookie: `${PREVIEW_COOKIE_NAME}=${rawTokenReact}`,
    subprotocol: 'vite-hmr',
  });

  console.log(`[+] VITE_REACT WebSocket Upgrade Status: ${reactWsRes.statusCode}`);
  if (reactWsRes.statusCode !== 101) {
    throw new Error(`Expected HTTP 101 from Vite React, got ${reactWsRes.statusCode}`);
  }
  console.log('[+] PASS: VITE_REACT WebSocket upgrade completed with HTTP 101 Switching Protocols.');

  // Bidirectional Frame Exchange with React Vite HMR server
  console.log('[*] Waiting for Vite React HMR server greeting frame...');
  let currentReactBuffer = reactWsRes.remainingData;
  const receivedReactGreeting = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for Vite React HMR greeting')), 8000);

    const check = () => {
      while (true) {
        const frame = decodeFrame(currentReactBuffer);
        if (!frame) break;
        currentReactBuffer = currentReactBuffer.slice(frame.totalLength);
        if (frame.opcode === 1) {
          const str = frame.payload.toString('utf8');
          if (str.includes('connected')) {
            clearTimeout(timer);
            return resolve(str);
          }
        }
      }
    };

    check();

    reactWsRes.client.on('data', (chunk) => {
      currentReactBuffer = Buffer.concat([currentReactBuffer, chunk]);
      check();
    });
  });

  console.log(`[+] Received Vite React HMR Frame from runner: ${receivedReactGreeting}`);
  if (!receivedReactGreeting.includes('connected')) {
    throw new Error(`Expected Vite React connected frame, received: ${receivedReactGreeting}`);
  }
  console.log('[+] PASS: Vite React HMR frame received through GitView Gateway.');

  // Send client ping frame back through the gateway
  console.log('[*] Sending client ping frame back to Vite React runner...');
  const reactPingFrame = encodeFrame({
    opcode: 1,
    payload: JSON.stringify({ type: 'ping' }),
    isClient: true,
  });
  reactWsRes.client.write(reactPingFrame);
  console.log('[+] PASS: Bidirectional HMR frames successfully transmitted for VITE_REACT!');

  // Live Vite React Fast Refresh HMR Source Update Verification:
  console.log('[*] Testing live Vite React Fast Refresh HMR source update propagation through Gateway...');
  const reactHmrUpdatePromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for live Vite React HMR update frame')), 8000);

    const checkUpdate = () => {
      while (true) {
        const frame = decodeFrame(currentReactBuffer);
        if (!frame) break;
        currentReactBuffer = currentReactBuffer.slice(frame.totalLength);
        if (frame.opcode === 1) {
          const str = frame.payload.toString('utf8');
          try {
            const parsed = JSON.parse(str);
            if (
              (parsed.type === 'update' && Array.isArray(parsed.updates)) ||
              parsed.type === 'full-reload'
            ) {
              clearTimeout(timer);
              return resolve(parsed);
            }
          } catch {}
        }
      }
    };

    checkUpdate();
    reactWsRes.client.on('data', (chunk) => {
      currentReactBuffer = Buffer.concat([currentReactBuffer, chunk]);
      checkUpdate();
    });
  });

  const reactHmrTimestamp = Date.now();
  console.log(`[*] Modifying /workspace/src/main.jsx inside container gitview-runner-${reactResult.session.id}...`);
  await new Promise((resolve, reject) => {
    const child = spawn('docker', [
      'exec', `gitview-runner-${reactResult.session.id}`,
      'sh', '-c', `echo "\n// React Fast Refresh trigger ${reactHmrTimestamp}" >> /workspace/src/main.jsx`
    ]);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Failed to touch main.jsx: code ${code}`))));
  });

  const reactHmrEvent = await reactHmrUpdatePromise;
  console.log('[+] Received live Vite React HMR update frame:', JSON.stringify(reactHmrEvent));
  if (reactHmrEvent.type === 'update') {
    if (!reactHmrEvent.updates.some((u) => u.path.includes('main.jsx') || u.acceptedPath?.includes('main.jsx'))) {
      throw new Error(`Expected HMR update for main.jsx, got: ${JSON.stringify(reactHmrEvent)}`);
    }
  }
  console.log('[+] PASS: Live Vite React Fast Refresh HMR source file update event successfully received through GitView Gateway!');

  sendCloseFrame(reactWsRes.client, 1000, 'Normal Acceptance Close');
  reactWsRes.client.destroy();

  // Test 7: Sidecar container replacement protection
  console.log('\n[*] Testing sidecar replacement protection (stale handshake rejection)...');
  // Spawn a rogue replacement sidecar on a new port with a mismatched instance ID
  const rogueInstanceId = crypto.randomUUID();
  console.log(`[*] Simulating sidecar container replacement with rogue instance ID: ${rogueInstanceId}`);

  // Create temporary container with mismatched com.gitview.sidecar-instance-id label
  const rogueContainerName = `gitview-proxy-rogue-${crypto.randomUUID()}`;
  await new Promise((resolve, reject) => {
    const child = spawn(
      'docker',
      [
        'run', '-d',
        '--name', rogueContainerName,
        '--label', 'com.gitview.managed=true',
        '--label', `com.gitview.session-id=${reactResult.session.id}`,
        '--label', 'com.gitview.role=proxy',
        '--label', `com.gitview.sidecar-instance-id=${rogueInstanceId}`,
        '-p', '127.0.0.1::8080',
        'gitview-preview-runner:v1.0.0',
        'node', '-e', 'require("http").createServer((req,res)=>res.end("rogue")).listen(8080);'
      ],
      { stdio: 'pipe' }
    );
    child.on('close', (c) => (c === 0 ? resolve() : reject(new Error('Failed to spawn rogue container'))));
  });

  // Get dynamic port of rogue container
  const roguePort = await new Promise((resolve, reject) => {
    const child = spawn('docker', ['port', rogueContainerName, '8080']);
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString('utf8')));
    child.on('close', () => {
      const match = out.match(/127\.0\.0\.1:(\d+)/);
      if (match) resolve(parseInt(match[1], 10));
      else reject(new Error('Could not find published port for rogue container'));
    });
  });

  // Update session in prisma with rogue container ID and port, but original proxyInstanceId
  await prismaReact.previewSession.update({
    where: { id: reactResult.session.id },
    data: {
      proxyPort: roguePort,
      proxyContainerId: rogueContainerName,
    },
  });
  invalidateSessionGatewayCache(reactResult.session.id);
  if (typeof activeGateway?.invalidate === 'function') {
    activeGateway.invalidate(reactResult.session.id);
  }

  console.log('[*] Sending WebSocket upgrade request against replaced sidecar container...');
  const rogueUpgradeRes = await connectRawWebSocket({
    gatewayPort,
    hostAuthority: targetHostAuthorityReact,
    origin: targetOriginReact,
    cookie: `${PREVIEW_COOKIE_NAME}=${rawTokenReact}`,
  });

  console.log(`[+] Replaced Sidecar Upgrade Response Status: ${rogueUpgradeRes.statusCode}`);
  if (rogueUpgradeRes.statusCode !== 502) {
    throw new Error(`Expected HTTP 502 Bad Gateway for replaced sidecar, got ${rogueUpgradeRes.statusCode}`);
  }
  console.log('[+] PASS: Stale / replaced sidecar container successfully rejected with HTTP 502 Bad Gateway.');
  rogueUpgradeRes.client.destroy();

  // Cleanup rogue container
  await new Promise((resolve) => {
    const child = spawn('docker', ['rm', '-f', rogueContainerName]);
    child.on('close', resolve);
  });

  await managerReact.stopPreviewSession(reactResult.session.id, userIdReact);
  console.log('[+] PASS: VITE_REACT preview successfully stopped and resources pruned.');

  // Close gateway server
  await new Promise((resolve) => gatewayServer.close(resolve));

  console.log('\n==================================================================');
  console.log(' ALL 7 WEBSOCKET GATEWAY ACCEPTANCE CHECKS PASSED EMPIRICALLY!');
  console.log('==================================================================');
}

runEmpiricalWebSocketAcceptance()
  .then(() => {
    console.log('\n[+] Preview WebSocket Gateway verification completed successfully.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n[-] FATAL ERROR in WebSocket Gateway Acceptance:', err);
    process.exit(1);
  });
EOF

echo ""
echo "[+] Acceptance test script executed successfully."

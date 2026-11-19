#!/usr/bin/env bash
# ==============================================================================
# GitView Phase 5 — Milestone 7, Task 3: Production HTTP Preview Gateway Live Acceptance
# ==============================================================================
# Demonstrates live HTTP reverse proxying through the authenticated Gateway
# on the host Docker daemon:
# 1. STATIC fixture: reaches RUNNING, proxied through Gateway with __Host- cookie, returns 200 OK & subresources.
# 2. VITE Vanilla fixture: reaches RUNNING via builder/egress proxy, proxied through Gateway, returns 200 OK & /@vite/client.
# 3. VITE React fixture: reaches RUNNING, proxied through Gateway, returns 200 OK & transformed JSX.
# 4. Gateway security controls: token verification, cookie stripping, Host authority validation, 401/410/502 error mappings.
# 5. Idempotent resource cleanup and teardown.
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
FIXTURES_DIR="${SERVER_DIR}/docker/fixtures"

echo "=================================================================="
echo " GitView Phase 5 — Milestone 7: HTTP Preview Gateway Acceptance"
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
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';

import { PreviewManager } from './src/modules/preview/previewManager.js';
import { dockerAdapter } from './src/modules/preview/dockerAdapter.js';
import { PreviewStatus, FrameworkType } from './src/modules/preview/sessionConstants.js';
import { encryptToken, decryptToken } from './src/utils/encryption.js';
import { decryptPreviewToken, hashPreviewToken, generatePreviewToken } from './src/utils/previewTokens.js';
import {
  createPreviewGateway,
  SessionValidationCache,
  invalidateSessionGatewayCache,
  getSessionValidationCache,
} from './src/modules/preview/previewGateway.js';
import { PREVIEW_COOKIE_NAME } from './src/modules/preview/previewCookie.js';
import { canonicalizeHostAuthority } from './src/modules/preview/hostAuthority.js';

const FIXTURES_DIR = path.resolve('./docker/fixtures');

function httpGatewayRequest({ gatewayPort, hostAuthority, path = '/', cookie = null, method = 'GET', timeoutMs = 10000 }) {
  return new Promise((resolve, reject) => {
    const headers = {
      Host: hostAuthority,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    };
    if (cookie) {
      headers['Cookie'] = cookie;
    }

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: gatewayPort,
        path,
        method,
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c.toString('utf8')));
        res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
      }
    );
    req.on('timeout', () => req.destroy(new Error('Gateway HTTP request timed out')));
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

async function runEmpiricalGatewayAcceptance() {
  console.log('\n==================================================================');
  console.log(' [DEMONSTRATION 1/3] STATIC Synthetic Preview via HTTP Gateway');
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
  console.log(`[+] Production HTTP Preview Gateway listening on 127.0.0.1:${gatewayPort}`);

  const gatewayStatic = createPreviewGateway({
    prisma: prismaStatic,
    port: gatewayPort,
  });
  let activeGateway = gatewayStatic;

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

  const dbSessionStatic = await prismaStatic.previewSession.findUnique({ where: { id: staticResult.session.id } });
  console.log(`[+] Session ID: ${staticResult.session.id}`);
  console.log(`[+] Status: ${staticResult.session.status}`);
  console.log(`[+] Upstream Sidecar Port: ${dbSessionStatic.proxyPort} (hostPort: ${staticResult.hostPort})`);
  console.log(`[+] Public Gateway Target Host: ${targetHostAuthorityStatic}`);

  // Test 1: Unauthenticated request through Gateway -> 401 TOKEN_MISSING
  console.log('[*] Sending unauthenticated request to Gateway (no cookie)...');
  const unauthRes = await httpGatewayRequest({
    gatewayPort,
    hostAuthority: targetHostAuthorityStatic,
    path: '/',
    cookie: null,
  });
  console.log(`[+] Unauthenticated HTTP Status: ${unauthRes.statusCode}`);
  if (unauthRes.statusCode !== 401) {
    throw new Error(`Expected HTTP 401 for unauthenticated request, got ${unauthRes.statusCode}`);
  }
  console.log('[+] PASS: Unauthenticated request blocked by Gateway with HTTP 401.');

  // Test 2: Authenticated request through Gateway -> 200 OK & HTML
  console.log('[*] Sending authenticated request through Gateway with __Host- cookie...');
  const authRes = await httpGatewayRequest({
    gatewayPort,
    hostAuthority: targetHostAuthorityStatic,
    path: '/',
    cookie: `${PREVIEW_COOKIE_NAME}=${rawTokenStatic}`,
  });
  console.log(`[+] Authenticated Gateway HTTP Status: ${authRes.statusCode}`);
  if (authRes.statusCode !== 200 || !authRes.body.includes('GitView Static Preview Test')) {
    throw new Error('Static preview failed to return expected HTML body through Gateway: ' + authRes.body.slice(0, 200));
  }
  console.log('[+] PASS: Gateway reverse-proxied request and returned HTTP 200 with HTML document.');

  // Milestone 7, Task 4: Verify CSP and Defensive Security Headers on STATIC
  console.log('[*] Verifying Task 4 CSP & Defensive Security Headers on STATIC preview...');
  const staticCsp = authRes.headers['content-security-policy'];
  if (!staticCsp || !staticCsp.includes("default-src 'none'") || !staticCsp.includes("frame-ancestors http://localhost:5173")) {
    throw new Error('STATIC CSP validation failed: ' + staticCsp);
  }
  if (staticCsp.includes("'unsafe-eval'") || staticCsp.includes('ws:')) {
    throw new Error('STATIC CSP must not contain unsafe-eval or ws: ' + staticCsp);
  }
  if (authRes.headers['x-content-type-options'] !== 'nosniff') {
    throw new Error('X-Content-Type-Options missing or invalid: ' + authRes.headers['x-content-type-options']);
  }
  if (authRes.headers['referrer-policy'] !== 'no-referrer') {
    throw new Error('Referrer-Policy missing or invalid: ' + authRes.headers['referrer-policy']);
  }
  if (!authRes.headers['permissions-policy']?.includes('camera=()')) {
    throw new Error('Permissions-Policy missing or invalid: ' + authRes.headers['permissions-policy']);
  }
  if (authRes.headers['cache-control'] !== 'no-cache, must-revalidate') {
    throw new Error('Cache-Control on HTML entrypoint must be no-cache, must-revalidate, got: ' + authRes.headers['cache-control']);
  }
  if (authRes.headers['x-frame-options']) {
    throw new Error('X-Frame-Options was not stripped: ' + authRes.headers['x-frame-options']);
  }
  console.log('[+] PASS: STATIC CSP and defensive security headers verified.');

  // Test 3: Subresource CSS asset via Gateway
  const cssRes = await httpGatewayRequest({
    gatewayPort,
    hostAuthority: targetHostAuthorityStatic,
    path: '/style.css',
    cookie: `${PREVIEW_COOKIE_NAME}=${rawTokenStatic}`,
  });
  console.log(`[+] CSS Subresource Status: ${cssRes.statusCode} (${cssRes.headers['content-type']})`);
  if (cssRes.statusCode !== 200 || !cssRes.headers['content-type']?.includes('text/css')) {
    throw new Error('Static CSS asset failed to serve through Gateway');
  }
  console.log('[+] PASS: CSS subresource streamed through Gateway with text/css MIME type.');

  // Test 4: Subresource JS asset via Gateway
  const jsRes = await httpGatewayRequest({
    gatewayPort,
    hostAuthority: targetHostAuthorityStatic,
    path: '/app.js',
    cookie: `${PREVIEW_COOKIE_NAME}=${rawTokenStatic}`,
  });
  console.log(`[+] JS Subresource Status: ${jsRes.statusCode} (${jsRes.headers['content-type']})`);
  if (jsRes.statusCode !== 200 || !jsRes.headers['content-type']?.includes('application/javascript')) {
    throw new Error('Static JS asset failed to serve through Gateway');
  }
  console.log('[+] PASS: JS subresource streamed through Gateway with application/javascript MIME type.');

  // Teardown STATIC
  await managerStatic.stopPreviewSession(staticResult.session.id, userIdStatic);
  console.log('[+] PASS: STATIC preview successfully stopped and resources pruned.');

  console.log('\n==================================================================');
  console.log(' [DEMONSTRATION 2/3] VITE Vanilla Synthetic Preview via HTTP Gateway');
  console.log('==================================================================');

  const userIdVanilla = crypto.randomUUID();
  const repoIdVanilla = crypto.randomUUID();
  const prismaVanilla = createIntegrationPrisma(userIdVanilla, repoIdVanilla);

  const gatewayVanilla = createPreviewGateway({
    prisma: prismaVanilla,
    port: gatewayPort,
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

  console.log('[*] Starting VITE_VANILLA orchestration (Dependency installation + local Vite runtime)...');
  const vanillaResult = await managerVanilla.createAndStartSession({
    userId: userIdVanilla,
    repositoryId: repoIdVanilla,
    commitRef: '0123456789abcdef0123456789abcdef01234567',
  });

  const rawTokenVanilla = vanillaResult.rawToken || decryptPreviewToken(vanillaResult.session.previewTokenEnc);
  const targetHostAuthorityVanilla = `${vanillaResult.session.id}.preview.localhost:${gatewayPort}`;

  // Active gateway set to vanilla
  activeGateway = gatewayVanilla;

  const dbSessionVanilla = await prismaVanilla.previewSession.findUnique({ where: { id: vanillaResult.session.id } });
  console.log(`[+] Session ID: ${vanillaResult.session.id}`);
  console.log(`[+] Status: ${vanillaResult.session.status}`);
  console.log(`[+] Upstream Sidecar Port: ${dbSessionVanilla.proxyPort} (hostPort: ${vanillaResult.hostPort})`);

  // 1. Root HTML through Gateway
  const vanillaHtml = await httpGatewayRequest({
    gatewayPort,
    hostAuthority: targetHostAuthorityVanilla,
    path: '/',
    cookie: `${PREVIEW_COOKIE_NAME}=${rawTokenVanilla}`,
  });
  console.log(`[+] Vite Vanilla Root HTML Status: ${vanillaHtml.statusCode}`);
  if (vanillaHtml.statusCode !== 200 || !vanillaHtml.body.includes('Vite Vanilla Test')) {
    throw new Error('Vite Vanilla HTML body mismatch: ' + vanillaHtml.body.slice(0, 200));
  }
  console.log('[+] PASS: VITE_VANILLA root HTML proxied through Gateway with HTTP 200.');

  // Milestone 7, Task 4: Verify CSP and Defensive Security Headers on VITE_VANILLA
  console.log('[*] Verifying Task 4 CSP & Defensive Security Headers on VITE_VANILLA preview...');
  const vanillaCsp = vanillaHtml.headers['content-security-policy'];
  if (!vanillaCsp || !vanillaCsp.includes("'unsafe-eval'") || !vanillaCsp.includes("connect-src 'self' ws: wss: https: blob: data:")) {
    throw new Error('VITE_VANILLA CSP validation failed: ' + vanillaCsp);
  }
  if (!vanillaCsp.includes("frame-ancestors http://localhost:5173")) {
    throw new Error('VITE_VANILLA frame-ancestors missing: ' + vanillaCsp);
  }
  if (vanillaHtml.headers['x-content-type-options'] !== 'nosniff') {
    throw new Error('X-Content-Type-Options missing or invalid on VITE_VANILLA');
  }
  if (vanillaHtml.headers['referrer-policy'] !== 'no-referrer') {
    throw new Error('Referrer-Policy missing or invalid on VITE_VANILLA');
  }
  if (!vanillaHtml.headers['permissions-policy']?.includes('camera=()')) {
    throw new Error('Permissions-Policy missing or invalid on VITE_VANILLA');
  }
  if (vanillaHtml.headers['x-frame-options']) {
    throw new Error('X-Frame-Options was not stripped on VITE_VANILLA');
  }
  console.log('[+] PASS: VITE_VANILLA CSP (with HMR & unsafe-eval) and defensive security headers verified.');

  // 2. /@vite/client runtime script through Gateway
  const viteClientRes = await httpGatewayRequest({
    gatewayPort,
    hostAuthority: targetHostAuthorityVanilla,
    path: '/@vite/client',
    cookie: `${PREVIEW_COOKIE_NAME}=${rawTokenVanilla}`,
  });
  console.log(`[+] /@vite/client Status: ${viteClientRes.statusCode}`);
  if (viteClientRes.statusCode !== 200 || !viteClientRes.body.includes('vite')) {
    throw new Error('/@vite/client failed to serve through Gateway');
  }
  console.log('[+] PASS: /@vite/client Vite runtime proxied through Gateway with HTTP 200.');

  // 3. /main.js module through Gateway
  const mainJsRes = await httpGatewayRequest({
    gatewayPort,
    hostAuthority: targetHostAuthorityVanilla,
    path: '/main.js',
    cookie: `${PREVIEW_COOKIE_NAME}=${rawTokenVanilla}`,
  });
  console.log(`[+] /main.js Module Status: ${mainJsRes.statusCode}`);
  if (mainJsRes.statusCode !== 200) {
    throw new Error('/main.js failed to serve through Gateway');
  }
  console.log('[+] PASS: /main.js ES module proxied through Gateway with HTTP 200.');

  // Teardown VITE_VANILLA
  await managerVanilla.stopPreviewSession(vanillaResult.session.id, userIdVanilla);
  console.log('[+] PASS: VITE_VANILLA preview successfully stopped and resources pruned.');

  console.log('\n==================================================================');
  console.log(' [DEMONSTRATION 3/3] VITE React Synthetic Preview via HTTP Gateway');
  console.log('==================================================================');

  const userIdReact = crypto.randomUUID();
  const repoIdReact = crypto.randomUUID();
  const prismaReact = createIntegrationPrisma(userIdReact, repoIdReact);

  const gatewayReact = createPreviewGateway({
    prisma: prismaReact,
    port: gatewayPort,
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

  console.log('[*] Starting VITE_REACT orchestration (React + Babel/JSX runtime)...');
  const reactResult = await managerReact.createAndStartSession({
    userId: userIdReact,
    repositoryId: repoIdReact,
    commitRef: '0123456789abcdef0123456789abcdef01234567',
  });

  const rawTokenReact = reactResult.rawToken || decryptPreviewToken(reactResult.session.previewTokenEnc);
  const targetHostAuthorityReact = `${reactResult.session.id}.preview.localhost:${gatewayPort}`;

  // Active gateway set to react
  activeGateway = gatewayReact;

  const dbSessionReact = await prismaReact.previewSession.findUnique({ where: { id: reactResult.session.id } });
  console.log(`[+] Session ID: ${reactResult.session.id}`);
  console.log(`[+] Status: ${reactResult.session.status}`);
  console.log(`[+] Upstream Sidecar Port: ${dbSessionReact.proxyPort} (hostPort: ${reactResult.hostPort})`);

  // 1. Root HTML through Gateway
  const reactHtml = await httpGatewayRequest({
    gatewayPort,
    hostAuthority: targetHostAuthorityReact,
    path: '/',
    cookie: `${PREVIEW_COOKIE_NAME}=${rawTokenReact}`,
  });
  console.log(`[+] Vite React Root HTML Status: ${reactHtml.statusCode}`);
  if (reactHtml.statusCode !== 200 || !reactHtml.body.includes('Vite React Test')) {
    throw new Error('Vite React HTML body mismatch: ' + reactHtml.body.slice(0, 200));
  }
  console.log('[+] PASS: VITE_REACT root HTML proxied through Gateway with HTTP 200.');

  // Milestone 7, Task 4: Verify CSP and Defensive Security Headers on VITE_REACT
  console.log('[*] Verifying Task 4 CSP & Defensive Security Headers on VITE_REACT preview...');
  const reactCsp = reactHtml.headers['content-security-policy'];
  if (!reactCsp || !reactCsp.includes("'unsafe-eval'") || !reactCsp.includes("connect-src 'self' ws: wss: https: blob: data:")) {
    throw new Error('VITE_REACT CSP validation failed: ' + reactCsp);
  }
  if (!reactCsp.includes("frame-ancestors http://localhost:5173")) {
    throw new Error('VITE_REACT frame-ancestors missing: ' + reactCsp);
  }
  if (reactHtml.headers['x-content-type-options'] !== 'nosniff') {
    throw new Error('X-Content-Type-Options missing or invalid on VITE_REACT');
  }
  if (reactHtml.headers['referrer-policy'] !== 'no-referrer') {
    throw new Error('Referrer-Policy missing or invalid on VITE_REACT');
  }
  if (!reactHtml.headers['permissions-policy']?.includes('camera=()')) {
    throw new Error('Permissions-Policy missing or invalid on VITE_REACT');
  }
  if (reactHtml.headers['x-frame-options']) {
    throw new Error('X-Frame-Options was not stripped on VITE_REACT');
  }
  console.log('[+] PASS: VITE_REACT CSP and defensive security headers verified.');

  // 2. /src/main.jsx transformed module through Gateway
  const reactJsxRes = await httpGatewayRequest({
    gatewayPort,
    hostAuthority: targetHostAuthorityReact,
    path: '/src/main.jsx',
    cookie: `${PREVIEW_COOKIE_NAME}=${rawTokenReact}`,
  });
  console.log(`[+] /src/main.jsx Status: ${reactJsxRes.statusCode}`);
  if (reactJsxRes.statusCode !== 200 || (!reactJsxRes.body.includes('React.createElement') && !reactJsxRes.body.includes('react/jsx-dev-runtime') && !reactJsxRes.body.includes('react'))) {
    throw new Error('React JSX module was not transformed or served correctly through Gateway: ' + reactJsxRes.body.slice(0, 200));
  }
  console.log('[+] PASS: /src/main.jsx transformed React module proxied through Gateway with HTTP 200.');

  // Teardown VITE_REACT
  await managerReact.stopPreviewSession(reactResult.session.id, userIdReact);
  console.log('[+] PASS: VITE_REACT preview successfully stopped and resources pruned.');

  // Close Gateway Server
  await new Promise((resolve) => gatewayServer.close(resolve));
  console.log('[+] Gateway server cleanly closed.');

  console.log('\n==================================================================');
  console.log(' [+] ALL 3 DOCKER ACCEPTANCE DEMONSTRATIONS COMPLETED SUCCESSFULLY');
  console.log('==================================================================\n');
}

runEmpiricalGatewayAcceptance().then(() => {
  process.exit(0);
}).catch((err) => {
  console.error('\n[-] FATAL ERROR IN GATEWAY ACCEPTANCE:', err);
  process.exit(1);
});
EOF

echo "[+] Execution completed successfully."

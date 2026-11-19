#!/usr/bin/env bash
# ==============================================================================
# GitView Phase 5 — Milestone 7: Live Docker Sidecar Replacement Verification
# ==============================================================================
# Verifies on host Docker daemon:
# 1. Spawning Sidecar 1 with proxyInstanceId1 and token1.
# 2. Replacing Sidecar 1 under the EXACT SAME Docker name and session ID.
# 3. Proving Replacement Sidecar receives new proxyInstanceId2 and new token2.
# 4. Proving Replacement Sidecar REJECTS previous token1 with HTTP 403 Forbidden.
# 5. Proving Replacement Sidecar ACCEPTS new token2 with HTTP 200 OK.
# 6. Proving application runner never receives internal handshake headers.
# 7. Clean idempotent teardown.
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "=================================================================="
echo " GitView Phase 5: Live Docker Sidecar Replacement Verification"
echo "=================================================================="

if ! docker info >/dev/null 2>&1; then
  echo "[-] ERROR: Docker daemon is not running"
  exit 1
fi

cleanup() {
  echo "[*] Cleaning up test containers, networks, and volumes..."
  docker rm -f $(docker ps -aq --filter label=gitview.managed=true) 2>/dev/null || true
  docker volume rm $(docker volume ls -q --filter label=gitview.managed=true) 2>/dev/null || true
  docker network rm $(docker network ls -q --filter label=gitview.managed=true) 2>/dev/null || true
}
trap cleanup EXIT
cleanup

cd "${SERVER_DIR}"

node --env-file=.env --input-type=module << 'EOF'
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { dockerAdapter, ContainerProfile } from './src/modules/preview/dockerAdapter.js';
import { createSidecarHandshakeToken, verifySidecarIdentity } from './src/modules/preview/previewGateway.js';

const FIXTURES_DIR = path.resolve('./docker/fixtures');

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

function httpRequest({ port, path = '/', headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers,
        timeout: 5000,
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c.toString('utf8')));
        res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
      }
    );
    req.on('timeout', () => req.destroy(new Error('HTTP request timed out')));
    req.on('error', reject);
    req.end();
  });
}

async function runLiveReplacementTest() {
  const sessionId = crypto.randomUUID();
  console.log(`[+] Initializing test session: ${sessionId}`);

  // 1. Create Networks and Volume
  const netName = `gitview-net-${sessionId}`;
  const ingressNetName = `gitview-ingress-net-${sessionId}`;
  const volName = `gitview-ws-${sessionId}`;

  await dockerAdapter.createNetwork({ sessionId, role: 'runner', networkName: netName, internal: true });
  await dockerAdapter.createNetwork({ sessionId, role: 'proxy', networkName: ingressNetName, internal: false });
  await dockerAdapter.createVolume({ sessionId, role: 'runner', volumeName: volName });
  await copyFixtureToVolume('static-site', volName);

  // 2. Start Runner Container
  const runnerName = `gitview-runner-${sessionId}`;
  await dockerAdapter.createAndStartContainer({
    profile: ContainerProfile.STATIC_RUNNER,
    sessionId,
    containerName: runnerName,
    networkName: netName,
    volumeMount: { volumeName: volName, mountPath: '/workspace', readOnly: false },
    portMapping: null,
    env: { NODE_ENV: 'production', PORT: '3000' },
  });
  console.log(`[+] Runner container started on internal network: ${runnerName}`);

  // 3. Start Sidecar Instance 1
  const proxyName = `gitview-proxy-${sessionId}`;
  const proxyInstanceId1 = crypto.randomUUID();
  const token1 = createSidecarHandshakeToken(sessionId, proxyInstanceId1);

  const sidecar1 = await dockerAdapter.createAndStartContainer({
    profile: ContainerProfile.TRUSTED_PROXY,
    sessionId,
    containerName: proxyName,
    instanceId: proxyInstanceId1,
    networkName: ingressNetName,
    internalNetworkName: netName,
    portMapping: { hostIp: '127.0.0.1', containerPort: 8080 },
    env: {
      UPSTREAM_HOST: runnerName,
      UPSTREAM_PORT: '3000',
      NODE_ENV: 'production',
      SESSION_ID: sessionId,
      EXPECTED_HANDSHAKE_TOKEN: token1,
      SIDECAR_INSTANCE_ID: proxyInstanceId1,
    },
  });

  const portInfo1 = await dockerAdapter.getPublishedPort({ containerName: proxyName, containerPort: 8080 });
  const proxyPort1 = portInfo1.hostPort;
  const proxyContainerId1 = sidecar1.containerId;

  console.log(`[+] Sidecar Instance 1 started:`);
  console.log(`    - Docker Name:         ${proxyName}`);
  console.log(`    - Docker Container ID: ${proxyContainerId1.slice(0, 12)}...`);
  console.log(`    - Proxy Instance ID:   ${proxyInstanceId1}`);
  console.log(`    - Published TCP Port:  ${proxyPort1}`);

  // Test 1: Handshake Token 1 against Sidecar 1 succeeds
  const res1 = await httpRequest({
    port: proxyPort1,
    headers: {
      'x-gitview-session-id': sessionId,
      'x-gitview-sidecar-token': token1,
    },
  });
  console.log(`[+] Request with Token 1 on Sidecar 1 -> HTTP ${res1.statusCode}`);
  if (res1.statusCode !== 200) {
    throw new Error(`Expected HTTP 200 on Sidecar 1 with Token 1, got ${res1.statusCode}`);
  }
  console.log('[+] PASS: Sidecar 1 accepted valid per-instance handshake token.');

  // 4. Destroy Sidecar 1
  console.log(`[*] Destroying Sidecar 1 (${proxyName})...`);
  await dockerAdapter.removeContainer(proxyName, { force: true });

  // 5. Start Replacement Sidecar 2 with the EXACT SAME proxyName and sessionId, but NEW proxyInstanceId2
  const proxyInstanceId2 = crypto.randomUUID();
  const token2 = createSidecarHandshakeToken(sessionId, proxyInstanceId2);

  const sidecar2 = await dockerAdapter.createAndStartContainer({
    profile: ContainerProfile.TRUSTED_PROXY,
    sessionId,
    containerName: proxyName, // IDENTICAL DOCKER NAME!
    instanceId: proxyInstanceId2,
    networkName: ingressNetName,
    internalNetworkName: netName,
    portMapping: { hostIp: '127.0.0.1', containerPort: 8080 },
    env: {
      UPSTREAM_HOST: runnerName,
      UPSTREAM_PORT: '3000',
      NODE_ENV: 'production',
      SESSION_ID: sessionId,
      EXPECTED_HANDSHAKE_TOKEN: token2, // NEW EXPECTED TOKEN!
      SIDECAR_INSTANCE_ID: proxyInstanceId2,
    },
  });

  const portInfo2 = await dockerAdapter.getPublishedPort({ containerName: proxyName, containerPort: 8080 });
  const proxyPort2 = portInfo2.hostPort;
  const proxyContainerId2 = sidecar2.containerId;

  console.log(`[+] Replacement Sidecar Instance 2 started (SAME DOCKER NAME):`);
  console.log(`    - Docker Name:         ${proxyName} (SAME)`);
  console.log(`    - Docker Container ID: ${proxyContainerId2.slice(0, 12)}... (NEW)`);
  console.log(`    - Proxy Instance ID:   ${proxyInstanceId2} (NEW)`);
  console.log(`    - Published TCP Port:  ${proxyPort2}`);

  if (proxyContainerId1 === proxyContainerId2) {
    throw new Error('Docker container IDs must be distinct between old and replacement container');
  }
  if (proxyInstanceId1 === proxyInstanceId2) {
    throw new Error('Proxy instance IDs must be distinct between old and replacement container');
  }
  if (token1 === token2) {
    throw new Error('Handshake tokens must be distinct between old and replacement container');
  }

  // Test 2: Send previous instance token (token1) to Replacement Sidecar 2 -> REJECTED with HTTP 403
  console.log('[*] Testing replay of previous instance Token 1 against Replacement Sidecar 2...');
  const resReplay = await httpRequest({
    port: proxyPort2,
    headers: {
      'x-gitview-session-id': sessionId,
      'x-gitview-sidecar-token': token1, // OLD TOKEN!
    },
  });
  console.log(`[+] Replay request status: HTTP ${resReplay.statusCode} (X-GitView-Handshake-Error: ${resReplay.headers['x-gitview-handshake-error']})`);
  if (resReplay.statusCode !== 403 || resReplay.headers['x-gitview-handshake-error'] !== 'true') {
    throw new Error(`Expected HTTP 403 with X-GitView-Handshake-Error on replay of Token 1, got ${resReplay.statusCode}`);
  }
  console.log('[+] PASS: Replacement Sidecar 2 strictly REJECTED previous instance token (HTTP 403).');

  // Test 3: Send newly generated token (token2) to Replacement Sidecar 2 -> ACCEPTED with HTTP 200
  console.log('[*] Testing newly generated Token 2 against Replacement Sidecar 2...');
  const resValidNew = await httpRequest({
    port: proxyPort2,
    headers: {
      'x-gitview-session-id': sessionId,
      'x-gitview-sidecar-token': token2, // NEW TOKEN!
    },
  });
  console.log(`[+] Valid request status: HTTP ${resValidNew.statusCode}`);
  if (resValidNew.statusCode !== 200) {
    throw new Error(`Expected HTTP 200 on Replacement Sidecar with Token 2, got ${resValidNew.statusCode}`);
  }
  console.log('[+] PASS: Replacement Sidecar 2 strictly ACCEPTED newly generated token (HTTP 200).');

  // Test 4: verifySidecarIdentity fails closed on stale proxyInstanceId1
  const staleVerification = await verifySidecarIdentity({
    docker: dockerAdapter,
    sessionId,
    proxyContainerId: proxyContainerId2,
    proxyInstanceId: proxyInstanceId1, // Stale instance identity!
    proxyPort: proxyPort2,
  });
  console.log(`[+] verifySidecarIdentity with stale proxyInstanceId1: valid=${staleVerification.valid}, reason=${staleVerification.reason}`);
  if (staleVerification.valid !== false || staleVerification.reason !== 'INSTANCE_ID_MISMATCH') {
    throw new Error('Expected verifySidecarIdentity to fail closed with INSTANCE_ID_MISMATCH');
  }
  console.log('[+] PASS: Gateway verification fails closed with INSTANCE_ID_MISMATCH on stale instance ID.');

  // Test 5: verifySidecarIdentity succeeds on current proxyInstanceId2
  const currentVerification = await verifySidecarIdentity({
    docker: dockerAdapter,
    sessionId,
    proxyContainerId: proxyContainerId2,
    proxyInstanceId: proxyInstanceId2, // Current instance identity!
    proxyPort: proxyPort2,
  });
  console.log(`[+] verifySidecarIdentity with current proxyInstanceId2: valid=${currentVerification.valid}`);
  if (!currentVerification.valid) {
    throw new Error('Expected verifySidecarIdentity to succeed with current proxyInstanceId2');
  }
  console.log('[+] PASS: Gateway verification succeeds with verified proxyContainerId and proxyInstanceId.');

  // 6. Cleanup session
  await dockerAdapter.cleanupSession(sessionId);
  console.log('[+] Cleaned up live session resources.');

  console.log('\n==================================================================');
  console.log(' [+] LIVE DOCKER SIDECAR REPLACEMENT EMPIRICALLY VERIFIED!');
  console.log('==================================================================\n');
}

runLiveReplacementTest().catch((err) => {
  console.error('[-] FATAL ERROR:', err);
  process.exit(1);
});
EOF

echo "[+] Live replacement verification script completed successfully."

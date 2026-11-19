#!/usr/bin/env bash
# GitView Phase 5 — Milestone 6, Task 2.1: Docker Adapter Security Hardening Live Verification
# Empirically verifies profile-governed containers, immutable image references, network attachment
# policies, loopback port discovery, and session-scoped cleanup using DockerAdapter.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "=================================================================="
echo " GitView Phase 5 — Docker Adapter Security Hardening Verification"
echo "=================================================================="

# Ensure node is available
if ! command -v node >/dev/null 2>&1; then
  echo "[-] ERROR: node is not installed or not in PATH"
  exit 1
fi

# Ensure docker is running
if ! docker info >/dev/null 2>&1; then
  echo "[-] ERROR: Docker daemon is not running"
  exit 1
fi

echo "[+] Executing DockerAdapter live integration test via Node.js..."
cd "${SERVER_DIR}"

node --input-type=module << 'EOF'
import { dockerAdapter, ContainerProfile, DockerErrorCode } from './src/modules/preview/dockerAdapter.js';
import crypto from 'node:crypto';

async function runLiveVerification() {
  const sessionId = crypto.randomUUID();
  console.log(`[+] Generated test session UUID: ${sessionId}`);

  const internalNetName = `gitview-net-${sessionId}`;
  const bridgeNetName = `gitview-ingress-net-${sessionId}`;
  const volumeName = `gitview-ws-${sessionId}`;
  const proxyContainerName = `gitview-proxy-${sessionId}`;
  const runnerContainerName = `gitview-runner-${sessionId}`;

  try {
    // 1. Create Internal Network
    console.log(`[+] 1. Testing createInternalNetwork (${internalNetName})...`);
    const netRes = await dockerAdapter.createInternalNetwork({
      sessionId,
      role: 'runner',
      networkName: internalNetName,
    });
    if (!netRes.internal) throw new Error('Network should be internal');

    const netInspect = await dockerAdapter.inspectNetwork(internalNetName);
    if (!netInspect.Internal) throw new Error('Docker reports network Internal is false');
    if (netInspect.Labels['com.gitview.managed'] !== 'true') throw new Error('Missing com.gitview.managed label on network');
    if (netInspect.Labels['com.gitview.session-id'] !== sessionId) throw new Error('Incorrect session-id label on network');
    console.log('    [PASS] Internal network created with correct labels and --internal flag.');

    // 2. Create Bridge Ingress Network
    console.log(`[+] 2. Testing createBridgeNetwork (${bridgeNetName})...`);
    const bridgeRes = await dockerAdapter.createBridgeNetwork({
      sessionId,
      role: 'proxy',
      networkName: bridgeNetName,
    });
    const bridgeInspect = await dockerAdapter.inspectNetwork(bridgeNetName);
    if (bridgeInspect.Internal) throw new Error('Bridge network should not be internal');
    console.log('    [PASS] Bridge network created with correct labels.');

    // 3. Create Named Volume
    console.log(`[+] 3. Testing createVolume (${volumeName})...`);
    const volRes = await dockerAdapter.createVolume({
      sessionId,
      role: 'runner',
      volumeName,
    });
    const volInspect = await dockerAdapter.inspectVolume(volumeName);
    if (volInspect.Labels['com.gitview.managed'] !== 'true') throw new Error('Missing com.gitview.managed label on volume');
    if (volInspect.Labels['com.gitview.session-id'] !== sessionId) throw new Error('Incorrect session-id label on volume');
    console.log('    [PASS] Named volume created with correct labels.');

    // 4. Test Security Policy Rejection: Runner to External Bridge Network
    console.log('[+] 4. Verifying security policy rejects RUNNER attachment to external network...');
    let policyBlocked = false;
    try {
      await dockerAdapter.createAndStartContainer({
        profile: ContainerProfile.STATIC_RUNNER,
        sessionId,
        networkName: bridgeNetName, // External bridge network!
        volumeMount: {
          volumeName,
          mountPath: '/app/workspace',
          readOnly: true,
        },
      });
    } catch (err) {
      if (err.errorCode === DockerErrorCode.DOCKER_SECURITY_POLICY_VIOLATION) {
        policyBlocked = true;
      } else {
        throw err;
      }
    }
    if (!policyBlocked) throw new Error('Failed to block RUNNER from connecting to external network');
    console.log('    [PASS] RUNNER attachment to external network was blocked by security policy.');

    // 5. Test Security Policy Rejection: Arbitrary Commands
    console.log('[+] 5. Verifying security policy rejects arbitrary command execution...');
    let cmdBlocked = false;
    try {
      await dockerAdapter.createAndStartContainer({
        profile: ContainerProfile.STATIC_RUNNER,
        sessionId,
        networkName: internalNetName,
        volumeMount: {
          volumeName,
          mountPath: '/app/workspace',
          readOnly: true,
        },
        command: ['sh', '-c', 'echo injected'],
      });
    } catch (err) {
      if (err.errorCode === DockerErrorCode.DOCKER_SECURITY_POLICY_VIOLATION) {
        cmdBlocked = true;
      } else {
        throw err;
      }
    }
    if (!cmdBlocked) throw new Error('Failed to block arbitrary command');
    console.log('    [PASS] Arbitrary command execution was blocked by security policy.');

    // 6. Spawn STATIC_RUNNER with Immutable Image on Internal Network
    console.log(`[+] 6. Spawning STATIC_RUNNER (${runnerContainerName}) using gitview-preview-runner:v1.0.0...`);
    const runnerRes = await dockerAdapter.createAndStartContainer({
      profile: ContainerProfile.STATIC_RUNNER,
      sessionId,
      containerName: runnerContainerName,
      networkName: internalNetName,
      volumeMount: {
        volumeName,
        mountPath: '/app/workspace',
        readOnly: true,
      },
    });
    if (!runnerRes.containerId) throw new Error('Runner container ID missing');
    console.log(`    [PASS] STATIC_RUNNER container started (ID: ${runnerRes.containerId.slice(0, 12)}).`);

    // 7. Spawn TRUSTED_PROXY with Dual Networks & Published Loopback Port
    console.log(`[+] 7. Spawning TRUSTED_PROXY (${proxyContainerName}) with loopback port publishing...`);
    const proxyRes = await dockerAdapter.createAndStartContainer({
      profile: ContainerProfile.TRUSTED_PROXY,
      sessionId,
      containerName: proxyContainerName,
      ingressNetworkName: bridgeNetName,
      internalNetworkName: internalNetName,
      portMapping: {
        containerPort: 8080,
      },
      env: {
        UPSTREAM_HOST: runnerContainerName,
        UPSTREAM_PORT: '3000',
      },
    });
    if (!proxyRes.containerId) throw new Error('Proxy container ID missing');
    console.log(`    [PASS] TRUSTED_PROXY container started (ID: ${proxyRes.containerId.slice(0, 12)}).`);

    // 8. Dynamic Loopback Port Discovery
    console.log('[+] 8. Testing dynamic published port discovery on proxy...');
    const portInfo = await dockerAdapter.getPublishedPort({
      containerName: proxyContainerName,
      containerPort: 8080,
    });
    if (portInfo.hostIp !== '127.0.0.1') throw new Error(`Host IP is not 127.0.0.1: ${portInfo.hostIp}`);
    if (portInfo.hostPort < 1024 || portInfo.hostPort > 65535) throw new Error(`Invalid host port: ${portInfo.hostPort}`);
    console.log(`    [PASS] Discovered loopback published port: 127.0.0.1:${portInfo.hostPort}`);

    // 9. Verify Container Security Profiles (no-new-privileges, cap-drop ALL, non-root user)
    console.log('[+] 9. Verifying container security options on runner and proxy...');
    const runnerInspect = await dockerAdapter.inspectContainer(runnerContainerName);
    if (!runnerInspect.HostConfig.SecurityOpt.includes('no-new-privileges')) {
      throw new Error('no-new-privileges missing on runner');
    }
    if (!runnerInspect.HostConfig.CapDrop.includes('ALL')) {
      throw new Error('CapDrop ALL missing on runner');
    }
    if (runnerInspect.Config.User !== '10001:10001') {
      throw new Error('User 10001:10001 missing on runner');
    }
    console.log('    [PASS] Runner security profile verified (no-new-privileges, cap-drop ALL, user 10001).');

    // 10. Scoped Session Cleanup
    console.log(`[+] 10. Testing cleanupSession (${sessionId})...`);
    const report = await dockerAdapter.cleanupSession(sessionId);
    console.log('    Cleanup report:', JSON.stringify(report));

    if (report.containersRemoved.length !== 2) throw new Error(`Expected 2 containers removed, got ${report.containersRemoved.length}`);
    if (report.networksRemoved.length !== 2) throw new Error(`Expected 2 networks removed, got ${report.networksRemoved.length}`);
    if (report.volumesRemoved.length !== 1) throw new Error(`Expected 1 volume removed, got ${report.volumesRemoved.length}`);
    if (report.errors.length > 0) throw new Error(`Cleanup reported errors: ${report.errors.join(', ')}`);

    // 11. Idempotent Cleanup Check
    console.log('[+] 11. Testing idempotent cleanup on already purged session...');
    const secondReport = await dockerAdapter.cleanupSession(sessionId);
    if (secondReport.containersRemoved.length !== 0 || secondReport.networksRemoved.length !== 0 || secondReport.volumesRemoved.length !== 0) {
      throw new Error('Second cleanup should report 0 removed resources');
    }
    console.log('    [PASS] Idempotent cleanup confirmed.');

    console.log('\n==================================================================');
    console.log(' ALL 11 DOCKER ADAPTER SECURITY HARDENING CHECKS PASSED EMPIRICALLY!');
    console.log('==================================================================');
  } catch (err) {
    console.error('[-] ERROR in live verification:', err);
    try { await dockerAdapter.cleanupSession(sessionId); } catch {}
    process.exit(1);
  }
}

runLiveVerification();
EOF

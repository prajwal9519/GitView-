#!/usr/bin/env bash
# ==============================================================================
# GitView Phase 5 — Milestone 1 Acceptance Test 3: Network Isolation (Hardened)
# ==============================================================================
# Verifies that:
# 1. `docker network create --internal` blocks external TCP outbound traffic (e.g. 8.8.8.8:53, 1.1.1.1:80)
#    verified via real Node.js socket attempts, not missing ping binaries.
# 2. External DNS resolution (github.com) is tested; any successful resolution is treated as a security failure.
# 3. Connectivity to an explicitly configured temporary macOS host-side test service is tested,
#    categorizing errors: ECONNREFUSED, ETIMEDOUT, ENETUNREACH.
# 4. Cross-session isolation is tested using a real TCP listener in Network B and an attempted
#    connection from Network A, verifying that containers are NOT on a shared network.
# ==============================================================================

set -euo pipefail

NET_A="gitview-net-test-a-${RANDOM}"
NET_B="gitview-net-test-b-${RANDOM}"
CONTAINER_A="gitview-c-a-${RANDOM}"
CONTAINER_B="gitview-c-b-${RANDOM}"
IMAGE_NAME="node:22-bookworm-slim"
HOST_PORT_FILE=$(mktemp)
HOST_SERVER_PID=""

echo "======================================================================"
echo "TEST 3: Internal Network Isolation (--internal)"
echo "======================================================================"

# 0. Pre-flight check
if ! command -v docker &> /dev/null; then
  echo "[-] ERROR: Docker CLI is not installed or not in PATH."
  exit 1
fi

if ! docker info &> /dev/null; then
  echo "[-] ERROR: Docker daemon is not running."
  exit 1
fi

cleanup() {
  echo "[*] Cleaning up test resources..."
  if [[ -n "${HOST_SERVER_PID}" ]] && kill -0 "${HOST_SERVER_PID}" 2>/dev/null; then
    echo "[*] Terminating temporary host-side test service (PID: ${HOST_SERVER_PID})..."
    kill -TERM "${HOST_SERVER_PID}" 2>/dev/null || true
    wait "${HOST_SERVER_PID}" 2>/dev/null || true
  fi
  rm -f "${HOST_PORT_FILE}" 2>/dev/null || true
  docker rm -f "${CONTAINER_A}" "${CONTAINER_B}" &> /dev/null || true
  docker network rm "${NET_A}" "${NET_B}" &> /dev/null || true
  echo "[+] Cleanup complete."
}
trap cleanup EXIT

# 1. Start a temporary, explicitly configured test TCP/HTTP service on macOS host (ephemeral port)
echo "[*] Starting temporary host-side test TCP service on dynamic ephemeral port..."
node -e "
  const http = require('http');
  const fs = require('fs');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('HOST_TEST_SERVICE_PROBE_ACK\n');
  });
  server.listen(0, '0.0.0.0', () => {
    const port = server.address().port;
    fs.writeFileSync('${HOST_PORT_FILE}', String(port));
    console.log('[HOST_TEST_SERVICE] Active on host port ' + port);
  });
" &
HOST_SERVER_PID=$!
sleep 1

if [[ ! -s "${HOST_PORT_FILE}" ]]; then
  echo "[-] ERROR: Failed to obtain ephemeral port for host test service."
  exit 1
fi
HOST_TEST_PORT=$(cat "${HOST_PORT_FILE}")

# Verify host service is responding locally
HOST_SELF_CHECK=$(node -e "
  fetch('http://127.0.0.1:${HOST_TEST_PORT}')
    .then(r => r.text())
    .then(t => { if (t.includes('HOST_TEST_SERVICE_PROBE_ACK')) process.exit(0); else process.exit(1); })
    .catch(() => process.exit(1));
" && echo "OK" || echo "FAIL")

if [[ "${HOST_SELF_CHECK}" != "OK" ]]; then
  echo "[-] ERROR: Temporary host-side test service self-check failed on port ${HOST_TEST_PORT}."
  exit 1
fi
echo "[+] Temporary host-side test service verified on port ${HOST_TEST_PORT}."

# 2. Create two isolated internal networks
echo "[*] Creating internal network A: ${NET_A}..."
docker network create --internal "${NET_A}"

echo "[*] Creating internal network B: ${NET_B}..."
docker network create --internal "${NET_B}"

GATEWAY_A=$(docker network inspect "${NET_A}" -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}')
echo "[+] Network A Gateway IP: ${GATEWAY_A}"

# 3. Start Container B on Network B with an active TCP listener
echo "[*] Spawning Container B on Network B with active TCP server on port 8888..."
docker run -d \
  --name "${CONTAINER_B}" \
  --network "${NET_B}" \
  "${IMAGE_NAME}" \
  node -e "
    const net = require('net');
    const server = net.createServer(socket => {
      socket.write('SESSION_B_TCP_ACK\n');
      socket.end();
    });
    server.listen(8888, '0.0.0.0', () => {
      console.log('Session B TCP server ready on port 8888');
    });
  "

sleep 2

# 4. Verify network separation between containers
echo "[*] Verifying container network attachments (ensuring no shared networks)..."
CONTAINER_A_NETWORKS=$(docker network inspect "${NET_A}" -f '{{range $id, $cont := .Containers}}{{$cont.Name}} {{end}}')
CONTAINER_B_NETWORKS=$(docker network inspect "${NET_B}" -f '{{range $id, $cont := .Containers}}{{$cont.Name}} {{end}}')
echo "[+] Network A attached containers: ${CONTAINER_A_NETWORKS}"
echo "[+] Network B attached containers: ${CONTAINER_B_NETWORKS}"

IP_B=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "${CONTAINER_B}")
echo "[+] Container B IP on Network B: ${IP_B}"

# 5. Execute network isolation probes from Container A
echo "[*] Launching Container A on Network A to execute comprehensive isolation probes..."
docker run --rm \
  --name "${CONTAINER_A}" \
  --network "${NET_A}" \
  "${IMAGE_NAME}" \
  node -e "
    const net = require('net');
    const dns = require('dns');

    async function probeTcp(host, port, timeoutMs = 2000) {
      return new Promise((resolve) => {
        const sock = net.createConnection({ host, port, timeout: timeoutMs });
        sock.on('connect', () => {
          sock.destroy();
          resolve({ status: 'CONNECTED', code: null, message: 'Connection established' });
        });
        sock.on('error', (err) => {
          resolve({ status: 'ERROR', code: err.code, message: err.message });
        });
        sock.on('timeout', () => {
          sock.destroy();
          resolve({ status: 'TIMEOUT', code: 'ETIMEDOUT', message: 'Connection timed out' });
        });
      });
    }

    async function probeDns(hostname) {
      return new Promise((resolve) => {
        dns.lookup(hostname, (err, address) => {
          if (err) {
            resolve({ status: 'FAILED', code: err.code, message: err.message });
          } else {
            resolve({ status: 'RESOLVED', address });
          }
        });
      });
    }

    async function run() {
      let failedTests = 0;

      console.log('--- 3a. External TCP Egress Probes (Direct IP Connections) ---');
      const ext8888 = await probeTcp('8.8.8.8', 53, 2000);
      console.log('Probe 8.8.8.8:53 result: ' + ext8888.status + ' (' + (ext8888.code || '') + ') ' + (ext8888.message || ''));
      if (ext8888.status === 'CONNECTED') {
        console.error('[-] SECURITY FAILURE: Outbound TCP to 8.8.8.8:53 succeeded!');
        failedTests++;
      } else {
        console.log('[+] Verified: Outbound TCP to 8.8.8.8:53 is BLOCKED (' + ext8888.code + ').');
      }

      const ext1111 = await probeTcp('1.1.1.1', 80, 2000);
      console.log('Probe 1.1.1.1:80 result: ' + ext1111.status + ' (' + (ext1111.code || '') + ') ' + (ext1111.message || ''));
      if (ext1111.status === 'CONNECTED') {
        console.error('[-] SECURITY FAILURE: Outbound TCP to 1.1.1.1:80 succeeded!');
        failedTests++;
      } else {
        console.log('[+] Verified: Outbound TCP to 1.1.1.1:80 is BLOCKED (' + ext1111.code + ').');
      }

      console.log('--- 3b. External DNS Resolution Probe ---');
      const dnsResult = await probeDns('github.com');
      console.log('DNS lookup github.com result: ' + dnsResult.status + ' (' + (dnsResult.code || dnsResult.address) + ')');
      if (dnsResult.status === 'RESOLVED') {
        console.error('[-] SECURITY FAILURE: External DNS resolution for github.com succeeded! Address: ' + dnsResult.address);
        console.error('[-] Internal network allows external domain resolution leak.');
        failedTests++;
      } else {
        console.log('[+] Verified: External DNS resolution failed (' + dnsResult.code + '). No external domain leaks.');
      }

      console.log('--- 3c. Host-Side Service Reachability Probes (Target Port: ${HOST_TEST_PORT}) ---');
      // Probe 1: host.docker.internal
      const hostDnsResult = await probeDns('host.docker.internal');
      console.log('host.docker.internal DNS status: ' + hostDnsResult.status + ' (' + (hostDnsResult.code || hostDnsResult.address) + ')');

      // Probe 2: Bridge Gateway
      const gatewayProbe = await probeTcp('${GATEWAY_A}', ${HOST_TEST_PORT}, 2000);
      console.log('Bridge gateway (${GATEWAY_A}:${HOST_TEST_PORT}) probe: ' + gatewayProbe.status + ' (' + gatewayProbe.code + ') - ' + gatewayProbe.message);
      if (gatewayProbe.status === 'CONNECTED') {
        console.error('[-] SECURITY WARNING/FAILURE: Host service directly reachable via bridge gateway!');
        failedTests++;
      } else {
        console.log('[+] Verified: Bridge gateway did NOT proxy to host test service. Result: ' + gatewayProbe.code + ' (' +
          (gatewayProbe.code === 'ECONNREFUSED' ? 'TCP RST received: port not listening on bridge interface' :
           gatewayProbe.code === 'ENETUNREACH' ? 'Network unreachable' : 'Connection timed out') + ').');
      }

      // Probe 3: Docker Desktop host VM IP (192.168.65.254)
      const hostVmProbe = await probeTcp('192.168.65.254', ${HOST_TEST_PORT}, 2000);
      console.log('Docker Desktop VM Host IP (192.168.65.254:${HOST_TEST_PORT}) probe: ' + hostVmProbe.status + ' (' + hostVmProbe.code + ')');
      if (hostVmProbe.status === 'CONNECTED') {
        console.error('[-] SECURITY FAILURE: Host service reachable via 192.168.65.254!');
        failedTests++;
      } else {
        console.log('[+] Verified: Docker Desktop VM host IP unreachable (' + hostVmProbe.code + ').');
      }

      console.log('--- 3d. Cross-Session Isolation Probe (Target: Container B at ${IP_B}:8888) ---');
      const crossSessionProbe = await probeTcp('${IP_B}', 8888, 2000);
      console.log('Cross-session probe to Container B (${IP_B}:8888): ' + crossSessionProbe.status + ' (' + crossSessionProbe.code + ')');
      if (crossSessionProbe.status === 'CONNECTED') {
        console.error('[-] CRITICAL SECURITY FAILURE: Able to establish TCP connection to Container B across internal networks!');
        failedTests++;
      } else {
        console.log('[+] Verified: Cross-network TCP connection to Container B is BLOCKED (' + crossSessionProbe.code + ').');
      }

      if (failedTests > 0) {
        console.error('[-] TEST 3 COMPLETED WITH ' + failedTests + ' SECURITY/ISOLATION FAILURES.');
        process.exit(1);
      } else {
        console.log('[+] ALL TEST 3 NETWORK ISOLATION ASSERTIONS VERIFIED.');
        process.exit(0);
      }
    }

    run();
  "

echo "[+] TEST 3 PASSED: Network isolation, egress blocking, and cross-session isolation empirically verified."

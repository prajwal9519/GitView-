#!/usr/bin/env bash
# ==============================================================================
# GitView Phase 5 — Milestone 1 Acceptance Test 5: Combined Preview Architecture
# ==============================================================================
# Verifies the proposed architecture combining:
# 1. Dedicated internal Docker network (`docker network create --internal`).
# 2. HTTP test server container attached to that internal network.
# 3. Dynamic host-loopback port publishing (`-p 127.0.0.1::3000`).
# 4. Port discovery via `docker port`.
# 5. Native macOS Node.js reachability.
# 6. Outbound external TCP egress blocking.
# 7. Absence of any additional unrestricted network attachments.
# 8. Idempotent resource cleanup.
# ==============================================================================

set -euo pipefail

NET_NAME="gitview-comb-net-${RANDOM}"
VOL_NAME="gitview-comb-vol-${RANDOM}"
CONTAINER_NAME="gitview-comb-cont-${RANDOM}"
IMAGE_NAME="node:22-bookworm-slim"

echo "======================================================================"
echo "TEST 5: Combined Preview Architecture (Internal Net + Dynamic Host Port)"
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
  echo "[*] Cleaning up Test 5 resources..."
  docker rm -f "${CONTAINER_NAME}" &> /dev/null || true
  docker volume rm -f "${VOL_NAME}" &> /dev/null || true
  docker network rm "${NET_NAME}" &> /dev/null || true
  echo "[+] Cleanup complete."
}
trap cleanup EXIT

# 1. Create dedicated internal Docker network
echo "[*] 1. Creating dedicated internal network '${NET_NAME}'..."
docker network create --internal "${NET_NAME}"

# 2. Create test named volume
echo "[*] 2. Creating test named volume '${VOL_NAME}'..."
docker volume create "${VOL_NAME}"

# 3. Start HTTP server container attached to internal network with -p 127.0.0.1::3000
echo "[*] 3. Starting container '${CONTAINER_NAME}' on internal network with '-p 127.0.0.1::3000'..."
docker run -d \
  --name "${CONTAINER_NAME}" \
  --network "${NET_NAME}" \
  -v "${VOL_NAME}:/workspace" \
  -p 127.0.0.1::3000 \
  "${IMAGE_NAME}" \
  node -e "
    const http = require('http');
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', architecture: 'COMBINED_PREVIEW_SUCCESS' }));
    });
    server.listen(3000, '0.0.0.0', () => {
      console.log('HTTP preview server listening on 0.0.0.0:3000');
    });
  "

sleep 2

# 4. Retrieve dynamic host port using `docker port`
echo "[*] 4. Retrieving dynamic host port via 'docker port ${CONTAINER_NAME} 3000'..."
RAW_PORT=$(docker port "${CONTAINER_NAME}" 3000 2>&1 || true)
echo "    - Raw 'docker port' output: '${RAW_PORT}'"

HOST_CONFIG_PORTS=$(docker inspect -f '{{json .HostConfig.PortBindings}}' "${CONTAINER_NAME}")
NETWORK_PORTS=$(docker inspect -f '{{json .NetworkSettings.Ports}}' "${CONTAINER_NAME}")
echo "    - HostConfig.PortBindings: ${HOST_CONFIG_PORTS}"
echo "    - NetworkSettings.Ports:   ${NETWORK_PORTS}"

HOST_PORT=""
if [[ "${RAW_PORT}" =~ :([0-9]+)$ ]]; then
  HOST_PORT="${BASH_REMATCH[1]}"
  echo "[+] Discovered published host port: ${HOST_PORT}"
else
  echo "[-] 'docker port' yielded no valid port mapping: '${RAW_PORT}'"
fi

# 5. Verify native macOS Node.js reachability
echo "[*] 5. Verifying native macOS Node.js reachability..."
HOST_REACHABLE="false"
if [[ -n "${HOST_PORT}" ]]; then
  set +e
  HOST_CHECK=$(node -e "
    fetch('http://127.0.0.1:${HOST_PORT}')
      .then(r => r.json())
      .then(d => {
        if (d.architecture === 'COMBINED_PREVIEW_SUCCESS') {
          console.log('SUCCESS: Host Node.js reached container on port ${HOST_PORT}');
          process.exit(0);
        } else {
          process.exit(1);
        }
      })
      .catch(e => {
        console.error('FETCH_ERROR:', e.message);
        process.exit(1);
      });
  " 2>&1)
  HOST_CHECK_STATUS=$?
  set -e
  if [ "${HOST_CHECK_STATUS}" -eq 0 ]; then
    HOST_REACHABLE="true"
    echo "[+] Verified: Host reached container via dynamic port ${HOST_PORT}."
  else
    echo "[-] FAILED: Host could not connect to container: ${HOST_CHECK}"
  fi
else
  echo "[-] FAILED: Cannot test host HTTP reachability because Docker failed to assign/publish a host port."
  echo "    Root cause: In Docker / Moby daemon, an '--internal' network completely"
  echo "    suppresses host port publishing (docker-proxy is not initialized)."
fi

# 6. Verify external TCP egress remains blocked from inside the container
echo "[*] 6. Verifying external TCP egress is blocked from inside container..."
EGRESS_BLOCKED=$(docker exec "${CONTAINER_NAME}" node -e "
  const net = require('net');
  const s = net.createConnection({ host: '8.8.8.8', port: 53, timeout: 2000 });
  s.on('connect', () => { console.log('CONNECTED'); s.destroy(); process.exit(1); });
  s.on('error', (e) => { console.log('BLOCKED_' + e.code); process.exit(0); });
  s.on('timeout', () => { console.log('BLOCKED_TIMEOUT'); s.destroy(); process.exit(0); });
")
echo "[+] Container outbound egress check result: ${EGRESS_BLOCKED}"

# 7. Verify the container has no additional unrestricted network attachment
echo "[*] 7. Verifying container network attachments (ensuring no unrestricted networks)..."
ATTACHED_NETWORKS=$(docker inspect -f '{{json .NetworkSettings.Networks}}' "${CONTAINER_NAME}")
echo "    - Attached networks: ${ATTACHED_NETWORKS}"

NETWORK_COUNT=$(docker inspect -f '{{len .NetworkSettings.Networks}}' "${CONTAINER_NAME}")
PRIMARY_NET=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}' "${CONTAINER_NAME}")

if [ "${NETWORK_COUNT}" -eq 1 ] && [ "${PRIMARY_NET}" = "${NET_NAME}" ]; then
  echo "[+] Verified: Container is attached ONLY to internal network '${NET_NAME}' with 0 additional networks."
else
  echo "[-] FAILED: Container has unexpected network attachments (Count: ${NETWORK_COUNT}, Networks: ${ATTACHED_NETWORKS})"
  exit 1
fi

echo "======================================================================"
echo "TEST 5 EMPIRICAL VERIFICATION SUMMARY"
echo "======================================================================"
echo "  1. Dedicated internal network created:         YES (${NET_NAME})"
echo "  2. Container started on internal network:      YES (${CONTAINER_NAME})"
echo "  3. Port publishing requested (-p 127.0.0.1::3000): YES"
echo "  4. Dynamic host port published by Docker:      $(if [[ -n "${HOST_PORT}" ]]; then echo "YES (${HOST_PORT})"; else echo "NO (Disabled by Docker Moby daemon)"; fi)"
echo "  5. Host Node.js reachability verified:         ${HOST_REACHABLE}"
echo "  6. External TCP egress blocked:                $(if [[ "${EGRESS_BLOCKED}" =~ BLOCKED ]]; then echo "YES (${EGRESS_BLOCKED})"; else echo "NO"; fi)"
echo "  7. Single network attachment verified:         YES (Attached only to ${NET_NAME})"
echo "======================================================================"

if [ "${HOST_REACHABLE}" = "true" ]; then
  echo "[+] TEST 5 PASSED: Combined architecture verified."
  exit 0
else
  echo "[-] TEST 5 FAILED / ARCHITECTURAL INCOMPATIBILITY CONFIRMED:"
  echo "    In Docker Engine / Moby, an '--internal' bridge network fundamentally"
  echo "    prohibits host port publishing ('-p'). Docker's port-forwarding proxy"
  echo "    (docker-proxy) is NOT initialized for internal networks."
  echo "    Therefore, combining '--internal' with '-p 127.0.0.1::3000' is physically"
  echo "    unsupported by Docker without an architectural adjustment."
  exit 1
fi

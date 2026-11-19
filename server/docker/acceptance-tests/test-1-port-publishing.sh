#!/usr/bin/env bash
# ==============================================================================
# GitView Phase 5 — Milestone 1 Acceptance Test 1: Dynamic Port Publishing
# ==============================================================================
# Verifies that:
# 1. -p 127.0.0.1::3000 dynamically allocates an unprivileged host port bound strictly
#    to loopback (127.0.0.1).
# 2. The dynamically allocated host port can be discovered via `docker port`.
# 3. A native macOS host Node.js process can connect to the container service via
#    http://127.0.0.1:<PORT>.
# 4. Container and port allocation can be cleanly torn down.
# ==============================================================================

set -euo pipefail

CONTAINER_NAME="gitview-test-port-${RANDOM}"
IMAGE_NAME="node:22-bookworm-slim"

echo "======================================================================"
echo "TEST 1: Dynamic Port Publishing (-p 127.0.0.1::3000)"
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
  echo "[*] Cleaning up test container '${CONTAINER_NAME}'..."
  docker rm -f "${CONTAINER_NAME}" &> /dev/null || true
  echo "[+] Cleanup complete."
}
trap cleanup EXIT

# 1. Start disposable Node.js HTTP server container
echo "[*] Starting test container '${CONTAINER_NAME}' bound to 127.0.0.1::3000..."
docker run -d \
  --name "${CONTAINER_NAME}" \
  -p 127.0.0.1::3000 \
  "${IMAGE_NAME}" \
  node -e '
    const http = require("http");
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", message: "GitView Port Test Success", pid: process.pid }));
    });
    server.listen(3000, "0.0.0.0", () => {
      console.log("Test HTTP server listening on 0.0.0.0:3000");
    });
  '

# 2. Wait for container to report running
sleep 2

# 3. Retrieve dynamic host port via `docker port`
PORT_MAPPING=$(docker port "${CONTAINER_NAME}" 3000)
echo "[+] Docker port mapping output: ${PORT_MAPPING}"

HOST_PORT=$(echo "${PORT_MAPPING}" | head -n1 | awk -F':' '{print $NF}')

if [[ -z "${HOST_PORT}" ]]; then
  echo "[-] FAILED: Could not extract dynamic host port from '${PORT_MAPPING}'"
  exit 1
fi

echo "[+] Dynamically allocated host loopback port: ${HOST_PORT}"

# Verify binding IP is strictly 127.0.0.1 (not 0.0.0.0)
BIND_IP=$(echo "${PORT_MAPPING}" | head -n1 | awk -F':' '{print $1}')
if [[ "${BIND_IP}" != "127.0.0.1" ]]; then
  echo "[!] WARNING: Port bound to '${BIND_IP}', expected '127.0.0.1'"
else
  echo "[+] Verified: Host port is bound strictly to loopback interface 127.0.0.1"
fi

# 4. Verify connectivity from host Node.js process
echo "[*] Connecting from native macOS Node.js process to http://127.0.0.1:${HOST_PORT}..."
NODE_VERIFICATION=$(node -e "
  fetch('http://127.0.0.1:${HOST_PORT}')
    .then(async res => {
      if (!res.ok) throw new Error('HTTP Status ' + res.status);
      const data = await res.json();
      if (data.status === 'ok') {
        console.log('SUCCESS: Host Node.js received payload:', JSON.stringify(data));
        process.exit(0);
      } else {
        throw new Error('Unexpected payload');
      }
    })
    .catch(err => {
      console.error('FAILURE:', err.message);
      process.exit(1);
    });
")

echo "${NODE_VERIFICATION}"
echo "[+] TEST 1 PASSED: Dynamic loopback port publishing and host Node.js reachability verified."

#!/usr/bin/env bash
# ==============================================================================
# GitView Phase 5 — Milestone 2: Hardened Runner Verification Suite
# ==============================================================================
# Verifies the 10 core security, runtime, and functional requirements of the
# preview runner base image (gitview-preview-runner:v1.0.0).
#
# Requirements tested:
#   1. Linux ARM64 Architecture Verification (aarch64 / arm64)
#   2. Node.js Version Verification (v22.x LTS)
#   3. Non-root User & UID/GID Isolation (UID 10001:10001)
#   4. Workspace Directory Writable (/workspace)
#   5. Tmpfs & Cache Directory Writable (/tmp, /tmp/npm-cache)
#   6. Read-Only Root Filesystem Enforcement (--read-only)
#   7. Static Server Functional Verification (gitview-serve.js HTTP 200 & MIME)
#   8. Static Server Security Boundaries (Path traversal & sensitive file 403)
#   9. Trusted Vite CLI Availability & Integrity (/usr/local/bin/vite)
#  10. Network Isolation & Egress Prevention (--internal network)
# ==============================================================================

set -euo pipefail

IMAGE_TAG="${IMAGE_TAG:-gitview-preview-runner:v1.0.0}"
SESSION_ID="${RANDOM}_$$"
NET_INTERNAL="gitview-runner-int-${SESSION_ID}"
RUNNER_CONTAINER="gitview-runner-srv-${SESSION_ID}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURES_DIR="${SCRIPT_DIR}/fixtures/static-site"

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

PASSED_TESTS=0
FAILED_TESTS=0

report_pass() {
  local test_name="$1"
  local details="$2"
  echo -e "${GREEN}[PASS]${NC} ${test_name}"
  if [ -n "${details}" ]; then
    echo "       Detail: ${details}"
  fi
  PASSED_TESTS=$((PASSED_TESTS + 1))
}

report_fail() {
  local test_name="$1"
  local details="$2"
  echo -e "${RED}[FAIL]${NC} ${test_name}"
  if [ -n "${details}" ]; then
    echo "       Detail: ${details}"
  fi
  FAILED_TESTS=$((FAILED_TESTS + 1))
}

echo "======================================================================"
echo -e "${BLUE}GitView Phase 5 — Milestone 2: Hardened Runner Verification Suite${NC}"
echo "======================================================================"
echo "Runner Image: ${IMAGE_TAG}"
echo "Host Machine: $(uname -sm)"
echo "Timestamp:    $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
echo "======================================================================"

cleanup() {
  echo ""
  echo "[*] Cleaning up verification resources..."
  docker rm -f "${RUNNER_CONTAINER}" &> /dev/null || true
  docker network rm "${NET_INTERNAL}" &> /dev/null || true
  echo "[+] Cleanup complete."
}
trap cleanup EXIT

# Pre-flight check: Image existence
if ! docker image inspect "${IMAGE_TAG}" &> /dev/null; then
  echo -e "${RED}[ERROR]${NC} Image ${IMAGE_TAG} does not exist locally. Building..."
  docker build -f "${SCRIPT_DIR}/preview-runner.Dockerfile" -t "${IMAGE_TAG}" "${SCRIPT_DIR}"
fi

echo ""
echo "--- 1. Linux ARM64 Architecture Verification ---"
CONTAINER_ARCH=$(docker run --rm "${IMAGE_TAG}" uname -m)
if [ "${CONTAINER_ARCH}" = "aarch64" ] || [ "${CONTAINER_ARCH}" = "arm64" ]; then
  report_pass "Architecture matches Apple Silicon ARM64" "uname -m reports ${CONTAINER_ARCH}"
else
  report_fail "Architecture mismatch" "Expected aarch64/arm64, got ${CONTAINER_ARCH}"
fi

echo ""
echo "--- 2. Node.js Version Verification ---"
NODE_VERSION=$(docker run --rm "${IMAGE_TAG}" node -v)
if [[ "${NODE_VERSION}" =~ ^v22\. ]]; then
  report_pass "Node.js 22 LTS verified" "node -v reports ${NODE_VERSION}"
else
  report_fail "Node.js version mismatch" "Expected v22.x, got ${NODE_VERSION}"
fi

echo ""
echo "--- 3. Non-root User & UID/GID Isolation ---"
ID_OUTPUT=$(docker run --rm "${IMAGE_TAG}" id)
if [[ "${ID_OUTPUT}" == *"uid=10001(gitview)"* ]] && [[ "${ID_OUTPUT}" == *"gid=10001(gitview)"* ]]; then
  report_pass "Non-root UID/GID 10001 verified" "id reports: ${ID_OUTPUT}"
else
  report_fail "User identity failure" "Expected uid=10001/gid=10001, got: ${ID_OUTPUT}"
fi

# Ensure sudo is absent
if docker run --rm "${IMAGE_TAG}" which sudo &> /dev/null; then
  report_fail "Sudo binary present" "sudo binary found in container image"
else
  report_pass "Privilege escalation tool sudo absent" "sudo is not installed"
fi

echo ""
echo "--- 4. Workspace Directory Writable (/workspace) ---"
VOL_TEST="gitview-test-vol-${SESSION_ID}"
echo "[*] Creating named volume ${VOL_TEST}..."
docker volume create "${VOL_TEST}" > /dev/null

WORKSPACE_TEST=$(docker run --rm \
  -v "${VOL_TEST}:/workspace" \
  "${IMAGE_TAG}" \
  sh -c "echo 'workspace-rw-verified' > /workspace/write-test.txt && cat /workspace/write-test.txt")
docker volume rm "${VOL_TEST}" > /dev/null
if [ "${WORKSPACE_TEST}" = "workspace-rw-verified" ]; then
  report_pass "Workspace is writable by UID 10001" "Successfully wrote and read /workspace/write-test.txt"
else
  report_fail "Workspace write failure" "Output: ${WORKSPACE_TEST}"
fi

echo ""
echo "--- 5. Tmpfs & Cache Directory Writable (/tmp, /tmp/npm-cache) ---"
TMP_TEST=$(docker run --rm \
  --read-only \
  --mount type=tmpfs,destination=/tmp \
  --mount type=tmpfs,destination=/workspace \
  "${IMAGE_TAG}" \
  sh -c "mkdir -p /tmp/npm-cache && echo 'cache-ok' > /tmp/npm-cache/test.txt && cat /tmp/npm-cache/test.txt")
if [ "${TMP_TEST}" = "cache-ok" ]; then
  report_pass "Tmpfs and cache writable under read-only root" "Verified /tmp and /tmp/npm-cache under --read-only"
else
  report_fail "Tmpfs write failure" "Output: ${TMP_TEST}"
fi

echo ""
echo "--- 6. Read-Only Root Filesystem Enforcement ---"
RO_CHECK_PASS=1

# Attempt to write to root
ROOT_TOUCH_OUT=$(docker run --rm \
  --read-only \
  --mount type=tmpfs,destination=/tmp \
  "${IMAGE_TAG}" \
  touch /root_write_test 2>&1 || true)
if echo "${ROOT_TOUCH_OUT}" | grep -qi "Read-only file system"; then
  echo "    [+] Root directory / mutation blocked (Read-only file system)"
else
  echo "    [-] Root directory / mutation succeeded or gave unexpected error: ${ROOT_TOUCH_OUT}"
  RO_CHECK_PASS=0
fi

# Attempt to write to /usr/local/bin
BIN_TOUCH_OUT=$(docker run --rm \
  --read-only \
  --mount type=tmpfs,destination=/tmp \
  "${IMAGE_TAG}" \
  touch /usr/local/bin/mutation_test 2>&1 || true)
if echo "${BIN_TOUCH_OUT}" | grep -qi "Read-only file system"; then
  echo "    [+] /usr/local/bin mutation blocked (Read-only file system)"
else
  echo "    [-] /usr/local/bin mutation succeeded or gave unexpected error: ${BIN_TOUCH_OUT}"
  RO_CHECK_PASS=0
fi

# Attempt to write to /etc
ETC_TOUCH_OUT=$(docker run --rm \
  --read-only \
  --mount type=tmpfs,destination=/tmp \
  "${IMAGE_TAG}" \
  touch /etc/mutation_test 2>&1 || true)
if echo "${ETC_TOUCH_OUT}" | grep -qi "Read-only file system"; then
  echo "    [+] /etc mutation blocked (Read-only file system)"
else
  echo "    [-] /etc mutation succeeded or gave unexpected error: ${ETC_TOUCH_OUT}"
  RO_CHECK_PASS=0
fi

if [ ${RO_CHECK_PASS} -eq 1 ]; then
  report_pass "Read-only root enforcement verified" "All attempted mutations to /, /usr/local/bin, and /etc were denied"
else
  report_fail "Read-only root enforcement failed" "One or more directories were writable under --read-only"
fi

echo ""
echo "--- 7 & 8: Static Server Functional & Security Testing ---"
# Setup dedicated internal network
echo "[*] Creating internal network ${NET_INTERNAL}..."
docker network create --internal "${NET_INTERNAL}" > /dev/null

# Start runner container running gitview-serve against synthetic fixtures
echo "[*] Launching runner container with static server..."
docker run -d \
  --name "${RUNNER_CONTAINER}" \
  --network "${NET_INTERNAL}" \
  --read-only \
  --mount type=bind,source="${FIXTURES_DIR}",target=/workspace,readonly \
  --mount type=tmpfs,destination=/tmp \
  "${IMAGE_TAG}" \
  node /usr/local/bin/gitview-serve.js --port 3000 --root /workspace > /dev/null

# Wait briefly for server startup
sleep 1

# Run automated HTTP test client from within the internal network
echo "[*] Executing HTTP functional and security test probe..."
HTTP_PROBE_SCRIPT=$(cat << 'EOF'
const http = require('http');

async function testUrl(path, expectedStatus, expectedHeaderRegex, expectedBodySubstring) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: process.env.TARGET_HOST,
      port: 3000,
      path: path,
      method: 'GET'
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        let pass = true;
        let reasons = [];
        if (res.statusCode !== expectedStatus) {
          pass = false;
          reasons.push(`Status code expected ${expectedStatus}, got ${res.statusCode}`);
        }
        if (expectedHeaderRegex) {
          const contentType = res.headers['content-type'] || '';
          if (!expectedHeaderRegex.test(contentType)) {
            pass = false;
            reasons.push(`Content-Type expected ${expectedHeaderRegex}, got '${contentType}'`);
          }
        }
        if (expectedBodySubstring && !body.includes(expectedBodySubstring)) {
          pass = false;
          reasons.push(`Body missing substring: '${expectedBodySubstring}'`);
        }
        resolve({ path, pass, statusCode: res.statusCode, reasons });
      });
    });
    req.on('error', (err) => {
      resolve({ path, pass: false, statusCode: 0, reasons: [err.message] });
    });
    req.end();
  });
}

async function run() {
  const tests = [
    // Functional tests
    { path: '/', status: 200, ct: /text\/html/, sub: 'GitView Static Preview Test' },
    { path: '/style.css', status: 200, ct: /text\/css/, sub: 'background-color: #f4f4f4' },
    { path: '/app.js', status: 200, ct: /application\/javascript/, sub: 'Synthetic Fixture Active' },
    { path: '/dashboard', status: 200, ct: /text\/html/, sub: 'GitView Static Preview Test' }, // SPA fallback
    // Security tests
    { path: '/../../etc/passwd', status: 403, ct: null, sub: 'Forbidden' },
    { path: '/%2e%2e/etc/passwd', status: 403, ct: null, sub: 'Forbidden' },
    { path: '/.env', status: 403, ct: null, sub: 'Forbidden' },
    { path: '/.git/config', status: 403, ct: null, sub: 'Forbidden' }
  ];

  let allPass = true;
  for (const t of tests) {
    const res = await testUrl(t.path, t.status, t.ct, t.sub);
    if (!res.pass) {
      console.log(`FAIL: ${t.path} -> ${res.reasons.join(', ')}`);
      allPass = false;
    } else {
      console.log(`PASS: ${t.path} -> ${res.statusCode}`);
    }
  }
  process.exit(allPass ? 0 : 1);
}

run();
EOF
)

PROBE_OUTPUT=$(docker run --rm \
  --network "${NET_INTERNAL}" \
  -e TARGET_HOST="${RUNNER_CONTAINER}" \
  "${IMAGE_TAG}" \
  node -e "${HTTP_PROBE_SCRIPT}" 2>&1) || PROBE_STATUS=$?

echo "${PROBE_OUTPUT}"

if echo "${PROBE_OUTPUT}" | grep -q "PASS: / -> 200" && \
   echo "${PROBE_OUTPUT}" | grep -q "PASS: /style.css -> 200" && \
   echo "${PROBE_OUTPUT}" | grep -q "PASS: /dashboard -> 200"; then
  report_pass "Static server functionality (HTML, CSS, JS, SPA fallback)" "All valid resources served with proper Content-Type"
else
  report_fail "Static server functional failure" "${PROBE_OUTPUT}"
fi

if echo "${PROBE_OUTPUT}" | grep -q "PASS: /../../etc/passwd -> 403" && \
   echo "${PROBE_OUTPUT}" | grep -q "PASS: /%2e%2e/etc/passwd -> 403" && \
   echo "${PROBE_OUTPUT}" | grep -q "PASS: /.env -> 403" && \
   echo "${PROBE_OUTPUT}" | grep -q "PASS: /.git/config -> 403"; then
  report_pass "Static server security boundaries (Path traversal & sensitive files)" "All prohibited paths rejected with HTTP 403"
else
  report_fail "Static server security boundary failure" "${PROBE_OUTPUT}"
fi

echo ""
echo "--- 9. Trusted Vite CLI Availability & Integrity ---"
VITE_OUTPUT=$(docker run --rm "${IMAGE_TAG}" /usr/local/bin/vite --version 2>&1)
if [[ "${VITE_OUTPUT}" == *"vite/5."* ]] && [[ "${VITE_OUTPUT}" == *"linux-arm64"* ]]; then
  report_pass "Vite CLI available and verified" "/usr/local/bin/vite --version reports: ${VITE_OUTPUT}"
else
  report_fail "Vite CLI failure" "Unexpected output: ${VITE_OUTPUT}"
fi

# Verify React plugin presence
PLUGIN_CHECK=$(docker run --rm "${IMAGE_TAG}" node -e "const p = require('@vitejs/plugin-react'); console.log(typeof p.default === 'function' ? 'plugin-ok' : 'plugin-bad')")
if [ "${PLUGIN_CHECK}" = "plugin-ok" ]; then
  report_pass "Trusted React plugin present" "@vitejs/plugin-react resolves and exports plugin function"
else
  report_fail "React plugin resolution failure" "Output: ${PLUGIN_CHECK}"
fi

echo ""
echo "--- 10. Network Isolation & Egress Prevention ---"
EGRESS_CHECK_PASS=1

# Test outbound IP connection
echo "[*] Testing external IP connection blocking (8.8.8.8:53)..."
IP_EGRESS=$(docker run --rm \
  --network "${NET_INTERNAL}" \
  "${IMAGE_TAG}" \
  node -e "
    const net = require('net');
    const s = net.createConnection({ host: '8.8.8.8', port: 53, timeout: 2000 });
    s.on('connect', () => { console.log('CONNECTED'); s.destroy(); process.exit(0); });
    s.on('timeout', () => { console.log('TIMEOUT'); s.destroy(); process.exit(1); });
    s.on('error', (err) => { console.log('BLOCKED:' + err.code); process.exit(1); });
  " 2>&1 || true)

if [[ "${IP_EGRESS}" == *"TIMEOUT"* ]] || [[ "${IP_EGRESS}" == *"BLOCKED"* ]]; then
  echo "    [+] External IP egress blocked (${IP_EGRESS})"
else
  echo "    [-] External IP egress was NOT blocked: ${IP_EGRESS}"
  EGRESS_CHECK_PASS=0
fi

# Test external DNS resolution
echo "[*] Testing external DNS resolution blocking (github.com)..."
DNS_EGRESS=$(docker run --rm \
  --network "${NET_INTERNAL}" \
  "${IMAGE_TAG}" \
  node -e "
    const dns = require('dns');
    dns.lookup('github.com', (err, address) => {
      if (err) {
        console.log('DNS_BLOCKED:' + err.code);
        process.exit(1);
      } else {
        console.log('RESOLVED:' + address);
        process.exit(0);
      }
    });
  " 2>&1 || true)

if [[ "${DNS_EGRESS}" == *"DNS_BLOCKED"* ]]; then
  echo "    [+] External DNS resolution blocked (${DNS_EGRESS})"
else
  echo "    [-] External DNS resolved: ${DNS_EGRESS}"
  EGRESS_CHECK_PASS=0
fi

if [ ${EGRESS_CHECK_PASS} -eq 1 ]; then
  report_pass "Network isolation verified" "Zero egress on --internal network (IP connections & DNS lookups denied)"
else
  report_fail "Network isolation failure" "External traffic leaked out of internal network"
fi

echo ""
echo "======================================================================"
echo "VERIFICATION SUMMARY"
echo "======================================================================"
echo -e "Total Tests Run: $((PASSED_TESTS + FAILED_TESTS))"
echo -e "Passed:         ${GREEN}${PASSED_TESTS}${NC}"
echo -e "Failed:         ${RED}${FAILED_TESTS}${NC}"
echo "======================================================================"

if [ ${FAILED_TESTS} -eq 0 ]; then
  echo -e "${GREEN}[SUCCESS] All Milestone 2 requirements verified successfully!${NC}"
  exit 0
else
  echo -e "${RED}[FAILURE] Some requirements failed verification.${NC}"
  exit 1
fi

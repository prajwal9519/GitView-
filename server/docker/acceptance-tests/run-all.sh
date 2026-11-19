#!/usr/bin/env bash
# ==============================================================================
# GitView Phase 5 — Milestone 1: Master Acceptance Test Runner (Hardened)
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "======================================================================"
echo " GitView Phase 5 — Milestone 1: Docker & Networking Feasibility Suite"
echo "======================================================================"
echo "Host Machine Details:"
echo "  OS:           $(sw_vers -productName) $(sw_vers -productVersion) ($(uname -m))"
echo "  Kernel:       $(uname -s) $(uname -r)"
echo "  CPU:          $(sysctl -n machdep.cpu.brand_string 2>/dev/null || uname -m)"
echo "  Node.js Host: $(node -v 2>/dev/null || echo 'Not found')"
echo "----------------------------------------------------------------------"

# 1. Check Docker CLI
if ! command -v docker &> /dev/null; then
  echo "[-] PREREQUISITE CHECK FAILED: Docker CLI is NOT installed."
  echo ""
  echo "Please install Docker and re-run this script: ./server/docker/acceptance-tests/run-all.sh"
  exit 1
fi

# 2. Check Docker Daemon
if ! docker info &> /dev/null; then
  echo "[-] PREREQUISITE CHECK FAILED: Docker CLI is found, but Docker Daemon is NOT running."
  echo "    Please start Docker Desktop, OrbStack, or Colima and retry."
  exit 1
fi

echo "[+] Docker CLI:    $(docker --version)"
DOCKER_ENGINE_ARCH=$(docker info --format '{{.Architecture}}' 2>/dev/null || echo "Unknown")
echo "[+] Docker Engine: $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo 'Unknown') (Arch: ${DOCKER_ENGINE_ARCH})"
echo "======================================================================"

global_cleanup() {
  echo ""
  echo "[*] Running final sweep cleanup of all gitview test artifacts..."
  docker rm -f $(docker ps -a --format '{{.Names}}' | grep '^gitview-test-' | grep -v 'gitview-test-redis') 2>/dev/null || true
  docker rm -f $(docker ps -aq --filter "name=gitview-c-") 2>/dev/null || true
  docker rm -f $(docker ps -aq --filter "name=gitview-comb-") 2>/dev/null || true
  docker rm -f $(docker ps -aq --filter "name=gitview-builder-") 2>/dev/null || true
  docker rm -f $(docker ps -aq --filter "name=gitview-build-proxy-") 2>/dev/null || true
  docker volume rm -f $(docker volume ls -q --filter "name=gitview-test-vol") 2>/dev/null || true
  docker volume rm -f $(docker volume ls -q --filter "name=gitview-comb-vol") 2>/dev/null || true
  docker volume rm -f $(docker volume ls -q --filter "name=gitview-ws-") 2>/dev/null || true
  docker network rm $(docker network ls -q --filter "name=gitview-net-test") 2>/dev/null || true
  docker network rm $(docker network ls -q --filter "name=gitview-comb-net") 2>/dev/null || true
  docker network rm $(docker network ls -q --filter "name=gitview-build-") 2>/dev/null || true
  echo "[+] Final sweep cleanup complete."
}
trap global_cleanup EXIT

TESTS=(
  "test-1-port-publishing.sh:Test 1: Dynamic Port Publishing"
  "test-2-uid-permissions.sh:Test 2: UID & Volume Permissions"
  "test-3-internal-network.sh:Test 3: Internal Network Isolation"
  "test-4-resource-limits.sh:Test 4: Resource Limits & Task Accounting"
  "test-5-proxy-sidecar-architecture.sh:Test 5: Option A Proxy-Sidecar Architecture"
  "test-6-builder-egress-isolation.sh:Test 6: Dual-Network npm Egress Proxy & Builder Isolation"
)

PASSED=0
FAILED=0
RESULTS=()

for entry in "${TESTS[@]}"; do
  script_file="${entry%%:*}"
  test_label="${entry##*:}"
  script_path="${SCRIPT_DIR}/${script_file}"

  echo ""
  echo ">>> =================================================================="
  echo ">>> RUNNING: ${test_label}"
  echo ">>> =================================================================="

  set +e
  bash "${script_path}"
  exit_status=$?
  set -e

  if [ "${exit_status}" -eq 0 ]; then
    echo ">>> RESULT: ${test_label} -> PASSED (Exit code: 0)"
    PASSED=$((PASSED + 1))
    RESULTS+=("[PASS] ${test_label} (Exit: 0)")
  else
    echo ">>> RESULT: ${test_label} -> FAILED (Exit code: ${exit_status})"
    FAILED=$((FAILED + 1))
    RESULTS+=("[FAIL] ${test_label} (Exit: ${exit_status})")
  fi
done

echo ""
echo "======================================================================"
echo " ACCEPTANCE TEST SUITE SUMMARY MATRIX"
echo "======================================================================"
for r in "${RESULTS[@]}"; do
  echo "  ${r}"
done
echo "----------------------------------------------------------------------"
echo "  Total Executed: $((PASSED + FAILED))"
echo "  Passed:         ${PASSED}"
echo "  Failed:         ${FAILED}"
echo "======================================================================"

if [ "${FAILED}" -eq 0 ]; then
  echo "[+] ALL MANDATORY MILESTONE 1 ACCEPTANCE TESTS PASSED EMPIRICALLY!"
  exit 0
else
  echo "[-] ONE OR MORE ACCEPTANCE TESTS FAILED OR REVEALED ARCHITECTURAL LIMITATIONS."
  echo "    See detailed logs above and README for empirical findings."
  exit 1
fi

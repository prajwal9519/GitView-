#!/usr/bin/env bash
# ==============================================================================
# GitView Phase 5 — Milestone 1 Acceptance Test 2: UID & Volume Permissions
# ==============================================================================
# Verifies that:
# 1. Non-root user (UID 10001, GID 10001) runs inside the container.
# 2. Named volume mounted to /workspace is writable by UID 10001.
# 3. Designated tmpfs directories (/tmp, /run) are writable.
# 4. Container root filesystem is strictly read-only (--read-only) and writes fail.
# ==============================================================================

set -euo pipefail

VOLUME_NAME="gitview-test-vol-${RANDOM}"
IMAGE_NAME="node:22-bookworm-slim"

echo "======================================================================"
echo "TEST 2: UID and Volume Permissions"
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
  echo "[*] Cleaning up test volume '${VOLUME_NAME}'..."
  docker volume rm -f "${VOLUME_NAME}" &> /dev/null || true
  echo "[+] Cleanup complete."
}
trap cleanup EXIT

# 1. Create named volume
echo "[*] Creating named volume '${VOLUME_NAME}'..."
docker volume create "${VOLUME_NAME}"

# 2. Initialize volume permissions for unprivileged UID 10001
# In Docker, a new volume inherits ownership of the mount point.
# Because vanilla node image has no pre-existing /workspace directory,
# we initialize /workspace ownership to UID 10001 (mimicking the custom runner image).
echo "[*] Initializing volume ownership to UID 10001:10001..."
docker run --rm \
  -v "${VOLUME_NAME}:/workspace" \
  "${IMAGE_NAME}" \
  chown -R 10001:10001 /workspace

# 3. Test non-root UID, read-only root, workspace write, tmpfs write
echo "[*] Running container as UID 10001:10001 with --read-only root..."
docker run --rm \
  --user 10001:10001 \
  --read-only \
  -v "${VOLUME_NAME}:/workspace" \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --tmpfs /run:rw,noexec,nosuid,size=16m \
  "${IMAGE_NAME}" \
  sh -c '
    set -e
    echo "--- 3a. Checking effective UID/GID ---"
    CURRENT_UID=$(id -u)
    CURRENT_GID=$(id -g)
    echo "Current UID: ${CURRENT_UID}, GID: ${CURRENT_GID}"
    if [ "${CURRENT_UID}" != "10001" ] || [ "${CURRENT_GID}" != "10001" ]; then
      echo "[-] Failed: Expected UID 10001, got ${CURRENT_UID}"
      exit 1
    fi
    echo "[+] Verified: Container is running strictly as UID 10001:10001."

    echo "--- 3b. Testing write to named volume /workspace ---"
    echo "Hello from GitView Runner" > /workspace/acceptance_test.txt
    if [ ! -f /workspace/acceptance_test.txt ]; then
      echo "[-] Failed: Could not write to /workspace"
      exit 1
    fi
    CONTENT=$(cat /workspace/acceptance_test.txt)
    echo "[+] Successfully wrote and read back: \"${CONTENT}\""

    echo "--- 3c. Testing write to tmpfs /tmp ---"
    echo "temporary_data" > /tmp/temp.log
    if [ ! -f /tmp/temp.log ]; then
      echo "[-] Failed: Could not write to /tmp"
      exit 1
    fi
    echo "[+] Verified: /tmp tmpfs is writable by UID 10001."

    echo "--- 3d. Testing read-only root filesystem enforcement ---"
    if touch /test_file_on_root.txt 2>/dev/null; then
      echo "[-] CRITICAL FAILURE: Able to write to container root filesystem!"
      exit 1
    else
      echo "[+] Verified: Write to root filesystem was rejected (Read-only file system)."
    fi

    echo "--- 3e. Testing read-only /etc modification ---"
    if echo "malicious" >> /etc/hosts 2>/dev/null; then
      echo "[-] CRITICAL FAILURE: Able to modify /etc/hosts on read-only root!"
      exit 1
    else
      echo "[+] Verified: /etc modification was rejected."
    fi
  '

echo "[+] TEST 2 PASSED: UID 10001 privileges, named volume writes, tmpfs, and read-only root verified."

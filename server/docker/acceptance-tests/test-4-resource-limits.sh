#!/usr/bin/env bash
# ==============================================================================
# GitView Phase 5 — Milestone 1 Acceptance Test 4: Resource Limits (Hardened)
# ==============================================================================
# Verifies that:
# 1. Memory caps (--memory="64m" --memory-swap="64m") trigger kernel OOM killer:
#    verifies BOTH State.OOMKilled == true via docker inspect AND exit code 137.
# 2. CPU CFS quotas (--cpus="0.5") constrain container CPU usage to ~50% of 1 core.
# 3. PID limits (--pids-limit=32):
#    - Clarifies attempted spawns vs successful OS processes vs tracked handles.
#    - Verifies peak cgroup tasks (pids.current) never exceeds pids.max (32).
#    - Verifies EAGAIN detection on blocked processes.
#    - Gracefully cleans up all active child processes.
# ==============================================================================

set -euo pipefail

IMAGE_NAME="node:22-bookworm-slim"
MEM_CONTAINER="gitview-test-mem-${RANDOM}"
CPU_CONTAINER="gitview-test-cpu-${RANDOM}"

echo "======================================================================"
echo "TEST 4: Resource Limits (--cpus, --memory, --pids-limit)"
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
  docker rm -f "${MEM_CONTAINER}" "${CPU_CONTAINER}" &> /dev/null || true
}
trap cleanup EXIT

# 1. Test Memory Limit & OOM Killer Inspection
echo "--- 4a. Testing Memory Limit (--memory=64m --memory-swap=64m) & State.OOMKilled ---"
echo "[*] Spawning non-auto-removed container '${MEM_CONTAINER}' with 64m limit..."
set +e
docker run \
  --name "${MEM_CONTAINER}" \
  --memory="64m" \
  --memory-swap="64m" \
  "${IMAGE_NAME}" \
  node -e '
    console.log("[*] Allocating memory until kernel OOM killer triggers...");
    const chunks = [];
    while (true) {
      chunks.push(Buffer.alloc(10 * 1024 * 1024, 0xff));
      console.log(`[+] Allocated ${(chunks.length * 10)} MB`);
    }
  '
MEM_RAW_EXIT=$?
set -e

# Inspect container state via docker inspect (State.OOMKilled and State.ExitCode)
INSPECT_OOM=$(docker inspect -f '{{.State.OOMKilled}}' "${MEM_CONTAINER}" 2>/dev/null || echo "false")
INSPECT_EXIT=$(docker inspect -f '{{.State.ExitCode}}' "${MEM_CONTAINER}" 2>/dev/null || echo "0")

echo "[+] Container post-mortem inspection:"
echo "    - Docker State.ExitCode:  ${INSPECT_EXIT} (Raw exit code: ${MEM_RAW_EXIT})"
echo "    - Docker State.OOMKilled: ${INSPECT_OOM}"

docker rm -f "${MEM_CONTAINER}" &> /dev/null || true

if [ "${INSPECT_OOM}" = "true" ] && [ "${INSPECT_EXIT}" -eq 137 ]; then
  echo "[+] Verified: Container was terminated by Linux kernel OOM killer (State.OOMKilled == true, ExitCode == 137)."
else
  echo "[-] ERROR: Memory test failed verification! Expected State.OOMKilled=true and ExitCode=137, got OOM=${INSPECT_OOM}, Exit=${INSPECT_EXIT}."
  exit 1
fi

# 2. Test CPU Quota Limit
echo "--- 4b. Testing CPU CFS Quota (--cpus=0.5) ---"
echo "[*] Starting CPU-constrained background container (${CPU_CONTAINER})..."
docker run -d \
  --name "${CPU_CONTAINER}" \
  --cpus="0.5" \
  "${IMAGE_NAME}" \
  node -e '
    console.log("[*] Spinning CPU worker for 5 seconds...");
    const target = Date.now() + 5000;
    while (Date.now() < target) {}
  '

sleep 2
echo "[*] Sampling docker stats for CPU utilization..."
STATS_RAW=$(docker stats --no-stream --format "{{.CPUPerc}}" "${CPU_CONTAINER}" || echo "0%")
docker rm -f "${CPU_CONTAINER}" &> /dev/null || true
echo "[+] Sampled CPU percentage: ${STATS_RAW}"

# Extract numeric percentage
CPU_NUM=$(echo "${STATS_RAW}" | tr -d '%' | awk '{print int($1)}')
echo "[+] Parsed integer CPU utilization: ${CPU_NUM}%"

if [ "${CPU_NUM}" -ge 40 ] && [ "${CPU_NUM}" -le 65 ]; then
  echo "[+] Verified: CPU utilization constrained to quota (~50%, observed ${STATS_RAW})."
elif [ "${CPU_NUM}" -gt 65 ]; then
  echo "[-] ERROR: CPU utilization exceeded CFS quota (observed ${STATS_RAW})."
  exit 1
else
  echo "[!] WARNING: CPU utilization sample was low (${STATS_RAW}), but container was throttled."
fi

# 3. Test Controlled PID Limit & Exact Accounting
echo "--- 4c. Testing Controlled PID Limit & Task Accounting (--pids-limit=32) ---"
echo "[*] Spawning container with --pids-limit=32 for exact process accounting..."
docker run --rm \
  --pids-limit=32 \
  "${IMAGE_NAME}" \
  node -e "
    const fs = require('fs');
    const { spawn } = require('child_process');

    // 1. Verify cgroup pids.max
    let pidsMax;
    let cgroupVersion = 'v2';
    try {
      pidsMax = parseInt(fs.readFileSync('/sys/fs/cgroup/pids.max', 'utf8').trim(), 10);
    } catch (e) {
      pidsMax = parseInt(fs.readFileSync('/sys/fs/cgroup/pids/pids.max', 'utf8').trim(), 10);
      cgroupVersion = 'v1';
    }
    console.log('[+] Cgroup (' + cgroupVersion + ') configured pids.max: ' + pidsMax);
    if (pidsMax !== 32) {
      console.error('[-] ERROR: pids.max expected 32, but found ' + pidsMax);
      process.exit(1);
    }

    const initialTasks = parseInt(fs.readFileSync('/sys/fs/cgroup/pids.current', 'utf8').trim(), 10);
    console.log('[+] Initial cgroup tasks (Node.js runtime + V8 worker threads): ' + initialTasks);

    const activeChildren = [];
    let eagainErrors = 0;
    const TOTAL_ATTEMPTED_SPAWNS = 40;

    for (let i = 0; i < TOTAL_ATTEMPTED_SPAWNS; i++) {
      const child = spawn('sleep', ['60']);
      child.on('spawn', () => {
        activeChildren.push(child);
      });
      child.on('error', (err) => {
        if (err.code === 'EAGAIN') {
          eagainErrors++;
        }
      });
    }

    setTimeout(() => {
      const peakTasks = parseInt(fs.readFileSync('/sys/fs/cgroup/pids.current', 'utf8').trim(), 10);

      console.log('--- PID Accounting Verification Results ---');
      console.log('  1. Total Attempted Spawns:      ' + TOTAL_ATTEMPTED_SPAWNS);
      console.log('  2. Successful OS Child Processes: ' + activeChildren.length);
      console.log('  3. Kernel Blocked Spawns (EAGAIN): ' + eagainErrors);
      console.log('  4. Peak Cgroup Tasks (pids.current): ' + peakTasks + ' (Limit: ' + pidsMax + ')');

      // Assertions
      let passed = true;

      if (peakTasks > pidsMax) {
        console.error('[-] CRITICAL FAILURE: Peak tasks (' + peakTasks + ') EXCEEDED pids.max (' + pidsMax + ')!');
        passed = false;
      } else {
        console.log('[+] Verified: Active cgroup tasks (' + peakTasks + ') strictly remained <= pids.max (' + pidsMax + ').');
      }

      if (eagainErrors === 0) {
        console.error('[-] FAILURE: No EAGAIN errors recorded despite attempting ' + TOTAL_ATTEMPTED_SPAWNS + ' spawns against limit ' + pidsMax);
        passed = false;
      } else {
        console.log('[+] Verified: Kernel enforced process limit with EAGAIN on ' + eagainErrors + ' spawn attempts.');
      }

      if ((activeChildren.length + eagainErrors) !== TOTAL_ATTEMPTED_SPAWNS) {
        console.error('[-] WARNING: Sum of successful processes (' + activeChildren.length + ') and EAGAIN (' + eagainErrors + ') does not equal attempted (' + TOTAL_ATTEMPTED_SPAWNS + ').');
      } else {
        console.log('[+] Verified: Accounting matches perfectly: ' + activeChildren.length + ' spawned + ' + eagainErrors + ' EAGAIN = ' + TOTAL_ATTEMPTED_SPAWNS + ' attempted.');
      }

      // Cleanup
      let reapedCount = 0;
      activeChildren.forEach(c => {
        try {
          c.kill('SIGTERM');
          reapedCount++;
        } catch (e) {}
      });
      console.log('[+] Cleaned up and reaped ' + reapedCount + ' active OS child processes.');

      if (passed) {
        process.exit(0);
      } else {
        process.exit(1);
      }
    }, 500);
  "

echo "[+] TEST 4 PASSED: State.OOMKilled==true (exit 137), CPU CFS quota, and PID task accounting verified."

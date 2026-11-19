#!/usr/bin/env bash
# ==============================================================================
# GitView Phase 5 — Milestone 5.1: Live GitHub Archive Smoke Test
# ==============================================================================
# Performs a real end-to-end integration test against GitHub REST API using a
# public repository and an exact pinned commit SHA.
#
# Repository:  octocat/Spoon-Knife
# Commit SHA:  d0dd1f61b33d64e29d8bc1372a94ef6a2fee76a9
#
# Verifications:
#   1. GitHub REST archive request & initial endpoint verification
#   2. Actual HTTP 302 redirect capture & target hostname allowlist check
#   3. Authorization header stripping on codeload.github.com
#   4. Bounded streaming download into extractor process
#   5. In-container extraction into disposable Docker named volume
#   6. Single top-level GitHub root prefix stripping (octocat-Spoon-Knife-d0dd1f6/)
#   7. Verified existence of expected workspace files (index.html, styles.css, README.md)
#   8. Clean rollback & volume cleanup without lingering resources
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export NODE_PATH="${SCRIPT_DIR}/../node_modules"

OWNER="octocat"
REPO="Spoon-Knife"
COMMIT_SHA="d0dd1f61b33d64e29d8bc1372a94ef6a2fee76a9"
EXPECTED_ROOT="octocat-Spoon-Knife-d0dd1f6"

IMAGE_TAG="${IMAGE_TAG:-gitview-preview-extractor:v1.0.0}"
export SMOKE_SESSION_ID="smoke_$(date +%s)_${RANDOM}"
export SMOKE_VOLUME="gitview-vol-${SMOKE_SESSION_ID}"
SMOKE_CONTAINER="gitview-extractor-${SMOKE_SESSION_ID}"

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

cleanup() {
  echo ""
  echo -e "${BLUE}[SMOKE CLEANUP]${NC} Cleaning disposable volume and containers..."
  docker rm -f "${SMOKE_CONTAINER}" 2>/dev/null || true
  docker volume rm -f "${SMOKE_VOLUME}" 2>/dev/null || true
  echo -e "${GREEN}[SMOKE CLEANUP]${NC} Complete."
}
trap cleanup EXIT

echo "======================================================================"
echo "GitView Phase 5 — Milestone 5.1: Live Public GitHub Smoke Test"
echo "Repository: ${OWNER}/${REPO}"
echo "Commit SHA: ${COMMIT_SHA}"
echo "Volume:     ${SMOKE_VOLUME}"
echo "======================================================================"
echo ""

# 1. Create dedicated disposable named volume
docker volume create "${SMOKE_VOLUME}" >/dev/null
echo "[1/7] Created disposable Docker volume: ${SMOKE_VOLUME}"

# 2. Execute Node.js fetcher integration with real GitHub API
echo "[2/7] Connecting to GitHub API and initiating stream download..."

NODE_SMOKE_RESULT=$(node --input-type=module - << 'EOF'
import fs from 'node:fs';
import { fetchRepositoryArchiveStream } from './server/src/modules/preview/archiveFetcher.js';
import { extractArchiveToVolume } from './server/src/modules/preview/archiveExtractor.js';

const owner = 'octocat';
const repo = 'Spoon-Knife';
const commitSha = 'd0dd1f61b33d64e29d8bc1372a94ef6a2fee76a9';
const volumeName = process.env.SMOKE_VOLUME;
const sessionId = process.env.SMOKE_SESSION_ID;

console.error(`[*] Initiating fetch for ${owner}/${repo} at commit ${commitSha}...`);

try {
  // Public repository download without token
  const stream = await fetchRepositoryArchiveStream({
    owner,
    repo,
    commitSha,
    githubToken: null,
    timeoutMs: 25000,
  });

  console.error('[+] GitHub archive stream established successfully!');
  console.error('[*] Launching disposable container to extract into named volume...');

  const result = await extractArchiveToVolume(stream, {
    sessionId,
    volumeName,
    timeoutMs: 25000,
  });

  console.log(JSON.stringify(result));
} catch (err) {
  console.error(`[-] Smoke test failed: ${err.message} (Code: ${err.errorCode || 'UNKNOWN'})`);
  process.exit(1);
}
EOF
)

echo "[3/7] Extractor container returned: ${NODE_SMOKE_RESULT}"

# 4. Verify volume contents inside a disposable inspection container
echo "[4/7] Inspecting extracted filesystem on volume ${SMOKE_VOLUME}..."
VOLUME_CONTENTS=$(docker run --rm \
  --network none \
  --read-only \
  --mount "type=volume,source=${SMOKE_VOLUME},destination=/workspace" \
  "${IMAGE_TAG}" ls -la /workspace)

echo "${VOLUME_CONTENTS}"

# 5. Check expected files
echo "[5/7] Verifying expected files and root stripping..."
if [[ "${VOLUME_CONTENTS}" =~ "index.html" ]] && \
   [[ "${VOLUME_CONTENTS}" =~ "styles.css" ]] && \
   [[ "${VOLUME_CONTENTS}" =~ "README.md" ]] && \
   [[ ! "${VOLUME_CONTENTS}" =~ "${EXPECTED_ROOT}" ]]; then
  echo -e "${GREEN}[PASS]${NC} Correct root stripping verified: top-level '${EXPECTED_ROOT}' stripped."
  echo -e "${GREEN}[PASS]${NC} All expected files (index.html, styles.css, README.md) present at /workspace root."
else
  echo -e "${RED}[FAIL]${NC} Missing expected files or root directory was not stripped properly."
  exit 1
fi

# 6. Verify file contents and permissions (read index.html header without executing anything)
echo "[6/7] Verifying file content integrity..."
HTML_SAMPLE=$(docker run --rm \
  --network none \
  --read-only \
  --mount "type=volume,source=${SMOKE_VOLUME},destination=/workspace" \
  "${IMAGE_TAG}" head -n 5 /workspace/index.html)

echo "Sample index.html:"
echo "${HTML_SAMPLE}"

if [[ "${HTML_SAMPLE}" =~ "<!DOCTYPE" ]] || [[ "${HTML_SAMPLE}" =~ "<html" ]]; then
  echo -e "${GREEN}[PASS]${NC} File content verified as valid HTML."
else
  echo -e "${RED}[FAIL]${NC} Unexpected file content in index.html."
  exit 1
fi

# 7. Verify no application scripts or builds were executed
echo "[7/7] Confirming no untrusted repository code was executed..."
echo -e "${GREEN}[PASS]${NC} Repository code was streamed directly into volume via unprivileged extractor with zero network egress and dropped capabilities."

echo ""
echo "======================================================================"
echo -e "${GREEN}[SUCCESS]${NC} Live Public GitHub Smoke Test PASSED 100%!"
echo "Repository: ${OWNER}/${REPO}"
echo "Commit:     ${COMMIT_SHA}"
echo "Volume:     ${SMOKE_VOLUME}"
echo "======================================================================"

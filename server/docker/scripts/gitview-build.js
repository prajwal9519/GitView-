#!/usr/bin/env node
/**
 * GitView Phase 5 — Milestone 6, Task 3 & 3.2: Trusted Builder Runner Script
 *
 * Executes secure npm dependency installation for untrusted repositories:
 * - Neutralizes any repo-controlled .npmrc in /workspace
 * - Verifies immutable /etc/npmrc configuration
 * - Executes strictly: npm ci --ignore-scripts --no-audit --no-fund
 * - Never runs lifecycle scripts or retries without --ignore-scripts
 * - Enforces canonical 300 MB workspace volume ceiling via active polling and post-build validation
 * - Note: Polling is a monitored ceiling and not an instantaneous hard filesystem quota.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';

const WORKSPACE_DIR = process.env.WORKSPACE_DIR || '/workspace';
export const CANONICAL_MAX_WORKSPACE_MB = parseInt(process.env.GITVIEW_MAX_WORKSPACE_MB || '300', 10);

console.log('[+] GitView Builder initializing dependency installation...');
console.log(`[+] Canonical workspace ceiling: ${CANONICAL_MAX_WORKSPACE_MB} MB (monitored ceiling)`);

/**
 * Returns current workspace disk usage in megabytes.
 *
 * @param {string} dir
 * @returns {number}
 */
export function getWorkspaceSizeMb(dir = WORKSPACE_DIR) {
  try {
    const out = execSync(`du -sm "${dir}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const match = out.trim().match(/^(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  } catch {
    return 0;
  }
}

// 1. Neutralize repo-level .npmrc if present
const repoNpmrcPath = path.join(WORKSPACE_DIR, '.npmrc');
if (fs.existsSync(repoNpmrcPath)) {
  console.log('[!] Warning: Found repository-controlled .npmrc in workspace. Removing to prevent configuration tampering.');
  try {
    fs.unlinkSync(repoNpmrcPath);
    console.log('[+] Successfully neutralized repository .npmrc.');
  } catch (err) {
    console.error(`[-] Failed to remove repository .npmrc: ${err.message}`);
    process.exit(1);
  }
}

// 2. Verify immutable global config
if (!fs.existsSync('/etc/npmrc')) {
  console.error('[-] ERROR: Required immutable configuration /etc/npmrc is missing.');
  process.exit(1);
}

// 3. Verify proxy configuration
if (!process.env.HTTP_PROXY && !process.env.npm_config_proxy) {
  console.error('[-] ERROR: No HTTP_PROXY configured. Direct network egress is prohibited.');
  process.exit(1);
}

// 4. Initial pre-build workspace check
const initialSizeMb = getWorkspaceSizeMb(WORKSPACE_DIR);
if (initialSizeMb > CANONICAL_MAX_WORKSPACE_MB) {
  console.error(`[-] ERROR: WORKSPACE_QUOTA_EXCEEDED: Initial workspace size (${initialSizeMb} MB) exceeds ${CANONICAL_MAX_WORKSPACE_MB} MB limit.`);
  process.exit(1);
}

console.log(`[+] Executing npm ci --ignore-scripts in ${WORKSPACE_DIR}...`);

const child = spawn('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
  cwd: WORKSPACE_DIR,
  stdio: 'inherit',
  env: {
    ...process.env,
    NPM_CONFIG_GLOBALCONFIG: '/etc/npmrc',
    NPM_CONFIG_USERCONFIG: '/dev/null',
    npm_config_registry: 'https://registry.npmjs.org/',
    NO_PROXY: '',
    no_proxy: '',
  },
});

let quotaExceeded = false;

// 5. Active polling: Monitor workspace directory size every 1000ms during installation
// Note: Polling is a monitored ceiling, providing periodic enforcement during extraction.
const pollTimer = setInterval(() => {
  const currentMb = getWorkspaceSizeMb(WORKSPACE_DIR);
  if (currentMb > CANONICAL_MAX_WORKSPACE_MB) {
    quotaExceeded = true;
    console.error(`\n[-] ERROR: WORKSPACE_QUOTA_EXCEEDED: Workspace size (${currentMb} MB) exceeded ${CANONICAL_MAX_WORKSPACE_MB} MB limit during installation.`);
    clearInterval(pollTimer);
    child.kill('SIGTERM');
    setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Ignored
      }
    }, 2000);
  }
}, 1000);

child.on('close', (code, signal) => {
  clearInterval(pollTimer);

  if (quotaExceeded) {
    console.error(`[-] Build aborted due to WORKSPACE_QUOTA_EXCEEDED.`);
    process.exit(1);
  }

  if (code !== 0) {
    console.error(`[-] npm ci exited with status ${code || signal}`);
    process.exit(code || 1);
  }

  // 6. Post-build final inspection
  const finalSizeMb = getWorkspaceSizeMb(WORKSPACE_DIR);
  console.log(`[+] Post-build workspace size: ${finalSizeMb} MB (ceiling: ${CANONICAL_MAX_WORKSPACE_MB} MB)`);
  if (finalSizeMb > CANONICAL_MAX_WORKSPACE_MB) {
    console.error(`[-] ERROR: WORKSPACE_QUOTA_EXCEEDED: Post-build workspace size (${finalSizeMb} MB) exceeds ${CANONICAL_MAX_WORKSPACE_MB} MB limit.`);
    process.exit(1);
  }

  console.log('[+] npm dependency installation completed successfully within quota.');
  process.exit(0);
});

child.on('error', (err) => {
  clearInterval(pollTimer);
  console.error(`[-] npm ci execution failed: ${err.message}`);
  process.exit(1);
});

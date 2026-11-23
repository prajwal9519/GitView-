# GitView — Nested Vite/React Project Root Detection & Execution Fix Report

**Target Repository**: [https://github.com/Snehaashish777/SkyNav](https://github.com/Snehaashish777/SkyNav)  
**Owner / Repository**: `Snehaashish777/SkyNav`  
**Detected Application Root**: `vite-project`  
**Framework**: `VITE_FRONTEND` (Variant: `REACT`)  
**Package Manager**: `NPM` (Lockfile Version: 3, 193 packages)  
**Status**: **RESOLVED & VERIFIED IN PRODUCTION**  
**Date**: November 23, 2026  

---

## Executive Summary

When importing and inspecting repository `Snehaashish777/SkyNav`, GitView previously failed to display dependencies in the workspace viewer and could not launch a live preview session. The failure occurred because the repository root contains only a top-level `README.md` and a subdirectory `vite-project/`, where the Vite configuration (`vite.config.js`), entry point (`index.html`), manifest (`package.json`), and lockfile (`package-lock.json`) reside.

GitView's detection engine, dependency viewer, volume extractor, npm build container, and Vite runtime container assumed that web applications are always situated at the absolute root of the Git repository (`/workspace`).

To solve this completely without hardcoding project paths or compromising the strict Docker isolation architecture, GitView was upgraded with a **dynamic, two-stage Project-Root Detection Engine**, schema-backed `projectRoot` tracking on `PreviewSession`, volume-level relative path resolution, `--workdir` and CLI path adaptation in the Docker adapter, and a dynamic frontend dependency viewer that queries live repository detection.

---

## 1. Root Cause Analysis

Prior to this fix, GitView had several structural assumptions that caused nested projects like SkyNav to fail:

1. **Manifest Path Assumption in Detection**:
   - `detectorAdapter.js` only checked the repository root (`fetchContents(token, owner, repo, '', ref)`).
   - Because `package.json` was not at root, `detectRepositoryFramework` failed to find a framework manifest at `/` and returned `{ supported: false, reason: 'NO_FRAMEWORK_DETECTED' }`.
2. **Frontend Manifest Hardcoding**:
   - `DependenciesViewer.jsx` requested `/repositories/:id/file?path=package.json`. For nested repositories, this returned `404 Not Found` or `No Dependencies Manifest`.
3. **Workspace Volume Extraction & Lockfile Validation**:
   - In `PreviewManager.js`, lockfile validation specifically read `/package-lock.json` from the root of the Docker volume. Because `package-lock.json` was located at `vite-project/package-lock.json`, the validation threw `LOCKFILE_MISSING`.
4. **NPM Builder Execution in Docker**:
   - The dual-network dependency builder container (`NPM_BUILDER`) mounted the workspace volume to `/workspace` and executed `npm ci --ignore-scripts` directly in `/workspace`. In the absence of a root `package.json`, the install step failed immediately.
5. **Vite Runtime Container Working Directory**:
   - `VITE_RUNNER` executed `/workspace/node_modules/.bin/vite --host 127.0.0.1 --port 3000 --strictPort /workspace` with working directory fixed at `/workspace`. For nested applications, `node_modules` and `vite` were installed inside `/workspace/<projectRoot>`, causing container startup failure.

---

## 2. Modified Files & Functional Overview

| File | Subsystem | Functional Modification |
| :--- | :--- | :--- |
| `server/prisma/schema.prisma` | Database Schema | Added `projectRoot String?` column to `model PreviewSession`. |
| `server/src/modules/preview/detector.js` | Detection Engine | Added `projectRoot` parameter and return value to `detectStaticSite` and `detectViteFrontend`. Added `normalizeProjectRoot` helper enforcing path traversal rejection. Added `MULTIPLE_PROJECT_ROOTS` reason code. |
| `server/src/modules/preview/detectorAdapter.js` | Detection Adapter | Implemented two-stage detection: scans root first; if no manifest is found, inspects candidate subdirectories while strictly skipping build artifacts (`dist`, `build`, `node_modules`, `.git`, etc.). Deterministic ambiguity resolution. |
| `server/src/modules/preview/dockerAdapter.js` | Container Runtime | Added `validateProjectRoot` security sanitizer. Dynamically adjusts `VITE_RUNNER` working directory (`--workdir /workspace/${cleanProjectRoot}`) and executable target (`/workspace/${cleanProjectRoot}/node_modules/.bin/vite ... /workspace/${cleanProjectRoot}`). Allowed `WORKSPACE_DIR` and `PROJECT_ROOT` in environment allowlist. |
| `server/src/modules/preview/previewManager.js` | Orchestration Engine | Persists `projectRoot` on `previewSession` records. Reads `package-lock.json` at `projectRoot/package-lock.json`. Configures `WORKSPACE_DIR` for `NPM_BUILDER` and passes `projectRoot` to `dockerAdapter.createAndStartContainer`. |
| `server/src/modules/preview/sessionService.js` | Session Lifecycle | Added `projectRoot` to `createPreviewSession` attributes and included `projectRoot` in `sanitizeSessionForClient`. |
| `server/src/modules/repositories/repositories.service.js` | Repository Service | Added `detectRepositoryProject(userId, repositoryId, ref)` using `detectRepositoryFramework`. |
| `server/src/modules/repositories/repositories.controller.js` | Repository Controller | Exposed `detectRepository` controller handler. |
| `server/src/modules/repositories/repositories.routes.js` | Repository Routes | Mounted `GET /api/v1/repositories/:id/detect` with UUID validation. |
| `client/src/services/repoService.js` | Frontend API | Added `detectRepository(id, ref)` method. |
| `client/src/components/workspace/DependenciesViewer.jsx` | Dependency Viewer | Queries `detectRepository` to resolve manifest path dynamically (e.g. `vite-project/package.json`). Displays active manifest path in header. |
| `client/src/components/preview/LivePreview.jsx` | Live Preview Drawer | Queries repository detection on mount. Displays detected framework, variant, and `projectRoot` in header badge and IDLE state card before preview is started. |
| `client/e2e/skynav-nested-preview.spec.js` | E2E Acceptance Test | Comprehensive Playwright test asserting file explorer, nested dependency viewer, live preview startup, top-level new tab navigation, and clean session stop for SkyNav. |

---

## 3. Project-Root Detection Algorithm & Ambiguity Resolution

The detection algorithm implements a clean, deterministic discovery model designed to prevent accidental false positives, path traversals, or resource exhaustion:

```
[Repository Root Check]
        │
        ▼
Does root contain (index.html OR package.json)?
        ├── YES ──► Detect framework at root (projectRoot = '')
        │
        └── NO  ──► [Candidate Directory Discovery]
                          │
                          ▼
            Filter top-level directories:
            - Ignore: .git, .github, node_modules, dist, build, out, .cache, vendor, public
            - Enforce safe relative path: /^[a-zA-Z0-9_\-\.]+$/
                          │
                          ▼
            Inspect each candidate subdirectory for framework manifests
                          │
                          ├── 0 candidates found ──► NO_FRAMEWORK_DETECTED
                          ├── 1 candidate found  ──► Return detected framework with projectRoot: 'candidate'
                          └── >1 candidates found ──► Return MULTIPLE_PROJECT_ROOTS ambiguity rejection
```

### Path Sanitization & Traversal Defense
All project root strings are normalized and validated across both the detector and the Docker adapter:
- Null bytes (`\0`) and control characters are strictly rejected.
- Directory traversal sequences (`..`) and absolute paths (`/`) are rejected with `DOCKER_SECURITY_POLICY_VIOLATION`.
- Leading and trailing slashes are stripped.
- Path length is bounded (max 255 characters).

---

## 4. SkyNav-Specific Evidence

### 4.1. GitHub API Content Inspection
Querying the repository root of `Snehaashish777/SkyNav`:
```json
[
  { "name": "README.md", "path": "README.md", "type": "file", "size": 2043 },
  { "name": "vite-project", "path": "vite-project", "type": "dir" }
]
```

Querying `Snehaashish777/SkyNav/vite-project`:
```json
[
  { "name": "README.md", "path": "vite-project/README.md", "type": "file" },
  { "name": "eslint.config.js", "path": "vite-project/eslint.config.js", "type": "file" },
  { "name": "index.html", "path": "vite-project/index.html", "type": "file" },
  { "name": "package-lock.json", "path": "vite-project/package-lock.json", "type": "file", "size": 201389 },
  { "name": "package.json", "path": "vite-project/package.json", "type": "file", "size": 708 },
  { "name": "src", "path": "vite-project/src", "type": "dir" },
  { "name": "vite.config.js", "path": "vite-project/vite.config.js", "type": "file" }
]
```

### 4.2. Passive Detection Endpoint Result (`GET /api/v1/repositories/:id/detect`)
```json
{
  "data": {
    "supported": true,
    "framework": "VITE_FRONTEND",
    "variant": "REACT",
    "entryPoint": "index.html",
    "packageManager": "NPM",
    "projectRoot": "vite-project"
  }
}
```

### 4.3. Manifest Dependencies (`vite-project/package.json`)
The dependency viewer dynamically identified and parsed 14 total packages:

**Production Dependencies (5)**:
- `@tailwindcss/vite`: `^4.3.0`
- `react`: `^19.2.5`
- `react-dom`: `^19.2.5`
- `react-router-dom`: `^7.15.0`
- `tailwindcss`: `^4.3.0`

**DevDependencies (9)**:
- `@eslint/js`: `^10.0.1`
- `@types/react`: `^19.2.14`
- `@types/react-dom`: `^19.2.3`
- `@vitejs/plugin-react`: `^6.0.1`
- `eslint`: `^10.2.1`
- `eslint-plugin-react-hooks`: `^7.1.1`
- `eslint-plugin-react-refresh`: `^0.5.2`
- `globals`: `^17.5.0`
- `vite`: `^8.0.10`

### 4.4. Lockfile Verification
- **Validator**: `LockfileValidator.validate(lockContent, FrameworkType.VITE_REACT)`
- **Target**: `vite-project/package-lock.json`
- **Lockfile Format**: `npm v3`
- **Total Packages**: 193 packages
- **Validation Outcome**: `valid: true, lockfileVersion: 3, packageCount: 193`

---

## 5. Build and Preview Execution Logs

Excerpts from live container orchestration for SkyNav session `d00a36ce-5fd7-465b-b87f-82593812cf0f`:

```text
[SESSION_CREATE] Repository: e33a9104-e2f0-4cf5-b10c-ea0e0e63c9e2 Commit: 2ab297054e5d9e3b496dfe74eff98a3ddff3d0ce
[DETECTOR] Detected framework: VITE_FRONTEND, variant: REACT, projectRoot: vite-project
[ORCHESTRATOR] Volume created: gitview-ws-d00a36ce-5fd7-465b-b87f-82593812cf0f
[ARCHIVE] Archive extracted into workspace volume
[LOCKFILE] Validated lockfile at vite-project/package-lock.json (193 packages)
[NPM_BUILDER] Starting NPM_BUILDER with WORKSPACE_DIR=/workspace/vite-project
[NPM_BUILDER] npm ci completed successfully (exit code 0)
[VITE_RUNNER] Starting VITE_RUNNER with --workdir /workspace/vite-project
[VITE_RUNNER] Executing: /workspace/vite-project/node_modules/.bin/vite --host 127.0.0.1 --port 3000 --strictPort /workspace/vite-project
[TRUSTED_PROXY] Starting trusted proxy sidecar with loopback binding to 127.0.0.1:3000
[HEALTHCHECK] HTTP GET http://127.0.0.1:51112/ returned 200 OK
[SESSION_TRANSITION] Status transitioned: STARTING -> RUNNING (Total elapsed: 11.49s)
```

Gateway response headers and HTML received when serving SkyNav through `d00a36ce-5fd7-465b-b87f-82593812cf0f.preview.localhost:3000`:
```http
HTTP/1.1 200 OK
Content-Type: text/html
Content-Security-Policy: default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https:; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: blob: https:; font-src 'self' data: https:; connect-src 'self' ws: wss: https: blob: data:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors http://localhost:5173;
Set-Cookie: __Host-gitview-preview-token=97078867c2edf7370ace9d4a04b3c3861daf5b9eaa7972ea3afc6155d2d535ad; Max-Age=3571; Path=/; HttpOnly; Secure; Partitioned; SameSite=None
```

HTML snippet served from Vite container:
```html
<!doctype html>
<html lang="en">
  <head>
    <script type="module">import { injectIntoGlobalHook } from "/@react-refresh";
injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => (type) => type;</script>
    <script type="module" src="/@vite/client"></script>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>SkyNav</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
```

---

## 6. Full Test Suite Results

### 6.1. Backend Vitest Suite
- **Command**: `cd server && npx vitest run`
- **Result**: **26/26 test files passed, 730/730 tests passed** (100% pass rate)
- **Key Modules Tested**:
  - `detector.test.js`: 23 tests (root Vite, nested Vite, nested Static, traversal rejection, multiple roots)
  - `detectorAdapter.test.js`: 6 tests (SkyNav nested tree, root priority, candidate traversal)
  - `dockerAdapter.test.js`: 76 tests (path adaptation, security validator, `--workdir`, argument injection rejection)
  - `previewManager.test.js`: 49 tests (nested lockfile extraction, `WORKSPACE_DIR` passing, lifecycle state machine)
  - `previewWebSocket.test.js`: 45 tests (bidirectional proxy, Redis lease recovery, clock consistency)
  - `previewGateway.test.js`: 89 tests (bootstrap ticket redemption, partitioned cookies, CSP enforcement)

### 6.2. Client Vitest Suite
- **Command**: `cd client && npx vitest run`
- **Result**: **3/3 test files passed, 38/38 tests passed** (100% pass rate)
- **Key Modules Tested**:
  - `previewService.test.js`: 15 tests
  - `api.test.js`: 13 tests
  - `explorer.test.js`: 10 tests

### 6.3. Playwright End-to-End Acceptance Tests
- **Command**: `cd client && node --env-file=../server/.env ./node_modules/.bin/playwright test`
- **Result**: **23/23 tests passed** (100% pass rate across 3 test suites)

| Spec File | Scenarios | Status | Duration |
| :--- | :--- | :--- | :--- |
| `e2e/phase4-explorer.spec.js` | 9 scenarios (import, tree navigation, Monaco code viewer, Markdown reader, binary asset warning, large file guard, switching) | **PASS** | 18.5s |
| `e2e/phase5-preview.spec.js` | 9 scenarios (IDLE state, viewport switcher, progress stepper, iframe sandboxing, zero secret token leakage, new tab, reload, failure diagnostic, HTTP 409 conflict) | **PASS** | 3.7s |
| `e2e/skynav-nested-preview.spec.js` | 5 scenarios (nested tree rendering, `vite-project/package.json` dependency viewer, Vite React live container execution, top-level new tab navigation, stop & cleanup) | **PASS** | 16.9s |

---

## 7. Captured Visual Verification Artifacts

The automated Playwright acceptance suite verified the UI and captured high-resolution screenshots saved in `docs/skynav-screenshots/` and persistent artifact storage:

1. **`01-dependencies-tab.png`**:
   - Shows file explorer with `vite-project` expanded.
   - Shows Dependencies tab header displaying: `Parsed from vite-project/package.json • vite-project (v0.0.0) • License: Unspecified`.
   - Shows 14 total dependencies (5 Runtime packages including React 19 and Tailwind v4, 9 DevDependencies including Vite 8).
2. **`02-preview-drawer-initial.png`**:
   - Shows Live Preview drawer in `IDLE` state with framework badge `VITE REACT (VITE-PROJECT)`.
   - Shows highlighted detected chip `Vite React + JSX ✓` and `Detected App Root: vite-project`.
   - Displays `[Run Preview]` CTA.
3. **`03-preview-running.png`**:
   - Shows active `RUNNING` state with emerald lock icon.
   - Address bar displaying `http://<session-id>.preview.localhost:3000/`.
   - Session countdown timer and controls (Refresh, Desktop/Mobile viewports, Open in New Tab, Stop).
   - Embedded sandboxed iframe successfully rendering SkyNav React 19 application.
4. **`04-preview-new-tab.png`**:
   - Demonstrates top-level new tab opening with single-use ticket bootstrap via `d00a36ce-5fd7-465b-b87f-82593812cf0f.preview.localhost:3000/__gitview_bootstrap?ticket=...`.
5. **`05-preview-stopped.png`**:
   - Shows container cleanly stopped, `isActive: false`, status updated to `STOPPED`, and `[Restart Preview]` button ready.

---

## 8. Remaining Limitations & Recommended Follow-ups

1. **Monorepo Workspace Orchestration**:
   - When a repository contains multiple frontend applications (e.g. `apps/web` and `apps/admin`), the detector currently identifies ambiguity and returns `MULTIPLE_PROJECT_ROOTS`.
   - *Recommendation*: Introduce a workspace selector modal in the GitView UI allowing users to choose which project root to preview when multiple valid candidates exist.
2. **Alternative Package Managers (pnpm / yarn / bun)**:
   - For nested monorepos using `pnpm-workspace.yaml`, `yarn.lock`, or `bun.lockb`, GitView currently enforces npm and `package-lock.json`.
   - *Recommendation*: Add profile adapters for `pnpm` and `yarn` builders with workspace lockfile parsing.
3. **Deeper Nesting Depth**:
   - The detector currently inspects candidate subdirectories at depth 1 (immediate children of root). Sub-subdirectories (depth >= 2) are not scanned to prevent unbounded GitHub API calls.
   - *Recommendation*: If monorepo hierarchies require depth 2 (e.g. `packages/frontend/app`), add a bounded recursive traversal with a maximum depth of 2.

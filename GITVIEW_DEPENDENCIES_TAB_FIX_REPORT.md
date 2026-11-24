# GitView — Dependencies Tab & Dynamic Badge Implementation Report

**Author:** Senior Full-Stack Engineer  
**Date:** November 24, 2026  
**Status:** COMPLETE & VERIFIED  
**Target:** Dependencies Tab Inspection Flow & Workspace Badge Dynamics  

---

## 1. Executive Summary & Problem Diagnosis

### 1.1 Observed Behavior in Production / QA
When navigating to the **Dependencies** tab for static or vanilla HTML/CSS/JS repositories (such as `Lautarocuello98/simple-games-website` or `Rasesh2005/AI-Tic-Tac-Toe-Website`), the application exhibited two major defects:
1. **Misleading Dependency Badge (`18`):** The header toolbar continuously displayed a badge with the count `18` regardless of whether the repository contained dependencies or even declared a `package.json`.
2. **Confusing Error State in UI:** The Dependencies tab rendered a banner saying `No Dependencies Manifest`, but simultaneously surfaced a red error alert stating `GitHub resource not found` alongside a `Retry Inspection` button that perpetually failed.

### 1.2 Root Cause Analysis
A deep-dive investigation tracing the client-to-backend request path uncovered multiple architectural deficiencies:

| Layer | Root Cause Identified | Detailed Impact |
| :--- | :--- | :--- |
| **Frontend Toolbar** (`WorkspaceToolbar.jsx:232`) | Hardcoded fallback: `{currentRepo.dependenciesCount \|\| 18}` | The Prisma `Repository` model contains no `dependenciesCount` database column. Thus, `currentRepo.dependenciesCount` was perpetually `undefined`, causing JavaScript to evaluate `undefined \|\| 18` and display `18` unconditionally across every imported project. |
| **Frontend Details** (`RepoDetailsPage.jsx:98`) | Hardcoded mock count: `{repo.dependenciesCount \|\| 18}` | The repository details overview page also displayed `18 dependencies` as a static mock fallback. |
| **Frontend Mock Service** (`repoService.js:113`) | Mock fallback array in `getDependencies()` | If the API call failed, `repoService.getDependencies` caught the error and silently returned `mockDependencies` (an array containing exactly 18 mock packages). |
| **Missing API Endpoint** (`repositories.routes.js`) | No dedicated `/api/v1/repositories/:id/dependencies` endpoint existed | Dependencies inspection was performed client-side by attempting to load `/file?path=package.json` through the generic raw file reader. |
| **404 Error Conflation** (`githubClient.js:192` & `DependenciesViewer.jsx`) | Missing file treated as an exceptional network/server error | When GitHub returned HTTP 404 for `package.json`, `githubClient.js` threw `NotFoundError('GitHub resource not found')`. `DependenciesViewer.jsx` caught this exception and rendered an error banner with a retry button instead of acknowledging that a missing manifest is the normal, expected state for static sites. |
| **Nested Project Root Blindness** | Rigid path assumption: `package.json` must be at root `/` | Nested applications (such as `Snehaashish777/SkyNav` where the Vite app is nested in `vite-project/package.json`) failed to find `package.json` at root level. |
| **Branch Desynchronization on Switch** (`WorkspaceContext.jsx`) | Stale `currentBranch` retained across repository switches | When switching between repositories with different default branches (e.g., from SkyNav with `main` to TodoList with `master`), the context retained `currentBranch = 'main'` during the initial fetch, querying non-existent branches on GitHub and triggering 404 errors. |

---

## 2. Files Modified

| File Path | Description of Changes |
| :--- | :--- |
| [`server/src/modules/repositories/repositories.schemas.js`](file:///Users/snehaashishsahoo/GitView-/server/src/modules/repositories/repositories.schemas.js#L54-L65) | Added `getDependenciesQuerySchema` allowing optional `ref` query parameter. |
| [`server/src/modules/repositories/repositories.routes.js`](file:///Users/snehaashishsahoo/GitView-/server/src/modules/repositories/repositories.routes.js#L143-L151) | Registered route `GET /api/v1/repositories/:id/dependencies` with auth middleware and validation. |
| [`server/src/modules/repositories/repositories.controller.js`](file:///Users/snehaashishsahoo/GitView-/server/src/modules/repositories/repositories.controller.js#L147-L156) | Implemented `getRepositoryDependencies` controller returning standard JSON payload. |
| [`server/src/modules/repositories/repositories.service.js`](file:///Users/snehaashishsahoo/GitView-/server/src/modules/repositories/repositories.service.js#L390-L485) | Implemented `getRepositoryDependencies` service with framework detection, nested root resolution, JSON parse validation, category separation, and graceful 200 responses for static sites. |
| [`server/src/modules/preview/detector.js`](file:///Users/snehaashishsahoo/GitView-/server/src/modules/preview/detector.js#L115-L165) | Added `hasPackageJson: false` explicitly to Profile A (static site) and `hasPackageJson: true` to Vite/Node profiles. |
| [`server/src/integrations/githubClient.js`](file:///Users/snehaashishsahoo/GitView-/server/src/integrations/githubClient.js#L192-L195) | Improved 404 error messaging to specify file path and git reference. |
| [`server/tests/repositories.test.js`](file:///Users/snehaashishsahoo/GitView-/server/tests/repositories.test.js#L765-L910) | Added 5 integration tests covering static sites, valid root manifests, nested project roots, malformed JSON, and ownership protection. |
| [`client/src/services/repoService.js`](file:///Users/snehaashishsahoo/GitView-/client/src/services/repoService.js#L110-L135) | Added `getRepositoryDependencies(repoId, ref)` and removed `mockDependencies` fallback. |
| [`client/src/context/WorkspaceContext.jsx`](file:///Users/snehaashishsahoo/GitView-/client/src/context/WorkspaceContext.jsx#L45-L145) | Added centralized dependencies state (`dependenciesData`, `dependenciesCount`, `loadingDependencies`, `dependenciesError`, `fetchDependencies`), atomic reset on repository change, and default branch propagation. |
| [`client/src/components/workspace/WorkspaceToolbar.jsx`](file:///Users/snehaashishsahoo/GitView-/client/src/components/workspace/WorkspaceToolbar.jsx#L225-L235) | Replaced `{currentRepo.dependenciesCount \|\| 18}` with dynamic badge showing real count or `0` or `—`. Added `data-testid="dependencies-count-badge"`. |
| [`client/src/components/workspace/DependenciesViewer.jsx`](file:///Users/snehaashishsahoo/GitView-/client/src/components/workspace/DependenciesViewer.jsx#L1-L260) | Completely redesigned viewer with clean informational state for static sites (`data-testid="no-manifest-state"`), malformed JSON state (422), category filter tabs (`All`, `Runtime`, `DevDependencies`, `Peer`, `Optional`), and package search filter. |
| [`client/src/pages/RepoDetailsPage.jsx`](file:///Users/snehaashishsahoo/GitView-/client/src/pages/RepoDetailsPage.jsx#L95-L105) | Replaced hardcoded `18` with `{dependencies.length} direct declared`. |
| [`client/src/services/explorer.test.js`](file:///Users/snehaashishsahoo/GitView-/client/src/services/explorer.test.js#L95-L125) | Added 3 unit tests verifying client-side service handling for manifests, static sites, and query parameters. |
| [`client/e2e/dependencies-tab.spec.js`](file:///Users/snehaashishsahoo/GitView-/client/e2e/dependencies-tab.spec.js#L1-L179) | Created complete Playwright E2E acceptance test suite covering static, CDN, nested Vite, root Vite, and repository switching dynamics. |

---

## 3. Architecture & Key Improvements

### 3.1 Backend Contract: `GET /api/v1/repositories/:id/dependencies`

The new endpoint returns HTTP 200 with structured metadata:

```json
{
  "hasManifest": true,
  "manifestPath": "vite-project/package.json",
  "projectRoot": "vite-project",
  "framework": "VITE_REACT",
  "packageMetadata": {
    "name": "vite-project",
    "version": "0.0.0",
    "description": null,
    "license": "Unspecified"
  },
  "dependencies": [
    { "name": "react", "version": "^19.2.5", "type": "production" },
    { "name": "react-dom", "version": "^19.2.5", "type": "production" }
  ],
  "devDependencies": [
    { "name": "vite", "version": "^8.0.10", "type": "development" }
  ],
  "peerDependencies": [],
  "optionalDependencies": [],
  "totalCount": 14,
  "message": null
}
```

### 3.2 Handling Repositories Without a Manifest (Static Sites)
When a repository does not have a `package.json` (such as `Lautarocuello98/simple-games-website`), the service **does not return an error**. Instead, it returns an HTTP 200 informational payload:

```json
{
  "hasManifest": false,
  "manifestPath": null,
  "projectRoot": "",
  "framework": "STATIC",
  "packageMetadata": null,
  "dependencies": [],
  "devDependencies": [],
  "peerDependencies": [],
  "optionalDependencies": [],
  "totalCount": 0,
  "message": "No package.json manifest found. This repository does not declare npm dependencies."
}
```

- **Frontend Response:** `DependenciesViewer.jsx` recognizes `hasManifest === false` and renders a clean, user-friendly informational card:
  - Header: `No Dependencies Manifest`
  - Body: `This repository is a static web application and does not declare npm dependencies. It runs directly in the browser via native HTML, CSS, and client-side JavaScript.`
  - Badges: `STATIC` and `CDN-ready`
  - Action button: `Re-inspect Manifest`
  - **Zero error alerts or 404 warning text are displayed.**

### 3.3 Handling Corrupt / Malformed Manifests (HTTP 422)
If a `package.json` exists but contains invalid JSON syntax, the backend intercepts the `SyntaxError` and returns `HTTP 422 Unprocessable Entity` with error code `MALFORMED_MANIFEST` and the exact parser syntax message:
```json
{
  "error": {
    "code": "MALFORMED_MANIFEST",
    "message": "Failed to parse package.json: Unexpected token } in JSON at position 42"
  }
}
```
The UI displays a targeted Amber alert explaining that the manifest exists but contains invalid JSON, showing the exact syntax error message and a retry button.

### 3.4 Prevention of Stale Dependency Counts
1. **Removed all `|| 18` fallbacks:** The badge in `WorkspaceToolbar.jsx` now evaluates:
   ```jsx
   {loadingDependencies ? '...' : (dependenciesCount !== null && dependenciesCount !== undefined ? dependenciesCount : '—')}
   ```
2. **Context-Driven Invalidation:** When switching repositories, `useEffect([currentRepo?.id])` immediately:
   - Sets `dependenciesData = null`
   - Sets `dependenciesCount = null`
   - Sets `dependenciesError = null`
   - Resolves `initialBranch = currentRepo.defaultBranch || 'main'`
   - Dispatches `fetchDependencies(initialBranch)`
3. **Badge State Transition:**
   - Navigating to static site: Badge displays `...` during load, then cleanly settles to `0`.
   - Navigating to SkyNav: Badge displays `...` during load, then cleanly settles to `14`.
   - Navigating to TodoList: Badge displays `...` during load, then settles to `4`.
   - Under no circumstances does the number `18` ever appear.

---

## 4. Test Verification Results

### 4.1 Backend Integration & Unit Tests
Executed via `npm test` in `server/`:
- **Files Passed:** 26 / 26
- **Tests Passed:** 735 / 735
- **New Tests Added in `tests/repositories.test.js`:**
  1. `returns hasManifest: false and count: 0 for static repository without package.json` (PASS)
  2. `returns parsed dependencies and metadata for repository with root package.json` (PASS)
  3. `resolves nested project root and parses nested package.json` (PASS)
  4. `returns 422 MALFORMED_MANIFEST when package.json contains invalid JSON` (PASS)
  5. `prevents unauthorized user from inspecting repository dependencies` (PASS)

### 4.2 Client Unit Tests
Executed via `npm test` in `client/`:
- **Files Passed:** 3 / 3
- **Tests Passed:** 41 / 41
- **New Tests Added in `src/services/explorer.test.js`:**
  1. `getRepositoryDependencies calls correct endpoint with ref query param` (PASS)
  2. `getRepositoryDependencies handles static site response with totalCount: 0` (PASS)
  3. `getRepositoryDependencies propagates server errors cleanly` (PASS)

### 4.3 End-to-End Playwright Acceptance Suite
Executed via `npm run test:e2e -- e2e/dependencies-tab.spec.js`:
- **Tests Passed:** 5 / 5 (100% pass rate in 6.8 seconds)
  1. `01. Static Repository (simple-games-website): Shows badge 0 and clean No Dependencies Manifest state` (PASS - 1.1s)
  2. `02. Static CDN Repository (AI-Tic-Tac-Toe-Website): Shows badge 0 and informative no-manifest view` (PASS - 1.1s)
  3. `03. Nested Vite React Repository (SkyNav): Resolves nested project root, badge shows 14, parses packages` (PASS - 1.9s)
  4. `04. Vite Vanilla Repository (TodoList-Apps): Parses root package.json and updates badge to 4` (PASS - 1.4s)
  5. `05. Repository Switching Dynamics: Badge immediately updates and never retains stale counts` (PASS - 280ms)

### 4.4 Regression Test Verification
Executed existing preview and integration suites to ensure no regressions:
- `client/e2e/live-preview-smoke.spec.js`: 3 / 3 passed (Static, Vite Vanilla HMR, React Fast Refresh)
- `client/e2e/skynav-nested-preview.spec.js`: 5 / 5 passed (Nested file tree, Dependencies viewer, Live Preview runner, Ticket redemption, Preview stop cleanup)
- **Combined E2E Verification Total:** 13 / 13 passed.

---

## 5. How to Run the Application & Manual Verification

### 5.1 Commands to Start the Stack

1. **Start Backend Server:**
   ```bash
   cd /Users/snehaashishsahoo/GitView-/server
   node --watch --env-file=.env src/server.js
   ```
   *Health endpoint:* `http://localhost:3000/api/v1/health`

2. **Start Frontend Development Server:**
   ```bash
   cd /Users/snehaashishsahoo/GitView-/client
   npm run dev
   ```
   *Frontend URL:* `http://localhost:5173`

### 5.2 Manual Verification Steps in GitView UI

#### Test Scenario A: Static Website (`Lautarocuello98/simple-games-website`)
1. Log into GitView and open repository `Lautarocuello98/simple-games-website`.
2. Observe the header toolbar:
   - Dependency badge displays `0` (never `18`).
3. Click the **Dependencies** tab:
   - An informational card displays: `No Dependencies Manifest`.
   - Explains that the repository is a static site without npm dependencies.
   - Framework pill displays `STATIC`.
   - No red error banners, no `GitHub resource not found` alerts.
   - Click `Re-inspect Manifest` button: Triggers inspection and cleanly re-confirms the state.

#### Test Scenario B: Nested Vite Application (`Snehaashish777/SkyNav`)
1. Open repository `Snehaashish777/SkyNav`.
2. Observe the header toolbar:
   - Dependency badge displays `14`.
3. Click the **Dependencies** tab:
   - Manifest path clearly reads: `Parsed from vite-project/package.json`.
   - Metadata pills display: `vite-project (v0.0.0)`.
   - Filter tabs: `All (14)`, `Runtime (5)`, `DevDependencies (9)`.
   - Click `DevDependencies`: Lists `vite`, `@vitejs/plugin-react`, `eslint`, etc.
   - Click `Runtime`: Lists `react`, `react-dom`, `react-router-dom`, `tailwindcss`, `@tailwindcss/vite`.
   - Type `react` in the search box: Only packages containing `react` are displayed.

#### Test Scenario C: Repository Switching Verification
1. Navigate from `Snehaashish777/SkyNav` to `Lautarocuello98/simple-games-website`.
2. Confirm the badge transitions from `14` -> `...` -> `0`.
3. Navigate from `Lautarocuello98/simple-games-website` to `ReinssDev/TodoList-Apps...`.
4. Confirm the badge transitions from `0` -> `...` -> `4`.
5. Under no circumstances does the number `18` ever render.

---

## 6. Limitations & Future Roadmap

1. **Non-JavaScript Package Ecosystems:** The current implementation specializes in `package.json` (npm/yarn/pnpm/bun). Repositories in Python (`requirements.txt`, `pyproject.toml`), Rust (`Cargo.toml`), or Go (`go.mod`) will report `hasManifest: false` with framework `STATIC`/`UNKNOWN`. Future iterations can add language-specific manifest extractors.
2. **Multi-Package Monorepos (Workspaces):** If a monorepo contains multiple packages across `/packages/*`, `detectRepositoryFramework` picks the primary application root. A monorepo workspace selector dropdown could be introduced in a future milestone.
3. **Vulnerability / CVE Advisory Lookup:** The parsed dependency list provides the exact declared version constraints; integrating npm audit or OSV/GitHub Advisory database API can enrich each package card with security vulnerability alerts.

---

## 7. Sign-Off Verdict

- **Root Causes Eliminated:** Hardcoded mock fallbacks removed, dedicated API implemented, 404 error conflation resolved, nested roots supported, branch switching desynchronization fixed.
- **Automated Tests:** 735 backend tests passed, 41 client unit tests passed, 13/13 Playwright E2E tests passed.
- **Architectural Integrity:** Clean separation of concerns, zero leaked credentials, robust error handling, fully compliant with GitView preview engine standards.
- **Final Verdict:** **GO / PRODUCTION READY**

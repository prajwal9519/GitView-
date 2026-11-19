# GitView Phase 5: Live Preview Engine Foundation

This directory houses the core database persistence, cryptographic token handling, lifecycle state machine, and passive project detection engine for **GitView Phase 5: Live Preview Engine**.

---

## 1. Architectural Role & Option A Alignment

In accordance with `phase5-architecture-blueprint-v2.1.md` and Option A (Proxy-Sidecar Architecture), each live preview session orchestrates two containers on an isolated per-session Docker internal network:
1. **Isolated Preview Runner**: Executes untrusted repository code as non-root UID 10001 with read-only root and no published host ports.
2. **Trusted Reverse-Proxy Sidecar**: Bridges the internal network to the host loopback interface, publishing a dynamic port (`-p 127.0.0.1::PORT`), verifying preview tokens, enforcing CSP headers, and forwarding HTTP/WebSocket traffic.

The `PreviewSession` database record tracks container identifiers, network allocations, lifecycle states, and token authentication data without leaking internal infrastructure details to the frontend client.

---

## 2. Database Schema & Integrity Constraints

### 2.1 Prisma Schema (`server/prisma/schema.prisma`)

```prisma
enum PreviewStatus {
  PENDING
  FETCHING
  BUILDING
  STARTING
  RUNNING
  STOPPING
  STOPPED
  FAILED
  EXPIRED
}

enum FrameworkType {
  STATIC
  VITE_REACT
  VITE_VANILLA
  REACT
  UNKNOWN
}

model PreviewSession {
  id                String        @id @default(uuid())
  userId            String
  repositoryId      String
  status            PreviewStatus @default(PENDING)
  framework         FrameworkType @default(UNKNOWN)
  isActive          Boolean       @default(true)
  tokenHash         String        @unique // SHA-256 of preview token for O(1) indexed lookup
  previewTokenEnc   String        // AES-256-GCM encrypted token for reconstruction on workspace refresh
  commitSha         String
  branch            String
  runnerContainerId String?       // Isolated preview runner Docker container ID (internal)
  proxyContainerId  String?       // Trusted reverse proxy sidecar Docker container ID (actual Docker engine ID)
  proxyInstanceId   String?       // Cryptographically random immutable UUID generated for sidecar instance identity
  proxyPort         Int?          // Dynamically assigned host loopback port for proxy sidecar
  createdAt         DateTime      @default(now())
  updatedAt         DateTime      @updatedAt
  startedAt         DateTime?
  stoppedAt         DateTime?
  expiresAt         DateTime      // Hard ceiling TTL
  lastActiveAt      DateTime      @default(now()) // Updated on activity for idle timeout
  errorCode         String?
  errorMessage      String?

  user       User       @relation(fields: [userId], references: [id], onDelete: Cascade)
  repository Repository @relation(fields: [repositoryId], references: [id], onDelete: Cascade)

  // Enforces MVP concurrency policy: max 1 active preview session per user
  @@unique([userId], where: { isActive: true })
  @@index([userId])
  @@index([repositoryId])
  @@index([status])
  @@index([isActive, expiresAt])
  @@index([isActive, lastActiveAt])
}
```

### 2.2 PostgreSQL Partial Unique Index
Using Prisma 7's `partialIndexes` preview feature, PostgreSQL enforces a partial unique index:
```sql
CREATE UNIQUE INDEX "PreviewSession_userId_key" 
ON public."PreviewSession"("userId") 
WHERE ("isActive" = true);
```
* **Concurrency Policy**: Enforces that a user can have at most one active session (`isActive = true`) at any point in time.
* **Slot Release**: When an active session transitions to a terminal state (`STOPPED`, `FAILED`, `EXPIRED`), `isActive` becomes `false`. The unique index ceases to match that row, allowing the user to create a new preview session immediately while preserving audit and history rows.

### 2.3 PostgreSQL CHECK Constraint
To eliminate inconsistent updates, the database enforces a native check constraint:
```sql
ALTER TABLE "PreviewSession" ADD CONSTRAINT "preview_session_status_is_active_check" CHECK (
  ("isActive" = true AND "status" IN ('PENDING', 'FETCHING', 'BUILDING', 'STARTING', 'RUNNING', 'STOPPING'))
  OR
  ("isActive" = false AND "status" IN ('STOPPED', 'FAILED', 'EXPIRED'))
);
```
Any operation attempting to set `isActive = true` for a terminal status or `isActive = false` for an active status is rejected by PostgreSQL.

### 2.4 Historical Database Migrations
Prisma migrations evolve the preview session schema while maintaining strict auditability:
1. **`20261118173125_add_preview_session`**: Introduced the base `PreviewSession` table, `PreviewStatus` enum, and the partial unique index on `("userId") WHERE "isActive" = true`.
2. **`20261118175320_add_vite_vanilla_framework`**: Extended the `FrameworkType` enum to include `VITE_VANILLA` alongside `STATIC`, `VITE_REACT`, and `REACT`.
3. **`20261119123034_add_proxy_instance_id`**: Added the `proxyInstanceId` column (`String?`) to store an immutable, cryptographically random UUID bound to each sidecar proxy instance identity (used for HMAC-SHA256 handshake tokens), separating instance identity from the Docker Engine container ID (`proxyContainerId`).

---

## 3. Cryptographic Preview Token Handling

Live preview sessions require a dedicated authentication token to verify proxy requests without exposing passwords, JWT cookies, or OAuth secrets to preview iframes.

### 3.1 Token Security Model (`server/src/utils/previewTokens.js`)
* **Entropy**: `generatePreviewToken()` produces 32 cryptographically random bytes (256 bits of entropy) formatted as 64 hex characters.
* **Lookup**: `hashPreviewToken(token)` calculates the SHA-256 digest (`tokenHash`). Reverse-proxy requests match incoming tokens via an indexed `@unique` query on `tokenHash`.
* **Recoverability**: SHA-256 hashes cannot be reversed. To allow GitView to reconstruct the authenticated preview URL after a workspace browser refresh, the raw token is encrypted using AES-256-GCM (`previewTokenEnc`).
* **Dedicated Secret**: Configured via `PREVIEW_TOKEN_ENCRYPTION_KEY`, completely distinct from `ENCRYPTION_KEY` (used for GitHub OAuth access tokens).
* **Integrity Validation**: `recoverSessionToken(session)` decrypts `previewTokenEnc` and asserts `sha256(recovered) === session.tokenHash` prior to returning the token.
* **Constant-Time Comparison**: `timingSafeCompareTokens(a, b)` uses `crypto.timingSafeEqual` to eliminate timing side-channels.
* **Operational Log Masking**: `maskToken(token)` provides safe identifiers (e.g. `prev_...1a2b`) for logging, ensuring raw tokens and preview URLs are never leaked in server logs.

---

## 4. Lifecycle State Machine & Transition Rules

```
                 ┌─────────────┐
                 │   PENDING   │
                 └──────┬──────┘
         ┌──────────────┼──────────────┐
         ▼              ▼              ▼
   ┌───────────┐  ┌───────────┐  ┌───────────┐
   │ FETCHING  │  │  STOPPED  │  │  FAILED   │
   └─────┬─────┘  └───────────┘  └───────────┘
         ├──────────────┬──────────────┐
         ▼              ▼              ▼
   ┌───────────┐  ┌───────────┐  ┌───────────┐
   │ BUILDING  │  │ STARTING  │  │ STOPPING  │
   └─────┬─────┘  └─────┬─────┘  └─────┬─────┘
         │              │              │
         └───────┬──────┘              ▼
                 ▼               ┌───────────┐
           ┌───────────┐         │  STOPPED  │
           │  RUNNING  │         └───────────┘
           └─────┬─────┘
                 ├──────────────┐
                 ▼              ▼
           ┌───────────┐  ┌───────────┐
           │ STOPPING  │  │  EXPIRED  │
           └───────────┘  └───────────┘
```

### 4.1 State Definitions
* **Active States (`isActive = true`)**: `PENDING`, `FETCHING`, `BUILDING`, `STARTING`, `RUNNING`, `STOPPING`.
* **Terminal States (`isActive = false`)**: `STOPPED`, `FAILED`, `EXPIRED`.

### 4.2 Atomic Transition Guarantee
Transitions are executed conditionally:
```javascript
const result = await client.previewSession.updateMany({
  where: {
    id: sessionId,
    status: expectedCurrentStatus, // Optimistic concurrency check
  },
  data: updatePayload,
});
if (result.count === 0) {
  throw new SessionTransitionConflictError(sessionId, expectedCurrentStatus);
}
```
If two processes concurrently attempt to transition the same session, exactly one succeeds and the other receives a `409 Conflict` error.

---

## 5. Expiration & Timeout Semantics

GitView enforces a clear distinction between hard session lifetimes and idle timeouts:

| Type | Duration | Reference | Behavior |
| :--- | :--- | :--- | :--- |
| **Hard Ceiling** (`expiresAt`) | 60 minutes | `createdAt + 1 hour` | Fixed maximum container runtime. Session is unconditionally terminated regardless of user activity. |
| **Idle Timeout** (`lastActiveAt`) | 15 minutes | `lastActiveAt + 15 min` | Dynamic timeout updated whenever HTTP traffic or WebSocket pings flow through the reverse proxy. |

Indexes `[isActive, expiresAt]` and `[isActive, lastActiveAt]` allow future background cleanup workers to query expired sessions efficiently without table scans.

---

## 6. Client Sanitization & Information Hiding

`sanitizeSessionForClient(session)` strips internal infrastructure fields before serialization:
* **Exposed**: `id`, `repositoryId`, `status`, `framework`, `isActive`, `commitSha`, `branch`, `createdAt`, `startedAt`, `stoppedAt`, `expiresAt`, `lastActiveAt`, `errorCode`, `errorMessage`.
* **Hidden (Never returned to client)**: `runnerContainerId`, `proxyContainerId`, `proxyInstanceId`, `proxyPort`, `tokenHash`, `previewTokenEnc`.

---

## 7. Passive Project Detection Engine (Milestone 4)

The detection engine (`detector.js` and `detectorAdapter.js`) evaluates imported repositories to determine if they match an approved executable MVP preview profile.

### 7.1 Non-Execution Guarantee
Detection is **strictly passive**. The engine:
* Never executes `package.json` scripts (`scripts.dev`, `scripts.start`, `scripts.build`, `scripts.postinstall`, etc.).
* Never runs `npm install`, `npm ci`, or package managers.
* Never imports or executes untrusted project JavaScript or TypeScript files.
* Never invokes `vite.config.js` or build tools.
* Never spawns Docker containers.

### 7.2 Approved MVP Profiles

#### Profile A: `STATIC`
* Root-level `index.html`.
* Pure static HTML, CSS, client-side JavaScript, and assets.
* No `package.json` with build dependencies or backend libraries.
* Served directly by `/usr/local/bin/gitview-serve.js`.

#### Profile B: `VITE_FRONTEND`
* Root-level `index.html`.
* Recognized `vite` dependency in `package.json` (`dependencies` or `devDependencies`).
* Supported npm lockfile (`package-lock.json`) present at repository root.
* Variants:
  * `REACT`: Contains `react`, `react-dom`, or `@vitejs/plugin-react`.
  * `VANILLA`: No React or fullstack dependencies.

### 7.3 Rejection Rules & Reason Codes

| Reason Code | Condition | User-Facing Message |
| :--- | :--- | :--- |
| `EMPTY_REPOSITORY` | Repository root is empty or inaccessible | The repository is empty. |
| `MISSING_INDEX_HTML` | Root `index.html` is absent | Root index.html is required for live application preview. |
| `PACKAGE_JSON_OVERSIZED` | `package.json` exceeds 256 KB | package.json exceeds maximum allowed size limit of 256 KB. |
| `PACKAGE_JSON_INVALID` | Malformed JSON or non-object root | package.json contains invalid JSON syntax. |
| `MONOREPO_UNSUPPORTED` | Workspaces configured (`package.json#workspaces`, `pnpm-workspace.yaml`, `lerna.json`) | Monorepo and workspace repositories are not supported in MVP. |
| `BACKEND_PROJECT_UNSUPPORTED` | Server runtime detected (Express, Fastify, Nest, Koa, Socket.io) | Backend applications are not supported in the live preview engine. |
| `CRA_UNSUPPORTED` | Create React App (`react-scripts`) | Create React App (react-scripts) is not supported. Please use Vite React. |
| `NEXTJS_UNSUPPORTED` | Next.js detected (`next`) | Next.js applications require a full Node.js server runtime and are not supported in MVP. |
| `NUXT_UNSUPPORTED` | Nuxt detected (`nuxt`) | Nuxt applications are not supported in MVP. |
| `ASTRO_UNSUPPORTED` | Astro detected (`astro`) | Astro applications are not supported in MVP. |
| `REMIX_UNSUPPORTED` | Remix detected (`@remix-run/react`) | Remix applications are not supported in MVP. |
| `GATSBY_UNSUPPORTED` | Gatsby detected (`gatsby`) | Gatsby applications are not supported in MVP. |
| `BUNDLER_UNSUPPORTED` | Webpack or Parcel detected | Webpack/Parcel bundlers are not supported. Only Vite is supported in MVP. |
| `REACT_WITHOUT_VITE` | React present without Vite | React projects without Vite are not supported in MVP. Vite is required. |
| `LOCKFILE_REQUIRED` | Vite project missing lockfile | This repository does not contain a supported npm lockfile (package-lock.json). |
| `LOCKFILE_UNSUPPORTED` | Yarn (`yarn.lock`), pnpm (`pnpm-lock.yaml`), or Bun (`bun.lockb`) lockfile | Only npm (package-lock.json) is supported in the initial preview engine. |
| `UNSUPPORTED_PROJECT_STRUCTURE` | Arbitrary dependencies without supported build tool | This project specifies dependencies but does not include a supported build tool (Vite). |

### 7.4 Framework Enum Reconciliation (Milestone 4.1)

The PostgreSQL enum `FrameworkType` defined in `schema.prisma` is:
```prisma
enum FrameworkType {
  STATIC
  VITE_REACT
  VITE_VANILLA
  REACT
  UNKNOWN
}
```

* **Semantics of `UNKNOWN` vs `UNSUPPORTED`**:
  * In the detection response, `supported: false` with `framework: "UNSUPPORTED"` explicitly identifies an unexecutable project with a descriptive `reasonCode`.
  * In the database, `UNKNOWN` is reserved exclusively for unclassified or genuinely undetected sessions prior to project evaluation.
* **`REACT` Enum Value**:
  * Standalone `REACT` is **never** classified as executable by the detector. React projects without Vite fail detection with `REACT_WITHOUT_VITE`.
* **Exact Mapping Function (`mapDetectorResultToPrismaFramework`)**:
  * `STATIC` -> Prisma `FrameworkType.STATIC`
  * `VITE_FRONTEND` (variant: `REACT`) -> Prisma `FrameworkType.VITE_REACT`
  * `VITE_FRONTEND` (variant: `VANILLA`) -> Prisma `FrameworkType.VITE_VANILLA`
  * Unsupported / Invalid -> `FrameworkType.UNKNOWN`
* **Additive Migration (`20261118175320_add_vite_vanilla_framework`)**:
  ```sql
  -- AlterEnum
  ALTER TYPE "FrameworkType" ADD VALUE 'VITE_VANILLA';
  ```
  *Impact*: Non-breaking additive PostgreSQL enum alteration. All existing records and enum values are 100% preserved.

---

## 8. Secure Repository Extraction Pipeline (Milestone 5)

Milestone 5 implements a streaming archive download and safe in-container extraction pipeline:
`GitHub Repository + Exact Commit SHA -> Stream Compressed Archive -> Meter Stream -> Disposable Extractor Container -> Validate Tar Entries -> Populate Per-Session Named Volume -> Report Result`.

### 8.1 Architecture & Security Controls

```
               [GitHub REST API]
                      │
           (HTTP 302 Redirect to CDN)
                      │
                      ▼
         [archiveFetcher.js (Host Node.js)]
           - Validates owner, repo, 40-char SHA
           - Whitelists redirect host (*.github.com, *.githubusercontent.com)
           - Strips Authorization header off api.github.com
           - Streams & meters incoming bytes (max 25 MB)
                      │
                      ▼ (Stream piped via stdin)
         [Disposable Extractor Container]
           - Image: gitview-preview-extractor:v1.0.0
           - Isolation: --network none, --read-only, --cap-drop ALL
           - Privilege: UID 10001:10001, no-new-privileges:true
           - Resources: --memory 256m, --pids-limit 64, --cpus 1.0
           - Volume: gitview-vol-${sessionId} mounted to /workspace
                      │
                      ▼
         [gitview-extract.js (/usr/local/bin)]
           - Streaming gunzip -> tar-stream
           - Discovers and strips top-level GitHub prefix
           - Validates entry paths (max 500 chars, no .., no %2e, no /)
           - Rejects unsafe entries (symlinks, hardlinks, devices, fifos)
           - Rejects duplicate entries & file/directory conflicts
           - Excludes sensitive files (.env, .npmrc, .git, node_modules)
           - Sanitizes file permissions (dirs 0755, files 0644)
           - Enforces limits (max 2,000 entries, max 100 MB uncompressed)
           - Rolls back and purges /workspace on any error
```

### 8.2 Sensitive File Exclusion Policy

Untrusted repositories frequently contain accidentally committed environment secrets, private registry tokens, or local dependencies. The extractor enforces an exclusion policy:
- `.env` and `.env.*` (e.g. `.env.local`, `.env.production`)
- `.npmrc` (npm authentication and registry tokens)
- `.git` and `.git/**` (Git internals and repository history)
- `node_modules` and `node_modules/**` (untrusted pre-packaged dependencies)

Excluded files are recorded in `excludedFiles`, skipped during extraction, and never written to the destination volume.

### 8.3 Error Codes & Mapping

All extraction errors extend `AppError` via `ArchiveExtractionError`:
* `ARCHIVE_DOWNLOAD_FAILED`: GitHub API network failure, 401/404, or unapproved redirect target.
* `ARCHIVE_TOO_LARGE`: Compressed archive stream exceeds 25 MB limit.
* `ARCHIVE_TIMEOUT`: Download or in-container extraction exceeds execution timeout.
* `ARCHIVE_CORRUPTED`: Malformed gzip or truncated tar stream.
* `ARCHIVE_PATH_TRAVERSAL`: Path traversal (`..`, `%2e`, null bytes, absolute paths, path length > 500 chars).
* `ARCHIVE_UNSAFE_ENTRY`: Symlinks, hardlinks, character/block devices, fifos, duplicate entries, file/directory conflicts.
* `ARCHIVE_ENTRY_LIMIT_EXCEEDED`: Archive exceeds 2,000 entry limit.
* `ARCHIVE_UNCOMPRESSED_LIMIT_EXCEEDED`: Total uncompressed bytes exceed 100 MB.
* `ARCHIVE_EXTRACTION_FAILED`: Filesystem I/O error or abnormal container exit.

### 8.4 Security Audit & Hardening (Milestone 5.1)

1. **Exact Redirect Allowlisting & Protocol Lockdown**:
   - `APPROVED_REDIRECT_HOSTNAMES`: Exactly restricted to `codeload.github.com`, `api.github.com`, and `objects.githubusercontent.com`. No naive suffix or regex matching.
   - Rejects non-HTTPS protocols (`http:`).
   - Rejects deceptive userinfo (e.g. `codeload.github.com@attacker.example`).
   - Rejects unexpected ports (e.g. `:8443`, `:80`).
   - Limits redirects to maximum 3 hops.
   - `Authorization: Bearer` headers are strictly stripped when leaving `api.github.com`.
2. **Decompressed Byte Accounting on Excluded Entries**:
   - Decompressed bytes from excluded files (`.git/`, `node_modules/`, `.env*`) are metered chunk-by-chunk in the stream.
   - Rejects archives where total decompressed bytes exceed the limit (100 MB), preventing decompression bomb attacks hidden in excluded directories.
3. **Deterministic `tar-stream` Runtime Resolution**:
   - Image includes symlink `/node_modules -> /usr/local/lib/node_modules`.
   - Script implements explicit path fallback `/usr/local/lib/node_modules/tar-stream`.
   - Verified under `env -i /usr/local/bin/node` with empty environment and without `NODE_PATH`.
4. **Volume Cleanup & Cross-Session Isolation**:
   - `removeSessionVolume(volumeName)` securely deletes session volume on failed/abandoned extraction.
   - Guaranteed isolation: tearing down Session A's volume never affects Session B.
5. **Live Public GitHub Smoke Test**:
   - Empirically verified against public repository `octocat/Spoon-Knife` at pinned commit SHA `d0dd1f61b33d64e29d8bc1372a94ef6a2fee76a9`.
   - Verified HTTP 302 redirect to `codeload.github.com`, bounded stream, unprivileged extraction, root prefix stripping (`octocat-Spoon-Knife-d0dd1f6/`), presence of `index.html`, `styles.css`, `README.md`, and clean teardown.

---

## 9. Verification Results

All 212 backend tests, 14 Docker extractor verification tests, live GitHub smoke test, 12 runner container checks, and 5 Docker acceptance tests pass with zero failures:

```
Test Suites: 15 passed (15)
Tests:       212 passed (212)
Duration:    5.04s

✓ tests/archiveExtraction.test.js (48 tests)
✓ tests/detector.test.js (21 tests)
✓ tests/detectorAdapter.test.js (4 tests)
✓ tests/previewLifecycle.test.js (21 tests)
✓ tests/previewTokens.test.js (10 tests)
✓ tests/explorer.test.js (15 tests)
✓ tests/refresh.test.js (17 tests)
✓ tests/repositories.test.js (16 tests)
✓ tests/authorization.test.js (12 tests)
✓ tests/register.test.js (16 tests)
✓ tests/githubOAuth.test.js (11 tests)
✓ tests/rateLimit.test.js (1 test)
✓ tests/login.test.js (6 tests)
✓ tests/errors.test.js (6 tests)
✓ tests/encryption.test.js (8 tests)
```

* **Live GitHub Smoke Test (`server/docker/smoke-test-live-github.sh`)**: 7/7 PASS (Real GitHub extraction).
* **Extractor Verification Suite (`server/docker/verify-extractor.sh`)**: 14/14 PASS.
* **Runner Verification Suite (`server/docker/verify-runner.sh`)**: 12/12 PASS.
* **Docker Acceptance Suite (`server/docker/acceptance-tests/run-all.sh`)**: 5/5 PASS.

---

## 10. Milestone 6: Lockfile Validation Engine (`lockfileValidator.js`)

Task 1 of Milestone 6 implements a deterministic, passive validator for npm `package-lock.json` files prior to dependency installation or container builder execution.

### 10.1 Validation Rules & Policy Enforcements
1. **Size Limits**: Maximum lockfile size is 1 MB (`1024 * 1024` bytes). Oversized files return `LOCKFILE_TOO_LARGE`.
2. **Version Whitelist**: Only npm lockfile versions 2 and 3 are supported. Version 1, 4+, or string versions return `LOCKFILE_UNSUPPORTED_VERSION`.
3. **Safe Parsing & Nesting Depth**: Pre-scans raw JSON in O(N) linear time to enforce a maximum nesting depth of 32 (`LOCKFILE_NESTING_EXCEEDED`), preventing stack-overflow or recursion attacks during `JSON.parse`.
4. **Package Count Ceiling**: Limits total package declarations to 5,000 (`LOCKFILE_PACKAGE_LIMIT_EXCEEDED`).
5. **Exact Hostname Allowlisting**: Requires `https://registry.npmjs.org` exclusively (`LOCKFILE_UNAPPROVED_HOST` / `LOCKFILE_INSECURE_URL_SCHEME`). Disallows embedded URL credentials (`LOCKFILE_URL_CREDENTIALS_DISALLOWED`) and non-standard ports.
6. **Supply Chain Source Boundaries**:
   - Rejects all Git dependencies (`git://`, `git+ssh://`, `git+https://`, `github:`, `gitlab:`, `bitbucket:`, `gist:`) -> `LOCKFILE_GIT_DEPENDENCY_DISALLOWED`.
   - Rejects local dependencies (`file:`, `link:`, `link: true`) -> `LOCKFILE_LOCAL_DEPENDENCY_DISALLOWED`.
7. **Integrity Verification**:
   - Enforces presence of integrity hashes for all external packages (`LOCKFILE_MISSING_INTEGRITY`).
   - Validates Subresource Integrity (SRI) format and algorithms (`sha512`, `sha384`, `sha256`, `sha1`) with strict base64 character set and digest length verification (`LOCKFILE_INVALID_INTEGRITY`).
8. **Passive Execution**: The validator is completely isolated from network interfaces, filesystem side-effects, and child processes. Package scripts (`preinstall`, `postinstall`) are never executed.

### 10.2 Test Verification
All 58 unit and security tests pass in `server/tests/lockfileValidator.test.js`:
- Valid lockfile v2 (with nested dependencies tree) and v3.
- Real `server/package-lock.json` validation.
- Oversized lockfiles, package ceiling breaches, and excessive JSON nesting.
- Malformed, empty, and truncated inputs.
- HTTP and unapproved host rejections (subdomain spoofing, non-standard ports, evil hosts).
- Git schemes and shorthands, local file and link dependencies.
- URL credential injection.
- SRI integrity verification (valid sha512/sha1/sha256 vs invalid/unapproved md5/malformed digests).
- Passive execution verification spying on `child_process.exec`, `spawn`, `execFile`, `http.request`, `https.request`, and `globalThis.fetch`.

---

## 11. Milestone 6: Docker CLI Adapter & Security Hardening (`dockerAdapter.js`)

Tasks 2 and 2.1 of Milestone 6 implement a secure, profile-governed Docker CLI adapter for backend orchestration of GitView-owned Docker resources.

### 11.1 Security Boundaries & Defenses
1. **Explicit Spawn Execution**: Executes commands strictly via `spawn('docker', args, { shell: false })`. Internal command execution is private to the adapter.
2. **Immutable Image Allowlist**:
   - Strictly restricted to validated immutable images:
     - `gitview-preview-runner:v1.0.0`
     - `gitview-preview-extractor:v1.0.0`
     - Pinned image digests (`@sha256:...`)
   - Mutable tags (`:latest`, `:edge`, `:main`, `:master`, unversioned) and unknown images are rejected with `DOCKER_SECURITY_POLICY_VIOLATION`.
   - Builder and egress-proxy images remain unlisted until implemented and verified in Task 3.
3. **Role-Specific Container Profiles**:
   Caller cannot pass arbitrary Docker commands, flag arrays, or untrusted environment objects. Container execution is governed strictly by approved profiles:
   - `STATIC_RUNNER`: Serves static assets read-only from `/workspace` or `/app/workspace` (`gitview-ws-${sessionId}:ro`) on an internal preview network with UID 10001, `no-new-privileges`, `cap-drop=ALL`, memory 512M, CPU 1.0, PID 64.
   - `VITE_RUNNER`: Executes Vite dev server with read-write caching (`gitview-ws-${sessionId}:rw`) on an internal preview network.
   - `EXTRACTOR`: Unpacks tar archives into `/workspace` with `--network none` (zero network interfaces).
   - `TRUSTED_PROXY`: Dual-attached trusted reverse proxy (ingress bridge + internal preview) with dynamic port publishing strictly to loopback `127.0.0.1::8080`.
   - `NPM_BUILDER` & `EGRESS_PROXY`: Profile definitions defined; execution gated behind Task 3.
4. **Network Attachment Enforcement**:
   - `RUNNER`: Permitted strictly on internal preview networks (`Internal === true`). External network attachments are rejected.
   - `BUILDER`: Permitted strictly on internal build networks (`Internal === true`).
   - `EXTRACTOR`: Permitted zero network attachments (`mode: 'none'`).
   - `TRUSTED_PROXY`: Permitted attachment to dual networks: ingress bridge (external loopback publishing) and internal preview network.
   - Cross-session network attachment is rejected via session label validation.
5. **Port Publishing Policy**:
   - Only `TRUSTED_PROXY` may publish ports.
   - Host binding must be strictly `127.0.0.1`. Wildcard `0.0.0.0` exposure is rejected.
   - Port publishing is strictly forbidden on runner, extractor, and builder profiles.
6. **Mandatory Resource Labeling**:
   Every GitView-created container, network, and volume carries:
   - `com.gitview.managed=true`
   - `com.gitview.session-id=<validated-uuid>`
   - `com.gitview.role=<approved-role>` (`runner`, `proxy`, `builder`, `build-proxy`, `extractor`)
   - `com.gitview.created-at=<iso-timestamp>`
7. **Session-Scoped Idempotent Cleanup**:
   Queries and removes only resources matching both `com.gitview.managed=true` AND `com.gitview.session-id=${sessionId}`. Unrelated resources and other sessions are completely untouched. Resource removal is idempotent (non-existent resources do not throw).
8. **Process Management & Output Sanitization**:
   Supports command timeouts, `AbortSignal`, bounded buffer capture (max 1 MB), and automatic redaction of GitHub and Bearer tokens in logs and errors (`sanitizeOutput`).

### 11.2 Verification Results
- **Unit Test Suite (`server/tests/dockerAdapter.test.js`)**: 66/66 tests pass.
- **Live Integration Verification (`server/docker/verify-docker-adapter.sh`)**: 11/11 checks pass against local Docker Desktop engine:
  - Internal network creation with `--internal` and labels.
  - Bridge network creation with labels.
  - Named volume creation with labels.
  - Security policy blocking RUNNER from external bridge network.
  - Security policy blocking arbitrary command injection.
  - Hardened STATIC_RUNNER startup with `gitview-preview-runner:v1.0.0`.
  - TRUSTED_PROXY startup with dual network attachments and loopback publishing.
  - Dynamic published port discovery (`127.0.0.1::PORT`).
  - Container security verification (`no-new-privileges`, `cap-drop ALL`, user `10001:10001`).
  - Scoped session cleanup (removing exact containers, dual networks, and volume).
  - Idempotent cleanup on already-purged session.

---

## 12. Milestone 6, Task 3 & 3.1: Dual-Network npm Egress Proxy & Builder Orchestration

Tasks 3 and 3.1 integrate the isolated dependency-installation topology into `dockerAdapter.js` and provide an empirically verified execution environment for untrusted Vite repositories.

### 12.1 Approved Images & Inspected Identities
1. **Approved Images**:
   - `gitview-preview-runner:v1.0.0`
   - `gitview-preview-extractor:v1.0.0`
   - `gitview-preview-builder:v1.0.0` (`sha256:0c3497ec6b7dad5cdda3d61e43740efae439d97d5db5293bcfda52f3748dea60`)
   - `gitview-npm-egress-proxy:v1.0.0` (`sha256:cf280d9008cae9456666413556796542709c3fb27d0e97bb97d5d81662671b1c`)
   - Third-party digests (`@sha256:...`)
2. **Container Profiles**:
   - `NPM_BUILDER`:
     - Image: `gitview-preview-builder:v1.0.0`
     - Network: Attached **strictly** to internal network (`gitview-build-int-${SESSION_ID}`).
     - Resources: Memory 1024m, CPU 1.0, PID limit 128.
     - Security: `--read-only`, `--cap-drop ALL`, `no-new-privileges`, UID 10001:10001.
     - Tmpfs: `/tmp` (256m) and `/home/gitview/.npm` (256m).
     - Environment: `HTTP_PROXY`, `HTTPS_PROXY`, `npm_config_proxy`, `npm_config_https_proxy` pointing strictly to `http://${proxyName}:3128`.
   - `EGRESS_PROXY`:
     - Image: `gitview-npm-egress-proxy:v1.0.0`
     - Network: Dual-attached (internal build network + external egress network with `--gw-priority 1`).
     - Resources: Memory 256m, CPU 0.5, PID limit 64.
     - Security: `--read-only`, `--cap-drop ALL`, `no-new-privileges`, UID 10001:10001.
     - Port publishing: None (internal service port 3128 only).

### 12.2 Kernel Routing Table & Gateway Inspection
`dockerAdapter.js` adds methods for validating proxy gateway routing:
- `getContainerRoutes(containerName)`: Executes `ip route` within the target container and parses kernel routing entries.
- `verifyProxyDefaultGateway(containerName, expectedGatewayIp)`: Validates that the default gateway in the proxy container points exclusively to the external egress bridge network (`default via <gateway>`).

### 12.3 Task 3.1 Targeted Verification Defenses
1. **Explicit IPv4 Policy**: The proxy enforces IPv4-only outbound traffic. All IPv6 literals, IPv4-mapped IPv6, and malformed IP strings are rejected. Zero AAAA DNS lookups exist.
2. **TLS ClientHello SNI Verification**: Plaintext ClientHello preamble inspection ensures that CONNECT destination and TLS SNI agree (`registry.npmjs.org`). Mismatches cause immediate connection termination before any outbound TCP socket is opened. Encrypted ClientHello (ECH) fails closed if unapproved.
3. **Controlled DNS Resolver & Anti-Rebinding**: Outbound TCP sockets are pinned to pre-validated literal IPv4 addresses. Rebind lookups returning private/metadata addresses are rejected with zero TCP attempts to blocked addresses. Mixed public/private DNS answers fail closed.
4. **Shared Aggregate Transfer Budget**: 150 MB shared limit across all active tunnels with bidirectional (upload + download) byte metering. Sockets are destroyed immediately upon breach, and new tunnels are rejected with `HTTP 509 Bandwidth Limit Exceeded`.
5. **Realistic Vite Dependency Installations**:
   - `vite-vanilla` (pinned `vite@5.4.14`): 11 packages installed in ~835ms (workspace size 20 MB).
   - `vite-react` (`vite@5.4.14` + `react@18.3.1` + `react-dom@18.3.1` + `@vitejs/plugin-react@4.3.4`): 62 packages installed in ~1s (workspace size 42 MB).

### 12.4 Task 3.2 Targeted Verification & Policy Correction
1. **Unconditional ECH Rejection**:
   - Every ClientHello bearing TLS extension `0xfe0d` (Encrypted ClientHello) is rejected unconditionally upfront.
   - Rejected even when the outer SNI matches `registry.npmjs.org`, because ECH encrypts `ClientHelloInner` containing the true destination SNI.
   - Zero decryption attempts and zero TLS MITM are performed.
   - Rejected immediately before opening any outbound TCP socket (zero upstream connection attempts).
   - Logged with bounded reason code `ECH_UNSUPPORTED`.
   - Architectural status: ECH is unsupported in MVP.
2. **Authoritative IANA IPv4 Destination Classification (RFC 6890)**:
   - Strict canonical dotted-decimal regex parsing (`/^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/`).
   - Rejects non-canonical representations (octal e.g. `0177.0.0.1`, leading zeros e.g. `127.000.000.001`, hex e.g. `0x7f.0.0.1`, dword e.g. `2130706433`, whitespace, and trailing dots).
   - Rejects all IPv6 literals, IPv4-mapped IPv6 (`::ffff:...`), and malformed strings (enforcing an IPv4-only policy with zero AAAA DNS lookups).
   - Accurately checks all RFC 6890 non-globally reachable allocations (`0.0.0.0/8`, RFC 1918, `100.64.0.0/10`, `127.0.0.0/8`, `169.254.0.0/16`, `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`, `198.18.0.0/15`, `192.88.99.0/24`, multicast `224.0.0.0/4`, reserved `240.0.0.0/4`, limited broadcast `255.255.255.255/32`).
   - Correctly implements official IANA IPv4 Special-Purpose Address Registry specifications for `192.0.0.0/24` (Task 3.3):
     - `192.0.0.9/32` (PCP Anycast, RFC 7723): Globally Reachable = True (Accepted)
     - `192.0.0.10/32` (TURN Anycast, RFC 8155): Globally Reachable = True (Accepted)
     - `192.0.0.170/32` (NAT64/DNS64 Discovery, RFC 7050): Globally Reachable = False (Rejected)
     - `192.0.0.171/32` (NAT64/DNS64 Discovery, RFC 8880): Globally Reachable = False (Rejected)
     - Remainder of `192.0.0.0/24` (e.g. `192.0.0.1`, `192.0.0.8`, `192.0.0.200`): Globally Reachable = False (Rejected)
   - Properly verifies globally reachable special-purpose prefixes: `192.31.196.0/24` (AS112-v4), `192.52.193.0/24` (AMT), `192.175.48.0/24` (AS112 Direct Delegation) are accepted.
3. **Canonical 300 MB Workspace-Size Ceiling Alignment**:
   - Reconciled all documentation, builder environment variables, and acceptance scripts to the canonical **300 MB** limit.
   - Implemented active periodic polling (1 Hz) in `gitview-build.js` alongside post-build inspection, terminating builds immediately upon quota breach (`SIGTERM` followed by `SIGKILL` if unhandled).
   - Documented that active polling and post-build inspection enforce a defense-in-depth monitored ceiling, not an instantaneous hard filesystem quota (given overlayfs on macOS virtiofs does not support directory project quotas).

### 12.5 Empirical Verification Summary
- **Backend Test Suite (`npm --prefix server test`)**: 367/367 tests pass across 18 test files (including 31/31 in `egressProxy.test.js`).
- **Docker Adapter Live Verification (`server/docker/verify-docker-adapter.sh`)**: 11/11 checks pass.
- **Master Acceptance Test Suite (`server/docker/acceptance-tests/run-all.sh`)**: 6/6 test suites pass (including all 21 checks in `test-6-builder-egress-isolation.sh`).

---

## 13. Phase 5 — Milestone 6, Task 4: PreviewManager Orchestration Engine

### 13.1 Architecture & Pipeline Overview
`server/src/modules/preview/previewManager.js` serves as the central orchestration service connecting the end-to-end live preview pipeline. It encapsulates all domain operations while preserving strict security boundaries:
1. **Server-Side Verification & Pinning**:
   - Validates repository ownership against the authenticated user (`prisma.repository.findFirst({ where: { id, userId } })`).
   - Retrieves GitHub OAuth access tokens internally from `OAuthAccount` (AES-256-GCM decrypted on backend, never exposed to frontend).
   - Resolves and pins commit references server-side into exact 40-character hexadecimal SHAs (`isValidCommitSha`).
2. **Concurrency Ceiling**:
   - Enforces the MVP rule of max 1 active preview session per user (`getActiveSessionForUser`). Concurrent starts reject with `ActiveSessionConflictError` (HTTP 409).
3. **Passive Framework Detection**:
   - Executes metadata detection (`detectorAdapter.js`) against the remote GitHub repository at the exact commit SHA without cloning.
   - Maps detected profiles to `FrameworkType` (`STATIC`, `VITE_VANILLA`, `VITE_REACT`).
4. **Isolated Workspaces & Networks**:
   - Creates per-session internal preview network (`gitview-net-${sessionId}`).
   - Creates per-session named workspace volume (`gitview-ws-${sessionId}`).
   - Streams bounded archive from GitHub API and extracts via disposable extractor container (`gitview-preview-extractor:v1.0.0`) with `--network none`, `--read-only`, and non-root UID 10001.
5. **Deterministic Lockfile Validation**:
   - For Vite projects, reads `package-lock.json` directly from the named volume using isolated runner execution (`dockerAdapter.readVolumeFile`).
   - Runs `LockfileValidator.validate` (1 MB size limit, 5,000 package ceiling, HTTPS-only `registry.npmjs.org`, zero git/file dependencies, valid SRI integrity hashes).
   - Verifies consistency between detected framework and lockfile dependency tree (`verifyLockfileFrameworkConsistency`).
6. **Dual-Network Dependency Installation (Vite Projects)**:
   - Sets session status: `FETCHING` -> `BUILDING`.
   - Provisions internal build bridge network (`gitview-build-int-${sessionId}`, `--internal`) and external egress network (`gitview-build-egress-${sessionId}`).
   - Spawns `gitview-npm-egress-proxy:v1.0.0` dual-attached, with `--gw-priority 1` on egress network. Verifies default gateway kernel routing.
   - Spawns `gitview-preview-builder:v1.0.0` connected strictly to internal build network (zero external egress). Runs `gitview-build.js` enforcing `npm ci --ignore-scripts --no-audit --no-fund` within 90s deadline and 300 MB monitored ceiling.
   - Verifies `/workspace/node_modules/.bin/vite` executable exists in volume (`dockerAdapter.verifyVolumeExecutable`).
   - Destroys builder container, egress proxy container, and build networks immediately after installation.
7. **Hardened Runtime Startup & Option A Proxy**:
   - Sets session status: `STARTING`.
   - Spawns runner container:
     - `STATIC_RUNNER`: runs `gitview-serve.js` with volume mounted read-only (`ro`) at `/workspace`.
     - `VITE_RUNNER`: runs project-local `/workspace/node_modules/.bin/vite --host 0.0.0.0 --port 3000 --strictPort /workspace` with volume mounted read-write (`rw`) for cache, UID 10001 non-root, `--read-only` root, `cap-drop ALL`, `no-new-privileges`.
   - Spawns `TRUSTED_PROXY` sidecar attached to ingress bridge network (`gitview-ingress-net-${sessionId}`) and internal preview network (`gitview-net-${sessionId}`).
   - Publishes proxy port strictly on `127.0.0.1::8080`.
   - Option A proxy forwards `Host: localhost:3000` to runner, fully compliant with Vite's built-in dev server host-authorization and DNS rebinding protections (independent of CVE-2024-45812, which pertains to DOM clobbering in bundle outputs).
8. **Health Checks & Readiness**:
   - Verifies runner and proxy container states (`State.Running === true`).
   - Verifies loopback binding (`127.0.0.1`).
   - Actively polls `http://127.0.0.1:${port}/` for HTTP 200/HTML within 30s deadline.
   - Transitions to `RUNNING`.
9. **Failure Recovery, Cancellation & Reconciliation**:
   - Cancellation at any point triggers idempotent `docker.cleanupSession(sessionId)` and transitions state to `STOPPED` (releasing user active slot).
   - Any pipeline failure records bounded error codes and transitions state to `FAILED`.
   - Startup reconciliation (`reconcileStaleSessions`) expires sessions past TTL, detects crashed runner containers, and prunes orphaned Docker resources without touching active sessions.

### 13.2 Empirical Verification Results
- **Full Backend Test Suite (`npm --prefix server test`)**: 396/396 tests passed across 19 test files (including 21/21 in `previewManager.test.js` and 74/74 in `dockerAdapter.test.js`).
- **Live Integration Demonstrations (`server/docker/verify-preview-manager.sh`)**:
  - `[DEMONSTRATION 1/3] STATIC`: Reached `RUNNING`, loopback port bound to `127.0.0.1:54586`, HTTP GET returned 200 with HTML fixture, stopped and cleaned up idempotently.
  - `[DEMONSTRATION 2/3] VITE_VANILLA`: Dual-network dependency installation succeeded through egress proxy, project-local Vite CLI started, reached `RUNNING`, loopback port bound to `127.0.0.1:54603`, HTTP GET returned 200 with Vite HTML, stopped and cleaned up idempotently.
  - `[DEMONSTRATION 3/3] VITE_REACT`: Dependency installation with React + `@vitejs/plugin-react` succeeded, local Vite dev server started, reached `RUNNING`, loopback port bound to `127.0.0.1:54623`, HTTP GET returned 200 with React HTML, stopped and cleaned up idempotently.
- **Docker Adapter Live Verification (`server/docker/verify-docker-adapter.sh`)**: 11/11 live security checks passed.
- **Master Acceptance Test Suite (`server/docker/acceptance-tests/run-all.sh`)**: 6/6 master acceptance suites passed.

---

## 14. Phase 5 — Milestone 6, Task 5: Synthetic End-to-End Acceptance & Hardening

### 14.1 Objective & Architecture Overview
Task 5 demonstrates the final backend orchestration acceptance and hardening of the complete GitView preview pipeline across three supported profiles: `STATIC`, `VITE_VANILLA`, and `VITE_REACT`.

Pipeline execution spans:
Repository metadata → passive detection → synthetic archive fixture retrieval → secure unprivileged extraction → lockfile validation & framework consistency verification → dual-network dependency installation (for Vite) → runner startup with UID 10001 → Option A proxy sidecar forwarding → HTTP readiness and WebSocket upgrade verification → `RUNNING`, followed by clean shutdown to `STOPPED` and idempotent resource release.

### 14.2 Functional End-to-End Acceptance

#### 1. STATIC Profile
- Valid synthetic repository with exact commit SHA recorded in PostgreSQL.
- Extracted into named workspace volume `gitview-ws-${sessionId}` with non-root UID 10001 permissions.
- Zero npm builder or egress proxy containers created.
- Static runner started as UID 10001:10001 with workspace volume mounted strictly read-only (`ro`).
- Option A proxy sidecar forwards HTTP requests:
  - Root HTML (`GET /`): HTTP 200 OK (`text/html`).
  - CSS asset (`GET /style.css`): HTTP 200 OK (`text/css`).
  - JS asset (`GET /app.js`): HTTP 200 OK (`application/javascript`).
  - SVG image asset (`GET /logo.svg`): HTTP 200 OK (`image/svg+xml`).
  - SPA client-side fallback route (`GET /dashboard`): HTTP 200 OK (`text/html`, `X-GitView-Fallback: SPA`).
- Transitions to `RUNNING` and stops cleanly to `STOPPED`, pruning all session resources.

#### 2. VITE_VANILLA Profile
- Lockfile validation succeeds (`package-lock.json` versions 2/3, HTTPS-only `registry.npmjs.org`, zero git/file dependencies).
- Dependencies installed inside dual-network topology (`gitview-build-int-${sessionId}` internal + `gitview-build-egress-${sessionId}` egress).
- Egress proxy restricts outbound CONNECT to `registry.npmjs.org:443`, verifying TLS SNI and unconditionally rejecting ECH (`0xfe0d`).
- Lifecycle scripts suppressed via `--ignore-scripts`.
- Builder container and build networks destroyed immediately upon completion.
- Local Vite executable `/workspace/node_modules/.bin/vite` verified with `test -x`.
- Runtime runner attached exclusively to internal preview network (no external route).
- Option A proxy sidecar forwards:
  - Root HTML (`GET /`): HTTP 200 OK.
  - Vite client runtime (`GET /@vite/client`): HTTP 200 OK.
  - Main application module (`GET /main.js`): HTTP 200 OK.
  - Vite HMR RFC 6455 WebSocket Upgrade (`GET /` with `Upgrade: websocket`): HTTP 101 Switching Protocols.
- Transitions to `RUNNING` and stops cleanly to `STOPPED`, pruning all session resources.

#### 3. VITE_REACT Profile
- Same workflow as Vite Vanilla with complete React dependency resolution.
- Workspace contains `react@18.3.1`, `react-dom@18.3.1`, and `@vitejs/plugin-react@4.3.4`.
- Option A proxy sidecar forwards:
  - Root HTML (`GET /`): HTTP 200 OK.
  - Vite client runtime (`GET /@vite/client`): HTTP 200 OK.
  - Transformed React JSX module (`GET /src/main.jsx`): HTTP 200 OK with transpiled React runtime imports.
  - Vite HMR RFC 6455 WebSocket Upgrade (`GET /` with `Upgrade: websocket`): HTTP 101 Switching Protocols.
- Transitions to `RUNNING` and stops cleanly to `STOPPED`, pruning all session resources.

### 14.3 HTTP and WebSocket Forwarding Verification
The Option A proxy sidecar (`dockerAdapter.js`) forwards all incoming HTTP requests and WebSocket Upgrade handshakes to the upstream runner container:
1. **Host Header Rewriting**: Rewrites `Host: localhost:${port}` on both HTTP requests and RFC 6455 WebSocket upgrades. This complies with Vite v5.4.14 host authorization checks (`server.allowedHosts` / localhost defense against DNS rebinding).
2. **WebSocket Upgrade Forwarding**: Intercepts the HTTP `upgrade` event on the proxy HTTP server, forwards complete client handshake headers (`Sec-WebSocket-Key`, `Sec-WebSocket-Version: 13`, `Sec-WebSocket-Protocol`, etc.) with rewritten `Host`, establishes a raw duplex TCP tunnel to upstream runner port 3000, and returns `HTTP 101 Switching Protocols` to the client.

### 14.4 Lifecycle Cancellation & Concurrency Verification
All cancellation and concurrency scenarios are verified using controlled synchronization gates rather than sleeps:
- **Cancellation during PENDING**: Aborts before extraction/detection, releases user slot immediately, status `STOPPED`, `isActive: false`.
- **Cancellation during FETCHING**: Aborts archive stream, prunes partial workspace volume, transitions `STOPPING` -> `STOPPED`, `isActive: false`.
- **Cancellation during BUILDING**: Aborts builder container, prunes dual build networks and egress proxy, transitions `STOPPING` -> `STOPPED`, `isActive: false`.
- **Cancellation during STARTING**: Aborts runner and proxy startup, cleans networks, transitions `STOPPING` -> `STOPPED`, `isActive: false`.
- **Two simultaneous starts for the same user**: First session creates active row in DB; second caller is rejected with `ActiveSessionConflictError` (HTTP 409).
- **Concurrent start and stop**: Calling `stopPreviewSession` while startup is in flight aborts startup operation via `AbortSignal`, cleanly transitions session to `STOPPED`, and destroys all partial resources.
- **Duplicate stop requests**: Completely idempotent; returns sanitized `STOPPED` session DTO with zero errors.
- **Race conditions**: Races between health check completion and cancellation, or between builder completion and cancellation, cleanly yield terminal `STOPPED` state with zero leaking containers, networks, or volumes.

### 14.5 Failure-Injection Matrix (16 Failure Modes)
Every failure mode is verified to produce a bounded error code, terminal database status `FAILED`, release the active slot (`isActive: false`), destroy all partial Docker resources, and leave other sessions untouched:

| # | Failure Injection Mode | Injected Condition | Resulting Error Code | Terminal Status | Resource Cleanup | Cross-Session Isolation |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | GitHub archive download failure | Rate limit or 502 from GitHub API | `ARCHIVE_FETCH_FAILED` | `FAILED` | Volume/Network pruned | Untouched |
| 2 | Corrupted archive payload | Truncated tar stream | `ARCHIVE_CORRUPT` | `FAILED` | Volume/Network pruned | Untouched |
| 3 | Unsafe archive entry | Path traversal / symlink in tar | `ARCHIVE_UNSAFE_ENTRY` | `FAILED` | Volume/Network pruned | Untouched |
| 4 | Missing package-lock.json | Lockfile absent in Vite repository | `LOCKFILE_MISSING_PACKAGES` | `FAILED` | Volume/Network pruned | Untouched |
| 5 | Invalid lockfile | Unsupported version (v1) / invalid JSON | `LOCKFILE_UNSUPPORTED_VERSION` | `FAILED` | Volume/Network pruned | Untouched |
| 6 | Rejected registry URL | Lockfile references non-npmjs host | `LOCKFILE_UNAPPROVED_HOST` | `FAILED` | Volume/Network pruned | Untouched |
| 7 | npm egress proxy startup failure | Proxy port collision or bind failure | `DOCKER_CONTAINER_START_FAILED` | `FAILED` | Build networks/containers pruned | Untouched |
| 8 | Builder timeout (>90s) | Dependency install exceeds deadline | `BUILD_TIMEOUT` | `FAILED` | Builder/proxy/nets pruned | Untouched |
| 9 | npm lifecycle script attempt | Postinstall script fails or exit non-zero | `BUILD_FAILED` | `FAILED` | Builder/proxy/nets pruned | Untouched |
| 10 | Workspace size ceiling exceeded | Monitored workspace quota exceeds 300 MB | `WORKSPACE_LIMIT_EXCEEDED` | `FAILED` | Builder/proxy/nets pruned | Untouched |
| 11 | Missing Vite executable | `node_modules/.bin/vite` missing | `MISSING_VITE_EXECUTABLE` | `FAILED` | All resources pruned | Untouched |
| 12 | Runner container crash | Runner exits unexpectedly (exit 137) | `CONTAINER_CRASHED` | `FAILED` | Runner/proxy/nets pruned | Untouched |
| 13 | Proxy sidecar startup failure | Proxy container fails to start | `DOCKER_CONTAINER_START_FAILED` | `FAILED` | All resources pruned | Untouched |
| 14 | Invalid proxy port binding | Host port not found or not 127.0.0.1 | `DOCKER_PORT_BIND_FAILED` | `FAILED` | All resources pruned | Untouched |
| 15 | HTTP health-check timeout | Readiness probe fails within 30s | `HEALTH_CHECK_TIMEOUT` | `FAILED` | All resources pruned | Untouched |
| 16 | Docker daemon communication failure | Docker socket unresponsive | `DOCKER_DAEMON_COMMUNICATION_ERROR` | `FAILED` | Resources pruned, slot freed | Untouched |

### 14.6 Backend Restart & Stale Session Reconciliation
`PreviewManager.reconcileStaleSessions()` executes safe reconciliation on backend startup:
1. **TTL-Expired Sessions**: Identifies active sessions where `expiresAt <= now` or `lastActiveAt <= idleCutoff`. Cleans up Docker resources, marks session `EXPIRED`, and releases user slot.
2. **Crashed Runner Containers**: Identifies active `RUNNING` sessions whose runner container is dead (`Running: false` or missing). Cleans up resources, marks session `FAILED` with `errorCode: 'CONTAINER_CRASHED'`, and releases user slot.
3. **Safe Resource Pruning**: Inspects Docker containers, networks, and volumes bearing `gitview-` labels. Prunes orphaned resources whose session ID does not match any active DB session, while strictly preserving active, healthy sessions and never executing global pruning.
4. **Immediate Subsequent Session Creation**: Verifies that once a stale session is reconciled, the user can immediately create and start a new session without slot contention.

### 14.7 Documentation Correction: CVE-2024-45812
- **Accurate Scope**: CVE-2024-45812 relates specifically to DOM clobbering vulnerabilities in certain bundled output formats (specifically when browser global variables override bundled script properties).
- **Vite Host Header Forwarding Rationale**: In contrast, Vite's dev server Host header blocking (`server.allowedHosts`) is a native defense against DNS rebinding and host-header injection attacks in local development environments. The Option A proxy rewrites `Host: localhost:${port}` to satisfy this check, and this mechanism is documented independently of CVE-2024-45812.

### 14.8 Separated Test Count Reporting
In strict compliance with Milestone 6 reporting standards, test counts are categorized separately:

| Category | Suite / Script | Test Count | Status | Description |
| :--- | :--- | :--- | :--- | :--- |
| **Unit & In-Memory Integration** | `npm --prefix server test` (18 files) | **403 tests** | **PASS** | Lockfile validator, crypto, detector, Docker adapter unit, session service, egress proxy unit |
| **Database Integration** | `server/tests/previewLifecycle.test.js` | **21 tests** | **PASS** | State machine transitions, PostgreSQL partial unique index, concurrency ceiling |
| **PreviewManager Orchestration** | `server/tests/previewManager.test.js` | **49 tests** | **PASS** | Cancellation gates, concurrency races, 16-point failure injection, restart reconciliation |
| **Live Docker Adapter Verification** | `server/docker/verify-docker-adapter.sh` | **11 checks** | **PASS** | Typed Docker methods, labels, UID 10001, loopback publishing, session cleanup |
| **Master Docker Acceptance Suites** | `server/docker/acceptance-tests/run-all.sh` | **6 suites (21 egress checks)** | **PASS** | Ports, UID, networks, resource limits, Option A proxy, dual-network egress isolation |
| **Full Preview Demonstrations** | `server/docker/verify-preview-manager.sh` | **4 demonstrations** | **PASS** | STATIC assets & SPA, VITE_VANILLA modules & WS 101, VITE_REACT JSX & WS 101, Crash reconciliation |






---

## 15. Milestone 7, Task 1: Public Preview API Routes & CSRF Controller

### 15.1 Component Architecture & Route Mounting
Milestone 7 Task 1 implements the authenticated public REST API routes for preview lifecycle management and secure CSRF verification, mounted under `/api/v1/previews`:

* **`server/src/modules/preview/preview.routes.js`**: Express router mounting endpoints with `authenticate`, `previewCsrf`, `validateHostHeader`, per-user rate limiters, and Zod input validation.
* **`server/src/modules/preview/previewController.js`**: Controller delegating lifecycle actions strictly to `previewManager` and returning client-sanitized DTOs. Controllers contain zero Prisma queries or lifecycle state transitions.
* **`server/src/middleware/previewCsrf.js`**: Middleware enforcing duplicate Host header detection, exact Origin allowlisting against `env.FRONTEND_URL`, WHATWG Referer fallback, and `Content-Type: application/json` on mutating requests.
* **`server/src/modules/preview/preview.schemas.js`**: Zod validation schemas for request bodies and parameter parsing.

### 15.2 Public Endpoints Matrix

| Method | Endpoint | Description | Rate Limit | Request Body | Response Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `POST` | `/api/v1/previews` | Starts a new live preview session. | 5 req / min / user | `{ repositoryId, commitRef }` | `201 Created` |
| `GET` | `/api/v1/previews/:id` | Polls session lifecycle state. | 60 req / min / user | None | `200 OK` |
| `POST` | `/api/v1/previews/:id/stop`| Gracefully stops an active preview. | 10 req / min / user | None | `200 OK` |

### 15.3 CSRF & Host Authority Verification
1. **Host Header Integrity (`validateHostHeader`)**:
   - Inspects `req.rawHeaders` to count occurrences of the `Host` header.
   - Detects and rejects duplicate `Host` headers or comma-separated host syntax with `HTTP 400 Bad Request` (`DUPLICATE_HOST_HEADER`).
   - Mitigates HTTP request smuggling and Host header spoofing before request parsing.
2. **Exact Origin Allowlisting**:
   - Compares incoming `Origin` header against `new URL(env.FRONTEND_URL).origin` using strict string equality.
   - Forbids wildcards (`*`), domain suffixes, and subdomain overrides.
   - Rejects missing or mismatched Origins with `HTTP 403 Forbidden` (`CSRF_ORIGIN_INVALID`).
3. **WHATWG Referer Fallback**:
   - When the `Origin` header is omitted by the browser, parses `req.headers.referer` using WHATWG `new URL(referer).origin`.
   - Rejects missing, malformed, or mismatched referrers with `HTTP 403 Forbidden` (`CSRF_ORIGIN_INVALID`).
4. **Mutating Request Content-Type Enforcement**:
   - All state-changing requests (`POST`) must declare `Content-Type: application/json`.
   - Requests with missing or non-JSON content types are rejected with `HTTP 400 Bad Request` (`INVALID_CONTENT_TYPE`).

### 15.4 Information Leakage Prevention & Sanitization
All API responses strictly invoke `sanitizeSessionForClient()` before transmitting JSON to the client. Responses contain exclusively:
- `id`, `repositoryId`, `status`, `framework`, `isActive`, `commitSha`, `branch`, `createdAt`, `startedAt`, `stoppedAt`, `expiresAt`, `lastActiveAt`, `errorCode`, `errorMessage`.

The following sensitive internal attributes are strictly barred from API serialization:
- `rawToken`, `tokenHash`, `previewTokenEnc`, `runnerContainerId`, `proxyContainerId`, `proxyPort`, `dockerNetwork`, `workspacePath`, `previewUrl`.

### 15.5 Test Suite Coverage (`server/tests/previewRoutes.test.js`)
Comprehensive API integration tests verify:
- 401 on unauthenticated or forged token access.
- 403 on missing, mismatched, or malformed Origin and Referer headers.
- 400 on non-JSON content types, duplicate Host headers, and Zod validation errors.
- 201 on successful preview initiation with sanitized DTO.
- 409 on concurrent active session conflict (concurrency ceiling).
- 404 on repository ownership mismatch or cross-user status lookup.
- 200 on status retrieval and idempotent stop operations.
- Per-user rate limiting quotas (5 req/min create, 60 req/min status, 10 req/min stop, 10 req/min ticket).
- Real PostgreSQL database state updates.

---

## 16. Milestone 7, Task 2: Redis Ticket Registry & Secure Browser Bootstrap

### 16.1 Component Architecture & Workflow

Milestone 7 Task 2 implements the single-use ticket registry, canonical WHATWG host authority validation, state-changing ticket issuance, and the secure browser bootstrap redemption flow:

```
[ Frontend Client ]                                      [ Gateway Edge ]                                [ Storage / DB ]
        │                                                        │                                               │
        │ 1. POST /api/v1/previews/:id/ticket (mode: iframe)    │                                               │
        ├───────────────────────────────────────────────────────►│                                               │
        │                                                        │ 2. Validates session is RUNNING & owned       │
        │                                                        │ 3. Generates 32-byte rawTicket                │
        │                                                        │ 4. Computes targetOrigin & host authority     │
        │                                                        │ 5. Stores SHA-256(ticket) with 30s TTL ──────►│ [Redis / MemStore]
        │ 6. Returns { previewUrl, targetOrigin, ticketExpiresAt}│                                               │
        │◄───────────────────────────────────────────────────────┤                                               │
        │                                                        │                                               │
        │ 7. Browser Navigates: GET /__gitview_bootstrap?ticket= │                                               │
        ├───────────────────────────────────────────────────────►│                                               │
        │                                                        │ 8. Atomically consumes via Lua script ───────►│ [Redis GETDEL]
        │                                                        │    (Preserves ticket on Host mismatch)        │
        │                                                        │ 9. Canonical verifyHostAuthority()            │
        │                                                        │ 10. Recovers encrypted token from DB ─────────►│ [PostgreSQL]
        │                                                        │ 11. Sets __Host- partitioned cookie           │
        │ 12. HTTP 302 Found (Empty body: 0 bytes, Location: /)  │                                               │
        │◄───────────────────────────────────────────────────────┤                                               │
```

### 16.2 Implemented Components

* **`server/src/modules/preview/ticketStore.js`**:
  - `ITicketStore`: Common abstract interface (`setTicket`, `consumeTicket`, `clear`, `close`).
  - `validateSessionExpiresAtMs(exp)`: Helper validating that session expiry is a positive safe integer Unix timestamp in milliseconds (`Number.isSafeInteger(exp) && exp > 0`). Rejects missing, null, string, fractional, negative, zero, and excessively large values (> `Number.MAX_SAFE_INTEGER`).
  - `RedisTicketStore`: Production store wrapping `ioredis`. Keys formatted as `preview:ticket:${sha256(ticket)}` with strict 30s TTL. Uses an atomic fail-closed Lua script enforcing strict metadata validation:
    - `NOT_FOUND` on missing key.
    - `INVALID_METADATA` on invalid JSON, missing `sessionId`, `targetOrigin`, `targetHostAuthority`, invalid or non-safe-integer `sessionExpiresAtMs`, or invalid `mode` (preserves key without deleting).
    - `HOST_MISMATCH` on missing `expectedHost` or authority mismatch (preserves key without deleting).
    - Atomically calls `DEL` and returns metadata JSON only upon full validation pass.
    - Fails closed with 500 `REDIS_ERROR` if Redis connection fails; never silently falls back to MemoryTicketStore.
  - `MemoryTicketStore`: In-memory `Map` store for local single-process development and unit testing with identical fail-closed metadata checks and timer-based TTL cleanup.
  - `createTicketStore()` & `getTicketStore()`: Environment-driven factory enforcing Redis requirement in production.
* **`server/src/modules/preview/hostAuthority.js`**:
  - `canonicalizeHostAuthority(hostOrUrl, defaultProtocol)`: Normalizes authorities to `${lowercase_hostname}:${explicit_numeric_port}` enforcing WHATWG effective-port equivalence (e.g. HTTPS without port equals `:443`, HTTP without port equals `:80`). Handles IPv6 bracketed literals.
  - `verifyHostAuthority(incomingHostHeader, expectedTargetOrigin)`: Canonical WHATWG Host normalization algorithm matching §3.3. Rejects user credentials (`@`), path separators, malformed characters, duplicate headers, and non-matching ports.
  - `getPreviewTargetOrigin(sessionId, options)`: Server-authoritative origin resolution supporting custom base URLs, dedicated preview domains, and local `*.preview.localhost:PORT`.
* **`server/src/modules/preview/previewCookie.js`**:
  - `setPreviewCookie(res, rawToken, remainingLifetimeSeconds)`: Injects RFC 6265bis `__Host-gitview-preview-token` with `Path=/`, `Secure`, `HttpOnly`, `SameSite=None`, and `Partitioned` (CHIPS). Strictly omits `Domain`. Max-Age is capped at remaining session lifetime (max 3600s).
  - `clearPreviewCookie(res)`: Purges the cookie.
* **`server/src/modules/preview/previewBootstrap.controller.js`**:
  - `validateBootstrapHost(req)`: Inspects `req.rawHeaders` directly before touching the ticket store. Requires exactly one Host header, rejecting missing Host (`MISSING_HOST_HEADER`) and duplicate or comma-separated Host headers (`DUPLICATE_HOST_HEADER`).
  - `handleBootstrap`: Handles `GET /__gitview_bootstrap?ticket=...`. Validates ticket format (64 hex characters), consumes atomically from ticket store using canonical authority, verifies `PreviewSession` status (`RUNNING`, active, unexpired), decrypts token server-side (`recoverSessionToken`), issues partitioned cookie, injects defensive headers (`Cache-Control: no-store`, `Referrer-Policy: no-referrer`), and returns immediate HTTP 302 redirect with 0 bytes.
* **`server/src/app.js`**:
  - Custom Morgan `:url` token redacting sensitive `?ticket=[^&]+` parameters to `?ticket=[REDACTED]`.
  - Mounts root-level `GET /__gitview_bootstrap`.
* **`server/src/modules/preview/previewController.js` & `preview.routes.js`**:
  - Mounts `POST /api/v1/previews/:id/ticket` with `previewCsrf`, `previewTicketLimiter` (10 req/min/user), and body validation (`createTicketSchema`). Returns `{ previewUrl, targetOrigin, ticketExpiresAt }` with `Cache-Control: no-store`.

### 16.3 Verification Suites
- **`tests/previewTicketStore.test.js`** (40 tests): Cryptographic hashing, `validateSessionExpiresAtMs` validation, memory store fail-closed validation, live Redis 7 Lua fail-closed script tests (all error codes and key preservation across missing, null, string, fractional, negative, zero, excessively large, and valid integer sessionExpiresAtMs variants), Redis outage fail-closed behavior, and factory injection.
- **`tests/hostAuthority.test.js`** (28 tests): Canonical WHATWG Host authority positive and negative acceptance matrix (§12.1 Tier 1) and `canonicalizeHostAuthority()` effective-port equivalence tests.
- **`tests/previewBootstrap.test.js`** (12 tests): Complete browser bootstrap redemption flow, 302 redirect, 0-byte body, `__Host-` cookie attributes, replayed ticket rejection, DB session verification, raw TCP duplicate Host rejection with unconsumed ticket preservation, missing Host rejection, comma-separated Host rejection, HTTPS port equivalence, and Redis outage fail-closed behavior.
- **`tests/previewRoutes.test.js`** (48 tests): End-to-end API testing including `POST /api/v1/previews/:id/ticket` and Redis outage fail-closed handling during ticket issuance.

---

## 17. Milestone 7, Task 3: Production HTTP Preview Gateway

### 17.1 Component Architecture & Workflow

Milestone 7 Task 3 implements the dedicated, production-grade streaming HTTP reverse proxy gateway (`server/src/modules/preview/previewGateway.js`) conforming strictly to `MILESTONE_7_ARCHITECTURE.md` §5. The gateway serves as the primary ingress controller for all authenticated browser preview requests on the dedicated preview domain:

```
[ Browser / Iframe Client ]
           │
           │ 1. GET http://<sessionId>.preview.localhost:3000/
           │    Host: <sessionId>.preview.localhost:3000
           │    Cookie: __Host-gitview-preview-token=<rawToken>; app_theme=dark
           ▼
[ Preview Gateway Edge Middleware (app.js) ]
           │
           ├─► 2. validateHostHeader(req) (Raw socket headers checked: single Host, no @ credentials, no comma)
           ├─► 3. isCandidatePreviewRequest(req) (Identifies <sessionId>.preview.localhost subdomain)
           ├─► 4. verifyHostAuthority(Host, expectedOrigin) (Strict WHATWG canonical comparison matching §3.3)
           ├─► 5. extractPreviewToken(req) & hash SHA-256 (Constant-time tokenHash computation)
           │
           ├─► 6. Token Cache Lookup ────────────────────────────────────────┐
           │      [SessionValidationCache] (10s TTL, max 500 entries)        │
           │      ├─ Cache Hit ──► Validates status=RUNNING, isActive=true   │
           │      └─ Cache Miss ─► Prisma Query: findUnique({ tokenHash }) ──┘
           │
           ├─► 7. Session Rate Limiter (180 req/min, burst 300)
           ├─► 8. Debounced lastActiveAt Activity Heartbeat (at most once every 30s)
           │
           │ 9. Request Header Sanitization & Upstream Forwarding:
           │    - Rewrite Host: localhost:${session.proxyPort}
           │    - Strip Hop-by-Hop headers (Connection, Upgrade, Keep-Alive, TE, etc.)
           │    - Strip untrusted forwarding headers (X-Forwarded-*, Forwarded)
           │    - Reconstruct verified X-Forwarded-For, X-Forwarded-Proto, X-Forwarded-Host
           │    - Strip __Host-gitview-preview-token, access_token, refresh_token, Authorization
           │    - Preserve client application cookies (e.g. app_theme=dark)
           ▼
[ Trusted Reverse-Proxy Sidecar (127.0.0.1:${session.proxyPort}) ]
           │
           ▼
[ Isolated Preview Runner (UID 10001, internal network) ]
           │
           │ 10. Upstream Response Streaming:
           │     - Stream response chunks with native backpressure
           │     - Strip hop-by-hop headers from upstream response
           │     - Enforce 10 MB maximum body meter and 16 KB header bounds
           │     - Enforce 5s connect timeout and 60s idle timeout
           ▼
[ Client Browser Receives Response (HTTP 200 OK + Streamed Payload) ]
```

### 17.2 Host Header Validation & Candidate Identification

* **`validateHostHeader(req)`**:
  - Direct inspection of `req.rawHeaders` to count Host occurrences before any body or router middleware.
  - Rejects missing Host headers with `HTTP 400 Bad Request` (`MISSING_HOST_HEADER`).
  - Rejects duplicate Host headers with `HTTP 400 Bad Request` (`DUPLICATE_HOST_HEADER`).
  - Rejects comma-separated Host headers (`DUPLICATE_HOST_HEADER`).
  - Rejects credentials (`@`), path separators (`/`, `\`), and whitespace (`HOST_AUTHORITY_MALFORMED`).
* **`extractPreviewHostInfo(hostHeader, options)`**:
  - Parses host authority into hostname and port, supporting IPv6 bracketed literals (`[::1]:PORT`).
  - Extracts the candidate UUID session ID prefix from `<sessionId>.preview.localhost` or `<sessionId>.${PREVIEW_DOMAIN}`.
  - Rejects non-UUID subdomains and apex preview domain without subdomains (`UNKNOWN_PREVIEW_HOST`).
* **`verifyHostAuthority(incomingHost, expectedOrigin)`**:
  - Enforces canonical WHATWG comparison against the server-generated `targetOrigin` (§3.3).
  - Rejects port mismatches or cross-host hijacking attempts with `HTTP 401 Unauthorized` (`HOST_AUTHORITY_MISMATCH`).

### 17.3 Bounded In-Memory LRU Cache (`SessionValidationCache`)

To prevent database connection pool starvation from high-frequency subresource bursts (e.g. Vite loading 100+ modules simultaneously), the gateway implements a strictly bounded in-memory LRU cache:
* **Max Capacity**: 500 entries (least recently used entries evicted when full).
* **TTL**: 10 seconds (guarantees revocation or session state transitions propagate within at most 10 seconds).
* **Key Hashing**: Indexed strictly by `SHA-256(rawToken)` — raw capability tokens are **never** stored in the cache.
* **Hard Session Expiry Precedence**: Cached entries are checked against `expiresAtMs <= Date.now()`. Hard expiry always takes precedence over cache hits, evicting the entry and returning `HTTP 410 SESSION_EXPIRED`.
* **Proactive Invalidation**: `invalidateSessionGatewayCache(sessionId)` evicts cached sessions immediately when stopped, cancelled, failed, or expired.

### 17.4 Streaming Reverse Proxy (`forwardHttpPreviewRequest`)

* **Fixed Upstream Loopback Routing**: Routes exclusively to `http://127.0.0.1:${session.proxyPort}` (Option A trusted proxy sidecar).
* **Host Rewriting**: Rewrites the upstream Host header to `localhost:${session.proxyPort}` to satisfy runner and sidecar authority requirements.
* **Streaming & Backpressure**: Streams request bodies and upstream responses using native Node.js stream piping (`req.pipe(proxyReq)` and `proxyRes.pipe(res)`), ensuring constant memory consumption even during multi-megabyte transfers.
* **Cumulative Body Meter**: Enforces a strict 10 MB maximum request body limit on both Content-Length declarations and chunked streaming requests.
* **Header Size Limit**: Enforces a strict 16 KB maximum header size limit (`REQUEST_HEADER_FIELDS_TOO_LARGE`).
* **Timeouts**: 5s connect timeout and 60s socket idle timeout, returning `HTTP 504 GATEWAY_TIMEOUT` if the upstream sidecar becomes unresponsive.
* **Client Disconnect Handling**: Listens to `res.on('close')` to destroy upstream proxy requests if the browser aborts the request before completion.

### 17.5 Header Sanitization & Credential Stripping

* **Hop-by-Hop Headers**: Unconditionally removes RFC 2616 / RFC 7230 / RFC 9110 hop-by-hop headers from incoming requests and upstream responses (`connection`, `keep-alive`, `proxy-authenticate`, `proxy-authorization`, `te`, `trailer`, `transfer-encoding`, `upgrade`, plus any headers named in the `Connection` header).
* **Forwarded Headers**: Strips all untrusted incoming `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto`, `X-Forwarded-Port`, and `Forwarded` headers. Reconstructs verified headers from the direct socket address (`req.socket.remoteAddress`) and canonical public host.
* **Cookie Sanitization (`stripAuthCookies`)**: Strips GitView authentication cookies (`__Host-gitview-preview-token`, `access_token`, `refresh_token`) before forwarding, ensuring untrusted repository code never observes GitView tokens. Retains user application cookies (e.g. `theme=dark`, `app_session=123`).
* **Authorization Stripping**: Deletes internal `Authorization` headers before upstream proxying.

### 17.6 Rate Limiting & Activity Heartbeat Debouncing

* **Sliding-Window Session Rate Limiting (`SessionRateLimiter`)**: Limits requests per active preview session to 180 req/min with a maximum burst capacity of 300 requests, returning `HTTP 429 Too Many Requests` (`TOO_MANY_REQUESTS`).
* **Debounced Activity Heartbeat**: To avoid overwhelming PostgreSQL during asset bundling, updates to `lastActiveAt` are throttled to at most once every 30 seconds per session.

### 17.7 Error Mapping & Information Leakage Prevention

The gateway maps failure modes into clean, standard HTTP status codes without leaking internal container IDs, internal ports, or Docker infrastructure details:
* `400 Bad Request`: `MISSING_HOST_HEADER`, `DUPLICATE_HOST_HEADER`, `HOST_AUTHORITY_MALFORMED`, `UNKNOWN_PREVIEW_HOST`.
* `401 Unauthorized`: `TOKEN_MISSING`, `TOKEN_INVALID`, `SESSION_NOT_FOUND`, `SESSION_INACTIVE`, `HOST_AUTHORITY_MISMATCH`.
* `410 Gone`: `SESSION_STOPPED`, `SESSION_EXPIRED`.
* `413 Payload Too Large`: `PAYLOAD_TOO_LARGE` (body exceeds 10 MB).
* `429 Too Many Requests`: `TOO_MANY_REQUESTS` (rate limit exceeded).
* `431 Request Header Fields Too Large`: `REQUEST_HEADER_FIELDS_TOO_LARGE` (headers exceed 16 KB).
* `500 Internal Server Error`: `DB_UNAVAILABLE` (database unreachable during cache miss; fails closed).
* `502 Bad Gateway`: `BAD_GATEWAY` (upstream sidecar connection refused or reset; port unassigned).
* `504 Gateway Timeout`: `GATEWAY_TIMEOUT` (upstream runner unresponsive).

### 17.8 Verification Suites & Test Coverage

* **`server/tests/previewGateway.test.js`** (42 tests):
  - LRU micro-cache TTL, capacity bounds, hard expiry precedence, invalidation, zero plaintext tokens in storage.
  - Auth cookie stripping, multi-cookie preservation, and empty header handling.
  - Host authority validation, duplicate/comma-separated Host rejection, malformed characters, and cross-session token isolation.
  - Request authentication, missing/malformed token rejection, inactive/stopped/expired session handling, and valid 200 OK HTML streaming.
  - Streaming reverse proxying, Host rewriting to `localhost:${proxyPort}`, credential stripping, hop-by-hop stripping, reconstructed X-Forwarded-*, CSS/JS MIME handling, request body piping, 10 MB payload limiting, and 16 KB header limiting.
  - Upstream connection refused/reset recovery (502), upstream timeout (504), fail-closed DB outage on cache miss (500), and resilient LRU cache hit serving during DB outage.
  - Debounced 30s `lastActiveAt` activity tracking.
  - Per-session sliding-window rate limiting (429).
* **`server/docker/verify-preview-gateway.sh`** (Empirical Live Docker Acceptance):
  - End-to-end live HTTP access through the authenticated HTTP gateway for STATIC, VITE_VANILLA, and VITE_REACT preview sessions.
  - Verifies HTTP 200 OK, root HTML delivery, CSS/JS subresource streaming, 401 unauthenticated blocking, and automatic teardown cleanup on the host Docker daemon.

---

## 18. Milestone 7 Task 3.1 & 3.2: HTTP Gateway Security Hardening & Final Verification

Milestone 7 Tasks 3.1 and 3.2 harden the production HTTP Preview Gateway against sidecar port-reassignment races, container substitution, internal address leakage in redirects, reserved cookie overwrite attacks, cross-subdomain cookie leakage, and untrusted forwarded-header spoofing.

### 18.1 Sidecar Identity & Port-Reuse Protection (§1)

When Docker terminates a sidecar container, the published host TCP port is released and may immediately be reallocated to another container (e.g. another preview session's sidecar). To ensure the gateway forwards requests exclusively to the verified container belonging to the active preview session:
* **Pre-Forwarding Verification (`verifySidecarIdentity`)**:
  - Direct Docker API inspection of the expected `proxyContainerId`.
  - Verifies `State.Running === true`.
  - Verifies mandatory labels:
    - `com.gitview.managed === 'true'`
    - `com.gitview.session-id === sessionId`
    - `com.gitview.role === 'proxy'`
  - Verifies published host TCP bindings on `127.0.0.1` match `session.proxyPort`.
  - Rejects stopped, missing, or mismatched containers by failing closed with `HTTP 502 BAD_GATEWAY`.
* **Verification Micro-Cache (`SidecarVerificationCache`)**:
  - Maximum 500 entries with a strict 2-second TTL.
  - Keyed by `${sessionId}:${proxyContainerId}:${proxyPort}`.
  - Instantly invalidated via `invalidateSessionGatewayCache(sessionId)` on session stop, cancel, fail, or expire.
* **Sidecar Port-Reassignment Race & Authenticated Handshake Evaluation**:
  - *The Race Condition*: If Session A's sidecar identity is cached within its 2-second TTL, and Session A's container is destroyed unexpectedly outside the lifecycle API (e.g. kernel OOM-killer or daemon crash), Docker could reassign that exact port to Session B while Session A's cache entry is still live.
  - *The Defense Mechanism*: The gateway includes an unexposed per-session authenticated handshake token (`X-GitView-Sidecar-Token = HMAC-SHA256(sessionId:proxyInstanceId, GITVIEW_SIDECAR_HANDSHAKE_KEY)`) and `X-GitView-Session-Id` on all upstream requests.
  - *Enforcement*: The sidecar proxy inspects the session ID and handshake token. If the incoming request carries Session A's handshake credentials on Session B's sidecar, the sidecar immediately rejects the request with `HTTP 403 Forbidden` (`X-GitView-Handshake-Error: true`) or terminates the socket. Session B's application runner is **never** reached.
  - *Cache Self-Correction*: Upon detecting a 403 handshake error or socket error from the sidecar, the gateway immediately purges the stale cache entry for Session A (`activeSidecarCache.deleteBySessionId(sessionId)`) and returns `HTTP 502 BAD_GATEWAY`. A stale cache entry can therefore never enable cross-session forwarding.

### 18.2 Upstream Location Header Sanitization & Redirect Validation (§2 & §3)

Internal frameworks (e.g. Vite, Express) frequently return redirects referencing internal loopback or Docker hostnames. `sanitizeLocationHeader` safely rewrites or blocks them:
* **Relative Redirects**: Path-absolute (`/dashboard`), document-relative (`../app`, `page.html`), query (`?x=1`), and fragment (`#section`) redirects are preserved unchanged.
* **Internal Loopback & Sidecar Rewriting**: Absolute redirects referencing `localhost:${proxyPort}`, `127.0.0.1:${proxyPort}`, internal Docker hostnames (`gitview-runner-*`), or the explicit session public host are rewritten to the canonical public preview origin (`${expectedTargetOrigin}/path`). Internal ports and loopback IPs are **never** exposed to the browser.
* **Scheme Whitelist & Injection Defense**:
  - Only `http:` and `https:` schemes are accepted.
  - `javascript:`, `data:`, `file:`, `blob:`, and `about:` schemes are strictly rejected with `HTTP 502 BAD_GATEWAY`.
  - Rejects malformed authorities, CRLF injection, control characters, backslashes (`\`), URL credentials (`user:pass@`), and protocol-relative (`//...`) redirects.
* **External Redirect Policy**:
  - Permits legitimate public external URLs (e.g. OAuth redirects to `https://github.com/login/oauth`).
  - Blocks redirects to other preview subdomains (`http://<otherSessionId>.preview.localhost/...`) with `HTTP 502 BAD_GATEWAY`.
  - Blocks redirects to private RFC 1918 subnets (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), loopback (`127.0.0.0/8`, `::1`), and link-local (`169.254.0.0/16`, `fe80::/10`) with `HTTP 502 BAD_GATEWAY`.

### 18.3 Reserved Cookie Protection & Cookie-Domain Threat Model (§2)

* **Reserved Cookie Filtering (`sanitizeUpstreamSetCookie`)**:
  - Strictly rejects upstream attempts to set, overwrite, or manipulate reserved GitView authentication cookies:
    - `__Host-gitview-preview-token`
    - `access_token`
    - `refresh_token`
  - Preserves legitimate application cookies (e.g. `app_session`, `theme`).
  - Unconditionally strips `Domain=...` attributes, enforcing host-only application cookies scoped exclusively to the specific session subdomain (`<sessionId>.preview.localhost`).
  - If an upstream response sets only reserved cookies, the `Set-Cookie` header is deleted entirely so the browser never receives it.
* **Production Cookie Isolation Guarantee & Residual Risks**:
  - **`__Host-` Capability Cookie Isolation (RFC 6265bis §4.1.3.1)**: GitView's core preview capability token is stored in a `__Host-` prefixed cookie. Under RFC 6265bis §4.1.3.1, modern browsers unconditionally reject any `__Host-` cookie that contains a `Domain` attribute, and require `Secure` and `Path=/`. Even in the presence of untrusted JavaScript on sibling subdomains, attacker scripts cannot overwrite or tamper with the `__Host-gitview-preview-token` capability cookie.
  - **Remaining Parent-Domain Cookie Risk**: Untrusted client JavaScript running inside an iframe can set non-`__Host-` parent-domain cookies (`document.cookie = "...; Domain=preview.localhost"` or `Domain=gitview-preview.com`) unless the domain is registered on the Mozilla Public Suffix List (PSL). Full sibling cookie isolation cannot be claimed until PSL registration or per-preview registrable-domain (eTLD+1) protection is verified.
  - **Opaque-Origin Iframe Trade-off**: An opaque origin (`sandbox` without `allow-same-origin`) provides complete cookie isolation, but breaks modern Single Page Application (SPA) functionality by disabling `localStorage`, `sessionStorage`, `indexedDB`, and Web Workers. GitView therefore maintains same-origin execution while strictly bounding its authentication guarantee to `__Host-` capability cookie isolation.

### 18.4 Trusted Forwarded-Protocol Reconstruction (§4)

* **Direct Socket TLS**: If Node terminates TLS directly (`req.socket.encrypted === true`), `x-forwarded-proto` is unconditionally set to `https`.
* **Explicit Trusted Proxy CIDRs (`trustedProxies` / `TRUSTED_PROXIES`)**:
  - Configurable CIDR list (e.g. `10.0.0.0/8`, `172.16.0.0/12`, `127.0.0.1/32`, `::1/128`).
  - Supports IPv4, IPv6, and IPv4-mapped IPv6 addresses (`normalizeIp`).
  - Strict CIDR parsing (`parseCidr`, `isIpInCidr`) that fails closed on invalid input.
* **Immediate Peer Validation & Single-Scheme Enforcement**:
  - If `req.socket.remoteAddress` is verified against the trusted proxy list, the load balancer is expected to overwrite client-supplied forwarding headers.
  - `X-Forwarded-Proto` must be a single permitted scheme (`'https'` or `'http'`). Comma-separated values (e.g. `'https, http'`) and malformed values (e.g. `'ftp'`, `'//evil'`) are rejected, falling back to safe default `'http'`.
  - If the immediate peer is **not** a trusted proxy, all client-supplied forwarding headers are unconditionally stripped and ignored. Protocol defaults to `http` (or `https` on direct TLS), and client IP is pinned to `req.socket.remoteAddress`.

### 18.5 Unresolved Security Risks

1. **Parent-Domain Cookie Writing (Non-PSL Deployments)**: In environments where the preview apex domain (`gitview-preview.com`) is not registered on the Mozilla Public Suffix List (PSL), client-side JavaScript executing in an iframe on `session-a.gitview-preview.com` can set broad parent-domain cookies (`Domain=gitview-preview.com`). While these cookies cannot tamper with `__Host-gitview-preview-token`, they can be read by `session-b.gitview-preview.com`. Production deployments must register the preview apex on the PSL or allocate isolated random eTLD+1 domains per preview.
2. **Sidecar Process Verification Without Handshake Secret in Legacy Containers**: If an existing runner image is run without sidecar handshake enforcement, a 2-second port-reassignment race window theoretically exists if a container dies unexpectedly and its port is instantly reassigned. Sidecar handshake enforcement (`X-GitView-Sidecar-Token`) eliminates this risk in Milestone 7.
3. **HTTP Cleartext Egress to Sidecar**: Communication between the gateway and the Option A sidecar traverses the host loopback interface (`127.0.0.1`) in cleartext HTTP. While loopback traffic does not leave the host, local root/wheel users with packet capture capabilities can inspect loopback frames. TLS termination directly at the sidecar would resolve this in future enterprise hardening milestones.

---

## 19. Milestone 7 Task 3.3: Sidecar Handshake Key Separation & Header Stripping

Task 3.3 implements strict cryptographic key separation and internal header sanitization for the gateway-to-sidecar authentication channel.

### 19.1 Cryptographic Key Separation

1. **Dedicated Secret (`GITVIEW_SIDECAR_HANDSHAKE_KEY`)**:
   - Distinct from `ENCRYPTION_KEY` (used for GitHub OAuth access tokens).
   - Distinct from `PREVIEW_TOKEN_ENCRYPTION_KEY` (used for capability preview tokens).
   - Validated at startup via Zod refinements in `env.js` (minimum 32 characters, distinct from all other secrets).
2. **Zero Key Reuse**:
   - The preview-token encryption key is never used for sidecar authentication.
   - If `GITVIEW_SIDECAR_HANDSHAKE_KEY` matches `ENCRYPTION_KEY` or `PREVIEW_TOKEN_ENCRYPTION_KEY`, the server fails closed and crashes immediately at startup with an explicit configuration error.

### 19.2 Per-Session Expected Token Provisioning & Zero Master Key Exposure

1. **Gateway Token Formulation**:
   - Token computation preserves HMAC-SHA256 session and proxy container binding:
     $$\text{HandshakeToken} = \text{HMAC-SHA256}_{K_{\text{sidecar}}}(\text{sessionId} \parallel \text{proxyInstanceId})$$
2. **Provisioning Model**:
   - The Gateway / PreviewManager computes the expected handshake token per session and provisions **only** that session-specific expected token (`EXPECTED_HANDSHAKE_TOKEN`) and `SESSION_ID` into the trusted sidecar proxy container environment.
   - The master handshake key `GITVIEW_SIDECAR_HANDSHAKE_KEY` is **never** provided to the sidecar proxy container.
3. **Application Runner Container Isolation**:
   - Neither the master handshake key nor the expected handshake token is ever exposed to application runner containers (`STATIC_RUNNER`, `VITE_RUNNER`, `NPM_BUILDER`).
   - `dockerAdapter.js` strictly restricts runner environment variables to `['NODE_ENV', 'PORT']`.

### 19.3 Constant-Time Comparison (`constantTimeCompare`)

- The trusted sidecar validates incoming `x-gitview-sidecar-token` against `EXPECTED_HANDSHAKE_TOKEN` using `crypto.timingSafeEqual`.
- In `trustedProxy.js`, `constantTimeCompare(a, b)` normalizes execution time by ensuring timing leaks are avoided across mismatched length strings or single-byte changes.
- Mismatched tokens immediately trigger `HTTP 403 Forbidden` with header `X-GitView-Handshake-Error: true`.

### 19.4 Upstream Header Stripping

Before forwarding HTTP requests or WebSocket upgrades to the untrusted application runner container, the trusted sidecar proxy unconditionally strips:
- `x-gitview-session-id`
- `x-gitview-sidecar-token`

Application runners only receive clean application headers with rewritten `host: localhost:${P}`.

---

## 20. Milestone 7 Task 3.4: Final Sidecar Identity Binding Verification

Task 3.4 implements strict cryptographic validation, terminology resolution, and container replacement verification for the trusted sidecar proxy subsystem.

### 20.1 Canonical 64-Character Hexadecimal Key Representation

1. **Entropy & Representation Requirement**:
   - `GITVIEW_SIDECAR_HANDSHAKE_KEY` must be generated from at least 32 cryptographically secure random bytes (256 bits).
   - Validated at startup in `src/config/env.js` via Zod regex:
     ```javascript
     GITVIEW_SIDECAR_HANDSHAKE_KEY: z
       .string()
       .regex(/^[0-9a-fA-F]{64}$/, 'GITVIEW_SIDECAR_HANDSHAKE_KEY must be a 64-character hexadecimal string (32 bytes)')
     ```
2. **Key Separation & Uniqueness**:
   - Validated via refinements to be distinct from `ENCRYPTION_KEY` and `PREVIEW_TOKEN_ENCRYPTION_KEY`.
3. **Zero Secret Printing or Logging**:
   - The handshake key is never logged, printed to console, emitted in test output, or included in client-facing error payloads.

---

## 21. Milestone 7 Task 3.5: Sidecar Identity Naming & Documentation Consistency

Task 3.5 establishes complete architectural separation among the three distinct container and instance identifiers, updates the database schema, and ensures uniform documentation across all preview modules.

### 21.1 Separation of the Three Identifiers

| Identifier | Type | Origin & Lifecycle | Storage & Location | Purpose |
| :--- | :--- | :--- | :--- | :--- |
| **`proxyName`** | `string` | Deterministic resource name (`gitview-proxy-${sessionId}`) | Docker daemon container name | Docker daemon management (`docker run --name`, `stop`, `rm`) |
| **`proxyContainerId`** | `string` | Actual Docker Engine container ID returned by Docker daemon | `PreviewSession.proxyContainerId` | Container inspection (`docker inspect`) and low-level container operations |
| **`proxyInstanceId`** | `UUID` | Cryptographically random immutable UUID generated per instance | `PreviewSession.proxyInstanceId` & `--label com.gitview.sidecar-instance-id` | HMAC-SHA256 handshake token binding and sidecar instance verification |

```
+-----------------------------------------------------------------------------------------+
|                                    Preview Session                                      |
|  - sessionId: <UUID>                                                                    |
|  - proxyName: gitview-proxy-<sessionId>          (Docker Container Name)                |
|  - proxyContainerId: <64-char Hex Docker ID>     (Actual Docker Engine Container ID)    |
|  - proxyInstanceId: <Random Instance UUID>       (Immutable Instance Identity)          |
|                                                                                         |
|  HandshakeToken = HMAC-SHA256(GITVIEW_SIDECAR_HANDSHAKE_KEY, sessionId:proxyInstanceId)  |
+-----------------------------------------------------------------------------------------+
```

### 21.2 Lifecycle and Replacement Guarantees

1. **Independent Instance Generation**:
   - Every time a sidecar is created or replaced—even under the identical `proxyName` and `sessionId`—a fresh `proxyInstanceId` is generated via `crypto.randomUUID()`.
   - The sidecar container is tagged with `--label com.gitview.sidecar-instance-id=${proxyInstanceId}` and provisioned with `SIDECAR_INSTANCE_ID=${proxyInstanceId}`.
2. **Deterministic Inspection via Docker Container ID**:
   - `verifySidecarIdentity` inspects the actual Docker Engine container ID (`proxyContainerId`).
   - Verifies `labels['com.gitview.sidecar-instance-id'] === proxyInstanceId`.
   - If a container is replaced, previous instance tokens are rejected in constant time (`HTTP 403 Forbidden`), and stale gateway cache entries fail closed (`HTTP 502 INSTANCE_ID_MISMATCH`).
3. **Information Hiding**:
   - `sanitizeSessionForClient` strictly omits `proxyContainerId`, `proxyInstanceId`, and `runnerContainerId`. Client DTOs never expose internal identifiers.

### 21.3 Secret Randomness Clarification

The 64-character hexadecimal validation (`/^[0-9a-fA-F]{64}$/`) in `envSchema` strictly guarantees **format and 32-byte length** (256 bits). True **cryptographic randomness and entropy** depend on secure secret generation (e.g. `crypto.randomBytes(32).toString('hex')`) and secure secret provisioning during deployment.

### 21.4 Complete Secret Separation Guarantee

All sidecar HMAC operations throughout the codebase exclusively utilize `GITVIEW_SIDECAR_HANDSHAKE_KEY`. Stale references to `PREVIEW_TOKEN_ENCRYPTION_KEY` have been completely removed. `PREVIEW_TOKEN_ENCRYPTION_KEY` is strictly reserved for AES-256-GCM capability token encryption.

---

## 22. Milestone 7 Task 4: Content Security Policy & Production Security Headers

Architecture Reference: `MILESTONE_7_ARCHITECTURE.md` v1.2 §6

Task 4 establishes server-side generated Content Security Policies (CSP) and defensive HTTP response headers enforced by the Gateway (`previewGateway.js`, `previewCsp.js`, `previewBootstrap.controller.js`).

### 22.1 Architecture & Baseline Invariants

1. **Server-Side Policy Generation**:
   - CSP policies are computed entirely server-side by the Gateway based on the session's verified `framework` and `NODE_ENV`.
   - The Gateway **never** accepts CSP directives or framing origins from client request headers or query parameters.
   - Applied as HTTP response headers (`Content-Security-Policy`), never HTML `<meta>` tags.
2. **Fail-Closed Baseline Directives**:
   - `default-src 'none'`: Unspecified resource types are blocked by default.
   - `object-src 'none'`: Prevents legacy Flash, Java applets, and ActiveX execution.
   - `base-uri 'self'`: Prevents `<base>` tag hijacking and path redirection attacks.
   - `form-action 'self'`: Prevents cross-origin form exfiltration from preview frames.
   - `worker-src 'self' blob:`: Constrains Web Workers to same-origin and blob execution.

### 22.2 Strict Environment-Segregated Framing (`frame-ancestors`)

To prevent cross-environment embedding attacks and clickjacking:
- **Development**: Strictly `frame-ancestors http://localhost:5173;`
- **Production**: Strictly `frame-ancestors https://app.gitview.dev;`
- **Invariable Rule**: Neither development nor production policies ever contain both origins indiscriminately.
- **X-Frame-Options Conflict Resolution**:
  - `X-Frame-Options` is an obsolete header with limited expressiveness that conflicts with W3C `frame-ancestors`.
  - The Gateway unconditionally strips `X-Frame-Options` and `x-frame-options` received from upstream applications (`sanitizeUpstreamHeadersForClient`) to guarantee that `frame-ancestors` retains uncontested framing authority.

### 22.3 Framework-Tailored Policies (STATIC vs. VITE)

| Directive | STATIC (Dev & Prod) | VITE_REACT / VITE_VANILLA (Dev) | VITE_REACT / VITE_VANILLA (Prod) |
| :--- | :--- | :--- | :--- |
| **`default-src`** | `'none'` | `'none'` | `'none'` |
| **`script-src`** | `'self' 'unsafe-inline' https:` | `'self' 'unsafe-inline' 'unsafe-eval' blob: https:` | `'self' 'unsafe-inline' blob: https:` |
| **`style-src`** | `'self' 'unsafe-inline' https:` | `'self' 'unsafe-inline' https:` | `'self' 'unsafe-inline' https:` |
| **`img-src`** | `'self' data: blob: https:` | `'self' data: blob: https:` | `'self' data: blob: https:` |
| **`font-src`** | `'self' data: https:` | `'self' data: https:` | `'self' data: https:` |
| **`connect-src`** | `'self' https:` | `'self' ws: wss: https: blob: data:` | `'self' wss: https: blob: data:` |
| **`worker-src`** | `'self' blob:` | `'self' blob:` | `'self' blob:` |
| **`object-src`** | `'none'` | `'none'` | `'none'` |
| **`base-uri`** | `'self'` | `'self'` | `'self'` |
| **`form-action`** | `'self'` | `'self'` | `'self'` |
| **`frame-ancestors`**| `http://localhost:5173` (dev) / `https://app.gitview.dev` (prod) | `http://localhost:5173` (dev) | `https://app.gitview.dev` (prod) |

- **Vite Dev Capabilities**: Dev policies permit `'unsafe-eval'` (for source maps and Fast Refresh) and `ws:` in `connect-src` (for Vite HMR WebSocket connection).
- **External Asset Restrictions**: External subresources are restricted strictly to secure `https:`, `data:`, and `blob:`. Insecure `http:` URLs are forbidden.

#### 22.3.1 Policy Evaluation: External HTTPS Scheme vs. Exact Host Allowlists

The current preview policy specifies the scheme source `https:` across `script-src`, `style-src`, `img-src`, `font-src`, and `connect-src`. This design has been thoroughly evaluated:

1. **Broad HTTPS Scheme vs. Exact Host Allowlist**:
   - `https:` allows resources and network connections to any arbitrary HTTPS endpoint rather than a fixed set of pre-approved domain names.
   - Restricting `connect-src` to `'self' ws: wss:` or a narrow host allowlist would break a vast category of imported developer projects (e.g., applications fetching public APIs, third-party CDNs, analytics, or external GraphQL endpoints).
2. **Server-Controlled Host Allowlists**:
   - For high-assurance or enterprise multi-tenant deployments, `previewCsp.js` is architected to accept an optional `allowedExternalOrigins` allowlist.
   - However, imposing strict host allowlisting globally would destroy developer preview utility for arbitrary imported Git repositories.
3. **Explicitly Accepted Residual Risk**:
   - Outbound HTTPS network access from the preview iframe is an **explicitly accepted residual risk**.
   - **Defense-in-Depth Mitigations**:
     - The capability authentication token is stored in an `HttpOnly`, `SameSite=None`, `Partitioned`, `Secure` cookie (`__Host-gitview-preview-token`), making it completely inaccessible to JavaScript running in the iframe.
     - `form-action 'self'` blocks cross-origin HTML form POST exfiltration.
     - `object-src 'none'` blocks plugins and Flash exfiltration.
     - `Referrer-Policy: no-referrer` prevents token or URL leakage in external requests.
     - The containerized application runner runs in an isolated network without host egress.

### 22.4 Upstream CSP Conjunction & Combination

- **Conjunction Semantics**: When upstream applications provide their own `Content-Security-Policy` header, the Gateway combines it with GitView's mandatory policy (`combineCspHeaders`).
- **Fail-Closed Intersection**: Under W3C CSP Level 2/3, multiple CSP headers enforce a strict conjunction (AND). Upstream policies can add restrictions (e.g., disallowing `'unsafe-inline'`), but **cannot** weaken Gateway mandatory constraints (e.g., relaxing `object-src 'none'` or changing `frame-ancestors`).
- **CRLF Injection & Sanitization**:
  - `isSafeHeaderValue(val)` validates headers against `\r`, `\n`, and null bytes (`\0`).
  - Malformed or CRLF-injected upstream policies are discarded, protecting the client against HTTP response splitting.

### 22.5 Defensive HTTP Security Headers

Every preview HTTP response issued by the Gateway carries the following defensive headers:
1. `X-Content-Type-Options: nosniff`: Prevents MIME-type sniffing attacks on uploaded or generated files.
2. `Referrer-Policy: no-referrer`: Prevents token, session ID, or path leakage in the `Referer` header to external resources.
3. `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()`: Disables high-risk hardware APIs within the preview iframe.
4. **Content-Aware `Cache-Control`**:
   - **HTML Entrypoint Documents**: `Cache-Control: no-cache, must-revalidate` (guarantees that browser reloads or iframe refreshes fetch the newest container build rather than stale cached HTML).
   - **Static Subresources (CSS, JS, Fonts, Images)**: Preserves legitimate upstream caching headers (`Cache-Control: public, max-age=...`, `ETag`, `Last-Modified`).
   - **Error & Bootstrap Responses**: `Cache-Control: no-store, no-cache, must-revalidate` and `Pragma: no-cache`.

### 22.6 Error Response Hardening

All preview gateway error responses (401, 403, 404, 410, 500, 502, 504) and the bootstrap endpoint (`/__gitview_bootstrap`) unconditionally carry:
- Strict Error CSP (`buildErrorCspPolicy`): `default-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors <origin>;`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: no-referrer`
- `Cache-Control: no-store, no-cache, must-revalidate`

### 22.7 Actual HMR Scope & Architectural Boundary

1. **Task 4 Boundary (CSP Directives Only)**:
   - Task 4 verifies browser CSP permissions for Vite WebSockets (`connect-src 'self' ws: wss: ...` in dev).
   - Task 4 does **not** implement or claim functional bidirectional WebSocket or HMR frame proxying.
2. **Task 5 Responsibility**:
   - The actual HTTP `Upgrade: websocket` gateway listener, ticket exchange on WebSocket handshake, capability token validation, and bidirectional frame streaming to the trusted sidecar proxy remain strictly the responsibility of **Task 5**.

---

## 23. Task 5: Secure WebSocket Gateway & Bidirectional Proxy

Milestone 7 Task 5 implements the production WebSocket upgrade router, bidirectional proxy pipeline, connection lifecycle accounting, and resource guardrails for interactive Vite Hot Module Replacement (HMR) within containerized previews.

```
+--------------------------------------------------------------------------------------------------------+
|                                    PREVIEW WEBSOCKET ARCHITECTURE                                      |
+--------------------------------------------------------------------------------------------------------+
|                                                                                                        |
|  [ Browser / Preview Client ]                                                                          |
|       │  GET / HTTP/1.1                                                                                |
|       │  Host: <session-id>.preview.localhost:3000                                                     |
|       │  Upgrade: websocket                                                                            |
|       │  Connection: Upgrade                                                                           |
|       │  Sec-WebSocket-Key: <base64>                                                                   |
|       │  Sec-WebSocket-Version: 13                                                                     |
|       │  Sec-WebSocket-Protocol: vite-hmr                                                              |
|       │  Origin: http://<session-id>.preview.localhost:3000                                            |
|       │  Cookie: __Host-gitview-preview-token=<64-hex>                                                 |
|       ▼                                                                                                |
|  [ GitView Gateway HTTP Upgrade Listener ] (`previewWebSocket.js` / `server.js`)                       |
|       │                                                                                                |
|       ├─► 1. RFC 6455 Handshake Validation (GET only, Upgrade: websocket, Connection: Upgrade, v13)   |
|       ├─► 2. Host Authority Normalization (`verifyHostAuthority`)                                      |
|       ├─► 3. Strict CSWSH Origin Verification (`verifyWebSocketOrigin` == canonical target origin)    |
|       ├─► 4. Capability Token Authentication (`__Host-` cookie SHA-256 hash lookup)                    |
|       ├─► 5. Session State Invariants (`RUNNING`, `isActive === true`, not expired)                     |
|       ├─► 6. Per-Session Concurrency Limiter (activeSockets < 10; 11th rejected with 429)              |
|       ├─► 7. Upstream Sidecar Container Identity (`verifySidecarIdentity` via Docker engine)          |
|       │                                                                                                |
|       ▼                                                                                                |
|  [ Gateway Upstream Upgrade Request ]                                                                  |
|       │  GET / HTTP/1.1                                                                                |
|       │  Host: localhost:<proxyPort>                                                                   |
|       │  Upgrade: websocket                                                                            |
|       │  Connection: Upgrade                                                                           |
|       │  Sec-WebSocket-Key: <preserved-key>                                                            |
|       │  Sec-WebSocket-Version: 13                                                                     |
|       │  Sec-WebSocket-Protocol: vite-hmr                                                              |
|       │  x-gitview-session-id: <session-id>                                                            |
|       │  x-gitview-sidecar-token: <HMAC-SHA256(GITVIEW_SIDECAR_HANDSHAKE_KEY)>                         |
|       ▼                                                                                                |
|  [ Trusted Proxy Sidecar Container ] (`com.gitview.role=proxy`)                                        |
|       │  - Constant-time HMAC handshake token verification (`verifyHandshake`)                         |
|       │  - Strips x-gitview-session-id and x-gitview-sidecar-token                                      |
|       │  - Sanitizes and rewrites Host to localhost:3000                                               |
|       ▼                                                                                                |
|  [ Application Runner Container ] (`gitview-runner-<session-id>`)                                      |
|       │  - Vite Dev Server (Port 3000) completes HTTP 101 Switching Protocols                          |
|       │  - Emits initial greeting frame: `{"type":"connected"}`                                        |
|       ▼                                                                                                |
|  [ Bounded Bidirectional Frame Proxy Pipeline ]                                                        |
|       │  Client Socket <--- Frame Size Validator (1009 if > 1MB) ---> Upstream Socket                 |
|       │  Transparent pipe with native TCP backpressure, ping/pong forwarding, and clean 1000 close.   |
+--------------------------------------------------------------------------------------------------------+
```

### 23.1 WebSocket Upgrade Handling & RFC 6455 Pipeline

WebSocket upgrade requests are intercepted via native Node.js `server.on('upgrade')` mounted in `server.js` and delegated to `handlePreviewWebSocketUpgrade`:
1. **Method & Protocol Validation**: Enforces HTTP `GET`. Non-GET requests (e.g., `POST` or `CONNECT`) are rejected with `HTTP 405 Method Not Allowed`.
2. **Upgrade & Connection Header Validation**: Requires `Upgrade: websocket` (case-insensitive) and `Connection: Upgrade` (case-insensitive substring). Malformed or missing headers return `HTTP 400 Bad Request`.
3. **Version Enforcement**: Requires `Sec-WebSocket-Version: 13`. Unsupported versions (e.g., version 8) are rejected with `HTTP 426 Upgrade Required` carrying `Sec-WebSocket-Version: 13`.
4. **Key Verification**: `Sec-WebSocket-Key` is validated to be a valid 16-byte base64-encoded string (24 characters ending in `==`). Malformed keys return `HTTP 400 Bad Request`.
5. **Subprotocol Negotiation**: Incoming `Sec-WebSocket-Protocol` (such as `vite-hmr`) is captured and forwarded to upstream, with upstream's accepted subprotocol relayed back to the client in the `101 Switching Protocols` response.

### 23.2 Handshake Authentication & Security Controls

Every WebSocket upgrade request must satisfy five rigorous layers of security before any upstream connection is established:
1. **Host Authority Verification**: The request `Host` header is parsed and validated against the canonical preview origin using WHATWG URL semantics (`verifyHostAuthority`). Requests with missing ports, user credentials, whitespace, or duplicate `Host` headers are rejected with `400` or `403`.
2. **Strict Origin Verification (Anti-CSWSH)**:
   - Browsers unconditionally attach `Origin` to WebSocket upgrade requests.
   - `verifyWebSocketOrigin` enforces that `Origin` must be present and must **strictly equal** the expected canonical preview origin (`http://${session.id}.preview.localhost:${port}`).
   - Missing Origin headers, cross-origin hosts, or attacker origins are rejected with `HTTP 403 Forbidden` (`CSRF_REJECTED`).
3. **Capability Token Authentication**:
   - The capability token is extracted exclusively from the `__Host-gitview-preview-token` cookie.
   - The raw 64-character hexadecimal token is hashed via SHA-256 in constant time (`hashPreviewToken`).
   - Session lookup resolves the session from the LRU cache or PostgreSQL (`prisma.previewSession.findUnique`).
   - Missing cookies or invalid tokens return `HTTP 401 Unauthorized`.
4. **Session State Invariants**:
   - The session must have `status: RUNNING` (stopped/crashed sessions return `HTTP 410 Gone`).
   - The session must have `isActive: true` (inactive sessions return `HTTP 401 Unauthorized`).
   - Hard expiry (`expiresAtMs < now`) returns `HTTP 410 Gone` and triggers immediate session termination.
5. **Sidecar Container Identity Verification**:
   - Resolves the container via Docker Engine inspection (`docker.inspectContainer`).
   - Verifies container state is running (`State.Running === true`).
   - Verifies Docker labels: `com.gitview.managed === true`, `com.gitview.session-id === sessionId`, and `com.gitview.role === 'proxy'`.
   - Verifies `com.gitview.sidecar-instance-id` matches the session's immutable `proxyInstanceId` UUID, preventing sidecar container reuse or stale cache port exploitation. Stale or mismatched containers return `HTTP 502 Bad Gateway`.

### 23.3 Trusted Sidecar Handshake Authentication (Option A)

To protect against dynamic port reuse and unauthorized upstream access:
1. **Secret Key**: Gateway signs a per-session HMAC-SHA256 handshake token using `GITVIEW_SIDECAR_HANDSHAKE_KEY`:
   $$\text{token} = \text{HMAC-SHA256}(\text{key}, \text{sessionId} \mathbin{\Vert} \text{proxyInstanceId})$$
2. **Header Injection**: Gateway attaches `x-gitview-session-id` and `x-gitview-sidecar-token` to the upstream HTTP Upgrade request.
3. **Sidecar Verification**: The trusted sidecar proxy verifies the HMAC token in constant time (`crypto.timingSafeEqual`) against its provisioned environment variable (`GITVIEW_EXPECTED_HANDSHAKE_TOKEN`).
4. **Header Stripping**: The sidecar strips all internal `x-gitview-*` headers before piping the WebSocket stream to the untrusted application runner on port 3000.

### 23.4 Transparent, Bounded Bidirectional Proxying

Once the upstream server returns `HTTP 101 Switching Protocols`:
1. **Handshake Relay**: The gateway writes `HTTP/1.1 101 Switching Protocols` to the client socket, echoing `Upgrade: websocket`, `Connection: Upgrade`, `Sec-WebSocket-Accept: <digest>`, and negotiated `Sec-WebSocket-Protocol`.
2. **Backpressure & Duplex Pipelining**:
   - The client socket and upstream socket are bound using native Node.js streams with automatic flow control and high-watermark buffering.
   - Preserves bidirectional framing across text frames, binary frames, continuation/fragmented frames, and control frames (Ping, Pong, Close).
3. **Normal Close Propagation**: When either endpoint sends an RFC 6455 close frame (opcode 8, e.g. status code 1000), the close frame is proxied to the peer, and sockets are cleanly torn down.

### 23.5 Resource Limits, Abuse Prevention & Lifecycle Management

1. **Concurrency Ceiling**: Enforces a strict limit of **10 concurrent WebSocket connections per preview session**. The 11th connection attempt is immediately rejected with `HTTP 429 Too Many Requests` (`CONCURRENT_WEBSOCKET_LIMIT_EXCEEDED`).
2. **Oversized Frame Protection**: `createFrameSizeValidator` parses incoming frame headers on the fly. If any payload exceeds the configured maximum frame limit (default 1MB), the socket emits an RFC 6455 close frame with status code `1009 Message Too Big` and terminates the connection.
3. **Handshake Timeout**: Upstream connection and upgrade responses are bounded by a 10-second timeout. Handshakes exceeding 10 seconds return `HTTP 504 Gateway Timeout`.
4. **Idle Timeout**: Inactive WebSocket connections with zero traffic for 10 minutes are closed with status code `1000 Normal Closure`.
5. **Immediate Session Termination**: When a preview session transitions to `STOPPED`, `STOPPING`, `FAILED`, or `EXPIRED`, `terminateSessionWebSockets(sessionId)` immediately tears down all active client and upstream sockets belonging to that session.

### 23.6 Unit & Integration Test Inventory

All WebSocket gateway functionality is rigorously tested in `server/tests/previewWebSocket.test.js` across 6 distinct categories:

| Category | Suite | Test Cases | Status |
| :--- | :--- | :--- | :--- |
| **1. Authentication Verification** | Token, Cookie, Host, Origin, and Invariants | 13 tests | **13/13 PASS** |
| **2. Protocol & RFC 6455** | Method, Upgrade, Version, Key, Subprotocols | 5 tests | **5/5 PASS** |
| **3. Bidirectional Frames** | Text, Binary, Fragmentation, Ping/Pong, Close, Backpressure | 8 tests | **8/8 PASS** |
| **4. Security & Sidecar Identity**| Cross-Session, Sidecar HMAC, Container Identity, Privileged Port Rejection, Cookie Stripping | 6 tests | **6/6 PASS** |
| **5. Resource & Abuse Limits** | Concurrency (10 max / 429), Redis Pub/Sub Broadcast, Frame Limit (1009), Handshake Timeout (504), Framework Rejection | 6 tests | **6/6 PASS** |
| **6. Redis Lease Recovery & Clock Consistency** | Clock-Skew Immunity, Active Lease Protection, Stale Lease Crash Recovery, Heartbeat Renewal, Key PEXPIRE Auto-Cleanup, Lost Pub/Sub Recovery, Fail-Closed Outage | 7 tests | **7/7 PASS** |
| **Total Task 5 / 5.1 / 5.2 / 5.3 Test Suite** | `tests/previewWebSocket.test.js` | **45 tests** | **45/45 PASS (100%)** |

### 23.7 Empirical Docker Acceptance Verification

Live Docker acceptance verification is executed via `./server/docker/verify-preview-websocket.sh` against real containerized runtimes and sidecars:

```bash
./server/docker/verify-preview-websocket.sh
```

**Verification Results**:
1. **Demonstration 1 (STATIC Preview)**: WebSocket upgrade request to static preview runner is deterministically rejected upfront with `HTTP 400 Bad Request` (`WEBSOCKET_UNSUPPORTED_FOR_FRAMEWORK`), avoiding unnecessary upstream socket allocations.
2. **Demonstration 2 (VITE_VANILLA Preview)**:
   - Full orchestration: dependency installation and local Vite runtime initialization.
   - Upstream sidecar loopback port resolved and verified via Docker container inspection.
   - Authenticated WebSocket handshake completes with `HTTP 101 Switching Protocols`.
   - Initial greeting frame received from Vite runner: `{"type":"connected"}`.
   - Vite module graph pre-fetched via HTTP gateway for `/` and `/main.js`.
   - File modification executed inside container (`/workspace/main.js`); live HMR update frame verified: `{"type":"update", ...}`.
   - Targeted security tests verified on live preview:
     - Invalid cookie rejected with `HTTP 401`.
     - Wrong Origin rejected with `HTTP 403`.
     - Missing Origin rejected with `HTTP 403`.
     - Cross-session token rejected with `HTTP 401`.
   - Clean shutdown with close frame 1000 and resource pruning.
3. **Demonstration 3 (VITE_REACT Preview)**:
   - Full orchestration: React + Babel/JSX runtime initialization.
   - Upstream sidecar loopback port resolved and verified via Docker container inspection.
   - Authenticated WebSocket handshake completes with `HTTP 101 Switching Protocols`.
   - Initial greeting frame received from Vite React runner: `{"type":"connected"}`.
   - Vite React module graph pre-fetched via HTTP gateway for `/` and `/src/main.jsx`.
   - File modification executed inside container (`/workspace/src/main.jsx`); live HMR update frame verified: `{"type":"update", ...}`.
   - Replaced sidecar protection: rogue container with mismatched `proxyInstanceId` is rejected with `HTTP 502 Bad Gateway`.
   - Clean shutdown and resource pruning.

---

## 23.8 Task 5.1 Audit Hardening: Port Diagnostics, STATIC Rejection, Multi-Instance Accounting & Live HMR

During the Milestone 7 Task 5.1 final acceptance audit, four targeted hardening enhancements were implemented and validated:

### 23.8.1 Upstream Sidecar Port Diagnostic Resolution & Validation
1. **Diagnostic Discrepancy Root Cause**: In Task 5 verification scripts, `result.session` returned from `PreviewManager.createAndStartSession` was passed through `sanitizeSessionForClient()`. By design, client sanitization strips internal infrastructure metadata (`proxyPort`, `proxyContainerId`, `proxyInstanceId`) so frontend API responses cannot leak internal topology. Accessing `session.proxyPort` on the sanitized object yielded `undefined`.
2. **Resolution & Direct Assertion**: The verification script was updated to query the exact published loopback port from `result.hostPort`, the database record (`prisma.previewSession.findUnique`), and the Docker Engine inspection API (`docker.inspectContainer`). The script verifies that:
   - `proxyContainerId` exists and corresponds to a running container.
   - `proxyInstanceId` matches Docker label `com.gitview.sidecar-instance-id`.
   - Published host port matches `127.0.0.1:<publishedPort>` with `port > 1024`.
3. **Privileged Port Protection in Gateway**: `previewWebSocket.js` now validates that the resolved upstream sidecar port satisfies `proxyPort >= 1024 && proxyPort <= 65535`. Any attempt to forward to a privileged system port (< 1024) is rejected with `HTTP 502 Bad Gateway`.

### 23.8.2 Explicit Rejection of WebSockets on STATIC Previews
1. **The Issue**: Static preview containers serve static files via `serve` on port 3000. When an HTTP Upgrade request was forwarded upstream, `serve` ignored the Upgrade header and responded with `HTTP 200 OK` and `index.html`. For a WebSocket opening handshake, HTTP 200 is invalid and unexpected.
2. **Deterministic Upfront Rejection**: The gateway checks `session.framework` before initiating any upstream connection. If `session.framework === FrameworkType.STATIC`, the gateway immediately rejects the upgrade request with:
   - Status: `HTTP 400 Bad Request`
   - Header: `x-gitview-error: WEBSOCKET_UNSUPPORTED_FOR_FRAMEWORK`
   - Body: JSON error `{ error: 'WebSockets are not supported for STATIC preview sessions', code: 'WEBSOCKET_UNSUPPORTED_FOR_FRAMEWORK' }`
   - No upstream socket or tunnel is created, preventing socket leaks.

### 23.8.3 Multi-Instance Connection Accounting & Clock Consistency (`previewConnectionTracker.js`)
1. **The Architecture**: In multi-instance deployments behind a reverse proxy/load balancer, process-local maps (`activeSocketsMap`) cannot enforce the global limit of 10 concurrent WebSocket connections across multiple gateway instances, nor can one instance terminate sockets maintained on another instance when a session stops.
2. **`IConnectionTracker` Abstraction**:
   - `MemoryConnectionTracker`: Fast local atomic tracking for single-process environments and unit tests without Redis. Uses monotonic `performance.now()` elapsed times.
   - `RedisConnectionTracker`: Production-ready distributed tracking backed by Redis and Redis Pub/Sub.
3. **Redis Sorted Set (ZSET) Leases & Authoritative Server Clock (Task 5.2 & 5.3 Hardening)**:
   - Leases are stored in Redis Sorted Set `preview:ws:leases:<sessionId>` with member `socketId` and score `heartbeatTimestampMs`.
   - **Authoritative Server Time (`TIME`)**: Gateway processes never supply their own wall-clock timestamps (`Date.now()`) for distributed lease decisions. All Lua scripts execute `redis.call('TIME')` inside Redis and convert `[seconds, microseconds]` into consistent integer milliseconds:
     $$\text{nowMs} = \text{seconds} \times 1000 + \lfloor \text{microseconds} / 1000 \rfloor$$
     This guarantees complete immunity to gateway host clock skew or uncoordinated NTP drift.
   - `acquireWsConnectionLease`: Atomically prunes stale entries older than `now - leaseTtlMs` using Redis server time (`ZREMRANGEBYSCORE key -inf (now - leaseTtlMs)`). If unexpired count `ZCARD key < 10`, registers `ZADD key now socketId` and sets key `PEXPIRE`.
   - `renewWsConnectionLease`: Atomic heartbeat renewal using Redis server time. Prunes stale leases, confirms the lease still exists in the set, updates score to `now`, and refreshes key `PEXPIRE`. Returns 0 if lease was deleted or pruned.
   - `releaseWsConnectionLease`: Atomically removes `ZREM key socketId`. Deletes key (`DEL key`) if count drops to 0.
   - `pruneAndCountWsConnectionLeases`: Prunes expired entries using Redis server time and returns active `ZCARD key`.
4. **Automatic Key Cleanup via Key-Level `PEXPIRE`**:
   - Every successful acquisition and renewal refreshes key-level expiration via `PEXPIRE key (leaseTtlMs * 2)`.
   - While connections remain active, recurring heartbeats (`heartbeatIntervalMs = leaseTtlMs / 3`) continuously refresh `PEXPIRE`, preventing premature eviction.
   - If all gateway instances abruptly crash and no further connections occur, Redis automatically evicts the abandoned sorted-set key from memory after $2 \times \text{leaseTtlMs}$.
5. **Fail-Closed Policy for Redis Outages & Renewal Failures**:
   - If Redis is unreachable during connection upgrade, `acquireLease` fails closed (returns `false`), preventing unmetered connections.
   - Local socket tracking measures renewal timeouts using the monotonic clock (`performance.now()`). If Redis connection drops during an active connection and elapsed monotonic time exceeds `leaseTtlMs` without successful renewal, the gateway immediately tears down the local socket with code `1001` (`Redis Lease Expired (Renewal Failed)`), ensuring partition events cannot bypass connection limits.
6. **Distributed Termination & Lost Pub/Sub Safeguard**:
   - When a session terminates, the managing instance terminates local sockets, deletes `preview:ws:leases:<sessionId>`, and broadcasts `sessionId` over Redis Pub/Sub channel `gitview:preview:terminate-ws`.
   - Connected instances receive the broadcast and close their local sockets with code `1001`.
   - **Lost Pub/Sub Recovery Safeguard**: If a network glitch or reconnect causes an instance to miss the Pub/Sub broadcast, on the very next heartbeat tick (~5s), `renewWsConnectionLease` discovers that the sorted set key was deleted (returns 0). The instance immediately terminates the surviving local socket with code `1001`.

### 23.8.4 Live Vite HMR File Modification Verification
1. **Vite On-Demand Module Graph**: Vite dev server compiles modules on-demand only when requested over HTTP. If a WebSocket client connects without the entry modules being requested, Vite's `server.moduleGraph` is unpopulated, and disk modifications will not trigger HMR updates.
2. **End-to-End Live HMR Test**:
   - The test pre-fetches `/` and `/main.js` (or `/src/main.jsx`) through the authenticated HTTP gateway, initializing Vite's module graph.
   - A live file modification is written directly inside the running container workspace (`docker exec ...`).
   - The WebSocket listener receives and asserts a real RFC 6455 text frame containing `{"type":"update", ...}` or `{"type":"full-reload", ...}` arriving from the Vite HMR server through the trusted proxy and GitView Gateway.
   - Tested and verified for both **Vite Vanilla** and **Vite React**.


---

## 24. Milestone 7, Task 6: Final Frontend Integration, End-to-End Acceptance & Release Hardening

### 24.1 Frontend Preview Architecture
1. **`previewService.js` (`client/src/services/previewService.js`)**:
   - Centralized preview API service layer using the authenticated `api` Axios client.
   - Methods:
     - `createPreview(repositoryId, commitRef)`: Initiates preview session (`POST /api/v1/previews`).
     - `getPreviewStatus(previewId)`: Retrieves session status (`GET /api/v1/previews/:id`).
     - `stopPreview(previewId)`: Stops session idempotently (`POST /api/v1/previews/:id/stop`).
     - `createPreviewTicket(previewId, mode)`: Generates single-use bootstrap ticket (`POST /api/v1/previews/:id/ticket`). Enforces strict mode validation (`'iframe'` or `'toplevel'`). Sets `Cache-Control: no-store`.
     - `pollPreviewStatus(previewId, onUpdate, options)`: Bounded-backoff polling loop ($1000\text{ms} \to 3000\text{ms}$, multiplier 1.25) with automatic cancellation via `AbortSignal` and immediate exit upon reaching terminal status (`RUNNING`, `STOPPED`, `FAILED`, `EXPIRED`).
   - Security invariants:
     - Capability tokens and tickets are NEVER written to `localStorage` or `sessionStorage`.
     - Secret tokens and tickets are NEVER printed to browser `console.log`.

2. **`LivePreview.jsx` (`client/src/components/preview/LivePreview.jsx`)**:
   - Comprehensive state machine covering all 7 UI states:
     - `IDLE`: Clean dark aesthetic with supported framework tags, security capability badges, and "Run Preview" call-to-action.
     - `PROGRESSIVE LOADING` (`FETCHING`, `BUILDING`, `STARTING`): Multi-step visual progress stepper, active stage label, and "Cancel Launch" abort button.
     - `RUNNING`: Secure sandboxed `<iframe>` (`sandbox="allow-scripts allow-forms allow-same-origin"`, `referrerPolicy="no-referrer"`), address bar showing preview host, live session countdown timer with $<5\text{min}$ warning animation, framework badge (`STATIC`, `VITE_VANILLA`, `VITE_REACT`), desktop vs mobile (375px) viewport switcher, refresh button, top-level new tab launcher, restart button, and stop button.
     - `STOPPED`: Clean post-termination state with "Restart Preview" button.
     - `FAILED`: Red alert state, machine-readable error code badge (`Code: ...`), user-friendly message, collapsible technical error drawer, and "Try Again" retry button.
     - `EXPIRED`: 1-hour session limit notice and "Start New Session" button.
     - `CONFLICT`: Concurrency ceiling notice (HTTP 409 `ACTIVE_SESSION_CONFLICT`) with "Switch to This Preview" action that automatically terminates the prior session and launches the new one.
   - Lifecycle cleanup: Automatically aborts polling controllers and clears timer intervals on unmount to eliminate memory leaks.

3. **Workspace Integration (`client/src/components/workspace/LivePreview.jsx` & `WorkspaceToolbar.jsx`)**:
   - Integrates directly with `WorkspaceContext`, binding the active repository ID, commit SHA / branch ref, and repository name.
   - Workspace toolbar features an interactive status pill displaying live preview status and toggling the preview pane.

### 24.2 Browser End-to-End Acceptance Suite (Playwright)
- **Test Files**: `client/e2e/*.spec.js` (21 serial tests in Chromium across 3 spec files).
- **Test Inventory**:
  1. `e2e/phase4-explorer.spec.js` (9 tests): Repository import, file tree navigation, breadcrumbs, Monaco editor, README rendering, binary file detection, large file limits, and multi-repo switching.
  2. `e2e/phase5-preview.spec.js` (9 tests): Preview panel toggle, desktop/mobile viewport switcher, progressive stage loading and cancellation, iframe sandboxing invariants, zero storage / console secret leakage, top-level new tab navigation, preview frame reload, error drawer presentation, and HTTP 409 session conflict resolution.
  3. `e2e/live-preview-smoke.spec.js` (3 tests): Full end-to-end integration running against live backend, Redis, PostgreSQL, and Docker Engine:
     - *STATIC Preview*: Spawns container and sidecar, redeems iframe ticket, verifies rendered `<h1>GitView Static Preview Test</h1>` DOM, asserts Docker container lifecycle, tests top-level ticket issuance, stops preview, and verifies container removal.
     - *VITE_VANILLA Preview*: Triggers archive extraction, runner/sidecar orchestration, verifies rendered `<h1>GitView Vanilla Preview</h1>` DOM, and confirms clean teardown.
     - *VITE_REACT Preview*: Orchestrates container, validates JSX transformation and dev runtime, verifies rendered `<h1>GitView React Preview</h1>` DOM, and confirms clean teardown.
- **Combined E2E Count**: 21 tests across 3 spec files, 100% passing in Chromium.

### 24.3 Complete Automated Test Accounting (Phase 5 Completion Baseline)
| Test Category | Suite / Scope | Tests / Checks | Pass Rate | Status |
| :--- | :--- | :---: | :---: | :---: |
| **Backend Vitest Suite** | 26 test files (`server/tests/*.test.js`) | **715** tests | **100%** (715 / 715) | PASS |
| ↳ *WebSocket Gateway Subsuite* | `tests/previewWebSocket.test.js` | 45 tests | 100% (45 / 45) | PASS |
| ↳ *HTTP Gateway Subsuite* | `tests/previewGateway.test.js` | 89 tests | 100% (89 / 89) | PASS |
| ↳ *Preview Routes Subsuite* | `tests/previewRoutes.test.js` | 48 tests | 100% (48 / 48) | PASS |
| ↳ *PreviewManager Subsuite* | `tests/previewManager.test.js` | 49 tests | 100% (49 / 49) | PASS |
| ↳ *Ticket Store Subsuite* | `tests/previewTicketStore.test.js` | 40 tests | 100% (40 / 40) | PASS |
| ↳ *Lockfile & Egress Subsuites* | `lockfileValidator.test.js`, `egressProxy.test.js` | 89 tests | 100% (89 / 89) | PASS |
| **Client Vitest Suite** | 3 test files (`client/src/services/*.test.js`) | **34** tests | **100%** (34 / 34) | PASS |
| ↳ *Preview Service Tests* | `src/services/previewService.test.js` | 15 tests | 100% (15 / 15) | PASS |
| ↳ *API Interceptor Tests* | `src/services/api.test.js` | 13 tests | 100% (13 / 13) | PASS |
| ↳ *Explorer Tree Tests* | `src/services/explorer.test.js` | 6 tests | 100% (6 / 6) | PASS |
| **Playwright Browser E2E** | 3 spec files (`client/e2e/*.spec.js`) | **21** tests | **100%** (21 / 21) | PASS |
| ↳ *Phase 5 Live Preview E2E* | `e2e/phase5-preview.spec.js` | 9 tests | 100% (9 / 9) | PASS |
| ↳ *Phase 5 Live Docker Smoke* | `e2e/live-preview-smoke.spec.js` | 3 tests | 100% (3 / 3) | PASS |
| ↳ *Phase 4 Explorer E2E* | `e2e/phase4-explorer.spec.js` | 9 tests | 100% (9 / 9) | PASS |
| **Docker Adapter Security Checks**| `server/docker/verify-docker-adapter.sh` | **11** checks | **100%** (11 / 11) | PASS |
| **Master Docker Acceptance** | `server/docker/acceptance-tests/run-all.sh` | **6** suites / 21 checks | **100%** (6 / 6 suites) | PASS |
| **Live Gateway HTTP Demonstrations**| `server/docker/verify-preview-gateway.sh` | **3** scenarios | **100%** (3 / 3) | PASS |
| **Live Gateway WebSocket Checks** | `server/docker/verify-preview-websocket.sh` | **7** checks | **100%** (7 / 7) | PASS |

> **Note**: Test layers evaluate distinct isolation boundaries (unit, browser DOM, container lifecycle, and live proxying) and are maintained as independent test sets. Individual test counts are reported separately without summing distinct checks into an artificial aggregate.

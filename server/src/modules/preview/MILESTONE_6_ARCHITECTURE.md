# GitView Phase 5 — Milestone 6: Preview Orchestration Architecture & Implementation Blueprint (v1.1)

> **Document Status**: Architecture & Implementation Specification  
> **Version**: 1.1 (Security Corrections & Network Topology Hardening)  
> **Scope**: Architecture & Implementation Planning ONLY. Strictly no modification of production application code, Prisma schema, migrations, or production Docker images until this architecture is formally approved.  
> **Status Classifications**:
> - **[APPROVED ARCHITECTURE DECISION]**: Formally approved design principles and infrastructure topologies established across Milestones 1–5.1.
> - **[IMPLEMENTATION REQUIREMENT]**: Mandatory implementation specifications, defensive checks, and interfaces to be implemented in Milestone 6 tasks.
> - **[EMPIRICAL TEST PENDING]**: Architectural proposals subject to empirical validation via isolated Docker test suites (`test-6-builder-egress-isolation.sh`) before production certification.

---

## Change Log (v1.0 → v1.1)

1. **Dual-Network Build Topology Correction (§1, §4)**:
   - Replaced single bridge network with dual-network isolation:
     - `gitview-build-int-${SESSION_ID}`: Internal Docker bridge (`--internal=true`), no gateway, completely disconnected from WAN.
     - `gitview-build-egress-${SESSION_ID}`: Standard bridge network with egress access, attached exclusively to the trusted build proxy.
   - Clarified Docker routing behavior: Docker assigns default route (`0.0.0.0/0`) via the standard bridge gateway on the proxy container; the builder has no default gateway and zero egress capability.
2. **Egress Proxy TLS Inspection & SSRF Defense (§4)**:
   - Clarified that without TLS MITM/interception, an HTTP CONNECT proxy inspects the unencrypted CONNECT authority (`host:port`) and optional TLS ClientHello SNI, **not** the encrypted HTTP Host header inside the tunnel.
   - Specified strict port 443 enforcement, rejection of numeric/IP-literal targets, server-side pre-resolution DNS check against RFC 1918, RFC 3927 (link-local/169.254.x.x), loopback, IPv6 link-local, and cloud metadata IPs (e.g. `169.254.169.254`), with DNS rebinding defenses.
3. **Execution Safety & Supply-Chain Boundaries (§3)**:
   - Mandated `--ignore-scripts` on `npm ci`.
   - Prevented `.npmrc` proxy overrides or `NO_PROXY` bypasses by mounting a controlled root `/root/.npmrc` or running with explicit command-line flags (`npm ci --ignore-scripts --proxy=... --https-proxy=...`).
4. **Bounded Resource Consumption on macOS Docker Desktop (§3)**:
   - Documented explicit quota boundaries: 1 MB lockfile size, 5,000 package graph depth, 150 MB cumulative package download limit, 300 MB workspace volume limit, 90-second installation timeout.
   - Explained macOS Docker Desktop constraint: ext4/xfs POSIX project quotas (`--storage-opt size=...`) are not supported on standard Docker Desktop VM storage drivers. Specified active host-side polling (`docker exec ... du -sm /workspace`) and post-install quota validation.
5. **Docker CLI Safety & Argument Injection (§7)**:
   - Corrected false claim that `execFile({ shell: false })` prevents all injection: acknowledged **argument injection** (flags/options starting with `-` or `--`).
   - Implemented fixed command templates with strict regex allowlists for all identifiers, session IDs, volume names, and container labels.
6. **Authentication & Token Handling (§2)**:
   - Forbade accepting `githubToken` from HTTP client payloads; tokens must be decrypted server-side from authenticated session database records.
   - Enforced repository ownership/collaborator authorization checks before session creation.
   - Pin 40-character commit SHA server-side.
   - Forbade returning `rawToken` in API responses and strictly prohibited logging bearer/preview tokens.
   - Clarified browser preview cookie bootstrap mechanism for Milestone 7.
7. **Empirical Validation Prerequisite (§10)**:
   - Explicitly classified registry-only egress filtering as **[EMPIRICAL TEST PENDING]** until `test-6-builder-egress-isolation.sh` passes successfully.

---

## 1. System Topology & Architectural Overview

The Live Preview Engine automates the journey from an imported GitHub repository into an active, sandboxed web preview. 

### 1.1 Complete Lifecycle Architecture Overview

```
                                 [ GitView Backend (Node.js ESM) ]
                                                │
                      ┌─────────────────────────┴─────────────────────────┐
                      ▼                                                   ▼
            [ Archive Fetcher ]                                  [ Preview Manager ]
        (api.github.com / codeload)                         (State Machine & Orchestration)
                      │                                                   │
                      ▼                                                   ▼
         [ Extractor Container ] ── populates volume ──► [ Per-Session Workspace Volume ]
       (gitview-extractor:latest)                         (gitview-ws-${SESSION_ID})
                                                                          │
                      ┌───────────────────────────────────────────────────┘
                      │
        ┌─────────────┴─────────────────────────────────────┐
        ▼ (STATIC Profile)                                  ▼ (VITE_FRONTEND Profile)
 [ Preview Runner ] (No Build)                   [ NPM Builder Container ]
 (gitview-runner:latest)                        (Dual-Network Egress Proxy Isolation)
        │                                                   │
        │                                                   ▼
        │                                        [ Compiled / Installed Workspace ]
        │                                                   │
        └─────────────────────────┬─────────────────────────┘
                                  ▼
                        [ Hardened Runtime ]
                 ┌───────────────────────────────────┐
                 │  Option A Proxy Architecture      │
                 │  - trusted proxy-sidecar          │
                 │  - dynamic 127.0.0.1::PORT        │
                 │  - isolated internal network      │
                 └───────────────────────────────────┘
```

### 1.2 Dual-Network npm Builder Topology **[APPROVED ARCHITECTURE DECISION]**

Building dependencies for untrusted Vite repositories requires internet access to `registry.npmjs.org`, but must prevent arbitrary WAN egress, scanning of internal networks, or connection to local infrastructure.

```
+---------------------------------------------------------------------------------------------------+
| Host: macOS / Docker Desktop VM                                                                   |
|                                                                                                   |
|  [ Builder Container ]                                                                            |
|  (UID 10001, node:22-alpine)                                                                      |
|  - Workspace: /workspace (RW)                                                                     |
|  - Drops all Linux caps                                                                           |
|  - Memory: 1024m, PIDs: 128, CPU: 1.0                                                             |
|  - npm ci --ignore-scripts                                                                         |
|         │                                                                                         |
|         │ eth0: 172.28.0.2                                                                        |
|         ▼                                                                                         |
|  ═════════════════════════════════════════════════════════════════════════════════════            |
|  Network A: Internal Build Network (gitview-build-int-${SESSION_ID})                              |
|  - docker network create --internal=true                                                          |
|  - Gateway: NONE (0.0.0.0/0 unreachable via kernel)                                               |
|  ═════════════════════════════════════════════════════════════════════════════════════            |
|         ▲                                                                                         |
|         │ eth0: 172.28.0.3 (Listening on port 3128)                                               |
|  [ Dedicated Egress Proxy ] (gitview-build-proxy-${SESSION_ID})                                   |
|  - Alpine / Hardened Micro-Proxy (e.g. Smokescreen / Tinyproxy / Custom Go Proxy)                 |
|  - Strict Whitelist: registry.npmjs.org:443 ONLY                                                  |
|  - Connect Authority & TLS SNI Inspection                                                         |
|  - Pre-resolution DNS check against RFC 1918 / Loopback / Metadata                                |
|  - Rejects IP literals & non-443 ports                                                            |
|         │                                                                                         |
|         │ eth1: 172.29.0.2 (Default Route Gateway: 172.29.0.1)                                    |
|  ═════════════════════════════════════════════════════════════════════════════════════            |
|  Network B: External Egress Network (gitview-build-egress-${SESSION_ID})                          |
|  - Standard Docker bridge network (default Docker NAT bridge)                                     |
|  ═════════════════════════════════════════════════════════════════════════════════════            |
|         │                                                                                         |
|         ▼                                                                                         |
|  [ Internet / NAT Gateway ] ──────────► Only: https://registry.npmjs.org:443                      |
+---------------------------------------------------------------------------------------------------+
```

#### Why This Dual-Network Topology Guarantees Builder Isolation:
1. **Zero Builder WAN Gateway**: When a Docker network is created with `--internal=true`, Docker Engine does not assign a default gateway interface to the bridge subnet (`Gateway: ""`). The Linux kernel routing table inside the Builder container contains only local subnet routes (e.g., `172.28.0.0/16 dev eth0`). Packets addressed to any non-local IP (such as public IPs or host LAN IPs) fail immediately with `ENETUNREACH` (Network unreachable).
2. **Deterministic Default Route for Proxy**: The egress proxy container is attached to both networks. In Linux, a container receives its default route (`0.0.0.0/0`) from the network interface that possesses a gateway. Since `gitview-build-int` has no gateway, Docker assigns the default route solely through `eth1` on `gitview-build-egress`. All outbound traffic from the proxy routes through the standard NAT bridge to the internet.
3. **Builder Network Sandboxing**: The builder container has no physical or virtual path to the internet except by explicitly establishing an HTTP CONNECT tunnel through `http://172.28.0.3:3128`. The proxy enforces our cryptographic and hostname whitelist.

---

## 2. PreviewManager Core Responsibilities & Input Handling **[IMPLEMENTATION REQUIREMENT]**

The `PreviewManager` is the top-level orchestration domain service in the backend (`server/src/modules/preview/previewManager.js`).

### 2.1 API Request & Input Security
1. **Never Accept Tokens from Client**: API endpoints (`POST /api/v1/preview/sessions`) accept only `{ repositoryId, commitSha }`. Clients **never** provide GitHub tokens in request bodies.
2. **Server-Side Token Retrieval & Decryption**: The `PreviewManager` retrieves the user's encrypted GitHub personal access token or OAuth token directly from the database (via existing user credential encryption services).
3. **Repository Authorization Check**: The manager verifies that the requesting user owns or has verified collaborator access to the target repository before initiating any resource provisioning.
4. **Commit SHA Verification**: The `commitSha` must be verified as a strict 40-character hexadecimal string (`/^[0-9a-fA-F]{40}$/`). The manager resolves or verifies this SHA against GitHub API or repository explorer data before dispatching downloads.
5. **Session Token Handling**: The session cryptographic preview token (Milestone 3 `previewTokens.js`) is hashed (`tokenHash`) for database storage. The raw token is **never** returned in standard API list/status payloads and is **never logged** in plaintext.
6. **Milestone 7 Browser Cookie Bootstrap**: In Milestone 7, the raw token is delivered strictly via an `HttpOnly`, `SameSite=Lax`, `Secure` session cookie during the initial preview launch redirect, or via a single-use handshake redirect.

---

## 3. Dependency Installation & Bounded Resource Consumption **[IMPLEMENTATION REQUIREMENT]**

Executing `npm ci` inside an isolated container for imported repositories introduces potential denial-of-service and supply-chain vulnerabilities. Milestone 6 implements strict deterministic boundaries.

### 3.1 Bounded Consumption Thresholds
- **Lockfile Size Limit**: Maximum 1.0 MB (`package-lock.json`). If exceeded, session transitions to `FAILED` with `LOCKFILE_TOO_LARGE`.
- **Package Graph Ceiling**: Maximum 5,000 total package declarations in `packages` / `dependencies`.
- **Installation Download Limit**: Maximum 150 MB cumulative `.npm` cache / network transfer.
- **Workspace Volume Ceiling**: Maximum 300 MB for the entire session volume (`gitview-ws-${SESSION_ID}`).
- **Build Duration Timeout**: Maximum 90 seconds wall-clock time. If the builder container does not exit within 90 seconds, it is forcefully killed via `docker rm -f`.

### 3.2 Storage Quota Enforcement on macOS Docker Desktop
> [!IMPORTANT]
> Standard Linux Docker hosts support directory or volume quotas using XFS/ext4 project quotas (`--storage-opt size=300M`). However, **Docker Desktop on macOS** runs an Alpine/LinuxKit VM utilizing overlayfs on virtiofs/qcow2 without exposed project quota support on standard named volumes.
>
> **Enforcement Mechanism**:
> 1. **Active Host Polling**: The host orchestrator monitors workspace disk usage every 5 seconds during building via:
>    `docker exec <builder-id> du -sm /workspace`
> 2. **Post-Build Validation**: Immediately after the builder exits (and before starting the runner), the orchestrator inspects the volume size. If total disk usage exceeds 300 MB, the workspace is purged, containers are killed, and the session fails with `WORKSPACE_QUOTA_EXCEEDED`.
> 3. **Non-Root UID Prevention**: The builder runs as unprivileged user `node` (UID 10001, GID 10001) with `no-new-privileges`, preventing elevation to bypass file ownership.

### 3.3 Supply-Chain Execution Safety
- **Mandatory `--ignore-scripts`**: All dependency installation is executed strictly with `npm ci --ignore-scripts`. Pre-install, post-install, and arbitrary lifecycle shell scripts are completely suppressed.
- **npm Proxy Configuration**: 
  - Builder container is invoked with explicit environment variables:
    - `HTTP_PROXY="http://gitview-build-proxy-${SESSION_ID}:3128"`
    - `HTTPS_PROXY="http://gitview-build-proxy-${SESSION_ID}:3128"`
    - `npm_config_proxy="http://gitview-build-proxy-${SESSION_ID}:3128"`
    - `npm_config_https_proxy="http://gitview-build-proxy-${SESSION_ID}:3128"`
  - An immutable `/root/.npmrc` or `/home/node/.npmrc` is populated in the builder container forcing `registry=https://registry.npmjs.org/` and forbidding user repository `.npmrc` files from overriding proxy or registry parameters.

---

## 4. Restricted npm Egress Proxy Architecture **[IMPLEMENTATION REQUIREMENT]**

The egress proxy container (`gitview-build-proxy-${SESSION_ID}`) acts as a security perimeter between the builder container and the internet.

### 4.1 Proxy Security & TLS Tunneling Specification
1. **CONNECT Authority & TLS SNI vs HTTP Host Header**:
   - Because `npm` communicates with `https://registry.npmjs.org/` via encrypted TLS, the client initiates an unencrypted HTTP `CONNECT registry.npmjs.org:443 HTTP/1.1` tunnel request.
   - The proxy **does not** perform TLS interception (MITM), as generating dynamic root CAs inside ephemeral containers introduces significant credential attack surfaces.
   - Consequently, the proxy inspects:
     a. The unencrypted **CONNECT Authority** (`host:port`).
     b. The TLS **ClientHello Server Name Indication (SNI)** during the TLS handshake before relaying raw encrypted packets.
   - The proxy **cannot and does not** inspect the encrypted HTTP `Host` header inside the established TLS tunnel.
2. **Exact Allowlisted Hostname**:
   - Only `registry.npmjs.org` is permitted. Naive suffix matching (`*.npmjs.org` or substring matches) is forbidden.
3. **Port Enforcement**:
   - Strictly destination port `443`. Requests to port 80, 8080, 22, etc., are immediately aborted.
4. **Rejection of IP-Literal Destinations**:
   - Any CONNECT request specifying raw IPv4/IPv6 literals (e.g. `CONNECT 1.1.1.1:443`, `CONNECT 127.0.0.1:443`) is rejected with HTTP 403 Forbidden.
5. **Pre-Resolution SSRF & Private IP Blocking**:
   - Before establishing the outbound TCP socket to `registry.npmjs.org`, the proxy resolves the hostname via upstream DNS and inspects all returned IP addresses.
   - Connection is aborted if the target IP resolves to:
     - RFC 1918 Private ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`).
     - RFC 3927 Link-Local (`169.254.0.0/16`), specifically guarding AWS/GCP cloud metadata endpoints (`169.254.169.254`).
     - Loopback (`127.0.0.0/8`, `::1`).
     - Carrier-Grade NAT (`100.64.0.0/10`) or Multicast (`224.0.0.0/4`).
6. **DNS Rebinding Defense**:
   - The outbound socket is pinned directly to the validated IP address obtained from the pre-resolution check, preventing Time-of-Check to Time-of-Use (TOCTOU) DNS rebinding attacks.

---

## 5. Runtime Orchestration: STATIC vs VITE_FRONTEND & ESM Resolution **[APPROVED ARCHITECTURE DECISION]**

GitView's Live Preview Engine isolates execution according to the detected framework profile.

### 5.1 STATIC Profile Execution
- **Zero Build Step**: No builder or egress proxy containers are provisioned.
- **Runtime Server**: Spawns `gitview-runner` container in static file-serving mode.
- **Filesystem**: Named volume `gitview-ws-${SESSION_ID}` mounted read-only (`ro`) at `/app/workspace`.
- **Serving Command**: Lightweight Node.js or static HTTP server serving `/app/workspace` on port 3000.

### 5.2 VITE_FRONTEND Profile Execution (Vite Vanilla & Vite React)
- **Supported Versions**:
  - Vite: 5.x and 6.x.
  - React: 18.x and 19.x.
  - Node.js Runtime: Node 22 LTS (`node:22-alpine` / `gitview-runner:latest`).
- **Phase 1: Build & Install**:
  - Provision dual networks (`gitview-build-int-${SESSION_ID}`, `gitview-build-egress-${SESSION_ID}`).
  - Start egress proxy container.
  - Run builder container with `/workspace` mounted read-write (`rw`).
  - Execute `npm ci --ignore-scripts`.
  - Validate volume size (<= 300 MB).
  - Destroy builder and egress proxy containers and prune build networks.
- **Phase 2: Runtime Dev Server**:
  - Spawn `gitview-runner` container attached to internal runtime network `gitview-net-${SESSION_ID}`.
  - Volume `gitview-ws-${SESSION_ID}` mounted read-write (`rw`) for Vite `.vite` dependency pre-bundling cache, but with non-root UID 10001 isolation and dropping all Linux capabilities.
  - Command: `npx vite --host 0.0.0.0 --port 3000 --strictPort`.
  - Vite HMR WebSocket and HTTP requests proxied via Option A proxy container.

---

## 6. Option A Container Orchestration Topology **[APPROVED ARCHITECTURE DECISION]**

Milestone 1 established and empirically validated the Option A architecture on Docker Desktop (Apple Silicon ARM64). Milestone 6 orchestrates this runtime layout.

```
+---------------------------------------------------------------------------------------------------+
| Host: macOS (Loopback Interface 127.0.0.1)                                                        |
|                                                                                                   |
|  [ Browser Client ]                                                                               |
|         │                                                                                         |
|         │ HTTP / WS: http://127.0.0.1:${ASSIGNED_PORT}                                            |
|         ▼                                                                                         |
|  [ Option A Trusted Proxy Container ] (gitview-proxy-${SESSION_ID})                               |
|  - Network 1: Ingress Bridge Network (gitview-ingress-net)                                        |
|    - Publishes port: -p 127.0.0.1:${ASSIGNED_PORT}:8080                                           |
|  - Network 2: Per-Session Internal Network (gitview-net-${SESSION_ID})                            |
|    - docker network create --internal=true                                                        |
|  - Reverse-proxies HTTP and WebSockets to http://preview-runner:3000                              |
|  - Does not execute repository code                                                               |
|  - No Docker socket or host mounts                                                                |
|         │                                                                                         |
|         │ Forwarded over internal network (no external egress)                                    |
|         ▼                                                                                         |
|  [ Hardened Preview Runner Container ] (gitview-runner-${SESSION_ID})                             |
|  - Network: Connected ONLY to gitview-net-${SESSION_ID}                                           |
|  - No published host ports                                                                        |
|  - Memory: 512m, CPU: 1.0, PIDs: 64, no-new-privileges                                            |
|  - UID 10001 (non-root)                                                                           |
|  - Serving on internal port 3000                                                                  |
+---------------------------------------------------------------------------------------------------+
```

---

## 7. Docker Adapter Design (`dockerAdapter.js`) & CLI Safety **[IMPLEMENTATION REQUIREMENT]**

All Docker interactions are encapsulated inside `server/src/modules/preview/dockerAdapter.js`.

### 7.1 Addressing Argument Injection & CLI Safety
> [!IMPORTANT]
> Using `child_process.execFile` with `shell: false` protects against shell metacharacter injection (`|`, `&`, `;`, `$()`), but **does NOT prevent argument injection**. If untrusted strings beginning with dashes (e.g. `--privileged`, `-v`, `--net=host`) are passed as elements in the argument array, the Docker CLI interprets them as flags.
>
> **Mandatory Docker CLI Protections**:
> 1. **Fixed Command Templates**: Command flag structures are hardcoded templates. Dynamic arguments are never permitted in flag positions.
> 2. **Strict Regex Whitelisting on Dynamic Identifiers**:
>    - Session IDs: `/^[a-zA-Z0-9_-]{1,64}$/`
>    - Volume names: `/^gitview-ws-[a-zA-Z0-9_-]{1,64}$/`
>    - Container names: `/^gitview-(runner|proxy|builder|build-proxy)-[a-zA-Z0-9_-]{1,64}$/`
>    - Port numbers: Valid integers between `1024` and `65535`.
> 3. **Labels for Lifecycle Tracking**: Every created Docker resource (container, volume, network) MUST be labeled with:
>    - `gitview.managed=true`
>    - `gitview.session.id=${sessionId}`
>    - `gitview.created.at=${isoTimestamp}`
> 4. **Scoped Cleanup**: Resource teardown selects targets strictly using Docker label filters:
>    `docker rm -f $(docker ps -aq --filter label=gitview.session.id=${sessionId})`

---

## 8. Lifecycle Orchestration, State Transitions & Failure Recovery **[IMPLEMENTATION REQUIREMENT]**

The `PreviewManager` interacts with the `PreviewSession` state machine (Milestone 3).

```
                      ┌──────────────┐
                      │   PENDING    │
                      └──────┬───────┘
                             │
                             ▼
                      ┌──────────────┐
                      │ PROVISIONING │
                      └──────┬───────┘
                             │
              ┌──────────────┴──────────────┐
              │                             │ (Vite)
              ▼ (Static)                    ▼
       ┌──────────────┐              ┌──────────────┐
       │   STARTING   │              │   BUILDING   │
       └──────┬───────┘              └──────┬───────┘
              │                             │
              │                             ▼
              │                      ┌──────────────┐
              │                      │   STARTING   │
              │                      └──────┬───────┘
              │                             │
              └──────────────┬──────────────┘
                             │
                             ▼
                      ┌──────────────┐
                      │   RUNNING    │
                      └──────┬───────┘
                             │
              ┌──────────────┴──────────────┐
              ▼                             ▼
       ┌──────────────┐              ┌──────────────┐
       │   STOPPING   │              │    FAILED    │
       └──────┬───────┘              └──────────────┘
              │
              ▼
       ┌──────────────┐
       │   STOPPED    │
       └──────────────┘
```

### 8.1 State Transitions
1. `PENDING` → `PROVISIONING`: Database session initialized, volume created, archive downloaded & extracted.
2. `PROVISIONING` → `BUILDING`: (For `VITE_FRONTEND`) Lockfile validated, builder and egress proxy spawned.
3. `BUILDING` → `STARTING`: Dependencies installed, build containers torn down, runner container provisioned.
4. `PROVISIONING` → `STARTING`: (For `STATIC`) Directly provisions runner container.
5. `STARTING` → `RUNNING`: Proxy container verifies runner port health check, session URL assigned.
6. `RUNNING` → `STOPPING` → `STOPPED`: Normal teardown (idle timeout or user stop).
7. `*` → `FAILED`: Unhandled error, quota breach, lockfile invalid, network timeout. Full atomic cleanup invoked.

---

## 9. Proposed Module Interfaces **[IMPLEMENTATION REQUIREMENT]**

### 9.1 `PreviewManager` (`server/src/modules/preview/previewManager.js`)
```javascript
export class PreviewManager {
  /**
   * Initiates session provisioning and orchestrates build/runtime pipeline.
   * @param {Object} params
   * @param {string} params.userId - Authenticated user ID
   * @param {string} params.repositoryId - User-authorized repository ID
   * @param {string} params.commitSha - Strict 40-char commit SHA
   * @returns {Promise<PreviewSessionPublicDTO>}
   */
  async createPreviewSession({ userId, repositoryId, commitSha });

  /**
   * Stops an active session and tears down containers.
   * @param {string} sessionId
   * @param {string} userId
   * @returns {Promise<void>}
   */
  async stopPreviewSession(sessionId, userId);

  /**
   * Retrieves sanitized session status without sensitive tokens.
   * @param {string} sessionId
   * @param {string} userId
   * @returns {Promise<PreviewSessionPublicDTO>}
   */
  async getPreviewSessionStatus(sessionId, userId);
}
```

### 9.2 `LockfileValidator` (`server/src/modules/preview/lockfileValidator.js`)
```javascript
export class LockfileValidator {
  /**
   * Validates package-lock.json against security and size constraints.
   * @param {string} lockfileContent - Raw JSON string
   * @returns {{ valid: boolean, packageCount: number, error?: string }}
   */
  static validate(lockfileContent);
}
```

### 9.3 `DockerAdapter` (`server/src/modules/preview/dockerAdapter.js`)
```javascript
export class DockerAdapter {
  async createVolume(volumeName, labels);
  async createInternalNetwork(networkName, labels);
  async createBridgeNetwork(networkName, labels);
  async spawnEgressProxy({ sessionId, networkInt, networkEgress, port });
  async runNpmBuilder({ sessionId, volumeName, networkInt, timeoutSec });
  async spawnRunner({ sessionId, volumeName, networkInt, framework });
  async spawnProxySidecar({ sessionId, networkInt, targetPort, hostPort });
  async cleanupSessionResources(sessionId);
}
```

---

## 10. Test Strategy & Synthetic Verification Suite

### 10.1 Empirical Validation Prerequisite **[EMPIRICAL TEST PENDING]**
> [!CAUTION]
> The dual-network npm builder egress isolation architecture is **pending empirical validation**. It must not be certified for production deployment until the dedicated test script `server/docker/acceptance-tests/test-6-builder-egress-isolation.sh` successfully executes.

### 10.2 Synthetic Vite Fixtures (`server/tests/fixtures/`)
1. **`synthetic-vite-vanilla`**: Minimal HTML + vanilla TypeScript Vite 5 setup.
2. **`synthetic-vite-react`**: React 18/19 counter component using `@vitejs/plugin-react`.
3. **`malicious-vite-postinstall`**: Test fixture containing malicious `postinstall` script in `package.json` attempting outbound ping; verifies `--ignore-scripts` blocks execution.
4. **`malicious-vite-egress`**: Test fixture attempting direct `curl` or socket connection to non-allowlisted IP/host; verifies network unreachable and proxy rejection.

### 10.3 Test Script: `server/docker/acceptance-tests/test-6-builder-egress-isolation.sh`
1. Spawns `gitview-build-int` (`--internal=true`) and `gitview-build-egress`.
2. Verifies direct outbound ping/curl from builder container fails (`ENETUNREACH`).
3. Verifies `npm ci` succeeds exclusively through the egress proxy for allowlisted `registry.npmjs.org`.
4. Verifies requests to non-allowlisted domains (`evil.com`, `google.com`) or port 80 fail with 403.
5. Verifies SSRF attempts to `169.254.169.254` and `127.0.0.1` fail.

---

## 11. Ordered Implementation Tasks

- [ ] **Task 1: Module Scaffolding & Lockfile Validation**: Create `lockfileValidator.js` with comprehensive unit tests for size limits (1 MB) and package graph ceiling (5,000 packages).
- [ ] **Task 2: Docker Adapter Implementation (`dockerAdapter.js`)**: Implement safe `execFile` command wrappers with regex whitelisting, label-based resource tracking, volume creation, and teardown.
- [ ] **Task 3: Dual-Network Egress Proxy Image & Isolation Script**: Implement egress proxy configuration and execute `test-6-builder-egress-isolation.sh` to empirically prove registry-only egress.
- [ ] **Task 4: Builder & Static Pipeline Orchestration**: Integrate `PreviewManager` with extractor, lockfile validator, and Docker adapter for both STATIC and VITE_FRONTEND profiles.
- [ ] **Task 5: End-to-End Synthetic Preview Acceptance**: Validate end-to-end preview launch, port publishing, and teardown using synthetic Vite and static fixtures.

---

## 12. Verifiable Acceptance Criteria

1. **Dual Network Isolation**: Builder container has zero direct WAN egress routes; can reach only the egress proxy on port 3128.
2. **Egress Allowlisting**: Only `registry.npmjs.org:443` is permitted through the proxy. SSRF, IP literals, and alternative domains fail.
3. **Script Suppression**: `package.json` lifecycle scripts (`preinstall`, `postinstall`) are never executed.
4. **Bounded Storage**: Workspace volume usage exceeding 300 MB or lockfiles exceeding 1 MB trigger immediate failure and teardown.
5. **No Token Leakage**: GitHub tokens and raw session tokens are never present in API responses or plaintext logs.
6. **Clean Teardown**: Stopping a session removes all associated containers, ephemeral networks, and volumes without orphaned host resources.

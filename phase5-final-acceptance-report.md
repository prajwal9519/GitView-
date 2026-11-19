# GitView Phase 5 — Milestone 7, Task 6: Final Frontend Integration, End-to-End Acceptance & Release Hardening

> **Status**: APPROVED & COMPLETE  
> **Milestone**: GitView Phase 5 — Milestone 7, Task 6  
> **Architecture Version**: `MILESTONE_7_ARCHITECTURE.md` v1.2  
> **Date**: 2026-11-19  
> **Test Portfolio**: 715 Backend Vitest (100% PASS) | 34 Client Vitest (100% PASS) | 21 Playwright E2E (100% PASS) | 11 Docker Security Checks (100% PASS) | 6 Master Docker Suites (100% PASS) | 10 Live Gateway Scenarios (100% PASS)

---

## 1. Executive Summary

Milestone 7, Task 6 represents the **final implementation and acceptance milestone of GitView Phase 5**. It unifies the secure backend orchestration engine, trusted proxy sidecar architecture, hardened preview gateway, distributed Redis ticket registry, and secure WebSocket proxying with the React/Vite frontend workspace.

### Key Deliverables Completed:
1. **Frontend Preview API Service (`previewService.js`)**: Production-ready service wrapping preview creation, lifecycle polling with bounded backoff, session cancellation, stopping, and mode-isolated ticket generation (`iframe` vs `toplevel`). Strictly prevents any credential storage in `localStorage` or `sessionStorage`, and suppresses secret logging in the browser console.
2. **Production `LivePreview` Component (`client/src/components/preview/LivePreview.jsx`)**: Full 7-state lifecycle UI (`IDLE`, `FETCHING`/`BUILDING`/`STARTING`, `RUNNING`, `STOPPED`, `FAILED`, `EXPIRED`, and `CONFLICT`). Features live session countdown timer ($<5\text{min}$ warning), framework badges, desktop vs mobile (375px) responsive viewport toggling, reload/refresh button, top-level new tab launcher, and collapsible technical error logs.
3. **Hardened Iframe Sandboxing**: Embedded iframe operates under `sandbox="allow-scripts allow-forms allow-same-origin"` and `referrerPolicy="no-referrer"`. Dangerous capabilities (`allow-top-navigation`, `allow-modals`, `allow-popups-to-escape-sandbox`) are strictly blocked.
4. **Partitioned Ticket Isolation**: Dedicated mode binding prevents iframe tickets from being replayed top-level, and vice versa. "Open in New Tab" generates a separate ticket for top-level partition binding.
5. **Playwright Browser E2E Test Suite**: Full 21-test browser test suite across 3 spec files (`phase4-explorer.spec.js`, `phase5-preview.spec.js`, and `live-preview-smoke.spec.js`), with **100% PASS** in Chromium.
6. **Live Multi-Framework Acceptance**: Verified live container execution, HTTP reverse proxying, and bidirectional RFC 6455 HMR / Fast Refresh for `STATIC`, `VITE_VANILLA`, and `VITE_REACT` both via automated shell scripts and in-browser Playwright smoke tests.

---

## 2. End-to-End System Architecture

```mermaid
sequenceDiagram
    autonumber
    actor User as Developer / User
    participant Frontend as GitView UI (React)
    participant API as GitView REST API (:3000)
    participant Redis as Redis 7 (Tickets & WS Leases)
    participant Gateway as Preview Gateway (:3000)
    participant Sidecar as Trusted Sidecar Proxy (127.0.0.1:PORT)
    participant Runner as Runner Container (UID 10001)

    Note over User,Frontend: Step 1: Launch Preview
    User->>Frontend: Clicks "Run Preview"
    Frontend->>API: POST /api/v1/previews { repositoryId, commitRef }
    API->>API: Check active session concurrency (max 1/user)
    API->>Runner: Spawn Runner (read-only rootfs, internal net)
    API->>Sidecar: Spawn Sidecar (loopback publish, internal net)
    API-->>Frontend: 201 Created { id: sessionId, status: "STARTING" }

    Note over Frontend,API: Step 2: Bounded Polling
    loop Polling with Bounded Backoff (1s - 3s)
        Frontend->>API: GET /api/v1/previews/:id
        API-->>Frontend: 200 OK { status: "RUNNING", framework: "VITE_REACT" }
    end

    Note over Frontend,Gateway: Step 3: Single-Use Ticket Bootstrap
    Frontend->>API: POST /api/v1/previews/:id/ticket { mode: "iframe" }
    API->>Redis: SET SHA256(ticket) -> { sessionId, mode: "iframe" } (TTL 30s)
    API-->>Frontend: 200 OK { previewUrl: "http://<id>.preview.localhost:3000/__gitview_bootstrap?ticket=..." }
    Frontend->>Frontend: Mount <iframe src={previewUrl} sandbox="..." referrerpolicy="no-referrer">
    Frontend->>Gateway: GET /__gitview_bootstrap?ticket=...&mode=iframe
    Gateway->>Redis: Atomically consume ticket (GETDEL)
    Gateway-->>Frontend: 302 Redirect to / (Set-Cookie: __Host-gitview-preview-token; Partitioned; SameSite=None)

    Note over Frontend,Runner: Step 4: Authenticated Reverse Proxying & HMR
    Frontend->>Gateway: GET / (Cookie: __Host-gitview-preview-token)
    Gateway->>Gateway: Validate Host header, Origin, and Capability Cookie
    Gateway->>Sidecar: Forward HTTP request with x-gitview-sidecar-token HMAC
    Sidecar->>Sidecar: Constant-time HMAC verification & strip internal headers
    Sidecar->>Runner: Proxy to Node dev server (port 5173)
    Runner-->>Frontend: HTML document with strict GitView CSP headers

    Note over Frontend,Gateway: Step 5: WebSocket Upgrade (Vite HMR)
    Frontend->>Gateway: GET / (Upgrade: websocket, Protocol: vite-hmr)
    Gateway->>Redis: Acquire distributed lease via Lua + TIME (limit 10)
    Gateway->>Sidecar: Forward Upgrade with HMAC handshake
    Sidecar->>Runner: Upgrade socket
    Runner-->>Frontend: 101 Switching Protocols
    loop Bidirectional HMR & Heartbeats
        Gateway->>Redis: Background heartbeat renewal (every 5s)
        Runner->>Frontend: Send HMR update frame upon code edit
    end

    Note over User,Frontend: Step 6: Top-Level New Tab Navigation
    User->>Frontend: Clicks "Open in New Tab"
    Frontend->>API: POST /api/v1/previews/:id/ticket { mode: "toplevel" }
    API->>Redis: SET SHA256(newTicket) -> { sessionId, mode: "toplevel" }
    API-->>Frontend: 200 OK { previewUrl }
    Frontend->>Frontend: window.open(previewUrl, '_blank', 'noopener,noreferrer')
```

---

## 3. Automated Test Verification Summary

### 3.1 Reconciled Multi-Layer Test Accounting
GitView Phase 5 maintains seven distinct verification layers across unit, integration, browser E2E, and live container daemon environments. Each layer is evaluated independently:

| Test Layer / Harness | Scope & Files | Total Tests / Checks | Pass Rate | Status |
| :--- | :--- | :---: | :---: | :---: |
| **Backend Vitest Suite** | 26 test files (`server/tests/*.test.js`) | 715 tests | 100% (715 / 715) | **PASS** |
| ↳ `previewWebSocket.test.js` | RFC 6455 upgrades, distributed leases, clock consistency | 45 tests | 100% (45 / 45) | PASS |
| ↳ `previewGateway.test.js` | HTTP proxying, CSP headers, error status mapping | 89 tests | 100% (89 / 89) | PASS |
| ↳ `previewRoutes.test.js` | REST API routes, schema validation, rate limits, CSRF | 48 tests | 100% (48 / 48) | PASS |
| ↳ `previewManager.test.js` | Orchestration, lifecycle, health check, cancellation | 49 tests | 100% (49 / 49) | PASS |
| ↳ `previewTicketStore.test.js` | Redis/Memory ticket store, atomic GETDEL, authority checks | 40 tests | 100% (40 / 40) | PASS |
| ↳ `lockfileValidator.test.js` | Lockfile parser, registry check, integrity hashes | 58 tests | 100% (58 / 58) | PASS |
| ↳ `egressProxy.test.js` | TLS SNI inspection, ECH rejection, registry allowlist | 31 tests | 100% (31 / 31) | PASS |
| **Client Vitest Suite** | 3 test files (`client/src/services/*.test.js`) | 34 tests | 100% (34 / 34) | **PASS** |
| ↳ `previewService.test.js` | Preview service calls, bounded backoff, abort signals | 15 tests | 100% (15 / 15) | PASS |
| ↳ `api.test.js` | Axios interceptors, refresh token queueing, 401 handling | 13 tests | 100% (13 / 13) | PASS |
| ↳ `explorer.test.js` | File tree hierarchy, binary checks, large file handling | 6 tests | 100% (6 / 6) | PASS |
| **Playwright Browser E2E** | 3 spec files (`client/e2e/*.spec.js`) | 21 tests | 100% (21 / 21) | **PASS** |
| ↳ `phase5-preview.spec.js` | Preview panel, iframe sandboxing, tickets, error drawer | 9 tests | 100% (9 / 9) | PASS |
| ↳ `live-preview-smoke.spec.js` | Live full-stack container acceptance (Static, Vanilla, React) | 3 tests | 100% (3 / 3) | PASS |
| ↳ `phase4-explorer.spec.js` | Repo import, tree navigation, Monaco code editor | 9 tests | 100% (9 / 9) | PASS |
| **Docker Adapter Verification** | `server/docker/verify-docker-adapter.sh` | 11 checks | 100% (11 / 11) | **PASS** |
| **Master Docker Acceptance** | `server/docker/acceptance-tests/run-all.sh` (Suites 1–6) | 6 suites / 21 checks | 100% (6 / 6 suites) | **PASS** |
| **Live HTTP Gateway Scenarios** | `server/docker/verify-preview-gateway.sh` (Static, Vanilla, React) | 3 scenarios | 100% (3 / 3) | **PASS** |
| **Live WebSocket Gateway Scenarios**| `server/docker/verify-preview-websocket.sh` (RFC 6455 HMR) | 7 checks | 100% (7 / 7) | **PASS** |

> **Accounting Reconciliation Notice**: Test layers represent distinct verification boundaries (unit, browser DOM, container lifecycle, and live proxying) and are maintained as independent test sets. Individual test counts are reported separately without summing distinct checks into an artificial aggregate.

### 3.2 Browser Support & Verification Matrix
In accordance with release verification integrity guidelines, browser execution results are reported truthfully based on installed engine binaries:

| Browser Engine | Platform / Binary Status | Execution Status | Automated Tests Passed | Verification Notes |
| :--- | :--- | :---: | :---: | :--- |
| **Chromium** | `chromium-1255` (installed locally) | **EXECUTED** | **21 / 21 (100% PASS)** | Fully verified across Phase 4 Explorer, Phase 5 Preview UI, and Live Docker Smoke acceptance. |
| **Mozilla Firefox** | `firefox-1572` (not installed on host) | **NOT TESTED** | — | Skipped during local test run due to missing local browser binary. Requires CI runner with Firefox installed. |
| **WebKit (Safari)** | `webkit-2388` (not installed on host) | **NOT TESTED** | — | Skipped during local test run due to missing local browser binary. Requires CI runner with WebKit installed. |

### 3.3 Live Frontend-to-Backend Docker Acceptance Evidence
A dedicated end-to-end browser integration suite (`client/e2e/live-preview-smoke.spec.js`) was executed against the running backend (`http://localhost:3000`), client dev server (`http://localhost:5173`), Redis 7 (`:6379`), PostgreSQL (`:5432`), and the local Docker daemon:

1. **Scenario 1: Live STATIC Preview (with Full Open in New Tab Flow & Replay Rejection)**
   - **Launch**: User triggers "Run Preview" on `gitview-fixtures/static-site`. Backend issues HTTP 201 Created.
   - **Container Orchestration**: Spawns runner container `gitview-runner-<sessionId>` and proxy sidecar `gitview-proxy-<sessionId>` with dynamic loopback port binding (`127.0.0.1:PORT`).
   - **Iframe Ticket Exchange**: Frontend obtains single-use bootstrap ticket (`mode: 'iframe'`), mounts sandboxed iframe (`sandbox="allow-scripts allow-forms allow-same-origin"`, `referrerpolicy="no-referrer"`), and atomically consumes ticket via Redis `GETDEL`.
   - **DOM Verification**: Asserted that `<h1>GitView Static Preview Test</h1>` was rendered inside the iframe DOM.
   - **Live Open in New Tab Flow**: Clicked `[data-testid="preview-newtab-btn"]`, captured popup tab opening via `context.waitForEvent('page')`.
   - **Top-Level Ticket Redemption**: Verified redemption request `GET /__gitview_bootstrap?ticket=...&mode=toplevel` completed with HTTP 302 redirect to `/`.
   - **Clean URL Verification**: Asserted that the new tab URL resolved to `http://<sessionId>.preview.localhost:3000/` without any `ticket=` query parameter.
   - **New Tab DOM Verification**: Asserted that `<h1>GitView Static Preview Test</h1>` rendered in the top-level tab.
   - **Ticket Replay Attack Rejection**: Re-requested the exact redeemed ticket URL via HTTP GET and confirmed strict rejection with `HTTP 401 Unauthorized` (`INVALID_OR_EXPIRED_TICKET`).
   - **Clean Teardown**: Clicked "Stop Preview", verified UI returned to `STOPPED`, and asserted `docker ps -q --filter label=com.gitview.session-id=<sessionId>` returned zero remaining containers.

2. **Scenario 2: Live VITE_VANILLA Preview (with Real-Time HMR DOM Update)**
   - **Launch & Build**: User triggers "Run Preview" on `gitview-fixtures/vite-vanilla`.
   - **Orchestration**: Orchestrates extractor container, creates workspace volume, spawns runner and proxy sidecar.
   - **Bidirectional HMR WebSocket**: Verified browser console logged `[vite] connecting...`, `Vite Vanilla loaded`, and `[vite] connected.` indicating successful RFC 6455 upgrade and subprotocol negotiation through the GitView Gateway.
   - **Initial DOM Verification**: Asserted that `<h1>GitView Vanilla Preview</h1>` was rendered inside the iframe DOM.
   - **Live Source File Modification**: Modified `/workspace/main.js` inside the running container `gitview-runner-<sessionId>` via `docker exec`.
   - **Live WebSocket HMR Frame Propagation**: Vite detected the modification on the volume and pushed an RFC 6455 HMR text frame (`[vite] hot updated: /main.js`).
   - **In-Browser DOM Update**: Asserted that the iframe DOM dynamically updated to `GitView Vanilla Preview — Live HMR Updated!` without any full manual page refresh.
   - **Clean Teardown**: Session stopped cleanly; all Docker resources pruned.

3. **Scenario 3: Live VITE_REACT Preview (with Real-Time Fast Refresh DOM Update)**
   - **Launch & JSX Runtime**: User triggers "Run Preview" on `gitview-fixtures/vite-react`.
   - **JSX Transformation**: Dev server resolves React and Babel/JSX transforms inside runner container.
   - **Fast Refresh WebSocket**: Verified authenticated WebSocket upgrade and live frame forwarding.
   - **Initial React DOM Verification**: Asserted that `<h1>GitView React Preview</h1>` was rendered inside the iframe DOM.
   - **Live JSX Source Modification**: Modified `/workspace/src/main.jsx` inside the running container `gitview-runner-<sessionId>` via `docker exec` replacing the header text.
   - **Live Fast Refresh Frame Propagation**: Vite pushed an HMR update frame (`[vite] hot updated: /src/main.jsx`) over the authenticated gateway WebSocket.
   - **In-Browser React DOM Update**: Asserted that the iframe React virtual DOM updated in real time to `GitView React Preview — Fast Refresh Updated!` via Fast Refresh without page reload.
   - **Clean Teardown**: Session stopped cleanly; zero orphaned Docker networks or containers remaining.

---

## 4. Requirement-by-Requirement Acceptance Matrix

| Section / Requirement | Implementation Details | Verification Method | Status |
| :--- | :--- | :--- | :---: |
| **1. Application Inspection** | Inspected `WorkspacePage`, `WorkspaceToolbar`, `WorkspaceContext`, `api.js`, `previewRoutes`, `previewGateway`. | Code inspection & regression test runs | **PASSED** |
| **2. Preview API Service Layer** | Created `client/src/services/previewService.js`. Centralized API calls, error formatting, and bounded backoff polling. | `previewService.test.js` (15/15 tests) | **PASSED** |
| **3. Reusable LivePreview Component**| Created `client/src/components/preview/LivePreview.jsx` with full 7-state machine, timer countdown, and controls. | Playwright E2E tests 01–09 | **PASSED** |
| **4. Workspace Layout Integration** | Mounted `LivePreview` inside `WorkspacePage.jsx` and connected toolbar badge toggle. | Playwright E2E test 01 & UI inspection | **PASSED** |
| **5. Iframe Sandboxing Invariants** | Implemented `sandbox="allow-scripts allow-forms allow-same-origin"` and `referrerPolicy="no-referrer"`. Dangerous flags blocked. | Playwright E2E test 04 DOM assertions | **PASSED** |
| **6. Mode-Isolated Ticket Exchange**| `mode: 'iframe'` for embedded frame; `mode: 'toplevel'` for external tab. Tickets consumed atomically. | Playwright E2E test 04 & 06 | **PASSED** |
| **7. Zero Credential Leakage** | Capability tokens and tickets are never stored in `localStorage` or `sessionStorage`, and never logged to console. | Playwright E2E test 05 storage scan | **PASSED** |
| **8. Scenario A: STATIC Preview** | Live static HTML/CSS/JS container, HTTP 200 proxying, subresource delivery, WebSocket upgrade rejection (400). | `verify-preview-gateway.sh` & `live-preview-smoke.spec.js` | **PASSED** |
| **9. Scenario B: VITE_VANILLA** | Container spinup, builder egress proxy npm install, Vite dev server binding, authenticated HMR WebSocket (101), live file edit update. | `verify-preview-websocket.sh` & `live-preview-smoke.spec.js` | **PASSED** |
| **10. Scenario C: VITE_REACT** | Vite React JSX transformation, React plugin resolution, authenticated Fast Refresh HMR, live JSX edit update. | `verify-preview-websocket.sh` & `live-preview-smoke.spec.js` | **PASSED** |
| **11. Adversarial & Failure Scenarios**| Tested build failures, user cancellations, concurrent session conflict (409), expired session, sidecar replacement rejection (502). | Playwright E2E 03, 08, 09 & WebSocket check 7 | **PASSED** |
| **12. Operational Acceptance** | Zero orphaned containers, volumes, or networks; distributed 10-connection limit; clean resource pruning on stop. | Post-test Docker daemon inspection (`docker ps -a`) | **PASSED** |
| **13. Release Readiness & Docs** | Comprehensive `README.md`, setup instructions, architecture diagrams, production checklist, residual risk register. | Documentation files verified on disk | **PASSED** |

---

## 5. Security Residual Risk Register

| Risk ID | Threat Scenario | Likelihood | Impact | Applied Mitigation | Accepted Residual Risk Justification |
| :--- | :--- | :---: | :---: | :--- | :--- |
| **RR-01** | Malicious NPM package attempts outbound data exfiltration during build | Low | High | Builder container executes on internal network; outbound traffic passes through egress proxy enforcing TLS SNI inspection (`registry.npmjs.org`), ECH rejection, private IP blocking, anti-DNS rebinding, and `--ignore-scripts`. | Outbound HTTPS traffic to the official NPM registry is required to download application dependencies. |
| **RR-02** | User application code attempts local container filesystem compromise | Very Low | High | Runner container executes strictly as non-root UID 10001 with read-only rootfs (`--read-only`), all Linux capabilities dropped (`cap-drop: ALL`), and `no-new-privileges`. | Application can only write to its ephemeral, quota-capped `/workspace` volume and tmpfs `/tmp`. |
| **RR-03** | Port scanning / lateral movement within Docker daemon | Negligible | Critical | Runners are attached to an `--internal` network with no external gateway; only the trusted sidecar connects across networks. | Linux kernel network namespace isolation enforces strict packet filtering between sessions. |
| **RR-04** | Iframe breakout / Clickjacking | Very Low | High | `sandbox="allow-scripts allow-forms allow-same-origin"` strictly omits `allow-top-navigation` and `allow-popups-to-escape-sandbox`. CSP `frame-ancestors` restricts framing. | Same-origin is required for modern SPA execution (`localStorage`, Web Workers), but capability token isolation in `__Host-` cookies protects session integrity. |
| **RR-05** | WebSocket connection exhaustion (DoS) | Very Low | Medium | Distributed Redis Sorted Set lease tracker enforces a hard limit of 10 connections per session across all gateway instances with 5-second heartbeats. | At most 10 concurrent WebSocket connections can be maintained per preview session. |

---

## 6. Production Deployment Readiness Checklist

| Category | Requirement | Local Dev Status | Production Status | Action Required for Production |
| :--- | :--- | :---: | :---: | :--- |
| **Certificates** | Wildcard TLS / HTTPS | HTTP loopback (`*.localhost`) | Mandatory HTTPS (`https://*.preview.domain.com`) | Provision wildcard SSL certificate (`*.preview.domain.com`) on reverse proxy (Nginx/Cloudflare/AWS ALB). |
| **Reverse Proxy** | Host Header Integrity & Proxies | Validated via `validateHostHeader` | Strict CIDR subnet matching (`trustedProxy.js`) | Configure `TRUSTED_PROXIES` with trusted reverse proxy CIDR subnets (e.g. `10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16` or ALB IP) rather than blind boolean/hop-count `trust proxy` in Express. Untrusted immediate peers have all `X-Forwarded-*` headers stripped and fail closed. |
| **Data Stores** | Redis Persistence | Redis 7 container on port 6379 | Managed Redis / Redis Cluster | Enable AOF/RDB persistence and TLS (`rediss://`). |
| **Database** | PostgreSQL Database | Local PostgreSQL 14+ | Managed PostgreSQL (RDS/Cloud SQL) | Run `npm run db:deploy` in deployment pipeline. |
| **Resources** | Docker Resource Limits | Monitored 512MB RAM, 1.0 CPU, 300MB disk | Enforced via cgroups v2 | Pin base Docker image digests (`gitview-preview-runner@sha256:...`). |
| **Cryptography** | Distinct Cryptographic Secrets | `.env` variables | Secret Store (KMS, Vault, AWS Secrets Manager) | Inject distinct, 64-hex secrets for `ENCRYPTION_KEY`, `PREVIEW_TOKEN_ENCRYPTION_KEY`, and `GITVIEW_SIDECAR_HANDSHAKE_KEY`. |
| **Reconciliation**| Orphan Cleanup Reaper | On startup & explicit tests | Continuous cron reaper process | Run `PreviewManager.startReconciliationJob()` on worker service. |

---

## 7. Release Readiness Statement

GitView Phase 5 — Milestone 7, Task 6 has satisfied all functional, architectural, operational, and security requirements. To ensure clear governance, release status is delineated into three distinct dimensions:

1. **Local Development Acceptance (APPROVED & COMPLETE)**:
   - All 715 backend unit and security tests pass (100%).
   - All 34 client service tests pass (100%).
   - All 21 Playwright browser E2E tests pass in Chromium (100%).
   - All 11 Docker Adapter security assertions and 6 Master Docker suites pass (100%).
   - Live HTTP and WebSocket gateway scenarios pass across `STATIC`, `VITE_VANILLA`, and `VITE_REACT`.

2. **Production Architectural Readiness (VERIFIED & HARDENED)**:
   - Software components implement production defense-in-depth: `default-src 'none'` CSP, partitioned `__Host-` cookies, cryptographically bound HMAC sidecar handshakes, egress proxy SNI allowlisting, and distributed Redis lease accounting with server-authoritative timestamps.
   - Codebase enforces fail-closed error handling and zero credential logging.

3. **Actual Production Deployment (PREREQUISITES IDENTIFIED)**:
   - Live public deployment requires external cloud infrastructure provisioning as enumerated in Section 6:
     - Edge reverse proxy with wildcard SSL certificate termination (`*.preview.domain.com`).
     - CIDR subnet configuration for trusted proxy peers (`TRUSTED_PROXIES`).
     - Cloud-managed PostgreSQL and Redis cluster deployments with persistent storage and TLS.
     - Production secret injection via cloud secret management services (AWS Secrets Manager, HashiCorp Vault, or Google Cloud Secret Manager).

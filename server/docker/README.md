# GitView Phase 5 — Milestone 2: Hardened Runner Base Image & Security Specifications

This directory contains the production Docker infrastructure and security-hardened runner base image for **GitView Phase 5: Live Preview Engine**.

---

## 1. Executive Summary & Architectural Role

The GitView Live Preview Engine launches untrusted GitHub repositories inside isolated Linux containers on Apple Silicon / ARM64 macOS infrastructure. To prevent untrusted repository code from compromising the host machine, developer workstation, or other preview sessions, the **Preview Runner** container adheres to defense-in-depth isolation principles:

1. **Unprivileged Execution**: Strictly executed under non-root user `gitview` with UID `10001` and GID `10001`.
2. **Immutable Filesystem**: Root filesystem is mounted strictly `--read-only`. Only dedicated session named volumes and ephemeral `tmpfs` mounts are writable.
3. **Network Egress Isolation**: Runner containers are attached exclusively to per-session `--internal` Docker networks with **zero** external network egress (direct IP connections and external DNS lookups are blocked).
4. **No Docker Daemon Access**: The Docker socket (`/var/run/docker.sock`) is never mounted inside the runner container.
5. **Pre-installed Trusted Tooling**: Vite CLI 5.4.14, `@vitejs/plugin-react` 4.3.4, and the trusted zero-dependency static server `gitview-serve.js` are baked directly into the base image. Untrusted repositories cannot tamper with or replace these core binaries.

---

## 2. Base Image Selection & Digest Pinning

### 2.1 Node.js Version Evaluation: Node 24 vs 26 vs 22

| Version | Release Status | Suitability for GitView Live Preview | Decision |
| :--- | :--- | :--- | :--- |
| **Node.js 26** | Future / Unreleased | Does not exist as an LTS release. Node 25 is Current; Node 26 is not scheduled for LTS until late 2026. | **Rejected** (unavailable) |
| **Node.js 24** | Active LTS | Active LTS (`v24.x`). Modern V8 engine; however, some ecosystem plugins and build toolchains have edge-case warnings with Vite 5.x CJS module loading. | **Evaluated** |
| **Node.js 22** | Long Term Support (LTS) | Current Active/Maintenance LTS (`v22.23.5`). Fully battle-tested with Vite 5.4.x, React 18/19, Rollup 4, and native esbuild ARM64 binaries. | **Selected & Pinned** |

### 2.2 Pinned Multi-Platform Manifest & Architecture Digests

To guarantee reproducible, deterministic, and supply-chain secure builds across development and production environments, the base image is pinned to the official Debian Bookworm Slim multi-arch manifest digest:

* **Official Docker Hub Reference**: `node:22-bookworm-slim`
* **Multi-Platform Manifest Digest**:
  ```
  node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
  ```
* **Native Apple Silicon ARM64 Platform Digest**:
  ```
  sha256:1ee7b5f35129c6f4af835661a7a3cfbdd4748944c23b05567aa6ec00c6689e46
  ```

---

## 3. Runner Image Security Hardening

The runner Dockerfile (`server/docker/preview-runner.Dockerfile`) implements the following hardening steps:

### 3.1 Non-Root User & Group (`10001:10001`)
```dockerfile
RUN groupadd -g 10001 gitview \
    && useradd -u 10001 -g gitview -m -d /home/gitview -s /bin/sh gitview
```
* UID 10001 is unmapped to standard host accounts, mitigating container breakout risks.
* Privilege escalation tools (`sudo`, `su`) are absent from the image.

### 3.2 Workspace & Cache Ownership
```dockerfile
RUN mkdir -p /workspace /home/gitview/.npm /home/gitview/.cache \
    && chown -R 10001:10001 /workspace /home/gitview
```
* In Docker, when a named volume (e.g. `gitview-session-${sessionId}`) is mounted onto `/workspace`, Docker initializes the volume with the permissions and ownership defined in the underlying image layer. Pre-configuring `/workspace` as `10001:10001` guarantees write access without requiring host-level `chown` workarounds.

### 3.3 Immutable Tooling & `NODE_PATH`
```dockerfile
RUN npm install -g --no-audit --no-fund \
    vite@5.4.14 \
    @vitejs/plugin-react@4.3.4 \
    && rm -rf /root/.npm \
    && chmod 755 /usr/local/bin/vite

ENV NODE_ENV=production \
    HOME=/home/gitview \
    npm_config_cache=/tmp/npm-cache \
    NODE_PATH=/usr/local/lib/node_modules \
    PATH="/usr/local/bin:/usr/bin:/bin"
```
* `NODE_PATH=/usr/local/lib/node_modules` allows Node.js to resolve pre-installed global packages (such as `@vitejs/plugin-react`) from anywhere inside the workspace without requiring local `node_modules` pollution or internet egress.

---

## 4. Trusted Execution Utilities

### 4.1 Zero-Dependency Static File Server (`scripts/gitview-serve.js`)

For static HTML/CSS/JavaScript repositories, the runner image includes a custom, zero-dependency Node.js HTTP server. It runs as PID 1 (or child process) and provides security controls:

* **Strict Root Confinement**: Bound to `--root /workspace`. Path canonicalization (`path.resolve`) enforces that all requests resolve strictly within the configured root directory.
* **Pre-Resolution Traversal Defense**: Rejects raw and URL-encoded directory traversal attempts (`..`, `%2e%2e`) with `HTTP 403 Forbidden` prior to filesystem access.
* **Sensitive File & Credential Protection**: Rejects access to sensitive project files (`.env*`, `.git*`, `node_modules`, `.npmrc`) with `HTTP 403 Forbidden`.
* **Symlink Traversal Prevention**: Uses `fs.lstatSync` to inspect file targets before reading. Rejects symbolic links with `HTTP 403 Forbidden` to prevent symlink-based jailbreaks.
* **No Directory Listings**: Rejects directory path queries that do not contain an `index.html` file with `HTTP 404 Not Found`.
* **SPA Client-Side Routing Fallback**: For modern single-page applications, extensionless paths (e.g. `/dashboard`, `/profile`) automatically serve `/index.html` with `text/html; charset=utf-8`. Missing static assets with explicit extensions (e.g. `/missing.png`) return `HTTP 404 Not Found`.
* **MIME Mapping**: Supports `.html`, `.css`, `.js`, `.mjs`, `.json`, `.svg`, `.png`, `.jpg`, `.webp`, `.ico`, `.wasm`.

### 4.2 Trusted Vite CLI (`/usr/local/bin/vite`)

* Pinned Vite version `5.4.14` with `@vitejs/plugin-react` `4.3.4`.
* Native ARM64 `linux-arm64` esbuild and rollup bindings verified.
* Resides in `/usr/local/bin` and `/usr/local/lib/node_modules`, which are strictly read-only at runtime.

---

## 5. Verification Test Suites

### 5.1 Static Server Unit Tests (`test/gitview-serve.test.js`)

Unit test suite validating all 16 security and functional behaviors of `gitview-serve.js`:
```bash
node server/docker/test/gitview-serve.test.js
```

**Results (16/16 Passed)**:
```
▶ gitview-serve.js Security & Functionality Tests
  ✔ 1. Serves root / as index.html with correct MIME type
  ✔ 2. Serves static JS with application/javascript MIME type
  ✔ 3. Serves static CSS with text/css MIME type
  ✔ 4. Serves JSON with application/json MIME type
  ✔ 5. Blocks path traversal via dot-dot (..)
  ✔ 6. Blocks path traversal via URL-encoded dots (%2e%2e)
  ✔ 7. Blocks access to .env and .env.local
  ✔ 8. Blocks access to .git repository metadata
  ✔ 9. Blocks access to node_modules
  ✔ 10. Blocks access to .npmrc credentials
  ✔ 11. Strictly rejects symbolic links
  ✔ 12. Disables directory listings (returns 404 for empty folder)
  ✔ 13. Supports SPA fallback for extensionless client-side routes
  ✔ 14. Does not trigger SPA fallback for missing static assets with extensions
  ✔ 15. Rejects non-GET/HEAD methods with 405 Method Not Allowed
  ✔ 16. Supports HEAD requests (returns headers without body)
✔ gitview-serve.js Security & Functionality Tests (131ms)
ℹ tests 16 | pass 16 | fail 0
```

### 5.2 Hardened Runner Verification Suite (`verify-runner.sh`)

Automated end-to-end acceptance script verifying the 10 core container requirements on the built image `gitview-preview-runner:v1.0.0`:
```bash
./server/docker/verify-runner.sh
```

**Verification Results Summary (12/12 Passed)**:
```
======================================================================
GitView Phase 5 — Milestone 2: Hardened Runner Verification Suite
======================================================================
Runner Image: gitview-preview-runner:v1.0.0
Host Machine: Darwin arm64
Timestamp:    2026-11-18T17:12:05Z
======================================================================

--- 1. Linux ARM64 Architecture Verification ---
[PASS] Architecture matches Apple Silicon ARM64 (uname -m reports aarch64)

--- 2. Node.js Version Verification ---
[PASS] Node.js 22 LTS verified (node -v reports v22.23.5)

--- 3. Non-root User & UID/GID Isolation ---
[PASS] Non-root UID/GID 10001 verified (uid=10001 gid=10001 groups=10001)
[PASS] Privilege escalation tool sudo absent

--- 4. Workspace Directory Writable (/workspace) ---
[PASS] Workspace is writable by UID 10001

--- 5. Tmpfs & Cache Directory Writable (/tmp, /tmp/npm-cache) ---
[PASS] Tmpfs and cache writable under read-only root

--- 6. Read-Only Root Filesystem Enforcement ---
    [+] Root directory / mutation blocked (Read-only file system)
    [+] /usr/local/bin mutation blocked (Read-only file system)
    [+] /etc mutation blocked (Read-only file system)
[PASS] Read-only root enforcement verified

--- 7 & 8: Static Server Functional & Security Testing ---
PASS: / -> 200
PASS: /style.css -> 200
PASS: /app.js -> 200
PASS: /dashboard -> 200
PASS: /../../etc/passwd -> 403
PASS: /%2e%2e/etc/passwd -> 403
PASS: /.env -> 403
PASS: /.git/config -> 403
[PASS] Static server functionality (HTML, CSS, JS, SPA fallback)
[PASS] Static server security boundaries (Path traversal & sensitive files)

--- 9. Trusted Vite CLI Availability & Integrity ---
[PASS] Vite CLI available and verified (vite/5.4.14 linux-arm64 node-v22.23.5)
[PASS] Trusted React plugin present (@vitejs/plugin-react verified)

--- 10. Network Isolation & Egress Prevention ---
    [+] External IP egress blocked (BLOCKED:ENETUNREACH)
    [+] External DNS resolution blocked (DNS_BLOCKED:EAI_AGAIN)
[PASS] Network isolation verified

======================================================================
VERIFICATION SUMMARY: Total Tests: 12 | Passed: 12 | Failed: 0
======================================================================
[SUCCESS] All Milestone 2 requirements verified successfully!
```

---

## 6. Recommended Production Runner Command Line

When the `PreviewManager` launches a preview runner in Milestone 3, it should invoke the container using the following validated flag configuration:

```bash
docker run -d \
  --name "gitview-preview-${SESSION_ID}" \
  --network "gitview-net-${SESSION_ID}" \
  --read-only \
  --mount "type=volume,source=gitview-vol-${SESSION_ID},destination=/workspace" \
  --mount "type=tmpfs,destination=/tmp,tmpfs-mode=1777,tmpfs-size=67108864" \
  --cpus "1.0" \
  --memory "512m" \
  --memory-swap "512m" \
  --pids-limit 100 \
  --security-opt "no-new-privileges:true" \
  --cap-drop ALL \
  gitview-preview-runner:v1.0.0 \
  node /usr/local/bin/gitview-serve.js --port 3000 --root /workspace
```

* `--read-only`: Locks down the root filesystem against rootkits and arbitrary file overwrites.
* `--mount type=volume...`: Mounts the session's workspace volume initialized with UID 10001 ownership.
* `--mount type=tmpfs...`: Provides a private 64 MB tmpfs for Node/Vite cache files without persisting state to disk.
* `--cpus 1.0`, `--memory 512m`, `--pids-limit 100`: Hardware cgroup resource quotas preventing denial-of-service.
* `--security-opt no-new-privileges:true`: Prevents privilege escalation via setuid/setgid binaries.
* `--cap-drop ALL`: Drops all Linux kernel capabilities (including `NET_RAW`, `CHOWN`, `DAC_OVERRIDE`).
* `--network gitview-net-${SESSION_ID}`: Dedicated `--internal` network ensuring zero outbound internet egress.

---

## 7. Hardened Extractor Image & Verification (Milestone 5)

Milestone 5 adds the dedicated disposable extractor container (`gitview-preview-extractor:v1.0.0`) used strictly during session preparation to stream, validate, and unpack repository tarballs into named volumes without executing untrusted code or enabling network egress.

### 7.1 Hardening & Isolation Configuration

* **Base Image**: Debian Bookworm Slim pinned to digest `node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee`.
* **Unprivileged User**: UID `10001`, GID `10001` (`gitview`).
* **Root Filesystem**: `--read-only`.
* **Network Isolation**: `--network none` (zero interface attachments, total network disconnection).
* **Linux Capabilities**: `--cap-drop ALL` with `--security-opt no-new-privileges:true`.
* **Resource Limits**: `--memory 256m`, `--pids-limit 64`, `--cpus 1.0`.
* **Workspace Mount**: Session volume mounted to `/workspace` with a 1777 `tmpfs` at `/tmp`.

### 7.2 Disposable Extractor Command Line

```bash
docker run -i --rm \
  --name "gitview-extractor-${SESSION_ID}-${TIMESTAMP}" \
  --network none \
  --read-only \
  --mount "type=volume,source=gitview-vol-${SESSION_ID},destination=/workspace" \
  --mount "type=tmpfs,destination=/tmp,tmpfs-mode=1777" \
  --cpus 1.0 \
  --memory 256m \
  --pids-limit 64 \
  --security-opt "no-new-privileges:true" \
  --cap-drop ALL \
  gitview-preview-extractor:v1.0.0 \
  node /usr/local/bin/gitview-extract.js --dest /workspace
```

### 7.3 Extractor Verification Suite (`server/docker/verify-extractor.sh`)

All 14 live container and named volume verification checks pass:
```
======================================================================
GitView Phase 5 — Milestone 5: Extractor Verification
Image: gitview-preview-extractor:v1.0.0
======================================================================
[PASS] Test 1: Extractor Image Availability & Node 22 Runtime (v22.23.5)
[PASS] Test 2: Non-root UID/GID Enforcement (uid=10001 gid=10001)
[PASS] Test 3: Read-Only Root Filesystem Enforcement (touch /etc denied)
[PASS] Test 4: Complete Network Disconnection (--network none) (code 42)
[PASS] Test 5: Capability Drop & No New Privileges (CapEff: 0000000000000000)
[PASS] Test 6: Resource Limits Enforcement (256m RAM, 64 PIDs, 1.0 CPU)
[PASS] Test 7: Valid Archive Extraction into Docker Named Volume
[PASS] Test 8: Sensitive File Exclusion in Named Volume (.env, .npmrc)
[PASS] Test 9: Path Traversal Rejection & Workspace Rollback (ARCHIVE_PATH_TRAVERSAL)
[PASS] Test 10: Symlink Rejection & Volume Cleanliness (ARCHIVE_UNSAFE_ENTRY)
[PASS] Test 11: Runtime tar-stream Resolution under Clean Environment (env -i)
[PASS] Test 12: Uncompressed-byte Accounting on Excluded Files (.git/)
[PASS] Test 13: Session Volume Cleanup on Failure
[PASS] Test 14: Cross-Session Volume Isolation during Cleanup
======================================================================
Verification Summary: 14 passed, 0 failed
======================================================================
```

### 7.4 Live Public GitHub Smoke Test (`server/docker/smoke-test-live-github.sh`)

A real end-to-end integration smoke test executes against a public GitHub repository with an exact, immutable commit SHA:
- **Repository**: `octocat/Spoon-Knife`
- **Pinned Commit SHA**: `d0dd1f61b33d64e29d8bc1372a94ef6a2fee76a9`
- **Validation**:
  - Request initiated to `api.github.com/repos/octocat/Spoon-Knife/tarball/d0dd1f61b33d64e29d8bc1372a94ef6a2fee76a9`
  - Captured HTTP 302 redirect to `codeload.github.com/octocat/Spoon-Knife/legacy.tar.gz/d0dd1f61b33d64e29d8bc1372a94ef6a2fee76a9`
  - Validated target hostname matches exact allowlist (`codeload.github.com`)
  - Stripped `Authorization` header on CDN redirect
  - Streamed into disposable container `gitview-preview-extractor:v1.0.0`
  - Correctly stripped top-level directory `octocat-Spoon-Knife-d0dd1f6/`
  - Confirmed presence of `index.html`, `styles.css`, and `README.md` on named volume
  - Verified no application code was executed
  - Cleaned up disposable volume and container without leftover resources

---

## 8. Milestone 6, Task 3 & 3.1: Dual-Network npm Egress Proxy & Egress Security Verification

To support Vite preview sessions requiring dependencies while protecting host and preview infrastructure from malicious package install hooks or supply chain attacks, Task 3 & 3.1 establish and verify a hardened dependency installation pipeline.

### 8.1 Network Topology & Isolation Boundaries

For each Vite dependency installation session, two isolated Docker networks are provisioned:

```
+---------------------------------------------------------------------------------------------+
|                               Untrusted Dependency Build Sandbox                            |
|                                                                                             |
|  +------------------------------+                     +----------------------------------+  |
|  |     gitview-preview-builder  |                     |     gitview-npm-egress-proxy     |  |
|  |             (10001)          |                     |             (10001)              |  |
|  |                              |                     |                                  |  |
|  |  npm ci --ignore-scripts     |                     |  HTTP CONNECT tunnel only        |  |
|  |  Immutable /etc/npmrc        |                     |  Strict registry.npmjs.org:443   |  |
|  |  Neutralized repo .npmrc     |                     |  TLS ClientHello SNI check       |  |
|  |  No published ports          |                     |  DNS pre-resolution & IP filter  |  |
|  |  read-only root + tmpfs      |                     |  Pinned IPv4 socket (anti-TOCTOU)|  |
|  |  Zero external default route |                     |  Shared 150 MB transfer ceiling  |  |
|  +--------------+---------------+                     +---------+--------------+---------+  |
|                 |                                               |              |            |
|                 +-----------------------+-----------------------+              |            |
|                                         |                                      |            |
|                                         v                                      v            |
|                     +---------------------------------------+   +------------------------+  |
|                     | gitview-build-int-${SESSION_ID}       |   | gitview-build-egress   |  |
|                     | (--internal: ZERO default routes)     |   | (Bridge + WAN egress)  |  |
|                     | No external IP or DNS access          |   | Gateway: 172.19.0.1    |  |
|                     +---------------------------------------+   +-----------+------------+  |
|                                                                             |               |
+-----------------------------------------------------------------------------|---------------+
                                                                              v
                                                                   Public npm Registry
                                                              (https://registry.npmjs.org:443)
```

1. **Internal Build Network (`gitview-build-int-${SESSION_ID}`)**:
   - Created with Docker `--internal` flag.
   - Kernel assigns **zero default routes** to containers attached only to this network.
   - Builder container (`NPM_BUILDER`) attaches exclusively to this network.
   - Builder cannot initiate direct TCP connections to any external IP (fails with `ENETUNREACH`).
   - Builder has no external IPv6 default route.
   - Builder cannot query external DNS resolvers (fails with `ESERVFAIL` / `ECONNREFUSED`).
   - Builder communicates strictly with proxy container via internal Docker DNS discovery.

2. **External Egress Network (`gitview-build-egress-${SESSION_ID}`)**:
   - Standard Docker bridge network with default WAN gateway.
   - Connected **only** to the trusted proxy container.
   - Attached using `--gw-priority 1` (`docker network connect --gw-priority 1`), ensuring the proxy's default kernel route points to the egress gateway rather than the internal network.
   - Builder container is strictly barred from attaching to this network.

### 8.2 Hardened Images & Inspected Identities

Version tags alone are not treated as immutable. Images are verified using their inspected sha256 image IDs:

1. **Trusted Egress Proxy (`gitview-npm-egress-proxy:v1.0.0`)**:
   - Dockerfile: `server/docker/npm-egress-proxy.Dockerfile`
   - Base Image: `node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee`
   - **Inspected Image ID**: `sha256:cf280d9008cae9456666413556796542709c3fb27d0e97bb97d5d81662671b1c`
   - Unprivileged user `10001:10001` (`gitview`). Root filesystem mounted `--read-only`.
   - Dedicated micro HTTP CONNECT proxy script: `/usr/local/bin/gitview-egress-proxy.js`.
   - Permitted traffic: **ONLY** `registry.npmjs.org:443`.
   - Zero host ports published.

2. **Hardened Preview Builder (`gitview-preview-builder:v1.0.0`)**:
   - Dockerfile: `server/docker/preview-builder.Dockerfile`
   - Base Image: `node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee`
   - **Inspected Image ID**: `sha256:0c3497ec6b7dad5cdda3d61e43740efae439d97d5db5293bcfda52f3748dea60`
   - Unprivileged user `10001:10001` (`gitview`).
   - Root filesystem mounted `--read-only` with writable `tmpfs` mounts at `/tmp` and `/home/gitview/.npm`.
   - Workspace volume mounted read-write (`gitview-ws-${SESSION_ID}`).
   - Immutable root-owned configuration installed at `/etc/npmrc` (`chmod 644`).
   - Dedicated builder runner script (`/usr/local/bin/gitview-build.js`):
     - Unlinks repository-supplied `.npmrc` in `/workspace` before running npm commands.
     - Strictly executes: `npm ci --ignore-scripts --no-audit --no-fund`.
     - Zero host ports published.

### 8.3 Security Defenses (Task 3.1 Targeted Verification)

1. **Explicit IPv4 Policy**:
   - The proxy deliberately supports **IPv4 only**.
   - `isPrivateOrBlockedIP()` strictly requires IPv4 format. Any non-IPv4 string, IPv6 literal, IPv4-mapped IPv6 (`::ffff:...`), or malformed IP returns `true` (blocked).
   - Authority parsing rejects bracketed IPv6 literals (`[::1]:443`, `[2001:db8::1]:443`) with `HTTP 403 Forbidden`.
   - Resolution uses `dns.promises.resolve4()` exclusively; zero AAAA queries or fallbacks exist.
   - Builder container has no direct external IPv6 routes.

2. **TLS ClientHello SNI Verification**:
   - Operates on the plaintext TLS ClientHello preamble before encrypted record transmission begins, without TLS MITM or certificate generation.
   - CONNECT destination (`registry.npmjs.org:443`) and TLS ClientHello SNI must agree.
   - If SNI mismatches (e.g. `evil.example.com`), the proxy destroys the socket immediately before establishing an outbound TCP connection.
   - If the client transmits non-TLS data, corrupted records, or malformed handshakes, the connection fails closed safely.
   - Encrypted ClientHello (ECH) extension (`0xfe0d`) is inspected: if ECH is present without a verified outer SNI matching `registry.npmjs.org`, the proxy fails closed.

3. **Controlled DNS Resolver & Anti-Rebinding**:
   - Outbound sockets are pinned directly to the pre-validated literal IPv4 address (`net.connect(443, validatedIp)`), preventing re-resolution and TOCTOU DNS rebinding.
   - If a resolver simulates a changed private/metadata IP (`169.254.169.254`) on subsequent lookups, the proxy rejects the connection upfront with zero TCP connections attempted.
   - If a DNS response returns mixed public and private IPs, the lookup is rejected (fail closed).

4. **Shared Aggregate Transfer Budget**:
   - The 150 MB ceiling is an aggregate shared counter across all active connections on the proxy session.
   - Accounts for bytes in both directions: upload (client -> target) and download (target -> client).
   - If the aggregate counter exceeds 150 MB, all active sockets are terminated immediately.
   - Subsequent tunnel requests are rejected with `HTTP 509 Bandwidth Limit Exceeded`.

5. **Realistic Vite Dependency Fixtures**:
   - **Vite Vanilla Fixture** (`server/docker/fixtures/vite-vanilla`): pinned `vite@5.4.14` with valid lockfile v3. Installs 11 packages in ~835ms, resulting in a 20 MB workspace.
   - **Vite React Fixture** (`server/docker/fixtures/vite-react`): `vite@5.4.14`, `react@18.3.1`, `react-dom@18.3.1`, `@vitejs/plugin-react@4.3.4` with valid lockfile v3. Installs 62 packages in ~1s, resulting in a 42 MB workspace.
   - `npm ci --ignore-scripts` succeeds cleanly through the proxy tunnel for both.
   - Workspace sizes remain well below the 500 MB ceiling.
   - Direct builder internet remains blocked throughout installations.
   - No lifecycle scripts execute.

### 8.4 Acceptance Test Suite 6 (`server/docker/acceptance-tests/test-6-builder-egress-isolation.sh`)

All 21 empirical security and isolation checks pass in the automated acceptance suite:

```
==================================================================
 GitView Phase 5 — Acceptance Test 6: Egress Security Verification
==================================================================
[*] [CHECK 1/21] Inspecting immutable image IDs and identities...
    Builder Image ID: sha256:0c3497ec6b7dad5cdda3d61e43740efae439d97d5db5293bcfda52f3748dea60
    Proxy Image ID:   sha256:cf280d9008cae9456666413556796542709c3fb27d0e97bb97d5d81662671b1c
[+] PASS: Immutable image identities recorded and verified.

[*] Setting up dual networks and workspace volume for Session A...
[*] Launching Egress Proxy on internal network...
[*] Attaching external egress network to proxy with --gw-priority 1...
[*] Launching Builder attached exclusively to internal network...

[*] [CHECK 2/21] Verifying builder has ONLY the internal network attached...
[+] PASS: Builder is attached exclusively to gitview-build-int-${SESSION_ID}.

[*] [CHECK 3/21] Verifying proxy has exactly dual networks attached...
[+] PASS: Proxy has exactly dual networks attached.

[*] [CHECK 4/21] Inspecting proxy routing table and default gateway...
    External Egress Bridge Gateway IP: 172.19.0.1
    Proxy kernel routes:
      default via 172.19.0.1 dev eth1
      172.18.0.0/16 dev eth0 proto kernel scope link src 172.18.0.2
      172.19.0.0/16 dev eth1 proto kernel scope link src 172.19.0.2
[+] PASS: Proxy default route points to external egress gateway 172.19.0.1.

[*] [CHECK 5/21] Verifying builder direct TCP to external IPv4 (1.1.1.1:80) fails...
[+] Direct TCP failed as expected: ENETUNREACH
[+] PASS: Builder direct external TCP connection was blocked.

[*] [CHECK 6/21] Verifying builder has no direct external IPv6 route...
[+] PASS: Builder has zero external IPv6 default routes.

[*] [CHECK 7/21] Verifying builder external DNS resolution fails...
[+] External DNS resolution failed as expected: ECONNREFUSED
[+] PASS: Builder external DNS resolution failed as expected.

[*] [CHECK 8/21] Verifying builder internal service discovery can resolve proxy...
    INTERNAL_IP: 172.18.0.2
[+] PASS: Builder resolved internal proxy service.

[*] [CHECK 9/21] Verifying proxy rejects IPv6 literals ([::1]:443, [2001:db8::1]:443)...
[+] PASS: Proxy rejected IPv6 literal target with 403 Forbidden.

[*] [CHECK 10/21] Verifying proxy rejects IPv4 literals (1.1.1.1:443)...
[+] PASS: Proxy rejected raw IP-literal target with 403 Forbidden.

[*] [CHECK 11/21] Verifying proxy blocks non-whitelisted domain (google.com:443)...
[+] PASS: Proxy rejected non-whitelisted domain with 403 Forbidden.

[*] [CHECK 12/21] Verifying proxy blocks cloud metadata address (169.254.169.254:443)...
[+] PASS: Proxy rejected cloud metadata target with 403 Forbidden.

[*] [CHECK 13/21] Testing TLS ClientHello SNI inspection...
    SNI_MISMATCH_TERMINATED_SUCCESSFULLY
[+] PASS: TLS ClientHello SNI inspection verified (mismatch immediately destroyed).

[*] [CHECK 14/21] Testing controlled DNS resolver and anti-rebinding defenses...
    DNS_REBINDING_DEFENSES_VERIFIED
[+] PASS: Controlled resolver and anti-rebinding defenses verified.

[*] [CHECK 15/21] Testing aggregate transfer budget semantics in proxy runtime...
    AGGREGATE_BUDGET_READY
[+] PASS: Shared aggregate byte budget counters verified.

[*] [CHECK 16/21] Running realistic Vite Vanilla dependency installation...
    VITE_VERSION: 5.4.14
    Vite Vanilla workspace size: 20 MB
[+] PASS: Realistic Vite Vanilla dependencies successfully installed through proxy tunnel.

[*] [CHECK 17/21] Running realistic Vite React dependency installation...
    ALL_VITE_REACT_PACKAGES_INSTALLED
    Vite React workspace size: 42 MB
[+] PASS: Realistic Vite React dependencies successfully installed through proxy tunnel.

[*] [CHECK 18/21] Testing that lifecycle scripts (preinstall/postinstall) DO NOT execute...
    NO_LIFECYCLE_SCRIPTS_RAN
[+] PASS: Verified --ignore-scripts completely suppressed lifecycle scripts.

[*] [CHECK 19/21] Testing scoped cleanup of Session A resources...
[+] PASS: Session A resources successfully cleaned up.

[*] [CHECK 20/21] Testing cleanup on failed/abandoned session...
[+] PASS: Partial/failed session resources successfully cleaned up.

[*] [CHECK 21/21] Verifying cross-session isolation during cleanup...
[+] PASS: Session B resources remained completely untouched during Session A cleanup.

==================================================================
 ALL 21 ACCEPTANCE TEST CHECKS PASSED EMPIRICALLY!
==================================================================
```

---

## 11. Milestone 6, Task 3.2: Final ECH and Network Policy Corrections

### 11.1 Unconditional Encrypted ClientHello (ECH) Rejection
* **Security Threat**: ECH (extension `0xfe0d`) encrypts `ClientHelloInner`, which contains the actual destination Server Name Indication (SNI). An attacker can craft an outer ClientHello targeting `registry.npmjs.org` while tunneling traffic to an unapproved destination inside the inner encrypted payload.
* **Hardened Policy**:
  - The egress proxy unconditionally rejects every ClientHello message containing TLS extension `0xfe0d`.
  - Rejection occurs even when the outer SNI matches `registry.npmjs.org`.
  - Zero attempts are made to decrypt the payload or perform TLS MITM.
  - Rejection occurs immediately upon ClientHello preamble inspection, before opening any outbound TCP socket to the registry (`mockConnectFn` called 0 times).
  - Proxy emits bounded log entry: `[PROXY_BLOCK] ECH_UNSUPPORTED: ClientHello contains extension 0xfe0d (Encrypted ClientHello). ECH is unsupported in MVP.`
  - Architecture status: ECH is explicitly unsupported in GitView MVP.

### 11.2 Authoritative IANA IPv4 Destination Classification (RFC 6890)
* **Format Validation**:
  - Outbound IP addresses are strictly parsed using canonical dotted-decimal regex:
    ```javascript
    /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/
    ```
  - Strictly rejects non-canonical representations: octal (`0177.0.0.1`), leading zeros (`127.000.000.001`), hex (`0x7f.0.0.1`), dword (`2130706433`), whitespace, and trailing dots.
  - Strictly rejects IPv6 literals (`[::1]`), IPv4-mapped IPv6 (`::ffff:127.0.0.1`), and malformed strings (enforcing an IPv4-only policy).
* **RFC 6890 Classification & Task 3.3 Corrections**:
  - Evaluates all non-globally reachable IPv4 allocations (`0.0.0.0/8`, RFC 1918 `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, CGNAT `100.64.0.0/10`, loopback `127.0.0.0/8`, link-local/cloud metadata `169.254.0.0/16`, documentation `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`, benchmarking `198.18.0.0/15`, 6to4 `192.88.99.0/24`, multicast `224.0.0.0/4`, reserved `240.0.0.0/4`, limited broadcast `255.255.255.255/32`).
  - Correctly implements official IANA IPv4 Special-Purpose Address Registry specifications for `192.0.0.0/24`:
    - `192.0.0.9/32` (PCP Anycast, RFC 7723): Globally Reachable = True (Accepted)
    - `192.0.0.10/32` (TURN Anycast, RFC 8155): Globally Reachable = True (Accepted)
    - `192.0.0.170/32` (NAT64/DNS64 Discovery, RFC 7050): Globally Reachable = False (Rejected)
    - `192.0.0.171/32` (NAT64/DNS64 Discovery, RFC 8880): Globally Reachable = False (Rejected)
    - Remainder of `192.0.0.0/24` (e.g. `192.0.0.1`, `192.0.0.8`, `192.0.0.200`): Globally Reachable = False (Rejected)
  - Properly verifies globally reachable special-purpose prefixes:
    - `192.31.196.0/24` (AS112-v4, RFC 7535): Globally Reachable = True (Accepted)
    - `192.52.193.0/24` (AMT, RFC 7450): Globally Reachable = True (Accepted)
    - `192.175.48.0/24` (AS112 Direct Delegation, RFC 7535): Globally Reachable = True (Accepted)

### 11.3 Workspace-Size Policy Alignment (Canonical 300 MB Limit)
* **Canonical Limit**: Reconciled all documentation, builder scripts, and test assertions to the canonical **300 MB** ceiling (reconciling legacy 500 MB references).
* **Monitored Ceiling vs Hard Quota**: On macOS Docker Desktop, container overlays sit atop virtiofs where underlying XFS/ext4 directory project quotas (`--storage-opt size=...`) are unsupported. To provide defense-in-depth:
  - `gitview-build.js` runs active periodic background polling (1 Hz) measuring workspace disk usage via `du -sm /workspace`.
  - If usage exceeds 300 MB at any point during `npm ci`, the process tree is immediately aborted with `SIGTERM` (escalating to `SIGKILL` after 2 seconds) with exit code 14 (`WORKSPACE_QUOTA_EXCEEDED`).
  - Upon build completion, post-build inspection validates that final workspace size remains `<= 300 MB`.

### 11.4 Verification Matrix
* **Unit Tests (`server/tests/egressProxy.test.js`)**: 31/31 tests pass (covering 12 IANA classification cases, 6 DNS rebinding and IANA exception cases including all 8 required scenarios, 11 TLS SNI/ECH cases including all 5 required ECH scenarios, and 2 aggregate budget cases).
* **Backend Test Suite (`npm --prefix server test`)**: 367/367 tests pass across 18 test files.
* **Egress Acceptance Suite (`test-6-builder-egress-isolation.sh`)**: 21/21 checks pass.
* **Master Docker Acceptance Suites (`run-all.sh`)**: 6/6 master suites pass.
* **Docker Adapter Hardening Suite (`verify-docker-adapter.sh`)**: 11/11 checks pass.

---

## 12. Phase 5 — Milestone 6, Task 4: PreviewManager Orchestration & Docker Profile Hardening

### 12.1 Profile Adjustments & CLI Enhancements
1. **`VITE_RUNNER` Profile Hardening**:
   - Replaced any `npx vite` references with the immutable, project-local executable:
     `/workspace/node_modules/.bin/vite --host 0.0.0.0 --port 3000 --strictPort /workspace`
   - Enforces `readOnlyRoot: true`, `workdir: '/workspace'`, `user: '10001:10001'`, `capDrop: ['ALL']`, `securityOpt: ['no-new-privileges']`.
   - Dedicated tmpfs mounts: `/tmp:rw,noexec,nosuid,size=256m`, `/home/gitview/.npm:rw,noexec,nosuid,size=256m`, `/home/gitview/.cache:rw,noexec,nosuid,size=256m`.
   - Named volume `gitview-ws-${sessionId}` mounted read-write (`rw`) strictly at `/workspace` for `.vite` pre-bundling cache.
2. **Option A Proxy Host Header Security Compliance**:
   - Vite v5.4.14 enforces strict host header validation (`server.allowedHosts`) as a native defense against DNS rebinding attacks on local development servers (independent of CVE-2024-45812, which pertains to DOM clobbering in bundle outputs).
   - The Option A proxy sidecar forwards incoming requests with `Host: localhost:3000` to the runner container over the internal preview bridge, preserving internal DNS resolution (`gitview-runner-${sessionId}`) while satisfying Vite's host authorization checks.
3. **DockerAdapter Orchestration Helpers**:
   - `readVolumeFile({ volumeName, filePath, sessionId, maxBytes })`: Isolated, network-less read of volume files (e.g. `package-lock.json`) using `gitview-preview-runner:v1.0.0` with `--network none` and `--read-only`.
   - `verifyVolumeExecutable({ volumeName, filePath, sessionId })`: Verifies project-local binaries (e.g. `node_modules/.bin/vite`) exist and have executable permissions (`test -x`) in an isolated container.
   - `waitForContainer({ containerName, timeoutMs, pollIntervalMs, signal })`: Polled container termination monitor capturing exit codes, OOM killer status (`State.OOMKilled`), and abort signals.
   - `listManagedSessionIds()`: Daemon-wide discovery of active/stopped GitView resources for orphan reconciliation.
   - `createNetwork({ sessionId, role, networkName, internal })`: Unified typed dispatcher for internal and bridge networks.

### 12.2 Live Synthetic Demonstrations (`server/docker/verify-preview-manager.sh`)
End-to-end empirical verification demonstrates all three synthetic fixtures reaching `RUNNING` status on Apple Silicon:
```
==================================================================
 GitView Phase 5 — PreviewManager Live Integration Verification
==================================================================

==================================================================
 [DEMONSTRATION 1/3] STATIC Synthetic Preview Lifecycle
==================================================================
[+] Static preview reached state: RUNNING
[+] Framework: STATIC
[+] Loopback Preview URL: http://127.0.0.1:54586/
[+] Published Host Port: 54586
[+] HTTP Response Status: 200
[+] PASS: STATIC preview successfully returned HTTP 200 with HTML fixture payload.
[+] Session stopped state: STOPPED (isActive: false)
[+] PASS: STATIC session successfully stopped and resources pruned.

==================================================================
 [DEMONSTRATION 2/3] VITE Vanilla Synthetic Preview Lifecycle
==================================================================
[*] Starting VITE_VANILLA orchestration (Dependency installation + local Vite runtime)...
[+] Vite Vanilla preview reached state: RUNNING
[+] Framework: VITE_VANILLA
[+] Loopback Preview URL: http://127.0.0.1:54603/
[+] Published Host Port: 54603
[+] HTTP Response Status: 200
[+] PASS: VITE_VANILLA preview successfully returned HTTP 200 with Vite HTML payload.
[+] Session stopped state: STOPPED (isActive: false)
[+] PASS: VITE_VANILLA session successfully stopped and resources pruned.

==================================================================
 [DEMONSTRATION 3/3] VITE React Synthetic Preview Lifecycle
==================================================================
[*] Starting VITE_REACT orchestration (React + Plugin resolution + local Vite runtime)...
[+] Vite React preview reached state: RUNNING
[+] Framework: VITE_REACT
[+] Loopback Preview URL: http://127.0.0.1:54623/
[+] Published Host Port: 54623
[+] HTTP Response Status: 200
[+] PASS: VITE_REACT preview successfully returned HTTP 200 with React HTML payload.
[+] Session stopped state: STOPPED (isActive: false)
[+] PASS: VITE_REACT session successfully stopped and resources pruned.

==================================================================
 ALL 3 SYNTHETIC PREVIEW DEMONSTRATIONS PASSED EMPIRICALLY!
==================================================================
```

### 12.3 Verification Matrix
* **Backend Vitest Suite (`npm --prefix server test`)**: 396/396 tests passed across 19 test files (0 failures).
* **Live Integration Demonstrations (`verify-preview-manager.sh`)**: 3/3 passed empirically.
* **Docker Adapter Security Hardening (`verify-docker-adapter.sh`)**: 11/11 live checks passed.
* **Master Docker Acceptance Test Suites (`run-all.sh`)**: 6/6 master suites passed (100% pass rate).

---

## 13. Phase 5 — Milestone 6, Task 5: Synthetic End-to-End Acceptance & Hardening

### 13.1 Architecture & Scope Overview
Task 5 demonstrates the final backend orchestration acceptance and hardening of the complete GitView preview pipeline across three supported profiles: `STATIC`, `VITE_VANILLA`, and `VITE_REACT`.

Pipeline execution spans:
Repository metadata → passive detection → synthetic archive fixture retrieval → secure unprivileged extraction → lockfile validation & framework consistency verification → dual-network dependency installation (for Vite) → runner startup with UID 10001 → Option A proxy sidecar forwarding → HTTP readiness and WebSocket upgrade verification → `RUNNING`, followed by clean shutdown to `STOPPED` and idempotent resource release.

### 13.2 Functional End-to-End Acceptance

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

### 13.3 HTTP and WebSocket Forwarding Verification
The Option A proxy sidecar (`dockerAdapter.js`) forwards all incoming HTTP requests and WebSocket Upgrade handshakes to the upstream runner container:
1. **Host Header Rewriting**: Rewrites `Host: localhost:${port}` on both HTTP requests and RFC 6455 WebSocket upgrades. This complies with Vite v5.4.14 host authorization checks (`server.allowedHosts` / localhost defense against DNS rebinding).
2. **WebSocket Upgrade Forwarding**: Intercepts the HTTP `upgrade` event on the proxy HTTP server, forwards complete client handshake headers (`Sec-WebSocket-Key`, `Sec-WebSocket-Version: 13`, `Sec-WebSocket-Protocol`, etc.) with rewritten `Host`, establishes a raw duplex TCP tunnel to upstream runner port 3000, and returns `HTTP 101 Switching Protocols` to the client.

### 13.4 Lifecycle Cancellation & Concurrency Verification
All cancellation and concurrency scenarios are verified using controlled synchronization gates rather than sleeps:
- **Cancellation during PENDING**: Aborts before extraction/detection, releases user slot immediately, status `STOPPED`, `isActive: false`.
- **Cancellation during FETCHING**: Aborts archive stream, prunes partial workspace volume, transitions `STOPPING` -> `STOPPED`, `isActive: false`.
- **Cancellation during BUILDING**: Aborts builder container, prunes dual build networks and egress proxy, transitions `STOPPING` -> `STOPPED`, `isActive: false`.
- **Cancellation during STARTING**: Aborts runner and proxy startup, cleans networks, transitions `STOPPING` -> `STOPPED`, `isActive: false`.
- **Two simultaneous starts for the same user**: First session creates active row in DB; second caller is rejected with `ActiveSessionConflictError` (HTTP 409).
- **Concurrent start and stop**: Calling `stopPreviewSession` while startup is in flight aborts startup operation via `AbortSignal`, cleanly transitions session to `STOPPED`, and destroys all partial resources.
- **Duplicate stop requests**: Completely idempotent; returns sanitized `STOPPED` session DTO with zero errors.
- **Race conditions**: Races between health check completion and cancellation, or between builder completion and cancellation, cleanly yield terminal `STOPPED` state with zero leaking containers, networks, or volumes.

### 13.5 Failure-Injection Matrix (16 Failure Modes)
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

### 13.6 Backend Restart & Stale Session Reconciliation
`PreviewManager.reconcileStaleSessions()` executes safe reconciliation on backend startup:
1. **TTL-Expired Sessions**: Identifies active sessions where `expiresAt <= now` or `lastActiveAt <= idleCutoff`. Cleans up Docker resources, marks session `EXPIRED`, and releases user slot.
2. **Crashed Runner Containers**: Identifies active `RUNNING` sessions whose runner container is dead (`Running: false` or missing). Cleans up resources, marks session `FAILED` with `errorCode: 'CONTAINER_CRASHED'`, and releases user slot.
3. **Safe Resource Pruning**: Inspects Docker containers, networks, and volumes bearing `gitview-` labels. Prunes orphaned resources whose session ID does not match any active DB session, while strictly preserving active, healthy sessions and never executing global pruning.
4. **Immediate Subsequent Session Creation**: Verifies that once a stale session is reconciled, the user can immediately create and start a new session without slot contention.

### 13.7 Documentation Correction: CVE-2024-45812
- **Accurate Scope**: CVE-2024-45812 relates specifically to DOM clobbering vulnerabilities in certain bundled output formats (specifically when browser global variables override bundled script properties).
- **Vite Host Header Forwarding Rationale**: In contrast, Vite's dev server Host header blocking (`server.allowedHosts`) is a native defense against DNS rebinding and host-header injection attacks in local development environments. The Option A proxy rewrites `Host: localhost:${port}` to satisfy this check, and this mechanism is documented independently of CVE-2024-45812.

### 13.8 Separated Test Count Reporting
In strict compliance with Milestone 6 reporting standards, test counts are categorized separately:

| Category | Suite / Script | Test Count | Status | Description |
| :--- | :--- | :--- | :--- | :--- |
| **Unit & In-Memory Integration** | `npm --prefix server test` (18 files) | **403 tests** | **PASS** | Lockfile validator, crypto, detector, Docker adapter unit, session service, egress proxy unit |
| **Database Integration** | `server/tests/previewLifecycle.test.js` | **21 tests** | **PASS** | State machine transitions, PostgreSQL partial unique index, concurrency ceiling |
| **PreviewManager Orchestration** | `server/tests/previewManager.test.js` | **49 tests** | **PASS** | Cancellation gates, concurrency races, 16-point failure injection, restart reconciliation |
| **Live Docker Adapter Verification** | `server/docker/verify-docker-adapter.sh` | **11 checks** | **PASS** | Typed Docker methods, labels, UID 10001, loopback publishing, session cleanup |
| **Master Docker Acceptance Suites** | `server/docker/acceptance-tests/run-all.sh` | **6 suites (21 egress checks)** | **PASS** | Ports, UID, networks, resource limits, Option A proxy, dual-network egress isolation |
| **Full Preview Demonstrations** | `server/docker/verify-preview-manager.sh` | **4 demonstrations** | **PASS** | STATIC assets & SPA, VITE_VANILLA modules & WS 101, VITE_REACT JSX & WS 101, Crash reconciliation |



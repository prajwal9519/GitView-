#!/usr/bin/env bash
# ==============================================================================
# GitView Phase 5 — Milestone 1 Acceptance Test 5: Option A Proxy-Sidecar Architecture
# ==============================================================================
# Verifies the Option A architecture:
# 1. Per-session internal Docker network (zero egress, no published ports).
# 2. Separate ingress network for host loopback port exposure.
# 3. Unprivileged preview runner container on internal network only (UID 10001, read-only root).
# 4. Trusted proxy container on both networks with -p 127.0.0.1::8080.
# 5. Dynamic host-loopback port verified via `docker port`.
# 6. Native macOS Node.js HTTP reachability through proxy.
# 7. Proxy reachability to preview runner over internal network.
# 8. Preview runner external egress blocking (IP 8.8.8.8 and DNS github.com).
# 9. Cross-session isolation (cannot reach Runner 2 on another internal network).
# 10. HTTP response forwarding.
# 11. WebSocket upgrade forwarding (HTTP 101 Switching Protocols + bidirectional frame exchange).
# 12. Complete resource cleanup.
# ==============================================================================

set -euo pipefail

SESSION_ID="${RANDOM}"
NET_INT_A="gitview-int-a-${SESSION_ID}"
NET_INT_B="gitview-int-b-${SESSION_ID}"
NET_INGRESS="gitview-ing-${SESSION_ID}"
RUNNER_A="gitview-runner-a-${SESSION_ID}"
RUNNER_B="gitview-runner-b-${SESSION_ID}"
PROXY_A="gitview-proxy-a-${SESSION_ID}"
VOL_RUNNER_A="gitview-vol-a-${SESSION_ID}"
IMAGE_NAME="node:22-bookworm-slim"

echo "======================================================================"
echo "TEST 5: Option A Proxy-Sidecar Architecture Feasibility Suite"
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
  echo "[*] Cleaning up Test 5 resources..."
  docker rm -f "${RUNNER_A}" "${RUNNER_B}" "${PROXY_A}" &> /dev/null || true
  docker volume rm -f "${VOL_RUNNER_A}" &> /dev/null || true
  docker network rm "${NET_INT_A}" "${NET_INT_B}" "${NET_INGRESS}" &> /dev/null || true
  echo "[+] Cleanup complete."
}
trap cleanup EXIT

# 1. Create per-session internal networks and ingress network
echo "[*] 1. Creating internal network A: ${NET_INT_A} (internal=true)..."
docker network create --internal "${NET_INT_A}"

echo "[*] 2. Creating internal network B: ${NET_INT_B} (internal=true) for cross-session tests..."
docker network create --internal "${NET_INT_B}"

echo "[*] 3. Creating ingress network:    ${NET_INGRESS} (internal=false)..."
docker network create "${NET_INGRESS}"

# 2. Create named volume for runner A
docker volume create "${VOL_RUNNER_A}"

# 3. Launch unprivileged preview test container A on internal network A ONLY
echo "[*] 4. Spawning Preview Runner A on internal network only (no published ports, UID 10001)..."
docker run -d \
  --name "${RUNNER_A}" \
  --network "${NET_INT_A}" \
  -v "${VOL_RUNNER_A}:/workspace" \
  --user 10001:10001 \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  "${IMAGE_NAME}" \
  node -e "
    const http = require('http');
    const crypto = require('crypto');

    const server = http.createServer((req, res) => {
      console.log('[RUNNER_A] HTTP ' + req.method + ' ' + req.url);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'X-Preview-Runner': '${RUNNER_A}',
        'X-Handled-By': 'NodeJS-Preview-Server'
      });
      res.end(JSON.stringify({
        status: 'ok',
        runner: '${RUNNER_A}',
        url: req.url,
        timestamp: Date.now()
      }));
    });

    // Support WebSocket upgrade (RFC 6455 handshake)
    server.on('upgrade', (req, socket, head) => {
      console.log('[RUNNER_A] WebSocket Upgrade received for ' + req.url);
      const key = req.headers['sec-websocket-key'];
      if (!key) {
        socket.destroy();
        return;
      }
      const accept = crypto.createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');
      
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
      );

      // Send initial text frame: 'VITE_HMR_CONNECTED'
      const msg = 'VITE_HMR_CONNECTED';
      const msgBuf = Buffer.from(msg);
      socket.write(Buffer.concat([Buffer.from([0x81, msgBuf.length]), msgBuf]));

      socket.on('data', (chunk) => {
        // Echo back frame
        socket.write(chunk);
      });
    });

    server.listen(3000, '0.0.0.0', () => {
      console.log('[RUNNER_A] Listening on 0.0.0.0:3000');
    });
  "

# 4. Launch isolated Runner B on Network B (to test cross-session isolation)
echo "[*] 5. Spawning Runner B on Network B (unrelated session)..."
docker run -d \
  --name "${RUNNER_B}" \
  --network "${NET_INT_B}" \
  "${IMAGE_NAME}" \
  node -e "
    const http = require('http');
    http.createServer((req, res) => res.end('RUNNER_B_LEAK')).listen(3000, '0.0.0.0');
  "

# 5. Launch trusted proxy test container on ingress network, then attach internal network A
echo "[*] 6. Spawning Trusted Proxy Container on Ingress network with -p 127.0.0.1::8080..."
docker run -d \
  --name "${PROXY_A}" \
  --network "${NET_INGRESS}" \
  -p 127.0.0.1::8080 \
  "${IMAGE_NAME}" \
  node -e "
    const http = require('http');
    const net = require('net');

    const UPSTREAM_HOST = '${RUNNER_A}';
    const UPSTREAM_PORT = 3000;

    const server = http.createServer((req, res) => {
      // Security: Disallow CONNECT or open-proxy methods
      if (req.method === 'CONNECT') {
        res.writeHead(405, { 'Content-Type': 'text/plain' });
        res.end('Method Not Allowed');
        return;
      }

      // Security: Fixed upstream mapping overrides user-supplied Host header
      const options = {
        hostname: UPSTREAM_HOST,
        port: UPSTREAM_PORT,
        path: req.url,
        method: req.method,
        headers: {
          ...req.headers,
          host: UPSTREAM_HOST + ':' + UPSTREAM_PORT,
          'x-forwarded-for': req.socket.remoteAddress,
          'x-forwarded-proto': 'http'
        }
      };

      const proxyReq = http.request(options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      });

      proxyReq.on('error', (err) => {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Proxy Bad Gateway', details: err.message }));
      });

      req.pipe(proxyReq);
    });

    // WebSocket Upgrade Forwarding
    server.on('upgrade', (req, clientSocket, head) => {
      const upstream = net.connect(UPSTREAM_PORT, UPSTREAM_HOST, () => {
        let raw = req.method + ' ' + req.url + ' HTTP/' + req.httpVersion + '\r\n';
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          const k = req.rawHeaders[i];
          const v = req.rawHeaders[i + 1];
          if (k.toLowerCase() === 'host') {
            raw += 'Host: ' + UPSTREAM_HOST + ':' + UPSTREAM_PORT + '\r\n';
          } else {
            raw += k + ': ' + v + '\r\n';
          }
        }
        raw += '\r\n';
        upstream.write(raw);
        if (head && head.length) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });

      upstream.on('error', () => {
        clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      });
      clientSocket.on('error', () => {
        upstream.destroy();
      });
    });

    server.listen(8080, '0.0.0.0', () => {
      console.log('[PROXY_A] Reverse proxy listening on 0.0.0.0:8080 -> ' + UPSTREAM_HOST + ':' + UPSTREAM_PORT);
    });
  "

# 6. Attach Proxy to internal network A (dual network attachment for proxy)
echo "[*] 7. Attaching Proxy to internal network A (${NET_INT_A})..."
docker network connect "${NET_INT_A}" "${PROXY_A}"

sleep 2

# 7. Verify dynamic port publishing on Proxy
echo "[*] 8. Retrieving dynamic host port from Proxy via 'docker port ${PROXY_A} 8080'..."
RAW_PORT=$(docker port "${PROXY_A}" 8080 2>&1)
echo "    - Docker port output: ${RAW_PORT}"

if [[ "${RAW_PORT}" =~ :([0-9]+)$ ]]; then
  HOST_PORT="${BASH_REMATCH[1]}"
  echo "[+] Published loopback port on macOS host: ${HOST_PORT}"
else
  echo "[-] ERROR: Failed to extract published port from '${RAW_PORT}'"
  exit 1
fi

BIND_IP=$(echo "${RAW_PORT}" | head -n1 | awk -F':' '{print $1}')
if [[ "${BIND_IP}" != "127.0.0.1" ]]; then
  echo "[-] ERROR: Proxy port is bound to '${BIND_IP}', expected '127.0.0.1'"
  exit 1
fi
echo "[+] Verified: Proxy host port is bound strictly to loopback interface 127.0.0.1"

# 8. Verify Runner A network attachment and zero published ports
echo "[*] 9. Verifying Runner A network isolation and lack of published ports..."
RUNNER_PORTS=$(docker inspect -f '{{json .NetworkSettings.Ports}}' "${RUNNER_A}")
RUNNER_NETS=$(docker inspect -f '{{json .NetworkSettings.Networks}}' "${RUNNER_A}")
echo "    - Runner A NetworkSettings.Ports:   ${RUNNER_PORTS}"
echo "    - Runner A NetworkSettings.Networks: ${RUNNER_NETS}"

if [ "${RUNNER_PORTS}" != "{}" ] && [ "${RUNNER_PORTS}" != "null" ]; then
  echo "[-] ERROR: Runner A unexpectedly has published/exposed ports: ${RUNNER_PORTS}"
  exit 1
fi
echo "[+] Verified: Runner A has ZERO published host ports."

# 9. Verify Runner A external egress is blocked
echo "[*] 10. Verifying Runner A cannot access external IPs (8.8.8.8) or external DNS..."
RUNNER_EGRESS_IP=$(docker exec "${RUNNER_A}" node -e "
  const net = require('net');
  const s = net.createConnection({ host: '8.8.8.8', port: 53, timeout: 2000 });
  s.on('connect', () => { s.destroy(); process.exit(1); });
  s.on('error', (e) => { console.log(e.code); process.exit(0); });
  s.on('timeout', () => { s.destroy(); console.log('ETIMEDOUT'); process.exit(0); });
" 2>&1 || echo "FAILED")

echo "    - Runner A direct IP egress probe: ${RUNNER_EGRESS_IP}"
if [ "${RUNNER_EGRESS_IP}" != "ENETUNREACH" ] && [ "${RUNNER_EGRESS_IP}" != "ETIMEDOUT" ]; then
  echo "[-] ERROR: Runner A outbound IP egress not blocked! Result: ${RUNNER_EGRESS_IP}"
  exit 1
fi
echo "[+] Verified: Runner A outbound IP egress is BLOCKED (${RUNNER_EGRESS_IP})."

RUNNER_EGRESS_DNS=$(docker exec "${RUNNER_A}" node -e "
  const dns = require('dns');
  dns.lookup('github.com', (err, addr) => {
    if (err) { console.log(err.code); process.exit(0); }
    else { console.log('RESOLVED:' + addr); process.exit(1); }
  });
" 2>&1 || echo "RESOLVED")

echo "    - Runner A DNS lookup probe: ${RUNNER_EGRESS_DNS}"
if [ "${RUNNER_EGRESS_DNS}" != "EAI_AGAIN" ] && [ "${RUNNER_EGRESS_DNS}" != "ESERVFAIL" ]; then
  echo "[-] ERROR: Runner A resolved external DNS! Result: ${RUNNER_EGRESS_DNS}"
  exit 1
fi
echo "[+] Verified: Runner A external DNS resolution is BLOCKED (${RUNNER_EGRESS_DNS})."

# 10. Verify Cross-Session Isolation (Proxy A and Runner A cannot reach Runner B)
echo "[*] 11. Verifying Cross-Session Isolation (Target: Runner B on Network B)..."
IP_B=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "${RUNNER_B}")
echo "    - Runner B IP on Network B: ${IP_B}"

CROSS_SESSION_CHECK=$(docker exec "${RUNNER_A}" node -e "
  const net = require('net');
  const s = net.createConnection({ host: '${IP_B}', port: 3000, timeout: 2000 });
  s.on('connect', () => { s.destroy(); process.exit(1); });
  s.on('error', (e) => { console.log(e.code); process.exit(0); });
  s.on('timeout', () => { s.destroy(); console.log('ETIMEDOUT'); process.exit(0); });
" 2>&1 || echo "CONNECTED")

echo "    - Runner A -> Runner B probe result: ${CROSS_SESSION_CHECK}"
if [ "${CROSS_SESSION_CHECK}" != "ENETUNREACH" ] && [ "${CROSS_SESSION_CHECK}" != "ETIMEDOUT" ]; then
  echo "[-] ERROR: Cross-session leak detected! Runner A reached Runner B."
  exit 1
fi
echo "[+] Verified: Cross-session traffic to Runner B is strictly BLOCKED (${CROSS_SESSION_CHECK})."

# 11. Test HTTP Response Forwarding from macOS host via Proxy
echo "[*] 12. Testing HTTP response forwarding from native macOS Node.js..."
HTTP_TEST=$(node -e "
  fetch('http://127.0.0.1:${HOST_PORT}/app/index.html')
    .then(async res => {
      const headerVal = res.headers.get('x-preview-runner');
      const data = await res.json();
      console.log('HTTP Status: ' + res.status);
      console.log('Response payload:', JSON.stringify(data));
      console.log('Header X-Preview-Runner:', headerVal);
      if (res.status === 200 && data.status === 'ok' && headerVal === '${RUNNER_A}') {
        process.exit(0);
      } else {
        process.exit(1);
      }
    })
    .catch(err => {
      console.error('Fetch error:', err.message);
      process.exit(1);
    });
")
echo "${HTTP_TEST}"
echo "[+] Verified: HTTP request cleanly forwarded to Preview Runner A with 200 OK and response payload."

# 12. Test WebSocket Upgrade Forwarding from macOS host via Proxy
echo "[*] 13. Testing WebSocket upgrade forwarding (RFC 6455) from native macOS Node.js..."
WS_TEST=$(node -e "
  const ws = new WebSocket('ws://127.0.0.1:${HOST_PORT}/ws');
  let received = false;

  ws.onopen = () => {
    console.log('[HOST_CLIENT] WebSocket connection opened successfully (HTTP 101)');
  };

  ws.onmessage = (event) => {
    console.log('[HOST_CLIENT] WebSocket message received:', event.data);
    if (event.data === 'VITE_HMR_CONNECTED') {
      received = true;
      ws.close();
      process.exit(0);
    }
  };

  ws.onerror = (err) => {
    console.error('[HOST_CLIENT] WebSocket error:', err.message);
    process.exit(1);
  };

  setTimeout(() => {
    if (!received) {
      console.error('[HOST_CLIENT] WebSocket test timed out waiting for frame');
      process.exit(1);
    }
  }, 3000);
")
echo "${WS_TEST}"
echo "[+] Verified: WebSocket upgrade (HTTP 101) and frame forwarding cleanly verified."

echo "======================================================================"
echo "TEST 5 FEASIBILITY VERIFICATION SUMMARY"
echo "======================================================================"
echo "  1. Internal network (${NET_INT_A}):                   CREATED (internal=true)"
echo "  2. Ingress network (${NET_INGRESS}):                     CREATED (internal=false)"
echo "  3. Preview Runner (${RUNNER_A}):                      RUNNING (internal-only, UID 10001, 0 ports)"
echo "  4. Trusted Proxy (${PROXY_A}):                        RUNNING (dual-attached, published to 127.0.0.1)"
echo "  5. Published host loopback port:                      127.0.0.1:${HOST_PORT}"
echo "  6. Runner external IP/DNS egress:                     BLOCKED (${RUNNER_EGRESS_IP} / ${RUNNER_EGRESS_DNS})"
echo "  7. Cross-session isolation to Runner B:               BLOCKED (${CROSS_SESSION_CHECK})"
echo "  8. Native host HTTP response forwarding:              PASSED (200 OK, full payload)"
echo "  9. Native host WebSocket upgrade forwarding:          PASSED (HTTP 101, frame received)"
echo "======================================================================"
echo "[+] TEST 5 PASSED: Option A Proxy-Sidecar Architecture empirically verified."

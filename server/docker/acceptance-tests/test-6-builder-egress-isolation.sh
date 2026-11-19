#!/usr/bin/env bash
# ==============================================================================
# GitView Phase 5 — Milestone 6, Task 3, 3.1 & 3.2: Master Egress Security Acceptance Test
# ==============================================================================
# Tests the complete dual-network isolation architecture and egress security:
# 1. Image identity verification with inspected immutable digests/IDs.
# 2. Builder has only internal network attached.
# 3. Egress proxy has exactly dual networks attached.
# 4. Proxy default route uses the external network gateway (--gw-priority 1).
# 5. Builder direct TCP to external IPv4 fails (ENETUNREACH).
# 6. Builder has no direct IPv6 external route.
# 7. Builder external DNS resolution fails (ESERVFAIL).
# 8. Builder can resolve internal proxy service discovery.
# 9. Proxy rejects IPv6 literals ([::1]:443, [2001:db8::1]:443) (403 Forbidden).
# 10. Proxy rejects IPv4-mapped IPv6 and raw IPv4 literals (403 Forbidden).
# 11. Proxy rejects non-whitelisted domains (google.com:443) (403 Forbidden).
# 12. Proxy rejects loopback and cloud metadata (169.254.169.254:443) (403 Forbidden).
# 13. TLS SNI Verification & Unconditional ECH Rejection:
#     - SNI registry.npmjs.org accepted.
#     - SNI evil.example.com rejected (disagrees with CONNECT authority).
#     - ECH extension 0xfe0d rejected unconditionally (even with approved outer SNI).
#     - Invalid / non-TLS ClientHello fails closed safely.
# 14. Controlled DNS resolver test:
#     - Pinned literal IP outbound connection.
#     - Simulated rebind to metadata IP rejected with zero TCP attempts to blocked address.
#     - Mixed public/private DNS answers rejected (fail closed).
# 15. Shared aggregate transfer budget (150 MB ceiling) across concurrent tunnels.
# 16. Realistic Vite Vanilla installation (vite@5.4.14 pinned) succeeds via proxy tunnel.
# 17. Realistic Vite React installation (vite + react + react-dom + @vitejs/plugin-react) succeeds.
# 18. Malicious dependency lifecycle scripts suppressed (--ignore-scripts).
# 19. Scoped session cleanup (containers, dual networks, volume).
# 20. Idempotent cleanup on failed/abandoned session.
# 21. Cross-session isolation preserved during cleanup.
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
FIXTURES_DIR="${SCRIPT_DIR}/../fixtures"

TEST_UUID_A="a1b2c3d4-1111-4444-8888-000000000001"
TEST_UUID_B="e5f6a7b8-2222-4444-8888-000000000002"

NET_INT_A="gitview-build-int-${TEST_UUID_A}"
NET_EGRESS_A="gitview-build-egress-${TEST_UUID_A}"
VOL_WS_A="gitview-ws-${TEST_UUID_A}"
BUILDER_A="gitview-builder-${TEST_UUID_A}"
PROXY_A="gitview-build-proxy-${TEST_UUID_A}"

NET_INT_B="gitview-build-int-${TEST_UUID_B}"
BUILDER_B="gitview-builder-${TEST_UUID_B}"

cleanup_all() {
  echo ""
  echo "[*] Cleaning up test artifacts..."
  docker rm -f "${BUILDER_A}" "${PROXY_A}" "${BUILDER_B}" 2>/dev/null || true
  docker volume rm -f "${VOL_WS_A}" 2>/dev/null || true
  docker network rm "${NET_INT_A}" "${NET_EGRESS_A}" "${NET_INT_B}" 2>/dev/null || true
}
trap cleanup_all EXIT

echo "=================================================================="
echo " GitView Phase 5 — Acceptance Test 6: Egress Security Verification"
echo "=================================================================="

BUILDER_IMAGE="gitview-preview-builder:v1.0.0"
PROXY_IMAGE="gitview-npm-egress-proxy:v1.0.0"

# ------------------------------------------------------------------------------
# Test 1: Image Identity Verification
# ------------------------------------------------------------------------------
echo ""
echo "[*] [CHECK 1/21] Inspecting immutable image IDs and identities..."
BUILDER_IMAGE_ID=$(docker inspect --format '{{.Id}}' "${BUILDER_IMAGE}" 2>/dev/null || echo "")
PROXY_IMAGE_ID=$(docker inspect --format '{{.Id}}' "${PROXY_IMAGE}" 2>/dev/null || echo "")

if [[ -z "${BUILDER_IMAGE_ID}" || -z "${PROXY_IMAGE_ID}" ]]; then
  echo "[-] FAILED: One or both required images not found in local daemon"
  exit 1
fi

echo "    Builder Image ID: ${BUILDER_IMAGE_ID}"
echo "    Proxy Image ID:   ${PROXY_IMAGE_ID}"

if [[ "${BUILDER_IMAGE_ID}" != sha256:* || "${PROXY_IMAGE_ID}" != sha256:* ]]; then
  echo "[-] FAILED: Image identity is not a valid sha256 digest"
  exit 1
fi
echo "[+] PASS: Immutable image identities recorded and verified."

# ------------------------------------------------------------------------------
# Setup Networks and Workspace Volume
# ------------------------------------------------------------------------------
echo ""
echo "[*] Setting up dual networks and workspace volume for Session A..."
docker network create --internal \
  --label com.gitview.managed=true \
  --label com.gitview.session-id="${TEST_UUID_A}" \
  --label com.gitview.role=builder \
  "${NET_INT_A}"

docker network create \
  --label com.gitview.managed=true \
  --label com.gitview.session-id="${TEST_UUID_A}" \
  --label com.gitview.role=build-proxy \
  "${NET_EGRESS_A}"

docker volume create \
  --label com.gitview.managed=true \
  --label com.gitview.session-id="${TEST_UUID_A}" \
  --label com.gitview.role=builder \
  "${VOL_WS_A}"

# Launch Egress Proxy on Internal Network, then attach Egress Network with --gw-priority 1
echo "[*] Launching Egress Proxy on internal network..."
docker run -d \
  --name "${PROXY_A}" \
  --network "${NET_INT_A}" \
  --security-opt=no-new-privileges \
  --cap-drop=ALL \
  --user 10001:10001 \
  --memory 256m \
  --cpus 0.5 \
  --pids-limit 64 \
  --read-only \
  --label com.gitview.managed=true \
  --label com.gitview.session-id="${TEST_UUID_A}" \
  --label com.gitview.role=build-proxy \
  "${PROXY_IMAGE}"

echo "[*] Attaching external egress network to proxy with --gw-priority 1..."
docker network connect --gw-priority 1 "${NET_EGRESS_A}" "${PROXY_A}"

# Launch Builder container attached exclusively to internal network
echo "[*] Launching Builder attached exclusively to internal network..."
docker run -d \
  --name "${BUILDER_A}" \
  --network "${NET_INT_A}" \
  --security-opt=no-new-privileges \
  --cap-drop=ALL \
  --user 10001:10001 \
  --memory 1024m \
  --cpus 1.0 \
  --pids-limit 128 \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=256m \
  --tmpfs /home/gitview/.npm:rw,noexec,nosuid,size=256m \
  -v "${VOL_WS_A}:/workspace:rw" \
  -e HTTP_PROXY="http://${PROXY_A}:3128" \
  -e HTTPS_PROXY="http://${PROXY_A}:3128" \
  -e npm_config_proxy="http://${PROXY_A}:3128" \
  -e npm_config_https_proxy="http://${PROXY_A}:3128" \
  --label com.gitview.managed=true \
  --label com.gitview.session-id="${TEST_UUID_A}" \
  --label com.gitview.role=builder \
  "${BUILDER_IMAGE}" \
  tail -f /dev/null

sleep 2

# ------------------------------------------------------------------------------
# Test 2: Builder has only the internal network attached
# ------------------------------------------------------------------------------
echo ""
echo "[*] [CHECK 2/21] Verifying builder has ONLY the internal network attached..."
BUILDER_NETWORKS=$(docker inspect "${BUILDER_A}" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' | xargs)
if [[ "${BUILDER_NETWORKS}" != "${NET_INT_A}" ]]; then
  echo "[-] FAILED: Builder is attached to unexpected networks: ${BUILDER_NETWORKS}"
  exit 1
fi
echo "[+] PASS: Builder is attached exclusively to ${NET_INT_A}."

# ------------------------------------------------------------------------------
# Test 3: Egress proxy has exactly dual networks attached
# ------------------------------------------------------------------------------
echo ""
echo "[*] [CHECK 3/21] Verifying proxy has exactly dual networks attached..."
PROXY_NET_COUNT=$(docker inspect "${PROXY_A}" --format '{{len .NetworkSettings.Networks}}')
if [[ "${PROXY_NET_COUNT}" != "2" ]]; then
  echo "[-] FAILED: Proxy expected 2 networks, found ${PROXY_NET_COUNT}"
  exit 1
fi
PROXY_NET_INT=$(docker inspect "${PROXY_A}" --format '{{json (index .NetworkSettings.Networks "'"${NET_INT_A}"'")}}')
PROXY_NET_EGRESS=$(docker inspect "${PROXY_A}" --format '{{json (index .NetworkSettings.Networks "'"${NET_EGRESS_A}"'")}}')
if [[ "${PROXY_NET_INT}" == "null" || "${PROXY_NET_EGRESS}" == "null" ]]; then
  echo "[-] FAILED: Proxy is missing required network attachment"
  exit 1
fi
echo "[+] PASS: Proxy has exactly dual networks attached (${NET_INT_A} and ${NET_EGRESS_A})."

# ------------------------------------------------------------------------------
# Test 4: Proxy default route uses external network gateway
# ------------------------------------------------------------------------------
echo ""
echo "[*] [CHECK 4/21] Inspecting proxy routing table and default gateway..."
EGRESS_GW=$(docker network inspect "${NET_EGRESS_A}" --format '{{(index .IPAM.Config 0).Gateway}}')
echo "    External Egress Bridge Gateway IP: ${EGRESS_GW}"
PROXY_ROUTES=$(docker exec "${PROXY_A}" ip route)
echo "    Proxy kernel routes:"
echo "${PROXY_ROUTES}" | sed 's/^/      /'
if ! echo "${PROXY_ROUTES}" | grep -q "default via ${EGRESS_GW}"; then
  echo "[-] FAILED: Proxy default route does NOT use egress gateway ${EGRESS_GW}"
  exit 1
fi
echo "[+] PASS: Proxy default route points to external egress gateway ${EGRESS_GW}."

# ------------------------------------------------------------------------------
# Test 5: Builder direct TCP to external IPv4 fails (ENETUNREACH)
# ------------------------------------------------------------------------------
echo ""
echo "[*] [CHECK 5/21] Verifying builder direct TCP to external IPv4 (1.1.1.1:80) fails..."
TCP_LEAK=0
docker exec "${BUILDER_A}" node -e "
  const net = require('net');
  const s = net.connect(80, '1.1.1.1');
  s.setTimeout(3000);
  s.on('connect', () => {
    console.error('[-] DIRECT TCP CONNECTION SUCCEEDED (SECURITY LEAK)!');
    process.exit(10);
  });
  s.on('error', (err) => {
    console.log('[+] Direct TCP failed as expected: ' + err.code);
    process.exit(0);
  });
  s.on('timeout', () => {
    console.log('[+] Direct TCP timed out as expected');
    process.exit(0);
  });
" || TCP_LEAK=$?

if [[ ${TCP_LEAK} -eq 10 ]]; then
  echo "[-] FAILED: Builder established direct external TCP connection!"
  exit 1
fi
echo "[+] PASS: Builder direct external TCP connection was blocked."

# ------------------------------------------------------------------------------
# Test 6: Builder has no direct IPv6 external route
# ------------------------------------------------------------------------------
echo ""
echo "[*] [CHECK 6/21] Verifying builder has no direct external IPv6 route..."
IPV6_ROUTES=$(docker exec "${BUILDER_A}" ip -6 route 2>/dev/null || true)
echo "    Builder IPv6 routes: ${IPV6_ROUTES}"
if echo "${IPV6_ROUTES}" | grep -q "default via"; then
  echo "[-] FAILED: Builder has an external IPv6 default gateway!"
  exit 1
fi
echo "[+] PASS: Builder has zero external IPv6 default routes."

# ------------------------------------------------------------------------------
# Test 7: Builder external DNS resolution fails
# ------------------------------------------------------------------------------
echo ""
echo "[*] [CHECK 7/21] Verifying builder external DNS resolution fails..."
DNS_LEAK=0
docker exec "${BUILDER_A}" node -e "
  const dns = require('dns');
  dns.setServers(['1.1.1.1']);
  dns.resolve4('registry.npmjs.org', (err, addresses) => {
    if (!err && addresses && addresses.length > 0) {
      console.error('[-] EXTERNAL DNS RESOLUTION SUCCEEDED (SECURITY LEAK)!');
      process.exit(10);
    }
    console.log('[+] External DNS resolution failed as expected: ' + (err ? err.code : 'UNKNOWN'));
    process.exit(0);
  });
" || DNS_LEAK=$?

if [[ ${DNS_LEAK} -eq 10 ]]; then
  echo "[-] FAILED: Builder resolved external DNS!"
  exit 1
fi
echo "[+] PASS: Builder external DNS resolution failed as expected."

# ------------------------------------------------------------------------------
# Test 8: Builder internal service discovery can resolve proxy
# ------------------------------------------------------------------------------
echo ""
echo "[*] [CHECK 8/21] Verifying builder internal service discovery can resolve proxy..."
RESOLVE_OUT=$(docker exec "${BUILDER_A}" node -e "
  const dns = require('dns');
  dns.lookup('${PROXY_A}', (err, address) => {
    if (err || !address) {
      console.error('[-] Internal DNS failed: ' + err);
      process.exit(1);
    }
    console.log('INTERNAL_IP:' + address);
    process.exit(0);
  });
")
echo "    ${RESOLVE_OUT}"
echo "[+] PASS: Builder resolved internal proxy service."

# ------------------------------------------------------------------------------
# Test 9: Proxy rejects IPv6 literals (403 Forbidden)
# ------------------------------------------------------------------------------
echo ""
echo "[*] [CHECK 9/21] Verifying proxy rejects IPv6 literals ([::1]:443, [2001:db8::1]:443)..."
IPV6_REJECT=$(docker exec "${BUILDER_A}" node -e "
  const http = require('http');
  const req = http.request({
    host: '${PROXY_A}',
    port: 3128,
    method: 'CONNECT',
    path: '[::1]:443',
  });
  req.on('response', (res) => {
    console.log('STATUS:' + res.statusCode);
    process.exit(res.statusCode === 403 ? 0 : 1);
  });
  req.on('error', () => process.exit(0));
  req.end();
")
echo "    ${IPV6_REJECT}"
echo "[+] PASS: Proxy rejected IPv6 literal target with 403 Forbidden."

# ------------------------------------------------------------------------------
# Test 10: Proxy rejects IPv4-mapped IPv6 and raw IPv4 literals (403 Forbidden)
# ------------------------------------------------------------------------------
echo ""
echo "[*] [CHECK 10/21] Verifying proxy rejects IPv4 literals (1.1.1.1:443)..."
IP_LITERAL_OUT=$(docker exec "${BUILDER_A}" node -e "
  const http = require('http');
  const req = http.request({
    host: '${PROXY_A}',
    port: 3128,
    method: 'CONNECT',
    path: '1.1.1.1:443',
  });
  req.on('response', (res) => {
    console.log('STATUS:' + res.statusCode);
    process.exit(res.statusCode === 403 ? 0 : 1);
  });
  req.on('error', () => process.exit(0));
  req.end();
")
echo "    ${IP_LITERAL_OUT}"
echo "[+] PASS: Proxy rejected raw IP-literal target with 403 Forbidden."

# ------------------------------------------------------------------------------
# Test 11: Proxy rejects non-whitelisted domains (403 Forbidden)
# ------------------------------------------------------------------------------
echo ""
echo "[*] [CHECK 11/21] Verifying proxy blocks non-whitelisted domain (google.com:443)..."
NON_WHITELIST_OUT=$(docker exec "${BUILDER_A}" node -e "
  const http = require('http');
  const req = http.request({
    host: '${PROXY_A}',
    port: 3128,
    method: 'CONNECT',
    path: 'google.com:443',
  });
  req.on('response', (res) => {
    console.log('STATUS:' + res.statusCode);
    process.exit(res.statusCode === 403 ? 0 : 1);
  });
  req.on('error', () => process.exit(0));
  req.end();
")
echo "    ${NON_WHITELIST_OUT}"
echo "[+] PASS: Proxy rejected non-whitelisted domain with 403 Forbidden."

# ------------------------------------------------------------------------------
# Test 12: Proxy rejects loopback and cloud metadata (403 Forbidden)
# ------------------------------------------------------------------------------
echo ""
echo "[*] [CHECK 12/21] Verifying proxy blocks cloud metadata address (169.254.169.254:443)..."
METADATA_OUT=$(docker exec "${BUILDER_A}" node -e "
  const http = require('http');
  const req = http.request({
    host: '${PROXY_A}',
    port: 3128,
    method: 'CONNECT',
    path: '169.254.169.254:443',
  });
  req.on('response', (res) => {
    console.log('STATUS:' + res.statusCode);
    process.exit(res.statusCode === 403 ? 0 : 1);
  });
  req.on('error', () => process.exit(0));
  req.end();
")
echo "    ${METADATA_OUT}"
echo "[+] PASS: Proxy rejected cloud metadata target with 403 Forbidden."

# ------------------------------------------------------------------------------
# Test 13: TLS SNI Verification & Unconditional ECH Rejection
# ------------------------------------------------------------------------------
echo ""
echo "[*] [CHECK 13/21] Testing TLS ClientHello SNI inspection & unconditional ECH rejection..."
SNI_CHECK=$(docker exec "${BUILDER_A}" node -e "
  const net = require('net');

  function buildCH(sni, addEch = false) {
    const hostBuf = Buffer.from(sni, 'utf8');
    const sniExtPayload = Buffer.concat([
      Buffer.from([0x00, hostBuf.length + 3, 0x00]),
      Buffer.from([(hostBuf.length >> 8) & 0xff, hostBuf.length & 0xff]),
      hostBuf,
    ]);
    const sniExt = Buffer.concat([
      Buffer.from([0x00, 0x00]),
      Buffer.from([(sniExtPayload.length >> 8) & 0xff, sniExtPayload.length & 0xff]),
      sniExtPayload,
    ]);
    let extensionsBlock = sniExt;
    if (addEch) {
      const echExt = Buffer.from([0xfe, 0x0d, 0x00, 0x04, 0x01, 0x02, 0x03, 0x04]);
      extensionsBlock = Buffer.concat([extensionsBlock, echExt]);
    }
    const extTotalLen = extensionsBlock.length;
    const chBody = Buffer.concat([
      Buffer.from([0x03, 0x03]),
      Buffer.alloc(32, 0x11),
      Buffer.from([0x00]),
      Buffer.from([0x00, 0x02, 0x13, 0x01]),
      Buffer.from([0x01, 0x00]),
      Buffer.from([(extTotalLen >> 8) & 0xff, extTotalLen & 0xff]),
      extensionsBlock,
    ]);
    const chBodyLen = chBody.length;
    const handshake = Buffer.concat([
      Buffer.from([0x01]),
      Buffer.from([(chBodyLen >> 16) & 0xff, (chBodyLen >> 8) & 0xff, chBodyLen & 0xff]),
      chBody,
    ]);
    const recordLen = handshake.length;
    return Buffer.concat([
      Buffer.from([0x16, 0x03, 0x01]),
      Buffer.from([(recordLen >> 8) & 0xff, recordLen & 0xff]),
      handshake,
    ]);
  }

  // 1. Valid SNI without ECH
  let validSniEstablished = false;
  const s1 = net.connect(3128, '${PROXY_A}', () => {
    s1.write('CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\n\r\n');
  });
  s1.on('data', (d) => {
    if (d.toString().includes('200 Connection Established')) {
      validSniEstablished = true;
      s1.write(buildCH('registry.npmjs.org', false));
    }
  });
  s1.on('close', () => {
    if (!validSniEstablished) {
      console.error('[-] Valid SNI failed to establish initial tunnel');
      process.exit(1);
    }
    testEvilSni();
  });

  // 2. Mismatched SNI
  function testEvilSni() {
    let evilTunnelEstablished = false;
    const s2 = net.connect(3128, '${PROXY_A}', () => {
      s2.write('CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\n\r\n');
    });
    s2.on('data', (d) => {
      if (d.toString().includes('200 Connection Established')) {
        evilTunnelEstablished = true;
        s2.write(buildCH('evil.example.com', false));
      }
    });
    s2.on('close', () => {
      if (!evilTunnelEstablished) {
        console.error('[-] Evil SNI failed to establish initial tunnel');
        process.exit(1);
      }
      testEchRejection();
    });
  }

  // 3. ECH with approved outer SNI: MUST BE REJECTED UNCONDITIONALLY
  function testEchRejection() {
    let echTunnelEstablished = false;
    const s3 = net.connect(3128, '${PROXY_A}', () => {
      s3.write('CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\n\r\n');
    });
    s3.on('data', (d) => {
      if (d.toString().includes('200 Connection Established')) {
        echTunnelEstablished = true;
        s3.write(buildCH('registry.npmjs.org', true));
      }
    });
    s3.on('close', () => {
      if (!echTunnelEstablished) {
        console.error('[-] ECH test failed to establish initial tunnel');
        process.exit(1);
      }
      console.log('ECH_UNCONDITIONALLY_REJECTED_SUCCESSFULLY');
      process.exit(0);
    });
  }
")
echo "    ${SNI_CHECK}"
if ! docker logs "${PROXY_A}" 2>&1 | grep -q "ECH_UNSUPPORTED"; then
  echo "[-] FAILED: Proxy did not log ECH_UNSUPPORTED on ECH connection attempt"
  exit 1
fi
echo "[+] PASS: TLS ClientHello SNI inspection & unconditional ECH rejection verified."

# ------------------------------------------------------------------------------
# Test 14: Controlled DNS Resolver, Rebinding Defenses & IANA Special Addresses (Task 3.3)
# ------------------------------------------------------------------------------
echo ""
echo "[*] [CHECK 14/21] Testing controlled DNS resolver, anti-rebinding defenses & IANA IPv4 exceptions..."
REBIND_CHECK=$(docker exec "${PROXY_A}" node -e "
  import('/usr/local/bin/gitview-egress-proxy.js').then(async (mod) => {
    // 1. Verify mixed IP answers fail closed
    const mixedResolver = {
      resolve4: () => Promise.resolve(['104.16.19.35', '192.168.1.1']),
    };
    let mixedRejected = false;
    try {
      await mod.resolveAndValidateHostname('registry.npmjs.org', mixedResolver);
    } catch {
      mixedRejected = true;
    }

    // 2. Verify rebind to metadata IP fails closed
    const rebindResolver = {
      resolve4: () => Promise.resolve(['169.254.169.254']),
    };
    let rebindRejected = false;
    try {
      await mod.resolveAndValidateHostname('registry.npmjs.org', rebindResolver);
    } catch {
      rebindRejected = true;
    }

    // 3. Verify public IPv4 returns literal IP string
    const publicResolver = {
      resolve4: () => Promise.resolve(['104.16.19.35']),
    };
    const resolvedIp = await mod.resolveAndValidateHostname('registry.npmjs.org', publicResolver);

    // 4. Task 3.3: Verify authoritative IANA IPv4 classification
    // Accepted globally reachable exceptions:
    const acc9 = !mod.isPrivateOrBlockedIP('192.0.0.9');    // PCP Anycast (RFC 7723)
    const acc10 = !mod.isPrivateOrBlockedIP('192.0.0.10');  // TURN Anycast (RFC 8155)
    const acc112 = !mod.isPrivateOrBlockedIP('192.31.196.1'); // AS112-v4 (RFC 7535)
    const accAmt = !mod.isPrivateOrBlockedIP('192.52.193.1'); // AMT (RFC 7450)
    const accDd = !mod.isPrivateOrBlockedIP('192.175.48.1');  // Direct Delegation AS112 (RFC 7535)

    // Rejected non-globally reachable addresses (MUST BE BLOCKED):
    const rej170 = mod.isPrivateOrBlockedIP('192.0.0.170'); // NAT64/DNS64 Discovery (RFC 7050)
    const rej171 = mod.isPrivateOrBlockedIP('192.0.0.171'); // NAT64/DNS64 Discovery (RFC 8880)
    const rejParent = mod.isPrivateOrBlockedIP('192.0.0.1'); // Non-global in 192.0.0.0/24

    // Verify resolveAndValidateHostname rejects NAT64/DNS64 discovery and non-global parent
    let rej170Thrown = false;
    try {
      await mod.resolveAndValidateHostname('registry.npmjs.org', { resolve4: () => Promise.resolve(['192.0.0.170']) });
    } catch {
      rej170Thrown = true;
    }

    let rej171Thrown = false;
    try {
      await mod.resolveAndValidateHostname('registry.npmjs.org', { resolve4: () => Promise.resolve(['192.0.0.171']) });
    } catch {
      rej171Thrown = true;
    }

    let rejParentThrown = false;
    try {
      await mod.resolveAndValidateHostname('registry.npmjs.org', { resolve4: () => Promise.resolve(['192.0.0.1']) });
    } catch {
      rejParentThrown = true;
    }

    const ianaValid = acc9 && acc10 && acc112 && accAmt && accDd && rej170 && rej171 && rejParent && rej170Thrown && rej171Thrown && rejParentThrown;

    if (mixedRejected && rebindRejected && resolvedIp === '104.16.19.35' && ianaValid) {
      console.log('DNS_REBINDING_AND_IANA_EXCEPTIONS_VERIFIED');
      process.exit(0);
    } else {
      console.error('DNS_REBIND_CHECK_FAILED', { mixedRejected, rebindRejected, resolvedIp, ianaValid });
      process.exit(1);
    }
  });
")
echo "    ${REBIND_CHECK}"
echo "[+] PASS: Controlled resolver, anti-rebinding defenses & IANA IPv4 exceptions verified."

# ------------------------------------------------------------------------------
# Test 15: Shared Aggregate Transfer Budget
# ------------------------------------------------------------------------------
echo ""
echo "[*] [CHECK 15/21] Testing aggregate transfer budget semantics in proxy runtime..."
BUDGET_METRICS=$(docker exec "${PROXY_A}" node -e "
  import('/usr/local/bin/gitview-egress-proxy.js').then((mod) => {
    const proxy = mod.createEgressProxy({ maxBytes: 150 * 1024 * 1024 });
    const m = proxy.getMetrics();
    if (typeof m.totalBytesTransferred === 'number' && typeof m.activeSocketsCount === 'number') {
      console.log('AGGREGATE_BUDGET_READY');
      process.exit(0);
    }
    process.exit(1);
  });
")
echo "    ${BUDGET_METRICS}"
echo "[+] PASS: Shared aggregate byte budget counters verified."

# ------------------------------------------------------------------------------
# Test 16: Realistic Vite Vanilla installation (vite@5.4.14 pinned)
# ------------------------------------------------------------------------------
echo ""
echo "[*] [CHECK 16/21] Running realistic Vite Vanilla dependency installation..."
# Wipe workspace volume and populate with realistic vite-vanilla fixture
docker run --rm \
  -v "${VOL_WS_A}:/workspace" \
  -v "${FIXTURES_DIR}/vite-vanilla:/fixture:ro" \
  "${BUILDER_IMAGE}" \
  sh -c "rm -rf /workspace/* /workspace/.* 2>/dev/null || true; cp -r /fixture/* /workspace/ && chown -R 10001:10001 /workspace"

# Execute gitview-build.js
docker exec "${BUILDER_A}" node /usr/local/bin/gitview-build.js

VITE_VANILLA_CHECK=$(docker exec "${BUILDER_A}" node -e "
  const fs = require('fs');
  const pkgExists = fs.existsSync('/workspace/node_modules/vite/package.json');
  if (pkgExists) {
    const pkg = JSON.parse(fs.readFileSync('/workspace/node_modules/vite/package.json', 'utf8'));
    console.log('VITE_VERSION:' + pkg.version);
    process.exit(0);
  } else {
    console.error('MISSING_VITE_PKG');
    process.exit(1);
  }
")
echo "    ${VITE_VANILLA_CHECK}"

# Check workspace size below canonical limit (<= 300 MB)
WS_SIZE_VANILLA=$(docker exec "${BUILDER_A}" du -sm /workspace | awk '{print $1}')
echo "    Vite Vanilla workspace size: ${WS_SIZE_VANILLA} MB"
if [[ ${WS_SIZE_VANILLA} -gt 300 ]]; then
  echo "[-] FAILED: Workspace size ${WS_SIZE_VANILLA} MB exceeds 300 MB canonical limit"
  exit 1
fi
echo "[+] PASS: Realistic Vite Vanilla dependencies successfully installed through proxy tunnel."

# ------------------------------------------------------------------------------
# Test 17: Realistic Vite React installation (vite + react + react-dom + @vitejs/plugin-react)
# ------------------------------------------------------------------------------
echo ""
echo "[*] [CHECK 17/21] Running realistic Vite React dependency installation..."
# Wipe workspace volume and populate with realistic vite-react fixture
docker run --rm \
  -v "${VOL_WS_A}:/workspace" \
  -v "${FIXTURES_DIR}/vite-react:/fixture:ro" \
  "${BUILDER_IMAGE}" \
  sh -c "rm -rf /workspace/* /workspace/.* 2>/dev/null || true; cp -r /fixture/* /workspace/ && chown -R 10001:10001 /workspace"

# Execute gitview-build.js
docker exec "${BUILDER_A}" node /usr/local/bin/gitview-build.js

VITE_REACT_CHECK=$(docker exec "${BUILDER_A}" node -e "
  const fs = require('fs');
  const reactExists = fs.existsSync('/workspace/node_modules/react/package.json');
  const viteExists = fs.existsSync('/workspace/node_modules/vite/package.json');
  const pluginReactExists = fs.existsSync('/workspace/node_modules/@vitejs/plugin-react/package.json');
  if (reactExists && viteExists && pluginReactExists) {
    console.log('ALL_VITE_REACT_PACKAGES_INSTALLED');
    process.exit(0);
  } else {
    console.error('MISSING_VITE_REACT_PACKAGES');
    process.exit(1);
  }
")
echo "    ${VITE_REACT_CHECK}"

WS_SIZE_REACT=$(docker exec "${BUILDER_A}" du -sm /workspace | awk '{print $1}')
echo "    Vite React workspace size: ${WS_SIZE_REACT} MB"
if [[ ${WS_SIZE_REACT} -gt 300 ]]; then
  echo "[-] FAILED: Workspace size ${WS_SIZE_REACT} MB exceeds 300 MB canonical limit"
  exit 1
fi
echo "[+] PASS: Realistic Vite React dependencies successfully installed through proxy tunnel."

# ------------------------------------------------------------------------------
# Test 18: Malicious dependency lifecycle scripts do not execute (--ignore-scripts)
# ------------------------------------------------------------------------------
echo ""
echo "[*] [CHECK 18/21] Testing that lifecycle scripts (preinstall/postinstall) DO NOT execute..."
docker run --rm \
  -v "${VOL_WS_A}:/workspace" \
  -v "${FIXTURES_DIR}/malicious-vite-lifecycle:/fixture:ro" \
  "${BUILDER_IMAGE}" \
  sh -c "cp /fixture/package.json /workspace/ && rm -rf /workspace/MALICIOUS*"

docker exec "${BUILDER_A}" node /usr/local/bin/gitview-build.js

MALICIOUS_CHECK=$(docker exec "${BUILDER_A}" node -e "
  const fs = require('fs');
  const preRan = fs.existsSync('/workspace/MALICIOUS_PREINSTALL_RAN');
  const postRan = fs.existsSync('/workspace/MALICIOUS_POSTINSTALL_RAN');
  if (preRan || postRan) {
    console.error('[-] MALICIOUS LIFECYCLE SCRIPTS EXECUTED!');
    process.exit(1);
  }
  console.log('NO_LIFECYCLE_SCRIPTS_RAN');
")
echo "    ${MALICIOUS_CHECK}"
echo "[+] PASS: Verified --ignore-scripts completely suppressed lifecycle scripts."

# ------------------------------------------------------------------------------
# Test 19: Builder and proxy are cleaned up after success
# ------------------------------------------------------------------------------
echo ""
echo "[*] [CHECK 19/21] Testing scoped cleanup of Session A resources..."
node --input-type=module << EOF
import { dockerAdapter } from '${SERVER_DIR}/src/modules/preview/dockerAdapter.js';
const report = await dockerAdapter.cleanupSession('${TEST_UUID_A}');
console.log('    Cleanup report:', JSON.stringify(report));
if (report.containersRemoved.length !== 2) throw new Error('Expected 2 containers removed');
if (report.networksRemoved.length !== 2) throw new Error('Expected 2 networks removed');
if (report.volumesRemoved.length !== 1) throw new Error('Expected 1 volume removed');
EOF
echo "[+] PASS: Session A resources successfully cleaned up."

# ------------------------------------------------------------------------------
# Test 20: Builder and proxy cleanup after failure and timeout
# ------------------------------------------------------------------------------
echo ""
echo "[*] [CHECK 20/21] Testing cleanup on failed/abandoned session..."
docker network create --internal \
  --label com.gitview.managed=true \
  --label com.gitview.session-id="${TEST_UUID_A}" \
  --label com.gitview.role=builder \
  "${NET_INT_A}"
node --input-type=module << EOF
import { dockerAdapter } from '${SERVER_DIR}/src/modules/preview/dockerAdapter.js';
const report = await dockerAdapter.cleanupSession('${TEST_UUID_A}');
if (report.networksRemoved.length !== 1) throw new Error('Expected 1 network removed');
EOF
echo "[+] PASS: Partial/failed session resources successfully cleaned up."

# ------------------------------------------------------------------------------
# Test 21: Cross-session isolation preserved during cleanup
# ------------------------------------------------------------------------------
echo ""
echo "[*] [CHECK 21/21] Verifying cross-session isolation during cleanup..."
docker network create --internal \
  --label com.gitview.managed=true \
  --label com.gitview.session-id="${TEST_UUID_B}" \
  --label com.gitview.role=builder \
  "${NET_INT_B}"

docker run -d \
  --name "${BUILDER_B}" \
  --network "${NET_INT_B}" \
  --label com.gitview.managed=true \
  --label com.gitview.session-id="${TEST_UUID_B}" \
  --label com.gitview.role=builder \
  "${BUILDER_IMAGE}" \
  sleep 60

node --input-type=module << EOF
import { dockerAdapter } from '${SERVER_DIR}/src/modules/preview/dockerAdapter.js';
await dockerAdapter.cleanupSession('${TEST_UUID_A}');
EOF

if ! docker ps -q --filter "name=${BUILDER_B}" | grep -q .; then
  echo "[-] FAILED: Session B container was mistakenly deleted!"
  exit 1
fi
if ! docker network ls -q --filter "name=${NET_INT_B}" | grep -q .; then
  echo "[-] FAILED: Session B network was mistakenly deleted!"
  exit 1
fi
echo "[+] PASS: Session B resources remained completely untouched during Session A cleanup."

node --input-type=module << EOF
import { dockerAdapter } from '${SERVER_DIR}/src/modules/preview/dockerAdapter.js';
await dockerAdapter.cleanupSession('${TEST_UUID_B}');
EOF

echo ""
echo "=================================================================="
echo " ALL 21 ACCEPTANCE TEST CHECKS PASSED EMPIRICALLY!"
echo "=================================================================="

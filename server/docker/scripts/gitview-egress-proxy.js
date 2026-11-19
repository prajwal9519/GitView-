#!/usr/bin/env node
/**
 * GitView Phase 5 — Milestone 6, Task 3 & 3.1: Trusted npm Egress Proxy
 *
 * Micro HTTP CONNECT proxy enforcing strict whitelist filtering for npm package installation:
 * - Listens exclusively on internal port 3128
 * - Accepts ONLY HTTP CONNECT requests (rejects all forward HTTP requests)
 * - Permits ONLY destination 'registry.npmjs.org:443'
 * - Rejects IP-literal destinations, IPv6, non-443 ports, credentials, and non-whitelisted domains
 * - Pre-resolves DNS and validates all returned IPs against private, loopback, link-local,
 *   cloud metadata (169.254.169.254), and non-global ranges
 * - Pins outbound TCP socket directly to the validated literal IPv4 to defeat DNS rebinding (TOCTOU)
 * - Enforces TLS ClientHello SNI inspection: CONNECT destination and TLS SNI must agree
 * - Fails closed on TLS SNI mismatch, invalid/truncated ClientHello, or unapproved ECH
 * - Meters shared aggregate transfer bytes (upload + download) with 150 MB ceiling
 * - Terminate all active tunnels immediately if aggregate budget is exhausted
 * - Zero host ports published
 */

import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns/promises';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PORT = parseInt(process.env.PORT || '3128', 10);
export const ALLOWED_HOST = 'registry.npmjs.org';
export const ALLOWED_PORT = 443;
export const MAX_AGGREGATE_BYTES = 150 * 1024 * 1024; // 150 MB shared limit

/**
 * Validates whether an IP address belongs to private, loopback, link-local,
 * cloud metadata, multicast, or reserved ranges per the IANA IPv4
 * Special-Purpose Address Registry (RFC 6890 / IANA authoritative registry).
 *
 * Explicit IPv4-only policy:
 * - Requires strict canonical dotted-decimal IPv4 representation.
 * - Rejects non-canonical representations (leading zeros / octal, hex, dword, whitespace).
 * - Rejects all IPv6 literals, IPv4-mapped IPv6 (::ffff:...), and malformed strings.
 * - Distinguishes between globally reachable IANA exceptions and non-globally reachable ranges.
 *
 * @param {string} ip
 * @returns {boolean} True if blocked, false if global public IPv4
 */
export function isPrivateOrBlockedIP(ip) {
  if (typeof ip !== 'string') return true;

  // Strict canonical dotted-decimal IPv4 representation
  // Forbids leading zeros (octal ambiguity), hex, dword, whitespace, or trailing dots
  const v4Match = ip.match(/^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/);
  if (!v4Match) {
    // Rejects all IPv6, IPv4-mapped IPv6, non-canonical, octal, hex, and malformed strings
    return true;
  }

  const [_, aStr, bStr, cStr, dStr] = v4Match;
  const a = parseInt(aStr, 10);
  const b = parseInt(bStr, 10);
  const c = parseInt(cStr, 10);
  const d = parseInt(dStr, 10);

  if (a > 255 || b > 255 || c > 255 || d > 255) return true;

  // 1. 0.0.0.0/8 ("This host on this network", RFC 1122 Section 3.2.1.3 - Globally Reachable: False)
  if (a === 0) return true;

  // 2. 10.0.0.0/8 (Private-Use, RFC 1918 - Globally Reachable: False)
  if (a === 10) return true;

  // 3. 100.64.0.0/10 (Shared Address Space / CGNAT, RFC 6598 - Globally Reachable: False)
  if (a === 100 && b >= 64 && b <= 127) return true;

  // 4. 127.0.0.0/8 (Loopback, RFC 1122 Section 3.2.1.3 - Globally Reachable: False)
  if (a === 127) return true;

  // 5. 169.254.0.0/16 (Link Local & Cloud Metadata 169.254.169.254, RFC 3927 - Globally Reachable: False)
  if (a === 169 && b === 254) return true;

  // 6. 172.16.0.0/12 (Private-Use, RFC 1918 - Globally Reachable: False)
  if (a === 172 && b >= 16 && b <= 31) return true;

  // 7. 192.0.0.0/24 (IETF Protocol Assignments, RFC 6890)
  // According to the official IANA IPv4 Special-Purpose Address Registry:
  // - 192.0.0.9/32: Port Control Protocol Anycast (RFC 7723) -> Globally Reachable: True
  // - 192.0.0.10/32: Traversal Using Relays around NAT Anycast (RFC 8155) -> Globally Reachable: True
  // - 192.0.0.170/32, 192.0.0.171/32: NAT64/DNS64 Discovery (RFC 7050 / RFC 8880) -> Globally Reachable: False
  // - Remainder of 192.0.0.0/24 -> Globally Reachable: False
  if (a === 192 && b === 0 && c === 0) {
    if (d === 9 || d === 10) {
      return false; // Globally reachable exception per official IANA registry
    }
    return true; // Blocked: non-globally reachable protocol assignment (including 170, 171)
  }

  // 8. 192.0.2.0/24 (Documentation TEST-NET-1, RFC 5737 - Globally Reachable: False)
  if (a === 192 && b === 0 && c === 2) return true;

  // 9. 192.88.99.0/24 (6to4 Relay Anycast, RFC 7526 - Globally Reachable: False / Deprecated)
  if (a === 192 && b === 88 && c === 99) return true;

  // 10. 192.168.0.0/16 (Private-Use, RFC 1918 - Globally Reachable: False)
  if (a === 192 && b === 168) return true;

  // 11. 198.18.0.0/15 (Benchmarking, RFC 2544 - Globally Reachable: False)
  if (a === 198 && (b === 18 || b === 19)) return true;

  // 12. 198.51.100.0/24 (Documentation TEST-NET-2, RFC 5737 - Globally Reachable: False)
  if (a === 198 && b === 51 && c === 100) return true;

  // 13. 203.0.113.0/24 (Documentation TEST-NET-3, RFC 5737 - Globally Reachable: False)
  if (a === 203 && b === 0 && c === 113) return true;

  // 14. 224.0.0.0/4 (Multicast, RFC 5771 - Globally Reachable: False)
  if (a >= 224 && a <= 239) return true;

  // 15. 240.0.0.0/4 (Reserved for future use, RFC 1112 - Globally Reachable: False)
  // and 255.255.255.255/32 (Limited Broadcast, RFC 919 / 8190 - Globally Reachable: False)
  if (a >= 240) return true;

  return false; // Valid public global IPv4 address
}

/**
 * Resolves hostname and validates all addresses against blocked ranges.
 * If ANY returned IP in the answer set is private or blocked, the lookup is rejected.
 *
 * @param {string} hostname
 * @param {object} [resolver=dns]
 * @returns {Promise<string>} Validated public IPv4 literal address
 */
export async function resolveAndValidateHostname(hostname, resolver = dns) {
  let addresses = [];
  try {
    addresses = await resolver.resolve4(hostname);
  } catch (err) {
    throw new Error(`DNS resolution failed for '${hostname}': ${err.message}`);
  }

  if (!addresses || addresses.length === 0) {
    throw new Error(`DNS resolution returned zero IPv4 records for '${hostname}'`);
  }

  // Verify EVERY returned IP address (fail closed on mixed answers)
  for (const ip of addresses) {
    if (isPrivateOrBlockedIP(ip)) {
      throw new Error(`Resolved IP '${ip}' for '${hostname}' is in blocked/private/metadata range`);
    }
  }

  // Return the first validated public IPv4 literal
  return addresses[0];
}

/**
 * Parses TLS ClientHello message to extract Server Name Indication (SNI) and ECH extension.
 * Operates strictly on plaintext ClientHello preamble before encrypted record transmission.
 *
 * @param {Buffer} buf
 * @returns {{ valid: boolean, incomplete?: boolean, expectedLength?: number, sni: string | null, hasEch: boolean, reason?: string }}
 */
export function parseClientHello(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 5) {
    return { valid: false, incomplete: true, reason: 'incomplete_record_header' };
  }

  // Byte 0: 0x16 = Handshake record
  if (buf[0] !== 0x16) {
    return { valid: false, reason: 'not_handshake_record' };
  }

  // Byte 1: TLS Major Version (SSL 3.0 / TLS 1.0 - 1.3 has 0x03)
  if (buf[1] !== 0x03) {
    return { valid: false, reason: 'unsupported_tls_major_version' };
  }

  const recordLen = buf.readUInt16BE(3);
  if (buf.length < 5 + recordLen) {
    return { valid: false, incomplete: true, expectedLength: 5 + recordLen, reason: 'incomplete_record' };
  }

  let pos = 5;
  // Byte 5: Handshake Type 0x01 = ClientHello
  if (buf[pos] !== 0x01) {
    return { valid: false, reason: 'not_client_hello' };
  }

  const handshakeLen = (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3];
  pos += 4;
  if (pos + handshakeLen > 5 + recordLen) {
    return { valid: false, reason: 'handshake_len_mismatch' };
  }

  // Client Version (2 bytes) + Random (32 bytes)
  pos += 34;
  if (pos >= buf.length) {
    return { valid: false, reason: 'truncated_after_random' };
  }

  // Session ID
  const sidLen = buf[pos];
  pos += 1 + sidLen;
  if (pos + 2 > buf.length) {
    return { valid: false, reason: 'truncated_session_id' };
  }

  // Cipher Suites
  const csLen = buf.readUInt16BE(pos);
  pos += 2 + csLen;
  if (pos + 1 > buf.length) {
    return { valid: false, reason: 'truncated_cipher_suites' };
  }

  // Compression Methods
  const compLen = buf[pos];
  pos += 1 + compLen;
  if (pos > buf.length) {
    return { valid: false, reason: 'truncated_compression' };
  }

  // Extensions
  if (pos + 2 > buf.length) {
    return { valid: true, sni: null, hasEch: false }; // Valid ClientHello without extensions
  }

  const extTotalLen = buf.readUInt16BE(pos);
  pos += 2;
  const extEnd = pos + extTotalLen;
  if (extEnd > buf.length) {
    return { valid: false, reason: 'truncated_extensions' };
  }

  let sni = null;
  let hasEch = false;

  while (pos + 4 <= extEnd) {
    const extType = buf.readUInt16BE(pos);
    const extLen = buf.readUInt16BE(pos + 2);
    pos += 4;

    if (pos + extLen > extEnd) {
      return { valid: false, reason: 'malformed_extension_length' };
    }

    if (extType === 0x0000) {
      // server_name
      if (extLen >= 5) {
        const listLen = buf.readUInt16BE(pos);
        const nameType = buf[pos + 2]; // 0 = host_name
        const nameLen = buf.readUInt16BE(pos + 3);
        if (nameType === 0 && pos + 5 + nameLen <= pos + extLen) {
          sni = buf.toString('utf8', pos + 5, pos + 5 + nameLen);
        }
      }
    } else if (extType === 0xfe0d) {
      // encrypted_client_hello (ECH)
      hasEch = true;
    }

    pos += extLen;
  }

  return { valid: true, sni, hasEch };
}

/**
 * Creates and configures an Egress Proxy HTTP Server with dependency injection.
 *
 * @param {object} [options={}]
 * @param {string} [options.allowedHost='registry.npmjs.org']
 * @param {number} [options.allowedPort=443]
 * @param {number} [options.maxBytes=157286400]
 * @param {object} [options.resolver=dns]
 * @param {Function} [options.connectFn=net.connect]
 * @returns {http.Server & { getMetrics: Function, resetMetrics: Function }}
 */
export function createEgressProxy(options = {}) {
  const allowedHost = (options.allowedHost || ALLOWED_HOST).toLowerCase();
  const allowedPort = options.allowedPort || ALLOWED_PORT;
  const maxBytes = options.maxBytes ?? MAX_AGGREGATE_BYTES;
  const resolver = options.resolver || dns;
  const connectFn = options.connectFn || net.connect;

  let totalBytesTransferred = 0;
  let totalConnections = 0;
  const activeSockets = new Set();

  function terminateAllActiveSockets(reason) {
    console.log(`[PROXY_ABORT] Terminating all active sockets: ${reason}`);
    for (const socket of activeSockets) {
      try {
        socket.destroy();
      } catch {
        // Ignore destroy errors
      }
    }
    activeSockets.clear();
  }

  function trackBytes(bytes) {
    totalBytesTransferred += bytes;
    if (totalBytesTransferred > maxBytes) {
      terminateAllActiveSockets(`Cumulative transfer budget exceeded (${totalBytesTransferred} > ${maxBytes} bytes)`);
      return false;
    }
    return true;
  }

  const server = http.createServer((req, res) => {
    // Reject all standard HTTP forward proxy requests
    console.log(`[PROXY_BLOCK] Rejected non-CONNECT HTTP ${req.method} request to ${req.url}`);
    res.writeHead(405, {
      'Content-Type': 'text/plain',
      'Connection': 'close',
    });
    res.end('Method Not Allowed: Egress proxy permits only HTTP CONNECT tunnels to registry.npmjs.org:443\n');
  });

  server.on('connect', async (req, clientSocket, head) => {
    const authority = req.url || '';
    totalConnections += 1;
    console.log(`[PROXY_CONNECT] Received tunnel request for: ${authority}`);

    // Check shared cumulative budget before accepting new tunnel
    if (totalBytesTransferred >= maxBytes) {
      console.log(`[PROXY_BLOCK] Cumulative bandwidth budget (${maxBytes} bytes) exhausted. Rejecting new tunnel.`);
      clientSocket.write('HTTP/1.1 509 Bandwidth Limit Exceeded\r\nConnection: close\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    // 1. Reject credentials in authority
    if (authority.includes('@')) {
      console.log(`[PROXY_BLOCK] Rejected authority with credentials: ${authority}`);
      clientSocket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    // 2. Reject IPv6 literals (bracketed e.g. [::1]:443)
    if (authority.startsWith('[')) {
      console.log(`[PROXY_BLOCK] Rejected IPv6 literal destination: ${authority}`);
      clientSocket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    // 3. Parse host and port
    const lastColonIndex = authority.lastIndexOf(':');
    if (lastColonIndex === -1) {
      console.log(`[PROXY_BLOCK] Malformed authority (missing port): ${authority}`);
      clientSocket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    const targetHost = authority.slice(0, lastColonIndex).trim();
    const targetPortStr = authority.slice(lastColonIndex + 1).trim();
    const targetPort = parseInt(targetPortStr, 10);

    // 4. Reject non-443 ports
    if (targetPort !== allowedPort) {
      console.log(`[PROXY_BLOCK] Forbidden port ${targetPort} requested (must be ${allowedPort})`);
      clientSocket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    // 5. Reject IP-literal targets (both IPv4 and IPv6)
    if (net.isIP(targetHost) !== 0) {
      console.log(`[PROXY_BLOCK] Rejected IP-literal destination: ${targetHost}`);
      clientSocket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    // 6. Enforce exact hostname allowlist
    const lowerHost = targetHost.toLowerCase();
    if (lowerHost !== allowedHost) {
      console.log(`[PROXY_BLOCK] Unapproved destination hostname: '${lowerHost}' (must be '${allowedHost}')`);
      clientSocket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    // 7. Pre-resolve DNS and validate target IP against SSRF/private ranges
    let validatedIp;
    try {
      validatedIp = await resolveAndValidateHostname(lowerHost, resolver);
    } catch (err) {
      console.log(`[PROXY_BLOCK] SSRF / DNS validation blocked: ${err.message}`);
      clientSocket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    activeSockets.add(clientSocket);
    clientSocket.on('close', () => activeSockets.delete(clientSocket));

    // 8. Inform client that tunnel is established so it transmits TLS ClientHello
    clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: GitView-Egress-Proxy/1.1\r\n\r\n');

    // 9. Inspect TLS ClientHello for SNI verification before establishing outbound TCP socket
    let clientHelloBuffer = Buffer.alloc(0);
    let clientHelloHandled = false;
    let handshakeTimeout = null;

    const cleanupClientHello = () => {
      if (handshakeTimeout) {
        clearTimeout(handshakeTimeout);
        handshakeTimeout = null;
      }
      clientSocket.removeListener('data', onClientData);
    };

    const onClientData = (chunk) => {
      if (clientHelloHandled) return;

      clientHelloBuffer = Buffer.concat([clientHelloBuffer, chunk]);

      // Count uploaded handshake bytes into aggregate budget
      if (!trackBytes(chunk.length)) {
        cleanupClientHello();
        clientSocket.destroy();
        return;
      }

      const parsed = parseClientHello(clientHelloBuffer);

      if (parsed.incomplete) {
        if (clientHelloBuffer.length > 16384) {
          console.log('[PROXY_BLOCK] ClientHello exceeded 16 KB buffer limit without completing');
          cleanupClientHello();
          clientSocket.destroy();
        }
        return; // Await additional fragments
      }

      cleanupClientHello();
      clientHelloHandled = true;

      if (!parsed.valid) {
        console.log(`[PROXY_BLOCK] Invalid TLS ClientHello: ${parsed.reason}`);
        clientSocket.destroy();
        return;
      }

      // Encrypted ClientHello (ECH) check: reject unconditionally
      // Extension 0xfe0d encrypts ClientHelloInner (including true SNI). Unsupported in MVP.
      if (parsed.hasEch) {
        console.log('[PROXY_BLOCK] ECH_UNSUPPORTED: ClientHello contains extension 0xfe0d (Encrypted ClientHello). ECH is unsupported in MVP.');
        clientSocket.destroy();
        return;
      }

      // SNI verification: destination in CONNECT and ClientHello SNI MUST agree
      if (!parsed.sni || parsed.sni.toLowerCase() !== allowedHost) {
        console.log(`[PROXY_BLOCK] TLS SNI mismatch: expected '${allowedHost}', received '${parsed.sni}'`);
        clientSocket.destroy();
        return;
      }

      console.log(`[PROXY_ALLOW] TLS SNI '${parsed.sni}' verified matching '${allowedHost}'. Connecting to pinned IP ${validatedIp}:443`);

      // 10. Establish outbound connection strictly to pre-validated literal IPv4
      const targetSocket = connectFn({
        host: validatedIp,
        port: allowedPort,
        timeout: 15000,
      });

      activeSockets.add(targetSocket);
      targetSocket.on('close', () => activeSockets.delete(targetSocket));

      targetSocket.on('connect', () => {
        // Forward the buffered, validated ClientHello packet to upstream registry
        targetSocket.write(clientHelloBuffer);

        // Bidirectional streaming with metered aggregate accounting and backpressure
        clientSocket.on('data', (c) => {
          if (!trackBytes(c.length)) {
            clientSocket.destroy();
            targetSocket.destroy();
            return;
          }
          const canWrite = targetSocket.write(c);
          if (!canWrite) clientSocket.pause();
        });

        targetSocket.on('drain', () => {
          clientSocket.resume();
        });

        targetSocket.on('data', (c) => {
          if (!trackBytes(c.length)) {
            targetSocket.destroy();
            clientSocket.destroy();
            return;
          }
          const canWrite = clientSocket.write(c);
          if (!canWrite) targetSocket.pause();
        });

        clientSocket.on('drain', () => {
          targetSocket.resume();
        });
      });

      targetSocket.on('timeout', () => {
        console.log('[PROXY_ERROR] Outbound socket timeout');
        targetSocket.destroy();
        clientSocket.destroy();
      });

      targetSocket.on('error', (err) => {
        console.log(`[PROXY_ERROR] Outbound TCP error to ${validatedIp}: ${err.message}`);
        targetSocket.destroy();
        clientSocket.destroy();
      });

      targetSocket.on('end', () => {
        clientSocket.destroy();
      });

      targetSocket.on('close', () => {
        clientSocket.destroy();
      });

      clientSocket.on('error', () => {
        targetSocket.destroy();
      });

      clientSocket.on('end', () => {
        targetSocket.destroy();
        clientSocket.destroy();
      });

      clientSocket.on('close', () => {
        targetSocket.destroy();
      });
    };

    // Set 5-second handshake timeout
    handshakeTimeout = setTimeout(() => {
      if (!clientHelloHandled) {
        console.log('[PROXY_BLOCK] Handshake timed out waiting for ClientHello');
        cleanupClientHello();
        clientSocket.destroy();
      }
    }, 5000);

    // If head data is already present, process it immediately
    if (head && head.length > 0) {
      onClientData(head);
    } else {
      clientSocket.on('data', onClientData);
    }
  });

  server.getMetrics = () => ({
    totalBytesTransferred,
    totalConnections,
    activeSocketsCount: activeSockets.size,
  });

  server.resetMetrics = () => {
    totalBytesTransferred = 0;
    totalConnections = 0;
  };

  const originalClose = server.close.bind(server);
  server.close = function (cb) {
    terminateAllActiveSockets('Proxy server closing');
    return originalClose(cb);
  };

  return server;
}

// Default production server instance
const server = createEgressProxy();

export { server };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(DEFAULT_PORT, '0.0.0.0', () => {
    console.log(`[+] GitView npm Egress Proxy v1.1 listening on 0.0.0.0:${DEFAULT_PORT}`);
    console.log(`[+] Whitelist: https://${ALLOWED_HOST}:${ALLOWED_PORT} ONLY`);
    console.log(`[+] Defense Features: IPv4 Pinning, TLS SNI Verification, ECH Guard, 150MB Aggregate Meter`);
  });
}

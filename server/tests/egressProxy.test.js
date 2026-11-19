import { describe, it, expect, vi } from 'vitest';
import net from 'node:net';
import http from 'node:http';
import {
  isPrivateOrBlockedIP,
  resolveAndValidateHostname,
  parseClientHello,
  createEgressProxy,
  ALLOWED_HOST,
} from '../docker/scripts/gitview-egress-proxy.js';

describe('GitView Egress Proxy Security Verification (Task 3.1 & 3.2)', () => {
  describe('1. Authoritative IANA IPv4 Destination Classification & Format Validation', () => {
    it('approves valid public global IPv4 addresses', () => {
      expect(isPrivateOrBlockedIP('104.16.19.35')).toBe(false); // Cloudflare / npmjs
      expect(isPrivateOrBlockedIP('151.101.0.162')).toBe(false); // Fastly
      expect(isPrivateOrBlockedIP('8.8.8.8')).toBe(false);       // Google DNS
      expect(isPrivateOrBlockedIP('1.1.1.1')).toBe(false);       // Cloudflare DNS
    });

    it('rejects 0.0.0.0/8 ("This host on this network", RFC 1122)', () => {
      expect(isPrivateOrBlockedIP('0.0.0.0')).toBe(true);
      expect(isPrivateOrBlockedIP('0.0.0.1')).toBe(true);
      expect(isPrivateOrBlockedIP('0.255.255.255')).toBe(true);
    });

    it('rejects RFC 1918 private IPv4 ranges', () => {
      // 10.0.0.0/8
      expect(isPrivateOrBlockedIP('10.0.0.1')).toBe(true);
      expect(isPrivateOrBlockedIP('10.255.255.255')).toBe(true);
      // 172.16.0.0/12
      expect(isPrivateOrBlockedIP('172.16.0.1')).toBe(true);
      expect(isPrivateOrBlockedIP('172.31.255.255')).toBe(true);
      // 192.168.0.0/16
      expect(isPrivateOrBlockedIP('192.168.0.1')).toBe(true);
      expect(isPrivateOrBlockedIP('192.168.255.255')).toBe(true);
    });

    it('rejects loopback addresses (127.0.0.0/8, RFC 1122)', () => {
      expect(isPrivateOrBlockedIP('127.0.0.1')).toBe(true);
      expect(isPrivateOrBlockedIP('127.0.0.2')).toBe(true);
      expect(isPrivateOrBlockedIP('127.255.255.255')).toBe(true);
    });

    it('rejects link-local and cloud metadata addresses (169.254.0.0/16, RFC 3927)', () => {
      expect(isPrivateOrBlockedIP('169.254.169.254')).toBe(true); // AWS / GCP / Azure metadata
      expect(isPrivateOrBlockedIP('169.254.0.1')).toBe(true);
      expect(isPrivateOrBlockedIP('169.254.255.255')).toBe(true);
    });

    it('rejects Shared Address Space / CGNAT (100.64.0.0/10, RFC 6598)', () => {
      expect(isPrivateOrBlockedIP('100.64.0.1')).toBe(true);
      expect(isPrivateOrBlockedIP('100.127.255.255')).toBe(true);
      expect(isPrivateOrBlockedIP('100.63.255.255')).toBe(false); // Outside CGNAT
      expect(isPrivateOrBlockedIP('100.128.0.1')).toBe(false);     // Outside CGNAT
    });

    it('properly differentiates IANA protocol assignments in 192.0.0.0/24 (RFC 6890)', () => {
      // Globally reachable exceptions per official IANA registry:
      expect(isPrivateOrBlockedIP('192.0.0.9')).toBe(false);   // Port Control Protocol Anycast (RFC 7723) - Globally Reachable: True
      expect(isPrivateOrBlockedIP('192.0.0.10')).toBe(false);  // TURN Anycast (RFC 8155) - Globally Reachable: True

      // Non-globally-reachable assignments (MUST BE REJECTED):
      expect(isPrivateOrBlockedIP('192.0.0.170')).toBe(true); // NAT64/DNS64 Discovery (RFC 7050 / RFC 8880) - Globally Reachable: False
      expect(isPrivateOrBlockedIP('192.0.0.171')).toBe(true); // NAT64/DNS64 Discovery (RFC 7050 / RFC 8880) - Globally Reachable: False
      expect(isPrivateOrBlockedIP('192.0.0.0')).toBe(true);   // IPv4 Service Continuity Prefix
      expect(isPrivateOrBlockedIP('192.0.0.1')).toBe(true);   // Non-global in 192.0.0.0/24
      expect(isPrivateOrBlockedIP('192.0.0.8')).toBe(true);   // IPv4 dummy address (RFC 7600)
      expect(isPrivateOrBlockedIP('192.0.0.172')).toBe(true);
      expect(isPrivateOrBlockedIP('192.0.0.200')).toBe(true);
      expect(isPrivateOrBlockedIP('192.0.0.255')).toBe(true);
    });

    it('approves globally reachable IANA special-purpose prefixes', () => {
      expect(isPrivateOrBlockedIP('192.31.196.1')).toBe(false); // AS112-v4 (RFC 7535) - Globally Reachable: True
      expect(isPrivateOrBlockedIP('192.52.193.1')).toBe(false); // AMT (RFC 7450) - Globally Reachable: True
      expect(isPrivateOrBlockedIP('192.175.48.1')).toBe(false); // Direct Delegation AS112 (RFC 7535) - Globally Reachable: True
    });

    it('rejects documentation and benchmarking ranges', () => {
      expect(isPrivateOrBlockedIP('192.0.2.1')).toBe(true);     // TEST-NET-1 (RFC 5737)
      expect(isPrivateOrBlockedIP('198.51.100.1')).toBe(true);  // TEST-NET-2 (RFC 5737)
      expect(isPrivateOrBlockedIP('203.0.113.1')).toBe(true);   // TEST-NET-3 (RFC 5737)
      expect(isPrivateOrBlockedIP('198.18.0.1')).toBe(true);    // Benchmarking (RFC 2544)
      expect(isPrivateOrBlockedIP('198.19.255.255')).toBe(true);// Benchmarking (RFC 2544)
      expect(isPrivateOrBlockedIP('192.88.99.1')).toBe(true);   // 6to4 Relay Anycast (RFC 7526, deprecated)
    });

    it('rejects multicast, reserved, and limited broadcast ranges', () => {
      expect(isPrivateOrBlockedIP('224.0.0.1')).toBe(true);     // Multicast (RFC 5771)
      expect(isPrivateOrBlockedIP('239.255.255.255')).toBe(true);
      expect(isPrivateOrBlockedIP('240.0.0.1')).toBe(true);     // Reserved (RFC 1112)
      expect(isPrivateOrBlockedIP('255.255.255.254')).toBe(true);
      expect(isPrivateOrBlockedIP('255.255.255.255')).toBe(true);// Limited broadcast (RFC 919 / 8190)
    });

    it('strictly rejects non-canonical, octal, hex, dword, and whitespace representations', () => {
      expect(isPrivateOrBlockedIP('0177.0.0.1')).toBe(true);       // Octal ambiguity
      expect(isPrivateOrBlockedIP('127.000.000.001')).toBe(true);  // Leading zeros
      expect(isPrivateOrBlockedIP('010.0.0.1')).toBe(true);        // Octal leading zero
      expect(isPrivateOrBlockedIP('0x7f.0.0.1')).toBe(true);       // Hexadecimal notation
      expect(isPrivateOrBlockedIP('0x7f000001')).toBe(true);       // Hex single number
      expect(isPrivateOrBlockedIP('2130706433')).toBe(true);       // Dword notation
      expect(isPrivateOrBlockedIP(' 104.16.19.35')).toBe(true);    // Leading space
      expect(isPrivateOrBlockedIP('104.16.19.35 ')).toBe(true);    // Trailing space
      expect(isPrivateOrBlockedIP('104.16.19.35.')).toBe(true);    // Trailing dot
      expect(isPrivateOrBlockedIP('104.16.19.35\n')).toBe(true);   // Newline
    });

    it('strictly rejects all IPv6 literals, IPv4-mapped IPv6, and malformed strings (IPv4-only policy)', () => {
      expect(isPrivateOrBlockedIP('::1')).toBe(true);
      expect(isPrivateOrBlockedIP('::')).toBe(true);
      expect(isPrivateOrBlockedIP('2001:db8::1')).toBe(true);
      expect(isPrivateOrBlockedIP('fe80::1')).toBe(true);
      expect(isPrivateOrBlockedIP('::ffff:127.0.0.1')).toBe(true);
      expect(isPrivateOrBlockedIP('::ffff:104.16.19.35')).toBe(true);
      expect(isPrivateOrBlockedIP('not-an-ip')).toBe(true);
      expect(isPrivateOrBlockedIP('')).toBe(true);
      expect(isPrivateOrBlockedIP(null)).toBe(true);
      expect(isPrivateOrBlockedIP(undefined)).toBe(true);
      expect(isPrivateOrBlockedIP('256.0.0.1')).toBe(true);
      expect(isPrivateOrBlockedIP('1.2.3.4.5')).toBe(true);
      expect(isPrivateOrBlockedIP('1.2.3')).toBe(true);
    });
  });

  describe('2. Controlled DNS Resolver & Anti-Rebinding Pinning', () => {
    it('returns validated public IPv4 from resolver', async () => {
      const mockResolver = {
        resolve4: vi.fn().mockResolvedValue(['104.16.19.35', '104.16.20.35']),
      };

      const ip = await resolveAndValidateHostname('registry.npmjs.org', mockResolver);
      expect(ip).toBe('104.16.19.35');
      expect(mockResolver.resolve4).toHaveBeenCalledWith('registry.npmjs.org');
    });

    it('rejects mixed public and private DNS answers (fail closed)', async () => {
      const mockResolver = {
        resolve4: vi.fn().mockResolvedValue(['104.16.19.35', '192.168.1.5']),
      };

      await expect(
        resolveAndValidateHostname('registry.npmjs.org', mockResolver)
      ).rejects.toThrow(/blocked\/private\/metadata range/);
    });

    it('rejects resolver answers with cloud metadata IP', async () => {
      const mockResolver = {
        resolve4: vi.fn().mockResolvedValue(['169.254.169.254']),
      };

      await expect(
        resolveAndValidateHostname('registry.npmjs.org', mockResolver)
      ).rejects.toThrow(/blocked\/private\/metadata range/);
    });

    it('simulates DNS rebinding and proves proxy connects only to the validated literal IP', async () => {
      let lookupCount = 0;
      const mockResolver = {
        resolve4: vi.fn().mockImplementation(() => {
          lookupCount++;
          if (lookupCount === 1) {
            return Promise.resolve(['104.16.19.35']); // 1st lookup: legitimate public IP
          }
          return Promise.resolve(['169.254.169.254']); // 2nd lookup: rebind attempt to metadata IP
        }),
      };

      const connectCalls = [];
      const mockConnectFn = vi.fn().mockImplementation((opts) => {
        connectCalls.push(opts);
        const socket = new net.Socket();
        process.nextTick(() => socket.emit('connect'));
        return socket;
      });

      const proxy = createEgressProxy({
        resolver: mockResolver,
        connectFn: mockConnectFn,
      });

      await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
      const proxyPort = proxy.address().port;

      // 1. Initial connection: resolves to 104.16.19.35
      const res1 = await executeTestConnect(proxyPort, 'registry.npmjs.org:443', 'registry.npmjs.org');
      expect(res1.statusCode).toBe(200);
      expect(connectCalls[0].host).toBe('104.16.19.35'); // Pinned literal IP!
      expect(connectCalls[0].host).not.toBe('registry.npmjs.org');

      // 2. Second connection: resolver rebinds to 169.254.169.254
      // Proxy must block the connection and NEVER call mockConnectFn!
      const initialConnectCount = connectCalls.length;
      const res2 = await executeTestConnect(proxyPort, 'registry.npmjs.org:443', 'registry.npmjs.org');
      expect(res2.statusCode).toBe(403);
      expect(connectCalls.length).toBe(initialConnectCount); // NO TCP socket opened to blocked address!

      await new Promise((resolve) => proxy.close(resolve));
    });

    it('Task 3.3 Regression: Proves proxy never establishes an outbound TCP socket for rejected IANA destinations', async () => {
      const rejectedAddresses = [
        { ip: '192.0.0.170', desc: 'NAT64/DNS64 Discovery (RFC 7050)' },
        { ip: '192.0.0.171', desc: 'NAT64/DNS64 Discovery (RFC 8880)' },
        { ip: '192.0.0.1', desc: 'Non-global address in 192.0.0.0/24 parent range' },
      ];

      for (const item of rejectedAddresses) {
        const mockResolver = {
          resolve4: vi.fn().mockResolvedValue([item.ip]),
        };
        const mockConnectFn = vi.fn();

        const proxy = createEgressProxy({
          resolver: mockResolver,
          connectFn: mockConnectFn,
        });

        await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
        const proxyPort = proxy.address().port;

        const res = await executeTestConnect(proxyPort, 'registry.npmjs.org:443', 'registry.npmjs.org');
        expect(res.statusCode).toBe(403);
        // CRITICAL: Zero outbound TCP connection attempts to rejected destination!
        expect(mockConnectFn).toHaveBeenCalledTimes(0);

        await new Promise((resolve) => proxy.close(resolve));
      }
    });

    it('Task 3.3 Regression: Proves proxy accepts globally reachable IANA special-purpose assignments', async () => {
      const approvedAddresses = [
        { ip: '192.0.0.9', desc: 'PCP Anycast (RFC 7723)' },
        { ip: '192.0.0.10', desc: 'TURN Anycast (RFC 8155)' },
        { ip: '192.31.196.1', desc: 'AS112-v4 (RFC 7535)' },
        { ip: '192.52.193.1', desc: 'AMT (RFC 7450)' },
        { ip: '192.175.48.1', desc: 'AS112 Direct Delegation (RFC 7535)' },
      ];

      for (const item of approvedAddresses) {
        const mockResolver = {
          resolve4: vi.fn().mockResolvedValue([item.ip]),
        };
        const connectCalls = [];
        const mockConnectFn = vi.fn().mockImplementation((opts) => {
          connectCalls.push(opts);
          const socket = new net.Socket();
          process.nextTick(() => socket.emit('connect'));
          return socket;
        });

        const proxy = createEgressProxy({
          resolver: mockResolver,
          connectFn: mockConnectFn,
        });

        await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
        const proxyPort = proxy.address().port;

        const res = await executeTestConnect(proxyPort, 'registry.npmjs.org:443', 'registry.npmjs.org');
        expect(res.statusCode).toBe(200);
        expect(mockConnectFn).toHaveBeenCalledTimes(1);
        expect(connectCalls[0].host).toBe(item.ip); // Connected to validated literal IP!

        await new Promise((resolve) => proxy.close(resolve));
      }
    });
  });

  describe('3. TLS ClientHello SNI Verification & Unconditional ECH Rejection (Task 3.2)', () => {
    it('parses valid TLS ClientHello with server_name extension', () => {
      const clientHello = buildSyntheticClientHello('registry.npmjs.org');
      const parsed = parseClientHello(clientHello);
      expect(parsed.valid).toBe(true);
      expect(parsed.sni).toBe('registry.npmjs.org');
      expect(parsed.hasEch).toBe(false);
    });

    it('detects Encrypted ClientHello (ECH) extension 0xfe0d', () => {
      const clientHelloWithEch = buildSyntheticClientHello('registry.npmjs.org', { addEch: true });
      const parsed = parseClientHello(clientHelloWithEch);
      expect(parsed.valid).toBe(true);
      expect(parsed.sni).toBe('registry.npmjs.org');
      expect(parsed.hasEch).toBe(true);
    });

    it('rejects non-handshake data safely', () => {
      const parsed = parseClientHello(Buffer.from('GET / HTTP/1.1\r\n\r\n'));
      expect(parsed.valid).toBe(false);
      expect(parsed.reason).toBe('not_handshake_record');
    });

    it('marks truncated records as incomplete to allow fragment buffering', () => {
      const fullRecord = buildSyntheticClientHello('registry.npmjs.org');
      const fragment1 = fullRecord.subarray(0, 10);
      const parsed = parseClientHello(fragment1);
      expect(parsed.valid).toBe(false);
      expect(parsed.incomplete).toBe(true);
    });

    it('Case 1: Normal registry CONNECT with matching SNI is accepted', async () => {
      const openSockets = [];
      const targetServer = net.createServer((socket) => {
        openSockets.push(socket);
        socket.on('data', () => {});
      });
      await new Promise((resolve) => targetServer.listen(0, '127.0.0.1', resolve));
      const targetPort = targetServer.address().port;

      const mockConnectFn = vi.fn().mockImplementation(() => {
        const s = net.connect(targetPort, '127.0.0.1');
        openSockets.push(s);
        return s;
      });

      const proxy = createEgressProxy({
        resolver: { resolve4: vi.fn().mockResolvedValue(['104.16.19.35']) },
        connectFn: mockConnectFn,
      });

      await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
      const proxyPort = proxy.address().port;

      const res = await executeTestConnect(proxyPort, 'registry.npmjs.org:443', 'registry.npmjs.org');
      expect(res.statusCode).toBe(200);
      expect(res.sniAccepted).toBe(true);
      expect(mockConnectFn).toHaveBeenCalledTimes(1);

      for (const s of openSockets) {
        try { s.destroy(); } catch {}
      }
      await new Promise((resolve) => proxy.close(resolve));
      await new Promise((resolve) => targetServer.close(resolve));
    });

    it('Case 2: CONNECT registry.npmjs.org:443 with ECH and approved outer SNI is rejected unconditionally', async () => {
      const mockConnectFn = vi.fn();

      const proxy = createEgressProxy({
        resolver: { resolve4: vi.fn().mockResolvedValue(['104.16.19.35']) },
        connectFn: mockConnectFn,
      });

      await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
      const proxyPort = proxy.address().port;

      const res = await executeTestConnect(proxyPort, 'registry.npmjs.org:443', 'registry.npmjs.org', { addEch: true });
      expect(res.sniAccepted).toBe(false);
      // Zero upstream TCP connection attempts!
      expect(mockConnectFn).not.toHaveBeenCalled();

      await new Promise((resolve) => proxy.close(resolve));
    });

    it('Case 3: CONNECT registry.npmjs.org:443 with ECH and unapproved outer SNI is rejected', async () => {
      const mockConnectFn = vi.fn();

      const proxy = createEgressProxy({
        resolver: { resolve4: vi.fn().mockResolvedValue(['104.16.19.35']) },
        connectFn: mockConnectFn,
      });

      await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
      const proxyPort = proxy.address().port;

      const res = await executeTestConnect(proxyPort, 'registry.npmjs.org:443', 'evil.example.com', { addEch: true });
      expect(res.sniAccepted).toBe(false);
      expect(mockConnectFn).not.toHaveBeenCalled();

      await new Promise((resolve) => proxy.close(resolve));
    });

    it('Case 4: ECH with malformed ClientHello is rejected safely without crashes', async () => {
      const mockConnectFn = vi.fn();

      const proxy = createEgressProxy({
        resolver: { resolve4: vi.fn().mockResolvedValue(['104.16.19.35']) },
        connectFn: mockConnectFn,
      });

      await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
      const proxyPort = proxy.address().port;

      // Construct a complete TLS record with invalid handshake type and corrupted ECH tag
      const malformedPayload = Buffer.from([
        0x16, 0x03, 0x01, 0x00, 0x0a, // Record: Handshake, length 10
        0x02,                         // Handshake type 0x02 (ServerHello, not ClientHello)
        0x00, 0x00, 0x06,             // Length 6
        0xfe, 0x0d, 0x00, 0x02, 0xaa, 0xbb // ECH extension
      ]);

      const client = net.connect(proxyPort, '127.0.0.1');
      let closed = false;

      await new Promise((resolve) => {
        client.on('connect', () => {
          client.write('CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\n\r\n');
        });
        client.on('data', (d) => {
          if (d.toString().includes('200 Connection Established')) {
            client.write(malformedPayload);
          }
        });
        client.on('close', () => {
          closed = true;
          resolve();
        });
      });

      expect(closed).toBe(true);
      expect(mockConnectFn).not.toHaveBeenCalled();

      await new Promise((resolve) => proxy.close(resolve));
    });

    it('Case 5: Verifies zero upstream TCP connection attempts for all rejected ECH cases', async () => {
      const mockConnectFn = vi.fn();

      const proxy = createEgressProxy({
        resolver: { resolve4: vi.fn().mockResolvedValue(['104.16.19.35']) },
        connectFn: mockConnectFn,
      });

      await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
      const proxyPort = proxy.address().port;

      // Send 3 separate ECH requests with varying payloads
      await executeTestConnect(proxyPort, 'registry.npmjs.org:443', 'registry.npmjs.org', { addEch: true });
      await executeTestConnect(proxyPort, 'registry.npmjs.org:443', 'evil.example.com', { addEch: true });
      await executeTestConnect(proxyPort, 'registry.npmjs.org:443', 'sub.registry.npmjs.org', { addEch: true });

      expect(mockConnectFn).toHaveBeenCalledTimes(0);

      await new Promise((resolve) => proxy.close(resolve));
    });

    it('rejects connection when SNI disagrees with CONNECT authority (mismatch)', async () => {
      const mockConnectFn = vi.fn();

      const proxy = createEgressProxy({
        resolver: { resolve4: vi.fn().mockResolvedValue(['104.16.19.35']) },
        connectFn: mockConnectFn,
      });

      await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
      const proxyPort = proxy.address().port;

      const res = await executeTestConnect(proxyPort, 'registry.npmjs.org:443', 'evil.example.com');
      expect(res.sniAccepted).toBe(false);
      expect(mockConnectFn).not.toHaveBeenCalled();

      await new Promise((resolve) => proxy.close(resolve));
    });

    it('rejects CONNECT to unapproved authority upfront', async () => {
      const mockConnectFn = vi.fn();
      const proxy = createEgressProxy({ connectFn: mockConnectFn });

      await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
      const proxyPort = proxy.address().port;

      const res = await executeTestConnect(proxyPort, 'evil.example.com:443', 'evil.example.com');
      expect(res.statusCode).toBe(403);
      expect(mockConnectFn).not.toHaveBeenCalled();

      await new Promise((resolve) => proxy.close(resolve));
    });
  });

  describe('4. Shared Aggregate Transfer Budget', () => {
    it('tracks bytes in both directions and terminates when budget is exceeded', async () => {
      const maxBudget = 1000; // 1000 bytes budget

      const targetServer = net.createServer((socket) => {
        socket.on('data', () => {
          socket.write(Buffer.alloc(1200, 'X'));
        });
      });
      await new Promise((resolve) => targetServer.listen(0, '127.0.0.1', resolve));
      const targetPort = targetServer.address().port;

      const mockConnectFn = vi.fn().mockImplementation(() => {
        return net.connect(targetPort, '127.0.0.1');
      });

      const proxy = createEgressProxy({
        maxBytes: maxBudget,
        resolver: { resolve4: vi.fn().mockResolvedValue(['104.16.19.35']) },
        connectFn: mockConnectFn,
      });

      await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
      const proxyPort = proxy.address().port;

      const client = net.connect(proxyPort, '127.0.0.1');
      let clientClosed = false;

      await new Promise((resolve) => {
        client.on('connect', () => {
          client.write('CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\n\r\n');
        });
        client.on('data', (chunk) => {
          if (chunk.toString().includes('200 Connection Established')) {
            client.write(buildSyntheticClientHello('registry.npmjs.org'));
          }
        });
        client.on('close', () => {
          clientClosed = true;
          resolve();
        });
      });

      expect(clientClosed).toBe(true);
      expect(proxy.getMetrics().totalBytesTransferred).toBeGreaterThanOrEqual(1000);

      // Now attempt another connection: must be rejected with 509 Bandwidth Limit Exceeded
      const resAfter = await executeTestConnect(proxyPort, 'registry.npmjs.org:443', 'registry.npmjs.org');
      expect(resAfter.statusCode).toBe(509);

      await new Promise((resolve) => proxy.close(resolve));
      await new Promise((resolve) => targetServer.close(resolve));
    });

    it('aggregates transfer bytes across multiple concurrent connections', async () => {
      const maxBudget = 2500; // 2500 bytes budget

      const targetServer = net.createServer((socket) => {
        socket.on('data', () => {
          socket.write(Buffer.alloc(1500, 'B'));
        });
      });
      await new Promise((resolve) => targetServer.listen(0, '127.0.0.1', resolve));
      const targetPort = targetServer.address().port;

      const mockConnectFn = vi.fn().mockImplementation(() => {
        return net.connect(targetPort, '127.0.0.1');
      });

      const proxy = createEgressProxy({
        maxBytes: maxBudget,
        resolver: { resolve4: vi.fn().mockResolvedValue(['104.16.19.35']) },
        connectFn: mockConnectFn,
      });

      await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
      const proxyPort = proxy.address().port;

      const client1 = net.connect(proxyPort, '127.0.0.1');
      const client2 = net.connect(proxyPort, '127.0.0.1');

      let client1Closed = false;
      let client2Closed = false;

      const p1 = new Promise((resolve) => {
        client1.on('connect', () => {
          client1.write('CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\n\r\n');
        });
        client1.on('data', (c) => {
          if (c.toString().includes('200 Connection Established')) {
            client1.write(buildSyntheticClientHello('registry.npmjs.org'));
          }
        });
        client1.on('close', () => {
          client1Closed = true;
          resolve();
        });
      });

      const p2 = new Promise((resolve) => {
        client2.on('connect', () => {
          client2.write('CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\n\r\n');
        });
        client2.on('data', (c) => {
          if (c.toString().includes('200 Connection Established')) {
            client2.write(buildSyntheticClientHello('registry.npmjs.org'));
          }
        });
        client2.on('close', () => {
          client2Closed = true;
          resolve();
        });
      });

      await Promise.all([p1, p2]);

      expect(client1Closed).toBe(true);
      expect(client2Closed).toBe(true);
      expect(proxy.getMetrics().totalBytesTransferred).toBeGreaterThanOrEqual(2500);

      await new Promise((resolve) => proxy.close(resolve));
      await new Promise((resolve) => targetServer.close(resolve));
    });
  });
});

// --- Helper Functions ---

function executeTestConnect(proxyPort, authority, sniServerName, options = {}) {
  return new Promise((resolve) => {
    const client = net.connect(proxyPort, '127.0.0.1');
    let statusCode = null;
    let sniAccepted = false;

    client.on('connect', () => {
      client.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });

    client.on('data', (chunk) => {
      const text = chunk.toString();
      if (!statusCode) {
        const m = text.match(/HTTP\/1\.[01]\s+(\d{3})/);
        if (m) {
          statusCode = parseInt(m[1], 10);
        }
      }
      if (text.includes('200 Connection Established')) {
        const ch = buildSyntheticClientHello(sniServerName, options);
        client.write(ch);
        setTimeout(() => {
          if (!client.destroyed) {
            sniAccepted = true;
            client.destroy();
          }
        }, 50);
      }
    });

    client.on('close', () => {
      resolve({ statusCode, sniAccepted });
    });

    client.on('error', () => {
      resolve({ statusCode: statusCode || 500, sniAccepted: false });
    });
  });
}

function buildSyntheticClientHello(sniHost, options = {}) {
  const hostBuf = Buffer.from(sniHost, 'utf8');

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
  if (options.addEch) {
    // ECH extension: 0xfe0d + len(4) + payload
    const echExt = Buffer.from([0xfe, 0x0d, 0x00, 0x04, 0x01, 0x02, 0x03, 0x04]);
    extensionsBlock = Buffer.concat([extensionsBlock, echExt]);
  }

  const extTotalLen = extensionsBlock.length;

  const chBody = Buffer.concat([
    Buffer.from([0x03, 0x03]),
    Buffer.alloc(32, 0xaa),
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

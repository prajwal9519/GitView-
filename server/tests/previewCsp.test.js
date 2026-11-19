/**
 * GitView Phase 5 — Milestone 7, Task 4: Content Security Policy & Defensive Security Headers Test Suite
 *
 * Verifies:
 * 1. STATIC dev CSP policy contains required directives (script-src, connect-src, frame-ancestors: http://localhost:5173)
 * 2. VITE dev CSP policy contains required directives (script-src with unsafe-eval, connect-src with ws:, frame-ancestors: http://localhost:5173)
 * 3. Production CSP policy contains required directives (frame-ancestors: https://app.gitview.dev, secure connect-src)
 * 4. Exact frame-ancestors value for dev vs prod (strict segregation, neither contains the other)
 * 5. Explicit form-action 'self' in all preview policies
 * 6. default-src 'none', object-src 'none', base-uri 'self' fail-closed baseline
 * 7. Vite HMR compatibility (ws: in dev connect-src; unsafe-eval in dev script-src)
 * 8. Upstream CSP combination: conjunction/intersection preserved, cannot weaken gateway policy
 * 9. External asset restrictions: only https:, data:, blob: allowed where applicable
 * 10. Error responses carry security headers (Referrer-Policy: no-referrer, nosniff, no-store, strict error CSP)
 * 11. Rejection of malformed or CRLF-injected upstream headers
 * 12. Cookie bootstrap behavior and defensive security headers
 * 13. Stripping of upstream X-Frame-Options to eliminate framing conflicts
 * 14. Gateway integration: end-to-end HTTP preview response carries all security headers
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import request from 'supertest';

import {
  buildCspPolicy,
  buildErrorCspPolicy,
  combineCspHeaders,
  getFrameAncestors,
  getPreviewSecurityHeaders,
  sanitizeUpstreamHeadersForClient,
  isSafeHeaderValue,
  FRAME_ANCESTORS_DEV,
  FRAME_ANCESTORS_PROD,
  PERMISSIONS_POLICY_DEFAULT,
  REFERRER_POLICY_DEFAULT,
  X_CONTENT_TYPE_OPTIONS_DEFAULT,
} from '../src/modules/preview/previewCsp.js';

import {
  createPreviewGateway,
  handlePreviewGateway,
  invalidateSessionGatewayCache,
  setDefaultDockerAdapter,
  getDefaultDockerAdapter,
  getSidecarVerificationCache,
} from '../src/modules/preview/previewGateway.js';

import { app } from '../src/app.js';
import { prisma, resetDb, createUser } from './helpers.js';
import { PreviewStatus, FrameworkType } from '../src/modules/preview/sessionConstants.js';
import {
  generatePreviewToken,
  hashPreviewToken,
  encryptPreviewToken,
} from '../src/utils/previewTokens.js';
import { getPreviewTargetOrigin, canonicalizeHostAuthority } from '../src/modules/preview/hostAuthority.js';
import { PREVIEW_COOKIE_NAME } from '../src/modules/preview/previewCookie.js';
import { getTicketStore } from '../src/modules/preview/ticketStore.js';

describe('Milestone 7, Task 4: Content Security Policy & Production Security Headers', () => {
  const originalDocker = getDefaultDockerAdapter();
  let user;
  let repo;
  let staticSession;
  let viteReactSession;
  let viteVanillaSession;
  let rawTokenStatic;
  let rawTokenVite;
  let targetOriginStatic;
  let targetHostAuthorityStatic;
  let targetOriginVite;
  let targetHostAuthorityVite;
  let mockUpstreamServer;
  let mockUpstreamPort;
  let mockDocker;

  beforeEach(async () => {
    await resetDb();
    vi.restoreAllMocks();

    user = await createUser({
      email: 'csp-test-user@example.com',
      username: 'csp_test_user',
    });

    repo = await prisma.repository.create({
      data: {
        userId: user.id,
        githubRepoId: '98001',
        owner: 'gitview-org',
        name: 'csp-test-repo',
        fullName: 'gitview-org/csp-test-repo',
        htmlUrl: 'https://github.com/gitview-org/csp-test-repo',
        defaultBranch: 'main',
        latestCommitSha: '0123456789abcdef0123456789abcdef01234567',
      },
    });

    // Mock upstream server simulating Option A sidecar
    await new Promise((resolve) => {
      mockUpstreamServer = http.createServer((req, res) => {
        if (req.url === '/with-xfo-deny') {
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'X-Frame-Options': 'DENY',
          });
          res.end('<html><body>App with XFO DENY</body></html>');
          return;
        }

        if (req.url === '/with-xfo-sameorigin') {
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'x-frame-options': 'SAMEORIGIN',
          });
          res.end('<html><body>App with xfo sameorigin</body></html>');
          return;
        }

        if (req.url === '/with-upstream-csp') {
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Security-Policy': "img-src 'self' https://trusted-cdn.com",
          });
          res.end('<html><body>App with Upstream CSP</body></html>');
          return;
        }

        if (req.url === '/with-crlf-csp') {
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Security-Policy': "default-src 'none'\r\nX-Injected: evil",
          });
          res.end('<html><body>App with CRLF CSP</body></html>');
          return;
        }

        if (req.url === '/static/app.bundle.js') {
          res.writeHead(200, {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'public, max-age=31536000, immutable',
            'ETag': '"bundle-12345"',
            'Last-Modified': 'Wed, 19 Nov 2026 12:00:00 GMT',
          });
          res.end('console.log("Static asset");');
          return;
        }

        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'X-Upstream-Handled': 'true',
        });
        res.end('<!DOCTYPE html><html><head><title>Preview App</title></head><body><h1>Preview Running</h1></body></html>');
      });

      mockUpstreamServer.listen(0, '127.0.0.1', () => {
        mockUpstreamPort = mockUpstreamServer.address().port;
        resolve();
      });
    });

    // 1. STATIC session
    rawTokenStatic = generatePreviewToken();
    const tokenHashStatic = hashPreviewToken(rawTokenStatic);
    staticSession = await prisma.previewSession.create({
      data: {
        userId: user.id,
        repositoryId: repo.id,
        commitSha: '0123456789abcdef0123456789abcdef01234567',
        branch: 'main',
        framework: FrameworkType.STATIC,
        status: PreviewStatus.RUNNING,
        isActive: true,
        tokenHash: tokenHashStatic,
        previewTokenEnc: encryptPreviewToken(rawTokenStatic),
        proxyPort: mockUpstreamPort,
        proxyContainerId: `gitview-proxy-${crypto.randomUUID()}`,
        proxyInstanceId: crypto.randomUUID(),
        runnerContainerId: `gitview-runner-${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + 3600 * 1000),
        lastActiveAt: new Date(),
        startedAt: new Date(),
      },
    });
    targetOriginStatic = getPreviewTargetOrigin(staticSession.id);
    targetHostAuthorityStatic = canonicalizeHostAuthority(targetOriginStatic);

    // 2. VITE_REACT session (needs separate user due to PreviewSession_userId_key unique constraint)
    const userVite = await createUser({
      email: 'csp-vite-user@example.com',
      username: 'csp_vite_user',
    });
    const repoVite = await prisma.repository.create({
      data: {
        userId: userVite.id,
        githubRepoId: '98002',
        owner: 'gitview-org',
        name: 'csp-vite-repo',
        fullName: 'gitview-org/csp-vite-repo',
        htmlUrl: 'https://github.com/gitview-org/csp-vite-repo',
        defaultBranch: 'main',
        latestCommitSha: '0123456789abcdef0123456789abcdef01234567',
      },
    });

    rawTokenVite = generatePreviewToken();
    const tokenHashVite = hashPreviewToken(rawTokenVite);
    viteReactSession = await prisma.previewSession.create({
      data: {
        userId: userVite.id,
        repositoryId: repoVite.id,
        commitSha: '0123456789abcdef0123456789abcdef01234567',
        branch: 'main',
        framework: FrameworkType.VITE_REACT,
        status: PreviewStatus.RUNNING,
        isActive: true,
        tokenHash: tokenHashVite,
        previewTokenEnc: encryptPreviewToken(rawTokenVite),
        proxyPort: mockUpstreamPort,
        proxyContainerId: `gitview-proxy-${crypto.randomUUID()}`,
        proxyInstanceId: crypto.randomUUID(),
        runnerContainerId: `gitview-runner-${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + 3600 * 1000),
        lastActiveAt: new Date(),
        startedAt: new Date(),
      },
    });
    targetOriginVite = getPreviewTargetOrigin(viteReactSession.id);
    targetHostAuthorityVite = canonicalizeHostAuthority(targetOriginVite);

    // Mock Docker adapter for sidecar verification
    mockDocker = {
      inspectContainer: vi.fn(async (containerId) => {
        let matchingSession = staticSession;
        if (containerId === viteReactSession.proxyContainerId) {
          matchingSession = viteReactSession;
        }
        return {
          State: { Running: true },
          Config: {
            Labels: {
              'com.gitview.managed': 'true',
              'com.gitview.session-id': matchingSession.id,
              'com.gitview.role': 'proxy',
              'com.gitview.sidecar-instance-id': matchingSession.proxyInstanceId,
            },
          },
          NetworkSettings: {
            Ports: {
              '80/tcp': [{ HostIp: '127.0.0.1', HostPort: String(mockUpstreamPort) }],
            },
          },
        };
      }),
    };
    setDefaultDockerAdapter(mockDocker);
  });

  afterEach(async () => {
    if (mockUpstreamServer) {
      await new Promise((resolve) => mockUpstreamServer.close(resolve));
    }
    setDefaultDockerAdapter(originalDocker);
    getSidecarVerificationCache().clear();
    invalidateSessionGatewayCache(staticSession?.id);
    invalidateSessionGatewayCache(viteReactSession?.id);
  });

  // =========================================================================
  // 1. STATIC Development CSP Policy
  // =========================================================================
  describe('1. STATIC Development CSP Policy', () => {
    it('generates compliant CSP policy for STATIC framework in development', () => {
      const csp = buildCspPolicy({
        framework: FrameworkType.STATIC,
        isProduction: false,
      });

      // Must contain:
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("script-src 'self' 'unsafe-inline' https:");
      expect(csp).toContain("style-src 'self' 'unsafe-inline' https:");
      expect(csp).toContain("img-src 'self' data: blob: https:");
      expect(csp).toContain("font-src 'self' data: https:");
      expect(csp).toContain("connect-src 'self' https:");
      expect(csp).toContain("worker-src 'self' blob:");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("base-uri 'self'");
      expect(csp).toContain("form-action 'self'");
      expect(csp).toContain(`frame-ancestors ${FRAME_ANCESTORS_DEV}`);

      // Must NOT contain:
      expect(csp).not.toContain("'unsafe-eval'");
      expect(csp).not.toContain('ws:');
      expect(csp).not.toContain('wss:');
      expect(csp).not.toContain(FRAME_ANCESTORS_PROD);
    });
  });

  // =========================================================================
  // 2. VITE Development CSP Policy
  // =========================================================================
  describe('2. VITE Development CSP Policy (VITE_REACT & VITE_VANILLA)', () => {
    it('generates compliant CSP policy for VITE_REACT in development with HMR support', () => {
      const csp = buildCspPolicy({
        framework: FrameworkType.VITE_REACT,
        isProduction: false,
      });

      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https:");
      expect(csp).toContain("style-src 'self' 'unsafe-inline' https:");
      expect(csp).toContain("img-src 'self' data: blob: https:");
      expect(csp).toContain("font-src 'self' data: https:");
      expect(csp).toContain("connect-src 'self' ws: wss: https: blob: data:");
      expect(csp).toContain("worker-src 'self' blob:");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("base-uri 'self'");
      expect(csp).toContain("form-action 'self'");
      expect(csp).toContain(`frame-ancestors ${FRAME_ANCESTORS_DEV}`);

      // Must NOT contain production frame ancestor:
      expect(csp).not.toContain(FRAME_ANCESTORS_PROD);
    });

    it('generates compliant CSP policy for VITE_VANILLA in development with HMR support', () => {
      const csp = buildCspPolicy({
        framework: FrameworkType.VITE_VANILLA,
        isProduction: false,
      });

      expect(csp).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https:");
      expect(csp).toContain("connect-src 'self' ws: wss: https: blob: data:");
      expect(csp).toContain(`frame-ancestors ${FRAME_ANCESTORS_DEV}`);
    });
  });

  // =========================================================================
  // 3. Production CSP Policy
  // =========================================================================
  describe('3. Production CSP Policy', () => {
    it('generates production framing policy targeting app.gitview.dev only', () => {
      const cspStaticProd = buildCspPolicy({
        framework: FrameworkType.STATIC,
        isProduction: true,
      });

      expect(cspStaticProd).toContain(`frame-ancestors ${FRAME_ANCESTORS_PROD}`);
      expect(cspStaticProd).toContain("connect-src 'self' https:");
      expect(cspStaticProd).not.toContain(FRAME_ANCESTORS_DEV);
      expect(cspStaticProd).not.toContain('localhost');

      const cspViteProd = buildCspPolicy({
        framework: FrameworkType.VITE_REACT,
        isProduction: true,
      });

      expect(cspViteProd).toContain(`frame-ancestors ${FRAME_ANCESTORS_PROD}`);
      // In production Vite, connect-src uses wss: but omits insecure ws:
      expect(cspViteProd).toContain("connect-src 'self' wss: https: blob: data:");
      expect(cspViteProd).not.toContain("ws: ");
      expect(cspViteProd).not.toContain(FRAME_ANCESTORS_DEV);
    });
  });

  // =========================================================================
  // 4. Exact frame-ancestors Segregation
  // =========================================================================
  describe('4. Strict Environment Segregation of frame-ancestors', () => {
    it('ensures dev and prod frame-ancestors are mutually exclusive and never mixed', () => {
      expect(FRAME_ANCESTORS_DEV).toBe('http://localhost:5173');
      expect(FRAME_ANCESTORS_PROD).toBe('https://app.gitview.dev');

      const devOrigin = getFrameAncestors(false);
      const prodOrigin = getFrameAncestors(true);

      expect(devOrigin).toBe('http://localhost:5173');
      expect(prodOrigin).toBe('https://app.gitview.dev');
      expect(devOrigin).not.toContain(prodOrigin);
      expect(prodOrigin).not.toContain(devOrigin);

      // Verify buildCspPolicy produces strict singular origin
      const devPolicy = buildCspPolicy({ isProduction: false });
      const prodPolicy = buildCspPolicy({ isProduction: true });

      expect(devPolicy).toContain('frame-ancestors http://localhost:5173;');
      expect(devPolicy).not.toContain('https://app.gitview.dev');

      expect(prodPolicy).toContain('frame-ancestors https://app.gitview.dev;');
      expect(prodPolicy).not.toContain('http://localhost:5173');
    });

    it('permits a safe custom frame-ancestors override but rejects injection', () => {
      const custom = getFrameAncestors(false, 'https://staging.gitview.dev');
      expect(custom).toBe('https://staging.gitview.dev');

      expect(() => {
        getFrameAncestors(false, 'http://localhost:5173\r\nEvil: injected');
      }).toThrow('Invalid frame-ancestors override');
    });
  });

  // =========================================================================
  // 5. Explicit form-action 'self'
  // =========================================================================
  describe('5. Explicit form-action Directive', () => {
    it('enforces form-action \'self\' across STATIC, VITE, and error policies', () => {
      const staticDev = buildCspPolicy({ framework: FrameworkType.STATIC, isProduction: false });
      const staticProd = buildCspPolicy({ framework: FrameworkType.STATIC, isProduction: true });
      const viteDev = buildCspPolicy({ framework: FrameworkType.VITE_REACT, isProduction: false });
      const viteProd = buildCspPolicy({ framework: FrameworkType.VITE_REACT, isProduction: true });
      const errorCsp = buildErrorCspPolicy();

      expect(staticDev).toContain("form-action 'self'");
      expect(staticProd).toContain("form-action 'self'");
      expect(viteDev).toContain("form-action 'self'");
      expect(viteProd).toContain("form-action 'self'");
      // Error CSP locks down completely:
      expect(errorCsp).toContain("form-action 'none'");
    });
  });

  // =========================================================================
  // 6. Fail-Closed Baseline Directives
  // =========================================================================
  describe('6. Baseline Fail-Closed Directives (default-src, object-src, base-uri)', () => {
    it('enforces default-src \'none\', object-src \'none\', and base-uri \'self\' across all policies', () => {
      const policies = [
        buildCspPolicy({ framework: FrameworkType.STATIC, isProduction: false }),
        buildCspPolicy({ framework: FrameworkType.STATIC, isProduction: true }),
        buildCspPolicy({ framework: FrameworkType.VITE_REACT, isProduction: false }),
        buildCspPolicy({ framework: FrameworkType.VITE_VANILLA, isProduction: false }),
        buildCspPolicy({ framework: FrameworkType.VITE_REACT, isProduction: true }),
      ];

      for (const p of policies) {
        expect(p).toContain("default-src 'none'");
        expect(p).toContain("object-src 'none'");
        expect(p).toContain("base-uri 'self'");
        expect(p).toContain("worker-src 'self' blob:");
      }
    });
  });

  // =========================================================================
  // 7. Vite HMR Compatibility
  // =========================================================================
  describe('7. Vite HMR Compatibility', () => {
    it('permits required capabilities for Vite Hot Module Replacement in dev', () => {
      const vitePolicy = buildCspPolicy({ framework: FrameworkType.VITE_REACT, isProduction: false });

      // WebSocket connections for HMR
      expect(vitePolicy).toContain("ws:");
      expect(vitePolicy).toContain("wss:");
      expect(vitePolicy).toMatch(/connect-src [^;]*ws:/);

      // Eval for source maps and Fast Refresh preamble
      expect(vitePolicy).toContain("'unsafe-eval'");
      expect(vitePolicy).toContain("'unsafe-inline'");
      expect(vitePolicy).toContain("blob:");
    });
  });

  // =========================================================================
  // 8. Upstream CSP Combination & Conjunction
  // =========================================================================
  describe('8. Upstream CSP Conjunction (combineCspHeaders)', () => {
    it('combines Gateway mandatory policy with upstream application CSP header', () => {
      const gatewayPolicy = buildCspPolicy({ framework: FrameworkType.STATIC, isProduction: false });
      const upstreamPolicy = "img-src 'self' https://images.unsplash.com;";

      const combined = combineCspHeaders(gatewayPolicy, upstreamPolicy);

      expect(Array.isArray(combined)).toBe(true);
      expect(combined.length).toBe(2);
      expect(combined[0]).toBe(gatewayPolicy.trim());
      expect(combined[1]).toBe(upstreamPolicy.trim());
    });

    it('preserves multiple upstream CSP headers if provided in an array', () => {
      const gatewayPolicy = buildCspPolicy({ framework: FrameworkType.STATIC, isProduction: false });
      const upstreamList = [
        "style-src 'self' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
      ];

      const combined = combineCspHeaders(gatewayPolicy, upstreamList);
      expect(combined.length).toBe(3);
      expect(combined[0]).toBe(gatewayPolicy.trim());
      expect(combined[1]).toBe(upstreamList[0]);
      expect(combined[2]).toBe(upstreamList[1]);
    });

    it('returns singular gateway policy when upstream CSP is null or empty', () => {
      const gatewayPolicy = buildCspPolicy();
      expect(combineCspHeaders(gatewayPolicy, null)).toEqual([gatewayPolicy.trim()]);
      expect(combineCspHeaders(gatewayPolicy, '')).toEqual([gatewayPolicy.trim()]);
      expect(combineCspHeaders(gatewayPolicy, '   ')).toEqual([gatewayPolicy.trim()]);
    });

    it('throws when gateway policy is missing or invalid', () => {
      expect(() => combineCspHeaders(null)).toThrow('gatewayPolicy must be a non-empty string');
      expect(() => combineCspHeaders('')).toThrow('gatewayPolicy must be a non-empty string');
    });
  });

  // =========================================================================
  // 9. External Asset Restrictions
  // =========================================================================
  describe('9. External Asset Restrictions', () => {
    it('restricts script, style, image, font, and connect external sources to https:, blob:, data:', () => {
      const p = buildCspPolicy({ framework: FrameworkType.STATIC, isProduction: false });

      // No http: schemes allowed for external resources
      expect(p).not.toMatch(/script-src [^;]*http:/);
      expect(p).not.toMatch(/style-src [^;]*http:/);
      expect(p).not.toMatch(/img-src [^;]*http:/);
      expect(p).not.toMatch(/font-src [^;]*http:/);

      // Only https: allowed externally
      expect(p).toMatch(/script-src 'self' 'unsafe-inline' https:/);
      expect(p).toMatch(/style-src 'self' 'unsafe-inline' https:/);
      expect(p).toMatch(/img-src 'self' data: blob: https:/);
      expect(p).toMatch(/font-src 'self' data: https:/);
    });
  });

  // =========================================================================
  // 10. Error Responses Carry Security Headers
  // =========================================================================
  describe('10. Defensive Headers on Error Responses', () => {
    it('generates defensive security headers for error responses', () => {
      const headers = getPreviewSecurityHeaders({ isError: true, isProduction: false });

      expect(headers['content-security-policy']).toBe(
        "default-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors http://localhost:5173;"
      );
      expect(headers['x-content-type-options']).toBe(X_CONTENT_TYPE_OPTIONS_DEFAULT);
      expect(headers['referrer-policy']).toBe(REFERRER_POLICY_DEFAULT);
      expect(headers['permissions-policy']).toBe(PERMISSIONS_POLICY_DEFAULT);
      expect(headers['cache-control']).toBe('no-store, no-cache, must-revalidate');
      expect(headers['pragma']).toBe('no-cache');
    });

    it('generates production error headers with prod frame-ancestors', () => {
      const headers = getPreviewSecurityHeaders({ isError: true, isProduction: true });
      expect(headers['content-security-policy']).toContain(`frame-ancestors ${FRAME_ANCESTORS_PROD}`);
    });
  });

  // =========================================================================
  // 11. Rejection of CRLF-injected Upstream Headers
  // =========================================================================
  describe('11. CRLF Injection Rejection (isSafeHeaderValue & combineCspHeaders)', () => {
    it('detects and rejects CRLF or null-byte characters in header values', () => {
      expect(isSafeHeaderValue('valid-value-123')).toBe(true);
      expect(isSafeHeaderValue('default-src \'self\' https:')).toBe(true);

      // CRLF injections
      expect(isSafeHeaderValue('value\r\nX-Injected: evil')).toBe(false);
      expect(isSafeHeaderValue('value\nInjected: evil')).toBe(false);
      expect(isSafeHeaderValue('value\rInjected: evil')).toBe(false);
      expect(isSafeHeaderValue('value\0nullbyte')).toBe(false);
      expect(isSafeHeaderValue(123)).toBe(false);
      expect(isSafeHeaderValue(null)).toBe(false);
    });

    it('silently ignores CRLF-injected upstream CSP headers during combination', () => {
      const gatewayPolicy = buildCspPolicy();
      const maliciousUpstream = "default-src 'self'\r\nInjected-Header: evil";

      const combined = combineCspHeaders(gatewayPolicy, maliciousUpstream);
      // Malicious upstream was discarded; only gateway policy remains
      expect(combined).toEqual([gatewayPolicy.trim()]);
    });
  });

  // =========================================================================
  // 12. Cookie Bootstrap Defensive Security Headers
  // =========================================================================
  describe('12. Bootstrap Endpoint Defensive Security Headers', () => {
    it('sets strict defensive security headers on GET /__gitview_bootstrap', async () => {
      const ticketStore = getTicketStore();
      const ticket = crypto.randomBytes(32).toString('hex');
      await ticketStore.setTicket(
        ticket,
        {
          sessionId: staticSession.id,
          targetOrigin: targetOriginStatic,
          targetHostAuthority: targetHostAuthorityStatic,
          sessionExpiresAtMs: Date.now() + 3600000,
          expiresAt: new Date(Date.now() + 30000).toISOString(),
          mode: 'iframe',
        },
        30
      );

      const res = await request(app)
        .get(`/__gitview_bootstrap?ticket=${ticket}`)
        .set('Host', targetHostAuthorityStatic);

      expect(res.status).toBe(302);
      expect(res.headers['location']).toBe('/');
      expect(res.headers['cache-control']).toBe('no-store, no-cache, must-revalidate');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['permissions-policy']).toBe(PERMISSIONS_POLICY_DEFAULT);
      expect(res.headers['content-security-policy']).toContain("default-src 'none'");
      expect(res.headers['content-security-policy']).toContain(`frame-ancestors ${FRAME_ANCESTORS_DEV}`);
    });
  });

  // =========================================================================
  // 13. Stripping of Upstream X-Frame-Options
  // =========================================================================
  describe('13. Stripping of Upstream X-Frame-Options', () => {
    it('sanitizeUpstreamHeadersForClient unconditionally deletes X-Frame-Options and x-frame-options', () => {
      const headers = {
        'content-type': 'text/html',
        'X-Frame-Options': 'DENY',
        'x-frame-options': 'SAMEORIGIN',
        'cache-control': 'public, max-age=3600',
      };

      const sanitized = sanitizeUpstreamHeadersForClient(headers);

      expect(sanitized['X-Frame-Options']).toBeUndefined();
      expect(sanitized['x-frame-options']).toBeUndefined();
      expect(sanitized['content-type']).toBe('text/html');
      expect(sanitized['cache-control']).toBe('public, max-age=3600');
    });

    it('live gateway strips upstream X-Frame-Options: DENY from response', async () => {
      const res = await request(app)
        .get('/with-xfo-deny')
        .set('Host', targetHostAuthorityStatic)
        .set('Cookie', `${PREVIEW_COOKIE_NAME}=${rawTokenStatic}`);

      expect(res.status).toBe(200);
      expect(res.headers['x-frame-options']).toBeUndefined();
      expect(res.headers['X-Frame-Options']).toBeUndefined();
      expect(res.headers['content-security-policy']).toContain(`frame-ancestors ${FRAME_ANCESTORS_DEV}`);
    });

    it('live gateway strips upstream x-frame-options: SAMEORIGIN from response', async () => {
      const res = await request(app)
        .get('/with-xfo-sameorigin')
        .set('Host', targetHostAuthorityStatic)
        .set('Cookie', `${PREVIEW_COOKIE_NAME}=${rawTokenStatic}`);

      expect(res.status).toBe(200);
      expect(res.headers['x-frame-options']).toBeUndefined();
      expect(res.headers['content-security-policy']).toContain(`frame-ancestors ${FRAME_ANCESTORS_DEV}`);
    });
  });

  // =========================================================================
  // 14. Live Gateway Integration: Full Security Header Suite
  // =========================================================================
  describe('14. Live Gateway Integration: Full Security Header Verification', () => {
    it('injects all defensive security headers on STATIC preview response', async () => {
      const res = await request(app)
        .get('/')
        .set('Host', targetHostAuthorityStatic)
        .set('Cookie', `${PREVIEW_COOKIE_NAME}=${rawTokenStatic}`);

      expect(res.status).toBe(200);

      // 1. Content-Security-Policy (STATIC dev policy)
      const csp = res.headers['content-security-policy'];
      expect(csp).toBeTruthy();
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("script-src 'self' 'unsafe-inline' https:");
      expect(csp).toContain("connect-src 'self' https:");
      expect(csp).toContain(`frame-ancestors ${FRAME_ANCESTORS_DEV}`);
      expect(csp).not.toContain("'unsafe-eval'");
      expect(csp).not.toContain('ws:');

      // 2. Defensive headers
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['permissions-policy']).toBe(PERMISSIONS_POLICY_DEFAULT);

      // 3. Content-aware Cache-Control on HTML entrypoint
      expect(res.headers['cache-control']).toBe('no-cache, must-revalidate');

      // 4. Conflicting framing header absent
      expect(res.headers['x-frame-options']).toBeUndefined();
    });

    it('injects all defensive security headers on VITE_REACT preview response', async () => {
      const res = await request(app)
        .get('/')
        .set('Host', targetHostAuthorityVite)
        .set('Cookie', `${PREVIEW_COOKIE_NAME}=${rawTokenVite}`);

      expect(res.status).toBe(200);

      // VITE policy includes unsafe-eval and ws: in connect-src
      const csp = res.headers['content-security-policy'];
      expect(csp).toBeTruthy();
      expect(csp).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https:");
      expect(csp).toContain("connect-src 'self' ws: wss: https: blob: data:");
      expect(csp).toContain(`frame-ancestors ${FRAME_ANCESTORS_DEV}`);

      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['permissions-policy']).toBe(PERMISSIONS_POLICY_DEFAULT);
      expect(res.headers['x-frame-options']).toBeUndefined();
    });

    it('combines upstream application CSP with Gateway policy on live gateway response', async () => {
      const res = await request(app)
        .get('/with-upstream-csp')
        .set('Host', targetHostAuthorityStatic)
        .set('Cookie', `${PREVIEW_COOKIE_NAME}=${rawTokenStatic}`);

      expect(res.status).toBe(200);

      const csp = res.headers['content-security-policy'];
      expect(csp).toBeTruthy();
      // Either array or comma-separated depending on transport representation
      const cspStr = Array.isArray(csp) ? csp.join('; ') : csp;
      expect(cspStr).toContain("default-src 'none'");
      expect(cspStr).toContain("img-src 'self' https://trusted-cdn.com");
    });

    it('discards CRLF-injected upstream CSP and sanitizes headers', () => {
      // 1. Direct getPreviewSecurityHeaders rejects CRLF injection
      const sec = getPreviewSecurityHeaders({
        framework: FrameworkType.STATIC,
        isProduction: false,
        upstreamHeaders: {
          'content-security-policy': "default-src 'self'\r\nX-Injected: evil",
        },
      });

      const csp = sec['content-security-policy'];
      expect(csp).toBeTruthy();
      expect(csp).not.toContain('evil');
      expect(csp).not.toContain('X-Injected');
      expect(csp).toContain("default-src 'none'");

      // 2. sanitizeUpstreamHeadersForClient drops injected or malformed header keys and values
      const rawHeaders = {
        'content-type': 'text/html',
        'x-injected\r\nevil': 'malformed-key',
        'valid-header': 'safe-value',
        'injected-value': 'malicious\r\nvalue',
      };
      const clean = sanitizeUpstreamHeadersForClient(rawHeaders);
      expect(clean['content-type']).toBe('text/html');
      expect(clean['valid-header']).toBe('safe-value');
      expect(clean['x-injected\r\nevil']).toBeUndefined();
      expect(clean['injected-value']).toBeUndefined();
    });

    it('preserves upstream caching headers (Cache-Control, ETag, Last-Modified) on static subresources', async () => {
      const res = await request(app)
        .get('/static/app.bundle.js')
        .set('Host', targetHostAuthorityStatic)
        .set('Cookie', `${PREVIEW_COOKIE_NAME}=${rawTokenStatic}`);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/javascript');
      expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect(res.headers['etag']).toBe('"bundle-12345"');
      expect(res.headers['last-modified']).toBe('Wed, 19 Nov 2026 12:00:00 GMT');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
    });

    it('injects defensive security headers on preview error responses (401 TOKEN_MISSING)', async () => {
      const res = await request(app)
        .get('/')
        .set('Host', targetHostAuthorityStatic); // Missing preview cookie

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('TOKEN_MISSING');
      expect(res.headers['content-security-policy']).toContain("default-src 'none'");
      expect(res.headers['content-security-policy']).toContain("object-src 'none'");
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['permissions-policy']).toBe(PERMISSIONS_POLICY_DEFAULT);
      expect(res.headers['cache-control']).toBe('no-store, no-cache, must-revalidate');
    });

    it('injects defensive security headers on preview error responses (410 SESSION_STOPPED)', async () => {
      await prisma.previewSession.update({
        where: { id: staticSession.id },
        data: { status: PreviewStatus.STOPPED, isActive: false },
      });
      invalidateSessionGatewayCache(staticSession.id);

      const res = await request(app)
        .get('/')
        .set('Host', targetHostAuthorityStatic)
        .set('Cookie', `${PREVIEW_COOKIE_NAME}=${rawTokenStatic}`);

      expect(res.status).toBe(410);
      expect(res.body.error.code).toBe('SESSION_STOPPED');
      expect(res.headers['content-security-policy']).toContain("default-src 'none'");
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['cache-control']).toBe('no-store, no-cache, must-revalidate');
    });
  });
});

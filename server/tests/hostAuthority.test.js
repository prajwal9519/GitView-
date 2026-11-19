/**
 * GitView Phase 5 — Milestone 7: Canonical WHATWG Host Authority Acceptance Tests
 *
 * Verifies MILESTONE_7_ARCHITECTURE.md §3.3 & §12.1 Tier 1 Acceptance Tests:
 * 1. Exact match development: session-1.preview.localhost:3000 -> valid
 * 2. Case normalization: SESSION-1.PREVIEW.LOCALHOST:3000 -> valid
 * 3. Exact match production: session-1.gitview-preview.com (implicit 443) -> valid
 * 4. Explicit port production: session-1.gitview-preview.com:443 -> valid
 * 5. IPv6 literal authority: [::1]:3000 -> valid
 * 6. Missing port when target has non-default port -> rejected
 * 7. Port mismatch -> rejected
 * 8. Credential character @ in Host -> rejected
 * 9. Duplicate/comma-separated Host header -> rejected
 * 10. Malformed characters (slash, backslash, query, hash) in Host -> rejected
 * 11. Non-numeric port -> rejected
 * 12. Port out of range -> rejected
 * 13. Subdomain session ID mismatch -> rejected
 * 14. Target origin derivation logic (getPreviewTargetOrigin)
 */

import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  verifyHostAuthority,
  getPreviewTargetOrigin,
  normalizeHostAuthority,
  canonicalizeHostAuthority,
} from '../src/modules/preview/hostAuthority.js';

describe('Milestone 7, Task 2: Canonical WHATWG Host Authority Verification', () => {
  const DEV_ORIGIN = 'http://session-123.preview.localhost:3000';
  const PROD_ORIGIN = 'https://session-123.gitview-preview.com';
  const IPV6_ORIGIN = 'http://[::1]:3000';

  describe('Positive Canonical Verification Cases', () => {
    it('1. Accepts exact match in development environment', () => {
      const result = verifyHostAuthority('session-123.preview.localhost:3000', DEV_ORIGIN);
      expect(result.valid).toBe(true);
    });

    it('2. Accepts case-normalized host header in development', () => {
      const result = verifyHostAuthority('SESSION-123.PREVIEW.LOCALHOST:3000', DEV_ORIGIN);
      expect(result.valid).toBe(true);
    });

    it('3. Accepts production authority with implicit default port 443', () => {
      const result = verifyHostAuthority('session-123.gitview-preview.com', PROD_ORIGIN);
      expect(result.valid).toBe(true);
    });

    it('4. Accepts production authority with explicit port 443', () => {
      const result = verifyHostAuthority('session-123.gitview-preview.com:443', PROD_ORIGIN);
      expect(result.valid).toBe(true);
    });

    it('5. Accepts IPv6 bracketed literal authority with port', () => {
      const result = verifyHostAuthority('[::1]:3000', IPV6_ORIGIN);
      expect(result.valid).toBe(true);
    });
  });

  describe('Negative Host Authority Rejection Cases', () => {
    it('6. Rejects missing port when target origin has non-default port', () => {
      const result = verifyHostAuthority('session-123.preview.localhost', DEV_ORIGIN);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('HOST_HEADER_PORT_MISMATCH');
    });

    it('7. Rejects port mismatch in development', () => {
      const result = verifyHostAuthority('session-123.preview.localhost:8080', DEV_ORIGIN);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('HOST_HEADER_PORT_MISMATCH');
    });

    it('8. Rejects credentials character @ in Host header', () => {
      const result = verifyHostAuthority('user@session-123.preview.localhost:3000', DEV_ORIGIN);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('HOST_HEADER_MALFORMED_CHARACTERS');
    });

    it('9. Rejects duplicate / comma-separated Host headers', () => {
      const result = verifyHostAuthority(
        'session-123.preview.localhost:3000, evil.com:3000',
        DEV_ORIGIN
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('HOST_HEADER_DUPLICATE_OR_MULTIPLE');
    });

    it('10. Rejects malformed characters in Host header (slashes, backslashes, hash, query)', () => {
      expect(verifyHostAuthority('session-123.preview.localhost/path:3000', DEV_ORIGIN).valid).toBe(false);
      expect(verifyHostAuthority('session-123.preview.localhost\\win:3000', DEV_ORIGIN).valid).toBe(false);
      expect(verifyHostAuthority('session-123.preview.localhost?query=1:3000', DEV_ORIGIN).valid).toBe(false);
      expect(verifyHostAuthority('session-123.preview.localhost#hash:3000', DEV_ORIGIN).valid).toBe(false);
      expect(verifyHostAuthority('session-123.preview.localhost :3000', DEV_ORIGIN).valid).toBe(false);
    });

    it('11. Rejects non-numeric port strings', () => {
      const result = verifyHostAuthority('session-123.preview.localhost:abcd', DEV_ORIGIN);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('HOST_HEADER_PORT_NON_NUMERIC');
    });

    it('12. Rejects out-of-range port numbers (0 and >65535)', () => {
      expect(verifyHostAuthority('session-123.preview.localhost:0', DEV_ORIGIN).reason).toBe(
        'HOST_HEADER_PORT_OUT_OF_RANGE'
      );
      expect(verifyHostAuthority('session-123.preview.localhost:65536', DEV_ORIGIN).reason).toBe(
        'HOST_HEADER_PORT_OUT_OF_RANGE'
      );
      expect(verifyHostAuthority('session-123.preview.localhost:99999', DEV_ORIGIN).reason).toBe(
        'HOST_HEADER_PORT_OUT_OF_RANGE'
      );
    });

    it('13. Rejects subdomain session ID mismatch', () => {
      const result = verifyHostAuthority('session-999.preview.localhost:3000', DEV_ORIGIN);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('HOST_HEADER_HOSTNAME_MISMATCH');
    });

    it('Rejects non-string or array Host headers', () => {
      expect(verifyHostAuthority(null, DEV_ORIGIN).valid).toBe(false);
      expect(verifyHostAuthority(undefined, DEV_ORIGIN).valid).toBe(false);
      expect(verifyHostAuthority(['session-123.preview.localhost:3000'], DEV_ORIGIN).valid).toBe(false);
    });

    it('Rejects malformed IPv6 Host header', () => {
      expect(verifyHostAuthority('[::1', IPV6_ORIGIN).reason).toBe('HOST_HEADER_INVALID_IPV6');
      expect(verifyHostAuthority('[::1]extra', IPV6_ORIGIN).reason).toBe('HOST_HEADER_INVALID_IPV6_PORT');
    });
  });

  describe('getPreviewTargetOrigin()', () => {
    const sessionId = crypto.randomUUID();

    it('constructs standard local development origin with port 3000', () => {
      const origin = getPreviewTargetOrigin(sessionId, { port: 3000, isHttps: false, previewDomain: '' });
      expect(origin).toBe(`http://${sessionId}.preview.localhost:3000`);
    });

    it('omits port 80 for plain HTTP or port 443 for HTTPS', () => {
      const httpOrigin = getPreviewTargetOrigin(sessionId, { port: 80, isHttps: false, previewDomain: '' });
      expect(httpOrigin).toBe(`http://${sessionId}.preview.localhost`);

      const httpsOrigin = getPreviewTargetOrigin(sessionId, { port: 443, isHttps: true, previewDomain: '' });
      expect(httpsOrigin).toBe(`https://${sessionId}.preview.localhost`);
    });

    it('constructs dedicated preview domain origin in production', () => {
      const origin = getPreviewTargetOrigin(sessionId, {
        previewDomain: 'gitview-preview.com',
        isHttps: true,
      });
      expect(origin).toBe(`https://${sessionId}.gitview-preview.com`);
    });

    it('respects PREVIEW_BASE_URL override', () => {
      const origin = getPreviewTargetOrigin(sessionId, {
        previewBaseUrl: 'https://custom-preview.dev:8443',
      });
      expect(origin).toBe(`https://${sessionId}.custom-preview.dev:8443`);
    });

    it('throws when sessionId is missing', () => {
      expect(() => getPreviewTargetOrigin('')).toThrow('sessionId is required');
      expect(() => getPreviewTargetOrigin(null)).toThrow('sessionId is required');
    });
  });

  describe('normalizeHostAuthority()', () => {
    it('extracts and lowercases host authority from URL or host string', () => {
      expect(normalizeHostAuthority('http://MyHost.Local:3000/path')).toBe('myhost.local:3000');
      expect(normalizeHostAuthority('MYHOST.LOCAL:3000')).toBe('myhost.local:3000');
      expect(normalizeHostAuthority(null)).toBeNull();
    });
  });

  describe('canonicalizeHostAuthority() - WHATWG Effective Port Equivalence', () => {
    it('normalizes HTTPS hostname without port to explicit :443', () => {
      expect(canonicalizeHostAuthority('session-1.gitview-preview.com', 'https:')).toBe(
        'session-1.gitview-preview.com:443'
      );
    });

    it('normalizes HTTPS hostname with explicit :443 to explicit :443 (exact match)', () => {
      expect(canonicalizeHostAuthority('session-1.gitview-preview.com:443', 'https:')).toBe(
        'session-1.gitview-preview.com:443'
      );
      // Both representations produce identical canonical strings
      expect(canonicalizeHostAuthority('session-1.gitview-preview.com', 'https:')).toBe(
        canonicalizeHostAuthority('session-1.gitview-preview.com:443', 'https:')
      );
    });

    it('normalizes HTTP hostname without port to explicit :80', () => {
      expect(canonicalizeHostAuthority('session-1.preview.localhost', 'http:')).toBe(
        'session-1.preview.localhost:80'
      );
    });

    it('normalizes HTTP hostname with explicit :80 to explicit :80 (exact match)', () => {
      expect(canonicalizeHostAuthority('session-1.preview.localhost:80', 'http:')).toBe(
        'session-1.preview.localhost:80'
      );
      expect(canonicalizeHostAuthority('session-1.preview.localhost', 'http:')).toBe(
        canonicalizeHostAuthority('session-1.preview.localhost:80', 'http:')
      );
    });

    it('preserves non-default ports and case-normalizes hostnames', () => {
      expect(canonicalizeHostAuthority('SESSION-1.PREVIEW.LOCALHOST:3000', 'http:')).toBe(
        'session-1.preview.localhost:3000'
      );
    });

    it('canonicalizes fully qualified targetOrigin URLs with explicit or default ports', () => {
      expect(canonicalizeHostAuthority('https://session-1.gitview-preview.com')).toBe(
        'session-1.gitview-preview.com:443'
      );
      expect(canonicalizeHostAuthority('http://session-1.preview.localhost:3000')).toBe(
        'session-1.preview.localhost:3000'
      );
      expect(canonicalizeHostAuthority('http://[::1]:3000')).toBe('[::1]:3000');
      expect(canonicalizeHostAuthority('https://[::1]')).toBe('[::1]:443');
    });

    it('returns null for malformed authorities, credentials, or invalid ports', () => {
      expect(canonicalizeHostAuthority('user@session-1.preview.localhost:3000')).toBeNull();
      expect(canonicalizeHostAuthority('session-1.preview.localhost/path')).toBeNull();
      expect(canonicalizeHostAuthority('session-1.preview.localhost:abcd')).toBeNull();
      expect(canonicalizeHostAuthority('session-1.preview.localhost:0')).toBeNull();
      expect(canonicalizeHostAuthority('session-1.preview.localhost:70000')).toBeNull();
      expect(canonicalizeHostAuthority(null)).toBeNull();
      expect(canonicalizeHostAuthority('')).toBeNull();
    });
  });
});

/**
 * GitView Phase 5 — Milestone 6, Task 1: Lockfile Validator
 *
 * Deterministic, passive validator for npm package-lock.json files prior to dependency installation.
 * Enforces strict security boundaries, exact hostname allowlisting, integrity validation,
 * resource ceilings, and safe JSON parsing without executing code or touching the network.
 */

import { AppError } from '../../utils/AppError.js';

export const LockfileErrorCode = Object.freeze({
  LOCKFILE_EMPTY: 'LOCKFILE_EMPTY',
  LOCKFILE_TOO_LARGE: 'LOCKFILE_TOO_LARGE',
  LOCKFILE_PARSE_FAILED: 'LOCKFILE_PARSE_FAILED',
  LOCKFILE_NESTING_EXCEEDED: 'LOCKFILE_NESTING_EXCEEDED',
  LOCKFILE_INVALID_ROOT: 'LOCKFILE_INVALID_ROOT',
  LOCKFILE_UNSUPPORTED_VERSION: 'LOCKFILE_UNSUPPORTED_VERSION',
  LOCKFILE_MISSING_PACKAGES: 'LOCKFILE_MISSING_PACKAGES',
  LOCKFILE_PACKAGE_LIMIT_EXCEEDED: 'LOCKFILE_PACKAGE_LIMIT_EXCEEDED',
  LOCKFILE_INVALID_PACKAGE_ENTRY: 'LOCKFILE_INVALID_PACKAGE_ENTRY',
  LOCKFILE_INSECURE_URL_SCHEME: 'LOCKFILE_INSECURE_URL_SCHEME',
  LOCKFILE_UNAPPROVED_HOST: 'LOCKFILE_UNAPPROVED_HOST',
  LOCKFILE_URL_CREDENTIALS_DISALLOWED: 'LOCKFILE_URL_CREDENTIALS_DISALLOWED',
  LOCKFILE_GIT_DEPENDENCY_DISALLOWED: 'LOCKFILE_GIT_DEPENDENCY_DISALLOWED',
  LOCKFILE_LOCAL_DEPENDENCY_DISALLOWED: 'LOCKFILE_LOCAL_DEPENDENCY_DISALLOWED',
  LOCKFILE_MISSING_INTEGRITY: 'LOCKFILE_MISSING_INTEGRITY',
  LOCKFILE_INVALID_INTEGRITY: 'LOCKFILE_INVALID_INTEGRITY',
  LOCKFILE_INVALID_METADATA: 'LOCKFILE_INVALID_METADATA',
});

export class LockfileValidationError extends AppError {
  constructor(code, message) {
    super(400, code, message);
    this.name = 'LockfileValidationError';
    this.errorCode = code;
  }
}

export const MAX_LOCKFILE_BYTES = 1024 * 1024; // 1 MB
export const MAX_PACKAGE_DECLARATIONS = 5000;
export const MAX_NESTING_DEPTH = 32;
export const APPROVED_REGISTRY_HOST = 'registry.npmjs.org';
export const SUPPORTED_LOCKFILE_VERSIONS = Object.freeze([2, 3]);

/**
 * Standard Subresource Integrity (SRI) algorithm specifications.
 * Enforces correct base64 character sets and length boundaries.
 */
const SRI_ALGORITHMS = {
  sha512: {
    // 64 bytes -> 88 chars padded with ==, or 86 chars unpadded
    regex: /^[A-Za-z0-9+/]{86}(?:==)?$/,
  },
  sha384: {
    // 48 bytes -> 64 chars (no padding)
    regex: /^[A-Za-z0-9+/]{64}$/,
  },
  sha256: {
    // 32 bytes -> 44 chars padded with =, or 43 chars unpadded
    regex: /^[A-Za-z0-9+/]{43}(?:=)?$/,
  },
  sha1: {
    // 20 bytes -> 28 chars padded with =, or 27 chars unpadded (legacy npm packages)
    regex: /^[A-Za-z0-9+/]{27}(?:=)?$/,
  },
};

/**
 * Scans raw JSON string to verify maximum brace/bracket nesting depth.
 * Protects against deep recursion / stack overflow attacks in JSON.parse.
 *
 * @param {string} str - Raw JSON text
 * @param {number} maxDepth - Max allowable nesting depth
 * @returns {boolean} True if within depth limit, false if exceeded
 */
export function checkMaxNestingDepth(str, maxDepth = MAX_NESTING_DEPTH) {
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (char === '\\') {
        escape = true;
      } else if (char === '"') {
        inString = false;
      }
    } else {
      if (char === '"') {
        inString = true;
      } else if (char === '{' || char === '[') {
        depth++;
        if (depth > maxDepth) {
          return false;
        }
      } else if (char === '}' || char === ']') {
        depth--;
      }
    }
  }
  return true;
}

/**
 * Identifies if a string represents an unapproved Git dependency source.
 *
 * @param {string} val
 * @returns {boolean}
 */
export function isGitSpecifier(val) {
  if (typeof val !== 'string') return false;
  const lower = val.toLowerCase().trim();
  return (
    lower.startsWith('git://') ||
    lower.startsWith('git+ssh://') ||
    lower.startsWith('git+https://') ||
    lower.startsWith('git+http://') ||
    lower.startsWith('git+file://') ||
    lower.startsWith('github:') ||
    lower.startsWith('gitlab:') ||
    lower.startsWith('bitbucket:') ||
    lower.startsWith('gist:') ||
    /^git@[a-zA-Z0-9.-]+:/.test(lower) ||
    /\.git(#.*)?$/.test(lower)
  );
}

/**
 * Identifies if a string represents an unapproved local dependency source.
 *
 * @param {string} val
 * @returns {boolean}
 */
export function isLocalSpecifier(val) {
  if (typeof val !== 'string') return false;
  const lower = val.toLowerCase().trim();
  return lower.startsWith('file:') || lower.startsWith('link:');
}

/**
 * Validates Subresource Integrity (SRI) string format and approved cryptographic algorithms.
 *
 * @param {string} integrityStr
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateIntegrity(integrityStr) {
  if (typeof integrityStr !== 'string' || integrityStr.trim() === '') {
    return { valid: false, error: 'Integrity value must be a non-empty string' };
  }

  const tokens = integrityStr.trim().split(/\s+/);
  if (tokens.length === 0) {
    return { valid: false, error: 'Integrity value contains no tokens' };
  }

  let hasApprovedAlgorithm = false;

  for (const token of tokens) {
    const dashIndex = token.indexOf('-');
    if (dashIndex <= 0) {
      return { valid: false, error: `Malformed integrity token '${token}': missing algorithm separator` };
    }

    const algorithm = token.slice(0, dashIndex).toLowerCase();
    const digest = token.slice(dashIndex + 1);

    const spec = SRI_ALGORITHMS[algorithm];
    if (!spec) {
      return { valid: false, error: `Unapproved or unsupported integrity algorithm '${algorithm}'` };
    }

    if (!spec.regex.test(digest)) {
      return { valid: false, error: `Invalid base64 digest format or length for algorithm '${algorithm}'` };
    }

    hasApprovedAlgorithm = true;
  }

  if (!hasApprovedAlgorithm) {
    return { valid: false, error: 'No approved integrity algorithm found' };
  }

  return { valid: true };
}

/**
 * LockfileValidator
 * Passive, deterministic validator for npm package-lock.json v2/v3.
 */
export class LockfileValidator {
  /**
   * Validates raw package-lock.json content against security boundaries and structural constraints.
   *
   * @param {string|Buffer} content - Raw package-lock.json content
   * @returns {{ valid: boolean, packageCount?: number, lockfileVersion?: number, errorCode?: string, error?: string }}
   */
  static validate(content) {
    // 1. Content presence check
    if (content === null || content === undefined) {
      return {
        valid: false,
        errorCode: LockfileErrorCode.LOCKFILE_EMPTY,
        error: 'Lockfile content is null or undefined',
      };
    }

    // 2. Type and byte length check
    if (typeof content !== 'string' && !Buffer.isBuffer(content)) {
      return {
        valid: false,
        errorCode: LockfileErrorCode.LOCKFILE_PARSE_FAILED,
        error: 'Lockfile content must be a string or Buffer',
      };
    }

    const byteLength = Buffer.isBuffer(content) ? content.length : Buffer.byteLength(content, 'utf8');

    if (byteLength === 0) {
      return {
        valid: false,
        errorCode: LockfileErrorCode.LOCKFILE_EMPTY,
        error: 'Lockfile content is empty',
      };
    }

    if (byteLength > MAX_LOCKFILE_BYTES) {
      return {
        valid: false,
        errorCode: LockfileErrorCode.LOCKFILE_TOO_LARGE,
        error: `Lockfile size (${byteLength} bytes) exceeds maximum limit of ${MAX_LOCKFILE_BYTES} bytes (1 MB)`,
      };
    }

    const contentStr = Buffer.isBuffer(content) ? content.toString('utf8') : content;
    if (contentStr.trim().length === 0) {
      return {
        valid: false,
        errorCode: LockfileErrorCode.LOCKFILE_EMPTY,
        error: 'Lockfile content contains only whitespace',
      };
    }

    // 3. Nesting depth check before parsing (O(N) safe pre-scan)
    if (!checkMaxNestingDepth(contentStr, MAX_NESTING_DEPTH)) {
      return {
        valid: false,
        errorCode: LockfileErrorCode.LOCKFILE_NESTING_EXCEEDED,
        error: `Lockfile exceeds maximum allowable JSON nesting depth of ${MAX_NESTING_DEPTH}`,
      };
    }

    // 4. Safe JSON parsing
    let parsed;
    try {
      parsed = JSON.parse(contentStr);
    } catch (err) {
      return {
        valid: false,
        errorCode: LockfileErrorCode.LOCKFILE_PARSE_FAILED,
        error: `Malformed JSON in package-lock.json: ${err.message}`,
      };
    }

    // 5. Root structure check
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        valid: false,
        errorCode: LockfileErrorCode.LOCKFILE_INVALID_ROOT,
        error: 'Lockfile root must be a non-null object',
      };
    }

    // 6. Lockfile version check (Accept v2 and v3 only)
    if (parsed.lockfileVersion !== 2 && parsed.lockfileVersion !== 3) {
      return {
        valid: false,
        errorCode: LockfileErrorCode.LOCKFILE_UNSUPPORTED_VERSION,
        error: `Unsupported lockfileVersion '${parsed.lockfileVersion}'. Only versions 2 and 3 are supported`,
      };
    }

    // 7. Packages object check
    if (!parsed.packages || typeof parsed.packages !== 'object' || Array.isArray(parsed.packages)) {
      return {
        valid: false,
        errorCode: LockfileErrorCode.LOCKFILE_MISSING_PACKAGES,
        error: 'Lockfile must contain a valid packages object',
      };
    }

    // 8. Package declaration count check
    const packageKeys = Object.keys(parsed.packages);
    let totalDeclarations = packageKeys.length;

    // In lockfile v2, count and validate nested dependencies tree if present
    let v2DependencyCount = 0;
    if (parsed.lockfileVersion === 2 && parsed.dependencies) {
      if (typeof parsed.dependencies !== 'object' || Array.isArray(parsed.dependencies)) {
        return {
          valid: false,
          errorCode: LockfileErrorCode.LOCKFILE_INVALID_METADATA,
          error: 'Legacy dependencies tree in lockfile v2 must be an object',
        };
      }
      const v2CountResult = countAndValidateV2Dependencies(parsed.dependencies, 1);
      if (!v2CountResult.valid) {
        return v2CountResult;
      }
      v2DependencyCount = v2CountResult.count;
    }

    if (totalDeclarations > MAX_PACKAGE_DECLARATIONS) {
      return {
        valid: false,
        errorCode: LockfileErrorCode.LOCKFILE_PACKAGE_LIMIT_EXCEEDED,
        error: `Lockfile exceeds maximum of ${MAX_PACKAGE_DECLARATIONS} package declarations (found ${totalDeclarations})`,
        packageCount: totalDeclarations,
      };
    }

    // 9. Inspect all package declarations in packages object
    for (const pkgPath of packageKeys) {
      const pkg = parsed.packages[pkgPath];

      // Must be an object
      if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) {
        return {
          valid: false,
          errorCode: LockfileErrorCode.LOCKFILE_INVALID_PACKAGE_ENTRY,
          error: `Package declaration at '${pkgPath}' must be a non-null object`,
        };
      }

      // Root application package (usually "")
      if (pkgPath === '' || pkgPath === '.') {
        // Root package may declare dependencies/devDependencies - ensure no git/local specifiers
        const depCheck = checkDependencySpecifiers(pkg, pkgPath);
        if (!depCheck.valid) {
          return depCheck;
        }

        // If root has resolved, validate it
        if (pkg.resolved) {
          const resCheck = validateResolvedUrl(pkg.resolved, pkgPath);
          if (!resCheck.valid) return resCheck;
        }
        continue;
      }

      // Check for local link dependencies
      if (pkg.link === true) {
        return {
          valid: false,
          errorCode: LockfileErrorCode.LOCKFILE_LOCAL_DEPENDENCY_DISALLOWED,
          error: `Local link dependency is not permitted at '${pkgPath}'`,
        };
      }

      // Check version field if present
      if (pkg.version !== undefined) {
        if (typeof pkg.version !== 'string') {
          return {
            valid: false,
            errorCode: LockfileErrorCode.LOCKFILE_INVALID_METADATA,
            error: `Package version at '${pkgPath}' must be a string`,
          };
        }
        if (isGitSpecifier(pkg.version)) {
          return {
            valid: false,
            errorCode: LockfileErrorCode.LOCKFILE_GIT_DEPENDENCY_DISALLOWED,
            error: `Git dependency specifier in version is not permitted at '${pkgPath}'`,
          };
        }
        if (isLocalSpecifier(pkg.version)) {
          return {
            valid: false,
            errorCode: LockfileErrorCode.LOCKFILE_LOCAL_DEPENDENCY_DISALLOWED,
            error: `Local dependency specifier in version is not permitted at '${pkgPath}'`,
          };
        }
      }

      // Bundled packages without external download
      if (pkg.inBundle === true && !pkg.resolved) {
        // If bundled package has integrity, validate it
        if (pkg.integrity) {
          const integrityCheck = validateIntegrity(pkg.integrity);
          if (!integrityCheck.valid) {
            return {
              valid: false,
              errorCode: LockfileErrorCode.LOCKFILE_INVALID_INTEGRITY,
              error: `Invalid integrity metadata for bundled package '${pkgPath}': ${integrityCheck.error}`,
            };
          }
        }
        continue;
      }

      // External packages MUST have a resolved URL
      if (!pkg.resolved || typeof pkg.resolved !== 'string') {
        return {
          valid: false,
          errorCode: LockfileErrorCode.LOCKFILE_INVALID_METADATA,
          error: `Missing or invalid resolved URL for external package at '${pkgPath}'`,
        };
      }

      // Validate resolved URL
      const resolvedCheck = validateResolvedUrl(pkg.resolved, pkgPath);
      if (!resolvedCheck.valid) {
        return resolvedCheck;
      }

      // External packages MUST have integrity metadata
      if (!pkg.integrity || typeof pkg.integrity !== 'string' || pkg.integrity.trim() === '') {
        return {
          valid: false,
          errorCode: LockfileErrorCode.LOCKFILE_MISSING_INTEGRITY,
          error: `Missing required integrity hash for external package at '${pkgPath}'`,
        };
      }

      const integrityCheck = validateIntegrity(pkg.integrity);
      if (!integrityCheck.valid) {
        return {
          valid: false,
          errorCode: LockfileErrorCode.LOCKFILE_INVALID_INTEGRITY,
          error: `Invalid integrity metadata for package '${pkgPath}': ${integrityCheck.error}`,
        };
      }

      // Check sub-dependency specifiers inside this package entry
      const subDepCheck = checkDependencySpecifiers(pkg, pkgPath);
      if (!subDepCheck.valid) {
        return subDepCheck;
      }
    }

    return {
      valid: true,
      lockfileVersion: parsed.lockfileVersion,
      packageCount: totalDeclarations,
    };
  }

  /**
   * Throws LockfileValidationError if lockfile is invalid, otherwise returns validation result.
   *
   * @param {string|Buffer} content
   * @returns {{ valid: true, packageCount: number, lockfileVersion: number }}
   */
  static validateOrThrow(content) {
    const result = LockfileValidator.validate(content);
    if (!result.valid) {
      throw new LockfileValidationError(result.errorCode, result.error);
    }
    return result;
  }
}

/**
 * Validates package resolved URL according to security policy:
 * - Rejects Git and local schemes
 * - Requires HTTPS protocol
 * - Permits ONLY registry.npmjs.org
 * - Forbids embedded URL credentials and non-standard ports
 *
 * @param {string} resolved
 * @param {string} pkgPath
 * @returns {{ valid: boolean, errorCode?: string, error?: string }}
 */
function validateResolvedUrl(resolved, pkgPath) {
  if (isGitSpecifier(resolved)) {
    return {
      valid: false,
      errorCode: LockfileErrorCode.LOCKFILE_GIT_DEPENDENCY_DISALLOWED,
      error: `Git dependency is not permitted in resolved URL for package '${pkgPath}'`,
    };
  }

  if (isLocalSpecifier(resolved)) {
    return {
      valid: false,
      errorCode: LockfileErrorCode.LOCKFILE_LOCAL_DEPENDENCY_DISALLOWED,
      error: `Local dependency is not permitted in resolved URL for package '${pkgPath}'`,
    };
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(resolved);
  } catch {
    return {
      valid: false,
      errorCode: LockfileErrorCode.LOCKFILE_INVALID_METADATA,
      error: `Malformed resolved URL syntax for package '${pkgPath}'`,
    };
  }

  // Enforce HTTPS
  if (parsedUrl.protocol !== 'https:') {
    return {
      valid: false,
      errorCode: LockfileErrorCode.LOCKFILE_INSECURE_URL_SCHEME,
      error: `Resolved URL for package '${pkgPath}' must use HTTPS (found '${parsedUrl.protocol}')`,
    };
  }

  // Enforce no credentials
  if (parsedUrl.username || parsedUrl.password) {
    return {
      valid: false,
      errorCode: LockfileErrorCode.LOCKFILE_URL_CREDENTIALS_DISALLOWED,
      error: `Resolved URL for package '${pkgPath}' must not contain user credentials`,
    };
  }

  // Enforce exact approved host
  const hostname = parsedUrl.hostname.toLowerCase();
  if (hostname !== APPROVED_REGISTRY_HOST) {
    return {
      valid: false,
      errorCode: LockfileErrorCode.LOCKFILE_UNAPPROVED_HOST,
      error: `Resolved URL host '${hostname}' for package '${pkgPath}' is not permitted. Only '${APPROVED_REGISTRY_HOST}' is allowed`,
    };
  }

  // Enforce port 443 (or standard default)
  if (parsedUrl.port && parsedUrl.port !== '443') {
    return {
      valid: false,
      errorCode: LockfileErrorCode.LOCKFILE_UNAPPROVED_HOST,
      error: `Resolved URL port '${parsedUrl.port}' for package '${pkgPath}' is not permitted`,
    };
  }

  return { valid: true };
}

/**
 * Checks dependency specifier objects (dependencies, devDependencies, etc.)
 * for illicit Git or local file references.
 *
 * @param {Object} pkg
 * @param {string} pkgPath
 * @returns {{ valid: boolean, errorCode?: string, error?: string }}
 */
function checkDependencySpecifiers(pkg, pkgPath) {
  const fields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
  for (const field of fields) {
    const deps = pkg[field];
    if (deps && typeof deps === 'object' && !Array.isArray(deps)) {
      for (const [depName, depSpec] of Object.entries(deps)) {
        if (typeof depSpec === 'string') {
          if (isGitSpecifier(depSpec)) {
            return {
              valid: false,
              errorCode: LockfileErrorCode.LOCKFILE_GIT_DEPENDENCY_DISALLOWED,
              error: `Git dependency specifier '${depSpec}' for '${depName}' in '${field}' is not permitted at '${pkgPath}'`,
            };
          }
          if (isLocalSpecifier(depSpec)) {
            return {
              valid: false,
              errorCode: LockfileErrorCode.LOCKFILE_LOCAL_DEPENDENCY_DISALLOWED,
              error: `Local dependency specifier '${depSpec}' for '${depName}' in '${field}' is not permitted at '${pkgPath}'`,
            };
          }
        }
      }
    }
  }
  return { valid: true };
}

/**
 * Recursively traverses and validates lockfile v2 legacy dependencies tree.
 *
 * @param {Object} dependenciesObj
 * @param {number} depth
 * @returns {{ valid: boolean, count: number, errorCode?: string, error?: string }}
 */
function countAndValidateV2Dependencies(dependenciesObj, depth) {
  if (depth > 20) {
    return {
      valid: false,
      count: 0,
      errorCode: LockfileErrorCode.LOCKFILE_NESTING_EXCEEDED,
      error: 'Lockfile v2 dependencies tree exceeds maximum depth',
    };
  }

  let count = 0;
  for (const [depName, entry] of Object.entries(dependenciesObj)) {
    count++;
    if (count > MAX_PACKAGE_DECLARATIONS) {
      return {
        valid: false,
        count,
        errorCode: LockfileErrorCode.LOCKFILE_PACKAGE_LIMIT_EXCEEDED,
        error: `Lockfile v2 dependencies exceed maximum package limit of ${MAX_PACKAGE_DECLARATIONS}`,
      };
    }

    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return {
        valid: false,
        count,
        errorCode: LockfileErrorCode.LOCKFILE_INVALID_PACKAGE_ENTRY,
        error: `Dependency declaration for '${depName}' in v2 dependencies must be an object`,
      };
    }

    // Check version
    if (entry.version && typeof entry.version === 'string') {
      if (isGitSpecifier(entry.version)) {
        return {
          valid: false,
          count,
          errorCode: LockfileErrorCode.LOCKFILE_GIT_DEPENDENCY_DISALLOWED,
          error: `Git dependency in version for '${depName}' in v2 dependencies is not permitted`,
        };
      }
      if (isLocalSpecifier(entry.version)) {
        return {
          valid: false,
          count,
          errorCode: LockfileErrorCode.LOCKFILE_LOCAL_DEPENDENCY_DISALLOWED,
          error: `Local dependency in version for '${depName}' in v2 dependencies is not permitted`,
        };
      }
    }

    // If bundled in v2
    if (entry.bundled === true && !entry.resolved) {
      if (entry.integrity) {
        const integrityCheck = validateIntegrity(entry.integrity);
        if (!integrityCheck.valid) {
          return {
            valid: false,
            count,
            errorCode: LockfileErrorCode.LOCKFILE_INVALID_INTEGRITY,
            error: `Invalid integrity for bundled v2 dependency '${depName}': ${integrityCheck.error}`,
          };
        }
      }
    } else if (entry.resolved) {
      const resCheck = validateResolvedUrl(entry.resolved, depName);
      if (!resCheck.valid) {
        return { ...resCheck, count };
      }

      if (!entry.integrity) {
        return {
          valid: false,
          count,
          errorCode: LockfileErrorCode.LOCKFILE_MISSING_INTEGRITY,
          error: `Missing integrity for v2 dependency '${depName}'`,
        };
      }

      const integrityCheck = validateIntegrity(entry.integrity);
      if (!integrityCheck.valid) {
        return {
          valid: false,
          count,
          errorCode: LockfileErrorCode.LOCKFILE_INVALID_INTEGRITY,
          error: `Invalid integrity for v2 dependency '${depName}': ${integrityCheck.error}`,
        };
      }
    }

    // Nested dependencies in v2
    if (entry.dependencies && typeof entry.dependencies === 'object') {
      const nestedResult = countAndValidateV2Dependencies(entry.dependencies, depth + 1);
      if (!nestedResult.valid) {
        return nestedResult;
      }
      count += nestedResult.count;
    }
  }

  return { valid: true, count };
}

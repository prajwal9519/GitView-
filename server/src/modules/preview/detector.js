/**
 * GitView Phase 5 — Milestone 4: Passive Project Detection Engine
 *
 * Deterministically inspects root repository metadata and files without
 * executing untrusted code, running scripts, or starting containers.
 */

export const MAX_PACKAGE_JSON_SIZE_BYTES = 256 * 1024; // 256 KB

export const DetectionReasonCode = Object.freeze({
  EMPTY_REPOSITORY: 'EMPTY_REPOSITORY',
  MISSING_INDEX_HTML: 'MISSING_INDEX_HTML',
  PACKAGE_JSON_OVERSIZED: 'PACKAGE_JSON_OVERSIZED',
  PACKAGE_JSON_INVALID: 'PACKAGE_JSON_INVALID',
  MONOREPO_UNSUPPORTED: 'MONOREPO_UNSUPPORTED',
  BACKEND_PROJECT_UNSUPPORTED: 'BACKEND_PROJECT_UNSUPPORTED',
  CRA_UNSUPPORTED: 'CRA_UNSUPPORTED',
  NEXTJS_UNSUPPORTED: 'NEXTJS_UNSUPPORTED',
  NUXT_UNSUPPORTED: 'NUXT_UNSUPPORTED',
  ASTRO_UNSUPPORTED: 'ASTRO_UNSUPPORTED',
  REMIX_UNSUPPORTED: 'REMIX_UNSUPPORTED',
  GATSBY_UNSUPPORTED: 'GATSBY_UNSUPPORTED',
  BUNDLER_UNSUPPORTED: 'BUNDLER_UNSUPPORTED',
  REACT_WITHOUT_VITE: 'REACT_WITHOUT_VITE',
  LOCKFILE_REQUIRED: 'LOCKFILE_REQUIRED',
  LOCKFILE_UNSUPPORTED: 'LOCKFILE_UNSUPPORTED',
  UNSUPPORTED_PROJECT_STRUCTURE: 'UNSUPPORTED_PROJECT_STRUCTURE',
  MULTIPLE_PROJECT_ROOTS: 'MULTIPLE_PROJECT_ROOTS',
  INVALID_METADATA: 'INVALID_METADATA',
});

// Known backend / server-side framework signatures
const BACKEND_DEPENDENCIES = new Set([
  'express',
  'koa',
  'fastify',
  'nestjs',
  '@nestjs/core',
  '@nestjs/common',
  'hapi',
  '@hapi/hapi',
  'restify',
  'feathers',
  '@feathersjs/feathers',
  'socket.io',
  'electron',
  'react-native',
]);

// Known unsupported bundlers
const UNSUPPORTED_BUNDLERS = new Set([
  'webpack',
  'parcel',
  '@parcel/core',
]);

/**
 * Normalizes and validates a relative project root path against path traversal.
 *
 * @param {string|null} rootPath
 * @returns {string} Clean relative path, e.g. "vite-project" or "" for root
 */
export function normalizeProjectRoot(rootPath) {
  if (!rootPath || typeof rootPath !== 'string') return '';
  const trimmed = rootPath.trim().replace(/\\/g, '/');
  if (!trimmed || trimmed === '.') return '';
  if (trimmed.startsWith('/') || trimmed.includes('\0') || trimmed.includes('..') || /%2e/i.test(trimmed)) {
    throw new Error('Invalid project root path: path traversal or absolute path detected');
  }
  const clean = trimmed.replace(/^\/+|\/+$/g, '');
  if (!clean || clean === '.') return '';
  const segments = clean.split('/').filter(Boolean);
  if (segments.some((s) => s === '..' || s === '.' || /%2e/i.test(s))) {
    throw new Error('Invalid project root path: path traversal detected');
  }
  return clean;
}

/**
 * Normalizes rootFiles input to a Set of lowercase filenames.
 * Supports strings or objects with a `name` or `path` property.
 *
 * @param {Array<string|Object>} rootFiles
 * @returns {Set<string>}
 */
function extractFilenames(rootFiles) {
  if (!Array.isArray(rootFiles)) {
    return new Set();
  }
  const set = new Set();
  for (const item of rootFiles) {
    if (typeof item === 'string') {
      set.add(item.trim().toLowerCase());
    } else if (item && typeof item === 'object') {
      const name = item.name || item.path;
      if (typeof name === 'string') {
        // Strip leading directory paths if any
        const base = name.split('/').pop().trim().toLowerCase();
        set.add(base);
      }
    }
  }
  return set;
}

/**
 * Pure framework detection function.
 * Evaluates repository file tree and package.json contents deterministically.
 *
 * @param {Object} input
 * @param {Array<string|Object>} [input.rootFiles] List of files/items at the repository root
 * @param {string|Object} [input.packageJsonRaw] Raw package.json string or parsed object
 * @param {number} [input.packageJsonSize] Size of package.json in bytes
 * @returns {Object} Detection profile response
 */
export function detectFramework({
  rootFiles = [],
  packageJsonRaw = null,
  packageJsonSize = null,
  projectRoot = '',
} = {}) {
  const cleanProjectRoot = normalizeProjectRoot(projectRoot);
  // 1. Validate metadata structures
  if (!Array.isArray(rootFiles)) {
    return {
      supported: false,
      framework: 'UNSUPPORTED',
      reasonCode: DetectionReasonCode.INVALID_METADATA,
      message: 'Invalid repository metadata: rootFiles must be an array.',
    };
  }

  const filenames = extractFilenames(rootFiles);

  // 2. Empty repository check
  if (filenames.size === 0) {
    return {
      supported: false,
      framework: 'UNSUPPORTED',
      reasonCode: DetectionReasonCode.EMPTY_REPOSITORY,
      message: 'The repository is empty.',
    };
  }

  // 3. Monorepo workspace check via root-level indicator files
  if (filenames.has('pnpm-workspace.yaml') || filenames.has('lerna.json')) {
    return {
      supported: false,
      framework: 'UNSUPPORTED',
      reasonCode: DetectionReasonCode.MONOREPO_UNSUPPORTED,
      message: 'Monorepo and workspace repositories are not supported in the initial preview engine.',
    };
  }

  // 4. Root index.html check (mandatory entry point for all supported MVP profiles)
  if (!filenames.has('index.html')) {
    return {
      supported: false,
      framework: 'UNSUPPORTED',
      reasonCode: DetectionReasonCode.MISSING_INDEX_HTML,
      message: 'Root index.html is required for live application preview.',
    };
  }

  // 5. If no package.json is present, evaluate for static website profile
  const hasPackageJson = filenames.has('package.json');
  if (!hasPackageJson) {
    // If a lockfile exists without package.json, reject as inconsistent
    if (filenames.has('package-lock.json') || filenames.has('yarn.lock') || filenames.has('pnpm-lock.yaml')) {
      return {
        supported: false,
        framework: 'UNSUPPORTED',
        reasonCode: DetectionReasonCode.UNSUPPORTED_PROJECT_STRUCTURE,
        message: 'Repository contains a lockfile without a corresponding package.json.',
      };
    }

    // Supported Profile A: Static HTML/CSS/JS website
    return {
      supported: true,
      framework: 'STATIC',
      variant: 'STATIC_HTML',
      entryPoint: 'index.html',
      projectRoot: cleanProjectRoot,
    };
  }

  // 6. package.json exists: Validate size constraints (256 KB threshold)
  let rawContent = packageJsonRaw;
  let computedSize = packageJsonSize;

  if (typeof rawContent === 'string') {
    computedSize = computedSize ?? Buffer.byteLength(rawContent, 'utf8');
  }

  if (computedSize !== null && computedSize > MAX_PACKAGE_JSON_SIZE_BYTES) {
    return {
      supported: false,
      framework: 'UNSUPPORTED',
      reasonCode: DetectionReasonCode.PACKAGE_JSON_OVERSIZED,
      message: 'package.json exceeds maximum allowed size limit of 256 KB.',
    };
  }

  // If package.json is in rootFiles list but content was not provided
  if (rawContent === null || rawContent === undefined) {
    return {
      supported: false,
      framework: 'UNSUPPORTED',
      reasonCode: DetectionReasonCode.PACKAGE_JSON_INVALID,
      message: 'package.json is present but its content could not be read.',
    };
  }

  // 7. Parse and validate package.json structure
  let pkg;
  if (typeof rawContent === 'object' && rawContent !== null) {
    pkg = rawContent;
  } else if (typeof rawContent === 'string') {
    try {
      pkg = JSON.parse(rawContent);
    } catch {
      return {
        supported: false,
        framework: 'UNSUPPORTED',
        reasonCode: DetectionReasonCode.PACKAGE_JSON_INVALID,
        message: 'package.json contains invalid JSON syntax.',
      };
    }
  } else {
    return {
      supported: false,
      framework: 'UNSUPPORTED',
      reasonCode: DetectionReasonCode.PACKAGE_JSON_INVALID,
      message: 'package.json content must be a valid string or JSON object.',
    };
  }

  if (typeof pkg !== 'object' || pkg === null || Array.isArray(pkg)) {
    return {
      supported: false,
      framework: 'UNSUPPORTED',
      reasonCode: DetectionReasonCode.PACKAGE_JSON_INVALID,
      message: 'package.json root must be a valid JSON object.',
    };
  }

  // 8. Workspaces field in package.json (monorepo check)
  if (pkg.workspaces) {
    return {
      supported: false,
      framework: 'UNSUPPORTED',
      reasonCode: DetectionReasonCode.MONOREPO_UNSUPPORTED,
      message: 'Repositories using npm/yarn/pnpm workspaces are not supported in MVP.',
    };
  }

  // 9. Inspect dependencies & devDependencies safely (ignoring arbitrary scripts completely)
  const allDeps = new Set();

  function collectDeps(depsObj) {
    if (depsObj && typeof depsObj === 'object' && !Array.isArray(depsObj)) {
      for (const dep of Object.keys(depsObj)) {
        if (typeof dep === 'string') {
          allDeps.add(dep.trim().toLowerCase());
        }
      }
    }
  }

  collectDeps(pkg.dependencies);
  collectDeps(pkg.devDependencies);

  // 10. Check for backend framework signatures (Express, Nest, Fastify, etc.)
  for (const backendLib of BACKEND_DEPENDENCIES) {
    if (allDeps.has(backendLib)) {
      return {
        supported: false,
        framework: 'UNSUPPORTED',
        reasonCode: DetectionReasonCode.BACKEND_PROJECT_UNSUPPORTED,
        message: `Backend applications (${backendLib}) are not supported in the live preview engine.`,
      };
    }
  }

  // 11. Check for specific unsupported frontend & fullstack frameworks
  if (allDeps.has('next')) {
    return {
      supported: false,
      framework: 'UNSUPPORTED',
      reasonCode: DetectionReasonCode.NEXTJS_UNSUPPORTED,
      message: 'Next.js applications require a full Node.js server runtime and are not supported in MVP.',
    };
  }

  if (allDeps.has('react-scripts')) {
    return {
      supported: false,
      framework: 'UNSUPPORTED',
      reasonCode: DetectionReasonCode.CRA_UNSUPPORTED,
      message: 'Create React App (react-scripts) is not supported. Please use Vite React.',
    };
  }

  if (allDeps.has('nuxt') || allDeps.has('@nuxt/kit') || allDeps.has('@nuxt/core')) {
    return {
      supported: false,
      framework: 'UNSUPPORTED',
      reasonCode: DetectionReasonCode.NUXT_UNSUPPORTED,
      message: 'Nuxt applications are not supported in MVP.',
    };
  }

  if (allDeps.has('astro')) {
    return {
      supported: false,
      framework: 'UNSUPPORTED',
      reasonCode: DetectionReasonCode.ASTRO_UNSUPPORTED,
      message: 'Astro applications are not supported in MVP.',
    };
  }

  if (allDeps.has('@remix-run/react') || allDeps.has('@remix-run/node')) {
    return {
      supported: false,
      framework: 'UNSUPPORTED',
      reasonCode: DetectionReasonCode.REMIX_UNSUPPORTED,
      message: 'Remix applications are not supported in MVP.',
    };
  }

  if (allDeps.has('gatsby')) {
    return {
      supported: false,
      framework: 'UNSUPPORTED',
      reasonCode: DetectionReasonCode.GATSBY_UNSUPPORTED,
      message: 'Gatsby applications are not supported in MVP.',
    };
  }

  // 12. Check for unsupported bundlers (Webpack, Parcel)
  for (const bundler of UNSUPPORTED_BUNDLERS) {
    if (allDeps.has(bundler)) {
      return {
        supported: false,
        framework: 'UNSUPPORTED',
        reasonCode: DetectionReasonCode.BUNDLER_UNSUPPORTED,
        message: `${bundler} bundler is not supported. Only Vite is supported in MVP.`,
      };
    }
  }

  // 13. Vite vs Non-Vite evaluation
  const hasVite = allDeps.has('vite');

  if (!hasVite) {
    // If project has React without Vite, reject explicitly
    if (allDeps.has('react') || allDeps.has('react-dom')) {
      return {
        supported: false,
        framework: 'UNSUPPORTED',
        reasonCode: DetectionReasonCode.REACT_WITHOUT_VITE,
        message: 'React projects without Vite are not supported in MVP. Vite is required.',
      };
    }

    // If package.json has dependencies without a recognized build tool, reject
    if (allDeps.size > 0) {
      return {
        supported: false,
        framework: 'UNSUPPORTED',
        reasonCode: DetectionReasonCode.UNSUPPORTED_PROJECT_STRUCTURE,
        message: 'This project specifies dependencies but does not include a supported build tool (Vite).',
      };
    }

    // Pure static site that merely contains a metadata-only package.json (no dependencies)
    return {
      supported: true,
      framework: 'STATIC',
      variant: 'STATIC_HTML',
      entryPoint: 'index.html',
      projectRoot: cleanProjectRoot,
    };
  }

  // 14. Vite project detected: Enforce Lockfile Policy
  const hasNpmLock = filenames.has('package-lock.json');
  const hasYarnLock = filenames.has('yarn.lock');
  const hasPnpmLock = filenames.has('pnpm-lock.yaml');
  const hasBunLock = filenames.has('bun.lockb');

  if (!hasNpmLock) {
    if (hasYarnLock || hasPnpmLock || hasBunLock) {
      const pm = hasYarnLock ? 'Yarn (yarn.lock)' : hasPnpmLock ? 'pnpm (pnpm-lock.yaml)' : 'Bun (bun.lockb)';
      return {
        supported: false,
        framework: 'UNSUPPORTED',
        reasonCode: DetectionReasonCode.LOCKFILE_UNSUPPORTED,
        message: `${pm} lockfiles are not supported in MVP. A package-lock.json is required.`,
      };
    }

    return {
      supported: false,
      framework: 'UNSUPPORTED',
      reasonCode: DetectionReasonCode.LOCKFILE_REQUIRED,
      message: 'This repository does not contain a supported npm lockfile (package-lock.json).',
    };
  }

  // 15. Supported Profile B: VITE_FRONTEND (React or Vanilla)
  const isReact = allDeps.has('react') || allDeps.has('react-dom') || allDeps.has('@vitejs/plugin-react');

  return {
    supported: true,
    framework: 'VITE_FRONTEND',
    variant: isReact ? 'REACT' : 'VANILLA',
    entryPoint: 'index.html',
    packageManager: 'NPM',
    projectRoot: cleanProjectRoot,
  };
}

/**
 * Maps a detection result object to the database FrameworkType enum.
 * Reconciles the rich detector profile with the Prisma schema enum values:
 * [STATIC, VITE_REACT, VITE_VANILLA, REACT, UNKNOWN].
 *
 * @param {Object} detectionResult
 * @returns {'STATIC' | 'VITE_REACT' | 'VITE_VANILLA' | 'UNKNOWN'}
 */
export function mapDetectorResultToPrismaFramework(detectionResult) {
  if (!detectionResult || !detectionResult.supported) {
    return 'UNKNOWN';
  }
  if (detectionResult.framework === 'STATIC') {
    return 'STATIC';
  }
  if (detectionResult.framework === 'VITE_FRONTEND') {
    if (detectionResult.variant === 'REACT') {
      return 'VITE_REACT';
    }
    if (detectionResult.variant === 'VANILLA') {
      return 'VITE_VANILLA';
    }
  }
  // Genuinely unclassified or undetected sessions remain UNKNOWN
  return 'UNKNOWN';
}

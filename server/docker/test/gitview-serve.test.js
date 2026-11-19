/**
 * ==============================================================================
 * GitView Phase 5: Unit Tests for gitview-serve.js
 * ==============================================================================
 */

'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const FIXTURE_DIR = path.resolve(__dirname, '../fixtures/test-workspace');
const SERVE_SCRIPT = path.resolve(__dirname, '../scripts/gitview-serve.js');

let serverProcess;
let serverPort;

function request(method, pathUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: serverPort,
      path: pathUrl,
      method: method,
      ...options
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data
        });
      });
    });

    req.on('error', reject);
    req.end();
  });
}

describe('gitview-serve.js Security & Functionality Tests', () => {
  before(async () => {
    // 1. Create synthetic test fixture directory structure
    if (fs.existsSync(FIXTURE_DIR)) {
      fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
    fs.mkdirSync(path.join(FIXTURE_DIR, 'assets'), { recursive: true });
    fs.mkdirSync(path.join(FIXTURE_DIR, 'empty-dir'), { recursive: true });
    fs.mkdirSync(path.join(FIXTURE_DIR, 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(FIXTURE_DIR, '.git'), { recursive: true });

    // Files
    fs.writeFileSync(path.join(FIXTURE_DIR, 'index.html'), '<!DOCTYPE html><html><body>Root Index</body></html>');
    fs.writeFileSync(path.join(FIXTURE_DIR, 'assets', 'app.js'), 'console.log("App loaded");');
    fs.writeFileSync(path.join(FIXTURE_DIR, 'assets', 'style.css'), 'body { background: #000; }');
    fs.writeFileSync(path.join(FIXTURE_DIR, 'assets', 'data.json'), '{"gitview":true}');
    fs.writeFileSync(path.join(FIXTURE_DIR, '.env'), 'SECRET_API_KEY=leak_me_if_you_can');
    fs.writeFileSync(path.join(FIXTURE_DIR, '.env.local'), 'LOCAL_SECRET=foo');
    fs.writeFileSync(path.join(FIXTURE_DIR, '.npmrc'), '//registry.npmjs.org/:_authToken=secret');
    fs.writeFileSync(path.join(FIXTURE_DIR, '.git', 'config'), '[core]\nrepositoryformatversion = 0');
    fs.writeFileSync(path.join(FIXTURE_DIR, 'node_modules', 'evil.js'), 'console.log("evil");');

    // Create a symlink to an internal file
    try {
      fs.symlinkSync(path.join(FIXTURE_DIR, 'index.html'), path.join(FIXTURE_DIR, 'symlink-index.html'));
    } catch (e) {}

    // Find an ephemeral port
    const tmpServer = http.createServer();
    await new Promise(res => tmpServer.listen(0, '127.0.0.1', res));
    serverPort = tmpServer.address().port;
    await new Promise(res => tmpServer.close(res));

    // Launch server process
    serverProcess = spawn(process.execPath, [
      SERVE_SCRIPT,
      '--root', FIXTURE_DIR,
      '--port', String(serverPort),
      '--host', '127.0.0.1'
    ], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    serverProcess.stderr.on('data', d => console.error('[SERVER_ERR]', d.toString()));

    // Wait for server to start
    await new Promise((resolve, reject) => {
      let attempts = 0;
      const check = () => {
        attempts++;
        const s = http.get(`http://127.0.0.1:${serverPort}/index.html`, (res) => {
          res.resume();
          resolve();
        });
        s.on('error', () => {
          if (attempts > 30) return reject(new Error('Server failed to start'));
          setTimeout(check, 100);
        });
      };
      check();
    });
  });

  after(() => {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
    }
    if (fs.existsSync(FIXTURE_DIR)) {
      fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
    }
  });

  test('1. Serves root / as index.html with correct MIME type', async () => {
    const res = await request('GET', '/');
    assert.strictEqual(res.statusCode, 200);
    assert.match(res.headers['content-type'], /^text\/html/);
    assert.strictEqual(res.body, '<!DOCTYPE html><html><body>Root Index</body></html>');
  });

  test('2. Serves static JS with application/javascript MIME type', async () => {
    const res = await request('GET', '/assets/app.js');
    assert.strictEqual(res.statusCode, 200);
    assert.match(res.headers['content-type'], /^application\/javascript/);
    assert.strictEqual(res.body, 'console.log("App loaded");');
  });

  test('3. Serves static CSS with text/css MIME type', async () => {
    const res = await request('GET', '/assets/style.css');
    assert.strictEqual(res.statusCode, 200);
    assert.match(res.headers['content-type'], /^text\/css/);
    assert.strictEqual(res.body, 'body { background: #000; }');
  });

  test('4. Serves JSON with application/json MIME type', async () => {
    const res = await request('GET', '/assets/data.json');
    assert.strictEqual(res.statusCode, 200);
    assert.match(res.headers['content-type'], /^application\/json/);
    assert.strictEqual(res.body, '{"gitview":true}');
  });

  test('5. Blocks path traversal via dot-dot (..)', async () => {
    const res = await request('GET', '/../../etc/passwd');
    assert.strictEqual(res.statusCode, 403);
    assert.match(res.body, /Forbidden/);
  });

  test('6. Blocks path traversal via URL-encoded dots (%2e%2e)', async () => {
    const res = await request('GET', '/%2e%2e/%2e%2e/etc/passwd');
    assert.strictEqual(res.statusCode, 403);
    assert.match(res.body, /Forbidden/);
  });

  test('7. Blocks access to .env and .env.local', async () => {
    const res1 = await request('GET', '/.env');
    assert.strictEqual(res1.statusCode, 403);
    assert.match(res1.body, /Forbidden/);

    const res2 = await request('GET', '/.env.local');
    assert.strictEqual(res2.statusCode, 403);
    assert.match(res2.body, /Forbidden/);
  });

  test('8. Blocks access to .git repository metadata', async () => {
    const res = await request('GET', '/.git/config');
    assert.strictEqual(res.statusCode, 403);
    assert.match(res.body, /Forbidden/);
  });

  test('9. Blocks access to node_modules', async () => {
    const res = await request('GET', '/node_modules/evil.js');
    assert.strictEqual(res.statusCode, 403);
    assert.match(res.body, /Forbidden/);
  });

  test('10. Blocks access to .npmrc credentials', async () => {
    const res = await request('GET', '/.npmrc');
    assert.strictEqual(res.statusCode, 403);
    assert.match(res.body, /Forbidden/);
  });

  test('11. Strictly rejects symbolic links', async () => {
    const res = await request('GET', '/symlink-index.html');
    assert.strictEqual(res.statusCode, 403);
    assert.match(res.body, /Symbolic Links Prohibited/);
  });

  test('12. Disables directory listings (returns 404 for empty folder)', async () => {
    const res = await request('GET', '/empty-dir');
    assert.strictEqual(res.statusCode, 404);
    assert.match(res.body, /Directory Listing Disabled/);
  });

  test('13. Supports SPA fallback for extensionless client-side routes', async () => {
    const res = await request('GET', '/dashboard/analytics');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers['x-gitview-fallback'], 'SPA');
    assert.match(res.headers['content-type'], /^text\/html/);
    assert.strictEqual(res.body, '<!DOCTYPE html><html><body>Root Index</body></html>');
  });

  test('14. Does not trigger SPA fallback for missing static assets with extensions', async () => {
    const res = await request('GET', '/missing-file.png');
    assert.strictEqual(res.statusCode, 404);
  });

  test('15. Rejects non-GET/HEAD methods with 405 Method Not Allowed', async () => {
    const resPost = await request('POST', '/');
    assert.strictEqual(resPost.statusCode, 405);

    const resPut = await request('PUT', '/');
    assert.strictEqual(resPut.statusCode, 405);

    const resDelete = await request('DELETE', '/');
    assert.strictEqual(resDelete.statusCode, 405);
  });

  test('16. Supports HEAD requests (returns headers without body)', async () => {
    const res = await request('HEAD', '/');
    assert.strictEqual(res.statusCode, 200);
    assert.match(res.headers['content-type'], /^text\/html/);
    assert.strictEqual(res.body, '');
  });
});

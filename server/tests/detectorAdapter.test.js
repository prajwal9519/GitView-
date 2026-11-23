import { describe, it, expect, vi } from 'vitest';
import * as githubClient from '../src/integrations/githubClient.js';
import { detectRepositoryFramework } from '../src/modules/preview/detectorAdapter.js';
import { MAX_PACKAGE_JSON_SIZE_BYTES } from '../src/modules/preview/detector.js';

describe('GitHub Detection Adapter (detectorAdapter.js)', () => {
  it('detects static site from GitHub root directory contents without extra fetches', async () => {
    const fetchSpy = vi.spyOn(githubClient, 'fetchContents').mockResolvedValueOnce([
      { name: 'index.html', path: 'index.html', type: 'file', size: 500 },
      { name: 'style.css', path: 'style.css', type: 'file', size: 1200 },
      { name: 'app.js', path: 'app.js', type: 'file', size: 3000 },
    ]);

    const res = await detectRepositoryFramework('fake_token', 'user', 'static-repo');

    expect(res.supported).toBe(true);
    expect(res.framework).toBe('STATIC');
    expect(res.variant).toBe('STATIC_HTML');
    expect(fetchSpy).toHaveBeenCalledTimes(1); // Only root listing fetched!

    fetchSpy.mockRestore();
  });

  it('detects Vite React project by fetching only root listing and package.json', async () => {
    const pkg = {
      name: 'vite-react-app',
      dependencies: { react: '^18.3.1' },
      devDependencies: { vite: '^5.4.14' },
    };
    const b64 = Buffer.from(JSON.stringify(pkg), 'utf8').toString('base64');

    const fetchSpy = vi.spyOn(githubClient, 'fetchContents')
      // 1st call: root directory contents
      .mockResolvedValueOnce([
        { name: 'index.html', path: 'index.html', type: 'file', size: 400 },
        { name: 'package.json', path: 'package.json', type: 'file', size: 350 },
        { name: 'package-lock.json', path: 'package-lock.json', type: 'file', size: 50000 },
      ])
      // 2nd call: package.json file content
      .mockResolvedValueOnce({
        name: 'package.json',
        path: 'package.json',
        size: 350,
        encoding: 'base64',
        content: b64,
      });

    const res = await detectRepositoryFramework('fake_token', 'user', 'vite-repo');

    expect(res.supported).toBe(true);
    expect(res.framework).toBe('VITE_FRONTEND');
    expect(res.variant).toBe('REACT');
    expect(fetchSpy).toHaveBeenCalledTimes(2); // Only root listing + package.json!

    fetchSpy.mockRestore();
  });

  it('avoids fetching package.json content when size in root listing exceeds 256 KB', async () => {
    const oversizedSize = MAX_PACKAGE_JSON_SIZE_BYTES + 2048;

    const fetchSpy = vi.spyOn(githubClient, 'fetchContents').mockResolvedValueOnce([
      { name: 'index.html', path: 'index.html', type: 'file', size: 400 },
      { name: 'package.json', path: 'package.json', type: 'file', size: oversizedSize },
      { name: 'package-lock.json', path: 'package-lock.json', type: 'file', size: 50000 },
    ]);

    const res = await detectRepositoryFramework('fake_token', 'user', 'oversized-repo');

    expect(res.supported).toBe(false);
    expect(res.reasonCode).toBe('PACKAGE_JSON_OVERSIZED');
    expect(fetchSpy).toHaveBeenCalledTimes(1); // Content was NOT fetched because size was known!

    fetchSpy.mockRestore();
  });

  it('handles empty repository 404 cleanly', async () => {
    const notFoundError = new Error('Not found');
    notFoundError.statusCode = 404;

    const fetchSpy = vi.spyOn(githubClient, 'fetchContents').mockRejectedValueOnce(notFoundError);

    const res = await detectRepositoryFramework('fake_token', 'user', 'empty-repo');

    expect(res.supported).toBe(false);
    expect(res.reasonCode).toBe('EMPTY_REPOSITORY');

    fetchSpy.mockRestore();
  });

  it('detects nested Vite React application in candidate directory (e.g. vite-project)', async () => {
    const pkg = {
      name: 'nested-vite-react',
      dependencies: { react: '^19.2.5', 'react-dom': '^19.2.5' },
      devDependencies: { vite: '^8.0.10', '@vitejs/plugin-react': '^6.0.1' },
    };
    const b64 = Buffer.from(JSON.stringify(pkg), 'utf8').toString('base64');

    const fetchSpy = vi.spyOn(githubClient, 'fetchContents')
      // 1st call: root directory contents (contains README and vite-project dir)
      .mockResolvedValueOnce([
        { name: 'README.md', path: 'README.md', type: 'file', size: 1200 },
        { name: 'vite-project', path: 'vite-project', type: 'dir' },
      ])
      // 2nd call: nested directory contents (vite-project)
      .mockResolvedValueOnce([
        { name: 'index.html', path: 'vite-project/index.html', type: 'file', size: 400 },
        { name: 'package.json', path: 'vite-project/package.json', type: 'file', size: 450 },
        { name: 'package-lock.json', path: 'vite-project/package-lock.json', type: 'file', size: 50000 },
        { name: 'src', path: 'vite-project/src', type: 'dir' },
      ])
      // 3rd call: nested package.json content
      .mockResolvedValueOnce({
        name: 'package.json',
        path: 'vite-project/package.json',
        size: 450,
        encoding: 'base64',
        content: b64,
      });

    const res = await detectRepositoryFramework('fake_token', 'user', 'SkyNav');

    expect(res.supported).toBe(true);
    expect(res.framework).toBe('VITE_FRONTEND');
    expect(res.variant).toBe('REACT');
    expect(res.projectRoot).toBe('vite-project');
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    fetchSpy.mockRestore();
  });

  it('resolves standard priority when multiple candidate nested roots exist', async () => {
    const pkg = {
      name: 'client-app',
      dependencies: { react: '^18.0.0' },
      devDependencies: { vite: '^5.0.0' },
    };
    const b64 = Buffer.from(JSON.stringify(pkg), 'utf8').toString('base64');

    const fetchSpy = vi.spyOn(githubClient, 'fetchContents')
      // Root items
      .mockResolvedValueOnce([
        { name: 'client', path: 'client', type: 'dir' },
        { name: 'other', path: 'other', type: 'dir' },
      ])
      // Candidate 1: client
      .mockResolvedValueOnce([
        { name: 'index.html', path: 'client/index.html', type: 'file', size: 300 },
        { name: 'package.json', path: 'client/package.json', type: 'file', size: 300 },
        { name: 'package-lock.json', path: 'client/package-lock.json', type: 'file', size: 20000 },
      ])
      // Candidate 1 package.json
      .mockResolvedValueOnce({
        name: 'package.json',
        content: b64,
        encoding: 'base64',
      })
      // Candidate 2: other
      .mockResolvedValueOnce([
        { name: 'index.html', path: 'other/index.html', type: 'file', size: 300 },
        { name: 'package.json', path: 'other/package.json', type: 'file', size: 300 },
        { name: 'package-lock.json', path: 'other/package-lock.json', type: 'file', size: 20000 },
      ])
      // Candidate 2 package.json
      .mockResolvedValueOnce({
        name: 'package.json',
        content: b64,
        encoding: 'base64',
      });

    const res = await detectRepositoryFramework('fake_token', 'user', 'multi-app');

    expect(res.supported).toBe(true);
    expect(res.projectRoot).toBe('client'); // prioritized over 'other'

    fetchSpy.mockRestore();
  });
});

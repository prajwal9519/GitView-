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
});

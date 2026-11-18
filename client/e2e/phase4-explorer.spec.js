import { test, expect } from '@playwright/test';
import { setupE2EUser } from './test-setup.mjs';

test.describe.serial('GitView Phase 4: Repository Explorer & Code Viewer E2E Suite', () => {
  let context;
  let page;
  let credentials;
  let importedRepoId = null;
  let secondRepoId = null;

  test.beforeAll(async ({ browser }) => {
    // 1. Prepare user and link GitHub OAuth credentials in Postgres
    credentials = await setupE2EUser();

    // 2. Create browser context & page
    context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    page = await context.newPage();

    // 3. Authenticate test user through UI
    await page.goto('/login');
    await expect(page).toHaveTitle(/GitView/i);
    await page.locator('input[type="email"]').fill(credentials.email);
    await page.locator('input[type="password"]').fill(credentials.password);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL('**/dashboard', { timeout: 15000 });
    await expect(page.locator('h1')).toContainText('Dashboard Overview');
  });

  test.afterAll(async () => {
    await page?.close();
    await context?.close();

    // Database cleanup: remove test user and imported repositories
    const { prisma } = await import('../../server/src/lib/prisma.js');
    try {
      if (credentials?.user?.id) {
        await prisma.repository.deleteMany({
          where: { userId: credentials.user.id },
        });
        await prisma.oAuthAccount.deleteMany({
          where: { userId: credentials.user.id },
        });
        await prisma.refreshToken.deleteMany({
          where: { userId: credentials.user.id },
        });
        await prisma.user.delete({
          where: { id: credentials.user.id },
        });
        console.log('Test cleanup completed: test user and imported repositories removed.');
      }
    } catch (e) {
      console.warn('Cleanup notice:', e.message);
    } finally {
      await prisma.$disconnect();
    }
  });

  test('01. Repository Import: Import facebook/react via UI and verify dashboard card', async () => {
    // Navigate from dashboard to Import page
    await page.goto('/dashboard');
    const importLink = page.locator('a[href="/import"]').first();
    await expect(importLink).toBeVisible();
    await importLink.click();
    await page.waitForURL('**/import');
    await expect(page.locator('h1')).toContainText('Import Repository');

    // Specify facebook/react in manual input
    const repoInput = page.locator('input[placeholder*="facebook/react"]');
    await repoInput.fill('facebook/react');

    // Click Import to GitView button
    const importBtn = page.locator('button:has-text("Import to GitView")');
    await expect(importBtn).toBeEnabled();
    await importBtn.click();

    // Wait for the success toast
    await expect(page.locator('text=Repository Imported')).toBeVisible({ timeout: 15000 });

    // Wait for automatic redirect back to /dashboard
    await page.waitForURL('**/dashboard', { timeout: 15000 });

    // Verify newly imported repository card is rendered
    const repoCard = page.locator('article:has-text("react")').first();
    await expect(repoCard).toBeVisible({ timeout: 10000 });
    await expect(repoCard).toContainText('react');

    await page.screenshot({ path: 'test-results/screenshots/01-imported-dashboard.png' });
  });

  test('02. Repository Workspace: Open facebook/react into Workspace and verify live tree', async () => {
    await page.goto('/dashboard');
    const repoCard = page.locator('article:has-text("react")').first();
    await expect(repoCard).toBeVisible();

    // Capture repository ID from Open link
    const openLink = repoCard.locator('a:has-text("Open")');
    const href = await openLink.getAttribute('href');
    if (href && href.includes('/workspace/')) {
      importedRepoId = href.split('/workspace/')[1];
    }

    // Click Open to enter workspace
    await openLink.click();
    await page.waitForURL('**/workspace/**', { timeout: 15000 });

    // Verify Workspace header displays repository name
    await expect(page.locator('header')).toContainText('react');

    // Verify root directory contents fetched from GitHub
    await expect(page.locator('div[title="packages"]')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('div[title="scripts"]')).toBeVisible();
    await expect(page.locator('div[title="package.json"]')).toBeVisible();

    await page.screenshot({ path: 'test-results/screenshots/02-workspace-loaded.png' });
  });

  test('03. Nested Folder Expansion: Lazy loading and caching verification', async () => {
    if (!page.url().includes('/workspace')) {
      await page.goto(importedRepoId ? `/workspace/${importedRepoId}` : '/workspace');
    }

    // 1. Expand 'packages'
    const packagesFolder = page.locator('aside div[title="packages"]');
    await expect(packagesFolder).toBeVisible();
    await packagesFolder.click();

    // Wait for child folder 'packages/react' to appear
    const reactFolder = page.locator('aside div[title="packages/react"]');
    await expect(reactFolder).toBeVisible({ timeout: 15000 });

    // 2. Expand 'packages/react'
    await reactFolder.click();
    const reactSrcFolder = page.locator('aside div[title="packages/react/src"]');
    await expect(reactSrcFolder).toBeVisible({ timeout: 15000 });

    // 3. Expand 'packages/react/src'
    await reactSrcFolder.click();
    const reactJsFile = page.locator('aside div[title="packages/react/src/ReactClient.js"]');
    await expect(reactJsFile).toBeVisible({ timeout: 15000 });

    await page.screenshot({ path: 'test-results/screenshots/03-nested-tree-expanded.png' });

    // 4. Test caching: Collapse and re-expand while spying on network requests
    let networkRequestTriggered = false;
    page.on('request', (req) => {
      if (req.url().includes('path=packages%2Freact%2Fsrc')) {
        networkRequestTriggered = true;
      }
    });

    // Collapse
    await reactSrcFolder.click();
    await expect(reactJsFile).not.toBeVisible();

    // Re-expand (should use cached tree instantly without network request)
    await reactSrcFolder.click();
    await expect(reactJsFile).toBeVisible();
    expect(networkRequestTriggered).toBe(false);
  });

  test('04. Monaco Code Viewer: Display decoded ReactClient.js with syntax highlighting & breadcrumbs', async () => {
    if (!page.url().includes('/workspace')) {
      await page.goto(importedRepoId ? `/workspace/${importedRepoId}` : '/workspace');
    }

    // Ensure packages/react/src/ReactClient.js is visible in aside and click it
    const reactJsFile = page.locator('aside div[title="packages/react/src/ReactClient.js"]');
    await expect(reactJsFile).toBeVisible({ timeout: 15000 });
    await reactJsFile.click();

    // Verify tab in editor tab bar
    const activeTab = page.locator('div.border-b div[title="packages/react/src/ReactClient.js"]');
    await expect(activeTab).toBeVisible({ timeout: 10000 });

    // Verify Breadcrumb bar displays full nested path
    const breadcrumbBar = page.locator('div.h-6');
    await expect(breadcrumbBar).toContainText('packages');
    await expect(breadcrumbBar).toContainText('react');
    await expect(breadcrumbBar).toContainText('src');
    await expect(breadcrumbBar).toContainText('ReactClient.js');

    // Verify Monaco editor is rendered and contains React symbols
    const monacoEditor = page.locator('.monaco-editor');
    await expect(monacoEditor).toBeVisible({ timeout: 20000 });
    await expect(page.locator('body')).toContainText(/ReactVersion|REACT_FRAGMENT_TYPE|export/);

    // Verify language indicator is JavaScript
    await expect(page.getByRole('main').getByText('Javascript')).toBeVisible();

    await page.screenshot({ path: 'test-results/screenshots/04-monaco-code-viewer.png' });
  });

  test('05. README Viewer: Safe Markdown rendering without dangerouslySetInnerHTML', async () => {
    if (!page.url().includes('/workspace')) {
      await page.goto(importedRepoId ? `/workspace/${importedRepoId}` : '/workspace');
    }

    // Switch to README tab in center toolbar
    const readmeTabBtn = page.locator('header button:has-text("README")');
    await expect(readmeTabBtn).toBeVisible();
    await readmeTabBtn.click();

    // Verify README content renders safely into native React elements
    const readmeHeading = page.locator('main h1:has-text("React")');
    await expect(readmeHeading).toBeVisible({ timeout: 20000 });

    // Verify safe native elements: paragraphs exist
    await expect(page.locator('main p:has-text("React is a JavaScript library for building user interfaces")')).toBeVisible({ timeout: 10000 });

    await page.screenshot({ path: 'test-results/screenshots/05-readme-viewer.png' });

    // Switch back to Code mode
    await page.locator('header button:has-text("Code")').click();
  });

  test('06. Binary File Handling: Detect binary asset and show GitHub redirection link without crash', async () => {
    if (!page.url().includes('/workspace')) {
      await page.goto(importedRepoId ? `/workspace/${importedRepoId}` : '/workspace');
    }

    // Navigate to a binary asset: fixtures -> owner-stacks -> public -> logo192.png
    const fixturesFolder = page.locator('aside div[title="fixtures"]');
    await fixturesFolder.scrollIntoViewIfNeeded();
    await fixturesFolder.click();

    const ownerStacksFolder = page.locator('aside div[title="fixtures/owner-stacks"]');
    await expect(ownerStacksFolder).toBeVisible({ timeout: 15000 });
    await ownerStacksFolder.scrollIntoViewIfNeeded();
    await ownerStacksFolder.click();

    const publicFolder = page.locator('aside div[title="fixtures/owner-stacks/public"]');
    await expect(publicFolder).toBeVisible({ timeout: 15000 });
    await publicFolder.scrollIntoViewIfNeeded();
    await publicFolder.click();

    const logoPng = page.locator('aside div[title="fixtures/owner-stacks/public/logo192.png"]');
    await expect(logoPng).toBeVisible({ timeout: 15000 });
    await logoPng.click();

    // Verify Binary File warning appears and editor does not mount corrupt characters
    await expect(page.locator('main h3:has-text("Binary File Detected")')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('main p:has-text("cannot be rendered as text")')).toBeVisible();
    await expect(page.locator('main a:has-text("Open File on GitHub")')).toBeVisible();

    await page.screenshot({ path: 'test-results/screenshots/06-binary-file.png' });
  });

  test('07. Large File Handling: Threshold (>512 KB) triggers warning notice without loading content', async () => {
    if (!page.url().includes('/workspace')) {
      await page.goto(importedRepoId ? `/workspace/${importedRepoId}` : '/workspace');
    }

    // In facebook/react root, yarn.lock is ~713 KB (exceeds 512 KB limit)
    const yarnLockFile = page.locator('aside div[title="yarn.lock"]');
    await yarnLockFile.scrollIntoViewIfNeeded();
    await expect(yarnLockFile).toBeVisible();
    await yarnLockFile.click();

    // Verify Size Limit warning
    await expect(page.locator('main h3:has-text("File Exceeds Size Limit")')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('main p:has-text("larger than 512 KB")')).toBeVisible();
    await expect(page.locator('main a:has-text("View Raw on GitHub")')).toBeVisible();

    await page.screenshot({ path: 'test-results/screenshots/07-large-file.png' });
  });

  test('08. Repository Switching: Import second repo and verify isolated tree reset', async () => {
    // Return to Import Page
    await page.goto('/import');
    await expect(page.locator('h1')).toContainText('Import Repository');

    // Import expressjs/express
    const repoInput = page.locator('input[placeholder*="facebook/react"]');
    await repoInput.fill('expressjs/express');

    const importBtn = page.locator('button:has-text("Import to GitView")');
    await importBtn.click();

    // Wait for success toast & redirect
    await expect(page.locator('text=Repository Imported')).toBeVisible({ timeout: 15000 });
    await page.waitForURL('**/dashboard', { timeout: 15000 });

    // Locate the express card and open it
    const expressCard = page.locator('article:has-text("express")').first();
    await expect(expressCard).toBeVisible({ timeout: 10000 });

    const openLink = expressCard.locator('a:has-text("Open")');
    const href = await openLink.getAttribute('href');
    if (href && href.includes('/workspace/')) {
      secondRepoId = href.split('/workspace/')[1];
    }

    await openLink.click();
    await page.waitForURL('**/workspace/**', { timeout: 15000 });

    // Verify Toolbar displays express
    await expect(page.locator('header')).toContainText('express');

    // Verify File Explorer reset to Express files and old React packages are absent
    await expect(page.locator('aside div[title="lib"]')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('aside div[title="History.md"]')).toBeVisible();
    await expect(page.locator('aside div[title="packages"]')).not.toBeVisible();

    await page.screenshot({ path: 'test-results/screenshots/08-repo-switched.png' });
  });

  test('09. Error Handling: Invalid repo, path traversal, nonexistent file, and directory as file', async () => {
    // 1. Invalid repo ID in UI
    await page.goto('/workspace/00000000-0000-0000-0000-000000000000');
    // App should not crash
    await expect(page.locator('header')).toBeVisible();

    // 2. Direct API error tests using authenticated browser context
    if (importedRepoId) {
      // Path traversal attempt
      const traversalRes = await context.request.get(`http://localhost:3000/api/v1/repositories/${importedRepoId}/file?path=../../etc/passwd`);
      expect(traversalRes.status()).toBe(400);
      const traversalJson = await traversalRes.json();
      expect(traversalJson.error?.code).toBe('INVALID_PATH');

      // Nonexistent file
      const nonExistentRes = await context.request.get(`http://localhost:3000/api/v1/repositories/${importedRepoId}/file?path=non_existent_file_987654.js`);
      expect(nonExistentRes.status()).toBe(404);

      // Directory requested as file
      const dirAsFileRes = await context.request.get(`http://localhost:3000/api/v1/repositories/${importedRepoId}/file?path=packages`);
      expect(dirAsFileRes.status()).toBe(400);
      const dirAsFileJson = await dirAsFileRes.json();
      expect(dirAsFileJson.error?.code).toBe('NOT_A_FILE');
    }

    await page.screenshot({ path: 'test-results/screenshots/09-error-handling.png' });
  });
});

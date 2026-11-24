import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { signAccessToken } from '../../server/src/utils/tokens.js';
import { prisma } from '../../server/src/lib/prisma.js';

test.describe.serial('SkyNav Nested Project Root Live Acceptance Test', () => {
  let context;
  let page;
  let repoId;
  const userId = '36aeb54a-7e81-4d07-ace1-330ce5c12794';

  test.beforeAll(async ({ browser }) => {
    // 1. Clean up any stale sessions or containers for this user
    try {
      execSync('docker rm -f $(docker ps -aq --filter label=com.gitview.managed=true) 2>/dev/null || true');
      execSync('docker network prune -f 2>/dev/null || true');
    } catch {}

    await prisma.previewSession.updateMany({
      where: { userId, isActive: true },
      data: { isActive: false, status: 'STOPPED' },
    });

    const skynavRepo = await prisma.repository.findFirst({
      where: { userId, fullName: { contains: 'SkyNav', mode: 'insensitive' } },
    });
    repoId = skynavRepo?.id || '7c544487-cb84-4a92-8d72-06486e2c709b';

    const token = signAccessToken({ id: userId, role: 'USER' });

    context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });

    await context.addCookies([
      {
        name: 'access_token',
        value: token,
        domain: 'localhost',
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);

    page = await context.newPage();
    page.on('console', (msg) => console.log('[BROWSER_CONSOLE]', msg.text()));
  });

  test.afterAll(async () => {
    try {
      execSync('docker rm -f $(docker ps -aq --filter label=com.gitview.managed=true) 2>/dev/null || true');
      execSync('docker network prune -f 2>/dev/null || true');
    } catch {}

    await page?.close();
    await context?.close();
  });

  test('Step 1: Workspace loads with file explorer showing vite-project directory', async () => {
    await page.goto(`/workspace/${repoId}`, { waitUntil: 'networkidle' });

    // Expect repository title
    await expect(page.locator('text=SkyNav').first()).toBeVisible({ timeout: 15000 });

    // File tree should include vite-project
    const viteProjectFolder = page.locator('text=vite-project').first();
    await expect(viteProjectFolder).toBeVisible({ timeout: 10000 });
  });

  test('Step 2: Dependencies viewer correctly identifies nested vite-project/package.json', async () => {
    // Click on Dependencies tab
    const depsTab = page.locator('button:has-text("Dependencies")');
    await depsTab.click();

    // Verify manifest path badge
    const manifestPath = page.locator('[data-testid="manifest-path"]');
    await expect(manifestPath).toBeVisible({ timeout: 10000 });
    await expect(manifestPath).toContainText('vite-project/package.json');

    // Verify React 19 dependencies
    await expect(page.locator('text=react').first()).toBeVisible();
    await expect(page.locator('text=^19.2.5').first()).toBeVisible();
    await expect(page.locator('text=tailwindcss').first()).toBeVisible();

    // Take screenshot
    await page.screenshot({ path: '../docs/skynav-screenshots/01-dependencies-tab.png' });
  });

  test('Step 3: Live Preview drawer detects Vite React and runs SkyNav container', async () => {
    // Ensure Live Preview drawer is open
    const previewPanel = page.locator('[data-testid="live-preview-panel"]');
    if (!(await previewPanel.isVisible())) {
      const toggleBtn = page.locator('button[title*="Preview"]').first();
      await toggleBtn.click();
    }
    await expect(previewPanel).toBeVisible({ timeout: 5000 });

    // Verify framework badge and detected chip
    const badge = page.locator('[data-testid="framework-badge"]');
    await expect(badge).toBeVisible({ timeout: 10000 });
    await expect(badge).toContainText(/React/i);

    const chip = page.locator('[data-testid="detected-framework-chip"]');
    await expect(chip).toBeVisible();
    await expect(chip).toContainText('Vite React + JSX');
    await expect(page.locator('text=vite-project').first()).toBeVisible();

    // Screenshot initial preview drawer
    await page.screenshot({ path: '../docs/skynav-screenshots/02-preview-drawer-initial.png' });

    // Click Run Preview button
    const runBtn = page.locator('[data-testid="preview-run-btn"]');
    await expect(runBtn).toBeVisible();
    await runBtn.click();

    // Wait for RUNNING state (allocating volume, npm builder, vite runner, sidecar)
    const runningState = page.locator('[data-testid="preview-running-state"]');
    await expect(runningState).toBeVisible({ timeout: 45000 });

    // Verify preview iframe attached
    const iframe = page.locator('[data-testid="preview-iframe"]');
    await expect(iframe).toBeVisible({ timeout: 10000 });

    const src = await iframe.getAttribute('src');
    expect(src).toContain('.preview.localhost:3000/__gitview_bootstrap?ticket=');

    // Give iframe 3 seconds to bootstrap and render React
    await page.waitForTimeout(3000);

    // Screenshot live running preview
    await page.screenshot({ path: '../docs/skynav-screenshots/03-preview-running.png' });
  });

  test('Step 4: Open in New Tab validates top-level preview ticket redemption', async () => {
    const pagePromise = context.waitForEvent('page');
    const newTabBtn = page.locator('[data-testid="preview-newtab-btn"]');
    await expect(newTabBtn).toBeVisible();
    await newTabBtn.click();

    const newPage = await pagePromise;
    await newPage.waitForLoadState('domcontentloaded');
    expect(newPage.url()).toContain('.preview.localhost:3000');
    await newPage.waitForTimeout(2000);
    await newPage.screenshot({ path: '../docs/skynav-screenshots/04-preview-new-tab.png' });
    await newPage.close();
  });

  test('Step 5: Stop preview terminates container and updates UI state', async () => {
    const stopBtn = page.locator('[data-testid="preview-stop-btn"]');
    await expect(stopBtn).toBeVisible();
    await stopBtn.click();

    // Wait for stopped state
    const stoppedState = page.locator('[data-testid="preview-stopped-state"]');
    await expect(stoppedState).toBeVisible({ timeout: 15000 });

    // Verify restart button is ready
    await expect(page.locator('[data-testid="preview-restart-btn"]')).toBeVisible();

    // Screenshot stopped state
    await page.screenshot({ path: '../docs/skynav-screenshots/05-preview-stopped.png' });
  });
});

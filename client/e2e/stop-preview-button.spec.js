import { test, expect } from '@playwright/test';
import { setupE2EUser } from './test-setup.mjs';
import { prisma } from '../../server/src/lib/prisma.js';
import { execSync } from 'node:child_process';
import path from 'node:path';

test.describe.serial('GitView Always-Visible Stop Preview Button Acceptance Suite', () => {
  let context;
  let page;
  let credentials;
  let repoA;
  let repoB;
  let activeSessionId = null;

  test.beforeAll(async ({ browser }) => {
    // 0. Clean any lingering Docker containers or networks from previous runs
    try {
      execSync('docker rm -f $(docker ps -aq --filter label=com.gitview.managed=true) 2>/dev/null || true');
      execSync('docker network prune -f 2>/dev/null || true');
    } catch {}

    // 1. Prepare E2E user in PostgreSQL
    credentials = await setupE2EUser();

    // Clean any prior repositories or preview sessions for this user
    await prisma.previewSession.deleteMany({
      where: { userId: credentials.user.id },
    });
    await prisma.repository.deleteMany({
      where: { userId: credentials.user.id },
    });

    // 2. Insert synthetic fixture repositories for user
    repoA = await prisma.repository.create({
      data: {
        userId: credentials.user.id,
        githubRepoId: '980001',
        owner: 'gitview-fixtures',
        name: 'static-site',
        fullName: 'gitview-fixtures/static-site',
        htmlUrl: 'https://github.com/gitview-fixtures/static-site',
        defaultBranch: 'main',
        latestCommitSha: '0123456789abcdef0123456789abcdef01234567',
        primaryLanguage: 'HTML',
      },
    });

    repoB = await prisma.repository.create({
      data: {
        userId: credentials.user.id,
        githubRepoId: '980002',
        owner: 'gitview-fixtures',
        name: 'vite-vanilla',
        fullName: 'gitview-fixtures/vite-vanilla',
        htmlUrl: 'https://github.com/gitview-fixtures/vite-vanilla',
        defaultBranch: 'main',
        latestCommitSha: '0123456789abcdef0123456789abcdef01234567',
        primaryLanguage: 'JavaScript',
      },
    });

    // 3. Create browser context and authenticate
    context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    page = await context.newPage();

    page.on('console', (msg) => console.log('[BROWSER_CONSOLE]', msg.text()));
    page.on('response', (res) => {
      if (res.url().includes('/api/v1/previews')) {
        console.log('[API_RESPONSE]', res.status(), res.url());
      }
    });

    await page.goto('/login');
    await page.locator('input[type="email"]').fill(credentials.email);
    await page.locator('input[type="password"]').fill(credentials.password);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL('**/dashboard', { timeout: 15000 });
  });

  test.afterAll(async () => {
    if (activeSessionId) {
      try {
        execSync(`docker rm -f $(docker ps -aq --filter label=com.gitview.session-id=${activeSessionId}) 2>/dev/null || true`);
        execSync('docker network prune -f 2>/dev/null || true');
      } catch {}
    }

    await page?.close();
    await context?.close();

    try {
      if (credentials?.user?.id) {
        await prisma.previewSession.deleteMany({
          where: { userId: credentials.user.id },
        });
        await prisma.repository.deleteMany({
          where: { userId: credentials.user.id },
        });
      }
    } catch {}
  });

  test('01. Start Preview: Both toolbar and panel Stop Preview buttons appear and are visually distinct', async () => {
    test.setTimeout(90000);

    await page.goto(`/workspace?repo=${repoA.id}`);
    await page.waitForLoadState('networkidle');

    // Open preview panel
    const panel = page.locator('[data-testid="live-preview-panel"]');
    if (!(await panel.isVisible())) {
      await page.locator('[title="Toggle Preview Panel"]').click();
    }

    // Launch preview
    const runBtn = page.locator('[data-testid="preview-run-btn"]');
    await expect(runBtn).toBeVisible({ timeout: 10000 });
    await runBtn.click();

    // Wait for RUNNING state
    const runningState = page.locator('[data-testid="preview-running-state"]');
    await expect(runningState).toBeVisible({ timeout: 45000 });

    // Verify Workspace Toolbar Stop button is visible and distinct
    const toolbarStopBtn = page.locator('[data-testid="toolbar-stop-preview-btn"]');
    await expect(toolbarStopBtn).toBeVisible();
    await expect(toolbarStopBtn).toContainText('Stop Preview');
    expect(await toolbarStopBtn.isEnabled()).toBe(true);

    // Verify Preview Panel Toolbar Stop button is visible beside Refresh
    const panelStopBtn = page.locator('[data-testid="preview-stop-btn"]');
    await expect(panelStopBtn).toBeVisible();
    await expect(panelStopBtn).toContainText('Stop');
    expect(await panelStopBtn.isEnabled()).toBe(true);

    const refreshBtn = page.locator('[data-testid="preview-refresh-btn"]');
    await expect(refreshBtn).toBeVisible();

    // Verify Docker container is actually running
    const session = await prisma.previewSession.findFirst({
      where: { userId: credentials.user.id, isActive: true },
    });
    expect(session).toBeTruthy();
    activeSessionId = session.id;

    const dockerCheck = execSync(`docker ps --filter label=com.gitview.session-id=${session.id} --format "{{.ID}}"`).toString().trim();
    expect(dockerCheck.length).toBeGreaterThan(0);

    // Capture screenshot: Both Stop controls clearly visible
    await page.screenshot({ path: '../docs/stop-preview-screenshots/01-toolbar-and-panel-stop-buttons.png' });
  });

  test('02. Stop from Workspace Toolbar: Transitions through STOPPING to STOPPED, releases Docker containers, button disappears', async () => {
    test.setTimeout(60000);

    const toolbarStopBtn = page.locator('[data-testid="toolbar-stop-preview-btn"]');
    await expect(toolbarStopBtn).toBeVisible();

    // Click Stop on the top workspace toolbar
    await toolbarStopBtn.click();

    // Verify immediate disabled state to prevent duplicate clicks
    await expect(toolbarStopBtn).toBeDisabled();

    // Capture screenshot during stopping transition if visible or right after
    const stoppedState = page.locator('[data-testid="preview-stopped-state"]');
    await expect(stoppedState).toBeVisible({ timeout: 15000 });

    // Toolbar stop button should now be removed from toolbar
    await expect(toolbarStopBtn).not.toBeVisible();

    // Toolbar status pill should now show Preview: Idle or Preview: Stopped
    const statusPill = page.locator('[title="Toggle Live Preview Panel"]');
    await expect(statusPill).toContainText('Preview: Idle');

    // Verify Docker containers and networks are cleaned up
    if (activeSessionId) {
      const dockerCheck = execSync(`docker ps --filter label=com.gitview.session-id=${activeSessionId} --format "{{.ID}}"`).toString().trim();
      expect(dockerCheck.length).toBe(0);
    }

    // Capture screenshot of stopped state
    await page.screenshot({ path: '../docs/stop-preview-screenshots/02-stopped-after-toolbar-stop.png' });
  });

  test('03. Stop from Preview Panel: Transitions cleanly, syncs with top toolbar status, cleans up containers', async () => {
    test.setTimeout(90000);

    // Restart preview using panel restart button
    const restartBtn = page.locator('[data-testid="preview-restart-btn"]');
    await expect(restartBtn).toBeVisible();
    await restartBtn.click();

    // Wait for RUNNING state
    const runningState = page.locator('[data-testid="preview-running-state"]');
    await expect(runningState).toBeVisible({ timeout: 45000 });

    const session = await prisma.previewSession.findFirst({
      where: { userId: credentials.user.id, isActive: true },
    });
    expect(session).toBeTruthy();
    activeSessionId = session.id;

    // Both buttons should be visible
    const toolbarStopBtn = page.locator('[data-testid="toolbar-stop-preview-btn"]');
    const panelStopBtn = page.locator('[data-testid="preview-stop-btn"]');
    await expect(toolbarStopBtn).toBeVisible();
    await expect(panelStopBtn).toBeVisible();

    // Click Stop inside the preview panel toolbar
    await panelStopBtn.click();

    // Wait for stopped state
    const stoppedState = page.locator('[data-testid="preview-stopped-state"]');
    await expect(stoppedState).toBeVisible({ timeout: 15000 });

    // Global toolbar stop button disappears in sync
    await expect(toolbarStopBtn).not.toBeVisible();

    // Verify Docker containers stopped
    const dockerCheck = execSync(`docker ps --filter label=com.gitview.session-id=${session.id} --format "{{.ID}}"`).toString().trim();
    expect(dockerCheck.length).toBe(0);

    // Capture screenshot: Clean stopped preview panel
    await page.screenshot({ path: '../docs/stop-preview-screenshots/03-stopped-after-panel-stop.png' });
  });

  test('04. Responsiveness: Toolbar Stop Preview button remains accessible at normal desktop and narrower viewports', async () => {
    test.setTimeout(60000);

    // Launch preview again
    const restartBtn = page.locator('[data-testid="preview-restart-btn"]');
    await expect(restartBtn).toBeVisible();
    await restartBtn.click();

    await expect(page.locator('[data-testid="preview-running-state"]')).toBeVisible({ timeout: 45000 });

    const toolbarStopBtn = page.locator('[data-testid="toolbar-stop-preview-btn"]');
    await expect(toolbarStopBtn).toBeVisible();

    // 1. Standard Desktop (1440x900)
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(toolbarStopBtn).toBeVisible();
    await expect(toolbarStopBtn).toContainText('Stop Preview');

    // 2. Medium Desktop / Tablet Landscape (1024x768)
    await page.setViewportSize({ width: 1024, height: 768 });
    await expect(toolbarStopBtn).toBeVisible();
    await expect(toolbarStopBtn).toContainText('Stop Preview');

    // 3. Narrower Viewport (768x900)
    await page.setViewportSize({ width: 768, height: 900 });
    await expect(toolbarStopBtn).toBeVisible();
    await expect(toolbarStopBtn).toContainText('Stop');

    // Capture screenshot at narrower viewport
    await page.screenshot({ path: '../docs/stop-preview-screenshots/04-narrow-viewport-responsive.png' });

    // Restore standard desktop viewport and clean up
    await page.setViewportSize({ width: 1440, height: 900 });
    await toolbarStopBtn.click();
    await expect(page.locator('[data-testid="preview-stopped-state"]')).toBeVisible({ timeout: 15000 });
  });

  test('05. Stop & Launch Here Conflict Resolution: Cleanly terminates active session and starts new repository preview', async () => {
    test.setTimeout(90000);

    // 1. Start preview on repoA
    await page.goto(`/workspace?repo=${repoA.id}`);
    await page.waitForLoadState('networkidle');

    const panelA = page.locator('[data-testid="live-preview-panel"]');
    if (!(await panelA.isVisible())) {
      await page.locator('[title="Toggle Preview Panel"]').click();
    }

    const runBtn = page.locator('[data-testid="preview-run-btn"]');
    if (await runBtn.isVisible()) {
      await runBtn.click();
      await expect(page.locator('[data-testid="preview-running-state"]')).toBeVisible({ timeout: 45000 });
    }

    // 2. Navigate to repoB without stopping repoA
    await page.goto(`/workspace?repo=${repoB.id}`);
    await page.waitForLoadState('networkidle');

    // Open preview panel on repoB
    const panelB = page.locator('[data-testid="live-preview-panel"]');
    if (!(await panelB.isVisible())) {
      await page.locator('[title="Toggle Preview Panel"]').click();
    }

    // Try to run preview on repoB -> triggers conflict detection
    const runBtnB = page.locator('[data-testid="preview-run-btn"]');
    await expect(runBtnB).toBeVisible({ timeout: 10000 });
    await runBtnB.click();

    // 3. Assert conflict card appears with "Stop & Launch Here"
    const conflictBtn = page.locator('[data-testid="preview-terminate-restart-btn"]');
    await expect(conflictBtn).toBeVisible({ timeout: 10000 });
    await expect(conflictBtn).toContainText('Stop & Launch Here');

    // Capture screenshot of conflict resolution card
    await page.screenshot({ path: '../docs/stop-preview-screenshots/05-conflict-stop-and-launch.png' });

    // 4. Click "Stop & Launch Here"
    await conflictBtn.click();

    // 5. Assert repoB launches into RUNNING state
    await expect(page.locator('[data-testid="preview-running-state"]')).toBeVisible({ timeout: 45000 });

    // 6. Stop repoB from toolbar to clean up
    const toolbarStop = page.locator('[data-testid="toolbar-stop-preview-btn"]');
    await expect(toolbarStop).toBeVisible();
    await toolbarStop.click();
    await expect(page.locator('[data-testid="preview-stopped-state"]')).toBeVisible({ timeout: 15000 });

    // Verify neither repo was deleted
    const countA = await prisma.repository.count({ where: { id: repoA.id } });
    const countB = await prisma.repository.count({ where: { id: repoB.id } });
    expect(countA).toBe(1);
    expect(countB).toBe(1);
  });
});

import { test, expect } from '@playwright/test';
import { setupE2EUser } from './test-setup.mjs';
import { prisma } from '../../server/src/lib/prisma.js';
import { execSync } from 'node:child_process';

test.describe.serial('GitView Phase 5: Live Frontend-to-Backend Docker Acceptance Smoke Suite', () => {
  let context;
  let page;
  let credentials;
  let staticRepo;
  let vanillaRepo;
  let reactRepo;
  let activeSessionId = null;

  test.beforeAll(async ({ browser }) => {
    // 0. Clean any lingering Docker containers or networks from previous tests
    try {
      execSync('docker rm -f $(docker ps -aq --filter label=com.gitview.managed=true) 2>/dev/null || true');
      execSync('docker network prune -f 2>/dev/null || true');
    } catch {}

    // 1. Prepare E2E user in PostgreSQL
    credentials = await setupE2EUser();

    // 2. Insert synthetic fixture repositories for user
    staticRepo = await prisma.repository.create({
      data: {
        userId: credentials.user.id,
        githubRepoId: '900001',
        owner: 'gitview-fixtures',
        name: 'static-site',
        fullName: 'gitview-fixtures/static-site',
        htmlUrl: 'https://github.com/gitview-fixtures/static-site',
        defaultBranch: 'main',
        latestCommitSha: '0123456789abcdef0123456789abcdef01234567',
        primaryLanguage: 'HTML',
      },
    });

    vanillaRepo = await prisma.repository.create({
      data: {
        userId: credentials.user.id,
        githubRepoId: '900002',
        owner: 'gitview-fixtures',
        name: 'vite-vanilla',
        fullName: 'gitview-fixtures/vite-vanilla',
        htmlUrl: 'https://github.com/gitview-fixtures/vite-vanilla',
        defaultBranch: 'main',
        latestCommitSha: '0123456789abcdef0123456789abcdef01234567',
        primaryLanguage: 'JavaScript',
      },
    });

    reactRepo = await prisma.repository.create({
      data: {
        userId: credentials.user.id,
        githubRepoId: '900003',
        owner: 'gitview-fixtures',
        name: 'vite-react',
        fullName: 'gitview-fixtures/vite-react',
        htmlUrl: 'https://github.com/gitview-fixtures/vite-react',
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

  test.afterEach(async () => {
    try {
      execSync('docker rm -f $(docker ps -aq --filter label=com.gitview.managed=true) 2>/dev/null || true');
      execSync('docker network prune -f 2>/dev/null || true');
    } catch {}
  });

  test.afterAll(async () => {
    // Teardown any running session in Docker
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
        await prisma.oAuthAccount.deleteMany({
          where: { userId: credentials.user.id },
        });
        await prisma.refreshToken.deleteMany({
          where: { userId: credentials.user.id },
        });
        await prisma.user.delete({
          where: { id: credentials.user.id },
        });
      }
    } catch (e) {
      console.warn('Live smoke cleanup warning:', e.message);
    } finally {
      await prisma.$disconnect();
    }
  });

  test('01. Live STATIC Preview: Launch, Render Iframe DOM, Live Open in New Tab Flow & Stop Cleanup', async () => {
    test.setTimeout(90000);

    // Navigate to workspace with static repo
    await page.goto(`/workspace?repo=${staticRepo.id}`);
    await page.waitForLoadState('networkidle');

    // Open Preview panel via toolbar if not already visible
    const previewTrigger = page.locator('[title="Toggle Live Preview Panel"]');
    if (await previewTrigger.isVisible()) {
      await previewTrigger.click();
    }

    const runBtn = page.locator('[data-testid="preview-run-btn"]');
    await expect(runBtn).toBeVisible({ timeout: 10000 });
    await runBtn.click();

    // Wait for RUNNING state to be mounted
    const runningState = page.locator('[data-testid="preview-running-state"]');
    await expect(runningState).toBeVisible({ timeout: 45000 });

    // Verify framework badge shows STATIC
    const frameworkBadge = page.locator('[data-testid="framework-badge"]');
    await expect(frameworkBadge).toBeVisible();
    await expect(frameworkBadge).toHaveText('STATIC');

    // Verify sandboxed iframe is mounted
    const iframe = page.locator('[data-testid="preview-iframe"]');
    await expect(iframe).toBeVisible();
    await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts allow-forms allow-same-origin');
    await expect(iframe).toHaveAttribute('referrerpolicy', 'no-referrer');

    // Inspect iframe content and confirm actual rendered DOM element from static-site fixture
    const frame = page.frameLocator('[data-testid="preview-iframe"]');
    const heading = frame.locator('h1');
    await expect(heading).toBeVisible({ timeout: 20000 });
    await expect(heading).toHaveText('GitView Static Preview Test');

    // Retrieve active session ID from database
    const session = await prisma.previewSession.findFirst({
      where: { userId: credentials.user.id, isActive: true },
    });
    expect(session).toBeTruthy();
    activeSessionId = session.id;

    // Verify Docker container exists and is running
    const dockerCheck = execSync(`docker ps --filter label=com.gitview.session-id=${session.id} --format "{{.ID}}"`).toString().trim();
    expect(dockerCheck.length).toBeGreaterThan(0);

    // Verify actual live Open in New Tab flow
    const newTabBtn = page.locator('[data-testid="preview-newtab-btn"]');
    await expect(newTabBtn).toBeVisible();

    // Track bootstrap redemption request across context to capture ticket URL
    let redeemedTicketUrl = null;
    const onRequest = (req) => {
      const u = req.url();
      if (u.includes('/__gitview_bootstrap') && u.includes('ticket=')) {
        redeemedTicketUrl = u;
      }
    };
    context.on('request', onRequest);

    // Click Open in New Tab and capture popup
    const [newTab] = await Promise.all([
      context.waitForEvent('page'),
      newTabBtn.click(),
    ]);

    await newTab.waitForLoadState('networkidle');
    context.off('request', onRequest);

    // Assert preview renders in the new tab
    const newTabHeading = newTab.locator('h1');
    await expect(newTabHeading).toBeVisible({ timeout: 20000 });
    await expect(newTabHeading).toHaveText('GitView Static Preview Test');

    // Verify final URL has no ticket query parameter (/ after 302 redirect)
    const finalUrl = new URL(newTab.url());
    expect(finalUrl.pathname).toBe('/');
    expect(finalUrl.searchParams.has('ticket')).toBe(false);

    // Verify independent top-level ticket redemption occurred
    expect(redeemedTicketUrl).toBeTruthy();
    expect(redeemedTicketUrl).toContain('mode=toplevel');
    expect(redeemedTicketUrl).toContain('ticket=');

    // Verify ticket replay is rejected (HTTP 401 Unauthorized upon re-requesting same ticket)
    const replayResponse = await page.request.get(redeemedTicketUrl, {
      maxRedirects: 0,
      failOnStatusCode: false,
    });
    expect(replayResponse.status()).toBe(401);

    await newTab.close();

    // Click Stop Preview
    const stopBtn = page.locator('[data-testid="preview-stop-btn"]');
    await expect(stopBtn).toBeVisible();
    await stopBtn.click();

    // Confirm UI transitions cleanly to STOPPED
    const stoppedState = page.locator('[data-testid="preview-stopped-state"]');
    await expect(stoppedState).toBeVisible({ timeout: 15000 });

    // Verify in Docker daemon that all containers for session have been stopped and removed
    await expect.poll(() => {
      const remaining = execSync(`docker ps -q --filter label=com.gitview.session-id=${session.id}`).toString().trim();
      return remaining;
    }, { timeout: 15000 }).toBe('');

    activeSessionId = null;
  });

  test('02. Live VITE_VANILLA Preview: Build, Start Runner & Sidecar, Render Iframe DOM, Live HMR Update & Stop', async () => {
    test.setTimeout(120000);

    // Navigate to workspace with vite-vanilla repo
    await page.goto(`/workspace?repo=${vanillaRepo.id}`);
    await page.waitForLoadState('networkidle');

    // Open Preview panel via toolbar if not already visible
    const previewTrigger = page.locator('[title="Toggle Live Preview Panel"]');
    if (await previewTrigger.isVisible()) {
      await previewTrigger.click();
    }

    const runBtn = page.locator('[data-testid="preview-run-btn"]');
    await expect(runBtn).toBeVisible({ timeout: 10000 });
    await runBtn.click();

    // Wait for RUNNING state to be mounted (builder + egress proxy + vite startup)
    const runningState = page.locator('[data-testid="preview-running-state"]');
    await expect(runningState).toBeVisible({ timeout: 90000 });

    // Verify framework badge
    const frameworkBadge = page.locator('[data-testid="framework-badge"]');
    await expect(frameworkBadge).toBeVisible();
    await expect(frameworkBadge).toHaveText('VITE_VANILLA');

    // Inspect iframe content and confirm rendered DOM from vite-vanilla fixture
    const frame = page.frameLocator('[data-testid="preview-iframe"]');
    const heading = frame.locator('h1');
    await expect(heading).toBeVisible({ timeout: 20000 });
    await expect(heading).toHaveText('GitView Vanilla Preview');

    // Retrieve active session ID
    const session = await prisma.previewSession.findFirst({
      where: { userId: credentials.user.id, isActive: true },
    });
    expect(session).toBeTruthy();
    activeSessionId = session.id;

    // Live HMR Verification: modify a source file inside the running workspace container
    execSync(
      `docker exec gitview-runner-${session.id} sh -c "echo \\"document.querySelector('h1').textContent = 'GitView Vanilla Preview — Live HMR Updated!';\\" >> /workspace/main.js"`
    );

    // Assert the browser iframe DOM updates via WebSocket HMR without a full manual refresh
    await expect(heading).toHaveText('GitView Vanilla Preview — Live HMR Updated!', { timeout: 15000 });

    // Click Stop Preview
    const stopBtn = page.locator('[data-testid="preview-stop-btn"]');
    await expect(stopBtn).toBeVisible();
    await stopBtn.click();

    // Confirm UI transitions cleanly to STOPPED
    const stoppedState = page.locator('[data-testid="preview-stopped-state"]');
    await expect(stoppedState).toBeVisible({ timeout: 15000 });

    // Verify Docker cleanup
    await expect.poll(() => {
      const remaining = execSync(`docker ps -q --filter label=com.gitview.session-id=${session.id}`).toString().trim();
      return remaining;
    }, { timeout: 15000 }).toBe('');

    activeSessionId = null;
  });

  test('03. Live VITE_REACT Preview: JSX Transformation, Render Iframe DOM, Live Fast Refresh Update & Clean Stop', async () => {
    test.setTimeout(120000);

    // Navigate to workspace with vite-react repo
    await page.goto(`/workspace?repo=${reactRepo.id}`);
    await page.waitForLoadState('networkidle');

    // Open Preview panel via toolbar if not already visible
    const previewTrigger = page.locator('[title="Toggle Live Preview Panel"]');
    if (await previewTrigger.isVisible()) {
      await previewTrigger.click();
    }

    const runBtn = page.locator('[data-testid="preview-run-btn"]');
    await expect(runBtn).toBeVisible({ timeout: 10000 });
    await runBtn.click();

    // Wait for RUNNING state to be mounted
    const runningState = page.locator('[data-testid="preview-running-state"]');
    await expect(runningState).toBeVisible({ timeout: 90000 });

    // Verify framework badge
    const frameworkBadge = page.locator('[data-testid="framework-badge"]');
    await expect(frameworkBadge).toBeVisible();
    await expect(frameworkBadge).toHaveText('VITE_REACT');

    // Inspect iframe content and confirm rendered React DOM from vite-react fixture
    const frame = page.frameLocator('[data-testid="preview-iframe"]');
    const heading = frame.locator('h1');
    await expect(heading).toBeVisible({ timeout: 20000 });
    await expect(heading).toHaveText('GitView React Preview');

    // Retrieve active session ID
    const session = await prisma.previewSession.findFirst({
      where: { userId: credentials.user.id, isActive: true },
    });
    expect(session).toBeTruthy();
    activeSessionId = session.id;

    // Live Fast Refresh Verification: modify a JSX file inside the running workspace container
    execSync(
      `docker exec gitview-runner-${session.id} sh -c "sed -i.bak 's/GitView React Preview/GitView React Preview — Fast Refresh Updated!/g' /workspace/src/main.jsx"`
    );

    // Assert the updated React DOM appears through Fast Refresh via WebSocket without manual refresh
    await expect(heading).toHaveText('GitView React Preview — Fast Refresh Updated!', { timeout: 15000 });

    // Click Stop Preview
    const stopBtn = page.locator('[data-testid="preview-stop-btn"]');
    await expect(stopBtn).toBeVisible();
    await stopBtn.click();

    // Confirm UI transitions cleanly to STOPPED
    const stoppedState = page.locator('[data-testid="preview-stopped-state"]');
    await expect(stoppedState).toBeVisible({ timeout: 15000 });

    // Verify Docker cleanup
    await expect.poll(() => {
      const remaining = execSync(`docker ps -q --filter label=com.gitview.session-id=${session.id}`).toString().trim();
      return remaining;
    }, { timeout: 15000 }).toBe('');

    activeSessionId = null;
  });
});

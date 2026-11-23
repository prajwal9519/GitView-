import { test, expect } from '@playwright/test';
import { setupE2EUser } from './test-setup.mjs';

test.describe.serial('GitView Phase 5: Live Preview & End-to-End Hardening E2E Suite', () => {
  let context;
  let page;
  let credentials;
  const consoleMessages = [];

  test.beforeAll(async ({ browser }) => {
    // 1. Prepare E2E user in database
    credentials = await setupE2EUser();

    // 1b. Ensure a fixture repository exists for the user
    const { prisma } = await import('../../server/src/lib/prisma.js');
    await prisma.repository.upsert({
      where: {
        userId_githubRepoId: {
          userId: credentials.user.id,
          githubRepoId: '900001',
        },
      },
      update: {},
      create: {
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

    // 2. Create browser context
    context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    page = await context.newPage();

    // Track all console messages to verify zero credential/token leakage
    page.on('console', (msg) => {
      consoleMessages.push(msg.text());
    });

    // 3. Authenticate test user
    await page.goto('/login');
    await expect(page).toHaveTitle(/GitView/i);
    await page.locator('input[type="email"]').fill(credentials.email);
    await page.locator('input[type="password"]').fill(credentials.password);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL('**/dashboard', { timeout: 15000 });
  });

  test.afterAll(async () => {
    await page?.close();
    await context?.close();

    // Database cleanup
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
      }
    } catch (e) {
      console.warn('Cleanup notice:', e.message);
    } finally {
      await prisma.$disconnect();
    }
  });

  test('01. Preview Panel UI & Initial IDLE State', async () => {
    await page.goto('/workspace');
    await page.waitForLoadState('networkidle');

    // Click preview badge in the toolbar to toggle open the preview panel
    const previewBadge = page.locator('text=/Preview: (Launch|Idle)/');
    await expect(previewBadge).toBeVisible({ timeout: 10000 });
    await previewBadge.click();

    // Verify LivePreview panel is visible
    const previewPanel = page.locator('[data-testid="live-preview-panel"]');
    await expect(previewPanel).toBeVisible();

    // Verify IDLE state elements
    const idleState = page.locator('[data-testid="preview-idle-state"]');
    await expect(idleState).toBeVisible();
    await expect(idleState).toContainText('Live Isolated Preview');
    await expect(idleState).toContainText('HTML / CSS / JS (Static)');
    await expect(idleState).toContainText('Vite Vanilla');
    await expect(idleState).toContainText('Vite React + JSX');

    // Verify security guarantees listed
    await expect(idleState).toContainText('Loopback runner isolation');
    await expect(idleState).toContainText('__Host- partitioned cookies (CHIPS)');
    await expect(idleState).toContainText('Strict Content-Security-Policy');

    // Verify "Run Preview" button is enabled
    const runBtn = page.locator('[data-testid="preview-run-btn"]');
    await expect(runBtn).toBeVisible();
    await expect(runBtn).toBeEnabled();

    // Take screenshot of IDLE state
    await page.screenshot({ path: 'test-results/screenshots/preview-01-idle-state.png' });
  });

  test('02. Viewport Switcher & Mobile Responsive Controls', async () => {
    // Mock a RUNNING session to inspect toolbar controls
    await page.route('**/api/v1/previews', async (route) => {
      if (route.request().method() === 'POST') {
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              id: 'sess-viewport-test-1111',
              repositoryId: 'repo-1',
              status: 'RUNNING',
              framework: 'STATIC',
              isActive: true,
              createdAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 3600000).toISOString(),
            },
          }),
        });
      }
      return route.continue();
    });

    await page.route('**/api/v1/previews/*/ticket', async (route) => {
      const postData = route.request().postDataJSON();
      const mode = postData?.mode || 'iframe';
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            previewUrl: `http://sess-viewport-test-1111.preview.localhost:3000/__gitview_bootstrap?ticket=fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210&mode=${mode}`,
            targetOrigin: 'http://sess-viewport-test-1111.preview.localhost:3000',
            ticketExpiresAt: new Date(Date.now() + 30000).toISOString(),
          },
        }),
      });
    });

    await page.route('**/api/v1/previews/*/stop', async (route) => {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            id: 'sess-viewport-test-1111',
            status: 'STOPPED',
            isActive: false,
          },
        }),
      });
    });

    const runBtn = page.locator('[data-testid="preview-run-btn"]');
    await runBtn.click();

    // Verify RUNNING state
    await expect(page.locator('[data-testid="preview-running-state"]')).toBeVisible({ timeout: 10000 });

    // Switch to Mobile viewport (375px)
    const mobileBtn = page.locator('[data-testid="viewport-mobile-btn"]');
    await mobileBtn.click();
    const viewportContainer = page.locator('[data-testid="preview-viewport-container"]');
    await expect(viewportContainer).toHaveClass(/w-\[375px\]/);

    // Switch back to Desktop viewport
    const desktopBtn = page.locator('[data-testid="viewport-desktop-btn"]');
    await desktopBtn.click();
    await expect(viewportContainer).toHaveClass(/w-full/);

    // Stop session cleanly
    const stopBtn = page.locator('[data-testid="preview-stop-btn"]');
    await stopBtn.click();
    await expect(page.locator('[data-testid="preview-stopped-state"]')).toBeVisible();

    await page.unroute('**/api/v1/previews');
    await page.unroute('**/api/v1/previews/*/ticket');
    await page.unroute('**/api/v1/previews/*/stop');
  });

  test('03. Progressive Loading Stepper & User Cancellation', async () => {
    let stopCalled = false;

    // Simulate multi-stage progression: FETCHING -> BUILDING -> STARTING
    await page.route('**/api/v1/previews', async (route) => {
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            id: 'sess-stepper-test-2222',
            repositoryId: 'repo-2',
            status: 'FETCHING',
            framework: 'VITE_REACT',
            isActive: true,
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
          },
        }),
      });
    });

    await page.route('**/api/v1/previews/sess-stepper-test-2222', async (route) => {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            id: 'sess-stepper-test-2222',
            status: 'BUILDING',
            framework: 'VITE_REACT',
            isActive: true,
          },
        }),
      });
    });

    await page.route('**/api/v1/previews/sess-stepper-test-2222/stop', async (route) => {
      stopCalled = true;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            id: 'sess-stepper-test-2222',
            status: 'STOPPED',
            isActive: false,
          },
        }),
      });
    });

    // Start preview from stopped state
    const restartBtn = page.locator('[data-testid="preview-restart-btn"]');
    await restartBtn.click();

    // Verify loading stage stepper appears
    const loadingState = page.locator('[data-testid="preview-loading-state"]');
    await expect(loadingState).toBeVisible({ timeout: 10000 });

    const stageTitle = page.locator('[data-testid="preview-stage-title"]');
    await expect(stageTitle).toBeVisible();

    // Click "Cancel Launch" button
    const cancelBtn = page.locator('[data-testid="preview-cancel-btn"]');
    await expect(cancelBtn).toBeVisible();
    await cancelBtn.click();

    // Verify session stopped
    await expect(page.locator('[data-testid="preview-stopped-state"]')).toBeVisible();
    expect(stopCalled).toBe(true);

    await page.unroute('**/api/v1/previews');
    await page.unroute('**/api/v1/previews/sess-stepper-test-2222');
    await page.unroute('**/api/v1/previews/sess-stepper-test-2222/stop');
  });

  test('04. Active RUNNING State & Strict Iframe Sandboxing Invariants', async () => {
    let requestedTicketMode = null;

    await page.route('**/api/v1/previews', async (route) => {
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            id: 'sess-sandbox-test-3333',
            repositoryId: 'repo-3',
            status: 'RUNNING',
            framework: 'VITE_REACT',
            isActive: true,
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 3500000).toISOString(),
          },
        }),
      });
    });

    await page.route('**/api/v1/previews/sess-sandbox-test-3333/ticket', async (route) => {
      const body = route.request().postDataJSON();
      requestedTicketMode = body?.mode;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            previewUrl:
              'http://sess-sandbox-test-3333.preview.localhost:3000/__gitview_bootstrap?ticket=1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff',
            targetOrigin: 'http://sess-sandbox-test-3333.preview.localhost:3000',
            ticketExpiresAt: new Date(Date.now() + 30000).toISOString(),
          },
        }),
      });
    });

    // Start preview from stopped state
    const restartBtn = page.locator('[data-testid="preview-restart-btn"]');
    await restartBtn.click();

    // Verify RUNNING state
    await expect(page.locator('[data-testid="preview-running-state"]')).toBeVisible({ timeout: 10000 });

    // Verify framework badge
    const badge = page.locator('[data-testid="framework-badge"]');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText('VITE_REACT');

    // Verify ticket mode requested was strictly 'iframe'
    expect(requestedTicketMode).toBe('iframe');

    // Inspect iframe sandbox attributes
    const iframe = page.locator('[data-testid="preview-iframe"]');
    await expect(iframe).toBeVisible();

    const sandbox = await iframe.getAttribute('sandbox');
    expect(sandbox).toContain('allow-scripts');
    expect(sandbox).toContain('allow-forms');
    expect(sandbox).toContain('allow-same-origin');

    // STRICT INVARIANT: Must NEVER include dangerous bypass capabilities
    expect(sandbox).not.toContain('allow-top-navigation');
    expect(sandbox).not.toContain('allow-modals');
    expect(sandbox).not.toContain('allow-popups-to-escape-sandbox');

    // Verify referrer policy
    const referrerPolicy = await iframe.getAttribute('referrerpolicy');
    expect(referrerPolicy).toBe('no-referrer');

    // Verify iframe src format
    const src = await iframe.getAttribute('src');
    expect(src).toContain('__gitview_bootstrap?ticket=');

    // Take screenshot of RUNNING state
    await page.screenshot({ path: 'test-results/screenshots/preview-04-running-sandboxed.png' });
  });

  test('05. Zero Secret Token or Ticket Storage Invariant', async () => {
    // Assert localStorage does NOT contain any ticket or preview token values
    const localKeys = await page.evaluate(() => Object.keys(localStorage));
    for (const key of localKeys) {
      expect(key.toLowerCase()).not.toContain('preview_token');
      expect(key.toLowerCase()).not.toContain('ticket');
      const val = await page.evaluate((k) => localStorage.getItem(k), key);
      expect(val).not.toContain('__gitview_bootstrap');
    }

    // Assert sessionStorage does NOT contain any ticket or preview token values
    const sessionKeys = await page.evaluate(() => Object.keys(sessionStorage));
    for (const key of sessionKeys) {
      expect(key.toLowerCase()).not.toContain('preview_token');
      expect(key.toLowerCase()).not.toContain('ticket');
    }

    // Assert browser console logs did NOT print raw 64-hex tickets
    for (const msg of consoleMessages) {
      expect(msg).not.toMatch(/[0-9a-f]{64}/i);
    }
  });

  test('06. Top-Level New Tab Navigation (mode: toplevel)', async () => {
    let newTabTicketMode = null;

    await page.route('**/api/v1/previews/sess-sandbox-test-3333/ticket', async (route) => {
      const body = route.request().postDataJSON();
      newTabTicketMode = body?.mode;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            previewUrl:
              'http://sess-sandbox-test-3333.preview.localhost:3000/__gitview_bootstrap?ticket=9999888877776666555544443333222211110000ffffeeeeddddccccbbbbaaaa',
            targetOrigin: 'http://sess-sandbox-test-3333.preview.localhost:3000',
            ticketExpiresAt: new Date(Date.now() + 30000).toISOString(),
          },
        }),
      });
    });

    // Mock window.open to intercept top-level URL
    let openedUrl = null;
    await page.exposeFunction('mockWindowOpen', (url) => {
      openedUrl = url;
    });
    await page.evaluate(() => {
      window.open = (url) => {
        window.mockWindowOpen(url);
        return null;
      };
    });

    const newTabBtn = page.locator('[data-testid="preview-newtab-btn"]');
    await expect(newTabBtn).toBeVisible();
    await newTabBtn.click();

    // Verify mode requested for new tab was strictly 'toplevel'
    await expect.poll(() => newTabTicketMode).toBe('toplevel');
    await expect.poll(() => openedUrl).toContain('__gitview_bootstrap?ticket=9999888877776666');
  });

  test('07. Reload / Refresh Preview Frame', async () => {
    let refreshTicketRequested = false;

    await page.route('**/api/v1/previews/sess-sandbox-test-3333/ticket', async (route) => {
      const body = route.request().postDataJSON();
      if (body?.mode === 'iframe') {
        refreshTicketRequested = true;
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            previewUrl:
              'http://sess-sandbox-test-3333.preview.localhost:3000/__gitview_bootstrap?ticket=reloaded1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff',
            targetOrigin: 'http://sess-sandbox-test-3333.preview.localhost:3000',
            ticketExpiresAt: new Date(Date.now() + 30000).toISOString(),
          },
        }),
      });
    });

    const refreshBtn = page.locator('[data-testid="preview-refresh-btn"]');
    await refreshBtn.click();

    await expect.poll(() => refreshTicketRequested).toBe(true);

    await page.unroute('**/api/v1/previews');
    await page.unroute('**/api/v1/previews/sess-sandbox-test-3333/ticket');
  });

  test('08. Failure Scenario & Collapsible Error Diagnostics', async () => {
    await page.route('**/api/v1/previews/*/stop', async (route) => {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: { id: '33333333-3333-4333-8333-333333333333', status: 'STOPPED', isActive: false },
        }),
      });
    });

    await page.route('**/api/v1/previews', async (route) => {
      if (route.request().method() === 'POST') {
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              id: '44444444-4444-4444-8444-444444444444',
              status: 'FAILED',
              errorCode: 'BUILD_FAILED',
              errorMessage: 'SyntaxError: Unexpected token < in index.jsx:12:4\n    at viteBuild (vite.config.js:10)',
              isActive: false,
            },
          }),
        });
      }
      return route.continue();
    });

    // Trigger preview
    const stopBtn = page.locator('[data-testid="preview-stop-btn"]');
    if (await stopBtn.isVisible()) {
      await stopBtn.click();
      await expect(page.locator('[data-testid="preview-stopped-state"]')).toBeVisible();
    }
    const restartBtn = page.locator('[data-testid="preview-restart-btn"]');
    await restartBtn.click();

    // Verify FAILED state UI
    const failedState = page.locator('[data-testid="preview-failed-state"]');
    await expect(failedState).toBeVisible({ timeout: 10000 });
    await expect(failedState).toContainText('Preview Execution Failed');

    // Verify error code badge
    const errorCode = page.locator('[data-testid="preview-error-code"]');
    await expect(errorCode).toBeVisible();
    await expect(errorCode).toContainText('BUILD_FAILED');

    // Toggle error log details
    const showDetailsBtn = failedState.locator('text=Show Error Log');
    await expect(showDetailsBtn).toBeVisible();
    await showDetailsBtn.click();

    const errorPre = failedState.locator('pre');
    await expect(errorPre).toBeVisible();
    await expect(errorPre).toContainText('SyntaxError: Unexpected token');

    // Verify retry button exists
    const retryBtn = page.locator('[data-testid="preview-retry-btn"]');
    await expect(retryBtn).toBeVisible();

    await page.screenshot({ path: 'test-results/screenshots/preview-08-failed-state.png' });

    await page.unroute('**/api/v1/previews');
    await page.unroute('**/api/v1/previews/*/stop');
  });

  test('09. Active Session Conflict Resolution (HTTP 409)', async () => {
    let stopPreviousCalled = false;

    await page.route('**/api/v1/previews', async (route) => {
      if (route.request().method() === 'POST') {
        return route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            error: {
              code: 'ACTIVE_SESSION_CONFLICT',
              message: 'You already have an active live preview session. Only one concurrent preview is permitted.',
              details: { activeSessionId: '55555555-5555-4555-8555-555555555555' },
            },
          }),
        });
      }
      return route.continue();
    });

    await page.route('**/api/v1/previews/55555555-5555-4555-8555-555555555555/stop', async (route) => {
      stopPreviousCalled = true;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: { id: '55555555-5555-4555-8555-555555555555', status: 'STOPPED', isActive: false },
        }),
      });
    });

    const retryBtn = page.locator('[data-testid="preview-retry-btn"]');
    await retryBtn.click();

    // Verify conflict state UI
    const conflictState = page.locator('[data-testid="preview-conflict-state"]');
    await expect(conflictState).toBeVisible({ timeout: 10000 });
    await expect(conflictState).toContainText('Active Preview Exists');

    // Click "Switch to This Preview"
    const switchBtn = page.locator('[data-testid="preview-terminate-restart-btn"]');
    await expect(switchBtn).toBeVisible();
    await switchBtn.click();

    // Verify that the conflict session stop endpoint was invoked
    await expect.poll(() => stopPreviousCalled).toBe(true);

    await page.unroute('**/api/v1/previews');
    await page.unroute('**/api/v1/previews/55555555-5555-4555-8555-555555555555/stop');
  });
});

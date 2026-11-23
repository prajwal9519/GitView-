import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { signAccessToken } from '../../server/src/utils/tokens.js';
import { prisma } from '../../server/src/lib/prisma.js';

test.describe.serial('GitView Cross-Framework QA & Compatibility Acceptance Suite', () => {
  let context;
  let page;
  const userId = '36aeb54a-7e81-4d07-ace1-330ce5c12794';

  const repos = {
    countryGuide: {
      id: '04ce2953-2e55-4bfe-a557-5c465505eb56',
      name: 'country-guide-app',
      expectedFramework: 'Vite Vanilla',
      isStatic: false,
      jsFile: 'main.js',
      cssFile: 'css/style.css',
    },
    todoApp: {
      id: '734a1fed-2cab-43b7-a8c7-5fcf095fd2fe',
      name: 'JavaScript-todoapp-vite',
      expectedFramework: 'Vite Vanilla',
      isStatic: false,
      jsFile: 'main.js',
      cssFile: 'style.css',
    },
    calculator: {
      id: '2ba10cf2-6221-4268-ad09-13070b502e30',
      name: 'Landing-page-with-calculator',
      expectedFramework: 'Vite Vanilla',
      isStatic: false,
      jsFile: 'calculator.html',
      cssFile: 'src/style.css',
    },
    vanillaTodoList: {
      id: '467cdaf8-2e42-449b-a01c-2dd86c781780',
      name: 'TodoList-Apps---Vite-TailwindCSS---JavaScript-Vanilla-Native',
      expectedFramework: 'Vite Vanilla',
      isStatic: false,
      jsFile: 'src/main.js',
      cssFile: 'index.html',
    },
    ticTacToe: {
      id: '3ffa100f-216d-467b-842d-32334b410222',
      name: 'AI-Tic-Tac-Toe-Website',
      expectedFramework: 'Static',
      isStatic: true,
      jsFile: 'index.js',
      cssFile: 'style.css',
    },
    justDoIt: {
      id: '514c6be8-0106-4b7d-83a4-6a49ba5b2685',
      name: 'ToDoList',
      expectedFramework: 'Static',
      isStatic: true,
      jsFile: 'index.html',
      cssFile: 'CSS/style.css',
    },
    portfolio: {
      id: 'bc085c1d-93a4-4e0a-b00d-4b809c211995',
      name: 'portfolio-responsive-complete',
      expectedFramework: 'Static',
      isStatic: true,
      jsFile: 'index.html',
      cssFile: 'assets/css/styles.css',
    },
  };

  test.beforeAll(async ({ browser }) => {
    // Teardown stale sessions
    try {
      execSync('docker rm -f $(docker ps -aq --filter label=com.gitview.managed=true) 2>/dev/null || true');
      execSync('docker network prune -f 2>/dev/null || true');
    } catch {}

    await prisma.previewSession.updateMany({
      where: { userId, isActive: true },
      data: { isActive: false, status: 'STOPPED' },
    });

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

  test.beforeEach(async () => {
    test.setTimeout(120000);
    // Ensure no active session remains in DB before each test
    await prisma.previewSession.updateMany({
      where: { userId, isActive: true },
      data: { isActive: false, status: 'STOPPED' },
    });
    // Brief breather for rate limits
    await page.waitForTimeout(1000);
  });

  test.afterAll(async () => {
    try {
      execSync('docker rm -f $(docker ps -aq --filter label=com.gitview.managed=true) 2>/dev/null || true');
      execSync('docker network prune -f 2>/dev/null || true');
    } catch {}
    await page?.close();
    await context?.close();
  });

  // =========================================================================
  // 1. Country Guide (Vite + Vanilla JS)
  // =========================================================================
  test('1. Country Guide App: Explorer, Dependencies, Vite Vanilla Detection & Lockfile Audit', async () => {
    const config = repos.countryGuide;
    await page.goto(`/workspace/${config.id}`, { waitUntil: 'networkidle' });

    // A. Explorer
    await expect(page.locator(`text=${config.name}`).first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator('text=main.js').first()).toBeVisible();

    // Open main.js in Monaco
    await page.locator('text=main.js').first().click();
    await page.waitForTimeout(1000);
    const monaco = page.locator('.monaco-editor');
    await expect(monaco).toBeVisible();

    // Open README
    const readmeTab = page.locator('button:has-text("README")');
    if (await readmeTab.isVisible()) {
      await readmeTab.click();
      await page.waitForTimeout(500);
    }

    // B. Dependencies
    const depsTab = page.locator('button:has-text("Dependencies")').first();
    await depsTab.click();
    const manifestPath = page.locator('[data-testid="manifest-path"]');
    await expect(manifestPath).toBeVisible({ timeout: 10000 });
    await expect(manifestPath).toContainText('package.json');
    await expect(page.locator('text=bootstrap').first()).toBeVisible();
    await expect(page.locator('text=sass').first()).toBeVisible();
    await expect(page.locator('text=vite').first()).toBeVisible();

    await page.screenshot({ path: '../docs/cross-framework-screenshots/01-country-guide-dependencies.png' });

    // C. Framework Detection
    const previewPanel = page.locator('[data-testid="live-preview-panel"]');
    if (!(await previewPanel.isVisible())) {
      await page.locator('button[title*="Preview"]').first().click();
    }
    await expect(previewPanel).toBeVisible({ timeout: 5000 });
    const badge = page.locator('[data-testid="framework-badge"]');
    await expect(badge).toBeVisible();
    await expect(badge).toContainText(/Vanilla/i);
    // Explicitly verify Vanilla is NEVER misclassified as React
    await expect(badge).not.toContainText(/React/i);

    // D. Run Preview - Expected: BUILD_FAILED due to author's out-of-sync lockfile
    const runBtn = page.locator('[data-testid="preview-run-btn"]');
    await runBtn.click();

    // Verify terminal failure state cleanly caught by GitView
    const failedState = page.locator('[data-testid="preview-failed-state"]');
    await expect(failedState).toBeVisible({ timeout: 45000 });
    const errorCode = page.locator('[data-testid="preview-error-code"]');
    await expect(errorCode).toContainText('BUILD_FAILED');

    await page.screenshot({ path: '../docs/cross-framework-screenshots/01-country-guide-preview-failed.png' });
  });

  // =========================================================================
  // 2. JavaScript Todo App (Vite + Vanilla JS)
  // =========================================================================
  test('2. JavaScript Todo App: Full Lifecycle & Smoke Interaction Test', async () => {
    const config = repos.todoApp;
    await page.goto(`/workspace/${config.id}`, { waitUntil: 'networkidle' });

    // Explorer check
    await expect(page.locator(`text=${config.name}`).first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator('text=main.js').first()).toBeVisible();
    await page.locator('text=main.js').first().click();
    await page.waitForTimeout(800);

    // Dependencies
    await page.locator('button:has-text("Dependencies")').first().click();
    await expect(page.locator('[data-testid="manifest-path"]')).toContainText('package.json');
    await expect(page.locator('text=uuid').first()).toBeVisible();
    await expect(page.locator('text=^9.0.0').first()).toBeVisible();
    await expect(page.locator('text=vite').first()).toBeVisible();
    await page.screenshot({ path: '../docs/cross-framework-screenshots/02-todoapp-dependencies.png' });

    // Live Preview
    const previewPanel = page.locator('[data-testid="live-preview-panel"]');
    if (!(await previewPanel.isVisible())) {
      await page.locator('button[title*="Preview"]').first().click();
    }
    const badge = page.locator('[data-testid="framework-badge"]');
    await expect(badge).toContainText(/Vanilla/i);
    await expect(badge).not.toContainText(/React/i);

    // Run preview
    await page.locator('[data-testid="preview-run-btn"]').click();
    await expect(page.locator('[data-testid="preview-running-state"]')).toBeVisible({ timeout: 45000 });

    const iframe = page.locator('[data-testid="preview-iframe"]');
    await expect(iframe).toBeVisible();
    await page.waitForTimeout(3000);
    await page.screenshot({ path: '../docs/cross-framework-screenshots/02-todoapp-preview-running.png' });

    // Smoke test inside iframe: add a task
    const frame = page.frameLocator('[data-testid="preview-iframe"]');
    const todoInput = frame.locator('#new-todo-input');
    await expect(todoInput).toBeVisible({ timeout: 10000 });
    await todoInput.fill('Buy Groceries for GitView QA');
    await todoInput.press('Enter');

    // Verify task added to .todo-list
    const todoItem = frame.locator('.todo-list li', { hasText: 'Buy Groceries for GitView QA' });
    await expect(todoItem).toBeVisible({ timeout: 5000 });

    // Toggle complete
    const toggleBtn = todoItem.locator('.toggle');
    await toggleBtn.click();
    await expect(todoItem).toHaveClass(/completed/);

    await page.screenshot({ path: '../docs/cross-framework-screenshots/02-todoapp-smoke-interaction.png' });

    // Stop preview
    await page.locator('[data-testid="preview-stop-btn"]').click();
    await expect(page.locator('[data-testid="preview-stopped-state"], [data-testid="preview-idle-state"]')).toBeVisible({ timeout: 15000 });
  });

  // =========================================================================
  // 3. Scientific Calculator (Vite + Vanilla JS)
  // =========================================================================
  test('3. Scientific Calculator: Landing Page, Route Navigation & Arithmetic Execution', async () => {
    const config = repos.calculator;
    await page.goto(`/workspace/${config.id}`, { waitUntil: 'networkidle' });

    await expect(page.locator(`text=${config.name}`).first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator('text=calculator.html').first()).toBeVisible();

    // Dependencies
    await page.locator('button:has-text("Dependencies")').first().click();
    await expect(page.locator('[data-testid="manifest-path"]')).toContainText('package.json');
    await expect(page.locator('text=vite').first()).toBeVisible();
    await page.screenshot({ path: '../docs/cross-framework-screenshots/03-calculator-dependencies.png' });

    // Live Preview
    const previewPanel = page.locator('[data-testid="live-preview-panel"]');
    if (!(await previewPanel.isVisible())) {
      await page.locator('button[title*="Preview"]').first().click();
    }
    const badge = page.locator('[data-testid="framework-badge"]');
    await expect(badge).toContainText(/Vanilla/i);

    // Run preview
    await page.locator('[data-testid="preview-run-btn"]').click();
    await expect(page.locator('[data-testid="preview-running-state"]')).toBeVisible({ timeout: 45000 });

    const iframe = page.locator('[data-testid="preview-iframe"]');
    await expect(iframe).toBeVisible();
    await page.waitForTimeout(3000);
    await page.screenshot({ path: '../docs/cross-framework-screenshots/03-calculator-preview-running.png' });

    // Smoke test: Landing hero link to calculator.html
    const frame = page.frameLocator('[data-testid="preview-iframe"]');
    const launchBtn = frame.locator('a.cta-button, a:has-text("Launch Calculator")');
    await expect(launchBtn).toBeVisible({ timeout: 10000 });
    await launchBtn.click();

    // Wait for calculator page
    const currentOperand = frame.locator('#current-operand');
    await expect(currentOperand).toBeVisible({ timeout: 10000 });

    // Click 7 + 5 = 12
    const btn7 = frame.locator('button[data-number]:has-text("7"), button:has-text("7")').first();
    const btnPlus = frame.locator('button[data-operator="+"]');
    const btn5 = frame.locator('button[data-number]:has-text("5"), button:has-text("5")').first();
    const btnEquals = frame.locator('button[data-action="compute"], button.equal-btn');

    await btn7.click();
    await btnPlus.click();
    await btn5.click();
    await btnEquals.click();

    // Verify calculated result
    await expect(currentOperand).toHaveText('12');

    await page.screenshot({ path: '../docs/cross-framework-screenshots/03-calculator-smoke-interaction.png' });

    // Stop preview
    await page.locator('[data-testid="preview-stop-btn"]').click();
    await expect(page.locator('[data-testid="preview-stopped-state"], [data-testid="preview-idle-state"]')).toBeVisible({ timeout: 15000 });
  });

  // =========================================================================
  // 4. Vanilla JavaScript TodoList (Vite + TailwindCSS + Vanilla JS)
  // =========================================================================
  test('4. Vanilla JavaScript TodoList: Tailwind Setup & Task Creation Smoke Test', async () => {
    const config = repos.vanillaTodoList;
    await page.goto(`/workspace/${config.id}`, { waitUntil: 'networkidle' });

    await expect(page.locator(`text=${config.name}`).first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator('text=src').first()).toBeVisible();

    // Dependencies
    await page.locator('button:has-text("Dependencies")').first().click();
    await expect(page.locator('[data-testid="manifest-path"]')).toContainText('package.json');
    await expect(page.locator('text=tailwindcss').first()).toBeVisible();
    await expect(page.locator('text=sweetalert2').first()).toBeVisible();
    await page.screenshot({ path: '../docs/cross-framework-screenshots/04-todolist-dependencies.png' });

    // Live Preview
    const previewPanel = page.locator('[data-testid="live-preview-panel"]');
    if (!(await previewPanel.isVisible())) {
      await page.locator('button[title*="Preview"]').first().click();
    }
    const badge = page.locator('[data-testid="framework-badge"]');
    await expect(badge).toContainText(/Vanilla/i);

    // Run preview
    await page.locator('[data-testid="preview-run-btn"]').click();
    await expect(page.locator('[data-testid="preview-running-state"]')).toBeVisible({ timeout: 45000 });

    const iframe = page.locator('[data-testid="preview-iframe"]');
    await expect(iframe).toBeVisible();
    await page.waitForTimeout(3000);
    await page.screenshot({ path: '../docs/cross-framework-screenshots/04-todolist-preview-running.png' });

    // Smoke test: Input task
    const frame = page.frameLocator('[data-testid="preview-iframe"]');
    const taskInput = frame.locator('#todoTask');
    await expect(taskInput).toBeVisible({ timeout: 10000 });
    await taskInput.fill('Cross-Framework QA Verified');

    await page.screenshot({ path: '../docs/cross-framework-screenshots/04-todolist-smoke-interaction.png' });

    // Stop preview
    await page.locator('[data-testid="preview-stop-btn"]').click();
    await expect(page.locator('[data-testid="preview-stopped-state"], [data-testid="preview-idle-state"]')).toBeVisible({ timeout: 15000 });
  });

  // =========================================================================
  // 5. AI Tic-Tac-Toe Website (Static HTML/CSS/JS)
  // =========================================================================
  test('5. AI Tic-Tac-Toe: Static Detection, No-Manifest State & Interactive Gameplay', async () => {
    const config = repos.ticTacToe;
    await page.goto(`/workspace/${config.id}`, { waitUntil: 'networkidle' });

    await expect(page.locator(`text=${config.name}`).first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator('text=index.html').first()).toBeVisible();
    await expect(page.locator('text=index.js').first()).toBeVisible();

    // Monaco code view
    await page.locator('text=index.js').first().click();
    await page.waitForTimeout(800);
    await expect(page.locator('.monaco-editor')).toBeVisible();

    // Dependencies tab must display intentional "No Dependencies Manifest" empty state
    await page.locator('button:has-text("Dependencies")').first().click();
    const noManifest = page.locator('[data-testid="no-manifest-state"]');
    await expect(noManifest).toBeVisible({ timeout: 10000 });
    await expect(noManifest).toContainText('No Dependencies Manifest');
    await page.screenshot({ path: '../docs/cross-framework-screenshots/05-tictactoe-no-manifest.png' });

    // Live Preview
    const previewPanel = page.locator('[data-testid="live-preview-panel"]');
    if (!(await previewPanel.isVisible())) {
      await page.locator('button[title*="Preview"]').first().click();
    }
    const badge = page.locator('[data-testid="framework-badge"]');
    await expect(badge).toContainText(/STATIC/i);
    await expect(badge).not.toContainText(/React/i);

    // Run preview (STATIC_RUNNER)
    await page.locator('[data-testid="preview-run-btn"]').click();
    await expect(page.locator('[data-testid="preview-running-state"]')).toBeVisible({ timeout: 20000 });

    const iframe = page.locator('[data-testid="preview-iframe"]');
    await expect(iframe).toBeVisible();
    await page.waitForTimeout(3000);
    await page.screenshot({ path: '../docs/cross-framework-screenshots/05-tictactoe-preview-running.png' });

    // Smoke test: click block_0
    const frame = page.frameLocator('[data-testid="preview-iframe"]');
    const block0 = frame.locator('#block_0');
    await expect(block0).toBeVisible({ timeout: 10000 });
    await block0.click();
    await page.waitForTimeout(800);

    // Verify cell filled
    await expect(block0).not.toBeEmpty();

    // Test reset button
    const resetBtn = frame.locator('button:has-text("RESET BOARD")');
    await expect(resetBtn).toBeVisible();
    await resetBtn.click();
    await page.waitForTimeout(500);
    await expect(block0).toHaveText('');

    await page.screenshot({ path: '../docs/cross-framework-screenshots/05-tictactoe-smoke-interaction.png' });

    // Stop preview
    await page.locator('[data-testid="preview-stop-btn"]').click();
    await expect(page.locator('[data-testid="preview-stopped-state"], [data-testid="preview-idle-state"]')).toBeVisible({ timeout: 15000 });
  });

  // =========================================================================
  // 6. Just Do It — ToDoList (Static HTML/CSS/JS)
  // =========================================================================
  test('6. Just Do It: Static Site Task Creation & Theme Switching Smoke Test', async () => {
    const config = repos.justDoIt;
    await page.goto(`/workspace/${config.id}`, { waitUntil: 'networkidle' });

    await expect(page.locator(`text=${config.name}`).first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator('text=index.html').first()).toBeVisible();

    // Dependencies tab must display intentional "No Dependencies Manifest" empty state
    await page.locator('button:has-text("Dependencies")').first().click();
    const noManifest = page.locator('[data-testid="no-manifest-state"]');
    await expect(noManifest).toBeVisible({ timeout: 10000 });
    await expect(noManifest).toContainText('No Dependencies Manifest');
    await page.screenshot({ path: '../docs/cross-framework-screenshots/06-justdoit-no-manifest.png' });

    // Live Preview
    const previewPanel = page.locator('[data-testid="live-preview-panel"]');
    if (!(await previewPanel.isVisible())) {
      await page.locator('button[title*="Preview"]').first().click();
    }
    const badge = page.locator('[data-testid="framework-badge"]');
    await expect(badge).toContainText(/STATIC/i);

    // Run preview (STATIC_RUNNER)
    await page.locator('[data-testid="preview-run-btn"]').click();
    await expect(page.locator('[data-testid="preview-running-state"]')).toBeVisible({ timeout: 20000 });

    const iframe = page.locator('[data-testid="preview-iframe"]');
    await expect(iframe).toBeVisible();
    await page.waitForTimeout(3000);
    await page.screenshot({ path: '../docs/cross-framework-screenshots/06-justdoit-preview-running.png' });

    // Smoke test: Add a task
    // Note: The app's JS dynamically renames input and button classes based on active theme (.standard-input)
    const frame = page.frameLocator('[data-testid="preview-iframe"]');
    const input = frame.locator('#form input');
    await expect(input).toBeVisible({ timeout: 10000 });
    await input.fill('Verify GitView Static Runner');

    const submitBtn = frame.locator('#form button');
    await submitBtn.click();
    await page.waitForTimeout(500);

    // Verify task element added to DOM inside iframe
    await expect(frame.locator('text=Verify GitView Static Runner').first()).toBeVisible({ timeout: 5000 });

    // Theme selector: click light theme and assert body class
    const lightTheme = frame.locator('.light-theme');
    if (await lightTheme.isVisible()) {
      await lightTheme.click();
      await page.waitForTimeout(500);
      await expect(frame.locator('body')).toHaveClass(/light/);
    }

    await page.screenshot({ path: '../docs/cross-framework-screenshots/06-justdoit-smoke-interaction.png' });

    // Stop preview
    await page.locator('[data-testid="preview-stop-btn"]').click();
    await expect(page.locator('[data-testid="preview-stopped-state"], [data-testid="preview-idle-state"]')).toBeVisible({ timeout: 15000 });
  });

  // =========================================================================
  // 7. Responsive Portfolio (Static HTML/CSS/JS)
  // =========================================================================
  test('7. Responsive Portfolio: Static Site Navigation, CSS & Responsive Viewport', async () => {
    const config = repos.portfolio;
    await page.goto(`/workspace/${config.id}`, { waitUntil: 'networkidle' });

    await expect(page.locator(`text=${config.name}`).first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator('text=index.html').first()).toBeVisible();

    // Dependencies
    await page.locator('button:has-text("Dependencies")').first().click();
    const noManifest = page.locator('[data-testid="no-manifest-state"]');
    await expect(noManifest).toBeVisible({ timeout: 10000 });
    await expect(noManifest).toContainText('No Dependencies Manifest');
    await page.screenshot({ path: '../docs/cross-framework-screenshots/07-portfolio-no-manifest.png' });

    // Live Preview
    const previewPanel = page.locator('[data-testid="live-preview-panel"]');
    if (!(await previewPanel.isVisible())) {
      await page.locator('button[title*="Preview"]').first().click();
    }
    const badge = page.locator('[data-testid="framework-badge"]');
    await expect(badge).toContainText(/STATIC/i);

    // Run preview (STATIC_RUNNER)
    await page.locator('[data-testid="preview-run-btn"]').click();
    await expect(page.locator('[data-testid="preview-running-state"]')).toBeVisible({ timeout: 20000 });

    const iframe = page.locator('[data-testid="preview-iframe"]');
    await expect(iframe).toBeVisible();
    await page.waitForTimeout(3000);
    await page.screenshot({ path: '../docs/cross-framework-screenshots/07-portfolio-preview-running.png' });

    // Smoke test: Responsive navigation
    const frame = page.frameLocator('[data-testid="preview-iframe"]');
    const homeSection = frame.locator('#home');
    const aboutSection = frame.locator('#about');
    await expect(homeSection).toBeVisible({ timeout: 10000 });

    const navToggle = frame.locator('#nav-toggle');
    if (await navToggle.isVisible()) {
      await navToggle.click();
      await page.waitForTimeout(400);
    }
    const aboutLink = frame.locator('a[href="#about"]').first();
    await aboutLink.click({ force: true });
    await page.waitForTimeout(800);
    await expect(aboutSection).toBeVisible();

    // Test mobile viewport switch
    await page.locator('[data-testid="viewport-mobile-btn"]').click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: '../docs/cross-framework-screenshots/07-portfolio-mobile-viewport.png' });

    // Switch back to desktop
    await page.locator('[data-testid="viewport-desktop-btn"]').click();
    await page.waitForTimeout(500);

    // Stop preview
    await page.locator('[data-testid="preview-stop-btn"]').click();
    await expect(page.locator('[data-testid="preview-stopped-state"], [data-testid="preview-idle-state"]')).toBeVisible({ timeout: 15000 });
  });
});

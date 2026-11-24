import { test, expect } from '@playwright/test';
import { signAccessToken } from '../../server/src/utils/tokens.js';
import { prisma } from '../../server/src/lib/prisma.js';

test.describe.serial('GitView Dependencies Tab & Dynamic Badge Acceptance Suite', () => {
  let context;
  let page;
  const userId = '36aeb54a-7e81-4d07-ace1-330ce5c12794';

  let staticRepo;
  let tictactoeRepo;
  let skynavRepo;
  let vanillaRepo;

  test.beforeAll(async ({ browser }) => {
    // Look up test repositories from database
    staticRepo = await prisma.repository.findFirst({
      where: { userId, fullName: 'Lautarocuello98/simple-games-website' },
    });
    tictactoeRepo = await prisma.repository.findFirst({
      where: { userId, fullName: 'Rasesh2005/AI-Tic-Tac-Toe-Website' },
    });
    skynavRepo = await prisma.repository.findFirst({
      where: { userId, fullName: 'Snehaashish777/SkyNav' },
    });
    vanillaRepo = await prisma.repository.findFirst({
      where: { userId, fullName: 'ReinssDev/TodoList-Apps---Vite-TailwindCSS---JavaScript-Vanilla-Native' },
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

  test.afterAll(async () => {
    await page?.close();
    await context?.close();
  });

  test('01. Static Repository (simple-games-website): Shows badge 0 and clean No Dependencies Manifest state', async () => {
    expect(staticRepo).toBeDefined();

    await page.goto(`/workspace?repo=${staticRepo.id}`);
    await page.waitForLoadState('networkidle');

    // 1. Verify workspace header dependency badge shows '0' (NEVER stale '18')
    const badge = page.locator('[data-testid="dependencies-count-badge"]');
    await expect(badge).toBeVisible({ timeout: 10000 });
    await expect(badge).toHaveText('0');
    expect(await badge.textContent()).not.toBe('18');

    // 2. Click Dependencies tab button
    const depsTab = page.locator('button:has-text("Dependencies")');
    await expect(depsTab).toBeVisible();
    await depsTab.click();

    // 3. Verify clean informational state (NOT an error state)
    const noManifestState = page.locator('[data-testid="no-manifest-state"]');
    await expect(noManifestState).toBeVisible({ timeout: 10000 });
    await expect(noManifestState).toContainText('No Dependencies Manifest');
    await expect(noManifestState).toContainText('This repository is a static web application and does not declare npm dependencies.');

    // 4. Verify absence of misleading GitHub error text
    await expect(page.locator('text=GitHub resource not found')).not.toBeVisible();
    await expect(page.locator('text=Re-inspect Manifest')).toBeVisible();
  });

  test('02. Static CDN Repository (AI-Tic-Tac-Toe-Website): Shows badge 0 and informative no-manifest view', async () => {
    expect(tictactoeRepo).toBeDefined();

    await page.goto(`/workspace?repo=${tictactoeRepo.id}`);
    await page.waitForLoadState('networkidle');

    // 1. Verify badge shows 0
    const badge = page.locator('[data-testid="dependencies-count-badge"]');
    await expect(badge).toBeVisible({ timeout: 10000 });
    await expect(badge).toHaveText('0');

    // 2. Open Dependencies tab
    await page.locator('button:has-text("Dependencies")').click();

    // 3. Verify informational state
    const noManifestState = page.locator('[data-testid="no-manifest-state"]');
    await expect(noManifestState).toBeVisible();
    await expect(noManifestState).toContainText('No Dependencies Manifest');
    await expect(noManifestState).toContainText('STATIC');
  });

  test('03. Nested Vite React Repository (SkyNav): Resolves nested project root, badge shows 14, parses packages', async () => {
    expect(skynavRepo).toBeDefined();

    await page.goto(`/workspace?repo=${skynavRepo.id}`);
    await page.waitForLoadState('networkidle');

    // 1. Verify badge dynamically updates to 14
    const badge = page.locator('[data-testid="dependencies-count-badge"]');
    await expect(badge).toBeVisible({ timeout: 10000 });
    await expect(badge).toHaveText('14');

    // 2. Open Dependencies tab
    await page.locator('button:has-text("Dependencies")').click();

    // 3. Verify manifest path resolves to nested vite-project/package.json
    const manifestPath = page.locator('[data-testid="manifest-path"]');
    await expect(manifestPath).toBeVisible({ timeout: 10000 });
    await expect(manifestPath).toContainText('vite-project/package.json');

    // 4. Verify React 19 packages appear
    await expect(page.locator('text=react').first()).toBeVisible();
    await expect(page.locator('text=react-dom').first()).toBeVisible();
    await expect(page.locator('text=tailwindcss').first()).toBeVisible();

    // 5. Category filter: DevDependencies
    const devBtn = page.locator('button:has-text("DevDependencies (9)")');
    await expect(devBtn).toBeVisible();
    await devBtn.click();
    await expect(page.locator('text=vite').first()).toBeVisible();

    // 6. Switch back to All tab and test search filter
    const allBtn = page.locator('button:has-text("All (14)")');
    await allBtn.click();
    const searchInput = page.locator('input[placeholder="Search packages..."]');
    await searchInput.fill('tailwindcss');
    await expect(page.locator('text=@tailwindcss/vite').first()).toBeVisible();
  });

  test('04. Vite Vanilla Repository (TodoList-Apps): Parses root package.json and updates badge to 4', async () => {
    expect(vanillaRepo).toBeDefined();

    await page.goto(`/workspace?repo=${vanillaRepo.id}`);
    await page.waitForLoadState('networkidle');

    // 1. Verify badge shows 4
    const badge = page.locator('[data-testid="dependencies-count-badge"]');
    await expect(badge).toBeVisible({ timeout: 10000 });
    await expect(badge).toHaveText('4');

    // 2. Open Dependencies tab
    await page.locator('button:has-text("Dependencies")').click();

    // 3. Verify root package.json path and packages
    const manifestPath = page.locator('[data-testid="manifest-path"]');
    await expect(manifestPath).toBeVisible();
    await expect(manifestPath).toContainText('package.json');
    await expect(page.locator('text=sweetalert2').first()).toBeVisible();
    await expect(page.locator('text=tailwindcss').first()).toBeVisible();
  });

  test('05. Repository Switching Dynamics: Badge immediately updates and never retains stale counts', async () => {
    // 1. Visit SkyNav (count = 14)
    await page.goto(`/workspace?repo=${skynavRepo.id}`);
    const badge = page.locator('[data-testid="dependencies-count-badge"]');
    await expect(badge).toHaveText('14', { timeout: 10000 });

    // 2. Switch directly to static simple-games-website (count must become 0, never 14 or 18)
    await page.goto(`/workspace?repo=${staticRepo.id}`);
    await expect(badge).toHaveText('0', { timeout: 10000 });

    // 3. Switch directly to vanilla TodoList-Apps (count must become 4)
    await page.goto(`/workspace?repo=${vanillaRepo.id}`);
    await expect(badge).toHaveText('4', { timeout: 10000 });
  });
});

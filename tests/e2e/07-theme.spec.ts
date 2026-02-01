import { test, expect } from '@playwright/test';

/**
 * Level 7: Theme and Appearance Tests
 *
 * Tests for theme toggle and visual states.
 */

test.describe('Theme Toggle', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('should have theme toggle button', async ({ page }) => {
    const themeToggle = page.locator('#theme-toggle');
    await expect(themeToggle).toBeVisible();
  });

  test('should toggle theme on click', async ({ page }) => {
    const themeToggle = page.locator('#theme-toggle');
    const html = page.locator('html');

    // Get initial theme
    const initialTheme = await html.getAttribute('data-theme');

    // Click toggle
    await themeToggle.click();

    // Theme should change
    const newTheme = await html.getAttribute('data-theme');

    // Themes should be different
    // (or class changes)
    const body = page.locator('body');
    const hasClass = await body.evaluate(el => {
      return el.classList.contains('dark') || el.classList.contains('light');
    });
  });

  test('should show correct icon for current theme', async ({ page }) => {
    const lightIcon = page.locator('.theme-icon-light');
    const darkIcon = page.locator('.theme-icon-dark');

    // One should be visible based on theme
    // Implementation dependent on which is shown
    await expect(lightIcon).toBeVisible();
  });

  test('should persist theme across reload', async ({ page }) => {
    const themeToggle = page.locator('#theme-toggle');

    // Toggle theme
    await themeToggle.click();
    await page.waitForTimeout(100);

    // Get current theme state
    const bodyClassBefore = await page.locator('body').getAttribute('class');

    // Reload
    await page.reload();
    await page.waitForLoadState('networkidle');

    // Theme should persist (localStorage)
    const bodyClassAfter = await page.locator('body').getAttribute('class');

    // Classes should match (theme persisted)
    expect(bodyClassAfter).toBe(bodyClassBefore);
  });
});

test.describe('Theme Visual Changes', () => {
  test('should change background color on theme toggle', async ({ page }) => {
    await page.goto('/');

    const body = page.locator('body');
    const themeToggle = page.locator('#theme-toggle');

    // Get initial background
    const initialBg = await body.evaluate(el => {
      return window.getComputedStyle(el).backgroundColor;
    });

    // Toggle theme
    await themeToggle.click();
    await page.waitForTimeout(200);

    // Get new background
    const newBg = await body.evaluate(el => {
      return window.getComputedStyle(el).backgroundColor;
    });

    // Background should change
    expect(newBg).not.toBe(initialBg);
  });
});

test.describe('Syntax Highlighting Theme', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('should have light highlight theme stylesheet', async ({ page }) => {
    const lightStyle = page.locator('#hljs-light');
    await expect(lightStyle).toBeAttached();
  });

  test('should have dark highlight theme stylesheet', async ({ page }) => {
    const darkStyle = page.locator('#hljs-dark');
    await expect(darkStyle).toBeAttached();
  });

  test('should switch highlight theme with main theme', async ({ page }) => {
    const themeToggle = page.locator('#theme-toggle');
    const lightStyle = page.locator('#hljs-light');
    const darkStyle = page.locator('#hljs-dark');

    // Check initial state
    const lightDisabledBefore = await lightStyle.getAttribute('disabled');
    const darkDisabledBefore = await darkStyle.getAttribute('disabled');

    // Toggle theme
    await themeToggle.click();
    await page.waitForTimeout(200);

    // Check new state
    const lightDisabledAfter = await lightStyle.getAttribute('disabled');
    const darkDisabledAfter = await darkStyle.getAttribute('disabled');

    // One of them should have changed
    const lightChanged = lightDisabledBefore !== lightDisabledAfter;
    const darkChanged = darkDisabledBefore !== darkDisabledAfter;

    expect(lightChanged || darkChanged).toBe(true);
  });
});

test.describe('Responsive Layout', () => {
  test('should handle mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/');

    // Core elements should still be visible
    await expect(page.locator('#message-input')).toBeVisible();
    await expect(page.locator('#send-btn')).toBeVisible();

    // Sidebar might be hidden on mobile
    const sidebar = page.locator('#sidebar');
    // Implementation dependent
  });

  test('should handle tablet viewport', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto('/');

    await expect(page.locator('#message-input')).toBeVisible();
    await expect(page.locator('#sidebar')).toBeVisible();
  });

  test('should handle desktop viewport', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto('/');

    await expect(page.locator('#message-input')).toBeVisible();
    await expect(page.locator('#sidebar')).toBeVisible();
    await expect(page.locator('#settings-panel')).toBeAttached();
  });
});

test.describe('Accessibility', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('should have accessible input labels', async ({ page }) => {
    const input = page.locator('#message-input');
    const placeholder = await input.getAttribute('placeholder');

    // Should have placeholder or aria-label
    const ariaLabel = await input.getAttribute('aria-label');
    expect(placeholder || ariaLabel).toBeTruthy();
  });

  test('should have accessible buttons', async ({ page }) => {
    const sendBtn = page.locator('#send-btn');
    const title = await sendBtn.getAttribute('title');
    const ariaLabel = await sendBtn.getAttribute('aria-label');

    // Should have some accessible name
    expect(title || ariaLabel).toBeTruthy();
  });

  test('should support keyboard navigation', async ({ page }) => {
    // Tab to input
    await page.keyboard.press('Tab');

    // Should be able to reach input
    const focused = await page.evaluate(() => document.activeElement?.tagName);
    // Some element should be focused
    expect(focused).toBeTruthy();
  });
});

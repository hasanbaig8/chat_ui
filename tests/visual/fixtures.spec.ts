import { test, expect } from '@playwright/test';

/**
 * Visual regression tests for UI fixtures.
 *
 * These tests capture screenshots of various message states
 * and compare them against baseline images.
 *
 * Run with:
 *   npm run test:visual           # Compare against baselines
 *   npm run test:visual:update    # Update baseline screenshots
 */

test.describe('Message Fixtures', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dev/ui');
    // Wait for the fixture harness to load
    await expect(page.locator('.harness-header')).toBeVisible();
  });

  test('user message - simple', async ({ page }) => {
    const fixture = page.locator('[data-testid="fixture-user-simple"]');
    await expect(fixture).toHaveScreenshot('user-message-simple.png');
  });

  test('user message - versioned', async ({ page }) => {
    const fixture = page.locator('[data-testid="fixture-user-versioned"]');
    await expect(fixture).toHaveScreenshot('user-message-versioned.png');
  });

  test('user message - long text', async ({ page }) => {
    const fixture = page.locator('[data-testid="fixture-user-long"]');
    await expect(fixture).toHaveScreenshot('user-message-long.png');
  });

  test('assistant message - simple', async ({ page }) => {
    const fixture = page.locator('[data-testid="fixture-assistant-simple"]');
    await expect(fixture).toHaveScreenshot('assistant-message-simple.png');
  });

  test('assistant message - markdown', async ({ page }) => {
    const fixture = page.locator('[data-testid="fixture-assistant-markdown"]');
    await expect(fixture).toHaveScreenshot('assistant-message-markdown.png');
  });

  test('assistant message - with thinking', async ({ page }) => {
    const fixture = page.locator('[data-testid="fixture-assistant-thinking"]');
    await expect(fixture).toHaveScreenshot('assistant-message-thinking.png');
  });

  test('assistant message - streaming state', async ({ page }) => {
    const fixture = page.locator('[data-testid="fixture-assistant-streaming"]');
    await expect(fixture).toHaveScreenshot('assistant-message-streaming.png');
  });

  test('tool use block', async ({ page }) => {
    const fixture = page.locator('[data-testid="fixture-tool-use"]');
    await expect(fixture).toHaveScreenshot('tool-use-block.png');
  });

  test('tool result block', async ({ page }) => {
    const fixture = page.locator('[data-testid="fixture-tool-result"]');
    await expect(fixture).toHaveScreenshot('tool-result-block.png');
  });

  test('web search results', async ({ page }) => {
    const fixture = page.locator('[data-testid="fixture-web-search"]');
    await expect(fixture).toHaveScreenshot('web-search-results.png');
  });

  test('surface content block', async ({ page }) => {
    const fixture = page.locator('[data-testid="fixture-surface-content"]');
    await expect(fixture).toHaveScreenshot('surface-content-block.png');
  });
});

test.describe('Full Page Snapshots', () => {
  test('dev ui harness - full page', async ({ page }) => {
    await page.goto('/dev/ui');
    await expect(page.locator('.harness-header')).toBeVisible();
    await expect(page).toHaveScreenshot('dev-ui-full-page.png', {
      fullPage: true,
    });
  });

  test('main chat interface - initial state', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#chat-input')).toBeVisible();
    await expect(page).toHaveScreenshot('main-chat-initial.png');
  });
});

test.describe('Thinking Section Interaction', () => {
  test('thinking section - toggle expand/collapse', async ({ page }) => {
    await page.goto('/dev/ui');

    const fixture = page.locator('[data-testid="fixture-assistant-thinking"]');
    const thinkingSection = fixture.locator('.thinking-section');
    const thinkingHeader = fixture.locator('.thinking-header');

    // Initially collapsed
    await expect(thinkingSection).toHaveClass(/collapsed/);

    // Click to expand
    await thinkingHeader.click();
    await expect(thinkingSection).not.toHaveClass(/collapsed/);
    await expect(fixture).toHaveScreenshot('thinking-section-expanded.png');

    // Click to collapse
    await thinkingHeader.click();
    await expect(thinkingSection).toHaveClass(/collapsed/);
  });
});

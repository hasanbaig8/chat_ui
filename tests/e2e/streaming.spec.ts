import { test, expect } from '@playwright/test';

/**
 * E2E tests for streaming functionality.
 *
 * Best run with MOCK_LLM=1 for deterministic behavior:
 *   MOCK_LLM=1 npm run test:e2e
 */

test.describe('Stream Testing via Dev UI', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dev/ui');
    await expect(page.locator('.harness-header')).toBeVisible();
  });

  test('should stream normal chat response', async ({ page }) => {
    const output = page.locator('#stream-output');
    const streamButton = page.locator('#btn-normal-stream');

    await streamButton.click();

    // Wait for streaming to complete (look for "done" event)
    await expect(output).toContainText('"type":"done"', { timeout: 30000 });

    // Should have text events
    await expect(output).toContainText('"type":"text"');
  });

  test('should stream with thinking events', async ({ page }) => {
    const output = page.locator('#stream-output');
    const streamButton = page.locator('#btn-normal-thinking');

    await streamButton.click();

    // Wait for streaming to complete
    await expect(output).toContainText('"type":"done"', { timeout: 30000 });

    // Should have thinking events
    await expect(output).toContainText('"type":"thinking"');
    await expect(output).toContainText('"type":"text"');
  });

  test('should stream with web search events', async ({ page }) => {
    const output = page.locator('#stream-output');
    const streamButton = page.locator('#btn-normal-websearch');

    await streamButton.click();

    // Wait for streaming to complete
    await expect(output).toContainText('"type":"done"', { timeout: 30000 });

    // Should have web search events
    await expect(output).toContainText('"type":"web_search_start"');
    await expect(output).toContainText('"type":"web_search_result"');
    await expect(output).toContainText('"type":"text"');
  });

  test('should stream agent response', async ({ page }) => {
    const output = page.locator('#stream-output');
    const streamButton = page.locator('#btn-agent-stream');

    await streamButton.click();

    // Wait for streaming to complete
    await expect(output).toContainText('"type":"done"', { timeout: 30000 });

    // Should have agent-specific events (when MOCK_LLM=1)
    await expect(output).toContainText('"type":"text"');
    // In mock mode, these will be present:
    // await expect(output).toContainText('"type":"tool_use"');
    // await expect(output).toContainText('"type":"session_id"');
  });

  test('should clear output', async ({ page }) => {
    const output = page.locator('#stream-output');
    const clearButton = page.locator('#btn-clear');

    // First, stream something
    await page.locator('#btn-normal-stream').click();
    await expect(output).toContainText('"type":"done"', { timeout: 30000 });

    // Clear output
    await clearButton.click();

    // Output should be empty
    await expect(output).toBeEmpty();
  });
});

test.describe('Mock Mode Detection', () => {
  test('should show mock mode status', async ({ page }) => {
    await page.goto('/dev/ui');

    const statusBadge = page.locator('.status-badge');
    await expect(statusBadge).toBeVisible();

    // Check if mock or live mode
    const text = await statusBadge.textContent();
    expect(['MOCK MODE', 'LIVE MODE']).toContain(text?.trim());
  });

  test('should return mock mode in dev status endpoint', async ({ page }) => {
    const response = await page.request.get('/dev/status');
    expect(response.ok()).toBeTruthy();

    const data = await response.json();
    expect(data).toHaveProperty('mock_mode');
    expect(typeof data.mock_mode).toBe('boolean');
  });
});

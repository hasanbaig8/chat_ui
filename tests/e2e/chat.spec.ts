import { test, expect } from '@playwright/test';

/**
 * Core Chat Tests
 *
 * Essential happy-path tests for the chat interface.
 * Run with MOCK_LLM=1 for deterministic streaming:
 *   MOCK_LLM=1 npm run test:e2e
 */

test.describe('Chat Interface - Happy Path', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#message-input')).toBeVisible();
  });

  test('should load the app', async ({ page }) => {
    await expect(page).toHaveTitle(/Claude/i);
    await expect(page.locator('#welcome-message')).toBeVisible();
  });

  test('should send message and receive response', async ({ page }) => {
    const input = page.locator('#message-input');
    const sendBtn = page.locator('#send-btn');

    // Type and send
    await input.fill('Hello, Claude!');
    await sendBtn.click();

    // Input cleared
    await expect(input).toHaveValue('');

    // User message appears
    await expect(page.locator('.message.user')).toBeVisible();
    await expect(page.locator('.message.user')).toContainText('Hello, Claude!');

    // Assistant responds
    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30000 });
  });

  test('should hide welcome message after sending', async ({ page }) => {
    await expect(page.locator('#welcome-message')).toBeVisible();

    await page.locator('#message-input').fill('Test');
    await page.locator('#send-btn').click();

    await expect(page.locator('#welcome-message')).toBeHidden();
  });

  test('should show message actions', async ({ page }) => {
    await page.locator('#message-input').fill('Test');
    await page.locator('#send-btn').click();
    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30000 });

    // User message actions
    await expect(page.locator('.message.user .copy-btn')).toBeVisible();
    await expect(page.locator('.message.user .edit-btn')).toBeVisible();

    // Assistant message actions
    await expect(page.locator('.message.assistant .copy-btn')).toBeVisible();
    await expect(page.locator('.message.assistant .retry-btn')).toBeVisible();
  });

  test('should create new conversation', async ({ page }) => {
    // Send a message first
    await page.locator('#message-input').fill('Hello');
    await page.locator('#send-btn').click();
    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30000 });

    // Create new chat
    await page.locator('#new-chat-btn').click();

    // Should show welcome (fresh conversation)
    await expect(page.locator('#welcome-message')).toBeVisible();
  });

  test('should show conversation in sidebar', async ({ page }) => {
    await page.locator('#message-input').fill('Hello');
    await page.locator('#send-btn').click();
    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30000 });

    // Conversation should appear in sidebar
    await expect(page.locator('.conversation-item')).toBeVisible({ timeout: 5000 });
  });
});

test.describe('Model Selection', () => {
  test('should have model selector with options', async ({ page }) => {
    await page.goto('/');

    const modelSelect = page.locator('#model-select');
    await expect(modelSelect).toBeVisible();

    const options = modelSelect.locator('option');
    await expect(options).not.toHaveCount(0);
  });
});

test.describe('Settings Panel', () => {
  test('should toggle settings panel', async ({ page }) => {
    await page.goto('/');

    const settingsBtn = page.locator('#default-settings-toggle');
    const settingsPanel = page.locator('#settings-panel');

    // Open
    await settingsBtn.click();
    await expect(settingsPanel).toHaveClass(/open/);

    // Close
    await settingsBtn.click();
    await expect(settingsPanel).not.toHaveClass(/open/);
  });

  test('should have thinking toggle', async ({ page }) => {
    await page.goto('/');
    await page.locator('#default-settings-toggle').click();

    await expect(page.locator('#thinking-toggle')).toBeVisible();
  });
});

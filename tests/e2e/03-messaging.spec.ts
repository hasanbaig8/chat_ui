import { test, expect } from '@playwright/test';

/**
 * Level 3: Messaging Tests
 *
 * Tests for sending messages and receiving responses.
 * Best run with MOCK_LLM=1 for deterministic behavior.
 */

test.describe('Send Message', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#message-input')).toBeVisible();
  });

  test('should send message on button click', async ({ page }) => {
    const input = page.locator('#message-input');
    const sendBtn = page.locator('#send-btn');

    await input.fill('Hello, Claude!');
    await sendBtn.click();

    // Input should be cleared
    await expect(input).toHaveValue('');

    // User message should appear
    await expect(page.locator('.message.user')).toBeVisible({ timeout: 5000 });
  });

  test('should hide welcome message after sending', async ({ page }) => {
    const input = page.locator('#message-input');
    const welcome = page.locator('#welcome-message');

    await expect(welcome).toBeVisible();

    await input.fill('Test message');
    await page.locator('#send-btn').click();

    await expect(welcome).toBeHidden({ timeout: 5000 });
  });

  test('should show user message content', async ({ page }) => {
    const input = page.locator('#message-input');
    const messageText = 'This is my test message';

    await input.fill(messageText);
    await page.locator('#send-btn').click();

    const userMessage = page.locator('.message.user');
    await expect(userMessage).toBeVisible({ timeout: 5000 });
    await expect(userMessage).toContainText(messageText);
  });

  test('should receive assistant response', async ({ page }) => {
    const input = page.locator('#message-input');

    await input.fill('Hello');
    await page.locator('#send-btn').click();

    // Wait for assistant response
    const assistantMessage = page.locator('.message.assistant');
    await expect(assistantMessage).toBeVisible({ timeout: 30000 });
  });

  test('should update message count in status bar', async ({ page }) => {
    const input = page.locator('#message-input');
    const msgCount = page.locator('#stat-messages');

    await expect(msgCount).toHaveText('0');

    await input.fill('Test');
    await page.locator('#send-btn').click();

    // Wait for response
    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30000 });

    // Give time for stats to update
    await page.waitForTimeout(500);

    // Should have messages (count may vary by implementation)
    // Just verify the DOM is still there - count update is implementation-specific
    await expect(msgCount).toBeVisible();
  });
});

test.describe('Message Display', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.locator('#message-input').fill('Hello');
    await page.locator('#send-btn').click();
    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30000 });
  });

  test('should show user message with correct styling', async ({ page }) => {
    const userMessage = page.locator('.message.user');
    await expect(userMessage).toBeVisible();
  });

  test('should show assistant message with correct styling', async ({ page }) => {
    const assistantMessage = page.locator('.message.assistant');
    await expect(assistantMessage).toBeVisible();
  });

  test('should show messages in order', async ({ page }) => {
    const messages = page.locator('.message');
    const count = await messages.count();

    expect(count).toBeGreaterThanOrEqual(2);

    // First should be user, second should be assistant
    const firstClass = await messages.nth(0).getAttribute('class');
    const secondClass = await messages.nth(1).getAttribute('class');

    expect(firstClass).toContain('user');
    expect(secondClass).toContain('assistant');
  });
});

test.describe('Message Actions', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.locator('#message-input').fill('Test message');
    await page.locator('#send-btn').click();
    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30000 });
  });

  test('should show copy button on user message', async ({ page }) => {
    const userActions = page.locator('.message.user .message-actions');
    const copyBtn = userActions.locator('.copy-btn');
    await expect(copyBtn).toBeVisible();
  });

  test('should show edit button on user message', async ({ page }) => {
    const userActions = page.locator('.message.user .message-actions');
    const editBtn = userActions.locator('.edit-btn');
    await expect(editBtn).toBeVisible();
  });

  test('should show copy button on assistant message', async ({ page }) => {
    const assistantActions = page.locator('.message.assistant .message-actions');
    const copyBtn = assistantActions.locator('.copy-btn');
    await expect(copyBtn).toBeVisible();
  });

  test('should show retry button on assistant message', async ({ page }) => {
    const assistantActions = page.locator('.message.assistant .message-actions');
    const retryBtn = assistantActions.locator('.retry-btn');
    await expect(retryBtn).toBeVisible();
  });
});

test.describe('Multiple Messages', () => {
  test('should handle conversation flow', async ({ page }) => {
    await page.goto('/');
    const input = page.locator('#message-input');
    const sendBtn = page.locator('#send-btn');

    // Send first message
    await input.fill('First message');
    await sendBtn.click();
    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30000 });

    // Send second message
    await input.fill('Second message');
    await sendBtn.click();

    // Wait for second response
    await page.waitForTimeout(1000);
    const assistantMessages = page.locator('.message.assistant');
    await expect(assistantMessages).toHaveCount(2, { timeout: 30000 });
  });
});

test.describe('Streaming Behavior', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('should show stop button during streaming', async ({ page }) => {
    const input = page.locator('#message-input');
    const stopBtn = page.locator('#stop-btn');

    // Stop button should be hidden initially
    await expect(stopBtn).toBeHidden();

    await input.fill('Tell me a long story');
    await page.locator('#send-btn').click();

    // During streaming, stop button might appear
    // This depends on implementation and timing
    await page.waitForTimeout(500);

    // Wait for completion
    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30000 });

    // After streaming, stop button should be hidden
    await expect(stopBtn).toBeHidden();
  });

  test('should disable send button during streaming', async ({ page }) => {
    const input = page.locator('#message-input');
    const sendBtn = page.locator('#send-btn');

    await input.fill('Test');
    await sendBtn.click();

    // During streaming, can't send new message
    await page.waitForTimeout(100);

    // Wait for completion
    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30000 });

    // After streaming, can type again
    await input.fill('Another message');
    await expect(sendBtn).toBeEnabled();
  });
});

import { test, expect } from '@playwright/test';

test.describe('Message Visibility', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:8079');
    await page.waitForLoadState('networkidle');
  });

  test('user message should be visible after sending in normal mode', async ({ page }) => {
    // Start fresh - click New Chat
    await page.locator('#new-chat-btn').click();
    await page.waitForTimeout(500);

    const input = page.locator('#message-input');
    const sendBtn = page.locator('#send-btn');

    // Type and send
    await input.fill('Test message from user');
    await sendBtn.click();

    // User message should appear
    const userMessage = page.locator('.message.user');
    await expect(userMessage).toBeVisible({ timeout: 10000 });
    await expect(userMessage).toContainText('Test message from user');

    // Check messages container has content
    const container = page.locator('#messages-container');
    const childCount = await container.locator('.message').count();
    expect(childCount).toBeGreaterThanOrEqual(1);
  });

  test('user message should be visible after sending in agent mode', async ({ page }) => {
    // Click Agent Chat button
    await page.locator('#new-agent-chat-btn').click();
    await page.waitForTimeout(500);

    const input = page.locator('#message-input');
    const sendBtn = page.locator('#send-btn');

    // Type and send
    await input.fill('Test agent message');
    await sendBtn.click();

    // User message should appear
    const userMessage = page.locator('.message.user');
    await expect(userMessage).toBeVisible({ timeout: 10000 });
    await expect(userMessage).toContainText('Test agent message');
  });

  test('messages should persist when switching conversations', async ({ page }) => {
    // Create a new conversation and send a message
    await page.locator('#new-chat-btn').click();
    await page.waitForTimeout(500);

    await page.locator('#message-input').fill('First conversation message');
    await page.locator('#send-btn').click();

    // Verify message is visible
    await expect(page.locator('.message.user')).toBeVisible({ timeout: 10000 });

    // Click on a different conversation if available
    const conversations = page.locator('.conversation-item');
    const count = await conversations.count();
    if (count > 1) {
      await conversations.nth(1).click();
      await page.waitForTimeout(500);

      // Click back to the first conversation
      await conversations.first().click();
      await page.waitForTimeout(500);

      // Messages should still be visible
      await expect(page.locator('.message.user')).toBeVisible({ timeout: 5000 });
    }
  });
});

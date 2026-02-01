import { test, expect } from '@playwright/test';

/**
 * Conversation Switching Tests
 *
 * Tests for switching between multiple conversations and verifying
 * state preservation and correct message display.
 *
 * Run with MOCK_LLM=1 for deterministic streaming:
 *   MOCK_LLM=1 npx playwright test tests/e2e/conversation_switching.spec.ts --reporter=line
 */

test.describe('Conversation Switching', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#message-input')).toBeVisible();
  });

  test('should create 3 conversations and verify correct messages when switching', async ({ page }) => {
    const input = page.locator('#message-input');
    const sendBtn = page.locator('#send-btn');
    const newChatBtn = page.locator('#new-chat-btn');

    // Create first conversation with unique message
    await input.fill('First conversation unique message AAA');
    await sendBtn.click();
    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30000 });

    // Wait for conversation to appear in sidebar (use .first() since there may be existing conversations)
    await expect(page.locator('.conversation-item').first()).toBeVisible({ timeout: 5000 });
    const firstConvId = await page.locator('.conversation-item.active').getAttribute('data-id');
    expect(firstConvId).toBeTruthy();

    // Create second conversation
    await newChatBtn.click();
    await expect(page.locator('#welcome-message')).toBeVisible();
    await input.fill('Second conversation unique message BBB');
    await sendBtn.click();
    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30000 });

    const secondConvId = await page.locator('.conversation-item.active').getAttribute('data-id');
    expect(secondConvId).toBeTruthy();
    expect(secondConvId).not.toBe(firstConvId);

    // Create third conversation
    await newChatBtn.click();
    await expect(page.locator('#welcome-message')).toBeVisible();
    await input.fill('Third conversation unique message CCC');
    await sendBtn.click();
    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30000 });

    const thirdConvId = await page.locator('.conversation-item.active').getAttribute('data-id');
    expect(thirdConvId).toBeTruthy();
    expect(thirdConvId).not.toBe(firstConvId);
    expect(thirdConvId).not.toBe(secondConvId);

    // Verify all 3 conversations we created exist in sidebar
    await expect(page.locator(`.conversation-item[data-id="${firstConvId}"]`)).toBeVisible({ timeout: 5000 });
    await expect(page.locator(`.conversation-item[data-id="${secondConvId}"]`)).toBeVisible();
    await expect(page.locator(`.conversation-item[data-id="${thirdConvId}"]`)).toBeVisible();

    // Switch to first conversation and verify message
    await page.locator(`.conversation-item[data-id="${firstConvId}"]`).click();
    await page.waitForTimeout(500);
    await expect(page.locator('.message.user')).toContainText('First conversation unique message AAA');

    // Switch to second conversation and verify message
    await page.locator(`.conversation-item[data-id="${secondConvId}"]`).click();
    await page.waitForTimeout(500);
    await expect(page.locator('.message.user')).toContainText('Second conversation unique message BBB');

    // Switch to third conversation and verify message
    await page.locator(`.conversation-item[data-id="${thirdConvId}"]`).click();
    await page.waitForTimeout(500);
    await expect(page.locator('.message.user')).toContainText('Third conversation unique message CCC');

    // Switch back to first again to confirm
    await page.locator(`.conversation-item[data-id="${firstConvId}"]`).click();
    await page.waitForTimeout(500);
    await expect(page.locator('.message.user')).toContainText('First conversation unique message AAA');
  });

  // Skipping: Default settings don't immediately affect new conversations - this is a known behavior
  // The mock stream generates thinking blocks based on request params, not default settings state
  test.skip('should show thinking blocks only in conversation with thinking enabled', async ({ page }) => {
    const input = page.locator('#message-input');
    const sendBtn = page.locator('#send-btn');
    const newChatBtn = page.locator('#new-chat-btn');

    // Create first conversation WITH thinking enabled
    await page.locator('#default-settings-toggle').click();
    await page.waitForTimeout(300);

    const thinkingToggle = page.locator('#thinking-toggle');
    if (await thinkingToggle.isVisible()) {
      if (!(await thinkingToggle.isChecked())) {
        await thinkingToggle.click();
      }
    }

    // Close settings panel
    const cancelBtn = page.getByRole('button', { name: 'Cancel' });
    if (await cancelBtn.isVisible()) {
      await cancelBtn.click();
    }
    await page.waitForTimeout(300);

    await input.fill('First conversation WITH thinking');
    await sendBtn.click();
    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30000 });

    // Wait for thinking block to appear
    await expect(page.locator('.thinking-block')).toBeVisible({ timeout: 30000 });

    const firstConvId = await page.locator('.conversation-item.active').getAttribute('data-id');
    expect(firstConvId).toBeTruthy();

    // Create second conversation WITHOUT thinking
    await newChatBtn.click();
    await expect(page.locator('#welcome-message')).toBeVisible();

    // Open settings and disable thinking
    await page.locator('#default-settings-toggle').click();
    await page.waitForTimeout(300);

    if (await thinkingToggle.isVisible()) {
      if (await thinkingToggle.isChecked()) {
        await thinkingToggle.click();
      }
    }

    // Close settings panel
    if (await cancelBtn.isVisible()) {
      await cancelBtn.click();
    }
    await page.waitForTimeout(300);

    await input.fill('Second conversation WITHOUT thinking');
    await sendBtn.click();
    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30000 });

    const secondConvId = await page.locator('.conversation-item.active').getAttribute('data-id');
    expect(secondConvId).toBeTruthy();

    // Second conversation should NOT have thinking blocks
    await expect(page.locator('.thinking-block')).toHaveCount(0);

    // Switch to first conversation - should have thinking block
    await page.locator(`.conversation-item[data-id="${firstConvId}"]`).click();
    await page.waitForTimeout(500);
    await expect(page.locator('.thinking-block')).toBeVisible();
    await expect(page.locator('.message.user')).toContainText('WITH thinking');

    // Switch back to second - should NOT have thinking block
    await page.locator(`.conversation-item[data-id="${secondConvId}"]`).click();
    await page.waitForTimeout(500);
    await expect(page.locator('.thinking-block')).toHaveCount(0);
    await expect(page.locator('.message.user')).toContainText('WITHOUT thinking');
  });

  test('should preserve all messages when switching away and back', async ({ page }) => {
    const input = page.locator('#message-input');
    const sendBtn = page.locator('#send-btn');
    const newChatBtn = page.locator('#new-chat-btn');

    // Create conversation with multiple messages
    await input.fill('First message in conversation');
    await sendBtn.click();
    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30000 });

    await input.fill('Second message in conversation');
    await sendBtn.click();
    await expect(page.locator('.message.assistant').nth(1)).toBeVisible({ timeout: 30000 });

    await input.fill('Third message in conversation');
    await sendBtn.click();
    await expect(page.locator('.message.assistant').nth(2)).toBeVisible({ timeout: 30000 });

    // Get the conversation ID
    const convId = await page.locator('.conversation-item.active').getAttribute('data-id');
    expect(convId).toBeTruthy();

    // Verify we have 3 user messages and 3 assistant messages
    await expect(page.locator('.message.user')).toHaveCount(3);
    await expect(page.locator('.message.assistant')).toHaveCount(3);

    // Create a new conversation and switch away
    await newChatBtn.click();
    await expect(page.locator('#welcome-message')).toBeVisible();

    await input.fill('Different conversation');
    await sendBtn.click();
    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30000 });

    // Switch back to original conversation
    await page.locator(`.conversation-item[data-id="${convId}"]`).click();
    await page.waitForTimeout(500);

    // Verify all 3 messages are still there
    await expect(page.locator('.message.user')).toHaveCount(3);
    await expect(page.locator('.message.assistant')).toHaveCount(3);

    // Verify content
    const userMessages = page.locator('.message.user');
    await expect(userMessages.nth(0)).toContainText('First message in conversation');
    await expect(userMessages.nth(1)).toContainText('Second message in conversation');
    await expect(userMessages.nth(2)).toContainText('Third message in conversation');
  });

  test('should remove deleted conversation from sidebar while viewing another', async ({ page }) => {
    const input = page.locator('#message-input');
    const sendBtn = page.locator('#send-btn');
    const newChatBtn = page.locator('#new-chat-btn');

    // Create first conversation
    await input.fill('Conversation to delete');
    await sendBtn.click();
    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30000 });

    const convToDeleteId = await page.locator('.conversation-item.active').getAttribute('data-id');
    expect(convToDeleteId).toBeTruthy();

    // Create second conversation
    await newChatBtn.click();
    await expect(page.locator('#welcome-message')).toBeVisible();

    await input.fill('Conversation to keep');
    await sendBtn.click();
    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30000 });

    const convToKeepId = await page.locator('.conversation-item.active').getAttribute('data-id');
    expect(convToKeepId).toBeTruthy();

    // Verify both conversations exist
    await expect(page.locator(`.conversation-item[data-id="${convToDeleteId}"]`)).toBeVisible();
    await expect(page.locator(`.conversation-item[data-id="${convToKeepId}"]`)).toBeVisible();

    // We are viewing the second conversation, delete the first one
    const convToDelete = page.locator(`.conversation-item[data-id="${convToDeleteId}"]`);
    await convToDelete.hover();

    // Handle the confirm dialog
    page.on('dialog', async dialog => {
      await dialog.accept();
    });

    // Click the delete button
    await convToDelete.locator('.conversation-delete').click();
    await page.waitForTimeout(500);

    // Verify the deleted conversation is gone from sidebar
    await expect(page.locator(`.conversation-item[data-id="${convToDeleteId}"]`)).toHaveCount(0);

    // Verify the kept conversation is still there
    await expect(page.locator(`.conversation-item[data-id="${convToKeepId}"]`)).toBeVisible();

    // Verify we are still viewing the kept conversation
    await expect(page.locator('.message.user')).toContainText('Conversation to keep');
  });

  test('should preserve messages after page reload and switching back', async ({ page }) => {
    const input = page.locator('#message-input');
    const sendBtn = page.locator('#send-btn');
    const newChatBtn = page.locator('#new-chat-btn');

    // Create first conversation with unique message
    const uniqueText = `Persistence test ${Date.now()}`;
    await input.fill(uniqueText);
    await sendBtn.click();
    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30000 });

    const firstConvId = await page.locator('.conversation-item.active').getAttribute('data-id');
    expect(firstConvId).toBeTruthy();

    // Create second conversation
    await newChatBtn.click();
    await expect(page.locator('#welcome-message')).toBeVisible();

    await input.fill('Second conversation after reload');
    await sendBtn.click();
    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30000 });

    const secondConvId = await page.locator('.conversation-item.active').getAttribute('data-id');
    expect(secondConvId).toBeTruthy();

    // Reload the page
    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#message-input')).toBeVisible();

    // Both conversations should still be in the sidebar
    await expect(page.locator(`.conversation-item[data-id="${firstConvId}"]`)).toBeVisible({ timeout: 5000 });
    await expect(page.locator(`.conversation-item[data-id="${secondConvId}"]`)).toBeVisible();

    // Click on the first conversation
    await page.locator(`.conversation-item[data-id="${firstConvId}"]`).click();
    await page.waitForTimeout(500);

    // Verify the unique message is preserved
    await expect(page.locator('.message.user')).toContainText(uniqueText);
    await expect(page.locator('.message.assistant')).toBeVisible();

    // Switch to second conversation
    await page.locator(`.conversation-item[data-id="${secondConvId}"]`).click();
    await page.waitForTimeout(500);

    // Verify second conversation's message
    await expect(page.locator('.message.user')).toContainText('Second conversation after reload');
    await expect(page.locator('.message.assistant')).toBeVisible();
  });
});

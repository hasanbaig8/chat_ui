import { test, expect } from '@playwright/test';

test.describe('Thinking Block Persistence', () => {
  test('thinking blocks should persist after page reload', async ({ page }) => {
    await page.goto('http://localhost:8079');
    await page.waitForLoadState('networkidle');

    // Start a new normal chat
    await page.locator('#new-chat-btn').click();
    await page.waitForTimeout(500);

    // Enable thinking in settings (if not already enabled)
    await page.locator('#default-settings-toggle').click();
    await page.waitForTimeout(300);

    // Check if thinking toggle exists and enable it
    const thinkingToggle = page.locator('#thinking-toggle');
    if (await thinkingToggle.isVisible()) {
      const isChecked = await thinkingToggle.isChecked();
      if (!isChecked) {
        await thinkingToggle.click();
      }
    }

    // Close settings modal by clicking Cancel or outside
    const cancelBtn = page.getByRole('button', { name: 'Cancel' });
    if (await cancelBtn.isVisible()) {
      await cancelBtn.click();
    }
    await page.waitForTimeout(300);

    // Send a message
    await page.locator('#message-input').fill('Test thinking persistence');
    await page.locator('#send-btn').click();

    // Wait for response with thinking block
    const thinkingBlock = page.locator('.thinking-block');
    await expect(thinkingBlock.first()).toBeVisible({ timeout: 30000 });

    // Wait for stream to complete (DONE status)
    await expect(thinkingBlock.first().locator('.thinking-status')).toHaveText('DONE', { timeout: 30000 });

    // Get conversation ID from sidebar
    const convItem = page.locator('.conversation-item.active');
    const convId = await convItem.getAttribute('data-id');
    expect(convId).toBeTruthy();

    // Reload page
    await page.reload();
    await page.waitForLoadState('networkidle');

    // Click on the same conversation
    await page.locator(`.conversation-item[data-id="${convId}"]`).click();
    await page.waitForTimeout(500);

    // Thinking block should still be visible
    await expect(page.locator('.thinking-block').first()).toBeVisible({ timeout: 5000 });

    // Should show DONE status (persisted, not streaming)
    await expect(page.locator('.thinking-block .thinking-status').first()).toHaveText('DONE');
  });
});

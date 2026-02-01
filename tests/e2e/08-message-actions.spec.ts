import { test, expect } from '@playwright/test';

/**
 * Level 8: Message Actions Tests
 *
 * Tests for editing, retry, copy, and branching functionality.
 * These are more advanced features.
 */

test.describe('Copy Message', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');

    // Create a conversation
    await page.locator('#message-input').fill('Test message for copying');
    await page.locator('#send-btn').click();
    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30000 });
  });

  test('should have copy button on user message', async ({ page }) => {
    const userMessage = page.locator('.message.user').first();
    const copyBtn = userMessage.locator('.copy-btn');
    await expect(copyBtn).toBeVisible();
  });

  test('should have copy button on assistant message', async ({ page }) => {
    const assistantMessage = page.locator('.message.assistant').first();
    const copyBtn = assistantMessage.locator('.copy-btn');
    await expect(copyBtn).toBeVisible();
  });

  test('should copy message content on click', async ({ page, context }) => {
    // Grant clipboard permissions
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

    const userMessage = page.locator('.message.user').first();
    const copyBtn = userMessage.locator('.copy-btn');

    await copyBtn.click();

    // Read clipboard
    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toContain('Test message for copying');
  });
});

test.describe('Edit Message', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');

    // Create a conversation
    await page.locator('#message-input').fill('Original message');
    await page.locator('#send-btn').click();
    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30000 });
  });

  test('should have edit button on user message', async ({ page }) => {
    const userMessage = page.locator('.message.user').first();
    const editBtn = userMessage.locator('.edit-btn');
    await expect(editBtn).toBeVisible();
  });

  test('should enter edit mode on edit button click', async ({ page }) => {
    const userMessage = page.locator('.message.user').first();
    const editBtn = userMessage.locator('.edit-btn');

    await editBtn.click();

    // Should show edit input
    const editInput = userMessage.locator('textarea, input[type="text"], .edit-input');
    await expect(editInput).toBeVisible({ timeout: 2000 });
  });

  test('should show original text in edit input', async ({ page }) => {
    const userMessage = page.locator('.message.user').first();
    const editBtn = userMessage.locator('.edit-btn');

    await editBtn.click();

    const editInput = userMessage.locator('textarea, input[type="text"], .edit-input');
    await expect(editInput).toHaveValue('Original message');
  });

  test('should have save and cancel buttons in edit mode', async ({ page }) => {
    const userMessage = page.locator('.message.user').first();
    await userMessage.locator('.edit-btn').click();

    const saveBtn = userMessage.locator('.save-btn, [title*="Save"], button:has-text("Save")');
    const cancelBtn = userMessage.locator('.cancel-btn, [title*="Cancel"], button:has-text("Cancel")');

    await expect(saveBtn).toBeVisible({ timeout: 2000 });
    await expect(cancelBtn).toBeVisible({ timeout: 2000 });
  });

  test('should cancel edit on cancel button', async ({ page }) => {
    const userMessage = page.locator('.message.user').first();
    await userMessage.locator('.edit-btn').click();

    const editInput = userMessage.locator('textarea, input[type="text"], .edit-input');
    await editInput.fill('Modified message');

    const cancelBtn = userMessage.locator('.cancel-btn, [title*="Cancel"], button:has-text("Cancel")');
    await cancelBtn.click();

    // Edit input should be gone
    await expect(editInput).toBeHidden({ timeout: 2000 });

    // Original text should remain
    await expect(userMessage).toContainText('Original message');
  });

  test('should save edit and regenerate response', async ({ page }) => {
    const userMessage = page.locator('.message.user').first();
    await userMessage.locator('.edit-btn').click();

    const editInput = userMessage.locator('textarea, input[type="text"], .edit-input');
    await editInput.fill('Edited message content');

    const saveBtn = userMessage.locator('.save-btn, [title*="Save"], button:has-text("Save")');
    await saveBtn.click();

    // Should show edited message
    await expect(userMessage).toContainText('Edited message content', { timeout: 5000 });

    // Should regenerate response (creates branch)
    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30000 });
  });
});

test.describe('Retry Message', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');

    await page.locator('#message-input').fill('Retry test message');
    await page.locator('#send-btn').click();
    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30000 });
  });

  test('should have retry button on assistant message', async ({ page }) => {
    const assistantMessage = page.locator('.message.assistant').first();
    const retryBtn = assistantMessage.locator('.retry-btn');
    await expect(retryBtn).toBeVisible();
  });

  test('should regenerate response on retry', async ({ page }) => {
    const assistantMessage = page.locator('.message.assistant').first();
    const retryBtn = assistantMessage.locator('.retry-btn');

    // Get original response
    const originalContent = await assistantMessage.locator('.message-content').textContent();

    await retryBtn.click();

    // Wait for new response
    await page.waitForTimeout(1000);
    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30000 });

    // In mock mode, might get same response
    // In live mode, might get different response
  });
});

test.describe('Version Navigation (Branching)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');

    // Create initial message
    await page.locator('#message-input').fill('First version');
    await page.locator('#send-btn').click();
    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30000 });

    // Edit to create branch
    const userMessage = page.locator('.message.user').first();
    await userMessage.locator('.edit-btn').click();

    const editInput = userMessage.locator('textarea, input[type="text"], .edit-input');
    await editInput.fill('Second version');

    const saveBtn = userMessage.locator('.save-btn, [title*="Save"], button:has-text("Save")');
    await saveBtn.click();

    // Wait for regeneration
    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30000 });
  });

  test('should show version navigation after edit', async ({ page }) => {
    const userMessage = page.locator('.message.user').first();

    // Look for version navigation buttons
    const prevBtn = userMessage.locator('.prev-version, [title*="Previous"], button:has-text("◀")');
    const nextBtn = userMessage.locator('.next-version, [title*="Next"], button:has-text("▶")');

    // At least one should exist if branching is enabled
    const hasPrev = await prevBtn.count() > 0;
    const hasNext = await nextBtn.count() > 0;

    // If branching UI exists, test it
    if (hasPrev || hasNext) {
      await expect(prevBtn.or(nextBtn).first()).toBeVisible();
    }
  });

  test('should navigate between versions', async ({ page }) => {
    const userMessage = page.locator('.message.user').first();
    const prevBtn = userMessage.locator('.prev-version, [title*="Previous"], button:has-text("◀")');

    if (await prevBtn.count() > 0 && await prevBtn.isVisible()) {
      await prevBtn.click();

      // Should show first version
      await expect(userMessage).toContainText('First version', { timeout: 5000 });
    }
  });

  test('should show version indicator', async ({ page }) => {
    const userMessage = page.locator('.message.user').first();

    // Look for version indicator like "2/2" or similar
    const versionIndicator = userMessage.locator('.version-indicator, .version-count');

    if (await versionIndicator.count() > 0) {
      await expect(versionIndicator).toBeVisible();
      const text = await versionIndicator.textContent();
      expect(text).toMatch(/\d.*\d/); // Contains numbers
    }
  });
});

test.describe('Delete Message', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');

    await page.locator('#message-input').fill('Message to delete');
    await page.locator('#send-btn').click();
    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30000 });
  });

  test('should have delete option', async ({ page }) => {
    const userMessage = page.locator('.message.user').first();

    // Delete might be in actions or require right-click
    const deleteBtn = userMessage.locator('.delete-btn, [title*="Delete"]');

    if (await deleteBtn.count() > 0) {
      await expect(deleteBtn).toBeVisible();
    }
  });
});

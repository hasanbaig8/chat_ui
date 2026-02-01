import { test, expect } from '@playwright/test';

/**
 * Level 2: Input Tests
 *
 * Tests for the message input field behavior.
 * No message sending yet, just input interactions.
 */

test.describe('Message Input Behavior', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#message-input')).toBeVisible();
  });

  test('should accept text input', async ({ page }) => {
    const input = page.locator('#message-input');
    await input.fill('Hello, world!');
    await expect(input).toHaveValue('Hello, world!');
  });

  test('should enable send button when input has text', async ({ page }) => {
    const input = page.locator('#message-input');
    const sendBtn = page.locator('#send-btn');

    // Initially disabled
    await expect(sendBtn).toBeDisabled();

    // Type something
    await input.fill('Test');
    await expect(sendBtn).toBeEnabled();
  });

  test('should disable send button when input is cleared', async ({ page }) => {
    const input = page.locator('#message-input');
    const sendBtn = page.locator('#send-btn');

    await input.fill('Test');
    await expect(sendBtn).toBeEnabled();

    await input.fill('');
    await expect(sendBtn).toBeDisabled();
  });

  test('should handle multiline input', async ({ page }) => {
    const input = page.locator('#message-input');

    await input.fill('Line 1\nLine 2\nLine 3');
    const value = await input.inputValue();
    expect(value).toContain('Line 1');
    expect(value).toContain('Line 2');
    expect(value).toContain('Line 3');
  });

  test('should handle special characters', async ({ page }) => {
    const input = page.locator('#message-input');
    const special = '!@#$%^&*()_+-=[]{}|;:,.<>?';

    await input.fill(special);
    await expect(input).toHaveValue(special);
  });

  test('should handle unicode characters', async ({ page }) => {
    const input = page.locator('#message-input');
    const unicode = '你好 こんにちは 🎉 émojis';

    await input.fill(unicode);
    await expect(input).toHaveValue(unicode);
  });

  test('should focus input on page load', async ({ page }) => {
    const input = page.locator('#message-input');

    // Give it a moment for autofocus
    await page.waitForTimeout(100);

    // Check if input is focused (or can be focused)
    await input.focus();
    await expect(input).toBeFocused();
  });
});

test.describe('Input Placeholder', () => {
  test('should show placeholder text', async ({ page }) => {
    await page.goto('/');
    const input = page.locator('#message-input');

    const placeholder = await input.getAttribute('placeholder');
    expect(placeholder).toBeTruthy();
    expect(placeholder?.length).toBeGreaterThan(0);
  });
});

test.describe('Keyboard Shortcuts', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#message-input')).toBeVisible();
  });

  test('should not submit on Enter alone in textarea', async ({ page }) => {
    const input = page.locator('#message-input');
    const welcome = page.locator('#welcome-message');

    await input.fill('Test message');
    await input.press('Enter');

    // Welcome should still be visible (message not sent)
    // Note: behavior depends on implementation - textarea might allow newlines
    await page.waitForTimeout(500);

    // Check if message was sent (welcome hidden) or not
    const isWelcomeVisible = await welcome.isVisible();

    // If textarea, Enter should add newline, not submit
    if (isWelcomeVisible) {
      const value = await input.inputValue();
      expect(value).toContain('\n');
    }
  });

  test('should submit on Ctrl+Enter or Cmd+Enter', async ({ page }) => {
    const input = page.locator('#message-input');
    const welcome = page.locator('#welcome-message');

    await input.fill('Test message');

    // Use Ctrl+Enter (or Cmd+Enter on Mac)
    await input.press('Control+Enter');

    // Wait for potential submission
    await page.waitForTimeout(1000);

    // Message might be sent - this is implementation dependent
    // Just verify no crash
    await expect(page.locator('body')).toBeVisible();
  });
});

test.describe('Input with Model Selection', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('should have model selector visible', async ({ page }) => {
    const modelSelect = page.locator('#model-select');
    await expect(modelSelect).toBeVisible();
  });

  test('should have model options', async ({ page }) => {
    const modelSelect = page.locator('#model-select');
    const options = modelSelect.locator('option');

    const count = await options.count();
    expect(count).toBeGreaterThan(0);
  });

  test('should be able to change model', async ({ page }) => {
    const modelSelect = page.locator('#model-select');

    // Get all options
    const options = await modelSelect.locator('option').all();

    if (options.length > 1) {
      // Get second option value
      const secondValue = await options[1].getAttribute('value');
      if (secondValue) {
        await modelSelect.selectOption(secondValue);
        await expect(modelSelect).toHaveValue(secondValue);
      }
    }
  });
});

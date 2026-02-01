import { test } from '@playwright/test';

test('take UI screenshot', async ({ page }) => {
  await page.goto('http://localhost:8079');
  await page.waitForLoadState('networkidle');

  // Click New Chat and send a message
  await page.locator('#new-chat-btn').click();
  await page.waitForTimeout(500);

  await page.locator('#message-input').fill('Hello, this is a test message to show the user message styling!');
  await page.locator('#send-btn').click();

  // Wait for response
  await page.waitForTimeout(4000);

  // Take screenshot
  await page.screenshot({ path: 'test-results/ui-screenshot.png', fullPage: false });
});

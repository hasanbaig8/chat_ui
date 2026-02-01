import { test, expect } from '@playwright/test';

/**
 * Smoke Tests - Run with Real API
 *
 * A minimal test suite that validates the critical path.
 * If these pass, you have high confidence the full suite will pass.
 *
 * Run: npm run test:smoke
 * (Does NOT use MOCK_LLM - hits real Anthropic API)
 *
 * These tests run SERIALLY and share state to minimize API calls.
 */

// Run tests serially - they share server state
test.describe.configure({ mode: 'serial' });

// Share page across tests to avoid re-creating conversations
let sharedUniqueId: string;

test.describe('Smoke Tests', () => {
  // Increase timeout for real API calls
  test.setTimeout(90000);

  test('1. App loads correctly', async ({ page }) => {
    await page.goto('/');

    // Core elements visible
    await expect(page.locator('#message-input')).toBeVisible();
    await expect(page.locator('#send-btn')).toBeVisible();
    await expect(page.locator('#welcome-message')).toBeVisible();
    await expect(page.locator('#sidebar')).toBeVisible();
    await expect(page.locator('#model-select')).toBeVisible();
  });

  test('2. Send message and receive response', async ({ page }) => {
    await page.goto('/');

    // Generate unique ID to track this conversation
    sharedUniqueId = `SMOKE${Date.now().toString().slice(-6)}`;

    const input = page.locator('#message-input');
    const sendBtn = page.locator('#send-btn');

    // Send message with unique ID
    await input.fill(`Say "${sharedUniqueId}" and nothing else.`);
    await sendBtn.click();

    // Input should clear
    await expect(input).toHaveValue('');

    // User message appears
    await expect(page.locator('.message.user')).toBeVisible({ timeout: 5000 });

    // Assistant response appears and has actual content
    const assistantMessage = page.locator('.message.assistant');
    await expect(assistantMessage).toBeVisible({ timeout: 60000 });

    // Wait for actual text content (not just the container)
    const messageContent = assistantMessage.locator('.message-content');
    await expect(messageContent).not.toBeEmpty({ timeout: 60000 });

    // Verify content has text
    const content = await messageContent.innerText();
    expect(content.trim().length).toBeGreaterThan(0);

    // Message actions visible
    await expect(page.locator('.message.user .edit-btn')).toBeVisible();
    await expect(page.locator('.message.assistant .retry-btn')).toBeVisible();
  });

  test('3. Conversation appears in sidebar', async ({ page }) => {
    // Continue from test 2 - just reload to verify sidebar
    await page.goto('/');
    await page.waitForTimeout(1000);

    // Conversation should be in sidebar
    const convItems = page.locator('.conversation-item');
    await expect(convItems.first()).toBeVisible({ timeout: 5000 });

    // Should have a title
    const firstTitle = await convItems.first().locator('.conversation-title').textContent();
    expect(firstTitle?.length).toBeGreaterThan(0);
  });

  test('4. Conversation persists after reload', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(1000);

    // Click the first conversation
    const convItem = page.locator('.conversation-item').first();
    await convItem.click();
    await page.waitForTimeout(500);

    // Should see messages (from test 2)
    await expect(page.locator('.message.user')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 5000 });

    // Our unique ID should be in the user message
    await expect(page.locator('.message.user').first()).toContainText(sharedUniqueId);
  });

  test('5. Settings modal works', async ({ page }) => {
    await page.goto('/');

    // Open default settings modal
    await page.locator('#default-settings-toggle').click();
    await page.waitForTimeout(500);

    // Modal should be visible with title
    const heading = page.getByRole('heading', { name: 'Default Settings' });
    await expect(heading).toBeVisible();

    // Has Normal Chat / Agent Chat tabs
    const normalTab = page.getByRole('button', { name: 'Normal Chat', exact: true });
    const agentTab = page.getByRole('button', { name: 'Agent Chat', exact: true });
    await expect(normalTab).toBeVisible();
    await expect(agentTab).toBeVisible();

    // Can switch tabs
    await agentTab.click();
    await page.waitForTimeout(200);
    await normalTab.click();

    // Close modal with Cancel button
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.waitForTimeout(300);

    // Modal should be closed (heading not visible)
    await expect(heading).toBeHidden();
  });
});

/**
 * Coverage: These 5 tests validate the complete critical path
 * with only 1 API call (test 2).
 *
 * If these pass:
 * - API integration works
 * - Streaming works
 * - Message rendering works
 * - Persistence works
 * - Settings work
 *
 * Then run MOCK_LLM=1 npm run test:e2e for full coverage.
 */

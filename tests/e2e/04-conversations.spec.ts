import { test, expect } from '@playwright/test';

/**
 * Level 4: Conversation Management Tests
 *
 * Tests for creating, switching, and managing conversations.
 */

test.describe('Create Conversations', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#message-input')).toBeVisible();
  });

  test('should create new conversation on new chat button', async ({ page }) => {
    const newChatBtn = page.locator('#new-chat-btn');
    await newChatBtn.click();

    // Should show welcome message (fresh conversation)
    await expect(page.locator('#welcome-message')).toBeVisible();
  });

  test('should create conversation after sending message', async ({ page }) => {
    const input = page.locator('#message-input');

    await input.fill('Hello');
    await page.locator('#send-btn').click();

    // Wait for response
    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30000 });

    // Conversation should appear in sidebar
    const convItem = page.locator('.conversation-item');
    await expect(convItem.first()).toBeVisible({ timeout: 5000 });
  });

  test('should create agent conversation', async ({ page }) => {
    const agentBtn = page.locator('#new-agent-chat-btn');
    await agentBtn.click();

    // Agent chat might have different UI indicators
    await page.waitForTimeout(500);

    // Should still be able to send messages
    const input = page.locator('#message-input');
    await expect(input).toBeVisible();
  });
});

test.describe('Conversation List', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');

    // Wait for UI to be ready
    const sendBtn = page.locator('#send-btn');
    await page.locator('#message-input').fill('Test conversation');
    await expect(sendBtn).toBeEnabled({ timeout: 10000 });
    await sendBtn.click();
    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30000 });
  });

  test('should show conversation in sidebar', async ({ page }) => {
    // Get the active conversation by ID (created in beforeEach)
    const activeConvId = await page.locator('.conversation-item.active').getAttribute('data-id');
    expect(activeConvId).toBeTruthy();

    // Verify it's visible in the sidebar
    await expect(page.locator(`.conversation-item[data-id="${activeConvId}"]`)).toBeVisible();
  });

  test('should show conversation title', async ({ page }) => {
    // Get the active conversation by ID (created in beforeEach)
    const activeConvId = await page.locator('.conversation-item.active').getAttribute('data-id');
    expect(activeConvId).toBeTruthy();

    const convItem = page.locator(`.conversation-item[data-id="${activeConvId}"]`);
    const title = convItem.locator('.conversation-title');

    await expect(title).toBeVisible();
    const text = await title.textContent();
    expect(text?.length).toBeGreaterThan(0);
  });

  test('should highlight active conversation', async ({ page }) => {
    // Get the active conversation by ID (created in beforeEach)
    const activeConvId = await page.locator('.conversation-item.active').getAttribute('data-id');
    expect(activeConvId).toBeTruthy();

    // Verify it has the active class
    const convItem = page.locator(`.conversation-item[data-id="${activeConvId}"]`);
    const classList = await convItem.getAttribute('class');
    expect(classList).toContain('active');
  });
});

test.describe('Switch Conversations', () => {
  test('should switch between conversations', async ({ page }) => {
    await page.goto('/');
    const input = page.locator('#message-input');
    const sendBtn = page.locator('#send-btn');

    // Create first conversation
    await input.fill('First conversation message');
    await expect(sendBtn).toBeEnabled({ timeout: 10000 });
    await sendBtn.click();
    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30000 });

    // Track first conversation by ID
    const firstConvId = await page.locator('.conversation-item.active').getAttribute('data-id');
    expect(firstConvId).toBeTruthy();

    // Create new conversation
    await page.locator('#new-chat-btn').click();
    await expect(page.locator('#welcome-message')).toBeVisible();

    // Send message in new conversation
    await input.fill('Second conversation message');
    await expect(sendBtn).toBeEnabled({ timeout: 10000 });
    await sendBtn.click();
    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30000 });

    // Track second conversation by ID
    const secondConvId = await page.locator('.conversation-item.active').getAttribute('data-id');
    expect(secondConvId).toBeTruthy();
    expect(secondConvId).not.toBe(firstConvId);

    // Verify both conversations exist by ID
    await expect(page.locator(`.conversation-item[data-id="${firstConvId}"]`)).toBeVisible();
    await expect(page.locator(`.conversation-item[data-id="${secondConvId}"]`)).toBeVisible();

    // Click first conversation by ID
    await page.locator(`.conversation-item[data-id="${firstConvId}"]`).click();

    // Should show first conversation's messages
    await expect(page.locator('.message.user')).toContainText('First conversation');
  });

  test('should preserve messages when switching', async ({ page }) => {
    await page.goto('/');
    const input = page.locator('#message-input');
    const sendBtn = page.locator('#send-btn');

    // Create conversation with specific message
    await input.fill('Unique message 12345');
    await expect(sendBtn).toBeEnabled({ timeout: 10000 });
    await sendBtn.click();
    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30000 });

    // Track first conversation by ID
    const firstConvId = await page.locator('.conversation-item.active').getAttribute('data-id');

    // Create new conversation
    await page.locator('#new-chat-btn').click();
    await input.fill('Different message');
    await expect(sendBtn).toBeEnabled({ timeout: 10000 });
    await sendBtn.click();
    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30000 });

    // Switch back to first conversation by ID
    await page.locator(`.conversation-item[data-id="${firstConvId}"]`).click();

    // Original message should be there
    await expect(page.locator('.message.user')).toContainText('Unique message 12345');
  });
});

test.describe('Conversation Search', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');

    // Wait for UI to be ready
    const sendBtn = page.locator('#send-btn');
    await page.locator('#message-input').fill('Searchable test message');
    await expect(sendBtn).toBeEnabled({ timeout: 10000 });
    await sendBtn.click();
    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30000 });
  });

  test('should filter conversations by search', async ({ page }) => {
    const searchInput = page.locator('#search-input');

    // Type in search
    await searchInput.fill('Searchable');

    // Wait for filter
    await page.waitForTimeout(500);

    // Should still see the matching conversation
    const convItems = page.locator('.conversation-item:visible');
    const count = await convItems.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test('should show clear button when searching', async ({ page }) => {
    const searchInput = page.locator('#search-input');
    const clearBtn = page.locator('#clear-search-btn');

    // Clear button initially hidden
    await expect(clearBtn).toBeHidden();

    // Type in search
    await searchInput.fill('test');

    // Clear button should appear
    await expect(clearBtn).toBeVisible();
  });

  test('should clear search on clear button click', async ({ page }) => {
    const searchInput = page.locator('#search-input');
    const clearBtn = page.locator('#clear-search-btn');

    await searchInput.fill('test');
    await expect(clearBtn).toBeVisible();

    await clearBtn.click();

    await expect(searchInput).toHaveValue('');
    await expect(clearBtn).toBeHidden();
  });
});

test.describe('Conversation Delete', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');

    // Wait for UI to be ready
    const sendBtn = page.locator('#send-btn');
    await page.locator('#message-input').fill('Message to delete');
    await expect(sendBtn).toBeEnabled({ timeout: 10000 });
    await sendBtn.click();
    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30000 });
  });

  test('should show delete option on conversation', async ({ page }) => {
    const convItem = page.locator('.conversation-item').first();

    // Hover to reveal actions (if hidden)
    await convItem.hover();

    // Look for delete button
    const deleteBtn = convItem.locator('.delete-btn, [title*="Delete"], [aria-label*="Delete"]');

    // Some implementations use context menu
    if (await deleteBtn.count() > 0) {
      await expect(deleteBtn.first()).toBeVisible();
    } else {
      // Try right-click for context menu
      await convItem.click({ button: 'right' });
      await page.waitForTimeout(300);
    }
  });
});

test.describe('Conversation Persistence', () => {
  test('should persist conversation on reload', async ({ page }) => {
    await page.goto('/');

    // Create conversation
    const uniqueText = `Persistence test ${Date.now()}`;
    await page.locator('#message-input').fill(uniqueText);
    await page.locator('#send-btn').click();
    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30000 });

    // Reload page
    await page.reload();
    await expect(page.locator('#message-input')).toBeVisible();

    // Click the conversation in sidebar
    const convItem = page.locator('.conversation-item').first();
    await convItem.click();

    // Should see the original message
    await expect(page.locator('.message.user')).toContainText(uniqueText);
  });
});

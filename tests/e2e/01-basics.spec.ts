import { test, expect } from '@playwright/test';

/**
 * Level 1: Basic Tests
 *
 * These tests verify the app loads and core elements exist.
 * No interactions, just visibility checks.
 */

test.describe('Page Load', () => {
  test('should load the home page', async ({ page }) => {
    const response = await page.goto('/');
    expect(response?.status()).toBe(200);
  });

  test('should have correct page title', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/Claude/i);
  });

  test('should load without console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Filter out expected errors (like missing favicons)
    const realErrors = errors.filter(e => !e.includes('favicon'));
    expect(realErrors).toHaveLength(0);
  });
});

test.describe('Core Layout Elements', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('should show header with logo', async ({ page }) => {
    const header = page.locator('header.header');
    await expect(header).toBeVisible();

    const logo = page.locator('.logo');
    await expect(logo).toContainText('Claude');
  });

  test('should show sidebar', async ({ page }) => {
    const sidebar = page.locator('#sidebar');
    await expect(sidebar).toBeVisible();
  });

  test('should show chat area', async ({ page }) => {
    const chatArea = page.locator('main.chat-area');
    await expect(chatArea).toBeVisible();
  });

  test('should show messages container', async ({ page }) => {
    const container = page.locator('#messages-container');
    await expect(container).toBeVisible();
  });

  test('should show welcome message initially', async ({ page }) => {
    const welcome = page.locator('#welcome-message');
    await expect(welcome).toBeVisible();
  });
});

test.describe('Input Area Elements', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('should show message input', async ({ page }) => {
    const input = page.locator('#message-input');
    await expect(input).toBeVisible();
  });

  test('should show send button', async ({ page }) => {
    const sendBtn = page.locator('#send-btn');
    await expect(sendBtn).toBeVisible();
  });

  test('send button should be disabled initially', async ({ page }) => {
    const sendBtn = page.locator('#send-btn');
    await expect(sendBtn).toBeDisabled();
  });

  test('should show file upload button', async ({ page }) => {
    const fileBtn = page.locator('#server-file-btn');
    await expect(fileBtn).toBeVisible();
  });

  test('should show prompts button', async ({ page }) => {
    const promptsBtn = page.locator('#prompts-btn');
    await expect(promptsBtn).toBeVisible();
  });
});

test.describe('Sidebar Elements', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('should show new chat button', async ({ page }) => {
    const newChatBtn = page.locator('#new-chat-btn');
    await expect(newChatBtn).toBeVisible();
  });

  test('should show new agent chat button', async ({ page }) => {
    const agentBtn = page.locator('#new-agent-chat-btn');
    await expect(agentBtn).toBeVisible();
  });

  test('should show new project button', async ({ page }) => {
    const projectBtn = page.locator('#new-project-btn');
    await expect(projectBtn).toBeVisible();
  });

  test('should show search input', async ({ page }) => {
    const searchInput = page.locator('#search-input');
    await expect(searchInput).toBeVisible();
  });

  test('should show conversations list', async ({ page }) => {
    const convList = page.locator('#conversations-list');
    await expect(convList).toBeVisible();
  });
});

test.describe('Header Elements', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('should show theme toggle', async ({ page }) => {
    const themeToggle = page.locator('#theme-toggle');
    await expect(themeToggle).toBeVisible();
  });

  test('should show help chat button', async ({ page }) => {
    const helpBtn = page.locator('#help-chat-btn');
    await expect(helpBtn).toBeVisible();
  });

  test('should show copy conversation button', async ({ page }) => {
    const copyBtn = page.locator('#copy-conversation-btn');
    await expect(copyBtn).toBeVisible();
  });

  test('should show default settings toggle', async ({ page }) => {
    const settingsToggle = page.locator('#default-settings-toggle');
    await expect(settingsToggle).toBeVisible();
  });
});

test.describe('Status Bar', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('should show context stats', async ({ page }) => {
    const statsBar = page.locator('#context-stats');
    await expect(statsBar).toBeVisible();
  });

  test('should show message count', async ({ page }) => {
    const msgCount = page.locator('#stat-messages');
    await expect(msgCount).toBeVisible();
    await expect(msgCount).toHaveText('0');
  });

  test('should show context usage', async ({ page }) => {
    const context = page.locator('#stat-context');
    await expect(context).toBeVisible();
  });
});

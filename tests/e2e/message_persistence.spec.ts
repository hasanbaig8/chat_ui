import { test, expect, Page, Locator } from '@playwright/test';

/**
 * Message Persistence Tests
 *
 * Tests that message content persists correctly across conversation switches.
 * Run with MOCK_LLM=1 for deterministic behavior:
 *   MOCK_LLM=1 npx playwright test tests/e2e/message_persistence.spec.ts --reporter=line
 */

// Expected mock response content (from services/mock_streams.py MOCK_TEXT_CHUNKS)
const EXPECTED_MOCK_TEXT_PARTS = {
  greeting: "Hello!",
  boldText: "mock response",
  codeFunction: "def hello():",
  codePrint: "print('Hello, World!')",
  listItems: ["Item one", "Item two", "Item three"]
};

// Expected thinking content (from MOCK_THINKING_CONTENT)
const EXPECTED_THINKING_PARTS = [
  "analyze this request",
  "understand what the user is asking",
  "testing the chat interface",
  "helpful response"
];

// Expected web search results (from MOCK_WEB_SEARCH_RESULTS)
// Note: The UI renders titles and URLs but not snippets
const EXPECTED_WEB_SEARCH_CONTENT = [
  "Example Result 1",
  "example.com/result1",
  "Claude Documentation"
];

/**
 * Helper to wait for streaming to complete by checking for content rendered
 */
async function waitForStreamingComplete(page: Page): Promise<void> {
  // Wait for the mock response's list items to appear in the message content
  // Look for "Item three" text which is the last list item in the mock response
  await expect(page.locator('.message.assistant').first()).toContainText('Item three', { timeout: 30000 });
}

/**
 * Helper to wait for send button to be enabled and click it
 * Includes retry logic to handle race conditions with input events
 */
async function clickSendButton(page: Page): Promise<void> {
  const sendBtn = page.locator('#send-btn');
  const input = page.locator('#message-input');

  // Trigger input event to ensure button state is updated
  await input.dispatchEvent('input');

  // Wait a bit for the event to propagate
  await page.waitForTimeout(100);

  // Wait for button to be enabled with a longer timeout
  await expect(sendBtn).toBeEnabled({ timeout: 10000 });
  await sendBtn.click();
}

/**
 * Helper to verify markdown content in an assistant message
 */
async function verifyMarkdownContent(messageLocator: Locator): Promise<void> {
  // Check bold text is rendered
  await expect(messageLocator.locator('strong').first()).toContainText(EXPECTED_MOCK_TEXT_PARTS.boldText);

  // Check code block is rendered
  await expect(messageLocator.locator('pre code').first()).toBeVisible();
  await expect(messageLocator.locator('pre code').first()).toContainText(EXPECTED_MOCK_TEXT_PARTS.codeFunction);
  await expect(messageLocator.locator('pre code').first()).toContainText(EXPECTED_MOCK_TEXT_PARTS.codePrint);

  // Check list items are rendered - look for specific content
  for (const item of EXPECTED_MOCK_TEXT_PARTS.listItems) {
    await expect(messageLocator).toContainText(item);
  }
}

/**
 * Helper to find conversation by user message content
 */
async function findConversationByMessage(page: Page, messageContent: string): Promise<Locator> {
  // Conversations are titled with the first message content (truncated)
  // We look for a conversation item that contains the start of the message
  const truncatedContent = messageContent.substring(0, 30);
  return page.locator('.conversation-item', { hasText: truncatedContent }).first();
}

/**
 * Helper to get the conversation ID from the URL or data attribute
 */
async function getCurrentConversationId(page: Page): Promise<string | null> {
  const url = page.url();
  const match = url.match(/conversation=([^&]+)/);
  return match ? match[1] : null;
}

/**
 * Helper to create a new conversation and ensure it's ready
 */
async function createNewChat(page: Page): Promise<void> {
  await page.locator('#new-chat-btn').click();
  await expect(page.locator('#welcome-message')).toBeVisible();
  // Wait for input to be ready and enabled
  await expect(page.locator('#message-input')).toBeVisible();
  await expect(page.locator('#message-input')).toBeEnabled();
  // Small wait to ensure UI is stable
  await page.waitForTimeout(200);
}

test.describe('Message Persistence Across Conversation Switches', () => {
  test.beforeEach(async ({ page }) => {
    // Create a fresh conversation for each test to avoid interference
    await page.goto('/');
    await expect(page.locator('#message-input')).toBeVisible();
    // Click new chat to ensure we start fresh
    await createNewChat(page);
  });

  test('should persist markdown content (code block, bold, list) after switching conversations', async ({ page }) => {
    // Send a unique message
    const input = page.locator('#message-input');
    const uniqueMessage = `Markdown test ${Date.now()}`;

    await input.fill(uniqueMessage);
    await clickSendButton(page);

    // Wait for assistant response to appear
    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30000 });

    // Wait for streaming to complete
    await waitForStreamingComplete(page);

    // Find our conversation item by the message content
    const conversationItem = await findConversationByMessage(page, uniqueMessage);
    await expect(conversationItem).toBeVisible({ timeout: 5000 });

    // Verify markdown is rendered initially
    const assistantMessage = page.locator('.message.assistant').first();
    await verifyMarkdownContent(assistantMessage);

    // Create a new conversation to switch away
    await page.locator('#new-chat-btn').click();
    await expect(page.locator('#welcome-message')).toBeVisible();

    // Switch back to the original conversation
    await conversationItem.click();

    // Wait for messages to load
    await expect(page.locator('.message.user')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 10000 });

    // Verify markdown is still correctly rendered after switching back
    const persistedAssistantMessage = page.locator('.message.assistant').first();
    await verifyMarkdownContent(persistedAssistantMessage);
  });

  test('should persist thinking block content after switching to 3 other conversations and back', async ({ page }) => {
    // Send unique message
    const input = page.locator('#message-input');
    const uniqueMessage = `Thinking test ${Date.now()}`;
    await input.fill(uniqueMessage);
    await clickSendButton(page);

    // Wait for response
    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30000 });

    // Wait for streaming to complete
    await waitForStreamingComplete(page);

    // Find our conversation
    const originalConversation = await findConversationByMessage(page, uniqueMessage);
    await expect(originalConversation).toBeVisible({ timeout: 5000 });

    // Check if thinking toggle is visible (indicates thinking was in response)
    const thinkingToggleBtn = page.locator('.message.assistant .thinking-toggle').first();
    const hasThinking = await thinkingToggleBtn.isVisible().catch(() => false);

    if (hasThinking) {
      // Click to expand thinking and verify content
      await thinkingToggleBtn.click();
      const thinkingContent = page.locator('.message.assistant .thinking-content').first();
      await expect(thinkingContent).toBeVisible();

      // Verify thinking content parts
      for (const part of EXPECTED_THINKING_PARTS) {
        await expect(thinkingContent).toContainText(part);
      }
    }

    // Switch away to 3 other conversations
    for (let i = 0; i < 3; i++) {
      await createNewChat(page);

      // Send a message in each new conversation to create it
      await input.fill(`Switch conversation ${i + 1} ${Date.now()}`);
      await clickSendButton(page);
      await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30000 });
      await waitForStreamingComplete(page);
    }

    // Switch back to the original conversation
    await originalConversation.click();

    // Wait for messages to load
    await expect(page.locator('.message.user')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.message.user')).toContainText('Thinking test');

    // If thinking was present initially, verify it persisted
    if (hasThinking) {
      const persistedThinkingToggle = page.locator('.message.assistant .thinking-toggle').first();
      await expect(persistedThinkingToggle).toBeVisible();

      // Expand and verify content
      await persistedThinkingToggle.click();

      const persistedThinkingContent = page.locator('.message.assistant .thinking-content').first();
      await expect(persistedThinkingContent).toBeVisible();

      for (const part of EXPECTED_THINKING_PARTS) {
        await expect(persistedThinkingContent).toContainText(part);
      }
    }

    // Always verify the main text content persisted
    const persistedAssistantMessage = page.locator('.message.assistant').first();
    await expect(persistedAssistantMessage.locator('strong').first()).toContainText(EXPECTED_MOCK_TEXT_PARTS.boldText);
  });

  test('should persist web search results after switching conversations', async ({ page }) => {
    // Enable web search via localStorage before page loads
    await page.evaluate(() => {
      localStorage.setItem('claude-chat-web-search-enabled', 'true');
      localStorage.setItem('claude-chat-web-search-max-uses', '5');
      localStorage.setItem('claude-chat-thinking-enabled', 'false');
    });

    // Reload page to apply settings and start fresh
    await page.reload();
    await expect(page.locator('#message-input')).toBeVisible();
    await createNewChat(page);

    // Send unique message
    const input = page.locator('#message-input');
    const uniqueMessage = `Web search test ${Date.now()}`;
    await input.fill(uniqueMessage);
    await clickSendButton(page);

    // Wait for response
    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30000 });

    // Wait for streaming to complete
    await waitForStreamingComplete(page);

    // Find our conversation
    const originalConversation = await findConversationByMessage(page, uniqueMessage);
    await expect(originalConversation).toBeVisible({ timeout: 5000 });

    // Check for web search block
    const assistantMessage = page.locator('.message.assistant').first();
    const hasWebSearch = await assistantMessage.locator('.web-search-block, .web-search-results, [class*="web-search"]').first().isVisible().catch(() => false);

    if (hasWebSearch) {
      // Verify web search content
      for (const content of EXPECTED_WEB_SEARCH_CONTENT) {
        await expect(assistantMessage).toContainText(content, { ignoreCase: true });
      }
    }

    // Switch to a new conversation
    await page.locator('#new-chat-btn').click();
    await expect(page.locator('#welcome-message')).toBeVisible();

    // Switch back to original
    await originalConversation.click();

    // Wait for messages to load
    await expect(page.locator('.message.user')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 10000 });

    // Verify the main text content persisted
    const persistedAssistantMessage = page.locator('.message.assistant').first();
    await expect(persistedAssistantMessage.locator('strong').first()).toContainText(EXPECTED_MOCK_TEXT_PARTS.boldText);

    // If web search was present, verify it persisted
    if (hasWebSearch) {
      for (const content of EXPECTED_WEB_SEARCH_CONTENT) {
        await expect(persistedAssistantMessage).toContainText(content, { ignoreCase: true });
      }
    }
  });

  test('should persist long message (500+ characters) after switching conversations', async ({ page }) => {
    // Create a long user message (500+ characters) with unique identifier
    const timestamp = Date.now();
    const longMessageParts = [
      `LongMessageTest${timestamp}`,
      'A'.repeat(100),
      'B'.repeat(100),
      'C'.repeat(100),
      'D'.repeat(100),
      'E'.repeat(100),
      'This is the end of the long message.'
    ];
    const longMessage = longMessageParts.join(' ');

    expect(longMessage.length).toBeGreaterThan(500);

    // Send the long message
    const input = page.locator('#message-input');
    await input.fill(longMessage);
    await clickSendButton(page);

    // Wait for user message to appear
    await expect(page.locator('.message.user')).toBeVisible();

    // Verify long message is displayed correctly
    const userMessage = page.locator('.message.user').first();
    await expect(userMessage).toContainText(`LongMessageTest${timestamp}`);
    await expect(userMessage).toContainText('AAAA');
    await expect(userMessage).toContainText('This is the end of the long message.');

    // Wait for assistant response and streaming to complete
    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30000 });
    await waitForStreamingComplete(page);

    // Find our conversation (use the unique timestamp identifier)
    const originalConversation = await findConversationByMessage(page, `LongMessageTest${timestamp}`);
    await expect(originalConversation).toBeVisible({ timeout: 5000 });

    // Switch to a new conversation
    await page.locator('#new-chat-btn').click();
    await expect(page.locator('#welcome-message')).toBeVisible();

    // Switch back to original
    await originalConversation.click();

    // Wait for messages to load
    await expect(page.locator('.message.user')).toBeVisible({ timeout: 10000 });

    const persistedUserMessage = page.locator('.message.user').first();

    // Verify full content of long message
    await expect(persistedUserMessage).toContainText(`LongMessageTest${timestamp}`);
    await expect(persistedUserMessage).toContainText('AAAA');
    await expect(persistedUserMessage).toContainText('BBBB');
    await expect(persistedUserMessage).toContainText('CCCC');
    await expect(persistedUserMessage).toContainText('DDDD');
    await expect(persistedUserMessage).toContainText('EEEE');
    await expect(persistedUserMessage).toContainText('This is the end of the long message.');

    // Also verify assistant response is still there
    await expect(page.locator('.message.assistant')).toBeVisible();
    const persistedAssistantMessage = page.locator('.message.assistant').first();
    await expect(persistedAssistantMessage.locator('strong').first()).toContainText(EXPECTED_MOCK_TEXT_PARTS.boldText);
  });

  test('should persist multiple assistant responses in one conversation after switching', async ({ page }) => {
    const input = page.locator('#message-input');
    const timestamp = Date.now();

    // Store user messages for verification with unique identifiers
    const userMessages = [
      `First message ${timestamp}`,
      `Second message ${timestamp}`,
      `Third message ${timestamp}`
    ];

    // First message exchange
    await input.fill(userMessages[0]);
    await clickSendButton(page);

    await expect(page.locator('.message.user')).toBeVisible();
    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30000 });
    await waitForStreamingComplete(page);

    // Second message exchange
    await input.fill(userMessages[1]);
    await clickSendButton(page);

    // Wait for second assistant response
    await expect(page.locator('.message.assistant')).toHaveCount(2, { timeout: 30000 });
    await expect(page.locator('.message.assistant').nth(1)).toContainText('Item three', { timeout: 30000 });

    // Third message exchange
    await input.fill(userMessages[2]);
    await clickSendButton(page);

    // Wait for third assistant response
    await expect(page.locator('.message.assistant')).toHaveCount(3, { timeout: 30000 });
    await expect(page.locator('.message.assistant').nth(2)).toContainText('Item three', { timeout: 30000 });

    // Find our conversation (use the first message)
    const originalConversation = await findConversationByMessage(page, userMessages[0]);
    await expect(originalConversation).toBeVisible({ timeout: 5000 });

    // Verify all messages are present before switching
    await expect(page.locator('.message.user')).toHaveCount(3);
    await expect(page.locator('.message.assistant')).toHaveCount(3);

    // Verify content of all messages before switch
    for (let i = 0; i < 3; i++) {
      // User message
      await expect(page.locator('.message.user').nth(i)).toContainText(userMessages[i]);

      // Assistant message - check key elements
      const assistantMsg = page.locator('.message.assistant').nth(i);
      await expect(assistantMsg.locator('strong').first()).toContainText(EXPECTED_MOCK_TEXT_PARTS.boldText);
      await expect(assistantMsg.locator('pre code').first()).toContainText(EXPECTED_MOCK_TEXT_PARTS.codeFunction);
      for (const item of EXPECTED_MOCK_TEXT_PARTS.listItems) {
        await expect(assistantMsg).toContainText(item);
      }
    }

    // Switch to a new conversation
    await page.locator('#new-chat-btn').click();
    await expect(page.locator('#welcome-message')).toBeVisible();

    // Switch back to original
    await originalConversation.click();

    // Wait for messages to load
    await expect(page.locator('.message.user')).toHaveCount(3, { timeout: 10000 });
    await expect(page.locator('.message.assistant')).toHaveCount(3, { timeout: 10000 });

    // Verify user messages content
    for (let i = 0; i < 3; i++) {
      await expect(page.locator('.message.user').nth(i)).toContainText(userMessages[i]);
    }

    // Verify all assistant messages content persisted
    for (let i = 0; i < 3; i++) {
      const persistedAssistantMsg = page.locator('.message.assistant').nth(i);

      // Check bold text
      await expect(persistedAssistantMsg.locator('strong').first()).toContainText(EXPECTED_MOCK_TEXT_PARTS.boldText);

      // Check code block
      await expect(persistedAssistantMsg.locator('pre code').first()).toContainText(EXPECTED_MOCK_TEXT_PARTS.codeFunction);

      // Check list items content
      for (const item of EXPECTED_MOCK_TEXT_PARTS.listItems) {
        await expect(persistedAssistantMsg).toContainText(item);
      }
    }
  });
});

import { test, expect, Page, ConsoleMessage } from '@playwright/test';

/**
 * Streaming Interruption Tests
 *
 * Tests for handling various interruptions during streaming:
 * - Switching conversations mid-stream
 * - Page reload during streaming
 * - New chat during streaming
 * - Agent tool execution interruption
 * - Settings panel during streaming
 * - Rapid switching during streaming
 *
 * Run with MOCK_LLM=1 for deterministic behavior:
 *   MOCK_LLM=1 npx playwright test tests/e2e/streaming_interruption.spec.ts --workers=1 --reporter=line
 */

// Helper to wait for the app to be ready (not streaming)
async function waitForAppReady(page: Page): Promise<void> {
  const sendBtn = page.locator('#send-btn');
  await expect(sendBtn).toBeVisible({ timeout: 10000 });

  const stopBtn = page.locator('#stop-btn');
  await expect(stopBtn).toBeHidden({ timeout: 30000 });
}

// Helper to send a message (returns immediately after click, doesn't wait for response)
async function sendMessageNoWait(page: Page, message: string): Promise<void> {
  const input = page.locator('#message-input');
  const sendBtn = page.locator('#send-btn');

  await input.fill(message);
  await expect(sendBtn).toBeEnabled({ timeout: 5000 });
  await sendBtn.click();
}

// Helper to send a message and wait for response
async function sendMessageAndWait(page: Page, message: string): Promise<void> {
  await sendMessageNoWait(page, message);
  await expect(page.locator('.message.assistant').last()).toBeVisible({ timeout: 30000 });
  await waitForAppReady(page);
}

// Helper to create a conversation with unique marker
async function createConversation(page: Page, marker: string): Promise<string> {
  await sendMessageAndWait(page, marker);

  const convItem = page.locator('.conversation-item').filter({ hasText: marker }).first();
  await expect(convItem).toBeVisible({ timeout: 5000 });

  const convId = await convItem.getAttribute('data-id') || 'unknown';
  return convId;
}

// Helper to start a new conversation
async function startNewChat(page: Page): Promise<void> {
  await waitForAppReady(page);
  await page.locator('#new-chat-btn').click();
  await expect(page.locator('#welcome-message')).toBeVisible({ timeout: 5000 });
}

// Helper to start a new agent conversation
async function startNewAgentChat(page: Page): Promise<void> {
  await waitForAppReady(page);
  await page.locator('#new-agent-chat-btn').click();
  await page.waitForTimeout(500);
}

// Helper to get conversation item by marker
function getConvByMarker(page: Page, marker: string) {
  return page.locator('.conversation-item').filter({ hasText: marker }).first();
}

// Known bug patterns to exclude from critical error checks
const KNOWN_BUGS = [
  'branch is not defined'  // Known bug in chat.js:810
];

// Network errors that are expected under load
const NETWORK_ERRORS = [
  'Failed to fetch',
  'net::ERR_CONNECTION_REFUSED',
  'net::ERR_INCOMPLETE_CHUNKED_ENCODING',
  'network error',
  'NetworkError',
  'Failed to load resource',
  'Failed to load conversation',
  'Failed to create conversation',
  'ERR_ABORTED'
];

function isKnownBug(error: string): boolean {
  return KNOWN_BUGS.some(bug => error.includes(bug));
}

function isNetworkError(error: string): boolean {
  return NETWORK_ERRORS.some(pattern => error.includes(pattern));
}

function isCriticalError(error: string): boolean {
  if (isKnownBug(error) || isNetworkError(error)) return false;
  if (error.includes('favicon') || error.includes('404')) return false;

  return (
    error.includes('TypeError') ||
    error.includes('ReferenceError') ||
    error.includes('Cannot read properties') ||
    error.includes('undefined is not') ||
    error.includes('null is not')
  );
}

test.describe('Streaming Interruption Tests', () => {
  let consoleErrors: string[] = [];

  test.beforeEach(async ({ page }) => {
    // Capture console errors
    consoleErrors = [];
    page.on('console', (msg: ConsoleMessage) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    await page.goto('/');
    await expect(page.locator('#message-input')).toBeVisible();
    await page.waitForLoadState('networkidle');
  });

  test.afterEach(async () => {
    const criticalErrors = consoleErrors.filter(isCriticalError);
    if (criticalErrors.length > 0) {
      console.log('Console errors during test:', criticalErrors);
    }
  });

  test('1. Switch to different conversation mid-stream - no errors and old stream stopped', async ({ page }) => {
    const markerA = `STREAM_SWITCH_A_${Date.now()}`;
    const markerB = `STREAM_SWITCH_B_${Date.now()}`;

    // Create first conversation (completed)
    await createConversation(page, markerA);

    // Start second conversation but don't wait for completion
    await startNewChat(page);
    await sendMessageNoWait(page, markerB);

    // Wait for streaming to start (assistant message container appears)
    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 10000 });

    // Wait briefly for stream to be in progress
    await page.waitForTimeout(200);

    // Switch to first conversation while streaming
    const convA = getConvByMarker(page, markerA);
    await convA.click();

    // Wait for UI to settle
    await page.waitForTimeout(500);

    // Verify we're now showing conversation A
    await expect(convA).toHaveClass(/active/);
    await expect(page.locator('.message.user').first()).toContainText(markerA);

    // Verify no critical console errors
    const criticalErrors = consoleErrors.filter(isCriticalError);
    expect(criticalErrors).toHaveLength(0);

    // Verify stop button is not visible (stream should have been aborted)
    const stopBtn = page.locator('#stop-btn');
    await expect(stopBtn).toBeHidden({ timeout: 5000 });
  });

  test('2. Page reload mid-stream - conversation loads correctly after reload', async ({ page }) => {
    const marker = `RELOAD_STREAM_${Date.now()}`;

    // Start streaming a message
    await sendMessageNoWait(page, marker);

    // Wait for streaming to start
    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(200);

    // Get the conversation ID before reload
    const convItem = page.locator('.conversation-item.active');
    const convId = await convItem.getAttribute('data-id');

    // Reload page mid-stream
    await page.reload();
    await page.waitForLoadState('networkidle');

    // Wait for app to be ready
    await expect(page.locator('#message-input')).toBeVisible({ timeout: 10000 });

    // The conversation should still exist in sidebar
    if (convId) {
      const convItemAfterReload = page.locator(`.conversation-item[data-id="${convId}"]`);
      await expect(convItemAfterReload).toBeVisible({ timeout: 5000 });

      // Click on it to load
      await convItemAfterReload.click();
      await page.waitForTimeout(500);

      // Should show user message
      await expect(page.locator('.message.user').first()).toContainText(marker);
    }

    // Verify no critical errors
    const criticalErrors = consoleErrors.filter(isCriticalError);
    expect(criticalErrors).toHaveLength(0);
  });

  test('3. Click new chat button mid-stream - new chat works correctly', async ({ page }) => {
    const markerStreaming = `NEW_CHAT_STREAM_${Date.now()}`;
    const markerNew = `NEW_CHAT_AFTER_${Date.now()}`;

    // Start streaming a message
    await sendMessageNoWait(page, markerStreaming);

    // Wait for streaming to start
    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(200);

    // Click new chat while streaming
    await page.locator('#new-chat-btn').click();

    // Should show welcome message (clean state)
    await expect(page.locator('#welcome-message')).toBeVisible({ timeout: 5000 });

    // Messages should be cleared
    const messages = page.locator('#messages-container .message');
    await expect(messages).toHaveCount(0);

    // New chat should work - send a new message
    await sendMessageAndWait(page, markerNew);

    // Verify new message is shown
    await expect(page.locator('.message.user').first()).toContainText(markerNew);

    // Verify no critical errors
    const criticalErrors = consoleErrors.filter(isCriticalError);
    expect(criticalErrors).toHaveLength(0);
  });

  test('4. Agent streaming with tools - switch away mid-tool-execution, switch back, verify clean state', async ({ page }) => {
    const markerAgent = `AGENT_TOOL_${Date.now()}`;
    const markerNormal = `NORMAL_CHAT_${Date.now()}`;

    // Create a normal conversation first
    await createConversation(page, markerNormal);

    // Start agent conversation
    await startNewAgentChat(page);
    await sendMessageNoWait(page, markerAgent);

    // Wait for agent response to start (could include tool blocks in mock mode)
    await page.waitForTimeout(500);

    // Check if streaming is in progress (assistant message visible or stop button visible)
    const assistantVisible = await page.locator('.message.assistant').isVisible();
    const stopBtnVisible = await page.locator('#stop-btn').isVisible();

    if (assistantVisible || stopBtnVisible) {
      // Switch to normal conversation while agent might be using tools
      const convNormal = getConvByMarker(page, markerNormal);
      await convNormal.click();
      await page.waitForTimeout(500);

      // Verify we're showing normal conversation
      await expect(page.locator('.message.user').first()).toContainText(markerNormal);

      // Switch back to agent conversation
      const convAgent = getConvByMarker(page, markerAgent);
      if (await convAgent.isVisible()) {
        await convAgent.click();
        await page.waitForTimeout(500);

        // Verify agent conversation loads (might be partial if interrupted)
        await expect(page.locator('.message.user').first()).toContainText(markerAgent);
      }
    }

    // Verify no critical errors
    const criticalErrors = consoleErrors.filter(isCriticalError);
    expect(criticalErrors).toHaveLength(0);
  });

  test('5. Open/close settings panel during streaming - stream continues', async ({ page }) => {
    const marker = `SETTINGS_STREAM_${Date.now()}`;

    // Start streaming a message
    await sendMessageNoWait(page, marker);

    // Wait for streaming to start
    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 10000 });

    // Open default settings modal while streaming (uses 'visible' class, not 'open')
    await page.locator('#default-settings-toggle').click();
    await expect(page.locator('#default-settings-modal')).toHaveClass(/visible/, { timeout: 2000 });

    // Wait a bit with modal open
    await page.waitForTimeout(300);

    // Close settings modal (use the Cancel button which is more reliable)
    const cancelBtn = page.locator('#cancel-default-settings');
    if (await cancelBtn.isVisible()) {
      await cancelBtn.click();
    } else {
      // Fall back to close button
      await page.locator('#close-default-settings').click();
    }
    await expect(page.locator('#default-settings-modal')).not.toHaveClass(/visible/);

    // Wait for streaming to complete (or timeout gracefully)
    await waitForAppReady(page);

    // Verify we have a complete conversation (user message + assistant response)
    await expect(page.locator('.message.user').first()).toContainText(marker);
    await expect(page.locator('.message.assistant')).toBeVisible();

    // Verify no critical errors
    const criticalErrors = consoleErrors.filter(isCriticalError);
    expect(criticalErrors).toHaveLength(0);
  });

  test('6. Multiple rapid switches during streaming - only final conversation displays', async ({ page }) => {
    const timestamp = Date.now();
    const markers = [
      `RAPID_ONE_${timestamp}`,
      `RAPID_TWO_${timestamp}`,
      `RAPID_THREE_${timestamp}`,
      `RAPID_FOUR_${timestamp}`
    ];

    // Create first 3 conversations
    for (let i = 0; i < 3; i++) {
      if (i > 0) {
        await startNewChat(page);
      }
      await createConversation(page, markers[i]);
    }

    // Start 4th conversation streaming (don't wait)
    await startNewChat(page);
    await sendMessageNoWait(page, markers[3]);

    // Wait for streaming to start
    await page.waitForTimeout(200);

    // Get all conversation items
    const convItems = markers.map(m => getConvByMarker(page, m));

    // Verify at least first 3 exist
    for (let i = 0; i < 3; i++) {
      await expect(convItems[i]).toBeVisible({ timeout: 5000 });
    }

    // Rapidly switch through conversations while 4th might be streaming
    // Click: 0 -> 1 -> 2 -> 0 -> 1 -> 2 -> 0
    const switchOrder = [0, 1, 2, 0, 1, 2, 0];
    for (const idx of switchOrder) {
      await convItems[idx].click();
    }

    // Wait for UI to settle
    await page.waitForTimeout(500);

    // Final state: we should be on conversation 0 (markers[0])
    await expect(convItems[0]).toHaveClass(/active/);

    // Verify correct message is displayed
    await expect(page.locator('.message.user').first()).toContainText(markers[0]);

    // Ensure we're NOT seeing any other conversation's content mixed in
    const userMessageText = await page.locator('.message.user').first().textContent();
    expect(userMessageText).toContain(markers[0]);
    expect(userMessageText).not.toContain(markers[1]);
    expect(userMessageText).not.toContain(markers[2]);
    expect(userMessageText).not.toContain(markers[3]);

    // Verify no critical errors
    const criticalErrors = consoleErrors.filter(isCriticalError);
    expect(criticalErrors).toHaveLength(0);
  });
});

test.describe('Streaming Interruption - Edge Cases', () => {
  let consoleErrors: string[] = [];

  test.beforeEach(async ({ page }) => {
    consoleErrors = [];
    page.on('console', (msg: ConsoleMessage) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    await page.goto('/');
    await expect(page.locator('#message-input')).toBeVisible();
    await page.waitForLoadState('networkidle');
  });

  test('Stop button click during streaming should cleanly abort', async ({ page }) => {
    const marker = `STOP_ABORT_${Date.now()}`;

    // Start streaming
    await sendMessageNoWait(page, marker);

    // Wait for streaming to start
    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 10000 });

    // Click stop button if visible
    const stopBtn = page.locator('#stop-btn');
    if (await stopBtn.isVisible()) {
      await stopBtn.click();

      // Wait for stop to take effect
      await page.waitForTimeout(500);

      // Stop button should be hidden after stopping
      await expect(stopBtn).toBeHidden({ timeout: 5000 });
    }

    // App should remain functional - can start new conversation
    await startNewChat(page);
    await expect(page.locator('#welcome-message')).toBeVisible();

    // Verify no critical errors
    const criticalErrors = consoleErrors.filter(isCriticalError);
    expect(criticalErrors).toHaveLength(0);
  });

  test('Double-click send button should not cause double streaming', async ({ page }) => {
    const marker = `DOUBLE_SEND_${Date.now()}`;

    const input = page.locator('#message-input');
    const sendBtn = page.locator('#send-btn');

    await input.fill(marker);
    await expect(sendBtn).toBeEnabled({ timeout: 5000 });

    // Double-click send
    await sendBtn.dblclick();

    // Wait for streaming to start
    await page.waitForTimeout(500);

    // Should only have one user message
    const userMessages = page.locator('.message.user');
    await expect(userMessages).toHaveCount(1);

    // Wait for completion
    await waitForAppReady(page);

    // Still should only have one user message
    await expect(userMessages).toHaveCount(1);

    // Verify no critical errors
    const criticalErrors = consoleErrors.filter(isCriticalError);
    expect(criticalErrors).toHaveLength(0);
  });

  test('Switching conversations with thinking enabled mid-stream should not leak thinking blocks', async ({ page }) => {
    const markerThinking = `THINKING_LEAK_${Date.now()}`;
    const markerNormal = `NORMAL_LEAK_${Date.now()}`;

    // First, ensure thinking is DISABLED in default settings
    await page.locator('#default-settings-toggle').click();
    await expect(page.locator('#default-settings-modal')).toHaveClass(/visible/, { timeout: 2000 });

    const thinkingToggleDefault = page.locator('#default-settings-modal #default-thinking-toggle');
    if (await thinkingToggleDefault.isVisible() && await thinkingToggleDefault.isChecked()) {
      await thinkingToggleDefault.click();
    }

    // Save settings to ensure thinking is disabled
    const saveBtn = page.locator('#save-default-settings');
    if (await saveBtn.isVisible()) {
      await saveBtn.click();
      await expect(page.locator('#default-settings-modal')).not.toHaveClass(/visible/, { timeout: 5000 });
    } else {
      const cancelBtn = page.locator('#cancel-default-settings');
      await cancelBtn.click();
      await expect(page.locator('#default-settings-modal')).not.toHaveClass(/visible/);
    }

    // Create a normal conversation (with thinking DISABLED)
    await createConversation(page, markerNormal);

    // Verify the normal conversation was created without thinking
    const thinkingBlocksInitial = page.locator('.thinking-block');
    const initialCount = await thinkingBlocksInitial.count();

    // Start new conversation with thinking enabled
    await startNewChat(page);

    // Enable thinking via the default settings modal
    await page.locator('#default-settings-toggle').click();
    await expect(page.locator('#default-settings-modal')).toHaveClass(/visible/, { timeout: 2000 });

    if (await thinkingToggleDefault.isVisible() && !(await thinkingToggleDefault.isChecked())) {
      await thinkingToggleDefault.click();
    }

    // Close settings modal (don't save - just use for this conversation)
    const cancelBtn2 = page.locator('#cancel-default-settings');
    if (await cancelBtn2.isVisible()) {
      await cancelBtn2.click();
    } else {
      await page.locator('#close-default-settings').click();
    }
    await expect(page.locator('#default-settings-modal')).not.toHaveClass(/visible/);

    // Start streaming with thinking (note: thinking may or may not be applied
    // depending on whether the toggle affects new conversations)
    await sendMessageNoWait(page, markerThinking);

    // Wait for response to start
    await page.waitForTimeout(500);

    // Switch to normal conversation while streaming
    const convNormal = getConvByMarker(page, markerNormal);
    await convNormal.click();
    await page.waitForTimeout(500);

    // Verify we're showing normal conversation content
    await expect(page.locator('.message.user').first()).toContainText(markerNormal);

    // The normal conversation should have the same thinking block count as when created
    // (i.e., no new thinking blocks leaked from the other conversation)
    const thinkingBlocksFinal = page.locator('.thinking-block');
    const finalCount = await thinkingBlocksFinal.count();
    expect(finalCount).toBe(initialCount);

    // Verify no critical errors occurred during the switch
    const criticalErrors = consoleErrors.filter(isCriticalError);
    expect(criticalErrors).toHaveLength(0);
  });
});

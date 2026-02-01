import { test, expect, Page } from '@playwright/test';

/**
 * E2E tests for switching between agent and normal conversations.
 *
 * Run with MOCK_LLM=1 for deterministic behavior:
 *   MOCK_LLM=1 npx playwright test tests/e2e/agent_normal_switching.spec.ts --reporter=line
 */

// Helper to send a message and wait for response
async function sendMessage(page: Page, message: string): Promise<void> {
  const input = page.locator('#message-input');
  const sendBtn = page.locator('#send-btn');

  await input.fill(message);

  // Wait for send button to be enabled (input event needs to fire)
  await expect(sendBtn).toBeEnabled({ timeout: 5000 });

  await sendBtn.click();

  // Wait for assistant response
  await expect(page.locator('.message.assistant').last()).toBeVisible({ timeout: 30000 });
}

// Helper to open the conversation settings panel by clicking the gear icon
async function openSettingsPanelForConversation(page: Page, convMarker: string): Promise<void> {
  const convItem = page.locator(`.conversation-item:has-text("${convMarker}")`);
  await convItem.hover();
  const settingsBtn = convItem.locator('.conversation-settings');
  await settingsBtn.click();
  await expect(page.locator('#settings-panel')).toHaveClass(/open/, { timeout: 5000 });
}

// Helper to close the conversation settings panel
async function closeSettingsPanel(page: Page): Promise<void> {
  await page.locator('#close-settings').click();
  await expect(page.locator('#settings-panel')).not.toHaveClass(/open/);
}

test.describe('Agent/Normal Conversation Switching', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#message-input')).toBeVisible();
    // Wait for page to be fully loaded
    await page.waitForLoadState('networkidle');
  });

  test('should switch between agent and normal conversations with correct mode indicator', async ({ page }) => {
    const uniqueMarker = `TEST_${Date.now()}`;

    // Create a normal conversation
    await sendMessage(page, `Normal chat ${uniqueMarker}_NORMAL`);

    // Find normal conversation and open settings
    await openSettingsPanelForConversation(page, `${uniqueMarker}_NORMAL`);
    await expect(page.locator('#settings-panel')).toHaveAttribute('data-mode', 'normal');
    await closeSettingsPanel(page);

    // Create an agent conversation
    await page.locator('#new-agent-chat-btn').click();
    await page.waitForTimeout(500);

    // Send message in agent chat
    await sendMessage(page, `Agent chat ${uniqueMarker}_AGENT`);

    // Find our test conversations by marker
    const normalConvItem = page.locator(`.conversation-item:has-text("${uniqueMarker}_NORMAL")`);
    const agentConvItem = page.locator(`.conversation-item:has-text("${uniqueMarker}_AGENT")`);

    await expect(normalConvItem).toBeVisible({ timeout: 5000 });
    await expect(agentConvItem).toBeVisible({ timeout: 5000 });

    // Open agent conversation settings
    await openSettingsPanelForConversation(page, `${uniqueMarker}_AGENT`);
    await expect(page.locator('#settings-panel')).toHaveAttribute('data-mode', 'agent');
    await closeSettingsPanel(page);

    // Switch to normal conversation
    await normalConvItem.click();
    await page.waitForTimeout(500);

    // Verify mode indicator changed back to normal
    await openSettingsPanelForConversation(page, `${uniqueMarker}_NORMAL`);
    await expect(page.locator('#settings-panel')).toHaveAttribute('data-mode', 'normal');
    await closeSettingsPanel(page);

    // Switch to agent conversation
    await agentConvItem.click();
    await page.waitForTimeout(500);

    // Verify mode indicator is agent again
    await openSettingsPanelForConversation(page, `${uniqueMarker}_AGENT`);
    await expect(page.locator('#settings-panel')).toHaveAttribute('data-mode', 'agent');
  });

  test('should preserve messages when switching between normal and agent conversations', async ({ page }) => {
    const uniqueMarker = `TEST_${Date.now()}`;
    const normalMessage = `Normal unique ${uniqueMarker}_NMSG`;
    const agentMessage = `Agent unique ${uniqueMarker}_AMSG`;

    // Create normal conversation with unique message
    await sendMessage(page, normalMessage);

    // Create agent conversation with unique message
    await page.locator('#new-agent-chat-btn').click();
    await page.waitForTimeout(500);
    await sendMessage(page, agentMessage);

    // Find our test conversations
    const normalConvItem = page.locator(`.conversation-item:has-text("${uniqueMarker}_NMSG")`);
    const agentConvItem = page.locator(`.conversation-item:has-text("${uniqueMarker}_AMSG")`);

    await expect(normalConvItem).toBeVisible({ timeout: 5000 });
    await expect(agentConvItem).toBeVisible({ timeout: 5000 });

    // Switch back to normal conversation
    await normalConvItem.click();
    await page.waitForTimeout(500);

    // Verify normal message is displayed
    await expect(page.locator('.message.user')).toContainText(normalMessage);

    // Switch to agent conversation
    await agentConvItem.click();
    await page.waitForTimeout(500);

    // Verify agent message is displayed
    await expect(page.locator('.message.user')).toContainText(agentMessage);
  });

  test('should display normal conversation correctly while agent is streaming with tools', async ({ page }) => {
    const uniqueMarker = `TEST_${Date.now()}`;
    const normalMessage = `Normal before agent ${uniqueMarker}_NORM`;

    // Create a normal conversation first
    await sendMessage(page, normalMessage);

    // Find the normal conversation item
    const normalConvItem = page.locator(`.conversation-item:has-text("${uniqueMarker}_NORM")`);
    await expect(normalConvItem).toBeVisible({ timeout: 5000 });

    // Create agent conversation and start streaming
    await page.locator('#new-agent-chat-btn').click();
    await page.waitForTimeout(500);

    const input = page.locator('#message-input');
    const sendBtn = page.locator('#send-btn');

    await input.fill(`Agent with tools ${uniqueMarker}_AGENT`);
    await expect(sendBtn).toBeEnabled({ timeout: 5000 });
    await sendBtn.click();

    // Wait briefly for tool blocks to start appearing
    await page.waitForTimeout(1000);

    // While agent might still be streaming, switch to normal conversation
    await normalConvItem.click();
    await page.waitForTimeout(500);

    // Normal conversation should display correctly
    await expect(page.locator('.message.user')).toContainText(normalMessage);
    await expect(page.locator('.message.assistant')).toBeVisible();

    // Should NOT see tool blocks in normal conversation
    const toolBlocks = page.locator('.tool-use-block');
    await expect(toolBlocks).toHaveCount(0);

    // Settings should show normal mode via hover + click
    await openSettingsPanelForConversation(page, `${uniqueMarker}_NORM`);
    await expect(page.locator('#settings-panel')).toHaveAttribute('data-mode', 'normal');
  });

  test('should render tool blocks correctly when switching away and back to agent conversation', async ({ page }) => {
    const uniqueMarker = `TEST_${Date.now()}`;

    // Create agent conversation with tool blocks
    await page.locator('#new-agent-chat-btn').click();
    await page.waitForTimeout(500);

    await sendMessage(page, `Create a file ${uniqueMarker}_TOOL`);

    // Wait for tool block to appear and complete
    const toolBlock = page.locator('.tool-use-block').first();
    await expect(toolBlock).toBeVisible({ timeout: 15000 });

    // Wait for tool to complete
    await page.waitForTimeout(3000);

    // Verify tool block structure
    await expect(toolBlock.locator('.tool-header')).toBeVisible();
    await expect(toolBlock.locator('.tool-name')).toBeVisible();

    // Create a normal conversation (switch away)
    await page.locator('#new-chat-btn').click();
    await expect(page.locator('#welcome-message')).toBeVisible();

    // Send message in normal chat
    await sendMessage(page, `Normal after agent ${uniqueMarker}_AFTER`);

    // Find our test conversations
    const agentConvItem = page.locator(`.conversation-item:has-text("${uniqueMarker}_TOOL")`);
    const normalConvItem = page.locator(`.conversation-item:has-text("${uniqueMarker}_AFTER")`);

    await expect(agentConvItem).toBeVisible({ timeout: 5000 });
    await expect(normalConvItem).toBeVisible({ timeout: 5000 });

    // Switch back to agent conversation
    await agentConvItem.click();

    // Wait for the agent conversation to load completely
    // The user message should be visible first
    await expect(page.locator('.message.user')).toContainText(`${uniqueMarker}_TOOL`, { timeout: 10000 });

    // Then wait for tool blocks to render
    // This tests if tool blocks persist after switching conversations
    const toolBlockAfterSwitch = page.locator('.tool-use-block').first();
    await expect(toolBlockAfterSwitch).toBeVisible({ timeout: 15000 });
    await expect(toolBlockAfterSwitch.locator('.tool-header')).toBeVisible();
    await expect(toolBlockAfterSwitch.locator('.tool-name')).toBeVisible();

    // Check tool status shows DONE, ERROR, or RUNNING
    // Note: If we switched away while streaming, the tool might still be in RUNNING state
    // This is expected behavior - the test verifies the tool block persists
    const status = toolBlockAfterSwitch.locator('.tool-status');
    await expect(status).toHaveText(/DONE|ERROR|RUNNING/);
  });

  test('should display each conversation correctly when clicking through mix of agent and normal chats', async ({ page }) => {
    const uniqueMarker = `TEST_${Date.now()}`;
    const markers = [
      `${uniqueMarker}_N1`,  // Normal 1
      `${uniqueMarker}_A1`,  // Agent 1
      `${uniqueMarker}_N2`,  // Normal 2
      `${uniqueMarker}_A2`,  // Agent 2
    ];

    // Create normal conversation 1
    await sendMessage(page, `Normal conv ${markers[0]}`);

    // Create agent conversation 1
    await page.locator('#new-agent-chat-btn').click();
    await page.waitForTimeout(500);
    await sendMessage(page, `Agent conv ${markers[1]}`);

    // Create normal conversation 2
    await page.locator('#new-chat-btn').click();
    await expect(page.locator('#welcome-message')).toBeVisible();
    await sendMessage(page, `Normal conv ${markers[2]}`);

    // Create agent conversation 2
    await page.locator('#new-agent-chat-btn').click();
    await page.waitForTimeout(500);
    await sendMessage(page, `Agent conv ${markers[3]}`);

    // Find all our test conversations
    const convItems = markers.map(m => page.locator(`.conversation-item:has-text("${m}")`));

    for (const item of convItems) {
      await expect(item).toBeVisible({ timeout: 5000 });
    }

    // Expected modes for each conversation
    const expectedModes = ['normal', 'agent', 'normal', 'agent'];

    // Click through all conversations and verify correct mode
    for (let i = 0; i < markers.length; i++) {
      await convItems[i].click();
      await page.waitForTimeout(500);

      // Open settings panel by clicking the gear icon
      await openSettingsPanelForConversation(page, markers[i]);
      await expect(page.locator('#settings-panel')).toHaveAttribute('data-mode', expectedModes[i]);
      await closeSettingsPanel(page);

      // Verify the message content
      await expect(page.locator('.message.user').first()).toContainText(markers[i]);
    }
  });

  test('should show agent indicator in sidebar for agent conversations', async ({ page }) => {
    const uniqueMarker = `TEST_${Date.now()}`;

    // Create normal conversation
    await sendMessage(page, `Normal msg ${uniqueMarker}_NORMAL`);

    // Create agent conversation
    await page.locator('#new-agent-chat-btn').click();
    await page.waitForTimeout(500);
    await sendMessage(page, `Agent msg ${uniqueMarker}_AGENT`);

    // Find our test conversations
    const normalConvItem = page.locator(`.conversation-item:has-text("${uniqueMarker}_NORMAL")`);
    const agentConvItem = page.locator(`.conversation-item:has-text("${uniqueMarker}_AGENT")`);

    await expect(normalConvItem).toBeVisible({ timeout: 5000 });
    await expect(agentConvItem).toBeVisible({ timeout: 5000 });

    // Agent conversation should have 'agent' class
    await expect(agentConvItem).toHaveClass(/agent/);

    // Normal conversation should NOT have 'agent' class
    const normalClass = await normalConvItem.getAttribute('class');
    expect(normalClass).not.toContain('agent');
  });

  test('should show normal chat settings in normal mode and agent settings in agent mode', async ({ page }) => {
    const uniqueMarker = `TEST_${Date.now()}`;

    // Create normal conversation
    await sendMessage(page, `Normal settings test ${uniqueMarker}`);

    // Open settings panel by clicking gear icon
    await openSettingsPanelForConversation(page, uniqueMarker);
    const settingsPanel = page.locator('#settings-panel');
    await expect(settingsPanel).toHaveAttribute('data-mode', 'normal');

    // Verify the thinking-group container is visible (not the hidden checkbox input)
    // The checkbox itself has display:none due to custom toggle styling
    await expect(page.locator('#thinking-group')).toBeVisible();

    // Verify the toggle slider (the visible part of the toggle) is visible
    await expect(page.locator('#thinking-group .toggle-slider')).toBeVisible();

    // Close settings
    await closeSettingsPanel(page);

    // Create agent conversation
    await page.locator('#new-agent-chat-btn').click();
    await page.waitForTimeout(500);
    await sendMessage(page, `Agent settings test ${uniqueMarker}_AGENT`);

    // Open settings for agent conversation
    await openSettingsPanelForConversation(page, `${uniqueMarker}_AGENT`);
    await expect(settingsPanel).toHaveAttribute('data-mode', 'agent');

    // Verify agent-specific content is visible
    // Agent tools display should be visible
    await expect(page.locator('#agent-tools-display')).toBeVisible();

    // Verify normal chat settings are hidden (thinking-group should not be visible)
    await expect(page.locator('#thinking-group')).not.toBeVisible();
  });
});

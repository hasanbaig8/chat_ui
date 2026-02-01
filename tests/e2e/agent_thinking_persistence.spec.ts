import { test, expect } from '@playwright/test';

/**
 * Agent Mode Thinking Persistence Tests
 *
 * Tests that thinking blocks persist correctly in agent mode
 * when switching conversations and after page reload.
 *
 * Run with MOCK_LLM=1:
 *   MOCK_LLM=1 npx playwright test tests/e2e/agent_thinking_persistence.spec.ts --reporter=line
 */

test.describe('Agent Mode Thinking Persistence', () => {
    test('thinking blocks should persist after switching conversations', async ({ page }) => {
        await page.goto('http://localhost:8079');
        await page.waitForLoadState('networkidle');

        // Create agent conversation
        await page.locator('#new-agent-chat-btn').click();
        await page.waitForTimeout(500);

        // Send message
        await page.locator('#message-input').fill('Test agent thinking persistence');
        await page.locator('#send-btn').click();

        // Wait for thinking block to appear
        await expect(page.locator('.thinking-block').first()).toBeVisible({ timeout: 30000 });

        // Wait for stream to complete (message actions appear)
        await expect(page.locator('.message.assistant .message-actions')).toBeVisible({ timeout: 30000 });

        // Get conversation ID
        const convId = await page.locator('.conversation-item.active').getAttribute('data-id');
        expect(convId).toBeTruthy();

        // Count thinking blocks and tool blocks
        const thinkingCountBefore = await page.locator('.thinking-block').count();
        const toolCountBefore = await page.locator('.tool-use-block').count();
        const contentBefore = await page.locator('.message.assistant .message-content').textContent();

        console.log(`Before switch - Thinking: ${thinkingCountBefore}, Tools: ${toolCountBefore}, Content length: ${contentBefore?.length}`);

        expect(thinkingCountBefore).toBeGreaterThan(0);

        // Create a normal conversation (switch away)
        await page.locator('#new-chat-btn').click();
        await page.waitForTimeout(500);

        // Verify we're in a new conversation (no thinking blocks)
        await expect(page.locator('#welcome-message')).toBeVisible();
        await expect(page.locator('.thinking-block')).toHaveCount(0);

        // Switch back to agent conversation
        await page.locator(`.conversation-item[data-id="${convId}"]`).click();
        await page.waitForTimeout(1000);

        // Thinking blocks should still be visible
        const thinkingCountAfter = await page.locator('.thinking-block').count();
        const toolCountAfter = await page.locator('.tool-use-block').count();
        const contentAfter = await page.locator('.message.assistant .message-content').textContent();

        console.log(`After switch - Thinking: ${thinkingCountAfter}, Tools: ${toolCountAfter}, Content length: ${contentAfter?.length}`);

        expect(thinkingCountAfter).toBe(thinkingCountBefore);
        expect(toolCountAfter).toBe(toolCountBefore);
    });

    test('thinking blocks should persist after page reload', async ({ page }) => {
        await page.goto('http://localhost:8079');
        await page.waitForLoadState('networkidle');

        // Create agent conversation
        await page.locator('#new-agent-chat-btn').click();
        await page.waitForTimeout(500);

        // Send message
        await page.locator('#message-input').fill('Test agent thinking reload');
        await page.locator('#send-btn').click();

        // Wait for thinking block
        await expect(page.locator('.thinking-block').first()).toBeVisible({ timeout: 30000 });

        // Wait for stream to complete
        await expect(page.locator('.message.assistant .message-actions')).toBeVisible({ timeout: 30000 });

        // Get conversation ID and counts
        const convId = await page.locator('.conversation-item.active').getAttribute('data-id');
        const thinkingCountBefore = await page.locator('.thinking-block').count();
        const toolCountBefore = await page.locator('.tool-use-block').count();

        console.log(`Before reload - Thinking: ${thinkingCountBefore}, Tools: ${toolCountBefore}`);

        expect(thinkingCountBefore).toBeGreaterThan(0);

        // Reload page
        await page.reload();
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(500);

        // Click on the conversation
        await page.locator(`.conversation-item[data-id="${convId}"]`).click();
        await page.waitForTimeout(1000);

        // Verify thinking blocks persisted
        const thinkingCountAfter = await page.locator('.thinking-block').count();
        const toolCountAfter = await page.locator('.tool-use-block').count();

        console.log(`After reload - Thinking: ${thinkingCountAfter}, Tools: ${toolCountAfter}`);

        expect(thinkingCountAfter).toBe(thinkingCountBefore);
        expect(toolCountAfter).toBe(toolCountBefore);
    });
});

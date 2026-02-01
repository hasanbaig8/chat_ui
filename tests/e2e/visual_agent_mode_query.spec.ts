import { test, expect } from '@playwright/test';

test.describe('Visual Test - Agent Mode SDK Query', () => {
    // Increase timeout for agent streaming which takes longer
    test.setTimeout(120000);

    test('should display agent response for claude agent sdk forking query', async ({ page }) => {
        await page.goto('http://localhost:8079');
        await page.waitForLoadState('networkidle');

        // Create new AGENT chat
        await page.locator('#new-agent-chat-btn').click();
        await page.waitForTimeout(500);

        // Send the query
        const query = 'look up claude agent sdk docs and tell me how forking works';
        await page.locator('#message-input').fill(query);
        await page.locator('#send-btn').click();

        // Wait for assistant message to appear
        await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30000 });

        // Wait for streaming to complete - Stop button should disappear
        await expect(page.locator('#stop-btn')).toBeHidden({ timeout: 90000 });

        // Now message actions should be visible
        await expect(page.locator('.message.assistant .message-actions')).toBeVisible({ timeout: 10000 });

        // Verify user message is visible
        await expect(page.locator('.message.user')).toContainText('look up claude agent sdk');

        // Verify assistant response has content
        const assistantContent = page.locator('.message.assistant .message-content');
        await expect(assistantContent).toBeVisible();

        // Check response content
        const responseText = await assistantContent.textContent();
        expect(responseText).toBeTruthy();
        console.log(`Response length: ${responseText!.length}`);

        // Check for tool-use blocks (agent mode uses tools)
        const toolUseBlocks = page.locator('.tool-use-block');
        const toolCount = await toolUseBlocks.count();
        console.log(`Tool use blocks: ${toolCount}`);

        // Check for thinking blocks
        const thinkingBlocks = page.locator('.thinking-block');
        const thinkingCount = await thinkingBlocks.count();
        console.log(`Thinking blocks: ${thinkingCount}`);

        // Check for surface content blocks
        const surfaceBlocks = page.locator('.surface-content-block');
        const surfaceCount = await surfaceBlocks.count();
        console.log(`Surface content blocks: ${surfaceCount}`);

        // Get conversation ID
        const convId = await page.locator('.conversation-item.active').getAttribute('data-id');
        expect(convId).toBeTruthy();

        // Take screenshot
        await page.screenshot({ path: 'test-results/agent-mode-sdk-query.png', fullPage: true });
    });

    test('should persist agent response after switching and returning', async ({ page }) => {
        await page.goto('http://localhost:8079');
        await page.waitForLoadState('networkidle');

        // Create new AGENT chat
        await page.locator('#new-agent-chat-btn').click();
        await page.waitForTimeout(500);

        // Send query
        await page.locator('#message-input').fill('look up claude agent sdk docs and tell me how forking works');
        await page.locator('#send-btn').click();

        // Wait for assistant message
        await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30000 });

        // Wait for streaming to complete
        await expect(page.locator('#stop-btn')).toBeHidden({ timeout: 90000 });

        // Get conversation ID
        const convId = await page.locator('.conversation-item.active').getAttribute('data-id');

        // Count elements before switch
        const toolCountBefore = await page.locator('.tool-use-block').count();
        const thinkingCountBefore = await page.locator('.thinking-block').count();
        const assistantContentBefore = await page.locator('.message.assistant .message-content').textContent();

        console.log(`Before switch - Tools: ${toolCountBefore}, Thinking: ${thinkingCountBefore}, Content length: ${assistantContentBefore?.length}`);

        // Create a normal conversation (switch away)
        await page.locator('#new-chat-btn').click();
        await page.waitForTimeout(500);

        // Verify we're in a new conversation
        await expect(page.locator('#welcome-message')).toBeVisible();

        // Switch back to agent conversation
        await page.locator(`.conversation-item[data-id="${convId}"]`).click();
        await page.waitForTimeout(500);

        // Verify content persisted
        const toolCountAfter = await page.locator('.tool-use-block').count();
        const thinkingCountAfter = await page.locator('.thinking-block').count();
        const assistantContentAfter = await page.locator('.message.assistant .message-content').textContent();

        console.log(`After switch - Tools: ${toolCountAfter}, Thinking: ${thinkingCountAfter}, Content length: ${assistantContentAfter?.length}`);

        expect(toolCountAfter).toBe(toolCountBefore);
        expect(thinkingCountAfter).toBe(thinkingCountBefore);
        // Content should be roughly the same (allow for minor whitespace differences)
        expect(assistantContentAfter?.length).toBeGreaterThan((assistantContentBefore?.length || 0) * 0.9);
        expect(assistantContentAfter?.length).toBeLessThan((assistantContentBefore?.length || 0) * 1.1);

        // Take screenshot after switching back
        await page.screenshot({ path: 'test-results/agent-mode-sdk-query-after-switch.png', fullPage: true });
    });
});

import { test, expect } from '@playwright/test';

test.describe('Visual Test - Agent SDK Query', () => {
    test('should display response for claude agent sdk forking query', async ({ page }) => {
        await page.goto('http://localhost:8079');
        await page.waitForLoadState('networkidle');

        // Create new chat
        await page.locator('#new-chat-btn').click();
        await page.waitForTimeout(500);

        // Enable thinking for richer response
        await page.locator('#default-settings-toggle').click();
        await page.waitForTimeout(300);
        const thinkingToggle = page.locator('#thinking-toggle');
        if (await thinkingToggle.isVisible()) {
            if (!(await thinkingToggle.isChecked())) {
                await thinkingToggle.click();
            }
        }
        // Enable web search
        const webSearchToggle = page.locator('#web-search-toggle');
        if (await webSearchToggle.isVisible()) {
            if (!(await webSearchToggle.isChecked())) {
                await webSearchToggle.click();
            }
        }
        // Close settings
        const cancelBtn = page.getByRole('button', { name: 'Cancel' });
        if (await cancelBtn.isVisible()) {
            await cancelBtn.click();
        }
        await page.waitForTimeout(300);

        // Send the query
        const query = 'look up claude agent sdk docs and tell me how forking works';
        await page.locator('#message-input').fill(query);
        await page.locator('#send-btn').click();

        // Wait for response to complete (message actions appear when done)
        await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 60000 });
        await expect(page.locator('.message.assistant .message-actions')).toBeVisible({ timeout: 60000 });

        // Verify user message is visible
        await expect(page.locator('.message.user')).toContainText('look up claude agent sdk');

        // Verify assistant response has content
        const assistantContent = page.locator('.message.assistant .message-content');
        await expect(assistantContent).toBeVisible();

        // Check that the response contains relevant content (mock response)
        const responseText = await assistantContent.textContent();
        expect(responseText).toBeTruthy();
        expect(responseText!.length).toBeGreaterThan(100);

        // Verify message actions are present
        await expect(page.locator('.message.assistant .message-actions')).toBeVisible();

        // Check for thinking block if present
        const thinkingBlock = page.locator('.thinking-block');
        const hasThinking = await thinkingBlock.count() > 0;
        console.log(`Has thinking block: ${hasThinking}`);

        if (hasThinking) {
            await expect(thinkingBlock.first()).toBeVisible();
            await expect(thinkingBlock.first().locator('.thinking-status')).toHaveText('DONE');
        }

        // Check for web search block if present
        const webSearchBlock = page.locator('.web-search-block');
        const hasWebSearch = await webSearchBlock.count() > 0;
        console.log(`Has web search block: ${hasWebSearch}`);

        // Get conversation ID for persistence test
        const convId = await page.locator('.conversation-item.active').getAttribute('data-id');
        expect(convId).toBeTruthy();

        // Take a screenshot for visual reference (stored in test-results)
        await page.screenshot({ path: 'test-results/agent-sdk-query-full.png', fullPage: true });
    });

    test('should persist response after switching and returning', async ({ page }) => {
        await page.goto('http://localhost:8079');
        await page.waitForLoadState('networkidle');

        // Create new chat with thinking enabled
        await page.locator('#new-chat-btn').click();
        await page.waitForTimeout(500);

        await page.locator('#default-settings-toggle').click();
        await page.waitForTimeout(300);
        const thinkingToggle = page.locator('#thinking-toggle');
        if (await thinkingToggle.isVisible() && !(await thinkingToggle.isChecked())) {
            await thinkingToggle.click();
        }
        const cancelBtn = page.getByRole('button', { name: 'Cancel' });
        if (await cancelBtn.isVisible()) {
            await cancelBtn.click();
        }
        await page.waitForTimeout(300);

        // Send query
        await page.locator('#message-input').fill('look up claude agent sdk docs and tell me how forking works');
        await page.locator('#send-btn').click();

        // Wait for response
        await expect(page.locator('.message.assistant .message-actions')).toBeVisible({ timeout: 60000 });

        // Get conversation ID
        const convId = await page.locator('.conversation-item.active').getAttribute('data-id');

        // Count elements before switch
        const thinkingCountBefore = await page.locator('.thinking-block').count();
        const assistantContentBefore = await page.locator('.message.assistant .message-content').textContent();

        // Create another conversation
        await page.locator('#new-chat-btn').click();
        await page.waitForTimeout(500);

        // Verify we're in a new conversation (no messages)
        await expect(page.locator('#welcome-message')).toBeVisible();

        // Switch back to original conversation
        await page.locator(`.conversation-item[data-id="${convId}"]`).click();
        await page.waitForTimeout(500);

        // Verify content persisted
        const thinkingCountAfter = await page.locator('.thinking-block').count();
        const assistantContentAfter = await page.locator('.message.assistant .message-content').textContent();

        expect(thinkingCountAfter).toBe(thinkingCountBefore);
        expect(assistantContentAfter).toBe(assistantContentBefore);

        console.log(`Thinking blocks: ${thinkingCountAfter}`);
        console.log(`Content length: ${assistantContentAfter?.length}`);

        // Take screenshot after switching back
        await page.screenshot({ path: 'test-results/agent-sdk-query-after-switch.png', fullPage: true });
    });
});

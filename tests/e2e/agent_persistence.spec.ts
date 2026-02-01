import { test, expect } from '@playwright/test';

test.describe('Agent Mode Persistence', () => {
    test('tool blocks should persist after switching conversations', async ({ page }) => {
        await page.goto('http://localhost:8079');
        await page.waitForLoadState('networkidle');

        // Create agent conversation
        await page.locator('#new-agent-chat-btn').click();
        await page.waitForTimeout(500);

        // Send message
        await page.locator('#message-input').fill('Test agent tool persistence');
        await page.locator('#send-btn').click();

        // Wait for tool blocks (agent mock stream includes tool_use events)
        await expect(page.locator('.tool-use-block').first()).toBeVisible({ timeout: 30000 });

        // Wait for stream to complete
        await expect(page.locator('.message.assistant .message-actions')).toBeVisible({ timeout: 30000 });

        // Get conversation ID
        const convId = await page.locator('.conversation-item.active').getAttribute('data-id');
        expect(convId).toBeTruthy();

        // Count tool blocks
        const toolUseBlockCount = await page.locator('.tool-use-block').count();
        console.log(`Tool blocks before switch: ${toolUseBlockCount}`);
        expect(toolUseBlockCount).toBeGreaterThan(0);

        // Create a normal conversation
        await page.locator('#new-chat-btn').click();
        await page.waitForTimeout(500);

        // Verify no tool blocks in normal chat
        await expect(page.locator('.tool-use-block')).toHaveCount(0);

        // Switch back to agent conversation
        await page.locator(`.conversation-item[data-id="${convId}"]`).click();
        await page.waitForTimeout(500);

        // Tool blocks should still be visible
        const toolUseBlockCountAfter = await page.locator('.tool-use-block').count();
        console.log(`Tool blocks after switch: ${toolUseBlockCountAfter}`);
        expect(toolUseBlockCountAfter).toBe(toolUseBlockCount);
    });

    test('tool blocks should persist after page reload', async ({ page }) => {
        await page.goto('http://localhost:8079');
        await page.waitForLoadState('networkidle');

        // Create agent conversation
        await page.locator('#new-agent-chat-btn').click();
        await page.waitForTimeout(500);

        // Send message
        await page.locator('#message-input').fill('Test agent reload persistence');
        await page.locator('#send-btn').click();

        // Wait for tool blocks
        await expect(page.locator('.tool-use-block').first()).toBeVisible({ timeout: 30000 });

        // Wait for stream to complete
        await expect(page.locator('.message.assistant .message-actions')).toBeVisible({ timeout: 30000 });

        // Get conversation ID and tool count
        const convId = await page.locator('.conversation-item.active').getAttribute('data-id');
        const toolUseBlockCount = await page.locator('.tool-use-block').count();
        console.log(`Tool blocks before reload: ${toolUseBlockCount}`);

        // Reload page
        await page.reload();
        await page.waitForLoadState('networkidle');

        // Click on the conversation
        await page.locator(`.conversation-item[data-id="${convId}"]`).click();
        await page.waitForTimeout(500);

        // Tool blocks should persist
        const toolUseBlockCountAfter = await page.locator('.tool-use-block').count();
        console.log(`Tool blocks after reload: ${toolUseBlockCountAfter}`);
        expect(toolUseBlockCountAfter).toBe(toolUseBlockCount);
    });
});

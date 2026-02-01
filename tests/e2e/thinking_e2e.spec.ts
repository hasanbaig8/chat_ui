import { test, expect } from '@playwright/test';

test.describe('Thinking Block End-to-End', () => {
    test('complete thinking workflow: stream, display, save, reload, switch', async ({ page }) => {
        await page.goto('http://localhost:8079');
        await page.waitForLoadState('networkidle');

        // Step 1: Create new chat
        await page.locator('#new-chat-btn').click();
        await page.waitForTimeout(500);

        // Step 2: Enable thinking
        await page.locator('#default-settings-toggle').click();
        await page.waitForTimeout(300);
        const thinkingToggle = page.locator('#thinking-toggle');
        if (await thinkingToggle.isVisible()) {
            if (!(await thinkingToggle.isChecked())) {
                await thinkingToggle.click();
            }
        }
        const cancelBtn = page.getByRole('button', { name: 'Cancel' });
        if (await cancelBtn.isVisible()) {
            await cancelBtn.click();
        }
        await page.waitForTimeout(300);

        // Step 3: Send message
        await page.locator('#message-input').fill('E2E thinking test');
        await page.locator('#send-btn').click();

        // Step 4: Verify thinking block appears during streaming
        const thinkingBlock = page.locator('.thinking-block').first();
        await expect(thinkingBlock).toBeVisible({ timeout: 30000 });

        // Step 5: Verify DONE status after streaming
        await expect(thinkingBlock.locator('.thinking-status')).toHaveText('DONE', { timeout: 30000 });

        // Step 6: Verify thinking block is BEFORE text in DOM order
        const assistantContent = page.locator('.message.assistant .message-content');
        const children = await assistantContent.locator('> *').all();
        expect(children.length).toBeGreaterThanOrEqual(2);

        const firstChild = await assistantContent.locator('> *:first-child');
        expect(await firstChild.getAttribute('class')).toContain('thinking-block');

        // Step 7: Get conversation ID
        const convItem = page.locator('.conversation-item.active');
        const convId = await convItem.getAttribute('data-id');
        expect(convId).toBeTruthy();

        // Step 8: Expand thinking block and get content
        await thinkingBlock.locator('.thinking-header').click();
        await page.waitForTimeout(200);
        const thinkingContent = await thinkingBlock.locator('.thinking-inner').textContent();
        expect(thinkingContent!.length).toBeGreaterThan(10);

        // Step 9: Create second conversation
        await page.locator('#new-chat-btn').click();
        await page.waitForTimeout(500);
        await page.locator('#message-input').fill('Second chat');
        await page.locator('#send-btn').click();
        await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30000 });

        // Step 10: Switch back to first conversation
        await page.locator(`.conversation-item[data-id="${convId}"]`).click();
        await page.waitForTimeout(500);

        // Step 11: Verify thinking block persisted
        const restoredThinking = page.locator('.thinking-block').first();
        await expect(restoredThinking).toBeVisible();
        await expect(restoredThinking.locator('.thinking-status')).toHaveText('DONE');

        // Step 12: Verify content preserved
        await restoredThinking.locator('.thinking-header').click();
        await page.waitForTimeout(200);
        const restoredContent = await restoredThinking.locator('.thinking-inner').textContent();
        expect(restoredContent).toBe(thinkingContent);

        // Step 13: Reload page
        await page.reload();
        await page.waitForLoadState('networkidle');

        // Step 14: Click on conversation
        await page.locator(`.conversation-item[data-id="${convId}"]`).click();
        await page.waitForTimeout(500);

        // Step 15: Final verification
        const finalThinking = page.locator('.thinking-block').first();
        await expect(finalThinking).toBeVisible();
        await expect(finalThinking.locator('.thinking-status')).toHaveText('DONE');

        // Verify order preserved after reload
        const finalContent = page.locator('.message.assistant .message-content');
        const finalFirstChild = await finalContent.locator('> *:first-child');
        expect(await finalFirstChild.getAttribute('class')).toContain('thinking-block');

        // Verify content preserved after reload
        await finalThinking.locator('.thinking-header').click();
        await page.waitForTimeout(200);
        const finalThinkingContent = await finalThinking.locator('.thinking-inner').textContent();
        expect(finalThinkingContent).toBe(thinkingContent);
    });
});

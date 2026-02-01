import { test, expect } from '@playwright/test';

test.describe('Thinking Block Comprehensive Tests', () => {
    test('thinking blocks should persist after switching conversations', async ({ page }) => {
        await page.goto('http://localhost:8079');
        await page.waitForLoadState('networkidle');

        // Start a new normal chat
        await page.locator('#new-chat-btn').click();
        await page.waitForTimeout(500);

        // Enable thinking in settings
        await page.locator('#default-settings-toggle').click();
        await page.waitForTimeout(300);

        const thinkingToggle = page.locator('#thinking-toggle');
        if (await thinkingToggle.isVisible()) {
            const isChecked = await thinkingToggle.isChecked();
            if (!isChecked) {
                await thinkingToggle.click();
            }
        }

        const cancelBtn = page.getByRole('button', { name: 'Cancel' });
        if (await cancelBtn.isVisible()) {
            await cancelBtn.click();
        }
        await page.waitForTimeout(300);

        // Send a message
        await page.locator('#message-input').fill('Test thinking persistence across conversations');
        await page.locator('#send-btn').click();

        // Wait for response with thinking block
        await expect(page.locator('.thinking-block').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('.thinking-block .thinking-status').first()).toHaveText('DONE', { timeout: 30000 });

        // Get conversation ID
        const convItem = page.locator('.conversation-item.active');
        const firstConvId = await convItem.getAttribute('data-id');
        expect(firstConvId).toBeTruthy();

        // Create a second conversation
        await page.locator('#new-chat-btn').click();
        await page.waitForTimeout(500);

        // Send a message in the second conversation
        await page.locator('#message-input').fill('Second conversation test');
        await page.locator('#send-btn').click();
        await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30000 });

        // Switch back to first conversation
        await page.locator(`.conversation-item[data-id="${firstConvId}"]`).click();
        await page.waitForTimeout(500);

        // Thinking block should still be visible
        await expect(page.locator('.thinking-block').first()).toBeVisible({ timeout: 5000 });
        await expect(page.locator('.thinking-block .thinking-status').first()).toHaveText('DONE');
    });

    test('thinking blocks should be in correct order after reload', async ({ page }) => {
        await page.goto('http://localhost:8079');
        await page.waitForLoadState('networkidle');

        // Start a new normal chat
        await page.locator('#new-chat-btn').click();
        await page.waitForTimeout(500);

        // Enable thinking in settings
        await page.locator('#default-settings-toggle').click();
        await page.waitForTimeout(300);
        const thinkingToggle = page.locator('#thinking-toggle');
        if (await thinkingToggle.isVisible()) {
            const isChecked = await thinkingToggle.isChecked();
            if (!isChecked) {
                await thinkingToggle.click();
            }
        }
        const cancelBtn = page.getByRole('button', { name: 'Cancel' });
        if (await cancelBtn.isVisible()) {
            await cancelBtn.click();
        }
        await page.waitForTimeout(300);

        // Send a message
        await page.locator('#message-input').fill('Test thinking order');
        await page.locator('#send-btn').click();

        // Wait for response with thinking block
        await expect(page.locator('.thinking-block').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('.thinking-block .thinking-status').first()).toHaveText('DONE', { timeout: 30000 });

        // Get conversation ID
        const convItem = page.locator('.conversation-item.active');
        const convId = await convItem.getAttribute('data-id');

        // Check order: thinking block should come before text
        const messageContent = page.locator('.message.assistant .message-content');
        const firstChild = await messageContent.locator('> *:first-child');
        await expect(firstChild).toHaveClass(/thinking-block/);

        // Reload page
        await page.reload();
        await page.waitForLoadState('networkidle');

        // Click on the same conversation
        await page.locator(`.conversation-item[data-id="${convId}"]`).click();
        await page.waitForTimeout(500);

        // Verify order is preserved
        const messageContentAfter = page.locator('.message.assistant .message-content');
        const firstChildAfter = await messageContentAfter.locator('> *:first-child');
        await expect(firstChildAfter).toHaveClass(/thinking-block/);
    });

    test('thinking block content should be preserved after reload', async ({ page }) => {
        await page.goto('http://localhost:8079');
        await page.waitForLoadState('networkidle');

        // Start a new normal chat
        await page.locator('#new-chat-btn').click();
        await page.waitForTimeout(500);

        // Enable thinking in settings
        await page.locator('#default-settings-toggle').click();
        await page.waitForTimeout(300);
        const thinkingToggle = page.locator('#thinking-toggle');
        if (await thinkingToggle.isVisible()) {
            const isChecked = await thinkingToggle.isChecked();
            if (!isChecked) {
                await thinkingToggle.click();
            }
        }
        const cancelBtn = page.getByRole('button', { name: 'Cancel' });
        if (await cancelBtn.isVisible()) {
            await cancelBtn.click();
        }
        await page.waitForTimeout(300);

        // Send a message
        await page.locator('#message-input').fill('Test thinking content');
        await page.locator('#send-btn').click();

        // Wait for response with thinking block
        await expect(page.locator('.thinking-block').first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('.thinking-block .thinking-status').first()).toHaveText('DONE', { timeout: 30000 });

        // Expand the thinking block to see content
        await page.locator('.thinking-block .thinking-header').first().click();
        await page.waitForTimeout(200);

        // Get thinking content
        const thinkingContent = await page.locator('.thinking-block .thinking-inner').first().textContent();
        expect(thinkingContent).toBeTruthy();
        expect(thinkingContent!.length).toBeGreaterThan(10);

        // Get conversation ID
        const convItem = page.locator('.conversation-item.active');
        const convId = await convItem.getAttribute('data-id');

        // Reload page
        await page.reload();
        await page.waitForLoadState('networkidle');

        // Click on the same conversation
        await page.locator(`.conversation-item[data-id="${convId}"]`).click();
        await page.waitForTimeout(500);

        // Expand thinking block
        await page.locator('.thinking-block .thinking-header').first().click();
        await page.waitForTimeout(200);

        // Content should be the same
        const thinkingContentAfter = await page.locator('.thinking-block .thinking-inner').first().textContent();
        expect(thinkingContentAfter).toBe(thinkingContent);
    });
});

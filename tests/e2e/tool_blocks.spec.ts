import { test, expect } from '@playwright/test';

test.describe('Tool Block Rendering', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:8079');
    await page.waitForLoadState('networkidle');
  });

  test('should render tool blocks with proper structure in agent mode', async ({ page }) => {
    // Start agent chat
    await page.locator('#new-agent-chat-btn').click();
    await page.waitForTimeout(500);

    // Send a message
    await page.locator('#message-input').fill('Test tool blocks');
    await page.locator('#send-btn').click();

    // Wait for tool block to appear
    const toolBlock = page.locator('.tool-use-block').first();
    await expect(toolBlock).toBeVisible({ timeout: 15000 });

    // Check header elements
    const header = toolBlock.locator('.tool-header');
    await expect(header).toBeVisible();
    await expect(header.locator('.tool-expand-icon')).toBeVisible();
    await expect(header.locator('.tool-icon')).toBeVisible();
    await expect(header.locator('.tool-name')).toBeVisible();
    await expect(header.locator('.tool-status')).toBeVisible();

    // Wait for result
    await page.waitForTimeout(3000);

    // Check that status updates to DONE
    const status = toolBlock.locator('.tool-status');
    await expect(status).toHaveText(/DONE|ERROR/);

    // Check content structure
    const content = toolBlock.locator('.tool-content');
    await expect(content).toBeVisible();

    // Check INPUT section
    const inputSection = toolBlock.locator('.tool-input');
    await expect(inputSection).toBeVisible();
    await expect(inputSection.locator('.tool-section-label')).toHaveText('INPUT');

    // Check RESULT section
    const resultSection = toolBlock.locator('.tool-result');
    await expect(resultSection).toBeVisible();
    await expect(resultSection.locator('.tool-section-label')).toHaveText('RESULT');
  });

  test('should collapse and expand tool blocks', async ({ page }) => {
    // Start agent chat
    await page.locator('#new-agent-chat-btn').click();
    await page.waitForTimeout(500);

    // Send a message
    await page.locator('#message-input').fill('Test collapse');
    await page.locator('#send-btn').click();

    // Wait for tool block
    const toolBlock = page.locator('.tool-use-block').first();
    await expect(toolBlock).toBeVisible({ timeout: 15000 });

    // Wait for result
    await page.waitForTimeout(3000);

    // Content should be visible initially
    const content = toolBlock.locator('.tool-content');
    await expect(content).toBeVisible();

    // Click header to collapse
    await toolBlock.locator('.tool-header').click();

    // Content should be hidden
    await expect(toolBlock).toHaveClass(/collapsed/);

    // Expand icon should change to ▶
    const expandIcon = toolBlock.locator('.tool-expand-icon');
    await expect(expandIcon).toHaveText('▶');

    // Click again to expand
    await toolBlock.locator('.tool-header').click();

    // Content should be visible again
    await expect(toolBlock).not.toHaveClass(/collapsed/);
    await expect(expandIcon).toHaveText('▼');
  });

  test('dev UI should show tool block fixtures', async ({ page }) => {
    await page.goto('http://localhost:8079/dev/ui');
    await page.waitForLoadState('networkidle');

    // Check running tool block
    const runningFixture = page.locator('[data-testid="fixture-tool-use-running"]');
    await expect(runningFixture).toBeVisible();
    await expect(runningFixture.locator('.tool-status.running')).toBeVisible();
    await expect(runningFixture.locator('.tool-status.running')).toHaveText('RUNNING');

    // Check done tool block
    const doneFixture = page.locator('[data-testid="fixture-tool-use-done"]');
    await expect(doneFixture).toBeVisible();
    await expect(doneFixture.locator('.tool-status.done')).toBeVisible();
    await expect(doneFixture.locator('.tool-status.done')).toHaveText('DONE');

    // Check error tool block
    const errorFixture = page.locator('[data-testid="fixture-tool-use-error"]');
    await expect(errorFixture).toBeVisible();
    await expect(errorFixture.locator('.tool-status.error')).toBeVisible();
    await expect(errorFixture.locator('.tool-status.error')).toHaveText('ERROR');

    // Check collapsed tool block
    const collapsedFixture = page.locator('[data-testid="fixture-tool-collapsed"]');
    await expect(collapsedFixture).toBeVisible();
    await expect(collapsedFixture.locator('.tool-use-block.collapsed')).toBeVisible();
  });
});

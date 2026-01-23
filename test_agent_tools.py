#!/usr/bin/env python3
"""
Test script for agent chat tool display.

Tests the collapsible tool blocks and tool status indicators.
"""

import argparse
import asyncio
import sys
from pathlib import Path

try:
    from playwright.async_api import async_playwright
except ImportError:
    print("Playwright not installed. Install with:")
    print("  pip install playwright")
    print("  playwright install chromium")
    sys.exit(1)


SCREENSHOTS_DIR = Path(__file__).parent / "screenshots"
SERVER_URL = "http://localhost:8080"


async def take_screenshot(page, name: str):
    """Take a screenshot and save it to the screenshots directory."""
    filepath = SCREENSHOTS_DIR / f"{name}.png"
    await page.screenshot(path=str(filepath), full_page=False)
    print(f"  Screenshot: {filepath}")


async def run_agent_test(headed: bool = False):
    """Test agent chat tool display."""
    SCREENSHOTS_DIR.mkdir(exist_ok=True)

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=not headed)
        context = await browser.new_context(viewport={"width": 1280, "height": 900})
        page = await context.new_page()

        # Log console messages
        page.on("console", lambda msg: print(f"  [Browser] {msg.text}"))

        print("1. Loading page...")
        await page.goto(SERVER_URL)
        await page.wait_for_load_state("networkidle")
        await asyncio.sleep(0.5)

        print("2. Starting Agent Chat...")
        agent_btn = page.locator("#new-agent-chat-btn")
        if await agent_btn.is_visible():
            await agent_btn.click()
            await asyncio.sleep(1)
            await take_screenshot(page, "agent_01_new_chat")
        else:
            print("  ERROR: Agent Chat button not found!")
            await browser.close()
            return False

        print("3. Sending a message that triggers tool use...")
        message_input = page.locator("#message-input")

        # Ask for something that will trigger a tool (file read or web search)
        test_prompt = "Read the contents of the file requirements.txt in this workspace and tell me what dependencies are listed."
        await message_input.fill(test_prompt)
        await take_screenshot(page, "agent_02_message_typed")

        # Send the message
        send_btn = page.locator("#send-btn")
        await send_btn.click()
        await take_screenshot(page, "agent_03_message_sent")

        print("4. Waiting for tool use to appear...")
        # Wait for a tool block to appear
        try:
            await page.wait_for_selector(".tool-use-block", timeout=30000)
            await asyncio.sleep(1)
            await take_screenshot(page, "agent_04_tool_running")
        except:
            print("  No tool block appeared within 30 seconds")
            await take_screenshot(page, "agent_04_no_tool")

        print("5. Checking tool block structure...")
        tool_block = page.locator(".tool-use-block").first
        if await tool_block.is_visible():
            # Check if collapsed by default
            is_collapsed = await tool_block.evaluate("el => el.classList.contains('collapsed')")
            print(f"  Tool block collapsed: {is_collapsed}")

            # Check for expand icon
            expand_icon = tool_block.locator(".tool-expand-icon")
            if await expand_icon.is_visible():
                print(f"  Expand icon visible: True")

            # Check for status
            status = tool_block.locator(".tool-status")
            if await status.is_visible():
                status_text = await status.text_content()
                status_class = await status.evaluate("el => el.className")
                print(f"  Status: '{status_text}' (class: {status_class})")

            await take_screenshot(page, "agent_05_tool_collapsed")

            print("6. Clicking to expand tool block...")
            header = tool_block.locator(".tool-header")
            await header.click()
            await asyncio.sleep(0.3)
            await take_screenshot(page, "agent_06_tool_expanded")

            # Check expanded state
            is_collapsed_after = await tool_block.evaluate("el => el.classList.contains('collapsed')")
            print(f"  Tool block collapsed after click: {is_collapsed_after}")

            # Click again to collapse
            print("7. Clicking to collapse tool block...")
            await header.click()
            await asyncio.sleep(0.3)
            await take_screenshot(page, "agent_07_tool_collapsed_again")

        print("8. Waiting for response to complete...")
        # Wait for streaming indicator to disappear (more reliable than send button)
        try:
            await page.wait_for_selector(".streaming-indicator", state="detached", timeout=90000)
            await asyncio.sleep(1)  # Extra wait for final rendering
        except:
            print("  Timeout waiting for streaming to finish")

        await take_screenshot(page, "agent_08_response_complete")

        # Check for text content after tool blocks
        text_blocks = page.locator(".agent-text-block")
        text_count = await text_blocks.count()
        print(f"  Text blocks found: {text_count}")
        for i in range(text_count):
            block = text_blocks.nth(i)
            text = await block.text_content()
            print(f"  Text block {i+1}: {text[:100] if text else '(empty)'}...")

        # Check final tool status
        print("9. Checking final tool status...")
        tool_blocks = page.locator(".tool-use-block")
        count = await tool_blocks.count()
        print(f"  Total tool blocks: {count}")

        for i in range(count):
            block = tool_blocks.nth(i)
            tool_name = await block.locator(".tool-name").text_content()
            status = await block.locator(".tool-status").text_content()
            status_class = await block.locator(".tool-status").evaluate("el => el.className")
            print(f"  Tool {i+1}: {tool_name} - {status} ({status_class})")

        # Expand all tool blocks for final screenshot
        print("10. Expanding all tool blocks for final view...")
        for i in range(count):
            block = tool_blocks.nth(i)
            is_collapsed = await block.evaluate("el => el.classList.contains('collapsed')")
            if is_collapsed:
                header = block.locator(".tool-header")
                await header.click()
                await asyncio.sleep(0.2)

        await take_screenshot(page, "agent_09_all_expanded")

        await browser.close()
        print("\nTest complete! Check screenshots/ directory for results.")
        return True


def main():
    parser = argparse.ArgumentParser(description="Test agent chat tool display")
    parser.add_argument("--headed", action="store_true", help="Run with visible browser window")
    args = parser.parse_args()

    success = asyncio.run(run_agent_test(headed=args.headed))
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()

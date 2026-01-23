#!/usr/bin/env python3
"""
Test script for message editing functionality.

Diagnoses the issue where Save/Cancel buttons cannot be clicked when editing a message.
Takes screenshots at each step for visual debugging.

Usage:
    python test_edit_message.py
    python test_edit_message.py --headed  # Run with visible browser
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


async def run_edit_test(headed: bool = False):
    """Test message editing functionality."""
    SCREENSHOTS_DIR.mkdir(exist_ok=True)

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=not headed)
        context = await browser.new_context(viewport={"width": 1280, "height": 800})
        page = await context.new_page()

        # Enable console logging for debugging
        page.on("console", lambda msg: print(f"  [Browser] {msg.text}") if "error" in msg.text.lower() else None)

        print("1. Loading page...")
        await page.goto(SERVER_URL)
        await page.wait_for_load_state("networkidle")
        await asyncio.sleep(0.5)
        await take_screenshot(page, "edit_01_initial")

        print("2. Creating new conversation...")
        new_chat_btn = page.locator("#new-chat-btn")
        if await new_chat_btn.is_visible():
            await new_chat_btn.click()
            await asyncio.sleep(0.3)

        print("3. Sending a test message...")
        message_input = page.locator("#message-input")
        await message_input.fill("Hello, this is a test message for editing.")
        await take_screenshot(page, "edit_02_message_typed")

        # Press Enter to send
        await message_input.press("Enter")
        await take_screenshot(page, "edit_03_message_sent")

        print("4. Waiting for response to complete...")
        # Wait for response - look for assistant message or streaming to finish
        await asyncio.sleep(2)  # Give time for streaming to start

        # Wait for streaming to complete (stop button disappears or send button reappears)
        try:
            await page.wait_for_selector("#send-btn:not([style*='display: none'])", timeout=30000)
        except:
            pass

        await asyncio.sleep(1)
        await take_screenshot(page, "edit_04_response_complete")

        print("5. Finding and clicking the edit button...")
        # Find the user message
        user_message = page.locator(".message.user").first
        if await user_message.is_visible():
            # Hover to reveal action buttons
            await user_message.hover()
            await asyncio.sleep(0.3)
            await take_screenshot(page, "edit_05_hover_message")

            # Click edit button
            edit_btn = user_message.locator(".edit-btn")
            if await edit_btn.is_visible():
                await edit_btn.click()
                await asyncio.sleep(0.3)
                await take_screenshot(page, "edit_06_edit_mode")
            else:
                print("  ERROR: Edit button not visible!")
                await take_screenshot(page, "edit_06_error_no_edit_btn")
        else:
            print("  ERROR: User message not found!")
            await take_screenshot(page, "edit_06_error_no_message")
            await browser.close()
            return False

        print("6. Checking edit UI elements...")
        # Check for textarea
        textarea = page.locator(".edit-textarea")
        textarea_visible = await textarea.is_visible()
        print(f"  Textarea visible: {textarea_visible}")

        # Check for buttons
        save_btn = page.locator(".edit-save-btn")
        cancel_btn = page.locator(".edit-cancel-btn")

        save_visible = await save_btn.is_visible()
        cancel_visible = await cancel_btn.is_visible()
        print(f"  Save button visible: {save_visible}")
        print(f"  Cancel button visible: {cancel_visible}")

        # Check button positions
        if save_visible:
            save_box = await save_btn.bounding_box()
            print(f"  Save button position: {save_box}")
        if cancel_visible:
            cancel_box = await cancel_btn.bounding_box()
            print(f"  Cancel button position: {cancel_box}")

        # Check if buttons are clickable (not covered by other elements)
        print("\n7. Testing button clickability...")

        # Try clicking Cancel button
        if cancel_visible:
            try:
                # First, check what element is at the button's location
                cancel_box = await cancel_btn.bounding_box()
                if cancel_box:
                    # Check element at point
                    element_at_point = await page.evaluate("""
                        ([x, y]) => {
                            const el = document.elementFromPoint(x, y);
                            return {
                                tagName: el?.tagName,
                                className: el?.className,
                                textContent: el?.textContent?.slice(0, 50)
                            };
                        }
                    """, [cancel_box['x'] + cancel_box['width']/2, cancel_box['y'] + cancel_box['height']/2])
                    print(f"  Element at Cancel button location: {element_at_point}")

                await cancel_btn.click(timeout=5000)
                print("  Cancel button clicked successfully!")
                await take_screenshot(page, "edit_07_after_cancel")
            except Exception as e:
                print(f"  ERROR clicking Cancel: {e}")
                await take_screenshot(page, "edit_07_cancel_error")

                # Try force click
                print("  Trying force click...")
                try:
                    await cancel_btn.click(force=True)
                    print("  Force click succeeded!")
                    await take_screenshot(page, "edit_07_force_cancel_success")
                except Exception as e2:
                    print(f"  Force click also failed: {e2}")

        print("\n8. Re-entering edit mode to test Save...")
        # Re-enter edit mode
        user_message = page.locator(".message.user").first
        await user_message.hover()
        await asyncio.sleep(0.3)

        edit_btn = user_message.locator(".edit-btn")
        if await edit_btn.is_visible():
            await edit_btn.click()
            await asyncio.sleep(0.3)
            await take_screenshot(page, "edit_08_edit_mode_again")

            # Modify text
            textarea = page.locator(".edit-textarea")
            if await textarea.is_visible():
                await textarea.fill("This is the edited message content.")
                await take_screenshot(page, "edit_09_text_modified")

            # Try Save button
            save_btn = page.locator(".edit-save-btn")
            if await save_btn.is_visible():
                try:
                    save_box = await save_btn.bounding_box()
                    if save_box:
                        element_at_point = await page.evaluate("""
                            ([x, y]) => {
                                const el = document.elementFromPoint(x, y);
                                return {
                                    tagName: el?.tagName,
                                    className: el?.className,
                                    textContent: el?.textContent?.slice(0, 50)
                                };
                            }
                        """, [save_box['x'] + save_box['width']/2, save_box['y'] + save_box['height']/2])
                        print(f"  Element at Save button location: {element_at_point}")

                    await save_btn.click(timeout=5000)
                    print("  Save button clicked successfully!")
                    await asyncio.sleep(2)  # Wait for new response
                    await take_screenshot(page, "edit_10_after_save")
                except Exception as e:
                    print(f"  ERROR clicking Save: {e}")
                    await take_screenshot(page, "edit_10_save_error")

        print("\n9. Testing keyboard shortcuts...")
        # Re-enter edit mode for keyboard test
        user_message = page.locator(".message.user").first
        if await user_message.is_visible():
            await user_message.hover()
            await asyncio.sleep(0.3)
            edit_btn = user_message.locator(".edit-btn")
            if await edit_btn.is_visible():
                await edit_btn.click()
                await asyncio.sleep(0.3)

                # Try Escape to cancel
                textarea = page.locator(".edit-textarea")
                if await textarea.is_visible():
                    await textarea.press("Escape")
                    await asyncio.sleep(0.3)
                    await take_screenshot(page, "edit_11_after_escape")
                    print("  Escape key test complete")

        await browser.close()
        print("\nTest complete! Check screenshots/ directory for results.")
        return True


def main():
    parser = argparse.ArgumentParser(description="Test message editing functionality")
    parser.add_argument("--headed", action="store_true", help="Run with visible browser window")
    args = parser.parse_args()

    success = asyncio.run(run_edit_test(headed=args.headed))
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()

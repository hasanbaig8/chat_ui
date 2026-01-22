#!/usr/bin/env python3
"""
UI Test Script for Claude Chat UI

Starts the server, opens the chat interface in a browser, and takes screenshots
of various UI states for visual verification.

Requirements:
    pip install playwright
    playwright install chromium

Usage:
    python test_ui.py
    python test_ui.py --headed  # Run with visible browser
"""

import argparse
import asyncio
import subprocess
import sys
import time
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
SERVER_STARTUP_TIMEOUT = 10


async def wait_for_server(page, timeout: int = SERVER_STARTUP_TIMEOUT) -> bool:
    """Wait for the server to be ready."""
    start = time.time()
    while time.time() - start < timeout:
        try:
            response = await page.goto(SERVER_URL, timeout=5000)
            if response and response.ok:
                return True
        except Exception:
            pass
        await asyncio.sleep(0.5)
    return False


async def take_screenshot(page, name: str):
    """Take a screenshot and save it to the screenshots directory."""
    filepath = SCREENSHOTS_DIR / f"{name}.png"
    await page.screenshot(path=str(filepath), full_page=False)
    print(f"  Saved: {filepath}")


async def run_tests(headed: bool = False):
    """Run UI tests and capture screenshots."""
    SCREENSHOTS_DIR.mkdir(exist_ok=True)

    # Start the server with uvicorn
    print("Starting server...")
    server_process = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=Path(__file__).parent
    )

    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=not headed)
            context = await browser.new_context(
                viewport={"width": 1280, "height": 800}
            )
            page = await context.new_page()

            # Wait for server to start
            print("Waiting for server to be ready...")
            if not await wait_for_server(page):
                print("ERROR: Server failed to start")
                return False

            print("Server ready. Taking screenshots...\n")

            # 1. Initial empty state
            print("1. Capturing initial state...")
            await page.goto(SERVER_URL)
            await page.wait_for_load_state("networkidle")
            await asyncio.sleep(0.5)
            await take_screenshot(page, "01_initial_state")

            # 2. Open settings panel
            print("2. Capturing settings panel...")
            settings_btn = page.locator("#settings-btn")
            if await settings_btn.is_visible():
                await settings_btn.click()
                await asyncio.sleep(0.3)
                await take_screenshot(page, "02_settings_panel")
                # Close settings
                close_btn = page.locator("#close-settings-btn")
                if await close_btn.is_visible():
                    await close_btn.click()

            # 3. Type a message in the input
            print("3. Capturing message input...")
            message_input = page.locator("#message-input")
            if await message_input.is_visible():
                await message_input.fill("Hello! This is a test message for the Claude Chat UI.")
                await asyncio.sleep(0.2)
                await take_screenshot(page, "03_message_input")
                await message_input.clear()

            # 4. Open file browser (if available)
            print("4. Capturing file browser...")
            file_browser_btn = page.locator("#file-browser-btn")
            if await file_browser_btn.is_visible():
                await file_browser_btn.click()
                await asyncio.sleep(0.3)
                await take_screenshot(page, "04_file_browser")
                # Close file browser
                close_file_btn = page.locator("#close-file-browser")
                if await close_file_btn.is_visible():
                    await close_file_btn.click()

            # 5. Open prompt library (if available)
            print("5. Capturing prompt library...")
            prompt_btn = page.locator("#prompt-library-btn")
            if await prompt_btn.is_visible():
                await prompt_btn.click()
                await asyncio.sleep(0.3)
                await take_screenshot(page, "05_prompt_library")
                # Close prompt library
                close_prompt_btn = page.locator("#close-prompt-library")
                if await close_prompt_btn.is_visible():
                    await close_prompt_btn.click()

            # 6. Toggle dark mode
            print("6. Capturing dark mode...")
            theme_toggle = page.locator("#theme-toggle")
            if await theme_toggle.is_visible():
                await theme_toggle.click()
                await asyncio.sleep(0.3)
                await take_screenshot(page, "06_dark_mode")
                # Toggle back to light mode
                await theme_toggle.click()

            # 7. Create new conversation
            print("7. Capturing new conversation...")
            new_chat_btn = page.locator("#new-chat-btn")
            if await new_chat_btn.is_visible():
                await new_chat_btn.click()
                await asyncio.sleep(0.3)
                await take_screenshot(page, "07_new_conversation")

            # 8. Mobile viewport
            print("8. Capturing mobile view...")
            await page.set_viewport_size({"width": 375, "height": 667})
            await asyncio.sleep(0.3)
            await take_screenshot(page, "08_mobile_view")

            # Reset viewport
            await page.set_viewport_size({"width": 1280, "height": 800})

            await browser.close()

        print("\nAll screenshots captured successfully!")
        print(f"Screenshots saved to: {SCREENSHOTS_DIR.absolute()}")
        return True

    finally:
        # Stop the server
        print("\nStopping server...")
        server_process.terminate()
        try:
            server_process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server_process.kill()


def main():
    parser = argparse.ArgumentParser(description="Run UI tests and capture screenshots")
    parser.add_argument(
        "--headed",
        action="store_true",
        help="Run with visible browser window"
    )
    args = parser.parse_args()

    success = asyncio.run(run_tests(headed=args.headed))
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Test streaming behavior with rapid conversation switching.
"""

import asyncio
import subprocess
import sys
import time
from pathlib import Path

try:
    from playwright.async_api import async_playwright
except ImportError:
    print("Playwright not installed.")
    sys.exit(1)


SCREENSHOTS_DIR = Path(__file__).parent / "screenshots"
SERVER_URL = "http://localhost:8080"


async def wait_for_server(page, timeout=10):
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


async def run_test():
    SCREENSHOTS_DIR.mkdir(exist_ok=True)

    print("Starting server...")
    server_process = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=Path(__file__).parent
    )

    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            context = await browser.new_context(viewport={"width": 1400, "height": 900})
            page = await context.new_page()

            print("Waiting for server...")
            if not await wait_for_server(page):
                print("Server failed to start")
                return

            await page.goto(SERVER_URL)
            await page.wait_for_load_state("networkidle")
            await asyncio.sleep(1)

            print("\n=== Test 1: Create conversations and click around ===")

            # Create first conversation
            print("Creating conversation 1...")
            await page.click("#new-chat-btn")
            await asyncio.sleep(0.5)
            await page.screenshot(path=str(SCREENSHOTS_DIR / "test_01_new_conv1.png"))

            # Type and send a message
            print("Sending message in conversation 1...")
            await page.fill("#message-input", "Write a detailed analysis of climate change causes and solutions.")
            await page.click("#send-btn")
            await asyncio.sleep(1)  # Let streaming start
            await page.screenshot(path=str(SCREENSHOTS_DIR / "test_02_streaming_started.png"))

            # Create second conversation while first is streaming
            print("Creating conversation 2 while streaming...")
            await page.click("#new-chat-btn")
            await asyncio.sleep(0.5)
            await page.screenshot(path=str(SCREENSHOTS_DIR / "test_03_new_conv2_during_stream.png"))

            # Check if conv 1 shows streaming indicator
            print("Checking for streaming indicator...")
            await asyncio.sleep(0.5)
            await page.screenshot(path=str(SCREENSHOTS_DIR / "test_04_check_indicator.png"))

            # Click back to conversation 1
            print("Clicking back to conversation 1...")
            conv_items = await page.query_selector_all(".conversation-item")
            if len(conv_items) >= 2:
                await conv_items[1].click()  # Second item should be conv 1
                await asyncio.sleep(1)
                await page.screenshot(path=str(SCREENSHOTS_DIR / "test_05_back_to_conv1.png"))

            # Rapid clicking with re-querying elements
            print("\n=== Test 2: Rapid clicking ===")
            for i in range(3):
                await page.click("#new-chat-btn")
                await asyncio.sleep(0.2)
            await asyncio.sleep(0.5)
            await page.screenshot(path=str(SCREENSHOTS_DIR / "test_06_after_rapid_clicks.png"))

            # Click on conversations with proper waits
            print("Conversation switching...")
            for i in range(3):
                # Re-query elements each time to avoid stale references
                conv_items = await page.query_selector_all(".conversation-item")
                if i < len(conv_items):
                    await conv_items[i].click()
                    await asyncio.sleep(0.4)
                    await page.screenshot(path=str(SCREENSHOTS_DIR / f"test_07_switch_{i}.png"))

            await page.screenshot(path=str(SCREENSHOTS_DIR / "test_08_after_switching.png"))

            # Wait for stream to complete and check final state
            print("\nWaiting for stream to complete...")
            await asyncio.sleep(8)

            # Click back to streaming conversation
            conv_items = await page.query_selector_all(".conversation-item")
            for item in conv_items:
                title = await item.query_selector(".conversation-title")
                if title:
                    text = await title.inner_text()
                    if "Write" in text or "Climate" in text or "detailed" in text:
                        await item.click()
                        await asyncio.sleep(0.5)
                        break

            await page.screenshot(path=str(SCREENSHOTS_DIR / "test_09_final_conv.png"))

            print("\n=== Test complete ===")
            print(f"Screenshots saved to: {SCREENSHOTS_DIR}")

            await browser.close()

    finally:
        print("Stopping server...")
        server_process.terminate()
        try:
            server_process.wait(timeout=5)
        except:
            server_process.kill()


if __name__ == "__main__":
    asyncio.run(run_test())

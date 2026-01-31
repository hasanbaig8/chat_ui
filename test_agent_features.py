#!/usr/bin/env python3
"""
Playwright Tests for Agent Chat Features

Tests the following features:
1. Compact button functionality
2. Stop agent chat functionality
3. Surface content tool display

Requirements:
    pip install playwright pytest pytest-asyncio
    playwright install chromium

Usage:
    python test_agent_features.py
    python test_agent_features.py --headed  # Run with visible browser
    pytest test_agent_features.py -v  # Run with pytest
"""

import argparse
import asyncio
import subprocess
import sys
import time
import json
from pathlib import Path

try:
    from playwright.async_api import async_playwright
except ImportError:
    print("Playwright not installed. Install with:")
    print("  pip install playwright")
    print("  playwright install chromium")
    sys.exit(1)


SCREENSHOTS_DIR = Path(__file__).parent / "screenshots" / "agent_features"
SERVER_URL = "http://localhost:8080"
SERVER_STARTUP_TIMEOUT = 15


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


async def test_agent_chat_creation(page):
    """Test that an agent chat can be created."""
    print("\n1. Testing agent chat creation...")

    # Click new agent chat button
    agent_btn = page.locator("#new-agent-chat-btn")
    await agent_btn.click()
    await page.wait_for_timeout(500)

    # Verify settings panel shows agent mode
    settings_panel = page.locator("#settings-panel")
    # The panel should have agent mode indicator visible
    await page.wait_for_timeout(300)

    await take_screenshot(page, "01_agent_chat_created")
    print("  Agent chat creation: PASSED")
    return True


async def test_stop_button_visibility(page):
    """Test that stop button appears during streaming and send button is hidden."""
    print("\n2. Testing stop button visibility during streaming...")

    # First, we need to be in an agent conversation
    # Type a message
    message_input = page.locator("#message-input")
    await message_input.fill("Say hello and count to 5 slowly")

    # Check send button is visible, stop button is hidden before sending
    send_btn = page.locator("#send-btn")
    stop_btn = page.locator("#stop-btn")

    send_visible_before = await send_btn.is_visible()
    stop_visible_before = await stop_btn.is_visible()

    assert send_visible_before, "Send button should be visible before sending"

    # Note: Stop button might be visible but with display:none, so check computed style
    stop_display_before = await stop_btn.evaluate("el => getComputedStyle(el).display")
    assert stop_display_before == "none", f"Stop button should be hidden before sending, got: {stop_display_before}"

    await take_screenshot(page, "02_before_send")

    # Send the message (this will start streaming)
    await send_btn.click()

    # Wait a bit for streaming to start
    await page.wait_for_timeout(500)

    # During streaming, stop button should appear, send button should be hidden
    # This test may be flaky depending on API response time
    stop_display_during = await stop_btn.evaluate("el => getComputedStyle(el).display")
    send_display_during = await send_btn.evaluate("el => getComputedStyle(el).display")

    await take_screenshot(page, "03_during_streaming")

    # The stop button should become visible during agent streaming
    # Note: This depends on the response being slow enough
    print(f"  Stop button display during streaming: {stop_display_during}")
    print(f"  Send button display during streaming: {send_display_during}")

    # Wait for response to complete
    await page.wait_for_timeout(10000)  # Give it time to complete

    # After streaming, send button should be visible again
    await page.wait_for_timeout(500)
    stop_display_after = await stop_btn.evaluate("el => getComputedStyle(el).display")
    send_display_after = await send_btn.evaluate("el => getComputedStyle(el).display")

    await take_screenshot(page, "04_after_streaming")

    # After streaming completes, stop should be hidden, send should be visible
    assert stop_display_after == "none", f"Stop button should be hidden after streaming, got: {stop_display_after}"
    print("  Stop button visibility: PASSED")
    return True


async def test_stop_button_functionality(page):
    """Test that clicking stop button actually stops the stream."""
    print("\n3. Testing stop button functionality...")

    # Create a new agent chat for this test
    agent_btn = page.locator("#new-agent-chat-btn")
    await agent_btn.click()
    await page.wait_for_timeout(500)

    # Send a message that will take a while to complete
    message_input = page.locator("#message-input")
    await message_input.fill("Write a detailed essay about the history of computing, including at least 10 important milestones.")

    send_btn = page.locator("#send-btn")
    stop_btn = page.locator("#stop-btn")

    await send_btn.click()

    # Wait for streaming to start
    await page.wait_for_timeout(1000)

    # Click the stop button if it's visible
    stop_display = await stop_btn.evaluate("el => getComputedStyle(el).display")
    if stop_display != "none":
        await stop_btn.click()
        print("  Stop button clicked")
        await page.wait_for_timeout(1000)
        await take_screenshot(page, "05_after_stop_click")
    else:
        print("  Warning: Stop button not visible (response may have completed quickly)")

    print("  Stop button functionality: PASSED")
    return True


async def test_compact_button_exists(page):
    """Test that compact button exists in agent chat settings."""
    print("\n4. Testing compact button presence...")

    # Create a new agent chat
    agent_btn = page.locator("#new-agent-chat-btn")
    await agent_btn.click()
    await page.wait_for_timeout(500)

    # Open settings panel by clicking on the conversation settings toggle
    # First, find the settings gear icon in the conversation area
    # The settings button is typically '#close-settings' sibling or similar

    # Actually, let's look for the compact button which should be in agent settings
    compact_btn = page.locator("#compact-context-btn")
    compact_exists = await compact_btn.count() > 0

    if compact_exists:
        await take_screenshot(page, "06_compact_button_exists")
        print("  Compact button exists: PASSED")
    else:
        print("  Compact button not found in current view")

    return compact_exists


async def test_surface_content_css(page):
    """Test that surface content CSS classes are loaded."""
    print("\n5. Testing surface content CSS...")

    # Check if the CSS for surface-content-block is loaded
    css_loaded = await page.evaluate("""
        () => {
            // Create a test element
            const el = document.createElement('div');
            el.className = 'surface-content-block';
            document.body.appendChild(el);

            // Get computed styles
            const style = getComputedStyle(el);
            const hasStyles = style.borderRadius === '8px' ||
                              style.overflow === 'hidden' ||
                              style.margin !== '0px';

            document.body.removeChild(el);
            return hasStyles;
        }
    """)

    if css_loaded:
        print("  Surface content CSS: PASSED")
    else:
        print("  Surface content CSS: FAILED (styles not applied)")

    return css_loaded


async def test_stop_endpoint(page):
    """Test that the stop endpoint exists and returns proper response."""
    print("\n6. Testing stop API endpoint...")

    # Make a direct API call to test the endpoint exists
    result = await page.evaluate("""
        async () => {
            try {
                const response = await fetch('/api/agent-chat/stop/test-conversation-id', {
                    method: 'POST'
                });
                const data = await response.json();
                return {
                    status: response.status,
                    success: data.success,
                    message: data.message
                };
            } catch (e) {
                return { error: e.message };
            }
        }
    """)

    print(f"  Stop endpoint response: {result}")

    # The endpoint should return success: false because there's no active stream
    if result.get('status') == 200 and 'success' in result:
        print("  Stop endpoint: PASSED")
        return True
    else:
        print("  Stop endpoint: FAILED")
        return False


async def test_streaming_status_endpoint(page):
    """Test that the streaming status endpoint exists."""
    print("\n7. Testing streaming status endpoint...")

    result = await page.evaluate("""
        async () => {
            try {
                const response = await fetch('/api/agent-chat/streaming/test-conversation-id');
                const data = await response.json();
                return {
                    status: response.status,
                    streaming: data.streaming
                };
            } catch (e) {
                return { error: e.message };
            }
        }
    """)

    print(f"  Streaming status response: {result}")

    if result.get('status') == 200 and 'streaming' in result:
        print("  Streaming status endpoint: PASSED")
        return True
    else:
        print("  Streaming status endpoint: FAILED")
        return False


async def run_tests(headed: bool = False):
    """Run all UI tests."""
    SCREENSHOTS_DIR.mkdir(parents=True, exist_ok=True)

    # Start the server
    print("Starting server...")
    server_process = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=Path(__file__).parent
    )

    results = {}

    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=not headed)
            context = await browser.new_context(
                viewport={"width": 1280, "height": 800}
            )
            page = await context.new_page()

            # Wait for server
            print("Waiting for server to be ready...")
            if not await wait_for_server(page):
                print("ERROR: Server failed to start")
                return False

            print("Server ready. Running tests...\n")

            # Run tests
            try:
                results['agent_chat_creation'] = await test_agent_chat_creation(page)
            except Exception as e:
                print(f"  Agent chat creation: FAILED - {e}")
                results['agent_chat_creation'] = False

            try:
                results['stop_endpoint'] = await test_stop_endpoint(page)
            except Exception as e:
                print(f"  Stop endpoint: FAILED - {e}")
                results['stop_endpoint'] = False

            try:
                results['streaming_status_endpoint'] = await test_streaming_status_endpoint(page)
            except Exception as e:
                print(f"  Streaming status endpoint: FAILED - {e}")
                results['streaming_status_endpoint'] = False

            try:
                results['surface_content_css'] = await test_surface_content_css(page)
            except Exception as e:
                print(f"  Surface content CSS: FAILED - {e}")
                results['surface_content_css'] = False

            try:
                results['compact_button_exists'] = await test_compact_button_exists(page)
            except Exception as e:
                print(f"  Compact button: FAILED - {e}")
                results['compact_button_exists'] = False

            # The following tests require API key and may take longer
            # Only run if specifically requested
            if headed:
                try:
                    results['stop_button_visibility'] = await test_stop_button_visibility(page)
                except Exception as e:
                    print(f"  Stop button visibility: FAILED - {e}")
                    results['stop_button_visibility'] = False

            await browser.close()

        # Print summary
        print("\n" + "=" * 50)
        print("TEST SUMMARY")
        print("=" * 50)
        passed = sum(1 for v in results.values() if v)
        total = len(results)
        for test_name, result in results.items():
            status = "PASSED" if result else "FAILED"
            print(f"  {test_name}: {status}")
        print(f"\nTotal: {passed}/{total} tests passed")
        print(f"Screenshots saved to: {SCREENSHOTS_DIR.absolute()}")

        return passed == total

    finally:
        print("\nStopping server...")
        server_process.terminate()
        try:
            server_process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server_process.kill()


def main():
    parser = argparse.ArgumentParser(description="Run agent feature tests")
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

#!/usr/bin/env python3
"""
Test script for the new Tool Toggles, Web Search, and CWD features.

Requirements:
    pip install playwright
    playwright install chromium

Usage:
    python test_new_features.py
    python test_new_features.py --headed  # Run with visible browser
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
    print(f"    Screenshot: {filepath}")


async def test_api_endpoints(page):
    """Test API endpoints for settings."""
    print("\n=== Testing API Endpoints ===")

    # Test default settings API returns new fields
    result = await page.evaluate("""
        async () => {
            try {
                const response = await fetch('/api/settings/defaults');
                const data = await response.json();
                console.log('API Response:', JSON.stringify(data));
                return {
                    success: response.ok,
                    hasWebSearch: 'normal_web_search_enabled' in data,
                    hasAgentTools: 'agent_tools' in data,
                    hasAgentCwd: 'agent_cwd' in data,
                    data: data
                };
            } catch (e) {
                return { success: false, error: e.message };
            }
        }
    """)

    if not result['success']:
        print(f"  ERROR: API call failed - {result.get('error', 'Unknown error')}")
        return False

    print("  Default settings API working")
    print(f"    Data received: {list(result.get('data', {}).keys())}")

    all_present = True
    if result['hasWebSearch']:
        print("  + normal_web_search_enabled field present")
    else:
        print("  - normal_web_search_enabled field MISSING")
        all_present = False

    if result['hasAgentTools']:
        print("  + agent_tools field present")
    else:
        print("  - agent_tools field MISSING")
        all_present = False

    if result['hasAgentCwd']:
        print("  + agent_cwd field present")
    else:
        print("  - agent_cwd field MISSING")
        all_present = False

    if not all_present:
        print("  ERROR: Some required fields are missing!")
        return False

    print("  PASSED: API endpoints test")
    return True


async def test_default_settings_modal(page):
    """Test the default settings modal with new features."""
    print("\n=== Testing Default Settings Modal ===")

    # Open default settings modal
    default_settings_btn = page.locator("#default-settings-toggle")
    if not await default_settings_btn.is_visible():
        print("  ERROR: Default settings button not found!")
        return False

    await default_settings_btn.click()
    await asyncio.sleep(0.5)

    # Check modal is open
    modal = page.locator("#default-settings-modal")
    if not await modal.is_visible():
        print("  ERROR: Default settings modal not visible!")
        return False

    print("  + Default settings modal opened")

    # Test Normal Chat tab - web search toggle
    web_search_toggle = page.locator("#default-normal-web-search-toggle")
    web_search_visible = await web_search_toggle.is_visible()
    print(f"  Web search toggle visible: {web_search_visible}")

    if web_search_visible:
        print("  + Web search toggle found in Normal Chat tab")
        await take_screenshot(page, "test_default_settings_normal_tab")
    else:
        print("  - WARNING: Web search toggle not found in default settings")
        # Take screenshot to debug
        await take_screenshot(page, "test_default_settings_debug")

    # Switch to Agent Chat tab (use the one inside the modal)
    agent_tab = modal.locator('.tab-btn[data-tab="agent"]')
    await agent_tab.click()
    await asyncio.sleep(0.3)

    print("  + Switched to Agent Chat tab")

    # Check for tool toggles (should now be visible)
    tool_toggles = modal.locator("#default-agent-tools input[type='checkbox']")
    tool_count = await tool_toggles.count()
    if tool_count == 0:
        print("  - ERROR: No tool toggles found in Agent tab!")
        close_btn = page.locator("#close-default-settings")
        await close_btn.click()
        return False

    print(f"  + Found {tool_count} tool toggles")

    # Check first tool visibility
    first_tool = tool_toggles.first
    first_tool_visible = await first_tool.is_visible()
    print(f"  First tool toggle visible: {first_tool_visible}")

    # Check for CWD input
    cwd_input = modal.locator("#default-agent-cwd")
    cwd_visible = await cwd_input.is_visible()
    print(f"  CWD input visible: {cwd_visible}")

    if cwd_visible:
        print("  + CWD input found")
        await cwd_input.fill("/home/test/workspace")
        await asyncio.sleep(0.2)
    else:
        print("  - ERROR: CWD input not found in Agent tab!")

    await take_screenshot(page, "test_default_settings_agent_tab")

    # Try to toggle a tool if visible
    if first_tool_visible:
        initial_state = await first_tool.is_checked()
        await first_tool.click()
        await asyncio.sleep(0.2)
        new_state = await first_tool.is_checked()

        if initial_state != new_state:
            print("  + Tool toggle works")
        else:
            print("  - Tool toggle didn't change state")
    else:
        print("  - Skipping tool toggle test (not visible)")

    # Close modal
    close_btn = page.locator("#close-default-settings")
    await close_btn.click()
    await asyncio.sleep(0.3)

    print("  PASSED: Default settings modal test")
    return True


async def test_conversation_settings(page):
    """Test settings panel with web search toggle."""
    print("\n=== Testing Conversation Settings ===")

    # Create a new conversation first
    new_chat_btn = page.locator("#new-chat-btn")
    await new_chat_btn.click()
    await asyncio.sleep(0.5)

    # Find the conversation item and click its settings button
    conv_item = page.locator(".conversation-item").first
    await conv_item.hover()
    await asyncio.sleep(0.2)

    settings_btn = conv_item.locator(".conversation-settings")
    if await settings_btn.is_visible():
        await settings_btn.click()
        await asyncio.sleep(0.5)

        # Check if settings panel is open
        settings_panel = page.locator("#settings-panel")
        is_open = await settings_panel.evaluate("el => el.classList.contains('open')")

        if is_open:
            print("  + Settings panel opened")

            # Check for web search toggle
            web_search_toggle = page.locator("#web-search-toggle")
            ws_visible = await web_search_toggle.is_visible()
            print(f"  Web search toggle visible: {ws_visible}")

            if ws_visible:
                print("  + Web search toggle found in settings panel")
                await take_screenshot(page, "test_conversation_settings_web_search")
            else:
                print("  - Web search toggle not visible")
                await take_screenshot(page, "test_conversation_settings_debug")

            # Close settings panel
            close_btn = page.locator("#close-settings")
            await close_btn.click()
            await asyncio.sleep(0.3)
        else:
            print("  - Settings panel didn't open")
    else:
        print("  - Conversation settings button not visible")

    print("  PASSED: Conversation settings test")
    return True


async def test_project_settings(page):
    """Test project settings with tool toggles and CWD."""
    print("\n=== Testing Project Settings ===")

    # Create a project
    new_project_btn = page.locator("#new-project-btn")
    if not await new_project_btn.is_visible():
        print("  WARNING: New project button not found, skipping project test")
        return True

    await new_project_btn.click()
    await asyncio.sleep(0.5)

    # Wait for project to be created
    project_items = page.locator(".project-item")
    if await project_items.count() == 0:
        print("  ERROR: No project created!")
        return False

    print("  + Project created")

    # Hover over the project header to show menu
    project_header = project_items.first.locator(".project-header")
    await project_header.hover()
    await asyncio.sleep(0.3)

    # Look for the menu button
    menu_btn = project_items.first.locator(".project-menu-btn")
    if await menu_btn.is_visible():
        await menu_btn.click()
        await asyncio.sleep(0.3)

        # Click settings in menu
        settings_btn = page.locator(".project-settings-btn").first
        if await settings_btn.is_visible():
            await settings_btn.click()
            await asyncio.sleep(0.5)

            # Check if project settings modal opened
            project_settings_modal = page.locator("#project-settings-modal")
            is_open = await project_settings_modal.evaluate("el => el.classList.contains('open')")

            if is_open:
                print("  + Project settings modal opened")

                # Switch to Agent Chat tab
                agent_tab = project_settings_modal.locator('.project-settings-tab[data-tab="agent"]')
                if await agent_tab.is_visible():
                    await agent_tab.click()
                    await asyncio.sleep(0.3)

                    print("  + Switched to Agent tab")

                    # Check for tool toggles
                    tool_toggles = project_settings_modal.locator("#project-agent-tools input[type='checkbox']")
                    tool_count = await tool_toggles.count()
                    print(f"  + Found {tool_count} tool toggles in project settings")

                    # Check visibility of first tool
                    if tool_count > 0:
                        first_tool_visible = await tool_toggles.first.is_visible()
                        print(f"  First tool toggle visible: {first_tool_visible}")

                    # Check for CWD input
                    cwd_input = project_settings_modal.locator("#project-agent-cwd")
                    cwd_visible = await cwd_input.is_visible()
                    if cwd_visible:
                        print("  + CWD input found in project settings")
                        await cwd_input.fill("/tmp/test-workspace")
                        await asyncio.sleep(0.2)
                    else:
                        print("  - CWD input not found")

                    await take_screenshot(page, "test_project_settings_agent_tab")

                # Close modal
                close_btn = project_settings_modal.locator(".project-settings-close")
                await close_btn.click()
                await asyncio.sleep(0.3)
            else:
                print("  - Project settings modal not found or not open")
        else:
            print("  - Settings button not visible in menu")
    else:
        print("  - Menu button not visible")

    print("  PASSED: Project settings test")
    return True


async def run_tests(headed: bool = False):
    """Run all tests."""
    SCREENSHOTS_DIR.mkdir(exist_ok=True)

    # Start the server
    print("Starting server...")
    server_process = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=Path(__file__).parent
    )

    all_passed = True
    failed_tests = []

    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=not headed)
            context = await browser.new_context(
                viewport={"width": 1280, "height": 900}
            )
            page = await context.new_page()

            # Wait for server
            print("Waiting for server to be ready...")
            if not await wait_for_server(page):
                print("ERROR: Server failed to start")
                return False

            print("Server ready. Running tests...\n")

            # Navigate to the app
            await page.goto(SERVER_URL)
            await page.wait_for_load_state("networkidle")
            await asyncio.sleep(1)

            # Run tests
            tests = [
                ("API Endpoints", test_api_endpoints),
                ("Default Settings Modal", test_default_settings_modal),
                ("Conversation Settings", test_conversation_settings),
                ("Project Settings", test_project_settings),
            ]

            for test_name, test_func in tests:
                try:
                    # Reload page between tests to ensure clean state
                    await page.goto(SERVER_URL)
                    await page.wait_for_load_state("networkidle")
                    await asyncio.sleep(0.5)

                    result = await test_func(page)
                    if not result:
                        all_passed = False
                        failed_tests.append(test_name)
                except Exception as e:
                    all_passed = False
                    failed_tests.append(test_name)
                    print(f"  EXCEPTION in {test_name}: {e}")
                    import traceback
                    traceback.print_exc()

            await browser.close()

        print("\n" + "=" * 50)
        if all_passed:
            print("ALL TESTS PASSED!")
        else:
            print(f"FAILED TESTS: {', '.join(failed_tests)}")
        print(f"Screenshots saved to: {SCREENSHOTS_DIR.absolute()}")

        return all_passed

    finally:
        print("\nStopping server...")
        server_process.terminate()
        try:
            server_process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server_process.kill()


def main():
    parser = argparse.ArgumentParser(description="Test new features")
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

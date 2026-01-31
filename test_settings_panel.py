#!/usr/bin/env python3
"""
Test to verify settings panel content for agent chat.
"""

import asyncio
import subprocess
import sys
import time
from pathlib import Path

try:
    from playwright.async_api import async_playwright
except ImportError:
    sys.exit(1)

SCREENSHOTS_DIR = Path(__file__).parent / "screenshots" / "settings_panel"
SERVER_URL = "http://localhost:8080"


async def run_test():
    SCREENSHOTS_DIR.mkdir(parents=True, exist_ok=True)

    print("Starting server...")
    server_process = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=Path(__file__).parent
    )

    try:
        await asyncio.sleep(3)  # Wait for server

        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            context = await browser.new_context(viewport={"width": 1400, "height": 900})
            page = await context.new_page()

            await page.goto(SERVER_URL)
            await page.wait_for_load_state("networkidle")
            await asyncio.sleep(0.5)

            # Create agent chat
            print("Creating agent chat...")
            await page.click("#new-agent-chat-btn")
            await asyncio.sleep(0.5)

            # Take screenshot of initial state
            await page.screenshot(path=str(SCREENSHOTS_DIR / "01_agent_chat_initial.png"))
            print(f"Saved: {SCREENSHOTS_DIR}/01_agent_chat_initial.png")

            # Click on an existing agent chat to see if settings panel opens
            # First, let's check what elements exist for opening settings
            settings_elements = await page.evaluate("""
                () => {
                    return {
                        settingsPanel: !!document.getElementById('settings-panel'),
                        closeSettings: !!document.getElementById('close-settings'),
                        compactBtn: !!document.getElementById('compact-context-btn'),
                        toolsDisplay: !!document.getElementById('agent-tools-display')
                    };
                }
            """)
            print(f"Settings elements: {settings_elements}")

            # The settings panel might be in the page but hidden
            # Let's check if we can find a way to open it
            # Look for a settings toggle button on conversation items

            # Try clicking on the conversation item which might open settings
            conversation_items = await page.locator(".conversation-item").all()
            print(f"Found {len(conversation_items)} conversation items")

            # Click on the first agent conversation item
            if conversation_items:
                await conversation_items[0].click()
                await asyncio.sleep(0.5)

            # Check the settings panel state
            panel_state = await page.evaluate("""
                () => {
                    const panel = document.getElementById('settings-panel');
                    if (panel) {
                        const style = getComputedStyle(panel);
                        return {
                            width: style.width,
                            classList: Array.from(panel.classList),
                            isOpen: panel.classList.contains('open')
                        };
                    }
                    return null;
                }
            """)
            print(f"Settings panel state: {panel_state}")

            # Try to find and click the settings gear icon if it exists
            # Look for the settings button that toggles the panel
            gear_btns = await page.locator("button[title*='settings'], button.settings-btn, .settings-toggle").all()
            print(f"Found {len(gear_btns)} settings-related buttons")

            # Let's check the HTML structure
            html_snippet = await page.evaluate("""
                () => {
                    const panel = document.getElementById('settings-panel');
                    if (panel) {
                        return panel.outerHTML.substring(0, 1000);
                    }
                    return 'Panel not found';
                }
            """)
            print(f"Settings panel HTML snippet: {html_snippet[:500]}...")

            # Get the compact button HTML if it exists
            compact_html = await page.evaluate("""
                () => {
                    const btn = document.getElementById('compact-context-btn');
                    if (btn) {
                        return btn.outerHTML;
                    }
                    return 'Button not found';
                }
            """)
            print(f"Compact button HTML: {compact_html}")

            # Get the tools display HTML
            tools_html = await page.evaluate("""
                () => {
                    const display = document.getElementById('agent-tools-display');
                    if (display) {
                        return display.outerHTML;
                    }
                    return 'Display not found';
                }
            """)
            print(f"Tools display HTML: {tools_html[:500]}...")

            # Force the settings panel open via JS
            print("\nForcing settings panel open...")
            await page.evaluate("""
                () => {
                    const panel = document.getElementById('settings-panel');
                    if (panel) {
                        panel.classList.add('open');
                        panel.style.width = '300px';
                    }
                }
            """)
            await asyncio.sleep(0.3)

            # Take screenshot with panel open
            await page.screenshot(path=str(SCREENSHOTS_DIR / "02_settings_panel_open.png"))
            print(f"Saved: {SCREENSHOTS_DIR}/02_settings_panel_open.png")

            # Check compact button visibility
            compact_visible = await page.evaluate("""
                () => {
                    const btn = document.getElementById('compact-context-btn');
                    if (btn) {
                        const rect = btn.getBoundingClientRect();
                        const style = getComputedStyle(btn);
                        return {
                            visible: rect.width > 0 && rect.height > 0,
                            display: style.display,
                            text: btn.textContent.trim()
                        };
                    }
                    return null;
                }
            """)
            print(f"Compact button visibility: {compact_visible}")

            # Check tools display
            tools_visible = await page.evaluate("""
                () => {
                    const display = document.getElementById('agent-tools-display');
                    if (display) {
                        return {
                            innerHTML: display.innerHTML,
                            hasSurface: display.innerHTML.includes('Surface')
                        };
                    }
                    return null;
                }
            """)
            print(f"Tools display: {tools_visible}")

            # Final screenshot
            await page.screenshot(path=str(SCREENSHOTS_DIR / "03_final_state.png"))
            print(f"Saved: {SCREENSHOTS_DIR}/03_final_state.png")

            await browser.close()

        print("\nTest completed successfully!")
        return True

    finally:
        print("\nStopping server...")
        server_process.terminate()
        try:
            server_process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server_process.kill()


if __name__ == "__main__":
    asyncio.run(run_test())

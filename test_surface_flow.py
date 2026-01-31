#!/usr/bin/env python3
"""Test the surface content flow end-to-end."""

import asyncio
import subprocess
import sys
import os
import json
from pathlib import Path

try:
    from playwright.async_api import async_playwright
except ImportError:
    sys.exit(1)

SCREENSHOTS_DIR = Path(__file__).parent / "screenshots" / "surface_flow"
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
        await asyncio.sleep(3)

        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            context = await browser.new_context(viewport={"width": 1400, "height": 900})
            page = await context.new_page()

            await page.goto(SERVER_URL)
            await page.wait_for_load_state("networkidle")

            # Create agent chat
            print("\n1. Creating agent chat...")
            await page.click("#new-agent-chat-btn")
            await asyncio.sleep(0.5)

            # Get the conversation ID
            conversation_id = await page.evaluate("""
                () => ConversationsManager?.getCurrentConversationId()
            """)
            print(f"   Conversation ID: {conversation_id}")

            # Check workspace path
            workspace_path = Path(__file__).parent / "data" / "conversations" / conversation_id / "workspace"
            print(f"   Workspace path: {workspace_path}")
            print(f"   Workspace exists: {workspace_path.exists()}")

            # Simulate a surface_content event being received during streaming
            print("\n2. Simulating surface_content event from streaming...")

            # This simulates what happens when the agent calls the surface_content tool
            # and the backend receives the surface_content event

            test_content = """
<style>
    .test-viewer { padding: 20px; font-family: sans-serif; }
    .header { background: #4a90d9; color: white; padding: 15px; border-radius: 8px 8px 0 0; }
    .body { background: #f5f5f5; padding: 20px; border-radius: 0 0 8px 8px; }
    table { width: 100%; border-collapse: collapse; margin-top: 15px; }
    th, td { padding: 10px; text-align: left; border-bottom: 1px solid #ddd; }
    th { background: #e0e0e0; }
</style>
<div class="test-viewer">
    <div class="header"><h2>Test Data Viewer</h2></div>
    <div class="body">
        <p>This content should persist after page reload.</p>
        <table>
            <tr><th>Item</th><th>Value</th><th>Status</th></tr>
            <tr><td>Test 1</td><td>100</td><td>Pass</td></tr>
            <tr><td>Test 2</td><td>200</td><td>Pass</td></tr>
            <tr><td>Test 3</td><td>300</td><td>Pass</td></tr>
        </table>
    </div>
</div>
"""

            # Create workspace directory
            workspace_path.mkdir(parents=True, exist_ok=True)

            # Save surface content file
            content_id = "flow_test_001"
            filename = f"surface_{content_id}.html"
            filepath = workspace_path / filename

            with open(filepath, 'w', encoding='utf-8') as f:
                f.write(test_content)
            print(f"   Saved surface content to: {filepath}")
            print(f"   File exists: {filepath.exists()}")
            print(f"   File size: {filepath.stat().st_size} bytes")

            # Now simulate the message being saved with the surface_content reference
            # We'll manually create a message with the surface_content block

            # First, test the API endpoint
            print("\n3. Testing surface content API...")
            api_result = await page.evaluate(f"""
                async () => {{
                    try {{
                        const response = await fetch('/api/agent-chat/surface-content/{conversation_id}/{filename}');
                        if (!response.ok) {{
                            return {{ error: response.status, statusText: response.statusText }};
                        }}
                        return await response.json();
                    }} catch (e) {{
                        return {{ error: e.message }};
                    }}
                }}
            """)

            if 'error' in api_result:
                print(f"   API Error: {api_result}")
            else:
                print(f"   API Success! Content length: {len(api_result.get('content', ''))}")

            # Test creating and loading the surface block
            print("\n4. Testing surface block creation with file reference...")
            render_result = await page.evaluate(f"""
                async () => {{
                    try {{
                        // Create placeholder
                        const placeholder = ChatManager.createSurfaceContentPlaceholder(
                            'html',
                            'Test Data Viewer',
                            '{content_id}'
                        );
                        document.getElementById('messages-container').appendChild(placeholder);

                        // Load content
                        await ChatManager.loadSurfaceContent(
                            placeholder,
                            '{filename}',
                            'html',
                            'Test Data Viewer',
                            '{content_id}'
                        );

                        // Wait for loading
                        await new Promise(r => setTimeout(r, 1000));

                        // Check result
                        const blocks = document.querySelectorAll('.surface-content-block');
                        const lastBlock = blocks[blocks.length - 1];

                        return {{
                            success: true,
                            blockCount: blocks.length,
                            hasIframe: !!lastBlock?.querySelector('iframe'),
                            isLoading: lastBlock?.classList.contains('surface-loading'),
                            hasError: lastBlock?.classList.contains('surface-error'),
                            title: lastBlock?.querySelector('.surface-title')?.textContent
                        }};
                    }} catch (e) {{
                        return {{ error: e.message }};
                    }}
                }}
            """)
            print(f"   Render result: {render_result}")

            await asyncio.sleep(0.5)
            await page.screenshot(path=str(SCREENSHOTS_DIR / "01_surface_loaded.png"))
            print(f"   Screenshot: {SCREENSHOTS_DIR}/01_surface_loaded.png")

            # Test modal
            print("\n5. Testing modal...")
            await page.click('.surface-header')
            await asyncio.sleep(0.5)

            modal_result = await page.evaluate("""
                () => {
                    const modal = document.getElementById('surface-modal');
                    return {
                        exists: !!modal,
                        isOpen: modal?.classList.contains('open'),
                        hasIframe: !!modal?.querySelector('iframe')
                    };
                }
            """)
            print(f"   Modal result: {modal_result}")

            await page.screenshot(path=str(SCREENSHOTS_DIR / "02_modal_open.png"))
            print(f"   Screenshot: {SCREENSHOTS_DIR}/02_modal_open.png")

            await page.keyboard.press('Escape')
            await asyncio.sleep(0.3)

            await browser.close()

        print("\n" + "=" * 50)
        print("SURFACE FLOW TEST COMPLETE")
        print("=" * 50)
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

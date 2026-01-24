#!/usr/bin/env python3
"""
Visual Playwright test for the memory feature.

Tests the full flow:
1. Create a project
2. Create Agent Chat 1, add to project, write to memory
3. Create Agent Chat 2, add to project, read from memory
4. Verify Agent 2 can see Agent 1's memories

Usage:
    python test_memory_visual.py
    python test_memory_visual.py --headed  # Watch the browser
"""

import argparse
import os
import sys
import time
from pathlib import Path

# Check for playwright
try:
    from playwright.sync_api import sync_playwright, expect
except ImportError:
    print("Playwright not installed. Run: pip install playwright && playwright install chromium")
    sys.exit(1)


# Create screenshots directory
SCREENSHOTS_DIR = Path("screenshots/memory_test")
SCREENSHOTS_DIR.mkdir(parents=True, exist_ok=True)


def take_screenshot(page, name):
    """Take a screenshot with timestamp."""
    path = SCREENSHOTS_DIR / f"{name}.png"
    page.screenshot(path=str(path))
    print(f"  📸 Screenshot: {path}")


def wait_for_response_complete(page, timeout=120000):
    """Wait for agent response to complete (no more streaming)."""
    # Wait for either:
    # 1. Send button to be enabled, OR
    # 2. A message with tool results to appear (DONE badge)
    try:
        page.wait_for_function(
            """() => {
                // Check if send button is enabled
                const btn = document.querySelector('.send-btn');
                if (btn && !btn.disabled) return true;

                // Check if there's a completed tool use (DONE badge)
                const doneBadges = document.querySelectorAll('.tool-status.success');
                if (doneBadges.length > 0) {
                    // Also check if streaming indicator is gone
                    const streaming = document.querySelector('.streaming-indicator');
                    if (!streaming) return true;
                }

                return false;
            }""",
            timeout=timeout
        )
    except:
        # If timeout, check if there's content anyway
        pass

    # Additional wait to ensure UI is stable
    time.sleep(2)


def run_test(headed=False):
    """Run the visual memory test."""
    print("\n🧪 Visual Memory Feature Test")
    print("=" * 60)

    # Generate unique project name
    import random
    project_name = f"Memory Test {random.randint(1000, 9999)}"

    with sync_playwright() as p:
        # Launch browser
        browser = p.chromium.launch(headless=not headed)
        context = browser.new_context(viewport={"width": 1400, "height": 900})
        page = context.new_page()

        try:
            # Step 1: Open the app
            print("\n📍 Step 1: Opening app...")
            page.goto("http://localhost:8080")
            page.wait_for_load_state("networkidle")
            take_screenshot(page, "01_app_loaded")

            # Step 2: Create a new project
            print(f"\n📍 Step 2: Creating project '{project_name}'...")

            # Handle the prompt dialog before clicking
            def handle_dialog(dialog):
                dialog.accept(project_name)

            page.once("dialog", handle_dialog)

            # Click new project button
            page.click("#new-project-btn")
            page.wait_for_timeout(1500)
            take_screenshot(page, "02_project_created")

            # Verify project appears
            project_header = page.locator(f".project-header:has-text('{project_name}')").first
            expect(project_header).to_be_visible()
            print("  ✓ Project created")

            # Step 3: Create first agent chat
            print("\n📍 Step 3: Creating Agent Chat 1...")
            page.click("#new-agent-chat-btn")
            page.wait_for_timeout(2000)
            take_screenshot(page, "03_agent1_created")

            # Get the conversation ID from the active conversation
            active_conv = page.locator(".conversation-item.active")
            expect(active_conv).to_be_visible()
            print("  ✓ Agent Chat 1 created")

            # Step 4: Drag agent chat to project (or use API)
            print("\n📍 Step 4: Adding Agent Chat 1 to project...")

            # Since drag-drop can be tricky in Playwright, let's use the API directly
            # First get the conversation ID
            conv1_id = page.evaluate("""() => {
                const active = document.querySelector('.conversation-item.active');
                return active ? active.dataset.id : null;
            }""")

            # Get project ID - use the API to get the exact project we just created
            project_id = page.evaluate(f"""async () => {{
                const resp = await fetch('/api/projects');
                const data = await resp.json();
                // Find our project by name
                const project = data.projects.find(p => p.name === '{project_name}');
                return project ? project.id : null;
            }}""")
            print(f"  Project ID: {project_id}")

            if conv1_id and project_id:
                # Add via API
                page.evaluate(f"""async () => {{
                    await fetch('/api/projects/{project_id}/conversations', {{
                        method: 'POST',
                        headers: {{'Content-Type': 'application/json'}},
                        body: JSON.stringify({{conversation_id: '{conv1_id}'}})
                    }});
                    // Refresh the UI
                    if (window.ProjectsManager) {{
                        await ProjectsManager.loadProjects();
                    }}
                    if (window.ConversationsManager) {{
                        ConversationsManager.renderConversationsList();
                    }}
                }}""")
                page.wait_for_timeout(1000)

            take_screenshot(page, "04_agent1_in_project")
            print("  ✓ Agent Chat 1 added to project")

            # Step 5: Send message to Agent 1 to write to memory
            print("\n📍 Step 5: Asking Agent 1 to write to memory...")

            message_input = page.locator("#message-input")
            message_input.fill("Please save this to your memory: The user's name is Alice, their favorite programming language is Python, and they are working on a machine learning project about image classification.")

            take_screenshot(page, "05_agent1_message_typed")

            # Click send
            page.click(".send-btn")
            print("  ⏳ Waiting for Agent 1 response...")

            # Wait for response to complete
            wait_for_response_complete(page, timeout=180000)
            take_screenshot(page, "06_agent1_response")
            print("  ✓ Agent 1 responded")

            # Step 6: Create second agent chat
            print("\n📍 Step 6: Creating Agent Chat 2...")
            page.click("#new-agent-chat-btn")
            page.wait_for_timeout(2000)
            take_screenshot(page, "07_agent2_created")

            # Get new conversation ID
            conv2_id = page.evaluate("""() => {
                const active = document.querySelector('.conversation-item.active');
                return active ? active.dataset.id : null;
            }""")
            print("  ✓ Agent Chat 2 created")

            # Step 7: Add Agent Chat 2 to the same project
            print("\n📍 Step 7: Adding Agent Chat 2 to same project...")

            if conv2_id and project_id:
                page.evaluate(f"""async () => {{
                    await fetch('/api/projects/{project_id}/conversations', {{
                        method: 'POST',
                        headers: {{'Content-Type': 'application/json'}},
                        body: JSON.stringify({{conversation_id: '{conv2_id}'}})
                    }});
                    if (window.ProjectsManager) {{
                        await ProjectsManager.loadProjects();
                    }}
                    if (window.ConversationsManager) {{
                        ConversationsManager.renderConversationsList();
                    }}
                }}""")
                page.wait_for_timeout(1000)

            take_screenshot(page, "08_agent2_in_project")
            print("  ✓ Agent Chat 2 added to project")

            # Step 8: Ask Agent 2 to read from memory
            print("\n📍 Step 8: Asking Agent 2 to read from memory...")

            message_input = page.locator("#message-input")
            message_input.fill("Check your memory. What do you know about the user? What is their name and what are they working on?")

            take_screenshot(page, "09_agent2_message_typed")

            # Click send
            page.click(".send-btn")
            print("  ⏳ Waiting for Agent 2 response...")

            # Wait for response
            wait_for_response_complete(page, timeout=180000)
            take_screenshot(page, "10_agent2_response")
            print("  ✓ Agent 2 responded")

            # Step 9: Check workspace panel for memory files
            print("\n📍 Step 9: Checking workspace panel for memory files...")

            # Click workspace toggle if it exists
            workspace_btn = page.locator("#workspace-files-toggle")
            if workspace_btn.is_visible():
                workspace_btn.click()
                page.wait_for_timeout(1000)
                take_screenshot(page, "11_workspace_panel")
                print("  ✓ Workspace panel opened")

            # Step 10: Verify the response mentions the user info
            print("\n📍 Step 10: Verifying Agent 2 read the memory...")

            # Get the response text
            messages = page.locator(".message.assistant .message-content")
            last_response = messages.last
            response_text = last_response.inner_text().lower()

            # Check if key information was retrieved
            checks = {
                "alice": "alice" in response_text.lower(),
                "python": "python" in response_text.lower(),
                "machine learning": "machine learning" in response_text.lower() or "ml" in response_text.lower() or "image" in response_text.lower(),
            }

            print("\n  Memory retrieval checks:")
            all_passed = True
            for key, passed in checks.items():
                status = "✓" if passed else "✗"
                print(f"    {status} Found '{key}': {passed}")
                if not passed:
                    all_passed = False

            take_screenshot(page, "12_final_state")

            # Summary
            print("\n" + "=" * 60)
            if all_passed:
                print("✅ SUCCESS: Agent 2 successfully read Agent 1's memories!")
            else:
                print("⚠️  PARTIAL: Agent 2 responded but may not have found all memories")
                print("   Check the screenshots to see what happened")

            print(f"\n📁 Screenshots saved to: {SCREENSHOTS_DIR.absolute()}")

            # Keep browser open if headed
            if headed:
                print("\n👀 Browser is open. Press Enter to close...")
                input()

            return all_passed

        except Exception as e:
            print(f"\n❌ Error: {e}")
            take_screenshot(page, "error_state")
            raise
        finally:
            browser.close()


def main():
    parser = argparse.ArgumentParser(description="Visual memory feature test")
    parser.add_argument("--headed", action="store_true", help="Run with visible browser")
    args = parser.parse_args()

    # Check if server is running
    import urllib.request
    try:
        urllib.request.urlopen("http://localhost:8080", timeout=2)
    except:
        print("❌ Server not running. Start it with: python app.py")
        sys.exit(1)

    success = run_test(headed=args.headed)
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()

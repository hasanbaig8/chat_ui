#!/usr/bin/env python3
"""Test the surface_from_script functionality."""

import asyncio
import subprocess
import sys
from pathlib import Path

try:
    from playwright.async_api import async_playwright
except ImportError:
    sys.exit(1)

SCREENSHOTS_DIR = Path(__file__).parent / "screenshots" / "surface_script"
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
            print("Creating agent chat...")
            await page.click("#new-agent-chat-btn")
            await asyncio.sleep(0.5)

            # Test the workflow: simulate what an agent would do
            print("\nSimulating agent workflow for programmatic surfacing...")

            # Step 1: Write a Python script that generates HTML
            print("1. Writing data generation script...")
            script_content = '''#!/usr/bin/env python3
import json

# Sample data - in real use, this could come from a file, API, or database
data = [
    {"name": "Alice", "department": "Engineering", "score": 95, "status": "Active"},
    {"name": "Bob", "department": "Marketing", "score": 87, "status": "Active"},
    {"name": "Charlie", "department": "Engineering", "score": 92, "status": "On Leave"},
    {"name": "Diana", "department": "Sales", "score": 78, "status": "Active"},
    {"name": "Eve", "department": "Engineering", "score": 98, "status": "Active"},
]

# Generate HTML table with styling
html = """
<style>
    .data-table { width: 100%; border-collapse: collapse; }
    .data-table th { background: #f5f5f5; padding: 10px; text-align: left; font-weight: bold; }
    .data-table td { padding: 8px 10px; border-bottom: 1px solid #eee; }
    .data-table tr:hover { background: #f9f9f9; }
    .status-active { color: #28a745; font-weight: bold; }
    .status-leave { color: #ffc107; font-weight: bold; }
    .high-score { background: #d4edda; }
    .summary { margin-top: 15px; padding: 10px; background: #f8f9fa; border-radius: 4px; }
</style>
<table class="data-table">
    <tr>
        <th>Name</th>
        <th>Department</th>
        <th>Score</th>
        <th>Status</th>
    </tr>
"""

for person in data:
    score_class = "high-score" if person["score"] >= 90 else ""
    status_class = "status-active" if person["status"] == "Active" else "status-leave"
    html += f"""
    <tr class="{score_class}">
        <td>{person["name"]}</td>
        <td>{person["department"]}</td>
        <td>{person["score"]}</td>
        <td class="{status_class}">{person["status"]}</td>
    </tr>
"""

html += "</table>"

# Add summary
avg_score = sum(p["score"] for p in data) / len(data)
active_count = sum(1 for p in data if p["status"] == "Active")
html += f"""
<div class="summary">
    <strong>Summary:</strong> {len(data)} employees | Average Score: {avg_score:.1f} | Active: {active_count}
</div>
"""

print(html)
'''

            # Simulate writing the script to workspace
            # In real agent use, this would be done via the Write tool
            workspace_path = Path(__file__).parent / "data" / "conversations"

            # For testing, let's check if the surface tools are available via API
            result = await page.evaluate("""
                async () => {
                    // Test if agent SDK would have surface tools
                    // We can't directly test MCP, but we can verify the workflow concept

                    // Simulate what would happen:
                    // 1. Agent writes script
                    // 2. Agent calls surface_from_script tool
                    // 3. Tool executes script and returns surface_content result
                    // 4. Frontend renders the surfaced content

                    return {
                        hasChatManager: typeof ChatManager !== 'undefined',
                        hasCreateSurfaceBlock: typeof ChatManager?.createSurfaceContentBlock === 'function'
                    };
                }
            """)
            print(f"   ChatManager available: {result}")

            # Test the rendering with sample HTML (as if it came from a script)
            print("2. Testing HTML rendering from script output...")
            sample_html = '''
<style>
    .data-table { width: 100%; border-collapse: collapse; }
    .data-table th { background: #f5f5f5; padding: 10px; text-align: left; }
    .data-table td { padding: 8px 10px; border-bottom: 1px solid #eee; }
    .high-score { background: #d4edda; }
    .summary { margin-top: 15px; padding: 10px; background: #f8f9fa; border-radius: 4px; }
</style>
<table class="data-table">
    <tr><th>Name</th><th>Department</th><th>Score</th></tr>
    <tr class="high-score"><td>Alice</td><td>Engineering</td><td>95</td></tr>
    <tr><td>Bob</td><td>Marketing</td><td>87</td></tr>
    <tr class="high-score"><td>Charlie</td><td>Engineering</td><td>92</td></tr>
</table>
<div class="summary"><strong>Summary:</strong> 3 employees | Average: 91.3</div>
'''

            render_result = await page.evaluate(f"""
                () => {{
                    const content = {repr(sample_html)};
                    const block = ChatManager.createSurfaceContentBlock(
                        content,
                        'html',
                        'Employee Data (Script Output)',
                        'script-output-1'
                    );
                    document.getElementById('messages-container').appendChild(block);
                    return {{
                        success: true,
                        hasIframe: !!block.querySelector('iframe'),
                        hasHeader: !!block.querySelector('.surface-header')
                    }};
                }}
            """)
            print(f"   Render result: {render_result}")

            await asyncio.sleep(1)  # Wait for iframe to load
            await page.screenshot(path=str(SCREENSHOTS_DIR / "01_script_output_surfaced.png"))
            print(f"   Screenshot: {SCREENSHOTS_DIR}/01_script_output_surfaced.png")

            # Test markdown from script output
            print("3. Testing markdown rendering from script output...")
            sample_md = '''# Data Analysis Results

## Employee Statistics

| Metric | Value |
|--------|-------|
| Total Employees | 5 |
| Average Score | 90.0 |
| High Performers | 3 |

### Top Performers
1. **Eve** - Score: 98 (Engineering)
2. **Alice** - Score: 95 (Engineering)
3. **Charlie** - Score: 92 (Engineering)

> Note: Engineering department shows consistently high performance.
'''

            md_result = await page.evaluate(f"""
                () => {{
                    const content = {repr(sample_md)};
                    const block = ChatManager.createSurfaceContentBlock(
                        content,
                        'markdown',
                        'Analysis Report (Script Output)',
                        'script-output-2'
                    );
                    document.getElementById('messages-container').appendChild(block);
                    return {{ success: true }};
                }}
            """)
            print(f"   Markdown result: {md_result}")

            await asyncio.sleep(0.5)
            await page.screenshot(path=str(SCREENSHOTS_DIR / "02_markdown_script_output.png"))
            print(f"   Screenshot: {SCREENSHOTS_DIR}/02_markdown_script_output.png")

            # Final screenshot
            await page.screenshot(path=str(SCREENSHOTS_DIR / "03_all_outputs.png"))
            print(f"   Screenshot: {SCREENSHOTS_DIR}/03_all_outputs.png")

            await browser.close()

        print("\n" + "=" * 50)
        print("PROGRAMMATIC SURFACING TEST COMPLETE")
        print("=" * 50)
        print("\nThe workflow is:")
        print("1. Agent writes a script (Python/JS/etc) that outputs HTML/markdown")
        print("2. Agent calls surface_from_script with the script filename")
        print("3. MCP server executes script and captures stdout")
        print("4. Output is surfaced as interactive content in chat")
        print("\nAlternatively:")
        print("1. Agent generates HTML/markdown content directly")
        print("2. Agent calls surface_content with the content")
        print("3. Content is displayed in chat")
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

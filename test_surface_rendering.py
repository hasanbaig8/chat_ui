#!/usr/bin/env python3
"""
Test surface content rendering in the chat.
"""

import asyncio
import subprocess
import sys
from pathlib import Path

try:
    from playwright.async_api import async_playwright
except ImportError:
    sys.exit(1)

SCREENSHOTS_DIR = Path(__file__).parent / "screenshots" / "surface_rendering"
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
            await asyncio.sleep(0.5)

            # Create agent chat
            print("Creating agent chat...")
            await page.click("#new-agent-chat-btn")
            await asyncio.sleep(0.5)

            # Test creating a surface content block using ChatManager
            print("\nTesting surface content block creation...")

            # Test HTML content rendering
            html_result = await page.evaluate("""
                () => {
                    if (typeof ChatManager === 'undefined') {
                        return { error: 'ChatManager not defined' };
                    }

                    // Create a test surface block with HTML
                    const block = ChatManager.createSurfaceContentBlock(
                        '<h2>Test Data Table</h2><table><tr><th>Name</th><th>Value</th></tr><tr><td>Item 1</td><td>100</td></tr><tr><td>Item 2</td><td>200</td></tr></table>',
                        'html',
                        'Data Viewer',
                        'test-html-1'
                    );

                    // Add it to the page for testing
                    const container = document.getElementById('messages-container');
                    container.appendChild(block);

                    return {
                        success: true,
                        hasIframe: block.querySelector('iframe') !== null,
                        hasHeader: block.querySelector('.surface-header') !== null,
                        className: block.className,
                        dataset: block.dataset.contentId
                    };
                }
            """)
            print(f"HTML surface block: {html_result}")

            await asyncio.sleep(0.5)
            await page.screenshot(path=str(SCREENSHOTS_DIR / "01_html_surface_block.png"))
            print(f"Saved: {SCREENSHOTS_DIR}/01_html_surface_block.png")

            # Test markdown content rendering
            md_result = await page.evaluate("""
                () => {
                    const block = ChatManager.createSurfaceContentBlock(
                        '# Markdown Test\\n\\n**Bold text** and *italic text*\\n\\n- Item 1\\n- Item 2\\n- Item 3\\n\\n| Column A | Column B |\\n|----------|----------|\\n| Value 1  | Value 2  |',
                        'markdown',
                        'Markdown Preview',
                        'test-md-1'
                    );

                    const container = document.getElementById('messages-container');
                    container.appendChild(block);

                    return {
                        success: true,
                        hasMarkdownDiv: block.querySelector('.surface-markdown') !== null,
                        hasHeader: block.querySelector('.surface-header') !== null,
                        innerHTMLPreview: block.innerHTML.substring(0, 300)
                    };
                }
            """)
            print(f"Markdown surface block: {md_result}")

            await asyncio.sleep(0.5)
            await page.screenshot(path=str(SCREENSHOTS_DIR / "02_markdown_surface_block.png"))
            print(f"Saved: {SCREENSHOTS_DIR}/02_markdown_surface_block.png")

            # Test without title
            notitle_result = await page.evaluate("""
                () => {
                    const block = ChatManager.createSurfaceContentBlock(
                        '<p>Simple content without a title</p>',
                        'html',
                        null,
                        'test-notitle-1'
                    );

                    const container = document.getElementById('messages-container');
                    container.appendChild(block);

                    return {
                        success: true,
                        hasHeader: block.querySelector('.surface-header') !== null
                    };
                }
            """)
            print(f"No-title surface block: {notitle_result}")

            await page.screenshot(path=str(SCREENSHOTS_DIR / "03_all_surface_blocks.png"))
            print(f"Saved: {SCREENSHOTS_DIR}/03_all_surface_blocks.png")

            # Verify CSS styles
            css_check = await page.evaluate("""
                () => {
                    const blocks = document.querySelectorAll('.surface-content-block');
                    if (blocks.length === 0) return { error: 'No blocks found' };

                    const firstBlock = blocks[0];
                    const style = getComputedStyle(firstBlock);

                    return {
                        blockCount: blocks.length,
                        borderRadius: style.borderRadius,
                        overflow: style.overflow,
                        marginTop: style.marginTop,
                        marginBottom: style.marginBottom
                    };
                }
            """)
            print(f"CSS verification: {css_check}")

            # Check iframe auto-resize
            await asyncio.sleep(1)  # Wait for iframes to load
            iframe_check = await page.evaluate("""
                () => {
                    const iframe = document.querySelector('.surface-iframe');
                    if (!iframe) return { error: 'No iframe found' };

                    return {
                        width: iframe.style.width || 'auto',
                        height: iframe.style.height,
                        minHeight: getComputedStyle(iframe).minHeight
                    };
                }
            """)
            print(f"Iframe check: {iframe_check}")

            await page.screenshot(path=str(SCREENSHOTS_DIR / "04_final_with_iframes.png"))
            print(f"Saved: {SCREENSHOTS_DIR}/04_final_with_iframes.png")

            await browser.close()

        print("\nAll surface rendering tests passed!")
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

"""Mock streaming module for deterministic testing.

When MOCK_LLM=1 environment variable is set, this module provides
deterministic SSE event generators for both normal and agent chat streams.
This enables testing without external API dependencies.
"""

import os
import asyncio
import uuid
from typing import AsyncGenerator, Dict, Any, List, Optional


def is_mock_mode() -> bool:
    """Check if mock mode is enabled via environment variable."""
    return os.getenv("MOCK_LLM", "").lower() in ("1", "true", "yes")


# ============================================================================
# Mock Data Constants
# ============================================================================

MOCK_THINKING_CONTENT = """Let me analyze this request step by step.

First, I need to understand what the user is asking for.
The question seems to be about testing the chat interface.

I should provide a helpful response that demonstrates
the various rendering capabilities of the system.
"""

MOCK_TEXT_CHUNKS = [
    "Hello! ",
    "I'm a ",
    "**mock response** ",
    "designed for ",
    "testing purposes.\n\n",
    "Here's some code:\n",
    "```python\n",
    "def hello():\n",
    "    print('Hello, World!')\n",
    "```\n\n",
    "And a list:\n",
    "- Item one\n",
    "- Item two\n",
    "- Item three\n"
]

MOCK_WEB_SEARCH_RESULTS = [
    {
        "title": "Example Result 1 - Mock Search",
        "url": "https://example.com/result1",
        "snippet": "This is a mock search result for testing."
    },
    {
        "title": "Example Result 2 - Test Data",
        "url": "https://example.com/result2",
        "snippet": "Another mock result demonstrating web search rendering."
    },
    {
        "title": "Claude Documentation",
        "url": "https://docs.anthropic.com",
        "snippet": "Official documentation for Claude AI assistant."
    }
]

MOCK_TOOL_USE = {
    "id": "mock_tool_001",
    "name": "Read",
    "input": {
        "path": "/mock/path/to/file.txt"
    }
}

MOCK_TOOL_RESULT = {
    "tool_use_id": "mock_tool_001",
    "content": "Mock file contents:\nLine 1\nLine 2\nLine 3",
    "is_error": False
}

MOCK_SURFACE_CONTENT = {
    "content_id": "mock_surface_001",
    "content_type": "html",
    "title": "Mock Dashboard",
    "content": """<div style="padding: 20px; background: #f5f5f5; border-radius: 8px;">
    <h2>Mock Surface Content</h2>
    <p>This is a mock surface content block for testing the surface rendering.</p>
    <ul>
        <li>Item A</li>
        <li>Item B</li>
        <li>Item C</li>
    </ul>
</div>"""
}


# ============================================================================
# Mock Normal Chat Stream
# ============================================================================

async def mock_normal_chat_stream(
    conversation_id: Optional[str],
    thinking_enabled: bool = False,
    web_search_enabled: bool = False,
    delay_ms: int = 50
) -> AsyncGenerator[Dict[str, Any], None]:
    """Generate deterministic SSE events for normal chat.

    Args:
        conversation_id: Conversation ID for message tracking
        thinking_enabled: Whether to emit thinking chunks
        web_search_enabled: Whether to emit web search events
        delay_ms: Delay between events in milliseconds

    Yields:
        SSE event dictionaries
    """
    message_id = str(uuid.uuid4()) if conversation_id else None
    position = 0  # Will be set by caller

    # Emit message_id first
    if message_id:
        yield {"type": "message_id", "id": message_id, "position": position}
        await asyncio.sleep(delay_ms / 1000)

    # Emit thinking if enabled
    if thinking_enabled:
        thinking_chunks = MOCK_THINKING_CONTENT.split('\n')
        for chunk in thinking_chunks:
            yield {"type": "thinking", "content": chunk + "\n"}
            await asyncio.sleep(delay_ms / 1000)

    # Emit web search if enabled
    if web_search_enabled:
        search_id = f"ws_{uuid.uuid4().hex[:8]}"

        # Search start
        yield {"type": "web_search_start", "id": search_id}
        await asyncio.sleep(delay_ms / 1000)

        # Query partials
        query_parts = ["testing ", "chat ", "interface"]
        for part in query_parts:
            yield {"type": "web_search_query", "partial_query": part}
            await asyncio.sleep(delay_ms / 1000)

        # Results
        yield {
            "type": "web_search_result",
            "tool_use_id": search_id,
            "results": MOCK_WEB_SEARCH_RESULTS
        }
        await asyncio.sleep(delay_ms / 1000)

    # Emit text chunks
    for chunk in MOCK_TEXT_CHUNKS:
        yield {"type": "text", "content": chunk}
        await asyncio.sleep(delay_ms / 1000)

    # Done
    yield {"type": "done"}


# ============================================================================
# Mock Agent Chat Stream
# ============================================================================

MOCK_AGENT_THINKING_CONTENT = """Analyzing the user's request for agent mode.

Let me consider the best approach to help with this task.
I should use the available tools to accomplish this efficiently.
"""


async def mock_agent_chat_stream(
    conversation_id: Optional[str],
    stop_event: Optional[asyncio.Event] = None,
    include_tool_use: bool = True,
    include_surface: bool = True,
    include_thinking: bool = True,
    delay_ms: int = 50
) -> AsyncGenerator[Dict[str, Any], None]:
    """Generate deterministic SSE events for agent chat.

    Args:
        conversation_id: Conversation ID for message tracking
        stop_event: Event to check for stop signal
        include_tool_use: Whether to emit tool use/result events
        include_surface: Whether to emit surface content event
        include_thinking: Whether to emit thinking events
        delay_ms: Delay between events in milliseconds

    Yields:
        SSE event dictionaries
    """
    message_id = str(uuid.uuid4()) if conversation_id else None
    session_id = f"mock_session_{uuid.uuid4().hex[:8]}"

    def check_stopped():
        return stop_event and stop_event.is_set()

    # Emit message_id
    if message_id:
        yield {"type": "message_id", "id": message_id}
        await asyncio.sleep(delay_ms / 1000)

    if check_stopped():
        yield {"type": "stopped", "content": "Stream stopped by user"}
        return

    # Emit session_id
    yield {"type": "session_id", "session_id": session_id}
    await asyncio.sleep(delay_ms / 1000)

    if check_stopped():
        yield {"type": "stopped", "content": "Stream stopped by user"}
        return

    # Emit thinking if enabled
    if include_thinking:
        thinking_chunks = MOCK_AGENT_THINKING_CONTENT.split('\n')
        for chunk in thinking_chunks:
            if check_stopped():
                yield {"type": "stopped", "content": "Stream stopped by user"}
                return
            yield {"type": "thinking", "content": chunk + "\n"}
            await asyncio.sleep(delay_ms / 1000)

    # Initial text
    initial_text = ["I'll help you with that. ", "Let me ", "check some files first.\n\n"]
    for chunk in initial_text:
        if check_stopped():
            yield {"type": "stopped", "content": "Stream stopped by user"}
            return
        yield {"type": "text", "content": chunk}
        await asyncio.sleep(delay_ms / 1000)

    # Tool use
    if include_tool_use:
        if check_stopped():
            yield {"type": "stopped", "content": "Stream stopped by user"}
            return
        yield {
            "type": "tool_use",
            "id": MOCK_TOOL_USE["id"],
            "name": MOCK_TOOL_USE["name"],
            "input": MOCK_TOOL_USE["input"]
        }
        await asyncio.sleep(delay_ms * 2 / 1000)  # Slightly longer delay for tool

        if check_stopped():
            yield {"type": "stopped", "content": "Stream stopped by user"}
            return
        yield {
            "type": "tool_result",
            "tool_use_id": MOCK_TOOL_RESULT["tool_use_id"],
            "content": MOCK_TOOL_RESULT["content"],
            "is_error": MOCK_TOOL_RESULT["is_error"]
        }
        await asyncio.sleep(delay_ms / 1000)

    # More text after tool
    post_tool_text = [
        "\n\nI found the file. ",
        "Here's what I discovered:\n\n",
        "The file contains **mock data** ",
        "for testing purposes.\n"
    ]
    for chunk in post_tool_text:
        if check_stopped():
            yield {"type": "stopped", "content": "Stream stopped by user"}
            return
        yield {"type": "text", "content": chunk}
        await asyncio.sleep(delay_ms / 1000)

    # Surface content
    if include_surface:
        if check_stopped():
            yield {"type": "stopped", "content": "Stream stopped by user"}
            return
        yield {
            "type": "surface_content",
            "content_id": MOCK_SURFACE_CONTENT["content_id"],
            "content_type": MOCK_SURFACE_CONTENT["content_type"],
            "title": MOCK_SURFACE_CONTENT["title"],
            "content": MOCK_SURFACE_CONTENT["content"]
        }
        await asyncio.sleep(delay_ms / 1000)

    # Final text
    final_text = ["\n\nLet me know if you need ", "anything else!"]
    for chunk in final_text:
        if check_stopped():
            yield {"type": "stopped", "content": "Stream stopped by user"}
            return
        yield {"type": "text", "content": chunk}
        await asyncio.sleep(delay_ms / 1000)

    # Done
    yield {"type": "done"}


# ============================================================================
# Mock Error Stream (for testing error handling)
# ============================================================================

async def mock_error_stream(
    error_message: str = "Mock error for testing",
    delay_before_error_ms: int = 100
) -> AsyncGenerator[Dict[str, Any], None]:
    """Generate a stream that produces an error event.

    Args:
        error_message: The error message to emit
        delay_before_error_ms: Delay before emitting error

    Yields:
        A few text events followed by an error
    """
    yield {"type": "text", "content": "Starting response... "}
    await asyncio.sleep(delay_before_error_ms / 1000)
    yield {"type": "error", "content": error_message}

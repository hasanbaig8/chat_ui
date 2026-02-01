"""Claude Agent SDK client wrapper with streaming support.

This module provides integration with the Claude Agent SDK for agent-based
chat functionality with tool use (Read/Write file operations).

Note: The claude-agent-sdk package must be installed for agent chat to work.
If not installed, agent conversations will show an error message.
"""

import json
import os
from typing import AsyncIterator, Optional, List, Dict, Any
from dotenv import load_dotenv

load_dotenv()

# Try to import the Claude Agent SDK
SDK_AVAILABLE = False
SDK_IMPORT_ERROR = None
try:
    from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient
    SDK_AVAILABLE = True
except ImportError as e:
    SDK_IMPORT_ERROR = str(e)
except Exception as e:
    SDK_IMPORT_ERROR = f"Unexpected error: {e}"

# Path to MCP server scripts
import pathlib
GIF_MCP_SERVER_PATH = pathlib.Path(__file__).parent.parent / "tools" / "gif_mcp_server.py"
GIF_TOOL_AVAILABLE = GIF_MCP_SERVER_PATH.exists()

MEMORY_MCP_SERVER_PATH = pathlib.Path(__file__).parent.parent / "tools" / "memory_mcp_server.py"
MEMORY_TOOL_AVAILABLE = MEMORY_MCP_SERVER_PATH.exists()

SURFACE_MCP_SERVER_PATH = pathlib.Path(__file__).parent.parent / "tools" / "surface_mcp_server.py"
SURFACE_TOOL_AVAILABLE = SURFACE_MCP_SERVER_PATH.exists()


class AgentClient:
    """Wrapper for Claude Agent SDK with streaming support."""

    def __init__(self):
        api_key = os.getenv("ANTHROPIC_API_KEY")
        if not api_key:
            raise ValueError("ANTHROPIC_API_KEY environment variable is required")
        self.api_key = api_key

    def build_options(
        self,
        workspace_path: str,
        system_prompt: Optional[str] = None,
        model: Optional[str] = None,
        session_id: Optional[str] = None,
        memory_path: Optional[str] = None,
        enabled_tools: Optional[Dict[str, bool]] = None,
        thinking_budget: Optional[int] = None,
        conversation_id: Optional[str] = None
    ) -> "ClaudeAgentOptions":
        """Build ClaudeAgentOptions for a session.

        Args:
            workspace_path: Working directory for agent file operations
            system_prompt: Optional system prompt
            model: Optional model override
            session_id: Optional session ID to resume a previous conversation
            memory_path: Optional path to memory directory
            enabled_tools: Optional dict of tool names to enabled state
            thinking_budget: Optional thinking budget in tokens
            conversation_id: Optional conversation ID for workspace tools

        Returns:
            ClaudeAgentOptions configured for the session
        """
        if not SDK_AVAILABLE:
            raise RuntimeError(f"Claude Agent SDK not available: {SDK_IMPORT_ERROR}")

        # Build disallowed_tools list based on enabled_tools setting
        base_tools = [
            "Read", "Write", "Edit", "Bash", "Glob", "Grep",
            "WebSearch", "WebFetch", "Task",
        ]

        disallowed_tools = []
        if enabled_tools is not None:
            for tool in base_tools:
                if not enabled_tools.get(tool, True):
                    disallowed_tools.append(tool)

            if GIF_TOOL_AVAILABLE and not enabled_tools.get("GIF", True):
                disallowed_tools.append("mcp__gif-search__search_gif")

            if memory_path and MEMORY_TOOL_AVAILABLE and not enabled_tools.get("Memory", True):
                disallowed_tools.extend([
                    "mcp__memory__memory_view",
                    "mcp__memory__memory_create",
                    "mcp__memory__memory_str_replace",
                    "mcp__memory__memory_insert",
                    "mcp__memory__memory_delete",
                    "mcp__memory__memory_rename",
                ])

            print(f"[AGENT_CLIENT] Tool settings: {enabled_tools}")
            print(f"[AGENT_CLIENT] Disallowed tools: {disallowed_tools}")

        def stderr_callback(line: str):
            print(f"[AGENT_CLIENT STDERR] {line}")

        options = ClaudeAgentOptions(
            cwd=workspace_path,
            disallowed_tools=disallowed_tools if disallowed_tools else [],
            permission_mode="bypassPermissions",
            max_thinking_tokens=thinking_budget if thinking_budget and thinking_budget > 0 else None,
            stderr=stderr_callback,
        )

        # Build MCP servers configuration
        mcp_servers = {}

        if GIF_TOOL_AVAILABLE:
            mcp_servers["gif-search"] = {
                "command": "python3",
                "args": [str(GIF_MCP_SERVER_PATH)]
            }

        if memory_path and MEMORY_TOOL_AVAILABLE:
            mcp_servers["memory"] = {
                "command": "python3",
                "args": [str(MEMORY_MCP_SERVER_PATH), "--memory-path", memory_path]
            }

        if SURFACE_TOOL_AVAILABLE and conversation_id:
            if enabled_tools is None or enabled_tools.get("Surface", True):
                mcp_servers["surface"] = {
                    "command": "python3",
                    "args": [
                        str(SURFACE_MCP_SERVER_PATH),
                        "--workspace-path", workspace_path,
                        "--conversation-id", conversation_id
                    ]
                }

        if mcp_servers:
            options.mcp_servers = mcp_servers

        if system_prompt:
            options.system_prompt = system_prompt

        if model:
            options.model = model

        if session_id:
            options.resume = session_id

        return options

    async def stream_with_options(
        self,
        options: "ClaudeAgentOptions",
        prompt: str
    ) -> AsyncIterator[Dict[str, Any]]:
        """Stream agent responses using ClaudeSDKClient.

        Creates a fresh client for each request and properly manages the async context.

        Args:
            options: ClaudeAgentOptions for the session
            prompt: The user's message

        Yields:
            Events with types: 'session_id', 'text', 'tool_use', 'tool_result', 'done', 'error'
        """
        if not SDK_AVAILABLE:
            yield {
                "type": "error",
                "content": f"ClaudeSDKClient not available: {SDK_IMPORT_ERROR}"
            }
            return

        try:
            client = ClaudeSDKClient(options=options)
            async with client:
                # __aenter__ already calls connect() with no prompt
                # Use query() to send the actual message
                await client.query(prompt)

                # Stream all response messages
                async for message in client.receive_messages():
                    for event in self._process_message(message):
                        yield event

                    # Break when we get the final result
                    if type(message).__name__ == 'ResultMessage':
                        break

            yield {"type": "done"}

        except Exception as e:
            yield {"type": "error", "content": str(e)}

    def _process_message(self, message) -> List[Dict[str, Any]]:
        """Process a message from the agent SDK into SSE events."""
        events = []
        msg_type = type(message).__name__

        # Handle AssistantMessage - contains text and tool use blocks
        if msg_type == 'AssistantMessage':
            if hasattr(message, 'content') and message.content:
                for block in message.content:
                    block_type = type(block).__name__

                    if block_type == 'TextBlock':
                        text = getattr(block, 'text', '')
                        if text:
                            events.append({
                                "type": "text",
                                "content": text
                            })
                    elif block_type == 'ThinkingBlock':
                        thinking = getattr(block, 'thinking', '')
                        if thinking:
                            events.append({
                                "type": "thinking",
                                "content": thinking
                            })
                    elif block_type == 'ToolUseBlock':
                        events.append({
                            "type": "tool_use",
                            "id": getattr(block, 'id', ''),
                            "name": getattr(block, 'name', ''),
                            "input": getattr(block, 'input', {})
                        })
                    elif block_type == 'ToolResultBlock':
                        events.append({
                            "type": "tool_result",
                            "tool_use_id": getattr(block, 'tool_use_id', ''),
                            "content": getattr(block, 'content', ''),
                            "is_error": getattr(block, 'is_error', False)
                        })

        # Handle UserMessage - contains tool results
        elif msg_type == 'UserMessage':
            if hasattr(message, 'content') and message.content:
                for block in message.content:
                    block_type = type(block).__name__
                    if block_type == 'ToolResultBlock':
                        tool_use_id = getattr(block, 'tool_use_id', '')
                        content = getattr(block, 'content', '')
                        is_error = getattr(block, 'is_error', False)
                        # Content might be a list of content blocks
                        if isinstance(content, list):
                            text_parts = []
                            for c in content:
                                if hasattr(c, 'text'):
                                    text_parts.append(c.text)
                                elif isinstance(c, dict) and 'text' in c:
                                    text_parts.append(c['text'])
                            content = '\n'.join(text_parts)

                        # Check if this is a surface_content result
                        content_str = str(content) if content else ''
                        surface_event = self._parse_surface_content(content_str)
                        if surface_event:
                            events.append(surface_event)

                        events.append({
                            "type": "tool_result",
                            "tool_use_id": tool_use_id,
                            "content": content_str,
                            "is_error": bool(is_error)  # Convert None to False
                        })

        # Handle ToolResultMessage - result of tool execution (legacy)
        elif msg_type == 'ToolResultMessage':
            tool_use_id = getattr(message, 'tool_use_id', '')
            content = getattr(message, 'content', '')
            is_error = getattr(message, 'is_error', False)
            events.append({
                "type": "tool_result",
                "tool_use_id": tool_use_id,
                "content": str(content) if content else '',
                "is_error": is_error
            })

        # Handle ResultMessage - final result with metadata
        # Note: Don't emit text from ResultMessage as it duplicates AssistantMessage
        elif msg_type == 'ResultMessage':
            subtype = getattr(message, 'subtype', '')
            if subtype == 'success':
                events.append({
                    "type": "result",
                    "duration_ms": getattr(message, 'duration_ms', None),
                    "total_cost_usd": getattr(message, 'total_cost_usd', None)
                })

        # Handle SystemMessage - capture session ID from init message
        elif msg_type == 'SystemMessage':
            subtype = getattr(message, 'subtype', '')
            if subtype == 'init':
                # Session ID can be in session_id attribute or in data dict
                sid = getattr(message, 'session_id', None)
                if not sid and hasattr(message, 'data'):
                    sid = message.data.get('session_id')
                if sid:
                    events.append({
                        "type": "session_id",
                        "session_id": sid
                    })

        return events

    def _parse_surface_content(self, content: str) -> Optional[Dict[str, Any]]:
        """Check if content is surface_content JSON and parse it."""
        try:
            # Try to parse as JSON
            data = json.loads(content)
            # Check if it's a surface_content result
            if isinstance(data, dict) and data.get("type") == "surface_content":
                print(f"[Surface] Detected surface_content: id={data.get('content_id')}, title={data.get('title')}")
                return {
                    "type": "surface_content",
                    "content_id": data.get("content_id", ""),
                    "content": data.get("content", ""),
                    "content_type": data.get("content_type", "markdown"),
                    "title": data.get("title"),
                    "saved_to": data.get("saved_to")
                }
        except (json.JSONDecodeError, TypeError):
            pass
        return None


# Singleton instance
_agent_client: Optional[AgentClient] = None


def get_agent_client() -> AgentClient:
    """Get or create the singleton agent client instance."""
    global _agent_client
    if _agent_client is None:
        _agent_client = AgentClient()
    return _agent_client


def is_sdk_available() -> bool:
    """Check if the Claude Agent SDK is available."""
    return SDK_AVAILABLE


def is_sdk_client_available() -> bool:
    """Check if ClaudeSDKClient is available for persistent sessions."""
    return SDK_AVAILABLE


def get_sdk_import_error() -> Optional[str]:
    """Get the SDK import error if any."""
    return SDK_IMPORT_ERROR

"""Claude Agent SDK client wrapper with streaming support.

This module provides integration with the Claude Code SDK for agent-based
chat functionality with tool use (Read/Write file operations).

Note: The claude-code-sdk package must be installed for agent chat to work.
If not installed, agent conversations will show an error message.
"""

import os
from typing import AsyncIterator, Optional, List, Dict, Any
from dotenv import load_dotenv

load_dotenv()

# Try to import the Claude Code SDK
SDK_AVAILABLE = False
SDK_IMPORT_ERROR = None
try:
    from claude_code_sdk import query, ClaudeCodeOptions
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


class AgentClient:
    """Wrapper for Claude Agent SDK with streaming support."""

    def __init__(self):
        api_key = os.getenv("ANTHROPIC_API_KEY")
        if not api_key:
            raise ValueError("ANTHROPIC_API_KEY environment variable is required")
        self.api_key = api_key

    async def stream_agent_response(
        self,
        messages: List[Dict[str, Any]],
        workspace_path: str,
        system_prompt: Optional[str] = None,
        model: Optional[str] = None,
        session_id: Optional[str] = None,
        memory_path: Optional[str] = None
    ) -> AsyncIterator[Dict[str, Any]]:
        """
        Stream agent responses as SSE-compatible events.

        Args:
            messages: Conversation history
            workspace_path: Working directory for agent file operations
            system_prompt: Optional system prompt
            model: Optional model override
            session_id: Optional session ID to resume a previous conversation
            memory_path: Optional path to memory directory (for project-shared memories)

        Yields:
            Events with types: 'session_id', 'text', 'tool_use', 'tool_result', 'done', 'error'
        """
        if not SDK_AVAILABLE:
            yield {
                "type": "error",
                "content": f"Claude Code SDK not installed: {SDK_IMPORT_ERROR}"
            }
            return

        try:
            # Get the user's latest message
            user_message = ""
            if messages:
                last_msg = messages[-1]
                if isinstance(last_msg.get("content"), str):
                    user_message = last_msg["content"]
                elif isinstance(last_msg.get("content"), list):
                    # Extract text from content blocks
                    text_blocks = [
                        b.get("text", "") for b in last_msg["content"]
                        if b.get("type") == "text"
                    ]
                    user_message = "\n".join(text_blocks)

            # Configure agent options with explicit tool list
            allowed_tools = [
                "Read",
                "Write",
                "Edit",
                "Bash",
                "Glob",
                "Grep",
                "WebSearch",
                "WebFetch",
                "Task",
            ]
            if GIF_TOOL_AVAILABLE:
                allowed_tools.append("mcp__gif-search__search_gif")

            # Add memory tools if memory path is provided
            if memory_path and MEMORY_TOOL_AVAILABLE:
                allowed_tools.extend([
                    "mcp__memory__memory_view",
                    "mcp__memory__memory_create",
                    "mcp__memory__memory_str_replace",
                    "mcp__memory__memory_insert",
                    "mcp__memory__memory_delete",
                    "mcp__memory__memory_rename",
                ])

            options = ClaudeCodeOptions(
                cwd=workspace_path,
                allowed_tools=allowed_tools,
                permission_mode="acceptEdits",
            )

            # Build MCP servers configuration
            mcp_servers = {}

            # Add GIF MCP server if available
            if GIF_TOOL_AVAILABLE:
                mcp_servers["gif-search"] = {
                    "command": "python3",
                    "args": [str(GIF_MCP_SERVER_PATH)]
                }

            # Add memory MCP server if memory path is provided
            if memory_path and MEMORY_TOOL_AVAILABLE:
                mcp_servers["memory"] = {
                    "command": "python3",
                    "args": [str(MEMORY_MCP_SERVER_PATH), "--memory-path", memory_path]
                }

            if mcp_servers:
                options.mcp_servers = mcp_servers

            if system_prompt:
                options.system_prompt = system_prompt

            if model:
                options.model = model

            # Resume previous session if session_id is provided
            if session_id:
                options.resume = session_id

            # Stream responses from agent using the query function
            async for message in query(prompt=user_message, options=options):
                # Handle different message types from the SDK
                for event in self._process_message(message):
                    yield event

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
                        events.append({
                            "type": "tool_result",
                            "tool_use_id": tool_use_id,
                            "content": str(content) if content else '',
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


# Singleton instance
_agent_client: Optional[AgentClient] = None


def get_agent_client() -> AgentClient:
    """Get or create the singleton agent client instance."""
    global _agent_client
    if _agent_client is None:
        _agent_client = AgentClient()
    return _agent_client


def is_sdk_available() -> bool:
    """Check if the Claude Code SDK is available."""
    return SDK_AVAILABLE


def get_sdk_import_error() -> Optional[str]:
    """Get the SDK import error if any."""
    return SDK_IMPORT_ERROR

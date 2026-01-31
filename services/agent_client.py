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
    from claude_agent_sdk import query, ClaudeAgentOptions
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

    async def stream_agent_response(
        self,
        messages: List[Dict[str, Any]],
        workspace_path: str,
        system_prompt: Optional[str] = None,
        model: Optional[str] = None,
        session_id: Optional[str] = None,
        memory_path: Optional[str] = None,
        enabled_tools: Optional[Dict[str, bool]] = None,
        thinking_budget: Optional[int] = None,
        conversation_id: Optional[str] = None
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
            conversation_id: Optional conversation ID for workspace-aware tools
            enabled_tools: Optional dict of tool names to enabled state. If None, all tools are enabled.
                          Example: {"Read": True, "Write": False, "Bash": True}
            thinking_budget: Optional thinking budget in tokens for extended thinking

        Yields:
            Events with types: 'session_id', 'text', 'tool_use', 'tool_result', 'done', 'error'
        """
        if not SDK_AVAILABLE:
            yield {
                "type": "error",
                "content": f"Claude Agent SDK not installed: {SDK_IMPORT_ERROR}"
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
            # Define base tools that can be toggled
            base_tools = [
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

            # Build disallowed_tools list based on enabled_tools setting
            # Using disallowed_tools is more reliable than allowed_tools
            disallowed_tools = []
            if enabled_tools is not None:
                # Add disabled base tools to disallowed list
                for tool in base_tools:
                    if not enabled_tools.get(tool, True):
                        disallowed_tools.append(tool)

                # Handle GIF tool
                if GIF_TOOL_AVAILABLE and not enabled_tools.get("GIF", True):
                    disallowed_tools.append("mcp__gif-search__search_gif")

                # Handle memory tools
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

            # Capture stderr for debugging
            def stderr_callback(line: str):
                print(f"[AGENT_CLIENT STDERR] {line}")

            options = ClaudeAgentOptions(
                cwd=workspace_path,
                disallowed_tools=disallowed_tools if disallowed_tools else [],
                permission_mode="bypassPermissions",  # Auto-accept all permissions since user controls tools via UI
                max_thinking_tokens=thinking_budget if thinking_budget and thinking_budget > 0 else None,
                stderr=stderr_callback,
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

            # Add surface MCP server if available (needs workspace and conversation_id)
            if SURFACE_TOOL_AVAILABLE and conversation_id:
                # Check if Surface tool is enabled
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

            # Resume previous session if session_id is provided
            if session_id:
                options.resume = session_id

            # Stream responses from agent using the query function
            # If resumption fails, retry without session_id (start fresh)
            try:
                async for message in query(prompt=user_message, options=options):
                    # Handle different message types from the SDK
                    for event in self._process_message(message):
                        yield event
            except Exception as resume_error:
                error_msg = str(resume_error).lower()
                # Check if this is a session resumption failure
                if session_id and ("exit code 1" in error_msg or "command failed" in error_msg):
                    print(f"[AGENT_CLIENT] Session resumption failed, starting fresh session. Error: {resume_error}")
                    # Retry without session resumption
                    options.resume = None
                    yield {
                        "type": "info",
                        "content": "Previous session expired. Starting fresh conversation."
                    }
                    async for message in query(prompt=user_message, options=options):
                        for event in self._process_message(message):
                            yield event
                else:
                    raise resume_error

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


def get_sdk_import_error() -> Optional[str]:
    """Get the SDK import error if any."""
    return SDK_IMPORT_ERROR

# Complete Codebase for Review

This document contains all source code files from the chat-ui application.

It is a Flask-based web application that provides a chat interface for Claude AI,
with support for the Claude Agent SDK, MCP tools, file attachments, and more.

## Table of Contents

- [Core Application](#core-application)
- [API Routes](#api-routes)
- [Services](#services)
- [MCP Tool Servers](#mcp-tool-servers)
- [Frontend JavaScript](#frontend-javascript)
- [Frontend Styles](#frontend-styles)
- [HTML Templates](#html-templates)

---

## Core Application

### `app.py`

**Purpose:** Main Flask application entry point - defines routes and initializes the web server

```python
"""FastAPI application entry point for Claude Chat UI."""

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.requests import Request
from dotenv import load_dotenv

from api import chat_router, conversations_router, files_router, agent_chat_router, settings_router, projects_router, docs_router
from services.file_conversation_store import FileConversationStore

# Load environment variables
load_dotenv()

# Initialize store for startup
store = FileConversationStore()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan handler."""
    # Startup: Initialize database
    await store.initialize()
    yield
    # Shutdown: Nothing to clean up


# Create FastAPI app
app = FastAPI(
    title="Claude Chat UI",
    description="A full-featured chat interface for Claude models",
    version="1.0.0",
    lifespan=lifespan
)

# Mount static files
app.mount("/static", StaticFiles(directory="static"), name="static")

# Setup templates
templates = Jinja2Templates(directory="templates")

# Include routers
app.include_router(chat_router)
app.include_router(conversations_router)
app.include_router(files_router)
app.include_router(agent_chat_router)
app.include_router(settings_router)
app.include_router(projects_router)
app.include_router(docs_router)


@app.get("/")
async def index(request: Request):
    """Serve the main application page."""
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/health")
async def health():
    """Health check endpoint."""
    return {"status": "healthy"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8079, reload=True)

```

---

### `config.py`

**Purpose:** Configuration settings for the application (API keys, paths, etc.)

```python
"""Configuration constants and model definitions for Claude Chat UI."""

from dataclasses import dataclass
from typing import Optional


@dataclass
class ModelConfig:
    """Configuration for a Claude model."""
    id: str
    name: str
    supports_thinking: bool
    max_tokens: int
    description: str


# Available Claude models
MODELS = {
    "claude-opus-4-5-20251101": ModelConfig(
        id="claude-opus-4-5-20251101",
        name="Claude Opus 4.5",
        supports_thinking=True,
        max_tokens=64000,  # API limit for output tokens
        description="Most capable model, best for complex tasks"
    ),
    "claude-sonnet-4-5-20250929": ModelConfig(
        id="claude-sonnet-4-5-20250929",
        name="Claude Sonnet 4.5",
        supports_thinking=True,
        max_tokens=64000,  # API limit for output tokens
        description="Balanced performance and speed with extended thinking"
    ),
    "claude-sonnet-4-20250514": ModelConfig(
        id="claude-sonnet-4-20250514",
        name="Claude Sonnet 4",
        supports_thinking=True,
        max_tokens=64000,  # API limit for output tokens
        description="Fast and capable"
    ),
    "claude-3-5-sonnet-20241022": ModelConfig(
        id="claude-3-5-sonnet-20241022",
        name="Claude 3.5 Sonnet",
        supports_thinking=False,
        max_tokens=8192,
        description="Previous generation, fast responses"
    ),
    "claude-3-5-haiku-20241022": ModelConfig(
        id="claude-3-5-haiku-20241022",
        name="Claude 3.5 Haiku",
        supports_thinking=False,
        max_tokens=8192,
        description="Fastest model, best for simple tasks"
    ),
}

# Default model
DEFAULT_MODEL = "claude-opus-4-5-20251101"

# Default parameters
DEFAULT_TEMPERATURE = 1.0
DEFAULT_MAX_TOKENS = 4096
DEFAULT_TOP_P = 1.0
DEFAULT_TOP_K = 0  # 0 means disabled

# Extended thinking limits
# thinking_budget should be less than max_tokens to leave room for response
MIN_THINKING_BUDGET = 1024
MAX_THINKING_BUDGET = 50000  # Keep under max output tokens (64K)
DEFAULT_THINKING_BUDGET = 10000
MAX_OUTPUT_TOKENS = 64000  # Standard API max output limit

# File upload limits
MAX_IMAGE_SIZE = 5 * 1024 * 1024  # 5MB
MAX_PDF_SIZE = 32 * 1024 * 1024  # 32MB
MAX_TEXT_SIZE = 1 * 1024 * 1024  # 1MB
MAX_PDF_PAGES = 100

# Allowed file types
ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/gif", "image/webp"}
ALLOWED_DOCUMENT_TYPES = {"application/pdf"}
ALLOWED_TEXT_EXTENSIONS = {".txt", ".md", ".py", ".js", ".ts", ".json", ".yaml", ".yml", ".html", ".css", ".xml", ".csv"}

# Storage paths
DATABASE_PATH = "data/conversations.db"  # Legacy SQLite path (for reference)
CONVERSATIONS_PATH = "data/conversations"  # File-based conversation storage

```

---

## API Routes

### `api/__init__.py`

**Purpose:** API module initialization - registers blueprints

```python
"""API routes module for Claude Chat UI."""

from .chat import router as chat_router
from .conversations import router as conversations_router
from .files import router as files_router
from .agent_chat import router as agent_chat_router
from .settings import router as settings_router
from .projects import router as projects_router
from .docs import router as docs_router

__all__ = ["chat_router", "conversations_router", "files_router", "agent_chat_router", "settings_router", "projects_router", "docs_router"]

```

---

### `api/agent_chat.py`

**Purpose:** API endpoints for Claude agent-based chat functionality using the Agent SDK

```python
"""Agent chat streaming endpoints using Claude Agent SDK."""

import asyncio
import json
import os
from typing import Optional, List, Any, Dict
from fastapi import APIRouter, HTTPException, UploadFile, File
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from services.agent_client import get_agent_client, is_sdk_available, get_sdk_import_error
from services.file_conversation_store import FileConversationStore
from services.project_store import ProjectStore
from api.settings import get_project_settings, load_default_settings

router = APIRouter(prefix="/api/agent-chat", tags=["agent-chat"])

# Initialize stores
store = FileConversationStore()
project_store = ProjectStore()

# Track active streams for cancellation - map of conversation_id to asyncio.Event
active_streams: Dict[str, asyncio.Event] = {}

# Memory system prompt instruction
MEMORY_SYSTEM_PROMPT = """
IMPORTANT: You have access to a persistent memory system. ALWAYS check your memory at the start of conversations.

MEMORY PROTOCOL:
1. Use `memory_view` with path "/memories" to see what memories exist.
2. Read relevant memory files to recall past context, decisions, and progress.
3. As you work, save important information to memory using `memory_create` or update existing files with `memory_str_replace`.
4. Keep memories organized - use descriptive filenames, update rather than duplicate.

Your memories persist across conversations, so record anything you'd want to remember later.
"""


class AgentChatRequest(BaseModel):
    """Request to stream agent chat."""
    messages: List[dict]
    conversation_id: Optional[str] = None
    branch: Optional[List[int]] = None
    system_prompt: Optional[str] = None
    model: Optional[str] = None


@router.post("/stream")
async def stream_agent_chat(request: AgentChatRequest):
    """Stream agent chat responses using SSE."""

    async def event_generator():
        agent_client = get_agent_client()
        conversation_id = request.conversation_id
        branch = request.branch or [0]

        # Create stop event for this stream
        stop_event = asyncio.Event()
        if conversation_id:
            active_streams[conversation_id] = stop_event

        # Get workspace path, session_id, and memory path for this conversation
        workspace_path = None
        existing_session_id = None
        memory_path = None
        msg_record = None
        enabled_tools = None
        custom_cwd = None
        project_id = None
        thinking_budget = None

        if conversation_id:
            workspace_path = store.get_workspace_path(conversation_id)
            # Create workspace if needed
            os.makedirs(workspace_path, exist_ok=True)

            # Get existing session_id from conversation metadata for resumption
            try:
                conv = await store.get_conversation(conversation_id)
                if conv:
                    existing_session_id = conv.get("session_id")
            except Exception:
                pass  # Continue without session_id if we can't get it

            # Determine memory path based on whether conversation is in a project
            try:
                project_id = await project_store.get_project_for_conversation(conversation_id)
                if project_id:
                    # Use shared project memory
                    memory_path = project_store.get_project_memory_path(project_id)
                else:
                    # Use conversation-specific memory
                    memory_path = project_store.get_conversation_memory_path(conversation_id)
                # Ensure memory directory exists
                os.makedirs(memory_path, exist_ok=True)
            except Exception as e:
                print(f"Warning: Could not determine memory path: {e}")

            # Get settings for tool toggles and CWD
            # Priority: conversation settings > project settings > default settings
            try:
                # Start with default settings
                settings = load_default_settings()
                print(f"[AGENT] Default settings agent_tools: {settings.get('agent_tools')}")

                # Override with project settings if in a project
                if project_id:
                    project_settings = get_project_settings(project_id)
                    print(f"[AGENT] Project {project_id} settings agent_tools: {project_settings.get('agent_tools')}")
                    settings.update({k: v for k, v in project_settings.items() if v is not None})

                # Override with conversation settings
                conv_settings = conv.get("settings", {}) if conv else {}
                print(f"[AGENT] Conversation settings: {conv_settings}")
                settings.update({k: v for k, v in conv_settings.items() if v is not None})

                # Get enabled tools from settings
                enabled_tools = settings.get("agent_tools")
                print(f"[AGENT] Final enabled_tools: {enabled_tools}")

                # Get custom CWD from settings
                custom_cwd = settings.get("agent_cwd")
                if custom_cwd and os.path.isdir(custom_cwd):
                    workspace_path = custom_cwd

                # Get thinking budget from settings
                thinking_budget = settings.get("agent_thinking_budget")
                print(f"[AGENT] Thinking budget: {thinking_budget}")
            except Exception as e:
                print(f"Warning: Could not load settings: {e}")

            # Create assistant message record in DB first
            try:
                msg_record = await store.add_message(
                    conversation_id=conversation_id,
                    role="assistant",
                    content="",  # Will be updated as streaming progresses
                    branch=branch,
                    streaming=True
                )
                yield f"data: {json.dumps({'type': 'message_id', 'id': msg_record['id']})}\n\n"
            except Exception as e:
                yield f"data: {json.dumps({'type': 'error', 'content': f'Failed to create message: {str(e)}'})}\n\n"
                return

        # Track accumulated content for final DB save
        accumulated_content = []
        tool_results = []
        current_text = ""
        new_session_id = None

        stopped = False
        try:
            # Build system prompt with memory instructions if memory is available
            system_prompt = request.system_prompt or ""
            if memory_path:
                system_prompt = MEMORY_SYSTEM_PROMPT + "\n\n" + system_prompt

            async for event in agent_client.stream_agent_response(
                messages=request.messages,
                workspace_path=workspace_path or os.getcwd(),
                system_prompt=system_prompt if system_prompt.strip() else None,
                model=request.model,
                session_id=existing_session_id,  # Pass session_id for resumption
                memory_path=memory_path,  # Pass memory path for project-shared memories
                enabled_tools=enabled_tools,  # Pass enabled tools from settings
                thinking_budget=thinking_budget,  # Pass thinking budget from settings
                conversation_id=conversation_id  # Pass conversation_id for workspace tools
            ):
                # Check if stop was requested
                if stop_event.is_set():
                    stopped = True
                    yield f"data: {json.dumps({'type': 'stopped', 'content': 'Stream stopped by user'})}\n\n"
                    break

                # Send event to client
                yield f"data: {json.dumps(event)}\n\n"

                # Capture session_id from init message
                if event["type"] == "session_id":
                    new_session_id = event["session_id"]
                    # Save session_id to conversation metadata
                    if conversation_id and new_session_id:
                        try:
                            await store.update_conversation_session_id(
                                conversation_id=conversation_id,
                                session_id=new_session_id
                            )
                        except Exception as e:
                            # Log but don't fail the stream
                            print(f"Failed to save session_id: {e}")

                # Accumulate content for DB save
                elif event["type"] == "text":
                    current_text += event["content"]
                elif event["type"] == "tool_use":
                    # If we have accumulated text, save it first
                    if current_text:
                        accumulated_content.append({
                            "type": "text",
                            "text": current_text
                        })
                        current_text = ""
                    accumulated_content.append({
                        "type": "tool_use",
                        "id": event["id"],
                        "name": event["name"],
                        "input": event["input"]
                    })
                elif event["type"] == "tool_result":
                    tool_results.append({
                        "tool_use_id": event["tool_use_id"],
                        "content": event.get("content", ""),
                        "is_error": event.get("is_error", False)
                    })
                elif event["type"] == "surface_content":
                    # Save surface content to file and store reference
                    content_id = event.get("content_id", "")
                    content_type = event.get("content_type", "html")
                    content = event.get("content", "")
                    title = event.get("title")

                    # Always save to conversation workspace (not agent CWD)
                    # This ensures the API can find it when loading
                    save_path = store.get_workspace_path(conversation_id) if conversation_id else None

                    if save_path and conversation_id:
                        ext = ".html" if content_type == "html" else ".md"
                        filename = f"surface_{content_id}{ext}"
                        filepath = os.path.join(save_path, filename)

                        try:
                            # Ensure directory exists
                            os.makedirs(save_path, exist_ok=True)

                            with open(filepath, 'w', encoding='utf-8') as f:
                                f.write(content)
                            print(f"Saved surface content to: {filepath}")

                            # If we have accumulated text, save it first
                            if current_text:
                                accumulated_content.append({
                                    "type": "text",
                                    "text": current_text
                                })
                                current_text = ""

                            # Store reference, not full content
                            accumulated_content.append({
                                "type": "surface_content",
                                "content_id": content_id,
                                "content_type": content_type,
                                "title": title,
                                "filename": filename  # Reference to file
                            })
                        except Exception as e:
                            print(f"Failed to save surface content to {filepath}: {e}")
                            # Fallback: store content inline if file save fails
                            accumulated_content.append({
                                "type": "surface_content",
                                "content_id": content_id,
                                "content_type": content_type,
                                "title": title,
                                "content": content  # Inline content as fallback
                            })
                    else:
                        print(f"No workspace path available for surface content, storing inline")
                        # Store inline if no workspace
                        accumulated_content.append({
                            "type": "surface_content",
                            "content_id": content_id,
                            "content_type": content_type,
                            "title": title,
                            "content": content
                        })

            # Add any remaining text
            if current_text:
                accumulated_content.append({
                    "type": "text",
                    "text": current_text
                })

            # Add stopped indicator to content if stopped
            if stopped and accumulated_content:
                accumulated_content.append({
                    "type": "text",
                    "text": "\n\n*[Response stopped by user]*"
                })
            elif stopped:
                accumulated_content.append({
                    "type": "text",
                    "text": "*[Response stopped by user]*"
                })

            # Final DB save
            if conversation_id and msg_record:
                # Prepare final content - keep as array if it has tool_use or surface_content blocks
                has_special_blocks = any(
                    c.get("type") in ("tool_use", "surface_content") for c in accumulated_content
                )
                final_content = accumulated_content if len(accumulated_content) > 1 or has_special_blocks \
                    else (accumulated_content[0].get("text", "") if accumulated_content else "")

                await store.update_message_content(
                    conversation_id=conversation_id,
                    message_id=msg_record["id"],
                    content=final_content,
                    tool_results=tool_results if tool_results else None,
                    branch=branch
                )

        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'content': str(e)})}\n\n"
        finally:
            # Clean up active stream tracking
            if conversation_id and conversation_id in active_streams:
                del active_streams[conversation_id]

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        }
    )


@router.post("/stop/{conversation_id}")
async def stop_agent_stream(conversation_id: str):
    """Stop an active agent chat stream."""
    if conversation_id in active_streams:
        active_streams[conversation_id].set()
        return {"success": True, "message": "Stop signal sent"}
    return {"success": False, "message": "No active stream found for this conversation"}


@router.get("/streaming/{conversation_id}")
async def get_streaming_status(conversation_id: str):
    """Check if a conversation has an active stream."""
    return {
        "streaming": conversation_id in active_streams
    }


@router.get("/status")
async def get_agent_status():
    """Check if Agent SDK is available."""
    error = get_sdk_import_error()
    return {
        "sdk_available": is_sdk_available(),
        "message": "Claude Code SDK is ready" if is_sdk_available() else "Claude Code SDK not installed",
        "error": error
    }


@router.get("/surface-content/{conversation_id}/{filename}")
async def get_surface_content(conversation_id: str, filename: str):
    """Get surface content file from workspace."""
    workspace_path = store.get_workspace_path(conversation_id)
    file_path = os.path.join(workspace_path, filename)

    # Security check
    real_workspace = os.path.realpath(workspace_path)
    real_file = os.path.realpath(file_path)
    if not real_file.startswith(real_workspace):
        raise HTTPException(status_code=403, detail="Access denied")

    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Surface content not found")

    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
        return {"content": content}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/workspace/{conversation_id}")
async def get_workspace_files(conversation_id: str):
    """List files in conversation workspace."""
    workspace_path = store.get_workspace_path(conversation_id)

    if not os.path.exists(workspace_path):
        return {"files": []}

    files = []
    for item in os.listdir(workspace_path):
        item_path = os.path.join(workspace_path, item)
        files.append({
            "name": item,
            "is_dir": os.path.isdir(item_path),
            "size": os.path.getsize(item_path) if os.path.isfile(item_path) else None
        })

    return {"files": files, "workspace_path": workspace_path}


@router.delete("/workspace/{conversation_id}/{filename}")
async def delete_workspace_file(conversation_id: str, filename: str):
    """Delete a file from conversation workspace."""
    workspace_path = store.get_workspace_path(conversation_id)
    file_path = os.path.join(workspace_path, filename)

    # Security check - ensure file is within workspace
    real_workspace = os.path.realpath(workspace_path)
    real_file = os.path.realpath(file_path)
    if not real_file.startswith(real_workspace):
        raise HTTPException(status_code=400, detail="Invalid file path")

    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="File not found")

    try:
        if os.path.isfile(file_path):
            os.remove(file_path)
        elif os.path.isdir(file_path):
            import shutil
            shutil.rmtree(file_path)
        return {"success": True, "message": f"Deleted {filename}"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to delete file: {str(e)}")


@router.post("/workspace/{conversation_id}/upload")
async def upload_workspace_file(conversation_id: str, file: UploadFile = File(...)):
    """Upload a file to conversation workspace."""
    workspace_path = store.get_workspace_path(conversation_id)

    # Create workspace directory if it doesn't exist
    os.makedirs(workspace_path, exist_ok=True)

    # Sanitize filename to prevent directory traversal
    filename = os.path.basename(file.filename)
    if not filename or filename.startswith('.'):
        raise HTTPException(status_code=400, detail="Invalid filename")

    file_path = os.path.join(workspace_path, filename)

    # Security check - ensure file is within workspace
    real_workspace = os.path.realpath(workspace_path)
    real_file = os.path.realpath(file_path)
    if not real_file.startswith(real_workspace):
        raise HTTPException(status_code=400, detail="Invalid file path")

    try:
        # Write file
        with open(file_path, "wb") as f:
            content = await file.read()
            f.write(content)

        return {
            "success": True,
            "message": f"Uploaded {filename}",
            "filename": filename,
            "size": len(content)
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to upload file: {str(e)}")


@router.get("/memory/{conversation_id}")
async def get_memory_files(conversation_id: str):
    """List memory files for a conversation (or its project if in one)."""
    # Determine memory path based on whether conversation is in a project
    try:
        project_id = await project_store.get_project_for_conversation(conversation_id)
        if project_id:
            memory_path = project_store.get_project_memory_path(project_id)
            is_project_memory = True
        else:
            memory_path = project_store.get_conversation_memory_path(conversation_id)
            is_project_memory = False
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get memory path: {str(e)}")

    if not os.path.exists(memory_path):
        return {
            "files": [],
            "memory_path": memory_path,
            "is_project_memory": is_project_memory,
            "project_id": project_id if is_project_memory else None
        }

    files = []
    for item in os.listdir(memory_path):
        item_path = os.path.join(memory_path, item)
        if not item.startswith('.'):  # Skip hidden files
            files.append({
                "name": item,
                "is_dir": os.path.isdir(item_path),
                "size": os.path.getsize(item_path) if os.path.isfile(item_path) else None
            })

    return {
        "files": files,
        "memory_path": memory_path,
        "is_project_memory": is_project_memory,
        "project_id": project_id if is_project_memory else None
    }


@router.get("/memory/{conversation_id}/{filename:path}")
async def read_memory_file(conversation_id: str, filename: str):
    """Read a specific memory file."""
    # Determine memory path
    try:
        project_id = await project_store.get_project_for_conversation(conversation_id)
        if project_id:
            memory_path = project_store.get_project_memory_path(project_id)
        else:
            memory_path = project_store.get_conversation_memory_path(conversation_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get memory path: {str(e)}")

    file_path = os.path.join(memory_path, filename)

    # Security check
    real_memory = os.path.realpath(memory_path)
    real_file = os.path.realpath(file_path)
    if not real_file.startswith(real_memory):
        raise HTTPException(status_code=400, detail="Invalid file path")

    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Memory file not found")

    if os.path.isdir(file_path):
        raise HTTPException(status_code=400, detail="Cannot read directory")

    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
        return {
            "filename": filename,
            "content": content,
            "size": len(content)
        }
    except UnicodeDecodeError:
        raise HTTPException(status_code=400, detail="Binary file cannot be read")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read file: {str(e)}")

```

---

### `api/chat.py`

**Purpose:** API endpoints for standard chat functionality with Anthropic API

```python
"""Chat streaming endpoint using Server-Sent Events."""

import json
import asyncio
from typing import List, Dict, Any, Optional, Set
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from services.anthropic_client import AnthropicClient
from services.file_conversation_store import FileConversationStore
from config import DEFAULT_MODEL, DEFAULT_TEMPERATURE, DEFAULT_MAX_TOKENS, DEFAULT_THINKING_BUDGET

router = APIRouter(prefix="/api/chat", tags=["chat"])

# Initialize client and file store
client = AnthropicClient()
store = FileConversationStore()

# Track which conversations are currently streaming
streaming_conversations: Set[str] = set()


@router.on_event("startup")
async def startup():
    """Initialize storage and warm up API connection on startup."""
    await store.initialize()
    # Warm up Anthropic API connection in background
    asyncio.create_task(client.warmup())


class ContentBlock(BaseModel):
    """A content block in a message (text, image, or document)."""
    type: str
    text: Optional[str] = None
    source: Optional[Dict[str, Any]] = None


class Message(BaseModel):
    """A message in the conversation."""
    role: str
    content: Any  # Can be string or list of content blocks


class ChatRequest(BaseModel):
    """Request body for chat endpoint."""
    messages: List[Message]
    conversation_id: Optional[str] = None  # For saving streaming content to DB
    branch: Optional[List[int]] = None  # Current branch for saving
    model: str = DEFAULT_MODEL
    system_prompt: Optional[str] = None
    temperature: float = DEFAULT_TEMPERATURE
    max_tokens: int = DEFAULT_MAX_TOKENS
    top_p: Optional[float] = None
    top_k: Optional[int] = None
    thinking_enabled: bool = False
    thinking_budget: int = DEFAULT_THINKING_BUDGET
    web_search_enabled: bool = False
    web_search_max_uses: int = 5


@router.post("/stream")
async def stream_chat(request: ChatRequest):
    """
    Stream chat responses using Server-Sent Events.

    Events are formatted as:
    - type: 'thinking' - Extended thinking content
    - type: 'text' - Response text
    - type: 'error' - Error message
    - type: 'done' - Stream complete
    - type: 'message_id' - ID of the message being streamed (for DB updates)
    """

    async def event_generator():
        message_id = None
        text_content = ""
        thinking_content = ""
        conversation_id = request.conversation_id
        branch = request.branch or [0]

        # Track web search events for persistence
        web_search_blocks = []
        current_web_search = None

        # Use file store for all conversations

        # Convert messages to API format
        api_messages = []
        for msg in request.messages:
            if isinstance(msg.content, str):
                api_messages.append({"role": msg.role, "content": msg.content})
            else:
                # Handle content blocks (images, documents, etc.)
                content_blocks = []
                for block in msg.content:
                    if isinstance(block, dict):
                        content_blocks.append(block)
                    else:
                        content_blocks.append(block.model_dump(exclude_none=True))
                api_messages.append({"role": msg.role, "content": content_blocks})

        # If we have a conversation_id, create the message record first
        if conversation_id:
            streaming_conversations.add(conversation_id)
            try:
                print(f"[STREAM] Creating message for conversation {conversation_id} using store: {type(store).__name__}")
                msg_record = await store.add_message(
                    conversation_id=conversation_id,
                    role="assistant",
                    content="",
                    thinking=None,
                    branch=branch,
                    streaming=True
                )
                message_id = msg_record["id"]
                print(f"[STREAM] Created message {message_id} at position {msg_record['position']}")
                # Send message_id to frontend so it knows which message is streaming
                yield f"data: {json.dumps({'type': 'message_id', 'id': message_id, 'position': msg_record['position']})}\n\n"
            except Exception as e:
                print(f"[STREAM] Error creating message: {e}")
                yield f"data: {json.dumps({'type': 'error', 'content': str(e)})}\n\n"
                return

        update_counter = 0
        try:
            async for event in client.stream_message(
                messages=api_messages,
                model=request.model,
                system_prompt=request.system_prompt,
                temperature=request.temperature,
                max_tokens=request.max_tokens,
                top_p=request.top_p,
                top_k=request.top_k,
                thinking_enabled=request.thinking_enabled,
                thinking_budget=request.thinking_budget,
                web_search_enabled=request.web_search_enabled,
                web_search_max_uses=request.web_search_max_uses,
            ):
                yield f"data: {json.dumps(event)}\n\n"

                # Accumulate content
                if event.get("type") == "thinking":
                    thinking_content += event.get("content", "")
                elif event.get("type") == "text":
                    text_content += event.get("content", "")
                elif event.get("type") == "web_search_start":
                    # Start tracking a new web search
                    current_web_search = {
                        "id": event.get("id"),
                        "query": "",
                        "results": []
                    }
                elif event.get("type") == "web_search_query":
                    # Accumulate the search query
                    if current_web_search:
                        current_web_search["query"] += event.get("partial_query", "")
                elif event.get("type") == "web_search_result":
                    # Web search completed - save results
                    search_id = event.get("tool_use_id")
                    if current_web_search and current_web_search["id"] == search_id:
                        current_web_search["results"] = event.get("results", [])
                        web_search_blocks.append(current_web_search)
                        current_web_search = None
                    elif current_web_search:
                        # ID mismatch - save with the event's ID
                        current_web_search["id"] = search_id
                        current_web_search["results"] = event.get("results", [])
                        web_search_blocks.append(current_web_search)
                        current_web_search = None

                # Update DB periodically (every 10 chunks) to avoid too many writes
                update_counter += 1
                if message_id and update_counter % 10 == 0:
                    print(f"[STREAM] Updating message {message_id} with {len(text_content)} chars")
                    await store.update_message_content(
                        conversation_id=conversation_id,
                        message_id=message_id,
                        content=text_content,
                        thinking=thinking_content if thinking_content else None,
                        branch=branch,
                        streaming=True
                    )

            # Final update to DB with complete content
            if message_id:
                # Include web search data if present
                if web_search_blocks:
                    final_content = {
                        "text": text_content,
                        "web_searches": web_search_blocks
                    }
                else:
                    final_content = text_content

                print(f"[STREAM] Final update for message {message_id}: {len(text_content)} chars, {len(web_search_blocks)} web searches, streaming=False")
                await store.update_message_content(
                    conversation_id=conversation_id,
                    message_id=message_id,
                    content=final_content,
                    thinking=thinking_content if thinking_content else None,
                    branch=branch,
                    streaming=False
                )

        finally:
            if conversation_id:
                streaming_conversations.discard(conversation_id)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        }
    )


@router.get("/streaming/{conversation_id}")
async def is_conversation_streaming(conversation_id: str):
    """Check if a conversation is currently streaming."""
    return {"streaming": conversation_id in streaming_conversations}


@router.get("/models")
async def get_models():
    """Get available models and their configurations."""
    return {"models": client.get_available_models()}

```

---

### `api/conversations.py`

**Purpose:** API endpoints for conversation management (CRUD operations)

```python
"""Conversation management endpoints."""

from typing import Optional, List, Any
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from services.file_conversation_store import FileConversationStore

router = APIRouter(prefix="/api/conversations", tags=["conversations"])

# Initialize file store (SQLite removed)
store = FileConversationStore()


class ConversationSettings(BaseModel):
    """Settings for a conversation."""
    thinking_enabled: Optional[bool] = None
    thinking_budget: Optional[int] = None
    max_tokens: Optional[int] = None
    temperature: Optional[float] = None
    top_p: Optional[float] = None
    top_k: Optional[int] = None
    prune_threshold: Optional[float] = None
    # Agent-specific settings
    agent_cwd: Optional[str] = None
    agent_tools: Optional[dict] = None


class CreateConversationRequest(BaseModel):
    """Request to create a new conversation."""
    title: str = "New Conversation"
    model: Optional[str] = None
    system_prompt: Optional[str] = None
    is_agent: bool = False
    settings: Optional[ConversationSettings] = None


class UpdateConversationRequest(BaseModel):
    """Request to update a conversation."""
    title: Optional[str] = None
    model: Optional[str] = None
    system_prompt: Optional[str] = None
    settings: Optional[ConversationSettings] = None


class AddMessageRequest(BaseModel):
    """Request to add a message to a conversation."""
    role: str
    content: Any
    thinking: Optional[str] = None
    branch: Optional[List[int]] = None


class EditMessageRequest(BaseModel):
    """Request to edit a user message (creates new branch)."""
    user_msg_index: int  # Which user message (0-based) to edit
    content: Any
    branch: Optional[List[int]] = None  # Current branch


class SwitchBranchRequest(BaseModel):
    """Request to switch to an adjacent branch."""
    user_msg_index: int  # Which user message position to switch at
    direction: int  # -1 for prev, +1 for next
    branch: Optional[List[int]] = None  # Current branch


class RetryMessageRequest(BaseModel):
    """Request to retry an assistant message."""
    position: int
    content: Any
    thinking: Optional[str] = None
    branch: Optional[List[int]] = None


class SetBranchRequest(BaseModel):
    """Request to set the current branch."""
    branch: List[int]


class DeleteMessagesRequest(BaseModel):
    """Request to delete messages from a position."""
    branch: Optional[List[int]] = None


@router.on_event("startup")
async def startup():
    """Initialize storage on startup."""
    await store.initialize()


@router.post("")
async def create_conversation(request: CreateConversationRequest):
    """Create a new conversation."""
    # Convert settings to dict if provided
    settings_dict = None
    if request.settings:
        settings_dict = {k: v for k, v in request.settings.model_dump().items() if v is not None}
        print(f"[API] Creating conversation with settings: {settings_dict}")

    conversation = await store.create_conversation(
        title=request.title,
        model=request.model,
        system_prompt=request.system_prompt,
        is_agent=request.is_agent,
        settings=settings_dict
    )
    return conversation


@router.get("")
async def list_conversations():
    """List all conversations."""
    conversations = await store.list_conversations()
    return {"conversations": conversations}


@router.get("/search")
async def search_conversations(q: str = Query(..., min_length=1)):
    """Search conversations by title or message content (partial match)."""
    conversations = await store.search_conversations(q)
    return {"conversations": conversations, "query": q}


@router.post("/{conversation_id}/duplicate")
async def duplicate_conversation(conversation_id: str):
    """Duplicate a conversation with all its branches."""
    new_conversation = await store.duplicate_conversation(conversation_id)
    if not new_conversation:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return new_conversation


@router.get("/{conversation_id}")
async def get_conversation(
    conversation_id: str,
    branch: Optional[str] = Query(None, description="Branch array as comma-separated ints, e.g. '0,1,2'")
):
    """Get a specific conversation with messages from specified branch."""
    branch_array = None
    if branch:
        try:
            branch_array = [int(x) for x in branch.split(",")]
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid branch format")

    conversation = await store.get_conversation(conversation_id, branch_array)
    if not conversation:
        raise HTTPException(status_code=404, detail="Conversation not found")
    print(f"[GET_CONV] Loaded conversation {conversation_id} with {len(conversation.get('messages', []))} messages")
    return conversation


@router.put("/{conversation_id}")
async def update_conversation(conversation_id: str, request: UpdateConversationRequest):
    """Update conversation metadata."""
    # Convert settings to dict if provided
    settings_dict = None
    if request.settings:
        settings_dict = {k: v for k, v in request.settings.model_dump().items() if v is not None}

    success = await store.update_conversation(
        conversation_id=conversation_id,
        title=request.title,
        model=request.model,
        system_prompt=request.system_prompt,
        settings=settings_dict
    )
    if not success:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return {"success": True}


@router.delete("/{conversation_id}")
async def delete_conversation(conversation_id: str):
    """Delete a conversation."""
    success = await store.delete_conversation(conversation_id)
    if not success:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return {"success": True}


@router.post("/{conversation_id}/messages")
async def add_message(conversation_id: str, request: AddMessageRequest):
    """Add a message to a conversation branch."""
    try:
        message = await store.add_message(
            conversation_id=conversation_id,
            role=request.role,
            content=request.content,
            thinking=request.thinking,
            branch=request.branch
        )
        return message
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.get("/{conversation_id}/messages")
async def get_messages(
    conversation_id: str,
    branch: Optional[str] = Query(None)
):
    """Get all messages for a conversation branch."""
    branch_array = None
    if branch:
        try:
            branch_array = [int(x) for x in branch.split(",")]
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid branch format")

    messages = await store.get_messages(conversation_id, branch_array)
    return {"messages": messages}


@router.post("/{conversation_id}/edit")
async def edit_message(conversation_id: str, request: EditMessageRequest):
    """Edit a user message, creating a new branch."""
    try:
        result = await store.create_branch(
            conversation_id=conversation_id,
            current_branch=request.branch or [0],
            user_msg_index=request.user_msg_index,
            new_content=request.content
        )
        return result
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/{conversation_id}/switch-branch")
async def switch_branch(conversation_id: str, request: SwitchBranchRequest):
    """Switch to an adjacent branch at a user message position."""
    new_branch = await store.switch_branch(
        conversation_id=conversation_id,
        current_branch=request.branch or [0],
        user_msg_index=request.user_msg_index,
        direction=request.direction
    )
    if new_branch is None:
        raise HTTPException(status_code=404, detail="No branch in that direction")

    # Get the updated conversation
    conversation = await store.get_conversation(conversation_id, new_branch)
    return {
        "branch": new_branch,
        "conversation": conversation
    }


@router.post("/{conversation_id}/set-branch")
async def set_branch(conversation_id: str, request: SetBranchRequest):
    """Set the current branch for a conversation."""
    success = await store.set_current_branch(conversation_id, request.branch)
    if not success:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return {"success": True, "branch": request.branch}


@router.post("/{conversation_id}/retry")
async def retry_message(conversation_id: str, request: RetryMessageRequest):
    """Retry an assistant message, replacing it in the current branch."""
    try:
        message = await store.retry_assistant_message(
            conversation_id=conversation_id,
            branch=request.branch or [0],
            position=request.position,
            new_content=request.content,
            thinking=request.thinking
        )
        return message
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.get("/{conversation_id}/messages-up-to/{position}")
async def get_messages_up_to(
    conversation_id: str,
    position: int,
    branch: Optional[str] = Query(None)
):
    """Get messages up to (not including) a position. Used for retries."""
    branch_array = None
    if branch:
        try:
            branch_array = [int(x) for x in branch.split(",")]
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid branch format")

    messages = await store.get_messages_up_to(conversation_id, position, branch_array)
    return {"messages": messages}


@router.get("/{conversation_id}/branches")
async def list_branches(conversation_id: str):
    """List all branches in a conversation."""
    branches = await store.get_branches(conversation_id)
    return {"branches": branches}


@router.get("/{conversation_id}/version-info/{user_msg_index}")
async def get_version_info(
    conversation_id: str,
    user_msg_index: int,
    branch: Optional[str] = Query(None)
):
    """Get version info for a specific user message position."""
    branch_array = [0]
    if branch:
        try:
            branch_array = [int(x) for x in branch.split(",")]
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid branch format")

    version_info = await store.get_version_info(conversation_id, branch_array, user_msg_index)
    return version_info


@router.delete("/{conversation_id}/delete-from/{position}")
async def delete_messages_from(
    conversation_id: str,
    position: int,
    request: DeleteMessagesRequest
):
    """Delete messages from a position onwards (inclusive).

    This removes the message at the specified position and all messages after it.
    """
    success = await store.delete_messages_from(
        conversation_id=conversation_id,
        position=position,
        branch=request.branch
    )
    if not success:
        raise HTTPException(status_code=404, detail="Conversation or position not found")
    return {"success": True, "deleted_from": position}

```

---

### `api/docs.py`

**Purpose:** API endpoints for documentation-related features

```python
"""API routes for documentation and help resources."""

from pathlib import Path
from fastapi import APIRouter, HTTPException
from fastapi.responses import PlainTextResponse

router = APIRouter(prefix="/api/docs", tags=["docs"])

# Base directory
BASE_DIR = Path(__file__).parent.parent


@router.get("/capabilities", response_class=PlainTextResponse)
async def get_capabilities():
    """Get the capabilities documentation."""
    capabilities_path = BASE_DIR / "CAPABILITIES.md"
    if not capabilities_path.exists():
        raise HTTPException(status_code=404, detail="Capabilities documentation not found")

    return capabilities_path.read_text(encoding='utf-8')


@router.get("/code", response_class=PlainTextResponse)
async def get_backend_code():
    """Get key backend code files for understanding the implementation."""
    code_files = [
        "api/chat.py",
        "api/conversations.py",
        "api/projects.py",
        "api/agent_chat.py",
        "api/settings.py",
        "services/anthropic_client.py",
        "services/conversation_store.py",
        "services/file_conversation_store.py",
        "services/project_store.py",
        "services/agent_client.py",
        "config.py",
        "CLAUDE.md"
    ]

    combined_code = []
    combined_code.append("# BACKEND CODE REFERENCE\n")
    combined_code.append("# This document contains key backend code files for understanding how the application works.\n\n")

    for file_path in code_files:
        full_path = BASE_DIR / file_path
        if full_path.exists():
            combined_code.append(f"\n{'='*80}\n")
            combined_code.append(f"# FILE: {file_path}\n")
            combined_code.append(f"{'='*80}\n\n")
            try:
                content = full_path.read_text(encoding='utf-8')
                combined_code.append(content)
                combined_code.append("\n\n")
            except Exception as e:
                combined_code.append(f"# Error reading file: {e}\n\n")

    return "".join(combined_code)


@router.get("/frontend", response_class=PlainTextResponse)
async def get_frontend_code():
    """Get key frontend code files."""
    code_files = [
        "static/js/chat.js",
        "static/js/conversations.js",
        "static/js/projects.js",
        "static/js/settings.js",
        "static/js/workspace.js",
        "static/js/files.js"
    ]

    combined_code = []
    combined_code.append("# FRONTEND CODE REFERENCE\n")
    combined_code.append("# This document contains key frontend code files.\n\n")

    for file_path in code_files:
        full_path = BASE_DIR / file_path
        if full_path.exists():
            combined_code.append(f"\n{'='*80}\n")
            combined_code.append(f"# FILE: {file_path}\n")
            combined_code.append(f"{'='*80}\n\n")
            try:
                content = full_path.read_text(encoding='utf-8')
                # Limit frontend files to first 500 lines each to avoid huge context
                lines = content.split('\n')
                if len(lines) > 500:
                    content = '\n'.join(lines[:500]) + f"\n\n# ... (truncated, {len(lines) - 500} more lines) ..."
                combined_code.append(content)
                combined_code.append("\n\n")
            except Exception as e:
                combined_code.append(f"# Error reading file: {e}\n\n")

    return "".join(combined_code)

```

---

### `api/files.py`

**Purpose:** API endpoints for file operations (upload, browse, etc.)

```python
"""File upload handling endpoints."""

import os
from pathlib import Path
from typing import List, Optional
from fastapi import APIRouter, UploadFile, File, HTTPException, Query
from pydantic import BaseModel

from services.file_processor import FileProcessor

router = APIRouter(prefix="/api/files", tags=["files"])

processor = FileProcessor()

# Base directory for server file browser (user's home)
BASE_DIR = Path.home()


class ServerFileRequest(BaseModel):
    """Request to read a file from the server."""
    path: str


@router.get("/browse")
async def browse_directory(path: Optional[str] = Query(default=None)):
    """
    Browse files on the server filesystem.
    Returns list of files and directories.
    """
    try:
        if path:
            dir_path = Path(path).resolve()
        else:
            dir_path = BASE_DIR

        # Security: ensure we're not going outside allowed areas
        # Allow access to home directory and subdirectories
        if not str(dir_path).startswith(str(BASE_DIR)):
            dir_path = BASE_DIR

        if not dir_path.exists():
            raise HTTPException(status_code=404, detail="Directory not found")

        if not dir_path.is_dir():
            raise HTTPException(status_code=400, detail="Path is not a directory")

        items = []
        try:
            for item in sorted(dir_path.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower())):
                # Skip hidden files and common unneeded directories
                if item.name.startswith('.'):
                    continue

                try:
                    stat = item.stat()
                    items.append({
                        "name": item.name,
                        "path": str(item),
                        "is_dir": item.is_dir(),
                        "size": stat.st_size if item.is_file() else None,
                        "extension": item.suffix.lower() if item.is_file() else None
                    })
                except (PermissionError, OSError):
                    continue
        except PermissionError:
            raise HTTPException(status_code=403, detail="Permission denied")

        return {
            "current_path": str(dir_path),
            "parent_path": str(dir_path.parent) if dir_path != BASE_DIR else None,
            "items": items
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/read-server-file")
async def read_server_file(request: ServerFileRequest):
    """
    Read a file from the server filesystem and return it processed for the API.
    """
    try:
        file_path = Path(request.path).resolve()

        # Security check
        if not str(file_path).startswith(str(BASE_DIR)):
            raise HTTPException(status_code=403, detail="Access denied")

        if not file_path.exists():
            raise HTTPException(status_code=404, detail="File not found")

        if not file_path.is_file():
            raise HTTPException(status_code=400, detail="Path is not a file")

        # Read file content
        content = file_path.read_bytes()

        # Process file
        content_block = processor.process_file(
            filename=file_path.name,
            content=content,
            content_type=None
        )

        preview = processor.create_preview(
            filename=file_path.name,
            content=content,
            content_type=None
        )

        return {
            "content_block": content_block,
            "preview": preview
        }

    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/upload")
async def upload_file(file: UploadFile = File(...)):
    """
    Upload a file and get its processed content block for the API.

    Returns the content block in Anthropic API format.
    """
    content = await file.read()

    try:
        content_block = processor.process_file(
            filename=file.filename or "unknown",
            content=content,
            content_type=file.content_type
        )

        preview = processor.create_preview(
            filename=file.filename or "unknown",
            content=content,
            content_type=file.content_type
        )

        return {
            "content_block": content_block,
            "preview": preview
        }

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/upload-multiple")
async def upload_multiple_files(files: List[UploadFile] = File(...)):
    """
    Upload multiple files at once.

    Returns a list of content blocks.
    """
    results = []
    errors = []

    for file in files:
        content = await file.read()

        try:
            content_block = processor.process_file(
                filename=file.filename or "unknown",
                content=content,
                content_type=file.content_type
            )

            preview = processor.create_preview(
                filename=file.filename or "unknown",
                content=content,
                content_type=file.content_type
            )

            results.append({
                "filename": file.filename,
                "content_block": content_block,
                "preview": preview
            })

        except ValueError as e:
            errors.append({
                "filename": file.filename,
                "error": str(e)
            })

    return {
        "results": results,
        "errors": errors
    }

```

---

### `api/projects.py`

**Purpose:** API endpoints for project management

```python
"""API routes for project management."""

from typing import Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from services.project_store import ProjectStore

router = APIRouter(prefix="/api/projects", tags=["projects"])

# Initialize store
store = ProjectStore()


class CreateProjectRequest(BaseModel):
    name: str
    color: Optional[str] = "#C15F3C"
    settings: Optional[dict] = None


class UpdateProjectRequest(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None
    settings: Optional[dict] = None


class AddConversationRequest(BaseModel):
    conversation_id: str


@router.get("")
async def list_projects():
    """List all projects."""
    await store.initialize()
    projects = await store.list_projects()
    return {"projects": projects}


@router.get("/conversation-map")
async def get_conversation_project_map():
    """Get mapping of conversation_id -> project_id."""
    await store.initialize()
    conv_map = await store.get_conversation_project_map()
    return {"map": conv_map}


@router.get("/{project_id}")
async def get_project(project_id: str):
    """Get a single project by ID."""
    await store.initialize()
    project = await store.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


@router.post("")
async def create_project(request: CreateProjectRequest):
    """Create a new project."""
    await store.initialize()
    project = await store.create_project(
        name=request.name,
        color=request.color,
        settings=request.settings
    )
    return project


@router.put("/{project_id}")
async def update_project(project_id: str, request: UpdateProjectRequest):
    """Update a project's metadata."""
    await store.initialize()
    success = await store.update_project(
        project_id=project_id,
        name=request.name,
        color=request.color,
        settings=request.settings
    )
    if not success:
        raise HTTPException(status_code=404, detail="Project not found")
    return {"success": True}


@router.delete("/{project_id}")
async def delete_project(project_id: str):
    """Delete a project (keeps conversations)."""
    await store.initialize()
    success = await store.delete_project(project_id)
    if not success:
        raise HTTPException(status_code=404, detail="Project not found")
    return {"success": True}


@router.post("/{project_id}/conversations")
async def add_conversation_to_project(project_id: str, request: AddConversationRequest):
    """Add a conversation to a project."""
    await store.initialize()
    success = await store.add_conversation(project_id, request.conversation_id)
    if not success:
        raise HTTPException(status_code=404, detail="Project not found")
    return {"success": True}


@router.delete("/{project_id}/conversations/{conversation_id}")
async def remove_conversation_from_project(project_id: str, conversation_id: str):
    """Remove a conversation from a project."""
    await store.initialize()
    success = await store.remove_conversation(project_id, conversation_id)
    if not success:
        raise HTTPException(status_code=404, detail="Project or conversation not found")
    return {"success": True}


@router.get("/{project_id}/memory")
async def get_project_memory(project_id: str):
    """Get memory files for a project."""
    import os
    await store.initialize()

    project = await store.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    memory_path = store.get_project_memory_path(project_id)

    if not os.path.exists(memory_path):
        return {
            "files": [],
            "memory_path": memory_path,
            "project_id": project_id
        }

    files = []
    for item in os.listdir(memory_path):
        item_path = os.path.join(memory_path, item)
        if not item.startswith('.'):
            files.append({
                "name": item,
                "is_dir": os.path.isdir(item_path),
                "size": os.path.getsize(item_path) if os.path.isfile(item_path) else None
            })

    return {
        "files": files,
        "memory_path": memory_path,
        "project_id": project_id
    }

```

---

### `api/settings.py`

**Purpose:** API endpoints for application settings

```python
"""Default and project settings management endpoints."""

import json
from pathlib import Path
from typing import Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/api/settings", tags=["settings"])

# Path to settings files
DEFAULT_SETTINGS_PATH = Path("data/default_settings.json")
PROJECT_SETTINGS_PATH = Path("data/project_settings.json")


class DefaultSettings(BaseModel):
    """Default settings for new conversations."""
    # Normal chat defaults
    normal_model: Optional[str] = "claude-opus-4-5-20251101"
    normal_system_prompt: Optional[str] = None
    normal_thinking_enabled: Optional[bool] = True
    normal_thinking_budget: Optional[int] = 60000
    normal_max_tokens: Optional[int] = 64000
    normal_temperature: Optional[float] = 1.0
    normal_top_p: Optional[float] = 1.0
    normal_top_k: Optional[int] = 0
    normal_prune_threshold: Optional[float] = 0.7
    normal_web_search_enabled: Optional[bool] = False
    normal_web_search_max_uses: Optional[int] = 5

    # Agent chat defaults
    agent_model: Optional[str] = "claude-opus-4-5-20251101"
    agent_system_prompt: Optional[str] = None
    agent_tools: Optional[dict] = None  # e.g., {"Read": True, "Write": True, ...}
    agent_cwd: Optional[str] = None  # Custom working directory for agent
    agent_thinking_budget: Optional[int] = 32000  # Thinking budget for agent extended thinking


def load_default_settings() -> dict:
    """Load default settings from file."""
    if DEFAULT_SETTINGS_PATH.exists():
        try:
            with open(DEFAULT_SETTINGS_PATH, 'r') as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError):
            pass

    # Return defaults if file doesn't exist or is invalid
    return DefaultSettings().model_dump()


def save_default_settings(settings: dict) -> bool:
    """Save default settings to file."""
    try:
        # Ensure data directory exists
        DEFAULT_SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)

        with open(DEFAULT_SETTINGS_PATH, 'w') as f:
            json.dump(settings, f, indent=2)
        return True
    except IOError:
        return False


@router.get("/defaults")
async def get_defaults():
    """Get default settings for new conversations."""
    return load_default_settings()


@router.put("/defaults")
async def update_defaults(settings: DefaultSettings):
    """Update default settings."""
    # Merge with existing settings (only update provided values)
    current = load_default_settings()
    update_data = {k: v for k, v in settings.model_dump().items() if v is not None}
    current.update(update_data)

    if save_default_settings(current):
        return {"success": True, "settings": current}
    return {"success": False, "error": "Failed to save settings"}


# ==================== Project Settings ====================

def load_all_project_settings() -> dict:
    """Load all project settings from file."""
    if PROJECT_SETTINGS_PATH.exists():
        try:
            with open(PROJECT_SETTINGS_PATH, 'r') as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError):
            pass
    return {}


def save_all_project_settings(all_settings: dict) -> bool:
    """Save all project settings to file."""
    try:
        PROJECT_SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(PROJECT_SETTINGS_PATH, 'w') as f:
            json.dump(all_settings, f, indent=2)
        return True
    except IOError:
        return False


def get_project_settings(project_id: str) -> dict:
    """Get settings for a specific project."""
    all_settings = load_all_project_settings()
    return all_settings.get(project_id, {})


def save_project_settings(project_id: str, settings: dict) -> bool:
    """Save settings for a specific project."""
    all_settings = load_all_project_settings()
    all_settings[project_id] = settings
    return save_all_project_settings(all_settings)


class ProjectSettings(BaseModel):
    """Settings for a project."""
    # Normal chat defaults
    normal_model: Optional[str] = None
    normal_system_prompt: Optional[str] = None
    normal_thinking_enabled: Optional[bool] = None
    normal_thinking_budget: Optional[int] = None
    normal_max_tokens: Optional[int] = None
    normal_temperature: Optional[float] = None
    normal_top_p: Optional[float] = None
    normal_top_k: Optional[int] = None
    normal_prune_threshold: Optional[float] = None
    normal_web_search_enabled: Optional[bool] = None
    normal_web_search_max_uses: Optional[int] = None

    # Agent chat defaults
    agent_model: Optional[str] = None
    agent_system_prompt: Optional[str] = None
    agent_tools: Optional[dict] = None  # e.g., {"Read": True, "Write": True, ...}
    agent_cwd: Optional[str] = None  # Custom working directory for agent


@router.get("/project/{project_id}")
async def get_project_settings_endpoint(project_id: str):
    """Get settings for a project."""
    settings = get_project_settings(project_id)
    return {"project_id": project_id, "settings": settings}


@router.put("/project/{project_id}")
async def update_project_settings(project_id: str, settings: ProjectSettings):
    """Update settings for a project."""
    # Get existing settings and merge
    current = get_project_settings(project_id)
    update_data = {k: v for k, v in settings.model_dump().items() if v is not None}
    current.update(update_data)

    if save_project_settings(project_id, current):
        return {"success": True, "project_id": project_id, "settings": current}
    raise HTTPException(status_code=500, detail="Failed to save project settings")


@router.post("/project/{project_id}/init")
async def init_project_settings(project_id: str):
    """Initialize project settings from current default settings."""
    # Copy current defaults to the project
    defaults = load_default_settings()

    if save_project_settings(project_id, defaults):
        return {"success": True, "project_id": project_id, "settings": defaults}
    raise HTTPException(status_code=500, detail="Failed to initialize project settings")


@router.delete("/project/{project_id}")
async def delete_project_settings(project_id: str):
    """Delete settings for a project."""
    all_settings = load_all_project_settings()
    if project_id in all_settings:
        del all_settings[project_id]
        save_all_project_settings(all_settings)
    return {"success": True}

```

---

## Services

### `services/__init__.py`

**Purpose:** Services module initialization

```python
"""Services module for Claude Chat UI."""

from .anthropic_client import AnthropicClient
from .conversation_store import ConversationStore
from .file_processor import FileProcessor

__all__ = ["AnthropicClient", "ConversationStore", "FileProcessor"]

```

---

### `services/agent_client.py`

**Purpose:** Client wrapper for Claude Agent SDK interactions

```python
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

```

---

### `services/anthropic_client.py`

**Purpose:** Client wrapper for direct Anthropic API calls

```python
"""Anthropic API client wrapper with streaming support."""

import os
from typing import AsyncGenerator, Optional, List, Dict, Any
import anthropic
from dotenv import load_dotenv

from config import MODELS, DEFAULT_MODEL, DEFAULT_TEMPERATURE, DEFAULT_MAX_TOKENS

load_dotenv()


class AnthropicClient:
    """Wrapper for Anthropic API with streaming support."""

    def __init__(self):
        api_key = os.getenv("ANTHROPIC_API_KEY")
        if not api_key:
            raise ValueError("ANTHROPIC_API_KEY environment variable is required")
        # Use AsyncAnthropic for true async streaming
        self.client = anthropic.AsyncAnthropic(api_key=api_key)
        self._warmed_up = False

    async def warmup(self):
        """Warm up the API connection to avoid cold start latency."""
        if self._warmed_up:
            return
        try:
            # Use count_tokens as a lightweight warmup call
            await self.client.messages.count_tokens(
                model=DEFAULT_MODEL,
                messages=[{"role": "user", "content": "hi"}]
            )
            self._warmed_up = True
        except Exception as e:
            # Warmup failure is not critical
            print(f"API warmup failed (non-critical): {e}")

    async def stream_message(
        self,
        messages: List[Dict[str, Any]],
        model: str = DEFAULT_MODEL,
        system_prompt: Optional[str] = None,
        temperature: float = DEFAULT_TEMPERATURE,
        max_tokens: int = DEFAULT_MAX_TOKENS,
        top_p: Optional[float] = None,
        top_k: Optional[int] = None,
        thinking_enabled: bool = False,
        thinking_budget: int = 10000,
        web_search_enabled: bool = False,
        web_search_max_uses: int = 5,
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """
        Stream a message from the Anthropic API.

        Yields events with types: 'thinking', 'text', 'error', 'done', 'web_search_start', 'web_search_result'
        """
        model_config = MODELS.get(model)
        if not model_config:
            yield {"type": "error", "content": f"Unknown model: {model}"}
            return

        # Build request parameters
        params: Dict[str, Any] = {
            "model": model,
            "max_tokens": min(max_tokens, model_config.max_tokens),
            "messages": messages,
        }

        # Add optional parameters
        if system_prompt:
            params["system"] = system_prompt

        # Temperature is not allowed when thinking is enabled
        if not thinking_enabled:
            params["temperature"] = temperature
            if top_p is not None and top_p < 1.0:
                params["top_p"] = top_p
            if top_k is not None and top_k > 0:
                params["top_k"] = top_k

        # Add thinking configuration for supported models
        if thinking_enabled and model_config.supports_thinking:
            params["thinking"] = {
                "type": "enabled",
                "budget_tokens": thinking_budget
            }

        # Add web search tool if enabled
        if web_search_enabled:
            params["tools"] = [{
                "type": "web_search_20250305",
                "name": "web_search",
                "max_uses": web_search_max_uses
            }]

        try:
            async with self.client.messages.stream(**params) as stream:
                current_tool_use_id = None
                async for event in stream:
                    # Handle different event types from the streaming API
                    if hasattr(event, 'type'):
                        if event.type == 'content_block_start':
                            if hasattr(event, 'content_block'):
                                block = event.content_block
                                block_type = getattr(block, 'type', None)

                                # Check if this is a server tool use (web search starting)
                                if block_type == 'server_tool_use':
                                    current_tool_use_id = getattr(block, 'id', None)
                                    tool_name = getattr(block, 'name', 'web_search')
                                    yield {
                                        "type": "web_search_start",
                                        "id": current_tool_use_id,
                                        "name": tool_name
                                    }

                                # Check if this is web search results
                                elif block_type == 'web_search_tool_result':
                                    search_results = getattr(block, 'content', [])
                                    # Convert results to serializable format
                                    results_list = []
                                    for result in search_results:
                                        if hasattr(result, 'type'):
                                            results_list.append({
                                                "type": result.type,
                                                "url": getattr(result, 'url', ''),
                                                "title": getattr(result, 'title', ''),
                                                "snippet": getattr(result, 'encrypted_content', '')[:200] if hasattr(result, 'encrypted_content') else '',
                                                "page_age": getattr(result, 'page_age', '')
                                            })
                                    yield {
                                        "type": "web_search_result",
                                        "tool_use_id": getattr(block, 'tool_use_id', current_tool_use_id),
                                        "results": results_list
                                    }

                        elif event.type == 'content_block_delta':
                            if hasattr(event, 'delta'):
                                delta = event.delta
                                delta_type = getattr(delta, 'type', None)

                                if delta_type == 'thinking_delta' and hasattr(delta, 'thinking'):
                                    yield {"type": "thinking", "content": delta.thinking}
                                elif delta_type == 'text_delta' and hasattr(delta, 'text'):
                                    yield {"type": "text", "content": delta.text}
                                elif delta_type == 'input_json_delta':
                                    # This is the search query being streamed
                                    partial_json = getattr(delta, 'partial_json', '')
                                    if partial_json and current_tool_use_id:
                                        yield {
                                            "type": "web_search_query",
                                            "id": current_tool_use_id,
                                            "partial_query": partial_json
                                        }

                        elif event.type == 'message_stop':
                            yield {"type": "done", "content": ""}

        except anthropic.APIError as e:
            yield {"type": "error", "content": f"API Error: {str(e)}"}
        except Exception as e:
            yield {"type": "error", "content": f"Error: {str(e)}"}

    def get_available_models(self) -> List[Dict[str, Any]]:
        """Return list of available models with their configurations."""
        return [
            {
                "id": model.id,
                "name": model.name,
                "supports_thinking": model.supports_thinking,
                "max_tokens": model.max_tokens,
                "description": model.description
            }
            for model in MODELS.values()
        ]

```

---

### `services/conversation_store.py`

**Purpose:** Abstract interface for conversation storage

```python
"""SQLite-based conversation persistence with branching support."""

import json
import uuid
from datetime import datetime
from pathlib import Path
from typing import List, Dict, Any, Optional
import aiosqlite

from config import DATABASE_PATH


class ConversationStore:
    """SQLite-based storage for conversations with message branching."""

    def __init__(self, db_path: str = DATABASE_PATH):
        self.db_path = db_path
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)

    async def initialize(self):
        """Initialize the database schema."""
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute("""
                CREATE TABLE IF NOT EXISTS conversations (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    model TEXT,
                    system_prompt TEXT,
                    active_versions TEXT DEFAULT '{}'
                )
            """)

            # Check if we need to migrate the messages table
            cursor = await db.execute("PRAGMA table_info(messages)")
            columns = [row[1] for row in await cursor.fetchall()]

            if 'position' not in columns:
                # New schema - create fresh or migrate
                await db.execute("""
                    CREATE TABLE IF NOT EXISTS messages_new (
                        id TEXT PRIMARY KEY,
                        conversation_id TEXT NOT NULL,
                        role TEXT NOT NULL,
                        content TEXT NOT NULL,
                        thinking TEXT,
                        position INTEGER NOT NULL,
                        version INTEGER NOT NULL DEFAULT 1,
                        parent_message_id TEXT,
                        created_at TEXT NOT NULL,
                        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
                        FOREIGN KEY (parent_message_id) REFERENCES messages(id) ON DELETE SET NULL
                    )
                """)

                # Check if old messages table exists and has data
                cursor = await db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'")
                if await cursor.fetchone():
                    # Migrate existing messages
                    cursor = await db.execute("SELECT * FROM messages ORDER BY conversation_id, created_at")
                    rows = await cursor.fetchall()

                    # Group by conversation and assign positions
                    conv_positions = {}
                    for row in rows:
                        msg_id, conv_id, role, content, thinking, created_at = row
                        if conv_id not in conv_positions:
                            conv_positions[conv_id] = 0
                        pos = conv_positions[conv_id]
                        conv_positions[conv_id] += 1

                        await db.execute(
                            """INSERT INTO messages_new (id, conversation_id, role, content, thinking, position, version, parent_message_id, created_at)
                               VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?)""",
                            (msg_id, conv_id, role, content, thinking, pos, created_at)
                        )

                    await db.execute("DROP TABLE messages")

                await db.execute("ALTER TABLE messages_new RENAME TO messages")

            # Add parent_message_id column if missing (for existing databases)
            if 'parent_message_id' not in columns and 'position' in columns:
                await db.execute("ALTER TABLE messages ADD COLUMN parent_message_id TEXT")

            await db.execute("""
                CREATE INDEX IF NOT EXISTS idx_messages_conversation
                ON messages(conversation_id, position, version)
            """)

            await db.execute("""
                CREATE INDEX IF NOT EXISTS idx_messages_parent
                ON messages(parent_message_id)
            """)

            # Add active_versions column if missing
            cursor = await db.execute("PRAGMA table_info(conversations)")
            conv_columns = [row[1] for row in await cursor.fetchall()]
            if 'active_versions' not in conv_columns:
                await db.execute("ALTER TABLE conversations ADD COLUMN active_versions TEXT DEFAULT '{}'")

            await db.commit()

    async def create_conversation(
        self,
        title: str = "New Conversation",
        model: Optional[str] = None,
        system_prompt: Optional[str] = None,
        is_agent: bool = False
    ) -> Dict[str, Any]:
        """Create a new conversation.

        Args:
            is_agent: Whether this is an agent conversation (ignored for SQLite store, kept for compatibility)
        """
        conversation_id = str(uuid.uuid4())
        now = datetime.utcnow().isoformat()

        async with aiosqlite.connect(self.db_path) as db:
            await db.execute(
                """INSERT INTO conversations (id, title, created_at, updated_at, model, system_prompt, active_versions)
                   VALUES (?, ?, ?, ?, ?, ?, '{}')""",
                (conversation_id, title, now, now, model, system_prompt)
            )
            await db.commit()

        return {
            "id": conversation_id,
            "title": title,
            "created_at": now,
            "updated_at": now,
            "model": model,
            "system_prompt": system_prompt,
            "messages": []
        }

    async def get_conversation(self, conversation_id: str, branch: Optional[List[int]] = None) -> Optional[Dict[str, Any]]:
        """Get a conversation with active messages following the branch chain.

        Args:
            conversation_id: ID of the conversation
            branch: Optional branch array (ignored for SQLite store, kept for compatibility with FileConversationStore)

        Messages are selected based on:
        1. At position 0: use active_versions to select which user message version
        2. At subsequent positions: select messages whose parent matches the previous selected message
        3. If multiple messages have the same parent (retries), use active_versions to pick
        """
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row

            cursor = await db.execute(
                "SELECT * FROM conversations WHERE id = ?",
                (conversation_id,)
            )
            row = await cursor.fetchone()
            if not row:
                return None

            conversation = dict(row)
            active_versions = json.loads(conversation.get('active_versions') or '{}')

            # Get all messages for this conversation
            cursor = await db.execute(
                """SELECT * FROM messages WHERE conversation_id = ?
                   ORDER BY position, version""",
                (conversation_id,)
            )
            all_messages = [dict(row) async for row in cursor]

            print(f"[GET_CONV SQLite] Found {len(all_messages)} messages for {conversation_id}")
            for msg in all_messages:
                print(f"  - Position {msg['position']}, Role {msg['role']}, Version {msg['version']}, Content length: {len(msg['content'])}")

            if not all_messages:
                conversation["messages"] = []
                return conversation

            # Group messages by position for version counting
            messages_by_position = {}
            for msg in all_messages:
                pos = msg['position']
                if pos not in messages_by_position:
                    messages_by_position[pos] = []
                messages_by_position[pos].append(msg)

            # Build the active message chain following parent links
            messages = []
            current_parent_id = None
            previous_selected_version = None
            max_position = max(messages_by_position.keys())

            for pos in range(max_position + 1):
                if pos not in messages_by_position:
                    continue

                candidates = messages_by_position[pos]

                # Filter candidates by parent_message_id
                if pos == 0:
                    # First message has no parent - select by active_versions
                    matching = candidates
                else:
                    # Find messages whose parent is the previously selected message
                    matching = [m for m in candidates if m.get('parent_message_id') == current_parent_id]

                    # Fallback for legacy data (no parent_message_id set)
                    if not matching:
                        # Try to match by version number - assumes versions correspond
                        # (user v2 should pair with assistant v2 if they were created together)
                        if previous_selected_version:
                            version_match = [m for m in candidates if m['version'] == previous_selected_version]
                            if version_match:
                                matching = version_match

                    # Final fallback: use all candidates
                    if not matching:
                        matching = candidates

                if not matching:
                    continue

                # If multiple matching (retries with same parent), use active_versions
                active_ver = active_versions.get(str(pos))
                selected = None

                if active_ver:
                    # Try to find the specifically requested version
                    for m in matching:
                        if m['version'] == active_ver:
                            selected = m
                            break

                if not selected:
                    # Default to the latest matching version
                    selected = max(matching, key=lambda m: m['version'])

                # Parse content
                try:
                    selected["content"] = json.loads(selected["content"])
                except (json.JSONDecodeError, TypeError):
                    pass

                # Add version info for UI
                # For proper branching, count only versions that share the same parent
                versions_with_same_parent = [m for m in candidates if m.get('parent_message_id') == selected.get('parent_message_id')]
                selected["total_versions"] = len(versions_with_same_parent) if versions_with_same_parent else len(candidates)
                selected["current_version"] = selected['version']

                messages.append(selected)
                current_parent_id = selected['id']
                previous_selected_version = selected['version']

            print(f"[GET_CONV SQLite] Returning {len(messages)} messages after filtering")
            for msg in messages:
                print(f"  - Position {msg['position']}, Role {msg['role']}, Content length: {len(str(msg['content']))}")

            conversation["messages"] = messages
            return conversation

    async def list_conversations(self) -> List[Dict[str, Any]]:
        """List all conversations (without messages)."""
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute(
                "SELECT id, title, created_at, updated_at, model FROM conversations ORDER BY updated_at DESC"
            )
            return [dict(row) async for row in cursor]

    async def update_conversation(
        self,
        conversation_id: str,
        title: Optional[str] = None,
        model: Optional[str] = None,
        system_prompt: Optional[str] = None
    ) -> bool:
        """Update conversation metadata."""
        updates = []
        params = []

        if title is not None:
            updates.append("title = ?")
            params.append(title)
        if model is not None:
            updates.append("model = ?")
            params.append(model)
        if system_prompt is not None:
            updates.append("system_prompt = ?")
            params.append(system_prompt)

        if not updates:
            return False

        updates.append("updated_at = ?")
        params.append(datetime.utcnow().isoformat())
        params.append(conversation_id)

        async with aiosqlite.connect(self.db_path) as db:
            await db.execute(
                f"UPDATE conversations SET {', '.join(updates)} WHERE id = ?",
                params
            )
            await db.commit()
            return db.total_changes > 0

    async def delete_conversation(self, conversation_id: str) -> bool:
        """Delete a conversation and all its messages."""
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute(
                "DELETE FROM messages WHERE conversation_id = ?",
                (conversation_id,)
            )
            await db.execute(
                "DELETE FROM conversations WHERE id = ?",
                (conversation_id,)
            )
            await db.commit()
            return db.total_changes > 0

    async def add_message(
        self,
        conversation_id: str,
        role: str,
        content: Any,
        thinking: Optional[str] = None,
        streaming: bool = False,
        parent_message_id: Optional[str] = None,
        branch: Optional[List[int]] = None,
        tool_results: Optional[List[Dict]] = None
    ) -> Dict[str, Any]:
        """Add a message to a conversation.

        Args:
            parent_message_id: ID of the message this is responding to.
                - For user messages: parent is the previous assistant message (or None for first)
                - For assistant messages: parent is the user message being responded to
            branch: Optional branch array (ignored for SQLite store, kept for compatibility)
            tool_results: Optional tool results (ignored for SQLite store, kept for compatibility)
        """
        message_id = str(uuid.uuid4())
        now = datetime.utcnow().isoformat()
        content_str = json.dumps(content) if not isinstance(content, str) else content

        async with aiosqlite.connect(self.db_path) as db:
            # Get next position
            cursor = await db.execute(
                "SELECT MAX(position) FROM messages WHERE conversation_id = ?",
                (conversation_id,)
            )
            row = await cursor.fetchone()
            # Note: can't use `row[0] or -1` because 0 is falsy in Python
            position = 0 if row[0] is None else row[0] + 1

            print(f"[ADD_MESSAGE SQLite] Adding {role} message at position {position}, parent: {parent_message_id}, content length: {len(content_str)}")
            await db.execute(
                """INSERT INTO messages (id, conversation_id, role, content, thinking, position, version, parent_message_id, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)""",
                (message_id, conversation_id, role, content_str, thinking, position, parent_message_id, now)
            )
            await db.execute(
                "UPDATE conversations SET updated_at = ? WHERE id = ?",
                (now, conversation_id)
            )
            await db.commit()
            print(f"[ADD_MESSAGE SQLite] Created message {message_id}")

        return {
            "id": message_id,
            "conversation_id": conversation_id,
            "role": role,
            "content": content,
            "thinking": thinking,
            "position": position,
            "version": 1,
            "total_versions": 1,
            "current_version": 1,
            "parent_message_id": parent_message_id,
            "created_at": now,
            "streaming": streaming
        }

    async def update_message_content(
        self,
        conversation_id: str,
        message_id: str,
        content: str,
        thinking: Optional[str] = None,
        tool_results: Optional[List[Dict]] = None,
        branch: Optional[List[int]] = None,
        streaming: bool = True
    ) -> bool:
        """Update message content (used for streaming updates).

        Args:
            conversation_id: Conversation ID (kept for compatibility with FileConversationStore)
            message_id: Message ID to update
            content: New content
            thinking: Optional thinking content
            tool_results: Optional tool results (ignored for SQLite store)
            branch: Optional branch array (ignored for SQLite store)
            streaming: Whether message is still streaming
        """
        print(f"[UPDATE_MESSAGE SQLite] Updating message {message_id} with content length: {len(content)}")
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute(
                "UPDATE messages SET content = ?, thinking = ? WHERE id = ?",
                (content, thinking, message_id)
            )
            await db.commit()
            updated = db.total_changes > 0
            print(f"[UPDATE_MESSAGE SQLite] Updated: {updated}")
            return updated

    async def get_message_by_id(self, message_id: str) -> Optional[Dict[str, Any]]:
        """Get a single message by ID."""
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute(
                "SELECT * FROM messages WHERE id = ?",
                (message_id,)
            )
            row = await cursor.fetchone()
            if not row:
                return None
            msg = dict(row)
            try:
                msg["content"] = json.loads(msg["content"])
            except (json.JSONDecodeError, TypeError):
                pass
            return msg

    async def edit_message(
        self,
        conversation_id: str,
        position: int,
        new_content: Any
    ) -> Dict[str, Any]:
        """Edit a message at a position, creating a new version (new branch).

        The new version keeps the same parent as the original message.
        """
        message_id = str(uuid.uuid4())
        now = datetime.utcnow().isoformat()
        content_str = json.dumps(new_content) if not isinstance(new_content, str) else new_content

        async with aiosqlite.connect(self.db_path) as db:
            # Get current max version and info at this position
            cursor = await db.execute(
                "SELECT MAX(version), role, parent_message_id FROM messages WHERE conversation_id = ? AND position = ?",
                (conversation_id, position)
            )
            row = await cursor.fetchone()
            new_version = (row[0] or 0) + 1
            role = row[1] or 'user'
            parent_message_id = row[2]  # Keep same parent as original

            # Insert new version with same parent
            await db.execute(
                """INSERT INTO messages (id, conversation_id, role, content, thinking, position, version, parent_message_id, created_at)
                   VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)""",
                (message_id, conversation_id, role, content_str, position, new_version, parent_message_id, now)
            )

            # Update active versions to use this new version
            cursor = await db.execute(
                "SELECT active_versions FROM conversations WHERE id = ?",
                (conversation_id,)
            )
            row = await cursor.fetchone()
            active_versions = json.loads(row[0] or '{}')
            active_versions[str(position)] = new_version

            # Remove active versions for positions after this one (they'll use defaults)
            keys_to_remove = [k for k in active_versions.keys() if int(k) > position]
            for k in keys_to_remove:
                del active_versions[k]

            await db.execute(
                "UPDATE conversations SET active_versions = ?, updated_at = ? WHERE id = ?",
                (json.dumps(active_versions), now, conversation_id)
            )
            await db.commit()

        return {
            "id": message_id,
            "conversation_id": conversation_id,
            "role": role,
            "content": new_content,
            "position": position,
            "version": new_version,
            "parent_message_id": parent_message_id,
            "created_at": now
        }

    async def create_branch(
        self,
        conversation_id: str,
        current_branch: List[int],
        user_msg_index: int,
        new_content: Any
    ) -> Dict[str, Any]:
        """Create a new branch by editing a user message.

        This is an adapter that matches the file store's interface.
        For SQLite, we use position-based versioning instead of branch arrays.
        """
        # User messages are at even positions (0, 2, 4, ...)
        position = user_msg_index * 2

        # Call the existing edit_message method
        message = await self.edit_message(conversation_id, position, new_content)

        # Construct a branch array for compatibility
        # The branch array represents version choices at each user message position
        new_branch = current_branch[:user_msg_index] if user_msg_index < len(current_branch) else current_branch[:]
        new_branch.append(message["version"] - 1)  # Version is 1-based, branch is 0-based

        return {
            "branch": new_branch,
            "message": message
        }

    async def retry_message(
        self,
        conversation_id: str,
        position: int,
        new_content: Any,
        thinking: Optional[str] = None,
        parent_message_id: Optional[str] = None
    ) -> Dict[str, Any]:
        """Create a new version of an assistant message (retry).

        The retry keeps the same parent (the user message it responds to).
        """
        message_id = str(uuid.uuid4())
        now = datetime.utcnow().isoformat()
        content_str = json.dumps(new_content) if not isinstance(new_content, str) else new_content

        async with aiosqlite.connect(self.db_path) as db:
            # Get current max version and parent at this position
            cursor = await db.execute(
                "SELECT MAX(version), parent_message_id FROM messages WHERE conversation_id = ? AND position = ?",
                (conversation_id, position)
            )
            row = await cursor.fetchone()
            new_version = (row[0] or 0) + 1
            # Use provided parent or keep existing parent
            actual_parent = parent_message_id if parent_message_id else row[1]

            # Insert new version with same parent
            await db.execute(
                """INSERT INTO messages (id, conversation_id, role, content, thinking, position, version, parent_message_id, created_at)
                   VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, ?)""",
                (message_id, conversation_id, content_str, thinking, position, new_version, actual_parent, now)
            )

            # Update active versions
            cursor = await db.execute(
                "SELECT active_versions FROM conversations WHERE id = ?",
                (conversation_id,)
            )
            row = await cursor.fetchone()
            active_versions = json.loads(row[0] or '{}')
            active_versions[str(position)] = new_version

            await db.execute(
                "UPDATE conversations SET active_versions = ?, updated_at = ? WHERE id = ?",
                (json.dumps(active_versions), now, conversation_id)
            )
            await db.commit()

        return {
            "id": message_id,
            "conversation_id": conversation_id,
            "role": "assistant",
            "content": new_content,
            "thinking": thinking,
            "position": position,
            "version": new_version,
            "parent_message_id": actual_parent,
            "created_at": now
        }

    async def switch_version(
        self,
        conversation_id: str,
        position: int,
        version: int
    ) -> bool:
        """Switch to a different version at a position.

        When switching a user message version, also clears downstream active_versions
        so that the corresponding assistant responses are shown (defaults to matching version
        or latest available).
        """
        async with aiosqlite.connect(self.db_path) as db:
            # Verify the version exists and get the role
            cursor = await db.execute(
                "SELECT role FROM messages WHERE conversation_id = ? AND position = ? AND version = ?",
                (conversation_id, position, version)
            )
            row = await cursor.fetchone()
            if not row:
                return False

            role = row[0]

            # Update active versions
            cursor = await db.execute(
                "SELECT active_versions FROM conversations WHERE id = ?",
                (conversation_id,)
            )
            row = await cursor.fetchone()
            active_versions = json.loads(row[0] or '{}')
            active_versions[str(position)] = version

            # If switching a user message, clear downstream positions
            # This ensures the corresponding assistant response is shown
            if role == 'user':
                keys_to_remove = [k for k in active_versions.keys() if int(k) > position]
                for k in keys_to_remove:
                    del active_versions[k]

            await db.execute(
                "UPDATE conversations SET active_versions = ? WHERE id = ?",
                (json.dumps(active_versions), conversation_id)
            )
            await db.commit()
            return True

    async def get_messages_up_to(self, conversation_id: str, position: int) -> List[Dict[str, Any]]:
        """Get active messages up to (not including) a position, following the branch chain."""
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row

            cursor = await db.execute(
                "SELECT active_versions FROM conversations WHERE id = ?",
                (conversation_id,)
            )
            row = await cursor.fetchone()
            active_versions = json.loads(row[0] or '{}') if row else {}

            cursor = await db.execute(
                """SELECT * FROM messages WHERE conversation_id = ? AND position < ?
                   ORDER BY position, version""",
                (conversation_id, position)
            )
            all_messages = [dict(row) async for row in cursor]

            if not all_messages:
                return []

            # Group by position
            messages_by_position = {}
            for msg in all_messages:
                pos = msg['position']
                if pos not in messages_by_position:
                    messages_by_position[pos] = []
                messages_by_position[pos].append(msg)

            # Build the active message chain following parent links
            messages = []
            current_parent_id = None
            previous_selected_version = None
            max_pos = max(messages_by_position.keys()) if messages_by_position else -1

            for pos in range(max_pos + 1):
                if pos not in messages_by_position:
                    continue

                candidates = messages_by_position[pos]

                # Filter by parent
                if pos == 0:
                    matching = candidates
                else:
                    matching = [m for m in candidates if m.get('parent_message_id') == current_parent_id]

                    # Fallback for legacy data - try to match by version
                    if not matching and previous_selected_version:
                        version_match = [m for m in candidates if m['version'] == previous_selected_version]
                        if version_match:
                            matching = version_match

                    # Final fallback
                    if not matching:
                        matching = candidates

                if not matching:
                    continue

                # Select based on active_versions
                active_ver = active_versions.get(str(pos))
                selected = None

                if active_ver:
                    for m in matching:
                        if m['version'] == active_ver:
                            selected = m
                            break

                if not selected:
                    selected = max(matching, key=lambda m: m['version'])

                # Parse content
                try:
                    selected["content"] = json.loads(selected["content"])
                except (json.JSONDecodeError, TypeError):
                    pass

                # Add version info
                versions_with_same_parent = [m for m in candidates if m.get('parent_message_id') == selected.get('parent_message_id')]
                selected["total_versions"] = len(versions_with_same_parent) if versions_with_same_parent else len(candidates)

                messages.append(selected)
                current_parent_id = selected['id']
                previous_selected_version = selected['version']

            return messages

    async def get_messages(self, conversation_id: str) -> List[Dict[str, Any]]:
        """Get all active messages for a conversation."""
        conv = await self.get_conversation(conversation_id)
        return conv["messages"] if conv else []

    async def get_position_version_info(self, conversation_id: str, position: int) -> Dict[str, Any]:
        """Get version info for a specific position."""
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row

            # Get all versions at this position
            cursor = await db.execute(
                """SELECT version FROM messages
                   WHERE conversation_id = ? AND position = ?
                   ORDER BY version""",
                (conversation_id, position)
            )
            versions = [row['version'] async for row in cursor]

            if not versions:
                return {"position": position, "total_versions": 0, "versions": []}

            # Get active version
            cursor = await db.execute(
                "SELECT active_versions FROM conversations WHERE id = ?",
                (conversation_id,)
            )
            row = await cursor.fetchone()
            active_versions = json.loads(row[0] or '{}') if row else {}
            current_version = active_versions.get(str(position), max(versions))

            return {
                "position": position,
                "total_versions": len(versions),
                "current_version": current_version,
                "versions": versions
            }

    async def search_conversations(self, query: str) -> List[Dict[str, Any]]:
        """Search conversations by title or message content (partial match always enabled)."""
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row

            # First, search in titles only
            cursor = await db.execute(
                "SELECT id, title, created_at, updated_at, model FROM conversations WHERE title LIKE ? ORDER BY updated_at DESC",
                (f'%{query}%',)
            )
            title_matches = {row['id']: dict(row) async for row in cursor}

            # Then, search in message content
            # Use INNER JOIN to only get conversations that have messages
            cursor = await db.execute(
                """
                SELECT DISTINCT c.id, c.title, c.created_at, c.updated_at, c.model
                FROM conversations c
                INNER JOIN messages m ON c.id = m.conversation_id
                WHERE m.content LIKE ?
                ORDER BY c.updated_at DESC
                """,
                (f'%{query}%',)
            )

            # Merge results, keeping title matches first
            content_matches = [dict(row) async for row in cursor]

            # Add content matches that aren't already in title matches
            results = list(title_matches.values())
            for conv in content_matches:
                if conv['id'] not in title_matches:
                    results.append(conv)

            return results

    async def duplicate_conversation(self, conversation_id: str) -> Optional[Dict[str, Any]]:
        """Duplicate a conversation with all its messages."""
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row

            # Get original conversation
            cursor = await db.execute(
                "SELECT * FROM conversations WHERE id = ?",
                (conversation_id,)
            )
            original = await cursor.fetchone()
            if not original:
                return None

            original_dict = dict(original)

            # Create new conversation with "Copy of" prefix
            new_id = str(uuid.uuid4())
            now = datetime.utcnow().isoformat()
            new_title = f"Copy of {original_dict['title']}"

            await db.execute(
                """INSERT INTO conversations (id, title, created_at, updated_at, model, system_prompt, active_versions)
                   VALUES (?, ?, ?, ?, ?, ?, '{}')""",
                (new_id, new_title, now, now, original_dict.get('model'), original_dict.get('system_prompt'))
            )

            # Copy all messages
            cursor = await db.execute(
                "SELECT * FROM messages WHERE conversation_id = ? ORDER BY position, version",
                (conversation_id,)
            )
            messages = [dict(row) async for row in cursor]

            for msg in messages:
                new_msg_id = str(uuid.uuid4())
                await db.execute(
                    """INSERT INTO messages (id, conversation_id, role, content, thinking, position, version, created_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                    (new_msg_id, new_id, msg['role'], msg['content'], msg.get('thinking'),
                     msg['position'], msg['version'], now)
                )

            await db.commit()

            return {
                "id": new_id,
                "title": new_title,
                "created_at": now,
                "updated_at": now,
                "model": original_dict.get('model'),
                "system_prompt": original_dict.get('system_prompt')
            }

    async def delete_messages_from(
        self,
        conversation_id: str,
        position: int,
        branch: Optional[List[int]] = None
    ) -> bool:
        """Delete messages from a position onwards (inclusive).

        For SQLite store, this deletes all messages with position >= specified position.
        The branch parameter is ignored as SQLite uses a different branching model.
        """
        print(f"[DELETE SQLite] Deleting messages from position {position} in conversation {conversation_id}")

        async with aiosqlite.connect(self.db_path) as db:
            # Check if conversation exists
            cursor = await db.execute(
                "SELECT id FROM conversations WHERE id = ?",
                (conversation_id,)
            )
            if not await cursor.fetchone():
                print(f"[DELETE SQLite] Conversation {conversation_id} not found")
                return False

            # Delete messages at or after position
            await db.execute(
                "DELETE FROM messages WHERE conversation_id = ? AND position >= ?",
                (conversation_id, position)
            )

            # Update conversation timestamp
            now = datetime.utcnow().isoformat()
            await db.execute(
                "UPDATE conversations SET updated_at = ? WHERE id = ?",
                (now, conversation_id)
            )

            await db.commit()
            deleted_count = db.total_changes
            print(f"[DELETE SQLite] Deleted {deleted_count} row(s)")
            return deleted_count > 0

```

---

### `services/file_conversation_store.py`

**Purpose:** File-based implementation of conversation storage

```python
"""File-based conversation storage with branching support.

Each conversation is stored as a folder with:
- metadata.json: Title, model, system_prompt, timestamps
- Branch files (0.json, 1.json, 0_1.json, etc.): Message arrays

Branch naming convention:
- 0.json = Default branch (implicitly 0_0_0_0...)
- 1.json = Branch 1 at user msg 1, then 0s
- 0_1.json = Branch 0 at user msg 1, branch 1 at user msg 2
- Trailing _0s are implicit and omitted
"""

import json
import uuid
import re
import os
from datetime import datetime
from pathlib import Path
from typing import List, Dict, Any, Optional, Tuple


class FileConversationStore:
    """File-based storage for conversations with branch-per-file model."""

    def __init__(self, base_path: str = "data/conversations"):
        self.base_path = Path(base_path)

    async def initialize(self):
        """Initialize the storage directory."""
        self.base_path.mkdir(parents=True, exist_ok=True)

    # =========================================================================
    # Branch Naming Utilities
    # =========================================================================

    def branch_array_to_filename(self, branch: List[int]) -> str:
        """Convert branch array to filename.

        Trailing zeros are omitted:
        [0] -> "0.json"
        [0, 0, 0] -> "0.json"
        [1] -> "1.json"
        [1, 0, 0] -> "1.json"
        [0, 1] -> "0_1.json"
        [0, 1, 0] -> "0_1.json"
        """
        if not branch:
            return "0.json"

        # Strip trailing zeros
        while len(branch) > 1 and branch[-1] == 0:
            branch = branch[:-1]

        return "_".join(str(b) for b in branch) + ".json"

    def filename_to_branch_array(self, filename: str) -> List[int]:
        """Convert filename to branch array.

        "0.json" -> [0]
        "1.json" -> [1]
        "0_1.json" -> [0, 1]
        """
        name = filename.replace(".json", "")
        if not name:
            return [0]
        return [int(x) for x in name.split("_")]

    def extend_branch_array(self, branch: List[int], length: int) -> List[int]:
        """Extend branch array with zeros to specified length."""
        if len(branch) >= length:
            return branch[:length]
        return branch + [0] * (length - len(branch))

    def get_branch_prefix(self, branch: List[int], length: int) -> List[int]:
        """Get prefix of branch array up to length."""
        return self.extend_branch_array(branch, length)[:length]

    # =========================================================================
    # File Operations
    # =========================================================================

    def _get_conversation_path(self, conversation_id: str) -> Path:
        """Get path to conversation folder."""
        return self.base_path / conversation_id

    def _get_metadata_path(self, conversation_id: str) -> Path:
        """Get path to metadata.json."""
        return self._get_conversation_path(conversation_id) / "metadata.json"

    def _get_settings_path(self, conversation_id: str) -> Path:
        """Get path to settings.json."""
        return self._get_conversation_path(conversation_id) / "settings.json"

    def _get_branch_path(self, conversation_id: str, branch: List[int]) -> Path:
        """Get path to a branch file."""
        filename = self.branch_array_to_filename(branch)
        return self._get_conversation_path(conversation_id) / filename

    async def _read_json(self, path: Path) -> Optional[Dict]:
        """Read and parse a JSON file."""
        try:
            with open(path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            return None

    async def _write_json(self, path: Path, data: Dict):
        """Write data to a JSON file."""
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)

    def _list_branch_files(self, conversation_id: str) -> List[str]:
        """List all branch files in a conversation folder."""
        conv_path = self._get_conversation_path(conversation_id)
        if not conv_path.exists():
            return []

        return [f.name for f in conv_path.iterdir()
                if f.is_file() and f.suffix == '.json'
                and f.name not in ('metadata.json', 'settings.json')]

    # =========================================================================
    # Conversation CRUD
    # =========================================================================

    def get_workspace_path(self, conversation_id: str) -> str:
        """Get the workspace path for an agent conversation."""
        return str(self._get_conversation_path(conversation_id) / "workspace")

    async def create_conversation(
        self,
        title: str = "New Conversation",
        model: Optional[str] = None,
        system_prompt: Optional[str] = None,
        is_agent: bool = False,
        settings: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """Create a new conversation."""
        conversation_id = str(uuid.uuid4())
        now = datetime.utcnow().isoformat()

        # Default settings for normal chats (thinking enabled)
        default_settings = {
            "thinking_enabled": True,
            "thinking_budget": 60000,
            "max_tokens": 64000,
            "temperature": 1.0,
            "top_p": 1.0,
            "top_k": 0,
            "prune_threshold": 0.7
        }

        # Merge provided settings with defaults
        conv_settings = {**default_settings, **(settings or {})}
        print(f"[STORE] Creating conversation with settings: {conv_settings}")

        # Create metadata (no settings - stored separately)
        metadata = {
            "id": conversation_id,
            "title": title,
            "model": model,
            "system_prompt": system_prompt,
            "is_agent": is_agent,
            "created_at": now,
            "updated_at": now,
            "current_branch": [0]  # Track current branch for the conversation
        }

        # Create conversation folder
        conv_path = self._get_conversation_path(conversation_id)
        conv_path.mkdir(parents=True, exist_ok=True)

        # Create workspace for agent conversations
        if is_agent:
            workspace_path = conv_path / "workspace"
            workspace_path.mkdir(exist_ok=True)

        # Write metadata
        await self._write_json(self._get_metadata_path(conversation_id), metadata)

        # Write settings to separate file
        await self._write_json(self._get_settings_path(conversation_id), conv_settings)

        # Create default branch file
        await self._write_json(
            self._get_branch_path(conversation_id, [0]),
            {"messages": []}
        )

        return {
            "id": conversation_id,
            "title": title,
            "created_at": now,
            "updated_at": now,
            "model": model,
            "system_prompt": system_prompt,
            "is_agent": is_agent,
            "messages": [],
            "current_branch": [0],
            "settings": conv_settings
        }

    async def list_conversations(self) -> List[Dict[str, Any]]:
        """List all conversations (metadata only)."""
        conversations = []

        if not self.base_path.exists():
            return conversations

        for conv_dir in self.base_path.iterdir():
            if conv_dir.is_dir():
                metadata = await self._read_json(conv_dir / "metadata.json")
                if metadata:
                    conversations.append({
                        "id": metadata["id"],
                        "title": metadata["title"],
                        "created_at": metadata["created_at"],
                        "updated_at": metadata["updated_at"],
                        "model": metadata.get("model"),
                        "is_agent": metadata.get("is_agent", False)
                    })

        # Sort by updated_at descending
        conversations.sort(key=lambda x: x["updated_at"], reverse=True)
        return conversations

    async def get_conversation(
        self,
        conversation_id: str,
        branch: Optional[List[int]] = None
    ) -> Optional[Dict[str, Any]]:
        """Get a conversation with messages from specified branch.

        If branch is None, uses the current_branch from metadata.
        """
        metadata = await self._read_json(self._get_metadata_path(conversation_id))
        if not metadata:
            return None

        # Use provided branch or default to current_branch
        if branch is None:
            branch = metadata.get("current_branch", [0])

        # Read branch file
        branch_data = await self._read_json(self._get_branch_path(conversation_id, branch))
        messages = branch_data.get("messages", []) if branch_data else []

        # Add version info to messages
        messages_with_versions = await self._add_version_info(conversation_id, branch, messages)

        # Read settings from separate file (with defaults for backwards compatibility)
        default_settings = {
            "thinking_enabled": True,
            "thinking_budget": 60000,
            "max_tokens": 64000,
            "temperature": 1.0,
            "top_p": 1.0,
            "top_k": 0,
            "prune_threshold": 0.7
        }
        saved_settings = await self._read_json(self._get_settings_path(conversation_id)) or {}
        conv_settings = {**default_settings, **saved_settings}

        return {
            "id": metadata["id"],
            "title": metadata["title"],
            "created_at": metadata["created_at"],
            "updated_at": metadata["updated_at"],
            "model": metadata.get("model"),
            "system_prompt": metadata.get("system_prompt"),
            "is_agent": metadata.get("is_agent", False),
            "session_id": metadata.get("session_id"),  # For agent conversation resumption
            "messages": messages_with_versions,
            "current_branch": branch,
            "settings": conv_settings
        }

    async def _add_version_info(
        self,
        conversation_id: str,
        branch: List[int],
        messages: List[Dict]
    ) -> List[Dict]:
        """Add version navigation info to messages.

        For each user message, calculate:
        - current_version: which branch number at this position
        - total_versions: how many branches exist at this position (with same prefix)
        """
        result = []
        user_msg_index = 0  # Tracks which user message position we're at

        for i, msg in enumerate(messages):
            msg_copy = dict(msg)
            msg_copy["position"] = i

            # Preserve tool_results if present (for agent messages)
            if "tool_results" in msg:
                msg_copy["tool_results"] = msg["tool_results"]

            if msg["role"] == "user":
                # Get version info for this user message position
                version_info = await self.get_version_info(conversation_id, branch, user_msg_index)
                msg_copy["current_version"] = version_info["current_version"]
                msg_copy["total_versions"] = version_info["total_versions"]
                msg_copy["user_msg_index"] = user_msg_index
                user_msg_index += 1
            else:
                # Assistant messages inherit version info from preceding user message
                # They don't have their own version nav in this model
                msg_copy["current_version"] = 1
                msg_copy["total_versions"] = 1

            result.append(msg_copy)

        return result

    async def update_conversation(
        self,
        conversation_id: str,
        title: Optional[str] = None,
        model: Optional[str] = None,
        system_prompt: Optional[str] = None,
        settings: Optional[Dict[str, Any]] = None
    ) -> bool:
        """Update conversation metadata."""
        metadata_path = self._get_metadata_path(conversation_id)
        metadata = await self._read_json(metadata_path)
        if not metadata:
            return False

        if title is not None:
            metadata["title"] = title
        if model is not None:
            metadata["model"] = model
        if system_prompt is not None:
            metadata["system_prompt"] = system_prompt

        metadata["updated_at"] = datetime.utcnow().isoformat()
        await self._write_json(metadata_path, metadata)

        # Save settings to separate file if provided
        if settings is not None:
            settings_path = self._get_settings_path(conversation_id)
            existing_settings = await self._read_json(settings_path) or {}
            merged_settings = {**existing_settings, **settings}
            await self._write_json(settings_path, merged_settings)

        return True

    async def update_conversation_settings(
        self,
        conversation_id: str,
        settings: Dict[str, Any]
    ) -> bool:
        """Update just the settings for a conversation."""
        settings_path = self._get_settings_path(conversation_id)
        existing_settings = await self._read_json(settings_path) or {}
        merged_settings = {**existing_settings, **settings}
        await self._write_json(settings_path, merged_settings)
        return True

    async def update_conversation_session_id(
        self,
        conversation_id: str,
        session_id: str
    ) -> bool:
        """Update the session_id for an agent conversation.

        This is used to store the Claude Agent SDK session ID for resuming
        conversations when the user switches tabs or returns later.
        """
        metadata_path = self._get_metadata_path(conversation_id)
        metadata = await self._read_json(metadata_path)
        if not metadata:
            return False

        metadata["session_id"] = session_id
        metadata["updated_at"] = datetime.utcnow().isoformat()
        await self._write_json(metadata_path, metadata)
        return True

    async def delete_conversation(self, conversation_id: str) -> bool:
        """Delete a conversation and all its files."""
        conv_path = self._get_conversation_path(conversation_id)
        if not conv_path.exists():
            return False

        import shutil
        shutil.rmtree(conv_path)
        return True

    # =========================================================================
    # Message Operations
    # =========================================================================

    async def add_message(
        self,
        conversation_id: str,
        role: str,
        content: Any,
        thinking: Optional[str] = None,
        tool_results: Optional[List[Dict]] = None,
        branch: Optional[List[int]] = None,
        streaming: bool = False
    ) -> Dict[str, Any]:
        """Add a message to a branch.

        If branch is None, uses current_branch from metadata.
        """
        metadata = await self._read_json(self._get_metadata_path(conversation_id))
        if not metadata:
            raise ValueError(f"Conversation {conversation_id} not found")

        if branch is None:
            branch = metadata.get("current_branch", [0])

        # Read current branch
        branch_path = self._get_branch_path(conversation_id, branch)
        branch_data = await self._read_json(branch_path)
        if not branch_data:
            branch_data = {"messages": []}

        # Create message
        message_id = str(uuid.uuid4())
        now = datetime.utcnow().isoformat()
        position = len(branch_data["messages"])

        message = {
            "id": message_id,
            "role": role,
            "content": content,
            "thinking": thinking,
            "created_at": now
        }

        # Add tool_results for agent messages
        if tool_results:
            message["tool_results"] = tool_results

        # Append message
        branch_data["messages"].append(message)
        await self._write_json(branch_path, branch_data)

        # Update metadata timestamp
        metadata["updated_at"] = now
        await self._write_json(self._get_metadata_path(conversation_id), metadata)

        return {
            "id": message_id,
            "conversation_id": conversation_id,
            "role": role,
            "content": content,
            "thinking": thinking,
            "tool_results": tool_results,
            "position": position,
            "version": 1,
            "total_versions": 1,
            "created_at": now,
            "streaming": streaming
        }

    async def update_message_content(
        self,
        conversation_id: str,
        message_id: str,
        content: Any,
        thinking: Optional[str] = None,
        tool_results: Optional[List[Dict]] = None,
        branch: Optional[List[int]] = None,
        streaming: bool = True
    ) -> bool:
        """Update message content (used for streaming updates)."""
        metadata = await self._read_json(self._get_metadata_path(conversation_id))
        if not metadata:
            return False

        if branch is None:
            branch = metadata.get("current_branch", [0])

        branch_path = self._get_branch_path(conversation_id, branch)
        branch_data = await self._read_json(branch_path)
        if not branch_data:
            return False

        # Find and update the message
        for msg in branch_data["messages"]:
            if msg.get("id") == message_id:
                msg["content"] = content
                if thinking is not None:
                    msg["thinking"] = thinking
                if tool_results is not None:
                    msg["tool_results"] = tool_results
                await self._write_json(branch_path, branch_data)
                return True

        return False

    async def get_messages(
        self,
        conversation_id: str,
        branch: Optional[List[int]] = None
    ) -> List[Dict[str, Any]]:
        """Get all messages for a branch."""
        conv = await self.get_conversation(conversation_id, branch)
        return conv["messages"] if conv else []

    async def get_messages_up_to(
        self,
        conversation_id: str,
        position: int,
        branch: Optional[List[int]] = None
    ) -> List[Dict[str, Any]]:
        """Get messages up to (not including) a position."""
        messages = await self.get_messages(conversation_id, branch)
        return messages[:position]

    # =========================================================================
    # Branching Operations
    # =========================================================================

    async def create_branch(
        self,
        conversation_id: str,
        current_branch: List[int],
        user_msg_index: int,
        new_content: Any
    ) -> Dict[str, Any]:
        """Create a new branch by editing a user message.

        Args:
            conversation_id: The conversation ID
            current_branch: Current branch array
            user_msg_index: Which user message (0-based) is being edited
            new_content: New content for the user message

        Returns:
            Dict with new branch info and the edited message
        """
        # Read current branch to get messages up to edit point
        branch_path = self._get_branch_path(conversation_id, current_branch)
        branch_data = await self._read_json(branch_path)
        if not branch_data:
            raise ValueError("Branch not found")

        messages = branch_data["messages"]

        # Find the position of the user message being edited
        user_count = 0
        edit_position = None
        for i, msg in enumerate(messages):
            if msg["role"] == "user":
                if user_count == user_msg_index:
                    edit_position = i
                    break
                user_count += 1

        if edit_position is None:
            raise ValueError(f"User message {user_msg_index} not found")

        # Determine new branch number at this position
        # Scan existing branches to find next available number
        existing_branches = self._list_branch_files(conversation_id)

        # Get the prefix up to but not including the edit position
        prefix = self.extend_branch_array(current_branch, user_msg_index)

        # Find all branches with this prefix and get their values at user_msg_index
        used_numbers = set()
        for filename in existing_branches:
            file_branch = self.filename_to_branch_array(filename)
            file_prefix = self.extend_branch_array(file_branch, user_msg_index)

            if file_prefix == prefix:
                # This branch shares our prefix
                extended = self.extend_branch_array(file_branch, user_msg_index + 1)
                used_numbers.add(extended[user_msg_index])

        # Find next available number
        new_branch_num = 0
        while new_branch_num in used_numbers:
            new_branch_num += 1

        # Create new branch array
        new_branch = prefix + [new_branch_num]

        # Copy messages up to edit position, then add edited message
        new_messages = []
        for i, msg in enumerate(messages):
            if i < edit_position:
                new_messages.append(dict(msg))
            elif i == edit_position:
                # Add edited user message
                message_id = str(uuid.uuid4())
                now = datetime.utcnow().isoformat()
                new_messages.append({
                    "id": message_id,
                    "role": "user",
                    "content": new_content,
                    "thinking": None,
                    "created_at": now
                })
                break

        # Write new branch file
        new_branch_path = self._get_branch_path(conversation_id, new_branch)
        await self._write_json(new_branch_path, {"messages": new_messages})

        # Update metadata to use new branch
        metadata = await self._read_json(self._get_metadata_path(conversation_id))
        metadata["current_branch"] = new_branch
        metadata["updated_at"] = datetime.utcnow().isoformat()
        await self._write_json(self._get_metadata_path(conversation_id), metadata)

        edited_msg = new_messages[-1]
        return {
            "branch": new_branch,
            "message": {
                "id": edited_msg["id"],
                "conversation_id": conversation_id,
                "role": "user",
                "content": new_content,
                "position": edit_position,
                "version": new_branch_num + 1,  # 1-indexed for display
                "total_versions": len(used_numbers) + 1,
                "created_at": edited_msg["created_at"]
            }
        }

    async def switch_branch(
        self,
        conversation_id: str,
        current_branch: List[int],
        user_msg_index: int,
        direction: int
    ) -> Optional[List[int]]:
        """Switch to adjacent branch at a user message position.

        Args:
            conversation_id: The conversation ID
            current_branch: Current branch array
            user_msg_index: Which user message position to switch at
            direction: -1 for previous, +1 for next

        Returns:
            New branch array, or None if no branch exists in that direction
        """
        # Get prefix up to the switch position
        prefix = self.extend_branch_array(current_branch, user_msg_index)
        current_extended = self.extend_branch_array(current_branch, user_msg_index + 1)
        current_value = current_extended[user_msg_index]

        # Find all branches with this prefix
        existing_branches = self._list_branch_files(conversation_id)
        branch_values = set()

        for filename in existing_branches:
            file_branch = self.filename_to_branch_array(filename)
            file_prefix = self.extend_branch_array(file_branch, user_msg_index)

            if file_prefix == prefix:
                extended = self.extend_branch_array(file_branch, user_msg_index + 1)
                branch_values.add(extended[user_msg_index])

        if not branch_values:
            return None

        # Sort values and find adjacent
        sorted_values = sorted(branch_values)
        current_idx = sorted_values.index(current_value) if current_value in sorted_values else 0

        new_idx = current_idx + direction
        if new_idx < 0:
            new_idx = len(sorted_values) - 1  # Wrap around
        elif new_idx >= len(sorted_values):
            new_idx = 0  # Wrap around

        new_value = sorted_values[new_idx]
        new_branch = prefix + [new_value]

        # Find the actual branch file that matches this (snap to lowest downstream)
        # Look for the branch file with this prefix that has the lowest numbers after
        best_match = None
        for filename in existing_branches:
            file_branch = self.filename_to_branch_array(filename)
            file_extended = self.extend_branch_array(file_branch, user_msg_index + 1)

            if file_extended[:user_msg_index + 1] == new_branch:
                if best_match is None:
                    best_match = file_branch
                else:
                    # Prefer branch with smaller values (snap to lowest)
                    if file_branch < best_match:
                        best_match = file_branch

        if best_match:
            # Update metadata
            metadata = await self._read_json(self._get_metadata_path(conversation_id))
            metadata["current_branch"] = best_match
            await self._write_json(self._get_metadata_path(conversation_id), metadata)
            return best_match

        return new_branch

    async def get_version_info(
        self,
        conversation_id: str,
        branch: List[int],
        user_msg_index: int
    ) -> Dict[str, Any]:
        """Get version info for a specific user message position.

        Returns current version number and total versions at this position
        (considering only branches with the same prefix).
        """
        # Get prefix up to this position
        prefix = self.extend_branch_array(branch, user_msg_index)
        current_extended = self.extend_branch_array(branch, user_msg_index + 1)
        current_value = current_extended[user_msg_index]

        # Find all branches with this prefix
        existing_branches = self._list_branch_files(conversation_id)
        branch_values = set()

        for filename in existing_branches:
            file_branch = self.filename_to_branch_array(filename)
            file_prefix = self.extend_branch_array(file_branch, user_msg_index)

            if file_prefix == prefix:
                extended = self.extend_branch_array(file_branch, user_msg_index + 1)
                branch_values.add(extended[user_msg_index])

        if not branch_values:
            return {
                "position": user_msg_index,
                "current_version": 1,
                "total_versions": 1,
                "versions": [0]
            }

        sorted_values = sorted(branch_values)
        current_idx = sorted_values.index(current_value) if current_value in sorted_values else 0

        return {
            "position": user_msg_index,
            "current_version": current_idx + 1,  # 1-indexed
            "total_versions": len(sorted_values),
            "versions": sorted_values
        }

    async def get_branches(self, conversation_id: str) -> List[List[int]]:
        """List all branches in a conversation."""
        branch_files = self._list_branch_files(conversation_id)
        return [self.filename_to_branch_array(f) for f in branch_files]

    # =========================================================================
    # Search and Utility
    # =========================================================================

    async def search_conversations(self, query: str) -> List[Dict[str, Any]]:
        """Search conversations by title or message content."""
        results = []
        query_lower = query.lower()

        if not self.base_path.exists():
            return results

        for conv_dir in self.base_path.iterdir():
            if not conv_dir.is_dir():
                continue

            metadata = await self._read_json(conv_dir / "metadata.json")
            if not metadata:
                continue

            # Check title
            if query_lower in metadata.get("title", "").lower():
                results.append({
                    "id": metadata["id"],
                    "title": metadata["title"],
                    "created_at": metadata["created_at"],
                    "updated_at": metadata["updated_at"],
                    "model": metadata.get("model")
                })
                continue

            # Check messages in all branches
            found = False
            for branch_file in conv_dir.iterdir():
                if branch_file.name in ("metadata.json", "settings.json") or not branch_file.suffix == ".json":
                    continue

                branch_data = await self._read_json(branch_file)
                if not branch_data:
                    continue

                for msg in branch_data.get("messages", []):
                    content = msg.get("content", "")
                    if isinstance(content, str) and query_lower in content.lower():
                        found = True
                        break
                    elif isinstance(content, list):
                        for block in content:
                            if block.get("type") == "text" and query_lower in block.get("text", "").lower():
                                found = True
                                break

                if found:
                    break

            if found:
                results.append({
                    "id": metadata["id"],
                    "title": metadata["title"],
                    "created_at": metadata["created_at"],
                    "updated_at": metadata["updated_at"],
                    "model": metadata.get("model")
                })

        # Sort by updated_at descending
        results.sort(key=lambda x: x["updated_at"], reverse=True)
        return results

    async def duplicate_conversation(self, conversation_id: str) -> Optional[Dict[str, Any]]:
        """Duplicate a conversation with all its branches."""
        conv_path = self._get_conversation_path(conversation_id)
        if not conv_path.exists():
            return None

        new_id = str(uuid.uuid4())
        new_path = self._get_conversation_path(new_id)
        new_path.mkdir(parents=True, exist_ok=True)

        now = datetime.utcnow().isoformat()

        # Copy all files
        for src_file in conv_path.iterdir():
            if not src_file.is_file():
                continue

            data = await self._read_json(src_file)
            if not data:
                continue

            if src_file.name == "metadata.json":
                # Update metadata for new conversation
                data["id"] = new_id
                data["title"] = f"Copy of {data['title']}"
                data["created_at"] = now
                data["updated_at"] = now
                data["current_branch"] = [0]

            await self._write_json(new_path / src_file.name, data)

        # Return new conversation info
        metadata = await self._read_json(new_path / "metadata.json")
        return {
            "id": new_id,
            "title": metadata["title"],
            "created_at": now,
            "updated_at": now,
            "model": metadata.get("model"),
            "system_prompt": metadata.get("system_prompt")
        }

    # =========================================================================
    # Retry Support (Assistant message regeneration)
    # =========================================================================

    async def retry_assistant_message(
        self,
        conversation_id: str,
        branch: List[int],
        position: int,
        new_content: Any,
        thinking: Optional[str] = None
    ) -> Dict[str, Any]:
        """Regenerate an assistant message in place.

        Unlike user message edits (which create new branches), retrying an
        assistant message just replaces the assistant message and removes
        any messages after it in the current branch.
        """
        branch_path = self._get_branch_path(conversation_id, branch)
        branch_data = await self._read_json(branch_path)
        if not branch_data:
            raise ValueError("Branch not found")

        messages = branch_data["messages"]
        if position >= len(messages):
            raise ValueError(f"Position {position} out of range")

        # Truncate to position
        messages = messages[:position]

        # Add new assistant message
        message_id = str(uuid.uuid4())
        now = datetime.utcnow().isoformat()

        new_message = {
            "id": message_id,
            "role": "assistant",
            "content": new_content,
            "thinking": thinking,
            "created_at": now
        }
        messages.append(new_message)

        # Save
        branch_data["messages"] = messages
        await self._write_json(branch_path, branch_data)

        # Update metadata timestamp
        metadata = await self._read_json(self._get_metadata_path(conversation_id))
        metadata["updated_at"] = now
        await self._write_json(self._get_metadata_path(conversation_id), metadata)

        return {
            "id": message_id,
            "conversation_id": conversation_id,
            "role": "assistant",
            "content": new_content,
            "thinking": thinking,
            "position": position,
            "version": 1,
            "created_at": now
        }

    async def set_current_branch(self, conversation_id: str, branch: List[int]) -> bool:
        """Set the current branch for a conversation."""
        metadata_path = self._get_metadata_path(conversation_id)
        metadata = await self._read_json(metadata_path)
        if not metadata:
            return False

        metadata["current_branch"] = branch
        await self._write_json(metadata_path, metadata)
        return True

    async def delete_messages_from(
        self,
        conversation_id: str,
        position: int,
        branch: Optional[List[int]] = None
    ) -> bool:
        """Delete messages from a position onwards (inclusive).

        This truncates the branch file to remove all messages at and after
        the specified position. Since children are naturally part of the
        same branch file, they are automatically deleted.
        """
        print(f"[DELETE] Attempting to delete from conversation {conversation_id}, position {position}, branch {branch}")

        metadata = await self._read_json(self._get_metadata_path(conversation_id))
        if not metadata:
            print(f"[DELETE] ERROR: Metadata not found for conversation {conversation_id}")
            return False

        if branch is None:
            branch = metadata.get("current_branch", [0])

        print(f"[DELETE] Using branch: {branch}")

        branch_path = self._get_branch_path(conversation_id, branch)
        print(f"[DELETE] Branch path: {branch_path}")

        branch_data = await self._read_json(branch_path)
        if not branch_data:
            print(f"[DELETE] ERROR: Branch data not found at {branch_path}")
            return False

        # Truncate messages
        messages = branch_data.get("messages", [])
        print(f"[DELETE] Found {len(messages)} messages in branch")

        if position >= len(messages):
            print(f"[DELETE] ERROR: Position {position} >= message count {len(messages)}")
            return False  # Nothing to delete

        branch_data["messages"] = messages[:position]
        await self._write_json(branch_path, branch_data)
        print(f"[DELETE] Successfully truncated to {position} messages")

        # Update metadata timestamp
        metadata["updated_at"] = datetime.utcnow().isoformat()
        await self._write_json(self._get_metadata_path(conversation_id), metadata)

        return True

```

---

### `services/file_processor.py`

**Purpose:** Service for processing uploaded files (images, PDFs, etc.)

```python
"""File processing utilities for uploads."""

import base64
import mimetypes
from pathlib import Path
from typing import Dict, Any, Optional, Tuple

from config import (
    MAX_IMAGE_SIZE, MAX_PDF_SIZE, MAX_TEXT_SIZE,
    ALLOWED_IMAGE_TYPES, ALLOWED_DOCUMENT_TYPES, ALLOWED_TEXT_EXTENSIONS
)


class FileProcessor:
    """Process uploaded files for the Anthropic API."""

    @staticmethod
    def get_mime_type(filename: str, content_type: Optional[str] = None) -> str:
        """Determine the MIME type of a file."""
        if content_type and content_type != "application/octet-stream":
            return content_type

        mime_type, _ = mimetypes.guess_type(filename)
        return mime_type or "application/octet-stream"

    @staticmethod
    def validate_file(
        filename: str,
        content: bytes,
        content_type: Optional[str] = None
    ) -> Tuple[bool, str, str]:
        """
        Validate an uploaded file.

        Returns: (is_valid, error_message, file_type)
        file_type is one of: 'image', 'document', 'text'
        """
        mime_type = FileProcessor.get_mime_type(filename, content_type)
        file_size = len(content)
        ext = Path(filename).suffix.lower()

        # Check for images
        if mime_type in ALLOWED_IMAGE_TYPES:
            if file_size > MAX_IMAGE_SIZE:
                return False, f"Image too large. Maximum size is {MAX_IMAGE_SIZE // (1024*1024)}MB", ""
            return True, "", "image"

        # Check for PDFs
        if mime_type in ALLOWED_DOCUMENT_TYPES or ext == ".pdf":
            if file_size > MAX_PDF_SIZE:
                return False, f"PDF too large. Maximum size is {MAX_PDF_SIZE // (1024*1024)}MB", ""
            return True, "", "document"

        # Check for text files
        if ext in ALLOWED_TEXT_EXTENSIONS:
            if file_size > MAX_TEXT_SIZE:
                return False, f"Text file too large. Maximum size is {MAX_TEXT_SIZE // (1024*1024)}MB", ""
            return True, "", "text"

        # Check if it might be a text file by content type
        if mime_type and mime_type.startswith("text/"):
            if file_size > MAX_TEXT_SIZE:
                return False, f"Text file too large. Maximum size is {MAX_TEXT_SIZE // (1024*1024)}MB", ""
            return True, "", "text"

        return False, f"Unsupported file type: {mime_type or ext}", ""

    @staticmethod
    def process_file(
        filename: str,
        content: bytes,
        content_type: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Process a file for the Anthropic API.

        Returns the appropriate content block format for the API.
        """
        is_valid, error, file_type = FileProcessor.validate_file(filename, content, content_type)

        if not is_valid:
            raise ValueError(error)

        mime_type = FileProcessor.get_mime_type(filename, content_type)

        if file_type == "image":
            return {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": mime_type,
                    "data": base64.b64encode(content).decode("utf-8")
                }
            }

        elif file_type == "document":
            return {
                "type": "document",
                "source": {
                    "type": "base64",
                    "media_type": "application/pdf",
                    "data": base64.b64encode(content).decode("utf-8")
                }
            }

        elif file_type == "text":
            # For text files, we include them as text content
            try:
                text_content = content.decode("utf-8")
            except UnicodeDecodeError:
                text_content = content.decode("latin-1")

            return {
                "type": "text",
                "text": f"File: {filename}\n\n```\n{text_content}\n```"
            }

        raise ValueError(f"Unknown file type: {file_type}")

    @staticmethod
    def create_preview(
        filename: str,
        content: bytes,
        content_type: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Create a preview representation of a file.

        Returns metadata for UI display.
        """
        mime_type = FileProcessor.get_mime_type(filename, content_type)
        file_size = len(content)
        ext = Path(filename).suffix.lower()

        preview = {
            "filename": filename,
            "size": file_size,
            "size_display": FileProcessor._format_size(file_size),
            "mime_type": mime_type,
            "extension": ext
        }

        # For images, include base64 for thumbnail
        if mime_type in ALLOWED_IMAGE_TYPES:
            preview["type"] = "image"
            preview["thumbnail"] = f"data:{mime_type};base64,{base64.b64encode(content).decode('utf-8')}"

        elif mime_type in ALLOWED_DOCUMENT_TYPES or ext == ".pdf":
            preview["type"] = "document"

        else:
            preview["type"] = "text"
            # Include first few lines for text preview
            try:
                text = content.decode("utf-8")[:500]
                preview["preview_text"] = text
            except UnicodeDecodeError:
                preview["preview_text"] = "[Binary content]"

        return preview

    @staticmethod
    def _format_size(size: int) -> str:
        """Format file size for display."""
        for unit in ["B", "KB", "MB", "GB"]:
            if size < 1024:
                return f"{size:.1f} {unit}"
            size /= 1024
        return f"{size:.1f} TB"

```

---

### `services/project_store.py`

**Purpose:** Service for managing project data and settings

```python
"""JSON file-based project storage for organizing conversations."""

import json
import uuid
from datetime import datetime
from pathlib import Path
from typing import List, Dict, Any, Optional

# Use absolute path to avoid issues when MCP servers run with different cwd
DATA_DIR = Path(__file__).parent.parent / "data"
PROJECTS_FILE = DATA_DIR / "projects.json"


class ProjectStore:
    """File-based storage for projects that organize conversations."""

    def __init__(self):
        DATA_DIR.mkdir(parents=True, exist_ok=True)

    async def initialize(self):
        """Initialize the projects file if it doesn't exist."""
        if not PROJECTS_FILE.exists():
            self._save_projects([])

    def _load_projects(self) -> List[Dict[str, Any]]:
        """Load projects from JSON file."""
        if not PROJECTS_FILE.exists():
            return []
        try:
            with open(PROJECTS_FILE, 'r') as f:
                data = json.load(f)
                return data.get('projects', [])
        except (json.JSONDecodeError, IOError):
            return []

    def _save_projects(self, projects: List[Dict[str, Any]]):
        """Save projects to JSON file."""
        with open(PROJECTS_FILE, 'w') as f:
            json.dump({'projects': projects}, f, indent=2)

    async def list_projects(self) -> List[Dict[str, Any]]:
        """List all projects."""
        return self._load_projects()

    async def get_project(self, project_id: str) -> Optional[Dict[str, Any]]:
        """Get a project by ID."""
        projects = self._load_projects()
        for project in projects:
            if project['id'] == project_id:
                return project
        return None

    async def create_project(
        self,
        name: str,
        color: str = "#C15F3C",
        settings: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """Create a new project."""
        projects = self._load_projects()
        now = datetime.utcnow().isoformat()

        project = {
            "id": str(uuid.uuid4()),
            "name": name,
            "color": color,
            "created_at": now,
            "updated_at": now,
            "conversation_ids": [],
            "settings": settings or {}
        }

        projects.insert(0, project)  # Add at the beginning
        self._save_projects(projects)
        return project

    async def update_project(
        self,
        project_id: str,
        name: Optional[str] = None,
        color: Optional[str] = None,
        settings: Optional[Dict[str, Any]] = None
    ) -> bool:
        """Update a project's metadata."""
        projects = self._load_projects()

        for project in projects:
            if project['id'] == project_id:
                if name is not None:
                    project['name'] = name
                if color is not None:
                    project['color'] = color
                if settings is not None:
                    project['settings'] = settings
                project['updated_at'] = datetime.utcnow().isoformat()
                self._save_projects(projects)
                return True

        return False

    async def delete_project(self, project_id: str) -> bool:
        """Delete a project. Conversations are kept but unassigned."""
        projects = self._load_projects()
        original_length = len(projects)
        projects = [p for p in projects if p['id'] != project_id]

        if len(projects) < original_length:
            self._save_projects(projects)
            return True
        return False

    async def add_conversation(self, project_id: str, conversation_id: str) -> bool:
        """Add a conversation to a project."""
        projects = self._load_projects()

        # First, remove the conversation from any other project
        for project in projects:
            if conversation_id in project['conversation_ids']:
                project['conversation_ids'].remove(conversation_id)
                project['updated_at'] = datetime.utcnow().isoformat()

        # Then add to the target project
        for project in projects:
            if project['id'] == project_id:
                if conversation_id not in project['conversation_ids']:
                    project['conversation_ids'].insert(0, conversation_id)  # Add at beginning
                    project['updated_at'] = datetime.utcnow().isoformat()
                self._save_projects(projects)
                return True

        return False

    async def remove_conversation(self, project_id: str, conversation_id: str) -> bool:
        """Remove a conversation from a project."""
        projects = self._load_projects()

        for project in projects:
            if project['id'] == project_id:
                if conversation_id in project['conversation_ids']:
                    project['conversation_ids'].remove(conversation_id)
                    project['updated_at'] = datetime.utcnow().isoformat()
                    self._save_projects(projects)
                    return True
                return False

        return False

    async def get_conversation_project_map(self) -> Dict[str, str]:
        """Get a mapping of conversation_id -> project_id."""
        projects = self._load_projects()
        conv_map = {}
        for project in projects:
            for conv_id in project['conversation_ids']:
                conv_map[conv_id] = project['id']
        return conv_map

    async def get_project_for_conversation(self, conversation_id: str) -> Optional[str]:
        """Get the project ID for a conversation, if any."""
        projects = self._load_projects()
        for project in projects:
            if conversation_id in project['conversation_ids']:
                return project['id']
        return None

    def get_project_memory_path(self, project_id: str) -> str:
        """Get the memory directory path for a project."""
        return str(DATA_DIR / "projects" / project_id / "memories")

    def get_conversation_memory_path(self, conversation_id: str) -> str:
        """Get the memory directory path for a standalone conversation (not in a project)."""
        return str(DATA_DIR / "conversations" / conversation_id / "memories")

```

---

## MCP Tool Servers

### `tools/gif_mcp_server.py`

**Purpose:** MCP server for GIF search functionality via Giphy API

```python
#!/usr/bin/env python3
"""MCP stdio server for GIF search using Giphy API.

This server implements the Model Context Protocol (MCP) over stdio,
allowing Claude to search for GIFs using the Giphy API.

Usage:
    python gif_mcp_server.py

The server reads JSON-RPC messages from stdin and writes responses to stdout.
"""

import json
import sys
import os
import urllib.request
import urllib.parse
from pathlib import Path

# Load .env from project root
env_path = Path(__file__).parent.parent / ".env"
if env_path.exists():
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                os.environ.setdefault(key.strip(), value.strip())

GIPHY_API_KEY = os.environ.get("GIPHY_API_KEY")

# Tool definition
SEARCH_GIF_TOOL = {
    "name": "search_gif",
    "description": "Search for a GIF using the Giphy API. Returns a GIF URL that will be displayed in the chat. Use this when the user asks for a GIF, reaction image, or animated image.",
    "inputSchema": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "The search query for finding a GIF (e.g., 'happy cat', 'thumbs up', 'dancing')"
            }
        },
        "required": ["query"]
    }
}


def search_giphy(query: str) -> dict:
    """Search Giphy API for a GIF."""
    if not GIPHY_API_KEY:
        return {"error": "GIPHY_API_KEY not configured"}

    base_url = "https://api.giphy.com/v1/gifs/search"
    params = urllib.parse.urlencode({
        "api_key": GIPHY_API_KEY,
        "q": query,
        "limit": 1,
        "rating": "g"
    })
    url = f"{base_url}?{params}"

    try:
        with urllib.request.urlopen(url, timeout=10) as response:
            data = json.loads(response.read().decode())

        if not data.get("data"):
            return {"error": f"No GIFs found for '{query}'"}

        gif = data["data"][0]
        return {
            "success": True,
            "title": gif.get("title", ""),
            "url": gif["images"]["original"]["url"],
        }
    except Exception as e:
        return {"error": str(e)}


def handle_request(request: dict) -> dict:
    """Handle an MCP JSON-RPC request."""
    method = request.get("method", "")
    request_id = request.get("id")
    params = request.get("params", {})

    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {
                    "tools": {}
                },
                "serverInfo": {
                    "name": "gif-search",
                    "version": "1.0.0"
                }
            }
        }

    elif method == "notifications/initialized":
        # This is a notification, no response needed
        return None

    elif method == "tools/list":
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "tools": [SEARCH_GIF_TOOL]
            }
        }

    elif method == "tools/call":
        tool_name = params.get("name", "")
        arguments = params.get("arguments", {})

        if tool_name == "search_gif":
            query = arguments.get("query", "")
            if not query:
                return {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "result": {
                        "content": [{"type": "text", "text": "Error: No search query provided"}],
                        "isError": True
                    }
                }

            result = search_giphy(query)

            if result.get("error"):
                return {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "result": {
                        "content": [{"type": "text", "text": f"Error: {result['error']}"}],
                        "isError": True
                    }
                }

            # Return the GIF info - the URL will be auto-embedded by the frontend
            response_text = f"""Found a GIF for "{query}":

**{result['title']}**

{result['url']}"""

            return {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "content": [{"type": "text", "text": response_text}]
                }
            }
        else:
            return {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {
                    "code": -32601,
                    "message": f"Unknown tool: {tool_name}"
                }
            }

    else:
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {
                "code": -32601,
                "message": f"Method not found: {method}"
            }
        }


def main():
    """Main loop - read JSON-RPC messages from stdin, write responses to stdout."""
    # Unbuffered output
    sys.stdout = open(sys.stdout.fileno(), mode='w', buffering=1)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            request = json.loads(line)
            response = handle_request(request)

            if response is not None:
                print(json.dumps(response), flush=True)

        except json.JSONDecodeError as e:
            error_response = {
                "jsonrpc": "2.0",
                "id": None,
                "error": {
                    "code": -32700,
                    "message": f"Parse error: {str(e)}"
                }
            }
            print(json.dumps(error_response), flush=True)
        except Exception as e:
            error_response = {
                "jsonrpc": "2.0",
                "id": None,
                "error": {
                    "code": -32603,
                    "message": f"Internal error: {str(e)}"
                }
            }
            print(json.dumps(error_response), flush=True)


if __name__ == "__main__":
    main()

```

---

### `tools/gif_search.py`

**Purpose:** GIF search helper functions

```python
#!/usr/bin/env python3
"""GIF search tool using Giphy API.

Usage:
    python gif_search.py "search query"

Returns:
    JSON with GIF URL that can be displayed in the chat UI.

The output format is designed to be parsed by the chat frontend
to display the GIF inline.
"""

import os
import sys
import json
import urllib.request
import urllib.parse
from pathlib import Path

# Load .env file from project root
env_path = Path(__file__).parent.parent / ".env"
if env_path.exists():
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                os.environ.setdefault(key.strip(), value.strip())

GIPHY_API_KEY = os.environ.get("GIPHY_API_KEY")

def search_gif(query: str, limit: int = 1) -> dict:
    """Search for a GIF on Giphy.

    Args:
        query: Search query string
        limit: Number of results to return (default 1)

    Returns:
        Dictionary with GIF information including URL
    """
    if not GIPHY_API_KEY:
        return {"error": "GIPHY_API_KEY not set in environment"}

    # Build API URL
    base_url = "https://api.giphy.com/v1/gifs/search"
    params = urllib.parse.urlencode({
        "api_key": GIPHY_API_KEY,
        "q": query,
        "limit": limit,
        "rating": "g"
    })
    url = f"{base_url}?{params}"

    try:
        with urllib.request.urlopen(url, timeout=10) as response:
            data = json.loads(response.read().decode())

        if not data.get("data"):
            return {"error": f"No GIFs found for '{query}'"}

        gif = data["data"][0]

        # Return the GIF info in a format the frontend can use
        return {
            "type": "gif",
            "url": gif["images"]["original"]["url"],
            "title": gif.get("title", ""),
            "preview_url": gif["images"]["fixed_height"]["url"],
            "width": gif["images"]["original"]["width"],
            "height": gif["images"]["original"]["height"]
        }

    except urllib.error.URLError as e:
        return {"error": f"Failed to fetch from Giphy: {str(e)}"}
    except json.JSONDecodeError as e:
        return {"error": f"Failed to parse Giphy response: {str(e)}"}
    except Exception as e:
        return {"error": f"Unexpected error: {str(e)}"}


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: gif_search.py 'search query'"}))
        sys.exit(1)

    query = " ".join(sys.argv[1:])
    result = search_gif(query)

    # Output as JSON for easy parsing
    print(json.dumps(result, indent=2))

    if "error" in result:
        sys.exit(1)


if __name__ == "__main__":
    main()

```

---

### `tools/memory_mcp_server.py`

**Purpose:** MCP server for persistent memory storage across conversations

```python
#!/usr/bin/env python3
"""MCP stdio server for memory operations.

This server implements the Model Context Protocol (MCP) over stdio,
allowing Claude to store and retrieve information in a memory directory.
Memories are stored per-project for shared context across conversations.

Usage:
    python memory_mcp_server.py --memory-path /path/to/memories

The server reads JSON-RPC messages from stdin and writes responses to stdout.
"""

import argparse
import json
import os
import shutil
import sys
from pathlib import Path




def get_memory_tools():
    """Return the list of memory tools."""
    return [
        {
            "name": "memory_view",
            "description": "View contents of a file or directory in the memory. Use this to check what memories exist or read specific memory files.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "The path within /memories to view. Use '/memories' to list all memories, or '/memories/filename.txt' to read a specific file."
                    },
                    "view_range": {
                        "type": "array",
                        "items": {"type": "integer"},
                        "description": "Optional [start_line, end_line] to view specific lines (1-indexed)"
                    }
                },
                "required": ["path"]
            }
        },
        {
            "name": "memory_create",
            "description": "Create a new memory file. Use this to store new information that should persist across conversations.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "The path for the new file (e.g., '/memories/notes.txt')"
                    },
                    "file_text": {
                        "type": "string",
                        "description": "The content to write to the file"
                    }
                },
                "required": ["path", "file_text"]
            }
        },
        {
            "name": "memory_str_replace",
            "description": "Replace text in a memory file. Use this to update existing memories.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "The path to the file to edit"
                    },
                    "old_str": {
                        "type": "string",
                        "description": "The text to replace (must match exactly)"
                    },
                    "new_str": {
                        "type": "string",
                        "description": "The replacement text"
                    }
                },
                "required": ["path", "old_str", "new_str"]
            }
        },
        {
            "name": "memory_insert",
            "description": "Insert text at a specific line in a memory file.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "The path to the file"
                    },
                    "insert_line": {
                        "type": "integer",
                        "description": "The line number to insert at (0 for beginning, or line number)"
                    },
                    "insert_text": {
                        "type": "string",
                        "description": "The text to insert"
                    }
                },
                "required": ["path", "insert_line", "insert_text"]
            }
        },
        {
            "name": "memory_delete",
            "description": "Delete a memory file or directory.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "The path to delete"
                    }
                },
                "required": ["path"]
            }
        },
        {
            "name": "memory_rename",
            "description": "Rename or move a memory file or directory.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "old_path": {
                        "type": "string",
                        "description": "The current path"
                    },
                    "new_path": {
                        "type": "string",
                        "description": "The new path"
                    }
                },
                "required": ["old_path", "new_path"]
            }
        }
    ]


class MemoryServer:
    """MCP server for memory operations."""

    def __init__(self, memory_base_path: str):
        """Initialize with the base path for memories."""
        # Convert to absolute path and resolve
        self.memory_base_path = Path(memory_base_path).resolve()
        self.memory_base_path.mkdir(parents=True, exist_ok=True)

    def _resolve_path(self, virtual_path: str) -> Path:
        """Resolve a virtual path (/memories/...) to a real path.

        Security: Validates path is within memory directory.
        """
        # Remove /memories prefix if present
        if virtual_path.startswith("/memories"):
            relative = virtual_path[9:]  # Remove "/memories"
        else:
            relative = virtual_path

        # Remove leading slash
        if relative.startswith("/"):
            relative = relative[1:]

        # Resolve to real path
        if relative:
            real_path = (self.memory_base_path / relative).resolve()
        else:
            real_path = self.memory_base_path.resolve()

        # Security check: ensure path is within memory directory
        try:
            real_path.relative_to(self.memory_base_path)
        except ValueError:
            raise ValueError(f"Path traversal attempt detected: {virtual_path}")

        return real_path

    def _format_size(self, size: int) -> str:
        """Format file size in human-readable format."""
        if size < 1024:
            return f"{size}B"
        elif size < 1024 * 1024:
            return f"{size / 1024:.1f}K"
        else:
            return f"{size / (1024 * 1024):.1f}M"

    def view(self, path: str, view_range: list = None) -> str:
        """View a file or directory."""
        try:
            real_path = self._resolve_path(path)
        except ValueError as e:
            return str(e)

        if not real_path.exists():
            return f"The path {path} does not exist. Please provide a valid path."

        if real_path.is_dir():
            # List directory contents (up to 2 levels deep)
            lines = [f"Here're the files and directories up to 2 levels deep in {path}, excluding hidden items and node_modules:"]

            def list_dir(dir_path: Path, prefix: str, depth: int):
                if depth > 2:
                    return
                try:
                    items = sorted(dir_path.iterdir())
                    for item in items:
                        # Skip hidden files and node_modules
                        if item.name.startswith('.') or item.name == 'node_modules':
                            continue

                        if item.is_file():
                            size = self._format_size(item.stat().st_size)
                            rel_path = "/" + str(item.relative_to(self.memory_base_path.parent))
                            lines.append(f"{size}\t{rel_path}")
                        elif item.is_dir():
                            rel_path = "/" + str(item.relative_to(self.memory_base_path.parent))
                            lines.append(f"4.0K\t{rel_path}")
                            list_dir(item, prefix, depth + 1)
                except PermissionError:
                    pass

            # Add the directory itself
            rel_path = "/" + str(real_path.relative_to(self.memory_base_path.parent))
            lines.append(f"4.0K\t{rel_path}")
            list_dir(real_path, "", 1)

            return "\n".join(lines)
        else:
            # Read file contents
            try:
                with open(real_path, 'r', encoding='utf-8') as f:
                    file_lines = f.readlines()
            except UnicodeDecodeError:
                return f"Error: {path} is a binary file and cannot be displayed."

            if len(file_lines) > 999999:
                return f"File {path} exceeds maximum line limit of 999,999 lines."

            # Apply view_range if specified
            if view_range and len(view_range) == 2:
                start, end = view_range
                start = max(1, start) - 1  # Convert to 0-indexed
                end = min(len(file_lines), end)
                file_lines = file_lines[start:end]
                line_offset = start
            else:
                line_offset = 0

            # Format with line numbers (6 chars, right-aligned, tab separator)
            formatted_lines = [f"Here's the content of {path} with line numbers:"]
            for i, line in enumerate(file_lines, start=line_offset + 1):
                # Remove trailing newline for formatting
                line_content = line.rstrip('\n')
                formatted_lines.append(f"{i:6d}\t{line_content}")

            return "\n".join(formatted_lines)

    def create(self, path: str, file_text: str) -> str:
        """Create a new file."""
        try:
            real_path = self._resolve_path(path)
        except ValueError as e:
            return f"Error: {e}"

        if real_path.exists():
            return f"Error: File {path} already exists"

        # Create parent directories if needed
        real_path.parent.mkdir(parents=True, exist_ok=True)

        try:
            with open(real_path, 'w', encoding='utf-8') as f:
                f.write(file_text)
            return f"File created successfully at: {path}"
        except Exception as e:
            return f"Error creating file: {e}"

    def str_replace(self, path: str, old_str: str, new_str: str) -> str:
        """Replace text in a file."""
        try:
            real_path = self._resolve_path(path)
        except ValueError as e:
            return f"Error: {e}"

        if not real_path.exists():
            return f"Error: The path {path} does not exist. Please provide a valid path."

        if real_path.is_dir():
            return f"Error: The path {path} does not exist. Please provide a valid path."

        try:
            with open(real_path, 'r', encoding='utf-8') as f:
                content = f.read()
        except Exception as e:
            return f"Error reading file: {e}"

        # Count occurrences
        count = content.count(old_str)

        if count == 0:
            return f"No replacement was performed, old_str `{old_str}` did not appear verbatim in {path}."

        if count > 1:
            # Find line numbers of occurrences
            lines = content.split('\n')
            line_nums = []
            for i, line in enumerate(lines, 1):
                if old_str in line:
                    line_nums.append(str(i))
            return f"No replacement was performed. Multiple occurrences of old_str `{old_str}` in lines: {', '.join(line_nums)}. Please ensure it is unique"

        # Perform replacement
        new_content = content.replace(old_str, new_str, 1)

        try:
            with open(real_path, 'w', encoding='utf-8') as f:
                f.write(new_content)
        except Exception as e:
            return f"Error writing file: {e}"

        # Return success with snippet
        lines = new_content.split('\n')
        # Find the line with the replacement
        for i, line in enumerate(lines):
            if new_str in line:
                start = max(0, i - 2)
                end = min(len(lines), i + 3)
                snippet_lines = [f"{j+1:6d}\t{lines[j]}" for j in range(start, end)]
                snippet = "\n".join(snippet_lines)
                return f"The memory file has been edited.\n{snippet}"

        return "The memory file has been edited."

    def insert(self, path: str, insert_line: int, insert_text: str) -> str:
        """Insert text at a specific line."""
        try:
            real_path = self._resolve_path(path)
        except ValueError as e:
            return f"Error: {e}"

        if not real_path.exists():
            return f"Error: The path {path} does not exist"

        if real_path.is_dir():
            return f"Error: The path {path} does not exist"

        try:
            with open(real_path, 'r', encoding='utf-8') as f:
                lines = f.readlines()
        except Exception as e:
            return f"Error reading file: {e}"

        n_lines = len(lines)

        if insert_line < 0 or insert_line > n_lines:
            return f"Error: Invalid `insert_line` parameter: {insert_line}. It should be within the range of lines of the file: [0, {n_lines}]"

        # Ensure insert_text ends with newline if inserting in middle
        if not insert_text.endswith('\n') and insert_line < n_lines:
            insert_text += '\n'

        lines.insert(insert_line, insert_text)

        try:
            with open(real_path, 'w', encoding='utf-8') as f:
                f.writelines(lines)
            return f"The file {path} has been edited."
        except Exception as e:
            return f"Error writing file: {e}"

    def delete(self, path: str) -> str:
        """Delete a file or directory."""
        try:
            real_path = self._resolve_path(path)
        except ValueError as e:
            return f"Error: {e}"

        if not real_path.exists():
            return f"Error: The path {path} does not exist"

        # Prevent deleting the memories root
        if real_path.resolve() == self.memory_base_path.resolve():
            return "Error: Cannot delete the memories root directory"

        try:
            if real_path.is_file():
                real_path.unlink()
            else:
                shutil.rmtree(real_path)
            return f"Successfully deleted {path}"
        except Exception as e:
            return f"Error deleting: {e}"

    def rename(self, old_path: str, new_path: str) -> str:
        """Rename or move a file/directory."""
        try:
            real_old = self._resolve_path(old_path)
            real_new = self._resolve_path(new_path)
        except ValueError as e:
            return f"Error: {e}"

        if not real_old.exists():
            return f"Error: The path {old_path} does not exist"

        if real_new.exists():
            return f"Error: The destination {new_path} already exists"

        # Create parent directories if needed
        real_new.parent.mkdir(parents=True, exist_ok=True)

        try:
            real_old.rename(real_new)
            return f"Successfully renamed {old_path} to {new_path}"
        except Exception as e:
            return f"Error renaming: {e}"


def handle_request(server: MemoryServer, request: dict) -> dict:
    """Handle an MCP JSON-RPC request."""
    method = request.get("method", "")
    request_id = request.get("id")
    params = request.get("params", {})

    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {
                    "tools": {}
                },
                "serverInfo": {
                    "name": "memory",
                    "version": "1.0.0"
                }
            }
        }

    elif method == "notifications/initialized":
        return None

    elif method == "tools/list":
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "tools": get_memory_tools()
            }
        }

    elif method == "tools/call":
        tool_name = params.get("name", "")
        arguments = params.get("arguments", {})

        result_text = ""
        is_error = False

        try:
            if tool_name == "memory_view":
                result_text = server.view(
                    path=arguments.get("path", "/memories"),
                    view_range=arguments.get("view_range")
                )
            elif tool_name == "memory_create":
                result_text = server.create(
                    path=arguments.get("path", ""),
                    file_text=arguments.get("file_text", "")
                )
            elif tool_name == "memory_str_replace":
                result_text = server.str_replace(
                    path=arguments.get("path", ""),
                    old_str=arguments.get("old_str", ""),
                    new_str=arguments.get("new_str", "")
                )
            elif tool_name == "memory_insert":
                result_text = server.insert(
                    path=arguments.get("path", ""),
                    insert_line=arguments.get("insert_line", 0),
                    insert_text=arguments.get("insert_text", "")
                )
            elif tool_name == "memory_delete":
                result_text = server.delete(
                    path=arguments.get("path", "")
                )
            elif tool_name == "memory_rename":
                result_text = server.rename(
                    old_path=arguments.get("old_path", ""),
                    new_path=arguments.get("new_path", "")
                )
            else:
                return {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "error": {
                        "code": -32601,
                        "message": f"Unknown tool: {tool_name}"
                    }
                }

            # Check if result indicates an error
            if result_text.startswith("Error:"):
                is_error = True

        except Exception as e:
            result_text = f"Error: {str(e)}"
            is_error = True

        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "content": [{"type": "text", "text": result_text}],
                "isError": is_error
            }
        }

    else:
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {
                "code": -32601,
                "message": f"Method not found: {method}"
            }
        }


def main():
    """Main loop - read JSON-RPC messages from stdin, write responses to stdout."""
    parser = argparse.ArgumentParser(description="Memory MCP Server")
    parser.add_argument(
        "--memory-path",
        required=True,
        help="Base path for memory storage"
    )
    args = parser.parse_args()

    server = MemoryServer(args.memory_path)

    # Unbuffered output
    sys.stdout = open(sys.stdout.fileno(), mode='w', buffering=1)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            request = json.loads(line)
            response = handle_request(server, request)

            if response is not None:
                print(json.dumps(response), flush=True)

        except json.JSONDecodeError as e:
            error_response = {
                "jsonrpc": "2.0",
                "id": None,
                "error": {
                    "code": -32700,
                    "message": f"Parse error: {str(e)}"
                }
            }
            print(json.dumps(error_response), flush=True)
        except Exception as e:
            error_response = {
                "jsonrpc": "2.0",
                "id": None,
                "error": {
                    "code": -32603,
                    "message": f"Internal error: {str(e)}"
                }
            }
            print(json.dumps(error_response), flush=True)


if __name__ == "__main__":
    main()

```

---

### `tools/surface_mcp_server.py`

**Purpose:** MCP server for surfacing content (HTML/markdown) to the user

```python
#!/usr/bin/env python3
"""MCP stdio server for surfacing content to users.

This server implements the Model Context Protocol (MCP) over stdio,
allowing Claude to surface interactive HTML/markdown content to users
within chat messages. The content can include data viewers, rankers,
forms, and other interactive elements.

Usage:
    python surface_mcp_server.py --workspace-path /path/to/workspace --conversation-id abc123

The server reads JSON-RPC messages from stdin and writes responses to stdout.
"""

import argparse
import json
import os
import sys
import uuid
from pathlib import Path
from datetime import datetime


def get_surface_tools():
    """Return the list of surface tools.

    Note: We only expose surface_from_file and surface_from_script (not direct surface_content)
    because writing long HTML content inline is slow. The agent should write content to a file
    first, then surface it.
    """
    return [
        {
            "name": "workspace_read",
            "description": "Read a file from the conversation workspace. Use this to load data for display.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "filename": {
                        "type": "string",
                        "description": "The filename to read from the workspace"
                    }
                },
                "required": ["filename"]
            }
        },
        {
            "name": "workspace_write",
            "description": "Write content to a file in the conversation workspace. Use this to save data or state.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "filename": {
                        "type": "string",
                        "description": "The filename to write to the workspace"
                    },
                    "content": {
                        "type": "string",
                        "description": "The content to write"
                    }
                },
                "required": ["filename", "content"]
            }
        },
        {
            "name": "workspace_list",
            "description": "List files in the conversation workspace.",
            "inputSchema": {
                "type": "object",
                "properties": {},
                "required": []
            }
        },
        {
            "name": "surface_from_file",
            "description": """Read a file from the workspace and surface its content to the user.

WORKFLOW: Write an HTML/markdown file to workspace first, then call this tool to display it.

DESIGN SYSTEM - Use this warm color palette for consistent styling:
- Primary: #C15F3C (rust-orange), Hover: #A8523A
- Background: #F4F3EE (cream), Surface: #FFFFFF (white cards)
- Text: #1A1A1A, Secondary text: #666666
- Borders: #E0DDD4, Success: #4A9B7F, Warning: #D4A574

Example HTML structure:
```html
<style>
  body { font-family: system-ui; background: #F4F3EE; padding: 20px; }
  .card { background: #fff; border: 1px solid #E0DDD4; border-radius: 8px; padding: 20px; }
  .header { background: linear-gradient(135deg, #C15F3C, #A8523A); color: white; padding: 16px; border-radius: 8px 8px 0 0; margin: -20px -20px 20px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 12px; border-bottom: 1px solid #E0DDD4; text-align: left; }
  th { background: #F4F3EE; font-weight: 600; }
  .badge { padding: 4px 10px; border-radius: 12px; font-size: 12px; }
  .badge-success { background: #E8F5F0; color: #4A9B7F; }
</style>
<div class="card">
  <div class="header"><h2>Title</h2></div>
  <!-- content here -->
</div>
```""",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "filename": {
                        "type": "string",
                        "description": "The filename to read and surface (must be in workspace)"
                    },
                    "content_type": {
                        "type": "string",
                        "enum": ["html", "markdown"],
                        "description": "Type of content in the file"
                    },
                    "title": {
                        "type": "string",
                        "description": "Optional title for the content panel"
                    }
                },
                "required": ["filename", "content_type"]
            }
        },
        {
            "name": "surface_from_script",
            "description": """Execute a script in the workspace and surface its stdout output to the user.

WORKFLOW:
1. Write a script (Python, Node, bash) to workspace that prints HTML/markdown to stdout
2. Call this tool to execute it and surface the output

DESIGN SYSTEM - Use this warm color palette:
- Primary: #C15F3C (rust-orange), Background: #F4F3EE (cream)
- Cards: white with #E0DDD4 borders, rounded corners
- Header: gradient from #C15F3C to #A8523A with white text
- Success badges: #E8F5F0 bg with #4A9B7F text

Example Python script (viewer.py):
```python
print('''<style>
body { font-family: system-ui; background: #F4F3EE; padding: 20px; }
.card { background: #fff; border: 1px solid #E0DDD4; border-radius: 8px; padding: 20px; }
.header { background: linear-gradient(135deg, #C15F3C, #A8523A); color: white; padding: 16px; border-radius: 8px 8px 0 0; margin: -20px -20px 20px; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 12px; border-bottom: 1px solid #E0DDD4; }
th { background: #F4F3EE; }
</style>
<div class="card"><div class="header"><h2>Data</h2></div>
<table><tr><th>Name</th><th>Score</th></tr>
<tr><td>Alice</td><td>95</td></tr></table></div>''')
```""",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "script_file": {
                        "type": "string",
                        "description": "The script filename in workspace to execute"
                    },
                    "interpreter": {
                        "type": "string",
                        "description": "Interpreter to use (python3, node, bash, etc.). Default: auto-detect from extension"
                    },
                    "content_type": {
                        "type": "string",
                        "enum": ["html", "markdown"],
                        "description": "Type of content the script outputs"
                    },
                    "title": {
                        "type": "string",
                        "description": "Optional title for the content panel"
                    },
                    "args": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Optional arguments to pass to the script"
                    }
                },
                "required": ["script_file", "content_type"]
            }
        }
    ]


class SurfaceServer:
    """MCP server for surfacing content to users."""

    def __init__(self, workspace_path: str, conversation_id: str):
        """Initialize with the workspace path and conversation ID."""
        self.workspace_path = Path(workspace_path).resolve()
        self.conversation_id = conversation_id
        self.workspace_path.mkdir(parents=True, exist_ok=True)

    def _resolve_path(self, filename: str) -> Path:
        """Resolve a filename to a real path within workspace.

        Security: Validates path is within workspace directory.
        """
        # Sanitize filename
        filename = os.path.basename(filename)
        real_path = (self.workspace_path / filename).resolve()

        # Security check: ensure path is within workspace
        try:
            real_path.relative_to(self.workspace_path)
        except ValueError:
            raise ValueError(f"Path traversal attempt detected: {filename}")

        return real_path

    def surface_content(self, content: str, content_type: str, title: str = None, save_to_workspace: bool = False) -> dict:
        """Surface content to the user."""
        content_id = str(uuid.uuid4())[:8]

        result = {
            "type": "surface_content",
            "content_id": content_id,
            "content": content,
            "content_type": content_type,
            "title": title,
            "timestamp": datetime.utcnow().isoformat(),
            "conversation_id": self.conversation_id
        }

        # Optionally save to workspace
        if save_to_workspace:
            ext = ".html" if content_type == "html" else ".md"
            filename = f"surfaced_{content_id}{ext}"
            filepath = self.workspace_path / filename
            with open(filepath, 'w', encoding='utf-8') as f:
                f.write(content)
            result["saved_to"] = filename

        return result

    def workspace_read(self, filename: str) -> str:
        """Read a file from the workspace."""
        try:
            filepath = self._resolve_path(filename)
            if not filepath.exists():
                return f"Error: File '{filename}' not found in workspace"
            if filepath.is_dir():
                return f"Error: '{filename}' is a directory"
            with open(filepath, 'r', encoding='utf-8') as f:
                return f.read()
        except ValueError as e:
            return f"Error: {e}"
        except UnicodeDecodeError:
            return f"Error: '{filename}' is a binary file and cannot be read as text"
        except Exception as e:
            return f"Error reading file: {e}"

    def workspace_write(self, filename: str, content: str) -> str:
        """Write content to a file in the workspace."""
        try:
            filepath = self._resolve_path(filename)
            with open(filepath, 'w', encoding='utf-8') as f:
                f.write(content)
            return f"Successfully wrote {len(content)} characters to '{filename}'"
        except ValueError as e:
            return f"Error: {e}"
        except Exception as e:
            return f"Error writing file: {e}"

    def workspace_list(self) -> str:
        """List files in the workspace."""
        try:
            files = []
            for item in self.workspace_path.iterdir():
                if item.name.startswith('.'):
                    continue
                if item.is_file():
                    size = item.stat().st_size
                    files.append(f"{item.name} ({size} bytes)")
                elif item.is_dir():
                    files.append(f"{item.name}/ (directory)")

            if not files:
                return "Workspace is empty"
            return "Files in workspace:\n" + "\n".join(files)
        except Exception as e:
            return f"Error listing workspace: {e}"

    def surface_from_file(self, filename: str, content_type: str, title: str = None) -> dict:
        """Read a file from workspace and surface its content."""
        try:
            filepath = self._resolve_path(filename)
            if not filepath.exists():
                return {"error": f"File '{filename}' not found in workspace"}
            if filepath.is_dir():
                return {"error": f"'{filename}' is a directory"}

            with open(filepath, 'r', encoding='utf-8') as f:
                content = f.read()

            # Use surface_content to create the result
            return self.surface_content(content, content_type, title or filename)

        except ValueError as e:
            return {"error": str(e)}
        except UnicodeDecodeError:
            return {"error": f"'{filename}' is a binary file and cannot be surfaced"}
        except Exception as e:
            return {"error": f"Error reading file: {e}"}

    def surface_from_script(self, script_file: str, content_type: str, title: str = None,
                           interpreter: str = None, args: list = None) -> dict:
        """Execute a script and surface its stdout output."""
        import subprocess

        try:
            filepath = self._resolve_path(script_file)
            if not filepath.exists():
                return {"error": f"Script '{script_file}' not found in workspace"}

            # Auto-detect interpreter from extension if not provided
            if not interpreter:
                ext = filepath.suffix.lower()
                interpreter_map = {
                    '.py': 'python3',
                    '.js': 'node',
                    '.sh': 'bash',
                    '.rb': 'ruby',
                    '.pl': 'perl',
                    '.php': 'php',
                }
                interpreter = interpreter_map.get(ext)
                if not interpreter:
                    return {"error": f"Cannot auto-detect interpreter for '{ext}'. Please specify interpreter."}

            # Build command
            cmd = [interpreter, str(filepath)]
            if args:
                cmd.extend(args)

            # Execute with timeout and capture output
            try:
                result = subprocess.run(
                    cmd,
                    capture_output=True,
                    text=True,
                    timeout=30,  # 30 second timeout
                    cwd=str(self.workspace_path)
                )

                if result.returncode != 0:
                    error_msg = result.stderr or f"Script exited with code {result.returncode}"
                    return {"error": f"Script execution failed: {error_msg}"}

                content = result.stdout
                if not content.strip():
                    return {"error": "Script produced no output"}

                # Surface the output
                return self.surface_content(content, content_type, title or f"Output: {script_file}")

            except subprocess.TimeoutExpired:
                return {"error": "Script execution timed out (30s limit)"}

        except ValueError as e:
            return {"error": str(e)}
        except Exception as e:
            return {"error": f"Error executing script: {e}"}


def handle_request(server: SurfaceServer, request: dict) -> dict:
    """Handle an MCP JSON-RPC request."""
    method = request.get("method", "")
    request_id = request.get("id")
    params = request.get("params", {})

    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {
                    "tools": {}
                },
                "serverInfo": {
                    "name": "surface",
                    "version": "1.0.0"
                }
            }
        }

    elif method == "notifications/initialized":
        return None

    elif method == "tools/list":
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "tools": get_surface_tools()
            }
        }

    elif method == "tools/call":
        tool_name = params.get("name", "")
        arguments = params.get("arguments", {})

        result_text = ""
        is_error = False
        result_data = None

        try:
            if tool_name == "workspace_read":
                result_text = server.workspace_read(
                    filename=arguments.get("filename", "")
                )
            elif tool_name == "workspace_write":
                result_text = server.workspace_write(
                    filename=arguments.get("filename", ""),
                    content=arguments.get("content", "")
                )
            elif tool_name == "workspace_list":
                result_text = server.workspace_list()
            elif tool_name == "surface_from_file":
                result_data = server.surface_from_file(
                    filename=arguments.get("filename", ""),
                    content_type=arguments.get("content_type", "markdown"),
                    title=arguments.get("title")
                )
                if "error" in result_data:
                    result_text = f"Error: {result_data['error']}"
                    is_error = True
                else:
                    result_text = json.dumps(result_data)
            elif tool_name == "surface_from_script":
                result_data = server.surface_from_script(
                    script_file=arguments.get("script_file", ""),
                    content_type=arguments.get("content_type", "markdown"),
                    title=arguments.get("title"),
                    interpreter=arguments.get("interpreter"),
                    args=arguments.get("args")
                )
                if "error" in result_data:
                    result_text = f"Error: {result_data['error']}"
                    is_error = True
                else:
                    result_text = json.dumps(result_data)
            else:
                return {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "error": {
                        "code": -32601,
                        "message": f"Unknown tool: {tool_name}"
                    }
                }

            # Check if result indicates an error
            if result_text.startswith("Error:"):
                is_error = True

        except Exception as e:
            result_text = f"Error: {str(e)}"
            is_error = True

        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "content": [{"type": "text", "text": result_text}],
                "isError": is_error
            }
        }

    else:
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {
                "code": -32601,
                "message": f"Method not found: {method}"
            }
        }


def main():
    """Main loop - read JSON-RPC messages from stdin, write responses to stdout."""
    parser = argparse.ArgumentParser(description="Surface Content MCP Server")
    parser.add_argument(
        "--workspace-path",
        required=True,
        help="Path to conversation workspace"
    )
    parser.add_argument(
        "--conversation-id",
        required=True,
        help="Conversation ID"
    )
    args = parser.parse_args()

    server = SurfaceServer(args.workspace_path, args.conversation_id)

    # Unbuffered output
    sys.stdout = open(sys.stdout.fileno(), mode='w', buffering=1)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            request = json.loads(line)
            response = handle_request(server, request)

            if response is not None:
                print(json.dumps(response), flush=True)

        except json.JSONDecodeError as e:
            error_response = {
                "jsonrpc": "2.0",
                "id": None,
                "error": {
                    "code": -32700,
                    "message": f"Parse error: {str(e)}"
                }
            }
            print(json.dumps(error_response), flush=True)
        except Exception as e:
            error_response = {
                "jsonrpc": "2.0",
                "id": None,
                "error": {
                    "code": -32603,
                    "message": f"Internal error: {str(e)}"
                }
            }
            print(json.dumps(error_response), flush=True)


if __name__ == "__main__":
    main()

```

---

## Frontend JavaScript

### `static/js/app.js`

**Purpose:** Main frontend application - initializes UI components and event handlers

```javascript
/**
 * Main application initialization
 */

// Track current message index for arrow navigation
let currentMessageIndex = -1; // -1 means at bottom/input

document.addEventListener('DOMContentLoaded', async () => {
    console.log('Claude Chat UI initializing...');

    try {
        // Initialize all modules
        await SettingsManager.init();
        SettingsManager.setMode('normal');  // Default to normal mode
        await DefaultSettingsManager.init();
        await ProjectSettingsManager.init();
        FilesManager.init();
        PromptLibrary.init();
        WorkspaceManager.init();
        ChatManager.init();
        await ProjectsManager.init();
        await ConversationsManager.init();

        console.log('Claude Chat UI initialized successfully');

        // Set up help chat button
        const helpChatBtn = document.getElementById('help-chat-btn');
        if (helpChatBtn) {
            helpChatBtn.addEventListener('click', () => createHelpChat());
        }

    } catch (error) {
        console.error('Failed to initialize app:', error);
        alert('Failed to initialize application. Please refresh the page.');
    }
});

/**
 * Create a special help chat with documentation and code context
 */
async function createHelpChat() {
    try {
        // Fetch the latest documentation and code
        console.log('Fetching documentation and code...');
        const [capabilitiesResponse, codeResponse] = await Promise.all([
            fetch('/api/docs/capabilities'),
            fetch('/api/docs/code')
        ]);

        if (!capabilitiesResponse.ok || !codeResponse.ok) {
            throw new Error('Failed to fetch documentation');
        }

        const capabilities = await capabilitiesResponse.text();
        const code = await codeResponse.text();

        // Create a new conversation with helpful title and system prompt
        const systemPrompt = `You are a helpful assistant for the Claude Chat UI application.

The user's first message contains the COMPLETE and UP-TO-DATE documentation (CAPABILITIES.md) and backend code for this application. This is the current state of the application.

Your role:
- Help users understand how to use the application features
- Answer questions about capabilities, settings, projects, agent mode, workspace, etc.
- Explain how the code works when asked technical questions
- Provide clear, concise answers with examples

IMPORTANT: ONLY reference features that are explicitly documented in the provided CAPABILITIES.md or visible in the provided backend code. If a feature is not mentioned in the documentation or code that was provided to you, do NOT suggest it exists. If you're unsure whether a feature exists, clearly state that you don't see it in the documentation.

Be friendly, clear, and helpful!`;

        // Create conversation with proper parameters
        const conversation = await ConversationsManager.createConversation(
            '❓ Help: How to Use This App',
            true, // clearUI
            false // isAgent
        );

        // Update conversation with system prompt
        await fetch(`/api/conversations/${conversation.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                system_prompt: systemPrompt
            })
        });

        // Switch to the new conversation
        await ConversationsManager.selectConversation(conversation.id);

        // Add documentation and code as the first user message (hidden from UI)
        const contextMessage = `Here is the complete, up-to-date documentation and code for the Claude Chat UI application:

# CAPABILITIES.md

${capabilities}

# Backend Code

${code}`;

        // Save the context message to the backend
        const response = await fetch(`/api/conversations/${conversation.id}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                role: 'user',
                content: contextMessage,
                branch: [0]
            })
        });

        if (!response.ok) {
            throw new Error('Failed to save context message');
        }

        // Add a welcome message from the assistant
        if (typeof ChatManager !== 'undefined') {
            const welcomeMessage = `# Welcome to Help Chat! 👋

I'm here to help you learn how to use Claude Chat UI. I have access to the complete, up-to-date documentation and backend code for this application.

I can answer questions about:

## Features & Usage 🎯
- **Projects** - How to organize conversations
- **Agent Chat** - Using the workspace and tools
- **Settings** - Customizing models, temperature, and more
- **Conversation Branching** - Editing and retrying messages
- **File Attachments** - Uploading and working with files
- **Extended Thinking** - Using deep reasoning mode
- **Keyboard Shortcuts** - Faster navigation

## Technical Questions 🔧
- How the streaming works
- Backend architecture and APIs
- Storage systems (SQLite vs JSON)
- Project memory system
- How features are implemented

## Examples:
- "How do I create a project?"
- "What can agent chat do with files?"
- "How does conversation branching work?"
- "How is streaming implemented in the backend?"
- "What keyboard shortcuts are available?"

**Just ask me anything!** 😊`;

            // Add context message to local state (hidden)
            ChatManager.messages.push({
                id: 'help-context',
                role: 'user',
                content: contextMessage,
                position: 0,
                version: 1,
                total_versions: 1,
                hidden: true // Mark as hidden so it doesn't render
            });

            // Add welcome message to local state
            ChatManager.messages.push({
                id: 'help-welcome',
                role: 'assistant',
                content: welcomeMessage,
                position: 1,
                version: 1,
                total_versions: 1
            });

            // Only render the welcome message (not the context)
            ChatManager.renderMessage({
                id: 'help-welcome',
                role: 'assistant',
                content: welcomeMessage,
                position: 1,
                version: 1,
                total_versions: 1
            });

            // Hide welcome message
            document.getElementById('welcome-message').style.display = 'none';
            ChatManager.updateContextStats();
        }

        console.log('Help chat created successfully with documentation context');

    } catch (error) {
        console.error('Failed to create help chat:', error);
        alert('Failed to create help chat: ' + error.message);
    }
}

// Handle page visibility changes to stop streaming if hidden
document.addEventListener('visibilitychange', () => {
    if (document.hidden && ChatManager.isStreaming) {
        // Optionally stop streaming when tab is hidden
        // ChatManager.stopStreaming();
    }
});

// Handle keyboard shortcuts
document.addEventListener('keydown', (e) => {
    // Escape to close settings panel or project settings modal
    if (e.key === 'Escape') {
        if (typeof ProjectSettingsManager !== 'undefined' && ProjectSettingsManager.isOpen) {
            ProjectSettingsManager.close();
        } else if (SettingsManager.isOpen) {
            SettingsManager.togglePanel();
        }
    }

    // Ctrl/Cmd + N for new chat
    if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
        e.preventDefault();
        ConversationsManager.createConversation();
    }

    // Ctrl/Cmd + , for settings
    if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault();
        SettingsManager.togglePanel();
    }

    // Arrow Up - Navigate to previous message
    if (e.key === 'ArrowUp' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        const messageInput = document.getElementById('message-input');
        const activeElement = document.activeElement;

        // Only trigger if not typing in textarea, or if at the start of textarea
        if (activeElement !== messageInput || (messageInput.selectionStart === 0 && messageInput.selectionEnd === 0)) {
            const container = document.getElementById('messages-container');
            const messages = Array.from(container.querySelectorAll('.message'));

            if (messages.length > 0) {
                // If at bottom (-1), go to last message
                if (currentMessageIndex === -1) {
                    currentMessageIndex = messages.length - 1;
                } else if (currentMessageIndex > 0) {
                    // Go to previous message
                    currentMessageIndex--;
                }

                const targetMessage = messages[currentMessageIndex];
                const scrollTop = targetMessage.offsetTop - 80; // 80px offset to show slightly above

                container.scrollTo({
                    top: scrollTop,
                    behavior: 'smooth'
                });
                e.preventDefault();
            }
        }
    }

    // Arrow Down - Navigate to next message or bottom
    if (e.key === 'ArrowDown' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        const messageInput = document.getElementById('message-input');
        const activeElement = document.activeElement;

        // Only trigger if not typing in textarea, or if at the end of textarea
        const isAtEnd = messageInput.selectionStart === messageInput.value.length &&
                        messageInput.selectionEnd === messageInput.value.length;

        if (activeElement !== messageInput || isAtEnd) {
            const container = document.getElementById('messages-container');
            const messages = Array.from(container.querySelectorAll('.message'));

            if (currentMessageIndex === -1) {
                // Already at bottom, do nothing or scroll to bottom again
                container.scrollTo({
                    top: container.scrollHeight,
                    behavior: 'smooth'
                });
            } else if (currentMessageIndex < messages.length - 1) {
                // Go to next message
                currentMessageIndex++;
                const targetMessage = messages[currentMessageIndex];
                const scrollTop = targetMessage.offsetTop - 80; // 80px offset

                container.scrollTo({
                    top: scrollTop,
                    behavior: 'smooth'
                });
            } else {
                // At last message, go to bottom
                currentMessageIndex = -1;
                container.scrollTo({
                    top: container.scrollHeight,
                    behavior: 'smooth'
                });

                // Focus the input
                messageInput.focus();
            }
            e.preventDefault();
        }
    }
});

// Reset message index when user manually scrolls
document.addEventListener('DOMContentLoaded', () => {
    const container = document.getElementById('messages-container');
    if (container) {
        let scrollTimeout;
        container.addEventListener('scroll', () => {
            // Reset index if user manually scrolls near the bottom
            clearTimeout(scrollTimeout);
            scrollTimeout = setTimeout(() => {
                const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 150;
                if (isNearBottom) {
                    currentMessageIndex = -1;
                }
            }, 150);
        });
    }
});

// Warn before closing if streaming
window.addEventListener('beforeunload', (e) => {
    if (ChatManager.isStreaming) {
        e.preventDefault();
        e.returnValue = '';
    }
});

// Sidebar resize functionality with snap-to-close
document.addEventListener('DOMContentLoaded', () => {
    const sidebar = document.getElementById('sidebar');
    const resizeHandle = document.getElementById('sidebar-resize-handle');

    if (!sidebar || !resizeHandle) return;

    const MIN_WIDTH = 180;
    const MAX_WIDTH = 500;
    const SNAP_THRESHOLD = 80; // Below this, snap to closed

    let isResizing = false;
    let startX = 0;
    let startWidth = 0;
    let wasCollapsed = false;

    const collapseSidebar = () => {
        sidebar.classList.add('collapsed');
        sidebar.style.width = '0px';
        localStorage.setItem('sidebarCollapsed', 'true');
        localStorage.removeItem('sidebarWidth');
    };

    const expandSidebar = (width = MIN_WIDTH) => {
        sidebar.classList.remove('collapsed');
        sidebar.style.width = width + 'px';
        localStorage.setItem('sidebarCollapsed', 'false');
        localStorage.setItem('sidebarWidth', width);
    };

    resizeHandle.addEventListener('mousedown', (e) => {
        isResizing = true;
        startX = e.clientX;
        wasCollapsed = sidebar.classList.contains('collapsed');
        // If collapsed, treat starting width as 0 for calculations
        startWidth = wasCollapsed ? 0 : sidebar.offsetWidth;
        // Temporarily expand if collapsed so we can see the drag
        if (wasCollapsed) {
            sidebar.classList.remove('collapsed');
        }
        resizeHandle.classList.add('dragging');
        document.body.classList.add('sidebar-resizing');
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;

        // Calculate new width based on mouse position (use absolute X position)
        let newWidth = e.clientX;

        // Visual feedback during drag
        if (newWidth < SNAP_THRESHOLD) {
            // Show collapsed state preview
            sidebar.classList.add('collapsed');
            sidebar.style.width = '0px';
        } else {
            // Show normal state - clamp between min and max
            sidebar.classList.remove('collapsed');
            sidebar.style.width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, newWidth)) + 'px';
        }
    });

    document.addEventListener('mouseup', () => {
        if (isResizing) {
            isResizing = false;
            resizeHandle.classList.remove('dragging');
            document.body.classList.remove('sidebar-resizing');

            // Determine final state based on current width
            const currentWidth = sidebar.offsetWidth;

            if (sidebar.classList.contains('collapsed') || currentWidth < SNAP_THRESHOLD) {
                // Snap to closed
                collapseSidebar();
            } else {
                // Save normal width
                const finalWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, currentWidth));
                expandSidebar(finalWidth);
            }
        }
    });

    // Double-click on handle to toggle
    resizeHandle.addEventListener('dblclick', () => {
        if (sidebar.classList.contains('collapsed')) {
            const savedWidth = localStorage.getItem('sidebarWidth');
            expandSidebar(savedWidth ? parseInt(savedWidth, 10) : MIN_WIDTH);
        } else {
            collapseSidebar();
        }
    });

    // Keyboard shortcut: Cmd+B (Mac) / Ctrl+B (Windows/Linux) to toggle sidebar
    document.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
            e.preventDefault();
            if (sidebar.classList.contains('collapsed')) {
                const savedWidth = localStorage.getItem('sidebarWidth');
                expandSidebar(savedWidth ? parseInt(savedWidth, 10) : MIN_WIDTH);
            } else {
                collapseSidebar();
            }
        }
    });

    // Restore saved state
    const isCollapsed = localStorage.getItem('sidebarCollapsed') === 'true';
    if (isCollapsed) {
        collapseSidebar();
    } else {
        const savedWidth = localStorage.getItem('sidebarWidth');
        if (savedWidth) {
            const width = parseInt(savedWidth, 10);
            if (width >= MIN_WIDTH && width <= MAX_WIDTH) {
                sidebar.style.width = width + 'px';
            }
        }
    }
});

```

---

### `static/js/background-streams.js`

**Purpose:** Handles background streaming for agent tasks

```javascript
/**
 * Streaming State Tracker
 * Simple tracking of which conversations are streaming (based on server state)
 */

const StreamingTracker = {
    // Set of conversation IDs that are streaming
    streamingConversations: new Set(),

    /**
     * Mark a conversation as streaming
     */
    setStreaming(conversationId, isStreaming) {
        if (isStreaming) {
            this.streamingConversations.add(conversationId);
        } else {
            this.streamingConversations.delete(conversationId);
        }
        this.updateStreamingIndicators();
    },

    /**
     * Check if a conversation is streaming
     */
    isStreaming(conversationId) {
        return this.streamingConversations.has(conversationId);
    },

    /**
     * Check streaming status from server
     */
    async checkServerStatus(conversationId) {
        try {
            const response = await fetch(`/api/chat/streaming/${conversationId}`);
            const data = await response.json();
            console.log('[StreamingTracker] Server status for', conversationId, ':', data);
            this.setStreaming(conversationId, data.streaming);
            return Boolean(data.streaming);
        } catch (e) {
            console.error('[StreamingTracker] Error checking status:', e);
            return false;
        }
    },

    /**
     * Update visual indicators in conversation list
     */
    updateStreamingIndicators() {
        const items = document.querySelectorAll('.conversation-item');
        items.forEach(item => {
            const id = item.dataset.id;
            const existingIndicator = item.querySelector('.streaming-dot');

            if (this.isStreaming(id)) {
                if (!existingIndicator) {
                    const dot = document.createElement('span');
                    dot.className = 'streaming-dot';
                    dot.title = 'Generating response...';
                    const titleEl = item.querySelector('.conversation-title');
                    if (titleEl) {
                        titleEl.prepend(dot);
                    }
                }
            } else {
                if (existingIndicator) {
                    existingIndicator.remove();
                }
            }
        });
    }
};

// Alias for backward compatibility
const BackgroundStreams = StreamingTracker;

```

---

### `static/js/chat.js`

**Purpose:** Chat UI functionality - message rendering, sending, streaming responses

```javascript
/**
 * Chat and streaming module with file-based branching support
 */

const ChatManager = {
    messages: [],  // Array of {role, content, position, version, total_versions, user_msg_index}
    currentBranch: [0],  // Current branch array
    isStreaming: false,
    isAgentConversation: false,  // Whether current conversation uses agent SDK
    agentSessionId: null,  // Session ID for agent SDK conversation resumption
    abortController: null,
    editingPosition: null,
    originalEditContent: null,  // Original content when editing
    retryPosition: null,  // Position for retry operations
    lastPrunedCount: 0,  // Track number of pruned messages
    activeConversationId: null,  // Track which conversation is currently displayed
    streamingMessageEl: null,  // Reference to current streaming message element
    streamingMessageId: null,  // ID of message being streamed (for DB updates)
    pollInterval: null,  // Interval for polling streaming updates
    lastStreamingText: '',  // Track last known streaming text for smooth updates
    streamingTextQueue: '',  // Queue of text waiting to be revealed
    streamingDisplayedText: '',  // Text currently displayed during animated streaming
    streamingAnimationFrame: null,  // Animation frame for smooth text reveal
    userScrolledAway: false,  // Track if user has scrolled away during streaming
    lastTabRefresh: 0,  // Timestamp of last tab refresh to debounce
    toolBlocks: {},  // Map of tool_use_id to DOM elements for agent chats

    // Model context limits (in tokens)
    MODEL_LIMITS: {
        'claude-3-5-sonnet-20241022': 200000,
        'claude-3-5-haiku-20241022': 200000,
        'claude-3-opus-20240229': 200000,
        'claude-3-sonnet-20240229': 200000,
        'claude-3-haiku-20240307': 200000
    },

    /**
     * Initialize chat
     */
    init() {
        this.bindEvents();
        this.configureMarked();
        this.bindTabVisibility();
    },

    /**
     * Handle tab visibility changes - refresh state when tab becomes visible
     */
    bindTabVisibility() {
        document.addEventListener('visibilitychange', async () => {
            if (document.visibilityState === 'visible') {
                await this.refreshOnTabFocus();
            }
        });

        // Also handle window focus for cases where visibilitychange doesn't fire
        window.addEventListener('focus', async () => {
            await this.refreshOnTabFocus();
        });
    },

    /**
     * Refresh conversation state when returning to tab
     */
    async refreshOnTabFocus() {
        // Debounce: don't refresh more than once per second
        const now = Date.now();
        if (now - this.lastTabRefresh < 1000) {
            return;
        }
        this.lastTabRefresh = now;

        // Don't refresh if we're actively streaming locally (would interrupt SSE)
        if (this.abortController) {
            return;
        }

        // Refresh conversation list
        if (typeof ConversationsManager !== 'undefined') {
            await ConversationsManager.loadConversations();
        }

        // Reload current conversation if one is selected
        const currentId = this.activeConversationId;
        if (currentId) {
            try {
                // Check streaming status on server
                const streamingResponse = await fetch(`/api/chat/streaming/${currentId}`);
                const streamingData = await streamingResponse.json();

                // Reload conversation from DB with current branch
                const branchParam = this.currentBranch.join(',');
                const convResponse = await fetch(`/api/conversations/${currentId}?branch=${branchParam}`);
                if (convResponse.ok) {
                    const conversation = await convResponse.json();

                    // Update streaming tracker
                    if (typeof StreamingTracker !== 'undefined') {
                        StreamingTracker.setStreaming(currentId, streamingData.streaming);
                    }

                    // Reload the conversation UI
                    await this.loadConversation(conversation);
                }
            } catch (e) {
                console.error('Error refreshing on tab focus:', e);
            }
        }
    },

    /**
     * Configure marked.js for markdown rendering
     */
    configureMarked() {
        if (typeof marked !== 'undefined') {
            marked.setOptions({
                highlight: function(code, lang) {
                    if (typeof hljs !== 'undefined' && lang && hljs.getLanguage(lang)) {
                        try {
                            return hljs.highlight(code, { language: lang }).value;
                        } catch (e) {}
                    }
                    if (typeof hljs !== 'undefined') {
                        try {
                            return hljs.highlightAuto(code).value;
                        } catch (e) {}
                    }
                    return code;
                },
                breaks: true,
                gfm: true
            });
        }
    },

    /**
     * Bind DOM events
     */
    bindEvents() {
        const messageInput = document.getElementById('message-input');
        const sendBtn = document.getElementById('send-btn');

        messageInput.addEventListener('input', () => {
            this.autoResizeTextarea(messageInput);
            this.updateSendButton();
        });

        sendBtn.addEventListener('click', () => {
            this.sendMessage();
        });

        // Stop button for agent chats
        const stopBtn = document.getElementById('stop-btn');
        if (stopBtn) {
            stopBtn.addEventListener('click', () => {
                this.stopAgentStream();
            });
        }

        messageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.sendMessage();
            } else if (e.key === 'Enter' && e.shiftKey) {
                // Auto-continue bullet points on Shift+Enter
                const cursorPos = messageInput.selectionStart;
                const text = messageInput.value;
                const lineStart = text.lastIndexOf('\n', cursorPos - 1) + 1;
                const currentLine = text.substring(lineStart, cursorPos);

                // Check for bullet patterns: "- ", "* ", "1. ", "2. " etc.
                const bulletMatch = currentLine.match(/^(\s*)([-*]|\d+\.)\s/);
                if (bulletMatch) {
                    e.preventDefault();
                    const indent = bulletMatch[1];
                    const bullet = bulletMatch[2];

                    // If line only has the bullet (empty item), remove it
                    if (currentLine.trim() === bullet) {
                        // Remove the bullet line
                        messageInput.value = text.substring(0, lineStart) + text.substring(cursorPos);
                        messageInput.selectionStart = messageInput.selectionEnd = lineStart;
                    } else {
                        // Increment numbered list, or keep same bullet
                        let nextBullet = bullet;
                        const numMatch = bullet.match(/^(\d+)\.$/);
                        if (numMatch) {
                            nextBullet = (parseInt(numMatch[1], 10) + 1) + '.';
                        }
                        const insertion = '\n' + indent + nextBullet + ' ';
                        messageInput.value = text.substring(0, cursorPos) + insertion + text.substring(cursorPos);
                        const newPos = cursorPos + insertion.length;
                        messageInput.selectionStart = messageInput.selectionEnd = newPos;
                    }
                    this.autoResizeTextarea(messageInput);
                }
            }
        });

        // Copy entire conversation button
        const copyConversationBtn = document.getElementById('copy-conversation-btn');
        if (copyConversationBtn) {
            copyConversationBtn.addEventListener('click', () => {
                this.copyEntireConversation();
            });
        }

        // Track user scroll behavior during streaming
        const messagesContainer = document.getElementById('messages-container');
        messagesContainer.addEventListener('scroll', () => {
            if (!this.isStreaming) return;

            const container = messagesContainer;
            const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;

            // If user scrolled more than 50px from bottom, they've scrolled away
            if (distanceFromBottom > 50) {
                this.userScrolledAway = true;
            } else {
                // User scrolled back to bottom
                this.userScrolledAway = false;
            }
        });
    },

    autoResizeTextarea(textarea) {
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
    },

    updateSendButton() {
        const messageInput = document.getElementById('message-input');
        const sendBtn = document.getElementById('send-btn');
        const stopBtn = document.getElementById('stop-btn');
        const hasContent = messageInput.value.trim() || FilesManager.hasPendingFiles();
        sendBtn.disabled = !hasContent || this.isStreaming;

        // Show stop button only during agent streaming
        if (stopBtn) {
            if (this.isStreaming && this.isAgentConversation) {
                stopBtn.style.display = 'inline-block';
                sendBtn.style.display = 'none';
            } else {
                stopBtn.style.display = 'none';
                sendBtn.style.display = 'inline-block';
            }
        }
    },

    /**
     * Stop an active agent stream
     */
    async stopAgentStream() {
        const conversationId = ConversationsManager?.getCurrentConversationId();
        if (!conversationId || !this.isAgentConversation) {
            return;
        }

        try {
            // First abort the local fetch
            if (this.abortController) {
                this.abortController.abort();
            }

            // Then signal the backend to stop
            const response = await fetch(`/api/agent-chat/stop/${conversationId}`, {
                method: 'POST'
            });
            const result = await response.json();
            console.log('Stop agent stream result:', result);
        } catch (error) {
            console.error('Error stopping agent stream:', error);
        }
    },

    /**
     * Estimate token count for content (rough approximation: ~4 chars per token)
     */
    estimateTokens(content) {
        if (typeof content === 'string') {
            return Math.ceil(content.length / 4);
        } else if (Array.isArray(content)) {
            let total = 0;
            for (const block of content) {
                if (block.type === 'text') {
                    total += Math.ceil((block.text || '').length / 4);
                } else if (block.type === 'image') {
                    // Images: rough estimate based on size, ~1000 tokens for base64 images
                    total += 1000;
                } else if (block.type === 'document') {
                    // Documents: estimate based on content
                    total += 500;
                }
            }
            return total;
        }
        return 0;
    },

    /**
     * Get context limit for current model
     */
    getContextLimit() {
        const settings = SettingsManager?.getSettings() || {};
        return this.MODEL_LIMITS[settings.model] || 200000;
    },

    /**
     * Prune messages to keep context under threshold
     */
    pruneMessages(messages) {
        const settings = SettingsManager?.getSettings() || {};
        const pruneThreshold = settings.prune_threshold || 0.7;
        const contextLimit = this.getContextLimit();
        const maxTokens = Math.floor(contextLimit * pruneThreshold);

        // Calculate total tokens
        let totalTokens = 0;
        for (const msg of messages) {
            totalTokens += this.estimateTokens(msg.content);
        }

        // If under limit, no pruning needed
        if (totalTokens <= maxTokens) {
            return messages;
        }

        // Prune from the beginning, but keep at least the last 2 messages (user + assistant)
        const prunedMessages = [];
        let currentTokens = 0;

        // Start from the end and work backwards
        for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            const msgTokens = this.estimateTokens(msg.content);

            if (currentTokens + msgTokens <= maxTokens || prunedMessages.length < 2) {
                prunedMessages.unshift(msg);
                currentTokens += msgTokens;
            } else {
                // Stop adding messages - we've hit the limit
                break;
            }
        }

        const prunedCount = messages.length - prunedMessages.length;
        this.lastPrunedCount = prunedCount;

        if (prunedCount > 0) {
            const settings = SettingsManager?.getSettings() || {};
            const pruneThreshold = settings.prune_threshold || 0.7;
            console.log(`Pruned ${prunedCount} message(s) to keep context under ${pruneThreshold * 100}% (${totalTokens} -> ${currentTokens} tokens)`);
        }

        return prunedMessages;
    },

    /**
     * Load a conversation and its messages
     */
    async loadConversation(conversation) {
        console.log('[loadConversation] Starting load for:', conversation.id, 'Active ID:', this.activeConversationId);

        // Verify this is still the conversation we want to load
        if (this.activeConversationId !== conversation.id) {
            console.log('[loadConversation] SKIPPED - activeConversationId changed from', conversation.id, 'to', this.activeConversationId);
            return;
        }

        // Stop any existing polling
        this.stopPolling();

        this.messages = [];
        this.currentBranch = conversation.current_branch || [0];
        this.isAgentConversation = conversation.is_agent || false;
        this.agentSessionId = conversation.session_id || null;  // For agent SDK resumption
        this.toolBlocks = {};
        this.clearMessagesUI();

        // Update settings mode based on conversation type
        if (typeof SettingsManager !== 'undefined') {
            SettingsManager.setMode(this.isAgentConversation ? 'agent' : 'normal');
        }

        // Update workspace visibility
        if (typeof WorkspaceManager !== 'undefined') {
            WorkspaceManager.updateVisibility(this.isAgentConversation);
            WorkspaceManager.setConversation(conversation.id);
        }
        this.streamingMessageEl = null;
        this.streamingMessageId = null;

        // Check if this conversation is streaming on the server FIRST
        let isStreamingActive = false;
        if (typeof StreamingTracker !== 'undefined') {
            isStreamingActive = await StreamingTracker.checkServerStatus(conversation.id);
            this.isStreaming = isStreamingActive;
            console.log('[loadConversation] Streaming active:', isStreamingActive, 'Messages count:', conversation.messages?.length);
        }

        if (conversation.messages && conversation.messages.length > 0) {
            console.log('[loadConversation] Branch:', conversation.current_branch, 'Message count:', conversation.messages.length);
            console.log('[loadConversation] Rendering messages:', conversation.messages.map(m => ({
                role: m.role,
                position: m.position,
                contentLength: typeof m.content === 'string' ? m.content.length : 'array',
                content: typeof m.content === 'string' ? m.content.substring(0, 100) : m.content,
                id: m.id
            })));
            document.getElementById('welcome-message').style.display = 'none';

            // First, populate all messages with IDs for parent tracking
            conversation.messages.forEach(msg => {
                this.messages.push({
                    id: msg.id,
                    role: msg.role,
                    content: msg.content,
                    tool_results: msg.tool_results,
                    position: msg.position,
                    version: msg.current_version || msg.version || 1,
                    total_versions: msg.total_versions || 1,
                    user_msg_index: msg.user_msg_index
                });
            });

            // Then render all messages
            conversation.messages.forEach(msg => {
                this.renderMessage({
                    id: msg.id,
                    role: msg.role,
                    content: msg.content,
                    thinking: msg.thinking,
                    tool_results: msg.tool_results,
                    position: msg.position,
                    version: msg.current_version || msg.version || 1,
                    total_versions: msg.total_versions || 1,
                    user_msg_index: msg.user_msg_index
                });
            });

            // Force scroll to bottom when loading a conversation
            this.scrollToBottom(true);
            this.updateContextStats();
        } else if (!isStreamingActive) {
            // Only show welcome message if NOT streaming (streaming might have in-progress message)
            const welcomeEl = document.getElementById('welcome-message');
            welcomeEl.innerHTML = this.getWelcomeMessage();
            welcomeEl.style.display = '';
        }

        // Set up streaming if active
        if (isStreamingActive) {
            // Initialize streaming state with current content for smooth animation
            if (conversation.messages && conversation.messages.length > 0) {
                const lastMsg = conversation.messages[conversation.messages.length - 1];
                if (lastMsg.role === 'assistant') {
                    this.lastStreamingText = lastMsg.content || '';
                    this.streamingDisplayedText = lastMsg.content || '';
                    this.streamingTextQueue = '';
                }
            }
            this.startPolling(conversation.id);
        } else {
            this.lastStreamingText = '';
            this.stopStreamingAnimation();
            this.isStreaming = false;
        }

        this.updateSendButton();
    },

    /**
     * Start polling for streaming updates
     */
    startPolling(conversationId) {
        this.stopPolling();  // Clear any existing interval

        this.isStreaming = true;
        this.updateSendButton();

        // Poll every 500ms for updates
        this.pollInterval = setInterval(async () => {
            if (this.activeConversationId !== conversationId) {
                this.stopPolling();
                return;
            }

            try {
                // Check if still streaming
                const streamingResponse = await fetch(`/api/chat/streaming/${conversationId}`);
                const streamingData = await streamingResponse.json();

                if (!streamingData.streaming) {
                    // Streaming finished, reload conversation to get final content
                    this.stopPolling();
                    if (typeof StreamingTracker !== 'undefined') {
                        StreamingTracker.setStreaming(conversationId, false);
                    }

                    // Reload the conversation from DB with current branch
                    const branchParam = this.currentBranch.join(',');
                    const convResponse = await fetch(`/api/conversations/${conversationId}?branch=${branchParam}`);
                    const conversation = await convResponse.json();

                    if (this.activeConversationId === conversationId) {
                        this.loadConversation(conversation);
                    }
                    return;
                }

                // Still streaming - reload to get latest content
                const branchParam = this.currentBranch.join(',');
                const convResponse = await fetch(`/api/conversations/${conversationId}?branch=${branchParam}`);
                const conversation = await convResponse.json();

                if (this.activeConversationId === conversationId) {
                    this.updateFromConversation(conversation);
                }
            } catch (e) {
                console.error('Polling error:', e);
            }
        }, 500);
    },

    /**
     * Stop polling for updates
     */
    stopPolling() {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
    },

    /**
     * Update UI from conversation data (used during polling)
     */
    updateFromConversation(conversation) {
        console.log('[updateFromConversation] Messages:', conversation.messages?.length, 'Last message content length:', conversation.messages?.[conversation.messages.length - 1]?.content?.length);
        if (!conversation.messages || conversation.messages.length === 0) return;

        const container = document.getElementById('messages-container');
        const lastMsg = conversation.messages[conversation.messages.length - 1];

        // Find or create the message element
        let messageEl = container.querySelector(`.message[data-position="${lastMsg.position}"]`);

        if (!messageEl && lastMsg.role === 'assistant') {
            // Create new message element
            messageEl = this.createMessageElement('assistant', lastMsg.position, 1, 1);
            container.appendChild(messageEl);
            document.getElementById('welcome-message').style.display = 'none';
        }

        if (messageEl && lastMsg.role === 'assistant') {
            const contentEl = messageEl.querySelector('.message-content');

            // Add streaming indicator if streaming
            let indicator = contentEl.querySelector('.streaming-indicator');
            if (!indicator && this.isStreaming) {
                indicator = document.createElement('span');
                indicator.className = 'streaming-indicator';
            }

            // Update thinking block if present
            if (lastMsg.thinking) {
                let thinkingEl = contentEl.querySelector('.thinking-block');
                if (!thinkingEl) {
                    thinkingEl = this.createThinkingBlock();
                    contentEl.insertBefore(thinkingEl, contentEl.firstChild);
                }
                this.updateThinkingBlock(thinkingEl, lastMsg.thinking);
            }

            // Update text content with smooth streaming
            if (lastMsg.content) {
                // For streaming, use incremental updates
                if (this.isStreaming) {
                    this.updateStreamingContent(contentEl, lastMsg.content, indicator);
                } else {
                    this.updateMessageContent(contentEl, lastMsg.content, indicator);
                }
            }

            this.scrollToBottom();
        }

        // Update messages array
        this.messages = conversation.messages.map(msg => ({
            id: msg.id,
            role: msg.role,
            content: msg.content,
            position: msg.position,
            version: msg.current_version || msg.version || 1,
            total_versions: msg.total_versions || 1,
            user_msg_index: msg.user_msg_index
        }));

        this.updateContextStats();
    },

    /**
     * Update streaming content smoothly with animated character reveal
     * When polling returns chunks of text, we animate them character by character
     */
    updateStreamingContent(contentEl, newText, indicator) {
        // If new text is an extension of what we know about, queue the new chars
        const oldText = this.lastStreamingText || '';

        if (newText.length > oldText.length && newText.startsWith(oldText)) {
            // Queue the new characters for animated reveal
            const newChars = newText.slice(oldText.length);
            this.streamingTextQueue += newChars;
            this.lastStreamingText = newText;
        } else if (newText !== oldText) {
            // Text changed differently - reset and show immediately
            this.streamingTextQueue = '';
            this.streamingDisplayedText = newText;
            this.lastStreamingText = newText;
            this.renderStreamingText(contentEl, newText, indicator);
            return;
        }

        // Start animation if not already running
        if (!this.streamingAnimationFrame && this.streamingTextQueue.length > 0) {
            this.animateStreamingText(contentEl, indicator);
        }
    },

    /**
     * Animate revealing queued text character by character
     */
    animateStreamingText(contentEl, indicator) {
        const charsPerFrame = 3;  // Reveal multiple chars per frame for speed
        const frameDelay = 16;    // ~60fps

        const animate = () => {
            if (this.streamingTextQueue.length === 0) {
                this.streamingAnimationFrame = null;
                return;
            }

            // Take chars from queue
            const chars = this.streamingTextQueue.slice(0, charsPerFrame);
            this.streamingTextQueue = this.streamingTextQueue.slice(charsPerFrame);
            this.streamingDisplayedText += chars;

            // Render current displayed text
            this.renderStreamingText(contentEl, this.streamingDisplayedText, indicator);

            // Continue animation
            this.streamingAnimationFrame = setTimeout(() => {
                requestAnimationFrame(() => animate());
            }, frameDelay);
        };

        this.streamingAnimationFrame = requestAnimationFrame(() => animate());
    },

    /**
     * Render the streaming text to the DOM
     */
    renderStreamingText(contentEl, text, indicator) {
        const thinkingBlock = contentEl.querySelector('.thinking-block');
        const wasExpanded = thinkingBlock?.classList.contains('expanded');

        // Get or create text container
        let textContainer = contentEl.querySelector('.message-text');
        if (!textContainer) {
            // Clear existing content (from renderMessage) but preserve thinking block
            // Remove all children except thinking block
            Array.from(contentEl.children).forEach(child => {
                if (!child.classList.contains('thinking-block') &&
                    !child.classList.contains('streaming-indicator')) {
                    child.remove();
                }
            });

            textContainer = document.createElement('div');
            textContainer.className = 'message-text';
            contentEl.appendChild(textContainer);
        }

        textContainer.innerHTML = this.formatText(text);
        this.addCodeCopyButtons(textContainer);
        textContainer.dataset.rawText = text;

        // Re-add thinking block at the beginning
        if (thinkingBlock) {
            contentEl.insertBefore(thinkingBlock, contentEl.firstChild);
            if (wasExpanded) {
                thinkingBlock.classList.add('expanded');
            }
        }

        // Ensure indicator is at end
        if (indicator && indicator.parentNode !== contentEl) {
            contentEl.appendChild(indicator);
        }

        // Note: Don't call scrollToBottom here - it's called too frequently
        // Let updateFromConversation handle scrolling at a reasonable rate
    },

    /**
     * Stop streaming text animation
     */
    stopStreamingAnimation() {
        if (this.streamingAnimationFrame) {
            cancelAnimationFrame(this.streamingAnimationFrame);
            clearTimeout(this.streamingAnimationFrame);
            this.streamingAnimationFrame = null;
        }
        this.streamingTextQueue = '';
        this.streamingDisplayedText = '';
    },

    clearChat() {
        this.stopPolling();
        this.stopStreamingAnimation();
        this.messages = [];
        this.currentBranch = [0];
        // Don't reset isAgentConversation here - let the caller set it appropriately
        this.clearMessagesUI();
        this.streamingMessageEl = null;
        this.streamingMessageId = null;
        this.isStreaming = false;
        this.agentSessionId = null;
        this.userScrolledAway = false;
        this.abortController = null;
        this.lastStreamingText = '';
        this.toolBlocks = {};
        document.getElementById('welcome-message').style.display = '';
        this.updateContextStats();
        this.updateSendButton();

        // Update workspace visibility
        if (typeof WorkspaceManager !== 'undefined') {
            WorkspaceManager.updateVisibility(this.isAgentConversation);
        }
    },

    /**
     * Prepare UI for a conversation switch - call this immediately when switching
     */
    prepareForConversationSwitch(newConversationId) {
        // Stop polling and animation for the old conversation
        this.stopPolling();
        this.stopStreamingAnimation();

        // Update active conversation ID immediately
        this.activeConversationId = newConversationId;

        // Clear UI immediately to prevent showing stale messages
        this.messages = [];
        this.currentBranch = [0];
        // Note: isAgentConversation should be set by caller before calling this
        this.clearMessagesUI();
        this.streamingMessageEl = null;
        this.streamingMessageId = null;
        this.lastStreamingText = '';
        this.toolBlocks = {};

        // Show loading state or welcome message
        document.getElementById('welcome-message').style.display = '';

        // Reset streaming state - will be updated when conversation loads
        this.isStreaming = false;
        // Don't reset isAgentConversation here - it's set by the caller
        this.agentSessionId = null;
        this.userScrolledAway = false;
        this.updateSendButton();
        this.updateContextStats();

        // Update workspace visibility based on conversation type
        if (typeof WorkspaceManager !== 'undefined') {
            WorkspaceManager.updateVisibility(this.isAgentConversation);
            WorkspaceManager.setConversation(newConversationId);
        }
    },

    clearMessagesUI() {
        const container = document.getElementById('messages-container');
        const welcomeHtml = this.getWelcomeMessage();
        container.innerHTML = `<div class="welcome-message" id="welcome-message" style="display: none;">${welcomeHtml}</div>`;
    },

    /**
     * Get welcome message based on conversation type
     */
    getWelcomeMessage() {
        if (this.isAgentConversation) {
            return `
                <h2>Welcome to Claude Agent Chat</h2>
                <p>This is an agentic conversation where Claude can:</p>
                <ul style="text-align: left; display: inline-block; margin-top: 10px;">
                    <li>Read and write files in your workspace</li>
                    <li>Execute bash commands</li>
                    <li>Search for GIFs to enhance responses</li>
                    <li>Maintain context across multiple turns</li>
                </ul>
                <p style="margin-top: 15px;">Start by asking Claude to help with coding tasks!</p>
            `;
        } else {
            return '<h2>Welcome to Claude Chat</h2><p>Start a conversation by typing a message below.</p>';
        }
    },

    /**
     * Handle slash commands for agent conversations
     * Returns true if command was handled, false otherwise
     */
    async handleSlashCommand(text) {
        if (!this.isAgentConversation || !text.startsWith('/')) {
            return false;
        }

        const parts = text.split(' ');
        const command = parts[0].toLowerCase();
        const args = parts.slice(1);

        switch (command) {
            case '/ls':
                // Show workspace files
                if (typeof WorkspaceManager !== 'undefined') {
                    WorkspaceManager.togglePanel();
                    if (!WorkspaceManager.isOpen) {
                        // If was closed, open it
                        WorkspaceManager.togglePanel();
                    }
                }
                return true;

            case '/delete':
                // Delete a file
                if (args.length === 0) {
                    this.showSystemMessage('Usage: /delete <filename>');
                    return true;
                }
                const filename = args.join(' ');
                if (typeof WorkspaceManager !== 'undefined') {
                    await WorkspaceManager.deleteFile(filename);
                }
                return true;

            default:
                return false;
        }
    },

    /**
     * Show system message in chat
     */
    showSystemMessage(text) {
        const container = document.getElementById('messages-container');
        const msgEl = document.createElement('div');
        msgEl.className = 'system-message';
        msgEl.textContent = text;
        msgEl.style.cssText = `
            padding: 8px 12px;
            margin: 8px auto;
            max-width: 600px;
            background-color: var(--color-bg);
            border: 1px solid var(--color-border);
            border-radius: 6px;
            color: var(--color-text-secondary);
            font-size: 13px;
            text-align: center;
        `;
        container.appendChild(msgEl);
        this.scrollToBottom(true);
    },

    /**
     * Send a new message
     */
    async sendMessage() {
        const messageInput = document.getElementById('message-input');
        const text = messageInput.value.trim();
        const fileBlocks = FilesManager.getContentBlocks();

        if (!text && fileBlocks.length === 0) return;
        if (this.isStreaming) return;

        // Handle slash commands for agent conversations
        if (await this.handleSlashCommand(text)) {
            messageInput.value = '';
            messageInput.style.height = 'auto';
            this.updateSendButton();
            return;
        }

        let content;
        if (fileBlocks.length > 0) {
            content = [...fileBlocks];
            if (text) {
                content.push({ type: 'text', text: text });
            }
        } else {
            content = text;
        }

        messageInput.value = '';
        messageInput.style.height = 'auto';
        FilesManager.clearPendingFiles();
        this.updateSendButton();

        let conversationId = ConversationsManager.getCurrentConversationId();
        if (!conversationId) {
            const conversation = await ConversationsManager.createConversation(
                ConversationsManager.generateTitle(content),
                false  // Don't clear UI - we're about to add the user's message
            );
            conversationId = conversation.id;
            // Set activeConversationId since createConversation didn't (clearUI=false)
            this.activeConversationId = conversationId;
            this.currentBranch = [0];
        } else if (this.messages.length === 0) {
            await ConversationsManager.updateConversationTitle(
                conversationId,
                ConversationsManager.generateTitle(content)
            );
        }

        document.getElementById('welcome-message').style.display = 'none';

        // Add user message to backend first to get ID
        const savedMsg = await ConversationsManager.addMessage('user', content, null, this.currentBranch);

        // Add user message to local state with ID
        const userMsg = {
            id: savedMsg?.id,
            role: 'user',
            content,
            position: savedMsg?.position ?? this.messages.length,
            version: 1,
            total_versions: 1
        };
        this.messages.push(userMsg);
        this.renderMessage(userMsg, true); // Force scroll to bottom for new message

        await this.streamResponse();
    },

    /**
     * Edit a message at a position - inline editing
     */
    async editMessage(position) {
        const msg = this.messages.find(m => m.position === position);
        if (!msg || msg.role !== 'user') return;
        if (this.isStreaming) return;
        if (this.editingPosition !== null) return; // Already editing

        // Get the text content
        let textContent = '';
        if (typeof msg.content === 'string') {
            textContent = msg.content;
        } else if (Array.isArray(msg.content)) {
            const textBlock = msg.content.find(b => b.type === 'text' && !b.text?.startsWith('File: '));
            textContent = textBlock?.text || '';
        }

        const container = document.getElementById('messages-container');
        const userMsgEl = container.querySelector(`.message.user[data-position="${position}"]`);
        if (!userMsgEl) return;

        const contentEl = userMsgEl.querySelector('.message-content');
        if (!contentEl) return;

        // Store original content and mark as editing
        this.editingPosition = position;
        this.originalEditContent = textContent;

        // Add editing class for expanded styling
        userMsgEl.classList.add('editing');

        // Replace content with editable textarea
        const textarea = document.createElement('textarea');
        textarea.className = 'edit-textarea';
        textarea.value = textContent;
        textarea.style.cssText = `
            width: 100%;
            min-height: 80px;
            padding: 12px;
            border: none;
            border-radius: 6px;
            background: transparent;
            color: var(--color-text);
            font-family: inherit;
            font-size: inherit;
            line-height: 1.5;
            resize: vertical;
            outline: none;
        `;

        // Create button container
        const buttonContainer = document.createElement('div');
        buttonContainer.className = 'edit-buttons';
        buttonContainer.style.cssText = `
            display: flex;
            gap: 8px;
            margin-top: 8px;
            justify-content: flex-end;
        `;

        const saveBtn = document.createElement('button');
        saveBtn.textContent = 'Save';
        saveBtn.className = 'edit-save-btn';
        saveBtn.style.cssText = `
            padding: 6px 12px;
            background: var(--color-primary);
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
            font-weight: 500;
        `;

        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        cancelBtn.className = 'edit-cancel-btn';
        cancelBtn.style.cssText = `
            padding: 6px 12px;
            background: var(--color-border);
            color: var(--color-text);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
        `;

        buttonContainer.appendChild(cancelBtn);
        buttonContainer.appendChild(saveBtn);

        // Clear content and add edit UI
        contentEl.innerHTML = '';
        contentEl.appendChild(textarea);
        contentEl.appendChild(buttonContainer);

        // Hide the action buttons while editing
        const actionsEl = userMsgEl.querySelector('.message-actions');
        if (actionsEl) actionsEl.style.display = 'none';

        // Focus and select text
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);

        // Auto-resize textarea
        const autoResize = () => {
            textarea.style.height = 'auto';
            textarea.style.height = Math.min(textarea.scrollHeight, 300) + 'px';
        };
        autoResize();
        textarea.addEventListener('input', autoResize);

        // Handle save
        const saveEdit = async () => {
            const newContent = textarea.value.trim();
            if (!newContent) {
                cancelEdit();
                return;
            }
            await this.confirmEdit(position, newContent);
        };

        // Handle cancel
        const cancelEdit = () => {
            this.cancelEdit(position);
        };

        // Event listeners
        saveBtn.addEventListener('click', saveEdit);
        cancelBtn.addEventListener('click', cancelEdit);

        textarea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                saveEdit();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                cancelEdit();
            }
        });
    },

    /**
     * Confirm and save the edit - creates a new branch
     */
    async confirmEdit(position, newContent) {
        if (this.editingPosition !== position) return;

        const conversationId = ConversationsManager.getCurrentConversationId();
        if (!conversationId) return;

        // Find the user message index for the edited position
        const msg = this.messages.find(m => m.position === position);
        const userMsgIndex = msg?.user_msg_index ?? Math.floor(position / 2);

        // Clear editing state
        this.editingPosition = null;
        this.originalEditContent = null;

        // Create new branch via API
        const response = await fetch(`/api/conversations/${conversationId}/edit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                user_msg_index: userMsgIndex,
                content: newContent,
                branch: this.currentBranch
            })
        });

        if (response.ok) {
            const result = await response.json();
            // Update current branch
            this.currentBranch = result.branch;

            // Reload conversation with new branch
            await ConversationsManager.selectConversation(conversationId, this.currentBranch);

            // Stream new response
            await this.streamResponse();
        }
    },

    /**
     * Cancel the edit and restore original content
     */
    cancelEdit(position) {
        if (this.editingPosition !== position) return;

        const container = document.getElementById('messages-container');
        const userMsgEl = container.querySelector(`.message.user[data-position="${position}"]`);

        if (userMsgEl) {
            // Remove editing class
            userMsgEl.classList.remove('editing');

            const contentEl = userMsgEl.querySelector('.message-content');
            if (contentEl) {
                contentEl.innerHTML = this.formatText(this.originalEditContent || '');
            }
            // Show action buttons again
            const actionsEl = userMsgEl.querySelector('.message-actions');
            if (actionsEl) actionsEl.style.display = '';
        }

        // Clear editing state
        this.editingPosition = null;
        this.originalEditContent = null;
    },

    /**
     * Copy message content to clipboard
     */
    async copyMessage(messageEl) {
        const contentEl = messageEl.querySelector('.message-content');
        if (!contentEl) return;

        // Extract text content, skipping thinking blocks
        let textToCopy = '';

        // Get all text nodes, but skip thinking content
        const thinkingBlock = contentEl.querySelector('.thinking-block');
        if (thinkingBlock) {
            // Clone the content element and remove thinking block from clone
            const clone = contentEl.cloneNode(true);
            const thinkingClone = clone.querySelector('.thinking-block');
            if (thinkingClone) thinkingClone.remove();
            textToCopy = clone.textContent.trim();
        } else {
            textToCopy = contentEl.textContent.trim();
        }

        if (!textToCopy) return;

        try {
            await navigator.clipboard.writeText(textToCopy);

            // Show visual feedback
            const copyBtn = messageEl.querySelector('.copy-btn');
            if (copyBtn) {
                const originalText = copyBtn.textContent;
                copyBtn.textContent = 'Copied';
                copyBtn.style.color = '#4CAF50';
                setTimeout(() => {
                    copyBtn.textContent = originalText;
                    copyBtn.style.color = '';
                }, 1000);
            }
        } catch (error) {
            console.error('Failed to copy:', error);
            alert('Failed to copy to clipboard');
        }
    },

    /**
     * Copy entire conversation to clipboard
     */
    async copyEntireConversation() {
        if (this.messages.length === 0) {
            return;
        }

        // Format all messages as text
        const formatted = this.messages.map(msg => {
            const role = msg.role === 'user' ? 'User' : 'Assistant';

            // Extract text content from message
            let content = '';
            if (typeof msg.content === 'string') {
                content = msg.content;
            } else if (Array.isArray(msg.content)) {
                // Get text blocks, excluding file metadata
                const textBlocks = msg.content.filter(b => b.type === 'text' && !b.text?.startsWith('File: '));
                content = textBlocks.map(b => b.text).join('\n');

                // If there are files, add a note
                const fileBlocks = msg.content.filter(b => b.type === 'image' || b.type === 'document');
                if (fileBlocks.length > 0) {
                    const fileNote = `[${fileBlocks.length} file${fileBlocks.length > 1 ? 's' : ''} attached]`;
                    content = fileNote + (content ? '\n' + content : '');
                }
            }

            return `${role}: ${content}`;
        }).join('\n\n');

        try {
            await navigator.clipboard.writeText(formatted);

            // Show visual feedback
            const copyBtn = document.getElementById('copy-conversation-btn');
            if (copyBtn) {
                // Clear any existing timeout to prevent race conditions
                if (copyBtn._copyTimeout) {
                    clearTimeout(copyBtn._copyTimeout);
                }
                copyBtn.textContent = 'Copied';
                copyBtn.style.color = '#4CAF50';
                copyBtn._copyTimeout = setTimeout(() => {
                    copyBtn.textContent = '📋';
                    copyBtn.style.color = '';
                    copyBtn._copyTimeout = null;
                }, 2000);
            }
        } catch (error) {
            console.error('Failed to copy conversation:', error);
            alert('Failed to copy conversation to clipboard');
        }
    },

    /**
     * Retry an assistant message (called from assistant message)
     */
    async retryMessage(assistantPosition) {
        if (this.isStreaming) return;

        const conversationId = ConversationsManager.getCurrentConversationId();
        if (!conversationId) return;

        // Remove messages from this position onwards in UI FIRST
        this.removeMessagesFromPosition(assistantPosition);

        // Force a repaint to ensure UI is cleared before streaming
        await new Promise(resolve => requestAnimationFrame(resolve));

        // Set retry position for the streaming handler
        this.retryPosition = assistantPosition;

        // Stream new response
        await this.streamResponse(true);

        // Reload conversation to ensure UI is in sync
        await ConversationsManager.selectConversation(conversationId, this.currentBranch);
    },

    /**
     * Switch to a different branch at a user message position
     */
    async switchVersion(position, direction) {
        const msg = this.messages.find(m => m.position === position);
        if (!msg || msg.total_versions <= 1) return;

        const conversationId = ConversationsManager.getCurrentConversationId();
        if (!conversationId) return;

        // Get the user_msg_index for this position
        const userMsgIndex = msg.user_msg_index ?? Math.floor(position / 2);

        // Call the switch-branch API
        const response = await fetch(`/api/conversations/${conversationId}/switch-branch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                user_msg_index: userMsgIndex,
                direction: direction,
                branch: this.currentBranch
            })
        });

        if (response.ok) {
            const result = await response.json();
            this.currentBranch = result.branch;

            // Reload with new branch
            await this.loadConversation(result.conversation);
        }
    },

    /**
     * Remove messages from UI starting at position
     */
    removeMessagesFromPosition(position) {
        const container = document.getElementById('messages-container');
        const messageEls = container.querySelectorAll('.message');

        messageEls.forEach(el => {
            const pos = parseInt(el.dataset.position);
            if (pos >= position) {
                el.remove();
            }
        });

        // Update internal messages array
        this.messages = this.messages.filter(m => m.position < position);
    },

    /**
     * Delete messages from a position onwards (inclusive)
     * This removes them from the backend storage as well
     */
    async deleteMessagesFrom(position) {
        if (this.isStreaming) return;

        const conversationId = ConversationsManager.getCurrentConversationId();
        if (!conversationId) return;

        console.log('Delete request - Position:', position, 'Total messages:', this.messages.length, 'Branch:', this.currentBranch);

        // Confirm deletion
        const msgCount = this.messages.filter(m => m.position >= position).length;
        if (!confirm(`Delete ${msgCount} message${msgCount > 1 ? 's' : ''}? This cannot be undone.`)) {
            return;
        }

        try {
            // Call API to delete messages
            const response = await fetch(`/api/conversations/${conversationId}/delete-from/${position}`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ branch: this.currentBranch })
            });

            console.log('Delete response status:', response.status);

            if (response.ok) {
                console.log('Delete successful, removing from UI');
                // Remove from UI
                this.removeMessagesFromPosition(position);
                this.updateContextStats();

                // Show welcome message if no messages left
                if (this.messages.length === 0) {
                    const welcomeEl = document.getElementById('welcome-message');
                    welcomeEl.innerHTML = this.getWelcomeMessage();
                    welcomeEl.style.display = '';
                }
            } else {
                const errorText = await response.text();
                console.error('Delete failed - Status:', response.status, 'Response:', errorText);
                try {
                    const error = JSON.parse(errorText);
                    alert(`Failed to delete messages: ${error.detail || 'Unknown error'}`);
                } catch (e) {
                    alert(`Failed to delete messages: ${errorText || response.status}`);
                }
            }
        } catch (error) {
            console.error('Delete exception:', error);
            alert(`Failed to delete messages: ${error.message}`);
        }
    },

    /**
     * Stream response from API
     * Backend saves streaming content directly to DB
     */
    async streamResponse(isRetry = false) {
        // Use agent streaming for agent conversations
        if (this.isAgentConversation) {
            return this.streamAgentResponse(isRetry);
        }

        this.isStreaming = true;
        this.lastStreamingText = '';  // Reset for fresh stream
        this.stopStreamingAnimation();  // Clear any pending animation
        this.userScrolledAway = false;  // Reset scroll tracking for new response
        this.updateSendButton();

        const conversationId = ConversationsManager.getCurrentConversationId();
        const settings = SettingsManager.getSettings();

        // Mark conversation as streaming
        if (typeof StreamingTracker !== 'undefined') {
            StreamingTracker.setStreaming(conversationId, true);
        }

        // Create assistant message element
        const position = this.messages.length;
        const messageEl = this.createMessageElement('assistant', position, 1, 1);
        const container = document.getElementById('messages-container');
        container.appendChild(messageEl);
        this.streamingMessageEl = messageEl;

        // Force scroll to bottom when starting a new response
        this.scrollToBottom(true);

        let thinkingContent = '';
        let textContent = '';
        let thinkingEl = null;

        const indicator = document.createElement('span');
        indicator.className = 'streaming-indicator';

        // Create abort controller for this stream
        const abortController = new AbortController();
        this.abortController = abortController;

        try {
            // Build messages for API
            const allMessages = this.messages.map(m => ({
                role: m.role,
                content: m.content
            }));

            // Debug: Log messages being sent
            console.log('[streamResponse] this.messages:', this.messages.map(m => ({ role: m.role, position: m.position, contentPreview: typeof m.content === 'string' ? m.content.substring(0, 50) : 'array' })));
            console.log('[streamResponse] allMessages for API:', allMessages.map(m => ({ role: m.role, contentPreview: typeof m.content === 'string' ? m.content.substring(0, 50) : 'array' })));

            // Prune messages to keep context under threshold
            const apiMessages = this.pruneMessages(allMessages);

            // Pass conversation_id and branch so backend can save streaming content to DB
            const response = await fetch('/api/chat/stream', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: apiMessages,
                    conversation_id: isRetry ? null : conversationId,  // Don't auto-save for retries
                    branch: isRetry ? null : this.currentBranch,
                    model: settings.model,
                    system_prompt: settings.system_prompt,
                    temperature: settings.temperature,
                    max_tokens: settings.max_tokens,
                    top_p: settings.top_p !== 1.0 ? settings.top_p : null,
                    top_k: settings.top_k > 0 ? settings.top_k : null,
                    thinking_enabled: settings.thinking_enabled,
                    thinking_budget: settings.thinking_budget,
                    web_search_enabled: settings.web_search_enabled || false,
                    web_search_max_uses: settings.web_search_max_uses || 5
                }),
                signal: abortController.signal
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            const contentEl = messageEl.querySelector('.message-content');
            contentEl.appendChild(indicator);

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const event = JSON.parse(line.slice(6));

                            if (event.type === 'message_id') {
                                // Backend created the message, store the ID
                                this.streamingMessageId = event.id;
                                messageEl.dataset.messageId = event.id;
                            } else if (event.type === 'thinking') {
                                thinkingContent += event.content;

                                // Only update UI if this conversation is still active and element is in DOM
                                if (this.activeConversationId === conversationId && document.contains(messageEl)) {
                                    if (!thinkingEl) {
                                        thinkingEl = this.createThinkingBlock();
                                        contentEl.insertBefore(thinkingEl, contentEl.firstChild);
                                    }
                                    this.updateThinkingBlock(thinkingEl, thinkingContent);
                                }
                            } else if (event.type === 'text') {
                                textContent += event.content;

                                // Only update UI if this conversation is still active and element is in DOM
                                if (this.activeConversationId === conversationId && document.contains(messageEl)) {
                                    this.updateMessageContent(contentEl, textContent, indicator);
                                }
                            } else if (event.type === 'web_search_start') {
                                // Web search started - show indicator
                                if (this.activeConversationId === conversationId && document.contains(messageEl)) {
                                    const searchBlock = this.createWebSearchBlock(event.id, event.name);
                                    contentEl.insertBefore(searchBlock, indicator);
                                    this.toolBlocks[event.id] = searchBlock;
                                }
                            } else if (event.type === 'web_search_query') {
                                // Web search query being streamed
                                if (this.activeConversationId === conversationId && document.contains(messageEl)) {
                                    const searchBlock = this.toolBlocks[event.id];
                                    if (searchBlock) {
                                        this.updateWebSearchQuery(searchBlock, event.partial_query);
                                    }
                                }
                            } else if (event.type === 'web_search_result') {
                                // Web search completed - show results
                                if (this.activeConversationId === conversationId && document.contains(messageEl)) {
                                    const searchBlock = this.toolBlocks[event.tool_use_id];
                                    if (searchBlock) {
                                        this.updateWebSearchBlock(searchBlock, event.results);
                                    }
                                }
                            } else if (event.type === 'error') {
                                if (this.activeConversationId === conversationId && document.contains(messageEl)) {
                                    this.showError(contentEl, event.content);
                                }
                            }
                        } catch (e) {}
                    }
                }

                // Only scroll if this conversation is still active and element is in DOM
                if (this.activeConversationId === conversationId && document.contains(messageEl)) {
                    this.scrollToBottom();
                }
            }

        } catch (error) {
            if (error.name !== 'AbortError') {
                console.error('Streaming error:', error);
                if (this.activeConversationId === conversationId && document.contains(messageEl)) {
                    const contentEl = messageEl.querySelector('.message-content');
                    this.showError(contentEl, error.message);
                }
            }
        } finally {
            // Mark streaming as complete
            if (typeof StreamingTracker !== 'undefined') {
                StreamingTracker.setStreaming(conversationId, false);
            }

            // Only update UI state if this conversation is still active
            if (this.activeConversationId === conversationId && document.contains(messageEl)) {
                const indicatorEl = messageEl.querySelector('.streaming-indicator');
                if (indicatorEl) indicatorEl.remove();

                this.isStreaming = false;
                this.abortController = null;
                this.streamingMessageEl = null;
                this.streamingMessageId = null;
                this.updateSendButton();
                this.updateContextStats();
            }

            // Handle saving for retry case
            if (textContent && conversationId && isRetry) {
                const retryPos = this.retryPosition;

                if (retryPos !== null) {
                    const retryResponse = await fetch(`/api/conversations/${conversationId}/retry`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            position: retryPos,
                            content: textContent,
                            thinking: thinkingContent || null,
                            branch: this.currentBranch
                        })
                    });

                    if (retryResponse.ok) {
                        const retryData = await retryResponse.json();

                        // Update UI only if this conversation is active
                        if (this.activeConversationId === conversationId) {
                            // Update local messages
                            this.messages = this.messages.filter(m => m.position !== retryPos);
                            this.messages.push({
                                id: retryData.id,
                                role: 'assistant',
                                content: textContent,
                                position: retryPos,
                                version: 1,
                                total_versions: 1
                            });

                            // Update the message element
                            if (document.contains(messageEl)) {
                                messageEl.dataset.position = retryPos;
                                messageEl.dataset.messageId = retryData.id;
                            }
                        }
                    }

                    this.retryPosition = null;
                }
            } else if (textContent && !isRetry) {
                // Non-retry: backend already saved during streaming, just update local state
                if (this.activeConversationId === conversationId) {
                    this.messages.push({
                        id: this.streamingMessageId,
                        role: 'assistant',
                        content: textContent,
                        position: position,
                        version: 1,
                        total_versions: 1
                    });
                }
            }

            // Clean up from BackgroundStreams
            if (typeof StreamingTracker !== 'undefined') {
                StreamingTracker.setStreaming(conversationId, false);
            }

            // Scroll if still on same conversation
            if (this.activeConversationId === conversationId) {
                this.scrollToBottom();
            }
        }
    },

    /**
     * Stream response from Agent API (Claude Agent SDK)
     */
    async streamAgentResponse(isRetry = false) {
        this.isStreaming = true;
        this.lastStreamingText = '';
        this.stopStreamingAnimation();
        this.userScrolledAway = false;
        this.toolBlocks = {};
        this.updateSendButton();

        const conversationId = ConversationsManager.getCurrentConversationId();
        const settings = SettingsManager.getSettings();

        // Mark conversation as streaming
        if (typeof StreamingTracker !== 'undefined') {
            StreamingTracker.setStreaming(conversationId, true);
        }

        // Create assistant message element
        const position = this.messages.length;
        const messageEl = this.createMessageElement('assistant', position, 1, 1);
        const container = document.getElementById('messages-container');
        container.appendChild(messageEl);
        this.streamingMessageEl = messageEl;

        // Force scroll to bottom when starting a new response
        this.scrollToBottom(true);

        const accumulatedContent = [];  // Content blocks in chronological order
        const toolResults = [];

        const indicator = document.createElement('span');
        indicator.className = 'streaming-indicator';

        // Track current text block for chronological rendering
        let currentTextBlock = null;
        let currentTextContent = '';  // Text for current block (reset when tool arrives)

        // Track thinking block for extended thinking
        let thinkingEl = null;
        let thinkingContent = '';

        // Create abort controller for this stream
        const abortController = new AbortController();
        this.abortController = abortController;

        try {
            // Build messages for API
            const allMessages = this.messages.map(m => ({
                role: m.role,
                content: m.content
            }));

            // Prune messages
            const apiMessages = this.pruneMessages(allMessages);

            // Use agent streaming endpoint
            const response = await fetch('/api/agent-chat/stream', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: apiMessages,
                    conversation_id: isRetry ? null : conversationId,
                    branch: isRetry ? null : this.currentBranch,
                    system_prompt: settings.system_prompt,
                    model: settings.model
                }),
                signal: abortController.signal
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            const contentEl = messageEl.querySelector('.message-content');
            contentEl.appendChild(indicator);

            // Helper to finalize current text block
            const finalizeTextBlock = () => {
                if (currentTextBlock && currentTextContent.trim()) {
                    this.renderMarkdownContent(currentTextBlock, currentTextContent);
                }
                currentTextBlock = null;
                currentTextContent = '';
            };

            // Helper to ensure we have a text block for text content
            const ensureTextBlock = () => {
                if (!currentTextBlock) {
                    currentTextBlock = document.createElement('div');
                    currentTextBlock.className = 'agent-text-block';
                    contentEl.insertBefore(currentTextBlock, indicator);
                }
            };

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const event = JSON.parse(line.slice(6));

                            if (event.type === 'message_id') {
                                this.streamingMessageId = event.id;
                                messageEl.dataset.messageId = event.id;
                            } else if (event.type === 'session_id') {
                                // Store session ID for conversation resumption
                                this.agentSessionId = event.session_id;
                                console.log('Agent session ID:', event.session_id);
                            } else if (event.type === 'thinking') {
                                // Handle thinking blocks from extended thinking
                                if (this.activeConversationId === conversationId && document.contains(messageEl)) {
                                    if (!thinkingEl) {
                                        thinkingEl = this.createThinkingBlock();
                                        contentEl.insertBefore(thinkingEl, contentEl.firstChild);
                                    }
                                    thinkingContent += event.content;
                                    this.updateThinkingBlock(thinkingEl, thinkingContent);
                                }
                            } else if (event.type === 'text') {
                                currentTextContent += event.content;

                                if (this.activeConversationId === conversationId && document.contains(messageEl)) {
                                    ensureTextBlock();
                                    // Update current text block with streaming content
                                    currentTextBlock.innerHTML = this.renderMarkdownToHtml(currentTextContent);
                                }
                            } else if (event.type === 'tool_use') {
                                // Push any pending text to accumulated content before the tool
                                if (currentTextContent.trim()) {
                                    accumulatedContent.push({ type: 'text', text: currentTextContent });
                                }
                                // Finalize text block for display
                                if (this.activeConversationId === conversationId && document.contains(messageEl)) {
                                    finalizeTextBlock();
                                    const toolBlock = this.createToolUseBlock(event.name, event.input, event.id);
                                    // Insert before the indicator
                                    contentEl.insertBefore(toolBlock, indicator);
                                    this.toolBlocks[event.id] = toolBlock;
                                }
                                // Reset text tracking for next text block
                                currentTextContent = '';
                                currentTextBlock = null;

                                accumulatedContent.push({
                                    type: 'tool_use',
                                    id: event.id,
                                    name: event.name,
                                    input: event.input
                                });
                            } else if (event.type === 'tool_result') {
                                // Update tool block with result
                                if (this.activeConversationId === conversationId) {
                                    this.updateToolResult(event.tool_use_id, event.content, event.is_error);
                                }
                                toolResults.push({
                                    tool_use_id: event.tool_use_id,
                                    content: event.content,
                                    is_error: event.is_error || false
                                });
                            } else if (event.type === 'error') {
                                if (this.activeConversationId === conversationId && document.contains(messageEl)) {
                                    finalizeTextBlock();
                                    this.showError(contentEl, event.content);
                                }
                            } else if (event.type === 'stopped') {
                                // Stream was stopped by user - handled gracefully
                                console.log('Agent stream stopped by user');
                            } else if (event.type === 'surface_content') {
                                // Surface content to user - render HTML/markdown in chat
                                if (this.activeConversationId === conversationId && document.contains(messageEl)) {
                                    finalizeTextBlock();
                                    const surfaceBlock = this.createSurfaceContentBlock(
                                        event.content,
                                        event.content_type,
                                        event.title,
                                        event.content_id
                                    );
                                    contentEl.insertBefore(surfaceBlock, indicator);
                                }
                                // Also track for saving
                                accumulatedContent.push({
                                    type: 'surface_content',
                                    content: event.content,
                                    content_type: event.content_type,
                                    title: event.title,
                                    content_id: event.content_id
                                });
                            }
                        } catch (e) {
                            console.error('Error parsing event:', e);
                        }
                    }
                }

                if (this.activeConversationId === conversationId && document.contains(messageEl)) {
                    this.scrollToBottom();
                }
            }

        } catch (error) {
            if (error.name !== 'AbortError') {
                console.error('Agent streaming error:', error);
                if (this.activeConversationId === conversationId && document.contains(messageEl)) {
                    const contentEl = messageEl.querySelector('.message-content');
                    this.showError(contentEl, error.message);
                }
            }
        } finally {
            // Mark streaming as complete
            if (typeof StreamingTracker !== 'undefined') {
                StreamingTracker.setStreaming(conversationId, false);
            }

            if (this.activeConversationId === conversationId && document.contains(messageEl)) {
                const indicatorEl = messageEl.querySelector('.streaming-indicator');
                if (indicatorEl) indicatorEl.remove();

                this.isStreaming = false;
                this.abortController = null;
                this.streamingMessageEl = null;
                this.streamingMessageId = null;
                this.updateSendButton();
                this.updateContextStats();
            }

            // Push any remaining text to accumulated content
            if (currentTextContent.trim()) {
                accumulatedContent.push({ type: 'text', text: currentTextContent });
            }

            // Update local messages array
            if (accumulatedContent.length > 0) {
                // Build final content - could be just text or mixed
                let finalContent;
                // Check if it's only a single text block
                if (accumulatedContent.length === 1 && accumulatedContent[0].type === 'text') {
                    finalContent = accumulatedContent[0].text;
                } else {
                    finalContent = accumulatedContent;
                }

                if (this.activeConversationId === conversationId) {
                    this.messages.push({
                        id: this.streamingMessageId,
                        role: 'assistant',
                        content: finalContent,
                        tool_results: toolResults.length > 0 ? toolResults : undefined,
                        position: position,
                        version: 1,
                        total_versions: 1
                    });
                }
            }

            // Clean up from BackgroundStreams
            if (typeof StreamingTracker !== 'undefined') {
                StreamingTracker.setStreaming(conversationId, false);
            }

            if (this.activeConversationId === conversationId) {
                this.scrollToBottom();
            }
        }
    },

    /**
     * Create a tool use block element
     */
    createToolUseBlock(toolName, input, toolUseId) {
        const el = document.createElement('div');
        el.className = 'tool-use-block collapsed';
        el.dataset.toolUseId = toolUseId;

        // Check if this is a subagent (Task) tool
        const isSubagent = toolName === 'Task' || toolName.toLowerCase().includes('task');

        const icon = this.getToolIcon(toolName);
        const displayName = this.getToolDisplayName(toolName);
        const inputPreview = typeof input === 'object' ? JSON.stringify(input, null, 2) : String(input);

        // Get a brief description for the collapsed state
        let briefDesc = '';
        if (typeof input === 'object') {
            if (input.command) briefDesc = input.command.substring(0, 50) + (input.command.length > 50 ? '...' : '');
            else if (input.file_path) briefDesc = input.file_path;
            else if (input.pattern) briefDesc = input.pattern;
            else if (input.query) briefDesc = input.query.substring(0, 50) + (input.query.length > 50 ? '...' : '');
            else if (input.prompt) briefDesc = input.prompt.substring(0, 50) + (input.prompt.length > 50 ? '...' : '');
            else if (input.description) briefDesc = input.description;
        }

        el.innerHTML = `
            <div class="tool-header" role="button" tabindex="0" aria-expanded="false">
                <span class="tool-expand-icon">▶</span>
                <span class="tool-icon">${icon}</span>
                <span class="tool-name">${this.escapeHtml(displayName)}</span>
                ${briefDesc ? `<span class="tool-brief">${this.escapeHtml(briefDesc)}</span>` : ''}
                <span class="tool-status running">Running...</span>
            </div>
            <div class="tool-details" style="display: none;">
                <div class="tool-input">
                    <div class="tool-section-label">Input</div>
                    <pre>${this.escapeHtml(inputPreview)}</pre>
                </div>
                ${isSubagent ? '<div class="subagent-transcript" style="display: none;"><div class="tool-section-label">Subagent Transcript</div><div class="subagent-content"></div></div>' : ''}
                <div class="tool-result" style="display: none;"></div>
            </div>
        `;

        // Add click handler to toggle collapsed state
        const header = el.querySelector('.tool-header');
        header.addEventListener('click', () => {
            const isCollapsed = el.classList.contains('collapsed');
            el.classList.toggle('collapsed');
            header.setAttribute('aria-expanded', isCollapsed);
            const expandIcon = el.querySelector('.tool-expand-icon');
            expandIcon.textContent = isCollapsed ? '▼' : '▶';
            const details = el.querySelector('.tool-details');
            details.style.display = isCollapsed ? 'block' : 'none';
        });

        // Keyboard accessibility
        header.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                header.click();
            }
        });

        return el;
    },

    /**
     * Update a tool block with its result
     */
    updateToolResult(toolUseId, content, isError) {
        const toolBlock = this.toolBlocks[toolUseId] ||
            document.querySelector(`[data-tool-use-id="${toolUseId}"]`);

        if (!toolBlock) return;

        const statusEl = toolBlock.querySelector('.tool-status');
        if (statusEl) {
            statusEl.textContent = isError ? 'Error' : 'Done';
            statusEl.classList.remove('running');
            statusEl.classList.add(isError ? 'error' : 'success');
        }

        const resultEl = toolBlock.querySelector('.tool-result');
        if (resultEl) {
            // Check if the result is a GIF from gif_search.py
            const gifResult = this.parseGifResult(content);
            if (gifResult && gifResult.url) {
                // Render as GIF image
                resultEl.innerHTML = '<div class="tool-section-label">Result</div>';
                const gifContainer = document.createElement('div');
                gifContainer.className = 'gif-result';
                gifContainer.innerHTML = `
                    <img src="${this.escapeHtml(gifResult.url)}"
                         alt="${this.escapeHtml(gifResult.title || 'GIF')}"
                         class="gif-image"
                         loading="lazy">
                    ${gifResult.title ? `<div class="gif-title">${this.escapeHtml(gifResult.title)}</div>` : ''}
                `;
                resultEl.appendChild(gifContainer);
                resultEl.style.display = 'block';
                resultEl.classList.add('gif-result-container');
                return;
            }

            // Only show result section if there's content or an error
            if (content || isError) {
                // Truncate long results for display
                const displayContent = content && content.length > 1000
                    ? content.substring(0, 1000) + '... (truncated)'
                    : content;
                resultEl.innerHTML = `<div class="tool-section-label">Result</div><pre>${this.escapeHtml(displayContent || (isError ? 'Tool execution failed' : 'Success'))}</pre>`;
                resultEl.style.display = 'block';
                if (isError) {
                    resultEl.classList.add('error');
                }
            }
            // If no content and no error, hide the result section (tool completed silently)
        }
    },

    /**
     * Create a surface content block for displaying HTML/markdown to user
     */
    createSurfaceContentBlock(content, contentType, title, contentId) {
        const el = document.createElement('div');
        el.className = 'surface-content-block';
        el.dataset.contentId = contentId || '';
        el.dataset.content = content;
        el.dataset.contentType = contentType;
        el.dataset.title = title || '';

        const headerHtml = title
            ? `<div class="surface-header">
                <span class="surface-icon">📊</span>
                <span class="surface-title">${this.escapeHtml(title)}</span>
                <span class="surface-expand-hint">Click to expand</span>
               </div>`
            : '<div class="surface-header surface-header-minimal"><span class="surface-expand-hint">Click to expand</span></div>';

        if (contentType === 'html') {
            // Render HTML content directly (sandboxed in iframe for security)
            const iframe = document.createElement('iframe');
            iframe.className = 'surface-iframe';
            iframe.sandbox = 'allow-scripts allow-same-origin';
            iframe.setAttribute('loading', 'lazy');

            el.innerHTML = headerHtml;
            el.appendChild(iframe);

            // Write content to iframe
            iframe.onload = () => {
                const doc = iframe.contentDocument || iframe.contentWindow.document;
                doc.open();
                doc.write(this._getSurfaceIframeHtml(content));
                doc.close();

                // Auto-resize iframe to content
                const resizeIframe = () => {
                    if (iframe.contentDocument && iframe.contentDocument.body) {
                        iframe.style.height = Math.min(iframe.contentDocument.body.scrollHeight + 20, 400) + 'px';
                    }
                };
                resizeIframe();
                // Also resize after images load
                const images = iframe.contentDocument.querySelectorAll('img');
                images.forEach(img => img.addEventListener('load', resizeIframe));
            };

            // Trigger load for already-loaded iframes
            setTimeout(() => iframe.onload && iframe.onload(), 100);

        } else {
            // Render markdown content
            el.innerHTML = headerHtml + '<div class="surface-markdown">' + this.renderMarkdownToHtml(content) + '</div>';
        }

        // Add click handler to header to expand
        const header = el.querySelector('.surface-header');
        if (header) {
            header.style.cursor = 'pointer';
            header.addEventListener('click', (e) => {
                e.stopPropagation();
                this.openSurfaceModal(content, contentType, title);
            });
        }

        // Also allow clicking on the block border area (not iframe)
        el.addEventListener('click', (e) => {
            // Only expand if clicking directly on the block or markdown content
            if (e.target === el || e.target.closest('.surface-markdown')) {
                this.openSurfaceModal(content, contentType, title);
            }
        });

        return el;
    },

    /**
     * Create a placeholder for surface content while loading
     */
    createSurfaceContentPlaceholder(contentType, title, contentId) {
        const el = document.createElement('div');
        el.className = 'surface-content-block surface-loading';
        el.dataset.contentId = contentId || '';

        const headerHtml = title
            ? `<div class="surface-header">
                <span class="surface-icon">📊</span>
                <span class="surface-title">${this.escapeHtml(title)}</span>
                <span class="surface-expand-hint">Loading...</span>
               </div>`
            : '<div class="surface-header surface-header-minimal"><span class="surface-expand-hint">Loading...</span></div>';

        el.innerHTML = headerHtml + '<div class="surface-loading-body">Loading content...</div>';
        return el;
    },

    /**
     * Load surface content from server and replace placeholder
     */
    async loadSurfaceContent(placeholderEl, filename, contentType, title, contentId) {
        const conversationId = ConversationsManager?.getCurrentConversationId();
        if (!conversationId) return;

        try {
            const response = await fetch(`/api/agent-chat/surface-content/${conversationId}/${encodeURIComponent(filename)}`);
            if (!response.ok) throw new Error('Failed to load surface content');

            const data = await response.json();
            this.replaceSurfaceContentPlaceholder(placeholderEl, data.content, contentType, title, contentId);
        } catch (error) {
            console.error('Failed to load surface content:', error);
            placeholderEl.querySelector('.surface-loading-body').textContent = 'Failed to load content';
            placeholderEl.classList.add('surface-error');
        }
    },

    /**
     * Replace placeholder with actual surface content
     */
    replaceSurfaceContentPlaceholder(placeholderEl, content, contentType, title, contentId) {
        // Create the real surface content block
        const realBlock = this.createSurfaceContentBlock(content, contentType, title, contentId);

        // Replace placeholder with real block
        placeholderEl.parentNode.replaceChild(realBlock, placeholderEl);
    },

    /**
     * Get the HTML template for surface iframe content
     */
    _getSurfaceIframeHtml(content) {
        return `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="utf-8">
                <style>
                    * { box-sizing: border-box; }
                    body {
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                        margin: 0;
                        padding: 12px;
                        font-size: 14px;
                        line-height: 1.5;
                        color: #333;
                        background: #fff;
                    }
                    table { border-collapse: collapse; width: 100%; }
                    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
                    th { background: #f5f5f5; font-weight: 600; }
                    tr:hover { background: #f9f9f9; }
                    button, .btn { padding: 6px 12px; border-radius: 4px; cursor: pointer; border: 1px solid #ccc; background: #f5f5f5; }
                    button:hover, .btn:hover { background: #e5e5e5; }
                    input, select { padding: 6px 8px; border: 1px solid #ccc; border-radius: 4px; }
                    .card { border: 1px solid #ddd; border-radius: 8px; padding: 16px; margin: 8px 0; }
                    .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 12px; }
                    .badge-success { background: #d4edda; color: #155724; }
                    .badge-warning { background: #fff3cd; color: #856404; }
                    .badge-danger { background: #f8d7da; color: #721c24; }
                    .progress { height: 20px; background: #e9ecef; border-radius: 4px; overflow: hidden; }
                    .progress-bar { height: 100%; background: #007bff; transition: width 0.3s; }
                </style>
            </head>
            <body>${content}</body>
            </html>
        `;
    },

    /**
     * Open surface content in a fullscreen modal
     */
    openSurfaceModal(content, contentType, title) {
        // Remove existing modal if any
        const existingModal = document.getElementById('surface-modal');
        if (existingModal) existingModal.remove();

        // Create modal
        const modal = document.createElement('div');
        modal.id = 'surface-modal';
        modal.className = 'surface-modal';
        modal.innerHTML = `
            <div class="surface-modal-backdrop"></div>
            <div class="surface-modal-container">
                <div class="surface-modal-header">
                    <span class="surface-modal-title">${title ? this.escapeHtml(title) : 'Content'}</span>
                    <button class="surface-modal-close" title="Close (Esc)">&times;</button>
                </div>
                <div class="surface-modal-body"></div>
            </div>
        `;

        const bodyEl = modal.querySelector('.surface-modal-body');

        if (contentType === 'html') {
            const iframe = document.createElement('iframe');
            iframe.className = 'surface-modal-iframe';
            iframe.sandbox = 'allow-scripts allow-same-origin';
            bodyEl.appendChild(iframe);

            // Write content after appending to DOM
            setTimeout(() => {
                const doc = iframe.contentDocument || iframe.contentWindow.document;
                doc.open();
                doc.write(this._getSurfaceIframeHtml(content));
                doc.close();
            }, 50);
        } else {
            bodyEl.innerHTML = '<div class="surface-modal-markdown">' + this.renderMarkdownToHtml(content) + '</div>';
        }

        // Close handlers
        const closeModal = () => {
            modal.classList.add('closing');
            setTimeout(() => modal.remove(), 200);
        };

        modal.querySelector('.surface-modal-close').addEventListener('click', closeModal);
        modal.querySelector('.surface-modal-backdrop').addEventListener('click', closeModal);

        // Escape key to close
        const escHandler = (e) => {
            if (e.key === 'Escape') {
                closeModal();
                document.removeEventListener('keydown', escHandler);
            }
        };
        document.addEventListener('keydown', escHandler);

        document.body.appendChild(modal);

        // Trigger animation
        requestAnimationFrame(() => modal.classList.add('open'));
    },

    /**
     * Add a child tool call to a subagent's transcript
     */
    addSubagentToolCall(parentToolUseId, childToolBlock) {
        const parentBlock = this.toolBlocks[parentToolUseId] ||
            document.querySelector(`[data-tool-use-id="${parentToolUseId}"]`);

        if (!parentBlock) return;

        const transcriptEl = parentBlock.querySelector('.subagent-transcript');
        if (transcriptEl) {
            transcriptEl.style.display = 'block';
            const contentEl = transcriptEl.querySelector('.subagent-content');
            if (contentEl) {
                contentEl.appendChild(childToolBlock);
            }
        }
    },

    /**
     * Try to parse content as a GIF result from gif_search.py
     */
    parseGifResult(content) {
        if (!content || typeof content !== 'string') return null;

        try {
            const parsed = JSON.parse(content);
            if (parsed.type === 'gif' && parsed.url) {
                return parsed;
            }
        } catch (e) {
            // Not JSON, check if content contains GIF URL inline
            // Look for giphy.com URLs in the content
            const giphyMatch = content.match(/https:\/\/[^\s"]*giphy\.com[^\s"]*/i);
            if (giphyMatch) {
                return { url: giphyMatch[0], title: '' };
            }
        }
        return null;
    },

    /**
     * Get icon for a tool
     */
    getToolIcon(toolName) {
        const icons = {
            'Read': '&#128214;',    // Open book
            'Write': '&#9997;',     // Writing hand
            'Edit': '&#9997;',      // Writing hand
            'Bash': '&#128187;',    // Computer
            'Glob': '&#128269;',    // Magnifying glass
            'Grep': '&#128270;',    // Magnifying glass right
            'mcp__gif-tools__search_gif': '&#127912;',  // Film frames (GIF)
            'search_gif': '&#127912;',  // Film frames (GIF)
        };
        return icons[toolName] || '&#128295;';  // Wrench as default
    },

    /**
     * Get display name for a tool (handles MCP tool name format)
     */
    getToolDisplayName(toolName) {
        // Handle MCP tool format: mcp__server-name__tool_name
        if (toolName.startsWith('mcp__')) {
            const parts = toolName.split('__');
            if (parts.length >= 3) {
                // Return just the tool name part, formatted nicely
                return parts[2].replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
            }
        }
        return toolName;
    },

    /**
     * Update the version nav badge on any message
     */
    updateMessageVersionNav(position, currentVersion, totalVersions) {
        const container = document.getElementById('messages-container');
        const msgEl = container.querySelector(`.message[data-position="${position}"]`);

        if (!msgEl) return;

        // Update data attributes
        msgEl.dataset.version = currentVersion;
        msgEl.dataset.totalVersions = totalVersions;

        const versionBadge = msgEl.querySelector('.version-badge');
        if (versionBadge) {
            if (totalVersions > 1) {
                versionBadge.style.display = '';
                const indicator = versionBadge.querySelector('.version-indicator');
                if (indicator) {
                    indicator.textContent = `${currentVersion}/${totalVersions}`;
                }
            } else {
                versionBadge.style.display = 'none';
            }
        }
    },

    /**
     * Create a message element with action buttons
     * For user messages: Copy + Edit + Version Nav (branches off user messages)
     * For assistant messages: Copy + Retry
     */
    createMessageElement(role, position = 0, version = 1, totalVersions = 1, nextVersionInfo = null, timestamp = null) {
        const el = document.createElement('div');
        el.className = `message ${role}`;
        el.dataset.position = position;
        el.dataset.version = version;
        el.dataset.totalVersions = totalVersions;

        let actionsHtml = '';
        if (role === 'user') {
            // User messages get Copy, Edit, Delete, and Version Nav (branching happens at user messages)
            const showVersionNav = totalVersions > 1;
            actionsHtml = `
                <div class="message-actions">
                    <button class="action-btn copy-btn" title="Copy">📋</button>
                    <button class="action-btn edit-btn" title="Edit">✏️</button>
                    <button class="action-btn delete-btn" title="Delete this and all following messages">🗑️</button>
                    <div class="version-badge" style="${showVersionNav ? '' : 'display: none;'}">
                        <button class="version-nav-btn prev-btn" title="Previous version">◀</button>
                        <span class="version-indicator">${version}/${totalVersions}</span>
                        <button class="version-nav-btn next-btn" title="Next version">▶</button>
                    </div>
                </div>
            `;
        } else {
            // Assistant messages get Copy and Retry
            actionsHtml = `
                <div class="message-actions">
                    <button class="action-btn copy-btn" title="Copy">📋</button>
                    <button class="action-btn retry-btn" title="Regenerate response">🔄</button>
                </div>
            `;
        }

        // Format timestamp if provided
        let timestampHtml = '';
        if (timestamp) {
            const time = this.formatTimestamp(timestamp);
            timestampHtml = `<div class="message-timestamp">${time}</div>`;
        }

        el.innerHTML = `
            <div class="message-content"></div>
            ${timestampHtml}
            ${actionsHtml}
        `;

        // Bind action buttons
        const copyBtn = el.querySelector('.copy-btn');
        const editBtn = el.querySelector('.edit-btn');
        const retryBtn = el.querySelector('.retry-btn');
        const deleteBtn = el.querySelector('.delete-btn');
        const prevBtn = el.querySelector('.prev-btn');
        const nextBtn = el.querySelector('.next-btn');

        if (copyBtn) {
            copyBtn.addEventListener('click', () => this.copyMessage(el));
        }
        if (editBtn) {
            editBtn.addEventListener('click', () => this.editMessage(position));
        }
        if (retryBtn) {
            // Retry regenerates the assistant response at this position
            retryBtn.addEventListener('click', () => this.retryMessage(position));
        }
        if (deleteBtn) {
            // Delete this message and all following messages
            deleteBtn.addEventListener('click', () => this.deleteMessagesFrom(position));
        }
        if (prevBtn) {
            // Version nav - switches branch at this position
            prevBtn.addEventListener('click', () => this.switchVersion(position, -1));
        }
        if (nextBtn) {
            nextBtn.addEventListener('click', () => this.switchVersion(position, 1));
        }

        return el;
    },

    /**
     * Format timestamp for display
     */
    formatTimestamp(timestamp) {
        if (!timestamp) return '';

        const date = new Date(timestamp);
        const now = new Date();
        const diffMs = now - date;
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffMs / 86400000);

        // Less than 1 minute: "Just now"
        if (diffMins < 1) return 'Just now';
        // Less than 1 hour: "X mins ago"
        if (diffHours < 1) return `${diffMins} ${diffMins === 1 ? 'min' : 'mins'} ago`;
        // Less than 24 hours: "X hours ago"
        if (diffDays < 1) return `${diffHours} ${diffHours === 1 ? 'hour' : 'hours'} ago`;
        // Less than 7 days: "X days ago"
        if (diffDays < 7) return `${diffDays} ${diffDays === 1 ? 'day' : 'days'} ago`;
        // Older: show date
        return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
    },

    /**
     * Render a message to the UI
     */
    renderMessage(msg, forceScroll = false) {
        const { role, content, thinking, tool_results, position = 0, version = 1, total_versions = 1, created_at } = msg;
        console.log('[renderMessage]', {role, position, contentLength: typeof content === 'string' ? content.length : 'array', content: typeof content === 'string' ? content.substring(0, 100) : content});

        // Check for compaction marker (system message with compaction type)
        if (role === 'system' && typeof content === 'object' && content?.type === 'compaction') {
            this.renderCompactionSeparator();
            return;
        }

        // Version info is now passed directly for user messages
        const el = this.createMessageElement(role, position, version, total_versions, null, created_at);
        const contentEl = el.querySelector('.message-content');

        if (thinking) {
            const thinkingEl = this.createThinkingBlock();
            this.updateThinkingBlock(thinkingEl, thinking);
            contentEl.appendChild(thinkingEl);
        }

        if (Array.isArray(content)) {
            // Separate files from other content (files always go first)
            const files = content.filter(b => b.type === 'image' || b.type === 'document');
            const textFiles = content.filter(b => b.type === 'text' && b.text?.startsWith('File: '));
            const otherContent = content.filter(b =>
                b.type !== 'image' && b.type !== 'document' &&
                !(b.type === 'text' && b.text?.startsWith('File: '))
            );

            if (files.length > 0 || textFiles.length > 0) {
                const filesEl = document.createElement('div');
                filesEl.className = 'message-files';

                files.forEach(file => {
                    const fileEl = document.createElement('div');
                    fileEl.className = 'message-file';
                    if (file.type === 'image' && file.source?.data) {
                        fileEl.innerHTML = `<img src="data:${file.source.media_type};base64,${file.source.data}" alt="Image">`;
                    } else if (file.type === 'document') {
                        fileEl.innerHTML = '<span class="message-file-icon">PDF</span><span>PDF Document</span>';
                    }
                    filesEl.appendChild(fileEl);
                });

                textFiles.forEach(tf => {
                    const fileEl = document.createElement('div');
                    fileEl.className = 'message-file';
                    const match = tf.text.match(/^File: (.+?)\n/);
                    const filename = match ? match[1] : 'Text file';
                    fileEl.innerHTML = `<span class="message-file-icon">TXT</span><span>${this.escapeHtml(filename)}</span>`;
                    filesEl.appendChild(fileEl);
                });

                contentEl.appendChild(filesEl);
            }

            // Build a map of tool results by tool_use_id
            const toolResultsMap = {};
            if (tool_results) {
                tool_results.forEach(tr => {
                    toolResultsMap[tr.tool_use_id] = tr;
                });
            }

            // Render content blocks in order (chronologically)
            otherContent.forEach(block => {
                if (block.type === 'tool_use') {
                    const toolEl = this.createToolUseBlock(block.name, block.input, block.id);
                    contentEl.appendChild(toolEl);
                    // Store reference for later status update
                    this.toolBlocks[block.id] = toolEl;

                    // Update tool status - mark as done for loaded messages
                    const result = toolResultsMap[block.id];
                    if (result) {
                        this.updateToolResult(block.id, result.content, result.is_error);
                    } else {
                        // No explicit result - assume success for loaded messages
                        this.updateToolResult(block.id, null, false);
                    }
                } else if (block.type === 'text' && block.text) {
                    const textEl = document.createElement('div');
                    textEl.className = 'agent-text-block';
                    textEl.innerHTML = this.formatText(block.text);
                    contentEl.appendChild(textEl);
                } else if (block.type === 'surface_content') {
                    // Render surface content block from saved message
                    // Content is stored on disk, need to fetch it
                    const surfaceEl = this.createSurfaceContentPlaceholder(
                        block.content_type,
                        block.title,
                        block.content_id
                    );
                    contentEl.appendChild(surfaceEl);

                    // Load content from server if we have a filename reference
                    if (block.filename) {
                        this.loadSurfaceContent(surfaceEl, block.filename, block.content_type, block.title, block.content_id);
                    } else if (block.content) {
                        // Fallback: content might be inline (old format)
                        this.replaceSurfaceContentPlaceholder(surfaceEl, block.content, block.content_type, block.title, block.content_id);
                    }
                }
            });
        } else if (typeof content === 'object' && content !== null && content.web_searches) {
            // Content with web search results - restore web search blocks first
            if (Array.isArray(content.web_searches)) {
                content.web_searches.forEach(ws => {
                    const searchBlock = this.createWebSearchBlock(ws.id, 'web_search');
                    this.updateWebSearchBlock(searchBlock, ws.results);
                    contentEl.appendChild(searchBlock);
                });
            }
            // Then render text content
            if (content.text) {
                const textEl = document.createElement('div');
                textEl.className = 'message-text';
                textEl.innerHTML = this.formatText(content.text);
                contentEl.appendChild(textEl);
            }
        } else {
            contentEl.innerHTML += this.formatText(content);
        }

        // Add copy buttons to code blocks
        this.addCodeCopyButtons(contentEl);

        const container = document.getElementById('messages-container');
        container.appendChild(el);
        this.scrollToBottom(forceScroll);
    },

    createThinkingBlock() {
        const el = document.createElement('div');
        el.className = 'thinking-block';
        el.innerHTML = `
            <div class="thinking-header" onclick="this.parentElement.classList.toggle('expanded')">
                <span class="thinking-toggle">></span>
                <span class="thinking-label">Thinking...</span>
            </div>
            <div class="thinking-content"></div>
        `;

        return el;
    },

    updateThinkingBlock(el, content) {
        const contentEl = el.querySelector('.thinking-content');
        contentEl.textContent = content;

        const label = el.querySelector('.thinking-label');
        const lines = content.split('\n').length;
        label.textContent = `Thinking (${lines} lines)`;
    },

    /**
     * Create a web search indicator block
     */
    createWebSearchBlock(id, name) {
        const el = document.createElement('div');
        el.className = 'web-search-block';
        el.dataset.toolUseId = id;
        el.innerHTML = `
            <div class="web-search-header" onclick="this.parentElement.classList.toggle('expanded')">
                <span class="web-search-toggle">▶</span>
                <span class="web-search-icon">🔍</span>
                <span class="web-search-label">Searching the web...</span>
                <span class="web-search-status searching">searching</span>
            </div>
            <div class="web-search-content">
                <div class="web-search-results"></div>
            </div>
        `;
        return el;
    },

    /**
     * Update web search block with results
     */
    /**
     * Update web search block with query being streamed
     */
    updateWebSearchQuery(el, partialQuery) {
        const label = el.querySelector('.web-search-label');
        // Try to extract query from the partial JSON
        try {
            // The partial_query might be incomplete JSON like {"query":"weather in london
            const match = partialQuery.match(/"query"\s*:\s*"([^"]*)(")?/);
            if (match && match[1]) {
                label.textContent = `Searching: "${match[1]}..."`;
            }
        } catch (e) {
            // Ignore parse errors
        }
    },

    /**
     * Update web search block with results
     */
    updateWebSearchBlock(el, results) {
        const label = el.querySelector('.web-search-label');
        const status = el.querySelector('.web-search-status');
        const resultsContainer = el.querySelector('.web-search-results');

        // Update status
        status.className = 'web-search-status complete';
        status.textContent = 'done';

        // Update label with result count
        const resultCount = Array.isArray(results) ? results.length : 0;
        label.textContent = `Web search (${resultCount} results)`;

        // Auto-expand to show results
        el.classList.add('expanded');

        // Render results
        if (Array.isArray(results) && results.length > 0) {
            let html = '';
            for (const result of results) {
                // Handle both direct objects and objects with type field
                const url = result.url || '';
                const title = result.title || 'Untitled';
                const snippet = result.snippet || result.page_age || '';

                html += `
                    <div class="web-search-result-item">
                        <a href="${this.escapeHtml(url)}" target="_blank" class="web-search-result-title">
                            ${this.escapeHtml(title)}
                        </a>
                        <div class="web-search-result-url">${this.escapeHtml(url)}</div>
                        ${snippet ? `<div class="web-search-result-snippet">${this.escapeHtml(snippet)}</div>` : ''}
                    </div>
                `;
            }
            resultsContainer.innerHTML = html || '<p>No results found</p>';
        } else {
            resultsContainer.innerHTML = '<p>No results found</p>';
        }
    },

    /**
     * Escape HTML to prevent XSS
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    },

    /**
     * Update message content with smooth streaming appearance
     * Instead of replacing all HTML at once, we try to preserve existing content
     * and only update what changed for smoother visual feedback
     */
    updateMessageContent(contentEl, text, indicator) {
        const thinkingBlock = contentEl.querySelector('.thinking-block');
        const wasExpanded = thinkingBlock?.classList.contains('expanded');

        // Get the current text container or create one
        let textContainer = contentEl.querySelector('.message-text');
        if (!textContainer) {
            // Clear existing content but preserve thinking block and indicator
            Array.from(contentEl.children).forEach(child => {
                if (!child.classList.contains('thinking-block') &&
                    !child.classList.contains('streaming-indicator')) {
                    child.remove();
                }
            });

            textContainer = document.createElement('div');
            textContainer.className = 'message-text';
            contentEl.appendChild(textContainer);
        }

        // For streaming, we want smooth character-by-character appearance
        // Check if this is an incremental update (new text starts with old text)
        const currentText = textContainer.dataset.rawText || '';

        if (text.startsWith(currentText) && currentText.length > 0) {
            // Incremental update - only add new characters
            const newChars = text.slice(currentText.length);
            if (newChars) {
                // Append new content smoothly
                this.appendFormattedText(textContainer, currentText, text);
            }
        } else {
            // Full replacement (initial render or content changed significantly)
            textContainer.innerHTML = this.formatText(text);
            this.addCodeCopyButtons(textContainer);
        }

        // Store raw text for comparison
        textContainer.dataset.rawText = text;

        // Re-add thinking block at the beginning if it existed
        if (thinkingBlock) {
            contentEl.insertBefore(thinkingBlock, contentEl.firstChild);
            if (wasExpanded) {
                thinkingBlock.classList.add('expanded');
            }
        }

        // Ensure indicator is at the end
        if (indicator && indicator.parentNode !== contentEl) {
            contentEl.appendChild(indicator);
        }
    },

    /**
     * Append new text to existing content smoothly
     * Re-renders if markdown structure might have changed, otherwise just appends
     */
    appendFormattedText(container, oldText, newText) {
        // Check if we're in the middle of a markdown structure that needs re-rendering
        const needsRerender =
            // In the middle of a code block
            (newText.match(/```/g) || []).length % 2 !== 0 ||
            // In the middle of bold/italic
            (newText.match(/\*\*/g) || []).length % 2 !== 0 ||
            // In the middle of a list or heading (last line starts with special char)
            /\n[#\-\*\d]/.test(newText.slice(-50));

        if (needsRerender || !container.lastChild) {
            // Full re-render needed
            container.innerHTML = this.formatText(newText);
            this.addCodeCopyButtons(container);
        } else {
            // Try to append smoothly - re-render last paragraph/element
            // This is a simplified approach: just re-render but browser will diff efficiently
            const html = this.formatText(newText);
            if (container.innerHTML !== html) {
                container.innerHTML = html;
                this.addCodeCopyButtons(container);
            }
        }
    },

    showError(contentEl, message) {
        const errorEl = document.createElement('div');
        errorEl.style.color = 'var(--color-error)';
        errorEl.textContent = `Error: ${message}`;
        contentEl.appendChild(errorEl);
    },

    /**
     * Render a compaction separator in the chat
     */
    renderCompactionSeparator() {
        const container = document.getElementById('messages-container');
        if (!container) return;

        const separator = document.createElement('div');
        separator.className = 'compaction-separator';
        separator.innerHTML = `
            <div class="compaction-line"></div>
            <span class="compaction-label">CONTEXT COMPACTED</span>
            <div class="compaction-line"></div>
        `;
        container.appendChild(separator);
    },

    formatText(text) {
        if (!text) return '';

        if (typeof marked !== 'undefined') {
            try {
                let html = marked.parse(text);
                // Auto-embed Giphy URLs as images
                html = this.embedGiphyUrls(html);
                return html;
            } catch (e) {
                console.error('Markdown parsing error:', e);
            }
        }

        let html = this.escapeHtml(text);
        html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
        html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
        html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
        html = html.replace(/\n/g, '<br>');
        // Auto-embed Giphy URLs as images
        html = this.embedGiphyUrls(html);
        return html;
    },

    /**
     * Render markdown text to HTML string
     */
    renderMarkdownToHtml(text) {
        return this.formatText(text);
    },

    /**
     * Render markdown content into an element
     */
    renderMarkdownContent(element, text) {
        if (element && text) {
            element.innerHTML = this.formatText(text);
            // Highlight code blocks if available
            if (typeof hljs !== 'undefined') {
                element.querySelectorAll('pre code').forEach(block => {
                    hljs.highlightElement(block);
                });
            }
        }
    },

    /**
     * Replace Giphy URLs with embedded GIF images
     */
    embedGiphyUrls(html) {
        // Match Giphy gif URLs (both in links and standalone)
        // Pattern for URLs ending in .gif from giphy.com
        const giphyGifPattern = /(https:\/\/media[0-9]*\.giphy\.com\/[^\s"<>]+\.gif)/gi;

        return html.replace(giphyGifPattern, (match, url) => {
            // If it's already in an img tag, leave it
            const imgPattern = new RegExp(`<img[^>]*src=["']${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`, 'i');
            if (imgPattern.test(html)) {
                return match;
            }
            // Replace the URL with an embedded GIF
            return `<div class="embedded-gif"><img src="${url}" alt="GIF" class="gif-image" loading="lazy"></div>`;
        });
    },

    /**
     * Add copy buttons to code blocks in a container
     */
    addCodeCopyButtons(container) {
        const codeBlocks = container.querySelectorAll('pre');

        codeBlocks.forEach(pre => {
            // Skip if already wrapped
            if (pre.parentElement?.classList.contains('code-block-wrapper')) {
                return;
            }

            // Create wrapper
            const wrapper = document.createElement('div');
            wrapper.className = 'code-block-wrapper';

            // Wrap the pre element
            pre.parentNode.insertBefore(wrapper, pre);
            wrapper.appendChild(pre);

            // Create copy button
            const copyBtn = document.createElement('button');
            copyBtn.className = 'code-copy-btn';
            copyBtn.textContent = 'Copy';
            copyBtn.addEventListener('click', async () => {
                const codeEl = pre.querySelector('code');
                const code = codeEl ? codeEl.textContent : pre.textContent;

                try {
                    await navigator.clipboard.writeText(code);
                    copyBtn.textContent = 'Copied!';
                    copyBtn.classList.add('copied');

                    setTimeout(() => {
                        copyBtn.textContent = 'Copy';
                        copyBtn.classList.remove('copied');
                    }, 2000);
                } catch (error) {
                    console.error('Failed to copy code:', error);
                    copyBtn.textContent = 'Failed';
                    setTimeout(() => {
                        copyBtn.textContent = 'Copy';
                    }, 2000);
                }
            });

            wrapper.appendChild(copyBtn);
        });
    },

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    },

    scrollToBottom(force = false) {
        const container = document.getElementById('messages-container');

        if (force) {
            // Force scroll to bottom (e.g., when sending a new message)
            container.scrollTop = container.scrollHeight;
            this.userScrolledAway = false;
        } else {
            // Respect user's scroll intent - if they scrolled away, don't auto-scroll
            if (this.userScrolledAway) {
                return;
            }

            // Only auto-scroll if user is at the bottom (within 30px)
            const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
            if (distanceFromBottom < 30) {
                container.scrollTop = container.scrollHeight;
            }
        }
    },

    updateContextStats() {
        const settings = SettingsManager?.getSettings() || {};
        const model = settings.model || 'claude-3-5-sonnet-20241022';
        const modelLimit = this.MODEL_LIMITS[model] || 200000;

        // Calculate total tokens
        let totalTokens = 0;
        this.messages.forEach(msg => {
            totalTokens += this.estimateTokens(msg.content);
        });

        // Update UI
        document.getElementById('stat-messages').textContent = this.messages.length;

        const contextPercentage = ((totalTokens / modelLimit) * 100).toFixed(0);
        const tokensFormatted = totalTokens >= 1000 ? `${(totalTokens / 1000).toFixed(1)}K` : totalTokens;
        const limitFormatted = modelLimit >= 1000 ? `${(modelLimit / 1000).toFixed(0)}K` : modelLimit;
        document.getElementById('stat-context').textContent = `${tokensFormatted} / ${limitFormatted} (${contextPercentage}%)`;

        // Show/hide pruned messages stat
        const prunedContainer = document.getElementById('stat-pruned-container');
        if (this.lastPrunedCount > 0) {
            prunedContainer.style.display = '';
            document.getElementById('stat-pruned').textContent = `${this.lastPrunedCount}`;
        } else {
            prunedContainer.style.display = 'none';
        }
    },

    stopStreaming() {
        if (this.abortController) {
            this.abortController.abort();
        }
    }
};

```

---

### `static/js/conversations.js`

**Purpose:** Conversation list management in the sidebar

```javascript
/**
 * Conversation management module with file-based branching support
 */

const ConversationsManager = {
    conversations: [],
    currentConversationId: null,
    searchQuery: '',
    searchResults: null,
    renamingConversationId: null,
    loadRequestId: 0,  // Track conversation load requests to handle race conditions

    refreshInterval: null,  // Interval for periodic refresh
    lastRefresh: 0,  // Timestamp of last refresh

    /**
     * Initialize the conversations manager
     */
    async init() {
        await this.loadConversations();
        this.bindEvents();
        this.bindSearchEvents();
        this.startPeriodicRefresh();
    },

    /**
     * Start periodic refresh of conversations list
     */
    startPeriodicRefresh() {
        // Refresh every 5 seconds
        this.refreshInterval = setInterval(() => {
            this.refreshConversationsIfVisible();
        }, 5000);
    },

    /**
     * Refresh conversations list if tab is visible
     */
    async refreshConversationsIfVisible() {
        // Only refresh if tab is visible
        if (document.visibilityState !== 'visible') {
            return;
        }

        // Don't refresh if user is actively searching
        if (this.searchQuery) {
            return;
        }

        // Don't refresh if user is renaming
        if (this.renamingConversationId !== null) {
            return;
        }

        try {
            const response = await fetch('/api/conversations');
            const data = await response.json();
            const newConversations = data.conversations || [];

            // Only re-render if something changed
            if (this.hasConversationsChanged(newConversations)) {
                this.conversations = newConversations;
                this.renderConversationsList();
            }
        } catch (error) {
            // Silently fail on periodic refresh
            console.debug('Periodic refresh failed:', error);
        }
    },

    /**
     * Check if conversations list has changed
     */
    hasConversationsChanged(newConversations) {
        if (newConversations.length !== this.conversations.length) {
            return true;
        }

        for (let i = 0; i < newConversations.length; i++) {
            const newConv = newConversations[i];
            const oldConv = this.conversations[i];

            if (newConv.id !== oldConv.id ||
                newConv.title !== oldConv.title ||
                newConv.updated_at !== oldConv.updated_at) {
                return true;
            }
        }

        return false;
    },

    /**
     * Bind DOM events
     */
    bindEvents() {
        document.getElementById('new-chat-btn').addEventListener('click', () => {
            this.createConversation();
        });

        // New Agent Chat button
        const agentBtn = document.getElementById('new-agent-chat-btn');
        if (agentBtn) {
            agentBtn.addEventListener('click', (e) => {
                if (e.shiftKey) {
                    // Shift+click: show settings popup
                    // Determine if we're in a project context
                    const projectId = typeof ProjectsManager !== 'undefined'
                        ? ProjectsManager.getCurrentProjectId()
                        : null;
                    if (typeof QuickAgentSettings !== 'undefined') {
                        QuickAgentSettings.open(projectId);
                    }
                } else {
                    // Normal click: create agent chat directly
                    this.createConversation('New Agent Chat', true, true);  // clearUI=true, isAgent=true
                }
            });
        }
    },

    /**
     * Bind search events
     */
    bindSearchEvents() {
        const searchInput = document.getElementById('search-input');
        const clearBtn = document.getElementById('clear-search-btn');

        searchInput.addEventListener('input', (e) => {
            this.handleSearch(e.target.value);
        });

        clearBtn.addEventListener('click', () => {
            searchInput.value = '';
            this.handleSearch('');
            searchInput.focus();
        });

        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                searchInput.value = '';
                this.handleSearch('');
            }
        });
    },

    /**
     * Handle search input
     */
    async handleSearch(query) {
        this.searchQuery = query.trim();
        const clearBtn = document.getElementById('clear-search-btn');

        // Show/hide clear button
        clearBtn.style.display = this.searchQuery ? '' : 'none';

        if (!this.searchQuery) {
            this.searchResults = null;
            this.renderConversationsList();
            return;
        }

        // Search in conversation titles (client-side) - partial match
        const titleMatches = this.conversations.filter(conv =>
            conv.title.toLowerCase().includes(this.searchQuery.toLowerCase())
        );

        // Search message content (server-side) - always enabled with partial match
        try {
            const response = await fetch(
                `/api/conversations/search?q=${encodeURIComponent(this.searchQuery)}`
            );
            if (response.ok) {
                const data = await response.json();

                // Create a set of title match IDs for quick lookup
                const titleMatchIds = new Set(titleMatches.map(c => c.id));

                // Separate content-only matches
                const contentOnlyMatches = data.conversations.filter(conv =>
                    !titleMatchIds.has(conv.id)
                );

                // Prioritize: title matches first, then content matches
                this.searchResults = [...titleMatches, ...contentOnlyMatches];
            } else {
                // Fallback to title-only search if endpoint fails
                this.searchResults = titleMatches;
            }
        } catch (error) {
            // Fallback to title-only search on error
            console.error('Search error:', error);
            this.searchResults = titleMatches;
        }

        this.renderConversationsList();
    },

    /**
     * Load all conversations from the server
     */
    async loadConversations() {
        try {
            const response = await fetch('/api/conversations');
            const data = await response.json();
            this.conversations = data.conversations || [];
            this.renderConversationsList();

            // Also refresh projects to sync conversation data
            if (typeof ProjectsManager !== 'undefined') {
                ProjectsManager.renderProjects();
            }
        } catch (error) {
            console.error('Failed to load conversations:', error);
        }
    },

    /**
     * Render the conversations list in the sidebar
     */
    renderConversationsList() {
        const container = document.getElementById('conversations-list');
        container.innerHTML = '';

        // Use search results if available, otherwise all conversations
        let conversationsToShow = this.searchResults !== null ? this.searchResults : this.conversations;

        // When not searching, filter out conversations that belong to projects
        if (this.searchResults === null && typeof ProjectsManager !== 'undefined') {
            conversationsToShow = ProjectsManager.getUnorganizedConversations(conversationsToShow);
        }

        if (this.conversations.length === 0) {
            container.innerHTML = '<p style="padding: 12px; color: var(--color-text-secondary); font-size: 13px;">No conversations yet</p>';
            return;
        }

        if (conversationsToShow.length === 0 && this.searchQuery) {
            container.innerHTML = '<p style="padding: 12px; color: var(--color-text-secondary); font-size: 13px;">No matches found</p>';
            return;
        }

        if (conversationsToShow.length === 0 && !this.searchQuery) {
            container.innerHTML = '<p style="padding: 12px; color: var(--color-text-secondary); font-size: 13px;">All conversations are in projects</p>';
            return;
        }

        conversationsToShow.forEach(conv => {
            const item = document.createElement('div');
            item.className = `conversation-item${conv.id === this.currentConversationId ? ' active' : ''}${conv.is_agent ? ' agent' : ''}`;
            item.dataset.id = conv.id;
            item.dataset.isAgent = conv.is_agent || false;

            // Highlight search matches in title
            let titleHtml = this.escapeHtml(conv.title);
            if (this.searchQuery) {
                const regex = new RegExp(`(${this.escapeRegex(this.searchQuery)})`, 'gi');
                titleHtml = titleHtml.replace(regex, '<mark>$1</mark>');
            }

            // Add agent indicator if this is an agent conversation
            const agentIcon = conv.is_agent ? '<img src="/static/favicon.png" alt="Agent" class="agent-icon" title="Agent Chat">' : '';

            // Add project badge if searching and conversation is in a project
            let projectBadge = '';
            if (this.searchQuery && typeof ProjectsManager !== 'undefined') {
                const projectId = ProjectsManager.conversationProjectMap[conv.id];
                if (projectId) {
                    const project = ProjectsManager.projects.find(p => p.id === projectId);
                    if (project) {
                        projectBadge = `<span class="project-badge" style="background-color: ${project.color}">${ProjectsManager.escapeHtml(project.name)}</span>`;
                    }
                }
            }

            item.innerHTML = `
                ${agentIcon}
                <span class="conversation-title">${titleHtml}</span>
                ${projectBadge}
                <div class="conversation-actions">
                    <button class="conversation-settings" title="Settings">⚙️</button>
                    <button class="conversation-duplicate" title="Duplicate">📋</button>
                    <button class="conversation-rename" title="Rename">✏️</button>
                    <button class="conversation-delete" title="Delete">🗑️</button>
                </div>
            `;

            const titleEl = item.querySelector('.conversation-title');

            // Click to select conversation
            item.addEventListener('click', (e) => {
                if (!e.target.classList.contains('conversation-delete') &&
                    !e.target.classList.contains('conversation-rename') &&
                    !e.target.classList.contains('conversation-duplicate') &&
                    !e.target.classList.contains('conversation-settings')) {
                    this.selectConversation(conv.id);
                }
            });

            // Settings button - open settings panel for this conversation
            item.querySelector('.conversation-settings').addEventListener('click', async (e) => {
                e.stopPropagation();
                // Select the conversation first
                await this.selectConversation(conv.id);
                // Open settings panel
                if (typeof SettingsManager !== 'undefined' && !SettingsManager.isOpen) {
                    SettingsManager.togglePanel();
                }
            });

            // Double-click to rename
            titleEl.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                this.startRename(conv.id, titleEl);
            });

            // Duplicate button
            item.querySelector('.conversation-duplicate').addEventListener('click', (e) => {
                e.stopPropagation();
                this.duplicateConversation(conv.id);
            });

            // Rename button
            item.querySelector('.conversation-rename').addEventListener('click', (e) => {
                e.stopPropagation();
                this.startRename(conv.id, titleEl);
            });

            // Delete button
            item.querySelector('.conversation-delete').addEventListener('click', (e) => {
                e.stopPropagation();
                this.deleteConversation(conv.id);
            });

            // Setup drag handlers for moving to projects
            if (typeof ProjectsManager !== 'undefined') {
                ProjectsManager.setupDragHandlers(item, conv.id);
            }

            container.appendChild(item);
        });

        // Update streaming indicators after rendering
        if (typeof BackgroundStreams !== 'undefined') {
            BackgroundStreams.updateStreamingIndicators();
        }
    },

    /**
     * Create a new conversation
     * @param {string} title - The conversation title
     * @param {boolean} clearUI - Whether to clear the chat UI (true when clicking New Chat button)
     * @param {boolean} isAgent - Whether this is an agent conversation
     */
    async createConversation(title = 'New Conversation', clearUI = true, isAgent = false) {
        try {
            // Get default settings for this mode
            const mode = isAgent ? 'agent' : 'normal';
            const defaults = typeof DefaultSettingsManager !== 'undefined'
                ? DefaultSettingsManager.getDefaultsForMode(mode)
                : {};

            const requestBody = {
                title,
                model: defaults.model || SettingsManager.getSettings().model,
                system_prompt: defaults.system_prompt || null,
                is_agent: isAgent
            };

            // Add settings for normal chat (not agent)
            if (!isAgent && defaults.settings) {
                requestBody.settings = defaults.settings;
            }

            const response = await fetch('/api/conversations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody)
            });

            const conversation = await response.json();
            this.conversations.unshift(conversation);
            this.currentConversationId = conversation.id;
            this.renderConversationsList();

            // Clear the chat UI to show the new empty conversation
            if (clearUI && typeof ChatManager !== 'undefined') {
                ChatManager.isAgentConversation = isAgent;  // Set this so clearChat shows correct welcome message
                ChatManager.clearChat();
                ChatManager.activeConversationId = conversation.id;
                ChatManager.currentBranch = [0];

                // Update settings mode
                if (typeof SettingsManager !== 'undefined') {
                    SettingsManager.setMode(isAgent ? 'agent' : 'normal');
                    // Load the conversation settings (from defaults)
                    SettingsManager.loadConversationSettings(conversation);
                }
            }

            return conversation;
        } catch (error) {
            console.error('Failed to create conversation:', error);
            throw error;
        }
    },

    /**
     * Select a conversation and load its messages
     * @param {string} conversationId - The conversation ID
     * @param {Array<number>} branch - Optional branch to load (default: uses conversation's current_branch)
     */
    async selectConversation(conversationId, branch = null) {
        console.log('[selectConversation] Starting for:', conversationId);

        // Increment request ID to track this specific request
        const requestId = ++this.loadRequestId;

        this.currentConversationId = conversationId;
        this.renderConversationsList();

        // Re-render projects to update active state
        if (typeof ProjectsManager !== 'undefined') {
            ProjectsManager.renderProjects();
        }

        // Find the conversation to get its is_agent flag before preparing
        const conversation = this.conversations.find(c => c.id === conversationId);
        const isAgent = conversation?.is_agent || false;

        // Immediately prepare ChatManager for the switch - clears UI and sets active ID
        if (typeof ChatManager !== 'undefined') {
            ChatManager.isAgentConversation = isAgent;  // Set this before preparing so welcome message is correct
            ChatManager.prepareForConversationSwitch(conversationId);

            // Update settings mode
            if (typeof SettingsManager !== 'undefined') {
                SettingsManager.setMode(isAgent ? 'agent' : 'normal');
            }
        }

        try {
            // Build URL with optional branch parameter
            let url = `/api/conversations/${conversationId}`;
            if (branch) {
                url += `?branch=${branch.join(',')}`;
            }

            const response = await fetch(url);

            // Check if user clicked on a different conversation while we were fetching
            if (this.loadRequestId !== requestId || this.currentConversationId !== conversationId) {
                console.log('Conversation load abandoned - user switched to different conversation');
                return;
            }

            const conversation = await response.json();

            // Double-check again after parsing JSON
            if (this.loadRequestId !== requestId || this.currentConversationId !== conversationId) {
                console.log('Conversation load abandoned - user switched to different conversation');
                return;
            }

            // Load messages into chat
            if (typeof ChatManager !== 'undefined') {
                // Don't overwrite isAgentConversation - it was already set before prepareForConversationSwitch
                // This prevents the workspace button from flickering
                await ChatManager.loadConversation(conversation);
            }

            // Update workspace visibility after loading conversation
            if (typeof WorkspaceManager !== 'undefined') {
                WorkspaceManager.updateVisibility(conversation.is_agent || false);
                WorkspaceManager.setConversation(conversation.id);
            }

            // Load conversation-specific settings
            if (typeof SettingsManager !== 'undefined') {
                SettingsManager.loadConversationSettings(conversation);
            }

        } catch (error) {
            console.error('Failed to load conversation:', error);
        }
    },

    /**
     * Update conversation title
     */
    async updateConversationTitle(conversationId, title) {
        try {
            await fetch(`/api/conversations/${conversationId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title })
            });

            // Update local state
            const conv = this.conversations.find(c => c.id === conversationId);
            if (conv) {
                conv.title = title;
                this.renderConversationsList();
            }
        } catch (error) {
            console.error('Failed to update conversation:', error);
        }
    },

    /**
     * Start renaming a conversation
     */
    startRename(conversationId, titleEl) {
        if (this.renamingConversationId !== null) return;

        const conv = this.conversations.find(c => c.id === conversationId);
        if (!conv) return;

        this.renamingConversationId = conversationId;

        // Create input element
        const input = document.createElement('input');
        input.type = 'text';
        input.value = conv.title;
        input.className = 'conversation-rename-input';
        input.style.cssText = `
            width: 100%;
            padding: 4px 6px;
            border: 1px solid var(--color-primary);
            border-radius: 4px;
            background: var(--color-surface);
            color: var(--color-text);
            font-size: 13px;
            outline: none;
        `;

        // Replace title with input
        const originalHtml = titleEl.innerHTML;
        titleEl.innerHTML = '';
        titleEl.appendChild(input);

        input.focus();
        input.select();

        // Handle save
        const save = async () => {
            const newTitle = input.value.trim();
            if (newTitle && newTitle !== conv.title) {
                await this.updateConversationTitle(conversationId, newTitle);
            }
            this.renamingConversationId = null;
            this.renderConversationsList();
        };

        // Handle cancel
        const cancel = () => {
            this.renamingConversationId = null;
            titleEl.innerHTML = originalHtml;
        };

        // Event listeners
        input.addEventListener('blur', save);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                save();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                cancel();
            }
        });

        // Prevent click from bubbling
        input.addEventListener('click', (e) => e.stopPropagation());
    },

    /**
     * Duplicate a conversation
     */
    async duplicateConversation(conversationId) {
        try {
            const response = await fetch(`/api/conversations/${conversationId}/duplicate`, {
                method: 'POST'
            });

            if (!response.ok) {
                throw new Error('Failed to duplicate conversation');
            }

            const newConversation = await response.json();

            // Add to local state at the top
            this.conversations.unshift(newConversation);

            // Select the new conversation
            this.selectConversation(newConversation.id);

            this.renderConversationsList();
        } catch (error) {
            console.error('Failed to duplicate conversation:', error);
            alert('Failed to duplicate conversation');
        }
    },

    /**
     * Delete a conversation
     */
    async deleteConversation(conversationId) {
        if (!confirm('Delete this conversation?')) {
            return;
        }

        try {
            await fetch(`/api/conversations/${conversationId}`, {
                method: 'DELETE'
            });

            // Remove from local state
            this.conversations = this.conversations.filter(c => c.id !== conversationId);

            // Remove from projects map if present
            if (typeof ProjectsManager !== 'undefined') {
                const projectId = ProjectsManager.conversationProjectMap[conversationId];
                if (projectId) {
                    delete ProjectsManager.conversationProjectMap[conversationId];
                    const project = ProjectsManager.projects.find(p => p.id === projectId);
                    if (project) {
                        project.conversation_ids = project.conversation_ids.filter(id => id !== conversationId);
                    }
                }
                ProjectsManager.renderProjects();
            }

            // If deleted current conversation, clear chat
            if (conversationId === this.currentConversationId) {
                this.currentConversationId = null;
                if (typeof ChatManager !== 'undefined') {
                    ChatManager.clearChat();
                }
            }

            this.renderConversationsList();
        } catch (error) {
            console.error('Failed to delete conversation:', error);
        }
    },

    /**
     * Add a message to the current conversation
     * @param {string} role - 'user' or 'assistant'
     * @param {any} content - Message content
     * @param {string|null} thinking - Extended thinking content
     * @param {Array<number>|null} branch - Branch to add message to
     */
    async addMessage(role, content, thinking = null, branch = null) {
        if (!this.currentConversationId) {
            return null;
        }

        try {
            const response = await fetch(`/api/conversations/${this.currentConversationId}/messages`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    role,
                    content,
                    thinking,
                    branch
                })
            });

            return await response.json();
        } catch (error) {
            console.error('Failed to add message:', error);
            return null;
        }
    },

    /**
     * Generate a title from the first message
     */
    generateTitle(message) {
        const text = typeof message === 'string' ? message :
            (Array.isArray(message) ? message.find(b => b.type === 'text')?.text : '');

        if (!text) return 'New Conversation';

        // Take first 50 chars
        let title = text.substring(0, 50).trim();
        if (text.length > 50) title += '...';
        return title;
    },

    /**
     * Escape HTML to prevent XSS
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    },

    /**
     * Escape regex special characters
     */
    escapeRegex(text) {
        return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    },

    /**
     * Get current conversation ID
     */
    getCurrentConversationId() {
        return this.currentConversationId;
    }
};

```

---

### `static/js/default-settings.js`

**Purpose:** Default configuration values for the frontend

```javascript
/**
 * Default Settings management module
 * Handles the popup modal for default settings that apply to new conversations
 */

const DefaultSettingsManager = {
    models: [],
    isOpen: false,
    currentTab: 'normal',
    settings: null,

    /**
     * Initialize default settings manager
     */
    async init() {
        await this.loadModels();
        await this.loadSettings();
        this.bindEvents();
        this.renderModels();
        this.applySettingsToUI();
    },

    /**
     * Load available models from API
     */
    async loadModels() {
        try {
            const response = await fetch('/api/chat/models');
            const data = await response.json();
            this.models = data.models || [];
        } catch (error) {
            console.error('Failed to load models:', error);
        }
    },

    /**
     * Load default settings from API
     */
    async loadSettings() {
        try {
            const response = await fetch('/api/settings/defaults');
            this.settings = await response.json();
        } catch (error) {
            console.error('Failed to load default settings:', error);
            this.settings = this.getDefaultValues();
        }
    },

    /**
     * Get default values if API fails
     */
    getDefaultValues() {
        return {
            normal_model: 'claude-opus-4-5-20251101',
            normal_system_prompt: '',
            normal_thinking_enabled: true,
            normal_thinking_budget: 60000,
            normal_max_tokens: 64000,
            normal_temperature: 1.0,
            normal_top_p: 1.0,
            normal_top_k: 0,
            normal_prune_threshold: 0.7,
            normal_web_search_enabled: false,
            normal_web_search_max_uses: 5,
            agent_model: 'claude-opus-4-5-20251101',
            agent_system_prompt: '',
            agent_tools: null,
            agent_cwd: null,
            agent_thinking_budget: 32000
        };
    },

    /**
     * Render model dropdowns
     */
    renderModels() {
        const normalSelect = document.getElementById('default-normal-model');
        const agentSelect = document.getElementById('default-agent-model');

        [normalSelect, agentSelect].forEach(select => {
            if (!select) return;
            select.innerHTML = '<option value="">Use default model</option>';
            this.models.forEach(model => {
                const option = document.createElement('option');
                option.value = model.id;
                option.textContent = model.name;
                select.appendChild(option);
            });
        });
    },

    /**
     * Apply loaded settings to UI elements
     */
    applySettingsToUI() {
        if (!this.settings) return;

        // Normal chat defaults
        const normalModel = document.getElementById('default-normal-model');
        if (normalModel && this.settings.normal_model) {
            normalModel.value = this.settings.normal_model;
        }

        const normalSystemPrompt = document.getElementById('default-normal-system-prompt');
        if (normalSystemPrompt) {
            normalSystemPrompt.value = this.settings.normal_system_prompt || '';
        }

        const normalThinkingToggle = document.getElementById('default-normal-thinking-toggle');
        if (normalThinkingToggle) {
            normalThinkingToggle.checked = this.settings.normal_thinking_enabled !== false;
            this.onThinkingToggle(normalThinkingToggle.checked);
        }

        const normalThinkingBudget = document.getElementById('default-normal-thinking-budget');
        const normalThinkingBudgetValue = document.getElementById('default-normal-thinking-budget-value');
        if (normalThinkingBudget) {
            normalThinkingBudget.value = this.settings.normal_thinking_budget || 10000;
            if (normalThinkingBudgetValue) {
                normalThinkingBudgetValue.textContent = normalThinkingBudget.value;
            }
        }

        const normalMaxTokens = document.getElementById('default-normal-max-tokens');
        const normalMaxTokensValue = document.getElementById('default-normal-max-tokens-value');
        if (normalMaxTokens) {
            normalMaxTokens.value = this.settings.normal_max_tokens || 64000;
            if (normalMaxTokensValue) {
                normalMaxTokensValue.textContent = normalMaxTokens.value;
            }
        }

        const normalTemperature = document.getElementById('default-normal-temperature');
        const normalTemperatureValue = document.getElementById('default-normal-temperature-value');
        if (normalTemperature) {
            normalTemperature.value = this.settings.normal_temperature ?? 1.0;
            if (normalTemperatureValue) {
                normalTemperatureValue.textContent = normalTemperature.value;
            }
        }

        const normalTopP = document.getElementById('default-normal-top-p');
        const normalTopPValue = document.getElementById('default-normal-top-p-value');
        if (normalTopP) {
            normalTopP.value = this.settings.normal_top_p ?? 1.0;
            if (normalTopPValue) {
                normalTopPValue.textContent = normalTopP.value;
            }
        }

        const normalTopK = document.getElementById('default-normal-top-k');
        const normalTopKValue = document.getElementById('default-normal-top-k-value');
        if (normalTopK) {
            normalTopK.value = this.settings.normal_top_k ?? 0;
            if (normalTopKValue) {
                normalTopKValue.textContent = normalTopK.value;
            }
        }

        const normalPruneThreshold = document.getElementById('default-normal-prune-threshold');
        const normalPruneThresholdValue = document.getElementById('default-normal-prune-threshold-value');
        if (normalPruneThreshold) {
            const thresholdPercent = Math.round((this.settings.normal_prune_threshold || 0.7) * 100);
            normalPruneThreshold.value = thresholdPercent;
            if (normalPruneThresholdValue) {
                normalPruneThresholdValue.textContent = thresholdPercent;
            }
        }

        // Web search
        const webSearchToggle = document.getElementById('default-normal-web-search-toggle');
        if (webSearchToggle) {
            webSearchToggle.checked = this.settings.normal_web_search_enabled || false;
            this.onWebSearchToggle(webSearchToggle.checked);
        }

        const webSearchMaxUses = document.getElementById('default-normal-web-search-max-uses');
        const webSearchMaxUsesValue = document.getElementById('default-normal-web-search-max-uses-value');
        if (webSearchMaxUses) {
            webSearchMaxUses.value = this.settings.normal_web_search_max_uses || 5;
            if (webSearchMaxUsesValue) {
                webSearchMaxUsesValue.textContent = webSearchMaxUses.value;
            }
        }

        // Agent chat defaults
        const agentModel = document.getElementById('default-agent-model');
        if (agentModel && this.settings.agent_model) {
            agentModel.value = this.settings.agent_model;
        }

        const agentSystemPrompt = document.getElementById('default-agent-system-prompt');
        if (agentSystemPrompt) {
            agentSystemPrompt.value = this.settings.agent_system_prompt || '';
        }

        const agentCwd = document.getElementById('default-agent-cwd');
        if (agentCwd) {
            agentCwd.value = this.settings.agent_cwd || '';
        }

        // Agent thinking budget
        const agentThinkingBudget = document.getElementById('default-agent-thinking-budget');
        const agentThinkingBudgetValue = document.getElementById('default-agent-thinking-budget-value');
        if (agentThinkingBudget) {
            agentThinkingBudget.value = this.settings.agent_thinking_budget || 8000;
            if (agentThinkingBudgetValue) {
                agentThinkingBudgetValue.textContent = agentThinkingBudget.value;
            }
        }

        // Agent tools
        const toolToggles = document.querySelectorAll('#default-agent-tools input[type="checkbox"]');
        const agentTools = this.settings.agent_tools || {};
        toolToggles.forEach(checkbox => {
            // Default to true (enabled) if not specified
            checkbox.checked = agentTools[checkbox.name] !== false;
        });
    },

    /**
     * Handle web search toggle
     */
    onWebSearchToggle(enabled) {
        const configContainer = document.getElementById('default-normal-web-search-config');
        if (configContainer) {
            configContainer.style.display = enabled ? 'block' : 'none';
        }
    },

    /**
     * Handle thinking toggle
     */
    onThinkingToggle(enabled) {
        const budgetContainer = document.getElementById('default-normal-thinking-budget-container');
        const temperatureGroup = document.getElementById('default-normal-temperature-group');
        const topPGroup = document.getElementById('default-normal-top-p-group');
        const topKGroup = document.getElementById('default-normal-top-k-group');

        if (enabled) {
            if (budgetContainer) budgetContainer.classList.add('visible');
            if (temperatureGroup) temperatureGroup.classList.add('hidden');
            if (topPGroup) topPGroup.classList.add('hidden');
            if (topKGroup) topKGroup.classList.add('hidden');
        } else {
            if (budgetContainer) budgetContainer.classList.remove('visible');
            if (temperatureGroup) temperatureGroup.classList.remove('hidden');
            if (topPGroup) topPGroup.classList.remove('hidden');
            if (topKGroup) topKGroup.classList.remove('hidden');
        }
    },

    /**
     * Bind DOM events
     */
    bindEvents() {
        // Open modal button
        const toggleBtn = document.getElementById('default-settings-toggle');
        if (toggleBtn) {
            toggleBtn.addEventListener('click', () => this.openModal());
        }

        // Close buttons
        const closeBtn = document.getElementById('close-default-settings');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => this.closeModal());
        }

        const cancelBtn = document.getElementById('cancel-default-settings');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => this.closeModal());
        }

        // Save button
        const saveBtn = document.getElementById('save-default-settings');
        if (saveBtn) {
            saveBtn.addEventListener('click', () => this.saveSettings());
        }

        // Tab switching
        const tabBtns = document.querySelectorAll('#default-settings-modal .tab-btn');
        tabBtns.forEach(btn => {
            btn.addEventListener('click', (e) => {
                const tab = e.target.dataset.tab;
                this.switchTab(tab);
            });
        });

        // Modal overlay click to close
        const modal = document.getElementById('default-settings-modal');
        if (modal) {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    this.closeModal();
                }
            });
        }

        // Thinking toggle
        const thinkingToggle = document.getElementById('default-normal-thinking-toggle');
        if (thinkingToggle) {
            thinkingToggle.addEventListener('change', (e) => {
                this.onThinkingToggle(e.target.checked);
            });
        }

        // Web search toggle
        const webSearchToggle = document.getElementById('default-normal-web-search-toggle');
        if (webSearchToggle) {
            webSearchToggle.addEventListener('change', (e) => {
                this.onWebSearchToggle(e.target.checked);
            });
        }

        // Slider value updates
        this.bindSliderEvents();
    },

    /**
     * Bind slider input events to update displayed values
     */
    bindSliderEvents() {
        const sliders = [
            { id: 'default-normal-thinking-budget', valueId: 'default-normal-thinking-budget-value' },
            { id: 'default-normal-max-tokens', valueId: 'default-normal-max-tokens-value' },
            { id: 'default-normal-temperature', valueId: 'default-normal-temperature-value' },
            { id: 'default-normal-top-p', valueId: 'default-normal-top-p-value' },
            { id: 'default-normal-top-k', valueId: 'default-normal-top-k-value' },
            { id: 'default-normal-prune-threshold', valueId: 'default-normal-prune-threshold-value' },
            { id: 'default-normal-web-search-max-uses', valueId: 'default-normal-web-search-max-uses-value' },
            { id: 'default-agent-thinking-budget', valueId: 'default-agent-thinking-budget-value' }
        ];

        sliders.forEach(({ id, valueId }) => {
            const slider = document.getElementById(id);
            const valueDisplay = document.getElementById(valueId);
            if (slider && valueDisplay) {
                slider.addEventListener('input', (e) => {
                    valueDisplay.textContent = e.target.value;
                });
            }
        });

        // Add specific validation for thinking budget and max tokens
        const thinkingBudgetSlider = document.getElementById('default-normal-thinking-budget');
        const maxTokensSlider = document.getElementById('default-normal-max-tokens');
        const thinkingToggle = document.getElementById('default-normal-thinking-toggle');

        if (thinkingBudgetSlider && maxTokensSlider) {
            // Thinking budget - if increased above max_tokens, raise max_tokens
            thinkingBudgetSlider.addEventListener('input', (e) => {
                const thinkingBudget = parseInt(e.target.value);

                if (thinkingToggle && thinkingToggle.checked && parseInt(maxTokensSlider.value) < thinkingBudget) {
                    maxTokensSlider.value = thinkingBudget;
                    document.getElementById('default-normal-max-tokens-value').textContent = thinkingBudget;
                }
            });

            // Max tokens - if decreased below thinking_budget, lower thinking_budget
            maxTokensSlider.addEventListener('input', (e) => {
                const value = parseInt(e.target.value);

                if (thinkingToggle && thinkingToggle.checked && parseInt(thinkingBudgetSlider.value) > value) {
                    thinkingBudgetSlider.value = value;
                    document.getElementById('default-normal-thinking-budget-value').textContent = value;
                }
            });

            // Sync values when thinking is toggled on
            if (thinkingToggle) {
                thinkingToggle.addEventListener('change', (e) => {
                    if (e.target.checked) {
                        const thinkingBudget = parseInt(thinkingBudgetSlider.value);
                        const maxTokens = parseInt(maxTokensSlider.value);
                        if (maxTokens < thinkingBudget) {
                            maxTokensSlider.value = thinkingBudget;
                            document.getElementById('default-normal-max-tokens-value').textContent = thinkingBudget;
                        }
                    }
                });
            }
        }
    },

    /**
     * Switch between tabs
     */
    switchTab(tab) {
        this.currentTab = tab;

        // Update tab buttons
        const tabBtns = document.querySelectorAll('#default-settings-modal .tab-btn');
        tabBtns.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tab);
        });

        // Update tab content
        document.getElementById('default-tab-normal').style.display = tab === 'normal' ? '' : 'none';
        document.getElementById('default-tab-agent').style.display = tab === 'agent' ? '' : 'none';
    },

    /**
     * Open the modal
     */
    openModal() {
        const modal = document.getElementById('default-settings-modal');
        if (modal) {
            modal.classList.add('visible');
            this.isOpen = true;
        }
    },

    /**
     * Close the modal
     */
    closeModal() {
        const modal = document.getElementById('default-settings-modal');
        if (modal) {
            modal.classList.remove('visible');
            this.isOpen = false;
        }
    },

    /**
     * Collect settings from UI and save to API
     */
    async saveSettings() {
        const settings = {
            // Normal chat defaults
            normal_model: document.getElementById('default-normal-model')?.value || null,
            normal_system_prompt: document.getElementById('default-normal-system-prompt')?.value || '',
            normal_thinking_enabled: document.getElementById('default-normal-thinking-toggle')?.checked ?? true,
            normal_thinking_budget: parseInt(document.getElementById('default-normal-thinking-budget')?.value) || 10000,
            normal_max_tokens: parseInt(document.getElementById('default-normal-max-tokens')?.value) || 64000,
            normal_temperature: parseFloat(document.getElementById('default-normal-temperature')?.value) ?? 1.0,
            normal_top_p: parseFloat(document.getElementById('default-normal-top-p')?.value) ?? 1.0,
            normal_top_k: parseInt(document.getElementById('default-normal-top-k')?.value) ?? 0,
            normal_prune_threshold: (parseInt(document.getElementById('default-normal-prune-threshold')?.value) || 70) / 100,
            normal_web_search_enabled: document.getElementById('default-normal-web-search-toggle')?.checked || false,
            normal_web_search_max_uses: parseInt(document.getElementById('default-normal-web-search-max-uses')?.value) || 5,

            // Agent chat defaults
            agent_model: document.getElementById('default-agent-model')?.value || null,
            agent_system_prompt: document.getElementById('default-agent-system-prompt')?.value || '',
            agent_cwd: document.getElementById('default-agent-cwd')?.value || null,
            agent_thinking_budget: parseInt(document.getElementById('default-agent-thinking-budget')?.value) || 8000,
            agent_tools: this.getDefaultToolToggles()
        };

        try {
            const response = await fetch('/api/settings/defaults', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(settings)
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const result = await response.json();
            if (result.success) {
                this.settings = result.settings;
                this.closeModal();
            } else {
                console.error('Failed to save default settings:', result.error);
                alert('Failed to save default settings: ' + (result.error || 'Unknown error'));
            }
        } catch (error) {
            console.error('Failed to save default settings:', error);
            alert('Failed to save default settings. Please restart the server.');
        }
    },

    /**
     * Get default tool toggles from UI
     */
    getDefaultToolToggles() {
        const toolsContainer = document.getElementById('default-agent-tools');
        if (!toolsContainer) return null;

        const checkboxes = toolsContainer.querySelectorAll('input[type="checkbox"]');
        if (checkboxes.length === 0) return null;

        const tools = {};
        checkboxes.forEach(cb => {
            tools[cb.name] = cb.checked;
        });
        return tools;
    },

    /**
     * Get default settings for a specific mode
     */
    getDefaultsForMode(mode) {
        if (!this.settings) return {};

        if (mode === 'agent') {
            return {
                model: this.settings.agent_model,
                system_prompt: this.settings.agent_system_prompt,
                agent_cwd: this.settings.agent_cwd,
                agent_thinking_budget: this.settings.agent_thinking_budget,
                agent_tools: this.settings.agent_tools
            };
        }

        return {
            model: this.settings.normal_model,
            system_prompt: this.settings.normal_system_prompt,
            settings: {
                thinking_enabled: this.settings.normal_thinking_enabled,
                thinking_budget: this.settings.normal_thinking_budget,
                max_tokens: this.settings.normal_max_tokens,
                temperature: this.settings.normal_temperature,
                top_p: this.settings.normal_top_p,
                top_k: this.settings.normal_top_k,
                prune_threshold: this.settings.normal_prune_threshold,
                web_search_enabled: this.settings.normal_web_search_enabled,
                web_search_max_uses: this.settings.normal_web_search_max_uses
            }
        };
    }
};

```

---

### `static/js/files.js`

**Purpose:** File attachment and upload handling in the UI

```javascript
/**
 * File handling module with server file browser
 */

const FilesManager = {
    pendingFiles: [],
    selectedServerFiles: new Set(),
    currentPath: null,

    /**
     * Initialize file handling
     */
    init() {
        this.bindEvents();
    },

    /**
     * Bind DOM events
     */
    bindEvents() {
        // Server file browser button
        document.getElementById('server-file-btn').addEventListener('click', () => {
            this.openFileBrowser();
        });

        // Close file browser
        document.getElementById('close-file-browser').addEventListener('click', () => {
            this.closeFileBrowser();
        });

        // Click outside to close
        document.getElementById('file-browser-modal').addEventListener('click', (e) => {
            if (e.target.id === 'file-browser-modal') {
                this.closeFileBrowser();
            }
        });

        // Add selected files button
        document.getElementById('add-selected-files').addEventListener('click', () => {
            this.addSelectedFiles();
        });

        // Paste from clipboard (for images)
        document.addEventListener('paste', (e) => {
            const items = e.clipboardData?.items;
            if (items) {
                for (const item of items) {
                    if (item.kind === 'file' && item.type.startsWith('image/')) {
                        const file = item.getAsFile();
                        if (file) this.handlePastedFile(file);
                    }
                }
            }
        });

        // Drag and drop support
        const dropZone = document.querySelector('.input-area');

        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropZone.classList.add('dragging');
        });

        dropZone.addEventListener('dragleave', (e) => {
            e.preventDefault();
            e.stopPropagation();
            // Only remove if leaving the input-area itself, not child elements
            if (e.target === dropZone) {
                dropZone.classList.remove('dragging');
            }
        });

        dropZone.addEventListener('drop', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropZone.classList.remove('dragging');

            const files = Array.from(e.dataTransfer.files);
            if (files.length > 0) {
                await this.handleDroppedFiles(files);
            }
        });

        // Prevent default drag behavior on document to avoid browser opening files
        document.addEventListener('dragover', (e) => {
            e.preventDefault();
        });

        document.addEventListener('drop', (e) => {
            e.preventDefault();
        });
    },

    /**
     * Open the server file browser
     */
    async openFileBrowser() {
        this.selectedServerFiles.clear();
        document.getElementById('file-browser-modal').classList.add('visible');
        await this.browsePath(null);
    },

    /**
     * Close the file browser
     */
    closeFileBrowser() {
        document.getElementById('file-browser-modal').classList.remove('visible');
        this.selectedServerFiles.clear();
    },

    /**
     * Browse a directory path
     */
    async browsePath(path) {
        try {
            const url = path ? `/api/files/browse?path=${encodeURIComponent(path)}` : '/api/files/browse';
            const response = await fetch(url);

            if (!response.ok) {
                const error = await response.json();
                alert(error.detail || 'Failed to browse directory');
                return;
            }

            const data = await response.json();
            this.currentPath = data.current_path;
            this.renderFileBrowser(data);
        } catch (error) {
            console.error('Browse error:', error);
            alert('Failed to browse directory');
        }
    },

    /**
     * Render the file browser
     */
    renderFileBrowser(data) {
        // Render path breadcrumb
        const pathEl = document.getElementById('file-browser-path');
        const parts = data.current_path.split('/').filter(Boolean);
        let pathHtml = '<span class="path-segment" data-path="/">~</span>';
        let cumPath = '';
        for (const part of parts) {
            cumPath += '/' + part;
            pathHtml += ` / <span class="path-segment" data-path="${cumPath}">${part}</span>`;
        }
        pathEl.innerHTML = pathHtml;

        // Add click handlers to path segments
        pathEl.querySelectorAll('.path-segment').forEach(seg => {
            seg.addEventListener('click', () => {
                const segPath = seg.dataset.path;
                this.browsePath(segPath === '/' ? null : segPath);
            });
        });

        // Render file list
        const listEl = document.getElementById('file-browser-list');
        listEl.innerHTML = '';

        // Parent directory
        if (data.parent_path) {
            const parentItem = document.createElement('div');
            parentItem.className = 'file-item';
            parentItem.innerHTML = `
                <span class="file-item-icon">📁</span>
                <div class="file-item-info">
                    <div class="file-item-name">..</div>
                </div>
            `;
            parentItem.addEventListener('click', () => {
                this.browsePath(data.parent_path);
            });
            listEl.appendChild(parentItem);
        }

        // Files and directories
        for (const item of data.items) {
            const itemEl = document.createElement('div');
            itemEl.className = 'file-item';
            if (this.selectedServerFiles.has(item.path)) {
                itemEl.classList.add('selected');
            }

            const icon = item.is_dir ? '📁' : this.getFileIcon(item.extension);
            const size = item.size ? this.formatSize(item.size) : '';

            if (item.is_dir) {
                itemEl.innerHTML = `
                    <span class="file-item-icon">${icon}</span>
                    <div class="file-item-info">
                        <div class="file-item-name">${this.escapeHtml(item.name)}</div>
                    </div>
                `;
                itemEl.addEventListener('click', () => {
                    this.browsePath(item.path);
                });
            } else {
                itemEl.innerHTML = `
                    <input type="checkbox" class="file-item-checkbox" ${this.selectedServerFiles.has(item.path) ? 'checked' : ''}>
                    <span class="file-item-icon">${icon}</span>
                    <div class="file-item-info">
                        <div class="file-item-name">${this.escapeHtml(item.name)}</div>
                        <div class="file-size">${size}</div>
                    </div>
                `;
                itemEl.addEventListener('click', (e) => {
                    if (e.target.type !== 'checkbox') {
                        const checkbox = itemEl.querySelector('.file-item-checkbox');
                        checkbox.checked = !checkbox.checked;
                    }
                    this.toggleFileSelection(item.path, itemEl);
                });
            }

            listEl.appendChild(itemEl);
        }

        this.updateSelectedCount();
    },

    /**
     * Toggle file selection
     */
    toggleFileSelection(path, itemEl) {
        if (this.selectedServerFiles.has(path)) {
            this.selectedServerFiles.delete(path);
            itemEl.classList.remove('selected');
        } else {
            this.selectedServerFiles.add(path);
            itemEl.classList.add('selected');
        }
        this.updateSelectedCount();
    },

    /**
     * Update selected files count
     */
    updateSelectedCount() {
        const count = this.selectedServerFiles.size;
        document.getElementById('selected-files-count').textContent = `${count} file${count !== 1 ? 's' : ''} selected`;
        document.getElementById('add-selected-files').disabled = count === 0;
    },

    /**
     * Add selected server files
     */
    async addSelectedFiles() {
        const paths = Array.from(this.selectedServerFiles);

        for (const path of paths) {
            try {
                const response = await fetch('/api/files/read-server-file', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path })
                });

                if (!response.ok) {
                    const error = await response.json();
                    console.error(`Failed to read ${path}:`, error.detail);
                    continue;
                }

                const result = await response.json();
                this.pendingFiles.push(result);
            } catch (error) {
                console.error(`Failed to read ${path}:`, error);
            }
        }

        this.closeFileBrowser();
        this.renderPreviews();
        this.updateSendButton();
    },

    /**
     * Handle pasted file (for clipboard images)
     */
    async handlePastedFile(file) {
        const formData = new FormData();
        formData.append('file', file);

        try {
            const response = await fetch('/api/files/upload', {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.detail || 'Upload failed');
            }

            const result = await response.json();
            this.pendingFiles.push(result);
            this.renderPreviews();
            this.updateSendButton();
        } catch (error) {
            console.error('Failed to upload pasted file:', error);
        }
    },

    /**
     * Handle dropped files (for drag and drop)
     */
    async handleDroppedFiles(files) {
        for (const file of files) {
            const formData = new FormData();
            formData.append('file', file);

            try {
                const response = await fetch('/api/files/upload', {
                    method: 'POST',
                    body: formData
                });

                if (!response.ok) {
                    const error = await response.json();
                    console.error(`Failed to upload ${file.name}:`, error.detail || 'Upload failed');
                    continue;
                }

                const result = await response.json();
                this.pendingFiles.push(result);
            } catch (error) {
                console.error(`Failed to upload ${file.name}:`, error);
            }
        }

        this.renderPreviews();
        this.updateSendButton();
    },

    /**
     * Render file previews
     */
    renderPreviews() {
        const container = document.getElementById('file-previews');
        container.innerHTML = '';

        this.pendingFiles.forEach((file, index) => {
            const preview = document.createElement('div');
            preview.className = 'file-preview';

            const { preview: previewData } = file;

            let thumbnailHtml = '';
            if (previewData.type === 'image' && previewData.thumbnail) {
                thumbnailHtml = `<img src="${previewData.thumbnail}" alt="${previewData.filename}">`;
            } else if (previewData.type === 'document') {
                thumbnailHtml = '<span class="file-preview-icon">📄</span>';
            } else {
                thumbnailHtml = '<span class="file-preview-icon">📝</span>';
            }

            preview.innerHTML = `
                ${thumbnailHtml}
                <div class="file-preview-info">
                    <span class="file-preview-name">${this.escapeHtml(previewData.filename)}</span>
                    <span class="file-preview-size">${previewData.size_display}</span>
                </div>
                <button class="file-preview-remove" data-index="${index}">&times;</button>
            `;

            preview.querySelector('.file-preview-remove').addEventListener('click', () => {
                this.removeFile(index);
            });

            container.appendChild(preview);
        });
    },

    /**
     * Remove a pending file
     */
    removeFile(index) {
        this.pendingFiles.splice(index, 1);
        this.renderPreviews();
        this.updateSendButton();
    },

    /**
     * Clear all pending files
     */
    clearPendingFiles() {
        this.pendingFiles = [];
        this.renderPreviews();
    },

    /**
     * Get content blocks for API request
     */
    getContentBlocks() {
        return this.pendingFiles.map(file => file.content_block);
    },

    /**
     * Check if there are pending files
     */
    hasPendingFiles() {
        return this.pendingFiles.length > 0;
    },

    /**
     * Update send button state
     */
    updateSendButton() {
        const messageInput = document.getElementById('message-input');
        const sendBtn = document.getElementById('send-btn');
        const hasContent = messageInput.value.trim() || this.hasPendingFiles();
        sendBtn.disabled = !hasContent;
    },

    /**
     * Get icon for file extension
     */
    getFileIcon(ext) {
        const icons = {
            '.pdf': '📄',
            '.doc': '📄', '.docx': '📄',
            '.txt': '📝', '.md': '📝',
            '.py': '🐍',
            '.js': '📜', '.ts': '📜',
            '.json': '📋',
            '.jpg': '🖼️', '.jpeg': '🖼️', '.png': '🖼️', '.gif': '🖼️', '.webp': '🖼️',
            '.html': '🌐', '.css': '🎨',
            '.csv': '📊', '.xlsx': '📊',
            '.zip': '📦', '.tar': '📦', '.gz': '📦'
        };
        return icons[ext] || '📄';
    },

    /**
     * Format file size
     */
    formatSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    },

    /**
     * Escape HTML
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
};

```

---

### `static/js/folder-browser.js`

**Purpose:** Folder/directory browser component for file selection

```javascript
/**
 * Folder Browser Module - handles folder selection for CWD inputs
 */

const FolderBrowser = {
    isOpen: false,
    currentPath: null,
    targetInputId: null,

    /**
     * Initialize the folder browser
     */
    init() {
        this.bindEvents();
    },

    /**
     * Bind event handlers
     */
    bindEvents() {
        // Close button
        document.getElementById('close-folder-browser')?.addEventListener('click', () => {
            this.close();
        });

        // Cancel button
        document.getElementById('cancel-folder-browser')?.addEventListener('click', () => {
            this.close();
        });

        // Select folder button
        document.getElementById('select-folder')?.addEventListener('click', () => {
            this.selectCurrentFolder();
        });

        // Click outside to close
        document.getElementById('folder-browser-modal')?.addEventListener('click', (e) => {
            if (e.target.id === 'folder-browser-modal') {
                this.close();
            }
        });

        // Bind all folder browse buttons
        document.addEventListener('click', (e) => {
            const btn = e.target.closest('.folder-browse-btn');
            if (btn) {
                e.preventDefault();
                const targetId = btn.dataset.target;
                this.open(targetId);
            }
        });
    },

    /**
     * Open the folder browser
     */
    async open(targetInputId) {
        this.targetInputId = targetInputId;

        // Get current value from input as starting path
        const input = document.getElementById(targetInputId);
        let startPath = input?.value || null;

        // If no path, start from home or root
        if (!startPath) {
            startPath = null; // Will use server default
        }

        document.getElementById('folder-browser-modal').classList.add('visible');
        this.isOpen = true;

        await this.browsePath(startPath);
    },

    /**
     * Close the folder browser
     */
    close() {
        document.getElementById('folder-browser-modal').classList.remove('visible');
        this.isOpen = false;
        this.targetInputId = null;
        this.currentPath = null;
    },

    /**
     * Browse a directory path
     */
    async browsePath(path) {
        try {
            const url = path
                ? `/api/files/browse?path=${encodeURIComponent(path)}`
                : '/api/files/browse';

            const response = await fetch(url);
            if (!response.ok) {
                throw new Error('Failed to browse folder');
            }

            const data = await response.json();
            // API returns current_path, parent_path - normalize to path, parent
            this.currentPath = data.current_path || data.path;
            this.renderFolderList({
                path: data.current_path || data.path,
                parent: data.parent_path || data.parent,
                items: data.items || []
            });
        } catch (error) {
            console.error('Failed to browse folder:', error);
            // Try to go to root on error
            if (path !== '/') {
                await this.browsePath('/');
            }
        }
    },

    /**
     * Render the folder list
     */
    renderFolderList(data) {
        const pathEl = document.getElementById('folder-browser-path');
        const listEl = document.getElementById('folder-browser-list');

        // Update path display
        pathEl.textContent = data.path || '/';

        // Build folder list HTML
        let html = '';

        // Add parent directory link if not at root
        if (data.parent) {
            html += `
                <div class="folder-browser-item parent" data-path="${this.escapeHtml(data.parent)}">
                    <span class="folder-icon">&#128193;</span>
                    <span class="folder-name">..</span>
                </div>
            `;
        }

        // Add directories only (folders, not files)
        // API may return is_dir or is_directory depending on version
        const folders = (data.items || []).filter(item => item.is_dir || item.is_directory);

        for (const folder of folders) {
            html += `
                <div class="folder-browser-item" data-path="${this.escapeHtml(folder.path)}">
                    <span class="folder-icon">&#128193;</span>
                    <span class="folder-name">${this.escapeHtml(folder.name)}</span>
                </div>
            `;
        }

        if (folders.length === 0 && !data.parent) {
            html = '<div class="folder-browser-empty">No folders found</div>';
        }

        listEl.innerHTML = html;

        // Bind click handlers
        listEl.querySelectorAll('.folder-browser-item').forEach(item => {
            item.addEventListener('click', () => {
                const path = item.dataset.path;
                this.browsePath(path);
            });
        });
    },

    /**
     * Select the current folder
     */
    selectCurrentFolder() {
        if (this.targetInputId && this.currentPath) {
            const input = document.getElementById(this.targetInputId);
            if (input) {
                input.value = this.currentPath;
                // Trigger change event
                input.dispatchEvent(new Event('change', { bubbles: true }));
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }
        this.close();
    },

    /**
     * Escape HTML for safe display
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
};

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    FolderBrowser.init();
});

```

---

### `static/js/project-settings.js`

**Purpose:** Project-specific settings UI

```javascript
/**
 * Project Settings Manager - handles editing settings for individual projects
 */

const ProjectSettingsManager = {
    isOpen: false,
    currentProjectId: null,
    currentProject: null,
    settings: null,
    models: [],

    /**
     * Initialize the manager
     */
    async init() {
        // Load available models
        try {
            const response = await fetch('/api/chat/models');
            const data = await response.json();
            this.models = data.models || [];
        } catch (error) {
            console.error('Failed to load models:', error);
        }

        this.createModal();
        this.bindEvents();
    },

    /**
     * Create the modal HTML
     */
    createModal() {
        const modal = document.createElement('div');
        modal.id = 'project-settings-modal';
        modal.className = 'project-settings-modal';
        modal.innerHTML = `
            <div class="project-settings-overlay"></div>
            <div class="project-settings-content">
                <div class="project-settings-header">
                    <h2>Project Settings</h2>
                    <span class="project-settings-name"></span>
                    <button class="project-settings-close">&times;</button>
                </div>
                <div class="project-settings-tabs">
                    <button class="project-settings-tab active" data-tab="normal">Normal Chat</button>
                    <button class="project-settings-tab" data-tab="agent">Agent Chat</button>
                </div>
                <div class="project-settings-body">
                    <div class="project-settings-panel active" data-panel="normal">
                        <div class="setting-group">
                            <label>Model</label>
                            <select id="project-normal-model"></select>
                        </div>
                        <div class="setting-group">
                            <label>System Prompt</label>
                            <textarea id="project-normal-system-prompt" rows="4" placeholder="Optional system prompt..."></textarea>
                        </div>
                        <div class="setting-group">
                            <label>
                                <input type="checkbox" id="project-normal-thinking-enabled">
                                Enable Extended Thinking
                            </label>
                        </div>
                        <div class="setting-group" id="project-thinking-budget-group">
                            <label>Thinking Budget: <span id="project-thinking-budget-value">60000</span></label>
                            <input type="range" id="project-normal-thinking-budget" min="1024" max="128000" step="1024" value="60000">
                        </div>
                        <div class="setting-group">
                            <label>Max Tokens: <span id="project-max-tokens-value">64000</span></label>
                            <input type="range" id="project-normal-max-tokens" min="1024" max="128000" step="1024" value="64000">
                        </div>
                        <div class="setting-group">
                            <label>Temperature: <span id="project-temperature-value">1.0</span></label>
                            <input type="range" id="project-normal-temperature" min="0" max="1" step="0.1" value="1.0">
                        </div>
                    </div>
                    <div class="project-settings-panel" data-panel="agent">
                        <div class="setting-group">
                            <label>Model</label>
                            <select id="project-agent-model"></select>
                        </div>
                        <div class="setting-group">
                            <label>System Prompt</label>
                            <textarea id="project-agent-system-prompt" rows="4" placeholder="Optional system prompt for agent..."></textarea>
                        </div>
                        <div class="setting-group">
                            <label>Working Directory (CWD)</label>
                            <div class="cwd-input-group">
                                <input type="text" id="project-agent-cwd" placeholder="Leave empty for default workspace">
                                <button type="button" class="btn-icon folder-browse-btn" data-target="project-agent-cwd" title="Browse folders">
                                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                                    </svg>
                                </button>
                            </div>
                            <span class="setting-description">Custom directory where the agent will operate. Leave empty to use the default workspace.</span>
                        </div>
                        <div class="setting-group">
                            <label>Thinking Budget: <span id="project-agent-thinking-budget-value">32000</span></label>
                            <input type="range" id="project-agent-thinking-budget" min="1024" max="32000" step="1024" value="32000">
                            <span class="setting-description">Token budget for agent's internal reasoning (extended thinking).</span>
                        </div>
                        <div class="setting-group">
                            <label>Available Tools</label>
                            <div class="tool-toggles" id="project-agent-tools">
                                <label class="tool-toggle"><input type="checkbox" name="Read" checked> Read</label>
                                <label class="tool-toggle"><input type="checkbox" name="Write" checked> Write</label>
                                <label class="tool-toggle"><input type="checkbox" name="Edit" checked> Edit</label>
                                <label class="tool-toggle"><input type="checkbox" name="Bash" checked> Bash</label>
                                <label class="tool-toggle"><input type="checkbox" name="Glob" checked> Glob</label>
                                <label class="tool-toggle"><input type="checkbox" name="Grep" checked> Grep</label>
                                <label class="tool-toggle"><input type="checkbox" name="WebSearch" checked> WebSearch</label>
                                <label class="tool-toggle"><input type="checkbox" name="WebFetch" checked> WebFetch</label>
                                <label class="tool-toggle"><input type="checkbox" name="Task" checked> Task</label>
                                <label class="tool-toggle"><input type="checkbox" name="GIF" checked> GIF</label>
                                <label class="tool-toggle"><input type="checkbox" name="Memory" checked> Memory</label>
                            </div>
                            <span class="setting-description">Toggle tools on/off to control what the agent can use.</span>
                        </div>
                    </div>
                </div>
                <div class="project-settings-footer">
                    <button class="btn-secondary" id="project-settings-cancel">Cancel</button>
                    <button class="btn-primary" id="project-settings-save">Save Settings</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
    },

    /**
     * Bind event handlers
     */
    bindEvents() {
        const modal = document.getElementById('project-settings-modal');

        // Close button
        modal.querySelector('.project-settings-close').addEventListener('click', () => this.close());
        modal.querySelector('.project-settings-overlay').addEventListener('click', () => this.close());
        modal.querySelector('#project-settings-cancel').addEventListener('click', () => this.close());

        // Save button
        modal.querySelector('#project-settings-save').addEventListener('click', () => this.save());

        // Tab switching
        modal.querySelectorAll('.project-settings-tab').forEach(tab => {
            tab.addEventListener('click', (e) => {
                const tabName = e.target.dataset.tab;
                this.switchTab(tabName);
            });
        });

        // Range input updates with value sync
        const thinkingBudgetSlider = modal.querySelector('#project-normal-thinking-budget');
        const maxTokensSlider = modal.querySelector('#project-normal-max-tokens');
        const thinkingToggle = modal.querySelector('#project-normal-thinking-enabled');

        // Thinking budget - if increased above max_tokens, raise max_tokens
        thinkingBudgetSlider.addEventListener('input', (e) => {
            const thinkingBudget = parseInt(e.target.value);
            modal.querySelector('#project-thinking-budget-value').textContent = thinkingBudget;

            if (thinkingToggle.checked && parseInt(maxTokensSlider.value) < thinkingBudget) {
                maxTokensSlider.value = thinkingBudget;
                modal.querySelector('#project-max-tokens-value').textContent = thinkingBudget;
            }
        });

        // Max tokens - if decreased below thinking_budget, lower thinking_budget
        maxTokensSlider.addEventListener('input', (e) => {
            const value = parseInt(e.target.value);
            modal.querySelector('#project-max-tokens-value').textContent = value;

            if (thinkingToggle.checked && parseInt(thinkingBudgetSlider.value) > value) {
                thinkingBudgetSlider.value = value;
                modal.querySelector('#project-thinking-budget-value').textContent = value;
            }
        });

        modal.querySelector('#project-normal-temperature').addEventListener('input', (e) => {
            modal.querySelector('#project-temperature-value').textContent = e.target.value;
        });

        // Thinking enabled toggle - sync values when enabled
        thinkingToggle.addEventListener('change', (e) => {
            modal.querySelector('#project-thinking-budget-group').style.display = e.target.checked ? 'block' : 'none';
            if (e.target.checked) {
                const thinkingBudget = parseInt(thinkingBudgetSlider.value);
                const maxTokens = parseInt(maxTokensSlider.value);
                if (maxTokens < thinkingBudget) {
                    maxTokensSlider.value = thinkingBudget;
                    modal.querySelector('#project-max-tokens-value').textContent = thinkingBudget;
                }
            }
        });

        // Agent thinking budget slider
        const agentThinkingBudget = modal.querySelector('#project-agent-thinking-budget');
        if (agentThinkingBudget) {
            agentThinkingBudget.addEventListener('input', (e) => {
                modal.querySelector('#project-agent-thinking-budget-value').textContent = e.target.value;
            });
        }
    },

    /**
     * Switch between tabs
     */
    switchTab(tabName) {
        const modal = document.getElementById('project-settings-modal');

        // Update tab buttons
        modal.querySelectorAll('.project-settings-tab').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.tab === tabName);
        });

        // Update panels
        modal.querySelectorAll('.project-settings-panel').forEach(panel => {
            panel.classList.toggle('active', panel.dataset.panel === tabName);
        });
    },

    /**
     * Populate model select options
     */
    populateModels() {
        const modal = document.getElementById('project-settings-modal');
        const normalSelect = modal.querySelector('#project-normal-model');
        const agentSelect = modal.querySelector('#project-agent-model');

        [normalSelect, agentSelect].forEach(select => {
            select.innerHTML = '';
            this.models.forEach(model => {
                const option = document.createElement('option');
                option.value = model.id;
                option.textContent = model.name;
                select.appendChild(option);
            });
        });
    },

    /**
     * Open settings for a project
     */
    async openForProject(project) {
        this.currentProjectId = project.id;
        this.currentProject = project;

        // Fetch project settings
        try {
            const response = await fetch(`/api/settings/project/${project.id}`);
            const data = await response.json();
            this.settings = data.settings || {};
        } catch (error) {
            console.error('Failed to load project settings:', error);
            this.settings = {};
        }

        this.populateModels();
        this.loadSettingsIntoForm();

        const modal = document.getElementById('project-settings-modal');
        modal.querySelector('.project-settings-name').textContent = project.name;
        modal.classList.add('open');
        this.isOpen = true;
    },

    /**
     * Load settings into form fields
     */
    loadSettingsIntoForm() {
        const modal = document.getElementById('project-settings-modal');
        const s = this.settings;

        // Normal chat settings
        if (s.normal_model) {
            modal.querySelector('#project-normal-model').value = s.normal_model;
        }
        modal.querySelector('#project-normal-system-prompt').value = s.normal_system_prompt || '';
        modal.querySelector('#project-normal-thinking-enabled').checked = s.normal_thinking_enabled !== false;
        modal.querySelector('#project-normal-thinking-budget').value = s.normal_thinking_budget || 60000;
        modal.querySelector('#project-thinking-budget-value').textContent = s.normal_thinking_budget || 60000;
        modal.querySelector('#project-normal-max-tokens').value = s.normal_max_tokens || 64000;
        modal.querySelector('#project-max-tokens-value').textContent = s.normal_max_tokens || 64000;
        modal.querySelector('#project-normal-temperature').value = s.normal_temperature ?? 1.0;
        modal.querySelector('#project-temperature-value').textContent = s.normal_temperature ?? 1.0;

        // Show/hide thinking budget based on enabled state
        modal.querySelector('#project-thinking-budget-group').style.display =
            s.normal_thinking_enabled !== false ? 'block' : 'none';

        // Agent settings
        if (s.agent_model) {
            modal.querySelector('#project-agent-model').value = s.agent_model;
        }
        modal.querySelector('#project-agent-system-prompt').value = s.agent_system_prompt || '';
        modal.querySelector('#project-agent-cwd').value = s.agent_cwd || '';

        // Agent thinking budget
        const agentThinkingBudget = modal.querySelector('#project-agent-thinking-budget');
        if (agentThinkingBudget) {
            agentThinkingBudget.value = s.agent_thinking_budget || 32000;
            const valueDisplay = modal.querySelector('#project-agent-thinking-budget-value');
            if (valueDisplay) {
                valueDisplay.textContent = agentThinkingBudget.value;
            }
        }

        // Load tool toggles
        const toolToggles = modal.querySelectorAll('#project-agent-tools input[type="checkbox"]');
        const agentTools = s.agent_tools || {};
        toolToggles.forEach(checkbox => {
            const toolName = checkbox.name;
            // Default to true (enabled) if not specified
            checkbox.checked = agentTools[toolName] !== false;
        });
    },

    /**
     * Save settings
     */
    async save() {
        const modal = document.getElementById('project-settings-modal');

        const settings = {
            // Normal chat settings
            normal_model: modal.querySelector('#project-normal-model').value,
            normal_system_prompt: modal.querySelector('#project-normal-system-prompt').value || null,
            normal_thinking_enabled: modal.querySelector('#project-normal-thinking-enabled').checked,
            normal_thinking_budget: parseInt(modal.querySelector('#project-normal-thinking-budget').value),
            normal_max_tokens: parseInt(modal.querySelector('#project-normal-max-tokens').value),
            normal_temperature: parseFloat(modal.querySelector('#project-normal-temperature').value),
            normal_top_p: 1.0,
            normal_top_k: 0,
            normal_prune_threshold: 0.7,

            // Agent settings
            agent_model: modal.querySelector('#project-agent-model').value,
            agent_system_prompt: modal.querySelector('#project-agent-system-prompt').value || null,
            agent_cwd: modal.querySelector('#project-agent-cwd').value || null,
            agent_thinking_budget: parseInt(modal.querySelector('#project-agent-thinking-budget')?.value) || 8000,
            agent_tools: this.getToolToggles()
        };

        try {
            const response = await fetch(`/api/settings/project/${this.currentProjectId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(settings)
            });

            if (response.ok) {
                this.close();
            } else {
                alert('Failed to save project settings');
            }
        } catch (error) {
            console.error('Failed to save project settings:', error);
            alert('Failed to save project settings');
        }
    },

    /**
     * Get tool toggle values as object
     */
    getToolToggles() {
        const modal = document.getElementById('project-settings-modal');
        const toolToggles = modal.querySelectorAll('#project-agent-tools input[type="checkbox"]');
        const tools = {};
        toolToggles.forEach(checkbox => {
            tools[checkbox.name] = checkbox.checked;
        });
        return tools;
    },

    /**
     * Close the modal
     */
    close() {
        const modal = document.getElementById('project-settings-modal');
        modal.classList.remove('open');
        this.isOpen = false;
        this.currentProjectId = null;
        this.currentProject = null;
    }
};

```

---

### `static/js/projects.js`

**Purpose:** Project management UI (create, switch, delete projects)

```javascript
/**
 * Projects management module for organizing conversations into folders
 */

const ProjectsManager = {
    projects: [],
    expandedProjects: new Set(),
    conversationProjectMap: {},  // conv_id -> project_id
    renamingProjectId: null,
    draggedConversationId: null,

    // Preset colors for projects
    presetColors: [
        '#C15F3C',  // rust/primary
        '#4A9B7F',  // green
        '#5B8DEF',  // blue
        '#9B59B6',  // purple
        '#E67E22',  // orange
        '#1ABC9C',  // teal
    ],

    /**
     * Initialize the projects manager
     */
    async init() {
        // Load expanded state from localStorage
        const savedExpanded = localStorage.getItem('expandedProjects');
        if (savedExpanded) {
            try {
                this.expandedProjects = new Set(JSON.parse(savedExpanded));
            } catch (e) {
                this.expandedProjects = new Set();
            }
        }

        await this.loadProjects();
        this.bindEvents();
    },

    /**
     * Bind DOM events
     */
    bindEvents() {
        // New project button
        const newProjectBtn = document.getElementById('new-project-btn');
        if (newProjectBtn) {
            newProjectBtn.addEventListener('click', () => this.promptCreateProject());
        }

        // Global click handler to close dropdown menus
        document.addEventListener('click', (e) => {
            // Don't close if clicking on a menu button (that's handled separately)
            if (e.target.closest('.project-menu-btn')) return;
            // Close all open dropdowns
            document.querySelectorAll('.project-menu-dropdown.open').forEach(m => {
                m.classList.remove('open');
            });
        });

        // Setup drop zone for removing conversations from projects
        const conversationsList = document.getElementById('conversations-list');
        if (conversationsList) {
            conversationsList.addEventListener('dragover', (e) => {
                if (this.draggedConversationId) {
                    e.preventDefault();
                    conversationsList.classList.add('drag-over');
                }
            });

            conversationsList.addEventListener('dragleave', (e) => {
                if (!conversationsList.contains(e.relatedTarget)) {
                    conversationsList.classList.remove('drag-over');
                }
            });

            conversationsList.addEventListener('drop', async (e) => {
                e.preventDefault();
                conversationsList.classList.remove('drag-over');

                if (this.draggedConversationId) {
                    const currentProjectId = this.conversationProjectMap[this.draggedConversationId];
                    if (currentProjectId) {
                        await this.removeConversationFromProject(currentProjectId, this.draggedConversationId);
                    }
                }
            });
        }
    },

    /**
     * Load all projects from server
     */
    async loadProjects() {
        try {
            const [projectsResponse, mapResponse] = await Promise.all([
                fetch('/api/projects'),
                fetch('/api/projects/conversation-map')
            ]);

            const projectsData = await projectsResponse.json();
            const mapData = await mapResponse.json();

            this.projects = projectsData.projects || [];
            this.conversationProjectMap = mapData.map || {};

            this.renderProjects();
        } catch (error) {
            console.error('Failed to load projects:', error);
        }
    },

    /**
     * Prompt user to create a new project
     */
    promptCreateProject() {
        const name = prompt('Enter project name:');
        if (name && name.trim()) {
            this.createProject(name.trim());
        }
    },

    /**
     * Create a new project with default settings
     */
    async createProject(name, color = '#C15F3C') {
        try {
            // Create the project first
            const response = await fetch('/api/projects', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, color })
            });

            const project = await response.json();

            // Initialize project settings from current defaults
            await fetch(`/api/settings/project/${project.id}/init`, {
                method: 'POST'
            });

            this.projects.unshift(project);
            this.expandedProjects.add(project.id);
            this.saveExpandedState();
            this.renderProjects();

            return project;
        } catch (error) {
            console.error('Failed to create project:', error);
            throw error;
        }
    },

    /**
     * Update a project
     */
    async updateProject(projectId, name = null, color = null) {
        try {
            const body = {};
            if (name !== null) body.name = name;
            if (color !== null) body.color = color;

            await fetch(`/api/projects/${projectId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });

            // Update local state
            const project = this.projects.find(p => p.id === projectId);
            if (project) {
                if (name !== null) project.name = name;
                if (color !== null) project.color = color;
                this.renderProjects();
            }
        } catch (error) {
            console.error('Failed to update project:', error);
        }
    },

    /**
     * Delete a project
     */
    async deleteProject(projectId) {
        if (!confirm('Delete this project? Conversations will be kept.')) {
            return;
        }

        try {
            await fetch(`/api/projects/${projectId}`, { method: 'DELETE' });

            // Remove from local state
            const project = this.projects.find(p => p.id === projectId);
            if (project) {
                // Clear conversation mappings
                project.conversation_ids.forEach(convId => {
                    delete this.conversationProjectMap[convId];
                });
            }

            this.projects = this.projects.filter(p => p.id !== projectId);
            this.expandedProjects.delete(projectId);
            this.saveExpandedState();
            this.renderProjects();

            // Re-render conversations list to show unorganized conversations
            if (typeof ConversationsManager !== 'undefined') {
                ConversationsManager.renderConversationsList();
            }
        } catch (error) {
            console.error('Failed to delete project:', error);
        }
    },

    /**
     * Add a conversation to a project
     */
    async addConversationToProject(projectId, conversationId) {
        try {
            await fetch(`/api/projects/${projectId}/conversations`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ conversation_id: conversationId })
            });

            // Update local state
            // Remove from previous project if any
            const prevProjectId = this.conversationProjectMap[conversationId];
            if (prevProjectId) {
                const prevProject = this.projects.find(p => p.id === prevProjectId);
                if (prevProject) {
                    prevProject.conversation_ids = prevProject.conversation_ids.filter(id => id !== conversationId);
                }
            }

            // Add to new project
            const project = this.projects.find(p => p.id === projectId);
            if (project && !project.conversation_ids.includes(conversationId)) {
                project.conversation_ids.unshift(conversationId);
            }
            this.conversationProjectMap[conversationId] = projectId;

            // Auto-expand the project
            this.expandedProjects.add(projectId);
            this.saveExpandedState();

            this.renderProjects();

            // Re-render conversations list
            if (typeof ConversationsManager !== 'undefined') {
                ConversationsManager.renderConversationsList();
            }
        } catch (error) {
            console.error('Failed to add conversation to project:', error);
        }
    },

    /**
     * Remove a conversation from a project
     */
    async removeConversationFromProject(projectId, conversationId) {
        try {
            await fetch(`/api/projects/${projectId}/conversations/${conversationId}`, {
                method: 'DELETE'
            });

            // Update local state
            const project = this.projects.find(p => p.id === projectId);
            if (project) {
                project.conversation_ids = project.conversation_ids.filter(id => id !== conversationId);
            }
            delete this.conversationProjectMap[conversationId];

            this.renderProjects();

            // Re-render conversations list
            if (typeof ConversationsManager !== 'undefined') {
                ConversationsManager.renderConversationsList();
            }
        } catch (error) {
            console.error('Failed to remove conversation from project:', error);
        }
    },

    /**
     * Toggle project expanded/collapsed state
     */
    toggleProject(projectId) {
        if (this.expandedProjects.has(projectId)) {
            this.expandedProjects.delete(projectId);
        } else {
            this.expandedProjects.add(projectId);
        }
        this.saveExpandedState();
        this.renderProjects();
    },

    /**
     * Save expanded state to localStorage
     */
    saveExpandedState() {
        localStorage.setItem('expandedProjects', JSON.stringify([...this.expandedProjects]));
    },

    /**
     * Check if a conversation is in any project
     */
    isConversationInProject(conversationId) {
        return conversationId in this.conversationProjectMap;
    },

    /**
     * Get conversations that are not in any project
     */
    getUnorganizedConversations(allConversations) {
        return allConversations.filter(conv => !this.isConversationInProject(conv.id));
    },

    /**
     * Get the project ID of the currently selected conversation (if any)
     */
    getCurrentProjectId() {
        if (typeof ConversationsManager !== 'undefined' && ConversationsManager.currentConversationId) {
            return this.conversationProjectMap[ConversationsManager.currentConversationId] || null;
        }
        return null;
    },

    /**
     * Render the projects section
     */
    renderProjects() {
        const container = document.getElementById('projects-section');
        if (!container) return;

        container.innerHTML = '';

        if (this.projects.length === 0) {
            return;  // Don't show anything if no projects
        }

        // Get all conversations for lookup
        const allConversations = typeof ConversationsManager !== 'undefined'
            ? ConversationsManager.conversations
            : [];
        const conversationsMap = {};
        allConversations.forEach(conv => {
            conversationsMap[conv.id] = conv;
        });

        this.projects.forEach(project => {
            const isExpanded = this.expandedProjects.has(project.id);

            // Filter out non-existent conversations
            const validConvIds = project.conversation_ids.filter(id => id in conversationsMap);

            const projectEl = document.createElement('div');
            projectEl.className = `project-item${isExpanded ? ' expanded' : ''}`;
            projectEl.dataset.projectId = project.id;

            // Check if any conversations are agent conversations (have memory)
            const hasAgentConversations = validConvIds.some(id => {
                const conv = conversationsMap[id];
                return conv && conv.is_agent;
            });

            // Project header
            const header = document.createElement('div');
            header.className = 'project-header';
            header.innerHTML = `
                <span class="project-expand-icon">${isExpanded ? '&#9660;' : '&#9654;'}</span>
                <span class="project-color-dot" style="background-color: ${project.color}"></span>
                <span class="project-name">${this.escapeHtml(project.name)}</span>
                ${hasAgentConversations ? '<span class="project-memory-icon" title="Shared memory for agent chats">&#129504;</span>' : ''}
                <span class="project-count">(${validConvIds.length})</span>
                <div class="project-actions">
                    <button class="project-new-chat-btn" title="New Chat">+</button>
                    <button class="project-new-agent-btn" title="New Agent Chat">+</button>
                    <div class="project-menu-container">
                        <button class="project-menu-btn" title="More options">&#8942;</button>
                        <div class="project-menu-dropdown">
                            <button class="project-menu-item project-settings-btn" title="Settings">&#9881;</button>
                            <button class="project-menu-item project-color-btn" title="Change color">&#127912;</button>
                            <button class="project-menu-item project-rename-btn" title="Rename">&#9998;</button>
                            <button class="project-menu-item project-delete-btn" title="Delete">&#128465;</button>
                        </div>
                    </div>
                </div>
            `;

            // Header click to toggle
            header.addEventListener('click', (e) => {
                if (!e.target.closest('.project-actions')) {
                    this.toggleProject(project.id);
                }
            });

            // Drag and drop handlers for header
            header.addEventListener('dragover', (e) => {
                if (this.draggedConversationId) {
                    e.preventDefault();
                    header.classList.add('drag-over');
                }
            });

            header.addEventListener('dragleave', () => {
                header.classList.remove('drag-over');
            });

            header.addEventListener('drop', async (e) => {
                e.preventDefault();
                header.classList.remove('drag-over');

                if (this.draggedConversationId) {
                    await this.addConversationToProject(project.id, this.draggedConversationId);
                }
            });

            // New Chat button (blue)
            header.querySelector('.project-new-chat-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                this.createConversationInProject(project.id, false);
            });

            // New Agent Chat button (orange) - with shift-click support
            header.querySelector('.project-new-agent-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                if (e.shiftKey) {
                    // Shift+click: show settings popup with project context
                    if (typeof QuickAgentSettings !== 'undefined') {
                        QuickAgentSettings.open(project.id);
                    }
                } else {
                    // Normal click: create agent chat directly
                    this.createConversationInProject(project.id, true);
                }
            });

            // Menu button
            const menuBtn = header.querySelector('.project-menu-btn');
            const menuDropdown = header.querySelector('.project-menu-dropdown');

            menuBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                // Close other open menus
                document.querySelectorAll('.project-menu-dropdown.open').forEach(m => {
                    if (m !== menuDropdown) m.classList.remove('open');
                });

                // Position the dropdown to the right of the button
                const rect = menuBtn.getBoundingClientRect();
                menuDropdown.style.top = `${rect.top + rect.height / 2}px`;
                menuDropdown.style.left = `${rect.right + 4}px`;
                menuDropdown.style.transform = 'translateY(-50%)';

                menuDropdown.classList.toggle('open');
            });

            // Action buttons in menu
            header.querySelector('.project-settings-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                menuDropdown.classList.remove('open');
                this.openProjectSettings(project.id);
            });

            header.querySelector('.project-color-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                menuDropdown.classList.remove('open');
                this.showColorPicker(project.id, menuBtn);
            });

            header.querySelector('.project-rename-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                menuDropdown.classList.remove('open');
                this.startRename(project.id, header.querySelector('.project-name'));
            });

            header.querySelector('.project-delete-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                menuDropdown.classList.remove('open');
                this.deleteProject(project.id);
            });

            projectEl.appendChild(header);

            // Project conversations (if expanded)
            if (isExpanded) {
                const convList = document.createElement('div');
                convList.className = 'project-conversations';

                if (validConvIds.length === 0) {
                    convList.innerHTML = '<div class="project-empty">Drag conversations here</div>';
                } else {
                    validConvIds.forEach(convId => {
                        const conv = conversationsMap[convId];
                        if (!conv) return;

                        const convItem = this.createConversationItem(conv, project.id);
                        convList.appendChild(convItem);
                    });
                }

                // Make the list a drop zone too
                convList.addEventListener('dragover', (e) => {
                    if (this.draggedConversationId) {
                        e.preventDefault();
                        convList.classList.add('drag-over');
                    }
                });

                convList.addEventListener('dragleave', (e) => {
                    if (!convList.contains(e.relatedTarget)) {
                        convList.classList.remove('drag-over');
                    }
                });

                convList.addEventListener('drop', async (e) => {
                    e.preventDefault();
                    convList.classList.remove('drag-over');

                    if (this.draggedConversationId) {
                        await this.addConversationToProject(project.id, this.draggedConversationId);
                    }
                });

                projectEl.appendChild(convList);
            }

            container.appendChild(projectEl);
        });
    },

    /**
     * Create a conversation item element
     */
    createConversationItem(conv, projectId) {
        const item = document.createElement('div');
        const isActive = typeof ConversationsManager !== 'undefined' &&
            conv.id === ConversationsManager.currentConversationId;

        item.className = `conversation-item project-conversation${isActive ? ' active' : ''}${conv.is_agent ? ' agent' : ''}`;
        item.dataset.id = conv.id;
        item.dataset.projectId = projectId;
        item.draggable = true;

        const agentIcon = conv.is_agent ? '<img src="/static/favicon.png" alt="Agent" class="agent-icon" title="Agent Chat">' : '';

        item.innerHTML = `
            ${agentIcon}
            <span class="conversation-title">${this.escapeHtml(conv.title)}</span>
            <div class="conversation-actions">
                <button class="conversation-rename" title="Rename">&#9998;</button>
                <button class="conversation-settings" title="Settings">&#9881;</button>
                <button class="conversation-remove-from-project" title="Remove from project">&#10006;</button>
            </div>
        `;

        const titleEl = item.querySelector('.conversation-title');

        // Click to select conversation
        item.addEventListener('click', (e) => {
            if (!e.target.classList.contains('conversation-remove-from-project') &&
                !e.target.classList.contains('conversation-settings') &&
                !e.target.classList.contains('conversation-rename')) {
                if (typeof ConversationsManager !== 'undefined') {
                    ConversationsManager.selectConversation(conv.id);
                }
            }
        });

        // Double-click to rename
        titleEl.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            this.startConversationRename(conv.id, titleEl);
        });

        // Rename button
        item.querySelector('.conversation-rename').addEventListener('click', (e) => {
            e.stopPropagation();
            this.startConversationRename(conv.id, titleEl);
        });

        // Settings button - open settings panel for this conversation
        item.querySelector('.conversation-settings').addEventListener('click', async (e) => {
            e.stopPropagation();
            // Select the conversation first
            if (typeof ConversationsManager !== 'undefined') {
                await ConversationsManager.selectConversation(conv.id);
            }
            // Open settings panel
            if (typeof SettingsManager !== 'undefined' && !SettingsManager.isOpen) {
                SettingsManager.togglePanel();
            }
        });

        // Remove from project button
        item.querySelector('.conversation-remove-from-project').addEventListener('click', (e) => {
            e.stopPropagation();
            this.removeConversationFromProject(projectId, conv.id);
        });

        // Drag handlers
        item.addEventListener('dragstart', (e) => {
            this.draggedConversationId = conv.id;
            item.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', conv.id);
        });

        item.addEventListener('dragend', () => {
            this.draggedConversationId = null;
            item.classList.remove('dragging');
            document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
        });

        return item;
    },

    /**
     * Start renaming a conversation in a project
     */
    startConversationRename(conversationId, titleEl) {
        const currentTitle = titleEl.textContent;
        const input = document.createElement('input');
        input.type = 'text';
        input.value = currentTitle;
        input.className = 'conversation-rename-input';

        titleEl.textContent = '';
        titleEl.appendChild(input);
        input.focus();
        input.select();

        const finishRename = async () => {
            const newTitle = input.value.trim();
            if (newTitle && newTitle !== currentTitle) {
                try {
                    await fetch(`/api/conversations/${conversationId}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ title: newTitle })
                    });

                    titleEl.textContent = newTitle;

                    // Update in ConversationsManager too
                    if (typeof ConversationsManager !== 'undefined') {
                        const conv = ConversationsManager.conversations.find(c => c.id === conversationId);
                        if (conv) {
                            conv.title = newTitle;
                            ConversationsManager.renderConversationsList();
                        }
                    }
                } catch (error) {
                    console.error('Failed to rename conversation:', error);
                    titleEl.textContent = currentTitle;
                }
            } else {
                titleEl.textContent = currentTitle;
            }
        };

        input.addEventListener('blur', finishRename);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                input.blur();
            } else if (e.key === 'Escape') {
                input.value = currentTitle;
                input.blur();
            }
        });
    },

    /**
     * Start renaming a project
     */
    startRename(projectId, nameEl) {
        if (this.renamingProjectId !== null) return;

        const project = this.projects.find(p => p.id === projectId);
        if (!project) return;

        this.renamingProjectId = projectId;

        const input = document.createElement('input');
        input.type = 'text';
        input.value = project.name;
        input.className = 'project-rename-input';

        const originalHtml = nameEl.innerHTML;
        nameEl.innerHTML = '';
        nameEl.appendChild(input);

        input.focus();
        input.select();

        const save = async () => {
            const newName = input.value.trim();
            if (newName && newName !== project.name) {
                await this.updateProject(projectId, newName);
            }
            this.renamingProjectId = null;
            this.renderProjects();
        };

        const cancel = () => {
            this.renamingProjectId = null;
            nameEl.innerHTML = originalHtml;
        };

        input.addEventListener('blur', save);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                save();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                cancel();
            }
        });
        input.addEventListener('click', (e) => e.stopPropagation());
    },

    /**
     * Show color picker for a project
     */
    showColorPicker(projectId, button) {
        // Remove any existing picker
        const existingPicker = document.querySelector('.project-color-picker');
        if (existingPicker) {
            existingPicker.remove();
        }

        const picker = document.createElement('div');
        picker.className = 'project-color-picker';

        this.presetColors.forEach(color => {
            const colorBtn = document.createElement('button');
            colorBtn.className = 'color-option';
            colorBtn.style.backgroundColor = color;
            colorBtn.addEventListener('click', () => {
                this.updateProject(projectId, null, color);
                picker.remove();
            });
            picker.appendChild(colorBtn);
        });

        // Position near the button
        const rect = button.getBoundingClientRect();
        picker.style.position = 'fixed';
        picker.style.top = `${rect.bottom + 4}px`;
        picker.style.left = `${rect.left}px`;

        document.body.appendChild(picker);

        // Close on click outside
        const closeHandler = (e) => {
            if (!picker.contains(e.target) && e.target !== button) {
                picker.remove();
                document.removeEventListener('click', closeHandler);
            }
        };
        setTimeout(() => document.addEventListener('click', closeHandler), 0);
    },

    /**
     * Escape HTML to prevent XSS
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    },

    /**
     * Create a new conversation directly inside a project using project settings
     */
    async createConversationInProject(projectId, isAgent = false) {
        try {
            // Fetch project settings from API
            const settingsResponse = await fetch(`/api/settings/project/${projectId}`);
            const settingsData = await settingsResponse.json();
            const projectSettings = settingsData.settings || {};

            const title = isAgent ? 'New Agent Chat' : 'New Conversation';

            // Build the request body using project settings
            const requestBody = {
                title,
                is_agent: isAgent
            };

            if (isAgent) {
                // Use project's agent settings
                if (projectSettings.agent_model) {
                    requestBody.model = projectSettings.agent_model;
                }
                if (projectSettings.agent_system_prompt) {
                    requestBody.system_prompt = projectSettings.agent_system_prompt;
                }
            } else {
                // Use project's normal chat settings
                if (projectSettings.normal_model) {
                    requestBody.model = projectSettings.normal_model;
                }
                if (projectSettings.normal_system_prompt) {
                    requestBody.system_prompt = projectSettings.normal_system_prompt;
                }
                requestBody.settings = {
                    thinking_enabled: projectSettings.normal_thinking_enabled ?? true,
                    thinking_budget: projectSettings.normal_thinking_budget ?? 60000,
                    max_tokens: projectSettings.normal_max_tokens ?? 64000,
                    temperature: projectSettings.normal_temperature ?? 1.0,
                    top_p: projectSettings.normal_top_p ?? 1.0,
                    top_k: projectSettings.normal_top_k ?? 0,
                    prune_threshold: projectSettings.normal_prune_threshold ?? 0.7
                };
            }

            // Create the conversation directly via API
            const response = await fetch('/api/conversations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody)
            });

            const conversation = await response.json();

            if (conversation && conversation.id) {
                // Add to ConversationsManager list
                if (typeof ConversationsManager !== 'undefined') {
                    ConversationsManager.conversations.unshift(conversation);
                    ConversationsManager.currentConversationId = conversation.id;
                    ConversationsManager.renderConversationsList();

                    // Update ChatManager
                    if (typeof ChatManager !== 'undefined') {
                        ChatManager.isAgentConversation = isAgent;
                        ChatManager.clearChat();
                        ChatManager.activeConversationId = conversation.id;
                        ChatManager.currentBranch = [0];
                    }

                    // Update SettingsManager
                    if (typeof SettingsManager !== 'undefined') {
                        SettingsManager.setMode(isAgent ? 'agent' : 'normal');
                        SettingsManager.loadConversationSettings(conversation);
                    }
                }

                // Add to project
                await this.addConversationToProject(projectId, conversation.id);
            }
        } catch (error) {
            console.error('Failed to create conversation in project:', error);
        }
    },

    /**
     * Open project settings panel
     */
    openProjectSettings(projectId) {
        const project = this.projects.find(p => p.id === projectId);
        if (!project) return;

        // Open the project settings modal
        if (typeof ProjectSettingsManager !== 'undefined') {
            ProjectSettingsManager.openForProject(project);
        }
    },

    /**
     * Setup drag handlers for a conversation item in the main list
     */
    setupDragHandlers(item, conversationId) {
        item.draggable = true;

        item.addEventListener('dragstart', (e) => {
            this.draggedConversationId = conversationId;
            item.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', conversationId);
        });

        item.addEventListener('dragend', () => {
            this.draggedConversationId = null;
            item.classList.remove('dragging');
            document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
        });
    }
};

```

---

### `static/js/prompts.js`

**Purpose:** System prompt management and templates

```javascript
/**
 * Prompt Library Manager
 */
const PromptLibrary = {
    prompts: [],
    editingPromptId: null,

    /**
     * Initialize the prompt library
     */
    init() {
        this.loadPrompts();
        this.addDefaultPrompts();
        this.renderPromptList();
        this.bindEvents();
    },

    /**
     * Add default prompts if library is empty
     */
    addDefaultPrompts() {
        if (this.prompts.length === 0) {
            this.prompts = [
                {
                    id: this.generateId(),
                    name: 'Summarize Academic Paper',
                    content: 'Please provide a comprehensive summary of this academic paper. Include:\n\n1. Main research question and objectives\n2. Methodology used\n3. Key findings and results\n4. Conclusions and implications\n5. Limitations and future research directions\n\nPresent the summary in a clear, structured format suitable for quick understanding.'
                },
                {
                    id: this.generateId(),
                    name: 'Code Review',
                    content: 'Please review this code for:\n\n1. Code quality and readability\n2. Potential bugs or issues\n3. Performance considerations\n4. Security concerns\n5. Best practices and design patterns\n6. Suggestions for improvement\n\nProvide specific, actionable feedback with examples where appropriate.'
                },
                {
                    id: this.generateId(),
                    name: 'Explain Like I\'m 5',
                    content: 'Please explain this concept in simple terms that a 5-year-old could understand. Use analogies, simple language, and relatable examples. Avoid technical jargon.'
                }
            ];
            this.savePrompts();
            this.renderPromptList();
        }
    },

    /**
     * Bind DOM events
     */
    bindEvents() {
        // Add prompt button in settings (sidebar)
        const addBtn = document.getElementById('add-prompt-btn');
        if (addBtn) {
            addBtn.addEventListener('click', () => {
                this.showEditModal();
            });
        }

        // Add prompt button in default settings modal
        const defaultAddBtn = document.getElementById('default-add-prompt-btn');
        if (defaultAddBtn) {
            defaultAddBtn.addEventListener('click', () => {
                this.showEditModal();
            });
        }

        // Prompts button near input
        const promptsBtn = document.getElementById('prompts-btn');
        if (promptsBtn) {
            promptsBtn.addEventListener('click', () => {
                this.showPromptLibraryModal();
            });
        }

        // Close modals
        const closeLibraryBtn = document.getElementById('close-prompt-library');
        if (closeLibraryBtn) {
            closeLibraryBtn.addEventListener('click', () => {
                this.closePromptLibraryModal();
            });
        }

        const closeEditBtn = document.getElementById('close-edit-prompt');
        if (closeEditBtn) {
            closeEditBtn.addEventListener('click', () => {
                this.closeEditModal();
            });
        }

        // Close on overlay click
        const libraryModal = document.getElementById('prompt-library-modal');
        if (libraryModal) {
            libraryModal.addEventListener('click', (e) => {
                if (e.target.id === 'prompt-library-modal') {
                    this.closePromptLibraryModal();
                }
            });
        }

        const editModal = document.getElementById('edit-prompt-modal');
        if (editModal) {
            editModal.addEventListener('click', (e) => {
                if (e.target.id === 'edit-prompt-modal') {
                    this.closeEditModal();
                }
            });
        }

        // Save/cancel buttons
        const saveBtn = document.getElementById('save-prompt');
        if (saveBtn) {
            saveBtn.addEventListener('click', () => {
                this.savePrompt();
            });
        }

        const cancelBtn = document.getElementById('cancel-edit-prompt');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => {
                this.closeEditModal();
            });
        }

        // ESC to close modals
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                if (document.getElementById('prompt-library-modal').classList.contains('visible')) {
                    this.closePromptLibraryModal();
                }
                if (document.getElementById('edit-prompt-modal').classList.contains('visible')) {
                    this.closeEditModal();
                }
            }
        });
    },

    /**
     * Generate unique ID
     */
    generateId() {
        return Date.now().toString(36) + Math.random().toString(36).substr(2);
    },

    /**
     * Load prompts from localStorage
     */
    loadPrompts() {
        const stored = localStorage.getItem('promptLibrary');
        if (stored) {
            try {
                this.prompts = JSON.parse(stored);
            } catch (error) {
                console.error('Failed to load prompts:', error);
                this.prompts = [];
            }
        }
    },

    /**
     * Save prompts to localStorage
     */
    savePrompts() {
        localStorage.setItem('promptLibrary', JSON.stringify(this.prompts));
    },

    /**
     * Render prompt list in settings panel
     */
    renderPromptList() {
        // Render in both sidebar settings and default settings modal
        const containers = [
            document.getElementById('prompt-library-list'),
            document.getElementById('default-prompt-library-list')
        ].filter(c => c !== null);

        containers.forEach(container => {
            container.innerHTML = '';

            if (this.prompts.length === 0) {
                container.innerHTML = '<p style="color: var(--color-text-secondary); font-size: 13px; padding: 8px 0;">No prompts saved yet.</p>';
                return;
            }

            this.prompts.forEach(prompt => {
                const item = document.createElement('div');
                item.className = 'prompt-item';
                item.innerHTML = `
                    <div class="prompt-item-header">
                        <span class="prompt-name">${this.escapeHtml(prompt.name)}</span>
                        <div class="prompt-actions">
                            <button class="prompt-action-btn insert-btn" title="Insert">↩</button>
                            <button class="prompt-action-btn edit-btn" title="Edit">✏️</button>
                            <button class="prompt-action-btn delete-btn" title="Delete">&times;</button>
                        </div>
                    </div>
                    <div class="prompt-preview">${this.escapeHtml(this.truncate(prompt.content, 100))}</div>
                `;

                // Insert button
                item.querySelector('.insert-btn').addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.insertPrompt(prompt.id);
                });

                // Edit button
                item.querySelector('.edit-btn').addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.showEditModal(prompt.id);
                });

                // Delete button
                item.querySelector('.delete-btn').addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.deletePrompt(prompt.id);
                });

                container.appendChild(item);
            });
        });
    },

    /**
     * Render prompt list in modal
     */
    renderPromptLibraryModal() {
        const container = document.getElementById('prompt-library-modal-list');
        container.innerHTML = '';

        if (this.prompts.length === 0) {
            container.innerHTML = '<p style="color: var(--color-text-secondary); text-align: center; padding: 20px;">No prompts saved yet. Add prompts in Settings.</p>';
            return;
        }

        this.prompts.forEach(prompt => {
            const item = document.createElement('div');
            item.className = 'prompt-modal-item';
            item.innerHTML = `
                <div class="prompt-modal-header">
                    <span class="prompt-modal-name">${this.escapeHtml(prompt.name)}</span>
                </div>
                <div class="prompt-modal-content">${this.escapeHtml(prompt.content)}</div>
                <div class="prompt-modal-actions">
                    <button class="btn btn-small insert-modal-btn">Insert</button>
                </div>
            `;

            // Insert button
            item.querySelector('.insert-modal-btn').addEventListener('click', () => {
                this.insertPrompt(prompt.id);
                this.closePromptLibraryModal();
            });

            container.appendChild(item);
        });
    },

    /**
     * Show prompt library modal
     */
    showPromptLibraryModal() {
        this.renderPromptLibraryModal();
        document.getElementById('prompt-library-modal').classList.add('visible');
    },

    /**
     * Close prompt library modal
     */
    closePromptLibraryModal() {
        document.getElementById('prompt-library-modal').classList.remove('visible');
    },

    /**
     * Show edit/add prompt modal
     */
    showEditModal(promptId = null) {
        this.editingPromptId = promptId;

        const titleEl = document.getElementById('edit-prompt-title');
        const nameInput = document.getElementById('prompt-name');
        const contentInput = document.getElementById('prompt-content');

        if (promptId) {
            const prompt = this.prompts.find(p => p.id === promptId);
            if (prompt) {
                titleEl.textContent = 'Edit Prompt';
                nameInput.value = prompt.name;
                contentInput.value = prompt.content;
            }
        } else {
            titleEl.textContent = 'Add Prompt';
            nameInput.value = '';
            contentInput.value = '';
        }

        document.getElementById('edit-prompt-modal').classList.add('visible');
        nameInput.focus();
    },

    /**
     * Close edit modal
     */
    closeEditModal() {
        document.getElementById('edit-prompt-modal').classList.remove('visible');
        this.editingPromptId = null;
    },

    /**
     * Save prompt (add or update)
     */
    savePrompt() {
        const name = document.getElementById('prompt-name').value.trim();
        const content = document.getElementById('prompt-content').value.trim();

        if (!name || !content) {
            alert('Please enter both name and content');
            return;
        }

        if (this.editingPromptId) {
            // Update existing
            const prompt = this.prompts.find(p => p.id === this.editingPromptId);
            if (prompt) {
                prompt.name = name;
                prompt.content = content;
            }
        } else {
            // Add new
            this.prompts.push({
                id: this.generateId(),
                name,
                content
            });
        }

        this.savePrompts();
        this.renderPromptList();
        this.closeEditModal();
    },

    /**
     * Delete prompt
     */
    deletePrompt(promptId) {
        if (!confirm('Delete this prompt?')) {
            return;
        }

        this.prompts = this.prompts.filter(p => p.id !== promptId);
        this.savePrompts();
        this.renderPromptList();
    },

    /**
     * Insert prompt into message input
     */
    insertPrompt(promptId) {
        const prompt = this.prompts.find(p => p.id === promptId);
        if (!prompt) return;

        const input = document.getElementById('message-input');
        const currentValue = input.value.trim();

        if (currentValue) {
            input.value = currentValue + '\n\n' + prompt.content;
        } else {
            input.value = prompt.content;
        }

        // Trigger input event to update UI
        input.dispatchEvent(new Event('input'));
        input.focus();

        // Scroll to bottom of textarea
        input.scrollTop = input.scrollHeight;
    },

    /**
     * Truncate text
     */
    truncate(text, length) {
        if (text.length <= length) return text;
        return text.substring(0, length) + '...';
    },

    /**
     * Escape HTML
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
};

```

---

### `static/js/quick-agent-settings.js`

**Purpose:** Quick access settings panel for agent configuration

```javascript
/**
 * Quick Agent Settings Module
 * Handles the shift+click popup for creating agent chats with custom settings
 */

const QuickAgentSettings = {
    isOpen: false,
    projectId: null,
    models: [],

    /**
     * Initialize the quick agent settings module
     */
    init() {
        this.bindEvents();
    },

    /**
     * Bind event handlers
     */
    bindEvents() {
        // Close button
        document.getElementById('close-quick-agent')?.addEventListener('click', () => {
            this.close();
        });

        // Cancel button
        document.getElementById('cancel-quick-agent')?.addEventListener('click', () => {
            this.close();
        });

        // Create button
        document.getElementById('create-quick-agent')?.addEventListener('click', () => {
            this.createChat();
        });

        // Click outside to close
        document.getElementById('quick-agent-modal')?.addEventListener('click', (e) => {
            if (e.target.id === 'quick-agent-modal') {
                this.close();
            }
        });
    },

    /**
     * Load models for the dropdown
     */
    async loadModels() {
        if (this.models.length > 0) return; // Already loaded

        try {
            const response = await fetch('/api/chat/models');
            const data = await response.json();
            this.models = data.models || [];
        } catch (error) {
            console.error('Failed to load models:', error);
        }
    },

    /**
     * Render model dropdown
     */
    renderModels() {
        const select = document.getElementById('quick-agent-model');
        if (!select) return;

        select.innerHTML = '';
        this.models.forEach(model => {
            const option = document.createElement('option');
            option.value = model.id;
            option.textContent = model.name;
            select.appendChild(option);
        });
    },

    /**
     * Open the quick agent settings modal
     * @param {string|null} projectId - Optional project ID to load settings from
     */
    async open(projectId = null) {
        this.projectId = projectId;
        this.isOpen = true;

        // Load models if needed
        await this.loadModels();
        this.renderModels();

        // Load settings (project or default)
        const settings = await this.loadSettings(projectId);
        this.applySettings(settings);

        // Show modal
        document.getElementById('quick-agent-modal').classList.add('visible');
    },

    /**
     * Close the modal
     */
    close() {
        document.getElementById('quick-agent-modal').classList.remove('visible');
        this.isOpen = false;
        this.projectId = null;
    },

    /**
     * Load settings from project or defaults
     */
    async loadSettings(projectId) {
        // Try to get project settings first
        if (projectId && typeof ProjectsManager !== 'undefined') {
            const project = ProjectsManager.projects.find(p => p.id === projectId);
            if (project?.settings) {
                return {
                    model: project.settings.agent_model || project.settings.model,
                    system_prompt: project.settings.agent_system_prompt || project.settings.system_prompt || '',
                    agent_cwd: project.settings.agent_cwd || '',
                    agent_tools: project.settings.agent_tools || {}
                };
            }
        }

        // Fall back to default settings
        if (typeof DefaultSettingsManager !== 'undefined' && DefaultSettingsManager.settings) {
            return {
                model: DefaultSettingsManager.settings.agent_model,
                system_prompt: DefaultSettingsManager.settings.agent_system_prompt || '',
                agent_cwd: DefaultSettingsManager.settings.agent_cwd || '',
                agent_tools: DefaultSettingsManager.settings.agent_tools || {}
            };
        }

        // Fallback defaults
        return {
            model: 'claude-opus-4-5-20251101',
            system_prompt: '',
            agent_cwd: '',
            agent_tools: {}
        };
    },

    /**
     * Apply settings to the form
     */
    applySettings(settings) {
        // Model
        const modelSelect = document.getElementById('quick-agent-model');
        if (modelSelect && settings.model) {
            modelSelect.value = settings.model;
        }

        // System prompt
        const systemPrompt = document.getElementById('quick-agent-system-prompt');
        if (systemPrompt) {
            systemPrompt.value = settings.system_prompt || '';
        }

        // CWD
        const cwdInput = document.getElementById('quick-agent-cwd');
        if (cwdInput) {
            cwdInput.value = settings.agent_cwd || '';
        }

        // Tools
        const toolsContainer = document.getElementById('quick-agent-tools');
        if (toolsContainer) {
            const agentTools = settings.agent_tools || {};
            const checkboxes = toolsContainer.querySelectorAll('input[type="checkbox"]');
            checkboxes.forEach(checkbox => {
                // Default to true (enabled) if not specified
                checkbox.checked = agentTools[checkbox.name] !== false;
            });
        }
    },

    /**
     * Collect settings from the form
     */
    collectSettings() {
        const tools = {};
        const toolsContainer = document.getElementById('quick-agent-tools');
        if (toolsContainer) {
            toolsContainer.querySelectorAll('input[type="checkbox"]').forEach(cb => {
                tools[cb.name] = cb.checked;
            });
        }

        return {
            model: document.getElementById('quick-agent-model')?.value,
            system_prompt: document.getElementById('quick-agent-system-prompt')?.value || null,
            agent_cwd: document.getElementById('quick-agent-cwd')?.value || null,
            agent_tools: tools
        };
    },

    /**
     * Create the agent chat with collected settings
     */
    async createChat() {
        const settings = this.collectSettings();

        try {
            // Build request body
            const requestBody = {
                title: 'New Agent Chat',
                model: settings.model,
                system_prompt: settings.system_prompt,
                is_agent: true,
                settings: {
                    agent_cwd: settings.agent_cwd,
                    agent_tools: settings.agent_tools
                }
            };

            const response = await fetch('/api/conversations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody)
            });

            const conversation = await response.json();

            // Add to conversations manager
            if (typeof ConversationsManager !== 'undefined') {
                ConversationsManager.conversations.unshift(conversation);
                ConversationsManager.currentConversationId = conversation.id;
                ConversationsManager.renderConversationsList();

                // Add to project if we opened from a project
                if (this.projectId && typeof ProjectsManager !== 'undefined') {
                    await ProjectsManager.addConversationToProject(this.projectId, conversation.id);
                }

                // Select the new conversation
                await ConversationsManager.selectConversation(conversation.id);
            }

            this.close();
        } catch (error) {
            console.error('Failed to create agent chat:', error);
            alert('Failed to create agent chat');
        }
    }
};

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    QuickAgentSettings.init();
});

```

---

### `static/js/settings.js`

**Purpose:** Main settings panel functionality

```javascript
/**
 * Settings panel management module
 */

const SettingsManager = {
    models: [],
    isOpen: false,
    saveTimeout: null,  // For debounced saving

    /**
     * Initialize settings
     */
    async init() {
        await this.loadModels();
        this.bindEvents();
        this.loadSavedSettings();
        this.updateThinkingVisibility();
    },

    /**
     * Debounced save to current conversation
     */
    scheduleSave() {
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
        }
        this.saveTimeout = setTimeout(() => {
            const conversationId = typeof ConversationsManager !== 'undefined'
                ? ConversationsManager.currentConversationId
                : null;
            if (conversationId) {
                this.saveToConversation(conversationId);
            }
        }, 500);  // Save 500ms after last change
    },

    /**
     * Bind DOM events
     */
    bindEvents() {
        // Close settings panel button
        document.getElementById('close-settings').addEventListener('click', () => {
            this.togglePanel();
        });

        // Model selection
        document.getElementById('model-select').addEventListener('change', (e) => {
            this.onModelChange(e.target.value);
            this.scheduleSave();
        });

        // Extended thinking toggle
        const thinkingToggle = document.getElementById('thinking-toggle');
        const thinkingBudgetSlider = document.getElementById('thinking-budget');
        const maxTokensSlider = document.getElementById('max-tokens');

        thinkingToggle.addEventListener('change', (e) => {
            this.onThinkingToggle(e.target.checked);
            // Sync values when thinking is enabled
            if (e.target.checked) {
                const thinkingBudget = parseInt(thinkingBudgetSlider.value);
                const maxTokens = parseInt(maxTokensSlider.value);
                if (maxTokens < thinkingBudget) {
                    maxTokensSlider.value = thinkingBudget;
                    document.getElementById('max-tokens-value').textContent = thinkingBudget;
                }
            }
            this.scheduleSave();
        });

        // Thinking budget slider - if increased above max_tokens, raise max_tokens
        thinkingBudgetSlider.addEventListener('input', (e) => {
            const thinkingBudget = parseInt(e.target.value);
            document.getElementById('thinking-budget-value').textContent = thinkingBudget;

            if (thinkingToggle.checked && parseInt(maxTokensSlider.value) < thinkingBudget) {
                maxTokensSlider.value = thinkingBudget;
                document.getElementById('max-tokens-value').textContent = thinkingBudget;
            }
            this.scheduleSave();
        });

        // Temperature slider
        document.getElementById('temperature').addEventListener('input', (e) => {
            document.getElementById('temperature-value').textContent = e.target.value;
            this.scheduleSave();
        });

        // Max tokens slider - if decreased below thinking_budget, lower thinking_budget
        maxTokensSlider.addEventListener('input', (e) => {
            const value = parseInt(e.target.value);
            document.getElementById('max-tokens-value').textContent = value;

            if (thinkingToggle.checked && parseInt(thinkingBudgetSlider.value) > value) {
                thinkingBudgetSlider.value = value;
                document.getElementById('thinking-budget-value').textContent = value;
            }
            this.scheduleSave();
        });

        // Top P slider
        document.getElementById('top-p').addEventListener('input', (e) => {
            document.getElementById('top-p-value').textContent = e.target.value;
            this.scheduleSave();
        });

        // Top K slider
        document.getElementById('top-k').addEventListener('input', (e) => {
            document.getElementById('top-k-value').textContent = e.target.value;
            this.scheduleSave();
        });

        // Prune threshold slider
        const pruneThresholdSlider = document.getElementById('prune-threshold');
        if (pruneThresholdSlider) {
            pruneThresholdSlider.addEventListener('input', (e) => {
                const valueDisplay = document.getElementById('prune-threshold-value');
                if (valueDisplay) {
                    valueDisplay.textContent = e.target.value;
                }
                this.scheduleSave();
            });
        }

        // Web search toggle
        const webSearchToggle = document.getElementById('web-search-toggle');
        if (webSearchToggle) {
            webSearchToggle.addEventListener('change', (e) => {
                this.onWebSearchToggle(e.target.checked);
                this.scheduleSave();
            });
        }

        // Web search max uses slider
        const webSearchMaxUses = document.getElementById('web-search-max-uses');
        if (webSearchMaxUses) {
            webSearchMaxUses.addEventListener('input', (e) => {
                document.getElementById('web-search-max-uses-value').textContent = e.target.value;
                this.scheduleSave();
            });
        }

        // Agent tools toggles (in conversation settings)
        const agentToolsContainer = document.getElementById('agent-tools');
        if (agentToolsContainer) {
            agentToolsContainer.addEventListener('change', (e) => {
                if (e.target.type === 'checkbox') {
                    this.scheduleSave();
                }
            });
        }

        // Agent CWD input (in conversation settings)
        const agentCwdInput = document.getElementById('agent-cwd');
        if (agentCwdInput) {
            agentCwdInput.addEventListener('input', () => {
                this.scheduleSave();
            });
        }

        // System prompt
        document.getElementById('system-prompt').addEventListener('input', () => {
            this.scheduleSave();
        });

        // Theme toggle
        document.getElementById('theme-toggle').addEventListener('click', () => {
            this.toggleTheme();
        });

    },

    /**
     * Load available models from API
     */
    async loadModels() {
        try {
            const response = await fetch('/api/chat/models');
            const data = await response.json();
            this.models = data.models || [];
            this.renderModelSelect();
        } catch (error) {
            console.error('Failed to load models:', error);
        }
    },

    /**
     * Render model selection dropdown
     */
    renderModelSelect() {
        const select = document.getElementById('model-select');
        select.innerHTML = '';

        this.models.forEach(model => {
            const option = document.createElement('option');
            option.value = model.id;
            option.textContent = model.name;
            select.appendChild(option);
        });

        // Set default or saved model
        const savedModel = localStorage.getItem('claude-chat-model');
        if (savedModel && this.models.find(m => m.id === savedModel)) {
            select.value = savedModel;
        }

        this.onModelChange(select.value);
    },

    /**
     * Handle model change
     */
    onModelChange(modelId) {
        const model = this.models.find(m => m.id === modelId);
        if (!model) return;

        // Update description
        document.getElementById('model-description').textContent = model.description;

        // Update max tokens limit
        const maxTokensInput = document.getElementById('max-tokens');
        maxTokensInput.max = model.max_tokens;

        // Update thinking availability
        this.updateThinkingVisibility();

        // Save preference
        localStorage.setItem('claude-chat-model', modelId);
    },

    /**
     * Handle thinking toggle
     */
    onThinkingToggle(enabled) {
        const budgetContainer = document.getElementById('thinking-budget-container');
        const temperatureGroup = document.getElementById('temperature-group');
        const topPGroup = document.getElementById('top-p-group');
        const topKGroup = document.getElementById('top-k-group');
        const maxTokensInput = document.getElementById('max-tokens');

        if (enabled) {
            budgetContainer.classList.add('visible');
            // Hide temperature controls when thinking is enabled (not allowed by API)
            temperatureGroup.classList.add('hidden');
            topPGroup.classList.add('hidden');
            topKGroup.classList.add('hidden');
            // Reset max tokens slider to full range
            maxTokensInput.min = 1;
            maxTokensInput.max = 64000;
        } else {
            budgetContainer.classList.remove('visible');
            temperatureGroup.classList.remove('hidden');
            topPGroup.classList.remove('hidden');
            topKGroup.classList.remove('hidden');

            // Reset max_tokens minimum
            maxTokensInput.min = 1;
        }
    },

    /**
     * Handle web search toggle
     */
    onWebSearchToggle(enabled) {
        const configContainer = document.getElementById('web-search-config');
        if (configContainer) {
            configContainer.style.display = enabled ? 'block' : 'none';
        }
    },

    /**
     * Update thinking toggle visibility based on model
     */
    updateThinkingVisibility() {
        const modelId = document.getElementById('model-select').value;
        const model = this.models.find(m => m.id === modelId);
        const thinkingGroup = document.getElementById('thinking-group');
        const thinkingToggle = document.getElementById('thinking-toggle');

        if (model && model.supports_thinking) {
            thinkingGroup.style.display = '';
        } else {
            thinkingGroup.style.display = 'none';
            thinkingToggle.checked = false;
            this.onThinkingToggle(false);
        }
    },

    /**
     * Toggle settings panel
     */
    togglePanel() {
        this.isOpen = !this.isOpen;
        const panel = document.getElementById('settings-panel');
        panel.classList.toggle('open', this.isOpen);
    },

    /**
     * Toggle dark/light theme
     */
    toggleTheme() {
        const currentTheme = document.documentElement.getAttribute('data-theme');
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';

        document.documentElement.setAttribute('data-theme', newTheme);
        localStorage.setItem('claude-chat-theme', newTheme);

        // Toggle highlight.js theme
        this.updateHighlightTheme(newTheme);
    },

    /**
     * Update highlight.js theme
     */
    updateHighlightTheme(theme) {
        const lightTheme = document.getElementById('hljs-light');
        const darkTheme = document.getElementById('hljs-dark');
        if (lightTheme && darkTheme) {
            lightTheme.disabled = theme === 'dark';
            darkTheme.disabled = theme !== 'dark';
        }
    },

    /**
     * Load saved settings from localStorage
     */
    loadSavedSettings() {
        // Theme
        const savedTheme = localStorage.getItem('claude-chat-theme');
        let theme = 'light';
        if (savedTheme) {
            theme = savedTheme;
            document.documentElement.setAttribute('data-theme', savedTheme);
        } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
            theme = 'dark';
            document.documentElement.setAttribute('data-theme', 'dark');
        }
        this.updateHighlightTheme(theme);

        // Model
        const savedModel = localStorage.getItem('claude-chat-model');
        if (savedModel) {
            const modelSelect = document.getElementById('model-select');
            if (modelSelect) {
                modelSelect.value = savedModel;
            }
        }

        // Temperature
        const savedTemp = localStorage.getItem('claude-chat-temperature');
        if (savedTemp) {
            document.getElementById('temperature').value = savedTemp;
            document.getElementById('temperature-value').textContent = savedTemp;
        }

        // Max tokens (default: 64000 - Opus 4.5 max output limit)
        const savedMaxTokens = localStorage.getItem('claude-chat-max-tokens');
        const maxTokens = savedMaxTokens ? parseInt(savedMaxTokens) : 64000;
        document.getElementById('max-tokens').value = Math.min(maxTokens, 64000);
        document.getElementById('max-tokens-value').textContent = Math.min(maxTokens, 64000);

        // Top P
        const savedTopP = localStorage.getItem('claude-chat-top-p');
        if (savedTopP) {
            document.getElementById('top-p').value = savedTopP;
            document.getElementById('top-p-value').textContent = savedTopP;
        }

        // Top K
        const savedTopK = localStorage.getItem('claude-chat-top-k');
        if (savedTopK) {
            document.getElementById('top-k').value = savedTopK;
            document.getElementById('top-k-value').textContent = savedTopK;
        }

        // Thinking enabled (default: true)
        const savedThinkingEnabled = localStorage.getItem('claude-chat-thinking-enabled');
        const thinkingEnabled = savedThinkingEnabled === null ? true : savedThinkingEnabled === 'true';
        document.getElementById('thinking-toggle').checked = thinkingEnabled;

        // Thinking budget (default: 60000, max: 63000 to leave room for output within 64K limit)
        const savedThinkingBudget = localStorage.getItem('claude-chat-thinking-budget');
        const thinkingBudget = savedThinkingBudget ? Math.min(parseInt(savedThinkingBudget), 63000) : 60000;
        document.getElementById('thinking-budget').value = thinkingBudget;
        document.getElementById('thinking-budget-value').textContent = thinkingBudget;

        // Apply thinking toggle UI state
        this.onThinkingToggle(thinkingEnabled);

        // System prompt
        const savedSystemPrompt = localStorage.getItem('claude-chat-system-prompt');
        if (savedSystemPrompt) {
            document.getElementById('system-prompt').value = savedSystemPrompt;
        }

        // Prune threshold
        const savedPruneThreshold = localStorage.getItem('claude-chat-prune-threshold');
        if (savedPruneThreshold) {
            document.getElementById('prune-threshold').value = savedPruneThreshold;
            document.getElementById('prune-threshold-value').textContent = savedPruneThreshold;
        }

        // Web search
        const savedWebSearchEnabled = localStorage.getItem('claude-chat-web-search-enabled');
        const webSearchEnabled = savedWebSearchEnabled === 'true';
        const webSearchToggle = document.getElementById('web-search-toggle');
        if (webSearchToggle) {
            webSearchToggle.checked = webSearchEnabled;
            this.onWebSearchToggle(webSearchEnabled);
        }

        const savedWebSearchMaxUses = localStorage.getItem('claude-chat-web-search-max-uses');
        if (savedWebSearchMaxUses) {
            document.getElementById('web-search-max-uses').value = savedWebSearchMaxUses;
            document.getElementById('web-search-max-uses-value').textContent = savedWebSearchMaxUses;
        }
    },

    /**
     * Get current settings
     */
    getSettings() {
        const model = document.getElementById('model-select').value;
        const thinkingEnabled = document.getElementById('thinking-toggle').checked;
        const webSearchEnabled = document.getElementById('web-search-toggle')?.checked || false;
        const webSearchMaxUses = parseInt(document.getElementById('web-search-max-uses')?.value || '5');

        const settings = {
            model,
            temperature: parseFloat(document.getElementById('temperature').value),
            max_tokens: parseInt(document.getElementById('max-tokens').value),
            top_p: parseFloat(document.getElementById('top-p').value),
            top_k: parseInt(document.getElementById('top-k').value),
            system_prompt: document.getElementById('system-prompt').value || null,
            thinking_enabled: thinkingEnabled,
            thinking_budget: parseInt(document.getElementById('thinking-budget').value),
            prune_threshold: parseInt(document.getElementById('prune-threshold').value) / 100,
            web_search_enabled: webSearchEnabled,
            web_search_max_uses: webSearchMaxUses
        };

        // Save to localStorage
        localStorage.setItem('claude-chat-model', settings.model);
        localStorage.setItem('claude-chat-temperature', settings.temperature);
        localStorage.setItem('claude-chat-max-tokens', settings.max_tokens);
        localStorage.setItem('claude-chat-top-p', settings.top_p);
        localStorage.setItem('claude-chat-top-k', settings.top_k);
        localStorage.setItem('claude-chat-thinking-enabled', settings.thinking_enabled);
        localStorage.setItem('claude-chat-thinking-budget', settings.thinking_budget);
        localStorage.setItem('claude-chat-prune-threshold', settings.prune_threshold * 100);
        localStorage.setItem('claude-chat-web-search-enabled', settings.web_search_enabled);
        localStorage.setItem('claude-chat-web-search-max-uses', settings.web_search_max_uses);
        if (settings.system_prompt) {
            localStorage.setItem('claude-chat-system-prompt', settings.system_prompt);
        }

        return settings;
    },

    /**
     * Set model programmatically
     */
    setModel(modelId) {
        const select = document.getElementById('model-select');
        if (this.models.find(m => m.id === modelId)) {
            select.value = modelId;
            this.onModelChange(modelId);
        }
    },

    /**
     * Set the settings mode (normal or agent chat)
     * This shows/hides relevant settings for each mode
     */
    setMode(mode) {
        const panel = document.getElementById('settings-panel');
        panel.dataset.mode = mode;  // 'normal' or 'agent'
    },

    /**
     * Load settings from a conversation object
     */
    loadConversationSettings(conversation) {
        if (!conversation) return;

        const settings = conversation.settings || {};

        // Model
        if (conversation.model) {
            this.setModel(conversation.model);
        }

        // System prompt
        if (conversation.system_prompt !== undefined) {
            document.getElementById('system-prompt').value = conversation.system_prompt || '';
        }

        // Thinking enabled
        const thinkingEnabled = settings.thinking_enabled !== undefined ? settings.thinking_enabled : true;
        document.getElementById('thinking-toggle').checked = thinkingEnabled;

        // Thinking budget
        const thinkingBudget = settings.thinking_budget || 60000;
        document.getElementById('thinking-budget').value = thinkingBudget;
        document.getElementById('thinking-budget-value').textContent = thinkingBudget;

        // Max tokens
        const maxTokens = settings.max_tokens || 64000;
        document.getElementById('max-tokens').value = maxTokens;
        document.getElementById('max-tokens-value').textContent = maxTokens;

        // Temperature
        const temperature = settings.temperature !== undefined ? settings.temperature : 1.0;
        document.getElementById('temperature').value = temperature;
        document.getElementById('temperature-value').textContent = temperature;

        // Top P
        const topP = settings.top_p !== undefined ? settings.top_p : 1.0;
        document.getElementById('top-p').value = topP;
        document.getElementById('top-p-value').textContent = topP;

        // Top K
        const topK = settings.top_k !== undefined ? settings.top_k : 0;
        document.getElementById('top-k').value = topK;
        document.getElementById('top-k-value').textContent = topK;

        // Prune threshold
        const pruneThreshold = settings.prune_threshold !== undefined ? settings.prune_threshold * 100 : 70;
        document.getElementById('prune-threshold').value = pruneThreshold;
        document.getElementById('prune-threshold-value').textContent = pruneThreshold;

        // Web search
        const webSearchEnabled = settings.web_search_enabled || false;
        const webSearchToggle = document.getElementById('web-search-toggle');
        if (webSearchToggle) {
            webSearchToggle.checked = webSearchEnabled;
            this.onWebSearchToggle(webSearchEnabled);
        }

        const webSearchMaxUses = settings.web_search_max_uses || 5;
        const webSearchMaxUsesInput = document.getElementById('web-search-max-uses');
        if (webSearchMaxUsesInput) {
            webSearchMaxUsesInput.value = webSearchMaxUses;
            document.getElementById('web-search-max-uses-value').textContent = webSearchMaxUses;
        }

        // Agent CWD (read-only display)
        const agentCwdDisplay = document.getElementById('agent-cwd-display');
        if (agentCwdDisplay) {
            const cwdPath = agentCwdDisplay.querySelector('.cwd-path');
            if (cwdPath) {
                cwdPath.textContent = settings.agent_cwd || 'Default workspace';
            }
        }

        // Agent tools (read-only badges)
        const agentToolsDisplay = document.getElementById('agent-tools-display');
        if (agentToolsDisplay) {
            const agentTools = settings.agent_tools || {};
            const toolNames = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Task', 'GIF', 'Memory', 'Surface'];
            agentToolsDisplay.innerHTML = toolNames
                .map(name => {
                    const enabled = agentTools[name] !== false;
                    return `<span class="tool-badge ${enabled ? 'enabled' : 'disabled'}">${name}</span>`;
                })
                .join('');
        }

        // Apply thinking toggle UI state
        this.onThinkingToggle(thinkingEnabled);
    },

    /**
     * Get current settings as object for saving to conversation
     */
    getConversationSettings() {
        const settings = {
            thinking_enabled: document.getElementById('thinking-toggle').checked,
            thinking_budget: parseInt(document.getElementById('thinking-budget').value),
            max_tokens: parseInt(document.getElementById('max-tokens').value),
            temperature: parseFloat(document.getElementById('temperature').value),
            top_p: parseFloat(document.getElementById('top-p').value),
            top_k: parseInt(document.getElementById('top-k').value),
            prune_threshold: parseInt(document.getElementById('prune-threshold').value) / 100,
            web_search_enabled: document.getElementById('web-search-toggle')?.checked || false,
            web_search_max_uses: parseInt(document.getElementById('web-search-max-uses')?.value || '5')
        };

        // Note: Agent CWD and tools are read-only in conversation settings
        // They are set via project settings or default settings when the conversation is created
        // So we don't include them here - they shouldn't be changed from the conversation panel

        return settings;
    },

    /**
     * Save current settings to the active conversation
     */
    async saveToConversation(conversationId) {
        if (!conversationId) return;

        const settings = this.getConversationSettings();
        const model = document.getElementById('model-select').value;
        const systemPrompt = document.getElementById('system-prompt').value || null;

        try {
            await fetch(`/api/conversations/${conversationId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: model,
                    system_prompt: systemPrompt,
                    settings: settings
                })
            });
        } catch (error) {
            console.error('Failed to save settings:', error);
        }
    }
};

```

---

### `static/js/workspace.js`

**Purpose:** Workspace file management for surfaced content

```javascript
/**
 * Workspace files manager for agent conversations
 */

const WorkspaceManager = {
    isOpen: false,
    currentConversationId: null,
    files: [],
    memoryFiles: [],
    memoryInfo: null,

    /**
     * Initialize workspace manager
     */
    init() {
        this.bindEvents();
    },

    /**
     * Bind DOM events
     */
    bindEvents() {
        // Workspace toggle button
        const toggleBtn = document.getElementById('workspace-files-toggle');
        if (toggleBtn) {
            toggleBtn.addEventListener('click', () => {
                this.togglePanel();
            });
        }

        // Close button
        const closeBtn = document.getElementById('close-workspace');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                this.togglePanel();
            });
        }

        // Drag and drop events
        const panel = document.getElementById('workspace-panel');
        if (panel) {
            panel.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (this.isOpen && this.currentConversationId) {
                    panel.classList.add('drag-over');
                }
            });

            panel.addEventListener('dragleave', (e) => {
                e.preventDefault();
                e.stopPropagation();
                // Only remove if leaving the panel itself, not a child
                if (e.target === panel) {
                    panel.classList.remove('drag-over');
                }
            });

            panel.addEventListener('drop', (e) => {
                e.preventDefault();
                e.stopPropagation();
                panel.classList.remove('drag-over');

                if (this.isOpen && this.currentConversationId) {
                    this.handleFileDrop(e);
                }
            });
        }
    },

    /**
     * Toggle workspace panel
     */
    togglePanel() {
        this.isOpen = !this.isOpen;
        const panel = document.getElementById('workspace-panel');
        panel.classList.toggle('open', this.isOpen);

        if (this.isOpen && this.currentConversationId) {
            this.loadFiles(this.currentConversationId);
        }
    },

    /**
     * Show/hide workspace button based on conversation type
     */
    updateVisibility(isAgentConversation) {
        const toggleBtn = document.getElementById('workspace-files-toggle');
        if (toggleBtn) {
            toggleBtn.style.display = isAgentConversation ? '' : 'none';
        }

        // Close panel if switching to non-agent conversation
        if (!isAgentConversation && this.isOpen) {
            this.togglePanel();
        }
    },

    /**
     * Set current conversation
     */
    setConversation(conversationId) {
        this.currentConversationId = conversationId;
        if (this.isOpen) {
            this.loadFiles(conversationId);
        }
    },

    /**
     * Load files from workspace and memory
     */
    async loadFiles(conversationId) {
        try {
            // Load workspace files
            const workspaceResponse = await fetch(`/api/agent-chat/workspace/${conversationId}`);
            if (!workspaceResponse.ok) {
                throw new Error(`HTTP error! status: ${workspaceResponse.status}`);
            }

            const workspaceData = await workspaceResponse.json();
            this.files = workspaceData.files || [];

            // Load memory files
            try {
                const memoryResponse = await fetch(`/api/agent-chat/memory/${conversationId}`);
                if (memoryResponse.ok) {
                    const memoryData = await memoryResponse.json();
                    this.memoryFiles = memoryData.files || [];
                    this.memoryInfo = {
                        isProjectMemory: memoryData.is_project_memory,
                        projectId: memoryData.project_id
                    };
                } else {
                    this.memoryFiles = [];
                    this.memoryInfo = null;
                }
            } catch (e) {
                console.debug('Memory endpoint not available:', e);
                this.memoryFiles = [];
                this.memoryInfo = null;
            }

            this.renderFiles(workspaceData.workspace_path);
        } catch (error) {
            console.error('Failed to load workspace files:', error);
            this.renderError();
        }
    },

    /**
     * Render files list
     */
    renderFiles(workspacePath) {
        const pathEl = document.getElementById('workspace-path');
        const listEl = document.getElementById('workspace-files-list');

        pathEl.textContent = workspacePath || '';

        listEl.innerHTML = '';

        // Render memory section if there are memory files or memory is enabled
        if (this.memoryInfo) {
            const memorySection = document.createElement('div');
            memorySection.className = 'workspace-section memory-section';

            const memoryHeader = document.createElement('div');
            memoryHeader.className = 'workspace-section-header';
            const memoryLabel = this.memoryInfo.isProjectMemory
                ? '🧠 Shared Project Memory'
                : '🧠 Conversation Memory';
            memoryHeader.innerHTML = `<span>${memoryLabel}</span>`;
            memorySection.appendChild(memoryHeader);

            if (this.memoryFiles.length === 0) {
                const emptyMsg = document.createElement('div');
                emptyMsg.className = 'workspace-empty small';
                emptyMsg.textContent = 'No memories yet';
                memorySection.appendChild(emptyMsg);
            } else {
                this.memoryFiles.forEach(file => {
                    const item = this.createMemoryFileItem(file);
                    memorySection.appendChild(item);
                });
            }

            listEl.appendChild(memorySection);
        }

        // Render workspace files section
        const filesSection = document.createElement('div');
        filesSection.className = 'workspace-section files-section';

        const filesHeader = document.createElement('div');
        filesHeader.className = 'workspace-section-header';
        filesHeader.innerHTML = '<span>📁 Workspace Files</span>';
        filesSection.appendChild(filesHeader);

        if (this.files.length === 0) {
            const emptyMsg = document.createElement('div');
            emptyMsg.className = 'workspace-empty small';
            emptyMsg.innerHTML = 'No files yet<br><span style="font-size: 11px; opacity: 0.7;">Drag and drop to upload</span>';
            filesSection.appendChild(emptyMsg);
        } else {
            this.files.forEach(file => {
                const item = this.createFileItem(file);
                filesSection.appendChild(item);
            });
        }

        listEl.appendChild(filesSection);
    },

    /**
     * Create memory file item element
     */
    createMemoryFileItem(file) {
        const item = document.createElement('div');
        item.className = 'workspace-file-item memory-file';

        const icon = file.is_dir ? '📁' : '📝';
        const size = file.size ? this.formatFileSize(file.size) : '';

        item.innerHTML = `
            <div class="workspace-file-info">
                <span class="workspace-file-icon">${icon}</span>
                <span class="workspace-file-name" title="${this.escapeHtml(file.name)}">${this.escapeHtml(file.name)}</span>
                ${size ? `<span class="workspace-file-size">${size}</span>` : ''}
            </div>
            <div class="workspace-file-actions">
                <button class="workspace-file-action-btn view" title="View">👁️</button>
            </div>
        `;

        // View button
        const viewBtn = item.querySelector('.view');
        viewBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.viewMemoryFile(file.name);
        });

        return item;
    },

    /**
     * View a memory file
     */
    async viewMemoryFile(filename) {
        try {
            const response = await fetch(`/api/agent-chat/memory/${this.currentConversationId}/${encodeURIComponent(filename)}`);
            if (!response.ok) {
                throw new Error('Failed to load memory file');
            }

            const data = await response.json();
            alert(`Memory: ${filename}\n\n${data.content}`);
        } catch (error) {
            console.error('Failed to view memory file:', error);
            alert('Failed to load memory file');
        }
    },

    /**
     * Create file item element
     */
    createFileItem(file) {
        const item = document.createElement('div');
        item.className = 'workspace-file-item';

        const icon = file.is_dir ? '📁' : '📄';
        const size = file.size ? this.formatFileSize(file.size) : '';

        item.innerHTML = `
            <div class="workspace-file-info">
                <span class="workspace-file-icon">${icon}</span>
                <span class="workspace-file-name" title="${this.escapeHtml(file.name)}">${this.escapeHtml(file.name)}</span>
                ${size ? `<span class="workspace-file-size">${size}</span>` : ''}
            </div>
            <div class="workspace-file-actions">
                <button class="workspace-file-action-btn tag" title="Tag in message">@</button>
                <button class="workspace-file-action-btn delete" title="Delete">🗑️</button>
            </div>
        `;

        // Tag button - insert @filename into message input
        const tagBtn = item.querySelector('.tag');
        tagBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.tagFile(file.name);
        });

        // Delete button
        const deleteBtn = item.querySelector('.delete');
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.deleteFile(file.name);
        });

        return item;
    },

    /**
     * Tag file in message input
     */
    tagFile(filename) {
        const input = document.getElementById('message-input');
        const currentValue = input.value;
        const cursorPos = input.selectionStart;

        // Insert @filename at cursor position
        const before = currentValue.substring(0, cursorPos);
        const after = currentValue.substring(cursorPos);
        input.value = before + '@' + filename + ' ' + after;

        // Move cursor after the tag
        const newPos = cursorPos + filename.length + 2;
        input.setSelectionRange(newPos, newPos);
        input.focus();

        // Trigger input event to update UI
        input.dispatchEvent(new Event('input'));
    },

    /**
     * Delete file from workspace
     */
    async deleteFile(filename) {
        if (!confirm(`Delete "${filename}" from workspace?`)) {
            return;
        }

        try {
            const response = await fetch(`/api/agent-chat/workspace/${this.currentConversationId}/${encodeURIComponent(filename)}`, {
                method: 'DELETE'
            });

            if (!response.ok) {
                throw new Error('Failed to delete file');
            }

            // Reload files list
            await this.loadFiles(this.currentConversationId);

            console.log(`Deleted file: ${filename}`);
        } catch (error) {
            console.error('Failed to delete file:', error);
            alert('Failed to delete file');
        }
    },

    /**
     * Handle file drop event
     */
    async handleFileDrop(event) {
        const files = Array.from(event.dataTransfer.files);

        if (files.length === 0) {
            return;
        }

        console.log(`Uploading ${files.length} file(s) to workspace`);

        // Upload each file
        for (const file of files) {
            try {
                await this.uploadFile(file);
            } catch (error) {
                console.error(`Failed to upload ${file.name}:`, error);
                alert(`Failed to upload ${file.name}: ${error.message}`);
            }
        }

        // Reload files list
        await this.loadFiles(this.currentConversationId);
    },

    /**
     * Upload a file to workspace
     */
    async uploadFile(file) {
        const formData = new FormData();
        formData.append('file', file);

        const response = await fetch(`/api/agent-chat/workspace/${this.currentConversationId}/upload`, {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'Upload failed');
        }

        const result = await response.json();
        console.log(`Uploaded ${file.name}: ${result.message}`);
        return result;
    },

    /**
     * Render error state
     */
    renderError() {
        const listEl = document.getElementById('workspace-files-list');
        listEl.innerHTML = '<div class="workspace-empty">Failed to load workspace files</div>';
    },

    /**
     * Format file size
     */
    formatFileSize(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return Math.round(bytes / Math.pow(k, i) * 10) / 10 + ' ' + sizes[i];
    },

    /**
     * Escape HTML
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
};

```

---

## Frontend Styles

### `static/css/main.css`

**Purpose:** Main stylesheet - all CSS styles for the application

```css
/* Anthropic Color Palette - Claude Chat UI */

:root {
    /* Primary colors - Anthropic warm palette */
    --color-primary: #C15F3C;      /* Crail - warm rust-orange */
    --color-primary-hover: #A8523A;
    --color-secondary: #B1ADA1;    /* Cloudy - neutral grey */
    --color-background: #F4F3EE;   /* Pampas - off-white/cream */
    --color-surface: #FFFFFF;      /* White - cards/content */
    --color-text: #1A1A1A;
    --color-text-secondary: #666666;
    --color-border: #E0DDD4;
    --color-border-light: #F0EDE6;

    /* Semantic colors */
    --color-success: #4A9B7F;
    --color-error: #C15F3C;
    --color-warning: #D4A574;

    /* Shadows */
    --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.05);
    --shadow-md: 0 4px 6px rgba(0, 0, 0, 0.07);
    --shadow-lg: 0 10px 15px rgba(0, 0, 0, 0.1);

    /* Spacing */
    --sidebar-width: 260px;
    --settings-width: 300px;
    --header-height: 56px;

    /* Typography */
    --font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
    --font-mono: 'SF Mono', 'Fira Code', 'Consolas', monospace;

    /* Transitions */
    --transition-fast: 150ms ease;
    --transition-normal: 250ms ease;
}

/* Dark Theme */
[data-theme="dark"] {
    --color-primary: #D97555;      /* Lighter Crail for dark mode */
    --color-primary-hover: #E08B6B;
    --color-secondary: #8A8680;
    --color-background: #1A1A1A;
    --color-surface: #2D2D2D;
    --color-text: #F4F3EE;
    --color-text-secondary: #A0A0A0;
    --color-border: #3D3D3D;
    --color-border-light: #333333;

    --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.2);
    --shadow-md: 0 4px 6px rgba(0, 0, 0, 0.3);
    --shadow-lg: 0 10px 15px rgba(0, 0, 0, 0.4);
}

/* Reset & Base */
*, *::before, *::after {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
}

html, body {
    height: 100%;
    font-family: var(--font-family);
    font-size: 14px;
    line-height: 1.5;
    color: var(--color-text);
    background-color: var(--color-background);
    transition: background-color var(--transition-normal), color var(--transition-normal);
}

/* App Container */
.app-container {
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
}

/* Header */
.header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: var(--header-height);
    padding: 0 16px;
    background-color: var(--color-surface);
    border-bottom: 1px solid var(--color-border);
    z-index: 100;
}

.header-left {
    display: flex;
    align-items: center;
}

.logo {
    font-size: 18px;
    font-weight: 600;
    color: var(--color-primary);
}

.header-right {
    display: flex;
    align-items: center;
    gap: 8px;
}

.icon-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    background: transparent;
    border: none;
    border-radius: 8px;
    color: var(--color-text-secondary);
    font-size: 18px;
    cursor: pointer;
    transition: all var(--transition-fast);
}

.icon-btn:hover {
    background-color: var(--color-border-light);
    color: var(--color-text);
}

/* Theme toggle icons */
.theme-icon-dark {
    display: none;
}

[data-theme="dark"] .theme-icon-light {
    display: none;
}

[data-theme="dark"] .theme-icon-dark {
    display: inline;
}

/* Main Container */
.main-container {
    display: flex;
    flex: 1;
    overflow: hidden;
}

/* Sidebar */
.sidebar {
    width: var(--sidebar-width);
    min-width: 180px;
    max-width: 500px;
    background-color: var(--color-surface);
    border-right: 1px solid var(--color-border);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    position: relative;
}

/* Sidebar resize handle */
.sidebar-resize-handle {
    position: absolute;
    top: 0;
    right: 0;
    width: 4px;
    height: 100%;
    cursor: ew-resize;
    background: transparent;
    z-index: 10;
    transition: background-color var(--transition-fast);
}

.sidebar-resize-handle:hover,
.sidebar-resize-handle.dragging {
    background-color: var(--color-primary);
}

body.sidebar-resizing {
    cursor: ew-resize !important;
    user-select: none;
}

/* Collapsed sidebar state */
.sidebar.collapsed {
    width: 0 !important;
    min-width: 0 !important;
    border-right: none;
    overflow: visible; /* Allow handle to extend outside */
}

.sidebar.collapsed > *:not(.sidebar-resize-handle) {
    display: none;
}

.sidebar.collapsed .sidebar-resize-handle {
    width: 6px;
    left: 0;
    right: auto; /* Position at left edge when collapsed */
    background-color: var(--color-primary);
    cursor: e-resize;
    border-radius: 0 3px 3px 0;
    z-index: 100;
}

.sidebar.collapsed .sidebar-resize-handle:hover {
    background-color: var(--color-primary-hover);
    width: 10px;
}

.new-chat-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 12px;
    padding: 10px 16px;
    background-color: var(--color-primary);
    color: white;
    border: none;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: background-color var(--transition-fast);
}

.new-chat-btn:hover {
    background-color: var(--color-primary-hover);
}

.new-chat-btn span {
    font-size: 18px;
}

.search-container {
    position: relative;
    margin: 0 12px 12px;
}

.search-input {
    width: 100%;
    padding: 8px 32px 8px 12px;
    background-color: var(--color-background);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    font-size: 13px;
    color: var(--color-text);
    outline: none;
    transition: border-color var(--transition-fast);
}

.search-input:focus {
    border-color: var(--color-primary);
}

.search-input::placeholder {
    color: var(--color-text-secondary);
}

.clear-search-btn {
    position: absolute;
    right: 4px;
    top: 50%;
    transform: translateY(-50%);
    padding: 4px 8px;
    background: none;
    border: none;
    color: var(--color-text-secondary);
    cursor: pointer;
    font-size: 16px;
    border-radius: 4px;
    transition: all var(--transition-fast);
}

.clear-search-btn:hover {
    background-color: var(--color-border);
    color: var(--color-text);
}

.conversations-list {
    flex: 1;
    overflow-y: auto;
    padding: 0 8px 12px;
}

.conversation-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    margin-bottom: 4px;
    border-radius: 8px;
    cursor: pointer;
    transition: background-color var(--transition-fast);
    position: relative;
}

.conversation-item:hover {
    background-color: var(--color-border-light);
}

.conversation-item.active {
    background-color: var(--color-border);
}

.conversation-title {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
    min-width: 0;
}

.conversation-title mark {
    background-color: var(--color-primary);
    color: white;
    padding: 1px 2px;
    border-radius: 2px;
}

[data-theme="dark"] .conversation-title mark {
    background-color: var(--color-primary);
    color: var(--color-background);
}

.conversation-actions {
    position: absolute;
    right: 8px;
    top: 50%;
    transform: translateY(-50%);
    display: flex;
    gap: 4px;
    opacity: 0;
    pointer-events: none;
    background: linear-gradient(to right, transparent, var(--color-surface) 8px);
    padding-left: 16px;
    transition: opacity var(--transition-fast);
}

.conversation-item:hover .conversation-actions {
    opacity: 1;
    pointer-events: auto;
    background: linear-gradient(to right, transparent, var(--color-border-light) 8px);
}

.conversation-item.active .conversation-actions {
    background: linear-gradient(to right, transparent, var(--color-border) 8px);
}

.conversation-duplicate,
.conversation-rename,
.conversation-delete {
    padding: 4px 6px;
    background: none;
    border: none;
    color: var(--color-text-secondary);
    cursor: pointer;
    border-radius: 4px;
    font-size: 12px;
    transition: all var(--transition-fast);
}

.conversation-duplicate:hover {
    background-color: #4A9B7F;
    color: white;
}

.conversation-rename:hover {
    background-color: var(--color-primary);
    color: white;
}

.conversation-delete:hover {
    background-color: var(--color-error);
    color: white;
}

/* Chat Area */
.chat-area {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background-color: var(--color-background);
}

.messages-container {
    flex: 1;
    overflow-y: auto;
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 16px;
}

.welcome-message {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    text-align: center;
    color: var(--color-text-secondary);
}

.welcome-message h2 {
    font-size: 24px;
    margin-bottom: 8px;
    color: var(--color-text);
}

.welcome-message p {
    font-size: 15px;
}

/* Messages */
.message {
    max-width: 800px;
    margin: 0 auto;
    width: 100%;
    padding: 16px;
    border-radius: 12px;
    animation: fadeIn 0.2s ease;
}

@keyframes fadeIn {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
}

.message.user {
    background-color: transparent;
    margin-left: auto;
    max-width: 600px;
    padding: 0;
}

.message.user .message-content {
    background-color: var(--color-primary);
    color: white;
    padding: 12px 16px;
    border-radius: 16px;
    width: fit-content;
    max-width: 100%;
    margin-left: auto;
}

.message.assistant {
    background-color: var(--color-surface);
    border: 1px solid var(--color-border);
}

/* Message Timestamp */
.message-timestamp {
    font-size: 11px;
    color: var(--color-text-secondary);
    margin-top: 6px;
    opacity: 0.7;
}

.message.user .message-timestamp {
    color: var(--color-text-secondary);
    text-align: right;
    margin-top: 4px;
}

/* Message Actions */
.message-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--color-border-light);
}

/* Action buttons always visible */
.message-actions .action-btn {
    opacity: 0.6 !important;
    visibility: visible !important;
    transition: opacity var(--transition-fast);
}

.message-actions .action-btn:hover {
    opacity: 1 !important;
}

/* Version badge is always visible when present */
.message-actions .version-badge {
    opacity: 1;
}

/* User message actions styling */
.message.user .message-actions {
    border-top: none;
    background-color: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    padding: 4px 8px;
    margin-top: 6px;
    width: fit-content;
    margin-left: auto;
}

.message.user .message-actions .action-btn {
    color: var(--color-text);
}

/* Edit mode - expand to full width */
.message.user.editing {
    max-width: 90%;
}

.message.user.editing .message-content {
    background-color: var(--color-surface);
    border: 2px solid var(--color-primary);
    width: 100%;
}

.action-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    background: transparent;
    border: none;
    border-radius: 6px;
    font-size: 14px;
    cursor: pointer;
    transition: all var(--transition-fast);
}

.action-btn:hover {
    background-color: var(--color-border-light);
    opacity: 1 !important;
}

.message.user .action-btn:hover {
    background-color: rgba(255, 255, 255, 0.2);
}

.copy-btn:hover {
    background-color: rgba(76, 175, 80, 0.2) !important;
}

.retry-btn:hover {
    background-color: rgba(193, 95, 60, 0.2) !important;
}

/* Version Badge - Always visible on messages with multiple versions */
.version-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    background: var(--color-border);
    border-radius: 12px;
    font-size: 12px;
    margin-left: auto;
    opacity: 1 !important; /* Always visible when present */
}

/* Version badge in user message action bar */
.message.user .version-badge {
    background: var(--color-border-light);
}

.version-indicator {
    font-size: 12px;
    color: var(--color-text);
    min-width: 28px;
    text-align: center;
    font-weight: 500;
}

.version-nav-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    background: var(--color-surface);
    border: 1px solid var(--color-border-light);
    border-radius: 4px;
    font-size: 10px;
    cursor: pointer;
    transition: all var(--transition-fast);
    color: var(--color-text-secondary);
}

.version-nav-btn:hover {
    background-color: var(--color-primary);
    color: white;
    border-color: var(--color-primary);
}

.message-content {
    word-wrap: break-word;
    overflow-wrap: break-word;
}

.message-content > *:first-child {
    margin-top: 0;
}

.message-content > *:last-child {
    margin-bottom: 0;
}

.message-content p {
    margin: 0 0 12px 0;
    line-height: 1.6;
}

.message-content p:last-child {
    margin-bottom: 0;
}

/* Headings */
.message-content h1,
.message-content h2,
.message-content h3,
.message-content h4,
.message-content h5,
.message-content h6 {
    margin: 20px 0 12px 0;
    font-weight: 600;
    line-height: 1.3;
}

.message-content h1 { font-size: 1.5em; }
.message-content h2 { font-size: 1.3em; }
.message-content h3 { font-size: 1.15em; }
.message-content h4 { font-size: 1em; }

/* Lists */
.message-content ul,
.message-content ol {
    margin: 12px 0;
    padding-left: 24px;
}

.message-content li {
    margin: 6px 0;
    line-height: 1.6;
}

.message-content li > ul,
.message-content li > ol {
    margin: 4px 0;
}

/* Blockquotes */
.message-content blockquote {
    margin: 12px 0;
    padding: 8px 16px;
    border-left: 4px solid var(--color-primary);
    background-color: var(--color-border-light);
    border-radius: 0 4px 4px 0;
}

.message-content blockquote p {
    margin: 0;
}

/* Code */
.message-content code {
    font-family: var(--font-mono);
    background-color: var(--color-border-light);
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 13px;
}

.message.user .message-content code {
    background-color: rgba(255, 255, 255, 0.2);
}

.message-content pre {
    background-color: var(--color-border-light);
    padding: 16px;
    border-radius: 8px;
    overflow-x: auto;
    margin: 12px 0;
}

[data-theme="dark"] .message-content pre {
    background-color: #1e1e1e;
}

.message-content pre code {
    background: none;
    padding: 0;
    font-size: 13px;
    line-height: 1.5;
}

/* Tables */
.message-content table {
    width: 100%;
    border-collapse: collapse;
    margin: 12px 0;
    font-size: 13px;
}

.message-content th,
.message-content td {
    padding: 8px 12px;
    border: 1px solid var(--color-border);
    text-align: left;
}

.message-content th {
    background-color: var(--color-border-light);
    font-weight: 600;
}

.message-content tr:nth-child(even) {
    background-color: var(--color-border-light);
}

/* Horizontal rule */
.message-content hr {
    margin: 20px 0;
    border: none;
    border-top: 1px solid var(--color-border);
}

/* Links */
.message-content a {
    color: var(--color-primary);
    text-decoration: none;
}

.message-content a:hover {
    text-decoration: underline;
}

/* Strong/Bold and Emphasis */
.message-content strong {
    font-weight: 600;
}

.message-content em {
    font-style: italic;
}

/* Thinking Block */
.thinking-block {
    margin-bottom: 12px;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    overflow: hidden;
}

.thinking-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background-color: var(--color-border-light);
    cursor: pointer;
    user-select: none;
}

.thinking-header:hover {
    background-color: var(--color-border);
}

.thinking-toggle {
    font-size: 10px;
    transition: transform var(--transition-fast);
}

.thinking-block.expanded .thinking-toggle {
    transform: rotate(90deg);
}

.thinking-label {
    font-size: 12px;
    font-weight: 500;
    color: var(--color-text-secondary);
}

.thinking-content {
    display: none;
    padding: 12px;
    font-size: 13px;
    color: var(--color-text-secondary);
    white-space: pre-wrap;
    max-height: 300px;
    overflow-y: auto;
    border-top: 1px solid var(--color-border);
}

.thinking-block.expanded .thinking-content {
    display: block;
}

/* File Attachments in Messages */
.message-files {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 12px;
}

.message-file {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    background-color: var(--color-border-light);
    border-radius: 6px;
    font-size: 12px;
}

.message.user .message-file {
    background-color: rgba(255, 255, 255, 0.2);
}

.message-file-icon {
    font-size: 14px;
}

.message-file img {
    max-width: 200px;
    max-height: 150px;
    border-radius: 4px;
}

/* Input Area */
.input-area {
    transition: all var(--transition-normal);
}

.input-area.dragging {
    border: 2px dashed var(--color-primary);
    background-color: rgba(193, 95, 60, 0.1);
    box-shadow: inset 0 0 0 2px rgba(193, 95, 60, 0.2);
}

[data-theme="dark"] .input-area.dragging {
    background-color: rgba(217, 117, 85, 0.15);
    box-shadow: inset 0 0 0 2px rgba(217, 117, 85, 0.3);
}

.file-previews {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 8px;
}

.file-preview {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background-color: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    font-size: 12px;
}

.file-preview img {
    width: 40px;
    height: 40px;
    object-fit: cover;
    border-radius: 4px;
}

.file-preview-info {
    display: flex;
    flex-direction: column;
}

.file-preview-name {
    font-weight: 500;
    max-width: 150px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.file-preview-size {
    color: var(--color-text-secondary);
}

.file-preview-remove {
    padding: 4px;
    background: none;
    border: none;
    color: var(--color-text-secondary);
    cursor: pointer;
    border-radius: 4px;
}

.file-preview-remove:hover {
    background-color: var(--color-error);
    color: white;
}

.input-container {
    max-width: 800px;
    margin: 0 auto;
}

.input-wrapper {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    padding: 8px;
    background-color: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 12px;
    box-shadow: var(--shadow-sm);
}

.file-upload-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    color: var(--color-text-secondary);
    cursor: pointer;
    border-radius: 8px;
    transition: all var(--transition-fast);
}

.file-upload-btn:hover {
    background-color: var(--color-border-light);
    color: var(--color-text);
}

.file-upload-btn input {
    display: none;
}

#message-input {
    flex: 1;
    padding: 8px 4px;
    border: none;
    background: transparent;
    font-family: var(--font-family);
    font-size: 14px;
    color: var(--color-text);
    resize: none;
    outline: none;
    min-height: 36px;
    max-height: 200px;
}

#message-input::placeholder {
    color: var(--color-text-secondary);
}

.send-btn {
    padding: 8px 16px;
    background-color: var(--color-primary);
    color: white;
    border: none;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: all var(--transition-fast);
}

.send-btn:hover:not(:disabled) {
    background-color: var(--color-primary-hover);
}

.send-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.stop-btn {
    padding: 8px 16px;
    background-color: #dc3545;
    color: white;
    border: none;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: all var(--transition-fast);
}

.stop-btn:hover {
    background-color: #c82333;
}

/* Settings Panel */
.settings-panel {
    width: 0;
    overflow: hidden;
    background-color: var(--color-surface);
    border-left: 1px solid var(--color-border);
    transition: width var(--transition-normal);
}

.settings-panel.open {
    width: var(--settings-width);
}

.settings-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px;
    border-bottom: 1px solid var(--color-border);
}

.settings-header h3 {
    font-size: 16px;
    font-weight: 600;
}

.settings-content {
    padding: 16px;
    overflow-y: auto;
    height: calc(100vh - var(--header-height) - 57px);
}

.setting-group {
    margin-bottom: 20px;
}

.setting-group label {
    display: block;
    font-size: 13px;
    font-weight: 500;
    margin-bottom: 6px;
}

.setting-description {
    display: block;
    font-size: 11px;
    color: var(--color-text-secondary);
    margin-top: 4px;
}

/* Settings mode indicator */
.settings-mode-indicator {
    padding-bottom: 12px;
    border-bottom: 1px solid var(--color-border);
    margin-bottom: 16px;
}

.mode-badge {
    display: none;
    padding: 4px 10px;
    border-radius: 12px;
    font-size: 12px;
    font-weight: 500;
}

.mode-badge.normal-mode {
    background-color: var(--color-primary);
    color: white;
}

.mode-badge.agent-mode {
    background-color: #e67e22;
    color: white;
}

/* Show appropriate mode badge */
.settings-panel[data-mode="normal"] .mode-badge.normal-mode,
.settings-panel[data-mode="agent"] .mode-badge.agent-mode {
    display: inline-block;
}

/* Mode-specific settings visibility */
.normal-chat-settings,
.agent-chat-settings {
    display: none;
}

.settings-panel[data-mode="normal"] .normal-chat-settings {
    display: block;
}

.settings-panel[data-mode="agent"] .agent-chat-settings {
    display: block;
}

/* Agent info text */
.agent-info {
    font-size: 12px;
    line-height: 1.5;
    padding: 10px;
    background-color: rgba(230, 126, 34, 0.1);
    border-radius: 6px;
    border-left: 3px solid #e67e22;
}

.setting-group select {
    width: 100%;
    padding: 8px 12px;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background-color: var(--color-surface);
    color: var(--color-text);
    font-size: 13px;
    cursor: pointer;
}

.setting-group input[type="range"] {
    width: 100%;
    margin-top: 4px;
    accent-color: var(--color-primary);
}

.setting-group textarea {
    width: 100%;
    padding: 8px 12px;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background-color: var(--color-surface);
    color: var(--color-text);
    font-family: var(--font-family);
    font-size: 13px;
    resize: vertical;
}

/* Toggle Switch */
.toggle-label {
    display: flex;
    align-items: center;
    justify-content: space-between;
    cursor: pointer;
    user-select: none;
    gap: 16px;
    min-height: 26px;
}

.toggle-label > span:first-child {
    flex: 1;
    display: flex;
    align-items: center;
}

.toggle-label input {
    display: none;
}

.toggle-slider {
    position: relative;
    display: inline-block;
    width: 50px;
    height: 26px;
    background-color: #ddd;
    border: 1px solid var(--color-border);
    border-radius: 13px;
    transition: all 0.3s ease;
    cursor: pointer;
    flex-shrink: 0;
    box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.1);
}

.toggle-slider::before {
    content: '';
    position: absolute;
    top: 3px;
    left: 3px;
    width: 20px;
    height: 20px;
    background-color: white;
    border-radius: 50%;
    transition: transform 0.3s ease;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
}

.toggle-label input:checked + .toggle-slider {
    background-color: var(--color-primary);
    border-color: var(--color-primary-hover);
    box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.2);
}

.toggle-label input:checked + .toggle-slider::before {
    transform: translateX(24px);
}

/* Hover effect */
.toggle-label:hover .toggle-slider {
    opacity: 0.9;
}

/* Dark mode toggle adjustments */
[data-theme="dark"] .toggle-slider {
    background-color: #3a3a3a;
    border-color: #555;
    box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.3);
}

[data-theme="dark"] .toggle-label input:checked + .toggle-slider {
    background-color: var(--color-primary);
    border-color: var(--color-primary-hover);
}

[data-theme="dark"] .toggle-slider::before {
    background-color: #f5f5f5;
    box-shadow: 0 2px 5px rgba(0, 0, 0, 0.5);
}

.thinking-budget-container {
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid var(--color-border-light);
    display: none;
}

.thinking-budget-container.visible {
    display: block;
}

/* Hidden state for temperature when thinking is enabled */
.setting-group.hidden {
    display: none;
}

/* Loading Overlay */
.loading-overlay {
    display: none;
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background-color: rgba(0, 0, 0, 0.3);
    z-index: 1000;
    align-items: center;
    justify-content: center;
}

.loading-overlay.visible {
    display: flex;
}

.loading-spinner {
    width: 40px;
    height: 40px;
    border: 3px solid var(--color-border);
    border-top-color: var(--color-primary);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
}

@keyframes spin {
    to { transform: rotate(360deg); }
}

/* Workspace Panel */
.workspace-panel {
    width: 0;
    overflow: hidden;
    background-color: var(--color-surface);
    border-left: 1px solid var(--color-border);
    transition: width var(--transition-normal);
    position: relative;
}

.workspace-panel.open {
    width: var(--settings-width);
}

.workspace-panel.drag-over::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background-color: rgba(91, 143, 191, 0.1);
    border: 2px dashed var(--color-primary);
    border-radius: 8px;
    margin: 8px;
    pointer-events: none;
    z-index: 1000;
}

.workspace-panel.drag-over::after {
    content: '📁 Drop files here';
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background-color: var(--color-surface);
    padding: 16px 24px;
    border-radius: 8px;
    font-size: 14px;
    color: var(--color-text);
    box-shadow: var(--shadow-md);
    pointer-events: none;
    z-index: 1001;
}

.workspace-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px;
    border-bottom: 1px solid var(--color-border);
}

.workspace-header h3 {
    font-size: 16px;
    font-weight: 600;
}

.workspace-content {
    padding: 16px;
    overflow-y: auto;
    height: calc(100vh - var(--header-height) - 57px);
}

.workspace-path {
    font-size: 12px;
    color: var(--color-text-secondary);
    padding: 8px 12px;
    background-color: var(--color-bg);
    border-radius: 6px;
    margin-bottom: 16px;
    word-break: break-all;
    font-family: monospace;
}

.workspace-files-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.workspace-file-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px;
    background-color: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    cursor: pointer;
    transition: all var(--transition-fast);
}

.workspace-file-item:hover {
    background-color: var(--color-surface-hover);
    border-color: var(--color-primary);
}

.workspace-file-info {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    min-width: 0;
}

.workspace-file-icon {
    font-size: 16px;
    flex-shrink: 0;
}

.workspace-file-name {
    font-size: 13px;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.workspace-file-size {
    font-size: 11px;
    color: var(--color-text-secondary);
    margin-left: 8px;
    flex-shrink: 0;
}

.workspace-file-actions {
    display: flex;
    gap: 4px;
    opacity: 0;
    transition: opacity var(--transition-fast);
}

.workspace-file-item:hover .workspace-file-actions {
    opacity: 1;
}

.workspace-file-action-btn {
    padding: 4px 8px;
    background-color: transparent;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    transition: all var(--transition-fast);
}

.workspace-file-action-btn:hover {
    background-color: var(--color-surface);
}

.workspace-file-action-btn.delete {
    color: #e74c3c;
}

.workspace-empty {
    text-align: center;
    padding: 40px 20px;
    color: var(--color-text-secondary);
}

/* Scrollbar Styling */
::-webkit-scrollbar {
    width: 8px;
    height: 8px;
}

::-webkit-scrollbar-track {
    background: transparent;
}

::-webkit-scrollbar-thumb {
    background-color: var(--color-secondary);
    border-radius: 4px;
}

::-webkit-scrollbar-thumb:hover {
    background-color: var(--color-text-secondary);
}

/* Streaming indicator */
.streaming-indicator {
    display: inline-block;
    width: 8px;
    height: 8px;
    background-color: var(--color-primary);
    border-radius: 50%;
    animation: pulse 1s infinite;
    margin-left: 4px;
    vertical-align: middle;
}

@keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
}

/* Modal Overlay */
.modal-overlay {
    display: none;
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background-color: rgba(0, 0, 0, 0.5);
    z-index: 1000;
    align-items: center;
    justify-content: center;
}

.modal-overlay.visible {
    display: flex;
}

.modal-content {
    background-color: var(--color-surface);
    border-radius: 12px;
    box-shadow: var(--shadow-lg);
    max-width: 90vw;
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
}

.modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px;
    border-bottom: 1px solid var(--color-border);
}

.modal-header h3 {
    font-size: 16px;
    font-weight: 600;
}

.modal-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-top: 1px solid var(--color-border);
    background-color: var(--color-border-light);
}

.modal-footer span {
    font-size: 13px;
    color: var(--color-text-secondary);
}

/* File Browser */
.file-browser {
    width: 600px;
}

.file-browser-path {
    padding: 8px 16px;
    background-color: var(--color-border-light);
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--color-text-secondary);
    border-bottom: 1px solid var(--color-border);
    display: flex;
    align-items: center;
    gap: 8px;
}

.file-browser-path .path-segment {
    cursor: pointer;
    color: var(--color-primary);
}

.file-browser-path .path-segment:hover {
    text-decoration: underline;
}

.file-browser-list {
    flex: 1;
    overflow-y: auto;
    min-height: 300px;
    max-height: 400px;
}

.file-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 16px;
    cursor: pointer;
    border-bottom: 1px solid var(--color-border-light);
    transition: background-color var(--transition-fast);
}

.file-item:hover {
    background-color: var(--color-border-light);
}

.file-item.selected {
    background-color: var(--color-primary);
    color: white;
}

.file-item.selected .file-size {
    color: rgba(255, 255, 255, 0.7);
}

.file-item-icon {
    font-size: 20px;
    width: 24px;
    text-align: center;
}

.file-item-info {
    flex: 1;
    min-width: 0;
}

.file-item-name {
    font-size: 14px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.file-size {
    font-size: 12px;
    color: var(--color-text-secondary);
}

.file-item-checkbox {
    width: 18px;
    height: 18px;
    accent-color: var(--color-primary);
}

/* Buttons */
.btn {
    padding: 8px 16px;
    border: none;
    border-radius: 6px;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: all var(--transition-fast);
}

.btn-primary {
    background-color: var(--color-primary);
    color: white;
}

.btn-primary:hover:not(:disabled) {
    background-color: var(--color-primary-hover);
}

.btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

/* Responsive */
@media (max-width: 768px) {
    .sidebar {
        position: absolute;
        left: -var(--sidebar-width);
        height: calc(100vh - var(--header-height));
        z-index: 50;
        transition: left var(--transition-normal);
    }

    .sidebar.open {
        left: 0;
    }

    .settings-panel {
        position: absolute;
        right: 0;
        height: calc(100vh - var(--header-height));
        z-index: 50;
    }

    .message {
        max-width: 100%;
    }

    .message.user {
        max-width: 85%;
    }

    .file-browser {
        width: 95vw;
    }

    .input-area-wrapper {
        padding: 12px 16px 16px;
    }

    .status-bar {
        gap: 16px;
        padding: 6px 12px;
        font-size: 10px;
    }
}

/* Prompt Library */
.prompt-library-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
}

.btn-small {
    padding: 4px 10px;
    font-size: 12px;
    background: var(--color-primary);
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    transition: background var(--transition-fast);
}

.btn-small:hover {
    background: var(--color-primary-hover);
}

.prompt-library-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: 400px;
    overflow-y: auto;
}

.prompt-item {
    background: var(--color-border-light);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    padding: 10px;
    transition: all var(--transition-fast);
}

.prompt-item:hover {
    background: var(--color-surface);
    box-shadow: var(--shadow-sm);
}

.prompt-item-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 6px;
}

.prompt-name {
    font-weight: 500;
    font-size: 13px;
    color: var(--color-text);
}

.prompt-actions {
    display: flex;
    gap: 4px;
}

.prompt-action-btn {
    padding: 4px 8px;
    background: transparent;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    color: var(--color-text-secondary);
    transition: all var(--transition-fast);
}

.prompt-action-btn:hover {
    background: var(--color-border);
    color: var(--color-text);
}

.prompt-preview {
    font-size: 12px;
    color: var(--color-text-secondary);
    line-height: 1.4;
    white-space: pre-wrap;
}

/* Prompt Library Modal */
.prompt-library-modal {
    max-width: 700px;
    max-height: 80vh;
}

.prompt-library-modal-list {
    display: flex;
    flex-direction: column;
    gap: 16px;
    max-height: 60vh;
    overflow-y: auto;
    padding: 20px;
}

.prompt-modal-item {
    background: var(--color-border-light);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    padding: 16px;
    transition: all var(--transition-fast);
}

.prompt-modal-item:hover {
    background: var(--color-surface);
    box-shadow: var(--shadow-md);
}

.prompt-modal-header {
    margin-bottom: 12px;
}

.prompt-modal-name {
    font-weight: 600;
    font-size: 15px;
    color: var(--color-text);
}

.prompt-modal-content {
    font-size: 13px;
    color: var(--color-text);
    line-height: 1.6;
    white-space: pre-wrap;
    background: var(--color-surface);
    padding: 12px;
    border-radius: 6px;
    margin-bottom: 12px;
    max-height: 200px;
    overflow-y: auto;
}

.prompt-modal-actions {
    display: flex;
    justify-content: flex-end;
}

.insert-modal-btn {
    background: var(--color-primary) !important;
    color: white !important;
}

.insert-modal-btn:hover {
    background: var(--color-primary-hover) !important;
}

/* Edit Prompt Modal */
.edit-prompt-modal {
    max-width: 800px;
    width: 90%;
}

.edit-prompt-form {
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 16px;
}

.form-group {
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.form-group label {
    font-weight: 500;
    font-size: 13px;
    color: var(--color-text);
}

.form-group input[type="text"],
.form-group textarea {
    padding: 10px;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    font-size: 14px;
    font-family: inherit;
    background: var(--color-surface);
    color: var(--color-text);
    resize: vertical;
}

.form-group input[type="text"]:focus,
.form-group textarea:focus {
    outline: none;
    border-color: var(--color-primary);
    box-shadow: 0 0 0 3px rgba(193, 95, 60, 0.1);
}

/* Input Area Wrapper */
.input-area-wrapper {
    position: relative;
    padding: 16px 20px 20px;
    background-color: var(--color-background);
    border-top: 1px solid var(--color-border);
}

/* Status Bar */
.status-bar {
    display: flex;
    justify-content: center;
    gap: 24px;
    max-width: 800px;
    margin: 8px auto 0;
    padding: 6px 16px;
    font-size: 11px;
    color: var(--color-text-secondary);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    background: var(--color-surface);
}

.status-item {
    display: flex;
    align-items: center;
    gap: 4px;
}

.status-label {
    font-weight: 500;
    color: var(--color-text-secondary);
}

.status-value {
    color: var(--color-text);
    font-weight: 600;
}

.status-warning {
    color: var(--color-warning);
}

/* Code Block Copy Button */
.code-block-wrapper {
    position: relative;
}

.code-copy-btn {
    position: absolute;
    top: 8px;
    right: 8px;
    padding: 6px 10px;
    background: rgba(0, 0, 0, 0.6);
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    opacity: 0;
    transition: all var(--transition-fast);
    z-index: 10;
}

.code-block-wrapper:hover .code-copy-btn {
    opacity: 1;
}

.code-copy-btn:hover {
    background: rgba(0, 0, 0, 0.8);
}

.code-copy-btn.copied {
    background: #4CAF50 !important;
    opacity: 1 !important;
}

/* Streaming indicator dot for conversation list */
.streaming-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    background-color: var(--color-primary);
    border-radius: 50%;
    margin-right: 6px;
    animation: pulse 1s infinite;
    vertical-align: middle;
    flex-shrink: 0;
}

/* Message text container for smooth streaming */
.message-text {
    /* Smooth font rendering for streaming text */
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
}

/* Streaming text cursor effect */
.streaming-indicator {
    display: inline-block;
    width: 8px;
    height: 8px;
    background-color: var(--color-primary);
    border-radius: 50%;
    margin-left: 4px;
    animation: pulse 1s infinite;
    vertical-align: middle;
}

/* Conversation item with streaming indicator */
.conversation-item.streaming {
    position: relative;
}

.conversation-item.streaming::before {
    content: '';
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 3px;
    background-color: var(--color-primary);
    border-radius: 0 2px 2px 0;
}

/* Agent Chat Button */
.sidebar-buttons {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 12px;
}

.sidebar-buttons .new-chat-btn {
    margin: 0;
}

.new-chat-btn.agent-btn {
    background-color: #5B8FBF;
}

.new-chat-btn.agent-btn:hover {
    background-color: #4A7EAE;
}

/* Agent conversation indicator in sidebar */
.conversation-item.agent {
    border-left: 3px solid #5B8FBF;
}

.agent-icon {
    width: 18px;
    height: 18px;
    flex-shrink: 0;
    object-fit: contain;
}

/* Compaction Separator */
.compaction-separator {
    display: flex;
    align-items: center;
    gap: 16px;
    margin: 24px 0;
    padding: 0 20px;
}

.compaction-line {
    flex: 1;
    height: 2px;
    background: linear-gradient(90deg, transparent, var(--color-border), var(--color-border), transparent);
}

.compaction-label {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 1.5px;
    color: var(--color-text-secondary);
    background: var(--color-background);
    padding: 4px 12px;
    border-radius: 12px;
    border: 1px solid var(--color-border);
    white-space: nowrap;
}

[data-theme="dark"] .compaction-label {
    background: var(--color-surface);
}

/* Tool Use Blocks for Agent Messages */
.tool-use-block {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    margin: 8px 0;
    overflow: hidden;
    font-size: 13px;
}

.tool-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: var(--color-border-light);
    font-weight: 500;
    cursor: pointer;
    user-select: none;
    transition: background-color 0.15s ease;
}

.tool-header:hover {
    background: var(--color-border);
}

.tool-expand-icon {
    font-size: 10px;
    color: var(--color-text-secondary);
    width: 12px;
    transition: transform 0.15s ease;
}

.tool-icon {
    font-size: 14px;
}

.tool-name {
    color: var(--color-text);
    font-weight: 600;
    white-space: nowrap;
}

.tool-brief {
    flex: 1;
    color: var(--color-text-secondary);
    font-weight: 400;
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    margin-left: 4px;
}

.tool-status {
    font-size: 10px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
}

.tool-status.running {
    background: var(--color-warning);
    color: white;
    animation: pulse 1.5s infinite;
}

@keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.7; }
}

.tool-status.success {
    background: var(--color-success);
    color: white;
}

.tool-status.error {
    background: var(--color-error);
    color: white;
}

.tool-details {
    border-top: 1px solid var(--color-border);
}

.tool-section-label {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--color-text-secondary);
    margin-bottom: 6px;
}

.tool-input {
    padding: 10px 12px;
    background: var(--color-background);
    max-height: 200px;
    overflow-y: auto;
}

.tool-input pre {
    margin: 0;
    padding: 0;
    background: transparent;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 11px;
    font-family: var(--font-mono);
    color: var(--color-text-secondary);
}

.tool-result {
    padding: 10px 12px;
    border-top: 1px solid var(--color-border);
    background: var(--color-surface);
    max-height: 300px;
    overflow-y: auto;
}

.tool-result pre {
    margin: 0;
    font-family: var(--font-mono);
    font-size: 11px;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--color-text);
}

.tool-result.error {
    background: rgba(193, 95, 60, 0.1);
}

.tool-result.error pre {
    color: var(--color-error);
}

/* Subagent transcript styling */
.subagent-transcript {
    padding: 10px 12px;
    border-top: 1px solid var(--color-border);
    background: var(--color-background);
}

.subagent-content {
    margin-top: 8px;
    padding-left: 12px;
    border-left: 2px solid var(--color-primary);
}

.subagent-content .tool-use-block {
    margin: 6px 0;
    font-size: 12px;
}

.subagent-content .tool-header {
    padding: 6px 10px;
}

/* Dark mode tool block adjustments */
[data-theme="dark"] .tool-use-block {
    background: var(--color-surface);
}

[data-theme="dark"] .tool-header {
    background: var(--color-border);
}

[data-theme="dark"] .tool-header:hover {
    background: var(--color-border-light);
}

[data-theme="dark"] .tool-input {
    background: #1a1a1a;
}

[data-theme="dark"] .subagent-transcript {
    background: #1a1a1a;
}

[data-theme="dark"] .tool-result.error {
    background: rgba(217, 117, 85, 0.15);
}

/* Agent text blocks - for chronological ordering with tool blocks */
.agent-text-block {
    margin: 8px 0;
}

.agent-text-block:first-child {
    margin-top: 0;
}

.agent-text-block:empty {
    display: none;
}

/* Surface Content Blocks - for displaying rich HTML/markdown to users */
.surface-content-block {
    background: var(--color-surface);
    border: 2px solid var(--color-primary);
    border-radius: 8px;
    margin: 12px 0;
    overflow: hidden;
}

.surface-header {
    background: linear-gradient(135deg, var(--color-primary), var(--color-primary-hover));
    color: white;
    padding: 10px 14px;
    font-weight: 600;
    font-size: 14px;
    display: flex;
    align-items: center;
    gap: 8px;
}

.surface-icon {
    font-size: 16px;
}

.surface-iframe {
    width: 100%;
    min-height: 100px;
    max-height: 600px;
    border: none;
    background: white;
}

.surface-markdown {
    padding: 16px;
    background: var(--color-surface);
}

.surface-markdown h1, .surface-markdown h2, .surface-markdown h3 {
    margin-top: 0;
    color: var(--color-text);
}

.surface-markdown table {
    width: 100%;
    border-collapse: collapse;
    margin: 12px 0;
}

.surface-markdown th,
.surface-markdown td {
    border: 1px solid var(--color-border);
    padding: 8px 12px;
    text-align: left;
}

.surface-markdown th {
    background: var(--color-background);
    font-weight: 600;
}

.surface-markdown tr:hover {
    background: var(--color-background);
}

[data-theme="dark"] .surface-content-block {
    border-color: var(--color-primary);
}

[data-theme="dark"] .surface-iframe {
    background: #1a1a1a;
}

[data-theme="dark"] .surface-markdown th {
    background: var(--color-border);
}

/* Surface content - clickable */
.surface-content-block {
    cursor: pointer;
    transition: transform 0.15s ease, box-shadow 0.15s ease;
}

.surface-content-block:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

.surface-header {
    display: flex;
    align-items: center;
    gap: 8px;
}

.surface-title {
    flex: 1;
}

.surface-expand-hint {
    font-size: 11px;
    opacity: 0.7;
    font-weight: normal;
}

.surface-header-minimal {
    padding: 6px 14px;
    justify-content: flex-end;
}

.surface-loading .surface-loading-body {
    padding: 40px;
    text-align: center;
    color: var(--color-text-secondary);
    font-style: italic;
}

.surface-loading:hover {
    transform: none;
    box-shadow: none;
    cursor: default;
}

.surface-error .surface-loading-body {
    color: var(--color-error);
}

/* Surface Modal - Fullscreen overlay */
.surface-modal {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 10000;
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0;
    transition: opacity 0.2s ease;
}

.surface-modal.open {
    opacity: 1;
}

.surface-modal.closing {
    opacity: 0;
}

.surface-modal-backdrop {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.7);
}

.surface-modal-container {
    position: relative;
    width: 90vw;
    height: 90vh;
    max-width: 1400px;
    background: var(--color-surface);
    border-radius: 12px;
    box-shadow: 0 25px 50px rgba(0, 0, 0, 0.3);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    transform: scale(0.95);
    transition: transform 0.2s ease;
}

.surface-modal.open .surface-modal-container {
    transform: scale(1);
}

.surface-modal-header {
    display: flex;
    align-items: center;
    padding: 16px 20px;
    background: linear-gradient(135deg, var(--color-primary), var(--color-primary-hover));
    color: white;
}

.surface-modal-title {
    flex: 1;
    font-size: 18px;
    font-weight: 600;
}

.surface-modal-close {
    width: 32px;
    height: 32px;
    border: none;
    background: rgba(255, 255, 255, 0.2);
    color: white;
    font-size: 24px;
    line-height: 1;
    border-radius: 6px;
    cursor: pointer;
    transition: background 0.15s ease;
}

.surface-modal-close:hover {
    background: rgba(255, 255, 255, 0.3);
}

.surface-modal-body {
    flex: 1;
    overflow: auto;
    background: white;
}

.surface-modal-iframe {
    width: 100%;
    height: 100%;
    border: none;
}

.surface-modal-markdown {
    padding: 24px;
    max-width: 900px;
    margin: 0 auto;
}

.surface-modal-markdown h1 {
    font-size: 28px;
    margin-bottom: 16px;
}

.surface-modal-markdown h2 {
    font-size: 22px;
    margin-top: 24px;
    margin-bottom: 12px;
}

.surface-modal-markdown table {
    width: 100%;
    border-collapse: collapse;
    margin: 16px 0;
}

.surface-modal-markdown th,
.surface-modal-markdown td {
    border: 1px solid #ddd;
    padding: 12px 16px;
    text-align: left;
}

.surface-modal-markdown th {
    background: #f5f5f5;
    font-weight: 600;
}

[data-theme="dark"] .surface-modal-body {
    background: var(--color-surface);
}

[data-theme="dark"] .surface-modal-markdown th {
    background: var(--color-border);
}

/* GIF Result Styling */
.tool-result.gif-result-container {
    padding: 8px;
    max-height: none;
    overflow: visible;
    background: var(--color-background);
}

.gif-result {
    text-align: center;
}

.gif-result .gif-image {
    max-width: 100%;
    max-height: 300px;
    border-radius: 8px;
    box-shadow: var(--shadow-md);
}

.gif-result .gif-title {
    margin-top: 8px;
    font-size: 12px;
    color: var(--color-text-secondary);
    font-family: var(--font-family);
}

/* Embedded GIF in text content */
.embedded-gif {
    margin: 12px 0;
    text-align: center;
}

.embedded-gif .gif-image {
    max-width: 100%;
    max-height: 350px;
    border-radius: 8px;
    box-shadow: var(--shadow-md);
}

/* Default Settings Modal */
.default-settings-modal {
    width: 90vw;
    max-width: 700px;
    max-height: 90vh;
    height: 90vh;  /* Ensure modal uses available height */
}

.default-settings-content {
    flex: 1;
    overflow-y: auto;
    padding: 20px;
    min-height: 0;  /* Required for flex child to scroll */
}

.default-settings-tabs {
    display: flex;
    gap: 8px;
    margin-bottom: 20px;
    border-bottom: 1px solid var(--color-border);
    padding-bottom: 12px;
}

.default-settings-tabs .tab-btn {
    padding: 8px 16px;
    background: var(--color-border-light);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    font-size: 14px;
    cursor: pointer;
    transition: all var(--transition-fast);
    color: var(--color-text-secondary);
}

.default-settings-tabs .tab-btn:hover {
    background: var(--color-background);
    color: var(--color-text);
}

.default-settings-tabs .tab-btn.active {
    background: var(--color-primary);
    border-color: var(--color-primary);
    color: white;
}

.default-settings-tab-content {
    display: flex;
    flex-direction: column;
    gap: 16px;
}

.default-settings-tab-content .setting-group {
    margin-bottom: 8px;
}

.default-settings-tab-content .setting-group label {
    display: block;
    font-size: 13px;
    font-weight: 500;
    margin-bottom: 6px;
    color: var(--color-text);
}

.default-settings-tab-content .setting-group select,
.default-settings-tab-content .setting-group textarea,
.default-settings-tab-content .setting-group input[type="range"] {
    width: 100%;
}

.default-settings-tab-content .setting-group select,
.default-settings-tab-content .setting-group textarea {
    padding: 8px 10px;
    background: var(--color-background);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    font-size: 13px;
    color: var(--color-text);
}

.default-settings-tab-content .setting-group select:focus,
.default-settings-tab-content .setting-group textarea:focus {
    outline: none;
    border-color: var(--color-primary);
}

.default-settings-tab-content .thinking-budget-container {
    display: none;
    margin-top: 8px;
    padding: 10px;
    background: var(--color-border-light);
    border-radius: 6px;
}

.default-settings-tab-content .thinking-budget-container.visible {
    display: block;
}

.default-settings-tab-content .toggle-label {
    display: flex;
    align-items: center;
    justify-content: space-between;
    cursor: pointer;
}

.default-settings-tab-content .toggle-slider {
    width: 44px;
    height: 24px;
    background: var(--color-border);
    border-radius: 12px;
    position: relative;
    transition: background var(--transition-fast);
}

.default-settings-tab-content .toggle-slider::after {
    content: '';
    position: absolute;
    width: 20px;
    height: 20px;
    background: white;
    border-radius: 50%;
    top: 2px;
    left: 2px;
    transition: transform var(--transition-fast);
}

.default-settings-tab-content input[type="checkbox"] {
    display: none;
}

/* Override for tool toggles - show checkboxes */
.default-settings-tab-content .tool-toggles input[type="checkbox"],
#default-agent-tools input[type="checkbox"],
#quick-agent-tools input[type="checkbox"] {
    display: inline-block;
    width: 16px;
    height: 16px;
    accent-color: var(--color-primary);
    cursor: pointer;
}

.default-settings-tab-content input[type="checkbox"]:checked + .toggle-slider {
    background: var(--color-primary);
}

.default-settings-tab-content input[type="checkbox"]:checked + .toggle-slider::after {
    transform: translateX(20px);
}

.default-settings-tab-content .hidden {
    display: none !important;
}

.default-settings-tab-content input[type="text"] {
    width: 100%;
    padding: 8px 12px;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-background);
    color: var(--color-text);
    font-size: 14px;
    font-family: var(--font-mono);
}

.default-settings-tab-content input[type="text"]:focus {
    outline: none;
    border-color: var(--color-primary);
}

.default-settings-tab-content .agent-info {
    padding: 12px;
    background: var(--color-border-light);
    border-radius: 6px;
    font-size: 13px;
    line-height: 1.5;
}

/* Projects Section */
.projects-section {
    padding: 0 8px 8px;
    border-bottom: 1px solid var(--color-border);
    margin-bottom: 8px;
}

.project-item {
    margin-bottom: 4px;
    border-radius: 8px;
    background-color: var(--color-border-light);
}

.project-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    cursor: pointer;
    transition: background-color var(--transition-fast);
    user-select: none;
}

.project-header:hover {
    background-color: var(--color-border);
}

.project-header.drag-over {
    background-color: rgba(193, 95, 60, 0.2);
    outline: 2px dashed var(--color-primary);
    outline-offset: -2px;
}

.project-expand-icon {
    font-size: 10px;
    color: var(--color-text-secondary);
    width: 14px;
    text-align: center;
}

.project-color-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
}

.project-name {
    flex: 1;
    font-size: 13px;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.project-count {
    font-size: 11px;
    color: var(--color-text-secondary);
}

.project-memory-icon {
    font-size: 12px;
    margin-left: 2px;
    opacity: 0.8;
}

.project-actions {
    display: flex;
    align-items: center;
    gap: 4px;
    opacity: 0;
    transition: opacity var(--transition-fast);
}

.project-header:hover .project-actions {
    opacity: 1;
}

/* New chat buttons in project header */
.project-new-chat-btn,
.project-new-agent-btn {
    width: 20px;
    height: 20px;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 14px;
    font-weight: bold;
    line-height: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all var(--transition-fast);
}

.project-new-chat-btn {
    background-color: var(--color-primary);
    color: white;
}

.project-new-chat-btn:hover {
    background-color: #a84f32;
    transform: scale(1.1);
}

.project-new-agent-btn {
    background-color: #5B8DEF;
    color: white;
}

.project-new-agent-btn:hover {
    background-color: #4a7dd9;
    transform: scale(1.1);
}

/* 3-dot menu */
.project-menu-container {
    position: relative;
}

.project-menu-btn {
    padding: 4px 6px;
    background: none;
    border: none;
    color: var(--color-text-secondary);
    cursor: pointer;
    border-radius: 4px;
    font-size: 14px;
    transition: all var(--transition-fast);
}

.project-menu-btn:hover {
    background-color: rgba(0, 0, 0, 0.1);
    color: var(--color-text);
}

.project-menu-dropdown {
    display: none;
    position: fixed;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    box-shadow: var(--shadow-lg);
    z-index: 1000;
    flex-direction: row;
    gap: 2px;
    padding: 4px;
}

.project-menu-dropdown.open {
    display: flex;
}

.project-menu-item {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: none;
    background: none;
    color: var(--color-text-secondary);
    cursor: pointer;
    font-size: 14px;
    border-radius: 4px;
    transition: all var(--transition-fast);
}

.project-menu-item:hover {
    background-color: rgba(0, 0, 0, 0.08);
    color: var(--color-text);
}

.project-menu-item.project-color-btn:hover {
    background-color: var(--color-primary);
    color: white;
}

.project-menu-item.project-rename-btn:hover {
    background-color: #5B8DEF;
    color: white;
}

.project-menu-item.project-delete-btn:hover {
    background-color: var(--color-error);
    color: white;
}

.project-menu-item.project-settings-btn:hover {
    background-color: #6c757d;
    color: white;
}

/* Project Settings Modal */
.project-settings-modal {
    display: none;
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 2000;
}

.project-settings-modal.open {
    display: flex;
    align-items: center;
    justify-content: center;
}

.project-settings-overlay {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.5);
}

.project-settings-content {
    position: relative;
    background: var(--color-surface);
    border-radius: 12px;
    box-shadow: var(--shadow-lg);
    width: 500px;
    max-width: 90vw;
    max-height: 80vh;
    overflow: hidden;
    display: flex;
    flex-direction: column;
}

.project-settings-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 16px 20px;
    border-bottom: 1px solid var(--color-border);
}

.project-settings-header h2 {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
}

.project-settings-name {
    color: var(--color-text-secondary);
    font-size: 14px;
}

.project-settings-close {
    margin-left: auto;
    background: none;
    border: none;
    font-size: 24px;
    cursor: pointer;
    color: var(--color-text-secondary);
    padding: 0;
    line-height: 1;
}

.project-settings-close:hover {
    color: var(--color-text);
}

.project-settings-tabs {
    display: flex;
    border-bottom: 1px solid var(--color-border);
    padding: 0 20px;
}

.project-settings-tab {
    padding: 12px 16px;
    background: none;
    border: none;
    cursor: pointer;
    font-size: 14px;
    color: var(--color-text-secondary);
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    transition: all var(--transition-fast);
}

.project-settings-tab:hover {
    color: var(--color-text);
}

.project-settings-tab.active {
    color: var(--color-primary);
    border-bottom-color: var(--color-primary);
}

.project-settings-body {
    flex: 1;
    overflow-y: auto;
    padding: 20px;
}

.project-settings-panel {
    display: none;
}

.project-settings-panel.active {
    display: block;
}

.project-settings-panel .setting-group {
    margin-bottom: 16px;
}

.project-settings-panel .setting-group label {
    display: block;
    margin-bottom: 6px;
    font-size: 13px;
    font-weight: 500;
    color: var(--color-text-secondary);
}

.project-settings-panel .setting-group select,
.project-settings-panel .setting-group textarea,
.project-settings-panel .setting-group input[type="range"] {
    width: 100%;
}

.project-settings-panel .setting-group select {
    padding: 8px 12px;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-background);
    color: var(--color-text);
    font-size: 14px;
}

.project-settings-panel .setting-group textarea {
    padding: 8px 12px;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-background);
    color: var(--color-text);
    font-size: 14px;
    resize: vertical;
}

.project-settings-panel .setting-group input[type="checkbox"] {
    width: auto;
    margin-right: 8px;
}

.project-settings-footer {
    display: flex;
    justify-content: flex-end;
    gap: 12px;
    padding: 16px 20px;
    border-top: 1px solid var(--color-border);
}

.project-settings-footer .btn-secondary {
    padding: 8px 16px;
    background: var(--color-border);
    border: none;
    border-radius: 6px;
    cursor: pointer;
    font-size: 14px;
    color: var(--color-text);
}

.project-settings-footer .btn-secondary:hover {
    background: var(--color-border-light);
}

.project-settings-footer .btn-primary {
    padding: 8px 16px;
    background: var(--color-primary);
    border: none;
    border-radius: 6px;
    cursor: pointer;
    font-size: 14px;
    color: white;
}

.project-settings-footer .btn-primary:hover {
    background: #a84f32;
}

.project-conversations {
    padding: 4px 8px 8px 24px;
    max-height: 300px;
    overflow-y: auto;
    overflow-x: hidden;
}

/* Scrollbar styling for project conversations */
.project-conversations::-webkit-scrollbar {
    width: 6px;
}

.project-conversations::-webkit-scrollbar-track {
    background: transparent;
}

.project-conversations::-webkit-scrollbar-thumb {
    background-color: var(--color-border);
    border-radius: 3px;
}

.project-conversations::-webkit-scrollbar-thumb:hover {
    background-color: var(--color-text-secondary);
}

.project-conversations.drag-over {
    background-color: rgba(193, 95, 60, 0.1);
}

.project-empty {
    padding: 12px;
    text-align: center;
    font-size: 12px;
    color: var(--color-text-secondary);
    font-style: italic;
}

.project-conversation {
    padding: 8px 10px;
    margin-bottom: 2px;
    border-radius: 6px;
    font-size: 12px;
}

.project-conversation:last-child {
    margin-bottom: 0;
}

.project-rename-input,
.conversation-rename-input {
    width: 100%;
    padding: 2px 6px;
    border: 1px solid var(--color-primary);
    border-radius: 4px;
    background: var(--color-surface);
    color: var(--color-text);
    font-size: 13px;
    outline: none;
}

.project-conversation .conversation-rename {
    padding: 2px 6px;
    background: none;
    border: none;
    color: var(--color-text-secondary);
    font-size: 12px;
    cursor: pointer;
    opacity: 0;
    transition: opacity var(--transition-fast);
}

.project-conversation:hover .conversation-rename {
    opacity: 1;
}

.project-conversation .conversation-rename:hover {
    color: var(--color-primary);
}

.conversation-remove-from-project,
.project-conversation .conversation-settings {
    padding: 2px 6px;
    background: none;
    border: none;
    color: var(--color-text-secondary);
    cursor: pointer;
    border-radius: 4px;
    font-size: 10px;
    transition: all var(--transition-fast);
}

.conversation-remove-from-project:hover {
    background-color: var(--color-error);
    color: white;
}

.project-conversation .conversation-settings:hover {
    background-color: var(--color-primary);
    color: white;
}

/* Color Picker */
.project-color-picker {
    display: flex;
    gap: 6px;
    padding: 8px;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    box-shadow: var(--shadow-md);
    z-index: 1001;
}

.color-option {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    border: 2px solid transparent;
    cursor: pointer;
    transition: all var(--transition-fast);
}

.color-option:hover {
    transform: scale(1.15);
    border-color: var(--color-text);
}

/* New Project Button */
.new-chat-btn.project-btn {
    background-color: var(--color-secondary);
    color: var(--color-text);
}

.new-chat-btn.project-btn:hover {
    background-color: #9A968B;
}

/* Drag and Drop States */
.conversation-item.dragging {
    opacity: 0.5;
    border: 2px dashed var(--color-primary);
}

.conversations-list.drag-over {
    background-color: rgba(193, 95, 60, 0.1);
    border-radius: 8px;
}

/* Dark theme adjustments for projects */
[data-theme="dark"] .project-item {
    background-color: var(--color-border);
}

[data-theme="dark"] .project-header:hover {
    background-color: var(--color-border-light);
}

[data-theme="dark"] .project-color-picker {
    background: var(--color-surface);
    border-color: var(--color-border-light);
}

[data-theme="dark"] .project-menu-btn:hover {
    background-color: rgba(255, 255, 255, 0.1);
}

[data-theme="dark"] .project-menu-dropdown {
    background: var(--color-surface);
    border-color: var(--color-border-light);
}

[data-theme="dark"] .project-menu-item:hover {
    background-color: rgba(255, 255, 255, 0.05);
}

[data-theme="dark"] .new-chat-btn.project-btn {
    background-color: #4A4744;
    color: var(--color-text);
}

[data-theme="dark"] .new-chat-btn.project-btn:hover {
    background-color: #5A5754;
}

/* Project Badge for search results */
.project-badge {
    display: inline-block;
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 500;
    color: white;
    margin-left: 6px;
    flex-shrink: 0;
    max-width: 60px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

/* Workspace Sections */
.workspace-section {
    margin-bottom: 16px;
}

.workspace-section-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 0;
    font-size: 12px;
    font-weight: 600;
    color: var(--color-text);
    border-bottom: 1px solid var(--color-border);
    margin-bottom: 8px;
}

.workspace-section.memory-section {
    background: linear-gradient(to bottom, rgba(155, 89, 182, 0.05), transparent);
    padding: 8px;
    border-radius: 8px;
    margin-bottom: 12px;
}

.workspace-section.memory-section .workspace-section-header {
    color: #9B59B6;
    border-bottom-color: rgba(155, 89, 182, 0.3);
}

.workspace-file-item.memory-file {
    background: rgba(155, 89, 182, 0.08);
    border-color: rgba(155, 89, 182, 0.2);
}

.workspace-file-item.memory-file:hover {
    border-color: #9B59B6;
}

.workspace-empty.small {
    padding: 12px;
    font-size: 12px;
}

[data-theme="dark"] .workspace-section.memory-section {
    background: linear-gradient(to bottom, rgba(155, 89, 182, 0.1), transparent);
}

[data-theme="dark"] .workspace-file-item.memory-file {
    background: rgba(155, 89, 182, 0.15);
    border-color: rgba(155, 89, 182, 0.3);
}

/* Tool Toggles in Project Settings */
.tool-toggles {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 8px;
    padding: 12px;
    background: var(--color-border-light);
    border-radius: 8px;
    margin-top: 8px;
}

.tool-toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    cursor: pointer;
    padding: 6px 8px;
    border-radius: 4px;
    transition: background-color var(--transition-fast);
}

.tool-toggle:hover {
    background-color: var(--color-background);
}

.tool-toggle input[type="checkbox"] {
    width: 16px;
    height: 16px;
    accent-color: var(--color-primary);
    cursor: pointer;
}

[data-theme="dark"] .tool-toggles {
    background: var(--color-border);
}

[data-theme="dark"] .tool-toggle:hover {
    background-color: var(--color-border-light);
}

/* Tool Badges (read-only display in conversation settings) */
.tool-badges {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 8px 0;
}

.tool-badge {
    padding: 4px 10px;
    border-radius: 12px;
    font-size: 12px;
    font-weight: 500;
}

.tool-badge.enabled {
    background: var(--color-success);
    color: white;
}

.tool-badge.disabled {
    background: var(--color-border);
    color: var(--color-text-secondary);
    text-decoration: line-through;
}

/* Agent CWD Display (read-only) */
.agent-cwd-display {
    padding: 8px 12px;
    background: var(--color-border-light);
    border-radius: 6px;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--color-text);
}

.agent-cwd-display .cwd-path {
    word-break: break-all;
}

[data-theme="dark"] .agent-cwd-display {
    background: var(--color-border);
}

/* Quick Agent Settings Modal */
#quick-agent-modal {
    z-index: 1100;  /* Above default settings */
}

.quick-agent-settings {
    width: 500px;
    max-width: 90vw;
    max-height: 90vh;
}

.quick-agent-content {
    padding: 20px;
    overflow-y: auto;
    max-height: 60vh;
}

.quick-agent-content .setting-group {
    margin-bottom: 16px;
}

.quick-agent-content .setting-group label {
    display: block;
    font-size: 13px;
    font-weight: 500;
    margin-bottom: 6px;
    color: var(--color-text);
}

.quick-agent-content .setting-group select,
.quick-agent-content .setting-group textarea,
.quick-agent-content .setting-group input[type="text"] {
    width: 100%;
    padding: 8px 12px;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-background);
    color: var(--color-text);
    font-size: 14px;
    font-family: inherit;
}

.quick-agent-content .setting-group select:focus,
.quick-agent-content .setting-group textarea:focus,
.quick-agent-content .setting-group input[type="text"]:focus {
    outline: none;
    border-color: var(--color-primary);
}

.quick-agent-content .setting-group textarea {
    resize: vertical;
    min-height: 60px;
}

.quick-agent-content .setting-group input[type="text"] {
    font-family: var(--font-mono);
}

/* CWD Input in Project Settings */
.project-settings-panel input[type="text"] {
    width: 100%;
    padding: 8px 12px;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-background);
    color: var(--color-text);
    font-size: 14px;
    font-family: var(--font-mono);
}

.project-settings-panel input[type="text"]:focus {
    outline: none;
    border-color: var(--color-primary);
}

/* Web Search Settings */
.web-search-config {
    display: none;
    margin-top: 12px;
    padding: 10px;
    background: var(--color-border-light);
    border-radius: 6px;
}

[data-theme="dark"] .web-search-config {
    background: var(--color-border);
}

/* Web Search Results Block */
.web-search-block {
    margin: 12px 0;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    overflow: hidden;
    background: var(--color-surface);
}

.web-search-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    background: linear-gradient(135deg, #2563eb10, #3b82f620);
    cursor: pointer;
    user-select: none;
    border-bottom: 1px solid var(--color-border);
}

.web-search-header:hover {
    background: linear-gradient(135deg, #2563eb18, #3b82f630);
}

.web-search-toggle {
    font-size: 10px;
    color: var(--color-text-secondary);
    transition: transform 0.15s ease;
}

.web-search-block.expanded .web-search-toggle {
    transform: rotate(90deg);
}

.web-search-icon {
    font-size: 16px;
}

.web-search-label {
    flex: 1;
    font-size: 13px;
    font-weight: 500;
    color: var(--color-text);
}

.web-search-status {
    font-size: 10px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
}

.web-search-status.searching {
    background: #3b82f6;
    color: white;
    animation: pulse 1.5s infinite;
}

.web-search-status.complete {
    background: var(--color-success);
    color: white;
}

.web-search-content {
    display: none;
    padding: 12px;
    max-height: 400px;
    overflow-y: auto;
}

.web-search-block.expanded .web-search-content {
    display: block;
}

.web-search-results {
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.web-search-result-item {
    padding: 10px;
    background: var(--color-border-light);
    border-radius: 6px;
    border-left: 3px solid #3b82f6;
}

.web-search-result-title {
    font-size: 14px;
    font-weight: 500;
    color: #3b82f6;
    text-decoration: none;
    display: block;
    margin-bottom: 4px;
}

.web-search-result-title:hover {
    text-decoration: underline;
}

.web-search-result-url {
    font-size: 11px;
    color: var(--color-text-secondary);
    margin-bottom: 6px;
    word-break: break-all;
}

.web-search-result-snippet {
    font-size: 12px;
    color: var(--color-text);
    line-height: 1.5;
}

[data-theme="dark"] .web-search-block {
    background: var(--color-surface);
}

[data-theme="dark"] .web-search-header {
    background: linear-gradient(135deg, #2563eb20, #3b82f630);
}

[data-theme="dark"] .web-search-header:hover {
    background: linear-gradient(135deg, #2563eb30, #3b82f640);
}

[data-theme="dark"] .web-search-result-item {
    background: var(--color-border);
}

/* CWD Input Group with Folder Browse Button */
.cwd-input-group {
    display: flex;
    gap: 8px;
    align-items: center;
}

.cwd-input-group input[type="text"] {
    flex: 1;
}

.btn-icon.folder-browse-btn {
    padding: 8px;
    background: var(--color-border-light);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    cursor: pointer;
    color: var(--color-text-secondary);
    transition: all 0.15s ease;
    display: flex;
    align-items: center;
    justify-content: center;
}

.btn-icon.folder-browse-btn:hover {
    background: var(--color-primary);
    border-color: var(--color-primary);
    color: white;
}

[data-theme="dark"] .btn-icon.folder-browse-btn {
    background: var(--color-border);
    border-color: var(--color-border);
}

[data-theme="dark"] .btn-icon.folder-browse-btn:hover {
    background: var(--color-primary);
    border-color: var(--color-primary);
}

/* Folder Browser Modal - higher z-index to appear above other modals */
#folder-browser-modal {
    z-index: 2100;  /* Higher than default settings (1000) and project settings (2000) */
}

.folder-browser {
    width: 600px;
    max-width: 95vw;
    max-height: 80vh;
    display: flex;
    flex-direction: column;
}

.folder-browser-path {
    padding: 12px 16px;
    background: var(--color-border-light);
    border-bottom: 1px solid var(--color-border);
    font-family: monospace;
    font-size: 13px;
    word-break: break-all;
}

.folder-browser-list {
    flex: 1;
    overflow-y: auto;
    padding: 8px 0;
    min-height: 300px;
    max-height: 400px;
}

.folder-browser-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 16px;
    cursor: pointer;
    transition: background 0.1s ease;
}

.folder-browser-item:hover {
    background: var(--color-border-light);
}

.folder-browser-item.parent {
    color: var(--color-primary);
    font-weight: 500;
}

.folder-browser-item .folder-icon {
    font-size: 18px;
}

.folder-browser-item .folder-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

[data-theme="dark"] .folder-browser-path {
    background: var(--color-border);
}

[data-theme="dark"] .folder-browser-item:hover {
    background: var(--color-border);
}

```

---

## HTML Templates

### `templates/index.html`

**Purpose:** Main HTML template - the single-page application structure

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Claude Chat</title>
    <link rel="icon" type="image/png" href="/static/favicon.png">
    <link rel="stylesheet" href="/static/css/main.css?v=4">
    <!-- Highlight.js for code syntax highlighting -->
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css" id="hljs-light">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css" id="hljs-dark" disabled>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
    <!-- Marked.js for markdown rendering -->
    <script src="https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.0/marked.min.js"></script>
</head>
<body>
    <div class="app-container">
        <!-- Header -->
        <header class="header">
            <div class="header-left">
                <h1 class="logo">Claude Chat</h1>
            </div>
            <div class="header-right">
                <button id="workspace-files-toggle" class="icon-btn" title="Workspace Files" style="display: none;">
                    📁
                </button>
                <button id="help-chat-btn" class="icon-btn" title="Create Help Chat - Learn how to use this app">
                    ❓
                </button>
                <button id="copy-conversation-btn" class="icon-btn" title="Copy entire conversation">
                    📋
                </button>
                <button id="theme-toggle" class="icon-btn" title="Toggle theme">
                    <span class="theme-icon-light">&#9728;</span>
                    <span class="theme-icon-dark">&#9790;</span>
                </button>
                <button id="default-settings-toggle" class="icon-btn" title="Default Settings">
                    &#9881;
                </button>
            </div>
        </header>

        <div class="main-container">
            <!-- Sidebar -->
            <aside class="sidebar" id="sidebar">
                <div class="sidebar-buttons">
                    <button id="new-chat-btn" class="new-chat-btn">
                        <span>+</span> New Chat
                    </button>
                    <button id="new-agent-chat-btn" class="new-chat-btn agent-btn" title="Create Agent Chat (Shift+click for settings)">
                        <img src="/static/favicon.png" alt="Agent" class="agent-icon"> Agent Chat
                    </button>
                    <button id="new-project-btn" class="new-chat-btn project-btn">
                        <span>+</span> New Project
                    </button>
                </div>
                <div class="search-container">
                    <input
                        type="text"
                        id="search-input"
                        class="search-input"
                        placeholder="Search chats..."
                    >
                    <button id="clear-search-btn" class="clear-search-btn" style="display: none;">&times;</button>
                </div>
                <div class="projects-section" id="projects-section">
                    <!-- Projects will be populated here -->
                </div>
                <div class="conversations-list" id="conversations-list">
                    <!-- Conversations will be populated here -->
                </div>
                <div class="sidebar-resize-handle" id="sidebar-resize-handle"></div>
            </aside>

            <!-- Chat Area -->
            <main class="chat-area">
                <div class="messages-container" id="messages-container">
                    <div class="welcome-message" id="welcome-message">
                        <h2>Welcome to Claude Chat</h2>
                        <p>Start a conversation by typing a message below.</p>
                    </div>
                    <!-- Messages will be populated here -->
                </div>

                <!-- Input Area with Stats -->
                <div class="input-area-wrapper">
                    <!-- Input Area -->
                    <div class="input-area">
                        <div class="file-previews" id="file-previews">
                            <!-- File previews will appear here -->
                        </div>
                        <div class="input-container">
                            <div class="input-wrapper">
                                <button class="file-upload-btn" id="server-file-btn" title="Browse server files">
                                    &#128206;
                                </button>
                                <button class="file-upload-btn" id="prompts-btn" title="Insert prompt from library">
                                    📝
                                </button>
                                <textarea
                                    id="message-input"
                                    placeholder="Type your message..."
                                    rows="1"
                                    autofocus
                                ></textarea>
                                <button id="send-btn" class="send-btn" disabled>
                                    Send
                                </button>
                                <button id="stop-btn" class="stop-btn" style="display: none;" title="Stop generating">
                                    Stop
                                </button>
                            </div>
                        </div>
                    </div>

                    <!-- Status Bar -->
                    <div class="status-bar" id="context-stats">
                        <span class="status-item">
                            <span class="status-label">Messages:</span>
                            <span class="status-value" id="stat-messages">0</span>
                        </span>
                        <span class="status-item">
                            <span class="status-label">Context:</span>
                            <span class="status-value" id="stat-context">0 / 200K</span>
                        </span>
                        <span class="status-item" id="stat-pruned-container" style="display: none;">
                            <span class="status-label">Pruned:</span>
                            <span class="status-value status-warning" id="stat-pruned">0</span>
                        </span>
                    </div>
                </div>
            </main>

            <!-- Settings Panel -->
            <aside class="settings-panel" id="settings-panel">
                <div class="settings-header">
                    <h3>Conversation Settings</h3>
                    <button id="close-settings" class="icon-btn">&times;</button>
                </div>

                <div class="settings-content">
                    <!-- Mode indicator -->
                    <div class="setting-group settings-mode-indicator" id="settings-mode-indicator">
                        <span class="mode-badge normal-mode">Normal Chat</span>
                        <span class="mode-badge agent-mode">Agent Chat</span>
                    </div>

                    <!-- Model Selection (both modes) -->
                    <div class="setting-group">
                        <label for="model-select">Model</label>
                        <select id="model-select">
                            <!-- Models will be populated here -->
                        </select>
                        <span class="setting-description" id="model-description"></span>
                    </div>

                    <!-- System Prompt (both modes) -->
                    <div class="setting-group">
                        <label for="system-prompt">System Prompt</label>
                        <textarea id="system-prompt" rows="4" placeholder="Optional system prompt..."></textarea>
                    </div>

                    <!-- Normal chat only settings -->
                    <div class="normal-chat-settings">
                        <!-- Extended Thinking -->
                        <div class="setting-group" id="thinking-group">
                            <label class="toggle-label">
                                <span>Extended Thinking</span>
                                <input type="checkbox" id="thinking-toggle" checked>
                                <span class="toggle-slider"></span>
                            </label>
                            <div class="thinking-budget-container visible" id="thinking-budget-container">
                                <label for="thinking-budget">Budget: <span id="thinking-budget-value">10000</span> tokens</label>
                                <input type="range" id="thinking-budget" min="1024" max="50000" value="10000" step="1024">
                            </div>
                        </div>

                        <!-- Temperature (hidden when thinking enabled) -->
                        <div class="setting-group hidden" id="temperature-group">
                            <label for="temperature">Temperature: <span id="temperature-value">1.0</span></label>
                            <input type="range" id="temperature" min="0" max="1" value="1" step="0.1">
                        </div>

                        <!-- Max Tokens -->
                        <div class="setting-group" id="max-tokens-group">
                            <label for="max-tokens">Max Tokens: <span id="max-tokens-value">64000</span></label>
                            <input type="range" id="max-tokens" min="1" max="64000" value="64000" step="1000">
                        </div>

                        <!-- Top P (hidden when thinking enabled) -->
                        <div class="setting-group hidden" id="top-p-group">
                            <label for="top-p">Top P: <span id="top-p-value">1.0</span></label>
                            <input type="range" id="top-p" min="0" max="1" value="1" step="0.05">
                        </div>

                        <!-- Top K (hidden when thinking enabled) -->
                        <div class="setting-group hidden" id="top-k-group">
                            <label for="top-k">Top K: <span id="top-k-value">0</span> (0 = disabled)</label>
                            <input type="range" id="top-k" min="0" max="500" value="0" step="10">
                        </div>

                        <!-- Context Pruning -->
                        <div class="setting-group" id="prune-threshold-group">
                            <label for="prune-threshold">Context Pruning: <span id="prune-threshold-value">70</span>%</label>
                            <input type="range" id="prune-threshold" min="50" max="95" value="70" step="5">
                            <span class="setting-description">Automatically remove oldest messages to keep context under this threshold</span>
                        </div>

                        <!-- Web Search -->
                        <div class="setting-group" id="web-search-group">
                            <label class="toggle-label">
                                <span>Web Search</span>
                                <input type="checkbox" id="web-search-toggle">
                                <span class="toggle-slider"></span>
                            </label>
                            <div class="web-search-config" id="web-search-config">
                                <label for="web-search-max-uses">Max Uses: <span id="web-search-max-uses-value">5</span></label>
                                <input type="range" id="web-search-max-uses" min="1" max="20" value="5" step="1">
                            </div>
                            <span class="setting-description">Allow Claude to search the web for current information</span>
                        </div>

                        <!-- Prompt Library -->
                        <div class="setting-group" id="prompt-library-group">
                            <div class="prompt-library-header">
                                <label>Prompt Library</label>
                                <button class="btn-small" id="add-prompt-btn">+ Add Prompt</button>
                            </div>
                            <div id="prompt-library-list" class="prompt-library-list">
                                <!-- Prompts will be listed here -->
                            </div>
                        </div>
                    </div>

                    <!-- Agent chat only settings -->
                    <div class="agent-chat-settings">
                        <div class="setting-group">
                            <span class="setting-description agent-info">
                                Agent mode uses the Claude Code SDK with automatic tool access.
                            </span>
                        </div>

                        <div class="setting-group">
                            <label>Working Directory (CWD)</label>
                            <div class="agent-cwd-display" id="agent-cwd-display">
                                <span class="cwd-path">Default workspace</span>
                            </div>
                        </div>

                        <div class="setting-group">
                            <label>Available Tools</label>
                            <div class="tool-badges" id="agent-tools-display">
                                <!-- Filled dynamically when loading agent conversation -->
                            </div>
                            <span class="setting-description">Tools are configured in Project Settings or Default Settings</span>
                        </div>

                    </div>
                </div>
            </aside>

            <!-- Workspace Files Panel -->
            <aside class="workspace-panel" id="workspace-panel">
                <div class="workspace-header">
                    <h3>Workspace Files</h3>
                    <button id="close-workspace" class="icon-btn">&times;</button>
                </div>

                <div class="workspace-content">
                    <div class="workspace-path" id="workspace-path">
                        <!-- Workspace path will be shown here -->
                    </div>
                    <div class="workspace-files-list" id="workspace-files-list">
                        <!-- Files will be listed here -->
                    </div>
                </div>
            </aside>
        </div>
    </div>

    <!-- Server File Browser Modal -->
    <div class="modal-overlay" id="file-browser-modal">
        <div class="modal-content file-browser">
            <div class="modal-header">
                <h3>Browse Server Files</h3>
                <button class="icon-btn" id="close-file-browser">&times;</button>
            </div>
            <div class="file-browser-path" id="file-browser-path">
                <!-- Current path will be shown here -->
            </div>
            <div class="file-browser-list" id="file-browser-list">
                <!-- File list will be populated here -->
            </div>
            <div class="modal-footer">
                <span id="selected-files-count">0 files selected</span>
                <button class="btn btn-primary" id="add-selected-files" disabled>Add Selected</button>
            </div>
        </div>
    </div>

    <!-- Folder Browser Modal -->
    <div class="modal-overlay" id="folder-browser-modal">
        <div class="modal-content folder-browser">
            <div class="modal-header">
                <h3>Select Folder</h3>
                <button class="icon-btn" id="close-folder-browser">&times;</button>
            </div>
            <div class="folder-browser-path" id="folder-browser-path">
                <!-- Current path will be shown here -->
            </div>
            <div class="folder-browser-list" id="folder-browser-list">
                <!-- Folder list will be populated here -->
            </div>
            <div class="modal-footer">
                <button class="btn" id="cancel-folder-browser">Cancel</button>
                <button class="btn btn-primary" id="select-folder">Select This Folder</button>
            </div>
        </div>
    </div>

    <!-- Prompt Library Modal -->
    <div class="modal-overlay" id="prompt-library-modal">
        <div class="modal-content prompt-library-modal">
            <div class="modal-header">
                <h3>Prompt Library</h3>
                <button class="icon-btn" id="close-prompt-library">&times;</button>
            </div>
            <div class="prompt-library-modal-list" id="prompt-library-modal-list">
                <!-- Prompts will be listed here -->
            </div>
        </div>
    </div>

    <!-- Add/Edit Prompt Modal -->
    <div class="modal-overlay" id="edit-prompt-modal">
        <div class="modal-content edit-prompt-modal">
            <div class="modal-header">
                <h3 id="edit-prompt-title">Add Prompt</h3>
                <button class="icon-btn" id="close-edit-prompt">&times;</button>
            </div>
            <div class="edit-prompt-form">
                <div class="form-group">
                    <label for="prompt-name">Prompt Name</label>
                    <input type="text" id="prompt-name" placeholder="e.g., Summarize Academic Paper">
                </div>
                <div class="form-group">
                    <label for="prompt-content">Prompt Content</label>
                    <textarea id="prompt-content" rows="10" placeholder="Enter your prompt template..."></textarea>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn" id="cancel-edit-prompt">Cancel</button>
                <button class="btn btn-primary" id="save-prompt">Save</button>
            </div>
        </div>
    </div>

    <!-- Default Settings Modal -->
    <div class="modal-overlay" id="default-settings-modal">
        <div class="modal-content default-settings-modal">
            <div class="modal-header">
                <h3>Default Settings</h3>
                <button class="icon-btn" id="close-default-settings">&times;</button>
            </div>
            <div class="default-settings-content">
                <div class="default-settings-tabs">
                    <button class="tab-btn active" data-tab="normal">Normal Chat</button>
                    <button class="tab-btn" data-tab="agent">Agent Chat</button>
                </div>

                <!-- Normal Chat Defaults -->
                <div class="default-settings-tab-content" id="default-tab-normal">
                    <div class="setting-group">
                        <label for="default-normal-model">Default Model</label>
                        <select id="default-normal-model">
                            <!-- Models will be populated here -->
                        </select>
                    </div>

                    <div class="setting-group">
                        <label for="default-normal-system-prompt">Default System Prompt</label>
                        <textarea id="default-normal-system-prompt" rows="4" placeholder="Optional default system prompt..."></textarea>
                    </div>

                    <!-- Prompt Library in Default Settings -->
                    <div class="setting-group" id="default-prompt-library-group">
                        <div class="prompt-library-header">
                            <label>Prompt Library</label>
                            <button class="btn-small" id="default-add-prompt-btn">+ Add Prompt</button>
                        </div>
                        <div id="default-prompt-library-list" class="prompt-library-list">
                            <!-- Prompts will be listed here -->
                        </div>
                    </div>

                    <div class="setting-group">
                        <label class="toggle-label">
                            <span>Extended Thinking</span>
                            <input type="checkbox" id="default-normal-thinking-toggle" checked>
                            <span class="toggle-slider"></span>
                        </label>
                        <div class="thinking-budget-container visible" id="default-normal-thinking-budget-container">
                            <label for="default-normal-thinking-budget">Budget: <span id="default-normal-thinking-budget-value">10000</span> tokens</label>
                            <input type="range" id="default-normal-thinking-budget" min="1024" max="50000" value="10000" step="1024">
                        </div>
                    </div>

                    <div class="setting-group">
                        <label for="default-normal-max-tokens">Max Tokens: <span id="default-normal-max-tokens-value">64000</span></label>
                        <input type="range" id="default-normal-max-tokens" min="1" max="64000" value="64000" step="1000">
                    </div>

                    <div class="setting-group" id="default-normal-temperature-group">
                        <label for="default-normal-temperature">Temperature: <span id="default-normal-temperature-value">1.0</span></label>
                        <input type="range" id="default-normal-temperature" min="0" max="1" value="1" step="0.1">
                    </div>

                    <div class="setting-group" id="default-normal-top-p-group">
                        <label for="default-normal-top-p">Top P: <span id="default-normal-top-p-value">1.0</span></label>
                        <input type="range" id="default-normal-top-p" min="0" max="1" value="1" step="0.05">
                    </div>

                    <div class="setting-group" id="default-normal-top-k-group">
                        <label for="default-normal-top-k">Top K: <span id="default-normal-top-k-value">0</span> (0 = disabled)</label>
                        <input type="range" id="default-normal-top-k" min="0" max="500" value="0" step="10">
                    </div>

                    <div class="setting-group">
                        <label for="default-normal-prune-threshold">Context Pruning: <span id="default-normal-prune-threshold-value">70</span>%</label>
                        <input type="range" id="default-normal-prune-threshold" min="50" max="95" value="70" step="5">
                        <span class="setting-description">Automatically remove oldest messages to keep context under this threshold</span>
                    </div>

                    <div class="setting-group">
                        <label class="toggle-label">
                            <span>Web Search</span>
                            <input type="checkbox" id="default-normal-web-search-toggle">
                            <span class="toggle-slider"></span>
                        </label>
                        <div class="web-search-config" id="default-normal-web-search-config">
                            <label for="default-normal-web-search-max-uses">Max Uses: <span id="default-normal-web-search-max-uses-value">5</span></label>
                            <input type="range" id="default-normal-web-search-max-uses" min="1" max="20" value="5" step="1">
                        </div>
                        <span class="setting-description">Allow Claude to search the web for current information</span>
                    </div>
                </div>

                <!-- Agent Chat Defaults -->
                <div class="default-settings-tab-content" id="default-tab-agent" style="display: none;">
                    <div class="setting-group">
                        <label for="default-agent-model">Default Model</label>
                        <select id="default-agent-model">
                            <!-- Models will be populated here -->
                        </select>
                    </div>

                    <div class="setting-group">
                        <label for="default-agent-system-prompt">Default System Prompt</label>
                        <textarea id="default-agent-system-prompt" rows="4" placeholder="Optional default system prompt for agent chats..."></textarea>
                    </div>

                    <div class="setting-group">
                        <label for="default-agent-cwd">Working Directory (CWD)</label>
                        <div class="cwd-input-group">
                            <input type="text" id="default-agent-cwd" placeholder="Leave empty for default workspace">
                            <button type="button" class="btn-icon folder-browse-btn" data-target="default-agent-cwd" title="Browse folders">
                                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                                </svg>
                            </button>
                        </div>
                        <span class="setting-description">Custom directory where the agent will operate. Leave empty to use the default workspace.</span>
                    </div>

                    <div class="setting-group">
                        <label for="default-agent-thinking-budget">Thinking Budget: <span id="default-agent-thinking-budget-value">32000</span></label>
                        <input type="range" id="default-agent-thinking-budget" min="1024" max="32000" step="1024" value="32000">
                        <span class="setting-description">Token budget for agent's internal reasoning (extended thinking). Higher values allow deeper analysis.</span>
                    </div>

                    <div class="setting-group">
                        <label>Available Tools</label>
                        <div class="tool-toggles" id="default-agent-tools">
                            <label class="tool-toggle"><input type="checkbox" name="Read" checked> Read</label>
                            <label class="tool-toggle"><input type="checkbox" name="Write" checked> Write</label>
                            <label class="tool-toggle"><input type="checkbox" name="Edit" checked> Edit</label>
                            <label class="tool-toggle"><input type="checkbox" name="Bash" checked> Bash</label>
                            <label class="tool-toggle"><input type="checkbox" name="Glob" checked> Glob</label>
                            <label class="tool-toggle"><input type="checkbox" name="Grep" checked> Grep</label>
                            <label class="tool-toggle"><input type="checkbox" name="WebSearch" checked> WebSearch</label>
                            <label class="tool-toggle"><input type="checkbox" name="WebFetch" checked> WebFetch</label>
                            <label class="tool-toggle"><input type="checkbox" name="Task" checked> Task</label>
                            <label class="tool-toggle"><input type="checkbox" name="GIF" checked> GIF</label>
                            <label class="tool-toggle"><input type="checkbox" name="Memory" checked> Memory</label>
                        </div>
                        <span class="setting-description">Toggle tools on/off to control what the agent can use.</span>
                    </div>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn" id="cancel-default-settings">Cancel</button>
                <button class="btn btn-primary" id="save-default-settings">Save Defaults</button>
            </div>
        </div>
    </div>

    <!-- Quick Agent Settings Modal (Shift+Click on Agent Chat button) -->
    <div class="modal-overlay" id="quick-agent-modal">
        <div class="modal-content quick-agent-settings">
            <div class="modal-header">
                <h3>Agent Chat Settings</h3>
                <button class="icon-btn" id="close-quick-agent">&times;</button>
            </div>
            <div class="quick-agent-content">
                <div class="setting-group">
                    <label for="quick-agent-model">Model</label>
                    <select id="quick-agent-model">
                        <!-- Models will be populated here -->
                    </select>
                </div>

                <div class="setting-group">
                    <label for="quick-agent-system-prompt">System Prompt</label>
                    <textarea id="quick-agent-system-prompt" rows="3" placeholder="Optional system prompt for the agent..."></textarea>
                </div>

                <div class="setting-group">
                    <label for="quick-agent-cwd">Working Directory (CWD)</label>
                    <div class="cwd-input-group">
                        <input type="text" id="quick-agent-cwd" placeholder="Leave empty for default workspace">
                        <button type="button" class="btn-icon folder-browse-btn" data-target="quick-agent-cwd" title="Browse folders">
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                            </svg>
                        </button>
                    </div>
                    <span class="setting-description">Custom directory where the agent will operate.</span>
                </div>

                <div class="setting-group">
                    <label>Available Tools</label>
                    <div class="tool-toggles" id="quick-agent-tools">
                        <label class="tool-toggle"><input type="checkbox" name="Read" checked> Read</label>
                        <label class="tool-toggle"><input type="checkbox" name="Write" checked> Write</label>
                        <label class="tool-toggle"><input type="checkbox" name="Edit" checked> Edit</label>
                        <label class="tool-toggle"><input type="checkbox" name="Bash" checked> Bash</label>
                        <label class="tool-toggle"><input type="checkbox" name="Glob" checked> Glob</label>
                        <label class="tool-toggle"><input type="checkbox" name="Grep" checked> Grep</label>
                        <label class="tool-toggle"><input type="checkbox" name="WebSearch" checked> WebSearch</label>
                        <label class="tool-toggle"><input type="checkbox" name="WebFetch" checked> WebFetch</label>
                        <label class="tool-toggle"><input type="checkbox" name="Task" checked> Task</label>
                        <label class="tool-toggle"><input type="checkbox" name="GIF" checked> GIF</label>
                        <label class="tool-toggle"><input type="checkbox" name="Memory" checked> Memory</label>
                    </div>
                    <span class="setting-description">Toggle tools on/off to control what the agent can use.</span>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn" id="cancel-quick-agent">Cancel</button>
                <button class="btn btn-primary" id="create-quick-agent">Create Chat</button>
            </div>
        </div>
    </div>

    <!-- Loading Overlay -->
    <div class="loading-overlay" id="loading-overlay">
        <div class="loading-spinner"></div>
    </div>

    <!-- Scripts -->
    <script src="/static/js/background-streams.js"></script>
    <script src="/static/js/projects.js"></script>
    <script src="/static/js/project-settings.js"></script>
    <script src="/static/js/folder-browser.js"></script>
    <script src="/static/js/quick-agent-settings.js"></script>
    <script src="/static/js/conversations.js"></script>
    <script src="/static/js/files.js"></script>
    <script src="/static/js/settings.js"></script>
    <script src="/static/js/default-settings.js"></script>
    <script src="/static/js/prompts.js"></script>
    <script src="/static/js/workspace.js"></script>
    <script src="/static/js/chat.js?v=7"></script>
    <script src="/static/js/app.js"></script>
</body>
</html>

```

---

"""Agent chat streaming endpoints using Claude Agent SDK."""

import json
import os
from typing import Optional, List, Any
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

        # Get workspace path, session_id, and memory path for this conversation
        workspace_path = None
        existing_session_id = None
        memory_path = None
        msg_record = None
        enabled_tools = None
        custom_cwd = None
        project_id = None

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
                enabled_tools=enabled_tools  # Pass enabled tools from settings
            ):
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

            # Add any remaining text
            if current_text:
                accumulated_content.append({
                    "type": "text",
                    "text": current_text
                })

            # Final DB save
            if conversation_id and msg_record:
                # Prepare final content
                final_content = accumulated_content if len(accumulated_content) > 1 or any(
                    c.get("type") == "tool_use" for c in accumulated_content
                ) else (accumulated_content[0].get("text", "") if accumulated_content else "")

                await store.update_message_content(
                    conversation_id=conversation_id,
                    message_id=msg_record["id"],
                    content=final_content,
                    tool_results=tool_results if tool_results else None,
                    branch=branch
                )

        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'content': str(e)})}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        }
    )


@router.get("/status")
async def get_agent_status():
    """Check if Agent SDK is available."""
    error = get_sdk_import_error()
    return {
        "sdk_available": is_sdk_available(),
        "message": "Claude Code SDK is ready" if is_sdk_available() else "Claude Code SDK not installed",
        "error": error
    }


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


class CompactRequest(BaseModel):
    """Request to compact agent conversation context."""
    conversation_id: str
    instructions: Optional[str] = None  # Optional preservation instructions


@router.post("/compact")
async def compact_conversation(request: CompactRequest):
    """
    Compact the agent conversation context by summarizing history.
    This helps manage the context window for long-running conversations.
    """
    async def event_generator():
        conversation_id = request.conversation_id

        # Get existing session_id and workspace for resumption
        existing_session_id = None
        workspace_path = None
        try:
            conv = await store.get_conversation(conversation_id)
            if conv:
                existing_session_id = conv.get("session_id")
                # Get workspace path
                workspace_path = store.get_workspace_path(conversation_id)
                os.makedirs(workspace_path, exist_ok=True)

                # Check for custom CWD in settings
                conv_settings = conv.get("settings", {})
                custom_cwd = conv_settings.get("agent_cwd")
                if custom_cwd and os.path.isdir(custom_cwd):
                    workspace_path = custom_cwd
        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'content': f'Failed to load conversation: {str(e)}'})}\n\n"
            return

        if not existing_session_id:
            yield f"data: {json.dumps({'type': 'error', 'content': 'No session to compact. Send a message first to create a session.'})}\n\n"
            return

        # Build compact command with optional instructions
        compact_prompt = "/compact"
        if request.instructions:
            compact_prompt = f"/compact {request.instructions}"

        try:
            from claude_code_sdk import query, ClaudeCodeOptions

            options = ClaudeCodeOptions(
                cwd=workspace_path or os.getcwd(),
                resume=existing_session_id,
                permission_mode="acceptEdits",
            )

            print(f"[COMPACT] Sending compact command with session_id={existing_session_id}, cwd={workspace_path}")

            # Send compact command
            async for message in query(prompt=compact_prompt, options=options):
                msg_type = type(message).__name__

                if msg_type == 'SystemMessage':
                    subtype = getattr(message, 'subtype', '')
                    if subtype == 'init':
                        # Capture new session_id after compact
                        sid = getattr(message, 'session_id', None)
                        if not sid and hasattr(message, 'data'):
                            sid = message.data.get('session_id')
                        if sid:
                            # Update stored session_id
                            await store.update_conversation_session_id(
                                conversation_id=conversation_id,
                                session_id=sid
                            )
                            yield f"data: {json.dumps({'type': 'session_id', 'session_id': sid})}\n\n"

                elif msg_type == 'AssistantMessage':
                    if hasattr(message, 'content') and message.content:
                        for block in message.content:
                            if type(block).__name__ == 'TextBlock':
                                text = getattr(block, 'text', '')
                                if text:
                                    yield f"data: {json.dumps({'type': 'text', 'content': text})}\n\n"

                elif msg_type == 'ResultMessage':
                    subtype = getattr(message, 'subtype', '')
                    if subtype == 'success':
                        # Save compaction marker to conversation
                        try:
                            from datetime import datetime
                            await store.add_message(
                                conversation_id=conversation_id,
                                role="system",
                                content={"type": "compaction", "compacted_at": datetime.utcnow().isoformat()},
                                branch=None  # Use current branch
                            )
                            print(f"[COMPACT] Saved compaction marker for conversation {conversation_id}")
                        except Exception as e:
                            print(f"[COMPACT] Failed to save compaction marker: {e}")
                        yield f"data: {json.dumps({'type': 'compact_complete'})}\n\n"

            yield f"data: {json.dumps({'type': 'done'})}\n\n"

        except Exception as e:
            error_msg = str(e)
            print(f"[COMPACT] Error: {error_msg}")
            # Provide more helpful error messages
            if "exit code 1" in error_msg.lower() or "command failed" in error_msg.lower():
                error_msg = "Compact failed. The session may have expired or the context is already minimal. Try sending a new message first."
            yield f"data: {json.dumps({'type': 'error', 'content': error_msg})}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        }
    )


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

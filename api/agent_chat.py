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

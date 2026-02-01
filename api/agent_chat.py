"""Agent chat streaming endpoints using Claude Agent SDK."""

import asyncio
import json
import os
from typing import Optional, List, Any, Dict
from fastapi import APIRouter, HTTPException, UploadFile, File
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from services.agent_client import get_agent_client, is_sdk_available, get_sdk_import_error
from services.settings_service import get_settings_service
from services.streaming_service import get_streaming_service, StreamType
from services.mock_streams import is_mock_mode, mock_agent_chat_stream
from api.deps import get_store, get_project_store

router = APIRouter(prefix="/api/agent-chat", tags=["agent-chat"])

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
        # Get dependencies
        store = get_store()
        project_store = get_project_store()
        agent_client = get_agent_client()
        streaming_service = get_streaming_service()

        conversation_id = request.conversation_id
        branch = request.branch or [0]

        # Register stream and get stop event
        stop_event = None
        if conversation_id:
            stop_event = streaming_service.start_stream(conversation_id, StreamType.AGENT)

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

            # Resolve settings with unified service
            # Priority: defaults < project < conversation
            try:
                settings_service = get_settings_service()
                conv_settings = conv.get("settings", {}) if conv else {}
                agent_settings = settings_service.resolve_agent_settings(
                    project_id=project_id,
                    conversation_settings=conv_settings
                )

                enabled_tools = agent_settings.get("tools")
                thinking_budget = agent_settings.get("thinking_budget")
                custom_cwd = agent_settings.get("cwd")

                print(f"[AGENT] Resolved settings - tools: {enabled_tools}, thinking_budget: {thinking_budget}, cwd: {custom_cwd}")

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
        # All blocks (thinking, text, tool_use, tool_result) go into this array in order
        accumulated_content = []
        current_text = ""
        current_thinking = ""
        in_thinking = False
        new_session_id = None

        stopped = False
        try:
            # Build system prompt with memory instructions if memory is available
            system_prompt = request.system_prompt or ""
            if memory_path:
                system_prompt = MEMORY_SYSTEM_PROMPT + "\n\n" + system_prompt

            # Get the user's latest message for multi-turn sessions
            user_message = ""
            if request.messages:
                last_msg = request.messages[-1]
                if isinstance(last_msg.get("content"), str):
                    user_message = last_msg["content"]
                elif isinstance(last_msg.get("content"), list):
                    text_blocks = [
                        b.get("text", "") for b in last_msg["content"]
                        if b.get("type") == "text"
                    ]
                    user_message = "\n".join(text_blocks)

            # Use mock stream if MOCK_LLM=1
            if is_mock_mode():
                event_stream = mock_agent_chat_stream(
                    conversation_id=conversation_id,
                    stop_event=stop_event,
                    include_tool_use=True,
                    include_surface=True
                )

                # Process mock events
                async for event in event_stream:
                    if stop_event and stop_event.is_set():
                        stopped = True
                        yield f"data: {json.dumps({'type': 'stopped', 'content': 'Stream stopped by user'})}\n\n"
                        break

                    yield f"data: {json.dumps(event)}\n\n"

                    # Accumulate content for mock mode
                    if event["type"] == "text":
                        current_text += event.get("content", "")
                    elif event["type"] == "tool_use":
                        if current_text:
                            accumulated_content.append({"type": "text", "text": current_text})
                            current_text = ""
                        accumulated_content.append({
                            "type": "tool_use",
                            "id": event["id"],
                            "name": event["name"],
                            "input": event["input"]
                        })
                    elif event["type"] == "tool_result":
                        accumulated_content.append({
                            "type": "tool_result",
                            "tool_use_id": event["tool_use_id"],
                            "content": event.get("content", ""),
                            "is_error": event.get("is_error", False)
                        })

            else:
                # Use ClaudeSDKClient for agent streaming
                # Build options for the SDK client
                options = agent_client.build_options(
                    workspace_path=workspace_path or os.getcwd(),
                    system_prompt=system_prompt if system_prompt.strip() else None,
                    model=request.model,
                    session_id=existing_session_id,
                    memory_path=memory_path,
                    enabled_tools=enabled_tools,
                    thinking_budget=thinking_budget,
                    conversation_id=conversation_id
                )

                # Stream using ClaudeSDKClient
                event_stream = agent_client.stream_with_options(
                    options=options,
                    prompt=user_message
                )

                async for event in event_stream:
                    # Check if stop was requested
                    if stop_event and stop_event.is_set():
                        stopped = True
                        yield f"data: {json.dumps({'type': 'stopped', 'content': 'Stream stopped by user'})}\n\n"
                        break

                    # Send event to client
                    yield f"data: {json.dumps(event)}\n\n"

                    # Capture session_id from init message
                    if event["type"] == "session_id":
                        new_session_id = event["session_id"]
                        if new_session_id:
                            try:
                                await store.update_conversation_session_id(
                                    conversation_id=conversation_id,
                                    session_id=new_session_id
                                )
                            except Exception as e:
                                print(f"Failed to save session_id: {e}")

                    # Accumulate content for DB save
                    elif event["type"] == "thinking":
                        if not in_thinking:
                            if current_text:
                                accumulated_content.append({"type": "text", "text": current_text})
                                current_text = ""
                            in_thinking = True
                        current_thinking += event.get("content", "")
                    elif event["type"] == "text":
                        if in_thinking:
                            if current_thinking:
                                accumulated_content.append({"type": "thinking", "content": current_thinking})
                                current_thinking = ""
                            in_thinking = False
                        current_text += event.get("content", "")
                    elif event["type"] == "tool_use":
                        if in_thinking:
                            if current_thinking:
                                accumulated_content.append({"type": "thinking", "content": current_thinking})
                                current_thinking = ""
                            in_thinking = False
                        if current_text:
                            accumulated_content.append({"type": "text", "text": current_text})
                            current_text = ""
                        accumulated_content.append({
                            "type": "tool_use",
                            "id": event["id"],
                            "name": event["name"],
                            "input": event["input"]
                        })
                    elif event["type"] == "tool_result":
                        accumulated_content.append({
                            "type": "tool_result",
                            "tool_use_id": event["tool_use_id"],
                            "content": event.get("content", ""),
                            "is_error": event.get("is_error", False)
                        })
                    elif event["type"] == "surface_content":
                        if in_thinking:
                            if current_thinking:
                                accumulated_content.append({"type": "thinking", "content": current_thinking})
                                current_thinking = ""
                            in_thinking = False
                        if current_text:
                            accumulated_content.append({"type": "text", "text": current_text})
                            current_text = ""

                        content_id = event.get("content_id", "")
                        content_type = event.get("content_type", "html")
                        content = event.get("content", "")
                        title = event.get("title")

                        # Save surface content to file if we have a conversation
                        if conversation_id:
                            save_path = store.get_workspace_path(conversation_id)
                            ext = ".html" if content_type == "html" else ".md"
                            filename = f"surface_{content_id}{ext}"
                            filepath = os.path.join(save_path, filename)

                            try:
                                os.makedirs(save_path, exist_ok=True)
                                with open(filepath, 'w', encoding='utf-8') as f:
                                    f.write(content)
                                print(f"Saved surface content to: {filepath}")
                                accumulated_content.append({
                                    "type": "surface_content",
                                    "content_id": content_id,
                                    "content_type": content_type,
                                    "title": title,
                                    "filename": filename
                                })
                            except Exception as e:
                                print(f"Failed to save surface content to {filepath}: {e}")
                                accumulated_content.append({
                                    "type": "surface_content",
                                    "content_id": content_id,
                                    "content_type": content_type,
                                    "title": title,
                                    "content": content
                                })
                        else:
                            # No conversation - store inline
                            accumulated_content.append({
                                "type": "surface_content",
                                "content_id": content_id,
                                "content_type": content_type,
                                "title": title,
                                "content": content
                            })

            # Finalize any remaining thinking block
            if in_thinking and current_thinking:
                accumulated_content.append({"type": "thinking", "content": current_thinking})
            # Add any remaining text
            if current_text:
                accumulated_content.append({"type": "text", "text": current_text})

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
                has_special_blocks = any(
                    c.get("type") in ("tool_use", "tool_result", "surface_content", "thinking")
                    for c in accumulated_content
                )
                final_content = accumulated_content if len(accumulated_content) > 1 or has_special_blocks \
                    else (accumulated_content[0].get("text", "") if accumulated_content else "")

                await store.update_message_content(
                    conversation_id=conversation_id,
                    message_id=msg_record["id"],
                    content=final_content,
                    thinking=None,
                    tool_results=None,
                    branch=branch
                )

        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'content': str(e)})}\n\n"
        finally:
            # Clean up stream tracking
            if conversation_id:
                streaming_service.end_stream(conversation_id)

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
    streaming_service = get_streaming_service()
    if streaming_service.stop_stream(conversation_id):
        return {"success": True, "message": "Stop signal sent"}
    return {"success": False, "message": "No active stream found or stream not stoppable"}


@router.get("/streaming/{conversation_id}")
async def get_streaming_status(conversation_id: str):
    """Check if a conversation has an active stream.

    NOTE: This endpoint is kept for backwards compatibility but the unified
    endpoint at /api/chat/streaming/{id} should be preferred.
    """
    streaming_service = get_streaming_service()
    return streaming_service.get_status(conversation_id)


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
    store = get_store()
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
    store = get_store()
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
    store = get_store()
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
    store = get_store()
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
    project_store = get_project_store()
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
    project_store = get_project_store()
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

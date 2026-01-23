"""Agent chat streaming endpoints using Claude Agent SDK."""

import json
import os
from typing import Optional, List, Any
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from services.agent_client import get_agent_client, is_sdk_available, get_sdk_import_error
from services.file_conversation_store import FileConversationStore

router = APIRouter(prefix="/api/agent-chat", tags=["agent-chat"])

# Initialize store
store = FileConversationStore()


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

        # Get workspace path and session_id for this conversation
        workspace_path = None
        existing_session_id = None
        msg_record = None

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
            async for event in agent_client.stream_agent_response(
                messages=request.messages,
                workspace_path=workspace_path or os.getcwd(),
                system_prompt=request.system_prompt,
                model=request.model,
                session_id=existing_session_id  # Pass session_id for resumption
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

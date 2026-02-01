"""Chat streaming endpoint using Server-Sent Events."""

import json
import asyncio
from typing import List, Dict, Any, Optional
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from api.deps import get_store, get_anthropic_client
from services.streaming_service import get_streaming_service, StreamType
from services.mock_streams import is_mock_mode, mock_normal_chat_stream
from config import DEFAULT_MODEL, DEFAULT_TEMPERATURE, DEFAULT_MAX_TOKENS, DEFAULT_THINKING_BUDGET

router = APIRouter(prefix="/api/chat", tags=["chat"])


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
        # Get dependencies
        store = get_store()
        client = get_anthropic_client()

        message_id = None
        conversation_id = request.conversation_id
        branch = request.branch or [0]

        # Track content blocks in order (thinking, text, web_search interleaved)
        content_blocks = []
        current_text = ""
        current_thinking = ""
        in_thinking = False

        # Track web search events
        current_web_search = None

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
        streaming_service = get_streaming_service()
        if conversation_id:
            streaming_service.start_stream(conversation_id, StreamType.NORMAL)
            try:
                print(f"[STREAM] Creating message for conversation {conversation_id}")
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
            # Use mock stream if MOCK_LLM=1
            if is_mock_mode():
                event_stream = mock_normal_chat_stream(
                    conversation_id=conversation_id,
                    thinking_enabled=request.thinking_enabled,
                    web_search_enabled=request.web_search_enabled
                )
            else:
                event_stream = client.stream_message(
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
                )

            async for event in event_stream:
                yield f"data: {json.dumps(event)}\n\n"

                # Accumulate content blocks in order
                if event.get("type") == "thinking":
                    # Start thinking phase - finalize any pending text first
                    if not in_thinking:
                        if current_text:
                            content_blocks.append({"type": "text", "text": current_text})
                            current_text = ""
                        in_thinking = True
                    current_thinking += event.get("content", "")
                elif event.get("type") == "text":
                    # End thinking phase if active
                    if in_thinking:
                        if current_thinking:
                            content_blocks.append({"type": "thinking", "content": current_thinking})
                            current_thinking = ""
                        in_thinking = False
                    current_text += event.get("content", "")
                elif event.get("type") == "web_search_start":
                    # Finalize any pending content
                    if in_thinking and current_thinking:
                        content_blocks.append({"type": "thinking", "content": current_thinking})
                        current_thinking = ""
                        in_thinking = False
                    if current_text:
                        content_blocks.append({"type": "text", "text": current_text})
                        current_text = ""
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
                    # Web search completed - add to content blocks
                    search_id = event.get("tool_use_id")
                    if current_web_search and current_web_search["id"] == search_id:
                        current_web_search["results"] = event.get("results", [])
                        content_blocks.append({"type": "web_search", **current_web_search})
                        current_web_search = None
                    elif current_web_search:
                        # ID mismatch - save with the event's ID
                        current_web_search["id"] = search_id
                        current_web_search["results"] = event.get("results", [])
                        content_blocks.append({"type": "web_search", **current_web_search})
                        current_web_search = None

                # Update DB periodically (every 10 chunks) to avoid too many writes
                update_counter += 1
                if message_id and update_counter % 10 == 0:
                    # Build current content for progress update
                    progress_content = list(content_blocks)
                    if in_thinking and current_thinking:
                        progress_content.append({"type": "thinking", "content": current_thinking})
                    if current_text:
                        progress_content.append({"type": "text", "text": current_text})
                    # Use simple text if no thinking
                    if len(progress_content) == 1 and progress_content[0].get("type") == "text":
                        progress_content = progress_content[0]["text"]
                    print(f"[STREAM] Updating message {message_id}")
                    await store.update_message_content(
                        conversation_id=conversation_id,
                        message_id=message_id,
                        content=progress_content if progress_content else "",
                        branch=branch,
                        streaming=True
                    )

            # Finalize any remaining content
            if in_thinking and current_thinking:
                content_blocks.append({"type": "thinking", "content": current_thinking})
            if current_text:
                content_blocks.append({"type": "text", "text": current_text})

            # Final update to DB with complete content
            if message_id:
                # Build final content
                if len(content_blocks) == 0:
                    final_content = ""
                elif len(content_blocks) == 1 and content_blocks[0].get("type") == "text":
                    # Just text, save as string for backward compatibility
                    final_content = content_blocks[0]["text"]
                else:
                    # Multiple blocks or has thinking - save as array
                    final_content = content_blocks

                print(f"[STREAM] Final update for message {message_id}: {len(content_blocks)} blocks, streaming=False")
                await store.update_message_content(
                    conversation_id=conversation_id,
                    message_id=message_id,
                    content=final_content,
                    branch=branch,
                    streaming=False
                )

        finally:
            if conversation_id:
                streaming_service.end_stream(conversation_id)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        }
    )


@router.get("/streaming/all")
async def get_all_streaming_conversations():
    """Get status of all currently streaming conversations."""
    streaming_service = get_streaming_service()
    return streaming_service.get_all_streaming()


@router.get("/streaming/{conversation_id}")
async def is_conversation_streaming(conversation_id: str):
    """Check if a conversation is currently streaming.

    Returns unified status for both normal and agent streams.
    """
    streaming_service = get_streaming_service()
    return streaming_service.get_status(conversation_id)


@router.get("/models")
async def get_models():
    """Get available models and their configurations."""
    client = get_anthropic_client()
    return {"models": client.get_available_models()}

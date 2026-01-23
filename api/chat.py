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
            ):
                yield f"data: {json.dumps(event)}\n\n"

                # Accumulate content
                if event.get("type") == "thinking":
                    thinking_content += event.get("content", "")
                elif event.get("type") == "text":
                    text_content += event.get("content", "")

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
                print(f"[STREAM] Final update for message {message_id}: {len(text_content)} chars, streaming=False")
                await store.update_message_content(
                    conversation_id=conversation_id,
                    message_id=message_id,
                    content=text_content,
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

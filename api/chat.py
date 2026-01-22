"""Chat streaming endpoint using Server-Sent Events."""

import json
from typing import List, Dict, Any, Optional
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from services.anthropic_client import AnthropicClient
from config import DEFAULT_MODEL, DEFAULT_TEMPERATURE, DEFAULT_MAX_TOKENS, DEFAULT_THINKING_BUDGET

router = APIRouter(prefix="/api/chat", tags=["chat"])

# Initialize client
client = AnthropicClient()


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
    """

    async def event_generator():
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

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        }
    )


@router.get("/models")
async def get_models():
    """Get available models and their configurations."""
    return {"models": client.get_available_models()}

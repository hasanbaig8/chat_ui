"""Conversation management endpoints."""

from typing import Optional, List, Any
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from services.conversation_store import ConversationStore

router = APIRouter(prefix="/api/conversations", tags=["conversations"])

# Initialize store
store = ConversationStore()


class CreateConversationRequest(BaseModel):
    """Request to create a new conversation."""
    title: str = "New Conversation"
    model: Optional[str] = None
    system_prompt: Optional[str] = None


class UpdateConversationRequest(BaseModel):
    """Request to update a conversation."""
    title: Optional[str] = None
    model: Optional[str] = None
    system_prompt: Optional[str] = None


class AddMessageRequest(BaseModel):
    """Request to add a message to a conversation."""
    role: str
    content: Any
    thinking: Optional[str] = None


class EditMessageRequest(BaseModel):
    """Request to edit a message."""
    position: int
    content: Any


class SwitchVersionRequest(BaseModel):
    """Request to switch message version."""
    position: int
    version: int


class RetryMessageRequest(BaseModel):
    """Request to retry an assistant message (create new version)."""
    position: int
    content: Any
    thinking: Optional[str] = None


@router.on_event("startup")
async def startup():
    """Initialize database on startup."""
    await store.initialize()


@router.post("")
async def create_conversation(request: CreateConversationRequest):
    """Create a new conversation."""
    conversation = await store.create_conversation(
        title=request.title,
        model=request.model,
        system_prompt=request.system_prompt
    )
    return conversation


@router.get("")
async def list_conversations():
    """List all conversations."""
    conversations = await store.list_conversations()
    return {"conversations": conversations}


@router.get("/{conversation_id}")
async def get_conversation(conversation_id: str):
    """Get a specific conversation with all messages."""
    conversation = await store.get_conversation(conversation_id)
    if not conversation:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return conversation


@router.put("/{conversation_id}")
async def update_conversation(conversation_id: str, request: UpdateConversationRequest):
    """Update conversation metadata."""
    success = await store.update_conversation(
        conversation_id=conversation_id,
        title=request.title,
        model=request.model,
        system_prompt=request.system_prompt
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
    """Add a message to a conversation."""
    # Verify conversation exists
    conversation = await store.get_conversation(conversation_id)
    if not conversation:
        raise HTTPException(status_code=404, detail="Conversation not found")

    message = await store.add_message(
        conversation_id=conversation_id,
        role=request.role,
        content=request.content,
        thinking=request.thinking
    )
    return message


@router.get("/{conversation_id}/messages")
async def get_messages(conversation_id: str):
    """Get all messages for a conversation."""
    # Verify conversation exists
    conversation = await store.get_conversation(conversation_id)
    if not conversation:
        raise HTTPException(status_code=404, detail="Conversation not found")

    messages = await store.get_messages(conversation_id)
    return {"messages": messages}


@router.post("/{conversation_id}/edit")
async def edit_message(conversation_id: str, request: EditMessageRequest):
    """Edit a message at a position, creating a new version."""
    conversation = await store.get_conversation(conversation_id)
    if not conversation:
        raise HTTPException(status_code=404, detail="Conversation not found")

    message = await store.edit_message(
        conversation_id=conversation_id,
        position=request.position,
        new_content=request.content
    )
    return message


@router.post("/{conversation_id}/switch-version")
async def switch_version(conversation_id: str, request: SwitchVersionRequest):
    """Switch to a different version at a position."""
    success = await store.switch_version(
        conversation_id=conversation_id,
        position=request.position,
        version=request.version
    )
    if not success:
        raise HTTPException(status_code=404, detail="Version not found")
    return {"success": True}


@router.post("/{conversation_id}/retry")
async def retry_message(conversation_id: str, request: RetryMessageRequest):
    """Retry an assistant message, creating a new version at the position."""
    conversation = await store.get_conversation(conversation_id)
    if not conversation:
        raise HTTPException(status_code=404, detail="Conversation not found")

    message = await store.retry_message(
        conversation_id=conversation_id,
        position=request.position,
        new_content=request.content,
        thinking=request.thinking
    )
    return message


@router.get("/{conversation_id}/messages-up-to/{position}")
async def get_messages_up_to(conversation_id: str, position: int):
    """Get active messages up to (not including) a position. Used for retries."""
    conversation = await store.get_conversation(conversation_id)
    if not conversation:
        raise HTTPException(status_code=404, detail="Conversation not found")

    messages = await store.get_messages_up_to(conversation_id, position)
    return {"messages": messages}


@router.get("/{conversation_id}/position/{position}/versions")
async def get_position_versions(conversation_id: str, position: int):
    """Get version info for a specific position."""
    conversation = await store.get_conversation(conversation_id)
    if not conversation:
        raise HTTPException(status_code=404, detail="Conversation not found")

    version_info = await store.get_position_version_info(conversation_id, position)
    return version_info

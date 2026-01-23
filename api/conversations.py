"""Conversation management endpoints."""

from typing import Optional, List, Any
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from services.conversation_store import ConversationStore
from services.file_conversation_store import FileConversationStore

router = APIRouter(prefix="/api/conversations", tags=["conversations"])

# Initialize both stores
sqlite_store = ConversationStore()
file_store = FileConversationStore()

async def get_store_for_conversation(conversation_id: str):
    """Get the appropriate store for an existing conversation by checking both stores."""
    # Try SQLite store first
    conv = await sqlite_store.get_conversation(conversation_id)
    if conv:
        return sqlite_store

    # Try file store
    conv = await file_store.get_conversation(conversation_id)
    if conv:
        return file_store

    # Default to SQLite if not found in either
    return sqlite_store


class CreateConversationRequest(BaseModel):
    """Request to create a new conversation."""
    title: str = "New Conversation"
    model: Optional[str] = None
    system_prompt: Optional[str] = None
    is_agent: bool = False


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
    """Initialize both storage backends on startup."""
    await sqlite_store.initialize()
    await file_store.initialize()


@router.post("")
async def create_conversation(request: CreateConversationRequest):
    """Create a new conversation."""
    # Use file store for agent conversations, SQLite for regular
    store = file_store if request.is_agent else sqlite_store

    conversation = await store.create_conversation(
        title=request.title,
        model=request.model,
        system_prompt=request.system_prompt,
        is_agent=request.is_agent
    )
    return conversation


@router.get("")
async def list_conversations():
    """List all conversations from both stores."""
    sqlite_conversations = await sqlite_store.list_conversations()
    file_conversations = await file_store.list_conversations()
    # Combine and sort by updated_at
    all_conversations = sqlite_conversations + file_conversations
    all_conversations.sort(key=lambda x: x.get("updated_at", ""), reverse=True)
    return {"conversations": all_conversations}


@router.get("/search")
async def search_conversations(q: str = Query(..., min_length=1)):
    """Search conversations by title or message content (partial match)."""
    sqlite_conversations = await sqlite_store.search_conversations(q)
    file_conversations = await file_store.search_conversations(q)
    # Combine and sort by updated_at
    all_conversations = sqlite_conversations + file_conversations
    all_conversations.sort(key=lambda x: x.get("updated_at", ""), reverse=True)
    return {"conversations": all_conversations, "query": q}


@router.post("/{conversation_id}/duplicate")
async def duplicate_conversation(conversation_id: str):
    """Duplicate a conversation with all its branches."""
    store = await get_store_for_conversation(conversation_id)
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

    store = await get_store_for_conversation(conversation_id)
    conversation = await store.get_conversation(conversation_id, branch_array)
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
    # Get the correct store for this conversation
    store = await get_store_for_conversation(conversation_id)

    success = await store.delete_messages_from(
        conversation_id=conversation_id,
        position=position,
        branch=request.branch
    )
    if not success:
        raise HTTPException(status_code=404, detail="Conversation or position not found")
    return {"success": True, "deleted_from": position}

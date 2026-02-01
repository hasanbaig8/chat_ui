"""API routes for project management."""

from typing import Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from api.deps import get_project_store

router = APIRouter(prefix="/api/projects", tags=["projects"])


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
    store = get_project_store()
    projects = await store.list_projects()
    return {"projects": projects}


@router.get("/conversation-map")
async def get_conversation_project_map():
    """Get mapping of conversation_id -> project_id."""
    store = get_project_store()
    conv_map = await store.get_conversation_project_map()
    return {"map": conv_map}


@router.get("/{project_id}")
async def get_project(project_id: str):
    """Get a single project by ID."""
    store = get_project_store()
    project = await store.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


@router.post("")
async def create_project(request: CreateProjectRequest):
    """Create a new project."""
    store = get_project_store()
    project = await store.create_project(
        name=request.name,
        color=request.color,
        settings=request.settings
    )
    return project


@router.put("/{project_id}")
async def update_project(project_id: str, request: UpdateProjectRequest):
    """Update a project's metadata."""
    store = get_project_store()
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
    store = get_project_store()
    success = await store.delete_project(project_id)
    if not success:
        raise HTTPException(status_code=404, detail="Project not found")
    return {"success": True}


@router.post("/{project_id}/conversations")
async def add_conversation_to_project(project_id: str, request: AddConversationRequest):
    """Add a conversation to a project."""
    store = get_project_store()
    success = await store.add_conversation(project_id, request.conversation_id)
    if not success:
        raise HTTPException(status_code=404, detail="Project not found")
    return {"success": True}


@router.delete("/{project_id}/conversations/{conversation_id}")
async def remove_conversation_from_project(project_id: str, conversation_id: str):
    """Remove a conversation from a project."""
    store = get_project_store()
    success = await store.remove_conversation(project_id, conversation_id)
    if not success:
        raise HTTPException(status_code=404, detail="Project or conversation not found")
    return {"success": True}


@router.get("/{project_id}/memory")
async def get_project_memory(project_id: str):
    """Get memory files for a project."""
    import os
    store = get_project_store()

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

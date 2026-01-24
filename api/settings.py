"""Default and project settings management endpoints."""

import json
from pathlib import Path
from typing import Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/api/settings", tags=["settings"])

# Path to settings files
DEFAULT_SETTINGS_PATH = Path("data/default_settings.json")
PROJECT_SETTINGS_PATH = Path("data/project_settings.json")


class DefaultSettings(BaseModel):
    """Default settings for new conversations."""
    # Normal chat defaults
    normal_model: Optional[str] = "claude-opus-4-5-20251101"
    normal_system_prompt: Optional[str] = None
    normal_thinking_enabled: Optional[bool] = True
    normal_thinking_budget: Optional[int] = 60000
    normal_max_tokens: Optional[int] = 64000
    normal_temperature: Optional[float] = 1.0
    normal_top_p: Optional[float] = 1.0
    normal_top_k: Optional[int] = 0
    normal_prune_threshold: Optional[float] = 0.7

    # Agent chat defaults
    agent_model: Optional[str] = "claude-opus-4-5-20251101"
    agent_system_prompt: Optional[str] = None


def load_default_settings() -> dict:
    """Load default settings from file."""
    if DEFAULT_SETTINGS_PATH.exists():
        try:
            with open(DEFAULT_SETTINGS_PATH, 'r') as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError):
            pass

    # Return defaults if file doesn't exist or is invalid
    return DefaultSettings().model_dump()


def save_default_settings(settings: dict) -> bool:
    """Save default settings to file."""
    try:
        # Ensure data directory exists
        DEFAULT_SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)

        with open(DEFAULT_SETTINGS_PATH, 'w') as f:
            json.dump(settings, f, indent=2)
        return True
    except IOError:
        return False


@router.get("/defaults")
async def get_defaults():
    """Get default settings for new conversations."""
    return load_default_settings()


@router.put("/defaults")
async def update_defaults(settings: DefaultSettings):
    """Update default settings."""
    # Merge with existing settings (only update provided values)
    current = load_default_settings()
    update_data = {k: v for k, v in settings.model_dump().items() if v is not None}
    current.update(update_data)

    if save_default_settings(current):
        return {"success": True, "settings": current}
    return {"success": False, "error": "Failed to save settings"}


# ==================== Project Settings ====================

def load_all_project_settings() -> dict:
    """Load all project settings from file."""
    if PROJECT_SETTINGS_PATH.exists():
        try:
            with open(PROJECT_SETTINGS_PATH, 'r') as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError):
            pass
    return {}


def save_all_project_settings(all_settings: dict) -> bool:
    """Save all project settings to file."""
    try:
        PROJECT_SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(PROJECT_SETTINGS_PATH, 'w') as f:
            json.dump(all_settings, f, indent=2)
        return True
    except IOError:
        return False


def get_project_settings(project_id: str) -> dict:
    """Get settings for a specific project."""
    all_settings = load_all_project_settings()
    return all_settings.get(project_id, {})


def save_project_settings(project_id: str, settings: dict) -> bool:
    """Save settings for a specific project."""
    all_settings = load_all_project_settings()
    all_settings[project_id] = settings
    return save_all_project_settings(all_settings)


class ProjectSettings(BaseModel):
    """Settings for a project."""
    # Normal chat defaults
    normal_model: Optional[str] = None
    normal_system_prompt: Optional[str] = None
    normal_thinking_enabled: Optional[bool] = None
    normal_thinking_budget: Optional[int] = None
    normal_max_tokens: Optional[int] = None
    normal_temperature: Optional[float] = None
    normal_top_p: Optional[float] = None
    normal_top_k: Optional[int] = None
    normal_prune_threshold: Optional[float] = None

    # Agent chat defaults
    agent_model: Optional[str] = None
    agent_system_prompt: Optional[str] = None


@router.get("/project/{project_id}")
async def get_project_settings_endpoint(project_id: str):
    """Get settings for a project."""
    settings = get_project_settings(project_id)
    return {"project_id": project_id, "settings": settings}


@router.put("/project/{project_id}")
async def update_project_settings(project_id: str, settings: ProjectSettings):
    """Update settings for a project."""
    # Get existing settings and merge
    current = get_project_settings(project_id)
    update_data = {k: v for k, v in settings.model_dump().items() if v is not None}
    current.update(update_data)

    if save_project_settings(project_id, current):
        return {"success": True, "project_id": project_id, "settings": current}
    raise HTTPException(status_code=500, detail="Failed to save project settings")


@router.post("/project/{project_id}/init")
async def init_project_settings(project_id: str):
    """Initialize project settings from current default settings."""
    # Copy current defaults to the project
    defaults = load_default_settings()

    if save_project_settings(project_id, defaults):
        return {"success": True, "project_id": project_id, "settings": defaults}
    raise HTTPException(status_code=500, detail="Failed to initialize project settings")


@router.delete("/project/{project_id}")
async def delete_project_settings(project_id: str):
    """Delete settings for a project."""
    all_settings = load_all_project_settings()
    if project_id in all_settings:
        del all_settings[project_id]
        save_all_project_settings(all_settings)
    return {"success": True}

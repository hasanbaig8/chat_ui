"""Default settings management endpoints."""

import json
from pathlib import Path
from typing import Optional
from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(prefix="/api/settings", tags=["settings"])

# Path to default settings file
DEFAULT_SETTINGS_PATH = Path("data/default_settings.json")


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

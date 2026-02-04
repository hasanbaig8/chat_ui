"""Default and project settings management endpoints."""

import json
from pathlib import Path
from typing import Optional, List
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/api/settings", tags=["settings"])

# Path to settings files
DEFAULT_SETTINGS_PATH = Path("data/default_settings.json")
PROJECT_SETTINGS_PATH = Path("data/project_settings.json")


class Skill(BaseModel):
    """A skill definition with name, description, and prompt."""
    id: str  # Unique identifier
    name: str  # Display name
    description: Optional[str] = None  # Brief description
    prompt: str  # The actual skill prompt/instructions


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
    normal_web_search_enabled: Optional[bool] = False
    normal_web_search_max_uses: Optional[int] = 5

    # Agent chat defaults
    agent_model: Optional[str] = "claude-opus-4-5-20251101"
    agent_system_prompt: Optional[str] = None
    agent_tools: Optional[dict] = None  # e.g., {"Read": True, "Write": True, ...}
    agent_cwd: Optional[str] = None  # Custom working directory for agent
    agent_thinking_budget: Optional[int] = 32000  # Thinking budget for agent extended thinking

    # Skills - available across projects
    skills: Optional[List[dict]] = None  # List of skill definitions


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
    normal_web_search_enabled: Optional[bool] = None
    normal_web_search_max_uses: Optional[int] = None

    # Agent chat defaults
    agent_model: Optional[str] = None
    agent_system_prompt: Optional[str] = None
    agent_tools: Optional[dict] = None  # e.g., {"Read": True, "Write": True, ...}
    agent_cwd: Optional[str] = None  # Custom working directory for agent

    # Enabled skills for this project (list of skill IDs)
    enabled_skills: Optional[List[str]] = None


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


# ==================== Skills Helper Functions ====================

@router.get("/skills")
async def get_all_skills():
    """Get all defined skills."""
    defaults = load_default_settings()
    return {"skills": defaults.get("skills", [])}


@router.post("/skills")
async def create_skill(skill: Skill):
    """Create a new skill."""
    defaults = load_default_settings()
    skills = defaults.get("skills", [])

    # Check for duplicate ID
    if any(s.get("id") == skill.id for s in skills):
        raise HTTPException(status_code=400, detail=f"Skill with ID '{skill.id}' already exists")

    skills.append(skill.model_dump())
    defaults["skills"] = skills

    if save_default_settings(defaults):
        return {"success": True, "skill": skill.model_dump()}
    raise HTTPException(status_code=500, detail="Failed to save skill")


@router.put("/skills/{skill_id}")
async def update_skill(skill_id: str, skill: Skill):
    """Update an existing skill."""
    defaults = load_default_settings()
    skills = defaults.get("skills", [])

    # Find and update the skill
    for i, s in enumerate(skills):
        if s.get("id") == skill_id:
            skills[i] = skill.model_dump()
            defaults["skills"] = skills
            if save_default_settings(defaults):
                return {"success": True, "skill": skill.model_dump()}
            raise HTTPException(status_code=500, detail="Failed to save skill")

    raise HTTPException(status_code=404, detail=f"Skill '{skill_id}' not found")


@router.delete("/skills/{skill_id}")
async def delete_skill(skill_id: str):
    """Delete a skill."""
    defaults = load_default_settings()
    skills = defaults.get("skills", [])

    original_count = len(skills)
    skills = [s for s in skills if s.get("id") != skill_id]

    if len(skills) == original_count:
        raise HTTPException(status_code=404, detail=f"Skill '{skill_id}' not found")

    defaults["skills"] = skills
    if save_default_settings(defaults):
        return {"success": True}
    raise HTTPException(status_code=500, detail="Failed to delete skill")


def get_enabled_skills_prompt(project_id: str) -> str:
    """Get the combined prompt from all enabled skills for a project.

    Args:
        project_id: The project ID

    Returns:
        Combined skill prompts as a string, or empty string if no skills enabled
    """
    # Get project settings
    project_settings = get_project_settings(project_id)
    enabled_skill_ids = project_settings.get('enabled_skills', [])

    if not enabled_skill_ids:
        return ""

    # Get default settings which contain the skill definitions
    defaults = load_default_settings()
    skills = defaults.get('skills', [])

    if not skills:
        return ""

    # Build combined prompt from enabled skills
    skill_prompts = []
    for skill in skills:
        if skill.get('id') in enabled_skill_ids:
            skill_name = skill.get('name', 'Unnamed Skill')
            skill_prompt = skill.get('prompt', '')
            if skill_prompt:
                skill_prompts.append(f"## Skill: {skill_name}\n\n{skill_prompt}")

    if not skill_prompts:
        return ""

    return "\n\n---\n\n".join(skill_prompts)

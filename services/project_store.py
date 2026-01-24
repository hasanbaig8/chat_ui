"""JSON file-based project storage for organizing conversations."""

import json
import uuid
from datetime import datetime
from pathlib import Path
from typing import List, Dict, Any, Optional

# Use absolute path to avoid issues when MCP servers run with different cwd
DATA_DIR = Path(__file__).parent.parent / "data"
PROJECTS_FILE = DATA_DIR / "projects.json"


class ProjectStore:
    """File-based storage for projects that organize conversations."""

    def __init__(self):
        DATA_DIR.mkdir(parents=True, exist_ok=True)

    async def initialize(self):
        """Initialize the projects file if it doesn't exist."""
        if not PROJECTS_FILE.exists():
            self._save_projects([])

    def _load_projects(self) -> List[Dict[str, Any]]:
        """Load projects from JSON file."""
        if not PROJECTS_FILE.exists():
            return []
        try:
            with open(PROJECTS_FILE, 'r') as f:
                data = json.load(f)
                return data.get('projects', [])
        except (json.JSONDecodeError, IOError):
            return []

    def _save_projects(self, projects: List[Dict[str, Any]]):
        """Save projects to JSON file."""
        with open(PROJECTS_FILE, 'w') as f:
            json.dump({'projects': projects}, f, indent=2)

    async def list_projects(self) -> List[Dict[str, Any]]:
        """List all projects."""
        return self._load_projects()

    async def get_project(self, project_id: str) -> Optional[Dict[str, Any]]:
        """Get a project by ID."""
        projects = self._load_projects()
        for project in projects:
            if project['id'] == project_id:
                return project
        return None

    async def create_project(
        self,
        name: str,
        color: str = "#C15F3C",
        settings: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """Create a new project."""
        projects = self._load_projects()
        now = datetime.utcnow().isoformat()

        project = {
            "id": str(uuid.uuid4()),
            "name": name,
            "color": color,
            "created_at": now,
            "updated_at": now,
            "conversation_ids": [],
            "settings": settings or {}
        }

        projects.insert(0, project)  # Add at the beginning
        self._save_projects(projects)
        return project

    async def update_project(
        self,
        project_id: str,
        name: Optional[str] = None,
        color: Optional[str] = None,
        settings: Optional[Dict[str, Any]] = None
    ) -> bool:
        """Update a project's metadata."""
        projects = self._load_projects()

        for project in projects:
            if project['id'] == project_id:
                if name is not None:
                    project['name'] = name
                if color is not None:
                    project['color'] = color
                if settings is not None:
                    project['settings'] = settings
                project['updated_at'] = datetime.utcnow().isoformat()
                self._save_projects(projects)
                return True

        return False

    async def delete_project(self, project_id: str) -> bool:
        """Delete a project. Conversations are kept but unassigned."""
        projects = self._load_projects()
        original_length = len(projects)
        projects = [p for p in projects if p['id'] != project_id]

        if len(projects) < original_length:
            self._save_projects(projects)
            return True
        return False

    async def add_conversation(self, project_id: str, conversation_id: str) -> bool:
        """Add a conversation to a project."""
        projects = self._load_projects()

        # First, remove the conversation from any other project
        for project in projects:
            if conversation_id in project['conversation_ids']:
                project['conversation_ids'].remove(conversation_id)
                project['updated_at'] = datetime.utcnow().isoformat()

        # Then add to the target project
        for project in projects:
            if project['id'] == project_id:
                if conversation_id not in project['conversation_ids']:
                    project['conversation_ids'].insert(0, conversation_id)  # Add at beginning
                    project['updated_at'] = datetime.utcnow().isoformat()
                self._save_projects(projects)
                return True

        return False

    async def remove_conversation(self, project_id: str, conversation_id: str) -> bool:
        """Remove a conversation from a project."""
        projects = self._load_projects()

        for project in projects:
            if project['id'] == project_id:
                if conversation_id in project['conversation_ids']:
                    project['conversation_ids'].remove(conversation_id)
                    project['updated_at'] = datetime.utcnow().isoformat()
                    self._save_projects(projects)
                    return True
                return False

        return False

    async def get_conversation_project_map(self) -> Dict[str, str]:
        """Get a mapping of conversation_id -> project_id."""
        projects = self._load_projects()
        conv_map = {}
        for project in projects:
            for conv_id in project['conversation_ids']:
                conv_map[conv_id] = project['id']
        return conv_map

    async def get_project_for_conversation(self, conversation_id: str) -> Optional[str]:
        """Get the project ID for a conversation, if any."""
        projects = self._load_projects()
        for project in projects:
            if conversation_id in project['conversation_ids']:
                return project['id']
        return None

    def get_project_memory_path(self, project_id: str) -> str:
        """Get the memory directory path for a project."""
        return str(DATA_DIR / "projects" / project_id / "memories")

    def get_conversation_memory_path(self, conversation_id: str) -> str:
        """Get the memory directory path for a standalone conversation (not in a project)."""
        return str(DATA_DIR / "conversations" / conversation_id / "memories")

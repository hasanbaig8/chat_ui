"""Dependency injection providers for the API layer.

This module provides a single source of truth for shared services like
the conversation store, project store, and anthropic client. All modules
should use these providers instead of creating their own instances.
"""

from services.file_conversation_store import FileConversationStore
from services.project_store import ProjectStore
from services.anthropic_client import AnthropicClient
from services.agent_session_manager import AgentSessionManager, get_session_manager as _get_session_manager

# Singleton instances
_store: FileConversationStore | None = None
_project_store: ProjectStore | None = None
_anthropic_client: AnthropicClient | None = None
_session_manager: AgentSessionManager | None = None
_initialized: bool = False


async def initialize_all():
    """Initialize all stores and services. Called once at app startup."""
    global _store, _project_store, _anthropic_client, _session_manager, _initialized

    if _initialized:
        return

    # Initialize conversation store
    _store = FileConversationStore()
    await _store.initialize()

    # Initialize project store
    _project_store = ProjectStore()
    await _project_store.initialize()

    # Initialize anthropic client
    _anthropic_client = AnthropicClient()

    # Initialize agent session manager (singleton)
    _session_manager = _get_session_manager()

    _initialized = True
    print("[DEPS] All services initialized")


def get_store() -> FileConversationStore:
    """Get the singleton FileConversationStore instance."""
    if not _initialized or _store is None:
        raise RuntimeError("Dependencies not initialized. Call initialize_all() first.")
    return _store


def get_project_store() -> ProjectStore:
    """Get the singleton ProjectStore instance."""
    if not _initialized or _project_store is None:
        raise RuntimeError("Dependencies not initialized. Call initialize_all() first.")
    return _project_store


def get_anthropic_client() -> AnthropicClient:
    """Get the singleton AnthropicClient instance."""
    if not _initialized or _anthropic_client is None:
        raise RuntimeError("Dependencies not initialized. Call initialize_all() first.")
    return _anthropic_client


def get_session_manager() -> AgentSessionManager:
    """Get the singleton AgentSessionManager instance."""
    if not _initialized or _session_manager is None:
        raise RuntimeError("Dependencies not initialized. Call initialize_all() first.")
    return _session_manager


def is_initialized() -> bool:
    """Check if dependencies have been initialized."""
    return _initialized

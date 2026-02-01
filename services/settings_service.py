"""Unified settings resolution service.

This service provides a single source of truth for resolving settings
across different levels: defaults -> project -> conversation.
"""

from typing import Dict, Any, Optional
from api.settings import load_default_settings, get_project_settings


class SettingsService:
    """Service for resolving settings with proper priority cascade."""

    # Settings keys that apply to agent mode
    AGENT_SETTINGS_KEYS = {
        "agent_model",
        "agent_system_prompt",
        "agent_tools",
        "agent_cwd",
        "agent_thinking_budget",
    }

    # Settings keys that apply to normal chat mode
    NORMAL_SETTINGS_KEYS = {
        "normal_model",
        "normal_system_prompt",
        "normal_thinking_enabled",
        "normal_thinking_budget",
        "normal_max_tokens",
        "normal_temperature",
        "normal_top_p",
        "normal_top_k",
        "normal_prune_threshold",
        "normal_web_search_enabled",
        "normal_web_search_max_uses",
    }

    def resolve_settings(
        self,
        project_id: Optional[str] = None,
        conversation_settings: Optional[Dict[str, Any]] = None,
        mode: str = "normal"
    ) -> Dict[str, Any]:
        """Resolve settings with priority: defaults < project < conversation.

        Args:
            project_id: Optional project ID to load project-level settings
            conversation_settings: Optional conversation-level settings override
            mode: "normal" or "agent" - determines which settings keys to use

        Returns:
            Resolved settings dictionary with all applicable settings
        """
        # Start with default settings
        resolved = load_default_settings()

        # Override with project settings if available
        if project_id:
            project_settings = get_project_settings(project_id)
            # Only update with non-None values
            resolved.update({k: v for k, v in project_settings.items() if v is not None})

        # Override with conversation settings if available
        if conversation_settings:
            resolved.update({k: v for k, v in conversation_settings.items() if v is not None})

        return resolved

    def resolve_agent_settings(
        self,
        project_id: Optional[str] = None,
        conversation_settings: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """Convenience method for resolving agent-specific settings.

        Returns a dictionary with agent-relevant keys:
        - model
        - system_prompt
        - tools (enabled tools dict)
        - cwd (working directory)
        - thinking_budget
        """
        full_settings = self.resolve_settings(project_id, conversation_settings, "agent")

        return {
            "model": full_settings.get("agent_model"),
            "system_prompt": full_settings.get("agent_system_prompt"),
            "tools": full_settings.get("agent_tools"),
            "cwd": full_settings.get("agent_cwd"),
            "thinking_budget": full_settings.get("agent_thinking_budget"),
        }

    def resolve_normal_settings(
        self,
        project_id: Optional[str] = None,
        conversation_settings: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """Convenience method for resolving normal chat settings.

        Returns a dictionary with normal chat-relevant keys:
        - model
        - system_prompt
        - thinking_enabled
        - thinking_budget
        - max_tokens
        - temperature
        - top_p
        - top_k
        - prune_threshold
        - web_search_enabled
        - web_search_max_uses
        """
        full_settings = self.resolve_settings(project_id, conversation_settings, "normal")

        return {
            "model": full_settings.get("normal_model"),
            "system_prompt": full_settings.get("normal_system_prompt"),
            "thinking_enabled": full_settings.get("normal_thinking_enabled"),
            "thinking_budget": full_settings.get("normal_thinking_budget"),
            "max_tokens": full_settings.get("normal_max_tokens"),
            "temperature": full_settings.get("normal_temperature"),
            "top_p": full_settings.get("normal_top_p"),
            "top_k": full_settings.get("normal_top_k"),
            "prune_threshold": full_settings.get("normal_prune_threshold"),
            "web_search_enabled": full_settings.get("normal_web_search_enabled"),
            "web_search_max_uses": full_settings.get("normal_web_search_max_uses"),
        }


# Singleton instance
_settings_service: Optional[SettingsService] = None


def get_settings_service() -> SettingsService:
    """Get the singleton SettingsService instance."""
    global _settings_service
    if _settings_service is None:
        _settings_service = SettingsService()
    return _settings_service

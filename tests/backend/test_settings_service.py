"""Tests for the settings service.

Note: Some tests are simplified to avoid circular import issues between
services.settings_service and api modules. The core logic is still tested
through mocking the dependency functions.
"""

import pytest
from unittest.mock import patch, MagicMock


# Use module-level mocking to avoid circular imports
@pytest.fixture(autouse=True)
def mock_api_settings():
    """Mock api.settings before importing settings_service."""
    mock_defaults = {
        "normal_model": "claude-sonnet-4",
        "normal_system_prompt": "Default system prompt",
        "normal_thinking_enabled": False,
        "normal_thinking_budget": 10000,
        "normal_max_tokens": 4096,
        "normal_temperature": 0.7,
        "normal_top_p": None,
        "normal_top_k": None,
        "normal_prune_threshold": 50,
        "normal_web_search_enabled": False,
        "normal_web_search_max_uses": 5,
        "agent_model": "claude-sonnet-4",
        "agent_system_prompt": "Agent default prompt",
        "agent_tools": {"Read": True, "Write": True},
        "agent_cwd": "/home/user",
        "agent_thinking_budget": 20000,
    }

    mock_module = MagicMock()
    mock_module.load_default_settings = MagicMock(return_value=mock_defaults)
    mock_module.get_project_settings = MagicMock(return_value={})

    with patch.dict("sys.modules", {"api.settings": mock_module}):
        yield mock_module


class TestSettingsService:
    """Test suite for SettingsService."""

    def test_resolve_with_defaults_only(self, mock_api_settings):
        """Should return defaults when no overrides provided."""
        from services.settings_service import SettingsService

        service = SettingsService()
        result = service.resolve_settings()

        assert result["normal_model"] == "claude-sonnet-4"
        assert result["normal_thinking_budget"] == 10000

    def test_resolve_with_project_override(self, mock_api_settings):
        """Project settings should override defaults."""
        mock_api_settings.get_project_settings.return_value = {
            "normal_model": "claude-opus-4",
            "normal_thinking_budget": 50000,
        }

        from services.settings_service import SettingsService

        service = SettingsService()
        result = service.resolve_settings(project_id="proj-1")

        assert result["normal_model"] == "claude-opus-4"
        assert result["normal_thinking_budget"] == 50000
        # Non-overridden values should be from defaults
        assert result["normal_temperature"] == 0.7

    def test_resolve_with_conversation_override(self, mock_api_settings):
        """Conversation settings should override all."""
        from services.settings_service import SettingsService

        service = SettingsService()
        conversation_settings = {
            "normal_model": "claude-haiku",
            "normal_temperature": 0.5,
        }

        result = service.resolve_settings(conversation_settings=conversation_settings)

        assert result["normal_model"] == "claude-haiku"
        assert result["normal_temperature"] == 0.5

    def test_resolve_priority_cascade(self, mock_api_settings):
        """Conversation > Project > Defaults."""
        mock_api_settings.get_project_settings.return_value = {
            "normal_model": "claude-opus-4",
            "normal_thinking_budget": 50000,
        }

        from services.settings_service import SettingsService

        service = SettingsService()
        conversation_settings = {
            "normal_model": "claude-haiku",  # Should win
        }

        result = service.resolve_settings(
            project_id="proj-1",
            conversation_settings=conversation_settings
        )

        assert result["normal_model"] == "claude-haiku"  # Conversation wins
        assert result["normal_thinking_budget"] == 50000  # Project
        assert result["normal_temperature"] == 0.7  # Default

    def test_none_values_not_applied(self, mock_api_settings):
        """None values should not override existing settings."""
        from services.settings_service import SettingsService

        service = SettingsService()
        conversation_settings = {
            "normal_model": None,  # Should not override
            "normal_temperature": 0.5,
        }

        result = service.resolve_settings(conversation_settings=conversation_settings)

        assert result["normal_model"] == "claude-sonnet-4"  # Default preserved
        assert result["normal_temperature"] == 0.5  # Conversation applied


class TestResolveAgentSettings:
    """Test suite for resolve_agent_settings method."""

    def test_returns_agent_keys(self, mock_api_settings):
        """Should return only agent-relevant keys."""
        from services.settings_service import SettingsService

        service = SettingsService()
        result = service.resolve_agent_settings()

        assert "model" in result
        assert "system_prompt" in result
        assert "tools" in result
        assert "cwd" in result
        assert "thinking_budget" in result
        # Should not have prefixed keys
        assert "agent_model" not in result

    def test_maps_keys_correctly(self, mock_api_settings):
        """Should map agent_* keys to unprefixed keys."""
        from services.settings_service import SettingsService

        service = SettingsService()
        result = service.resolve_agent_settings()

        assert result["model"] == "claude-sonnet-4"
        assert result["cwd"] == "/home/user"


class TestResolveNormalSettings:
    """Test suite for resolve_normal_settings method."""

    def test_returns_normal_keys(self, mock_api_settings):
        """Should return only normal-relevant keys."""
        from services.settings_service import SettingsService

        service = SettingsService()
        result = service.resolve_normal_settings()

        assert "model" in result
        assert "system_prompt" in result
        assert "thinking_enabled" in result
        assert "thinking_budget" in result
        assert "max_tokens" in result
        assert "temperature" in result
        assert "web_search_enabled" in result

    def test_maps_keys_correctly(self, mock_api_settings):
        """Should map normal_* keys to unprefixed keys."""
        from services.settings_service import SettingsService

        service = SettingsService()
        result = service.resolve_normal_settings()

        assert result["model"] == "claude-sonnet-4"
        assert result["temperature"] == 0.7
        assert result["thinking_enabled"] is False


class TestSingleton:
    """Test the singleton pattern."""

    def test_get_settings_service_returns_same_instance(self, mock_api_settings):
        """Should return the same instance."""
        import services.settings_service as mod

        # Reset the singleton
        mod._settings_service = None

        service1 = mod.get_settings_service()
        service2 = mod.get_settings_service()

        assert service1 is service2

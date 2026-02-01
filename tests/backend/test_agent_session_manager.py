"""Tests for the agent session manager."""

import asyncio
import time
import pytest
from services.agent_session_manager import (
    AgentSessionManager,
    get_session_manager,
    is_sdk_client_available,
)


class TestAgentSessionManager:
    """Tests for AgentSessionManager class."""

    def test_initial_state(self):
        """Test manager starts with no sessions."""
        manager = AgentSessionManager()
        assert manager.get_active_session_count() == 0

    def test_has_session_false_when_empty(self):
        """Test has_session returns False for non-existent session."""
        manager = AgentSessionManager()
        assert not manager.has_session("conv-123")

    def test_get_session_returns_none_when_empty(self):
        """Test get_session returns None for non-existent session."""
        manager = AgentSessionManager()
        assert manager.get_session("conv-123") is None

    def test_get_lock_creates_lock(self):
        """Test get_lock creates and returns a lock."""
        manager = AgentSessionManager()
        lock = manager.get_lock("conv-123")
        assert isinstance(lock, asyncio.Lock)

    def test_get_lock_returns_same_lock(self):
        """Test get_lock returns the same lock for same conversation."""
        manager = AgentSessionManager()
        lock1 = manager.get_lock("conv-123")
        lock2 = manager.get_lock("conv-123")
        assert lock1 is lock2

    def test_get_lock_different_locks_per_conversation(self):
        """Test get_lock returns different locks for different conversations."""
        manager = AgentSessionManager()
        lock1 = manager.get_lock("conv-123")
        lock2 = manager.get_lock("conv-456")
        assert lock1 is not lock2

    def test_remove_session_nonexistent(self):
        """Test remove_session handles non-existent session gracefully."""
        manager = AgentSessionManager()
        # Should not raise
        manager.remove_session("conv-123")

    def test_get_session_info_none_when_empty(self):
        """Test get_session_info returns None for non-existent session."""
        manager = AgentSessionManager()
        assert manager.get_session_info("conv-123") is None

    def test_cleanup_stale_sessions_empty(self):
        """Test cleanup_stale_sessions returns 0 when no sessions."""
        manager = AgentSessionManager()
        count = manager.cleanup_stale_sessions()
        assert count == 0


class TestSessionManagerSingleton:
    """Tests for singleton behavior."""

    def test_get_session_manager_returns_same_instance(self):
        """Test get_session_manager returns the same instance."""
        manager1 = get_session_manager()
        manager2 = get_session_manager()
        assert manager1 is manager2


class TestSDKAvailability:
    """Tests for SDK availability check."""

    def test_is_sdk_client_available_returns_bool(self):
        """Test is_sdk_client_available returns a boolean."""
        result = is_sdk_client_available()
        assert isinstance(result, bool)

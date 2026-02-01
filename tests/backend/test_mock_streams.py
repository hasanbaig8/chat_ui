"""Tests for mock streaming functionality."""

import pytest
import asyncio
import os
from services.mock_streams import (
    is_mock_mode,
    mock_normal_chat_stream,
    mock_agent_chat_stream,
    mock_error_stream,
)


class TestMockMode:
    """Test suite for mock mode detection."""

    def test_mock_mode_disabled_by_default(self, monkeypatch):
        """Mock mode should be disabled by default."""
        monkeypatch.delenv("MOCK_LLM", raising=False)
        assert is_mock_mode() is False

    def test_mock_mode_enabled_with_1(self, monkeypatch):
        """Mock mode should be enabled with MOCK_LLM=1."""
        monkeypatch.setenv("MOCK_LLM", "1")
        assert is_mock_mode() is True

    def test_mock_mode_enabled_with_true(self, monkeypatch):
        """Mock mode should be enabled with MOCK_LLM=true."""
        monkeypatch.setenv("MOCK_LLM", "true")
        assert is_mock_mode() is True

    def test_mock_mode_enabled_with_yes(self, monkeypatch):
        """Mock mode should be enabled with MOCK_LLM=yes."""
        monkeypatch.setenv("MOCK_LLM", "yes")
        assert is_mock_mode() is True

    def test_mock_mode_case_insensitive(self, monkeypatch):
        """Mock mode should be case insensitive."""
        monkeypatch.setenv("MOCK_LLM", "TRUE")
        assert is_mock_mode() is True

    def test_mock_mode_disabled_with_0(self, monkeypatch):
        """Mock mode should be disabled with MOCK_LLM=0."""
        monkeypatch.setenv("MOCK_LLM", "0")
        assert is_mock_mode() is False


class TestMockNormalChatStream:
    """Test suite for mock normal chat streaming."""

    @pytest.mark.asyncio
    async def test_emits_done_event(self):
        """Stream should end with a done event."""
        events = []
        async for event in mock_normal_chat_stream("test-id", delay_ms=1):
            events.append(event)

        assert events[-1]["type"] == "done"

    @pytest.mark.asyncio
    async def test_emits_text_events(self):
        """Stream should emit text events."""
        events = []
        async for event in mock_normal_chat_stream("test-id", delay_ms=1):
            events.append(event)

        text_events = [e for e in events if e.get("type") == "text"]
        assert len(text_events) > 0

    @pytest.mark.asyncio
    async def test_emits_thinking_when_enabled(self):
        """Stream should emit thinking events when enabled."""
        events = []
        async for event in mock_normal_chat_stream("test-id", thinking_enabled=True, delay_ms=1):
            events.append(event)

        thinking_events = [e for e in events if e.get("type") == "thinking"]
        assert len(thinking_events) > 0

    @pytest.mark.asyncio
    async def test_no_thinking_when_disabled(self):
        """Stream should not emit thinking events when disabled."""
        events = []
        async for event in mock_normal_chat_stream("test-id", thinking_enabled=False, delay_ms=1):
            events.append(event)

        thinking_events = [e for e in events if e.get("type") == "thinking"]
        assert len(thinking_events) == 0

    @pytest.mark.asyncio
    async def test_emits_web_search_when_enabled(self):
        """Stream should emit web search events when enabled."""
        events = []
        async for event in mock_normal_chat_stream("test-id", web_search_enabled=True, delay_ms=1):
            events.append(event)

        web_search_start = [e for e in events if e.get("type") == "web_search_start"]
        web_search_result = [e for e in events if e.get("type") == "web_search_result"]

        assert len(web_search_start) > 0
        assert len(web_search_result) > 0

    @pytest.mark.asyncio
    async def test_no_web_search_when_disabled(self):
        """Stream should not emit web search events when disabled."""
        events = []
        async for event in mock_normal_chat_stream("test-id", web_search_enabled=False, delay_ms=1):
            events.append(event)

        web_search_events = [e for e in events if "web_search" in e.get("type", "")]
        assert len(web_search_events) == 0


class TestMockAgentChatStream:
    """Test suite for mock agent chat streaming."""

    @pytest.mark.asyncio
    async def test_emits_session_id(self):
        """Stream should emit a session_id event."""
        events = []
        async for event in mock_agent_chat_stream("test-id", delay_ms=1):
            events.append(event)

        session_events = [e for e in events if e.get("type") == "session_id"]
        assert len(session_events) == 1

    @pytest.mark.asyncio
    async def test_emits_tool_use_when_enabled(self):
        """Stream should emit tool_use events when enabled."""
        events = []
        async for event in mock_agent_chat_stream("test-id", include_tool_use=True, delay_ms=1):
            events.append(event)

        tool_use_events = [e for e in events if e.get("type") == "tool_use"]
        assert len(tool_use_events) > 0

    @pytest.mark.asyncio
    async def test_emits_tool_result_when_enabled(self):
        """Stream should emit tool_result events when enabled."""
        events = []
        async for event in mock_agent_chat_stream("test-id", include_tool_use=True, delay_ms=1):
            events.append(event)

        tool_result_events = [e for e in events if e.get("type") == "tool_result"]
        assert len(tool_result_events) > 0

    @pytest.mark.asyncio
    async def test_emits_surface_content_when_enabled(self):
        """Stream should emit surface_content events when enabled."""
        events = []
        async for event in mock_agent_chat_stream("test-id", include_surface=True, delay_ms=1):
            events.append(event)

        surface_events = [e for e in events if e.get("type") == "surface_content"]
        assert len(surface_events) > 0

    @pytest.mark.asyncio
    async def test_stops_when_event_set(self):
        """Stream should stop when stop_event is set."""
        stop_event = asyncio.Event()
        events = []

        async def stop_after_few():
            await asyncio.sleep(0.1)
            stop_event.set()

        asyncio.create_task(stop_after_few())

        async for event in mock_agent_chat_stream("test-id", stop_event=stop_event, delay_ms=50):
            events.append(event)
            if event.get("type") == "stopped":
                break

        stopped_events = [e for e in events if e.get("type") == "stopped"]
        assert len(stopped_events) == 1


class TestMockErrorStream:
    """Test suite for mock error streaming."""

    @pytest.mark.asyncio
    async def test_emits_error_event(self):
        """Stream should emit an error event."""
        events = []
        async for event in mock_error_stream(delay_before_error_ms=1):
            events.append(event)

        error_events = [e for e in events if e.get("type") == "error"]
        assert len(error_events) == 1

    @pytest.mark.asyncio
    async def test_custom_error_message(self):
        """Stream should use custom error message."""
        events = []
        async for event in mock_error_stream(error_message="Custom error", delay_before_error_ms=1):
            events.append(event)

        error_event = [e for e in events if e.get("type") == "error"][0]
        assert error_event["content"] == "Custom error"

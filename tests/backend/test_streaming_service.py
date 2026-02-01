"""Tests for the unified streaming service."""

import pytest
import asyncio
from services.streaming_service import StreamingService, StreamType, StreamState


class TestStreamingService:
    """Test suite for StreamingService."""

    def test_start_normal_stream(self, streaming_service: StreamingService):
        """Normal streams should not have stop events."""
        stop_event = streaming_service.start_stream("conv-1", StreamType.NORMAL)

        # Normal streams return None for stop_event
        assert stop_event is None

        # Should be tracked as streaming
        status = streaming_service.get_status("conv-1")
        assert status["streaming"] is True
        assert status["type"] == "normal"
        assert status["stoppable"] is False

    def test_start_agent_stream(self, streaming_service: StreamingService):
        """Agent streams should have stop events."""
        stop_event = streaming_service.start_stream("conv-2", StreamType.AGENT)

        # Agent streams return an Event for stopping
        assert stop_event is not None
        assert isinstance(stop_event, asyncio.Event)

        # Should be tracked as streaming
        status = streaming_service.get_status("conv-2")
        assert status["streaming"] is True
        assert status["type"] == "agent"
        assert status["stoppable"] is True

    def test_end_stream(self, streaming_service: StreamingService):
        """Ending a stream should remove it from tracking."""
        streaming_service.start_stream("conv-3", StreamType.NORMAL)

        # Should be streaming
        assert streaming_service.get_status("conv-3")["streaming"] is True

        # End the stream
        streaming_service.end_stream("conv-3")

        # Should no longer be streaming
        assert streaming_service.get_status("conv-3")["streaming"] is False

    def test_stop_agent_stream(self, streaming_service: StreamingService):
        """Stopping an agent stream should set the stop event."""
        stop_event = streaming_service.start_stream("conv-4", StreamType.AGENT)

        # Stop event should not be set initially
        assert not stop_event.is_set()

        # Stop the stream
        result = streaming_service.stop_stream("conv-4")
        assert result is True

        # Stop event should now be set
        assert stop_event.is_set()

    def test_stop_normal_stream_fails(self, streaming_service: StreamingService):
        """Stopping a normal stream should fail gracefully."""
        streaming_service.start_stream("conv-5", StreamType.NORMAL)

        # Request stop on non-stoppable stream
        result = streaming_service.stop_stream("conv-5")

        # Should return False (not stopped)
        assert result is False

    def test_stop_nonexistent_stream(self, streaming_service: StreamingService):
        """Stopping a nonexistent stream should fail gracefully."""
        result = streaming_service.stop_stream("nonexistent")
        assert result is False

    def test_get_status_nonexistent(self, streaming_service: StreamingService):
        """Getting status of nonexistent conversation returns not streaming."""
        status = streaming_service.get_status("nonexistent")
        assert status["streaming"] is False
        assert status["type"] is None
        assert status["stoppable"] is False

    def test_multiple_conversations(self, streaming_service: StreamingService):
        """Multiple conversations can stream simultaneously."""
        streaming_service.start_stream("conv-a", StreamType.NORMAL)
        streaming_service.start_stream("conv-b", StreamType.AGENT)

        assert streaming_service.get_status("conv-a")["streaming"] is True
        assert streaming_service.get_status("conv-b")["streaming"] is True

        # End one
        streaming_service.end_stream("conv-a")

        assert streaming_service.get_status("conv-a")["streaming"] is False
        assert streaming_service.get_status("conv-b")["streaming"] is True

    def test_is_streaming(self, streaming_service: StreamingService):
        """is_streaming helper should work correctly."""
        assert streaming_service.is_streaming("conv-x") is False

        streaming_service.start_stream("conv-x", StreamType.NORMAL)
        assert streaming_service.is_streaming("conv-x") is True

        streaming_service.end_stream("conv-x")
        assert streaming_service.is_streaming("conv-x") is False

    def test_get_all_streaming(self, streaming_service: StreamingService):
        """Should return all currently streaming conversations."""
        streaming_service.start_stream("conv-1", StreamType.NORMAL)
        streaming_service.start_stream("conv-2", StreamType.AGENT)

        all_streaming = streaming_service.get_all_streaming()
        assert "conv-1" in all_streaming
        assert "conv-2" in all_streaming
        assert len(all_streaming) == 2

        streaming_service.end_stream("conv-1")
        all_streaming = streaming_service.get_all_streaming()
        assert "conv-1" not in all_streaming
        assert "conv-2" in all_streaming

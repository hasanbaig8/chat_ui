"""Unified streaming registry service.

This service provides a single source of truth for tracking all active
streams, whether they are normal chat or agent chat streams.
"""

import asyncio
from enum import Enum
from typing import Dict, Optional
from dataclasses import dataclass


class StreamType(Enum):
    """Type of stream - determines capabilities."""
    NORMAL = "normal"  # Regular chat - not stoppable
    AGENT = "agent"    # Agent chat - stoppable via Event


@dataclass
class StreamState:
    """State of an active stream."""
    stream_type: StreamType
    stop_event: Optional[asyncio.Event] = None  # Only for AGENT streams


class StreamingService:
    """Unified registry for all active streams."""

    def __init__(self):
        self._streams: Dict[str, StreamState] = {}

    def start_stream(
        self,
        conversation_id: str,
        stream_type: StreamType
    ) -> Optional[asyncio.Event]:
        """Register a new stream.

        Args:
            conversation_id: The conversation being streamed
            stream_type: NORMAL or AGENT

        Returns:
            Event for agent streams (used to signal stop), None for normal streams
        """
        stop_event = None
        if stream_type == StreamType.AGENT:
            stop_event = asyncio.Event()

        self._streams[conversation_id] = StreamState(
            stream_type=stream_type,
            stop_event=stop_event
        )

        return stop_event

    def end_stream(self, conversation_id: str) -> bool:
        """Unregister a stream.

        Args:
            conversation_id: The conversation to unregister

        Returns:
            True if stream was found and removed, False otherwise
        """
        if conversation_id in self._streams:
            del self._streams[conversation_id]
            return True
        return False

    def is_streaming(self, conversation_id: str) -> bool:
        """Check if a conversation is currently streaming."""
        return conversation_id in self._streams

    def get_status(self, conversation_id: str) -> Dict:
        """Get detailed status for a conversation.

        Returns:
            Dict with streaming status and capabilities
        """
        if conversation_id not in self._streams:
            return {
                "streaming": False,
                "type": None,
                "stoppable": False
            }

        state = self._streams[conversation_id]
        return {
            "streaming": True,
            "type": state.stream_type.value,
            "stoppable": state.stream_type == StreamType.AGENT
        }

    def stop_stream(self, conversation_id: str) -> bool:
        """Signal a stream to stop (only works for agent streams).

        Args:
            conversation_id: The conversation to stop

        Returns:
            True if stop was signaled, False if not possible
        """
        if conversation_id not in self._streams:
            return False

        state = self._streams[conversation_id]
        if state.stream_type != StreamType.AGENT or state.stop_event is None:
            return False

        state.stop_event.set()
        return True

    def get_all_streaming(self) -> Dict[str, Dict]:
        """Get status of all active streams.

        Returns:
            Dict mapping conversation_id to status dict
        """
        return {
            conv_id: self.get_status(conv_id)
            for conv_id in self._streams
        }


# Singleton instance
_streaming_service: Optional[StreamingService] = None


def get_streaming_service() -> StreamingService:
    """Get the singleton StreamingService instance."""
    global _streaming_service
    if _streaming_service is None:
        _streaming_service = StreamingService()
    return _streaming_service

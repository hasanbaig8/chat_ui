"""Unified streaming registry service.

This service provides a single source of truth for tracking all active
streams, whether they are normal chat or agent chat streams.
"""

import asyncio
import time
import uuid
from enum import Enum
from typing import Dict, Optional, List, Any
from dataclasses import dataclass, field


class StreamType(Enum):
    """Type of stream - determines capabilities."""
    NORMAL = "normal"  # Regular chat - not stoppable
    AGENT = "agent"    # Agent chat - stoppable via Event


@dataclass
class SteerContext:
    """Context for steering an in-progress agent stream."""
    guidance: str
    partial_content: List[Dict[str, Any]]
    created_at: float = field(default_factory=time.time)


@dataclass
class StreamState:
    """State of an active stream."""
    stream_type: StreamType
    stop_event: Optional[asyncio.Event] = None  # Only for AGENT streams
    # Task tracking fields
    task_id: Optional[str] = None
    title: Optional[str] = None
    conversation_id: Optional[str] = None
    started_at: Optional[float] = None
    # Steering context (for real-time guidance)
    steer_context: Optional[SteerContext] = None


class StreamingService:
    """Unified registry for all active streams."""

    def __init__(self):
        self._streams: Dict[str, StreamState] = {}
        # Store steer contexts separately so they survive stream end
        self._steer_contexts: Dict[str, SteerContext] = {}

    def start_stream(
        self,
        conversation_id: str,
        stream_type: StreamType,
        title: Optional[str] = None
    ) -> Optional[asyncio.Event]:
        """Register a new stream.

        Args:
            conversation_id: The conversation being streamed
            stream_type: NORMAL or AGENT
            title: Optional title for task tracking (first line of user message)

        Returns:
            Event for agent streams (used to signal stop), None for normal streams
        """
        stop_event = None
        if stream_type == StreamType.AGENT:
            stop_event = asyncio.Event()

        task_id = str(uuid.uuid4()) if stream_type == StreamType.AGENT else None

        self._streams[conversation_id] = StreamState(
            stream_type=stream_type,
            stop_event=stop_event,
            task_id=task_id,
            title=title,
            conversation_id=conversation_id,
            started_at=time.time()
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

    def get_active_tasks(self) -> List[Dict[str, Any]]:
        """Get all active agent tasks with metadata.

        Returns:
            List of task info dicts for background task tracking
        """
        tasks = []
        for conv_id, state in self._streams.items():
            if state.stream_type == StreamType.AGENT and state.task_id:
                tasks.append({
                    "task_id": state.task_id,
                    "conversation_id": conv_id,
                    "title": state.title,
                    "started_at": state.started_at,
                    "elapsed_seconds": time.time() - state.started_at if state.started_at else 0
                })
        return tasks

    def set_steer_context(self, conversation_id: str, context: SteerContext) -> bool:
        """Set steering context for a conversation.

        Stores context separately from stream state so it survives stream end.

        Args:
            conversation_id: The conversation to steer
            context: The steering context with guidance and partial content

        Returns:
            True (always succeeds)
        """
        print(f"[STREAMING_SERVICE] Setting steer context for: {conversation_id}")
        print(f"[STREAMING_SERVICE] Current steer contexts: {list(self._steer_contexts.keys())}")
        self._steer_contexts[conversation_id] = context
        print(f"[STREAMING_SERVICE] After set, steer contexts: {list(self._steer_contexts.keys())}")
        return True

    def get_steer_context(self, conversation_id: str) -> Optional[SteerContext]:
        """Get steering context for a conversation.

        Args:
            conversation_id: The conversation to check

        Returns:
            SteerContext if set, None otherwise
        """
        print(f"[STREAMING_SERVICE] Getting steer context for: {conversation_id}")
        print(f"[STREAMING_SERVICE] Available steer contexts: {list(self._steer_contexts.keys())}")
        result = self._steer_contexts.get(conversation_id)
        print(f"[STREAMING_SERVICE] Found: {result is not None}")
        return result

    def clear_steer_context(self, conversation_id: str) -> bool:
        """Clear steering context for a conversation.

        Args:
            conversation_id: The conversation to clear context for

        Returns:
            True if cleared, False if not found
        """
        print(f"[STREAMING_SERVICE] Clearing steer context for: {conversation_id}")
        if conversation_id in self._steer_contexts:
            del self._steer_contexts[conversation_id]
            return True
        return False


# Singleton instance
_streaming_service: Optional[StreamingService] = None


def get_streaming_service() -> StreamingService:
    """Get the singleton StreamingService instance."""
    global _streaming_service
    if _streaming_service is None:
        _streaming_service = StreamingService()
    return _streaming_service

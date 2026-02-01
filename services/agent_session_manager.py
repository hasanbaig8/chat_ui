"""Agent session manager for persistent ClaudeSDKClient sessions.

This module manages active ClaudeSDKClient instances keyed by conversation_id,
enabling multi-turn conversations within a single agent session without
re-initializing tools or losing context.
"""

import asyncio
import time
from typing import Dict, Optional, Any

# Try to import the Claude Agent SDK
SDK_AVAILABLE = False
ClaudeSDKClient = None
ClaudeAgentOptions = None

try:
    from claude_agent_sdk import ClaudeSDKClient as _ClaudeSDKClient, ClaudeAgentOptions as _ClaudeAgentOptions
    ClaudeSDKClient = _ClaudeSDKClient
    ClaudeAgentOptions = _ClaudeAgentOptions
    SDK_AVAILABLE = True
except ImportError:
    pass


class AgentSessionManager:
    """Manages persistent ClaudeSDKClient sessions."""

    def __init__(self, session_ttl_seconds: int = 1800):
        """Initialize the session manager.

        Args:
            session_ttl_seconds: Time-to-live for inactive sessions (default 30 min)
        """
        self._sessions: Dict[str, Any] = {}  # conversation_id -> ClaudeSDKClient
        self._locks: Dict[str, asyncio.Lock] = {}  # conversation_id -> Lock
        self._last_activity: Dict[str, float] = {}  # conversation_id -> timestamp
        self._session_ttl = session_ttl_seconds

    def get_session(self, conversation_id: str) -> Optional[Any]:
        """Get existing session or None.

        Args:
            conversation_id: The conversation ID

        Returns:
            ClaudeSDKClient instance if exists, None otherwise
        """
        session = self._sessions.get(conversation_id)
        if session:
            self._last_activity[conversation_id] = time.time()
        return session

    def has_session(self, conversation_id: str) -> bool:
        """Check if a session exists for the conversation.

        Args:
            conversation_id: The conversation ID

        Returns:
            True if session exists, False otherwise
        """
        return conversation_id in self._sessions

    def create_session(
        self,
        conversation_id: str,
        options: Any
    ) -> Any:
        """Create new session, replacing any existing one.

        Args:
            conversation_id: The conversation ID
            options: ClaudeAgentOptions for the session

        Returns:
            New ClaudeSDKClient instance
        """
        if not SDK_AVAILABLE or ClaudeSDKClient is None:
            raise RuntimeError("Claude Agent SDK not available")

        # Close existing session if any
        if conversation_id in self._sessions:
            self._cleanup_session(conversation_id)

        client = ClaudeSDKClient(options=options)
        self._sessions[conversation_id] = client
        self._locks[conversation_id] = asyncio.Lock()
        self._last_activity[conversation_id] = time.time()

        print(f"[SESSION_MANAGER] Created session for conversation {conversation_id}")
        return client

    def store_session(self, conversation_id: str, client: Any) -> None:
        """Store an existing client session.

        Args:
            conversation_id: The conversation ID
            client: ClaudeSDKClient instance to store
        """
        self._sessions[conversation_id] = client
        if conversation_id not in self._locks:
            self._locks[conversation_id] = asyncio.Lock()
        self._last_activity[conversation_id] = time.time()
        print(f"[SESSION_MANAGER] Stored session for conversation {conversation_id}")

    def get_lock(self, conversation_id: str) -> asyncio.Lock:
        """Get lock to prevent concurrent queries on same session.

        Args:
            conversation_id: The conversation ID

        Returns:
            asyncio.Lock for the conversation
        """
        if conversation_id not in self._locks:
            self._locks[conversation_id] = asyncio.Lock()
        return self._locks[conversation_id]

    def remove_session(self, conversation_id: str) -> None:
        """Remove and cleanup session.

        Args:
            conversation_id: The conversation ID
        """
        self._cleanup_session(conversation_id)
        print(f"[SESSION_MANAGER] Removed session for conversation {conversation_id}")

    def _cleanup_session(self, conversation_id: str) -> None:
        """Internal cleanup.

        Args:
            conversation_id: The conversation ID
        """
        if conversation_id in self._sessions:
            # Just remove the reference - don't try to disconnect
            # The SDK will cleanup when the object is garbage collected
            del self._sessions[conversation_id]
        if conversation_id in self._locks:
            del self._locks[conversation_id]
        if conversation_id in self._last_activity:
            del self._last_activity[conversation_id]

    def cleanup_stale_sessions(self) -> int:
        """Remove sessions that have been inactive longer than TTL.

        Returns:
            Number of sessions cleaned up
        """
        now = time.time()
        stale_ids = [
            cid for cid, last_time in self._last_activity.items()
            if now - last_time > self._session_ttl
        ]

        for cid in stale_ids:
            self._cleanup_session(cid)
            print(f"[SESSION_MANAGER] Cleaned up stale session for conversation {cid}")

        return len(stale_ids)

    def get_active_session_count(self) -> int:
        """Get the number of active sessions.

        Returns:
            Number of active sessions
        """
        return len(self._sessions)

    def get_session_info(self, conversation_id: str) -> Optional[Dict[str, Any]]:
        """Get info about a session.

        Args:
            conversation_id: The conversation ID

        Returns:
            Dict with session info or None if no session exists
        """
        if conversation_id not in self._sessions:
            return None

        return {
            "conversation_id": conversation_id,
            "has_session": True,
            "last_activity": self._last_activity.get(conversation_id),
            "age_seconds": time.time() - self._last_activity.get(conversation_id, time.time())
        }


# Singleton instance
_session_manager: Optional[AgentSessionManager] = None


def get_session_manager() -> AgentSessionManager:
    """Get or create the singleton session manager instance."""
    global _session_manager
    if _session_manager is None:
        _session_manager = AgentSessionManager()
    return _session_manager


def is_sdk_client_available() -> bool:
    """Check if ClaudeSDKClient is available."""
    return SDK_AVAILABLE

"""Agent session pooling service.

Pre-computes and caches agent options to reduce startup latency.
Since the ClaudeSDKClient spawns MCP servers internally, we focus on
pre-validating paths and building options ahead of time.
"""

import asyncio
import time
import os
from dataclasses import dataclass, field
from typing import Dict, Optional, Any


@dataclass
class WarmSession:
    """Pre-computed session data for faster agent startup."""
    conversation_id: str
    workspace_path: str
    memory_path: Optional[str]
    options_kwargs: Dict[str, Any]  # Pre-built kwargs for build_options
    created_at: float = field(default_factory=time.time)
    last_used: float = field(default_factory=time.time)


class AgentPool:
    """Pool of pre-warmed agent sessions.

    Caches pre-computed options and validated paths to reduce
    startup latency when initiating agent conversations.
    """

    def __init__(self, max_sessions: int = 10, ttl_seconds: int = 300):
        """Initialize the agent pool.

        Args:
            max_sessions: Maximum number of warm sessions to maintain
            ttl_seconds: Time-to-live for unused sessions (seconds)
        """
        self._sessions: Dict[str, WarmSession] = {}
        self._max_sessions = max_sessions
        self._ttl_seconds = ttl_seconds
        self._lock = asyncio.Lock()

    async def warm_for_conversation(
        self,
        conversation_id: str,
        workspace_path: str,
        memory_path: Optional[str] = None,
        system_prompt: Optional[str] = None,
        model: Optional[str] = None,
        session_id: Optional[str] = None,
        enabled_tools: Optional[Dict[str, bool]] = None,
        thinking_budget: Optional[int] = None
    ) -> bool:
        """Pre-warm a session for a conversation.

        Creates and caches pre-computed options for faster startup.

        Args:
            conversation_id: Conversation to warm
            workspace_path: Working directory for agent
            memory_path: Optional memory directory path
            system_prompt: Optional system prompt
            model: Optional model override
            session_id: Optional session ID to resume
            enabled_tools: Optional tool enable/disable settings
            thinking_budget: Optional thinking budget

        Returns:
            True if session was warmed successfully
        """
        async with self._lock:
            # Clean up stale sessions first
            await self._cleanup_stale_locked()

            # Evict oldest if at capacity
            if len(self._sessions) >= self._max_sessions:
                oldest_id = min(
                    self._sessions.keys(),
                    key=lambda k: self._sessions[k].last_used
                )
                del self._sessions[oldest_id]

            # Validate and create workspace
            os.makedirs(workspace_path, exist_ok=True)
            if memory_path:
                os.makedirs(memory_path, exist_ok=True)

            # Build options kwargs (everything except the prompt)
            options_kwargs = {
                "workspace_path": workspace_path,
                "system_prompt": system_prompt,
                "model": model,
                "session_id": session_id,
                "memory_path": memory_path,
                "enabled_tools": enabled_tools,
                "thinking_budget": thinking_budget,
                "conversation_id": conversation_id
            }

            # Store warm session
            self._sessions[conversation_id] = WarmSession(
                conversation_id=conversation_id,
                workspace_path=workspace_path,
                memory_path=memory_path,
                options_kwargs=options_kwargs
            )

            print(f"[AgentPool] Warmed session for {conversation_id}")
            return True

    async def get_warm_session(self, conversation_id: str) -> Optional[WarmSession]:
        """Get a pre-warmed session if available.

        Args:
            conversation_id: Conversation to get session for

        Returns:
            WarmSession if available, None otherwise
        """
        async with self._lock:
            session = self._sessions.get(conversation_id)
            if session:
                # Check if still valid
                if time.time() - session.created_at < self._ttl_seconds:
                    session.last_used = time.time()
                    print(f"[AgentPool] Using warm session for {conversation_id}")
                    return session
                else:
                    # Expired
                    del self._sessions[conversation_id]
                    print(f"[AgentPool] Session expired for {conversation_id}")

            return None

    async def invalidate_session(self, conversation_id: str) -> bool:
        """Remove a warm session.

        Args:
            conversation_id: Conversation to invalidate

        Returns:
            True if session was found and removed
        """
        async with self._lock:
            if conversation_id in self._sessions:
                del self._sessions[conversation_id]
                return True
            return False

    async def cleanup_stale(self):
        """Remove expired sessions (public method)."""
        async with self._lock:
            await self._cleanup_stale_locked()

    async def _cleanup_stale_locked(self):
        """Remove expired sessions (must be called with lock held)."""
        now = time.time()
        expired = [
            conv_id for conv_id, session in self._sessions.items()
            if now - session.last_used > self._ttl_seconds
        ]
        for conv_id in expired:
            del self._sessions[conv_id]
            print(f"[AgentPool] Cleaned up stale session: {conv_id}")

    def get_stats(self) -> Dict[str, Any]:
        """Get pool statistics."""
        return {
            "active_sessions": len(self._sessions),
            "max_sessions": self._max_sessions,
            "ttl_seconds": self._ttl_seconds,
            "session_ids": list(self._sessions.keys())
        }


# Singleton instance
_agent_pool: Optional[AgentPool] = None


def get_agent_pool() -> AgentPool:
    """Get the singleton AgentPool instance."""
    global _agent_pool
    if _agent_pool is None:
        _agent_pool = AgentPool()
    return _agent_pool

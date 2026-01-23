"""SQLite-based conversation persistence with branching support."""

import json
import uuid
from datetime import datetime
from pathlib import Path
from typing import List, Dict, Any, Optional
import aiosqlite

from config import DATABASE_PATH


class ConversationStore:
    """SQLite-based storage for conversations with message branching."""

    def __init__(self, db_path: str = DATABASE_PATH):
        self.db_path = db_path
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)

    async def initialize(self):
        """Initialize the database schema."""
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute("""
                CREATE TABLE IF NOT EXISTS conversations (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    model TEXT,
                    system_prompt TEXT,
                    active_versions TEXT DEFAULT '{}'
                )
            """)

            # Check if we need to migrate the messages table
            cursor = await db.execute("PRAGMA table_info(messages)")
            columns = [row[1] for row in await cursor.fetchall()]

            if 'position' not in columns:
                # New schema - create fresh or migrate
                await db.execute("""
                    CREATE TABLE IF NOT EXISTS messages_new (
                        id TEXT PRIMARY KEY,
                        conversation_id TEXT NOT NULL,
                        role TEXT NOT NULL,
                        content TEXT NOT NULL,
                        thinking TEXT,
                        position INTEGER NOT NULL,
                        version INTEGER NOT NULL DEFAULT 1,
                        parent_message_id TEXT,
                        created_at TEXT NOT NULL,
                        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
                        FOREIGN KEY (parent_message_id) REFERENCES messages(id) ON DELETE SET NULL
                    )
                """)

                # Check if old messages table exists and has data
                cursor = await db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'")
                if await cursor.fetchone():
                    # Migrate existing messages
                    cursor = await db.execute("SELECT * FROM messages ORDER BY conversation_id, created_at")
                    rows = await cursor.fetchall()

                    # Group by conversation and assign positions
                    conv_positions = {}
                    for row in rows:
                        msg_id, conv_id, role, content, thinking, created_at = row
                        if conv_id not in conv_positions:
                            conv_positions[conv_id] = 0
                        pos = conv_positions[conv_id]
                        conv_positions[conv_id] += 1

                        await db.execute(
                            """INSERT INTO messages_new (id, conversation_id, role, content, thinking, position, version, parent_message_id, created_at)
                               VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?)""",
                            (msg_id, conv_id, role, content, thinking, pos, created_at)
                        )

                    await db.execute("DROP TABLE messages")

                await db.execute("ALTER TABLE messages_new RENAME TO messages")

            # Add parent_message_id column if missing (for existing databases)
            if 'parent_message_id' not in columns and 'position' in columns:
                await db.execute("ALTER TABLE messages ADD COLUMN parent_message_id TEXT")

            await db.execute("""
                CREATE INDEX IF NOT EXISTS idx_messages_conversation
                ON messages(conversation_id, position, version)
            """)

            await db.execute("""
                CREATE INDEX IF NOT EXISTS idx_messages_parent
                ON messages(parent_message_id)
            """)

            # Add active_versions column if missing
            cursor = await db.execute("PRAGMA table_info(conversations)")
            conv_columns = [row[1] for row in await cursor.fetchall()]
            if 'active_versions' not in conv_columns:
                await db.execute("ALTER TABLE conversations ADD COLUMN active_versions TEXT DEFAULT '{}'")

            await db.commit()

    async def create_conversation(
        self,
        title: str = "New Conversation",
        model: Optional[str] = None,
        system_prompt: Optional[str] = None,
        is_agent: bool = False
    ) -> Dict[str, Any]:
        """Create a new conversation.

        Args:
            is_agent: Whether this is an agent conversation (ignored for SQLite store, kept for compatibility)
        """
        conversation_id = str(uuid.uuid4())
        now = datetime.utcnow().isoformat()

        async with aiosqlite.connect(self.db_path) as db:
            await db.execute(
                """INSERT INTO conversations (id, title, created_at, updated_at, model, system_prompt, active_versions)
                   VALUES (?, ?, ?, ?, ?, ?, '{}')""",
                (conversation_id, title, now, now, model, system_prompt)
            )
            await db.commit()

        return {
            "id": conversation_id,
            "title": title,
            "created_at": now,
            "updated_at": now,
            "model": model,
            "system_prompt": system_prompt,
            "messages": []
        }

    async def get_conversation(self, conversation_id: str, branch: Optional[List[int]] = None) -> Optional[Dict[str, Any]]:
        """Get a conversation with active messages following the branch chain.

        Args:
            conversation_id: ID of the conversation
            branch: Optional branch array (ignored for SQLite store, kept for compatibility with FileConversationStore)

        Messages are selected based on:
        1. At position 0: use active_versions to select which user message version
        2. At subsequent positions: select messages whose parent matches the previous selected message
        3. If multiple messages have the same parent (retries), use active_versions to pick
        """
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row

            cursor = await db.execute(
                "SELECT * FROM conversations WHERE id = ?",
                (conversation_id,)
            )
            row = await cursor.fetchone()
            if not row:
                return None

            conversation = dict(row)
            active_versions = json.loads(conversation.get('active_versions') or '{}')

            # Get all messages for this conversation
            cursor = await db.execute(
                """SELECT * FROM messages WHERE conversation_id = ?
                   ORDER BY position, version""",
                (conversation_id,)
            )
            all_messages = [dict(row) async for row in cursor]

            print(f"[GET_CONV SQLite] Found {len(all_messages)} messages for {conversation_id}")
            for msg in all_messages:
                print(f"  - Position {msg['position']}, Role {msg['role']}, Version {msg['version']}, Content length: {len(msg['content'])}")

            if not all_messages:
                conversation["messages"] = []
                return conversation

            # Group messages by position for version counting
            messages_by_position = {}
            for msg in all_messages:
                pos = msg['position']
                if pos not in messages_by_position:
                    messages_by_position[pos] = []
                messages_by_position[pos].append(msg)

            # Build the active message chain following parent links
            messages = []
            current_parent_id = None
            previous_selected_version = None
            max_position = max(messages_by_position.keys())

            for pos in range(max_position + 1):
                if pos not in messages_by_position:
                    continue

                candidates = messages_by_position[pos]

                # Filter candidates by parent_message_id
                if pos == 0:
                    # First message has no parent - select by active_versions
                    matching = candidates
                else:
                    # Find messages whose parent is the previously selected message
                    matching = [m for m in candidates if m.get('parent_message_id') == current_parent_id]

                    # Fallback for legacy data (no parent_message_id set)
                    if not matching:
                        # Try to match by version number - assumes versions correspond
                        # (user v2 should pair with assistant v2 if they were created together)
                        if previous_selected_version:
                            version_match = [m for m in candidates if m['version'] == previous_selected_version]
                            if version_match:
                                matching = version_match

                    # Final fallback: use all candidates
                    if not matching:
                        matching = candidates

                if not matching:
                    continue

                # If multiple matching (retries with same parent), use active_versions
                active_ver = active_versions.get(str(pos))
                selected = None

                if active_ver:
                    # Try to find the specifically requested version
                    for m in matching:
                        if m['version'] == active_ver:
                            selected = m
                            break

                if not selected:
                    # Default to the latest matching version
                    selected = max(matching, key=lambda m: m['version'])

                # Parse content
                try:
                    selected["content"] = json.loads(selected["content"])
                except (json.JSONDecodeError, TypeError):
                    pass

                # Add version info for UI
                # For proper branching, count only versions that share the same parent
                versions_with_same_parent = [m for m in candidates if m.get('parent_message_id') == selected.get('parent_message_id')]
                selected["total_versions"] = len(versions_with_same_parent) if versions_with_same_parent else len(candidates)
                selected["current_version"] = selected['version']

                messages.append(selected)
                current_parent_id = selected['id']
                previous_selected_version = selected['version']

            print(f"[GET_CONV SQLite] Returning {len(messages)} messages after filtering")
            for msg in messages:
                print(f"  - Position {msg['position']}, Role {msg['role']}, Content length: {len(str(msg['content']))}")

            conversation["messages"] = messages
            return conversation

    async def list_conversations(self) -> List[Dict[str, Any]]:
        """List all conversations (without messages)."""
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute(
                "SELECT id, title, created_at, updated_at, model FROM conversations ORDER BY updated_at DESC"
            )
            return [dict(row) async for row in cursor]

    async def update_conversation(
        self,
        conversation_id: str,
        title: Optional[str] = None,
        model: Optional[str] = None,
        system_prompt: Optional[str] = None
    ) -> bool:
        """Update conversation metadata."""
        updates = []
        params = []

        if title is not None:
            updates.append("title = ?")
            params.append(title)
        if model is not None:
            updates.append("model = ?")
            params.append(model)
        if system_prompt is not None:
            updates.append("system_prompt = ?")
            params.append(system_prompt)

        if not updates:
            return False

        updates.append("updated_at = ?")
        params.append(datetime.utcnow().isoformat())
        params.append(conversation_id)

        async with aiosqlite.connect(self.db_path) as db:
            await db.execute(
                f"UPDATE conversations SET {', '.join(updates)} WHERE id = ?",
                params
            )
            await db.commit()
            return db.total_changes > 0

    async def delete_conversation(self, conversation_id: str) -> bool:
        """Delete a conversation and all its messages."""
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute(
                "DELETE FROM messages WHERE conversation_id = ?",
                (conversation_id,)
            )
            await db.execute(
                "DELETE FROM conversations WHERE id = ?",
                (conversation_id,)
            )
            await db.commit()
            return db.total_changes > 0

    async def add_message(
        self,
        conversation_id: str,
        role: str,
        content: Any,
        thinking: Optional[str] = None,
        streaming: bool = False,
        parent_message_id: Optional[str] = None,
        branch: Optional[List[int]] = None,
        tool_results: Optional[List[Dict]] = None
    ) -> Dict[str, Any]:
        """Add a message to a conversation.

        Args:
            parent_message_id: ID of the message this is responding to.
                - For user messages: parent is the previous assistant message (or None for first)
                - For assistant messages: parent is the user message being responded to
            branch: Optional branch array (ignored for SQLite store, kept for compatibility)
            tool_results: Optional tool results (ignored for SQLite store, kept for compatibility)
        """
        message_id = str(uuid.uuid4())
        now = datetime.utcnow().isoformat()
        content_str = json.dumps(content) if not isinstance(content, str) else content

        async with aiosqlite.connect(self.db_path) as db:
            # Get next position
            cursor = await db.execute(
                "SELECT MAX(position) FROM messages WHERE conversation_id = ?",
                (conversation_id,)
            )
            row = await cursor.fetchone()
            # Note: can't use `row[0] or -1` because 0 is falsy in Python
            position = 0 if row[0] is None else row[0] + 1

            print(f"[ADD_MESSAGE SQLite] Adding {role} message at position {position}, parent: {parent_message_id}, content length: {len(content_str)}")
            await db.execute(
                """INSERT INTO messages (id, conversation_id, role, content, thinking, position, version, parent_message_id, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)""",
                (message_id, conversation_id, role, content_str, thinking, position, parent_message_id, now)
            )
            await db.execute(
                "UPDATE conversations SET updated_at = ? WHERE id = ?",
                (now, conversation_id)
            )
            await db.commit()
            print(f"[ADD_MESSAGE SQLite] Created message {message_id}")

        return {
            "id": message_id,
            "conversation_id": conversation_id,
            "role": role,
            "content": content,
            "thinking": thinking,
            "position": position,
            "version": 1,
            "total_versions": 1,
            "current_version": 1,
            "parent_message_id": parent_message_id,
            "created_at": now,
            "streaming": streaming
        }

    async def update_message_content(
        self,
        conversation_id: str,
        message_id: str,
        content: str,
        thinking: Optional[str] = None,
        tool_results: Optional[List[Dict]] = None,
        branch: Optional[List[int]] = None,
        streaming: bool = True
    ) -> bool:
        """Update message content (used for streaming updates).

        Args:
            conversation_id: Conversation ID (kept for compatibility with FileConversationStore)
            message_id: Message ID to update
            content: New content
            thinking: Optional thinking content
            tool_results: Optional tool results (ignored for SQLite store)
            branch: Optional branch array (ignored for SQLite store)
            streaming: Whether message is still streaming
        """
        print(f"[UPDATE_MESSAGE SQLite] Updating message {message_id} with content length: {len(content)}")
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute(
                "UPDATE messages SET content = ?, thinking = ? WHERE id = ?",
                (content, thinking, message_id)
            )
            await db.commit()
            updated = db.total_changes > 0
            print(f"[UPDATE_MESSAGE SQLite] Updated: {updated}")
            return updated

    async def get_message_by_id(self, message_id: str) -> Optional[Dict[str, Any]]:
        """Get a single message by ID."""
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute(
                "SELECT * FROM messages WHERE id = ?",
                (message_id,)
            )
            row = await cursor.fetchone()
            if not row:
                return None
            msg = dict(row)
            try:
                msg["content"] = json.loads(msg["content"])
            except (json.JSONDecodeError, TypeError):
                pass
            return msg

    async def edit_message(
        self,
        conversation_id: str,
        position: int,
        new_content: Any
    ) -> Dict[str, Any]:
        """Edit a message at a position, creating a new version (new branch).

        The new version keeps the same parent as the original message.
        """
        message_id = str(uuid.uuid4())
        now = datetime.utcnow().isoformat()
        content_str = json.dumps(new_content) if not isinstance(new_content, str) else new_content

        async with aiosqlite.connect(self.db_path) as db:
            # Get current max version and info at this position
            cursor = await db.execute(
                "SELECT MAX(version), role, parent_message_id FROM messages WHERE conversation_id = ? AND position = ?",
                (conversation_id, position)
            )
            row = await cursor.fetchone()
            new_version = (row[0] or 0) + 1
            role = row[1] or 'user'
            parent_message_id = row[2]  # Keep same parent as original

            # Insert new version with same parent
            await db.execute(
                """INSERT INTO messages (id, conversation_id, role, content, thinking, position, version, parent_message_id, created_at)
                   VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)""",
                (message_id, conversation_id, role, content_str, position, new_version, parent_message_id, now)
            )

            # Update active versions to use this new version
            cursor = await db.execute(
                "SELECT active_versions FROM conversations WHERE id = ?",
                (conversation_id,)
            )
            row = await cursor.fetchone()
            active_versions = json.loads(row[0] or '{}')
            active_versions[str(position)] = new_version

            # Remove active versions for positions after this one (they'll use defaults)
            keys_to_remove = [k for k in active_versions.keys() if int(k) > position]
            for k in keys_to_remove:
                del active_versions[k]

            await db.execute(
                "UPDATE conversations SET active_versions = ?, updated_at = ? WHERE id = ?",
                (json.dumps(active_versions), now, conversation_id)
            )
            await db.commit()

        return {
            "id": message_id,
            "conversation_id": conversation_id,
            "role": role,
            "content": new_content,
            "position": position,
            "version": new_version,
            "parent_message_id": parent_message_id,
            "created_at": now
        }

    async def create_branch(
        self,
        conversation_id: str,
        current_branch: List[int],
        user_msg_index: int,
        new_content: Any
    ) -> Dict[str, Any]:
        """Create a new branch by editing a user message.

        This is an adapter that matches the file store's interface.
        For SQLite, we use position-based versioning instead of branch arrays.
        """
        # User messages are at even positions (0, 2, 4, ...)
        position = user_msg_index * 2

        # Call the existing edit_message method
        message = await self.edit_message(conversation_id, position, new_content)

        # Construct a branch array for compatibility
        # The branch array represents version choices at each user message position
        new_branch = current_branch[:user_msg_index] if user_msg_index < len(current_branch) else current_branch[:]
        new_branch.append(message["version"] - 1)  # Version is 1-based, branch is 0-based

        return {
            "branch": new_branch,
            "message": message
        }

    async def retry_message(
        self,
        conversation_id: str,
        position: int,
        new_content: Any,
        thinking: Optional[str] = None,
        parent_message_id: Optional[str] = None
    ) -> Dict[str, Any]:
        """Create a new version of an assistant message (retry).

        The retry keeps the same parent (the user message it responds to).
        """
        message_id = str(uuid.uuid4())
        now = datetime.utcnow().isoformat()
        content_str = json.dumps(new_content) if not isinstance(new_content, str) else new_content

        async with aiosqlite.connect(self.db_path) as db:
            # Get current max version and parent at this position
            cursor = await db.execute(
                "SELECT MAX(version), parent_message_id FROM messages WHERE conversation_id = ? AND position = ?",
                (conversation_id, position)
            )
            row = await cursor.fetchone()
            new_version = (row[0] or 0) + 1
            # Use provided parent or keep existing parent
            actual_parent = parent_message_id if parent_message_id else row[1]

            # Insert new version with same parent
            await db.execute(
                """INSERT INTO messages (id, conversation_id, role, content, thinking, position, version, parent_message_id, created_at)
                   VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, ?)""",
                (message_id, conversation_id, content_str, thinking, position, new_version, actual_parent, now)
            )

            # Update active versions
            cursor = await db.execute(
                "SELECT active_versions FROM conversations WHERE id = ?",
                (conversation_id,)
            )
            row = await cursor.fetchone()
            active_versions = json.loads(row[0] or '{}')
            active_versions[str(position)] = new_version

            await db.execute(
                "UPDATE conversations SET active_versions = ?, updated_at = ? WHERE id = ?",
                (json.dumps(active_versions), now, conversation_id)
            )
            await db.commit()

        return {
            "id": message_id,
            "conversation_id": conversation_id,
            "role": "assistant",
            "content": new_content,
            "thinking": thinking,
            "position": position,
            "version": new_version,
            "parent_message_id": actual_parent,
            "created_at": now
        }

    async def switch_version(
        self,
        conversation_id: str,
        position: int,
        version: int
    ) -> bool:
        """Switch to a different version at a position.

        When switching a user message version, also clears downstream active_versions
        so that the corresponding assistant responses are shown (defaults to matching version
        or latest available).
        """
        async with aiosqlite.connect(self.db_path) as db:
            # Verify the version exists and get the role
            cursor = await db.execute(
                "SELECT role FROM messages WHERE conversation_id = ? AND position = ? AND version = ?",
                (conversation_id, position, version)
            )
            row = await cursor.fetchone()
            if not row:
                return False

            role = row[0]

            # Update active versions
            cursor = await db.execute(
                "SELECT active_versions FROM conversations WHERE id = ?",
                (conversation_id,)
            )
            row = await cursor.fetchone()
            active_versions = json.loads(row[0] or '{}')
            active_versions[str(position)] = version

            # If switching a user message, clear downstream positions
            # This ensures the corresponding assistant response is shown
            if role == 'user':
                keys_to_remove = [k for k in active_versions.keys() if int(k) > position]
                for k in keys_to_remove:
                    del active_versions[k]

            await db.execute(
                "UPDATE conversations SET active_versions = ? WHERE id = ?",
                (json.dumps(active_versions), conversation_id)
            )
            await db.commit()
            return True

    async def get_messages_up_to(self, conversation_id: str, position: int) -> List[Dict[str, Any]]:
        """Get active messages up to (not including) a position, following the branch chain."""
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row

            cursor = await db.execute(
                "SELECT active_versions FROM conversations WHERE id = ?",
                (conversation_id,)
            )
            row = await cursor.fetchone()
            active_versions = json.loads(row[0] or '{}') if row else {}

            cursor = await db.execute(
                """SELECT * FROM messages WHERE conversation_id = ? AND position < ?
                   ORDER BY position, version""",
                (conversation_id, position)
            )
            all_messages = [dict(row) async for row in cursor]

            if not all_messages:
                return []

            # Group by position
            messages_by_position = {}
            for msg in all_messages:
                pos = msg['position']
                if pos not in messages_by_position:
                    messages_by_position[pos] = []
                messages_by_position[pos].append(msg)

            # Build the active message chain following parent links
            messages = []
            current_parent_id = None
            previous_selected_version = None
            max_pos = max(messages_by_position.keys()) if messages_by_position else -1

            for pos in range(max_pos + 1):
                if pos not in messages_by_position:
                    continue

                candidates = messages_by_position[pos]

                # Filter by parent
                if pos == 0:
                    matching = candidates
                else:
                    matching = [m for m in candidates if m.get('parent_message_id') == current_parent_id]

                    # Fallback for legacy data - try to match by version
                    if not matching and previous_selected_version:
                        version_match = [m for m in candidates if m['version'] == previous_selected_version]
                        if version_match:
                            matching = version_match

                    # Final fallback
                    if not matching:
                        matching = candidates

                if not matching:
                    continue

                # Select based on active_versions
                active_ver = active_versions.get(str(pos))
                selected = None

                if active_ver:
                    for m in matching:
                        if m['version'] == active_ver:
                            selected = m
                            break

                if not selected:
                    selected = max(matching, key=lambda m: m['version'])

                # Parse content
                try:
                    selected["content"] = json.loads(selected["content"])
                except (json.JSONDecodeError, TypeError):
                    pass

                # Add version info
                versions_with_same_parent = [m for m in candidates if m.get('parent_message_id') == selected.get('parent_message_id')]
                selected["total_versions"] = len(versions_with_same_parent) if versions_with_same_parent else len(candidates)

                messages.append(selected)
                current_parent_id = selected['id']
                previous_selected_version = selected['version']

            return messages

    async def get_messages(self, conversation_id: str) -> List[Dict[str, Any]]:
        """Get all active messages for a conversation."""
        conv = await self.get_conversation(conversation_id)
        return conv["messages"] if conv else []

    async def get_position_version_info(self, conversation_id: str, position: int) -> Dict[str, Any]:
        """Get version info for a specific position."""
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row

            # Get all versions at this position
            cursor = await db.execute(
                """SELECT version FROM messages
                   WHERE conversation_id = ? AND position = ?
                   ORDER BY version""",
                (conversation_id, position)
            )
            versions = [row['version'] async for row in cursor]

            if not versions:
                return {"position": position, "total_versions": 0, "versions": []}

            # Get active version
            cursor = await db.execute(
                "SELECT active_versions FROM conversations WHERE id = ?",
                (conversation_id,)
            )
            row = await cursor.fetchone()
            active_versions = json.loads(row[0] or '{}') if row else {}
            current_version = active_versions.get(str(position), max(versions))

            return {
                "position": position,
                "total_versions": len(versions),
                "current_version": current_version,
                "versions": versions
            }

    async def search_conversations(self, query: str) -> List[Dict[str, Any]]:
        """Search conversations by title or message content (partial match always enabled)."""
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row

            # First, search in titles only
            cursor = await db.execute(
                "SELECT id, title, created_at, updated_at, model FROM conversations WHERE title LIKE ? ORDER BY updated_at DESC",
                (f'%{query}%',)
            )
            title_matches = {row['id']: dict(row) async for row in cursor}

            # Then, search in message content
            # Use INNER JOIN to only get conversations that have messages
            cursor = await db.execute(
                """
                SELECT DISTINCT c.id, c.title, c.created_at, c.updated_at, c.model
                FROM conversations c
                INNER JOIN messages m ON c.id = m.conversation_id
                WHERE m.content LIKE ?
                ORDER BY c.updated_at DESC
                """,
                (f'%{query}%',)
            )

            # Merge results, keeping title matches first
            content_matches = [dict(row) async for row in cursor]

            # Add content matches that aren't already in title matches
            results = list(title_matches.values())
            for conv in content_matches:
                if conv['id'] not in title_matches:
                    results.append(conv)

            return results

    async def duplicate_conversation(self, conversation_id: str) -> Optional[Dict[str, Any]]:
        """Duplicate a conversation with all its messages."""
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row

            # Get original conversation
            cursor = await db.execute(
                "SELECT * FROM conversations WHERE id = ?",
                (conversation_id,)
            )
            original = await cursor.fetchone()
            if not original:
                return None

            original_dict = dict(original)

            # Create new conversation with "Copy of" prefix
            new_id = str(uuid.uuid4())
            now = datetime.utcnow().isoformat()
            new_title = f"Copy of {original_dict['title']}"

            await db.execute(
                """INSERT INTO conversations (id, title, created_at, updated_at, model, system_prompt, active_versions)
                   VALUES (?, ?, ?, ?, ?, ?, '{}')""",
                (new_id, new_title, now, now, original_dict.get('model'), original_dict.get('system_prompt'))
            )

            # Copy all messages
            cursor = await db.execute(
                "SELECT * FROM messages WHERE conversation_id = ? ORDER BY position, version",
                (conversation_id,)
            )
            messages = [dict(row) async for row in cursor]

            for msg in messages:
                new_msg_id = str(uuid.uuid4())
                await db.execute(
                    """INSERT INTO messages (id, conversation_id, role, content, thinking, position, version, created_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                    (new_msg_id, new_id, msg['role'], msg['content'], msg.get('thinking'),
                     msg['position'], msg['version'], now)
                )

            await db.commit()

            return {
                "id": new_id,
                "title": new_title,
                "created_at": now,
                "updated_at": now,
                "model": original_dict.get('model'),
                "system_prompt": original_dict.get('system_prompt')
            }

    async def delete_messages_from(
        self,
        conversation_id: str,
        position: int,
        branch: Optional[List[int]] = None
    ) -> bool:
        """Delete messages from a position onwards (inclusive).

        For SQLite store, this deletes all messages with position >= specified position.
        The branch parameter is ignored as SQLite uses a different branching model.
        """
        print(f"[DELETE SQLite] Deleting messages from position {position} in conversation {conversation_id}")

        async with aiosqlite.connect(self.db_path) as db:
            # Check if conversation exists
            cursor = await db.execute(
                "SELECT id FROM conversations WHERE id = ?",
                (conversation_id,)
            )
            if not await cursor.fetchone():
                print(f"[DELETE SQLite] Conversation {conversation_id} not found")
                return False

            # Delete messages at or after position
            await db.execute(
                "DELETE FROM messages WHERE conversation_id = ? AND position >= ?",
                (conversation_id, position)
            )

            # Update conversation timestamp
            now = datetime.utcnow().isoformat()
            await db.execute(
                "UPDATE conversations SET updated_at = ? WHERE id = ?",
                (now, conversation_id)
            )

            await db.commit()
            deleted_count = db.total_changes
            print(f"[DELETE SQLite] Deleted {deleted_count} row(s)")
            return deleted_count > 0

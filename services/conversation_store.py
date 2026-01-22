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
                        created_at TEXT NOT NULL,
                        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
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
                            """INSERT INTO messages_new (id, conversation_id, role, content, thinking, position, version, created_at)
                               VALUES (?, ?, ?, ?, ?, ?, 1, ?)""",
                            (msg_id, conv_id, role, content, thinking, pos, created_at)
                        )

                    await db.execute("DROP TABLE messages")

                await db.execute("ALTER TABLE messages_new RENAME TO messages")

            await db.execute("""
                CREATE INDEX IF NOT EXISTS idx_messages_conversation
                ON messages(conversation_id, position, version)
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
        system_prompt: Optional[str] = None
    ) -> Dict[str, Any]:
        """Create a new conversation."""
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

    async def get_conversation(self, conversation_id: str) -> Optional[Dict[str, Any]]:
        """Get a conversation with active messages only."""
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

            # Filter to active versions and add version info
            messages = []
            position_versions = {}  # Track available versions at each position

            for msg in all_messages:
                pos = str(msg['position'])
                if pos not in position_versions:
                    position_versions[pos] = []
                position_versions[pos].append(msg['version'])

                # Use active version or default to highest version
                active_ver = active_versions.get(pos, max(position_versions[pos]))

                if msg['version'] == active_ver:
                    try:
                        msg["content"] = json.loads(msg["content"])
                    except (json.JSONDecodeError, TypeError):
                        pass

                    # Add version info for UI
                    msg["total_versions"] = len(position_versions[pos])
                    msg["current_version"] = msg['version']
                    messages.append(msg)

            # Update total_versions now that we know all versions
            for msg in messages:
                pos = str(msg['position'])
                msg["total_versions"] = len(position_versions[pos])

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
        streaming: bool = False
    ) -> Dict[str, Any]:
        """Add a message to a conversation."""
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

            await db.execute(
                """INSERT INTO messages (id, conversation_id, role, content, thinking, position, version, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, 1, ?)""",
                (message_id, conversation_id, role, content_str, thinking, position, now)
            )
            await db.execute(
                "UPDATE conversations SET updated_at = ? WHERE id = ?",
                (now, conversation_id)
            )
            await db.commit()

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
            "created_at": now,
            "streaming": streaming
        }

    async def update_message_content(
        self,
        message_id: str,
        content: str,
        thinking: Optional[str] = None,
        streaming: bool = True
    ) -> bool:
        """Update message content (used for streaming updates)."""
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute(
                "UPDATE messages SET content = ?, thinking = ? WHERE id = ?",
                (content, thinking, message_id)
            )
            await db.commit()
            return db.total_changes > 0

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
        """Edit a message at a position, creating a new version."""
        message_id = str(uuid.uuid4())
        now = datetime.utcnow().isoformat()
        content_str = json.dumps(new_content) if not isinstance(new_content, str) else new_content

        async with aiosqlite.connect(self.db_path) as db:
            # Get current max version at this position
            cursor = await db.execute(
                "SELECT MAX(version), role FROM messages WHERE conversation_id = ? AND position = ?",
                (conversation_id, position)
            )
            row = await cursor.fetchone()
            new_version = (row[0] or 0) + 1
            role = row[1] or 'user'

            # Insert new version
            await db.execute(
                """INSERT INTO messages (id, conversation_id, role, content, thinking, position, version, created_at)
                   VALUES (?, ?, ?, ?, NULL, ?, ?, ?)""",
                (message_id, conversation_id, role, content_str, position, new_version, now)
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
            "created_at": now
        }

    async def retry_message(
        self,
        conversation_id: str,
        position: int,
        new_content: Any,
        thinking: Optional[str] = None
    ) -> Dict[str, Any]:
        """Create a new version of an assistant message (retry)."""
        message_id = str(uuid.uuid4())
        now = datetime.utcnow().isoformat()
        content_str = json.dumps(new_content) if not isinstance(new_content, str) else new_content

        async with aiosqlite.connect(self.db_path) as db:
            # Get current max version at this position
            cursor = await db.execute(
                "SELECT MAX(version) FROM messages WHERE conversation_id = ? AND position = ?",
                (conversation_id, position)
            )
            row = await cursor.fetchone()
            new_version = (row[0] or 0) + 1

            # Insert new version
            await db.execute(
                """INSERT INTO messages (id, conversation_id, role, content, thinking, position, version, created_at)
                   VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?)""",
                (message_id, conversation_id, content_str, thinking, position, new_version, now)
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
            "created_at": now
        }

    async def switch_version(
        self,
        conversation_id: str,
        position: int,
        version: int
    ) -> bool:
        """Switch to a different version at a position."""
        async with aiosqlite.connect(self.db_path) as db:
            # Verify the version exists
            cursor = await db.execute(
                "SELECT 1 FROM messages WHERE conversation_id = ? AND position = ? AND version = ?",
                (conversation_id, position, version)
            )
            if not await cursor.fetchone():
                return False

            # Update active versions
            cursor = await db.execute(
                "SELECT active_versions FROM conversations WHERE id = ?",
                (conversation_id,)
            )
            row = await cursor.fetchone()
            active_versions = json.loads(row[0] or '{}')
            active_versions[str(position)] = version

            await db.execute(
                "UPDATE conversations SET active_versions = ? WHERE id = ?",
                (json.dumps(active_versions), conversation_id)
            )
            await db.commit()
            return True

    async def get_messages_up_to(self, conversation_id: str, position: int) -> List[Dict[str, Any]]:
        """Get active messages up to (not including) a position."""
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
                   ORDER BY position""",
                (conversation_id, position)
            )
            all_messages = [dict(row) async for row in cursor]

            # Group by position and filter to active versions
            position_messages = {}
            for msg in all_messages:
                pos = msg['position']
                if pos not in position_messages:
                    position_messages[pos] = []
                position_messages[pos].append(msg)

            messages = []
            for pos in sorted(position_messages.keys()):
                versions = position_messages[pos]
                active_ver = active_versions.get(str(pos), max(m['version'] for m in versions))
                for msg in versions:
                    if msg['version'] == active_ver:
                        try:
                            msg["content"] = json.loads(msg["content"])
                        except (json.JSONDecodeError, TypeError):
                            pass
                        messages.append(msg)
                        break

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

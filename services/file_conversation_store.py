"""File-based conversation storage with branching support.

Each conversation is stored as a folder with:
- metadata.json: Title, model, system_prompt, timestamps
- Branch files (0.json, 1.json, 0_1.json, etc.): Message arrays

Branch naming convention:
- 0.json = Default branch (implicitly 0_0_0_0...)
- 1.json = Branch 1 at user msg 1, then 0s
- 0_1.json = Branch 0 at user msg 1, branch 1 at user msg 2
- Trailing _0s are implicit and omitted
"""

import json
import uuid
import re
import os
from datetime import datetime
from pathlib import Path
from typing import List, Dict, Any, Optional, Tuple


class FileConversationStore:
    """File-based storage for conversations with branch-per-file model."""

    def __init__(self, base_path: str = "data/conversations"):
        self.base_path = Path(base_path)

    async def initialize(self):
        """Initialize the storage directory."""
        self.base_path.mkdir(parents=True, exist_ok=True)

    # =========================================================================
    # Branch Naming Utilities
    # =========================================================================

    def branch_array_to_filename(self, branch: List[int]) -> str:
        """Convert branch array to filename.

        Trailing zeros are omitted:
        [0] -> "0.json"
        [0, 0, 0] -> "0.json"
        [1] -> "1.json"
        [1, 0, 0] -> "1.json"
        [0, 1] -> "0_1.json"
        [0, 1, 0] -> "0_1.json"
        """
        if not branch:
            return "0.json"

        # Strip trailing zeros
        while len(branch) > 1 and branch[-1] == 0:
            branch = branch[:-1]

        return "_".join(str(b) for b in branch) + ".json"

    def filename_to_branch_array(self, filename: str) -> List[int]:
        """Convert filename to branch array.

        "0.json" -> [0]
        "1.json" -> [1]
        "0_1.json" -> [0, 1]
        """
        name = filename.replace(".json", "")
        if not name:
            return [0]
        return [int(x) for x in name.split("_")]

    def extend_branch_array(self, branch: List[int], length: int) -> List[int]:
        """Extend branch array with zeros to specified length."""
        if len(branch) >= length:
            return branch[:length]
        return branch + [0] * (length - len(branch))

    def get_branch_prefix(self, branch: List[int], length: int) -> List[int]:
        """Get prefix of branch array up to length."""
        return self.extend_branch_array(branch, length)[:length]

    # =========================================================================
    # File Operations
    # =========================================================================

    def _get_conversation_path(self, conversation_id: str) -> Path:
        """Get path to conversation folder."""
        return self.base_path / conversation_id

    def _get_metadata_path(self, conversation_id: str) -> Path:
        """Get path to metadata.json."""
        return self._get_conversation_path(conversation_id) / "metadata.json"

    def _get_branch_path(self, conversation_id: str, branch: List[int]) -> Path:
        """Get path to a branch file."""
        filename = self.branch_array_to_filename(branch)
        return self._get_conversation_path(conversation_id) / filename

    async def _read_json(self, path: Path) -> Optional[Dict]:
        """Read and parse a JSON file."""
        try:
            with open(path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            return None

    async def _write_json(self, path: Path, data: Dict):
        """Write data to a JSON file."""
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)

    def _list_branch_files(self, conversation_id: str) -> List[str]:
        """List all branch files in a conversation folder."""
        conv_path = self._get_conversation_path(conversation_id)
        if not conv_path.exists():
            return []

        return [f.name for f in conv_path.iterdir()
                if f.is_file() and f.suffix == '.json' and f.name != 'metadata.json']

    # =========================================================================
    # Conversation CRUD
    # =========================================================================

    def get_workspace_path(self, conversation_id: str) -> str:
        """Get the workspace path for an agent conversation."""
        return str(self._get_conversation_path(conversation_id) / "workspace")

    async def create_conversation(
        self,
        title: str = "New Conversation",
        model: Optional[str] = None,
        system_prompt: Optional[str] = None,
        is_agent: bool = False
    ) -> Dict[str, Any]:
        """Create a new conversation."""
        conversation_id = str(uuid.uuid4())
        now = datetime.utcnow().isoformat()

        # Create metadata
        metadata = {
            "id": conversation_id,
            "title": title,
            "model": model,
            "system_prompt": system_prompt,
            "is_agent": is_agent,
            "created_at": now,
            "updated_at": now,
            "current_branch": [0]  # Track current branch for the conversation
        }

        # Create conversation folder
        conv_path = self._get_conversation_path(conversation_id)
        conv_path.mkdir(parents=True, exist_ok=True)

        # Create workspace for agent conversations
        if is_agent:
            workspace_path = conv_path / "workspace"
            workspace_path.mkdir(exist_ok=True)

        # Write metadata
        await self._write_json(self._get_metadata_path(conversation_id), metadata)

        # Create default branch file
        await self._write_json(
            self._get_branch_path(conversation_id, [0]),
            {"messages": []}
        )

        return {
            "id": conversation_id,
            "title": title,
            "created_at": now,
            "updated_at": now,
            "model": model,
            "system_prompt": system_prompt,
            "is_agent": is_agent,
            "messages": [],
            "current_branch": [0]
        }

    async def list_conversations(self) -> List[Dict[str, Any]]:
        """List all conversations (metadata only)."""
        conversations = []

        if not self.base_path.exists():
            return conversations

        for conv_dir in self.base_path.iterdir():
            if conv_dir.is_dir():
                metadata = await self._read_json(conv_dir / "metadata.json")
                if metadata:
                    conversations.append({
                        "id": metadata["id"],
                        "title": metadata["title"],
                        "created_at": metadata["created_at"],
                        "updated_at": metadata["updated_at"],
                        "model": metadata.get("model"),
                        "is_agent": metadata.get("is_agent", False)
                    })

        # Sort by updated_at descending
        conversations.sort(key=lambda x: x["updated_at"], reverse=True)
        return conversations

    async def get_conversation(
        self,
        conversation_id: str,
        branch: Optional[List[int]] = None
    ) -> Optional[Dict[str, Any]]:
        """Get a conversation with messages from specified branch.

        If branch is None, uses the current_branch from metadata.
        """
        metadata = await self._read_json(self._get_metadata_path(conversation_id))
        if not metadata:
            return None

        # Use provided branch or default to current_branch
        if branch is None:
            branch = metadata.get("current_branch", [0])

        # Read branch file
        branch_data = await self._read_json(self._get_branch_path(conversation_id, branch))
        messages = branch_data.get("messages", []) if branch_data else []

        # Add version info to messages
        messages_with_versions = await self._add_version_info(conversation_id, branch, messages)

        return {
            "id": metadata["id"],
            "title": metadata["title"],
            "created_at": metadata["created_at"],
            "updated_at": metadata["updated_at"],
            "model": metadata.get("model"),
            "system_prompt": metadata.get("system_prompt"),
            "is_agent": metadata.get("is_agent", False),
            "session_id": metadata.get("session_id"),  # For agent conversation resumption
            "messages": messages_with_versions,
            "current_branch": branch
        }

    async def _add_version_info(
        self,
        conversation_id: str,
        branch: List[int],
        messages: List[Dict]
    ) -> List[Dict]:
        """Add version navigation info to messages.

        For each user message, calculate:
        - current_version: which branch number at this position
        - total_versions: how many branches exist at this position (with same prefix)
        """
        result = []
        user_msg_index = 0  # Tracks which user message position we're at

        for i, msg in enumerate(messages):
            msg_copy = dict(msg)
            msg_copy["position"] = i

            # Preserve tool_results if present (for agent messages)
            if "tool_results" in msg:
                msg_copy["tool_results"] = msg["tool_results"]

            if msg["role"] == "user":
                # Get version info for this user message position
                version_info = await self.get_version_info(conversation_id, branch, user_msg_index)
                msg_copy["current_version"] = version_info["current_version"]
                msg_copy["total_versions"] = version_info["total_versions"]
                msg_copy["user_msg_index"] = user_msg_index
                user_msg_index += 1
            else:
                # Assistant messages inherit version info from preceding user message
                # They don't have their own version nav in this model
                msg_copy["current_version"] = 1
                msg_copy["total_versions"] = 1

            result.append(msg_copy)

        return result

    async def update_conversation(
        self,
        conversation_id: str,
        title: Optional[str] = None,
        model: Optional[str] = None,
        system_prompt: Optional[str] = None
    ) -> bool:
        """Update conversation metadata."""
        metadata_path = self._get_metadata_path(conversation_id)
        metadata = await self._read_json(metadata_path)
        if not metadata:
            return False

        if title is not None:
            metadata["title"] = title
        if model is not None:
            metadata["model"] = model
        if system_prompt is not None:
            metadata["system_prompt"] = system_prompt

        metadata["updated_at"] = datetime.utcnow().isoformat()
        await self._write_json(metadata_path, metadata)
        return True

    async def update_conversation_session_id(
        self,
        conversation_id: str,
        session_id: str
    ) -> bool:
        """Update the session_id for an agent conversation.

        This is used to store the Claude Agent SDK session ID for resuming
        conversations when the user switches tabs or returns later.
        """
        metadata_path = self._get_metadata_path(conversation_id)
        metadata = await self._read_json(metadata_path)
        if not metadata:
            return False

        metadata["session_id"] = session_id
        metadata["updated_at"] = datetime.utcnow().isoformat()
        await self._write_json(metadata_path, metadata)
        return True

    async def delete_conversation(self, conversation_id: str) -> bool:
        """Delete a conversation and all its files."""
        conv_path = self._get_conversation_path(conversation_id)
        if not conv_path.exists():
            return False

        import shutil
        shutil.rmtree(conv_path)
        return True

    # =========================================================================
    # Message Operations
    # =========================================================================

    async def add_message(
        self,
        conversation_id: str,
        role: str,
        content: Any,
        thinking: Optional[str] = None,
        tool_results: Optional[List[Dict]] = None,
        branch: Optional[List[int]] = None,
        streaming: bool = False
    ) -> Dict[str, Any]:
        """Add a message to a branch.

        If branch is None, uses current_branch from metadata.
        """
        metadata = await self._read_json(self._get_metadata_path(conversation_id))
        if not metadata:
            raise ValueError(f"Conversation {conversation_id} not found")

        if branch is None:
            branch = metadata.get("current_branch", [0])

        # Read current branch
        branch_path = self._get_branch_path(conversation_id, branch)
        branch_data = await self._read_json(branch_path)
        if not branch_data:
            branch_data = {"messages": []}

        # Create message
        message_id = str(uuid.uuid4())
        now = datetime.utcnow().isoformat()
        position = len(branch_data["messages"])

        message = {
            "id": message_id,
            "role": role,
            "content": content,
            "thinking": thinking,
            "created_at": now
        }

        # Add tool_results for agent messages
        if tool_results:
            message["tool_results"] = tool_results

        # Append message
        branch_data["messages"].append(message)
        await self._write_json(branch_path, branch_data)

        # Update metadata timestamp
        metadata["updated_at"] = now
        await self._write_json(self._get_metadata_path(conversation_id), metadata)

        return {
            "id": message_id,
            "conversation_id": conversation_id,
            "role": role,
            "content": content,
            "thinking": thinking,
            "tool_results": tool_results,
            "position": position,
            "version": 1,
            "total_versions": 1,
            "created_at": now,
            "streaming": streaming
        }

    async def update_message_content(
        self,
        conversation_id: str,
        message_id: str,
        content: Any,
        thinking: Optional[str] = None,
        tool_results: Optional[List[Dict]] = None,
        branch: Optional[List[int]] = None,
        streaming: bool = True
    ) -> bool:
        """Update message content (used for streaming updates)."""
        metadata = await self._read_json(self._get_metadata_path(conversation_id))
        if not metadata:
            return False

        if branch is None:
            branch = metadata.get("current_branch", [0])

        branch_path = self._get_branch_path(conversation_id, branch)
        branch_data = await self._read_json(branch_path)
        if not branch_data:
            return False

        # Find and update the message
        for msg in branch_data["messages"]:
            if msg.get("id") == message_id:
                msg["content"] = content
                if thinking is not None:
                    msg["thinking"] = thinking
                if tool_results is not None:
                    msg["tool_results"] = tool_results
                await self._write_json(branch_path, branch_data)
                return True

        return False

    async def get_messages(
        self,
        conversation_id: str,
        branch: Optional[List[int]] = None
    ) -> List[Dict[str, Any]]:
        """Get all messages for a branch."""
        conv = await self.get_conversation(conversation_id, branch)
        return conv["messages"] if conv else []

    async def get_messages_up_to(
        self,
        conversation_id: str,
        position: int,
        branch: Optional[List[int]] = None
    ) -> List[Dict[str, Any]]:
        """Get messages up to (not including) a position."""
        messages = await self.get_messages(conversation_id, branch)
        return messages[:position]

    # =========================================================================
    # Branching Operations
    # =========================================================================

    async def create_branch(
        self,
        conversation_id: str,
        current_branch: List[int],
        user_msg_index: int,
        new_content: Any
    ) -> Dict[str, Any]:
        """Create a new branch by editing a user message.

        Args:
            conversation_id: The conversation ID
            current_branch: Current branch array
            user_msg_index: Which user message (0-based) is being edited
            new_content: New content for the user message

        Returns:
            Dict with new branch info and the edited message
        """
        # Read current branch to get messages up to edit point
        branch_path = self._get_branch_path(conversation_id, current_branch)
        branch_data = await self._read_json(branch_path)
        if not branch_data:
            raise ValueError("Branch not found")

        messages = branch_data["messages"]

        # Find the position of the user message being edited
        user_count = 0
        edit_position = None
        for i, msg in enumerate(messages):
            if msg["role"] == "user":
                if user_count == user_msg_index:
                    edit_position = i
                    break
                user_count += 1

        if edit_position is None:
            raise ValueError(f"User message {user_msg_index} not found")

        # Determine new branch number at this position
        # Scan existing branches to find next available number
        existing_branches = self._list_branch_files(conversation_id)

        # Get the prefix up to but not including the edit position
        prefix = self.extend_branch_array(current_branch, user_msg_index)

        # Find all branches with this prefix and get their values at user_msg_index
        used_numbers = set()
        for filename in existing_branches:
            file_branch = self.filename_to_branch_array(filename)
            file_prefix = self.extend_branch_array(file_branch, user_msg_index)

            if file_prefix == prefix:
                # This branch shares our prefix
                extended = self.extend_branch_array(file_branch, user_msg_index + 1)
                used_numbers.add(extended[user_msg_index])

        # Find next available number
        new_branch_num = 0
        while new_branch_num in used_numbers:
            new_branch_num += 1

        # Create new branch array
        new_branch = prefix + [new_branch_num]

        # Copy messages up to edit position, then add edited message
        new_messages = []
        for i, msg in enumerate(messages):
            if i < edit_position:
                new_messages.append(dict(msg))
            elif i == edit_position:
                # Add edited user message
                message_id = str(uuid.uuid4())
                now = datetime.utcnow().isoformat()
                new_messages.append({
                    "id": message_id,
                    "role": "user",
                    "content": new_content,
                    "thinking": None,
                    "created_at": now
                })
                break

        # Write new branch file
        new_branch_path = self._get_branch_path(conversation_id, new_branch)
        await self._write_json(new_branch_path, {"messages": new_messages})

        # Update metadata to use new branch
        metadata = await self._read_json(self._get_metadata_path(conversation_id))
        metadata["current_branch"] = new_branch
        metadata["updated_at"] = datetime.utcnow().isoformat()
        await self._write_json(self._get_metadata_path(conversation_id), metadata)

        edited_msg = new_messages[-1]
        return {
            "branch": new_branch,
            "message": {
                "id": edited_msg["id"],
                "conversation_id": conversation_id,
                "role": "user",
                "content": new_content,
                "position": edit_position,
                "version": new_branch_num + 1,  # 1-indexed for display
                "total_versions": len(used_numbers) + 1,
                "created_at": edited_msg["created_at"]
            }
        }

    async def switch_branch(
        self,
        conversation_id: str,
        current_branch: List[int],
        user_msg_index: int,
        direction: int
    ) -> Optional[List[int]]:
        """Switch to adjacent branch at a user message position.

        Args:
            conversation_id: The conversation ID
            current_branch: Current branch array
            user_msg_index: Which user message position to switch at
            direction: -1 for previous, +1 for next

        Returns:
            New branch array, or None if no branch exists in that direction
        """
        # Get prefix up to the switch position
        prefix = self.extend_branch_array(current_branch, user_msg_index)
        current_extended = self.extend_branch_array(current_branch, user_msg_index + 1)
        current_value = current_extended[user_msg_index]

        # Find all branches with this prefix
        existing_branches = self._list_branch_files(conversation_id)
        branch_values = set()

        for filename in existing_branches:
            file_branch = self.filename_to_branch_array(filename)
            file_prefix = self.extend_branch_array(file_branch, user_msg_index)

            if file_prefix == prefix:
                extended = self.extend_branch_array(file_branch, user_msg_index + 1)
                branch_values.add(extended[user_msg_index])

        if not branch_values:
            return None

        # Sort values and find adjacent
        sorted_values = sorted(branch_values)
        current_idx = sorted_values.index(current_value) if current_value in sorted_values else 0

        new_idx = current_idx + direction
        if new_idx < 0:
            new_idx = len(sorted_values) - 1  # Wrap around
        elif new_idx >= len(sorted_values):
            new_idx = 0  # Wrap around

        new_value = sorted_values[new_idx]
        new_branch = prefix + [new_value]

        # Find the actual branch file that matches this (snap to lowest downstream)
        # Look for the branch file with this prefix that has the lowest numbers after
        best_match = None
        for filename in existing_branches:
            file_branch = self.filename_to_branch_array(filename)
            file_extended = self.extend_branch_array(file_branch, user_msg_index + 1)

            if file_extended[:user_msg_index + 1] == new_branch:
                if best_match is None:
                    best_match = file_branch
                else:
                    # Prefer branch with smaller values (snap to lowest)
                    if file_branch < best_match:
                        best_match = file_branch

        if best_match:
            # Update metadata
            metadata = await self._read_json(self._get_metadata_path(conversation_id))
            metadata["current_branch"] = best_match
            await self._write_json(self._get_metadata_path(conversation_id), metadata)
            return best_match

        return new_branch

    async def get_version_info(
        self,
        conversation_id: str,
        branch: List[int],
        user_msg_index: int
    ) -> Dict[str, Any]:
        """Get version info for a specific user message position.

        Returns current version number and total versions at this position
        (considering only branches with the same prefix).
        """
        # Get prefix up to this position
        prefix = self.extend_branch_array(branch, user_msg_index)
        current_extended = self.extend_branch_array(branch, user_msg_index + 1)
        current_value = current_extended[user_msg_index]

        # Find all branches with this prefix
        existing_branches = self._list_branch_files(conversation_id)
        branch_values = set()

        for filename in existing_branches:
            file_branch = self.filename_to_branch_array(filename)
            file_prefix = self.extend_branch_array(file_branch, user_msg_index)

            if file_prefix == prefix:
                extended = self.extend_branch_array(file_branch, user_msg_index + 1)
                branch_values.add(extended[user_msg_index])

        if not branch_values:
            return {
                "position": user_msg_index,
                "current_version": 1,
                "total_versions": 1,
                "versions": [0]
            }

        sorted_values = sorted(branch_values)
        current_idx = sorted_values.index(current_value) if current_value in sorted_values else 0

        return {
            "position": user_msg_index,
            "current_version": current_idx + 1,  # 1-indexed
            "total_versions": len(sorted_values),
            "versions": sorted_values
        }

    async def get_branches(self, conversation_id: str) -> List[List[int]]:
        """List all branches in a conversation."""
        branch_files = self._list_branch_files(conversation_id)
        return [self.filename_to_branch_array(f) for f in branch_files]

    # =========================================================================
    # Search and Utility
    # =========================================================================

    async def search_conversations(self, query: str) -> List[Dict[str, Any]]:
        """Search conversations by title or message content."""
        results = []
        query_lower = query.lower()

        if not self.base_path.exists():
            return results

        for conv_dir in self.base_path.iterdir():
            if not conv_dir.is_dir():
                continue

            metadata = await self._read_json(conv_dir / "metadata.json")
            if not metadata:
                continue

            # Check title
            if query_lower in metadata.get("title", "").lower():
                results.append({
                    "id": metadata["id"],
                    "title": metadata["title"],
                    "created_at": metadata["created_at"],
                    "updated_at": metadata["updated_at"],
                    "model": metadata.get("model")
                })
                continue

            # Check messages in all branches
            found = False
            for branch_file in conv_dir.iterdir():
                if branch_file.name == "metadata.json" or not branch_file.suffix == ".json":
                    continue

                branch_data = await self._read_json(branch_file)
                if not branch_data:
                    continue

                for msg in branch_data.get("messages", []):
                    content = msg.get("content", "")
                    if isinstance(content, str) and query_lower in content.lower():
                        found = True
                        break
                    elif isinstance(content, list):
                        for block in content:
                            if block.get("type") == "text" and query_lower in block.get("text", "").lower():
                                found = True
                                break

                if found:
                    break

            if found:
                results.append({
                    "id": metadata["id"],
                    "title": metadata["title"],
                    "created_at": metadata["created_at"],
                    "updated_at": metadata["updated_at"],
                    "model": metadata.get("model")
                })

        # Sort by updated_at descending
        results.sort(key=lambda x: x["updated_at"], reverse=True)
        return results

    async def duplicate_conversation(self, conversation_id: str) -> Optional[Dict[str, Any]]:
        """Duplicate a conversation with all its branches."""
        conv_path = self._get_conversation_path(conversation_id)
        if not conv_path.exists():
            return None

        new_id = str(uuid.uuid4())
        new_path = self._get_conversation_path(new_id)
        new_path.mkdir(parents=True, exist_ok=True)

        now = datetime.utcnow().isoformat()

        # Copy all files
        for src_file in conv_path.iterdir():
            if not src_file.is_file():
                continue

            data = await self._read_json(src_file)
            if not data:
                continue

            if src_file.name == "metadata.json":
                # Update metadata for new conversation
                data["id"] = new_id
                data["title"] = f"Copy of {data['title']}"
                data["created_at"] = now
                data["updated_at"] = now
                data["current_branch"] = [0]

            await self._write_json(new_path / src_file.name, data)

        # Return new conversation info
        metadata = await self._read_json(new_path / "metadata.json")
        return {
            "id": new_id,
            "title": metadata["title"],
            "created_at": now,
            "updated_at": now,
            "model": metadata.get("model"),
            "system_prompt": metadata.get("system_prompt")
        }

    # =========================================================================
    # Retry Support (Assistant message regeneration)
    # =========================================================================

    async def retry_assistant_message(
        self,
        conversation_id: str,
        branch: List[int],
        position: int,
        new_content: Any,
        thinking: Optional[str] = None
    ) -> Dict[str, Any]:
        """Regenerate an assistant message in place.

        Unlike user message edits (which create new branches), retrying an
        assistant message just replaces the assistant message and removes
        any messages after it in the current branch.
        """
        branch_path = self._get_branch_path(conversation_id, branch)
        branch_data = await self._read_json(branch_path)
        if not branch_data:
            raise ValueError("Branch not found")

        messages = branch_data["messages"]
        if position >= len(messages):
            raise ValueError(f"Position {position} out of range")

        # Truncate to position
        messages = messages[:position]

        # Add new assistant message
        message_id = str(uuid.uuid4())
        now = datetime.utcnow().isoformat()

        new_message = {
            "id": message_id,
            "role": "assistant",
            "content": new_content,
            "thinking": thinking,
            "created_at": now
        }
        messages.append(new_message)

        # Save
        branch_data["messages"] = messages
        await self._write_json(branch_path, branch_data)

        # Update metadata timestamp
        metadata = await self._read_json(self._get_metadata_path(conversation_id))
        metadata["updated_at"] = now
        await self._write_json(self._get_metadata_path(conversation_id), metadata)

        return {
            "id": message_id,
            "conversation_id": conversation_id,
            "role": "assistant",
            "content": new_content,
            "thinking": thinking,
            "position": position,
            "version": 1,
            "created_at": now
        }

    async def set_current_branch(self, conversation_id: str, branch: List[int]) -> bool:
        """Set the current branch for a conversation."""
        metadata_path = self._get_metadata_path(conversation_id)
        metadata = await self._read_json(metadata_path)
        if not metadata:
            return False

        metadata["current_branch"] = branch
        await self._write_json(metadata_path, metadata)
        return True

    async def delete_messages_from(
        self,
        conversation_id: str,
        position: int,
        branch: Optional[List[int]] = None
    ) -> bool:
        """Delete messages from a position onwards (inclusive).

        This truncates the branch file to remove all messages at and after
        the specified position. Since children are naturally part of the
        same branch file, they are automatically deleted.
        """
        print(f"[DELETE] Attempting to delete from conversation {conversation_id}, position {position}, branch {branch}")

        metadata = await self._read_json(self._get_metadata_path(conversation_id))
        if not metadata:
            print(f"[DELETE] ERROR: Metadata not found for conversation {conversation_id}")
            return False

        if branch is None:
            branch = metadata.get("current_branch", [0])

        print(f"[DELETE] Using branch: {branch}")

        branch_path = self._get_branch_path(conversation_id, branch)
        print(f"[DELETE] Branch path: {branch_path}")

        branch_data = await self._read_json(branch_path)
        if not branch_data:
            print(f"[DELETE] ERROR: Branch data not found at {branch_path}")
            return False

        # Truncate messages
        messages = branch_data.get("messages", [])
        print(f"[DELETE] Found {len(messages)} messages in branch")

        if position >= len(messages):
            print(f"[DELETE] ERROR: Position {position} >= message count {len(messages)}")
            return False  # Nothing to delete

        branch_data["messages"] = messages[:position]
        await self._write_json(branch_path, branch_data)
        print(f"[DELETE] Successfully truncated to {position} messages")

        # Update metadata timestamp
        metadata["updated_at"] = datetime.utcnow().isoformat()
        await self._write_json(self._get_metadata_path(conversation_id), metadata)

        return True

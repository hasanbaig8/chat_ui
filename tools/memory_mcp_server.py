#!/usr/bin/env python3
"""MCP stdio server for memory operations.

This server implements the Model Context Protocol (MCP) over stdio,
allowing Claude to store and retrieve information in a memory directory.
Memories are stored per-project for shared context across conversations.

Usage:
    python memory_mcp_server.py --memory-path /path/to/memories

The server reads JSON-RPC messages from stdin and writes responses to stdout.
"""

import argparse
import json
import os
import shutil
import sys
from pathlib import Path




def get_memory_tools():
    """Return the list of memory tools."""
    return [
        {
            "name": "memory_view",
            "description": "View contents of a file or directory in the memory. Use this to check what memories exist or read specific memory files.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "The path within /memories to view. Use '/memories' to list all memories, or '/memories/filename.txt' to read a specific file."
                    },
                    "view_range": {
                        "type": "array",
                        "items": {"type": "integer"},
                        "description": "Optional [start_line, end_line] to view specific lines (1-indexed)"
                    }
                },
                "required": ["path"]
            }
        },
        {
            "name": "memory_create",
            "description": "Create a new memory file. Use this to store new information that should persist across conversations.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "The path for the new file (e.g., '/memories/notes.txt')"
                    },
                    "file_text": {
                        "type": "string",
                        "description": "The content to write to the file"
                    }
                },
                "required": ["path", "file_text"]
            }
        },
        {
            "name": "memory_str_replace",
            "description": "Replace text in a memory file. Use this to update existing memories.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "The path to the file to edit"
                    },
                    "old_str": {
                        "type": "string",
                        "description": "The text to replace (must match exactly)"
                    },
                    "new_str": {
                        "type": "string",
                        "description": "The replacement text"
                    }
                },
                "required": ["path", "old_str", "new_str"]
            }
        },
        {
            "name": "memory_insert",
            "description": "Insert text at a specific line in a memory file.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "The path to the file"
                    },
                    "insert_line": {
                        "type": "integer",
                        "description": "The line number to insert at (0 for beginning, or line number)"
                    },
                    "insert_text": {
                        "type": "string",
                        "description": "The text to insert"
                    }
                },
                "required": ["path", "insert_line", "insert_text"]
            }
        },
        {
            "name": "memory_delete",
            "description": "Delete a memory file or directory.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "The path to delete"
                    }
                },
                "required": ["path"]
            }
        },
        {
            "name": "memory_rename",
            "description": "Rename or move a memory file or directory.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "old_path": {
                        "type": "string",
                        "description": "The current path"
                    },
                    "new_path": {
                        "type": "string",
                        "description": "The new path"
                    }
                },
                "required": ["old_path", "new_path"]
            }
        }
    ]


class MemoryServer:
    """MCP server for memory operations."""

    def __init__(self, memory_base_path: str):
        """Initialize with the base path for memories."""
        # Convert to absolute path and resolve
        self.memory_base_path = Path(memory_base_path).resolve()
        self.memory_base_path.mkdir(parents=True, exist_ok=True)

    def _resolve_path(self, virtual_path: str) -> Path:
        """Resolve a virtual path (/memories/...) to a real path.

        Security: Validates path is within memory directory.
        """
        # Remove /memories prefix if present
        if virtual_path.startswith("/memories"):
            relative = virtual_path[9:]  # Remove "/memories"
        else:
            relative = virtual_path

        # Remove leading slash
        if relative.startswith("/"):
            relative = relative[1:]

        # Resolve to real path
        if relative:
            real_path = (self.memory_base_path / relative).resolve()
        else:
            real_path = self.memory_base_path.resolve()

        # Security check: ensure path is within memory directory
        try:
            real_path.relative_to(self.memory_base_path)
        except ValueError:
            raise ValueError(f"Path traversal attempt detected: {virtual_path}")

        return real_path

    def _format_size(self, size: int) -> str:
        """Format file size in human-readable format."""
        if size < 1024:
            return f"{size}B"
        elif size < 1024 * 1024:
            return f"{size / 1024:.1f}K"
        else:
            return f"{size / (1024 * 1024):.1f}M"

    def view(self, path: str, view_range: list = None) -> str:
        """View a file or directory."""
        try:
            real_path = self._resolve_path(path)
        except ValueError as e:
            return str(e)

        if not real_path.exists():
            return f"The path {path} does not exist. Please provide a valid path."

        if real_path.is_dir():
            # List directory contents (up to 2 levels deep)
            lines = [f"Here're the files and directories up to 2 levels deep in {path}, excluding hidden items and node_modules:"]

            def list_dir(dir_path: Path, prefix: str, depth: int):
                if depth > 2:
                    return
                try:
                    items = sorted(dir_path.iterdir())
                    for item in items:
                        # Skip hidden files and node_modules
                        if item.name.startswith('.') or item.name == 'node_modules':
                            continue

                        if item.is_file():
                            size = self._format_size(item.stat().st_size)
                            rel_path = "/" + str(item.relative_to(self.memory_base_path.parent))
                            lines.append(f"{size}\t{rel_path}")
                        elif item.is_dir():
                            rel_path = "/" + str(item.relative_to(self.memory_base_path.parent))
                            lines.append(f"4.0K\t{rel_path}")
                            list_dir(item, prefix, depth + 1)
                except PermissionError:
                    pass

            # Add the directory itself
            rel_path = "/" + str(real_path.relative_to(self.memory_base_path.parent))
            lines.append(f"4.0K\t{rel_path}")
            list_dir(real_path, "", 1)

            return "\n".join(lines)
        else:
            # Read file contents
            try:
                with open(real_path, 'r', encoding='utf-8') as f:
                    file_lines = f.readlines()
            except UnicodeDecodeError:
                return f"Error: {path} is a binary file and cannot be displayed."

            if len(file_lines) > 999999:
                return f"File {path} exceeds maximum line limit of 999,999 lines."

            # Apply view_range if specified
            if view_range and len(view_range) == 2:
                start, end = view_range
                start = max(1, start) - 1  # Convert to 0-indexed
                end = min(len(file_lines), end)
                file_lines = file_lines[start:end]
                line_offset = start
            else:
                line_offset = 0

            # Format with line numbers (6 chars, right-aligned, tab separator)
            formatted_lines = [f"Here's the content of {path} with line numbers:"]
            for i, line in enumerate(file_lines, start=line_offset + 1):
                # Remove trailing newline for formatting
                line_content = line.rstrip('\n')
                formatted_lines.append(f"{i:6d}\t{line_content}")

            return "\n".join(formatted_lines)

    def create(self, path: str, file_text: str) -> str:
        """Create a new file."""
        try:
            real_path = self._resolve_path(path)
        except ValueError as e:
            return f"Error: {e}"

        if real_path.exists():
            return f"Error: File {path} already exists"

        # Create parent directories if needed
        real_path.parent.mkdir(parents=True, exist_ok=True)

        try:
            with open(real_path, 'w', encoding='utf-8') as f:
                f.write(file_text)
            return f"File created successfully at: {path}"
        except Exception as e:
            return f"Error creating file: {e}"

    def str_replace(self, path: str, old_str: str, new_str: str) -> str:
        """Replace text in a file."""
        try:
            real_path = self._resolve_path(path)
        except ValueError as e:
            return f"Error: {e}"

        if not real_path.exists():
            return f"Error: The path {path} does not exist. Please provide a valid path."

        if real_path.is_dir():
            return f"Error: The path {path} does not exist. Please provide a valid path."

        try:
            with open(real_path, 'r', encoding='utf-8') as f:
                content = f.read()
        except Exception as e:
            return f"Error reading file: {e}"

        # Count occurrences
        count = content.count(old_str)

        if count == 0:
            return f"No replacement was performed, old_str `{old_str}` did not appear verbatim in {path}."

        if count > 1:
            # Find line numbers of occurrences
            lines = content.split('\n')
            line_nums = []
            for i, line in enumerate(lines, 1):
                if old_str in line:
                    line_nums.append(str(i))
            return f"No replacement was performed. Multiple occurrences of old_str `{old_str}` in lines: {', '.join(line_nums)}. Please ensure it is unique"

        # Perform replacement
        new_content = content.replace(old_str, new_str, 1)

        try:
            with open(real_path, 'w', encoding='utf-8') as f:
                f.write(new_content)
        except Exception as e:
            return f"Error writing file: {e}"

        # Return success with snippet
        lines = new_content.split('\n')
        # Find the line with the replacement
        for i, line in enumerate(lines):
            if new_str in line:
                start = max(0, i - 2)
                end = min(len(lines), i + 3)
                snippet_lines = [f"{j+1:6d}\t{lines[j]}" for j in range(start, end)]
                snippet = "\n".join(snippet_lines)
                return f"The memory file has been edited.\n{snippet}"

        return "The memory file has been edited."

    def insert(self, path: str, insert_line: int, insert_text: str) -> str:
        """Insert text at a specific line."""
        try:
            real_path = self._resolve_path(path)
        except ValueError as e:
            return f"Error: {e}"

        if not real_path.exists():
            return f"Error: The path {path} does not exist"

        if real_path.is_dir():
            return f"Error: The path {path} does not exist"

        try:
            with open(real_path, 'r', encoding='utf-8') as f:
                lines = f.readlines()
        except Exception as e:
            return f"Error reading file: {e}"

        n_lines = len(lines)

        if insert_line < 0 or insert_line > n_lines:
            return f"Error: Invalid `insert_line` parameter: {insert_line}. It should be within the range of lines of the file: [0, {n_lines}]"

        # Ensure insert_text ends with newline if inserting in middle
        if not insert_text.endswith('\n') and insert_line < n_lines:
            insert_text += '\n'

        lines.insert(insert_line, insert_text)

        try:
            with open(real_path, 'w', encoding='utf-8') as f:
                f.writelines(lines)
            return f"The file {path} has been edited."
        except Exception as e:
            return f"Error writing file: {e}"

    def delete(self, path: str) -> str:
        """Delete a file or directory."""
        try:
            real_path = self._resolve_path(path)
        except ValueError as e:
            return f"Error: {e}"

        if not real_path.exists():
            return f"Error: The path {path} does not exist"

        # Prevent deleting the memories root
        if real_path.resolve() == self.memory_base_path.resolve():
            return "Error: Cannot delete the memories root directory"

        try:
            if real_path.is_file():
                real_path.unlink()
            else:
                shutil.rmtree(real_path)
            return f"Successfully deleted {path}"
        except Exception as e:
            return f"Error deleting: {e}"

    def rename(self, old_path: str, new_path: str) -> str:
        """Rename or move a file/directory."""
        try:
            real_old = self._resolve_path(old_path)
            real_new = self._resolve_path(new_path)
        except ValueError as e:
            return f"Error: {e}"

        if not real_old.exists():
            return f"Error: The path {old_path} does not exist"

        if real_new.exists():
            return f"Error: The destination {new_path} already exists"

        # Create parent directories if needed
        real_new.parent.mkdir(parents=True, exist_ok=True)

        try:
            real_old.rename(real_new)
            return f"Successfully renamed {old_path} to {new_path}"
        except Exception as e:
            return f"Error renaming: {e}"


def handle_request(server: MemoryServer, request: dict) -> dict:
    """Handle an MCP JSON-RPC request."""
    method = request.get("method", "")
    request_id = request.get("id")
    params = request.get("params", {})

    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {
                    "tools": {}
                },
                "serverInfo": {
                    "name": "memory",
                    "version": "1.0.0"
                }
            }
        }

    elif method == "notifications/initialized":
        return None

    elif method == "tools/list":
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "tools": get_memory_tools()
            }
        }

    elif method == "tools/call":
        tool_name = params.get("name", "")
        arguments = params.get("arguments", {})

        result_text = ""
        is_error = False

        try:
            if tool_name == "memory_view":
                result_text = server.view(
                    path=arguments.get("path", "/memories"),
                    view_range=arguments.get("view_range")
                )
            elif tool_name == "memory_create":
                result_text = server.create(
                    path=arguments.get("path", ""),
                    file_text=arguments.get("file_text", "")
                )
            elif tool_name == "memory_str_replace":
                result_text = server.str_replace(
                    path=arguments.get("path", ""),
                    old_str=arguments.get("old_str", ""),
                    new_str=arguments.get("new_str", "")
                )
            elif tool_name == "memory_insert":
                result_text = server.insert(
                    path=arguments.get("path", ""),
                    insert_line=arguments.get("insert_line", 0),
                    insert_text=arguments.get("insert_text", "")
                )
            elif tool_name == "memory_delete":
                result_text = server.delete(
                    path=arguments.get("path", "")
                )
            elif tool_name == "memory_rename":
                result_text = server.rename(
                    old_path=arguments.get("old_path", ""),
                    new_path=arguments.get("new_path", "")
                )
            else:
                return {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "error": {
                        "code": -32601,
                        "message": f"Unknown tool: {tool_name}"
                    }
                }

            # Check if result indicates an error
            if result_text.startswith("Error:"):
                is_error = True

        except Exception as e:
            result_text = f"Error: {str(e)}"
            is_error = True

        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "content": [{"type": "text", "text": result_text}],
                "isError": is_error
            }
        }

    else:
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {
                "code": -32601,
                "message": f"Method not found: {method}"
            }
        }


def main():
    """Main loop - read JSON-RPC messages from stdin, write responses to stdout."""
    parser = argparse.ArgumentParser(description="Memory MCP Server")
    parser.add_argument(
        "--memory-path",
        required=True,
        help="Base path for memory storage"
    )
    args = parser.parse_args()

    server = MemoryServer(args.memory_path)

    # Unbuffered output
    sys.stdout = open(sys.stdout.fileno(), mode='w', buffering=1)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            request = json.loads(line)
            response = handle_request(server, request)

            if response is not None:
                print(json.dumps(response), flush=True)

        except json.JSONDecodeError as e:
            error_response = {
                "jsonrpc": "2.0",
                "id": None,
                "error": {
                    "code": -32700,
                    "message": f"Parse error: {str(e)}"
                }
            }
            print(json.dumps(error_response), flush=True)
        except Exception as e:
            error_response = {
                "jsonrpc": "2.0",
                "id": None,
                "error": {
                    "code": -32603,
                    "message": f"Internal error: {str(e)}"
                }
            }
            print(json.dumps(error_response), flush=True)


if __name__ == "__main__":
    main()

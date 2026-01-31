#!/usr/bin/env python3
"""MCP stdio server for surfacing content to users.

This server implements the Model Context Protocol (MCP) over stdio,
allowing Claude to surface interactive HTML/markdown content to users
within chat messages. The content can include data viewers, rankers,
forms, and other interactive elements.

Usage:
    python surface_mcp_server.py --workspace-path /path/to/workspace --conversation-id abc123

The server reads JSON-RPC messages from stdin and writes responses to stdout.
"""

import argparse
import json
import os
import sys
import uuid
from pathlib import Path
from datetime import datetime


def get_surface_tools():
    """Return the list of surface tools.

    Note: We only expose surface_from_file and surface_from_script (not direct surface_content)
    because writing long HTML content inline is slow. The agent should write content to a file
    first, then surface it.
    """
    return [
        {
            "name": "workspace_read",
            "description": "Read a file from the conversation workspace. Use this to load data for display.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "filename": {
                        "type": "string",
                        "description": "The filename to read from the workspace"
                    }
                },
                "required": ["filename"]
            }
        },
        {
            "name": "workspace_write",
            "description": "Write content to a file in the conversation workspace. Use this to save data or state.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "filename": {
                        "type": "string",
                        "description": "The filename to write to the workspace"
                    },
                    "content": {
                        "type": "string",
                        "description": "The content to write"
                    }
                },
                "required": ["filename", "content"]
            }
        },
        {
            "name": "workspace_list",
            "description": "List files in the conversation workspace.",
            "inputSchema": {
                "type": "object",
                "properties": {},
                "required": []
            }
        },
        {
            "name": "surface_from_file",
            "description": """Read a file from the workspace and surface its content to the user.

WORKFLOW: Write an HTML/markdown file to workspace first, then call this tool to display it.

DESIGN SYSTEM - Use this warm color palette for consistent styling:
- Primary: #C15F3C (rust-orange), Hover: #A8523A
- Background: #F4F3EE (cream), Surface: #FFFFFF (white cards)
- Text: #1A1A1A, Secondary text: #666666
- Borders: #E0DDD4, Success: #4A9B7F, Warning: #D4A574

Example HTML structure:
```html
<style>
  body { font-family: system-ui; background: #F4F3EE; padding: 20px; }
  .card { background: #fff; border: 1px solid #E0DDD4; border-radius: 8px; padding: 20px; }
  .header { background: linear-gradient(135deg, #C15F3C, #A8523A); color: white; padding: 16px; border-radius: 8px 8px 0 0; margin: -20px -20px 20px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 12px; border-bottom: 1px solid #E0DDD4; text-align: left; }
  th { background: #F4F3EE; font-weight: 600; }
  .badge { padding: 4px 10px; border-radius: 12px; font-size: 12px; }
  .badge-success { background: #E8F5F0; color: #4A9B7F; }
</style>
<div class="card">
  <div class="header"><h2>Title</h2></div>
  <!-- content here -->
</div>
```""",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "filename": {
                        "type": "string",
                        "description": "The filename to read and surface (must be in workspace)"
                    },
                    "content_type": {
                        "type": "string",
                        "enum": ["html", "markdown"],
                        "description": "Type of content in the file"
                    },
                    "title": {
                        "type": "string",
                        "description": "Optional title for the content panel"
                    }
                },
                "required": ["filename", "content_type"]
            }
        },
        {
            "name": "surface_from_script",
            "description": """Execute a script in the workspace and surface its stdout output to the user.

WORKFLOW:
1. Write a script (Python, Node, bash) to workspace that prints HTML/markdown to stdout
2. Call this tool to execute it and surface the output

DESIGN SYSTEM - Use this warm color palette:
- Primary: #C15F3C (rust-orange), Background: #F4F3EE (cream)
- Cards: white with #E0DDD4 borders, rounded corners
- Header: gradient from #C15F3C to #A8523A with white text
- Success badges: #E8F5F0 bg with #4A9B7F text

Example Python script (viewer.py):
```python
print('''<style>
body { font-family: system-ui; background: #F4F3EE; padding: 20px; }
.card { background: #fff; border: 1px solid #E0DDD4; border-radius: 8px; padding: 20px; }
.header { background: linear-gradient(135deg, #C15F3C, #A8523A); color: white; padding: 16px; border-radius: 8px 8px 0 0; margin: -20px -20px 20px; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 12px; border-bottom: 1px solid #E0DDD4; }
th { background: #F4F3EE; }
</style>
<div class="card"><div class="header"><h2>Data</h2></div>
<table><tr><th>Name</th><th>Score</th></tr>
<tr><td>Alice</td><td>95</td></tr></table></div>''')
```""",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "script_file": {
                        "type": "string",
                        "description": "The script filename in workspace to execute"
                    },
                    "interpreter": {
                        "type": "string",
                        "description": "Interpreter to use (python3, node, bash, etc.). Default: auto-detect from extension"
                    },
                    "content_type": {
                        "type": "string",
                        "enum": ["html", "markdown"],
                        "description": "Type of content the script outputs"
                    },
                    "title": {
                        "type": "string",
                        "description": "Optional title for the content panel"
                    },
                    "args": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Optional arguments to pass to the script"
                    }
                },
                "required": ["script_file", "content_type"]
            }
        }
    ]


class SurfaceServer:
    """MCP server for surfacing content to users."""

    def __init__(self, workspace_path: str, conversation_id: str):
        """Initialize with the workspace path and conversation ID."""
        self.workspace_path = Path(workspace_path).resolve()
        self.conversation_id = conversation_id
        self.workspace_path.mkdir(parents=True, exist_ok=True)

    def _resolve_path(self, filename: str) -> Path:
        """Resolve a filename to a real path within workspace.

        Security: Validates path is within workspace directory.
        """
        # Sanitize filename
        filename = os.path.basename(filename)
        real_path = (self.workspace_path / filename).resolve()

        # Security check: ensure path is within workspace
        try:
            real_path.relative_to(self.workspace_path)
        except ValueError:
            raise ValueError(f"Path traversal attempt detected: {filename}")

        return real_path

    def surface_content(self, content: str, content_type: str, title: str = None, save_to_workspace: bool = False) -> dict:
        """Surface content to the user."""
        content_id = str(uuid.uuid4())[:8]

        result = {
            "type": "surface_content",
            "content_id": content_id,
            "content": content,
            "content_type": content_type,
            "title": title,
            "timestamp": datetime.utcnow().isoformat(),
            "conversation_id": self.conversation_id
        }

        # Optionally save to workspace
        if save_to_workspace:
            ext = ".html" if content_type == "html" else ".md"
            filename = f"surfaced_{content_id}{ext}"
            filepath = self.workspace_path / filename
            with open(filepath, 'w', encoding='utf-8') as f:
                f.write(content)
            result["saved_to"] = filename

        return result

    def workspace_read(self, filename: str) -> str:
        """Read a file from the workspace."""
        try:
            filepath = self._resolve_path(filename)
            if not filepath.exists():
                return f"Error: File '{filename}' not found in workspace"
            if filepath.is_dir():
                return f"Error: '{filename}' is a directory"
            with open(filepath, 'r', encoding='utf-8') as f:
                return f.read()
        except ValueError as e:
            return f"Error: {e}"
        except UnicodeDecodeError:
            return f"Error: '{filename}' is a binary file and cannot be read as text"
        except Exception as e:
            return f"Error reading file: {e}"

    def workspace_write(self, filename: str, content: str) -> str:
        """Write content to a file in the workspace."""
        try:
            filepath = self._resolve_path(filename)
            with open(filepath, 'w', encoding='utf-8') as f:
                f.write(content)
            return f"Successfully wrote {len(content)} characters to '{filename}'"
        except ValueError as e:
            return f"Error: {e}"
        except Exception as e:
            return f"Error writing file: {e}"

    def workspace_list(self) -> str:
        """List files in the workspace."""
        try:
            files = []
            for item in self.workspace_path.iterdir():
                if item.name.startswith('.'):
                    continue
                if item.is_file():
                    size = item.stat().st_size
                    files.append(f"{item.name} ({size} bytes)")
                elif item.is_dir():
                    files.append(f"{item.name}/ (directory)")

            if not files:
                return "Workspace is empty"
            return "Files in workspace:\n" + "\n".join(files)
        except Exception as e:
            return f"Error listing workspace: {e}"

    def surface_from_file(self, filename: str, content_type: str, title: str = None) -> dict:
        """Read a file from workspace and surface its content."""
        try:
            filepath = self._resolve_path(filename)
            if not filepath.exists():
                return {"error": f"File '{filename}' not found in workspace"}
            if filepath.is_dir():
                return {"error": f"'{filename}' is a directory"}

            with open(filepath, 'r', encoding='utf-8') as f:
                content = f.read()

            # Use surface_content to create the result
            return self.surface_content(content, content_type, title or filename)

        except ValueError as e:
            return {"error": str(e)}
        except UnicodeDecodeError:
            return {"error": f"'{filename}' is a binary file and cannot be surfaced"}
        except Exception as e:
            return {"error": f"Error reading file: {e}"}

    def surface_from_script(self, script_file: str, content_type: str, title: str = None,
                           interpreter: str = None, args: list = None) -> dict:
        """Execute a script and surface its stdout output."""
        import subprocess

        try:
            filepath = self._resolve_path(script_file)
            if not filepath.exists():
                return {"error": f"Script '{script_file}' not found in workspace"}

            # Auto-detect interpreter from extension if not provided
            if not interpreter:
                ext = filepath.suffix.lower()
                interpreter_map = {
                    '.py': 'python3',
                    '.js': 'node',
                    '.sh': 'bash',
                    '.rb': 'ruby',
                    '.pl': 'perl',
                    '.php': 'php',
                }
                interpreter = interpreter_map.get(ext)
                if not interpreter:
                    return {"error": f"Cannot auto-detect interpreter for '{ext}'. Please specify interpreter."}

            # Build command
            cmd = [interpreter, str(filepath)]
            if args:
                cmd.extend(args)

            # Execute with timeout and capture output
            try:
                result = subprocess.run(
                    cmd,
                    capture_output=True,
                    text=True,
                    timeout=30,  # 30 second timeout
                    cwd=str(self.workspace_path)
                )

                if result.returncode != 0:
                    error_msg = result.stderr or f"Script exited with code {result.returncode}"
                    return {"error": f"Script execution failed: {error_msg}"}

                content = result.stdout
                if not content.strip():
                    return {"error": "Script produced no output"}

                # Surface the output
                return self.surface_content(content, content_type, title or f"Output: {script_file}")

            except subprocess.TimeoutExpired:
                return {"error": "Script execution timed out (30s limit)"}

        except ValueError as e:
            return {"error": str(e)}
        except Exception as e:
            return {"error": f"Error executing script: {e}"}


def handle_request(server: SurfaceServer, request: dict) -> dict:
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
                    "name": "surface",
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
                "tools": get_surface_tools()
            }
        }

    elif method == "tools/call":
        tool_name = params.get("name", "")
        arguments = params.get("arguments", {})

        result_text = ""
        is_error = False
        result_data = None

        try:
            if tool_name == "workspace_read":
                result_text = server.workspace_read(
                    filename=arguments.get("filename", "")
                )
            elif tool_name == "workspace_write":
                result_text = server.workspace_write(
                    filename=arguments.get("filename", ""),
                    content=arguments.get("content", "")
                )
            elif tool_name == "workspace_list":
                result_text = server.workspace_list()
            elif tool_name == "surface_from_file":
                result_data = server.surface_from_file(
                    filename=arguments.get("filename", ""),
                    content_type=arguments.get("content_type", "markdown"),
                    title=arguments.get("title")
                )
                if "error" in result_data:
                    result_text = f"Error: {result_data['error']}"
                    is_error = True
                else:
                    result_text = json.dumps(result_data)
            elif tool_name == "surface_from_script":
                result_data = server.surface_from_script(
                    script_file=arguments.get("script_file", ""),
                    content_type=arguments.get("content_type", "markdown"),
                    title=arguments.get("title"),
                    interpreter=arguments.get("interpreter"),
                    args=arguments.get("args")
                )
                if "error" in result_data:
                    result_text = f"Error: {result_data['error']}"
                    is_error = True
                else:
                    result_text = json.dumps(result_data)
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
    parser = argparse.ArgumentParser(description="Surface Content MCP Server")
    parser.add_argument(
        "--workspace-path",
        required=True,
        help="Path to conversation workspace"
    )
    parser.add_argument(
        "--conversation-id",
        required=True,
        help="Conversation ID"
    )
    args = parser.parse_args()

    server = SurfaceServer(args.workspace_path, args.conversation_id)

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

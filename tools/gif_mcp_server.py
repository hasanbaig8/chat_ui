#!/usr/bin/env python3
"""MCP stdio server for GIF search using Giphy API.

This server implements the Model Context Protocol (MCP) over stdio,
allowing Claude to search for GIFs using the Giphy API.

Usage:
    python gif_mcp_server.py

The server reads JSON-RPC messages from stdin and writes responses to stdout.
"""

import json
import sys
import os
import urllib.request
import urllib.parse
from pathlib import Path

# Load .env from project root
env_path = Path(__file__).parent.parent / ".env"
if env_path.exists():
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                os.environ.setdefault(key.strip(), value.strip())

GIPHY_API_KEY = os.environ.get("GIPHY_API_KEY")

# Tool definition
SEARCH_GIF_TOOL = {
    "name": "search_gif",
    "description": "Search for a GIF using the Giphy API. Returns a GIF URL that will be displayed in the chat. Use this when the user asks for a GIF, reaction image, or animated image.",
    "inputSchema": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "The search query for finding a GIF (e.g., 'happy cat', 'thumbs up', 'dancing')"
            }
        },
        "required": ["query"]
    }
}


def search_giphy(query: str) -> dict:
    """Search Giphy API for a GIF."""
    if not GIPHY_API_KEY:
        return {"error": "GIPHY_API_KEY not configured"}

    base_url = "https://api.giphy.com/v1/gifs/search"
    params = urllib.parse.urlencode({
        "api_key": GIPHY_API_KEY,
        "q": query,
        "limit": 1,
        "rating": "g"
    })
    url = f"{base_url}?{params}"

    try:
        with urllib.request.urlopen(url, timeout=10) as response:
            data = json.loads(response.read().decode())

        if not data.get("data"):
            return {"error": f"No GIFs found for '{query}'"}

        gif = data["data"][0]
        return {
            "success": True,
            "title": gif.get("title", ""),
            "url": gif["images"]["original"]["url"],
        }
    except Exception as e:
        return {"error": str(e)}


def handle_request(request: dict) -> dict:
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
                    "name": "gif-search",
                    "version": "1.0.0"
                }
            }
        }

    elif method == "notifications/initialized":
        # This is a notification, no response needed
        return None

    elif method == "tools/list":
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "tools": [SEARCH_GIF_TOOL]
            }
        }

    elif method == "tools/call":
        tool_name = params.get("name", "")
        arguments = params.get("arguments", {})

        if tool_name == "search_gif":
            query = arguments.get("query", "")
            if not query:
                return {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "result": {
                        "content": [{"type": "text", "text": "Error: No search query provided"}],
                        "isError": True
                    }
                }

            result = search_giphy(query)

            if result.get("error"):
                return {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "result": {
                        "content": [{"type": "text", "text": f"Error: {result['error']}"}],
                        "isError": True
                    }
                }

            # Return the GIF info - the URL will be auto-embedded by the frontend
            response_text = f"""Found a GIF for "{query}":

**{result['title']}**

{result['url']}"""

            return {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "content": [{"type": "text", "text": response_text}]
                }
            }
        else:
            return {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {
                    "code": -32601,
                    "message": f"Unknown tool: {tool_name}"
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
    # Unbuffered output
    sys.stdout = open(sys.stdout.fileno(), mode='w', buffering=1)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            request = json.loads(line)
            response = handle_request(request)

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

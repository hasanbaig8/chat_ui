#!/usr/bin/env python3
"""GIF search tool using Giphy API.

Usage:
    python gif_search.py "search query"

Returns:
    JSON with GIF URL that can be displayed in the chat UI.

The output format is designed to be parsed by the chat frontend
to display the GIF inline.
"""

import os
import sys
import json
import urllib.request
import urllib.parse
from pathlib import Path

# Load .env file from project root
env_path = Path(__file__).parent.parent / ".env"
if env_path.exists():
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                os.environ.setdefault(key.strip(), value.strip())

GIPHY_API_KEY = os.environ.get("GIPHY_API_KEY")

def search_gif(query: str, limit: int = 1) -> dict:
    """Search for a GIF on Giphy.

    Args:
        query: Search query string
        limit: Number of results to return (default 1)

    Returns:
        Dictionary with GIF information including URL
    """
    if not GIPHY_API_KEY:
        return {"error": "GIPHY_API_KEY not set in environment"}

    # Build API URL
    base_url = "https://api.giphy.com/v1/gifs/search"
    params = urllib.parse.urlencode({
        "api_key": GIPHY_API_KEY,
        "q": query,
        "limit": limit,
        "rating": "g"
    })
    url = f"{base_url}?{params}"

    try:
        with urllib.request.urlopen(url, timeout=10) as response:
            data = json.loads(response.read().decode())

        if not data.get("data"):
            return {"error": f"No GIFs found for '{query}'"}

        gif = data["data"][0]

        # Return the GIF info in a format the frontend can use
        return {
            "type": "gif",
            "url": gif["images"]["original"]["url"],
            "title": gif.get("title", ""),
            "preview_url": gif["images"]["fixed_height"]["url"],
            "width": gif["images"]["original"]["width"],
            "height": gif["images"]["original"]["height"]
        }

    except urllib.error.URLError as e:
        return {"error": f"Failed to fetch from Giphy: {str(e)}"}
    except json.JSONDecodeError as e:
        return {"error": f"Failed to parse Giphy response: {str(e)}"}
    except Exception as e:
        return {"error": f"Unexpected error: {str(e)}"}


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: gif_search.py 'search query'"}))
        sys.exit(1)

    query = " ".join(sys.argv[1:])
    result = search_gif(query)

    # Output as JSON for easy parsing
    print(json.dumps(result, indent=2))

    if "error" in result:
        sys.exit(1)


if __name__ == "__main__":
    main()

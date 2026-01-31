#!/usr/bin/env python3
"""
Script to concatenate all source code files into a single markdown file
with explanations for code review by another LLM.
"""

import os
from pathlib import Path

# File descriptions based on their purpose
FILE_DESCRIPTIONS = {
    # Main application
    "app.py": "Main Flask application entry point - defines routes and initializes the web server",
    "config.py": "Configuration settings for the application (API keys, paths, etc.)",

    # API routes
    "api/__init__.py": "API module initialization - registers blueprints",
    "api/agent_chat.py": "API endpoints for Claude agent-based chat functionality using the Agent SDK",
    "api/chat.py": "API endpoints for standard chat functionality with Anthropic API",
    "api/conversations.py": "API endpoints for conversation management (CRUD operations)",
    "api/docs.py": "API endpoints for documentation-related features",
    "api/files.py": "API endpoints for file operations (upload, browse, etc.)",
    "api/projects.py": "API endpoints for project management",
    "api/settings.py": "API endpoints for application settings",

    # Services
    "services/__init__.py": "Services module initialization",
    "services/agent_client.py": "Client wrapper for Claude Agent SDK interactions",
    "services/anthropic_client.py": "Client wrapper for direct Anthropic API calls",
    "services/conversation_store.py": "Abstract interface for conversation storage",
    "services/file_conversation_store.py": "File-based implementation of conversation storage",
    "services/file_processor.py": "Service for processing uploaded files (images, PDFs, etc.)",
    "services/project_store.py": "Service for managing project data and settings",

    # Frontend JavaScript
    "static/js/app.js": "Main frontend application - initializes UI components and event handlers",
    "static/js/background-streams.js": "Handles background streaming for agent tasks",
    "static/js/chat.js": "Chat UI functionality - message rendering, sending, streaming responses",
    "static/js/conversations.js": "Conversation list management in the sidebar",
    "static/js/default-settings.js": "Default configuration values for the frontend",
    "static/js/files.js": "File attachment and upload handling in the UI",
    "static/js/folder-browser.js": "Folder/directory browser component for file selection",
    "static/js/project-settings.js": "Project-specific settings UI",
    "static/js/projects.js": "Project management UI (create, switch, delete projects)",
    "static/js/prompts.js": "System prompt management and templates",
    "static/js/quick-agent-settings.js": "Quick access settings panel for agent configuration",
    "static/js/settings.js": "Main settings panel functionality",
    "static/js/workspace.js": "Workspace file management for surfaced content",

    # Frontend CSS and HTML
    "static/css/main.css": "Main stylesheet - all CSS styles for the application",
    "templates/index.html": "Main HTML template - the single-page application structure",

    # MCP Tools (Model Context Protocol servers)
    "tools/gif_mcp_server.py": "MCP server for GIF search functionality via Giphy API",
    "tools/gif_search.py": "GIF search helper functions",
    "tools/memory_mcp_server.py": "MCP server for persistent memory storage across conversations",
    "tools/surface_mcp_server.py": "MCP server for surfacing content (HTML/markdown) to the user",

}

# Category order for organized output
CATEGORIES = [
    ("Core Application", ["app.py", "config.py"]),
    ("API Routes", ["api/"]),
    ("Services", ["services/"]),
    ("MCP Tool Servers", ["tools/"]),
    ("Frontend JavaScript", ["static/js/"]),
    ("Frontend Styles", ["static/css/"]),
    ("HTML Templates", ["templates/"]),
]

def get_language(filepath: str) -> str:
    """Get markdown code block language from file extension."""
    ext = Path(filepath).suffix.lower()
    return {
        ".py": "python",
        ".js": "javascript",
        ".html": "html",
        ".css": "css",
        ".json": "json",
    }.get(ext, "")

def get_description(filepath: str) -> str:
    """Get description for a file."""
    # Normalize path
    normalized = filepath.lstrip("./")

    if normalized in FILE_DESCRIPTIONS:
        return FILE_DESCRIPTIONS[normalized]

    # Fallback for unknown files
    return f"Source file: {normalized}"

def categorize_file(filepath: str) -> str:
    """Determine which category a file belongs to."""
    normalized = filepath.lstrip("./")

    for category_name, patterns in CATEGORIES:
        for pattern in patterns:
            if normalized.startswith(pattern) or normalized == pattern:
                return category_name

    return "Other"

def main():
    # Get all source files
    source_files = []

    for root, dirs, files in os.walk("."):
        # Skip unwanted directories
        dirs[:] = [d for d in dirs if d not in [".venv", "__pycache__", ".git", "data", "node_modules"]]

        for file in files:
            if file.endswith((".py", ".js", ".html", ".css")):
                # Skip test files
                if file.startswith("test_"):
                    continue
                filepath = os.path.join(root, file)
                source_files.append(filepath)

    # Sort files by category
    categorized = {}
    for filepath in source_files:
        category = categorize_file(filepath)
        if category not in categorized:
            categorized[category] = []
        categorized[category].append(filepath)

    # Sort files within each category
    for category in categorized:
        categorized[category].sort()

    # Generate markdown
    output = []
    output.append("# Complete Codebase for Review\n")
    output.append("This document contains all source code files from the chat-ui application.\n")
    output.append("It is a Flask-based web application that provides a chat interface for Claude AI,")
    output.append("with support for the Claude Agent SDK, MCP tools, file attachments, and more.\n")
    output.append("## Table of Contents\n")

    # Generate TOC
    for category_name, _ in CATEGORIES:
        if category_name in categorized:
            output.append(f"- [{category_name}](#{category_name.lower().replace(' ', '-')})")
    output.append("\n---\n")

    # Generate content for each category
    for category_name, _ in CATEGORIES:
        if category_name not in categorized:
            continue

        output.append(f"## {category_name}\n")

        for filepath in categorized[category_name]:
            normalized = filepath.lstrip("./")
            description = get_description(filepath)
            language = get_language(filepath)

            output.append(f"### `{normalized}`\n")
            output.append(f"**Purpose:** {description}\n")

            try:
                with open(filepath, "r", encoding="utf-8") as f:
                    content = f.read()
                output.append(f"```{language}")
                output.append(content)
                output.append("```\n")
            except Exception as e:
                output.append(f"*Error reading file: {e}*\n")

            output.append("---\n")

    # Write output file
    with open("concatenated.md", "w", encoding="utf-8") as f:
        f.write("\n".join(output))

    print(f"Generated concatenated.md with {len(source_files)} files")
    print(f"File size: {os.path.getsize('concatenated.md') / 1024:.1f} KB")

if __name__ == "__main__":
    main()

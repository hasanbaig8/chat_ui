# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude Chat UI is a full-stack web chat interface for Anthropic's Claude AI models. It features real-time streaming responses, conversation branching (edit/retry with version navigation), extended thinking support, file attachments, and persistent SQLite storage.

**Tech Stack:** FastAPI (Python) backend + Vanilla JavaScript frontend + SQLite database

## Development Commands

```bash
# Setup
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env  # Add ANTHROPIC_API_KEY

# Run development server (auto-reload)
python app.py
# or: uvicorn app:app --reload --host 0.0.0.0 --port 8080

# Access at http://localhost:8080
```

No build step required for frontend (vanilla JS with CDN dependencies).

## Architecture

```
Frontend (Vanilla JS)  →  FastAPI REST API  →  Services Layer  →  SQLite
     ↓                         ↓                    ↓
 static/js/            api/*.py routes      services/*.py
 - chat.js             - /api/chat/stream   - anthropic_client.py (streaming)
 - conversations.js    - /api/conversations - conversation_store.py (persistence)
 - files.js            - /api/files         - file_processor.py (validation)
 - settings.js
 - prompts.js
```

**Key Flow:** User input → ChatManager.sendMessage() → POST /api/chat/stream (SSE) → AnthropicClient.stream_message() → Anthropic API → Stream events back → Real-time rendering

## Key Files

- **app.py** - FastAPI entry point, mounts routers, lifespan management
- **config.py** - Model definitions (with thinking support flags), token limits, file size limits
- **static/js/chat.js** - Core chat logic: streaming, branching, markdown rendering, version navigation
- **services/anthropic_client.py** - Async Anthropic API wrapper with extended thinking support
- **services/conversation_store.py** - SQLite CRUD with message branching (multiple versions per position)

## Conversation Branching Model

Messages have `position` (order) and `version` (branch) fields. Editing a user message or retrying a response creates a new version at that position. The `active_versions` JSON in conversations tracks which version is displayed at each position.

## API Patterns

- Streaming uses Server-Sent Events (SSE) with event types: `thinking`, `text`, `error`, `done`
- All database operations use async/await (aiosqlite)
- File uploads convert to Anthropic API content blocks (base64 images, PDF support)

## Configuration (config.py)

Models are defined with `supports_thinking` flag - temperature is automatically omitted when thinking is enabled (API requirement). Default model: `claude-sonnet-4-5-20250929`.

## Testing

```bash
# Install test dependencies
pip install playwright
playwright install chromium

# Run UI tests (headless, takes screenshots)
python test_ui.py

# Run with visible browser
python test_ui.py --headed
```

The test script starts the server, opens the UI in a browser, and captures screenshots of various states (settings, file browser, dark mode, mobile view, etc.) to `screenshots/`.

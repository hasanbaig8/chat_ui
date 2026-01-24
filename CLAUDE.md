# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Note:** This project was completed as part of the Anthropic Fellowship.

## Project Overview

Claude Chat UI is a full-stack web chat interface for Anthropic's Claude AI models. It features real-time streaming responses, conversation branching (edit/retry with version navigation), extended thinking support, file attachments, and dual storage backends (SQLite for regular chats, file-based JSON for agent conversations).

**Tech Stack:** FastAPI (Python) backend + Vanilla JavaScript frontend + SQLite/JSON storage

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

## Testing

```bash
pip install playwright && playwright install chromium
python test_ui.py          # Headless, saves screenshots to screenshots/
python test_ui.py --headed # Visible browser
```

## Architecture

```
Frontend (Vanilla JS)  →  FastAPI REST API  →  Services Layer  →  Storage
     ↓                         ↓                    ↓              ↓
 static/js/            api/*.py routes      services/*.py     SQLite (regular)
 - chat.js             - /api/chat/stream   - anthropic_client.py   JSON files (agent)
 - conversations.js    - /api/conversations - conversation_store.py
 - files.js            - /api/files         - file_conversation_store.py
 - settings.js         - /api/agent-chat    - file_processor.py
 - workspace.js                             - agent_client.py
 - background-streams.js
 - prompts.js
```

**Key Flow:** User input → ChatManager.sendMessage() → POST /api/chat/stream (SSE) → AnthropicClient.stream_message() → Anthropic API → Stream events back → Real-time rendering

## Key Files

- **app.py** - FastAPI entry point, mounts routers, lifespan management
- **config.py** - Model definitions (with `supports_thinking` flag), token limits, file size limits
- **static/js/chat.js** - Core chat logic (~2400 lines): streaming, branching, markdown rendering, version navigation
- **services/anthropic_client.py** - Async Anthropic API wrapper with extended thinking support
- **services/conversation_store.py** - SQLite CRUD with message branching (regular conversations)
- **services/file_conversation_store.py** - File-based JSON storage with branching (agent conversations)
- **api/agent_chat.py** - Agent SDK streaming endpoints with workspace management
- **services/agent_client.py** - Agent SDK wrapper for tool-enabled conversations

## Dual Storage Backends

**SQLite** (`services/conversation_store.py`) - For regular conversations:
- Messages have `position` (order) and `version` (branch) fields
- `active_versions` JSON in conversations tracks which version is displayed at each position
- Uses `parent_message_id` to track branching chains

**File-based JSON** (`services/file_conversation_store.py`) - For agent conversations:
- Each conversation is a folder: `data/conversations/{id}/`
- `metadata.json` contains title, model, system_prompt, session_id (for agent resumption)
- Branch files: `0.json`, `1.json`, `0_1.json` (trailing zeros omitted)
- `workspace/` subfolder stores files created by the agent

## Conversation Branching Model

Editing a user message creates a new branch (version). Both storage backends support navigation between versions using `◀ ▶` buttons. The branch array (e.g., `[0, 1, 0]`) encodes version choices at each user message position.

## SSE Streaming Events

Event types: `thinking`, `text`, `error`, `done`, `message_id`, `tool_use`, `tool_result` (agent mode)

## Configuration (config.py)

Models with `supports_thinking=True` automatically omit temperature (API requirement). Default model: `claude-sonnet-4-5-20250929`. Thinking budget range: 1K-128K tokens (default 10K).

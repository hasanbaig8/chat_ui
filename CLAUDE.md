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

# Run development server (port 8079)
python app.py

# Run with mock LLM (no API calls, deterministic responses)
MOCK_LLM=1 python app.py

# Access at http://localhost:8079
# Dev UI fixtures at http://localhost:8079/dev/ui
```

No build step required for frontend (vanilla JS with CDN dependencies).

## Testing

```bash
# Install test dependencies
uv pip install pytest pytest-asyncio
npm install

# Backend unit tests (61 tests)
pytest tests/backend/ -v

# E2E tests with Playwright
npm run test:e2e

# Visual regression tests
npm run test:visual

# All tests in mock mode (recommended for CI)
MOCK_LLM=1 npm run test:all

# Legacy UI test
python test_ui.py --headed
```

See `TESTING.md` for comprehensive testing documentation.

## Mock Mode (MOCK_LLM=1)

When `MOCK_LLM=1` is set, the app uses deterministic mock streams instead of calling the Anthropic API:

- **No API costs** - Works without ANTHROPIC_API_KEY
- **Deterministic** - Same output every time for testing
- **Fast** - Minimal delays between stream events
- **Offline** - No internet required

Mock mode affects:
- `/api/chat/stream` - Returns mock text/thinking/web_search events
- `/api/agent-chat/stream` - Returns mock tool_use/tool_result/surface_content events

Check mock status: `GET /dev/status`

## Architecture

```
Frontend (Vanilla JS)     →    FastAPI REST API    →    Services Layer    →    Storage
        ↓                            ↓                        ↓                  ↓
static/js/                   api/*.py routes          services/*.py         SQLite (regular)
├── core/                    - /api/chat/stream       - anthropic_client    JSON files (agent)
│   ├── store.js            - /api/conversations     - file_conversation_store
│   ├── apiClient.js        - /api/agent-chat        - streaming_service
│   └── sseClient.js        - /api/files             - settings_service
├── chat/                    - /dev/ui               - content_normalizer
│   ├── ChatController.js                            - mock_streams
│   └── ChatRenderer.js
├── chat.js (legacy)
├── conversations.js
├── background-streams.js
└── settings.js
```

### Frontend Module Responsibilities

| Module | Purpose |
|--------|---------|
| `store.js` | Single source of truth for app state, reactive subscriptions |
| `apiClient.js` | All fetch() calls centralized, error handling |
| `sseClient.js` | SSE stream processing with race condition protection (stream tokens) |
| `ChatController.js` | Orchestrates chat operations, no DOM touching |
| `ChatRenderer.js` | Pure DOM manipulation, no API calls |
| `background-streams.js` | StreamingTracker for conversation list indicators |
| `chat.js` | Legacy monolith (~3000 lines), gradually migrating to above modules |

### Backend Service Responsibilities

| Service | Purpose |
|---------|---------|
| `streaming_service.py` | Unified registry for normal + agent streams, stop signal handling |
| `settings_service.py` | Resolves settings: defaults → project → conversation |
| `content_normalizer.py` | Normalizes message content shapes for storage |
| `mock_streams.py` | Deterministic stream generators for testing |
| `file_conversation_store.py` | File-based JSON storage with branching |

### Dependency Injection (`api/deps.py`)

All services use singleton DI pattern:
```python
from api.deps import get_store, get_anthropic_client, get_streaming_service

# In route handlers:
store = get_store()
client = get_anthropic_client()
```

Services are initialized once in `app.py` lifespan handler.

## Key Files

- **app.py** - FastAPI entry point, mounts routers, lifespan management
- **api/deps.py** - Dependency injection for all services (singletons)
- **config.py** - Model definitions (with `supports_thinking` flag), token limits
- **static/js/core/store.js** - Reactive state management with subscriptions
- **static/js/chat/ChatController.js** - Chat orchestration with stream token race protection
- **services/streaming_service.py** - Unified streaming registry (normal + agent)
- **services/mock_streams.py** - Deterministic mock streams for testing

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

**Normal Chat:**
- `message_id` - Message tracking
- `thinking` - Extended thinking content (if enabled)
- `web_search_start`, `web_search_query`, `web_search_result` - Web search (if enabled)
- `text` - Response text chunks
- `error` - Error message
- `done` - Stream complete

**Agent Chat:**
- `message_id`, `session_id` - Tracking
- `text` - Response chunks
- `tool_use` - Tool invocation (id, name, input)
- `tool_result` - Tool output (tool_use_id, content, is_error)
- `surface_content` - Rich content blocks
- `stopped` - User-initiated stop
- `done` - Stream complete

## Race Condition Protection

Stream tokens prevent stale updates when switching conversations during streaming:

```javascript
// ChatController.js
const streamToken = Store.startStreaming();
// ...
onEvent: (event) => {
    if (Store.get('currentConversationId') !== conversationId) return;
    // Safe to update UI
}
```

## Configuration (config.py)

Models with `supports_thinking=True` automatically omit temperature (API requirement). Default model: `claude-sonnet-4-5-20250929`. Thinking budget range: 1K-128K tokens (default 10K).

## Dev UI Fixture Harness

Visit `/dev/ui` for:
- Visual fixtures of all message states (user, assistant, streaming, tool use, etc.)
- Stream testing buttons (normal, with thinking, with web search, agent)
- Screenshot targets for visual regression testing

## Surface Content Tool

Agent conversations have access to the `surface_content` MCP tool for displaying rich HTML/markdown content to users. The content appears as an expandable artifact in the chat that persists across page reloads.

**Available Tools:**
- `surface_content` - Surface HTML/markdown content directly
- `surface_from_file` - Read a file from workspace and surface it
- `surface_from_script` - Execute a script and surface its stdout

**IMPORTANT:** When creating HTML content to surface, use the `/surface-ui` skill which provides the design system matching this chat interface's warm color palette (rust-orange #C15F3C, cream #F4F3EE, etc.).

## Skills

This project includes custom skills in `.claude/skills/`:

- **surface-ui** - Design system for creating HTML surfaces that match the chat UI aesthetic. Auto-invokes when creating data viewers, dashboards, tables, or any HTML content for the user.

## Test Files Structure

```
tests/
├── backend/                    # Python unit tests (pytest)
│   ├── test_content_normalizer.py
│   ├── test_mock_streams.py
│   ├── test_settings_service.py
│   └── test_streaming_service.py
├── e2e/                        # Playwright E2E tests
│   ├── chat.spec.ts
│   └── streaming.spec.ts
├── visual/                     # Visual regression tests
│   └── fixtures.spec.ts
└── conftest.py                 # Pytest fixtures
```

## Common Tasks

**Add a new SSE event type:**
1. Add to `services/mock_streams.py` mock generators
2. Handle in `api/chat.py` or `api/agent_chat.py` event accumulation
3. Handle in `static/js/chat/ChatController.js` switch statement
4. Render in `static/js/chat/ChatRenderer.js`
5. Add fixture to `templates/dev_ui.html`
6. Add test to `tests/backend/test_mock_streams.py`

**Add a new service:**
1. Create `services/new_service.py` with singleton pattern
2. Add to `api/deps.py` with `get_new_service()` function
3. Initialize in `deps.initialize_all()`
4. Add tests to `tests/backend/test_new_service.py`

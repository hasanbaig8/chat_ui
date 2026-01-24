# Claude Chat UI - User Guide & Capabilities

## Overview

Claude Chat UI is a full-featured web interface for Claude AI models with support for:
- Real-time streaming responses with extended thinking
- Conversation branching (edit/retry with version navigation)
- Project-based organization with persistent memory
- Agent mode with file workspace and tool usage
- Dual storage backends (SQLite for regular chats, JSON for agent chats)

---

## Getting Started

### Basic Chat
1. Click **"+ New Chat"** to start a regular conversation
2. Type your message and press Enter or click Send
3. Responses stream in real-time with optional extended thinking

### Agent Chat
1. Click **"Agent Chat"** button (with favicon icon)
2. Agent can read/write files, execute bash commands, and search for GIFs
3. Access workspace files via the 📁 button
4. Use slash commands: `/ls` (list files), `/delete <filename>`

---

## Core Features

### 1. Conversation Management

#### Creating Conversations
- **New Chat**: Standard Claude conversation
- **Agent Chat**: Tool-enabled conversation with file workspace
- Both support all Claude models and extended thinking

#### Conversation List
- Shows all conversations sorted by recency
- **Search**: Filter by title or content (top of sidebar)
- **Actions**: Duplicate (📋), Rename (✏️), Delete (🗑️)
- **Visual indicators**:
  - Blue left border = Agent conversation
  - Streaming dot = Response in progress

#### Editing & Branching
- **Edit user message**: Click ✏️ or double-click message
- **Retry assistant response**: Click 🔄
- **Navigate versions**: Use ◀ ▶ when multiple versions exist
- Each edit creates a new branch you can navigate between

### 2. Projects System 📁

Projects organize related conversations with shared settings and memory.

#### Creating Projects
1. Open Projects panel (folder icon in header)
2. Click "Create New Project"
3. Set name, color, and custom settings

#### Project Features
- **Conversations**: Assign chats to projects via drag-and-drop or right-click menu
- **Settings**: Override defaults per-project (model, temperature, system prompt)
- **Memory**: Persistent memory across all conversations in a project (agent mode only)
- **Colors**: Visual coding for easy identification

#### Using Project Memory (Agent Mode)
Agent conversations in projects can:
- Store information to `/memories` directory
- Access memories from other conversations in same project
- Tools: `memory_view`, `memory_create`, `memory_update`, `memory_delete`

### 3. Settings ⚙️

#### Default Settings (Global)
- **Model**: Select Claude model (Sonnet, Opus, Haiku)
- **Temperature**: Randomness (0.0-1.0)
- **Max Tokens**: Response length limit
- **Top P / Top K**: Sampling parameters
- **Extended Thinking**: Enable and set token budget (1K-128K)
- **System Prompt**: Default behavior instructions

#### Project Settings (Override)
- Same options as default settings
- Only apply when a project conversation is active
- Can be set per-project via Projects panel → Settings tab

### 4. Agent Chat & Workspace

#### Workspace
- Private file directory for each agent conversation
- View files: Click 📁 button (top-right)
- **Upload files**: Drag & drop into workspace panel
- **Tag files**: Click @ button to insert `@filename` in message
- **Delete files**: Click 🗑️ button

#### Agent Tools
- **Read**: Read files from workspace
- **Write**: Create or modify files
- **Bash**: Execute shell commands
- **Grep**: Search file contents
- **Glob**: Find files by pattern
- **GIF Search**: Find relevant GIFs via Giphy API

#### Slash Commands (Agent Chat Only)
- `/ls` - List workspace files
- `/delete <filename>` - Delete a file from workspace

### 5. File Attachments

#### Supported Files
- **Images**: PNG, JPG, JPEG, GIF, WebP (up to 5MB)
- **Documents**: PDF (up to 10MB)
- **Text files**: Sent as text content

#### Attaching Files
1. Click 📎 button next to message input
2. Select file(s) from file browser
3. Preview appears above input
4. Click X to remove before sending

### 6. Prompt Library

Pre-saved prompts for quick access.

#### Using Prompts
1. Open Settings panel
2. Go to "Prompt Library" tab
3. Click prompt to insert into message input
4. Or click "Insert" in modal view

#### Managing Prompts
- **Add**: Click "+ Add Prompt"
- **Edit**: Click prompt → Edit
- **Delete**: Click prompt → Delete
- **Search**: Filter by name or content

---

## Advanced Features

### Extended Thinking
When enabled, Claude can think deeply about complex problems before responding.

- **Enable**: Toggle in Settings → Extended Thinking
- **Budget**: Set thinking token limit (1K-128K)
- **View**: Thinking appears in collapsible section
- **Models**: Only works with thinking-enabled models (Sonnet 3.7+, Opus 4+)

### Conversation Branching
Every edit creates a version you can navigate:

```
User: "What's 2+2?"
├─ Assistant v1: "4"
└─ Assistant v2: "The answer is 4" [after retry]
```

- **Navigate**: Use ◀ ▶ buttons
- **Version indicator**: Shows "2/3" (version 2 of 3)
- **Independent branches**: Each path has its own history

### Context Management
- **Auto-pruning**: Oldest messages removed if exceeding token limit
- **Status bar**: Shows token usage (bottom of screen)
- **Strategy**: Keeps recent messages + important context

### Streaming Behavior
- Messages save to database periodically during streaming
- Click away and back during streaming - message persists
- Visual indicators show active streams
- Abort button (X) stops current generation

---

## Project Structure (Technical)

### Storage
- **Regular conversations**: SQLite database (`data/conversations.db`)
- **Agent conversations**: JSON files (`data/conversations/{id}/`)
- **Projects**: SQLite database (`data/projects.db`)
- **Workspace**: Files in `data/conversations/{id}/workspace/`
- **Memory**: Project-specific (`data/memories/{project_id}/`)

### Architecture
```
Frontend (Vanilla JS) → FastAPI REST API → Services → Storage
- chat.js             - /api/chat          - anthropic_client.py   - SQLite
- projects.js         - /api/projects      - conversation_store.py  - JSON files
- workspace.js        - /api/agent-chat    - agent_client.py
```

### API Endpoints

#### Chat
- `POST /api/chat/stream` - Stream chat response (SSE)
- `GET /api/chat/streaming/{id}` - Check if conversation is streaming
- `GET /api/chat/models` - List available models

#### Conversations
- `GET /api/conversations` - List all conversations
- `GET /api/conversations/{id}` - Get conversation with messages
- `POST /api/conversations` - Create new conversation
- `PUT /api/conversations/{id}` - Update title/settings
- `DELETE /api/conversations/{id}` - Delete conversation
- `POST /api/conversations/{id}/messages` - Add message
- `POST /api/conversations/{id}/edit` - Edit message (create branch)
- `POST /api/conversations/{id}/retry` - Retry assistant message
- `DELETE /api/conversations/{id}/delete-from/{position}` - Delete from position

#### Projects
- `GET /api/projects` - List all projects
- `GET /api/projects/{id}` - Get project details
- `POST /api/projects` - Create project
- `PUT /api/projects/{id}` - Update project
- `DELETE /api/projects/{id}` - Delete project
- `POST /api/projects/{id}/conversations` - Add conversation to project
- `DELETE /api/projects/{id}/conversations/{conv_id}` - Remove from project

#### Agent Workspace
- `GET /api/agent-chat/workspace/{id}` - List workspace files
- `POST /api/agent-chat/workspace/{id}/upload` - Upload file (drag & drop)
- `DELETE /api/agent-chat/workspace/{id}/{filename}` - Delete file

#### Settings
- `GET /api/settings/default` - Get default settings
- `PUT /api/settings/default` - Update default settings
- `GET /api/settings/project/{id}` - Get project settings
- `PUT /api/settings/project/{id}` - Update project settings

---

## Keyboard Shortcuts

- **Enter** - Send message (Shift+Enter for new line)
- **Ctrl/Cmd + K** - Open search
- **Esc** - Close panels/modals

---

## Tips & Best Practices

### For Regular Chats
- Use extended thinking for complex reasoning tasks
- Edit messages to explore different conversation paths
- Organize related conversations into projects
- Use prompt library for frequently used instructions

### For Agent Chats
- Give agent clear file paths and instructions
- Use workspace to share files with agent
- Check workspace (📁) to see what files agent created
- Use project memory for information that should persist
- Drag & drop files directly into workspace panel

### For Projects
- Create projects for different domains (work, personal, research)
- Use project settings to customize model/temperature per domain
- Agent memory is shared across project conversations
- Color-code projects for visual organization

### Performance
- Regular chats are faster (no tool overhead)
- Agent chats are more powerful (can read/write files)
- Limit thinking budget for faster responses
- Delete old conversations to keep database lean

---

## Troubleshooting

### Messages Not Appearing
- Check if conversation is still streaming (look for dot indicator)
- Refresh the page
- Check browser console for errors

### Agent Tools Not Working
- Ensure you're in an Agent conversation (blue border in sidebar)
- Check that Claude Code SDK is installed
- Workspace must exist (automatically created)

### Project Memory Issues
- Memory only works in agent conversations
- Conversation must be assigned to a project
- Check `/memories` directory exists

### File Upload Fails
- Check file size limits (5MB images, 10MB PDFs)
- Ensure file format is supported
- Try drag & drop instead of file picker

---

## Configuration

### Environment Variables
```bash
ANTHROPIC_API_KEY=your_api_key_here
DATABASE_PATH=data/conversations.db  # Optional, default shown
PORT=8080                            # Optional, default shown
```

### Model Configuration
Edit `config.py` to:
- Add new models
- Adjust token limits
- Configure thinking support
- Set file size limits

---

## Security Notes

- Workspace files are isolated per conversation
- Path traversal protection on file operations
- API key stored in environment variables (not in database)
- No file upload to external servers (local only)
- Agent bash commands run in user context (be cautious)

---

## Known Limitations

- Agent bash commands have same permissions as server process
- No multi-user support (single-user application)
- Memory system requires MCP server to be running
- Extended thinking only works with compatible models
- File attachments limited by API constraints

---

## Getting Help

- Check browser console (F12) for JavaScript errors
- Check server logs for backend errors
- Ensure all dependencies are installed (`pip install -r requirements.txt`)
- Test with simple conversations first
- For development: See `CLAUDE.md` for technical details

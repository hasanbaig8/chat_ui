# Claude Chat UI

A modern, feature-rich chat interface for Claude AI with support for extended thinking, conversation branching, and file attachments.

![Claude Chat UI](https://img.shields.io/badge/Claude-Chat%20UI-C15F3C)
![Python](https://img.shields.io/badge/Python-3.11+-blue)
![License](https://img.shields.io/badge/License-MIT-green)

## Features

- **Streaming Responses** - Real-time streaming of Claude's responses
- **Extended Thinking** - Support for Claude's extended thinking capability with configurable token budgets
- **Conversation Branching** - Edit messages and retry responses to create conversation branches
- **Version Navigation** - Switch between different response versions using intuitive navigation
- **File Attachments** - Attach files from the server to your messages
- **Dark/Light Theme** - Toggle between dark and light modes
- **Syntax Highlighting** - Code blocks with syntax highlighting
- **Markdown Rendering** - Full markdown support in responses
- **Persistent Storage** - SQLite-based conversation storage

## Screenshots

### Chat Interface
The main chat interface with message editing and retry controls on user messages.

### Extended Thinking
Enable extended thinking mode to see Claude's reasoning process.

### Conversation Branching
Create branches by editing messages or regenerating responses, then navigate between versions.

## Quick Start

### Prerequisites

- Python 3.11+
- An Anthropic API key

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/yourusername/claude-chat-ui.git
   cd claude-chat-ui
   ```

2. **Create a virtual environment**
   ```bash
   python -m venv .venv
   source .venv/bin/activate  # On Windows: .venv\Scripts\activate
   ```

3. **Install dependencies**
   ```bash
   pip install -r requirements.txt
   ```

4. **Configure environment**
   ```bash
   cp .env.example .env
   # Edit .env and add your Anthropic API key
   ```

5. **Run the application**
   ```bash
   python app.py
   ```

6. **Open in browser**
   ```
   http://localhost:8080
   ```

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Your Anthropic API key |

### Settings Panel

Access the settings panel by clicking the gear icon (⚙️) in the top right:

- **Model** - Select the Claude model to use
- **Extended Thinking** - Enable/disable extended thinking mode
- **Thinking Budget** - Set the token budget for extended thinking (1K-128K)
- **Max Tokens** - Maximum tokens for the response
- **Temperature** - Control response randomness (disabled when thinking is enabled)
- **System Prompt** - Set a custom system prompt

## Usage

### Sending Messages

1. Type your message in the input field
2. Press Enter or click Send
3. Watch the response stream in real-time

### Editing Messages

1. Hover over a user message (orange)
2. Click the pencil icon (✏️)
3. Edit the text in the inline editor
4. Press Ctrl+Enter to save, or Escape to cancel
5. A new response will be generated based on the edited message

### Regenerating Responses

1. Hover over a user message
2. Click the refresh icon (🔄)
3. A new response version will be generated
4. Use the arrow buttons (◀ ▶) to navigate between versions

### Attaching Files

1. Click the paperclip icon (📎) in the input area
2. Browse and select files from the server
3. Selected files will be attached to your next message

### Theme Toggle

Click the sun/moon icon (☀️/🌙) in the header to switch between light and dark modes.

## Project Structure

```
claude-chat-ui/
├── app.py                 # FastAPI application entry point
├── config.py              # Configuration management
├── requirements.txt       # Python dependencies
├── .env.example          # Example environment file
├── api/
│   ├── chat.py           # Chat streaming endpoint
│   ├── conversations.py  # Conversation CRUD endpoints
│   └── files.py          # File browser endpoints
├── services/
│   └── conversation_store.py  # SQLite conversation storage
├── static/
│   ├── css/
│   │   └── main.css      # Application styles
│   └── js/
│       ├── app.js        # Main application logic
│       ├── chat.js       # Chat and streaming logic
│       ├── conversations.js  # Conversation management
│       ├── files.js      # File browser logic
│       └── settings.js   # Settings panel logic
├── templates/
│   └── index.html        # Main HTML template
└── data/                  # SQLite database (created on first run)
```

## API Endpoints

### Chat
- `POST /api/chat/stream` - Stream a chat response

### Conversations
- `GET /api/conversations` - List all conversations
- `POST /api/conversations` - Create a new conversation
- `GET /api/conversations/{id}` - Get a conversation
- `DELETE /api/conversations/{id}` - Delete a conversation
- `POST /api/conversations/{id}/messages` - Add a message
- `POST /api/conversations/{id}/edit` - Edit a message (creates new version)
- `POST /api/conversations/{id}/retry` - Retry a response (creates new version)
- `POST /api/conversations/{id}/switch-version` - Switch to a different version

### Files
- `GET /api/files/browse` - Browse server files
- `POST /api/files/read` - Read file contents

## Development

### Running in Development Mode

```bash
uvicorn app:app --reload --host 0.0.0.0 --port 8080
```

### Code Style

The project uses standard Python and JavaScript conventions. Key patterns:

- **Backend**: FastAPI with async/await
- **Frontend**: Vanilla JavaScript with module pattern
- **Storage**: SQLite with aiosqlite for async operations

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- Built with [FastAPI](https://fastapi.tiangolo.com/)
- Powered by [Anthropic's Claude](https://www.anthropic.com/)
- Markdown rendering by [Marked.js](https://marked.js.org/)
- Syntax highlighting by [Highlight.js](https://highlightjs.org/)

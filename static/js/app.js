/**
 * Main application initialization
 */

// Track current message index for arrow navigation
let currentMessageIndex = -1; // -1 means at bottom/input

document.addEventListener('DOMContentLoaded', async () => {
    console.log('Claude Chat UI initializing...');

    try {
        // Initialize all modules
        await SettingsManager.init();
        SettingsManager.setMode('normal');  // Default to normal mode
        await DefaultSettingsManager.init();
        await ProjectSettingsManager.init();
        FilesManager.init();
        PromptLibrary.init();
        WorkspaceManager.init();
        ChatManager.init();
        await ProjectsManager.init();
        await ConversationsManager.init();

        console.log('Claude Chat UI initialized successfully');

        // Set up help chat button
        const helpChatBtn = document.getElementById('help-chat-btn');
        if (helpChatBtn) {
            helpChatBtn.addEventListener('click', () => createHelpChat());
        }

    } catch (error) {
        console.error('Failed to initialize app:', error);
        alert('Failed to initialize application. Please refresh the page.');
    }
});

/**
 * Create a special help chat with documentation and code context
 */
async function createHelpChat() {
    try {
        // Fetch the latest documentation and code
        console.log('Fetching documentation and code...');
        const [capabilitiesResponse, codeResponse] = await Promise.all([
            fetch('/api/docs/capabilities'),
            fetch('/api/docs/code')
        ]);

        if (!capabilitiesResponse.ok || !codeResponse.ok) {
            throw new Error('Failed to fetch documentation');
        }

        const capabilities = await capabilitiesResponse.text();
        const code = await codeResponse.text();

        // Create a new conversation with helpful title and system prompt
        const systemPrompt = `You are a helpful assistant for the Claude Chat UI application.

The user's first message contains the COMPLETE and UP-TO-DATE documentation (CAPABILITIES.md) and backend code for this application. This is the current state of the application.

Your role:
- Help users understand how to use the application features
- Answer questions about capabilities, settings, projects, agent mode, workspace, etc.
- Explain how the code works when asked technical questions
- Provide clear, concise answers with examples

IMPORTANT: ONLY reference features that are explicitly documented in the provided CAPABILITIES.md or visible in the provided backend code. If a feature is not mentioned in the documentation or code that was provided to you, do NOT suggest it exists. If you're unsure whether a feature exists, clearly state that you don't see it in the documentation.

Be friendly, clear, and helpful!`;

        // Create conversation with proper parameters
        const conversation = await ConversationsManager.createConversation(
            '❓ Help: How to Use This App',
            true, // clearUI
            false // isAgent
        );

        // Update conversation with system prompt
        await fetch(`/api/conversations/${conversation.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                system_prompt: systemPrompt
            })
        });

        // Switch to the new conversation
        await ConversationsManager.selectConversation(conversation.id);

        // Add documentation and code as the first user message (hidden from UI)
        const contextMessage = `Here is the complete, up-to-date documentation and code for the Claude Chat UI application:

# CAPABILITIES.md

${capabilities}

# Backend Code

${code}`;

        // Save the context message to the backend
        const response = await fetch(`/api/conversations/${conversation.id}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                role: 'user',
                content: contextMessage,
                branch: [0]
            })
        });

        if (!response.ok) {
            throw new Error('Failed to save context message');
        }

        // Add a welcome message from the assistant
        if (typeof ChatManager !== 'undefined') {
            const welcomeMessage = `# Welcome to Help Chat! 👋

I'm here to help you learn how to use Claude Chat UI. I have access to the complete, up-to-date documentation and backend code for this application.

I can answer questions about:

## Features & Usage 🎯
- **Projects** - How to organize conversations
- **Agent Chat** - Using the workspace and tools
- **Settings** - Customizing models, temperature, and more
- **Conversation Branching** - Editing and retrying messages
- **File Attachments** - Uploading and working with files
- **Extended Thinking** - Using deep reasoning mode
- **Keyboard Shortcuts** - Faster navigation

## Technical Questions 🔧
- How the streaming works
- Backend architecture and APIs
- Storage systems (SQLite vs JSON)
- Project memory system
- How features are implemented

## Examples:
- "How do I create a project?"
- "What can agent chat do with files?"
- "How does conversation branching work?"
- "How is streaming implemented in the backend?"
- "What keyboard shortcuts are available?"

**Just ask me anything!** 😊`;

            // Add context message to local state (hidden)
            ChatManager.messages.push({
                id: 'help-context',
                role: 'user',
                content: contextMessage,
                position: 0,
                version: 1,
                total_versions: 1,
                hidden: true // Mark as hidden so it doesn't render
            });

            // Add welcome message to local state
            ChatManager.messages.push({
                id: 'help-welcome',
                role: 'assistant',
                content: welcomeMessage,
                position: 1,
                version: 1,
                total_versions: 1
            });

            // Only render the welcome message (not the context)
            ChatManager.renderMessage({
                id: 'help-welcome',
                role: 'assistant',
                content: welcomeMessage,
                position: 1,
                version: 1,
                total_versions: 1
            });

            // Hide welcome message
            document.getElementById('welcome-message').style.display = 'none';
            ChatManager.updateContextStats();
        }

        console.log('Help chat created successfully with documentation context');

    } catch (error) {
        console.error('Failed to create help chat:', error);
        alert('Failed to create help chat: ' + error.message);
    }
}

// Handle page visibility changes to stop streaming if hidden
document.addEventListener('visibilitychange', () => {
    if (document.hidden && ChatManager.isStreaming) {
        // Optionally stop streaming when tab is hidden
        // ChatManager.stopStreaming();
    }
});

// Handle keyboard shortcuts
document.addEventListener('keydown', (e) => {
    // Escape to close settings panel or project settings modal
    if (e.key === 'Escape') {
        if (typeof ProjectSettingsManager !== 'undefined' && ProjectSettingsManager.isOpen) {
            ProjectSettingsManager.close();
        } else if (SettingsManager.isOpen) {
            SettingsManager.togglePanel();
        }
    }

    // Ctrl/Cmd + N for new chat
    if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
        e.preventDefault();
        ConversationsManager.createConversation();
    }

    // Ctrl/Cmd + , for settings
    if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault();
        SettingsManager.togglePanel();
    }

    // Arrow Up - Navigate to previous message
    if (e.key === 'ArrowUp' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        const messageInput = document.getElementById('message-input');
        const activeElement = document.activeElement;

        // Only trigger if not typing in textarea, or if at the start of textarea
        if (activeElement !== messageInput || (messageInput.selectionStart === 0 && messageInput.selectionEnd === 0)) {
            const container = document.getElementById('messages-container');
            const messages = Array.from(container.querySelectorAll('.message'));

            if (messages.length > 0) {
                // If at bottom (-1), go to last message
                if (currentMessageIndex === -1) {
                    currentMessageIndex = messages.length - 1;
                } else if (currentMessageIndex > 0) {
                    // Go to previous message
                    currentMessageIndex--;
                }

                const targetMessage = messages[currentMessageIndex];
                const scrollTop = targetMessage.offsetTop - 80; // 80px offset to show slightly above

                container.scrollTo({
                    top: scrollTop,
                    behavior: 'smooth'
                });
                e.preventDefault();
            }
        }
    }

    // Arrow Down - Navigate to next message or bottom
    if (e.key === 'ArrowDown' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        const messageInput = document.getElementById('message-input');
        const activeElement = document.activeElement;

        // Only trigger if not typing in textarea, or if at the end of textarea
        const isAtEnd = messageInput.selectionStart === messageInput.value.length &&
                        messageInput.selectionEnd === messageInput.value.length;

        if (activeElement !== messageInput || isAtEnd) {
            const container = document.getElementById('messages-container');
            const messages = Array.from(container.querySelectorAll('.message'));

            if (currentMessageIndex === -1) {
                // Already at bottom, do nothing or scroll to bottom again
                container.scrollTo({
                    top: container.scrollHeight,
                    behavior: 'smooth'
                });
            } else if (currentMessageIndex < messages.length - 1) {
                // Go to next message
                currentMessageIndex++;
                const targetMessage = messages[currentMessageIndex];
                const scrollTop = targetMessage.offsetTop - 80; // 80px offset

                container.scrollTo({
                    top: scrollTop,
                    behavior: 'smooth'
                });
            } else {
                // At last message, go to bottom
                currentMessageIndex = -1;
                container.scrollTo({
                    top: container.scrollHeight,
                    behavior: 'smooth'
                });

                // Focus the input
                messageInput.focus();
            }
            e.preventDefault();
        }
    }
});

// Reset message index when user manually scrolls
document.addEventListener('DOMContentLoaded', () => {
    const container = document.getElementById('messages-container');
    if (container) {
        let scrollTimeout;
        container.addEventListener('scroll', () => {
            // Reset index if user manually scrolls near the bottom
            clearTimeout(scrollTimeout);
            scrollTimeout = setTimeout(() => {
                const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 150;
                if (isNearBottom) {
                    currentMessageIndex = -1;
                }
            }, 150);
        });
    }
});

// Warn before closing if streaming
window.addEventListener('beforeunload', (e) => {
    if (ChatManager.isStreaming) {
        e.preventDefault();
        e.returnValue = '';
    }
});

// Sidebar resize functionality with snap-to-close
document.addEventListener('DOMContentLoaded', () => {
    const sidebar = document.getElementById('sidebar');
    const resizeHandle = document.getElementById('sidebar-resize-handle');

    if (!sidebar || !resizeHandle) return;

    const MIN_WIDTH = 180;
    const MAX_WIDTH = 500;
    const SNAP_THRESHOLD = 80; // Below this, snap to closed

    let isResizing = false;
    let startX = 0;
    let startWidth = 0;
    let wasCollapsed = false;

    const collapseSidebar = () => {
        sidebar.classList.add('collapsed');
        sidebar.style.width = '0px';
        localStorage.setItem('sidebarCollapsed', 'true');
        localStorage.removeItem('sidebarWidth');
    };

    const expandSidebar = (width = MIN_WIDTH) => {
        sidebar.classList.remove('collapsed');
        sidebar.style.width = width + 'px';
        localStorage.setItem('sidebarCollapsed', 'false');
        localStorage.setItem('sidebarWidth', width);
    };

    resizeHandle.addEventListener('mousedown', (e) => {
        isResizing = true;
        startX = e.clientX;
        wasCollapsed = sidebar.classList.contains('collapsed');
        // If collapsed, treat starting width as 0 for calculations
        startWidth = wasCollapsed ? 0 : sidebar.offsetWidth;
        // Temporarily expand if collapsed so we can see the drag
        if (wasCollapsed) {
            sidebar.classList.remove('collapsed');
        }
        resizeHandle.classList.add('dragging');
        document.body.classList.add('sidebar-resizing');
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;

        // Calculate new width based on mouse position (use absolute X position)
        let newWidth = e.clientX;

        // Visual feedback during drag
        if (newWidth < SNAP_THRESHOLD) {
            // Show collapsed state preview
            sidebar.classList.add('collapsed');
            sidebar.style.width = '0px';
        } else {
            // Show normal state - clamp between min and max
            sidebar.classList.remove('collapsed');
            sidebar.style.width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, newWidth)) + 'px';
        }
    });

    document.addEventListener('mouseup', () => {
        if (isResizing) {
            isResizing = false;
            resizeHandle.classList.remove('dragging');
            document.body.classList.remove('sidebar-resizing');

            // Determine final state based on current width
            const currentWidth = sidebar.offsetWidth;

            if (sidebar.classList.contains('collapsed') || currentWidth < SNAP_THRESHOLD) {
                // Snap to closed
                collapseSidebar();
            } else {
                // Save normal width
                const finalWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, currentWidth));
                expandSidebar(finalWidth);
            }
        }
    });

    // Double-click on handle to toggle
    resizeHandle.addEventListener('dblclick', () => {
        if (sidebar.classList.contains('collapsed')) {
            const savedWidth = localStorage.getItem('sidebarWidth');
            expandSidebar(savedWidth ? parseInt(savedWidth, 10) : MIN_WIDTH);
        } else {
            collapseSidebar();
        }
    });

    // Keyboard shortcut: Cmd+B (Mac) / Ctrl+B (Windows/Linux) to toggle sidebar
    document.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
            e.preventDefault();
            if (sidebar.classList.contains('collapsed')) {
                const savedWidth = localStorage.getItem('sidebarWidth');
                expandSidebar(savedWidth ? parseInt(savedWidth, 10) : MIN_WIDTH);
            } else {
                collapseSidebar();
            }
        }
    });

    // Restore saved state
    const isCollapsed = localStorage.getItem('sidebarCollapsed') === 'true';
    if (isCollapsed) {
        collapseSidebar();
    } else {
        const savedWidth = localStorage.getItem('sidebarWidth');
        if (savedWidth) {
            const width = parseInt(savedWidth, 10);
            if (width >= MIN_WIDTH && width <= MAX_WIDTH) {
                sidebar.style.width = width + 'px';
            }
        }
    }
});

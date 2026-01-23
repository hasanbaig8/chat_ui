/**
 * Chat and streaming module with file-based branching support
 */

const ChatManager = {
    messages: [],  // Array of {role, content, position, version, total_versions, user_msg_index}
    currentBranch: [0],  // Current branch array
    isStreaming: false,
    isAgentConversation: false,  // Whether current conversation uses agent SDK
    agentSessionId: null,  // Session ID for agent SDK conversation resumption
    abortController: null,
    editingPosition: null,
    originalEditContent: null,  // Original content when editing
    retryPosition: null,  // Position for retry operations
    lastPrunedCount: 0,  // Track number of pruned messages
    activeConversationId: null,  // Track which conversation is currently displayed
    streamingMessageEl: null,  // Reference to current streaming message element
    streamingMessageId: null,  // ID of message being streamed (for DB updates)
    pollInterval: null,  // Interval for polling streaming updates
    lastStreamingText: '',  // Track last known streaming text for smooth updates
    streamingTextQueue: '',  // Queue of text waiting to be revealed
    streamingDisplayedText: '',  // Text currently displayed during animated streaming
    streamingAnimationFrame: null,  // Animation frame for smooth text reveal
    userScrolledAway: false,  // Track if user has scrolled away during streaming
    lastTabRefresh: 0,  // Timestamp of last tab refresh to debounce
    toolBlocks: {},  // Map of tool_use_id to DOM elements for agent chats

    // Model context limits (in tokens)
    MODEL_LIMITS: {
        'claude-3-5-sonnet-20241022': 200000,
        'claude-3-5-haiku-20241022': 200000,
        'claude-3-opus-20240229': 200000,
        'claude-3-sonnet-20240229': 200000,
        'claude-3-haiku-20240307': 200000
    },

    /**
     * Initialize chat
     */
    init() {
        this.bindEvents();
        this.configureMarked();
        this.bindTabVisibility();
    },

    /**
     * Handle tab visibility changes - refresh state when tab becomes visible
     */
    bindTabVisibility() {
        document.addEventListener('visibilitychange', async () => {
            if (document.visibilityState === 'visible') {
                await this.refreshOnTabFocus();
            }
        });

        // Also handle window focus for cases where visibilitychange doesn't fire
        window.addEventListener('focus', async () => {
            await this.refreshOnTabFocus();
        });
    },

    /**
     * Refresh conversation state when returning to tab
     */
    async refreshOnTabFocus() {
        // Debounce: don't refresh more than once per second
        const now = Date.now();
        if (now - this.lastTabRefresh < 1000) {
            return;
        }
        this.lastTabRefresh = now;

        // Don't refresh if we're actively streaming locally (would interrupt SSE)
        if (this.abortController) {
            return;
        }

        // Refresh conversation list
        if (typeof ConversationsManager !== 'undefined') {
            await ConversationsManager.loadConversations();
        }

        // Reload current conversation if one is selected
        const currentId = this.activeConversationId;
        if (currentId) {
            try {
                // Check streaming status on server
                const streamingResponse = await fetch(`/api/chat/streaming/${currentId}`);
                const streamingData = await streamingResponse.json();

                // Reload conversation from DB with current branch
                const branchParam = this.currentBranch.join(',');
                const convResponse = await fetch(`/api/conversations/${currentId}?branch=${branchParam}`);
                if (convResponse.ok) {
                    const conversation = await convResponse.json();

                    // Update streaming tracker
                    if (typeof StreamingTracker !== 'undefined') {
                        StreamingTracker.setStreaming(currentId, streamingData.streaming);
                    }

                    // Reload the conversation UI
                    await this.loadConversation(conversation);
                }
            } catch (e) {
                console.error('Error refreshing on tab focus:', e);
            }
        }
    },

    /**
     * Configure marked.js for markdown rendering
     */
    configureMarked() {
        if (typeof marked !== 'undefined') {
            marked.setOptions({
                highlight: function(code, lang) {
                    if (typeof hljs !== 'undefined' && lang && hljs.getLanguage(lang)) {
                        try {
                            return hljs.highlight(code, { language: lang }).value;
                        } catch (e) {}
                    }
                    if (typeof hljs !== 'undefined') {
                        try {
                            return hljs.highlightAuto(code).value;
                        } catch (e) {}
                    }
                    return code;
                },
                breaks: true,
                gfm: true
            });
        }
    },

    /**
     * Bind DOM events
     */
    bindEvents() {
        const messageInput = document.getElementById('message-input');
        const sendBtn = document.getElementById('send-btn');

        messageInput.addEventListener('input', () => {
            this.autoResizeTextarea(messageInput);
            this.updateSendButton();
        });

        sendBtn.addEventListener('click', () => {
            this.sendMessage();
        });

        messageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.sendMessage();
            }
        });

        // Copy entire conversation button
        const copyConversationBtn = document.getElementById('copy-conversation-btn');
        if (copyConversationBtn) {
            copyConversationBtn.addEventListener('click', () => {
                this.copyEntireConversation();
            });
        }

        // Track user scroll behavior during streaming
        const messagesContainer = document.getElementById('messages-container');
        messagesContainer.addEventListener('scroll', () => {
            if (!this.isStreaming) return;

            const container = messagesContainer;
            const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;

            // If user scrolled more than 50px from bottom, they've scrolled away
            if (distanceFromBottom > 50) {
                this.userScrolledAway = true;
            } else {
                // User scrolled back to bottom
                this.userScrolledAway = false;
            }
        });
    },

    autoResizeTextarea(textarea) {
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
    },

    updateSendButton() {
        const messageInput = document.getElementById('message-input');
        const sendBtn = document.getElementById('send-btn');
        const hasContent = messageInput.value.trim() || FilesManager.hasPendingFiles();
        sendBtn.disabled = !hasContent || this.isStreaming;
    },

    /**
     * Estimate token count for content (rough approximation: ~4 chars per token)
     */
    estimateTokens(content) {
        if (typeof content === 'string') {
            return Math.ceil(content.length / 4);
        } else if (Array.isArray(content)) {
            let total = 0;
            for (const block of content) {
                if (block.type === 'text') {
                    total += Math.ceil((block.text || '').length / 4);
                } else if (block.type === 'image') {
                    // Images: rough estimate based on size, ~1000 tokens for base64 images
                    total += 1000;
                } else if (block.type === 'document') {
                    // Documents: estimate based on content
                    total += 500;
                }
            }
            return total;
        }
        return 0;
    },

    /**
     * Get context limit for current model
     */
    getContextLimit() {
        const settings = SettingsManager?.getSettings() || {};
        return this.MODEL_LIMITS[settings.model] || 200000;
    },

    /**
     * Prune messages to keep context under threshold
     */
    pruneMessages(messages) {
        const settings = SettingsManager?.getSettings() || {};
        const pruneThreshold = settings.prune_threshold || 0.7;
        const contextLimit = this.getContextLimit();
        const maxTokens = Math.floor(contextLimit * pruneThreshold);

        // Calculate total tokens
        let totalTokens = 0;
        for (const msg of messages) {
            totalTokens += this.estimateTokens(msg.content);
        }

        // If under limit, no pruning needed
        if (totalTokens <= maxTokens) {
            return messages;
        }

        // Prune from the beginning, but keep at least the last 2 messages (user + assistant)
        const prunedMessages = [];
        let currentTokens = 0;

        // Start from the end and work backwards
        for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            const msgTokens = this.estimateTokens(msg.content);

            if (currentTokens + msgTokens <= maxTokens || prunedMessages.length < 2) {
                prunedMessages.unshift(msg);
                currentTokens += msgTokens;
            } else {
                // Stop adding messages - we've hit the limit
                break;
            }
        }

        const prunedCount = messages.length - prunedMessages.length;
        this.lastPrunedCount = prunedCount;

        if (prunedCount > 0) {
            const settings = SettingsManager?.getSettings() || {};
            const pruneThreshold = settings.prune_threshold || 0.7;
            console.log(`Pruned ${prunedCount} message(s) to keep context under ${pruneThreshold * 100}% (${totalTokens} -> ${currentTokens} tokens)`);
        }

        return prunedMessages;
    },

    /**
     * Load a conversation and its messages
     */
    async loadConversation(conversation) {
        console.log('[loadConversation] Starting load for:', conversation.id, 'Active ID:', this.activeConversationId);

        // Verify this is still the conversation we want to load
        if (this.activeConversationId !== conversation.id) {
            console.log('[loadConversation] SKIPPED - activeConversationId changed from', conversation.id, 'to', this.activeConversationId);
            return;
        }

        // Stop any existing polling
        this.stopPolling();

        this.messages = [];
        this.currentBranch = conversation.current_branch || [0];
        this.isAgentConversation = conversation.is_agent || false;
        this.agentSessionId = conversation.session_id || null;  // For agent SDK resumption
        this.toolBlocks = {};
        this.clearMessagesUI();

        // Update settings mode based on conversation type
        if (typeof SettingsManager !== 'undefined') {
            SettingsManager.setMode(this.isAgentConversation ? 'agent' : 'normal');
        }

        // Update workspace visibility
        if (typeof WorkspaceManager !== 'undefined') {
            WorkspaceManager.updateVisibility(this.isAgentConversation);
            WorkspaceManager.setConversation(conversation.id);
        }
        this.streamingMessageEl = null;
        this.streamingMessageId = null;

        // Check if this conversation is streaming on the server FIRST
        let isStreamingActive = false;
        if (typeof StreamingTracker !== 'undefined') {
            isStreamingActive = await StreamingTracker.checkServerStatus(conversation.id);
            this.isStreaming = isStreamingActive;
            console.log('[loadConversation] Streaming active:', isStreamingActive, 'Messages count:', conversation.messages?.length);
        }

        if (conversation.messages && conversation.messages.length > 0) {
            console.log('[loadConversation] Branch:', conversation.current_branch, 'Message count:', conversation.messages.length);
            console.log('[loadConversation] Rendering messages:', conversation.messages.map(m => ({
                role: m.role,
                position: m.position,
                contentLength: typeof m.content === 'string' ? m.content.length : 'array',
                content: typeof m.content === 'string' ? m.content.substring(0, 100) : m.content,
                id: m.id
            })));
            document.getElementById('welcome-message').style.display = 'none';

            // First, populate all messages with IDs for parent tracking
            conversation.messages.forEach(msg => {
                this.messages.push({
                    id: msg.id,
                    role: msg.role,
                    content: msg.content,
                    tool_results: msg.tool_results,
                    position: msg.position,
                    version: msg.current_version || msg.version || 1,
                    total_versions: msg.total_versions || 1,
                    user_msg_index: msg.user_msg_index
                });
            });

            // Then render all messages
            conversation.messages.forEach(msg => {
                this.renderMessage({
                    id: msg.id,
                    role: msg.role,
                    content: msg.content,
                    thinking: msg.thinking,
                    tool_results: msg.tool_results,
                    position: msg.position,
                    version: msg.current_version || msg.version || 1,
                    total_versions: msg.total_versions || 1,
                    user_msg_index: msg.user_msg_index
                });
            });

            // Force scroll to bottom when loading a conversation
            this.scrollToBottom(true);
            this.updateContextStats();
        } else if (!isStreamingActive) {
            // Only show welcome message if NOT streaming (streaming might have in-progress message)
            const welcomeEl = document.getElementById('welcome-message');
            welcomeEl.innerHTML = this.getWelcomeMessage();
            welcomeEl.style.display = '';
        }

        // Set up streaming if active
        if (isStreamingActive) {
            // Initialize streaming state with current content for smooth animation
            if (conversation.messages && conversation.messages.length > 0) {
                const lastMsg = conversation.messages[conversation.messages.length - 1];
                if (lastMsg.role === 'assistant') {
                    this.lastStreamingText = lastMsg.content || '';
                    this.streamingDisplayedText = lastMsg.content || '';
                    this.streamingTextQueue = '';
                }
            }
            this.startPolling(conversation.id);
        } else {
            this.lastStreamingText = '';
            this.stopStreamingAnimation();
            this.isStreaming = false;
        }

        this.updateSendButton();
    },

    /**
     * Start polling for streaming updates
     */
    startPolling(conversationId) {
        this.stopPolling();  // Clear any existing interval

        this.isStreaming = true;
        this.updateSendButton();

        // Poll every 500ms for updates
        this.pollInterval = setInterval(async () => {
            if (this.activeConversationId !== conversationId) {
                this.stopPolling();
                return;
            }

            try {
                // Check if still streaming
                const streamingResponse = await fetch(`/api/chat/streaming/${conversationId}`);
                const streamingData = await streamingResponse.json();

                if (!streamingData.streaming) {
                    // Streaming finished, reload conversation to get final content
                    this.stopPolling();
                    if (typeof StreamingTracker !== 'undefined') {
                        StreamingTracker.setStreaming(conversationId, false);
                    }

                    // Reload the conversation from DB with current branch
                    const branchParam = this.currentBranch.join(',');
                    const convResponse = await fetch(`/api/conversations/${conversationId}?branch=${branchParam}`);
                    const conversation = await convResponse.json();

                    if (this.activeConversationId === conversationId) {
                        this.loadConversation(conversation);
                    }
                    return;
                }

                // Still streaming - reload to get latest content
                const branchParam = this.currentBranch.join(',');
                const convResponse = await fetch(`/api/conversations/${conversationId}?branch=${branchParam}`);
                const conversation = await convResponse.json();

                if (this.activeConversationId === conversationId) {
                    this.updateFromConversation(conversation);
                }
            } catch (e) {
                console.error('Polling error:', e);
            }
        }, 500);
    },

    /**
     * Stop polling for updates
     */
    stopPolling() {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
    },

    /**
     * Update UI from conversation data (used during polling)
     */
    updateFromConversation(conversation) {
        console.log('[updateFromConversation] Messages:', conversation.messages?.length, 'Last message content length:', conversation.messages?.[conversation.messages.length - 1]?.content?.length);
        if (!conversation.messages || conversation.messages.length === 0) return;

        const container = document.getElementById('messages-container');
        const lastMsg = conversation.messages[conversation.messages.length - 1];

        // Find or create the message element
        let messageEl = container.querySelector(`.message[data-position="${lastMsg.position}"]`);

        if (!messageEl && lastMsg.role === 'assistant') {
            // Create new message element
            messageEl = this.createMessageElement('assistant', lastMsg.position, 1, 1);
            container.appendChild(messageEl);
            document.getElementById('welcome-message').style.display = 'none';
        }

        if (messageEl && lastMsg.role === 'assistant') {
            const contentEl = messageEl.querySelector('.message-content');

            // Add streaming indicator if streaming
            let indicator = contentEl.querySelector('.streaming-indicator');
            if (!indicator && this.isStreaming) {
                indicator = document.createElement('span');
                indicator.className = 'streaming-indicator';
            }

            // Update thinking block if present
            if (lastMsg.thinking) {
                let thinkingEl = contentEl.querySelector('.thinking-block');
                if (!thinkingEl) {
                    thinkingEl = this.createThinkingBlock();
                    contentEl.insertBefore(thinkingEl, contentEl.firstChild);
                }
                this.updateThinkingBlock(thinkingEl, lastMsg.thinking);
            }

            // Update text content with smooth streaming
            if (lastMsg.content) {
                // For streaming, use incremental updates
                if (this.isStreaming) {
                    this.updateStreamingContent(contentEl, lastMsg.content, indicator);
                } else {
                    this.updateMessageContent(contentEl, lastMsg.content, indicator);
                }
            }

            this.scrollToBottom();
        }

        // Update messages array
        this.messages = conversation.messages.map(msg => ({
            id: msg.id,
            role: msg.role,
            content: msg.content,
            position: msg.position,
            version: msg.current_version || msg.version || 1,
            total_versions: msg.total_versions || 1,
            user_msg_index: msg.user_msg_index
        }));

        this.updateContextStats();
    },

    /**
     * Update streaming content smoothly with animated character reveal
     * When polling returns chunks of text, we animate them character by character
     */
    updateStreamingContent(contentEl, newText, indicator) {
        // If new text is an extension of what we know about, queue the new chars
        const oldText = this.lastStreamingText || '';

        if (newText.length > oldText.length && newText.startsWith(oldText)) {
            // Queue the new characters for animated reveal
            const newChars = newText.slice(oldText.length);
            this.streamingTextQueue += newChars;
            this.lastStreamingText = newText;
        } else if (newText !== oldText) {
            // Text changed differently - reset and show immediately
            this.streamingTextQueue = '';
            this.streamingDisplayedText = newText;
            this.lastStreamingText = newText;
            this.renderStreamingText(contentEl, newText, indicator);
            return;
        }

        // Start animation if not already running
        if (!this.streamingAnimationFrame && this.streamingTextQueue.length > 0) {
            this.animateStreamingText(contentEl, indicator);
        }
    },

    /**
     * Animate revealing queued text character by character
     */
    animateStreamingText(contentEl, indicator) {
        const charsPerFrame = 3;  // Reveal multiple chars per frame for speed
        const frameDelay = 16;    // ~60fps

        const animate = () => {
            if (this.streamingTextQueue.length === 0) {
                this.streamingAnimationFrame = null;
                return;
            }

            // Take chars from queue
            const chars = this.streamingTextQueue.slice(0, charsPerFrame);
            this.streamingTextQueue = this.streamingTextQueue.slice(charsPerFrame);
            this.streamingDisplayedText += chars;

            // Render current displayed text
            this.renderStreamingText(contentEl, this.streamingDisplayedText, indicator);

            // Continue animation
            this.streamingAnimationFrame = setTimeout(() => {
                requestAnimationFrame(() => animate());
            }, frameDelay);
        };

        this.streamingAnimationFrame = requestAnimationFrame(() => animate());
    },

    /**
     * Render the streaming text to the DOM
     */
    renderStreamingText(contentEl, text, indicator) {
        const thinkingBlock = contentEl.querySelector('.thinking-block');
        const wasExpanded = thinkingBlock?.classList.contains('expanded');

        // Get or create text container
        let textContainer = contentEl.querySelector('.message-text');
        if (!textContainer) {
            // Clear existing content (from renderMessage) but preserve thinking block
            // Remove all children except thinking block
            Array.from(contentEl.children).forEach(child => {
                if (!child.classList.contains('thinking-block') &&
                    !child.classList.contains('streaming-indicator')) {
                    child.remove();
                }
            });

            textContainer = document.createElement('div');
            textContainer.className = 'message-text';
            contentEl.appendChild(textContainer);
        }

        textContainer.innerHTML = this.formatText(text);
        this.addCodeCopyButtons(textContainer);
        textContainer.dataset.rawText = text;

        // Re-add thinking block at the beginning
        if (thinkingBlock) {
            contentEl.insertBefore(thinkingBlock, contentEl.firstChild);
            if (wasExpanded) {
                thinkingBlock.classList.add('expanded');
            }
        }

        // Ensure indicator is at end
        if (indicator && indicator.parentNode !== contentEl) {
            contentEl.appendChild(indicator);
        }

        // Note: Don't call scrollToBottom here - it's called too frequently
        // Let updateFromConversation handle scrolling at a reasonable rate
    },

    /**
     * Stop streaming text animation
     */
    stopStreamingAnimation() {
        if (this.streamingAnimationFrame) {
            cancelAnimationFrame(this.streamingAnimationFrame);
            clearTimeout(this.streamingAnimationFrame);
            this.streamingAnimationFrame = null;
        }
        this.streamingTextQueue = '';
        this.streamingDisplayedText = '';
    },

    clearChat() {
        this.stopPolling();
        this.stopStreamingAnimation();
        this.messages = [];
        this.currentBranch = [0];
        // Don't reset isAgentConversation here - let the caller set it appropriately
        this.clearMessagesUI();
        this.streamingMessageEl = null;
        this.streamingMessageId = null;
        this.isStreaming = false;
        this.agentSessionId = null;
        this.userScrolledAway = false;
        this.abortController = null;
        this.lastStreamingText = '';
        this.toolBlocks = {};
        document.getElementById('welcome-message').style.display = '';
        this.updateContextStats();
        this.updateSendButton();

        // Update workspace visibility
        if (typeof WorkspaceManager !== 'undefined') {
            WorkspaceManager.updateVisibility(this.isAgentConversation);
        }
    },

    /**
     * Prepare UI for a conversation switch - call this immediately when switching
     */
    prepareForConversationSwitch(newConversationId) {
        // Stop polling and animation for the old conversation
        this.stopPolling();
        this.stopStreamingAnimation();

        // Update active conversation ID immediately
        this.activeConversationId = newConversationId;

        // Clear UI immediately to prevent showing stale messages
        this.messages = [];
        this.currentBranch = [0];
        // Note: isAgentConversation should be set by caller before calling this
        this.clearMessagesUI();
        this.streamingMessageEl = null;
        this.streamingMessageId = null;
        this.lastStreamingText = '';
        this.toolBlocks = {};

        // Show loading state or welcome message
        document.getElementById('welcome-message').style.display = '';

        // Reset streaming state - will be updated when conversation loads
        this.isStreaming = false;
        // Don't reset isAgentConversation here - it's set by the caller
        this.agentSessionId = null;
        this.userScrolledAway = false;
        this.updateSendButton();
        this.updateContextStats();

        // Update workspace visibility based on conversation type
        if (typeof WorkspaceManager !== 'undefined') {
            WorkspaceManager.updateVisibility(this.isAgentConversation);
            WorkspaceManager.setConversation(newConversationId);
        }
    },

    clearMessagesUI() {
        const container = document.getElementById('messages-container');
        const welcomeHtml = this.getWelcomeMessage();
        container.innerHTML = `<div class="welcome-message" id="welcome-message" style="display: none;">${welcomeHtml}</div>`;
    },

    /**
     * Get welcome message based on conversation type
     */
    getWelcomeMessage() {
        if (this.isAgentConversation) {
            return `
                <h2>Welcome to Claude Agent Chat</h2>
                <p>This is an agentic conversation where Claude can:</p>
                <ul style="text-align: left; display: inline-block; margin-top: 10px;">
                    <li>Read and write files in your workspace</li>
                    <li>Execute bash commands</li>
                    <li>Search for GIFs to enhance responses</li>
                    <li>Maintain context across multiple turns</li>
                </ul>
                <p style="margin-top: 15px;">Start by asking Claude to help with coding tasks!</p>
            `;
        } else {
            return '<h2>Welcome to Claude Chat</h2><p>Start a conversation by typing a message below.</p>';
        }
    },

    /**
     * Handle slash commands for agent conversations
     * Returns true if command was handled, false otherwise
     */
    async handleSlashCommand(text) {
        if (!this.isAgentConversation || !text.startsWith('/')) {
            return false;
        }

        const parts = text.split(' ');
        const command = parts[0].toLowerCase();
        const args = parts.slice(1);

        switch (command) {
            case '/ls':
                // Show workspace files
                if (typeof WorkspaceManager !== 'undefined') {
                    WorkspaceManager.togglePanel();
                    if (!WorkspaceManager.isOpen) {
                        // If was closed, open it
                        WorkspaceManager.togglePanel();
                    }
                }
                return true;

            case '/delete':
                // Delete a file
                if (args.length === 0) {
                    this.showSystemMessage('Usage: /delete <filename>');
                    return true;
                }
                const filename = args.join(' ');
                if (typeof WorkspaceManager !== 'undefined') {
                    await WorkspaceManager.deleteFile(filename);
                }
                return true;

            default:
                return false;
        }
    },

    /**
     * Show system message in chat
     */
    showSystemMessage(text) {
        const container = document.getElementById('messages-container');
        const msgEl = document.createElement('div');
        msgEl.className = 'system-message';
        msgEl.textContent = text;
        msgEl.style.cssText = `
            padding: 8px 12px;
            margin: 8px auto;
            max-width: 600px;
            background-color: var(--color-bg);
            border: 1px solid var(--color-border);
            border-radius: 6px;
            color: var(--color-text-secondary);
            font-size: 13px;
            text-align: center;
        `;
        container.appendChild(msgEl);
        this.scrollToBottom(true);
    },

    /**
     * Send a new message
     */
    async sendMessage() {
        const messageInput = document.getElementById('message-input');
        const text = messageInput.value.trim();
        const fileBlocks = FilesManager.getContentBlocks();

        if (!text && fileBlocks.length === 0) return;
        if (this.isStreaming) return;

        // Handle slash commands for agent conversations
        if (await this.handleSlashCommand(text)) {
            messageInput.value = '';
            messageInput.style.height = 'auto';
            this.updateSendButton();
            return;
        }

        let content;
        if (fileBlocks.length > 0) {
            content = [...fileBlocks];
            if (text) {
                content.push({ type: 'text', text: text });
            }
        } else {
            content = text;
        }

        messageInput.value = '';
        messageInput.style.height = 'auto';
        FilesManager.clearPendingFiles();
        this.updateSendButton();

        let conversationId = ConversationsManager.getCurrentConversationId();
        if (!conversationId) {
            const conversation = await ConversationsManager.createConversation(
                ConversationsManager.generateTitle(content),
                false  // Don't clear UI - we're about to add the user's message
            );
            conversationId = conversation.id;
            // Set activeConversationId since createConversation didn't (clearUI=false)
            this.activeConversationId = conversationId;
            this.currentBranch = [0];
        } else if (this.messages.length === 0) {
            await ConversationsManager.updateConversationTitle(
                conversationId,
                ConversationsManager.generateTitle(content)
            );
        }

        document.getElementById('welcome-message').style.display = 'none';

        // Add user message to backend first to get ID
        const savedMsg = await ConversationsManager.addMessage('user', content, null, this.currentBranch);

        // Add user message to local state with ID
        const userMsg = {
            id: savedMsg?.id,
            role: 'user',
            content,
            position: savedMsg?.position ?? this.messages.length,
            version: 1,
            total_versions: 1
        };
        this.messages.push(userMsg);
        this.renderMessage(userMsg, true); // Force scroll to bottom for new message

        await this.streamResponse();
    },

    /**
     * Edit a message at a position - inline editing
     */
    async editMessage(position) {
        const msg = this.messages.find(m => m.position === position);
        if (!msg || msg.role !== 'user') return;
        if (this.isStreaming) return;
        if (this.editingPosition !== null) return; // Already editing

        // Get the text content
        let textContent = '';
        if (typeof msg.content === 'string') {
            textContent = msg.content;
        } else if (Array.isArray(msg.content)) {
            const textBlock = msg.content.find(b => b.type === 'text' && !b.text?.startsWith('File: '));
            textContent = textBlock?.text || '';
        }

        const container = document.getElementById('messages-container');
        const userMsgEl = container.querySelector(`.message.user[data-position="${position}"]`);
        if (!userMsgEl) return;

        const contentEl = userMsgEl.querySelector('.message-content');
        if (!contentEl) return;

        // Store original content and mark as editing
        this.editingPosition = position;
        this.originalEditContent = textContent;

        // Add editing class for expanded styling
        userMsgEl.classList.add('editing');

        // Replace content with editable textarea
        const textarea = document.createElement('textarea');
        textarea.className = 'edit-textarea';
        textarea.value = textContent;
        textarea.style.cssText = `
            width: 100%;
            min-height: 80px;
            padding: 12px;
            border: none;
            border-radius: 6px;
            background: transparent;
            color: var(--color-text);
            font-family: inherit;
            font-size: inherit;
            line-height: 1.5;
            resize: vertical;
            outline: none;
        `;

        // Create button container
        const buttonContainer = document.createElement('div');
        buttonContainer.className = 'edit-buttons';
        buttonContainer.style.cssText = `
            display: flex;
            gap: 8px;
            margin-top: 8px;
            justify-content: flex-end;
        `;

        const saveBtn = document.createElement('button');
        saveBtn.textContent = 'Save';
        saveBtn.className = 'edit-save-btn';
        saveBtn.style.cssText = `
            padding: 6px 12px;
            background: var(--color-primary);
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
            font-weight: 500;
        `;

        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        cancelBtn.className = 'edit-cancel-btn';
        cancelBtn.style.cssText = `
            padding: 6px 12px;
            background: var(--color-border);
            color: var(--color-text);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
        `;

        buttonContainer.appendChild(cancelBtn);
        buttonContainer.appendChild(saveBtn);

        // Clear content and add edit UI
        contentEl.innerHTML = '';
        contentEl.appendChild(textarea);
        contentEl.appendChild(buttonContainer);

        // Hide the action buttons while editing
        const actionsEl = userMsgEl.querySelector('.message-actions');
        if (actionsEl) actionsEl.style.display = 'none';

        // Focus and select text
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);

        // Auto-resize textarea
        const autoResize = () => {
            textarea.style.height = 'auto';
            textarea.style.height = Math.min(textarea.scrollHeight, 300) + 'px';
        };
        autoResize();
        textarea.addEventListener('input', autoResize);

        // Handle save
        const saveEdit = async () => {
            const newContent = textarea.value.trim();
            if (!newContent) {
                cancelEdit();
                return;
            }
            await this.confirmEdit(position, newContent);
        };

        // Handle cancel
        const cancelEdit = () => {
            this.cancelEdit(position);
        };

        // Event listeners
        saveBtn.addEventListener('click', saveEdit);
        cancelBtn.addEventListener('click', cancelEdit);

        textarea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                saveEdit();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                cancelEdit();
            }
        });
    },

    /**
     * Confirm and save the edit - creates a new branch
     */
    async confirmEdit(position, newContent) {
        if (this.editingPosition !== position) return;

        const conversationId = ConversationsManager.getCurrentConversationId();
        if (!conversationId) return;

        // Find the user message index for the edited position
        const msg = this.messages.find(m => m.position === position);
        const userMsgIndex = msg?.user_msg_index ?? Math.floor(position / 2);

        // Clear editing state
        this.editingPosition = null;
        this.originalEditContent = null;

        // Create new branch via API
        const response = await fetch(`/api/conversations/${conversationId}/edit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                user_msg_index: userMsgIndex,
                content: newContent,
                branch: this.currentBranch
            })
        });

        if (response.ok) {
            const result = await response.json();
            // Update current branch
            this.currentBranch = result.branch;

            // Reload conversation with new branch
            await ConversationsManager.selectConversation(conversationId, this.currentBranch);

            // Stream new response
            await this.streamResponse();
        }
    },

    /**
     * Cancel the edit and restore original content
     */
    cancelEdit(position) {
        if (this.editingPosition !== position) return;

        const container = document.getElementById('messages-container');
        const userMsgEl = container.querySelector(`.message.user[data-position="${position}"]`);

        if (userMsgEl) {
            // Remove editing class
            userMsgEl.classList.remove('editing');

            const contentEl = userMsgEl.querySelector('.message-content');
            if (contentEl) {
                contentEl.innerHTML = this.formatText(this.originalEditContent || '');
            }
            // Show action buttons again
            const actionsEl = userMsgEl.querySelector('.message-actions');
            if (actionsEl) actionsEl.style.display = '';
        }

        // Clear editing state
        this.editingPosition = null;
        this.originalEditContent = null;
    },

    /**
     * Copy message content to clipboard
     */
    async copyMessage(messageEl) {
        const contentEl = messageEl.querySelector('.message-content');
        if (!contentEl) return;

        // Extract text content, skipping thinking blocks
        let textToCopy = '';

        // Get all text nodes, but skip thinking content
        const thinkingBlock = contentEl.querySelector('.thinking-block');
        if (thinkingBlock) {
            // Clone the content element and remove thinking block from clone
            const clone = contentEl.cloneNode(true);
            const thinkingClone = clone.querySelector('.thinking-block');
            if (thinkingClone) thinkingClone.remove();
            textToCopy = clone.textContent.trim();
        } else {
            textToCopy = contentEl.textContent.trim();
        }

        if (!textToCopy) return;

        try {
            await navigator.clipboard.writeText(textToCopy);

            // Show visual feedback
            const copyBtn = messageEl.querySelector('.copy-btn');
            if (copyBtn) {
                const originalText = copyBtn.textContent;
                copyBtn.textContent = 'Copied';
                copyBtn.style.color = '#4CAF50';
                setTimeout(() => {
                    copyBtn.textContent = originalText;
                    copyBtn.style.color = '';
                }, 1000);
            }
        } catch (error) {
            console.error('Failed to copy:', error);
            alert('Failed to copy to clipboard');
        }
    },

    /**
     * Copy entire conversation to clipboard
     */
    async copyEntireConversation() {
        if (this.messages.length === 0) {
            return;
        }

        // Format all messages as text
        const formatted = this.messages.map(msg => {
            const role = msg.role === 'user' ? 'User' : 'Assistant';

            // Extract text content from message
            let content = '';
            if (typeof msg.content === 'string') {
                content = msg.content;
            } else if (Array.isArray(msg.content)) {
                // Get text blocks, excluding file metadata
                const textBlocks = msg.content.filter(b => b.type === 'text' && !b.text?.startsWith('File: '));
                content = textBlocks.map(b => b.text).join('\n');

                // If there are files, add a note
                const fileBlocks = msg.content.filter(b => b.type === 'image' || b.type === 'document');
                if (fileBlocks.length > 0) {
                    const fileNote = `[${fileBlocks.length} file${fileBlocks.length > 1 ? 's' : ''} attached]`;
                    content = fileNote + (content ? '\n' + content : '');
                }
            }

            return `${role}: ${content}`;
        }).join('\n\n');

        try {
            await navigator.clipboard.writeText(formatted);

            // Show visual feedback
            const copyBtn = document.getElementById('copy-conversation-btn');
            if (copyBtn) {
                const originalText = copyBtn.textContent;
                copyBtn.textContent = 'Copied';
                copyBtn.style.color = '#4CAF50';
                setTimeout(() => {
                    copyBtn.textContent = originalText;
                    copyBtn.style.color = '';
                }, 2000);
            }
        } catch (error) {
            console.error('Failed to copy conversation:', error);
            alert('Failed to copy conversation to clipboard');
        }
    },

    /**
     * Retry an assistant message (called from assistant message)
     */
    async retryMessage(assistantPosition) {
        if (this.isStreaming) return;

        const conversationId = ConversationsManager.getCurrentConversationId();
        if (!conversationId) return;

        // Remove messages from this position onwards in UI FIRST
        this.removeMessagesFromPosition(assistantPosition);

        // Force a repaint to ensure UI is cleared before streaming
        await new Promise(resolve => requestAnimationFrame(resolve));

        // Set retry position for the streaming handler
        this.retryPosition = assistantPosition;

        // Stream new response
        await this.streamResponse(true);

        // Reload conversation to ensure UI is in sync
        await ConversationsManager.selectConversation(conversationId, this.currentBranch);
    },

    /**
     * Switch to a different branch at a user message position
     */
    async switchVersion(position, direction) {
        const msg = this.messages.find(m => m.position === position);
        if (!msg || msg.total_versions <= 1) return;

        const conversationId = ConversationsManager.getCurrentConversationId();
        if (!conversationId) return;

        // Get the user_msg_index for this position
        const userMsgIndex = msg.user_msg_index ?? Math.floor(position / 2);

        // Call the switch-branch API
        const response = await fetch(`/api/conversations/${conversationId}/switch-branch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                user_msg_index: userMsgIndex,
                direction: direction,
                branch: this.currentBranch
            })
        });

        if (response.ok) {
            const result = await response.json();
            this.currentBranch = result.branch;

            // Reload with new branch
            await this.loadConversation(result.conversation);
        }
    },

    /**
     * Remove messages from UI starting at position
     */
    removeMessagesFromPosition(position) {
        const container = document.getElementById('messages-container');
        const messageEls = container.querySelectorAll('.message');

        messageEls.forEach(el => {
            const pos = parseInt(el.dataset.position);
            if (pos >= position) {
                el.remove();
            }
        });

        // Update internal messages array
        this.messages = this.messages.filter(m => m.position < position);
    },

    /**
     * Delete messages from a position onwards (inclusive)
     * This removes them from the backend storage as well
     */
    async deleteMessagesFrom(position) {
        if (this.isStreaming) return;

        const conversationId = ConversationsManager.getCurrentConversationId();
        if (!conversationId) return;

        console.log('Delete request - Position:', position, 'Total messages:', this.messages.length, 'Branch:', this.currentBranch);

        // Confirm deletion
        const msgCount = this.messages.filter(m => m.position >= position).length;
        if (!confirm(`Delete ${msgCount} message${msgCount > 1 ? 's' : ''}? This cannot be undone.`)) {
            return;
        }

        try {
            // Call API to delete messages
            const response = await fetch(`/api/conversations/${conversationId}/delete-from/${position}`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ branch: this.currentBranch })
            });

            console.log('Delete response status:', response.status);

            if (response.ok) {
                console.log('Delete successful, removing from UI');
                // Remove from UI
                this.removeMessagesFromPosition(position);
                this.updateContextStats();

                // Show welcome message if no messages left
                if (this.messages.length === 0) {
                    const welcomeEl = document.getElementById('welcome-message');
                    welcomeEl.innerHTML = this.getWelcomeMessage();
                    welcomeEl.style.display = '';
                }
            } else {
                const errorText = await response.text();
                console.error('Delete failed - Status:', response.status, 'Response:', errorText);
                try {
                    const error = JSON.parse(errorText);
                    alert(`Failed to delete messages: ${error.detail || 'Unknown error'}`);
                } catch (e) {
                    alert(`Failed to delete messages: ${errorText || response.status}`);
                }
            }
        } catch (error) {
            console.error('Delete exception:', error);
            alert(`Failed to delete messages: ${error.message}`);
        }
    },

    /**
     * Stream response from API
     * Backend saves streaming content directly to DB
     */
    async streamResponse(isRetry = false) {
        // Use agent streaming for agent conversations
        if (this.isAgentConversation) {
            return this.streamAgentResponse(isRetry);
        }

        this.isStreaming = true;
        this.lastStreamingText = '';  // Reset for fresh stream
        this.stopStreamingAnimation();  // Clear any pending animation
        this.userScrolledAway = false;  // Reset scroll tracking for new response
        this.updateSendButton();

        const conversationId = ConversationsManager.getCurrentConversationId();
        const settings = SettingsManager.getSettings();

        // Mark conversation as streaming
        if (typeof StreamingTracker !== 'undefined') {
            StreamingTracker.setStreaming(conversationId, true);
        }

        // Create assistant message element
        const position = this.messages.length;
        const messageEl = this.createMessageElement('assistant', position, 1, 1);
        const container = document.getElementById('messages-container');
        container.appendChild(messageEl);
        this.streamingMessageEl = messageEl;

        // Force scroll to bottom when starting a new response
        this.scrollToBottom(true);

        let thinkingContent = '';
        let textContent = '';
        let thinkingEl = null;

        const indicator = document.createElement('span');
        indicator.className = 'streaming-indicator';

        // Create abort controller for this stream
        const abortController = new AbortController();
        this.abortController = abortController;

        try {
            // Build messages for API
            const allMessages = this.messages.map(m => ({
                role: m.role,
                content: m.content
            }));

            // Debug: Log messages being sent
            console.log('[streamResponse] this.messages:', this.messages.map(m => ({ role: m.role, position: m.position, contentPreview: typeof m.content === 'string' ? m.content.substring(0, 50) : 'array' })));
            console.log('[streamResponse] allMessages for API:', allMessages.map(m => ({ role: m.role, contentPreview: typeof m.content === 'string' ? m.content.substring(0, 50) : 'array' })));

            // Prune messages to keep context under threshold
            const apiMessages = this.pruneMessages(allMessages);

            // Pass conversation_id and branch so backend can save streaming content to DB
            const response = await fetch('/api/chat/stream', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: apiMessages,
                    conversation_id: isRetry ? null : conversationId,  // Don't auto-save for retries
                    branch: isRetry ? null : this.currentBranch,
                    model: settings.model,
                    system_prompt: settings.system_prompt,
                    temperature: settings.temperature,
                    max_tokens: settings.max_tokens,
                    top_p: settings.top_p !== 1.0 ? settings.top_p : null,
                    top_k: settings.top_k > 0 ? settings.top_k : null,
                    thinking_enabled: settings.thinking_enabled,
                    thinking_budget: settings.thinking_budget
                }),
                signal: abortController.signal
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            const contentEl = messageEl.querySelector('.message-content');
            contentEl.appendChild(indicator);

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const event = JSON.parse(line.slice(6));

                            if (event.type === 'message_id') {
                                // Backend created the message, store the ID
                                this.streamingMessageId = event.id;
                                messageEl.dataset.messageId = event.id;
                            } else if (event.type === 'thinking') {
                                thinkingContent += event.content;

                                // Only update UI if this conversation is still active and element is in DOM
                                if (this.activeConversationId === conversationId && document.contains(messageEl)) {
                                    if (!thinkingEl) {
                                        thinkingEl = this.createThinkingBlock();
                                        contentEl.insertBefore(thinkingEl, contentEl.firstChild);
                                    }
                                    this.updateThinkingBlock(thinkingEl, thinkingContent);
                                }
                            } else if (event.type === 'text') {
                                textContent += event.content;

                                // Only update UI if this conversation is still active and element is in DOM
                                if (this.activeConversationId === conversationId && document.contains(messageEl)) {
                                    this.updateMessageContent(contentEl, textContent, indicator);
                                }
                            } else if (event.type === 'error') {
                                if (this.activeConversationId === conversationId && document.contains(messageEl)) {
                                    this.showError(contentEl, event.content);
                                }
                            }
                        } catch (e) {}
                    }
                }

                // Only scroll if this conversation is still active and element is in DOM
                if (this.activeConversationId === conversationId && document.contains(messageEl)) {
                    this.scrollToBottom();
                }
            }

        } catch (error) {
            if (error.name !== 'AbortError') {
                console.error('Streaming error:', error);
                if (this.activeConversationId === conversationId && document.contains(messageEl)) {
                    const contentEl = messageEl.querySelector('.message-content');
                    this.showError(contentEl, error.message);
                }
            }
        } finally {
            // Mark streaming as complete
            if (typeof StreamingTracker !== 'undefined') {
                StreamingTracker.setStreaming(conversationId, false);
            }

            // Only update UI state if this conversation is still active
            if (this.activeConversationId === conversationId && document.contains(messageEl)) {
                const indicatorEl = messageEl.querySelector('.streaming-indicator');
                if (indicatorEl) indicatorEl.remove();

                this.isStreaming = false;
                this.abortController = null;
                this.streamingMessageEl = null;
                this.streamingMessageId = null;
                this.updateSendButton();
                this.updateContextStats();
            }

            // Handle saving for retry case
            if (textContent && conversationId && isRetry) {
                const retryPos = this.retryPosition;

                if (retryPos !== null) {
                    const retryResponse = await fetch(`/api/conversations/${conversationId}/retry`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            position: retryPos,
                            content: textContent,
                            thinking: thinkingContent || null,
                            branch: this.currentBranch
                        })
                    });

                    if (retryResponse.ok) {
                        const retryData = await retryResponse.json();

                        // Update UI only if this conversation is active
                        if (this.activeConversationId === conversationId) {
                            // Update local messages
                            this.messages = this.messages.filter(m => m.position !== retryPos);
                            this.messages.push({
                                id: retryData.id,
                                role: 'assistant',
                                content: textContent,
                                position: retryPos,
                                version: 1,
                                total_versions: 1
                            });

                            // Update the message element
                            if (document.contains(messageEl)) {
                                messageEl.dataset.position = retryPos;
                                messageEl.dataset.messageId = retryData.id;
                            }
                        }
                    }

                    this.retryPosition = null;
                }
            } else if (textContent && !isRetry) {
                // Non-retry: backend already saved during streaming, just update local state
                if (this.activeConversationId === conversationId) {
                    this.messages.push({
                        id: this.streamingMessageId,
                        role: 'assistant',
                        content: textContent,
                        position: position,
                        version: 1,
                        total_versions: 1
                    });
                }
            }

            // Clean up from BackgroundStreams
            if (typeof StreamingTracker !== 'undefined') {
                StreamingTracker.setStreaming(conversationId, false);
            }

            // Scroll if still on same conversation
            if (this.activeConversationId === conversationId) {
                this.scrollToBottom();
            }
        }
    },

    /**
     * Stream response from Agent API (Claude Agent SDK)
     */
    async streamAgentResponse(isRetry = false) {
        this.isStreaming = true;
        this.lastStreamingText = '';
        this.stopStreamingAnimation();
        this.userScrolledAway = false;
        this.toolBlocks = {};
        this.updateSendButton();

        const conversationId = ConversationsManager.getCurrentConversationId();
        const settings = SettingsManager.getSettings();

        // Mark conversation as streaming
        if (typeof StreamingTracker !== 'undefined') {
            StreamingTracker.setStreaming(conversationId, true);
        }

        // Create assistant message element
        const position = this.messages.length;
        const messageEl = this.createMessageElement('assistant', position, 1, 1);
        const container = document.getElementById('messages-container');
        container.appendChild(messageEl);
        this.streamingMessageEl = messageEl;

        // Force scroll to bottom when starting a new response
        this.scrollToBottom(true);

        const accumulatedContent = [];  // Content blocks in chronological order
        const toolResults = [];

        const indicator = document.createElement('span');
        indicator.className = 'streaming-indicator';

        // Track current text block for chronological rendering
        let currentTextBlock = null;
        let currentTextContent = '';  // Text for current block (reset when tool arrives)

        // Create abort controller for this stream
        const abortController = new AbortController();
        this.abortController = abortController;

        try {
            // Build messages for API
            const allMessages = this.messages.map(m => ({
                role: m.role,
                content: m.content
            }));

            // Prune messages
            const apiMessages = this.pruneMessages(allMessages);

            // Use agent streaming endpoint
            const response = await fetch('/api/agent-chat/stream', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: apiMessages,
                    conversation_id: isRetry ? null : conversationId,
                    branch: isRetry ? null : this.currentBranch,
                    system_prompt: settings.system_prompt,
                    model: settings.model
                }),
                signal: abortController.signal
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            const contentEl = messageEl.querySelector('.message-content');
            contentEl.appendChild(indicator);

            // Helper to finalize current text block
            const finalizeTextBlock = () => {
                if (currentTextBlock && currentTextContent.trim()) {
                    this.renderMarkdownContent(currentTextBlock, currentTextContent);
                }
                currentTextBlock = null;
                currentTextContent = '';
            };

            // Helper to ensure we have a text block for text content
            const ensureTextBlock = () => {
                if (!currentTextBlock) {
                    currentTextBlock = document.createElement('div');
                    currentTextBlock.className = 'agent-text-block';
                    contentEl.insertBefore(currentTextBlock, indicator);
                }
            };

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const event = JSON.parse(line.slice(6));

                            if (event.type === 'message_id') {
                                this.streamingMessageId = event.id;
                                messageEl.dataset.messageId = event.id;
                            } else if (event.type === 'session_id') {
                                // Store session ID for conversation resumption
                                this.agentSessionId = event.session_id;
                                console.log('Agent session ID:', event.session_id);
                            } else if (event.type === 'text') {
                                currentTextContent += event.content;

                                if (this.activeConversationId === conversationId && document.contains(messageEl)) {
                                    ensureTextBlock();
                                    // Update current text block with streaming content
                                    currentTextBlock.innerHTML = this.renderMarkdownToHtml(currentTextContent);
                                }
                            } else if (event.type === 'tool_use') {
                                // Push any pending text to accumulated content before the tool
                                if (currentTextContent.trim()) {
                                    accumulatedContent.push({ type: 'text', text: currentTextContent });
                                }
                                // Finalize text block for display
                                if (this.activeConversationId === conversationId && document.contains(messageEl)) {
                                    finalizeTextBlock();
                                    const toolBlock = this.createToolUseBlock(event.name, event.input, event.id);
                                    // Insert before the indicator
                                    contentEl.insertBefore(toolBlock, indicator);
                                    this.toolBlocks[event.id] = toolBlock;
                                }
                                // Reset text tracking for next text block
                                currentTextContent = '';
                                currentTextBlock = null;

                                accumulatedContent.push({
                                    type: 'tool_use',
                                    id: event.id,
                                    name: event.name,
                                    input: event.input
                                });
                            } else if (event.type === 'tool_result') {
                                // Update tool block with result
                                if (this.activeConversationId === conversationId) {
                                    this.updateToolResult(event.tool_use_id, event.content, event.is_error);
                                }
                                toolResults.push({
                                    tool_use_id: event.tool_use_id,
                                    content: event.content,
                                    is_error: event.is_error || false
                                });
                            } else if (event.type === 'error') {
                                if (this.activeConversationId === conversationId && document.contains(messageEl)) {
                                    finalizeTextBlock();
                                    this.showError(contentEl, event.content);
                                }
                            }
                        } catch (e) {
                            console.error('Error parsing event:', e);
                        }
                    }
                }

                if (this.activeConversationId === conversationId && document.contains(messageEl)) {
                    this.scrollToBottom();
                }
            }

        } catch (error) {
            if (error.name !== 'AbortError') {
                console.error('Agent streaming error:', error);
                if (this.activeConversationId === conversationId && document.contains(messageEl)) {
                    const contentEl = messageEl.querySelector('.message-content');
                    this.showError(contentEl, error.message);
                }
            }
        } finally {
            // Mark streaming as complete
            if (typeof StreamingTracker !== 'undefined') {
                StreamingTracker.setStreaming(conversationId, false);
            }

            if (this.activeConversationId === conversationId && document.contains(messageEl)) {
                const indicatorEl = messageEl.querySelector('.streaming-indicator');
                if (indicatorEl) indicatorEl.remove();

                this.isStreaming = false;
                this.abortController = null;
                this.streamingMessageEl = null;
                this.streamingMessageId = null;
                this.updateSendButton();
                this.updateContextStats();
            }

            // Push any remaining text to accumulated content
            if (currentTextContent.trim()) {
                accumulatedContent.push({ type: 'text', text: currentTextContent });
            }

            // Update local messages array
            if (accumulatedContent.length > 0) {
                // Build final content - could be just text or mixed
                let finalContent;
                // Check if it's only a single text block
                if (accumulatedContent.length === 1 && accumulatedContent[0].type === 'text') {
                    finalContent = accumulatedContent[0].text;
                } else {
                    finalContent = accumulatedContent;
                }

                if (this.activeConversationId === conversationId) {
                    this.messages.push({
                        id: this.streamingMessageId,
                        role: 'assistant',
                        content: finalContent,
                        tool_results: toolResults.length > 0 ? toolResults : undefined,
                        position: position,
                        version: 1,
                        total_versions: 1
                    });
                }
            }

            // Clean up from BackgroundStreams
            if (typeof StreamingTracker !== 'undefined') {
                StreamingTracker.setStreaming(conversationId, false);
            }

            if (this.activeConversationId === conversationId) {
                this.scrollToBottom();
            }
        }
    },

    /**
     * Create a tool use block element
     */
    createToolUseBlock(toolName, input, toolUseId) {
        const el = document.createElement('div');
        el.className = 'tool-use-block collapsed';
        el.dataset.toolUseId = toolUseId;

        // Check if this is a subagent (Task) tool
        const isSubagent = toolName === 'Task' || toolName.toLowerCase().includes('task');

        const icon = this.getToolIcon(toolName);
        const displayName = this.getToolDisplayName(toolName);
        const inputPreview = typeof input === 'object' ? JSON.stringify(input, null, 2) : String(input);

        // Get a brief description for the collapsed state
        let briefDesc = '';
        if (typeof input === 'object') {
            if (input.command) briefDesc = input.command.substring(0, 50) + (input.command.length > 50 ? '...' : '');
            else if (input.file_path) briefDesc = input.file_path;
            else if (input.pattern) briefDesc = input.pattern;
            else if (input.query) briefDesc = input.query.substring(0, 50) + (input.query.length > 50 ? '...' : '');
            else if (input.prompt) briefDesc = input.prompt.substring(0, 50) + (input.prompt.length > 50 ? '...' : '');
            else if (input.description) briefDesc = input.description;
        }

        el.innerHTML = `
            <div class="tool-header" role="button" tabindex="0" aria-expanded="false">
                <span class="tool-expand-icon">▶</span>
                <span class="tool-icon">${icon}</span>
                <span class="tool-name">${this.escapeHtml(displayName)}</span>
                ${briefDesc ? `<span class="tool-brief">${this.escapeHtml(briefDesc)}</span>` : ''}
                <span class="tool-status running">Running...</span>
            </div>
            <div class="tool-details" style="display: none;">
                <div class="tool-input">
                    <div class="tool-section-label">Input</div>
                    <pre>${this.escapeHtml(inputPreview)}</pre>
                </div>
                ${isSubagent ? '<div class="subagent-transcript" style="display: none;"><div class="tool-section-label">Subagent Transcript</div><div class="subagent-content"></div></div>' : ''}
                <div class="tool-result" style="display: none;"></div>
            </div>
        `;

        // Add click handler to toggle collapsed state
        const header = el.querySelector('.tool-header');
        header.addEventListener('click', () => {
            const isCollapsed = el.classList.contains('collapsed');
            el.classList.toggle('collapsed');
            header.setAttribute('aria-expanded', isCollapsed);
            const expandIcon = el.querySelector('.tool-expand-icon');
            expandIcon.textContent = isCollapsed ? '▼' : '▶';
            const details = el.querySelector('.tool-details');
            details.style.display = isCollapsed ? 'block' : 'none';
        });

        // Keyboard accessibility
        header.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                header.click();
            }
        });

        return el;
    },

    /**
     * Update a tool block with its result
     */
    updateToolResult(toolUseId, content, isError) {
        const toolBlock = this.toolBlocks[toolUseId] ||
            document.querySelector(`[data-tool-use-id="${toolUseId}"]`);

        if (!toolBlock) return;

        const statusEl = toolBlock.querySelector('.tool-status');
        if (statusEl) {
            statusEl.textContent = isError ? 'Error' : 'Done';
            statusEl.classList.remove('running');
            statusEl.classList.add(isError ? 'error' : 'success');
        }

        const resultEl = toolBlock.querySelector('.tool-result');
        if (resultEl) {
            // Check if the result is a GIF from gif_search.py
            const gifResult = this.parseGifResult(content);
            if (gifResult && gifResult.url) {
                // Render as GIF image
                resultEl.innerHTML = '<div class="tool-section-label">Result</div>';
                const gifContainer = document.createElement('div');
                gifContainer.className = 'gif-result';
                gifContainer.innerHTML = `
                    <img src="${this.escapeHtml(gifResult.url)}"
                         alt="${this.escapeHtml(gifResult.title || 'GIF')}"
                         class="gif-image"
                         loading="lazy">
                    ${gifResult.title ? `<div class="gif-title">${this.escapeHtml(gifResult.title)}</div>` : ''}
                `;
                resultEl.appendChild(gifContainer);
                resultEl.style.display = 'block';
                resultEl.classList.add('gif-result-container');
                return;
            }

            // Only show result section if there's content or an error
            if (content || isError) {
                // Truncate long results for display
                const displayContent = content && content.length > 1000
                    ? content.substring(0, 1000) + '... (truncated)'
                    : content;
                resultEl.innerHTML = `<div class="tool-section-label">Result</div><pre>${this.escapeHtml(displayContent || (isError ? 'Tool execution failed' : 'Success'))}</pre>`;
                resultEl.style.display = 'block';
                if (isError) {
                    resultEl.classList.add('error');
                }
            }
            // If no content and no error, hide the result section (tool completed silently)
        }
    },

    /**
     * Add a child tool call to a subagent's transcript
     */
    addSubagentToolCall(parentToolUseId, childToolBlock) {
        const parentBlock = this.toolBlocks[parentToolUseId] ||
            document.querySelector(`[data-tool-use-id="${parentToolUseId}"]`);

        if (!parentBlock) return;

        const transcriptEl = parentBlock.querySelector('.subagent-transcript');
        if (transcriptEl) {
            transcriptEl.style.display = 'block';
            const contentEl = transcriptEl.querySelector('.subagent-content');
            if (contentEl) {
                contentEl.appendChild(childToolBlock);
            }
        }
    },

    /**
     * Try to parse content as a GIF result from gif_search.py
     */
    parseGifResult(content) {
        if (!content || typeof content !== 'string') return null;

        try {
            const parsed = JSON.parse(content);
            if (parsed.type === 'gif' && parsed.url) {
                return parsed;
            }
        } catch (e) {
            // Not JSON, check if content contains GIF URL inline
            // Look for giphy.com URLs in the content
            const giphyMatch = content.match(/https:\/\/[^\s"]*giphy\.com[^\s"]*/i);
            if (giphyMatch) {
                return { url: giphyMatch[0], title: '' };
            }
        }
        return null;
    },

    /**
     * Get icon for a tool
     */
    getToolIcon(toolName) {
        const icons = {
            'Read': '&#128214;',    // Open book
            'Write': '&#9997;',     // Writing hand
            'Edit': '&#9997;',      // Writing hand
            'Bash': '&#128187;',    // Computer
            'Glob': '&#128269;',    // Magnifying glass
            'Grep': '&#128270;',    // Magnifying glass right
            'mcp__gif-tools__search_gif': '&#127912;',  // Film frames (GIF)
            'search_gif': '&#127912;',  // Film frames (GIF)
        };
        return icons[toolName] || '&#128295;';  // Wrench as default
    },

    /**
     * Get display name for a tool (handles MCP tool name format)
     */
    getToolDisplayName(toolName) {
        // Handle MCP tool format: mcp__server-name__tool_name
        if (toolName.startsWith('mcp__')) {
            const parts = toolName.split('__');
            if (parts.length >= 3) {
                // Return just the tool name part, formatted nicely
                return parts[2].replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
            }
        }
        return toolName;
    },

    /**
     * Update the version nav badge on any message
     */
    updateMessageVersionNav(position, currentVersion, totalVersions) {
        const container = document.getElementById('messages-container');
        const msgEl = container.querySelector(`.message[data-position="${position}"]`);

        if (!msgEl) return;

        // Update data attributes
        msgEl.dataset.version = currentVersion;
        msgEl.dataset.totalVersions = totalVersions;

        const versionBadge = msgEl.querySelector('.version-badge');
        if (versionBadge) {
            if (totalVersions > 1) {
                versionBadge.style.display = '';
                const indicator = versionBadge.querySelector('.version-indicator');
                if (indicator) {
                    indicator.textContent = `${currentVersion}/${totalVersions}`;
                }
            } else {
                versionBadge.style.display = 'none';
            }
        }
    },

    /**
     * Create a message element with action buttons
     * For user messages: Copy + Edit + Version Nav (branches off user messages)
     * For assistant messages: Copy + Retry
     */
    createMessageElement(role, position = 0, version = 1, totalVersions = 1, nextVersionInfo = null, timestamp = null) {
        const el = document.createElement('div');
        el.className = `message ${role}`;
        el.dataset.position = position;
        el.dataset.version = version;
        el.dataset.totalVersions = totalVersions;

        let actionsHtml = '';
        if (role === 'user') {
            // User messages get Copy, Edit, Delete, and Version Nav (branching happens at user messages)
            const showVersionNav = totalVersions > 1;
            actionsHtml = `
                <div class="message-actions">
                    <button class="action-btn copy-btn" title="Copy">📋</button>
                    <button class="action-btn edit-btn" title="Edit">✏️</button>
                    <button class="action-btn delete-btn" title="Delete this and all following messages">🗑️</button>
                    <div class="version-badge" style="${showVersionNav ? '' : 'display: none;'}">
                        <button class="version-nav-btn prev-btn" title="Previous version">◀</button>
                        <span class="version-indicator">${version}/${totalVersions}</span>
                        <button class="version-nav-btn next-btn" title="Next version">▶</button>
                    </div>
                </div>
            `;
        } else {
            // Assistant messages get Copy and Retry
            actionsHtml = `
                <div class="message-actions">
                    <button class="action-btn copy-btn" title="Copy">📋</button>
                    <button class="action-btn retry-btn" title="Regenerate response">🔄</button>
                </div>
            `;
        }

        // Format timestamp if provided
        let timestampHtml = '';
        if (timestamp) {
            const time = this.formatTimestamp(timestamp);
            timestampHtml = `<div class="message-timestamp">${time}</div>`;
        }

        el.innerHTML = `
            <div class="message-content"></div>
            ${timestampHtml}
            ${actionsHtml}
        `;

        // Bind action buttons
        const copyBtn = el.querySelector('.copy-btn');
        const editBtn = el.querySelector('.edit-btn');
        const retryBtn = el.querySelector('.retry-btn');
        const deleteBtn = el.querySelector('.delete-btn');
        const prevBtn = el.querySelector('.prev-btn');
        const nextBtn = el.querySelector('.next-btn');

        if (copyBtn) {
            copyBtn.addEventListener('click', () => this.copyMessage(el));
        }
        if (editBtn) {
            editBtn.addEventListener('click', () => this.editMessage(position));
        }
        if (retryBtn) {
            // Retry regenerates the assistant response at this position
            retryBtn.addEventListener('click', () => this.retryMessage(position));
        }
        if (deleteBtn) {
            // Delete this message and all following messages
            deleteBtn.addEventListener('click', () => this.deleteMessagesFrom(position));
        }
        if (prevBtn) {
            // Version nav - switches branch at this position
            prevBtn.addEventListener('click', () => this.switchVersion(position, -1));
        }
        if (nextBtn) {
            nextBtn.addEventListener('click', () => this.switchVersion(position, 1));
        }

        return el;
    },

    /**
     * Format timestamp for display
     */
    formatTimestamp(timestamp) {
        if (!timestamp) return '';

        const date = new Date(timestamp);
        const now = new Date();
        const diffMs = now - date;
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffMs / 86400000);

        // Less than 1 minute: "Just now"
        if (diffMins < 1) return 'Just now';
        // Less than 1 hour: "X mins ago"
        if (diffHours < 1) return `${diffMins} ${diffMins === 1 ? 'min' : 'mins'} ago`;
        // Less than 24 hours: "X hours ago"
        if (diffDays < 1) return `${diffHours} ${diffHours === 1 ? 'hour' : 'hours'} ago`;
        // Less than 7 days: "X days ago"
        if (diffDays < 7) return `${diffDays} ${diffDays === 1 ? 'day' : 'days'} ago`;
        // Older: show date
        return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
    },

    /**
     * Render a message to the UI
     */
    renderMessage(msg, forceScroll = false) {
        const { role, content, thinking, tool_results, position = 0, version = 1, total_versions = 1, created_at } = msg;
        console.log('[renderMessage]', {role, position, contentLength: typeof content === 'string' ? content.length : 'array', content: typeof content === 'string' ? content.substring(0, 100) : content});

        // Version info is now passed directly for user messages
        const el = this.createMessageElement(role, position, version, total_versions, null, created_at);
        const contentEl = el.querySelector('.message-content');

        if (thinking) {
            const thinkingEl = this.createThinkingBlock();
            this.updateThinkingBlock(thinkingEl, thinking);
            contentEl.appendChild(thinkingEl);
        }

        if (Array.isArray(content)) {
            // Separate files from other content (files always go first)
            const files = content.filter(b => b.type === 'image' || b.type === 'document');
            const textFiles = content.filter(b => b.type === 'text' && b.text?.startsWith('File: '));
            const otherContent = content.filter(b =>
                b.type !== 'image' && b.type !== 'document' &&
                !(b.type === 'text' && b.text?.startsWith('File: '))
            );

            if (files.length > 0 || textFiles.length > 0) {
                const filesEl = document.createElement('div');
                filesEl.className = 'message-files';

                files.forEach(file => {
                    const fileEl = document.createElement('div');
                    fileEl.className = 'message-file';
                    if (file.type === 'image' && file.source?.data) {
                        fileEl.innerHTML = `<img src="data:${file.source.media_type};base64,${file.source.data}" alt="Image">`;
                    } else if (file.type === 'document') {
                        fileEl.innerHTML = '<span class="message-file-icon">PDF</span><span>PDF Document</span>';
                    }
                    filesEl.appendChild(fileEl);
                });

                textFiles.forEach(tf => {
                    const fileEl = document.createElement('div');
                    fileEl.className = 'message-file';
                    const match = tf.text.match(/^File: (.+?)\n/);
                    const filename = match ? match[1] : 'Text file';
                    fileEl.innerHTML = `<span class="message-file-icon">TXT</span><span>${this.escapeHtml(filename)}</span>`;
                    filesEl.appendChild(fileEl);
                });

                contentEl.appendChild(filesEl);
            }

            // Build a map of tool results by tool_use_id
            const toolResultsMap = {};
            if (tool_results) {
                tool_results.forEach(tr => {
                    toolResultsMap[tr.tool_use_id] = tr;
                });
            }

            // Render content blocks in order (chronologically)
            otherContent.forEach(block => {
                if (block.type === 'tool_use') {
                    const toolEl = this.createToolUseBlock(block.name, block.input, block.id);
                    contentEl.appendChild(toolEl);
                    // Store reference for later status update
                    this.toolBlocks[block.id] = toolEl;

                    // Update tool status - mark as done for loaded messages
                    const result = toolResultsMap[block.id];
                    if (result) {
                        this.updateToolResult(block.id, result.content, result.is_error);
                    } else {
                        // No explicit result - assume success for loaded messages
                        this.updateToolResult(block.id, null, false);
                    }
                } else if (block.type === 'text' && block.text) {
                    const textEl = document.createElement('div');
                    textEl.className = 'agent-text-block';
                    textEl.innerHTML = this.formatText(block.text);
                    contentEl.appendChild(textEl);
                }
            });
        } else {
            contentEl.innerHTML += this.formatText(content);
        }

        // Add copy buttons to code blocks
        this.addCodeCopyButtons(contentEl);

        const container = document.getElementById('messages-container');
        container.appendChild(el);
        this.scrollToBottom(forceScroll);
    },

    createThinkingBlock() {
        const el = document.createElement('div');
        el.className = 'thinking-block';
        el.innerHTML = `
            <div class="thinking-header" onclick="this.parentElement.classList.toggle('expanded')">
                <span class="thinking-toggle">></span>
                <span class="thinking-label">Thinking...</span>
            </div>
            <div class="thinking-content"></div>
        `;

        return el;
    },

    updateThinkingBlock(el, content) {
        const contentEl = el.querySelector('.thinking-content');
        contentEl.textContent = content;

        const label = el.querySelector('.thinking-label');
        const lines = content.split('\n').length;
        label.textContent = `Thinking (${lines} lines)`;
    },

    /**
     * Update message content with smooth streaming appearance
     * Instead of replacing all HTML at once, we try to preserve existing content
     * and only update what changed for smoother visual feedback
     */
    updateMessageContent(contentEl, text, indicator) {
        const thinkingBlock = contentEl.querySelector('.thinking-block');
        const wasExpanded = thinkingBlock?.classList.contains('expanded');

        // Get the current text container or create one
        let textContainer = contentEl.querySelector('.message-text');
        if (!textContainer) {
            // Clear existing content but preserve thinking block and indicator
            Array.from(contentEl.children).forEach(child => {
                if (!child.classList.contains('thinking-block') &&
                    !child.classList.contains('streaming-indicator')) {
                    child.remove();
                }
            });

            textContainer = document.createElement('div');
            textContainer.className = 'message-text';
            contentEl.appendChild(textContainer);
        }

        // For streaming, we want smooth character-by-character appearance
        // Check if this is an incremental update (new text starts with old text)
        const currentText = textContainer.dataset.rawText || '';

        if (text.startsWith(currentText) && currentText.length > 0) {
            // Incremental update - only add new characters
            const newChars = text.slice(currentText.length);
            if (newChars) {
                // Append new content smoothly
                this.appendFormattedText(textContainer, currentText, text);
            }
        } else {
            // Full replacement (initial render or content changed significantly)
            textContainer.innerHTML = this.formatText(text);
            this.addCodeCopyButtons(textContainer);
        }

        // Store raw text for comparison
        textContainer.dataset.rawText = text;

        // Re-add thinking block at the beginning if it existed
        if (thinkingBlock) {
            contentEl.insertBefore(thinkingBlock, contentEl.firstChild);
            if (wasExpanded) {
                thinkingBlock.classList.add('expanded');
            }
        }

        // Ensure indicator is at the end
        if (indicator && indicator.parentNode !== contentEl) {
            contentEl.appendChild(indicator);
        }
    },

    /**
     * Append new text to existing content smoothly
     * Re-renders if markdown structure might have changed, otherwise just appends
     */
    appendFormattedText(container, oldText, newText) {
        // Check if we're in the middle of a markdown structure that needs re-rendering
        const needsRerender =
            // In the middle of a code block
            (newText.match(/```/g) || []).length % 2 !== 0 ||
            // In the middle of bold/italic
            (newText.match(/\*\*/g) || []).length % 2 !== 0 ||
            // In the middle of a list or heading (last line starts with special char)
            /\n[#\-\*\d]/.test(newText.slice(-50));

        if (needsRerender || !container.lastChild) {
            // Full re-render needed
            container.innerHTML = this.formatText(newText);
            this.addCodeCopyButtons(container);
        } else {
            // Try to append smoothly - re-render last paragraph/element
            // This is a simplified approach: just re-render but browser will diff efficiently
            const html = this.formatText(newText);
            if (container.innerHTML !== html) {
                container.innerHTML = html;
                this.addCodeCopyButtons(container);
            }
        }
    },

    showError(contentEl, message) {
        const errorEl = document.createElement('div');
        errorEl.style.color = 'var(--color-error)';
        errorEl.textContent = `Error: ${message}`;
        contentEl.appendChild(errorEl);
    },

    formatText(text) {
        if (!text) return '';

        if (typeof marked !== 'undefined') {
            try {
                let html = marked.parse(text);
                // Auto-embed Giphy URLs as images
                html = this.embedGiphyUrls(html);
                return html;
            } catch (e) {
                console.error('Markdown parsing error:', e);
            }
        }

        let html = this.escapeHtml(text);
        html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
        html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
        html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
        html = html.replace(/\n/g, '<br>');
        // Auto-embed Giphy URLs as images
        html = this.embedGiphyUrls(html);
        return html;
    },

    /**
     * Render markdown text to HTML string
     */
    renderMarkdownToHtml(text) {
        return this.formatText(text);
    },

    /**
     * Render markdown content into an element
     */
    renderMarkdownContent(element, text) {
        if (element && text) {
            element.innerHTML = this.formatText(text);
            // Highlight code blocks if available
            if (typeof hljs !== 'undefined') {
                element.querySelectorAll('pre code').forEach(block => {
                    hljs.highlightElement(block);
                });
            }
        }
    },

    /**
     * Replace Giphy URLs with embedded GIF images
     */
    embedGiphyUrls(html) {
        // Match Giphy gif URLs (both in links and standalone)
        // Pattern for URLs ending in .gif from giphy.com
        const giphyGifPattern = /(https:\/\/media[0-9]*\.giphy\.com\/[^\s"<>]+\.gif)/gi;

        return html.replace(giphyGifPattern, (match, url) => {
            // If it's already in an img tag, leave it
            const imgPattern = new RegExp(`<img[^>]*src=["']${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`, 'i');
            if (imgPattern.test(html)) {
                return match;
            }
            // Replace the URL with an embedded GIF
            return `<div class="embedded-gif"><img src="${url}" alt="GIF" class="gif-image" loading="lazy"></div>`;
        });
    },

    /**
     * Add copy buttons to code blocks in a container
     */
    addCodeCopyButtons(container) {
        const codeBlocks = container.querySelectorAll('pre');

        codeBlocks.forEach(pre => {
            // Skip if already wrapped
            if (pre.parentElement?.classList.contains('code-block-wrapper')) {
                return;
            }

            // Create wrapper
            const wrapper = document.createElement('div');
            wrapper.className = 'code-block-wrapper';

            // Wrap the pre element
            pre.parentNode.insertBefore(wrapper, pre);
            wrapper.appendChild(pre);

            // Create copy button
            const copyBtn = document.createElement('button');
            copyBtn.className = 'code-copy-btn';
            copyBtn.textContent = 'Copy';
            copyBtn.addEventListener('click', async () => {
                const codeEl = pre.querySelector('code');
                const code = codeEl ? codeEl.textContent : pre.textContent;

                try {
                    await navigator.clipboard.writeText(code);
                    copyBtn.textContent = 'Copied!';
                    copyBtn.classList.add('copied');

                    setTimeout(() => {
                        copyBtn.textContent = 'Copy';
                        copyBtn.classList.remove('copied');
                    }, 2000);
                } catch (error) {
                    console.error('Failed to copy code:', error);
                    copyBtn.textContent = 'Failed';
                    setTimeout(() => {
                        copyBtn.textContent = 'Copy';
                    }, 2000);
                }
            });

            wrapper.appendChild(copyBtn);
        });
    },

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    },

    scrollToBottom(force = false) {
        const container = document.getElementById('messages-container');

        if (force) {
            // Force scroll to bottom (e.g., when sending a new message)
            container.scrollTop = container.scrollHeight;
            this.userScrolledAway = false;
        } else {
            // Respect user's scroll intent - if they scrolled away, don't auto-scroll
            if (this.userScrolledAway) {
                return;
            }

            // Only auto-scroll if user is at the bottom (within 30px)
            const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
            if (distanceFromBottom < 30) {
                container.scrollTop = container.scrollHeight;
            }
        }
    },

    updateContextStats() {
        const settings = SettingsManager?.getSettings() || {};
        const model = settings.model || 'claude-3-5-sonnet-20241022';
        const modelLimit = this.MODEL_LIMITS[model] || 200000;

        // Calculate total tokens
        let totalTokens = 0;
        this.messages.forEach(msg => {
            totalTokens += this.estimateTokens(msg.content);
        });

        // Update UI
        document.getElementById('stat-messages').textContent = this.messages.length;

        const contextPercentage = ((totalTokens / modelLimit) * 100).toFixed(0);
        const tokensFormatted = totalTokens >= 1000 ? `${(totalTokens / 1000).toFixed(1)}K` : totalTokens;
        const limitFormatted = modelLimit >= 1000 ? `${(modelLimit / 1000).toFixed(0)}K` : modelLimit;
        document.getElementById('stat-context').textContent = `${tokensFormatted} / ${limitFormatted} (${contextPercentage}%)`;

        // Show/hide pruned messages stat
        const prunedContainer = document.getElementById('stat-pruned-container');
        if (this.lastPrunedCount > 0) {
            prunedContainer.style.display = '';
            document.getElementById('stat-pruned').textContent = `${this.lastPrunedCount}`;
        } else {
            prunedContainer.style.display = 'none';
        }
    },

    stopStreaming() {
        if (this.abortController) {
            this.abortController.abort();
        }
    }
};

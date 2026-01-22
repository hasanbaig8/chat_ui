/**
 * Chat and streaming module with edit/retry and branching support
 */

const ChatManager = {
    messages: [],  // Array of {role, content, position, version, total_versions}
    isStreaming: false,
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

                // Reload conversation from DB
                const convResponse = await fetch(`/api/conversations/${currentId}`);
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
        // Verify this is still the conversation we want to load
        if (this.activeConversationId !== conversation.id) {
            console.log('loadConversation skipped - activeConversationId changed');
            return;
        }

        // Stop any existing polling
        this.stopPolling();

        this.messages = [];
        this.clearMessagesUI();
        this.streamingMessageEl = null;
        this.streamingMessageId = null;

        if (conversation.messages && conversation.messages.length > 0) {
            document.getElementById('welcome-message').style.display = 'none';

            // First, populate all messages with IDs for parent tracking
            conversation.messages.forEach(msg => {
                this.messages.push({
                    id: msg.id,
                    role: msg.role,
                    content: msg.content,
                    position: msg.position,
                    version: msg.current_version || msg.version,
                    total_versions: msg.total_versions || 1,
                    parent_message_id: msg.parent_message_id
                });
            });

            // Then render all messages
            conversation.messages.forEach(msg => {
                this.renderMessage({
                    id: msg.id,
                    role: msg.role,
                    content: msg.content,
                    thinking: msg.thinking,
                    position: msg.position,
                    version: msg.current_version || msg.version,
                    total_versions: msg.total_versions || 1
                });
            });

            // Force scroll to bottom when loading a conversation
            this.scrollToBottom(true);
            this.updateContextStats();
        } else {
            document.getElementById('welcome-message').style.display = '';
        }

        // Check if this conversation is streaming on the server
        if (typeof StreamingTracker !== 'undefined') {
            const isStreaming = await StreamingTracker.checkServerStatus(conversation.id);
            if (isStreaming) {
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
            }
            this.isStreaming = isStreaming;
        } else {
            this.isStreaming = false;
            this.lastStreamingText = '';
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

                    // Reload the conversation from DB
                    const convResponse = await fetch(`/api/conversations/${conversationId}`);
                    const conversation = await convResponse.json();

                    if (this.activeConversationId === conversationId) {
                        this.loadConversation(conversation);
                    }
                    return;
                }

                // Still streaming - reload to get latest content
                const convResponse = await fetch(`/api/conversations/${conversationId}`);
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
            role: msg.role,
            content: msg.content,
            position: msg.position,
            version: msg.current_version || msg.version,
            total_versions: msg.total_versions || 1
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
        this.clearMessagesUI();
        this.streamingMessageEl = null;
        this.streamingMessageId = null;
        this.isStreaming = false;
        this.userScrolledAway = false;
        this.abortController = null;
        this.lastStreamingText = '';
        document.getElementById('welcome-message').style.display = '';
        this.updateContextStats();
        this.updateSendButton();
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
        this.clearMessagesUI();
        this.streamingMessageEl = null;
        this.streamingMessageId = null;
        this.lastStreamingText = '';

        // Show loading state or welcome message
        document.getElementById('welcome-message').style.display = '';

        // Reset streaming state - will be updated when conversation loads
        this.isStreaming = false;
        this.userScrolledAway = false;
        this.updateSendButton();
        this.updateContextStats();
    },

    clearMessagesUI() {
        const container = document.getElementById('messages-container');
        container.innerHTML = '<div class="welcome-message" id="welcome-message" style="display: none;"><h2>Welcome to Claude Chat</h2><p>Start a conversation by typing a message below.</p></div>';
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
        } else if (this.messages.length === 0) {
            await ConversationsManager.updateConversationTitle(
                conversationId,
                ConversationsManager.generateTitle(content)
            );
        }

        document.getElementById('welcome-message').style.display = 'none';

        // Get parent message ID (the last assistant message, if any)
        const lastMsg = this.messages.length > 0 ? this.messages[this.messages.length - 1] : null;
        const parentMessageId = lastMsg && lastMsg.role === 'assistant' ? lastMsg.id : null;

        // Add user message to backend first to get ID
        const savedMsg = await ConversationsManager.addMessage('user', content, null, parentMessageId);

        // Add user message to local state with ID
        const userMsg = {
            id: savedMsg?.id,
            role: 'user',
            content,
            position: savedMsg?.position ?? this.messages.length,
            version: 1,
            total_versions: 1,
            parent_message_id: parentMessageId
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
        saveBtn.textContent = '✓ Save';
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
        cancelBtn.textContent = '✕ Cancel';
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
     * Confirm and save the edit
     */
    async confirmEdit(position, newContent) {
        if (this.editingPosition !== position) return;

        const conversationId = ConversationsManager.getCurrentConversationId();
        if (!conversationId) return;

        const container = document.getElementById('messages-container');
        const userMsgEl = container.querySelector(`.message.user[data-position="${position}"]`);

        // Remove messages from the position AFTER this one (clear assistant response and beyond)
        this.removeMessagesFromPosition(position + 1);

        // Clear editing state
        this.editingPosition = null;
        this.originalEditContent = null;

        // Save edit via API and get new version info
        const editResponse = await fetch(`/api/conversations/${conversationId}/edit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ position, content: newContent })
        });
        const editData = await editResponse.json();
        const newVersion = editData.version;

        // Update internal message with new version info
        const msgIndex = this.messages.findIndex(m => m.position === position);
        if (msgIndex !== -1) {
            this.messages[msgIndex].content = newContent;
            this.messages[msgIndex].version = newVersion;
            this.messages[msgIndex].total_versions = newVersion;
        }

        // Update the user message UI
        if (userMsgEl) {
            // Remove editing class
            userMsgEl.classList.remove('editing');

            const contentEl = userMsgEl.querySelector('.message-content');
            if (contentEl) {
                contentEl.innerHTML = this.formatText(newContent);
            }

            // Show action buttons again
            const actionsEl = userMsgEl.querySelector('.message-actions');
            if (actionsEl) actionsEl.style.display = '';

            // Update version badge (creates it if needed, or shows/updates it)
            userMsgEl.dataset.version = newVersion;
            userMsgEl.dataset.totalVersions = newVersion;

            let versionBadge = userMsgEl.querySelector('.version-badge');
            if (!versionBadge && newVersion > 1) {
                // Need to create the version badge
                versionBadge = document.createElement('div');
                versionBadge.className = 'version-badge';
                versionBadge.innerHTML = `
                    <button class="version-nav-btn prev-btn" title="Previous version">◀</button>
                    <span class="version-indicator">${newVersion}/${newVersion}</span>
                    <button class="version-nav-btn next-btn" title="Next version">▶</button>
                `;
                actionsEl.appendChild(versionBadge);

                // Bind events
                versionBadge.querySelector('.prev-btn').addEventListener('click', () => this.switchVersion(position, -1));
                versionBadge.querySelector('.next-btn').addEventListener('click', () => this.switchVersion(position, 1));
            } else if (versionBadge) {
                // Update existing badge
                if (newVersion > 1) {
                    versionBadge.style.display = '';
                    versionBadge.querySelector('.version-indicator').textContent = `${newVersion}/${newVersion}`;
                } else {
                    versionBadge.style.display = 'none';
                }
            }
        }

        // Stream new response
        await this.streamResponseFromPosition(position + 1, false);
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
                copyBtn.textContent = '✓';
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
                copyBtn.textContent = '✓';
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
     * Retry an assistant message (called from user message with assistant position)
     */
    async retryMessage(assistantPosition) {
        if (this.isStreaming) return;

        const conversationId = ConversationsManager.getCurrentConversationId();
        if (!conversationId) return;

        // Check if there's an existing assistant message at this position
        const existingAssistant = this.messages.find(m => m.position === assistantPosition && m.role === 'assistant');

        // Remove messages from this position onwards in UI FIRST
        this.removeMessagesFromPosition(assistantPosition);

        // Force a repaint to ensure UI is cleared before streaming
        await new Promise(resolve => requestAnimationFrame(resolve));

        // Stream new response - mark as retry if there was an existing assistant message
        await this.streamResponseFromPosition(assistantPosition, existingAssistant ? true : false);
    },

    /**
     * Switch to a different version at a position
     */
    async switchVersion(position, direction) {
        const msg = this.messages.find(m => m.position === position);
        if (!msg || msg.total_versions <= 1) return;

        let newVersion = msg.version + direction;
        if (newVersion < 1) newVersion = msg.total_versions;
        if (newVersion > msg.total_versions) newVersion = 1;

        const conversationId = ConversationsManager.getCurrentConversationId();
        if (!conversationId) return;

        await fetch(`/api/conversations/${conversationId}/switch-version`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ position, version: newVersion })
        });

        // Reload conversation
        await ConversationsManager.selectConversation(conversationId);
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
     * Stream response starting from a position (for edit/retry)
     * @param {number} position - The position to stream from
     * @param {boolean} isRetry - If true, this is a retry of an existing assistant message
     */
    async streamResponseFromPosition(position, isRetry = false) {
        const conversationId = ConversationsManager.getCurrentConversationId();
        if (!conversationId) return;

        // Get messages up to this position
        const response = await fetch(`/api/conversations/${conversationId}/messages-up-to/${position}`);
        const data = await response.json();

        // Update internal messages with IDs
        this.messages = data.messages.map(m => ({
            id: m.id,
            role: m.role,
            content: m.content,
            position: m.position,
            version: m.version,
            total_versions: m.total_versions || 1,
            parent_message_id: m.parent_message_id
        }));

        // Store the retry position if this is a retry
        this.retryPosition = isRetry ? position : null;

        await this.streamResponse(isRetry);
    },

    /**
     * Stream response from API
     * Backend now saves streaming content directly to DB
     */
    async streamResponse(isRetry = false) {
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

            // Prune messages to keep context under threshold
            const apiMessages = this.pruneMessages(allMessages);

            // Get the user message ID (the last message) to pass as parent
            const lastUserMsg = this.messages.length > 0 ? this.messages[this.messages.length - 1] : null;
            const parentMessageId = lastUserMsg && lastUserMsg.role === 'user' ? lastUserMsg.id : null;

            // Pass conversation_id so backend can save streaming content to DB
            const response = await fetch('/api/chat/stream', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: apiMessages,
                    conversation_id: isRetry ? null : conversationId,  // Don't auto-save for retries
                    parent_message_id: isRetry ? null : parentMessageId,  // Link to parent user message
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

            // Handle saving and local state update
            if (textContent && conversationId) {
                if (isRetry) {
                    // Retry case - save as new version
                    const retryPos = this.retryPosition;

                    if (retryPos !== null) {
                        // Find the user message that this is a response to (one position before)
                        const parentUserMsg = this.messages.find(m => m.position === retryPos - 1 && m.role === 'user');
                        const parentMessageId = parentUserMsg?.id || null;

                        const retryResponse = await fetch(`/api/conversations/${conversationId}/retry`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                position: retryPos,
                                content: textContent,
                                thinking: thinkingContent || null,
                                parent_message_id: parentMessageId
                            })
                        });

                        if (retryResponse.ok) {
                            const retryData = await retryResponse.json();

                            // Update UI only if this conversation is active
                            if (this.activeConversationId === conversationId) {
                                // Update local messages - replace any existing at this position
                                this.messages = this.messages.filter(m => m.position !== retryPos);
                                this.messages.push({
                                    id: retryData.id,
                                    role: 'assistant',
                                    content: textContent,
                                    position: retryPos,
                                    version: retryData.version,
                                    total_versions: retryData.version,
                                    parent_message_id: parentMessageId
                                });

                                // Update the message element
                                if (document.contains(messageEl)) {
                                    messageEl.dataset.position = retryPos;
                                    messageEl.dataset.version = retryData.version;
                                    messageEl.dataset.totalVersions = retryData.version;
                                    messageEl.dataset.messageId = retryData.id;
                                }
                            }
                        }

                        this.retryPosition = null;
                    }
                } else {
                    // Non-retry: backend already saved during streaming, just update local state with ID from streaming
                    if (this.activeConversationId === conversationId) {
                        const lastUserMsg = this.messages.length > 0 ? this.messages[this.messages.length - 1] : null;
                        this.messages.push({
                            id: this.streamingMessageId,
                            role: 'assistant',
                            content: textContent,
                            position: position,
                            version: 1,
                            total_versions: 1,
                            parent_message_id: lastUserMsg?.id
                        });
                    }
                }
            }

            // Clean up from BackgroundStreams
            if (typeof BackgroundStreams !== 'undefined') {
                BackgroundStreams.removeStream(conversationId);
            }

            // Scroll if still on same conversation
            if (this.activeConversationId === conversationId) {
                this.scrollToBottom();
            }
        }
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
            // User messages get Copy, Edit, and Version Nav (branching happens at user messages)
            const showVersionNav = totalVersions > 1;
            actionsHtml = `
                <div class="message-actions">
                    <button class="action-btn copy-btn" title="Copy">📋</button>
                    <button class="action-btn edit-btn" title="Edit">✏️</button>
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
        if (prevBtn) {
            // Version nav on user message - switches user message version (and corresponding response)
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
        const { role, content, thinking, position = 0, version = 1, total_versions = 1, created_at } = msg;

        // Version info is now passed directly for assistant messages
        const el = this.createMessageElement(role, position, version, total_versions, null, created_at);
        const contentEl = el.querySelector('.message-content');

        if (thinking) {
            const thinkingEl = this.createThinkingBlock();
            this.updateThinkingBlock(thinkingEl, thinking);
            contentEl.appendChild(thinkingEl);
        }

        if (Array.isArray(content)) {
            const files = content.filter(b => b.type === 'image' || b.type === 'document');
            const textFiles = content.filter(b => b.type === 'text' && b.text?.startsWith('File: '));
            const userMessages = content.filter(b => b.type === 'text' && !b.text?.startsWith('File: '));

            if (files.length > 0 || textFiles.length > 0) {
                const filesEl = document.createElement('div');
                filesEl.className = 'message-files';

                files.forEach(file => {
                    const fileEl = document.createElement('div');
                    fileEl.className = 'message-file';
                    if (file.type === 'image' && file.source?.data) {
                        fileEl.innerHTML = `<img src="data:${file.source.media_type};base64,${file.source.data}" alt="Image">`;
                    } else if (file.type === 'document') {
                        fileEl.innerHTML = '<span class="message-file-icon">📄</span><span>PDF Document</span>';
                    }
                    filesEl.appendChild(fileEl);
                });

                textFiles.forEach(tf => {
                    const fileEl = document.createElement('div');
                    fileEl.className = 'message-file';
                    const match = tf.text.match(/^File: (.+?)\n/);
                    const filename = match ? match[1] : 'Text file';
                    fileEl.innerHTML = `<span class="message-file-icon">📝</span><span>${this.escapeHtml(filename)}</span>`;
                    filesEl.appendChild(fileEl);
                });

                contentEl.appendChild(filesEl);
            }

            if (userMessages.length > 0) {
                const textEl = document.createElement('div');
                textEl.innerHTML = this.formatText(userMessages.map(m => m.text).join('\n\n'));
                contentEl.appendChild(textEl);
            }
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
                <span class="thinking-toggle">▶</span>
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
                return marked.parse(text);
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
        return html;
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

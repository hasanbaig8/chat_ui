/**
 * Chat module - Integrates with Store for state management
 *
 * This module handles UI interactions and rendering, delegating state
 * management to Store and API calls to ApiClient where possible.
 */

const ChatManager = {
    // UI state (not shared with other modules)
    abortController: null,
    editingPosition: null,
    originalEditContent: null,
    retryPosition: null,
    lastPrunedCount: 0,
    streamingMessageEl: null,
    streamingMessageId: null,
    pollInterval: null,
    lastStreamingText: '',
    streamingTextQueue: '',
    streamingDisplayedText: '',
    streamingAnimationFrame: null,
    userScrolledAway: false,
    lastTabRefresh: 0,
    toolBlocks: {},
    agentSessionId: null,

    // Model context limits (in tokens)
    MODEL_LIMITS: {
        'claude-3-5-sonnet-20241022': 200000,
        'claude-3-5-haiku-20241022': 200000,
        'claude-3-opus-20240229': 200000,
        'claude-3-sonnet-20240229': 200000,
        'claude-3-haiku-20240307': 200000
    },

    // =========================================================================
    // State accessors - delegate to Store
    // =========================================================================

    get messages() {
        return Store.get('messages') || [];
    },

    set messages(value) {
        Store.set({ messages: value });
    },

    get currentBranch() {
        return Store.get('currentBranch') || [0];
    },

    set currentBranch(value) {
        Store.set({ currentBranch: value });
    },

    get isStreaming() {
        return Store.get('isStreaming') || false;
    },

    set isStreaming(value) {
        if (value) {
            Store.startStreaming();
        } else {
            Store.endStreaming();
        }
    },

    get isAgentConversation() {
        return Store.get('isAgent') || false;
    },

    set isAgentConversation(value) {
        Store.set({ isAgent: value });
    },

    get activeConversationId() {
        return Store.get('currentConversationId');
    },

    set activeConversationId(value) {
        // Note: Use Store.setCurrentConversation for full state reset
        Store.set({ currentConversationId: value });
    },

    // =========================================================================
    // Initialization
    // =========================================================================

    _initialized: false,

    init() {
        if (this._initialized) return;
        this._initialized = true;

        this.bindEvents();
        this.configureMarked();
        this.bindTabVisibility();
        this.subscribeToStore();
    },

    /**
     * Subscribe to Store changes for reactive updates
     */
    subscribeToStore() {
        // Update send button when streaming state changes
        Store.subscribe('isStreaming', () => {
            this.updateSendButton();
        });

        // Update UI when messages change
        Store.subscribe('messages', (messages) => {
            // Could trigger re-render here if needed
        });
    },

    /**
     * Handle tab visibility changes
     */
    bindTabVisibility() {
        document.addEventListener('visibilitychange', async () => {
            if (document.visibilityState === 'visible') {
                await this.refreshOnTabFocus();
            }
        });

        window.addEventListener('focus', async () => {
            await this.refreshOnTabFocus();
        });
    },

    async refreshOnTabFocus() {
        const now = Date.now();
        if (now - this.lastTabRefresh < 1000) return;
        this.lastTabRefresh = now;

        if (this.abortController) return;

        if (typeof ConversationsManager !== 'undefined') {
            await ConversationsManager.loadConversations();
        }

        const currentId = this.activeConversationId;
        if (currentId) {
            try {
                const status = await ApiClient.getStreamingStatus(currentId);

                if (typeof StreamingTracker !== 'undefined') {
                    StreamingTracker.setStreaming(currentId, status);
                }

                const conversation = await ApiClient.getConversation(currentId, this.currentBranch);
                await this.loadConversation(conversation);
            } catch (e) {
                console.error('Error refreshing on tab focus:', e);
            }
        }
    },

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

    // =========================================================================
    // Event Binding
    // =========================================================================

    bindEvents() {
        const messageInput = document.getElementById('message-input');
        const sendBtn = document.getElementById('send-btn');

        messageInput.addEventListener('input', () => {
            this.autoResizeTextarea(messageInput);
            this.updateSendButton();
        });

        sendBtn.addEventListener('click', () => this.sendMessage());

        const stopBtn = document.getElementById('stop-btn');
        if (stopBtn) {
            stopBtn.addEventListener('click', () => this.stopAgentStream());
        }

        messageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.sendMessage();
            } else if (e.key === 'Enter' && e.shiftKey) {
                this.handleBulletContinuation(e, messageInput);
            }
        });

        // Copy entire conversation
        const copyAllBtn = document.getElementById('copy-all-btn');
        if (copyAllBtn) {
            copyAllBtn.addEventListener('click', () => this.copyEntireConversation());
        }

        // Message actions (delegated)
        document.getElementById('messages-container').addEventListener('click', (e) => {
            this.handleMessageAction(e);
        });

        // Version navigation
        document.getElementById('messages-container').addEventListener('click', (e) => {
            const versionBtn = e.target.closest('.version-btn');
            if (versionBtn) {
                const direction = parseInt(versionBtn.dataset.direction, 10);
                const position = parseInt(versionBtn.dataset.position, 10);
                this.switchVersion(position, direction);
            }
        });
    },

    handleBulletContinuation(e, messageInput) {
        const cursorPos = messageInput.selectionStart;
        const text = messageInput.value;
        const lineStart = text.lastIndexOf('\n', cursorPos - 1) + 1;
        const currentLine = text.substring(lineStart, cursorPos);

        const bulletMatch = currentLine.match(/^(\s*)([-*]|\d+\.)\s/);
        if (bulletMatch) {
            e.preventDefault();
            const indent = bulletMatch[1];
            const bullet = bulletMatch[2];

            if (currentLine.trim() === bullet) {
                messageInput.value = text.substring(0, lineStart) + text.substring(cursorPos);
                messageInput.selectionStart = messageInput.selectionEnd = lineStart;
            } else {
                let nextBullet = bullet;
                const numMatch = bullet.match(/^(\d+)\.$/);
                if (numMatch) {
                    nextBullet = (parseInt(numMatch[1], 10) + 1) + '.';
                }
                const insertion = '\n' + indent + nextBullet + ' ';
                messageInput.value = text.substring(0, cursorPos) + insertion + text.substring(cursorPos);
                const newPos = cursorPos + insertion.length;
                messageInput.selectionStart = messageInput.selectionEnd = newPos;
            }
            this.autoResizeTextarea(messageInput);
        }
    },

    handleMessageAction(e) {
        const btn = e.target.closest('.action-btn');
        if (!btn) return;

        const messageEl = btn.closest('.message');
        if (!messageEl) return;

        const action = btn.dataset.action;
        const position = parseInt(messageEl.dataset.position, 10);

        switch (action) {
            case 'copy':
                this.copyMessage(messageEl);
                break;
            case 'edit':
                this.editMessage(position);
                break;
            case 'retry':
                this.retryMessage(position);
                break;
            case 'delete':
                this.deleteMessagesFrom(position);
                break;
        }
    },

    // =========================================================================
    // UI Helpers
    // =========================================================================

    autoResizeTextarea(textarea) {
        textarea.style.height = 'auto';
        textarea.style.height = textarea.scrollHeight + 'px';
    },

    updateSendButton() {
        const sendBtn = document.getElementById('send-btn');
        const stopBtn = document.getElementById('stop-btn');
        const messageInput = document.getElementById('message-input');
        const hasContent = messageInput.value.trim().length > 0 ||
                          (typeof FilesManager !== 'undefined' && FilesManager.getContentBlocks().length > 0);

        if (this.isStreaming) {
            sendBtn.disabled = true;
            if (stopBtn && this.isAgentConversation) {
                stopBtn.style.display = 'block';
            }
        } else {
            sendBtn.disabled = !hasContent;
            if (stopBtn) {
                stopBtn.style.display = 'none';
            }
        }
    },

    scrollToBottom(force = false) {
        const container = document.getElementById('messages-container');
        if (!container) return;

        if (force || !this.userScrolledAway) {
            container.scrollTop = container.scrollHeight;
        }
    },

    getWelcomeMessage() {
        return document.getElementById('welcome-message');
    },

    // =========================================================================
    // Message Context Management
    // =========================================================================

    estimateTokens(content) {
        if (typeof content === 'string') {
            return Math.ceil(content.length / 4);
        }
        if (Array.isArray(content)) {
            return content.reduce((sum, block) => {
                if (block.type === 'text') {
                    return sum + Math.ceil((block.text || '').length / 4);
                }
                if (block.type === 'image' || block.type === 'document') {
                    return sum + 1000;
                }
                return sum;
            }, 0);
        }
        return 0;
    },

    getContextLimit() {
        const settings = typeof SettingsManager !== 'undefined' ? SettingsManager.getSettings() : {};
        const model = settings.model || 'claude-3-5-sonnet-20241022';
        return this.MODEL_LIMITS[model] || 200000;
    },

    pruneMessages(messages) {
        const settings = typeof SettingsManager !== 'undefined' ? SettingsManager.getSettings() : {};
        const thresholdPercent = settings.prune_threshold || 50;
        const contextLimit = this.getContextLimit();
        const threshold = Math.floor(contextLimit * (thresholdPercent / 100));

        let totalTokens = messages.reduce((sum, m) => sum + this.estimateTokens(m.content), 0);

        if (totalTokens <= threshold) {
            this.lastPrunedCount = 0;
            return messages;
        }

        const result = [...messages];
        let pruned = 0;

        while (totalTokens > threshold && result.length > 2) {
            const removed = result.shift();
            totalTokens -= this.estimateTokens(removed.content);
            pruned++;
        }

        this.lastPrunedCount = pruned;
        return result;
    },

    // =========================================================================
    // Conversation Management
    // =========================================================================

    async loadConversation(conversation) {
        // Update Store with conversation state
        Store.setCurrentConversation(
            conversation.id,
            conversation.current_branch || [0],
            conversation.is_agent || false
        );

        this.agentSessionId = conversation.session_id || null;

        // Load messages into Store
        const msgs = conversation.messages || [];
        Store.set({ messages: msgs });

        // Clear and render UI
        this.clearMessagesUI();
        const welcomeMessage = this.getWelcomeMessage();
        if (welcomeMessage) {
            welcomeMessage.style.display = msgs.length > 0 ? 'none' : 'block';
        }

        // Check for active background stream FIRST (before rendering messages)
        const activeStream = typeof BackgroundStreamManager !== 'undefined'
            ? BackgroundStreamManager.getStream(conversation.id)
            : null;

        // Check for any streaming messages and render
        let lastStreamingMsg = null;
        for (const msg of msgs) {
            if (msg.streaming) {
                lastStreamingMsg = msg;
            }
            // Skip rendering the streaming message if we have an active background stream
            // (StreamingDisplay will handle rendering it)
            if (activeStream && !activeStream.isComplete && msg.id === activeStream.messageId) {
                continue;
            }
            this.renderMessage(msg);
        }

        // Handle streaming state - check BackgroundStreamManager first
        if (activeStream && !activeStream.isComplete) {
            // Reconnect StreamingDisplay to background stream
            console.log('[ChatManager] Reconnecting to background stream:', conversation.id);
            Store.startStreaming();

            // Create message element for the streaming message
            const position = activeStream.position;
            const messageEl = this.createMessageElement('assistant', position, 1, 1);
            if (activeStream.messageId) {
                messageEl.dataset.messageId = activeStream.messageId;
            }
            document.getElementById('messages-container').appendChild(messageEl);

            // Connect StreamingDisplay to render accumulated content and subscribe to updates
            StreamingDisplay.connect(conversation.id, messageEl);
            this.updateSendButton();
        } else if (lastStreamingMsg) {
            // Message marked as streaming but no background stream - poll for completion
            this.startPolling(conversation.id);
        } else if (conversation.is_agent && typeof StreamingTracker !== 'undefined') {
            // Check server for streams we don't know about (page reload case)
            const status = await StreamingTracker.checkServerStatus(conversation.id);
            if (status.streaming && status.type === 'agent') {
                console.log('[ChatManager] Found server-side stream, starting polling:', conversation.id);
                this.startPolling(conversation.id);
                Store.startStreaming();
                this.updateSendButton();
            }
        }

        this.scrollToBottom(true);
        this.updateContextStats();
    },

    clearChat() {
        Store.clearCurrentConversation();
        this.clearMessagesUI();
        this.agentSessionId = null;
        this.toolBlocks = {};
        this.stopPolling();
        this.stopStreamingAnimation();

        const welcomeMessage = this.getWelcomeMessage();
        if (welcomeMessage) {
            welcomeMessage.style.display = 'block';
        }

        this.updateContextStats();
    },

    prepareForConversationSwitch(newConversationId) {
        const oldId = this.activeConversationId;

        // Check if there's a background stream (active OR just completed)
        // We use getStream() instead of isStreaming() to also catch streams that
        // just completed but haven't been cleaned up yet
        const hasBackgroundStream = typeof BackgroundStreamManager !== 'undefined' &&
            oldId && BackgroundStreamManager.getStream(oldId) !== null;

        const isAgentWithStream = this.isAgentConversation && hasBackgroundStream;

        // Disconnect StreamingDisplay from current stream (but keep stream data)
        if (typeof StreamingDisplay !== 'undefined') {
            StreamingDisplay.disconnect();
        }

        // For agent streams, NEVER clean up here - let the finally block handle it
        // This avoids race conditions between stream completion and conversation switching
        if (isAgentWithStream && oldId) {
            console.log('[ChatManager] Detaching from agent stream:', oldId);
            // DON'T abort - let the fetch loop continue reading and accumulating data
            // Just clear our reference so we know we've "detached"
            this.abortController = null;
            // Keep StreamingTracker state
            // Keep BackgroundStreamManager state - cleanup happens in finally block
        } else if (this.isAgentConversation && this.abortController) {
            // Agent stream started but not yet in BackgroundStreamManager (very early)
            console.log('[ChatManager] Detaching from early agent stream:', oldId);
            this.abortController = null;
        } else {
            // Normal chat - full cleanup
            if (this.abortController) {
                this.abortController.abort();
                this.abortController = null;
            }
            if (oldId) {
                if (typeof StreamingTracker !== 'undefined') {
                    StreamingTracker.setStreaming(oldId, { streaming: false });
                }
                // Clean up BackgroundStreamManager for non-agent streams only
                if (typeof BackgroundStreamManager !== 'undefined' && !this.isAgentConversation) {
                    BackgroundStreamManager.removeStream(oldId);
                }
            }
        }

        // Invalidate SSE streams
        if (typeof SSEClient !== 'undefined') {
            SSEClient.invalidateStreams();
        }

        this.stopPolling();
        this.stopStreamingAnimation();
        // Note: toolBlocks is now managed in BackgroundStreamManager and StreamingDisplay
        this.toolBlocks = {};
    },

    clearMessagesUI() {
        const container = document.getElementById('messages-container');
        if (container) {
            // Remove only message elements, preserve welcome-message
            const messages = container.querySelectorAll('.message');
            messages.forEach(msg => msg.remove());
        }
    },

    // =========================================================================
    // Slash Commands
    // =========================================================================

    async handleSlashCommand(text) {
        if (!text.startsWith('/')) return false;

        const parts = text.split(/\s+/);
        const command = parts[0].toLowerCase();

        if (this.isAgentConversation) {
            if (command === '/compact') {
                await this.compactConversation();
                return true;
            }
        }

        return false;
    },

    async compactConversation() {
        const conversationId = this.activeConversationId;
        if (!conversationId) return;

        try {
            const response = await fetch(`/api/agent-chat/compact/${conversationId}`, {
                method: 'POST'
            });

            if (response.ok) {
                const result = await response.json();
                this.showSystemMessage(`Compacted ${result.messages_removed} messages`);

                const conversation = await ApiClient.getConversation(conversationId, this.currentBranch);
                await this.loadConversation(conversation);
            }
        } catch (e) {
            console.error('Error compacting conversation:', e);
        }
    },

    showSystemMessage(text) {
        const container = document.getElementById('messages-container');
        const msgEl = document.createElement('div');
        msgEl.className = 'message system-message';
        msgEl.innerHTML = `<div class="message-content">${this.escapeHtml(text)}</div>`;
        container.appendChild(msgEl);
        this.scrollToBottom(true);
    },

    // =========================================================================
    // Send Message
    // =========================================================================

    async sendMessage() {
        const messageInput = document.getElementById('message-input');
        const text = messageInput.value.trim();
        const fileBlocks = typeof FilesManager !== 'undefined' ? FilesManager.getContentBlocks() : [];

        if (!text && fileBlocks.length === 0) return;
        if (this.isStreaming) return;

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
        if (typeof FilesManager !== 'undefined') {
            FilesManager.clearPendingFiles();
        }
        this.updateSendButton();

        let conversationId = ConversationsManager.getCurrentConversationId();
        if (!conversationId) {
            const conversation = await ConversationsManager.createConversation(
                ConversationsManager.generateTitle(content),
                false
            );
            conversationId = conversation.id;
            Store.set({ currentConversationId: conversationId });
            this.currentBranch = [0];
        } else if (this.messages.length === 0) {
            await ConversationsManager.updateConversationTitle(
                conversationId,
                ConversationsManager.generateTitle(content)
            );
        }

        document.getElementById('welcome-message').style.display = 'none';

        // Add user message via API
        const savedMsg = await ConversationsManager.addMessage('user', content, null, this.currentBranch);

        // Add to Store
        const userMsg = {
            id: savedMsg?.id,
            role: 'user',
            content,
            position: savedMsg?.position ?? this.messages.length,
            version: 1,
            total_versions: 1
        };
        Store.addMessage(userMsg);
        this.renderMessage(userMsg, true);

        await this.streamResponse();
    },

    // =========================================================================
    // Streaming
    // =========================================================================

    async streamResponse(isRetry = false) {
        if (this.isAgentConversation) {
            return this.streamAgentResponse(isRetry);
        }

        Store.startStreaming();
        this.lastStreamingText = '';
        this.stopStreamingAnimation();
        this.userScrolledAway = false;
        this.updateSendButton();

        const conversationId = ConversationsManager.getCurrentConversationId();
        const settings = typeof SettingsManager !== 'undefined' ? SettingsManager.getSettings() : {};

        if (typeof StreamingTracker !== 'undefined') {
            StreamingTracker.setStreaming(conversationId, { streaming: true, type: 'normal', stoppable: false });
        }

        // Create assistant message element
        const position = this.messages.length;
        const messageEl = this.createMessageElement('assistant', position, 1, 1);
        const container = document.getElementById('messages-container');
        container.appendChild(messageEl);
        this.streamingMessageEl = messageEl;

        this.scrollToBottom(true);

        // Track all content blocks in order (like agent mode does)
        let accumulatedContent = [];
        let currentText = '';
        let currentThinkingEl = null;
        let currentThinkingContent = '';

        const indicator = document.createElement('span');
        indicator.className = 'streaming-indicator';

        const abortController = new AbortController();
        this.abortController = abortController;

        try {
            const allMessages = this.messages.map(m => ({
                role: m.role,
                content: m.content
            }));

            const apiMessages = this.pruneMessages(allMessages);

            const response = await fetch('/api/chat/stream', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: apiMessages,
                    conversation_id: isRetry ? null : conversationId,
                    branch: isRetry ? null : this.currentBranch,
                    model: settings.model,
                    system_prompt: settings.system_prompt,
                    temperature: settings.temperature,
                    max_tokens: settings.max_tokens,
                    top_p: settings.top_p !== 1.0 ? settings.top_p : null,
                    top_k: settings.top_k > 0 ? settings.top_k : null,
                    thinking_enabled: settings.thinking_enabled,
                    thinking_budget: settings.thinking_budget,
                    web_search_enabled: settings.web_search_enabled || false,
                    web_search_max_uses: settings.web_search_max_uses || 5
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

                            // Check if still on same conversation
                            if (this.activeConversationId !== conversationId) {
                                return;
                            }

                            if (event.type === 'message_id') {
                                this.streamingMessageId = event.id;
                                messageEl.dataset.messageId = event.id;
                            } else if (event.type === 'thinking') {
                                // Thinking is like a tool block - accumulate then finalize
                                if (!currentThinkingEl) {
                                    // Finalize any pending text first
                                    if (currentText) {
                                        accumulatedContent.push({ type: 'text', text: currentText });
                                        currentText = '';
                                    }
                                    // Start new thinking block
                                    currentThinkingEl = this.createThinkingBlock(true);
                                    currentThinkingContent = '';
                                    if (document.contains(messageEl)) {
                                        contentEl.insertBefore(currentThinkingEl, indicator);
                                    }
                                }
                                currentThinkingContent += event.content;
                                if (document.contains(messageEl) && currentThinkingEl) {
                                    this.updateThinkingBlock(currentThinkingEl, currentThinkingContent);
                                }
                            } else if (event.type === 'text') {
                                // Finalize any active thinking block before text
                                if (currentThinkingEl) {
                                    this.finalizeThinkingBlock(currentThinkingEl);
                                    accumulatedContent.push({ type: 'thinking', content: currentThinkingContent });
                                    currentThinkingEl = null;
                                    currentThinkingContent = '';
                                }
                                currentText += event.content;
                                if (document.contains(messageEl)) {
                                    this.updateMessageContent(contentEl, currentText, indicator);
                                }
                            } else if (event.type === 'web_search_start') {
                                // Finalize any active thinking block
                                if (currentThinkingEl) {
                                    this.finalizeThinkingBlock(currentThinkingEl);
                                    accumulatedContent.push({ type: 'thinking', content: currentThinkingContent });
                                    currentThinkingEl = null;
                                    currentThinkingContent = '';
                                }
                                // Finalize any pending text
                                if (currentText) {
                                    accumulatedContent.push({ type: 'text', text: currentText });
                                    currentText = '';
                                }
                                if (document.contains(messageEl)) {
                                    const searchBlock = this.createWebSearchBlock(event.id, event.name);
                                    contentEl.insertBefore(searchBlock, indicator);
                                    this.toolBlocks[event.id] = searchBlock;
                                }
                            } else if (event.type === 'web_search_query') {
                                if (document.contains(messageEl)) {
                                    const searchBlock = this.toolBlocks[event.id];
                                    if (searchBlock) {
                                        this.updateWebSearchQuery(searchBlock, event.partial_query);
                                    }
                                }
                            } else if (event.type === 'web_search_result') {
                                if (document.contains(messageEl)) {
                                    const searchBlock = this.toolBlocks[event.tool_use_id];
                                    if (searchBlock) {
                                        this.updateWebSearchBlock(searchBlock, event.results);
                                    }
                                }
                            } else if (event.type === 'error') {
                                if (document.contains(messageEl)) {
                                    this.showError(contentEl, event.content);
                                }
                            } else if (event.type === 'done') {
                                // Stream complete
                            }
                        } catch (e) {
                            console.error('Error parsing SSE event:', e);
                        }
                    }
                }
            }

            // Finalize message
            indicator.remove();
            // Remove the streaming-text container and replace with final content
            const streamingText = contentEl.querySelector('.streaming-text');
            if (streamingText) {
                // Move children out of streaming-text container
                while (streamingText.firstChild) {
                    contentEl.insertBefore(streamingText.firstChild, streamingText);
                }
                streamingText.remove();
            }
            this.addCodeCopyButtons(contentEl);

            // Finalize any remaining thinking block
            if (currentThinkingEl) {
                this.finalizeThinkingBlock(currentThinkingEl);
                accumulatedContent.push({ type: 'thinking', content: currentThinkingContent });
            }
            // Finalize any remaining text
            if (currentText) {
                accumulatedContent.push({ type: 'text', text: currentText });
            }

            // Re-render the message from saved data to ensure consistency
            // This unifies the "live streaming" and "load from file" code paths
            const messageId = this.streamingMessageId;
            if (conversationId && messageId) {
                try {
                    // Small delay to ensure backend has finished saving
                    await new Promise(resolve => setTimeout(resolve, 100));

                    // Fetch the saved message from API
                    const response = await fetch(`/api/conversations/${conversationId}?branch=${encodeURIComponent(JSON.stringify(this.currentBranch))}`);
                    if (response.ok) {
                        const conv = await response.json();
                        const savedMsg = conv.messages?.find(m => m.id === messageId);
                        if (savedMsg) {
                            // Clear and re-render content from saved data
                            contentEl.innerHTML = '';
                            this.renderContent(contentEl, savedMsg.content, 'assistant');
                            this.addCodeCopyButtons(contentEl);

                            // Update Store with saved content
                            Store.addMessage({
                                id: messageId,
                                role: 'assistant',
                                content: savedMsg.content,
                                position: position,
                                version: 1,
                                total_versions: 1
                            });
                        }
                    }
                } catch (e) {
                    console.error('Error re-fetching message:', e);
                    // Fall back to accumulated content
                    let finalContent = accumulatedContent.length > 0 ? accumulatedContent : (currentText || '');
                    Store.addMessage({
                        id: messageId,
                        role: 'assistant',
                        content: finalContent,
                        position: position,
                        version: 1,
                        total_versions: 1
                    });
                }
            }

            // Add actions
            const actionsDiv = this.createMessageActions('assistant');
            messageEl.appendChild(actionsDiv);

        } catch (e) {
            if (e.name === 'AbortError') {
                console.log('Stream aborted');
            } else {
                console.error('Stream error:', e);
                const contentEl = messageEl.querySelector('.message-content');
                if (contentEl) {
                    this.showError(contentEl, e.message);
                }
            }
        } finally {
            Store.endStreaming();
            this.abortController = null;
            this.streamingMessageEl = null;
            this.streamingMessageId = null;
            this.updateSendButton();
            this.updateContextStats();

            if (typeof StreamingTracker !== 'undefined') {
                StreamingTracker.setStreaming(conversationId, { streaming: false });
            }
        }
    },

    async streamAgentResponse(isRetry = false) {
        Store.startStreaming();
        this.lastStreamingText = '';
        this.stopStreamingAnimation();
        this.userScrolledAway = false;
        this.updateSendButton();

        const conversationId = ConversationsManager.getCurrentConversationId();
        const settings = typeof SettingsManager !== 'undefined' ? SettingsManager.getSettings() : {};

        if (typeof StreamingTracker !== 'undefined') {
            StreamingTracker.setStreaming(conversationId, { streaming: true, type: 'agent', stoppable: true });
        }

        const position = this.messages.length;

        // Initialize stream in BackgroundStreamManager
        if (typeof BackgroundStreamManager !== 'undefined') {
            BackgroundStreamManager.startStream(conversationId, 'agent', position);
        }

        // Create message element
        const messageEl = this.createMessageElement('assistant', position, 1, 1);
        const container = document.getElementById('messages-container');
        container.appendChild(messageEl);
        this.streamingMessageEl = messageEl;

        // Connect StreamingDisplay for rendering
        if (typeof StreamingDisplay !== 'undefined') {
            StreamingDisplay.connect(conversationId, messageEl);
        }

        this.scrollToBottom(true);

        // Add streaming indicator
        const contentEl = messageEl.querySelector('.message-content');
        const indicator = document.createElement('span');
        indicator.className = 'streaming-indicator';
        contentEl.appendChild(indicator);

        const abortController = new AbortController();
        this.abortController = abortController;

        try {
            const allMessages = this.messages.map(m => ({
                role: m.role,
                content: m.content
            }));

            const response = await fetch('/api/agent-chat/stream', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: allMessages,
                    conversation_id: isRetry ? null : conversationId,
                    branch: isRetry ? null : this.currentBranch,
                    model: settings.model,
                    system_prompt: settings.system_prompt
                }),
                signal: abortController.signal
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

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

                            // Route event through BackgroundStreamManager
                            // It handles accumulation and notifies StreamingDisplay
                            if (typeof BackgroundStreamManager !== 'undefined') {
                                BackgroundStreamManager.handleEvent(conversationId, event);
                            }

                            // Track message ID and session ID locally for cleanup
                            if (event.type === 'message_id') {
                                this.streamingMessageId = event.id;
                            } else if (event.type === 'session_id') {
                                this.agentSessionId = event.session_id;
                            }
                        } catch (e) {
                            console.error('Error parsing SSE event:', e);
                        }
                    }
                }
            }

            // Stream completed normally - finalize through BackgroundStreamManager
            if (typeof BackgroundStreamManager !== 'undefined') {
                BackgroundStreamManager.endStream(conversationId);
            }

            // Re-render the message from saved data to ensure consistency
            // This unifies the "live streaming" and "load from file" code paths
            const messageId = this.streamingMessageId;
            if (conversationId && messageId) {
                try {
                    // Small delay to ensure backend has finished saving
                    await new Promise(resolve => setTimeout(resolve, 100));

                    // Fetch the saved message from API
                    const savedResponse = await fetch(`/api/conversations/${conversationId}?branch=${encodeURIComponent(JSON.stringify(this.currentBranch))}`);
                    if (savedResponse.ok) {
                        const conv = await savedResponse.json();
                        const savedMsg = conv.messages?.find(m => m.id === messageId);
                        if (savedMsg) {
                            // Only re-render if we're still viewing this conversation
                            if (this.activeConversationId === conversationId) {
                                const contentEl = messageEl.querySelector('.message-content');
                                if (contentEl) {
                                    // Clear and re-render content from saved data
                                    contentEl.innerHTML = '';
                                    this.renderContent(contentEl, savedMsg.content, 'assistant');

                                    // Backwards compatibility: render thinking from separate field
                                    if (savedMsg.thinking && !this.contentHasThinkingBlocks(savedMsg.content)) {
                                        const thinkingSegments = savedMsg.thinking.split('\n\n---\n\n');
                                        for (let i = thinkingSegments.length - 1; i >= 0; i--) {
                                            const segment = thinkingSegments[i];
                                            if (segment.trim()) {
                                                const thinkingEl = this.createThinkingBlock(false);
                                                this.updateThinkingBlock(thinkingEl, segment);
                                                thinkingEl.classList.add('collapsed');
                                                contentEl.insertBefore(thinkingEl, contentEl.firstChild);
                                            }
                                        }
                                    }

                                    // Backwards compatibility: apply tool results from separate field
                                    if (savedMsg.tool_results && Array.isArray(savedMsg.tool_results) && !this.contentHasToolResultBlocks(savedMsg.content)) {
                                        for (const result of savedMsg.tool_results) {
                                            const toolBlock = contentEl.querySelector(`.tool-use-block[data-tool-use-id="${result.tool_use_id}"]`);
                                            if (toolBlock) {
                                                this.applyToolResult(toolBlock, result.content, result.is_error);
                                            }
                                        }
                                    }
                                    this.addCodeCopyButtons(contentEl);

                                    // Add actions if not present
                                    if (!messageEl.querySelector('.message-actions')) {
                                        const actionsDiv = this.createMessageActions('assistant');
                                        messageEl.appendChild(actionsDiv);
                                    }
                                }
                            }

                            // Update Store with saved content
                            Store.addMessage({
                                id: messageId,
                                role: 'assistant',
                                content: savedMsg.content,
                                thinking: savedMsg.thinking,
                                position: position,
                                version: 1,
                                total_versions: 1
                            });
                        }
                    }
                } catch (e) {
                    console.error('Error re-fetching agent message:', e);
                    // Fall back to accumulated content from BackgroundStreamManager
                    if (typeof BackgroundStreamManager !== 'undefined') {
                        const stream = BackgroundStreamManager.getStream(conversationId);
                        if (stream) {
                            const finalContent = BackgroundStreamManager.buildFinalContent(stream);
                            Store.addMessage({
                                id: messageId,
                                role: 'assistant',
                                content: finalContent,
                                position: position,
                                version: 1,
                                total_versions: 1
                            });
                        }
                    }
                }
            }

        } catch (e) {
            if (e.name === 'AbortError') {
                // Check if this is from a conversation switch or an explicit stop
                // If we're still on this conversation, it's an explicit stop
                // If we're on a different conversation, it's a switch
                if (this.activeConversationId !== conversationId) {
                    // Conversation switch - stream will continue being processed by finally block
                    console.log('[ChatManager] Agent stream detached (conversation switch)');
                    // Note: finally block will handle cleanup
                } else {
                    // Explicit stop (user clicked stop button)
                    console.log('[ChatManager] Agent stream stopped by user');
                }
            } else {
                console.error('Agent stream error:', e);
                if (typeof BackgroundStreamManager !== 'undefined') {
                    BackgroundStreamManager.handleEvent(conversationId, { type: 'error', content: e.message });
                    BackgroundStreamManager.endStream(conversationId);
                }
            }
        } finally {
            // Always clean up BackgroundStreamManager and StreamingTracker for this conversation
            // These are per-conversation, so they should always be cleaned up when stream ends
            if (typeof StreamingTracker !== 'undefined') {
                StreamingTracker.setStreaming(conversationId, { streaming: false });
            }
            if (typeof BackgroundStreamManager !== 'undefined') {
                BackgroundStreamManager.removeStream(conversationId);
            }

            // Only do UI updates if we're still on this conversation
            if (this.activeConversationId === conversationId) {
                Store.endStreaming();
                this.abortController = null;
                this.streamingMessageEl = null;
                this.streamingMessageId = null;
                this.updateSendButton();
                this.updateContextStats();

                // Disconnect StreamingDisplay if it's connected to this conversation
                if (typeof StreamingDisplay !== 'undefined' &&
                    StreamingDisplay.getConnectedConversationId() === conversationId) {
                    StreamingDisplay.disconnect();
                }
            }
        }
    },

    async stopAgentStream() {
        const conversationId = this.activeConversationId;
        if (!conversationId) return;

        if (this.abortController) {
            this.abortController.abort();
        }

        try {
            await fetch(`/api/agent-chat/stop/${conversationId}`, { method: 'POST' });
        } catch (e) {
            console.warn('Error stopping agent stream:', e);
        }

        Store.endStreaming();
        this.updateSendButton();
    },

    stopStreaming() {
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
        Store.endStreaming();
        this.updateSendButton();
    },

    // =========================================================================
    // Polling for background streams
    // =========================================================================

    startPolling(conversationId) {
        this.stopPolling();

        this.pollInterval = setInterval(async () => {
            if (this.activeConversationId !== conversationId) {
                this.stopPolling();
                return;
            }

            try {
                const status = await ApiClient.getStreamingStatus(conversationId);

                if (!status.streaming) {
                    this.stopPolling();
                    // Partial update: only fetch and update the latest message
                    await this._fetchAndUpdateLatestMessage(conversationId);
                }
            } catch (e) {
                console.error('Polling error:', e);
            }
        }, 2000);
    },

    /**
     * Fetch the latest message from server and update DOM in-place
     * Avoids full conversation reload to prevent flickering
     */
    async _fetchAndUpdateLatestMessage(conversationId) {
        try {
            const conversation = await ApiClient.getConversation(conversationId, this.currentBranch);
            const latestMsg = conversation.messages?.[conversation.messages.length - 1];

            if (latestMsg && latestMsg.role === 'assistant') {
                // Find message element by ID (not stale ref)
                let messageEl = document.querySelector(`.message[data-message-id="${latestMsg.id}"]`);

                if (!messageEl) {
                    // Message element doesn't exist, create it
                    messageEl = this.createMessageElement('assistant', latestMsg.position, 1, 1);
                    messageEl.dataset.messageId = latestMsg.id;
                    document.getElementById('messages-container').appendChild(messageEl);
                }

                // Update content in-place
                const contentEl = messageEl.querySelector('.message-content');
                if (contentEl) {
                    contentEl.innerHTML = '';
                    this.renderContent(contentEl, latestMsg.content, 'assistant');

                    // Backwards compatibility: render thinking from separate field
                    if (latestMsg.thinking && !this.contentHasThinkingBlocks(latestMsg.content)) {
                        const thinkingSegments = latestMsg.thinking.split('\n\n---\n\n');
                        for (let i = thinkingSegments.length - 1; i >= 0; i--) {
                            const segment = thinkingSegments[i];
                            if (segment.trim()) {
                                const thinkingEl = this.createThinkingBlock(false);
                                this.updateThinkingBlock(thinkingEl, segment);
                                thinkingEl.classList.add('collapsed');
                                contentEl.insertBefore(thinkingEl, contentEl.firstChild);
                            }
                        }
                    }

                    // Backwards compatibility: apply tool results from separate field
                    if (latestMsg.tool_results && Array.isArray(latestMsg.tool_results) && !this.contentHasToolResultBlocks(latestMsg.content)) {
                        for (const result of latestMsg.tool_results) {
                            const toolBlock = contentEl.querySelector(`.tool-use-block[data-tool-use-id="${result.tool_use_id}"]`);
                            if (toolBlock) {
                                this.applyToolResult(toolBlock, result.content, result.is_error);
                            }
                        }
                    }

                    this.addCodeCopyButtons(contentEl);
                }

                // Add actions if not present
                if (!messageEl.querySelector('.message-actions')) {
                    const actionsDiv = this.createMessageActions('assistant');
                    messageEl.appendChild(actionsDiv);
                }

                // Update Store
                Store.addMessage(latestMsg);
            }

            Store.endStreaming();
            this.updateSendButton();
            this.updateContextStats();

            // Update StreamingTracker
            if (typeof StreamingTracker !== 'undefined') {
                StreamingTracker.setStreaming(conversationId, { streaming: false });
            }
        } catch (e) {
            console.error('Error fetching latest message:', e);
            // Fall back to full reload
            const conversation = await ApiClient.getConversation(conversationId, this.currentBranch);
            await this.loadConversation(conversation);
        }
    },

    stopPolling() {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
    },

    // =========================================================================
    // Edit / Retry / Delete
    // =========================================================================

    async editMessage(position) {
        const msg = this.messages.find(m => m.position === position);
        if (!msg || msg.role !== 'user') return;

        const messageEl = document.querySelector(`.message[data-position="${position}"]`);
        if (!messageEl) return;

        const contentEl = messageEl.querySelector('.message-content');
        this.editingPosition = position;
        this.originalEditContent = typeof msg.content === 'string' ? msg.content :
            msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n');

        contentEl.innerHTML = '';
        const textarea = document.createElement('textarea');
        textarea.className = 'edit-textarea';
        textarea.value = this.originalEditContent;
        contentEl.appendChild(textarea);

        const buttonsDiv = document.createElement('div');
        buttonsDiv.className = 'edit-buttons';

        const saveBtn = document.createElement('button');
        saveBtn.className = 'edit-save-btn';
        saveBtn.textContent = 'Save & Submit';
        saveBtn.onclick = () => this.confirmEdit(position, textarea.value);

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'edit-cancel-btn';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.onclick = () => this.cancelEdit(position);

        buttonsDiv.appendChild(saveBtn);
        buttonsDiv.appendChild(cancelBtn);
        contentEl.appendChild(buttonsDiv);

        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    },

    async confirmEdit(position, newContent) {
        if (newContent.trim() === '' || newContent === this.originalEditContent) {
            this.cancelEdit(position);
            return;
        }

        const conversationId = this.activeConversationId;
        const userMsgIndex = this.messages.filter(m => m.role === 'user' && m.position <= position).length - 1;

        try {
            const response = await fetch(`/api/conversations/${conversationId}/edit`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user_msg_index: userMsgIndex,
                    content: newContent,
                    current_branch: this.currentBranch
                })
            });

            if (response.ok) {
                const result = await response.json();
                this.currentBranch = result.branch;

                const conversation = await ApiClient.getConversation(conversationId, result.branch);
                await this.loadConversation(conversation);
                await this.streamResponse();
            }
        } catch (e) {
            console.error('Error editing message:', e);
        } finally {
            this.editingPosition = null;
            this.originalEditContent = null;
        }
    },

    cancelEdit(position) {
        const messageEl = document.querySelector(`.message[data-position="${position}"]`);
        if (!messageEl) return;

        const msg = this.messages.find(m => m.position === position);
        if (!msg) return;

        const contentEl = messageEl.querySelector('.message-content');
        const content = typeof msg.content === 'string' ? msg.content :
            msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
        contentEl.textContent = content;

        this.editingPosition = null;
        this.originalEditContent = null;
    },

    async retryMessage(assistantPosition) {
        // Remove from the user message before this assistant message
        const userPosition = assistantPosition - 1;
        const userMsg = this.messages.find(m => m.position === userPosition && m.role === 'user');
        if (!userMsg) return;

        // Remove assistant message from UI and state
        this.removeMessagesFromPosition(assistantPosition);

        // Filter messages in Store
        const newMessages = this.messages.filter(m => m.position < assistantPosition);
        Store.set({ messages: newMessages });

        await this.streamResponse(true);
    },

    removeMessagesFromPosition(position) {
        const container = document.getElementById('messages-container');
        const messages = container.querySelectorAll('.message');
        messages.forEach(el => {
            const pos = parseInt(el.dataset.position, 10);
            if (pos >= position) {
                el.remove();
            }
        });
    },

    async deleteMessagesFrom(position) {
        const conversationId = this.activeConversationId;
        if (!conversationId) return;

        try {
            await fetch(`/api/conversations/${conversationId}/messages?from_position=${position}&branch=${this.currentBranch.join(',')}`, {
                method: 'DELETE'
            });

            this.removeMessagesFromPosition(position);
            const newMessages = this.messages.filter(m => m.position < position);
            Store.set({ messages: newMessages });
            this.updateContextStats();
        } catch (e) {
            console.error('Error deleting messages:', e);
        }
    },

    async switchVersion(position, direction) {
        const conversationId = this.activeConversationId;
        const msg = this.messages.find(m => m.position === position);
        if (!msg) return;

        const userMsgIndex = msg.user_msg_index;
        if (userMsgIndex === undefined) return;

        try {
            const response = await fetch(`/api/conversations/${conversationId}/switch-branch`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user_msg_index: userMsgIndex,
                    direction: direction,
                    current_branch: this.currentBranch
                })
            });

            if (response.ok) {
                const result = await response.json();
                this.currentBranch = result.branch;
                await this.loadConversation(result.conversation);
            }
        } catch (e) {
            console.error('Error switching version:', e);
        }
    },

    // =========================================================================
    // Copy
    // =========================================================================

    async copyMessage(messageEl) {
        const contentEl = messageEl.querySelector('.message-content');
        if (!contentEl) return;

        const text = contentEl.textContent || contentEl.innerText;
        try {
            await navigator.clipboard.writeText(text);
            this.showCopyFeedback(messageEl);
        } catch (e) {
            console.error('Error copying:', e);
        }
    },

    showCopyFeedback(element) {
        const btn = element.querySelector('.copy-btn') || element;
        const original = btn.innerHTML;
        btn.innerHTML = '✓';
        setTimeout(() => {
            btn.innerHTML = original;
        }, 1000);
    },

    async copyEntireConversation() {
        const messages = this.messages;
        if (messages.length === 0) return;

        let text = '';
        for (const msg of messages) {
            const role = msg.role === 'user' ? 'User' : 'Assistant';
            const content = typeof msg.content === 'string' ? msg.content :
                msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
            text += `${role}:\n${content}\n\n`;
        }

        try {
            await navigator.clipboard.writeText(text.trim());
            const btn = document.getElementById('copy-all-btn');
            if (btn) {
                this.showCopyFeedback(btn);
            }
        } catch (e) {
            console.error('Error copying conversation:', e);
        }
    },

    // =========================================================================
    // Rendering
    // =========================================================================

    renderMessage(msg, forceScroll = false) {
        const container = document.getElementById('messages-container');
        const messageEl = this.createMessageElement(
            msg.role,
            msg.position,
            msg.current_version || msg.version || 1,
            msg.total_versions || 1,
            null,
            msg.timestamp
        );

        if (msg.id) {
            messageEl.dataset.messageId = msg.id;
        }
        if (msg.user_msg_index !== undefined) {
            messageEl.dataset.userMsgIndex = msg.user_msg_index;
        }

        const contentEl = messageEl.querySelector('.message-content');

        // Render content - renderContent handles all formats:
        // - string (plain text)
        // - array with thinking/text/tool_use/surface_content blocks
        // - object with text and web_searches
        this.renderContent(contentEl, msg.content, msg.role);

        // Backwards compatibility: Render separate thinking field if present
        // Only use legacy thinking field if content doesn't already have thinking blocks
        if (msg.thinking && !this.contentHasThinkingBlocks(msg.content)) {
            const thinkingSegments = msg.thinking.split('\n\n---\n\n');
            for (let i = thinkingSegments.length - 1; i >= 0; i--) {
                const segment = thinkingSegments[i];
                if (segment.trim()) {
                    const thinkingEl = this.createThinkingBlock(false);
                    this.updateThinkingBlock(thinkingEl, segment);
                    thinkingEl.classList.add('collapsed');
                    contentEl.insertBefore(thinkingEl, contentEl.firstChild);
                }
            }
        }

        // Backwards compatibility: Apply tool results from separate field
        // Only use legacy tool_results field if content doesn't have tool_result blocks
        if (msg.tool_results && Array.isArray(msg.tool_results) && !this.contentHasToolResultBlocks(msg.content)) {
            for (const result of msg.tool_results) {
                const toolBlock = contentEl.querySelector(`.tool-use-block[data-tool-use-id="${result.tool_use_id}"]`);
                if (toolBlock) {
                    this.applyToolResult(toolBlock, result.content, result.is_error);
                }
            }
        }

        // Add actions
        if (!msg.streaming) {
            const actionsDiv = this.createMessageActions(msg.role);
            messageEl.appendChild(actionsDiv);
        } else {
            const indicator = document.createElement('span');
            indicator.className = 'streaming-indicator';
            contentEl.appendChild(indicator);
        }

        container.appendChild(messageEl);

        if (forceScroll) {
            this.scrollToBottom(true);
        }
    },

    renderContent(contentEl, content, role) {
        if (typeof content === 'string') {
            if (role === 'assistant') {
                this.renderMarkdownContent(contentEl, content);
                this.addCodeCopyButtons(contentEl);
            } else {
                contentEl.textContent = content;
            }
            return;
        }

        // Handle dict with text and web_searches
        if (content && typeof content === 'object' && !Array.isArray(content)) {
            if (content.text) {
                this.renderMarkdownContent(contentEl, content.text);
                this.addCodeCopyButtons(contentEl);
            }
            if (content.web_searches) {
                for (const search of content.web_searches) {
                    const searchBlock = this.createWebSearchBlock(search.id, 'web_search');
                    this.updateWebSearchQuery(searchBlock, search.query);
                    this.updateWebSearchBlock(searchBlock, search.results);
                    contentEl.appendChild(searchBlock);
                }
            }
            return;
        }

        // Handle array of content blocks
        if (Array.isArray(content)) {
            for (const block of content) {
                if (block.type === 'thinking') {
                    // Render thinking block
                    if (block.content) {
                        const thinkingEl = this.createThinkingBlock(false);
                        this.updateThinkingBlock(thinkingEl, block.content);
                        thinkingEl.classList.add('collapsed');
                        contentEl.appendChild(thinkingEl);
                    }
                } else if (block.type === 'text') {
                    const textDiv = document.createElement('div');
                    textDiv.className = 'text-segment';
                    if (role === 'assistant') {
                        this.renderMarkdownContent(textDiv, block.text);
                    } else {
                        textDiv.textContent = block.text;
                    }
                    contentEl.appendChild(textDiv);
                } else if (block.type === 'tool_use') {
                    const toolBlock = this.createToolUseBlock(block.name, block.input, block.id);
                    contentEl.appendChild(toolBlock);
                } else if (block.type === 'surface_content') {
                    if (block.filename) {
                        const placeholder = this.createSurfaceContentPlaceholder(
                            block.content_type,
                            block.title,
                            block.content_id
                        );
                        contentEl.appendChild(placeholder);
                        this.loadSurfaceContent(placeholder, block.filename, block.content_type, block.title, block.content_id);
                    } else if (block.content) {
                        const surfaceBlock = this.createSurfaceContentBlock(
                            block.content,
                            block.content_type,
                            block.title,
                            block.content_id
                        );
                        contentEl.appendChild(surfaceBlock);
                    }
                } else if (block.type === 'web_search') {
                    // Web search block in array format
                    const searchBlock = this.createWebSearchBlock(block.id, 'web_search');
                    this.updateWebSearchQuery(searchBlock, block.query);
                    this.updateWebSearchBlock(searchBlock, block.results);
                    contentEl.appendChild(searchBlock);
                } else if (block.type === 'image') {
                    const img = document.createElement('img');
                    img.className = 'message-image';
                    if (block.source && block.source.data) {
                        img.src = `data:${block.source.media_type};base64,${block.source.data}`;
                    }
                    contentEl.appendChild(img);
                } else if (block.type === 'tool_result') {
                    // Find corresponding tool_use block and apply result
                    const toolBlock = contentEl.querySelector(
                        `.tool-use-block[data-tool-use-id="${block.tool_use_id}"]`
                    );
                    if (toolBlock) {
                        this.applyToolResult(toolBlock, block.content, block.is_error);
                    }
                }
            }
            this.addCodeCopyButtons(contentEl);
        }
    },

    // Helper to check if content array has thinking blocks
    contentHasThinkingBlocks(content) {
        return Array.isArray(content) && content.some(b => b.type === 'thinking');
    },

    // Helper to check if content array has tool_result blocks
    contentHasToolResultBlocks(content) {
        return Array.isArray(content) && content.some(b => b.type === 'tool_result');
    },

    createMessageElement(role, position = 0, version = 1, totalVersions = 1, nextVersionInfo = null, timestamp = null) {
        const el = document.createElement('div');
        el.className = `message ${role}`;
        el.dataset.position = position;
        el.dataset.role = role;

        // Version nav for user messages
        if (role === 'user' && totalVersions > 1) {
            const versionNav = document.createElement('div');
            versionNav.className = 'version-nav';

            const prevBtn = document.createElement('button');
            prevBtn.className = 'version-btn';
            prevBtn.textContent = '◀';
            prevBtn.dataset.direction = '-1';
            prevBtn.dataset.position = position;

            const counter = document.createElement('span');
            counter.className = 'version-counter';
            counter.textContent = `${version}/${totalVersions}`;

            const nextBtn = document.createElement('button');
            nextBtn.className = 'version-btn';
            nextBtn.textContent = '▶';
            nextBtn.dataset.direction = '1';
            nextBtn.dataset.position = position;

            versionNav.appendChild(prevBtn);
            versionNav.appendChild(counter);
            versionNav.appendChild(nextBtn);
            el.appendChild(versionNav);
        }

        const contentEl = document.createElement('div');
        contentEl.className = 'message-content';
        el.appendChild(contentEl);

        return el;
    },

    createMessageActions(role) {
        const actions = document.createElement('div');
        actions.className = 'message-actions';

        const copyBtn = document.createElement('button');
        copyBtn.className = 'action-btn copy-btn';
        copyBtn.innerHTML = '&#128203;';
        copyBtn.title = 'Copy';
        copyBtn.dataset.action = 'copy';
        actions.appendChild(copyBtn);

        if (role === 'user') {
            const editBtn = document.createElement('button');
            editBtn.className = 'action-btn edit-btn';
            editBtn.innerHTML = '&#9998;';
            editBtn.title = 'Edit';
            editBtn.dataset.action = 'edit';
            actions.appendChild(editBtn);
        } else {
            const retryBtn = document.createElement('button');
            retryBtn.className = 'action-btn retry-btn';
            retryBtn.innerHTML = '&#8635;';
            retryBtn.title = 'Retry';
            retryBtn.dataset.action = 'retry';
            actions.appendChild(retryBtn);
        }

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'action-btn delete-btn';
        deleteBtn.innerHTML = '&#128465;';
        deleteBtn.title = 'Delete';
        deleteBtn.dataset.action = 'delete';
        actions.appendChild(deleteBtn);

        return actions;
    },

    // =========================================================================
    // Thinking Block
    // =========================================================================

    createThinkingBlock(isStreaming = true) {
        const el = document.createElement('div');
        el.className = 'thinking-block';

        const header = document.createElement('div');
        header.className = 'thinking-header';
        header.innerHTML = `
            <span class="thinking-expand-icon">▼</span>
            <span class="thinking-icon">💭</span>
            <span class="thinking-label">Thinking</span>
            <span class="thinking-status ${isStreaming ? 'thinking' : 'done'}">${isStreaming ? 'THINKING' : 'DONE'}</span>
        `;

        // Toggle expand/collapse
        header.onclick = () => {
            el.classList.toggle('collapsed');
            const icon = header.querySelector('.thinking-expand-icon');
            if (icon) {
                icon.textContent = el.classList.contains('collapsed') ? '▶' : '▼';
            }
        };

        const content = document.createElement('div');
        content.className = 'thinking-content';

        const inner = document.createElement('div');
        inner.className = 'thinking-inner';

        content.appendChild(inner);
        el.appendChild(header);
        el.appendChild(content);
        return el;
    },

    updateThinkingBlock(el, content) {
        const innerEl = el.querySelector('.thinking-inner');
        if (innerEl) {
            innerEl.textContent = content;
        }
    },

    finalizeThinkingBlock(el) {
        const statusEl = el.querySelector('.thinking-status');
        if (statusEl) {
            statusEl.className = 'thinking-status done';
            statusEl.textContent = 'DONE';
        }
    },

    // =========================================================================
    // Web Search Block
    // =========================================================================

    createWebSearchBlock(id, name) {
        const el = document.createElement('div');
        el.className = 'web-search-block';
        el.dataset.searchId = id;

        const header = document.createElement('div');
        header.className = 'web-search-header';
        header.innerHTML = '<span class="search-icon">🔍</span><span class="search-query">Searching...</span>';

        const results = document.createElement('div');
        results.className = 'web-search-results';

        el.appendChild(header);
        el.appendChild(results);
        return el;
    },

    updateWebSearchQuery(el, query) {
        const queryEl = el.querySelector('.search-query');
        if (queryEl) {
            queryEl.textContent = query || 'Searching...';
        }
    },

    updateWebSearchBlock(el, results) {
        const resultsEl = el.querySelector('.web-search-results');
        if (!resultsEl || !results) return;

        resultsEl.innerHTML = '';
        for (const result of results) {
            const item = document.createElement('a');
            item.className = 'search-result-item';
            item.href = result.url;
            item.target = '_blank';
            item.innerHTML = `
                <div class="result-title">${this.escapeHtml(result.title)}</div>
                <div class="result-url">${this.escapeHtml(result.url)}</div>
            `;
            resultsEl.appendChild(item);
        }
    },

    // =========================================================================
    // Tool Use Block
    // =========================================================================

    createToolUseBlock(toolName, input, toolUseId) {
        const el = document.createElement('div');
        el.className = 'tool-use-block';
        el.dataset.toolUseId = toolUseId;

        // Get brief description from input
        const brief = this.getToolBrief(toolName, input);

        // Header with expand icon, tool info, and status
        const header = document.createElement('div');
        header.className = 'tool-header';
        header.innerHTML = `
            <span class="tool-expand-icon">▼</span>
            <span class="tool-icon">${this.getToolIcon(toolName)}</span>
            <span class="tool-name">${this.getToolDisplayName(toolName)}</span>
            <span class="tool-brief">${this.escapeHtml(brief)}</span>
            <span class="tool-status running">RUNNING</span>
        `;

        // Content area (collapsible)
        const content = document.createElement('div');
        content.className = 'tool-content';

        // Input section
        const inputEl = document.createElement('div');
        inputEl.className = 'tool-input';
        inputEl.innerHTML = `
            <div class="tool-section-label">INPUT</div>
            <pre>${this.escapeHtml(JSON.stringify(input, null, 2))}</pre>
        `;

        // Result section (populated when result arrives)
        const resultEl = document.createElement('div');
        resultEl.className = 'tool-result';

        content.appendChild(inputEl);
        content.appendChild(resultEl);

        // Toggle expand/collapse
        header.onclick = () => {
            el.classList.toggle('collapsed');
            const icon = header.querySelector('.tool-expand-icon');
            if (icon) {
                icon.textContent = el.classList.contains('collapsed') ? '▶' : '▼';
            }
        };

        el.appendChild(header);
        el.appendChild(content);
        return el;
    },

    updateToolResult(toolUseId, content, isError) {
        // First try the cache (populated during live streaming)
        let block = this.toolBlocks[toolUseId];

        // Fall back to DOM query (needed when loading from saved data)
        if (!block) {
            block = document.querySelector(`.tool-use-block[data-tool-use-id="${toolUseId}"]`);
        }

        if (!block) return;

        // Update status badge
        const statusEl = block.querySelector('.tool-status');
        if (statusEl) {
            statusEl.className = `tool-status ${isError ? 'error' : 'done'}`;
            statusEl.textContent = isError ? 'ERROR' : 'DONE';
        }

        const resultEl = block.querySelector('.tool-result');
        if (!resultEl) return;

        resultEl.className = `tool-result ${isError ? 'error' : 'success'}`;

        const contentStr = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
        const isLong = contentStr.length > 500;

        resultEl.innerHTML = `
            <div class="tool-section-label">RESULT</div>
            <pre class="${isLong ? 'collapsed' : ''}">${this.escapeHtml(contentStr)}</pre>
        `;

        if (isLong) {
            resultEl.onclick = () => resultEl.querySelector('pre').classList.toggle('collapsed');
        }
    },

    // Apply tool result directly to a block element (used when block isn't in DOM yet)
    applyToolResult(block, content, isError) {
        if (!block) return;

        // Update status badge
        const statusEl = block.querySelector('.tool-status');
        if (statusEl) {
            statusEl.className = `tool-status ${isError ? 'error' : 'done'}`;
            statusEl.textContent = isError ? 'ERROR' : 'DONE';
        }

        const resultEl = block.querySelector('.tool-result');
        if (!resultEl) return;

        resultEl.className = `tool-result ${isError ? 'error' : 'success'}`;

        const contentStr = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
        const isLong = contentStr.length > 500;

        resultEl.innerHTML = `
            <div class="tool-section-label">RESULT</div>
            <pre class="${isLong ? 'collapsed' : ''}">${this.escapeHtml(contentStr)}</pre>
        `;

        if (isLong) {
            resultEl.onclick = () => resultEl.querySelector('pre').classList.toggle('collapsed');
        }
    },

    getToolBrief(toolName, input) {
        // Extract a brief description from the input based on tool type
        if (!input) return '';

        switch (toolName) {
            case 'Read':
                return input.file_path || '';
            case 'Write':
                return input.file_path || '';
            case 'Edit':
                return input.file_path || '';
            case 'Bash':
                const cmd = input.command || '';
                return cmd.length > 50 ? cmd.substring(0, 50) + '...' : cmd;
            case 'Glob':
                return input.pattern || '';
            case 'Grep':
                return input.pattern || '';
            case 'WebFetch':
                return input.url || '';
            case 'WebSearch':
                return input.query || '';
            default:
                // Try common fields
                return input.file_path || input.path || input.command || input.query || '';
        }
    },

    getToolIcon(toolName) {
        const icons = {
            'Read': '📖',
            'Write': '✏️',
            'Edit': '📝',
            'Bash': '💻',
            'Glob': '🔍',
            'Grep': '🔎',
            'WebFetch': '🌐',
            'WebSearch': '🔍'
        };
        return icons[toolName] || '🔧';
    },

    getToolDisplayName(toolName) {
        return toolName || 'Tool';
    },

    // =========================================================================
    // Surface Content Block
    // =========================================================================

    createSurfaceContentBlock(content, contentType, title, contentId) {
        const el = document.createElement('div');
        el.className = 'surface-content-block';
        el.dataset.contentId = contentId;

        const header = document.createElement('div');
        header.className = 'surface-header';
        header.innerHTML = `<span class="surface-icon">📊</span><span class="surface-title">${this.escapeHtml(title || 'Content')}</span><button class="surface-expand">↗</button>`;

        const container = document.createElement('div');
        container.className = 'surface-container';

        if (contentType === 'html') {
            const iframe = document.createElement('iframe');
            iframe.className = 'surface-iframe';
            iframe.sandbox = 'allow-scripts';
            iframe.srcdoc = content;
            container.appendChild(iframe);
        } else {
            this.renderMarkdownContent(container, content);
        }

        header.querySelector('.surface-expand').onclick = () => {
            this.openSurfaceModal(content, contentType, title);
        };

        el.appendChild(header);
        el.appendChild(container);
        return el;
    },

    createSurfaceContentPlaceholder(contentType, title, contentId) {
        const el = document.createElement('div');
        el.className = 'surface-content-block loading';
        el.dataset.contentId = contentId;

        const header = document.createElement('div');
        header.className = 'surface-header';
        header.innerHTML = `<span class="surface-icon">📊</span><span class="surface-title">${this.escapeHtml(title || 'Loading...')}</span>`;

        el.appendChild(header);
        return el;
    },

    async loadSurfaceContent(placeholderEl, filename, contentType, title, contentId) {
        const conversationId = this.activeConversationId;
        if (!conversationId) return;

        try {
            const response = await fetch(`/api/agent-chat/workspace/${conversationId}/${filename}`);
            if (response.ok) {
                const content = await response.text();
                this.replaceSurfaceContentPlaceholder(placeholderEl, content, contentType, title, contentId);
            }
        } catch (e) {
            console.error('Error loading surface content:', e);
        }
    },

    replaceSurfaceContentPlaceholder(placeholderEl, content, contentType, title, contentId) {
        const newBlock = this.createSurfaceContentBlock(content, contentType, title, contentId);
        placeholderEl.replaceWith(newBlock);
    },

    openSurfaceModal(content, contentType, title) {
        const modal = document.createElement('div');
        modal.className = 'surface-modal';
        modal.innerHTML = `
            <div class="surface-modal-content">
                <div class="surface-modal-header">
                    <span>${this.escapeHtml(title || 'Content')}</span>
                    <button class="surface-modal-close">×</button>
                </div>
                <div class="surface-modal-body"></div>
            </div>
        `;

        const body = modal.querySelector('.surface-modal-body');
        if (contentType === 'html') {
            const iframe = document.createElement('iframe');
            iframe.className = 'surface-modal-iframe';
            iframe.sandbox = 'allow-scripts';
            iframe.srcdoc = content;
            body.appendChild(iframe);
        } else {
            this.renderMarkdownContent(body, content);
        }

        modal.querySelector('.surface-modal-close').onclick = () => modal.remove();
        modal.onclick = (e) => {
            if (e.target === modal) modal.remove();
        };

        document.body.appendChild(modal);
    },

    // =========================================================================
    // Markdown / Content Rendering
    // =========================================================================

    updateMessageContent(contentEl, text, indicator) {
        // Use a dedicated text container to preserve order of special blocks
        let textContainer = contentEl.querySelector('.streaming-text');

        if (!textContainer) {
            // Create text container and insert it before the indicator
            textContainer = document.createElement('div');
            textContainer.className = 'streaming-text';
            if (indicator && indicator.parentNode === contentEl) {
                contentEl.insertBefore(textContainer, indicator);
            } else {
                contentEl.appendChild(textContainer);
            }
        }

        // Only update the text container, preserving other blocks in their positions
        this.renderMarkdownContent(textContainer, text);
        this.addCodeCopyButtons(textContainer);

        this.scrollToBottom();
    },

    renderMarkdownContent(element, text) {
        if (!text) {
            element.innerHTML = '';
            return;
        }

        if (typeof marked !== 'undefined') {
            element.innerHTML = marked.parse(text);
            this.embedGiphyUrls(element);
        } else {
            element.textContent = text;
        }
    },

    embedGiphyUrls(element) {
        const links = element.querySelectorAll('a[href*="giphy.com"]');
        links.forEach(link => {
            const match = link.href.match(/giphy\.com\/(?:gifs|media)\/(?:.*-)?([a-zA-Z0-9]+)/);
            if (match) {
                const gifId = match[1];
                const img = document.createElement('img');
                img.src = `https://media.giphy.com/media/${gifId}/giphy.gif`;
                img.className = 'giphy-embed';
                link.replaceWith(img);
            }
        });
    },

    addCodeCopyButtons(container) {
        const codeBlocks = container.querySelectorAll('pre code');
        codeBlocks.forEach(code => {
            const pre = code.parentElement;
            if (pre.querySelector('.code-copy-btn')) return;

            const btn = document.createElement('button');
            btn.className = 'code-copy-btn';
            btn.textContent = 'Copy';
            btn.onclick = async () => {
                try {
                    await navigator.clipboard.writeText(code.textContent);
                    btn.textContent = 'Copied!';
                    setTimeout(() => btn.textContent = 'Copy', 1000);
                } catch (e) {
                    console.error('Error copying code:', e);
                }
            };

            pre.style.position = 'relative';
            pre.appendChild(btn);
        });
    },

    showError(contentEl, message) {
        const errorEl = document.createElement('div');
        errorEl.className = 'error-message';
        errorEl.textContent = `Error: ${message}`;
        contentEl.appendChild(errorEl);
    },

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    },

    // =========================================================================
    // Context Stats
    // =========================================================================

    updateContextStats() {
        const statsEl = document.getElementById('context-stats');
        if (!statsEl) return;

        const messages = this.messages;
        const totalTokens = messages.reduce((sum, m) => sum + this.estimateTokens(m.content), 0);
        const limit = this.getContextLimit();
        const percent = Math.round((totalTokens / limit) * 100);

        statsEl.textContent = `${totalTokens.toLocaleString()} / ${limit.toLocaleString()} tokens (${percent}%)`;

        if (percent > 80) {
            statsEl.className = 'context-stats warning';
        } else {
            statsEl.className = 'context-stats';
        }
    },

    // Animation stubs (simplified)
    stopStreamingAnimation() {
        if (this.streamingAnimationFrame) {
            cancelAnimationFrame(this.streamingAnimationFrame);
            this.streamingAnimationFrame = null;
        }
    }
};

// Note: ChatManager.init() is called by app.js to ensure proper initialization order

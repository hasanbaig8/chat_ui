/**
 * Chat and streaming module with edit/retry and branching support
 */

const ChatManager = {
    messages: [],  // Array of {role, content, position, version, total_versions}
    isStreaming: false,
    streamingConversationId: null,  // Track which conversation is streaming
    abortController: null,
    editingPosition: null,
    originalEditContent: null,  // Original content when editing
    retryPosition: null,  // Position for retry operations

    /**
     * Initialize chat
     */
    init() {
        this.bindEvents();
        this.configureMarked();
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
     * Load a conversation and its messages
     */
    loadConversation(conversation) {
        // Don't interrupt if this conversation is currently streaming
        if (this.isStreaming && this.streamingConversationId === conversation.id) {
            return;
        }

        this.messages = [];
        this.clearMessagesUI();

        if (conversation.messages && conversation.messages.length > 0) {
            document.getElementById('welcome-message').style.display = 'none';

            // First, populate all messages so look-ahead works for version info
            conversation.messages.forEach(msg => {
                this.messages.push({
                    role: msg.role,
                    content: msg.content,
                    position: msg.position,
                    version: msg.current_version || msg.version,
                    total_versions: msg.total_versions || 1
                });
            });

            // Then render all messages (now getNextAssistantVersionInfo can look ahead)
            conversation.messages.forEach(msg => {
                this.renderMessage({
                    role: msg.role,
                    content: msg.content,
                    thinking: msg.thinking,
                    position: msg.position,
                    version: msg.current_version || msg.version,
                    total_versions: msg.total_versions || 1
                });
            });

            this.scrollToBottom();
        } else {
            document.getElementById('welcome-message').style.display = '';
        }
    },

    clearChat() {
        this.messages = [];
        this.clearMessagesUI();
        document.getElementById('welcome-message').style.display = '';
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
                ConversationsManager.generateTitle(content)
            );
            conversationId = conversation.id;
        } else if (this.messages.length === 0) {
            await ConversationsManager.updateConversationTitle(
                conversationId,
                ConversationsManager.generateTitle(content)
            );
        }

        document.getElementById('welcome-message').style.display = 'none';

        // Add user message
        const position = this.messages.length;
        const userMsg = {
            role: 'user',
            content,
            position,
            version: 1,
            total_versions: 1
        };
        this.messages.push(userMsg);
        this.renderMessage(userMsg);
        await ConversationsManager.addMessage('user', content);

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

        // Replace content with editable textarea
        const textarea = document.createElement('textarea');
        textarea.className = 'edit-textarea';
        textarea.value = textContent;
        textarea.style.cssText = `
            width: 100%;
            min-height: 60px;
            padding: 8px;
            border: 2px solid rgba(255,255,255,0.5);
            border-radius: 6px;
            background: rgba(255,255,255,0.1);
            color: inherit;
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
            background: rgba(255,255,255,0.9);
            color: #333;
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
            background: rgba(255,255,255,0.3);
            color: inherit;
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

        // Update the user message in the UI
        if (userMsgEl) {
            const contentEl = userMsgEl.querySelector('.message-content');
            if (contentEl) {
                contentEl.innerHTML = this.formatText(newContent);
            }
            // Show action buttons again
            const actionsEl = userMsgEl.querySelector('.message-actions');
            if (actionsEl) actionsEl.style.display = '';
        }

        // Update internal message
        const msgIndex = this.messages.findIndex(m => m.position === position);
        if (msgIndex !== -1) {
            this.messages[msgIndex].content = newContent;
        }

        // Clear editing state
        this.editingPosition = null;
        this.originalEditContent = null;

        // Force repaint
        await new Promise(resolve => requestAnimationFrame(resolve));

        // Save edit via API
        await fetch(`/api/conversations/${conversationId}/edit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ position, content: newContent })
        });

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

        // Update internal messages
        this.messages = data.messages.map(m => ({
            role: m.role,
            content: m.content,
            position: m.position,
            version: m.version,
            total_versions: m.total_versions || 1
        }));

        // Store the retry position if this is a retry
        this.retryPosition = isRetry ? position : null;

        await this.streamResponse(isRetry);
    },

    /**
     * Stream response from API
     */
    async streamResponse(isRetry = false) {
        this.isStreaming = true;
        const conversationId = ConversationsManager.getCurrentConversationId();
        this.streamingConversationId = conversationId;
        this.updateSendButton();

        // Update UI to show this conversation is generating
        if (typeof ConversationsManager !== 'undefined') {
            ConversationsManager.setConversationGenerating(conversationId, true);
        }

        const settings = SettingsManager.getSettings();

        // Create assistant message element
        const position = this.messages.length;
        const messageEl = this.createMessageElement('assistant', position, 1, 1);
        const container = document.getElementById('messages-container');
        container.appendChild(messageEl);

        let thinkingContent = '';
        let textContent = '';
        let thinkingEl = null;

        const indicator = document.createElement('span');
        indicator.className = 'streaming-indicator';

        try {
            this.abortController = new AbortController();

            // Build messages for API
            const apiMessages = this.messages.map(m => ({
                role: m.role,
                content: m.content
            }));

            const response = await fetch('/api/chat/stream', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: apiMessages,
                    model: settings.model,
                    system_prompt: settings.system_prompt,
                    temperature: settings.temperature,
                    max_tokens: settings.max_tokens,
                    top_p: settings.top_p !== 1.0 ? settings.top_p : null,
                    top_k: settings.top_k > 0 ? settings.top_k : null,
                    thinking_enabled: settings.thinking_enabled,
                    thinking_budget: settings.thinking_budget
                }),
                signal: this.abortController.signal
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

                            if (event.type === 'thinking') {
                                thinkingContent += event.content;
                                if (!thinkingEl) {
                                    thinkingEl = this.createThinkingBlock();
                                    contentEl.insertBefore(thinkingEl, contentEl.firstChild);
                                }
                                this.updateThinkingBlock(thinkingEl, thinkingContent);
                            } else if (event.type === 'text') {
                                textContent += event.content;
                                this.updateMessageContent(contentEl, textContent, indicator);
                            } else if (event.type === 'error') {
                                this.showError(contentEl, event.content);
                            }
                        } catch (e) {}
                    }
                }

                this.scrollToBottom();
            }

        } catch (error) {
            if (error.name !== 'AbortError') {
                console.error('Streaming error:', error);
                const contentEl = messageEl.querySelector('.message-content');
                this.showError(contentEl, error.message);
            }
        } finally {
            indicator.remove();

            const wasStreaming = this.streamingConversationId;
            this.isStreaming = false;
            this.streamingConversationId = null;
            this.abortController = null;
            this.updateSendButton();

            // Update UI to show this conversation is done generating
            if (typeof ConversationsManager !== 'undefined' && wasStreaming) {
                ConversationsManager.setConversationGenerating(wasStreaming, false);
            }

            if (textContent && conversationId) {
                if (isRetry && this.retryPosition !== null) {
                    // For retry, use the retry endpoint to create a new version
                    const retryResponse = await fetch(`/api/conversations/${conversationId}/retry`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            position: this.retryPosition,
                            content: textContent,
                            thinking: thinkingContent || null
                        })
                    });

                    if (retryResponse.ok) {
                        const retryData = await retryResponse.json();
                        // Add assistant message with correct version info
                        const assistantMsg = {
                            role: 'assistant',
                            content: textContent,
                            position: this.retryPosition,
                            version: retryData.version,
                            total_versions: retryData.version  // New version means total is at least this
                        };
                        this.messages.push(assistantMsg);

                        // Update the user message above to show version nav
                        this.updateUserMessageVersionNav(this.retryPosition - 1, retryData.version, retryData.version);

                        // Update the current assistant message element position
                        messageEl.dataset.position = this.retryPosition;
                        messageEl.dataset.version = retryData.version;
                    }

                    this.retryPosition = null;
                } else {
                    // For new messages, add as usual
                    const assistantMsg = {
                        role: 'assistant',
                        content: textContent,
                        position: position,
                        version: 1,
                        total_versions: 1
                    };
                    this.messages.push(assistantMsg);

                    await ConversationsManager.addMessage('assistant', textContent, thinkingContent || null);
                }

                // Don't reload - we've updated the state locally
                // This prevents visual flashing
            }

            this.scrollToBottom();
        }
    },

    /**
     * Update the version nav on a user message to reflect new assistant response versions
     */
    updateUserMessageVersionNav(userPosition, currentVersion, totalVersions) {
        const container = document.getElementById('messages-container');
        const userMsgEl = container.querySelector(`.message.user[data-position="${userPosition}"]`);

        if (!userMsgEl) return;

        const versionNav = userMsgEl.querySelector('.version-nav');
        if (versionNav) {
            if (totalVersions > 1) {
                versionNav.style.display = '';
                const indicator = versionNav.querySelector('.version-indicator');
                if (indicator) {
                    indicator.textContent = `${currentVersion}/${totalVersions}`;
                }
            } else {
                versionNav.style.display = 'none';
            }
        }
    },

    /**
     * Get version info for the next assistant response after a user message
     */
    getNextAssistantVersionInfo(userPosition) {
        const nextMsg = this.messages.find(m => m.position === userPosition + 1 && m.role === 'assistant');
        if (nextMsg) {
            return {
                version: nextMsg.version,
                totalVersions: nextMsg.total_versions || 1,
                hasResponse: true
            };
        }
        return { version: 1, totalVersions: 1, hasResponse: false };
    },

    /**
     * Create a message element with action buttons
     * For user messages: edit button, retry button, and version nav for assistant response
     * For assistant messages: no action buttons (controls are on user message above)
     */
    createMessageElement(role, position = 0, version = 1, totalVersions = 1, nextVersionInfo = null) {
        const el = document.createElement('div');
        el.className = `message ${role}`;
        el.dataset.position = position;
        el.dataset.version = version;

        let actionsHtml = '';
        if (role === 'user') {
            // User messages get edit, retry, and version nav for the assistant response
            const assistantInfo = nextVersionInfo || { version: 1, totalVersions: 1, hasResponse: false };
            const assistantPosition = position + 1;

            actionsHtml = `
                <div class="message-actions">
                    <button class="action-btn edit-btn" title="Edit">✏️</button>
                    <button class="action-btn retry-btn" title="Regenerate response" data-assistant-position="${assistantPosition}">🔄</button>
                    <div class="version-nav" data-assistant-position="${assistantPosition}" style="${assistantInfo.totalVersions > 1 ? '' : 'display: none;'}">
                        <button class="action-btn nav-btn prev-btn" title="Previous response">◀</button>
                        <span class="version-indicator">${assistantInfo.version}/${assistantInfo.totalVersions}</span>
                        <button class="action-btn nav-btn next-btn" title="Next response">▶</button>
                    </div>
                </div>
            `;
        }
        // Assistant messages have no action buttons - controls are on the user message above

        el.innerHTML = `
            <div class="message-content"></div>
            ${actionsHtml}
        `;

        // Bind action buttons
        const editBtn = el.querySelector('.edit-btn');
        const retryBtn = el.querySelector('.retry-btn');
        const prevBtn = el.querySelector('.prev-btn');
        const nextBtn = el.querySelector('.next-btn');

        if (editBtn) {
            editBtn.addEventListener('click', () => this.editMessage(position));
        }
        if (retryBtn) {
            const assistantPos = parseInt(retryBtn.dataset.assistantPosition);
            retryBtn.addEventListener('click', () => this.retryMessage(assistantPos));
        }
        if (prevBtn) {
            const versionNav = el.querySelector('.version-nav');
            const assistantPos = parseInt(versionNav.dataset.assistantPosition);
            prevBtn.addEventListener('click', () => this.switchVersion(assistantPos, -1));
        }
        if (nextBtn) {
            const versionNav = el.querySelector('.version-nav');
            const assistantPos = parseInt(versionNav.dataset.assistantPosition);
            nextBtn.addEventListener('click', () => this.switchVersion(assistantPos, 1));
        }

        return el;
    },

    /**
     * Render a message to the UI
     */
    renderMessage(msg) {
        const { role, content, thinking, position = 0, version = 1, total_versions = 1 } = msg;

        // For user messages, get the next assistant response version info
        let nextVersionInfo = null;
        if (role === 'user') {
            nextVersionInfo = this.getNextAssistantVersionInfo(position);
        }

        const el = this.createMessageElement(role, position, version, total_versions, nextVersionInfo);
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

        const container = document.getElementById('messages-container');
        container.appendChild(el);
        this.scrollToBottom();
    },

    createThinkingBlock() {
        const el = document.createElement('div');
        el.className = 'thinking-block';
        el.innerHTML = `
            <div class="thinking-header">
                <span class="thinking-toggle">▶</span>
                <span class="thinking-label">Thinking...</span>
            </div>
            <div class="thinking-content"></div>
        `;

        el.querySelector('.thinking-header').addEventListener('click', () => {
            el.classList.toggle('expanded');
        });

        return el;
    },

    updateThinkingBlock(el, content) {
        const contentEl = el.querySelector('.thinking-content');
        contentEl.textContent = content;

        const label = el.querySelector('.thinking-label');
        const lines = content.split('\n').length;
        label.textContent = `Thinking (${lines} lines)`;
    },

    updateMessageContent(contentEl, text, indicator) {
        const thinkingBlock = contentEl.querySelector('.thinking-block');

        contentEl.innerHTML = this.formatText(text);

        if (thinkingBlock) {
            contentEl.insertBefore(thinkingBlock, contentEl.firstChild);
        }

        contentEl.appendChild(indicator);
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

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    },

    scrollToBottom() {
        const container = document.getElementById('messages-container');
        container.scrollTop = container.scrollHeight;
    },

    stopStreaming() {
        if (this.abortController) {
            this.abortController.abort();
        }
    }
};

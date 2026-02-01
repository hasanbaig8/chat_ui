/**
 * ChatRenderer - Pure rendering functions for chat UI
 *
 * This module handles all DOM manipulation for the chat.
 * It does NOT make API calls or manage state - that's ChatController's job.
 */

const ChatRenderer = {
    // DOM element references (set in init)
    messagesContainer: null,
    welcomeMessage: null,

    /**
     * Initialize renderer with DOM references
     */
    init() {
        this.messagesContainer = document.getElementById('messages-container');
        this.welcomeMessage = document.getElementById('welcome-message');
    },

    /**
     * Clear all messages from the container
     */
    clearMessages() {
        if (!this.messagesContainer) return;

        // Remove all message elements but keep welcome message
        const messages = this.messagesContainer.querySelectorAll('.message');
        messages.forEach(msg => msg.remove());
    },

    /**
     * Show welcome message
     */
    showWelcome() {
        if (this.welcomeMessage) {
            this.welcomeMessage.style.display = 'block';
        }
    },

    /**
     * Hide welcome message
     */
    hideWelcome() {
        if (this.welcomeMessage) {
            this.welcomeMessage.style.display = 'none';
        }
    },

    /**
     * Scroll to the bottom of messages
     */
    scrollToBottom() {
        if (this.messagesContainer) {
            this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
        }
    },

    /**
     * Check if user is scrolled near the bottom
     * @returns {boolean}
     */
    isNearBottom() {
        if (!this.messagesContainer) return true;
        const threshold = 100;
        return (
            this.messagesContainer.scrollHeight -
            this.messagesContainer.scrollTop -
            this.messagesContainer.clientHeight
        ) < threshold;
    },

    /**
     * Render a user message
     *
     * @param {object} message - Message data
     * @param {object} options - Render options
     * @returns {HTMLElement} The rendered message element
     */
    renderUserMessage(message, options = {}) {
        const element = document.createElement('div');
        element.className = 'message user';
        element.dataset.id = message.id;
        element.dataset.position = message.position;

        if (message.user_msg_index !== undefined) {
            element.dataset.userMsgIndex = message.user_msg_index;
        }

        // Version navigation
        const versionNav = this._createVersionNav(message);

        // Message content
        const contentDiv = document.createElement('div');
        contentDiv.className = 'message-content';
        contentDiv.textContent = this._extractTextContent(message.content);

        // Actions
        const actionsDiv = this._createMessageActions('user', message, options);

        element.appendChild(versionNav);
        element.appendChild(contentDiv);
        element.appendChild(actionsDiv);

        return element;
    },

    /**
     * Render an assistant message
     *
     * @param {object} message - Message data
     * @param {object} options - Render options
     * @returns {HTMLElement} The rendered message element
     */
    renderAssistantMessage(message, options = {}) {
        const element = document.createElement('div');
        element.className = 'message assistant';
        element.dataset.id = message.id;
        element.dataset.position = message.position;

        // Thinking section (if present)
        if (message.thinking) {
            const thinkingDiv = this._createThinkingSection(message.thinking);
            element.appendChild(thinkingDiv);
        }

        // Message content
        const contentDiv = document.createElement('div');
        contentDiv.className = 'message-content';
        contentDiv.innerHTML = this._renderContent(message.content);

        // Actions
        const actionsDiv = this._createMessageActions('assistant', message, options);

        element.appendChild(contentDiv);
        element.appendChild(actionsDiv);

        return element;
    },

    /**
     * Create a streaming message placeholder
     *
     * @param {string} messageId - Message ID
     * @param {number} position - Message position
     * @returns {HTMLElement} The placeholder element
     */
    createStreamingPlaceholder(messageId, position) {
        const element = document.createElement('div');
        element.className = 'message assistant streaming';
        element.dataset.id = messageId;
        element.dataset.position = position;

        // Thinking container (will be populated during stream)
        const thinkingDiv = document.createElement('div');
        thinkingDiv.className = 'thinking-section';
        thinkingDiv.style.display = 'none';

        const thinkingHeader = document.createElement('div');
        thinkingHeader.className = 'thinking-header';
        thinkingHeader.innerHTML = '<span>Thinking...</span>';

        const thinkingContent = document.createElement('div');
        thinkingContent.className = 'thinking-content';

        thinkingDiv.appendChild(thinkingHeader);
        thinkingDiv.appendChild(thinkingContent);

        // Content container
        const contentDiv = document.createElement('div');
        contentDiv.className = 'message-content';
        contentDiv.innerHTML = '<span class="typing-indicator"></span>';

        element.appendChild(thinkingDiv);
        element.appendChild(contentDiv);

        return element;
    },

    /**
     * Update streaming message with new content
     *
     * @param {HTMLElement} element - The streaming message element
     * @param {object} updates - Updates to apply
     */
    updateStreamingMessage(element, updates) {
        if (!element) return;

        if (updates.thinking !== undefined) {
            const thinkingSection = element.querySelector('.thinking-section');
            const thinkingContent = element.querySelector('.thinking-content');
            if (thinkingSection && thinkingContent) {
                thinkingSection.style.display = 'block';
                thinkingContent.textContent = updates.thinking;
            }
        }

        if (updates.text !== undefined) {
            const contentDiv = element.querySelector('.message-content');
            if (contentDiv) {
                contentDiv.innerHTML = this._renderMarkdown(updates.text) || '<span class="typing-indicator"></span>';
            }
        }
    },

    /**
     * Finalize a streaming message (remove streaming state, add actions)
     *
     * @param {HTMLElement} element - The streaming message element
     * @param {object} message - Final message data
     * @param {object} options - Options
     */
    finalizeStreamingMessage(element, message, options = {}) {
        if (!element) return;

        element.classList.remove('streaming');

        // Remove typing indicator
        const typingIndicator = element.querySelector('.typing-indicator');
        if (typingIndicator) {
            typingIndicator.remove();
        }

        // Add message actions
        const actionsDiv = this._createMessageActions('assistant', message, options);
        element.appendChild(actionsDiv);
    },

    // =========================================================================
    // Private helper methods
    // =========================================================================

    /**
     * Create version navigation for user messages
     * @private
     */
    _createVersionNav(message) {
        const nav = document.createElement('div');
        nav.className = 'version-nav';

        const total = message.total_versions || 1;
        const current = message.current_version || 1;

        if (total > 1) {
            const prevBtn = document.createElement('button');
            prevBtn.className = 'version-btn prev';
            prevBtn.textContent = '\u25C0';
            prevBtn.title = 'Previous version';
            prevBtn.dataset.direction = '-1';
            prevBtn.dataset.userMsgIndex = message.user_msg_index;

            const counter = document.createElement('span');
            counter.className = 'version-counter';
            counter.textContent = `${current}/${total}`;

            const nextBtn = document.createElement('button');
            nextBtn.className = 'version-btn next';
            nextBtn.textContent = '\u25B6';
            nextBtn.title = 'Next version';
            nextBtn.dataset.direction = '1';
            nextBtn.dataset.userMsgIndex = message.user_msg_index;

            nav.appendChild(prevBtn);
            nav.appendChild(counter);
            nav.appendChild(nextBtn);
        }

        return nav;
    },

    /**
     * Create message actions
     * @private
     */
    _createMessageActions(role, message, options = {}) {
        const actions = document.createElement('div');
        actions.className = 'message-actions';

        // Copy button
        const copyBtn = document.createElement('button');
        copyBtn.className = 'action-btn copy-btn';
        copyBtn.innerHTML = '&#128203;';
        copyBtn.title = 'Copy';
        copyBtn.dataset.action = 'copy';
        actions.appendChild(copyBtn);

        if (role === 'user') {
            // Edit button
            const editBtn = document.createElement('button');
            editBtn.className = 'action-btn edit-btn';
            editBtn.innerHTML = '&#9998;';
            editBtn.title = 'Edit';
            editBtn.dataset.action = 'edit';
            actions.appendChild(editBtn);
        } else {
            // Retry button for assistant messages
            const retryBtn = document.createElement('button');
            retryBtn.className = 'action-btn retry-btn';
            retryBtn.innerHTML = '&#8635;';
            retryBtn.title = 'Retry';
            retryBtn.dataset.action = 'retry';
            actions.appendChild(retryBtn);
        }

        // Delete button (only if not streaming)
        if (!options.streaming) {
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'action-btn delete-btn';
            deleteBtn.innerHTML = '&#128465;';
            deleteBtn.title = 'Delete';
            deleteBtn.dataset.action = 'delete';
            actions.appendChild(deleteBtn);
        }

        return actions;
    },

    /**
     * Create thinking section
     * @private
     */
    _createThinkingSection(thinking) {
        const section = document.createElement('div');
        section.className = 'thinking-section collapsed';

        const header = document.createElement('div');
        header.className = 'thinking-header';
        header.innerHTML = '<span>Thinking</span><span class="thinking-toggle">\u25B6</span>';

        const content = document.createElement('div');
        content.className = 'thinking-content';
        content.textContent = thinking;

        section.appendChild(header);
        section.appendChild(content);

        // Toggle on click
        header.addEventListener('click', () => {
            section.classList.toggle('collapsed');
            const toggle = header.querySelector('.thinking-toggle');
            toggle.textContent = section.classList.contains('collapsed') ? '\u25B6' : '\u25BC';
        });

        return section;
    },

    /**
     * Render message content (handles different content shapes)
     * @private
     */
    _renderContent(content) {
        // Simple string
        if (typeof content === 'string') {
            return this._renderMarkdown(content);
        }

        // Dict with text and web_searches
        if (content && content.text !== undefined) {
            let html = this._renderMarkdown(content.text);

            // Render web searches if present
            if (content.web_searches && content.web_searches.length > 0) {
                html += this._renderWebSearches(content.web_searches);
            }

            return html;
        }

        // Array of content blocks
        if (Array.isArray(content)) {
            let html = '';
            for (const block of content) {
                html += this._renderContentBlock(block);
            }
            return html;
        }

        return '';
    },

    /**
     * Render a single content block
     * @private
     */
    _renderContentBlock(block) {
        if (!block || typeof block !== 'object') return '';

        switch (block.type) {
            case 'text':
                return this._renderMarkdown(block.text || '');

            case 'tool_use':
                return this._renderToolUse(block);

            case 'surface_content':
                return this._renderSurfaceContent(block);

            default:
                return '';
        }
    },

    /**
     * Render tool use block
     * @private
     */
    _renderToolUse(block) {
        const html = `
            <div class="tool-use-block" data-tool-id="${block.id || ''}">
                <div class="tool-header">
                    <span class="tool-icon">\ud83d\udee0\ufe0f</span>
                    <span class="tool-name">${this._escapeHtml(block.name || 'Tool')}</span>
                </div>
                <div class="tool-input">
                    <pre><code>${this._escapeHtml(JSON.stringify(block.input, null, 2))}</code></pre>
                </div>
            </div>
        `;
        return html;
    },

    /**
     * Render surface content block
     * @private
     */
    _renderSurfaceContent(block) {
        const title = block.title || 'Content';
        const contentId = block.content_id || '';

        return `
            <div class="surface-content-block" data-content-id="${contentId}">
                <div class="surface-header">
                    <span class="surface-icon">\ud83d\udcca</span>
                    <span class="surface-title">${this._escapeHtml(title)}</span>
                    <button class="surface-toggle">\u25BC</button>
                </div>
                <div class="surface-content-container" data-filename="${block.filename || ''}">
                    <!-- Content loaded dynamically -->
                </div>
            </div>
        `;
    },

    /**
     * Render web searches
     * @private
     */
    _renderWebSearches(searches) {
        if (!searches || searches.length === 0) return '';

        let html = '<div class="web-searches">';
        for (const search of searches) {
            html += `
                <div class="web-search-block">
                    <div class="web-search-header">
                        <span class="web-search-icon">\ud83d\udd0d</span>
                        <span class="web-search-query">${this._escapeHtml(search.query)}</span>
                    </div>
                    ${this._renderSearchResults(search.results)}
                </div>
            `;
        }
        html += '</div>';
        return html;
    },

    /**
     * Render search results
     * @private
     */
    _renderSearchResults(results) {
        if (!results || results.length === 0) return '';

        let html = '<div class="web-search-results">';
        for (const result of results) {
            html += `
                <a class="web-search-result" href="${this._escapeHtml(result.url)}" target="_blank">
                    <div class="result-title">${this._escapeHtml(result.title)}</div>
                    <div class="result-url">${this._escapeHtml(result.url)}</div>
                </a>
            `;
        }
        html += '</div>';
        return html;
    },

    /**
     * Render markdown to HTML
     * @private
     */
    _renderMarkdown(text) {
        if (!text) return '';

        // Use marked.js if available
        if (typeof marked !== 'undefined') {
            return marked.parse(text);
        }

        // Fallback: escape HTML and preserve line breaks
        return this._escapeHtml(text).replace(/\n/g, '<br>');
    },

    /**
     * Extract plain text from content
     * @private
     */
    _extractTextContent(content) {
        if (typeof content === 'string') return content;

        if (content && content.text !== undefined) return content.text;

        if (Array.isArray(content)) {
            return content
                .filter(b => b.type === 'text')
                .map(b => b.text)
                .join('\n');
        }

        return '';
    },

    /**
     * Escape HTML special characters
     * @private
     */
    _escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
};

// Make ChatRenderer globally available
window.ChatRenderer = ChatRenderer;

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => ChatRenderer.init());
} else {
    ChatRenderer.init();
}

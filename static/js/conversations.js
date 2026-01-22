/**
 * Conversation management module
 */

const ConversationsManager = {
    conversations: [],
    currentConversationId: null,
    searchQuery: '',
    searchResults: null,
    renamingConversationId: null,
    loadRequestId: 0,  // Track conversation load requests to handle race conditions

    refreshInterval: null,  // Interval for periodic refresh
    lastRefresh: 0,  // Timestamp of last refresh

    /**
     * Initialize the conversations manager
     */
    async init() {
        await this.loadConversations();
        this.bindEvents();
        this.bindSearchEvents();
        this.startPeriodicRefresh();
    },

    /**
     * Start periodic refresh of conversations list
     */
    startPeriodicRefresh() {
        // Refresh every 5 seconds
        this.refreshInterval = setInterval(() => {
            this.refreshConversationsIfVisible();
        }, 5000);
    },

    /**
     * Refresh conversations list if tab is visible
     */
    async refreshConversationsIfVisible() {
        // Only refresh if tab is visible
        if (document.visibilityState !== 'visible') {
            return;
        }

        // Don't refresh if user is actively searching
        if (this.searchQuery) {
            return;
        }

        // Don't refresh if user is renaming
        if (this.renamingConversationId !== null) {
            return;
        }

        try {
            const response = await fetch('/api/conversations');
            const data = await response.json();
            const newConversations = data.conversations || [];

            // Only re-render if something changed
            if (this.hasConversationsChanged(newConversations)) {
                this.conversations = newConversations;
                this.renderConversationsList();
            }
        } catch (error) {
            // Silently fail on periodic refresh
            console.debug('Periodic refresh failed:', error);
        }
    },

    /**
     * Check if conversations list has changed
     */
    hasConversationsChanged(newConversations) {
        if (newConversations.length !== this.conversations.length) {
            return true;
        }

        for (let i = 0; i < newConversations.length; i++) {
            const newConv = newConversations[i];
            const oldConv = this.conversations[i];

            if (newConv.id !== oldConv.id ||
                newConv.title !== oldConv.title ||
                newConv.updated_at !== oldConv.updated_at) {
                return true;
            }
        }

        return false;
    },

    /**
     * Bind DOM events
     */
    bindEvents() {
        document.getElementById('new-chat-btn').addEventListener('click', () => {
            this.createConversation();
        });
    },

    /**
     * Bind search events
     */
    bindSearchEvents() {
        const searchInput = document.getElementById('search-input');
        const clearBtn = document.getElementById('clear-search-btn');

        searchInput.addEventListener('input', (e) => {
            this.handleSearch(e.target.value);
        });

        clearBtn.addEventListener('click', () => {
            searchInput.value = '';
            this.handleSearch('');
            searchInput.focus();
        });

        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                searchInput.value = '';
                this.handleSearch('');
            }
        });
    },

    /**
     * Handle search input
     */
    async handleSearch(query) {
        this.searchQuery = query.trim();
        const clearBtn = document.getElementById('clear-search-btn');

        // Show/hide clear button
        clearBtn.style.display = this.searchQuery ? '' : 'none';

        if (!this.searchQuery) {
            this.searchResults = null;
            this.renderConversationsList();
            return;
        }

        // Search in conversation titles (client-side) - partial match
        const titleMatches = this.conversations.filter(conv =>
            conv.title.toLowerCase().includes(this.searchQuery.toLowerCase())
        );

        // Search message content (server-side) - always enabled with partial match
        try {
            const response = await fetch(
                `/api/conversations/search?q=${encodeURIComponent(this.searchQuery)}`
            );
            if (response.ok) {
                const data = await response.json();

                // Create a set of title match IDs for quick lookup
                const titleMatchIds = new Set(titleMatches.map(c => c.id));

                // Separate content-only matches
                const contentOnlyMatches = data.conversations.filter(conv =>
                    !titleMatchIds.has(conv.id)
                );

                // Prioritize: title matches first, then content matches
                this.searchResults = [...titleMatches, ...contentOnlyMatches];
            } else {
                // Fallback to title-only search if endpoint fails
                this.searchResults = titleMatches;
            }
        } catch (error) {
            // Fallback to title-only search on error
            console.error('Search error:', error);
            this.searchResults = titleMatches;
        }

        this.renderConversationsList();
    },

    /**
     * Load all conversations from the server
     */
    async loadConversations() {
        try {
            const response = await fetch('/api/conversations');
            const data = await response.json();
            this.conversations = data.conversations || [];
            this.renderConversationsList();
        } catch (error) {
            console.error('Failed to load conversations:', error);
        }
    },

    /**
     * Render the conversations list in the sidebar
     */
    renderConversationsList() {
        const container = document.getElementById('conversations-list');
        container.innerHTML = '';

        // Use search results if available, otherwise all conversations
        const conversationsToShow = this.searchResults !== null ? this.searchResults : this.conversations;

        if (this.conversations.length === 0) {
            container.innerHTML = '<p style="padding: 12px; color: var(--color-text-secondary); font-size: 13px;">No conversations yet</p>';
            return;
        }

        if (conversationsToShow.length === 0 && this.searchQuery) {
            container.innerHTML = '<p style="padding: 12px; color: var(--color-text-secondary); font-size: 13px;">No matches found</p>';
            return;
        }

        conversationsToShow.forEach(conv => {
            const item = document.createElement('div');
            item.className = `conversation-item${conv.id === this.currentConversationId ? ' active' : ''}`;
            item.dataset.id = conv.id;

            // Highlight search matches in title
            let titleHtml = this.escapeHtml(conv.title);
            if (this.searchQuery) {
                const regex = new RegExp(`(${this.escapeRegex(this.searchQuery)})`, 'gi');
                titleHtml = titleHtml.replace(regex, '<mark>$1</mark>');
            }

            item.innerHTML = `
                <span class="conversation-title">${titleHtml}</span>
                <div class="conversation-actions">
                    <button class="conversation-duplicate" title="Duplicate">📋</button>
                    <button class="conversation-rename" title="Rename">✏️</button>
                    <button class="conversation-delete" title="Delete">&times;</button>
                </div>
            `;

            const titleEl = item.querySelector('.conversation-title');

            // Click to select conversation
            item.addEventListener('click', (e) => {
                if (!e.target.classList.contains('conversation-delete') &&
                    !e.target.classList.contains('conversation-rename') &&
                    !e.target.classList.contains('conversation-duplicate')) {
                    this.selectConversation(conv.id);
                }
            });

            // Double-click to rename
            titleEl.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                this.startRename(conv.id, titleEl);
            });

            // Duplicate button
            item.querySelector('.conversation-duplicate').addEventListener('click', (e) => {
                e.stopPropagation();
                this.duplicateConversation(conv.id);
            });

            // Rename button
            item.querySelector('.conversation-rename').addEventListener('click', (e) => {
                e.stopPropagation();
                this.startRename(conv.id, titleEl);
            });

            // Delete button
            item.querySelector('.conversation-delete').addEventListener('click', (e) => {
                e.stopPropagation();
                this.deleteConversation(conv.id);
            });

            container.appendChild(item);
        });

        // Update streaming indicators after rendering
        if (typeof BackgroundStreams !== 'undefined') {
            BackgroundStreams.updateStreamingIndicators();
        }
    },

    /**
     * Create a new conversation
     * @param {string} title - The conversation title
     * @param {boolean} clearUI - Whether to clear the chat UI (true when clicking New Chat button)
     */
    async createConversation(title = 'New Conversation', clearUI = true) {
        try {
            const response = await fetch('/api/conversations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title,
                    model: SettingsManager.getSettings().model
                })
            });

            const conversation = await response.json();
            this.conversations.unshift(conversation);
            this.currentConversationId = conversation.id;
            this.renderConversationsList();

            // Clear the chat UI to show the new empty conversation
            if (clearUI && typeof ChatManager !== 'undefined') {
                ChatManager.clearChat();
                ChatManager.activeConversationId = conversation.id;
            }

            return conversation;
        } catch (error) {
            console.error('Failed to create conversation:', error);
            throw error;
        }
    },

    /**
     * Select a conversation and load its messages
     */
    async selectConversation(conversationId) {
        // Increment request ID to track this specific request
        const requestId = ++this.loadRequestId;

        this.currentConversationId = conversationId;
        this.renderConversationsList();

        // Immediately prepare ChatManager for the switch - clears UI and sets active ID
        if (typeof ChatManager !== 'undefined') {
            ChatManager.prepareForConversationSwitch(conversationId);
        }

        try {
            const response = await fetch(`/api/conversations/${conversationId}`);

            // Check if user clicked on a different conversation while we were fetching
            if (this.loadRequestId !== requestId || this.currentConversationId !== conversationId) {
                console.log('Conversation load abandoned - user switched to different conversation');
                return;
            }

            const conversation = await response.json();

            // Double-check again after parsing JSON
            if (this.loadRequestId !== requestId || this.currentConversationId !== conversationId) {
                console.log('Conversation load abandoned - user switched to different conversation');
                return;
            }

            // Load messages into chat
            if (typeof ChatManager !== 'undefined') {
                ChatManager.loadConversation(conversation);
            }

            // Update settings if conversation has model preference
            if (conversation.model && typeof SettingsManager !== 'undefined') {
                SettingsManager.setModel(conversation.model);
            }

            if (conversation.system_prompt && typeof SettingsManager !== 'undefined') {
                document.getElementById('system-prompt').value = conversation.system_prompt;
            }

        } catch (error) {
            console.error('Failed to load conversation:', error);
        }
    },

    /**
     * Update conversation title
     */
    async updateConversationTitle(conversationId, title) {
        try {
            await fetch(`/api/conversations/${conversationId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title })
            });

            // Update local state
            const conv = this.conversations.find(c => c.id === conversationId);
            if (conv) {
                conv.title = title;
                this.renderConversationsList();
            }
        } catch (error) {
            console.error('Failed to update conversation:', error);
        }
    },

    /**
     * Start renaming a conversation
     */
    startRename(conversationId, titleEl) {
        if (this.renamingConversationId !== null) return;

        const conv = this.conversations.find(c => c.id === conversationId);
        if (!conv) return;

        this.renamingConversationId = conversationId;

        // Create input element
        const input = document.createElement('input');
        input.type = 'text';
        input.value = conv.title;
        input.className = 'conversation-rename-input';
        input.style.cssText = `
            width: 100%;
            padding: 4px 6px;
            border: 1px solid var(--color-primary);
            border-radius: 4px;
            background: var(--color-surface);
            color: var(--color-text);
            font-size: 13px;
            outline: none;
        `;

        // Replace title with input
        const originalHtml = titleEl.innerHTML;
        titleEl.innerHTML = '';
        titleEl.appendChild(input);

        input.focus();
        input.select();

        // Handle save
        const save = async () => {
            const newTitle = input.value.trim();
            if (newTitle && newTitle !== conv.title) {
                await this.updateConversationTitle(conversationId, newTitle);
            }
            this.renamingConversationId = null;
            this.renderConversationsList();
        };

        // Handle cancel
        const cancel = () => {
            this.renamingConversationId = null;
            titleEl.innerHTML = originalHtml;
        };

        // Event listeners
        input.addEventListener('blur', save);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                save();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                cancel();
            }
        });

        // Prevent click from bubbling
        input.addEventListener('click', (e) => e.stopPropagation());
    },

    /**
     * Duplicate a conversation
     */
    async duplicateConversation(conversationId) {
        try {
            const response = await fetch(`/api/conversations/${conversationId}/duplicate`, {
                method: 'POST'
            });

            if (!response.ok) {
                throw new Error('Failed to duplicate conversation');
            }

            const newConversation = await response.json();

            // Add to local state at the top
            this.conversations.unshift(newConversation);

            // Select the new conversation
            this.selectConversation(newConversation.id);

            this.renderConversationsList();
        } catch (error) {
            console.error('Failed to duplicate conversation:', error);
            alert('Failed to duplicate conversation');
        }
    },

    /**
     * Delete a conversation
     */
    async deleteConversation(conversationId) {
        if (!confirm('Delete this conversation?')) {
            return;
        }

        try {
            await fetch(`/api/conversations/${conversationId}`, {
                method: 'DELETE'
            });

            // Remove from local state
            this.conversations = this.conversations.filter(c => c.id !== conversationId);

            // If deleted current conversation, clear chat
            if (conversationId === this.currentConversationId) {
                this.currentConversationId = null;
                if (typeof ChatManager !== 'undefined') {
                    ChatManager.clearChat();
                }
            }

            this.renderConversationsList();
        } catch (error) {
            console.error('Failed to delete conversation:', error);
        }
    },

    /**
     * Add a message to the current conversation
     * @param {string} role - 'user' or 'assistant'
     * @param {any} content - Message content
     * @param {string|null} thinking - Extended thinking content
     * @param {string|null} parentMessageId - ID of the message this responds to
     */
    async addMessage(role, content, thinking = null, parentMessageId = null) {
        if (!this.currentConversationId) {
            return null;
        }

        try {
            const response = await fetch(`/api/conversations/${this.currentConversationId}/messages`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    role,
                    content,
                    thinking,
                    parent_message_id: parentMessageId
                })
            });

            return await response.json();
        } catch (error) {
            console.error('Failed to add message:', error);
            return null;
        }
    },

    /**
     * Generate a title from the first message
     */
    generateTitle(message) {
        const text = typeof message === 'string' ? message :
            (Array.isArray(message) ? message.find(b => b.type === 'text')?.text : '');

        if (!text) return 'New Conversation';

        // Take first 50 chars
        let title = text.substring(0, 50).trim();
        if (text.length > 50) title += '...';
        return title;
    },

    /**
     * Escape HTML to prevent XSS
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    },

    /**
     * Escape regex special characters
     */
    escapeRegex(text) {
        return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    },

    /**
     * Get current conversation ID
     */
    getCurrentConversationId() {
        return this.currentConversationId;
    }
};

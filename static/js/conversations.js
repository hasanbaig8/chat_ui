/**
 * Conversation management module
 */

const ConversationsManager = {
    conversations: [],
    currentConversationId: null,

    /**
     * Initialize the conversations manager
     */
    async init() {
        await this.loadConversations();
        this.bindEvents();
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

        if (this.conversations.length === 0) {
            container.innerHTML = '<p style="padding: 12px; color: var(--color-text-secondary); font-size: 13px;">No conversations yet</p>';
            return;
        }

        this.conversations.forEach(conv => {
            const item = document.createElement('div');
            item.className = `conversation-item${conv.id === this.currentConversationId ? ' active' : ''}`;
            item.dataset.id = conv.id;

            item.innerHTML = `
                <span class="conversation-title">${this.escapeHtml(conv.title)}</span>
                <button class="conversation-delete" title="Delete">&times;</button>
            `;

            item.addEventListener('click', (e) => {
                if (!e.target.classList.contains('conversation-delete')) {
                    this.selectConversation(conv.id);
                }
            });

            item.querySelector('.conversation-delete').addEventListener('click', (e) => {
                e.stopPropagation();
                this.deleteConversation(conv.id);
            });

            container.appendChild(item);
        });
    },

    /**
     * Create a new conversation
     */
    async createConversation(title = 'New Conversation') {
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
            // Just set the ID - don't call selectConversation which would clear ChatManager.messages
            this.currentConversationId = conversation.id;
            this.renderConversationsList();

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
        this.currentConversationId = conversationId;
        this.renderConversationsList();

        try {
            const response = await fetch(`/api/conversations/${conversationId}`);
            const conversation = await response.json();

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
     */
    async addMessage(role, content, thinking = null) {
        if (!this.currentConversationId) {
            return null;
        }

        try {
            const response = await fetch(`/api/conversations/${this.currentConversationId}/messages`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ role, content, thinking })
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
     * Get current conversation ID
     */
    getCurrentConversationId() {
        return this.currentConversationId;
    }
};

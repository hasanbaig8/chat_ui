/**
 * Store - Single source of truth for application state
 *
 * Provides reactive state management with subscriptions.
 * All state mutations should go through this store.
 */

const Store = {
    _state: {
        // Current conversation
        currentConversationId: null,
        currentBranch: [0],
        isAgent: false,

        // Streaming state
        isStreaming: false,
        streamToken: 0, // Incremented for each new stream to detect stale updates

        // Messages in current conversation
        messages: [],

        // Conversation list
        conversations: [],

        // Projects
        projects: [],
        conversationProjectMap: {},

        // UI state
        sidebarCollapsed: false,
        settingsOpen: false,
        currentView: 'chat', // 'chat', 'settings', 'workspace'

        // Settings
        settings: {
            model: null,
            systemPrompt: null,
            thinkingEnabled: true,
            thinkingBudget: 60000,
            maxTokens: 64000,
            temperature: 1.0,
            webSearchEnabled: false
        }
    },

    _subscribers: new Map(),
    _nextSubscriberId: 1,

    /**
     * Get a state value
     * @param {string} key - State key
     * @returns {any} State value
     */
    get(key) {
        if (key in this._state) {
            return this._state[key];
        }
        console.warn(`[Store] Unknown state key: ${key}`);
        return undefined;
    },

    /**
     * Get entire state (for debugging)
     */
    getState() {
        return { ...this._state };
    },

    /**
     * Set state values and notify subscribers
     * @param {object} updates - Key-value pairs to update
     */
    set(updates) {
        const changedKeys = [];

        for (const [key, value] of Object.entries(updates)) {
            if (!(key in this._state)) {
                console.warn(`[Store] Unknown state key: ${key}`);
                continue;
            }

            // Check if value actually changed
            if (this._state[key] !== value) {
                this._state[key] = value;
                changedKeys.push(key);
            }
        }

        // Notify subscribers for changed keys
        if (changedKeys.length > 0) {
            this._notifySubscribers(changedKeys);
        }
    },

    /**
     * Subscribe to state changes
     * @param {string|string[]} keys - State key(s) to watch
     * @param {function} callback - Called with (newValue, key) when state changes
     * @returns {function} Unsubscribe function
     */
    subscribe(keys, callback) {
        const keyArray = Array.isArray(keys) ? keys : [keys];
        const id = this._nextSubscriberId++;

        for (const key of keyArray) {
            if (!this._subscribers.has(key)) {
                this._subscribers.set(key, new Map());
            }
            this._subscribers.get(key).set(id, callback);
        }

        // Return unsubscribe function
        return () => {
            for (const key of keyArray) {
                const keySubscribers = this._subscribers.get(key);
                if (keySubscribers) {
                    keySubscribers.delete(id);
                }
            }
        };
    },

    /**
     * Notify subscribers of state changes
     * @private
     */
    _notifySubscribers(changedKeys) {
        for (const key of changedKeys) {
            const keySubscribers = this._subscribers.get(key);
            if (keySubscribers) {
                const value = this._state[key];
                for (const callback of keySubscribers.values()) {
                    try {
                        callback(value, key);
                    } catch (e) {
                        console.error(`[Store] Subscriber error for ${key}:`, e);
                    }
                }
            }
        }
    },

    // =========================================================================
    // Convenience methods for common operations
    // =========================================================================

    /**
     * Set the current conversation
     */
    setCurrentConversation(conversationId, branch = [0], isAgent = false) {
        this.set({
            currentConversationId: conversationId,
            currentBranch: branch,
            isAgent: isAgent,
            messages: [],
            isStreaming: false
        });
    },

    /**
     * Clear current conversation (go to empty state)
     */
    clearCurrentConversation() {
        this.set({
            currentConversationId: null,
            currentBranch: [0],
            isAgent: false,
            messages: [],
            isStreaming: false
        });
    },

    /**
     * Start streaming and get a new stream token
     * @returns {number} Stream token for this stream
     */
    startStreaming() {
        const token = this._state.streamToken + 1;
        this.set({
            isStreaming: true,
            streamToken: token
        });
        return token;
    },

    /**
     * End streaming
     */
    endStreaming() {
        this.set({ isStreaming: false });
    },

    /**
     * Check if a stream token is still current
     * @param {number} token - Token to check
     * @returns {boolean} True if token is current
     */
    isStreamCurrent(token) {
        return this._state.streamToken === token;
    },

    /**
     * Add a message to the current conversation
     * @param {object} message - Message to add
     */
    addMessage(message) {
        const messages = [...this._state.messages, message];
        this.set({ messages });
    },

    /**
     * Update a message by ID
     * @param {string} messageId - Message ID
     * @param {object} updates - Fields to update
     */
    updateMessage(messageId, updates) {
        const messages = this._state.messages.map(msg => {
            if (msg.id === messageId) {
                return { ...msg, ...updates };
            }
            return msg;
        });
        this.set({ messages });
    },

    /**
     * Update the last message
     * @param {object} updates - Fields to update
     */
    updateLastMessage(updates) {
        if (this._state.messages.length === 0) return;

        const messages = [...this._state.messages];
        const lastIndex = messages.length - 1;
        messages[lastIndex] = { ...messages[lastIndex], ...updates };
        this.set({ messages });
    },

    /**
     * Remove messages from a position onwards
     * @param {number} fromPosition - Position to start removal
     */
    removeMessagesFrom(fromPosition) {
        const messages = this._state.messages.filter(
            msg => msg.position < fromPosition
        );
        this.set({ messages });
    }
};

// Make Store globally available
window.Store = Store;

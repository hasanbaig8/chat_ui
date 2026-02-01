/**
 * ChatController - Orchestrates chat operations
 *
 * This controller handles the logic of sending messages, streaming responses,
 * and coordinating with the Store. It does NOT touch the DOM directly.
 * Use ChatRenderer for DOM manipulation.
 */

const ChatController = {
    // Current abort controller for streaming
    abortController: null,

    /**
     * Send a message and stream the response
     *
     * @param {string} content - Message content
     * @param {object} options - Options
     * @param {string} options.conversationId - Conversation ID
     * @param {boolean} options.isAgent - Whether this is an agent conversation
     * @param {Array} options.branch - Current branch
     * @param {Array} options.messages - Messages to send (for API)
     * @param {object} options.settings - Chat settings
     * @param {function} options.onTextChunk - Called with text chunks
     * @param {function} options.onThinkingChunk - Called with thinking chunks
     * @param {function} options.onToolUse - Called with tool use events
     * @param {function} options.onToolResult - Called with tool results
     * @param {function} options.onSurfaceContent - Called with surface content
     * @param {function} options.onWebSearchStart - Called when web search starts
     * @param {function} options.onWebSearchQuery - Called with search query
     * @param {function} options.onWebSearchResult - Called with search results
     * @param {function} options.onMessageId - Called with message ID
     * @param {function} options.onDone - Called when stream completes
     * @param {function} options.onError - Called on error
     */
    async streamResponse(options) {
        const {
            conversationId,
            isAgent,
            branch,
            messages,
            settings,
            onTextChunk,
            onThinkingChunk,
            onToolUse,
            onToolResult,
            onSurfaceContent,
            onWebSearchStart,
            onWebSearchQuery,
            onWebSearchResult,
            onMessageId,
            onDone,
            onError
        } = options;

        // Start streaming in Store
        const streamToken = Store.startStreaming();
        SSEClient.startStream();

        // Create abort controller
        this.abortController = new AbortController();

        // Mark conversation as streaming in tracker
        StreamingTracker.setStreaming(conversationId, {
            streaming: true,
            type: isAgent ? 'agent' : 'normal',
            stoppable: isAgent
        });

        try {
            let response;

            if (isAgent) {
                response = await ApiClient.streamAgentChat({
                    messages,
                    conversation_id: conversationId,
                    branch,
                    system_prompt: settings.systemPrompt,
                    model: settings.model
                }, this.abortController.signal);
            } else {
                response = await ApiClient.streamChat({
                    messages,
                    conversation_id: conversationId,
                    branch,
                    model: settings.model,
                    system_prompt: settings.systemPrompt,
                    temperature: settings.temperature,
                    max_tokens: settings.maxTokens,
                    top_p: settings.topP,
                    top_k: settings.topK,
                    thinking_enabled: settings.thinkingEnabled,
                    thinking_budget: settings.thinkingBudget,
                    web_search_enabled: settings.webSearchEnabled,
                    web_search_max_uses: settings.webSearchMaxUses
                }, this.abortController.signal);
            }

            if (!response.ok) {
                const error = await response.json().catch(() => ({ detail: response.statusText }));
                throw new Error(error.detail || `HTTP ${response.status}`);
            }

            // Process SSE stream with race condition protection
            await SSEClient.processStream(
                response,
                {
                    onEvent: (event) => {
                        // Double-check we're still on the same conversation
                        if (Store.get('currentConversationId') !== conversationId) {
                            return;
                        }

                        switch (event.type) {
                            case 'message_id':
                                if (onMessageId) onMessageId(event.id, event.position);
                                break;
                            case 'text':
                                if (onTextChunk) onTextChunk(event.content);
                                break;
                            case 'thinking':
                                if (onThinkingChunk) onThinkingChunk(event.content);
                                break;
                            case 'tool_use':
                                if (onToolUse) onToolUse(event);
                                break;
                            case 'tool_result':
                                if (onToolResult) onToolResult(event);
                                break;
                            case 'surface_content':
                                if (onSurfaceContent) onSurfaceContent(event);
                                break;
                            case 'web_search_start':
                                if (onWebSearchStart) onWebSearchStart(event);
                                break;
                            case 'web_search_query':
                                if (onWebSearchQuery) onWebSearchQuery(event);
                                break;
                            case 'web_search_result':
                                if (onWebSearchResult) onWebSearchResult(event);
                                break;
                            case 'error':
                                if (onError) onError(new Error(event.content));
                                break;
                            case 'stopped':
                                console.log('[ChatController] Stream was stopped');
                                break;
                            case 'done':
                                // Stream complete
                                break;
                        }
                    },
                    onDone: () => {
                        Store.endStreaming();
                        StreamingTracker.setStreaming(conversationId, { streaming: false });
                        if (onDone) onDone();
                    },
                    onError: (error) => {
                        Store.endStreaming();
                        StreamingTracker.setStreaming(conversationId, { streaming: false });
                        if (onError) onError(error);
                    }
                },
                streamToken,
                conversationId
            );

        } catch (error) {
            Store.endStreaming();
            StreamingTracker.setStreaming(conversationId, { streaming: false });

            // Don't report abort errors
            if (error.name === 'AbortError') {
                console.log('[ChatController] Stream aborted');
                if (onDone) onDone();
                return;
            }

            if (onError) onError(error);
        } finally {
            this.abortController = null;
        }
    },

    /**
     * Stop the current stream
     */
    async stopStream(conversationId, isAgent) {
        if (this.abortController) {
            this.abortController.abort();
        }

        // For agent streams, also signal the backend to stop
        if (isAgent && conversationId) {
            try {
                await ApiClient.stopAgentStream(conversationId);
            } catch (e) {
                console.warn('[ChatController] Failed to stop agent stream:', e);
            }
        }

        Store.endStreaming();
        StreamingTracker.setStreaming(conversationId, { streaming: false });
        SSEClient.invalidateStreams();
    },

    /**
     * Load a conversation and its messages
     *
     * @param {string} conversationId - Conversation to load
     * @param {Array} branch - Optional branch to load
     * @returns {Promise<object>} Conversation data
     */
    async loadConversation(conversationId, branch = null) {
        // Invalidate any in-flight streams when switching conversations
        SSEClient.invalidateStreams();

        const conversation = await ApiClient.getConversation(conversationId, branch);

        Store.setCurrentConversation(
            conversation.id,
            conversation.current_branch || [0],
            conversation.is_agent || false
        );

        Store.set({
            messages: conversation.messages || []
        });

        return conversation;
    },

    /**
     * Create a new conversation
     *
     * @param {string} title - Conversation title
     * @param {boolean} isAgent - Whether this is an agent conversation
     * @param {object} options - Additional options
     * @returns {Promise<object>} New conversation data
     */
    async createConversation(title, isAgent = false, options = {}) {
        const conversation = await ApiClient.createConversation(
            title,
            options.model,
            options.systemPrompt,
            isAgent,
            options.settings
        );

        Store.setCurrentConversation(
            conversation.id,
            [0],
            isAgent
        );

        return conversation;
    },

    /**
     * Add a user message to the current conversation
     *
     * @param {string} content - Message content
     * @returns {Promise<object>} Message data
     */
    async addUserMessage(content) {
        const conversationId = Store.get('currentConversationId');
        const branch = Store.get('currentBranch');

        if (!conversationId) {
            throw new Error('No conversation selected');
        }

        const message = await ApiClient.addMessage(
            conversationId,
            'user',
            content,
            branch
        );

        Store.addMessage(message);

        return message;
    },

    /**
     * Edit a user message (creates new branch)
     *
     * @param {number} userMsgIndex - User message index
     * @param {string} content - New content
     * @returns {Promise<object>} Result with new branch
     */
    async editMessage(userMsgIndex, content) {
        const conversationId = Store.get('currentConversationId');
        const branch = Store.get('currentBranch');

        const result = await ApiClient.editMessage(
            conversationId,
            userMsgIndex,
            content,
            branch
        );

        Store.set({ currentBranch: result.branch });

        return result;
    },

    /**
     * Switch to a different branch
     *
     * @param {number} userMsgIndex - Position to switch at
     * @param {number} direction - -1 for prev, +1 for next
     * @returns {Promise<object>} Result with new branch and conversation
     */
    async switchBranch(userMsgIndex, direction) {
        const conversationId = Store.get('currentConversationId');
        const branch = Store.get('currentBranch');

        const result = await ApiClient.switchBranch(
            conversationId,
            userMsgIndex,
            direction,
            branch
        );

        Store.set({
            currentBranch: result.branch,
            messages: result.conversation.messages || []
        });

        return result;
    },

    /**
     * Delete messages from a position onwards
     *
     * @param {number} position - Position to delete from
     * @returns {Promise<void>}
     */
    async deleteMessagesFrom(position) {
        const conversationId = Store.get('currentConversationId');
        const branch = Store.get('currentBranch');

        await ApiClient.deleteMessagesFrom(conversationId, position, branch);

        Store.removeMessagesFrom(position);
    }
};

// Make ChatController globally available
window.ChatController = ChatController;

/**
 * StreamingDisplay - Connects stream state to DOM
 *
 * Handles the connection between BackgroundStreamManager's accumulated
 * state and the actual DOM rendering. When switching conversations,
 * this module disconnects from one stream and can reconnect to another,
 * syncing the DOM to the current state and subscribing to future updates.
 *
 * Key responsibilities:
 * - Sync accumulated stream state to DOM when (re)connecting
 * - Subscribe to live updates and render incrementally
 * - Handle finalization when stream completes
 * - Clean up properly when disconnecting
 */

const StreamingDisplay = {
    _unsubscribe: null,
    _conversationId: null,
    _messageEl: null,
    _contentEl: null,
    _indicator: null,
    _currentThinkingEl: null,
    _toolBlockEls: new Map(),  // tool_use_id -> DOM element

    /**
     * Connect to a stream and start rendering
     * @param {string} conversationId - Conversation ID
     * @param {Element} messageEl - Message DOM element (optional, will find by message ID)
     */
    connect(conversationId, messageEl = null) {
        // Disconnect from any existing stream first
        this.disconnect();

        const stream = BackgroundStreamManager.getStream(conversationId);
        if (!stream) {
            console.warn('[StreamingDisplay] No stream to connect to:', conversationId);
            return;
        }

        console.log('[StreamingDisplay] Connecting to stream:', conversationId);

        this._conversationId = conversationId;
        this._messageEl = messageEl;
        this._toolBlockEls.clear();
        this._currentThinkingEl = null;

        // Find or create message element
        if (!this._messageEl && stream.messageId) {
            this._messageEl = document.querySelector(`.message[data-message-id="${stream.messageId}"]`);
        }

        // If we still don't have a message element, we can't render
        // This is fine - we'll create one when we get the first event
        if (this._messageEl) {
            this._contentEl = this._messageEl.querySelector('.message-content');

            // Create streaming indicator if not present
            this._indicator = this._contentEl.querySelector('.streaming-indicator');
            if (!this._indicator && !stream.isComplete) {
                this._indicator = document.createElement('span');
                this._indicator.className = 'streaming-indicator';
                this._contentEl.appendChild(this._indicator);
            }

            // Sync current state to DOM
            this._syncStateToDOM(stream);
        }

        // Subscribe to future updates
        this._unsubscribe = BackgroundStreamManager.subscribe(conversationId, (updateType, event, stream) => {
            this._handleUpdate(updateType, event, stream);
        });
    },

    /**
     * Disconnect from current stream
     */
    disconnect() {
        if (this._unsubscribe) {
            this._unsubscribe();
            this._unsubscribe = null;
        }

        console.log('[StreamingDisplay] Disconnected from:', this._conversationId);

        this._conversationId = null;
        this._messageEl = null;
        this._contentEl = null;
        this._indicator = null;
        this._currentThinkingEl = null;
        this._toolBlockEls.clear();
    },

    /**
     * Check if currently connected to a stream
     * @returns {boolean}
     */
    isConnected() {
        return this._conversationId !== null;
    },

    /**
     * Get the conversation ID we're connected to
     * @returns {string|null}
     */
    getConnectedConversationId() {
        return this._conversationId;
    },

    /**
     * Sync accumulated stream state to DOM
     * Called when (re)connecting to a stream
     * @private
     */
    _syncStateToDOM(stream) {
        if (!this._contentEl) return;

        console.log('[StreamingDisplay] Syncing state to DOM:', stream.contentBlocks.length, 'blocks');

        // Clear existing content (but keep indicator)
        const indicator = this._indicator;
        this._contentEl.innerHTML = '';
        if (indicator && !stream.isComplete) {
            this._contentEl.appendChild(indicator);
        }

        // Render all accumulated content blocks
        for (const block of stream.contentBlocks) {
            this._renderBlock(block, stream);
        }

        // Render current thinking if in progress
        if (stream.currentThinking) {
            this._currentThinkingEl = ChatManager.createThinkingBlock(true);
            ChatManager.updateThinkingBlock(this._currentThinkingEl, stream.currentThinking);
            if (indicator) {
                this._contentEl.insertBefore(this._currentThinkingEl, indicator);
            } else {
                this._contentEl.appendChild(this._currentThinkingEl);
            }
        }

        // Render current text if in progress
        if (stream.currentText) {
            this._updateTextContent(stream.currentText);
        }

        // Move indicator to end
        if (indicator && indicator.parentNode) {
            this._contentEl.appendChild(indicator);
        }

        ChatManager.scrollToBottom();
    },

    /**
     * Render a content block to DOM
     * @private
     */
    _renderBlock(block, stream) {
        const indicator = this._indicator;

        switch (block.type) {
            case 'thinking':
                const thinkingEl = ChatManager.createThinkingBlock(false);
                ChatManager.updateThinkingBlock(thinkingEl, block.content);
                ChatManager.finalizeThinkingBlock(thinkingEl);
                thinkingEl.classList.add('collapsed');
                if (indicator) {
                    this._contentEl.insertBefore(thinkingEl, indicator);
                } else {
                    this._contentEl.appendChild(thinkingEl);
                }
                break;

            case 'text':
                const textDiv = document.createElement('div');
                textDiv.className = 'text-segment finalized-text';
                ChatManager.renderMarkdownContent(textDiv, block.text);
                ChatManager.addCodeCopyButtons(textDiv);
                if (indicator) {
                    this._contentEl.insertBefore(textDiv, indicator);
                } else {
                    this._contentEl.appendChild(textDiv);
                }
                break;

            case 'tool_use':
                const toolBlock = ChatManager.createToolUseBlock(block.name, block.input, block.id);
                this._toolBlockEls.set(block.id, toolBlock);

                // Apply result if we have it
                const result = stream.toolResults.get(block.id);
                if (result) {
                    ChatManager.applyToolResult(toolBlock, result.content, result.is_error);
                }

                if (indicator) {
                    this._contentEl.insertBefore(toolBlock, indicator);
                } else {
                    this._contentEl.appendChild(toolBlock);
                }
                break;

            case 'surface_content':
                let surfaceBlock;
                if (block.filename && !block.content) {
                    surfaceBlock = ChatManager.createSurfaceContentPlaceholder(
                        block.content_type,
                        block.title,
                        block.content_id
                    );
                    // Load content async
                    ChatManager.loadSurfaceContent(
                        surfaceBlock,
                        block.filename,
                        block.content_type,
                        block.title,
                        block.content_id
                    );
                } else {
                    surfaceBlock = ChatManager.createSurfaceContentBlock(
                        block.content,
                        block.content_type,
                        block.title,
                        block.content_id
                    );
                }
                if (indicator) {
                    this._contentEl.insertBefore(surfaceBlock, indicator);
                } else {
                    this._contentEl.appendChild(surfaceBlock);
                }
                break;

            case 'web_search':
                const searchBlock = ChatManager.createWebSearchBlock(block.id, block.name);
                if (block.query) {
                    ChatManager.updateWebSearchQuery(searchBlock, block.query);
                }
                if (block.results && block.results.length > 0) {
                    ChatManager.updateWebSearchBlock(searchBlock, block.results);
                }
                if (indicator) {
                    this._contentEl.insertBefore(searchBlock, indicator);
                } else {
                    this._contentEl.appendChild(searchBlock);
                }
                break;
        }
    },

    /**
     * Handle an update from BackgroundStreamManager
     * @private
     */
    _handleUpdate(updateType, event, stream) {
        // Verify we're still displaying this conversation
        const currentConvId = Store.get('currentConversationId');
        if (currentConvId !== this._conversationId) {
            console.log('[StreamingDisplay] Ignoring update - different conversation active');
            return;
        }

        // Make sure we have a content element
        if (!this._contentEl) {
            // Try to find it
            if (stream.messageId) {
                this._messageEl = document.querySelector(`.message[data-message-id="${stream.messageId}"]`);
                if (this._messageEl) {
                    this._contentEl = this._messageEl.querySelector('.message-content');
                    this._indicator = this._contentEl.querySelector('.streaming-indicator');
                }
            }

            if (!this._contentEl) {
                console.warn('[StreamingDisplay] No content element for update');
                return;
            }
        }

        switch (updateType) {
            case 'message_id':
                if (this._messageEl) {
                    this._messageEl.dataset.messageId = event.id;
                }
                break;

            case 'thinking':
                // Create or update thinking block
                if (!this._currentThinkingEl) {
                    // Finalize any existing text container
                    const streamingText = this._contentEl.querySelector('.streaming-text');
                    if (streamingText) {
                        streamingText.classList.remove('streaming-text');
                        streamingText.classList.add('finalized-text');
                    }

                    this._currentThinkingEl = ChatManager.createThinkingBlock(true);
                    if (this._indicator) {
                        this._contentEl.insertBefore(this._currentThinkingEl, this._indicator);
                    } else {
                        this._contentEl.appendChild(this._currentThinkingEl);
                    }
                }
                ChatManager.updateThinkingBlock(this._currentThinkingEl, stream.currentThinking);
                ChatManager.scrollToBottom();
                break;

            case 'text':
                // Finalize thinking if needed
                if (this._currentThinkingEl) {
                    ChatManager.finalizeThinkingBlock(this._currentThinkingEl);
                    this._currentThinkingEl = null;
                }
                this._updateTextContent(stream.currentText);
                ChatManager.scrollToBottom();
                break;

            case 'tool_use':
                // Finalize thinking if needed
                if (this._currentThinkingEl) {
                    ChatManager.finalizeThinkingBlock(this._currentThinkingEl);
                    this._currentThinkingEl = null;
                }
                // Finalize text container
                const streamingText = this._contentEl.querySelector('.streaming-text');
                if (streamingText) {
                    streamingText.classList.remove('streaming-text');
                    streamingText.classList.add('finalized-text');
                }

                // Create tool block
                const toolBlock = ChatManager.createToolUseBlock(event.name, event.input, event.id);
                this._toolBlockEls.set(event.id, toolBlock);
                if (this._indicator) {
                    this._contentEl.insertBefore(toolBlock, this._indicator);
                } else {
                    this._contentEl.appendChild(toolBlock);
                }
                ChatManager.scrollToBottom();
                break;

            case 'tool_result':
                // Find tool block and update
                let toolEl = this._toolBlockEls.get(event.tool_use_id);
                if (!toolEl) {
                    // Try DOM query
                    toolEl = this._contentEl.querySelector(`.tool-use-block[data-tool-use-id="${event.tool_use_id}"]`);
                }
                if (toolEl) {
                    ChatManager.applyToolResult(toolEl, event.content, event.is_error);
                }
                ChatManager.scrollToBottom();
                break;

            case 'surface_content':
                // Finalize thinking if needed
                if (this._currentThinkingEl) {
                    ChatManager.finalizeThinkingBlock(this._currentThinkingEl);
                    this._currentThinkingEl = null;
                }

                const surfaceBlock = ChatManager.createSurfaceContentBlock(
                    event.content,
                    event.content_type,
                    event.title,
                    event.content_id
                );
                if (this._indicator) {
                    this._contentEl.insertBefore(surfaceBlock, this._indicator);
                } else {
                    this._contentEl.appendChild(surfaceBlock);
                }
                ChatManager.scrollToBottom();
                break;

            case 'web_search_start':
                // Finalize thinking if needed
                if (this._currentThinkingEl) {
                    ChatManager.finalizeThinkingBlock(this._currentThinkingEl);
                    this._currentThinkingEl = null;
                }

                const searchBlock = ChatManager.createWebSearchBlock(event.id, event.name);
                this._toolBlockEls.set(event.id, searchBlock);  // Reuse toolBlockEls for search blocks
                if (this._indicator) {
                    this._contentEl.insertBefore(searchBlock, this._indicator);
                } else {
                    this._contentEl.appendChild(searchBlock);
                }
                ChatManager.scrollToBottom();
                break;

            case 'web_search_query':
                const wsBlockQ = this._toolBlockEls.get(event.id);
                if (wsBlockQ) {
                    ChatManager.updateWebSearchQuery(wsBlockQ, event.partial_query);
                }
                break;

            case 'web_search_result':
                const wsBlockR = this._toolBlockEls.get(event.tool_use_id);
                if (wsBlockR) {
                    ChatManager.updateWebSearchBlock(wsBlockR, event.results);
                }
                break;

            case 'error':
                if (this._contentEl) {
                    ChatManager.showError(this._contentEl, event.content);
                }
                break;

            case 'stream_complete':
                this._finalizeMessage(stream);
                break;
        }
    },

    /**
     * Update text content in DOM
     * @private
     */
    _updateTextContent(text) {
        if (!this._contentEl) return;

        // Find or create streaming text container
        let textContainer = this._contentEl.querySelector('.streaming-text');
        if (!textContainer) {
            textContainer = document.createElement('div');
            textContainer.className = 'streaming-text';
            if (this._indicator) {
                this._contentEl.insertBefore(textContainer, this._indicator);
            } else {
                this._contentEl.appendChild(textContainer);
            }
        }

        ChatManager.renderMarkdownContent(textContainer, text);
        ChatManager.addCodeCopyButtons(textContainer);
    },

    /**
     * Finalize message after stream completes
     * @private
     */
    _finalizeMessage(stream) {
        if (!this._contentEl || !this._messageEl) return;

        console.log('[StreamingDisplay] Finalizing message');

        // Remove indicator
        if (this._indicator && this._indicator.parentNode) {
            this._indicator.remove();
            this._indicator = null;
        }

        // Finalize any in-progress thinking
        if (this._currentThinkingEl) {
            ChatManager.finalizeThinkingBlock(this._currentThinkingEl);
            this._currentThinkingEl = null;
        }

        // Convert streaming-text to finalized-text
        const streamingText = this._contentEl.querySelector('.streaming-text');
        if (streamingText) {
            streamingText.classList.remove('streaming-text');
            streamingText.classList.add('finalized-text');
        }

        ChatManager.addCodeCopyButtons(this._contentEl);

        // Add message actions if not present
        if (!this._messageEl.querySelector('.message-actions')) {
            const actionsDiv = ChatManager.createMessageActions('assistant');
            this._messageEl.appendChild(actionsDiv);
        }

        // Update Store with message
        if (stream.messageId) {
            const content = BackgroundStreamManager.buildFinalContent(stream);
            Store.addMessage({
                id: stream.messageId,
                role: 'assistant',
                content: content,
                position: stream.position,
                version: 1,
                total_versions: 1
            });
        }

        // Update UI state
        Store.endStreaming();
        ChatManager.updateSendButton();
        ChatManager.updateContextStats();

        // Update StreamingTracker
        if (typeof StreamingTracker !== 'undefined') {
            StreamingTracker.setStreaming(stream.conversationId, { streaming: false });
        }
    },

    /**
     * Set message element (called when creating new message)
     * @param {Element} messageEl - Message DOM element
     */
    setMessageElement(messageEl) {
        this._messageEl = messageEl;
        if (messageEl) {
            this._contentEl = messageEl.querySelector('.message-content');
            this._indicator = this._contentEl.querySelector('.streaming-indicator');
        }
    }
};

// Make StreamingDisplay globally available
window.StreamingDisplay = StreamingDisplay;

/**
 * BackgroundStreamManager - Central state management for all active streams
 *
 * Accumulates stream content independently of which conversation is displayed.
 * This allows agent streams to continue in the background when switching
 * conversations, with robust handling of rapid clicks.
 *
 * Architecture:
 * - Separates data accumulation from DOM rendering
 * - Maintains stream state even when not viewing the conversation
 * - Notifies subscribers (StreamingDisplay) of updates
 * - Handles reconnection when returning to a streaming conversation
 */

const BackgroundStreamManager = {
    // Map<conversationId, StreamState>
    _streams: new Map(),

    /**
     * StreamState structure:
     * {
     *   conversationId: string,
     *   messageId: string | null,
     *   sessionId: string | null,
     *   position: number,
     *   type: 'normal' | 'agent',
     *
     *   // Content accumulation
     *   contentBlocks: [],        // Finalized blocks (thinking, tool_use, surface_content, web_search)
     *   currentText: '',          // In-progress text being accumulated
     *   currentThinking: '',      // In-progress thinking being accumulated
     *   toolResults: Map(),       // tool_use_id -> { content, is_error }
     *
     *   // Stream status
     *   isComplete: false,
     *   error: null,
     *
     *   // Subscribers for live updates
     *   subscribers: Set()        // Callbacks: (updateType, event, stream) => void
     * }
     */

    /**
     * Start tracking a new stream
     * @param {string} conversationId - Conversation ID
     * @param {string} type - 'normal' or 'agent'
     * @param {number} position - Message position in conversation
     * @returns {object} Stream state
     */
    startStream(conversationId, type, position) {
        console.log('[BackgroundStreamManager] Starting stream:', conversationId, type, position);

        const stream = {
            conversationId,
            messageId: null,
            sessionId: null,
            position,
            type,
            contentBlocks: [],
            currentText: '',
            currentThinking: '',
            toolResults: new Map(),
            isComplete: false,
            error: null,
            subscribers: new Set()
        };

        this._streams.set(conversationId, stream);
        return stream;
    },

    /**
     * Get stream state for a conversation
     * @param {string} conversationId - Conversation ID
     * @returns {object|null} Stream state or null if not found
     */
    getStream(conversationId) {
        return this._streams.get(conversationId) || null;
    },

    /**
     * Check if a conversation has an active (non-complete) stream
     * @param {string} conversationId - Conversation ID
     * @returns {boolean}
     */
    isStreaming(conversationId) {
        const stream = this._streams.get(conversationId);
        return stream ? !stream.isComplete : false;
    },

    /**
     * Subscribe to stream updates
     * @param {string} conversationId - Conversation ID
     * @param {function} callback - Called with (updateType, event, stream)
     * @returns {function} Unsubscribe function
     */
    subscribe(conversationId, callback) {
        const stream = this._streams.get(conversationId);
        if (!stream) {
            console.warn('[BackgroundStreamManager] Cannot subscribe to non-existent stream:', conversationId);
            return () => {};
        }

        stream.subscribers.add(callback);
        console.log('[BackgroundStreamManager] Subscribed to stream:', conversationId, 'Total subscribers:', stream.subscribers.size);

        return () => {
            stream.subscribers.delete(callback);
            console.log('[BackgroundStreamManager] Unsubscribed from stream:', conversationId, 'Total subscribers:', stream.subscribers.size);
        };
    },

    /**
     * Unsubscribe a specific callback from stream updates
     * @param {string} conversationId - Conversation ID
     * @param {function} callback - The callback to remove
     */
    unsubscribe(conversationId, callback) {
        const stream = this._streams.get(conversationId);
        if (stream) {
            stream.subscribers.delete(callback);
        }
    },

    /**
     * Handle an SSE event and accumulate data
     * @param {string} conversationId - Conversation ID
     * @param {object} event - SSE event object
     */
    handleEvent(conversationId, event) {
        const stream = this._streams.get(conversationId);
        if (!stream) {
            console.warn('[BackgroundStreamManager] Event for unknown stream:', conversationId);
            return;
        }

        let updateType = event.type;

        switch (event.type) {
            case 'message_id':
                stream.messageId = event.id;
                break;

            case 'session_id':
                stream.sessionId = event.session_id;
                break;

            case 'thinking':
                // If we were accumulating text, finalize it first
                if (stream.currentText) {
                    stream.contentBlocks.push({ type: 'text', text: stream.currentText });
                    stream.currentText = '';
                }
                // Accumulate thinking
                stream.currentThinking += event.content;
                break;

            case 'text':
                // If we were accumulating thinking, finalize it first
                if (stream.currentThinking) {
                    stream.contentBlocks.push({ type: 'thinking', content: stream.currentThinking });
                    stream.currentThinking = '';
                }
                // Accumulate text
                stream.currentText += event.content;
                break;

            case 'tool_use':
                // Finalize any pending text/thinking
                this._finalizeCurrentContent(stream);
                // Add tool_use block
                stream.contentBlocks.push({
                    type: 'tool_use',
                    id: event.id,
                    name: event.name,
                    input: event.input
                });
                break;

            case 'tool_result':
                // Store tool result (may arrive out of order)
                stream.toolResults.set(event.tool_use_id, {
                    content: event.content,
                    is_error: event.is_error || false
                });
                break;

            case 'surface_content':
                // Finalize any pending text/thinking
                this._finalizeCurrentContent(stream);
                // Add surface_content block
                stream.contentBlocks.push({
                    type: 'surface_content',
                    content_id: event.content_id,
                    content_type: event.content_type,
                    title: event.title,
                    content: event.content,
                    filename: event.filename
                });
                break;

            case 'web_search_start':
                // Finalize any pending text/thinking
                this._finalizeCurrentContent(stream);
                // Add web_search block (will be updated with results later)
                stream.contentBlocks.push({
                    type: 'web_search',
                    id: event.id,
                    name: event.name,
                    query: '',
                    results: []
                });
                break;

            case 'web_search_query':
                // Update the query on the web_search block
                const searchBlock = stream.contentBlocks.find(
                    b => b.type === 'web_search' && b.id === event.id
                );
                if (searchBlock) {
                    searchBlock.query = event.partial_query || event.query || '';
                }
                break;

            case 'web_search_result':
                // Update results on the web_search block
                const wsBlock = stream.contentBlocks.find(
                    b => b.type === 'web_search' && b.id === event.tool_use_id
                );
                if (wsBlock) {
                    wsBlock.results = event.results || [];
                }
                break;

            case 'error':
                stream.error = event.content;
                break;

            case 'stopped':
                // Stream was stopped by user
                stream.isComplete = true;
                break;

            case 'done':
                // Stream completed normally
                // Don't set isComplete here - let endStream do it
                break;
        }

        // Notify all subscribers
        this._notifySubscribers(stream, updateType, event);
    },

    /**
     * Finalize any pending text or thinking content
     * @private
     */
    _finalizeCurrentContent(stream) {
        if (stream.currentThinking) {
            stream.contentBlocks.push({ type: 'thinking', content: stream.currentThinking });
            stream.currentThinking = '';
        }
        if (stream.currentText) {
            stream.contentBlocks.push({ type: 'text', text: stream.currentText });
            stream.currentText = '';
        }
    },

    /**
     * Notify all subscribers of an update
     * @private
     */
    _notifySubscribers(stream, updateType, event) {
        for (const callback of stream.subscribers) {
            try {
                callback(updateType, event, stream);
            } catch (e) {
                console.error('[BackgroundStreamManager] Subscriber error:', e);
            }
        }
    },

    /**
     * Mark a stream as complete
     * @param {string} conversationId - Conversation ID
     */
    endStream(conversationId) {
        const stream = this._streams.get(conversationId);
        if (!stream) return;

        console.log('[BackgroundStreamManager] Ending stream:', conversationId);

        // Finalize any remaining content
        this._finalizeCurrentContent(stream);

        stream.isComplete = true;

        // Notify subscribers of completion
        this._notifySubscribers(stream, 'stream_complete', { type: 'stream_complete' });
    },

    /**
     * Remove a stream entirely (cleanup)
     * @param {string} conversationId - Conversation ID
     */
    removeStream(conversationId) {
        const stream = this._streams.get(conversationId);
        if (stream) {
            console.log('[BackgroundStreamManager] Removing stream:', conversationId);
            stream.subscribers.clear();
            this._streams.delete(conversationId);
        }
    },

    /**
     * Build final content array from accumulated stream data
     * Includes tool_result blocks interleaved with tool_use blocks
     * @param {object} stream - Stream state
     * @returns {Array} Content blocks array
     */
    buildFinalContent(stream) {
        if (!stream) return [];

        const content = [];

        for (const block of stream.contentBlocks) {
            content.push(block);

            // If this is a tool_use block, add its result if we have it
            if (block.type === 'tool_use') {
                const result = stream.toolResults.get(block.id);
                if (result) {
                    content.push({
                        type: 'tool_result',
                        tool_use_id: block.id,
                        content: result.content,
                        is_error: result.is_error
                    });
                }
            }
        }

        // Add any remaining current text
        if (stream.currentText) {
            content.push({ type: 'text', text: stream.currentText });
        }

        // Add any remaining current thinking
        if (stream.currentThinking) {
            content.push({ type: 'thinking', content: stream.currentThinking });
        }

        return content;
    },

    /**
     * Get current text being accumulated (for display)
     * @param {string} conversationId - Conversation ID
     * @returns {string} Current text
     */
    getCurrentText(conversationId) {
        const stream = this._streams.get(conversationId);
        return stream ? stream.currentText : '';
    },

    /**
     * Get current thinking being accumulated (for display)
     * @param {string} conversationId - Conversation ID
     * @returns {string} Current thinking
     */
    getCurrentThinking(conversationId) {
        const stream = this._streams.get(conversationId);
        return stream ? stream.currentThinking : '';
    },

    /**
     * Get all active stream IDs (for debugging)
     * @returns {Array} Array of conversation IDs
     */
    getActiveStreams() {
        const active = [];
        for (const [id, stream] of this._streams) {
            if (!stream.isComplete) {
                active.push(id);
            }
        }
        return active;
    },

    /**
     * Debug: dump stream state
     */
    debugDump(conversationId) {
        const stream = this._streams.get(conversationId);
        if (!stream) {
            console.log('[BackgroundStreamManager] No stream for:', conversationId);
            return;
        }
        console.log('[BackgroundStreamManager] Stream state:', {
            conversationId,
            messageId: stream.messageId,
            position: stream.position,
            type: stream.type,
            isComplete: stream.isComplete,
            contentBlocks: stream.contentBlocks.length,
            currentTextLength: stream.currentText.length,
            currentThinkingLength: stream.currentThinking.length,
            toolResults: stream.toolResults.size,
            subscribers: stream.subscribers.size
        });
    }
};

// Make BackgroundStreamManager globally available
window.BackgroundStreamManager = BackgroundStreamManager;

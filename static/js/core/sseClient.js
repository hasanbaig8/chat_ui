/**
 * SSEClient - Server-Sent Events handler with stream token support
 *
 * Handles SSE streams with race condition protection via stream tokens.
 * When a stream token becomes stale (e.g., user switched conversations),
 * the stream is cancelled and no more updates are processed.
 */

const SSEClient = {
    // Current stream token - incremented each time a new stream starts
    streamToken: 0,

    /**
     * Process an SSE response stream
     *
     * @param {Response} response - Fetch response with SSE body
     * @param {object} handlers - Event handlers
     * @param {function} handlers.onEvent - Called for each SSE event
     * @param {function} handlers.onDone - Called when stream completes
     * @param {function} handlers.onError - Called on error
     * @param {number} streamToken - Token to check for staleness
     * @param {string} conversationId - ID to verify we're still on same conversation
     * @returns {Promise<void>}
     */
    async processStream(response, handlers, streamToken, conversationId) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        try {
            while (true) {
                const { done, value } = await reader.read();

                // Check if stream was superseded by conversation switch
                if (this.streamToken !== streamToken) {
                    console.log('[SSEClient] Stream superseded, cancelling');
                    await reader.cancel();
                    return;
                }

                // Check if conversation changed
                if (Store && Store.get('currentConversationId') !== conversationId) {
                    console.log('[SSEClient] Conversation changed, cancelling stream');
                    await reader.cancel();
                    return;
                }

                if (done) {
                    // Process any remaining buffer
                    if (buffer.trim()) {
                        this._processBuffer(buffer, handlers, streamToken, conversationId);
                    }
                    if (handlers.onDone) {
                        handlers.onDone();
                    }
                    return;
                }

                buffer += decoder.decode(value, { stream: true });

                // Process complete events from buffer
                buffer = this._processBuffer(buffer, handlers, streamToken, conversationId);
            }
        } catch (error) {
            // Don't report errors for superseded streams
            if (this.streamToken !== streamToken) {
                return;
            }
            if (handlers.onError) {
                handlers.onError(error);
            }
        }
    },

    /**
     * Process SSE events from buffer
     * @private
     */
    _processBuffer(buffer, handlers, streamToken, conversationId) {
        const lines = buffer.split('\n');
        let incomplete = '';

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // Last line might be incomplete
            if (i === lines.length - 1 && !line.endsWith('\n') && line !== '') {
                incomplete = line;
                continue;
            }

            // Skip empty lines
            if (!line.trim()) continue;

            // Parse SSE data
            if (line.startsWith('data: ')) {
                const data = line.slice(6);
                try {
                    const event = JSON.parse(data);

                    // Check staleness before handling each event
                    if (this.streamToken !== streamToken) {
                        return '';
                    }
                    if (Store && Store.get('currentConversationId') !== conversationId) {
                        return '';
                    }

                    if (handlers.onEvent) {
                        handlers.onEvent(event);
                    }
                } catch (e) {
                    console.warn('[SSEClient] Failed to parse event:', data, e);
                }
            }
        }

        return incomplete;
    },

    /**
     * Start a new stream and get a token
     * @returns {number} Stream token for this stream
     */
    startStream() {
        this.streamToken++;
        return this.streamToken;
    },

    /**
     * Check if a stream token is still current
     * @param {number} token - Token to check
     * @returns {boolean} True if token is current
     */
    isStreamCurrent(token) {
        return this.streamToken === token;
    },

    /**
     * Invalidate all streams (call when switching conversations)
     */
    invalidateStreams() {
        this.streamToken++;
    }
};

// Make SSEClient globally available
window.SSEClient = SSEClient;

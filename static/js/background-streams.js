/**
 * Streaming State Tracker
 * Simple tracking of which conversations are streaming (based on server state)
 */

const StreamingTracker = {
    // Set of conversation IDs that are streaming
    streamingConversations: new Set(),

    /**
     * Mark a conversation as streaming
     */
    setStreaming(conversationId, isStreaming) {
        if (isStreaming) {
            this.streamingConversations.add(conversationId);
        } else {
            this.streamingConversations.delete(conversationId);
        }
        this.updateStreamingIndicators();
    },

    /**
     * Check if a conversation is streaming
     */
    isStreaming(conversationId) {
        return this.streamingConversations.has(conversationId);
    },

    /**
     * Check streaming status from server
     */
    async checkServerStatus(conversationId) {
        try {
            const response = await fetch(`/api/chat/streaming/${conversationId}`);
            const data = await response.json();
            console.log('[StreamingTracker] Server status for', conversationId, ':', data);
            this.setStreaming(conversationId, data.streaming);
            return Boolean(data.streaming);
        } catch (e) {
            console.error('[StreamingTracker] Error checking status:', e);
            return false;
        }
    },

    /**
     * Update visual indicators in conversation list
     */
    updateStreamingIndicators() {
        const items = document.querySelectorAll('.conversation-item');
        items.forEach(item => {
            const id = item.dataset.id;
            const existingIndicator = item.querySelector('.streaming-dot');

            if (this.isStreaming(id)) {
                if (!existingIndicator) {
                    const dot = document.createElement('span');
                    dot.className = 'streaming-dot';
                    dot.title = 'Generating response...';
                    const titleEl = item.querySelector('.conversation-title');
                    if (titleEl) {
                        titleEl.prepend(dot);
                    }
                }
            } else {
                if (existingIndicator) {
                    existingIndicator.remove();
                }
            }
        });
    }
};

// Alias for backward compatibility
const BackgroundStreams = StreamingTracker;

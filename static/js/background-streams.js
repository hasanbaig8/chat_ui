/**
 * Streaming State Tracker
 * Unified tracking of streaming state for both normal and agent conversations.
 * Uses the unified /api/chat/streaming/{id} endpoint.
 */

const StreamingTracker = {
    // Map of conversation IDs to their streaming state
    // { streaming: bool, type: 'normal'|'agent', stoppable: bool }
    streamingStates: new Map(),

    /**
     * Mark a conversation as streaming with type info
     */
    setStreaming(conversationId, status) {
        const wasStreaming = this.streamingStates.has(conversationId);
        const wasAgent = wasStreaming && this.streamingStates.get(conversationId).type === 'agent';

        if (status && status.streaming) {
            this.streamingStates.set(conversationId, {
                streaming: true,
                type: status.type || 'normal',
                stoppable: status.stoppable || false
            });
        } else {
            this.streamingStates.delete(conversationId);

            // Notify TaskManager when an agent stream ends
            if (wasAgent && typeof TaskManager !== 'undefined') {
                TaskManager.completeTaskByConversation(conversationId, 'completed');
            }
        }
        this.updateStreamingIndicators();
    },

    /**
     * Check if a conversation is streaming
     */
    isStreaming(conversationId) {
        const state = this.streamingStates.get(conversationId);
        return state ? state.streaming : false;
    },

    /**
     * Get full status for a conversation
     */
    getStatus(conversationId) {
        return this.streamingStates.get(conversationId) || {
            streaming: false,
            type: null,
            stoppable: false
        };
    },

    /**
     * Check if a conversation's stream is stoppable (agent streams only)
     */
    isStoppable(conversationId) {
        const state = this.streamingStates.get(conversationId);
        return state ? state.stoppable : false;
    },

    /**
     * Check streaming status from server (unified endpoint)
     */
    async checkServerStatus(conversationId) {
        try {
            // Use unified endpoint that works for both normal and agent streams
            const response = await fetch(`/api/chat/streaming/${conversationId}`);
            const data = await response.json();
            console.log('[StreamingTracker] Server status for', conversationId, ':', data);
            this.setStreaming(conversationId, data);
            return data;
        } catch (e) {
            console.error('[StreamingTracker] Error checking status:', e);
            return { streaming: false, type: null, stoppable: false };
        }
    },

    /**
     * Stop an agent stream
     */
    async stopStream(conversationId) {
        if (!this.isStoppable(conversationId)) {
            console.warn('[StreamingTracker] Stream is not stoppable:', conversationId);
            return false;
        }
        try {
            const response = await fetch(`/api/agent-chat/stop/${conversationId}`, {
                method: 'POST'
            });
            const data = await response.json();
            return data.success;
        } catch (e) {
            console.error('[StreamingTracker] Error stopping stream:', e);
            return false;
        }
    },

    /**
     * Refresh all streaming states from server
     * Used on init to sync local state with server for background streams
     */
    async refreshAllStreamingStates() {
        try {
            const response = await fetch('/api/chat/streaming/all');
            const data = await response.json();

            // Update local state for each active stream
            for (const [convId, status] of Object.entries(data)) {
                this.setStreaming(convId, status);
            }

            // Clear local states not streaming on server
            for (const convId of this.streamingStates.keys()) {
                if (!data[convId]) {
                    this.streamingStates.delete(convId);
                }
            }

            this.updateStreamingIndicators();
        } catch (e) {
            console.error('[StreamingTracker] Error refreshing all states:', e);
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
            const status = this.getStatus(id);

            if (status.streaming) {
                if (!existingIndicator) {
                    const dot = document.createElement('span');
                    dot.className = 'streaming-dot';
                    // Different tooltip based on type
                    dot.title = status.type === 'agent'
                        ? 'Agent working... (can be stopped)'
                        : 'Generating response...';
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

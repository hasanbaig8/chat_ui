/**
 * ApiClient - Centralized API communication
 *
 * All fetch calls to the backend should go through this client.
 * Provides consistent error handling and response processing.
 */

const ApiClient = {
    // =========================================================================
    // Core HTTP methods
    // =========================================================================

    /**
     * Make a JSON request
     * @param {string} url - API endpoint
     * @param {object} options - Fetch options
     * @returns {Promise<any>} Parsed JSON response
     */
    async json(url, options = {}) {
        const response = await fetch(url, {
            headers: {
                'Content-Type': 'application/json',
                ...options.headers
            },
            ...options
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({ detail: response.statusText }));
            throw new Error(error.detail || `HTTP ${response.status}`);
        }

        return response.json();
    },

    /**
     * Make a GET request
     */
    async get(url) {
        return this.json(url);
    },

    /**
     * Make a POST request with JSON body
     */
    async post(url, data) {
        return this.json(url, {
            method: 'POST',
            body: JSON.stringify(data)
        });
    },

    /**
     * Make a PUT request with JSON body
     */
    async put(url, data) {
        return this.json(url, {
            method: 'PUT',
            body: JSON.stringify(data)
        });
    },

    /**
     * Make a DELETE request
     */
    async delete(url, data = null) {
        const options = { method: 'DELETE' };
        if (data) {
            options.body = JSON.stringify(data);
        }
        return this.json(url, options);
    },

    // =========================================================================
    // Conversations
    // =========================================================================

    async listConversations() {
        const data = await this.get('/api/conversations');
        return data.conversations;
    },

    async getConversation(id, branch = null) {
        let url = `/api/conversations/${id}`;
        if (branch) {
            url += `?branch=${branch.join(',')}`;
        }
        return this.get(url);
    },

    async createConversation(title, model = null, systemPrompt = null, isAgent = false, settings = null) {
        return this.post('/api/conversations', {
            title,
            model,
            system_prompt: systemPrompt,
            is_agent: isAgent,
            settings
        });
    },

    async updateConversation(id, updates) {
        return this.put(`/api/conversations/${id}`, updates);
    },

    async deleteConversation(id) {
        return this.delete(`/api/conversations/${id}`);
    },

    async duplicateConversation(id) {
        return this.post(`/api/conversations/${id}/duplicate`);
    },

    async searchConversations(query) {
        const data = await this.get(`/api/conversations/search?q=${encodeURIComponent(query)}`);
        return data.conversations;
    },

    // =========================================================================
    // Messages
    // =========================================================================

    async addMessage(conversationId, role, content, branch = null, thinking = null) {
        return this.post(`/api/conversations/${conversationId}/messages`, {
            role,
            content,
            thinking,
            branch
        });
    },

    async getMessages(conversationId, branch = null) {
        let url = `/api/conversations/${conversationId}/messages`;
        if (branch) {
            url += `?branch=${branch.join(',')}`;
        }
        const data = await this.get(url);
        return data.messages;
    },

    async getMessagesUpTo(conversationId, position, branch = null) {
        let url = `/api/conversations/${conversationId}/messages-up-to/${position}`;
        if (branch) {
            url += `?branch=${branch.join(',')}`;
        }
        const data = await this.get(url);
        return data.messages;
    },

    async deleteMessagesFrom(conversationId, position, branch = null) {
        return this.delete(`/api/conversations/${conversationId}/delete-from/${position}`, {
            branch
        });
    },

    // =========================================================================
    // Branching
    // =========================================================================

    async editMessage(conversationId, userMsgIndex, content, branch = null) {
        return this.post(`/api/conversations/${conversationId}/edit`, {
            user_msg_index: userMsgIndex,
            content,
            branch
        });
    },

    async switchBranch(conversationId, userMsgIndex, direction, branch = null) {
        return this.post(`/api/conversations/${conversationId}/switch-branch`, {
            user_msg_index: userMsgIndex,
            direction,
            branch
        });
    },

    async setBranch(conversationId, branch) {
        return this.post(`/api/conversations/${conversationId}/set-branch`, {
            branch
        });
    },

    async getVersionInfo(conversationId, userMsgIndex, branch = null) {
        let url = `/api/conversations/${conversationId}/version-info/${userMsgIndex}`;
        if (branch) {
            url += `?branch=${branch.join(',')}`;
        }
        return this.get(url);
    },

    async retryMessage(conversationId, position, content, branch = null, thinking = null) {
        return this.post(`/api/conversations/${conversationId}/retry`, {
            position,
            content,
            thinking,
            branch
        });
    },

    // =========================================================================
    // Streaming
    // =========================================================================

    /**
     * Get streaming status for a conversation (unified endpoint)
     */
    async getStreamingStatus(conversationId) {
        return this.get(`/api/chat/streaming/${conversationId}`);
    },

    /**
     * Start a normal chat stream
     * @param {object} data - Request data
     * @param {AbortSignal} signal - Optional abort signal
     * @returns {Response} Raw fetch response for SSE processing
     */
    streamChat(data, signal = null) {
        return fetch('/api/chat/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
            signal
        });
    },

    /**
     * Start an agent chat stream
     * @param {object} data - Request data
     * @param {AbortSignal} signal - Optional abort signal
     * @returns {Response} Raw fetch response for SSE processing
     */
    streamAgentChat(data, signal = null) {
        return fetch('/api/agent-chat/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
            signal
        });
    },

    /**
     * Stop an agent stream
     */
    async stopAgentStream(conversationId) {
        return this.post(`/api/agent-chat/stop/${conversationId}`);
    },

    /**
     * Send steering guidance to an in-progress agent stream
     * @param {string} conversationId - Conversation ID
     * @param {string} guidance - User's guidance text
     * @param {Array} accumulatedContent - Partial response content accumulated so far
     */
    async steerAgent(conversationId, guidance, accumulatedContent) {
        return this.post(`/api/agent-chat/steer/${conversationId}`, {
            guidance,
            accumulated_content: accumulatedContent
        });
    },

    /**
     * Pre-warm an agent session for faster startup
     * Fire-and-forget - don't await this in UI code
     * @param {string} conversationId - Conversation ID
     */
    warmAgentSession(conversationId) {
        // Fire and forget - don't await
        this.post(`/api/agent-chat/warm/${conversationId}`).catch((e) => {
            console.log('[ApiClient] Warm session failed (non-critical):', e.message);
        });
    },

    // =========================================================================
    // Models & Settings
    // =========================================================================

    async getModels() {
        const data = await this.get('/api/chat/models');
        return data.models;
    },

    async getDefaultSettings() {
        return this.get('/api/settings/defaults');
    },

    async updateDefaultSettings(settings) {
        return this.put('/api/settings/defaults', settings);
    },

    async getProjectSettings(projectId) {
        const data = await this.get(`/api/settings/project/${projectId}`);
        return data.settings;
    },

    async updateProjectSettings(projectId, settings) {
        return this.put(`/api/settings/project/${projectId}`, settings);
    },

    // =========================================================================
    // Projects
    // =========================================================================

    async listProjects() {
        const data = await this.get('/api/projects');
        return data.projects;
    },

    async getProject(id) {
        return this.get(`/api/projects/${id}`);
    },

    async createProject(name, color = '#C15F3C', settings = null) {
        return this.post('/api/projects', { name, color, settings });
    },

    async updateProject(id, updates) {
        return this.put(`/api/projects/${id}`, updates);
    },

    async deleteProject(id) {
        return this.delete(`/api/projects/${id}`);
    },

    async addConversationToProject(projectId, conversationId) {
        return this.post(`/api/projects/${projectId}/conversations`, {
            conversation_id: conversationId
        });
    },

    async removeConversationFromProject(projectId, conversationId) {
        return this.delete(`/api/projects/${projectId}/conversations/${conversationId}`);
    },

    async getConversationProjectMap() {
        const data = await this.get('/api/projects/conversation-map');
        return data.map;
    },

    // =========================================================================
    // Agent features
    // =========================================================================

    async getAgentStatus() {
        return this.get('/api/agent-chat/status');
    },

    async getWorkspaceFiles(conversationId) {
        const data = await this.get(`/api/agent-chat/workspace/${conversationId}`);
        return data.files;
    },

    async getSurfaceContent(conversationId, filename) {
        const data = await this.get(`/api/agent-chat/surface-content/${conversationId}/${filename}`);
        return data.content;
    },

    async getMemoryFiles(conversationId) {
        return this.get(`/api/agent-chat/memory/${conversationId}`);
    },

    // =========================================================================
    // Files
    // =========================================================================

    async processFile(file) {
        const formData = new FormData();
        formData.append('file', file);

        const response = await fetch('/api/files/process', {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({ detail: response.statusText }));
            throw new Error(error.detail || `HTTP ${response.status}`);
        }

        return response.json();
    }
};

// Make ApiClient globally available
window.ApiClient = ApiClient;

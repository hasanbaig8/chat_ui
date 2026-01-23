/**
 * Workspace files manager for agent conversations
 */

const WorkspaceManager = {
    isOpen: false,
    currentConversationId: null,
    files: [],

    /**
     * Initialize workspace manager
     */
    init() {
        this.bindEvents();
    },

    /**
     * Bind DOM events
     */
    bindEvents() {
        // Workspace toggle button
        const toggleBtn = document.getElementById('workspace-files-toggle');
        if (toggleBtn) {
            toggleBtn.addEventListener('click', () => {
                this.togglePanel();
            });
        }

        // Close button
        const closeBtn = document.getElementById('close-workspace');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                this.togglePanel();
            });
        }
    },

    /**
     * Toggle workspace panel
     */
    togglePanel() {
        this.isOpen = !this.isOpen;
        const panel = document.getElementById('workspace-panel');
        panel.classList.toggle('open', this.isOpen);

        if (this.isOpen && this.currentConversationId) {
            this.loadFiles(this.currentConversationId);
        }
    },

    /**
     * Show/hide workspace button based on conversation type
     */
    updateVisibility(isAgentConversation) {
        const toggleBtn = document.getElementById('workspace-files-toggle');
        if (toggleBtn) {
            toggleBtn.style.display = isAgentConversation ? '' : 'none';
        }

        // Close panel if switching to non-agent conversation
        if (!isAgentConversation && this.isOpen) {
            this.togglePanel();
        }
    },

    /**
     * Set current conversation
     */
    setConversation(conversationId) {
        this.currentConversationId = conversationId;
        if (this.isOpen) {
            this.loadFiles(conversationId);
        }
    },

    /**
     * Load files from workspace
     */
    async loadFiles(conversationId) {
        try {
            const response = await fetch(`/api/agent-chat/workspace/${conversationId}`);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();
            this.files = data.files || [];
            this.renderFiles(data.workspace_path);
        } catch (error) {
            console.error('Failed to load workspace files:', error);
            this.renderError();
        }
    },

    /**
     * Render files list
     */
    renderFiles(workspacePath) {
        const pathEl = document.getElementById('workspace-path');
        const listEl = document.getElementById('workspace-files-list');

        pathEl.textContent = workspacePath || '';

        if (this.files.length === 0) {
            listEl.innerHTML = '<div class="workspace-empty">No files in workspace yet</div>';
            return;
        }

        listEl.innerHTML = '';
        this.files.forEach(file => {
            const item = this.createFileItem(file);
            listEl.appendChild(item);
        });
    },

    /**
     * Create file item element
     */
    createFileItem(file) {
        const item = document.createElement('div');
        item.className = 'workspace-file-item';

        const icon = file.is_dir ? '📁' : '📄';
        const size = file.size ? this.formatFileSize(file.size) : '';

        item.innerHTML = `
            <div class="workspace-file-info">
                <span class="workspace-file-icon">${icon}</span>
                <span class="workspace-file-name" title="${this.escapeHtml(file.name)}">${this.escapeHtml(file.name)}</span>
                ${size ? `<span class="workspace-file-size">${size}</span>` : ''}
            </div>
            <div class="workspace-file-actions">
                <button class="workspace-file-action-btn tag" title="Tag in message">@</button>
                <button class="workspace-file-action-btn delete" title="Delete">🗑️</button>
            </div>
        `;

        // Tag button - insert @filename into message input
        const tagBtn = item.querySelector('.tag');
        tagBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.tagFile(file.name);
        });

        // Delete button
        const deleteBtn = item.querySelector('.delete');
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.deleteFile(file.name);
        });

        return item;
    },

    /**
     * Tag file in message input
     */
    tagFile(filename) {
        const input = document.getElementById('message-input');
        const currentValue = input.value;
        const cursorPos = input.selectionStart;

        // Insert @filename at cursor position
        const before = currentValue.substring(0, cursorPos);
        const after = currentValue.substring(cursorPos);
        input.value = before + '@' + filename + ' ' + after;

        // Move cursor after the tag
        const newPos = cursorPos + filename.length + 2;
        input.setSelectionRange(newPos, newPos);
        input.focus();

        // Trigger input event to update UI
        input.dispatchEvent(new Event('input'));
    },

    /**
     * Delete file from workspace
     */
    async deleteFile(filename) {
        if (!confirm(`Delete "${filename}" from workspace?`)) {
            return;
        }

        try {
            const response = await fetch(`/api/agent-chat/workspace/${this.currentConversationId}/${encodeURIComponent(filename)}`, {
                method: 'DELETE'
            });

            if (!response.ok) {
                throw new Error('Failed to delete file');
            }

            // Reload files list
            await this.loadFiles(this.currentConversationId);

            console.log(`Deleted file: ${filename}`);
        } catch (error) {
            console.error('Failed to delete file:', error);
            alert('Failed to delete file');
        }
    },

    /**
     * Render error state
     */
    renderError() {
        const listEl = document.getElementById('workspace-files-list');
        listEl.innerHTML = '<div class="workspace-empty">Failed to load workspace files</div>';
    },

    /**
     * Format file size
     */
    formatFileSize(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return Math.round(bytes / Math.pow(k, i) * 10) / 10 + ' ' + sizes[i];
    },

    /**
     * Escape HTML
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
};

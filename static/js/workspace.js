/**
 * Workspace files manager for agent conversations
 */

const WorkspaceManager = {
    isOpen: false,
    currentConversationId: null,
    files: [],
    memoryFiles: [],
    memoryInfo: null,

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

        // Drag and drop events
        const panel = document.getElementById('workspace-panel');
        if (panel) {
            panel.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (this.isOpen && this.currentConversationId) {
                    panel.classList.add('drag-over');
                }
            });

            panel.addEventListener('dragleave', (e) => {
                e.preventDefault();
                e.stopPropagation();
                // Only remove if leaving the panel itself, not a child
                if (e.target === panel) {
                    panel.classList.remove('drag-over');
                }
            });

            panel.addEventListener('drop', (e) => {
                e.preventDefault();
                e.stopPropagation();
                panel.classList.remove('drag-over');

                if (this.isOpen && this.currentConversationId) {
                    this.handleFileDrop(e);
                }
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
     * Load files from workspace and memory
     */
    async loadFiles(conversationId) {
        try {
            // Load workspace files
            const workspaceResponse = await fetch(`/api/agent-chat/workspace/${conversationId}`);
            if (!workspaceResponse.ok) {
                throw new Error(`HTTP error! status: ${workspaceResponse.status}`);
            }

            const workspaceData = await workspaceResponse.json();
            this.files = workspaceData.files || [];

            // Load memory files
            try {
                const memoryResponse = await fetch(`/api/agent-chat/memory/${conversationId}`);
                if (memoryResponse.ok) {
                    const memoryData = await memoryResponse.json();
                    this.memoryFiles = memoryData.files || [];
                    this.memoryInfo = {
                        isProjectMemory: memoryData.is_project_memory,
                        projectId: memoryData.project_id
                    };
                } else {
                    this.memoryFiles = [];
                    this.memoryInfo = null;
                }
            } catch (e) {
                console.debug('Memory endpoint not available:', e);
                this.memoryFiles = [];
                this.memoryInfo = null;
            }

            this.renderFiles(workspaceData.workspace_path);
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

        listEl.innerHTML = '';

        // Render memory section if there are memory files or memory is enabled
        if (this.memoryInfo) {
            const memorySection = document.createElement('div');
            memorySection.className = 'workspace-section memory-section';

            const memoryHeader = document.createElement('div');
            memoryHeader.className = 'workspace-section-header';
            const memoryLabel = this.memoryInfo.isProjectMemory
                ? '🧠 Shared Project Memory'
                : '🧠 Conversation Memory';
            memoryHeader.innerHTML = `<span>${memoryLabel}</span>`;
            memorySection.appendChild(memoryHeader);

            if (this.memoryFiles.length === 0) {
                const emptyMsg = document.createElement('div');
                emptyMsg.className = 'workspace-empty small';
                emptyMsg.textContent = 'No memories yet';
                memorySection.appendChild(emptyMsg);
            } else {
                this.memoryFiles.forEach(file => {
                    const item = this.createMemoryFileItem(file);
                    memorySection.appendChild(item);
                });
            }

            listEl.appendChild(memorySection);
        }

        // Render workspace files section
        const filesSection = document.createElement('div');
        filesSection.className = 'workspace-section files-section';

        const filesHeader = document.createElement('div');
        filesHeader.className = 'workspace-section-header';
        filesHeader.innerHTML = '<span>📁 Workspace Files</span>';
        filesSection.appendChild(filesHeader);

        if (this.files.length === 0) {
            const emptyMsg = document.createElement('div');
            emptyMsg.className = 'workspace-empty small';
            emptyMsg.innerHTML = 'No files yet<br><span style="font-size: 11px; opacity: 0.7;">Drag and drop to upload</span>';
            filesSection.appendChild(emptyMsg);
        } else {
            this.files.forEach(file => {
                const item = this.createFileItem(file);
                filesSection.appendChild(item);
            });
        }

        listEl.appendChild(filesSection);
    },

    /**
     * Create memory file item element
     */
    createMemoryFileItem(file) {
        const item = document.createElement('div');
        item.className = 'workspace-file-item memory-file';

        const icon = file.is_dir ? '📁' : '📝';
        const size = file.size ? this.formatFileSize(file.size) : '';

        item.innerHTML = `
            <div class="workspace-file-info">
                <span class="workspace-file-icon">${icon}</span>
                <span class="workspace-file-name" title="${this.escapeHtml(file.name)}">${this.escapeHtml(file.name)}</span>
                ${size ? `<span class="workspace-file-size">${size}</span>` : ''}
            </div>
            <div class="workspace-file-actions">
                <button class="workspace-file-action-btn view" title="View">👁️</button>
            </div>
        `;

        // View button
        const viewBtn = item.querySelector('.view');
        viewBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.viewMemoryFile(file.name);
        });

        return item;
    },

    /**
     * View a memory file
     */
    async viewMemoryFile(filename) {
        try {
            const response = await fetch(`/api/agent-chat/memory/${this.currentConversationId}/${encodeURIComponent(filename)}`);
            if (!response.ok) {
                throw new Error('Failed to load memory file');
            }

            const data = await response.json();
            alert(`Memory: ${filename}\n\n${data.content}`);
        } catch (error) {
            console.error('Failed to view memory file:', error);
            alert('Failed to load memory file');
        }
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
     * Handle file drop event
     */
    async handleFileDrop(event) {
        const files = Array.from(event.dataTransfer.files);

        if (files.length === 0) {
            return;
        }

        console.log(`Uploading ${files.length} file(s) to workspace`);

        // Upload each file
        for (const file of files) {
            try {
                await this.uploadFile(file);
            } catch (error) {
                console.error(`Failed to upload ${file.name}:`, error);
                alert(`Failed to upload ${file.name}: ${error.message}`);
            }
        }

        // Reload files list
        await this.loadFiles(this.currentConversationId);
    },

    /**
     * Upload a file to workspace
     */
    async uploadFile(file) {
        const formData = new FormData();
        formData.append('file', file);

        const response = await fetch(`/api/agent-chat/workspace/${this.currentConversationId}/upload`, {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'Upload failed');
        }

        const result = await response.json();
        console.log(`Uploaded ${file.name}: ${result.message}`);
        return result;
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

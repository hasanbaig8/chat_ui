/**
 * File handling module with server file browser
 */

const FilesManager = {
    pendingFiles: [],
    selectedServerFiles: new Set(),
    currentPath: null,

    /**
     * Initialize file handling
     */
    init() {
        this.bindEvents();
    },

    /**
     * Bind DOM events
     */
    bindEvents() {
        // Server file browser button
        document.getElementById('server-file-btn').addEventListener('click', () => {
            this.openFileBrowser();
        });

        // Close file browser
        document.getElementById('close-file-browser').addEventListener('click', () => {
            this.closeFileBrowser();
        });

        // Click outside to close
        document.getElementById('file-browser-modal').addEventListener('click', (e) => {
            if (e.target.id === 'file-browser-modal') {
                this.closeFileBrowser();
            }
        });

        // Add selected files button
        document.getElementById('add-selected-files').addEventListener('click', () => {
            this.addSelectedFiles();
        });

        // Paste from clipboard (for images)
        document.addEventListener('paste', (e) => {
            const items = e.clipboardData?.items;
            if (items) {
                for (const item of items) {
                    if (item.kind === 'file' && item.type.startsWith('image/')) {
                        const file = item.getAsFile();
                        if (file) this.handlePastedFile(file);
                    }
                }
            }
        });
    },

    /**
     * Open the server file browser
     */
    async openFileBrowser() {
        this.selectedServerFiles.clear();
        document.getElementById('file-browser-modal').classList.add('visible');
        await this.browsePath(null);
    },

    /**
     * Close the file browser
     */
    closeFileBrowser() {
        document.getElementById('file-browser-modal').classList.remove('visible');
        this.selectedServerFiles.clear();
    },

    /**
     * Browse a directory path
     */
    async browsePath(path) {
        try {
            const url = path ? `/api/files/browse?path=${encodeURIComponent(path)}` : '/api/files/browse';
            const response = await fetch(url);

            if (!response.ok) {
                const error = await response.json();
                alert(error.detail || 'Failed to browse directory');
                return;
            }

            const data = await response.json();
            this.currentPath = data.current_path;
            this.renderFileBrowser(data);
        } catch (error) {
            console.error('Browse error:', error);
            alert('Failed to browse directory');
        }
    },

    /**
     * Render the file browser
     */
    renderFileBrowser(data) {
        // Render path breadcrumb
        const pathEl = document.getElementById('file-browser-path');
        const parts = data.current_path.split('/').filter(Boolean);
        let pathHtml = '<span class="path-segment" data-path="/">~</span>';
        let cumPath = '';
        for (const part of parts) {
            cumPath += '/' + part;
            pathHtml += ` / <span class="path-segment" data-path="${cumPath}">${part}</span>`;
        }
        pathEl.innerHTML = pathHtml;

        // Add click handlers to path segments
        pathEl.querySelectorAll('.path-segment').forEach(seg => {
            seg.addEventListener('click', () => {
                const segPath = seg.dataset.path;
                this.browsePath(segPath === '/' ? null : segPath);
            });
        });

        // Render file list
        const listEl = document.getElementById('file-browser-list');
        listEl.innerHTML = '';

        // Parent directory
        if (data.parent_path) {
            const parentItem = document.createElement('div');
            parentItem.className = 'file-item';
            parentItem.innerHTML = `
                <span class="file-item-icon">📁</span>
                <div class="file-item-info">
                    <div class="file-item-name">..</div>
                </div>
            `;
            parentItem.addEventListener('click', () => {
                this.browsePath(data.parent_path);
            });
            listEl.appendChild(parentItem);
        }

        // Files and directories
        for (const item of data.items) {
            const itemEl = document.createElement('div');
            itemEl.className = 'file-item';
            if (this.selectedServerFiles.has(item.path)) {
                itemEl.classList.add('selected');
            }

            const icon = item.is_dir ? '📁' : this.getFileIcon(item.extension);
            const size = item.size ? this.formatSize(item.size) : '';

            if (item.is_dir) {
                itemEl.innerHTML = `
                    <span class="file-item-icon">${icon}</span>
                    <div class="file-item-info">
                        <div class="file-item-name">${this.escapeHtml(item.name)}</div>
                    </div>
                `;
                itemEl.addEventListener('click', () => {
                    this.browsePath(item.path);
                });
            } else {
                itemEl.innerHTML = `
                    <input type="checkbox" class="file-item-checkbox" ${this.selectedServerFiles.has(item.path) ? 'checked' : ''}>
                    <span class="file-item-icon">${icon}</span>
                    <div class="file-item-info">
                        <div class="file-item-name">${this.escapeHtml(item.name)}</div>
                        <div class="file-size">${size}</div>
                    </div>
                `;
                itemEl.addEventListener('click', (e) => {
                    if (e.target.type !== 'checkbox') {
                        const checkbox = itemEl.querySelector('.file-item-checkbox');
                        checkbox.checked = !checkbox.checked;
                    }
                    this.toggleFileSelection(item.path, itemEl);
                });
            }

            listEl.appendChild(itemEl);
        }

        this.updateSelectedCount();
    },

    /**
     * Toggle file selection
     */
    toggleFileSelection(path, itemEl) {
        if (this.selectedServerFiles.has(path)) {
            this.selectedServerFiles.delete(path);
            itemEl.classList.remove('selected');
        } else {
            this.selectedServerFiles.add(path);
            itemEl.classList.add('selected');
        }
        this.updateSelectedCount();
    },

    /**
     * Update selected files count
     */
    updateSelectedCount() {
        const count = this.selectedServerFiles.size;
        document.getElementById('selected-files-count').textContent = `${count} file${count !== 1 ? 's' : ''} selected`;
        document.getElementById('add-selected-files').disabled = count === 0;
    },

    /**
     * Add selected server files
     */
    async addSelectedFiles() {
        const paths = Array.from(this.selectedServerFiles);

        for (const path of paths) {
            try {
                const response = await fetch('/api/files/read-server-file', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path })
                });

                if (!response.ok) {
                    const error = await response.json();
                    console.error(`Failed to read ${path}:`, error.detail);
                    continue;
                }

                const result = await response.json();
                this.pendingFiles.push(result);
            } catch (error) {
                console.error(`Failed to read ${path}:`, error);
            }
        }

        this.closeFileBrowser();
        this.renderPreviews();
        this.updateSendButton();
    },

    /**
     * Handle pasted file (for clipboard images)
     */
    async handlePastedFile(file) {
        const formData = new FormData();
        formData.append('file', file);

        try {
            const response = await fetch('/api/files/upload', {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.detail || 'Upload failed');
            }

            const result = await response.json();
            this.pendingFiles.push(result);
            this.renderPreviews();
            this.updateSendButton();
        } catch (error) {
            console.error('Failed to upload pasted file:', error);
        }
    },

    /**
     * Render file previews
     */
    renderPreviews() {
        const container = document.getElementById('file-previews');
        container.innerHTML = '';

        this.pendingFiles.forEach((file, index) => {
            const preview = document.createElement('div');
            preview.className = 'file-preview';

            const { preview: previewData } = file;

            let thumbnailHtml = '';
            if (previewData.type === 'image' && previewData.thumbnail) {
                thumbnailHtml = `<img src="${previewData.thumbnail}" alt="${previewData.filename}">`;
            } else if (previewData.type === 'document') {
                thumbnailHtml = '<span class="file-preview-icon">📄</span>';
            } else {
                thumbnailHtml = '<span class="file-preview-icon">📝</span>';
            }

            preview.innerHTML = `
                ${thumbnailHtml}
                <div class="file-preview-info">
                    <span class="file-preview-name">${this.escapeHtml(previewData.filename)}</span>
                    <span class="file-preview-size">${previewData.size_display}</span>
                </div>
                <button class="file-preview-remove" data-index="${index}">&times;</button>
            `;

            preview.querySelector('.file-preview-remove').addEventListener('click', () => {
                this.removeFile(index);
            });

            container.appendChild(preview);
        });
    },

    /**
     * Remove a pending file
     */
    removeFile(index) {
        this.pendingFiles.splice(index, 1);
        this.renderPreviews();
        this.updateSendButton();
    },

    /**
     * Clear all pending files
     */
    clearPendingFiles() {
        this.pendingFiles = [];
        this.renderPreviews();
    },

    /**
     * Get content blocks for API request
     */
    getContentBlocks() {
        return this.pendingFiles.map(file => file.content_block);
    },

    /**
     * Check if there are pending files
     */
    hasPendingFiles() {
        return this.pendingFiles.length > 0;
    },

    /**
     * Update send button state
     */
    updateSendButton() {
        const messageInput = document.getElementById('message-input');
        const sendBtn = document.getElementById('send-btn');
        const hasContent = messageInput.value.trim() || this.hasPendingFiles();
        sendBtn.disabled = !hasContent;
    },

    /**
     * Get icon for file extension
     */
    getFileIcon(ext) {
        const icons = {
            '.pdf': '📄',
            '.doc': '📄', '.docx': '📄',
            '.txt': '📝', '.md': '📝',
            '.py': '🐍',
            '.js': '📜', '.ts': '📜',
            '.json': '📋',
            '.jpg': '🖼️', '.jpeg': '🖼️', '.png': '🖼️', '.gif': '🖼️', '.webp': '🖼️',
            '.html': '🌐', '.css': '🎨',
            '.csv': '📊', '.xlsx': '📊',
            '.zip': '📦', '.tar': '📦', '.gz': '📦'
        };
        return icons[ext] || '📄';
    },

    /**
     * Format file size
     */
    formatSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
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

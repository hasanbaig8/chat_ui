/**
 * Folder Browser Module - handles folder selection for CWD inputs
 */

const FolderBrowser = {
    isOpen: false,
    currentPath: null,
    targetInputId: null,

    /**
     * Initialize the folder browser
     */
    init() {
        this.bindEvents();
    },

    /**
     * Bind event handlers
     */
    bindEvents() {
        // Close button
        document.getElementById('close-folder-browser')?.addEventListener('click', () => {
            this.close();
        });

        // Cancel button
        document.getElementById('cancel-folder-browser')?.addEventListener('click', () => {
            this.close();
        });

        // Select folder button
        document.getElementById('select-folder')?.addEventListener('click', () => {
            this.selectCurrentFolder();
        });

        // Click outside to close
        document.getElementById('folder-browser-modal')?.addEventListener('click', (e) => {
            if (e.target.id === 'folder-browser-modal') {
                this.close();
            }
        });

        // Bind all folder browse buttons
        document.addEventListener('click', (e) => {
            const btn = e.target.closest('.folder-browse-btn');
            if (btn) {
                e.preventDefault();
                const targetId = btn.dataset.target;
                this.open(targetId);
            }
        });
    },

    /**
     * Open the folder browser
     */
    async open(targetInputId) {
        this.targetInputId = targetInputId;

        // Get current value from input as starting path
        const input = document.getElementById(targetInputId);
        let startPath = input?.value || null;

        // If no path, start from home or root
        if (!startPath) {
            startPath = null; // Will use server default
        }

        document.getElementById('folder-browser-modal').classList.add('visible');
        this.isOpen = true;

        await this.browsePath(startPath);
    },

    /**
     * Close the folder browser
     */
    close() {
        document.getElementById('folder-browser-modal').classList.remove('visible');
        this.isOpen = false;
        this.targetInputId = null;
        this.currentPath = null;
    },

    /**
     * Browse a directory path
     */
    async browsePath(path) {
        try {
            const url = path
                ? `/api/files/browse?path=${encodeURIComponent(path)}`
                : '/api/files/browse';

            const response = await fetch(url);
            if (!response.ok) {
                throw new Error('Failed to browse folder');
            }

            const data = await response.json();
            // API returns current_path, parent_path - normalize to path, parent
            this.currentPath = data.current_path || data.path;
            this.renderFolderList({
                path: data.current_path || data.path,
                parent: data.parent_path || data.parent,
                items: data.items || []
            });
        } catch (error) {
            console.error('Failed to browse folder:', error);
            // Try to go to root on error
            if (path !== '/') {
                await this.browsePath('/');
            }
        }
    },

    /**
     * Render the folder list
     */
    renderFolderList(data) {
        const pathEl = document.getElementById('folder-browser-path');
        const listEl = document.getElementById('folder-browser-list');

        // Update path display
        pathEl.textContent = data.path || '/';

        // Build folder list HTML
        let html = '';

        // Add parent directory link if not at root
        if (data.parent) {
            html += `
                <div class="folder-browser-item parent" data-path="${this.escapeHtml(data.parent)}">
                    <span class="folder-icon">&#128193;</span>
                    <span class="folder-name">..</span>
                </div>
            `;
        }

        // Add directories only (folders, not files)
        // API may return is_dir or is_directory depending on version
        const folders = (data.items || []).filter(item => item.is_dir || item.is_directory);

        for (const folder of folders) {
            html += `
                <div class="folder-browser-item" data-path="${this.escapeHtml(folder.path)}">
                    <span class="folder-icon">&#128193;</span>
                    <span class="folder-name">${this.escapeHtml(folder.name)}</span>
                </div>
            `;
        }

        if (folders.length === 0 && !data.parent) {
            html = '<div class="folder-browser-empty">No folders found</div>';
        }

        listEl.innerHTML = html;

        // Bind click handlers
        listEl.querySelectorAll('.folder-browser-item').forEach(item => {
            item.addEventListener('click', () => {
                const path = item.dataset.path;
                this.browsePath(path);
            });
        });
    },

    /**
     * Select the current folder
     */
    selectCurrentFolder() {
        if (this.targetInputId && this.currentPath) {
            const input = document.getElementById(this.targetInputId);
            if (input) {
                input.value = this.currentPath;
                // Trigger change event
                input.dispatchEvent(new Event('change', { bubbles: true }));
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }
        this.close();
    },

    /**
     * Escape HTML for safe display
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
};

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    FolderBrowser.init();
});

/**
 * Prompt Library Manager
 */
const PromptLibrary = {
    prompts: [],
    editingPromptId: null,

    /**
     * Initialize the prompt library
     */
    init() {
        this.loadPrompts();
        this.addDefaultPrompts();
        this.renderPromptList();
        this.bindEvents();
    },

    /**
     * Add default prompts if library is empty
     */
    addDefaultPrompts() {
        if (this.prompts.length === 0) {
            this.prompts = [
                {
                    id: this.generateId(),
                    name: 'Summarize Academic Paper',
                    content: 'Please provide a comprehensive summary of this academic paper. Include:\n\n1. Main research question and objectives\n2. Methodology used\n3. Key findings and results\n4. Conclusions and implications\n5. Limitations and future research directions\n\nPresent the summary in a clear, structured format suitable for quick understanding.'
                },
                {
                    id: this.generateId(),
                    name: 'Code Review',
                    content: 'Please review this code for:\n\n1. Code quality and readability\n2. Potential bugs or issues\n3. Performance considerations\n4. Security concerns\n5. Best practices and design patterns\n6. Suggestions for improvement\n\nProvide specific, actionable feedback with examples where appropriate.'
                },
                {
                    id: this.generateId(),
                    name: 'Explain Like I\'m 5',
                    content: 'Please explain this concept in simple terms that a 5-year-old could understand. Use analogies, simple language, and relatable examples. Avoid technical jargon.'
                }
            ];
            this.savePrompts();
            this.renderPromptList();
        }
    },

    /**
     * Bind DOM events
     */
    bindEvents() {
        // Add prompt button in settings
        const addBtn = document.getElementById('add-prompt-btn');
        if (addBtn) {
            addBtn.addEventListener('click', () => {
                this.showEditModal();
            });
        }

        // Prompts button near input
        const promptsBtn = document.getElementById('prompts-btn');
        if (promptsBtn) {
            promptsBtn.addEventListener('click', () => {
                this.showPromptLibraryModal();
            });
        }

        // Close modals
        const closeLibraryBtn = document.getElementById('close-prompt-library');
        if (closeLibraryBtn) {
            closeLibraryBtn.addEventListener('click', () => {
                this.closePromptLibraryModal();
            });
        }

        const closeEditBtn = document.getElementById('close-edit-prompt');
        if (closeEditBtn) {
            closeEditBtn.addEventListener('click', () => {
                this.closeEditModal();
            });
        }

        // Close on overlay click
        const libraryModal = document.getElementById('prompt-library-modal');
        if (libraryModal) {
            libraryModal.addEventListener('click', (e) => {
                if (e.target.id === 'prompt-library-modal') {
                    this.closePromptLibraryModal();
                }
            });
        }

        const editModal = document.getElementById('edit-prompt-modal');
        if (editModal) {
            editModal.addEventListener('click', (e) => {
                if (e.target.id === 'edit-prompt-modal') {
                    this.closeEditModal();
                }
            });
        }

        // Save/cancel buttons
        const saveBtn = document.getElementById('save-prompt');
        if (saveBtn) {
            saveBtn.addEventListener('click', () => {
                this.savePrompt();
            });
        }

        const cancelBtn = document.getElementById('cancel-edit-prompt');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => {
                this.closeEditModal();
            });
        }

        // ESC to close modals
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                if (document.getElementById('prompt-library-modal').classList.contains('visible')) {
                    this.closePromptLibraryModal();
                }
                if (document.getElementById('edit-prompt-modal').classList.contains('visible')) {
                    this.closeEditModal();
                }
            }
        });
    },

    /**
     * Generate unique ID
     */
    generateId() {
        return Date.now().toString(36) + Math.random().toString(36).substr(2);
    },

    /**
     * Load prompts from localStorage
     */
    loadPrompts() {
        const stored = localStorage.getItem('promptLibrary');
        if (stored) {
            try {
                this.prompts = JSON.parse(stored);
            } catch (error) {
                console.error('Failed to load prompts:', error);
                this.prompts = [];
            }
        }
    },

    /**
     * Save prompts to localStorage
     */
    savePrompts() {
        localStorage.setItem('promptLibrary', JSON.stringify(this.prompts));
    },

    /**
     * Render prompt list in settings panel
     */
    renderPromptList() {
        const container = document.getElementById('prompt-library-list');
        container.innerHTML = '';

        if (this.prompts.length === 0) {
            container.innerHTML = '<p style="color: var(--color-text-secondary); font-size: 13px; padding: 8px 0;">No prompts saved yet.</p>';
            return;
        }

        this.prompts.forEach(prompt => {
            const item = document.createElement('div');
            item.className = 'prompt-item';
            item.innerHTML = `
                <div class="prompt-item-header">
                    <span class="prompt-name">${this.escapeHtml(prompt.name)}</span>
                    <div class="prompt-actions">
                        <button class="prompt-action-btn insert-btn" title="Insert">↩</button>
                        <button class="prompt-action-btn edit-btn" title="Edit">✏️</button>
                        <button class="prompt-action-btn delete-btn" title="Delete">&times;</button>
                    </div>
                </div>
                <div class="prompt-preview">${this.escapeHtml(this.truncate(prompt.content, 100))}</div>
            `;

            // Insert button
            item.querySelector('.insert-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                this.insertPrompt(prompt.id);
            });

            // Edit button
            item.querySelector('.edit-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                this.showEditModal(prompt.id);
            });

            // Delete button
            item.querySelector('.delete-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                this.deletePrompt(prompt.id);
            });

            container.appendChild(item);
        });
    },

    /**
     * Render prompt list in modal
     */
    renderPromptLibraryModal() {
        const container = document.getElementById('prompt-library-modal-list');
        container.innerHTML = '';

        if (this.prompts.length === 0) {
            container.innerHTML = '<p style="color: var(--color-text-secondary); text-align: center; padding: 20px;">No prompts saved yet. Add prompts in Settings.</p>';
            return;
        }

        this.prompts.forEach(prompt => {
            const item = document.createElement('div');
            item.className = 'prompt-modal-item';
            item.innerHTML = `
                <div class="prompt-modal-header">
                    <span class="prompt-modal-name">${this.escapeHtml(prompt.name)}</span>
                </div>
                <div class="prompt-modal-content">${this.escapeHtml(prompt.content)}</div>
                <div class="prompt-modal-actions">
                    <button class="btn btn-small insert-modal-btn">Insert</button>
                </div>
            `;

            // Insert button
            item.querySelector('.insert-modal-btn').addEventListener('click', () => {
                this.insertPrompt(prompt.id);
                this.closePromptLibraryModal();
            });

            container.appendChild(item);
        });
    },

    /**
     * Show prompt library modal
     */
    showPromptLibraryModal() {
        this.renderPromptLibraryModal();
        document.getElementById('prompt-library-modal').classList.add('visible');
    },

    /**
     * Close prompt library modal
     */
    closePromptLibraryModal() {
        document.getElementById('prompt-library-modal').classList.remove('visible');
    },

    /**
     * Show edit/add prompt modal
     */
    showEditModal(promptId = null) {
        this.editingPromptId = promptId;

        const titleEl = document.getElementById('edit-prompt-title');
        const nameInput = document.getElementById('prompt-name');
        const contentInput = document.getElementById('prompt-content');

        if (promptId) {
            const prompt = this.prompts.find(p => p.id === promptId);
            if (prompt) {
                titleEl.textContent = 'Edit Prompt';
                nameInput.value = prompt.name;
                contentInput.value = prompt.content;
            }
        } else {
            titleEl.textContent = 'Add Prompt';
            nameInput.value = '';
            contentInput.value = '';
        }

        document.getElementById('edit-prompt-modal').classList.add('visible');
        nameInput.focus();
    },

    /**
     * Close edit modal
     */
    closeEditModal() {
        document.getElementById('edit-prompt-modal').classList.remove('visible');
        this.editingPromptId = null;
    },

    /**
     * Save prompt (add or update)
     */
    savePrompt() {
        const name = document.getElementById('prompt-name').value.trim();
        const content = document.getElementById('prompt-content').value.trim();

        if (!name || !content) {
            alert('Please enter both name and content');
            return;
        }

        if (this.editingPromptId) {
            // Update existing
            const prompt = this.prompts.find(p => p.id === this.editingPromptId);
            if (prompt) {
                prompt.name = name;
                prompt.content = content;
            }
        } else {
            // Add new
            this.prompts.push({
                id: this.generateId(),
                name,
                content
            });
        }

        this.savePrompts();
        this.renderPromptList();
        this.closeEditModal();
    },

    /**
     * Delete prompt
     */
    deletePrompt(promptId) {
        if (!confirm('Delete this prompt?')) {
            return;
        }

        this.prompts = this.prompts.filter(p => p.id !== promptId);
        this.savePrompts();
        this.renderPromptList();
    },

    /**
     * Insert prompt into message input
     */
    insertPrompt(promptId) {
        const prompt = this.prompts.find(p => p.id === promptId);
        if (!prompt) return;

        const input = document.getElementById('message-input');
        const currentValue = input.value.trim();

        if (currentValue) {
            input.value = currentValue + '\n\n' + prompt.content;
        } else {
            input.value = prompt.content;
        }

        // Trigger input event to update UI
        input.dispatchEvent(new Event('input'));
        input.focus();

        // Scroll to bottom of textarea
        input.scrollTop = input.scrollHeight;
    },

    /**
     * Truncate text
     */
    truncate(text, length) {
        if (text.length <= length) return text;
        return text.substring(0, length) + '...';
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

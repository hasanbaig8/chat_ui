/**
 * Projects management module for organizing conversations into folders
 */

const ProjectsManager = {
    projects: [],
    expandedProjects: new Set(),
    conversationProjectMap: {},  // conv_id -> project_id
    renamingProjectId: null,
    draggedConversationId: null,

    // Preset colors for projects
    presetColors: [
        '#C15F3C',  // rust/primary
        '#4A9B7F',  // green
        '#5B8DEF',  // blue
        '#9B59B6',  // purple
        '#E67E22',  // orange
        '#1ABC9C',  // teal
    ],

    /**
     * Initialize the projects manager
     */
    async init() {
        // Load expanded state from localStorage
        const savedExpanded = localStorage.getItem('expandedProjects');
        if (savedExpanded) {
            try {
                this.expandedProjects = new Set(JSON.parse(savedExpanded));
            } catch (e) {
                this.expandedProjects = new Set();
            }
        }

        await this.loadProjects();
        this.bindEvents();
    },

    /**
     * Bind DOM events
     */
    bindEvents() {
        // New project button
        const newProjectBtn = document.getElementById('new-project-btn');
        if (newProjectBtn) {
            newProjectBtn.addEventListener('click', () => this.promptCreateProject());
        }

        // Global click handler to close dropdown menus
        document.addEventListener('click', (e) => {
            // Don't close if clicking on a menu button (that's handled separately)
            if (e.target.closest('.project-menu-btn')) return;
            // Close all open dropdowns
            document.querySelectorAll('.project-menu-dropdown.open').forEach(m => {
                m.classList.remove('open');
            });
        });

        // Setup drop zone for removing conversations from projects
        const conversationsList = document.getElementById('conversations-list');
        if (conversationsList) {
            conversationsList.addEventListener('dragover', (e) => {
                if (this.draggedConversationId) {
                    e.preventDefault();
                    conversationsList.classList.add('drag-over');
                }
            });

            conversationsList.addEventListener('dragleave', (e) => {
                if (!conversationsList.contains(e.relatedTarget)) {
                    conversationsList.classList.remove('drag-over');
                }
            });

            conversationsList.addEventListener('drop', async (e) => {
                e.preventDefault();
                conversationsList.classList.remove('drag-over');

                if (this.draggedConversationId) {
                    const currentProjectId = this.conversationProjectMap[this.draggedConversationId];
                    if (currentProjectId) {
                        await this.removeConversationFromProject(currentProjectId, this.draggedConversationId);
                    }
                }
            });
        }
    },

    /**
     * Load all projects from server
     */
    async loadProjects() {
        try {
            const [projectsResponse, mapResponse] = await Promise.all([
                fetch('/api/projects'),
                fetch('/api/projects/conversation-map')
            ]);

            const projectsData = await projectsResponse.json();
            const mapData = await mapResponse.json();

            this.projects = projectsData.projects || [];
            this.conversationProjectMap = mapData.map || {};

            this.renderProjects();
        } catch (error) {
            console.error('Failed to load projects:', error);
        }
    },

    /**
     * Prompt user to create a new project
     */
    promptCreateProject() {
        const name = prompt('Enter project name:');
        if (name && name.trim()) {
            this.createProject(name.trim());
        }
    },

    /**
     * Create a new project with default settings
     */
    async createProject(name, color = '#C15F3C') {
        try {
            // Create the project first
            const response = await fetch('/api/projects', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, color })
            });

            const project = await response.json();

            // Initialize project settings from current defaults
            await fetch(`/api/settings/project/${project.id}/init`, {
                method: 'POST'
            });

            this.projects.unshift(project);
            this.expandedProjects.add(project.id);
            this.saveExpandedState();
            this.renderProjects();

            return project;
        } catch (error) {
            console.error('Failed to create project:', error);
            throw error;
        }
    },

    /**
     * Update a project
     */
    async updateProject(projectId, name = null, color = null) {
        try {
            const body = {};
            if (name !== null) body.name = name;
            if (color !== null) body.color = color;

            await fetch(`/api/projects/${projectId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });

            // Update local state
            const project = this.projects.find(p => p.id === projectId);
            if (project) {
                if (name !== null) project.name = name;
                if (color !== null) project.color = color;
                this.renderProjects();
            }
        } catch (error) {
            console.error('Failed to update project:', error);
        }
    },

    /**
     * Delete a project
     */
    async deleteProject(projectId) {
        if (!confirm('Delete this project? Conversations will be kept.')) {
            return;
        }

        try {
            await fetch(`/api/projects/${projectId}`, { method: 'DELETE' });

            // Remove from local state
            const project = this.projects.find(p => p.id === projectId);
            if (project) {
                // Clear conversation mappings
                project.conversation_ids.forEach(convId => {
                    delete this.conversationProjectMap[convId];
                });
            }

            this.projects = this.projects.filter(p => p.id !== projectId);
            this.expandedProjects.delete(projectId);
            this.saveExpandedState();
            this.renderProjects();

            // Re-render conversations list to show unorganized conversations
            if (typeof ConversationsManager !== 'undefined') {
                ConversationsManager.renderConversationsList();
            }
        } catch (error) {
            console.error('Failed to delete project:', error);
        }
    },

    /**
     * Add a conversation to a project
     */
    async addConversationToProject(projectId, conversationId) {
        try {
            await fetch(`/api/projects/${projectId}/conversations`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ conversation_id: conversationId })
            });

            // Update local state
            // Remove from previous project if any
            const prevProjectId = this.conversationProjectMap[conversationId];
            if (prevProjectId) {
                const prevProject = this.projects.find(p => p.id === prevProjectId);
                if (prevProject) {
                    prevProject.conversation_ids = prevProject.conversation_ids.filter(id => id !== conversationId);
                }
            }

            // Add to new project
            const project = this.projects.find(p => p.id === projectId);
            if (project && !project.conversation_ids.includes(conversationId)) {
                project.conversation_ids.unshift(conversationId);
            }
            this.conversationProjectMap[conversationId] = projectId;

            // Auto-expand the project
            this.expandedProjects.add(projectId);
            this.saveExpandedState();

            this.renderProjects();

            // Re-render conversations list
            if (typeof ConversationsManager !== 'undefined') {
                ConversationsManager.renderConversationsList();
            }
        } catch (error) {
            console.error('Failed to add conversation to project:', error);
        }
    },

    /**
     * Remove a conversation from a project
     */
    async removeConversationFromProject(projectId, conversationId) {
        try {
            await fetch(`/api/projects/${projectId}/conversations/${conversationId}`, {
                method: 'DELETE'
            });

            // Update local state
            const project = this.projects.find(p => p.id === projectId);
            if (project) {
                project.conversation_ids = project.conversation_ids.filter(id => id !== conversationId);
            }
            delete this.conversationProjectMap[conversationId];

            this.renderProjects();

            // Re-render conversations list
            if (typeof ConversationsManager !== 'undefined') {
                ConversationsManager.renderConversationsList();
            }
        } catch (error) {
            console.error('Failed to remove conversation from project:', error);
        }
    },

    /**
     * Toggle project expanded/collapsed state
     */
    toggleProject(projectId) {
        if (this.expandedProjects.has(projectId)) {
            this.expandedProjects.delete(projectId);
        } else {
            this.expandedProjects.add(projectId);
        }
        this.saveExpandedState();
        this.renderProjects();
    },

    /**
     * Save expanded state to localStorage
     */
    saveExpandedState() {
        localStorage.setItem('expandedProjects', JSON.stringify([...this.expandedProjects]));
    },

    /**
     * Check if a conversation is in any project
     */
    isConversationInProject(conversationId) {
        return conversationId in this.conversationProjectMap;
    },

    /**
     * Get conversations that are not in any project
     */
    getUnorganizedConversations(allConversations) {
        return allConversations.filter(conv => !this.isConversationInProject(conv.id));
    },

    /**
     * Render the projects section
     */
    renderProjects() {
        const container = document.getElementById('projects-section');
        if (!container) return;

        container.innerHTML = '';

        if (this.projects.length === 0) {
            return;  // Don't show anything if no projects
        }

        // Get all conversations for lookup
        const allConversations = typeof ConversationsManager !== 'undefined'
            ? ConversationsManager.conversations
            : [];
        const conversationsMap = {};
        allConversations.forEach(conv => {
            conversationsMap[conv.id] = conv;
        });

        this.projects.forEach(project => {
            const isExpanded = this.expandedProjects.has(project.id);

            // Filter out non-existent conversations
            const validConvIds = project.conversation_ids.filter(id => id in conversationsMap);

            const projectEl = document.createElement('div');
            projectEl.className = `project-item${isExpanded ? ' expanded' : ''}`;
            projectEl.dataset.projectId = project.id;

            // Check if any conversations are agent conversations (have memory)
            const hasAgentConversations = validConvIds.some(id => {
                const conv = conversationsMap[id];
                return conv && conv.is_agent;
            });

            // Project header
            const header = document.createElement('div');
            header.className = 'project-header';
            header.innerHTML = `
                <span class="project-expand-icon">${isExpanded ? '&#9660;' : '&#9654;'}</span>
                <span class="project-color-dot" style="background-color: ${project.color}"></span>
                <span class="project-name">${this.escapeHtml(project.name)}</span>
                ${hasAgentConversations ? '<span class="project-memory-icon" title="Shared memory for agent chats">&#129504;</span>' : ''}
                <span class="project-count">(${validConvIds.length})</span>
                <div class="project-actions">
                    <button class="project-new-chat-btn" title="New Chat">+</button>
                    <button class="project-new-agent-btn" title="New Agent Chat">+</button>
                    <div class="project-menu-container">
                        <button class="project-menu-btn" title="More options">&#8942;</button>
                        <div class="project-menu-dropdown">
                            <button class="project-menu-item project-settings-btn" title="Settings">&#9881;</button>
                            <button class="project-menu-item project-color-btn" title="Change color">&#127912;</button>
                            <button class="project-menu-item project-rename-btn" title="Rename">&#9998;</button>
                            <button class="project-menu-item project-delete-btn" title="Delete">&#128465;</button>
                        </div>
                    </div>
                </div>
            `;

            // Header click to toggle
            header.addEventListener('click', (e) => {
                if (!e.target.closest('.project-actions')) {
                    this.toggleProject(project.id);
                }
            });

            // Drag and drop handlers for header
            header.addEventListener('dragover', (e) => {
                if (this.draggedConversationId) {
                    e.preventDefault();
                    header.classList.add('drag-over');
                }
            });

            header.addEventListener('dragleave', () => {
                header.classList.remove('drag-over');
            });

            header.addEventListener('drop', async (e) => {
                e.preventDefault();
                header.classList.remove('drag-over');

                if (this.draggedConversationId) {
                    await this.addConversationToProject(project.id, this.draggedConversationId);
                }
            });

            // New Chat button (blue)
            header.querySelector('.project-new-chat-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                this.createConversationInProject(project.id, false);
            });

            // New Agent Chat button (orange)
            header.querySelector('.project-new-agent-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                this.createConversationInProject(project.id, true);
            });

            // Menu button
            const menuBtn = header.querySelector('.project-menu-btn');
            const menuDropdown = header.querySelector('.project-menu-dropdown');

            menuBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                // Close other open menus
                document.querySelectorAll('.project-menu-dropdown.open').forEach(m => {
                    if (m !== menuDropdown) m.classList.remove('open');
                });

                // Position the dropdown to the right of the button
                const rect = menuBtn.getBoundingClientRect();
                menuDropdown.style.top = `${rect.top + rect.height / 2}px`;
                menuDropdown.style.left = `${rect.right + 4}px`;
                menuDropdown.style.transform = 'translateY(-50%)';

                menuDropdown.classList.toggle('open');
            });

            // Action buttons in menu
            header.querySelector('.project-settings-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                menuDropdown.classList.remove('open');
                this.openProjectSettings(project.id);
            });

            header.querySelector('.project-color-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                menuDropdown.classList.remove('open');
                this.showColorPicker(project.id, menuBtn);
            });

            header.querySelector('.project-rename-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                menuDropdown.classList.remove('open');
                this.startRename(project.id, header.querySelector('.project-name'));
            });

            header.querySelector('.project-delete-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                menuDropdown.classList.remove('open');
                this.deleteProject(project.id);
            });

            projectEl.appendChild(header);

            // Project conversations (if expanded)
            if (isExpanded) {
                const convList = document.createElement('div');
                convList.className = 'project-conversations';

                if (validConvIds.length === 0) {
                    convList.innerHTML = '<div class="project-empty">Drag conversations here</div>';
                } else {
                    validConvIds.forEach(convId => {
                        const conv = conversationsMap[convId];
                        if (!conv) return;

                        const convItem = this.createConversationItem(conv, project.id);
                        convList.appendChild(convItem);
                    });
                }

                // Make the list a drop zone too
                convList.addEventListener('dragover', (e) => {
                    if (this.draggedConversationId) {
                        e.preventDefault();
                        convList.classList.add('drag-over');
                    }
                });

                convList.addEventListener('dragleave', (e) => {
                    if (!convList.contains(e.relatedTarget)) {
                        convList.classList.remove('drag-over');
                    }
                });

                convList.addEventListener('drop', async (e) => {
                    e.preventDefault();
                    convList.classList.remove('drag-over');

                    if (this.draggedConversationId) {
                        await this.addConversationToProject(project.id, this.draggedConversationId);
                    }
                });

                projectEl.appendChild(convList);
            }

            container.appendChild(projectEl);
        });
    },

    /**
     * Create a conversation item element
     */
    createConversationItem(conv, projectId) {
        const item = document.createElement('div');
        const isActive = typeof ConversationsManager !== 'undefined' &&
            conv.id === ConversationsManager.currentConversationId;

        item.className = `conversation-item project-conversation${isActive ? ' active' : ''}${conv.is_agent ? ' agent' : ''}`;
        item.dataset.id = conv.id;
        item.dataset.projectId = projectId;
        item.draggable = true;

        const agentIcon = conv.is_agent ? '<img src="/static/favicon.png" alt="Agent" class="agent-icon" title="Agent Chat">' : '';

        item.innerHTML = `
            ${agentIcon}
            <span class="conversation-title">${this.escapeHtml(conv.title)}</span>
            <div class="conversation-actions">
                <button class="conversation-settings" title="Settings">&#9881;</button>
                <button class="conversation-remove-from-project" title="Remove from project">&#10006;</button>
            </div>
        `;

        // Click to select conversation
        item.addEventListener('click', (e) => {
            if (!e.target.classList.contains('conversation-remove-from-project') &&
                !e.target.classList.contains('conversation-settings')) {
                if (typeof ConversationsManager !== 'undefined') {
                    ConversationsManager.selectConversation(conv.id);
                }
            }
        });

        // Settings button - open settings panel for this conversation
        item.querySelector('.conversation-settings').addEventListener('click', async (e) => {
            e.stopPropagation();
            // Select the conversation first
            if (typeof ConversationsManager !== 'undefined') {
                await ConversationsManager.selectConversation(conv.id);
            }
            // Open settings panel
            if (typeof SettingsManager !== 'undefined' && !SettingsManager.isOpen) {
                SettingsManager.togglePanel();
            }
        });

        // Remove from project button
        item.querySelector('.conversation-remove-from-project').addEventListener('click', (e) => {
            e.stopPropagation();
            this.removeConversationFromProject(projectId, conv.id);
        });

        // Drag handlers
        item.addEventListener('dragstart', (e) => {
            this.draggedConversationId = conv.id;
            item.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', conv.id);
        });

        item.addEventListener('dragend', () => {
            this.draggedConversationId = null;
            item.classList.remove('dragging');
            document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
        });

        return item;
    },

    /**
     * Start renaming a project
     */
    startRename(projectId, nameEl) {
        if (this.renamingProjectId !== null) return;

        const project = this.projects.find(p => p.id === projectId);
        if (!project) return;

        this.renamingProjectId = projectId;

        const input = document.createElement('input');
        input.type = 'text';
        input.value = project.name;
        input.className = 'project-rename-input';

        const originalHtml = nameEl.innerHTML;
        nameEl.innerHTML = '';
        nameEl.appendChild(input);

        input.focus();
        input.select();

        const save = async () => {
            const newName = input.value.trim();
            if (newName && newName !== project.name) {
                await this.updateProject(projectId, newName);
            }
            this.renamingProjectId = null;
            this.renderProjects();
        };

        const cancel = () => {
            this.renamingProjectId = null;
            nameEl.innerHTML = originalHtml;
        };

        input.addEventListener('blur', save);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                save();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                cancel();
            }
        });
        input.addEventListener('click', (e) => e.stopPropagation());
    },

    /**
     * Show color picker for a project
     */
    showColorPicker(projectId, button) {
        // Remove any existing picker
        const existingPicker = document.querySelector('.project-color-picker');
        if (existingPicker) {
            existingPicker.remove();
        }

        const picker = document.createElement('div');
        picker.className = 'project-color-picker';

        this.presetColors.forEach(color => {
            const colorBtn = document.createElement('button');
            colorBtn.className = 'color-option';
            colorBtn.style.backgroundColor = color;
            colorBtn.addEventListener('click', () => {
                this.updateProject(projectId, null, color);
                picker.remove();
            });
            picker.appendChild(colorBtn);
        });

        // Position near the button
        const rect = button.getBoundingClientRect();
        picker.style.position = 'fixed';
        picker.style.top = `${rect.bottom + 4}px`;
        picker.style.left = `${rect.left}px`;

        document.body.appendChild(picker);

        // Close on click outside
        const closeHandler = (e) => {
            if (!picker.contains(e.target) && e.target !== button) {
                picker.remove();
                document.removeEventListener('click', closeHandler);
            }
        };
        setTimeout(() => document.addEventListener('click', closeHandler), 0);
    },

    /**
     * Escape HTML to prevent XSS
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    },

    /**
     * Create a new conversation directly inside a project using project settings
     */
    async createConversationInProject(projectId, isAgent = false) {
        try {
            // Fetch project settings from API
            const settingsResponse = await fetch(`/api/settings/project/${projectId}`);
            const settingsData = await settingsResponse.json();
            const projectSettings = settingsData.settings || {};

            const title = isAgent ? 'New Agent Chat' : 'New Conversation';

            // Build the request body using project settings
            const requestBody = {
                title,
                is_agent: isAgent
            };

            if (isAgent) {
                // Use project's agent settings
                if (projectSettings.agent_model) {
                    requestBody.model = projectSettings.agent_model;
                }
                if (projectSettings.agent_system_prompt) {
                    requestBody.system_prompt = projectSettings.agent_system_prompt;
                }
            } else {
                // Use project's normal chat settings
                if (projectSettings.normal_model) {
                    requestBody.model = projectSettings.normal_model;
                }
                if (projectSettings.normal_system_prompt) {
                    requestBody.system_prompt = projectSettings.normal_system_prompt;
                }
                requestBody.settings = {
                    thinking_enabled: projectSettings.normal_thinking_enabled ?? true,
                    thinking_budget: projectSettings.normal_thinking_budget ?? 60000,
                    max_tokens: projectSettings.normal_max_tokens ?? 64000,
                    temperature: projectSettings.normal_temperature ?? 1.0,
                    top_p: projectSettings.normal_top_p ?? 1.0,
                    top_k: projectSettings.normal_top_k ?? 0,
                    prune_threshold: projectSettings.normal_prune_threshold ?? 0.7
                };
            }

            // Create the conversation directly via API
            const response = await fetch('/api/conversations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody)
            });

            const conversation = await response.json();

            if (conversation && conversation.id) {
                // Add to ConversationsManager list
                if (typeof ConversationsManager !== 'undefined') {
                    ConversationsManager.conversations.unshift(conversation);
                    ConversationsManager.currentConversationId = conversation.id;
                    ConversationsManager.renderConversationsList();

                    // Update ChatManager
                    if (typeof ChatManager !== 'undefined') {
                        ChatManager.isAgentConversation = isAgent;
                        ChatManager.clearChat();
                        ChatManager.activeConversationId = conversation.id;
                        ChatManager.currentBranch = [0];
                    }

                    // Update SettingsManager
                    if (typeof SettingsManager !== 'undefined') {
                        SettingsManager.setMode(isAgent ? 'agent' : 'normal');
                        SettingsManager.loadConversationSettings(conversation);
                    }
                }

                // Add to project
                await this.addConversationToProject(projectId, conversation.id);
            }
        } catch (error) {
            console.error('Failed to create conversation in project:', error);
        }
    },

    /**
     * Open project settings panel
     */
    openProjectSettings(projectId) {
        const project = this.projects.find(p => p.id === projectId);
        if (!project) return;

        // Open the project settings modal
        if (typeof ProjectSettingsManager !== 'undefined') {
            ProjectSettingsManager.openForProject(project);
        }
    },

    /**
     * Setup drag handlers for a conversation item in the main list
     */
    setupDragHandlers(item, conversationId) {
        item.draggable = true;

        item.addEventListener('dragstart', (e) => {
            this.draggedConversationId = conversationId;
            item.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', conversationId);
        });

        item.addEventListener('dragend', () => {
            this.draggedConversationId = null;
            item.classList.remove('dragging');
            document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
        });
    }
};

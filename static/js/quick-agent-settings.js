/**
 * Quick Agent Settings Module
 * Handles the shift+click popup for creating agent chats with custom settings
 */

const QuickAgentSettings = {
    isOpen: false,
    projectId: null,
    models: [],

    /**
     * Initialize the quick agent settings module
     */
    init() {
        this.bindEvents();
    },

    /**
     * Bind event handlers
     */
    bindEvents() {
        // Close button
        document.getElementById('close-quick-agent')?.addEventListener('click', () => {
            this.close();
        });

        // Cancel button
        document.getElementById('cancel-quick-agent')?.addEventListener('click', () => {
            this.close();
        });

        // Create button
        document.getElementById('create-quick-agent')?.addEventListener('click', () => {
            this.createChat();
        });

        // Click outside to close
        document.getElementById('quick-agent-modal')?.addEventListener('click', (e) => {
            if (e.target.id === 'quick-agent-modal') {
                this.close();
            }
        });
    },

    /**
     * Load models for the dropdown
     */
    async loadModels() {
        if (this.models.length > 0) return; // Already loaded

        try {
            const response = await fetch('/api/chat/models');
            const data = await response.json();
            this.models = data.models || [];
        } catch (error) {
            console.error('Failed to load models:', error);
        }
    },

    /**
     * Render model dropdown
     */
    renderModels() {
        const select = document.getElementById('quick-agent-model');
        if (!select) return;

        select.innerHTML = '';
        this.models.forEach(model => {
            const option = document.createElement('option');
            option.value = model.id;
            option.textContent = model.name;
            select.appendChild(option);
        });
    },

    /**
     * Open the quick agent settings modal
     * @param {string|null} projectId - Optional project ID to load settings from
     */
    async open(projectId = null) {
        this.projectId = projectId;
        this.isOpen = true;

        // Load models if needed
        await this.loadModels();
        this.renderModels();

        // Load settings (project or default)
        const settings = await this.loadSettings(projectId);
        this.applySettings(settings);

        // Show modal
        document.getElementById('quick-agent-modal').classList.add('visible');
    },

    /**
     * Close the modal
     */
    close() {
        document.getElementById('quick-agent-modal').classList.remove('visible');
        this.isOpen = false;
        this.projectId = null;
    },

    /**
     * Load settings from project or defaults
     */
    async loadSettings(projectId) {
        // Try to get project settings first
        if (projectId && typeof ProjectsManager !== 'undefined') {
            const project = ProjectsManager.projects.find(p => p.id === projectId);
            if (project?.settings) {
                return {
                    model: project.settings.agent_model || project.settings.model,
                    system_prompt: project.settings.agent_system_prompt || project.settings.system_prompt || '',
                    agent_cwd: project.settings.agent_cwd || '',
                    agent_tools: project.settings.agent_tools || {}
                };
            }
        }

        // Fall back to default settings
        if (typeof DefaultSettingsManager !== 'undefined' && DefaultSettingsManager.settings) {
            return {
                model: DefaultSettingsManager.settings.agent_model,
                system_prompt: DefaultSettingsManager.settings.agent_system_prompt || '',
                agent_cwd: DefaultSettingsManager.settings.agent_cwd || '',
                agent_tools: DefaultSettingsManager.settings.agent_tools || {}
            };
        }

        // Fallback defaults
        return {
            model: 'claude-opus-4-5-20251101',
            system_prompt: '',
            agent_cwd: '',
            agent_tools: {}
        };
    },

    /**
     * Apply settings to the form
     */
    applySettings(settings) {
        // Model
        const modelSelect = document.getElementById('quick-agent-model');
        if (modelSelect && settings.model) {
            modelSelect.value = settings.model;
        }

        // System prompt
        const systemPrompt = document.getElementById('quick-agent-system-prompt');
        if (systemPrompt) {
            systemPrompt.value = settings.system_prompt || '';
        }

        // CWD
        const cwdInput = document.getElementById('quick-agent-cwd');
        if (cwdInput) {
            cwdInput.value = settings.agent_cwd || '';
        }

        // Tools
        const toolsContainer = document.getElementById('quick-agent-tools');
        if (toolsContainer) {
            const agentTools = settings.agent_tools || {};
            const checkboxes = toolsContainer.querySelectorAll('input[type="checkbox"]');
            checkboxes.forEach(checkbox => {
                // Default to true (enabled) if not specified
                checkbox.checked = agentTools[checkbox.name] !== false;
            });
        }
    },

    /**
     * Collect settings from the form
     */
    collectSettings() {
        const tools = {};
        const toolsContainer = document.getElementById('quick-agent-tools');
        if (toolsContainer) {
            toolsContainer.querySelectorAll('input[type="checkbox"]').forEach(cb => {
                tools[cb.name] = cb.checked;
            });
        }

        return {
            model: document.getElementById('quick-agent-model')?.value,
            system_prompt: document.getElementById('quick-agent-system-prompt')?.value || null,
            agent_cwd: document.getElementById('quick-agent-cwd')?.value || null,
            agent_tools: tools
        };
    },

    /**
     * Create the agent chat with collected settings
     */
    async createChat() {
        const settings = this.collectSettings();

        try {
            // Build request body
            const requestBody = {
                title: 'New Agent Chat',
                model: settings.model,
                system_prompt: settings.system_prompt,
                is_agent: true,
                settings: {
                    agent_cwd: settings.agent_cwd,
                    agent_tools: settings.agent_tools
                }
            };

            const response = await fetch('/api/conversations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody)
            });

            const conversation = await response.json();

            // Add to conversations manager
            if (typeof ConversationsManager !== 'undefined') {
                ConversationsManager.conversations.unshift(conversation);
                ConversationsManager.currentConversationId = conversation.id;
                ConversationsManager.renderConversationsList();

                // Add to project if we opened from a project
                if (this.projectId && typeof ProjectsManager !== 'undefined') {
                    await ProjectsManager.addConversationToProject(this.projectId, conversation.id);
                }

                // Select the new conversation
                await ConversationsManager.selectConversation(conversation.id);
            }

            this.close();
        } catch (error) {
            console.error('Failed to create agent chat:', error);
            alert('Failed to create agent chat');
        }
    }
};

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    QuickAgentSettings.init();
});

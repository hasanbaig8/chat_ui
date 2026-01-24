/**
 * Project Settings Manager - handles editing settings for individual projects
 */

const ProjectSettingsManager = {
    isOpen: false,
    currentProjectId: null,
    currentProject: null,
    settings: null,
    models: [],

    /**
     * Initialize the manager
     */
    async init() {
        // Load available models
        try {
            const response = await fetch('/api/chat/models');
            const data = await response.json();
            this.models = data.models || [];
        } catch (error) {
            console.error('Failed to load models:', error);
        }

        this.createModal();
        this.bindEvents();
    },

    /**
     * Create the modal HTML
     */
    createModal() {
        const modal = document.createElement('div');
        modal.id = 'project-settings-modal';
        modal.className = 'project-settings-modal';
        modal.innerHTML = `
            <div class="project-settings-overlay"></div>
            <div class="project-settings-content">
                <div class="project-settings-header">
                    <h2>Project Settings</h2>
                    <span class="project-settings-name"></span>
                    <button class="project-settings-close">&times;</button>
                </div>
                <div class="project-settings-tabs">
                    <button class="project-settings-tab active" data-tab="normal">Normal Chat</button>
                    <button class="project-settings-tab" data-tab="agent">Agent Chat</button>
                </div>
                <div class="project-settings-body">
                    <div class="project-settings-panel active" data-panel="normal">
                        <div class="setting-group">
                            <label>Model</label>
                            <select id="project-normal-model"></select>
                        </div>
                        <div class="setting-group">
                            <label>System Prompt</label>
                            <textarea id="project-normal-system-prompt" rows="4" placeholder="Optional system prompt..."></textarea>
                        </div>
                        <div class="setting-group">
                            <label>
                                <input type="checkbox" id="project-normal-thinking-enabled">
                                Enable Extended Thinking
                            </label>
                        </div>
                        <div class="setting-group" id="project-thinking-budget-group">
                            <label>Thinking Budget: <span id="project-thinking-budget-value">60000</span></label>
                            <input type="range" id="project-normal-thinking-budget" min="1024" max="128000" step="1024" value="60000">
                        </div>
                        <div class="setting-group">
                            <label>Max Tokens: <span id="project-max-tokens-value">64000</span></label>
                            <input type="range" id="project-normal-max-tokens" min="1024" max="128000" step="1024" value="64000">
                        </div>
                        <div class="setting-group">
                            <label>Temperature: <span id="project-temperature-value">1.0</span></label>
                            <input type="range" id="project-normal-temperature" min="0" max="1" step="0.1" value="1.0">
                        </div>
                    </div>
                    <div class="project-settings-panel" data-panel="agent">
                        <div class="setting-group">
                            <label>Model</label>
                            <select id="project-agent-model"></select>
                        </div>
                        <div class="setting-group">
                            <label>System Prompt</label>
                            <textarea id="project-agent-system-prompt" rows="4" placeholder="Optional system prompt for agent..."></textarea>
                        </div>
                    </div>
                </div>
                <div class="project-settings-footer">
                    <button class="btn-secondary" id="project-settings-cancel">Cancel</button>
                    <button class="btn-primary" id="project-settings-save">Save Settings</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
    },

    /**
     * Bind event handlers
     */
    bindEvents() {
        const modal = document.getElementById('project-settings-modal');

        // Close button
        modal.querySelector('.project-settings-close').addEventListener('click', () => this.close());
        modal.querySelector('.project-settings-overlay').addEventListener('click', () => this.close());
        modal.querySelector('#project-settings-cancel').addEventListener('click', () => this.close());

        // Save button
        modal.querySelector('#project-settings-save').addEventListener('click', () => this.save());

        // Tab switching
        modal.querySelectorAll('.project-settings-tab').forEach(tab => {
            tab.addEventListener('click', (e) => {
                const tabName = e.target.dataset.tab;
                this.switchTab(tabName);
            });
        });

        // Range input updates
        modal.querySelector('#project-normal-thinking-budget').addEventListener('input', (e) => {
            modal.querySelector('#project-thinking-budget-value').textContent = e.target.value;
        });
        modal.querySelector('#project-normal-max-tokens').addEventListener('input', (e) => {
            modal.querySelector('#project-max-tokens-value').textContent = e.target.value;
        });
        modal.querySelector('#project-normal-temperature').addEventListener('input', (e) => {
            modal.querySelector('#project-temperature-value').textContent = e.target.value;
        });

        // Thinking enabled toggle
        modal.querySelector('#project-normal-thinking-enabled').addEventListener('change', (e) => {
            modal.querySelector('#project-thinking-budget-group').style.display = e.target.checked ? 'block' : 'none';
        });
    },

    /**
     * Switch between tabs
     */
    switchTab(tabName) {
        const modal = document.getElementById('project-settings-modal');

        // Update tab buttons
        modal.querySelectorAll('.project-settings-tab').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.tab === tabName);
        });

        // Update panels
        modal.querySelectorAll('.project-settings-panel').forEach(panel => {
            panel.classList.toggle('active', panel.dataset.panel === tabName);
        });
    },

    /**
     * Populate model select options
     */
    populateModels() {
        const modal = document.getElementById('project-settings-modal');
        const normalSelect = modal.querySelector('#project-normal-model');
        const agentSelect = modal.querySelector('#project-agent-model');

        [normalSelect, agentSelect].forEach(select => {
            select.innerHTML = '';
            this.models.forEach(model => {
                const option = document.createElement('option');
                option.value = model.id;
                option.textContent = model.name;
                select.appendChild(option);
            });
        });
    },

    /**
     * Open settings for a project
     */
    async openForProject(project) {
        this.currentProjectId = project.id;
        this.currentProject = project;

        // Fetch project settings
        try {
            const response = await fetch(`/api/settings/project/${project.id}`);
            const data = await response.json();
            this.settings = data.settings || {};
        } catch (error) {
            console.error('Failed to load project settings:', error);
            this.settings = {};
        }

        this.populateModels();
        this.loadSettingsIntoForm();

        const modal = document.getElementById('project-settings-modal');
        modal.querySelector('.project-settings-name').textContent = project.name;
        modal.classList.add('open');
        this.isOpen = true;
    },

    /**
     * Load settings into form fields
     */
    loadSettingsIntoForm() {
        const modal = document.getElementById('project-settings-modal');
        const s = this.settings;

        // Normal chat settings
        if (s.normal_model) {
            modal.querySelector('#project-normal-model').value = s.normal_model;
        }
        modal.querySelector('#project-normal-system-prompt').value = s.normal_system_prompt || '';
        modal.querySelector('#project-normal-thinking-enabled').checked = s.normal_thinking_enabled !== false;
        modal.querySelector('#project-normal-thinking-budget').value = s.normal_thinking_budget || 60000;
        modal.querySelector('#project-thinking-budget-value').textContent = s.normal_thinking_budget || 60000;
        modal.querySelector('#project-normal-max-tokens').value = s.normal_max_tokens || 64000;
        modal.querySelector('#project-max-tokens-value').textContent = s.normal_max_tokens || 64000;
        modal.querySelector('#project-normal-temperature').value = s.normal_temperature ?? 1.0;
        modal.querySelector('#project-temperature-value').textContent = s.normal_temperature ?? 1.0;

        // Show/hide thinking budget based on enabled state
        modal.querySelector('#project-thinking-budget-group').style.display =
            s.normal_thinking_enabled !== false ? 'block' : 'none';

        // Agent settings
        if (s.agent_model) {
            modal.querySelector('#project-agent-model').value = s.agent_model;
        }
        modal.querySelector('#project-agent-system-prompt').value = s.agent_system_prompt || '';
    },

    /**
     * Save settings
     */
    async save() {
        const modal = document.getElementById('project-settings-modal');

        const settings = {
            // Normal chat settings
            normal_model: modal.querySelector('#project-normal-model').value,
            normal_system_prompt: modal.querySelector('#project-normal-system-prompt').value || null,
            normal_thinking_enabled: modal.querySelector('#project-normal-thinking-enabled').checked,
            normal_thinking_budget: parseInt(modal.querySelector('#project-normal-thinking-budget').value),
            normal_max_tokens: parseInt(modal.querySelector('#project-normal-max-tokens').value),
            normal_temperature: parseFloat(modal.querySelector('#project-normal-temperature').value),
            normal_top_p: 1.0,
            normal_top_k: 0,
            normal_prune_threshold: 0.7,

            // Agent settings
            agent_model: modal.querySelector('#project-agent-model').value,
            agent_system_prompt: modal.querySelector('#project-agent-system-prompt').value || null
        };

        try {
            const response = await fetch(`/api/settings/project/${this.currentProjectId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(settings)
            });

            if (response.ok) {
                this.close();
            } else {
                alert('Failed to save project settings');
            }
        } catch (error) {
            console.error('Failed to save project settings:', error);
            alert('Failed to save project settings');
        }
    },

    /**
     * Close the modal
     */
    close() {
        const modal = document.getElementById('project-settings-modal');
        modal.classList.remove('open');
        this.isOpen = false;
        this.currentProjectId = null;
        this.currentProject = null;
    }
};

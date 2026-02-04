/**
 * Project Settings Manager - handles editing settings for individual projects
 */

const ProjectSettingsManager = {
    isOpen: false,
    currentProjectId: null,
    currentProject: null,
    settings: null,
    models: [],
    availableSkills: [],  // Skills loaded from default settings

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
                        <div class="setting-group">
                            <label>Working Directory (CWD)</label>
                            <div class="cwd-input-group">
                                <input type="text" id="project-agent-cwd" placeholder="Leave empty for default workspace">
                                <button type="button" class="btn-icon folder-browse-btn" data-target="project-agent-cwd" title="Browse folders">
                                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                                    </svg>
                                </button>
                            </div>
                            <span class="setting-description">Custom directory where the agent will operate. Leave empty to use the default workspace.</span>
                        </div>
                        <div class="setting-group">
                            <label>Thinking Budget: <span id="project-agent-thinking-budget-value">32000</span></label>
                            <input type="range" id="project-agent-thinking-budget" min="1024" max="32000" step="1024" value="32000">
                            <span class="setting-description">Token budget for agent's internal reasoning (extended thinking).</span>
                        </div>
                        <div class="setting-group">
                            <label>Available Tools</label>
                            <div class="tool-toggles" id="project-agent-tools">
                                <label class="tool-toggle"><input type="checkbox" name="Read" checked> Read</label>
                                <label class="tool-toggle"><input type="checkbox" name="Write" checked> Write</label>
                                <label class="tool-toggle"><input type="checkbox" name="Edit" checked> Edit</label>
                                <label class="tool-toggle"><input type="checkbox" name="Bash" checked> Bash</label>
                                <label class="tool-toggle"><input type="checkbox" name="Glob" checked> Glob</label>
                                <label class="tool-toggle"><input type="checkbox" name="Grep" checked> Grep</label>
                                <label class="tool-toggle"><input type="checkbox" name="WebSearch" checked> WebSearch</label>
                                <label class="tool-toggle"><input type="checkbox" name="WebFetch" checked> WebFetch</label>
                                <label class="tool-toggle"><input type="checkbox" name="Task" checked> Task</label>
                                <label class="tool-toggle"><input type="checkbox" name="GIF" checked> GIF</label>
                                <label class="tool-toggle"><input type="checkbox" name="Memory" checked> Memory</label>
                            </div>
                            <span class="setting-description">Toggle tools on/off to control what the agent can use.</span>
                        </div>
                        <div class="setting-group">
                            <label>Enabled Skills</label>
                            <div class="skills-checkboxes" id="project-skills-checkboxes">
                                <!-- Skills will be populated here -->
                            </div>
                            <span class="setting-description">Enable skills for this project. Skills add specialized prompts to the agent's system prompt.</span>
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

        // Range input updates with value sync
        const thinkingBudgetSlider = modal.querySelector('#project-normal-thinking-budget');
        const maxTokensSlider = modal.querySelector('#project-normal-max-tokens');
        const thinkingToggle = modal.querySelector('#project-normal-thinking-enabled');

        // Thinking budget - if increased above max_tokens, raise max_tokens
        thinkingBudgetSlider.addEventListener('input', (e) => {
            const thinkingBudget = parseInt(e.target.value);
            modal.querySelector('#project-thinking-budget-value').textContent = thinkingBudget;

            if (thinkingToggle.checked && parseInt(maxTokensSlider.value) < thinkingBudget) {
                maxTokensSlider.value = thinkingBudget;
                modal.querySelector('#project-max-tokens-value').textContent = thinkingBudget;
            }
        });

        // Max tokens - if decreased below thinking_budget, lower thinking_budget
        maxTokensSlider.addEventListener('input', (e) => {
            const value = parseInt(e.target.value);
            modal.querySelector('#project-max-tokens-value').textContent = value;

            if (thinkingToggle.checked && parseInt(thinkingBudgetSlider.value) > value) {
                thinkingBudgetSlider.value = value;
                modal.querySelector('#project-thinking-budget-value').textContent = value;
            }
        });

        modal.querySelector('#project-normal-temperature').addEventListener('input', (e) => {
            modal.querySelector('#project-temperature-value').textContent = e.target.value;
        });

        // Thinking enabled toggle - sync values when enabled
        thinkingToggle.addEventListener('change', (e) => {
            modal.querySelector('#project-thinking-budget-group').style.display = e.target.checked ? 'block' : 'none';
            if (e.target.checked) {
                const thinkingBudget = parseInt(thinkingBudgetSlider.value);
                const maxTokens = parseInt(maxTokensSlider.value);
                if (maxTokens < thinkingBudget) {
                    maxTokensSlider.value = thinkingBudget;
                    modal.querySelector('#project-max-tokens-value').textContent = thinkingBudget;
                }
            }
        });

        // Agent thinking budget slider
        const agentThinkingBudget = modal.querySelector('#project-agent-thinking-budget');
        if (agentThinkingBudget) {
            agentThinkingBudget.addEventListener('input', (e) => {
                modal.querySelector('#project-agent-thinking-budget-value').textContent = e.target.value;
            });
        }
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

        // Fetch project settings and default settings (for skills) in parallel
        try {
            const [projectResponse, defaultsResponse] = await Promise.all([
                fetch(`/api/settings/project/${project.id}`),
                fetch('/api/settings/defaults')
            ]);

            const projectData = await projectResponse.json();
            this.settings = projectData.settings || {};

            const defaultsData = await defaultsResponse.json();
            this.availableSkills = defaultsData.skills || [];
        } catch (error) {
            console.error('Failed to load settings:', error);
            this.settings = {};
            this.availableSkills = [];
        }

        this.populateModels();
        this.loadSettingsIntoForm();
        this.renderSkillsCheckboxes();

        const modal = document.getElementById('project-settings-modal');
        modal.querySelector('.project-settings-name').textContent = project.name;
        modal.classList.add('open');
        this.isOpen = true;
    },

    /**
     * Render skills checkboxes based on available skills from default settings
     */
    renderSkillsCheckboxes() {
        const container = document.getElementById('project-skills-checkboxes');
        if (!container) return;

        if (this.availableSkills.length === 0) {
            container.innerHTML = '<div class="skills-empty-project">No skills defined. Add skills in Default Settings.</div>';
            return;
        }

        const enabledSkills = this.settings?.enabled_skills || [];

        container.innerHTML = this.availableSkills.map(skill => `
            <label class="skill-checkbox">
                <input type="checkbox" name="${skill.id}" ${enabledSkills.includes(skill.id) ? 'checked' : ''}>
                <div class="skill-checkbox-info">
                    <div class="skill-checkbox-name">${this.escapeHtml(skill.name)}</div>
                    ${skill.description ? `<div class="skill-checkbox-description">${this.escapeHtml(skill.description)}</div>` : ''}
                </div>
            </label>
        `).join('');
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
        modal.querySelector('#project-agent-cwd').value = s.agent_cwd || '';

        // Agent thinking budget
        const agentThinkingBudget = modal.querySelector('#project-agent-thinking-budget');
        if (agentThinkingBudget) {
            agentThinkingBudget.value = s.agent_thinking_budget || 32000;
            const valueDisplay = modal.querySelector('#project-agent-thinking-budget-value');
            if (valueDisplay) {
                valueDisplay.textContent = agentThinkingBudget.value;
            }
        }

        // Load tool toggles
        const toolToggles = modal.querySelectorAll('#project-agent-tools input[type="checkbox"]');
        const agentTools = s.agent_tools || {};
        toolToggles.forEach(checkbox => {
            const toolName = checkbox.name;
            // Default to true (enabled) if not specified
            checkbox.checked = agentTools[toolName] !== false;
        });
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
            agent_system_prompt: modal.querySelector('#project-agent-system-prompt').value || null,
            agent_cwd: modal.querySelector('#project-agent-cwd').value || null,
            agent_thinking_budget: parseInt(modal.querySelector('#project-agent-thinking-budget')?.value) || 8000,
            agent_tools: this.getToolToggles(),

            // Enabled skills
            enabled_skills: this.getEnabledSkills()
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
     * Get tool toggle values as object
     */
    getToolToggles() {
        const modal = document.getElementById('project-settings-modal');
        const toolToggles = modal.querySelectorAll('#project-agent-tools input[type="checkbox"]');
        const tools = {};
        toolToggles.forEach(checkbox => {
            tools[checkbox.name] = checkbox.checked;
        });
        return tools;
    },

    /**
     * Get enabled skills as array of skill IDs
     */
    getEnabledSkills() {
        const modal = document.getElementById('project-settings-modal');
        const skillCheckboxes = modal.querySelectorAll('#project-skills-checkboxes input[type="checkbox"]:checked');
        return Array.from(skillCheckboxes).map(checkbox => checkbox.name);
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

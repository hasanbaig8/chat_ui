/**
 * Default Settings management module
 * Handles the popup modal for default settings that apply to new conversations
 */

const DefaultSettingsManager = {
    models: [],
    isOpen: false,
    currentTab: 'normal',
    settings: null,

    /**
     * Initialize default settings manager
     */
    async init() {
        await this.loadModels();
        await this.loadSettings();
        this.bindEvents();
        this.renderModels();
        this.applySettingsToUI();
    },

    /**
     * Load available models from API
     */
    async loadModels() {
        try {
            const response = await fetch('/api/chat/models');
            const data = await response.json();
            this.models = data.models || [];
        } catch (error) {
            console.error('Failed to load models:', error);
        }
    },

    /**
     * Load default settings from API
     */
    async loadSettings() {
        try {
            const response = await fetch('/api/settings/defaults');
            this.settings = await response.json();
        } catch (error) {
            console.error('Failed to load default settings:', error);
            this.settings = this.getDefaultValues();
        }
    },

    /**
     * Get default values if API fails
     */
    getDefaultValues() {
        return {
            normal_model: 'claude-opus-4-5-20251101',
            normal_system_prompt: '',
            normal_thinking_enabled: true,
            normal_thinking_budget: 60000,
            normal_max_tokens: 64000,
            normal_temperature: 1.0,
            normal_top_p: 1.0,
            normal_top_k: 0,
            normal_prune_threshold: 0.7,
            normal_web_search_enabled: false,
            normal_web_search_max_uses: 5,
            agent_model: 'claude-opus-4-5-20251101',
            agent_system_prompt: '',
            agent_tools: null,
            agent_cwd: null
        };
    },

    /**
     * Render model dropdowns
     */
    renderModels() {
        const normalSelect = document.getElementById('default-normal-model');
        const agentSelect = document.getElementById('default-agent-model');

        [normalSelect, agentSelect].forEach(select => {
            if (!select) return;
            select.innerHTML = '<option value="">Use default model</option>';
            this.models.forEach(model => {
                const option = document.createElement('option');
                option.value = model.id;
                option.textContent = model.name;
                select.appendChild(option);
            });
        });
    },

    /**
     * Apply loaded settings to UI elements
     */
    applySettingsToUI() {
        if (!this.settings) return;

        // Normal chat defaults
        const normalModel = document.getElementById('default-normal-model');
        if (normalModel && this.settings.normal_model) {
            normalModel.value = this.settings.normal_model;
        }

        const normalSystemPrompt = document.getElementById('default-normal-system-prompt');
        if (normalSystemPrompt) {
            normalSystemPrompt.value = this.settings.normal_system_prompt || '';
        }

        const normalThinkingToggle = document.getElementById('default-normal-thinking-toggle');
        if (normalThinkingToggle) {
            normalThinkingToggle.checked = this.settings.normal_thinking_enabled !== false;
            this.onThinkingToggle(normalThinkingToggle.checked);
        }

        const normalThinkingBudget = document.getElementById('default-normal-thinking-budget');
        const normalThinkingBudgetValue = document.getElementById('default-normal-thinking-budget-value');
        if (normalThinkingBudget) {
            normalThinkingBudget.value = this.settings.normal_thinking_budget || 10000;
            if (normalThinkingBudgetValue) {
                normalThinkingBudgetValue.textContent = normalThinkingBudget.value;
            }
        }

        const normalMaxTokens = document.getElementById('default-normal-max-tokens');
        const normalMaxTokensValue = document.getElementById('default-normal-max-tokens-value');
        if (normalMaxTokens) {
            normalMaxTokens.value = this.settings.normal_max_tokens || 64000;
            if (normalMaxTokensValue) {
                normalMaxTokensValue.textContent = normalMaxTokens.value;
            }
        }

        const normalTemperature = document.getElementById('default-normal-temperature');
        const normalTemperatureValue = document.getElementById('default-normal-temperature-value');
        if (normalTemperature) {
            normalTemperature.value = this.settings.normal_temperature ?? 1.0;
            if (normalTemperatureValue) {
                normalTemperatureValue.textContent = normalTemperature.value;
            }
        }

        const normalTopP = document.getElementById('default-normal-top-p');
        const normalTopPValue = document.getElementById('default-normal-top-p-value');
        if (normalTopP) {
            normalTopP.value = this.settings.normal_top_p ?? 1.0;
            if (normalTopPValue) {
                normalTopPValue.textContent = normalTopP.value;
            }
        }

        const normalTopK = document.getElementById('default-normal-top-k');
        const normalTopKValue = document.getElementById('default-normal-top-k-value');
        if (normalTopK) {
            normalTopK.value = this.settings.normal_top_k ?? 0;
            if (normalTopKValue) {
                normalTopKValue.textContent = normalTopK.value;
            }
        }

        const normalPruneThreshold = document.getElementById('default-normal-prune-threshold');
        const normalPruneThresholdValue = document.getElementById('default-normal-prune-threshold-value');
        if (normalPruneThreshold) {
            const thresholdPercent = Math.round((this.settings.normal_prune_threshold || 0.7) * 100);
            normalPruneThreshold.value = thresholdPercent;
            if (normalPruneThresholdValue) {
                normalPruneThresholdValue.textContent = thresholdPercent;
            }
        }

        // Web search
        const webSearchToggle = document.getElementById('default-normal-web-search-toggle');
        if (webSearchToggle) {
            webSearchToggle.checked = this.settings.normal_web_search_enabled || false;
            this.onWebSearchToggle(webSearchToggle.checked);
        }

        const webSearchMaxUses = document.getElementById('default-normal-web-search-max-uses');
        const webSearchMaxUsesValue = document.getElementById('default-normal-web-search-max-uses-value');
        if (webSearchMaxUses) {
            webSearchMaxUses.value = this.settings.normal_web_search_max_uses || 5;
            if (webSearchMaxUsesValue) {
                webSearchMaxUsesValue.textContent = webSearchMaxUses.value;
            }
        }

        // Agent chat defaults
        const agentModel = document.getElementById('default-agent-model');
        if (agentModel && this.settings.agent_model) {
            agentModel.value = this.settings.agent_model;
        }

        const agentSystemPrompt = document.getElementById('default-agent-system-prompt');
        if (agentSystemPrompt) {
            agentSystemPrompt.value = this.settings.agent_system_prompt || '';
        }

        const agentCwd = document.getElementById('default-agent-cwd');
        if (agentCwd) {
            agentCwd.value = this.settings.agent_cwd || '';
        }

        // Agent tools
        const toolToggles = document.querySelectorAll('#default-agent-tools input[type="checkbox"]');
        const agentTools = this.settings.agent_tools || {};
        toolToggles.forEach(checkbox => {
            // Default to true (enabled) if not specified
            checkbox.checked = agentTools[checkbox.name] !== false;
        });
    },

    /**
     * Handle web search toggle
     */
    onWebSearchToggle(enabled) {
        const configContainer = document.getElementById('default-normal-web-search-config');
        if (configContainer) {
            configContainer.style.display = enabled ? 'block' : 'none';
        }
    },

    /**
     * Handle thinking toggle
     */
    onThinkingToggle(enabled) {
        const budgetContainer = document.getElementById('default-normal-thinking-budget-container');
        const temperatureGroup = document.getElementById('default-normal-temperature-group');
        const topPGroup = document.getElementById('default-normal-top-p-group');
        const topKGroup = document.getElementById('default-normal-top-k-group');

        if (enabled) {
            if (budgetContainer) budgetContainer.classList.add('visible');
            if (temperatureGroup) temperatureGroup.classList.add('hidden');
            if (topPGroup) topPGroup.classList.add('hidden');
            if (topKGroup) topKGroup.classList.add('hidden');
        } else {
            if (budgetContainer) budgetContainer.classList.remove('visible');
            if (temperatureGroup) temperatureGroup.classList.remove('hidden');
            if (topPGroup) topPGroup.classList.remove('hidden');
            if (topKGroup) topKGroup.classList.remove('hidden');
        }
    },

    /**
     * Bind DOM events
     */
    bindEvents() {
        // Open modal button
        const toggleBtn = document.getElementById('default-settings-toggle');
        if (toggleBtn) {
            toggleBtn.addEventListener('click', () => this.openModal());
        }

        // Close buttons
        const closeBtn = document.getElementById('close-default-settings');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => this.closeModal());
        }

        const cancelBtn = document.getElementById('cancel-default-settings');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => this.closeModal());
        }

        // Save button
        const saveBtn = document.getElementById('save-default-settings');
        if (saveBtn) {
            saveBtn.addEventListener('click', () => this.saveSettings());
        }

        // Tab switching
        const tabBtns = document.querySelectorAll('#default-settings-modal .tab-btn');
        tabBtns.forEach(btn => {
            btn.addEventListener('click', (e) => {
                const tab = e.target.dataset.tab;
                this.switchTab(tab);
            });
        });

        // Modal overlay click to close
        const modal = document.getElementById('default-settings-modal');
        if (modal) {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    this.closeModal();
                }
            });
        }

        // Thinking toggle
        const thinkingToggle = document.getElementById('default-normal-thinking-toggle');
        if (thinkingToggle) {
            thinkingToggle.addEventListener('change', (e) => {
                this.onThinkingToggle(e.target.checked);
            });
        }

        // Web search toggle
        const webSearchToggle = document.getElementById('default-normal-web-search-toggle');
        if (webSearchToggle) {
            webSearchToggle.addEventListener('change', (e) => {
                this.onWebSearchToggle(e.target.checked);
            });
        }

        // Slider value updates
        this.bindSliderEvents();
    },

    /**
     * Bind slider input events to update displayed values
     */
    bindSliderEvents() {
        const sliders = [
            { id: 'default-normal-thinking-budget', valueId: 'default-normal-thinking-budget-value' },
            { id: 'default-normal-max-tokens', valueId: 'default-normal-max-tokens-value' },
            { id: 'default-normal-temperature', valueId: 'default-normal-temperature-value' },
            { id: 'default-normal-top-p', valueId: 'default-normal-top-p-value' },
            { id: 'default-normal-top-k', valueId: 'default-normal-top-k-value' },
            { id: 'default-normal-prune-threshold', valueId: 'default-normal-prune-threshold-value' },
            { id: 'default-normal-web-search-max-uses', valueId: 'default-normal-web-search-max-uses-value' }
        ];

        sliders.forEach(({ id, valueId }) => {
            const slider = document.getElementById(id);
            const valueDisplay = document.getElementById(valueId);
            if (slider && valueDisplay) {
                slider.addEventListener('input', (e) => {
                    valueDisplay.textContent = e.target.value;
                });
            }
        });

        // Add specific validation for thinking budget and max tokens
        const thinkingBudgetSlider = document.getElementById('default-normal-thinking-budget');
        const maxTokensSlider = document.getElementById('default-normal-max-tokens');
        const thinkingToggle = document.getElementById('default-normal-thinking-toggle');

        if (thinkingBudgetSlider && maxTokensSlider) {
            // Thinking budget - if increased above max_tokens, raise max_tokens
            thinkingBudgetSlider.addEventListener('input', (e) => {
                const thinkingBudget = parseInt(e.target.value);

                if (thinkingToggle && thinkingToggle.checked && parseInt(maxTokensSlider.value) < thinkingBudget) {
                    maxTokensSlider.value = thinkingBudget;
                    document.getElementById('default-normal-max-tokens-value').textContent = thinkingBudget;
                }
            });

            // Max tokens - if decreased below thinking_budget, lower thinking_budget
            maxTokensSlider.addEventListener('input', (e) => {
                const value = parseInt(e.target.value);

                if (thinkingToggle && thinkingToggle.checked && parseInt(thinkingBudgetSlider.value) > value) {
                    thinkingBudgetSlider.value = value;
                    document.getElementById('default-normal-thinking-budget-value').textContent = value;
                }
            });

            // Sync values when thinking is toggled on
            if (thinkingToggle) {
                thinkingToggle.addEventListener('change', (e) => {
                    if (e.target.checked) {
                        const thinkingBudget = parseInt(thinkingBudgetSlider.value);
                        const maxTokens = parseInt(maxTokensSlider.value);
                        if (maxTokens < thinkingBudget) {
                            maxTokensSlider.value = thinkingBudget;
                            document.getElementById('default-normal-max-tokens-value').textContent = thinkingBudget;
                        }
                    }
                });
            }
        }
    },

    /**
     * Switch between tabs
     */
    switchTab(tab) {
        this.currentTab = tab;

        // Update tab buttons
        const tabBtns = document.querySelectorAll('#default-settings-modal .tab-btn');
        tabBtns.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tab);
        });

        // Update tab content
        document.getElementById('default-tab-normal').style.display = tab === 'normal' ? '' : 'none';
        document.getElementById('default-tab-agent').style.display = tab === 'agent' ? '' : 'none';
    },

    /**
     * Open the modal
     */
    openModal() {
        const modal = document.getElementById('default-settings-modal');
        if (modal) {
            modal.classList.add('visible');
            this.isOpen = true;
        }
    },

    /**
     * Close the modal
     */
    closeModal() {
        const modal = document.getElementById('default-settings-modal');
        if (modal) {
            modal.classList.remove('visible');
            this.isOpen = false;
        }
    },

    /**
     * Collect settings from UI and save to API
     */
    async saveSettings() {
        const settings = {
            // Normal chat defaults
            normal_model: document.getElementById('default-normal-model')?.value || null,
            normal_system_prompt: document.getElementById('default-normal-system-prompt')?.value || '',
            normal_thinking_enabled: document.getElementById('default-normal-thinking-toggle')?.checked ?? true,
            normal_thinking_budget: parseInt(document.getElementById('default-normal-thinking-budget')?.value) || 10000,
            normal_max_tokens: parseInt(document.getElementById('default-normal-max-tokens')?.value) || 64000,
            normal_temperature: parseFloat(document.getElementById('default-normal-temperature')?.value) ?? 1.0,
            normal_top_p: parseFloat(document.getElementById('default-normal-top-p')?.value) ?? 1.0,
            normal_top_k: parseInt(document.getElementById('default-normal-top-k')?.value) ?? 0,
            normal_prune_threshold: (parseInt(document.getElementById('default-normal-prune-threshold')?.value) || 70) / 100,
            normal_web_search_enabled: document.getElementById('default-normal-web-search-toggle')?.checked || false,
            normal_web_search_max_uses: parseInt(document.getElementById('default-normal-web-search-max-uses')?.value) || 5,

            // Agent chat defaults
            agent_model: document.getElementById('default-agent-model')?.value || null,
            agent_system_prompt: document.getElementById('default-agent-system-prompt')?.value || '',
            agent_cwd: document.getElementById('default-agent-cwd')?.value || null,
            agent_tools: this.getDefaultToolToggles()
        };

        try {
            const response = await fetch('/api/settings/defaults', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(settings)
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const result = await response.json();
            if (result.success) {
                this.settings = result.settings;
                this.closeModal();
            } else {
                console.error('Failed to save default settings:', result.error);
                alert('Failed to save default settings: ' + (result.error || 'Unknown error'));
            }
        } catch (error) {
            console.error('Failed to save default settings:', error);
            alert('Failed to save default settings. Please restart the server.');
        }
    },

    /**
     * Get default tool toggles from UI
     */
    getDefaultToolToggles() {
        const toolsContainer = document.getElementById('default-agent-tools');
        if (!toolsContainer) return null;

        const checkboxes = toolsContainer.querySelectorAll('input[type="checkbox"]');
        if (checkboxes.length === 0) return null;

        const tools = {};
        checkboxes.forEach(cb => {
            tools[cb.name] = cb.checked;
        });
        return tools;
    },

    /**
     * Get default settings for a specific mode
     */
    getDefaultsForMode(mode) {
        if (!this.settings) return {};

        if (mode === 'agent') {
            return {
                model: this.settings.agent_model,
                system_prompt: this.settings.agent_system_prompt,
                agent_cwd: this.settings.agent_cwd,
                agent_tools: this.settings.agent_tools
            };
        }

        return {
            model: this.settings.normal_model,
            system_prompt: this.settings.normal_system_prompt,
            settings: {
                thinking_enabled: this.settings.normal_thinking_enabled,
                thinking_budget: this.settings.normal_thinking_budget,
                max_tokens: this.settings.normal_max_tokens,
                temperature: this.settings.normal_temperature,
                top_p: this.settings.normal_top_p,
                top_k: this.settings.normal_top_k,
                prune_threshold: this.settings.normal_prune_threshold,
                web_search_enabled: this.settings.normal_web_search_enabled,
                web_search_max_uses: this.settings.normal_web_search_max_uses
            }
        };
    }
};

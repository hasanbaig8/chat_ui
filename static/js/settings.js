/**
 * Settings panel management module
 */

const SettingsManager = {
    models: [],
    isOpen: false,
    saveTimeout: null,  // For debounced saving

    /**
     * Initialize settings
     */
    async init() {
        await this.loadModels();
        this.bindEvents();
        this.loadSavedSettings();
        this.updateThinkingVisibility();
    },

    /**
     * Debounced save to current conversation
     */
    scheduleSave() {
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
        }
        this.saveTimeout = setTimeout(() => {
            const conversationId = typeof ConversationsManager !== 'undefined'
                ? ConversationsManager.currentConversationId
                : null;
            if (conversationId) {
                this.saveToConversation(conversationId);
            }
        }, 500);  // Save 500ms after last change
    },

    /**
     * Bind DOM events
     */
    bindEvents() {
        // Close settings panel button
        document.getElementById('close-settings').addEventListener('click', () => {
            this.togglePanel();
        });

        // Model selection
        document.getElementById('model-select').addEventListener('change', (e) => {
            this.onModelChange(e.target.value);
            this.scheduleSave();
        });

        // Extended thinking toggle
        const thinkingToggle = document.getElementById('thinking-toggle');
        const thinkingBudgetSlider = document.getElementById('thinking-budget');
        const maxTokensSlider = document.getElementById('max-tokens');

        thinkingToggle.addEventListener('change', (e) => {
            this.onThinkingToggle(e.target.checked);
            // Sync values when thinking is enabled
            if (e.target.checked) {
                const thinkingBudget = parseInt(thinkingBudgetSlider.value);
                const maxTokens = parseInt(maxTokensSlider.value);
                if (maxTokens < thinkingBudget) {
                    maxTokensSlider.value = thinkingBudget;
                    document.getElementById('max-tokens-value').textContent = thinkingBudget;
                }
            }
            this.scheduleSave();
        });

        // Thinking budget slider - if increased above max_tokens, raise max_tokens
        thinkingBudgetSlider.addEventListener('input', (e) => {
            const thinkingBudget = parseInt(e.target.value);
            document.getElementById('thinking-budget-value').textContent = thinkingBudget;

            if (thinkingToggle.checked && parseInt(maxTokensSlider.value) < thinkingBudget) {
                maxTokensSlider.value = thinkingBudget;
                document.getElementById('max-tokens-value').textContent = thinkingBudget;
            }
            this.scheduleSave();
        });

        // Temperature slider
        document.getElementById('temperature').addEventListener('input', (e) => {
            document.getElementById('temperature-value').textContent = e.target.value;
            this.scheduleSave();
        });

        // Max tokens slider - if decreased below thinking_budget, lower thinking_budget
        maxTokensSlider.addEventListener('input', (e) => {
            const value = parseInt(e.target.value);
            document.getElementById('max-tokens-value').textContent = value;

            if (thinkingToggle.checked && parseInt(thinkingBudgetSlider.value) > value) {
                thinkingBudgetSlider.value = value;
                document.getElementById('thinking-budget-value').textContent = value;
            }
            this.scheduleSave();
        });

        // Top P slider
        document.getElementById('top-p').addEventListener('input', (e) => {
            document.getElementById('top-p-value').textContent = e.target.value;
            this.scheduleSave();
        });

        // Top K slider
        document.getElementById('top-k').addEventListener('input', (e) => {
            document.getElementById('top-k-value').textContent = e.target.value;
            this.scheduleSave();
        });

        // Prune threshold slider
        const pruneThresholdSlider = document.getElementById('prune-threshold');
        if (pruneThresholdSlider) {
            pruneThresholdSlider.addEventListener('input', (e) => {
                const valueDisplay = document.getElementById('prune-threshold-value');
                if (valueDisplay) {
                    valueDisplay.textContent = e.target.value;
                }
                this.scheduleSave();
            });
        }

        // Web search toggle
        const webSearchToggle = document.getElementById('web-search-toggle');
        if (webSearchToggle) {
            webSearchToggle.addEventListener('change', (e) => {
                this.onWebSearchToggle(e.target.checked);
                this.scheduleSave();
            });
        }

        // Web search max uses slider
        const webSearchMaxUses = document.getElementById('web-search-max-uses');
        if (webSearchMaxUses) {
            webSearchMaxUses.addEventListener('input', (e) => {
                document.getElementById('web-search-max-uses-value').textContent = e.target.value;
                this.scheduleSave();
            });
        }

        // Agent tools toggles (in conversation settings)
        const agentToolsContainer = document.getElementById('agent-tools');
        if (agentToolsContainer) {
            agentToolsContainer.addEventListener('change', (e) => {
                if (e.target.type === 'checkbox') {
                    this.scheduleSave();
                }
            });
        }

        // Agent CWD input (in conversation settings)
        const agentCwdInput = document.getElementById('agent-cwd');
        if (agentCwdInput) {
            agentCwdInput.addEventListener('input', () => {
                this.scheduleSave();
            });
        }

        // System prompt
        document.getElementById('system-prompt').addEventListener('input', () => {
            this.scheduleSave();
        });

        // Theme toggle
        document.getElementById('theme-toggle').addEventListener('click', () => {
            this.toggleTheme();
        });

    },

    /**
     * Load available models from API
     */
    async loadModels() {
        try {
            const response = await fetch('/api/chat/models');
            const data = await response.json();
            this.models = data.models || [];
            this.renderModelSelect();
        } catch (error) {
            console.error('Failed to load models:', error);
        }
    },

    /**
     * Render model selection dropdown
     */
    renderModelSelect() {
        const select = document.getElementById('model-select');
        select.innerHTML = '';

        this.models.forEach(model => {
            const option = document.createElement('option');
            option.value = model.id;
            option.textContent = model.name;
            select.appendChild(option);
        });

        // Set default or saved model
        const savedModel = localStorage.getItem('claude-chat-model');
        if (savedModel && this.models.find(m => m.id === savedModel)) {
            select.value = savedModel;
        }

        this.onModelChange(select.value);
    },

    /**
     * Handle model change
     */
    onModelChange(modelId) {
        const model = this.models.find(m => m.id === modelId);
        if (!model) return;

        // Update description
        document.getElementById('model-description').textContent = model.description;

        // Update max tokens limit
        const maxTokensInput = document.getElementById('max-tokens');
        maxTokensInput.max = model.max_tokens;

        // Update thinking availability
        this.updateThinkingVisibility();

        // Save preference
        localStorage.setItem('claude-chat-model', modelId);
    },

    /**
     * Handle thinking toggle
     */
    onThinkingToggle(enabled) {
        const budgetContainer = document.getElementById('thinking-budget-container');
        const temperatureGroup = document.getElementById('temperature-group');
        const topPGroup = document.getElementById('top-p-group');
        const topKGroup = document.getElementById('top-k-group');
        const maxTokensInput = document.getElementById('max-tokens');

        if (enabled) {
            budgetContainer.classList.add('visible');
            // Hide temperature controls when thinking is enabled (not allowed by API)
            temperatureGroup.classList.add('hidden');
            topPGroup.classList.add('hidden');
            topKGroup.classList.add('hidden');
            // Reset max tokens slider to full range
            maxTokensInput.min = 1;
            maxTokensInput.max = 64000;
        } else {
            budgetContainer.classList.remove('visible');
            temperatureGroup.classList.remove('hidden');
            topPGroup.classList.remove('hidden');
            topKGroup.classList.remove('hidden');

            // Reset max_tokens minimum
            maxTokensInput.min = 1;
        }
    },

    /**
     * Handle web search toggle
     */
    onWebSearchToggle(enabled) {
        const configContainer = document.getElementById('web-search-config');
        if (configContainer) {
            configContainer.style.display = enabled ? 'block' : 'none';
        }
    },

    /**
     * Update thinking toggle visibility based on model
     */
    updateThinkingVisibility() {
        const modelId = document.getElementById('model-select').value;
        const model = this.models.find(m => m.id === modelId);
        const thinkingGroup = document.getElementById('thinking-group');
        const thinkingToggle = document.getElementById('thinking-toggle');

        if (model && model.supports_thinking) {
            thinkingGroup.style.display = '';
        } else {
            thinkingGroup.style.display = 'none';
            thinkingToggle.checked = false;
            this.onThinkingToggle(false);
        }
    },

    /**
     * Toggle settings panel
     */
    togglePanel() {
        this.isOpen = !this.isOpen;
        const panel = document.getElementById('settings-panel');
        panel.classList.toggle('open', this.isOpen);
    },

    /**
     * Toggle dark/light theme
     */
    toggleTheme() {
        const currentTheme = document.documentElement.getAttribute('data-theme');
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';

        document.documentElement.setAttribute('data-theme', newTheme);
        localStorage.setItem('claude-chat-theme', newTheme);

        // Toggle highlight.js theme
        this.updateHighlightTheme(newTheme);
    },

    /**
     * Update highlight.js theme
     */
    updateHighlightTheme(theme) {
        const lightTheme = document.getElementById('hljs-light');
        const darkTheme = document.getElementById('hljs-dark');
        if (lightTheme && darkTheme) {
            lightTheme.disabled = theme === 'dark';
            darkTheme.disabled = theme !== 'dark';
        }
    },

    /**
     * Load saved settings from localStorage
     */
    loadSavedSettings() {
        // Theme
        const savedTheme = localStorage.getItem('claude-chat-theme');
        let theme = 'light';
        if (savedTheme) {
            theme = savedTheme;
            document.documentElement.setAttribute('data-theme', savedTheme);
        } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
            theme = 'dark';
            document.documentElement.setAttribute('data-theme', 'dark');
        }
        this.updateHighlightTheme(theme);

        // Model
        const savedModel = localStorage.getItem('claude-chat-model');
        if (savedModel) {
            const modelSelect = document.getElementById('model-select');
            if (modelSelect) {
                modelSelect.value = savedModel;
            }
        }

        // Temperature
        const savedTemp = localStorage.getItem('claude-chat-temperature');
        if (savedTemp) {
            document.getElementById('temperature').value = savedTemp;
            document.getElementById('temperature-value').textContent = savedTemp;
        }

        // Max tokens (default: 64000 - Opus 4.5 max output limit)
        const savedMaxTokens = localStorage.getItem('claude-chat-max-tokens');
        const maxTokens = savedMaxTokens ? parseInt(savedMaxTokens) : 64000;
        document.getElementById('max-tokens').value = Math.min(maxTokens, 64000);
        document.getElementById('max-tokens-value').textContent = Math.min(maxTokens, 64000);

        // Top P
        const savedTopP = localStorage.getItem('claude-chat-top-p');
        if (savedTopP) {
            document.getElementById('top-p').value = savedTopP;
            document.getElementById('top-p-value').textContent = savedTopP;
        }

        // Top K
        const savedTopK = localStorage.getItem('claude-chat-top-k');
        if (savedTopK) {
            document.getElementById('top-k').value = savedTopK;
            document.getElementById('top-k-value').textContent = savedTopK;
        }

        // Thinking enabled (default: true)
        const savedThinkingEnabled = localStorage.getItem('claude-chat-thinking-enabled');
        const thinkingEnabled = savedThinkingEnabled === null ? true : savedThinkingEnabled === 'true';
        document.getElementById('thinking-toggle').checked = thinkingEnabled;

        // Thinking budget (default: 60000, max: 63000 to leave room for output within 64K limit)
        const savedThinkingBudget = localStorage.getItem('claude-chat-thinking-budget');
        const thinkingBudget = savedThinkingBudget ? Math.min(parseInt(savedThinkingBudget), 63000) : 60000;
        document.getElementById('thinking-budget').value = thinkingBudget;
        document.getElementById('thinking-budget-value').textContent = thinkingBudget;

        // Apply thinking toggle UI state
        this.onThinkingToggle(thinkingEnabled);

        // System prompt
        const savedSystemPrompt = localStorage.getItem('claude-chat-system-prompt');
        if (savedSystemPrompt) {
            document.getElementById('system-prompt').value = savedSystemPrompt;
        }

        // Prune threshold
        const savedPruneThreshold = localStorage.getItem('claude-chat-prune-threshold');
        if (savedPruneThreshold) {
            document.getElementById('prune-threshold').value = savedPruneThreshold;
            document.getElementById('prune-threshold-value').textContent = savedPruneThreshold;
        }

        // Web search
        const savedWebSearchEnabled = localStorage.getItem('claude-chat-web-search-enabled');
        const webSearchEnabled = savedWebSearchEnabled === 'true';
        const webSearchToggle = document.getElementById('web-search-toggle');
        if (webSearchToggle) {
            webSearchToggle.checked = webSearchEnabled;
            this.onWebSearchToggle(webSearchEnabled);
        }

        const savedWebSearchMaxUses = localStorage.getItem('claude-chat-web-search-max-uses');
        if (savedWebSearchMaxUses) {
            document.getElementById('web-search-max-uses').value = savedWebSearchMaxUses;
            document.getElementById('web-search-max-uses-value').textContent = savedWebSearchMaxUses;
        }
    },

    /**
     * Get current settings
     */
    getSettings() {
        const model = document.getElementById('model-select').value;
        const thinkingEnabled = document.getElementById('thinking-toggle').checked;
        const webSearchEnabled = document.getElementById('web-search-toggle')?.checked || false;
        const webSearchMaxUses = parseInt(document.getElementById('web-search-max-uses')?.value || '5');

        const settings = {
            model,
            temperature: parseFloat(document.getElementById('temperature').value),
            max_tokens: parseInt(document.getElementById('max-tokens').value),
            top_p: parseFloat(document.getElementById('top-p').value),
            top_k: parseInt(document.getElementById('top-k').value),
            system_prompt: document.getElementById('system-prompt').value || null,
            thinking_enabled: thinkingEnabled,
            thinking_budget: parseInt(document.getElementById('thinking-budget').value),
            prune_threshold: parseInt(document.getElementById('prune-threshold').value) / 100,
            web_search_enabled: webSearchEnabled,
            web_search_max_uses: webSearchMaxUses
        };

        // Save to localStorage
        localStorage.setItem('claude-chat-model', settings.model);
        localStorage.setItem('claude-chat-temperature', settings.temperature);
        localStorage.setItem('claude-chat-max-tokens', settings.max_tokens);
        localStorage.setItem('claude-chat-top-p', settings.top_p);
        localStorage.setItem('claude-chat-top-k', settings.top_k);
        localStorage.setItem('claude-chat-thinking-enabled', settings.thinking_enabled);
        localStorage.setItem('claude-chat-thinking-budget', settings.thinking_budget);
        localStorage.setItem('claude-chat-prune-threshold', settings.prune_threshold * 100);
        localStorage.setItem('claude-chat-web-search-enabled', settings.web_search_enabled);
        localStorage.setItem('claude-chat-web-search-max-uses', settings.web_search_max_uses);
        if (settings.system_prompt) {
            localStorage.setItem('claude-chat-system-prompt', settings.system_prompt);
        }

        return settings;
    },

    /**
     * Set model programmatically
     */
    setModel(modelId) {
        const select = document.getElementById('model-select');
        if (this.models.find(m => m.id === modelId)) {
            select.value = modelId;
            this.onModelChange(modelId);
        }
    },

    /**
     * Set the settings mode (normal or agent chat)
     * This shows/hides relevant settings for each mode
     */
    setMode(mode) {
        const panel = document.getElementById('settings-panel');
        panel.dataset.mode = mode;  // 'normal' or 'agent'
    },

    /**
     * Load settings from a conversation object
     */
    loadConversationSettings(conversation) {
        if (!conversation) return;

        const settings = conversation.settings || {};

        // Model
        if (conversation.model) {
            this.setModel(conversation.model);
        }

        // System prompt
        if (conversation.system_prompt !== undefined) {
            document.getElementById('system-prompt').value = conversation.system_prompt || '';
        }

        // Thinking enabled
        const thinkingEnabled = settings.thinking_enabled !== undefined ? settings.thinking_enabled : true;
        document.getElementById('thinking-toggle').checked = thinkingEnabled;

        // Thinking budget
        const thinkingBudget = settings.thinking_budget || 60000;
        document.getElementById('thinking-budget').value = thinkingBudget;
        document.getElementById('thinking-budget-value').textContent = thinkingBudget;

        // Max tokens
        const maxTokens = settings.max_tokens || 64000;
        document.getElementById('max-tokens').value = maxTokens;
        document.getElementById('max-tokens-value').textContent = maxTokens;

        // Temperature
        const temperature = settings.temperature !== undefined ? settings.temperature : 1.0;
        document.getElementById('temperature').value = temperature;
        document.getElementById('temperature-value').textContent = temperature;

        // Top P
        const topP = settings.top_p !== undefined ? settings.top_p : 1.0;
        document.getElementById('top-p').value = topP;
        document.getElementById('top-p-value').textContent = topP;

        // Top K
        const topK = settings.top_k !== undefined ? settings.top_k : 0;
        document.getElementById('top-k').value = topK;
        document.getElementById('top-k-value').textContent = topK;

        // Prune threshold
        const pruneThreshold = settings.prune_threshold !== undefined ? settings.prune_threshold * 100 : 70;
        document.getElementById('prune-threshold').value = pruneThreshold;
        document.getElementById('prune-threshold-value').textContent = pruneThreshold;

        // Web search
        const webSearchEnabled = settings.web_search_enabled || false;
        const webSearchToggle = document.getElementById('web-search-toggle');
        if (webSearchToggle) {
            webSearchToggle.checked = webSearchEnabled;
            this.onWebSearchToggle(webSearchEnabled);
        }

        const webSearchMaxUses = settings.web_search_max_uses || 5;
        const webSearchMaxUsesInput = document.getElementById('web-search-max-uses');
        if (webSearchMaxUsesInput) {
            webSearchMaxUsesInput.value = webSearchMaxUses;
            document.getElementById('web-search-max-uses-value').textContent = webSearchMaxUses;
        }

        // Agent CWD (read-only display)
        const agentCwdDisplay = document.getElementById('agent-cwd-display');
        if (agentCwdDisplay) {
            const cwdPath = agentCwdDisplay.querySelector('.cwd-path');
            if (cwdPath) {
                cwdPath.textContent = settings.agent_cwd || 'Default workspace';
            }
        }

        // Agent tools (read-only badges)
        const agentToolsDisplay = document.getElementById('agent-tools-display');
        if (agentToolsDisplay) {
            const agentTools = settings.agent_tools || {};
            const toolNames = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Task', 'GIF', 'Memory', 'Surface'];
            agentToolsDisplay.innerHTML = toolNames
                .map(name => {
                    const enabled = agentTools[name] !== false;
                    return `<span class="tool-badge ${enabled ? 'enabled' : 'disabled'}">${name}</span>`;
                })
                .join('');
        }

        // Apply thinking toggle UI state
        this.onThinkingToggle(thinkingEnabled);
    },

    /**
     * Get current settings as object for saving to conversation
     */
    getConversationSettings() {
        const settings = {
            thinking_enabled: document.getElementById('thinking-toggle').checked,
            thinking_budget: parseInt(document.getElementById('thinking-budget').value),
            max_tokens: parseInt(document.getElementById('max-tokens').value),
            temperature: parseFloat(document.getElementById('temperature').value),
            top_p: parseFloat(document.getElementById('top-p').value),
            top_k: parseInt(document.getElementById('top-k').value),
            prune_threshold: parseInt(document.getElementById('prune-threshold').value) / 100,
            web_search_enabled: document.getElementById('web-search-toggle')?.checked || false,
            web_search_max_uses: parseInt(document.getElementById('web-search-max-uses')?.value || '5')
        };

        // Note: Agent CWD and tools are read-only in conversation settings
        // They are set via project settings or default settings when the conversation is created
        // So we don't include them here - they shouldn't be changed from the conversation panel

        return settings;
    },

    /**
     * Save current settings to the active conversation
     */
    async saveToConversation(conversationId) {
        if (!conversationId) return;

        const settings = this.getConversationSettings();
        const model = document.getElementById('model-select').value;
        const systemPrompt = document.getElementById('system-prompt').value || null;

        try {
            await fetch(`/api/conversations/${conversationId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: model,
                    system_prompt: systemPrompt,
                    settings: settings
                })
            });
        } catch (error) {
            console.error('Failed to save settings:', error);
        }
    }
};

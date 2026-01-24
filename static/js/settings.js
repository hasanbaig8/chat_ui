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
        document.getElementById('thinking-toggle').addEventListener('change', (e) => {
            this.onThinkingToggle(e.target.checked);
            this.scheduleSave();
        });

        // Thinking budget slider - enforce max_tokens >= thinking_budget and total <= 64000
        document.getElementById('thinking-budget').addEventListener('input', (e) => {
            const thinkingBudget = parseInt(e.target.value);
            document.getElementById('thinking-budget-value').textContent = thinkingBudget;

            // Ensure max_tokens is at least as large as thinking_budget
            const maxTokensInput = document.getElementById('max-tokens');
            let currentMaxTokens = parseInt(maxTokensInput.value);

            // When thinking is enabled, enforce thinking_budget + max_tokens <= 64000
            if (document.getElementById('thinking-toggle').checked) {
                const maxAllowed = 64000 - thinkingBudget;
                if (currentMaxTokens > maxAllowed) {
                    currentMaxTokens = maxAllowed;
                    maxTokensInput.value = currentMaxTokens;
                    document.getElementById('max-tokens-value').textContent = currentMaxTokens;
                }
                maxTokensInput.max = maxAllowed;
            }

            if (currentMaxTokens < thinkingBudget) {
                maxTokensInput.value = thinkingBudget;
                document.getElementById('max-tokens-value').textContent = thinkingBudget;
            }
            // Update min value for max_tokens when thinking is enabled
            if (document.getElementById('thinking-toggle').checked) {
                maxTokensInput.min = thinkingBudget;
            }
            this.scheduleSave();
        });

        // Temperature slider
        document.getElementById('temperature').addEventListener('input', (e) => {
            document.getElementById('temperature-value').textContent = e.target.value;
            this.scheduleSave();
        });

        // Max tokens slider - respect thinking budget minimum and total <= 64000
        document.getElementById('max-tokens').addEventListener('input', (e) => {
            let value = parseInt(e.target.value);
            const thinkingEnabled = document.getElementById('thinking-toggle').checked;

            // If thinking is enabled, enforce minimum and maximum
            if (thinkingEnabled) {
                const thinkingBudget = parseInt(document.getElementById('thinking-budget').value);
                if (value < thinkingBudget) {
                    value = thinkingBudget;
                    e.target.value = value;
                }
                // Enforce thinking_budget + max_tokens <= 64000
                const maxAllowed = 64000 - thinkingBudget;
                if (value > maxAllowed) {
                    value = maxAllowed;
                    e.target.value = value;
                }
            }
            document.getElementById('max-tokens-value').textContent = value;
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
            // Hide temperature controls when thinking is enabled (not allowed)
            temperatureGroup.classList.add('hidden');
            topPGroup.classList.add('hidden');
            topKGroup.classList.add('hidden');

            // Enforce max_tokens >= thinking_budget
            const thinkingBudget = parseInt(document.getElementById('thinking-budget').value);
            const currentMaxTokens = parseInt(maxTokensInput.value);
            maxTokensInput.min = thinkingBudget;
            if (currentMaxTokens < thinkingBudget) {
                maxTokensInput.value = thinkingBudget;
                document.getElementById('max-tokens-value').textContent = thinkingBudget;
            }
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

        // Ensure max_tokens >= thinking_budget when thinking is enabled
        if (thinkingEnabled) {
            const maxTokensInput = document.getElementById('max-tokens');
            const currentMaxTokens = parseInt(maxTokensInput.value);
            if (currentMaxTokens < thinkingBudget) {
                maxTokensInput.value = Math.min(thinkingBudget, 64000);
                document.getElementById('max-tokens-value').textContent = Math.min(thinkingBudget, 64000);
            }
            maxTokensInput.min = thinkingBudget;
        }

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
    },

    /**
     * Get current settings
     */
    getSettings() {
        const model = document.getElementById('model-select').value;
        const thinkingEnabled = document.getElementById('thinking-toggle').checked;

        const settings = {
            model,
            temperature: parseFloat(document.getElementById('temperature').value),
            max_tokens: parseInt(document.getElementById('max-tokens').value),
            top_p: parseFloat(document.getElementById('top-p').value),
            top_k: parseInt(document.getElementById('top-k').value),
            system_prompt: document.getElementById('system-prompt').value || null,
            thinking_enabled: thinkingEnabled,
            thinking_budget: parseInt(document.getElementById('thinking-budget').value),
            prune_threshold: parseInt(document.getElementById('prune-threshold').value) / 100
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

        // Apply thinking toggle UI state
        this.onThinkingToggle(thinkingEnabled);
    },

    /**
     * Get current settings as object for saving to conversation
     */
    getConversationSettings() {
        return {
            thinking_enabled: document.getElementById('thinking-toggle').checked,
            thinking_budget: parseInt(document.getElementById('thinking-budget').value),
            max_tokens: parseInt(document.getElementById('max-tokens').value),
            temperature: parseFloat(document.getElementById('temperature').value),
            top_p: parseFloat(document.getElementById('top-p').value),
            top_k: parseInt(document.getElementById('top-k').value),
            prune_threshold: parseInt(document.getElementById('prune-threshold').value) / 100
        };
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

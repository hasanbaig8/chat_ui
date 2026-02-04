/**
 * SteeringInput - Real-time agent guidance UI
 *
 * Provides a floating input that appears during agent streaming,
 * allowing users to send guidance/steering to the agent mid-task.
 */

const SteeringInput = {
    _container: null,
    _input: null,
    _submitBtn: null,
    _isVisible: false,
    _conversationId: null,

    /**
     * Initialize the steering input component
     */
    init() {
        if (this._container) return;

        // Create the steering input container
        this._container = document.createElement('div');
        this._container.className = 'steering-input-container';
        this._container.id = 'steering-input-container';
        this._container.style.display = 'none';

        this._container.innerHTML = `
            <div class="steering-input-header">
                <span class="steering-label">Guide the agent:</span>
                <button class="steering-close" title="Close">&times;</button>
            </div>
            <div class="steering-input-body">
                <textarea
                    class="steering-textarea"
                    placeholder="Type guidance for the agent... (Cmd/Ctrl+Enter to send)"
                    rows="2"
                ></textarea>
                <button class="steering-submit" title="Send guidance">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/>
                    </svg>
                </button>
            </div>
        `;

        // Insert above the input area
        const inputArea = document.querySelector('.input-area');
        if (inputArea) {
            inputArea.parentNode.insertBefore(this._container, inputArea);
        } else {
            document.body.appendChild(this._container);
        }

        // Get references
        this._input = this._container.querySelector('.steering-textarea');
        this._submitBtn = this._container.querySelector('.steering-submit');
        const closeBtn = this._container.querySelector('.steering-close');

        // Bind events
        this._submitBtn.addEventListener('click', () => this.submit());
        closeBtn.addEventListener('click', () => this.hide());

        this._input.addEventListener('keydown', (e) => {
            // Cmd/Ctrl+Enter to submit
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                this.submit();
            }
            // Escape to close
            if (e.key === 'Escape') {
                this.hide();
            }
        });

        // Auto-resize textarea
        this._input.addEventListener('input', () => {
            this._input.style.height = 'auto';
            this._input.style.height = Math.min(this._input.scrollHeight, 120) + 'px';
        });

        console.log('[SteeringInput] Initialized');
    },

    /**
     * Show the steering input for a conversation
     * @param {string} conversationId - The conversation being steered
     */
    show(conversationId) {
        if (!this._container) {
            this.init();
        }

        this._conversationId = conversationId;
        this._container.style.display = 'block';
        this._isVisible = true;
        this._input.value = '';
        this._input.style.height = 'auto';

        // Focus the input after a short delay (for animation)
        setTimeout(() => {
            this._input.focus();
        }, 100);

        console.log('[SteeringInput] Shown for conversation:', conversationId);
    },

    /**
     * Hide the steering input
     */
    hide() {
        if (!this._container) return;

        this._container.style.display = 'none';
        this._isVisible = false;
        this._conversationId = null;
        this._input.value = '';

        console.log('[SteeringInput] Hidden');
    },

    /**
     * Check if the steering input is visible
     * @returns {boolean}
     */
    isVisible() {
        return this._isVisible;
    },

    /**
     * Submit steering guidance
     */
    async submit() {
        const guidance = this._input.value.trim();
        if (!guidance) {
            this._input.focus();
            return;
        }

        if (!this._conversationId) {
            console.warn('[SteeringInput] No conversation ID set');
            return;
        }

        // Disable input while submitting
        this._input.disabled = true;
        this._submitBtn.disabled = true;

        try {
            // Get accumulated content from BackgroundStreamManager
            let accumulatedContent = [];
            if (typeof BackgroundStreamManager !== 'undefined') {
                const stream = BackgroundStreamManager.getStream(this._conversationId);
                if (stream) {
                    accumulatedContent = BackgroundStreamManager.buildFinalContent(stream);
                }
            }

            // Call the steer API
            const response = await fetch(`/api/agent-chat/steer/${this._conversationId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    guidance: guidance,
                    accumulated_content: accumulatedContent
                })
            });

            const data = await response.json();

            if (data.success) {
                console.log('[SteeringInput] Guidance sent successfully');

                // Show notification
                if (typeof NotificationManager !== 'undefined') {
                    NotificationManager.showInfo('Guidance sent - continuing...', 'Steering');
                }

                // Clear and hide the input
                this._input.value = '';
                this.hide();

                // Restart the agent stream to continue with guidance
                // The backend will pick up the steer context
                if (typeof ChatManager !== 'undefined') {
                    // Small delay to let the stop complete
                    setTimeout(() => {
                        ChatManager.continueAfterSteering();
                    }, 100);
                }
            } else {
                console.warn('[SteeringInput] Failed to send guidance:', data.message);
                if (typeof NotificationManager !== 'undefined') {
                    NotificationManager.showError(data.message || 'Failed to send guidance');
                }
            }

        } catch (error) {
            console.error('[SteeringInput] Error sending guidance:', error);
            if (typeof NotificationManager !== 'undefined') {
                NotificationManager.showError('Failed to send guidance: ' + error.message);
            }
        } finally {
            this._input.disabled = false;
            this._submitBtn.disabled = false;
            this._input.focus();
        }
    },

    /**
     * Get the current guidance text (for external access)
     * @returns {string}
     */
    getValue() {
        return this._input ? this._input.value : '';
    }
};

// Make SteeringInput globally available
window.SteeringInput = SteeringInput;

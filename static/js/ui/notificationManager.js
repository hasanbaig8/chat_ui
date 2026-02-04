/**
 * NotificationManager - Toast notifications for background events
 *
 * Displays toast notifications for:
 * - Task completion
 * - Errors
 * - General info messages
 */

const NotificationManager = {
    _container: null,
    _notifications: new Map(),
    _nextId: 1,

    // Default duration before auto-dismiss (ms)
    _defaultDuration: 8000,

    /**
     * Initialize the notification manager
     */
    init() {
        if (this._container) return;

        // Create notification container
        this._container = document.createElement('div');
        this._container.className = 'notification-container';
        this._container.id = 'notification-container';
        document.body.appendChild(this._container);

        console.log('[NotificationManager] Initialized');
    },

    /**
     * Show a task completion notification
     * @param {object} task - Task object with conversationId, title, status
     */
    showTaskComplete(task) {
        const isError = task.status === 'error';
        const icon = isError ? '!' : '&#10003;';
        const title = isError ? 'Task Failed' : 'Task Complete';
        const message = task.title || 'Agent task finished';

        this._createNotification({
            type: isError ? 'error' : 'task_complete',
            icon,
            title,
            message,
            actions: [
                {
                    label: 'View',
                    callback: () => {
                        // Navigate to the conversation
                        if (typeof ConversationsManager !== 'undefined') {
                            ConversationsManager.selectConversation(task.conversationId);
                        }
                    }
                }
            ],
            duration: this._defaultDuration
        });
    },

    /**
     * Show an info notification
     * @param {string} message - Message to display
     * @param {string} title - Optional title
     */
    showInfo(message, title = 'Info') {
        this._createNotification({
            type: 'info',
            icon: 'i',
            title,
            message,
            duration: 5000
        });
    },

    /**
     * Show an error notification
     * @param {string} message - Error message
     * @param {string} title - Optional title
     */
    showError(message, title = 'Error') {
        this._createNotification({
            type: 'error',
            icon: '!',
            title,
            message,
            duration: 10000
        });
    },

    /**
     * Show a success notification
     * @param {string} message - Success message
     * @param {string} title - Optional title
     */
    showSuccess(message, title = 'Success') {
        this._createNotification({
            type: 'success',
            icon: '&#10003;',
            title,
            message,
            duration: 5000
        });
    },

    /**
     * Create and display a notification
     * @param {object} options - Notification options
     * @private
     */
    _createNotification(options) {
        if (!this._container) {
            this.init();
        }

        const id = this._nextId++;
        const { type, icon, title, message, actions, duration } = options;

        // Create notification element
        const notification = document.createElement('div');
        notification.className = `notification notification-${type}`;
        notification.dataset.id = id;

        // Build inner HTML
        let html = `
            <div class="notification-icon">${icon}</div>
            <div class="notification-content">
                <div class="notification-title">${this._escapeHtml(title)}</div>
                <div class="notification-message">${this._escapeHtml(message)}</div>
        `;

        // Add action buttons if provided
        if (actions && actions.length > 0) {
            html += '<div class="notification-actions">';
            actions.forEach((action, index) => {
                html += `<button class="notification-action" data-action="${index}">${this._escapeHtml(action.label)}</button>`;
            });
            html += '</div>';
        }

        html += `
            </div>
            <button class="notification-close">&times;</button>
        `;

        notification.innerHTML = html;

        // Store notification data
        this._notifications.set(id, {
            element: notification,
            actions: actions || [],
            timeout: null
        });

        // Bind close button
        const closeBtn = notification.querySelector('.notification-close');
        closeBtn.addEventListener('click', () => this.dismiss(id));

        // Bind action buttons
        const actionBtns = notification.querySelectorAll('.notification-action');
        actionBtns.forEach((btn) => {
            btn.addEventListener('click', () => {
                const actionIndex = parseInt(btn.dataset.action, 10);
                const notifData = this._notifications.get(id);
                if (notifData && notifData.actions[actionIndex]) {
                    notifData.actions[actionIndex].callback();
                }
                this.dismiss(id);
            });
        });

        // Add to container with animation
        this._container.appendChild(notification);

        // Trigger entrance animation
        requestAnimationFrame(() => {
            notification.classList.add('notification-enter');
        });

        // Set auto-dismiss timer
        if (duration > 0) {
            const timeout = setTimeout(() => {
                this.dismiss(id);
            }, duration);

            const notifData = this._notifications.get(id);
            if (notifData) {
                notifData.timeout = timeout;
            }
        }

        // Pause timer on hover
        notification.addEventListener('mouseenter', () => {
            const notifData = this._notifications.get(id);
            if (notifData && notifData.timeout) {
                clearTimeout(notifData.timeout);
                notifData.timeout = null;
            }
        });

        // Resume timer on mouse leave
        notification.addEventListener('mouseleave', () => {
            const notifData = this._notifications.get(id);
            if (notifData && duration > 0) {
                notifData.timeout = setTimeout(() => {
                    this.dismiss(id);
                }, duration / 2); // Shorter duration after hover
            }
        });

        return id;
    },

    /**
     * Dismiss a notification
     * @param {number} id - Notification ID
     */
    dismiss(id) {
        const notifData = this._notifications.get(id);
        if (!notifData) return;

        // Clear timeout if exists
        if (notifData.timeout) {
            clearTimeout(notifData.timeout);
        }

        // Add exit animation
        notifData.element.classList.add('notification-exit');

        // Remove after animation
        setTimeout(() => {
            if (notifData.element.parentNode) {
                notifData.element.remove();
            }
            this._notifications.delete(id);
        }, 300);
    },

    /**
     * Dismiss all notifications
     */
    dismissAll() {
        for (const id of this._notifications.keys()) {
            this.dismiss(id);
        }
    },

    /**
     * Escape HTML to prevent XSS
     * @private
     */
    _escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
};

// Make NotificationManager globally available
window.NotificationManager = NotificationManager;

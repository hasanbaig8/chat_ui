/**
 * TaskManager - Background task tracking and notifications
 *
 * Tracks active agent tasks across conversations, enabling:
 * - Background task indicator in sidebar
 * - Notifications when tasks complete
 * - Navigation to completed task conversations
 */

const TaskManager = {
    // Map<task_id, TaskState>
    _tasks: new Map(),

    // Subscribers for task state changes
    _subscribers: new Set(),

    // Polling interval for syncing with backend
    _pollInterval: null,
    _pollIntervalMs: 5000,

    /**
     * TaskState structure:
     * {
     *   taskId: string,
     *   conversationId: string,
     *   title: string,
     *   startedAt: number (timestamp),
     *   status: 'running' | 'completed' | 'error',
     *   completedAt: number | null
     * }
     */

    /**
     * Initialize the task manager
     */
    init() {
        // Start polling for task status
        this.startPolling();

        // Also sync immediately
        this.syncWithBackend();
    },

    /**
     * Start polling for task updates from backend
     */
    startPolling() {
        if (this._pollInterval) return;

        this._pollInterval = setInterval(() => {
            this.syncWithBackend();
        }, this._pollIntervalMs);
    },

    /**
     * Stop polling
     */
    stopPolling() {
        if (this._pollInterval) {
            clearInterval(this._pollInterval);
            this._pollInterval = null;
        }
    },

    /**
     * Sync local task state with backend
     */
    async syncWithBackend() {
        try {
            const response = await fetch('/api/agent-chat/tasks/active');
            if (!response.ok) return;

            const data = await response.json();
            const activeTasks = data.tasks || [];

            // Build set of active task IDs from backend
            const activeTaskIds = new Set(activeTasks.map(t => t.task_id));

            // Check for completed tasks (tasks we're tracking that are no longer active)
            for (const [taskId, task] of this._tasks) {
                if (task.status === 'running' && !activeTaskIds.has(taskId)) {
                    // Task completed
                    this.completeTask(taskId, 'completed');
                }
            }

            // Add/update active tasks
            for (const backendTask of activeTasks) {
                if (!this._tasks.has(backendTask.task_id)) {
                    // New task we didn't know about (e.g., from another tab)
                    this._tasks.set(backendTask.task_id, {
                        taskId: backendTask.task_id,
                        conversationId: backendTask.conversation_id,
                        title: backendTask.title || 'Agent Task',
                        startedAt: backendTask.started_at * 1000, // Convert to JS timestamp
                        status: 'running',
                        completedAt: null
                    });
                    this._notifySubscribers('task_added', backendTask.task_id);
                }
            }

            // Update indicator
            this._updateIndicator();

        } catch (e) {
            console.warn('[TaskManager] Failed to sync with backend:', e);
        }
    },

    /**
     * Create/track a new task
     * @param {string} conversationId - Conversation ID
     * @param {string} title - Task title (first line of message)
     * @param {string} taskId - Optional task ID (will be generated if not provided)
     * @returns {string} Task ID
     */
    createTask(conversationId, title, taskId = null) {
        const id = taskId || `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        const task = {
            taskId: id,
            conversationId,
            title: title || 'Agent Task',
            startedAt: Date.now(),
            status: 'running',
            completedAt: null
        };

        this._tasks.set(id, task);
        console.log('[TaskManager] Created task:', id, task.title);

        this._notifySubscribers('task_created', id);
        this._updateIndicator();

        return id;
    },

    /**
     * Mark a task as complete
     * @param {string} taskId - Task ID
     * @param {string} status - 'completed' or 'error'
     */
    completeTask(taskId, status = 'completed') {
        const task = this._tasks.get(taskId);
        if (!task) return;

        if (task.status !== 'running') return; // Already completed

        task.status = status;
        task.completedAt = Date.now();

        console.log('[TaskManager] Completed task:', taskId, status);

        this._notifySubscribers('task_completed', taskId);
        this._updateIndicator();

        // Show notification if this is a background task (not currently viewing)
        const currentConversationId = Store.get('currentConversationId');
        if (task.conversationId !== currentConversationId) {
            if (typeof NotificationManager !== 'undefined') {
                NotificationManager.showTaskComplete(task);
            }
        }
    },

    /**
     * Complete task by conversation ID (called when stream ends)
     * @param {string} conversationId - Conversation ID
     * @param {string} status - 'completed' or 'error'
     */
    completeTaskByConversation(conversationId, status = 'completed') {
        for (const [taskId, task] of this._tasks) {
            if (task.conversationId === conversationId && task.status === 'running') {
                this.completeTask(taskId, status);
                break;
            }
        }
    },

    /**
     * Get all tasks not in the current conversation
     * @returns {Array} Background tasks
     */
    getBackgroundTasks() {
        const currentConversationId = Store.get('currentConversationId');
        const tasks = [];

        for (const task of this._tasks.values()) {
            if (task.status === 'running' && task.conversationId !== currentConversationId) {
                tasks.push(task);
            }
        }

        return tasks;
    },

    /**
     * Get count of running background tasks
     * @returns {number}
     */
    getBackgroundTaskCount() {
        return this.getBackgroundTasks().length;
    },

    /**
     * Get all running tasks
     * @returns {Array}
     */
    getRunningTasks() {
        const tasks = [];
        for (const task of this._tasks.values()) {
            if (task.status === 'running') {
                tasks.push(task);
            }
        }
        return tasks;
    },

    /**
     * Check if a conversation has a running task
     * @param {string} conversationId
     * @returns {boolean}
     */
    hasRunningTask(conversationId) {
        for (const task of this._tasks.values()) {
            if (task.conversationId === conversationId && task.status === 'running') {
                return true;
            }
        }
        return false;
    },

    /**
     * Subscribe to task changes
     * @param {function} callback - Called with (eventType, taskId)
     * @returns {function} Unsubscribe function
     */
    subscribe(callback) {
        this._subscribers.add(callback);
        return () => this._subscribers.delete(callback);
    },

    /**
     * Notify all subscribers of a change
     * @private
     */
    _notifySubscribers(eventType, taskId) {
        const task = this._tasks.get(taskId);
        for (const callback of this._subscribers) {
            try {
                callback(eventType, taskId, task);
            } catch (e) {
                console.error('[TaskManager] Subscriber error:', e);
            }
        }
    },

    /**
     * Update the background tasks indicator in sidebar
     * @private
     */
    _updateIndicator() {
        const indicator = document.getElementById('background-tasks-indicator');
        if (!indicator) return;

        const count = this.getBackgroundTaskCount();

        if (count > 0) {
            indicator.style.display = 'flex';
            const countEl = indicator.querySelector('.task-count');
            if (countEl) {
                countEl.textContent = count;
            }
            const textEl = indicator.querySelector('.task-text');
            if (textEl) {
                textEl.textContent = count === 1 ? 'task running' : 'tasks running';
            }
        } else {
            indicator.style.display = 'none';
        }
    },

    /**
     * Clean up old completed tasks (older than 1 hour)
     */
    cleanup() {
        const oneHourAgo = Date.now() - (60 * 60 * 1000);

        for (const [taskId, task] of this._tasks) {
            if (task.status !== 'running' && task.completedAt && task.completedAt < oneHourAgo) {
                this._tasks.delete(taskId);
            }
        }
    }
};

// Make TaskManager globally available
window.TaskManager = TaskManager;

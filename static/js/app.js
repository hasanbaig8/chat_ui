/**
 * Main application initialization
 */

document.addEventListener('DOMContentLoaded', async () => {
    console.log('Claude Chat UI initializing...');

    try {
        // Initialize all modules
        await SettingsManager.init();
        FilesManager.init();
        ChatManager.init();
        await ConversationsManager.init();

        console.log('Claude Chat UI initialized successfully');

    } catch (error) {
        console.error('Failed to initialize app:', error);
        alert('Failed to initialize application. Please refresh the page.');
    }
});

// Handle page visibility changes to stop streaming if hidden
document.addEventListener('visibilitychange', () => {
    if (document.hidden && ChatManager.isStreaming) {
        // Optionally stop streaming when tab is hidden
        // ChatManager.stopStreaming();
    }
});

// Handle keyboard shortcuts
document.addEventListener('keydown', (e) => {
    // Escape to close settings panel
    if (e.key === 'Escape') {
        if (SettingsManager.isOpen) {
            SettingsManager.togglePanel();
        }
    }

    // Ctrl/Cmd + N for new chat
    if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
        e.preventDefault();
        ConversationsManager.createConversation();
    }

    // Ctrl/Cmd + , for settings
    if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault();
        SettingsManager.togglePanel();
    }
});

// Warn before closing if streaming
window.addEventListener('beforeunload', (e) => {
    if (ChatManager.isStreaming) {
        e.preventDefault();
        e.returnValue = '';
    }
});

/**
 * Main application initialization
 */

document.addEventListener('DOMContentLoaded', async () => {
    console.log('Claude Chat UI initializing...');

    try {
        // Initialize all modules
        await SettingsManager.init();
        FilesManager.init();
        PromptLibrary.init();
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

    // Arrow Up - Scroll to top of last message
    if (e.key === 'ArrowUp' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        const messageInput = document.getElementById('message-input');
        const activeElement = document.activeElement;

        // Only trigger if not typing in textarea, or if at the start of textarea
        if (activeElement !== messageInput || (messageInput.selectionStart === 0 && messageInput.selectionEnd === 0)) {
            const container = document.getElementById('messages-container');
            const messages = container.querySelectorAll('.message');

            if (messages.length > 0) {
                const lastMessage = messages[messages.length - 1];
                const scrollTop = lastMessage.offsetTop - 20; // 20px padding

                container.scrollTo({
                    top: scrollTop,
                    behavior: 'smooth'
                });
                e.preventDefault();
            }
        }
    }

    // Arrow Down - Scroll to bottom
    if (e.key === 'ArrowDown' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        const messageInput = document.getElementById('message-input');
        const activeElement = document.activeElement;

        // Only trigger if not typing in textarea, or if at the end of textarea
        const isAtEnd = messageInput.selectionStart === messageInput.value.length &&
                        messageInput.selectionEnd === messageInput.value.length;

        if (activeElement !== messageInput || isAtEnd) {
            const container = document.getElementById('messages-container');

            container.scrollTo({
                top: container.scrollHeight,
                behavior: 'smooth'
            });

            // Focus the input
            messageInput.focus();
            e.preventDefault();
        }
    }
});

// Warn before closing if streaming
window.addEventListener('beforeunload', (e) => {
    if (ChatManager.isStreaming) {
        e.preventDefault();
        e.returnValue = '';
    }
});

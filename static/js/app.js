/**
 * Main application initialization
 */

// Track current message index for arrow navigation
let currentMessageIndex = -1; // -1 means at bottom/input

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

    // Arrow Up - Navigate to previous message
    if (e.key === 'ArrowUp' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        const messageInput = document.getElementById('message-input');
        const activeElement = document.activeElement;

        // Only trigger if not typing in textarea, or if at the start of textarea
        if (activeElement !== messageInput || (messageInput.selectionStart === 0 && messageInput.selectionEnd === 0)) {
            const container = document.getElementById('messages-container');
            const messages = Array.from(container.querySelectorAll('.message'));

            if (messages.length > 0) {
                // If at bottom (-1), go to last message
                if (currentMessageIndex === -1) {
                    currentMessageIndex = messages.length - 1;
                } else if (currentMessageIndex > 0) {
                    // Go to previous message
                    currentMessageIndex--;
                }

                const targetMessage = messages[currentMessageIndex];
                const scrollTop = targetMessage.offsetTop - 80; // 80px offset to show slightly above

                container.scrollTo({
                    top: scrollTop,
                    behavior: 'smooth'
                });
                e.preventDefault();
            }
        }
    }

    // Arrow Down - Navigate to next message or bottom
    if (e.key === 'ArrowDown' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        const messageInput = document.getElementById('message-input');
        const activeElement = document.activeElement;

        // Only trigger if not typing in textarea, or if at the end of textarea
        const isAtEnd = messageInput.selectionStart === messageInput.value.length &&
                        messageInput.selectionEnd === messageInput.value.length;

        if (activeElement !== messageInput || isAtEnd) {
            const container = document.getElementById('messages-container');
            const messages = Array.from(container.querySelectorAll('.message'));

            if (currentMessageIndex === -1) {
                // Already at bottom, do nothing or scroll to bottom again
                container.scrollTo({
                    top: container.scrollHeight,
                    behavior: 'smooth'
                });
            } else if (currentMessageIndex < messages.length - 1) {
                // Go to next message
                currentMessageIndex++;
                const targetMessage = messages[currentMessageIndex];
                const scrollTop = targetMessage.offsetTop - 80; // 80px offset

                container.scrollTo({
                    top: scrollTop,
                    behavior: 'smooth'
                });
            } else {
                // At last message, go to bottom
                currentMessageIndex = -1;
                container.scrollTo({
                    top: container.scrollHeight,
                    behavior: 'smooth'
                });

                // Focus the input
                messageInput.focus();
            }
            e.preventDefault();
        }
    }
});

// Reset message index when user manually scrolls
document.addEventListener('DOMContentLoaded', () => {
    const container = document.getElementById('messages-container');
    if (container) {
        let scrollTimeout;
        container.addEventListener('scroll', () => {
            // Reset index if user manually scrolls near the bottom
            clearTimeout(scrollTimeout);
            scrollTimeout = setTimeout(() => {
                const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 150;
                if (isNearBottom) {
                    currentMessageIndex = -1;
                }
            }, 150);
        });
    }
});

// Warn before closing if streaming
window.addEventListener('beforeunload', (e) => {
    if (ChatManager.isStreaming) {
        e.preventDefault();
        e.returnValue = '';
    }
});

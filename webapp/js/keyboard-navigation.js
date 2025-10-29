// Keyboard Navigation System
(function () {
    let currentFocusedView = null;
    let isFocusing = false; // Prevent recursive focus calls

    // Map of views with their keyboard shortcuts
    const viewMap = {
        'view-console': { // Console
            shortcut: 'k',
            modifiers: { cmd: true, shift: true }
        },
        'view-assistant': { // Assistant
            shortcut: 'a',
            modifiers: { cmd: true, shift: true }
        }
    };

    /**
     * Focus a view by ID
     */
    function focusView(viewId) {
        // Prevent recursive calls
        if (isFocusing) return;
        isFocusing = true;

        // Remove focus from all views
        document.querySelectorAll('.view').forEach(view => {
            view.classList.remove('focused');
        });

        // Add focus to the target view
        const view = document.getElementById(viewId);
        if (view) {
            view.classList.add('focused');
            currentFocusedView = viewId;

            // If activating console, blur the assistant's text field and focus terminal
            if (viewId === 'view-console') {
                const prompt = document.getElementById('ai-prompt');
                if (prompt) {
                    prompt.blur();
                }

                // Focus the terminal to make cursor blink again
                setTimeout(() => {
                    if (window.term && window.term.focus) {
                        window.term.focus();
                    }
                }, 50);
            }

            // If activating assistant, blur the console by clicking on console container
            if (viewId === 'view-assistant') {
                // Blur the console terminal cursor
                if (window.term && window.term.disable) {
                    window.term.disable();
                    // Re-enable it immediately so it's still usable, just not focused
                    setTimeout(() => {
                        if (window.term && window.term.enable) {
                            window.term.enable();
                        }
                    }, 10);
                }

                const consoleContainer = document.getElementById('console-container');
                if (consoleContainer) {
                    // Simulate a click to unfocus the terminal cursor
                    const clickEvent = new MouseEvent('mousedown', {
                        bubbles: true,
                        cancelable: true,
                        view: window
                    });
                    consoleContainer.dispatchEvent(clickEvent);
                }

                // Focus on the assistant's text input field and scroll to bottom
                setTimeout(() => {
                    const prompt = document.getElementById('ai-prompt');
                    if (prompt) {
                        prompt.focus();
                        prompt.click();
                    }

                    // Scroll the view-content to bottom
                    const viewContent = document.querySelector('#view-assistant .view-content');
                    if (viewContent) {
                        viewContent.scrollTop = viewContent.scrollHeight;
                    }
                }, 100);
            }

            // Trigger any view-specific focus handlers
            const event = new CustomEvent('viewFocused', { detail: { viewId } });
            window.dispatchEvent(event);
        }

        // Reset the flag after a short delay
        setTimeout(() => {
            isFocusing = false;
        }, 200);
    }

    /**
     * Handle keyboard shortcuts
     */
    function handleKeyDown(event) {
        const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
        const cmdKey = isMac ? event.metaKey : event.ctrlKey;
        const shiftKey = event.shiftKey;
        const key = event.key.toLowerCase();

        // Check each view's shortcut
        for (const [viewId, config] of Object.entries(viewMap)) {
            if (config.modifiers.cmd && !cmdKey) continue;
            if (config.modifiers.shift && !shiftKey) continue;
            if (key === config.shortcut) {
                event.preventDefault();
                focusView(viewId);
                return;
            }
        }
    }

    /**
     * Handle view clicks for focus
     */
    function handleViewClick(event) {
        // Find the closest parent view element
        const view = event.currentTarget;
        if (view && view.id) {
            // Only focus if not already focused to avoid unnecessary operations
            if (!view.classList.contains('focused')) {
                focusView(view.id);
            }
        }
    }

    /**
     * Initialize keyboard navigation
     */
    function init() {
        // Add keyboard event listener
        document.addEventListener('keydown', handleKeyDown);

        // Add click listeners to all views
        document.querySelectorAll('.view').forEach(view => {
            view.addEventListener('click', handleViewClick);
        });

        console.log('Keyboard navigation initialized');
    }

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // Expose focusView globally for other scripts
    window.focusView = focusView;
})();

// Keyboard Navigation System
(function () {
    let currentFocusedView = null;
    let isFocusing = false; // Prevent recursive focus calls

    // Map of views with their keyboard shortcuts
    const viewMap = {
        'view-scripts': { // Scripts
            shortcut: 's',
            modifiers: { cmd: true, shift: true }
        },
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
     * Blur the console terminal cursor
     */
    function blurConsole() {
        if (!window.term) return;

        // Find and blur the actual hidden input element that jQuery Terminal uses
        const terminalInput = document.querySelector('.cmd textarea, .cmd input, #console-container .terminal');
        if (terminalInput) {
            // Use blur on the actual input element
            terminalInput.blur();
        }
    }

    /**
     * Focus a view by ID
     */
    function focusView(viewId) {
        // Prevent recursive calls
        if (isFocusing) {
            console.warn('focusView already in progress, skipping');
            return;
        }
        isFocusing = true;

        console.log('focusView called with:', viewId);

        // Remove focus from all views
        document.querySelectorAll('.view').forEach(view => {
            view.classList.remove('focused');
        });

        // Add focus to the target view
        const view = document.getElementById(viewId);
        if (view) {
            view.classList.add('focused');
            currentFocusedView = viewId;

            // Save the last active view to localStorage
            localStorage.setItem('last_active_view', viewId);

            // Blur console for all non-console views first
            if (viewId !== 'view-console') {
                blurConsole();
            }

            // If activating scripts, focus the script editor after blurring console
            if (viewId === 'view-scripts') {
                setTimeout(() => {
                    const scriptEditor = document.getElementById('script-editor');
                    if (scriptEditor) {
                        scriptEditor.focus();
                        scriptEditor.click();
                    }
                }, 100);
            }

            // If activating console, blur the assistant's text field and focus terminal
            if (viewId === 'view-console') {
                const prompt = document.getElementById('ai-prompt');
                if (prompt) {
                    prompt.blur();
                }

                // Focus the terminal
                setTimeout(() => {
                    // Try to get terminal instance from window.term or directly from jQuery
                    let term = window.term;

                    // If window.term doesn't exist, try to get it from the jQuery terminal plugin
                    if (!term) {
                        const consoleElement = $('#console-container');
                        if (consoleElement.length && consoleElement.terminal) {
                            term = consoleElement.terminal();
                        }
                    }

                    if (term && term.focus) {
                        // Call terminal focus method
                        term.focus();
                    }

                    // Always try to focus the input element directly as well
                    const cmdInput = document.querySelector('#console-container .cmd textarea');
                    if (cmdInput) {
                        cmdInput.focus();
                    }
                }, 50);
            }

            // If activating assistant, focus and scroll
            if (viewId === 'view-assistant') {
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

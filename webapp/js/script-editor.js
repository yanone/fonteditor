// Script Editor for Python code execution
(function () {
    let editor = null;
    let runButton = null;
    let isScriptViewFocused = false;

    /**
     * Initialize the script editor
     */
    async function init() {
        // Wait for Ace to be loaded
        if (!window.ace) {
            console.error('Ace Editor not loaded');
            return;
        }

        const container = document.getElementById('script-editor');
        runButton = document.getElementById('run-script-btn');

        if (!container || !runButton) {
            console.error('Script editor elements not found');
            return;
        }

        // Load saved script from localStorage
        const savedScript = localStorage.getItem('python_script') || '# Write your Python script here...\n';

        // Create Ace editor
        editor = ace.edit('script-editor');
        editor.setTheme('ace/theme/monokai');
        editor.session.setMode('ace/mode/python');
        editor.setValue(savedScript, -1); // -1 moves cursor to start

        // Set top margin on the container
        container.style.marginTop = '11px';

        // Configure editor options
        editor.setOptions({
            fontSize: '12px',
            fontFamily: "'IBM Plex Mono', monospace",
            showPrintMargin: false,
            highlightActiveLine: true,
            enableBasicAutocompletion: true,
            enableLiveAutocompletion: false,
            tabSize: 4,
            useSoftTabs: true, // Use spaces instead of tabs
            wrap: false
        });

        let cursorWidth = '7px';
        let opacityLevel = '0.5';

        // Force wider cursor by injecting custom style and directly manipulating the cursor
        setTimeout(() => {
            // Method 1: Add a style tag to override cursor width
            const styleId = 'ace-cursor-width-override';
            if (!document.getElementById(styleId)) {
                const style = document.createElement('style');
                style.id = styleId;
                style.textContent = `
                    .ace_cursor {
                        width: ${cursorWidth} !important;
                        // opacity: ${opacityLevel} !important;
                        top: 2px !important;
                        left: -0px !important;
                    }
                `;
                document.head.appendChild(style);
            }

            // Method 2: Direct DOM manipulation
            const cursorLayer = editor.renderer.$cursorLayer;
            if (cursorLayer && cursorLayer.element) {
                const cursor = cursorLayer.element.querySelector('.ace_cursor');
                if (cursor) {
                    cursor.style.width = cursorWidth;
                    cursor.style.borderLeftWidth = cursorWidth;
                    // cursor.style.opacity = opacityLevel;
                }
            }

            // Method 3: Update on every cursor move
            editor.renderer.on('afterRender', () => {
                const cursor = editor.container.querySelector('.ace_cursor');
                if (cursor && cursor.style.width !== cursorWidth) {
                    cursor.style.width = cursorWidth;
                    cursor.style.borderLeftWidth = cursorWidth;
                    // cursor.style.opacity = opacityLevel;
                }
            });
        }, 100);

        // Save to localStorage on change
        editor.session.on('change', function () {
            localStorage.setItem('python_script', editor.getValue());
        });

        // Add custom keyboard shortcuts
        editor.commands.addCommand({
            name: 'runScript',
            bindKey: { win: 'Ctrl-Alt-R', mac: 'Command-Alt-R' },
            exec: function () {
                runScript();
            }
        });

        editor.commands.addCommand({
            name: 'clearConsole',
            bindKey: { win: 'Ctrl-K', mac: 'Command-K' },
            exec: function () {
                if (window.term) {
                    window.term.clear();
                }
            }
        });

        // Run button click handler
        runButton.addEventListener('click', runScript);

        // Handle keyboard shortcuts when script view is focused
        document.addEventListener('keydown', (event) => {
            const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
            const cmdKey = isMac ? event.metaKey : event.ctrlKey;
            const altKey = event.altKey;
            const code = event.code;

            // Check if Cmd+Alt+R and script view is focused
            if (cmdKey && altKey && code === 'KeyR' && isScriptViewFocused) {
                event.preventDefault();
                runScript();
            }

            // Check if Cmd+K to clear console
            if (cmdKey && !altKey && code === 'KeyK' && isScriptViewFocused) {
                event.preventDefault();
                if (window.term) {
                    window.term.clear();
                }
            }
        });

        // Track cursor position and focus state
        let savedCursorPosition = null;
        let isPreventingCursorJump = false;

        // Intercept ALL mouse events on the container when not focused
        container.addEventListener('mousedown', (e) => {
            if (!isScriptViewFocused) {
                // Save cursor position before any click
                savedCursorPosition = editor.getCursorPosition();
                isPreventingCursorJump = true;

                // Prevent the event from reaching the editor
                e.stopPropagation();
                e.preventDefault();

                // Manually trigger focus on the view
                const scriptView = document.getElementById('view-scripts');
                if (scriptView) {
                    scriptView.click();
                }

                // Restore cursor after focus
                setTimeout(() => {
                    if (savedCursorPosition) {
                        editor.moveCursorToPosition(savedCursorPosition);
                        editor.clearSelection();
                    }
                    isPreventingCursorJump = false;
                }, 50);
            }
        }, true); // Use capture phase to intercept before Ace

        // Listen for view focus events
        window.addEventListener('viewFocused', (event) => {
            isScriptViewFocused = event.detail.viewId === 'view-scripts';

            if (isScriptViewFocused && editor) {
                // Focus the editor
                editor.focus();

                // If we saved a position, restore it
                if (isPreventingCursorJump && savedCursorPosition) {
                    setTimeout(() => {
                        editor.moveCursorToPosition(savedCursorPosition);
                        editor.clearSelection();
                    }, 0);
                }
            }
        });

        console.log('Script editor initialized with Ace Editor');
    }

    /**
     * Run the Python script
     */
    async function runScript() {
        if (!editor) {
            console.error('Script editor not initialized');
            return;
        }

        if (!window.pyodide) {
            alert('Python environment not ready yet');
            return;
        }

        const code = editor.getValue().trim();
        if (!code) {
            alert('Please write some Python code first');
            return;
        }

        // Disable the run button while executing
        runButton.disabled = true;
        runButton.textContent = '⏳ Running...';

        try {
            // Run the Python code in the console terminal
            if (window.term) {
                // Print a separator in the console
                window.term.echo('---');
                window.term.echo('🚀 Running script...');

                // Execute the code
                await window.pyodide.runPythonAsync(code);

                window.term.echo('✅ Script completed');
            } else {
                // Fallback: just execute the code
                await window.pyodide.runPythonAsync(code);
                console.log('Script executed successfully');
            }

            // Play done sound
            if (window.playSound) {
                window.playSound('done');
            }

        } catch (error) {
            console.error('Script execution error:', error);

            // Store the full traceback for the AI assistant
            const fullTraceback = error.message;

            if (window.term) {
                let errorMessage = error.message;

                // Shorten the error message by removing internal Pyodide traceback
                const tracebackStart = 'Traceback (most recent call last):';
                const tracebackEnd = '    coroutine = eval(self.code, globals, locals)';

                if (errorMessage.includes(tracebackStart) && errorMessage.includes(tracebackEnd)) {
                    const startIndex = errorMessage.indexOf(tracebackStart) + tracebackStart.length;
                    const endIndex = errorMessage.indexOf(tracebackEnd) + tracebackEnd.length;

                    // Remove everything between these markers (but keep the "Traceback..." line)
                    errorMessage = errorMessage.slice(0, startIndex) + errorMessage.slice(endIndex);

                    // Clean up any extra newlines
                    errorMessage = errorMessage.replace(/\n{3,}/g, '\n\n').trim();
                }

                window.term.error(errorMessage);
            } else {
                alert('Script error: ' + error.message);
            }

            // Notify the AI assistant about the error
            if (window.aiAssistant && window.aiAssistant.addErrorFixMessage) {
                window.aiAssistant.addErrorFixMessage(fullTraceback, code);
            }
        } finally {
            // Re-enable the run button
            runButton.disabled = false;
            runButton.innerHTML = 'Run <span style="opacity: 0.5;">⌘⌥R</span>';
        }
    }

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // Expose scriptEditor API globally for other scripts
    window.scriptEditor = {
        get editor() {
            return editor;
        },
        runScript: runScript
    };
})();

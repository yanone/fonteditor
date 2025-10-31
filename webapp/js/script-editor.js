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

        // Listen for view focus events
        window.addEventListener('viewFocused', (event) => {
            isScriptViewFocused = event.detail.viewId === 'view-scripts';
            if (isScriptViewFocused && editor) {
                // Focus the editor when view is focused
                editor.focus();
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

            // Update font dropdown if fonts were modified
            if (window.fontDropdownManager) {
                await window.fontDropdownManager.updateDropdown();
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

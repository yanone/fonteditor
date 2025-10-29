// Script Editor for Python code execution
(function () {
    let editorView = null;
    let runButton = null;
    let isScriptViewFocused = false;

    /**
     * Initialize the script editor
     */
    async function init() {
        // Wait for CodeMirror to be loaded
        if (!window.CodeMirror) {
            await new Promise(resolve => {
                window.addEventListener('codemirror-loaded', resolve, { once: true });
            });
        }

        if (!window.CodeMirror) {
            console.error('CodeMirror not loaded');
            return;
        }

        const container = document.getElementById('script-editor');
        runButton = document.getElementById('run-script-btn');

        if (!container || !runButton) {
            console.error('Script editor elements not found');
            return;
        }

        const { EditorView, basicSetup, python, oneDark, keymap } = window.CodeMirror;

        // Load saved script from localStorage
        const savedScript = localStorage.getItem('python_script') || '# Write your Python script here...\n';

        // Custom keymap for Cmd+Alt+R
        const runKeymap = keymap.of([{
            key: "Mod-Alt-r",
            run: () => {
                runScript();
                return true;
            }
        }]);

        // Create CodeMirror editor
        editorView = new EditorView({
            doc: savedScript,
            extensions: [
                basicSetup,
                python(),
                oneDark,
                runKeymap,
                EditorView.updateListener.of((update) => {
                    if (update.docChanged) {
                        // Save to localStorage on change
                        localStorage.setItem('python_script', update.state.doc.toString());
                    }
                })
            ],
            parent: container
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
            if (isScriptViewFocused && editorView) {
                // Focus the editor when view is focused
                editorView.focus();
            }
        });

        // Handle Tab key manually to prevent focus change while adding indentation
        container.addEventListener('keydown', (event) => {
            if (event.key === 'Tab') {
                event.preventDefault();
                event.stopPropagation();

                if (!event.shiftKey) {
                    // Insert 2 spaces for indentation
                    editorView.dispatch({
                        changes: {
                            from: editorView.state.selection.main.from,
                            to: editorView.state.selection.main.to,
                            insert: '  '
                        },
                        selection: {
                            anchor: editorView.state.selection.main.from + 2
                        }
                    });
                }
                // Shift+Tab for de-indent could be added here if needed
            }
        }, true);

        console.log('Script editor initialized with CodeMirror');
    }

    /**
     * Run the Python script
     */
    async function runScript() {
        if (!editorView) {
            console.error('Script editor not initialized');
            return;
        }

        if (!window.pyodide) {
            alert('Python environment not ready yet');
            return;
        }

        const code = editorView.state.doc.toString().trim();
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
        } finally {
            // Re-enable the run button
            runButton.disabled = false;
            runButton.innerHTML = 'Run <span style="opacity: 0.5;">cmd+alt+r</span>';
        }
    }

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // Expose runScript globally for other scripts
    window.runScript = runScript;
})();

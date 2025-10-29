// Script Editor for Python code execution
(function () {
    let scriptEditor = null;
    let runButton = null;
    let isScriptViewFocused = false;

    /**
     * Initialize the script editor
     */
    function init() {
        scriptEditor = document.getElementById('script-editor');
        runButton = document.getElementById('run-script-btn');

        if (!scriptEditor || !runButton) {
            console.error('Script editor elements not found');
            return;
        }

        // Load saved script from localStorage
        const savedScript = localStorage.getItem('python_script');
        if (savedScript) {
            scriptEditor.value = savedScript;
        }

        // Save script to localStorage on change
        scriptEditor.addEventListener('input', () => {
            localStorage.setItem('python_script', scriptEditor.value);
        });

        // Run button click handler
        runButton.addEventListener('click', runScript);

        // Handle Cmd+Alt+R keyboard shortcut when script view is focused
        document.addEventListener('keydown', (event) => {
            const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
            const cmdKey = isMac ? event.metaKey : event.ctrlKey;
            const altKey = event.altKey;
            const code = event.code; // Use code instead of key for alt combinations

            // Check if Cmd+Alt+R and script view is focused
            if (cmdKey && altKey && code === 'KeyR' && isScriptViewFocused) {
                event.preventDefault();
                runScript();
            }
        });

        // Listen for view focus events
        window.addEventListener('viewFocused', (event) => {
            isScriptViewFocused = event.detail.viewId === 'view-scripts';
        });

        // Handle keyboard shortcuts in the script editor
        scriptEditor.addEventListener('keydown', (event) => {
            // Handle Tab key to insert tabs instead of changing focus
            if (event.key === 'Tab') {
                event.preventDefault();
                const start = scriptEditor.selectionStart;
                const end = scriptEditor.selectionEnd;
                const value = scriptEditor.value;

                // Insert tab character
                scriptEditor.value = value.substring(0, start) + '    ' + value.substring(end);

                // Move cursor after the tab
                scriptEditor.selectionStart = scriptEditor.selectionEnd = start + 4;
                return;
            }

            // Handle Cmd+Alt+R to run script
            const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
            const cmdKey = isMac ? event.metaKey : event.ctrlKey;
            const altKey = event.altKey;
            const code = event.code; // Use code instead of key for alt combinations

            if (cmdKey && altKey && code === 'KeyR') {
                event.preventDefault();
                event.stopPropagation();
                runScript();
            }
        });

        console.log('Script editor initialized');
    }

    /**
     * Run the Python script
     */
    async function runScript() {
        if (!scriptEditor) {
            console.error('Script editor not initialized');
            return;
        }

        if (!window.pyodide) {
            alert('Python environment not ready yet');
            return;
        }

        const code = scriptEditor.value.trim();
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
                window.term.echo('─'.repeat(60));
                window.term.echo('🚀 Running script...');
                window.term.echo('─'.repeat(60));

                // Execute the code
                await window.pyodide.runPythonAsync(code);

                window.term.echo('─'.repeat(60));
                window.term.echo('✅ Script completed');
                window.term.echo('─'.repeat(60));
            } else {
                // Fallback: just execute the code
                await window.pyodide.runPythonAsync(code);
                console.log('Script executed successfully');
            }

            // Update font dropdown if fonts were modified
            if (window.fontDropdownManager) {
                await window.fontDropdownManager.updateDropdown();
            }

        } catch (error) {
            console.error('Script execution error:', error);
            if (window.term) {
                window.term.error('❌ Error: ' + error.message);
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

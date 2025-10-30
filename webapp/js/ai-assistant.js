// AI Assistant for Font Editing
// Sends prompts to Anthropic Claude with Python API docs
// Executes generated Python code with error handling and retry

class AIAssistant {
    constructor() {
        this.apiKey = localStorage.getItem('anthropic_api_key') || '';
        this.messages = [];
        this.conversationHistory = [];
        this.maxRetries = 3;
        this.cachedApiDocs = null; // Cache for babelfont API documentation
        this.autoRun = localStorage.getItem('ai_auto_run') !== 'false'; // Default to true

        this.initUI();
    }

    initUI() {
        // Get DOM elements
        this.apiKeyInput = document.getElementById('ai-api-key');
        this.promptInput = document.getElementById('ai-prompt');
        this.sendButton = document.getElementById('ai-send-btn');
        this.clearButton = document.getElementById('ai-clear-btn');
        this.messagesContainer = document.getElementById('ai-messages');
        this.autoRunButton = document.getElementById('ai-auto-run-btn');
        this.isAssistantViewFocused = false;

        // Set saved API key
        if (this.apiKey) {
            this.apiKeyInput.value = this.apiKey;
        }

        // Update auto-run button state
        this.updateAutoRunButton();

        // Event listeners
        this.apiKeyInput.addEventListener('change', () => {
            this.apiKey = this.apiKeyInput.value;
            localStorage.setItem('anthropic_api_key', this.apiKey);
        });

        this.sendButton.addEventListener('click', () => this.sendPrompt());

        this.clearButton.addEventListener('click', () => this.clearConversation());

        this.autoRunButton.addEventListener('click', () => this.toggleAutoRun());

        this.promptInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault(); // Prevent newline
                this.sendPrompt();
            }
        });

        // Listen for view focus events
        window.addEventListener('viewFocused', (event) => {
            this.isAssistantViewFocused = event.detail.viewId === 'view-assistant';
            this.updateAutoRunButton(); // Update button appearance based on focus
        });

        // Add global keyboard shortcuts when assistant is focused
        document.addEventListener('keydown', (event) => {
            const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
            const cmdKey = isMac ? event.metaKey : event.ctrlKey;
            const code = event.code;

            // Check if Cmd+K to clear console when assistant is focused
            if (cmdKey && !event.altKey && code === 'KeyK' && this.isAssistantViewFocused) {
                event.preventDefault();
                if (window.term) {
                    window.term.clear();
                }
            }

            // Check if Cmd+Alt+R to run last visible "Run in Console" button
            if (cmdKey && event.altKey && code === 'KeyR' && this.isAssistantViewFocused) {
                event.preventDefault();
                // Find all visible run buttons
                const runButtons = document.querySelectorAll('.ai-run-in-console-btn');
                if (runButtons.length > 0) {
                    // Get the last button and trigger it
                    const lastButton = runButtons[runButtons.length - 1];
                    if (!lastButton.disabled) {
                        lastButton.click();
                    }
                }
            }

            // Check if Cmd+Alt+O to open last visible code in script editor
            if (cmdKey && event.altKey && !event.shiftKey && code === 'KeyO' && this.isAssistantViewFocused) {
                event.preventDefault();
                // Find all visible open in editor buttons
                const openButtons = document.querySelectorAll('.ai-open-in-editor-btn');
                if (openButtons.length > 0) {
                    // Get the last button and trigger it
                    const lastButton = openButtons[openButtons.length - 1];
                    if (!lastButton.disabled) {
                        lastButton.click();
                    }
                }
            }

            // Check if Alt+R to toggle auto-run (no cmd key)
            if (!cmdKey && event.altKey && !event.shiftKey && code === 'KeyR' && this.isAssistantViewFocused) {
                event.preventDefault();
                this.toggleAutoRun();
            }
        });
    }

    toggleAutoRun() {
        this.autoRun = !this.autoRun;
        localStorage.setItem('ai_auto_run', this.autoRun);
        this.updateAutoRunButton();
    }

    updateAutoRunButton() {
        if (this.autoRunButton) {
            if (this.autoRun) {
                // Use darker green when not focused
                const bgColor = this.isAssistantViewFocused ? '#00ff00' : '#006600';
                const borderColor = this.isAssistantViewFocused ? '#00ff00' : '#006600';

                this.autoRunButton.innerHTML = 'Auto-Run <span class="ai-button-shortcut" style="color: rgba(0, 0, 0, 0.5);">⌥R</span>';
                this.autoRunButton.style.backgroundColor = bgColor;
                this.autoRunButton.style.color = '#1a1a1a';
                this.autoRunButton.style.borderColor = borderColor;
            } else {
                this.autoRunButton.innerHTML = 'Auto-Run <span class="ai-button-shortcut">⌥R</span>';
                this.autoRunButton.style.backgroundColor = 'transparent';
                this.autoRunButton.style.color = 'rgba(255, 255, 255, 0.8)';
                this.autoRunButton.style.borderColor = 'rgba(255, 255, 255, 0.3)';
            }
        }
    }

    updateButtonShortcuts() {
        // Find all run buttons
        const runButtons = document.querySelectorAll('.ai-run-in-console-btn');

        // Remove shortcut from all run buttons
        runButtons.forEach(btn => {
            const text = btn.textContent || btn.innerText;
            if (text.includes('Run in Console')) {
                btn.innerHTML = 'Run in Console';
            }
        });

        // Add shortcut only to the last run button
        if (runButtons.length > 0) {
            const lastButton = runButtons[runButtons.length - 1];
            const text = lastButton.textContent || lastButton.innerText;
            if (text.includes('Run in Console')) {
                lastButton.innerHTML = 'Run in Console <span class="ai-button-shortcut">⌘⌥R</span>';
            }
        }

        // Find all open in editor buttons
        const openButtons = document.querySelectorAll('.ai-open-in-editor-btn');

        // Remove shortcut from all open buttons
        openButtons.forEach(btn => {
            const text = btn.textContent || btn.innerText;
            if (text.includes('Open in Script Editor')) {
                btn.innerHTML = 'Open in Script Editor';
            }
        });

        // Add shortcut only to the last open button
        if (openButtons.length > 0) {
            const lastButton = openButtons[openButtons.length - 1];
            const text = lastButton.textContent || lastButton.innerText;
            if (text.includes('Open in Script Editor')) {
                lastButton.innerHTML = 'Open in Script Editor <span class="ai-button-shortcut">⌘⌥O</span>';
            }
        }
    } addMessage(role, content, isCode = false, isCollapsible = false) {
        // Show messages container on first message
        if (this.messagesContainer.style.display === 'none' || !this.messagesContainer.style.display) {
            this.messagesContainer.style.display = 'block';
        }

        const messageDiv = document.createElement('div');
        messageDiv.className = `ai-message ai-message-${role}`;

        const timestamp = new Date().toLocaleTimeString();
        const roleLabel = role === 'user' ? '👽 You' : role === 'output' ? '🤖 Output' : '🤖 AI';
        const header = `<div class="ai-message-header">${roleLabel} - ${timestamp}</div>`;

        let body;
        if (isCode) {
            if (isCollapsible) {
                // Collapsible code block
                const codeId = 'code-' + Date.now() + Math.random().toString(36).substr(2, 9);
                const btnId = 'btn-' + Date.now() + Math.random().toString(36).substr(2, 9);
                body = `
                    <div class="ai-code-collapsible">
                        <button class="ai-code-toggle" id="${btnId}" onclick="
                            const code = document.getElementById('${codeId}');
                            const btn = document.getElementById('${btnId}');
                            code.classList.toggle('collapsed');
                            if (code.classList.contains('collapsed')) {
                                btn.textContent = '▶ Show Python Code';
                            } else {
                                btn.textContent = '▼ Hide Python Code';
                            }
                        ">▶ Show Python Code</button>
                        <pre class="ai-code collapsed" id="${codeId}"><code>${this.escapeHtml(content)}</code></pre>
                    </div>`;
            } else {
                body = `<pre class="ai-code"><code>${this.escapeHtml(content)}</code></pre>`;
            }
        } else {
            body = `<div class="ai-message-content">${this.escapeHtml(content)}</div>`;
        }

        messageDiv.innerHTML = header + body;
        this.messagesContainer.appendChild(messageDiv);
        this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;

        // Scroll the view-content to bottom
        this.scrollToBottom();

        return messageDiv;
    }

    scrollToBottom() {
        // Scroll the messages container
        if (this.messagesContainer) {
            this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
        }

        // Scroll the view-content container
        setTimeout(() => {
            const viewContent = document.querySelector('#view-assistant .view-content');
            if (viewContent) {
                viewContent.scrollTop = viewContent.scrollHeight;
            }
        }, 50);
    }

    addOutputWithCode(output, code, showRunButton = false) {
        // Show messages container on first message
        if (this.messagesContainer.style.display === 'none' || !this.messagesContainer.style.display) {
            this.messagesContainer.style.display = 'block';
        }

        const messageDiv = document.createElement('div');
        messageDiv.className = 'ai-message ai-message-output';

        const timestamp = new Date().toLocaleTimeString();

        // Generate unique IDs
        const codeId = 'code-' + Date.now() + Math.random().toString(36).substr(2, 9);
        const btnId = 'btn-' + Date.now() + Math.random().toString(36).substr(2, 9);
        const runBtnId = 'run-' + Date.now() + Math.random().toString(36).substr(2, 9);
        const openBtnId = 'open-' + Date.now() + Math.random().toString(36).substr(2, 9);

        const header = `
            <div class="ai-message-header">
                <span>📎 Assistant - ${timestamp}</span>
                <span class="ai-code-toggle-link" id="${btnId}" onclick="
                    const code = document.getElementById('${codeId}');
                    const btn = document.getElementById('${btnId}');
                    code.classList.toggle('collapsed');
                    if (code.classList.contains('collapsed')) {
                        btn.textContent = '▶ Show Code';
                    } else {
                        btn.textContent = '▼ Hide Code';
                    }
                ">▶ Show Code</span>
            </div>`;

        const buttonContainerHtml = showRunButton ? `
            <div class="ai-button-group">
                <button class="ai-run-in-console-btn" id="${runBtnId}">Run in Console</button>
                <button class="ai-open-in-editor-btn" id="${openBtnId}">Open in Script Editor</button>
            </div>` : '';

        const body = `
            <div class="ai-output-with-code">
                <pre class="ai-code collapsed" id="${codeId}"><code>${this.escapeHtml(code)}</code></pre>
                <div class="ai-message-content">${output && output.trim() ? this.escapeHtml(output) : '(Code ready to run)'}</div>
                ${buttonContainerHtml}
            </div>`;

        messageDiv.innerHTML = header + body;
        this.messagesContainer.appendChild(messageDiv);
        this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;

        // Add event listeners for buttons if they exist
        if (showRunButton) {
            const runBtn = document.getElementById(runBtnId);
            if (runBtn) {
                runBtn.addEventListener('click', async () => {
                    runBtn.disabled = true;
                    runBtn.innerHTML = 'Running...';
                    try {
                        await this.runCodeInConsole(code);
                        runBtn.innerHTML = '✓ Executed';
                        setTimeout(() => {
                            runBtn.innerHTML = 'Run in Console';
                            this.updateButtonShortcuts();
                            runBtn.disabled = false;
                        }, 2000);
                    } catch (error) {
                        runBtn.innerHTML = '✗ Error';
                        setTimeout(() => {
                            runBtn.innerHTML = 'Run in Console';
                            this.updateButtonShortcuts();
                            runBtn.disabled = false;
                        }, 2000);
                    }
                });
            }

            const openBtn = document.getElementById(openBtnId);
            if (openBtn) {
                openBtn.addEventListener('click', () => {
                    this.openCodeInEditor(code);
                });
            }
        }

        // Update which buttons show shortcuts (only the last ones)
        this.updateButtonShortcuts();

        // Scroll the view-content to bottom
        this.scrollToBottom();

        return messageDiv;
    }

    async runCodeInConsole(code) {
        if (!window.term) {
            throw new Error('Console not available');
        }

        if (!window.pyodide) {
            throw new Error('Python environment not ready');
        }

        try {
            window.term.echo('🚀 Running AI-generated code...');
            await window.pyodide.runPythonAsync(code);
            window.term.echo('✅ Code executed successfully');

            // Update font dropdown if fonts were modified
            if (window.fontDropdownManager) {
                await window.fontDropdownManager.updateDropdown();
            }

            // Play done sound
            if (window.playSound) {
                window.playSound('done');
            }
        } catch (error) {
            window.term.error('Error: ' + error.message);
            throw error;
        }
    }

    openCodeInEditor(code) {
        // Get the script editor instance
        if (window.scriptEditor && window.scriptEditor.editor) {
            // Set the code in the editor
            window.scriptEditor.editor.setValue(code, -1); // -1 moves cursor to start

            // Focus the script editor view
            const scriptView = document.getElementById('view-scripts');
            if (scriptView) {
                scriptView.click(); // This will trigger the focus
            }
        }
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    clearConversation() {
        if (confirm('Clear conversation history? This will start a fresh conversation.')) {
            this.conversationHistory = [];
            this.messagesContainer.innerHTML = '';
            this.messagesContainer.style.display = 'none'; // Hide when cleared
            console.log('Conversation history cleared');
        }
    }

    async sendPrompt() {
        const prompt = this.promptInput.value.trim();

        if (!prompt) {
            alert('Please enter a prompt');
            return;
        }

        if (!this.apiKey) {
            alert('Please enter your Anthropic API key');
            this.apiKeyInput.focus();
            return;
        }

        if (!window.pyodide) {
            alert('Python environment not ready yet');
            return;
        }

        // Clear input
        this.promptInput.value = '';
        this.promptInput.disabled = true;
        this.sendButton.disabled = true;

        // Add user message
        this.addMessage('user', prompt);

        // Play message sent sound
        if (window.playSound) {
            window.playSound('message_sent');
        }

        try {
            await this.executeWithRetry(prompt, 0);
        } catch (error) {
            this.addMessage('error', `Failed after ${this.maxRetries} attempts: ${error.message}`);
        } finally {
            this.promptInput.disabled = false;
            this.sendButton.disabled = false;
            this.promptInput.focus();
        }
    }

    async executeWithRetry(originalPrompt, attemptNumber, previousError = null) {
        if (attemptNumber >= this.maxRetries) {
            throw new Error(`Maximum retry attempts (${this.maxRetries}) reached`);
        }

        try {
            // Get Python code from Claude
            const pythonCode = await this.callClaude(originalPrompt, previousError, attemptNumber);

            if (this.autoRun) {
                // Auto-run mode: Execute the Python code and capture output
                const output = await this.executePython(pythonCode);

                // Show output with collapsible code and run button
                this.addOutputWithCode(output, pythonCode, true);

                // Play incoming message sound
                if (window.playSound) {
                    window.playSound('incoming_message');
                }

                // Update font dropdown if fonts were modified
                if (window.fontDropdownManager) {
                    await window.fontDropdownManager.updateDropdown();
                }
            } else {
                // Manual mode: Just show the code with a run button
                this.addOutputWithCode('', pythonCode, true);

                // Play incoming message sound
                if (window.playSound) {
                    window.playSound('incoming_message');
                }
            }

        } catch (error) {
            console.error(`Attempt ${attemptNumber + 1} failed:`, error);

            // Add error message
            this.addMessage('error', `Execution error: ${error.message}`);

            // Only retry in auto-run mode
            if (this.autoRun && attemptNumber < this.maxRetries - 1) {
                this.addMessage('system', `Retrying (attempt ${attemptNumber + 2}/${this.maxRetries})...`);
                await this.executeWithRetry(originalPrompt, attemptNumber + 1, error.message);
            } else {
                throw error;
            }
        }
    }

    async callClaude(userPrompt, previousError = null, attemptNumber = 0) {
        // Get API documentation from babelfont (cached after first generation)
        if (!this.cachedApiDocs) {
            try {
                this.cachedApiDocs = await window.pyodide.runPythonAsync(`
import babelfont
babelfont.generate_all_docs()
                `);
                console.log('Babelfont API documentation cached');
            } catch (error) {
                console.warn('Could not generate babelfont API docs, using fallback:', error);
                this.cachedApiDocs = `API documentation not available. Use standard babelfont attributes:
- font.glyphs, font.names, font.masters, etc.
- glyph.name, glyph.width, glyph.layers
- layer.paths, layer.width
- path.nodes
- node.x, node.y, node.type`;
            }
        }

        const apiDocs = this.cachedApiDocs;

        // Build the system prompt with API documentation
        const systemPrompt = `You are a Python code generator for a font editor using the babelfont library.

CRITICAL RULES:
1. ALWAYS use CurrentFont() and assign it to __font to get the main font object - DO NOT overwrite existing variables.
2. Generate ONLY executable Python code - no markdown, no explanations outside of code
3. Include print() statements in your code to show results to the user
4. Handle errors gracefully within your code
5. The font object is a babelfont Font instance
6. Only set data in the font object if there is a clear instruction to do so in the user prompt
7. Gently annotate the code with comments
8. But never return single-line Python comments. If you want to return just a comment, wrap it in a print statement anyway so the user gets to see it.
9. At the end of the code, save a summary of the user prompt (ca. 50 characters max) into a variable called __summary that can be used as a title to save the script.

BABELFONT API DOCUMENTATION:
${apiDocs}

EXAMPLE OPERATIONS:
# Make all glyphs 10% wider
font = CurrentFont()
for glyph in font.glyphs:
    for layer in glyph.layers:
        layer.width = layer.width * 1.1
        for path in layer.paths:
            for node in path.nodes:
                node.x = node.x * 1.1
print(f"Made {len(font.glyphs)} glyphs 10% wider")

# List all glyph names
font = CurrentFont()
print(f"Font has {len(font.glyphs)} glyphs:")
for glyph in font.glyphs:
    print(f"  - {glyph.name}")

Generate Python code for: ${userPrompt}`;

        // Build conversation messages with full conversation history
        const messages = [...this.conversationHistory];

        // Add current prompt (or retry with error context)
        if (previousError && attemptNumber > 0) {
            messages.push({
                role: 'user',
                content: `${userPrompt}\n\nPrevious attempt ${attemptNumber} failed with error:\n${previousError}\n\nPlease fix the code and try again.`
            });
        } else {
            messages.push({
                role: 'user',
                content: userPrompt
            });
        }

        // Call Anthropic API via proxy
        // Uses local proxy (localhost:8001) if available, otherwise falls back to public CORS proxy
        const localProxyUrl = 'http://localhost:8001';
        const publicProxyUrl = 'https://corsproxy.io/?https%3A%2F%2Fapi.anthropic.com%2Fv1%2Fmessages';

        // Try local proxy first, fall back to public proxy
        let apiUrl = localProxyUrl;
        let useLocalProxy = true;

        // Check if local proxy is available
        try {
            const testResponse = await fetch(localProxyUrl, { method: 'HEAD' }).catch(() => null);
            if (!testResponse || !testResponse.ok) {
                useLocalProxy = false;
                apiUrl = publicProxyUrl;
                console.log('Local proxy not available, using public CORS proxy');
            }
        } catch (e) {
            useLocalProxy = false;
            apiUrl = publicProxyUrl;
            console.log('Local proxy not available, using public CORS proxy');
        }

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'x-api-key': this.apiKey,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 8192,
                system: systemPrompt,
                messages: messages
            })
        });

        // Log the full prompt to console for debugging
        console.group('📎 AI Prompt Sent to Claude');
        console.log('System Prompt:', systemPrompt);
        console.log('Messages:', messages);
        console.log('Model:', 'claude-sonnet-4-20250514');
        console.groupEnd();

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(`API error: ${errorData.error?.message || response.statusText}`);
        }

        const data = await response.json();

        // Extract Python code from response
        let pythonCode = data.content[0].text;

        // Remove markdown code blocks if present
        pythonCode = pythonCode.replace(/```python\n?/g, '').replace(/```\n?/g, '').trim();

        // Add to conversation history (only if not a retry)
        if (!previousError || attemptNumber === 0) {
            this.conversationHistory.push({
                role: 'user',
                content: userPrompt
            });
            this.conversationHistory.push({
                role: 'assistant',
                content: data.content[0].text
            });

            // Keep conversation history manageable (last 10 exchanges = 20 messages)
            if (this.conversationHistory.length > 20) {
                this.conversationHistory = this.conversationHistory.slice(-20);
            }
        }

        return pythonCode;
    }

    async executePython(code) {
        if (!window.pyodide) {
            throw new Error('Pyodide not available');
        }

        try {
            // Capture stdout
            let capturedOutput = '';

            // Set up output capturing
            await window.pyodide.runPythonAsync(`
import sys
from io import StringIO

# Create a string buffer to capture output
_ai_output_buffer = StringIO()
_original_stdout = sys.stdout
sys.stdout = _ai_output_buffer
            `);

            // Execute the Python code
            await window.pyodide.runPythonAsync(code);

            // Get captured output
            capturedOutput = await window.pyodide.runPythonAsync(`
# Get the captured output
output = _ai_output_buffer.getvalue()

# Restore original stdout
sys.stdout = _original_stdout

# Clean up
del _ai_output_buffer
del _original_stdout

output
            `);

            return capturedOutput;
        } catch (error) {
            // Restore stdout on error
            try {
                await window.pyodide.runPythonAsync(`
if '_original_stdout' in dir():
    sys.stdout = _original_stdout
                `);
            } catch (e) {
                // Ignore cleanup errors
            }

            // Re-throw with cleaned up error message
            throw new Error(error.message || String(error));
        }
    }
}

// Initialize AI assistant when page loads
document.addEventListener('DOMContentLoaded', () => {
    // Wait for Pyodide to be ready
    const initAI = () => {
        if (window.pyodide) {
            window.aiAssistant = new AIAssistant();
            console.log('AI Assistant initialized');
        } else {
            setTimeout(initAI, 500);
        }
    };

    setTimeout(initAI, 2000);
});

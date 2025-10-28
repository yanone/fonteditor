// AI Assistant for Font Editing
// Sends prompts to Anthropic Claude with Python API docs
// Executes generated Python code with error handling and retry

class AIAssistant {
    constructor() {
        this.apiKey = localStorage.getItem('anthropic_api_key') || '';
        this.messages = [];
        this.conversationHistory = [];
        this.maxRetries = 3;

        this.initUI();
    }

    initUI() {
        // Get DOM elements
        this.apiKeyInput = document.getElementById('ai-api-key');
        this.promptInput = document.getElementById('ai-prompt');
        this.sendButton = document.getElementById('ai-send-btn');
        this.clearButton = document.getElementById('ai-clear-btn');
        this.messagesContainer = document.getElementById('ai-messages');

        // Set saved API key
        if (this.apiKey) {
            this.apiKeyInput.value = this.apiKey;
        }

        // Event listeners
        this.apiKeyInput.addEventListener('change', () => {
            this.apiKey = this.apiKeyInput.value;
            localStorage.setItem('anthropic_api_key', this.apiKey);
        });

        this.sendButton.addEventListener('click', () => this.sendPrompt());

        this.clearButton.addEventListener('click', () => this.clearConversation());

        this.promptInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                this.sendPrompt();
            }
        });
    }

    addMessage(role, content, isCode = false, isCollapsible = false) {
        const messageDiv = document.createElement('div');
        messageDiv.className = `ai-message ai-message-${role}`;

        const timestamp = new Date().toLocaleTimeString();
        const roleLabel = role === 'user' ? '👤 You' : role === 'output' ? '📤 Output' : '🤖 AI';
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

        return messageDiv;
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

            // Show the generated code (collapsed by default)
            this.addMessage('assistant', pythonCode, true, true);

            // Execute the Python code and capture output
            const output = await this.executePython(pythonCode);

            // Show the output in AI chat
            if (output && output.trim()) {
                this.addMessage('output', output, false, false);
            } else {
                this.addMessage('system', 'Execution completed successfully (no output)');
            }

            // Update font dropdown if fonts were modified
            if (window.fontDropdownManager) {
                await window.fontDropdownManager.updateDropdown();
            }

        } catch (error) {
            console.error(`Attempt ${attemptNumber + 1} failed:`, error);

            // Add error message
            this.addMessage('error', `Execution error: ${error.message}`);

            // Retry with error context
            if (attemptNumber < this.maxRetries - 1) {
                this.addMessage('system', `Retrying (attempt ${attemptNumber + 2}/${this.maxRetries})...`);
                await this.executeWithRetry(originalPrompt, attemptNumber + 1, error.message);
            } else {
                throw error;
            }
        }
    }

    async callClaude(userPrompt, previousError = null, attemptNumber = 0) {
        // Get API documentation from babelfont
        let apiDocs = '';
        try {
            apiDocs = await window.pyodide.runPythonAsync(`
import babelfont
babelfont.generate_all_docs()
            `);
        } catch (error) {
            console.warn('Could not generate babelfont API docs, using fallback:', error);
            apiDocs = `API documentation not available. Use standard babelfont attributes:
- font.glyphs, font.names, font.masters, etc.
- glyph.name, glyph.width, glyph.layers
- layer.paths, layer.width
- path.nodes
- node.x, node.y, node.type`;
        }

        // Build the system prompt with API documentation
        const systemPrompt = `You are a Python code generator for a font editor using the babelfont library.

CRITICAL RULES:
1. ALWAYS use CurrentFont() and assign it to __font to get the main font object - DO NOT overwrite existing variables.
2. Generate ONLY executable Python code - no markdown, no explanations outside of code
3. Include print() statements in your code to show results to the user
4. Handle errors gracefully within your code
5. The font object is a babelfont Font instance
6. Only set data in the font object if there is a clear instruction to do so in the user prompt.

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

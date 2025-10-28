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

        this.promptInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                this.sendPrompt();
            }
        });
    }

    addMessage(role, content, isCode = false) {
        const messageDiv = document.createElement('div');
        messageDiv.className = `ai-message ai-message-${role}`;

        const timestamp = new Date().toLocaleTimeString();
        const header = `<div class="ai-message-header">${role === 'user' ? '👤 You' : '🤖 AI'} - ${timestamp}</div>`;

        let body;
        if (isCode) {
            body = `<pre class="ai-code"><code>${this.escapeHtml(content)}</code></pre>`;
        } else {
            body = `<div class="ai-message-content">${this.escapeHtml(content)}</div>`;
        }

        messageDiv.innerHTML = header + body;
        this.messagesContainer.appendChild(messageDiv);
        this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
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

            // Show the generated code
            this.addMessage('assistant', pythonCode, true);

            // Execute the Python code
            const result = await this.executePython(pythonCode);

            // Show success (output should be included in the Python code via print statements)
            if (result) {
                this.addMessage('system', 'Execution completed successfully');
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
1. ALWAYS use CurrentFont() to get the main font object - DO NOT assume a variable name
2. Generate ONLY executable Python code - no markdown, no explanations outside of code
3. Include print() statements in your code to show results to the user
4. Handle errors gracefully within your code
5. The font object is a babelfont Font instance

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

        // Build conversation messages
        const messages = [];

        // Add previous error context if retrying
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

        // Call Anthropic API
        const response = await fetch('https://api.anthropic.com/v1/messages', {
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

        return pythonCode;
    }

    async executePython(code) {
        if (!window.pyodide) {
            throw new Error('Pyodide not available');
        }

        try {
            // Execute the Python code
            const result = await window.pyodide.runPythonAsync(code);
            return result;
        } catch (error) {
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

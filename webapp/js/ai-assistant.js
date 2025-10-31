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
        this.isShowingErrorFix = false; // Flag to prevent duplicate error fix messages

        // Detect environment and set proxy URL
        this.proxyUrl = this.getProxyUrl();

        // Configure marked.js for markdown parsing
        if (typeof marked !== 'undefined') {
            marked.setOptions({
                breaks: true,
                gfm: true,
                headerIds: false,
                mangle: false
            });
        }

        this.initUI();
    }

    getProxyUrl() {
        // Use Cloudflare Worker for both local and production
        // TODO: Replace with your actual Cloudflare Worker URL after deployment
        return 'https://late-firefly-13f5.post-adf.workers.dev';
    }

    initUI() {
        // Get DOM elements
        this.apiKeyInput = document.getElementById('ai-api-key');
        this.promptInput = document.getElementById('ai-prompt');
        this.sendButton = document.getElementById('ai-send-btn');
        this.clearButton = document.getElementById('ai-clear-btn');
        this.messagesContainer = document.getElementById('ai-messages');
        this.autoRunButton = document.getElementById('ai-auto-run-btn');
        this.contextFontButton = document.getElementById('ai-context-font-btn');
        this.contextScriptButton = document.getElementById('ai-context-script-btn');
        this.isAssistantViewFocused = false;

        // Restore saved context or default to 'font'
        const savedContext = localStorage.getItem('ai_context');
        this.context = savedContext || 'font';

        // Set saved API key
        if (this.apiKey) {
            this.apiKeyInput.value = this.apiKey;
        }

        // Set context button states based on restored context
        if (this.context === 'font') {
            this.contextFontButton.classList.add('active');
            this.contextScriptButton.classList.remove('active');
        } else {
            this.contextFontButton.classList.remove('active');
            this.contextScriptButton.classList.add('active');
        }

        // Set initial placeholder text based on context
        if (this.promptInput) {
            if (this.context === 'font') {
                this.promptInput.placeholder = 'Font context: Ask me to analyze or modify your font...';
            } else {
                this.promptInput.placeholder = 'Script context: Ask me to create or modify your script...';
            }
        }

        // Update auto-run button state
        this.updateAutoRunButton();

        // Update context buttons state
        this.updateContextButtons();

        // Event listeners
        this.apiKeyInput.addEventListener('change', () => {
            this.apiKey = this.apiKeyInput.value;
            localStorage.setItem('anthropic_api_key', this.apiKey);
        });

        this.sendButton.addEventListener('click', (event) => {
            event.stopPropagation(); // Prevent view focus
            this.sendPrompt();
        });

        this.clearButton.addEventListener('click', (event) => {
            event.stopPropagation(); // Prevent view focus
            this.clearConversation();
        });

        this.autoRunButton.addEventListener('click', (event) => {
            event.stopPropagation(); // Prevent view focus
            this.toggleAutoRun();
        });

        this.contextFontButton.addEventListener('click', (event) => {
            event.stopPropagation(); // Prevent view focus
            this.setContext('font');
        });

        this.contextScriptButton.addEventListener('click', (event) => {
            event.stopPropagation(); // Prevent view focus
            this.setContext('script');
        });

        this.promptInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                // Don't send if modal is open
                const modal = document.getElementById('diff-review-modal');
                if (modal && modal.classList.contains('active')) {
                    return;
                }
                e.preventDefault(); // Prevent newline
                this.sendPrompt();
            }
        });

        // Listen for view focus events
        window.addEventListener('viewFocused', (event) => {
            this.isAssistantViewFocused = event.detail.viewId === 'view-assistant';
            this.updateAutoRunButton(); // Update button appearance based on focus
            this.updateContextButtons(); // Update context button appearance based on focus
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

            // Check if Cmd+Alt+R
            if (cmdKey && event.altKey && code === 'KeyR' && this.isAssistantViewFocused) {
                event.preventDefault();

                if (this.context === 'script') {
                    // In script context: trigger Review Changes button
                    const reviewButtons = document.querySelectorAll('.ai-review-changes-btn');
                    if (reviewButtons.length > 0) {
                        const lastButton = reviewButtons[reviewButtons.length - 1];
                        if (!lastButton.disabled) {
                            lastButton.click();
                        }
                    }
                } else {
                    // In font context: trigger Run in Console button
                    const runButtons = document.querySelectorAll('.ai-run-in-console-btn');
                    if (runButtons.length > 0) {
                        const lastButton = runButtons[runButtons.length - 1];
                        if (!lastButton.disabled) {
                            lastButton.click();
                        }
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

            // Check if Alt+R to toggle auto-run (no cmd key, and only when not in script context)
            if (!cmdKey && event.altKey && !event.shiftKey && code === 'KeyR' && this.isAssistantViewFocused) {
                event.preventDefault();
                if (this.context !== 'script') {
                    this.toggleAutoRun();
                }
            }

            // Check if Alt+F to switch to font context
            if (!cmdKey && event.altKey && !event.shiftKey && code === 'KeyF' && this.isAssistantViewFocused) {
                event.preventDefault();
                this.setContext('font');
            }

            // Check if Alt+S to switch to script context
            if (!cmdKey && event.altKey && !event.shiftKey && code === 'KeyS' && this.isAssistantViewFocused) {
                event.preventDefault();
                this.setContext('script');
            }
        });
    }

    setContext(context) {
        this.context = context;

        // Save context to localStorage
        localStorage.setItem('ai_context', context);

        // Update button states
        if (context === 'font') {
            this.contextFontButton.classList.add('active');
            this.contextScriptButton.classList.remove('active');
        } else {
            this.contextFontButton.classList.remove('active');
            this.contextScriptButton.classList.add('active');
        }

        // Update placeholder text based on context
        if (this.promptInput) {
            if (context === 'font') {
                this.promptInput.placeholder = 'Font context: Ask me to analyze or modify your font...';
            } else {
                this.promptInput.placeholder = 'Script context: Ask me to create or modify your script...';
            }
        }

        // Update button colors
        this.updateContextButtons();

        // Update Auto-Run button state
        this.updateAutoRunButton();
    }

    updateContextButtons() {
        if (!this.contextFontButton || !this.contextScriptButton) return;

        // Update font button
        if (this.contextFontButton.classList.contains('active')) {
            const fontBgColor = this.isAssistantViewFocused ? '#ff00ff' : '#660066';
            const fontBorderColor = this.isAssistantViewFocused ? '#ff00ff' : '#660066';
            this.contextFontButton.style.backgroundColor = fontBgColor;
            this.contextFontButton.style.borderColor = fontBorderColor;
            this.contextFontButton.style.color = '#1a1a1a';
        } else {
            this.contextFontButton.style.backgroundColor = 'transparent';
            this.contextFontButton.style.borderColor = 'rgba(255, 255, 255, 0.3)';
            this.contextFontButton.style.color = 'rgba(255, 255, 255, 0.8)';
        }

        // Update script button
        if (this.contextScriptButton.classList.contains('active')) {
            const scriptBgColor = this.isAssistantViewFocused ? '#9900ff' : '#4d0080';
            const scriptBorderColor = this.isAssistantViewFocused ? '#9900ff' : '#4d0080';
            this.contextScriptButton.style.backgroundColor = scriptBgColor;
            this.contextScriptButton.style.borderColor = scriptBorderColor;
            this.contextScriptButton.style.color = '#1a1a1a';
        } else {
            this.contextScriptButton.style.backgroundColor = 'transparent';
            this.contextScriptButton.style.borderColor = 'rgba(255, 255, 255, 0.3)';
            this.contextScriptButton.style.color = 'rgba(255, 255, 255, 0.8)';
        }
    }

    toggleAutoRun() {
        this.autoRun = !this.autoRun;
        localStorage.setItem('ai_auto_run', this.autoRun);
        this.updateAutoRunButton();
    }

    updateAutoRunButton() {
        if (this.autoRunButton) {
            // Disable when context is script
            if (this.context === 'script') {
                this.autoRunButton.disabled = true;
                this.autoRunButton.innerHTML = 'Auto-Run <span class="ai-button-shortcut">⌥R</span>';
                this.autoRunButton.style.backgroundColor = 'transparent';
                this.autoRunButton.style.color = 'rgba(255, 255, 255, 0.3)';
                this.autoRunButton.style.borderColor = 'rgba(255, 255, 255, 0.2)';
            } else {
                this.autoRunButton.disabled = false;

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
    }

    updateButtonShortcuts() {
        // Remove shortcuts from ALL buttons first
        const allRunButtons = document.querySelectorAll('.ai-run-in-console-btn');
        allRunButtons.forEach(btn => {
            const text = btn.textContent || btn.innerText;
            if (text.includes('Run in Console')) {
                btn.innerHTML = 'Run in Console';
            }
        });

        const allOpenButtons = document.querySelectorAll('.ai-open-in-editor-btn');
        allOpenButtons.forEach(btn => {
            const text = btn.textContent || btn.innerText;
            if (text.includes('Open in Script Editor Without Review')) {
                btn.innerHTML = 'Open in Script Editor Without Review';
            } else if (text.includes('Open in Script Editor')) {
                btn.innerHTML = 'Open in Script Editor';
            }
        });

        const allReviewButtons = document.querySelectorAll('.ai-review-changes-btn');
        allReviewButtons.forEach(btn => {
            const text = btn.textContent || btn.innerText;
            if (text.includes('Review Changes')) {
                btn.innerHTML = 'Review Changes';
            }
        });

        // Find the last message with buttons (most recent output message)
        const allMessages = document.querySelectorAll('.ai-message-output');
        if (allMessages.length === 0) return;

        const lastMessage = allMessages[allMessages.length - 1];

        // Add shortcuts ONLY to buttons in the last message
        // Check for Run in Console button (font context)
        const runButton = lastMessage.querySelector('.ai-run-in-console-btn');
        if (runButton) {
            runButton.innerHTML = 'Run in Console <span class="ai-button-shortcut">⌘⌥R</span>';
        }

        // Check for Review Changes button (script context)
        const reviewButton = lastMessage.querySelector('.ai-review-changes-btn');
        if (reviewButton) {
            reviewButton.innerHTML = 'Review Changes <span class="ai-button-shortcut">⌘⌥R</span>';
        }

        // Check for Open in Script Editor button
        const openButton = lastMessage.querySelector('.ai-open-in-editor-btn');
        if (openButton) {
            const text = openButton.textContent || openButton.innerText;
            if (text.includes('Open in Script Editor Without Review')) {
                openButton.innerHTML = 'Open in Script Editor Without Review <span class="ai-button-shortcut">⌘⌥O</span>';
            } else {
                openButton.innerHTML = 'Open in Script Editor <span class="ai-button-shortcut">⌘⌥O</span>';
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
        const roleLabel = role === 'user' ? '😀 You' : role === 'output' ? '🤖 Output' : '🤖 AI';

        // Add context tag with appropriate color
        const contextTag = this.context === 'script'
            ? '<span class="ai-context-tag ai-context-tag-script">Script</span>'
            : '<span class="ai-context-tag ai-context-tag-font">Font</span>';

        const header = `<div class="ai-message-header"><span>${roleLabel} - ${timestamp}</span>${contextTag}</div>`;

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

        // Store the original prompt content in a data attribute for user messages
        if (role === 'user') {
            messageDiv.setAttribute('data-prompt', content);
        }

        this.messagesContainer.appendChild(messageDiv);
        this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;

        // Scroll the view-content to bottom
        this.scrollToBottom();

        return messageDiv;
    }

    addReuseButtonsToOldMessages() {
        // Find all user messages that are not error tracebacks
        const allUserMessages = this.messagesContainer.querySelectorAll('.ai-message-user');
        const userMessages = Array.from(allUserMessages).filter(msg => !msg.hasAttribute('data-error-traceback'));

        if (userMessages.length === 0) return;

        // Add reuse buttons to ALL user messages (including the last one)
        for (let i = 0; i < userMessages.length; i++) {
            const messageDiv = userMessages[i];

            // Check if button already exists
            if (messageDiv.querySelector('.ai-reuse-prompt-btn')) continue;

            // Get the stored prompt
            const prompt = messageDiv.getAttribute('data-prompt');
            if (!prompt) continue;

            // Create buttons container with both reuse and copy buttons
            const reuseId = 'reuse-' + Date.now() + '-' + i + '-' + Math.random().toString(36).substr(2, 9);
            const copyId = 'copy-' + Date.now() + '-' + i + '-' + Math.random().toString(36).substr(2, 9);
            const buttonDiv = document.createElement('div');
            buttonDiv.className = 'ai-reuse-prompt-container';
            buttonDiv.innerHTML = `
                <button class="ai-reuse-prompt-btn" id="${reuseId}">↻ Reuse prompt</button>
                <button class="ai-copy-prompt-btn" id="${copyId}">📋 Copy prompt</button>
            `;

            // Add buttons after the content
            const contentDiv = messageDiv.querySelector('.ai-message-content');
            if (contentDiv) {
                messageDiv.appendChild(buttonDiv);

                // Add click handler for reuse button
                const reuseBtn = document.getElementById(reuseId);
                if (reuseBtn) {
                    reuseBtn.addEventListener('click', (event) => {
                        event.stopPropagation(); // Prevent view focus

                        this.promptInput.value = prompt;
                        this.promptInput.focus();

                        // Manually activate assistant view after focusing input
                        if (window.focusView) {
                            window.focusView('view-assistant');
                        }

                        // Play a subtle click sound if available
                        if (window.playSound) {
                            window.playSound('click');
                        }
                    });
                }

                // Add click handler for copy button
                const copyBtn = document.getElementById(copyId);
                if (copyBtn) {
                    copyBtn.addEventListener('click', async (event) => {
                        event.stopPropagation(); // Prevent view focus

                        try {
                            await navigator.clipboard.writeText(prompt);

                            // Show feedback
                            const originalText = copyBtn.innerHTML;
                            copyBtn.innerHTML = '✓ Copied!';
                            setTimeout(() => {
                                copyBtn.innerHTML = originalText;
                            }, 2000);

                            // Play a subtle click sound if available
                            if (window.playSound) {
                                window.playSound('click');
                            }
                        } catch (err) {
                            console.error('Failed to copy text:', err);
                            copyBtn.innerHTML = '✗ Failed';
                            setTimeout(() => {
                                copyBtn.innerHTML = '📋 Copy prompt';
                            }, 2000);
                        }
                    });
                }
            }
        }
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

    addOutputWithCode(output, code, markdownText = '', showRunButton = false) {
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

        // Add context tag with appropriate color
        const contextTag = this.context === 'script'
            ? '<span class="ai-context-tag ai-context-tag-script">Script</span>'
            : '<span class="ai-context-tag ai-context-tag-font">Font</span>';

        const header = `
            <div class="ai-message-header">
                <span>👽 Assistant - ${timestamp}</span>
                <div class="ai-message-header-right">
                    ${contextTag}
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
                </div>
            </div>`;

        // Show appropriate buttons based on context
        let buttonContainerHtml = '';
        if (this.context === 'script') {
            // Script context: show both Review Changes and Open in Script Editor buttons
            const directOpenBtnId = 'direct-open-' + Date.now() + Math.random().toString(36).substr(2, 9);
            buttonContainerHtml = `
                <div class="ai-button-group">
                    <button class="ai-review-changes-btn" id="${openBtnId}">Review Changes</button>
                    <button class="ai-open-in-editor-btn" id="${directOpenBtnId}">Open in Script Editor Without Review</button>
                </div>`;
        } else if (showRunButton) {
            // Font context: show both buttons
            buttonContainerHtml = `
                <div class="ai-button-group">
                    <button class="ai-open-in-editor-btn" id="${openBtnId}">Open in Script Editor</button>
                    <button class="ai-run-in-console-btn" id="${runBtnId}">Run in Console</button>
                </div>`;
        }

        // Show markdown explanation if present
        const markdownHtml = markdownText && markdownText.trim() ?
            `<div class="ai-markdown-explanation">${this.formatMarkdown(markdownText)}</div>` : '';

        // Show Python output if present
        const outputHtml = output && output.trim() ?
            `<div class="ai-python-output">${this.escapeHtml(output)}</div>` : '';

        const body = `
            <div class="ai-output-with-code">
                <pre class="ai-code collapsed" id="${codeId}"><code>${this.escapeHtml(code)}</code></pre>
                ${markdownHtml}
                ${outputHtml}
                ${buttonContainerHtml}
            </div>`;

        messageDiv.innerHTML = header + body;
        this.messagesContainer.appendChild(messageDiv);
        this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;

        // Add event listeners for buttons if they exist
        const openBtn = document.getElementById(openBtnId);
        if (openBtn) {
            if (this.context === 'script') {
                // In script context, this is the Review Changes button
                openBtn.addEventListener('click', (event) => {
                    event.stopPropagation(); // Prevent view focus
                    this.showDiffReview(code, markdownText);
                });
            } else {
                // In font context, open directly in editor
                openBtn.addEventListener('click', (event) => {
                    event.stopPropagation(); // Prevent view focus
                    this.openCodeInEditor(code);
                });
            }
        }

        // Handle direct open button in script context
        if (this.context === 'script') {
            const directOpenBtnId = messageDiv.querySelector('.ai-button-group .ai-open-in-editor-btn')?.id;
            const directOpenBtn = document.getElementById(directOpenBtnId);
            if (directOpenBtn) {
                directOpenBtn.addEventListener('click', (event) => {
                    event.stopPropagation(); // Prevent view focus
                    this.openCodeInEditor(code);
                });
            }
        }

        if (showRunButton && this.context !== 'script') {
            const runBtn = document.getElementById(runBtnId);
            if (runBtn) {
                runBtn.addEventListener('click', async (event) => {
                    event.stopPropagation(); // Prevent view focus
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
            window.term.echo('---');
            window.term.echo('🚀 Running assistant-generated code...');
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

    showDiffReview(newCode, markdownText = '') {
        // Get current code from script editor
        const oldCode = (window.scriptEditor && window.scriptEditor.editor)
            ? window.scriptEditor.editor.getValue()
            : '';

        // Store new code for later use
        this.pendingCode = newCode;

        // Generate unified diff using jsdiff
        const diff = Diff.createPatch('script.py', oldCode, newCode, 'Current', 'Proposed');

        // Get modal elements
        const modal = document.getElementById('diff-review-modal');
        const diffContainer = document.getElementById('diff-container');
        const explanationContainer = document.getElementById('diff-explanation');
        const closeBtn = document.getElementById('diff-modal-close-btn');
        const cancelBtn = document.getElementById('diff-cancel-btn');
        const acceptBtn = document.getElementById('diff-accept-btn');

        // Render diff with diff2html
        const configuration = {
            drawFileList: false,
            matching: 'lines',
            outputFormat: 'side-by-side',
            renderNothingWhenEmpty: false,
            synchronisedScroll: true,
        };

        const diff2htmlUi = new Diff2HtmlUI(diffContainer, diff, configuration);
        diff2htmlUi.draw();
        diff2htmlUi.synchronisedScroll();

        // Display markdown explanation if present
        if (markdownText && markdownText.trim()) {
            explanationContainer.innerHTML = this.formatMarkdown(markdownText);
            explanationContainer.style.display = 'block';
        } else {
            explanationContainer.style.display = 'none';
        }

        // Show modal
        modal.classList.add('active');

        // Close handlers
        const closeModal = () => {
            modal.classList.remove('active');
            this.pendingCode = null;
        };

        const handleKeydown = (e) => {
            // Escape to close
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                closeModal();
                document.removeEventListener('keydown', handleKeydown);
                modal.removeEventListener('keydown', handleKeydown);
            }
            // Cmd+Enter to accept
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                this.openCodeInEditor(this.pendingCode);
                closeModal();
                document.removeEventListener('keydown', handleKeydown);
                modal.removeEventListener('keydown', handleKeydown);
            }
        };

        // Set up event listeners (remove old ones first to prevent duplicates)
        const newCloseBtn = closeBtn.cloneNode(true);
        closeBtn.parentNode.replaceChild(newCloseBtn, closeBtn);
        newCloseBtn.addEventListener('click', closeModal);

        const newCancelBtn = cancelBtn.cloneNode(true);
        cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);
        newCancelBtn.addEventListener('click', closeModal);

        const newAcceptBtn = acceptBtn.cloneNode(true);
        acceptBtn.parentNode.replaceChild(newAcceptBtn, acceptBtn);
        newAcceptBtn.addEventListener('click', () => {
            this.openCodeInEditor(this.pendingCode);
            closeModal();
        });

        document.addEventListener('keydown', handleKeydown);
        modal.addEventListener('keydown', handleKeydown);

        // Close on backdrop click
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                closeModal();
            }
        });
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    formatMarkdown(text) {
        if (!text || !text.trim()) {
            return '';
        }

        // Use marked.js for professional markdown parsing
        if (typeof marked !== 'undefined') {
            try {
                return marked.parse(text);
            } catch (error) {
                console.error('Markdown parsing error:', error);
                // Fallback to escaped text if parsing fails
                return this.escapeHtml(text).replace(/\n/g, '<br>');
            }
        }

        // Fallback if marked.js is not loaded
        console.warn('marked.js not loaded, using fallback');
        return this.escapeHtml(text).replace(/\n/g, '<br>');
    }

    addErrorFixMessage(errorTraceback, scriptCode) {
        // Check if we're already showing or about to show an error fix message
        if (this.isShowingErrorFix) {
            // Just update the traceback for the existing/pending message
            this.currentErrorTraceback = errorTraceback;
            return;
        }

        // Check if the last message is already an error fix message
        const allMessages = this.messagesContainer.querySelectorAll('.ai-message');
        const lastMessage = allMessages.length > 0 ? allMessages[allMessages.length - 1] : null;

        if (lastMessage && lastMessage.classList.contains('ai-message-error-fix')) {
            // Update the existing message with new traceback and make it blink again
            this.currentErrorTraceback = errorTraceback;

            // Delay to avoid overlap with error sound (same delay as first time)
            setTimeout(() => {
                // Remove and re-add the animation class to restart it
                lastMessage.classList.remove('ai-message-error-fix');
                void lastMessage.offsetWidth; // Force reflow
                lastMessage.classList.add('ai-message-error-fix');

                // Play attention sound
                if (window.playSound) {
                    window.playSound('attention');
                }

                // Scroll to bottom
                this.scrollToBottom();
            }, 2500); // Same delay as first time to avoid sound overlap

            return;
        }

        // Set flag to prevent duplicates
        this.isShowingErrorFix = true;

        // Store the current error traceback
        this.currentErrorTraceback = errorTraceback;

        // Delay showing the message by 1.5 seconds + estimated sound duration (attention.wav ~1 second)
        setTimeout(() => {
            // Show messages container
            if (this.messagesContainer.style.display === 'none' || !this.messagesContainer.style.display) {
                this.messagesContainer.style.display = 'block';
            }

            const messageDiv = document.createElement('div');
            messageDiv.className = 'ai-message ai-message-error-fix';

            const timestamp = new Date().toLocaleTimeString();
            const fixBtnId = 'fix-' + Date.now() + Math.random().toString(36).substr(2, 9);

            const header = `<div class="ai-message-header">⚠️ Script Error - ${timestamp}</div>`;

            const body = `
                <div class="ai-error-fix-content">
                    <div class="ai-error-fix-text">
                        <p><strong>An error occurred while running your script.</strong></p>
                        <p>Would you like me to analyze the error and suggest a fix?</p>
                    </div>
                    <button class="ai-fix-code-btn" id="${fixBtnId}">Fix Code</button>
                </div>`;

            messageDiv.innerHTML = header + body;
            this.messagesContainer.appendChild(messageDiv);
            this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;

            // Clear the flag now that the message is actually shown
            this.isShowingErrorFix = false;

            // Play attention sound
            if (window.playSound) {
                window.playSound('attention');
            }

            // Scroll to bottom
            this.scrollToBottom();

            // Add event listener to fix button
            const fixBtn = document.getElementById(fixBtnId);
            if (fixBtn) {
                fixBtn.addEventListener('click', (event) => {
                    event.stopPropagation(); // Prevent view focus initially

                    // Use the latest stored traceback
                    const latestTraceback = this.currentErrorTraceback;

                    // Remove the error message from UI and clear the flag
                    messageDiv.remove();
                    this.isShowingErrorFix = false;

                    // Switch to script context
                    this.setContext('script');

                    // Switch to assistant view (explicitly after context switch)
                    if (window.focusView) {
                        window.focusView('view-assistant');
                    }

                    // Construct the prompt with error information
                    const prompt = `The script produced an error. Please analyze and fix it, but don't refactor any other parts of the code.\n\nError traceback:\n\`\`\`\n${latestTraceback}\n\`\`\``;

                    // Add a custom user message with traceback displayed as code block
                    this.addErrorTracebackMessage(latestTraceback);

                    // Play message sent sound
                    if (window.playSound) {
                        window.playSound('message_sent');
                    }

                    // Clear input and disable controls
                    this.promptInput.value = '';
                    this.promptInput.disabled = true;
                    this.sendButton.disabled = true;

                    // Show typing indicator
                    this.showTypingIndicator();

                    // Execute directly without adding another user message
                    setTimeout(async () => {
                        try {
                            await this.executeWithRetry(prompt, 0);
                        } catch (error) {
                            this.addMessage('error', `Failed after ${this.maxRetries} attempts: ${error.message}`);
                        } finally {
                            // Hide typing indicator
                            this.hideTypingIndicator();

                            this.promptInput.disabled = false;
                            this.sendButton.disabled = false;
                            this.promptInput.focus();
                        }
                    }, 100);
                });
            }
        }, 2500); // 1500ms delay + ~1000ms for attention sound
    }

    addErrorTracebackMessage(errorTraceback) {
        // Show messages container
        if (this.messagesContainer.style.display === 'none' || !this.messagesContainer.style.display) {
            this.messagesContainer.style.display = 'block';
        }

        const messageDiv = document.createElement('div');
        messageDiv.className = 'ai-message ai-message-user ai-message-error-traceback';

        const timestamp = new Date().toLocaleTimeString();

        // Add context tag
        const contextTag = this.context === 'script'
            ? '<span class="ai-context-tag ai-context-tag-script">Script</span>'
            : '<span class="ai-context-tag ai-context-tag-font">Font</span>';

        const header = `<div class="ai-message-header"><span>😀 You - ${timestamp}</span>${contextTag}</div>`;

        // Format as markdown for consistent styling with assistant messages
        const markdownContent = `The script produced an error. Please analyze and fix it, but don't refactor any other parts of the code.

**Error traceback:**

\`\`\`
${errorTraceback}
\`\`\``;

        const body = `<div class="ai-markdown-explanation">${this.formatMarkdown(markdownContent)}</div>`;

        messageDiv.innerHTML = header + body;

        // Mark this as an error traceback message (don't add reuse button to these)
        messageDiv.setAttribute('data-error-traceback', 'true');

        this.messagesContainer.appendChild(messageDiv);
        this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;

        // Scroll the view-content to bottom
        this.scrollToBottom();

        return messageDiv;
    }

    showTypingIndicator() {
        // Remove any existing typing indicator first
        this.hideTypingIndicator();

        const typingDiv = document.createElement('div');
        typingDiv.className = 'ai-typing-indicator';
        typingDiv.id = 'ai-typing-indicator';
        typingDiv.innerHTML = `
            <span>Assistant is thinking</span>
            <div class="ai-typing-dots">
                <div class="ai-typing-dot"></div>
                <div class="ai-typing-dot"></div>
                <div class="ai-typing-dot"></div>
            </div>
        `;

        this.messagesContainer.appendChild(typingDiv);
        this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
        this.scrollToBottom();
    }

    hideTypingIndicator() {
        const typingIndicator = document.getElementById('ai-typing-indicator');
        if (typingIndicator) {
            typingIndicator.remove();
        }
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

        // Show typing indicator
        this.showTypingIndicator();

        try {
            await this.executeWithRetry(prompt, 0);
        } catch (error) {
            this.addMessage('error', `Failed after ${this.maxRetries} attempts: ${error.message}`);
        } finally {
            // Hide typing indicator
            this.hideTypingIndicator();

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
            // Get Python code and markdown from Claude
            const { pythonCode, markdownText } = await this.callClaude(originalPrompt, previousError, attemptNumber);

            // In script context, never auto-run - only show code with "Open in Script Editor" button
            if (this.context === 'script') {
                // Script mode: Just show the code, no execution
                this.addOutputWithCode('', pythonCode, markdownText, false);

                // Play incoming message sound
                if (window.playSound) {
                    window.playSound('incoming_message');
                }
            } else if (this.autoRun) {
                // Font mode with auto-run: Execute the Python code and capture output
                const output = await this.executePython(pythonCode);

                // Show output with collapsible code and run button
                this.addOutputWithCode(output, pythonCode, markdownText, true);

                // Play incoming message sound
                if (window.playSound) {
                    window.playSound('incoming_message');
                }

                // Update font dropdown if fonts were modified
                if (window.fontDropdownManager) {
                    await window.fontDropdownManager.updateDropdown();
                }
            } else {
                // Font mode, manual: Just show the code with a run button
                this.addOutputWithCode('', pythonCode, markdownText, true);

                // Play incoming message sound
                if (window.playSound) {
                    window.playSound('incoming_message');
                }
            }

            // Add reuse buttons to previous user messages now that we have a response
            this.addReuseButtonsToOldMessages();

        } catch (error) {
            console.error(`Attempt ${attemptNumber + 1} failed:`, error);

            // Add error message
            this.addMessage('error', `Execution error: ${error.message}`);

            // Only retry in font mode with auto-run (never retry in script context since we don't execute)
            if (this.context !== 'script' && this.autoRun && attemptNumber < this.maxRetries - 1) {
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

        // Build context-specific instructions
        const contextInstructions = this.context === 'script'
            ? `CONTEXT: SCRIPT EDITING MODE
You are helping to improve and modify Python scripts that will be run inside the font editor using the babelfont library. The user has an existing script open in their editor that they want to enhance or modify or fix, or the script may also be empty still.

PRIMARY FOCUS:
- Write Python scripts from scratch or improve existing ones
- Add new functionality to scripts only when explicitly requested
- Refactor and optimize code only when explicitly requested
- Fix errors in existing scripts when provided with error tracebacks
- Adapt code to babelfont API changes (see API docs below)
- Help write complete, reusable scripts
- Scripts should be designed to work on fonts using the babelfont library

CRITICAL RULES FOR SCRIPT MODE:
1. Generate complete, standalone Python scripts that can be saved and reused
2. ALWAYS use CurrentFont() and assign it to the "font" variable to get the main font object
3. Scripts should be self-contained and well-documented
4. Include proper error handling and user feedback via print statements
5. The babelfont API documentation below is provided for reference when writing scripts
6. Only refactor code when explicitly requested by the user. When fixing errors, only change the parts that are necessary to fix the error
`


            : `CONTEXT: FONT EDITING MODE
You are working directly on the user's currently open font. Generate Python code that will be executed immediately on the active font using the babelfont library.

CRITICAL RULES FOR FONT MODE:
1. ALWAYS use CurrentFont() and assign it to the "font" variable to get the main font object
2. Only set data in the font object if there is a clear instruction to do so in the user prompt, otherwise just read or analyze data
3. Code will be executed immediately - keep it focused and efficient
4. Always include a summary print statement at the end indicating what was done`;

        // Build the system prompt with API documentation
        const systemPrompt = `You are a Python code generator for a font editor using the babelfont library.

${contextInstructions}

GENERAL RULES (APPLY TO BOTH CONTEXTS):
1. Python code MUST be wrapped in one single \`\`\`python code block
2. You may include explanations in markdown format outside the code block
3. Include print() statements in your code to show results to the user
4. Handle errors gracefully within your code
5. The font object is a babelfont Font instance
6. Annotate the code with comments
7. Never return single-line Python comments. If you want to return just a comment, wrap it in a print statement anyway so the user gets to see it
8. Always include a summary of the user prompt in the first line of the code as a comment (max 40 characters, pose as a command, not a question), followed by a line with the most important keywords describing the most important concepts touched in the code (line starts with "Keywords: ", see below list for eligible keywords), followed by an empty line, followed by one or several comment lines explaining briefly what the script does. Cap the description at 40 characters per line
9. Always include an explanation of the code in markdown format outside the code block
10. Answer in the language used in the user prompt in the Python code and the markdown explanation
11. About the keywords line: Only use keywords that are actually relevant to the user prompt, not keywords of concepts that were used in the code as a means to get there or for filtering. Example: When a user wants to change anchors, only list "anchors" as a keyword while ignoring the keywords "glyphs" and "layers".

Example for file header:

\`\`\`python
# Make all glyphs 10 % wider
# Keywords: metrics
#
# This script iterates through all glyphs in the current font
# and increases their width by 10 %. It also adjusts the x
# coordinates of all nodes in each layer accordingly.
\`\`\`

Eligible keyword are:
glyphs, layers, paths, nodes, anchors, components, metrics, names, masters, unicode, kerning, groups, features, guidelines

BABELFONT API DOCUMENTATION:
${apiDocs}

CHANGELOG to API:
Oct. 23rd 2025:
- Layer.anchor_objects changed to Layer.anchors

EXAMPLE OPERATIONS:
${this.context === 'font' ? `# Make all glyphs 10% wider (FONT MODE)
font = CurrentFont()
for glyph in font.glyphs:
    for layer in glyph.layers:
        layer.width = layer.width * 1.1
        for path in layer.paths:
            for node in path.nodes:
                node.x = node.x * 1.1
print(f"Made {len(font.glyphs)} glyphs 10% wider")

# List all glyph names (FONT MODE)
font = CurrentFont()
print(f"Font has {len(font.glyphs)} glyphs:")
for glyph in font.glyphs:
    print(f"  - {glyph.name}")` : `# Example script for batch processing (SCRIPT MODE)
import babelfont

def process_font(font_path):
    font = babelfont.load(font_path)
    # Process the font
    print(f"Processing {font.names.familyName}")
    # Your modifications here
    return font

# This is a script that can be saved and reused`}

Generate Python code for: ${userPrompt}`;

        // Build conversation messages with full conversation history
        const messages = [...this.conversationHistory];

        // Add current prompt (or retry with error context) with context information
        const contextPrefix = `[Context: ${this.context === 'script' ? 'Script Editing' : 'Font Editing'}]\n\n`;

        // In script context, include the current script editor content
        let fullPrompt = userPrompt;
        if (this.context === 'script' && window.scriptEditor && window.scriptEditor.editor) {
            const currentScript = window.scriptEditor.editor.getValue();
            if (currentScript && currentScript.trim()) {
                fullPrompt = `Current script in editor:\n\`\`\`python\n${currentScript}\n\`\`\`\n\nUser request: ${userPrompt}`;
            }
        }

        if (previousError && attemptNumber > 0) {
            messages.push({
                role: 'user',
                content: `${contextPrefix}${fullPrompt}\n\nPrevious attempt ${attemptNumber} failed with error:\n${previousError}\n\nPlease fix the code and try again.`
            });
        } else {
            messages.push({
                role: 'user',
                content: `${contextPrefix}${fullPrompt}`
            });
        }

        // Call Anthropic API through proxy (local or Cloudflare Worker)
        const model = 'claude-sonnet-4-5-20250929';
        const response = await fetch(this.proxyUrl, {
            method: 'POST',
            headers: {
                'x-api-key': this.apiKey,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                model: model,
                max_tokens: 8192,
                system: systemPrompt,
                messages: messages
            })
        });

        // Log the full prompt to console for debugging
        console.group('👽 AI Prompt Sent to Claude');
        console.log('System Prompt:', systemPrompt);
        console.log('Messages:', messages);
        console.log('Model:', model);
        console.groupEnd();

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(`API error: ${errorData.error?.message || response.statusText}`);
        }

        const data = await response.json();

        // Extract Python code and markdown from response
        const fullResponse = data.content[0].text;
        let pythonCode = '';
        let markdownText = fullResponse;

        // Extract code from ```python code blocks
        const codeBlockRegex = /```python\s*\n([\s\S]*?)```/g;
        const matches = fullResponse.matchAll(codeBlockRegex);

        for (const match of matches) {
            pythonCode += match[1];
        }

        // If no python blocks found, try generic code blocks
        if (!pythonCode.trim()) {
            const genericCodeBlockRegex = /```\s*\n([\s\S]*?)```/g;
            const genericMatches = fullResponse.matchAll(genericCodeBlockRegex);

            for (const match of genericMatches) {
                pythonCode += match[1];
            }
        }

        pythonCode = pythonCode.trim();

        // Remove code blocks from markdown text, leaving only the explanations
        markdownText = markdownText.replace(/```python\s*\n[\s\S]*?```/g, '').replace(/```\s*\n[\s\S]*?```/g, '').trim();

        // Add to conversation history (only if not a retry)
        if (!previousError || attemptNumber === 0) {
            const contextPrefix = `[Context: ${this.context === 'script' ? 'Script Editing' : 'Font Editing'}]\n\n`;
            this.conversationHistory.push({
                role: 'user',
                content: `${contextPrefix}${userPrompt}`
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

        return { pythonCode, markdownText };
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

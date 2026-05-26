// AI Agent for Font Editing Knowledge
// Streaming multi-round tool calling entirely on the client.
// Each round is one streaming request per tool-call cycle.
// Tools and instructions live in agent-config.ts.

import { resolveWebsiteURL } from './website-url';
import { Logger } from './logger';
import { AGENT_TOOLS, AGENT_SYSTEM_PROMPT, UsageMetrics } from './agent-config';
import tippy from 'tippy.js';
import 'tippy.js/dist/tippy.css';
import { getTheme } from './tippy-utils';
import { getFeatureDescription } from './opentype-features';

const console = new Logger('AIAgent');

class AIAgent {
    [key: string]: any;

    messagesContainer: HTMLElement | null;
    promptInput: HTMLTextAreaElement | null;
    sendButton: HTMLElement | null;
    chatContainer: HTMLElement | null;
    loginContainer: HTMLElement | null;
    subscriptionContainer: HTMLElement | null;

    isAuthenticated: boolean;
    subscription: any;
    isStreaming: boolean;
    abortController: AbortController | null;
    messages: Array<{ role: string; content: string }>;
    conversationMessages: Array<any>;
    roundUsage: UsageMetrics[];
    sessionTotals: UsageMetrics;

    constructor() {
        this.messagesContainer = null;
        this.promptInput = null;
        this.sendButton = null;
        this.chatContainer = null;
        this.loginContainer = null;
        this.subscriptionContainer = null;
        this.isAuthenticated = false;
        this.subscription = null;
        this.isStreaming = false;
        this.abortController = null;
        this.messages = [];
        this.conversationMessages = [];
        this.roundUsage = [];
        this.sessionTotals = {};

        this.initUI();
        this.checkAuthenticationStatus();
    }

    getWebsiteURL() {
        return resolveWebsiteURL();
    }

    async checkAuthenticationStatus() {
        if (!window.authManager) {
            setTimeout(() => this.checkAuthenticationStatus(), 100);
            return;
        }
        const originalCallback = window.authManager.onAuthStateChanged;
        window.authManager.onAuthStateChanged = (
            isAuthenticated: boolean,
            user: any,
            subscription: any
        ) => {
            this.isAuthenticated = isAuthenticated;
            this.subscription = subscription;
            this.updateAuthUI();
            if (originalCallback)
                originalCallback.call(
                    window.authManager,
                    isAuthenticated,
                    user,
                    subscription
                );
        };
        const user = await window.authManager.checkAuthStatus();
        this.isAuthenticated = !!user;
        this.subscription = window.authManager.subscription;
        this.updateAuthUI();
    }

    updateAuthUI() {
        const chatContainer = document.getElementById('agent-chat-container');
        const loginContainer = document.getElementById('agent-login-container');
        const subscriptionContainer = document.getElementById(
            'agent-subscription-container'
        );
        if (!chatContainer || !loginContainer || !subscriptionContainer) return;

        if (!this.isAuthenticated) {
            chatContainer.style.display = 'none';
            loginContainer.style.display = 'flex';
            subscriptionContainer.style.display = 'none';
        } else if (!this.subscription || !this.subscription.isAdvanced) {
            chatContainer.style.display = 'none';
            loginContainer.style.display = 'none';
            subscriptionContainer.style.display = 'flex';
        } else {
            chatContainer.style.display = 'flex';
            loginContainer.style.display = 'none';
            subscriptionContainer.style.display = 'none';
        }
    }

    initUI() {
        this.promptInput = document.getElementById(
            'agent-prompt'
        ) as HTMLTextAreaElement | null;
        this.sendButton = document.getElementById('agent-send-btn');
        this.messagesContainer = document.getElementById('agent-messages');
        this.chatContainer = document.getElementById('agent-chat-container');
        this.loginContainer = document.getElementById('agent-login-container');
        this.subscriptionContainer = document.getElementById(
            'agent-subscription-container'
        );
        if (!this.sendButton || !this.promptInput || !this.messagesContainer) {
            console.warn('Agent UI elements not found');
            return;
        }

        this.sendButton.addEventListener('click', (e: Event) => {
            e.stopPropagation();
            this.sendPrompt();
        });
        this.promptInput.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                this.sendPrompt();
            }
        });

        const loginBtn = document.getElementById('agent-login-btn');
        if (loginBtn)
            loginBtn.addEventListener('click', () => {
                window.location.href =
                    this.getWebsiteURL() +
                    '/login?returnTo=' +
                    encodeURIComponent(window.location.href);
            });

        const accountBtn = document.getElementById('agent-account-btn');
        if (accountBtn)
            accountBtn.addEventListener('click', () => {
                window.location.href =
                    this.getWebsiteURL() +
                    '/account?returnTo=' +
                    encodeURIComponent(window.location.href);
            });

        document
            .getElementById('agent-new-chat-btn')
            ?.addEventListener('click', () => this.newChat());

        document
            .getElementById('agent-stop-btn')
            ?.addEventListener('click', () => {
                if (this.abortController) {
                    this.abortController.abort();
                    this.abortController = null;
                }
            });

        this.promptInput.addEventListener('input', () => {
            this.promptInput!.style.height = 'auto';
            this.promptInput!.style.height =
                Math.min(this.promptInput!.scrollHeight, 120) + 'px';
        });

        this.setupInfoModal();
    }

    setupInfoModal() {
        const btn = document.getElementById('agent-info-btn');
        const modal = document.getElementById('agent-info-modal');
        const close = document.getElementById('agent-info-modal-close-btn');
        const content = document.getElementById('agent-info-modal-content');
        if (!btn || !modal || !close || !content) return;

        // Populate content from AGENT_TOOLS
        content.innerHTML = AGENT_TOOLS.map(
            (tool) => `
                <div class="ai-info-section" style="margin-bottom: 16px">
                    <h4 style="font-size:14px;margin:0 0 4px 0;color:var(--text-primary);font-weight:600">
                        ${tool.function.name}
                    </h4>
                    <div style="margin:0 0 8px 0;font-size:12px;color:var(--text-tertiary);line-height:1.5">
                        ${typeof marked !== 'undefined' ? marked.parse(tool.function.description) : tool.function.description}
                    </div>
                    ${
                        Object.keys(tool.function.parameters?.properties || {})
                            .length > 0
                            ? `<div style="font-size:11px;color:var(--text-faint)">
                                <strong>Parameters:</strong>
                                ${Object.entries(
                                    tool.function.parameters?.properties || {}
                                )
                                    .map(
                                        ([name, prop]: [string, any]) =>
                                            `<code style="background:var(--background-hover);padding:1px 4px;border-radius:3px">${name}</code>`
                                    )
                                    .join(' ')}
                               </div>`
                            : '<div style="font-size:11px;color:var(--text-faint)"><em>No parameters</em></div>'
                    }
                </div>
            `
        ).join('');

        // Open
        btn.addEventListener('click', (e: Event) => {
            e.stopPropagation();
            modal.style.display = 'flex';
        });

        // Close
        const closeModal = () => {
            modal.style.display = 'none';
        };
        close.addEventListener('click', closeModal);

        // Close on backdrop click
        modal.addEventListener('click', (e: Event) => {
            if (e.target === modal) closeModal();
        });

        // Close on Escape
        document.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Escape' && modal.style.display === 'flex') {
                e.preventDefault();
                e.stopPropagation();
                closeModal();
            }
        });
    }

    addMessage(role: 'user' | 'agent' | 'error', content: string) {
        if (!this.messagesContainer) return;
        const msgDiv = document.createElement('div');
        msgDiv.className = `agent-message agent-message-${role}`;
        msgDiv.style.whiteSpace = 'pre-wrap';
        const header = document.createElement('div');
        header.className = 'agent-message-header';
        if (role === 'user') {
            header.innerHTML =
                '<span class="material-symbols-outlined">person</span> You';
            msgDiv.appendChild(header);
            msgDiv.appendChild(document.createTextNode(content));
        } else if (role === 'agent') {
            header.innerHTML =
                '<span class="material-symbols-outlined">robot_2</span> Agent';
            msgDiv.appendChild(header);
            const body = document.createElement('div');
            if (typeof marked !== 'undefined')
                body.innerHTML = marked.parse(content);
            else body.textContent = content;
            msgDiv.appendChild(body);
        } else {
            header.innerHTML =
                '<span class="material-symbols-outlined">error</span> Error';
            msgDiv.appendChild(header);
            msgDiv.appendChild(document.createTextNode(content));
        }
        this.messagesContainer.appendChild(msgDiv);
        this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
    }

    async executeToolCall(toolCall: any): Promise<string> {
        const { name, arguments: argsStr } = toolCall.function;
        const args = JSON.parse(argsStr || '{}');
        switch (name) {
            case 'handbook_toc':
                return await this.fetchText('/handbook/README.md');
            case 'handbook_topic': {
                const topic = args.topic;
                if (!topic)
                    throw new Error('Missing required parameter: topic');
                const clean = topic.replace(/\.\.\//g, '').replace(/^\/+/, '');
                if (!clean.endsWith('.md'))
                    throw new Error('Only .md files can be accessed');
                return await this.fetchText(`/handbook/${clean}`);
            }
            case 'python_api_docs': {
                let res = await fetch('/API.md').catch(() => null);
                if (!res || !res.ok)
                    res = await fetch(
                        `${this.getWebsiteURL()}/data/api-docs.md`
                    );
                if (!res.ok) throw new Error('API documentation not found');
                return await res.text();
            }
            case 'list_available_fonts': {
                const pluginRegistry = (window as any).pluginRegistry;
                if (!pluginRegistry) return 'Plugin registry not available.';

                const plugins = pluginRegistry.getAll() || [];
                const results: string[] = [];
                const messages: string[] = [];
                const fontExtensions = [
                    '.babelfont',
                    '.glyphs',
                    '.vfj',
                    '.sfd',
                    '.designspace'
                ];

                for (const plugin of plugins) {
                    const pluginId = plugin.getId();
                    const pluginName = plugin.getName?.() || pluginId;
                    const adapter = plugin.getAdapter();
                    if (!adapter) continue;

                    // Check plugin readiness with contextual messages
                    if (pluginId === 'disk') {
                        const hasDir =
                            typeof adapter.hasDirectory === 'function' &&
                            adapter.hasDirectory();
                        if (!hasDir) {
                            messages.push(
                                `⚠️ **${pluginName}**: No folder linked yet. Open the file browser and select a folder to enable disk access.`
                            );
                            continue;
                        }
                        const perm =
                            typeof adapter.checkPermission === 'function'
                                ? await adapter.checkPermission()
                                : 'granted';
                        if (perm !== 'granted') {
                            messages.push(
                                `⚠️ **${pluginName}**: Folder access expired. Re-enable access in the file browser to continue.`
                            );
                            continue;
                        }
                    }

                    const scanPath = plugin.getDefaultPath?.() || '/';

                    try {
                        const files = await adapter.scanDirectory(scanPath);
                        let found = 0;
                        for (const [name, info] of Object.entries(files)) {
                            const fileInfo = info as {
                                is_dir: boolean;
                                path: string;
                            };
                            const filePath = fileInfo.path || `/${name}`;
                            const lowerName = name.toLowerCase();
                            if (fileInfo.is_dir) {
                                if (
                                    lowerName.endsWith('.glyphspackage') ||
                                    lowerName.endsWith('.ufo')
                                ) {
                                    results.push(
                                        `${name} — ${pluginId}:///${filePath.replace(/^\//, '')}`
                                    );
                                    found++;
                                }
                                continue;
                            }
                            if (
                                fontExtensions.some((ext) =>
                                    lowerName.endsWith(ext)
                                )
                            ) {
                                results.push(
                                    `${name} — ${pluginId}:///${filePath.replace(/^\//, '')}`
                                );
                                found++;
                            }
                        }
                        if (found === 0) {
                            messages.push(
                                `📂 **${pluginName}**: No font files found.`
                            );
                        }
                    } catch {
                        messages.push(
                            `⚠️ **${pluginName}**: Could not scan — plugin may need setup.`
                        );
                    }
                }

                const output: string[] = [];
                if (results.length > 0) {
                    output.push('**Available fonts (name — URL):**');
                    output.push('');
                    output.push(...results);
                    output.push('');
                }
                if (messages.length > 0) {
                    output.push(...messages);
                }
                return output.length > 0
                    ? output.join('\n')
                    : 'No fonts found in any available storage plugin.';
            }
            case 'open_font': {
                const url = args.url;
                if (!url) throw new Error('Missing required parameter: url');

                const parsed = (window as any).parseFileUri?.(url);
                if (!parsed)
                    throw new Error(
                        `Invalid font URL: "${url}". Expected format: pluginId:///path (e.g. memory:///user/Fustat.glyphs)`
                    );

                const plugin = (window as any).pluginRegistry?.get?.(
                    parsed.pluginId
                );
                if (!plugin)
                    throw new Error(
                        `Plugin "${parsed.pluginId}" not found. Available: ${
                            ((window as any).pluginRegistry?.getAll?.() || [])
                                .map((p: any) => p.getId())
                                .join(', ') || 'none'
                        }`
                    );

                try {
                    // Check file exists before attempting to open
                    const adapter = plugin.getAdapter();
                    if (adapter && typeof adapter.fileExists === 'function') {
                        const exists = await adapter.fileExists(parsed.path);
                        if (!exists) {
                            throw new Error(
                                `File not found: ${parsed.path} (from ${url})`
                            );
                        }
                    }
                    await (window as any).openFont?.(parsed.path, undefined, {
                        sourcePluginOverride: plugin
                    });
                } catch (err: any) {
                    throw new Error(`Failed to open font: ${err.message}`);
                }

                return `Font opened successfully: ${url}`;
            }
            case 'current_font': {
                const fm = (window as any).fontManager;
                const currentFont = fm?.currentFont;
                if (!currentFont) return 'No font is currently open.';
                const pluginId = currentFont.sourcePlugin?.getId?.();
                const path = currentFont.path || '';
                const url = pluginId
                    ? `${pluginId}:///${path.replace(/^\//, '')}`
                    : path;
                return `${currentFont.name} — ${url}`;
            }
            case 'execute_python_code': {
                const code = args.code;
                if (!code) throw new Error('Missing required parameter: code');

                const pyodide = (window as any).pyodide;
                if (!pyodide)
                    throw new Error(
                        'Python environment (Pyodide) not loaded yet. Please wait and try again.'
                    );

                // Set up stdout capture
                await pyodide.runPythonAsync(`
import sys
from io import StringIO
_agent_output_buffer = StringIO()
_agent_original_stdout = sys.stdout
sys.stdout = _agent_output_buffer
                `);

                let output = '';
                try {
                    await pyodide.runPythonAsync(code);
                    output = await pyodide.runPythonAsync(`
output = _agent_output_buffer.getvalue()
sys.stdout = _agent_original_stdout
del _agent_output_buffer
del _agent_original_stdout
output
                    `);
                } catch (err: any) {
                    // Restore stdout on error
                    await pyodide.runPythonAsync(`
if '_agent_original_stdout' in dir():
    sys.stdout = _agent_original_stdout
                    `);
                    throw new Error(`Python error: ${err.message}`);
                }

                return output || '(no output)';
            }
            case 'get_editor_state': {
                const sm = (window as any).stateManager;
                if (!sm) throw new Error('State manager not available');

                const snapshot = sm.getStateSnapshot();
                const s = snapshot.state;

                // Build feature list with descriptions from all font-defined features
                const allFeatureTags = new Set<string>();
                const featuresIn = s.editor_opentype_features_in_subset || {};
                const featuresOut =
                    s.editor_opentype_features_not_in_subset || {};
                for (const tag of Object.keys(featuresIn))
                    allFeatureTags.add(tag);
                for (const tag of Object.keys(featuresOut))
                    allFeatureTags.add(tag);

                const features = [...allFeatureTags].sort().map((tag) => ({
                    tag,
                    active: featuresIn[tag] === true,
                    inSubset: tag in featuresIn,
                    description: getFeatureDescription(tag) || tag
                }));

                return JSON.stringify(
                    {
                        textBuffer: s.editor_text_buffer || '',
                        glyphs: s.editor_harfbuzz_glyph_names || '',
                        gids: s.editor_harfbuzz_gids || '',
                        advances: s.editor_harfbuzz_ax || '',
                        clusters: s.editor_harfbuzz_cl || '',
                        features,
                        file: s.editor_file || ''
                    },
                    null,
                    2
                );
            }
            case 'set_editor_text_buffer': {
                const text = args.text;
                if (text == null)
                    throw new Error('Missing required parameter: text');

                const gcSet = (window as any).glyphCanvas;
                if (!gcSet?.textRunEditor)
                    throw new Error('Editor not available');

                gcSet.textRunEditor.setTextBuffer(String(text));
                return `Text buffer set to: ${text}`;
            }
            case 'set_editor_opentype_features': {
                const featureTags: string[] = args.features || [];
                const gcSet2 = (window as any).glyphCanvas;
                if (!gcSet2?.featuresManager)
                    throw new Error('Editor not available');

                const fm2 = gcSet2.featuresManager;
                const allF = await fm2.getDiscretionaryFeatures();

                // Set all features to false first, then enable specified ones
                for (const f of allF) {
                    fm2.featureSettings[f.tag] = featureTags.includes(f.tag);
                }

                fm2.updateFeatureResetButton();
                fm2.call('change');

                return `Features updated. Active: ${featureTags.length > 0 ? featureTags.join(', ') : '(none)'}`;
            }
            default:
                throw new Error(`Unknown tool: ${name}`);
        }
    }

    async fetchText(url: string): Promise<string> {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Not found (HTTP ${res.status})`);
        return await res.text();
    }

    // ── Single streaming round ──

    async streamRound(
        messages: any[],
        onChunk: (text: string) => void,
        signal?: AbortSignal
    ): Promise<any> {
        const sessionToken = window.authManager?.getSessionToken();
        const headers: Record<string, string> = {
            'Content-Type': 'application/json'
        };
        if (sessionToken) headers['Authorization'] = `Bearer ${sessionToken}`;

        const response = await fetch(`${this.getWebsiteURL()}/api/ai/agent`, {
            method: 'POST',
            credentials: 'include',
            headers,
            signal,
            body: JSON.stringify({
                messages,
                tools: AGENT_TOOLS,
                systemPrompt: AGENT_SYSTEM_PROMPT,
                stream: true
            })
        });

        if (!response.ok) {
            const err = await response
                .json()
                .catch(() => ({ error: 'Request failed' }));
            throw new Error(err.error || `HTTP ${response.status}`);
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error('Empty response');

        const decoder = new TextDecoder();
        let buf = '';
        let streamedText = '';
        let toolCalls: any[] | null = null;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop() || '';

            for (const line of lines) {
                const t = line.trim();
                if (!t.startsWith('data: ')) continue;
                const data = t.slice(6);
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.type === 'chunk' && parsed.content) {
                        streamedText += parsed.content;
                        onChunk(parsed.content);
                    } else if (
                        parsed.type === 'tool_call' &&
                        parsed.tool_calls
                    ) {
                        toolCalls = parsed.tool_calls;
                    } else if (parsed.type === 'done') {
                        return {
                            text: streamedText,
                            toolCalls,
                            usage: parsed.usage,
                            done: true
                        };
                    } else if (parsed.type === 'error') {
                        throw new Error(parsed.error || 'Stream error');
                    }
                } catch {
                    /* skip unparseable */
                }
            }
        }
        return { text: streamedText, toolCalls, done: false };
    }

    // ── Main entry: streaming multi-round loop ──

    async sendPrompt() {
        if (!this.promptInput || !this.messagesContainer || this.isStreaming)
            return;
        const prompt = this.promptInput.value.trim();
        if (!prompt) return;

        this.promptInput.value = '';
        this.promptInput.style.height = 'auto';
        this.isStreaming = true;
        if (this.sendButton)
            (this.sendButton as HTMLButtonElement).disabled = true;
        this.showStreamIndicator();

        this.addMessage('user', prompt);
        const conversationMessages: any[] = [
            ...this.conversationMessages,
            { role: 'user', content: prompt }
        ];
        this.showInitialStatus();

        const abortController = new AbortController();
        this.abortController = abortController;
        const signal = abortController.signal;
        let roundTexts: string[] = [];

        try {
            let messageDiv: HTMLDivElement | null = null;
            let bodyDiv: HTMLDivElement | null = null;
            let currentRoundIndex = -1;

            while (true) {
                currentRoundIndex++;
                const result = await this.streamRound(
                    conversationMessages,
                    (chunk) => {
                        this.clearInitialStatus();
                        if (!messageDiv) {
                            messageDiv = document.createElement('div');
                            messageDiv.className =
                                'agent-message agent-message-agent';
                            const header = document.createElement('div');
                            header.className = 'agent-message-header';
                            header.innerHTML =
                                '<span class="material-symbols-outlined">robot_2</span> Agent';
                            messageDiv.appendChild(header);
                            bodyDiv = document.createElement('div');
                            messageDiv.appendChild(bodyDiv);
                            this.messagesContainer!.appendChild(messageDiv);
                        }

                        // Append/render to the LAST round-text container in bodyDiv
                        roundTexts[currentRoundIndex] =
                            (roundTexts[currentRoundIndex] || '') + chunk;
                        const bd = bodyDiv as HTMLDivElement;
                        let textContainer = bd.querySelector(
                            '.agent-round-text:last-child'
                        ) as HTMLDivElement | null;
                        if (!textContainer) {
                            textContainer = document.createElement('div');
                            textContainer.className = 'agent-round-text';
                            bd.appendChild(textContainer);
                        }
                        if (typeof marked !== 'undefined') {
                            textContainer.innerHTML = marked.parse(
                                roundTexts[currentRoundIndex]
                            );
                        } else {
                            textContainer.textContent =
                                roundTexts[currentRoundIndex];
                        }
                        this.scrollToBottomIfNear();
                    },
                    signal
                );

                // ── Track usage for this round ──
                const roundUsage = result.usage;
                if (roundUsage) {
                    this.roundUsage.push(roundUsage);
                    this.accumulateSessionTotals(roundUsage);
                }

                // ── Render per-round metrics (dev mode only) ──
                const isDev = window.isDevelopment?.() ?? false;
                if (isDev && bodyDiv) {
                    const bd = bodyDiv as HTMLDivElement;
                    const metricsStr = this.formatUsageMetrics(roundUsage);
                    if (metricsStr) {
                        const roundTextEl = bd.querySelector(
                            '.agent-round-text:last-child'
                        ) as HTMLElement | null;
                        if (roundTextEl) {
                            const metricsEl = document.createElement('div');
                            metricsEl.className = 'agent-round-metrics';
                            metricsEl.textContent = metricsStr;
                            roundTextEl.insertAdjacentElement(
                                'afterend',
                                metricsEl
                            );
                        }
                    }
                }

                this.updateSessionMetricsBar();

                if (result.toolCalls && result.toolCalls.length > 0) {
                    // Ensure the agent message container exists even when the model
                    // responds with only a tool call and no preamble text
                    if (!messageDiv) {
                        messageDiv = document.createElement('div');
                        messageDiv.className =
                            'agent-message agent-message-agent';
                        const header = document.createElement('div');
                        header.className = 'agent-message-header';
                        header.innerHTML =
                            '<span class="material-symbols-outlined">robot_2</span> Agent';
                        messageDiv.appendChild(header);
                        bodyDiv = document.createElement('div');
                        messageDiv.appendChild(bodyDiv);
                        this.messagesContainer!.appendChild(messageDiv);
                    }

                    conversationMessages.push({
                        role: 'assistant',
                        content: result.text || null,
                        tool_calls: result.toolCalls
                    });

                    for (const toolCall of result.toolCalls) {
                        let args;
                        try {
                            args = JSON.parse(
                                toolCall.function.arguments || '{}'
                            );
                        } catch {
                            args = {};
                        }

                        let toolResult: string;
                        let resultLen = 0;

                        // Add tool-call line directly into bodyDiv — between rounds,
                        // so it appears chronologically between Round 1 text and Round 2 text
                        if (bodyDiv) {
                            const line = document.createElement('div');
                            line.className = 'agent-tool-call-line';
                            line.textContent = `📖 Calling ${toolCall.function.name}`;

                            const infoBtn = document.createElement('button');
                            infoBtn.className = 'agent-tool-call-info-btn';
                            infoBtn.textContent = 'ⓘ';
                            line.appendChild(infoBtn);

                            try {
                                toolResult =
                                    await this.executeToolCall(toolCall);
                                resultLen = toolResult.length;
                            } catch (err: any) {
                                toolResult = `Error: ${err.message}`;
                            }

                            const metaEl = document.createElement('div');
                            metaEl.style.cssText =
                                'font-size:11px;line-height:1.6;padding:4px;color:var(--text-primary);';

                            // Format arguments — show Python code with syntax highlighting for execute_python_code
                            let argsHtml: string;
                            if (
                                toolCall.function.name ===
                                    'execute_python_code' &&
                                args.code
                            ) {
                                argsHtml = `<b>Arguments:</b><br><pre style="margin:4px 0 0 0;padding:8px;background:var(--background-hover);border-radius:4px;font-size:11px;line-height:1.5;overflow-x:auto;font-family:var(--font-families-mono);tab-size:4">${this.highlightPython(args.code)}</pre>`;
                            } else {
                                argsHtml = `<b>Arguments:</b> ${this.escapeHtml(JSON.stringify(args, null, 2))}`;
                            }

                            metaEl.innerHTML = `
                                <b>Tool:</b> ${toolCall.function.name}<br>
                                ${argsHtml}<br>
                                <b>Result:</b> ${resultLen} characters<br>
                                <b>Time:</b> ${new Date().toLocaleTimeString()}<br>
                                <hr style="margin:4px 0;border:none;border-top:1px solid var(--border-primary)">
                                <pre style="margin:0;white-space:pre-wrap;word-break:break-word;font-size:10px">${this.escapeHtml(toolResult)}</pre>
                            `;

                            tippy(infoBtn, {
                                content: metaEl,
                                allowHTML: true,
                                interactive: true,
                                appendTo: document.body,
                                maxWidth: 520,
                                placement: 'right',
                                zIndex: 99999,
                                theme: getTheme(),
                                popperOptions: {
                                    modifiers: [
                                        {
                                            name: 'preventOverflow',
                                            options: {
                                                boundary: 'viewport',
                                                padding: 12
                                            }
                                        }
                                    ]
                                },
                                onMount(instance) {
                                    const content =
                                        instance.popper.querySelector(
                                            '.tippy-content'
                                        ) as HTMLElement | null;
                                    if (content) {
                                        content.style.maxHeight = '70vh';
                                        content.style.overflowY = 'auto';
                                    }
                                }
                            });

                            (bodyDiv as HTMLDivElement).appendChild(line);
                            this.scrollToBottomIfNear();
                        } else {
                            try {
                                toolResult =
                                    await this.executeToolCall(toolCall);
                            } catch (err: any) {
                                toolResult = `Error: ${err.message}`;
                            }
                        }

                        conversationMessages.push({
                            role: 'tool',
                            tool_call_id: toolCall.id,
                            name: toolCall.function.name,
                            content: toolResult
                        });
                    }
                    // Continue to next streaming round
                } else {
                    // No more tool calls — final text response
                    const finalText = roundTexts.join(' ') || result.text || '';
                    this.conversationMessages = conversationMessages;
                    conversationMessages.push({
                        role: 'assistant',
                        content: finalText
                    });
                    this.messages.push({
                        role: 'assistant',
                        content: finalText
                    });
                    this.hideStreamIndicator();
                    this.isStreaming = false;
                    if (this.sendButton)
                        (this.sendButton as HTMLButtonElement).disabled = false;
                    if (this.promptInput) this.promptInput.focus();
                    return;
                }
            }
        } catch (err: any) {
            this.clearInitialStatus();
            if (err.name === 'AbortError') {
                // User clicked stop — save whatever text was streamed so the
                // model can pick up from "Continue"
                const partialText = roundTexts.filter(Boolean).join(' ').trim();
                if (partialText) {
                    conversationMessages.push({
                        role: 'assistant',
                        content: partialText
                    });
                    this.conversationMessages = conversationMessages;
                }
            } else {
                this.addMessage('error', err.message || 'Network error');
                console.error('[AIAgent]', 'Request failed:', err);
            }
        }

        this.hideStreamIndicator();
        this.isStreaming = false;
        if (this.sendButton)
            (this.sendButton as HTMLButtonElement).disabled = false;
        if (this.promptInput) this.promptInput.focus();
    }

    showInitialStatus() {
        if (!this.messagesContainer) return;
        const el = document.createElement('div');
        el.id = 'agent-initial-status';
        el.className = 'agent-tool-call-line';
        el.textContent = '💭 Understanding your question...';
        this.messagesContainer.appendChild(el);
        this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
    }

    showStreamIndicator() {
        const el = document.getElementById('agent-stream-indicator');
        if (el) el.style.display = 'flex';
    }

    hideStreamIndicator() {
        const el = document.getElementById('agent-stream-indicator');
        if (el) el.style.display = 'none';
    }

    clearInitialStatus() {
        document.getElementById('agent-initial-status')?.remove();
    }

    scrollToBottomIfNear(threshold = 150) {
        if (!this.messagesContainer) return;
        const dist =
            this.messagesContainer.scrollHeight -
            this.messagesContainer.scrollTop -
            this.messagesContainer.clientHeight;
        if (dist < threshold) {
            this.messagesContainer.scrollTop =
                this.messagesContainer.scrollHeight;
        }
    }

    escapeHtml(text: string): string {
        const d = document.createElement('div');
        d.appendChild(document.createTextNode(text));
        return d.innerHTML;
    }

    highlightPython(code: string): string {
        const escaped = this.escapeHtml(code);
        let html = escaped;

        // Triple-quoted strings (must come before single-line strings)
        html = html.replace(
            /(&quot;&quot;&quot;[\s\S]*?&quot;&quot;&quot;|&#x27;&#x27;&#x27;[\s\S]*?&#x27;&#x27;&#x27;)/g,
            '<span style="color:var(--accent-orange)">$1</span>'
        );
        // Comments
        html = html.replace(
            /(#[^\n]*)/g,
            '<span style="color:var(--accent-green);font-style:italic">$1</span>'
        );
        // F-strings (before regular strings)
        html = html.replace(
            /(f&quot;[^&]*?&quot;|f&#x27;[^&]*?&#x27;)/g,
            '<span style="color:var(--accent-magenta)">$1</span>'
        );
        // Regular strings
        html = html.replace(
            /(&quot;[^&]*?&quot;|&#x27;[^&]*?&#x27;)/g,
            '<span style="color:var(--accent-orange)">$1</span>'
        );
        // Keywords
        html = html.replace(
            /\b(def|class|if|elif|else|for|while|import|from|as|return|yield|try|except|finally|raise|with|pass|break|continue|and|or|not|in|is|lambda|async|await|True|False|None|self|del|global|nonlocal|assert)\b/g,
            '<span style="color:var(--accent-blue);font-weight:bold">$1</span>'
        );
        // Built-in functions
        html = html.replace(
            /\b(print|len|range|int|str|float|list|dict|set|tuple|type|open|map|filter|zip|enumerate|sorted|reversed|abs|min|max|sum|any|all|isinstance|hasattr|getattr|setattr|super|property|staticmethod|classmethod|object|__init__|__str__|__repr__|__len__|__getitem__|__setitem__|__delitem__|__iter__|__next__|__enter__|__exit__)\b/g,
            '<span style="color:var(--accent-cyan)">$1</span>'
        );
        // Numbers
        html = html.replace(
            /\b(\d+\.?\d*)\b/g,
            '<span style="color:var(--accent-magenta)">$1</span>'
        );

        return html;
    }

    // ── Dev-mode usage metrics ──

    formatUsageMetrics(usage: UsageMetrics | null | undefined): string {
        if (!usage) return '';
        const parts: string[] = [];
        if (usage.prompt_tokens != null)
            parts.push(`in: ${usage.prompt_tokens}`);
        if (usage.completion_tokens != null)
            parts.push(`out: ${usage.completion_tokens}`);
        if (usage.cached_tokens != null)
            parts.push(`cached: ${usage.cached_tokens}`);
        if (usage.total_cost != null)
            parts.push(`$${usage.total_cost.toFixed(6)}`);
        else if (usage.cost_eur_cents != null)
            parts.push(`${usage.cost_eur_cents}c`);
        return parts.length > 0 ? parts.join(' · ') : '';
    }

    accumulateSessionTotals(usage: UsageMetrics | null | undefined): void {
        if (!usage) return;
        this.sessionTotals.prompt_tokens =
            (this.sessionTotals.prompt_tokens || 0) +
            (usage.prompt_tokens || 0);
        this.sessionTotals.completion_tokens =
            (this.sessionTotals.completion_tokens || 0) +
            (usage.completion_tokens || 0);
        this.sessionTotals.cached_tokens =
            (this.sessionTotals.cached_tokens || 0) +
            (usage.cached_tokens || 0);
        this.sessionTotals.total_cost =
            (this.sessionTotals.total_cost || 0) + (usage.total_cost || 0);
        this.sessionTotals.cost_eur_cents =
            (this.sessionTotals.cost_eur_cents || 0) +
            (usage.cost_eur_cents || 0);
    }

    updateSessionMetricsBar(): void {
        const bar = document.getElementById('agent-session-metrics');
        if (!bar) return;
        if (!window.isDevelopment?.()) {
            bar.style.display = 'none';
            return;
        }
        const s = this.sessionTotals;
        const hasData =
            s.prompt_tokens != null ||
            s.completion_tokens != null ||
            s.total_cost != null;
        if (!hasData || Object.keys(s).length === 0) {
            bar.style.display = 'none';
            return;
        }
        bar.style.display = 'inline';
        bar.textContent = this.formatUsageMetrics(s);
    }

    newChat() {
        if (this.messagesContainer) this.messagesContainer.innerHTML = '';
        this.messages = [];
        this.conversationMessages = [];
        this.roundUsage = [];
        this.sessionTotals = {};
        this.isStreaming = false;
        if (this.promptInput) {
            this.promptInput.value = '';
            this.promptInput.style.height = 'auto';
        }
        if (this.sendButton)
            (this.sendButton as HTMLButtonElement).disabled = false;
        this.clearInitialStatus();
        this.hideStreamIndicator();
        this.updateSessionMetricsBar();
        if (this.promptInput) this.promptInput.focus();
    }
}

function initAgent() {
    const checkReady = () => {
        if (window.authManager) {
            window.aiAgent = new AIAgent();
        } else {
            setTimeout(checkReady, 100);
        }
    };
    checkReady();
}

if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', initAgent);
else initAgent();

export default AIAgent;

// AI Agent for Font Editing Knowledge
// Streaming multi-round tool calling entirely on the client.
// Each round is one streaming request per tool-call cycle.
// Tools and instructions live in agent-config.ts.

import { resolveWebsiteURL } from './website-url';
import { Logger } from './logger';
import {
    AGENT_TOOLS,
    AGENT_SYSTEM_PROMPT,
    AgentTool,
    UsageMetrics
} from './agent-config';
import tippy from 'tippy.js';
import 'tippy.js/dist/tippy.css';
import { getTheme } from './tippy-utils';
import {
    getFeatureDescription,
    getFeatureExecutionOrder,
    isDiscretionary,
    SCRIPT_TO_SHAPER
} from './opentype-features';
import { designspaceToUserspace, userspaceToDesignspace } from './locations';
import {
    buildCompileAndShapeFontCacheKey,
    buildCompileAndShapeFontRevisionKey,
    CompileAndShapeFontCacheEntry,
    resolveCompileAndShapeFontCompilation
} from './compile-and-shape-font-cache';
import {
    AgentPromptExecutionContext,
    setActiveAgentPythonExecution
} from './agent-execution-context';

const console = new Logger('AIAgent');

type CompileAndShapeFontWorkerState = {
    awaitWorkerDocumentSync?: () => Promise<void>;
    hasWorkerCacheDocument?: () => boolean;
};

type CompileAndShapeFontManagerState = {
    workerCacheUpdatePromise?: Promise<void> | null;
};

/** Wait until the committed Yjs worker state and visible font revision settle. */
async function awaitStableCompileAndShapeFontWorkerState(
    fontManager: CompileAndShapeFontManagerState,
    fontCompilation: CompileAndShapeFontWorkerState,
    getFontRevisionKey: () => string
): Promise<void> {
    if (
        typeof fontCompilation.awaitWorkerDocumentSync !== 'function' ||
        typeof fontCompilation.hasWorkerCacheDocument !== 'function'
    ) {
        throw new Error(
            'compile_and_shape_font worker synchronization is not available yet.'
        );
    }

    let lastAwaitedCacheUpdate: Promise<void> | null = null;
    for (let attempt = 0; attempt < 8; attempt++) {
        const revisionBeforeSync = getFontRevisionKey();
        await fontCompilation.awaitWorkerDocumentSync();

        const pendingCacheUpdate = fontManager.workerCacheUpdatePromise ?? null;
        if (
            pendingCacheUpdate &&
            pendingCacheUpdate !== lastAwaitedCacheUpdate
        ) {
            lastAwaitedCacheUpdate = pendingCacheUpdate;
            await pendingCacheUpdate;
            continue;
        }

        await fontCompilation.awaitWorkerDocumentSync();
        const cacheUpdateChanged =
            fontManager.workerCacheUpdatePromise !== pendingCacheUpdate;
        if (cacheUpdateChanged || revisionBeforeSync !== getFontRevisionKey()) {
            continue;
        }

        if (!fontCompilation.hasWorkerCacheDocument()) {
            throw new Error(
                'compile_and_shape_font requires the current font to finish synchronizing to the compiler worker.'
            );
        }

        return;
    }

    throw new Error(
        'compile_and_shape_font could not stabilize the current font revision. Retry after editing settles.'
    );
}

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
    _reconnectAttempts: number;
    messages: Array<{ role: string; content: string }>;
    conversationMessages: Array<any>;
    roundUsage: UsageMetrics[];
    sessionTotals: UsageMetrics;
    compileAndShapeFontCache: CompileAndShapeFontCacheEntry | null;
    allowFontEdits: boolean;
    activePromptContext: AgentPromptExecutionContext | null;

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
        this._reconnectAttempts = 0;
        this.messages = [];
        this.conversationMessages = [];
        this.roundUsage = [];
        this.sessionTotals = {};
        this.compileAndShapeFontCache = null;
        this.allowFontEdits =
            localStorage.getItem('agentAllowFontEdits') === 'true';
        this.activePromptContext = null;

        this.initUI();
        this.checkAuthenticationStatus();
    }

    canUseAgent() {
        return this.subscription?.canUseAgent === true;
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
        } else if (!this.canUseAgent()) {
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

        const editToggle = document.getElementById(
            'agent-edit-toggle'
        ) as HTMLButtonElement | null;
        editToggle?.addEventListener('click', () => {
            if (this.isStreaming) return;
            this.allowFontEdits = !this.allowFontEdits;
            localStorage.setItem(
                'agentAllowFontEdits',
                String(this.allowFontEdits)
            );
            this.updateAgentEditToggle();
        });
        this.updateAgentEditToggle();

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

    updateAgentEditToggle() {
        const editToggle = document.getElementById(
            'agent-edit-toggle'
        ) as HTMLButtonElement | null;
        if (!editToggle) return;

        const editsAllowed = this.allowFontEdits;
        const isLocked = this.isStreaming;
        const stateLabel = editsAllowed ? 'on' : 'off';
        const label = isLocked
            ? `Agent font edits are ${stateLabel} for this prompt and locked`
            : `Agent font edits are ${stateLabel}`;

        editToggle.classList.toggle('active', editsAllowed);
        editToggle.classList.toggle('locked', isLocked);
        editToggle.disabled = isLocked;
        editToggle.setAttribute('aria-pressed', String(editsAllowed));
        editToggle.setAttribute('aria-label', label);
        editToggle.title = label;

        const icon = editToggle.querySelector('.material-symbols-outlined');
        if (icon) {
            icon.textContent = editsAllowed ? 'edit' : 'edit_off';
        }
    }

    private async getRuntimeSystemPrompt(): Promise<string> {
        const editorState = await this.executeToolCall({
            function: { name: 'get_editor_state', arguments: '{}' }
        });
        const promptContext = this.activePromptContext;
        return `${AGENT_SYSTEM_PROMPT}\n\nCURRENT PROMPT PERMISSION: Font data editing is ${promptContext?.allowFontEdits ? 'allowed' : 'disabled'} for this prompt.\n\nCURRENT EDITOR STATE:\n${editorState}`;
    }

    setupInfoModal() {
        const btn = document.getElementById('agent-info-btn');
        const modal = document.getElementById('agent-info-modal');
        const close = document.getElementById('agent-info-modal-close-btn');
        const content = document.getElementById('agent-info-modal-content');
        if (!btn || !modal || !close || !content) return;

        const createLiveToolButton = (tool: AgentTool) => {
            const properties = this.getToolParameterProperties(tool);
            const hasParameters = Object.keys(properties).length > 0;
            const infoBtn = document.createElement('button');
            infoBtn.className = 'agent-tool-call-info-btn';
            infoBtn.textContent = 'ⓘ';
            infoBtn.title = hasParameters
                ? 'Configure and run tool'
                : 'Run tool and show current output';

            const instance = tippy(infoBtn, {
                content: this.createToolInvocationPopup(tool),
                allowHTML: true,
                interactive: true,
                appendTo: document.body,
                maxWidth: 520,
                placement: 'right',
                trigger: 'manual',
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
                    const inner = instance.popper.querySelector(
                        '.tippy-content'
                    ) as HTMLElement | null;
                    if (inner) {
                        inner.style.maxHeight = '70vh';
                        inner.style.overflowY = 'auto';
                    }
                }
            });

            infoBtn.addEventListener('click', async (event) => {
                event.preventDefault();
                event.stopPropagation();
                instance.setContent(
                    this.createToolInvocationPopup(tool, {
                        autoRun: !hasParameters
                    })
                );
                instance.show();
            });

            return infoBtn;
        };

        content.innerHTML = '';
        for (const tool of AGENT_TOOLS) {
            const section = document.createElement('div');
            section.className = 'ai-info-section';
            section.style.marginBottom = '16px';

            const titleRow = document.createElement('div');
            titleRow.style.cssText =
                'display:flex;align-items:center;gap:6px;margin:0 0 4px 0;';

            const title = document.createElement('h4');
            title.style.cssText =
                'font-size:14px;margin:0;color:var(--text-primary);font-weight:600;';
            title.textContent = tool.function.name;
            titleRow.appendChild(title);

            const properties = this.getToolParameterProperties(tool);
            titleRow.appendChild(createLiveToolButton(tool));

            section.appendChild(titleRow);

            const description = document.createElement('div');
            description.style.cssText =
                'margin:0 0 8px 0;font-size:12px;color:var(--text-tertiary);line-height:1.5';
            if (typeof marked !== 'undefined') {
                description.innerHTML = marked.parse(tool.function.description);
            } else {
                description.textContent = tool.function.description;
            }
            section.appendChild(description);

            const params = document.createElement('div');
            params.style.cssText = 'font-size:11px;color:var(--text-faint)';
            if (Object.keys(properties).length > 0) {
                const strong = document.createElement('strong');
                strong.textContent = 'Parameters:';
                params.appendChild(strong);
                params.appendChild(document.createTextNode(' '));

                for (const name of Object.keys(properties)) {
                    const code = document.createElement('code');
                    code.style.cssText =
                        'background:var(--background-hover);padding:1px 4px;border-radius:3px;margin-right:4px';
                    code.textContent = name;
                    params.appendChild(code);
                }
            } else {
                const em = document.createElement('em');
                em.textContent = 'No parameters';
                params.appendChild(em);
            }
            section.appendChild(params);
            content.appendChild(section);
        }

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

    getToolParameterProperties(tool: AgentTool): Record<string, any> {
        return ((tool.function.parameters as any)?.properties || {}) as Record<
            string,
            any
        >;
    }

    getToolRequiredParameters(tool: AgentTool): Set<string> {
        const required = (tool.function.parameters as any)?.required;
        return new Set(Array.isArray(required) ? required : []);
    }

    shouldUseTextareaForToolParameter(
        paramName: string,
        schema: Record<string, any>
    ): boolean {
        if (schema.type === 'array' || schema.type === 'object') {
            return true;
        }

        return paramName === 'code' || paramName === 'text';
    }

    parseToolParameterValue(
        rawValue: string,
        schema: Record<string, any>
    ): any {
        const trimmed = rawValue.trim();

        switch (schema.type) {
            case 'array': {
                if (!trimmed) {
                    return [];
                }

                if (trimmed.startsWith('[')) {
                    const parsed = JSON.parse(trimmed);
                    if (!Array.isArray(parsed)) {
                        throw new Error('Expected a JSON array.');
                    }
                    return parsed;
                }

                return trimmed
                    .split(/[\n,]/)
                    .map((value) => value.trim())
                    .filter(Boolean);
            }
            case 'integer': {
                if (!trimmed) {
                    return undefined;
                }
                const value = Number(trimmed);
                if (!Number.isInteger(value)) {
                    throw new Error('Expected an integer value.');
                }
                return value;
            }
            case 'number': {
                if (!trimmed) {
                    return undefined;
                }
                const value = Number(trimmed);
                if (!Number.isFinite(value)) {
                    throw new Error('Expected a numeric value.');
                }
                return value;
            }
            case 'boolean': {
                if (!trimmed) {
                    return undefined;
                }
                if (trimmed === 'true') {
                    return true;
                }
                if (trimmed === 'false') {
                    return false;
                }
                throw new Error('Expected `true` or `false`.');
            }
            case 'object': {
                if (!trimmed) {
                    return {};
                }
                return JSON.parse(trimmed);
            }
            default:
                return rawValue;
        }
    }

    collectToolInvocationArguments(
        tool: AgentTool,
        fields: Record<string, HTMLInputElement | HTMLTextAreaElement>
    ): Record<string, any> {
        const properties = this.getToolParameterProperties(tool);
        const required = this.getToolRequiredParameters(tool);
        const args: Record<string, any> = {};

        for (const [paramName, schema] of Object.entries(properties)) {
            const field = fields[paramName];
            if (!field) {
                continue;
            }

            const rawValue = field.value;
            const trimmed = rawValue.trim();
            if (!trimmed && schema.type !== 'array') {
                if (required.has(paramName)) {
                    throw new Error(`Missing required parameter: ${paramName}`);
                }
                continue;
            }

            const value = this.parseToolParameterValue(rawValue, schema);
            if (value === undefined && !required.has(paramName)) {
                continue;
            }
            args[paramName] = value;
        }

        return args;
    }

    createToolInvocationPopup(
        tool: AgentTool,
        options: { autoRun?: boolean } = {}
    ): HTMLElement {
        const properties = this.getToolParameterProperties(tool);
        const fieldEntries = Object.entries(properties);
        const fields: Record<string, HTMLInputElement | HTMLTextAreaElement> =
            {};

        const wrapper = document.createElement('div');
        wrapper.style.cssText =
            'min-width:320px;max-width:520px;padding:8px;color:var(--text-primary);';

        const title = document.createElement('div');
        title.textContent = tool.function.name;
        title.style.cssText =
            'font-size:12px;font-weight:600;margin-bottom:8px;color:var(--text-primary);';
        wrapper.appendChild(title);

        const form = document.createElement('form');
        form.style.cssText = 'display:flex;flex-direction:column;gap:10px;';

        for (const [paramName, schema] of fieldEntries) {
            const fieldWrapper = document.createElement('label');
            fieldWrapper.style.cssText =
                'display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--text-primary);';

            const label = document.createElement('span');
            label.textContent = paramName;
            label.style.cssText = 'font-weight:600;';
            fieldWrapper.appendChild(label);

            const input = this.shouldUseTextareaForToolParameter(
                paramName,
                schema
            )
                ? document.createElement('textarea')
                : document.createElement('input');

            input.style.cssText =
                'width:100%;box-sizing:border-box;border:1px solid var(--border-primary);border-radius:6px;padding:8px;background:var(--background-primary);color:var(--text-primary);font:inherit;font-size:11px;';
            if (input instanceof HTMLTextAreaElement) {
                input.rows = schema.type === 'array' ? 4 : 6;
                if (schema.type === 'array') {
                    input.placeholder =
                        '["liga", "kern"] or one value per line';
                }
            } else {
                input.type = 'text';
            }

            if (!input.placeholder && typeof schema.description === 'string') {
                input.placeholder = schema.description;
            }

            fieldWrapper.appendChild(input);

            if (typeof schema.description === 'string' && schema.description) {
                const description = document.createElement('div');
                description.textContent = schema.description;
                description.style.cssText =
                    'font-size:10px;line-height:1.4;color:var(--text-tertiary);';
                fieldWrapper.appendChild(description);
            }

            fields[paramName] = input;
            form.appendChild(fieldWrapper);
        }

        const controls = document.createElement('div');
        controls.style.cssText =
            'display:flex;align-items:center;gap:8px;flex-wrap:wrap;';

        const submitButton = document.createElement('button');
        submitButton.type = 'submit';
        submitButton.textContent = 'Run tool';
        submitButton.style.cssText =
            'border:1px solid var(--border-primary);border-radius:6px;padding:6px 10px;background:var(--background-hover);color:var(--text-primary);font-size:11px;cursor:pointer;';
        controls.appendChild(submitButton);

        const status = document.createElement('div');
        status.style.cssText =
            'font-size:10px;line-height:1.4;color:var(--text-tertiary);';
        status.textContent =
            fieldEntries.length > 0
                ? 'Fill parameters and run the live tool call.'
                : 'Run the live tool call.';
        controls.appendChild(status);

        form.appendChild(controls);
        wrapper.appendChild(form);

        const output = document.createElement('div');
        output.style.marginTop = '10px';
        wrapper.appendChild(output);

        const setOutput = (element: HTMLElement) => {
            output.innerHTML = '';
            output.appendChild(element);
        };

        const runTool = async () => {
            let args: Record<string, any> = {};
            try {
                args = this.collectToolInvocationArguments(tool, fields);
            } catch (error: any) {
                status.textContent = error.message || 'Invalid parameters.';
                status.style.color = 'var(--accent-red)';
                return;
            }

            submitButton.disabled = true;
            submitButton.style.opacity = '0.65';
            status.textContent = 'Running...';
            status.style.color = 'var(--text-tertiary)';

            try {
                const toolResult = await this.executeToolCall({
                    id: `info-${tool.function.name}`,
                    function: {
                        name: tool.function.name,
                        arguments: JSON.stringify(args)
                    }
                });

                status.textContent = 'Completed.';
                setOutput(
                    this.createToolCallMetaElement(
                        tool.function.name,
                        args,
                        toolResult,
                        new Date().toLocaleTimeString()
                    )
                );
            } catch (error: any) {
                status.textContent = 'Tool call failed.';
                status.style.color = 'var(--accent-red)';
                setOutput(
                    this.createToolCallMetaElement(
                        tool.function.name,
                        args,
                        `Error: ${error.message}`,
                        new Date().toLocaleTimeString()
                    )
                );
                return;
            } finally {
                submitButton.disabled = false;
                submitButton.style.opacity = '1';
            }

            status.style.color = 'var(--text-tertiary)';
        };

        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            await runTool();
        });

        if (options.autoRun) {
            void runTool();
        }

        return wrapper;
    }

    createAgentMessageShell() {
        const messageDiv = document.createElement('div');
        messageDiv.className = 'agent-message agent-message-agent';

        const header = document.createElement('div');
        header.className = 'agent-message-header';
        header.style.display = 'flex';
        header.style.alignItems = 'center';
        header.style.gap = '6px';

        const label = document.createElement('span');
        label.style.display = 'inline-flex';
        label.style.alignItems = 'center';
        label.style.gap = '4px';
        label.innerHTML =
            '<span class="material-symbols-outlined">robot_2</span> Agent';
        header.appendChild(label);

        messageDiv.appendChild(header);

        const body = document.createElement('div');
        messageDiv.appendChild(body);

        return { messageDiv, header, body };
    }

    attachPopup(
        button: HTMLElement,
        contentFactory: () => HTMLElement,
        placement: string = 'right',
        maxWidth: number = 520
    ) {
        tippy(button, {
            content: contentFactory(),
            allowHTML: true,
            interactive: true,
            appendTo: document.body,
            maxWidth,
            placement: placement as any,
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
            onShow: (instance) => {
                instance.setContent(contentFactory());
            },
            onMount(instance) {
                const content = instance.popper.querySelector(
                    '.tippy-content'
                ) as HTMLElement | null;
                if (content) {
                    content.style.maxHeight = '70vh';
                    content.style.overflowY = 'auto';
                }
            }
        });
    }

    toolCallHasNoArguments(args: any): boolean {
        return (
            !args ||
            (typeof args === 'object' &&
                !Array.isArray(args) &&
                Object.keys(args).length === 0)
        );
    }

    createToolCallMetaElement(
        toolName: string,
        args: any,
        toolResult: string,
        timeLabel: string
    ): HTMLElement {
        const resultLen = toolResult.length;
        const metaEl = document.createElement('div');
        metaEl.style.cssText =
            'font-size:11px;line-height:1.6;padding:4px;color:var(--text-primary);';

        let argsHtml: string;
        if (toolName === 'execute_python_code' && args.code) {
            argsHtml = `<b>Arguments:</b><br><pre style="margin:4px 0 0 0;padding:8px;background:var(--background-hover);border-radius:4px;font-size:11px;line-height:1.5;overflow-x:auto;font-family:var(--font-families-mono);tab-size:4">${this.highlightPython(args.code)}</pre>`;
        } else {
            argsHtml = `<b>Arguments:</b> ${this.escapeHtml(JSON.stringify(args, null, 2))}`;
        }

        metaEl.innerHTML = `
            <b>Tool:</b> ${toolName}<br>
            ${argsHtml}<br>
            <b>Result:</b> ${resultLen} characters<br>
            <b>Time:</b> ${this.escapeHtml(timeLabel)}<br>
            <hr style="margin:4px 0;border:none;border-top:1px solid var(--border-primary)">
            <pre style="margin:0;white-space:pre-wrap;word-break:break-word;font-size:10px">${this.escapeHtml(toolResult)}</pre>
        `;

        return metaEl;
    }

    createToolCallOutputElement(
        toolName: string,
        toolResult: string,
        timeLabel: string
    ): HTMLElement {
        const outputEl = document.createElement('div');
        outputEl.style.cssText =
            'font-size:11px;line-height:1.6;padding:4px;color:var(--text-primary);';
        outputEl.innerHTML = `
            <b>Tool:</b> ${toolName}<br>
            <b>Time:</b> ${this.escapeHtml(timeLabel)}<br>
            <hr style="margin:4px 0;border:none;border-top:1px solid var(--border-primary)">
            <pre style="margin:0;white-space:pre-wrap;word-break:break-word;font-size:10px">${this.escapeHtml(toolResult)}</pre>
        `;
        return outputEl;
    }

    parseOpenTypeSearchTerms(query: string): string[] {
        return query
            .toLowerCase()
            .split(/\s+/)
            .map((term) => term.trim())
            .filter(Boolean);
    }

    parseOpenTypeClassGlyphMembers(classCode: string): Set<string> {
        const glyphs = new Set<string>();
        if (!classCode) {
            return glyphs;
        }

        const codeWithoutComments = classCode.replace(/#.*/g, '');
        const tokens = codeWithoutComments
            .split(/\s+/)
            .map((token) => token.trim())
            .filter(Boolean);

        tokens.forEach((token) => glyphs.add(token));
        return glyphs;
    }

    getAllOpenTypeGlyphsInClass(
        className: string,
        classGlyphMembers: Map<string, Set<string>>,
        visited: Set<string> = new Set()
    ): Set<string> {
        const allGlyphs = new Set<string>();
        if (visited.has(className)) {
            return allGlyphs;
        }
        visited.add(className);

        const cleanName = className.startsWith('@')
            ? className.slice(1)
            : className;
        const members = classGlyphMembers.get(cleanName);
        if (!members) {
            return allGlyphs;
        }

        members.forEach((member) => {
            if (member.startsWith('@')) {
                const nestedGlyphs = this.getAllOpenTypeGlyphsInClass(
                    member,
                    classGlyphMembers,
                    visited
                );
                nestedGlyphs.forEach((glyph) => allGlyphs.add(glyph));
                return;
            }

            allGlyphs.add(member);
        });

        return allGlyphs;
    }

    findOpenTypeFeatureMatchLines(
        code: string,
        searchTerms: string[],
        matchingClasses: string[]
    ): Array<{ lineNumber: number; line: string }> {
        const lines = code.split(/\r?\n/);
        const matches: Array<{ lineNumber: number; line: string }> = [];

        lines.forEach((line, index) => {
            const lineLower = line.toLowerCase();
            const matchesSearchTerm = searchTerms.some((term) =>
                lineLower.includes(term)
            );
            const matchesClassReference = matchingClasses.some((className) =>
                line.includes(`@${className}`)
            );

            if (!matchesSearchTerm && !matchesClassReference) {
                return;
            }

            matches.push({
                lineNumber: index + 1,
                line: line.replace(/\t/g, ' ').replace(/ {2,}/g, ' ').trim()
            });
        });

        return matches;
    }

    searchFontOpenTypeClassesAndFeatures(query: string): string {
        const font = (window as any).currentFontModel;
        if (!font) {
            throw new Error('No font is currently open.');
        }

        const searchTerms = this.parseOpenTypeSearchTerms(query);
        if (searchTerms.length === 0) {
            throw new Error('Search query is empty.');
        }

        const classEntries = Object.entries(
            font.features?.classes || {}
        ) as Array<[string, { code?: string }]>;
        const featureEntries = (font.features?.features || []) as Array<
            [string, { code?: string }]
        >;

        const classCodeData = new Map<string, string>();
        const classGlyphMembers = new Map<string, Set<string>>();

        classEntries.forEach(([className, classData]) => {
            const code = classData?.code || '';
            classCodeData.set(className, code);
            classGlyphMembers.set(
                className,
                this.parseOpenTypeClassGlyphMembers(code)
            );
        });

        const matchingClasses = classEntries
            .map(([className, classData]) => {
                const code = classData?.code || '';
                const directMatchText = `${className} ${code}`.toLowerCase();
                const hasDirectMatch = searchTerms.every((term) =>
                    directMatchText.includes(term)
                );
                const matchingGlyphs = Array.from(
                    this.getAllOpenTypeGlyphsInClass(
                        className,
                        classGlyphMembers
                    )
                )
                    .filter((glyph) => {
                        const glyphLower = glyph.toLowerCase();
                        return searchTerms.every((term) =>
                            glyphLower.includes(term)
                        );
                    })
                    .sort((left, right) => left.localeCompare(right));

                if (!hasDirectMatch && matchingGlyphs.length === 0) {
                    return null;
                }

                return {
                    className,
                    matchingGlyphs
                };
            })
            .filter(
                (
                    value
                ): value is { className: string; matchingGlyphs: string[] } =>
                    value !== null
            )
            .sort((left, right) =>
                left.className.localeCompare(right.className)
            );

        const matchingClassNames = matchingClasses.map(
            ({ className }) => className
        );

        const matchingFeatures = featureEntries
            .map(([tag, codeData], index) => {
                const code = codeData?.code || '';
                const searchText = `${tag} ${code}`.toLowerCase();
                const hasDirectMatch = searchTerms.every((term) =>
                    searchText.includes(term)
                );
                const referencedMatchingClasses = matchingClassNames.filter(
                    (className) => code.includes(`@${className}`)
                );

                if (!hasDirectMatch && referencedMatchingClasses.length === 0) {
                    return null;
                }

                const lineMatches = this.findOpenTypeFeatureMatchLines(
                    code,
                    searchTerms,
                    referencedMatchingClasses
                );

                return {
                    tag,
                    index,
                    lineMatches,
                    tagOnlyMatch: lineMatches.length === 0 && hasDirectMatch
                };
            })
            .filter(
                (
                    value
                ): value is {
                    tag: string;
                    index: number;
                    lineMatches: Array<{ lineNumber: number; line: string }>;
                    tagOnlyMatch: boolean;
                } => value !== null
            );

        const lines: string[] = [
            `Search query: ${query}`,
            `Parsed search terms: ${searchTerms.join(', ')}`,
            '',
            '## Matching classes',
            ...(matchingClasses.length > 0
                ? matchingClasses.map(({ className, matchingGlyphs }) =>
                      matchingGlyphs.length > 0
                          ? `- @${className} (matching glyphs: ${matchingGlyphs.join(', ')})`
                          : `- @${className}`
                  )
                : ['- (none)']),
            '',
            '## Matching features',
            ...(matchingFeatures.length > 0
                ? matchingFeatures.flatMap((feature) => {
                      const featureLines = [
                          `- ${feature.tag} # index ${feature.index}`
                      ];

                      if (feature.lineMatches.length > 0) {
                          featureLines.push(
                              ...feature.lineMatches.map(
                                  ({ lineNumber, line }) =>
                                      `  - line ${lineNumber}: ${line || '(blank line)'}`
                              )
                          );
                      } else if (feature.tagOnlyMatch) {
                          featureLines.push(
                              '  - tag/code-level match, but no individual code line matched directly'
                          );
                      }

                      return featureLines;
                  })
                : ['- (none)'])
        ];

        return lines.join('\n');
    }

    getFontFeatureSourceOrder(): string[] {
        const font = (window as any).currentFontModel;
        if (!font?.features?.features) {
            return [];
        }

        return font.features.features
            .map(([tag]: [string, unknown]) => tag)
            .filter((tag: string): tag is string => typeof tag === 'string');
    }

    extractFontLanguageSystems(): string[] {
        const font = (window as any).currentFontModel;
        if (!font?.features) {
            return ['DFLT'];
        }

        const scripts = new Set<string>();
        scripts.add('DFLT');

        const allCode: string[] = [];

        if (font.features.prefixes) {
            Object.values(font.features.prefixes).forEach((prefix: any) => {
                if (prefix?.code) {
                    allCode.push(prefix.code);
                }
            });
        }

        if (font.features.features) {
            font.features.features.forEach(([, codeData]: [string, any]) => {
                if (codeData?.code) {
                    allCode.push(codeData.code);
                }
            });
        }

        const languageSystemRegex = /languagesystem\s+(\w+)\s+\w+/gi;
        allCode.forEach((code) => {
            let match: RegExpExecArray | null;
            while ((match = languageSystemRegex.exec(code)) !== null) {
                scripts.add(match[1]);
            }
        });

        return Array.from(scripts).sort();
    }

    getShapersInUse(): Map<string, string[]> {
        const supportedScripts = this.extractFontLanguageSystems();
        const shaperMap = new Map<string, string[]>();

        supportedScripts.forEach((script) => {
            const shaper = SCRIPT_TO_SHAPER[script] || 'default';
            if (!shaperMap.has(shaper)) {
                shaperMap.set(shaper, []);
            }
            shaperMap.get(shaper)!.push(script);
        });

        return new Map(
            Array.from(shaperMap.entries()).sort(([left], [right]) =>
                left.localeCompare(right)
            )
        );
    }

    categorizeFeaturesForShaper(
        features: Array<[string, any]>,
        executionOrder: string[]
    ): {
        usedByShaper: Array<{ tag: string; index: number }>;
        discretionary: Array<{ tag: string; index: number }>;
        postUserFeatures: Array<{ tag: string; index: number }>;
        notUsedByShaper: Array<{ tag: string; index: number }>;
    } {
        const userFeaturesIndex = executionOrder.indexOf(
            '--- USER FEATURES ---'
        );

        let preUserFeatures: string[] = [];
        let postUserFeaturesList: string[] = [];

        if (userFeaturesIndex >= 0) {
            preUserFeatures = executionOrder
                .slice(0, userFeaturesIndex)
                .filter((feature) => !feature.startsWith('---'));
            postUserFeaturesList = executionOrder
                .slice(userFeaturesIndex + 1)
                .filter((feature) => !feature.startsWith('---'));
        } else {
            preUserFeatures = executionOrder.filter(
                (feature) => !feature.startsWith('---')
            );
        }

        const preUserFeaturesSet = new Set(preUserFeatures);
        const postUserFeaturesSet = new Set(postUserFeaturesList);

        const usedByShaper: Array<{ tag: string; index: number }> = [];
        const discretionary: Array<{ tag: string; index: number }> = [];
        const postUserFeatures: Array<{ tag: string; index: number }> = [];
        const notUsedByShaper: Array<{ tag: string; index: number }> = [];

        features.forEach(([tag], index) => {
            if (isDiscretionary(tag)) {
                discretionary.push({ tag, index });
                return;
            }

            if (preUserFeaturesSet.has(tag)) {
                usedByShaper.push({ tag, index });
                return;
            }

            if (postUserFeaturesSet.has(tag)) {
                postUserFeatures.push({ tag, index });
                return;
            }

            notUsedByShaper.push({ tag, index });
        });

        usedByShaper.sort(
            (left, right) =>
                preUserFeatures.indexOf(left.tag) -
                preUserFeatures.indexOf(right.tag)
        );
        discretionary.sort((left, right) => left.index - right.index);
        postUserFeatures.sort(
            (left, right) =>
                postUserFeaturesList.indexOf(left.tag) -
                postUserFeaturesList.indexOf(right.tag)
        );
        notUsedByShaper.sort((left, right) =>
            left.tag.localeCompare(right.tag)
        );

        return {
            usedByShaper,
            discretionary,
            postUserFeatures,
            notUsedByShaper
        };
    }

    formatFeatureSection(
        title: string,
        features: Array<{ tag: string; index: number }>
    ): string[] {
        return [
            `### ${title}`,
            ...(features.length > 0
                ? features.map(
                      (feature) => `- ${feature.tag} # index ${feature.index}`
                  )
                : ['- (empty)']),
            ''
        ];
    }

    getFontOpenTypeInfo(): string {
        const font = (window as any).currentFontModel;
        if (!font) {
            throw new Error('No font is currently open.');
        }

        const features: Array<[string, any]> = font.features?.features || [];
        const sourceOrder = this.getFontFeatureSourceOrder();
        const shapersInUse = this.getShapersInUse();

        const lines: string[] = [
            'OpenType shaping order depends on the script-specific HarfBuzz shaper used for the current script, not on the raw order in which features are defined in the font.',
            '',
            'Other shaping engines besides HarfBuzz exist and may handle feature execution differently. Counterpunch is explicitly based on HarfBuzz, so the shaper ordering described here is HarfBuzz-specific and matches Counterpunch.',
            '',
            'The feature order below is the explicit source order as defined in the font. This is not the order in which shaping executes those features.',
            '',
            'One feature may be defined several times in the font under the same tag but with different instructions each. The shaper will execute these in the order they are defined in the font, which is why some features may appear several times in the shaper-specific sections below.',
            '',
            'The indices shown here and in the shaper-specific sections refer to the feature array as defined in the font.',
            'Since one feature may be defined several times in a font under the same tag, it is best to retrieve a feature by its index in Python code instead of looping over the feature names. Example: `font.features.features[3]` instead of searching for a feature with a specific tag, since multiple features may have the same tag.',
            '',
            '## Feature order as defined in the font',
            ...(sourceOrder.length > 0
                ? sourceOrder.map((tag, index) => `${index}. ${tag}`)
                : ['(empty)']),
            '',
            'For each shaper in use below, the output is split into up to four sections exactly like the features editor sidebar in the UI:',
            '- `Used by X shaper`: required features that this HarfBuzz shaper uses before the user-features split, ordered by the shaper. These features are not accessible in typesetting applications as user-controllable features but are controlled by the shaper based on the language of the text inferred either explicitly or implicitly.',
            '- `Discretionary (sortable)`: user-controllable features, ordered by the user-defined source sorting in the font editor. Typesetting applications typically only allow activating these discretionary features, so these are the only features that can be user-controlled in those applications. The discretionary section is sorted by the user-defined source order in the font, and also executed by the shaper in this order, which is why order matters here. If glyph substitutions are not reachable, the discretionary feature order could be a culprit.',
            '- `Used by X shaper, continued`: required features that this HarfBuzz shaper uses after the user-features split, ordered by the shaper. These features are not accessible in typesetting applications as user-controllable features but are controlled by the shaper based on the language of the text inferred either explicitly or implicitly.',
            '- `Inactive for X shaper`: features present in the font but unused by that shaper, listed as the inactive remainder for that shaper.',
            ''
        ];

        if (shapersInUse.size === 0) {
            lines.push('No shapers are currently in use for this font.');
            return lines.join('\n');
        }

        for (const [shaper, scripts] of shapersInUse.entries()) {
            const shaperDisplayName =
                shaper.charAt(0).toUpperCase() + shaper.slice(1);
            const categorized = this.categorizeFeaturesForShaper(
                features,
                getFeatureExecutionOrder(shaper)
            );

            lines.push(`## ${shaperDisplayName} shaper`);
            lines.push(
                `Scripts in use for this shaper: ${scripts.join(', ') || '(none)'}`
            );
            lines.push('');
            lines.push(
                ...this.formatFeatureSection(
                    `Used by ${shaperDisplayName} shaper`,
                    categorized.usedByShaper
                )
            );
            lines.push(
                ...this.formatFeatureSection(
                    'Discretionary (sortable)',
                    categorized.discretionary
                )
            );
            lines.push(
                ...this.formatFeatureSection(
                    `Used by ${shaperDisplayName} shaper, continued`,
                    categorized.postUserFeatures
                )
            );
            lines.push(
                ...this.formatFeatureSection(
                    `Inactive for ${shaperDisplayName} shaper`,
                    categorized.notUsedByShaper
                )
            );
        }

        return lines.join('\n');
    }

    createHeaderToolCallsElement(toolCalls: any[]): HTMLElement {
        const wrapper = document.createElement('div');
        wrapper.style.cssText =
            'min-width:260px;max-width:420px;padding:4px;color:var(--text-primary);';

        const title = document.createElement('div');
        title.textContent = 'Tool calls';
        title.style.cssText =
            'font-size:12px;font-weight:600;margin-bottom:8px;color:var(--text-primary);';
        wrapper.appendChild(title);

        if (toolCalls.length === 0) {
            const empty = document.createElement('div');
            empty.textContent = 'No tool calls recorded.';
            empty.style.cssText = 'font-size:11px;color:var(--text-tertiary);';
            wrapper.appendChild(empty);
            return wrapper;
        }

        for (const call of toolCalls) {
            const row = document.createElement('div');
            row.style.cssText =
                'display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 0;border-top:1px solid var(--border-primary);';

            const left = document.createElement('div');
            left.style.cssText = 'display:flex;align-items:center;gap:6px;';

            const name = document.createElement('span');
            name.textContent = call.name;
            name.style.cssText =
                'font-size:11px;font-family:var(--font-families-mono);color:var(--text-primary);';
            left.appendChild(name);

            if (this.toolCallHasNoArguments(call.args)) {
                const infoBtn = document.createElement('button');
                infoBtn.className = 'agent-tool-call-info-btn';
                infoBtn.textContent = 'ⓘ';
                infoBtn.title = 'Show tool output';
                this.attachPopup(
                    infoBtn,
                    () =>
                        this.createToolCallOutputElement(
                            call.name,
                            call.result,
                            call.timeLabel
                        ),
                    'right',
                    520
                );
                left.appendChild(infoBtn);
            }

            const meta = document.createElement('span');
            meta.textContent = this.toolCallHasNoArguments(call.args)
                ? 'no arguments'
                : `${Object.keys(call.args || {}).length} args`;
            meta.style.cssText =
                'font-size:10px;color:var(--text-tertiary);white-space:nowrap;';

            row.appendChild(left);
            row.appendChild(meta);
            wrapper.appendChild(row);
        }

        return wrapper;
    }

    ensureHeaderToolCallsButton(header: HTMLElement, toolCalls: any[]) {
        let button = header.querySelector(
            '.agent-message-info-btn'
        ) as HTMLButtonElement | null;

        if (!button) {
            button = document.createElement('button');
            button.className =
                'agent-tool-call-info-btn agent-message-info-btn';
            button.textContent = 'ⓘ';
            button.title = 'Show tool calls';
            button.style.marginLeft = '2px';
            header.appendChild(button);
            this.attachPopup(
                button,
                () => this.createHeaderToolCallsElement(toolCalls),
                'bottom-end',
                440
            );
        }

        button.style.display = toolCalls.length > 0 ? 'inline-flex' : 'none';
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
            const shell = this.createAgentMessageShell();
            shell.body.innerHTML =
                typeof marked !== 'undefined'
                    ? marked.parse(content)
                    : this.escapeHtml(content);
            this.messagesContainer.appendChild(shell.messageDiv);
            this.messagesContainer.scrollTop =
                this.messagesContainer.scrollHeight;
            return;
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
                    setActiveAgentPythonExecution(this.activePromptContext);
                    await pyodide.runPythonAsync(code);
                    setActiveAgentPythonExecution(null);
                    output = await pyodide.runPythonAsync(`
output = _agent_output_buffer.getvalue()
sys.stdout = _agent_original_stdout
del _agent_output_buffer
del _agent_original_stdout
output
                    `);
                } catch (err: any) {
                    setActiveAgentPythonExecution(null);
                    // Restore stdout on error
                    await pyodide.runPythonAsync(`
if '_agent_original_stdout' in dir():
    sys.stdout = _agent_original_stdout
                    `);
                    throw new Error(`Python error: ${err.message}`);
                } finally {
                    setActiveAgentPythonExecution(null);
                }

                return output || '(no output)';
            }
            case 'get_editor_state': {
                const sm = (window as any).stateManager;
                const fm = (window as any).fontManager;
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

                const featureStateByTag = Object.fromEntries(
                    [...allFeatureTags]
                        .sort()
                        .map((tag) => [tag, featuresIn[tag] === true])
                );

                const userspaceLocationRaw =
                    s.editor_variation_location &&
                    typeof s.editor_variation_location === 'object'
                        ? s.editor_variation_location
                        : {};
                const userspaceLocation = Object.fromEntries(
                    Object.entries(userspaceLocationRaw).filter(
                        ([, value]) =>
                            typeof value === 'number' && Number.isFinite(value)
                    )
                ) as Record<string, number>;

                const axes = fm?.currentFontModel?.axes || [];
                const designspaceLocation = userspaceToDesignspace(
                    userspaceLocation as any,
                    axes
                );
                const textBufferRaw = String(s.editor_text_buffer || '');
                const textRunEditor = (window as any).glyphCanvas
                    ?.textRunEditor;
                const textRunStateMatches =
                    textRunEditor?.textBuffer === textBufferRaw;
                // The state snapshot is authoritative; only reuse parsed UI state
                // when it was derived from the same raw buffer.
                const textBufferDisplay =
                    textRunStateMatches &&
                    typeof textRunEditor.displayTextBuffer === 'string'
                        ? textRunEditor.displayTextBuffer
                        : textBufferRaw.replace(/\/\//g, '/');
                const explicitGlyphTokens = textRunStateMatches
                    ? textRunEditor.explicitGlyphTokens.map(
                          ({
                              name,
                              start,
                              end
                          }: {
                              name: string;
                              start: number;
                              end: number;
                          }) => ({ name, start, end })
                      )
                    : [];
                const liveGlyphNameBuffer = textRunStateMatches
                    ? textRunEditor.glyphNameBuffer
                    : null;
                const liveGlyphBuffer = textRunStateMatches
                    ? textRunEditor.shapedGlyphs
                    : null;
                const hasLiveShapingState =
                    Array.isArray(liveGlyphNameBuffer) &&
                    Array.isArray(liveGlyphBuffer);
                const glyphs = hasLiveShapingState
                    ? liveGlyphNameBuffer.join(' ')
                    : s.editor_harfbuzz_glyph_names || '';
                const gids = hasLiveShapingState
                    ? liveGlyphBuffer.map((glyph: { g?: number }) =>
                          String(glyph.g ?? '')
                      )
                    : s.editor_harfbuzz_gids || '';
                const advances = hasLiveShapingState
                    ? liveGlyphBuffer.map((glyph: { ax?: number }) =>
                          String(glyph.ax ?? '')
                      )
                    : s.editor_harfbuzz_ax || '';
                const clusters = hasLiveShapingState
                    ? liveGlyphBuffer.map((glyph: { cl?: number }) =>
                          String(glyph.cl ?? '')
                      )
                    : s.editor_harfbuzz_cl || '';

                return JSON.stringify(
                    {
                        textBuffer: textBufferRaw,
                        textBufferRaw,
                        textBufferDisplay,
                        textBufferInterpretationIsCurrent: textRunStateMatches,
                        explicitGlyphTokens,
                        textBufferSyntax:
                            'Raw syntax: // is one literal slash; /glyphname is an explicit glyph reference only when it resolves. Never infer // unless textBufferRaw contains it.',
                        glyphs,
                        gids: Array.isArray(gids) ? gids.join(' ') : gids,
                        advances: Array.isArray(advances)
                            ? advances.join(' ')
                            : advances,
                        clusters: Array.isArray(clusters)
                            ? clusters.join(' ')
                            : clusters,
                        shapingStateSource: hasLiveShapingState
                            ? 'live-text-run'
                            : 'state-manager',
                        userspaceLocation,
                        designspaceLocation,
                        featureStateByTag,
                        features,
                        file: s.editor_file || ''
                    },
                    null,
                    2
                );
            }
            case 'set_prompt_history_summary': {
                const summary = String(args.summary || '').trim();
                if (!summary) {
                    throw new Error('Missing required parameter: summary');
                }
                if (!this.activePromptContext) {
                    throw new Error('No agent prompt is currently running');
                }
                this.activePromptContext.historySummary = summary;
                return 'Prompt history summary recorded.';
            }
            case 'get_font_opentype_info': {
                return this.getFontOpenTypeInfo();
            }
            case 'search_font_opentype_classes_and_features': {
                const query = args.query;
                if (query == null) {
                    throw new Error('Missing required parameter: query');
                }

                return this.searchFontOpenTypeClassesAndFeatures(String(query));
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
                await fm2.setEnabledFeatures(featureTags);

                const activeFeatures = Object.entries(fm2.featureSettings)
                    .filter(([, enabled]) => enabled)
                    .map(([tag]) => tag);

                return `Features updated. Active: ${activeFeatures.length > 0 ? activeFeatures.join(', ') : '(none)'}`;
            }
            case 'compile_and_shape_font': {
                const fm = (window as any).fontManager;
                const fc = (window as any).fontCompilation;
                const shapeWithFontDetailed = (window as any)
                    .shapeTextWithFontDetailed;

                if (!fm || !fc || !shapeWithFontDetailed) {
                    throw new Error(
                        'compile_and_shape_font dependencies are not available yet.'
                    );
                }
                if (window.windowRole && !window.windowRole.isMainWindow()) {
                    throw new Error(
                        'compile_and_shape_font is only available in the main window.'
                    );
                }
                const isEditPreviewActive = () => {
                    const outlineEditor = window.glyphCanvas?.outlineEditor;
                    return (
                        outlineEditor?.draggingSomething ||
                        outlineEditor?.isPreviewMode ||
                        outlineEditor?.hasPendingKeyboardPreviewCommit()
                    );
                };
                if (isEditPreviewActive()) {
                    throw new Error(
                        'compile_and_shape_font is unavailable while an edit preview is active. Retry after the edit commits.'
                    );
                }

                if (typeof args.text !== 'string') {
                    throw new Error(
                        'Missing required parameter: text (string). Use an empty string for full-font mode.'
                    );
                }
                const text = args.text;
                const fullFontMode = text.length === 0;

                if (
                    args.featureOverrides != null &&
                    (typeof args.featureOverrides !== 'object' ||
                        Array.isArray(args.featureOverrides))
                ) {
                    throw new Error(
                        'featureOverrides must be an object of { tag: boolean } when provided.'
                    );
                }
                const featureOverridesInput = (args.featureOverrides ||
                    {}) as Record<string, unknown>;
                const featureOverrides: Record<string, boolean> = {};
                for (const [rawTag, enabled] of Object.entries(
                    featureOverridesInput
                )) {
                    const tag = rawTag.trim();
                    if (tag.length === 0 || typeof enabled !== 'boolean') {
                        continue;
                    }
                    featureOverrides[tag] = enabled;
                }
                const featureOverrideList = Object.entries(featureOverrides)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([tag, enabled]) => `${tag}=${enabled ? 1 : 0}`);
                const featureOverrideString =
                    featureOverrideList.length > 0
                        ? featureOverrideList.join(',')
                        : undefined;

                const hasUserspaceLocation = args.userspaceLocation != null;
                const hasDesignspaceLocation = args.designspaceLocation != null;
                if (hasUserspaceLocation && hasDesignspaceLocation) {
                    throw new Error(
                        'Provide at most one of userspaceLocation or designspaceLocation, not both.'
                    );
                }

                if (
                    (hasUserspaceLocation &&
                        typeof args.userspaceLocation !== 'object') ||
                    Array.isArray(args.userspaceLocation)
                ) {
                    throw new Error(
                        'userspaceLocation must be an object when provided.'
                    );
                }
                if (
                    (hasDesignspaceLocation &&
                        typeof args.designspaceLocation !== 'object') ||
                    Array.isArray(args.designspaceLocation)
                ) {
                    throw new Error(
                        'designspaceLocation must be an object when provided.'
                    );
                }

                const axes = fm?.currentFontModel?.axes || [];
                const explicitUserspaceLocation = Object.fromEntries(
                    Object.entries(
                        (args.userspaceLocation || {}) as Record<
                            string,
                            unknown
                        >
                    ).filter(
                        ([, value]) =>
                            typeof value === 'number' && Number.isFinite(value)
                    )
                ) as Record<string, number>;

                const explicitDesignspaceLocation = Object.fromEntries(
                    Object.entries(
                        (args.designspaceLocation || {}) as Record<
                            string,
                            unknown
                        >
                    ).filter(
                        ([, value]) =>
                            typeof value === 'number' && Number.isFinite(value)
                    )
                ) as Record<string, number>;

                const userspaceLocation = hasDesignspaceLocation
                    ? (designspaceToUserspace(
                          explicitDesignspaceLocation as any,
                          axes
                      ) as Record<string, number>)
                    : explicitUserspaceLocation;
                const designspaceLocation = hasUserspaceLocation
                    ? userspaceToDesignspace(
                          explicitUserspaceLocation as any,
                          axes
                      )
                    : explicitDesignspaceLocation;

                const getFontRevision = () => {
                    const currentFont = fm?.currentFont;
                    return {
                        pluginId: currentFont?.sourcePlugin?.getId?.() || '',
                        fontPath: currentFont?.path || '',
                        changeVersion:
                            typeof currentFont?.changeVersion === 'number'
                                ? currentFont.changeVersion
                                : null
                    };
                };
                await awaitStableCompileAndShapeFontWorkerState(
                    fm as CompileAndShapeFontManagerState,
                    fc as CompileAndShapeFontWorkerState,
                    () => buildCompileAndShapeFontRevisionKey(getFontRevision())
                );
                if (isEditPreviewActive()) {
                    throw new Error(
                        'compile_and_shape_font is unavailable while an edit preview is active. Retry after the edit commits.'
                    );
                }
                const fontRevision = getFontRevision();
                const fontRevisionKey =
                    buildCompileAndShapeFontRevisionKey(fontRevision);
                const cacheKey = buildCompileAndShapeFontCacheKey(
                    fontRevision,
                    text
                );

                const allFeatureTags = Object.keys(featureOverrides).sort();
                const features = allFeatureTags.map((tag) => ({
                    tag,
                    active: featureOverrides[tag] === true,
                    inSubset: !fullFontMode,
                    description: getFeatureDescription(tag) || tag
                }));

                const compileResolution =
                    await resolveCompileAndShapeFontCompilation({
                        cacheEntry: this.compileAndShapeFontCache,
                        fontRevisionKey,
                        cacheKey,
                        fullFontMode,
                        text,
                        shapeOptions: {
                            features: featureOverrideString,
                            variationLocation: userspaceLocation
                        },
                        compileFullFont: async () => {
                            const fullCommittedFont = await fc.compileCached(
                                'full',
                                'debug-full-font.ttf'
                            );
                            return fullCommittedFont.result;
                        },
                        shapeSubsetWithFont: shapeWithFontDetailed,
                        compileSubsetFont: async (subsetGlyphs) => {
                            const compileResult =
                                await fc.compileCommittedDebugFont(
                                    subsetGlyphs
                                );
                            return compileResult.result;
                        }
                    });

                const shaped = await shapeWithFontDetailed(
                    compileResolution.compiledFont,
                    text,
                    {
                        features: featureOverrideString,
                        variationLocation: userspaceLocation
                    }
                );

                const editorStateOutput = {
                    textBuffer: text,
                    glyphs: shaped.glyphs.join(' '),
                    gids: shaped.gids.join(' '),
                    advances: shaped.advances.join(' '),
                    clusters: shaped.clusters.join(' '),
                    fontRevision,
                    userspaceLocation,
                    designspaceLocation,
                    featureStateByTag: Object.fromEntries(
                        allFeatureTags.map((tag) => [
                            tag,
                            featureOverrides[tag]
                        ])
                    ),
                    features,
                    file: fm?.currentFont?.path || ''
                };
                const result = JSON.stringify(editorStateOutput, null, 2);
                this.compileAndShapeFontCache = compileResolution.cacheEntry;
                return result;
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
        signal?: AbortSignal,
        previousGenerationIds?: string[]
    ): Promise<any> {
        const sessionToken = window.authManager?.getSessionToken();
        const headers: Record<string, string> = {
            'Content-Type': 'application/json'
        };
        if (sessionToken) headers['Authorization'] = `Bearer ${sessionToken}`;

        const body: Record<string, any> = {
            messages,
            tools: AGENT_TOOLS,
            systemPrompt: await this.getRuntimeSystemPrompt(),
            stream: true
        };
        if (previousGenerationIds && previousGenerationIds.length > 0) {
            body.previousGenerationIds = previousGenerationIds;
        }

        let response: Response;
        try {
            response = await fetch(`${this.getWebsiteURL()}/api/ai/agent`, {
                method: 'POST',
                credentials: 'include',
                headers,
                signal,
                body: JSON.stringify(body)
            });
        } catch (err: any) {
            // Re-throw AbortError so the caller's stop-button handler works
            if (err.name === 'AbortError') throw err;
            return {
                text: '',
                toolCalls: null,
                done: false,
                connectionDropped: true,
                dropError: err.message || 'Network request failed'
            };
        }

        if (!response.ok) {
            const errBody = await response
                .json()
                .catch(() => ({ error: 'Request failed' }));
            throw new Error(errBody.error || `HTTP ${response.status}`);
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error('Empty response');

        const decoder = new TextDecoder();
        let buf = '';
        let streamedText = '';
        let toolCalls: any[] | null = null;
        let generationId: string | null = null;

        while (true) {
            let readResult;
            try {
                readResult = await reader.read();
            } catch (err: any) {
                // Re-throw AbortError so the caller's stop-button handler works
                if (err.name === 'AbortError') throw err;
                // Connection dropped mid-stream — return partial text
                // so the caller can rehydrate and continue
                return {
                    text: streamedText,
                    toolCalls,
                    done: false,
                    connectionDropped: true,
                    dropError: err.message || 'Connection lost',
                    generationId
                };
            }
            const { done, value } = readResult;
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
                    // Capture OpenRouter generationId from every event
                    if (parsed.generationId) {
                        generationId = parsed.generationId;
                    }
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
                            generationId: generationId || parsed.generationId,
                            cumulativeUsage: parsed.cumulativeUsage,
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
        return { text: streamedText, toolCalls, done: false, generationId };
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
        this.activePromptContext = {
            id: `agent-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            allowFontEdits: this.allowFontEdits,
            historySummary: null
        };
        this.updateAgentEditToggle();
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
        // Track generationIds across retry legs for cumulative cost reporting
        const previousGenerationIds: string[] = [];

        try {
            let messageDiv: HTMLDivElement | null = null;
            let bodyDiv: HTMLDivElement | null = null;
            let headerDiv: HTMLDivElement | null = null;
            let currentRoundIndex = -1;
            const executedToolCalls: any[] = [];

            const ensureMessageShell = () => {
                if (!messageDiv) {
                    const shell = this.createAgentMessageShell();
                    messageDiv = shell.messageDiv;
                    headerDiv = shell.header;
                    bodyDiv = shell.body;
                    this.messagesContainer!.appendChild(messageDiv);
                }
            };

            while (true) {
                currentRoundIndex++;
                const result = await this.streamRound(
                    conversationMessages,
                    (chunk) => {
                        this.clearInitialStatus();
                        ensureMessageShell();

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
                    signal,
                    previousGenerationIds.length > 0
                        ? [...previousGenerationIds]
                        : undefined
                );

                // Successful round — reset reconnect counter and clear
                // previous generation IDs (their cost has now been captured
                // in cumulativeUsage or they're no longer relevant)
                this._reconnectAttempts = 0;

                // ── Track usage for this round ──
                // On retry legs, the backend returns cumulativeUsage which
                // is the total across ALL prior dropped legs + current leg.
                // We compute the delta (dropped legs = cumulative - current)
                // and accumulate that separately, then accumulate the current
                // leg normally. This avoids double-counting while capturing
                // the costs of legs whose SSE never completed.
                const roundUsage = result.usage;
                if (result.cumulativeUsage && roundUsage) {
                    const droppedPrompt =
                        (result.cumulativeUsage.prompt_tokens || 0) -
                        (roundUsage.prompt_tokens || 0);
                    const droppedCompletion =
                        (result.cumulativeUsage.completion_tokens || 0) -
                        (roundUsage.completion_tokens || 0);
                    const droppedCost =
                        (result.cumulativeUsage.total_cost || 0) -
                        (roundUsage.total_cost || 0);
                    if (droppedPrompt > 0 || droppedCompletion > 0) {
                        this.accumulateSessionTotals({
                            prompt_tokens: droppedPrompt,
                            completion_tokens: droppedCompletion,
                            total_tokens: droppedPrompt + droppedCompletion,
                            cached_tokens:
                                (result.cumulativeUsage.cached_tokens || 0) -
                                (roundUsage.cached_tokens || 0),
                            total_cost: droppedCost
                        });
                    }
                    this.accumulateSessionTotals(roundUsage);
                    // Clear previous gen IDs — their costs are now captured
                    // in sessionTotals via the delta above
                    previousGenerationIds.length = 0;
                } else if (roundUsage) {
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

                // ── Connection dropped mid-stream — auto-retry in-place ──
                if (result.connectionDropped) {
                    const partialText =
                        roundTexts.filter(Boolean).join(' ').trim() ||
                        result.text ||
                        '';
                    if (partialText) {
                        conversationMessages.push({
                            role: 'assistant',
                            content: partialText
                        });
                        this.conversationMessages = conversationMessages;
                    }
                    // Save the generationId from the dropped leg so the retry
                    // request includes it — the backend will query OpenRouter's
                    // generation API to include its usage in cumulativeUsage
                    if (result.generationId) {
                        previousGenerationIds.push(result.generationId);
                    }
                    if (!this._reconnectAttempts) this._reconnectAttempts = 0;
                    this._reconnectAttempts++;
                    if (this._reconnectAttempts <= 3) {
                        const reconnMsg = document.createElement('div');
                        reconnMsg.className = 'agent-connection-dropped';
                        reconnMsg.textContent = `🔄 Reconnecting... (attempt ${this._reconnectAttempts}/3)`;
                        const appendTarget: HTMLElement | null =
                            bodyDiv || this.messagesContainer;
                        if (appendTarget) appendTarget.appendChild(reconnMsg);
                        // Back off: 500ms, 1s, 1.5s
                        await new Promise((r) =>
                            setTimeout(r, 500 * this._reconnectAttempts)
                        );
                        // Remove the notice before retry so the seam is seamless
                        reconnMsg.remove();
                        // Retry SAME round into SAME shell —
                        // conversationMessages now ends with the partial
                        // assistant response, so the model picks up from
                        // where it left off
                        currentRoundIndex--; // undo the increment
                        continue;
                    }
                    // Max retries exhausted — give up
                    const exhaustedMsg = document.createElement('div');
                    exhaustedMsg.className = 'agent-connection-dropped';
                    exhaustedMsg.textContent =
                        '⚠️ Connection lost after 3 retries. Type "continue" to resume.';
                    const appendTarget: HTMLElement | null =
                        bodyDiv || this.messagesContainer;
                    if (appendTarget) appendTarget.appendChild(exhaustedMsg);
                    this.hideStreamIndicator();
                    this.isStreaming = false;
                    this.activePromptContext = null;
                    this.updateAgentEditToggle();
                    if (this.sendButton)
                        (this.sendButton as HTMLButtonElement).disabled = false;
                    if (this.promptInput) this.promptInput.focus();
                    this.scrollToBottomIfNear();
                    return;
                }

                if (result.toolCalls && result.toolCalls.length > 0) {
                    // Ensure the agent message container exists even when the model
                    // responds with only a tool call and no preamble text
                    ensureMessageShell();

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

                            const timeLabel = new Date().toLocaleTimeString();

                            this.attachPopup(
                                infoBtn,
                                () =>
                                    this.createToolCallMetaElement(
                                        toolCall.function.name,
                                        args,
                                        toolResult,
                                        timeLabel
                                    ),
                                'right',
                                520
                            );

                            executedToolCalls.push({
                                name: toolCall.function.name,
                                args,
                                result: toolResult,
                                timeLabel
                            });
                            if (headerDiv) {
                                this.ensureHeaderToolCallsButton(
                                    headerDiv,
                                    executedToolCalls
                                );
                            }

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
                    this.abortController = null;
                    this.activePromptContext = null;
                    this.updateAgentEditToggle();
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
        this.activePromptContext = null;
        this.updateAgentEditToggle();
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
        this._reconnectAttempts = 0;
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

import { Logger } from './logger';
import {
    openLinkedEditorWindow,
    prepareLinkedWindowOpen,
    type LinkedWindowLaunchInfo
} from './window-buttons';

const console = new Logger('AutomationRuntime');

const AUTOMATION_CHANNEL_PREFIX = 'counterpunch-automation:';
const DEFAULT_OPEN_TIMEOUT_MS = 30000;
const DEFAULT_QUERY_TIMEOUT_MS = 400;

type FontReadyDetail = {
    path?: string;
    openSessionId?: string;
    openedAt?: number;
};

export interface AutomationWindowMetadata {
    index: number;
    role: 'main' | 'linked';
    roleLabel: string;
    instanceId: string;
    sessionId: string;
    fontPath: string | null;
    textBuffer: string;
    focusedView: string | null;
    activeGlyphName: string | null;
    openSessionId: string | null;
    openedAt: number | null;
    isDirty: boolean;
    title: string;
}

interface MetadataRequestMessage {
    type: 'metadata-request';
    requestId: string;
    sourceInstanceId: string;
}

interface MetadataResponseMessage {
    type: 'metadata-response';
    requestId: string;
    metadata: AutomationWindowMetadata;
}

interface ActivateRequestMessage {
    type: 'activate-request';
    requestId: string;
    sourceInstanceId: string;
    targetIndex: number;
}

interface ActivateResponseMessage {
    type: 'activate-response';
    requestId: string;
    metadata: AutomationWindowMetadata;
}

interface LinkedWindowReadyMessage {
    type: 'linked-window-ready';
    metadata: AutomationWindowMetadata;
}

type AutomationMessage =
    | MetadataRequestMessage
    | MetadataResponseMessage
    | ActivateRequestMessage
    | ActivateResponseMessage
    | LinkedWindowReadyMessage;

interface PendingReadyWaiter {
    resolve: (metadata: AutomationWindowMetadata) => void;
    reject: (error: Error) => void;
    timeoutId: number;
}

interface CounterpunchAutomationApi {
    version: number;
    getWindowMetadata: () => Promise<AutomationWindowMetadata>;
    listLinkedWindows: (options?: {
        timeoutMs?: number;
    }) => Promise<AutomationWindowMetadata[]>;
    openFont: (options: { path: string; timeoutMs?: number }) => Promise<{
        path: string;
        openSessionId: string | null;
        window: AutomationWindowMetadata;
    }>;
    prepareLinkedWindowOpen: () => Promise<LinkedWindowLaunchInfo>;
    waitForLinkedWindowReady: (options: {
        index: number;
        timeoutMs?: number;
    }) => Promise<AutomationWindowMetadata>;
    openLinkedWindow: (options?: { timeoutMs?: number }) => Promise<{
        window: AutomationWindowMetadata;
    }>;
    activateLinkedWindow: (options: {
        index: number;
        timeoutMs?: number;
    }) => Promise<AutomationWindowMetadata>;
    callTool: (
        name: string,
        arguments_: Record<string, unknown>
    ) => Promise<unknown>;
}

const pendingMetadataCollectors = new Map<
    string,
    Map<number, AutomationWindowMetadata>
>();
const pendingActivationResolvers = new Map<
    string,
    {
        resolve: (metadata: AutomationWindowMetadata) => void;
        reject: (error: Error) => void;
        timeoutId: number;
    }
>();
const pendingReadyWaiters = new Map<number, PendingReadyWaiter>();
const knownWindowMetadata = new Map<number, AutomationWindowMetadata>();
let lastFontReadyDetail: FontReadyDetail | null = null;

function createId(): string {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
        window.setTimeout(resolve, ms);
    });
}

async function waitForPyodide(timeoutMs: number): Promise<void> {
    if (window.pyodide) {
        return;
    }

    const startedAt = performance.now();
    while (!window.pyodide) {
        if (performance.now() - startedAt >= timeoutMs) {
            throw new Error('Timed out waiting for Pyodide to initialize');
        }
        await wait(100);
    }
}

function getAutomationChannel(): BroadcastChannel | null {
    const sessionId = window.windowRole?.sessionId;
    if (!sessionId || typeof BroadcastChannel === 'undefined') {
        return null;
    }

    return new BroadcastChannel(`${AUTOMATION_CHANNEL_PREFIX}${sessionId}`);
}

const automationChannel = getAutomationChannel();

function getWindowIndex(): number {
    if (window.windowRole?.isMainWindow()) {
        return 0;
    }

    return window.windowRole?.linkedOrdinal ?? -1;
}

function getActiveGlyphName(): string | null {
    const glyphStack = String(window.stateManager?.editor_glyph_stack || '');
    if (glyphStack) {
        const deepestSegment = glyphStack.split('>').pop() || '';
        const glyphName = deepestSegment.split('@')[0] || '';
        if (glyphName) {
            return glyphName;
        }
    }

    return null;
}

function getWindowMetadata(): AutomationWindowMetadata {
    const currentFont = window.fontManager?.currentFont;
    const metadata: AutomationWindowMetadata = {
        index: getWindowIndex(),
        role: window.windowRole?.isMainWindow() ? 'main' : 'linked',
        roleLabel: window.windowRole?.getRoleLabel?.() || 'Unknown',
        instanceId: window.windowRole?.instanceId || 'unknown',
        sessionId: window.windowRole?.sessionId || 'unknown',
        fontPath: currentFont?.path || null,
        textBuffer: String(window.stateManager?.editor_text_buffer || ''),
        focusedView: window.getCurrentFocusedView?.() || null,
        activeGlyphName: getActiveGlyphName(),
        openSessionId: lastFontReadyDetail?.openSessionId || null,
        openedAt:
            typeof lastFontReadyDetail?.openedAt === 'number'
                ? lastFontReadyDetail.openedAt
                : null,
        isDirty: !!currentFont?.hasUnsavedChanges,
        title: document.title
    };

    if (metadata.index >= 0) {
        knownWindowMetadata.set(metadata.index, metadata);
    }

    return metadata;
}

async function focusCurrentWindow(): Promise<AutomationWindowMetadata> {
    try {
        window.focus();
    } catch {
        // Ignore focus failures in automation contexts.
    }

    const focusedView = window.getCurrentFocusedView?.();
    await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => {
            if (focusedView && typeof window.focusView === 'function') {
                try {
                    window.focusView(focusedView);
                } catch {
                    // Ignore view-focus failures and still resolve.
                }
            }
            resolve();
        });
    });

    return getWindowMetadata();
}

function postLinkedWindowReady(): void {
    if (!automationChannel || !window.windowRole?.isLinkedWindow()) {
        return;
    }

    automationChannel.postMessage({
        type: 'linked-window-ready',
        metadata: getWindowMetadata()
    } satisfies LinkedWindowReadyMessage);
}

function resolveReadyWaiter(metadata: AutomationWindowMetadata): void {
    const waiter = pendingReadyWaiters.get(metadata.index);
    if (!waiter) {
        return;
    }

    window.clearTimeout(waiter.timeoutId);
    pendingReadyWaiters.delete(metadata.index);
    waiter.resolve(metadata);
}

function handleAutomationMessage(message: AutomationMessage): void {
    switch (message.type) {
        case 'metadata-request':
            if (message.sourceInstanceId === window.windowRole?.instanceId) {
                return;
            }
            automationChannel?.postMessage({
                type: 'metadata-response',
                requestId: message.requestId,
                metadata: getWindowMetadata()
            } satisfies MetadataResponseMessage);
            break;

        case 'metadata-response': {
            const collector = pendingMetadataCollectors.get(message.requestId);
            if (!collector) {
                return;
            }
            collector.set(message.metadata.index, message.metadata);
            knownWindowMetadata.set(message.metadata.index, message.metadata);
            break;
        }

        case 'activate-request':
            if (message.targetIndex !== getWindowIndex()) {
                return;
            }
            void focusCurrentWindow().then((metadata) => {
                automationChannel?.postMessage({
                    type: 'activate-response',
                    requestId: message.requestId,
                    metadata
                } satisfies ActivateResponseMessage);
            });
            break;

        case 'activate-response': {
            const pending = pendingActivationResolvers.get(message.requestId);
            if (!pending) {
                return;
            }
            window.clearTimeout(pending.timeoutId);
            pendingActivationResolvers.delete(message.requestId);
            knownWindowMetadata.set(message.metadata.index, message.metadata);
            pending.resolve(message.metadata);
            break;
        }

        case 'linked-window-ready':
            knownWindowMetadata.set(message.metadata.index, message.metadata);
            resolveReadyWaiter(message.metadata);
            break;
    }
}

automationChannel?.addEventListener('message', (event) => {
    handleAutomationMessage(event.data as AutomationMessage);
});

window.addEventListener('fontReady', (event: Event) => {
    const detail = (event as CustomEvent<FontReadyDetail>).detail || {};
    lastFontReadyDetail = detail;
    const metadata = getWindowMetadata();
    knownWindowMetadata.set(metadata.index, metadata);
    postLinkedWindowReady();
});

function waitForFontReady(
    expectedPath: string,
    timeoutMs: number
): Promise<FontReadyDetail> {
    if (
        lastFontReadyDetail?.path === expectedPath &&
        window.fontManager?.currentFont?.path === expectedPath
    ) {
        return Promise.resolve(lastFontReadyDetail);
    }

    return new Promise((resolve, reject) => {
        const timeoutId = window.setTimeout(() => {
            window.removeEventListener('fontReady', onFontReady);
            reject(
                new Error(`Timed out waiting for fontReady for ${expectedPath}`)
            );
        }, timeoutMs);

        const onFontReady = (event: Event) => {
            const detail = (event as CustomEvent<FontReadyDetail>).detail || {};
            if (detail.path !== expectedPath) {
                return;
            }

            window.clearTimeout(timeoutId);
            window.removeEventListener('fontReady', onFontReady);
            resolve(detail);
        };

        window.addEventListener('fontReady', onFontReady);
    });
}

async function listLinkedWindows(options?: {
    timeoutMs?: number;
}): Promise<AutomationWindowMetadata[]> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
    const requestId = createId();
    const windowsByIndex = new Map<number, AutomationWindowMetadata>();
    const ownMetadata = getWindowMetadata();
    windowsByIndex.set(ownMetadata.index, ownMetadata);

    if (!automationChannel) {
        return [ownMetadata];
    }

    pendingMetadataCollectors.set(requestId, windowsByIndex);
    automationChannel.postMessage({
        type: 'metadata-request',
        requestId,
        sourceInstanceId: ownMetadata.instanceId
    } satisfies MetadataRequestMessage);

    await wait(timeoutMs);
    pendingMetadataCollectors.delete(requestId);

    return Array.from(windowsByIndex.values()).sort(
        (left, right) => left.index - right.index
    );
}

async function ensurePathAvailableForAutomation(
    plugin: {
        getId: () => string;
        getAdapter: () => { readFile?: (path: string) => Promise<unknown> };
    },
    path: string,
    timeoutMs: number
): Promise<void> {
    const adapter = plugin.getAdapter();
    if (typeof adapter.readFile !== 'function') {
        return;
    }

    try {
        await adapter.readFile(path);
        return;
    } catch (error) {
        if (plugin.getId() !== 'memory' || !window.loadExampleFonts) {
            throw error;
        }
    }

    await waitForPyodide(timeoutMs);
    await window.loadExampleFonts();
    await adapter.readFile(path);
}

async function openFont(options: {
    path: string;
    timeoutMs?: number;
}): Promise<{
    path: string;
    openSessionId: string | null;
    window: AutomationWindowMetadata;
}> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
    const requestedPath = options.path;
    if (!requestedPath || typeof requestedPath !== 'string') {
        throw new Error('open_font requires a non-empty path');
    }

    await window.waitForFileBrowserReady?.(timeoutMs);

    let fontPath = requestedPath;
    const openOptions: { sourcePluginOverride?: unknown } = {};
    const parsedFileUri = window.parseFileUri?.(requestedPath);
    if (parsedFileUri) {
        fontPath = parsedFileUri.path;
        const plugin = (window as any).pluginRegistry?.get?.(
            parsedFileUri.pluginId
        );
        if (!plugin) {
            throw new Error(
                `Unknown filesystem plugin: ${parsedFileUri.pluginId}`
            );
        }
        if (typeof plugin.isReady === 'function' && !(await plugin.isReady())) {
            throw new Error(
                `Filesystem plugin is not ready: ${parsedFileUri.pluginId}`
            );
        }
        await ensurePathAvailableForAutomation(plugin, fontPath, timeoutMs);
        openOptions.sourcePluginOverride = plugin;
    }

    const fontReadyPromise = waitForFontReady(fontPath, timeoutMs);
    await window.openFont(fontPath, undefined, openOptions);
    const detail = await fontReadyPromise;
    const metadata = getWindowMetadata();

    return {
        path: metadata.fontPath || fontPath,
        openSessionId: detail.openSessionId || null,
        window: metadata
    };
}

async function prepareLinkedWindowOpenCommand(): Promise<LinkedWindowLaunchInfo> {
    return prepareLinkedWindowOpen();
}

async function waitForLinkedWindowReady(options: {
    index: number;
    timeoutMs?: number;
}): Promise<AutomationWindowMetadata> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
    const cachedMetadata = knownWindowMetadata.get(options.index);
    if (cachedMetadata) {
        return cachedMetadata;
    }

    return new Promise((resolve, reject) => {
        const timeoutId = window.setTimeout(() => {
            pendingReadyWaiters.delete(options.index);
            reject(
                new Error(
                    `Timed out waiting for linked window ${options.index} readiness`
                )
            );
        }, timeoutMs);

        pendingReadyWaiters.set(options.index, {
            resolve,
            reject,
            timeoutId
        });
    });
}

async function openLinkedWindow(options?: { timeoutMs?: number }): Promise<{
    window: AutomationWindowMetadata;
}> {
    const launchInfo = prepareLinkedWindowOpen();
    const readyPromise = waitForLinkedWindowReady({
        index: launchInfo.linkedOrdinal,
        timeoutMs: options?.timeoutMs
    });
    const childWindow = openLinkedEditorWindow(launchInfo);
    if (!childWindow) {
        pendingReadyWaiters.delete(launchInfo.linkedOrdinal);
        throw new Error(
            'Failed to open linked window; browser blocked the popup'
        );
    }

    return {
        window: await readyPromise
    };
}

async function activateLinkedWindow(options: {
    index: number;
    timeoutMs?: number;
}): Promise<AutomationWindowMetadata> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
    const targetIndex = options.index;
    if (!Number.isInteger(targetIndex) || targetIndex < 0) {
        throw new Error('activate_linked_window requires a non-negative index');
    }

    if (targetIndex === getWindowIndex()) {
        return focusCurrentWindow();
    }

    if (!automationChannel) {
        throw new Error('Automation channel is not available in this window');
    }

    const requestId = createId();
    const ownMetadata = getWindowMetadata();

    return new Promise((resolve, reject) => {
        const timeoutId = window.setTimeout(() => {
            pendingActivationResolvers.delete(requestId);
            reject(
                new Error(
                    `Timed out waiting to activate linked window ${targetIndex}`
                )
            );
        }, timeoutMs);

        pendingActivationResolvers.set(requestId, {
            resolve,
            reject,
            timeoutId
        });

        automationChannel.postMessage({
            type: 'activate-request',
            requestId,
            sourceInstanceId: ownMetadata.instanceId,
            targetIndex
        } satisfies ActivateRequestMessage);
    });
}

async function callTool(
    name: string,
    arguments_: Record<string, unknown>
): Promise<unknown> {
    switch (name) {
        case 'open_font':
            return openFont({
                path: String(arguments_.path || ''),
                timeoutMs:
                    typeof arguments_.timeoutMs === 'number'
                        ? arguments_.timeoutMs
                        : undefined
            });
        case 'open_linked_window':
            return openLinkedWindow({
                timeoutMs:
                    typeof arguments_.timeoutMs === 'number'
                        ? arguments_.timeoutMs
                        : undefined
            });
        case 'list_linked_windows':
            return listLinkedWindows({
                timeoutMs:
                    typeof arguments_.timeoutMs === 'number'
                        ? arguments_.timeoutMs
                        : undefined
            });
        case 'activate_linked_window':
            return activateLinkedWindow({
                index: Number(arguments_.index),
                timeoutMs:
                    typeof arguments_.timeoutMs === 'number'
                        ? arguments_.timeoutMs
                        : undefined
            });
        default:
            throw new Error(`Unknown automation tool: ${name}`);
    }
}

const counterpunchAutomation: CounterpunchAutomationApi = {
    version: 1,
    getWindowMetadata: async () => getWindowMetadata(),
    listLinkedWindows,
    openFont,
    prepareLinkedWindowOpen: prepareLinkedWindowOpenCommand,
    waitForLinkedWindowReady,
    openLinkedWindow,
    activateLinkedWindow,
    callTool
};

window.counterpunchAutomation = counterpunchAutomation;
console.log('Counterpunch automation runtime initialized');

/**
 * CloudPlugin — FilesystemPlugin wrapper for CloudAdapter.
 *
 * Phase 1: eligibility check, openAsset, saveAs (seed DO), getAssets.
 * Exposed as window.cloudPlugin; window.cloudDebug kept for dev testing.
 */

import { FilesystemPlugin } from './filesystem-plugins';
import type {
    FileContextAction,
    FileContextTarget,
    TitleBarMenuItem
} from './filesystem-plugins';
import {
    CloudAdapter,
    CloudAdapterOptions,
    CloudConnectionStatus,
    normalizeCloudRoomWebSocketUrl
} from './cloud-adapter';
import { Path } from './babelfont-model';
import { ChangeBridge } from './change-bridge';
import { sanitizeBabelfontArrays, yDocToJson } from './change-bridge-ydoc';
import { Logger } from './logger';
import { resolveWebsiteURL } from './website-url';

const console = new Logger('CloudPlugin');

function getCloudRequestHeaders(
    extraHeaders: Record<string, string> = {}
): Record<string, string> {
    const headers = { ...extraHeaders };
    const sessionToken = window.authManager?.getSessionToken?.();
    if (sessionToken) {
        headers.Authorization = `Bearer ${sessionToken}`;
    }
    return headers;
}

function normalizeCloudExportForFontOpen(
    fontJson: Record<string, unknown>,
    operation: 'open' | 'save' = 'open'
) {
    let fixCount = sanitizeBabelfontArrays(fontJson);

    const glyphs = Array.isArray(fontJson.glyphs) ? fontJson.glyphs : [];
    for (const [glyphIndex, glyph] of glyphs.entries()) {
        const glyphRecord =
            glyph && typeof glyph === 'object' && !Array.isArray(glyph)
                ? (glyph as Record<string, unknown>)
                : null;
        const glyphName =
            typeof glyphRecord?.name === 'string' && glyphRecord.name.length
                ? glyphRecord.name
                : `glyph #${glyphIndex}`;
        const layers = Array.isArray(glyphRecord?.layers)
            ? (glyphRecord.layers as unknown[])
            : [];
        for (const [layerIndex, layer] of layers.entries()) {
            const layerRecord =
                layer && typeof layer === 'object' && !Array.isArray(layer)
                    ? (layer as Record<string, unknown>)
                    : null;
            if (
                layerRecord &&
                (typeof layerRecord.width !== 'number' ||
                    !Number.isFinite(layerRecord.width))
            ) {
                const layerId =
                    typeof layerRecord.id === 'string' && layerRecord.id.length
                        ? layerRecord.id
                        : `layer #${layerIndex}`;
                throw new Error(
                    `Cloud font layer ${glyphName}/${layerId} has invalid width; refusing to ${operation} cloud font data.`
                );
            }

            const shapes = Array.isArray(
                (layer as { shapes?: unknown[] }).shapes
            )
                ? (layer as { shapes: unknown[] }).shapes
                : [];
            for (const shape of shapes) {
                if (!shape || typeof shape !== 'object') {
                    continue;
                }

                const pathShape = shape as {
                    nodes?: unknown;
                    closed?: boolean;
                };
                if (Array.isArray(pathShape.nodes)) {
                    pathShape.nodes = Path.nodesToString(pathShape.nodes);
                    if (pathShape.closed === undefined) {
                        pathShape.closed = false;
                    }
                    fixCount++;
                }
            }
        }
    }

    return fixCount;
}

function getCloudFontJsonFromBridge(
    bridge: Pick<ChangeBridge, 'fontMap'>
): Record<string, unknown> | null {
    const fontJson = yDocToJson(bridge.fontMap);
    if (!fontJson || Object.keys(fontJson).length === 0) {
        return null;
    }

    return fontJson;
}

function assertCloudBridgeStateCanBeSaved(
    bridge: Pick<ChangeBridge, 'fontMap'>
): void {
    const fontJson = getCloudFontJsonFromBridge(bridge);
    if (!fontJson) {
        throw new Error('No active font data to save to cloud');
    }
    normalizeCloudExportForFontOpen(fontJson, 'save');
}

/**
 * Wait for the initial synced document to contain font data.
 * Some cloud rooms connect before their persisted snapshot has been applied.
 */
async function waitForCloudFontJson(
    bridge: Pick<ChangeBridge, 'fontMap' | 'yDoc'>,
    timeoutMs = 8000
): Promise<Record<string, unknown> | null> {
    const immediateFontJson = getCloudFontJsonFromBridge(bridge);
    if (immediateFontJson) {
        return immediateFontJson;
    }

    return await new Promise((resolve) => {
        let settled = false;

        const finish = (fontJson: Record<string, unknown> | null) => {
            if (settled) {
                return;
            }
            settled = true;
            window.clearTimeout(timeoutId);
            bridge.yDoc.off('update', onUpdate);
            resolve(fontJson);
        };

        const onUpdate = () => {
            const nextFontJson = getCloudFontJsonFromBridge(bridge);
            if (nextFontJson) {
                finish(nextFontJson);
            }
        };

        const timeoutId = window.setTimeout(() => {
            finish(getCloudFontJsonFromBridge(bridge));
        }, timeoutMs);

        bridge.yDoc.on('update', onUpdate);
    });
}

export interface CloudAsset {
    id: string;
    name: string;
    role: string;
    ownerUserId: string;
    createdAt: number;
    updatedAt: number;
}

export interface CloudEligibility {
    cloudHostingEnabled: boolean;
    maxFontsOwned: number | null;
    snapshotRetentionDays: number | null;
    fontsOwnedCount: number;
}

export class CloudPlugin extends FilesystemPlugin {
    private _cloudAdapter: CloudAdapter | null = null;
    private _activeAssetId: string | null = null;
    private _eligibility: CloudEligibility | null = null;
    private _pendingOpenAsset: {
        assetId: string;
        promise: Promise<void>;
    } | null = null;
    private _cloudSessionBootstrapEmail = 'local-dev@counterpunch.test';
    private _connectionStatusByAssetId = new Map<
        string,
        CloudConnectionStatus
    >();
    private _connectedAssetIds = new Set<string>();

    constructor(
        options: Omit<CloudAdapterOptions, 'assetId'> & {
            assetId?: string;
        } = {}
    ) {
        // Pass a stub adapter — real connections are created per-asset.
        const stubAdapter = new CloudAdapter({
            ...options,
            assetId: options.assetId ?? '__none__'
        });
        super(stubAdapter);
    }

    private get _websiteBaseUrl(): string {
        return window.authManager?.websiteURL || resolveWebsiteURL();
    }

    getAssetConnectionStatus(assetId: string): CloudConnectionStatus {
        return this._connectionStatusByAssetId.get(assetId) ?? 'disconnected';
    }

    hasConnectionProblem(assetId: string): boolean {
        const status = this.getAssetConnectionStatus(assetId);
        if (status === 'error') {
            return true;
        }

        if (
            status === 'connecting' ||
            status === 'authenticating' ||
            status === 'syncing' ||
            status === 'disconnected'
        ) {
            return this._connectedAssetIds.has(assetId);
        }

        return false;
    }

    private _updateConnectionStatus(
        assetId: string,
        status: CloudConnectionStatus,
        detail?: string
    ): void {
        this._connectionStatusByAssetId.set(assetId, status);
        if (status === 'connected') {
            this._connectedAssetIds.add(assetId);
        }

        window.dispatchEvent(
            new CustomEvent('cloudConnectionStatusChanged', {
                detail: { assetId, status, detail }
            })
        );
    }

    getId(): string {
        return 'cloud';
    }

    getName(): string {
        return 'Cloud';
    }

    getIcon(): string {
        return '<span class="material-symbols-outlined">cloud</span>';
    }

    canSave(): boolean {
        return true; // Cloud syncs continuously
    }

    supportsUpload(): boolean {
        return false;
    }

    supportsNewFolder(): boolean {
        return false; // Cloud uses a flat asset list — no folders
    }

    supportsNewFile(): boolean {
        return false; // New assets are created via Save As, not New File
    }

    supportsFileContextAction(
        action: FileContextAction,
        target: FileContextTarget
    ): boolean {
        switch (action) {
            case 'download':
            case 'rename':
                return false;
            case 'delete':
                return !target.isDir;
            default:
                return super.supportsFileContextAction(action, target);
        }
    }

    /**
     * Cloud Save As is handled entirely by this plugin:
     * create the asset, seed the DO, connect Yjs — no writeFile needed.
     */
    get interceptsSaveAs(): boolean {
        return true;
    }

    async handleSaveAs(name: string): Promise<boolean> {
        try {
            const assetId = await this.saveAs(name);
            const currentFont = (window as any).fontManager?.currentFont;
            if (currentFont) {
                // Use the bare assetId as the path so createFileUri produces
                // cloud:///assetId (no double-slash from a leading slash).
                currentFont.path = assetId;
                currentFont.sourcePlugin = this;
                currentFont.fileHandle = undefined;
                currentFont.directoryHandle = undefined;
                currentFont.needsRecompile = false;
                currentFont.hasUnsavedChanges = false;
            }
            if ((window as any).fontManager?.updateFontDisplay) {
                await (window as any).fontManager.updateFontDisplay();
            }
            if ((window as any).fontManager?.updateDirtyIndicator) {
                await (window as any).fontManager.updateDirtyIndicator();
            }
            if ((window as any).saveButton?.updateButtonState) {
                (window as any).saveButton.updateButtonState();
            }
            return true;
        } catch (err) {
            alert(`Failed to save to cloud: ${(err as Error).message}`);
            return false;
        }
    }

    async handleOpenPath(path: string): Promise<boolean> {
        if (!path.startsWith('cloud://')) {
            return false;
        }

        const assetId = path.slice('cloud://'.length).replace(/^\/+/, '');
        if (!assetId) {
            throw new Error('Missing cloud asset id');
        }

        await this.openAsset(assetId);
        return true;
    }

    requiresPermission(): boolean {
        return true;
    }

    /**
     * Activate the cloud plugin.
     * Returns true only when the user is authenticated and cloud hosting is
     * enabled for their account. Returning false causes switchContext to call
     * updateUI which shows the appropriate cloud-panel message.
     */
    async onActivate(): Promise<boolean> {
        const user = await this._ensureCloudUser({
            allowLoginRedirect: true
        });
        if (!user) return false;

        this._eligibility = null; // bust cache on every activation
        const eligibility = await this.checkEligibility();
        return eligibility?.cloudHostingEnabled === true;
    }

    async onDeactivate(): Promise<void> {
        const cloudPanel = document.getElementById('cloud-panel');
        if (cloudPanel) cloudPanel.classList.remove('visible');
    }

    /**
     * Update cloud-specific UI.
     * Manages the #cloud-panel element to show login-required or
     * eligibility-required messages, hiding it when ready to browse.
     */
    async updateUI(uiCallbacks: {
        showOpenFolderUI: () => void;
        hideOpenFolderUI: () => void;
        showPermissionBanner: (show: boolean) => void;
        showUnsupportedBrowserUI: () => void;
        hideUnsupportedBrowserUI: () => void;
    }): Promise<void> {
        uiCallbacks.hideUnsupportedBrowserUI();
        uiCallbacks.showPermissionBanner(false);
        uiCallbacks.hideOpenFolderUI();

        const cloudPanel = document.getElementById('cloud-panel');
        const titleEl = document.getElementById('cloud-panel-title');
        const msgEl = document.getElementById('cloud-panel-message');
        const loginBtn = document.getElementById('cloud-panel-login-btn');

        const authMgr = (window as any).authManager;
        const user = authMgr
            ? await authMgr.checkAuthStatus().catch(() => null)
            : null;

        if (!user) {
            if (titleEl) titleEl.textContent = 'Cloud Storage';
            if (msgEl)
                msgEl.textContent =
                    'Log in to save and open fonts from the cloud.';
            if (loginBtn) loginBtn.style.display = '';
            if (cloudPanel) cloudPanel.classList.add('visible');
            return;
        }

        const eligibility = await this.checkEligibility();
        if (!eligibility?.cloudHostingEnabled) {
            if (titleEl) titleEl.textContent = 'Cloud Storage';
            if (msgEl)
                msgEl.textContent =
                    'Cloud hosting is not enabled for your account.';
            if (loginBtn) loginBtn.style.display = 'none';
            if (cloudPanel) cloudPanel.classList.add('visible');
            return;
        }

        // Authenticated + eligible — hide cloud panel, file list will render.
        if (cloudPanel) cloudPanel.classList.remove('visible');

        // Refresh the asset list so it reflects the latest server state.
        if ((window as any).refreshFileSystem) {
            (window as any).refreshFileSystem();
        }
    }

    getTitleBarMenuItems(): TitleBarMenuItem[] {
        return [
            {
                label: 'Save to Cloud',
                icon: 'cloud_upload',
                action: async () => {
                    const name = prompt('Enter a name for this cloud font:');
                    if (!name) return;
                    try {
                        const assetId = await this.saveAs(name);
                        console.log(`Saved to cloud as ${assetId}`);
                    } catch (err) {
                        console.error('Save to cloud failed:', err);
                        alert(
                            `Failed to save to cloud: ${(err as Error).message}`
                        );
                    }
                }
            }
        ];
    }

    async isReady(): Promise<boolean> {
        return (
            this._cloudAdapter?.status === 'connected' ||
            this._cloudAdapter?.status === 'syncing'
        );
    }

    // ── Eligibility ──────────────────────────────────────────────

    /**
     * Fetch (and cache) cloud eligibility for the current user.
     * Returns null if the user is not authenticated or an error occurs.
     */
    async checkEligibility(): Promise<CloudEligibility | null> {
        if (this._eligibility) return this._eligibility;
        const user = await this._ensureCloudUser({
            allowLoginRedirect: true
        });
        if (!user) {
            return null;
        }
        try {
            const resp = await fetch(
                `${this._websiteBaseUrl}/api/cloud/eligibility`,
                {
                    credentials: 'include',
                    headers: getCloudRequestHeaders()
                }
            );
            if (!resp.ok) return null;
            const data = (await resp.json()) as CloudEligibility;
            this._eligibility = data;
            return data;
        } catch {
            return null;
        }
    }

    // ── Asset listing ────────────────────────────────────────────

    /**
     * List all cloud assets accessible to the current user.
     */
    async getAssets(): Promise<CloudAsset[]> {
        const user = await this._ensureCloudUser({
            allowLoginRedirect: true
        });
        if (!user) {
            return [];
        }
        const resp = await fetch(`${this._websiteBaseUrl}/api/cloud/assets`, {
            credentials: 'include',
            headers: getCloudRequestHeaders()
        });
        if (!resp.ok) {
            throw new Error(`Failed to list cloud assets: ${resp.status}`);
        }
        const data = (await resp.json()) as { assets: CloudAsset[] };
        return data.assets;
    }

    // ── Opening a cloud font ─────────────────────────────────────

    /**
     * Open an existing cloud font by asset ID.
     *
     * Flow:
     *  1. Fetch room token from the website.
     *  2. Connect a temporary ChangeBridge to the room WebSocket.
     *  3. Wait for the initial CRDT sync to complete.
     *  4. Extract babelfont JSON from the synced Yjs doc.
     *  5. Dispatch `fontLoaded` to trigger the normal font-loading pipeline.
     *  6. Bootstrap the real bridge from the synced Yjs state after
     *     `fontModelReady`, then rebind the adapter to it.
     */
    async openAsset(assetId: string): Promise<void> {
        if (this._pendingOpenAsset?.assetId === assetId) {
            return this._pendingOpenAsset.promise;
        }

        const openPromise = this._openAssetInternal(assetId);
        this._pendingOpenAsset = {
            assetId,
            promise: openPromise
        };

        try {
            await openPromise;
        } finally {
            if (this._pendingOpenAsset?.promise === openPromise) {
                this._pendingOpenAsset = null;
            }
        }
    }

    private async _openAssetInternal(assetId: string): Promise<void> {
        const user = await this._ensureCloudUser({
            allowLoginRedirect: true
        });
        if (!user) {
            throw new Error('Authentication required');
        }

        this._disconnectCurrent();

        const { token, roomUrl } = await this._fetchRoomToken(assetId);
        const wsUrl = normalizeCloudRoomWebSocketUrl(
            roomUrl,
            this._websiteBaseUrl
        );

        // Temporary bridge receives the initial CRDT state from the room.
        const tempBridge = new ChangeBridge(`cloud-bootstrap-${assetId}`);

        let resolveConnected!: () => void;
        let rejectConnected!: (err: Error) => void;
        const connectedPromise = new Promise<void>((res, rej) => {
            resolveConnected = res;
            rejectConnected = rej;
        });

        this._cloudAdapter = new CloudAdapter({
            assetId,
            websiteBaseUrl: this._websiteBaseUrl,
            onConnectionStatus: (
                status: CloudConnectionStatus,
                detail?: string
            ) => {
                console.log(
                    `[${assetId}] ${status}${detail ? ` (${detail})` : ''}`
                );
                this._updateConnectionStatus(assetId, status, detail);
                if (status === 'connected') resolveConnected();
                if (status === 'error')
                    rejectConnected(
                        new Error(detail ?? 'cloud connection error')
                    );
            }
        });

        await this._cloudAdapter.connectDirect(tempBridge, token, wsUrl);

        // Wait for initial sync (30 s timeout).
        const timeout = new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error('cloud sync timed out')), 30_000)
        );
        await Promise.race([connectedPromise, timeout]);

        // Extract babelfont JSON from the synced Yjs document.
        const fontJson = await waitForCloudFontJson(tempBridge);
        if (!fontJson) {
            this._disconnectCurrent();
            throw new Error(`Cloud asset ${assetId} has no font data`);
        }

        let sanitizeFixCount: number;
        try {
            sanitizeFixCount = normalizeCloudExportForFontOpen(fontJson);
        } catch (error) {
            this._disconnectCurrent();
            throw error;
        }
        if (sanitizeFixCount > 0) {
            console.warn(
                `[${assetId}] sanitized ${sanitizeFixCount} cloud-exported babelfont fields before font open`
            );
        }

        const babelfontJson = JSON.stringify(fontJson);
        const bridgeState = tempBridge.getFullState();

        this._activeAssetId = assetId;

        (
            window as Window & {
                __pendingCloudBridgeBootstrapState?: Uint8Array;
                __skipCloudBridgeRebindMerge?: boolean;
            }
        ).__pendingCloudBridgeBootstrapState = bridgeState;
        (
            window as Window & {
                __pendingCloudBridgeBootstrapState?: Uint8Array;
                __skipCloudBridgeRebindMerge?: boolean;
            }
        ).__skipCloudBridgeRebindMerge = true;

        const bridgeReadyPromise = new Promise<void>((resolve, reject) => {
            const timeoutId = window.setTimeout(() => {
                window.removeEventListener('fontModelReady', onFontModelReady);
                reject(new Error('cloud bridge bootstrap timed out'));
            }, 30_000);

            const onFontModelReady = () => {
                window.clearTimeout(timeoutId);
                window.removeEventListener('fontModelReady', onFontModelReady);
                this._cloudAdapter?.rebindToCurrentBridge();
                resolve();
            };

            window.addEventListener('fontModelReady', onFontModelReady);
        });

        // Dispatch fontLoaded — triggers the normal pipeline.
        // After fontModelReady, the adapter's handler will rebind to the real bridge.
        window.dispatchEvent(
            new CustomEvent('fontLoaded', {
                detail: {
                    path: `cloud://${assetId}`,
                    babelfontJson,
                    sourcePlugin: this,
                    fileHandle: undefined,
                    directoryHandle: undefined
                }
            })
        );

        await bridgeReadyPromise;
    }

    // ── Saving a font to the cloud ───────────────────────────────

    /**
     * Save the current font as a new cloud asset with the given name.
     *
     * Flow:
     *  1. Create a new asset via POST /api/cloud/assets.
     *  2. Fetch room token for the new asset.
     *  3. Connect the adapter to the current bridge.
     *     The auto-sync protocol seeds the empty DO with the current font state.
     */
    async saveAs(name: string): Promise<string> {
        const user = await this._ensureCloudUser({
            allowLoginRedirect: true
        });
        if (!user) {
            throw new Error('Authentication required');
        }

        const bridge = window.changeBridge;
        if (!bridge) throw new Error('No active font to save');

        assertCloudBridgeStateCanBeSaved(bridge);

        const resp = await fetch(`${this._websiteBaseUrl}/api/cloud/assets`, {
            method: 'POST',
            credentials: 'include',
            headers: getCloudRequestHeaders({
                'Content-Type': 'application/json'
            }),
            body: JSON.stringify({ name })
        });

        if (!resp.ok) {
            const err = await resp.text().catch(() => '');
            throw new Error(
                `Failed to create cloud asset: ${resp.status} ${err}`
            );
        }

        const { asset } = (await resp.json()) as { asset: CloudAsset };
        const assetId = asset.id;

        const { token, roomUrl } = await this._fetchRoomToken(assetId);
        const wsUrl = normalizeCloudRoomWebSocketUrl(
            roomUrl,
            this._websiteBaseUrl
        );

        this._disconnectCurrent();

        // Set up a promise that resolves when the initial sync with the DO is
        // complete (status 'connected'). connectDirect() resolves as soon as
        // the WebSocket object is created, before auth / sync finish — so we
        // must wait for the status callback before returning to the caller.
        let resolveConnected!: () => void;
        let rejectConnected!: (err: Error) => void;
        const connectedPromise = new Promise<void>((res, rej) => {
            resolveConnected = res;
            rejectConnected = rej;
        });

        this._cloudAdapter = new CloudAdapter({
            assetId,
            websiteBaseUrl: this._websiteBaseUrl,
            onConnectionStatus: (
                status: CloudConnectionStatus,
                detail?: string
            ) => {
                console.log(
                    `[${assetId}] ${status}${detail ? ` (${detail})` : ''}`
                );
                this._updateConnectionStatus(assetId, status, detail);
                if (status === 'connected') resolveConnected();
                if (status === 'error')
                    rejectConnected(
                        new Error(detail ?? 'cloud connection error')
                    );
            }
        });

        this._activeAssetId = assetId;
        await this._cloudAdapter.connectDirect(bridge, token, wsUrl);

        // Wait until the two-phase Yjs sync is complete so the DO has received
        // the full font state before we return (30 s safety timeout).
        const timeout = new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error('cloud save timed out')), 30_000)
        );
        await Promise.race([connectedPromise, timeout]);

        return assetId;
    }

    // ── Dev helpers ──────────────────────────────────────────────

    /**
     * Connect to a cloud room for the currently open font.
     * Requires a font to already be loaded (window.changeBridge must exist).
     */
    async connectToRoom(assetId: string): Promise<void> {
        const bridge = window.changeBridge;
        if (!bridge) {
            console.error('No changeBridge available — load a font first');
            return;
        }

        this._disconnectCurrent();

        this._cloudAdapter = new CloudAdapter({
            assetId,
            websiteBaseUrl: this._websiteBaseUrl,
            onConnectionStatus: (
                status: CloudConnectionStatus,
                detail?: string
            ) => {
                console.log(
                    `[${assetId}] ${status}${detail ? ` (${detail})` : ''}`
                );
                this._updateConnectionStatus(assetId, status, detail);
            }
        });

        console.log(`Connecting to room: ${assetId}`);
        await this._cloudAdapter.connect(bridge);
    }

    /**
     * Dev-only: Connect directly with a pre-built token and room URL,
     * bypassing the website auth endpoint.
     */
    async connectToRoomWithToken(
        assetId: string,
        token: string,
        roomUrl: string
    ): Promise<void> {
        const bridge = window.changeBridge;
        if (!bridge) {
            console.error('No changeBridge available — load a font first');
            return;
        }

        this._disconnectCurrent();

        this._cloudAdapter = new CloudAdapter({
            assetId,
            websiteBaseUrl: this._websiteBaseUrl,
            onConnectionStatus: (
                status: CloudConnectionStatus,
                detail?: string
            ) => {
                console.log(
                    `[${assetId}] ${status}${detail ? ` (${detail})` : ''}`
                );
                this._updateConnectionStatus(assetId, status, detail);
            }
        });

        const wsUrl = normalizeCloudRoomWebSocketUrl(
            roomUrl,
            this._websiteBaseUrl
        );
        console.log(`Connecting directly to room: ${assetId} at ${wsUrl}`);
        await this._cloudAdapter.connectDirect(bridge, token, wsUrl);
    }

    /** Disconnect from the current room. */
    disconnectFromRoom(): void {
        this._disconnectCurrent();
    }

    get connectionStatus(): CloudConnectionStatus {
        return this._cloudAdapter?.status ?? 'disconnected';
    }

    get activeAssetId(): string | null {
        return this._activeAssetId;
    }

    // ── Private helpers ──────────────────────────────────────────

    private _disconnectCurrent(): void {
        this._cloudAdapter?.disconnect();
        if (this._activeAssetId) {
            this._updateConnectionStatus(this._activeAssetId, 'disconnected');
        }
        this._cloudAdapter = null;
        this._activeAssetId = null;
    }

    private async _ensureCloudUser(options?: {
        allowLoginRedirect?: boolean;
    }): Promise<Record<string, unknown> | null> {
        const authMgr = window.authManager;
        if (!authMgr) {
            return null;
        }

        if (typeof authMgr.ensureCloudSession === 'function') {
            return await authMgr.ensureCloudSession({
                localEmail: this._cloudSessionBootstrapEmail,
                allowLoginRedirect: options?.allowLoginRedirect
            });
        }

        const user = await authMgr.checkAuthStatus().catch(() => null);
        if (user) {
            return user;
        }

        if (options?.allowLoginRedirect !== false) {
            await authMgr.login();
        }

        return null;
    }

    private async _fetchRoomToken(
        assetId: string
    ): Promise<{ token: string; roomUrl: string }> {
        const url = `${this._websiteBaseUrl}/api/cloud/assets/${encodeURIComponent(assetId)}/room-token`;
        const resp = await fetch(url, {
            method: 'POST',
            credentials: 'include',
            headers: getCloudRequestHeaders({
                'Content-Type': 'application/json'
            })
        });
        if (!resp.ok) {
            const body = await resp.text().catch(() => '');
            throw new Error(
                `room-token request failed: ${resp.status} ${body}`
            );
        }
        const data = (await resp.json()) as { token: string; roomUrl: string };
        if (!data.token || !data.roomUrl) {
            throw new Error('room-token response missing token or roomUrl');
        }
        return data;
    }
}

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
import { ChangeBridge } from './change-bridge';
import { yDocToJson } from './change-bridge-ydoc';
import { Logger } from './logger';

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
    private _cloudSessionBootstrapEmail = 'local-dev@counterpunch.test';

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
        return window.authManager?.websiteURL ?? 'http://localhost:8788';
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
                window.dispatchEvent(
                    new CustomEvent('cloudConnectionStatusChanged', {
                        detail: { assetId, status, detail }
                    })
                );
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
        const fontJson = yDocToJson(tempBridge.fontMap);
        if (!fontJson || Object.keys(fontJson).length === 0) {
            this._disconnectCurrent();
            throw new Error(`Cloud asset ${assetId} has no font data`);
        }
        const babelfontJson = JSON.stringify(fontJson);
        const bridgeState = tempBridge.getFullState();

        this._activeAssetId = assetId;

        (
            window as Window & {
                __pendingCloudBridgeBootstrapState?: Uint8Array;
            }
        ).__pendingCloudBridgeBootstrapState = bridgeState;

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
                window.dispatchEvent(
                    new CustomEvent('cloudConnectionStatusChanged', {
                        detail: { assetId, status, detail }
                    })
                );
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
                window.dispatchEvent(
                    new CustomEvent('cloudConnectionStatusChanged', {
                        detail: { assetId, status, detail }
                    })
                );
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
                window.dispatchEvent(
                    new CustomEvent('cloudConnectionStatusChanged', {
                        detail: { assetId, status, detail }
                    })
                );
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

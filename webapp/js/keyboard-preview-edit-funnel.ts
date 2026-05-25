import APP_SETTINGS from './settings';
import type { EditingCompileContext } from './font-manager';

export type KeyboardPreviewCompilingEditType = 'outline' | 'anchor' | null;

const KEYBOARD_PREVIEW_DATA_FRESHNESS_MODE: EditingCompileContext['dataFreshnessMode'] =
    'live-drag-worker-preview';

export type KeyboardPreviewEditRequest = {
    run: () => boolean | void | Promise<boolean | void>;
    isActive?: () => boolean;
    compile?: {
        changeSource: string;
        editType: KeyboardPreviewCompilingEditType;
    };
    onError?: (error: Error) => void;
};

export class KeyboardPreviewEditFunnel {
    private runningRequest: Promise<void> | null = null;
    private queuedRequest: KeyboardPreviewEditRequest | null = null;
    private commitTimer: number | null = null;
    private pendingCommit: (() => Promise<void>) | null = null;

    queue(request: KeyboardPreviewEditRequest): void {
        this.queuedRequest = request;
        this.startNextRequest();
    }

    scheduleCommit(commit: () => Promise<void>): void {
        this.pendingCommit = commit;
        if (this.commitTimer !== null) {
            window.clearTimeout(this.commitTimer);
        }
        this.commitTimer = window.setTimeout(() => {
            this.commitTimer = null;
            void this.flushPendingCommit();
        }, APP_SETTINGS.OUTLINE_EDITOR.KEYBOARD_PREVIEW_COMMIT_DEBOUNCE);
    }

    hasPendingWork(): boolean {
        return !!(
            this.runningRequest ||
            this.queuedRequest ||
            this.pendingCommit ||
            this.commitTimer !== null
        );
    }

    clearQueued(): void {
        this.queuedRequest = null;
    }

    cancelPendingCommit(): void {
        if (this.commitTimer !== null) {
            window.clearTimeout(this.commitTimer);
            this.commitTimer = null;
        }
        this.pendingCommit = null;
    }

    async drainAndClearQueued(): Promise<void> {
        this.queuedRequest = null;

        while (this.runningRequest) {
            const runningRequest = this.runningRequest;
            await runningRequest;
            if (this.runningRequest === runningRequest) {
                this.runningRequest = null;
            }
        }

        this.queuedRequest = null;
    }

    async flushPendingCommit(): Promise<void> {
        if (this.commitTimer !== null) {
            window.clearTimeout(this.commitTimer);
            this.commitTimer = null;
        }

        await this.drainAndClearQueued();

        const commit = this.pendingCommit;
        this.pendingCommit = null;
        if (commit) {
            await commit();
        }
    }

    reset(): void {
        this.clearQueued();
        this.cancelPendingCommit();
    }

    private startNextRequest(): void {
        if (this.runningRequest || !this.queuedRequest) {
            return;
        }

        const request = this.queuedRequest;
        this.queuedRequest = null;

        const runningRequest = this.processRequest(request);
        this.runningRequest = runningRequest;

        void runningRequest.finally(() => {
            if (this.runningRequest === runningRequest) {
                this.runningRequest = null;
            }
            this.startNextRequest();
        });
    }

    private async processRequest(
        request: KeyboardPreviewEditRequest
    ): Promise<void> {
        if (!this.isRequestActive(request)) {
            this.clearMatchingCompileContext(request);
            return;
        }

        let shouldCompile: boolean | void;
        try {
            shouldCompile = await request.run();
        } catch (error) {
            const normalizedError =
                error instanceof Error ? error : new Error(String(error));
            request.onError?.(normalizedError);
            this.clearMatchingCompileContext(request);
            return;
        }

        if (shouldCompile === false) {
            this.clearMatchingCompileContext(request);
            return;
        }

        if (!this.isRequestActive(request)) {
            this.clearMatchingCompileContext(request);
            return;
        }

        this.requestLiveCompile(request);
    }

    private isRequestActive(request: KeyboardPreviewEditRequest): boolean {
        return request.isActive ? request.isActive() : true;
    }

    private requestLiveCompile(request: KeyboardPreviewEditRequest): void {
        if (!request.compile) {
            return;
        }

        const fm = window.fontManager;
        const currentFont = fm?.currentFont;
        if (!fm || !currentFont) {
            return;
        }

        fm.setEditingCompileContext(
            request.compile.changeSource,
            request.compile.editType
        );
        currentFont.requestRecompileWithoutDataChange({
            compileContext: {
                changeSource: request.compile.changeSource,
                editType: request.compile.editType,
                dataFreshnessMode: KEYBOARD_PREVIEW_DATA_FRESHNESS_MODE
            }
        });
        window.autoCompileManager?.checkAndSchedule?.();
        this.clearMatchingCompileContext(request);
    }

    private clearMatchingCompileContext(request: KeyboardPreviewEditRequest) {
        if (!request.compile) {
            return;
        }

        const fm = window.fontManager;
        if (!fm) {
            return;
        }

        if (
            fm.lastChangeSource === request.compile.changeSource &&
            fm.lastEditType === request.compile.editType
        ) {
            fm.clearEditingCompileContext();
        }
    }
}

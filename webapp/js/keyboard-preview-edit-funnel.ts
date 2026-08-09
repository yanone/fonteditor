import APP_SETTINGS from './settings';
import type { EditingCompileContext } from './font-manager';

export type KeyboardPreviewCompilingEditType = 'outline' | 'anchor' | null;

type KeyboardPreviewCompileRequest = {
    changeSource: string;
    editType: KeyboardPreviewCompilingEditType;
};

const KEYBOARD_PREVIEW_DATA_FRESHNESS_MODE: EditingCompileContext['dataFreshnessMode'] =
    'live-drag-worker-preview';

export type KeyboardPreviewEditRequest = {
    prepare?: () => boolean | void | Promise<boolean | void>;
    run: () => boolean | void | Promise<boolean | void>;
    isActive?: () => boolean;
    render?: () => void;
    compile?:
        | KeyboardPreviewCompileRequest
        | (() => KeyboardPreviewCompileRequest | null);
    onError?: (error: Error) => void;
};

export class KeyboardPreviewEditFunnel {
    private runningRequest: Promise<void> | null = null;
    private queuedRequests: KeyboardPreviewEditRequest[] = [];
    private commitTimer: number | null = null;
    private pendingCommit: (() => Promise<void>) | null = null;

    queue(request: KeyboardPreviewEditRequest): void {
        this.queuedRequests.push(request);
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
        }, APP_SETTINGS.KEYBOARD_PREVIEW_COMMIT_DEBOUNCE);
    }

    hasPendingWork(): boolean {
        return !!(
            this.runningRequest ||
            this.queuedRequests.length > 0 ||
            this.pendingCommit ||
            this.commitTimer !== null
        );
    }

    clearQueued(): void {
        this.queuedRequests = [];
    }

    cancelPendingCommit(): void {
        if (this.commitTimer !== null) {
            window.clearTimeout(this.commitTimer);
            this.commitTimer = null;
        }
        this.pendingCommit = null;
    }

    async drainAndClearQueued(): Promise<void> {
        while (this.runningRequest || this.queuedRequests.length > 0) {
            if (!this.runningRequest && this.queuedRequests.length > 0) {
                this.startNextRequest();
            }

            const runningRequest = this.runningRequest;
            if (!runningRequest) {
                continue;
            }

            await runningRequest;
            if (this.runningRequest === runningRequest) {
                this.runningRequest = null;
            }
        }
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
        if (this.runningRequest || this.queuedRequests.length === 0) {
            return;
        }

        const request = this.queuedRequests.shift();
        if (!request) {
            return;
        }

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
        if (!request.prepare && !this.isRequestActive(request)) {
            this.clearMatchingCompileContext(request);
            return;
        }

        let shouldContinue: boolean | void = true;
        if (request.prepare) {
            try {
                shouldContinue = await request.prepare();
            } catch (error) {
                const normalizedError =
                    error instanceof Error ? error : new Error(String(error));
                request.onError?.(normalizedError);
                this.clearMatchingCompileContext(request);
                return;
            }

            if (shouldContinue === false) {
                this.clearMatchingCompileContext(request);
                return;
            }

            if (!this.isRequestActive(request)) {
                this.clearMatchingCompileContext(request);
                return;
            }

            if (request.render) {
                request.render();
                await this.waitForNextPaint();

                if (!this.isRequestActive(request)) {
                    this.clearMatchingCompileContext(request);
                    return;
                }
            }
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
        const compileRequest = this.resolveCompileRequest(request);
        if (!compileRequest) {
            return;
        }

        const fm = window.fontManager;
        const currentFont = fm?.currentFont;
        if (!fm || !currentFont) {
            return;
        }

        fm.setEditingCompileContext(
            compileRequest.changeSource,
            compileRequest.editType
        );
        currentFont.requestRecompileWithoutDataChange({
            compileContext: {
                changeSource: compileRequest.changeSource,
                editType: compileRequest.editType,
                dataFreshnessMode: KEYBOARD_PREVIEW_DATA_FRESHNESS_MODE
            }
        });
        window.autoCompileManager?.checkAndSchedule?.();
        this.clearMatchingCompileContext(request);
    }

    private clearMatchingCompileContext(request: KeyboardPreviewEditRequest) {
        const compileRequest = this.resolveCompileRequest(request);
        if (!compileRequest) {
            return;
        }

        const fm = window.fontManager;
        if (!fm) {
            return;
        }

        if (
            fm.lastChangeSource === compileRequest.changeSource &&
            fm.lastEditType === compileRequest.editType
        ) {
            fm.clearEditingCompileContext();
        }
    }

    private resolveCompileRequest(
        request: KeyboardPreviewEditRequest
    ): KeyboardPreviewCompileRequest | null {
        if (!request.compile) {
            return null;
        }

        return typeof request.compile === 'function'
            ? request.compile()
            : request.compile;
    }

    private async waitForNextPaint(): Promise<void> {
        await new Promise<void>((resolve) => {
            requestAnimationFrame(() => {
                requestAnimationFrame(() => resolve());
            });
        });
    }
}

import type { EditingCompileContext } from './font-manager';

export type LiveDragEditKind =
    | 'outline'
    | 'anchor'
    | 'sidebearing'
    | 'component'
    | 'transform'
    | 'guide'
    | 'contrast-axis';

export type LiveDragCompilingEditType = 'outline' | 'anchor' | null;

const LIVE_DRAG_DATA_FRESHNESS_MODE: EditingCompileContext['dataFreshnessMode'] =
    'live-drag-worker-preview';

export type LiveDragEditRequest = {
    kind: LiveDragEditKind;
    run: () => boolean | void | Promise<boolean | void>;
    isActive?: () => boolean;
    compile?: {
        changeSource: string;
        editType: LiveDragCompilingEditType;
    };
    onError?: (error: Error) => void;
};

/**
 * Serializes all pre-commit drag-time refreshes and compile wake-ups.
 *
 * Drag handlers mutate the editor model first, then enqueue the work needed to
 * keep Rust caches, recomposed dependent layers, HarfBuzz advances, and the
 * editing font in step while the pointer is still down.  Mouse-up drains this
 * funnel before the committed Yjs packet is produced, so stale live refreshes
 * cannot outlive the drag and poison the next committed compile context.
 */
export class LiveDragEditFunnel {
    private runningRequest: Promise<void> | null = null;
    private queuedRequest: LiveDragEditRequest | null = null;

    queue(request: LiveDragEditRequest): void {
        this.queuedRequest = request;
        this.startNextRequest();
    }

    clearQueued(): void {
        this.queuedRequest = null;
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

    reset(): void {
        this.clearQueued();
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

    private async processRequest(request: LiveDragEditRequest): Promise<void> {
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
            // run() may already have staged a physical overlay. If the
            // session died mid-await, drop that orphan so drag-2 cannot
            // inherit a prior generation (bake-skip on stale physical JSON).
            this.clearOrphanedPreviewOverlay(request);
            this.clearMatchingCompileContext(request);
            return;
        }

        this.requestLiveCompile(request);
    }

    private clearOrphanedPreviewOverlay(request: LiveDragEditRequest): void {
        if (request.kind !== 'sidebearing' && request.kind !== 'anchor') {
            return;
        }
        window.fontManager?.clearLiveDragPreview?.();
    }

    private isRequestActive(request: LiveDragEditRequest): boolean {
        return request.isActive ? request.isActive() : true;
    }

    private requestLiveCompile(request: LiveDragEditRequest): void {
        if (!request.compile) {
            return;
        }

        const fontCompilation = window.fontCompilation;
        if (
            fontCompilation?.isInitialized &&
            !fontCompilation.hasWorkerCacheDocument?.()
        ) {
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
                dataFreshnessMode: LIVE_DRAG_DATA_FRESHNESS_MODE
            }
        });
        window.autoCompileManager?.checkAndSchedule?.();
        this.clearMatchingCompileContext(request);
    }

    private clearMatchingCompileContext(request: LiveDragEditRequest): void {
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

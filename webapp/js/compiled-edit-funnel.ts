/**
 * CompiledEditFunnel — single post-commit reaction owner for all editing compiles.
 *
 * Every committed Yjs packet, local or remote, enters this serialized funnel.
 * The funnel:
 *   1. Sets transient compile context on FontManager from the committed metadata.
 *   2. Requests the editing compile.
 *   3. Arms the deferred full-compile timer (replaces scheduleFullCompileDebounce).
 *
 * The compile context is cleared by compileEditingFont after the compile reads it.
 * After each processed edit, any transient compile or edit-source state is cleaned
 * up so one edit cannot poison the next one (APP.md Document Collaboration rule).
 *
 * Edit types that do not need compilation (guide, contrast-axis) are detected
 * and skipped — no compile context is set, no compile is requested.
 */

import { Logger } from './logger';

const console = new Logger('CompiledEditFunnel');

const DEFERRED_FULL_MS = 500;

/** Edit types that should NOT trigger font recompilation. */
const NON_COMPILING_EDIT_TYPES = new Set<string>(['guide', 'contrast-axis']);

let deferredTimer: number | null = null;

function setCompileContext(
    fm: typeof window.fontManager,
    changeSource: string,
    editType: 'anchor' | 'outline' | 'kerning-value' | 'kerning-groups' | null
): void {
    if (typeof fm.setEditingCompileContext === 'function') {
        fm.setEditingCompileContext(changeSource, editType);
        return;
    }

    fm.lastChangeSource = changeSource;
    fm.lastEditType = editType;
}

function waitForEditingFontRevision(targetRevision: number): Promise<void> {
    return new Promise<void>((resolve) => {
        const finish = () => {
            window.removeEventListener('editingFontCompiled', handler);
            resolve();
        };

        const handler = (event: Event) => {
            const detail = (event as CustomEvent).detail;
            const fontRevision = Number(detail?.fontRevisionKey);
            if (!Number.isFinite(fontRevision)) {
                return;
            }
            if (fontRevision >= targetRevision) {
                finish();
            }
        };

        window.addEventListener('editingFontCompiled', handler);
    });
}

/**
 * Process a committed edit through the funnel.
 *
 * @param changeSource Human-readable source label for the edit.
 * @param editType     The fast-path edit type, or null for full compile.
 * @param options      forceTrigger — bypass idle checks for remote/undo/redo;
 *                     waitForCompletion — resolve only after the compile finishes.
 */
export async function processCommittedEdit(
    changeSource: string,
    editType: string | null,
    options?: {
        forceTrigger?: boolean;
        waitForCompletion?: boolean;
    }
): Promise<void> {
    const fm = window.fontManager;
    if (!fm?.currentFont) {
        return;
    }

    // Bootstrap guard: skip no-data commits before the first editing font exists.
    if (
        changeSource === 'change-bridge-local' &&
        fm.currentFont.changeVersion === 0 &&
        !fm.editingFont
    ) {
        return;
    }

    // Edit types that don't need compilation: skip entirely.
    if (editType && NON_COMPILING_EDIT_TYPES.has(editType)) {
        return;
    }

    // Set transient compile context for this request.
    // Cast is safe: non-compiling edit_types already filtered above.
    setCompileContext(
        fm,
        changeSource,
        editType as
            | 'anchor'
            | 'outline'
            | 'kerning-value'
            | 'kerning-groups'
            | null
    );

    // Request the editing compile.
    fm.currentFont.requestRecompileWithoutDataChange();
    window.autoCompileManager?.checkAndSchedule?.();

    const canForceTrigger =
        typeof window.autoCompileManager?.forceTrigger === 'function';
    const targetRevision = fm.currentFont.compileRequestVersion;
    const completionPromise =
        options?.waitForCompletion && canForceTrigger
            ? waitForEditingFontRevision(targetRevision)
            : null;

    // Force-trigger for remote, undo, redo.
    if (options?.forceTrigger && canForceTrigger) {
        try {
            await window.autoCompileManager.forceTrigger();
        } catch {
            // Compile errors are reported through normal error handling.
        }
    }

    if (completionPromise) {
        await completionPromise;
    }

    // Arm the deferred full-compile timer for fast-path edit types.
    // The timer ensures the font eventually gets a full compile (with
    // features and kerning) after interactive fast-path compiles.
    armDeferredFullCompile();
}

/**
 * Arm (or re-arm) the deferred full-compile timer.
 * Replaces `FontManager.scheduleFullCompileDebounce()`.
 */
function armDeferredFullCompile(): void {
    if (deferredTimer !== null) {
        clearTimeout(deferredTimer);
    }

    deferredTimer = window.setTimeout(() => {
        deferredTimer = null;

        // Don't fire while a drag is in progress — re-arm instead.
        if (window.glyphCanvas?.outlineEditor?.draggingSomething) {
            console.log(
                '[CompiledEditFunnel] Deferred full compile postponed until drag ends'
            );
            armDeferredFullCompile();
            return;
        }

        const fm = window.fontManager;
        if (!fm?.currentFont) {
            return;
        }

        // Skip if the last compile was already 'full'.
        if (fm.lastCompilationMode === 'full') {
            return;
        }

        // Flush any pending JSON/model sync from drag-finalization.
        if (fm.pendingBabelfontJsonSyncAfterDrag) {
            try {
                fm.currentFont.syncJsonFromModel();
                window.currentFontModel = fm.currentFont.fontModel;
                fm.pendingBabelfontJsonSyncAfterDrag = false;
            } catch {
                return;
            }
        }

        console.log(
            '[CompiledEditFunnel] Deferred full compile triggered after interactive editing'
        );

        // Request full compile through the same funnel.
        // Passing editType = null signals 'full' compilation mode.
        void processCommittedEdit('deferred-full', null);
    }, DEFERRED_FULL_MS);
}

/**
 * Cancel the deferred full-compile timer.
 */
export function cancelDeferredFullCompile(): void {
    if (deferredTimer !== null) {
        clearTimeout(deferredTimer);
        deferredTimer = null;
    }
}

/**
 * Reset internal timer state (for tests).
 */
export function reset(): void {
    cancelDeferredFullCompile();
}

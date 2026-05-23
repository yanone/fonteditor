/**
 * Canonical tests for CompiledEditFunnel — the single post-commit reaction owner.
 *
 * Tests lock down:
 *   1. The funnel always processes (no guard blocks it).
 *   2. Guide edits skip compilation.
 *   3. Fast-path edit types arm the deferred full compile.
 *   4. The startup bootstrap guard prevents no-data wake-ups.
 *   5. `lastChangeSource`/`lastEditType` are set from funnel metadata.
 *
 * See developer-docs/COMPILATION_EDIT_POLICY.md §CompiledEditFunnel.
 */

jest.mock('../../js/font-manager', () => ({}));

let funnel;

beforeEach(() => {
    jest.resetModules();
    funnel = require('../../js/compiled-edit-funnel');
    window.fontManager = {
        currentFont: {
            changeVersion: 5,
            compileRequestVersion: 10,
            requestRecompileWithoutDataChange: jest.fn(),
            syncJsonFromModel: jest.fn()
        },
        editingFont: new Uint8Array([1, 2, 3]),
        lastChangeSource: null,
        lastEditType: null,
        lastCompilationMode: 'outline-only',
        pendingBabelfontJsonSyncAfterDrag: false,
        setEditingCompileContext(changeSource, editType) {
            this.lastChangeSource = changeSource;
            this.lastEditType = editType;
        },
        clearEditingCompileContext() {
            this.lastChangeSource = null;
            this.lastEditType = null;
        }
    };
    window.autoCompileManager = {
        checkAndSchedule: jest.fn(),
        forceTrigger: jest.fn().mockResolvedValue(undefined)
    };
    window.glyphCanvas = {
        outlineEditor: {
            draggingSomething: false
        }
    };
});

afterEach(() => {
    delete window.fontManager;
    delete window.autoCompileManager;
    delete window.glyphCanvas;
    funnel.reset();
    jest.clearAllTimers();
    jest.useRealTimers();
});

function process(changeSource, editType, options) {
    return funnel.processCommittedEdit(changeSource, editType, options);
}

describe('CompiledEditFunnel', () => {
    describe('processCommittedEdit', () => {
        test('sets compile context and requests compile for outline edits', async () => {
            await process('keyboard-outline', 'outline');

            expect(window.fontManager.lastChangeSource).toBe(
                'keyboard-outline'
            );
            expect(window.fontManager.lastEditType).toBe('outline');
            expect(
                window.fontManager.currentFont.requestRecompileWithoutDataChange
            ).toHaveBeenCalledTimes(1);
            expect(
                window.autoCompileManager.checkAndSchedule
            ).toHaveBeenCalledTimes(1);
        });

        test('sets compile context for anchor edits', async () => {
            await process('keyboard-anchor', 'anchor');

            expect(window.fontManager.lastChangeSource).toBe(
                'keyboard-anchor'
            );
            expect(window.fontManager.lastEditType).toBe('anchor');
            expect(
                window.fontManager.currentFont.requestRecompileWithoutDataChange
            ).toHaveBeenCalledTimes(1);
        });

        test('sets null compile context for full (unknown) edits', async () => {
            await process('change-bridge-local', null);

            expect(window.fontManager.lastChangeSource).toBe(
                'change-bridge-local'
            );
            expect(window.fontManager.lastEditType).toBeNull();
            expect(
                window.fontManager.currentFont.requestRecompileWithoutDataChange
            ).toHaveBeenCalledTimes(1);
        });

        test('guide edits skip compile context and skip compilation', async () => {
            await process('keyboard-guide', 'guide');

            expect(window.fontManager.lastChangeSource).toBeNull();
            expect(window.fontManager.lastEditType).toBeNull();
            expect(
                window.fontManager.currentFont.requestRecompileWithoutDataChange
            ).not.toHaveBeenCalled();
            expect(
                window.autoCompileManager.checkAndSchedule
            ).not.toHaveBeenCalled();
        });

        test('contrast-axis edits skip compilation', async () => {
            await process('mouse', 'contrast-axis');

            expect(
                window.fontManager.currentFont.requestRecompileWithoutDataChange
            ).not.toHaveBeenCalled();
            expect(
                window.autoCompileManager.checkAndSchedule
            ).not.toHaveBeenCalled();
        });

        test('bootstrap guard skips no-data commits before first editing font', async () => {
            window.fontManager.currentFont.changeVersion = 0;
            delete window.fontManager.editingFont;

            await process('change-bridge-local', 'outline');

            expect(
                window.fontManager.currentFont.requestRecompileWithoutDataChange
            ).not.toHaveBeenCalled();
            expect(
                window.autoCompileManager.checkAndSchedule
            ).not.toHaveBeenCalled();
        });

        test('bootstrap guard does not skip when editing font already exists', async () => {
            window.fontManager.currentFont.changeVersion = 0;
            window.fontManager.editingFont = new Uint8Array([1, 2, 3]);

            await process('change-bridge-local', 'outline');

            expect(
                window.fontManager.currentFont.requestRecompileWithoutDataChange
            ).toHaveBeenCalledTimes(1);
        });

        test('forceTrigger calls forceTrigger when available', async () => {
            await process('remote-outline', 'outline', {
                forceTrigger: true
            });

            expect(
                window.autoCompileManager.forceTrigger
            ).toHaveBeenCalledTimes(1);
        });

        test('forceTrigger skips when not available', async () => {
            delete window.autoCompileManager.forceTrigger;

            await process('remote-outline', 'outline', {
                forceTrigger: true
            });

            // Should not throw
            expect(
                window.fontManager.currentFont.requestRecompileWithoutDataChange
            ).toHaveBeenCalledTimes(1);
        });
    });

    describe('deferred full compile', () => {
        beforeEach(() => {
            jest.useFakeTimers();
        });

        test('arms deferred full compile for outline edits', async () => {
            await process('keyboard-outline', 'outline');

            jest.advanceTimersByTime(500);

            // After 500ms, a deferred full compile should be requested
            expect(
                window.fontManager.currentFont.requestRecompileWithoutDataChange
            ).toHaveBeenCalledTimes(2);
        });

        test('does not arm deferred full compile for guide edits', async () => {
            await process('keyboard-guide', 'guide');

            jest.advanceTimersByTime(500);

            expect(
                window.fontManager.currentFont.requestRecompileWithoutDataChange
            ).not.toHaveBeenCalled();
        });

        test('re-arms when drag is active', async () => {
            await process('keyboard-outline', 'outline');
            const callCountBefore =
                window.fontManager.currentFont
                    .requestRecompileWithoutDataChange.mock.calls.length;

            // Drag becomes active before timer fires
            window.glyphCanvas.outlineEditor.draggingSomething = true;
            jest.advanceTimersByTime(500);
            // Drag still active — should re-arm, not fire
            expect(
                window.fontManager.currentFont
                    .requestRecompileWithoutDataChange
            ).toHaveBeenCalledTimes(callCountBefore);

            // Drag ends
            window.glyphCanvas.outlineEditor.draggingSomething = false;
            jest.advanceTimersByTime(500);

            // Should fire now
            expect(
                window.fontManager.currentFont
                    .requestRecompileWithoutDataChange
            ).toHaveBeenCalledTimes(callCountBefore + 1);
        });

        test('skips deferred full compile when last mode was already full', async () => {
            window.fontManager.lastCompilationMode = 'full';

            await process('keyboard-outline', 'outline');
            const callCountBefore =
                window.fontManager.currentFont
                    .requestRecompileWithoutDataChange.mock.calls.length;

            jest.advanceTimersByTime(500);

            // Timer fires but skips because lastCompilationMode is 'full'
            expect(
                window.fontManager.currentFont
                    .requestRecompileWithoutDataChange
            ).toHaveBeenCalledTimes(callCountBefore);
        });

        test('timer is cancelled and re-armed on subsequent edits', async () => {
            await process('keyboard-outline', 'outline');
            const callCountBefore =
                window.fontManager.currentFont
                    .requestRecompileWithoutDataChange.mock.calls.length;

            // Second edit re-arms the timer
            jest.advanceTimersByTime(400);
            await process('keyboard-outline', 'outline');

            // Timer shouldn't fire at 500ms from first edit (re-armed)
            jest.advanceTimersByTime(100);
            expect(
                window.fontManager.currentFont
                    .requestRecompileWithoutDataChange
            ).toHaveBeenCalledTimes(callCountBefore + 1); // +1 for second edit

            // Should fire 500ms from second edit
            jest.advanceTimersByTime(400);
            expect(
                window.fontManager.currentFont
                    .requestRecompileWithoutDataChange
            ).toHaveBeenCalledTimes(callCountBefore + 2); // +1 for deferred
        });
    });

    describe('no guard — funnel always processes', () => {
        test('processes even when lastFullCompiledDataVersion >= changeVersion', async () => {
            // Previous architecture had a guard here that blocked the funnel.
            // The guard is removed — the funnel always processes.
            window.fontManager.lastFullCompiledDataVersion = 100;
            window.fontManager.currentFont.changeVersion = 100;

            await process('keyboard-outline', 'outline');

            expect(
                window.fontManager.currentFont.requestRecompileWithoutDataChange
            ).toHaveBeenCalledTimes(1);
        });
    });
});
/**
 * Canonical tests for LiveDragEditFunnel — the pre-commit drag-time refresh
 * and compile owner.
 */

const { LiveDragEditFunnel } = require('../../js/live-drag-edit-funnel');

function deferred() {
    let resolve;
    const promise = new Promise((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

beforeEach(() => {
    const recordedCompileContexts = [];
    window.fontManager = {
        currentFont: {
            compileRequestVersion: 0,
            requestRecompileWithoutDataChange: jest.fn(() => {
                window.fontManager.currentFont.compileRequestVersion += 1;
                window.fontManager.recordEditingCompileRequestContext(
                    window.fontManager.currentFont.compileRequestVersion
                );
            })
        },
        lastChangeSource: null,
        lastEditType: null,
        recordedCompileContexts,
        setEditingCompileContext(changeSource, editType) {
            this.lastChangeSource = changeSource;
            this.lastEditType = editType;
        },
        clearEditingCompileContext() {
            this.lastChangeSource = null;
            this.lastEditType = null;
        },
        recordEditingCompileRequestContext(compileRequestVersion) {
            this.recordedCompileContexts.push({
                compileRequestVersion,
                changeSource: this.lastChangeSource,
                editType: this.lastEditType
            });
        }
    };
    window.autoCompileManager = {
        checkAndSchedule: jest.fn()
    };
});

afterEach(() => {
    delete window.fontManager;
    delete window.autoCompileManager;
});

describe('LiveDragEditFunnel', () => {
    test('runs a live refresh before requesting its compile', async () => {
        const funnel = new LiveDragEditFunnel();
        const calls = [];

        funnel.queue({
            kind: 'sidebearing',
            compile: {
                changeSource: 'mouse-drag-outline',
                editType: 'outline'
            },
            run: () => {
                calls.push('refresh');
            }
        });

        await funnel.drainAndClearQueued();

        expect(calls).toEqual(['refresh']);
        expect(window.fontManager.lastChangeSource).toBeNull();
        expect(window.fontManager.lastEditType).toBeNull();
        expect(window.fontManager.recordedCompileContexts).toEqual([
            {
                compileRequestVersion: 1,
                changeSource: 'mouse-drag-outline',
                editType: 'outline'
            }
        ]);
        expect(
            window.fontManager.currentFont.requestRecompileWithoutDataChange
        ).toHaveBeenCalledTimes(1);
        expect(
            window.autoCompileManager.checkAndSchedule
        ).toHaveBeenCalledTimes(1);
    });

    test('coalesces queued drag refreshes behind the running refresh', async () => {
        const funnel = new LiveDragEditFunnel();
        const first = deferred();
        const calls = [];

        funnel.queue({
            kind: 'outline',
            compile: {
                changeSource: 'mouse-drag-outline',
                editType: 'outline'
            },
            run: async () => {
                calls.push('first');
                await first.promise;
            }
        });
        funnel.queue({
            kind: 'outline',
            compile: {
                changeSource: 'mouse-drag-outline',
                editType: 'outline'
            },
            run: () => {
                calls.push('second');
            }
        });

        expect(calls).toEqual(['first']);

        first.resolve();
        await funnel.drainAndClearQueued();

        expect(calls).toEqual(['first']);
        expect(
            window.fontManager.currentFont.requestRecompileWithoutDataChange
        ).toHaveBeenCalledTimes(1);
        expect(window.fontManager.lastChangeSource).toBeNull();
        expect(window.fontManager.lastEditType).toBeNull();
    });

    test('runs the latest queued refresh after the current one completes', async () => {
        const funnel = new LiveDragEditFunnel();
        const first = deferred();
        const calls = [];

        funnel.queue({
            kind: 'anchor',
            compile: {
                changeSource: 'mouse-drag-anchor',
                editType: 'anchor'
            },
            run: async () => {
                calls.push('first');
                await first.promise;
            }
        });
        funnel.queue({
            kind: 'anchor',
            compile: {
                changeSource: 'mouse-drag-anchor',
                editType: 'anchor'
            },
            run: () => {
                calls.push('discarded');
            }
        });
        funnel.queue({
            kind: 'anchor',
            compile: {
                changeSource: 'mouse-drag-anchor',
                editType: 'anchor'
            },
            run: () => {
                calls.push('latest');
            }
        });

        first.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
        await funnel.drainAndClearQueued();

        expect(calls).toEqual(['first', 'latest']);
        expect(
            window.fontManager.currentFont.requestRecompileWithoutDataChange
        ).toHaveBeenCalledTimes(2);
        expect(window.fontManager.lastChangeSource).toBeNull();
        expect(window.fontManager.lastEditType).toBeNull();
    });

    test('draining after mouseup waits for in-flight refresh but skips stale compile', async () => {
        const funnel = new LiveDragEditFunnel();
        const refresh = deferred();
        let active = true;

        window.fontManager.lastChangeSource = 'mouse-drag-outline';
        window.fontManager.lastEditType = 'outline';

        funnel.queue({
            kind: 'sidebearing',
            compile: {
                changeSource: 'mouse-drag-outline',
                editType: 'outline'
            },
            isActive: () => active,
            run: async () => {
                await refresh.promise;
            }
        });

        active = false;
        const drained = funnel.drainAndClearQueued();
        refresh.resolve();
        await drained;

        expect(
            window.fontManager.currentFont.requestRecompileWithoutDataChange
        ).not.toHaveBeenCalled();
        expect(
            window.autoCompileManager.checkAndSchedule
        ).not.toHaveBeenCalled();
        expect(window.fontManager.lastChangeSource).toBeNull();
        expect(window.fontManager.lastEditType).toBeNull();
    });

    test('non-compiling live drag requests never wake auto compile', async () => {
        const funnel = new LiveDragEditFunnel();

        funnel.queue({
            kind: 'guide',
            run: () => true
        });

        await funnel.drainAndClearQueued();

        expect(
            window.fontManager.currentFont.requestRecompileWithoutDataChange
        ).not.toHaveBeenCalled();
        expect(
            window.autoCompileManager.checkAndSchedule
        ).not.toHaveBeenCalled();
    });
});

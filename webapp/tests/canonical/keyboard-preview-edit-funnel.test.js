const {
    KeyboardPreviewEditFunnel
} = require('../../js/keyboard-preview-edit-funnel');

function deferred() {
    let resolve;
    const promise = new Promise((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

describe('KeyboardPreviewEditFunnel', () => {
    let recordedCompileContexts;
    let rafQueue;
    let originalRequestAnimationFrame;

    function flushAnimationFrame() {
        const callback = rafQueue.shift();
        if (!callback) {
            throw new Error('No queued requestAnimationFrame callback');
        }
        callback(performance.now());
    }

    async function flushQueuedAnimationFrames() {
        while (rafQueue.length > 0) {
            flushAnimationFrame();
            await Promise.resolve();
            await Promise.resolve();
        }
    }

    beforeEach(() => {
        recordedCompileContexts = [];
        rafQueue = [];
        originalRequestAnimationFrame = global.requestAnimationFrame;
        global.requestAnimationFrame = jest.fn((callback) => {
            rafQueue.push(callback);
            return rafQueue.length;
        });

        window.fontManager = {
            currentFont: {
                compileRequestVersion: 0,
                requestRecompileWithoutDataChange: jest.fn((options) => {
                    window.fontManager.currentFont.compileRequestVersion += 1;
                    window.fontManager.recordEditingCompileRequestContext(
                        window.fontManager.currentFont.compileRequestVersion,
                        options?.compileContext
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
            recordEditingCompileRequestContext(
                compileRequestVersion,
                compileContext
            ) {
                this.recordedCompileContexts.push({
                    compileRequestVersion,
                    changeSource: this.lastChangeSource,
                    editType: this.lastEditType,
                    dataFreshnessMode: compileContext?.dataFreshnessMode ?? null
                });
            }
        };
        window.autoCompileManager = {
            checkAndSchedule: jest.fn()
        };
    });

    afterEach(() => {
        global.requestAnimationFrame = originalRequestAnimationFrame;
        delete window.fontManager;
        delete window.autoCompileManager;
    });

    test('processes queued keyboard previews in FIFO order', async () => {
        const funnel = new KeyboardPreviewEditFunnel();
        const firstPrepare = deferred();
        const calls = [];

        funnel.queue({
            prepare: async () => {
                calls.push('prepare-1');
                await firstPrepare.promise;
                return true;
            },
            render: () => {
                calls.push('render-1');
            },
            compile: {
                changeSource: 'keyboard-outline',
                editType: 'outline'
            },
            run: () => {
                calls.push('run-1');
            }
        });
        funnel.queue({
            prepare: () => {
                calls.push('prepare-2');
                return true;
            },
            render: () => {
                calls.push('render-2');
            },
            compile: {
                changeSource: 'keyboard-outline',
                editType: 'outline'
            },
            run: () => {
                calls.push('run-2');
            }
        });

        expect(calls).toEqual(['prepare-1']);

        firstPrepare.resolve();
        await Promise.resolve();
        await Promise.resolve();

        flushAnimationFrame();
        await Promise.resolve();
        expect(calls).toEqual(['prepare-1', 'render-1']);

        for (let attempts = 0; attempts < 10; attempts += 1) {
            await Promise.resolve();
            await Promise.resolve();
            await flushQueuedAnimationFrames();

            if (!funnel.hasPendingWork()) {
                break;
            }
        }

        expect(calls).toEqual([
            'prepare-1',
            'render-1',
            'run-1',
            'prepare-2',
            'render-2',
            'run-2'
        ]);
        expect(funnel.hasPendingWork()).toBe(false);
        expect(
            window.fontManager.currentFont.requestRecompileWithoutDataChange
        ).toHaveBeenCalledTimes(2);
    });

    test('waits for two animation frames after render before preview work continues', async () => {
        const funnel = new KeyboardPreviewEditFunnel();
        const calls = [];

        funnel.queue({
            prepare: () => {
                calls.push('prepare');
                return true;
            },
            render: () => {
                calls.push('render');
            },
            compile: {
                changeSource: 'keyboard-anchor',
                editType: 'anchor'
            },
            run: () => {
                calls.push('run');
            }
        });

        await Promise.resolve();
        expect(calls).toEqual(['prepare', 'render']);

        flushAnimationFrame();
        await Promise.resolve();
        expect(calls).toEqual(['prepare', 'render']);

        flushAnimationFrame();
        await Promise.resolve();
        await funnel.drainAndClearQueued();

        expect(calls).toEqual(['prepare', 'render', 'run']);
        expect(window.fontManager.recordedCompileContexts).toEqual([
            {
                compileRequestVersion: 1,
                changeSource: 'keyboard-anchor',
                editType: 'anchor',
                dataFreshnessMode: 'live-drag-worker-preview'
            }
        ]);
    });

    test('flushPendingCommit waits for queued keyboard increments before committing', async () => {
        const funnel = new KeyboardPreviewEditFunnel();
        const firstPrepare = deferred();
        const calls = [];

        funnel.queue({
            prepare: async () => {
                calls.push('prepare-1');
                await firstPrepare.promise;
                return true;
            },
            render: () => {
                calls.push('render-1');
            },
            run: () => {
                calls.push('run-1');
            }
        });
        funnel.queue({
            prepare: () => {
                calls.push('prepare-2');
                return true;
            },
            render: () => {
                calls.push('render-2');
            },
            run: () => {
                calls.push('run-2');
            }
        });

        funnel.scheduleCommit(async () => {
            calls.push('commit');
        });

        const flushPromise = funnel.flushPendingCommit();
        firstPrepare.resolve();

        for (let attempts = 0; attempts < 10; attempts += 1) {
            await Promise.resolve();
            await Promise.resolve();
            await flushQueuedAnimationFrames();

            if (!funnel.hasPendingWork()) {
                break;
            }
        }

        await flushPromise;

        expect(calls).toEqual([
            'prepare-1',
            'render-1',
            'run-1',
            'prepare-2',
            'render-2',
            'run-2',
            'commit'
        ]);
    });

    test('clearQueued drops future queued increments but lets the running one finish', async () => {
        const funnel = new KeyboardPreviewEditFunnel();
        const firstPrepare = deferred();
        const calls = [];

        funnel.queue({
            prepare: async () => {
                calls.push('prepare-1');
                await firstPrepare.promise;
                return true;
            },
            render: () => {
                calls.push('render-1');
            },
            run: () => {
                calls.push('run-1');
            }
        });
        funnel.queue({
            prepare: () => {
                calls.push('prepare-2');
                return true;
            },
            render: () => {
                calls.push('render-2');
            },
            run: () => {
                calls.push('run-2');
            }
        });

        expect(calls).toEqual(['prepare-1']);

        funnel.clearQueued();
        firstPrepare.resolve();

        for (let attempts = 0; attempts < 10; attempts += 1) {
            await Promise.resolve();
            await Promise.resolve();
            await flushQueuedAnimationFrames();

            if (!funnel.hasPendingWork()) {
                break;
            }
        }

        expect(calls).toEqual(['prepare-1', 'render-1', 'run-1']);
        expect(funnel.hasPendingWork()).toBe(false);
    });
});

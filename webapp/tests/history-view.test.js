jest.mock('tippy.js', () => {
    const factory = jest.fn(() => ({ destroy: jest.fn() }));
    return {
        __esModule: true,
        default: factory
    };
});

const { createLogEntry, resetLogCounter } = require('../js/change-log');

describe('history view', () => {
    const originalPatchSyncEngine = window.patchSyncEngine;
    const originalGlyphCanvas = window.glyphCanvas;
    const originalFontInfoManager = window.fontInfoManager;
    const originalGetHistoryUndoContext = window.getHistoryUndoContext;

    afterEach(() => {
        window.patchSyncEngine = originalPatchSyncEngine;
        window.glyphCanvas = originalGlyphCanvas;
        window.fontInfoManager = originalFontInfoManager;
        window.getHistoryUndoContext = originalGetHistoryUndoContext;
        document.body.innerHTML = '';
        jest.resetModules();
        jest.clearAllMocks();
    });

    function mountHistoryView({
        collaborationItems,
        changeLogEntries,
        glyphName = 'A',
        layerId = 'layer-1'
    }) {
        document.body.innerHTML = '<div id="history-view-content"></div>';

        window.patchSyncEngine = {
            onCollaborationLogUpdate: jest.fn((callback) => {
                callback(collaborationItems);
                return jest.fn();
            }),
            getChangeLog: jest.fn(() => changeLogEntries)
        };
        window.glyphCanvas = {
            outlineEditor: {
                active: true,
                selectedLayerId: layerId,
                parseGlyphStack: jest.fn(() => [{ glyphName }]),
                currentGlyphName: glyphName
            },
            getCurrentGlyphName: jest.fn(() => glyphName)
        };
        window.fontInfoManager = {
            getHistoryScopeTarget: jest.fn(() => null)
        };

        jest.isolateModules(() => {
            require('../js/history-view.ts');
        });
    }

    test('renders a flat collaboration-message list and keeps undo items visible', () => {
        const tippy = require('tippy.js').default;
        resetLogCounter();

        const collaborationItems = [
            {
                id: 'message-1',
                direction: 'local',
                timestamp: 1000,
                transactionDurationMs: 42.5,
                summary: 'Resize glyph',
                label: 'Resize glyph',
                source: 'change-bridge',
                editSource: 'mouse-drag-sidebearing',
                windowId: 'main-1',
                windowRoleLabel: 'main',
                historyItemId: 'history-1',
                historyAction: 'change',
                targetHistoryItemId: null,
                undoScope: 'layer',
                updateByteLength: 32,
                updateBase64Preview: 'AAAA',
                changedGlyphNames: ['A'],
                changedLayerIds: ['layer-1'],
                workerReplayTargets: [{ glyphName: 'A', layerId: 'layer-1' }],
                changes: [{ op: 'set', path: 'glyphs.A:layers.layer-1:width' }],
                derivedForwardChanges: [
                    {
                        path: 'glyphs.A:layers.layer-1:width',
                        op: 'set',
                        oldValue: 600,
                        newValue: 700,
                        objectType: 'layer'
                    }
                ]
            },
            {
                id: 'message-2',
                direction: 'local',
                timestamp: 2000,
                transactionDurationMs: null,
                summary: 'Undo',
                label: 'Undo',
                source: 'change-bridge',
                editSource: 'keyboard-sidebearing',
                windowId: 'main-1',
                windowRoleLabel: 'main',
                historyItemId: 'history-2',
                historyAction: 'undo',
                targetHistoryItemId: 'history-1',
                undoScope: 'layer',
                updateByteLength: 28,
                updateBase64Preview: 'BBBB',
                changedGlyphNames: ['A'],
                changedLayerIds: ['layer-1'],
                workerReplayTargets: [{ glyphName: 'A', layerId: 'layer-1' }],
                changes: [{ op: 'set', path: 'glyphs.A:layers.layer-1:width' }],
                derivedForwardChanges: [
                    {
                        path: 'glyphs.A:layers.layer-1:width',
                        op: 'set',
                        oldValue: 700,
                        newValue: 600,
                        objectType: 'layer'
                    }
                ]
            }
        ];

        const changeLogEntries = [
            createLogEntry({
                timestamp: 1000,
                windowId: 'main-1',
                windowRoleLabel: 'main',
                historyItemId: 'history-1',
                historyAction: 'change',
                transactionLabel: 'Resize glyph',
                transactionId: 1,
                op: 'set',
                undoScope: 'layer',
                path: 'glyphs.A:layers.layer-1:width',
                oldValue: 600,
                newValue: 700
            })
        ];

        mountHistoryView({ collaborationItems, changeLogEntries });

        const rows = [
            ...document.querySelectorAll('.history-entry.history-entry-flat')
        ];
        expect(rows).toHaveLength(2);
        expect(document.body.textContent).toContain('Resize glyph');
        expect(document.body.textContent).toContain('Undo');
        expect(document.body.textContent).toContain('42.5 ms');
        expect(
            document.querySelectorAll('[data-role="history-info-button"]')
        ).toHaveLength(2);
        expect(tippy).toHaveBeenCalled();
        const tooltipMarkups = tippy.mock.calls.map((call) => call[1].content);
        expect(
            tooltipMarkups.some((markup) => markup.includes('Forward change 1'))
        ).toBe(true);
        expect(
            tooltipMarkups.some(
                (markup) =>
                    markup.includes('Edit source') &&
                    markup.includes('mouse-drag-sidebearing') &&
                    markup.includes('Transaction duration') &&
                    markup.includes('42.5 ms') &&
                    markup.includes('glyphs.A:layers.layer-1:width') &&
                    markup.includes('600') &&
                    markup.includes('700')
            )
        ).toBe(true);
        expect(window.getHistoryUndoContext()).toEqual({
            scope: 'layer',
            glyphName: 'A',
            layerId: 'layer-1',
            historyTargetKey: null
        });

        const resizeRow = rows.find((row) =>
            row.textContent.includes('Resize glyph')
        );
        const undoRow = rows.find((row) =>
            row.textContent.trim().startsWith('Undo')
        );
        expect(resizeRow.className).not.toContain(
            'history-entry-cmdz-unreachable'
        );
        expect(undoRow.className).toContain('history-entry-cmdz-unreachable');
    });

    test('dims history items outside the current Cmd+Z editing context', () => {
        resetLogCounter();

        const collaborationItems = [
            {
                id: 'message-a',
                direction: 'local',
                timestamp: 1000,
                transactionDurationMs: null,
                summary: 'Edit A',
                label: 'Edit A',
                source: 'change-bridge',
                editSource: null,
                windowId: 'main-1',
                windowRoleLabel: 'main',
                historyItemId: 'history-a',
                historyAction: 'change',
                targetHistoryItemId: null,
                undoScope: 'layer',
                updateByteLength: 16,
                updateBase64Preview: 'AAAA',
                changedGlyphNames: ['A'],
                changedLayerIds: ['layer-1'],
                workerReplayTargets: [{ glyphName: 'A', layerId: 'layer-1' }],
                changes: [{ op: 'set', path: 'glyphs.A:layers.layer-1:width' }],
                derivedForwardChanges: []
            },
            {
                id: 'message-b',
                direction: 'local',
                timestamp: 2000,
                transactionDurationMs: null,
                summary: 'Edit B',
                label: 'Edit B',
                source: 'change-bridge',
                editSource: null,
                windowId: 'main-1',
                windowRoleLabel: 'main',
                historyItemId: 'history-b',
                historyAction: 'change',
                targetHistoryItemId: null,
                undoScope: 'layer',
                updateByteLength: 16,
                updateBase64Preview: 'BBBB',
                changedGlyphNames: ['B'],
                changedLayerIds: ['layer-1'],
                workerReplayTargets: [{ glyphName: 'B', layerId: 'layer-1' }],
                changes: [{ op: 'set', path: 'glyphs.B:layers.layer-1:width' }],
                derivedForwardChanges: []
            }
        ];

        const changeLogEntries = [
            createLogEntry({
                timestamp: 1000,
                windowId: 'main-1',
                windowRoleLabel: 'main',
                historyItemId: 'history-a',
                historyAction: 'change',
                transactionLabel: 'Edit A',
                transactionId: 1,
                op: 'set',
                undoScope: 'layer',
                path: 'glyphs.A:layers.layer-1:width',
                oldValue: 600,
                newValue: 610
            }),
            createLogEntry({
                timestamp: 2000,
                windowId: 'main-1',
                windowRoleLabel: 'main',
                historyItemId: 'history-b',
                historyAction: 'change',
                transactionLabel: 'Edit B',
                transactionId: 2,
                op: 'set',
                undoScope: 'layer',
                path: 'glyphs.B:layers.layer-1:width',
                oldValue: 600,
                newValue: 620
            })
        ];

        mountHistoryView({
            collaborationItems,
            changeLogEntries,
            glyphName: 'A',
            layerId: 'layer-1'
        });

        const rows = [
            ...document.querySelectorAll('.history-entry.history-entry-flat')
        ];
        const editA = rows.find((row) => row.textContent.includes('Edit A'));
        const editB = rows.find((row) => row.textContent.includes('Edit B'));

        expect(editA.className).not.toContain('history-entry-cmdz-unreachable');
        expect(editB.className).toContain('history-entry-cmdz-unreachable');
    });
});

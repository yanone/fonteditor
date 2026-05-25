jest.mock('tippy.js', () => {
    const factory = jest.fn(() => ({ destroy: jest.fn() }));
    return {
        __esModule: true,
        default: factory
    };
});

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

    test('renders a flat collaboration-message list and keeps undo items visible', () => {
        document.body.innerHTML = '<div id="history-view-content"></div>';
        const tippy = require('tippy.js').default;

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

        window.patchSyncEngine = {
            onCollaborationLogUpdate: jest.fn((callback) => {
                callback(collaborationItems);
                return jest.fn();
            })
        };
        window.glyphCanvas = {
            outlineEditor: {
                active: true,
                selectedLayerId: 'layer-1',
                parseGlyphStack: jest.fn(() => [{ glyphName: 'A' }]),
                currentGlyphName: 'A'
            },
            getCurrentGlyphName: jest.fn(() => 'A')
        };
        window.fontInfoManager = {
            getHistoryScopeTarget: jest.fn(() => null)
        };

        jest.isolateModules(() => {
            require('../js/history-view.ts');
        });

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
    });
});

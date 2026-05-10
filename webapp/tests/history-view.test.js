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
                summary: 'Resize glyph',
                label: 'Resize glyph',
                source: 'change-bridge',
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
                summary: 'Undo',
                label: 'Undo',
                source: 'change-bridge',
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
        expect(
            document.querySelectorAll('[data-role="history-info-button"]')
        ).toHaveLength(2);
        expect(tippy).toHaveBeenCalled();
        const tooltipMarkup = tippy.mock.calls[0][1].content;
        expect(tooltipMarkup).toContain('Forward change 1');
        expect(tooltipMarkup).toContain('glyphs.A:layers.layer-1:width');
        expect(tooltipMarkup).toContain('600');
        expect(tooltipMarkup).toContain('700');
        expect(window.getHistoryUndoContext()).toEqual({
            scope: 'layer',
            glyphName: 'A',
            layerId: 'layer-1',
            historyTargetKey: null
        });
    });
});

/**
 * Canvas history items must be undoable from every layer of the originating
 * glyph that the item actually wrote, not only from the first recorded layer.
 */

const { PatchSyncEngine: ChangeBridge } = require('../../js/patch-sync-engine');
const { getYPath } = require('../../js/change-bridge-ydoc');
const {
    buildHistoryStackItems,
    createLogEntry,
    formatHistoryOriginLabel,
    resetLogCounter
} = require('../../js/change-log');

function makeLayer(id, name, width) {
    return {
        id,
        name,
        width,
        master: {
            type: 'DefaultForMaster',
            master: 'master-regular'
        },
        smart_component_location: {},
        color: null,
        layer_index: 0,
        is_background: false,
        background_layer_id: null,
        location: {},
        format_specific: {},
        shapes: [],
        anchors: [],
        guides: []
    };
}

function makeFont() {
    return {
        upm: 1000,
        version: [1, 0],
        names: { familyName: 'TestFont' },
        axes: [],
        masters: [
            {
                name: 'Regular',
                id: 'master-regular',
                location: {},
                metrics: {},
                kerning: {},
                format_specific: {}
            }
        ],
        instances: [],
        glyphs: [
            {
                name: 'A',
                production_name: 'A',
                category: 'Base',
                codepoints: [65],
                exported: true,
                layers: [
                    makeLayer('layer-1', 'Regular', 600),
                    makeLayer('layer-1b', 'Regular Alt', 620),
                    makeLayer('layer-1c', 'Unwritten', 640)
                ]
            },
            {
                name: 'B',
                production_name: 'B',
                category: 'Base',
                codepoints: [66],
                exported: true,
                layers: [makeLayer('layer-2', 'Regular', 650)]
            }
        ]
    };
}

describe('history layer availability', () => {
    afterEach(() => {
        window.changeBridge = undefined;
    });

    test('multi-layer same-glyph edits are undoable from every written layer', () => {
        const fontJson = makeFont();
        const bridge = new ChangeBridge('history-layer-availability');
        bridge.initFromJson(fontJson);
        window.changeBridge = bridge;

        bridge.beginTransaction('Set component automatic alignment');
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1'],
            'width',
            600,
            700
        );
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1b'],
            'width',
            620,
            730
        );
        bridge.endTransaction();

        const log = bridge.getChangeLog();
        const originLayerItems = buildHistoryStackItems(log, {
            glyphName: 'A',
            layerId: 'layer-1'
        });
        const otherWrittenLayerItems = buildHistoryStackItems(log, {
            glyphName: 'A',
            layerId: 'layer-1b'
        });
        const unwrittenLayerItems = buildHistoryStackItems(log, {
            glyphName: 'A',
            layerId: 'layer-1c'
        });

        expect(originLayerItems).toHaveLength(1);
        expect(otherWrittenLayerItems).toHaveLength(1);
        expect(otherWrittenLayerItems[0].id).toBe(originLayerItems[0].id);
        expect(unwrittenLayerItems).toHaveLength(0);
        expect(
            formatHistoryOriginLabel({
                undoScope: originLayerItems[0].undoScope,
                originatingGlyphName: originLayerItems[0].originatingGlyphName,
                originatingLayerId: originLayerItems[0].originatingLayerId,
                changePaths: originLayerItems[0].touchedPaths
            })
        ).toBe('Layer · A');

        expect(bridge.undo('A', 'layer-1b')).not.toBeNull();
        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1',
                'width'
            ])
        ).toBe(600);
        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1b',
                'width'
            ])
        ).toBe(620);
        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1c',
                'width'
            ])
        ).toBe(640);

        expect(bridge.redo('A', 'layer-1b')).not.toBeNull();
        expect(
            getYPath(bridge.fontMap, [
                'glyphs',
                'A',
                'layers',
                'layer-1b',
                'width'
            ])
        ).toBe(730);

        bridge.destroy();
    });

    test('dependent glyph layers stay off the originating glyph canvas stack', () => {
        resetLogCounter();
        const historyItemId = 'history-cascade';
        const entries = [
            createLogEntry({
                timestamp: 1,
                windowId: 'w',
                windowRoleLabel: 'Main',
                historyItemId,
                historyAction: 'change',
                transactionLabel: 'Set sidebearing with dependents',
                transactionId: 1,
                op: 'set',
                undoScope: 'layer',
                path: 'glyphs.A:layers.layer-1:width',
                oldValue: 600,
                newValue: 620
            }),
            createLogEntry({
                timestamp: 1,
                windowId: 'w',
                windowRoleLabel: 'Main',
                historyItemId,
                historyAction: 'change',
                transactionLabel: 'Set sidebearing with dependents',
                transactionId: 1,
                op: 'set',
                undoScope: 'layer',
                path: 'glyphs.B:layers.layer-2:width',
                oldValue: 650,
                newValue: 680
            })
        ];

        expect(
            buildHistoryStackItems(entries, {
                glyphName: 'A',
                layerId: 'layer-1'
            })
        ).toHaveLength(1);
        expect(
            buildHistoryStackItems(entries, {
                glyphName: 'B',
                layerId: 'layer-2'
            })
        ).toHaveLength(0);
    });
});

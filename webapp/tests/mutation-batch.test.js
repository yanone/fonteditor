const {
    createChangeLogEntriesFromMutationBatchEnvelope,
    createMutationBatchEnvelopeFromChangeLogEntries,
    createMutationBatchEnvelopesFromChangeLogEntries,
    createMutationBatchEnvelope,
    isMutationBatchEnvelope
} = require('../js/mutation-batch.ts');
const { createLogEntry } = require('../js/change-log');

const TEST_FONT_JSON = {
    glyphs: [
        {
            name: 'A',
            layers: [{ id: 'layer-1', width: 600 }]
        },
        {
            name: 'A.alt',
            layers: [{ id: 'layer.regular.v1', width: 600 }]
        }
    ]
};

describe('mutation-batch scaffold', () => {
    test('createMutationBatchEnvelope normalizes optional top-level fields and clones arrays', () => {
        const metadata = {
            editType: 'outline',
            changedGlyphNames: ['A'],
            changedLayerIds: ['L0'],
            workerReplayTargets: [{ glyphName: 'A', layerId: 'L0' }],
            visualAnchorSide: 'left',
            requiresTrailingFullCompile: true
        };

        const envelope = createMutationBatchEnvelope({
            transactionId: 'tx-1',
            localSequence: 7,
            baseRevision: 'rev-1',
            patches: [
                {
                    forward: {
                        op: 'replace',
                        path: 'glyphs.A:name',
                        value: 'A'
                    },
                    inverse: {
                        op: 'replace',
                        path: 'glyphs.A:name',
                        value: 'A.alt'
                    }
                }
            ],
            metadata,
            source: 'unit-test',
            label: 'Rename glyph',
            windowId: 'window-1',
            timestamp: 1234
        });

        expect(envelope.schemaVersion).toBe(2);
        expect(envelope.roomSequence).toBeNull();
        expect(envelope.validationFingerprint).toBeNull();
        expect(envelope.metadata).not.toBe(metadata);
        expect(envelope.metadata.changedGlyphNames).toEqual(['A']);
        expect(envelope.patches).toEqual([
            expect.objectContaining({
                forward: expect.objectContaining({
                    op: 'replace',
                    path: 'glyphs.A:name',
                    value: 'A'
                }),
                inverse: expect.objectContaining({
                    op: 'replace',
                    path: 'glyphs.A:name',
                    value: 'A.alt'
                })
            })
        ]);
        expect(envelope.metadata.workerReplayTargets).toEqual([
            { glyphName: 'A', layerId: 'L0' }
        ]);

        metadata.changedGlyphNames.push('B');

        expect(envelope.metadata.changedGlyphNames).toEqual(['A']);
    });

    test('isMutationBatchEnvelope accepts the scaffold shape and rejects malformed values', () => {
        const validEnvelope = createMutationBatchEnvelope({
            transactionId: 'tx-2',
            localSequence: 1,
            roomSequence: 3,
            baseRevision: null,
            patches: [],
            metadata: {
                editType: 'bootstrap',
                changedGlyphNames: [],
                changedLayerIds: [],
                workerReplayTargets: []
            },
            source: 'bootstrap',
            label: null,
            windowId: null,
            timestamp: Date.now(),
            validationFingerprint: 'fp-1'
        });

        expect(isMutationBatchEnvelope(validEnvelope)).toBe(true);
        expect(
            isMutationBatchEnvelope({
                schemaVersion: 2,
                transactionId: 'tx-bad'
            })
        ).toBe(false);
        expect(isMutationBatchEnvelope(null)).toBe(false);
        expect(isMutationBatchEnvelope([])).toBe(false);
    });

    test('round-tripping through an envelope preserves undo metadata and sender attribution', () => {
        const entries = [
            createLogEntry({
                timestamp: 123,
                windowId: 'sender-window',
                windowRoleLabel: 'linked-2',
                historyItemId: 'history-undo-1',
                historyAction: 'undo',
                targetHistoryItemId: 'history-change-1',
                transactionLabel: 'Undo',
                transactionId: 44,
                op: 'set',
                undoScope: 'glyph',
                path: 'glyphs.A:name',
                oldValue: 'A.alt',
                newValue: 'A',
                historyTargetType: 'feature',
                historyTargetKey: 'liga',
                historyTargetLabel: 'liga',
                workerReplayTargets: [{ glyphName: 'A', layerId: 'layer-1' }]
            })
        ];

        const envelope = createMutationBatchEnvelopeFromChangeLogEntries(
            entries,
            {
                localSequence: 1,
                source: 'unit-test',
                windowId: 'sender-window'
            }
        );
        const roundTripped = createChangeLogEntriesFromMutationBatchEnvelope(
            envelope,
            {
                windowRoleLabel: 'receiver-window'
            }
        );

        expect(roundTripped).toHaveLength(1);
        expect(roundTripped[0]).toEqual(
            expect.objectContaining({
                windowId: 'sender-window',
                windowRoleLabel: 'linked-2',
                historyItemId: 'sender-window:history-undo-1',
                historyAction: 'undo',
                targetHistoryItemId: 'sender-window:history-change-1',
                transactionLabel: 'Undo',
                transactionId: 44,
                undoScope: 'glyph',
                path: 'glyphs.A:name',
                historyTargetType: 'feature',
                historyTargetKey: 'liga',
                historyTargetLabel: 'liga'
            })
        );
    });

    test('round-tripping preserves dotted glyph names and dotted layer ids', () => {
        const entries = [
            createLogEntry({
                timestamp: 123,
                windowId: 'sender-window',
                windowRoleLabel: 'main',
                historyItemId: 'history-dotted-1',
                transactionLabel: 'Resize dotted glyph',
                transactionId: 45,
                op: 'set',
                undoScope: 'layer',
                path: 'glyphs.A.alt:layers.layer.regular.v1:width',
                oldValue: 600,
                newValue: 720,
                workerReplayTargets: [
                    { glyphName: 'A.alt', layerId: 'layer.regular.v1' }
                ]
            })
        ];

        const envelope = createMutationBatchEnvelopeFromChangeLogEntries(
            entries,
            {
                localSequence: 1,
                source: 'unit-test',
                windowId: 'sender-window'
            }
        );
        const roundTripped = createChangeLogEntriesFromMutationBatchEnvelope(
            envelope,
            {
                windowRoleLabel: 'receiver-window'
            }
        );

        expect(envelope.patches[0]).toEqual(
            expect.objectContaining({
                forward: expect.objectContaining({
                    op: 'replace',
                    path: 'glyphs.A.alt:layers.layer.regular.v1:width',
                    value: 720
                }),
                inverse: expect.objectContaining({
                    op: 'replace',
                    path: 'glyphs.A.alt:layers.layer.regular.v1:width',
                    value: 600
                })
            })
        );
        expect(roundTripped[0]).toEqual(
            expect.objectContaining({
                path: 'glyphs.A.alt:layers.layer.regular.v1:width'
            })
        );
    });

    test('set envelopes prefer replay payloads for authoritative forward and inverse patches', () => {
        const entries = [
            createLogEntry({
                timestamp: 123,
                windowId: 'sender-window',
                windowRoleLabel: 'main',
                historyItemId: 'history-layer-delta-1',
                transactionLabel: 'Drag point',
                transactionId: 77,
                op: 'set',
                undoScope: 'layer',
                path: 'glyphs.o:layers.layer-1',
                oldValue: 'o',
                newValue: 'Drag point',
                replayOldValue: {
                    id: 'layer-1',
                    shapes: [{ nodes: '100 100 l 400 100 l' }]
                },
                replayNewValue: {
                    id: 'layer-1',
                    shapes: [{ nodes: '110 100 l 400 100 l' }]
                },
                workerReplayTargets: [{ glyphName: 'o', layerId: 'layer-1' }]
            })
        ];

        const envelope = createMutationBatchEnvelopeFromChangeLogEntries(
            entries,
            {
                localSequence: 1,
                source: 'unit-test',
                windowId: 'sender-window'
            }
        );

        expect(envelope.patches[0]).toEqual(
            expect.objectContaining({
                forward: expect.objectContaining({
                    op: 'replace',
                    path: 'glyphs.o:layers.layer-1',
                    value: {
                        id: 'layer-1',
                        shapes: [{ nodes: '110 100 l 400 100 l' }]
                    }
                }),
                inverse: expect.objectContaining({
                    op: 'replace',
                    path: 'glyphs.o:layers.layer-1',
                    value: {
                        id: 'layer-1',
                        shapes: [{ nodes: '100 100 l 400 100 l' }]
                    }
                })
            })
        );
    });

    test('splits change-log tails into one envelope per logical history item', () => {
        const entries = [
            createLogEntry({
                timestamp: 1,
                windowId: 'sender-window',
                windowRoleLabel: 'main',
                historyItemId: 'history-1',
                transactionLabel: 'Resize',
                transactionId: 1,
                op: 'set',
                undoScope: 'layer',
                path: 'glyphs.A:layers.layer-1.width',
                oldValue: 600,
                newValue: 700,
                workerReplayTargets: []
            }),
            createLogEntry({
                timestamp: 2,
                windowId: 'sender-window',
                windowRoleLabel: 'main',
                historyItemId: 'history-2',
                historyAction: 'undo',
                targetHistoryItemId: 'history-1',
                transactionLabel: 'Undo',
                transactionId: 2,
                op: 'set',
                undoScope: 'layer',
                path: 'glyphs.A:layers.layer-1.width',
                oldValue: 700,
                newValue: 600,
                workerReplayTargets: []
            })
        ];

        const envelopes = createMutationBatchEnvelopesFromChangeLogEntries(
            entries,
            {
                startingLocalSequence: 10,
                source: 'unit-test',
                windowId: 'sender-window'
            }
        );

        expect(envelopes).toHaveLength(2);
        expect(envelopes[0].metadata.historyItemId).toBe('history-1');
        expect(envelopes[1].metadata.historyAction).toBe('undo');
        expect(envelopes[1].metadata.targetHistoryItemId).toBe('history-1');
        expect(envelopes[0].localSequence).toBe(10);
        expect(envelopes[1].localSequence).toBe(11);
    });
});

const fs = require('fs');
const path = require('path');

const fontManager = require('../js/font-manager').default;
const { fontCompilation } = require('../js/font-compilation');
const { PatchSyncEngine: ChangeBridge } = require('../js/patch-sync-engine');
const { Font, withSuppressedModelRecording } = require('../js/babelfont-model');
const { yDocToJson } = require('../js/change-bridge-ydoc');
const { open_font_file } = require('../wasm-dist/babelfont_fontc_web');

function loadFontFixture(fileName) {
    const fixturePath = path.join(__dirname, '..', 'examples', fileName);
    const fileContents = fs.readFileSync(fixturePath, 'utf-8');
    return JSON.parse(open_font_file(fileName, fileContents));
}

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}

function makeWorkerCacheStatus(overrides = {}) {
    return {
        coherent: true,
        documentEpoch: 1,
        fontCacheEpoch: 1,
        filterEpoch: 1,
        subsetCacheEpoch: null,
        ...overrides
    };
}

function expectPlainShapeStructure(shapes, context) {
    expect(Array.isArray(shapes)).toBe(true);

    for (const [index, shape] of shapes.entries()) {
        expect(shape).toBeTruthy();
        expect(typeof shape).toBe('object');
        expect(Array.isArray(shape)).toBe(false);
        expect('Path' in shape).toBe(false);
        expect('Component' in shape).toBe(false);

        if ('nodes' in shape) {
            expect(Array.isArray(shape.nodes)).toBe(true);
            continue;
        }

        if ('reference' in shape) {
            expect(typeof shape.reference).toBe('string');
            continue;
        }

        throw new Error(
            `${context} shape ${index} is neither a plain path nor a plain component: ${JSON.stringify(
                shape
            )}`
        );
    }
}

function expectWorkerMirrorLayer(
    fontManagerInstance,
    glyphName,
    layerId,
    step
) {
    const workerDoc = fontManagerInstance.workerCacheYDoc;
    expect(workerDoc).toBeTruthy();

    const workerJson = yDocToJson(workerDoc.getMap('font'));
    const glyphs = Array.isArray(workerJson?.glyphs) ? workerJson.glyphs : [];
    const workerGlyph = glyphs.find((glyph) => glyph?.name === glyphName);
    expect(workerGlyph).toBeTruthy();

    const availableLayerIds = Array.isArray(workerGlyph?.layers)
        ? workerGlyph.layers.map((layer) => layer?.id).filter(Boolean)
        : [];
    const workerLayer = Array.isArray(workerGlyph?.layers)
        ? workerGlyph.layers.find((layer) => layer?.id === layerId)
        : null;
    if (!workerLayer) {
        throw new Error(
            `worker mirror missing ${glyphName}/${layerId} after move ${step}; available layers: ${availableLayerIds.join(', ')}`
        );
    }

    expectPlainShapeStructure(
        workerLayer.shapes,
        `worker mirror ${glyphName}/${layerId} after move ${step}`
    );
}

function getMatchingLayerTargets(
    fontModel,
    sourceGlyphName,
    sourceLayerId,
    glyphNames
) {
    const sourceGlyph = fontModel.findGlyph(sourceGlyphName);
    const sourceLayer = sourceGlyph?.findLayerById(sourceLayerId);

    return Array.from(new Set(glyphNames))
        .map((glyphName) => {
            const glyph = fontModel.findGlyph(glyphName);
            const matchedLayer =
                glyph?.findLayerById(sourceLayerId) ||
                sourceLayer?.getMatchingLayerOnGlyph?.(glyphName) ||
                glyph?.layers?.[0] ||
                null;

            return matchedLayer?.id
                ? { glyphName, layerId: matchedLayer.id }
                : null;
        })
        .filter(Boolean);
}

describe('Fustat anchor drag downstream composite serialization', () => {
    let originalOpenedFonts;
    let originalCurrentFontId;
    let originalFontCompilationInitialized;
    let sendMessageSpy;

    beforeEach(() => {
        originalOpenedFonts = fontManager.openedFonts;
        originalCurrentFontId = fontManager.currentFontId;
        originalFontCompilationInitialized = fontCompilation.isInitialized;

        const fontData = cloneJson(loadFontFixture('Fustat.glyphs'));
        const fontModel = Font.fromData(fontData);
        const currentFont = {
            babelfontJson: JSON.stringify(fontData),
            babelfontData: fontData,
            fontModel,
            name: 'Fustat',
            markDirty: jest.fn(),
            syncJsonFromModel: jest.fn(function () {
                this.babelfontJson = this.fontModel.toJSONString();
            }),
            requestRecompileWithoutDataChange: jest.fn()
        };

        fontManager.openedFonts = new Map([['test-font', currentFont]]);
        fontManager.currentFontId = 'test-font';
        fontCompilation.isInitialized = true;
        sendMessageSpy = jest
            .spyOn(fontCompilation, 'sendMessage')
            .mockResolvedValue({
                success: true,
                workerCacheStatus: makeWorkerCacheStatus()
            });

        const initialWorkerState = fontManager.buildWorkerSeedYjsState();
        fontManager.replaceWorkerYjsMirrorFromState(initialWorkerState);
    });

    afterEach(() => {
        sendMessageSpy?.mockRestore();
        fontManager.openedFonts = originalOpenedFonts;
        fontManager.currentFontId = originalCurrentFontId;
        fontCompilation.isInitialized = originalFontCompilationInitialized;
    });

    test('three top-anchor moves on o keep oacute plain-shape serializable', async () => {
        const fontModel = fontManager.currentFont.fontModel;
        const glyphO = fontModel.findGlyph('o');
        const glyphOacute = fontModel.findGlyph('oacute');
        const layerO = glyphO.layers[0];
        const topAnchor = layerO.anchors.find(
            (anchor) => anchor.name === 'top'
        );

        expect(glyphO).toBeTruthy();
        expect(glyphOacute).toBeTruthy();
        expect(layerO).toBeTruthy();
        expect(topAnchor).toBeTruthy();

        for (let moveIndex = 0; moveIndex < 3; moveIndex += 1) {
            withSuppressedModelRecording(() => {
                topAnchor.y += 10;
            });

            const affectedGlyphNames =
                fontModel.rebuildAutomaticCompositesForGlyphs(new Set(['o']), {
                    preferredLayerId: layerO.id,
                    preferredSourceGlyphName: 'o'
                });

            expect(affectedGlyphNames.has('oacute')).toBe(true);

            const oacuteLayer =
                glyphOacute.findLayerById(layerO.id) || glyphOacute.layers[0];
            const rawLayerData = oacuteLayer.toJSON();
            expectPlainShapeStructure(
                rawLayerData.shapes,
                `raw oacute layer after move ${moveIndex + 1}`
            );

            const serializedLayer = fontManager.serializeLayerForStorage(
                'oacute',
                oacuteLayer.id,
                rawLayerData
            );
            expect(serializedLayer).toBeTruthy();
            expectPlainShapeStructure(
                serializedLayer.shapes,
                `serialized oacute layer after move ${moveIndex + 1}`
            );

            await expect(
                fontManager.refreshGlyphsAfterModelBatch(
                    Array.from(affectedGlyphNames),
                    layerO.id,
                    { skipFingerprintBaseline: true }
                )
            ).resolves.toBeUndefined();

            expectWorkerMirrorLayer(
                fontManager,
                'oacute',
                oacuteLayer.id,
                moveIndex + 1
            );
        }
    });

    test('three top-anchor moves on o keep oacute valid through batched layer Yjs sync', () => {
        const fontData = fontManager.currentFont.babelfontData;
        const fontModel = fontManager.currentFont.fontModel;
        const bridge = new ChangeBridge();
        bridge.initFromJson(fontData);

        const glyphO = fontModel.findGlyph('o');
        const glyphOacute = fontModel.findGlyph('oacute');
        const layerO = glyphO.layers[0];
        const topAnchor = layerO.anchors.find(
            (anchor) => anchor.name === 'top'
        );

        expect(glyphO).toBeTruthy();
        expect(glyphOacute).toBeTruthy();
        expect(layerO).toBeTruthy();
        expect(topAnchor).toBeTruthy();

        for (let moveIndex = 0; moveIndex < 3; moveIndex += 1) {
            withSuppressedModelRecording(() => {
                topAnchor.y += 10;
            });

            const affectedGlyphNames =
                fontModel.rebuildAutomaticCompositesForGlyphs(new Set(['o']), {
                    preferredLayerId: layerO.id,
                    preferredSourceGlyphName: 'o'
                });

            const layerTargets = getMatchingLayerTargets(
                fontModel,
                'o',
                layerO.id,
                ['o', ...Array.from(affectedGlyphNames)]
            );

            bridge.syncLayersFromJson(layerTargets, 'Drag anchor');

            const bridgeJson = yDocToJson(bridge.fontMap);
            const bridgeGlyph = Array.isArray(bridgeJson.glyphs)
                ? bridgeJson.glyphs.find((glyph) => glyph?.name === 'oacute')
                : null;
            expect(bridgeGlyph).toBeTruthy();

            const bridgeLayer = Array.isArray(bridgeGlyph.layers)
                ? bridgeGlyph.layers.find(
                      (layer) =>
                          layer?.id ===
                          layerTargets.find(
                              (target) => target.glyphName === 'oacute'
                          )?.layerId
                  )
                : null;
            expect(bridgeLayer).toBeTruthy();
            expectPlainShapeStructure(
                bridgeLayer.shapes,
                `bridge oacute layer after move ${moveIndex + 1}`
            );
        }
    });
});

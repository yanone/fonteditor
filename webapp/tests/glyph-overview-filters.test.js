jest.mock('tippy.js', () => ({
    __esModule: true,
    default: jest.fn(() => ({
        destroy: jest.fn(),
        setProps: jest.fn(),
        show: jest.fn(),
        hide: jest.fn()
    }))
}));

jest.mock('tippy.js/dist/tippy.css', () => ({}), { virtual: true });

const { GlyphOverviewFilterManager } = require('../js/glyph-overview-filters');

function makeFilter(keyword, eventTypes = []) {
    return {
        path: 'basic',
        keyword,
        display_name: keyword,
        instance: null,
        eventTypes,
        classifications: new Map(),
        sourceLoaded: true,
        lastResults: []
    };
}

describe('GlyphOverviewFilterManager simple filters', () => {
    let manager;

    beforeEach(() => {
        manager = new GlyphOverviewFilterManager();
        manager.glyphOverview = {
            setActiveFilter: jest.fn(),
            updateSelectedGlyphGroups: jest.fn(),
            showFilterNotice: jest.fn(),
            showFilterError: jest.fn()
        };
        window.currentFontModel = {
            glyphs: [{ name: 'A' }, { name: 'B' }],
            findGlyph(name) {
                return this.glyphs.find((glyph) => glyph.name === name);
            }
        };
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('reuses an established cache when activating a filter', async () => {
        const active = makeFilter('com.context.allglyphs');
        const cached = makeFilter('user.cached', ['glyph.unicode.changed']);
        cached.lastResults = [{ glyph_name: 'A', groups: ['Encoded'] }];
        cached.groups = { Encoded: { description: 'Encoded', color: 'blue' } };
        manager.plugins = [active, cached];
        manager.activeFilter = active;

        const runFilter = jest
            .spyOn(manager, 'runFilter')
            .mockResolvedValue(undefined);
        const applyCached = jest.spyOn(manager, 'applyCachedFilterResults');

        await manager.activateFilter(cached, document.createElement('div'));

        expect(applyCached).toHaveBeenCalledWith(cached);
        expect(runFilter).not.toHaveBeenCalled();
    });

    test('reclassifies only filters subscribed to a content event', async () => {
        const subscribed = makeFilter('user.subscribed', [
            'glyph.unicode.changed'
        ]);
        const unrelated = makeFilter('user.unrelated', [
            'glyph.anchors.changed'
        ]);
        manager.plugins = [subscribed, unrelated];

        const classify = jest
            .spyOn(manager, 'classifyGlyph')
            .mockResolvedValue(undefined);

        await manager.handleCommittedGlyphFilterBatch({
            changes: [
                {
                    type: 'glyph.unicode.changed',
                    metadata: { glyphName: 'A' }
                }
            ]
        });

        expect(classify).toHaveBeenCalledTimes(1);
        expect(classify).toHaveBeenCalledWith(subscribed, { name: 'A' });
    });

    test('handles deletion for every filter without calling Python', async () => {
        const filter = makeFilter('user.any', []);
        filter.classifications.set('A', {
            groups: [{ name: 'Old', color: 'red' }]
        });
        manager.plugins = [filter];
        const classify = jest
            .spyOn(manager, 'classifyGlyph')
            .mockResolvedValue(undefined);

        await manager.handleCommittedChangeEntries([
            {
                path: 'glyphs.A',
                op: 'remove',
                oldValue: { name: 'A' },
                newValue: undefined
            }
        ]);

        expect(filter.classifications.has('A')).toBe(false);
        expect(classify).not.toHaveBeenCalled();
    });

    test('uses the most recently classified group color', () => {
        const filter = makeFilter('user.groups');
        filter.classifications.set('A', {
            groups: [{ name: 'Review', color: 'green' }]
        });
        filter.classifications.set('B', {
            groups: [{ name: 'Review', color: 'orange' }]
        });

        manager.derivePluginResults(filter);

        expect(filter.groups.Review.color).toBe('orange');
        expect(filter.lastResults).toEqual([
            { glyph_name: 'A', groups: ['Review'] },
            { glyph_name: 'B', groups: ['Review'] }
        ]);
    });
});

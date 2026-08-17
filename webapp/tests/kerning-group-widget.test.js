const {
    applyKerningGroupMembership,
    buildEditViewKerningGroupSide,
    renderKerningGroupWidget,
    summarizeKerningGroupsForGlyphs
} = require('../js/glyph-canvas/kerning-group-widget');

describe('kerning-group widget multi-glyph membership', () => {
    test('summarizes distinct groups and glyphs that still lack a group', () => {
        expect(
            summarizeKerningGroupsForGlyphs(
                {
                    ALeft: ['A'],
                    BLeft: ['B']
                },
                ['A', 'B', 'C']
            )
        ).toEqual({
            groupNames: ['ALeft', 'BLeft'],
            missingGlyphNames: ['C']
        });
    });

    test('adds an existing group only to glyphs that have none', () => {
        const fontModel = {
            second_kern_groups: {
                ALeft: ['A']
            }
        };

        expect(
            applyKerningGroupMembership(
                fontModel,
                'second',
                ['A', 'C'],
                'ALeft',
                true
            )
        ).toBe(true);
        expect(fontModel.second_kern_groups.ALeft).toEqual(['A', 'C']);
    });

    test('refuses to replace an existing different group', () => {
        const fontModel = {
            second_kern_groups: {
                ALeft: ['A'],
                BLeft: ['B']
            }
        };

        expect(
            applyKerningGroupMembership(
                fontModel,
                'second',
                ['A'],
                'BLeft',
                true
            )
        ).toBe(false);
        expect(fontModel.second_kern_groups.ALeft).toEqual(['A']);
        expect(fontModel.second_kern_groups.BLeft).toEqual(['B']);
    });

    test('renders several chips and a fill-only add placeholder', () => {
        const parent = document.createElement('div');
        const center = document.createElement('div');
        const side = buildEditViewKerningGroupSide('second', ['A', 'B', 'C'], {
            ALeft: ['A'],
            BLeft: ['B']
        });

        renderKerningGroupWidget(parent, {
            startSide: side,
            endSide: buildEditViewKerningGroupSide(
                'first',
                ['A', 'B', 'C'],
                {}
            ),
            center
        });

        const start = parent.querySelectorAll('.glyph-kerning-side')[0];
        expect(
            Array.from(start.querySelectorAll('.glyph-kerning-pill-label')).map(
                (element) => element.textContent
            )
        ).toEqual(['@ALeft', '@BLeft']);
        const addChip = start.querySelector('.glyph-kerning-pill-placeholder');
        expect(addChip).not.toBeNull();
        expect(addChip.title).toBe('Only empty fields will be filled');
        expect(addChip.tagName).toBe('BUTTON');
        expect(start.classList.contains('glyph-kerning-side-multiline')).toBe(
            true
        );
        expect(
            parent
                .querySelectorAll('.glyph-kerning-side')[1]
                .classList.contains('glyph-kerning-side-multiline')
        ).toBe(false);
    });

    test('keeps two-chip sides stacked instead of wrapping', () => {
        const parent = document.createElement('div');
        const center = document.createElement('div');

        renderKerningGroupWidget(parent, {
            startSide: buildEditViewKerningGroupSide('second', ['A', 'B'], {
                ALeft: ['A'],
                BLeft: ['B']
            }),
            endSide: buildEditViewKerningGroupSide('first', ['A'], {
                AFirst: ['A']
            }),
            center
        });

        const sides = parent.querySelectorAll('.glyph-kerning-side');
        expect(
            sides[0].classList.contains('glyph-kerning-side-multiline')
        ).toBe(false);
        expect(
            sides[1].classList.contains('glyph-kerning-side-multiline')
        ).toBe(false);
    });
});

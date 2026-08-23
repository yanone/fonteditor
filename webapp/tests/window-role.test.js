const { WindowRoleManager } = require('../js/window-role');

function occupancyKey(sessionId) {
    return `linkedWindowOccupancy.${sessionId}`;
}

describe('WindowRoleManager linked ordinals', () => {
    beforeEach(() => {
        localStorage.clear();
        sessionStorage.clear();
    });

    afterEach(() => {
        localStorage.clear();
        sessionStorage.clear();
    });

    test('reuses 1 after every linked window has been released', () => {
        const main = new WindowRoleManager();

        expect(main.allocateLinkedOrdinal('font.glyphs')).toBe(1);
        expect(main.allocateLinkedOrdinal('font.glyphs')).toBe(2);

        main.releaseLinkedOrdinal(1);
        main.releaseLinkedOrdinal(2);

        expect(main.allocateLinkedOrdinal('font.glyphs')).toBe(1);
    });

    test('fills the lowest closed slot while later windows stay open', () => {
        const main = new WindowRoleManager();

        expect(main.allocateLinkedOrdinal()).toBe(1);
        expect(main.allocateLinkedOrdinal()).toBe(2);
        expect(main.allocateLinkedOrdinal()).toBe(3);

        main.releaseLinkedOrdinal(2);

        expect(main.allocateLinkedOrdinal()).toBe(2);
        expect(main.allocateLinkedOrdinal()).toBe(4);
    });

    test('treats stale occupancy as free so crashed windows do not pin numbers', () => {
        const main = new WindowRoleManager();
        localStorage.setItem(
            occupancyKey(main.sessionId),
            JSON.stringify({
                1: {
                    instanceId: 'dead-window',
                    updatedAt: Date.now() - 60_000
                }
            })
        );

        expect(main.allocateLinkedOrdinal()).toBe(1);
    });

    test('does not release another window live claim', () => {
        const opener = new WindowRoleManager();
        expect(opener.allocateLinkedOrdinal()).toBe(1);

        const other = new WindowRoleManager();
        other.releaseLinkedOrdinal(1);

        expect(other.allocateLinkedOrdinal()).toBe(2);

        opener.releaseLinkedOrdinal(1);
        expect(other.allocateLinkedOrdinal()).toBe(1);
    });

    test('force-release frees a slot the opener no longer owns', () => {
        const opener = new WindowRoleManager();
        expect(opener.allocateLinkedOrdinal()).toBe(1);

        const child = new WindowRoleManager();
        child.claimLinkedOrdinal(1);

        opener.releaseLinkedOrdinal(1);
        expect(opener.allocateLinkedOrdinal()).toBe(2);

        opener.releaseLinkedOrdinal(1, true);
        expect(opener.allocateLinkedOrdinal()).toBe(1);
    });
});

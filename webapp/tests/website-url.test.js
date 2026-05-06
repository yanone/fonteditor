const { resolveWebsiteURL } = require('../js/website-url.ts');

describe('resolveWebsiteURL', () => {
    it('uses localhost only for genuine local development hosts', () => {
        expect(resolveWebsiteURL('localhost')).toBe('http://localhost:8788');
        expect(resolveWebsiteURL('127.0.0.1')).toBe('http://localhost:8788');
    });

    it('maps the preview editor host to the production website', () => {
        expect(resolveWebsiteURL('preview.editor.counterpunch.space')).toBe(
            'https://counterpunch.space'
        );
    });

    it('maps the production editor host to the production website', () => {
        expect(resolveWebsiteURL('editor.counterpunch.space')).toBe(
            'https://counterpunch.space'
        );
    });
});

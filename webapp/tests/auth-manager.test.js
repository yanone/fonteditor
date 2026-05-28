jest.mock('../js/website-url', () => ({
    resolveWebsiteURL: jest.fn(() => 'https://counterpunch.space')
}));

describe('AuthManager.checkAuthStatus', () => {
    let originalAuthManager;
    let originalFetch;

    beforeEach(() => {
        jest.resetModules();
        document.cookie = 'editor_session=; Max-Age=0; Path=/';
        document.cookie = 'session=; Max-Age=0; Path=/';
        originalAuthManager = window.authManager;
        originalFetch = global.fetch;
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                user: { email: 'bootstrap@counterpunch.test' },
                subscription: null,
                credits: null
            })
        });
    });

    afterEach(() => {
        document.cookie = 'editor_session=; Max-Age=0; Path=/';
        document.cookie = 'session=; Max-Age=0; Path=/';
        window.authManager = originalAuthManager;
        global.fetch = originalFetch;
        jest.restoreAllMocks();
    });

    it('clears stale legacy session cookies after a 401 without an editor_session token', async () => {
        require('../js/auth-manager');

        const authManager = window.authManager;
        global.fetch.mockResolvedValueOnce({
            ok: false,
            status: 401,
            json: async () => ({ error: 'invalid session' })
        });
        document.cookie = 'session=legacy-base64-token; Path=/';

        await authManager.checkAuthStatus();

        expect(document.cookie).not.toContain('session=legacy-base64-token');
        expect(document.cookie).not.toContain('editor_session=');
        expect(authManager.sessionToken).toBeNull();
        expect(authManager.isAuthenticated()).toBe(false);
    });

    it('exchanges URL handoff codes before checking auth status', async () => {
        const replaceStateSpy = jest.spyOn(window.history, 'replaceState');
        window.history.replaceState({}, '', '/?handoff=one-time-code');
        global.fetch = jest
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ sessionToken: 'signed-editor-token' })
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    user: { email: 'bootstrap@counterpunch.test' },
                    subscription: null,
                    credits: null
                })
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    user: { email: 'bootstrap@counterpunch.test' },
                    subscription: null,
                    credits: null
                })
            });

        require('../js/auth-manager');

        const authManager = window.authManager;
        await authManager.checkAuthStatus();

        expect(global.fetch.mock.calls[0][0]).toBe(
            'https://counterpunch.space/api/auth/exchange-handoff'
        );
        expect(document.cookie).toContain('editor_session=signed-editor-token');
        expect(replaceStateSpy).toHaveBeenCalled();
        expect(window.location.search).toBe('');
    });
});

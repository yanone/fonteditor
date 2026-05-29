import { expect, test } from '@playwright/test';

test.describe('Auth handoff bootstrap', () => {
    test('exchanges a one-time handoff code and removes it from the URL', async ({
        page
    }) => {
        let exchangeCalls = 0;
        let authMeCalls = 0;

        await page.route(
            'http://localhost:8788/api/auth/exchange-handoff',
            async (route) => {
                exchangeCalls += 1;
                await route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify({
                        sessionToken: 'signed-editor-token'
                    })
                });
            }
        );

        await page.route(
            /http:\/\/(localhost|127\.0\.0\.1|\[::1\]):8788\/api\/auth\/me(?:\?.*)?$/,
            async (route) => {
                authMeCalls += 1;
                await route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify({
                        user: { email: 'bootstrap@counterpunch.test' },
                        subscription: null,
                        credits: null
                    })
                });
            }
        );

        await page.goto('/?test=true&handoff=one-time-code');

        await page.waitForFunction(() => {
            return (
                !!window.authManager?.isAuthenticated?.() &&
                document.cookie.includes('editor_session=signed-editor-token')
            );
        });

        expect(exchangeCalls).toBe(1);
        expect(authMeCalls).toBeGreaterThanOrEqual(1);
        await expect(page).toHaveURL(/\?test=true$/);

        const cookieString = await page.evaluate(() => document.cookie);
        expect(cookieString).toContain('editor_session=signed-editor-token');
        expect(cookieString).not.toContain('handoff=');
    });
});

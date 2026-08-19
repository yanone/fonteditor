const {
    getSystemNotificationPermission,
    requestSystemNotificationPermission,
    showSystemNotification
} = require('../js/system-notifications.ts');

function mockNotification(permission) {
    const instances = [];
    class FakeNotification {
        constructor(title, options) {
            this.title = title;
            this.options = options;
            this.onclick = null;
            this.closed = false;
            instances.push(this);
        }

        close() {
            this.closed = true;
        }
    }

    FakeNotification.permission = permission;
    FakeNotification.requestPermission = jest.fn(async () => permission);
    FakeNotification.instances = instances;
    global.Notification = FakeNotification;
    return FakeNotification;
}

describe('system notifications', () => {
    const originalNotification = global.Notification;
    const originalFontModel = window.currentFontModel;

    afterEach(() => {
        window.currentFontModel = originalFontModel;
        if (originalNotification === undefined) {
            delete global.Notification;
        } else {
            global.Notification = originalNotification;
        }
    });

    test('reports unsupported when Notification is missing', async () => {
        delete global.Notification;

        expect(getSystemNotificationPermission()).toBe('unsupported');
        expect(await requestSystemNotificationPermission()).toBe('unsupported');
        await expect(showSystemNotification('Hello', 'Body')).resolves.toEqual({
            shown: false,
            permission: 'unsupported',
            reason: 'unsupported'
        });
    });

    test('rejects an empty title without posting', async () => {
        mockNotification('granted');

        await expect(showSystemNotification('  ')).resolves.toEqual({
            shown: false,
            permission: 'granted',
            reason: 'empty-title'
        });
        expect(global.Notification.instances).toHaveLength(0);
    });

    test('does not post when permission is denied', async () => {
        mockNotification('denied');

        await expect(
            showSystemNotification('Export complete', 'MyFont.otf written')
        ).resolves.toEqual({
            shown: false,
            permission: 'denied',
            reason: 'denied'
        });
        expect(global.Notification.instances).toHaveLength(0);
    });

    test('posts a notification when permission is granted', async () => {
        mockNotification('granted');

        await expect(
            showSystemNotification('Export complete', {
                body: 'MyFont.otf written'
            })
        ).resolves.toEqual({
            shown: true,
            permission: 'granted'
        });

        expect(global.Notification.instances).toHaveLength(1);
        expect(global.Notification.instances[0].title).toBe('Export complete');
        expect(global.Notification.instances[0].options.body).toBe(
            'MyFont.otf written'
        );
        expect(global.Notification.instances[0].options.renotify).toBe(true);
        expect(global.Notification.instances[0].options.tag).toMatch(
            /^cp-notify-/
        );
    });

    test('prepends the open font family name to the body', async () => {
        mockNotification('granted');
        window.currentFontModel = {
            names: { family_name: { dflt: 'Source Sans 3' } }
        };

        await showSystemNotification('Export complete', 'MyFont.otf written');

        expect(global.Notification.instances[0].options.body).toBe(
            'Source Sans 3\nMyFont.otf written'
        );
    });

    test('accepts a string body', async () => {
        mockNotification('granted');

        await showSystemNotification('Done', 'Finished');

        expect(global.Notification.instances[0].options.body).toBe('Finished');
    });

    test('reuses a tag and closes the previous identically worded notification', async () => {
        mockNotification('granted');

        await showSystemNotification('Export complete', 'Done');
        await showSystemNotification('Export complete', 'Done');

        expect(global.Notification.instances).toHaveLength(2);
        expect(global.Notification.instances[0].closed).toBe(true);
        expect(global.Notification.instances[1].closed).toBe(false);
        expect(global.Notification.instances[0].options.tag).toBe(
            global.Notification.instances[1].options.tag
        );
        expect(global.Notification.instances[1].options.renotify).toBe(true);
    });

    test('uses a different tag for different wording', async () => {
        mockNotification('granted');

        await showSystemNotification('Export complete', 'Done');
        await showSystemNotification('Export complete', 'Also done');

        expect(global.Notification.instances[0].options.tag).not.toBe(
            global.Notification.instances[1].options.tag
        );
        expect(global.Notification.instances[0].closed).toBe(false);
    });
});

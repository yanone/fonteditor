import { Logger } from './logger';

const console = new Logger('SystemNotifications');

const DEFAULT_ICON = 'assets/favicon/icon.svg';

export type SystemNotificationPermission =
    NotificationPermission | 'unsupported';

export type SystemNotificationOptions = {
    body?: string;
    tag?: string;
};

export type SystemNotificationResult = {
    shown: boolean;
    permission: SystemNotificationPermission;
    reason?: 'unsupported' | 'denied' | 'permission-pending' | 'empty-title';
};

function notificationsSupported(): boolean {
    return typeof Notification !== 'undefined';
}

export function getSystemNotificationPermission(): SystemNotificationPermission {
    if (!notificationsSupported()) {
        return 'unsupported';
    }
    return Notification.permission;
}

export async function requestSystemNotificationPermission(): Promise<SystemNotificationPermission> {
    const current = getSystemNotificationPermission();
    if (current !== 'default') {
        return current;
    }
    return Notification.requestPermission();
}

function resolveBody(options: SystemNotificationOptions | string | undefined): {
    body: string;
    tag?: string;
} {
    if (typeof options === 'string') {
        return { body: options };
    }
    return {
        body: options?.body ?? '',
        tag: options?.tag
    };
}

async function displayNotification(
    title: string,
    notificationOptions: NotificationOptions
): Promise<void> {
    if (
        document.visibilityState === 'hidden' &&
        typeof navigator !== 'undefined' &&
        'serviceWorker' in navigator
    ) {
        const registration = await navigator.serviceWorker.getRegistration();
        if (registration) {
            await registration.showNotification(title, notificationOptions);
            return;
        }
    }

    const notification = new Notification(title, notificationOptions);
    notification.onclick = () => {
        window.focus();
        notification.close();
    };
}

/**
 * Show an OS-level system notification.
 *
 * Use only for developer-requested actions (for example a long-running
 * export or script finishing). Never call this automatically as
 * confirmation of routine edits, saves, compiles, or other implicit success.
 */
export async function showSystemNotification(
    title: string,
    options: SystemNotificationOptions | string = {}
): Promise<SystemNotificationResult> {
    const normalizedTitle = String(title ?? '').trim();
    const { body, tag } = resolveBody(options);

    if (!normalizedTitle) {
        return {
            shown: false,
            permission: getSystemNotificationPermission(),
            reason: 'empty-title'
        };
    }

    if (!notificationsSupported()) {
        console.warn('Notifications API is not available in this browser');
        return {
            shown: false,
            permission: 'unsupported',
            reason: 'unsupported'
        };
    }

    let permission: NotificationPermission = Notification.permission;
    if (permission === 'default') {
        permission = await Notification.requestPermission();
    }

    if (permission !== 'granted') {
        console.warn('System notification permission is', permission);
        return {
            shown: false,
            permission,
            reason: permission === 'denied' ? 'denied' : 'permission-pending'
        };
    }

    const notificationOptions: NotificationOptions = {
        body: String(body ?? ''),
        icon: new URL(DEFAULT_ICON, window.location.href).href
    };
    if (tag) {
        notificationOptions.tag = tag;
    }

    try {
        await displayNotification(normalizedTitle, notificationOptions);
        return { shown: true, permission };
    } catch (error) {
        console.error('Failed to show system notification', error);
        return {
            shown: false,
            permission,
            reason: 'unsupported'
        };
    }
}

window.getSystemNotificationPermission = getSystemNotificationPermission;
window.requestSystemNotificationPermission =
    requestSystemNotificationPermission;
window.showSystemNotification = showSystemNotification;

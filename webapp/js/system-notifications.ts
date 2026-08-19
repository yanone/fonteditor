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

type DisplayNotificationOptions = NotificationOptions & {
    tag?: string;
    renotify?: boolean;
    timestamp?: number;
};

const lastNotificationsByTag = new Map<string, Notification>();

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

function resolveOpenFontFamilyName(): string {
    const names = window.currentFontModel?.names?.family_name;
    if (!names || typeof names !== 'object') {
        return '';
    }

    const dictionary = names as Record<string, string | undefined>;
    const preferred =
        dictionary.dflt ||
        dictionary.en ||
        Object.values(dictionary).find(
            (value) => typeof value === 'string' && value.trim()
        );

    return typeof preferred === 'string' ? preferred.trim() : '';
}

function composeNotificationBody(userBody: string): string {
    const fontName = resolveOpenFontFamilyName();
    const trimmedBody = String(userBody ?? '').trim();
    return [fontName, trimmedBody].filter(Boolean).join('\n');
}

function notificationTagForWording(title: string, body: string): string {
    const wording = `${title}\n${body}`;
    let hash = 2166136261;
    for (let i = 0; i < wording.length; i++) {
        hash ^= wording.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return `cp-notify-${(hash >>> 0).toString(16)}`;
}

async function displayNotification(
    title: string,
    notificationOptions: DisplayNotificationOptions
): Promise<void> {
    const tag = notificationOptions.tag;
    if (
        tag &&
        typeof navigator !== 'undefined' &&
        'serviceWorker' in navigator
    ) {
        const registration = await navigator.serviceWorker.getRegistration();
        if (registration) {
            const previous = await registration.getNotifications({ tag });
            previous.forEach((item) => item.close());
            await registration.showNotification(title, notificationOptions);
            return;
        }
    }

    if (tag) {
        lastNotificationsByTag.get(tag)?.close();
    }

    const notification = new Notification(title, notificationOptions);
    if (tag) {
        lastNotificationsByTag.set(tag, notification);
    }
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

    const composedBody = composeNotificationBody(body);
    const notificationOptions: DisplayNotificationOptions = {
        body: composedBody,
        icon: new URL(DEFAULT_ICON, window.location.href).href,
        tag: tag || notificationTagForWording(normalizedTitle, composedBody),
        renotify: true,
        timestamp: Date.now()
    };

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

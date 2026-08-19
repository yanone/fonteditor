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

const lastNotificationByWording = new Map<string, Notification>();
const lastTagByWording = new Map<string, string>();
let notificationSerial = 0;

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

function wordingKey(title: string, body: string): string {
    return `${title}\n${body}`;
}

function wordingHash(title: string, body: string): string {
    const wording = wordingKey(title, body);
    let hash = 2166136261;
    for (let i = 0; i < wording.length; i++) {
        hash ^= wording.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
}

async function getServiceWorkerRegistration(): Promise<ServiceWorkerRegistration | null> {
    try {
        if (
            typeof navigator === 'undefined' ||
            !('serviceWorker' in navigator)
        ) {
            return null;
        }
        return (await navigator.serviceWorker.getRegistration()) ?? null;
    } catch {
        return null;
    }
}

function nextUniqueTag(title: string, body: string): string {
    notificationSerial += 1;
    return `cp-notify-${wordingHash(title, body)}-${Date.now()}-${notificationSerial}`;
}

async function closePreviousMatchingNotifications(
    title: string,
    body: string
): Promise<void> {
    const key = wordingKey(title, body);
    lastNotificationByWording.get(key)?.close();
    lastNotificationByWording.delete(key);

    const registration = await getServiceWorkerRegistration();
    if (!registration) {
        lastTagByWording.delete(key);
        return;
    }

    const previousTag = lastTagByWording.get(key);
    const displayed = await registration.getNotifications();
    displayed.forEach((item) => {
        const sameWording = item.title === title && (item.body || '') === body;
        const sameTag = previousTag !== undefined && item.tag === previousTag;
        if (sameWording || sameTag) {
            item.close();
        }
    });
    lastTagByWording.delete(key);
}

async function displayNotification(
    title: string,
    notificationOptions: DisplayNotificationOptions
): Promise<void> {
    await closePreviousMatchingNotifications(
        title,
        notificationOptions.body || ''
    );

    const tag = notificationOptions.tag;
    const key = wordingKey(title, notificationOptions.body || '');

    const registration = await getServiceWorkerRegistration();
    if (registration) {
        if (tag) {
            lastTagByWording.set(key, tag);
        }
        await registration.showNotification(title, notificationOptions);
        return;
    }

    const notification = new Notification(title, notificationOptions);
    lastNotificationByWording.set(key, notification);
    if (tag) {
        lastTagByWording.set(key, tag);
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
    const { body } = resolveBody(options);

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
        tag: nextUniqueTag(normalizedTitle, composedBody),
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

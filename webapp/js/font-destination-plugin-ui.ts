import {
    FontDestinationManifest,
    fontDestinationPluginManager
} from './font-destination-plugin-manager';
import { Logger } from './logger';
import { bindModalEscape, type ModalEscapeBinding } from './ui/modal-escape';
import { createFolderSetupCallout } from './folder-permissions-dialog';
import { settingsFolder } from './settings-folder';

const console = new Logger('FontDestinationPluginUI');

let pluginManagerEscapeBinding: ModalEscapeBinding | null = null;

function createTextElement<K extends keyof HTMLElementTagNameMap>(
    tagName: K,
    text: string,
    className?: string
): HTMLElementTagNameMap[K] {
    const element = document.createElement(tagName);
    element.textContent = text;
    if (className) {
        element.className = className;
    }
    return element;
}

function getModalElements(): {
    overlay: HTMLElement;
    content: HTMLElement;
    closeButton: HTMLButtonElement;
} | null {
    const overlay = document.getElementById('plugin-manager-modal');
    const content = document.getElementById('plugin-manager-modal-content');
    const closeButton = document.getElementById(
        'plugin-manager-modal-close-btn'
    ) as HTMLButtonElement | null;
    if (!overlay || !content || !closeButton) {
        return null;
    }
    return { overlay, content, closeButton };
}

function closePluginManager(): void {
    pluginManagerEscapeBinding?.release();
    pluginManagerEscapeBinding = null;
    const overlay = document.getElementById('plugin-manager-modal');
    if (overlay) {
        overlay.style.display = 'none';
    }
}

async function renderPluginManager(content: HTMLElement): Promise<void> {
    content.replaceChildren(
        createTextElement('p', 'Searching Font Destinations…')
    );
    try {
        const settingsAccess = await settingsFolder.getAccessState();
        if (settingsAccess !== 'ready') {
            const notice = document.createElement('section');
            notice.className = 'plugin-manager-storage-notice';
            notice.appendChild(createFolderSetupCallout());
            content.replaceChildren(notice);
            return;
        }
        const storageStatus =
            await fontDestinationPluginManager.getPluginStorageStatus();
        if (storageStatus !== 'ready') {
            content.replaceChildren(
                createPluginStorageNotice(storageStatus, content)
            );
            return;
        }
        const [catalogue, installedWheels] = await Promise.all([
            fontDestinationPluginManager.discoverCatalogue(),
            fontDestinationPluginManager.getInstalledWheelFiles()
        ]);
        const installedNames = new Set(
            installedWheels.map((wheel) => wheel.path)
        );
        const section = document.createElement('section');
        section.className = 'plugin-manager-section';
        section.appendChild(createTextElement('h4', 'Font Destinations'));
        const diagnostics = fontDestinationPluginManager.getDiagnostics();
        if (diagnostics.length) {
            section.appendChild(createPluginDiagnostics(diagnostics));
        }

        if (!catalogue.length) {
            section.appendChild(
                createTextElement(
                    'p',
                    'No Font Destination plugins were found on GitHub.'
                )
            );
        }

        for (const manifest of catalogue) {
            section.appendChild(
                createPluginRow(manifest, installedNames, content)
            );
        }
        content.replaceChildren(section);
    } catch (error: unknown) {
        console.error('Could not load Plugin Manager:', error);
        content.replaceChildren(
            createTextElement(
                'p',
                error instanceof Error
                    ? error.message
                    : 'Could not load Font Destination plugins.'
            )
        );
    }
}

function createPluginStorageNotice(
    storageStatus: 'settings-folder-not-connected' | 'plugins-folder-missing',
    content: HTMLElement
): HTMLElement {
    const notice = document.createElement('section');
    notice.className = 'plugin-manager-storage-notice';
    const isSettingsFolderMissing =
        storageStatus === 'settings-folder-not-connected';
    notice.appendChild(
        createTextElement(
            'h4',
            isSettingsFolderMissing
                ? 'Connect a Settings Folder'
                : 'Create the Plugins Folder'
        )
    );
    notice.appendChild(
        createTextElement(
            'p',
            isSettingsFolderMissing
                ? 'Choose the Settings Folder Counterpunch should use for Font Destination plugins.'
                : 'The connected Settings Folder has no /Plugins directory. Plugin wheels are stored there.'
        )
    );
    const action = document.createElement('button');
    action.className = 'dialog-button plugin-manager-action';
    action.type = 'button';
    action.textContent = isSettingsFolderMissing
        ? 'Connect Folder'
        : 'Create Plugins Folder';
    action.addEventListener('click', async () => {
        action.disabled = true;
        try {
            if (isSettingsFolderMissing) {
                await fontDestinationPluginManager.connectSettingsFolder();
            } else {
                await fontDestinationPluginManager.createPluginsDirectory();
            }
            await renderPluginManager(content);
        } catch (error: unknown) {
            window.alert(
                error instanceof Error
                    ? error.message
                    : 'Could not prepare plugin storage.'
            );
            action.disabled = false;
        }
    });
    notice.appendChild(action);
    return notice;
}

function createPluginDiagnostics(messages: string[]): HTMLElement {
    const notice = document.createElement('section');
    notice.className = 'plugin-manager-diagnostics';
    notice.appendChild(createTextElement('h4', 'Plugin Diagnostics'));
    for (const message of messages) {
        notice.appendChild(createTextElement('p', message));
    }
    return notice;
}

function createPluginRow(
    manifest: FontDestinationManifest,
    installedNames: Set<string>,
    content: HTMLElement
): HTMLElement {
    const isInstalled = Array.from(installedNames).some((path) =>
        path.split('/').pop()?.startsWith(manifest.wheelAssetPrefix)
    );
    const row = document.createElement('article');
    row.className = 'plugin-manager-row';

    const details = document.createElement('div');
    details.className = 'plugin-manager-details';
    details.appendChild(createTextElement('h5', manifest.name));
    details.appendChild(createTextElement('p', manifest.description));
    if (manifest.imageUrl) {
        const image = document.createElement('img');
        image.className = 'plugin-manager-image';
        image.alt = `${manifest.name} preview`;
        image.crossOrigin = 'anonymous';
        image.loading = 'lazy';
        image.decoding = 'async';
        image.src = manifest.imageUrl;
        details.appendChild(image);
    }
    const repository = document.createElement('a');
    repository.href = manifest.repositoryUrl;
    repository.target = '_blank';
    repository.rel = 'noreferrer';
    repository.textContent = 'View on GitHub';
    details.appendChild(repository);
    row.appendChild(details);

    const action = document.createElement('button');
    action.className = 'dialog-button plugin-manager-action';
    action.type = 'button';
    action.textContent = isInstalled ? 'Uninstall' : 'Install';
    action.addEventListener('click', async () => {
        action.disabled = true;
        try {
            if (isInstalled) {
                const wheel = Array.from(installedNames).find((path) =>
                    path.split('/').pop()?.startsWith(manifest.wheelAssetPrefix)
                );
                if (wheel) {
                    await fontDestinationPluginManager.uninstall(wheel);
                }
            } else {
                await fontDestinationPluginManager.install(manifest);
            }
            await renderPluginManager(content);
        } catch (error: unknown) {
            window.alert(
                error instanceof Error
                    ? error.message
                    : 'Plugin installation failed.'
            );
            action.disabled = false;
        }
    });
    row.appendChild(action);
    return row;
}

/** Open the shared modal with catalogue entries and install controls. */
export async function showFontDestinationPluginManager(): Promise<void> {
    const elements = getModalElements();
    if (!elements) {
        return;
    }
    elements.overlay.style.display = 'flex';
    pluginManagerEscapeBinding?.release();
    pluginManagerEscapeBinding = bindModalEscape(closePluginManager, {
        isOpen: () =>
            document.getElementById('plugin-manager-modal')?.style.display ===
            'flex'
    });
    elements.closeButton.onclick = closePluginManager;
    elements.overlay.onclick = (event) => {
        if (event.target === elements.overlay) {
            closePluginManager();
        }
    };
    await renderPluginManager(elements.content);
}

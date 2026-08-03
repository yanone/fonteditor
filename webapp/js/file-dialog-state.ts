export type DialogFontSource = {
    path?: string;
    sourcePlugin?: { getId?: () => string };
} | null;

export type FileDialogMode = 'open' | 'save-as';

export type FileDialogSaveWarningState = {
    visible: boolean;
    title: string;
    label: string;
    icon: string;
    tone: 'warning' | 'error';
    canSave: boolean;
};

export function getDefaultDialogSelectionPath(
    pluginId: string,
    currentFont: DialogFontSource
): string | null {
    if (!currentFont?.path) {
        return null;
    }

    return currentFont.sourcePlugin?.getId?.() === pluginId
        ? currentFont.path
        : null;
}

export function isOpenDialogConfirmEnabled(
    selectedPathIsOpenableFont: boolean
): boolean {
    return selectedPathIsOpenableFont;
}

export function shouldOpenFileOnDialogDoubleClick(
    mode: FileDialogMode,
    isFont: boolean
): boolean {
    return mode === 'open' && isFont;
}

export function getFileDialogPrimaryAction(
    mode: FileDialogMode,
    selectedPath: string | null,
    selectedPathIsOpenableFont: boolean,
    pluginId: string,
    currentFont: DialogFontSource
): 'save' | 'open' | 'close' | 'none' {
    if (mode === 'save-as') {
        return 'save';
    }

    if (!selectedPath || !selectedPathIsOpenableFont) {
        return 'none';
    }

    if (
        currentFont?.path === selectedPath &&
        currentFont.sourcePlugin?.getId?.() === pluginId
    ) {
        return 'close';
    }

    return 'open';
}

export function getFileDialogHeaderActions(
    pluginId: string,
    supportsNewFolder: boolean,
    showsManualRefreshButton: boolean
) {
    return {
        showsUploadButtons: pluginId === 'memory',
        showsNewFolderButton: supportsNewFolder,
        showsRefreshButton: showsManualRefreshButton
    };
}

export function getFileDialogSaveWarningPresentation(
    warningState: FileDialogSaveWarningState | null,
    isSaveAsDialog: boolean
) {
    const visible = Boolean(warningState?.visible && isSaveAsDialog);

    return {
        visible,
        blocksSave: Boolean(visible && !warningState?.canSave),
        title: visible ? warningState!.title : '',
        label: visible ? warningState!.label : '',
        icon: visible ? warningState!.icon : '',
        tone: visible ? warningState!.tone : ''
    };
}

export function getFileDialogRefreshStatus(
    showsManualRefreshButton: boolean,
    timestamp: number | null
) {
    if (!showsManualRefreshButton) {
        return { visible: false, text: '' };
    }

    const timestampText = timestamp
        ? new Date(timestamp).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit'
          })
        : 'Not refreshed yet';
    return { visible: true, text: `Last refreshed ${timestampText}` };
}

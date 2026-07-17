import {
    awaitStableWorkerState,
    fontCompilation,
    fullFontCompilation
} from './font-compilation';
import { Logger } from './logger';

const console = new Logger('BinaryFontExport');

type SaveFilePickerOptions = {
    suggestedName: string;
    types: Array<{
        description: string;
        accept: Record<string, string[]>;
    }>;
};

type SaveFilePickerWindow = Window & {
    showSaveFilePicker?: (
        options: SaveFilePickerOptions
    ) => Promise<FileSystemFileHandle>;
};

type ExportedBinaryFontMetadata = {
    byteLength: number;
    changeVersion: number;
    filename: string;
    format: 'ttf';
    mimeType: 'font/ttf';
    timeTakenMs: number;
};

let destination: {
    font: object;
    handle: FileSystemFileHandle;
} | null = null;
let exportInProgress = false;
let exportFeedbackReset: (() => void) | null = null;

function getCurrentFont(): {
    changeVersion: number;
    path?: string;
} & object {
    const currentFont = window.fontManager?.currentFont;
    if (!currentFont) {
        throw new Error('Open a font before exporting a binary font.');
    }
    return currentFont;
}

function getSuggestedFilename(path: string | undefined): string {
    const sourceName = path?.split('/').pop() || 'font';
    const dotIndex = sourceName.lastIndexOf('.');
    const baseName = dotIndex > 0 ? sourceName.slice(0, dotIndex) : sourceName;
    return `${baseName || 'font'}.ttf`;
}

function getExportDestinationForFont(
    currentFont: object
): FileSystemFileHandle | null {
    if (destination?.font !== currentFont) {
        destination = null;
    }
    return destination?.handle ?? null;
}

async function chooseDestination(
    suggestedName: string
): Promise<FileSystemFileHandle | null> {
    const picker = (window as SaveFilePickerWindow).showSaveFilePicker;
    if (!picker) {
        throw new Error(
            'Binary font export requires a browser with the File System Access API.'
        );
    }

    try {
        return await picker({
            suggestedName,
            types: [
                {
                    description: 'TrueType font',
                    accept: { 'font/ttf': ['.ttf'] }
                }
            ]
        });
    } catch (error: unknown) {
        if (error instanceof DOMException && error.name === 'AbortError') {
            return null;
        }
        throw error;
    }
}

async function compileFullFont(): Promise<{
    bytes: Uint8Array;
    filename: string;
    timeTakenMs: number;
}> {
    const fontManager = window.fontManager;
    const currentFont = getCurrentFont();

    await awaitStableWorkerState(
        {
            awaitWorkerDocumentSync: () =>
                fontCompilation.awaitWorkerDocumentSync(),
            hasWorkerCacheDocument: () =>
                fontCompilation.hasWorkerCacheDocument(),
            getWorkerCacheUpdatePromise: () =>
                fontManager.workerCacheUpdatePromise,
            getFontRevisionKey: () =>
                `${currentFont.path ?? ''}\u0000${currentFont.changeVersion}`
        },
        {
            unavailable:
                'Binary font export is unavailable until the compiler worker is ready.',
            notReady:
                'Binary font export requires the current font to finish synchronizing to the compiler worker.',
            unstable:
                'Binary font export could not stabilize the current font revision. Retry after editing settles.'
        }
    );

    const workerSeedState = fontManager.buildWorkerSeedYjsState?.();
    if (!workerSeedState?.length) {
        throw new Error(
            'Binary font export could not snapshot the committed font state.'
        );
    }

    await fullFontCompilation.bootstrapWorkerCacheFromFontState(
        workerSeedState
    );

    const filename = getSuggestedFilename(currentFont.path);
    const compiled = await fullFontCompilation.compileCached('user', filename);
    return {
        bytes: compiled.result,
        filename: compiled.filename || filename,
        timeTakenMs: compiled.time_taken
    };
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function getDirtyIndicator(): HTMLElement | null {
    return document.getElementById('file-dirty-indicator');
}

function beginExportFeedback(): (() => void) | null {
    const dirtyIndicator = getDirtyIndicator();
    if (!dirtyIndicator) {
        return null;
    }

    const wasVisible = dirtyIndicator.classList.contains('visible');
    dirtyIndicator.classList.add('visible', 'exporting');

    return () => {
        dirtyIndicator.classList.remove('exporting');
        if (!wasVisible) {
            dirtyIndicator.classList.remove('visible');
        }
    };
}

async function runBinaryFontExport(
    alwaysChooseDestination: boolean
): Promise<void> {
    if (exportInProgress) {
        return;
    }

    exportInProgress = true;
    exportFeedbackReset?.();
    exportFeedbackReset = beginExportFeedback();
    try {
        const currentFont = getCurrentFont();
        const previousDestination = getExportDestinationForFont(currentFont);
        const handle =
            !alwaysChooseDestination && previousDestination
                ? previousDestination
                : await chooseDestination(
                      getSuggestedFilename(currentFont.path)
                  );
        if (!handle) {
            return;
        }

        const compiled = await compileFullFont();
        const writable = await handle.createWritable();
        await writable.write(new Uint8Array(compiled.bytes).buffer);
        await writable.close();

        destination = { font: currentFont, handle };

        const metadata: ExportedBinaryFontMetadata = {
            byteLength: compiled.bytes.byteLength,
            changeVersion: currentFont.changeVersion,
            filename: handle.name || compiled.filename,
            format: 'ttf',
            mimeType: 'font/ttf',
            timeTakenMs: compiled.timeTakenMs
        };
        const messageBytes = compiled.bytes.slice();
        window.postMessage(
            {
                type: 'counterpunch:binary-font-exported',
                version: 1,
                bytes: messageBytes.buffer,
                metadata
            },
            window.location.origin,
            [messageBytes.buffer]
        );
        console.log('Exported binary font:', metadata.filename);
    } catch (error: unknown) {
        if (destination?.font === window.fontManager?.currentFont) {
            destination = null;
        }
        const message = getErrorMessage(error);
        console.error('Binary font export failed:', message);
        window.alert(`Unable to export binary font: ${message}`);
    } finally {
        exportFeedbackReset?.();
        exportFeedbackReset = null;
        exportInProgress = false;
    }
}

export function exportBinaryFont(): Promise<void> {
    return runBinaryFontExport(false);
}

export function exportBinaryFontAs(): Promise<void> {
    return runBinaryFontExport(true);
}

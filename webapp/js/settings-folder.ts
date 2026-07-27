/**
 * Settings Folder — app-owned local directory for Plugins, Filters, and Scripts.
 *
 * Independent from the Disk plugin's Fonts folder. Persisted under its own
 * IndexedDB key and configured only from Preferences (and Plugin Manager).
 */

import {
    NativeAdapter,
    SETTINGS_FOLDER_HANDLE_KEY
} from './file-system-adapter';
import {
    ensureSettingsFolderSubdirectories,
    SETTINGS_FOLDER_PATHS
} from './settings-folder-paths';
import { Logger } from './logger';

const console = new Logger('SettingsFolder');

/** Source id used in script-editor URIs for Settings Folder backed files. */
export const SETTINGS_FOLDER_SOURCE_ID = 'settings';

export type SettingsFolderAccessChangedDetail = {
    hasSettingsFolderAccess: boolean;
    source: 'attach' | 'detach' | 'init';
};

class SettingsFolderService {
    private readonly adapter: NativeAdapter;
    private initializePromise: Promise<boolean> | null = null;

    constructor() {
        this.adapter = new NativeAdapter(SETTINGS_FOLDER_HANDLE_KEY);
    }

    getAdapter(): NativeAdapter {
        return this.adapter;
    }

    getFolderName(): string | null {
        if (!this.adapter.hasDirectory()) {
            return null;
        }
        return this.adapter.getDirectoryName() || null;
    }

    hasFolder(): boolean {
        return this.adapter.hasDirectory();
    }

    async isReady(): Promise<boolean> {
        await this.initialize();
        return this.adapter.hasDirectory();
    }

    async initialize(): Promise<boolean> {
        if (this.adapter.hasDirectory()) {
            return true;
        }
        if (!this.initializePromise) {
            this.initializePromise = this.adapter.initialize().finally(() => {
                this.initializePromise = null;
            });
        }
        return this.initializePromise;
    }

    /**
     * Prompt the user to choose a Settings Folder, create managed subfolders,
     * and notify dependents.
     */
    async selectFolder(options?: {
        startIn?: FileSystemHandle;
    }): Promise<boolean> {
        const selected = await this.adapter.selectDirectory(options);
        if (!selected) {
            return false;
        }

        await ensureSettingsFolderSubdirectories(this.adapter);
        this.dispatchAccessChanged({
            hasSettingsFolderAccess: true,
            source: 'attach'
        });
        console.log(
            'Settings Folder selected:',
            this.adapter.getDirectoryName()
        );
        return true;
    }

    async clearFolder(): Promise<void> {
        await this.adapter.clearDirectory();
        this.dispatchAccessChanged({
            hasSettingsFolderAccess: false,
            source: 'detach'
        });
        console.log('Settings Folder cleared');
    }

    async ensureSubdirectories(): Promise<void> {
        if (!this.adapter.hasDirectory()) {
            throw new Error('Choose a Settings Folder first.');
        }
        await ensureSettingsFolderSubdirectories(this.adapter);
    }

    async showOpenFilePicker(options?: {
        types?: { description: string; accept: Record<string, string[]> }[];
        startIn?: string;
    }): Promise<string | null> {
        if (!this.adapter.hasDirectory()) {
            return null;
        }

        try {
            const pickerOptions: Record<string, unknown> = {
                multiple: false
            };

            if (options?.types) {
                pickerOptions.types = options.types;
            }

            const startPath = options?.startIn || '/';
            try {
                const startHandle =
                    await this.adapter.getHandleAtPath(startPath);
                if (startHandle) {
                    pickerOptions.startIn = startHandle;
                }
            } catch {
                // Preferred start folder may not exist; fall back to root.
            }

            const [fileHandle] = await (
                window as unknown as {
                    showOpenFilePicker: (
                        options?: Record<string, unknown>
                    ) => Promise<FileSystemFileHandle[]>;
                }
            ).showOpenFilePicker(pickerOptions);

            return this.getRelativePath(fileHandle);
        } catch (error: unknown) {
            if (error instanceof DOMException && error.name === 'AbortError') {
                console.log('Open file picker cancelled');
                return null;
            }
            console.error('Error opening Settings Folder file picker:', error);
            throw error;
        }
    }

    async showSaveFilePicker(options?: {
        suggestedName?: string;
        types?: { description: string; accept: Record<string, string[]> }[];
        startIn?: string;
    }): Promise<string | null> {
        if (!this.adapter.hasDirectory()) {
            return null;
        }

        try {
            const pickerOptions: Record<string, unknown> = {};

            if (options?.suggestedName) {
                pickerOptions.suggestedName = options.suggestedName;
            }

            if (options?.types) {
                pickerOptions.types = options.types;
            }

            const startPath = options?.startIn || '/';
            try {
                const startHandle =
                    await this.adapter.getHandleAtPath(startPath);
                if (startHandle) {
                    pickerOptions.startIn = startHandle;
                }
            } catch {
                // Preferred start folder may not exist; fall back to root.
            }

            const fileHandle = await (
                window as unknown as {
                    showSaveFilePicker: (
                        options?: Record<string, unknown>
                    ) => Promise<FileSystemFileHandle>;
                }
            ).showSaveFilePicker(pickerOptions);

            return this.getRelativePath(fileHandle);
        } catch (error: unknown) {
            if (error instanceof DOMException && error.name === 'AbortError') {
                console.log('Save file picker cancelled');
                return null;
            }
            console.error('Error saving Settings Folder file picker:', error);
            throw error;
        }
    }

    private async getRelativePath(
        fileHandle: FileSystemFileHandle
    ): Promise<string | null> {
        try {
            const rootHandle = this.adapter.getDirectoryHandle();
            if (!rootHandle) {
                return null;
            }

            const pathParts = await (
                rootHandle as FileSystemDirectoryHandle & {
                    resolve: (
                        handle: FileSystemHandle
                    ) => Promise<string[] | null>;
                }
            ).resolve(fileHandle);
            if (pathParts === null) {
                console.warn(
                    'Selected file is outside the Settings Folder root'
                );
                return null;
            }

            return '/' + pathParts.join('/');
        } catch (error) {
            console.error('Error resolving Settings Folder path:', error);
            return null;
        }
    }

    private dispatchAccessChanged(
        detail: SettingsFolderAccessChangedDetail
    ): void {
        window.dispatchEvent(
            new CustomEvent('settingsFolderAccessChanged', { detail })
        );
    }
}

export const settingsFolder = new SettingsFolderService();

export { SETTINGS_FOLDER_PATHS };

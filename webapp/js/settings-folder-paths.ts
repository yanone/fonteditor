/**
 * Application-owned directories inside the Settings Folder.
 * The Settings Folder location is user-owned; these names are fixed app paths.
 */
export const SETTINGS_FOLDER_PATHS = {
    filters: '/Filters',
    plugins: '/Plugins',
    scripts: '/Scripts'
} as const;

type FolderCreatingAdapter = {
    createFolder: (path: string) => Promise<void>;
};

/**
 * Create Filters, Scripts, and Plugins under the Settings Folder when missing.
 * Safe to call repeatedly (`createFolder` is idempotent).
 */
export async function ensureSettingsFolderSubdirectories(
    adapter: FolderCreatingAdapter
): Promise<void> {
    for (const path of Object.values(SETTINGS_FOLDER_PATHS)) {
        await adapter.createFolder(path);
    }
}

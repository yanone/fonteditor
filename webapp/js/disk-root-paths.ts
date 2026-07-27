/**
 * Application-owned directories directly inside the Disk folder selected by
 * the user. The selected folder name and location remain entirely user-owned.
 */
export const DISK_ROOT_PATHS = {
    filters: '/Filters',
    plugins: '/Plugins',
    scripts: '/Scripts'
} as const;

type FolderCreatingAdapter = {
    createFolder: (path: string) => Promise<void>;
};

/**
 * Create Filters, Scripts, and Plugins under the selected Settings Folder
 * when they are missing. Safe to call repeatedly (`createFolder` is idempotent).
 */
export async function ensureManagedDiskRootFolders(
    adapter: FolderCreatingAdapter
): Promise<void> {
    for (const path of Object.values(DISK_ROOT_PATHS)) {
        await adapter.createFolder(path);
    }
}

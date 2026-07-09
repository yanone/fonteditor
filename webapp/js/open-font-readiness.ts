export function shouldHandleOpenPathBeforeEditorReady(
    pluginId: string,
    path: string
): boolean {
    return pluginId === 'cloud' && path.startsWith('cloud://');
}

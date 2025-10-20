// File Browser for in-browser memfs
// Shows the Pyodide file system in view 3

let fileSystemCache = {};

function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function getFileIcon(filename, isDir) {
    if (isDir) return '📁';

    const ext = filename.split('.').pop().toLowerCase();
    switch (ext) {
        case 'py': return '🐍';
        case 'txt': return '📄';
        case 'json': return '🔧';
        case 'md': return '📝';
        case 'html': return '🌐';
        case 'css': return '🎨';
        case 'js': return '⚡';
        case 'png': case 'jpg': case 'jpeg': case 'gif': return '🖼️';
        case 'pdf': return '📕';
        case 'zip': return '🗜️';
        default: return '📄';
    }
}

function getFileClass(filename, isDir) {
    if (isDir) return 'directory';

    const ext = filename.split('.').pop().toLowerCase();
    if (ext === 'py') return 'python-file';
    return 'file';
}

async function scanDirectory(path = '/') {
    if (!window.pyodide) {
        console.error("Pyodide not available");
        return {};
    }

    try {
        const result = await window.pyodide.runPython(`
import os
import json

def scan_directory(path='/'):
    items = {}
    try:
        if not os.path.exists(path):
            return items
            
        for item in sorted(os.listdir(path)):
            item_path = os.path.join(path, item)
            try:
                stat = os.stat(item_path)
                is_dir = os.path.isdir(item_path)
                items[item] = {
                    'path': item_path,
                    'is_dir': is_dir,
                    'size': stat.st_size if not is_dir else 0,
                    'mtime': stat.st_mtime
                }
            except (OSError, IOError) as e:
                # Skip items we can't access
                continue
    except (OSError, IOError) as e:
        # Skip directories we can't access
        pass
    
    return items

json.dumps(scan_directory('${path}'))
        `);

        return JSON.parse(result);
    } catch (error) {
        console.error("Error scanning directory:", error);
        return {};
    }
}

async function buildFileTree(rootPath = '/') {
    const items = await scanDirectory(rootPath);
    let html = '';

    if (rootPath !== '/') {
        const parentPath = rootPath.substring(0, rootPath.lastIndexOf('/')) || '/';
        html += `<div class="file-item directory" onclick="navigateToPath('${parentPath}')">
            📁 .. (parent directory)
        </div>`;
    }

    // Sort: directories first, then files
    const sortedItems = Object.entries(items).sort(([a, aData], [b, bData]) => {
        if (aData.is_dir && !bData.is_dir) return -1;
        if (!aData.is_dir && bData.is_dir) return 1;
        return a.localeCompare(b);
    });

    for (const [name, data] of sortedItems) {
        const icon = getFileIcon(name, data.is_dir);
        const fileClass = getFileClass(name, data.is_dir);
        const sizeText = data.is_dir ? '' : `<span class="file-size">${formatFileSize(data.size)}</span>`;

        const clickHandler = data.is_dir ?
            `navigateToPath('${data.path}')` :
            `selectFile('${data.path}')`;

        html += `<div class="file-item ${fileClass}" onclick="${clickHandler}">
            ${icon} ${name}${sizeText}
        </div>`;
    }

    return html;
}

async function navigateToPath(path) {
    try {
        const fileTree = document.getElementById('file-tree');
        fileTree.innerHTML = '<div style="color: #888;">Loading...</div>';

        const html = await buildFileTree(path);
        fileTree.innerHTML = `
            <div class="file-path">Current path: ${path}</div>
            ${html}
        `;

        // Cache the current path
        fileSystemCache.currentPath = path;
    } catch (error) {
        console.error("Error navigating to path:", error);
        document.getElementById('file-tree').innerHTML = `
            <div style="color: #ff3300;">Error loading directory: ${error.message}</div>
        `;
    }
}

function selectFile(filePath) {
    console.log("Selected file:", filePath);
    // TODO: Add file selection handling (e.g., show content, download, etc.)
    if (window.term) {
        window.term.echo(`Selected file: ${filePath}`);
    }
}

async function refreshFileSystem() {
    const currentPath = fileSystemCache.currentPath || '/';
    console.log("Refreshing file system...");

    // Clear cache
    fileSystemCache = { currentPath };

    // Reload current directory
    await navigateToPath(currentPath);

    if (window.term) {
        window.term.echo("File system refreshed");
    }
}

// Initialize file browser when Pyodide is ready
async function initFileBrowser() {
    try {
        if (!window.pyodide) {
            setTimeout(initFileBrowser, 500);
            return;
        }

        console.log("Initializing file browser...");
        await navigateToPath('/');
        console.log("File browser initialized");
    } catch (error) {
        console.error("Error initializing file browser:", error);
    }
}

// Auto-initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    setTimeout(initFileBrowser, 1500); // Wait a bit longer for Pyodide to be ready
});

// Export functions for global access
window.refreshFileSystem = refreshFileSystem;
window.navigateToPath = navigateToPath;
window.selectFile = selectFile;
window.initFileBrowser = initFileBrowser;
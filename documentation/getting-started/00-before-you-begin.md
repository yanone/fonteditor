# Before You Begin

Counterpunch is a font editor that runs entirely in your web browser without requiring any installation, downloads, or local server setup. This page explains how to get the best experience from the application, including browser recommendations and optional offline capabilities.

## How It Works

The application runs completely in your browser. When you visit https://editor.counterpunch.space, the editor loads into your browser's memory and executes there. Your font data, edits, and scripts all remain on your computer—nothing is uploaded to remote servers for processing. This architecture provides several advantages:

- **No installation required**: Open the URL and start working immediately
- **Cross-platform**: Works on macOS, Windows, and Linux without platform-specific builds
- **Instant updates**: Updating to the latest version takes just one click
- **Privacy by design**: Your font files never leave your machine

## Recommended Browser: Chrome

While Counterpunch works in several modern browsers, **Chrome (or Chromium) provides the best experience** for one critical reason: **hot-reloading of external files**.

When you grant Counterpunch access to a local folder on disk, Chrome can automatically detect when files in that folder change. If you edit a source file externally—in another editor, through a script, or via version control—Chrome will immediately refresh Counterpunch's view of that file without requiring manual reloading. This creates a seamless workflow where external changes appear instantly in the editor.

Other browsers may require you to manually refresh or re-grant folder access to see external changes, which interrupts your workflow and slows iteration.

### Browser Requirements

For full functionality, your browser needs to support:

- **File System Access API** (for direct local folder access)
- **SharedArrayBuffer** (for WebAssembly performance and Python runtime)
- **Service Workers** (for PWA capabilities and offline use)

Chrome and Chromium-based browsers have the most complete and reliable implementation of these standards.

If you don’t need hot-reloading of files because you’re only ever working directly in the editor, **Edge** and **Safari** are your second-best options. Other browsers are not recommended.

## Install as a Progressive Web App (PWA)

A Progressive Web App (PWA) is simply a website that gets downloaded to your computer and treated as a regular app.

Counterpunch can be installed as a Progressive Web App, which provides several benefits:

- **Offline access**: Work without an internet connection after initial installation
- **Desktop integration**: Launch from your applications menu or dock like a native app
- **Dedicated window**: Run Counterpunch in its own window without browser tabs and address bar
- **Faster startup**: The application shell loads from cache rather than downloading
- **Direct file opening**: Open supported font sources directly with the installed app (for example from Finder/Explorer or via app-icon file open)

When you open a font directly via the installed app and Counterpunch does not yet have folder access, the font opens immediately in detached mode. To enable full folder browsing and external hot-reload, attach the containing folder in the Disk context.

For folder-based sources such as `.glyphspackage`, `.ufo`, and `.designspace` projects, open the containing folder first and then open the source from there.

### How to Install

The installation process is simple and takes just a moment:

1. Open Counterpunch in Chrome (or a Chromium-based browser)
2. Look for the install icon in your browser's address bar (usually computer icon)
3. Click the install button and confirm
4. Counterpunch will now appear in your applications menu

Alternatively, you can usually find an "Install Counterpunch" option in your browser's menu (⋮ → More tools or similar).

### Working Offline

Once installed as a PWA, Counterpunch caches the application code locally. You can:

- Open and edit fonts stored on your computer without internet access
- Run Python scripts and use all editing features offline
- Compile and preview fonts locally

Note that features requiring external services—such as the AI Assistant—will only function when you have an internet connection and are signed in.

## First Launch

On your first visit or after installation, Counterpunch may request permissions for:

- **Local storage**: To cache application data and remember your preferences
- **Folder access** (optional): If you want to work directly with files on disk rather than browser memory

You control these permissions and can adjust them at any time through your browser's settings.

## Updating The App

Simply reloading the website won’t reload the latest application version, because of intentional caching.

When a new app update is available, an Update symbol will appear in the app’s title bar and only once you click that will the app update to the latest version.

This behaviour is identical whether you’re using it online of offline as a PWA.

## Suggested Screenshots

### Screenshot 1 — Counterpunch in browser

- Filename: `getting-started-00-01-browser-view.png`
- Capture: Counterpunch running in Chrome browser with URL visible.
- Suggested annotations:
    1. Browser address bar showing Counterpunch URL
    2. Install PWA icon
    3. Active editor workspace
- Alt text: Counterpunch font editor running in Chrome browser.

### Screenshot 2 — PWA installation prompt

- Filename: `getting-started-00-02-pwa-install.png`
- Capture: Browser installation dialog or install icon highlighted.
- Suggested annotations:
    1. Install button or icon
    2. Installation confirmation dialog
- Alt text: Progressive Web App installation prompt for Counterpunch.

### Screenshot 3 — Installed PWA on desktop

- Filename: `getting-started-00-03-pwa-desktop.png`
- Capture: Counterpunch running as installed PWA in standalone window.
- Suggested annotations:
    1. Application window without browser chrome
    2. Desktop/dock icon (if visible)
    3. Dedicated window controls
- Alt text: Counterpunch running as an installed Progressive Web App.

### Screenshot 4 — Chrome hot-reload in action

- Filename: `getting-started-00-04-hot-reload.png`
- Capture: Split view showing external file change and automatic update in Counterpunch.
- Suggested annotations:
    1. External file being edited
    2. Counterpunch automatically reflecting changes
    3. File changed notification (if visible)
- Alt text: Chrome hot-reloading external file changes in Counterpunch workspace.

## Next Step

Continue with [What is Counterpunch?](01-what-is-counterpunch.md) to understand the editor's capabilities and design philosophy.

## Related Pages

- [Your First Session](02-first-session.md)
- [Files View Basics](../files/01-files-view-basics.md)
- [Local Disk Access](../files/02-local-disk-access.md)

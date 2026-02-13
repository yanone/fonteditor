# Local Disk Access

Local disk access lets Counterpunch work directly with your project folders instead of isolated browser memory. This is powerful for real production workflows, but it depends on explicit browser permissions and can occasionally require re-authorization. Understanding that permission lifecycle helps you recover quickly when access is interrupted.

## Summary

Counterpunch can read and write files directly in a local folder through the browser’s File System Access model. When configured correctly, this enables a smooth, desktop-like save workflow while keeping the security guarantees of browser permission controls.

## How It Works

Enabling local disk access is straightforward. In the Files view, select **Disk** as your storage context, then click **Open Folder** and choose your project folder. After granting the necessary browser permissions, your folder will behave like a normal project tree, with saves writing directly to disk.

## Common Permission States

The browser manages permissions through several states. When access is granted, your folder functions seamlessly within Counterpunch. If permissions expire or are revoked, the interface will indicate a disabled state and prompt you to re-enable access. Some browsers may not support this feature, in which case the disk access controls will be unavailable.

## Recovery Steps

If you need to restore access to a folder, the process is simple. Click the **Re-enable access** button when it appears, select the same folder again, and confirm write permission in the browser prompt that follows.

## Suggested Screenshots

### Screenshot 1 — Open Folder flow

- Filename: `files-02-01-open-folder-flow.png`
- Capture: Disk context with Open Folder action visible.
- Suggested annotations:
    1. Disk context selected
    2. Open Folder button
    3. Project folder path area
- Alt text: Files view in Disk mode showing how to open a local folder.

### Screenshot 2 — Re-enable access state

- Filename: `files-02-02-reenable-access.png`
- Capture: UI state where local folder permission needs reactivation.
- Suggested annotations:
    1. Warning/status message
    2. Re-enable access button
- Alt text: Permission warning in Files view with re-enable access action.

### Screenshot 3 — Unsupported browser message

- Filename: `files-02-03-unsupported-browser.png`
- Capture: unsupported browser or missing File System Access API notice.
- Suggested annotations:
    1. Browser support warning
    2. Suggested browser action
- Alt text: Files panel showing browser incompatibility notice for disk access.

## Related Pages

- [Files View Basics](01-files-view-basics.md)
- [Troubleshooting](../troubleshooting/common-problems.md)

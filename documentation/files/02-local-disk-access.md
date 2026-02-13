# Local Disk Access

Local disk access lets Counterpunch work directly with your project folders instead of isolated browser memory. This is powerful for real production workflows, but it depends on explicit browser permissions and can occasionally require re-authorization. Understanding that permission lifecycle helps you recover quickly when access is interrupted.

## Summary

Counterpunch can read and write files directly in a local folder through the browser’s File System Access model. When configured correctly, this enables a smooth, desktop-like save workflow while keeping the security guarantees of browser permission controls.

## How It Works

1. In Files view, choose **Disk**.
2. Click **Open Folder** and select your project folder.
3. Grant browser permission.
4. Work normally; save writes to disk.

## Common Permission States

- Access granted: folder behaves like a normal project tree.
- Access expired/revoked: you may see a disabled state and need to re-enable.
- Unsupported browser: disk access controls may be unavailable.

## Recovery Steps

1. Click **Re-enable access** when shown.
2. Re-select the same folder.
3. Confirm write permission in browser prompt.

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

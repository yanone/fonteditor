# Local disk access

Disk mode lets Counterpunch read and write a real project folder through the browser File System Access API. That is the production workflow: saves go to disk, and Chrome can notice external file changes in the granted folder and refresh the editor (other browsers can’t detect and reload external from disk automatically).

In the **Open** dialog choose the **Disk** context, pick your main project folder, and allow read and write access. After that, the folder behaves like a normal project tree. This folder is not the Settings Folder; see [Project and settings folders](../getting-started/04-project-and-settings-folders.md).

If permission expires or is revoked, the panel shows a warning. Click **Re-enable access**, select the same folder, and confirm write permission again.

If Disk is unavailable, the browser likely lacks File System Access. Use Chrome. Recovery notes are in [Common problems](../troubleshooting/common-problems.md).

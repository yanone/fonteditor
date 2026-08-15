# Before you begin

Counterpunch is a font studio that runs in the browser. There is no install, download, or local server. Open [editor.counterpunch.space](https://editor.counterpunch.space) (or [preview.editor.counterpunch.space](https://preview.editor.counterpunch.space) for preview versions) and the studio loads in the browser. Font data, edits, and scripts stay on your computer. Nothing is uploaded for editing or compilation.

That architecture means you can start immediately on macOS, Windows, or Linux, pick up updates without a separate installer, and keep source files private by default.

## Recommended browser: Chrome

**Chrome** (or **Chromium**) is the recommended browser. It has the most complete support for the File System Access API which we need to read and write file to your disk.

Chrome can watch a granted local folder and refresh Counterpunch when files change on disk — for example after an edit in another app, a script, or version control. Other browsers may require a manual refresh.

If you only ever work inside Counterpunch and do not need that hot-reload, **Edge** and **Safari** are the next-best options.

Use **Firefox** only if you don’t need file system access at all. However, plugins, glyph filters, and reusable Python scripts need to be stored on your disk, so Firefox is **not recommended**.

Counterpunch is currently **not optimized for mobile operating systems**. Use a desktop computer.


## Install as a Progressive Web App

A Progressive Web App is a website that can be installed and launched like a regular application in your operating system. Installing Counterpunch from Chrome’s address-bar install icon (or the browser menu’s Install command) gives you:

- a dedicated window without browser tabs and address bar
- a dock or applications-menu icon
- the ability to open supported font files from the desktop

Once installed, you can open and edit fonts on disk, run Python, and compile previews without a network. The AI assistant still needs a connection and a signed-in account.

Even though now locally installed, the editor’s Python environment will not be able to access your computer’s normal Python environment. It’s still separate from that in a browser sandbox.

## First launch and updates

On first visit the browser may ask about folder access, and after a browser restart you may have to repeat giving those permissions once. This is a result of the editor not being a native OS app. The two folders you pick are in [Project and settings folders](04-project-and-settings-folders.md).

Reloading the page does not load a new version, because the app is cached on purpose. When an update is ready, an Update control appears in the title bar (File menu). Click it to switch. That behaviour is the same online and in the installed app.

Continue with [What is Counterpunch?](01-what-is-counterpunch.md).

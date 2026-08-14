# Editing in multiple windows

Counterpunch can open the same font in more than one browser window. That is useful when one window is for drawing, another for feature code, and another for overview or inspection. These windows are not independent copies of the font. They participate in one shared editing session.

## Main and linked windows

The first window that opens the font is **Main**. **Window → Open In New Window** opens the same font in another browser window and marks it **Linked 1**, **Linked 2**, and so on. You may see those labels in the window title and on history items.

Main and linked windows share the live session:

- edits in one window appear in the others
- history is synchronized
- undo and redo operate on the shared change history
- History shows which window produced each change

A change in a linked window is a real shared edit, not a preview. Think of linked windows as extra control surfaces for one document.

## Using them well

Give each window a job: drawing in one, Features in another, Overview or proofing in a third. That cuts view-switching without splitting the file.

Linked windows depend on the Main window’s session. Keep Main open while you work in linked windows. Closing the main window will also close all linked windows.

Undo scopes are explained in [Undo and history](../reference/undo-and-history-scopes.md).

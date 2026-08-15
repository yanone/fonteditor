# Konsole

Konsole is a Python prompt on the current font. It is the fastest place for a one-line inspection, a tiny prototype, or a sanity check before you commit the same idea to a script.

Use it to print one property, try a small transform, or verify an assumption about the object model. Long or reusable work belongs in the Script editor, including multi-step production logic that you will run again.

`Cmd/Ctrl+K` clears Konsole output. Font undo from this view uses the automation undo surface, same as Scripts.

Move a command that worked into [Script editor](02-script-editor-workflow.md) when you want to keep it. Session-only packages use `await micropip.install(...)`; lasting plugin wheels are in [Installing plugins and packages](07-installing-plugins-and-packages.md). If a command fails, [Common problems](../troubleshooting/common-problems.md) has a short recovery path.

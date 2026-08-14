# Script editor

The Scripts view is where one-off experiments become reusable procedures. Encode intent once and run it with consistency, instead of repeating the same manual action across many glyphs.

Write a small read-only report first. Run it with `Cmd/Ctrl+Alt+R` and read the output. Check the Editor or Overview if the script should have changed outlines. Save the font before a script that modifies data. Keep one purpose per file, and keep versions if you are iterating on a destructive approach.

`print()` counts, skips, and errors so you can see what happened. File headers (title, description, `Keywords:`) appear in the Run Python Script dialog.

While Scripts, Konsole, or Assistant is focused, `Cmd/Ctrl+Z` undoes those font edits on the automation undo surface.

With **Assistant editing** on (pen button in the Assistant title bar), the assistant can create or replace text in the unsaved Script Editor buffer. It does not run or save that file. You review, then Save or Run yourself.

Authoring rules are in [Writing general scripts](04-writing-general-scripts.md). Quick experiments belong in [Konsole](03-konsole-quick-tasks.md). Review habits for generated code are in [Safety and review](../ai/02-ai-safety-and-review.md).

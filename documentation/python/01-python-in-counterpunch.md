# Python in Counterpunch

Counterpunch includes an embedded Python runtime so you can automate font edits without switching tools or exporting intermediate data. For many designers, this bridges the gap between visual editing and repeatable technical operations. The key advantage is immediacy: you can test an idea on the current font context, inspect the result, and iterate quickly.

## Summary

Counterpunch includes a browser-based Python environment that can inspect and modify the active font model directly. This enables a practical hybrid workflow where exploratory scripting and visual verification happen in the same editing session.

## What Makes It Useful

- Repeat complex edits consistently.
- Automate cleanup and transformation tasks.
- Explore font data structure directly.

## Mental Model for Beginners

- Python runs inside Counterpunch.
- Scripts operate on the current font context.
- You can test quickly in Konsole, then formalize in Scripts view.

## Suggested Screenshots

### Screenshot 1 — Scripts and Konsole views side by side (or separate)

- Filename: `python-01-01-scripts-vs-konsole.png`
- Capture: both Python entry points visible.
- Suggested annotations:
    1. Scripts view (for reusable code)
    2. Konsole view (for quick commands)
    3. Current font context indicator (if visible)
- Alt text: Counterpunch Python areas for scripting and interactive commands.

### Screenshot 2 — Simple read-only Python query

- Filename: `python-01-02-readonly-query.png`
- Capture: small command printing glyph or font information.
- Suggested annotations:
    1. Command input
    2. Output area
- Alt text: Python command in Counterpunch returning simple font data.

## Related Pages

- [Script Editor Workflow](02-script-editor-workflow.md)
- [Konsole Quick Tasks](03-konsole-quick-tasks.md)

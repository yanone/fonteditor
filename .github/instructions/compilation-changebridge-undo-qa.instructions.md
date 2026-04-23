---
name: "Compilation Change Bridge Undo QA Policy"
description: "Use when reviewing or editing Counterpunch compilation hot paths, editing compile fast paths, change-bridge serialization or deserialization, Yjs synchronization, cross-window state transfer, or undo and redo behavior."
applyTo:
    - "webapp/js/change-bridge*.ts"
    - "webapp/js/window-sync.ts"
    - "webapp/js/history-view.ts"
    - "webapp/js/undo-redo-context.ts"
    - "webapp/js/change-log.ts"
    - "webapp/js/fontc-worker.ts"
    - "webapp/js/font-compilation.ts"
    - "webapp/js/auto-compile-manager.ts"
    - "webapp/js/full-font-compile-manager.ts"
    - "webapp/js/font-manager.ts"
    - "webapp/js/python-post-execution.ts"
    - "webapp/js/python-ui-sync.ts"
    - "webapp/js/babelfont-model.ts"
    - "babelfont-fontc-build/src/**/*.rs"
    - "developer-docs/COMPILATION_EDIT_POLICY.md"
---

# Compilation Change Bridge Undo QA Policy

- Treat edits in these files as QA-critical. They affect editing latency, fast-path eligibility, cross-window fidelity, or undo correctness.
- Before changing any function, class, or method in these files, run impact analysis on the target symbol and report the blast radius.
- Read the relevant policy and architecture documents before changing compile behavior or synchronization behavior, especially `APP.md` and `developer-docs/COMPILATION_EDIT_POLICY.md`.
- Use the `Compilation Change Bridge Undo QA` agent for review or execution when the task touches compilation hot paths, change-bridge serialization, Yjs transmission, receiving-window reconstruction, or undo and redo behavior.
- After modifying these files, immediately invoke the `Compilation Change Bridge Undo QA` agent as a subagent to review the main agent's changes before proceeding to final validation, summaries, or `task_complete`.
- Do not wait for the stop hook reminder if you already know you touched these files. The expected workflow is: edit, run the dedicated QA subagent, address findings if any, then finish validation and respond.
- Do not treat tests alone as a substitute for that dedicated QA review.
- Preserve or improve the existing performance envelope. Do not accept a slower editing path without explicit user approval.
- Preserve exact serialization and deserialization fidelity. Receiving-window state must reconstruct identically to the sent state.
- Preserve undo and redo correctness for both local and mirrored changes, including list insertions, deletions, and intermediate compilation states.
- Add or tighten targeted automated tests for every changed risk boundary.
- Run the smallest sufficient validation set before finishing, and report what passed, failed, or could not be run.

# Undo and History Scopes

Undo in Counterpunch is designed to be powerful, but it is not purely “whatever I touched last on screen.” The system follows the ownership of the underlying data, and the History view filters what you see based on the current scope. That usually feels sensible, but in some situations it can feel unintuitive until you understand which scope currently owns the change.

## Summary

Use this page to understand why some edits appear under layer, glyph, feature, or font history, and why undo sometimes requires switching the History view to a broader scope before the action becomes available.

The History panel shows the full collaboration log, but dims items that the current Cmd+Z / Edit → Undo context cannot reach. Reachable items keep normal styling.

## The Core Idea

Counterpunch records edits with an **undo scope**. In practice, that means each change belongs to one of four contexts:

- **Layer**: edits tied to the currently edited layer.
- **Glyph**: edits that belong to the glyph as a whole rather than one specific layer.
- **Feature**: edits tied to a specific OpenType feature, class, or prefix.
- **Font**: global edits that affect the font-wide model.

The History panel filters its list according to the currently active scope. The undo and redo buttons follow that same context. If the History panel is showing only layer history, layer undo will work on that filtered stack. If the change actually lives in font scope, it will not appear there and it will not undo from there.

## How The History View Chooses Scope

The History view follows your active editing context:

- When you are editing feature code, it switches to **feature** scope.
- When you are editing a glyph layer, it usually switches to **layer** scope.
- When you have a glyph selected without a specific layer context, it can use **glyph** scope.
- When there is no more specific context, it falls back to **font** scope.

This is useful because the list usually stays focused on the thing you are working on. The tradeoff is that some valid undo steps are temporarily hidden if they belong to a broader or different scope.

## Why Some Results Feel Unintuitive

Counterpunch scopes history by data ownership, not only by visual location.

That distinction matters because the canvas can show a mixture of local and global information at the same time. A guide, metric, or feature result may be visible while you are working in a layer, even though the edit itself belongs somewhere else in the font model.

One concrete example is **master-level guidelines**. These guides are visible in the glyph editor together with layer content, but they are owned by the master, not by the current layer. If you move one of those guides, the resulting history item is a **font-scoped** edit. It does **not** appear under the layer scope, even though you moved it while looking at a layer.

That means the behavior can feel surprising:

1. You move a master-bounds or other master-level guide while editing a glyph layer.
2. You open History and stay in **layer** scope.
3. The move is not listed there.
4. Undo does not reach it from that scope.
5. You switch History to **font** scope.
6. The move appears there and can be undone there.

This is expected behavior in the current model, even if it is not always intuitive on first encounter.

## Python Runs Are Grouped Into One Undo Step

Python editing behaves differently from many manual editing workflows. When you run a Python script, Counterpunch summarizes the resulting changes under one history item, typically labeled **Python script**, instead of flooding the History panel with one separate item per low-level change.

That means a script that modifies many glyphs, layers, anchors, metrics, or other font data can be undone in one step. In other words, the whole run can be reverted **en bloc**.

This is unusually powerful for a font editor. In many font tools, scripted edits are either hard to review in history, mixed into many small undo steps, or not grouped in a way that matches the user’s mental model of “one script run, one action.” Counterpunch treats one script execution as one meaningful operation.

The exact undo scope of that grouped Python item still depends on what the script changed. A script that only changes one glyph may behave differently from a script that changes font-wide data. But the important user-facing behavior is the same: the run is summarized as one history item rather than as a long stream of tiny edits.

## Practical Rules Of Thumb

When undo does not affect the thing you expect, use these checks:

1. Look at the current History scope first.
2. Check whether the visible item might actually belong to a broader object.
3. Switch from **layer** to **glyph** or **font** scope if the edit is missing.
4. In the feature editor, stay in **feature** scope if you want feature-specific undo.

As a working habit, it helps to treat the History view as a filtered lens rather than a universal chronological log. The edit may still exist in history even when the current scope is hiding it.

## Reading History Items

Each history item carries metadata that helps explain what you are seeing:

- The **scope badge** shows whether the edit is layer, glyph, feature, or font scoped.
- The **window badge** shows whether the change came from the Main window or a linked window.
- The detailed metadata view shows the exact undo scope recorded for that item.
- **Dimmed rows** are outside the current Cmd+Z editing context and will be skipped.

If an action seems to be “missing,” inspect the scope badge on nearby items and try a broader scope.

## Recommended Recovery Pattern

If undo feels blocked or inconsistent, follow this order:

1. Save your work if you are unsure.
2. Open the History panel.
3. Move outward through scopes: **layer → glyph → font**.
4. If you are editing OpenType code, also check **feature** scope.
5. Undo only once you can see the history item you expect.

This avoids accidentally undoing a different local edit while searching for a broader one.

## Suggested Screenshots

### Screenshot 1 — History panel in layer scope

- Filename: `reference-undo-history-01-layer-scope.png`
- Capture: History panel showing a layer-scoped list while editing a glyph.
- Suggested annotations:
    1. Active scope breadcrumb
    2. Layer-scoped items
    3. Undo button
- Alt text: History panel filtered to layer scope while editing a glyph layer.

### Screenshot 2 — Same session in font scope

- Filename: `reference-undo-history-02-font-scope.png`
- Capture: same editing session after switching History to font scope.
- Suggested annotations:
    1. Font scope selected
    2. Previously missing guide move now visible
    3. Scope badge on item
- Alt text: History panel in font scope showing a global edit not visible in layer scope.

### Screenshot 3 — Feature scope history

- Filename: `reference-undo-history-03-feature-scope.png`
- Capture: feature editor with History panel filtered to one feature.
- Suggested annotations:
    1. Feature scope breadcrumb
    2. Feature-specific history item
    3. Undo scope badge
- Alt text: Feature-scoped history list for a selected OpenType feature.

## Related Pages

- [Glyph Editor Basics](../editor/01-glyph-editor-basics.md)
- [Feature Code Editor](../features/01-feature-code-editor.md)
- [Common Problems and Recovery](../troubleshooting/common-problems.md)

# Preambel

This is a human-written document. Agents may alter it on request, but it must undergo human review.

# Purpose

`APP.md` is the principal authority document over how the app functions, described in human language, and translated into code and tests by agents.

# Counterpunch Font Editor Software Architecture

## Keeping tests up-to-sate

All rules in this document must be backed up by unit tests in either jest or playwright under /webapp/tests/canonical/ and the unit tests must be kept up-to-date and mustn’t fail.

The tests are locking down the described functionality. They are written first and functionality implemented backwards from there, if possible. In any case, the tests control the code and carry the autority over the correct execution of the document.

The agent may use the app’s dev-time mcp server to inspect the live app, and it may even propose alterations to the mcp server to achieve goals better, but tighter and more realistic tests are preferrable.

The test files must be named (and renamed) according to their topic and tests regrouped as it makes sense.

## Further Rules

Every function must be accompanied by a human-readable description, which must also be kept up-to-date.

## Glyphs

### Layers

#### Sidebearing Keys

Layer sidebearings can be linked to other glyphs’ sidebearings by curated keys such as `=n`or arithmetics like `=a+10` or fixed values `=50` etc.

Since sidbearings are not supposed to change when a user edits anything on a layer with inherited linked sidebearings, the sidebearings will be kept up-to-date if the glyph’s left-most or right-most nodes or component bounding boxes ar responsible for left or right side layer bounding box changes.

During edits from mouse-dragging, the width of the active glyph in the harfbuzz buffer must be updated live and without any lag by adjusting all occurrences of its advance width in the harfbuzz buffer and immediately redrawing, while scheduling repeated editing font compilations as during outline edits so that the GPOS table can update.

Simultaneously, once a glyph’s sidebearing changes, all downstream glyphs who inherit the active glyph’s sidebearings must be updated as well. Only update if the value actually changed in the end. Don’t propagate no-ops.

Group any sidebearing changes of sidebearing inheritance in one history transaction and Yjs message.

Update canvas panning: When sidebearings of the active glyph change, be it by editing outlines or components, or via the dedicated sidebearing handles on canvas, or via the property panel text fields, or via undo, update the canvas rendering as follows: If the RSB changes, anchor the canvas to the left edge of the glyph. If the LSB changes, anchor the canvas to the right edge of the glyph.
Width adjustments and canvas anchoring must happen during one single animation frame so that no jiggle is visible on screen.

The canvas must even be panned and anchored to the active glyph if only the right sidebearing gets edited and the width changes, because the entire line may contain other glyphs before it or repetitions of the same glyph whose width gets be adjusted in the same transaction.

When a sidebearing changes, update the sidebearings of all inheriting downstream glyphs both in the object model as well as their advance widths in the harfbuzz buffer before repainting the canvas, and anchoring the canvas to the opposite side of the sidebearing that was edited during the repaint.

##### Test

Sidebearing updates must be proven with a playwright fuzzing test that enforces the above rules. It randomly sets sidebearing keys, observes adherence, then changes outlines, unsets them, manually edits sidebearings using the handles or property panel text fields, each time ensuring that the sidebearings, width, and downstream glyphs update as expected and the opposite glyph side stays anchored on the canvas during all operations. At the end of the fuzzing test, all actions are to be undone via the history and checked that each state is undone correctly by comparing to snapshots that have been taken before each edit.

Details to test:

- No sidebearing keys: Drag sidebearing handle out, and back. Also edit via keyboard.
- With sidebearing keys: Edit outlines and back and observe that the sidebearing stays the same and the width changes.
- Observe that the glyph side opposite of the sidebearing edit stays anchored on canvas for all of these edits and undos. Observe that downstream glyphs update as well in the same transactions.

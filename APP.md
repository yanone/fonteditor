# Preambel

This is a human-written document. Agents may alter it on request, but it must undergo human review.

# Purpose

`APP.md` is the principal authority document over how the app functions, described in human language, and translated into code and tests by agents.

# Counterpunch Font Editor Software Architecture

## Keeping tests up-to-sate

All rules in this document must be backed up by unit tests in either jest or playwright under `/webapp/tests/canonical/` and the unit tests must be kept up-to-date and mustn’t fail.

The tests are locking down the described functionality. They are written first and functionality implemented backwards from there, if possible. In any case, the tests control the code and carry the autority over the correct execution of the document.

The agent may use the app’s dev-time mcp server to inspect the live app, and it may even propose alterations to the mcp server to achieve goals better, but tighter and more realistic tests are preferrable.

The test files must be named (and renamed) according to their topic and tests regrouped as it makes sense.

## Further Rules

Every function must be accompanied by a human-readable description, which must also be kept up-to-date.

## Glyphs

### Layers

#### Sidebearing Keys

Layer sidebearings can be linked to other glyphs’ sidebearings by curated keys such as `=n`or arithmetics like `=a+10` or fixed values `=50` etc.

In detail:

- `=n` inherits that sidebearing glyph-wide from the same-side sidebearing of glyph `n`
- `=n+10` or `=n*1.5*` does the same, but adds arithmetics
- `=50` sets sidebearings glyph-wide to an exact value of `50`
- exceptions can be made that are local to just one layer of a glyph when the key starts with another `=`, so `==n`, `==n+10`, or `==50` etc, while the other layers of the same glyph may have a glyph-wide key or no key at all.

Since sidebearings are not supposed to change when a user edits anything on a layer with inherited linked sidebearings, the sidebearings will be kept up-to-date if the glyph's left-most or right-most nodes or component bounding boxes are responsible for left or right side layer bounding box changes. This applies equally to path node drags, component drags, and mixed layers containing both paths and components.

During edits from mouse-dragging, the width of the active glyph in the harfbuzz buffer must be updated live and without any lag by adjusting all occurrences of its advance width in the harfbuzz buffer and immediately redrawing, while scheduling repeated editing font compilations as during outline edits so that the GPOS table can update.

Simultaneously, once a glyph’s sidebearing changes, all downstream glyphs who inherit the active glyph’s sidebearings must be updated as well. Only update if the value actually changed in the end. Don’t propagate no-ops.

Group any sidebearing changes of sidebearing inheritance in one history transaction and Yjs message.

Update canvas panning: When sidebearings of the active glyph change via explicit sidebearing edits, such as the dedicated sidebearing handles on canvas, the property panel text fields, or undo of those edits, anchor the opposite edge of the glyph on screen: If the RSB changes, anchor the canvas to the left edge of the glyph. If the LSB changes, anchor the canvas to the right edge of the glyph.
When sidebearing changes are caused by keyed realignment during outline or component editing, anchor the canvas on the center of the active glyph layer's visual bounding box on screen, matching the same bbox-center anchoring behavior used during zooming and interpolation.
Width adjustments and canvas anchoring must happen during one single animation frame so that no jiggle is visible on screen.

The canvas must even be panned and anchored to the active glyph if only the right sidebearing gets edited and the width changes, because the entire line may contain other glyphs before it or repetitions of the same glyph whose width gets adjusted in the same transaction.

When a sidebearing changes, update the sidebearings of all inheriting downstream glyphs both in the object model as well as their advance widths in the harfbuzz buffer before repainting the canvas. For explicit sidebearing edits, anchor the canvas to the opposite side of the sidebearing that was edited during the repaint. For keyed realignment during outline or component edits, preserve the active glyph layer's bbox center on screen during the repaint.

When downstream glyphs that appear **before** the active glyph in the harfbuzz buffer also change width (via metrics-key cascading), the active glyph's screen position shifts because its world position is the cumulative sum of all preceding advances. The viewport anchoring must account for those preceding-advance shifts as part of the same single-frame repaint so the active glyph remains visually stationary at its intended anchor point.

##### Tests

**Test 1: Unkeyed Sidebearing Edits**

For glyphs with no sidebearing keys, test that sidebearing edits via the handle by mouse, or via the handle by keyboard, or via the property panel text fields, always anchors the opposite glyph edge visually on the canvas. LSB edits anchor the right layer edge visually on screen, and RSB edits anchor the left layer edge visually on screen. Test a matrix of all edit input types and both sides.

**Test 2: Keyed Sidebearing Edits**

For glyphs with any of the defined sidebearing keys, test that outline or component edits always keep the active glyph layer's visual bounding-box center fixed on screen during keyed realignment.

**Instructions for all sidebearing tests**

Ensure that undo operations of the same edits result in the same edge anchoring as during edits, by storing in the history item which side got edited and using that for undo-time visual anchoring of the opposite edge.
Ensure that ongoing mouse drags that take a break are not committing data to the history items such that an undo restores an already altered state. Undos must restore each state cleanly.

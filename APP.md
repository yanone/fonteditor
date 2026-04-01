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

#### Drawing Outlines

#### Editing Existing Outlines

A point triplet is defined as a middle on-curve point with off-curve points on both sides. All three nodes are enforced to be aligned if the on-curve point is set to smooth, otherwise the off-curve points of the triplet may be moved freely.

Holding the shift key before or after selecting and moving an off-curve point of a smooth point triplet will restrict the triplet's direction to horizontal/vertical direction, rotated around the on-curve point.

Holding the alt key before or after selecting and moving a smooth on-curve point will keep its two off-curve points fixed in place and restrict the on-curve point to sliding on the straight line between those two off-curve points. Lifting the alt key while still dragging returns to free movement and lets the off-curve points follow again. Pressing the alt key again while still dragging freezes the off-curve points at their current positions and again restricts the on-curve point to the line between them.

Holding the alt key before or after selecting and moving an off-curve point that’s not connected to a smooth point will keep the movement restricted to its original direction from the on-curve point. Lifting the alt key while still dragging allows free movement, but pressing the alt key again while still dragging return to the original direction, not the direction at the moment of re-pressing the alt key.

Double clicking an on-curve point of a triplet will toggle the smoothness state. Turning a non-smooth on-curve point of a triplet to smooth will align both off-curve points in a straight line around the on-curve point, with their direction being the average of the previous off-curve points’ directions. Turning a non-smooth on-curve point of a triplet when one of the two lines is in perfect horizontal or vertical direction will also align the other off-curve point’s direction to horizontal or vertical.

An on-curve point with only one curve on either side (the other side being a straight line) must always be set to not smooth. If a smooth triplet loses a curve on one side by off-curve point deletion, the on-curve point must be set to not smooth.

All operations must wrap around the start/end point of a closed path as if the point was nothing special at all.

#### Node Snapping

Both for dragging existing points as well as drawing new points (not for inserting new nodes into existing segments), points will snap horizontally and/or vertically to on-curve points of the active glyph, on-curve points of both neighbouring glyphs, as well as an extra phantom point on the dragged point’s original position, as well as to vertical metrics lines end the glyph edge. The snap distance is configurable in `settings.ts`.

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
When sidebearing changes are caused by keyed realignment during outline or component dragging, anchor the opposite edge of the active glyph layer on screen just like any other sidebearing edit: If the RSB changes, anchor the canvas to the left edge of the glyph. If the LSB changes, anchor the canvas to the right edge of the glyph.
Reserve bbox-center anchoring for structural outline operations whose keyed realignment is applied only after the structure change is complete, such as inserting or deleting points, converting a straight segment to a curve, and opening or closing paths.
Width adjustments and canvas anchoring must happen during one single animation frame so that no jiggle is visible on screen.

The canvas must even be panned and anchored to the active glyph if only the right sidebearing gets edited and the width changes, because the entire line may contain other glyphs before it or repetitions of the same glyph whose width gets adjusted in the same transaction.

When a sidebearing changes, update the sidebearings of all inheriting downstream glyphs both in the object model as well as their advance widths in the harfbuzz buffer before repainting the canvas. For explicit sidebearing edits and keyed realignment during outline or component dragging, anchor the canvas to the opposite side of the sidebearing that changed during the repaint. For structural outline operations that trigger keyed realignment only after the structure update is complete, preserve the active glyph layer's bbox center on screen during that repaint.

When downstream glyphs that appear **before** the active glyph in the harfbuzz buffer also change width (via metrics-key cascading), the active glyph's screen position shifts because its world position is the cumulative sum of all preceding advances. The viewport anchoring must account for those preceding-advance shifts as part of the same single-frame repaint so the active glyph remains visually stationary at its intended anchor point.

##### Tests

**Test 1: Unkeyed Sidebearing Edits**

For glyphs with no sidebearing keys, test that sidebearing edits via the handle by mouse, or via the handle by keyboard, or via the property panel text fields, always anchors the opposite glyph edge visually on the canvas. LSB edits anchor the right layer edge visually on screen, and RSB edits anchor the left layer edge visually on screen. Test a matrix of all edit input types and both sides.

**Test 2: Keyed Sidebearing Edits**

For glyphs with any of the defined sidebearing keys, test that outline or component drags anchor the opposite glyph edge visually on the canvas during keyed realignment. LSB changes anchor the right layer edge visually on screen, and RSB changes anchor the left layer edge visually on screen.
Test structural outline operations that trigger keyed realignment after the structure edit separately, and ensure those preserve the active glyph layer's visual bounding-box center on screen.

**Instructions for all sidebearing tests**

Ensure that undo operations of the same edits result in the same edge anchoring as during edits, by storing in the history item which side got edited and using that for undo-time visual anchoring of the opposite edge.
Ensure that ongoing mouse drags that take a break are not committing data to the history items such that an undo restores an already altered state. Undos must restore each state cleanly.

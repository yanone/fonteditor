# Sidebearing Arithmetics

Sidebearing formulas let you link spacing decisions instead of typing the same numbers into every related glyph. In Counterpunch, the goal is practical: define spacing once, then let derived glyphs follow that logic while still showing you the resolved numeric result.

## Summary

You can enter plain numbers when you want an explicit sidebearing, or enter formulas when the sidebearing should be derived from another glyph, mirrored from the opposite side, shifted by a fixed amount, or measured at a specific vertical height.

## Where To Edit

When no outline object is selected, the property panel at the bottom of the editor shows fields for left and right sidebearings. Each field accepts either a number or a formula. Next to the input, Counterpunch shows the currently resolved sidebearing value.

This makes it possible to keep a formula such as `=n+10` in the field while still seeing the actual spacing value that is applied to the layer.

## Plain Numbers

Typing a plain number means “use exactly this sidebearing.”

Examples:

- `40`
- `-15`

When you enter a number, Counterpunch clears any existing metrics key for that side and stores the sidebearing directly.

## Reference Formulas

Reference formulas start with `=` and derive the sidebearing from another source.

Examples:

- `=n`
- `=H+20`
- `=o-10`

These formulas read the referenced sidebearing, apply the arithmetic, and then update the current glyph accordingly. If the referenced glyph changes later, dependent glyphs are recomputed automatically.

## Local Overrides

If a formula starts with `==`, it is stored only on the current layer instead of on the glyph as a whole.

Examples:

- `==n`
- `==+20`

This is useful when most layers should follow the glyph-wide metrics key, but one layer needs a master-specific exception.

## Mirroring

You can mirror from the opposite sidebearing instead of reading the same side.

Examples:

- `=|n`
- `=|H-10`

This is useful for shapes whose spacing logic is based on the opposite edge of another glyph.

## Measuring At A Height

Formulas can also measure sidebearings at a specific vertical position using `@`.

Examples:

- `=c@200`
- `=o@300+15`

This does not simply copy the target glyph’s stored right or left sidebearing. Instead, Counterpunch measures the outline at that height, compares it with the current glyph’s own measurement at the same height, and applies the difference as a sidebearing change.

That distinction matters for glyphs whose counters or terminals open differently at different heights. A formula such as `=c@200` keeps the spacing relationship aligned at `y = 200`, even if the current glyph’s raw sidebearing number is different from `c`.

## Automatic Component Offsets

For fully auto-aligned component layers, you can use automatic offset formulas such as:

- `=+10`
- `=-15`

These start from the auto-aligned component spacing and add or subtract a fixed amount. In the property panel, a fully automatic layer without an explicit metrics key shows an empty field with an `auto` placeholder.

## Error Handling

If Counterpunch cannot resolve a formula, the field is marked as invalid instead of silently applying a wrong value.

Common reasons include:

- the referenced glyph does not exist
- the formula contains invalid arithmetic
- the measurement height does not intersect the outline
- the formula graph contains a cycle

Fix the formula, and the resolved sidebearing preview updates immediately.

## A Useful Workflow

For families with related spacing patterns, a good approach is:

1. Set the spacing on a small set of base glyphs directly.
2. Use formulas for dependent glyphs such as accented forms or stylistic variants.
3. Use `==` only where a specific layer needs to break away from the shared rule.
4. Use `@height` when the optical spacing relationship depends on the shape at a specific vertical slice instead of the glyph’s overall margin.

## Related Pages

- [Glyph Editor Basics](01-glyph-editor-basics.md)
- [Axes, Masters, and Interpolation](02-axes-masters-interpolation.md)
- [Undo and History Scopes](../reference/undo-and-history-scopes.md)

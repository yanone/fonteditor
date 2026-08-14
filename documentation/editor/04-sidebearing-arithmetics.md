# Sidebearing arithmetics

Sidebearing formulas let you link spacing instead of typing the same numbers into every related glyph. Define spacing once, then let derived glyphs follow that logic while still showing the resolved numeric result.

## Where to edit

With nothing selected on the canvas, the editor property panel shows left and right sidebearings. Each field takes a number or a metrics key. The resolved value sits next to the input, so you can keep `=n+10` in the field and still see the spacing that is applied.

An empty field clears the metrics key for that side. On a fully auto-aligned component layer with no key, the field stays empty and the placeholder is `=+0 or ==+0`.

## Notation

These are the forms the metrics-key parser accepts. Spaces are not part of the syntax. Glyph names are matched as the longest prefix that exists in the font, so `n.ss01` wins over `n`.

### Plain numbers

A signed or unsigned number, including a decimal, stores that sidebearing and **clears** any metrics key:

- `40`
- `-15`
- `+20`
- `40.5`

### Glyph-wide keys (`=`) versus layer-local keys (`==`)

A leading `=` stores a **glyph-wide** metrics key: every layer of that glyph uses it unless a layer overrides it.

A leading `==` stores the same kind of key **only on the current layer**. After the extra `=`, the rest of the string is parsed the same way. Use `==` when most layers should follow the glyph-wide key but one master needs an exception.

`==n`, `==+10`, `==-20`, and `==|H-10` are the layer-local counterparts of `=n`, `=+10`, `=-20`, and `=|H-10`.

### Constants (`=40`)

`=` followed by an **unsigned** number is a constant formula. The sidebearing stays that value when the outline later changes:

- `=40`
- `=40.5`

There is no signed constant form. `=-20` is not a constant; it is an automatic offset (below).

### Automatic offsets (`=+10`, `=-15`)

`=` or `==` followed immediately by a **signed** number is an automatic-offset key:

- `=+10`, `=-15`, `=+10.5`
- `==+10`, `==-15` (layer-local)

On a **fully auto-aligned component layer**, the value is auto-aligned spacing plus that delta. Those layers accept **only** this signed form (`=+…` / `=-…` / `==+…` / `==-…`). References, unsigned constants, and plain numbers are rejected there.

On a **normal layer**, the same syntax resolves to that signed amount and keeps it as a formula after later outline edits.

### References

A reference reads another glyph’s corresponding sidebearing (or a measured slice of it), then optionally mirrors, samples at a height, and applies one arithmetic suffix.

The leading `=` is optional for references, so Glyphs-style `n` is accepted as well as `=n`.

| Form | Meaning |
| --- | --- |
| `=n` or `n` | Same side of glyph `n` |
| `=H+20`, `=o-10` | Referenced sidebearing plus or minus a number |
| `=H*2`, `=n/2` | Multiply or divide the referenced sidebearing |
| `=|n`, `=|H-10` | Opposite side of the referenced glyph, then optional arithmetic |
| `=|` | Opposite side of **this** layer (nothing after the pipe) |
| `=c@200` | Measure this outline and `c` at y = 200, then apply the difference (not a copy of `c`’s stored sidebearing) |
| `=o@300+15`, `=c@-50` | Height sample, then optional `+` `-` `*` `/` number. Height may be signed. |
| `=|c@200+15` | Mirror, height, and arithmetic together |

The arithmetic suffix is exactly one operator and a number: `+`, `-`, `*`, or `/`, then a signed or unsigned value (decimals allowed). `/0` does not resolve.

### Combinations with `==`

Any reference form can be layer-local:

- `==n`
- `==|H-10`
- `==c@200`
- `==|c@200+15`

## Resolution and errors

Dependents recompute when a source glyph’s spacing changes. If a formula cannot resolve — unknown glyph name, bad suffix, a height that misses the outline, division by zero, or a cycle — the field is marked invalid until you fix it.

A useful pattern: set spacing on a few base glyphs, formula-link accented and alternate forms, use `==` only for a layer that must break the shared rule, and use `@height` when the optical relationship lives at a vertical slice rather than the overall margin.

Related: [Glyph editor](01-glyph-editor.md), [Axes and masters](03-axes-masters.md), [Undo and history](../reference/undo-and-history-scopes.md).

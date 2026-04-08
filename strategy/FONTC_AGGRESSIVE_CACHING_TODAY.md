# fontc Aggressive Caching Today

## Purpose

This note captures how Counterpunch can benefit from the caching and work partitioning that already exists in upstream `googlefonts/fontc`, without assuming upstream already provides a complete changed-glyph incremental compiler through its default entrypoint.

We are saving this as a strategy note for later work. It is not a statement that this path is the immediate priority.

## Plain-Language Terms

`FE` means frontend compiler artifacts.

These are structured intermediate results derived from the source font before binary table generation. In `fontc`, this includes items such as:

- static metadata
- glyph IR per glyph
- anchors per glyph
- glyph order
- features
- kerning groups
- kerning-at-location data

`BE` means backend compiler artifacts.

These are the outputs produced from FE artifacts on the road to a binary font. In `fontc`, this includes items such as:

- per-glyph `glyf` fragments
- per-glyph `gvar` fragments
- compiled layout tables like `GPOS`, `GSUB`, `GDEF`
- metrics tables like `HVAR`, `MVAR`
- `name`, `STAT`, and other final tables
- the final font bytes

## What Exists Today

The important upstream fact is that `fontc` already has the right storage shape for aggressive caching:

1. FE and BE work are identified by stable work IDs.
2. Many of those work IDs are already glyph-granular.
3. FE and BE contexts both support persistent storage keyed by those work IDs.
4. The workload graph is already split into meaningful work units like per-glyph IR and per-glyph binary fragments.

This means the substrate for aggressive incremental reuse already exists.

## What Does Not Seem To Exist Yet

The stock compile driver still appears to:

1. build a fresh workload from the source each run
2. enqueue broad FE and BE work rather than pre-pruning by a dirty glyph set
3. rely on dependency satisfaction rather than cache-freshness satisfaction to suppress execution

So the default top-level compile path looks more like “incremental-ready infrastructure” than “fully realized changed-glyph incremental compilation”.

## Practical Benefit Available Today

Counterpunch can still benefit from aggressive caching today if it treats upstream `fontc` as a reusable work/cache substrate rather than as a single opaque full-compile call.

The main win would come from reusing unchanged FE and BE artifacts during interactive editing.

Best fit cases:

- point dragging in one glyph
- anchor dragging
- small component edits
- repeated interactive compile cycles over a mostly stable subset

Weak fit cases:

- feature-file edits
- global metadata edits
- global axis/instance changes
- any edit that invalidates broad layout state

## Counterpunch Strategy

### 1. Keep a Stable Compiler Cache Per Open Font

Maintain a stable cache directory or equivalent persisted FE/BE state for the lifetime of the open font session.

Without this, there is no persistent substrate to exploit.

### 2. Compute an Explicit Dirty Set in Counterpunch

Before invoking the compile path, Counterpunch should classify the edit and compute the smallest correct dirty set.

Examples:

- outline edit: edited glyph, dependent composites, metrics fallout if width changed
- anchor edit: edited glyph anchors, dependent automatic composites, mark-positioning fallout
- component edit: edited composite glyph, possibly dependent metrics fallout
- feature edit: broad feature/layout invalidation
- text-input subset change: subset/layout closure invalidation, not source-glyph invalidation

### 3. Restore Unchanged FE Artifacts

If a glyph did not change, reuse cached FE artifacts for that glyph instead of regenerating them.

That includes glyph IR and anchors.

### 4. Restore Unchanged BE Artifacts

If a glyph did not change, reuse cached BE artifacts for that glyph instead of rebuilding them.

That includes `glyf` and `gvar` fragments.

### 5. Prune the Workload Instead of Running the Stock One Blindly

This is the key missing driver behavior.

Counterpunch should eventually either:

1. create only the dirty work items plus required downstream dependents, or
2. pre-mark unchanged work IDs as satisfied from cache before execution

### 6. Keep Invalidation Classes Small and Explicit

A practical invalidation model should distinguish at least:

- glyph-local invalidation
- component-dependent invalidation
- anchor/layout invalidation
- metrics-table invalidation
- font-global invalidation

This is what keeps the fast path fast instead of accidentally turning every edit into a broad rebuild.

### 7. Accept That Some Tables Stay Global

Even with strong glyph caching, some outputs still need broad rebuilds.

That is acceptable. The win comes from not recomputing every unchanged glyph on the way there.

## Recommended Phases

### Phase 1

- persist one compiler cache per open font session
- classify edit types into dirty sets
- map dirty sets to FE and BE work IDs

### Phase 2

- wrap or fork the compile driver so unchanged FE/BE work can be restored instead of rerun
- keep using current caches, but stop scheduling the full graph blindly

### Phase 3

- add explicit dependency expansion rules for component references, anchor propagation, and metrics fallout

### Phase 4

- align invalidation with Counterpunch compile modes such as outline-only, anchor-only, text-input, and full

## Bottom Line

The aggressive caching opportunity in `fontc` today is real.

What exists already:

- glyph-granular FE and BE work IDs
- persistent FE and BE storage
- enough structure to restore unchanged artifacts

What appears missing:

- a stock top-level driver that turns a dirty glyph set into a pruned incremental compile automatically

So the right conclusion is:

Counterpunch can benefit from aggressive caching in `fontc` today, but only by building a dirty-set-aware driver on top of the existing work/cache substrate rather than expecting the current default compile entrypoint to provide that behavior by itself.

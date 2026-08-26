# On-device font ML

## Status

Proposed. This document is the working strategy for training small models on
the converted Google Fonts `.babelfont` corpus and running them inside
Counterpunch. It covers the jobs, the models, and what each job needs. It
does not specify editor UI.

Agents may draft this file. It must undergo human review before it is treated
as authority.

## Opportunity

The sibling tree `../gfsources/babelfont` holds ~1800 Google Fonts sources
converted to `.babelfont`. That corpus supports two models and several jobs:

1. **Font engineering QA** (tables, not a net). For each glyph, say whether a
   component or anchor is likely missing, with a numeric confidence.
2. **A single topology-preserving deformer**, used in more than one way:
   - **Typographic scale** of a path or glyph in **any direction** — wider,
     narrower, shorter, taller, uniform up/down — so stems stay in the range
     a type designer would have drawn at that size, not the result of naive
     `scale()`. Examples: stretch a letter; make small caps from capitals
     (and the reverse); turn a small `/schwa` into a capital `/Schwa`.
   - **Infer a new master / axis** at a chosen location (`wght`, `wdth`,
     `opsz`, or any other inventoried tag).
   - **Derive a glyph set** with the same scale call, applied in batch —
     e.g. auto-smallcaps from capitals. Operationally this is the infer-master
     job (every chosen glyph, throughput latency) with a geometric condition
     instead of an axis slot, writing new glyphs rather than a new master.

Jobs 2’s call sites are **the same model**. They differ only in conditioning
and in how much of the font the caller runs it on. They are not two networks.

All of this must run **in the app, on-device**: training is offline;
inference is a fetched local asset (ONNX and/or JSON), not a server
round-trip and not PyTorch in Pyodide.

## Thesis

Do not train one “font brain.” Train two artifacts:

- QA is **corpus statistics over glyph identity** (JSON tables). A neural
  encoder is optional later for shape outliers.
- Everything that moves outlines is **one deformer**: ordered cubic nodes in,
  residual `(Δx, Δy)` per node out. Conditioning is either a 2D geometric
  scale `(sx, sy)` or an axis location (masked tag slots), or both. Affine
  scale (or the source master) is the baseline; the net learns the designed
  correction to stems, contrast, joins, and terminals.

Closest published architecture (idea only, not weights or data): [NIV: Neural
Axis Variations](https://arxiv.org/pdf/2606.05261) (Benedek, Shamir, Fried,
2026). NIV predicts per-point displacements conditioned on axis values and
keeps topology. It trained on compiled TrueType `gvar` (quadratic). This
project does not. Counterpunch is cubic-only.

```text
gfsources/*.babelfont
        |
        v
   offline mill
        |
        +---> QA tables (identity -> recipes, anchors, n, confidence)
        |
        +---> deformer shards
              (cubic nodes + 2D scale residuals + axis residuals)
                    |
                    v
              one fp16 ONNX deformer
                    |
                    +---> typographic scale (sx, sy) on a path or glyph
                    +---> infer master (axis slot)
                    +---> derive glyphs, e.g. small caps (sx, sy, batch)
```

## Goals

1. Inventory **every** axis tag in the corpus (registered and custom), with
   source counts and default→other-master example counts, then decide which
   tags the deformer gets — including the option to take all of them.
2. Ship QA that can label “missing component X” / “missing anchor Y” on a
   glyph when confidence ≥ a threshold, without a neural net.
3. Ship **one** deformer that moves the existing cubic nodes of a glyph or
   path, never invents a new outline topology.
4. That deformer’s geometric condition is **anisotropic 2D** `(sx, sy)`, not
   width-only. Stem behaviour must stay plausible when scaling down (caps →
   small caps), up (schwa → Schwa), horizontally, vertically, or both.
5. Keep training data, checkpoints, and the 1800 sources out of the editor
   git repo. The editor receives versioned inference assets only.

## Non-goals

- Editor UI, menus, filters, sliders, or preview chrome (specified elsewhere).
- Training on compiled TTF/OTF, `gvar` tuples, or quadratic outlines.
- Converting cubics to quadratics “for easier deltas.”
- Pairing sibling static files that share a family name but have no axes
  (`ZillaSlab-Regular.babelfont` next to `-Bold.babelfont`). Those are not
  compatible masters.
- Requiring `/A` and `/A.sc` (or `/a` and `/A`, `/schwa` and `/Schwa`) to
  share construction. Small caps are a separate glyph set, not an axis.
  They are optional bonus supervision when topology happens to match. They
  are not the backbone of geometric training.
- Generative “draw an /a” models, SVG command sequences, or raster-then-
  vectorize pipelines as the product output.
- Making the Zhang–Suen skeleton offset solver the product path. It already
  exists in the outline editor and did not produce usable type. It may remain
  a debug/fallback, not the trained system.
- A second network for small caps, case conversion, or infer-master.
- Running training in the browser.
- Silent overwrite of user outlines. Every generative result is a draft the
  rest of the app can commit through existing Yjs paths.
- Kerning, hinting, and OpenType layout as deformer outputs (phantom advance
  / sidebearings are in scope when the caller scales a whole glyph or infers
  a master; pair kerning is not).

## Constraints that apply to all jobs

### Cubic sources only

The editor’s outline model is cubic: on-curve nodes plus off-curve cubic
handles, in contour order. Inference input and output are that same list.

Axis-bearing sources in the corpus already have **compatible outlines**
across masters: same contour count, same node count, same node kinds, in
correspondence. A master-pair label is:

```text
delta[i] = target_master.nodes[i] - source_master.nodes[i]
```

including handles. There is no densified `gvar` step.

Babelfont often stores contours as compact node strings (`"378 660 l 283 660 l
…"`). The mill must expand those to coordinate + kind records before
training, using the same expansion the gfsources sizing scripts already
implement.

### Where deformer labels come from

- **Axis residuals:** masters inside one axis-bearing `.babelfont`. Skip
  sources with no `axes` array. Do not invent pairs across files. These
  outlines are compatible by construction.
- **Geometric `(sx, sy)` residuals (primary):** those same master pairs,
  whenever the bounding box (or a robust x/y extent) actually changes
  (`wdth`, `opsz`, and any other tag that moves x or y size). Point-wise
  residuals are valid because masters correspond.
- **Geometric residuals from small-cap / case glyph pairs (optional,
  gappy):** see below. Never required. Never a mill failure.

### Small caps and case pairs are optional and gappy

Small caps are not an axis. They are a **separate set of glyphs**. Nothing
requires `/A` and `/A.sc` (or `/a.sc`) to share contour count, node count,
or construction. The same is true of `/schwa` vs `/Schwa` and of many
uppercase/lowercase pairs. The corpus will have:

- **match** — topology corresponds; a point residual is legal
- **mismatch** — both glyphs exist, construction differs (extra contours,
  different nodes, overlap vs merge, …)
- **missing peer** — only one of the two exists (gaps in the small-cap set)

The mill **tolerates all three**. Inventory counts them. Mismatch and
missing peer are skipped for point-wise loss, not treated as errors. A
source that has `.sc` for `/A` `/B` `/E` but not `/R` is fine.

**Inference does not look up a peer.** Typographic scale and auto-smallcaps
run on the cubic node list the caller already has. A capital with no `.sc`
in the font, and a capital whose `.sc` was drawn with a different
construction, both scale. The deformer never needs the other glyph at
run time. It learned “scale this outline, keep stems in range” from
compatible **master** pairs (and from the rare matching `.sc` pairs). That
is why gappy small-cap sets do not block resize.

Optional later, not v1: mismatch pairs can still contribute a **peer-free
auxiliary** (raster or stem-width of affine(`/A`) vs `/A.sc`) without
forcing point correspondence. Do not delay the mill or the deformer on
that.

### Topology lock

If a job cannot keep contour count, node count, and node kinds of the
**source** outline, it is unusable in this editor. The deformer is
sequence-to-sequence with equal length on that list. It does not insert,
delete, or retype nodes, and it does not morph `/A` into a differently
constructed `/A.sc`. Auto-smallcaps produces a scaled `/A`, not a traced
copy of a peer.

### Legal

The corpus is OFL / UFL / Apache Google Fonts sources. Training a model and
shipping weights as a derived artifact needs a legal pass before a public
release. Until then, mill output and checkpoints stay out of the editor
repository and off the production CDN if that would constitute distribution.

### Asset shape

Offline train; on-device infer. Target: a few million parameters, fp16 ONNX
on the order of 5–15 MB for the deformer; QA tables a few MB of JSON. Fetched
and cached locally (same idea as Python wheels). Inference in a dedicated
worker with WebGPU or WASM SIMD — not the fontc worker, not the main thread.

---

## Shared mill (needed before any job is real)

A sibling project (recommended: `../font-ml/`) reads `../gfsources/babelfont`
and writes compact shards. The editor never parses 1800 full JSON fonts at
train or run time.

### Phase 0 — inventories

**Axes.** Walk every `.babelfont`. For **every** axis tag that appears
(`wght`, `wdth`, `opsz`, `slnt`, `ital`, `GRAD`, `SOFT`, `WONK`, `CASL`, and
whatever else is in the tree):

| Field | Meaning |
| --- | --- |
| `tag` | Four-character (or custom) axis tag as stored |
| `n_sources` | Sources that declare this tag |
| `n_examples` | Default-master → other-master cubic glyph pairs where this tag’s location actually changes |
| `min` / `default` / `max` | Typical userspace or designspace extents (report both if they differ) |

No pre-filter to the “big four.” After the table exists, decide include-all
versus a count cutoff. Architecture can take all tags as masked slots; the
table only shows which tags are too rare to be worth a slot.

**Case / small-cap pairing (expect gaps).** Same walk, all sources. For
candidate pairs (`/X` vs `/X.sc` / `/x.sc` / `/X.smcp`, `/schwa` vs
`/Schwa`, other case pairs), count **match / mismatch / missing peer**.
Expect mismatch and missing peer to dominate. That is not a blocker. It
only tells how much optional point-supervision exists. Geometric training
does not wait on a high match rate.

Same pass can emit a first QA sketch (see use case 1) for a handful of
identities (`A`, `a`, `Aacute`, `acutecomb`).

### What the mill extracts

For **deformer shards**:

- Ordered cubic node sequence per glyph layer (expanded nodes).
- Master location as a dict of tag → designspace value (axis-bearing
  sources).
- **Axis-pair examples:** source layer, target layer, per-node `delta`,
  which tags differ (those slots unmasked; all others masked). Geometric
  slots masked (or set to 1).
- **Geometric-pair examples:** same or other pairings where a 2D scale is
  well-defined. Compute independent `sx`, `sy` from x-extent and y-extent
  (glyph bounds, or a robust percentile box so stray points do not dominate).
  Affine-scale the source about a documented pivot (origin or bounds centre).
  Residual = `target_points - affine(source_points)`. Axis slots masked.
  **Do not** emit a geometric example when both `|log sx|` and `|log sy|`
  are below a small threshold: that is a weight-like pair (stems change,
  size does not) and would teach the scale slots the wrong residual at
  identity scale. Those pairs remain axis examples only (`wght`, etc.).
- **Optional same-source glyph pairs:** `/A`↔`/A.sc`, `/schwa`↔`/Schwa`,
  both directions, **only on topology match**. Mismatch and missing peer:
  skip the pair, log the gap, continue. Do not drop the font. Do not try
  to align unequal node lists.
- Phantom / metric extras: LSB, RSB, advance (layer `width`), UPM.
- Optional 64–128px baseline-aligned raster of the source, for a later
  conditioning CNN — not as an output representation.

For **QA tables** (all sources, including static):

- Glyph identity (see use case 1).
- Component recipe per layer (referenced glyph identities, order, not
  precise transforms).
- Anchor name set per layer.
- Unicode / name maps.
- Sample size per identity.

Hold out some **fonts** (not random glyphs) for deformer eval so
reconstruction is measured on unseen styles.

---

## The deformer (one network)

### Input sequence

Each node:

- `(x, y)` scaled by `2/UPM` into roughly `[-1, 1]`
- kind as stored after expansion (line / curve / offcurve cubic handle)
- contour index
- normalized position along its contour in `[0, 1]`

Optional trailing phantom points for advance and sidebearings (needed when
the caller wants metrics to move with a whole glyph or a new master).

Variable length. Latin glyphs are tens to a few hundred nodes; CJK can be
much longer. The network must accept variable `N`.

### Conditioning

A property embedding (NIV-style AdaLN). Two families of slots, independently
maskable:

- **Axis slots:** one per inventoried tag. Normalized value in `[-1, 1]`
  relative to the source master, plus a mask bit. A Regular→Bold example
  unmasks `wght` only.
- **Geometric slots:** `sx`, `sy` as log-scale (or linear; pick one and
  stick to it in the mill). Masked on pure axis examples. Unmasked on
  typographic scale, small caps, and case conversion.

Taking “all axes” means a wider embedding table, not a second network. Rare
tags see fewer updates.

A contrast-axis angle can be added later as another geometric slot. It is
not required to start.

### Residual outputs (not absolute coordinates)

**Axis call (infer master)**

```text
output_points = source_points + predicted_delta(axis_slots)
```

**Geometric call (typographic scale, small caps, schwa→Schwa)**

```text
affine = scale source_points about a pivot by (sx, sy)
output_points = affine + predicted_delta(scale_slots)
```

The net learns the correction that makes naive scale look designed.

Stroke expectation, both directions:

- **Scale down** (`sx, sy < 1`, caps → small caps): naive scale thins stems
  too much. Residual should keep stems closer to the source (optically
  thicker than affine). That is the same idea as drawing small caps, and
  related to optical size.
- **Scale up** (`sx, sy > 1`, schwa → Schwa): naive scale fattens stems.
  Residual should keep stems closer to the source (thinner than affine).
- **Stretch in one axis** (wider/narrower or taller/shorter): the unscaled
  direction’s stems should not pick up the other direction’s scale.

`sx` and `sy` are independent. Uniform scale is just `sx == sy`. Horizontal
resize is `sy == 1`. Small-cap height is typically `sy` ≈ x-height/cap-height
with `sx` similar or slightly different; the caller chooses the numbers, the
model does not hard-code a small-cap ratio.

### Architecture sketch

Point-wise projection → positional encoding along contour order → stack of
self-attention blocks with AdaLN from the property embedding → per-node
`(Δx, Δy)` head. Equal-length, not autoregressive. Loss: MSE on residuals
(and on phantom metrics when present). No glyph-name or unicode input, so
it can run on unnamed paths, on characters unseen in training, and on
glyphs that never had a matching small-cap or case peer in the corpus.

Optional later: a small raster CNN whose vector is added into AdaLN. Do not
vectorize a predicted bitmap back into nodes.

### What this deformer is not

It does not decompose or compose glyphs. It does not retarget a capital
drawing onto a lowercase topology. Composites: run on layers that have path
nodes; leave `reference` shapes in place (policy A under infer-master).
Automatic composition can rest after bases and marks move.

---

## Use case 1 — Font engineering QA

### Job

Given the glyphs of an open font, produce per-glyph **labels** of the form:

- missing component: referenced identity `I` (and optionally slot/order)
- missing anchor: name `N`

each with a **confidence** in `[0, 1]`. A threshold `X` (for example 0.8 or
0.9) decides which labels are worth keeping. This document does not specify
how they are shown.

This is the primary QA job. It is feasible **without a neural net**.

### Why tables beat a classifier here

“Does `/Aacute` usually contain `/A` and an acute mark?” is an empirical
frequency over the corpus, conditioned on glyph identity. There is no
geometry to generate. A softmax would hallucinate confidence on tiny `n`.
A binomial rate with a **lower confidence bound** will not.

### Glyph identity

Prefer unicode (the codepoint list on the glyph). Fall back to an
AGL-normalized name when there is no codepoint.

Component references in sources are names (`A`, `acutecomb.case`). The mill
must map those to identities too, so `.case` / `.sc` / language suffixes
collapse or are stored as a **variant of** a base identity rather than as
unrelated keys. Exact policy:

- Store recipes both at the raw reference-name level and at a normalized
  identity level.
- At match time, try raw name first, then normalized identity.
- Do not treat `acutecomb.case` as a miss for a font that uses `acutecomb`
  if the normalized identity is the same combining acute.

### What is stored per identity

For each identity `G`, aggregated across corpus layers. Default
recommendation: one row per source glyph, using the default master (or the
only layer in a static source):

- `n` — number of corpus observations
- For each component identity `C` (and optionally multiplicity / order):
  `k_C` — how many observations include at least one component `C`
- For each anchor name `A`: `k_A` — how many observations include `A`
- Optional: whether the glyph is typically a pure composite (no local
  path nodes), a mixed composite, or outlines-only

Example from Work Sans (illustrative, not a mill result): `/A` carries
`bottom`, `ogonek`, `top`, `top_ring`; `/Aacute` is `reference: A` plus
`reference: acutecomb.case` and has no anchors of its own. QA must flag
missing `top` on **`/A`**, and missing the acute component on **`/Aacute`**.
Flagging “`/Aacute` is missing anchor `top`” would be a false model of how
those sources are built.

### Confidence

Let `p̂ = k / n`. Displayed confidence is not `p̂`. It is the **lower bound**
of a Wilson (or Jeffreys) interval at a fixed level (95% is a reasonable
default). That stops `2/2 = 100%` from firing.

A label is emitted when:

1. The lower bound ≥ threshold `X`, and
2. The open glyph lacks that component identity or that anchor name, and
3. Gating (below) does not suppress it.

`X` is a runtime parameter, not baked into the tables.

### Gating (required, or the feature nags)

Corpus priors are global. Fonts are local.

**Mark-system gate.** Do not flag mark anchors (`top`, `bottom`, `_top`, …)
or mark components if *this font* has no combining marks, no accented
composites, and no combining unicodes. A symbol font’s `/A` is allowed to
lack `top`.

**Role gate.** Apply anchor priors to identities that usually *have*
anchors (bases, marks). Apply component priors to identities that are
usually composites. Do not demand that a composite also copy the base’s
anchor set unless the corpus actually puts those anchors on the composite.

**Within-font consistency (stronger than the corpus when available).** If
this font has 42 glyphs whose identity is “base + acute” in the corpus, and
40 of those 42 in *this font* are composites of the same shape, then the two
that are outlines should be labeled even if the global rate is milder. If
this font systematically draws accents, the within-font rate is near zero
and the corpus should not override it. A practical rule: if the font has at
least `M` peers in the same recipe class (say `M = 8`), use the **maximum**
of (corpus lower bound, within-font lower bound) only when the within-font
rate is also high; if the within-font rate is low, suppress the corpus
label (intentional decomposed design).

**Copy of the label (semantic, not UI chrome).** The fact stored is
“92% of corpus `/Aacute` observations are `A` + acute-mark (n=…, lower
bound=…).” It is not “this glyph is broken.” Decomposed accents are a
legitimate design choice. v1 does not auto-insert components or anchors.

### Secondary QA (later, not required to start)

- Unicode vs name mismatches (AGL + corpus majority map).
- Shape outliers: a tiny raster encoder and per-identity centroid; high
  distance means “this `/a` does not look like an `/a`.” Needs the mill’s
  rasters. Do not block missing-component/anchor on this.
- Unusual contour counts, zero-width encoded glyphs, etc.

### Data needed

- QA tables from **all** corpus sources (static included).
- Identity normalization tables (AGL, unicode, mark `.case` / `.sc`).
- No ONNX required for v1.

### Eval (offline, no editor)

Take a corpus source that has `/A` with `top` and `/Aacute` as `A` + acute:

- Delete `top` from `/A` → label fires above `X`.
- Delete the acute component from `/Aacute` → label fires above `X`.
- A marks-free subset (or a symbol source) with `/A` and no `top` → no mark
  labels.
- A source that draws `/Aacute` as outlines, consistently → no “missing
  component” labels once the within-font gate sees enough peers.

Report precision/recall at a few `X` values. Tune `X` and `M` from that,
not from intuition.

### What this use case does not need

- The deformer.
- Axis inventory (except that the mill can share a walk of the tree).
- Compatible masters.

---

## Use cases 2 and 3 — Same deformer, different calls

There is no resize-net and master-net. One forward pass. The caller sets
masks and how many glyphs to run.

### Why the mathematical attempt failed

The outline editor already implements stroke-aware scaling: rasterize the
fill, thin to a skeleton, attach each node to a centerline with a
`normalOffset`, scale the skeleton, and try to keep the offset. Type
designers do not work that way. Designed masters move **corresponding cubic nodes**. Junctions, serifs,
and contrast are not a constant offset from a Zhang–Suen skeleton. The
deformer learns those residuals on top of affine scale (or on top of the
source, for an axis call). Matching `/A` vs `/A.sc` pairs, when they exist,
are extra geometric examples — not a dependency.

### Call: typographic scale (any `sx`, `sy`)

**Job.** Given an existing cubic path (one contour, several contours, or a
whole glyph layer), a pivot, and independent `sx`, `sy`, write a new
coordinate for each existing node (handles included) such that the requested
size is met and stems/contrast stay in designed range.

**Contract.**

- In: ordered nodes, UPM, `(sx, sy)`, pivot.
- Out: `Δx, Δy` per node in normalized space; add them to the affine-scaled
  nodes.
- Off-curve stays off-curve. Closed stays closed.

The mill and model do not know “selection.” Scope is the node list the
caller passes. No peer glyph is consulted. Outlines that could not have
been paired with a `.sc` in the mill still resize.

**Latency.** Interactive path work needs on the order of **&lt; 30 ms** for
a typical Latin glyph on WebGPU or WASM SIMD. One sequence, not the font.
If that budget cannot be met, live dragging is out; one-shot apply remains.

### Call: infer master / axis

**Job.** Given a font with one or more cubic masters, a target axis tag `T`
from the trained set, and a target location on `T`, produce a new master:
for every glyph, a layer topology-identical to the source, with predicted
outlines (and metrics).

Existing `Font.addMaster` interpolation, given a single master, copies. The
deformer supplies the designed delta.

**Contract.** Unmask slot `T`, set its normalized value from
`(target - source) / (axis_extent)`, mask geometric slots. Residuals add to
the source nodes (not to an affine). Source layer: default master, or the
master nearest the target in the existing design space. If the font already
has `T`, interpolation/extrapolation should be used instead of the net.

Inventory min/default/max per tag exist so a numeric location (e.g. CSS
weight 700) can be mapped. That mapping is data.

**Scope.** Every glyph that has outline data in the source master. Tens of
milliseconds per glyph is acceptable; seconds to tens of seconds for Latin
is acceptable; CJK may take minutes. Throughput, not interactive.

**Metrics.** Phantoms on, so advance and sidebearings move. Kerning is out
of scope.

**Composites.** v1: **policy A** — deform layers that have path nodes; leave
`reference` shapes. Automatic composition can rest after bases/marks move.
Policy B (predict component translations) only if A fails on a real family.

**Axes.** One new tag at a time in v1. Train on default → every other master,
not only extremes. A second new axis is a second inferred master after the
first exists.

### Call: derive glyphs (auto-smallcaps, case conversion)

**Job.** Same geometric forward pass as typographic scale, run in batch like
infer-master. Examples:

- Capitals → small caps: `sy` (and usually `sx`) ≈ small-cap height / cap
  height; stems must not collapse to the naive thin.
- Small caps → capitals: inverse scale; stems must not blow up.
- `/schwa` → `/Schwa` (and the reverse): scale to the other case’s typical
  height in that font (cap-height vs x-height, or a peer glyph’s bounds if
  it exists **as a size reference only**). Topology stays the outline you
  started from. A differently constructed peer, or a missing peer, does
  not block the call and is not blended in.

Gaps in the derived set are allowed: if the source font or the corpus has
small caps for only some letters, the rest still scale.

Output is new glyph data (or replacement drafts), not a new master and not
a new axis. That is a usage difference, not a model difference.

**Scope and latency.** Same as infer-master: a set of glyphs, throughput
budget.

**Metrics.** Phantoms on if the derived glyph should get a new advance.

### Training (all three calls)

One multi-task batch:

| Example type | Unmasked slots | Residual target |
| --- | --- | --- |
| Master pair, tags differ | those axis tags | `target - source` |
| Master pair, `|log sx|` or `|log sy|` above threshold | `sx`, `sy` | `target - affine(source)` |
| Glyph pair, topology **match** only (`/A`↔`/A.sc`, …) | `sx`, `sy` | `target - affine(source)` |
| Glyph pair, mismatch or missing peer | — | skip (count as a gap) |

`opsz` pairs are the main teacher of uniform-ish scale with optical stem
correction. `wdth` pairs teach horizontal stretch. Matching `.sc` / case
pairs are a bonus if the inventory finds enough of them. `wght` pairs stay
on the axis side of the table unless the box really changed. Geometric
resize must work even if the bonus row is almost empty.

### Eval (offline)

**Geometric / scale**

- Held-out `wdth`: affine vs predicted vs designed; stem cuts on `/n`,
  `/o`, `/H`, `/I`. Predicted stems must beat affine.
- Held-out `opsz` (if present): same, for near-uniform scale.
- **Primary small-cap / case check, no peer required:** scale held-out
  `/H`, `/A`, `/schwa` to 0.7 and 1.4 (and anisotropic stretches). Stem
  width must move **less** than affine (down: thicker than affine; up:
  thinner than affine). Run this on glyphs that have no `.sc` sibling so
  the gappy case is the default eval, not an afterthought.
- Optional extra: where a held-out `/A` vs `/A.sc` **matches** topology,
  also report node RMSE. Mismatch pairs are not an RMSE target; at most
  compare raster/stems.

**Axis / infer-master**

- Strip a non-default master on a held-out source; predict it from the
  default; RMSE on nodes and advance.
- Overlays on `/n`, `/o`, `/a`, `/e`, `/H` for several tags, not only
  `wght`.

**Ship bar.** A designer would start from the draft (scaled glyph, inferred
master, or derived small caps), not redraw. QA does not wait on this bar.
If geometric stem-preservation fails, none of the deformer call sites ship.

### Data needed

- Axis inventory (all tags) and the include-all vs cutoff decision.
- Case/small-cap inventory (match / mismatch / missing peer). Bonus
  point-pairs only on match; mill succeeds if match is rare.
- Deformer shards as in the mill section (axis + geometric master pairs;
  optional matching glyph pairs).
- Phantom / width targets for whole-glyph and master calls.

### What these calls do not need

- QA tables.
- Separate ONNX files per call site.

---

## What to ship as inference assets

| Asset | Jobs | Approximate size |
| --- | --- | --- |
| QA JSON: per-identity `n`, `k` for components and anchors, plus identity normalization | QA | a few MB |
| One deformer ONNX (fp16), axis-tag list, normalization constants (UPM scaling, per-tag extents, log vs linear scale) | all deformer calls | ~5–15 MB |
| Optional raster encoder ONNX + centroids | QA later | ~1 MB |

QA can ship without the deformer. The deformer can ship without QA. Neither
belongs in the editor source tree as training data.

## Work sequence (capability, not UI)

1. **Inventory** every axis tag, case/small-cap match–mismatch–missing
   counts, and a first QA frequency sketch.
2. **Mill** cubic shards (axis + 2D geometric residuals from masters;
   optional matching glyph pairs; skip gaps) and full QA tables.
3. **Train one deformer.** Export ONNX.
4. **Eval** QA and every deformer call site with the offline protocols
   above.
5. Only then integrate inference into the app (out of scope for this
   document).

## Open decisions (blocked on inventory and eval, not on taste)

- Include-all axis tags vs a minimum `n_examples` cutoff.
- Log vs linear `sx`/`sy`; pivot (origin vs bounds centre) as mill law.
- Threshold on `|log s|` that separates geometric examples from weight-like
  pairs.
- One QA observation per source glyph vs per master layer.
- Wilson vs Jeffreys interval; default `X` and within-font `M`.
- Composite policy A vs B if A fails on a real family.
- Whether a raster CNN is needed for deformer quality, or only for later
  shape-outlier QA.
- Whether mismatch `/A` vs `/A.sc` pairs later get a raster/stem auxiliary
  loss (still no point alignment). v1 skips them.

## References inside this repo

- Corpus: `../gfsources/babelfont`, mill notes in `../gfsources/README.md`
  (compact node expansion already exists in gfsources sizing scripts).
- Cubic model: `webapp/js/babelfont-model.ts` (paths, nodes, layers,
  masters, axes).
- Failed geometric resize (context only): stroke-aware skeleton path in
  `webapp/js/glyph-canvas/outline-editor.ts`.
- Existing add-master interpolation (copies when there is nothing to
  interpolate): `Font.addMaster` in `webapp/js/babelfont-model.ts`.

# Babelfont-rs Update + Upstream PR Plan

## Objective

Update the local `babelfont-rs` fork to the latest upstream, rebase the
`norad-non-file-io-editor-test` branch on top, then prepare clean PRs to
upstream for two essential fixes that the editor's JS bridge depends on.

## Context

The editor's WASM build (`babelfont-fontc-build/`) depends on the local fork at
`../../babelfont-rs/babelfont`. The `norad-non-file-io-editor-test` branch
carries a mix of (a) temporary/experimental changes, (b) already-committed
cleanup (stripping reactive-store attributes, removing UFO/fontforge save
paths), and (c) two real bug fixes that need to go upstream:

1. **`babelfont/src/font.rs`** — `interpolate_glyph{,_with_extrapolation}` does
   not resolve layers via `layer.master` (the `LayerType` tagged union). The JS
   model always uses `layer.master` to reference masters, so interpolation
   breaks on any font loaded from the editor that has outline paths.

2. **`babelfont/src/serde_helpers.rs`** — Node serialization uses a compact
   string format (`"100 200 m 300 400 l"`) that the JS side neither produces
   nor consumes:
   - JS → Rust (`store_font`): sends nodes as JSON arrays → deserialization
     fails without `deserialize_any` that accepts both formats.
   - Rust → JS (`interpolate_glyph`): outputs compact strings →
     `LayerDataNormalizer` throws `TypeError` because it requires arrays.

Both issues are **still present on upstream `main`** (SHA `15e6067`, verified
2026-06-09). The 5 upstream commits since the fork did not touch these files.

## Phase 1 — Reset and update the fork

### Step 1.1 — Discard unstaged changes in babelfont-rs

```bash
cd /Users/yanone/Code/Counterpunch/babelfont-rs
git checkout -- babelfont/src/font.rs babelfont/src/serde_helpers.rs
```

Verify with `git status` — working tree must be clean on branch
`norad-non-file-io-editor-test`.

### Step 1.2 — Update main branch to upstream HEAD

```bash
git checkout main
git fetch upstream
git merge upstream/main
# OR: git reset --hard upstream/main  (if you want a clean match)
```

Verify: `git log --oneline -1` shows upstream HEAD (`15e6067` or newer).

Push to origin:
```bash
git push origin main
```

### Step 1.3 — Rebase norad-non-file-io-editor-test onto updated main

```bash
git checkout norad-non-file-io-editor-test
git rebase main
```

Resolve any conflicts:
- `font.rs`: upstream may have changed the same functions. The already-committed
  changes on the branch (`interpolate_glyph_with_extrapolation`, removal of
  reactive-store attributes, remove UFO/fontforge save) will conflict if
  upstream touched the same lines. Handle case-by-case.
- `serde_helpers.rs`: no committed changes on our branch (only unstaged), so no
  conflicts expected here.

### Step 1.4 — Verify the babelfont crate compiles

The `babelfont` crate itself must compile cleanly:

```bash
cd /Users/yanone/Code/Counterpunch/babelfont-rs
cargo build -p babelfont
```

**Note:** The editor's WASM build (`./build-fontc-wasm.sh`) will likely **not** compile
at this stage, because upstream babelfont-rs switched its `fontdrasil` dependency
source from `simoncozens/fontc` to `googlefonts/fontc` (commit "Separate TTF
compilation options"). The editor's `babelfont-fontc-build/Cargo.toml` still
pins `fontdrasil` (and related crates `fontc`, `fontbe`, `fontir`) to
`simoncozens/fontc`. This creates a dueling-fontdrasil conflict — the two
versions have incompatible internal types (e.g. `Location` changed from
`BTreeMap`-backed to `Vec`-backed).

This conflict is **out of scope** for the norad-rebase work. It will be resolved
separately when the editor's WASM build deps are updated to match the new
babelfont-rs workspace (Phase 3.3).

For the PR branches (Phase 2), the fixes are in `font.rs` and `serde_helpers.rs`
only — they don't touch fontdrasil types at all. Their compilation will be
verified by building `cargo build -p babelfont` against `main`. The WASM dist
rebuild will happen after the editor's Cargo.toml deps are sorted out.

**Conflict-resolution fixes applied during rebase:**

| File | Fix |
|------|-----|
| `convertors/ufo.rs` | Added back `KEY_IDENTIFIER` and `KEY_ORIGINAL_GUIDE` constants (removed by branch but needed by `guide.rs`) |
| `convertors/ufo.rs` | Changed `as_norad(font)` signature back to `as_norad(font, _master_ix: usize)` (branch had dropped the arg) |
| `convertors/ufo.rs` | Added back `save_ufo` function (removed by branch but called from `font.rs`) |
| `filters/removeextraneouslayers.rs` | Added `false` as 5th `extrapolate` arg to `interpolate_layer` call |

These are compatibility shims between the branch's experimental norad code and
upstream's new API surface. They don't affect the two PR fixes.

---

## Step 1.5 — Resolve an additional dependency conflict

The rebase of `norad-non-file-io-editor-test` onto the updated `main` revealed
a **dueling fontdrasil** version conflict. Upstream's latest commit "Separate
TTF compilation options" switched the fontc/fontdrasil dependency source from
`simoncozens/fontc` to `googlefonts/fontc`. The editor's
`babelfont-fontc-build/Cargo.toml` still references the old source, so the
WASM build pulls in two incompatible versions of `fontdrasil` (one
`BTreeMap`-backed `Location`, one `Vec`-backed).

To make the WASM build work with the updated babelfont-rs, the editor's
`babelfont-fontc-build/Cargo.toml` needs its fontc/fontdrasil source updated:

```toml
# Change from:
fontdrasil = { git = "https://github.com/simoncozens/fontc", branch = "new-varc-writefonts" }
fontc = { git = "https://github.com/simoncozens/fontc", branch = "new-varc-writefonts", ... }
# etc.

# To (matching babelfont-rs workspace):
fontdrasil = { git = "https://github.com/googlefonts/fontc", rev = "3518040e" }
fontc = { git = "https://github.com/googlefonts/fontc", rev = "3518040e", ... }
# etc.
```

This change may introduce new compilation issues in the WASM build crate
itself if the new fontc API surface changed.

> **⚠ This may be time-intensive to resolve.** If so, consider deferring the
> editor's WASM dependency update to a separate task and proceeding with the
> PR branches only (Phase 2). The PR branches start from `main` and don't
> carry the norad changes, so they'll work with either fontc source.

## Phase 2 — Create clean PR-ready branches

### Step 2.1 — Create branch for the `font.rs` fix

From a clean parent (either `main` or a branch that only contains the
`layer.master` fix):

```bash
git checkout -b fix/interpolate-glyph-master-resolution main
```

Apply the `layer.master` resolution logic to `interpolate_glyph_with_extrapolation`
in `babelfont/src/font.rs`. The diff is:

- Before: only `layer.id == master.id` matching
- After: first try `layer.master` (`DefaultForMaster` / `AssociatedWithMaster`),
  fall back to legacy `layer.id` matching

Also include the `extrapolate` parameter pass-through if not already upstream.

Commit message style:
```
fix(font): resolve layers via layer.master in interpolate_glyph

The LayerType tagged union (DefaultForMaster / AssociatedWithMaster) is
the primary way layers reference their master, but interpolate_glyph only
matched by layer.id. Add layer.master resolution first, with a legacy
fallback for older fonts.
```

### Step 2.2 — Create branch for the `serde_helpers.rs` fix

```bash
git checkout -b fix/node-serialize-as-json-arrays main
```

Apply the `NodesVisitor` + `deserialize_any` change and the JSON-array
serialization. The diff:

- `serialize_nodes`: change from compact string to `SerializeSeq` of `Node`
  objects
- `deserialize_nodes`: replace `let s: String = deserialize(...)` with a
  `NodesVisitor` that implements `visit_seq` (JSON arrays) and
  `visit_str`/`visit_string` (legacy compact strings), delegating the latter to
  `parse_compact_node_string()`

Commit message style:
```
fix(serde): serialize nodes as JSON arrays, accept both formats on input

The compact string format ("x y type ...") is not compatible with tooling
that produces standard JSON arrays. Change serialization to output
[{x, y, nodetype, ...}] and make deserialization accept both formats via
a custom Visitor, retaining the compact string parser as a legacy fallback.
```

### Step 2.3 — Verify both branches compile

```bash
cd /Users/yanone/Code/Counterpunch/editor
./build-fontc-wasm.sh
```

On each branch, the WASM build must succeed.

### Step 2.4 — Rebuild editor WASM dist

After verifying the branches, rebuild the editor's WASM dist against the
`fix/interpolate-glyph-master-resolution` branch (or a combined branch with
both fixes, if preferred). This will regenerate:
- `webapp/wasm-dist/babelfont_fontc_web_bg.wasm`
- `webapp/wasm-dist/babelfont_fontc_web.d.ts`
- `webapp/wasm-dist/babelfont_fontc_web_bg.wasm.d.ts`

These changes will be committed in the editor repo.

## Phase 3 — Submit upstream PRs

### Step 3.1 — Push branches to origin

```bash
cd /Users/yanone/Code/Counterpunch/babelfont-rs
git push origin fix/interpolate-glyph-master-resolution
git push origin fix/node-serialize-as-json-arrays
```

### Step 3.2 — Create PRs to simoncozens/babelfont-rs

Via GitHub CLI or web UI. Each PR targets the upstream `main` branch.

PR descriptions should explain:
- What the JS bridge produces/consumes
- Why the current code fails
- Why the fix is backward-compatible (legacy fallback retained)

### Step 3.3 — Update editor dependency tracking

Once PRs are merged upstream (or accepted as a patch), update the editor's
`Cargo.toml` pin to point to the new upstream commit.

## Risk assessment

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Rebase conflicts on `font.rs` | Medium | Upstream has new commits; `interpolate_glyph{,_with_extrapolation}` lines may conflict. Resolve per-hunk. |
| WASM build fails after rebase | Low | If the forked branch's removals (reactive-store, UFO) conflict with upstream additions, comment out or adjust in the rebase. The clean PR branches avoid this entirely. |
| Upstream rejects JSON-array serialization | Medium | Upstream may prefer to keep compact strings. Fallback: serialize as JSON arrays only in the editor's WASM build layer (override serde in `babelfont-fontc-build`), keeping upstream unchanged on the serialize side. The deserialize fix (accept both) should be uncontroversial. |
| Upstream already has partial fix for one file | Low | Verified 2026-06-09: neither file was touched. |

## Sequence summary

```
1. git checkout -- babelfont/src/{font,serde_helpers}.rs   # discard unstaged
2. git checkout main && git merge upstream/main              # update to latest
3. git checkout norad-non-file-io-editor-test && git rebase main
4. ./build-fontc-wasm.sh                                     # verify build
5. git checkout -b fix/interpolate-glyph-master-resolution main
   → apply font.rs fix, commit
6. git checkout -b fix/node-serialize-as-json-arrays main
   → apply serde_helpers.rs fix, commit
7. ./build-fontc-wasm.sh (on each branch)
8. Rebuild editor WASM dist against combined fixes
9. gh pr create (x2) to simoncozens/babelfont-rs
```
# Live Collaboration v2

## Status And Relationship To v1

This document supersedes `LIVE_COLLABORATION_v1.md` for implementation
decisions. v1 remains useful as a survey of the existing code and the
high-level product model. v2 keeps v1's product model (assets with UUID
identity, cloud filesystem plugin, share-by-email, owner/editor/viewer roles)
and tightens the engineering plan in the areas where v1 was deliberately
non-committal:

- where the hot Yjs log actually lives on Cloudflare;
- exact persistence cadence for deltas, segments, and snapshots;
- how granular replay and revert should work for fonts;
- how undo behaves between users;
- how concurrent kerning and outline edits stay independently revertible;
- offline reconnect, idempotency, and ordering;
- WebSocket hibernation and cost shape;
- how invited users find shared fonts when their library has no folder structure;
- migration paths for schema and editor changes that hit live rooms;
- a credible path to lazy per-glyph loading for very large fonts (CJK).

What v1 already gets right and v2 keeps unchanged:

- two planes — `website` (Pages + D1) for accounts/metadata/sharing/auth and a
  data plane for live rooms;
- one Durable Object per font asset as the only place that applies updates;
- assets identified by long random IDs, decoupled from family name and folder
  path; folders are metadata, not path strings;
- share-by-email resolved to internal user IDs server-side; pending invitations
  for unregistered emails;
- owner/editor/viewer roles with room-token enforcement at the DO;
- editor's existing transaction boundaries (`ChangeBridge.endTransaction`,
  mouseup commits) as the unit of cloud history — no per-tick streaming;
- `WindowSync` provider abstraction: BroadcastChannel locally, WebSocket
  remotely;
- restore is a forward operation, not history rewriting.

What v2 revises:

- v1 left "Durable Object storage vs R2 vs D1" partially open; v2 commits to a
  three-tier hot/warm/cold layout with concrete thresholds;
- v1's snapshot cadence (every 250 updates / 60 s) is kept but v2 separates
  cheap "merge points" from expensive babelfont JSON materializations;
- v1 said little about offline editing; v2 adds an explicit reconnect protocol
  using Yjs state vectors plus per-client monotonic sequence numbers for
  idempotency;
- v2 commits to using Cloudflare Durable Objects with WebSocket hibernation and
  Durable Object SQLite storage — without those two, per-asset rooms are too
  expensive to leave open all day;
- v2 commits to a single shared `Y.Doc` with scoped `Y.Map` subtrees, not Yjs
  subdocs, because subdocs would force the editor to rework its existing
  scoped UndoManager wiring for marginal gain;
- v2 specifies how change-log metadata travels alongside the binary update so
  the server can build the per-glyph and per-kerning history index without
  parsing Yjs.

## Cloudflare Topology

```
Browser editor ────────────► Pages (website)            (control plane)
        │                       │   D1: users, ACL, folders, assets,
        │                       │       events index, named versions
        │                       │   KV: api docs (existing)
        │                       │
        │   room token (JWT)    ▼
        │                  Issues short-lived
        │                  per-asset tokens
        │
        ▼
   WebSocket ─────────────► Worker + Durable Object       (data plane)
                              per `font_asset.id`
                              ├─ in-memory Y.Doc
                              ├─ DO SQLite: hot append log,
                              │              awareness state,
                              │              per-client seq cursors
                              ├─ R2: warm segments + cold snapshots
                              └─ D1 (via service binding):
                                  event index rows,
                                  named version rows
```

Required Cloudflare capabilities (all GA on the platform today):

- Durable Objects with `WebSocketHibernation` API so idle rooms cost nothing
  while still resuming on the next message without losing in-memory state
  (state is rehydrated from DO SQLite);
- Durable Object SQLite-backed storage for the hot append log and per-client
  cursors;
- R2 for segment and snapshot blobs;
- Workers/Pages service bindings so the DO Worker can call into the website's
  D1 via a typed RPC, instead of duplicating D1 access logic.

Deployment shape: one new Worker (`cf-fonts-room`) bound from the Pages project
via service binding. The DO class lives in that Worker. Pages keeps owning all
HTTP control-plane endpoints. This avoids tangling the room runtime with the
Pages build.

## Cloud Filesystem Plugin

The editor gets a third filesystem plugin alongside `Memory` and `Disk`:

- ID `cloud`, requires authentication, no manual save UI;
- adapter implements the existing `FileSystemAdapter` contract;
- list/move/rename go through `/api/cloud/folders` and `/api/cloud/assets`;
- "Open" returns `{ assetId, displayName, role, roomEndpoint, roomToken,
bootstrap }` where `bootstrap` is either an inlined babelfont JSON for small
  fonts or a signed R2 URL for large snapshots plus a Yjs state vector;
- "Save As" on a non-cloud font calls `POST /api/cloud/assets` to create a new
  asset row, uploads the initial babelfont JSON to R2, and seeds the DO with
  it on first connect.

### Library Model: Flat List First, Folders As An Overlay

The Google Docs / Drive split is genuinely confusing and v2 should not
reproduce it. The mental model in v2 is:

1. **The library is a flat list of font assets you can access.** This is the
   primary view in the cloud plugin and the primary thing the editor's file
   browser shows. It is the union of fonts you own and fonts shared with you.
   It is sortable and filterable (by name, recency, owner, role, shared/owned)
   but has no inherent hierarchy.
2. **Folders are an organizational overlay on top of that flat list, and they
   belong to one user.** Folders are private to the user who created them.
   They organize _that user's view_ of _their accessible assets_. They do not
   travel with the asset.

Concretely:

- Owners place their own assets in their own folders.
- An invited editor or viewer sees the asset in their flat library by
  default. They may then file it into one of _their own_ folders, but that
  filing is invisible to the owner and to other collaborators.
- An asset can appear in at most one folder per user (or in no folder, i.e.
  "unfiled"), which is the same constraint Drive uses for `My Drive` in the
  shared-with-me case.
- Removing an asset from a folder does not affect access. Revoking access is
  a separate sharing action.
- "Recents", "Shared with me", "Owned by me", and "All" are filtered views
  over the flat list, not folders.

This collapses the Drive vs Docs duality into a single coherent model: the
library is the list, folders are tags-with-tree-structure that each user
maintains for their own benefit.

Schema implication: folder membership is **per user**, not per asset.
`cloud_folders.owner_user_id` already scopes folders to a user. The mapping
between asset and folder is held in a separate table:

```sql
CREATE TABLE cloud_folder_entries (
  user_id   TEXT NOT NULL,
  asset_id  TEXT NOT NULL,
  folder_id TEXT,            -- NULL = unfiled in this user's library
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, asset_id)
);
```

When a user gains access to an asset (becomes owner, accepts an invitation,
claims a pending invite), a single `cloud_folder_entries` row is created
with `folder_id = NULL`. The asset is therefore guaranteed to appear in
their flat library immediately. They can later move it into one of their
own folders without affecting anyone else.

When access is revoked, that user's `cloud_folder_entries` row is deleted.
The asset itself, the owner's filing, and other collaborators' filings are
untouched.

Future filesystem-sync (Dropbox/Drive style) preparation:

- folders and assets carry stable IDs and monotonic `revision` counters
  independent of name/path;
- because folder membership is per-user, a future sync engine maps **one
  user's folder tree** to their local filesystem — it never has to reconcile
  competing trees from different collaborators;
- a separate `cloud_sync_links` table is reserved (not implemented in v2) to
  map external-provider paths to `(user_id, asset_id, folder_id,
last_known_revision)`;
- moves and renames are explicit metadata events with both old and new
  parent/name so a future sync engine can replay them without diffing trees.

Do not implement filesystem sync now. Just keep these invariants so it stays
addable later without schema migrations.

## Sharing And Authorization

Roles in v2:

- `owner`: full edit, share, rename, archive, restore at any scope, delete,
  transfer, export;
- `editor`: edit live data, create named versions, restore their own recent
  changes (see Undo and Restore section);
- `viewer`: read-only, sees presence, may inspect history but cannot send
  document updates.

Auth flow:

1. Editor calls `POST /api/cloud/assets/:id/room-token` over the existing
   session cookie/bearer auth.
2. Pages function checks ACL in D1, then signs a short-lived JWT (≤ 5 min)
   with `{ assetId, userId, role, exp, jti }` using a shared secret bound to
   both Pages and the DO Worker.
3. Editor opens the WebSocket and sends `auth` with that JWT. The DO verifies
   the signature, checks `exp`, records `jti` in DO storage to detect replay,
   and pins the connection's `userId` and `role`.
4. Email is never sent to the DO. All authorization is by internal user ID.

Pending invitations remain as in v1: rows in `font_asset_invitations` keyed by
normalized email, claimed at signup, then converted into a
`font_asset_members` row.

Optional v2 extension (not v1): a viewer-only public link, implemented as a
distinct token type with `role = 'viewer'` and no `userId`, stored as a
revocable `font_asset_public_links` row. Off by default.

## User Account Types And Cloud Eligibility

Cloud hosting is a premium feature that is **disabled by default for all users**.
During the current development phase, access is granted manually on a per-user basis
by admins via the same dashboard pattern used for AI assistant inference overrides.
Later, access and quota limits will be tied to subscription tiers; the three
server-side methods below are the single call-site that will absorb those changes.

### Three Server-Side Entitlement Methods

Three functions in `utils/cloud-entitlements.js` are the sole source of truth for
cloud quota and eligibility decisions on the Pages control plane:

```js
// Returns true only if the user has an active cloud override row in D1.
// Default: false. Later: may also return true for qualifying subscription tiers.
async function isCloudHostingEnabled(db, userId) { ... }

// Returns null (unlimited) for all users in the current phase.
// Later: will return the integer font-count cap for the user's subscription tier.
async function getMaxFontsOwned(db, userId) { ... }

// Returns null (unlimited) for all users in the current phase.
// Later: will return the minimum number of days `named` versions owned by
// this user are retained (per tier). Operationally driven snapshot kinds
// (`recovery`, `session-end`, `session-start`, `pre-op`, `explicit`) follow
// the per-kind retention table in the Retention And Compaction section and
// are NOT affected by this value — they are infrastructure, not user data.
async function getSnapshotRetentionDays(db, userId) { ... }
```

All three consult `user_cloud_overrides` first. The bodies are intentionally stubs
now; callers are already wired, so internal logic can be enriched without touching
any call site. `null` always means "unlimited" throughout the system.

### Admin Override (Development Phase)

The admin dashboard gains a **Cloud Hosting** panel alongside the existing
Membership Overrides panel. An admin can grant or revoke cloud hosting access
for any user by email or user ID. The panel calls
`POST /api/admin/cloud/override` with `{ action: 'grant' | 'revoke', userQuery }`.

`isCloudHostingEnabled` returns `true` if any row exists for the user with
`revoked_at IS NULL`. No expiry in the development phase; overrides persist until
manually revoked. There are no quota columns on this table in v2 — those will be
added when concrete tier definitions exist.

### Internet-Facing Eligibility Endpoint

`GET /api/cloud/eligibility` is the only endpoint the editor's `CloudPlugin`
needs before deciding whether to show cloud features or allow a "Save to Cloud"
operation.

Response shape:

```jsonc
{
    "cloudHostingEnabled": false,
    "maxFontsOwned": null, // null = unlimited
    "snapshotRetentionDays": null, // null = unlimited
    "fontsOwnedCount": 0, // current count of assets owned by this user
}
```

- `cloudHostingEnabled: false` → editor hides the cloud plugin entirely. No
  "Save to Cloud" UI is shown.
- `cloudHostingEnabled: true` → editor shows the cloud plugin. It may also
  check `fontsOwnedCount < maxFontsOwned` (treating `null` as unlimited) before
  offering the Save As action, and display a quota indicator if `maxFontsOwned`
  is non-null.
- Unauthenticated callers receive `401`.
- Cheap: one D1 read against `user_cloud_overrides` + one row count against
  `font_assets.owner_user_id`. `cloud_folder_entries` is per accessible asset,
  so it must not be used for owned-font quota counts. No DO involvement.

`POST /api/cloud/assets` (Save As) re-checks eligibility server-side before
creating the asset row, guarding against stale client state.

### Future Tier Mapping

When subscription tiers are defined, `isCloudHostingEnabled` will also return
`true` for users whose active subscription includes cloud hosting. `getMaxFontsOwned`
and `getSnapshotRetentionDays` will return tier-appropriate caps. `user_cloud_overrides`
rows remain as a manual admin escape hatch that can override any tier limit — the
same pattern as `membership_overrides` for AI inference.

## Yjs Document Shape

One root `Y.Doc` per asset, structured so scoped UndoManagers and per-glyph
history work without subdocs:

```
yDoc
├─ font:         Y.Map   // family name, axes, masters, instances, info,
│                         // features (top-level), metrics defaults
├─ glyphs:       Y.Map<glyphName, Y.Map>
│                         // each glyph value is a Y.Map mirroring the
│                         // editor's current per-glyph topology:
│                         // `layers` (Y.Map<layerId, Y.Map> — paths,
│                         // anchors, components, width, metrics keys),
│                         // `unicodes`, glyph-level `metricsKeys`,
│                         // `categories`, etc.
├─ kerning:      Y.Map<masterId, Y.Map<pairKey, number>>
├─ features:     Y.Map   // feature source blocks, classes, lookups
└─ meta:         Y.Map   // doc schema version, last actor, lastEditAt
```

This matches the current `ChangeBridge` topology — v2 does not reshape the
Yjs tree. The reason matters: per-glyph and per-layer UndoManagers already
target sub-`Y.Map`s of `glyphs.<name>`. Cloud collaboration is a transport
change, not a model change.

### Lazy Glyph Loading: Future-Proofing For CJK And Very Large Fonts

v2 ships with **eager full-font loading**. The whole `Y.Doc` is loaded on
open, every connected client holds the full state, and snapshots are
full-font. This is correct for Latin/Cyrillic/Greek fonts of typical size
and keeps the existing `ChangeBridge` topology, scoped UndoManagers, and
compile fast paths working unchanged.

However CJK fonts can have 20k–60k glyphs and produce babelfont JSON in the
tens or hundreds of MB. Eager loading does not scale to that case. v2 must
leave a **migration path to lazy per-glyph loading** open without painting
itself into a corner. The plan:

**Decisions made now (v2 ships these even though full loading is the only
active mode):**

- The `glyphs` root is keyed by glyph name. That key is already the natural
  unit of laziness; switching to per-glyph subdocs later does not require
  reshaping the model the editor sees.
- All change-log entries already carry derived glyph names. The DO's event
  index in D1 is per-glyph from day one, so the server can answer "which
  glyphs changed since version N" without parsing Yjs.
- The bootstrap response separates **font-scope payload** (font, kerning,
  features, metrics defaults, glyph _index_ — names + widths + unicodes +
  layer ids only) from **glyph-scope payloads** (per-glyph layers, anchors,
  components, paths). v2's bootstrap currently inlines both, but the wire
  shape is `{ fontScope, glyphScope: { mode: 'inline-all' | 'on-demand',
glyphs?: ... } }`. v2 only emits `'inline-all'`. The `'on-demand'` mode
  is reserved.
- The editor's glyph overview already supports virtualized rendering.
  Anything that requires "all glyphs in memory simultaneously" — for
  example fontc compilation, full kerning resolution, or full export — is
  flagged in code as a **full-load operation** (a small audit pass, not a
  refactor) so the lazy path knows what to materialize on demand.
- Snapshots are split conceptually into a small **font snapshot** and a
  glyph-name-keyed snapshot directory. v2 stores them as one file each for
  simplicity (`snapshots/yjs/{version}.bin`,
  `snapshots/babelfont/{version}.json.br`), but the R2 layout reserves
  `snapshots/glyphs/{version}/{glyphName}.bin` for the lazy mode without
  schema changes.

**Decisions deferred to a future v3 (when CJK becomes a real requirement):**

- Move `glyphs.<name>` from sub-`Y.Map`s into Yjs **subdocs** (`Y.Doc`
  per glyph), loaded on demand by the editor and by the DO. The `glyphs`
  root in the parent doc holds only references plus the lightweight glyph
  index.
- Per-glyph subdocs let two users edit different glyphs without ever
  exchanging each other's update streams; presence and font-scope edits
  still flow through the parent doc.
- Per-glyph subdocs also unblock per-glyph snapshots in R2, which makes
  glyph restore O(one glyph blob) instead of O(full font).
- Scoped UndoManagers move from filtering predicates on the parent doc to
  per-subdoc managers. The current per-glyph and per-layer UndoManagers
  already operate on the natural sub-targets, so this is a localized
  change.
- Cross-glyph operations (rename, metrics-key dependents, automatic
  composition source resolution) load all involved glyph subdocs into
  memory for the duration of the transaction. The DO is the place that
  enforces this; clients can rely on the DO having the full set when it
  acks such transactions.

**Why not subdocs in v2:** subdocs require rewriting the existing scoped
undo wiring and complicate cross-scope operations like rename and
metrics-key dependencies _today_, before the editor itself is feature-
complete. Doing it now would slow editor work for a problem that does not
yet exist for the target users. Doing it later is feasible because the v2
bootstrap shape, event index, and snapshot layout are already glyph-keyed.

**Migration trigger and rollout:** when the first CJK pilot asset crosses a
threshold (initial proposal: ≥ 4000 glyphs OR ≥ 10 MB babelfont JSON), open
that asset in lazy mode. The DO's stored Yjs state for the asset is
rewritten in a one-shot migration job that splits glyph maps into subdocs;
the migration bumps `font_assets.yjs_doc_schema_version` and flips
`font_assets.load_mode` from `'eager'` to `'lazy'`, then writes a new
base snapshot. Older assets stay on `load_mode = 'eager'` until they too
cross the threshold or are explicitly migrated by an owner. The editor
negotiates which mode it must use during `auth` based on
`(yjs_doc_schema_version, load_mode)` returned in `auth-ok`.

## Yjs Origins And User Identity

The current editor uses string origins (`USER_EDIT_ORIGIN`,
`GLYPH_EDIT_ORIGIN`, `LAYER_EDIT_ORIGIN_PREFIX:<glyph>@@<layerId>`,
`HISTORY_REPLAY_ORIGIN`, `SYSTEM_REMOTE_ORIGIN`). v2 promotes origins to
structured objects when running in cloud mode:

```ts
type CloudOrigin = {
    kind:
        | "user-edit"
        | "glyph-edit"
        | "layer-edit"
        | "font-edit"
        | "restore"
        | "history-replay"
        | "remote";
    userId: string; // authenticated user
    clientId: string; // per-tab UUID
    seq: number; // monotonic per clientId
    txId: string; // ChangeBridge transaction id
    scope?: {
        glyph?: string;
        layerId?: string;
        master?: string;
        area?: "kerning" | "features" | "font-info";
    };
};
```

`UndoManager.trackedOrigins` is set per scope through a helper predicate that
accepts structured `CloudOrigin` objects where "`origin.userId === this user's
id` AND scope matches". The same helper also recognizes that scope's own local
UndoManager origin during undo/redo replay. This gives the v1 guarantee that a
user's Cmd+Z only undoes their own work, even when multiple windows are owned by
the same user. Multiple tabs of the same user share undo because the cloud
metadata matches `userId`, not `clientId`.

Remote update envelopes from the DO carry the original sender's `CloudOrigin`
as metadata for attribution, compile routing, and history indexing. The
receiver still applies the binary Yjs update inside `applyRemoteUpdate` with a
local `'remote'` origin so remote work is never tracked by any local
UndoManager.

## Wire Protocol (revised from v1)

Each frame is a small CBOR or MessagePack envelope. JSON is acceptable for
control frames; binary updates stay raw `Uint8Array`.

Client → DO:

| Type                 | Payload                                                                    |
| -------------------- | -------------------------------------------------------------------------- |
| `auth`               | `{ token, clientId, editorBuild, knownVersion? }`                          |
| `sync-request`       | `{ stateVector: bytes }`                                                   |
| `update`             | `{ seq, update: bytes, origin: CloudOrigin, changeLog: ChangeLogEntry[] }` |
| `awareness`          | `{ awarenessUpdate: bytes }`                                               |
| `checkpoint-request` | `{ label: string, meta?: { description?, color?, tags?, glyphs? } }`       |
| `ping`               | `{}`                                                                       |

DO → Client:

| Type            | Payload                                                                                 |
| --------------- | --------------------------------------------------------------------------------------- |
| `auth-ok`       | `{ roomVersion, serverClientId, snapshotVersion, loadMode, yjsDocSchemaVersion, role }` |
| `sync-response` | `{ update: bytes, roomVersion }` (single merged Yjs update)                             |
| `update`        | `{ seq, update, origin, changeLog, roomVersion, sender }`                               |
| `ack`           | `{ clientSeq, roomVersion, durable: bool }`                                             |
| `awareness`     | `{ awarenessUpdate }`                                                                   |
| `error`         | `{ code, message, retry? }`                                                             |
| `restore-event` | `{ scope, sourceVersion, summary }` (already applied as forward update)                 |

Acknowledgement model: there is **one** explicit ack per update — `ack`
with `durable: true` — emitted by the DO once the update has been written
to DO SQLite AND merged into the in-memory `Y.Doc`. The DO does not echo
the sender's own update back as a separate confirmation; the WebSocket
frame delivery is sufficient transport-level receipt. Editor's
"saving / saved" UI is driven exclusively by the durable ack.

Editor must show "unsaved cloud" until the durable ack is observed. v1
already said this; v2 makes it part of the wire protocol, not an
implementation detail.

## Persistence Cadence (the key question)

Persistence has three tiers. Each tier has a different write rate and a
different consumer.

### Tier 1 — Hot append log (DO SQLite, every accepted update)

Every accepted Yjs update is written into a single SQLite row inside the
Durable Object before the durable ack is sent:

```sql
CREATE TABLE room_log (
  room_version INTEGER PRIMARY KEY,
  client_id    TEXT NOT NULL,
  client_seq   INTEGER NOT NULL,
  user_id      TEXT NOT NULL,
  origin_kind  TEXT NOT NULL,
  scope_json   TEXT,
  change_log   BLOB,         -- compact summary, see history index
  update_blob  BLOB NOT NULL,
  created_at   INTEGER NOT NULL,
  UNIQUE(client_id, client_seq)
);
```

- Single-region, transactional, low latency (DO storage commits in a few ms).
- The `UNIQUE(client_id, client_seq)` constraint makes retries idempotent on
  reconnect — replaying a queued update is a no-op.
- Awareness frames are not logged.
- On WebSocket hibernation, only this table needs to be persistent; the
  in-memory `Y.Doc` is rebuilt from the latest snapshot plus this log on the
  next message.

### Tier 2 — Warm merged segments (R2, batched)

Roll a segment to R2 when any of these triggers fires:

- 256 logical updates accumulated since the last segment;
- 1 MB of accumulated `update_blob` bytes;
- 30 seconds of inactivity;
- explicit `checkpoint-request`.

A segment is the Yjs merge of those updates (`Y.mergeUpdates`) plus a small
JSON sidecar listing the contained `(client_id, client_seq, user_id,
scope_json, change_log_summary)` tuples. Once written to R2 and confirmed,
the corresponding `room_log` rows are pruned to keep DO SQLite bounded.

R2 keys:

```
fonts/{assetId}/segments/{startVersion}-{endVersion}.bin
fonts/{assetId}/segments/{startVersion}-{endVersion}.meta.json
```

### Tier 3 — Cold full snapshots (R2, semantic + safety)

Two snapshot kinds, both stored in R2:

- Yjs snapshot — `Y.encodeStateAsUpdate(yDoc)` of the full doc;
- babelfont JSON snapshot — Brotli-compressed JSON materialized from the same
  `Y.Doc` (the DO runs the same materialization the editor does today,
  imported as a shared module — same code path, same correctness).

Snapshots serve two distinct purposes with different optimal triggers:

**Semantic snapshots** — meaningful history points shown in the UI. These align
with natural work rhythms:

| Trigger                                                                                     | `kind`          | Notes                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Last live WebSocket closes while room is dirty (true disconnect, not hibernation)           | `session-end`   | Primary boundary. Captures the coherent state after a work session. Hibernation alone does not trigger this — the room version must have advanced since the previous snapshot. |
| First client connects after ≥ 15 min with no live WebSockets, AND room version has advanced | `session-start` | Bookmarks state _before_ the new session begins. Skipped if no edits have landed since the previous `session-end` — there is nothing new to record.                            |
| User creates a named version / milestone                                                    | `named`         | Most explicit semantic marker. User-labelled. Can carry custom metadata (see below).                                                                                           |
| Before any restore or destructive operation                                                 | `pre-op`        | Created server-side at the DO before the operation's forward update is broadcast. Stored as a Yjs snapshot only (no babelfont JSON materialization) — see below.               |

Semantic snapshots appear in the history UI. `session-end` and `session-start`
are auto-labelled with timestamp and connected-user list. `pre-op` snapshots are
shown only in the context of the operation that triggered them ("before this
restore").

`pre-op` snapshots are intentionally **Yjs-state only** (`yjs_state_ref`
populated, `babelfont_ref` left empty until first read). Materializing a
Brotli-compressed babelfont JSON for a 5k-glyph font can take seconds and
would visibly stall the user invoking the operation. The Yjs state is
sufficient to revert via a forward restore; the babelfont JSON is
materialized lazily on first inspection of that snapshot from the history
UI. All other snapshot kinds materialize both refs eagerly because they
are not on the user's interactive critical path.

### Named Milestones

A named milestone is a user-defined snapshot with a label and optional
structured metadata. It is the primary answer to "I want to mark this point in
history as meaningful".

A milestone is created by any owner or editor by sending a
`checkpoint-request` with a `label` and optional `meta`. The DO takes a
full snapshot immediately, stores it as `kind = 'named'`, and records it in
`font_asset_versions`. The snapshot appears in the history UI with the
user-supplied label.

```ts
// checkpoint-request wire payload
{
  label: string;          // required for named milestones
  meta?: {
    description?: string;  // longer freeform note
    color?: string;        // optional hex color for timeline display
    tags?: string[];       // optional short labels, e.g. ['client-review', 'v2']
    glyphs?: string[];     // optional list of glyphs this milestone concerns
  };
}
```

`font_asset_versions` gains `label_color TEXT`, `description TEXT`, and
`tags_json TEXT` columns. The history UI shows milestones as colored markers
on a timeline, filterable by tag.

Milestones can be renamed, re-described, re-colored, or re-tagged after the
fact by owners via a control-plane API call
(`PATCH /api/cloud/assets/:id/versions/:versionId`). These calls only update
D1 metadata; the stored snapshot blob is never touched.

### Milestone Visibility And "Deletion"

A milestone and its underlying snapshot are two separate things:

- The **snapshot** (Yjs state + babelfont JSON in R2) is a technical artifact
  needed for cold-start recovery, restore operations, and history replay. It
  should not be deleted just because the user no longer considers that point
  meaningful.
- The **milestone label** is metadata that makes the snapshot visible and
  named in the history UI.

Users who "delete" a milestone are expressing "this point is no longer a
meaningful marker", not "destroy the underlying data". The correct behavior
is therefore:

- "Delete milestone" demotes `kind` from `'named'` to `'recovery'` in D1.
  The snapshot blob in R2 is retained under normal `recovery` retention
  (7 days), then pruned like any other recovery snapshot.
- The milestone disappears from the history UI immediately.
- The snapshot is still usable as a restore point during its retention
  window, but it is no longer presented as a user-labelled point.
- If the user wants it gone from restore options too, that is a separate
  "delete snapshot" action, restricted to owners only, which hard-deletes
  the R2 blob and D1 row. The UI should make this distinction clear:
  "Hide from history" vs "Delete snapshot data".

This is also the right mental model for the scenario of keeping small
changes: a user marking a glyph as "done", then continuing to adjust it,
can just hide the premature milestone. The edit history is continuous and
undisturbed; only the label disappears. They can create a new milestone
when they are genuinely satisfied.

Editors can hide (demote) milestones they created. Owners can hide or hard-
delete any milestone. Neither action requires involvement of the Durable
Object — both are pure control-plane D1 writes via
`PATCH /api/cloud/assets/:id/versions/:versionId`.

### Configurable Automatic Triggers

The automatic `session-end` / `session-start` logic is always on and is not
configurable — it is the safety behavior, not a product preference. However
owners can configure **additional** automatic trigger rules at the asset level.
These are stored in a `font_assets.snapshot_rules_json` column as a small JSON
array; the DO reads them on room open.

Supported rule kinds for v2:

```jsonc
[
    // Take a named snapshot after every N accepted logical updates
    { "kind": "on-update-count", "every": 500, "label": "auto checkpoint" },

    // Take a named snapshot after N minutes of inactivity within a session
    {
        "kind": "on-inactivity",
        "afterMinutes": 30,
        "label": "30-min checkpoint",
    },

    // Take a snapshot whenever an accepted update touches a specific glyph
    // (or any glyph in a list)
    {
        "kind": "on-glyph-save",
        "glyphs": ["A", "a", "zero"],
        "label": "key glyph saved",
    },
]
```

Rule-triggered snapshots are `kind = 'named'` (not `recovery`) and appear in
the history UI with the configured label plus an auto-suffix of the room
version, e.g. `"auto checkpoint @ v1042"`.

No rules are configured by default. This keeps the default behavior simple:
only session boundaries and explicit user actions create named snapshots.

Rule evaluation happens server-side in the DO. The client is not involved
except that `on-glyph-save` requires `changeLog` entries with `scope.glyph`
to be present on incoming updates (which they already are). Adding or removing
rules takes effect on the next room open (the DO reloads them from D1 on
connect).

**Recovery-safety snapshots** — not meaningful history points, not shown in the
main history UI. Their only purpose is to bound cold-start replay time. If the
DO restarts with only a very old semantic snapshot on record, replaying thousands
of segments to reach the present is slow. Recovery snapshots cap that tail:

| Trigger                                                                   | `kind`     | Notes                                                                                                  |
| ------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------ |
| Every 4 segment rolls without a session-end snapshot (≈ 1024 updates)     | `recovery` | Keeps cold-start replay bounded to ≤ 4 segments, or roughly 1024 updates, on top of the last snapshot. |
| 30 minutes of continuous editing without a session-end                    | `recovery` | Fallback for extremely long uninterrupted sessions (e.g. all-day open tab).                            |
| UTC midnight, if edits happened that day and no `session-end` was written | `recovery` | Safety net for rooms that are never fully closed.                                                      |

Recovery snapshots are stored and retained normally; they simply have a
different `kind` so the history UI can omit them from the activity feed while
still making them available for cold-start and for restore operations.

Explicit control-plane operations — duplicate, transfer, archive — also trigger
a full snapshot regardless of kind, using `kind = 'explicit'`.

R2 keys:

```
fonts/{assetId}/snapshots/yjs/{version}.bin
fonts/{assetId}/snapshots/babelfont/{version}.json.br
```

### What lives in D1 (and what does not)

D1 is the metadata + searchable index. Per-update writes do not go to D1.

D1 receives:

- `font_asset_versions` rows: one row per snapshot or named version, with
  `yjs_state_ref`, `babelfont_ref`, `kind` (`session-end` |
  `session-start` | `named` | `pre-op` | `recovery` | `explicit` |
  `import` | `migration`), `actor_user_id`, `label`, `summary_json`,
  `created_at`;
- `font_asset_events` rows: one row per logical transaction at write-through
  granularity. The DO batches these — it inserts a single multi-row
  statement at segment-roll time, not per update — so D1 hot-write pressure
  is bounded by segment cadence, not edit cadence;
- the existing tables from v1 (`cloud_folders`, `font_assets`,
  `font_asset_members`, `font_asset_invitations`).

`font_asset_events` columns are deliberately compact (no binary update):

```
asset_id, room_version, actor_user_id, event_type,
scope_kind   ('font' | 'glyph' | 'layer' | 'kerning' | 'features' | 'font-info'),
glyph_name, layer_id, master_id,
summary      (short string, e.g. "moved 4 nodes", "kerning A/V += 5"),
created_at
```

This is the table the History UI queries. It scales well in D1 because it is
append-only with index `(asset_id, created_at)` and `(asset_id, scope_kind,
glyph_name)`.

### Rationale For The Tiered Design

- **Tier 1 (per-update DO SQLite)** is the safety floor. Every accepted update
  is durable before the ack. Without this, a crash between segment rolls loses
  edits silently.
- **Tier 2 segments** (256 updates / 1 MB / 30 s inactivity) are a mechanical
  batching layer. Their thresholds cap DO SQLite size and R2 object count; they
  carry no semantic meaning. The inactivity trigger (30 s of no new updates) is
  also the earliest practical signal that a user has paused, making it a cheap
  segment-flush point without waiting for a full session end.
- **Tier 3 semantic snapshots** (session-end / session-start / named / pre-op)
  are the primary history record and the reason users can trust the history UI
  to show meaningful before/after states rather than arbitrary cut points.
- **Tier 3 recovery snapshots** exist purely to cap cold-start replay time.
  "Every 4 segment rolls" means the DO never has to replay more than ~1024
  updates on top of a recent snapshot. The session-end snapshot already achieves
  this naturally for any room that is regularly closed; recovery snapshots only
  matter for rooms left open for many hours without a clean disconnection.
- **D1 batched insert at segment-roll** keeps D1 transactional cost bounded: at
  most one batched write per ~30 s of activity per room, well within D1's write
  budget.

## History, Replay, And Revert

Three concepts. Keep them separated in the UI and in code.

### Personal undo

- Each user undoes only their own changes via the scoped UndoManager predicate
  described above.
- Multi-tab same-user windows share undo via shared `userId` in cloud origin
  metadata.
- Undo emits a normal forward Yjs update. Yjs itself uses the UndoManager
  instance as the local transaction origin for undo/redo, so the cloud sender
  wraps the outbound envelope with `CloudOrigin.kind = 'history-replay'`, the
  undoing `userId`, and the original scope. Other users see it as a new edit by
  the undoing user, but their UndoManagers apply it with a remote origin and
  never add it to their local stacks.
- Undo never crosses scope: a font-level undo manager does not touch glyph
  text, etc. This is already the editor's behavior; v2 just keeps it.

### Owner/editor restore

Restore is a deliberate forward write derived from a stored snapshot or
event range. It is **not** Yjs undo and never rewrites history.

Scopes supported in v2:

| Scope            | Source                                           | Who can do it |
| ---------------- | ------------------------------------------------ | ------------- |
| Whole font       | any past snapshot or named version               | owner         |
| Single glyph     | snapshot containing that glyph                   | owner, editor |
| Single layer     | snapshot, identified by stable layer id          | owner, editor |
| Kerning (master) | snapshot for that master                         | owner         |
| Kerning (all)    | snapshot                                         | owner         |
| Features         | snapshot                                         | owner         |
| Font info / axes | named version only (not arbitrary point-in-time) | owner         |

Implementation: the DO loads the chosen snapshot, extracts the babelfont JSON
sub-tree for the requested scope, and applies it through the existing
`ChangeBridge` scoped-apply path inside a single Yjs transaction with
`origin = { kind: 'restore', userId, sourceVersion, scope }`. That
transaction:

- becomes a single forward update broadcast to all connected clients;
- is recorded as a `font_asset_events` row of type `restore`, with
  `actor_user_id` set to the user who invoked the restore (not the user
  who authored the source snapshot);
- creates a `pre-op` snapshot automatically labeled
  `before-restore-{version}` to make the restore itself reversible by another
  restore. This restore point is shown in the restore surface, but it is not a
  user-created `named` milestone.

Editors restoring whole-font is intentionally disallowed in v2; if an editor
wants that, the owner does it. Editors can restore glyphs and layers because
their normal edit rights already cover those scopes; restore is just a
faster path than redrawing.

Axes/masters/instances are not restorable to arbitrary points in v2 because
partial restore there breaks layer compatibility, kerning keys, and
interpolation. Whole-font named-version restore covers that case safely.

### Replay and time travel

Replay is the inspection UI. It reads from `font_asset_events` plus
snapshots; raw segments are only fetched on demand.

User-facing views:

- **Activity feed** per asset: chronological events with actor, scope,
  glyph, label.
- **Glyph history**: filter `font_asset_events` by `glyph_name`. Each entry
  links to the snapshot that contains the pre-edit and post-edit state for
  that glyph, computed at snapshot time.
- **Kerning history**: filter by `scope_kind = 'kerning'` plus optional
  master.
- **Named versions**: list `font_asset_versions` where `kind = 'named'`.

For "show me glyph A as of yesterday": find the most recent snapshot ≤ that
timestamp, decode the babelfont JSON, extract glyph A. Apply newer events
filtered by `glyph_name = 'A'` if precision below snapshot cadence is
required (rare; in practice "snapshot precision" is enough for review).

Raw segment-level Yjs replay is kept available as an admin/debug tool for
recovery, not as a normal user-facing feature.

## Concurrent Kerning And Outline Editing

This is the most font-specific concurrency case and the one users will hit.

Guarantees:

- `glyphs.A.layers.<id>` and `kerning.<masterId>` are independent `Y.Map`s.
  Yjs merges them with no semantic conflict.
- Each user's kerning UndoManager tracks only origins with
  `scope.area === 'kerning'` AND matching `userId`. Each user's outline
  UndoManager tracks only origins with `scope.glyph === <name>` AND matching
  `userId`. Therefore Cmd+Z while kerning A/V never reverts another user's
  outline edit on `A`, and vice versa.
- Restore-glyph never silently restores kerning. If the restore target's
  babelfont JSON has different kerning groups for that glyph, the restore
  surface warns: "Restoring `A` will change its kerning group from `@A` to
  `@A_alt`. Apply group change? Yes / No / Cancel". This is the only place
  glyph restore touches kerning.
- Restore-kerning(master) does not touch glyph outlines.

Soft locks (presence-only, not enforced):

- awareness frames carry `currentGlyph`, `currentLayer`, `currentArea`
  (`outline | metrics | kerning | features | font-info`);
- the editor surfaces "Yanone is editing outline of `A`" and dims the toolbar
  for that glyph if another user is actively editing it, but does not block
  the local user;
- no hard locks in v2. They are easy to add later as a per-asset setting.

## Offline, Reconnect, And Idempotency

### Offline capability scope in v2

v2 distinguishes three offline scenarios with different answers:

**1. Cold-start offline — not supported.** Opening a cloud font requires, in
order: a valid session cookie, a room-token API call to the Pages control
plane, and fetching the bootstrap snapshot. All three steps need network access.
The PWA service worker caches only the app shell (JS, CSS, WASM); it does not
cache per-asset font data. A user who opens the PWA with no connection and
tries to open a cloud font will see "Cannot connect — please check your
connection." If they need to work fully offline, they should use the Memory
or Disk filesystem plugin with a local file instead.

**2. In-session disconnect — handled gracefully, do not freeze edits.** When
the WebSocket drops mid-session, the editor continues to accept and apply
local edits exactly as if it were in single-user mode. The Yjs document is
local-first: the in-memory `Y.Doc` is the user's working copy, and the
WebSocket is the sync pipe, not the data source. Freezing edits on disconnect
would be catastrophic UX — a network blip during a point drag would lock the
canvas mid-gesture. Google Docs uses the same approach: it queues locally and
syncs when reconnected; it only blocks navigation away, not in-place editing.

The editor's "unsaved cloud" indicator tracks disconnect duration:

| Duration          | UI treatment                                              |
| ----------------- | --------------------------------------------------------- |
| 0–5 s             | No change. Brief blips are invisible to the user.         |
| 5 s – 2 min       | Subtle "reconnecting" spinner in the toolbar status area. |
| > 2 min           | Amber "N edits not yet saved to cloud" warning badge.     |
| Tab close attempt | Browser `beforeunload` dialog: "N edits have not reached  |
|                   | the server. Close anyway?" (Standard browser API; only    |
|                   | fires on intentional close/reload, not on crash.)         |

**3. Extended offline in a live session — queue in memory, acknowledge the
risk.** The in-memory queue is unbounded in v2. A user who edits for several
hours without network access will accumulate a large queue; if the tab crashes
or is hard-reloaded before reconnect, all queued edits are lost. This is
unavoidable without client-side persistent storage (see v3 note below). The
"N edits not yet saved" indicator and the `beforeunload` dialog are the
primary safeguards. v2 imposes no forced freeze after a time limit, but the
UX should make the risk legible.

**v3 offline-first path (not in v2).** Full offline capability — open a
cloud font, edit for days without network, sync on next connect — requires:
persisting the Yjs state between page loads (IndexedDB or OPFS), deferring
the room-token/bootstrap sequence until a connection is available, and
handling the case where the offline author's state vector has diverged far
enough that a full `force-rebase` is needed. This is feasible but adds
significant complexity and is deferred until there is demonstrated demand
from users who regularly work offline with cloud fonts.

### Reconnect protocol

- The editor queues outgoing `update` frames in memory while disconnected,
  preserving their `(clientId, seq, origin, changeLog)`. The queue is
  in-memory only; a tab crash or hard reload loses unflushed offline edits
  and assigns a new `clientId` on next load. "Durable" only means
  durable on the server, not crash-resilient on the client.
- On reconnect the editor sends `auth` then `sync-request` with its current
  state vector. The DO replies with `sync-response` containing the merged
  diff update for everything past that vector, then accepts the editor's
  queued updates. The DO drops any `(clientId, seq)` it has already seen
  thanks to the `UNIQUE` constraint, so in-process retries (network blip,
  reconnect of the same tab) are idempotent without client-side
  bookkeeping.
- If the WebSocket has been hibernating but never disconnected, the same
  flow works: the DO wakes, rehydrates from the latest snapshot + log, and
  resumes.
- If the editor was offline long enough that retention compacted segments
  past its state vector, the DO sends a full `sync-response` plus a
  `force-rebase` notice. The editor treats this like opening the asset
  fresh.
- All editor edits made while offline keep their original origin's
  `userId`; they are tagged offline-authored only by their creation
  timestamp. They are still attributable on replay.

## Compile And Worker Integration

Cloud-applied remote updates must not regress the editor's compile fast
paths. The same rules from `developer-docs/COMPILATION_EDIT_POLICY.md`
apply. Specifically:

- remote updates carry `changeLog` summaries with `touchedPaths`, derived
  glyph names, layer IDs, undo scope, and replay targets, identical in shape
  to local change-log entries today;
- the cloud receiver feeds those into `ChangeBridge.applyRemoteUpdate` with
  the exact same code path used by `WindowSync`, so worker cache replay
  targets, anchor/component dependent rebuilds, and full-sync fallback
  triggers all keep working;
- remote updates use the same active-drag-deferral rules: if a local drag is
  in progress, remote updates are queued and applied at the editor's
  existing safe boundary, not mid-drag. This avoids the "remote layer
  arrives during my drag" class of bugs already documented in repo memory;
- restore operations always carry full replay targets for affected glyphs
  and force a full-font compile when the scope is whole-font, kerning(all),
  features, or font-info.

The DO itself imports the same babelfont materialization module the editor
uses, so server-side snapshot JSON is bit-identical to what the editor would
produce locally.

## Schema And Server-Side Migration

The editor is not feature-complete. The babelfont JSON shape, the
`change-log` entry shape, and the Yjs subtree layout will change again
before launch and may keep changing after. v2 must therefore plan, from day
one, for how server-side and client-side updates land without corrupting
live rooms or stored assets.

### Versioning Surfaces

Three independent versions are tracked:

- `babelfont_schema_version` — the shape of the babelfont JSON. Stored on
  every snapshot row and on `font_assets.schema_version`.
- `yjs_doc_schema_version` — the shape of the Yjs subtree layout (eager vs
  lazy, glyph-keyed vs subdoc, etc.). Stored on `font_assets`.
- `wire_protocol_version` — the message envelope and message types between
  editor and DO. Negotiated at `auth` time.

Each editor build advertises a **range of supported versions per surface**,
not a single version. Each DO does the same. The `auth` handshake selects
the highest mutually supported version per surface, or rejects with
`error: { code: 'reload-required', minBuild }`, which the editor surfaces
as "please reload to get the latest editor".

### Pre-Launch (today, while the editor is in development)

- It is acceptable to **terminate live rooms** when a breaking schema or
  protocol change ships. The reload path is: DO closes connections with
  `reload-required`, editor surfaces a toast and reconnects after a hard
  reload.
- Asset migration runs as a one-shot job per asset on next open: load the
  latest snapshot, transform JSON in-process via a registered
  `babelfontMigrations[from → to]` function, write a new snapshot, bump
  `schema_version`, then accept connections at the new version.
- The migration registry lives in a shared module imported by both editor
  and DO so each transform is written once.
- Active rooms are drained before migration. Pre-launch this is fine
  because there are few simultaneous editors and downtime is acceptable.

Flag this period explicitly: set `config.preLaunchMigrationMode = true` in
the DO Worker. In that mode the DO may close rooms with `reload-required`
and may write the migrated snapshot inline rather than via the
dual-version window described below. Each pre-launch migration is recorded
in `font_asset_versions` as `kind = 'migration'` so the audit trail
survives.

Flipping `preLaunchMigrationMode` to `false` is itself a deployment
milestone. After that, any breaking change must follow the post-launch
dual-version process.

### Post-Launch (zero-interruption requirement)

Once real users are on the platform, breaking changes must not visibly
interrupt active editing.

1. **Additive changes are the default.** New babelfont fields, new
   change-log fields, and new wire-protocol message types are added with
   sensible defaults so older clients ignore them and newer clients fill
   them in. Most editor evolution is expected to be additive.

2. **Breaking changes ship behind a dual-version window.**
    - Step 1: editor build N+1 supports both the old and the new shape on
      read. It still writes the old shape. Both versions remain in use.
    - Step 2: build N+2 writes the new shape but still reads the old. The
      DO migrates assets opportunistically on next snapshot.
    - Step 3: when telemetry shows no remaining old-shape snapshots on
      active assets, build N+3 drops old-shape support. Cold-stored
      snapshots are migrated lazily on first access.
    - Each step ships independently; no step interrupts an active room.

3. **Live-room rolling upgrade.** A DO restart on deployment is
   unavoidable on Cloudflare. The DO mitigates by persisting state
   (snapshot + log) before accepting any new updates after deploy and
   resuming connections via the editor's automatic reconnect using state
   vectors. Editors see at most a brief "reconnecting" indicator. No edit
   is lost because every accepted edit was already in DO SQLite or queued
   client-side under its `(clientId, seq)` key. The
   `UNIQUE(client_id, client_seq)` constraint makes any reapplication
   idempotent.

4. **Mismatched editor builds in the same room.** Two users on different
   editor builds can share a room only if their advertised version
   ranges overlap. If user B's editor is older than the DO's minimum,
   the DO rejects B's connection with `reload-required`. The DO never
   downgrades the doc to keep an old client alive.

5. **Snapshot-time migration is the only place JSON is rewritten.** Live
   Yjs updates are never rewritten in flight. Migrations run when a
   snapshot is being materialized, in the same code path that creates
   snapshots normally, so there is exactly one transform site to test.

### Migration Testing

- Each `babelfontMigrations[from → to]` function ships with golden-pair
  fixtures (input JSON, expected output JSON).
- A nightly Worker walks a sample of stored assets, runs the full
  migration chain in a shadow process, and diffs against the live
  snapshot. Differences trigger an alert before the migration is enabled
  in production.
- The Playwright matrix includes "old-build editor connecting to new-build
  DO" and the reverse, with the expected handshake outcomes.

## D1 Schema Additions

Same intent as v1, with the cadence-aware `font_asset_events` and explicit
versioning columns:

```sql
CREATE TABLE cloud_folders (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  parent_folder_id TEXT,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  archived_at INTEGER
);

CREATE TABLE font_assets (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  current_room_version INTEGER NOT NULL DEFAULT 0,
  current_yjs_state_ref TEXT,
  current_babelfont_ref TEXT,
  babelfont_schema_version INTEGER NOT NULL DEFAULT 1,
  yjs_doc_schema_version INTEGER NOT NULL DEFAULT 1,
  glyph_count INTEGER NOT NULL DEFAULT 0,
  load_mode TEXT NOT NULL DEFAULT 'eager'
    CHECK (load_mode IN ('eager','lazy')),
  snapshot_rules_json TEXT,      -- JSON array of configurable trigger rules; NULL = no extra rules
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER
);

-- Per-user filing of an asset into one of that user's folders.
-- A row exists for every (user, accessible asset) pair; folder_id NULL
-- means "in the user's flat library, not in any folder".
CREATE TABLE cloud_folder_entries (
  user_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  folder_id TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, asset_id)
);
CREATE INDEX cloud_folder_entries_by_folder
  ON cloud_folder_entries(user_id, folder_id);

CREATE TABLE font_asset_members (
  asset_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
  invited_by_user_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (asset_id, user_id)
);

CREATE TABLE font_asset_invitations (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  invited_by_user_id TEXT NOT NULL,
  claimed_by_user_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  accepted_at INTEGER,
  revoked_at INTEGER
);

CREATE TABLE font_asset_versions (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  room_version INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'session-end',    -- last client disconnects (primary semantic)
    'session-start',  -- first client connects after 15 min idle
    'named',          -- user-created named version
    'pre-op',         -- automatic, before restore or destructive op
    'recovery',       -- safety bound: every 4 segments or 30 min continuous
    'explicit',       -- duplicate, transfer, archive control-plane ops
    'import',         -- initial upload / save-as from non-cloud font
    'migration'       -- schema migration (pre-launch mode only)
  )),
  actor_user_id TEXT,
  label TEXT,
  summary_json TEXT,             -- optional structured summary for history UI
  description TEXT,              -- optional longer note (from milestone meta)
  label_color TEXT,              -- optional hex color tag (from milestone meta)
  tags_json TEXT,                -- optional JSON array of short string tags
  yjs_state_ref TEXT NOT NULL,
  babelfont_ref TEXT NOT NULL,
  prior_version_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX font_asset_versions_by_asset_room_version
  ON font_asset_versions(asset_id, room_version);

-- Per-user cloud hosting override. A row with revoked_at IS NULL grants access.
-- No quota columns in v2; getMaxFontsOwned and getSnapshotRetentionDays return
-- null (unlimited) regardless of override state until tiers are defined.
CREATE TABLE user_cloud_overrides (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  granted_by_user_id TEXT NOT NULL,
  note TEXT,
  revoked_at INTEGER,
  revoked_by_user_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (granted_by_user_id) REFERENCES users(id)
);
CREATE INDEX user_cloud_overrides_by_user
  ON user_cloud_overrides(user_id, revoked_at);

CREATE TABLE font_asset_events (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  room_version INTEGER NOT NULL,
  actor_user_id TEXT,
  event_type TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  glyph_name TEXT,
  layer_id TEXT,
  master_id TEXT,
  summary TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX font_asset_events_by_asset_time
  ON font_asset_events(asset_id, created_at);
CREATE INDEX font_asset_events_by_glyph
  ON font_asset_events(asset_id, glyph_name, created_at);
CREATE INDEX font_asset_events_by_scope
  ON font_asset_events(asset_id, scope_kind, created_at);
```

## Retention And Compaction

| Object                                    | Retain                                                        |
| ----------------------------------------- | ------------------------------------------------------------- |
| DO SQLite `room_log`                      | until covered by a flushed segment                            |
| Warm segments in R2                       | 30 days, then compact into next snapshot                      |
| `session-end` / `session-start` snapshots | 90 days                                                       |
| `recovery` snapshots                      | 7 days (not shown in history UI)                              |
| `named` versions                          | until hidden (demoted to `recovery`) or hard-deleted by owner |
| `pre-op` snapshots                        | 90 days minimum                                               |
| `explicit` snapshots (duplicate etc.)     | 90 days                                                       |
| Pending invitations                       | 30 days, then auto-revoked                                    |

A scheduled Worker (separate from Pages) runs nightly compaction. It cannot
live in the Pages project because Pages does not support cron triggers.

## Local Development Setup

All server components can be developed and tested locally using Cloudflare's
`wrangler` CLI. No Cloudflare account access is required until you need real
multi-machine sessions or want to invite an external collaborator.

### Component emulation

| Component                    | Local equivalent                      | Notes                                                           |
| ---------------------------- | ------------------------------------- | --------------------------------------------------------------- |
| Worker + Durable Object      | `wrangler dev`                        | Full DO lifecycle including WebSocket hibernation               |
| DO SQLite storage            | Local SQLite file managed by wrangler | `ctx.storage.sql` works identically                             |
| D1                           | `wrangler d1 execute --local`         | Identical SQL dialect; local file under `.wrangler/state/`      |
| R2                           | Local filesystem mock                 | Transparent to Worker code; no bucket needed                    |
| Pages + Functions            | `wrangler pages dev`                  | Runs the full API route layer including auth middleware         |
| Service binding (Pages → DO) | Local inter-process binding           | Both wrangler instances discover each other via `wrangler.toml` |

### Dev server wiring

Three processes run concurrently during local development:

1. **`cf-fonts-room` Worker** — `wrangler dev` in `cf-fonts-room/` on port 8787.
   Binds the `FontRoomDO` class and exposes the WebSocket endpoint.

2. **Pages project** — `wrangler pages dev` in the repo root, with a service
   binding pointing at the local Worker on port 8787. Handles all
   `/api/cloud/*` HTTP routes.

3. **Editor dev server** — `npm run dev` in `webapp/`, already running on
   `https://localhost:8000`. Point `CLOUD_API_BASE` in the editor's dev config
   at the local Pages instance (default `http://localhost:8788`).

`wrangler.toml` in `cf-fonts-room/` declares the DO class, SQLite binding, and
R2 binding. The Pages project's `wrangler.toml` (or `wrangler.pages.toml`)
declares the service binding to the room Worker. Both files need a
`[dev]` block that sets local ports to avoid conflicts with the editor dev
server.

### D1 local setup

Run D1 migrations locally before first use:

```bash
wrangler d1 execute DB --local --file=migrations/0001_cloud_schema.sql
```

The local D1 database is a SQLite file under `.wrangler/state/v3/d1/`. It is
gitignored and can be reset at any time by deleting that directory.

### When a real Cloudflare deployment is needed

Local emulation covers Phases 0–2 entirely. A deployed environment becomes
useful when:

- testing actual multi-user sessions across different machines or networks;
- validating DO hibernation cold-start latency under real Cloudflare
  infrastructure (local wrangler does not simulate hibernation wake latency);
- inviting an external collaborator for Phase 3 sharing flows;
- Phase 5 soak testing under real network conditions.

The existing `release.sh` / GitHub Actions pipeline deploys the Pages project.
The `cf-fonts-room` Worker deploys via `wrangler deploy` from its directory,
or as a step added to the same CI workflow.

## Implementation Phases

### Phase 0 — Skeleton (no real users)

- [ ] Add Worker + DO class `FontRoomDO` with hibernation and DO SQLite storage.
- [ ] Add Pages route `POST /api/cloud/assets/:id/room-token` returning a signed
      JWT. Authorization stub returns `editor` for any logged-in user.
- [ ] Add minimal DO endpoints: `auth`, `sync-request`, `update`, `ack`. No
      segments, no snapshots, no restore. Just live mirroring with append log.
- [ ] Verify two browsers converge on a real font.

### Phase 1 — Cloud filesystem plugin and asset CRUD

- [ ] D1 migrations for `cloud_folders`, `font_assets`, `font_asset_members`,
      `font_asset_invitations`.
- [ ] D1 migration for `user_cloud_overrides`; add `POST /api/admin/cloud/override`
      (grant/revoke) and expose the Cloud Hosting panel in the admin dashboard.
- [ ] `GET /api/cloud/eligibility` endpoint backed by `utils/cloud-entitlements.js`
      (`isCloudHostingEnabled`, `getMaxFontsOwned`, `getSnapshotRetentionDays`).
- [ ] Pages routes `/api/cloud/folders` and `/api/cloud/assets` with full
      ACL checks using the existing auth middleware and `findUserByIdOrEmail`.
      `POST /api/cloud/assets` re-checks `isCloudHostingEnabled` before creating
      the asset row.
- [ ] Editor `CloudPlugin` and `CloudAdapter` matching the existing
      `FileSystemAdapter` contract. On init the plugin calls `GET /api/cloud/eligibility`
      and hides itself if `cloudHostingEnabled` is false. Open returns
      `{ assetId, role, roomEndpoint, roomToken, bootstrap }`.
- [ ] Save-as for non-cloud fonts (creates an asset and seeds the DO).
- [ ] Authorization in `room-token` endpoint actually checks
      `font_asset_members`.

### Phase 2 — Persistence cadence and snapshots

- [ ] DO writes `room_log` per accepted update (Tier 1).
- [ ] Segment roll on the documented thresholds, write to R2, prune log
      (Tier 2).
- [ ] Auto Yjs + babelfont snapshots on the documented thresholds (Tier 3).
- [ ] D1 batched inserts of `font_asset_events` at segment-roll time.
- [ ] Cold-start: load latest snapshot + replay log/segments past it.
- [ ] Editor `unsaved cloud` UI driven by `durable: true` ack.

### Phase 3 — Sharing UI and invitations

- [ ] Pages `POST /api/cloud/assets/:id/share` with email resolution.
- [ ] Pending invitation claim on signup/login.
- [ ] Dashboard UI for share/role management.
- [ ] Viewer-only WebSocket flow that rejects `update` frames with
      `error: 'role'`.

### Phase 4 — History UI and restore

- [ ] Activity feed, glyph history, kerning history backed by
      `font_asset_events`.
- [ ] Named versions UI (create, label, restore).
- [ ] Whole-font restore (owner), then glyph and layer restore (owner +
      editor), then kerning and features restore (owner).
- [ ] Each restore writes a `before-restore` `pre-op` restore point automatically.

### Phase 5 — Hardening and observability

- [ ] Per-room rate limits, payload caps, build-version compatibility checks.
- [ ] Reconnect via state vector; idempotent retry validated by the
      `UNIQUE(client_id, client_seq)` constraint.
- [ ] Metrics: durable ack latency p50/p95/p99, segment roll bytes/duration,
      snapshot duration, room cold-start time, concurrent connections per room,
      edits per minute per room.
- [ ] Scheduled compaction Worker.
- [ ] Soak: 10k-edit session, large font (5k glyphs), simultaneous outline +
      kerning, two users with reconnect storms.

## Open Decisions Carried Forward

- Whether to ship the public-link viewer flow in v2 or defer.
- Whether named versions auto-create at UTC day boundaries or only on
  explicit user action plus snapshot cadence (current bias: only explicit
  plus the existing automatic snapshots that happen to land near a day
  boundary).
- Whether to expose segment-level fine replay in the UI at all, or keep it
  admin-only.
- Whether kerning permission and outline permission should ever decouple per
  user (current bias: no, role is sufficient; complexity not justified).
- Hard locks on glyph editing: out of scope for v2.
- Exact glyph-count / size threshold that flips an asset into lazy load
  mode (current proposal: ≥ 4000 glyphs OR ≥ 10 MB babelfont JSON, revisit
  with the first CJK pilot).
- Whether invited users should also see the **owner's folder name** as a
  passive label on each asset card (read-only hint), or whether the owner's
  folder structure should remain fully invisible to invitees.

## Acceptance Criteria For v2

A v2 is "done" when, on Cloudflare:

- two authenticated users can open the same cloud font from the cloud
  filesystem plugin, edit different glyphs and kerning concurrently, see each
  other's presence, and converge;
- each user's Cmd+Z only undoes their own edits, even within the same scope;
- closing the room and reopening 24 hours later restores in under 2 s for a
  typical font from the latest snapshot plus a short log tail;
- an owner can create a named version, change the font further, and restore
  one glyph from that version, observing the restore on the other user's
  screen as a forward operation, with a `before-restore` restore point
  available for one-click reversal;
- a viewer-role user cannot send document updates (the DO drops any
  `update` frame from a connection pinned to `role = 'viewer'` and replies
  with `error: { code: 'role' }`);
- compile budgets and worker replay paths are unchanged from local-only
  editing in the existing benchmarks.

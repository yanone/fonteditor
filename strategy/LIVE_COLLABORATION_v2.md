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
- WebSocket hibernation and cost shape.

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

Future filesystem-sync (Dropbox/Drive style) preparation:

- folders and assets carry stable IDs and monotonic `revision` counters
  independent of name/path;
- a separate `cloud_sync_links` table is reserved (not implemented in v2) to
  map external-provider paths to `(asset_id, folder_id, last_known_revision)`;
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

## Yjs Document Shape

One root `Y.Doc` per asset, structured so scoped UndoManagers and per-glyph
history work without subdocs:

```
yDoc
├─ font:         Y.Map   // family name, axes, masters, instances, info,
│                         // features (top-level), metrics defaults
├─ glyphs:       Y.Map<glyphName, Y.Map>
│                         // each glyph value is a Y.Map with `layers`,
│                         // `unicodes`, `metricsKeys`, `anchors-default`,
│                         // `components` etc., as today
├─ kerning:      Y.Map<masterId, Y.Map<pairKey, number>>
├─ features:     Y.Map   // feature source blocks, classes, lookups
└─ meta:         Y.Map   // doc schema version, last actor, lastEditAt
```

This matches the current `ChangeBridge` topology — v2 does not reshape the
Yjs tree. The reason matters: per-glyph and per-layer UndoManagers already
target sub-`Y.Map`s of `glyphs.<name>`. Cloud collaboration is a transport
change, not a model change.

Rejected alternative: per-glyph Y.Doc subdocs. Subdocs would let us load
individual glyphs lazily and keep their update streams isolated, but they
require rewriting the existing scoped undo wiring and complicate cross-scope
operations like rename and metrics-key dependencies. Revisit only if asset
sizes prove this wrong.

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

`UndoManager.trackedOrigins` is set per scope to the predicate
"`origin.userId === this user's id` AND scope matches". This gives the v1
guarantee that a user's Cmd+Z only undoes their own work, even when multiple
windows are owned by the same user. Multiple tabs of the same user share
undo because the predicate matches `userId`, not `clientId`.

Remote updates from the DO arrive with the original sender's origin
preserved; the receiver applies them inside `applyRemoteUpdate` with a local
`'remote'` origin so they are never tracked by any local UndoManager.

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
| `checkpoint-request` | `{ label?: string }`                                                       |
| `ping`               | `{}`                                                                       |

DO → Client:

| Type            | Payload                                                                 |
| --------------- | ----------------------------------------------------------------------- |
| `auth-ok`       | `{ roomVersion, serverClientId, snapshotVersion }`                      |
| `sync-response` | `{ update: bytes, roomVersion }` (single merged Yjs update)             |
| `update`        | `{ seq, update, origin, changeLog, roomVersion, sender }`               |
| `ack`           | `{ clientSeq, roomVersion, durable: bool }`                             |
| `awareness`     | `{ awarenessUpdate }`                                                   |
| `error`         | `{ code, message, retry? }`                                             |
| `restore-event` | `{ scope, sourceVersion, summary }` (already applied as forward update) |

Two acknowledgements per update:

1. `received` (implicit on broadcast back to sender) — fast.
2. `durable: true` — emitted once the update has been written to DO SQLite
   AND merged into the in-memory `Y.Doc`. Editor's "saving / saved" UI is
   driven by this.

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

### Tier 3 — Cold full snapshots (R2, periodic + on-demand)

Two snapshot kinds, both stored in R2:

- Yjs snapshot — `Y.encodeStateAsUpdate(yDoc)` of the full doc;
- babelfont JSON snapshot — Brotli-compressed JSON materialized from the same
  `Y.Doc` (the DO runs the same materialization the editor does today,
  imported as a shared module — same code path, same correctness).

Cadence:

- automatic: every 1024 logical updates OR every 10 minutes of active editing
  OR on first idle after dirty state, whichever comes first;
- explicit: on named version, on duplicate, on transfer, on archive, on
  user-triggered "create version";
- guaranteed-recent: at least one snapshot per UTC day if any edits happened.

R2 keys:

```
fonts/{assetId}/snapshots/yjs/{version}.bin
fonts/{assetId}/snapshots/babelfont/{version}.json.br
```

### What lives in D1 (and what does not)

D1 is the metadata + searchable index. Per-update writes do not go to D1.

D1 receives:

- `font_asset_versions` rows: one row per snapshot or named version, with
  `yjs_state_ref`, `babelfont_ref`, `kind` (`auto` | `named` | `restore` |
  `import`), `actor_user_id`, `label`, `summary_json`, `created_at`;
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

### Why these numbers

- Per-update DO SQLite writes are cheap and avoid silent data loss between
  segment rolls; this is the safety floor.
- 256-update / 1 MB / 30 s segments keep R2 object counts and DO SQLite size
  modest for fonts edited for hours; a typical session of a few hundred
  meaningful transactions compacts into a handful of segments.
- 1024-update / 10-minute snapshots make cold-start of a long-edited room
  fast (load latest snapshot + ≤ 1024 updates) without snapshotting so often
  that R2 storage explodes for inactive rooms.
- D1 batched insert at segment-roll keeps D1 transactional cost roughly one
  insert per ~30 seconds of activity per room, which is well within D1's
  comfortable write rate.

## History, Replay, And Revert

Three concepts. Keep them separated in the UI and in code.

### Personal undo

- Each user undoes only their own changes (via `trackedOrigins` predicate
  matching `userId`).
- Multi-tab same-user windows share undo via shared `userId` in origin.
- Undo emits a normal forward Yjs update with origin `kind: 'user-edit'`
  (already true today). Other users see it as a new edit by the undoing
  user.
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
- is recorded as a `font_asset_events` row of type `restore`;
- creates a named version automatically labeled `before-restore-{version}`
  to make the restore itself reversible by another restore.

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

- The editor queues outgoing `update` frames in memory while disconnected,
  preserving their `(clientId, seq, origin, changeLog)`.
- On reconnect the editor sends `auth` then `sync-request` with its current
  state vector. The DO replies with `sync-response` containing the merged
  diff update for everything past that vector, then accepts the editor's
  queued updates. The DO drops any `(clientId, seq)` it has already seen
  thanks to the `UNIQUE` constraint, so the editor can retry safely without
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
  folder_id TEXT,
  name TEXT NOT NULL,
  current_room_version INTEGER NOT NULL DEFAULT 0,
  current_yjs_state_ref TEXT,
  current_babelfont_ref TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER
);

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
  kind TEXT NOT NULL CHECK (kind IN ('auto','named','restore','import','before-restore')),
  actor_user_id TEXT,
  label TEXT,
  yjs_state_ref TEXT NOT NULL,
  babelfont_ref TEXT NOT NULL,
  prior_version_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(asset_id, room_version)
);

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

| Object                   | Retain                                   |
| ------------------------ | ---------------------------------------- |
| DO SQLite `room_log`     | until covered by a flushed segment       |
| Warm segments in R2      | 30 days, then compact into next snapshot |
| Auto snapshots           | hourly: 7 days, daily: 90 days           |
| Named versions           | until owner deletes                      |
| Before-restore snapshots | 90 days minimum                          |
| Pending invitations      | 30 days, then auto-revoked               |

A scheduled Worker (separate from Pages) runs nightly compaction. It cannot
live in the Pages project because Pages does not support cron triggers.

## Implementation Phases

### Phase 0 — Skeleton (no real users)

- Add Worker + DO class `FontRoomDO` with hibernation and DO SQLite storage.
- Add Pages route `POST /api/cloud/assets/:id/room-token` returning a signed
  JWT. Authorization stub returns `editor` for any logged-in user.
- Add minimal DO endpoints: `auth`, `sync-request`, `update`, `ack`. No
  segments, no snapshots, no restore. Just live mirroring with append log.
- Verify two browsers converge on a real font.

### Phase 1 — Cloud filesystem plugin and asset CRUD

- D1 migrations for `cloud_folders`, `font_assets`, `font_asset_members`,
  `font_asset_invitations`.
- Pages routes `/api/cloud/folders` and `/api/cloud/assets` with full
  ACL checks using the existing auth middleware and `findUserByIdOrEmail`.
- Editor `CloudPlugin` and `CloudAdapter` matching the existing
  `FileSystemAdapter` contract. Open returns `{ assetId, role,
roomEndpoint, roomToken, bootstrap }`.
- Save-as for non-cloud fonts (creates an asset and seeds the DO).
- Authorization in `room-token` endpoint actually checks
  `font_asset_members`.

### Phase 2 — Persistence cadence and snapshots

- DO writes `room_log` per accepted update (Tier 1).
- Segment roll on the documented thresholds, write to R2, prune log
  (Tier 2).
- Auto Yjs + babelfont snapshots on the documented thresholds (Tier 3).
- D1 batched inserts of `font_asset_events` at segment-roll time.
- Cold-start: load latest snapshot + replay log/segments past it.
- Editor `unsaved cloud` UI driven by `durable: true` ack.

### Phase 3 — Sharing UI and invitations

- Pages `POST /api/cloud/assets/:id/share` with email resolution.
- Pending invitation claim on signup/login.
- Dashboard UI for share/role management.
- Viewer-only WebSocket flow that rejects `update` frames with
  `error: 'role'`.

### Phase 4 — History UI and restore

- Activity feed, glyph history, kerning history backed by
  `font_asset_events`.
- Named versions UI (create, label, restore).
- Whole-font restore (owner), then glyph and layer restore (owner +
  editor), then kerning and features restore (owner).
- Each restore writes a `before-restore` named version automatically.

### Phase 5 — Hardening and observability

- Per-room rate limits, payload caps, build-version compatibility checks.
- Reconnect via state vector; idempotent retry validated by the
  `UNIQUE(client_id, client_seq)` constraint.
- Metrics: durable ack latency p50/p95/p99, segment roll bytes/duration,
  snapshot duration, room cold-start time, concurrent connections per room,
  edits per minute per room.
- Scheduled compaction Worker.
- Soak: 10k-edit session, large font (5k glyphs), simultaneous outline +
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
  screen as a forward operation, with a `before-restore` version available
  for one-click reversal;
- a viewer-role user cannot send document updates;
- compile budgets and worker replay paths are unchanged from local-only
  editing in the existing benchmarks.

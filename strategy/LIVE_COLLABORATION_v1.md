# Live Collaboration v1

## Purpose

This document turns the existing Yjs undo/collaboration work into an online
Cloudflare-hosted collaboration plan for Counterpunch fonts. It assumes the
current editor remains the source of truth for babelfont editing behavior, while
the sibling `website` repository provides the authenticated account, sharing,
and Cloudflare control-plane APIs.

Live collaboration for fonts is new territory. The plan therefore separates
what must be real-time and CRDT-safe from what should be versioned, reviewable,
or reversible at a more human font-design granularity.

## Existing Strategy And Code Reviewed

Existing strategy docs:

- `strategy/YJS_UNDO_COLLABORATION.md`
- `strategy/HOSTED_COLLABORATIVE_EDITING_BLUEPRINT.md`
- `strategy/UNDO_REDO_SCOPING_AND_PYTHON_HISTORY.md`
- `developer-docs/COMPILATION_EDIT_POLICY.md`

Relevant current editor code:

- `webapp/js/change-bridge.ts` owns the `Y.Doc`, mirrors babelfont JSON,
  records change-log entries, scopes undo managers to font/glyph/layer, and
  applies remote updates back into the babelfont JSON model.
- `webapp/js/window-sync.ts` is already a provider-like transport boundary for
  Yjs updates. It microtask-batches outbound and inbound updates, omits full
  state on the hot path, and uses full-state request/response only for
  bootstrapping.
- `webapp/js/filesystem-plugins.ts` already has a plugin registry with `Memory`
  and `Disk` plugins. A `Cloud` plugin can follow this shape.
- `webapp/js/file-system-adapter.ts` defines the filesystem adapter contract
  used by the file browser.

Relevant current website code:

- `website/schema.sql` already has D1-backed `users`, auth tokens,
  subscriptions, AI chat, and error-report tables.
- `website/functions/_middleware.js` parses session cookies or bearer tokens
  and attaches authenticated user data to request context.
- `website/utils/auth.js` has `resolveEffectiveUserId()` and
  `findUserByIdOrEmail()`, which are the right primitives for share-by-email
  flows that store internal user IDs.
- `website/wrangler.toml` currently binds one D1 database as `DB` and deploys
  as a Cloudflare Pages project.

## Product Model

### Cloud Assets

A cloud font is an asset, not a filename.

Each asset has:

- a database identifier such as `font_asset.id`, generated as a long random
  UUID-like string;
- a user-facing `name`, which may but does not need to equal the font family
  name;
- one current Yjs document state;
- one current babelfont JSON materialization;
- folder membership metadata;
- sharing and role metadata;
- version-history metadata.

Do not use font family name, local filename, or visible folder path as the
stable identity. Paths and names are mutable presentation metadata.

### Cloud Filesystem

Add a third filesystem plugin called `Cloud`.

The `Cloud` plugin should present ordinary filesystem-like folders to the user:

- folders have stable IDs, mutable names, and parent folder IDs;
- font assets appear inside folders by membership, not by storing identity in
  the path string;
- renaming or moving a cloud font changes metadata only;
- opening a cloud font returns the asset ID, display name, current room token,
  and the latest bootstrap state needed by the editor.

The first implementation should support opening cloud fonts. Saving is automatic
through Yjs; the plugin should not expose a manual save path for cloud fonts
unless it means "force checkpoint now" or "export/download".

Prepare the model for future Dropbox/Google-Drive-like sync, but do not build
filesystem sync now. To keep that door open:

- store stable folder and asset IDs separately from visible paths;
- store a monotonic `folder_revision` and `asset_metadata_revision`;
- make moves and renames explicit metadata events;
- allow future external sync providers to maintain their own mapping table from
  local filesystem inode/path to cloud folder/asset IDs.

### Sharing

Users share fonts by entering registered users' email addresses, Google Docs
style. The API resolves those emails to internal anonymous user IDs before
creating membership or invitation records.

Recommended roles for v1:

- `owner`: full edit, sharing, deletion, restore, transfer/export;
- `editor`: edit live font data and create named versions;
- `viewer`: open read-only, see presence, inspect history;
- `commenter` can wait until annotation/review tooling exists.

Invitations should store internal user IDs when the recipient already exists.
If the recipient is not registered yet, store the normalized email and create a
pending invite that is claimed after signup, then convert it to a membership row
with the new internal user ID.

The Durable Object room must never trust the email address from the client. It
should receive a short-lived room token with `assetId`, `userId`, `role`, and an
expiry, issued by the website API after D1 authorization checks.

## Cloudflare Architecture

Use Cloudflare as two planes.

### Control Plane In `website`

The website owns accounts, billing, metadata, sharing, and signed room tokens.
Implement this in the sibling `website` repo because it already contains the D1
user database and Pages Functions auth middleware.

New Pages Functions/API areas:

- `GET /api/cloud/folders` lists the authenticated user's folder tree.
- `POST /api/cloud/folders` creates folders.
- `PATCH /api/cloud/folders/:id` renames or moves folders.
- `GET /api/cloud/assets` lists accessible font assets.
- `POST /api/cloud/assets` creates/imports a cloud font asset.
- `GET /api/cloud/assets/:id` returns metadata and the user's role.
- `PATCH /api/cloud/assets/:id` renames, moves, archives, or restores metadata.
- `POST /api/cloud/assets/:id/share` resolves emails and creates memberships or
  pending invitations.
- `DELETE /api/cloud/assets/:id/share/:userId` removes access.
- `POST /api/cloud/assets/:id/room-token` returns a short-lived WebSocket token.
- `GET /api/cloud/assets/:id/history` lists named versions, snapshots, and
  restore points.
- `POST /api/cloud/assets/:id/restore` creates a forward restore operation.

### Data Plane In Durable Objects

Use one Durable Object per live font asset. The Durable Object is the room
coordinator and the only component that applies Yjs updates for a room.

Responsibilities:

- authenticate WebSocket handshakes using room tokens;
- keep the hot `Y.Doc` in memory;
- fan out accepted Yjs updates to connected clients;
- broadcast awareness/presence updates without persisting them as font content;
- append accepted updates into durable update segments;
- create compact full snapshots;
- materialize latest babelfont JSON for fast non-live access and restore.

Use R2 for large binary blobs and long-lived snapshots. Use D1 for metadata,
ACLs, searchable history indexes, and pointers. Use Durable Object storage for
small room-local state and the current open segment if that keeps recovery
simpler.

Do not write each drag tick or Yjs delta as an individual D1 row. D1 is the
metadata/index database, not the hot collaboration log.

## Recommended Storage Model

### D1 Tables

Add these tables to the website database or a dedicated cloud-fonts D1 database:

```sql
CREATE TABLE cloud_folders (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  parent_folder_id TEXT,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  sort_order TEXT,
  revision INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE font_assets (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  folder_id TEXT,
  name TEXT NOT NULL,
  current_version INTEGER NOT NULL DEFAULT 0,
  current_snapshot_ref TEXT,
  current_babelfont_ref TEXT,
  current_yjs_state_ref TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER,
  metadata_revision INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE font_asset_members (
  asset_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
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
  version INTEGER NOT NULL,
  kind TEXT NOT NULL,
  actor_user_id TEXT,
  label TEXT,
  summary_json TEXT,
  yjs_state_ref TEXT,
  babelfont_ref TEXT,
  update_segment_ref TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(asset_id, version)
);

CREATE TABLE font_asset_events (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  version INTEGER,
  actor_user_id TEXT,
  event_type TEXT NOT NULL,
  scope TEXT,
  glyph_name TEXT,
  layer_id TEXT,
  payload_json TEXT,
  created_at INTEGER NOT NULL
);
```

`font_asset_events` should be small and queryable. It should not contain the raw
Yjs binary update for every edit. Store summaries and pointers there.

### R2 Object Layout

Suggested object keys:

- `fonts/{assetId}/snapshots/yjs/{version}.bin`
- `fonts/{assetId}/snapshots/babelfont/{version}.json.br`
- `fonts/{assetId}/segments/{segmentStartVersion}-{segmentEndVersion}.bin`
- `fonts/{assetId}/exports/{name-or-version}.otf`

Compress babelfont JSON with Brotli or gzip. Yjs update segments can be stored
as binary merged updates; compression should be measured because Yjs updates are
already compact but may still benefit from outer compression in large fonts.

## Wire Protocol

Keep the current `window-sync.ts` message semantics, but move the network
provider into a separate cloud provider layer.

Client to Durable Object:

- `auth`: room token, client ID, editor build version;
- `sync-state-request`: optional state vector and known version;
- `yjs-update`: binary update plus current change-log entries;
- `awareness-update`: selected glyph/layer/tool/cursor/color/name;
- `checkpoint-request`: optional explicit user-triggered save/version boundary;
- `ping`.

Durable Object to client:

- `sync-state-response`: full update or diff update, room version, snapshot ID;
- `yjs-update`: accepted update from another client plus history summaries;
- `awareness-update`;
- `ack`: durable room version and saved/checkpoint status;
- `error`: auth, role, version, payload, or rate-limit failure.

Viewers may receive `yjs-update` and send `awareness-update`, but must not send
content-changing `yjs-update` messages.

## Persistence Cadence

### Client Boundaries

Persist at existing logical collaboration boundaries, not raw pointer movement.

The current editor already avoids saving every drag tick into collaboration
history. Interactive drags update the local model and worker cache live, then
commit final Yjs/collaboration state on mouseup. Preserve that distinction for
cloud collaboration.

Cloud updates should correspond to:

- transaction end from `ChangeBridge.endTransaction()`;
- final mouseup commit after outline, sidebearing, component, or anchor drags;
- keyboard nudges and direct property edits after their existing transaction;
- feature-code commits, kerning edits, font-info edits, layer/glyph structural
  edits, and Python script transactions;
- undo/redo or restore operations, which are forward Yjs updates.

Do not send every live drag preview to the cloud as document history. Presence
can show "Yanone is editing glyph a" or a transient selection/cursor, but the
document state should commit at the same logical boundaries as today's
ChangeBridge history.

### Durable Append Policy

For every accepted content update, the Durable Object should apply the update to
its in-memory `Y.Doc`, assign a monotonically increasing room version, and append
the binary update to the current room segment.

Recommended v1 rule:

- acknowledge the client only after the update is either written to Durable
  Object storage or queued in an already-open storage transaction that is known
  to flush before the ack;
- broadcast to peers immediately after successful apply, without waiting for a
  full snapshot;
- roll the segment when it reaches 100 logical updates, 1 MB compressed, or 10
  seconds of room activity, whichever comes first;
- write the rolled segment to R2 and store its pointer in D1 as a
  `font_asset_versions` row of kind `segment` or as compact segment metadata.

If latency measurements show Durable Object storage writes are too slow for
every logical update, allow a bounded async window: ack as `received` immediately
and then emit `saved` once durable. The UI must then show unsaved cloud status
until the durable ack arrives. Do not pretend unsaved in-memory room state is
safe.

### Full Snapshot Policy

Save full snapshots. They are essential for fast open, recovery, pruning, and
human-friendly restore.

Recommended v1 cadence:

- full Yjs state snapshot every 250 logical updates or every 60 seconds of
  active editing, whichever comes first;
- full babelfont JSON materialization every full Yjs snapshot, and also on room
  idle after the last update;
- immediate full snapshot on explicit user action: duplicate asset, create named
  version, restore, export, transfer ownership, or close-last-editor after dirty
  state;
- keep at least the latest snapshot, the previous snapshot, and all named
  versions regardless of ordinary retention pruning.

The older hosted blueprint suggested 250 updates or 10 seconds. For font editing
v1, 60 seconds is a better default because logical updates are already
transaction-level, babelfont JSON can be large, and full snapshots should not
compete with interactive compilation. The Durable Object may snapshot sooner
when the accumulated segment bytes are large.

### Retention And Compaction

Keep raw update segments long enough to support recent replay and recovery.

Suggested v1 retention:

- ordinary unnamed update segments: 30 days;
- hourly snapshots: 7 days;
- daily snapshots: 90 days;
- named versions: until deleted by an owner;
- explicit restore events: retained with the target version pointer.

After a full snapshot is safely written, older segments before that snapshot may
be compacted or deleted according to retention. Never delete segments needed by
named versions or active restore windows.

## Replay, History, And Revert

There are three separate concepts.

### Local Undo

Undo is for the person currently editing. It should be quick, local in intent,
and unsurprising.

Policy for v1:

- each user can undo their own changes only;
- undo emits a normal forward Yjs update;
- remote users see the result as a new change by the undoing user;
- users cannot press Cmd+Z and accidentally revert someone else's work.

This matches the general expectation from collaborative editors and keeps
Counterpunch from inventing a surprising global undo model.

Implementation note: the current linked-window path uses same-user origins so
multiple windows belonging to the same person share undo ownership. Cloud mode
must introduce user-aware origins. Multiple windows for the same authenticated
user should share that user's undo scope; windows for different users should not
capture each other's changes in their undo managers.

### Owner/Admin Restore

Restore is not undo. Restore is a deliberate forward operation that copies an
older state or older scoped data into the current Yjs document.

Owners should be able to restore:

- the whole font to a named version or snapshot;
- one glyph to its state at a named version or snapshot;
- one layer, where the layer identity still exists;
- kerning data for a master or the whole font;
- feature code;
- font info/source data.

Editors may create named versions. Whether editors can restore whole-font state
should be a product decision; v1 should default whole-font restore to owners and
glyph-scoped restore to owners plus editors.

Restores should always create a new history event. They should not rewrite old
history. A restore event should include:

- actor user ID;
- source snapshot/version ID;
- scope: font, glyph, layer, kerning, features, font-info;
- affected glyph/layer/master identifiers;
- summary of replaced data;
- pointer to the pre-restore snapshot when practical.

### Replay

Replay is for inspection and recovery, not necessarily the main day-to-day UI.

Raw Yjs update replay is useful for reconstructing exact document state, but it
is not the best user-facing story. A font designer wants history grouped by
meaning: glyph outline, kerning, features, metrics, anchors, components, Python
script, import, restore.

Use the current `ChangeLogEntry` metadata as the human history index. Persist a
small summary per logical transaction into `font_asset_events`, including
`touchedPaths`, derived glyph names, layer IDs, undo scope, transaction label,
and actor user ID.

For replay UI, build from snapshots plus event summaries:

- timeline can jump to a full snapshot quickly;
- optional fine replay applies retained update segments after that snapshot;
- glyph history filters by derived touched glyph/layer metadata;
- kerning and features have their own filters because they are not naturally
  glyph-layer edits.

## Granularity For Font-Specific Revert

Recommended revert scopes:

### Glyph Outline And Layer Data

Primary revert unit: glyph layer.

Secondary unit: whole glyph, which includes all layers, anchors, guides,
components, metrics keys, codepoints, export flag, and glyph metadata.

Rationale: designers often work one glyph at a time, but variable fonts require
layer consistency. A whole-glyph restore is safer than path-level time travel in
v1. Layer restore is useful when a single master/intermediate layer went wrong.

### Kerning

Primary revert unit: kerning for one master.

Secondary units:

- one kerning pair or group pair;
- all kerning.

Kerning can happen while outline work happens. Keep kerning history separate in
the UI so restoring glyph `A` does not silently revert kerning unless the user
chooses a broader scope. If a glyph rename or deletion affects kerning keys,
show a dependency warning before scoped restore.

### OpenType Features

Primary revert unit: feature source block or whole feature file/source field,
depending on the babelfont representation available in the current model.

Feature changes should be treated as font-level history. They should not be
bundled into glyph restore unless future code builds reliable dependency
analysis for affected glyphs/classes.

### Axes, Masters, Instances

Primary revert unit: font-level named version.

Do not offer casual partial restore for axes or masters in v1. These structures
affect layer compatibility, interpolation, locations, kerning, and instances.
Partial restore is possible later, but it needs validation and warnings.

### Metrics, Sidebearings, Anchors, Components

These are glyph/layer data in the current Yjs model, but they have downstream
dependencies: metrics keys, automatic composition, anchor cascades, and GPOS.

Scoped restore must run the same rebuild and compile paths as undo/redo and
remote change application. If a restore touches anchors, components, metrics
keys, or automatic composition sources, it must carry worker replay targets or
force the documented full-sync fallback.

## Conflict And Ownership Policy

### Simultaneous Glyph Editing

Yjs can merge simultaneous edits, but font design intent can still conflict.
Add soft locks/presence, not hard locks, in v1:

- show who is viewing or editing the current glyph;
- show remote selection/layer context;
- warn when two users edit the same glyph layer;
- do not block edits unless a later product decision introduces explicit locks.

### Undoing Other Users

Do not provide "undo other user's last edit" as a keyboard or toolbar action.

Owners may restore a previous glyph or font state as an explicit restore action.
That is auditable, visible, and reversible as a new forward operation.

This distinction is important:

- undo is personal and immediate;
- restore is administrative/editorial and scoped;
- replay is historical inspection.

## Editor Integration Plan

### Phase 1: Cloud Plugin And Open Flow

1. Add `CloudAdapter` implementing `FileSystemAdapter` for folder listing and
   font opening.
2. Add `CloudPlugin` in `filesystem-plugins.ts` with ID `cloud`, cloud icon,
   auth requirement, and no ordinary manual save path.
3. Reuse website auth/session via existing editor auth manager and website API.
4. Opening a cloud font fetches asset metadata and room token, then bootstraps
   the editor from the Durable Object state.
5. Mark the font session as cloud-backed with `cloudAssetId`, display name,
   role, and room endpoint.

### Phase 2: Cloud Yjs Provider

1. Extract the provider responsibilities currently embedded in `WindowSync` into
   a transport abstraction:
    - local BroadcastChannel provider;
    - cloud WebSocket provider;
    - optional composite provider for multiple windows of the same user.
2. Preserve `WindowSync` batching rules: no full state on normal updates,
   structured-clone binary updates, inbound microtask batching, and compact
   repair snapshots when needed.
3. In cloud mode, send local Yjs updates to the Durable Object and apply remote
   updates through `ChangeBridge.applyRemoteUpdate()`.
4. Add authenticated user identity to change-log entries before cloud transmit.
5. Keep awareness separate from document Yjs updates.

### Phase 3: Durable Object Room

1. Add a Worker/Durable Object service, either alongside the Pages project or as
   a dedicated Worker bound from Pages.
2. Implement room-token verification and role enforcement.
3. Maintain in-memory `Y.Doc`, connected clients, user presence, current version,
   current segment, and checkpoint timers.
4. Load latest snapshot plus trailing segments on cold start.
5. Persist accepted updates according to the cadence above.
6. Expose test hooks for deterministic two-client convergence tests.

### Phase 4: History And Restore

1. Persist summarized change-log entries into `font_asset_events` at logical
   transaction boundaries.
2. Generate named versions from full snapshots.
3. Build restore operations that patch the live Yjs document forward from older
   babelfont JSON scopes.
4. Start with whole-font and whole-glyph restore, then add layer, kerning, and
   features restore after validation tests exist.

### Phase 5: Hardening

1. Add room rate limits, payload caps, and build-version compatibility checks.
2. Add reconnect via Yjs state vectors.
3. Add observability: update bytes, snapshot duration, room load time, connected
   users, durable ack latency, restore success/failure.
4. Add retention pruning jobs. Pages projects do not support cron directly, so
   use a separate scheduled Worker or dashboard-configured scheduled Worker.

## Website Integration Plan

The website repo should own these changes:

- schema migrations for cloud folders/assets/members/invitations/history;
- auth-guarded Pages Functions under `/api/cloud/*`;
- share-by-email using `findUserByIdOrEmail()` and pending invitation rows;
- room-token issuance using `resolveEffectiveUserId()`;
- dashboard UI for cloud fonts, folders, sharing, and versions;
- Wrangler bindings for Durable Objects and R2.

The editor repo should own these changes:

- `CloudPlugin` and `CloudAdapter`;
- cloud open/bootstrap flow;
- cloud Yjs provider integration;
- user-aware change-log metadata;
- scoped restore application into `ChangeBridge`;
- tests that prove cloud updates do not regress compile/cache budgets.

## Testing Strategy

Editor tests:

- unit tests for cloud provider message handling and reconnect state-vector
  logic;
- ChangeBridge tests for user-aware undo ownership;
- tests that cloud remote updates still use replay targets and avoid full-font
  worker crossings when targets exist;
- Playwright multi-context tests for two authenticated users editing different
  glyphs, same glyph, kerning plus outline, undo, and restore.

Website/Worker tests:

- API auth and role enforcement;
- share-by-email resolution and pending invite claim;
- Durable Object two-client convergence;
- snapshot and segment recovery after cold start;
- viewer cannot send document updates;
- restore creates a forward event and updates current state.

Soak tests:

- long room with thousands of logical edits;
- large font open/late join under target latency;
- disconnect/reconnect while edits continue;
- simultaneous kerning and glyph outline work.

## Open Decisions

- Whether cloud collaboration lives in the existing Pages project or a dedicated
  Worker service with its own deployment pipeline.
- Whether ordinary unnamed update segments are stored in Durable Object storage,
  R2, or both before compaction.
- Exact user-visible role names and whether editors may perform whole-font
  restore.
- Whether future folder sync is per user, per workspace, or per asset owner.
- Whether named versions are manual only or also created automatically at daily
  boundaries.

## Recommended First Prototype

Build a private internal prototype with one cloud asset and two authenticated
users:

1. Create D1 rows for one asset and two members.
2. Add a Durable Object room that accepts binary Yjs WebSocket updates.
3. Add a temporary editor cloud-open path that bypasses the full folder UI.
4. Open the same font in two browsers with different users.
5. Verify: edit glyph outline, edit kerning, undo own change, create a full
   snapshot, cold-start the room, and restore one glyph from the snapshot.

Only after that prototype should the full Cloud filesystem UI and sharing UI be
polished.

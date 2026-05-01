# Live Collaboration v1 → v2 Differences

This document summarises every material difference between
`LIVE_COLLABORATION_v1.md` and `LIVE_COLLABORATION_v2.md`. Items that are
unchanged between the two documents are not listed here.

---

## 1. Cloudflare Deployment Shape

| v1                                                                                    | v2                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Could live in the existing Pages project or a dedicated Worker service" — left open. | Committed: one new Worker (`cf-fonts-room`) bound to the Pages project via **service binding**. The DO class lives there; Pages keeps all HTTP control-plane routes. Pages and the Worker share D1 access via the binding so D1 logic is not duplicated. |
| No mention of WebSocket hibernation or DO storage engine.                             | **WebSocket Hibernation API** and **Durable Object SQLite storage** are hard requirements. Without them idle rooms are too expensive and in-memory state cannot be cheaply recovered.                                                                    |

---

## 2. Persistence Tier Model

v1 described a general intent (append log, segments, snapshots) without
committing to where each tier lives or its thresholds. v2 makes all of that
concrete.

### Hot append log (Tier 1)

| v1                                                                                                                               | v2                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Write each accepted update to Durable Object storage OR queue in an already-open storage transaction" — ambiguous about schema. | **DO SQLite table `room_log`** with an explicit schema. One row per accepted update, written before the durable ack is sent. `UNIQUE(client_id, client_seq)` makes retries idempotent. Awareness frames are not logged. |

### Warm segments (Tier 2)

| v1                                                                                   | v2                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Roll at "100 logical updates, 1 MB, or 10 seconds of room activity".                 | Roll at **256 updates, 1 MB, or 30 s of inactivity** (or explicit checkpoint). Rationale: 10 s is too aggressive for font editing where a single transaction can take several seconds.                               |
| "Write rolled segment to R2 and store pointer in D1 as a `font_asset_versions` row." | Write to R2 as a binary segment blob plus a JSON sidecar with per-update attribution metadata. D1 receives **batched `font_asset_events` rows** at segment-roll time — not per update, not as `font_asset_versions`. |

### Cold snapshots (Tier 3)

| v1                                                                                    | v2                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Full Yjs snapshot every 250 logical updates or every 60 seconds"                     | Full Yjs + babelfont snapshot every **1024 updates or every 10 minutes** of active editing, plus at least once per UTC day if any edits occurred. Higher thresholds because logical updates are already transaction-level and babelfont JSON can be large. |
| "Full babelfont JSON materialization every full Yjs snapshot, and also on room idle." | Same, but v2 requires the DO to import the **same babelfont materialization module** used by the editor, so server-side snapshots are bit-identical to what the editor would produce locally.                                                              |

### What goes into D1

| v1                                                    | v2                                                                                                                                                                                                                       |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Implied that some update-level data might go into D1. | Explicit: **D1 receives no per-update writes**. It receives only: snapshot/named-version rows (`font_asset_versions`) and batched event-index rows (`font_asset_events`) inserted once per segment roll (~30 s cadence). |

---

## 3. `font_asset_events` Table Design

| v1                                                                         | v2                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Table defined with `payload_json TEXT` — unstructured.                     | Structured columns: `scope_kind`, `glyph_name`, `layer_id`, `master_id`, `summary TEXT`. No binary update payloads. Three named indexes: `(asset_id, created_at)`, `(asset_id, glyph_name, created_at)`, `(asset_id, scope_kind, created_at)`. |
| `font_asset_versions` used to record segments as a `kind = 'segment'` row. | Segments are tracked separately in R2 with a sidecar; `font_asset_versions` is reserved for snapshots and named versions only. A new `kind = 'before-restore'` auto-named version is created whenever a restore runs.                          |

---

## 4. Yjs Origins And User Identity

| v1                                                                                                | v2                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Used string origin tokens (`USER_EDIT_ORIGIN`, `GLYPH_EDIT_ORIGIN`, etc.) as today's editor does. | Promotes origins to **structured objects** `CloudOrigin { kind, userId, clientId, seq, txId, scope }` in cloud mode.                                                                     |
| Said "introduce user-aware origins" without specifying shape.                                     | `UndoManager.trackedOrigins` is set per scope to the predicate `origin.userId === this user's id AND scope matches`. Concretely implements the v1 intent.                                |
| Multiple windows for the same user "should share undo ownership" — left as a note.                | Specified: multiple tabs share undo because the predicate matches `userId`, not `clientId`. Remote updates arrive under `kind: 'remote'` and are never tracked by any local UndoManager. |

---

## 5. Undo Policy (extended from v1)

v1 stated the policy ("each user undoes only their own changes") but left the
mechanism vague.

v2 specifies:

- `trackedOrigins` predicate filters by `userId` + scope, not by static string
  set.
- Undo across kerning / outline scopes stays isolated because each scope has
  its own UndoManager with its own predicate.
- "No undo of other user's edits" is now enforced structurally, not just by
  policy intention.

---

## 6. Concurrent Kerning And Outline Editing

v1 did not address this case explicitly.

v2 adds:

- `glyphs.<name>.layers.<id>` and `kerning.<masterId>` are independent
  `Y.Map`s; Yjs merges them with no semantic conflict.
- Each user has separate UndoManagers per scope; Cmd+Z during a kerning edit
  never reverts another user's outline edit.
- **Restore-glyph never silently changes kerning.** If restoring a glyph would
  change its kerning group, the editor warns and asks before applying the
  group change.
- Restore-kerning does not touch glyph outlines.

---

## 7. Restore Granularity Table

v1 listed restore scopes (glyph, layer, kerning, features, axes/masters) in
prose. v2 provides an explicit table with:

- the **source** allowed for each scope (snapshot / named version / any);
- who may perform each restore (`owner` vs. `owner + editor`);
- axes/masters/instances explicitly restricted to whole-font named-version
  restore with a rationale (partial restore breaks layer compatibility and
  interpolation).

New in v2: every restore automatically creates a `kind = 'before-restore'`
named version, making the restore itself reversible by a further restore
without manual snapshotting.

---

## 8. Offline Editing And Reconnect

v1 said nothing about offline editing. v2 specifies:

- Editor queues outgoing updates in memory while disconnected.
- Reconnect sends `auth` then `sync-request` with current state vector; DO
  replies with merged diff.
- DO `UNIQUE(client_id, client_seq)` makes replayed queued updates idempotent
  at the database layer — no extra deduplication logic needed in the editor.
- Long-offline case: if retention compacted segments past the editor's state
  vector, DO sends a `force-rebase` notice; editor treats it like a fresh
  open.
- Offline edits retain their original `userId` origin and are fully
  attributable on replay.

---

## 9. Replay And History UI

| v1                                                                                    | v2                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "Timeline can jump to a full snapshot; fine replay applies retained update segments." | Segment-level Yjs replay is **admin/debug only**, not a user-facing feature.                                                                                                                                                                                                   |
| History views listed without explicit data source.                                    | Activity feed, glyph history, kerning history, and named versions all read from the **indexed `font_asset_events` table** plus snapshot refs. Per-glyph time travel uses "latest snapshot ≤ target timestamp, then apply filtered events if sub-snapshot precision is needed." |

---

## 10. Wire Protocol Changes

v1 defined message types but not payload schemas.

v2 adds:

- All content `update` frames carry `{ seq, update: bytes, origin: CloudOrigin, changeLog: ChangeLogEntry[] }` — the same change-log shape used by `ChangeBridge` today, so the DO can build `font_asset_events` rows without parsing raw Yjs.
- Two explicit ack levels: `received` (fast, implicit on broadcast) and `durable: true` (once written to DO SQLite). Editor "saving" UI is driven by `durable: true`.
- `restore-event` message from DO to clients carrying scope + summary of a restore already applied as a forward update.

---

## 11. Compile And Worker Integration

v1 did not address how remote cloud updates interact with the editor's compile
fast paths.

v2 requires:

- Remote updates carry `changeLog` with `touchedPaths`, glyph names, layer IDs,
  and replay targets in the same shape as local `ChangeBridge` entries.
- Received through `ChangeBridge.applyRemoteUpdate` — the same path as
  `WindowSync` — so compile fast paths, worker cache replay, anchor/component
  dependents, and full-sync fallback all keep working unchanged.
- Active-drag-deferral applies to remote updates exactly as it does today.
- Restore operations carry full replay targets; whole-font/kerning-all/features/
  font-info restores force a full-font compile.

---

## 12. Snapshot / Segment Schema Changes

v1 listed R2 keys and a SQL schema. v2 keeps the same R2 key structure but
makes these schema changes:

- `font_asset_versions`: replaces `current_version INTEGER` with
  `current_room_version INTEGER`, adds `schema_version`, drops
  `current_snapshot_ref` (now encoded as two separate refs). Adds
  `prior_version_id` to the version row so restore chains are traversable.
- `font_asset_events`: adds structured scope columns, removes unstructured
  `payload_json`, adds three indexes.
- `cloud_folders`: adds `archived_at`.
- `font_asset_members`: adds `CHECK (role IN ('owner','editor','viewer'))`.

---

## 13. Items Removed From Open Decisions

v1 listed these as open: storage location (Pages vs dedicated Worker), D1 vs
R2 vs DO storage split, exact snapshot cadence, editor role for whole-font
restore, future folder sync shape.

v2 closes all of them. The only open decisions carried forward are:

- public-link viewer flow (off by default, implement later);
- whether named versions auto-create at UTC day boundaries;
- whether segment-level replay is ever exposed in UI;
- whether kerning/outline permissions decouple per user;
- hard locks on glyph editing (out of scope for v2).

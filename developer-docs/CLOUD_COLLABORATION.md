# Cloud Collaboration — Developer Reference

This document records implementation decisions and progress as each phase is
completed. It is updated incrementally alongside code changes. The authoritative
design is in `strategy/LIVE_COLLABORATION_v2.md`; this doc is the "what we built
and why" companion.

---

## Architecture Snapshot

```
Browser editor ──► Pages (website)   control plane: D1, auth, ACL, CRUD
        │
        │  room token (JWT-like)
        ▼
   WebSocket ──────► Worker + Durable Object (cf-fonts-room)
                      per-asset room: in-memory Y.Doc, DO SQLite hot log
```

Two repos:

| Repo    | Path                                      | Responsibility                                     |
| ------- | ----------------------------------------- | -------------------------------------------------- |
| editor  | `/Users/yanone/Code/Counterpunch/editor`  | Client-side TypeScript, CloudPlugin, CloudAdapter  |
| website | `/Users/yanone/Code/Counterpunch/website` | Cloudflare Pages, D1, room-token issuer, DO Worker |

Worker lives at `website/workers/fonts-room/`.

---

## Phase 0 — Skeleton (✅ complete)

**Goal:** Prove two browsers can converge on a real font via DO WebSocket sync.

### What was built

**website repo (commit `cb87d50`):**

- `workers/fonts-room/src/font-room-do.js` — Cloudflare Durable Object with
  WebSocket Hibernation API (`ctx.acceptWebSocket`). Stores updates in DO SQLite
  (`room_log` table). In-memory `Y.Doc` rebuilt from SQLite on hibernation wake.
- `functions/api/cloud/assets/[id]/room-token.js` — Phase 0 stub: any
  authenticated user receives `role:'editor'` for any asset ID. No D1 ACL check.

**editor repo (commit `d1bc4960`):**

- `webapp/js/cloud-adapter.ts` — WebSocket adapter implementing the Yjs
  two-phase sync protocol (state-vector exchange + incremental updates).
- `webapp/js/cloud-plugin.ts` — `FilesystemPlugin` wrapper exposing
  `connectToRoomWithToken()` for dev testing.
- `webapp/js/change-bridge.ts` — Added `applyYDocUpdateSilent(update)` to seed a
  new bridge's Y.Doc without triggering local-edit listeners.

### Key problem solved: Fustat size limit

Fustat font state is ~3.5 MB. An earlier `MAX_SYNC_BYTES = 900_000` guard
silently dropped the initial client state. CRDT left-sibling references were
unresolvable on peers.

**Solution:** Chunked sync protocol.

- `SYNC_CHUNK_SIZE = 750_000` bytes per WebSocket frame.
- Client splits large `sync-complete` into N `sync-chunk` + 1 final
  `sync-complete` frames.
- Server splits large `sync-response` into a header frame (`chunked:true,
totalChunks`) followed by N `sync-chunk` frames with `direction:'response'`.
- Client accumulates chunks in `_incomingResponseChunks` buffer and applies
  once all arrive.

### Key problem solved: bridge replacement race

When `fontModelReady` fires (compilation-triggered model rebuild),
`initializeBridge()` creates a new `ChangeBridge` with a fresh Y.Doc. Incremental
remote updates fail because the new Y.Doc lacks CRDT history.

**Solution:** `_subscribeFontModelReady()` in CloudAdapter copies the old
bridge's full state into the new bridge via `applyYDocUpdateSilent` before
re-binding the outbound update hook.

### Wire protocol (Phase 0)

All frames are JSON; binary Yjs data is base64-encoded.

Client → Server:

```
auth           { type, token }
sync-request   { type, stateVector: base64 }
sync-chunk     { type, update: base64, chunkIndex, totalChunks }
sync-complete  { type, update: base64 [, chunkIndex, totalChunks] }
update         { type, update: base64, clientId, seq }
```

Server → Client:

```
auth-ok        { type, clientId }
auth-error     { type, message }
sync-response  { type, update?: base64, serverStateVector: base64 [, chunked, totalChunks] }
sync-chunk     { type, update: base64, chunkIndex, totalChunks, direction:'response' }
update         { type, update: base64, clientId, seq }
ack            { type, seq, durable: bool }
error          { type, message }
```

### Local dev setup

```bash
# 1. Start room worker
cd website/workers/fonts-room
npx wrangler dev --port 8787

# 2. Start website Pages
cd website
npx wrangler pages dev --port 8788

# 3. Start editor
cd editor/webapp
npm run dev
```

Test via browser console:

```js
window.cloudDebug.connectWithToken(
    "asset-id",
    token,
    "ws://localhost:8787/room/asset-id",
);
```

---

## Phase 1 — Cloud filesystem plugin and asset CRUD (✅ complete)

**Goal:** Real asset management in D1, eligibility gating, cloud:// URIs,
open/save-as UI in editor.

### What was built

**D1 schema** (`website/migrations/cloud-schema-2026-XX-XX.sql`):

Tables: `cloud_folders`, `font_assets`, `font_asset_members`,
`font_asset_invitations`, `cloud_folder_entries`, `user_cloud_overrides`,
`font_asset_versions`, `font_asset_events`.

`user_cloud_overrides` — row with `revoked_at IS NULL` grants cloud hosting.
`font_assets` — one row per cloud font asset; `owner_user_id` is the creator.
`font_asset_members` — ACL table; `role ∈ {owner,editor,viewer}`.
`cloud_folder_entries` — per-user filing (folder_id NULL = unfiled flat library).

**Entitlements** (`website/utils/cloud-entitlements.js`):

Three stub functions that will absorb subscription tier logic later:

- `isCloudHostingEnabled(db, userId)` — checks `user_cloud_overrides`.
- `getMaxFontsOwned(db, userId)` — returns `null` (unlimited).
- `getSnapshotRetentionDays(db, userId)` — returns `null` (unlimited).

**API endpoints** (website Pages Functions):

| Endpoint                         | File                                       | Purpose                                   |
| -------------------------------- | ------------------------------------------ | ----------------------------------------- |
| `GET /api/cloud/eligibility`     | `functions/api/cloud/eligibility.js`       | Eligibility check before showing cloud UI |
| `GET /api/cloud/assets`          | `functions/api/cloud/assets/index.js`      | List accessible assets (owned + shared)   |
| `POST /api/cloud/assets`         | `functions/api/cloud/assets/index.js`      | Create asset (re-checks eligibility)      |
| `GET /api/cloud/assets/:id`      | `functions/api/cloud/assets/[id]/index.js` | Asset details + room token                |
| `DELETE /api/cloud/assets/:id`   | `functions/api/cloud/assets/[id]/index.js` | Owner-only delete                         |
| `GET /api/cloud/folders`         | `functions/api/cloud/folders/index.js`     | List user's folders                       |
| `POST /api/cloud/folders`        | `functions/api/cloud/folders/index.js`     | Create folder                             |
| `POST /api/admin/cloud/override` | `functions/api/admin/cloud/override.js`    | Grant/revoke cloud access                 |

**room-token ACL** — `functions/api/cloud/assets/[id]/room-token.js` now
queries `font_asset_members` to find the caller's role. Returns 403 if the
user has no row in that table for the requested asset.

**Editor** (`editor/webapp/js/`):

- `cloud-plugin.ts` — rewritten. On init calls `GET /api/cloud/eligibility`.
  Hides itself if `cloudHostingEnabled:false`. Exposes `openAsset(assetId)`
  which fetches a room token and connects `CloudAdapter`. `saveAs(fontJson)`
  creates a new D1 asset and seeds the DO.
- `cloud-adapter.ts` — `_fetchRoomToken()` now makes a real HTTP POST to
  `POST /api/cloud/assets/:id/room-token`. `connectDirect()` kept for dev
  testing.
- `file-browser.ts` — `openFont('cloud://uuid')` path detected and routed to
  `CloudPlugin.openAsset()`.
- `index.d.ts` — added `cloudPlugin`, `cloudEligibility` globals.

### cloud:// URI scheme

Font assets opened from the cloud use `cloud://<assetId>` as the "path"
passed to `openFont()`. The file-browser recognises the `cloud://` prefix and
delegates to `CloudPlugin.openAsset(assetId)` instead of the normal filesystem
read path.

### Admin override flow

Admin dashboard (website) → Cloud Hosting panel → `POST /api/admin/cloud/override`
with `{ action:'grant'|'revoke', userQuery }`.

### Constraints carried forward

- No Stripe tier checks yet — all quota functions return `null` (unlimited).
- `saveAs` seeds the DO by connecting `CloudAdapter`, sending the full
  babelfont JSON serialized into the existing Yjs CRDT. The DO persists it in
  its hot SQLite log.
- No sharing UI yet (Phase 3). Shared fonts can be accessed if a member row
  exists in D1 (manual admin insert).
- No snapshot persistence yet (Phase 2). DO holds state only in memory + SQLite
  hot log; restarts lose history until Phase 2.

---

## Phases 2–5 (pending)

See `strategy/LIVE_COLLABORATION_v2.md` for planned implementation.

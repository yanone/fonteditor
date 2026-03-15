# Hosted Collaborative Font Editing Blueprint

## Goal

Build an always-on, multi-user collaborative font editing service (Google Workspace style) on Cloudflare.

Primary outcomes:

1. Real-time collaborative editing with low latency.
2. Late joiners receive current state quickly.
3. Safe persistence, recovery, and access control.
4. Clear ownership, permissions, and auditability.

## Non-Goals (Phase 1)

1. Fine-grained merge UI for every conflict type.
2. Full historical timeline playback UI.
3. Cross-document transactions.

## Current Readiness Snapshot

What already exists:

1. Yjs document model and syncing primitives.
2. Full-state bootstrap semantics in local collaboration flow.
3. Undo/redo model tied to glyph-scoped streams.
4. Deterministic refresh and Rust cache sync paths.

What is missing for hosted mode:

1. Network provider for internet clients (not just BroadcastChannel).
2. Authenticated user identity and permissions.
3. Durable server-side room state and reconnect handling.
4. Snapshot and restore pipeline.
5. Presence channel and collaboration UX.

## Recommended Cloudflare Architecture

## Components

1. Cloudflare Durable Object per document room.
2. WebSocket endpoint in Worker routes clients to document Durable Object.
3. D1 for metadata and access control.
4. Durable Object storage or R2 for Yjs snapshot blobs.
5. Pages app (editor frontend) and Worker API.

## Why Durable Objects

1. Single-writer coordination per document without external lock manager.
2. In-memory hot state for low latency update fanout.
3. Natural fit for room semantics and presence state.

## Data Plane and Control Plane

Data plane (real-time):

1. Client sends binary Yjs updates over WebSocket.
2. Durable Object applies update and broadcasts to peers.
3. Awareness/presence updates are ephemeral and broadcasted.

Control plane (metadata and policy):

1. API checks permissions from D1.
2. Room token issuance and role assignment.
3. Sharing/invitation management.

## Document Lifecycle

## Open Document

1. User authenticates and requests room token.
2. Worker validates role (owner, editor, commenter, viewer).
3. Client opens WebSocket to room Durable Object.
4. Durable Object responds with latest Yjs state (full or diff).
5. Client hydrates local Y.Doc and loads font model.

## Edit Session

1. Local edits produce Yjs updates.
2. Updates sent to Durable Object.
3. Durable Object applies + rebroadcasts.
4. Server tracks dirty status and snapshot cadence.

## Late Join

1. New client connects.
2. Durable Object sends latest checkpoint state.
3. Optionally sends incremental updates after checkpoint version.
4. Client reconstructs latest document from Yjs state.

Important:

1. Late joiners should hydrate from Yjs state, not replay raw JSON edit history line-by-line.

## Disconnect / Reconnect

1. Client reconnects with last known state vector.
2. Durable Object sends only missing updates if available.
3. If unavailable, send full checkpoint.

## Persistence Strategy

Do not write each keystroke into D1.

Use hybrid persistence:

1. In-memory active Y.Doc in Durable Object.
2. Periodic compressed checkpoint snapshots (for example every 5-15 seconds or every N updates).
3. Optional update-log segments for recovery/audit between checkpoints.

Storage choices:

1. D1: document metadata, ACLs, small pointers.
2. R2 or Durable Object storage: binary checkpoint blobs.

## Suggested Snapshot Policy

1. Snapshot every 250 updates OR every 10 seconds, whichever comes first.
2. Snapshot on room idle timeout and before Durable Object eviction when possible.
3. Keep rolling checkpoints (latest + previous K).
4. Garbage collect stale update segments after checkpoint compaction.

## Identity and Permissions

## Identity

1. User signs in through your auth provider.
2. Worker verifies JWT/session and resolves stable user ID.
3. Durable Object receives user claims in handshake context.

## Authorization Model

Roles:

1. Owner: full control and sharing.
2. Editor: read/write.
3. Viewer: read-only.

Permissions enforced at two layers:

1. API layer issues room token only when authorized.
2. Durable Object checks token claims before accepting edit updates.

## Presence Model

Presence is not persisted as document content.

Presence payload examples:

1. User display name and color.
2. Cursor position.
3. Selected glyph/layer/component context.
4. Optional typing indicators.

Awareness best practices:

1. Rate-limit high-frequency cursor updates.
2. Drop stale presence on disconnect timeout.

## Undo/Redo in Multi-User Context

Default recommendation:

1. Keep undo local-user scoped in collaborative sessions.
2. Avoid global undo across users in Phase 1.

Rationale:

1. Global undo in collaborative contexts is usually surprising and can revert other users unexpectedly.

Implementation guideline:

1. Use per-client undo semantics in UI.
2. Keep server state CRDT-convergent; undo emits forward CRDT updates.

## Data Model (D1)

Example minimal schema:

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT,
  display_name TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  latest_checkpoint_version INTEGER NOT NULL DEFAULT 0,
  latest_checkpoint_ref TEXT,
  FOREIGN KEY (owner_user_id) REFERENCES users(id)
);

CREATE TABLE document_members (
  document_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (document_id, user_id),
  FOREIGN KEY (document_id) REFERENCES documents(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE document_events (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  actor_user_id TEXT,
  event_type TEXT NOT NULL,
  payload_json TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (document_id) REFERENCES documents(id)
);
```

Note:

1. Do not store raw high-frequency Yjs deltas one row per operation in D1.
2. Store event metadata and checkpoint references instead.

## Durable Object Room State

In-memory fields:

1. Y.Doc instance.
2. Current version counter.
3. Connected clients map (client ID, user ID, role).
4. Last checkpoint timestamp/update count.

Optional persistent fields:

1. Latest checkpoint reference.
2. Last applied update sequence marker.

## Wire Protocol (WebSocket)

Message categories:

1. auth
2. sync-state-request
3. sync-state-response
4. yjs-update
5. awareness-update
6. ack and error
7. ping and pong

Rules:

1. Reject yjs-update from viewer role.
2. Validate binary payload size and rate limits.
3. Broadcast only after successful apply.

## Late Join and Reconstruction

Expected behavior:

1. Joiner receives latest checkpoint Yjs state.
2. Optionally receives trailing updates newer than checkpoint.
3. Local client derives latest JSON/model from Yjs and renders current font.

Yes, this means a late joiner effectively gets the full latest font state reconstructed from Yjs.

## Consistency and Recovery

## Consistency

1. CRDT convergence from Yjs is source of truth.
2. Rust interpolation/cache refreshed from current font JSON post-apply.

## Recovery Plan

1. Durable Object cold start loads latest checkpoint.
2. If checkpoint missing/corrupt, recover from previous checkpoint + retained segments.
3. If all fail, fail closed and surface restoration workflow.

## Security and Abuse Controls

1. Signed room tokens with short TTL.
2. Origin checks and CSRF-safe handshake flow.
3. Per-user and per-room rate limits.
4. Payload size caps and binary validation.
5. Audit events for permission changes and destructive actions.

## Performance Targets

Initial SLO candidates:

1. P50 local-to-remote edit visibility under 150 ms.
2. P95 join-to-editable state under 2 s for typical font size.
3. P99 update apply loop under 50 ms on hot room.

## Observability

Metrics:

1. Connected users per room.
2. Update throughput and payload sizes.
3. Snapshot latency and interval drift.
4. Join hydration duration.
5. Reconnect success rate.
6. Durable Object restart frequency.

Logs:

1. Auth and authorization decisions.
2. Checkpoint creation and restore operations.
3. Protocol errors and dropped updates.

## Rollout Plan

## Phase A: Single-room MVP (internal)

1. Durable Object room with WebSocket updates.
2. Basic auth token check.
3. Full-state checkpoint save/load.
4. Editor can join and co-edit with two users.

## Phase B: Private beta

1. Membership roles and share links.
2. Presence and user badges.
3. Reconnect and partial sync via state vectors.
4. Operational dashboards and alerting.

## Phase C: Production hardening

1. Snapshot compaction and retention policy.
2. Abuse controls and quotas.
3. Version history checkpoints and restore UI.
4. Billing hooks if needed.

## Testing Strategy

1. Unit tests for protocol and auth guards.
2. Integration tests with multi-client CRDT convergence.
3. Soak tests for long-lived rooms.
4. Chaos tests for disconnect/reconnect and Durable Object restarts.
5. Load tests for large fonts and many awareness updates.

## Open Decisions

1. Auth provider and token format.
2. Snapshot store: Durable Object storage only vs R2 for large blobs.
3. Version history retention window and UX.
4. Commenting/review mode in early phases or later.
5. Billing and quota boundaries per workspace/document.

## Recommended Immediate Next Step

1. Build a proof-of-concept Durable Object provider for one document room and verify end-to-end with two browsers editing the same font in real time.

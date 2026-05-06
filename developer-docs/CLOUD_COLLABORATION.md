# Cloud Collaboration — Developer Reference

This document is the implementation companion to
`strategy/LIVE_COLLABORATION_v2.md`.

It records:

- what exists today;
- what is now considered legacy;
- what the next implementation steps are;
- what to avoid while the migration is in progress.

---

## Current State

Phase 1 from the original plan is complete.

What exists today:

- Cloud filesystem plugin in the editor.
- Eligibility gating and admin overrides.
- D1-backed asset and folder CRUD.
- ACL-backed room-token issuance.
- Live Cloudflare room runtime built around one Durable Object per asset.
- Local end-to-end collaboration workflow validated against the real local
  stack.
- Large serialized asset state currently chunked across SQLite blobs.

This state is functional enough to prove the product path, but it is not the
finished architecture.

---

## Active Direction

The project is moving to:

- Cloudflare Pages + D1 + R2 as control plane and blob storage.
- Cloudflare Durable Objects as the active hot room runtime.
- R2 as the canonical store for bootstrap blobs, snapshots, glyph snapshots,
  and rebases over time.
- transport routing based on committed mutation footprint, not feature origin.

In practice:

- do not deepen the chunked SQLite blob path;
- do not rewrite the runtime away from Durable Objects before telemetry justifies
  it;
- do not special-case Python for routing decisions.

---

## Legacy Components

These components are legacy and should be treated as migration surfaces:

- chunked SQLite blob storage for large serialized font state;
- assumptions that every meaningful mutation should be delivered as a single
  ordinary live room delta.

Legacy does not mean immediately deleted. It means:

- compatibility may temporarily remain;
- no new architecture should depend on it;
- cleanup is part of the active plan.

---

## Runtime Split

### Cloudflare

Owns:

- auth;
- asset CRUD;
- ACLs and membership;
- room-token issuance;
- live room runtime through Durable Objects;
- D1 metadata;
- history index rows;
- R2 object storage;
- admin controls and migration bookkeeping.

### External Executor

Owns:

- heavy full-font materialization;
- large mutation processing when ordinary live routing is unsafe;
- staged commit or rebase output.

External execution is optional. It is not the default live room runtime.

---

## Mutation Routing Rule

All committed logical transactions are routed by footprint.

The router should inspect:

- encoded delta bytes;
- glyph count touched;
- layer count touched;
- scope kind;
- whether full-font materialization is required;
- projected fan-out cost.

Routing outcomes:

1. `live-delta`
2. `staged-commit`
3. `rebase`

Important: the cause of the change is not the routing key.

Small Python changes stay small. Large non-Python changes still escalate.

---

## Undo Rule

Personal undo remains local in the editor.

When undo results in a committed forward change, that committed transaction is
routed by footprint exactly like any other change.

Do not build a separate transport regime for undo.

---

## Immediate Implementation Priorities

### 1. Retire chunked SQLite blobs

- Reassemble each asset's current chunked serialized state once.
- Write a canonical bootstrap blob to R2.
- Store the canonical R2 reference in metadata.
- Stop reading the old chunked representation after migration.

### 2. Stabilize the live DO runtime

- Add room open, reconnect, and persistence telemetry.
- Stop using undocumented memory-limit claims as architecture facts.
- Define operational guidance for suspiciously large rooms based on measured
  behavior.

### 3. Add mutation classification

- Classify committed logical transactions.
- Implement staged commit transport.
- Implement rebase transport.

### 4. Reconnect history and snapshots

- Store snapshots and glyph snapshots in R2.
- Keep `font_asset_versions` and `font_asset_events` in D1.
- Preserve restore as a forward operation.

---

## Actionable Checklist

- [x] Cloud filesystem plugin in the editor.
- [x] Eligibility gating and admin overrides.
- [x] D1-backed asset and folder CRUD.
- [x] ACL-backed room-token issuance.
- [x] Live Durable Object room runtime.
- [x] Local collaboration smoke workflow.
- [ ] Freeze new work on the legacy chunked-SQLite path.
- [ ] Define canonical R2 key layout for bootstrap blobs and snapshots.
- [ ] Implement one-shot asset migration from chunked SQLite to canonical R2.
- [ ] Record migration completion per asset in metadata.
- [ ] Add basic room open, reconnect, and persistence telemetry.
- [ ] Define mutation classification thresholds.
- [ ] Implement `live-delta`, `staged-commit`, and `rebase` routing.

---

## Operational Guidance

During the current Durable Object phase:

- measure open time, snapshot time, rebase time, and reconnect time from day
  one;
- classify suspicious rooms by observed behavior, not by undocumented hard
  memory numbers;
- keep large canonical blobs out of the DO steady-state path once R2 bootstrap
  is available.

---

## What Not To Build Next

Avoid these until the new baseline is stable:

- more features that depend on the current chunked DO blob layout;
- feature-specific routing logic for Python;
- premature runtime replacement before the current DO path is properly
  instrumented;
- long-term retention logic built on SQLite chunks.

---

## Success Criteria

The migration is on track when:

- a migrated asset opens from R2;
- the editor still connects through the DO-based room path cleanly;
- two browsers converge on the migrated asset;
- small edits remain live;
- large edits can escalate to staged commit or rebase;
- history metadata still lands in D1;
- the old chunked SQLite bootstrap path is no longer on the critical path.

---

## Local Development Workflow

Local collaboration development now happens against the real local stack before
any deployment work.

Local components:

- editor on `https://localhost:8000`
- website control plane on `http://localhost:8788`
- room worker on `http://localhost:8787`

Primary commands from the repo root:

- `npm run dev:collab:local`
- `npm run test:collab:local`

The editor exposes a local auth bootstrap helper for development and tests:

- `window.cloudDebug.bootstrapLocalSession('dev@counterpunch.test')`

That helper creates a local session token, grants cloud eligibility in the
local website database, stores `editor_session`, and refreshes the editor auth
state.

Important local auth rule:

- cloud API calls from the editor must send `Authorization: Bearer
  <editor_session>` explicitly; do not rely on cross-port localhost cookie
  propagation alone.

The local browser workflow that must stay green is:

1. bootstrap a local cloud session
2. load a font in the editor
3. save it to the local cloud asset path
4. reopen the same asset in a second page
5. perform a real glyph mutation in page A
6. verify page B receives the remote Yjs apply and converges on the same model

This workflow is covered by `webapp/tests/cloud-collaboration-local.spec.ts`.

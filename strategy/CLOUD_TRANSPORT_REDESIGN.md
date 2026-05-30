# Cloud Transport Redesign

A working document to collect and refine the next architecture for reliable cloud
collaboration transport. This is a **living design doc** — proposals here are
provisional and open to revision.

---

## Problem

The current WebSocket-based transport suffers from frequent disconnections
during both idle periods and active editing. Two browser windows connected to
the same room drop and reconnect roughly every minute.

## Architecture constraints (from CF docs)

### Lifecycle state machine

A Durable Object transitions through these states:

| State | Description |
|---|---|
| **Active, in-memory** | Running, handling requests. |
| **Idle, in-memory non-hibernateable** | Waiting for next event but cannot hibernate. |
| **Idle, in-memory hibernateable** | Eligible for hibernation. Hibernates after **10 seconds** of inactivity. |
| **Hibernated** | Removed from memory. WebSocket connections stay connected at the edge. |
| **Inactive** | Fully evicted from the host. May need cold start. |

Hibernation is only possible when ALL of these are true:
1. No `setTimeout`/`setInterval` scheduled callbacks.
2. No in-progress awaited `fetch()`.
3. No standard (non-Hibernation) WebSocket API in use.
4. No request/event is still being processed.

**Eviction** from non-hibernateable state happens after **70–140 seconds** of
**no incoming requests or events** — meaning any WebSocket message, alarm
firing, or fetch resets this timer.

### Alarm behavior

- `ctx.storage.setAlarm()` prevents hibernation while pending (per pricing FAQ).
- The alarm handler has a **15-minute wall time limit** (not 30 seconds like
  regular requests).
- `alarm()` has guaranteed at-least-once execution with exponential backoff
  retry on failure (up to 6 retries starting at 2s delays).
- A new alarm set inside the alarm handler keeps the DO non-hibernateable
  until that alarm fires.

### WebSocket limits

- Maximum **32,768** WebSocket connections per DO (Hibernation API).
- Cloudflare auto-responds to WebSocket **protocol-level ping frames** without
  waking the DO. The `webSocketMessage` handler is NOT called for control
  frames.
- `setWebSocketAutoResponse(request, response)` allows matching application-
  level messages and auto-responding without waking the DO. Both request and
  response are limited to **2,048 characters** each.

### CPU time

- **30 seconds** per invocation (HTTP request, WebSocket message, alarm).
- Each new incoming message resets the 30-second budget.
- Configurable up to 5 minutes via `limits.cpu_ms` in wrangler config.

---

## Root cause analysis

### Theory A: App-level heartbeat prevents hibernation (confirmed harmful)

The client sends `{type: "ping"}` every 20 seconds. Each ping:
1. Wakes the DO from hibernation (protocol-level pings are free, but the
   JSON ping is a WebSocket message that hits `webSocketMessage`).
2. Takes ~10ms to process and send pong.
3. Keeps the DO alive for another 10 seconds (hibernation delay timer)
   before it can hibernate again.
4. Is a billable WebSocket message request (20:1 billing ratio, but still
   wasteful).

**Net effect:** With 2 clients pinging every 20s, the DO is awake ~50% of
the time doing nothing useful. Over an hour: ~180 unnecessary wake-ups.

### Theory B: Chain-scheduled alarms keep the DO non-hibernateable

During the initial font sync, dirty journal rows are written to SQLite.
`_scheduleCheckpointAlarm()` is called, which calls `_setAlarmIfEarlier()`.
This sets an alarm at t+60s (the `IDLE_CHECKPOINT_MS`).

The alarm fires at t+60s. Inside the alarm handler, `_checkpointToR2()` runs,
and afterward `_scheduleCheckpointAlarm()` is called again — setting a new
alarm.

**Result:** As long as `_dirtyRowCount > 0`, the DO chain-schedules alarms
60s apart and **can never hibernate**. It stays non-hibernateable
indefinitely, incurring duration charges and staying vulnerable to runtime
eviction should the pings ever stop or the DO become overloaded.

With app pings every 20s, the 70–140s eviction timer keeps resetting, so
eviction itself is unlikely during active ping traffic. But the DO never
hibernates either.

### Theory C: Checkpoint validation blocks message processing

`_checkpointToR2()` runs:
```
R2 PUT snapshot → R2 PUT history → validate (sync CPU) → R2 PUT manifest → SQLite cleanup
```

The validation step creates a fresh Y.Doc, applies the full state, calls
`.toJSON()` on the entire font, JSON.stringify's it, and runs the Rust
validator. For a 200 MB font, this could take **10–30+ seconds** of
synchronous CPU on the DO's single thread.

During this time, ALL incoming WebSocket messages are queued, not processed.
If the DO has two clients pinging every 20s and the checkpoint blocks for
30s, the following happens:

```
t=0:   Alarm fires, checkpoint starts.
t=20:  Client A sends ping → QUEUED (DO busy)
t=30:  Validator finishes (hypothetical).
t=30:  DO processes queued ping, sends pong.
t=40:  Checkpoint finishes, alarm rescheduled.
t=50:  Client B's heartbeat timeout fires (50s from last pong at t=0)
       → CLOSE + RECONNECT
```

Both clients can cascade-fail if the blocking overlaps both their heartbeat
windows.

**But during idle with no changes**, the checkpoint should be small/fast.
Unless the *first* checkpoint after font load has to process the entire font
state. This would happen once after initial seed/load, and then again
whenever the DO restarts (deploy, eviction).

### Punctuation: alarm retry exponential backoff

If the alarm handler throws an exception, the runtime retries it with
exponential backoff starting at 2 seconds, for up to 6 retries. Each retry
wakes the DO again and runs `_checkpointToR2()` from the top. If the
validation is the thing that's failing (e.g., hitting a CPU timeout), this
creates a retry storm: wake → fail → 2s → wake → fail → 4s → ...

### Putting it together: the most likely disconnect chain

The "every minute" pattern during idle is most likely:

```
t=0:    Font loaded. Dirty rows. Alarm at t+60s.
t=0-60: App pings keep DO awake. Non-hibernateable (alarm pending).
t=60:   Alarm fires. _checkpointToR2() starts.
t=60-90: Validator runs on full font state. All pings queued.
t=85:   Client heartbeat times out (50s since last pong confirmed)
        → Client closes socket with code 4000 'heartbeat-timeout'
t=90:   Checkpoint finishes. DO processes queued pings.
t=90:   Both clients have already reconnected (3s delay), starting new sync.
        Dirty rows again. Alarm at t+150s.
```

The same pattern repeats every ~90 seconds because the checkpoint takes
~30s and the client's heartbeat timeout is 50s — if the checkpoint overlaps
with the last-acknowledged pong being >50s old, the client gives up.

### What about the edit triggering disconnects?

When a live edit arrives:

1. `_handleUpdate()` applies the update to Y.Doc.
2. Writes to SQLite `room_log`.
3. Calls `_scheduleCheckpointAlarm()`.
4. If dirty row count exceeds `CHECKPOINT_DELTA_ROWS_THRESHOLD` (2000),
   the alarm is set for **just 1 second later**.
5. That alarm fires almost immediately and runs `_checkpointToR2()`.
6. Validation blocks for seconds.
7. All peers' pings queue up during that blocking window.
8. If any peer's heartbeat timeout expires → disconnect.

This is why an edit can trigger both clients to drop simultaneously — the
edit pushed dirty data over the threshold, triggering an immediate
checkpoint that blocks the DO during active use.

---

### Theory D: Checkpoint validation is overkill for the actual risk

The Rust font validator (`checkpoint-validator.js` → WASM) is the heaviest
single operation in the DO. It was designed to prevent corrupt font state from
being permanently checkpointed to R2. But the actual failure modes are:

| Failure | Catches it? | Real risk |
|---|---|---|
| Truncated/bad Yjs binary | No — Yjs.applyUpdate already throws | None (DO rejects before write) |
| SHA mismatch on R2 read | No — manifest checksum does this | None |
| Semantically bad font data (NaN width, bad ref) | Yes — if Rust catches it | Low — editor must handle it anyway |
| Journal replay diverges from live state | No — only checks live state | None (diff check in debug endpoint) |

The validator's cost during a checkpoint is 10–30+ seconds of blocking the
DO's single thread. Its benefit is catching edge-case semantic corruption
that the editor would need to handle gracefully anyway (because the editor
runs in the browser alongside a live WASM font compiler that has its own
validation).

If we move the validation out of the checkpoint path entirely, the blocking
problem disappears regardless of the two-phase approach (P3).

---

## Proposals

### P1: Eliminate the application-level heartbeat

The Cloudflare runtime already auto-responds to WebSocket protocol ping
frames without waking the DO. The app-level `{type: "ping"}` is redundant
and actively harmful.

**Action:**
- Remove the JSON ping/pong cycle from `cloud-adapter.ts`.
- Alternatively: use `ctx.setWebSocketAutoResponse()` on the DO side to
  auto-respond to the JSON ping format without waking the DO. This would
  preserve the existing client code path while making it harmless.
  - The ping format `{type:"ping",sentAt:...}` is well under the 2048
    character limit.
  - Set it once after the first auth: `ctx.setWebSocketAutoResponse(
      '{"type":"ping"}', '{"type":"pong"}')`.
  - This is the lowest-risk option since it changes nothing on the client.

**Open questions:**
- How does the client detect stale connections without a heartbeat? The DO's
  `webSocketClose()` fires when a peer drops — the client can rely on the
  browser's native WebSocket close event.
- The client connection health reporting currently depends on heartbeat
  metrics. Replace with WebSocket state + last-inbound-message timestamp.

### P2: Direct R2 checkpoint download for cold-start Y.Doc sync

When a client connects with no prior Y.Doc state (new tab, page reload), the
current protocol sends `sync-request` → DO computes the full diff from empty
→ responds with the entire state in chunked WebSocket frames. For a font
whose JSON source is hundreds of MB, this means:

- DO spends CPU encoding the full state.
- DO spends CPU base64-encoding and chunking.
- DO spends wall time streaming N frames over the WebSocket.
- Client receives N chunks, base64-decodes, reassembles.

All of this goes through the DO's single thread, blocking other message
processing.

**Proposal:** Fetch the checkpoint snapshot directly from R2 instead.

1. The room-token response (or a brief DO HTTP interaction) includes a URL
   or key identifying the latest valid checkpoint in R2.

2. The client fetches the snapshot from R2 as a regular HTTPS download
   (streaming, no chunking, no DO involved).

3. The client applies the snapshot to its local Y.Doc:
   `bridge.applyFullState(snapshot)`.

4. The client then sends `sync-request` over WebSocket as usual — but now
   its state vector is very close to current. The missing diff is only the
   small set of incremental updates since the last checkpoint. No chunking
   needed.

**Benefits:**
- The DO never has to serialize or transmit the full state over WebSocket.
- R2 downloads are fast, streamable, and don't consume DO CPU or wall time.
- The incremental WebSocket diff is tiny (often zero).
- The chunked sync path becomes dead code for large payloads.

**Open questions:**
- How does the client discover the R2 snapshot location?
  - Option A: Return it in the room-token API response from the website.
  - Option B: The client makes a brief HTTP GET to the DO before opening
    the WebSocket.
  - Option C: Embed it in the WebSocket's `auth-ok` response as a new field.
- Does the R2 bucket need to be publicly readable, or can the client use a
  pre-signed URL? The room token could include a short-lived signed URL.
- How does the client know it's a cold start vs. reconnect? A cold start has
  no local Y.Doc state (empty bridge), so `encodeBridgeStateVector()` returns
  an empty vector. The client can skip R2 preload and just do the normal
  WebSocket sync if the vector is non-empty (meaning the bridge's Y.Doc
  survived the disconnect).

### P3: Move font validation out of the DO and into the client

Currently, the Rust font validator runs inside the DO during every checkpoint,
blocking the single thread for 10–30+ seconds. Its purpose is to reject
checkpoints that contain semantically corrupt font data (e.g., NaN values,
broken references).

**Why the DO is the wrong place for this:**

1. **Corruption can only arrive from a client.** The DO never mutates the
   Y.Doc itself — it only applies Yjs updates sent by clients. If the data
   is bad, it was already accepted by the client's own font model and WASM
   compilation pipeline. The editor already runs the exact same Rust
   validation during normal font compilation and editing.

2. **The checkpoint is a faithful snapshot of the Y.Doc.** If the Y.Doc
   contains bad data, the snapshot will too. Rejecting the checkpoint doesn't
   fix the data — it just enters degraded-persistence mode, which prevents
   *any* future checkpoints and lets the journal grow unbounded.

3. **The editor must handle bad data anyway.** Remote peers can send edits
   that produce intermediate states that don't make sense in isolation
   (e.g., a glyph width temporarily set to 0 during a drag operation that
   spans multiple Yjs updates). The editor already tolerates this. If it
   can't, that's a bug in the editor, and the validator is masking it.

4. **The Yjs binary is structurally validated by Yjs itself.**
   `Y.applyUpdate()` throws on corrupt binary — the DO already catches this
   in `_applyAndJournalUpdate()`. The only validator gap is semantic font
   validity, which is the editor's domain.

**Where validation should live instead:**

- **On font load.** When a client opens a font (from R2 checkpoint, from
  disk, or from a peer), the font data is already validated through the
  normal WASM compilation pipeline. If the data is corrupt, the compilation
  step surfaces errors that the editor can display to the user. This is the
  right time to validate — when a human can see the error and act.

- **On explicit user action.** "Validate font" as a user-invoked feature
  (like FontGoggles' validation panel). This is a product feature, not a
  storage correctness concern.

- **On the client side of checkpoint upload (P4).** If the client uploads
  the Yjs state directly to R2 for seeding, it can run the validator in its
  own WASM worker before uploading. This keeps validation in the browser's
  thread pool and doesn't block any DO. The DO only needs to confirm the
  binary is valid Yjs (which `Y.applyUpdate` already covers).

**What the DO should replace the validator with:**

A cheap structural integrity check that runs in JavaScript, not WASM:

```javascript
async _validateCheckpointCandidateSnapshot(snapshot) {
    const doc = new Y.Doc({ gc: false });
    Y.applyUpdate(doc, snapshot);     // throws on corrupt binary
    
    const fontMap = doc.getMap("font");
    const fontJson = fontMap.toJSON();
    
    if (!fontJson || typeof fontJson !== 'object') {
        return { ok: false, errors: [{ code: "invalid_font_type", ... }] };
    }
    
    const topKeys = Object.keys(fontJson);
    if (topKeys.length === 0) {
        return { ok: false, errors: [{ code: "empty_font", ... }] };
    }
    
    return { ok: true, validatorKind: "inline-yjs", errors: [] };
}
```

This runs in **milliseconds**, not seconds. It verifies the only invariant
the DO needs to enforce: "is this a valid Yjs document containing something
that looks like a font object?" Everything else is the editor's
responsibility.

**The full pipeline becomes:**

```
Client produces edit → editor validates normally → Yjs update sent to DO
→ DO applies to Y.Doc → journals to SQLite
→ checkpoint writes snapshot to R2 (fast, no blocking)
→ cheap structural check in JS (milliseconds)
→ manifest promoted
```

The heavy Rust validator never runs in the DO. It runs in the browser, only
when the user or the editor explicitly calls for it, on the client's own
thread pool.

---

### P4: Two-phase checkpoint validation

`_checkpointToR2()` currently does everything inline:

```
R2 PUT snapshot  →  R2 PUT history  →  validate (sync CPU)  →  R2 PUT manifest
```

**Proposal:** Split into two phases:

1. Write snapshot + history to R2 (fast, no validation).
2. Set a short alarm (e.g., 1 second).
3. Return from `_checkpointToR2()` — DO can now process queued messages.
4. On the next alarm tick, validate (using the cheap JS structural check
   from P3) and promote the manifest.

The snapshot is safe in R2 after step 1. If validation fails, the DO
enters degraded-persistence mode (as it already does). The stalled pings
are the real casualty, and this fix prevents that.

**Note:** The alarm handler has a 15-minute wall time limit (not 30s). This
is fine for even the original expensive validation — we just need to yield
so pings get through.

### P5: Seed fonts into the DO Room via R2 directly (reverse direction)

Currently, "Save As" cloud upload works like this:

1. Client serializes the full font.
2. Font compilation wasm processes it.
3. Client creates a Y.Doc from it.
4. Client opens WebSocket to the DO room.
5. Yjs two-phase sync sends the **entire font state** as `sync-complete`:
   - Serialized, base64-encoded, split into 750 KB chunks.
   - DO receives, base64-decodes, validates, accumulates, reassembles,
     applies, writes N rows to SQLite.

For a hundreds-of-MB font this means N chunks, N SQLite inserts, the DO
blocked on single-threaded chunk processing.

**Proposal:** Seed via R2 instead:

1. Client uploads the Yjs state directly to a temporary R2 path
   (`font-assets/{assetId}/seed/{sessionId}.yjs`) via a pre-signed upload
   URL. The upload goes directly to R2, bypassing the DO entirely.

2. Client sends a single WebSocket message:
   ```
   { type: "seed-from-r2", r2Key: "font-assets/{assetId}/seed/{sessionId}.yjs" }
   ```

3. DO reads the Yjs state from R2 in one operation
   (`ROOM_STATE_BUCKET.get(r2Key)`).

4. DO applies `Y.applyUpdate(this.yDoc, snapshot)`.

5. DO writes a single journal entry to SQLite.

6. DO deletes the temporary seed blob from R2.

7. DO broadcasts the update to other peers.

**Benefits:**
- No chunked WebSocket upload.
- No base64 encoding/decoding of multi-MB data.
- The DO does one R2 read instead of processing N chunks.
- The client uploads directly to R2 in parallel with other work.

**Open questions:**
- How does the client get the pre-signed R2 upload URL? The room-token
  response could include it alongside the WebSocket room URL.
- Fallback: if R2 upload fails, fall back to the current WebSocket chunked
  protocol.
- Do we build the client Y.Doc fresh in the browser or serialize from the
  WASM worker? The `Y.encodeStateAsUpdate()` output from the client bridge
  is what gets uploaded.
- Seed path lifecycle: apply a TTL or lifecycle policy to the `seed/`
  prefix so orphaned uploads are cleaned up automatically.

### P6: Stop preventing hibernation by chain-scheduling alarms

Currently, the DO chain-schedules alarms 60s apart as long as dirty rows
exist, keeping it permanently non-hibernateable.

**Likely the single most impactful change of the smaller proposals.**

Approach: **Don't set a checkpoint alarm unless there is actual checkpoint
work to do.**

- The immediate threshold alarm (dirty rows >= 2000 or dirty bytes >= 8 MB)
  is needed — that's an urgent write to prevent data loss.
- The idle timeout alarm (60s) can be increased significantly or deferred
  to only fire when the last connected peer disconnects (`webSocketClose`).
- The 30-minute safety max alarm (30 × 60 × 1000 ms) can remain as a
  safety net for crash recovery.

Better: Instead of scheduling the alarm proactively, schedule it from
`webSocketClose` when the last peer disconnects. This way, the DO
checkpoints on disconnect (or shortly after), then has no pending alarm
and can hibernate until the next peer connects.

### P7: Use `setWebSocketAutoResponse` for client keep-alive

Cloudflare provides an API that achieves the same effect as P1 without
changing client code:

```javascript
this.ctx.setWebSocketAutoResponse(
    '{"type":"ping"}',
    JSON.stringify({ type: "pong", serverTime: Date.now() })
);
```

This matches incoming JSON pings and auto-responds without calling
`webSocketMessage` or waking the DO. The response string is static, so
`sentAt` echo wouldn't be dynamic — but the client doesn't currently use
`sentAt` for anything critical (the heartbeat timeout uses its own
`_pendingHeartbeatSentAt` timestamp).

**Limitation:** The auto-response is static (2048 char limit per CF docs).
The `sentAt` field would be stale, but the pong confirms the connection is
alive at the transport level, which is all the client really needs.

### P8: Narrow the DO role to live-relay only

If P2 (R2 cold-start sync) and P5 (R2 seeding) are implemented, the DO's
role narrows to **relaying incremental live edits between peers**. The
full font state lives in R2 checkpoints and is transferred directly between
R2 and the client.

With this narrower role:
- The SQLite `room_log` only spans incremental updates between checkpoints.
- Checkpoints become cheap (no full-state snapshot to serialize).
- Between live edits, the DO can hibernate fully (no alarm chain, no dirty
  data unless someone is actively editing).
- The DO is no longer the source of truth — R2 is.

This is an architectural reframe that reduces DO cost, improves reliability,
and makes the system more resilient to DO evictions (since a new DO can
always be rebuilt from R2 checkpoints).

---

## Implementation priorities (tentative)

| Priority | Proposal | Effort | Impact |
|----------|----------|--------|--------|
| 1 | **P1**: Remove app heartbeat / use auto-response | Small | Reduces wake-ups, cuts cost |
| 2 | **P6**: Stop chain-scheduling alarms | Small | Lets DO hibernate between checkpoints |
| 3 | **P3**: Move validation out of DO | Small | Eliminates the blocking bottleneck |
| 4 | **P5**: R2 direct seeding | Medium | Makes initial font upload fast and reliable |
| 5 | **P2**: R2 checkpoint download for cold-start sync | Medium | Makes reconnect fast and reliable |
| 6 | **P4**: Two-phase checkpoint validation | Medium | Prevents blocking during checkpoints |
| 7 | **P7**: `setWebSocketAutoResponse` | Small | Belt-and-suspenders for zero-wake keepalive |
| 8 | **P8**: Narrow DO role to live-relay only | Large | Architectural reframe |

---

## Next

What do you want to refine first?
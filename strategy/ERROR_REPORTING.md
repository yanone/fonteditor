# Error Reporting Strategy

## Status

Planned only. No automatic server reporting is implemented yet.

## Goal

Send high-value, privacy-safe error reports from the editor to a backend endpoint so production issues can be diagnosed with source-mapped stacks and recent state context.

## Reporting Intentions

### 1) Trigger Conditions

Report only on:

- Unhandled runtime errors (`window.error`)
- Unhandled promise rejections (`window.unhandledrejection`)
- Explicitly marked critical failures (manual `captureError(...)` calls)

Do not report normal state changes.

### 2) Payload Shape

Use current `StateManager` report as baseline:

- `error.message`
- `error.stack` (source-mapped when possible)
- `timestamp`
- `state` (current app state snapshot)
- `history` (last 30s state deltas)

Add metadata:

- `appVersion`
- `buildHash` (if available)
- `url`
- `userAgent`
- `sessionId` (ephemeral UUID)

### 3) Privacy & Data Minimization

Before sending:

- Redact long text fields (e.g. truncate `editor_text_buffer`)
- Remove local file paths and potential personal identifiers from state
- Keep only required debug fields
- Cap history length and payload size

Default stance: collect the minimum needed to reproduce errors.

### 4) Reliability & Transport

Delivery strategy:

- Prefer `navigator.sendBeacon` for crash/unload scenarios
- Fallback to `fetch(..., { keepalive: true })`
- Queue unsent reports in memory (optional later: IndexedDB)
- Retry with bounded backoff

Set hard limits:

- Max report size (e.g. 64KB target)
- Max retries per report

### 5) Noise Control

Avoid flooding backend:

- Client-side dedupe by fingerprint (`message + top frame + version`)
- Per-session rate limit (e.g. max N reports/minute)
- Sample repeated identical errors

### 6) Backend Contract (Planned)

Single endpoint:

- `POST /api/error-report`

Backend responsibilities:

- Validate schema and size
- Store raw report safely
- Enrich with server receipt timestamp
- Support querying by fingerprint/version

### 7) Observability

Track:

- Accepted vs rejected reports
- Top fingerprints by frequency
- Regression by app version
- Mapping quality (mapped vs unmapped stacks)

### 8) Rollout Plan

1. Implement local sanitizer + serializer
2. Add transport with feature flag disabled by default
3. Enable in preview environment
4. Validate payload quality and noise levels
5. Enable for production with conservative rate limits
6. Tune dedupe/sampling based on observed volume

## Non-Goals (for first rollout)

- Full crash replay
- Session video capture
- Capturing complete user files/font binaries
- Sending every warning/log event

## Open Decisions

- Final backend location (`cloudflare-worker.js` vs dedicated worker route)
- Retention period for stored reports
- Whether user IDs are attached, hashed, or omitted
- Exact redaction rules for editor text and state blobs

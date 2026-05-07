# State Round-Trip Risk Patterns

## Purpose

This note captures the risk class exposed by the recent cloud-asset corruption
bug so we can revisit it with a focused research pass later.

The key lesson is simple:

- omitted data is not the same as explicitly empty data;
- partial editor state is not always safe to treat as canonical full state;
- round-trip paths can turn a local semantic mistake into durable corruption.

---

## Core Risk Pattern

Several editor paths operate on partially materialized layer data.

That is valid only if the system preserves the distinction between:

- field omitted because it is inherited, unchanged, or not materialized here;
- field present with an explicit empty value;
- field present with an explicit scalar default.

The dangerous failure mode is:

1. partial state is normalized;
2. normalization invents defaults such as `[]` or `0`;
3. those invented defaults are later treated as authoritative exact data;
4. the result is saved, synced, cached, or reloaded as real state.

This can silently convert absence into destructive intent.

---

## Hotspots

The highest-risk areas are the boundaries where state changes representation:

- exact-layer vs interpolated-layer switching;
- editor working copy vs model object sync;
- JSON normalization;
- save serialization;
- Yjs or other sync bridges;
- worker-cache refresh and compile bootstrap;
- nested component `layerData`;
- undo and redo replay from partial snapshots.

These paths deserve extra suspicion whenever they materialize defaults,
flatten structure, or merge partial payloads.

---

## Why This Surfaced Late

This class of bug can stay hidden for a long time because ordinary editing may
appear correct.

It tends to surface only when all of the following line up:

- a partial representation is considered acceptable locally;
- a later step interprets it as exact authoritative state;
- the state is persisted or rebroadcast;
- a reload, compile, or remote consumer is stricter than the original editor
  path.

That combination is cross-cutting and easy to miss without explicit tests.

---

## Research Questions

If we do a broader hardening round later, focus on these questions:

- Where do we normalize partial state into full-shape objects?
- Which serializers synthesize defaults for omitted fields?
- Which merge paths delete missing keys instead of preserving omission?
- Which caches or bridges treat partial payloads as canonical snapshots?
- Where do nested structures repeat the same mistake one level deeper?
- Which compile or validation paths assume exact complete default-master data?

---

## Recommended Invariants

Future work should protect these invariants:

- Omitted fields stay omitted unless a path is intentionally materializing a
  full authoritative layer.
- Exact-layer refresh must not destroy existing authoritative geometry because a
  refresh payload is partial.
- Serialization must not invent destructive empties for omitted collections.
- Sync bridges must distinguish explicit removal from ordinary omission.
- Diagnostics should compare semantic state, not only raw payload shape.

---

## Useful Hardening Work

The most valuable next research or QA work is likely:

- save and reload round-trip tests for omitted vs explicit empty fields;
- undo and redo tests that replay partial snapshots;
- nested component layer-data tests;
- exact/interpolated switching tests with partial layer payloads;
- targeted state-fingerprint diagnostics for local state vs synced state.

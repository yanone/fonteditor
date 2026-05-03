---
name: gortex-js
description: "Work in the js area — 27 symbols across 1 files (36% cohesion)"
---

# js

27 symbols | 1 files | 36% cohesion

## When to Use

Use this skill when working on files in:
- `webapp/js/change-bridge.ts`

## Key Files

| File | Symbols |
|------|---------|
| `webapp/js/change-bridge.ts` | ChangeBridge, _txId, _txBufferedOperations, _txHistoryTarget, _fontJson, ... |

## How to Explore

```
get_communities with id: "community-364"
smart_context with task: "understand js", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._

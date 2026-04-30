---
name: gortex-js
description: "Work in the js area — 34 symbols across 1 files (50% cohesion)"
---

# js

34 symbols | 1 files | 50% cohesion

## When to Use

Use this skill when working on files in:
- `webapp/js/font-info.ts`

## Key Files

| File | Symbols |
|------|---------|
| `webapp/js/font-info.ts` | FontInfoManager, prefixCodeData, searchInput, featureErrorLineWidget, namesTab, ... |

## How to Explore

```
get_communities with id: "community-449"
smart_context with task: "understand js", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._

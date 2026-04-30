---
name: gortex-impact
description: "Use when you need blast-radius analysis, change safety checks, or to know what depends on a function, type, or file before editing. Keywords: impact, blast radius, what breaks, safety, dependents, risk."
argument-hint: "symbol or change to assess"
---

# Impact Analysis With Gortex

## Default Workflow

1. Call `mcp_gortex_smart_context` or `mcp_gortex_plan_turn` to identify the target symbols.
2. Call `mcp_gortex_get_dependents` on the symbol you plan to change.
3. Call `mcp_gortex_get_edit_plan` when multiple related symbols may need coordinated edits.
4. Activate `activate_change_impact_analysis_tools` for richer impact verification and diff-aware analysis.
5. Activate `activate_symbol_analysis_and_usage_tools` to map usages and likely test targets.

## What To Look For

- Direct dependents are the first breakage surface.
- Shared communities from `mcp_gortex_get_communities` often indicate hidden coordination cost.
- Process-level connections from `mcp_gortex_get_processes` reveal runtime effects not obvious from a single file.

## Good Prompts

- `what breaks if we change glyph compile scheduling`
- `impact of changing change-bridge layer normalization`
- `is it safe to rename this outline-editor helper`

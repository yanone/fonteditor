---
name: gortex-explore
description: "Use when the user asks how code works, wants architecture or execution-flow understanding, or needs fast codebase exploration through Gortex. Keywords: explore, architecture, process, flow, how does this work, unfamiliar code."
argument-hint: "what to understand"
---

# Exploring Code With Gortex

## Default Workflow

1. Call `mcp_gortex_plan_turn` with the exploration task when you want the cheapest routing decision.
2. Call `mcp_gortex_smart_context` with the task for the first real context bundle.
3. Use `mcp_gortex_get_communities` for functional clusters and architecture orientation.
4. Use `mcp_gortex_get_processes` to inspect discovered execution flows.
5. Use `mcp_gortex_get_editing_context` on key files once you know which file matters.
6. Use `mcp_gortex_export_context` when the result needs to be shared outside the session.

## Deepening The Search

- Use `mcp_gortex_winnow_symbols` when plain task text is too broad and you need filters like language, path prefix, or community.
- Use `mcp_gortex_prefetch_context` after inspecting a few symbols to predict the next useful ones.
- Activate `activate_symbol_analysis_and_usage_tools` when you need precise usages, dependencies, or tests.
- Activate `activate_codebase_overview_and_health_tools` when you need repo outline or index-health details.

## Good Prompts

- `understand glyph canvas rendering`
- `trace how font compilation is triggered after edits`
- `show the execution flow for cross-window change propagation`

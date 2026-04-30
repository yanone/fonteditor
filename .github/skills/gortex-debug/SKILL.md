---
name: gortex-debug
description: "Use when debugging a bug, tracing an error, narrowing a regression, or understanding why behavior changed. Keywords: debug, trace, regression, failing, broken, why does this fail."
argument-hint: "symptom, error, or suspect area"
---

# Debugging With Gortex

## Default Workflow

1. Call `mcp_gortex_smart_context` with the symptom, error text, or suspect subsystem.
2. Call `mcp_gortex_get_editing_context` on the most relevant file from the first-pass result.
3. Call `mcp_gortex_get_processes` when the bug looks flow-related.
4. Call `mcp_gortex_get_symbol_history` to find churn-heavy symbols touched repeatedly in this session.
5. Call `mcp_gortex_get_dependents` on a suspect symbol to see what else may be affected by a fix.

## Additional Tool Groups

- Activate `activate_symbol_analysis_and_usage_tools` for precise usages, callers, dependencies, and test targeting.
- Activate `activate_change_impact_analysis_tools` when a proposed fix may have non-local consequences.
- Activate `activate_codebase_overview_and_health_tools` if you suspect stale or incomplete indexing.

## Debugging Patterns

- Error or warning text: use `mcp_gortex_smart_context` with the message and subsystem keywords.
- Behavioral regression: compare the suspect symbol set with `mcp_gortex_get_symbol_history` and then inspect dependents.
- Hard-to-trace propagation bug: inspect `mcp_gortex_get_processes` and then pivot into file editing context.

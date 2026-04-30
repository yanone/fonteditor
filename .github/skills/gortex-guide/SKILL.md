---
name: gortex-guide
description: "Use when you need the Gortex workflow reference, available tool groups, daemon or index orientation, or guidance on which Gortex skill or command to use for a task. Keywords: gortex, commands, tools, graph, daemon, index, workflow."
argument-hint: "question or task"
---

# Gortex Guide

## When to Use

- Use this skill when the task is about Gortex itself.
- Use it to choose the right Gortex workflow before exploring or editing.
- Use it when you need to explain which tool group to activate for deeper analysis.

## Default Workflow

1. Confirm the repo is indexed and the daemon is healthy if graph access is in doubt.
2. Call `mcp_gortex_plan_turn` with the task to get the shortest relevant tool sequence.
3. Call `mcp_gortex_smart_context` when you want a compact first-pass context bundle.
4. Activate the specialized Gortex tool groups only when the task needs deeper impact analysis, symbol tracing, editing, or repo health data.

## Tool Group Map

- Overview and health: `activate_codebase_overview_and_health_tools`
- Symbol analysis and usages: `activate_symbol_analysis_and_usage_tools`
- Symbol editing and refactoring: `activate_symbol_editing_and_context_tools`
- Change impact and verification: `activate_change_impact_analysis_tools`
- Project and repository management: `activate_project_management_and_repository_tools`
- Direct file editing helpers: `activate_file_editing_tools`

## Task Routing

- Architecture or unfamiliar code: use `gortex-explore`
- Bug tracing or regression hunts: use `gortex-debug`
- Blast radius or safety analysis: use `gortex-impact`
- Rename, extract, move, or restructure work: use `gortex-refactor`
- Area-specific work in this repo: use the community skills such as `gortex-glyph-canvas`, `gortex-get`, `gortex-src`, `gortex-tests`, or `gortex-js`

## Core Commands

- `mcp_gortex_plan_turn`: cheapest first-step router
- `mcp_gortex_smart_context`: task-aware context bundle
- `mcp_gortex_get_editing_context`: pre-edit file context
- `mcp_gortex_get_communities`: functional clusters
- `mcp_gortex_get_processes`: discovered execution flows
- `mcp_gortex_get_dependents`: blast radius from a symbol
- `mcp_gortex_get_edit_plan`: dependency-ordered refactor sequence
- `mcp_gortex_export_context`: portable markdown or JSON context packet

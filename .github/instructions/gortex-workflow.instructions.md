---
description: "Use when exploring, debugging, refactoring, or impact-analyzing indexed source in this repo. Prefer Gortex MCP tools and the workspace gortex skills when the daemon is ready and the repo is tracked."
---

# Gortex Workflow

- Prefer Gortex MCP tools over raw file reads and text search when working on indexed source in this repository.
- Start exploration with `mcp_gortex_plan_turn` or `mcp_gortex_smart_context` before manually traversing files.
- Before editing a file, prefer `mcp_gortex_get_editing_context`.
- When assessing risk, activate the impact-analysis and symbol-analysis tool groups, then use blast-radius and test-target tools before changing behavior.
- Use the matching workspace skill when the task clearly fits one: `gortex-guide`, `gortex-explore`, `gortex-debug`, `gortex-impact`, `gortex-refactor`, or the repo community skills such as `gortex-glyph-canvas`.
- If graph-backed calls fail unexpectedly, verify daemon status and repository coverage before falling back to file-level exploration.

---
name: gortex-refactor
description: "Use when renaming, extracting, moving, splitting, or restructuring code with Gortex support. Keywords: refactor, rename, extract, move, split, restructure."
argument-hint: "refactor task"
---

# Refactoring With Gortex

## Default Workflow

1. Call `mcp_gortex_smart_context` with the refactor goal.
2. Call `mcp_gortex_get_editing_context` on the primary file before editing.
3. Call `mcp_gortex_get_dependents` to measure blast radius.
4. Call `mcp_gortex_get_edit_plan` for a dependency-ordered sequence when more than one symbol is involved.
5. Activate `activate_symbol_editing_and_context_tools` for symbol-level edits or renames.
6. Activate `activate_change_impact_analysis_tools` when the refactor changes behavior or interfaces.
7. Use `mcp_gortex_batch_edit` when you already have a coordinated multi-symbol edit set.

## Typical Uses

- Rename a symbol safely across callers.
- Split a large editor path into smaller units.
- Extract shared logic into a focused module.
- Move code while preserving caller updates and tests.

## Guardrails

- Do not start multi-file edits without an edit plan.
- Use impact analysis before signature or interface changes.
- Re-check affected tests after the refactor path is clear.

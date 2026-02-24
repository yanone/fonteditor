# Copilot Indexing Exclusions (Counterpunch)

This list is optimized to keep Copilot/agent context focused on source code and docs, while excluding generated artifacts, binaries, and test output noise.

## Recommended exclusion patterns

Use these patterns for search/index-like workflows in VS Code:

- `**/node_modules/**`
- `**/build/**`
- `**/target/**`
- `**/playwright-report/**`
- `**/test-results/**`
- `**/compilation-test/output/**`
- `**/wasm-dist/**`
- `**/.cache/**`
- `**/*.log`
- `**/*.wasm`
- `**/*.ttf`
- `**/*.otf`
- `**/*.woff`
- `**/*.woff2`

## What was applied

Workspace settings were added in `.vscode/settings.json`:

- `search.exclude` for noisy/generated paths and binary artifacts
- `files.watcherExclude` for expensive folders that change often
- `github.copilot.enable` keeps coding languages on and disables plaintext suggestions

## Additional speed-ups for agentic development

1. Keep the active scope tight
    - Prefer opening `webapp/` alone for frontend-only tasks.
    - Prefer opening `babelfont-fontc-build/` alone for Rust/WASM tasks.

2. Use explicit context hints in prompts
    - Start prompts with target paths, e.g. `Only touch webapp/js/font-manager.ts and related tests`.

3. Prefer deterministic retrieval
    - Use exact filenames/symbols in prompts (`FontManager`, `glyph-canvas`) to reduce broad semantic scans.

4. Keep generated output out of git and search
    - If a generated folder is not needed in commits, add it to `.gitignore` too.

5. Use instruction files for stable constraints
    - Keep architecture/style constraints in `AGENTS.md` and small focused instruction files so every run starts with the same guardrails.

## Notes

- GitHub Copilot does not currently rely on a single universal `.copilotignore` file in VS Code.
- The practical control points are workspace exclusions (`search.exclude`, watcher excludes), repository ignore hygiene, and explicit prompt scoping.

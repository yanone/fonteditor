# Counterpunch Font Editor

## Live App

Try the editor live:

- Latest official release (using `release.sh`): https://editor.counterpunch.space
- Latest preview (updated after each succesful push): https://preview.editor.counterpunch.space

## Develop

Run the app locally with `cd webapp && npm run dev`

- Load assistant test conversation with `?assistant_style_test`
- Trigger end-to-end error reporting tests from DevTools: `window.triggerRuntimeErrorForTesting()` and `window.triggerUnhandledRejectionForTesting()`

### Rebuild wasm component

Currently the wasm component is based on the babelfont fork https://github.com/yanone/babelfont-rs because of changes that we sometimes PR. To build a new wasm binary, do the following:

1. Sync fork with upstream
2. Note down pinned commit hash from fork into `.babelfont-rs-ref`
3. Run `./update-rust-deps.sh`
4. Run `./build-fontc-wasm.sh`
5. Either later or immediately run `./check-type-drift.sh`, see below

### Type Drift Detection

TypeScript types are auto-generated from `babelfont-rs` and must stay in sync. The type drift check runs automatically in `npm test`:

```bash
# Update WASM and types from latest babelfont-rs
./update-rust-deps.sh
./build-fontc-wasm.sh
./regenerate-types.sh

# Verify sync (runs in CI)
./check-type-drift.sh
```

Type generation and drift checks use `../babelfont-rs` when available. In CI (or without a local clone), scripts fall back to `.babelfont-rs-ref` and clone a pinned repo+commit for deterministic checks.

Pin file format:

```text
repo=https://github.com/<owner>/babelfont-rs.git
commit=<full-40-char-sha>
```

## Releasing a New Version

To create and deploy a new release, run the release script from the repository root:

```bash
./release.sh v1.0.0
```

This script automatically:

- Updates the version number in `webapp/coi-serviceworker.js`
- Extracts release notes from the "Unreleased" section in `CHANGELOG.md`
- Commits the version change
- Creates and pushes a git tag
- Triggers GitHub Actions to create a release and deploy to Cloudflare Pages

Users will see an orange update notification button in the title bar within 10 minutes and can reload to get the latest version without manually clearing their cache.

## Roadmap

### Pre-historic bootstrapping phase

- ✅ Bidirectional text shaping
- ✅ Super basic outline editing
- ✅ Live recompilation during editing
- ✅ Variable preview, live interpolation, animation
- ✅ Assistant generates Python code
- ✅ Canvas drawing plugins

### Pre-babelfont-ts Foundation (Due: Feb 2, 2026)

**Website and subscription system while waiting for `babelfont-ts`**

- ✅ Cloudflare setup
- ✅ Cloudflare Workers - AI Assistant Relay
- ✅ Authentication system - Passwordless
- ✅ Usage metering and billing sync
- ✅ User dashboard
- ✅ Stripe setup
- ✅ Website content
- ✅ Terms of service, privacy policy
- ✅ Configure custom domains
- ✅ Website design
- ✅ Canvas plugin system

### v0.2 (Due: Feb 15, 2026)

**`babelfont-ts` object model integration — Counterpunch becomes an analysis tool**

- ✅ User file sytem I/O
- ✅ App state saved in URL, can be shared and restored
- ✅ .babelfont input/outut
- ✅ .glyphs input/outut
- ✅ .glyphspackage input
- ✅ .sfb input
- ◻️ .vfj input
- ◻️ .vfb input
- ◻️ Python scripts I/O
- ✅ Glyph overview
- ✅ Glyph search and filtering
- ✅ Glyph filtering plugins
- ✅ Insert glyphs into editor text
- ◻️ Show intermediate masters
- ✅ OpenType feature code editor
- ◻️ OpenType feature code error display inline
- ✅ Hot-reloading fonts on external changes (Chrome/Chromium only)
- ✅ Fontspector integration (glyph-level messages later)
- ✅ Open fonts in PWA directly
- ◻️ Interactive demo
- ✅ Basic documentation
- ◻️ First video

### v0.3 (Due: Mar 10, 2026)

**Counterpunch becomes a simple font editor**

- ◻️ Multi-line editing
- ◻️ Basic layer/glyph operations
- ◻️ Contour point manipulation
- ◻️ Component editing
- ◻️ Anchor editing
- ◻️ Guideline editing
- ◻️ Layer management UI
- ◻️ Undo/redo system
- ◻️ Clipboard operations
- ◻️ Selection tools
- ◻️ Font info editing
- ◻️ Master/instance management
- ◻️ Path operations (boolean)
- ◻️ Transform tools
- ◻️ Kerning UI
- ◻️ Automatic glyph metric updates

### v0.4 (Due: Apr 1, 2026)

**Extended features — Counterpunch becomes a full-featured font editor**

- ◻️ avar2 editor
- ◻️ Variable components
- ◻️ OpenType feature code generator
- ◻️ Glyph composition UI (OpenType ccmp)
- ◻️ Contextual kerning/positioning UI
- ◻️ Multiple font windows
- ◻️ Plugin system architecture complete

### v0.5 (Due: Apr 21, 2026)

Cleanup, documentation, testing, videos

- ◻️ Performance optimization
- ◻️ Memory usage optimization
- ◻️ Unit test coverage
- ◻️ Integration test suite
- ◻️ End-to-end tests
- ◻️ Browser compatibility testing
- ◻️ Code documentation
- ◻️ Load testing
- ◻️ User guide completion

### v0.6 Public Beta (Due: May 10, 2026)

- ◻️ Monitoring and analytics setup
- ◻️ Security and penetration testing
- ◻️ Demo video production
- ◻️ Public announcement

### v0.7...v0.9

Polish, incorporate user feedback

### v1.0 Public Release (Due: October 2026)

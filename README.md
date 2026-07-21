![](title.png)

## Live App

Try the editor live:

- Latest official release: https://editor.counterpunch.space
- Latest preview: https://preview.editor.counterpunch.space (updates after every successful push)

## Source File I/O

Counterpunch converts opened source files into the Babelfont model for editing.
Direct source saving is deliberately limited to formats with a browser-safe
serializer; unsupported source formats fail instead of receiving Babelfont JSON
under their original extension.
Saving to UFO/DS and .glyphspackage is in development.

| Format | Open | Save | Notes |
| --- | --- | --- | --- |
| `.babelfont` | Yes | Yes | Native JSON source format. |
| `.glyphs` | Yes | Yes | Glyphs 3 source text, serialized by `babelfont-rs`/`glyphslib`. |
| `.glyphspackage` | Yes | No | Directory-based Glyphs package import. |
| `.ufo` | Yes | No | Directory-based UFO import. |
| `.designspace` | Yes | No | Requires the Designspace file and referenced UFO entries. |
| `.vfj` | Yes | No | FontLab source import. |
| `.sfd` | Yes | No | FontForge source import. |
| `.ttf` | No | Export only | Use binary-font export; it is not an editable source import format. |

## Development

Run the app locally with `cd webapp && npm run dev`, test with `npm run test`. For further developer documentation, see [DEVELOPMENT.md](/developer-docs/DEVELOPMENT.md)

## Roadmap

### Pre-historic bootstrapping phase

- ✅ Bidirectional text shaping
- ✅ Super basic outline editing
- ✅ Live recompilation during editing
- ✅ Variable preview, live interpolation, animation
- ✅ Assistant generates Python code
- ✅ Canvas drawing plugins

### Pre-babelfont-ts Foundation (February 2nd, 2026)

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

### v0.2 (March 3rd, 2026)

**`babelfont-ts` object model integration — Counterpunch becomes an analysis tool**

- ✅ User file sytem I/O
- ✅ App state saved in URL, can be shared and restored
- ✅ .babelfont input/outut
- ✅ .glyphs input/outut
- ✅ .glyphspackage input
- ✅ .sfb input
- ✅ .vfj input
- ◻️ .vfb input
- ✅ Python scripts I/O
- ✅ Glyph overview
- ✅ Grid glyph overview
- ✅ Glyph search and filtering
- ✅ Glyph filtering plugins
- ✅ Insert glyphs into editor text
- ✅ Show intermediate masters
- ✅ OpenType feature code editor
- ✅ OpenType feature code error display inline
- ✅ Hot-reloading fonts on external changes (Chrome/Chromium only)
- ✅ Explicit binary font export
- ✅ Open fonts in PWA directly
- ◻️ Interactive demo
- ✅ Basic documentation
- ✅ First video

### v0.3

**Counterpunch becomes a simple font editor**

- ✅ Basic layer operations
- ✅ Background layers
- ◻️ Basic glyph operations
- ◻️ Path operations
- ✅ Edit outlines
- ◻️ Edit components
- ◻️ Edit anchors
- ◻️ Edit feature variations
- ✅ Edit sidebearings
- ◻️ Edit guidelines
- ✅ Draw new outlines
- ◻️ Python script inference UI
- ✅ Undo/redo system
- ◻️ Clipboard operations
- ✅ Selection tools
- ✅ Edit Font Info
- ✅ Master/instance management
- ✅ Visual Kerning UI
- ◻️ Kerning list UI
- ✅ Automatic glyph metric updates
- ✅ Automatic glyph composition
- ✅ Font export
- ◻️ Source saving

### v0.4

**Extended features — Counterpunch becomes a full-featured font editor**

- ◻️ Transform tools
- ◻️ Multi-line text
- ◻️ avar2 editor
- ◻️ Variable components
- ◻️ OpenType feature code generator
- ◻️ Glyph composition UI (OpenType ccmp)
- ◻️ Contextual kerning/positioning UI
- ✅ Multiple font windows
- ◻️ Plugin system architecture complete

### v0.5

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

### v0.6 Public Beta

- ◻️ Monitoring and analytics setup
- ◻️ Security and penetration testing
- ◻️ Demo video production
- ◻️ Public announcement

### v0.7...v0.9

Polish, incorporate user feedback

### v1.0 Public Release (October 2026)

### v2.0

- ✅ Live online collaboration

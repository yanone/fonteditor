![](title.png)

## Develpoment Stage

Development is in **Alpha** stage (features not complete).
See [Feature Overview](#feature-overview) for details.

## Live App

Try the editor live:

- Latest official release: https://editor.counterpunch.space (rarely updated, see [releases](https://github.com/counterpunchspace/editor/releases))
- Latest preview: https://preview.editor.counterpunch.space (updates when a preview release is cut)

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

## Feature Overview

Remember that we’re in **Alpha** stage. "Should work" means you could still encounter problems. [Report them](https://github.com/counterpunchspace/editor/issues).

Coverage: 🟢 Should work · 🟡 Partial · 🔴 Missing

| Feature | Coverage | Comments |
| --- | --- | --- |
| Live font compilation + Harfbuzz shaping | 🟢 | 🔥 |
| Bi-directional text support | 🟢 | 🔥 |
| In-place component editing | 🟢 | 🔥 |
| Outline drawing and editing | 🟢 | Basic drawing tools, no multi-line text yet |
| Variable fonts | 🟢 | No `avar2` support yet |
| Components | 🟢 | No variable components yet, maybe not all composition types implemented yet |
| Sidebearings | 🟢 | |
| Kerning | 🟢 | |
| Python scripting | 🟢 | API and docs need some work |
| AI assistant | 🟢 | |
| Undo and history | 🟢 | |
| Multiple windows | 🟢 | Panel arrangement saved and restored only for main window currently |
| Binary font export | 🟢 | |
| Language database | 🟢 | Ships with Hyperglot temporarily as a demo, later as user-installable plugins |
| Glyph composition | 🟢 | |
| Documentation | 🟡 | Incomplete, bad screenshots |
| Glyph overview and filters | 🟡 | Glyph categorization missing |
| Source file I/O | 🟡 | UFO/DS and `.glyphspackage` writing is missing |
| Plugin system | 🟡 | Most plugin types not yet implemented, no auto-update yet |
| OpenType feature code generator | 🔴 | |
| Live online collaboration | 🔴 | |

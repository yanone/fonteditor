# Handbook authoring

User documentation lives in this folder. The folder tree is the table of contents.

Folders are groups. Each `.md` file is a page. Optional `index.md` in a folder sets that group's title from its H1.

Sort with numeric prefixes (`01-glyph-editor.md`). Stable ids strip the prefix, so `editor/01-glyph-editor.md` is `editor/glyph-editor`. App buttons must use those ids, never the prefix.

Write in complete paragraphs. Lists are fine when they make a procedure or a set of terms easier to scan. Put screenshots next to the page that uses them:

```md
![Selected point on the glyph canvas](images/point-selection.png)
```

`README.md`, `manifest.json`, `assets/`, and `images/` folders are not TOC pages. Webpack and the website build regenerate `manifest.json` from this tree.

# Counterpunch Font Editor - Coding Instructions

## Project Overview

Counterpunch (also known as "Context Font Editor") is a browser-based font editor with live compilation and rendering capabilities. It uses a WebAssembly-based font compilation pipeline (Rust fontc/babelfont compiled to WASM) and a JavaScript/TypeScript/HTML/CSS frontend. The editor provides a Python scripting environment via Pyodide, allowing users to manipulate font data programmatically.

### Key Features

- **Interactive outline editing** with visual feedback
- **Live font compilation** in the browser using fontc WASM
- **Variable font preview** with live interpolation and animation
- **AI assistant** that generates Python code for font manipulation
- **Python scripting** via Pyodide with a transparent JS-to-Python object model
- **Plugin system** for canvas rendering and glyph filtering

## Technology Stack

| Component            | Technology                                                   |
| -------------------- | ------------------------------------------------------------ |
| **Frontend**         | TypeScript, JavaScript (ES6+), HTML5, CSS3                   |
| **Font Compilation** | Rust (fontc/babelfont) compiled to WebAssembly via wasm-pack |
| **Python Runtime**   | Pyodide (WASM-based Python in browser)                       |
| **Text Shaping**     | HarfBuzz.js                                                  |
| **Build System**     | Webpack 5, Babel, TypeScript compiler                        |
| **Testing**          | Jest (unit), Playwright (E2E)                                |
| **Deployment**       | Cloudflare Pages, GitHub Actions                             |
| **AI Proxy**         | Cloudflare Workers (Anthropic API relay)                     |

## Project Structure

```
/
├── webapp/                    # Main web application
│   ├── js/                    # JavaScript/TypeScript source (60+ files)
│   │   ├── glyph-canvas/      # Canvas rendering modules (9 files)
│   │   ├── bootstrap.ts       # Application entry point
│   │   ├── font-manager.ts    # Font loading/saving
│   │   ├── babelfont-model.ts # Font object model
│   │   ├── tippy-utils.ts     # Shared tippy menu utilities
│   │   └── ...
│   ├── css/                   # Stylesheets
│   │   ├── style.css          # Main styles
│   │   ├── tokens.json        # Design tokens
│   │   └── tokens.css         # Generated CSS variables
│   ├── py/                    # Python scripts for Pyodide
│   │   └── fonteditor.py      # Core font editing module
│   ├── wasm-dist/             # WASM binaries
│   ├── tests/                 # Test files
│   ├── examples/              # Sample font files (.babelfont, .glyphs)
│   ├── build/                 # Webpack build output
│   ├── index.html             # Main HTML file
│   ├── webpack.config.js      # Webpack configuration
│   ├── playwright.config.ts   # Playwright test config
│   └── jest.config.js         # Jest test config
├── babelfont-fontc-build/     # Rust/WASM source code
│   ├── src/                   # Rust source files (4 files, ~1700 LOC)
│   └── Cargo.toml             # Rust dependencies
├── plugins/                   # Plugin system
│   ├── canvas/                # Canvas drawing plugins
│   └── glyphfilter/           # Glyph filtering plugins
├── developer-docs/            # Generated developer reference docs
│   └── JS_EVENTS.md           # Generated JavaScript event reference
├── instructions/              # Architecture documentation
│   ├── CSS_COLOR_STYLING.md   # Color system guidelines
│   ├── UI_ELEMENTS.md         # UI component guidelines
│   ├── WEBAPP_OVERVIEW.md     # Webapp architecture
│   └── UNDO_COLLABORATION_ARCHITECTURE.md
└── .github/workflows/         # CI/CD pipelines
    ├── ci.yml                 # CI workflow
    └── release.yml            # Release workflow
```

## Build Commands

### Webapp Development

```bash
cd webapp

# Install dependencies
npm install

# Development server (https://localhost:8000)
npm run dev

# Production build
npm run build

# Generate CSS tokens from tokens.json
npm run tokens
```

### Rust/WASM Development

```bash
# Build WASM from Rust (requires Rust nightly + wasm-pack)
./build-fontc-wasm.sh

# Update Rust dependencies and toolchains
./update-rust-deps.sh
```

If you change Rust code in `babelfont-fontc-build/src/`, you MUST rebuild the WebAssembly output with `./build-fontc-wasm.sh` before considering the task finished.

### Testing

```bash
cd webapp

# Run Playwright E2E tests
npm test

# Run Playwright with UI
npm run test:ui

# Run Jest unit tests
npm run test:jest

# Update Playwright snapshots
npm run test:update-snapshots
```

### Playwright Automation Mode

- For automated development workflows, run Playwright non-interactively by default (headless CLI execution), so reports don't get stuck and require user to press Ctrl+C. The user might not be present to do that.
- The project must enforce this by default: keep Playwright configured with `use.headless = true` and HTML reporter `open: 'never'` so `npm run test` stays machine-processable after failures without opening interactive UI.
- Do not use Playwright UI/debug/record modes unless explicitly requested for manual investigation.

### Release Process

```bash
# Create and deploy a new release
./release.sh v1.0.0
```

This script:

1. Updates version in `webapp/coi-serviceworker.js` and `API.md`
2. Extracts release notes from `CHANGELOG.md`
3. Commits version changes
4. Creates and pushes git tag
5. Triggers GitHub Actions to create release and deploy to Cloudflare Pages

## Code Style Guidelines

### General

- Be extremely concise in interactions, plans, and commit messages
- Scan for reusable code across languages; avoid duplicate implementations
- Don't write spaghetti code
- Clean up temporary code, excessive logs, and debug statements
- Prefer command-line commands for search/replace operations
- Run commands such that output is visible (don't route to unreadable pipelines)

### JavaScript/TypeScript

- Use modern ES6+ syntax
- Prefer `const` over `let`, avoid `var`
- Use camelCase for variables and functions
- Use PascalCase for classes
- Add JSDoc comments for complex functions
- When adding properties to the global `window` object, type them in `js/index.d.ts`
- Do not introduce new `any` or `unknown` types; replace existing uses with concrete, domain-specific types wherever possible
- Exceptions are allowed only at typed boundary adapters (I/O, parsed JSON, external/plugin data), and must be immediately narrowed via dedicated type guards or parser functions

**Console Logging Convention:**

All TypeScript files MUST use the Logger class from `js/logger.ts`:

```typescript
import { Logger } from "./logger";
const console = new Logger("FacilityName");

console.log("Compiling font..."); // Conditional on registry
console.warn("Script execution failed"); // Always printed
console.error("Critical error"); // Always printed
```

**Facility Registry Control:**

The `FACILITY_REGISTRY` in `js/logger.ts` controls which facilities print normal logs:

```typescript
// Edit the registry directly in logger.ts:
export const FACILITY_REGISTRY: Record<string, boolean> = {
    FontCompilation: false, // Disabled - only errors/warnings print
    GlyphCanvas: true, // Enabled - all logs print
    // ...
};
```

**Runtime Control (Browser Console):**

```javascript
// Toggle facilities at runtime
Logger.disable("GlyphCanvas"); // Mute normal logs
Logger.enable("GlyphCanvas"); // Unmute normal logs
Logger.isEnabled("GlyphCanvas"); // Check status
Logger.getRegistry(); // See all facilities
Logger.enableOnly(["FontManager"]); // Enable only specific facilities
Logger.reset(); // Enable all facilities

// Or access the registry directly
window.FACILITY_REGISTRY.GlyphCanvas = false;
```

**Adding New Facilities:**

When creating a new TypeScript file that needs logging:

1. Import and use Logger as shown above
2. Add the facility name to `FACILITY_REGISTRY` in `js/logger.ts`
3. Choose a descriptive facility name (usually the file/class name in PascalCase)

**Note:** JavaScript files (`.js`) should continue using manual prefixes with the native console:

```javascript
console.log("[FacilityName]", "message");
```

**DOM Update Pattern (prevent flickering):**

```javascript
// Build off-screen first
const tempContainer = document.createElement("div");
// ... populate tempContainer ...

// Swap in single paint cycle
requestAnimationFrame(() => {
    container.innerHTML = "";
    container.appendChild(tempContainer);
});
```

**Tippy.js Menus (Dropdowns & Context Menus):**

All tippy menus MUST use the shared utilities from `js/tippy-utils.ts`:

```typescript
import {
    getOrCreateBackdrop,
    addTippyBackdropSupport,
    getTheme,
} from "./tippy-utils";

// Create backdrop
const backdrop = getOrCreateBackdrop("my-menu-backdrop");

// Create tippy instance
const tippyInstance = tippy(element, {
    content: menuHtml,
    allowHTML: true,
    trigger: "manual",
    interactive: true,
    theme: getTheme(),
    // ... other options
});

// Add backdrop support (enables click-outside-to-close + Escape key)
addTippyBackdropSupport(tippyInstance, backdrop, {
    targetElement: element, // Optional: element to add active class
    activeClass: "menu-active", // Optional: class to add when menu shown
    onEscape: () => {
        /* ... */
    }, // Optional: additional Escape handler
});
```

**DO NOT:**

- Duplicate `getOrCreateBackdrop`, `addTippyBackdropSupport`, or `getTheme` functions
- Implement custom backdrop click handlers separately
- Create tippy menus without backdrop support

**Property Panel Numeric Inputs:**

- Numeric text fields in the editor property panel (for example sidebearings and component transform controls) MUST use `ArrowAdjustableTextInput` so Up/Down keyboard adjustments behave consistently.
- Reuse the same input-step behavior and replacement-input lookup pattern already used by sidebearing fields in `webapp/js/glyph-canvas.ts`.

### CSS

**NEVER use hard-coded color values. ALWAYS use CSS variables.**

```css
/* WRONG */
.button {
    background-color: #ff00ff;
}

/* CORRECT */
.button {
    background-color: var(--accent-magenta);
}
```

Colors are defined in `webapp/css/style.css` in two theme blocks:

- **Dark Theme (Default)**: `:root { ... }`
- **Light Theme**: `:root[data-theme="light"] { ... }`

Variable naming: Use semantic names (purpose, not color):

- ✅ `--text-primary`, `--background-hover`, `--accent-green`
- ❌ `--dark-gray`, `--light-blue`, `--color-1`

Design tokens are defined in `css/tokens.json` and generated to `css/tokens.css` via `npm run tokens`.

### Rust

- Follow standard Rust conventions
- Use rustfmt for formatting
- Write documentation comments with `///`
- After changing `babelfont-fontc-build/src/*.rs`, rebuild the generated WASM artifacts with `./build-fontc-wasm.sh` and verify the generated files are updated as expected

## Testing Strategy

### Unit Tests (Jest)

- Configuration: `webapp/jest.config.js`
- Test files: `webapp/tests/*.test.js`
- Environment: jsdom with canvas mock
- WASM modules are mocked for Jest

### E2E Tests (Playwright)

- Configuration: `webapp/playwright.config.ts`
- Test files: `webapp/tests/*.spec.ts`
- Browsers: Chromium (WebKit commented out)
- SharedArrayBuffer required for WASM/Pyodide
- 5-minute timeout for complex interactions
- Screenshots/videos captured on failure

### Code Formatting

Prettier configuration in `webapp/.prettierrc`:

- Print width: 80
- Tab width: 4 spaces
- Single quotes
- No trailing commas
- LF line endings

Run formatting: `cd webapp && npx prettier --write .`
Check formatting: `cd webapp && npx prettier -c .`

## Key Architecture Details

### Font Object Model

The font data model is defined in `babelfont-model.ts` with classes:

- `Font` - Main font class
- `Glyph` - Individual glyphs
- `Layer` - Master/intermediate designs
- `Path` / `Node` - Outline contours and points
- `Component` - Component references
- `Axis` / `Master` / `Instance` - Variable font data

The model is accessible via `window.currentFontModel` and exposed to Python through Pyodide.

### File I/O

Supported formats (via `font-manager.ts`):

- `.babelfont` - Native JSON format
- `.glyphs` - Glyphs.app format
- `.vfj` - FontLab format
- `.ufo`/`.designspace` - Planned

### Compilation Pipeline

```
Edit → Serialize to JSON → fontc WASM → OpenType font → HarfBuzz shaping → Render
```

### Plugin System

- **Canvas plugins**: Custom drawing on glyph canvas (above/below outlines)
- **Glyph filters**: Custom filtering in glyph overview

Plugins are discovered dynamically from the `plugins/` directory.

## MCP Server for Development

Use the Chrome DevTools MCP server for live app inspection. It attaches to the real Chrome runtime that is already running the webapp, which avoids the stale or wrong-session issues that came from separate browser contexts.

When using MCP for live app inspection, always use the app instance already running in Chrome. Do not open or inspect the app in a VS Code browser tab, because that can attach MCP to the wrong runtime session and hide the real state.

When reloading the live app through Chrome DevTools MCP, always do it headlessly and non-interactively. Do not rely on the user being present to confirm dialogs; choose reload/navigation paths that auto-accept or avoid confirmation prompts.

## Security Considerations

- CORS headers required for SharedArrayBuffer (see `webapp/_headers`)
- COOP/COEP headers configured for cross-origin isolation
- Cloudflare Worker proxies Anthropic API requests to avoid CORS issues
- Service worker (`coi-serviceworker.js`) handles cache versioning

## Global Window Objects

Key globals exposed on `window` (see `js/index.d.ts` for full list):

- `window.currentFontModel` - Current font object model
- `window.fontManager` - Font loading/management
- `window.glyphCanvas` - Main canvas editor
- `window.pyodide` - Python runtime
- `window.aiAssistant` - AI assistant integration

## Deployment

- **Production**: https://editor.counterpunch.space
- **Preview**: https://preview.editor.counterpunch.space (auto-updated on push)
- Platform: Cloudflare Pages
- CI/CD: GitHub Actions

## Documentation Files

- `APP.md` - Principal authority for how the app functions. This file must always be read and followed.
- `API.md` - Font Object Model API documentation (auto-generated)
- `developer-docs/COMPILATION_EDIT_POLICY.md` - Authoritative compilation scheduling and fast-path policy. Its conduct must always be followed, and any change to that policy must be discussed with the author before implementation.
- `developer-docs/JS_EVENTS.md` - JavaScript event reference (auto-generated by `node generate-js-event-docs.mjs`)
- `CHANGELOG.md` - Release notes
- `instructions/*.md` - Architecture and style guides

Treat `APP.md` as the principal authority for application behavior in all implementation decisions.

When introducing, removing, renaming, or changing emitted JavaScript events, regenerate `developer-docs/JS_EVENTS.md` using `node generate-js-event-docs.mjs` (from repo root) so the event reference stays current.

When changing compilation scheduling, compile-mode selection, worker cache invalidation, subset handling, or any other editing compile behavior, update `developer-docs/COMPILATION_EDIT_POLICY.md` in the same change and follow it as the normative policy document.

## Useful Resources

- fontc: https://github.com/googlefonts/fontc
- babelfont-rs: https://github.com/simoncozens/babelfont-rs
- Pyodide: https://pyodide.org/
- HarfBuzz.js: https://github.com/harfbuzz/harfbuzzjs

<!-- gortex:communities:start -->
<!-- gortex:skills:start -->

## Community Skills

| Area         | Description | Skill                  |
| ------------ | ----------- | ---------------------- |
| Js           | 300 symbols | `/gortex-js`           |
| Glyph Canvas | 120 symbols | `/gortex-glyph-canvas` |
| Get          | 78 symbols  | `/gortex-get`          |
| Glyph Canvas | 76 symbols  | `/gortex-glyph-canvas` |
| Js           | 62 symbols  | `/gortex-js`           |
| Js           | 61 symbols  | `/gortex-js`           |
| Js           | 60 symbols  | `/gortex-js`           |
| Get          | 59 symbols  | `/gortex-get`          |
| Tests        | 51 symbols  | `/gortex-tests`        |
| Js           | 50 symbols  | `/gortex-js`           |
| Js           | 49 symbols  | `/gortex-js`           |
| Js           | 49 symbols  | `/gortex-js`           |
| Js           | 45 symbols  | `/gortex-js`           |
| Js           | 42 symbols  | `/gortex-js`           |
| Glyph Canvas | 41 symbols  | `/gortex-glyph-canvas` |
| Glyph Canvas | 41 symbols  | `/gortex-glyph-canvas` |
| Js           | 37 symbols  | `/gortex-js`           |
| Src          | 35 symbols  | `/gortex-src`          |
| Js           | 34 symbols  | `/gortex-js`           |
| Js           | 34 symbols  | `/gortex-js`           |

<!-- gortex:skills:end -->

<!-- gortex:communities:end -->

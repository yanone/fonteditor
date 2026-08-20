#!/usr/bin/env node

/**
 * localStorage Settings Documentation Generator
 *
 * Scans production TypeScript and plugin Python for localStorage keys used
 * to persist editor settings, UI preferences, and related client state.
 *
 * Usage:
 *   node generate-localstorage-docs.mjs
 */

import { generateWebStorageDocs } from "./generate-webstorage-docs-lib.mjs";

generateWebStorageDocs({
    apiName: "localStorage",
    scriptName: "generate-localstorage-docs.mjs",
    outputName: "LOCALSTORAGE_SETTINGS.md",
    title: "localStorage Settings Keys",
    intro: "This document lists `localStorage` keys discovered in production TypeScript (`webapp/js`) and plugin Python (`plugins/`) that persist editor settings, UI preferences, and related client state.",
    excludeNote:
        "IndexedDB keys such as directory handles and export destinations are not included. `sessionStorage` keys are documented separately in `SESSIONSTORAGE_SETTINGS.md`.",
    includePlugins: true,
});

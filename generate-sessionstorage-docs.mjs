#!/usr/bin/env node

/**
 * sessionStorage Settings Documentation Generator
 *
 * Scans production TypeScript and JavaScript for sessionStorage keys used
 * to persist tab-scoped editor state.
 *
 * Usage:
 *   node generate-sessionstorage-docs.mjs
 */

import { generateWebStorageDocs } from "./generate-webstorage-docs-lib.mjs";

generateWebStorageDocs({
    apiName: "sessionStorage",
    scriptName: "generate-sessionstorage-docs.mjs",
    outputName: "SESSIONSTORAGE_SETTINGS.md",
    title: "sessionStorage Settings Keys",
    intro: "This document lists `sessionStorage` keys discovered in production TypeScript (`webapp/js`) and supporting JavaScript (`webapp/coi-serviceworker.js`) that persist tab-scoped editor state.",
    excludeNote:
        "`localStorage` keys are documented separately in `LOCALSTORAGE_SETTINGS.md`. IndexedDB keys such as directory handles and export destinations are not included.",
    includePlugins: false,
    extraFiles: ["webapp/coi-serviceworker.js"],
});

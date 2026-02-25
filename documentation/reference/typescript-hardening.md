# TypeScript Hardening Tracker

This file tracks the transition from legacy permissive typing to stricter TypeScript checks.

## Current Status

- `strict: true`
- `noImplicitAny: true`
- `strictNullChecks: true`
- `noImplicitThis: true`
- `strictFunctionTypes: true`
- `strictBindCallApply: true`
- `strictPropertyInitialization: true`
- `alwaysStrict: true`
- `useUnknownInCatchVariables: true`

## Temporary Safety Rails

- DOM-heavy legacy code still relies on typed ambient DOM augmentations in `webapp/js/index.d.ts`.
- An explicit-any non-regression guard is enforced by `webapp/scripts/check-explicit-any-budget.mjs`.

## Priority Typing Debt

1. Replace ambient DOM augmentations with local, file-level narrowing (`querySelector`/`getElementById` guards and typed helpers).
2. Reduce `any` in high-churn files:
    - `webapp/js/ai-assistant.ts`
    - `webapp/js/keyboard-navigation.ts`
    - `webapp/js/file-browser.ts`
    - `webapp/js/glyph-canvas/textrun.ts`
3. Improve third-party shim typings (`bidi-js`) beyond minimal interface.

## Guardrails

- `npm run test:tsc` must pass.
- `npm run test:any-budget` must pass.
- CI runs both checks.

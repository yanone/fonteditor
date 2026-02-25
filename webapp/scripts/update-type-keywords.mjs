import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(process.cwd(), 'js');
const BABE_FONT_MODEL_PATH_SUFFIX = join('js', 'babelfont-model.ts');
const BUDGET_SCRIPT_PATH = join(
    process.cwd(),
    'scripts',
    'check-explicit-any-budget.mjs'
);

const tsFilePaths = [];

function walk(dir) {
    for (const name of readdirSync(dir)) {
        const fullPath = join(dir, name);
        const st = statSync(fullPath);
        if (st.isDirectory()) {
            walk(fullPath);
            continue;
        }
        if (!name.endsWith('.ts') || name.endsWith('.d.ts')) {
            continue;
        }
        tsFilePaths.push(fullPath);
    }
}

walk(ROOT);

const explicitAnyRegex = /\bany\b|as\s+any\b/g;
const explicitUnknownRegex = /\bunknown\b/g;

let anyTotal = 0;
let unknownTotal = 0;
let babelfontModelAny = 0;
let babelfontModelUnknown = 0;

for (const filePath of tsFilePaths) {
    const source = readFileSync(filePath, 'utf8');
    const anyCount = (source.match(explicitAnyRegex) || []).length;
    const unknownCount = (source.match(explicitUnknownRegex) || []).length;

    anyTotal += anyCount;
    unknownTotal += unknownCount;

    if (filePath.endsWith(BABE_FONT_MODEL_PATH_SUFFIX)) {
        babelfontModelAny = anyCount;
        babelfontModelUnknown = unknownCount;
    }
}

const budgetScriptSource = readFileSync(BUDGET_SCRIPT_PATH, 'utf8');
const updatedBudgetScript = budgetScriptSource
    .replace(
        /const EXPECTED_EXPLICIT_ANY = \d+;/,
        `const EXPECTED_EXPLICIT_ANY = ${anyTotal};`
    )
    .replace(
        /const EXPECTED_EXPLICIT_UNKNOWN = \d+;/,
        `const EXPECTED_EXPLICIT_UNKNOWN = ${unknownTotal};`
    )
    .replace(
        /const EXPECTED_BABELFONT_MODEL_ANY = \d+;/,
        `const EXPECTED_BABELFONT_MODEL_ANY = ${babelfontModelAny};`
    )
    .replace(
        /const EXPECTED_BABELFONT_MODEL_UNKNOWN = \d+;/,
        `const EXPECTED_BABELFONT_MODEL_UNKNOWN = ${babelfontModelUnknown};`
    );

writeFileSync(BUDGET_SCRIPT_PATH, updatedBudgetScript, 'utf8');

console.log('[TypeSafety] Updated check-explicit-any-budget.mjs constants:');
console.log(`  EXPECTED_EXPLICIT_ANY=${anyTotal}`);
console.log(`  EXPECTED_EXPLICIT_UNKNOWN=${unknownTotal}`);
console.log(`  EXPECTED_BABELFONT_MODEL_ANY=${babelfontModelAny}`);
console.log(`  EXPECTED_BABELFONT_MODEL_UNKNOWN=${babelfontModelUnknown}`);

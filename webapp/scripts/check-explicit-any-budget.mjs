import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(process.cwd(), 'js');
const EXPECTED_EXPLICIT_ANY = 621;
const EXPECTED_EXPLICIT_UNKNOWN = 115;
const EXPECTED_BABELFONT_MODEL_ANY = 0;
const EXPECTED_BABELFONT_MODEL_UNKNOWN = 0;
const BABE_FONT_MODEL_PATH_SUFFIX = join('js', 'babelfont-model.ts');
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
let babelfontModelAnyCount = 0;
let babelfontModelUnknownCount = 0;

for (const filePath of tsFilePaths) {
    const source = readFileSync(filePath, 'utf8');
    const matches = source.match(explicitAnyRegex);
    const unknownMatches = source.match(explicitUnknownRegex);
    const anyCount = matches ? matches.length : 0;
    const unknownCount = unknownMatches ? unknownMatches.length : 0;
    anyTotal += anyCount;
    unknownTotal += unknownCount;

    if (filePath.endsWith(BABE_FONT_MODEL_PATH_SUFFIX)) {
        babelfontModelAnyCount = anyCount;
        babelfontModelUnknownCount = unknownCount;
    }
}

if (babelfontModelAnyCount !== EXPECTED_BABELFONT_MODEL_ANY) {
    console.error(
        `[TypeSafety] babelfont-model.ts explicit any count changed: expected ${EXPECTED_BABELFONT_MODEL_ANY}, found ${babelfontModelAnyCount}`
    );
    process.exit(1);
}

if (babelfontModelUnknownCount !== EXPECTED_BABELFONT_MODEL_UNKNOWN) {
    console.error(
        `[TypeSafety] babelfont-model.ts unknown count changed: expected ${EXPECTED_BABELFONT_MODEL_UNKNOWN}, found ${babelfontModelUnknownCount}`
    );
    process.exit(1);
}

if (anyTotal !== EXPECTED_EXPLICIT_ANY) {
    console.error(
        `[TypeSafety] explicit any count changed: expected ${EXPECTED_EXPLICIT_ANY}, found ${anyTotal}`
    );
    process.exit(1);
}

if (unknownTotal !== EXPECTED_EXPLICIT_UNKNOWN) {
    console.error(
        `[TypeSafety] explicit unknown count changed: expected ${EXPECTED_EXPLICIT_UNKNOWN}, found ${unknownTotal}`
    );
    process.exit(1);
}

console.log(
    `[TypeSafety] explicit any/unknown counts ${anyTotal}/${EXPECTED_EXPLICIT_ANY} and ${unknownTotal}/${EXPECTED_EXPLICIT_UNKNOWN}`
);

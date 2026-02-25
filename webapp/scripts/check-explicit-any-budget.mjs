import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(process.cwd(), 'js');
const MAX_EXPLICIT_ANY = 685;
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
let total = 0;
let babelfontModelAnyCount = 0;

for (const filePath of tsFilePaths) {
    const source = readFileSync(filePath, 'utf8');
    const matches = source.match(explicitAnyRegex);
    const count = matches ? matches.length : 0;
    total += count;

    if (filePath.endsWith(BABE_FONT_MODEL_PATH_SUFFIX)) {
        babelfontModelAnyCount = count;
    }
}

if (babelfontModelAnyCount !== 0) {
    console.error(
        `[TypeSafety] babelfont-model.ts must have zero explicit any occurrences, found ${babelfontModelAnyCount}`
    );
    process.exit(1);
}

if (total > MAX_EXPLICIT_ANY) {
    console.error(
        `[TypeSafety] explicit any budget exceeded: ${total} > ${MAX_EXPLICIT_ANY}`
    );
    process.exit(1);
}

console.log(`[TypeSafety] explicit any count ${total}/${MAX_EXPLICIT_ANY}`);

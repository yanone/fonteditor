import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(process.cwd(), 'js');
const MAX_EXPLICIT_ANY = 773;
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

for (const filePath of tsFilePaths) {
    const source = readFileSync(filePath, 'utf8');
    const matches = source.match(explicitAnyRegex);
    total += matches ? matches.length : 0;
}

if (total > MAX_EXPLICIT_ANY) {
    console.error(
        `[TypeSafety] explicit any budget exceeded: ${total} > ${MAX_EXPLICIT_ANY}`
    );
    process.exit(1);
}

console.log(`[TypeSafety] explicit any count ${total}/${MAX_EXPLICIT_ANY}`);

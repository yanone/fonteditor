const fs = require('fs');
const path = require('path');

const SW_PATH = path.resolve(__dirname, '../coi-serviceworker.js');
const CSS_DIR = path.resolve(__dirname, '../css');
const JS_DIR = path.resolve(__dirname, '../build/js');

function parsePrecacheAssets(fileContent) {
    const match = fileContent.match(
        /const PRECACHE_ASSETS\s*=\s*\[([^\]]*?)\];/s
    );
    if (!match)
        throw new Error('Could not find PRECACHE_ASSETS in service worker');
    const items = [];
    const re = /['"]([^'"]+)['"]\s*,?\s*(?:\/\/.*)?$/gm;
    let m;
    while ((m = re.exec(match[1])) !== null) {
        items.push(m[1]);
    }
    return items;
}

function scanFiles(dir, prefix) {
    const files = [];
    function walk(d) {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else if (entry.isFile()) {
                files.push(prefix + entry.name);
            }
        }
    }
    walk(dir);
    return files.sort();
}

describe('COI ServiceWorker PRECACHE_ASSETS', () => {
    let precacheAssets;

    beforeAll(() => {
        const swContent = fs.readFileSync(SW_PATH, 'utf-8');
        precacheAssets = parsePrecacheAssets(swContent);
    });

    test('includes every CSS file in the css/ directory', () => {
        const cssFiles = scanFiles(CSS_DIR, './css/').filter((f) =>
            f.endsWith('.css')
        );
        const missing = cssFiles.filter((f) => !precacheAssets.includes(f));
        if (missing.length) {
            console.log(
                'Missing from PRECACHE_ASSETS:\n' +
                    missing.map((f) => "    '" + f + "',").join('\n')
            );
        }
        expect(missing).toEqual([]);
    });

    test('includes every JS file in the build/js/ directory', () => {
        const jsFiles = scanFiles(JS_DIR, './js/').filter(
            (f) => f.endsWith('.js') && !f.endsWith('.js.map')
        );
        const missing = jsFiles.filter((f) => !precacheAssets.includes(f));
        if (missing.length) {
            console.log(
                'Missing from PRECACHE_ASSETS:\n' +
                    missing.map((f) => "    '" + f + "',").join('\n')
            );
        }
        expect(missing).toEqual([]);
    });

    test('no orphaned CSS entries in PRECACHE_ASSETS', () => {
        const cssFiles = scanFiles(CSS_DIR, './css/').filter((f) =>
            f.endsWith('.css')
        );
        const precacheCss = precacheAssets.filter(
            (f) => f.startsWith('./css/') && f.endsWith('.css')
        );
        const orphaned = precacheCss.filter((f) => !cssFiles.includes(f));
        if (orphaned.length) {
            console.log(
                'Orphaned in PRECACHE_ASSETS (file no longer exists):\n' +
                    orphaned.map((f) => "    '" + f + "',").join('\n')
            );
        }
        expect(orphaned).toEqual([]);
    });

    test('no orphaned JS entries in PRECACHE_ASSETS', () => {
        const jsFiles = scanFiles(JS_DIR, './js/').filter(
            (f) => f.endsWith('.js') && !f.endsWith('.js.map')
        );
        const precacheJs = precacheAssets.filter(
            (f) => f.startsWith('./js/') && f.endsWith('.js')
        );
        const orphaned = precacheJs.filter((f) => !jsFiles.includes(f));
        if (orphaned.length) {
            console.log(
                'Orphaned in PRECACHE_ASSETS (file no longer exists):\n' +
                    orphaned.map((f) => "    '" + f + "',").join('\n')
            );
        }
        expect(orphaned).toEqual([]);
    });
});

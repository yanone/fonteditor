import { Logger } from './logger';

const console = new Logger('GlyphDataPluginManager');

export interface GlyphData {
    codepoint: number;
    glyph_name: string;
    name: string;
    general_category: string;
    category?: string;
    script: string;
    script_extensions?: string;
    block?: string;
    age?: string;
    joining_type?: string;
    joining_group?: string;
    decomposition?: string;
}

export interface GlyphDataSearchResult extends GlyphData {
    character: string;
}

type PyodideLike = {
    loadPackage(name: string): Promise<void>;
    runPythonAsync(code: string): Promise<string>;
};

/**
 * Loads the bundled Glyph Data wheel once and keeps a JavaScript search index
 * so interactive searches never cross the Pyodide boundary.
 */
export class GlyphDataPluginManager {
    private records: GlyphDataSearchResult[] = [];
    private byCodepoint = new Map<number, GlyphDataSearchResult>();
    private byName = new Map<string, GlyphDataSearchResult>();
    private readyPromise: Promise<void> | null = null;

    isReady(): boolean {
        return this.records.length > 0;
    }

    async ensureReady(): Promise<void> {
        if (this.isReady()) {
            return;
        }
        if (!this.readyPromise) {
            this.readyPromise = this.load().catch((error) => {
                this.readyPromise = null;
                throw error;
            });
        }
        return this.readyPromise;
    }

    getGlyphDataForUnicode(
        codepoints: readonly number[] | undefined
    ): GlyphDataSearchResult | undefined {
        if (!codepoints || codepoints.length !== 1) {
            return undefined;
        }
        return this.byCodepoint.get(codepoints[0]!);
    }

    getGlyphDataForName(name: string): GlyphDataSearchResult | undefined {
        return this.byName.get(name);
    }

    search(query: string, limit = 150): GlyphDataSearchResult[] {
        const normalized = query.trim().toLowerCase();
        if (!normalized) {
            return this.records.slice(0, limit);
        }

        const hex = normalized.replace(/^u\+|^0x/, '');
        const queryWords = normalized.split(/\s+/).filter(Boolean);
        const results: Array<{ record: GlyphDataSearchResult; score: number }> =
            [];
        for (const record of this.records) {
            const codepoint = record.codepoint.toString(16).toLowerCase();
            const name = record.glyph_name.toLowerCase();
            const unicodeName = record.name.toLowerCase();
            let score = 0;
            if (name === normalized || codepoint === hex) {
                score = 4;
            } else if (
                name.startsWith(normalized) ||
                codepoint.startsWith(hex)
            ) {
                score = 3;
            } else if (
                queryWords.every((queryWord) =>
                    unicodeName
                        .split(/\s+/)
                        .some((word) => word.startsWith(queryWord))
                )
            ) {
                score = 2;
            } else if (
                name.includes(normalized) ||
                unicodeName.includes(normalized) ||
                record.character === query
            ) {
                score = 1;
            }
            if (score) {
                results.push({ record, score });
            }
        }

        return results
            .sort(
                (left, right) =>
                    right.score - left.score ||
                    left.record.codepoint - right.record.codepoint
            )
            .slice(0, limit)
            .map(({ record }) => record);
    }

    private async load(): Promise<void> {
        const pyodide = await this.waitForPyodide();
        const manifestResponse = await fetch('/wheels/wheels.json');
        if (!manifestResponse.ok) {
            throw new Error(
                'Unable to load bundled Glyph Data wheel manifest.'
            );
        }
        const manifest = (await manifestResponse.json()) as {
            wheels?: string[];
        };
        const wheel = manifest.wheels?.find((name) =>
            name.startsWith('counterpunch_glyph_data-')
        );
        if (!wheel) {
            throw new Error('The bundled Glyph Data wheel is missing.');
        }

        await pyodide.loadPackage('micropip');
        await pyodide.runPythonAsync('import micropip');
        await pyodide.runPythonAsync(
            `await micropip.install(${JSON.stringify(`/wheels/${wheel}`)})`
        );
        const json = await pyodide.runPythonAsync(`
import json
from importlib.metadata import entry_points

entries = list(entry_points(group='counterpunch_glyph_data_plugins'))
if not entries:
    raise RuntimeError('No Glyph Data provider entry point is installed.')
provider = entries[0].load()()
json.dumps(provider.search_records())
`);
        const records = JSON.parse(json) as GlyphData[];
        this.records = records.map((record) => ({
            ...record,
            general_category: record.general_category || record.category || '',
            character:
                record.codepoint >= 0x20 &&
                record.codepoint !== 0x7f &&
                record.codepoint <= 0x10ffff
                    ? String.fromCodePoint(record.codepoint)
                    : ''
        }));
        this.byCodepoint = new Map(
            this.records.map((record) => [record.codepoint, record])
        );
        this.byName = new Map(
            this.records.map((record) => [record.glyph_name, record])
        );
        window.dispatchEvent(new Event('counterpunch:glyph-data-ready'));
        console.log(`Loaded ${this.records.length} Glyph Data records.`);
    }

    private async waitForPyodide(): Promise<PyodideLike> {
        for (let attempt = 0; attempt < 200; attempt += 1) {
            if (window.pyodide) {
                return window.pyodide as PyodideLike;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error('Pyodide did not become available for Glyph Data.');
    }
}

export const glyphDataPluginManager = new GlyphDataPluginManager();
window.glyphDataPluginManager = glyphDataPluginManager;

// The wheel is bundled with every editor build. Begin loading once Pyodide is
// available so model lookups are normally ready before the user opens Font.
void glyphDataPluginManager
    .ensureReady()
    .catch((error) =>
        console.warn('Glyph Data will be retried when opened.', error)
    );

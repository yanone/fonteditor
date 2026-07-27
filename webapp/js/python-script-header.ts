/**
 * Parse conventional Python script header comments used by Counterpunch scripts.
 *
 * Example:
 *   # Update glyphs
 *   #
 *   # This script updates the selected glyphs
 *   # and prints a summary.
 *   #
 *   # Keywords: metrics
 */

export type PythonScriptHeader = {
    /** First-line `# Title` text, or null when the first line is not a comment. */
    title: string | null;
    /** Comment body between the title and a Keywords line. */
    description: string;
    /** Parsed from `# Keywords: a, b`. */
    keywords: string[];
};

/**
 * Parse title / description / keywords from a script's leading comment block.
 */
export function parsePythonScriptHeader(content: string): PythonScriptHeader {
    const lines = content.split(/\r?\n/);
    const firstLine = (lines[0] ?? '').trimStart();
    let title: string | null = null;
    let index = 0;
    const descriptionLines: string[] = [];
    const keywords: string[] = [];

    const parseKeywordBody = (body: string): boolean => {
        const keywordMatch = /^keywords:\s*(.*)$/i.exec(body);
        if (!keywordMatch) {
            return false;
        }
        for (const part of keywordMatch[1].split(',')) {
            const keyword = part.trim();
            if (keyword) {
                keywords.push(keyword);
            }
        }
        return true;
    };

    if (firstLine.startsWith('#')) {
        const body = firstLine.replace(/^#\s?/, '').trim();
        if (parseKeywordBody(body)) {
            return { title: null, description: '', keywords };
        }
        title = body || null;
        index = 1;
    }

    for (; index < lines.length; index++) {
        const trimmed = lines[index].trimStart();
        if (!trimmed.startsWith('#')) {
            break;
        }

        const body = trimmed.replace(/^#\s?/, '').trim();
        if (parseKeywordBody(body)) {
            break;
        }

        descriptionLines.push(body);
    }

    while (descriptionLines.length > 0 && descriptionLines[0] === '') {
        descriptionLines.shift();
    }
    while (
        descriptionLines.length > 0 &&
        descriptionLines[descriptionLines.length - 1] === ''
    ) {
        descriptionLines.pop();
    }

    return {
        title,
        description: descriptionLines.join('\n').trim(),
        keywords
    };
}

/**
 * Suggest a Save As filename from the first `#` title comment line only.
 */
export function suggestFileNameFromScriptHeader(content: string): string {
    const firstLine = (content.split(/\r?\n/, 1)[0] ?? '').trimStart();
    if (!firstLine.startsWith('#')) {
        return 'Choose file name.py';
    }
    const title = firstLine.replace(/^#\s?/, '').trim();
    if (!title) {
        return 'Choose file name.py';
    }
    return title.toLowerCase().endsWith('.py') ? title : `${title}.py`;
}

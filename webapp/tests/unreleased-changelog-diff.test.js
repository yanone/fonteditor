const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.resolve(
    __dirname,
    '../../scripts/unreleased-changelog-diff.mjs'
);

function writeTemp(name, contents) {
    const filePath = path.join(os.tmpdir(), name);
    fs.writeFileSync(filePath, contents);
    return filePath;
}

function diffFiles(oldMarkdown, newMarkdown) {
    const oldPath = writeTemp(`old-changelog-${process.pid}.md`, oldMarkdown);
    const newPath = writeTemp(`new-changelog-${process.pid}.md`, newMarkdown);
    return execFileSync('node', [SCRIPT, oldPath, newPath], {
        encoding: 'utf8'
    }).trim();
}

describe('unreleased changelog diff', () => {
    test('returns only newly added Unreleased bullets', () => {
        const oldMarkdown = `# Unreleased

- **Kerning UX**: Existing note.

# v0.2.1

- **Older**: Stable note.
`;
        const newMarkdown = `# Unreleased

- **Themed Scrollbars**: New note.
- **Kerning UX**: Existing note.

# v0.2.1

- **Older**: Stable note.
`;
        expect(diffFiles(oldMarkdown, newMarkdown)).toBe(
            '- **Themed Scrollbars**: New note.'
        );
    });

    test('ignores bullets moved out of Unreleased after a stable release', () => {
        const oldMarkdown = `# Unreleased

- **Kerning UX**: Existing note.

# v0.2.1

- **Older**: Stable note.
`;
        const newMarkdown = `# Unreleased

- **Add items here** for the next release (Replace this comment)

# v0.2.2

- **Kerning UX**: Existing note.

# v0.2.1

- **Older**: Stable note.
`;
        expect(diffFiles(oldMarkdown, newMarkdown)).toBe(
            'No new Unreleased changelog bullets since the previous preview.'
        );
    });
});

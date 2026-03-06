/**
 * @jest-environment node
 */

const { execFileSync } = require('child_process');
const path = require('path');

describe('Dead code regression', () => {
    test('knip reports no unused files or dependency drift', () => {
        const webappDir = path.resolve(__dirname, '..');
        const knipBin = path.join(
            webappDir,
            'node_modules',
            'knip',
            'bin',
            'knip.js'
        );

        try {
            execFileSync(
                process.execPath,
                [
                    knipBin,
                    '--directory',
                    webappDir,
                    '--include',
                    'files,dependencies,unlisted',
                    '--reporter',
                    'compact'
                ],
                {
                    cwd: webappDir,
                    encoding: 'utf8',
                    stdio: 'pipe'
                }
            );
        } catch (error) {
            const output = [error.stdout, error.stderr]
                .filter(Boolean)
                .join('\n')
                .trim();

            throw new Error(output || 'Knip reported dead-code issues.');
        }
    });
});

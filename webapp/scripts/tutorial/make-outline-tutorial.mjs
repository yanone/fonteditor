import { runCommand, webappRoot } from './tutorial-utils.mjs';

async function main() {
    await runCommand(
        'node',
        ['scripts/tutorial/generate-outline-tutorial-audio.mjs'],
        {
            cwd: webappRoot
        }
    );
    await runCommand('node', ['scripts/tutorial/record-outline-tutorial.mjs'], {
        cwd: webappRoot
    });
    await runCommand(
        'node',
        ['scripts/tutorial/assemble-outline-tutorial.mjs'],
        {
            cwd: webappRoot
        }
    );
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

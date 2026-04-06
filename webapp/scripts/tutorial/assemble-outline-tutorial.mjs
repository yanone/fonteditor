import {
    ensureOutputDirs,
    finalVideoPath,
    manifestPath,
    rawVideoPath,
    readJson,
    requireFile,
    runCommand,
    writeJson
} from './tutorial-utils.mjs';

const MAX_FINAL_DURATION_SECONDS = 119.5;

async function main() {
    ensureOutputDirs();
    requireFile(manifestPath, 'Tutorial manifest');
    requireFile(rawVideoPath, 'Raw tutorial video');

    const manifest = readJson(manifestPath);
    requireFile(manifest.combinedAudioFile, 'Combined narration audio');
    const requestedDurationSeconds =
        manifest.recordedTutorialDurationSeconds ||
        manifest.totalDurationSeconds + 1.5;
    const targetDurationSeconds = Number(
        Math.min(requestedDurationSeconds, MAX_FINAL_DURATION_SECONDS).toFixed(
            3
        )
    );
    const trimStartSeconds = Number(
        Math.max(0, manifest.recordingTrimStartSeconds || 0).toFixed(3)
    );

    await runCommand('ffmpeg', [
        '-y',
        '-ss',
        `${trimStartSeconds}`,
        '-i',
        rawVideoPath,
        '-i',
        manifest.combinedAudioFile,
        '-t',
        `${targetDurationSeconds}`,
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        '-c:v',
        'libx264',
        '-preset',
        'slow',
        '-crf',
        '18',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-af',
        'apad',
        finalVideoPath
    ]);

    manifest.finalVideoFile = finalVideoPath;
    manifest.finalDurationSeconds = targetDurationSeconds;
    manifest.finalTrimStartSeconds = trimStartSeconds;
    manifest.assembledAt = new Date().toISOString();
    writeJson(manifestPath, manifest);
    console.log(`Final tutorial video written to ${finalVideoPath}`);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

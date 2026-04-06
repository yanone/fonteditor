import { writeFileSync } from 'fs';
import { join } from 'path';

import { GoogleGenAI } from '@google/genai';

import {
    buildTtsPrompt,
    scenes,
    tutorialId,
    tutorialTitle
} from './outline-scenes.mjs';
import {
    audioDir,
    ensureOutputDirs,
    manifestPath,
    probeDurationSeconds,
    runCommand,
    writeJson
} from './tutorial-utils.mjs';

function getApiKey() {
    return (
        process.env.VERTEX_AI_API_KEY ||
        process.env.GOOGLE_API_KEY ||
        process.env.GEMINI_API_KEY ||
        null
    );
}

function extractInlineData(response) {
    const candidate = response?.candidates?.[0];
    const parts = candidate?.content?.parts || [];

    for (const part of parts) {
        const inlineData = part.inlineData || part.inline_data || null;
        if (inlineData?.data) {
            return inlineData;
        }
    }

    throw new Error('Gemini TTS response did not include inline audio data');
}

function toBuffer(data) {
    if (Buffer.isBuffer(data)) {
        return data;
    }

    if (data instanceof Uint8Array) {
        return Buffer.from(data);
    }

    if (typeof data === 'string') {
        return Buffer.from(data, 'base64');
    }

    throw new Error(`Unsupported audio payload type: ${typeof data}`);
}

function pcmToWavBuffer(pcmBuffer, options = {}) {
    const channels = options.channels || 1;
    const sampleRate = options.sampleRate || 24000;
    const bitsPerSample = options.bitsPerSample || 16;
    const byteRate = (sampleRate * channels * bitsPerSample) / 8;
    const blockAlign = (channels * bitsPerSample) / 8;
    const header = Buffer.alloc(44);

    header.write('RIFF', 0, 4, 'ascii');
    header.writeUInt32LE(36 + pcmBuffer.length, 4);
    header.write('WAVE', 8, 4, 'ascii');
    header.write('fmt ', 12, 4, 'ascii');
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36, 4, 'ascii');
    header.writeUInt32LE(pcmBuffer.length, 40);

    return Buffer.concat([header, pcmBuffer]);
}

async function main() {
    const apiKey = getApiKey();
    if (!apiKey) {
        throw new Error(
            'Expected VERTEX_AI_API_KEY, GOOGLE_API_KEY, or GEMINI_API_KEY in the environment'
        );
    }

    ensureOutputDirs();

    const ai = new GoogleGenAI({ apiKey });
    const manifest = {
        tutorialId,
        tutorialTitle,
        voice: 'Aoede',
        speedMultiplier: 1.1,
        generatedAt: new Date().toISOString(),
        scenes: []
    };

    for (const scene of scenes) {
        const rawPath = join(audioDir, `${scene.id}-raw.wav`);
        const basePath = join(audioDir, `${scene.id}-base.wav`);
        const finalPath = join(audioDir, `${scene.id}.wav`);

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash-preview-tts',
            contents: buildTtsPrompt(scene),
            config: {
                responseModalities: ['AUDIO'],
                speechConfig: {
                    voiceConfig: {
                        prebuiltVoiceConfig: {
                            voiceName: 'Aoede'
                        }
                    }
                }
            }
        });

        const inlineData = extractInlineData(response);
        const audioBuffer = toBuffer(inlineData.data);
        const mimeType = inlineData.mimeType || inlineData.mime_type || '';
        const wavBuffer = /wav/i.test(String(mimeType))
            ? audioBuffer
            : pcmToWavBuffer(audioBuffer);
        writeFileSync(rawPath, wavBuffer);

        await runCommand('ffmpeg', [
            '-y',
            '-i',
            rawPath,
            '-filter:a',
            'atempo=1.1',
            basePath
        ]);

        const baseDurationSeconds = await probeDurationSeconds(basePath);
        const silenceAfterSeconds = Math.max(
            0,
            Number(scene.silenceAfterMs || 0) / 1000
        );

        if (silenceAfterSeconds > 0) {
            await runCommand('ffmpeg', [
                '-y',
                '-i',
                basePath,
                '-af',
                `apad=pad_dur=${silenceAfterSeconds}`,
                '-t',
                `${(baseDurationSeconds + silenceAfterSeconds).toFixed(3)}`,
                finalPath
            ]);
        } else {
            await runCommand('ffmpeg', [
                '-y',
                '-i',
                basePath,
                '-c',
                'copy',
                finalPath
            ]);
        }

        const durationSeconds = await probeDurationSeconds(finalPath);
        manifest.scenes.push({
            ...scene,
            audioFile: finalPath,
            rawAudioFile: rawPath,
            baseAudioFile: basePath,
            durationSeconds,
            durationMs: Math.round(durationSeconds * 1000)
        });
    }

    const concatListPath = join(audioDir, 'concat.txt');
    const combinedAudioPath = join(audioDir, `${tutorialId}-combined.wav`);
    writeFileSync(
        concatListPath,
        manifest.scenes
            .map((scene) => `file '${scene.audioFile.replace(/'/g, "'\\''")}'`)
            .join('\n') + '\n',
        'utf8'
    );

    await runCommand('ffmpeg', [
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        concatListPath,
        '-c',
        'copy',
        combinedAudioPath
    ]);

    manifest.combinedAudioFile = combinedAudioPath;
    manifest.totalDurationSeconds =
        await probeDurationSeconds(combinedAudioPath);
    manifest.totalDurationMs = Math.round(manifest.totalDurationSeconds * 1000);

    writeJson(manifestPath, manifest);
    console.log(`Audio manifest written to ${manifestPath}`);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

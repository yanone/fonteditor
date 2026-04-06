import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    writeFileSync
} from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

import { tutorialOutputDirName } from './outline-scenes.mjs';

const currentDir = dirname(fileURLToPath(import.meta.url));

export const webappRoot = resolve(currentDir, '../../');
export const repoRoot = resolve(webappRoot, '../');
export const outputDir = join(webappRoot, 'temp', tutorialOutputDirName);
export const audioDir = join(outputDir, 'audio');
export const videoDir = join(outputDir, 'video');
export const finalDir = join(outputDir, 'final');
export const manifestPath = join(outputDir, 'manifest.json');
export const rawVideoPath = join(videoDir, 'draw-new-outlines-raw.webm');
export const finalVideoPath = join(finalDir, 'draw-new-outlines-1080p.mp4');

export function ensureDir(dirPath) {
    mkdirSync(dirPath, { recursive: true });
}

export function ensureOutputDirs() {
    ensureDir(outputDir);
    ensureDir(audioDir);
    ensureDir(videoDir);
    ensureDir(finalDir);
}

export function writeJson(filePath, value) {
    writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function readJson(filePath) {
    return JSON.parse(readFileSync(filePath, 'utf8'));
}

export function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function copyFile(sourcePath, targetPath) {
    copyFileSync(sourcePath, targetPath);
}

export async function runCommand(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: options.cwd || webappRoot,
            stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
            env: options.env || process.env
        });

        let stdout = '';
        let stderr = '';

        if (child.stdout) {
            child.stdout.on('data', (chunk) => {
                stdout += chunk.toString();
            });
        }

        if (child.stderr) {
            child.stderr.on('data', (chunk) => {
                stderr += chunk.toString();
            });
        }

        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) {
                resolve({ stdout, stderr });
                return;
            }

            reject(
                new Error(
                    `${command} ${args.join(' ')} failed with code ${code}\n${stderr || stdout}`
                )
            );
        });
    });
}

export async function probeDurationSeconds(filePath) {
    const { stdout } = await runCommand('ffprobe', [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'csv=p=0',
        filePath
    ]);

    const value = Number.parseFloat(stdout.trim());
    if (!Number.isFinite(value)) {
        throw new Error(`Could not read duration for ${filePath}`);
    }

    return value;
}

export function requireFile(filePath, description) {
    if (!existsSync(filePath)) {
        throw new Error(`${description} not found at ${filePath}`);
    }
}

import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';

type ManagedProcess = {
    child: ChildProcess;
    name: string;
};

export type LocalCollabServicesController = {
    dispose: () => Promise<void>;
};

function prefixStream(
    stream: NodeJS.ReadableStream | null,
    prefix: string
): void {
    if (!stream) {
        return;
    }

    let buffered = '';
    stream.on('data', (chunk) => {
        buffered += chunk.toString();
        const lines = buffered.split(/\r?\n/);
        buffered = lines.pop() ?? '';
        for (const line of lines) {
            process.stdout.write(`[${prefix}] ${line}\n`);
        }
    });

    stream.on('end', () => {
        if (buffered.length > 0) {
            process.stdout.write(`[${prefix}] ${buffered}\n`);
        }
    });
}

function spawnManagedProcess(options: {
    name: string;
    command: string;
    args: string[];
    cwd: string;
}): ManagedProcess {
    const child = spawn(options.command, options.args, {
        cwd: options.cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe']
    });

    prefixStream(child.stdout, options.name);
    prefixStream(child.stderr, options.name);

    return {
        child,
        name: options.name
    };
}

function requestStatus(urlString: string): Promise<number> {
    const url = new URL(urlString);
    const client = url.protocol === 'https:' ? https : http;

    return new Promise((resolve, reject) => {
        const request = client.request(
            url,
            {
                method: 'GET',
                rejectUnauthorized: false
            },
            (response) => {
                response.resume();
                resolve(response.statusCode ?? 0);
            }
        );

        request.on('error', reject);
        request.end();
    });
}

async function isHttpReady(url: string): Promise<boolean> {
    try {
        const status = await requestStatus(url);
        return status >= 200 && status < 500;
    } catch {
        return false;
    }
}

async function waitForHttpReady(
    url: string,
    timeoutMs = 120000
): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if (await isHttpReady(url)) {
            return;
        }

        await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    throw new Error(`Timed out waiting for ${url}`);
}

async function terminateProcesses(children: ManagedProcess[]): Promise<void> {
    await Promise.all(
        children.map(
            ({ child }) =>
                new Promise<void>((resolve) => {
                    if (child.exitCode !== null || child.killed) {
                        resolve();
                        return;
                    }

                    child.once('exit', () => resolve());
                    child.kill('SIGTERM');

                    setTimeout(() => {
                        if (child.exitCode === null && !child.killed) {
                            child.kill('SIGKILL');
                        }
                    }, 5000);
                })
        )
    );
}

export async function ensureLocalCollabServices(): Promise<LocalCollabServicesController> {
    const repoRoot = path.resolve(process.cwd(), '..');
    const websiteRoot = path.resolve(repoRoot, '../website');
    const roomWorkerRoot = path.resolve(repoRoot, '../collab/collab');
    const children: ManagedProcess[] = [];

    if (!(await isHttpReady('http://localhost:8788/'))) {
        children.push(
            spawnManagedProcess({
                name: 'website',
                command: 'npm',
                args: ['run', 'dev'],
                cwd: websiteRoot
            })
        );
    }

    if (!(await isHttpReady('http://localhost:8787/health'))) {
        children.push(
            spawnManagedProcess({
                name: 'room-worker',
                command: 'npx',
                args: ['wrangler', 'dev', '--port', '8787'],
                cwd: roomWorkerRoot
            })
        );
    }

    try {
        await waitForHttpReady('http://localhost:8788/');
        await waitForHttpReady('http://localhost:8787/health');
        return {
            dispose: async () => {
                await terminateProcesses(children);
            }
        };
    } catch (error) {
        await terminateProcesses(children);
        throw error;
    }
}

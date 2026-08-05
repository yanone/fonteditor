import { execFile, spawn, type ChildProcess } from 'node:child_process';
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

type WaitForHttpReadyOptions = {
    process?: ManagedProcess;
    timeoutMs?: number;
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
    env?: Record<string, string | undefined>;
}): ManagedProcess {
    const child = spawn(options.command, options.args, {
        cwd: options.cwd,
        env: {
            ...process.env,
            ...(options.env || {})
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });

    prefixStream(child.stdout, options.name);
    prefixStream(child.stderr, options.name);

    return {
        child,
        name: options.name
    };
}

function sanitizeNodeOptionsForChild(
    nodeOptions: string | undefined
): string | undefined {
    if (!nodeOptions) {
        return nodeOptions;
    }

    const tokens = nodeOptions
        .split(/\s+/)
        .map((token) => token.trim())
        .filter(Boolean)
        .filter(
            (token) =>
                !token.startsWith('--inspect') &&
                !token.startsWith('--inspect-brk') &&
                !token.startsWith('--inspect-port')
        );

    return tokens.length ? tokens.join(' ') : undefined;
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

        request.setTimeout(5000, () => {
            request.destroy(new Error(`Timed out requesting ${urlString}`));
        });
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
    options: WaitForHttpReadyOptions = {}
): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 180000;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const child = options.process?.child;
        if (child && child.exitCode !== null) {
            throw new Error(
                `${options.process?.name ?? 'service'} exited before ${url} became ready (exit code ${child.exitCode ?? 'unknown'})`
            );
        }

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
                    if (child.exitCode !== null || child.signalCode !== null) {
                        resolve();
                        return;
                    }

                    child.once('exit', () => resolve());
                    child.kill('SIGTERM');

                    setTimeout(() => {
                        if (
                            child.exitCode === null &&
                            child.signalCode === null
                        ) {
                            child.kill('SIGKILL');
                        }
                    }, 5000);
                })
        )
    );
}

function execFileOutput(
    command: string,
    args: string[]
): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        execFile(command, args, (error, stdout, stderr) => {
            if (error) {
                reject(error);
                return;
            }

            resolve({ stdout, stderr });
        });
    });
}

async function findListeningProcessIds(port: number): Promise<number[]> {
    try {
        const { stdout } = await execFileOutput('lsof', [
            '-nP',
            `-iTCP:${port}`,
            '-sTCP:LISTEN',
            '-t'
        ]);
        return stdout
            .split(/\r?\n/)
            .map((entry) => Number(entry.trim()))
            .filter((pid) => Number.isInteger(pid) && pid > 0);
    } catch {
        return [];
    }
}

async function waitForPortRelease(
    port: number,
    timeoutMs = 10000
): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if ((await findListeningProcessIds(port)).length === 0) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }

    throw new Error(`Timed out waiting for port ${port} to be released`);
}

async function reclaimStalePort(port: number, readyUrl: string): Promise<void> {
    if (await isHttpReady(readyUrl)) {
        return;
    }

    const pids = await findListeningProcessIds(port);
    if (!pids.length) {
        return;
    }

    for (const pid of pids) {
        try {
            process.kill(pid, 'SIGTERM');
        } catch {
            // Ignore processes that exited between lookup and termination.
        }
    }

    try {
        await waitForPortRelease(port, 3000);
        return;
    } catch {
        const remainingPids = await findListeningProcessIds(port);
        for (const pid of remainingPids) {
            try {
                process.kill(pid, 'SIGKILL');
            } catch {
                // Ignore processes that exited between lookup and termination.
            }
        }
    }

    await waitForPortRelease(port, 7000);
}

export async function ensureLocalCollabServices(): Promise<LocalCollabServicesController> {
    const repoRoot = path.resolve(process.cwd(), '..');
    const websiteRoot = path.resolve(repoRoot, '../website');
    const roomWorkerRoot = path.resolve(repoRoot, '../collab/collab');
    const compactorRoot = path.resolve(repoRoot, '../cf-compactor');
    const children: ManagedProcess[] = [];
    let websiteProcess: ManagedProcess | undefined;
    let roomWorkerProcess: ManagedProcess | undefined;
    let compactorProcess: ManagedProcess | undefined;
    const childNodeOptions = sanitizeNodeOptionsForChild(
        process.env.NODE_OPTIONS
    );

    await reclaimStalePort(8788, 'https://localhost:8788/');
    if (!(await isHttpReady('https://localhost:8788/'))) {
        websiteProcess = spawnManagedProcess({
            name: 'website',
            command: 'npm',
            args: ['run', 'dev'],
            cwd: websiteRoot,
            env: {
                NODE_OPTIONS: childNodeOptions
            }
        });
        children.push(websiteProcess);
    }

    await reclaimStalePort(8789, 'http://localhost:8789/health');
    if (!(await isHttpReady('http://localhost:8789/health'))) {
        compactorProcess = spawnManagedProcess({
            name: 'compactor',
            command: 'npx',
            args: [
                'wrangler',
                'dev',
                '--port',
                '8789',
                '--var',
                'COMPACTOR_SHARED_TOKEN:local-test-compactor-token'
            ],
            cwd: compactorRoot,
            env: {
                NODE_OPTIONS: childNodeOptions
            }
        });
        children.push(compactorProcess);
    }

    await reclaimStalePort(8787, 'http://localhost:8787/health');
    if (!(await isHttpReady('http://localhost:8787/health'))) {
        roomWorkerProcess = spawnManagedProcess({
            name: 'room-worker',
            command: 'npx',
            args: [
                'wrangler',
                'dev',
                '--port',
                '8787',
                '--inspector-port',
                '9231',
                '--var',
                'EDITOR_ALLOWED_ORIGINS:https://localhost:8000',
                '--var',
                'AUTH_TOKEN_ALLOW_INSECURE_LOCAL_FALLBACK:true',
                '--var',
                'COMPACTOR_SHARED_TOKEN:local-test-compactor-token'
            ],
            cwd: roomWorkerRoot,
            env: {
                NODE_OPTIONS: childNodeOptions
            }
        });
        children.push(roomWorkerProcess);
    }

    try {
        await Promise.all([
            waitForHttpReady('https://localhost:8788/', {
                process: websiteProcess
            }),
            waitForHttpReady('http://localhost:8789/health', {
                process: compactorProcess
            }),
            waitForHttpReady('http://localhost:8787/health', {
                process: roomWorkerProcess
            })
        ]);
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

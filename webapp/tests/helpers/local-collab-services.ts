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
    const children: ManagedProcess[] = [];
    let websiteProcess: ManagedProcess | undefined;
    let roomWorkerProcess: ManagedProcess | undefined;

    await reclaimStalePort(8788, 'http://localhost:8788/');
    if (!(await isHttpReady('http://localhost:8788/'))) {
        websiteProcess = spawnManagedProcess({
            name: 'website',
            command: 'npm',
            args: ['run', 'dev'],
            cwd: websiteRoot
        });
        children.push(websiteProcess);
    }

    await reclaimStalePort(8787, 'http://localhost:8787/health');
    if (!(await isHttpReady('http://localhost:8787/health'))) {
        roomWorkerProcess = spawnManagedProcess({
            name: 'room-worker',
            command: 'npx',
            args: ['wrangler', 'dev', '--port', '8787'],
            cwd: roomWorkerRoot
        });
        children.push(roomWorkerProcess);
    }

    try {
        await Promise.all([
            waitForHttpReady('http://localhost:8788/', {
                process: websiteProcess
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

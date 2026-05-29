import { spawn } from "node:child_process";
import http from "node:http";
import https from "node:https";

function prefixStream(stream, prefix) {
    let buffered = "";

    stream.on("data", (chunk) => {
        buffered += chunk.toString();
        const lines = buffered.split(/\r?\n/);
        buffered = lines.pop() ?? "";
        for (const line of lines) {
            process.stdout.write(`[${prefix}] ${line}\n`);
        }
    });

    stream.on("end", () => {
        if (buffered.length > 0) {
            process.stdout.write(`[${prefix}] ${buffered}\n`);
        }
    });
}

export function spawnManagedProcess({ name, command, args, cwd, env, onExit }) {
    const child = spawn(command, args, {
        cwd,
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
    });

    prefixStream(child.stdout, name);
    prefixStream(child.stderr, name);

    child.on("exit", (code, signal) => {
        onExit?.({ name, code, signal });
    });

    return child;
}

export async function waitForHttpReady(url, options = {}) {
    const timeoutMs = options.timeoutMs ?? 120000;
    const intervalMs = options.intervalMs ?? 1000;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        try {
            const status = await requestStatus(url);
            if (status >= 200 && status < 500) {
                return;
            }
        } catch {
            // Keep polling until the service is ready.
        }

        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new Error(`Timed out waiting for ${url}`);
}

export async function isHttpReady(url) {
    try {
        const status = await requestStatus(url);
        return status >= 200 && status < 500;
    } catch {
        return false;
    }
}

function requestStatus(urlString) {
    const url = new URL(urlString);
    const client = url.protocol === "https:" ? https : http;

    return new Promise((resolve, reject) => {
        const req = client.request(
            url,
            {
                method: "GET",
                rejectUnauthorized: false,
            },
            (res) => {
                res.resume();
                resolve(res.statusCode ?? 0);
            },
        );

        req.on("error", reject);
        req.end();
    });
}

export async function terminateProcesses(children) {
    await Promise.all(
        children.filter(Boolean).map(
            (child) =>
                new Promise((resolve) => {
                    if (child.exitCode !== null || child.signalCode !== null) {
                        resolve();
                        return;
                    }

                    child.once("exit", () => resolve());
                    child.kill("SIGTERM");

                    setTimeout(() => {
                        if (
                            child.exitCode === null &&
                            child.signalCode === null
                        ) {
                            child.kill("SIGKILL");
                        }
                    }, 5000);
                }),
        ),
    );
}

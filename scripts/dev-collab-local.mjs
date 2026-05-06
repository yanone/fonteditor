import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    isHttpReady,
    spawnManagedProcess,
    terminateProcesses,
    waitForHttpReady,
} from "./collab-local-utils.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const websiteRoot = path.resolve(repoRoot, "../website");
const roomWorkerRoot = path.resolve(websiteRoot, "workers/fonts-room");
const editorWebappRoot = path.resolve(repoRoot, "webapp");

const children = [];
let shuttingDown = false;

function requestShutdown() {
    if (shuttingDown) {
        return;
    }
    shuttingDown = true;
    terminateProcesses(children)
        .then(() => process.exit(0))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}

function handleChildExit({ name, code, signal }) {
    if (shuttingDown) {
        return;
    }

    console.error(
        `[orchestrator] ${name} exited unexpectedly (${signal ?? code ?? "unknown"})`,
    );
    requestShutdown();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, requestShutdown);
}

if (!(await isHttpReady("http://localhost:8788/api/auth/me"))) {
    children.push(
        spawnManagedProcess({
            name: "website",
            command: "npm",
            args: ["run", "dev"],
            cwd: websiteRoot,
            onExit: handleChildExit,
        }),
    );
}

if (!(await isHttpReady("http://localhost:8787/health"))) {
    children.push(
        spawnManagedProcess({
            name: "room-worker",
            command: "npx",
            args: ["wrangler", "dev", "--port", "8787"],
            cwd: roomWorkerRoot,
            onExit: handleChildExit,
        }),
    );
}

if (!(await isHttpReady("https://localhost:8000"))) {
    children.push(
        spawnManagedProcess({
            name: "editor",
            command: "npm",
            args: ["run", "dev"],
            cwd: editorWebappRoot,
            onExit: handleChildExit,
        }),
    );
}

await waitForHttpReady("http://localhost:8788/api/auth/me");
await waitForHttpReady("http://localhost:8787/health");
await waitForHttpReady("https://localhost:8000");

console.log("[orchestrator] Local collaboration stack is ready");
console.log("[orchestrator] Editor: https://localhost:8000");
console.log("[orchestrator] Website: http://localhost:8788");
console.log("[orchestrator] Room worker: http://localhost:8787/health");

await new Promise(() => {});

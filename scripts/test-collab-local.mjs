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
const roomWorkerRoot = path.resolve(repoRoot, "../collab/collab");
const editorWebappRoot = path.resolve(repoRoot, "webapp");

const children = [];

try {
    if (!(await isHttpReady("http://localhost:8788/api/auth/me"))) {
        children.push(
            spawnManagedProcess({
                name: "website",
                command: "npm",
                args: ["run", "dev"],
                cwd: websiteRoot,
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
            }),
        );
    }

    await waitForHttpReady("http://localhost:8788/api/auth/me");
    await waitForHttpReady("http://localhost:8787/health");

    const playwright = spawnManagedProcess({
        name: "playwright",
        command: "npx",
        args: ["playwright", "test", "tests/cloud-collaboration-local.spec.ts"],
        cwd: editorWebappRoot,
    });

    const exitCode = await new Promise((resolve) => {
        playwright.on("exit", (code) => resolve(code ?? 1));
    });

    if (exitCode !== 0) {
        process.exitCode = exitCode;
    }
} finally {
    await terminateProcesses(children);
}

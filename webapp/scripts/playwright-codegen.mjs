#!/usr/bin/env node

import { spawn } from 'node:child_process';
import process from 'node:process';
import worktreeConfig from './worktree-config.cjs';

const { getWorktreeAppUrl } = worktreeConfig;

const child = spawn(
    'npx',
    ['playwright', 'codegen', '--ignore-https-errors', getWorktreeAppUrl()],
    {
        stdio: 'inherit',
        shell: false
    }
);

child.on('exit', (code, signal) => {
    if (signal) {
        process.kill(process.pid, signal);
        return;
    }

    process.exit(code ?? 1);
});
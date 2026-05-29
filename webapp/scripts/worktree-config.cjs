const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_DEV_PORT = 8000;
const WORKTREE_CONFIG_PATH = path.resolve(
    __dirname,
    '..',
    'worktree-config.json'
);

function readWorktreeConfig() {
    try {
        return JSON.parse(fs.readFileSync(WORKTREE_CONFIG_PATH, 'utf8'));
    } catch (_error) {
        return {};
    }
}

function getWorktreePort() {
    const config = readWorktreeConfig();
    return Number.isInteger(config.port) ? config.port : DEFAULT_DEV_PORT;
}

function getWorktreeAppUrl(pathname = '') {
    const normalizedPath = !pathname
        ? ''
        : pathname.startsWith('/')
          ? pathname
          : `/${pathname}`;
    return `https://localhost:${getWorktreePort()}${normalizedPath}`;
}

module.exports = {
    DEFAULT_DEV_PORT,
    WORKTREE_CONFIG_PATH,
    readWorktreeConfig,
    getWorktreePort,
    getWorktreeAppUrl
};
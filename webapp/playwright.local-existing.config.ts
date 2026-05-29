/// <reference types="node" />

import baseConfig from './playwright.config';

const { getWorktreeAppUrl } = require('./scripts/worktree-config.cjs');

export default {
    ...baseConfig,
    use: {
        ...baseConfig.use,
        baseURL: getWorktreeAppUrl()
    },
    webServer: undefined
};

import baseConfig from './playwright.config';

export default {
    ...baseConfig,
    use: {
        ...baseConfig.use,
        baseURL: 'https://localhost:8000'
    },
    webServer: undefined
};

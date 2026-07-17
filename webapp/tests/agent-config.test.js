const { AGENT_SYSTEM_PROMPT, AGENT_TOOLS } = require('../js/agent-config.ts');

describe('agent configuration', () => {
    test('directs users to enable font editing from the Agent title bar', () => {
        expect(AGENT_SYSTEM_PROMPT).toContain(
            'enable editing with the pen button in the Agent title bar'
        );
        expect(AGENT_SYSTEM_PROMPT).toContain('before sending a new prompt');
    });

    test('requires the Python authoring guide before substantive Python edits', () => {
        expect(AGENT_SYSTEM_PROMPT).toContain(
            'call python_authoring_guide for its kind'
        );
        const guideTool = AGENT_TOOLS.find(
            ({ function: tool }) => tool.name === 'python_authoring_guide'
        );
        expect(guideTool.function.parameters).toMatchObject({
            required: ['kind'],
            properties: {
                kind: {
                    enum: ['general-script', 'glyph-filter']
                }
            }
        });
    });
});

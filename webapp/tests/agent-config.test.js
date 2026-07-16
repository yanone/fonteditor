const { AGENT_SYSTEM_PROMPT } = require('../js/agent-config.ts');

describe('agent configuration', () => {
    test('directs users to enable font editing from the Agent title bar', () => {
        expect(AGENT_SYSTEM_PROMPT).toContain(
            'enable font editing with the pen button in the Agent title bar'
        );
        expect(AGENT_SYSTEM_PROMPT).toContain('before sending a new prompt');
    });
});

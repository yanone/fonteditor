const { AGENT_SYSTEM_PROMPT, AGENT_TOOLS } = require('../js/agent-config.ts');

describe('agent configuration', () => {
    test('directs users to enable font editing from the Agent title bar', () => {
        expect(AGENT_SYSTEM_PROMPT).toContain(
            'enable editing with the pen button in the Agent title bar'
        );
        expect(AGENT_SYSTEM_PROMPT).toContain('before sending a new prompt');
    });

    test('gives a literal Python document workflow before substantive edits', () => {
        expect(AGENT_SYSTEM_PROMPT).toContain(
            'Follow this exact workflow for Python authoring'
        );
        expect(AGENT_SYSTEM_PROMPT).toContain('get_active_python_document');
        expect(AGENT_SYSTEM_PROMPT).toContain(
            'call python_authoring_guide only after the kind is clear'
        );
        expect(AGENT_SYSTEM_PROMPT).toContain(
            'do not treat editorKind general-script as authoritative'
        );
        expect(AGENT_SYSTEM_PROMPT).toContain(
            'validate_python_document after every create or replace'
        );
        const activeDocumentTool = AGENT_TOOLS.find(
            ({ function: tool }) => tool.name === 'get_active_python_document'
        );
        expect(activeDocumentTool.function.description).toContain(
            'inspect kindConfidence and kindMessage'
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
        expect(
            guideTool.function.parameters.properties.kind.description
        ).toContain('user runs from Script Editor');
        expect(guideTool.function.description).toContain(
            'handbook discovery is not required'
        );
    });
});

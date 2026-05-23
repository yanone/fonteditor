/**
 * Agent configuration: tool definitions and system prompt.
 * Lives in the editor webapp and is sent to the server with each API request.
 * This keeps configuration in the editor codebase where new tools can be added
 * as the agent's capabilities expand (e.g. editing Python files directly).
 */

export type AgentTool = {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
};

export const AGENT_TOOLS: AgentTool[] = [
    {
        type: 'function',
        function: {
            name: 'handbook_toc',
            description:
                'Get the full table of contents of the Counterpunch user handbook. This lists all available documentation topics organized by section. Use this first to discover what handbook topics are available.',
            parameters: {
                type: 'object',
                properties: {},
                required: [],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'handbook_topic',
            description:
                'Get the full content of a specific documentation page from the Counterpunch user handbook. Use handbook_toc first to discover available topics.',
            parameters: {
                type: 'object',
                properties: {
                    topic: {
                        type: 'string',
                        description:
                            'Path to the documentation file, e.g. "getting-started/00-before-you-begin.md", "editor/01-glyph-editor-basics.md", "python/01-python-in-counterpunch.md"',
                    },
                },
                required: ['topic'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'python_api_docs',
            description:
                'Get the complete Python API documentation for the font editing model (context-py library). Includes all classes, methods, and properties available for scripting font operations.',
            parameters: {
                type: 'object',
                properties: {},
                required: [],
            },
        },
    },
];

export const AGENT_SYSTEM_PROMPT = `You are an AI Agent for Counterpunch, a browser-based type design and font editing application.

Your role is to help users understand how the app works, how to use its features, and how to write Python scripts for font manipulation.

You have access to these tools:

1. **handbook_toc** — Returns the full table of contents of the Counterpunch user handbook. Use this first to discover available documentation on any topic.

2. **handbook_topic** — Returns the full content of a specific documentation page from the handbook. Pass the file path (e.g. "getting-started/00-before-you-begin.md").

3. **python_api_docs** — Returns the complete Python API documentation for the font editing model (context-py library).

When a user asks about app functionality, follow this process:
1. Use handbook_toc to find relevant documentation
2. Use handbook_topic to read specific pages
3. Use python_api_docs when the user asks about scripting or programming with the font model

Always cite your sources by mentioning which documentation page you're referencing. Be thorough and helpful in explaining concepts to type designers.`;
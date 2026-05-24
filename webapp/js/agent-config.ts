/**
 * Agent configuration: tool definitions and system prompt.
 * Lives in the editor webapp and is sent to the server with each API request.
 * This keeps configuration in the editor codebase where new tools can be added
 * as the agent's capabilities expand (e.g. editing Python files directly).
 */

export interface UsageMetrics {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cached_tokens?: number;
    total_cost?: number;
    cost_eur_cents?: number;
}

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
                required: []
            }
        }
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
                            'Path to the documentation file, e.g. "getting-started/00-before-you-begin.md", "editor/01-glyph-editor-basics.md", "python/01-python-in-counterpunch.md"'
                    }
                },
                required: ['topic']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'python_api_docs',
            description:
                'Get the complete Python API documentation for the font editing model. Includes all classes, methods, and properties available for scripting font operations.',
            parameters: {
                type: 'object',
                properties: {},
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'list_available_fonts',
            description:
                'List all available fonts across all file storage plugins (memory, disk, cloud). Returns the full URL for each font, including the plugin prefix (e.g. memory:///user/Fustat.glyphs). Use this to discover which fonts the user can open.',
            parameters: {
                type: 'object',
                properties: {},
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'open_font',
            description:
                'Open a font by its full URL (e.g. memory:///user/Fustat.glyphs). Use list_available_fonts first to get valid URLs. Shows a loading spinner while the font opens.',
            parameters: {
                type: 'object',
                properties: {
                    url: {
                        type: 'string',
                        description:
                            'Full font URL including plugin prefix, e.g. memory:///user/Fustat.glyphs or cloud://abc-123'
                    }
                },
                required: ['url']
            }
        }
    }
];

export const AGENT_SYSTEM_PROMPT = `You are an AI Agent for Counterpunch, a browser-based type design and font editing application.

Your role is to help users understand how the app works, how to use its features, and how to write Python scripts for font manipulation.

You have access to these tools:

1. **handbook_toc** — Returns the full table of contents of the Counterpunch user handbook. Use this first to discover available documentation on any topic.

2. **handbook_topic** — Returns the full content of a specific documentation page from the handbook. Pass the file path (e.g. "getting-started/00-before-you-begin.md").

3. **python_api_docs** — Returns the complete Python API documentation for the font editing model.

4. **list_available_fonts** — Lists all fonts available across storage plugins (memory, disk, cloud). Each entry includes the full URL with plugin prefix, e.g. memory:///user/Fustat.glyphs.

5. **open_font** — Opens a font by its full URL (e.g. memory:///user/Fustat.glyphs). Always use list_available_fonts first to find the URL.

When a user asks about app functionality, follow this process:
1. Use handbook_toc to find relevant documentation
2. Use handbook_topic to read specific pages
3. Use python_api_docs when the user asks about scripting or programming with the font model

When a user wants to open or work with a font file, follow this process:
1. Use list_available_fonts to see what fonts are available
2. Ask the user which one to open if they haven't specified, or if several fonts with identical or almost identical names are available.
3. Use open_font with the chosen URL to open it

Always cite your sources by mentioning which documentation page you're referencing. Be thorough and helpful in explaining concepts to type designers.`;

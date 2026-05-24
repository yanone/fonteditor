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
    },
    {
        type: 'function',
        function: {
            name: 'current_font',
            description:
                'Get the currently open font details. Returns the font name and URL in the same format as list_available_fonts. Use this before open_font to avoid reopening an already-open font.',
            parameters: {
                type: 'object',
                properties: {},
                required: []
            }
        }
    }
];

export const AGENT_SYSTEM_PROMPT = `You are an AI Agent for Counterpunch, a browser-based font editor.

Your role is to help users understand how the app works, how to use its features, and how to write Python scripts for font manipulation.

Be thorough and helpful in explaining concepts to type designers, and keep your output short and precise and refrain from using emojis when possible.

Use the available tools to operate the app.
`;

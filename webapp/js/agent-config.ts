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
    },
    {
        type: 'function',
        function: {
            name: 'execute_python_code',
            description:
                "Execute a custom Python script to read or modify the current font. Use the tool `python_api_docs` first to learn how to write Python scripts for the font model. The font is accessible via the Font() function which is readily available and doesn't need to be imported. Print output with print() to see results. Changes to the font model are automatically tracked and compiled.",
            parameters: {
                type: 'object',
                properties: {
                    code: {
                        type: 'string',
                        description: 'The Python code to execute.'
                    }
                },
                required: ['code']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_editor_state',
            description:
                "Get the current editor state: the text buffer contents, the complete list of available OpenType features, which features are activatable (available in the current font subset defined by the text buffer and GSUB layout closure), which features are currently activated, and the shaped glyph buffer as returned by HarfBuzz. Use this to understand the current text layout and feature configuration before making changes. This state can change depending on OpenType feature code edits, so you may have to refresh it after executing code that modifies the text buffer or opentype features or font data. OpenType features that are not activatable in the current context (e.g. 'liga' when only single-letter glyphs are in the text buffer) are returned with \"activatable\": false and cannot be activated until the text buffer or font data is modified to a state where they become activatable. Don\'t explain to the user that these features don\'t exist in the font. They do exist, just not as part of the current subset font which is not the complete font that the user is editing but only the subset based on the current text buffer and GSUB layout closure.",
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
            name: 'set_editor_text_buffer',
            description:
                'Set the text buffer contents. The string may include encoded Unicode characters as well as glyph names using the /glyphname notation. Several glyph names may appear consecutively, but the last one needs to have a space character as a suffix before encoded characters may follow. Use tool `get_editor_state` first to see the current buffer.',
            parameters: {
                type: 'object',
                properties: {
                    text: {
                        type: 'string',
                        description:
                            'The new text buffer content. Supports /glyphname notation for explicit glyph references, space-separated. Example: "H/Ohorn/e/l/l/o" or "ABC /fi /ffi def".'
                    }
                },
                required: ['text']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'set_editor_opentype_features',
            description:
                'Set which OpenType features are activated. Provide a list of feature tags to enable. All other features are set to false. Use tool `get_editor_state` first to see available features and their tags.',
            parameters: {
                type: 'object',
                properties: {
                    features: {
                        type: 'array',
                        items: { type: 'string' },
                        description:
                            'Array of OpenType feature tags to enable (e.g. ["liga", "kern", "dlig"]). All features not in this list will be disabled.'
                    }
                },
                required: ['features']
            }
        }
    }
];

export const AGENT_SYSTEM_PROMPT = `You are an AI Agent for Counterpunch, a browser-based font editor.

Your role is to help users understand how the app works, how to use its features, and how to write Python scripts for font introspection and manipulation.

Be thorough and helpful in explaining concepts to type designers, and keep your output short and precise and refrain from using emojis when possible.

Use the available tools to operate the app.

CRITICAL RULE: If the user prompt is not about the broad topic of fonts and font engineering, or about how to use the Counterpunch app, or type design in general, then politely REFUSE to answer the question and let the user know what topics you can help with. Do not answer questions about topics outside of font design and Counterpunch usage. Always steer the user back to font design and using the app."
`;

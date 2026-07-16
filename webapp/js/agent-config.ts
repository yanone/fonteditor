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
                'Get the current editor state for both inspection and parameter-copying. Returns raw text-buffer syntax as textBuffer and textBufferRaw, user-visible text as textBufferDisplay, parsed explicit glyph tokens, HarfBuzz shaped buffers (glyph names, gids, advances, clusters), the complete current OpenType feature inventory with descriptions, subset availability, and activation flags, a per-feature tag-to-boolean activation dictionary, the current userspace location, the current designspace location, and the current file. In raw text syntax, // represents one literal slash and /glyphname is an explicit glyph reference only when it resolves; never claim an escaped slash pair unless textBufferRaw explicitly contains //. Use this to understand the active text layout and feature configuration, and also to copy explicit inputs for compile_and_shape_font. This state can change after text, feature, or font-data edits, so refresh it when needed.',
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
            name: 'get_font_opentype_info',
            description:
                'Explain how OpenType shaping depends on script-specific shaper execution order for the current font. Reports the explicit feature source order as defined in the font, clarifies that source order is not shaping order, and then reproduces the shaper-specific feature sections shown in the features sidebar for every shaper currently in use.',
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
            name: 'search_font_opentype_classes_and_features',
            description:
                "Search the current font's OpenType classes and features using the same term-based matching logic as the search field in the OpenType editor sidebar. Returns matching class names, glyph names, and lines of feature code. Feature matches are reported with the feature source-order index and the matching line numbers within each feature. If you want to see the entire content of a certain feature, it is better to read it via Python, as `search_font_opentype_classes_and_features` will only match glyph names in classes as well as glyphs names and class names in features.",
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description:
                            'Search query, split into space-separated search terms just like the OpenType editor search field. Example: "grave" or "grave @marks".'
                    }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'set_editor_text_buffer',
            description:
                'Set the raw text-buffer contents. The string may include encoded Unicode characters, literal slashes encoded as //, and explicit glyph names using the /glyphname notation. Several glyph names may appear consecutively, but the last one needs to have a space character as a suffix before encoded characters may follow. Use tool `get_editor_state` first to inspect textBufferRaw, textBufferDisplay, and explicitGlyphTokens.',
            parameters: {
                type: 'object',
                properties: {
                    text: {
                        type: 'string',
                        description:
                            'The new raw text buffer content. Use // for one literal slash and /glyphname for an explicit glyph reference. Example: "H/Ohorn/e/l/l/o", "ABC /fi /ffi def", or "0//10" for the visible text 0/10.'
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
    },
    {
        type: 'function',
        function: {
            name: 'compile_and_shape_font',
            description:
                'Compile the current font and shape `text` with explicit inputs only. Use this when you need a state-style shaping result without relying on the editor UI state. Empty `text` compiles the full font; non-empty `text` compiles and shapes a subset seeded from that text. `featureOverrides` is an optional tag-to-boolean map that overrides HarfBuzz defaults. `userspaceLocation` and `designspaceLocation` are optional variation-location overrides; provide at most one of them. The result includes shaped buffers, feature state, file, and `fontRevision`. Compile artifacts may be reused internally, but shaping is evaluated on every call with the current inputs.',
            parameters: {
                type: 'object',
                properties: {
                    text: {
                        type: 'string',
                        description:
                            'Required. Text to shape. Empty string means full-font mode; non-empty string means subset mode.'
                    },
                    featureOverrides: {
                        type: 'object',
                        description:
                            'Optional. OpenType feature override dictionary, e.g. {"liga": false, "kern": true}. Omit it or pass {} to use HarfBuzz defaults without overrides.'
                    },
                    userspaceLocation: {
                        type: 'object',
                        description:
                            'Optional. Userspace variation location override, e.g. {"wght": 500}. Omit it to avoid overriding the font default location. Do not provide this together with designspaceLocation.'
                    },
                    designspaceLocation: {
                        type: 'object',
                        description:
                            'Optional. Designspace location override, e.g. {"wght": 75}. Omit it to avoid overriding the font default location. Do not provide this together with userspaceLocation.'
                    }
                },
                required: ['text']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'set_prompt_history_summary',
            description:
                'Record a concise summary of this prompt for the font history item. Call this as soon as you understand the requested font work, before making any edits. This summary is not shown in the chat.',
            parameters: {
                type: 'object',
                properties: {
                    summary: {
                        type: 'string',
                        description:
                            'A short, concrete description of the intended font changes, suitable for the history panel.'
                    }
                },
                required: ['summary']
            }
        }
    }
];

export const AGENT_SYSTEM_PROMPT = `You are an AI Agent for Counterpunch, a browser-based font editor.

Your role is to help users understand how the app works, how to use its features, and how to write Python scripts for font introspection and manipulation.

Be thorough and helpful in explaining concepts to type designers, and keep your output short and precise and refrain from using emojis when possible.

Use the available tools to operate the app.

At the beginning of every prompt, call set_prompt_history_summary with a concise description of the requested font work. Do not mention that summary in your chat response.

Every request includes the current editor state and whether font editing is allowed. Treat that permission as authoritative. When font editing is disabled, you may still inspect the font and adjust editor UI state, but you must not modify font data. If you decline an edit because of this permission, tell the user that they can enable font editing with the pen button in the Agent title bar before sending a new prompt. You cannot change the permission yourself, and it remains frozen for the current prompt.

CRITICAL RULE: If the user prompt is not about the broad topic of fonts and font engineering, or about how to use the Counterpunch app, or type design in general, then politely REFUSE to answer the question and let the user know what topics you can help with. Do not answer questions about topics outside of font design and Counterpunch usage. Always steer the user back to font design and using the app."
`;

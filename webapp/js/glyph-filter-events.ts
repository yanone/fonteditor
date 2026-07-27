/**
 * Stable event contract used to decide when glyph filters should refresh.
 * Event emission and filter execution intentionally live outside this registry.
 */
export const GLYPH_FILTER_EVENT_TYPES = [
    'font.opened',
    'font.replaced',
    'glyph.created',
    'glyph.deleted',
    'glyph.renamed',
    'glyph.unicode.changed',
    'glyph.compatibility.changed',
    'font.masters.changed'
] as const;

export type GlyphFilterEventType = (typeof GLYPH_FILTER_EVENT_TYPES)[number];

export type GlyphFilterEventMetadataFieldType =
    'boolean' | 'number' | 'string' | 'string[]' | 'number | null';

export interface GlyphFilterEventMetadataField {
    name: string;
    type: GlyphFilterEventMetadataFieldType;
    description: string;
    required: boolean;
}

export interface GlyphFilterEventDefinition {
    name: string;
    description: string;
    metadataFields: readonly GlyphFilterEventMetadataField[];
}

export const GLYPH_FILTER_EVENT_REGISTRY = {
    'font.opened': {
        name: 'Font Opened',
        description:
            'A font finished opening and is available to glyph filters.',
        metadataFields: [
            {
                name: 'fontName',
                type: 'string',
                description: "The opened font's display name.",
                required: true
            },
            {
                name: 'source',
                type: 'string',
                description: 'The source from which the font was opened.',
                required: true
            }
        ]
    },
    'font.replaced': {
        name: 'Font Replaced',
        description: 'The active font was replaced by a different font.',
        metadataFields: [
            {
                name: 'fontName',
                type: 'string',
                description: "The replacement font's display name.",
                required: true
            },
            {
                name: 'previousFontName',
                type: 'string',
                description: "The replaced font's display name.",
                required: true
            }
        ]
    },
    'glyph.created': {
        name: 'Glyph Created',
        description: 'A glyph was added to the active font.',
        metadataFields: [
            {
                name: 'glyphName',
                type: 'string',
                description: "The new glyph's name.",
                required: true
            },
            {
                name: 'unicode',
                type: 'number | null',
                description: "The glyph's assigned Unicode value, if any.",
                required: false
            }
        ]
    },
    'glyph.deleted': {
        name: 'Glyph Deleted',
        description: 'A glyph was removed from the active font.',
        metadataFields: [
            {
                name: 'glyphName',
                type: 'string',
                description: "The removed glyph's name.",
                required: true
            }
        ]
    },
    'glyph.renamed': {
        name: 'Glyph Renamed',
        description: "A glyph's name changed in the active font.",
        metadataFields: [
            {
                name: 'glyphName',
                type: 'string',
                description: "The glyph's new name.",
                required: true
            },
            {
                name: 'previousGlyphName',
                type: 'string',
                description: "The glyph's name before the rename.",
                required: true
            }
        ]
    },
    'glyph.unicode.changed': {
        name: 'Glyph Unicode Changed',
        description: "A glyph's Unicode assignment changed.",
        metadataFields: [
            {
                name: 'glyphName',
                type: 'string',
                description: "The changed glyph's name.",
                required: true
            },
            {
                name: 'unicode',
                type: 'number | null',
                description: "The glyph's new Unicode value, if any.",
                required: true
            },
            {
                name: 'previousUnicode',
                type: 'number | null',
                description: "The glyph's previous Unicode value, if any.",
                required: true
            }
        ]
    },
    'glyph.compatibility.changed': {
        name: 'Glyph Compatibility Changed',
        description: "A glyph's layer compatibility changed.",
        metadataFields: [
            {
                name: 'glyphName',
                type: 'string',
                description: 'The glyph whose compatibility changed.',
                required: true
            },
            {
                name: 'compatible',
                type: 'boolean',
                description:
                    "Whether the glyph's relevant layers are compatible.",
                required: true
            },
            {
                name: 'layerIds',
                type: 'string[]',
                description:
                    'The layer IDs considered by the compatibility check.',
                required: true
            }
        ]
    },
    'font.masters.changed': {
        name: 'Font Masters Changed',
        description: "The active font's master list changed.",
        metadataFields: [
            {
                name: 'masterIds',
                type: 'string[]',
                description: 'The complete master ID list after the change.',
                required: true
            }
        ]
    }
} as const satisfies Record<GlyphFilterEventType, GlyphFilterEventDefinition>;

export type GlyphFilterEventMetadataValue =
    boolean | number | string | readonly string[] | null;

export interface GlyphFilterChange {
    type: GlyphFilterEventType;
    metadata: Readonly<Record<string, GlyphFilterEventMetadataValue>>;
}

export interface GlyphFilterChangeBatch {
    changes: readonly GlyphFilterChange[];
}

export interface GlyphFilterAssistantEventDefinition {
    type: GlyphFilterEventType;
    name: string;
    description: string;
    metadataFields: readonly GlyphFilterEventMetadataField[];
}

export interface GlyphFilterEventAssistantView {
    events: readonly GlyphFilterAssistantEventDefinition[];
}

/** Returns whether a string is one of the registered glyph filter event types. */
export function isGlyphFilterEventType(
    value: string
): value is GlyphFilterEventType {
    return GLYPH_FILTER_EVENT_TYPES.includes(value as GlyphFilterEventType);
}

/** Returns the registry contract in a JSON-serializable assistant-facing shape. */
export function getGlyphFilterEventAssistantView(): GlyphFilterEventAssistantView {
    return {
        events: GLYPH_FILTER_EVENT_TYPES.map((type) => ({
            type,
            name: GLYPH_FILTER_EVENT_REGISTRY[type].name,
            description: GLYPH_FILTER_EVENT_REGISTRY[type].description,
            metadataFields: GLYPH_FILTER_EVENT_REGISTRY[
                type
            ].metadataFields.map((field) => ({ ...field }))
        }))
    };
}

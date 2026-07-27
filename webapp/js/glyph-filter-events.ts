/**
 * Stable event contract used to decide when glyph filters should refresh.
 * Event emission and filter execution intentionally live outside this registry.
 *
 * Host derivation lives in `glyph-filter-change-derivation.ts` and is invoked
 * from `GlyphOverviewFilterManager.handleCommittedChangeEntries` after each
 * committed change-bridge batch. Filters subscribe via `EVENT_TYPES` /
 * `event_types` using these dotted names only — browser `CustomEvent` names
 * are not part of the plugin API.
 *
 * Full rebuilds (font open, filter activate/reload) are host-driven: the host
 * calls `filter_glyphs(font)` directly with an empty change batch and does
 * not go through `apply_changes`. Event types cover incremental edits only.
 */
export const GLYPH_FILTER_EVENT_TYPES = [
    'glyph.created',
    'glyph.deleted',
    'glyph.renamed',
    'glyph.unicode.changed',
    'glyph.category.changed',
    'glyph.export.changed',
    'glyph.production-name.changed',
    'glyph.paths.changed',
    'glyph.components.changed',
    'glyph.component.reference.changed',
    'glyph.component.transform.changed',
    'glyph.anchors.changed',
    'glyph.guides.changed',
    'glyph.layers.changed',
    'glyph.layer.location.changed',
    'glyph.metrics.changed',
    'glyph.metrics-key.changed',
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

const GLYPH_NAME_FIELD: GlyphFilterEventMetadataField = {
    name: 'glyphName',
    type: 'string',
    description: "The affected glyph's name.",
    required: true
};

const LAYER_IDS_FIELD: GlyphFilterEventMetadataField = {
    name: 'layerIds',
    type: 'string[]',
    description: 'Layer IDs touched by the change, when known.',
    required: false
};

export const GLYPH_FILTER_EVENT_REGISTRY = {
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
    'glyph.category.changed': {
        name: 'Glyph Category Changed',
        description: "A glyph's category assignment changed.",
        metadataFields: [GLYPH_NAME_FIELD]
    },
    'glyph.export.changed': {
        name: 'Glyph Export Changed',
        description: "A glyph's export flag changed.",
        metadataFields: [GLYPH_NAME_FIELD]
    },
    'glyph.production-name.changed': {
        name: 'Glyph Production Name Changed',
        description: "A glyph's production name changed.",
        metadataFields: [GLYPH_NAME_FIELD]
    },
    'glyph.paths.changed': {
        name: 'Glyph Paths Changed',
        description:
            'Path geometry or path structure on one or more layers of a glyph changed.',
        metadataFields: [GLYPH_NAME_FIELD, LAYER_IDS_FIELD]
    },
    'glyph.components.changed': {
        name: 'Glyph Components Changed',
        description:
            'Component membership on one or more layers of a glyph changed (add, remove, or replace).',
        metadataFields: [GLYPH_NAME_FIELD, LAYER_IDS_FIELD]
    },
    'glyph.component.reference.changed': {
        name: 'Glyph Component Reference Changed',
        description: 'A component instance changed which glyph it references.',
        metadataFields: [GLYPH_NAME_FIELD, LAYER_IDS_FIELD]
    },
    'glyph.component.transform.changed': {
        name: 'Glyph Component Transform Changed',
        description: 'A component instance transform changed.',
        metadataFields: [GLYPH_NAME_FIELD, LAYER_IDS_FIELD]
    },
    'glyph.anchors.changed': {
        name: 'Glyph Anchors Changed',
        description: 'Anchors on one or more layers of a glyph changed.',
        metadataFields: [GLYPH_NAME_FIELD, LAYER_IDS_FIELD]
    },
    'glyph.guides.changed': {
        name: 'Glyph Guides Changed',
        description: 'Guides on one or more layers of a glyph changed.',
        metadataFields: [GLYPH_NAME_FIELD, LAYER_IDS_FIELD]
    },
    'glyph.layers.changed': {
        name: 'Glyph Layers Changed',
        description:
            'A glyph layer was added, removed, or otherwise structurally changed.',
        metadataFields: [GLYPH_NAME_FIELD, LAYER_IDS_FIELD]
    },
    'glyph.layer.location.changed': {
        name: 'Glyph Layer Location Changed',
        description:
            'An intermediate layer location (designspace coordinates) changed.',
        metadataFields: [GLYPH_NAME_FIELD, LAYER_IDS_FIELD]
    },
    'glyph.metrics.changed': {
        name: 'Glyph Metrics Changed',
        description:
            'Layer metrics such as advance width or sidebearings changed.',
        metadataFields: [GLYPH_NAME_FIELD, LAYER_IDS_FIELD]
    },
    'glyph.metrics-key.changed': {
        name: 'Glyph Metrics Key Changed',
        description:
            'A glyph- or layer-level metrics key (LSB/RSB formula) changed.',
        metadataFields: [GLYPH_NAME_FIELD, LAYER_IDS_FIELD]
    },
    'glyph.compatibility.changed': {
        name: 'Glyph Compatibility Changed',
        description:
            "A glyph's outline compatibility boolean (`Glyph.isCompatible`) toggled.",
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
                    "Whether the glyph's relevant layers are compatible after the change.",
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

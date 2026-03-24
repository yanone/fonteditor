/**
 * Type extensions for Babelfont types
 * Keep generator-owned upstream types in babelfont.d.ts untouched.
 * Put app-specific augmentations and helper types here instead.
 */

import type { Babelfont } from './babelfont';

declare module './babelfont' {
    namespace Babelfont {
        /**
         * Extended Component type with custom layerData property
         */
        export interface Component {
            /**
             * Cached layer data for the component reference
             * Used for rendering and intersection calculations
             */
            layerData?: Layer;
        }

        /**
         * Extended Layer type with custom properties
         */
        export interface Layer {
            /**
             * Editor-only linked-layer flag used by scripting and outline-edit workflows.
             * This is runtime state only and is not saved into the font file.
             */
            linked?: boolean;

            /**
             * Legacy master reference (use `master` instead)
             * @deprecated Use `master` property instead
             */
            _master?: string;

            /**
             * Whether this layer is interpolated
             */
            isInterpolated?: boolean;

            /**
             * Vertical advance height for vertical writing
             */
            height?: number;

            /**
             * Vertical advance width for vertical writing
             */
            vertWidth?: number;
        }
    }
}

/**
 * Additional types used in the application
 */

/**
 * Normalized layer data structure for rendering
 */
export interface LayerData {
    width: number;
    shapes: Array<{
        nodes?: Array<{
            x: number;
            y: number;
            nodetype: string;
        }>;
        reference?: string;
        transform?: number[];
        layerData?: LayerData;
    }>;
    anchors?: Array<{
        name: string;
        x: number;
        y: number;
    }>;
    guides?: Array<{
        pos: number;
        angle: number;
    }>;
}

/**
 * Design space location type
 */
export type DesignspaceLocation = Record<string, number>;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
    [key: string]: JsonValue;
}

export type ModelData = Record<string, unknown>;

export type RuntimeNodeData = Babelfont.Node & {
    type?: string;
    nodetype?: string;
    smooth?: boolean;
};

export type RuntimePathData = Omit<Babelfont.Path, 'nodes'> & {
    nodes: RuntimeNodeData[] | string;
};

export type RuntimeComponentData = Babelfont.Component;
export type RuntimeAnchorData = Babelfont.Anchor;
export type RuntimeGuideData = Babelfont.Guide;
export type RuntimeLayerData = Babelfont.Layer;

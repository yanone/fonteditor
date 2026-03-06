// Copyright (C) 2025 Yanone
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

import { OutlineEditor } from './glyph-canvas/outline-editor';
import type { Babelfont } from './babelfont';
import { Logger } from './logger';

const console = new Logger('LayerDataNormalizer');

/**
 * Layer Data Normalizer
 *
 * Transforms layer data from multiple sources (Python layer.to_dict() and
 * babelfont-rs interpolate_glyph JSON) into a unified format for GlyphCanvas rendering.
 *
 * This ensures both editable Python layers and read-only interpolated layers
 * can be displayed using the same rendering code.
 */

export class LayerDataNormalizer {
    /**
     * Normalize layer data from any source
     *
     * @param {Object} layerData - Layer data from either Python or babelfont-rs
     * @param {boolean} isInterpolated - Whether this is interpolated data (optional, defaults to false)
     * @returns {Object} Normalized layer data with isInterpolated flag
     */
    static normalize(layerData: any, isInterpolated: boolean = false) {
        if (!layerData) {
            return null;
        }

        // Both Python and Rust now return identical structure with nested component layerData
        const normalized = {
            width: layerData.width || 0,
            shapes: this.normalizeShapes(
                layerData.shapes || [],
                isInterpolated
            ),
            anchors: this.normalizeAnchors(layerData.anchors || []),
            guides: layerData.guides || [],
            format_specific: layerData.format_specific || {},
            _verticalMetrics: layerData._verticalMetrics || null,
            // Add metadata flag for rendering
            isInterpolated: isInterpolated,
            name: layerData.name || null,
            id: layerData.id || null
        };

        return normalized;
    }

    /**
     * Normalize shapes array (Paths and Components)
     *
     * @param {Array} shapes - Array of shape objects
     * @param {boolean} isInterpolated - Whether this is interpolated data
     * @returns {Array} Normalized shapes array
     */
    static normalizeShapes(shapes: any[], isInterpolated: boolean): any[] {
        return shapes.map((shape, shapeIndex) => {
            if ('nodes' in shape) {
                // Parse nodes if they're a string (from babelfont-rs)
                let parsedNodes = this.parseNodes(shape.nodes);

                // IMPORTANT: For non-interpolated data, replace string with array in place
                // so object model and renderer share the same array reference.
                // This ensures modifications through window.currentFontModel are immediately visible.
                // For interpolated data, always use the freshly parsed nodes.
                if (typeof shape.nodes === 'string') {
                    shape.nodes = parsedNodes;
                }

                return {
                    // Keep original shape properties
                    ...shape,
                    // For rendering: use the parsed nodes (ensures interpolated data uses new array)
                    nodes: parsedNodes,
                    isInterpolated: isInterpolated
                };
            } else if ('reference' in shape) {
                return {
                    reference: shape.reference,
                    transform: shape.transform || [1, 0, 0, 1, 0, 0],
                    format_specific: shape.format_specific || {},
                    // Recursively normalize nested component layer data
                    // Component layerData comes with the same isInterpolated flag as parent
                    layerData: shape.layerData
                        ? this.normalize(shape.layerData, isInterpolated)
                        : null,
                    isInterpolated: isInterpolated
                };
            }
            return shape;
        });
    }

    /**
     * Parse nodes from string or array format using Path class normalization
     *
     * @param {string|Array} nodes - Nodes as string or already-parsed array
     * @returns {Array} Array of normalized node objects
     */
    static parseNodes(nodes: string | any[]): Babelfont.Node[] {
        // If already an array, return as-is
        if (Array.isArray(nodes)) {
            return nodes;
        }

        // For string format, use Path class parseNodesString which handles
        // short codes (c, cs, l, ls, etc.) and normalizes to proper enums
        if (typeof nodes === 'string') {
            // Dynamic require to avoid circular dependency
            const { Path } = require('./babelfont-model');
            return Path.parseNodesString(nodes);
        }

        return [];
    }

    /**
     * Serialize nodes array back to string format
     *
     * @param {Array} nodes - Array of node objects with x, y, type properties
     * @returns {string} Nodes as space-separated string "x1 y1 type x2 y2 type ..."
     */
    static serializeNodes(nodes: Babelfont.Node[]): string {
        if (!Array.isArray(nodes) || nodes.length === 0) {
            return '';
        }

        // Use Path.nodesToString for proper serialization with type mapping
        const { Path } = require('./babelfont-model');
        return Path.nodesToString(nodes);
    }

    /**
     * Normalize anchors array
     *
     * @param {Array} anchors - Array of anchor objects
     * @returns {Array} Normalized anchors array
     */
    static normalizeAnchors(anchors: any[]): any[] {
        return anchors.map((anchor) => ({
            name: anchor.name || '',
            x: anchor.x || 0,
            y: anchor.y || 0,
            format_specific: anchor.format_specific || {}
        }));
    }

    /**
     * Check if layer data is from an exact layer (not interpolated)
     *
     * @param {Object} normalizedData - Normalized layer data
     * @returns {boolean} True if this is an exact layer
     */
    static isExactLayer(normalizedData: any) {
        return normalizedData && !normalizedData.isInterpolated;
    }

    /**
     * Restore exact layer via Rust
     */
    static async restoreExactLayer(outlineEditor: OutlineEditor) {
        await outlineEditor.fetchLayerData();
    }

    /**
     * Get the next node in a circular array
     */
    static getNextNode(
        nodes: Babelfont.Node[],
        currentIndex: number
    ): Babelfont.Node | null {
        if (!nodes || nodes.length === 0) return null;
        const nextIndex = (currentIndex + 1) % nodes.length;
        return nodes[nextIndex];
    }

    /**
     * Get the previous node in a circular array
     */
    static getPrevNode(
        nodes: Babelfont.Node[],
        currentIndex: number
    ): Babelfont.Node | null {
        if (!nodes || nodes.length === 0) return null;
        const prevIndex = (currentIndex - 1 + nodes.length) % nodes.length;
        return nodes[prevIndex];
    }

    /**
     * Build a canvas path from a nodes array.
     * Standalone utility function extracted from Renderer.buildPathFromNodes.
     *
     * @param nodes - Array of Babelfont.Node objects
     * @param target - Canvas context or Path2D to draw to
     * @returns The start index for use in drawing direction arrows, or -1 if empty
     */
    static buildPathFromNodes(
        nodes: Babelfont.Node[],
        target: CanvasRenderingContext2D | Path2D
    ): number {
        if (!nodes || nodes.length === 0) {
            return -1;
        }

        const isOnCurve = (node: Babelfont.Node | undefined): boolean => {
            const type = node?.nodetype;
            return (
                type === 'Move' ||
                type === 'Line' ||
                type === 'Curve' ||
                type === 'QCurve'
            );
        };

        // Prefer explicit Move start if present, otherwise use first on-curve point
        let startIdx = 0;
        for (let i = 0; i < nodes.length; i++) {
            const { nodetype: type } = nodes[i];
            if (type === 'Move') {
                startIdx = i;
                break;
            }
        }
        for (let i = 0; i < nodes.length; i++) {
            const { nodetype: type } = nodes[i];
            if (
                startIdx === 0 &&
                (type === 'Curve' || type === 'QCurve' || type === 'Line')
            ) {
                startIdx = i;
                break;
            }
        }

        if (!isOnCurve(nodes[startIdx])) {
            for (let i = 0; i < nodes.length; i++) {
                if (isOnCurve(nodes[i])) {
                    startIdx = i;
                    break;
                }
            }
        }

        const contour = nodes
            .slice(startIdx)
            .concat(nodes.slice(0, startIdx)) as Babelfont.Node[];
        if (contour.length === 0) {
            return -1;
        }

        const { x: startX, y: startY } = contour[0];
        target.moveTo(startX, startY);

        let currentIndex = 0;
        let guard = 0;
        const guardLimit = contour.length * 4;

        while (guard < guardLimit) {
            guard += 1;

            const current = contour[currentIndex];
            if (!isOnCurve(current)) {
                currentIndex = (currentIndex + 1) % contour.length;
                if (currentIndex === 0) {
                    break;
                }
                continue;
            }

            let nextIndex = (currentIndex + 1) % contour.length;
            const controls: Babelfont.Node[] = [];

            while (nextIndex !== currentIndex) {
                const candidate = contour[nextIndex];
                if (!candidate) {
                    break;
                }
                if (candidate.nodetype === 'OffCurve') {
                    controls.push(candidate);
                    nextIndex = (nextIndex + 1) % contour.length;
                    continue;
                }
                break;
            }

            if (nextIndex === currentIndex) {
                break;
            }

            const end = contour[nextIndex];
            if (!end) {
                break;
            }

            if (controls.length === 0) {
                if (end.nodetype !== 'Move') {
                    target.lineTo(end.x, end.y);
                }
            } else if (controls.length >= 2 && end.nodetype === 'Curve') {
                const c1 = controls[0];
                const c2 = controls[1];
                target.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, end.x, end.y);
            } else {
                for (let i = 0; i < controls.length; i += 1) {
                    const control = controls[i];
                    const isLastControl = i === controls.length - 1;
                    const segmentEnd = isLastControl
                        ? { x: end.x, y: end.y }
                        : {
                              x: (controls[i].x + controls[i + 1].x) / 2,
                              y: (controls[i].y + controls[i + 1].y) / 2
                          };

                    target.quadraticCurveTo(
                        control.x,
                        control.y,
                        segmentEnd.x,
                        segmentEnd.y
                    );
                }
            }

            currentIndex = nextIndex;
            if (currentIndex === 0) {
                break;
            }
        }

        return startIdx;
    }
}

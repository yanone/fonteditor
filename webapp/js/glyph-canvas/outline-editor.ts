import { LayerDataNormalizer } from '../layer-data-normalizer';
import { fontInterpolation } from '../font-interpolation';
import { GlyphCanvas } from '../glyph-canvas';
import fontManager from '../font-manager';
import type { Babelfont } from '../babelfont';
import { Transform } from '../basictypes';
import { Logger } from '../logger';
import {
    Layer,
    DecomposedAffineTransform,
    withSuppressedModelRecording
} from '../babelfont-model';
import {
    getHighestVisibleVerticalMetricValue,
    getLowestVisibleVerticalMetricValue,
    getVisibleVerticalMetricValues
} from './vertical-metrics';
import APP_SETTINGS from '../settings';
import { userspaceToDesignspace, designspaceToUserspace } from '../locations';
import type { DesignspaceLocation, UserspaceLocation } from '../locations';
import { SavedVariationState } from '../saved-variation-state';
import {
    applyLiveSidebearingVisualSync,
    formatSidebearingHistoryValue,
    getSidebearingTransactionLabel,
    type SidebearingSide
} from '../sidebearing-utils';
import { translateLayerContentsX } from '../x-translation-utils';
import { Bezier } from 'bezier-js';
import tippy, { type Instance as TippyInstance } from 'tippy.js';
import {
    addTippyBackdropSupport,
    getOrCreateBackdrop,
    getTheme,
    setupMenuKeyboardNav
} from '../tippy-utils';

let console: Logger = new Logger('OutlineEditor');

type Point = { contourIndex: number; nodeIndex: number };
type SnapCandidate = {
    x: number;
    y: number;
    source: 'active' | 'left' | 'right' | 'origin' | 'metric';
};
type ActiveSnapTarget = {
    /** Source node providing the X snap (null = X not snapped) */
    xSource: SnapCandidate | null;
    /** Source node providing the Y snap (null = Y not snapped) */
    ySource: SnapCandidate | null;
    /** Final snapped X position of the dragged node */
    snappedX: number;
    /** Final snapped Y position of the dragged node */
    snappedY: number;
};
type SnapCandidateCache = {
    /** Active-glyph-only drag candidates (excludes dragged nodes) */
    activeOnlyDragCandidates: SnapCandidate[];
    /** Active + neighbor drag candidates (excludes dragged nodes) */
    allDragCandidates: SnapCandidate[];
    /** Active + neighbor ALL nodes including dragged (for debug overlay) */
    debugCandidates: SnapCandidate[];
    /** Pre-computed snap distance in font units for this drag session */
    snapDistFontUnits: number;
    /** Vertical metric Y values (baseline, x-height, cap-height, etc.) */
    metricsYValues: number[];
};
type GuideHandle = { scope: 'master' | 'layer'; index: number };
type SidebearingHandle = { side: SidebearingSide };
type LayerSelectionState = {
    points: Point[];
    anchors: number[];
    anchorNames: string[];
    components: number[];
    guideHandle: GuideHandle | null;
};
type VisibleGuide = GuideHandle & {
    guide: Babelfont.Guide;
    rootX: number;
    rootY: number;
    rootAngle: number;
};
type VisibleSidebearingHandle = SidebearingHandle & {
    x: number;
    y: number;
    editable: boolean;
};
type EditableContour = {
    nodes: Babelfont.Node[];
    closed: boolean;
};

type PreviewSegment = {
    type: 'line' | 'quadratic' | 'cubic';
    points: Array<{ x: number; y: number }>;
};

type HoveredSegmentPreview = {
    shapeIndex: number;
    pathIndex: number;
    segmentId: number;
    segments: PreviewSegment[];
};

type HoveredAddPointPreview = HoveredSegmentPreview & {
    t: number;
    point: { x: number; y: number };
};

type PathSegmentHit = {
    shapeIndex: number;
    pathIndex: number;
    descriptor: ReturnType<typeof Layer.getPathSegmentDescriptors>[number];
    projection: { x: number; y: number; t: number; distance: number };
};

type PendingCommandPathEdit = {
    didDraw: boolean;
    didConvertLine: boolean;
};

type ActivePathDrawingSession = {
    shapeIndex: number;
    pathIndex: number;
    edge: 'start' | 'end';
    startedFromExistingPath: boolean;
    originNodeIndex: number;
    segmentCount: number;
};

type CanvasPathContextTarget = {
    shapeIndex: number;
    pathIndex: number;
    nodeIndex: number | null;
    onCurveOrdinal: number | null;
    nodeType: Babelfont.NodeType | null;
    intendedPoint: CanvasPoint | null;
    canSetStartNode: boolean;
};

type CanvasPoint = { x: number; y: number };

/**
 * Convert affine matrix [a, b, c, d, e, f] to DecomposedAffine
 */
function affineToDecomposed(affine: number[]): Babelfont.DecomposedAffine {
    return DecomposedAffineTransform.fromAffine(affine);
}

/**
 * Identity transform in DecomposedAffine format
 */
function identityDecomposed(): Babelfont.DecomposedAffine {
    return DecomposedAffineTransform.identity();
}

const getPathShapeData = (shape: any): any => {
    if (
        shape &&
        typeof shape === 'object' &&
        typeof shape.isPath === 'function' &&
        typeof shape.asPath === 'function' &&
        shape.isPath()
    ) {
        return shape.asPath().toJSON();
    }
    if (shape && typeof shape === 'object' && 'Path' in shape) {
        return shape.Path;
    }
    if (shape && typeof shape === 'object' && 'Contour' in shape) {
        return shape.Contour;
    }
    return shape;
};

const getComponentShapeData = (shape: any): any => {
    if (
        shape &&
        typeof shape === 'object' &&
        typeof shape.isComponent === 'function' &&
        typeof shape.asComponent === 'function' &&
        shape.isComponent()
    ) {
        return shape.asComponent().toJSON();
    }
    if (shape && typeof shape === 'object' && 'Component' in shape) {
        return shape.Component;
    }
    return shape;
};

const LAYER_LOCATION_MATCH_EPSILON = 0.01;

function locationsMatchWithinTolerance(
    left: DesignspaceLocation | undefined,
    right: DesignspaceLocation | undefined,
    axisTags: string[]
): boolean {
    if (!left || !right) {
        return false;
    }

    const tags = new Set<string>([
        ...axisTags,
        ...Object.keys(left),
        ...Object.keys(right)
    ]);

    for (const tag of tags) {
        if (
            Math.abs(Number(left[tag] ?? 0) - Number(right[tag] ?? 0)) >
            LAYER_LOCATION_MATCH_EPSILON
        ) {
            return false;
        }
    }

    return true;
}

const parseComponentNodes = (shapes: Babelfont.Shape[]) => {
    if (!shapes) return;

    shapes.forEach((shape) => {
        const pathData = getPathShapeData(shape);
        if (pathData && typeof pathData === 'object' && pathData.nodes) {
            if (typeof pathData.nodes === 'string') {
                pathData.nodes = LayerDataNormalizer.parseNodes(pathData.nodes);
            }
        }

        const componentData = getComponentShapeData(shape);
        if (
            componentData &&
            typeof componentData === 'object' &&
            'reference' in componentData &&
            componentData.layerData &&
            componentData.layerData.shapes
        ) {
            parseComponentNodes(componentData.layerData.shapes);
        }
    });
};

function getEditableContour(
    shape: Babelfont.Shape | undefined
): EditableContour | null {
    const pathData = getPathShapeData(shape);
    if (!pathData || typeof pathData !== 'object' || !('nodes' in pathData)) {
        return null;
    }

    if (!pathData.nodes) {
        return null;
    }

    if (typeof pathData.nodes === 'string') {
        pathData.nodes = LayerDataNormalizer.parseNodes(pathData.nodes);
    }

    return {
        nodes: pathData.nodes as Babelfont.Node[],
        closed: Boolean(pathData.closed)
    };
}

function clampUnitInterval(value: number): number {
    if (!Number.isFinite(value)) {
        return 0;
    }

    return Math.max(0, Math.min(1, value));
}

function lerpPoint(
    start: { x: number; y: number },
    end: { x: number; y: number },
    t: number
): { x: number; y: number } {
    return {
        x: start.x + (end.x - start.x) * t,
        y: start.y + (end.y - start.y) * t
    };
}

function splitPreviewSegment(
    points: Array<{ x: number; y: number }>,
    t: number
): [Array<{ x: number; y: number }>, Array<{ x: number; y: number }>] {
    const normalizedT = clampUnitInterval(t);

    if (points.length === 2) {
        const splitPoint = lerpPoint(points[0], points[1], normalizedT);
        return [
            [points[0], splitPoint],
            [splitPoint, points[1]]
        ];
    }

    const split = new Bezier(points).split(normalizedT);
    return [
        split.left.points.map(({ x, y }: { x: number; y: number }) => ({
            x,
            y
        })),
        split.right.points.map(({ x, y }: { x: number; y: number }) => ({
            x,
            y
        }))
    ];
}

function projectPointOntoLine(
    point: { x: number; y: number },
    start: { x: number; y: number },
    end: { x: number; y: number }
): { x: number; y: number; t: number; distance: number } {
    const deltaX = end.x - start.x;
    const deltaY = end.y - start.y;
    const lengthSquared = deltaX * deltaX + deltaY * deltaY;

    if (!lengthSquared) {
        return {
            x: start.x,
            y: start.y,
            t: 0,
            distance: Math.hypot(point.x - start.x, point.y - start.y)
        };
    }

    const unclampedT =
        ((point.x - start.x) * deltaX + (point.y - start.y) * deltaY) /
        lengthSquared;
    const t = clampUnitInterval(unclampedT);
    const projectedPoint = lerpPoint(start, end, t);

    return {
        x: projectedPoint.x,
        y: projectedPoint.y,
        t,
        distance: Math.hypot(
            point.x - projectedPoint.x,
            point.y - projectedPoint.y
        )
    };
}

function isCurveNode(node: Babelfont.Node | null | undefined): boolean {
    return node?.nodetype === 'Curve' || node?.nodetype === 'QCurve';
}

function isOnCurveNode(node: Babelfont.Node | null | undefined): boolean {
    return Boolean(node) && node?.nodetype !== 'OffCurve';
}

function isOffCurveNode(node: Babelfont.Node | null | undefined): boolean {
    return node?.nodetype === 'OffCurve';
}

function getNeighborNodeIndex(
    nodeIndex: number,
    offset: number,
    numNodes: number,
    closed: boolean
): number | null {
    const targetIndex = nodeIndex + offset;

    if (closed) {
        return ((targetIndex % numNodes) + numNodes) % numNodes;
    }

    if (targetIndex < 0 || targetIndex >= numNodes) {
        return null;
    }

    return targetIndex;
}

function moveNodeByDelta(
    node: Babelfont.Node | null | undefined,
    deltaX: number,
    deltaY: number
): void {
    if (!node) {
        return;
    }

    node.x += deltaX;
    node.y += deltaY;
}

function alignHandleAlongDirection(
    anchor: Babelfont.Node,
    handle: Babelfont.Node,
    directionX: number,
    directionY: number
): void {
    const handleLength = Math.hypot(handle.x - anchor.x, handle.y - anchor.y);
    const directionLength = Math.hypot(directionX, directionY);

    if (!handleLength || !directionLength) {
        return;
    }

    handle.x = anchor.x + (directionX / directionLength) * handleLength;
    handle.y = anchor.y + (directionY / directionLength) * handleLength;
}

function projectDeltaOntoDirection(
    deltaX: number,
    deltaY: number,
    directionX: number,
    directionY: number
): { deltaX: number; deltaY: number } {
    const directionLengthSquared =
        directionX * directionX + directionY * directionY;

    if (!directionLengthSquared) {
        return { deltaX: 0, deltaY: 0 };
    }

    const scale =
        (deltaX * directionX + deltaY * directionY) / directionLengthSquared;
    return {
        deltaX: directionX * scale,
        deltaY: directionY * scale
    };
}

function getSmoothAnchorConstraintDirection(
    contour: EditableContour,
    nodeIndex: number
): { directionX: number; directionY: number } | null {
    const node = contour.nodes[nodeIndex];
    if (!node || !isOnCurveNode(node) || !node.smooth) {
        return null;
    }

    const prevIndex = getNeighborNodeIndex(
        nodeIndex,
        -1,
        contour.nodes.length,
        contour.closed
    );
    const nextIndex = getNeighborNodeIndex(
        nodeIndex,
        1,
        contour.nodes.length,
        contour.closed
    );

    if (prevIndex === null || nextIndex === null) {
        return null;
    }

    const prevNode = contour.nodes[prevIndex];
    const nextNode = contour.nodes[nextIndex];
    const prevIsHandle = isOffCurveNode(prevNode);
    const nextIsHandle = isOffCurveNode(nextNode);

    if (prevIsHandle && nextIsHandle) {
        return {
            directionX: nextNode.x - prevNode.x,
            directionY: nextNode.y - prevNode.y
        };
    }

    if (prevIsHandle && !nextIsHandle) {
        return {
            directionX: nextNode.x - prevNode.x,
            directionY: nextNode.y - prevNode.y
        };
    }

    if (!prevIsHandle && nextIsHandle) {
        return {
            directionX: nextNode.x - prevNode.x,
            directionY: nextNode.y - prevNode.y
        };
    }

    return null;
}

function getAltAnchorMoveDelta(
    contour: EditableContour,
    nodeIndex: number,
    deltaX: number,
    deltaY: number
): { deltaX: number; deltaY: number } {
    const constraintDirection = getSmoothAnchorConstraintDirection(
        contour,
        nodeIndex
    );

    if (!constraintDirection) {
        return { deltaX, deltaY };
    }

    return projectDeltaOntoDirection(
        deltaX,
        deltaY,
        constraintDirection.directionX,
        constraintDirection.directionY
    );
}

function realignSmoothHandles(
    contour: EditableContour,
    anchorIndex: number
): boolean {
    const anchor = contour.nodes[anchorIndex];
    if (!anchor || !isOnCurveNode(anchor) || !anchor.smooth) {
        return false;
    }

    const prevIndex = getNeighborNodeIndex(
        anchorIndex,
        -1,
        contour.nodes.length,
        contour.closed
    );
    const nextIndex = getNeighborNodeIndex(
        anchorIndex,
        1,
        contour.nodes.length,
        contour.closed
    );

    const prevHandleIndex =
        prevIndex !== null && isOffCurveNode(contour.nodes[prevIndex])
            ? prevIndex
            : null;
    const nextHandleIndex =
        nextIndex !== null && isOffCurveNode(contour.nodes[nextIndex])
            ? nextIndex
            : null;

    if (prevHandleIndex === null && nextHandleIndex === null) {
        return false;
    }

    if (prevHandleIndex !== null && nextHandleIndex !== null) {
        const prevHandle = contour.nodes[prevHandleIndex];
        const nextHandle = contour.nodes[nextHandleIndex];
        const handleVectorInX = anchor.x - prevHandle.x;
        const handleVectorInY = anchor.y - prevHandle.y;
        const handleVectorOutX = anchor.x - nextHandle.x;
        const handleVectorOutY = anchor.y - nextHandle.y;

        alignHandleAlongDirection(
            anchor,
            prevHandle,
            handleVectorOutX - handleVectorInX,
            handleVectorOutY - handleVectorInY
        );
        alignHandleAlongDirection(
            anchor,
            nextHandle,
            handleVectorInX - handleVectorOutX,
            handleVectorInY - handleVectorOutY
        );
        return true;
    }

    if (prevHandleIndex !== null && nextIndex !== null) {
        const prevHandle = contour.nodes[prevHandleIndex];
        const nextReference = contour.nodes[nextIndex];
        alignHandleAlongDirection(
            anchor,
            prevHandle,
            anchor.x - nextReference.x,
            anchor.y - nextReference.y
        );
        return true;
    }

    if (nextHandleIndex !== null && prevIndex !== null) {
        const nextHandle = contour.nodes[nextHandleIndex];
        const prevReference = contour.nodes[prevIndex];
        alignHandleAlongDirection(
            anchor,
            nextHandle,
            anchor.x - prevReference.x,
            anchor.y - prevReference.y
        );
        return true;
    }

    return false;
}

function transformPoint(
    x: number,
    y: number,
    transform: Transform
): { x: number; y: number } {
    return {
        x: transform[0] * x + transform[2] * y + transform[4],
        y: transform[1] * x + transform[3] * y + transform[5]
    };
}

function getAxisAlignedHandleDirection(
    anchor: Babelfont.Node,
    handle: Babelfont.Node
): { directionX: number; directionY: number } | null {
    const deltaX = handle.x - anchor.x;
    const deltaY = handle.y - anchor.y;

    if (deltaX !== 0 && deltaY === 0) {
        return { directionX: deltaX < 0 ? -1 : 1, directionY: 0 };
    }

    if (deltaY !== 0 && deltaX === 0) {
        return { directionX: 0, directionY: deltaY < 0 ? -1 : 1 };
    }

    return null;
}

function realignSmoothHandlesForToggle(
    contour: EditableContour,
    anchorIndex: number
): boolean {
    const anchor = contour.nodes[anchorIndex];
    if (!anchor || !isOnCurveNode(anchor) || !anchor.smooth) {
        return false;
    }

    const prevIndex = getNeighborNodeIndex(
        anchorIndex,
        -1,
        contour.nodes.length,
        contour.closed
    );
    const nextIndex = getNeighborNodeIndex(
        anchorIndex,
        1,
        contour.nodes.length,
        contour.closed
    );

    const prevHandleIndex =
        prevIndex !== null && isOffCurveNode(contour.nodes[prevIndex])
            ? prevIndex
            : null;
    const nextHandleIndex =
        nextIndex !== null && isOffCurveNode(contour.nodes[nextIndex])
            ? nextIndex
            : null;

    if (prevHandleIndex !== null && nextHandleIndex !== null) {
        const prevHandle = contour.nodes[prevHandleIndex];
        const nextHandle = contour.nodes[nextHandleIndex];
        const prevAxisDirection = getAxisAlignedHandleDirection(
            anchor,
            prevHandle
        );
        if (prevAxisDirection) {
            alignHandleAlongDirection(
                anchor,
                nextHandle,
                -prevAxisDirection.directionX,
                -prevAxisDirection.directionY
            );
            return true;
        }

        const nextAxisDirection = getAxisAlignedHandleDirection(
            anchor,
            nextHandle
        );
        if (nextAxisDirection) {
            alignHandleAlongDirection(
                anchor,
                prevHandle,
                -nextAxisDirection.directionX,
                -nextAxisDirection.directionY
            );
            return true;
        }
    }

    return realignSmoothHandles(contour, anchorIndex);
}

function realignOppositeSmoothHandle(
    contour: EditableContour,
    offcurveIndex: number
): boolean {
    const offcurve = contour.nodes[offcurveIndex];
    if (!isOffCurveNode(offcurve)) {
        return false;
    }

    const nextIndex = getNeighborNodeIndex(
        offcurveIndex,
        1,
        contour.nodes.length,
        contour.closed
    );
    if (nextIndex !== null) {
        const nextNode = contour.nodes[nextIndex];
        if (isOnCurveNode(nextNode) && nextNode.smooth) {
            const otherHandleIndex = getNeighborNodeIndex(
                nextIndex,
                1,
                contour.nodes.length,
                contour.closed
            );
            if (
                otherHandleIndex !== null &&
                otherHandleIndex !== offcurveIndex &&
                isOffCurveNode(contour.nodes[otherHandleIndex])
            ) {
                alignHandleAlongDirection(
                    nextNode,
                    contour.nodes[otherHandleIndex],
                    nextNode.x - offcurve.x,
                    nextNode.y - offcurve.y
                );
                return true;
            }

            const oppositeLineIndex = getNeighborNodeIndex(
                nextIndex,
                1,
                contour.nodes.length,
                contour.closed
            );
            if (
                oppositeLineIndex !== null &&
                oppositeLineIndex !== offcurveIndex &&
                !isOffCurveNode(contour.nodes[oppositeLineIndex])
            ) {
                alignHandleAlongDirection(
                    nextNode,
                    offcurve,
                    nextNode.x - contour.nodes[oppositeLineIndex].x,
                    nextNode.y - contour.nodes[oppositeLineIndex].y
                );
                return true;
            }
        }
    }

    const prevIndex = getNeighborNodeIndex(
        offcurveIndex,
        -1,
        contour.nodes.length,
        contour.closed
    );
    if (prevIndex !== null) {
        const prevNode = contour.nodes[prevIndex];
        if (isOnCurveNode(prevNode) && prevNode.smooth) {
            const otherHandleIndex = getNeighborNodeIndex(
                prevIndex,
                -1,
                contour.nodes.length,
                contour.closed
            );
            if (
                otherHandleIndex !== null &&
                otherHandleIndex !== offcurveIndex &&
                isOffCurveNode(contour.nodes[otherHandleIndex])
            ) {
                alignHandleAlongDirection(
                    prevNode,
                    contour.nodes[otherHandleIndex],
                    prevNode.x - offcurve.x,
                    prevNode.y - offcurve.y
                );
                return true;
            }

            const oppositeLineIndex = getNeighborNodeIndex(
                prevIndex,
                -1,
                contour.nodes.length,
                contour.closed
            );
            if (
                oppositeLineIndex !== null &&
                oppositeLineIndex !== offcurveIndex &&
                !isOffCurveNode(contour.nodes[oppositeLineIndex])
            ) {
                alignHandleAlongDirection(
                    prevNode,
                    offcurve,
                    prevNode.x - contour.nodes[oppositeLineIndex].x,
                    prevNode.y - contour.nodes[oppositeLineIndex].y
                );
                return true;
            }
        }
    }

    return false;
}

function snapSmoothHandleTripletToAxis(
    contour: EditableContour,
    offcurveIndex: number,
    pointerX: number,
    pointerY: number
): boolean {
    const offcurve = contour.nodes[offcurveIndex];
    if (!isOffCurveNode(offcurve)) {
        return false;
    }

    const nextIndex = getNeighborNodeIndex(
        offcurveIndex,
        1,
        contour.nodes.length,
        contour.closed
    );
    if (nextIndex !== null) {
        const nextNode = contour.nodes[nextIndex];
        if (isCurveNode(nextNode) && nextNode.smooth) {
            const otherHandleIndex = getNeighborNodeIndex(
                nextIndex,
                1,
                contour.nodes.length,
                contour.closed
            );
            if (
                otherHandleIndex !== null &&
                otherHandleIndex !== offcurveIndex &&
                isOffCurveNode(contour.nodes[otherHandleIndex])
            ) {
                return snapSmoothHandlePairToAxis(
                    nextNode,
                    offcurve,
                    contour.nodes[otherHandleIndex],
                    pointerX,
                    pointerY
                );
            }
        }
    }

    const prevIndex = getNeighborNodeIndex(
        offcurveIndex,
        -1,
        contour.nodes.length,
        contour.closed
    );
    if (prevIndex !== null) {
        const prevNode = contour.nodes[prevIndex];
        if (isCurveNode(prevNode) && prevNode.smooth) {
            const otherHandleIndex = getNeighborNodeIndex(
                prevIndex,
                -1,
                contour.nodes.length,
                contour.closed
            );
            if (
                otherHandleIndex !== null &&
                otherHandleIndex !== offcurveIndex &&
                isOffCurveNode(contour.nodes[otherHandleIndex])
            ) {
                return snapSmoothHandlePairToAxis(
                    prevNode,
                    offcurve,
                    contour.nodes[otherHandleIndex],
                    pointerX,
                    pointerY
                );
            }
        }
    }

    return false;
}

function snapSmoothHandlePairToAxis(
    anchor: Babelfont.Node,
    draggedHandle: Babelfont.Node,
    oppositeHandle: Babelfont.Node,
    pointerX: number,
    pointerY: number
): boolean {
    const deltaX = pointerX - anchor.x;
    const deltaY = pointerY - anchor.y;

    if (deltaX === 0 && deltaY === 0) {
        return false;
    }

    const horizontal = Math.abs(deltaX) >= Math.abs(deltaY);
    if (horizontal) {
        draggedHandle.x = pointerX;
        draggedHandle.y = anchor.y;
        alignHandleAlongDirection(
            anchor,
            oppositeHandle,
            deltaX < 0 ? 1 : -1,
            0
        );
        return true;
    }

    draggedHandle.x = anchor.x;
    draggedHandle.y = pointerY;
    alignHandleAlongDirection(anchor, oppositeHandle, 0, deltaY < 0 ? 1 : -1);
    return true;
}

export class OutlineEditor {
    active: boolean = false;
    isPreviewMode: boolean = false;
    previewModeBeforeSlider: boolean = false;
    spaceKeyPressed: boolean = false;
    cursorStyleBeforePreview: string | null = null;
    isDraggingPoint: boolean = false;
    isSlidingSmoothPointAlongCurve: boolean = false;
    /** Set when a remote change arrives during an active drag. After the drag ends, a full Rust cache + canvas refresh is triggered. */
    pendingRemoteRefreshAfterDrag: boolean = false;
    isSnappedToCloseOpenPath: boolean = false;
    private _dragStartEndpointsCoincident: boolean = false;

    /** Active snap target during a point drag – includes the snapped point and the source node it snapped from. */
    activeSnapTarget: ActiveSnapTarget | null = null;
    /** Natural (unsnapped) position the dragged primary node would be at this frame. Used for snap highlight rendering. */
    snapDraggedNaturalPos: { x: number; y: number } | null = null;
    private _snapDragStartMouseX: number | null = null;
    private _snapDragStartMouseY: number | null = null;
    private _snapDragStartNodePos: { x: number; y: number } | null = null;
    /** The node's actual position at the moment dragging began. Used by the renderer to draw origin guides. */
    get snapDragStartNodePos(): { x: number; y: number } | null {
        return this._snapDragStartNodePos;
    }
    private _snapCandidateCache: SnapCandidateCache | null = null;
    private _lastDragSaveTime: number = 0;
    private _lastPropertyPanelUpdateTime: number = 0;
    private _pendingDragMetricsUpdate: boolean = false;
    private _pointDragDeltaX: number = 0;
    private _componentDragDeltaX: number = 0;
    private _pointDragPreserveHandlePositions: boolean = false;
    isDraggingComponent: boolean = false;
    isDraggingAnchor: boolean = false;
    isDraggingSidebearing: boolean = false;
    isDraggingGuide: boolean = false;
    isMarqueeSelecting: boolean = false;
    _hasMoved: boolean = false;
    _preDragDesc: string | null = null;
    _metricsKeyEditedSide: SidebearingSide | null = null;
    _metricsKeyInteractionSide: SidebearingSide | null = null;
    _dragType:
        | 'anchor'
        | 'point'
        | 'slide-point'
        | 'component'
        | 'sidebearing'
        | 'guide'
        | null = null;
    currentGlyphName: string | null = null;
    glyphCanvas: GlyphCanvas;
    guidelinesVisible: boolean;

    selectedAnchors: number[] = [];
    selectedPoints: Point[] = [];
    selectedComponents: number[] = [];
    selectedSidebearingHandle: SidebearingHandle | null = null;
    selectedGuideHandle: GuideHandle | null = null;
    hoveredPointIndex: Point | null = null;
    hoveredAnchorIndex: number | null = null;
    hoveredComponentIndex: number | null = null;
    hoveredSidebearingHandle: SidebearingHandle | null = null;
    hoveredGuideHandle: GuideHandle | null = null;
    hoveredGlyphIndex: number = -1;
    hoveredAddPointPreview: HoveredAddPointPreview | null = null;
    hoveredCommandCurvePreview: HoveredSegmentPreview | null = null;
    selectedPointIndex: any = null;

    layerDataDirty: boolean = false;
    escapeState: SavedVariationState = new SavedVariationState();
    braceLayerNeighborAboveMasterId: string | null = null;
    braceLayerNeighborBelowMasterId: string | null = null;
    layerData: Babelfont.Layer | null = null;
    renderVerticalMetrics: Record<string, number> | null = null;
    targetLayerData: Babelfont.Layer | null = null;
    selectedLayerId: string | null = null;
    isInterpolating: boolean = false;
    isLayerSwitchAnimating: boolean = false;
    currentInterpolationId: number = 0;
    isDeterministicRefreshActive: boolean = false;
    lastGlyphX: number | null = null;
    lastGlyphY: number | null = null;
    lastPointDragShiftKey: boolean | null = null;
    altKeyPressed: boolean = false;
    cmdKeyPressed: boolean = false;
    canvas: HTMLCanvasElement | null = null;

    autoPanAnchorScreen: { x: number; y: number } | null = null;
    autoPanEnabled: boolean = true;
    glyphStack: string = '';
    marqueeSelectionStart: { glyphX: number; glyphY: number } | null = null;
    marqueeSelectionCurrent: { glyphX: number; glyphY: number } | null = null;
    marqueeToggleMode: boolean = false;
    marqueeInitialPoints: Point[] = [];
    private layerSelectionStateByKey = new Map<string, LayerSelectionState>();
    private unlinkedLayerIdsByGlyphName = new Map<string, Set<string>>();
    private pendingGlyphSwitchSourceLayerKey: string | null = null;
    private pendingGlyphSwitchSourceLayer: any | null = null;
    private activePathDrawingSession: ActivePathDrawingSession | null = null;
    private pendingCommandPathEdit: PendingCommandPathEdit | null = null;
    private canvasContextMenuTippy: TippyInstance | null = null;
    private canvasContextMenuTarget: CanvasPathContextTarget | null = null;

    private readonly GUIDELINES_STORAGE_KEY = 'outlineEditorGuidelinesVisible';

    private readonly CANVAS_CONTEXT_MENU_BACKDROP_CLASS =
        'canvas-context-menu-backdrop';

    constructor(glyphCanvas: GlyphCanvas) {
        this.glyphCanvas = glyphCanvas;
        this.guidelinesVisible = this.loadGuidelinesVisible();
    }

    getLayerLinkGlyphName(glyphName: string | null = null): string | null {
        const parsed = this.parseGlyphStack();
        const stackGlyphName = parsed.length
            ? parsed[parsed.length - 1].glyphName
            : null;

        const resolvedName =
            glyphName ||
            stackGlyphName ||
            this.currentGlyphName ||
            this.glyphCanvas.getCurrentGlyphName();

        if (!resolvedName || resolvedName === 'undefined') {
            return null;
        }

        return resolvedName;
    }

    private resolveLayerLinkGlyphName(
        glyphName: string | null = null
    ): string | null {
        return this.getLayerLinkGlyphName(glyphName);
    }

    isLayerLinked(
        layerId: string | null | undefined,
        glyphName: string | null = null
    ): boolean {
        if (!layerId) {
            return true;
        }

        const resolvedGlyphName = this.resolveLayerLinkGlyphName(glyphName);
        if (!resolvedGlyphName) {
            return true;
        }

        return !this.unlinkedLayerIdsByGlyphName
            .get(resolvedGlyphName)
            ?.has(layerId);
    }

    getUnlinkedLayerIdsForGlyph(glyphName: string | null = null): Set<string> {
        const resolvedGlyphName = this.resolveLayerLinkGlyphName(glyphName);
        if (!resolvedGlyphName) {
            return new Set<string>();
        }

        return new Set(
            this.unlinkedLayerIdsByGlyphName.get(resolvedGlyphName) || []
        );
    }

    areAllLayersLinked(
        layerIds: string[],
        glyphName: string | null = null
    ): boolean {
        return layerIds.every((layerId) =>
            this.isLayerLinked(layerId, glyphName)
        );
    }

    setLayerLinked(
        layerId: string | null | undefined,
        linked: boolean,
        glyphName: string | null = null
    ): void {
        if (!layerId) {
            return;
        }

        const resolvedGlyphName = this.resolveLayerLinkGlyphName(glyphName);
        if (!resolvedGlyphName) {
            return;
        }

        const unlinkedLayerIds = new Set(
            this.unlinkedLayerIdsByGlyphName.get(resolvedGlyphName) || []
        );

        if (linked) {
            unlinkedLayerIds.delete(layerId);
        } else {
            unlinkedLayerIds.add(layerId);
        }

        if (unlinkedLayerIds.size === 0) {
            this.unlinkedLayerIdsByGlyphName.delete(resolvedGlyphName);
            return;
        }

        this.unlinkedLayerIdsByGlyphName.set(
            resolvedGlyphName,
            unlinkedLayerIds
        );
    }

    setAllLayersLinked(
        layerIds: string[],
        linked: boolean,
        glyphName: string | null = null
    ): void {
        const resolvedGlyphName = this.resolveLayerLinkGlyphName(glyphName);
        if (!resolvedGlyphName) {
            return;
        }

        const uniqueLayerIds = Array.from(
            new Set(layerIds.filter((layerId): layerId is string => !!layerId))
        );

        if (uniqueLayerIds.length === 0) {
            return;
        }

        if (linked) {
            const unlinkedLayerIds = new Set(
                this.unlinkedLayerIdsByGlyphName.get(resolvedGlyphName) || []
            );

            uniqueLayerIds.forEach((layerId) =>
                unlinkedLayerIds.delete(layerId)
            );

            if (unlinkedLayerIds.size === 0) {
                this.unlinkedLayerIdsByGlyphName.delete(resolvedGlyphName);
                return;
            }

            this.unlinkedLayerIdsByGlyphName.set(
                resolvedGlyphName,
                unlinkedLayerIds
            );
            return;
        }

        const unlinkedLayerIds = new Set(
            this.unlinkedLayerIdsByGlyphName.get(resolvedGlyphName) || []
        );

        uniqueLayerIds.forEach((layerId) => unlinkedLayerIds.add(layerId));

        this.unlinkedLayerIdsByGlyphName.set(
            resolvedGlyphName,
            unlinkedLayerIds
        );
    }

    private loadGuidelinesVisible(): boolean {
        try {
            return (
                localStorage.getItem(this.GUIDELINES_STORAGE_KEY) !== 'false'
            );
        } catch (_error) {
            return true;
        }
    }

    setGuidelinesVisible(visible: boolean): void {
        this.guidelinesVisible = visible;

        if (!visible) {
            this.isDraggingGuide = false;
            this.selectedGuideHandle = null;
            this.hoveredGuideHandle = null;
        }

        try {
            localStorage.setItem(
                this.GUIDELINES_STORAGE_KEY,
                visible ? 'true' : 'false'
            );
        } catch (_error) {
            // Ignore localStorage access failures.
        }

        window.dispatchEvent(
            new CustomEvent('outlineGuidelinesVisibilityChanged', {
                detail: { visible }
            })
        );

        this.glyphCanvas.render();
    }

    toggleGuidelinesVisible(): boolean {
        const nextVisible = !this.guidelinesVisible;
        this.setGuidelinesVisible(nextVisible);
        return nextVisible;
    }

    private getGlyphModelByName(glyphName: string | null): any | null {
        const fontModel = fontManager.currentFont?.fontModel;
        if (!fontModel || !glyphName) {
            return null;
        }

        return fontModel.glyphs.find((glyph: any) => glyph.name === glyphName);
    }

    private getRootGlyphModel(): any | null {
        const parsed = this.parseGlyphStack();
        const glyphName =
            parsed[0]?.glyphName ?? this.glyphCanvas.getCurrentGlyphName();
        return this.getGlyphModelByName(glyphName);
    }

    private getCurrentGlyphModel(): any | null {
        const parsed = this.parseGlyphStack();
        const glyphName =
            parsed.length > 0
                ? parsed[parsed.length - 1].glyphName
                : this.glyphCanvas.getCurrentGlyphName();
        return this.getGlyphModelByName(glyphName);
    }

    private getRootLayerId(): string | null {
        const parsed = this.parseGlyphStack();
        return parsed[0]?.layerId ?? this.selectedLayerId;
    }

    private getCurrentLayerId(): string | null {
        const parsed = this.parseGlyphStack();
        return parsed[parsed.length - 1]?.layerId ?? this.selectedLayerId;
    }

    private getRootLayerModel(): any | null {
        const layerId = this.getRootLayerId();
        if (!layerId) {
            return null;
        }

        const glyph = this.getRootGlyphModel();
        if (!glyph) {
            return null;
        }

        return glyph.findLayerById?.(layerId) || null;
    }

    private getCurrentLayerModel(): any | null {
        const layerId = this.getCurrentLayerId();
        if (!layerId) {
            return null;
        }

        const glyph = this.getCurrentGlyphModel();
        if (!glyph) {
            return null;
        }

        return glyph.findLayerById?.(layerId) || null;
    }

    private hasActiveMetricsKey(side: SidebearingSide): boolean {
        const resolution =
            this.getCurrentLayerModel()?.resolveMetricsKey?.(side);
        return !!resolution?.input && !resolution?.error;
    }

    private updatePointDragDeltaX(deltaX: number): void {
        if (
            !this.isDraggingPoint ||
            this.isSlidingSmoothPointAlongCurve ||
            !Number.isFinite(deltaX)
        ) {
            return;
        }

        if (Math.abs(deltaX) <= 0.01) {
            return;
        }

        this._pointDragDeltaX += deltaX;
    }

    private updateComponentDragDeltaX(deltaX: number): void {
        if (!this.isDraggingComponent || !Number.isFinite(deltaX)) {
            return;
        }
        if (Math.abs(deltaX) <= 0.01) {
            return;
        }
        this._componentDragDeltaX += deltaX;
    }

    private getSelectionScopeLayerModel(layerId: string | null): any | null {
        if (!layerId) {
            return null;
        }

        const glyph = this.getCurrentGlyphModel();
        if (!glyph) {
            return null;
        }

        return glyph.findLayerById?.(layerId) || null;
    }

    private getTransitionPreviousLayerModel(
        nextRootGlyphName: string
    ): any | null {
        if (this.pendingGlyphSwitchSourceLayer) {
            return this.pendingGlyphSwitchSourceLayer;
        }

        if (!this.selectedLayerId) {
            return null;
        }

        const parsed = this.parseGlyphStack();
        const previousRootGlyphName =
            parsed[0]?.glyphName ||
            (this.currentGlyphName &&
            this.currentGlyphName !== nextRootGlyphName
                ? this.currentGlyphName
                : nextRootGlyphName);
        const previousGlyph = this.getGlyphModelByName(previousRootGlyphName);

        return previousGlyph?.findLayerById?.(this.selectedLayerId) || null;
    }

    prepareForGlyphSwitch(nextRootGlyphName: string): void {
        const previousLayer =
            this.getTransitionPreviousLayerModel(nextRootGlyphName);

        if (previousLayer) {
            this.storeSelectionStateForLayer(previousLayer);
            this.pendingGlyphSwitchSourceLayerKey =
                this.getLayerSelectionStorageKey(previousLayer);
            this.pendingGlyphSwitchSourceLayer = previousLayer;
        } else {
            this.pendingGlyphSwitchSourceLayerKey = null;
            this.pendingGlyphSwitchSourceLayer = null;
        }

        this.clearAllSelections();
    }

    private collectLiveAdvanceWidths(
        glyphNames: Iterable<string>,
        layerId: string,
        masterId: string | null
    ): Record<string, number> {
        const fontModel = fontManager.currentFont?.fontModel;
        if (!fontModel) {
            return {};
        }

        const glyphAdvances: Record<string, number> = {};
        for (const glyphName of glyphNames) {
            if (!glyphName || glyphName in glyphAdvances) {
                continue;
            }

            const glyph = fontModel.findGlyph(glyphName);
            const layer =
                glyph?.findLayerById(layerId) ||
                (masterId ? glyph?.findLayerByMasterId(masterId) : undefined);
            if (!layer || !Number.isFinite(layer.width)) {
                continue;
            }

            glyphAdvances[glyphName] = layer.width;
        }

        return glyphAdvances;
    }

    private recomputeMetricsKeysForGlyph(
        glyphName: string | null | undefined
    ): Set<string> {
        const fontModel = fontManager.currentFont?.fontModel;
        if (!glyphName || glyphName === 'undefined' || !fontModel) {
            return new Set();
        }

        const affectedGlyphNames = new Set<string>([glyphName]);
        const recompute = () => {
            for (const recomputedGlyphName of fontModel.recomputeMetricsKeys(
                new Set([glyphName])
            )) {
                affectedGlyphNames.add(recomputedGlyphName);
            }
        };

        const bridge = window.changeBridge;
        if (bridge?.runWithoutRecording) {
            bridge.runWithoutRecording(recompute);
        } else {
            recompute();
        }

        return affectedGlyphNames;
    }

    private applyMetricsKeysToCurrentEditedLayer(
        refreshGlyphAdvances: boolean = true
    ): {
        glyphName: string;
        nextWidth: number;
        glyphAdvances: Record<string, number>;
        advancesRefreshed: boolean;
    } | null {
        const currentLayerData = this.getCurrentLayerDataFromStack();
        const currentLayerId = this.getCurrentLayerId();
        if (
            !currentLayerData ||
            currentLayerData.isInterpolated ||
            !currentLayerId
        ) {
            return null;
        }

        const parsed = this.parseGlyphStack();
        const glyphName =
            parsed.length > 0
                ? parsed[parsed.length - 1].glyphName
                : this.glyphCanvas.getCurrentGlyphName();
        const fontModel = fontManager.currentFont?.fontModel;
        if (!glyphName || !fontModel) {
            return null;
        }

        const glyph = fontModel.findGlyph(glyphName);
        const layerModel = glyph?.findLayerById(currentLayerId);
        const rawLayer = layerModel?.toJSON?.();
        if (!glyph || !layerModel || !rawLayer) {
            return null;
        }

        const bboxCenterAnchorScreen = refreshGlyphAdvances
            ? this.getBoundingBoxCenterScreenPosition()
            : null;
        const previousWidth = Number(currentLayerData.width) || 0;
        const previousSidebearings =
            this.getDirectSidebearingsForLayerData(currentLayerData);

        rawLayer.width = currentLayerData.width;
        rawLayer.height = currentLayerData.height;
        rawLayer.vertWidth = currentLayerData.vertWidth;
        rawLayer.shapes = currentLayerData.shapes;

        if (currentLayerData.anchors !== undefined) {
            rawLayer.anchors = currentLayerData.anchors;
        }
        if (currentLayerData.guides !== undefined) {
            rawLayer.guides = currentLayerData.guides;
        }
        if (currentLayerData.format_specific !== undefined) {
            rawLayer.format_specific = currentLayerData.format_specific;
        }

        // Force shape wrapper rebuild so setDirectSidebearing operates
        // on the current editing shapes (not stale cached wrappers).
        layerModel.invalidateShapeCache();

        const affectedGlyphNames = new Set<string>([glyphName]);
        for (const affectedGlyphName of this.recomputeMetricsKeysForGlyph(
            glyphName
        )) {
            affectedGlyphNames.add(affectedGlyphName);
        }

        currentLayerData.width = rawLayer.width;
        currentLayerData.height = rawLayer.height;
        currentLayerData.vertWidth = rawLayer.vertWidth;
        currentLayerData.shapes = rawLayer.shapes;
        if (rawLayer.anchors !== undefined) {
            currentLayerData.anchors = rawLayer.anchors;
        }
        if (rawLayer.guides !== undefined) {
            currentLayerData.guides = rawLayer.guides;
        }

        const nextSidebearings =
            this.getDirectSidebearingsForLayerData(currentLayerData);
        const editedSide = this.inferEditedSideFromSidebearingDelta(
            previousSidebearings,
            nextSidebearings
        );

        this._metricsKeyEditedSide = editedSide;
        if (editedSide) {
            this._metricsKeyInteractionSide = editedSide;
        }

        const nextWidth = Number(currentLayerData.width) || 0;
        const widthDelta = nextWidth - previousWidth;

        if (editedSide === 'left') {
            if (Math.abs(widthDelta) > 0.01) {
                this._shiftSnapCandidateCacheX(widthDelta);
            }
        } else if (editedSide === 'right') {
            if (Math.abs(widthDelta) > 0.01) {
                // Right-neighbor candidates move because the active glyph's
                // advance changes, shifting the right neighbor's world position.
                this._shiftSnapCandidateCacheX(widthDelta, 'right');
            }
        }

        const masterId =
            typeof rawLayer.master === 'object' && rawLayer.master
                ? rawLayer.master.master || null
                : null;
        const glyphAdvances = this.collectLiveAdvanceWidths(
            affectedGlyphNames,
            currentLayerId,
            masterId
        );
        const adjacentSnapCandidateWidthDeltas =
            this._getAdjacentSnapCandidateWidthDeltas(glyphAdvances);

        const advancesRefreshed =
            refreshGlyphAdvances &&
            Object.keys(glyphAdvances).length > 0 &&
            !!this.glyphCanvas.textRunEditor?.refreshGlyphAdvancesLive(
                glyphAdvances,
                { render: false }
            );

        if (bboxCenterAnchorScreen) {
            this.applyBoundingBoxCenterScreenAnchor(bboxCenterAnchorScreen);
        }

        if (editedSide === 'left') {
            const rightNeighborWidthDelta =
                adjacentSnapCandidateWidthDeltas.right;
            if (rightNeighborWidthDelta !== undefined) {
                this._shiftSnapCandidateCacheX(
                    rightNeighborWidthDelta,
                    'right'
                );
            }
        } else if (editedSide === 'right') {
            const leftNeighborWidthDelta =
                adjacentSnapCandidateWidthDeltas.left;
            if (leftNeighborWidthDelta !== undefined) {
                this._shiftSnapCandidateCacheX(-leftNeighborWidthDelta, 'left');
            }
        }

        return {
            glyphName,
            nextWidth: currentLayerData.width || 0,
            glyphAdvances,
            advancesRefreshed
        };
    }

    private getBoundingBoxCenterScreenPosition(): {
        x: number;
        y: number;
    } | null {
        const currentLayerData = this.getCurrentLayerDataFromStack();
        const bbox = currentLayerData
            ? Layer.calculateBoundingBox(currentLayerData, true)
            : null;
        if (!bbox) {
            return null;
        }

        if (
            !this.glyphCanvas.viewportManager ||
            !this.glyphCanvas.textRunEditor ||
            this.glyphCanvas.textRunEditor.selectedGlyphIndex < 0
        ) {
            return null;
        }

        const glyphPosition = this.glyphCanvas.textRunEditor._getGlyphPosition(
            this.glyphCanvas.textRunEditor.selectedGlyphIndex
        );

        let localCenterX = bbox.minX + bbox.width / 2;
        let localCenterY = bbox.minY + bbox.height / 2;

        if (this.isEditingComponent()) {
            const transform = this.getAccumulatedTransform();
            const [a, b, c, d, tx, ty] = transform;
            const transformedX = a * localCenterX + c * localCenterY + tx;
            const transformedY = b * localCenterX + d * localCenterY + ty;
            localCenterX = transformedX;
            localCenterY = transformedY;
        }

        const worldCenterX =
            glyphPosition.xPosition + glyphPosition.xOffset + localCenterX;
        const worldCenterY = glyphPosition.yOffset + localCenterY;

        return this.glyphCanvas.viewportManager.fontToScreenCoordinates(
            worldCenterX,
            worldCenterY
        );
    }

    private applyBoundingBoxCenterScreenAnchor(
        anchorScreen: {
            x: number;
            y: number;
        } | null
    ): void {
        if (!anchorScreen || !this.glyphCanvas.viewportManager) {
            return;
        }

        const currentScreenPos = this.getBoundingBoxCenterScreenPosition();
        if (!currentScreenPos) {
            return;
        }

        this.glyphCanvas.viewportManager.panX +=
            anchorScreen.x - currentScreenPos.x;
        this.glyphCanvas.viewportManager.panY +=
            anchorScreen.y - currentScreenPos.y;
    }

    private refreshKeyedMetricsViewportAnchor(
        affectedGlyphNames: Set<string>,
        anchorScreen: {
            x: number;
            y: number;
        } | null
    ): void {
        this.syncCurrentExactLayerDataFromModel();

        if (!anchorScreen) {
            return;
        }

        const currentLayerId = this.getCurrentLayerId();
        const currentLayerModel = this.getCurrentLayerModel();
        const masterId =
            typeof currentLayerModel?.master === 'object' &&
            currentLayerModel.master
                ? currentLayerModel.master.master || null
                : null;

        if (currentLayerId) {
            const glyphAdvances = this.collectLiveAdvanceWidths(
                affectedGlyphNames,
                currentLayerId,
                masterId
            );
            if (Object.keys(glyphAdvances).length > 0) {
                this.glyphCanvas.textRunEditor?.refreshGlyphAdvancesLive(
                    glyphAdvances,
                    { render: false }
                );
            }
        }

        this.applyBoundingBoxCenterScreenAnchor(anchorScreen);
    }

    private getCurrentMasterModel(): any | null {
        const fontModel = fontManager.currentFont?.fontModel;
        const layer = this.getCurrentLayerModel();
        const masterId = layer?.master?.master;

        if (!fontModel || !masterId) {
            return null;
        }

        const masters = fontModel.masters || [];
        return masters.find((master: any) => master.id === masterId) || null;
    }

    private getRootMasterModel(): any | null {
        const fontModel = fontManager.currentFont?.fontModel;
        const layer = this.getRootLayerModel();
        const masterId = layer?.master?.master;

        if (!fontModel || !masterId) {
            return null;
        }

        const masters = fontModel.masters || [];
        return masters.find((master: any) => master.id === masterId) || null;
    }

    private transformGuideToRootSpace(
        x: number,
        y: number,
        angle: number,
        transform: number[]
    ): { rootX: number; rootY: number; rootAngle: number } {
        const [a, b, c, d, tx, ty] = transform;
        const rootX = a * x + c * y + tx;
        const rootY = b * x + d * y + ty;
        const angleRad = (angle * Math.PI) / 180;
        const dirX = Math.cos(angleRad);
        const dirY = Math.sin(angleRad);
        const transformedDirX = a * dirX + c * dirY;
        const transformedDirY = b * dirX + d * dirY;
        const rootAngle =
            (Math.atan2(transformedDirY, transformedDirX) * 180) / Math.PI;

        return { rootX, rootY, rootAngle };
    }

    private transformRootDeltaToGuideSpace(
        deltaX: number,
        deltaY: number,
        transform: number[]
    ): { localDeltaX: number; localDeltaY: number } {
        const [a, b, c, d] = transform;
        const det = a * d - b * c;

        if (Math.abs(det) < 0.0001) {
            return { localDeltaX: deltaX, localDeltaY: deltaY };
        }

        return {
            localDeltaX: (d * deltaX - c * deltaY) / det,
            localDeltaY: (-b * deltaX + a * deltaY) / det
        };
    }

    getVisibleGuides(): VisibleGuide[] {
        if (!this.guidelinesVisible || !this.selectedLayerId) {
            return [];
        }

        const currentLayerData = this.getCurrentLayerDataFromStack();
        const currentLayerModel = this.getCurrentLayerModel();
        if (!currentLayerData || currentLayerData.isInterpolated) {
            return [];
        }

        const guides: VisibleGuide[] = [];
        const accumulatedTransform = this.getAccumulatedTransform();

        currentLayerModel?.guides?.forEach((guide: any, index: number) => {
            guides.push({
                scope: 'layer',
                index,
                guide,
                ...this.transformGuideToRootSpace(
                    guide.pos.x,
                    guide.pos.y,
                    guide.pos.angle ?? 0,
                    accumulatedTransform
                )
            });
        });

        const master = this.getRootMasterModel();
        master?.guides?.forEach((guide: any, index: number) => {
            guides.push({
                scope: 'master',
                index,
                guide,
                rootX: guide.pos.x,
                rootY: guide.pos.y,
                rootAngle: guide.pos.angle ?? 0
            });
        });

        return guides;
    }

    private sameGuideHandle(
        left: GuideHandle | null,
        right: GuideHandle | null
    ): boolean {
        if (!left || !right) {
            return left === right;
        }

        return left.scope === right.scope && left.index === right.index;
    }

    private getSelectedGuide(): VisibleGuide | null {
        if (!this.selectedGuideHandle) {
            return null;
        }

        return (
            this.getVisibleGuides().find((guide) =>
                this.sameGuideHandle(guide, this.selectedGuideHandle)
            ) || null
        );
    }

    private normalizeAndRoundVerticalMetrics(
        metrics: Record<string, number> | null | undefined
    ): Record<string, number> | null {
        if (!metrics) {
            return null;
        }

        const result: Record<string, number> = {};
        for (const [metricKey, rawValue] of Object.entries(metrics)) {
            if (!Number.isFinite(rawValue)) {
                continue;
            }

            let normalizedValue = rawValue;

            result[metricKey] = normalizedValue;
        }

        return Object.keys(result).length ? result : null;
    }

    private setRenderVerticalMetrics(layerData: any): void {
        this.renderVerticalMetrics = this.normalizeAndRoundVerticalMetrics(
            layerData?._verticalMetrics
        );
    }

    private remapSelectedAnchors(
        previousLayer: Babelfont.Layer | null,
        nextLayer: Babelfont.Layer | null
    ): number[] {
        const selectedAnchorNames = this.getAnchorNamesForSelectionIndices(
            this.selectedAnchors,
            previousLayer?.anchors || []
        );

        if (selectedAnchorNames.length) {
            return this.remapAnchorSelectionNames(
                selectedAnchorNames,
                nextLayer?.anchors || []
            );
        }

        return this.remapAnchorSelectionIndices(
            this.selectedAnchors,
            previousLayer?.anchors || [],
            nextLayer?.anchors || []
        );
    }

    private getAnchorNamesForSelectionIndices(
        selectedAnchorIndices: number[],
        anchors: Array<any>
    ): string[] {
        return selectedAnchorIndices
            .map((index) => anchors[index]?.name)
            .filter((name): name is string => typeof name === 'string');
    }

    private remapAnchorSelectionNames(
        selectedAnchorNames: string[],
        nextAnchors: Array<any>
    ): number[] {
        if (!selectedAnchorNames.length || !nextAnchors.length) {
            return [];
        }

        const used = new Set<number>();
        const mapped: number[] = [];

        for (const anchorName of selectedAnchorNames) {
            const match = nextAnchors.findIndex(
                (anchor, index) =>
                    !used.has(index) && (anchor?.name || '') === anchorName
            );

            if (match >= 0) {
                used.add(match);
                mapped.push(match);
            }
        }

        return mapped;
    }

    private remapAnchorSelectionIndices(
        selectedAnchorIndices: number[],
        previousAnchors: Array<any>,
        nextAnchors: Array<any>
    ): number[] {
        if (!previousAnchors.length || !nextAnchors.length) {
            return [];
        }

        const selectedSignatures = selectedAnchorIndices
            .map((index) => {
                const anchor = previousAnchors[index];
                if (!anchor) {
                    return null;
                }
                return {
                    index,
                    name: anchor.name || '',
                    x: anchor.x,
                    y: anchor.y
                };
            })
            .filter((entry): entry is NonNullable<typeof entry> => !!entry);

        if (!selectedSignatures.length) {
            return [];
        }

        const used = new Set<number>();
        const mapped: number[] = [];

        const reserve = (candidate: number | undefined): number | null => {
            if (
                candidate === undefined ||
                candidate < 0 ||
                candidate >= nextAnchors.length ||
                used.has(candidate)
            ) {
                return null;
            }
            used.add(candidate);
            return candidate;
        };

        for (const signature of selectedSignatures) {
            let match = nextAnchors.findIndex(
                (anchor, index) =>
                    !used.has(index) &&
                    (anchor.name || '') === signature.name &&
                    anchor.x === signature.x &&
                    anchor.y === signature.y
            );

            if (match < 0 && signature.name) {
                match = nextAnchors.findIndex(
                    (anchor, index) =>
                        !used.has(index) &&
                        (anchor.name || '') === signature.name
                );
            }

            const resolved =
                reserve(match >= 0 ? match : undefined) ??
                reserve(signature.index) ??
                reserve(
                    nextAnchors.findIndex((_anchor, index) => !used.has(index))
                );

            if (resolved !== null) {
                mapped.push(resolved);
            }
        }

        return mapped;
    }

    private resolveLayerModel(layer: any): any {
        if (!layer?.id) {
            return layer;
        }

        if (typeof layer.parent === 'function') {
            return layer;
        }

        return (
            this.getCurrentGlyphModel()?.findLayerById?.(layer.id) ||
            this.getRootGlyphModel()?.findLayerById?.(layer.id) ||
            layer
        );
    }

    private cloneSelectionState(
        state: LayerSelectionState | null | undefined
    ): LayerSelectionState {
        return {
            points: (state?.points || []).map((point) => ({ ...point })),
            anchors: [...(state?.anchors || [])],
            anchorNames: [...(state?.anchorNames || [])],
            components: [...(state?.components || [])],
            guideHandle: state?.guideHandle ? { ...state.guideHandle } : null
        };
    }

    private getCurrentSelectionAnchorSource(): Array<any> {
        const currentLayerData = this.getCurrentLayerDataFromStack();
        if (Array.isArray(currentLayerData?.anchors)) {
            return currentLayerData.anchors;
        }

        return this.getCurrentLayerModel()?.anchors || [];
    }

    private getCurrentSelectionState(): LayerSelectionState {
        const anchors = this.getCurrentSelectionAnchorSource();
        return this.cloneSelectionState({
            points: this.selectedPoints,
            anchors: this.selectedAnchors,
            anchorNames: this.getAnchorNamesForSelectionIndices(
                this.selectedAnchors,
                anchors
            ),
            components: this.selectedComponents,
            guideHandle: this.selectedGuideHandle
        });
    }

    private getActiveSelectionScopeGlyphName(): string | null {
        const parsed = this.parseGlyphStack();
        if (parsed.length > 0) {
            return parsed[parsed.length - 1].glyphName;
        }

        return this.currentGlyphName || this.glyphCanvas.getCurrentGlyphName();
    }

    private getLayerSelectionStorageKey(layer: any): string | null {
        const resolvedLayer = this.resolveLayerModel(layer);
        const layerId = resolvedLayer?.id || layer?.id;
        if (!layerId) {
            return null;
        }

        const parentGlyph =
            typeof resolvedLayer?.parent === 'function'
                ? resolvedLayer.parent()
                : null;
        const glyphName =
            parentGlyph?.name || this.getActiveSelectionScopeGlyphName();
        return glyphName ? `${glyphName}@${layerId}` : String(layerId);
    }

    private getLayerGlyphName(layer: any): string | null {
        const resolvedLayer = this.resolveLayerModel(layer);
        const parentGlyph =
            typeof resolvedLayer?.parent === 'function'
                ? resolvedLayer.parent()
                : null;
        return parentGlyph?.name || null;
    }

    private getAnchorsForSelectionLayer(layer: any): Array<any> {
        const resolvedLayer = this.resolveLayerModel(layer);
        const currentLayer = this.getCurrentLayerModel();
        const currentGlyphName = this.getActiveSelectionScopeGlyphName();
        const targetGlyphName = this.getLayerGlyphName(resolvedLayer);

        if (
            resolvedLayer?.id &&
            currentLayer?.id === resolvedLayer.id &&
            currentGlyphName &&
            (!targetGlyphName || targetGlyphName === currentGlyphName)
        ) {
            const currentLayerData = this.getCurrentLayerDataFromStack();
            if (Array.isArray(currentLayerData?.anchors)) {
                return currentLayerData.anchors;
            }
        }

        return resolvedLayer?.anchors || layer?.anchors || [];
    }

    private getSelectionStateAnchorNames(
        state: LayerSelectionState,
        anchors: Array<any>
    ): string[] {
        if (state.anchorNames?.length) {
            return [...state.anchorNames];
        }

        return this.getAnchorNamesForSelectionIndices(state.anchors, anchors);
    }

    private canTransferSelectionBetweenLayers(
        previousLayer: any,
        nextLayer: any
    ): boolean {
        const previousGlyphName = this.getLayerGlyphName(previousLayer);
        const nextGlyphName = this.getLayerGlyphName(nextLayer);

        if (!previousGlyphName || !nextGlyphName) {
            return true;
        }

        return previousGlyphName === nextGlyphName;
    }

    private storeSelectionStateForLayer(
        layer: any,
        state: LayerSelectionState = this.getCurrentSelectionState()
    ): void {
        const key = this.getLayerSelectionStorageKey(layer);
        if (!key) {
            return;
        }

        this.layerSelectionStateByKey.set(key, this.cloneSelectionState(state));
    }

    private getStoredSelectionStateForLayer(
        layer: any
    ): LayerSelectionState | null {
        const key = this.getLayerSelectionStorageKey(layer);
        if (!key) {
            return null;
        }

        const storedState = this.layerSelectionStateByKey.get(key);
        return storedState ? this.cloneSelectionState(storedState) : null;
    }

    private isPathShape(shape: any): boolean {
        if (!shape) {
            return false;
        }

        if (typeof shape.isPath === 'function') {
            return !!shape.isPath();
        }

        return 'Path' in shape || 'nodes' in shape;
    }

    private isComponentShape(shape: any): boolean {
        if (!shape) {
            return false;
        }

        if (typeof shape.isComponent === 'function') {
            return !!shape.isComponent();
        }

        return 'Component' in shape || 'reference' in shape;
    }

    private getNodeCountForShape(shape: any): number {
        if (!this.isPathShape(shape)) {
            return 0;
        }

        if (typeof shape.asPath === 'function') {
            return shape.asPath().nodes?.length || 0;
        }

        if ('Path' in shape && Array.isArray(shape.Path?.nodes)) {
            return shape.Path.nodes.length;
        }

        return Array.isArray(shape.nodes) ? shape.nodes.length : 0;
    }

    private selectAllCurrentLayerObjects(): boolean {
        if (!this.selectedLayerId) {
            return false;
        }

        const layer =
            this.getCurrentLayerDataFromStack() || this.getCurrentLayerModel();
        if (!layer) {
            return false;
        }

        const shapes = layer.shapes || [];
        const points: Point[] = [];
        const components: number[] = [];

        shapes.forEach((shape: any, shapeIndex: number) => {
            if (this.isPathShape(shape)) {
                const nodeCount = this.getNodeCountForShape(shape);
                for (let nodeIndex = 0; nodeIndex < nodeCount; nodeIndex++) {
                    points.push({ contourIndex: shapeIndex, nodeIndex });
                }
                return;
            }

            if (this.isComponentShape(shape)) {
                components.push(shapeIndex);
            }
        });

        const anchorSource = this.getAnchorsForSelectionLayer(layer);
        const anchors = anchorSource.map((_anchor, index) => index);

        this.applySelectionStateForLayer(
            {
                points,
                anchors,
                anchorNames: this.getAnchorNamesForSelectionIndices(
                    anchors,
                    anchorSource
                ),
                components,
                guideHandle: null
            },
            layer
        );
        this.glyphCanvas.updatePropertyPanel();
        this.glyphCanvas.render();

        return points.length > 0 || anchors.length > 0 || components.length > 0;
    }

    private resetMarqueeSelection(): void {
        this.isMarqueeSelecting = false;
        this.marqueeSelectionStart = null;
        this.marqueeSelectionCurrent = null;
        this.marqueeToggleMode = false;
        this.marqueeInitialPoints = [];
    }

    private cloneSelectedPoints(
        points: Point[] = this.selectedPoints
    ): Point[] {
        return points.map((point) => ({ ...point }));
    }

    private getPointSelectionKey(point: Point): string {
        return `${point.contourIndex}:${point.nodeIndex}`;
    }

    private getCurrentLayerSelectablePoints(layer: any): Point[] {
        const shapes = layer?.shapes || [];
        const points: Point[] = [];

        shapes.forEach((shape: any, contourIndex: number) => {
            const contour = getEditableContour(shape);
            if (!contour) {
                return;
            }

            contour.nodes.forEach((_node, nodeIndex) => {
                points.push({ contourIndex, nodeIndex });
            });
        });

        return points;
    }

    private getMarqueeSelectionBox(): {
        minX: number;
        minY: number;
        maxX: number;
        maxY: number;
        width: number;
        height: number;
    } | null {
        if (!this.marqueeSelectionStart || !this.marqueeSelectionCurrent) {
            return null;
        }

        const minX = Math.min(
            this.marqueeSelectionStart.glyphX,
            this.marqueeSelectionCurrent.glyphX
        );
        const minY = Math.min(
            this.marqueeSelectionStart.glyphY,
            this.marqueeSelectionCurrent.glyphY
        );
        const maxX = Math.max(
            this.marqueeSelectionStart.glyphX,
            this.marqueeSelectionCurrent.glyphX
        );
        const maxY = Math.max(
            this.marqueeSelectionStart.glyphY,
            this.marqueeSelectionCurrent.glyphY
        );

        return {
            minX,
            minY,
            maxX,
            maxY,
            width: maxX - minX,
            height: maxY - minY
        };
    }

    private hasMarqueeDragged(): boolean {
        const rect = this.getMarqueeSelectionBox();
        if (!rect) {
            return false;
        }

        return rect.width !== 0 || rect.height !== 0;
    }

    getVisibleMarqueeSelectionBox(): {
        minX: number;
        minY: number;
        width: number;
        height: number;
    } | null {
        if (!this.isMarqueeSelecting) {
            return null;
        }

        const rect = this.getMarqueeSelectionBox();
        if (!rect) {
            return null;
        }

        return {
            minX: rect.minX,
            minY: rect.minY,
            width: rect.width,
            height: rect.height
        };
    }

    private beginMarqueeSelection(e: MouseEvent): boolean {
        if (e.altKey || e.metaKey || e.ctrlKey) {
            return false;
        }

        const { glyphX, glyphY } = this.transformMouseToComponentSpace();
        this.isMarqueeSelecting = true;
        this.marqueeSelectionStart = { glyphX, glyphY };
        this.marqueeSelectionCurrent = { glyphX, glyphY };
        this.marqueeToggleMode = e.shiftKey;
        this.marqueeInitialPoints = this.cloneSelectedPoints();
        return true;
    }

    private getToggledMarqueeSelection(pointsInRect: Point[]): Point[] {
        const initialKeys = new Set(
            this.marqueeInitialPoints.map((point) =>
                this.getPointSelectionKey(point)
            )
        );
        const rectKeys = new Set(
            pointsInRect.map((point) => this.getPointSelectionKey(point))
        );

        const nextPoints = this.marqueeInitialPoints.filter(
            (point) => !rectKeys.has(this.getPointSelectionKey(point))
        );

        pointsInRect.forEach((point) => {
            if (!initialKeys.has(this.getPointSelectionKey(point))) {
                nextPoints.push(point);
            }
        });

        return nextPoints;
    }

    private updateMarqueeSelection(): void {
        const layer = this.getCurrentLayerDataFromStack();
        const rect = this.getMarqueeSelectionBox();
        if (!layer || !rect) {
            return;
        }

        const pointsInRect = this.getCurrentLayerSelectablePoints(layer).filter(
            (point) => {
                const shape = layer.shapes?.[point.contourIndex];
                const contour = getEditableContour(shape);
                const node = contour?.nodes?.[point.nodeIndex];
                if (!node) {
                    return false;
                }

                return (
                    node.x >= rect.minX &&
                    node.x <= rect.maxX &&
                    node.y >= rect.minY &&
                    node.y <= rect.maxY
                );
            }
        );

        const nextPoints = this.marqueeToggleMode
            ? this.getToggledMarqueeSelection(pointsInRect)
            : pointsInRect;

        const sanitizedPoints = this.sanitizeSelectionStateForLayer(
            {
                points: nextPoints,
                anchors: [],
                anchorNames: [],
                components: [],
                guideHandle: null
            },
            layer
        ).points;

        this.selectedPoints = sanitizedPoints;
        this.storeSelectionStateForLayer(layer);
        this.glyphCanvas.updatePropertyPanel();
    }

    private getLayerFingerprint(layer: any): string | null {
        const resolvedLayer = this.resolveLayerModel(layer);
        return typeof resolvedLayer?.fingerprint === 'string'
            ? resolvedLayer.fingerprint
            : null;
    }

    private remapSelectionStateBetweenLayers(
        state: LayerSelectionState,
        previousLayer: any,
        nextLayer: any
    ): LayerSelectionState | null {
        const previousFingerprint = this.getLayerFingerprint(previousLayer);
        const nextFingerprint = this.getLayerFingerprint(nextLayer);
        if (
            previousFingerprint &&
            nextFingerprint &&
            previousFingerprint !== nextFingerprint
        ) {
            return null;
        }

        const previousAnchors = this.getAnchorsForSelectionLayer(previousLayer);
        const nextAnchors = this.getAnchorsForSelectionLayer(nextLayer);
        const anchorNames = this.getSelectionStateAnchorNames(
            state,
            previousAnchors
        );
        const anchors = anchorNames.length
            ? this.remapAnchorSelectionNames(anchorNames, nextAnchors)
            : this.remapAnchorSelectionIndices(
                  state.anchors,
                  previousAnchors,
                  nextAnchors
              );

        return this.cloneSelectionState({
            points: state.points,
            anchors,
            anchorNames: this.getAnchorNamesForSelectionIndices(
                anchors,
                nextAnchors
            ),
            components: state.components,
            guideHandle: state.guideHandle
        });
    }

    private getMasterGuideCountForLayer(layer: any): number {
        const masterId = layer?.master?.master;
        if (!masterId) {
            return 0;
        }

        const master =
            fontManager.currentFont?.fontModel?.findMaster?.(masterId);
        return master?.guides?.length || 0;
    }

    private sanitizeSelectionStateForLayer(
        state: LayerSelectionState | null | undefined,
        layer: any
    ): LayerSelectionState {
        const shapes = layer?.shapes || [];
        const anchors = this.getAnchorsForSelectionLayer(layer);
        const guides = layer?.guides || [];
        const normalizedState = this.cloneSelectionState(state);

        const points = normalizedState.points.filter(
            ({ contourIndex, nodeIndex }) =>
                contourIndex >= 0 &&
                contourIndex < shapes.length &&
                this.isPathShape(shapes[contourIndex]) &&
                nodeIndex >= 0 &&
                nodeIndex < this.getNodeCountForShape(shapes[contourIndex])
        );

        const anchorSelection = normalizedState.anchorNames.length
            ? this.remapAnchorSelectionNames(
                  normalizedState.anchorNames,
                  anchors
              )
            : normalizedState.anchors.filter(
                  (index) => index >= 0 && index < anchors.length
              );

        const componentSelection = normalizedState.components.filter(
            (index) =>
                index >= 0 &&
                index < shapes.length &&
                this.isComponentShape(shapes[index])
        );

        let guideHandle = normalizedState.guideHandle;
        if (guideHandle?.scope === 'layer') {
            if (guideHandle.index < 0 || guideHandle.index >= guides.length) {
                guideHandle = null;
            }
        } else if (guideHandle?.scope === 'master') {
            if (
                guideHandle.index < 0 ||
                guideHandle.index >= this.getMasterGuideCountForLayer(layer)
            ) {
                guideHandle = null;
            }
        }

        return {
            points,
            anchors: anchorSelection,
            anchorNames: this.getAnchorNamesForSelectionIndices(
                anchorSelection,
                anchors
            ),
            components: componentSelection,
            guideHandle: guideHandle ? { ...guideHandle } : null
        };
    }

    private isSelectionStateCompatibleWithLayer(
        state: LayerSelectionState,
        previousLayer: any,
        layer: any
    ): boolean {
        const remappedState = this.remapSelectionStateBetweenLayers(
            state,
            previousLayer,
            layer
        );

        if (!remappedState) {
            return false;
        }

        const sanitizedState = this.sanitizeSelectionStateForLayer(
            remappedState,
            layer
        );

        if (sanitizedState.points.length !== remappedState.points.length) {
            return false;
        }

        if (sanitizedState.anchors.length !== remappedState.anchors.length) {
            return false;
        }

        if (
            sanitizedState.components.length !== remappedState.components.length
        ) {
            return false;
        }

        return this.sameGuideHandle(
            sanitizedState.guideHandle,
            remappedState.guideHandle
        );
    }

    private applySelectionStateForLayer(
        state: LayerSelectionState | null | undefined,
        layer: any
    ): void {
        const nextState = this.sanitizeSelectionStateForLayer(state, layer);

        this.selectedPoints = nextState.points;
        this.selectedAnchors = nextState.anchors;
        this.selectedComponents = nextState.components;
        this.selectedGuideHandle = nextState.guideHandle;
        this.selectedSidebearingHandle = null;
        this.storeSelectionStateForLayer(layer, nextState);
    }

    private getSelectionStateForLayerTransition(
        previousLayer: any,
        nextLayer: any
    ): LayerSelectionState {
        const emptyState = this.cloneSelectionState(null);
        if (!nextLayer) {
            return emptyState;
        }

        if (!previousLayer) {
            this.pendingGlyphSwitchSourceLayerKey = null;
            this.pendingGlyphSwitchSourceLayer = null;
            return (
                this.getStoredSelectionStateForLayer(nextLayer) || emptyState
            );
        }

        const previousState = this.getCurrentSelectionState();
        const isCrossGlyphTransition = !this.canTransferSelectionBetweenLayers(
            previousLayer,
            nextLayer
        );
        const previousLayerKey =
            this.getLayerSelectionStorageKey(previousLayer);
        const shouldPreservePreparedPreviousSnapshot =
            isCrossGlyphTransition &&
            !!previousLayerKey &&
            previousLayerKey === this.pendingGlyphSwitchSourceLayerKey;

        if (!shouldPreservePreparedPreviousSnapshot) {
            this.storeSelectionStateForLayer(previousLayer, previousState);
        }

        this.pendingGlyphSwitchSourceLayerKey = null;
        this.pendingGlyphSwitchSourceLayer = null;

        if (isCrossGlyphTransition) {
            return (
                this.getStoredSelectionStateForLayer(nextLayer) || emptyState
            );
        }

        if (
            this.isSelectionStateCompatibleWithLayer(
                previousState,
                previousLayer,
                nextLayer
            )
        ) {
            return (
                this.remapSelectionStateBetweenLayers(
                    previousState,
                    previousLayer,
                    nextLayer
                ) || previousState
            );
        }

        return this.getStoredSelectionStateForLayer(nextLayer) || emptyState;
    }

    private assignLayerData(
        layerData: Babelfont.Layer | null,
        verticalMetricsSource?: any
    ): void {
        const previousLayerData = this.getCurrentLayerDataFromStack();
        if (layerData && layerData.shapes) {
            parseComponentNodes(layerData.shapes);
        }
        this.layerData = layerData;
        this.setRenderVerticalMetrics(verticalMetricsSource ?? layerData);

        const nextLayerData = this.getCurrentLayerDataFromStack();
        this.selectedAnchors = this.remapSelectedAnchors(
            previousLayerData,
            nextLayerData
        );
    }

    private mergeSelectedLayerComponentLayerData(
        exactLayerData: Babelfont.Layer | null | undefined,
        fallbackLayerData: Babelfont.Layer | null | undefined
    ): Babelfont.Layer | null | undefined {
        if (!exactLayerData) {
            return fallbackLayerData;
        }

        if (!fallbackLayerData) {
            return exactLayerData;
        }

        const mergedLayerData: Babelfont.Layer = {
            ...fallbackLayerData,
            ...exactLayerData,
            isInterpolated: false
        };

        if (exactLayerData.shapes || fallbackLayerData.shapes) {
            mergedLayerData.shapes = this.mergeSelectedLayerShapes(
                exactLayerData.shapes || [],
                fallbackLayerData.shapes || []
            );
        }

        return mergedLayerData;
    }

    private mergeSelectedLayerShapes(
        exactShapes: Babelfont.Shape[],
        interpolatedShapes: Babelfont.Shape[]
    ): Babelfont.Shape[] {
        const interpolatedComponentsByReference = new Map<
            string,
            Babelfont.Component[]
        >();

        for (const shape of interpolatedShapes) {
            if (!('reference' in shape)) {
                continue;
            }

            const queue =
                interpolatedComponentsByReference.get(shape.reference) || [];
            queue.push(shape);
            interpolatedComponentsByReference.set(shape.reference, queue);
        }

        return exactShapes.map((exactShape) => {
            if (!('reference' in exactShape)) {
                return exactShape;
            }

            const componentQueue =
                interpolatedComponentsByReference.get(exactShape.reference) ||
                [];
            const interpolatedShape = componentQueue.shift();
            const mergedLayerData = this.mergeSelectedLayerComponentLayerData(
                exactShape.layerData,
                interpolatedShape?.layerData
            );

            return {
                ...interpolatedShape,
                ...exactShape,
                transform: interpolatedShape?.transform ||
                    exactShape.transform || [1, 0, 0, 1, 0, 0],
                ...(mergedLayerData ? { layerData: mergedLayerData } : {}),
                isInterpolated: false
            };
        });
    }

    private applyExactSelectedLayerData(
        exactLayerData: any,
        interpolatedResult?: any | null
    ): void {
        const exactNormalized = LayerDataNormalizer.normalize(
            exactLayerData,
            false
        );
        const interpolatedNormalized = LayerDataNormalizer.normalize(
            interpolatedResult,
            true
        );

        if (exactNormalized?.shapes && interpolatedNormalized?.shapes?.length) {
            exactNormalized.shapes = this.mergeSelectedLayerShapes(
                exactNormalized.shapes,
                interpolatedNormalized.shapes
            );
        }

        this.assignLayerData(
            exactNormalized,
            interpolatedResult ?? exactNormalized
        );
    }

    private cloneLayerData<T>(value: T): T {
        if (typeof structuredClone === 'function') {
            return structuredClone(value);
        }

        return JSON.parse(JSON.stringify(value));
    }

    private flattenNestedShapes(shapes: any[] | undefined): any[] {
        if (!Array.isArray(shapes)) {
            return [];
        }

        return shapes.map((shape) => {
            if (!shape || typeof shape !== 'object') {
                return shape;
            }

            const flattenedShape =
                'Path' in shape && shape.Path
                    ? shape.Path
                    : 'Component' in shape && shape.Component
                      ? shape.Component
                      : shape;

            const result = { ...flattenedShape };

            if (result.layerData?.shapes) {
                result.layerData = {
                    ...result.layerData,
                    shapes: this.flattenNestedShapes(result.layerData.shapes)
                };
            }

            return result;
        });
    }

    private serializeLayerDataAsInterpolationPayload(layerData: any): any {
        if (!layerData || typeof layerData !== 'object') {
            return layerData;
        }

        const serializedLayerData: any = {
            width: layerData.width ?? 0,
            shapes: this.flattenNestedShapes(layerData.shapes).map((shape) => {
                if (!shape || typeof shape !== 'object') {
                    return shape;
                }

                if ('nodes' in shape) {
                    const serializedPath: Record<string, any> = {
                        nodes: Array.isArray(shape.nodes)
                            ? LayerDataNormalizer.serializeNodes(shape.nodes)
                            : shape.nodes
                    };

                    if (shape.closed !== undefined) {
                        serializedPath.closed = shape.closed;
                    }

                    if (
                        shape.format_specific &&
                        Object.keys(shape.format_specific).length
                    ) {
                        serializedPath.format_specific = shape.format_specific;
                    }

                    return serializedPath;
                }

                if ('reference' in shape) {
                    const originalTransform = shape.transform;
                    const affineTransform = Array.isArray(originalTransform)
                        ? originalTransform
                        : originalTransform
                          ? DecomposedAffineTransform.toAffine(
                                originalTransform
                            )
                          : [1, 0, 0, 1, 0, 0];

                    const serializedComponent: Record<string, any> = {
                        reference: shape.reference
                    };

                    if (
                        shape.format_specific &&
                        Object.keys(shape.format_specific).length
                    ) {
                        serializedComponent.format_specific =
                            shape.format_specific;
                    }

                    const isIdentityTransform =
                        affineTransform[0] === 1 &&
                        affineTransform[1] === 0 &&
                        affineTransform[2] === 0 &&
                        affineTransform[3] === 1 &&
                        affineTransform[4] === 0 &&
                        affineTransform[5] === 0;
                    if (!isIdentityTransform) {
                        serializedComponent.transform = originalTransform;
                    }

                    if (shape.location && Object.keys(shape.location).length) {
                        serializedComponent.location = shape.location;
                    }

                    if (shape.layerData) {
                        serializedComponent.layerData =
                            this.serializeLayerDataAsInterpolationPayload(
                                shape.layerData
                            );
                    }

                    return serializedComponent;
                }

                return shape;
            })
        };

        const serializedAnchors = (layerData.anchors || []).map(
            (anchor: any) => ({
                name: anchor.name,
                x: anchor.x,
                y: anchor.y
            })
        );
        if (serializedAnchors.length) {
            serializedLayerData.anchors = serializedAnchors;
        }

        delete serializedLayerData._verticalMetrics;
        delete serializedLayerData._interpolationLocation;

        return serializedLayerData;
    }

    private getPreferredComponentLayer(
        componentGlyph: any,
        masterId: string | null | undefined
    ): any | null {
        const layers = componentGlyph?.layers || [];
        if (!layers.length) {
            return null;
        }

        if (masterId) {
            const defaultLayer = layers.find(
                (candidate: any) =>
                    candidate.master?.master === masterId &&
                    candidate.master?.type === 'DefaultForMaster'
            );
            if (defaultLayer) {
                return defaultLayer;
            }

            const nonIntermediateSameMaster = layers.find(
                (candidate: any) =>
                    candidate.master?.master === masterId &&
                    (!candidate.location ||
                        Object.keys(candidate.location).length === 0) &&
                    (!candidate.smart_component_location ||
                        Object.keys(candidate.smart_component_location)
                            .length === 0)
            );
            if (nonIntermediateSameMaster) {
                return nonIntermediateSameMaster;
            }
        }

        return layers[0] || null;
    }

    private getVerticalMetricsForLayer(
        layer: any,
        fontModel: any
    ): Record<string, number> | null {
        const masterId = layer?.master?.master;
        if (!fontModel || !masterId) {
            return null;
        }

        const master =
            fontModel.findMaster?.(masterId) ||
            fontModel.masters?.find(
                (candidate: any) => candidate.id === masterId
            );
        const metrics = master?.metrics;

        if (!metrics || typeof metrics !== 'object') {
            return null;
        }

        const verticalMetrics = Object.fromEntries(
            Object.entries(metrics).filter(([, value]) =>
                Number.isFinite(value)
            )
        ) as Record<string, number>;

        if (!Object.keys(verticalMetrics).length) {
            return null;
        }

        if (Number.isFinite(verticalMetrics.WinDescent)) {
            verticalMetrics.WinDescent = -Math.abs(verticalMetrics.WinDescent);
        }

        return verticalMetrics;
    }

    private resolveComponentLayerDataFromModel(
        shapes: any[] | undefined,
        fontModel: any,
        masterId: string | null | undefined,
        visited: Set<string>
    ): any[] {
        const flattenedShapes = this.flattenNestedShapes(shapes);

        return flattenedShapes.map((shape) => {
            if (
                !shape ||
                typeof shape !== 'object' ||
                !('reference' in shape)
            ) {
                return shape;
            }

            const resolvedShape = { ...shape };
            const reference = resolvedShape.reference;

            if (!fontModel || !reference || visited.has(reference)) {
                if (resolvedShape.layerData?.shapes) {
                    resolvedShape.layerData = {
                        ...resolvedShape.layerData,
                        shapes: this.resolveComponentLayerDataFromModel(
                            resolvedShape.layerData.shapes,
                            fontModel,
                            masterId,
                            visited
                        )
                    };
                }

                return resolvedShape;
            }

            const componentGlyph =
                fontModel.findGlyph?.(reference) ||
                fontModel.glyphs?.find(
                    (glyph: any) => glyph.name === reference
                );
            if (!componentGlyph?.layers?.length) {
                return resolvedShape;
            }

            visited.add(reference);

            const componentLayer =
                this.getPreferredComponentLayer(componentGlyph, masterId) ||
                componentGlyph.layers[0];

            const rawLayerData =
                componentLayer?.toJSON?.() || componentLayer || null;
            const nestedLayerData = rawLayerData
                ? this.cloneLayerData(rawLayerData)
                : resolvedShape.layerData
                  ? this.cloneLayerData(resolvedShape.layerData)
                  : null;

            if (nestedLayerData?.shapes) {
                nestedLayerData.shapes =
                    this.resolveComponentLayerDataFromModel(
                        nestedLayerData.shapes,
                        fontModel,
                        componentLayer?.master?.master ?? masterId,
                        visited
                    );
            }

            visited.delete(reference);

            if (!nestedLayerData) {
                return resolvedShape;
            }

            return {
                ...resolvedShape,
                layerData: nestedLayerData
            };
        });
    }

    private buildExactLayerDataFromModel(
        glyphName: string,
        layerId: string
    ): any | null {
        const fontModel = fontManager.currentFont?.fontModel;
        const glyph = this.getGlyphModelByName(glyphName);
        const layer = glyph?.findLayerById?.(layerId);
        const rawLayerData = layer?.toJSON?.();

        if (!fontModel || !rawLayerData) {
            return null;
        }

        const exactLayerData = this.cloneLayerData(rawLayerData);
        exactLayerData.shapes = this.resolveComponentLayerDataFromModel(
            exactLayerData.shapes,
            fontModel,
            layer?.master?.master,
            new Set([glyphName])
        );

        const serializedLayerData =
            this.serializeLayerDataAsInterpolationPayload(exactLayerData);

        const verticalMetrics = this.getVerticalMetricsForLayer(
            layer,
            fontModel
        );
        if (verticalMetrics) {
            serializedLayerData._verticalMetrics = verticalMetrics;
        }

        const interpolationLocation = this.getUserspaceLocationForLayer(
            layerId,
            glyphName
        );
        if (interpolationLocation) {
            serializedLayerData._interpolationLocation = interpolationLocation;
        }

        return serializedLayerData;
    }

    private updateCurrentGlyphNameFromStack(glyphName: string): void {
        const parsed = this.parseGlyphStack();
        if (parsed.length > 1) {
            this.currentGlyphName = parsed[parsed.length - 1].glyphName;
        } else {
            this.currentGlyphName = glyphName;
        }
    }

    private finalizeFetchedLayerData(
        glyphName: string,
        skipRender: boolean
    ): void {
        this.updateCurrentGlyphNameFromStack(glyphName);

        console.log('Fetched ROOT layer data:', this.layerData);
        console.log('Current position in stack:', this.glyphStack);

        this.glyphCanvas.updatePropertyPanel();

        if (!skipRender) {
            this.glyphCanvas.render();
        }
    }

    private getExactLayerDataForSelection(
        glyphName: string,
        layerId: string
    ): any | null {
        return this.buildExactLayerDataFromModel(glyphName, layerId);
    }

    /**
     * Look up the userspace location for a layer by its ID.
     * Finds the layer in the current glyph's font model, resolves its
     * design-space location (brace layer location or master location),
     * and converts to userspace.
     */
    private getUserspaceLocationForLayer(
        layerId: string,
        rootGlyphName?: string
    ): UserspaceLocation | null {
        const fontModel = fontManager.currentFont?.fontModel;
        if (!fontModel) return null;

        const glyphName = rootGlyphName ?? this.parseGlyphStack()[0]?.glyphName;
        if (!glyphName) return null;
        const glyph = fontModel.glyphs.find((g: any) => g.name === glyphName);
        if (!glyph?.layers) return null;

        const layer = glyph.layers.find((l: any) => l.id === layerId);
        if (!layer) return null;

        const masters: Babelfont.Master[] = (fontModel.masters as any) || [];
        const masterIdToFind = layer.master?.master;
        const master = masters.find((m) => m.id === masterIdToFind);
        const hasLayerLocation =
            !!layer.location && Object.keys(layer.location).length > 0;
        const designLocation = hasLayerLocation
            ? layer.location
            : master?.location;

        if (!designLocation) return null;

        const fontAxes = fontModel.axes || [];
        return designspaceToUserspace(designLocation, fontAxes as any);
    }

    private sameSidebearingHandle(
        left: SidebearingHandle | null,
        right: SidebearingHandle | null
    ): boolean {
        return left?.side === right?.side;
    }

    private getSidebearingHandleRadiusScreen(): number {
        const scale = this.glyphCanvas.viewportManager!.scale;
        const anchorSizeMax =
            APP_SETTINGS.OUTLINE_EDITOR.ANCHOR_SIZE_AT_MAX_ZOOM;
        const anchorSizeMin =
            APP_SETTINGS.OUTLINE_EDITOR.ANCHOR_SIZE_AT_MIN_ZOOM;
        const anchorInterpolationMin =
            APP_SETTINGS.OUTLINE_EDITOR.ANCHOR_SIZE_INTERPOLATION_MIN;
        const anchorInterpolationMax =
            APP_SETTINGS.OUTLINE_EDITOR.ANCHOR_SIZE_INTERPOLATION_MAX;

        if (scale >= anchorInterpolationMax) {
            return anchorSizeMax;
        }

        const zoomFactor =
            (scale - anchorInterpolationMin) /
            (anchorInterpolationMax - anchorInterpolationMin);
        const clampedZoomFactor = Math.max(0, Math.min(1, zoomFactor));
        return (
            anchorSizeMin + (anchorSizeMax - anchorSizeMin) * clampedZoomFactor
        );
    }

    getVisibleSidebearingHandles(): VisibleSidebearingHandle[] {
        if (
            !this.selectedLayerId ||
            this.glyphCanvas.viewportManager!.scale <
                APP_SETTINGS.OUTLINE_EDITOR.MIN_ZOOM_FOR_HANDLES
        ) {
            return [];
        }

        const currentLayerData = this.getCurrentLayerDataFromStack();
        const currentLayerModel = this.getCurrentLayerModel();
        if (
            !currentLayerData ||
            currentLayerData.isInterpolated ||
            !currentLayerModel
        ) {
            return [];
        }

        const scale = this.glyphCanvas.viewportManager!.scale;
        const lowestMetricY =
            getLowestVisibleVerticalMetricValue(this.renderVerticalMetrics) ??
            0;
        const highestMetricY =
            getHighestVisibleVerticalMetricValue(this.renderVerticalMetrics) ??
            lowestMetricY;
        const panY = this.glyphCanvas.viewportManager!.panY;
        const rawCanvasHeight = this.canvas
            ? this.canvas.height / (window.devicePixelRatio || 1)
            : null;
        const canvasHeight =
            rawCanvasHeight !== null && rawCanvasHeight > 0
                ? rawCanvasHeight
                : null;
        const desiredHandleScreenY = -lowestMetricY * scale + panY;
        const highestMetricScreenY = -highestMetricY * scale + panY;
        const handleViewportInset = 10;
        const bottomClampedHandleScreenY =
            canvasHeight === null
                ? desiredHandleScreenY
                : Math.min(
                      desiredHandleScreenY,
                      canvasHeight - handleViewportInset
                  );
        const clampedHandleScreenY = Math.max(
            highestMetricScreenY,
            bottomClampedHandleScreenY
        );
        const handleY = -(clampedHandleScreenY - panY) / scale;
        const width = Number(currentLayerData.width);
        const handles: VisibleSidebearingHandle[] = [];

        const leftResolution = currentLayerModel.resolveMetricsKey('left');
        if (!leftResolution.error && leftResolution.value !== null) {
            handles.push({
                side: 'left',
                x: 0,
                y: handleY,
                editable: !leftResolution.input
            });
        }

        const rightResolution = currentLayerModel.resolveMetricsKey('right');
        if (
            !rightResolution.error &&
            rightResolution.value !== null &&
            Number.isFinite(width)
        ) {
            handles.push({
                side: 'right',
                x: width,
                y: handleY,
                editable: !rightResolution.input
            });
        }

        return handles;
    }

    /**
     * Apply Rust-returned layer data (interpolated or on-layer) to the editor.
     * Normalizes, parses component nodes, assigns layerData, and sets vertical metrics.
     */
    private applyRustLayerData(rustResult: any, isInterpolated: boolean): void {
        const normalized = LayerDataNormalizer.normalize(
            rustResult,
            isInterpolated
        );
        this.assignLayerData(normalized, rustResult);
    }

    /**
     * Parse glyph_stack into structured components
     * @returns Array of stack items, each with glyphName, layerId, and componentIndex
     */
    parseGlyphStack(): Array<{
        glyphName: string;
        layerId: string;
        componentIndex?: number;
    }> {
        if (!this.glyphStack) return [];

        const segments = this.glyphStack.split('>');
        const result: Array<{
            glyphName: string;
            layerId: string;
            componentIndex?: number;
        }> = [];

        for (let i = 0; i < segments.length; i++) {
            const segment = segments[i];
            let glyphAndLayer: string;
            let componentIndex: number | undefined;

            // Check if this segment has a component index (format: componentIndex:glyphName@layerId)
            if (segment.includes(':')) {
                const parts = segment.split(':');
                componentIndex = parseInt(parts[0], 10);
                glyphAndLayer = parts[1];
            } else {
                glyphAndLayer = segment;
            }

            // Split glyphName@layerId
            const [glyphName, layerId] = glyphAndLayer.split('@');

            result.push({
                glyphName,
                layerId,
                componentIndex
            });
        }

        return result;
    }

    /**
     * Check if currently editing a nested component
     * @returns true if inside one or more nested components
     */
    isEditingComponent(): boolean {
        const parsed = this.parseGlyphStack();
        return parsed.length > 1; // More than just root means we're in a component
    }

    /**
     * Get component nesting depth from glyphStack
     * @returns Number of nested component levels (0 = root, 1 = one level deep, etc.)
     */
    getComponentDepth(): number {
        const parsed = this.parseGlyphStack();
        return Math.max(0, parsed.length - 1); // Subtract 1 for root
    }

    /**
     * Build glyph_stack string from current state
     * @param rootGlyphName - Name of the root glyph
     * @param layerId - Current layer ID
     * @param componentPath - Array of component indices representing the nesting path
     */
    buildGlyphStack(
        rootGlyphName: string,
        layerId: string,
        componentPath: number[] = []
    ): void {
        let stack = `${rootGlyphName}@${layerId}`;

        // Add each nested component to the stack
        let currentLayerData = this.layerData;
        for (let i = 0; i < componentPath.length; i++) {
            const compIndex = componentPath[i];

            if (
                !currentLayerData ||
                !currentLayerData.shapes ||
                !currentLayerData.shapes[compIndex]
            ) {
                console.error(
                    '[GlyphStack] Invalid component path at index',
                    i,
                    compIndex
                );
                break;
            }

            const shape = currentLayerData.shapes[compIndex];
            if (!('reference' in shape)) {
                console.error(
                    '[GlyphStack] Shape at index',
                    compIndex,
                    'is not a component'
                );
                break;
            }

            const componentGlyphName = shape.reference;

            // Move to the nested component's layer data for the next iteration
            currentLayerData = shape.layerData || null;

            // Use the component's layer ID from its layerData
            const componentLayerId = currentLayerData?.id || layerId;
            stack += `>${compIndex}:${componentGlyphName}@${componentLayerId}`;
        }

        this.glyphStack = stack;
        console.log('[GlyphStack] Built stack:', this.glyphStack);
        window.dispatchEvent(
            new CustomEvent('glyphStackChanged', {
                detail: { glyphStack: this.glyphStack }
            })
        );
    }

    /**
     * Rebuild glyph_stack with new layer IDs when switching layers
     * This method does NOT depend on this.layerData, so it works even when layer data hasn't been fetched yet
     * Preserves the component navigation path
     */
    rebuildGlyphStackWithNewLayer(newLayerId: string): void {
        if (!this.glyphStack) return;

        // Only update the ROOT layer ID, preserve component layer IDs
        // Stack format: "glyphA@rootLayerID>0:glyphB@compLayerID>1:glyphC@compLayerID"
        // We want: "glyphA@newLayerID>0:glyphB@compLayerID>1:glyphC@compLayerID"

        // Split by '>' to get segments
        const segments = this.glyphStack.split('>');
        const newSegments = segments.map((segment, index) => {
            if (index === 0) {
                // Root segment - update its layer ID
                const atIndex = segment.lastIndexOf('@');
                const glyphName = segment.substring(0, atIndex);
                return `${glyphName}@${newLayerId}`;
            } else {
                // Component segments - preserve their layer IDs
                return segment;
            }
        });

        this.glyphStack = newSegments.join('>');
        console.log(
            '[GlyphStack] Rebuilt stack with new root layer ID:',
            this.glyphStack
        );
        window.dispatchEvent(
            new CustomEvent('glyphStackChanged', {
                detail: { glyphStack: this.glyphStack }
            })
        );
    }

    clearState() {
        this.canvasContextMenuTippy?.hide();
        this.canvasContextMenuTarget = null;
        this.layerData = null;
        this.selectedPoints = [];
        this.selectedSidebearingHandle = null;
        this.hoveredPointIndex = null;
        this.hoveredAddPointPreview = null;
        this.hoveredCommandCurvePreview = null;
        this.altKeyPressed = false;
        this.cmdKeyPressed = false;
        this.hoveredSidebearingHandle = null;
        this.isDraggingPoint = false;
        this.isSlidingSmoothPointAlongCurve = false;
        this.isSnappedToCloseOpenPath = false;
        this.isDraggingSidebearing = false;
        this.isDraggingGuide = false;
        this.selectedGuideHandle = null;
        this.hoveredGuideHandle = null;
        this.activeSnapTarget = null;
        this.snapDraggedNaturalPos = null;
        this._snapDragStartMouseX = null;
        this._snapDragStartMouseY = null;
        this._snapDragStartNodePos = null;
        this._snapCandidateCache = null;
        this._lastDragSaveTime = 0;
        this._lastPropertyPanelUpdateTime = 0;
        this._pendingDragMetricsUpdate = false;
        this._pointDragDeltaX = 0;
        this._componentDragDeltaX = 0;
        this._pointDragPreserveHandlePositions = false;
        this.activePathDrawingSession = null;
        this.pendingCommandPathEdit = null;
        this.resetMarqueeSelection();
        this.layerDataDirty = false;
    }

    clearAllSelections() {
        this.resetMarqueeSelection();
        this.selectedPoints = [];
        this.selectedAnchors = [];
        this.selectedComponents = [];
        this.selectedSidebearingHandle = null;
        this.selectedGuideHandle = null;
        this.hoveredPointIndex = null;
        this.hoveredAnchorIndex = null;
        this.hoveredComponentIndex = null;
        this.hoveredSidebearingHandle = null;
        this.hoveredGuideHandle = null;
        this.hoveredAddPointPreview = null;
        this.hoveredCommandCurvePreview = null;
        this.hoveredGlyphIndex = -1;
        this.glyphCanvas.updatePropertyPanel();
    }

    onEscapeKey(e: KeyboardEvent) {
        if (!this.active) return;

        // Check if editor view is focused
        const editorView = document.querySelector('#view-editor');
        const isEditorFocused =
            editorView && editorView.classList.contains('focused');

        if (!isEditorFocused) {
            return; // Don't handle Escape if editor view is not focused
        }

        // Priority -1: Exit stack preview mode if active (handled in glyph-canvas.ts)
        // This is checked before reaching here

        // Priority 0: Stop any active loop animations (play button sine waves)
        if (this.glyphCanvas.axesManager?.isLoopAnimating) {
            e.preventDefault();
            this.glyphCanvas.axesManager.stopAllLoopAnimations();
            return;
        }

        e.preventDefault();

        const previousState = this.escapeState.peek();

        console.log('Escape pressed. Previous state:', {
            layerId: previousState?.selectionId || null,
            settings: previousState?.variationSettings || null,
            componentStackDepth: this.getComponentDepth()
        });

        // Priority 1: If we have a saved previous state from slider interaction, restore it first
        // (This takes precedence over exiting component editing)
        // However, if the previous layer is the same as the current layer, skip restoration
        if (previousState) {
            // Check if we're already on the previous layer
            if (this.escapeState.matchesCurrent(this.selectedLayerId)) {
                console.log(
                    'Already on previous layer, clearing state and continuing to exit'
                );
                this.escapeState.clear();
                // Don't return - fall through to exit component or edit mode
            } else {
                console.log('Restoring previous layer by selecting it');

                // Get full layer data from font model
                const layerToSelect = this.getFullLayerData(
                    previousState.selectionId
                );

                if (layerToSelect) {
                    console.log('Found previous layer:', layerToSelect.id);
                    // Clear interpolating flag since we're transitioning to a real layer
                    this.isInterpolating = false;

                    // Clear previous state before calling selectLayer
                    // (selectLayer will also clear these, but we do it here to be explicit)
                    this.escapeState.clear();

                    // Imitate clicking on the layer in the list by calling selectLayer
                    // This will handle everything: fetch data, animate sliders, update UI
                    this.selectLayer(layerToSelect);
                    return;
                }

                // Fallback if layer not found - just clear state
                console.warn('Previous layer not found, clearing state');
                this.escapeState.clear();
            }
        }

        // Priority 2: Check if we're in component editing mode
        if (this.isEditingComponent()) {
            // Exit one level of component editing
            this.exitComponentEditing();
            return;
        }

        // Priority 3: No previous state and not in component - just exit edit mode
        this.glyphCanvas.exitGlyphEditMode();
    }

    restoreFocus() {
        // Only restore focus when in editor mode
        if (!this.active) return;
        // Use setTimeout to allow the click event to complete first
        // (e.g., slider interaction, button click)
        setTimeout(() => {
            this.canvas!.focus();
        }, 0);
    }

    onSliderMouseDown() {
        if (!this.active) return;
        // Remember if preview was already on (from keyboard toggle)
        this.previewModeBeforeSlider = this.isPreviewMode;

        // Capture anchor point BEFORE setting interpolating flag
        // This ensures correct bounding box is used for auto-panning
        this.captureAutoPanAnchor();

        // Set interpolating flag (don't change preview mode)
        this.isInterpolating = true;

        // If not in preview mode, mark current layer data as interpolated and render
        // to show monochrome visual feedback immediately
        if (!this.isPreviewMode && this.layerData) {
            this.layerData.isInterpolated = true;
            this.glyphCanvas.render();
        }
    }

    async onSliderMouseUp() {
        console.log('[OutlineEditor] onSliderMouseUp called', {
            active: this.active,
            isPreviewMode: this.isPreviewMode,
            isInterpolating: this.isInterpolating,
            selectedLayerId: this.selectedLayerId
        });
        if (this.active && this.isPreviewMode) {
            // Only exit preview mode if we entered it via slider
            // If it was already on (from keyboard), keep it on
            const shouldExitPreview = !this.previewModeBeforeSlider;

            if (shouldExitPreview) {
                this.isPreviewMode = false;
            }

            // Check if we're on an exact layer
            await this.autoSelectMatchingLayer();

            // Note: Don't clear isInterpolating here - let it stay true until animation completes
            // so auto-panning continues working. It will be cleared in animationComplete handler.
            fontInterpolation.resetRequestTracking();

            // If we landed on an exact layer, update the saved state to this new layer
            // so Escape will return here, not to the original layer
            if (this.selectedLayerId) {
                this.escapeState.sync(
                    this.selectedLayerId,
                    this.glyphCanvas.axesManager!.variationSettings
                );
                console.log('Updated previous state to new layer:', {
                    layerId: this.selectedLayerId,
                    settings: this.glyphCanvas.axesManager!.variationSettings
                });

                // Fetch layer data but skip render - we'll render after clearing flags
                await this.fetchLayerData(true);

                // Clear interpolating flag immediately since we're now on an exact layer
                // This ensures that if the user switches glyphs, the new glyph will properly
                // fetch its layer data in autoSelectMatchingLayer
                this.isInterpolating = false;
                this.autoPanAnchorScreen = null;
            } else if (this.layerData && this.layerData.isInterpolated) {
                // No exact layer match - keep interpolated data
                // Only restore if shapes are empty/missing
                if (
                    !this.layerData.shapes ||
                    this.layerData.shapes.length === 0
                ) {
                    await LayerDataNormalizer.restoreExactLayer(this);
                }

                // Still interpolating - only clear flags if animation is complete
                if (!this.glyphCanvas.axesManager!.isAnimating) {
                    this.isInterpolating = false;
                    this.autoPanAnchorScreen = null;
                }
            }

            // Always render to update colors after clearing isInterpolating flag
            this.glyphCanvas.render();
        } else if (this.active) {
            this.isPreviewMode = false;

            // Check if we're on an exact layer
            console.log(
                '[OutlineEditor] About to call autoSelectMatchingLayer from onSliderMouseUp (non-preview mode)'
            );
            await this.autoSelectMatchingLayer();
            console.log(
                '[OutlineEditor] After autoSelectMatchingLayer, selectedLayerId:',
                this.selectedLayerId
            );

            // Note: Don't clear isInterpolating here - let it stay true until animation completes
            // so auto-panning continues working. It will be cleared in animationComplete handler.
            fontInterpolation.resetRequestTracking();

            // If we landed on an exact layer, update the saved state to this new layer
            // so Escape will return here, not to the original layer
            if (this.selectedLayerId) {
                this.escapeState.sync(
                    this.selectedLayerId,
                    this.glyphCanvas.axesManager!.variationSettings
                );
                console.log('Updated previous state to new layer:', {
                    layerId: this.selectedLayerId,
                    settings: this.glyphCanvas.axesManager!.variationSettings
                });

                // Fetch layer data but skip render - we'll render after clearing flags
                await this.fetchLayerData(true);

                // Clear interpolating flag immediately since we're on an exact layer
                this.isInterpolating = false;
                this.autoPanAnchorScreen = null;
            }

            // If no exact layer match, keep showing interpolated data

            // Render with updated data and cleared flags
            this.glyphCanvas.render();
            // Restore focus to canvas
            setTimeout(() => this.canvas!.focus(), 0);
        }
    }

    // Real-time interpolation during slider movement
    // Skip interpolation if in preview mode (HarfBuzz handles interpolation)
    onSliderChange(axisTag: string, value: number) {
        console.log('[OutlineEditor] onSliderChange called', {
            axisTag,
            value,
            selectedLayerId: this.selectedLayerId,
            isInterpolating: this.isInterpolating,
            active: this.active
        });

        // Save current state before manual adjustment (only once per manual session)
        // When starting a new slider drag from a selected layer, save that layer
        // and deselect to enable interpolation mode
        if (this.selectedLayerId !== null) {
            // Only update previous state if we're starting a new drag session
            // (not continuing an existing interpolation session)
            if (
                this.escapeState.save(
                    this.selectedLayerId,
                    this.glyphCanvas.axesManager!.variationSettings
                )
            ) {
                console.log(
                    '[OutlineEditor] Saved previous state for Escape:',
                    {
                        layerId: this.selectedLayerId,
                        settings:
                            this.glyphCanvas.axesManager!.variationSettings
                    }
                );
            }
            this.selectedLayerId = null; // Deselect layer
            console.log(
                '[OutlineEditor] Deselected layer, selectedLayerId is now null'
            );
            // Always update layer selection UI when deselecting to show immediate visual feedback
            this.updateLayerSelection();
        }
        if (
            this.active &&
            this.isInterpolating &&
            !this.isPreviewMode &&
            this.currentGlyphName
        ) {
            console.log(
                '[OutlineEditor] Calling interpolateCurrentGlyph from onSliderChange'
            );
            this.interpolateCurrentGlyph();
        }
    }

    animationInProgress() {
        // Interpolate during both slider dragging AND layer switch animations
        console.log('[OutlineEditor] animationInProgress called:', {
            active: this.active,
            hasGlyphName: !!this.currentGlyphName,
            isInterpolating: this.isInterpolating,
            isLayerSwitchAnimating: this.isLayerSwitchAnimating
        });
        if (this.active && this.currentGlyphName) {
            if (this.isInterpolating || this.isLayerSwitchAnimating) {
                // Interpolate at current position for smooth animation
                console.log(
                    '[OutlineEditor] Calling interpolateCurrentGlyph from animationInProgress'
                );
                this.interpolateCurrentGlyph();
            }
        }
    }

    onDoubleClick(e: MouseEvent): boolean {
        console.log(
            '[OutlineEditor] Double-click detected. isGlyphEditMode:',
            this.active,
            'selectedLayerId:',
            this.selectedLayerId,
            'hoveredGlyphIndex:',
            this.hoveredGlyphIndex,
            'hoveredComponentIndex:',
            this.hoveredComponentIndex
        );

        // Stack preview mode: double-click enters component editing at hovered stack node.
        if (this.glyphCanvas.stackPreviewAnimator.shouldRenderStackPreview()) {
            if (this.glyphCanvas.stackPreviewAnimator.isInputBlocked()) {
                return true;
            }

            const hoveredLayerTreeIndex =
                this.glyphCanvas.stackPreviewAnimator.hoveredLayerTreeIndex;
            if (hoveredLayerTreeIndex === null) {
                return true;
            }

            const node =
                this.glyphCanvas.stackPreviewAnimator.layerTree[
                    hoveredLayerTreeIndex
                ];

            if (!node) {
                return true;
            }

            const componentPath = [...node.componentPath];
            this.glyphCanvas.stackPreviewAnimator.reverseAnimation(() => {
                void this.enterComponentEditingByPath(componentPath);
            }, componentPath);
            return true;
        }

        // If in edit mode with a component/point/anchor hovered, prioritize that over glyph switching
        if (this.active && this.layerData && !this.isPreviewMode) {
            // Double-click on component - enter component editing (without selecting it)
            if (this.hoveredComponentIndex !== null) {
                console.log(
                    '[OutlineEditor] Entering component editing for index:',
                    this.hoveredComponentIndex
                );
                // Ensure we have an actual layer selection for component editing.
                // This avoids requiring a manual click in the layer list first.
                void this.enterComponentEditingFromHover(
                    this.hoveredComponentIndex,
                    e
                );
                return true; // Event handled - skip single-click
            }
            // Double-click on point - toggle smooth for all selected points
            if (this.hoveredPointIndex) {
                this.togglePointSmoothSelection(
                    this.selectedPoints.length > 0
                        ? this.selectedPoints
                        : [this.hoveredPointIndex]
                );
                return true; // Event handled - skip single-click
            }

            if (
                this.hoveredGuideHandle === null &&
                this.hoveredSidebearingHandle === null &&
                this.hoveredComponentIndex === null &&
                this.hoveredAnchorIndex === null
            ) {
                const hoveredSegment = this.findClosestPathSegmentHit();
                if (
                    hoveredSegment &&
                    this.selectAllNodesInContour(hoveredSegment.shapeIndex)
                ) {
                    return true;
                }
            }
        }

        // Double-click on other glyph - switch to that glyph
        // Check this after edit mode interactions, but before checking selectedLayerId,
        // so it works even when interpolating
        if (this.hoveredGlyphIndex >= 0) {
            console.log(
                '[OutlineEditor] Double-clicking on glyph:',
                this.hoveredGlyphIndex
            );
            this.glyphCanvas.doubleClickOnGlyph(this.hoveredGlyphIndex);
            return true; // Event handled - skip single-click
        }

        return false; // Event not handled
    }

    onSingleClick(e: MouseEvent) {
        if (
            !this.active ||
            !this.selectedLayerId ||
            !this.layerData ||
            this.isPreviewMode
        )
            return;

        const selectedGlyphIndex =
            this.glyphCanvas.textRunEditor?.selectedGlyphIndex ?? -1;
        if (
            this.hoveredGlyphIndex >= 0 &&
            this.hoveredGlyphIndex !== selectedGlyphIndex
        ) {
            return;
        }

        const isCmdClick = (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;
        if (isCmdClick && this.hoveredAddPointPreview) {
            void this.commitHoveredAddPointPreview();
            return;
        }

        if (this.handleAltCurveConversionGesture(e)) {
            return;
        }

        if (this.handleCommandPathGesture(e)) {
            return;
        }

        if (this.hoveredGuideHandle) {
            this.selectedGuideHandle = { ...this.hoveredGuideHandle };
            this.selectedPoints = [];
            this.selectedAnchors = [];
            this.selectedComponents = [];
            this.selectedSidebearingHandle = null;
            this.isDraggingGuide = true;
            this._hasMoved = false;
            this._dragType = 'guide';
            this._preDragDesc = this._buildGuideDesc();
            window.changeBridge?.beginTransaction('Drag guide');
            this.glyphCanvas.lastMouseX = e.clientX;
            this.glyphCanvas.lastMouseY = e.clientY;
            this.lastGlyphX = null;
            this.lastGlyphY = null;
            this.glyphCanvas.updatePropertyPanel();
            this.glyphCanvas.render();
            return;
        }

        if (this.hoveredSidebearingHandle) {
            this.selectedGuideHandle = null;
            this.selectedSidebearingHandle = {
                ...this.hoveredSidebearingHandle
            };
            this.selectedPoints = [];
            this.selectedAnchors = [];
            this.selectedComponents = [];
            this.isDraggingSidebearing = true;
            console.log('[DRAG-DEBUG] Drag START: sidebearing drag begun');
            this._hasMoved = false;
            this._metricsKeyInteractionSide = null;
            this._dragType = 'sidebearing';
            const startingSidebearing = this.getCurrentDirectSidebearing(
                this.hoveredSidebearingHandle.side
            );
            this._preDragDesc =
                startingSidebearing === null
                    ? null
                    : formatSidebearingHistoryValue(
                          this.hoveredSidebearingHandle.side,
                          startingSidebearing
                      );
            window.changeBridge?.beginTransaction(
                getSidebearingTransactionLabel(
                    this.hoveredSidebearingHandle.side
                )
            );
            this.glyphCanvas.lastMouseX = e.clientX;
            this.glyphCanvas.lastMouseY = e.clientY;
            this.lastGlyphX = null;
            this.lastGlyphY = null;
            this.glyphCanvas.updatePropertyPanel();
            this.glyphCanvas.render();
            return;
        }

        // Check if clicking on a component first (components take priority)
        if (this.hoveredComponentIndex !== null) {
            this.selectedGuideHandle = null;
            this.selectedSidebearingHandle = null;
            if (e.shiftKey) {
                // Shift-click: add to or remove from selection (keep points and anchors for mixed selection)
                const existingIndex = this.selectedComponents.indexOf(
                    this.hoveredComponentIndex
                );
                if (existingIndex >= 0) {
                    this.selectedComponents.splice(existingIndex, 1);
                } else {
                    this.selectedComponents.push(this.hoveredComponentIndex);
                }
                this.glyphCanvas.updatePropertyPanel();
                this.glyphCanvas.render();
            } else {
                const isInSelection = this.selectedComponents.includes(
                    this.hoveredComponentIndex
                );

                if (!isInSelection) {
                    this.selectedComponents = [this.hoveredComponentIndex];
                    this.selectedPoints = [];
                    this.selectedAnchors = [];
                }
                // If already in selection, keep all selected components, points, and anchors

                this.isDraggingComponent = true;
                console.log('[DRAG-DEBUG] Drag START: component drag begun');
                this._hasMoved = false;
                this._metricsKeyInteractionSide = null;
                this._dragType = 'component';
                this._preDragDesc = this._buildComponentDesc();
                this._componentDragDeltaX = 0;
                window.changeBridge?.beginTransaction('Drag component');
                this.glyphCanvas.lastMouseX = e.clientX;
                this.glyphCanvas.lastMouseY = e.clientY;
                this.lastGlyphX = null;
                this.lastGlyphY = null;
                this.glyphCanvas.updatePropertyPanel();
                this.glyphCanvas.render();
            }
            return;
        }

        // Check if clicking on an anchor (anchors take priority over points)
        if (this.hoveredAnchorIndex !== null) {
            this.selectedGuideHandle = null;
            this.selectedSidebearingHandle = null;
            if (e.shiftKey) {
                // Shift-click: add to or remove from selection (keep points selected for mixed selection)
                const existingIndex = this.selectedAnchors.indexOf(
                    this.hoveredAnchorIndex
                );
                if (existingIndex >= 0) {
                    // Remove from selection
                    this.selectedAnchors.splice(existingIndex, 1);
                } else {
                    // Add to selection
                    this.selectedAnchors.push(this.hoveredAnchorIndex);
                }
                this.glyphCanvas.updatePropertyPanel();
                this.glyphCanvas.render();
            } else {
                // Check if clicked anchor is already in selection
                const isInSelection = this.selectedAnchors.includes(
                    this.hoveredAnchorIndex
                );

                if (!isInSelection) {
                    // Regular click on unselected anchor: select only this anchor, clear points
                    this.selectedAnchors = [this.hoveredAnchorIndex];
                    this.selectedPoints = []; // Clear point selection
                }
                // If already in selection, keep all selected anchors and points

                // Start dragging (all selected anchors and points)
                this.isDraggingAnchor = true;
                this._hasMoved = false;
                this._dragType = 'anchor';
                this._preDragDesc = this._buildAnchorDesc();
                window.changeBridge?.beginTransaction('Drag anchor');
                this.glyphCanvas.lastMouseX = e.clientX;
                this.glyphCanvas.lastMouseY = e.clientY;
                this.lastGlyphX = null; // Reset for delta calculation
                this.lastGlyphY = null;
                this.glyphCanvas.updatePropertyPanel();
                this.glyphCanvas.render();
            }
            return; // Don't start canvas panning
        }

        // Check if clicking on a point
        if (this.hoveredPointIndex) {
            this.selectedGuideHandle = null;
            this.selectedSidebearingHandle = null;
            const isCmdClick = e.metaKey || e.ctrlKey;
            if (
                isCmdClick &&
                !e.shiftKey &&
                this.canSlideSmoothPointOnCurve(this.hoveredPointIndex)
            ) {
                this.selectedPoints = [{ ...this.hoveredPointIndex }];
                this.selectedAnchors = [];
                this.selectedComponents = [];
                this.isDraggingPoint = true;
                this.isSlidingSmoothPointAlongCurve = true;
                console.log('[DRAG-DEBUG] Drag START: slide-point drag begun');
                this._hasMoved = false;
                this._metricsKeyInteractionSide = null;
                this._dragType = 'slide-point';
                this._preDragDesc = this._buildNodeDesc();
                window.changeBridge?.beginTransaction('Move point along curve');
                this.glyphCanvas.lastMouseX = e.clientX;
                this.glyphCanvas.lastMouseY = e.clientY;
                this.lastGlyphX = null;
                this.lastGlyphY = null;
                this.lastPointDragShiftKey = e.shiftKey;
                this._pointDragPreserveHandlePositions = false;
                this.glyphCanvas.updatePropertyPanel();
                this.glyphCanvas.render();
                return;
            }

            // Cmd+click on on-curve node of closed path: open path at that node
            if (isCmdClick && !e.shiftKey) {
                if (this.openClosedPathAtNode(this.hoveredPointIndex)) {
                    return;
                }
            }

            if (e.shiftKey) {
                // Shift-click: add to or remove from selection (keep anchors selected for mixed selection)
                const existingIndex = this.selectedPoints.findIndex(
                    (p) =>
                        p.contourIndex ===
                            this.hoveredPointIndex!.contourIndex &&
                        p.nodeIndex === this.hoveredPointIndex!.nodeIndex
                );
                if (existingIndex >= 0) {
                    // Remove from selection
                    this.selectedPoints.splice(existingIndex, 1);
                } else {
                    // Add to selection
                    this.selectedPoints.push({ ...this.hoveredPointIndex });
                }
                this.glyphCanvas.updatePropertyPanel();
                this.glyphCanvas.render();
            } else {
                // Check if clicked point is already in selection
                const isInSelection = this.selectedPoints.some(
                    (p) =>
                        p.contourIndex ===
                            this.hoveredPointIndex!.contourIndex &&
                        p.nodeIndex === this.hoveredPointIndex!.nodeIndex
                );

                if (!isInSelection) {
                    // Regular click on unselected point: select only this point, clear anchors
                    this.selectedPoints = [{ ...this.hoveredPointIndex }];
                    this.selectedAnchors = []; // Clear anchor selection
                }
                // If already in selection, keep all selected points and anchors

                // Start dragging (all selected points and anchors)
                this.isDraggingPoint = true;
                console.log('[DRAG-DEBUG] Drag START: point drag begun');
                this._hasMoved = false;
                this._metricsKeyInteractionSide = null;
                this._dragType = 'point';
                this._dragStartEndpointsCoincident =
                    this._areOpenPathEndpointsCoincident();
                this._preDragDesc = this._buildNodeDesc();
                this._pointDragDeltaX = 0;
                window.changeBridge?.beginTransaction('Drag point');
                this.glyphCanvas.lastMouseX = e.clientX;
                this.glyphCanvas.lastMouseY = e.clientY;
                this.lastGlyphX = null; // Reset for delta calculation
                this.lastGlyphY = null;
                this.lastPointDragShiftKey = e.shiftKey;
                this._pointDragPreserveHandlePositions = e.altKey;
                this.glyphCanvas.updatePropertyPanel();
                this.glyphCanvas.render();
            }
            return; // Don't start canvas panning
        }

        this.beginMarqueeSelection(e);
    }

    private async ensureLayerSelectedForEditing(): Promise<boolean> {
        if (this.selectedLayerId) {
            return true;
        }

        await this.autoSelectMatchingLayer();
        if (this.selectedLayerId) {
            return true;
        }

        const sortedLayers = this.glyphCanvas.getSortedLayers();
        if (sortedLayers.length === 0) {
            return false;
        }

        const fallbackLayer = this.getFullLayerData(sortedLayers[0].id);
        if (!fallbackLayer) {
            return false;
        }

        await this.selectLayer(fallbackLayer);
        return !!this.selectedLayerId;
    }

    private async enterComponentEditingFromHover(
        componentIndex: number,
        e: MouseEvent | null
    ): Promise<void> {
        const hasLayer = await this.ensureLayerSelectedForEditing();
        if (!hasLayer) {
            console.warn(
                '[OutlineEditor] Cannot enter component editing: no selectable layer available'
            );
            return;
        }

        this.selectedComponents = [];
        await this.enterComponentEditing(componentIndex, false, e);
    }

    private async enterComponentEditingByPath(
        componentPath: number[]
    ): Promise<void> {
        const hasLayer = await this.ensureLayerSelectedForEditing();
        if (!hasLayer) {
            console.warn(
                '[OutlineEditor] Cannot enter component editing path: no selectable layer available'
            );
            return;
        }

        if (componentPath.length === 0) {
            this.exitAllComponentEditing();
            this.clearAllSelections();
            this.currentGlyphName = this.glyphCanvas.getCurrentGlyphName();
            this.glyphCanvas.updateComponentBreadcrumb();
            await this.glyphCanvas.updatePropertiesUI();
            this.glyphCanvas.render();
            return;
        }

        this.exitAllComponentEditing();
        this.selectedComponents = [];

        for (let i = 0; i < componentPath.length; i++) {
            const depthBefore = this.getComponentDepth();
            const skipUIUpdate = i < componentPath.length - 1;
            await this.enterComponentEditing(
                componentPath[i],
                skipUIUpdate,
                null
            );

            // Abort if path navigation failed at this depth.
            if (this.getComponentDepth() === depthBefore) {
                console.warn(
                    '[OutlineEditor] Failed to enter component path at depth',
                    i,
                    'componentIndex:',
                    componentPath[i]
                );
                break;
            }
        }
    }

    /**
     * Collect on-curve node positions as snap candidates.
     *
     * Returns positions in **active-glyph-local** coordinates:
     * - Nodes from the active glyph's current edited layer (all, or minus dragged when excludeDraggedPoints=true)
     * - Nodes from the directly adjacent left/right glyphs in the text run (offset to active-glyph space)
     *
     * @param excludeDraggedPoints - when true, skip the currently-selected (dragged) nodes
     */
    private _collectOnCurveCandidatesFromShapes(
        shapes: Babelfont.Shape[] | undefined,
        source: SnapCandidate['source'],
        parentTransform: Transform = [1, 0, 0, 1, 0, 0],
        masterId: string | null | undefined = null,
        fontModel: any = (window as any).currentFontModel
    ): SnapCandidate[] {
        fontModel = fontModel || fontManager.currentFont?.fontModel;

        if (!shapes?.length) {
            return [];
        }

        const candidates: SnapCandidate[] = [];

        for (const shape of shapes) {
            const componentData = getComponentShapeData(shape);
            if (
                componentData &&
                typeof componentData === 'object' &&
                'reference' in componentData
            ) {
                const nestedTransformRaw = componentData.transform || [
                    1, 0, 0, 1, 0, 0
                ];
                const nestedTransform = Array.isArray(nestedTransformRaw)
                    ? nestedTransformRaw
                    : DecomposedAffineTransform.toAffine(nestedTransformRaw);
                const combinedTransform: Transform = [
                    parentTransform[0] * nestedTransform[0] +
                        parentTransform[2] * nestedTransform[1],
                    parentTransform[1] * nestedTransform[0] +
                        parentTransform[3] * nestedTransform[1],
                    parentTransform[0] * nestedTransform[2] +
                        parentTransform[2] * nestedTransform[3],
                    parentTransform[1] * nestedTransform[2] +
                        parentTransform[3] * nestedTransform[3],
                    parentTransform[0] * nestedTransform[4] +
                        parentTransform[2] * nestedTransform[5] +
                        parentTransform[4],
                    parentTransform[1] * nestedTransform[4] +
                        parentTransform[3] * nestedTransform[5] +
                        parentTransform[5]
                ];

                let componentShapes = componentData.layerData?.shapes;
                if (!componentShapes && fontModel && componentData.reference) {
                    const componentGlyph = fontModel.findGlyph(
                        componentData.reference
                    );
                    if (componentGlyph?.layers?.length) {
                        const componentLayer =
                            (masterId && componentGlyph.findLayerByMasterId
                                ? componentGlyph.findLayerByMasterId(masterId)
                                : undefined) ||
                            (masterId
                                ? componentGlyph.layers.find(
                                      (candidate: any) =>
                                          candidate.master?.master === masterId
                                  )
                                : undefined) ||
                            componentGlyph.layers[0];
                        componentShapes = componentLayer?.shapes;
                    }
                }

                candidates.push(
                    ...this._collectOnCurveCandidatesFromShapes(
                        componentShapes,
                        source,
                        combinedTransform,
                        masterId,
                        fontModel
                    )
                );
                continue;
            }

            const contour = getEditableContour(shape);
            if (!contour) {
                continue;
            }

            for (const node of contour.nodes) {
                if (!isOnCurveNode(node)) {
                    continue;
                }
                const point = transformPoint(node.x, node.y, parentTransform);
                candidates.push({ x: point.x, y: point.y, source });
            }
        }

        return candidates;
    }

    private _getBufferedAdjacentSnapCandidates(
        glyphIndex: number,
        source: 'left' | 'right',
        activeWorldX: number,
        activeWorldY: number,
        masterId: string | null | undefined
    ): SnapCandidate[] {
        const tre = this.glyphCanvas.textRunEditor;
        if (!tre || glyphIndex < 0 || glyphIndex >= tre.shapedGlyphs.length) {
            return [];
        }

        const glyphPosition = tre._getGlyphPosition(glyphIndex);
        const offsetX =
            glyphPosition.xPosition + glyphPosition.xOffset - activeWorldX;
        const offsetY = glyphPosition.yOffset - activeWorldY;
        const shapedGlyph = tre.shapedGlyphs[glyphIndex];
        const fontModel =
            fontManager.currentFont?.fontModel ||
            (window as any).currentFontModel;

        const explicitGlyphName = shapedGlyph.explicitGlyphName;
        if (explicitGlyphName && shapedGlyph.g === 0) {
            const explicitOutline =
                tre.getCachedExplicitGlyphOutline(explicitGlyphName);
            if (explicitOutline?.shapes?.length) {
                return this._collectOnCurveCandidatesFromShapes(
                    explicitOutline.shapes as Babelfont.Shape[],
                    source,
                    [1, 0, 0, 1, offsetX, offsetY],
                    masterId,
                    fontModel
                );
            }
        }

        const glyphName =
            explicitGlyphName || tre.glyphNameBuffer[glyphIndex] || null;
        const glyphWrapper = glyphName ? fontModel?.findGlyph(glyphName) : null;
        if (!glyphWrapper?.layers?.length) {
            return [];
        }

        const layer =
            (masterId && glyphWrapper.findLayerByMasterId
                ? glyphWrapper.findLayerByMasterId(masterId)
                : undefined) ||
            (masterId
                ? glyphWrapper.layers.find(
                      (candidate: any) => candidate.master?.master === masterId
                  )
                : undefined) ||
            glyphWrapper.layers[0];

        return this._collectOnCurveCandidatesFromShapes(
            layer?.shapes,
            source,
            [1, 0, 0, 1, offsetX, offsetY],
            masterId,
            fontModel
        );
    }

    collectDebugSnapCandidates(): SnapCandidate[] {
        // Show only during active on-curve point drag; use cached data only.
        if (
            !this.isDraggingPoint ||
            this.isSlidingSmoothPointAlongCurve ||
            !this._snapCandidateCache
        ) {
            return [];
        }
        // Filter out active-glyph nodes: they are identical to the visible
        // node handles already drawn by the outline editor.
        return this._snapCandidateCache.debugCandidates.filter(
            (c) => c.source !== 'active'
        );
    }

    private _buildSnapCandidateCache(anchor: {
        x: number;
        y: number;
    }): SnapCandidateCache {
        const distFn = (c: SnapCandidate) =>
            Math.hypot(c.x - anchor.x, c.y - anchor.y);
        const sortByDist = (arr: SnapCandidate[]) =>
            arr.sort((a, b) => distFn(a) - distFn(b));

        // Origin: always first so snapping back to start is never blocked.
        const originCandidate: SnapCandidate = {
            x: anchor.x,
            y: anchor.y,
            source: 'origin'
        };

        // Active glyph on-curve nodes (split into dragged vs non-dragged)
        const draggedKeys = new Set(
            this.selectedPoints.map((p) => `${p.contourIndex}:${p.nodeIndex}`)
        );
        const activeNonDragged: SnapCandidate[] = [];
        const activeDragged: SnapCandidate[] = [];

        const activeLayerData = this.getCurrentLayerDataFromStack();
        if (activeLayerData?.shapes) {
            activeLayerData.shapes.forEach((shape, ci) => {
                const contour = getEditableContour(shape);
                if (!contour) return;
                contour.nodes.forEach((node, ni) => {
                    if (!isOnCurveNode(node)) return;
                    const c: SnapCandidate = {
                        x: node.x,
                        y: node.y,
                        source: 'active'
                    };
                    if (draggedKeys.has(`${ci}:${ni}`)) {
                        activeDragged.push(c);
                    } else {
                        activeNonDragged.push(c);
                    }
                });
            });
        }
        sortByDist(activeNonDragged);

        // Neighbor candidates (left + right adjacent glyphs)
        const leftCandidates: SnapCandidate[] = [];
        const rightCandidates: SnapCandidate[] = [];
        const tre = this.glyphCanvas.textRunEditor;
        const fontModel =
            fontManager.currentFont?.fontModel ||
            (window as any).currentFontModel;
        if (tre && tre.selectedGlyphIndex >= 0 && fontModel) {
            const idx = tre.selectedGlyphIndex;
            const masterId =
                this.getCurrentLayerModel()?.master?.master ||
                tre.selectedMasterId ||
                fontModel.masters?.[0]?.id;
            const activePos = tre._getGlyphPosition(idx);
            const wx = activePos.xPosition + activePos.xOffset;
            const wy = activePos.yOffset;
            for (const adjIdx of [idx - 1, idx + 1]) {
                if (adjIdx < 0 || adjIdx >= tre.shapedGlyphs.length) continue;
                const bucket = adjIdx < idx ? leftCandidates : rightCandidates;
                bucket.push(
                    ...this._getBufferedAdjacentSnapCandidates(
                        adjIdx,
                        adjIdx < idx ? 'left' : 'right',
                        wx,
                        wy,
                        masterId
                    )
                );
            }
        }
        sortByDist(leftCandidates);
        sortByDist(rightCandidates);

        // Assemble the three pre-sorted arrays by concatenating sorted blocks.
        // Origin always first; then active (non-dragged); then left; then right.
        const activeOnlyDragCandidates = [originCandidate, ...activeNonDragged];
        const allDragCandidates = [
            originCandidate,
            ...activeNonDragged,
            ...leftCandidates,
            ...rightCandidates
        ];
        // Debug includes ALL active nodes (including dragged ones) + neighbors
        const debugCandidates = [
            originCandidate,
            ...activeNonDragged,
            ...activeDragged,
            ...leftCandidates,
            ...rightCandidates
        ];

        const scale = this.glyphCanvas.viewportManager?.scale || 1;
        const snapDistFontUnits =
            APP_SETTINGS.OUTLINE_EDITOR.SNAP_DISTANCE_PX / scale;
        const metricsYValues = getVisibleVerticalMetricValues(
            this.renderVerticalMetrics
        );

        return {
            activeOnlyDragCandidates,
            allDragCandidates,
            debugCandidates,
            snapDistFontUnits,
            metricsYValues
        };
    }

    private _rebuildSnapCandidateCache(): void {
        if (!this._snapDragStartNodePos) {
            this._snapCandidateCache = null;
            return;
        }

        this._snapCandidateCache = this._buildSnapCandidateCache(
            this._snapDragStartNodePos
        );
    }

    /**
     * Shift all snap candidate X coordinates (except left-neighbor candidates)
     * by deltaX. Called after a keyed-LSB compensation shifts active-glyph
     * geometry and advances the right neighbor's world position, so that
     * cached snap candidates stay visually aligned with the geometry.
     */
    private _shiftSnapCandidateCacheX(
        deltaX: number,
        onlySource?: SnapCandidate['source']
    ): void {
        if (!this._snapCandidateCache) return;
        // debugCandidates is the union of all three candidate arrays.
        // Candidates are shared by reference across arrays, so iterating only
        // debugCandidates shifts each unique object exactly once.
        for (const c of this._snapCandidateCache.debugCandidates) {
            if (
                onlySource !== undefined
                    ? c.source === onlySource
                    : c.source !== 'left'
            ) {
                c.x += deltaX;
            }
        }
    }

    private _getAdjacentSnapCandidateWidthDeltas(
        glyphAdvances: Record<string, number>
    ): Partial<Record<'left' | 'right', number>> {
        const textRunEditor = this.glyphCanvas.textRunEditor;
        if (
            !textRunEditor ||
            !Array.isArray(textRunEditor.shapedGlyphs) ||
            textRunEditor.selectedGlyphIndex < 0
        ) {
            return {};
        }

        const deltas: Partial<Record<'left' | 'right', number>> = {};
        const selectedGlyphIndex = textRunEditor.selectedGlyphIndex;
        const resolveGlyphName = (glyphIndex: number): string | null => {
            const shapedGlyph = textRunEditor.shapedGlyphs[glyphIndex];
            return (
                shapedGlyph?.explicitGlyphName ||
                textRunEditor.glyphNameBuffer?.[glyphIndex] ||
                null
            );
        };

        for (const [source, glyphIndex] of [
            ['left', selectedGlyphIndex - 1],
            ['right', selectedGlyphIndex + 1]
        ] as const) {
            if (
                glyphIndex < 0 ||
                glyphIndex >= textRunEditor.shapedGlyphs.length
            ) {
                continue;
            }

            const glyphName = resolveGlyphName(glyphIndex);
            if (!glyphName || !(glyphName in glyphAdvances)) {
                continue;
            }

            const previousAdvance = Number(
                textRunEditor.shapedGlyphs[glyphIndex]?.ax
            );
            const nextAdvance = Number(glyphAdvances[glyphName]);
            if (
                !Number.isFinite(previousAdvance) ||
                !Number.isFinite(nextAdvance)
            ) {
                continue;
            }

            const delta = nextAdvance - previousAdvance;
            if (Math.abs(delta) > 0.01) {
                deltas[source] = delta;
            }
        }

        return deltas;
    }

    /**
     * Whether to include neighboring glyphs' nodes in H/V axis snapping.
     * XY exact-node snapping always includes neighbors.
     * H/V axis snapping (aligning to a single coordinate) only includes
     * neighbors when Alt is held after the drag started.
     */
    private _shouldIncludeNeighborAxisSnap(): boolean {
        return (
            this.isDraggingPoint &&
            !this.isSlidingSmoothPointAlongCurve &&
            !this._pointDragPreserveHandlePositions &&
            this.altKeyPressed
        );
    }

    /**
     * Return the position of the first selected on-curve node from the
     * current live layer data, or null if none is available.
     */
    private _getPrimaryDragNodePos(): { x: number; y: number } | null {
        const currentLayerData = this.getCurrentLayerDataFromStack();
        if (!currentLayerData?.shapes) return null;
        for (const { contourIndex, nodeIndex } of this.selectedPoints) {
            const contour = getEditableContour(
                currentLayerData.shapes[contourIndex]
            );
            const node = contour?.nodes[nodeIndex];
            if (node && isOnCurveNode(node)) {
                return { x: node.x, y: node.y };
            }
        }
        return null;
    }

    /**
     * Compute snap-adjusted deltas for a point drag frame.
     *
     * Uses the absolute offset from drag-start (tracked with _snapDragStart*)
     * to determine the "natural" target position and then checks whether any
     * snap candidate is within the pre-computed snap distance.  Sets
     * this.activeSnapTarget and this.snapDraggedNaturalPos as side-effects.
     *
     * @param primaryNodeX Current X of the primary dragged node
     * @param primaryNodeY Current Y of the primary dragged node
     */
    private _applySnapToDelta(
        rawDeltaX: number,
        rawDeltaY: number,
        glyphX: number,
        glyphY: number,
        primaryNodeX: number,
        primaryNodeY: number
    ): { deltaX: number; deltaY: number } {
        if (
            !this._snapCandidateCache ||
            !this._snapDragStartNodePos ||
            this._snapDragStartMouseX === null ||
            this._snapDragStartMouseY === null
        ) {
            this.activeSnapTarget = null;
            this.snapDraggedNaturalPos = null;
            return { deltaX: rawDeltaX, deltaY: rawDeltaY };
        }

        // Natural (unsnapped) target using cumulative offset from drag start –
        // avoids error accumulation from per-frame snapped deltas
        const naturalX =
            this._snapDragStartNodePos.x +
            Math.round(glyphX) -
            Math.round(this._snapDragStartMouseX);
        const naturalY =
            this._snapDragStartNodePos.y +
            Math.round(glyphY) -
            Math.round(this._snapDragStartMouseY);

        this.snapDraggedNaturalPos = { x: naturalX, y: naturalY };

        const snapDist = this._snapCandidateCache.snapDistFontUnits;

        // Single-pass scan: find the nearest XY exact point snap AND the
        // best independent X/Y axis snaps in one loop over all candidates.
        // allDragCandidates is a superset of activeOnlyDragCandidates;
        // neighbors are always eligible for XY exact snap but only for
        // axis snap when Alt is held.
        const allCandidates = this._snapCandidateCache.allDragCandidates;
        const includeNeighborAxis = this._shouldIncludeNeighborAxisSnap();
        let bestSnapPoint: SnapCandidate | null = null;
        let bestSnapPointDist = Number.POSITIVE_INFINITY;
        let bestSnapXCandidate: SnapCandidate | null = null;
        let bestSnapX: number | null = null;
        let bestDistX = snapDist;
        let bestSnapYCandidate: SnapCandidate | null = null;
        let bestSnapY: number | null = null;
        let bestDistY = snapDist;

        for (const candidate of allCandidates) {
            const distX = Math.abs(naturalX - candidate.x);
            const distY = Math.abs(naturalY - candidate.y);

            // XY exact point snap: both axes within threshold simultaneously
            if (distX <= snapDist && distY <= snapDist) {
                const pointDist = Math.hypot(distX, distY);
                if (pointDist < bestSnapPointDist) {
                    bestSnapPointDist = pointDist;
                    bestSnapPoint = candidate;
                }
            }

            // Independent axis snap: neighbors only when Alt is held
            const isNeighbor =
                candidate.source === 'left' || candidate.source === 'right';
            if (!isNeighbor || includeNeighborAxis) {
                if (distX < bestDistX) {
                    bestDistX = distX;
                    bestSnapX = candidate.x;
                    bestSnapXCandidate = candidate;
                }
                if (distY < bestDistY) {
                    bestDistY = distY;
                    bestSnapY = candidate.y;
                    bestSnapYCandidate = candidate;
                }
            }
        }

        // Pass 3: Vertical metrics Y snap — always active.
        // When a metric Y wins:
        //   - If the node is also within snapDist of the drag-start X (origin),
        //     lock both axes to (originX, metricY) so the node can't drift
        //     sideways while landing on the metric line.
        //   - If the node has moved far enough sideways, only lock Y to the
        //     metric line so the node can slide freely along it.
        for (const metricY of this._snapCandidateCache.metricsYValues) {
            const distY = Math.abs(naturalY - metricY);
            if (distY < bestDistY) {
                bestDistY = distY;
                bestSnapY = metricY;
                const originX = this._snapDragStartNodePos.x;
                const distXFromOrigin = Math.abs(naturalX - originX);
                if (distXFromOrigin <= snapDist) {
                    // Within origin X range: lock both to (originX, metricY)
                    const metricCandidate: SnapCandidate = {
                        x: originX,
                        y: metricY,
                        source: 'metric'
                    };
                    bestSnapYCandidate = metricCandidate;
                    bestSnapX = originX;
                    bestSnapXCandidate = metricCandidate;
                    bestDistX = distXFromOrigin;
                } else {
                    // Sideways of origin: only lock Y, slide freely along the
                    // metric line. The metricCandidate X follows naturalX so
                    // the snap guide draws vertically from the dragged point.
                    const metricCandidate: SnapCandidate = {
                        x: naturalX,
                        y: metricY,
                        source: 'metric'
                    };
                    bestSnapYCandidate = metricCandidate;
                }
            }
        }

        // Resolve final snapped position and per-axis sources.
        // XY exact snap wins over independent axis snaps when both are active
        // on the same axis, because it locks both axes to a single node.
        //
        // Baseline always uses the cumulative natural position rather than the
        // per-frame raw delta.  For normal drags these are equivalent, but when
        // a keyed metrics-key compensation pans the viewport between frames the
        // raw delta becomes zero (the pan absorbs the mouse movement in screen
        // space).  The cumulative formula is immune to that because it works
        // from the fixed drag-start origin and is unaffected by viewport shifts.
        let adjustedDeltaX = naturalX - primaryNodeX;
        let adjustedDeltaY = naturalY - primaryNodeY;
        let finalSnapX = naturalX;
        let finalSnapY = naturalY;
        let xSource: SnapCandidate | null = null;
        let ySource: SnapCandidate | null = null;

        if (bestSnapPoint) {
            // Exact XY point snap: both axes lock to the same node.
            // Individual axis snaps may still override if they are closer
            // on their respective axis.
            const useExactX =
                !bestSnapXCandidate ||
                Math.abs(naturalX - bestSnapPoint.x) <= bestDistX;
            const useExactY =
                !bestSnapYCandidate ||
                Math.abs(naturalY - bestSnapPoint.y) <= bestDistY;
            xSource = useExactX ? bestSnapPoint : bestSnapXCandidate;
            ySource = useExactY ? bestSnapPoint : bestSnapYCandidate;
            finalSnapX = xSource ? xSource.x : naturalX;
            finalSnapY = ySource ? ySource.y : naturalY;
            // If axis snap beat the exact snap on one axis, override
            if (!useExactX && bestSnapXCandidate) {
                finalSnapX = bestSnapX!;
            }
            if (!useExactY && bestSnapYCandidate) {
                finalSnapY = bestSnapY!;
            }
        } else {
            // Independent axis snaps (different sources allowed on X and Y).
            if (bestSnapX !== null) {
                finalSnapX = bestSnapX;
                xSource = bestSnapXCandidate;
            }
            if (bestSnapY !== null) {
                finalSnapY = bestSnapY;
                ySource = bestSnapYCandidate;
            }
        }

        if (xSource) adjustedDeltaX = finalSnapX - primaryNodeX;
        if (ySource) adjustedDeltaY = finalSnapY - primaryNodeY;

        this.activeSnapTarget =
            xSource || ySource
                ? {
                      xSource,
                      ySource,
                      snappedX: finalSnapX,
                      snappedY: finalSnapY
                  }
                : null;

        return { deltaX: adjustedDeltaX, deltaY: adjustedDeltaY };
    }

    onMouseMove(e: MouseEvent) {
        if (this.isMarqueeSelecting) {
            const rect = this.canvas!.getBoundingClientRect();
            this.glyphCanvas.mouseX = e.clientX - rect.left;
            this.glyphCanvas.mouseY = e.clientY - rect.top;
            const { glyphX, glyphY } = this.transformMouseToComponentSpace();
            this.marqueeSelectionCurrent = { glyphX, glyphY };
            this.updateMarqueeSelection();
            this.glyphCanvas.render();
            return;
        }

        // Handle component, anchor, or point dragging in outline editor
        if (
            (this.isDraggingGuide && this.selectedGuideHandle !== null) ||
            (this.isDraggingComponent && this.selectedComponents.length > 0) ||
            (this.isDraggingAnchor && this.selectedAnchors.length > 0) ||
            (this.isDraggingSidebearing && this.selectedSidebearingHandle) ||
            (this.isDraggingPoint && this.selectedPoints.length > 0)
        ) {
            if (this.layerData) {
                this._handleDrag(e);
            }
            return;
        }
    }

    _handleDrag(e: MouseEvent): void {
        const rect = this.canvas!.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        // Update glyphCanvas mouse coordinates so transformMouseToComponentSpace() uses current position
        this.glyphCanvas.mouseX = mouseX;
        this.glyphCanvas.mouseY = mouseY;

        const { glyphX, glyphY } = this.isDraggingGuide
            ? this.transformMouseToRootSpace()
            : this.transformMouseToComponentSpace();

        let previousGlyphX = this.lastGlyphX;
        let previousGlyphY = this.lastGlyphY;
        if (
            this.isDraggingPoint &&
            this.selectedPoints.length === 1 &&
            this.lastPointDragShiftKey !== null &&
            this.lastPointDragShiftKey !== e.shiftKey
        ) {
            const currentLayerData = this.getCurrentLayerDataFromStack();
            const { contourIndex, nodeIndex } = this.selectedPoints[0];
            const contour = getEditableContour(
                currentLayerData?.shapes?.[contourIndex]
            );
            const node = contour?.nodes[nodeIndex];

            if (node) {
                previousGlyphX = node.x;
                previousGlyphY = node.y;
            }
        }

        // Calculate delta from last position
        const deltaX =
            Math.round(glyphX) - Math.round(previousGlyphX ?? glyphX);
        const deltaY =
            Math.round(glyphY) - Math.round(previousGlyphY ?? glyphY);

        this.lastGlyphX = glyphX;
        this.lastGlyphY = glyphY;
        if (this.isDraggingPoint) {
            this.lastPointDragShiftKey = e.shiftKey;
        }

        // Initialize snap drag-start state on the first genuine drag frame
        // (previousGlyphX === null means no movement has been applied yet)
        if (
            this.isDraggingPoint &&
            !this.isSlidingSmoothPointAlongCurve &&
            previousGlyphX === null
        ) {
            this._snapDragStartMouseX = glyphX;
            this._snapDragStartMouseY = glyphY;
            this._snapDragStartNodePos = this._getPrimaryDragNodePos();
            this._rebuildSnapCandidateCache();
        }

        // Apply node snapping when dragging on-curve points (not sliding smooth points)
        let effectiveDeltaX = deltaX;
        let effectiveDeltaY = this.isDraggingSidebearing ? 0 : deltaY;

        if (
            this.isDraggingPoint &&
            !this.isSlidingSmoothPointAlongCurve &&
            this.selectedPoints.length > 0
        ) {
            // Read primary node position once for this frame (avoids a
            // redundant getCurrentLayerDataFromStack inside _applySnapToDelta)
            const primaryPos = this._getPrimaryDragNodePos();
            const snapped = this._applySnapToDelta(
                deltaX,
                deltaY,
                glyphX,
                glyphY,
                primaryPos?.x ?? glyphX,
                primaryPos?.y ?? glyphY
            );
            effectiveDeltaX = snapped.deltaX;
            effectiveDeltaY = this.isDraggingSidebearing ? 0 : snapped.deltaY;
        } else {
            this.activeSnapTarget = null;
            this.snapDraggedNaturalPos = null;
            this._snapCandidateCache = null;
        }

        // Track whether any actual movement occurred (to avoid spurious undo entries)
        if (effectiveDeltaX !== 0 || effectiveDeltaY !== 0) {
            this._hasMoved = true;
        }

        // Update all selected items
        this._updateDraggedGuide(deltaX, deltaY);
        this._updateDraggedComponents(deltaX, deltaY);
        if (this.isSlidingSmoothPointAlongCurve) {
            if (this.slideSelectedSmoothPointAlongCurve(glyphX, glyphY)) {
                this._hasMoved = true;
            }
        } else {
            this._updateDraggedPoints(
                effectiveDeltaX,
                effectiveDeltaY,
                this._pointDragPreserveHandlePositions,
                e.shiftKey,
                glyphX,
                glyphY
            );
            this.updatePointDragDeltaX(effectiveDeltaX);
            this._checkOpenPathEndpointSnap();
        }
        this._updateDraggedAnchors(deltaX, deltaY);
        this._updateDraggedSidebearing(effectiveDeltaX);

        if (this.isDraggingComponent) {
            const metricsResult = this.applyMetricsKeysToCurrentEditedLayer();
            if (metricsResult) {
                this.updateComponentDragDeltaX(deltaX);
            }
        } else if (
            this.isDraggingPoint &&
            !this.isSlidingSmoothPointAlongCurve
        ) {
            this.applyMetricsKeysToCurrentEditedLayer();
        }

        // After metrics key recomputation, the viewport may have been
        // re-anchored to keep the bbox center fixed on screen. Recalculate
        // lastGlyphX/Y so the next frame's delta purely reflects mouse movement.
        if (
            (this.isDraggingComponent || this.isDraggingPoint) &&
            this._metricsKeyEditedSide !== null
        ) {
            const recalc = this.isDraggingGuide
                ? this.transformMouseToRootSpace()
                : this.transformMouseToComponentSpace();
            this.lastGlyphX = recalc.glyphX;
            this.lastGlyphY = recalc.glyphY;
        }

        // Throttle saveLayerData during drag (every 50ms) — final save on mouseUp
        const now = performance.now();
        if (this.isDraggingGuide) {
            if (this.selectedGuideHandle?.scope === 'layer') {
                this.saveLayerData('mouse-drag-guide');
            }
        } else if (this.isSlidingSmoothPointAlongCurve) {
            // Sliding a smooth point is applied directly to the model so linked
            // layers stay in sync. Persist once on mouse up.
        } else {
            if (now - this._lastDragSaveTime >= 50) {
                this._lastDragSaveTime = now;
                const dragChangeSource = this.isDraggingAnchor
                    ? 'mouse-drag-anchor'
                    : 'mouse-drag-outline';
                this.saveLayerData(dragChangeSource);
            }
        }

        // Throttle property panel DOM updates during drag (every 100ms)
        if (now - this._lastPropertyPanelUpdateTime >= 100) {
            this._lastPropertyPanelUpdateTime = now;
            this.glyphCanvas.updatePropertyPanel();
        }
        this.glyphCanvas.render();
    }

    _updateDraggedGuide(deltaX: number, deltaY: number): void {
        if (!this.isDraggingGuide || !this.selectedGuideHandle) {
            return;
        }

        if (this.selectedGuideHandle.scope === 'layer') {
            const accumulatedTransform = this.getAccumulatedTransform();
            const { localDeltaX, localDeltaY } =
                this.transformRootDeltaToGuideSpace(
                    deltaX,
                    deltaY,
                    accumulatedTransform
                );
            const currentLayerData = this.getCurrentLayerDataFromStack();
            const currentLayerModel = this.getCurrentLayerModel();
            const modelGuide =
                currentLayerModel?.guides?.[this.selectedGuideHandle.index];
            if (!modelGuide?.pos) {
                return;
            }

            modelGuide.pos.x += localDeltaX;
            modelGuide.pos.y += localDeltaY;

            if (currentLayerData) {
                if (!currentLayerData.guides) {
                    currentLayerData.guides = currentLayerModel?.guides?.map(
                        (guide: any) => ({
                            pos: {
                                x: guide.pos.x,
                                y: guide.pos.y,
                                angle: guide.pos.angle
                            },
                            ...(guide.name && { name: guide.name }),
                            ...(guide.color && { color: guide.color })
                        })
                    );
                }

                const dataGuide =
                    currentLayerData.guides?.[this.selectedGuideHandle.index];
                if (dataGuide?.pos) {
                    dataGuide.pos.x = modelGuide.pos.x;
                    dataGuide.pos.y = modelGuide.pos.y;
                    dataGuide.pos.angle = modelGuide.pos.angle;
                }
            }
            return;
        }

        const master = this.getRootMasterModel();
        const guide = master?.guides?.[this.selectedGuideHandle.index];
        if (!guide?.pos) {
            return;
        }

        guide.pos.x += deltaX;
        guide.pos.y += deltaY;
    }

    _updateDraggedPoints(
        deltaX: number,
        deltaY: number,
        preserveHandlePositions: boolean = false,
        snapSmoothHandleTriplet: boolean = false,
        pointerX?: number,
        pointerY?: number
    ): void {
        const currentLayerData = this.getCurrentLayerDataFromStack();
        if (!currentLayerData || !currentLayerData.shapes) return;

        this.applySelectedPointMove(
            currentLayerData,
            deltaX,
            deltaY,
            preserveHandlePositions,
            snapSmoothHandleTriplet,
            pointerX,
            pointerY
        );
    }

    /**
     * Check whether the selected point is an endpoint of an open path
     * and the two endpoints are at the same position.
     */
    private _areOpenPathEndpointsCoincident(): boolean {
        if (this.selectedPoints.length !== 1) {
            return false;
        }

        const currentLayerData = this.getCurrentLayerDataFromStack();
        if (!currentLayerData?.shapes) {
            return false;
        }

        const { contourIndex, nodeIndex } = this.selectedPoints[0];
        const contour = getEditableContour(
            currentLayerData.shapes[contourIndex]
        );
        if (!contour || contour.closed || contour.nodes.length < 2) {
            return false;
        }

        const lastIndex = contour.nodes.length - 1;
        if (nodeIndex !== 0 && nodeIndex !== lastIndex) {
            return false;
        }

        const first = contour.nodes[0];
        const last = contour.nodes[lastIndex];
        return first.x === last.x && first.y === last.y;
    }

    /**
     * While dragging a single endpoint of an open path, snap it onto
     * the opposite endpoint when close enough to allow closing on mouseup.
     * Skipped when the endpoints were already coincident at drag start.
     */
    _checkOpenPathEndpointSnap(): void {
        this.isSnappedToCloseOpenPath = false;

        if (
            !this.isDraggingPoint ||
            this.selectedPoints.length !== 1 ||
            this._dragStartEndpointsCoincident
        ) {
            return;
        }

        const currentLayerData = this.getCurrentLayerDataFromStack();
        if (!currentLayerData?.shapes) {
            return;
        }

        const { contourIndex, nodeIndex } = this.selectedPoints[0];
        const contour = getEditableContour(
            currentLayerData.shapes[contourIndex]
        );
        if (!contour || contour.closed || contour.nodes.length < 2) {
            return;
        }

        const lastIndex = contour.nodes.length - 1;
        const isStartNode = nodeIndex === 0;
        const isEndNode = nodeIndex === lastIndex;
        if (!isStartNode && !isEndNode) {
            return;
        }

        const oppositeIndex = isStartNode ? lastIndex : 0;
        const draggedNode = contour.nodes[nodeIndex];
        const oppositeNode = contour.nodes[oppositeIndex];
        const snapRadius = 10 / this.glyphCanvas.viewportManager!.scale;
        const dist = Math.sqrt(
            (draggedNode.x - oppositeNode.x) ** 2 +
                (draggedNode.y - oppositeNode.y) ** 2
        );

        if (dist <= snapRadius) {
            // Snap the dragged node onto the opposite node
            draggedNode.x = oppositeNode.x;
            draggedNode.y = oppositeNode.y;
            this.isSnappedToCloseOpenPath = true;
        }
    }

    _updateDraggedAnchors(deltaX: number, deltaY: number): void {
        const currentLayerData = this.getCurrentLayerDataFromStack();
        if (!currentLayerData) return;

        let anchors = currentLayerData.anchors || [];
        for (const anchorIndex of this.selectedAnchors) {
            const anchor = anchors[anchorIndex];
            if (anchor) {
                anchor.x += deltaX;
                anchor.y += deltaY;
            }
        }
    }

    _updateDraggedComponents(deltaX: number, deltaY: number): void {
        const currentLayerData = this.getCurrentLayerDataFromStack();
        if (!currentLayerData || !currentLayerData.shapes) return;

        for (const compIndex of this.selectedComponents) {
            const shape = currentLayerData.shapes[compIndex];
            if (shape && 'reference' in shape) {
                if (!shape.transform) {
                    // Initialize transform if it doesn't exist
                    shape.transform = identityDecomposed();
                }

                // Update translation part of transform
                const transform = shape.transform;
                if (Array.isArray(transform)) {
                    // Legacy number[] format
                    transform[4] += deltaX;
                    transform[5] += deltaY;
                } else {
                    // DecomposedAffine format
                    if (!transform.translation) transform.translation = [0, 0];
                    transform.translation[0] += deltaX;
                    transform.translation[1] += deltaY;
                }
            }
        }
    }

    onMouseUp(e: MouseEvent): void {
        if (this.isMarqueeSelecting) {
            if (!this.marqueeToggleMode && !this.hasMarqueeDragged()) {
                this.clearAllSelections();
                this.glyphCanvas.render();
            }
            this.resetMarqueeSelection();
            return;
        }

        const wasDragging =
            this.isDraggingPoint ||
            this.isDraggingAnchor ||
            this.isDraggingComponent ||
            this.isDraggingSidebearing ||
            this.isDraggingGuide;

        // Capture drag state before clearing drag flags
        const dragType = this._dragType;
        const preDragDesc = this._preDragDesc;
        const draggedGuideScope = this.selectedGuideHandle?.scope ?? null;
        const wasSnappedToClose = this.isSnappedToCloseOpenPath;
        const snappedContourIndex =
            wasSnappedToClose && this.selectedPoints.length === 1
                ? this.selectedPoints[0].contourIndex
                : -1;

        this.isDraggingPoint = false;
        this.isSlidingSmoothPointAlongCurve = false;
        this.isSnappedToCloseOpenPath = false;
        this.isDraggingAnchor = false;
        this.isDraggingComponent = false;
        this.isDraggingSidebearing = false;
        this.isDraggingGuide = false;
        this.lastPointDragShiftKey = null;
        this._pointDragPreserveHandlePositions = false;

        // Reset node snap state
        this.activeSnapTarget = null;
        this.snapDraggedNaturalPos = null;
        this._snapDragStartMouseX = null;
        this._snapDragStartMouseY = null;
        this._snapDragStartNodePos = null;
        this._snapCandidateCache = null;
        this._lastDragSaveTime = 0;
        this._lastPropertyPanelUpdateTime = 0;

        // If we were snapped to close an open path, abort the normal
        // drag sync and perform a merge-close instead.
        if (wasSnappedToClose && wasDragging && snappedContourIndex >= 0) {
            // Don't end the drag transaction — reuse it so
            // drag + close appear as a single undo entry.
            this._hasMoved = false;
            this._preDragDesc = null;
            this._dragType = null;
            this.closeOpenPathByMerge(snappedContourIndex, true);
            return;
        }

        // Update worker font cache after dragging ends
        if (wasDragging) {
            console.log(
                `[DRAG-DEBUG] onMouseUp entered wasDragging block — dragType=${dragType}, hasMoved=${this._hasMoved}, selectedLayerId=${this.selectedLayerId}`
            );
            // Flush the final saveLayerData that throttling may have skipped
            if (this._hasMoved && dragType !== 'guide') {
                const dragChangeSource =
                    dragType === 'anchor'
                        ? 'mouse-drag-anchor'
                        : 'mouse-drag-outline';
                console.log(
                    `[DRAG-DEBUG] onMouseUp before saveLayerData — changeSource=${dragChangeSource}`
                );
                this.saveLayerData(dragChangeSource);
            }

            // Final property panel update
            console.log('[DRAG-DEBUG] onMouseUp before updatePropertyPanel');
            this.glyphCanvas.updatePropertyPanel();

            // Only sync to Y.Doc if there was actual movement — avoids spurious undo entries
            // from simple clicks on anchors/points/components that didn't move anything.
            if (this._hasMoved) {
                // Build post-drag description (layerData already mutated — use coords-only)
                let postDragDesc: string | undefined;
                if (dragType === 'anchor') {
                    postDragDesc = this._buildAnchorDesc(true);
                } else if (dragType === 'point') {
                    postDragDesc = this._buildNodeDesc(true);
                } else if (dragType === 'component') {
                    postDragDesc = this._buildComponentDesc(true);
                } else if (dragType === 'guide') {
                    postDragDesc = this._buildGuideDesc(true);
                } else if (dragType === 'sidebearing') {
                    const side = this.selectedSidebearingHandle?.side;
                    const sidebearingValue = side
                        ? this.getCurrentDirectSidebearing(side)
                        : null;
                    postDragDesc =
                        side && sidebearingValue !== null
                            ? formatSidebearingHistoryValue(
                                  side,
                                  sidebearingValue
                              )
                            : undefined;
                }
                const normalizeDragDesc = (
                    value: string | null | undefined
                ): string | null => {
                    if (!value) {
                        return null;
                    }
                    const colonIndex = value.indexOf(': ');
                    if (colonIndex >= 0) {
                        return value.slice(colonIndex + 2);
                    }
                    return value;
                };
                const isNoOpDragByDescription =
                    normalizeDragDesc(preDragDesc) !== null &&
                    normalizeDragDesc(preDragDesc) ===
                        normalizeDragDesc(postDragDesc);
                const hasLeftMetricsKeyPointDragDelta =
                    dragType === 'point' &&
                    Math.abs(this._pointDragDeltaX) > 0.01 &&
                    this.hasActiveMetricsKey('left');
                const hasLeftMetricsKeyComponentDragDelta =
                    dragType === 'component' &&
                    Math.abs(this._componentDragDeltaX) > 0.01 &&
                    this.hasActiveMetricsKey('left');
                const hasMetricsKeySideChange =
                    this._metricsKeyEditedSide !== null ||
                    hasLeftMetricsKeyPointDragDelta ||
                    hasLeftMetricsKeyComponentDragDelta;
                const label =
                    dragType === 'anchor'
                        ? 'Drag anchor'
                        : dragType === 'slide-point'
                          ? 'Move point along curve'
                          : dragType === 'point'
                            ? 'Drag point'
                            : dragType === 'component'
                              ? 'Drag component'
                              : dragType === 'guide'
                                ? 'Drag guide'
                                : dragType === 'sidebearing' &&
                                    this.selectedSidebearingHandle
                                  ? getSidebearingTransactionLabel(
                                        this.selectedSidebearingHandle.side
                                    )
                                  : 'Drag';
                if (isNoOpDragByDescription && !hasMetricsKeySideChange) {
                    // A drag moved during interaction but returned to the same
                    // effective value (e.g. point dragged out and back). Skip
                    // Yjs/history sync to avoid no-op history entries.
                } else if (dragType === 'slide-point') {
                    const currentGlyphModel = this.getCurrentGlyphModel();
                    if (window.changeBridge && currentGlyphModel?.name) {
                        window.changeBridge.syncGlyphFromJson(
                            currentGlyphModel.name,
                            label
                        );
                    }
                } else if (
                    !(dragType === 'guide' && draggedGuideScope === 'master')
                ) {
                    // Encode the metrics-key edited side into newValue so
                    // inferSidebearingSideFromHistoryItem can detect it on undo.
                    const metricsKeySide =
                        this._metricsKeyEditedSide ||
                        this._metricsKeyInteractionSide ||
                        (hasLeftMetricsKeyPointDragDelta ||
                        hasLeftMetricsKeyComponentDragDelta
                            ? 'left'
                            : null);
                    this._metricsKeyEditedSide = null;
                    this._metricsKeyInteractionSide = null;
                    this._pointDragDeltaX = 0;
                    this._componentDragDeltaX = 0;
                    const encodedPostDesc =
                        metricsKeySide && postDragDesc !== undefined
                            ? `${
                                  metricsKeySide === 'left' ? 'LEFT' : 'RIGHT'
                              } ${postDragDesc}`
                            : postDragDesc;
                    console.log(
                        `[DRAG-DEBUG] onMouseUp before _syncCurrentGlyphToYDoc — label=${label}, preDragDesc=${preDragDesc ?? 'null'}, postDragDesc=${encodedPostDesc ?? 'null'}`
                    );
                    this._syncCurrentGlyphToYDoc(
                        label,
                        preDragDesc ?? undefined,
                        encodedPostDesc,
                        metricsKeySide
                    );
                }
            }

            console.log('[DRAG-DEBUG] onMouseUp before endTransaction');
            window.changeBridge?.endTransaction();
            if (dragType === 'slide-point') {
                const currentFont = fontManager.currentFont;
                const currentGlyphModel = this.getCurrentGlyphModel();
                if (currentFont) {
                    currentFont.markDirty('keyboard-outline');
                    void fontManager.updateDirtyIndicator();
                    window.setTimeout(() => {
                        if (fontManager.currentFont !== currentFont) {
                            return;
                        }

                        try {
                            currentFont.syncJsonFromModel();
                        } catch (error) {
                            console.error(
                                '[OutlineEditor] Error syncing font JSON after smooth point slide:',
                                error
                            );
                            return;
                        }

                        void fontManager.updateWorkerFontCache();
                    }, 0);
                } else if (currentGlyphModel?.name) {
                    window.dispatchEvent(
                        new CustomEvent('glyphChanged', {
                            detail: {
                                glyphName: currentGlyphModel.name,
                                layerId: this.getCurrentLayerId()
                            }
                        })
                    );
                }
            } else if (dragType !== 'guide') {
                console.log(
                    '[DRAG-DEBUG] onMouseUp before updateWorkerFontCache + flushPendingDebugEditingFontSaveAfterDrag'
                );
                fontManager.updateWorkerFontCache();
                fontManager.flushPendingDebugEditingFontSaveAfterDrag();
            }
            this._pointDragDeltaX = 0;
            this._componentDragDeltaX = 0;
            this._hasMoved = false;
            this._preDragDesc = null;
            this._dragType = null;
            this._metricsKeyInteractionSide = null;

            // A remote change was deferred during the drag to avoid resetting
            // layerData mid-drag. Now that the drag is complete, run the refresh.
            console.log(
                `[DRAG-DEBUG] Drag END: mouseup — pendingRemoteRefreshAfterDrag=${this.pendingRemoteRefreshAfterDrag}`
            );
            if (this.pendingRemoteRefreshAfterDrag) {
                console.warn(
                    '[DRAG-DEBUG] Firing deferred remote refresh after drag end'
                );
                this.pendingRemoteRefreshAfterDrag = false;
                void window.syncRustCacheAndRefreshCanvas?.();
            }
        }
    }

    get draggingSomething() {
        return (
            this.active &&
            (this.isMarqueeSelecting ||
                this.isDraggingPoint ||
                this.isDraggingAnchor ||
                this.isDraggingComponent ||
                this.isDraggingSidebearing ||
                this.isDraggingGuide)
        );
    }

    // In outline editor mode, check for hovered components, anchors and points first (unless in preview mode), then other glyphs
    performHitDetection(e: MouseEvent | null): void {
        if (!(this.active && this.layerData && !this.isPreviewMode)) return;
        if (this.glyphCanvas.stackPreviewAnimator.shouldRenderStackPreview()) {
            return;
        }
        if (e) {
            this.altKeyPressed = e.altKey;
        }

        this.updateHoveredGuideHandle();
        this.updateHoveredSidebearingHandle();
        this.updateHoveredComponent();
        this.updateHoveredAnchor();
        this.updateHoveredPoint();
        this.updateHoveredAddPointPreview();
        this.updateHoveredCommandCurvePreview();
    }

    cursorStyle(): string | null {
        if (!this.active) return null;
        if (this.cmdKeyPressed && this.hoveredAddPointPreview) {
            this.canvas!.style.cursor = 'crosshair';
            return null;
        }
        if (this.shouldShowCommandPathCrosshair()) {
            this.canvas!.style.cursor = 'crosshair';
            return null;
        }
        if (
            this.selectedLayerId &&
            this.layerData &&
            !this.isPreviewMode &&
            (this.hoveredGuideHandle !== null ||
                this.hoveredSidebearingHandle !== null ||
                this.hoveredComponentIndex !== null ||
                this.hoveredPointIndex ||
                this.hoveredAnchorIndex !== null ||
                this.hoveredAddPointPreview !== null ||
                this.hoveredCommandCurvePreview !== null)
        ) {
            this.canvas!.style.cursor = 'pointer';
        } else if (this.hoveredGlyphIndex !== -1) {
            // Hovering over another glyph in editing mode
            this.canvas!.style.cursor = 'pointer';
        } else {
            this.canvas!.style.cursor = 'default';
        }
        return null;
    }

    _findHoveredItem<T, U>(
        items: T[],
        getCoords: (item: T) => { x: number; y: number } | null,
        getValue: (item: T) => U,
        hitRadius: number = 10
    ): U | null {
        if (!this.layerData || !items) {
            return null;
        }
        const { glyphX, glyphY } = this.transformMouseToComponentSpace();
        const scaledHitRadius =
            hitRadius / this.glyphCanvas.viewportManager!.scale;

        // Find the closest item within hit radius (not just the first backwards hit)
        let bestDist = Infinity;
        let bestValue: U | null = null;
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const coords = getCoords(item);
            if (coords) {
                const dist = Math.sqrt(
                    (coords.x - glyphX) ** 2 + (coords.y - glyphY) ** 2
                );
                if (dist <= scaledHitRadius && dist <= bestDist) {
                    bestDist = dist;
                    bestValue = getValue(item);
                }
            }
        }
        return bestValue;
    }

    private transformMouseToRootSpace(): { glyphX: number; glyphY: number } {
        return this.glyphCanvas.toGlyphLocal(
            this.glyphCanvas.mouseX,
            this.glyphCanvas.mouseY
        );
    }

    updateHoveredGuideHandle(): void {
        const visibleGuides = this.getVisibleGuides();
        const { glyphX: rootGlyphX, glyphY: rootGlyphY } =
            this.transformMouseToRootSpace();
        const scaledHitRadius = 20 / this.glyphCanvas.viewportManager!.scale;

        let bestDist = Infinity;
        let foundGuideHandle: GuideHandle | null = null;

        for (const guide of visibleGuides) {
            const dist = Math.sqrt(
                (guide.rootX - rootGlyphX) ** 2 +
                    (guide.rootY - rootGlyphY) ** 2
            );

            if (dist <= scaledHitRadius && dist < bestDist) {
                bestDist = dist;
                foundGuideHandle = {
                    scope: guide.scope,
                    index: guide.index
                };
            }
        }

        if (!this.sameGuideHandle(foundGuideHandle, this.hoveredGuideHandle)) {
            this.hoveredGuideHandle = foundGuideHandle;
            this.glyphCanvas.render();
        }
    }

    updateHoveredSidebearingHandle(): void {
        const visibleHandles = this.getVisibleSidebearingHandles().filter(
            (handle) => handle.editable
        );
        const foundHandle = this._findHoveredItem(
            visibleHandles,
            (handle) => ({ x: handle.x, y: handle.y }),
            (handle) => ({ side: handle.side }),
            this.getSidebearingHandleRadiusScreen()
        );

        if (
            !this.sameSidebearingHandle(
                foundHandle,
                this.hoveredSidebearingHandle
            )
        ) {
            this.hoveredSidebearingHandle = foundHandle;
            this.glyphCanvas.render();
        }
    }

    updateHoveredComponent(): void {
        const currentLayerData = this.getCurrentLayerDataFromStack();
        if (!currentLayerData || !currentLayerData.shapes) {
            return;
        }

        // First, check for hovering near component origins, which take priority.
        const components = currentLayerData.shapes
            .map((shape: Babelfont.Shape, index: number) => ({
                shape,
                index
            }))
            .filter(
                (item: { shape: Babelfont.Shape; index: number }) =>
                    'Component' in item.shape || 'reference' in item.shape
            );

        const getComponentOrigin = (item: {
            shape: Babelfont.Shape;
            index: number;
        }) => {
            // Handle both nested { Component: { reference, transform } } and flat { reference, transform }
            let transform;
            if ('Component' in item.shape) {
                transform =
                    (item.shape as any).Component.transform ||
                    identityDecomposed();
            } else if ('reference' in item.shape) {
                transform =
                    (item.shape as any).transform || identityDecomposed();
            } else {
                transform = identityDecomposed();
            }
            const transformArray = Array.isArray(transform)
                ? transform
                : DecomposedAffineTransform.toAffine(transform);
            return { x: transformArray[4] || 0, y: transformArray[5] || 0 };
        };

        let foundComponentIndex: number | null = this._findHoveredItem(
            components,
            getComponentOrigin,
            (item) => item.index,
            20 // Larger hit radius for origin marker
        );

        // If no origin was hovered, proceed with path-based hit testing.
        if (foundComponentIndex === null) {
            const { glyphX, glyphY } = this.transformMouseToComponentSpace();

            for (
                let index = 0;
                index < currentLayerData.shapes.length;
                index++
            ) {
                const shape = currentLayerData.shapes[index];
                // Check for both nested { Component: { reference, ... } } and flat { reference, ... }
                const isComponent =
                    'Component' in shape || 'reference' in shape;
                const hasLayerData =
                    ('Component' in shape &&
                        (shape as any).Component.layerData) ||
                    ('reference' in shape && (shape as any).layerData);
                const layerData =
                    ('Component' in shape &&
                        (shape as any).Component.layerData) ||
                    ('reference' in shape && (shape as any).layerData);
                const shapesData = layerData && layerData.shapes;

                if (isComponent && shapesData) {
                    if (this._isPointInComponent(shape, glyphX, glyphY)) {
                        foundComponentIndex = index;
                    }
                }
            }
        }

        if (foundComponentIndex !== this.hoveredComponentIndex) {
            this.hoveredComponentIndex = foundComponentIndex;
            this.glyphCanvas.render();
        }
    }

    _isPointInComponent(
        shape: Babelfont.Shape,
        glyphX: number,
        glyphY: number
    ): boolean {
        // Handle both nested { Component: { ... } } and flat { reference, ... } structures
        const isNested = 'Component' in shape;
        const componentData = isNested ? (shape as any).Component : shape;

        if (!('reference' in componentData)) {
            return false;
        }

        const transformRaw = componentData.transform;
        const transform = !transformRaw
            ? [1, 0, 0, 1, 0, 0]
            : Array.isArray(transformRaw)
              ? transformRaw
              : DecomposedAffineTransform.toAffine(transformRaw);

        // Ensure transform is always an array with 6 elements
        const transformArray: Transform = (
            Array.isArray(transform) && transform.length >= 6
                ? transform
                : [1, 0, 0, 1, 0, 0]
        ) as Transform;

        // Collect all outline shapes with their accumulated transforms
        // This allows proper counter detection via nonzero winding rule
        const collectOutlineShapes = (
            shapes: Babelfont.Shape[],
            parentTransform: Transform = [1, 0, 0, 1, 0, 0]
        ): Array<{ nodes: any[]; transform: Transform; closed: boolean }> => {
            const outlineShapes: Array<{
                nodes: any[];
                transform: Transform;
                closed: boolean;
            }> = [];

            for (const componentShape of shapes) {
                // Handle both nested { Component: { reference, transform, layerData } } and flat { reference, transform, layerData }
                const isNestedComp = 'Component' in componentShape;
                const compData = isNestedComp
                    ? (componentShape as any).Component
                    : componentShape;

                if ('reference' in compData) {
                    const nestedTransformRaw = compData.transform || [
                        1, 0, 0, 1, 0, 0
                    ];
                    const nestedTransform = Array.isArray(nestedTransformRaw)
                        ? nestedTransformRaw
                        : DecomposedAffineTransform.toAffine(
                              nestedTransformRaw
                          );
                    const nestedTransformArray: Transform = (
                        Array.isArray(nestedTransform) &&
                        nestedTransform.length >= 6
                            ? nestedTransform
                            : [1, 0, 0, 1, 0, 0]
                    ) as Transform;

                    // Multiply matrices to combine transforms
                    // Transform format: [a, b, c, d, tx, ty] where matrix is:
                    // | a  c  tx |
                    // | b  d  ty |
                    // | 0  0   1 |
                    const combinedTransform: Transform = [
                        parentTransform[0] * nestedTransformArray[0] +
                            parentTransform[2] * nestedTransformArray[1],
                        parentTransform[1] * nestedTransformArray[0] +
                            parentTransform[3] * nestedTransformArray[1],
                        parentTransform[0] * nestedTransformArray[2] +
                            parentTransform[2] * nestedTransformArray[3],
                        parentTransform[1] * nestedTransformArray[2] +
                            parentTransform[3] * nestedTransformArray[3],
                        parentTransform[0] * nestedTransformArray[4] +
                            parentTransform[2] * nestedTransformArray[5] +
                            parentTransform[4],
                        parentTransform[1] * nestedTransformArray[4] +
                            parentTransform[3] * nestedTransformArray[5] +
                            parentTransform[5]
                    ];

                    if (compData.layerData && compData.layerData.shapes) {
                        outlineShapes.push(
                            ...collectOutlineShapes(
                                compData.layerData.shapes,
                                combinedTransform
                            )
                        );
                    }
                } else {
                    const contour = getEditableContour(componentShape);

                    if (contour?.nodes.length) {
                        outlineShapes.push({
                            nodes: contour.nodes,
                            transform: parentTransform,
                            closed: contour.closed
                        });
                    }
                }
            }

            return outlineShapes;
        };

        // Collect all shapes from the component hierarchy
        const shapeIsNested = 'Component' in shape;
        const shapeComponentData = shapeIsNested
            ? (shape as any).Component
            : shape;
        const layerData = shapeComponentData.layerData;

        const outlineShapes = collectOutlineShapes(layerData?.shapes || []);

        if (outlineShapes.length === 0) {
            return false;
        }

        // Build a single combined path with all contours
        // This allows the canvas nonzero winding rule to properly handle counters
        const combinedPath = new Path2D();

        for (const {
            nodes,
            transform: nestedTransform,
            closed
        } of outlineShapes) {
            // Create a path for this shape
            const shapePath = new Path2D();
            this.glyphCanvas.renderer!.buildPathFromNodes(
                nodes,
                closed,
                shapePath
            );
            if (closed) {
                shapePath.closePath();
            }

            // Apply the accumulated transform to this shape's path
            const matrix = new DOMMatrix([
                nestedTransform[0],
                nestedTransform[1],
                nestedTransform[2],
                nestedTransform[3],
                nestedTransform[4],
                nestedTransform[5]
            ]);

            // Add the transformed path to the combined path
            combinedPath.addPath(shapePath, matrix);
        }

        // Now do a single hit test on the combined path with the component's transform
        this.glyphCanvas.ctx!.save();
        this.glyphCanvas.ctx!.setTransform(1, 0, 0, 1, 0, 0);
        this.glyphCanvas.ctx!.transform(
            transformArray[0],
            transformArray[1],
            transformArray[2],
            transformArray[3],
            transformArray[4],
            transformArray[5]
        );

        // Calculate scale for hit tolerance
        const scaleX = Math.sqrt(
            transformArray[0] * transformArray[0] +
                transformArray[1] * transformArray[1]
        );
        const scaleY = Math.sqrt(
            transformArray[2] * transformArray[2] +
                transformArray[3] * transformArray[3]
        );
        const scale = Math.max(scaleX, scaleY);
        const totalScale = this.glyphCanvas.viewportManager!.scale * scale;
        this.glyphCanvas.ctx!.lineWidth =
            APP_SETTINGS.OUTLINE_EDITOR.HIT_TOLERANCE / totalScale;

        // Use both fill and stroke for hit detection
        const isInPath =
            this.glyphCanvas.ctx!.isPointInPath(combinedPath, glyphX, glyphY) ||
            this.glyphCanvas.ctx!.isPointInStroke(combinedPath, glyphX, glyphY);

        this.glyphCanvas.ctx!.restore();
        return isInPath;
    }

    updateHoveredAnchor(): void {
        const currentLayerData = this.getCurrentLayerDataFromStack();
        if (!currentLayerData || !currentLayerData.anchors) {
            return;
        }

        const foundAnchorIndex = this._findHoveredItem(
            currentLayerData.anchors.map(
                (anchor: Babelfont.Anchor, index: number) => ({
                    ...anchor,
                    index
                })
            ),
            (item) => ({ x: item.x, y: item.y }),
            (item) => item.index
        );

        if (foundAnchorIndex !== this.hoveredAnchorIndex) {
            this.hoveredAnchorIndex = foundAnchorIndex;
            this.glyphCanvas.render();
        }
    }

    updateHoveredPoint(): void {
        const currentLayerData = this.getCurrentLayerDataFromStack();
        if (!currentLayerData || !currentLayerData.shapes) {
            return;
        }

        const points = currentLayerData.shapes.flatMap(
            (shape: Babelfont.Shape, contourIndex: number) => {
                // Handle both nested { Path: { nodes: [...] } } and flat { nodes: [...] }
                let nodes: Babelfont.Node[] | null = null;
                if ('Path' in shape && (shape as any).Path?.nodes) {
                    nodes = (shape as any).Path.nodes;
                } else if ('nodes' in shape && (shape as any).nodes) {
                    nodes = (shape as any).nodes;
                }

                if (!nodes || !Array.isArray(nodes)) return [];
                return nodes.map((node: Babelfont.Node, nodeIndex: number) => ({
                    node,
                    contourIndex,
                    nodeIndex
                }));
            }
        );

        const foundPoint = this._findHoveredItem(
            points,
            (item) => ({ x: item.node.x, y: item.node.y }),
            (item) => ({
                contourIndex: item.contourIndex,
                nodeIndex: item.nodeIndex
            })
        );

        if (
            JSON.stringify(foundPoint) !==
            JSON.stringify(this.hoveredPointIndex)
        ) {
            this.hoveredPointIndex = foundPoint;
            this.glyphCanvas.render();
        }
    }

    private clearHoveredAddPointPreview(): void {
        if (this.hoveredAddPointPreview) {
            this.hoveredAddPointPreview = null;
            this.glyphCanvas.render();
        }
    }

    private clearHoveredCommandCurvePreview(): void {
        if (this.hoveredCommandCurvePreview) {
            this.hoveredCommandCurvePreview = null;
            this.glyphCanvas.render();
        }
    }

    private findClosestPathSegmentHit(): PathSegmentHit | null {
        const currentLayerData = this.getCurrentLayerDataFromStack();
        if (!currentLayerData?.shapes) {
            return null;
        }

        const { glyphX, glyphY } = this.transformMouseToComponentSpace();
        const hitRadius =
            10 / Math.max(this.glyphCanvas.viewportManager?.scale ?? 1, 0.001);
        let bestHit: PathSegmentHit | null = null;
        let bestDistance = Infinity;
        let pathIndex = 0;

        currentLayerData.shapes.forEach(
            (shape: Babelfont.Shape, shapeIndex: number) => {
                const contour = getEditableContour(shape);
                if (!contour || contour.nodes.length < 2) {
                    return;
                }

                const descriptors = Layer.getPathSegmentDescriptors({
                    nodes: contour.nodes,
                    closed: contour.closed
                });

                descriptors.forEach((descriptor) => {
                    let projection: PathSegmentHit['projection'] | null = null;

                    if (descriptor.type === 'line') {
                        projection = projectPointOntoLine(
                            { x: glyphX, y: glyphY },
                            descriptor.points[0],
                            descriptor.points[1]
                        );
                    } else {
                        const projected = new Bezier(descriptor.points).project(
                            {
                                x: glyphX,
                                y: glyphY
                            }
                        );
                        projection = {
                            x: projected.x,
                            y: projected.y,
                            t: clampUnitInterval(projected.t ?? 0),
                            distance: projected.d ?? Infinity
                        };
                    }

                    if (!projection || projection.distance > hitRadius) {
                        return;
                    }

                    if (projection.distance >= bestDistance) {
                        return;
                    }

                    bestDistance = projection.distance;
                    bestHit = {
                        shapeIndex,
                        pathIndex,
                        descriptor,
                        projection
                    };
                });

                pathIndex += 1;
            }
        );

        return bestHit;
    }

    private selectAllNodesInContour(contourIndex: number): boolean {
        const currentLayerData = this.getCurrentLayerDataFromStack();
        const contour = getEditableContour(
            currentLayerData?.shapes?.[contourIndex]
        );

        if (!contour?.nodes.length) {
            return false;
        }

        this.selectedPoints = contour.nodes.map(
            (_node: Babelfont.Node, nodeIndex: number) => ({
                contourIndex,
                nodeIndex
            })
        );
        this.selectedAnchors = [];
        this.selectedComponents = [];
        this.selectedGuideHandle = null;
        this.selectedSidebearingHandle = null;
        this.glyphCanvas.updatePropertyPanel();
        this.glyphCanvas.render();
        return true;
    }

    private updateHoveredAddPointPreview(): void {
        if (
            !this.active ||
            !this.layerData ||
            this.layerData.isInterpolated ||
            !this.selectedLayerId ||
            !this.glyphCanvas.canvas?.matches(':focus')
        ) {
            this.clearHoveredAddPointPreview();
            return;
        }

        if (!this.cmdKeyPressed || this.altKeyPressed) {
            this.clearHoveredAddPointPreview();
            return;
        }

        if (
            this.hoveredGuideHandle ||
            this.hoveredSidebearingHandle ||
            this.hoveredComponentIndex !== null ||
            this.hoveredAnchorIndex !== null ||
            this.hoveredPointIndex
        ) {
            this.clearHoveredAddPointPreview();
            return;
        }

        const currentLayerData = this.getCurrentLayerDataFromStack();
        if (!currentLayerData?.shapes) {
            this.clearHoveredAddPointPreview();
            return;
        }

        const { glyphX, glyphY } = this.transformMouseToComponentSpace();
        let bestPreview: HoveredAddPointPreview | null = null;
        const bestHit = this.findClosestPathSegmentHit();

        if (bestHit) {
            const [leftPoints, rightPoints] = splitPreviewSegment(
                bestHit.descriptor.points,
                bestHit.projection.t
            );

            bestPreview = {
                shapeIndex: bestHit.shapeIndex,
                pathIndex: bestHit.pathIndex,
                segmentId: bestHit.descriptor.segmentId,
                t: bestHit.projection.t,
                point: {
                    x: bestHit.projection.x,
                    y: bestHit.projection.y
                },
                segments: [
                    {
                        type: bestHit.descriptor.type,
                        points: leftPoints
                    },
                    {
                        type: bestHit.descriptor.type,
                        points: rightPoints
                    }
                ]
            };
        }

        const previousPreview = JSON.stringify(this.hoveredAddPointPreview);
        const nextPreview = JSON.stringify(bestPreview);
        if (previousPreview !== nextPreview) {
            this.hoveredAddPointPreview = bestPreview;
            this.glyphCanvas.render();
        }
    }

    private buildHoveredCommandCurvePreview(
        hit: PathSegmentHit
    ): HoveredSegmentPreview | null {
        if (hit.descriptor.type !== 'line') {
            return null;
        }

        const firstHandle = lerpPoint(
            hit.descriptor.points[0],
            hit.descriptor.points[1],
            1 / 3
        );
        const secondHandle = lerpPoint(
            hit.descriptor.points[0],
            hit.descriptor.points[1],
            2 / 3
        );

        return {
            shapeIndex: hit.shapeIndex,
            pathIndex: hit.pathIndex,
            segmentId: hit.descriptor.segmentId,
            segments: [
                {
                    type: 'cubic',
                    points: [
                        hit.descriptor.points[0],
                        firstHandle,
                        secondHandle,
                        hit.descriptor.points[1]
                    ]
                }
            ]
        };
    }

    private updateHoveredCommandCurvePreview(): void {
        if (
            !this.active ||
            !this.layerData ||
            this.layerData.isInterpolated ||
            !this.selectedLayerId ||
            !this.altKeyPressed ||
            this.cmdKeyPressed ||
            this.activePathDrawingSession
        ) {
            this.clearHoveredCommandCurvePreview();
            return;
        }

        if (!this.isNeutralCommandCanvasTarget()) {
            this.clearHoveredCommandCurvePreview();
            return;
        }

        const bestHit = this.findClosestPathSegmentHit();
        const bestPreview = bestHit
            ? this.buildHoveredCommandCurvePreview(bestHit)
            : null;

        const previousPreview = JSON.stringify(this.hoveredCommandCurvePreview);
        const nextPreview = JSON.stringify(bestPreview);
        if (previousPreview !== nextPreview) {
            this.hoveredCommandCurvePreview = bestPreview;
            this.glyphCanvas.render();
        }
    }

    setCommandKeyPressed(pressed: boolean, refreshHover: boolean = true): void {
        if (this.cmdKeyPressed === pressed) {
            return;
        }

        this.cmdKeyPressed = pressed;
        if (!pressed) {
            this.hoveredAddPointPreview = null;
            this.finalizePendingCommandPathEdit();
        }

        if (
            refreshHover &&
            this.active &&
            this.layerData &&
            !this.isPreviewMode
        ) {
            this.performHitDetection(null);
            this.glyphCanvas.updateCursorStyle();
            this.glyphCanvas.render();
        }
    }

    setAltKeyPressed(pressed: boolean): void {
        if (this.altKeyPressed === pressed) {
            return;
        }

        this.altKeyPressed = pressed;
        if (this.isDraggingPoint && !this.isSlidingSmoothPointAlongCurve) {
            this._rebuildSnapCandidateCache();
        }
        if (!pressed) {
            this.hoveredCommandCurvePreview = null;
            this.finalizePendingCommandPathEdit();
        }

        if (this.active && this.layerData && !this.isPreviewMode) {
            this.performHitDetection(null);
            this.glyphCanvas.updateCursorStyle();
            this.glyphCanvas.render();
        }
    }

    private async commitHoveredAddPointPreview(): Promise<void> {
        const preview = this.hoveredAddPointPreview;
        const currentLayerData = this.getCurrentLayerDataFromStack();
        const currentLayerModel = this.getCurrentLayerModel();
        const currentGlyphModel = this.getCurrentGlyphModel();

        if (
            !preview ||
            !currentLayerData ||
            !currentLayerModel ||
            !currentGlyphModel
        ) {
            return;
        }

        const activePath = currentLayerModel.paths?.[preview.pathIndex];
        if (!activePath) {
            return;
        }

        const linkedLayers = currentLayerModel._getLinkedLayers?.() || [];
        const bridge = window.changeBridge;
        let insertedNodeIndex: number | null = null;

        const roundPathNodesToGrid = (
            path: { nodes?: Babelfont.Node[] } | null | undefined
        ): void => {
            if (!path?.nodes) {
                return;
            }

            for (const node of path.nodes) {
                node.x = Math.round(node.x);
                node.y = Math.round(node.y);
            }
        };

        withSuppressedModelRecording(() => {
            insertedNodeIndex = activePath._addPoint(
                preview.segmentId,
                preview.t
            );
            roundPathNodesToGrid(activePath);

            for (const linkedLayer of linkedLayers) {
                const linkedPath = linkedLayer.paths?.[preview.pathIndex];
                if (!linkedPath) {
                    continue;
                }
                linkedPath._addPoint(preview.segmentId, preview.t);
                roundPathNodesToGrid(linkedPath);
            }
        });

        if (bridge && currentGlyphModel.name) {
            bridge.beginTransaction('Add point');
            try {
                bridge.syncGlyphFromJson(currentGlyphModel.name, 'Add point');
            } finally {
                bridge.endTransaction();
            }
        }

        if (insertedNodeIndex === null) {
            return;
        }

        const activePathData = activePath.toJSON();
        const activeShape = currentLayerData.shapes?.[preview.shapeIndex];
        const activeContour = getPathShapeData(activeShape);
        if (activeContour && typeof activeContour === 'object') {
            const normalizedNodes =
                typeof activePathData.nodes === 'string'
                    ? LayerDataNormalizer.parseNodes(activePathData.nodes)
                    : Array.isArray(activePathData.nodes)
                      ? activePathData.nodes
                      : [];
            activeContour.nodes = normalizedNodes.map(
                (node: Babelfont.Node) => ({ ...node })
            );
            activeContour.closed = Boolean(activePathData.closed);
        }

        this.selectedPoints = [
            {
                contourIndex: preview.shapeIndex,
                nodeIndex: insertedNodeIndex
            }
        ];
        this.selectedAnchors = [];
        this.selectedComponents = [];
        this.selectedGuideHandle = null;
        this.selectedSidebearingHandle = null;
        this.hoveredAddPointPreview = null;

        const currentFont = fontManager.currentFont;
        const layerId = this.getCurrentLayerId();
        const shouldUseIncrementalCacheRefresh = linkedLayers.length === 0;

        if (currentFont) {
            currentFont.markDirty('keyboard-outline');
            void fontManager.updateDirtyIndicator();
        }

        this.performHitDetection(null);
        this.glyphCanvas.updatePropertyPanel();
        this.glyphCanvas.render();

        if (currentFont) {
            window.setTimeout(() => {
                if (fontManager.currentFont !== currentFont) {
                    return;
                }

                if (shouldUseIncrementalCacheRefresh) {
                    fontManager.pendingBabelfontJsonSyncAfterDrag = true;
                    void fontManager.updateWorkerFontCache();
                    return;
                }

                try {
                    currentFont.syncJsonFromModel();
                } catch (error) {
                    console.error(
                        '[OutlineEditor] Error syncing font JSON after point insertion:',
                        error
                    );
                    return;
                }

                void fontManager.updateWorkerFontCache();
            }, 0);
        } else if (currentGlyphModel.name) {
            window.dispatchEvent(
                new CustomEvent('glyphChanged', {
                    detail: {
                        glyphName: currentGlyphModel.name,
                        layerId
                    }
                })
            );
        }
    }

    private handleCommandPathGesture(e: MouseEvent): boolean {
        const isCmdClick = (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;
        if (!isCmdClick) {
            return false;
        }

        this.setCommandKeyPressed(true, false);

        if (this.tryHandleActivePathDrawingSessionClick()) {
            return true;
        }

        const selectedEndpointSeed = this.getSelectedOpenPathEndpointSeed();
        if (
            selectedEndpointSeed &&
            this.isCommandPathCloseTarget(selectedEndpointSeed)
        ) {
            return this.closeActivePathDrawingSession(selectedEndpointSeed);
        }

        if (!this.isNeutralCommandCanvasTarget()) {
            return false;
        }

        return this.beginCommandPathDrawing();
    }

    private handleAltCurveConversionGesture(e: MouseEvent): boolean {
        const isAltClick = e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey;
        if (!isAltClick || !this.isNeutralCommandCanvasTarget()) {
            return false;
        }

        this.altKeyPressed = true;

        const segmentHit = this.findClosestPathSegmentHit();
        if (segmentHit?.descriptor.type !== 'line') {
            return false;
        }

        return this.convertLineSegmentToCurve(segmentHit);
    }

    private isNeutralCommandCanvasTarget(): boolean {
        return (
            this.hoveredGuideHandle === null &&
            this.hoveredSidebearingHandle === null &&
            this.hoveredComponentIndex === null &&
            this.hoveredAnchorIndex === null &&
            this.hoveredPointIndex === null
        );
    }

    private tryHandleActivePathDrawingSessionClick(): boolean {
        const session = this.activePathDrawingSession;
        if (!session) {
            return false;
        }

        if (this.isCommandPathCloseTarget(session)) {
            return this.closeActivePathDrawingSession(session);
        }

        if (!this.isNeutralCommandCanvasTarget()) {
            return false;
        }

        const { glyphX, glyphY } = this.transformMouseToComponentSpace();
        return this.appendLineToPathSession(session, { x: glyphX, y: glyphY });
    }

    private isCommandPathCloseTarget(
        session: ActivePathDrawingSession
    ): boolean {
        const hoveredPoint = this.hoveredPointIndex;
        if (!hoveredPoint || hoveredPoint.contourIndex !== session.shapeIndex) {
            return false;
        }

        const currentLayerData = this.getCurrentLayerDataFromStack();
        const contour = getEditableContour(
            currentLayerData?.shapes?.[session.shapeIndex]
        );
        if (!contour || contour.closed || contour.nodes.length < 2) {
            return false;
        }

        if (session.startedFromExistingPath) {
            const oppositeEndpointIndex =
                session.edge === 'start' ? contour.nodes.length - 1 : 0;
            return hoveredPoint.nodeIndex === oppositeEndpointIndex;
        }

        return (
            session.segmentCount > 1 &&
            hoveredPoint.nodeIndex === session.originNodeIndex
        );
    }

    private beginCommandPathDrawing(): boolean {
        const currentLayerData = this.getCurrentLayerDataFromStack();
        const currentLayerModel = this.getCurrentLayerModel();

        if (!currentLayerData || !currentLayerModel) {
            return false;
        }

        const seed = this.getSelectedOpenPathEndpointSeed();
        if (seed) {
            const { glyphX, glyphY } = this.transformMouseToComponentSpace();
            return this.appendLineToPathSession(seed, { x: glyphX, y: glyphY });
        }

        return this.startNewPathDrawingSession();
    }

    private ensureCanvasContextMenu(): TippyInstance | null {
        if (this.canvasContextMenuTippy) {
            return this.canvasContextMenuTippy;
        }

        if (!this.canvas) {
            return null;
        }

        const backdrop = getOrCreateBackdrop(
            this.CANVAS_CONTEXT_MENU_BACKDROP_CLASS
        );

        this.canvasContextMenuTippy = tippy(this.canvas, {
            content: '',
            allowHTML: true,
            trigger: 'manual',
            interactive: true,
            placement: 'right-start',
            theme: getTheme(),
            arrow: false,
            offset: [0, 0],
            appendTo: document.body,
            hideOnClick: false,
            zIndex: 9999,
            getReferenceClientRect: null as any,
            onHide: () => {
                this.restoreFocus();
            },
            onHidden: () => {
                this.canvasContextMenuTarget = null;
            },
            onShown: (instance) => {
                const menu = instance.popper.querySelector('.plugin-menu');
                if (!menu) {
                    return;
                }

                if ((menu as any)._handlersSetup) {
                    return;
                }
                (menu as any)._handlersSetup = true;

                setupMenuKeyboardNav(menu);

                menu.querySelectorAll('.plugin-menu-item').forEach((item) => {
                    item.addEventListener('click', () => {
                        const action = item.getAttribute('data-action');
                        if (!action) {
                            return;
                        }

                        instance.hide();
                        this.handleCanvasContextMenuAction(action);
                    });
                });
            }
        });

        addTippyBackdropSupport(this.canvasContextMenuTippy, backdrop);
        return this.canvasContextMenuTippy;
    }

    private findClosestPointNodeAt(
        glyphPoint: CanvasPoint,
        hitRadius: number = 10
    ): Point | null {
        const currentLayerData = this.getCurrentLayerDataFromStack();
        if (!currentLayerData?.shapes) {
            return null;
        }

        const scaledHitRadius =
            hitRadius /
            Math.max(this.glyphCanvas.viewportManager!.scale, 0.001);
        let bestDist = Infinity;
        let bestPoint: Point | null = null;

        currentLayerData.shapes.forEach(
            (shape: Babelfont.Shape, contourIndex) => {
                const contour = getEditableContour(shape);
                if (!contour?.nodes?.length) {
                    return;
                }

                contour.nodes.forEach(
                    (node: Babelfont.Node, nodeIndex: number) => {
                        const dist = Math.hypot(
                            node.x - glyphPoint.x,
                            node.y - glyphPoint.y
                        );
                        if (dist <= scaledHitRadius && dist <= bestDist) {
                            bestDist = dist;
                            bestPoint = { contourIndex, nodeIndex };
                        }
                    }
                );
            }
        );

        return bestPoint;
    }

    private findClosestPathSegmentHitAt(
        glyphPoint: CanvasPoint
    ): PathSegmentHit | null {
        const currentLayerData = this.getCurrentLayerDataFromStack();
        if (!currentLayerData?.shapes) {
            return null;
        }

        const hitRadius =
            10 / Math.max(this.glyphCanvas.viewportManager?.scale ?? 1, 0.001);
        let bestHit: PathSegmentHit | null = null;
        let bestDistance = Infinity;
        let pathIndex = 0;

        currentLayerData.shapes.forEach(
            (shape: Babelfont.Shape, shapeIndex: number) => {
                const contour = getEditableContour(shape);
                if (!contour || contour.nodes.length < 2) {
                    return;
                }

                const descriptors = Layer.getPathSegmentDescriptors({
                    nodes: contour.nodes,
                    closed: contour.closed
                });

                descriptors.forEach((descriptor) => {
                    let projection: PathSegmentHit['projection'] | null = null;

                    if (descriptor.type === 'line') {
                        projection = projectPointOntoLine(
                            glyphPoint,
                            descriptor.points[0],
                            descriptor.points[1]
                        );
                    } else {
                        const projected = new Bezier(descriptor.points).project(
                            glyphPoint
                        );
                        projection = {
                            x: projected.x,
                            y: projected.y,
                            t: clampUnitInterval(projected.t ?? 0),
                            distance: projected.d ?? Infinity
                        };
                    }

                    if (!projection || projection.distance > hitRadius) {
                        return;
                    }

                    if (projection.distance >= bestDistance) {
                        return;
                    }

                    bestDistance = projection.distance;
                    bestHit = {
                        shapeIndex,
                        pathIndex,
                        descriptor,
                        projection
                    };
                });

                pathIndex += 1;
            }
        );

        return bestHit;
    }

    private buildCanvasContextMenuTarget(
        clickedPoint: CanvasPoint | null = null
    ): CanvasPathContextTarget | null {
        const currentLayerData = this.getCurrentLayerDataFromStack();
        const currentLayerModel = this.getCurrentLayerModel();
        if (
            !this.selectedLayerId ||
            !currentLayerModel ||
            currentLayerData?.isInterpolated ||
            !currentLayerData?.shapes
        ) {
            return null;
        }

        const fallbackPoint = this.transformMouseToComponentSpace();
        const resolvedPoint = clickedPoint || {
            x: fallbackPoint.glyphX,
            y: fallbackPoint.glyphY
        };

        const segmentHit = this.findClosestPathSegmentHitAt(resolvedPoint);
        let shapeIndex = segmentHit?.shapeIndex ?? null;
        let pathIndex = segmentHit?.pathIndex ?? null;
        const clickedNode = this.findClosestPointNodeAt(resolvedPoint);

        if (clickedNode) {
            const hoveredShapeIndex = clickedNode.contourIndex;
            const hoveredPathIndex =
                this.getPathIndexForShapeIndex(hoveredShapeIndex);

            if (hoveredPathIndex !== null) {
                shapeIndex = hoveredShapeIndex;
                pathIndex = hoveredPathIndex;
            }
        }

        if (shapeIndex === null || pathIndex === null) {
            return null;
        }

        const contour = getEditableContour(currentLayerData.shapes[shapeIndex]);
        const hoveredNodeIndex =
            clickedNode?.contourIndex === shapeIndex
                ? clickedNode.nodeIndex
                : null;
        const hoveredNode =
            hoveredNodeIndex !== null ? contour?.nodes[hoveredNodeIndex] : null;
        let onCurveOrdinal: number | null = null;
        if (hoveredNodeIndex !== null && contour?.nodes) {
            const onCurveBeforeOrAtNode = contour.nodes
                .slice(0, hoveredNodeIndex + 1)
                .filter((node: Babelfont.Node) => isOnCurveNode(node)).length;
            onCurveOrdinal = Math.max(0, onCurveBeforeOrAtNode - 1);
        }
        const canSetStartNode = Boolean(
            contour?.closed &&
            hoveredNodeIndex !== null &&
            hoveredNodeIndex > 0 &&
            onCurveOrdinal !== null &&
            onCurveOrdinal > 0 &&
            hoveredNode &&
            hoveredNode.nodetype !== 'OffCurve'
        );

        return {
            shapeIndex,
            pathIndex,
            nodeIndex: hoveredNodeIndex,
            onCurveOrdinal,
            nodeType:
                hoveredNode && isOnCurveNode(hoveredNode)
                    ? hoveredNode.nodetype
                    : null,
            intendedPoint:
                hoveredNode && isOnCurveNode(hoveredNode)
                    ? {
                          x: Number(hoveredNode.x),
                          y: Number(hoveredNode.y)
                      }
                    : null,
            canSetStartNode
        };
    }

    private getClosestOnCurveNodeIndex(
        path: any,
        point: CanvasPoint,
        requireNonStart: boolean,
        preferredNodeType?: Babelfont.NodeType | null
    ): number | null {
        const nodes = path?.nodes;
        if (!Array.isArray(nodes) || !nodes.length) {
            return null;
        }

        const pickBest = (enforceNodeType: boolean): number | null => {
            let bestIndex: number | null = null;
            let bestDistance = Infinity;

            nodes.forEach((node: Babelfont.Node, nodeIndex: number) => {
                if (!isOnCurveNode(node)) {
                    return;
                }

                if (requireNonStart && nodeIndex === 0) {
                    return;
                }

                if (
                    enforceNodeType &&
                    preferredNodeType &&
                    node.nodetype !== preferredNodeType
                ) {
                    return;
                }

                const distance = Math.hypot(node.x - point.x, node.y - point.y);
                if (distance < bestDistance) {
                    bestDistance = distance;
                    bestIndex = nodeIndex;
                }
            });

            return bestIndex;
        };

        return pickBest(true) ?? pickBest(false);
    }

    private getOnCurveNodeIndexByOrdinal(
        path: any,
        onCurveOrdinal: number,
        requireNonStart: boolean
    ): number | null {
        const nodes = path?.nodes;
        if (!Array.isArray(nodes) || !nodes.length || onCurveOrdinal < 0) {
            return null;
        }

        let currentOrdinal = -1;
        for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex++) {
            const node = nodes[nodeIndex];
            if (!isOnCurveNode(node)) {
                continue;
            }

            currentOrdinal += 1;
            if (currentOrdinal !== onCurveOrdinal) {
                continue;
            }

            if (requireNonStart && nodeIndex === 0) {
                return null;
            }

            return nodeIndex;
        }

        return null;
    }

    private buildCanvasContextMenuHtml(
        target: CanvasPathContextTarget | null
    ): string {
        const items: string[] = [];

        if (target?.canSetStartNode) {
            items.push(`
                <div class="plugin-menu-item" data-action="set-start-node">
                    <span class="material-symbols-outlined">flag</span>
                    <span>Set as start node</span>
                </div>
            `);
        }

        if (target) {
            items.push(`
                <div class="plugin-menu-item" data-action="reverse-path-direction">
                    <span class="material-symbols-outlined">swap_horiz</span>
                    <span>Reverse path direction</span>
                </div>
            `);
        }

        if (!items.length) {
            items.push(`
                <div class="plugin-menu-item">
                    <span class="material-symbols-outlined">block</span>
                    <span>No path actions here</span>
                </div>
            `);
        }

        return `<div class="plugin-menu">${items.join('')}</div>`;
    }

    onContextMenu(e: MouseEvent): void {
        e.preventDefault();
        e.stopPropagation();

        const tippyInstance = this.ensureCanvasContextMenu();
        if (!tippyInstance) {
            return;
        }

        const rect = this.canvas?.getBoundingClientRect();
        const canvasPoint = rect
            ? this.glyphCanvas.toGlyphLocal(
                  e.clientX - rect.left,
                  e.clientY - rect.top
              )
            : this.transformMouseToComponentSpace();
        const clickedPoint = this.isEditingComponent()
            ? (() => {
                  const compTransform = this.getAccumulatedTransform();
                  const [a, b, c, d, tx, ty] = compTransform;
                  const det = a * d - b * c;

                  if (Math.abs(det) <= 0.0001) {
                      return {
                          x: canvasPoint.glyphX,
                          y: canvasPoint.glyphY
                      };
                  }

                  const localX = canvasPoint.glyphX - tx;
                  const localY = canvasPoint.glyphY - ty;
                  return {
                      x: (d * localX - c * localY) / det,
                      y: (a * localY - b * localX) / det
                  };
              })()
            : {
                  x: canvasPoint.glyphX,
                  y: canvasPoint.glyphY
              };

        this.canvasContextMenuTarget =
            this.buildCanvasContextMenuTarget(clickedPoint);

        tippyInstance.setProps({
            theme: getTheme(),
            content: this.buildCanvasContextMenuHtml(
                this.canvasContextMenuTarget
            ),
            getReferenceClientRect: () => ({
                width: 0,
                height: 0,
                top: e.clientY,
                bottom: e.clientY,
                left: e.clientX,
                right: e.clientX,
                x: e.clientX,
                y: e.clientY,
                toJSON: () => ({})
            })
        });

        tippyInstance.show();
    }

    private handleCanvasContextMenuAction(action: string): void {
        if (action === 'set-start-node') {
            this.setContextMenuPathStartNode();
            return;
        }

        if (action === 'reverse-path-direction') {
            this.reverseContextMenuPathDirection();
        }
    }

    private applyPathMutationAcrossLinkedLayers(
        pathIndex: number,
        label: string,
        mutate: (path: any, layerIndex?: number) => boolean
    ): boolean {
        const currentLayerModel = this.getCurrentLayerModel();
        const currentGlyphModel = this.getCurrentGlyphModel();
        if (!currentLayerModel || !currentGlyphModel) {
            return false;
        }

        const activePath = currentLayerModel.paths?.[pathIndex];
        if (!activePath) {
            return false;
        }

        const linkedLayers = currentLayerModel._getLinkedLayers?.() || [];
        let changed = false;

        withSuppressedModelRecording(() => {
            changed = mutate(activePath, 0);
            if (!changed) {
                return;
            }

            for (
                let layerIndex = 0;
                layerIndex < linkedLayers.length;
                layerIndex++
            ) {
                const linkedLayer = linkedLayers[layerIndex];
                const linkedPath = linkedLayer.paths?.[pathIndex];
                if (!linkedPath) {
                    continue;
                }
                mutate(linkedPath, layerIndex + 1);
            }
        });

        if (!changed) {
            return false;
        }

        const bridge = window.changeBridge;
        if (bridge && currentGlyphModel.name) {
            bridge.beginTransaction(label);
            try {
                bridge.syncGlyphFromJson(currentGlyphModel.name, label);
            } finally {
                bridge.endTransaction();
            }
        }

        this.syncCurrentExactLayerDataFromModel();

        const currentFont = fontManager.currentFont;
        if (currentFont) {
            currentFont.markDirty('keyboard-outline');
            void fontManager.updateDirtyIndicator();
        }

        this.performHitDetection(null);
        this.glyphCanvas.updatePropertyPanel();
        this.glyphCanvas.render();

        if (currentFont) {
            window.setTimeout(() => {
                if (fontManager.currentFont !== currentFont) {
                    return;
                }

                try {
                    currentFont.syncJsonFromModel();
                } catch (error) {
                    console.error(
                        '[OutlineEditor] Error syncing font JSON after path context menu action:',
                        error
                    );
                    return;
                }

                void fontManager.updateWorkerFontCache();
            }, 0);
        } else if (currentGlyphModel.name) {
            window.dispatchEvent(
                new CustomEvent('glyphChanged', {
                    detail: {
                        glyphName: currentGlyphModel.name,
                        layerId: this.getCurrentLayerId()
                    }
                })
            );
        }

        return true;
    }

    private setContextMenuPathStartNode(): boolean {
        const target = this.canvasContextMenuTarget;
        if (
            !target ||
            !target.canSetStartNode ||
            target.nodeIndex === null ||
            target.onCurveOrdinal === null ||
            target.onCurveOrdinal <= 0 ||
            !target.intendedPoint
        ) {
            return false;
        }

        const resolvedPathIndex = target.pathIndex;
        if (!Number.isInteger(resolvedPathIndex) || resolvedPathIndex < 0) {
            return false;
        }

        const currentLayerModel = this.getCurrentLayerModel();
        if (!currentLayerModel) {
            return false;
        }

        const linkedLayers = currentLayerModel._getLinkedLayers?.() || [];
        const layers = [currentLayerModel, ...linkedLayers];
        const mappedNodeIndicesByLayer: number[] = [];

        // Resolve active layer by coordinate proximity (intendedPoint in model space),
        // then derive the on-curve ordinal for linked-layer mapping.
        // This avoids relying on target.nodeIndex / target.onCurveOrdinal which were
        // captured from render data that may be out of sync after prior mutations.
        const activePath = currentLayerModel.paths?.[resolvedPathIndex];
        if (!activePath) {
            return false;
        }

        const activeModelIndex = this.getClosestOnCurveNodeIndex(
            activePath,
            target.intendedPoint as CanvasPoint,
            true
        );

        if (activeModelIndex === null || activeModelIndex <= 0) {
            return false;
        }

        mappedNodeIndicesByLayer[0] = activeModelIndex;

        // Derive on-curve ordinal from the resolved active-layer node.
        const activeNodes = activePath.nodes;
        const activeOrdinal = Array.isArray(activeNodes)
            ? activeNodes
                  .slice(0, activeModelIndex + 1)
                  .filter((n: any) => isOnCurveNode(n)).length - 1
            : -1;

        if (activeOrdinal < 0) {
            return false;
        }

        for (let layerIndex = 1; layerIndex < layers.length; layerIndex++) {
            const layer = layers[layerIndex];
            const path = layer?.paths?.[resolvedPathIndex];
            if (!path) {
                continue;
            }

            const mappedNodeIndex = this.getOnCurveNodeIndexByOrdinal(
                path,
                activeOrdinal,
                false
            );

            if (mappedNodeIndex === null) {
                continue;
            }

            mappedNodeIndicesByLayer[layerIndex] = mappedNodeIndex;
        }

        // Verify all layers have resolved indices before mutating.
        for (let i = 0; i < layers.length; i++) {
            if (mappedNodeIndicesByLayer[i] === undefined) {
                return false;
            }
        }

        const changed = this.applyPathMutationAcrossLinkedLayers(
            resolvedPathIndex,
            'Set start node',
            (path: any, layerIndex = 0) => {
                const mappedNodeIndex = mappedNodeIndicesByLayer[layerIndex];
                if (mappedNodeIndex === undefined || mappedNodeIndex <= 0) {
                    return mappedNodeIndex === 0;
                }

                return path?._setStartNode?.(mappedNodeIndex) ?? false;
            }
        );

        if (!changed) {
            return false;
        }

        this.selectedPoints = [
            {
                contourIndex: target.shapeIndex,
                nodeIndex: 0
            }
        ];
        this.selectedAnchors = [];
        this.selectedComponents = [];
        this.selectedGuideHandle = null;
        this.selectedSidebearingHandle = null;
        this.performHitDetection(null);
        this.glyphCanvas.updatePropertyPanel();
        this.glyphCanvas.render();
        return true;
    }

    private reverseContextMenuPathDirection(): boolean {
        const target = this.canvasContextMenuTarget;
        if (!target) {
            return false;
        }

        const resolvedPathIndex = target.pathIndex;
        if (!Number.isInteger(resolvedPathIndex) || resolvedPathIndex < 0) {
            return false;
        }

        const changed = this.applyPathMutationAcrossLinkedLayers(
            resolvedPathIndex,
            'Reverse path direction',
            (path: any) => path?._reverseDirection?.() ?? false
        );

        if (!changed) {
            return false;
        }

        this.selectedAnchors = [];
        this.selectedComponents = [];
        this.selectedGuideHandle = null;
        this.selectedSidebearingHandle = null;
        this.performHitDetection(null);
        this.glyphCanvas.updatePropertyPanel();
        this.glyphCanvas.render();
        return true;
    }

    private getSelectedOpenPathEndpointSeed(): ActivePathDrawingSession | null {
        if (this.selectedPoints.length !== 1) {
            return null;
        }

        const selectedPoint = this.selectedPoints[0];
        const currentLayerData = this.getCurrentLayerDataFromStack();
        const contour = getEditableContour(
            currentLayerData?.shapes?.[selectedPoint.contourIndex]
        );

        if (!contour || contour.closed || contour.nodes.length < 1) {
            return null;
        }

        if (
            selectedPoint.nodeIndex !== 0 &&
            selectedPoint.nodeIndex !== contour.nodes.length - 1
        ) {
            return null;
        }

        const pathIndex = this.getPathIndexForShapeIndex(
            selectedPoint.contourIndex
        );
        if (pathIndex === null) {
            return null;
        }

        return {
            shapeIndex: selectedPoint.contourIndex,
            pathIndex,
            edge: selectedPoint.nodeIndex === 0 ? 'start' : 'end',
            startedFromExistingPath: true,
            originNodeIndex: selectedPoint.nodeIndex,
            segmentCount: 0
        };
    }

    private getPathIndexForShapeIndex(shapeIndex: number): number | null {
        const currentLayerData = this.getCurrentLayerDataFromStack();
        const shapes = currentLayerData?.shapes;
        if (!shapes || shapeIndex < 0 || shapeIndex >= shapes.length) {
            return null;
        }

        let pathIndex = 0;
        for (let index = 0; index < shapes.length; index++) {
            if (!this.isPathShape(shapes[index])) {
                continue;
            }

            if (index === shapeIndex) {
                return pathIndex;
            }

            pathIndex += 1;
        }

        return null;
    }

    private getCommandPathPreviewSeed(): ActivePathDrawingSession | null {
        return (
            this.activePathDrawingSession ||
            this.getSelectedOpenPathEndpointSeed()
        );
    }

    private getCommandPathPreviewStartPoint(): { x: number; y: number } | null {
        const session = this.getCommandPathPreviewSeed();
        if (!session) {
            return null;
        }

        const currentLayerData = this.getCurrentLayerDataFromStack();
        const contour = getEditableContour(
            currentLayerData?.shapes?.[session.shapeIndex]
        );

        if (!contour?.nodes.length) {
            return null;
        }

        const nodeIndex =
            session.edge === 'start' ? 0 : contour.nodes.length - 1;
        const node = contour.nodes[nodeIndex];
        return node ? { x: node.x, y: node.y } : null;
    }

    shouldRenderCommandPathPreview(): boolean {
        return Boolean(
            this.active &&
            this.cmdKeyPressed &&
            !this.isPreviewMode &&
            this.getCommandPathPreviewStartPoint()
        );
    }

    getCommandPathPreviewLine(): {
        start: { x: number; y: number };
        end: { x: number; y: number };
    } | null {
        if (!this.shouldRenderCommandPathPreview()) {
            return null;
        }

        const start = this.getCommandPathPreviewStartPoint();
        if (!start) {
            return null;
        }

        const { glyphX, glyphY } = this.transformMouseToComponentSpace();
        return {
            start,
            end: {
                x: glyphX,
                y: glyphY
            }
        };
    }

    getCommandPathPreviewContourIndex(): number | null {
        return this.getCommandPathPreviewSeed()?.shapeIndex ?? null;
    }

    private shouldShowCommandPathCrosshair(): boolean {
        if (!this.active || !this.cmdKeyPressed || this.isPreviewMode) {
            return false;
        }

        if (this.getCommandPathPreviewSeed()) {
            return true;
        }

        return this.isNeutralCommandCanvasTarget();
    }

    private startNewPathDrawingSession(): boolean {
        const currentLayerData = this.getCurrentLayerDataFromStack();
        const currentLayerModel = this.getCurrentLayerModel();

        if (!currentLayerData || !currentLayerModel) {
            return false;
        }

        const { glyphX, glyphY } = this.transformMouseToComponentSpace();
        const snappedStart = { x: Math.round(glyphX), y: Math.round(glyphY) };
        const linkedLayers = currentLayerModel._getLinkedLayers?.() || [];
        let activePath = null;

        withSuppressedModelRecording(() => {
            activePath = currentLayerModel.addPath(false);
            activePath?._appendLine(snappedStart);

            for (const linkedLayer of linkedLayers) {
                const linkedPath = linkedLayer.addPath(false);
                linkedPath._appendLine(snappedStart);
            }
        });

        const pathIndex = currentLayerModel.paths.length - 1;
        const shapeIndex = (currentLayerModel.shapes?.length || 1) - 1;
        this.notePendingCommandPathEdit('draw');
        this.activePathDrawingSession = {
            shapeIndex,
            pathIndex,
            edge: 'end',
            startedFromExistingPath: false,
            originNodeIndex: 0,
            segmentCount: 0
        };

        this.syncCurrentContourDataFromModel(pathIndex, shapeIndex);
        this.selectedPoints = [{ contourIndex: shapeIndex, nodeIndex: 0 }];
        this.selectedAnchors = [];
        this.selectedComponents = [];
        this.selectedGuideHandle = null;
        this.selectedSidebearingHandle = null;
        this.performHitDetection(null);
        this.glyphCanvas.updatePropertyPanel();
        this.glyphCanvas.render();
        return !!activePath;
    }

    private appendLineToPathSession(
        session: ActivePathDrawingSession,
        point: { x: number; y: number }
    ): boolean {
        const currentLayerModel = this.getCurrentLayerModel();
        if (!currentLayerModel) {
            return false;
        }

        const activePath = currentLayerModel.paths?.[session.pathIndex];
        if (!activePath) {
            return false;
        }

        const linkedLayers = currentLayerModel._getLinkedLayers?.() || [];
        const snappedPoint = {
            x: Math.round(point.x),
            y: Math.round(point.y)
        };
        let insertedNodeIndex: number | null = null;

        withSuppressedModelRecording(() => {
            insertedNodeIndex = activePath._appendLine(
                snappedPoint,
                session.edge
            );

            for (const linkedLayer of linkedLayers) {
                const linkedPath = linkedLayer.paths?.[session.pathIndex];
                linkedPath?._appendLine(snappedPoint, session.edge);
            }
        });

        if (insertedNodeIndex === null) {
            return false;
        }

        this.notePendingCommandPathEdit('draw');
        this.activePathDrawingSession = {
            ...session,
            segmentCount: session.segmentCount + 1
        };
        this.syncCurrentContourDataFromModel(
            session.pathIndex,
            session.shapeIndex
        );
        this.selectedPoints = [
            {
                contourIndex: session.shapeIndex,
                nodeIndex: insertedNodeIndex
            }
        ];
        this.selectedAnchors = [];
        this.selectedComponents = [];
        this.selectedGuideHandle = null;
        this.selectedSidebearingHandle = null;
        this.performHitDetection(null);
        this.glyphCanvas.updatePropertyPanel();
        this.glyphCanvas.render();
        return true;
    }

    private closeActivePathDrawingSession(
        session: ActivePathDrawingSession
    ): boolean {
        const currentLayerModel = this.getCurrentLayerModel();
        if (!currentLayerModel) {
            return false;
        }

        const activePath = currentLayerModel.paths?.[session.pathIndex];
        if (!activePath) {
            return false;
        }

        const linkedLayers = currentLayerModel._getLinkedLayers?.() || [];
        let changed = false;

        withSuppressedModelRecording(() => {
            changed = activePath._closeOpenPath();
            if (!changed) {
                return;
            }

            for (const linkedLayer of linkedLayers) {
                const linkedPath = linkedLayer.paths?.[session.pathIndex];
                linkedPath?._closeOpenPath();
            }
        });

        if (!changed) {
            return false;
        }

        this.notePendingCommandPathEdit('draw');
        this.activePathDrawingSession = null;
        this.syncCurrentContourDataFromModel(
            session.pathIndex,
            session.shapeIndex
        );
        this.selectedPoints = [
            {
                contourIndex: session.shapeIndex,
                nodeIndex: session.originNodeIndex
            }
        ];
        this.selectedAnchors = [];
        this.selectedComponents = [];
        this.selectedGuideHandle = null;
        this.selectedSidebearingHandle = null;
        this.performHitDetection(null);
        this.glyphCanvas.updatePropertyPanel();
        this.glyphCanvas.render();
        return true;
    }

    private convertLineSegmentToCurve(hit: PathSegmentHit): boolean {
        const currentLayerModel = this.getCurrentLayerModel();
        if (!currentLayerModel) {
            return false;
        }

        const activePath = currentLayerModel.paths?.[hit.pathIndex];
        if (!activePath) {
            return false;
        }

        const linkedLayers = currentLayerModel._getLinkedLayers?.() || [];
        const roundPathNodesToGrid = (
            path: { nodes?: Babelfont.Node[] } | null | undefined
        ): void => {
            if (!path?.nodes) {
                return;
            }

            for (const node of path.nodes) {
                node.x = Math.round(node.x);
                node.y = Math.round(node.y);
            }
        };
        let changed = false;

        withSuppressedModelRecording(() => {
            changed = activePath._convertLineSegmentToCurve(
                hit.descriptor.segmentId
            );
            if (!changed) {
                return;
            }
            roundPathNodesToGrid(activePath);

            for (const linkedLayer of linkedLayers) {
                const linkedPath = linkedLayer.paths?.[hit.pathIndex];
                linkedPath?._convertLineSegmentToCurve(
                    hit.descriptor.segmentId
                );
                roundPathNodesToGrid(linkedPath);
            }
        });

        if (!changed) {
            return false;
        }

        this.notePendingCommandPathEdit('convert');
        this.activePathDrawingSession = null;
        this.syncCurrentContourDataFromModel(hit.pathIndex, hit.shapeIndex);
        this.performHitDetection(null);
        this.glyphCanvas.updatePropertyPanel();
        this.glyphCanvas.render();
        return true;
    }

    private openClosedPathAtNode(point: Point): boolean {
        const currentLayerModel = this.getCurrentLayerModel();
        const currentGlyphModel = this.getCurrentGlyphModel();
        if (!currentLayerModel || !currentGlyphModel) {
            return false;
        }

        const activePath = currentLayerModel.paths?.[point.contourIndex];
        if (!activePath || !activePath.closed) {
            return false;
        }

        const linkedLayers = currentLayerModel._getLinkedLayers?.() || [];
        let changed = false;

        withSuppressedModelRecording(() => {
            changed = activePath._openClosedPathAtNode(point.nodeIndex);
            if (!changed) {
                return;
            }

            for (const linkedLayer of linkedLayers) {
                const linkedPath = linkedLayer.paths?.[point.contourIndex];
                linkedPath?._openClosedPathAtNode(point.nodeIndex);
            }
        });

        if (!changed) {
            return false;
        }

        const bridge = window.changeBridge;
        if (bridge && currentGlyphModel.name) {
            bridge.beginTransaction('Open path');
            try {
                bridge.syncGlyphFromJson(currentGlyphModel.name, 'Open path');
            } finally {
                bridge.endTransaction();
            }
        }

        this.syncCurrentExactLayerDataFromModel();

        const currentFont = fontManager.currentFont;
        if (currentFont) {
            currentFont.markDirty('keyboard-outline');
            void fontManager.updateDirtyIndicator();
        }

        // Select only the new end node (the duplicate at the end)
        const newPath = currentLayerModel.paths?.[point.contourIndex];
        const lastNodeIndex = newPath ? newPath.nodes.length - 1 : 0;
        this.selectedPoints = [
            {
                contourIndex: point.contourIndex,
                nodeIndex: lastNodeIndex
            }
        ];
        this.selectedAnchors = [];
        this.selectedComponents = [];
        this.selectedGuideHandle = null;
        this.selectedSidebearingHandle = null;
        this.performHitDetection(null);
        this.glyphCanvas.updatePropertyPanel();
        this.glyphCanvas.render();

        if (currentFont) {
            window.setTimeout(() => {
                if (fontManager.currentFont !== currentFont) {
                    return;
                }

                try {
                    currentFont.syncJsonFromModel();
                } catch (error) {
                    console.error(
                        '[OutlineEditor] Error syncing font JSON after opening path:',
                        error
                    );
                    return;
                }

                void fontManager.updateWorkerFontCache();
            }, 0);
        } else if (currentGlyphModel.name) {
            window.dispatchEvent(
                new CustomEvent('glyphChanged', {
                    detail: {
                        glyphName: currentGlyphModel.name,
                        layerId: this.getCurrentLayerId()
                    }
                })
            );
        }
        return true;
    }

    private closeOpenPathByMerge(
        contourIndex: number,
        reuseTransaction: boolean = false
    ): boolean {
        const currentLayerModel = this.getCurrentLayerModel();
        const currentGlyphModel = this.getCurrentGlyphModel();
        if (!currentLayerModel || !currentGlyphModel) {
            return false;
        }

        const activePath = currentLayerModel.paths?.[contourIndex];
        if (!activePath || activePath.closed) {
            return false;
        }

        const linkedLayers = currentLayerModel._getLinkedLayers?.() || [];
        let changed = false;

        withSuppressedModelRecording(() => {
            changed = activePath._closeOpenPathByMerge();
            if (!changed) {
                return;
            }

            for (const linkedLayer of linkedLayers) {
                const linkedPath = linkedLayer.paths?.[contourIndex];
                linkedPath?._closeOpenPathByMerge();
            }
        });

        if (!changed) {
            return false;
        }

        const currentFont = fontManager.currentFont;
        const bboxCenterAnchorScreen =
            this.getBoundingBoxCenterScreenPosition();
        const affectedGlyphNames = this.recomputeMetricsKeysForGlyph(
            currentGlyphModel.name
        );

        // Sync JSON and update worker cache immediately (before endTransaction fires
        // dirty callbacks and before updatePropertyPanel triggers fetchLayerData →
        // interpolateGlyph). This ensures the Rust worker has up-to-date glyph data
        // for ALL masters when it processes the interpolation request, preventing
        // GlyphNotInterpolatable. Use forceFullWorkerCacheUpdate to bypass incremental
        // single-layer optimisations — close-path patches all linked masters at once.
        if (currentFont) {
            try {
                currentFont.syncJsonFromModel();
            } catch (error) {
                console.error(
                    '[OutlineEditor] Error syncing font JSON after closing path:',
                    error
                );
            }
            fontManager.lastChangeSource = 'close-open-path';
            fontManager.lastEditType = null;
            void fontManager.forceFullWorkerCacheUpdate().then(() => {
                for (const glyphName of affectedGlyphNames) {
                    if (glyphName === currentGlyphModel.name) {
                        continue;
                    }
                    window.dispatchEvent(
                        new CustomEvent('glyphChanged', {
                            detail: {
                                glyphName,
                                layerId: this.getCurrentLayerId()
                            }
                        })
                    );
                }
            });
        }

        const bridge = window.changeBridge;
        if (bridge && currentGlyphModel.name) {
            if (!reuseTransaction) {
                bridge.beginTransaction('Close path');
            }
            try {
                bridge.syncGlyphFromJson(currentGlyphModel.name, 'Close path');
            } finally {
                bridge.endTransaction();
            }
        }

        this.refreshKeyedMetricsViewportAnchor(
            affectedGlyphNames,
            bboxCenterAnchorScreen
        );

        if (currentFont) {
            currentFont.markDirty('close-open-path');
            void fontManager.updateDirtyIndicator();
        }

        this.selectedPoints = [{ contourIndex, nodeIndex: 0 }];
        this.selectedAnchors = [];
        this.selectedComponents = [];
        this.selectedGuideHandle = null;
        this.selectedSidebearingHandle = null;
        this.performHitDetection(null);
        this.glyphCanvas.updatePropertyPanel();
        this.glyphCanvas.render();

        if (!currentFont && currentGlyphModel.name) {
            window.dispatchEvent(
                new CustomEvent('glyphChanged', {
                    detail: {
                        glyphName: currentGlyphModel.name,
                        layerId: this.getCurrentLayerId()
                    }
                })
            );
        }
        return true;
    }

    private notePendingCommandPathEdit(kind: 'draw' | 'convert'): void {
        if (!this.pendingCommandPathEdit) {
            this.pendingCommandPathEdit = {
                didDraw: false,
                didConvertLine: false
            };
        }

        if (kind === 'draw') {
            this.pendingCommandPathEdit.didDraw = true;
        } else {
            this.pendingCommandPathEdit.didConvertLine = true;
        }
    }

    private finalizePendingCommandPathEdit(): void {
        const pendingEdit = this.pendingCommandPathEdit;
        this.activePathDrawingSession = null;
        this.pendingCommandPathEdit = null;

        if (!pendingEdit) {
            return;
        }

        const currentGlyphModel = this.getCurrentGlyphModel();
        const currentFont = fontManager.currentFont;
        const layerId = this.getCurrentLayerId();
        const bridge = window.changeBridge;
        const bboxCenterAnchorScreen =
            this.getBoundingBoxCenterScreenPosition();
        const affectedGlyphNames = this.recomputeMetricsKeysForGlyph(
            currentGlyphModel?.name
        );
        const label = pendingEdit.didDraw
            ? pendingEdit.didConvertLine
                ? 'Edit path'
                : 'Draw path'
            : pendingEdit.didConvertLine
              ? 'Convert line to curve'
              : null;

        if (!label) {
            return;
        }

        if (bridge && currentGlyphModel?.name) {
            bridge.beginTransaction(label);
            try {
                bridge.syncGlyphFromJson(currentGlyphModel.name, label);
            } finally {
                bridge.endTransaction();
            }
        }

        if (currentFont) {
            currentFont.markDirty('keyboard-outline');
            void fontManager.updateDirtyIndicator();

            window.setTimeout(() => {
                if (fontManager.currentFont !== currentFont) {
                    return;
                }

                try {
                    currentFont.syncJsonFromModel();
                } catch (error) {
                    console.error(
                        '[OutlineEditor] Error syncing font JSON after modifier path edit:',
                        error
                    );
                    return;
                }

                void fontManager.updateWorkerFontCache().then(() => {
                    for (const glyphName of affectedGlyphNames) {
                        if (glyphName === currentGlyphModel?.name) {
                            continue;
                        }
                        window.dispatchEvent(
                            new CustomEvent('glyphChanged', {
                                detail: {
                                    glyphName,
                                    layerId
                                }
                            })
                        );
                    }
                });
            }, 0);
        } else if (currentGlyphModel?.name) {
            window.dispatchEvent(
                new CustomEvent('glyphChanged', {
                    detail: {
                        glyphName: currentGlyphModel.name,
                        layerId
                    }
                })
            );
        }

        this.refreshKeyedMetricsViewportAnchor(
            affectedGlyphNames,
            bboxCenterAnchorScreen
        );
        this.performHitDetection(null);
        this.glyphCanvas.updatePropertyPanel();
        this.glyphCanvas.render();
    }

    onGlyphSelected() {
        // Perform mouse hit detection for objects at current mouse position
        if (this.active && this.selectedLayerId && this.layerData) {
            this.updateHoveredGuideHandle();
            this.updateHoveredComponent();
            this.updateHoveredAnchor();
            this.updateHoveredPoint();
            this.updateHoveredAddPointPreview();
        }
    }

    private syncCurrentContourDataFromModel(
        pathIndex: number,
        shapeIndex: number = pathIndex
    ): void {
        const currentLayerData = this.getCurrentLayerDataFromStack();
        const currentLayerModel = this.getCurrentLayerModel();
        const path = currentLayerModel?.paths?.[pathIndex];
        const shape = currentLayerData?.shapes?.[shapeIndex];
        const contour = getPathShapeData(shape);

        if (!currentLayerData || !path) {
            return;
        }

        const pathData = path.toJSON();
        const normalizedNodes =
            typeof pathData.nodes === 'string'
                ? LayerDataNormalizer.parseNodes(pathData.nodes)
                : Array.isArray(pathData.nodes)
                  ? pathData.nodes
                  : [];
        const normalizedPathData: Babelfont.Path = {
            ...pathData,
            nodes: normalizedNodes.map((node: Babelfont.Node) => ({
                ...node
            })),
            closed: Boolean(pathData.closed)
        };

        if (!contour || typeof contour !== 'object') {
            if (!currentLayerData.shapes) {
                currentLayerData.shapes = [];
            }

            currentLayerData.shapes.splice(shapeIndex, 0, normalizedPathData);
            return;
        }

        contour.nodes = normalizedPathData.nodes;
        contour.closed = normalizedPathData.closed;
    }

    private syncCurrentExactLayerDataFromModel(): void {
        const currentLayerData = this.getCurrentLayerDataFromStack();
        const currentLayerModel = this.getCurrentLayerModel();

        if (!currentLayerData || !currentLayerModel) {
            return;
        }

        const exactNormalized = LayerDataNormalizer.normalize(
            currentLayerModel.toJSON(),
            false
        );

        if (!exactNormalized) {
            return;
        }

        if (exactNormalized.shapes && currentLayerData.shapes?.length) {
            exactNormalized.shapes = this.mergeSelectedLayerShapes(
                exactNormalized.shapes,
                currentLayerData.shapes
            );
        }

        for (const key of Object.keys(currentLayerData)) {
            if (!(key in exactNormalized)) {
                delete (currentLayerData as Record<string, any>)[key];
            }
        }

        Object.assign(currentLayerData, exactNormalized);
        parseComponentNodes(currentLayerData.shapes || []);
    }

    private canSlideSmoothPointOnCurve(point: Point): boolean {
        const currentLayerModel = this.getCurrentLayerModel();
        const path = currentLayerModel?.paths?.[point.contourIndex];
        return Boolean(path?._canSlideSmoothOnCurve?.(point.nodeIndex));
    }

    private slideSelectedSmoothPointAlongCurve(
        pointerX: number,
        pointerY: number
    ): boolean {
        if (this.selectedPoints.length !== 1) {
            return false;
        }

        const currentLayerModel = this.getCurrentLayerModel();
        const currentPoint = this.selectedPoints[0];
        const activePath =
            currentLayerModel?.paths?.[currentPoint.contourIndex];

        if (!activePath) {
            return false;
        }

        const linkedLayers = currentLayerModel._getLinkedLayers?.() || [];
        let result: {
            insertedNodeIndex: number;
            changed: boolean;
            t: number;
        } | null = null;

        withSuppressedModelRecording(() => {
            result = activePath._slideSmoothOnCurve(currentPoint.nodeIndex, {
                x: pointerX,
                y: pointerY
            });

            if (!result) {
                return;
            }

            for (const linkedLayer of linkedLayers) {
                const linkedPath =
                    linkedLayer.paths?.[currentPoint.contourIndex];
                if (!linkedPath) {
                    continue;
                }

                linkedPath._slideSmoothOnCurveAtT(
                    currentPoint.nodeIndex,
                    result.t
                );
            }
        });

        const slideResult = result as {
            insertedNodeIndex: number;
            changed: boolean;
            t: number;
        } | null;

        if (!slideResult) {
            return false;
        }

        this.syncCurrentContourDataFromModel(currentPoint.contourIndex);
        this.selectedPoints = [
            {
                contourIndex: currentPoint.contourIndex,
                nodeIndex: slideResult.insertedNodeIndex
            }
        ];

        return slideResult.changed;
    }

    moveSelectedPoints(
        deltaX: number,
        deltaY: number,
        preserveHandlePositions: boolean = false
    ): void {
        // Move all selected points by the given delta
        const currentLayerData = this.getCurrentLayerDataFromStack();
        if (
            !currentLayerData ||
            !currentLayerData.shapes ||
            this.selectedPoints.length === 0
        ) {
            return;
        }

        this.applySelectedPointMove(
            currentLayerData,
            deltaX,
            deltaY,
            preserveHandlePositions
        );

        this.applyMetricsKeysToCurrentEditedLayer();

        // Save to object model (non-blocking)
        this.saveLayerData('keyboard-outline');
        this.glyphCanvas.updatePropertyPanel();
        this.glyphCanvas.render();
    }

    moveSelectedAnchors(deltaX: number, deltaY: number): void {
        // Move all selected anchors by the given delta
        const currentLayerData = this.getCurrentLayerDataFromStack();
        if (
            !currentLayerData ||
            !currentLayerData.anchors ||
            this.selectedAnchors.length === 0
        ) {
            return;
        }

        for (const anchorIndex of this.selectedAnchors) {
            const anchor = currentLayerData.anchors[anchorIndex];
            if (anchor) {
                anchor.x += deltaX;
                anchor.y += deltaY;
            }
        }

        // Save to object model (non-blocking)
        this.saveLayerData('keyboard-anchor');
        this.glyphCanvas.render();
    }

    moveSelectedComponents(deltaX: number, deltaY: number): void {
        // Move all selected components by the given delta
        if (
            !this.layerData ||
            !this.layerData.shapes ||
            this.selectedComponents.length === 0
        ) {
            return;
        }

        for (const compIndex of this.selectedComponents) {
            const shape = this.layerData.shapes[compIndex];
            if (shape && 'reference' in shape) {
                if (!shape.transform) {
                    // Initialize transform if it doesn't exist
                    shape.transform = identityDecomposed();
                } else if (Array.isArray(shape.transform)) {
                    // Convert legacy array format to DecomposedAffine before mutating
                    shape.transform = DecomposedAffineTransform.fromAffine(
                        shape.transform
                    );
                }
                const transform = shape.transform as Babelfont.DecomposedAffine;
                if (!transform.translation) transform.translation = [0, 0];
                transform.translation[0] += deltaX;
                transform.translation[1] += deltaY;
            }
        }

        this.applyMetricsKeysToCurrentEditedLayer();

        // Save to object model (non-blocking)
        this.saveLayerData('keyboard-outline');
        this.glyphCanvas.updatePropertyPanel();
        this.glyphCanvas.render();
    }

    private getCurrentDirectSidebearing(side: 'left' | 'right'): number | null {
        const currentLayerData = this.getCurrentLayerDataFromStack();
        if (!currentLayerData || currentLayerData.isInterpolated) {
            return null;
        }

        const bounds = Layer.calculateBoundingBox(
            currentLayerData,
            false,
            fontManager.currentFont?.fontModel,
            currentLayerData.master?.master
        );

        if (side === 'left') {
            return bounds ? bounds.minX : 0;
        }

        return bounds
            ? (currentLayerData.width || 0) - bounds.maxX
            : currentLayerData.width || 0;
    }

    private getDirectSidebearingsForLayerData(layerData: {
        width?: number;
        master?: { master?: string } | null;
    }): { left: number; right: number } {
        const bounds = Layer.calculateBoundingBox(
            layerData,
            false,
            fontManager.currentFont?.fontModel,
            layerData.master?.master
        );
        const width = Number(layerData.width) || 0;

        return {
            left: bounds ? bounds.minX : 0,
            right: bounds ? width - bounds.maxX : width
        };
    }

    private inferEditedSideFromSidebearingDelta(
        previousSidebearings: { left: number; right: number },
        nextSidebearings: { left: number; right: number }
    ): SidebearingSide | null {
        const epsilon = 0.01;
        const leftDelta = Math.abs(
            nextSidebearings.left - previousSidebearings.left
        );
        const rightDelta = Math.abs(
            nextSidebearings.right - previousSidebearings.right
        );

        if (leftDelta <= epsilon && rightDelta <= epsilon) {
            return null;
        }
        if (leftDelta > rightDelta + epsilon) {
            return 'left';
        }
        if (rightDelta > leftDelta + epsilon) {
            return 'right';
        }

        return null;
    }

    private applySidebearingDelta(
        side: 'left' | 'right',
        sidebearingDelta: number
    ): boolean {
        if (sidebearingDelta === 0) {
            return false;
        }

        const currentLayerData = this.getCurrentLayerDataFromStack();
        if (!currentLayerData || currentLayerData.isInterpolated) {
            return false;
        }

        const previousWidth = currentLayerData.width;

        if (side === 'left') {
            translateLayerContentsX(
                {
                    shapes: currentLayerData.shapes || [],
                    anchors: currentLayerData.anchors || [],
                    getPathNodes: (shape) => {
                        const pathData = getPathShapeData(shape);
                        if (
                            !pathData ||
                            typeof pathData !== 'object' ||
                            !('nodes' in pathData) ||
                            !pathData.nodes
                        ) {
                            return null;
                        }

                        if (typeof pathData.nodes === 'string') {
                            pathData.nodes = LayerDataNormalizer.parseNodes(
                                pathData.nodes
                            );
                        }

                        return pathData.nodes as Babelfont.Node[];
                    },
                    getOrCreateComponentTransform: (shape) => {
                        const componentData = getComponentShapeData(shape);
                        if (
                            !componentData ||
                            typeof componentData !== 'object' ||
                            !('reference' in componentData)
                        ) {
                            return null;
                        }

                        if (!componentData.transform) {
                            componentData.transform = identityDecomposed();
                        } else if (Array.isArray(componentData.transform)) {
                            componentData.transform =
                                DecomposedAffineTransform.fromAffine(
                                    componentData.transform
                                );
                        }

                        return componentData.transform as Babelfont.DecomposedAffine;
                    },
                    shiftAnchor: (anchor, deltaX) => {
                        anchor.x += deltaX;
                    }
                },
                sidebearingDelta
            );
        }

        currentLayerData.width =
            (currentLayerData.width || 0) + sidebearingDelta;

        const metricsUpdate = this.applyMetricsKeysToCurrentEditedLayer(false);
        const parsed = this.parseGlyphStack();
        const glyphName =
            metricsUpdate?.glyphName ||
            (parsed.length > 0
                ? parsed[parsed.length - 1].glyphName
                : this.glyphCanvas.getCurrentGlyphName());

        const { widthDelta } = applyLiveSidebearingVisualSync(
            this.glyphCanvas,
            {
                glyphName,
                glyphAdvances: metricsUpdate?.glyphAdvances,
                side,
                previousWidth,
                nextWidth:
                    metricsUpdate?.nextWidth || currentLayerData.width || 0,
                render: false
            }
        );

        if (
            side === 'left' &&
            this.isDraggingSidebearing &&
            this.lastGlyphX !== null
        ) {
            this.lastGlyphX += widthDelta;
        }

        return true;
    }

    setSidebearingValue(side: 'left' | 'right', targetValue: number): boolean {
        const currentSidebearing = this.getCurrentDirectSidebearing(side);
        if (currentSidebearing === null) {
            return false;
        }

        if (
            !this.applySidebearingDelta(side, targetValue - currentSidebearing)
        ) {
            return false;
        }

        this.saveLayerData('keyboard-outline');
        this._syncCurrentGlyphToYDoc(
            'Set sidebearing',
            formatSidebearingHistoryValue(side, currentSidebearing),
            formatSidebearingHistoryValue(side, targetValue)
        );
        return true;
    }

    private adjustSelectedSidebearing(deltaX: number): boolean {
        if (!this.selectedSidebearingHandle || deltaX === 0) {
            return false;
        }

        const side = this.selectedSidebearingHandle.side;
        const sidebearingDelta = side === 'left' ? -deltaX : deltaX;

        return this.applySidebearingDelta(side, sidebearingDelta);
    }

    moveSelectedSidebearing(deltaX: number): void {
        if (!this.adjustSelectedSidebearing(deltaX)) {
            return;
        }

        this.saveLayerData('keyboard-outline');
        this.glyphCanvas.updatePropertyPanel();
        this.glyphCanvas.render();
    }

    _updateDraggedSidebearing(deltaX: number): void {
        if (!this.isDraggingSidebearing) {
            return;
        }

        this.adjustSelectedSidebearing(deltaX);
    }

    private applySelectedPointMove(
        currentLayerData: Babelfont.Layer,
        deltaX: number,
        deltaY: number,
        preserveHandlePositions: boolean = false,
        snapSmoothHandleTriplet: boolean = false,
        pointerX?: number,
        pointerY?: number
    ): void {
        const contourCache = new Map<number, EditableContour | null>();
        const getContourData = (
            contourIndex: number
        ): EditableContour | null => {
            if (!contourCache.has(contourIndex)) {
                contourCache.set(
                    contourIndex,
                    getEditableContour(currentLayerData.shapes?.[contourIndex])
                );
            }
            return contourCache.get(contourIndex) || null;
        };

        const selectedPointKeys = new Set(
            this.selectedPoints.map(
                ({ contourIndex, nodeIndex }) => `${contourIndex}:${nodeIndex}`
            )
        );
        const smoothAnchorsToRealign = new Set<string>();

        for (const { contourIndex, nodeIndex } of this.selectedPoints) {
            const contour = getContourData(contourIndex);
            const node = contour?.nodes[nodeIndex];
            if (!contour || !node || !isOnCurveNode(node)) {
                continue;
            }

            const prevIndex = getNeighborNodeIndex(
                nodeIndex,
                -1,
                contour.nodes.length,
                contour.closed
            );
            const nextIndex = getNeighborNodeIndex(
                nodeIndex,
                1,
                contour.nodes.length,
                contour.closed
            );

            if (
                prevIndex !== null &&
                isOffCurveNode(contour.nodes[prevIndex])
            ) {
                selectedPointKeys.delete(`${contourIndex}:${prevIndex}`);
            }
            if (
                nextIndex !== null &&
                isOffCurveNode(contour.nodes[nextIndex])
            ) {
                selectedPointKeys.delete(`${contourIndex}:${nextIndex}`);
            }
        }

        for (const { contourIndex, nodeIndex } of this.selectedPoints) {
            if (!selectedPointKeys.has(`${contourIndex}:${nodeIndex}`)) {
                continue;
            }

            const contour = getContourData(contourIndex);
            const node = contour?.nodes[nodeIndex];
            if (!contour || !node) {
                continue;
            }

            const adjustedDelta =
                preserveHandlePositions && isOnCurveNode(node)
                    ? getAltAnchorMoveDelta(contour, nodeIndex, deltaX, deltaY)
                    : { deltaX, deltaY };

            if (adjustedDelta.deltaX === 0 && adjustedDelta.deltaY === 0) {
                continue;
            }

            moveNodeByDelta(node, adjustedDelta.deltaX, adjustedDelta.deltaY);

            if (
                isOnCurveNode(node) &&
                node.smooth &&
                !preserveHandlePositions
            ) {
                smoothAnchorsToRealign.add(`${contourIndex}:${nodeIndex}`);
            }

            if (!isOffCurveNode(node)) {
                const prevIndexForAlignment = getNeighborNodeIndex(
                    nodeIndex,
                    -1,
                    contour.nodes.length,
                    contour.closed
                );
                const nextIndexForAlignment = getNeighborNodeIndex(
                    nodeIndex,
                    1,
                    contour.nodes.length,
                    contour.closed
                );

                if (
                    prevIndexForAlignment !== null &&
                    isOnCurveNode(contour.nodes[prevIndexForAlignment]) &&
                    contour.nodes[prevIndexForAlignment].smooth
                ) {
                    smoothAnchorsToRealign.add(
                        `${contourIndex}:${prevIndexForAlignment}`
                    );
                }
                if (
                    nextIndexForAlignment !== null &&
                    isOnCurveNode(contour.nodes[nextIndexForAlignment]) &&
                    contour.nodes[nextIndexForAlignment].smooth
                ) {
                    smoothAnchorsToRealign.add(
                        `${contourIndex}:${nextIndexForAlignment}`
                    );
                }
            }

            if (isOffCurveNode(node) || preserveHandlePositions) {
                continue;
            }

            const prevIndex = getNeighborNodeIndex(
                nodeIndex,
                -1,
                contour.nodes.length,
                contour.closed
            );
            const nextIndex = getNeighborNodeIndex(
                nodeIndex,
                1,
                contour.nodes.length,
                contour.closed
            );

            if (
                prevIndex !== null &&
                isOffCurveNode(contour.nodes[prevIndex])
            ) {
                moveNodeByDelta(
                    contour.nodes[prevIndex],
                    adjustedDelta.deltaX,
                    adjustedDelta.deltaY
                );
            }
            if (
                nextIndex !== null &&
                isOffCurveNode(contour.nodes[nextIndex])
            ) {
                moveNodeByDelta(
                    contour.nodes[nextIndex],
                    adjustedDelta.deltaX,
                    adjustedDelta.deltaY
                );
            }
        }

        for (const anchorKey of smoothAnchorsToRealign) {
            const [contourIndexString, anchorIndexString] =
                anchorKey.split(':');
            const contourIndex = Number(contourIndexString);
            const anchorIndex = Number(anchorIndexString);
            const contour = getContourData(contourIndex);
            if (contour) {
                realignSmoothHandles(contour, anchorIndex);
            }
        }

        if (this.selectedPoints.length === 1) {
            const { contourIndex, nodeIndex } = this.selectedPoints[0];
            const contour = getContourData(contourIndex);
            if (contour) {
                realignOppositeSmoothHandle(contour, nodeIndex);
                if (
                    snapSmoothHandleTriplet &&
                    pointerX !== undefined &&
                    pointerY !== undefined
                ) {
                    snapSmoothHandleTripletToAxis(
                        contour,
                        nodeIndex,
                        pointerX,
                        pointerY
                    );
                }
            }
        }
    }

    private togglePointSmoothSelection(points: Point[]): void {
        const currentLayerData = this.getCurrentLayerDataFromStack();
        if (!currentLayerData || !currentLayerData.shapes) {
            return;
        }

        const contourCache = new Map<number, EditableContour | null>();
        const getContourData = (
            contourIndex: number
        ): EditableContour | null => {
            if (!contourCache.has(contourIndex)) {
                contourCache.set(
                    contourIndex,
                    getEditableContour(currentLayerData.shapes?.[contourIndex])
                );
            }
            return contourCache.get(contourIndex) || null;
        };

        let changed = false;
        for (const point of points) {
            const contour = getContourData(point.contourIndex);
            const node = contour?.nodes[point.nodeIndex];
            if (!contour || !node || isOffCurveNode(node)) {
                continue;
            }

            node.smooth = !node.smooth;
            if (node.smooth) {
                realignSmoothHandlesForToggle(contour, point.nodeIndex);
            }
            changed = true;
        }

        if (!changed) {
            return;
        }

        this.saveLayerData('keyboard');
        this._syncCurrentGlyphToYDoc('Toggle smooth');
        this.glyphCanvas.updatePropertyPanel();
        this.glyphCanvas.render();
    }

    togglePointSmooth(pointIndex: Point): void {
        this.togglePointSmoothSelection([pointIndex]);
    }

    /**
     * Delete selected nodes with proper segment merging across all linked layers.
     * Handles off-curve nodes (converts to line), on-curve nodes with various
     * neighbor configurations (line-line, line-curve, curve-curve).
     */
    async deleteSelectedNodes(): Promise<void> {
        const currentLayerModel = this.getCurrentLayerModel();
        const currentGlyphModel = this.getCurrentGlyphModel();
        const currentLayerData = this.getCurrentLayerDataFromStack();
        const hasPointSelection = this.selectedPoints.length > 0;
        const hasAnchorSelection = this.selectedAnchors.length > 0;
        const hasGuideSelection = this.selectedGuideHandle !== null;

        if (
            !currentLayerModel ||
            !currentGlyphModel ||
            !currentLayerData ||
            (!hasPointSelection && !hasAnchorSelection && !hasGuideSelection)
        ) {
            return;
        }

        // Group selected points by path/contour
        const pointsByPath = new Map<number, number[]>();
        for (const point of this.selectedPoints) {
            const indices = pointsByPath.get(point.contourIndex) || [];
            indices.push(point.nodeIndex);
            pointsByPath.set(point.contourIndex, indices);
        }

        const linkedLayers = currentLayerModel._getLinkedLayers?.() || [];
        const bridge = window.changeBridge;
        const fullContourIndices = new Set<number>();

        // Sort indices in descending order for each path (to maintain validity during deletion)
        for (const [pathIndex, nodeIndices] of pointsByPath) {
            const contour = getEditableContour(
                currentLayerData.shapes?.[pathIndex]
            );
            const uniqueNodeIndices = [...new Set(nodeIndices)].filter(
                (nodeIndex) =>
                    Number.isInteger(nodeIndex) &&
                    nodeIndex >= 0 &&
                    nodeIndex < (contour?.nodes.length || 0)
            );

            const selectedNodeIndexSet = new Set(uniqueNodeIndices);
            const onCurveNodeIndices = contour
                ? contour.nodes
                      .map((node, index) =>
                          isOnCurveNode(node) ? index : null
                      )
                      .filter((index): index is number => index !== null)
                : [];

            if (
                contour &&
                onCurveNodeIndices.length > 0 &&
                onCurveNodeIndices.every((index) =>
                    selectedNodeIndexSet.has(index)
                )
            ) {
                fullContourIndices.add(pathIndex);
                pointsByPath.set(
                    pathIndex,
                    uniqueNodeIndices.sort((a, b) => b - a)
                );
                continue;
            }

            pointsByPath.set(
                pathIndex,
                uniqueNodeIndices.sort((a, b) => b - a)
            );
        }

        const contourIndicesDescending = [...pointsByPath.keys()].sort(
            (left, right) => right - left
        );

        const selectedAnchorIndicesDescending = [
            ...new Set(this.selectedAnchors)
        ]
            .filter(
                (anchorIndex) =>
                    Number.isInteger(anchorIndex) &&
                    anchorIndex >= 0 &&
                    anchorIndex < (currentLayerModel.anchors?.length || 0)
            )
            .sort((left, right) => right - left);

        const selectedAnchorNames = this.getAnchorNamesForSelectionIndices(
            this.selectedAnchors,
            currentLayerData.anchors || []
        );

        const selectedGuideHandle = this.selectedGuideHandle
            ? { ...this.selectedGuideHandle }
            : null;

        const selectedLayerGuideName =
            selectedGuideHandle?.scope === 'layer'
                ? currentLayerModel.guides?.[selectedGuideHandle.index]?.name
                : null;

        // Perform deletions with suppressed model recording
        withSuppressedModelRecording(() => {
            const deleteContourFromLayer = (layerModel: Layer): void => {
                for (const pathIndex of contourIndicesDescending) {
                    const shape = layerModel.shapes?.[pathIndex];
                    if (!shape?.isPath?.()) {
                        continue;
                    }

                    if (fullContourIndices.has(pathIndex)) {
                        layerModel.removeShape(pathIndex);
                        continue;
                    }

                    const nodeIndices = pointsByPath.get(pathIndex) || [];
                    if (!nodeIndices.length) {
                        continue;
                    }

                    shape.asPath()._deleteNodes(nodeIndices);
                }
            };

            const removeAnchorsByName = (layerModel: Layer): void => {
                if (!selectedAnchorNames.length) {
                    return;
                }

                const used = new Set<number>();
                const indicesToDelete: number[] = [];

                for (const anchorName of selectedAnchorNames) {
                    const match = layerModel.anchors?.findIndex(
                        (anchor, index) =>
                            !used.has(index) && anchor.name === anchorName
                    );

                    if (match !== undefined && match >= 0) {
                        used.add(match);
                        indicesToDelete.push(match);
                    }
                }

                indicesToDelete
                    .sort((left, right) => right - left)
                    .forEach((index) => layerModel.removeAnchor(index));
            };

            const removeSelectedGuideFromLayer = (layerModel: Layer): void => {
                if (selectedGuideHandle?.scope !== 'layer') {
                    return;
                }

                if (layerModel === currentLayerModel) {
                    layerModel.removeGuide(selectedGuideHandle.index);
                    return;
                }

                if (!selectedLayerGuideName) {
                    return;
                }

                const linkedGuideIndex = layerModel.guides?.findIndex(
                    (guide) => guide.name === selectedLayerGuideName
                );

                if (linkedGuideIndex !== undefined && linkedGuideIndex >= 0) {
                    layerModel.removeGuide(linkedGuideIndex);
                }
            };

            deleteContourFromLayer(currentLayerModel);
            selectedAnchorIndicesDescending.forEach((anchorIndex) =>
                currentLayerModel.removeAnchor(anchorIndex)
            );
            removeSelectedGuideFromLayer(currentLayerModel);

            if (selectedGuideHandle?.scope === 'master') {
                this.getRootMasterModel()?.removeGuide(
                    selectedGuideHandle.index
                );
            }

            for (const linkedLayer of linkedLayers) {
                deleteContourFromLayer(linkedLayer);
                removeAnchorsByName(linkedLayer);
                removeSelectedGuideFromLayer(linkedLayer);
            }
        });

        // Sync changes to YDoc
        if (bridge && currentGlyphModel.name) {
            bridge.beginTransaction('Delete point(s)');
            try {
                bridge.syncGlyphFromJson(
                    currentGlyphModel.name,
                    'Delete point(s)'
                );
            } finally {
                bridge.endTransaction();
            }
        }

        this.syncCurrentExactLayerDataFromModel();

        // Clear selection
        this.selectedPoints = [];
        this.selectedAnchors = [];
        this.selectedComponents = [];
        this.selectedGuideHandle = null;
        this.selectedSidebearingHandle = null;

        // Update UI
        const currentFont = fontManager.currentFont;
        const shouldUseIncrementalCacheRefresh = linkedLayers.length === 0;

        if (currentFont) {
            currentFont.markDirty('keyboard-outline');
            void fontManager.updateDirtyIndicator();
        }

        this.performHitDetection(null);
        this.glyphCanvas.updatePropertyPanel();
        this.glyphCanvas.render();

        // Update font cache
        if (currentFont) {
            window.setTimeout(() => {
                if (fontManager.currentFont !== currentFont) {
                    return;
                }

                if (shouldUseIncrementalCacheRefresh) {
                    fontManager.pendingBabelfontJsonSyncAfterDrag = true;
                    void fontManager.updateWorkerFontCache();
                    return;
                }

                try {
                    currentFont.syncJsonFromModel();
                } catch (error) {
                    console.error(
                        '[OutlineEditor] Error syncing font JSON after node deletion:',
                        error
                    );
                    return;
                }

                void fontManager.updateWorkerFontCache();
            }, 0);
        } else if (currentGlyphModel.name) {
            window.dispatchEvent(
                new CustomEvent('glyphChanged', {
                    detail: {
                        glyphName: currentGlyphModel.name,
                        layerId: this.getCurrentLayerId()
                    }
                })
            );
        }
    }

    onSpaceKeyReleased() {
        if (!this.active || !this.isPreviewMode) return;
        this.spaceKeyPressed = false;
        console.log('  -> Exiting preview mode from Space release');
        this.isPreviewMode = false;

        // Restore cursor style
        if (this.glyphCanvas.canvas && this.cursorStyleBeforePreview) {
            this.glyphCanvas.canvas.style.cursor =
                this.cursorStyleBeforePreview;
            this.cursorStyleBeforePreview = null;
        }

        // Check if current axis position matches an exact layer
        this.autoSelectMatchingLayer().then(async () => {
            if (this.selectedLayerId !== null) {
                // On an exact layer - fetch that layer's data
                await this.fetchLayerData();
                this.glyphCanvas.render();
            } else {
                // Between layers - need to interpolate
                if (this.currentGlyphName) {
                    await this.interpolateCurrentGlyph(true);
                } else {
                    this.glyphCanvas.render();
                }
            }
        });
    }

    onBlur() {
        this.setCommandKeyPressed(false);
        this.spaceKeyPressed = false;
        this.isDraggingPoint = false;
        this.isSlidingSmoothPointAlongCurve = false;
        this.isSnappedToCloseOpenPath = false;
        this.isDraggingAnchor = false;
        this.isDraggingComponent = false;
        // Exit preview mode if active
        if (this.isPreviewMode) {
            this.isPreviewMode = false;
            // Restore cursor visibility in text mode
            if (!this.active) {
                this.glyphCanvas.cursorVisible = true;
            }
            this.glyphCanvas.render();
        }
    }

    async interpolateCurrentGlyph(force: boolean = false): Promise<void> {
        // Interpolate the current glyph at current variation settings
        if (!this.currentGlyphName) {
            console.log('[OutlineEditor] Skipping interpolation:', {
                hasGlyphName: !!this.currentGlyphName
            });
            return;
        }

        if (this.isDeterministicRefreshActive && !force) {
            return;
        }

        // Allow interpolation during active interpolation OR layer switch animation
        // Unless force=true (e.g., entering edit mode at interpolated position)
        if (!force && !this.isInterpolating && !this.isLayerSwitchAnimating) {
            console.log(
                '[OutlineEditor] Skipping interpolation - not in active interpolation state'
            );
            return;
        }

        // Increment counter and capture it locally - this invalidates all previous calls
        const myInterpolationId = ++this.currentInterpolationId;
        console.log(
            '[OutlineEditor] Starting interpolation',
            myInterpolationId
        );

        try {
            const location = this.glyphCanvas.axesManager!.variationSettings;

            // ALWAYS interpolate the root glyph (with full component tree)
            // This matches the architecture where layerData always contains the root glyph
            // and we navigate to nested components using glyphStack
            const rootGlyphName = this.glyphCanvas.getCurrentGlyphName();
            const interpolatedLayer = await fontInterpolation.interpolateGlyph(
                rootGlyphName,
                location
            );

            // Check if we've been superseded by a newer interpolation call
            if (myInterpolationId !== this.currentInterpolationId) {
                console.log(
                    '[OutlineEditor] 🚫 Aborting stale interpolation',
                    myInterpolationId,
                    '(current is',
                    this.currentInterpolationId,
                    ')'
                );
                return;
            }

            // Final check before rendering
            if (myInterpolationId !== this.currentInterpolationId) {
                console.log(
                    '[OutlineEditor] 🚫 Aborting stale interpolation',
                    myInterpolationId,
                    '(current is',
                    this.currentInterpolationId,
                    ')'
                );
                return;
            }

            console.log(
                '[OutlineEditor] ✅ Rendering interpolation',
                myInterpolationId
            );

            // Don't apply interpolated data if we're no longer in an interpolating state
            // This can happen if a layer switch animation completes while an interpolation is in flight
            if (
                !this.isInterpolating &&
                !this.isLayerSwitchAnimating &&
                !force
            ) {
                console.log(
                    '[OutlineEditor] 🚫 Skipping applyInterpolatedLayer - no longer interpolating'
                );
                return;
            }

            // Apply interpolated data via shared normalizer
            this.applyRustLayerData(interpolatedLayer, true);

            // In editing mode, update HarfBuzz and auto-pan together to keep them in sync
            if (
                interpolatedLayer._interpolationLocation &&
                this.autoPanAnchorScreen !== null
            ) {
                // Update the axes manager's variation settings to match the interpolated location
                // This ensures HarfBuzz renders at the same location as the interpolated outline
                this.glyphCanvas.axesManager!.variationSettings = {
                    ...interpolatedLayer._interpolationLocation
                };

                // Update HarfBuzz font with the new variation settings (updates text width)
                // Skip render here - we'll render after auto-pan adjustment
                this.glyphCanvas.textRunEditor!.shapeText(true);

                // Apply auto-pan adjustment now that text width is updated
                this.applyAutoPanAdjustment();
            }

            // Render with the new interpolated data
            console.log(
                '[OutlineEditor] About to render with layerData.width:',
                this.layerData?.width
            );
            this.glyphCanvas.render();
            console.log(
                '[OutlineEditor] After render - layerData.width:',
                this.layerData?.width
            );

            console.log(
                `[OutlineEditor] ✅ Applied interpolated layer for "${this.currentGlyphName}"`
            );
        } catch (error: any) {
            // Silently ignore cancellation errors
            if (error.message && error.message.includes('cancelled')) {
                console.log(
                    '[OutlineEditor] 🚫 Interpolation cancelled (newer request pending)'
                );
                return;
            }

            console.warn(
                `[OutlineEditor] ⚠️ Interpolation failed for "${this.currentGlyphName}":`,
                error
            );
            // On error, keep showing whatever data we have
        }
    }

    async runDeterministicRefresh<T>(task: () => Promise<T>): Promise<T> {
        this.currentInterpolationId++;
        this.isDeterministicRefreshActive = true;
        try {
            return await task();
        } finally {
            this.isDeterministicRefreshActive = false;
        }
    }

    onKeyDown(e: KeyboardEvent) {
        if (!this.active) return;
        // Handle space bar press to enter preview mode and enable panning
        if (e.code === 'Space') {
            e.preventDefault();
            this.spaceKeyPressed = true;
            // Only enter preview mode if not already in it (prevents key repeat from re-entering)
            if (!this.isPreviewMode) {
                this.isPreviewMode = true;
                // Store current cursor and change to grab cursor
                if (this.glyphCanvas.canvas) {
                    this.cursorStyleBeforePreview =
                        this.glyphCanvas.canvas.style.cursor;
                    this.glyphCanvas.canvas.style.cursor = 'grab';
                }
                this.glyphCanvas.render();
            }
            return;
        }

        // Handle Cmd+Left/Right to navigate through glyphs in logical order
        // Only when in glyph edit mode but NOT in nested component mode
        if ((e.metaKey || e.ctrlKey) && !this.isEditingComponent()) {
            if (e.key === 'ArrowLeft') {
                e.preventDefault();
                if (this.active && !this.isEditingComponent()) {
                    this.glyphCanvas.textRunEditor!.navigateToPreviousGlyphLogical();
                }
                return;
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                this.glyphCanvas.textRunEditor!.navigateToNextGlyphLogical();
                return;
            }
        }

        // Handle Cmd+Up/Down to cycle through layers.
        // Allow when a layer is selected, or when we have saved brace-layer
        // neighbors so navigation can resume after switching to a glyph that
        // doesn't have that brace layer.
        const canCycleLayers =
            this.selectedLayerId !== null ||
            this.braceLayerNeighborAboveMasterId !== null ||
            this.braceLayerNeighborBelowMasterId !== null;
        if ((e.metaKey || e.ctrlKey) && canCycleLayers) {
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                e.preventDefault();
                this.cycleLayers(e.key === 'ArrowUp');
                return;
            }
        }

        if (
            (e.metaKey || e.ctrlKey) &&
            e.key.toLowerCase() === 'a' &&
            !e.shiftKey &&
            !e.altKey
        ) {
            if (this.selectAllCurrentLayerObjects()) {
                e.preventDefault();
            }
            return;
        }

        // Handle arrow keys for point/anchor/component movement
        if (
            this.selectedLayerId &&
            (this.selectedPoints.length > 0 ||
                this.selectedAnchors.length > 0 ||
                this.selectedComponents.length > 0 ||
                this.selectedSidebearingHandle)
        ) {
            const multiplier = e.shiftKey ? 10 : 1;
            let moved = false;

            // Capture pre-move state for undo log description
            let preMoveDesc: string | undefined;
            if (this.selectedAnchors.length > 0) {
                preMoveDesc = this._buildAnchorDesc();
            } else if (this.selectedPoints.length > 0) {
                preMoveDesc = this._buildNodeDesc();
            } else if (this.selectedComponents.length > 0) {
                preMoveDesc = this._buildComponentDesc();
            } else if (this.selectedSidebearingHandle) {
                preMoveDesc = this.selectedSidebearingHandle.side.toUpperCase();
            }

            if (e.key === 'ArrowLeft') {
                e.preventDefault();
                if (this.selectedPoints.length > 0) {
                    this.moveSelectedPoints(-multiplier, 0, e.altKey);
                }
                if (this.selectedAnchors.length > 0) {
                    this.moveSelectedAnchors(-multiplier, 0);
                }
                if (this.selectedComponents.length > 0) {
                    this.moveSelectedComponents(-multiplier, 0);
                }
                if (this.selectedSidebearingHandle) {
                    this.moveSelectedSidebearing(-multiplier);
                }
                moved = true;
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                if (this.selectedPoints.length > 0) {
                    this.moveSelectedPoints(multiplier, 0, e.altKey);
                }
                if (this.selectedAnchors.length > 0) {
                    this.moveSelectedAnchors(multiplier, 0);
                }
                if (this.selectedComponents.length > 0) {
                    this.moveSelectedComponents(multiplier, 0);
                }
                if (this.selectedSidebearingHandle) {
                    this.moveSelectedSidebearing(multiplier);
                }
                moved = true;
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (this.selectedPoints.length > 0) {
                    this.moveSelectedPoints(0, multiplier, e.altKey);
                }
                if (this.selectedAnchors.length > 0) {
                    this.moveSelectedAnchors(0, multiplier);
                }
                if (this.selectedComponents.length > 0) {
                    this.moveSelectedComponents(0, multiplier);
                }
                moved = true;
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (this.selectedPoints.length > 0) {
                    this.moveSelectedPoints(0, -multiplier, e.altKey);
                }
                if (this.selectedAnchors.length > 0) {
                    this.moveSelectedAnchors(0, -multiplier);
                }
                if (this.selectedComponents.length > 0) {
                    this.moveSelectedComponents(0, -multiplier);
                }
                moved = true;
            }

            if (moved) {
                // Build post-move description using coords-only (label already in preMoveDesc)
                let postMoveDesc: string | undefined;
                if (this.selectedAnchors.length > 0) {
                    postMoveDesc = this._buildAnchorDesc(true);
                } else if (this.selectedPoints.length > 0) {
                    postMoveDesc = this._buildNodeDesc(true);
                } else if (this.selectedComponents.length > 0) {
                    postMoveDesc = this._buildComponentDesc(true);
                }
                // Encode the metrics-key edited side into postMoveDesc so
                // inferSidebearingSideFromHistoryItem can detect it on undo
                // and apply the matching viewport pan (same as drag-end path).
                if (this._metricsKeyEditedSide && postMoveDesc !== undefined) {
                    postMoveDesc = `${
                        this._metricsKeyEditedSide === 'left' ? 'LEFT' : 'RIGHT'
                    } ${postMoveDesc}`;
                }
                const visualAnchorSide =
                    this._metricsKeyEditedSide ||
                    this._metricsKeyInteractionSide;
                this._metricsKeyEditedSide = null;
                this._metricsKeyInteractionSide = null;
                this._syncCurrentGlyphToYDoc(
                    'Arrow key',
                    preMoveDesc,
                    postMoveDesc,
                    visualAnchorSide
                );
                return;
            }
        }

        // Handle Delete/Backspace for node deletion
        if (e.key === 'Delete' || e.key === 'Backspace') {
            if (
                this.selectedPoints.length > 0 ||
                this.selectedAnchors.length > 0 ||
                this.selectedGuideHandle
            ) {
                e.preventDefault();
                void this.deleteSelectedNodes();
                return;
            }
        }
    }

    async cycleLayers(moveUp: boolean): Promise<void> {
        let sortedLayers = this.glyphCanvas.getSortedLayers();
        if (sortedLayers.length === 0) {
            return;
        }
        // Cycle through layers with Cmd+Up (previous) or Cmd+Down (next)
        // Find current layer index
        const currentIndex = sortedLayers.findIndex(
            (layer) => layer.id === this.selectedLayerId
        );
        if (currentIndex === -1) {
            // No layer selected. If we last had a brace layer selected, resume
            // navigation from the saved adjacent master position.
            const neighborMasterId = moveUp
                ? this.braceLayerNeighborAboveMasterId
                : this.braceLayerNeighborBelowMasterId;
            if (neighborMasterId) {
                const neighborIndex = sortedLayers.findIndex(
                    (l) => l._master === neighborMasterId
                );
                const targetIndex = neighborIndex !== -1 ? neighborIndex : 0;
                const layerToSelect = this.getFullLayerData(
                    sortedLayers[targetIndex].id
                );
                if (layerToSelect) {
                    await this.selectLayer(layerToSelect);
                }
            } else {
                // Default: select first layer
                const layerToSelect = this.getFullLayerData(sortedLayers[0].id);
                if (layerToSelect) {
                    await this.selectLayer(layerToSelect);
                }
            }
            return;
        }

        // Calculate next index (with wrapping)
        let nextIndex;
        if (moveUp) {
            nextIndex = currentIndex - 1;
            if (nextIndex < 0) {
                nextIndex = sortedLayers.length - 1; // Wrap to last
            }
        } else {
            nextIndex = currentIndex + 1;
            if (nextIndex >= sortedLayers.length) {
                nextIndex = 0; // Wrap to first
            }
        }

        // Get full layer data from font model before selecting
        const layerToSelect = this.getFullLayerData(sortedLayers[nextIndex].id);
        if (layerToSelect) {
            await this.selectLayer(layerToSelect);
        }
    }

    /**
     * Get full layer data from font model by layer ID
     * Converts Layer wrapper to plain Babelfont.Layer object
     */
    private getFullLayerData(layerId: string): Babelfont.Layer | null {
        const fontModel = fontManager.currentFont?.fontModel;
        if (!fontModel) return null;

        const glyphName =
            this.parseGlyphStack()[0]?.glyphName ??
            this.glyphCanvas.getCurrentGlyphName();
        const glyph = fontModel.glyphs.find((g: any) => g.name === glyphName);
        if (!glyph || !glyph.layers) return null;

        const layer = glyph.layers.find((l: any) => l.id === layerId);
        if (!layer) return null;

        // Convert Layer wrapper to plain Babelfont.Layer object
        return {
            id: layer.id,
            name: layer.name,
            master: layer.master,
            location: layer.location,
            width: layer.width,
            shapes: layer.shapes?.map((s: any) => ({ ...s })),
            anchors: layer.anchors?.map((anchor: any) => ({
                name: anchor.name,
                x: anchor.x,
                y: anchor.y
            })),
            guides: layer.guides?.map((guide: any) => ({
                pos: {
                    x: guide.pos.x,
                    y: guide.pos.y,
                    angle: guide.pos.angle
                },
                ...(guide.name && { name: guide.name }),
                ...(guide.color && { color: guide.color })
            })),
            isInterpolated: false
        };
    }

    async selectLayer(layer: Babelfont.Layer): Promise<void> {
        layer = this.resolveLayerModel(layer);

        // Select a layer and update axis sliders to match its master location
        // Clear previous state when explicitly selecting a layer
        this.escapeState.clear();
        const previousLayer = this.getCurrentLayerModel();

        console.log(
            `[OutlineEditor] selectLayer called with layer:`,
            layer,
            `id: ${layer.id}, _master: ${layer.master}`
        );
        this.selectedLayerId = layer.id!;
        console.log(
            `[OutlineEditor] Set selectedLayerId to:`,
            this.selectedLayerId
        );
        // When a brace layer is selected, record the master IDs of the layers
        // immediately above and below it in the sorted list. This lets
        // Cmd+Up/Down resume from the right position when switching to a glyph
        // that doesn't have the same brace layer.
        const isBraceLayer =
            !!layer.location && Object.keys(layer.location).length > 0;
        if (isBraceLayer) {
            const sortedLayers = this.glyphCanvas.getSortedLayers();
            const braceIndex = sortedLayers.findIndex((l) => l.id === layer.id);
            if (braceIndex !== -1) {
                const above =
                    braceIndex > 0 ? sortedLayers[braceIndex - 1] : undefined;
                const below =
                    braceIndex < sortedLayers.length - 1
                        ? sortedLayers[braceIndex + 1]
                        : undefined;
                this.braceLayerNeighborAboveMasterId = above?._master ?? null;
                this.braceLayerNeighborBelowMasterId = below?._master ?? null;
            }
        } else {
            this.braceLayerNeighborAboveMasterId = null;
            this.braceLayerNeighborBelowMasterId = null;
        }

        // Rebuild glyph_stack with new layer ID (preserves component path)
        if (this.glyphStack && this.glyphStack !== '') {
            this.rebuildGlyphStackWithNewLayer(layer.id!);
        } else {
            // Initial selection - build stack from scratch at root level
            const rootGlyphName = this.glyphCanvas.getCurrentGlyphName();
            this.buildGlyphStack(rootGlyphName, layer.id!, []);
        }

        const selectionTargetLayer =
            this.isEditingComponent() && layer.id
                ? this.getSelectionScopeLayerModel(layer.id) || layer
                : layer;
        const nextSelectionState = this.getSelectionStateForLayerTransition(
            previousLayer,
            selectionTargetLayer
        );

        // Capture anchor point before layer switch animation begins
        this.captureAutoPanAnchor();

        // Immediately clear interpolated flag on existing data
        // to prevent rendering with monochrome colors
        if (this.layerData) {
            this.layerData.isInterpolated = false;
        }
        // Use font model masters (designspace locations), NOT fontData.masters
        // which has already-converted userspace locations
        let masters: Babelfont.Master[] =
            (fontManager.currentFont?.fontModel?.masters as any) || [];
        console.log(`Selected layer: ${layer.name} (ID: ${layer.id})`);
        console.log('Layer data:', layer);
        console.log('Available masters:', masters);

        // Store current layer data before fetching new one (for animation)
        const oldLayerData = this.layerData;

        // CRITICAL SECTION: Suppress all renders during layer data fetch and swap
        // This prevents the target layer from flashing before animation starts
        this.glyphCanvas.renderSuppressed = true;

        try {
            // Fetch layer data now and store as target for animation
            // This ensures new outlines are ready before animation starts
            await this.fetchLayerData(true);

            // Immediately swap layer data to prevent flash
            // If we're in edit mode, set up animation state
            // Move the NEW layer data to targetLayerData and restore OLD layer data
            // so the animation interpolates FROM old TO new
            if (this.active && this.layerData) {
                this.targetLayerData = this.layerData;
                this.layerData = oldLayerData;
                this.isLayerSwitchAnimating = true;
                console.log(
                    'Starting layer switch animation - old layer in layerData, new layer in targetLayerData'
                );
            }

            // Perform mouse hit detection after swap (uses layerData)
            this.performHitDetection(null);
        } finally {
            // Always re-enable rendering after critical section
            this.glyphCanvas.renderSuppressed = false;
        }

        this.applySelectionStateForLayer(
            nextSelectionState,
            selectionTargetLayer
        );

        // Find the userspace location for this layer
        const targetUserspaceLocation = this.getUserspaceLocationForLayer(
            layer.id!,
            this.parseGlyphStack()[0]?.glyphName
        );

        if (!targetUserspaceLocation) {
            console.warn('No location found for layer', {
                layerId: layer.id
            });
            return;
        }

        console.log(
            `Setting axis values to layer location:`,
            targetUserspaceLocation
        );

        // Set up animation to all axes at once
        const newSettings: UserspaceLocation = {};
        for (const [axisTag, value] of Object.entries(
            targetUserspaceLocation
        )) {
            newSettings[axisTag] = value;
        }
        this.glyphCanvas.axesManager!._setupAnimation(newSettings);

        await this.glyphCanvas.updatePropertiesUI();
    }

    async onAnimationComplete() {
        // Don't clear isLayerSwitchAnimating here - it's cleared in glyph-canvas.ts
        // after calling restoreTargetLayerDataAfterAnimating()

        // Don't handle interpolation slider resets here when layer switching
        // The layer switch logic in glyph-canvas.ts will handle everything
        if (!this.isLayerSwitchAnimating) {
            fontInterpolation.resetRequestTracking();
        }

        // Clear auto-pan anchor since animation is complete
        this.autoPanAnchorScreen = null;

        // Only handle interpolation mode here, not layer switches
        // Layer switches are handled in restoreTargetLayerDataAfterAnimating()
        if (this.isLayerSwitchAnimating) {
            // Layer switch animation - don't handle here
            return;
        }

        // Check if new variation settings match any layer (interpolation mode only)
        if (this.active && this.glyphCanvas.fontData) {
            await this.autoSelectMatchingLayer();

            // If no exact layer match, keep interpolated data visible
            if (
                this.selectedLayerId === null &&
                this.layerData &&
                this.layerData.isInterpolated
            ) {
                // Keep showing interpolated data
                console.log('Animation complete: showing interpolated glyph');
            }
        }
    }

    findMatchingLayer(
        rootGlyphName: string = this.glyphCanvas.getCurrentGlyphName()
    ): Babelfont.Layer | null {
        const fontModel = fontManager.currentFont?.fontModel;
        if (!fontModel || !fontModel.glyphs) {
            return null;
        }

        const currentGlyph = fontModel.glyphs.find(
            (g: any) => g.name === rootGlyphName
        );
        if (!currentGlyph?.layers?.length) {
            return null;
        }

        const masters: Babelfont.Master[] = (fontModel.masters || []) as any;
        if (!masters.length) {
            return null;
        }

        const currentUserspaceLocation = {
            ...this.glyphCanvas.axesManager!.variationSettings
        };
        const currentDesignspaceLocation = userspaceToDesignspace(
            currentUserspaceLocation,
            fontModel.axes || []
        );
        const axisTags = (fontModel.axes || []).map((axis) => axis.tag);

        for (const layer of currentGlyph.layers) {
            const masterId = layer.master?.master;
            const hasLayerLocation =
                !!layer.location && Object.keys(layer.location).length > 0;
            const master = masters.find((m) => m.id === masterId);
            const effectiveDesignLocation = hasLayerLocation
                ? layer.location
                : master?.location;

            if (!effectiveDesignLocation) {
                console.log(
                    '[OutlineEditor]',
                    `  Skipping layer ${layer.id}: no effective location for masterId=${masterId}`
                );
                continue;
            }

            if (
                locationsMatchWithinTolerance(
                    effectiveDesignLocation,
                    currentDesignspaceLocation,
                    axisTags
                )
            ) {
                return layer as Babelfont.Layer;
            }
        }

        return null;
    }

    async autoSelectMatchingLayer(options?: {
        skipRender?: boolean;
    }): Promise<void> {
        const rootGlyphName = this.glyphCanvas.getCurrentGlyphName();
        const skipRender = options?.skipRender === true;
        const previousLayer = this.isEditingComponent()
            ? this.getCurrentLayerModel()
            : this.getTransitionPreviousLayerModel(rootGlyphName);

        console.log('[OutlineEditor] autoSelectMatchingLayer called', {
            active: this.active,
            isInterpolating: this.isInterpolating,
            selectedLayerId: this.selectedLayerId,
            currentGlyphName: this.currentGlyphName,
            rootGlyphName
        });

        const matchingLayer = this.findMatchingLayer(rootGlyphName);

        if (matchingLayer) {
            console.log(
                '[OutlineEditor]',
                `  ✓ MATCH found: layer ${matchingLayer.id}`
            );
            // Found a matching layer - select it
            this.selectedLayerId = matchingLayer.id || null;

            // Build or rebuild glyph_stack with new layer ID
            const parsedStack = this.parseGlyphStack();
            const stackRootGlyphName = parsedStack[0]?.glyphName;

            if (
                this.glyphStack &&
                this.glyphStack !== '' &&
                stackRootGlyphName === rootGlyphName
            ) {
                // If stack exists, rebuild with new layer (preserves component path)
                this.rebuildGlyphStackWithNewLayer(matchingLayer.id!);
            } else {
                // If stack is empty or the root glyph changed, rebuild the stack for the new glyph.
                this.buildGlyphStack(rootGlyphName, matchingLayer.id!, []);
            }

            const selectionTargetLayer =
                this.isEditingComponent() && matchingLayer.id
                    ? this.getSelectionScopeLayerModel(matchingLayer.id) ||
                      matchingLayer
                    : matchingLayer;
            const nextSelectionState = this.getSelectionStateForLayerTransition(
                previousLayer,
                selectionTargetLayer
            );

            // Don't clear previous state - keep it to allow Escape to restore
            // The previous state is only cleared in selectLayer() when explicitly clicking a layer
            console.log('Keeping previous state for Escape functionality');

            // Fetch layer data EXCEPT during slider interpolation or layer switch animation
            // During these states, we use interpolated data instead
            if (!this.isInterpolating && !this.isLayerSwitchAnimating) {
                await this.fetchLayerData(skipRender); // Fetch layer data for outline editor

                // Perform mouse hit detection after layer data is loaded
                this.performHitDetection(null);
            }

            this.applySelectionStateForLayer(
                nextSelectionState,
                selectionTargetLayer
            );

            // Clear the interpolating flag and render to display the new outlines
            this.isInterpolating = false;
            this.autoPanAnchorScreen = null;

            if (this.active && !skipRender) {
                this.glyphCanvas.updatePropertyPanel();
                this.glyphCanvas.render();
            }

            this.updateLayerSelection();
            this.glyphCanvas.updatePropertyPanel();
            console.log(
                `Auto-selected layer: ${matchingLayer.name || 'Default'} (${matchingLayer.id})`
            );
            return;
        }

        // No matching layer found - deselect current layer
        if (this.selectedLayerId !== null) {
            if (previousLayer) {
                this.storeSelectionStateForLayer(previousLayer);
            }
            this.selectedLayerId = null;
            // Don't clear layer data during interpolation - keep showing interpolated data
            if (!this.isInterpolating) {
                this.layerData = null; // Clear layer data when deselecting
            }
            this.selectedPointIndex = null;
            this.hoveredPointIndex = null;
            this.updateLayerSelection();
            this.glyphCanvas.updatePropertyPanel();
            console.log('No matching layer - deselected');
        }

        // If we're in glyph edit mode and not on a layer, interpolate at current position
        if (this.active && this.selectedLayerId === null && rootGlyphName) {
            console.log(
                'Interpolating at current position after entering edit mode'
            );

            // Preserve existing component navigation during slider interpolation.
            // Only bootstrap stack when it's missing.
            if (!this.glyphStack) {
                this.buildGlyphStack(rootGlyphName, '', []);
            }

            await this.interpolateCurrentGlyph(true); // force=true to bypass guard

            // Pan to glyph after interpolation completes (when switching glyphs via keyboard)
            // This ensures we have the correct interpolated bounds for panning
            if (
                this.glyphCanvas.textRunEditor!.selectedGlyphIndex >= 0 &&
                this.glyphCanvas.textRunEditor!.selectedGlyphIndex <
                    this.glyphCanvas.textRunEditor!.shapedGlyphs.length
            ) {
                this.glyphCanvas.panToGlyph(
                    this.glyphCanvas.textRunEditor!.selectedGlyphIndex
                );
            }
        }
    }

    /**
     * Get the layer data for the current position in glyph_stack
     * Always starts from root layerData and navigates through components
     * @returns The layer data at the current glyph_stack position
     */
    getCurrentLayerDataFromStack(): Babelfont.Layer | null {
        if (!this.layerData || !this.glyphStack) {
            return this.layerData;
        }

        const parsed = this.parseGlyphStack();
        if (parsed.length === 0) {
            return this.layerData;
        }

        // Start with root layer data
        let currentLayerData: Babelfont.Layer | null = this.layerData;

        // Navigate through each component in the stack (skip the first root item)
        for (let i = 0; i < parsed.length; i++) {
            const item = parsed[i];

            // Skip root item (has no componentIndex)
            if (item.componentIndex === undefined) {
                continue;
            }

            // Navigate to the component
            if (
                !currentLayerData ||
                !currentLayerData.shapes ||
                !currentLayerData.shapes[item.componentIndex]
            ) {
                console.error(
                    '[GlyphStack] Invalid navigation at index',
                    i,
                    'componentIndex:',
                    item.componentIndex
                );
                return null;
            }

            const shape: Babelfont.Shape =
                currentLayerData.shapes[item.componentIndex];
            if (!('reference' in shape)) {
                console.error(
                    '[GlyphStack] Shape at index',
                    item.componentIndex,
                    'is not a component'
                );
                return null;
            }

            // Move to the component's layer data
            currentLayerData = shape.layerData || null;
            if (!currentLayerData) {
                console.error(
                    '[GlyphStack] Component at index',
                    item.componentIndex,
                    'has no layerData'
                );
                return null;
            }
        }

        return currentLayerData;
    }

    async fetchLayerData(
        skipRender: boolean = false,
        rootGlyphName?: string,
        retryCount: number = 0
    ): Promise<void> {
        const stackPreview = new Error().stack
            ?.split('\n')
            .slice(2, 6)
            .map((line) => line.trim())
            .join(' | ');
        // Reset interpolation request tracking since we're loading exact layer data
        fontInterpolation.resetRequestTracking();

        // ALWAYS fetch root glyph layer data (with nested components)
        // Never fetch layer data for a component separately
        if (!this.selectedLayerId) {
            this.layerData = null;
            this.renderVerticalMetrics = null;
            return;
        }

        // Always fetch root glyph name - never component reference
        const parsedStack = this.parseGlyphStack();
        const glyphName =
            rootGlyphName ??
            parsedStack[0]?.glyphName ??
            this.glyphCanvas.getCurrentGlyphName();
        if (
            !glyphName ||
            glyphName === 'undefined' ||
            glyphName.startsWith('GID ')
        ) {
            console.warn(
                '[OutlineEditor] Skipping fetchLayerData due to invalid glyph name',
                glyphName
            );
            return;
        }

        console.log(
            `[DRAG-DEBUG] fetchLayerData called — glyph="${glyphName}", layer=${this.selectedLayerId}, draggingSomething=${this.draggingSomething}, skipRender=${skipRender}, retryCount=${retryCount}, caller=${stackPreview ?? 'unknown'}`
        );
        console.log(
            `🔍 Fetching ROOT layer data for glyph: "${glyphName}", layer: ${this.selectedLayerId}`
        );

        const exactLayerData = this.getExactLayerDataForSelection(
            glyphName,
            this.selectedLayerId
        );
        if (exactLayerData) {
            this.applyExactSelectedLayerData(exactLayerData, null);
            this.finalizeFetchedLayerData(glyphName, skipRender);
        }

        try {
            // Compute the userspace location for this layer
            const userspaceLocation = this.getUserspaceLocationForLayer(
                this.selectedLayerId,
                glyphName
            );
            if (!userspaceLocation) {
                console.warn(
                    `[OutlineEditor] Could not resolve location for layer ${this.selectedLayerId}`
                );
                if (!exactLayerData) {
                    this.layerData = null;
                    this.renderVerticalMetrics = null;
                }
                return;
            }

            // Fetch via Rust WASM — same path as interpolation.
            // The Rust FONT_CACHE is already up-to-date via incremental
            // update_cached_layer during edits and storeFontJson at font-open time.
            const rustResult = await fontInterpolation.interpolateGlyph(
                glyphName,
                userspaceLocation
            );

            if (exactLayerData) {
                this.applyExactSelectedLayerData(exactLayerData, rustResult);
            } else {
                // Fallback for unexpected selection/model desync.
                this.applyRustLayerData(rustResult, false);
            }

            this.finalizeFetchedLayerData(glyphName, skipRender);
        } catch (error) {
            // Silently ignore cancellations — these happen when a newer fetchLayerData
            // call supersedes this one during startup or rapid glyph switching.
            if (
                error instanceof Error &&
                error.message.includes('Interpolation cancelled')
            ) {
                if (retryCount < 1) {
                    await this.fetchLayerData(
                        skipRender,
                        rootGlyphName,
                        retryCount + 1
                    );
                }
                return;
            }
            console.error('Error fetching layer data via Rust:', error);
            if (!exactLayerData) {
                this.layerData = null;
                this.renderVerticalMetrics = null;
            }
        }
    }

    /**
     * Sync the current glyph's data from babelfontData into the Y.Doc.
     * Called after direct JSON mutations (drag, keyboard edits) that
     * bypass the babelfont-model setters.
     * @param oldValue - Optional pre-change description for the undo log.
     * @param newValue - Optional post-change description for the undo log.
     */
    private _syncCurrentGlyphToYDoc(
        label: string,
        oldValue?: string,
        newValue?: string,
        visualAnchorSide?: SidebearingSide | null
    ): void {
        if (!window.changeBridge) return;
        const parsed = this.parseGlyphStack();
        const editedGlyphName =
            parsed.length > 0
                ? parsed[parsed.length - 1].glyphName
                : this.glyphCanvas.getCurrentGlyphName();

        if (!editedGlyphName) {
            return;
        }

        window.changeBridge.syncGlyphFromJson(
            editedGlyphName,
            label,
            oldValue,
            newValue,
            this.selectedLayerId,
            visualAnchorSide
        );
    }

    /**
     * Format a glyph-space coordinate pair as "(X, Y)" with integers.
     */
    private _fmtCoord(x: number, y: number): string {
        return `(${Math.round(x)}, ${Math.round(y)})`;
    }

    /**
     * Build a description string for the selected anchors given their
     * current positions in layerData.
     * @param coordsOnly - If true, return only "(X, Y)" without the anchor label.
     */
    private _buildAnchorDesc(coordsOnly = false): string {
        const layer = this.getCurrentLayerDataFromStack();
        if (!layer?.anchors || this.selectedAnchors.length === 0) return '';
        const first = layer.anchors[this.selectedAnchors[0]];
        if (!first) return '';
        const pos = this._fmtCoord(first.x, first.y);
        if (coordsOnly) return pos;
        const label = first.name ? `anchor '${first.name}'` : 'anchor';
        if (this.selectedAnchors.length === 1) {
            return `${label}: ${pos}`;
        }
        return `${label} (+${this.selectedAnchors.length - 1} more): ${pos}`;
    }

    /**
     * Build a description string for the selected nodes given their
     * current positions in layerData.
     * @param coordsOnly - If true, return only "(X, Y)" without the node label.
     */
    private _buildNodeDesc(coordsOnly = false): string {
        const layer = this.getCurrentLayerDataFromStack();
        if (!layer?.shapes || this.selectedPoints.length === 0) return '';
        const first = this.selectedPoints[0];
        const shape = layer.shapes[first.contourIndex];
        let nodes: Babelfont.Node[] | null = null;
        if ('Path' in shape && (shape as any).Path?.nodes) {
            nodes = (shape as any).Path.nodes;
        } else if ('nodes' in shape && (shape as any).nodes) {
            nodes = (shape as any).nodes;
        }
        if (!nodes) return '';
        const node = nodes[first.nodeIndex];
        if (!node) return '';
        const pos = this._fmtCoord(node.x, node.y);
        if (coordsOnly) return pos;
        const label = `node ${first.contourIndex}.${first.nodeIndex}`;
        if (this.selectedPoints.length === 1) {
            return `${label}: ${pos}`;
        }
        return `${label} (+${this.selectedPoints.length - 1} more): ${pos}`;
    }

    /**
     * Build a description string for the selected components given their
     * current transforms in layerData.
     * @param coordsOnly - If true, return only "(X, Y)" without the component label.
     */
    private _buildComponentDesc(coordsOnly = false): string {
        const layer = this.getCurrentLayerDataFromStack();
        if (!layer?.shapes || this.selectedComponents.length === 0) return '';
        const idx = this.selectedComponents[0];
        const shape = layer.shapes[idx];
        if (!shape || !('reference' in shape || 'Component' in shape))
            return '';
        const compData =
            'Component' in shape ? (shape as any).Component : shape;
        const ref = compData.reference ?? `component[${idx}]`;
        const transform = compData.transform;
        let tx = 0;
        let ty = 0;
        if (Array.isArray(transform)) {
            tx = transform[4] ?? 0;
            ty = transform[5] ?? 0;
        } else if (transform?.translation) {
            tx = transform.translation[0] ?? 0;
            ty = transform.translation[1] ?? 0;
        }
        const pos = this._fmtCoord(tx, ty);
        if (coordsOnly) return pos;
        const label = `component '${ref}'`;
        if (this.selectedComponents.length === 1) {
            return `${label}: ${pos}`;
        }
        return `${label} (+${this.selectedComponents.length - 1} more): ${pos}`;
    }

    /**
     * Build a description string for the selected guide handle.
     * @param coordsOnly - If true, return only "(X, Y)" without the guide label.
     */
    private _buildGuideDesc(coordsOnly = false): string {
        const guideEntry = this.getSelectedGuide();
        if (!guideEntry) return '';

        const pos = this._fmtCoord(
            guideEntry.guide.pos.x,
            guideEntry.guide.pos.y
        );
        if (coordsOnly) return pos;

        const scopeLabel =
            guideEntry.scope === 'master' ? 'master guide' : 'layer guide';
        const nameLabel = guideEntry.guide.name
            ? ` '${guideEntry.guide.name}'`
            : '';
        return `${scopeLabel}${nameLabel}: ${pos}`;
    }

    async saveLayerData(changeSource: string = 'unknown'): Promise<void> {
        // Save layer data back to Python using from_dict()
        if (!window.pyodide || !this.layerData) {
            return;
        }

        // Don't save interpolated data - it's not editable and has no layer ID
        if (this.layerData.isInterpolated) {
            console.warn(
                'Cannot save interpolated layer data - not on an exact layer location'
            );
            return;
        }

        if (!this.selectedLayerId) {
            console.warn('No layer selected - cannot save');
            return;
        }

        try {
            const parsed = this.parseGlyphStack();
            const rootGlyphName =
                parsed.length > 0
                    ? parsed[0].glyphName
                    : this.glyphCanvas.getCurrentGlyphName();
            const isNestedEditing = this.isEditingComponent();

            console.log(
                `[DRAG-DEBUG] OutlineEditor.saveLayerData called — changeSource=${changeSource}, rootGlyphName=${rootGlyphName}, selectedLayerId=${this.selectedLayerId}, draggingSomething=${this.draggingSomething}`
            );

            if (!isNestedEditing) {
                // Root editing mode: persist the root glyph layer.
                console.log(
                    `[SaveLayerData] Saving ROOT glyph "${rootGlyphName}" with stack: ${this.glyphStack}`
                );
                await fontManager!.saveLayerData(
                    rootGlyphName,
                    this.selectedLayerId,
                    this.layerData,
                    changeSource
                );
            } else {
                // Nested component editing mode: persist only the glyph that is
                // actually being edited (last item in glyph stack).
                const currentLayerData = this.getCurrentLayerDataFromStack();
                if (currentLayerData) {
                    // Get the currently edited glyph name from the stack
                    const componentGlyphName =
                        parsed[parsed.length - 1].glyphName;
                    const currentLayerId =
                        currentLayerData.id || this.getCurrentLayerId();

                    if (!currentLayerId) {
                        console.warn(
                            '[SaveLayerData] No current layer ID for nested editing'
                        );
                        return;
                    }

                    console.log(
                        `[SaveLayerData] Saving nested edited glyph "${componentGlyphName}" with layer: ${currentLayerId}`
                    );

                    // Save only the edited glyph definition; do not also persist
                    // the root glyph copy in nested mode.
                    await fontManager!.saveLayerData(
                        componentGlyphName,
                        currentLayerId,
                        currentLayerData,
                        changeSource
                    );
                }
            }

            console.log('Layer data saved successfully');
        } catch (error) {
            console.error('Error saving layer data to Python:', error);
        }
    }

    updateLayerSelection(): void {
        // Update the visual selection highlight for layer items without rebuilding
        if (!this.glyphCanvas.propertiesSection) return;

        // Find all master/layer items and update their selected class
        // Items now have data-master-id, and optionally data-layer-id if layer exists
        const masterItems =
            this.glyphCanvas.propertiesSection.querySelectorAll(
                '[data-master-id]'
            );
        masterItems.forEach((item: any) => {
            const layerId = item.getAttribute('data-layer-id');
            if (layerId === this.selectedLayerId) {
                item.classList.add('selected');
            } else {
                item.classList.remove('selected');
            }
        });
    }

    async enterComponentEditing(
        componentIndex: number,
        skipUIUpdate: boolean = false,
        mouseEvent: MouseEvent | null = null
    ): Promise<void> {
        // Enter editing mode for a component
        // With glyph_stack approach: we DON'T swap layerData, we just update the stack
        // layerData ALWAYS remains the root glyph's data
        // skipUIUpdate: if true, skip UI updates (useful when rebuilding component stack)
        if (
            !this.layerData ||
            !this.layerData.shapes ||
            !this.layerData.shapes[componentIndex] ||
            !this.selectedLayerId
        ) {
            return;
        }

        // Get the component shape from current position in stack
        const currentLayerData =
            this.getCurrentLayerDataFromStack() || this.layerData;

        if (
            !currentLayerData.shapes ||
            !currentLayerData.shapes[componentIndex]
        ) {
            return;
        }

        const componentShape = currentLayerData.shapes[componentIndex];
        if (!('reference' in componentShape) || !componentShape.reference) {
            console.log('Component has no reference');
            return;
        }

        console.log(
            `[EnterComponent] Entering component: ${componentShape.reference}, index: ${componentIndex}`
        );

        const previousLayer = this.getCurrentLayerModel();
        if (previousLayer) {
            this.storeSelectionStateForLayer(previousLayer);
        }

        // Get component transform
        const transform = componentShape.transform || [1, 0, 0, 1, 0, 0];

        // Get current glyph name (for breadcrumb trail)
        let currentGlyphName: string;
        const parsed = this.parseGlyphStack();
        if (parsed.length > 0) {
            // Get the last glyph name from the stack
            currentGlyphName = parsed[parsed.length - 1].glyphName;
        } else {
            currentGlyphName = this.glyphCanvas.getCurrentGlyphName();
        }

        const editingGlyphName = componentShape.reference;

        // Clear selections when entering component
        this.clearAllSelections();

        console.log(
            `Entering component. New depth: ${this.getComponentDepth() + 1}, current glyph: ${currentGlyphName}`
        );

        // Update glyph_stack by adding this component to the navigation path
        const componentPath: number[] = [];
        // Extract existing component path
        for (let i = 0; i < parsed.length; i++) {
            if (parsed[i].componentIndex !== undefined) {
                componentPath.push(parsed[i].componentIndex!);
            }
        }
        // Add the new component index
        componentPath.push(componentIndex);
        // Rebuild with updated path
        const rootGlyphName = this.glyphCanvas.getCurrentGlyphName();
        this.buildGlyphStack(
            rootGlyphName,
            this.selectedLayerId,
            componentPath
        );

        // Update currentGlyphName for interpolation to target the component we're entering
        this.currentGlyphName = editingGlyphName;

        // DON'T set layerData to component data - keep it as root!
        // The renderer will use getCurrentLayerDataFromStack() to get the right data

        const nextLayer = this.getCurrentLayerModel();
        if (nextLayer) {
            this.applySelectionStateForLayer(
                this.getStoredSelectionStateForLayer(nextLayer),
                nextLayer
            );
        }

        console.log(
            `[EnterComponent] Entered component: ${editingGlyphName}, stack depth: ${this.getComponentDepth()}`
        );
        console.log(`[EnterComponent] Updated glyph_stack: ${this.glyphStack}`);

        if (!skipUIUpdate) {
            // Update UI and perform hit detection to update hover states
            this.glyphCanvas.updateComponentBreadcrumb();
            this.glyphCanvas.updatePropertiesUI();
            this.glyphCanvas.render();

            // Perform hit detection immediately if we have a mouse event
            if (mouseEvent) {
                this.performHitDetection(mouseEvent);
                this.glyphCanvas.render();
            }
        }
    }

    exitComponentEditing(skipUIUpdate: boolean = false): boolean {
        // Exit current component editing level
        // With glyph_stack: we DON'T restore layerData, we just update the stack
        // layerData ALWAYS remains the root glyph's data
        // skipUIUpdate: if true, skip UI updates (useful when exiting multiple levels)
        console.log(
            '[EXIT] exitComponentEditing called, current stack depth:',
            this.getComponentDepth()
        );

        if (!this.isEditingComponent()) {
            return false; // Not in component mode
        }

        const previousLayer = this.getCurrentLayerModel();
        if (previousLayer) {
            this.storeSelectionStateForLayer(previousLayer);
        }

        // Update glyph_stack by removing the last component
        const parsed = this.parseGlyphStack();
        const componentPath: number[] = [];
        // Extract component path (excluding the last one we're exiting)
        for (let i = 0; i < parsed.length; i++) {
            if (
                parsed[i].componentIndex !== undefined &&
                i < parsed.length - 1
            ) {
                componentPath.push(parsed[i].componentIndex!);
            }
        }
        // Rebuild with reduced path
        const rootGlyphName = this.glyphCanvas.getCurrentGlyphName();
        if (this.selectedLayerId) {
            this.buildGlyphStack(
                rootGlyphName,
                this.selectedLayerId,
                componentPath
            );
        }

        // Clear selections when exiting (selection tracking will be added separately)
        this.clearAllSelections();

        // Update currentGlyphName based on new stack position
        const newParsed = this.parseGlyphStack();
        if (newParsed.length > 1) {
            // Still in a nested component
            this.currentGlyphName = newParsed[newParsed.length - 1].glyphName;
        } else {
            // Back to root level
            this.currentGlyphName = this.glyphCanvas.getCurrentGlyphName();
        }

        const nextLayer = this.getCurrentLayerModel();
        if (nextLayer) {
            this.applySelectionStateForLayer(
                this.getStoredSelectionStateForLayer(nextLayer),
                nextLayer
            );
        }

        console.log(
            `[EXIT] Exited component editing, stack depth: ${this.getComponentDepth()}`
        );
        console.log(`[EXIT] Updated glyph_stack: ${this.glyphStack}`);

        if (!skipUIUpdate) {
            this.glyphCanvas.updateComponentBreadcrumb();
            this.glyphCanvas.updatePropertiesUI();
            this.glyphCanvas.render();
        }

        return true;
    }

    exitAllComponentEditing(): void {
        // If we're in nested component mode, exit all levels first
        // Skip UI updates during batch exit to avoid duplicate layer interfaces
        while (this.isEditingComponent()) {
            this.exitComponentEditing(true); // Skip UI updates
        }
    }

    updateEditorTitleBar(): void {
        // Update the editor title bar with glyph name and breadcrumb
        const editorView = document.getElementById('view-editor');
        if (!editorView) return;

        const titleBar = editorView.querySelector('.view-title-bar');
        if (!titleBar) return;

        const titleLeft = titleBar.querySelector('.view-title-left');
        if (!titleLeft) return;

        // Find or create the glyph name element
        let glyphNameElement = titleBar.querySelector(
            '.editor-glyph-name'
        ) as HTMLSpanElement;
        if (!glyphNameElement) {
            glyphNameElement = document.createElement('span');
            glyphNameElement.className = 'editor-glyph-name';
            glyphNameElement.style.cssText = `
                margin-left: 12px;
                margin-top: -2px;
                font-family: var(--font-families-mono);
                font-size: 13px;
                color: var(--text-secondary);
                display: flex;
                align-items: center;
                gap: 6px;
            `;
            titleLeft.appendChild(glyphNameElement);
        }

        // Clear existing content
        glyphNameElement.innerHTML = '';

        // If not in edit mode, hide the glyph name
        if (
            !this.active ||
            this.glyphCanvas.textRunEditor!.selectedGlyphIndex < 0 ||
            this.glyphCanvas.textRunEditor!.selectedGlyphIndex >=
                this.glyphCanvas.textRunEditor!.shapedGlyphs.length
        ) {
            glyphNameElement.style.display = 'none';
            return;
        }

        glyphNameElement.style.display = 'flex';

        const parsedStack = this.parseGlyphStack();

        // Build breadcrumb trail from glyphStack
        const trail: string[] = [];

        if (this.glyphStack && this.glyphStack !== '') {
            // Add each glyph name from the stack
            for (const item of parsedStack) {
                trail.push(item.glyphName);
            }
        }

        // If we have a breadcrumb trail (in component editing mode), show it
        if (trail.length > 0) {
            // Add breadcrumb trail as clickable text
            trail.forEach((componentName, index) => {
                if (index > 0) {
                    const arrow = document.createElement('span');
                    arrow.className = 'material-symbols-outlined';
                    arrow.textContent = 'chevron_right';
                    arrow.style.cssText = 'opacity: 0.5; font-size: 16px;';
                    glyphNameElement.appendChild(arrow);
                }

                const item = document.createElement('span');
                item.textContent = componentName;
                item.style.cssText = `
                    cursor: pointer;
                    transition: opacity 0.15s;
                `;

                // Current level is highlighted
                if (index === trail.length - 1) {
                    item.style.fontWeight = '500';
                    item.style.color = 'var(--text-primary)';
                } else {
                    item.style.opacity = '0.7';
                    item.style.color = 'var(--text-secondary)';
                }

                // Hover effect
                item.addEventListener('mouseenter', () => {
                    if (index < trail.length - 1) {
                        item.style.opacity = '1';
                    }
                });
                item.addEventListener('mouseleave', () => {
                    if (index < trail.length - 1) {
                        item.style.opacity = '0.7';
                    }
                });

                // Click to navigate to that level
                item.addEventListener('click', () => {
                    const levelsToExit = trail.length - 1 - index;
                    // Skip UI updates during batch exit to avoid duplicate layer interfaces
                    for (let i = 0; i < levelsToExit; i++) {
                        this.exitComponentEditing(true); // Skip UI updates
                    }
                    // Update UI once after all exits
                    if (levelsToExit > 0) {
                        this.glyphCanvas.doUIUpdate();
                    }
                });

                glyphNameElement.appendChild(item);
            });
        } else {
            // Not in component editing - just show main glyph name
            const mainGlyphName = this.glyphCanvas.getCurrentGlyphName();
            const mainNameSpan = document.createElement('span');
            mainNameSpan.textContent = mainGlyphName;
            mainNameSpan.style.cssText = `
                color: var(--text-primary);
                font-weight: 500;
            `;

            glyphNameElement.appendChild(mainNameSpan);
        }
    }

    extractComponentTransformFromInterpolatedLayer(
        parentLayer: any
    ): number[] | null {
        // Navigate through the glyphStack accumulating interpolated transforms
        // This matches how getAccumulatedTransform() works for master layers

        const parsed = this.parseGlyphStack();
        console.log(
            '[extractComponentTransform] Called with glyphStack depth:',
            parsed.length
        );

        let a = 1,
            b = 0,
            c = 0,
            d = 1,
            tx = 0,
            ty = 0;
        let currentLayer = parentLayer;

        // Skip the first item (root glyph), process remaining items (components)
        for (let i = 1; i < parsed.length; i++) {
            const stackItem = parsed[i];
            if (
                !currentLayer?.shapes ||
                stackItem.componentIndex === undefined
            ) {
                console.error(
                    '[OutlineEditor] Cannot navigate glyphStack - missing shapes or invalid index',
                    { stackItem, currentLayer }
                );
                return null;
            }

            const componentShape =
                currentLayer.shapes[stackItem.componentIndex];
            if (!componentShape || !('reference' in componentShape)) {
                console.error(
                    '[OutlineEditor] Component shape not found at index',
                    stackItem.componentIndex
                );
                return null;
            }

            // Get this component's interpolated transform and accumulate it
            const t = componentShape.transform || [1, 0, 0, 1, 0, 0];
            console.log(
                '[extractComponentTransform] Stack level',
                i,
                'component:',
                componentShape.reference,
                'transform:',
                t
            );

            // Multiply transforms: new = current * level
            const newA = a * t[0] + c * t[1];
            const newB = b * t[0] + d * t[1];
            const newC = a * t[2] + c * t[3];
            const newD = b * t[2] + d * t[3];
            const newTx = a * t[4] + c * t[5] + tx;
            const newTy = b * t[4] + d * t[5] + ty;

            a = newA;
            b = newB;
            c = newC;
            d = newD;
            tx = newTx;
            ty = newTy;

            // Get the component's layer data to continue navigating (unless this is the last level)
            if (i < parsed.length - 1) {
                if (!componentShape.layerData) {
                    console.error(
                        '[OutlineEditor] Component has no layerData',
                        componentShape.reference
                    );
                    return null;
                }

                // Move to the next level
                currentLayer = componentShape.layerData;
            }
        }

        // Return the accumulated transform
        console.log(
            '[extractComponentTransform] Final accumulated transform:',
            [a, b, c, d, tx, ty]
        );
        return [a, b, c, d, tx, ty];
    }

    /**
     * Get accumulated transform from glyphStack by navigating through root layerData
     * This replaces the old componentStack-based approach
     */
    getAccumulatedTransformFromStack(): number[] {
        let a = 1,
            b = 0,
            c = 0,
            d = 1,
            tx = 0,
            ty = 0;

        if (!this.layerData || !this.glyphStack) {
            return [a, b, c, d, tx, ty];
        }

        const parsed = this.parseGlyphStack();
        console.log(
            `[getAccumulatedTransformFromStack] Stack: ${this.glyphStack}`
        );
        console.log(
            `[getAccumulatedTransformFromStack] Parsed depth: ${parsed.length - 1}`,
            parsed
        );

        // Start at root and navigate through components
        let currentLayerData: Babelfont.Layer | null = this.layerData;

        for (let i = 0; i < parsed.length; i++) {
            const item = parsed[i];

            // Skip root (no transform to apply)
            if (item.componentIndex === undefined) {
                continue;
            }

            // Get the component shape
            if (
                !currentLayerData ||
                !currentLayerData.shapes ||
                !currentLayerData.shapes[item.componentIndex]
            ) {
                console.error(
                    '[getAccumulatedTransformFromStack] Invalid navigation at index',
                    i,
                    'componentIndex:',
                    item.componentIndex
                );
                break;
            }

            const shape: Babelfont.Shape =
                currentLayerData.shapes[item.componentIndex];
            if (!('reference' in shape)) {
                console.error(
                    '[getAccumulatedTransformFromStack] Shape at index',
                    item.componentIndex,
                    'is not a component'
                );
                break;
            }

            console.log(
                `[getAccumulatedTransformFromStack] Level ${i}: component "${shape.reference}", transform:`,
                shape.transform
            );

            // Apply this component's transform
            if (shape.transform) {
                // Convert to array format if needed
                const t = Array.isArray(shape.transform)
                    ? shape.transform
                    : DecomposedAffineTransform.toAffine(shape.transform);
                const newA = a * t[0] + c * t[1];
                const newB = b * t[0] + d * t[1];
                const newC = a * t[2] + c * t[3];
                const newD = b * t[2] + d * t[3];
                const newTx = a * t[4] + c * t[5] + tx;
                const newTy = b * t[4] + d * t[5] + ty;
                a = newA;
                b = newB;
                c = newC;
                d = newD;
                tx = newTx;
                ty = newTy;
            }

            // Move to next level
            currentLayerData = shape.layerData || null;
        }

        const result = [a, b, c, d, tx, ty];
        console.log('[getAccumulatedTransformFromStack] Result:', result);
        return result;
    }

    /**
     * @deprecated Use getAccumulatedTransformFromStack() instead
     * Legacy method kept for backward compatibility during migration
     */
    getAccumulatedTransform(): number[] {
        // For now, delegate to new implementation
        return this.getAccumulatedTransformFromStack();
    }

    transformMouseToComponentSpace(): { glyphX: number; glyphY: number } {
        // Transform mouse coordinates from canvas to component local space
        let { glyphX, glyphY } = this.glyphCanvas.toGlyphLocal(
            this.glyphCanvas.mouseX,
            this.glyphCanvas.mouseY
        );

        // Apply inverse component transform if editing a component
        if (this.isEditingComponent()) {
            const glyphXBeforeInverse = glyphX;
            const glyphYBeforeInverse = glyphY;
            const compTransform = this.getAccumulatedTransform();
            const [a, b, c, d, tx, ty] = compTransform;
            const det = a * d - b * c;

            if (Math.abs(det) > 0.0001) {
                // Inverse transform: (x', y') = inverse(T) * (x - tx, y - ty)
                const localX = glyphX - tx;
                const localY = glyphY - ty;
                glyphX = (d * localX - c * localY) / det;
                glyphY = (a * localY - b * localX) / det;
            }
            console.log(
                `[transformMouseToComponentSpace] before inverse=(${glyphXBeforeInverse}, ${glyphYBeforeInverse}), after inverse=(${glyphX}, ${glyphY}), accumulated transform=[${compTransform}], det=${det}`
            );
        }

        return { glyphX, glyphY };
    }

    /**
     * Capture the current bbox center as an anchor point in screen coordinates.
     * This is called before starting an animation (slider or layer switch).
     */
    captureAutoPanAnchor() {
        if (!this.autoPanEnabled) {
            this.autoPanAnchorScreen = null;
            return;
        }

        if (!this.active) {
            this.autoPanAnchorScreen = null;
            return;
        }

        this.autoPanAnchorScreen = this.getBoundingBoxCenterScreenPosition();
    }

    /**
     * Adjust pan to keep the bbox center at the anchor point.
     * This is called after interpolation updates the glyph.
     */
    applyAutoPanAdjustment() {
        if (!this.autoPanEnabled || !this.autoPanAnchorScreen) {
            return;
        }

        this.applyBoundingBoxCenterScreenAnchor(this.autoPanAnchorScreen);
    }

    calculateGlyphBoundingBox(): {
        minX: number;
        minY: number;
        maxX: number;
        maxY: number;
        width: number;
        height: number;
    } | null {
        // Calculate bounding box for the currently edited glyph
        // When editing a component, this returns the bbox of the component, not the root glyph
        // Returns {minX, minY, maxX, maxY, width, height} in glyph-local coordinates
        // Returns null if no glyph is selected or no layer data is available

        if (!this.active || !this.layerData) {
            return null;
        }

        // Get the layer data for the current editing position
        // If editing a component, this navigates to the component's layer data
        const currentLayerData = this.getCurrentLayerDataFromStack();
        if (!currentLayerData) {
            return null;
        }

        console.log(
            '[OutlineEditor]',
            'calculateGlyphBoundingBox: currentLayerData.shapes=',
            currentLayerData.shapes,
            'currentLayerData.width=',
            currentLayerData.width,
            'isEditingComponent=',
            this.isEditingComponent()
        );

        // Use the Layer.calculateBoundingBox static method with includeAnchors=true
        // to match the old behavior of including anchors
        const bbox = Layer.calculateBoundingBox(currentLayerData, true);

        if (bbox) {
            console.log(
                '[OutlineEditor]',
                'calculateGlyphBoundingBox: bbox=',
                bbox
            );
        } else {
            console.log(
                '[OutlineEditor]',
                'calculateGlyphBoundingBox: No bbox calculated'
            );
        }

        return bbox;
    }

    async restoreTargetLayerDataAfterAnimating(): Promise<void> {
        if (this.targetLayerData) {
            console.log(
                'Before restore - layerData.isInterpolated:',
                this.layerData?.isInterpolated
            );
            console.log(
                'Before restore - targetLayerData.isInterpolated:',
                this.targetLayerData?.isInterpolated
            );
            this.layerData = this.targetLayerData;
            this.targetLayerData = null;
            // Clear interpolated flag to restore editing mode
            if (this.layerData) {
                this.layerData.isInterpolated = false;
                // Also clear on shapes
                if (this.layerData.shapes) {
                    this.layerData.shapes.forEach((shape: any) => {
                        if (shape.isInterpolated !== undefined) {
                            shape.isInterpolated = false;
                        }
                    });
                }
            }
            console.log(
                'After restore - layerData.isInterpolated:',
                this.layerData?.isInterpolated
            );
            console.log(
                'Layer switch animation complete, restored target layer for editing'
            );

            // Only re-match if we don't already have an explicitly selected layer.
            // When the user clicked a layer (including brace layers), selectedLayerId
            // is already set correctly by selectLayer() — don't override it.
            if (!this.selectedLayerId) {
                await this.autoSelectMatchingLayer();
            }

            const currentLayer = this.getCurrentLayerModel();
            if (currentLayer) {
                this.applySelectionStateForLayer(
                    this.getStoredSelectionStateForLayer(currentLayer),
                    currentLayer
                );
            }

            if (this.active) {
                this.glyphCanvas.updatePropertyPanel();
                this.glyphCanvas.render();
            }
        }
    }
}

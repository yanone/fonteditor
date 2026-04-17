import { LayerDataNormalizer } from '../layer-data-normalizer';
import { fontInterpolation } from '../font-interpolation';
import { GlyphCanvas } from '../glyph-canvas';
import fontManager from '../font-manager';
import type { Babelfont } from '../babelfont';
import { Transform } from '../basictypes';
import { Logger } from '../logger';
import { normalizeWorkerReplayTargets } from '../change-log';
import {
    Layer,
    DecomposedAffineTransform,
    withSuppressedModelRecording,
    withSuppressedMetricsKeyRecompute
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
    source: 'active' | 'left' | 'right' | 'origin' | 'metric' | 'edge';
};
type ActiveSnapTarget = {
    xSource: SnapCandidate | null;
    ySource: SnapCandidate | null;
    snappedX: number;
    snappedY: number;
};
type SnapVisualizationState = {
    debugCandidates: SnapCandidate[];
    snapTarget: ActiveSnapTarget | null;
    naturalPos: { x: number; y: number } | null;
    originPos: { x: number; y: number } | null;
};
type SnapCandidateCache = {
    activeOnlyDragCandidates: SnapCandidate[];
    allDragCandidates: SnapCandidate[];
    debugCandidates: SnapCandidate[];
    snapDistFontUnits: number;
    edgeXValues: number[];
    metricsYValues: number[];
};
type GuideHandle = { scope: 'master' | 'layer'; index: number };
type SidebearingHandle = { side: SidebearingSide; editable?: boolean };
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

type PathSegmentDescriptor = ReturnType<
    typeof Layer.getPathSegmentDescriptors
>[number];

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

type OpenPathEndpointRef = {
    shapeIndex: number;
    pathIndex: number;
    nodeIndex: number;
    edge: 'start' | 'end';
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

type ResizeHandleAxisRole = -1 | 0 | 1;

type SelectionTransformBounds = {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    width: number;
    height: number;
    centerX: number;
    centerY: number;
};

type SelectionResizeHandle = {
    key: string;
    x: number;
    y: number;
    actualX: number;
    actualY: number;
    xRole: ResizeHandleAxisRole;
    yRole: ResizeHandleAxisRole;
    cursor: string;
};

type SelectionResizePointSnapshot = {
    contourIndex: number;
    nodeIndex: number;
    x: number;
    y: number;
};

type SelectionResizeAnchorSnapshot = {
    anchorIndex: number;
    x: number;
    y: number;
};

type SelectionResizeComponentSnapshot = {
    componentIndex: number;
    transform: Transform;
    usesArrayTransform: boolean;
};

type SmoothHandleDirectionSnapshot = {
    contourIndex: number;
    anchorIndex: number;
    prevHandleIndex: number | null;
    prevDirectionX: number | null;
    prevDirectionY: number | null;
    nextHandleIndex: number | null;
    nextDirectionX: number | null;
    nextDirectionY: number | null;
};

type SelectionResizeSnapshot = {
    bounds: SelectionTransformBounds;
    handle: SelectionResizeHandle;
    points: SelectionResizePointSnapshot[];
    anchors: SelectionResizeAnchorSnapshot[];
    components: SelectionResizeComponentSnapshot[];
    includesGeometry: boolean;
    includesAnchors: boolean;
    useStrokeAwareScaling: boolean;
    strokeAwareGeometry: StrokeAwareGeometrySnapshot | null;
    strokeAwareTargets: StrokeAwareTargetSnapshot[];
    smoothHandleDirections: SmoothHandleDirectionSnapshot[];
    contrastAxisAngleDegrees: number;
};

type ContrastAxisHandle = {
    key: 'start' | 'end';
    x: number;
    y: number;
    cursor: string;
};

type StrokeAwareGeometrySnapshot = {
    centerlineBranches: Array<Array<{ x: number; y: number }>>;
    spokes: Array<{
        startX: number;
        startY: number;
        endX: number;
        endY: number;
    }>;
};

type StrokeAwareCenterlineAttachment = {
    centerBranchIndex: number;
    centerSegmentIndex: number;
    centerSegmentT: number;
    tangentX: number;
    tangentY: number;
    normalX: number;
    normalY: number;
    tangentOffset: number;
    normalOffset: number;
};

type StrokeAwareTargetSnapshot = {
    kind: 'point' | 'anchor';
    contourIndex: number | null;
    nodeIndex: number | null;
    anchorIndex: number | null;
    attachments: StrokeAwareCenterlineAttachment[];
};

type StrokeAwareCenterlineDebugGeometry = {
    centerlineBranches: Array<Array<{ x: number; y: number }>>;
    spokes: Array<{
        startX: number;
        startY: number;
        endX: number;
        endY: number;
    }>;
};

type StrokeAwareSelectionGeometry = {
    geometry: StrokeAwareGeometrySnapshot;
    targets: StrokeAwareTargetSnapshot[];
    debugGeometry: StrokeAwareCenterlineDebugGeometry;
};

const CONTRAST_AXIS_FORMAT_SPECIFIC_KEY =
    'space.counterpunch.contrast_axis_angle';
const DEFAULT_CONTRAST_AXIS_ANGLE_DEGREES = 90;

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

function canOnCurvePointBeSmooth(
    contour: EditableContour,
    nodeIndex: number
): boolean {
    const node = contour.nodes[nodeIndex];
    if (!node || !isOnCurveNode(node) || node.nodetype === 'Move') {
        return false;
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
        return false;
    }

    if (!contour.closed) {
        const lastIndex = contour.nodes.length - 1;
        if (nodeIndex === 0 || nodeIndex === lastIndex) {
            return false;
        }
    }

    const prevNode = contour.nodes[prevIndex];
    const nextNode = contour.nodes[nextIndex];
    const prevIsHandle = isOffCurveNode(prevNode);
    const nextIsHandle = isOffCurveNode(nextNode);

    return (
        (prevIsHandle && nextIsHandle) ||
        (prevIsHandle && isOnCurveNode(nextNode)) ||
        (nextIsHandle && isOnCurveNode(prevNode))
    );
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

function getOffCurveDragConstraintReference(
    contour: EditableContour,
    offcurveIndex: number
): {
    anchorX: number;
    anchorY: number;
    directionX: number;
    directionY: number;
} | null {
    const offcurve = contour.nodes[offcurveIndex];
    if (!isOffCurveNode(offcurve)) {
        return null;
    }

    const prevIndex = getNeighborNodeIndex(
        offcurveIndex,
        -1,
        contour.nodes.length,
        contour.closed
    );
    const nextIndex = getNeighborNodeIndex(
        offcurveIndex,
        1,
        contour.nodes.length,
        contour.closed
    );
    const prevNode = prevIndex !== null ? contour.nodes[prevIndex] : null;
    const nextNode = nextIndex !== null ? contour.nodes[nextIndex] : null;
    const prevIsOnCurve = isOnCurveNode(prevNode);
    const nextIsOnCurve = isOnCurveNode(nextNode);

    // Cubic handles have exactly one adjacent on-curve anchor. If both sides
    // are on-curve, there is no single anchor to constrain against here.
    if (prevIsOnCurve === nextIsOnCurve) {
        return null;
    }

    const anchor = prevIsOnCurve ? prevNode : nextNode;
    if (!anchor || anchor.smooth) {
        return null;
    }

    const directionX = offcurve.x - anchor.x;
    const directionY = offcurve.y - anchor.y;
    if (directionX === 0 && directionY === 0) {
        return null;
    }

    return {
        anchorX: anchor.x,
        anchorY: anchor.y,
        directionX,
        directionY
    };
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

function multiplyAffineTransforms(
    left: Transform,
    right: Transform
): Transform {
    return [
        left[0] * right[0] + left[2] * right[1],
        left[1] * right[0] + left[3] * right[1],
        left[0] * right[2] + left[2] * right[3],
        left[1] * right[2] + left[3] * right[3],
        left[0] * right[4] + left[2] * right[5] + left[4],
        left[1] * right[4] + left[3] * right[5] + left[5]
    ];
}

function createAffineScaleAboutPoint(
    anchorX: number,
    anchorY: number,
    scaleX: number,
    scaleY: number,
    translateX: number = 0,
    translateY: number = 0
): Transform {
    return [
        scaleX,
        0,
        0,
        scaleY,
        anchorX - scaleX * anchorX + translateX,
        anchorY - scaleY * anchorY + translateY
    ];
}

function dotProduct(
    leftX: number,
    leftY: number,
    rightX: number,
    rightY: number
): number {
    return leftX * rightX + leftY * rightY;
}

function normalizeVector(
    x: number,
    y: number,
    fallbackX: number = 1,
    fallbackY: number = 0
): { x: number; y: number } {
    const length = Math.hypot(x, y);
    if (length <= 0.000001) {
        return { x: fallbackX, y: fallbackY };
    }

    return { x: x / length, y: y / length };
}

function normalizeContrastAxisAngle(angleDegrees: number): number {
    const normalized = angleDegrees % 180;
    return normalized < 0 ? normalized + 180 : normalized;
}

function crossProduct2D(
    leftX: number,
    leftY: number,
    rightX: number,
    rightY: number
): number {
    return leftX * rightY - leftY * rightX;
}

function sampleDescriptorPoints(
    descriptor: PathSegmentDescriptor
): Array<{ x: number; y: number }> {
    if (descriptor.type === 'line') {
        return descriptor.points.map((point) => ({ x: point.x, y: point.y }));
    }

    const curve = new Bezier(descriptor.points);
    const sampleCount = descriptor.type === 'cubic' ? 24 : 18;
    return curve.getLUT(sampleCount).map((point: { x: number; y: number }) => ({
        x: point.x,
        y: point.y
    }));
}

/**
 * Evaluate a path segment at parameter t and return both point and tangent.
 */
function evaluateDescriptorAt(
    descriptor: PathSegmentDescriptor,
    t: number
): { x: number; y: number; tangentX: number; tangentY: number } {
    const safeT = clampUnitInterval(t);
    if (descriptor.type === 'line') {
        const start = descriptor.points[0];
        const end = descriptor.points[descriptor.points.length - 1];
        const tangent = normalizeVector(end.x - start.x, end.y - start.y, 1, 0);
        return {
            x: start.x + (end.x - start.x) * safeT,
            y: start.y + (end.y - start.y) * safeT,
            tangentX: tangent.x,
            tangentY: tangent.y
        };
    }

    const curve = new Bezier(descriptor.points);
    const point = curve.get(safeT);
    const derivative = curve.derivative(safeT);
    const tangent = normalizeVector(derivative.x, derivative.y, 1, 0);
    return {
        x: point.x,
        y: point.y,
        tangentX: tangent.x,
        tangentY: tangent.y
    };
}

/**
 * Choose one centerline branch per contour segment using repeated cross-section
 * samples plus a continuity penalty so ownership does not jump branches unless
 * the geometric evidence is clearly better.
 */
function chooseSegmentBranchesForContour(
    descriptors: PathSegmentDescriptor[],
    centerlineBranches: Array<Array<{ x: number; y: number }>>
): Map<number, number> {
    const assignments = new Map<number, number>();
    if (descriptors.length === 0 || centerlineBranches.length === 0) {
        return assignments;
    }
    if (centerlineBranches.length === 1) {
        descriptors.forEach((descriptor) => {
            assignments.set(descriptor.segmentId, 0);
        });
        return assignments;
    }

    const descriptorScores = descriptors.map((descriptor) => {
        const sampleTs =
            descriptor.type === 'line' ? [0.25, 0.5, 0.75] : [0.2, 0.5, 0.8];
        return centerlineBranches.map((branch) => {
            let totalScore = 0;
            let totalDistance = 0;

            sampleTs.forEach((sampleT) => {
                const sample = evaluateDescriptorAt(descriptor, sampleT);
                const projection = projectPointOntoPolyline(sample, branch);
                const sampleTangent = normalizeVector(
                    sample.tangentX,
                    sample.tangentY,
                    1,
                    0
                );
                const sampleNormal = {
                    x: -sampleTangent.y,
                    y: sampleTangent.x
                };
                const vectorToCenterline = {
                    x: projection.x - sample.x,
                    y: projection.y - sample.y
                };
                const crossSectionDirection = normalizeVector(
                    vectorToCenterline.x,
                    vectorToCenterline.y,
                    sampleNormal.x,
                    sampleNormal.y
                );
                const tangentAlignment = Math.abs(
                    dotProduct(
                        sampleTangent.x,
                        sampleTangent.y,
                        projection.tangentX,
                        projection.tangentY
                    )
                );
                const normalAlignment = Math.abs(
                    dotProduct(
                        crossSectionDirection.x,
                        crossSectionDirection.y,
                        sampleNormal.x,
                        sampleNormal.y
                    )
                );

                totalDistance += projection.distance;
                totalScore +=
                    projection.distance +
                    (1 - tangentAlignment) * 28 +
                    (1 - normalAlignment) * 36;
            });

            return {
                score: totalScore / sampleTs.length,
                averageDistance: totalDistance / sampleTs.length
            };
        });
    });

    const branchCount = centerlineBranches.length;
    const descriptorCount = descriptors.length;
    let bestPath: number[] = [];
    let bestPathScore = Number.POSITIVE_INFINITY;

    const buildSwitchPenalty = (
        previousBranchIndex: number,
        currentBranchIndex: number,
        descriptorIndex: number
    ): number => {
        if (previousBranchIndex === currentBranchIndex) {
            return 0;
        }

        const previousDistance =
            descriptorScores[Math.max(0, descriptorIndex - 1)][
                previousBranchIndex
            ].averageDistance;
        const currentDistance =
            descriptorScores[descriptorIndex][currentBranchIndex]
                .averageDistance;
        return Math.max(12, (previousDistance + currentDistance) * 0.6 + 8);
    };

    for (
        let startBranchIndex = 0;
        startBranchIndex < branchCount;
        startBranchIndex++
    ) {
        const dp = Array.from({ length: descriptorCount }, () =>
            Array.from({ length: branchCount }, () => Number.POSITIVE_INFINITY)
        );
        const previousBranch = Array.from({ length: descriptorCount }, () =>
            Array.from({ length: branchCount }, () => -1)
        );
        dp[0][startBranchIndex] = descriptorScores[0][startBranchIndex].score;

        for (
            let descriptorIndex = 1;
            descriptorIndex < descriptorCount;
            descriptorIndex++
        ) {
            for (
                let currentBranchIndex = 0;
                currentBranchIndex < branchCount;
                currentBranchIndex++
            ) {
                const localScore =
                    descriptorScores[descriptorIndex][currentBranchIndex].score;
                for (
                    let previousBranchIndex = 0;
                    previousBranchIndex < branchCount;
                    previousBranchIndex++
                ) {
                    const candidateScore =
                        dp[descriptorIndex - 1][previousBranchIndex] +
                        buildSwitchPenalty(
                            previousBranchIndex,
                            currentBranchIndex,
                            descriptorIndex
                        ) +
                        localScore;
                    if (
                        candidateScore < dp[descriptorIndex][currentBranchIndex]
                    ) {
                        dp[descriptorIndex][currentBranchIndex] =
                            candidateScore;
                        previousBranch[descriptorIndex][currentBranchIndex] =
                            previousBranchIndex;
                    }
                }
            }
        }

        for (
            let endBranchIndex = 0;
            endBranchIndex < branchCount;
            endBranchIndex++
        ) {
            const closedScore =
                dp[descriptorCount - 1][endBranchIndex] +
                buildSwitchPenalty(
                    endBranchIndex,
                    startBranchIndex,
                    descriptorCount - 1
                );
            if (closedScore >= bestPathScore) {
                continue;
            }

            const path = new Array<number>(descriptorCount);
            let branchIndex = endBranchIndex;
            for (
                let descriptorIndex = descriptorCount - 1;
                descriptorIndex >= 0;
                descriptorIndex--
            ) {
                path[descriptorIndex] = branchIndex;
                branchIndex = previousBranch[descriptorIndex][branchIndex];
                if (descriptorIndex === 0) {
                    break;
                }
            }

            bestPathScore = closedScore;
            bestPath = path;
        }
    }

    descriptors.forEach((descriptor, descriptorIndex) => {
        assignments.set(descriptor.segmentId, bestPath[descriptorIndex] ?? 0);
    });
    return assignments;
}

function buildClosedContourSampledPolyline(
    contour: EditableContour
): Array<{ x: number; y: number }> {
    const descriptors = Layer.getPathSegmentDescriptors({
        nodes: contour.nodes,
        closed: contour.closed
    });
    const points: Array<{ x: number; y: number }> = [];

    descriptors.forEach((descriptor, descriptorIndex) => {
        const samples = sampleDescriptorPoints(descriptor);
        samples.forEach((sample, sampleIndex) => {
            if (descriptorIndex > 0 && sampleIndex === 0) {
                return;
            }

            const previous = points[points.length - 1];
            if (
                previous &&
                Math.hypot(previous.x - sample.x, previous.y - sample.y) <=
                    0.000001
            ) {
                return;
            }

            points.push({ x: sample.x, y: sample.y });
        });
    });

    if (
        points.length > 1 &&
        Math.hypot(
            points[0].x - points[points.length - 1].x,
            points[0].y - points[points.length - 1].y
        ) <= 0.000001
    ) {
        points.pop();
    }

    return points;
}

function buildContourPath2D(contour: EditableContour): Path2D | null {
    const descriptors = Layer.getPathSegmentDescriptors({
        nodes: contour.nodes,
        closed: contour.closed
    });
    if (descriptors.length === 0) {
        return null;
    }

    const path = new Path2D();
    path.moveTo(descriptors[0].points[0].x, descriptors[0].points[0].y);

    descriptors.forEach((descriptor) => {
        if (descriptor.type === 'line') {
            path.lineTo(descriptor.points[1].x, descriptor.points[1].y);
            return;
        }

        if (descriptor.type === 'quadratic') {
            path.quadraticCurveTo(
                descriptor.points[1].x,
                descriptor.points[1].y,
                descriptor.points[2].x,
                descriptor.points[2].y
            );
            return;
        }

        path.bezierCurveTo(
            descriptor.points[1].x,
            descriptor.points[1].y,
            descriptor.points[2].x,
            descriptor.points[2].y,
            descriptor.points[3].x,
            descriptor.points[3].y
        );
    });

    if (contour.closed) {
        path.closePath();
    }

    return path;
}

function buildCombinedContourPath2D(
    currentLayerData: Babelfont.Layer,
    contourIndices: number[]
): Path2D | null {
    const path = new Path2D();
    let hasContours = false;

    contourIndices.forEach((contourIndex) => {
        const contour = getEditableContour(
            currentLayerData.shapes?.[contourIndex]
        );
        if (!contour) {
            return;
        }

        const contourPath = buildContourPath2D(contour);
        if (!contourPath) {
            return;
        }

        path.addPath(contourPath);
        hasContours = true;
    });

    return hasContours ? path : null;
}

function rasterizeContourMask(
    currentLayerData: Babelfont.Layer,
    contourIndices: number[]
): {
    mask: Uint8Array;
    width: number;
    height: number;
    scale: number;
    minX: number;
    minY: number;
    padding: number;
} | null {
    const boundaryPolylines = contourIndices
        .map((contourIndex) =>
            getEditableContour(currentLayerData.shapes?.[contourIndex])
        )
        .filter((contour): contour is EditableContour => Boolean(contour))
        .map((contour) => buildClosedContourSampledPolyline(contour))
        .filter((polyline) => polyline.length >= 3);
    if (boundaryPolylines.length === 0) {
        return null;
    }

    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    boundaryPolylines.forEach((polyline) => {
        polyline.forEach((point) => {
            minX = Math.min(minX, point.x);
            minY = Math.min(minY, point.y);
            maxX = Math.max(maxX, point.x);
            maxY = Math.max(maxY, point.y);
        });
    });

    const boundsWidth = Math.max(1, maxX - minX);
    const boundsHeight = Math.max(1, maxY - minY);
    const padding = 12;
    const targetLongestSide = 384;
    const maxRasterSide = 768;
    let scale = Math.min(
        4,
        Math.max(0.35, targetLongestSide / Math.max(boundsWidth, boundsHeight))
    );
    const projectedLongestSide =
        Math.max(boundsWidth, boundsHeight) * scale + padding * 2;
    if (projectedLongestSide > maxRasterSide) {
        scale *= maxRasterSide / projectedLongestSide;
    }

    const width = Math.max(3, Math.ceil(boundsWidth * scale) + padding * 2);
    const height = Math.max(3, Math.ceil(boundsHeight * scale) + padding * 2);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
        return null;
    }

    const path = buildCombinedContourPath2D(currentLayerData, contourIndices);
    if (!path) {
        return null;
    }

    ctx.clearRect(0, 0, width, height);
    ctx.save();
    ctx.translate(padding - minX * scale, padding - minY * scale);
    ctx.scale(scale, scale);
    ctx.fillStyle = '#000';
    ctx.fill(path, 'nonzero');
    ctx.restore();

    const imageData = ctx.getImageData(0, 0, width, height);
    const mask = new Uint8Array(width * height);
    for (let pixelIndex = 0; pixelIndex < width * height; pixelIndex++) {
        mask[pixelIndex] = imageData.data[pixelIndex * 4 + 3] > 0 ? 1 : 0;
    }

    return {
        mask,
        width,
        height,
        scale,
        minX,
        minY,
        padding
    };
}

function thinMaskToSkeleton(
    mask: Uint8Array,
    width: number,
    height: number
): Uint8Array {
    const result = new Uint8Array(mask);
    const get = (x: number, y: number): number => result[y * width + x];
    const neighbors = [
        [0, -1],
        [1, -1],
        [1, 0],
        [1, 1],
        [0, 1],
        [-1, 1],
        [-1, 0],
        [-1, -1]
    ] as const;

    let changed = true;
    while (changed) {
        changed = false;
        for (let phase = 0; phase < 2; phase++) {
            const toRemove: number[] = [];

            for (let y = 1; y < height - 1; y++) {
                for (let x = 1; x < width - 1; x++) {
                    const index = y * width + x;
                    if (result[index] === 0) {
                        continue;
                    }

                    const ring = neighbors.map(([deltaX, deltaY]) =>
                        get(x + deltaX, y + deltaY)
                    );
                    const neighborCount = ring.reduce(
                        (sum, value) => sum + value,
                        0
                    );
                    if (neighborCount < 2 || neighborCount > 6) {
                        continue;
                    }

                    let transitions = 0;
                    for (
                        let ringIndex = 0;
                        ringIndex < ring.length;
                        ringIndex++
                    ) {
                        const current = ring[ringIndex];
                        const next = ring[(ringIndex + 1) % ring.length];
                        if (current === 0 && next === 1) {
                            transitions++;
                        }
                    }
                    if (transitions !== 1) {
                        continue;
                    }

                    const [p2, p3, p4, p5, p6, p7, p8, p9] = ring;
                    const phasePasses =
                        phase === 0
                            ? p2 * p4 * p6 === 0 && p4 * p6 * p8 === 0
                            : p2 * p4 * p8 === 0 && p2 * p6 * p8 === 0;
                    if (!phasePasses) {
                        continue;
                    }

                    toRemove.push(index);
                }
            }

            if (toRemove.length > 0) {
                changed = true;
                toRemove.forEach((index) => {
                    result[index] = 0;
                });
            }
        }
    }

    return result;
}

function buildSkeletonNeighbors(
    mask: Uint8Array,
    width: number,
    height: number
): Map<number, number[]> {
    const neighborDeltas = [
        [-1, -1],
        [0, -1],
        [1, -1],
        [-1, 0],
        [1, 0],
        [-1, 1],
        [0, 1],
        [1, 1]
    ] as const;
    const neighbors = new Map<number, number[]>();

    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const index = y * width + x;
            if (mask[index] === 0) {
                continue;
            }

            const adjacent = neighborDeltas
                .map(([deltaX, deltaY]) => (y + deltaY) * width + (x + deltaX))
                .filter((candidateIndex) => mask[candidateIndex] !== 0);
            neighbors.set(index, adjacent);
        }
    }

    return neighbors;
}

function extractSkeletonBranches(
    mask: Uint8Array,
    width: number,
    height: number
): Array<Array<{ x: number; y: number }>> {
    const neighbors = buildSkeletonNeighbors(mask, width, height);
    const nodes = [...neighbors.keys()];
    if (nodes.length === 0) {
        return [];
    }

    const keyForEdge = (left: number, right: number): string =>
        left < right ? `${left}:${right}` : `${right}:${left}`;
    const branchNodes = new Set(
        nodes.filter((index) => (neighbors.get(index) || []).length !== 2)
    );
    const visitedEdges = new Set<string>();
    const branches: Array<Array<{ x: number; y: number }>> = [];

    const appendBranch = (pathIndices: number[]): void => {
        if (pathIndices.length < 2) {
            return;
        }

        const points = pathIndices.map((index) => ({
            x: index % width,
            y: Math.floor(index / width)
        }));
        const pathLength = points.reduce(
            (sum, point, pointIndex) =>
                pointIndex === 0
                    ? 0
                    : sum +
                      Math.hypot(
                          point.x - points[pointIndex - 1].x,
                          point.y - points[pointIndex - 1].y
                      ),
            0
        );
        if (pathLength < 4) {
            return;
        }

        branches.push(points);
    };

    const traverseFrom = (startIndex: number, nextIndex: number): void => {
        const pathIndices = [startIndex, nextIndex];
        visitedEdges.add(keyForEdge(startIndex, nextIndex));
        let previousIndex = startIndex;
        let currentIndex = nextIndex;

        while (!branchNodes.has(currentIndex)) {
            const adjacent = (neighbors.get(currentIndex) || []).filter(
                (candidate) => candidate !== previousIndex
            );
            if (adjacent.length === 0) {
                break;
            }

            const followingIndex = adjacent[0];
            const edgeKey = keyForEdge(currentIndex, followingIndex);
            if (visitedEdges.has(edgeKey)) {
                break;
            }

            pathIndices.push(followingIndex);
            visitedEdges.add(edgeKey);
            previousIndex = currentIndex;
            currentIndex = followingIndex;
        }

        appendBranch(pathIndices);
    };

    if (branchNodes.size === 0) {
        const loop = nodes.map((index) => ({
            x: index % width,
            y: Math.floor(index / width)
        }));
        return loop.length > 1 ? [loop] : [];
    }

    branchNodes.forEach((branchIndex) => {
        (neighbors.get(branchIndex) || []).forEach((neighborIndex) => {
            const edgeKey = keyForEdge(branchIndex, neighborIndex);
            if (visitedEdges.has(edgeKey)) {
                return;
            }

            traverseFrom(branchIndex, neighborIndex);
        });
    });

    return branches;
}

function projectPointOntoBranchSet(
    point: { x: number; y: number },
    branches: Array<Array<{ x: number; y: number }>>
): {
    branchIndex: number;
    segmentIndex: number;
    t: number;
    x: number;
    y: number;
    tangentX: number;
    tangentY: number;
    distance: number;
} {
    let bestProjection: {
        branchIndex: number;
        segmentIndex: number;
        t: number;
        x: number;
        y: number;
        tangentX: number;
        tangentY: number;
        distance: number;
    } | null = null;

    branches.forEach((branch, branchIndex) => {
        const branchProjection = projectPointOntoPolyline(point, branch);
        if (
            !bestProjection ||
            branchProjection.distance < bestProjection.distance
        ) {
            bestProjection = {
                branchIndex,
                ...branchProjection
            };
        }
    });

    return (
        bestProjection || {
            branchIndex: 0,
            segmentIndex: 0,
            t: 0,
            x: point.x,
            y: point.y,
            tangentX: 1,
            tangentY: 0,
            distance: 0
        }
    );
}

/**
 * Build a stroke-aware attachment for a specific branch assignment by
 * projecting the target point onto that branch.
 */
function buildStrokeAwareAttachmentForBranch(
    x: number,
    y: number,
    branches: Array<Array<{ x: number; y: number }>>,
    branchIndex: number
): StrokeAwareCenterlineAttachment {
    const branch = branches[branchIndex] || [];
    const projection = projectPointOntoPolyline({ x, y }, branch);
    const normal = {
        x: -projection.tangentY,
        y: projection.tangentX
    };
    const vectorToNode = {
        x: x - projection.x,
        y: y - projection.y
    };
    const orientedNormal =
        dotProduct(vectorToNode.x, vectorToNode.y, normal.x, normal.y) >= 0
            ? normal
            : { x: -normal.x, y: -normal.y };

    return {
        centerBranchIndex: branchIndex,
        centerSegmentIndex: projection.segmentIndex,
        centerSegmentT: projection.t,
        tangentX: projection.tangentX,
        tangentY: projection.tangentY,
        normalX: orientedNormal.x,
        normalY: orientedNormal.y,
        tangentOffset: dotProduct(
            vectorToNode.x,
            vectorToNode.y,
            projection.tangentX,
            projection.tangentY
        ),
        normalOffset: dotProduct(
            vectorToNode.x,
            vectorToNode.y,
            orientedNormal.x,
            orientedNormal.y
        )
    };
}

/**
 * Solve x/y from weighted tangent and normal constraints contributed by one or
 * more centerline attachments.
 */
function solveStrokeAwareConstraintPoint(
    constraints: Array<{
        directionX: number;
        directionY: number;
        rhs: number;
        weight: number;
    }>
): { x: number; y: number } | null {
    let a00 = 0;
    let a01 = 0;
    let a11 = 0;
    let b0 = 0;
    let b1 = 0;

    constraints.forEach((constraint) => {
        const weightedA = constraint.directionX * constraint.weight;
        const weightedB = constraint.directionY * constraint.weight;
        a00 += weightedA * constraint.directionX;
        a01 += weightedA * constraint.directionY;
        a11 += weightedB * constraint.directionY;
        b0 += weightedA * constraint.rhs;
        b1 += weightedB * constraint.rhs;
    });

    const determinant = a00 * a11 - a01 * a01;
    if (Math.abs(determinant) <= 0.000001) {
        return null;
    }

    return {
        x: (b0 * a11 - b1 * a01) / determinant,
        y: (a00 * b1 - a01 * b0) / determinant
    };
}

/**
 * Derive a local tangent at an on-curve node so extrema can choose a stroke
 * centerline from the point itself rather than from neighboring segment frames.
 */
function getOnCurvePointTangent(
    contour: EditableContour,
    nodeIndex: number
): { x: number; y: number } {
    const smoothDirection = getSmoothAnchorConstraintDirection(
        contour,
        nodeIndex
    );
    if (smoothDirection) {
        return normalizeVector(
            smoothDirection.directionX,
            smoothDirection.directionY,
            1,
            0
        );
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
    const prevNode = prevIndex !== null ? contour.nodes[prevIndex] : null;
    const nextNode = nextIndex !== null ? contour.nodes[nextIndex] : null;
    return normalizeVector(
        (nextNode?.x ?? contour.nodes[nodeIndex].x) -
            (prevNode?.x ?? contour.nodes[nodeIndex].x),
        (nextNode?.y ?? contour.nodes[nodeIndex].y) -
            (prevNode?.y ?? contour.nodes[nodeIndex].y),
        1,
        0
    );
}

/**
 * Choose the best centerline branch for an on-curve point from the point's own
 * cross-section instead of inheriting both adjacent segment branches.
 */
function chooseBranchForOnCurvePoint(
    contour: EditableContour,
    nodeIndex: number,
    centerlineBranches: Array<Array<{ x: number; y: number }>>
): number {
    const node = contour.nodes[nodeIndex];
    const tangent = getOnCurvePointTangent(contour, nodeIndex);
    const normal = { x: -tangent.y, y: tangent.x };
    let bestBranchIndex = 0;
    let bestScore = Number.POSITIVE_INFINITY;

    centerlineBranches.forEach((branch, branchIndex) => {
        const projection = projectPointOntoPolyline(node, branch);
        const vectorToCenterline = {
            x: projection.x - node.x,
            y: projection.y - node.y
        };
        const crossSectionDirection = normalizeVector(
            vectorToCenterline.x,
            vectorToCenterline.y,
            normal.x,
            normal.y
        );
        const tangentAlignment = Math.abs(
            dotProduct(
                tangent.x,
                tangent.y,
                projection.tangentX,
                projection.tangentY
            )
        );
        const normalAlignment = Math.abs(
            dotProduct(
                crossSectionDirection.x,
                crossSectionDirection.y,
                normal.x,
                normal.y
            )
        );
        const score =
            projection.distance +
            (1 - tangentAlignment) * 30 +
            (1 - normalAlignment) * 42;
        if (score < bestScore) {
            bestScore = score;
            bestBranchIndex = branchIndex;
        }
    });

    return bestBranchIndex;
}

function smoothOpenPolyline(
    points: Array<{ x: number; y: number }>,
    iterations: number = 2
): Array<{ x: number; y: number }> {
    let result = points.slice();
    for (let iteration = 0; iteration < iterations; iteration++) {
        if (result.length < 3) {
            return result;
        }

        const next: Array<{ x: number; y: number }> = [result[0]];
        for (let index = 0; index < result.length - 1; index++) {
            const start = result[index];
            const end = result[index + 1];
            next.push({
                x: start.x * 0.75 + end.x * 0.25,
                y: start.y * 0.75 + end.y * 0.25
            });
            next.push({
                x: start.x * 0.25 + end.x * 0.75,
                y: start.y * 0.25 + end.y * 0.75
            });
        }
        next.push(result[result.length - 1]);
        result = next;
    }

    return result;
}

function mapRasterPointToGlyphSpace(
    point: { x: number; y: number },
    raster: {
        scale: number;
        minX: number;
        minY: number;
        padding: number;
    }
): { x: number; y: number } {
    return {
        x: (point.x + 0.5 - raster.padding) / raster.scale + raster.minX,
        y: (point.y + 0.5 - raster.padding) / raster.scale + raster.minY
    };
}

function buildCenterlineSpokes(
    centerlineBranches: Array<Array<{ x: number; y: number }>>,
    boundaryPolylines: Array<Array<{ x: number; y: number }>>
): Array<{ startX: number; startY: number; endX: number; endY: number }> {
    const spokes: Array<{
        startX: number;
        startY: number;
        endX: number;
        endY: number;
    }> = [];
    if (centerlineBranches.length === 0 || boundaryPolylines.length === 0) {
        return spokes;
    }

    const findIntersection = (
        origin: { x: number; y: number },
        direction: { x: number; y: number }
    ): { x: number; y: number; distance: number } | null => {
        let bestIntersection: {
            x: number;
            y: number;
            distance: number;
        } | null = null;

        boundaryPolylines.forEach((boundaryPolyline) => {
            for (let index = 0; index < boundaryPolyline.length; index++) {
                const segmentStart = boundaryPolyline[index];
                const segmentEnd =
                    boundaryPolyline[(index + 1) % boundaryPolyline.length];
                const intersection = intersectRayWithSegment(
                    origin.x,
                    origin.y,
                    direction.x,
                    direction.y,
                    segmentStart.x,
                    segmentStart.y,
                    segmentEnd.x,
                    segmentEnd.y
                );
                if (!intersection) {
                    continue;
                }

                if (
                    !bestIntersection ||
                    intersection.distance < bestIntersection.distance
                ) {
                    bestIntersection = intersection;
                }
            }
        });

        return bestIntersection;
    };

    centerlineBranches.forEach((centerlinePoints) => {
        centerlinePoints.forEach((point, index) => {
            if (index === 0 || index === centerlinePoints.length - 1) {
                return;
            }

            const previous = centerlinePoints[index - 1];
            const next = centerlinePoints[index + 1];
            const tangent = normalizeVector(
                next.x - previous.x,
                next.y - previous.y,
                1,
                0
            );
            const normal = { x: -tangent.y, y: tangent.x };
            const positive = findIntersection(point, normal);
            const negative = findIntersection(point, {
                x: -normal.x,
                y: -normal.y
            });
            if (!positive || !negative) {
                return;
            }

            spokes.push({
                startX: negative.x,
                startY: negative.y,
                endX: positive.x,
                endY: positive.y
            });
        });
    });

    return spokes;
}

function reapplySmoothHandleDirectionsForContour(
    contour: EditableContour
): void {
    for (let nodeIndex = 0; nodeIndex < contour.nodes.length; nodeIndex++) {
        const node = contour.nodes[nodeIndex];
        if (!isOnCurveNode(node) || !node.smooth) {
            continue;
        }

        realignSmoothHandles(contour, nodeIndex);
    }
}

function captureSmoothHandleDirectionSnapshots(
    contour: EditableContour,
    contourIndex: number
): SmoothHandleDirectionSnapshot[] {
    const snapshots: SmoothHandleDirectionSnapshot[] = [];

    for (
        let anchorIndex = 0;
        anchorIndex < contour.nodes.length;
        anchorIndex++
    ) {
        const anchor = contour.nodes[anchorIndex];
        if (!anchor || !isOnCurveNode(anchor) || !anchor.smooth) {
            continue;
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
        const prevHandle =
            prevIndex !== null && isOffCurveNode(contour.nodes[prevIndex])
                ? contour.nodes[prevIndex]
                : null;
        const nextHandle =
            nextIndex !== null && isOffCurveNode(contour.nodes[nextIndex])
                ? contour.nodes[nextIndex]
                : null;

        if (!prevHandle && !nextHandle) {
            continue;
        }

        snapshots.push({
            contourIndex,
            anchorIndex,
            prevHandleIndex: prevHandle ? prevIndex : null,
            prevDirectionX: prevHandle ? prevHandle.x - anchor.x : null,
            prevDirectionY: prevHandle ? prevHandle.y - anchor.y : null,
            nextHandleIndex: nextHandle ? nextIndex : null,
            nextDirectionX: nextHandle ? nextHandle.x - anchor.x : null,
            nextDirectionY: nextHandle ? nextHandle.y - anchor.y : null
        });
    }

    return snapshots;
}

function reapplySmoothHandleDirectionsFromSnapshots(
    contour: EditableContour,
    directionSnapshots: SmoothHandleDirectionSnapshot[]
): void {
    directionSnapshots.forEach((snapshot) => {
        const anchor = contour.nodes[snapshot.anchorIndex];
        if (!anchor || !isOnCurveNode(anchor) || !anchor.smooth) {
            return;
        }

        if (
            snapshot.prevHandleIndex !== null &&
            snapshot.prevDirectionX !== null &&
            snapshot.prevDirectionY !== null
        ) {
            const prevHandle = contour.nodes[snapshot.prevHandleIndex];
            if (prevHandle && isOffCurveNode(prevHandle)) {
                alignHandleAlongDirection(
                    anchor,
                    prevHandle,
                    snapshot.prevDirectionX,
                    snapshot.prevDirectionY
                );
            }
        }

        if (
            snapshot.nextHandleIndex !== null &&
            snapshot.nextDirectionX !== null &&
            snapshot.nextDirectionY !== null
        ) {
            const nextHandle = contour.nodes[snapshot.nextHandleIndex];
            if (nextHandle && isOffCurveNode(nextHandle)) {
                alignHandleAlongDirection(
                    anchor,
                    nextHandle,
                    snapshot.nextDirectionX,
                    snapshot.nextDirectionY
                );
            }
        }
    });
}

function buildPolylineCumulativeLengths(
    points: Array<{ x: number; y: number }>
): number[] {
    const lengths = [0];
    for (let index = 1; index < points.length; index++) {
        lengths.push(
            lengths[index - 1] +
                Math.hypot(
                    points[index].x - points[index - 1].x,
                    points[index].y - points[index - 1].y
                )
        );
    }

    return lengths;
}

function evaluateOpenPolylineAt(
    points: Array<{ x: number; y: number }>,
    segmentIndex: number,
    t: number
): {
    x: number;
    y: number;
    tangentX: number;
    tangentY: number;
} {
    if (points.length === 0) {
        return { x: 0, y: 0, tangentX: 1, tangentY: 0 };
    }

    if (points.length === 1) {
        return {
            x: points[0].x,
            y: points[0].y,
            tangentX: 1,
            tangentY: 0
        };
    }

    const safeSegmentIndex = Math.max(
        0,
        Math.min(points.length - 2, segmentIndex)
    );
    const safeT = clampUnitInterval(t);
    const start = points[safeSegmentIndex];
    const end = points[safeSegmentIndex + 1];
    const tangent = normalizeVector(end.x - start.x, end.y - start.y, 1, 0);

    return {
        x: start.x + (end.x - start.x) * safeT,
        y: start.y + (end.y - start.y) * safeT,
        tangentX: tangent.x,
        tangentY: tangent.y
    };
}

function projectPointOntoPolyline(
    point: { x: number; y: number },
    polyline: Array<{ x: number; y: number }>
): {
    segmentIndex: number;
    t: number;
    x: number;
    y: number;
    tangentX: number;
    tangentY: number;
    distance: number;
} {
    if (polyline.length <= 1) {
        const fallback = polyline[0] || { x: point.x, y: point.y };
        return {
            segmentIndex: 0,
            t: 0,
            x: fallback.x,
            y: fallback.y,
            tangentX: 1,
            tangentY: 0,
            distance: Math.hypot(point.x - fallback.x, point.y - fallback.y)
        };
    }

    let bestProjection = {
        segmentIndex: 0,
        t: 0,
        x: polyline[0].x,
        y: polyline[0].y,
        tangentX: 1,
        tangentY: 0,
        distance: Number.POSITIVE_INFINITY
    };

    for (
        let segmentIndex = 0;
        segmentIndex < polyline.length - 1;
        segmentIndex++
    ) {
        const projection = projectPointOntoLine(
            point,
            polyline[segmentIndex],
            polyline[segmentIndex + 1]
        );
        const tangent = normalizeVector(
            polyline[segmentIndex + 1].x - polyline[segmentIndex].x,
            polyline[segmentIndex + 1].y - polyline[segmentIndex].y,
            1,
            0
        );
        if (projection.distance < bestProjection.distance) {
            bestProjection = {
                segmentIndex,
                t: projection.t,
                x: projection.x,
                y: projection.y,
                tangentX: tangent.x,
                tangentY: tangent.y,
                distance: projection.distance
            };
        }
    }

    return bestProjection;
}

function resampleOpenPolyline(
    polyline: Array<{ x: number; y: number }>,
    targetCount: number
): Array<{ x: number; y: number }> {
    if (polyline.length <= 1 || targetCount <= 1) {
        return polyline.slice();
    }

    const cumulativeLengths = buildPolylineCumulativeLengths(polyline);
    const totalLength = cumulativeLengths[cumulativeLengths.length - 1];
    if (totalLength <= 0.000001) {
        return polyline.slice(0, targetCount);
    }

    const result: Array<{ x: number; y: number }> = [];
    let segmentIndex = 0;

    for (let sampleIndex = 0; sampleIndex < targetCount; sampleIndex++) {
        const targetDistance =
            (totalLength * sampleIndex) / Math.max(1, targetCount - 1);

        while (
            segmentIndex < cumulativeLengths.length - 2 &&
            cumulativeLengths[segmentIndex + 1] < targetDistance
        ) {
            segmentIndex++;
        }

        const segmentStartDistance = cumulativeLengths[segmentIndex];
        const segmentEndDistance = cumulativeLengths[segmentIndex + 1];
        const segmentLength = segmentEndDistance - segmentStartDistance;
        const t =
            segmentLength <= 0.000001
                ? 0
                : (targetDistance - segmentStartDistance) / segmentLength;
        result.push(
            lerpPoint(polyline[segmentIndex], polyline[segmentIndex + 1], t)
        );
    }

    return result;
}

function intersectRayWithSegment(
    originX: number,
    originY: number,
    directionX: number,
    directionY: number,
    startX: number,
    startY: number,
    endX: number,
    endY: number
): { x: number; y: number; distance: number } | null {
    const segmentX = endX - startX;
    const segmentY = endY - startY;
    const determinant = crossProduct2D(
        directionX,
        directionY,
        segmentX,
        segmentY
    );
    if (Math.abs(determinant) <= 0.000001) {
        return null;
    }

    const deltaX = startX - originX;
    const deltaY = startY - originY;
    const rayDistance =
        crossProduct2D(deltaX, deltaY, segmentX, segmentY) / determinant;
    const segmentT =
        crossProduct2D(deltaX, deltaY, directionX, directionY) / determinant;
    if (
        rayDistance <= 0.000001 ||
        segmentT < -0.000001 ||
        segmentT > 1.000001
    ) {
        return null;
    }

    return {
        x: originX + directionX * rayDistance,
        y: originY + directionY * rayDistance,
        distance: rayDistance
    };
}

function buildStrokeAwareSelectionGeometry(
    currentLayerData: Babelfont.Layer,
    contourIndices: number[],
    anchorIndices: number[]
): StrokeAwareSelectionGeometry | null {
    if (contourIndices.length === 0) {
        return null;
    }

    const contours = contourIndices
        .map((contourIndex) => ({
            contourIndex,
            contour: getEditableContour(currentLayerData.shapes?.[contourIndex])
        }))
        .filter(
            (
                entry
            ): entry is { contourIndex: number; contour: EditableContour } =>
                Boolean(entry.contour)
        );
    if (
        contours.length === 0 ||
        contours.some(
            ({ contour }) => !contour.closed || contour.nodes.length < 3
        )
    ) {
        return null;
    }

    const boundaryPolylines = contours
        .map(({ contour }) => buildClosedContourSampledPolyline(contour))
        .filter((polyline) => polyline.length >= 3);
    if (boundaryPolylines.length === 0) {
        return null;
    }

    const raster = rasterizeContourMask(currentLayerData, contourIndices);
    if (!raster) {
        return null;
    }

    const skeletonMask = thinMaskToSkeleton(
        raster.mask,
        raster.width,
        raster.height
    );
    const rawSkeletonBranches = extractSkeletonBranches(
        skeletonMask,
        raster.width,
        raster.height
    );
    if (rawSkeletonBranches.length === 0) {
        return null;
    }

    const centerlineBranches = rawSkeletonBranches
        .map((branch) =>
            resampleOpenPolyline(
                smoothOpenPolyline(
                    branch.map((point) =>
                        mapRasterPointToGlyphSpace(point, raster)
                    ),
                    2
                ),
                Math.max(12, Math.min(48, branch.length))
            )
        )
        .filter((branch) => branch.length >= 2);
    const spokes = buildCenterlineSpokes(centerlineBranches, boundaryPolylines);

    if (centerlineBranches.length === 0) {
        return null;
    }

    const targets: StrokeAwareTargetSnapshot[] = [];

    contours.forEach(({ contourIndex, contour }) => {
        const descriptors = Layer.getPathSegmentDescriptors({
            nodes: contour.nodes,
            closed: contour.closed
        });
        const segmentBranches = chooseSegmentBranchesForContour(
            descriptors,
            centerlineBranches
        );
        const attachmentsByNode = new Map<
            number,
            StrokeAwareCenterlineAttachment[]
        >();

        descriptors.forEach((descriptor) => {
            const branchIndex = segmentBranches.get(descriptor.segmentId);
            if (branchIndex === undefined) {
                return;
            }

            const ownedNodeIndices = [
                descriptor.startNodeIndex,
                ...descriptor.controlNodeIndices,
                descriptor.endNodeIndex
            ];
            ownedNodeIndices.forEach((nodeIndex) => {
                const node = contour.nodes[nodeIndex];
                if (!node) {
                    return;
                }

                const existingAttachments =
                    attachmentsByNode.get(nodeIndex) || [];
                if (
                    existingAttachments.some(
                        (attachment) =>
                            attachment.centerBranchIndex === branchIndex
                    )
                ) {
                    return;
                }

                existingAttachments.push(
                    buildStrokeAwareAttachmentForBranch(
                        node.x,
                        node.y,
                        centerlineBranches,
                        branchIndex
                    )
                );
                attachmentsByNode.set(nodeIndex, existingAttachments);
            });
        });

        contour.nodes.forEach((node, nodeIndex) => {
            const attachments = isOnCurveNode(node)
                ? [
                      buildStrokeAwareAttachmentForBranch(
                          node.x,
                          node.y,
                          centerlineBranches,
                          chooseBranchForOnCurvePoint(
                              contour,
                              nodeIndex,
                              centerlineBranches
                          )
                      )
                  ]
                : attachmentsByNode.get(nodeIndex);
            if (!attachments || attachments.length === 0) {
                return;
            }

            targets.push({
                kind: 'point',
                contourIndex,
                nodeIndex,
                anchorIndex: null,
                attachments
            });
        });
    });

    anchorIndices.forEach((anchorIndex) => {
        const anchor = currentLayerData.anchors?.[anchorIndex];
        if (!anchor) {
            return;
        }

        const branchProjection = projectPointOntoBranchSet(
            { x: anchor.x, y: anchor.y },
            centerlineBranches
        );
        targets.push({
            kind: 'anchor',
            contourIndex: null,
            nodeIndex: null,
            anchorIndex,
            attachments: [
                buildStrokeAwareAttachmentForBranch(
                    anchor.x,
                    anchor.y,
                    centerlineBranches,
                    branchProjection.branchIndex
                )
            ]
        });
    });

    if (targets.length === 0) {
        return null;
    }

    return {
        geometry: {
            centerlineBranches,
            spokes
        },
        targets,
        debugGeometry: {
            centerlineBranches,
            spokes
        }
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

const TOGGLE_SMOOTH_AXIS_SNAP_MAX_ANGLE_RADIANS = (10 * Math.PI) / 180;

function getAngleBetweenVectors(
    leftX: number,
    leftY: number,
    rightX: number,
    rightY: number
): number | null {
    const leftLength = Math.hypot(leftX, leftY);
    const rightLength = Math.hypot(rightX, rightY);
    if (!leftLength || !rightLength) {
        return null;
    }

    const cosine = Math.max(
        -1,
        Math.min(
            1,
            (leftX * rightX + leftY * rightY) / (leftLength * rightLength)
        )
    );
    return Math.acos(cosine);
}

function getNearestAxisDirectionWithinThreshold(
    directionX: number,
    directionY: number,
    thresholdRadians: number
): { directionX: number; directionY: number } | null {
    const length = Math.hypot(directionX, directionY);
    if (!length) {
        return null;
    }

    const absoluteX = Math.abs(directionX);
    const absoluteY = Math.abs(directionY);
    const angleToHorizontal = Math.atan2(absoluteY, absoluteX || 0);
    const angleToVertical = Math.atan2(absoluteX, absoluteY || 0);

    if (
        angleToHorizontal <= thresholdRadians &&
        angleToHorizontal <= angleToVertical
    ) {
        return {
            directionX: directionX < 0 ? -1 : 1,
            directionY: 0
        };
    }

    if (angleToVertical <= thresholdRadians) {
        return {
            directionX: 0,
            directionY: directionY < 0 ? -1 : 1
        };
    }

    return null;
}

function snapToggleSmoothedTripletToAxisWhenEligible(
    anchor: Babelfont.Node,
    prevHandle: Babelfont.Node,
    nextHandle: Babelfont.Node,
    originalIncomingX: number,
    originalIncomingY: number,
    originalOutgoingX: number,
    originalOutgoingY: number
): boolean {
    const originalDirectionMismatch = getAngleBetweenVectors(
        originalIncomingX,
        originalIncomingY,
        originalOutgoingX,
        originalOutgoingY
    );
    if (
        originalDirectionMismatch === null ||
        originalDirectionMismatch <= TOGGLE_SMOOTH_AXIS_SNAP_MAX_ANGLE_RADIANS
    ) {
        return false;
    }

    const snappedAxisDirection = getNearestAxisDirectionWithinThreshold(
        nextHandle.x - anchor.x,
        nextHandle.y - anchor.y,
        TOGGLE_SMOOTH_AXIS_SNAP_MAX_ANGLE_RADIANS
    );
    if (!snappedAxisDirection) {
        return false;
    }

    alignHandleAlongDirection(
        anchor,
        prevHandle,
        -snappedAxisDirection.directionX,
        -snappedAxisDirection.directionY
    );
    alignHandleAlongDirection(
        anchor,
        nextHandle,
        snappedAxisDirection.directionX,
        snappedAxisDirection.directionY
    );
    return true;
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
        const originalIncomingX = anchor.x - prevHandle.x;
        const originalIncomingY = anchor.y - prevHandle.y;
        const originalOutgoingX = nextHandle.x - anchor.x;
        const originalOutgoingY = nextHandle.y - anchor.y;
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

        const changed = realignSmoothHandles(contour, anchorIndex);
        if (!changed) {
            return false;
        }

        snapToggleSmoothedTripletToAxisWhenEligible(
            anchor,
            prevHandle,
            nextHandle,
            originalIncomingX,
            originalIncomingY,
            originalOutgoingX,
            originalOutgoingY
        );
        return true;
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
    private _dragConnectionSourcePoint: Point | null = null;
    private _dragSeparatedFromCoincidentEndpointPair: boolean = false;
    private _snappedOpenPathEndpointTarget: OpenPathEndpointRef | null = null;

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
    private _adjacentSnapInterpolatedLayerCache: Map<
        string,
        Babelfont.Layer | null
    > = new Map();
    private _pendingAdjacentSnapInterpolatedLayerRequests: Set<string> =
        new Set();
    private _adjacentSnapInterpolationSessionId: number = 0;
    private _lastDragSaveTime: number = 0;
    private _lastLiveAnchorRefreshTime: number = 0;
    private _lastLiveSidebearingRefreshTime: number = 0;
    private _lastPropertyPanelUpdateTime: number = 0;
    private _pendingDragMetricsUpdate: boolean = false;
    private _dragMetricsFlushTimer: number | null = null;
    private _pointDragDeltaX: number = 0;
    private _componentDragDeltaX: number = 0;
    private _sidebearingAffectedGlyphNames: Set<string> = new Set();
    private _anchorAffectedGlyphNames: Set<string> = new Set();
    private _liveAnchorRefreshPromise: Promise<void> | null = null;
    private _liveAnchorRefreshQueued: boolean = false;
    private _cachedAnchorDragScopeSourceGlyphName: string | null = null;
    private _cachedAnchorDragScopeVisibleKey: string = '';
    private _cachedAnchorDragScopeGlyphNames: Set<string> | null = null;
    private _liveSidebearingRefreshPromise: Promise<void> | null = null;
    private _liveSidebearingRefreshQueued: boolean = false;
    private _pointDragPreserveHandlePositions: boolean = false;
    private _offCurveAltDragConstraint: {
        contourIndex: number;
        nodeIndex: number;
        anchorX: number;
        anchorY: number;
        directionX: number;
        directionY: number;
    } | null = null;
    private _smoothOnCurveAltDragConstraint: {
        contourIndex: number;
        nodeIndex: number;
        linePointX: number;
        linePointY: number;
        directionX: number;
        directionY: number;
    } | null = null;
    isDraggingComponent: boolean = false;
    isDraggingAnchor: boolean = false;
    isDraggingSidebearing: boolean = false;
    isDraggingGuide: boolean = false;
    isResizingSelection: boolean = false;
    isDraggingContrastAxis: boolean = false;
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
        | 'transform'
        | 'contrast-axis'
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
    hoveredResizeHandle: SelectionResizeHandle | null = null;
    hoveredContrastAxisHandle: ContrastAxisHandle | null = null;
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
    private suppressSelectedEndpointCommandSeedUntilCommandRelease: boolean = false;
    private pendingCommandPathEdit: PendingCommandPathEdit | null = null;
    private canvasContextMenuTippy: TippyInstance | null = null;
    private canvasContextMenuTarget: CanvasPathContextTarget | null = null;
    private selectionResizeSnapshot: SelectionResizeSnapshot | null = null;
    private strokeAwareScalingPreference: boolean = false;

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

    private isAutomaticComposedLayer(): boolean {
        return !!this.getCurrentLayerModel()?.isAutomaticAlignedLayer?.();
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

    private getVisibleGlyphNamesForDragMetricsRefresh(
        glyphName: string
    ): Set<string> {
        const visibleGlyphNames = new Set<string>([glyphName]);
        for (const visibleGlyphName of this.glyphCanvas.textRunEditor
            ?.glyphNameBuffer || []) {
            if (visibleGlyphName) {
                visibleGlyphNames.add(visibleGlyphName);
            }
        }

        return visibleGlyphNames;
    }

    private recomputeMetricsKeysForGlyph(
        glyphName: string | null | undefined,
        options?: { allowedGlyphNames?: Set<string> }
    ): Set<string> {
        const fontModel = fontManager.currentFont?.fontModel;
        if (!glyphName || glyphName === 'undefined' || !fontModel) {
            return new Set();
        }

        const affectedGlyphNames = new Set<string>([glyphName]);
        const recompute = () => {
            const recomputedGlyphNames = options
                ? fontModel.recomputeMetricsKeys(new Set([glyphName]), options)
                : fontModel.recomputeMetricsKeys(new Set([glyphName]));

            for (const recomputedGlyphName of recomputedGlyphNames) {
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
        refreshGlyphAdvances: boolean = true,
        options?: { useVisibleDragScope?: boolean }
    ): {
        glyphName: string;
        nextWidth: number;
        glyphAdvances: Record<string, number>;
        advancesRefreshed: boolean;
        affectedGlyphNames: Set<string>;
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

        const allowedGlyphNames = options?.useVisibleDragScope
            ? this.getVisibleGlyphNamesForDragMetricsRefresh(glyphName)
            : undefined;
        const affectedGlyphNames = new Set<string>([glyphName]);
        for (const affectedGlyphName of this.recomputeMetricsKeysForGlyph(
            glyphName,
            allowedGlyphNames ? { allowedGlyphNames } : undefined
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

        const advancesRefreshed = refreshGlyphAdvances
            ? editedSide
                ? applyLiveSidebearingVisualSync(this.glyphCanvas, {
                      glyphName,
                      glyphAdvances,
                      side: editedSide,
                      previousWidth,
                      nextWidth,
                      render: false
                  }).advancesRefreshed
                : Object.keys(glyphAdvances).length > 0 &&
                  !!this.glyphCanvas.textRunEditor?.refreshGlyphAdvancesLive(
                      glyphAdvances,
                      { render: false }
                  )
            : false;

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
            advancesRefreshed,
            affectedGlyphNames
        };
    }

    private schedulePendingDragMetricsUpdate(): void {
        this._pendingDragMetricsUpdate = true;
        if (this._dragMetricsFlushTimer !== null) {
            return;
        }

        const elapsed = performance.now() - this._lastDragSaveTime;
        const delay = Math.max(0, 50 - elapsed);
        this._dragMetricsFlushTimer = window.setTimeout(() => {
            this._dragMetricsFlushTimer = null;
            if (!this._pendingDragMetricsUpdate) {
                return;
            }
            if (
                !this.draggingSomething ||
                !(
                    this.isDraggingComponent ||
                    this.isDraggingPoint ||
                    this.isResizingSelection
                )
            ) {
                return;
            }

            this.flushPendingDragMetricsUpdate('mouse-drag-outline');
        }, delay);
    }

    private flushPendingDragMetricsUpdate(
        changeSource: string,
        forceMetricsRecompute: boolean = false
    ): void {
        this._pendingDragMetricsUpdate = false;
        this._lastDragSaveTime = performance.now();

        if (
            forceMetricsRecompute ||
            this.isDraggingComponent ||
            this.isResizingSelection ||
            (this.isDraggingPoint && !this.isSlidingSmoothPointAlongCurve)
        ) {
            this.applyMetricsKeysToCurrentEditedLayer(true, {
                useVisibleDragScope: !forceMetricsRecompute
            });

            if (this._metricsKeyEditedSide !== null) {
                const recalc = this.isDraggingGuide
                    ? this.transformMouseToRootSpace()
                    : this.transformMouseToComponentSpace();
                this.lastGlyphX = recalc.glyphX;
                this.lastGlyphY = recalc.glyphY;
            }
        }

        this.saveLayerData(changeSource);
    }

    private cancelPendingDragMetricsUpdate(): void {
        this._pendingDragMetricsUpdate = false;
        if (this._dragMetricsFlushTimer !== null) {
            window.clearTimeout(this._dragMetricsFlushTimer);
            this._dragMetricsFlushTimer = null;
        }
    }

    private syncDependentGlyphsAfterSidebearingEdit(
        glyphName: string | null | undefined,
        affectedGlyphNames: Set<string>,
        options?: { liveVisibleOnly?: boolean }
    ): void {
        const downstreamGlyphNames = Array.from(
            new Set(
                Array.from(affectedGlyphNames || []).filter(
                    (affectedGlyphName): affectedGlyphName is string =>
                        typeof affectedGlyphName === 'string' &&
                        affectedGlyphName.length > 0 &&
                        affectedGlyphName !== glyphName
                )
            )
        );
        if (downstreamGlyphNames.length === 0) {
            return;
        }

        const currentFont = fontManager.currentFont;
        if (!currentFont) {
            return;
        }

        const currentLayerId = this.getCurrentLayerId();

        if (options?.liveVisibleOnly) {
            // Fire-and-forget: batch source + downstream layer updates
            // into a single worker cache sync + compilation run.
            // The model is already updated synchronously; canvas renders
            // from the model, so visual feedback is immediate.
            const allGlyphNames = [
                ...(glyphName ? [glyphName] : []),
                ...downstreamGlyphNames
            ];
            fontManager
                .refreshGlyphsAfterModelBatch(allGlyphNames, currentLayerId, {
                    dispatchGlyphChanged: false,
                    skipFingerprintBaseline: true
                })
                .then(() => {
                    currentFont.requestRecompileWithoutDataChange();
                    window.autoCompileManager?.checkAndSchedule?.();
                });
            return;
        }

        // Non-drag path: incremental worker cache update + dispatch
        // glyphChanged events for downstream tiles in the overview.
        fontManager
            .refreshGlyphsAfterModelBatch(
                [...(glyphName ? [glyphName] : []), ...downstreamGlyphNames],
                currentLayerId
            )
            .then(() => {
                for (const affectedGlyphName of downstreamGlyphNames) {
                    window.dispatchEvent(
                        new CustomEvent('glyphChanged', {
                            detail: {
                                glyphName: affectedGlyphName,
                                layerId: currentLayerId
                            }
                        })
                    );
                }
                currentFont.requestRecompileWithoutDataChange();
                window.autoCompileManager?.checkAndSchedule?.();
            });
    }

    private rebuildAutomaticCompositesForCurrentEditedGlyph(options?: {
        limitToDragVisibleGlyphs?: boolean;
        allowedGlyphNames?: Set<string>;
    }): Set<string> {
        const currentLayerData = this.getCurrentLayerDataFromStack();
        const currentLayerId = this.getCurrentLayerId();
        const parsed = this.parseGlyphStack();
        const glyphName =
            parsed.length > 0
                ? parsed[parsed.length - 1].glyphName
                : this.glyphCanvas.getCurrentGlyphName();
        const fontModel = fontManager.currentFont?.fontModel;

        if (
            !currentLayerData ||
            currentLayerData.isInterpolated ||
            !currentLayerId ||
            !glyphName ||
            !fontModel
        ) {
            return new Set();
        }

        const glyph = fontModel.findGlyph(glyphName);
        const layerModel = glyph?.findLayerById(currentLayerId);
        if (!glyph || !layerModel) {
            return new Set();
        }

        // Bulk-sync the editor's working copy into the model layer,
        // avoiding the expensive toJSON() round-trip that would
        // trigger layout recomputation for automatic-aligned layers.
        layerModel.syncFromEditorLayerData({
            width: currentLayerData.width,
            height: currentLayerData.height,
            vertWidth: currentLayerData.vertWidth,
            shapes: currentLayerData.shapes,
            anchors: currentLayerData.anchors,
            guides: currentLayerData.guides,
            format_specific: currentLayerData.format_specific
        });

        const affectedGlyphNames = new Set<string>([glyphName]);
        const allowedGlyphNames = options?.allowedGlyphNames
            ? new Set(options.allowedGlyphNames)
            : options?.limitToDragVisibleGlyphs
              ? fontManager.getAutomaticCompositionDragScopeGlyphNames(
                    glyphName,
                    fontModel
                )
              : undefined;
        const rebuild = () => {
            for (const affectedGlyphName of fontModel.rebuildAutomaticCompositesForGlyphs(
                new Set([glyphName]),
                {
                    ...(allowedGlyphNames ? { allowedGlyphNames } : undefined),
                    ...(options?.allowedGlyphNames && currentLayerId
                        ? {
                              preferredLayerId: currentLayerId,
                              preferredSourceGlyphName: glyphName
                          }
                        : undefined)
                }
            )) {
                affectedGlyphNames.add(affectedGlyphName);
            }
        };

        const bridge = window.changeBridge;
        const wrappedRebuild = () =>
            withSuppressedModelRecording(() =>
                withSuppressedMetricsKeyRecompute(() => {
                    if (allowedGlyphNames) {
                        fontModel.invalidateLayoutCachesForGlyphs(
                            allowedGlyphNames
                        );
                    }
                    rebuild();
                })
            );
        if (bridge?.runWithoutRecording) {
            bridge.runWithoutRecording(wrappedRebuild);
        } else {
            wrappedRebuild();
        }

        const dependencyQueue = Array.from(affectedGlyphNames);
        while (dependencyQueue.length > 0) {
            const changedGlyphName = dependencyQueue.shift();
            if (!changedGlyphName) {
                continue;
            }

            for (const dependentGlyphName of fontModel.findGlyphsUsingComponent(
                changedGlyphName
            )) {
                if (
                    allowedGlyphNames &&
                    !allowedGlyphNames.has(dependentGlyphName)
                ) {
                    continue;
                }

                if (affectedGlyphNames.has(dependentGlyphName)) {
                    continue;
                }

                affectedGlyphNames.add(dependentGlyphName);
                dependencyQueue.push(dependentGlyphName);
            }
        }

        return affectedGlyphNames;
    }

    private async syncDependentGlyphsAfterAnchorEdit(
        glyphName: string | null | undefined,
        affectedGlyphNames: Set<string>,
        options?: { liveVisibleOnly?: boolean }
    ): Promise<void> {
        const currentLayerId = this.getCurrentLayerId();
        const downstreamGlyphNames = Array.from(
            new Set(
                Array.from(affectedGlyphNames || []).filter(
                    (affectedGlyphName): affectedGlyphName is string =>
                        typeof affectedGlyphName === 'string' &&
                        affectedGlyphName.length > 0 &&
                        affectedGlyphName !== glyphName
                )
            )
        );
        if (downstreamGlyphNames.length === 0) {
            return;
        }

        const currentFont = fontManager.currentFont;
        if (!currentFont) {
            return;
        }

        const refreshSourceGlyphPromise =
            glyphName && currentLayerId
                ? fontManager.refreshWorkerCacheForReplayTargets([
                      {
                          glyphName,
                          layerId: currentLayerId
                      }
                  ])
                : Promise.resolve(false);

        if (options?.liveVisibleOnly) {
            // Fire-and-forget: batch source + downstream layer updates
            // into a single worker cache sync + compilation run.
            // The model is already updated synchronously; canvas renders
            // from the model, so visual feedback is immediate.
            const allGlyphNames = [
                ...(glyphName ? [glyphName] : []),
                ...downstreamGlyphNames
            ];
            fontManager
                .refreshGlyphsAfterModelBatch(allGlyphNames, currentLayerId, {
                    dispatchGlyphChanged: false,
                    skipFingerprintBaseline: true
                })
                .then(() => {
                    currentFont.requestRecompileWithoutDataChange();
                    window.autoCompileManager?.checkAndSchedule?.();
                });
            return;
        }

        try {
            currentFont.syncJsonFromModel();
        } catch (error) {
            console.error(
                '[OutlineEditor] Error syncing font JSON after anchor edit:',
                error
            );
            return;
        }

        await refreshSourceGlyphPromise;
        await fontManager.refreshGlyphsAfterModelBatch(
            downstreamGlyphNames,
            currentLayerId
        );
        fontManager.forceFullEditingCacheRefresh = true;
        currentFont.requestRecompileWithoutDataChange();
        window.autoCompileManager?.checkAndSchedule?.();
    }

    private resetLiveAnchorRefreshState(): void {
        this._liveAnchorRefreshQueued = false;
        this._liveAnchorRefreshPromise = null;
        this._cachedAnchorDragScopeSourceGlyphName = null;
        this._cachedAnchorDragScopeVisibleKey = '';
        this._cachedAnchorDragScopeGlyphNames = null;
        this.resetLiveSidebearingRefreshState();
    }

    private getCachedAnchorDragScopeGlyphNames(
        sourceGlyphName: string,
        fontModel: NonNullable<typeof fontManager.currentFont>['fontModel']
    ): Set<string> {
        const visibleKey = fontManager
            .getLiveVisibleGlyphNames()
            .join('\u0000');
        if (
            this._cachedAnchorDragScopeGlyphNames &&
            this._cachedAnchorDragScopeSourceGlyphName === sourceGlyphName &&
            this._cachedAnchorDragScopeVisibleKey === visibleKey
        ) {
            return this._cachedAnchorDragScopeGlyphNames;
        }

        const scopedGlyphNames =
            fontManager.getAutomaticCompositionDragScopeGlyphNames(
                sourceGlyphName,
                fontModel
            );
        this._cachedAnchorDragScopeSourceGlyphName = sourceGlyphName;
        this._cachedAnchorDragScopeVisibleKey = visibleKey;
        this._cachedAnchorDragScopeGlyphNames = scopedGlyphNames;
        return scopedGlyphNames;
    }

    private queueLiveVisibleAnchorDependentRefresh(): void {
        if (this._liveAnchorRefreshPromise) {
            this._liveAnchorRefreshQueued = true;
            return;
        }

        const runRefresh = async () => {
            // Collapse all queued refreshes into a single pass over
            // the latest model state. Only the final position matters.
            this._liveAnchorRefreshQueued = false;

            const currentFont = fontManager.currentFont;
            const fontModel = currentFont?.fontModel;
            const sourceGlyphName = this.getCurrentGlyphModel()?.name;
            if (!fontModel || !sourceGlyphName) {
                return;
            }

            const allowedGlyphNames = this.getCachedAnchorDragScopeGlyphNames(
                sourceGlyphName,
                fontModel
            );
            this._anchorAffectedGlyphNames =
                this.rebuildAutomaticCompositesForCurrentEditedGlyph({
                    allowedGlyphNames
                });

            try {
                await this.syncDependentGlyphsAfterAnchorEdit(
                    sourceGlyphName,
                    this._anchorAffectedGlyphNames,
                    { liveVisibleOnly: true }
                );
            } catch (error) {
                console.error(
                    '[OutlineEditor] Error refreshing live anchor-dependent glyphs:',
                    error
                );
            }
        };

        this._liveAnchorRefreshPromise = runRefresh().finally(() => {
            this._liveAnchorRefreshPromise = null;
            if (this._liveAnchorRefreshQueued) {
                this.queueLiveVisibleAnchorDependentRefresh();
            }
        });
    }

    private collectMatchingLayerWorkerReplayTargets(
        glyphNames: Iterable<string>,
        layerId?: string | null
    ): Array<{ glyphName: string; layerId: string }> {
        if (!layerId) {
            return [];
        }

        const fontModel = fontManager.currentFont?.fontModel;
        if (!fontModel) {
            return [];
        }

        const sourceGlyphName = this.getCurrentGlyphModel()?.name;
        const sourceLayer = sourceGlyphName
            ? fontModel.findGlyph(sourceGlyphName)?.findLayerById(layerId)
            : null;

        return normalizeWorkerReplayTargets(
            Array.from(new Set(glyphNames)).map((glyphName) => {
                const glyph = fontModel.findGlyph(glyphName);
                const matchedLayer =
                    glyph?.findLayerById(layerId) ??
                    sourceLayer?.getMatchingLayerOnGlyph?.(glyphName);
                return matchedLayer?.id
                    ? { glyphName, layerId: matchedLayer.id }
                    : null;
            })
        );
    }

    private refreshLiveVisibleAnchorDependents(now: number): void {
        if (!this._hasMoved || now - this._lastLiveAnchorRefreshTime < 50) {
            return;
        }

        this._lastLiveAnchorRefreshTime = now;
        fontManager.lastChangeSource = this.draggingSomething
            ? 'mouse-drag-anchor'
            : 'keyboard-anchor';
        fontManager.lastEditType = 'anchor';
        this.queueLiveVisibleAnchorDependentRefresh();
    }

    private resetLiveSidebearingRefreshState(): void {
        this._liveSidebearingRefreshQueued = false;
        this._liveSidebearingRefreshPromise = null;
    }

    private queueLiveVisibleSidebearingDependentRefresh(): void {
        if (this._liveSidebearingRefreshPromise) {
            this._liveSidebearingRefreshQueued = true;
            return;
        }

        const runRefresh = async () => {
            this._liveSidebearingRefreshQueued = false;

            const currentFont = fontManager.currentFont;
            const fontModel = currentFont?.fontModel;
            const sourceGlyphName = this.getCurrentGlyphModel()?.name;
            if (!fontModel || !sourceGlyphName) {
                return;
            }

            // Sync the editor's working copy into the model layer so that
            // recomputeMetricsKeys sees the latest width/shapes.
            const currentLayerData = this.getCurrentLayerDataFromStack();
            const currentLayerId = this.getCurrentLayerId();
            const glyph = fontModel.findGlyph(sourceGlyphName);
            const layerModel = glyph?.findLayerById(currentLayerId ?? '');
            if (currentLayerData && layerModel) {
                layerModel.syncFromEditorLayerData({
                    width: currentLayerData.width,
                    height: currentLayerData.height,
                    vertWidth: currentLayerData.vertWidth,
                    shapes: currentLayerData.shapes,
                    anchors: currentLayerData.anchors,
                    guides: currentLayerData.guides,
                    format_specific: currentLayerData.format_specific
                });
            }

            // Recompute metrics keys scoped to visible glyphs in the text run.
            // Skip full automatic-composite recomposition since sidebearing
            // cascades only need width updates on downstream layers.
            const allowedGlyphNames =
                this.getVisibleGlyphNamesForDragMetricsRefresh(sourceGlyphName);
            const bridge = window.changeBridge;
            const recompute = () =>
                fontModel.recomputeMetricsKeys(new Set([sourceGlyphName]), {
                    allowedGlyphNames,
                    skipAutomaticCompositeRebuild: true
                });
            const affectedGlyphNames = new Set<string>([sourceGlyphName]);
            const recomputedNames =
                typeof bridge?.runWithoutRecording === 'function'
                    ? bridge.runWithoutRecording(recompute)
                    : recompute();
            for (const glyphName of recomputedNames) {
                affectedGlyphNames.add(glyphName);
            }

            try {
                await this.syncDependentGlyphsAfterSidebearingEdit(
                    sourceGlyphName,
                    affectedGlyphNames,
                    { liveVisibleOnly: true }
                );
            } catch (error) {
                console.error(
                    '[OutlineEditor] Error refreshing live sidebearing-dependent glyphs:',
                    error
                );
            }
        };

        this._liveSidebearingRefreshPromise = runRefresh().finally(() => {
            this._liveSidebearingRefreshPromise = null;
            if (this._liveSidebearingRefreshQueued) {
                this.queueLiveVisibleSidebearingDependentRefresh();
            }
        });
    }

    private refreshLiveVisibleSidebearingDependents(now: number): void {
        if (
            !this._hasMoved ||
            now - this._lastLiveSidebearingRefreshTime < 50
        ) {
            return;
        }

        this._lastLiveSidebearingRefreshTime = now;
        fontManager.lastChangeSource = this.draggingSomething
            ? 'mouse-drag-outline'
            : 'keyboard-outline';
        fontManager.lastEditType = 'outline';
        this.queueLiveVisibleSidebearingDependentRefresh();
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

    private syncStructuralGlyphChangeTransaction(
        changeLabel: string,
        currentGlyphName: string | null | undefined,
        affectedGlyphNames: Set<string>,
        options: {
            reuseTransaction?: boolean;
            layerId?: string | null;
        } = {}
    ): void {
        const bridge = window.changeBridge;
        if (!bridge || !currentGlyphName) {
            return;
        }

        const glyphNames = Array.from(
            new Set([
                currentGlyphName,
                ...Array.from(affectedGlyphNames || []).filter(Boolean)
            ])
        );

        if (!options.reuseTransaction) {
            bridge.beginTransaction(changeLabel);
        }

        try {
            if (
                glyphNames.length > 1 &&
                typeof bridge.syncGlyphsFromJson === 'function'
            ) {
                bridge.syncGlyphsFromJson(glyphNames, changeLabel);
            } else {
                const syncLayerId = Object.prototype.hasOwnProperty.call(
                    options,
                    'layerId'
                )
                    ? options.layerId
                    : this.getCurrentLayerId();
                bridge.syncGlyphFromJson(
                    currentGlyphName,
                    changeLabel,
                    undefined,
                    undefined,
                    syncLayerId
                );
            }
        } finally {
            bridge.endTransaction();
        }
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

    private getSelectionTransformBounds(): SelectionTransformBounds | null {
        const currentLayerData = this.getCurrentLayerDataFromStack();
        if (!currentLayerData || currentLayerData.isInterpolated) {
            return null;
        }

        let minX = Number.POSITIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;

        const includePoint = (x: number, y: number): void => {
            if (!Number.isFinite(x) || !Number.isFinite(y)) {
                return;
            }

            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
        };

        for (const { contourIndex, nodeIndex } of this.selectedPoints) {
            const contour = getEditableContour(
                currentLayerData.shapes?.[contourIndex]
            );
            const node = contour?.nodes?.[nodeIndex];
            if (node) {
                includePoint(node.x, node.y);
            }
        }

        for (const anchorIndex of this.selectedAnchors) {
            const anchor = currentLayerData.anchors?.[anchorIndex];
            if (anchor) {
                includePoint(anchor.x, anchor.y);
            }
        }

        for (const componentIndex of this.selectedComponents) {
            const shape = currentLayerData.shapes?.[componentIndex];
            if (!shape || !('reference' in shape) || !shape.layerData?.shapes) {
                continue;
            }

            const transformRaw = shape.transform;
            const transform = !transformRaw
                ? ([1, 0, 0, 1, 0, 0] as Transform)
                : Array.isArray(transformRaw)
                  ? (transformRaw as Transform)
                  : (DecomposedAffineTransform.toAffine(
                        transformRaw
                    ) as Transform);
            const bounds = Layer.calculateShapeBounds(
                shape.layerData.shapes,
                transform
            );
            if (!bounds) {
                continue;
            }

            includePoint(bounds.minX, bounds.minY);
            includePoint(bounds.maxX, bounds.maxY);
        }

        if (
            !Number.isFinite(minX) ||
            !Number.isFinite(minY) ||
            !Number.isFinite(maxX) ||
            !Number.isFinite(maxY)
        ) {
            return null;
        }

        return {
            minX,
            minY,
            maxX,
            maxY,
            width: maxX - minX,
            height: maxY - minY,
            centerX: (minX + maxX) / 2,
            centerY: (minY + maxY) / 2
        };
    }

    private expandSelectionTransformBounds(
        bounds: SelectionTransformBounds,
        padding: number
    ): SelectionTransformBounds {
        const expandX = bounds.width > 0.000001 ? padding : 0;
        const expandY = bounds.height > 0.000001 ? padding : 0;
        const minX = bounds.minX - expandX;
        const minY = bounds.minY - expandY;
        const maxX = bounds.maxX + expandX;
        const maxY = bounds.maxY + expandY;

        return {
            minX,
            minY,
            maxX,
            maxY,
            width: maxX - minX,
            height: maxY - minY,
            centerX: (minX + maxX) / 2,
            centerY: (minY + maxY) / 2
        };
    }

    getVisibleSelectionTransformBounds(): SelectionTransformBounds | null {
        if (
            !this.active ||
            !this.selectedLayerId ||
            !this.layerData ||
            this.isPreviewMode ||
            (this.selectedPoints.length === 0 &&
                this.selectedAnchors.length === 0 &&
                this.selectedComponents.length === 0)
        ) {
            return null;
        }

        const bounds = this.getSelectionTransformBounds();
        if (!bounds) {
            return null;
        }

        const selectedNodeCount =
            this.selectedPoints.length + this.selectedAnchors.length;
        if (this.selectedComponents.length === 0 && selectedNodeCount <= 1) {
            return null;
        }

        const viewportScale = this.glyphCanvas.viewportManager?.scale || 1;
        return this.expandSelectionTransformBounds(bounds, 20 / viewportScale);
    }

    getVisibleSelectionResizeHandles(): SelectionResizeHandle[] {
        const visibleBounds = this.getVisibleSelectionTransformBounds();
        const actualBounds = this.getSelectionTransformBounds();
        if (!visibleBounds || !actualBounds) {
            return [];
        }

        const hasWidth = actualBounds.width > 0.000001;
        const hasHeight = actualBounds.height > 0.000001;
        if (!hasWidth && !hasHeight) {
            return [];
        }

        const roles: Array<[ResizeHandleAxisRole, ResizeHandleAxisRole]> = [
            [-1, 1],
            [0, 1],
            [1, 1],
            [-1, 0],
            [1, 0],
            [-1, -1],
            [0, -1],
            [1, -1]
        ];

        const getCursor = (
            xRole: ResizeHandleAxisRole,
            yRole: ResizeHandleAxisRole
        ): string => {
            if (xRole === 0) {
                return 'ns-resize';
            }
            if (yRole === 0) {
                return 'ew-resize';
            }
            return xRole === yRole ? 'nesw-resize' : 'nwse-resize';
        };

        return roles
            .filter(([xRole, yRole]) => {
                if (!hasWidth && xRole !== 0) {
                    return false;
                }
                if (!hasHeight && yRole !== 0) {
                    return false;
                }
                return hasWidth || hasHeight;
            })
            .filter(([xRole, yRole]) => !(xRole === 0 && yRole === 0))
            .map(([xRole, yRole]) => ({
                key: `${xRole}:${yRole}`,
                x:
                    xRole === -1
                        ? visibleBounds.minX
                        : xRole === 1
                          ? visibleBounds.maxX
                          : visibleBounds.centerX,
                y:
                    yRole === -1
                        ? visibleBounds.minY
                        : yRole === 1
                          ? visibleBounds.maxY
                          : visibleBounds.centerY,
                actualX:
                    xRole === -1
                        ? actualBounds.minX
                        : xRole === 1
                          ? actualBounds.maxX
                          : actualBounds.centerX,
                actualY:
                    yRole === -1
                        ? actualBounds.minY
                        : yRole === 1
                          ? actualBounds.maxY
                          : actualBounds.centerY,
                xRole,
                yRole,
                cursor: getCursor(xRole, yRole)
            }));
    }

    private getStrokeAwareEligibleContourIndices(): number[] {
        if (
            !this.active ||
            !this.selectedLayerId ||
            !this.layerData ||
            this.isPreviewMode ||
            this.selectedPoints.length === 0 ||
            this.selectedComponents.length > 0 ||
            this.selectedGuideHandle !== null ||
            this.selectedSidebearingHandle !== null
        ) {
            return [];
        }

        const currentLayerData = this.getCurrentLayerDataFromStack();
        if (!currentLayerData?.shapes) {
            return [];
        }

        const pointsByContour = new Map<number, Set<number>>();
        for (const point of this.selectedPoints) {
            const indices =
                pointsByContour.get(point.contourIndex) || new Set<number>();
            indices.add(point.nodeIndex);
            pointsByContour.set(point.contourIndex, indices);
        }

        const eligibleContourIndices: number[] = [];
        let expectedPointCount = 0;

        for (const [contourIndex, nodeIndices] of pointsByContour) {
            const contour = getEditableContour(
                currentLayerData.shapes[contourIndex]
            );
            if (!contour || !contour.closed || contour.nodes.length === 0) {
                return [];
            }

            if (nodeIndices.size !== contour.nodes.length) {
                return [];
            }

            for (
                let nodeIndex = 0;
                nodeIndex < contour.nodes.length;
                nodeIndex++
            ) {
                if (!nodeIndices.has(nodeIndex)) {
                    return [];
                }
            }

            expectedPointCount += contour.nodes.length;
            eligibleContourIndices.push(contourIndex);
        }

        if (expectedPointCount !== this.selectedPoints.length) {
            return [];
        }

        return eligibleContourIndices.sort((left, right) => left - right);
    }

    canOfferStrokeAwareScaling(): boolean {
        return this.getStrokeAwareEligibleContourIndices().length > 0;
    }

    isStrokeAwareScalingEnabled(): boolean {
        return (
            this.strokeAwareScalingPreference &&
            this.canOfferStrokeAwareScaling()
        );
    }

    setStrokeAwareScalingEnabled(enabled: boolean): void {
        this.strokeAwareScalingPreference = enabled;
        this.hoveredContrastAxisHandle = null;
    }

    private getCurrentContrastAxisAngleDegrees(): number {
        const currentLayerData = this.getCurrentLayerDataFromStack();
        const rawAngle =
            currentLayerData?.format_specific?.[
                CONTRAST_AXIS_FORMAT_SPECIFIC_KEY
            ];
        const numericAngle = Number(rawAngle);
        if (!Number.isFinite(numericAngle)) {
            return DEFAULT_CONTRAST_AXIS_ANGLE_DEGREES;
        }

        return normalizeContrastAxisAngle(numericAngle);
    }

    private setCurrentContrastAxisAngleDegrees(angleDegrees: number): boolean {
        const currentLayerData = this.getCurrentLayerDataFromStack();
        if (!currentLayerData || currentLayerData.isInterpolated) {
            return false;
        }

        const normalizedAngle = normalizeContrastAxisAngle(angleDegrees);
        const previousAngle = this.getCurrentContrastAxisAngleDegrees();
        if (Math.abs(previousAngle - normalizedAngle) <= 0.000001) {
            return false;
        }

        const formatSpecific = {
            ...(currentLayerData.format_specific || {})
        } as Record<string, number>;
        formatSpecific[CONTRAST_AXIS_FORMAT_SPECIFIC_KEY] = normalizedAngle;
        currentLayerData.format_specific = formatSpecific;
        return true;
    }

    getVisibleContrastAxisLine(): {
        start: { x: number; y: number };
        end: { x: number; y: number };
        angleDegrees: number;
    } | null {
        if (!this.isStrokeAwareScalingEnabled()) {
            return null;
        }

        const bounds = this.getVisibleSelectionTransformBounds();
        if (!bounds) {
            return null;
        }

        const angleDegrees = this.getCurrentContrastAxisAngleDegrees();
        const angleRadians = (angleDegrees * Math.PI) / 180;
        const direction = {
            x: Math.cos(angleRadians),
            y: Math.sin(angleRadians)
        };
        const viewportScale = this.glyphCanvas.viewportManager?.scale || 1;
        const framePadding = 28 / viewportScale;
        const halfWidth = bounds.width / 2 + framePadding;
        const halfHeight = bounds.height / 2 + framePadding;
        const maxT = Math.min(
            Math.abs(direction.x) > 0.000001
                ? halfWidth / Math.abs(direction.x)
                : Number.POSITIVE_INFINITY,
            Math.abs(direction.y) > 0.000001
                ? halfHeight / Math.abs(direction.y)
                : Number.POSITIVE_INFINITY
        );

        if (!Number.isFinite(maxT)) {
            return null;
        }

        return {
            start: {
                x: bounds.centerX - direction.x * maxT,
                y: bounds.centerY - direction.y * maxT
            },
            end: {
                x: bounds.centerX + direction.x * maxT,
                y: bounds.centerY + direction.y * maxT
            },
            angleDegrees
        };
    }

    getVisibleContrastAxisHandles(): ContrastAxisHandle[] {
        const line = this.getVisibleContrastAxisLine();
        if (!line) {
            return [];
        }

        return [
            {
                key: 'start',
                x: line.start.x,
                y: line.start.y,
                cursor: 'grab'
            },
            {
                key: 'end',
                x: line.end.x,
                y: line.end.y,
                cursor: 'grab'
            }
        ];
    }

    getVisibleStrokeAwareCenterlines(): StrokeAwareCenterlineDebugGeometry[] {
        if (!this.isStrokeAwareScalingEnabled()) {
            return [];
        }

        const currentLayerData = this.getCurrentLayerDataFromStack();
        const eligibleContourIndices =
            this.getStrokeAwareEligibleContourIndices();
        if (!currentLayerData?.shapes || eligibleContourIndices.length === 0) {
            return [];
        }

        const geometry = buildStrokeAwareSelectionGeometry(
            currentLayerData,
            eligibleContourIndices,
            this.selectedAnchors
        );
        return geometry ? [geometry.debugGeometry] : [];
    }

    private buildStrokeAwareResizeSnapshots(): {
        geometry: StrokeAwareGeometrySnapshot | null;
        targets: StrokeAwareTargetSnapshot[];
    } {
        const currentLayerData = this.getCurrentLayerDataFromStack();
        const eligibleContourIndices =
            this.getStrokeAwareEligibleContourIndices();
        if (!currentLayerData?.shapes || eligibleContourIndices.length === 0) {
            return { geometry: null, targets: [] };
        }

        const geometry = buildStrokeAwareSelectionGeometry(
            currentLayerData,
            eligibleContourIndices,
            this.selectedAnchors
        );
        return geometry
            ? { geometry: geometry.geometry, targets: geometry.targets }
            : { geometry: null, targets: [] };
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
        this.hoveredResizeHandle = null;
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
        interpolatedShapes: Babelfont.Shape[],
        preferExactComponentTransforms: boolean = false
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
                transform: (preferExactComponentTransforms
                    ? exactShape.transform || interpolatedShape?.transform
                    : interpolatedShape?.transform || exactShape.transform) || [
                    1, 0, 0, 1, 0, 0
                ],
                ...(mergedLayerData ? { layerData: mergedLayerData } : {}),
                isInterpolated: false
            };
        });
    }

    private shouldPreferExactSelectedLayerComponentTransforms(
        layer: Layer | null | undefined
    ): boolean {
        if (!layer?.isAutomaticAlignedLayer?.()) {
            return false;
        }

        const leftResolution = layer.resolveMetricsKey?.('left');
        if (
            !leftResolution ||
            leftResolution.error ||
            !leftResolution.input ||
            !/^==?[+-]/.test(leftResolution.input)
        ) {
            return false;
        }

        const delta = Number.parseFloat(
            leftResolution.input.replace(/^==?/, '')
        );

        return Number.isFinite(delta) && Math.abs(delta) > 0.01;
    }

    private applyExactSelectedLayerData(
        exactLayerData: any,
        interpolatedResult?: any | null
    ): void {
        const preferExactComponentTransforms =
            exactLayerData?.__preferExactComponentTransforms === true;
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
                interpolatedNormalized.shapes,
                preferExactComponentTransforms
            );
        }

        this.assignLayerData(
            exactNormalized,
            interpolatedResult ?? exactNormalized
        );
    }

    private cloneLayerData<T>(value: T): T {
        if (typeof structuredClone === 'function') {
            try {
                return structuredClone(value);
            } catch (error) {
                const isDataCloneError =
                    error instanceof DOMException
                        ? error.name === 'DataCloneError'
                        : error instanceof Error &&
                          error.name === 'DataCloneError';
                if (!isDataCloneError) {
                    throw error;
                }
            }
        }

        return this.cloneSerializableLayerValue(value) as T;
    }

    private cloneSerializableLayerValue(value: any): any {
        if (value === null || value === undefined) {
            return value;
        }

        const valueType = typeof value;
        if (
            valueType === 'string' ||
            valueType === 'number' ||
            valueType === 'boolean'
        ) {
            return value;
        }

        if (valueType === 'bigint') {
            return Number(value);
        }

        if (valueType === 'function' || valueType === 'symbol') {
            return undefined;
        }

        if (Array.isArray(value)) {
            return value.map((item) => this.cloneSerializableLayerValue(item));
        }

        if (value instanceof Date) {
            return new Date(value.getTime());
        }

        if (value instanceof ArrayBuffer) {
            return value.slice(0);
        }

        if (ArrayBuffer.isView(value)) {
            return new Uint8Array(
                value.buffer.slice(
                    value.byteOffset,
                    value.byteOffset + value.byteLength
                )
            );
        }

        const prototype = Object.getPrototypeOf(value);
        if (prototype === Object.prototype || prototype === null) {
            const clonedEntries = Object.entries(value).flatMap(
                ([key, entryValue]) => {
                    const clonedValue =
                        this.cloneSerializableLayerValue(entryValue);
                    return clonedValue === undefined
                        ? []
                        : [[key, clonedValue] as const];
                }
            );
            return Object.fromEntries(clonedEntries);
        }

        return undefined;
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

            if (componentLayer?.isAutomaticAlignedLayer?.()) {
                withSuppressedModelRecording(() => {
                    componentLayer.rebuildAutomaticComposition?.();
                });
            }

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
        if (this.shouldPreferExactSelectedLayerComponentTransforms(layer)) {
            serializedLayerData.__preferExactComponentTransforms = true;
        }

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

    cancelPendingLayerSwitchAnimation(): void {
        this.targetLayerData = null;
        this.isLayerSwitchAnimating = false;
    }

    private async refreshSelectedLayerWithoutAnimation(
        layer: Babelfont.Layer,
        rootGlyphName?: string
    ): Promise<void> {
        const resolvedLayer = this.resolveLayerModel(layer);
        const layerId = resolvedLayer.id;
        if (!layerId) {
            return;
        }

        const glyphName =
            rootGlyphName ??
            this.parseGlyphStack()[0]?.glyphName ??
            this.glyphCanvas.getCurrentGlyphName();
        const selectionTargetLayer =
            this.isEditingComponent() && layerId
                ? this.getSelectionScopeLayerModel(layerId) || resolvedLayer
                : resolvedLayer;
        const selectionState = selectionTargetLayer
            ? this.getStoredSelectionStateForLayer(selectionTargetLayer)
            : null;

        this.cancelPendingLayerSwitchAnimation();
        this.selectedLayerId = layerId;

        if (this.glyphStack && this.glyphStack !== '') {
            this.rebuildGlyphStackWithNewLayer(layerId);
        } else {
            this.buildGlyphStack(glyphName, layerId, []);
        }

        await this.fetchLayerData(true, glyphName);

        if (selectionState && selectionTargetLayer) {
            this.applySelectionStateForLayer(
                selectionState,
                selectionTargetLayer
            );
        }

        this.performHitDetection(null);
        this.updateLayerSelection();
        this.glyphCanvas.updatePropertyPanel();
        this.glyphCanvas.render();
    }

    getLayerListGlyphName(): string | null {
        return (
            this.getLayerLinkGlyphName() ||
            this.getActiveSelectionScopeGlyphName() ||
            this.glyphCanvas.getCurrentGlyphName()
        );
    }

    getCurrentUserspaceLocation(): UserspaceLocation {
        return {
            ...(this.glyphCanvas.axesManager?.variationSettings || {})
        };
    }

    private getUserspaceLocationForMaster(
        masterId: string,
        fontModel: any
    ): UserspaceLocation | null {
        const master = (fontModel?.masters || []).find(
            (candidate: any) => candidate?.id === masterId
        );
        if (!master?.location) {
            return null;
        }
        return designspaceToUserspace(master.location, fontModel.axes || []);
    }

    findClosestMasterId(userspaceLocation: UserspaceLocation): string | null {
        const fontModel = fontManager.currentFont?.fontModel;
        if (!fontModel?.masters?.length) {
            return null;
        }
        const axisTags = (fontModel.axes || []).map((axis: any) => axis.tag);
        const designLocation = userspaceToDesignspace(
            userspaceLocation,
            fontModel.axes || []
        );
        let closestMaster: any = null;
        let closestDistance = Infinity;
        for (const master of fontModel.masters || []) {
            let distance = 0;
            for (const tag of axisTags) {
                const masterVal = Number(master.location?.[tag] ?? 0);
                const currentVal = Number(designLocation?.[tag] ?? 0);
                const axis = (fontModel.axes || []).find(
                    (a: any) => a.tag === tag
                );
                const range =
                    Number(axis?.max ?? 1000) - Number(axis?.min ?? 0) || 1;
                distance += Math.pow((masterVal - currentVal) / range, 2);
            }
            if (distance < closestDistance) {
                closestDistance = distance;
                closestMaster = master;
            }
        }
        return closestMaster?.id || null;
    }

    private sanitizeShapeForStoredLayer(shape: any): any {
        if (!shape || typeof shape !== 'object') {
            return shape;
        }

        if ('nodes' in shape) {
            const nodes = Array.isArray(shape.nodes)
                ? LayerDataNormalizer.serializeNodes(shape.nodes)
                : this.cloneLayerData(shape.nodes);
            return {
                nodes,
                closed: !!shape.closed,
                ...(shape.format_specific
                    ? {
                          format_specific: this.cloneLayerData(
                              shape.format_specific
                          )
                      }
                    : {})
            };
        }

        if ('reference' in shape) {
            return {
                reference: shape.reference,
                ...(shape.transform
                    ? { transform: this.cloneLayerData(shape.transform) }
                    : {}),
                ...(shape.location
                    ? { location: this.cloneLayerData(shape.location) }
                    : {}),
                ...(shape.format_specific
                    ? {
                          format_specific: this.cloneLayerData(
                              shape.format_specific
                          )
                      }
                    : {})
            };
        }

        return this.cloneLayerData(shape);
    }

    private sanitizeLayerDataForStoredLayer(layerData: any): {
        width: number;
        height?: number;
        vertWidth?: number;
        shapes?: any[];
        anchors?: any[];
        guides?: any[];
        format_specific?: Record<string, any>;
    } {
        return {
            width: Number(layerData?.width || 0),
            ...(layerData?.height !== undefined
                ? { height: Number(layerData.height) }
                : {}),
            ...(layerData?.vertWidth !== undefined
                ? { vertWidth: Number(layerData.vertWidth) }
                : {}),
            ...(Array.isArray(layerData?.shapes)
                ? {
                      shapes: layerData.shapes.map((shape: any) =>
                          this.sanitizeShapeForStoredLayer(shape)
                      )
                  }
                : {}),
            ...(Array.isArray(layerData?.anchors)
                ? {
                      anchors: this.cloneLayerData(layerData.anchors)
                  }
                : {}),
            ...(Array.isArray(layerData?.guides)
                ? {
                      guides: this.cloneLayerData(layerData.guides)
                  }
                : {}),
            ...(layerData?.format_specific
                ? {
                      format_specific: this.cloneLayerData(
                          layerData.format_specific
                      )
                  }
                : {})
        };
    }

    private materializeStoredInterpolatedLayer(
        glyph: any,
        options: {
            masterId: string;
            designLocation?: DesignspaceLocation | null;
            isMasterBound: boolean;
            layerId?: string | null;
        },
        layerPayload: any
    ): any {
        const layerType: Babelfont.LayerType = options.isMasterBound
            ? { type: 'DefaultForMaster', master: options.masterId }
            : { type: 'AssociatedWithMaster', master: options.masterId };
        const targetLayerId =
            options.layerId ||
            (options.isMasterBound ? options.masterId : null);

        const newLayer = glyph.addLayer(
            layerPayload.width,
            layerType,
            targetLayerId
        );

        if (targetLayerId) {
            newLayer.id = targetLayerId;
        }

        if (
            !options.isMasterBound &&
            options.designLocation &&
            Object.keys(options.designLocation).length > 0
        ) {
            newLayer.location = this.cloneLayerData(options.designLocation);
        }

        withSuppressedModelRecording(() => {
            newLayer.syncFromEditorLayerData(layerPayload);
        });

        return newLayer;
    }

    private async refreshAfterStructuralLayerEdit(
        glyphName: string,
        changeSource: string,
        options: {
            scheduleCompile?: boolean;
            dispatchGlyphChanged?: boolean;
        } = {}
    ): Promise<void> {
        const currentFont = fontManager.currentFont;
        if (!currentFont) {
            return;
        }

        currentFont.markDirty(changeSource);
        await fontManager.updateDirtyIndicator();

        if (typeof currentFont.syncJsonFromModel === 'function') {
            currentFont.syncJsonFromModel();
        }

        await fontManager.forceFullWorkerCacheUpdate();

        if (options.scheduleCompile !== false) {
            fontManager.lastEditType = 'outline';
            fontManager.scheduleFullCompileDebounce();
            window.autoCompileManager?.checkAndSchedule?.();
        }

        if (options.dispatchGlyphChanged !== false) {
            window.dispatchEvent(
                new CustomEvent('glyphChanged', {
                    detail: {
                        glyphName
                    }
                })
            );
        }
    }

    private async selectInterpolatedUserspaceLocation(
        userspaceLocation: UserspaceLocation,
        glyphName: string
    ): Promise<void> {
        const previousLayer = this.getCurrentLayerModel();
        if (this.selectedLayerId !== null && previousLayer) {
            this.storeSelectionStateForLayer(previousLayer);
        }

        this.selectedLayerId = null;
        this.currentGlyphName = glyphName;
        this.layerData = null;
        this.renderVerticalMetrics = null;
        this.clearAllSelections();
        this.updateLayerSelection();
        this.glyphCanvas.updatePropertyPanel();

        await this.glyphCanvas.animateToLocation(userspaceLocation, 10);
    }

    async createInterpolatedLayer(options: {
        glyphName?: string | null;
        userspaceLocation: UserspaceLocation;
        masterId: string;
        designLocation?: DesignspaceLocation | null;
        isMasterBound: boolean;
        changeSource?: string;
        selectNewLayer?: boolean;
        extrapolate?: boolean;
    }): Promise<any | null> {
        const glyphName = options.glyphName || this.getLayerListGlyphName();
        const currentFont = fontManager.currentFont;
        const glyph = glyphName ? this.getGlyphModelByName(glyphName) : null;
        if (!glyphName || !currentFont || !glyph) {
            return null;
        }

        const interpolatedLayer = await fontInterpolation.interpolateGlyph(
            glyphName,
            options.userspaceLocation,
            options.extrapolate === true
        );
        const normalizedLayer = LayerDataNormalizer.normalize(
            interpolatedLayer,
            true
        );
        const layerPayload =
            this.sanitizeLayerDataForStoredLayer(normalizedLayer);
        const newLayer = this.materializeStoredInterpolatedLayer(
            glyph,
            {
                masterId: options.masterId,
                designLocation: options.designLocation,
                isMasterBound: options.isMasterBound
            },
            layerPayload
        );

        // Sync the complete layer data to the Y.Doc so undo can restore
        // all fields. The model setters ran inside withSuppressedModelRecording.
        const createBridge = window.changeBridge;
        if (createBridge) {
            createBridge.syncGlyphFromJson(
                glyphName,
                'Create interpolated layer sync',
                undefined,
                undefined,
                newLayer.id
            );
        }

        await this.refreshAfterStructuralLayerEdit(
            glyphName,
            options.changeSource || 'layer-create'
        );

        if (options.selectNewLayer !== false) {
            await this.selectLayer(newLayer);
        }

        return newLayer;
    }

    async deleteLayerById(
        layerId: string,
        options?: {
            glyphName?: string | null;
            changeSource?: string;
            preferInterpolationFallback?: boolean;
        }
    ): Promise<boolean> {
        const glyphName = options?.glyphName || this.getLayerListGlyphName();
        const glyph = glyphName ? this.getGlyphModelByName(glyphName) : null;
        if (!glyphName || !glyph?.layers?.length) {
            return false;
        }

        const layer = glyph.findLayerById?.(layerId);
        if (!layer) {
            return false;
        }

        const userspaceLocation = this.getUserspaceLocationForLayer(
            layerId,
            glyphName
        );
        const masterId = layer?.master?.master || null;
        const wasSelected = this.selectedLayerId === layerId;
        const isMasterBound = layer?.master?.type === 'DefaultForMaster';

        glyph.removeLayerById?.(layerId);

        await this.refreshAfterStructuralLayerEdit(
            glyphName,
            options?.changeSource || 'layer-delete'
        );

        if (wasSelected && userspaceLocation) {
            await this.selectInterpolatedUserspaceLocation(
                userspaceLocation,
                glyphName
            );
        } else if (wasSelected) {
            this.selectedLayerId = null;
            this.layerData = null;
            this.renderVerticalMetrics = null;
            this.clearAllSelections();
            this.updateLayerSelection();
            this.glyphCanvas.updatePropertyPanel();
            this.glyphCanvas.render();
        }

        return true;
    }

    async reinterpolateLayerById(
        layerId: string,
        options?: {
            glyphName?: string | null;
            changeSource?: string;
            selectNewLayer?: boolean;
        }
    ): Promise<any | null> {
        const glyphName = options?.glyphName || this.getLayerListGlyphName();
        const glyph = glyphName ? this.getGlyphModelByName(glyphName) : null;
        if (!glyphName || !glyph) {
            return null;
        }

        const layer = glyph.findLayerById?.(layerId);
        if (!layer) {
            return null;
        }

        const masterId = layer.master?.master;
        const userspaceLocation = this.getUserspaceLocationForLayer(
            layerId,
            glyphName
        );
        const designLocation = layer.location
            ? this.cloneLayerData(layer.location)
            : null;
        const isMasterBound = layer.master?.type === 'DefaultForMaster';
        const shouldSelectNewLayer =
            options?.selectNewLayer ?? this.selectedLayerId === layerId;

        if (!masterId || !userspaceLocation) {
            return null;
        }

        const changeSource = options?.changeSource || 'layer-reinterpolate';
        const originalLayerPayload = this.sanitizeLayerDataForStoredLayer(
            layer.toJSON()
        );
        const bridge = window.changeBridge;

        bridge?.beginTransaction('Reinterpolate layer');

        try {
            glyph.removeLayerById?.(layerId);

            await this.refreshAfterStructuralLayerEdit(
                glyphName,
                changeSource,
                {
                    scheduleCompile: false,
                    dispatchGlyphChanged: false
                }
            );

            const interpolatedLayer = await fontInterpolation.interpolateGlyph(
                glyphName,
                userspaceLocation,
                true
            );
            const normalizedLayer = LayerDataNormalizer.normalize(
                interpolatedLayer,
                true
            );
            const layerPayload =
                this.sanitizeLayerDataForStoredLayer(normalizedLayer);
            const newLayer = this.materializeStoredInterpolatedLayer(
                glyph,
                {
                    masterId,
                    designLocation,
                    isMasterBound,
                    layerId
                },
                layerPayload
            );

            // Sync the complete layer data to the Y.Doc so undo can restore
            // all fields (id, master, location, shapes, etc.). The model
            // setters above ran inside withSuppressedModelRecording, so
            // the Y.Doc only has the minimal addLayer data. Without this
            // sync, undo would produce a layer missing most fields.
            if (bridge) {
                bridge.syncGlyphFromJson(
                    glyphName,
                    'Reinterpolate layer sync',
                    undefined,
                    undefined,
                    newLayer.id
                );
            }

            await this.refreshAfterStructuralLayerEdit(glyphName, changeSource);

            if (shouldSelectNewLayer) {
                if (this.selectedLayerId === newLayer.id) {
                    await this.refreshSelectedLayerWithoutAnimation(
                        newLayer,
                        glyphName
                    );
                } else {
                    await this.selectLayer(newLayer);
                }
            } else if (this.selectedLayerId === layerId) {
                this.selectedLayerId = null;
                this.layerData = null;
                this.renderVerticalMetrics = null;
                this.clearAllSelections();
                this.updateLayerSelection();
                this.glyphCanvas.updatePropertyPanel();
                this.glyphCanvas.render();
            }

            return newLayer;
        } catch (error) {
            if (!glyph.findLayerById?.(layerId)) {
                const restoredLayer = this.materializeStoredInterpolatedLayer(
                    glyph,
                    {
                        masterId,
                        designLocation,
                        isMasterBound,
                        layerId
                    },
                    originalLayerPayload
                );

                await this.refreshAfterStructuralLayerEdit(
                    glyphName,
                    changeSource
                );

                if (shouldSelectNewLayer) {
                    if (this.selectedLayerId === restoredLayer.id) {
                        await this.refreshSelectedLayerWithoutAnimation(
                            restoredLayer,
                            glyphName
                        );
                    } else {
                        await this.selectLayer(restoredLayer);
                    }
                }
            }

            throw error;
        } finally {
            bridge?.endTransaction();
        }
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
        return left?.side === right?.side && left?.editable === right?.editable;
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
        const automaticLayer = currentLayerModel.isAutomaticAlignedLayer();

        const leftResolution = currentLayerModel.resolveMetricsKey('left');
        if (!leftResolution.error && leftResolution.value !== null) {
            handles.push({
                side: 'left',
                x: 0,
                y: handleY,
                editable: !automaticLayer && !leftResolution.input
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
                editable: !automaticLayer && !rightResolution.input
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
        this._lastLiveAnchorRefreshTime = 0;
        this._lastLiveSidebearingRefreshTime = 0;
        this._lastPropertyPanelUpdateTime = 0;
        this.cancelPendingDragMetricsUpdate();
        this._pointDragDeltaX = 0;
        this._componentDragDeltaX = 0;
        this._pointDragPreserveHandlePositions = false;
        this.activePathDrawingSession = null;
        this.suppressSelectedEndpointCommandSeedUntilCommandRelease = false;
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
        this.hoveredResizeHandle = null;
        this.hoveredContrastAxisHandle = null;
        this.hoveredAddPointPreview = null;
        this.hoveredCommandCurvePreview = null;
        this.hoveredGlyphIndex = -1;
        this.selectionResizeSnapshot = null;
        this.isResizingSelection = false;
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

        if (this.handleAltCurveConversionGesture(e)) {
            return;
        }

        if (this.handleCommandPathGesture(e)) {
            return;
        }

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

        if (this.hoveredResizeHandle) {
            this.beginSelectionResize(e);
            return;
        }

        if (this.hoveredContrastAxisHandle) {
            this.beginContrastAxisDrag(e);
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
            if (!this.hoveredSidebearingHandle.editable) {
                this.glyphCanvas.updatePropertyPanel();
                this.glyphCanvas.render();
                return;
            }

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
                const nextSelection = isInSelection
                    ? [...this.selectedComponents]
                    : [this.hoveredComponentIndex];

                if (!isInSelection) {
                    this.selectedComponents = [this.hoveredComponentIndex];
                    this.selectedPoints = [];
                    this.selectedAnchors = [];
                }
                // If already in selection, keep all selected components, points, and anchors

                if (this.isAutomaticComposedLayer()) {
                    this.glyphCanvas.updatePropertyPanel();
                    this.glyphCanvas.render();
                    return;
                }

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
                this.resetLiveAnchorRefreshState();
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
            const hoveredPoint = this.hoveredPointIndex;
            const isCmdCutClick =
                (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;
            if (isCmdCutClick && this.cutPathAtNode(hoveredPoint)) {
                return;
            }

            if (
                (e.metaKey || e.ctrlKey) &&
                !e.altKey &&
                !e.shiftKey &&
                this.canSlideSmoothPointOnCurve(hoveredPoint)
            ) {
                this.selectedPoints = [{ ...hoveredPoint }];
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

            const existingIndex = this.selectedPoints.findIndex(
                (p) =>
                    p.contourIndex === hoveredPoint.contourIndex &&
                    p.nodeIndex === hoveredPoint.nodeIndex
            );
            const isInSelection = existingIndex >= 0;
            const currentLayerData = this.getCurrentLayerDataFromStack();
            const contour = getEditableContour(
                currentLayerData?.shapes?.[hoveredPoint.contourIndex]
            );
            const hoveredNode = contour?.nodes[hoveredPoint.nodeIndex];
            const canStartShiftOffCurveDrag =
                e.shiftKey &&
                isOffCurveNode(hoveredNode) &&
                ((this.selectedPoints.length === 0 &&
                    this.selectedAnchors.length === 0) ||
                    (isInSelection &&
                        this.selectedPoints.length === 1 &&
                        this.selectedAnchors.length === 0));

            if (e.shiftKey && !canStartShiftOffCurveDrag) {
                // Shift-click: add to or remove from selection (keep anchors selected for mixed selection)
                if (existingIndex >= 0) {
                    // Remove from selection
                    this.selectedPoints.splice(existingIndex, 1);
                } else {
                    // Add to selection
                    this.selectedPoints.push({ ...hoveredPoint });
                }
                this.glyphCanvas.updatePropertyPanel();
                this.glyphCanvas.render();
            } else {
                // Check if clicked point is already in selection
                if (!isInSelection || canStartShiftOffCurveDrag) {
                    // Regular click on unselected point: select only this point, clear anchors
                    this.selectedPoints = [{ ...hoveredPoint }];
                    this.selectedAnchors = []; // Clear anchor selection
                }
                // If already in selection, keep all selected points and anchors

                // Start dragging (all selected points and anchors)
                this.isDraggingPoint = true;
                console.log('[DRAG-DEBUG] Drag START: point drag begun');
                this._hasMoved = false;
                this._metricsKeyInteractionSide = null;
                this._dragType = 'point';
                this._dragConnectionSourcePoint = this.getOpenPathEndpointRef(
                    hoveredPoint.contourIndex,
                    hoveredPoint.nodeIndex
                )
                    ? { ...hoveredPoint }
                    : null;
                this._dragStartEndpointsCoincident =
                    this._areOpenPathEndpointsCoincident(
                        this._dragConnectionSourcePoint
                    );
                this._dragSeparatedFromCoincidentEndpointPair =
                    !this._dragStartEndpointsCoincident;
                this._preDragDesc = this._buildNodeDesc();
                this._pointDragDeltaX = 0;
                window.changeBridge?.beginTransaction('Drag point');
                this.glyphCanvas.lastMouseX = e.clientX;
                this.glyphCanvas.lastMouseY = e.clientY;
                this.lastGlyphX = null; // Reset for delta calculation
                this.lastGlyphY = null;
                this.lastPointDragShiftKey = e.shiftKey;
                this.altKeyPressed = e.altKey;
                this._pointDragPreserveHandlePositions = false;
                this._captureSmoothOnCurveAltDragConstraint();
                this._captureOffCurveAltDragConstraint();
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

    private _beginAdjacentSnapInterpolationSession(): void {
        this._adjacentSnapInterpolationSessionId += 1;
        this._adjacentSnapInterpolatedLayerCache.clear();
        this._pendingAdjacentSnapInterpolatedLayerRequests.clear();
    }

    private _serializeAdjacentSnapUserspaceLocation(
        location: UserspaceLocation
    ): string {
        const keys = Object.keys(location).sort();
        const normalized: Record<string, number> = {};

        for (const key of keys) {
            normalized[key] = Number(location[key]);
        }

        return JSON.stringify(normalized);
    }

    private _makeAdjacentSnapInterpolationCacheKey(
        glyphName: string,
        location: UserspaceLocation
    ): string {
        return `${glyphName}|${this._serializeAdjacentSnapUserspaceLocation(location)}`;
    }

    private _getCurrentAdjacentSnapUserspaceLocation(): UserspaceLocation | null {
        const rootGlyphName =
            this.parseGlyphStack()[0]?.glyphName ||
            this.glyphCanvas.getCurrentGlyphName();

        if (this.selectedLayerId && rootGlyphName) {
            const layerLocation = this.getUserspaceLocationForLayer(
                this.selectedLayerId,
                rootGlyphName
            );
            if (layerLocation) {
                return layerLocation;
            }
        }

        const textRunLocation =
            this.glyphCanvas.textRunEditor?.getCurrentVariationLocationSnapshot?.();
        return textRunLocation && Object.keys(textRunLocation).length >= 0
            ? textRunLocation
            : null;
    }

    private _findMatchingLayerForGlyphAtUserspaceLocation(
        glyphName: string,
        userspaceLocation: UserspaceLocation
    ): any | null {
        const fontModel = fontManager.currentFont?.fontModel;
        if (!fontModel?.glyphs?.length) {
            return null;
        }

        const glyph = fontModel.glyphs.find((candidate: any) => {
            return candidate.name === glyphName;
        });
        if (!glyph?.layers?.length) {
            return null;
        }

        const masters: Babelfont.Master[] = (fontModel.masters || []) as any;
        if (!masters.length) {
            return null;
        }

        const currentDesignspaceLocation = userspaceToDesignspace(
            userspaceLocation,
            fontModel.axes || []
        );
        const axisTags = (fontModel.axes || []).map((axis) => axis.tag);

        const matchingLayers = glyph.layers.filter((layer: any) => {
            const masterId = layer.master?.master;
            const hasLayerLocation =
                !!layer.location && Object.keys(layer.location).length > 0;
            const master = masters.find(
                (candidate) => candidate.id === masterId
            );
            const effectiveDesignLocation = hasLayerLocation
                ? layer.location
                : master?.location;

            return locationsMatchWithinTolerance(
                effectiveDesignLocation,
                currentDesignspaceLocation,
                axisTags
            );
        });

        if (!matchingLayers.length) {
            return null;
        }

        matchingLayers.sort((left: any, right: any) => {
            const leftHasLayerLocation =
                !!left.location && Object.keys(left.location).length > 0;
            const rightHasLayerLocation =
                !!right.location && Object.keys(right.location).length > 0;

            const leftPriority = leftHasLayerLocation
                ? 0
                : left.master?.type === 'DefaultForMaster'
                  ? 1
                  : left.master?.type === 'AssociatedWithMaster'
                    ? 2
                    : 3;
            const rightPriority = rightHasLayerLocation
                ? 0
                : right.master?.type === 'DefaultForMaster'
                  ? 1
                  : right.master?.type === 'AssociatedWithMaster'
                    ? 2
                    : 3;

            if (leftPriority !== rightPriority) {
                return leftPriority - rightPriority;
            }

            return String(left.id || '').localeCompare(String(right.id || ''));
        });

        return matchingLayers[0] || null;
    }

    private _requestAdjacentSnapInterpolatedLayer(
        glyphName: string,
        userspaceLocation: UserspaceLocation
    ): void {
        const fontCompilation = (window as any).fontCompilation;
        if (!fontCompilation?.sendMessage) {
            return;
        }

        const cacheKey = this._makeAdjacentSnapInterpolationCacheKey(
            glyphName,
            userspaceLocation
        );
        if (
            this._adjacentSnapInterpolatedLayerCache.has(cacheKey) ||
            this._pendingAdjacentSnapInterpolatedLayerRequests.has(cacheKey)
        ) {
            return;
        }

        const sessionId = this._adjacentSnapInterpolationSessionId;
        this._pendingAdjacentSnapInterpolatedLayerRequests.add(cacheKey);

        void fontCompilation
            .sendMessage({
                type: 'getGlyphOutlines',
                glyphNames: [glyphName],
                location: userspaceLocation,
                flattenComponents: true
            })
            .then((response: any) => {
                if (sessionId !== this._adjacentSnapInterpolationSessionId) {
                    return;
                }

                if (response?.error) {
                    console.warn(
                        '[OutlineEditor] Failed to fetch adjacent snap outlines:',
                        response.error
                    );
                    this._adjacentSnapInterpolatedLayerCache.set(
                        cacheKey,
                        null
                    );
                    return;
                }

                const outlines = JSON.parse(response?.outlinesJson || '[]');
                const outline = outlines.find(
                    (candidate: any) => candidate?.name === glyphName
                );

                if (!outline) {
                    this._adjacentSnapInterpolatedLayerCache.set(
                        cacheKey,
                        null
                    );
                    return;
                }

                const normalizedLayer = LayerDataNormalizer.normalize(
                    {
                        width: outline.width ?? 0,
                        shapes: outline.shapes || []
                    },
                    true
                );
                this._adjacentSnapInterpolatedLayerCache.set(
                    cacheKey,
                    normalizedLayer
                );
            })
            .catch((error: any) => {
                if (sessionId !== this._adjacentSnapInterpolationSessionId) {
                    return;
                }
                console.warn(
                    '[OutlineEditor] Adjacent snap outline request failed:',
                    error
                );
                this._adjacentSnapInterpolatedLayerCache.set(cacheKey, null);
            })
            .finally(() => {
                if (sessionId !== this._adjacentSnapInterpolationSessionId) {
                    return;
                }

                this._pendingAdjacentSnapInterpolatedLayerRequests.delete(
                    cacheKey
                );

                if (
                    this.isDraggingPoint &&
                    !this.isSlidingSmoothPointAlongCurve &&
                    this._snapDragStartNodePos
                ) {
                    this._rebuildSnapCandidateCache();
                    this.glyphCanvas.render();
                }
            });
    }

    private _resolveAdjacentSnapLayerData(
        glyphName: string,
        masterId: string | null | undefined,
        fontModel: any
    ): Babelfont.Layer | null {
        const userspaceLocation =
            this._getCurrentAdjacentSnapUserspaceLocation();
        if (userspaceLocation) {
            const matchingLayer =
                this._findMatchingLayerForGlyphAtUserspaceLocation(
                    glyphName,
                    userspaceLocation
                );

            if (matchingLayer?.id) {
                const exactLayerData = this.buildExactLayerDataFromModel(
                    glyphName,
                    matchingLayer.id
                );
                if (exactLayerData) {
                    return exactLayerData;
                }
            }

            const cacheKey = this._makeAdjacentSnapInterpolationCacheKey(
                glyphName,
                userspaceLocation
            );
            if (this._adjacentSnapInterpolatedLayerCache.has(cacheKey)) {
                return (
                    this._adjacentSnapInterpolatedLayerCache.get(cacheKey) ||
                    null
                );
            }

            this._requestAdjacentSnapInterpolatedLayer(
                glyphName,
                userspaceLocation
            );
            return null;
        }

        const glyphWrapper = glyphName ? fontModel?.findGlyph(glyphName) : null;
        if (!glyphWrapper?.layers?.length) {
            return null;
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

        if (layer?.id) {
            return this.buildExactLayerDataFromModel(glyphName, layer.id);
        }

        return null;
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
        if (!glyphName) {
            return [];
        }

        const layer = this._resolveAdjacentSnapLayerData(
            glyphName,
            masterId,
            fontModel
        );
        if (!layer?.shapes?.length) {
            return [];
        }

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

    private _buildSnapCandidateCache(
        anchor: {
            x: number;
            y: number;
        },
        includeOriginCandidate: boolean = true,
        originCandidatePosition?: {
            x: number;
            y: number;
        }
    ): SnapCandidateCache {
        const distFn = (c: SnapCandidate) =>
            Math.hypot(c.x - anchor.x, c.y - anchor.y);
        const sortByDist = (arr: SnapCandidate[]) =>
            arr.sort((a, b) => distFn(a) - distFn(b));

        // Origin: always first so snapping back to start is never blocked.
        const originCandidate: SnapCandidate = {
            x: originCandidatePosition?.x ?? anchor.x,
            y: originCandidatePosition?.y ?? anchor.y,
            source: 'origin'
        };

        // Active glyph on-curve nodes (split into dragged vs non-dragged)
        const draggedKeys = this.isDraggingPoint
            ? new Set(
                  this.selectedPoints.map(
                      (p) => `${p.contourIndex}:${p.nodeIndex}`
                  )
              )
            : new Set<string>();
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
        const activeOnlyDragCandidates = includeOriginCandidate
            ? [originCandidate, ...activeNonDragged]
            : [...activeNonDragged];
        const allDragCandidates = includeOriginCandidate
            ? [
                  originCandidate,
                  ...activeNonDragged,
                  ...leftCandidates,
                  ...rightCandidates
              ]
            : [...activeNonDragged, ...leftCandidates, ...rightCandidates];
        // Debug includes ALL active nodes (including dragged ones) + neighbors
        const debugCandidates = includeOriginCandidate
            ? [
                  originCandidate,
                  ...activeNonDragged,
                  ...activeDragged,
                  ...leftCandidates,
                  ...rightCandidates
              ]
            : [
                  ...activeNonDragged,
                  ...activeDragged,
                  ...leftCandidates,
                  ...rightCandidates
              ];

        sortByDist(activeOnlyDragCandidates);
        sortByDist(allDragCandidates);
        sortByDist(debugCandidates);

        const scale = this.glyphCanvas.viewportManager?.scale || 1;
        const snapDistFontUnits =
            APP_SETTINGS.OUTLINE_EDITOR.SNAP_DISTANCE_PX / scale;
        const width = activeLayerData?.width;
        const edgeXValues =
            typeof width === 'number' && Number.isFinite(width)
                ? Array.from(
                      new Set(
                          [0, Math.round(width)].filter((value) =>
                              Number.isFinite(value)
                          )
                      )
                  )
                : [0];
        const metricsYValues = getVisibleVerticalMetricValues(
            this.renderVerticalMetrics
        );

        return {
            activeOnlyDragCandidates,
            allDragCandidates,
            debugCandidates,
            snapDistFontUnits,
            edgeXValues,
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
     * Return the position of the first selected point from the current live
     * layer data, or null if none is available.
     */
    private _getPrimaryDragNodePos(): { x: number; y: number } | null {
        const currentLayerData = this.getCurrentLayerDataFromStack();
        if (!currentLayerData?.shapes) return null;
        if (this._dragConnectionSourcePoint) {
            const contour = getEditableContour(
                currentLayerData.shapes[
                    this._dragConnectionSourcePoint.contourIndex
                ]
            );
            const node =
                contour?.nodes?.[this._dragConnectionSourcePoint.nodeIndex];
            if (node) {
                return { x: node.x, y: node.y };
            }
        }
        for (const { contourIndex, nodeIndex } of this.selectedPoints) {
            const contour = getEditableContour(
                currentLayerData.shapes[contourIndex]
            );
            const node = contour?.nodes[nodeIndex];
            if (node) {
                return { x: node.x, y: node.y };
            }
        }
        return null;
    }

    /**
     * Resolve the snapped X/Y position for a natural point position against a
     * prepared snap candidate cache.
     */
    private _resolveSnappedPosition(
        naturalX: number,
        naturalY: number,
        snapCandidateCache: SnapCandidateCache,
        originPos: { x: number; y: number } | null
    ): {
        snappedX: number;
        snappedY: number;
        xSource: SnapCandidate | null;
        ySource: SnapCandidate | null;
    } {
        const snapDist = snapCandidateCache.snapDistFontUnits;

        const allCandidates = snapCandidateCache.allDragCandidates;
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

            if (distX <= snapDist && distY <= snapDist) {
                const pointDist = Math.hypot(distX, distY);
                if (pointDist < bestSnapPointDist) {
                    bestSnapPointDist = pointDist;
                    bestSnapPoint = candidate;
                }
            }

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

        for (const metricY of snapCandidateCache.metricsYValues) {
            const distY = Math.abs(naturalY - metricY);
            if (distY < bestDistY) {
                bestDistY = distY;
                bestSnapY = metricY;
                if (originPos) {
                    const distXFromOrigin = Math.abs(naturalX - originPos.x);
                    if (distXFromOrigin <= snapDist) {
                        const metricCandidate: SnapCandidate = {
                            x: originPos.x,
                            y: metricY,
                            source: 'metric'
                        };
                        bestSnapYCandidate = metricCandidate;
                        bestSnapX = originPos.x;
                        bestSnapXCandidate = metricCandidate;
                        bestDistX = distXFromOrigin;
                    } else {
                        bestSnapYCandidate = {
                            x: naturalX,
                            y: metricY,
                            source: 'metric'
                        };
                    }
                } else {
                    bestSnapYCandidate = {
                        x: naturalX,
                        y: metricY,
                        source: 'metric'
                    };
                }
            }
        }

        for (const edgeX of snapCandidateCache.edgeXValues || []) {
            const distX = Math.abs(naturalX - edgeX);
            if (distX < bestDistX) {
                bestDistX = distX;
                bestSnapX = edgeX;
                if (originPos) {
                    const distYFromOrigin = Math.abs(naturalY - originPos.y);
                    if (distYFromOrigin <= snapDist) {
                        const edgeCandidate: SnapCandidate = {
                            x: edgeX,
                            y: originPos.y,
                            source: 'edge'
                        };
                        bestSnapXCandidate = edgeCandidate;
                        bestSnapY = originPos.y;
                        bestSnapYCandidate = edgeCandidate;
                        bestDistY = distYFromOrigin;
                    } else {
                        bestSnapXCandidate = {
                            x: edgeX,
                            y: naturalY,
                            source: 'edge'
                        };
                    }
                } else {
                    bestSnapXCandidate = {
                        x: edgeX,
                        y: naturalY,
                        source: 'edge'
                    };
                }
            }
        }

        let snappedX = naturalX;
        let snappedY = naturalY;
        let xSource: SnapCandidate | null = null;
        let ySource: SnapCandidate | null = null;

        if (bestSnapPoint) {
            const useExactX =
                !bestSnapXCandidate ||
                Math.abs(naturalX - bestSnapPoint.x) <= bestDistX;
            const useExactY =
                !bestSnapYCandidate ||
                Math.abs(naturalY - bestSnapPoint.y) <= bestDistY;
            xSource = useExactX ? bestSnapPoint : bestSnapXCandidate;
            ySource = useExactY ? bestSnapPoint : bestSnapYCandidate;
            snappedX = xSource ? xSource.x : naturalX;
            snappedY = ySource ? ySource.y : naturalY;
            if (!useExactX && bestSnapXCandidate) {
                snappedX = bestSnapX!;
            }
            if (!useExactY && bestSnapYCandidate) {
                snappedY = bestSnapY!;
            }
        } else {
            if (bestSnapX !== null) {
                snappedX = bestSnapX;
                xSource = bestSnapXCandidate;
            }
            if (bestSnapY !== null) {
                snappedY = bestSnapY;
                ySource = bestSnapYCandidate;
            }
        }

        return { snappedX, snappedY, xSource, ySource };
    }

    /**
     * Snap a command-path drawing point against the same node and vertical
     * metric and glyph-edge candidates used for dragging existing points, without adding a
     * phantom origin candidate.
     */
    private _snapPointForDrawing(
        point: {
            x: number;
            y: number;
        },
        originPoint?: { x: number; y: number } | null
    ): { x: number; y: number } {
        const cache = this._buildSnapCandidateCache(
            point,
            Boolean(originPoint),
            originPoint || undefined
        );
        const resolved = this._resolveSnappedPosition(
            Math.round(point.x),
            Math.round(point.y),
            cache,
            originPoint || null
        );
        return {
            x: resolved.snappedX,
            y: resolved.snappedY
        };
    }

    private getCommandPathOriginPoint(
        session: ActivePathDrawingSession | null = this.getCommandPathPreviewSeed()
    ): { x: number; y: number } | null {
        if (!session) {
            return null;
        }

        const currentLayerData = this.getCurrentLayerDataFromStack();
        const contour = getEditableContour(
            currentLayerData?.shapes?.[session.shapeIndex]
        );
        const node = contour?.nodes?.[session.originNodeIndex];
        return node ? { x: node.x, y: node.y } : null;
    }

    /**
     * Build snap visualization state for the current command-path preview.
     */
    private _getCommandPathPreviewSnapVisualizationState(): SnapVisualizationState | null {
        if (!this.active || this.isPreviewMode || !this.cmdKeyPressed) {
            return null;
        }

        const { glyphX, glyphY } = this.transformMouseToComponentSpace();
        const naturalPos = {
            x: Math.round(glyphX),
            y: Math.round(glyphY)
        };
        const originPos = this.getCommandPathOriginPoint();
        const cache = this._buildSnapCandidateCache(
            naturalPos,
            Boolean(originPos),
            originPos || undefined
        );
        const { snappedX, snappedY, xSource, ySource } =
            this._resolveSnappedPosition(
                naturalPos.x,
                naturalPos.y,
                cache,
                originPos
            );

        return {
            debugCandidates: cache.debugCandidates.filter(
                (candidate) => candidate.source !== 'active'
            ),
            snapTarget:
                xSource || ySource
                    ? {
                          xSource,
                          ySource,
                          snappedX,
                          snappedY
                      }
                    : null,
            naturalPos,
            originPos
        };
    }

    /**
     * Return the active snap visualization state for dragging or command-path preview.
     */
    getSnapVisualizationState(): SnapVisualizationState | null {
        if (
            this.isDraggingPoint &&
            !this.isSlidingSmoothPointAlongCurve &&
            this._snapCandidateCache
        ) {
            return {
                debugCandidates:
                    this._snapCandidateCache.debugCandidates.filter(
                        (candidate) => candidate.source !== 'active'
                    ),
                snapTarget: this.activeSnapTarget,
                naturalPos: this.snapDraggedNaturalPos,
                originPos: this.snapDragStartNodePos
            };
        }

        return this._getCommandPathPreviewSnapVisualizationState();
    }

    /**
     * Capture the original anchor ray for a single non-smooth off-curve drag.
     */
    private _captureOffCurveAltDragConstraint(): void {
        this._offCurveAltDragConstraint = null;

        if (this.selectedPoints.length !== 1) {
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
        if (!contour) {
            return;
        }

        const reference = getOffCurveDragConstraintReference(
            contour,
            nodeIndex
        );
        if (!reference) {
            return;
        }

        this._offCurveAltDragConstraint = {
            contourIndex,
            nodeIndex,
            ...reference
        };
    }

    /**
     * Capture the current handle line for a single smooth on-curve point so
     * Alt can freeze the off-curve points and slide only the anchor.
     */
    private _captureSmoothOnCurveAltDragConstraint(): void {
        this._smoothOnCurveAltDragConstraint = null;

        if (this.selectedPoints.length !== 1) {
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
        if (!contour) {
            return;
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
            return;
        }

        const prevNode = contour.nodes[prevIndex];
        const nextNode = contour.nodes[nextIndex];
        let linePointX: number;
        let linePointY: number;
        let directionX: number;
        let directionY: number;

        if (isOffCurveNode(prevNode) && isOffCurveNode(nextNode)) {
            linePointX = prevNode.x;
            linePointY = prevNode.y;
            directionX = nextNode.x - prevNode.x;
            directionY = nextNode.y - prevNode.y;
        } else if (isOffCurveNode(prevNode) && isOnCurveNode(nextNode)) {
            linePointX = prevNode.x;
            linePointY = prevNode.y;
            directionX = nextNode.x - prevNode.x;
            directionY = nextNode.y - prevNode.y;
        } else if (isOnCurveNode(prevNode) && isOffCurveNode(nextNode)) {
            linePointX = prevNode.x;
            linePointY = prevNode.y;
            directionX = nextNode.x - prevNode.x;
            directionY = nextNode.y - prevNode.y;
        } else {
            return;
        }

        if (directionX === 0 && directionY === 0) {
            return;
        }

        this._smoothOnCurveAltDragConstraint = {
            contourIndex,
            nodeIndex,
            linePointX,
            linePointY,
            directionX,
            directionY
        };
    }

    /**
     * Shared body for both alt-drag constraint re-application methods.
     * When the Alt key is pressed or released mid-drag, re-evaluates the
     * current pointer position against the stored constraint so the handle
     * or on-curve point updates immediately.
     */
    private _applyCurrentAltConstraintStateForNode(
        constraint: { contourIndex: number; nodeIndex: number } | null,
        checkNodeType: (node: Babelfont.Node | null | undefined) => boolean
    ): void {
        if (
            !constraint ||
            !this.isDraggingPoint ||
            this.isSlidingSmoothPointAlongCurve
        ) {
            return;
        }

        const currentLayerData = this.getCurrentLayerDataFromStack();
        if (!currentLayerData?.shapes) {
            return;
        }

        const contour = getEditableContour(
            currentLayerData.shapes[constraint.contourIndex]
        );
        const node = contour?.nodes[constraint.nodeIndex];
        if (!contour || !node || !checkNodeType(node)) {
            return;
        }

        const { glyphX, glyphY } = this.transformMouseToComponentSpace();
        const beforeX = node.x;
        const beforeY = node.y;

        this.applySelectedPointMove(
            currentLayerData,
            0,
            0,
            false,
            false,
            glyphX,
            glyphY,
            this.altKeyPressed,
            !this.altKeyPressed
        );

        const appliedDeltaX = node.x - beforeX;
        const appliedDeltaY = node.y - beforeY;
        if (appliedDeltaX !== 0 || appliedDeltaY !== 0) {
            this._hasMoved = true;
            this.updatePointDragDeltaX(appliedDeltaX);
            this.applyMetricsKeysToCurrentEditedLayer();
        }

        const recalc = this.transformMouseToComponentSpace();
        this.lastGlyphX = recalc.glyphX;
        this.lastGlyphY = recalc.glyphY;
    }

    /**
     * Re-evaluate the active off-curve drag at the current pointer when Alt
     * changes so the handle updates immediately on press and release.
     */
    private _applyCurrentOffCurveAltConstraintState(): void {
        this._applyCurrentAltConstraintStateForNode(
            this._offCurveAltDragConstraint,
            isOffCurveNode
        );
    }

    /**
     * Re-evaluate the active smooth on-curve drag at the current pointer when
     * Alt changes so the constrained/free state updates immediately.
     */
    private _applyCurrentSmoothOnCurveAltConstraintState(): void {
        this._applyCurrentAltConstraintStateForNode(
            this._smoothOnCurveAltDragConstraint,
            isOnCurveNode
        );
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

        const {
            snappedX: finalSnapX,
            snappedY: finalSnapY,
            xSource,
            ySource
        } = this._resolveSnappedPosition(
            naturalX,
            naturalY,
            this._snapCandidateCache,
            this._snapDragStartNodePos
        );

        let adjustedDeltaX = naturalX - primaryNodeX;
        let adjustedDeltaY = naturalY - primaryNodeY;

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

        if (this.isDraggingContrastAxis) {
            this.handleContrastAxisDrag(e);
            return;
        }

        if (this.isResizingSelection) {
            this.handleSelectionResizeDrag(e);
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

    private buildSelectionResizeDescription(
        bounds: SelectionTransformBounds | null
    ): string | null {
        if (!bounds) {
            return null;
        }

        return `Bounds: (${Math.round(bounds.minX)}, ${Math.round(bounds.minY)})-(${Math.round(bounds.maxX)}, ${Math.round(bounds.maxY)})`;
    }

    private buildContrastAxisDescription(): string | null {
        if (!this.isStrokeAwareScalingEnabled()) {
            return null;
        }

        return `Contrast axis: ${Math.round(this.getCurrentContrastAxisAngleDegrees())}°`;
    }

    private getStrokeAwarePreservationStrength(
        normalX: number,
        normalY: number,
        scaleX: number,
        scaleY: number,
        handle: SelectionResizeHandle
    ): number {
        const epsilon = 0.000001;
        const preserveHorizontally =
            handle.xRole !== 0 && Math.abs(scaleX - 1) > epsilon;
        const preserveVertically =
            handle.yRole !== 0 && Math.abs(scaleY - 1) > epsilon;

        if (preserveHorizontally && preserveVertically) {
            return 1;
        }
        if (preserveHorizontally) {
            return Math.abs(normalX);
        }
        if (preserveVertically) {
            return Math.abs(normalY);
        }

        return 0;
    }

    private beginContrastAxisDrag(e: MouseEvent): void {
        if (
            !this.hoveredContrastAxisHandle ||
            !this.isStrokeAwareScalingEnabled()
        ) {
            return;
        }

        this.isDraggingContrastAxis = true;
        this._hasMoved = false;
        this._dragType = 'contrast-axis';
        this._preDragDesc = this.buildContrastAxisDescription();
        window.changeBridge?.beginTransaction('Set contrast axis');
        this.glyphCanvas.lastMouseX = e.clientX;
        this.glyphCanvas.lastMouseY = e.clientY;
        this.glyphCanvas.render();
    }

    private handleContrastAxisDrag(e: MouseEvent): void {
        const bounds = this.getVisibleSelectionTransformBounds();
        if (!bounds) {
            return;
        }

        const rect = this.canvas!.getBoundingClientRect();
        this.glyphCanvas.mouseX = e.clientX - rect.left;
        this.glyphCanvas.mouseY = e.clientY - rect.top;
        const { glyphX, glyphY } = this.transformMouseToComponentSpace();
        const angleDegrees =
            (Math.atan2(glyphY - bounds.centerY, glyphX - bounds.centerX) *
                180) /
            Math.PI;
        if (this.setCurrentContrastAxisAngleDegrees(angleDegrees)) {
            this._hasMoved = true;
        }

        this.glyphCanvas.render();
    }

    private beginSelectionResize(e: MouseEvent): void {
        const currentLayerData = this.getCurrentLayerDataFromStack();
        const bounds = this.getSelectionTransformBounds();
        const handle = this.hoveredResizeHandle;

        if (!currentLayerData || !bounds || !handle) {
            return;
        }

        const points: SelectionResizePointSnapshot[] = [];
        for (const point of this.selectedPoints) {
            const contour = getEditableContour(
                currentLayerData.shapes?.[point.contourIndex]
            );
            const node = contour?.nodes?.[point.nodeIndex];
            if (!node) {
                continue;
            }

            points.push({
                contourIndex: point.contourIndex,
                nodeIndex: point.nodeIndex,
                x: node.x,
                y: node.y
            });
        }

        const anchors: SelectionResizeAnchorSnapshot[] = [];
        for (const anchorIndex of this.selectedAnchors) {
            const anchor = currentLayerData.anchors?.[anchorIndex];
            if (!anchor) {
                continue;
            }

            anchors.push({
                anchorIndex,
                x: anchor.x,
                y: anchor.y
            });
        }

        const components: SelectionResizeComponentSnapshot[] = [];
        for (const componentIndex of this.selectedComponents) {
            const shape = currentLayerData.shapes?.[componentIndex];
            if (!shape || !('reference' in shape)) {
                continue;
            }

            const transformRaw = shape.transform;
            const usesArrayTransform = Array.isArray(transformRaw);
            const transform = !transformRaw
                ? ([1, 0, 0, 1, 0, 0] as Transform)
                : usesArrayTransform
                  ? ([...transformRaw] as Transform)
                  : (DecomposedAffineTransform.toAffine(
                        transformRaw
                    ) as Transform);

            components.push({
                componentIndex,
                transform,
                usesArrayTransform
            });
        }

        const smoothHandleDirections: SmoothHandleDirectionSnapshot[] = [];
        const strokeAwareContourIndices =
            this.getStrokeAwareEligibleContourIndices();
        strokeAwareContourIndices.forEach((contourIndex) => {
            const contour = getEditableContour(
                currentLayerData.shapes?.[contourIndex]
            );
            if (!contour) {
                return;
            }

            smoothHandleDirections.push(
                ...captureSmoothHandleDirectionSnapshots(contour, contourIndex)
            );
        });

        const strokeAwareSnapshots = this.isStrokeAwareScalingEnabled()
            ? this.buildStrokeAwareResizeSnapshots()
            : { geometry: null, targets: [] };

        this.selectionResizeSnapshot = {
            bounds,
            handle,
            points,
            anchors,
            components,
            includesGeometry: points.length > 0 || components.length > 0,
            includesAnchors: anchors.length > 0,
            useStrokeAwareScaling: this.isStrokeAwareScalingEnabled(),
            strokeAwareGeometry: strokeAwareSnapshots.geometry,
            strokeAwareTargets: strokeAwareSnapshots.targets,
            smoothHandleDirections,
            contrastAxisAngleDegrees: this.getCurrentContrastAxisAngleDegrees()
        };
        this.isResizingSelection = true;
        this._hasMoved = false;
        this._dragType = 'transform';
        this._preDragDesc = this.buildSelectionResizeDescription(bounds);
        this.selectedSidebearingHandle = null;
        this.selectedGuideHandle = null;
        window.changeBridge?.beginTransaction('Scale selection');
        this.glyphCanvas.lastMouseX = e.clientX;
        this.glyphCanvas.lastMouseY = e.clientY;
        this.lastGlyphX = null;
        this.lastGlyphY = null;
        this.glyphCanvas.updatePropertyPanel();
        this.glyphCanvas.render();
    }

    private handleSelectionResizeDrag(e: MouseEvent): void {
        const snapshot = this.selectionResizeSnapshot;
        const currentLayerData = this.getCurrentLayerDataFromStack();
        if (!snapshot || !currentLayerData) {
            return;
        }

        const rect = this.canvas!.getBoundingClientRect();
        this.glyphCanvas.mouseX = e.clientX - rect.left;
        this.glyphCanvas.mouseY = e.clientY - rect.top;
        const { glyphX, glyphY } = this.transformMouseToComponentSpace();
        const actualGlyphX =
            glyphX - (snapshot.handle.x - snapshot.handle.actualX);
        const actualGlyphY =
            glyphY - (snapshot.handle.y - snapshot.handle.actualY);

        const startBounds = snapshot.bounds;
        const widthDenominator = startBounds.maxX - startBounds.minX;
        const heightDenominator = startBounds.maxY - startBounds.minY;
        const fixedX =
            snapshot.handle.xRole === 1
                ? startBounds.minX
                : snapshot.handle.xRole === -1
                  ? startBounds.maxX
                  : startBounds.centerX;
        const fixedY =
            snapshot.handle.yRole === 1
                ? startBounds.minY
                : snapshot.handle.yRole === -1
                  ? startBounds.maxY
                  : startBounds.centerY;
        const degenerateX =
            snapshot.handle.xRole !== 0 &&
            Math.abs(widthDenominator) < 0.000001;
        const degenerateY =
            snapshot.handle.yRole !== 0 &&
            Math.abs(heightDenominator) < 0.000001;
        const scaleX =
            snapshot.handle.xRole === 0 || degenerateX
                ? 1
                : snapshot.handle.xRole === 1
                  ? (actualGlyphX - fixedX) / widthDenominator
                  : (fixedX - actualGlyphX) / widthDenominator;
        const scaleY =
            snapshot.handle.yRole === 0 || degenerateY
                ? 1
                : snapshot.handle.yRole === 1
                  ? (actualGlyphY - fixedY) / heightDenominator
                  : (fixedY - actualGlyphY) / heightDenominator;
        const translateX =
            snapshot.handle.xRole === 0 || !degenerateX
                ? 0
                : actualGlyphX -
                  (snapshot.handle.xRole === 1
                      ? startBounds.maxX
                      : startBounds.minX);
        const translateY =
            snapshot.handle.yRole === 0 || !degenerateY
                ? 0
                : actualGlyphY -
                  (snapshot.handle.yRole === 1
                      ? startBounds.maxY
                      : startBounds.minY);
        const selectionTransform = createAffineScaleAboutPoint(
            fixedX,
            fixedY,
            scaleX,
            scaleY,
            translateX,
            translateY
        );
        const handledAnchorIndices = new Set<number>();

        if (
            snapshot.useStrokeAwareScaling &&
            snapshot.strokeAwareGeometry &&
            snapshot.strokeAwareTargets.length > 0
        ) {
            const linearTransform: Transform = [
                selectionTransform[0],
                selectionTransform[1],
                selectionTransform[2],
                selectionTransform[3],
                0,
                0
            ];
            const transformedCenterlines =
                snapshot.strokeAwareGeometry.centerlineBranches.map((branch) =>
                    branch.map((point) =>
                        transformPoint(point.x, point.y, selectionTransform)
                    )
                );

            const handledPointKeys = new Set<string>([
                ...snapshot.strokeAwareTargets
                    .filter((target) => target.kind === 'point')
                    .map((point) => `${point.contourIndex}:${point.nodeIndex}`)
            ]);

            snapshot.strokeAwareTargets
                .filter((target) => target.kind === 'anchor')
                .forEach((target) =>
                    handledAnchorIndices.add(target.anchorIndex!)
                );

            for (const pointSnapshot of snapshot.strokeAwareTargets) {
                const target =
                    pointSnapshot.kind === 'point'
                        ? getEditableContour(
                              currentLayerData.shapes?.[
                                  pointSnapshot.contourIndex!
                              ]
                          )?.nodes?.[pointSnapshot.nodeIndex!]
                        : currentLayerData.anchors?.[
                              pointSnapshot.anchorIndex!
                          ];
                if (!target) {
                    continue;
                }
                const directPositions: Array<{ x: number; y: number }> = [];
                const constraints: Array<{
                    directionX: number;
                    directionY: number;
                    rhs: number;
                    weight: number;
                }> = [];

                pointSnapshot.attachments.forEach((attachment) => {
                    const transformedCenterline =
                        transformedCenterlines[attachment.centerBranchIndex];
                    if (
                        !transformedCenterline ||
                        transformedCenterline.length < 2
                    ) {
                        return;
                    }

                    const transformedCenter = evaluateOpenPolylineAt(
                        transformedCenterline,
                        attachment.centerSegmentIndex,
                        attachment.centerSegmentT
                    );
                    const transformedTangent = normalizeVector(
                        transformedCenter.tangentX,
                        transformedCenter.tangentY,
                        attachment.tangentX,
                        attachment.tangentY
                    );
                    const transformedNormalCandidate = normalizeVector(
                        attachment.normalX * linearTransform[0] +
                            attachment.normalY * linearTransform[2],
                        attachment.normalX * linearTransform[1] +
                            attachment.normalY * linearTransform[3],
                        attachment.normalX,
                        attachment.normalY
                    );
                    let transformedNormal = {
                        x: -transformedTangent.y,
                        y: transformedTangent.x
                    };
                    if (
                        dotProduct(
                            transformedNormal.x,
                            transformedNormal.y,
                            transformedNormalCandidate.x,
                            transformedNormalCandidate.y
                        ) < 0
                    ) {
                        transformedNormal = {
                            x: -transformedNormal.x,
                            y: -transformedNormal.y
                        };
                    }

                    const transformedLocalVector = transformPoint(
                        attachment.tangentX * attachment.tangentOffset +
                            attachment.normalX * attachment.normalOffset,
                        attachment.tangentY * attachment.tangentOffset +
                            attachment.normalY * attachment.normalOffset,
                        linearTransform
                    );
                    const geometricTangentOffset = dotProduct(
                        transformedLocalVector.x,
                        transformedLocalVector.y,
                        transformedTangent.x,
                        transformedTangent.y
                    );
                    const geometricNormalOffset = dotProduct(
                        transformedLocalVector.x,
                        transformedLocalVector.y,
                        transformedNormal.x,
                        transformedNormal.y
                    );
                    const preservationStrength =
                        this.getStrokeAwarePreservationStrength(
                            attachment.normalX,
                            attachment.normalY,
                            scaleX,
                            scaleY,
                            snapshot.handle
                        );
                    const strokeAwareNormalOffset =
                        attachment.normalOffset * preservationStrength +
                        geometricNormalOffset * (1 - preservationStrength);

                    directPositions.push({
                        x:
                            transformedCenter.x +
                            transformedTangent.x * geometricTangentOffset +
                            transformedNormal.x * strokeAwareNormalOffset,
                        y:
                            transformedCenter.y +
                            transformedTangent.y * geometricTangentOffset +
                            transformedNormal.y * strokeAwareNormalOffset
                    });
                    constraints.push({
                        directionX: transformedTangent.x,
                        directionY: transformedTangent.y,
                        rhs:
                            dotProduct(
                                transformedCenter.x,
                                transformedCenter.y,
                                transformedTangent.x,
                                transformedTangent.y
                            ) + geometricTangentOffset,
                        weight: 0.85
                    });
                    constraints.push({
                        directionX: transformedNormal.x,
                        directionY: transformedNormal.y,
                        rhs:
                            dotProduct(
                                transformedCenter.x,
                                transformedCenter.y,
                                transformedNormal.x,
                                transformedNormal.y
                            ) + strokeAwareNormalOffset,
                        weight: 1.35
                    });
                });

                if (directPositions.length === 0) {
                    continue;
                }

                const solvedPosition =
                    solveStrokeAwareConstraintPoint(constraints);
                if (solvedPosition) {
                    target.x = solvedPosition.x;
                    target.y = solvedPosition.y;
                    continue;
                }

                target.x =
                    directPositions.reduce(
                        (sum, position) => sum + position.x,
                        0
                    ) / directPositions.length;
                target.y =
                    directPositions.reduce(
                        (sum, position) => sum + position.y,
                        0
                    ) / directPositions.length;
            }

            const strokeAwareContourIndices = new Set(
                snapshot.strokeAwareTargets
                    .filter((target) => target.kind === 'point')
                    .map((target) => target.contourIndex!)
            );
            strokeAwareContourIndices.forEach((contourIndex) => {
                const contour = getEditableContour(
                    currentLayerData.shapes?.[contourIndex]
                );
                if (contour) {
                    reapplySmoothHandleDirectionsFromSnapshots(
                        contour,
                        snapshot.smoothHandleDirections.filter(
                            (directionSnapshot) =>
                                directionSnapshot.contourIndex === contourIndex
                        )
                    );
                }
            });

            for (const pointSnapshot of snapshot.points) {
                const pointKey = `${pointSnapshot.contourIndex}:${pointSnapshot.nodeIndex}`;
                if (handledPointKeys.has(pointKey)) {
                    continue;
                }

                const contour = getEditableContour(
                    currentLayerData.shapes?.[pointSnapshot.contourIndex]
                );
                const node = contour?.nodes?.[pointSnapshot.nodeIndex];
                if (!node) {
                    continue;
                }

                const transformedPoint = transformPoint(
                    pointSnapshot.x,
                    pointSnapshot.y,
                    selectionTransform
                );
                node.x = transformedPoint.x;
                node.y = transformedPoint.y;
            }

            const movementEpsilon = 0.000001;
            if (
                Math.abs(scaleX - 1) > movementEpsilon ||
                Math.abs(scaleY - 1) > movementEpsilon ||
                Math.abs(translateX) > movementEpsilon ||
                Math.abs(translateY) > movementEpsilon
            ) {
                this._hasMoved = true;
            }

            const now = performance.now();
            if (snapshot.includesAnchors) {
                this.refreshLiveVisibleAnchorDependents(now);
            }
            this.schedulePendingDragMetricsUpdate();
            if (now - this._lastPropertyPanelUpdateTime >= 100) {
                this._lastPropertyPanelUpdateTime = now;
                this.glyphCanvas.updatePropertyPanel();
            }
            this.glyphCanvas.render();
            return;
        }

        for (const pointSnapshot of snapshot.points) {
            const contour = getEditableContour(
                currentLayerData.shapes?.[pointSnapshot.contourIndex]
            );
            const node = contour?.nodes?.[pointSnapshot.nodeIndex];
            if (!node) {
                continue;
            }

            const transformed = transformPoint(
                pointSnapshot.x,
                pointSnapshot.y,
                selectionTransform
            );
            node.x = transformed.x;
            node.y = transformed.y;
        }

        for (const anchorSnapshot of snapshot.anchors) {
            if (handledAnchorIndices?.has(anchorSnapshot.anchorIndex)) {
                continue;
            }
            const anchor =
                currentLayerData.anchors?.[anchorSnapshot.anchorIndex];
            if (!anchor) {
                continue;
            }

            const transformed = transformPoint(
                anchorSnapshot.x,
                anchorSnapshot.y,
                selectionTransform
            );
            anchor.x = transformed.x;
            anchor.y = transformed.y;
        }

        for (const componentSnapshot of snapshot.components) {
            const shape =
                currentLayerData.shapes?.[componentSnapshot.componentIndex];
            if (!shape || !('reference' in shape)) {
                continue;
            }

            const transformed = multiplyAffineTransforms(
                selectionTransform,
                componentSnapshot.transform
            );
            (shape as any).transform = componentSnapshot.usesArrayTransform
                ? [...transformed]
                : affineToDecomposed(transformed);
        }

        const movementEpsilon = 0.000001;
        if (
            Math.abs(scaleX - 1) > movementEpsilon ||
            Math.abs(scaleY - 1) > movementEpsilon ||
            Math.abs(translateX) > movementEpsilon ||
            Math.abs(translateY) > movementEpsilon
        ) {
            this._hasMoved = true;
        }

        const now = performance.now();
        if (snapshot.includesAnchors) {
            this.refreshLiveVisibleAnchorDependents(now);
        }
        if (snapshot.includesGeometry) {
            this.schedulePendingDragMetricsUpdate();
        } else if (now - this._lastDragSaveTime >= 50) {
            this._lastDragSaveTime = now;
            this.saveLayerData('mouse-drag-anchor');
        }

        if (now - this._lastPropertyPanelUpdateTime >= 100) {
            this._lastPropertyPanelUpdateTime = now;
            this.glyphCanvas.updatePropertyPanel();
        }

        this.glyphCanvas.render();
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
            this._beginAdjacentSnapInterpolationSession();
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

            const predictedTargetX =
                (primaryPos?.x ?? glyphX) + effectiveDeltaX;
            const predictedTargetY =
                (primaryPos?.y ?? glyphY) + effectiveDeltaY;
            const endpointSnapTarget = this.findOpenPathEndpointSnapTarget(
                predictedTargetX,
                predictedTargetY
            );
            if (endpointSnapTarget && primaryPos) {
                const currentLayerData = this.getCurrentLayerDataFromStack();
                const targetContour = getEditableContour(
                    currentLayerData?.shapes?.[endpointSnapTarget.shapeIndex]
                );
                const targetNode =
                    targetContour?.nodes?.[endpointSnapTarget.nodeIndex];
                if (targetNode) {
                    effectiveDeltaX = targetNode.x - primaryPos.x;
                    effectiveDeltaY = this.isDraggingSidebearing
                        ? 0
                        : targetNode.y - primaryPos.y;
                    this.isSnappedToCloseOpenPath = true;
                    this._snappedOpenPathEndpointTarget = endpointSnapTarget;
                }
            } else {
                this.isSnappedToCloseOpenPath = false;
                this._snappedOpenPathEndpointTarget = null;
            }
        } else {
            this.activeSnapTarget = null;
            this.snapDraggedNaturalPos = null;
            this._snapCandidateCache = null;
            this.isSnappedToCloseOpenPath = false;
            this._snappedOpenPathEndpointTarget = null;
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
                glyphY,
                e.altKey,
                false
            );
            this.updatePointDragDeltaX(effectiveDeltaX);
        }
        this._updateDraggedAnchors(deltaX, deltaY);
        this._updateDraggedSidebearing(effectiveDeltaX);

        const now = performance.now();
        const shouldPersistDragFrame = now - this._lastDragSaveTime >= 50;

        if (this.selectedAnchors.length > 0) {
            this.refreshLiveVisibleAnchorDependents(now);
        }

        if (this.isDraggingComponent) {
            this.updateComponentDragDeltaX(deltaX);
        }

        if (
            this.isDraggingComponent ||
            (this.isDraggingPoint && !this.isSlidingSmoothPointAlongCurve)
        ) {
            this.schedulePendingDragMetricsUpdate();
        }

        // Throttle saveLayerData during drag (every 50ms) — final save on mouseUp
        // Anchor drag recomposition and sidebearing drag live refresh already
        // keep the model in sync and trigger compilation; saveLayerData would
        // be redundant.
        if (this.isDraggingGuide) {
            if (this.selectedGuideHandle?.scope === 'layer') {
                this.saveLayerData('mouse-drag-guide');
            }
        } else if (this.isSlidingSmoothPointAlongCurve) {
            // Sliding a smooth point is applied directly to the model so linked
            // layers stay in sync. Persist once on mouse up.
        } else if (!this.isDraggingAnchor && !this.isDraggingSidebearing) {
            if (
                shouldPersistDragFrame &&
                !this._pendingDragMetricsUpdate &&
                !this.isDraggingComponent &&
                !this.isDraggingPoint
            ) {
                this._lastDragSaveTime = now;
                this.saveLayerData('mouse-drag-outline');
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
        pointerY?: number,
        constrainWithAltModifier: boolean = false,
        allowPointerFallback: boolean = false
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
            pointerY,
            constrainWithAltModifier,
            allowPointerFallback
        );
    }

    private findOpenPathEndpointSnapTarget(
        draggedPointX: number,
        draggedPointY: number
    ): OpenPathEndpointRef | null {
        if (
            !this.isDraggingPoint ||
            !this.getCurrentLayerDataFromStack()?.shapes
        ) {
            return null;
        }

        const currentLayerData = this.getCurrentLayerDataFromStack();
        if (!currentLayerData?.shapes) {
            return null;
        }

        const sourcePoint =
            this._dragConnectionSourcePoint ||
            (this.selectedPoints.length === 1 ? this.selectedPoints[0] : null);
        if (!sourcePoint) {
            return null;
        }

        const { contourIndex, nodeIndex } = sourcePoint;
        const contour = getEditableContour(
            currentLayerData.shapes[contourIndex]
        );
        if (!contour || contour.closed || contour.nodes.length < 2) {
            return null;
        }

        const lastIndex = contour.nodes.length - 1;
        const isStartNode = nodeIndex === 0;
        const isEndNode = nodeIndex === lastIndex;
        if (!isStartNode && !isEndNode) {
            return null;
        }

        if (
            this._dragStartEndpointsCoincident &&
            !this._dragSeparatedFromCoincidentEndpointPair
        ) {
            const sourceNode = contour.nodes[nodeIndex];
            const oppositeNode = contour.nodes[isStartNode ? lastIndex : 0];
            if (
                sourceNode &&
                oppositeNode &&
                (Math.abs(sourceNode.x - oppositeNode.x) > 0.000001 ||
                    Math.abs(sourceNode.y - oppositeNode.y) > 0.000001)
            ) {
                this._dragSeparatedFromCoincidentEndpointPair = true;
            }
        }

        const snapRadius = 10 / this.glyphCanvas.viewportManager!.scale;
        let bestTarget: OpenPathEndpointRef | null = null;
        let bestDistance = Number.POSITIVE_INFINITY;

        for (
            let shapeIndex = 0;
            shapeIndex < currentLayerData.shapes.length;
            shapeIndex++
        ) {
            const candidateContour = getEditableContour(
                currentLayerData.shapes[shapeIndex]
            );
            if (
                !candidateContour ||
                candidateContour.closed ||
                candidateContour.nodes.length < 2
            ) {
                continue;
            }

            const candidateIndexes = [0, candidateContour.nodes.length - 1];
            for (const candidateNodeIndex of candidateIndexes) {
                if (
                    shapeIndex === contourIndex &&
                    candidateNodeIndex === nodeIndex
                ) {
                    continue;
                }

                if (
                    this._dragStartEndpointsCoincident &&
                    !this._dragSeparatedFromCoincidentEndpointPair &&
                    shapeIndex === contourIndex
                ) {
                    continue;
                }

                const candidateNode =
                    candidateContour.nodes[candidateNodeIndex];
                const distance = Math.sqrt(
                    (draggedPointX - candidateNode.x) ** 2 +
                        (draggedPointY - candidateNode.y) ** 2
                );
                if (distance > snapRadius || distance >= bestDistance) {
                    continue;
                }

                const targetEndpoint = this.getOpenPathEndpointRef(
                    shapeIndex,
                    candidateNodeIndex
                );
                if (!targetEndpoint) {
                    continue;
                }

                bestTarget = targetEndpoint;
                bestDistance = distance;
            }
        }

        return bestTarget;
    }

    /**
     * Check whether the selected point is an endpoint of an open path
     * and the two endpoints are at the same position.
     */
    private _areOpenPathEndpointsCoincident(
        point: Point | null = null
    ): boolean {
        const targetPoint =
            point ||
            (this.selectedPoints.length === 1 ? this.selectedPoints[0] : null);
        if (!targetPoint) {
            return false;
        }

        const currentLayerData = this.getCurrentLayerDataFromStack();
        if (!currentLayerData?.shapes) {
            return false;
        }

        const { contourIndex, nodeIndex } = targetPoint;
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
        this._snappedOpenPathEndpointTarget = null;

        const primaryPos = this._getPrimaryDragNodePos();
        if (!primaryPos) {
            return;
        }

        const bestTarget = this.findOpenPathEndpointSnapTarget(
            primaryPos.x,
            primaryPos.y
        );
        if (!bestTarget) {
            return;
        }

        this.isSnappedToCloseOpenPath = true;
        this._snappedOpenPathEndpointTarget = bestTarget;
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
            this.isDraggingContrastAxis ||
            this.isResizingSelection ||
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
        const snappedEndpointTarget = this._snappedOpenPathEndpointTarget;
        const dragConnectionSourcePoint = this._dragConnectionSourcePoint;

        this.isDraggingPoint = false;
        this.isSlidingSmoothPointAlongCurve = false;
        this.isSnappedToCloseOpenPath = false;
        this._snappedOpenPathEndpointTarget = null;
        this._dragConnectionSourcePoint = null;
        this._dragSeparatedFromCoincidentEndpointPair = false;
        this.isDraggingAnchor = false;
        this.isDraggingComponent = false;
        this.isDraggingSidebearing = false;
        this.isDraggingGuide = false;
        this.isResizingSelection = false;
        this.isDraggingContrastAxis = false;
        this.lastPointDragShiftKey = null;
        this._pointDragPreserveHandlePositions = false;
        this._offCurveAltDragConstraint = null;
        this._smoothOnCurveAltDragConstraint = null;
        const selectionResizeSnapshot = this.selectionResizeSnapshot;
        this.selectionResizeSnapshot = null;

        // Reset node snap state
        this.activeSnapTarget = null;
        this.snapDraggedNaturalPos = null;
        this._snapDragStartMouseX = null;
        this._snapDragStartMouseY = null;
        this._snapDragStartNodePos = null;
        this._snapCandidateCache = null;
        this._lastDragSaveTime = 0;
        this._lastLiveAnchorRefreshTime = 0;
        this._lastPropertyPanelUpdateTime = 0;
        this.cancelPendingDragMetricsUpdate();

        // If we were snapped to close an open path, abort the normal
        // drag sync and perform a merge-close instead.
        if (wasSnappedToClose && wasDragging && snappedEndpointTarget) {
            const sourcePoint =
                dragConnectionSourcePoint ||
                (this.selectedPoints.length === 1
                    ? this.selectedPoints[0]
                    : null);
            const sourceEndpoint = sourcePoint
                ? this.getOpenPathEndpointRef(
                      sourcePoint.contourIndex,
                      sourcePoint.nodeIndex
                  )
                : null;
            if (!sourceEndpoint) {
                return;
            }

            // Don't end the drag transaction — reuse it so
            // drag + close appear as a single undo entry.
            this._hasMoved = false;
            this._preDragDesc = null;
            this._dragType = null;
            this.completeOpenPathEndpointConnection(
                sourceEndpoint,
                snappedEndpointTarget,
                {
                    reuseTransaction: true,
                    cascadeCoincidentConnections: true,
                    compileReason:
                        sourceEndpoint.pathIndex ===
                        snappedEndpointTarget.pathIndex
                            ? 'closing dragged open path'
                            : 'connecting dragged open paths'
                }
            );
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
                        : dragType === 'transform' &&
                            selectionResizeSnapshot &&
                            !selectionResizeSnapshot.includesGeometry &&
                            selectionResizeSnapshot.includesAnchors
                          ? 'mouse-drag-anchor'
                          : 'mouse-drag-outline';
                if (
                    dragType === 'point' ||
                    dragType === 'component' ||
                    (dragType === 'transform' &&
                        selectionResizeSnapshot?.includesGeometry)
                ) {
                    this.cancelPendingDragMetricsUpdate();
                    this.flushPendingDragMetricsUpdate(dragChangeSource, true);
                } else {
                    this._lastDragSaveTime = performance.now();
                    this.saveLayerData(dragChangeSource);
                }
                console.log(
                    `[DRAG-DEBUG] onMouseUp before saveLayerData — changeSource=${dragChangeSource}`
                );
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
                } else if (dragType === 'transform') {
                    postDragDesc =
                        this.buildSelectionResizeDescription(
                            this.getSelectionTransformBounds()
                        ) ?? undefined;
                } else if (dragType === 'contrast-axis') {
                    postDragDesc =
                        this.buildContrastAxisDescription() ?? undefined;
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
                              : dragType === 'transform'
                                ? 'Scale selection'
                                : dragType === 'contrast-axis'
                                  ? 'Set contrast axis'
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
                    if (dragType === 'anchor') {
                        this._anchorAffectedGlyphNames =
                            this.rebuildAutomaticCompositesForCurrentEditedGlyph();
                    }
                    console.log(
                        `[DRAG-DEBUG] onMouseUp before _syncCurrentGlyphToYDoc — label=${label}, preDragDesc=${preDragDesc ?? 'null'}, postDragDesc=${encodedPostDesc ?? 'null'}`
                    );
                    this._syncCurrentGlyphToYDoc(
                        label,
                        preDragDesc ?? undefined,
                        encodedPostDesc,
                        metricsKeySide,
                        dragType === 'anchor'
                            ? this.collectMatchingLayerWorkerReplayTargets(
                                  this._anchorAffectedGlyphNames,
                                  this.getCurrentLayerId()
                              )
                            : dragType === 'sidebearing'
                              ? this.collectMatchingLayerWorkerReplayTargets(
                                    this._sidebearingAffectedGlyphNames,
                                    this.getCurrentLayerId()
                                )
                              : undefined
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
                    this.prepareStructuralOutlineCompile();
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
                        this.wakeStructuralOutlineCompile();
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
            } else if (dragType !== 'guide' && dragType !== 'contrast-axis') {
                console.log(
                    '[DRAG-DEBUG] onMouseUp before updateWorkerFontCache + flushPendingDebugEditingFontSaveAfterDrag'
                );
                const handledAnchorDependentRefresh =
                    dragType === 'anchor' ||
                    (dragType === 'transform' &&
                        selectionResizeSnapshot?.includesAnchors);
                if (dragType === 'sidebearing') {
                    this.syncDependentGlyphsAfterSidebearingEdit(
                        this.getCurrentGlyphModel()?.name,
                        this._sidebearingAffectedGlyphNames
                    );
                } else if (handledAnchorDependentRefresh) {
                    this._anchorAffectedGlyphNames =
                        this.rebuildAutomaticCompositesForCurrentEditedGlyph();
                    void this.syncDependentGlyphsAfterAnchorEdit(
                        this.getCurrentGlyphModel()?.name,
                        this._anchorAffectedGlyphNames
                    ).catch((error) => {
                        console.error(
                            '[OutlineEditor] Error refreshing anchor-dependent glyphs after mouseup:',
                            error
                        );
                    });
                }
                if (!handledAnchorDependentRefresh) {
                    fontManager.updateWorkerFontCache();
                }
                fontManager.flushPendingDebugEditingFontSaveAfterDrag();
            }
            this._pointDragDeltaX = 0;
            this._componentDragDeltaX = 0;
            this._sidebearingAffectedGlyphNames = new Set();
            this._anchorAffectedGlyphNames = new Set();
            this.resetLiveAnchorRefreshState();
            this._hasMoved = false;
            this._preDragDesc = null;
            this._dragType = null;
            this._metricsKeyInteractionSide = null;
            this.hoveredResizeHandle = null;
            this.hoveredContrastAxisHandle = null;

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
                this.isDraggingContrastAxis ||
                this.isResizingSelection ||
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
        this.updateHoveredResizeHandle();
        if (this.hoveredResizeHandle) {
            this.hoveredContrastAxisHandle = null;
            this.hoveredGuideHandle = null;
            this.hoveredSidebearingHandle = null;
            this.hoveredComponentIndex = null;
            this.hoveredAnchorIndex = null;
            this.hoveredPointIndex = null;
            this.hoveredAddPointPreview = null;
            this.hoveredCommandCurvePreview = null;
            this.hoveredGlyphIndex = -1;
            return;
        }
        this.updateHoveredContrastAxisHandle();
        if (this.hoveredContrastAxisHandle) {
            this.hoveredResizeHandle = null;
            this.hoveredGuideHandle = null;
            this.hoveredSidebearingHandle = null;
            this.hoveredComponentIndex = null;
            this.hoveredAnchorIndex = null;
            this.hoveredPointIndex = null;
            this.hoveredAddPointPreview = null;
            this.hoveredCommandCurvePreview = null;
            this.hoveredGlyphIndex = -1;
            return;
        }
        this.updateHoveredSidebearingHandle();
        this.updateHoveredComponent();
        this.updateHoveredAnchor();
        this.updateHoveredPoint();
        this.updateHoveredAddPointPreview();
        this.updateHoveredCommandCurvePreview();
    }

    cursorStyle(): string | null {
        if (!this.active) return null;
        if (this.hoveredResizeHandle) {
            this.canvas!.style.cursor = this.hoveredResizeHandle.cursor;
            return null;
        }
        if (this.hoveredContrastAxisHandle) {
            this.canvas!.style.cursor = this.hoveredContrastAxisHandle.cursor;
            return null;
        }
        if (this.cmdKeyPressed && this.hoveredAddPointPreview) {
            this.canvas!.style.cursor = 'crosshair';
            return null;
        }
        if (this.shouldShowCommandCutCrosshair()) {
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

    updateHoveredContrastAxisHandle(): void {
        if (!this.isStrokeAwareScalingEnabled()) {
            this.hoveredContrastAxisHandle = null;
            return;
        }

        if (this.hoveredResizeHandle) {
            if (this.hoveredContrastAxisHandle !== null) {
                this.hoveredContrastAxisHandle = null;
                this.glyphCanvas.render();
            }
            return;
        }

        const foundHandle = this._findHoveredItem(
            this.getVisibleContrastAxisHandles(),
            (handle) => ({ x: handle.x, y: handle.y }),
            (handle) => handle,
            14
        );

        if (foundHandle?.key !== this.hoveredContrastAxisHandle?.key) {
            this.hoveredContrastAxisHandle = foundHandle;
            this.glyphCanvas.render();
        }
    }

    updateHoveredResizeHandle(): void {
        if (
            !this.active ||
            !this.selectedLayerId ||
            !this.layerData ||
            this.isPreviewMode
        ) {
            this.hoveredResizeHandle = null;
            return;
        }

        const foundHandle = this._findHoveredItem(
            this.getVisibleSelectionResizeHandles(),
            (handle) => ({ x: handle.x, y: handle.y }),
            (handle) => handle,
            14
        );

        if (foundHandle?.key !== this.hoveredResizeHandle?.key) {
            this.hoveredResizeHandle = foundHandle;
            this.glyphCanvas.render();
        }
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
            (handle) => ({
                side: handle.side,
                editable: handle.editable
            }),
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

        if (this.getCommandPathPreviewSeed()) {
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
            this.suppressSelectedEndpointCommandSeedUntilCommandRelease = false;
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
            if (pressed) {
                this._captureSmoothOnCurveAltDragConstraint();
            }
            this._applyCurrentSmoothOnCurveAltConstraintState();
            this._applyCurrentOffCurveAltConstraintState();
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
            this.prepareStructuralOutlineCompile();
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
                    this.wakeStructuralOutlineCompile();
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
                this.wakeStructuralOutlineCompile();
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

        if (this.hoveredAddPointPreview) {
            return false;
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
        const targetEndpoint = this.getHoveredOpenPathEndpointRef();
        if (!targetEndpoint) {
            return false;
        }

        if (session.startedFromExistingPath) {
            if (targetEndpoint.pathIndex !== session.pathIndex) {
                return true;
            }

            return targetEndpoint.edge !== session.edge;
        }

        return (
            session.segmentCount > 1 &&
            targetEndpoint.pathIndex === session.pathIndex &&
            targetEndpoint.nodeIndex === session.originNodeIndex
        );
    }

    private beginCommandPathDrawing(): boolean {
        const currentLayerData = this.getCurrentLayerDataFromStack();
        const currentLayerModel = this.getCurrentLayerModel();

        if (!currentLayerData || !currentLayerModel) {
            return false;
        }

        const selectedPoint =
            this.selectedPoints.length === 1 ? this.selectedPoints[0] : null;
        if (
            this.suppressSelectedEndpointCommandSeedUntilCommandRelease &&
            selectedPoint &&
            this.getOpenPathEndpointRef(
                selectedPoint.contourIndex,
                selectedPoint.nodeIndex
            )
        ) {
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
            this.prepareStructuralOutlineCompile();
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
                this.wakeStructuralOutlineCompile();
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
        if (this.suppressSelectedEndpointCommandSeedUntilCommandRelease) {
            return null;
        }

        if (this.selectedPoints.length !== 1) {
            return null;
        }

        const selectedPoint = this.selectedPoints[0];
        const endpoint = this.getOpenPathEndpointRef(
            selectedPoint.contourIndex,
            selectedPoint.nodeIndex
        );
        if (!endpoint) {
            return null;
        }

        return {
            shapeIndex: endpoint.shapeIndex,
            pathIndex: endpoint.pathIndex,
            edge: endpoint.edge,
            startedFromExistingPath: true,
            originNodeIndex: endpoint.nodeIndex,
            segmentCount: 0
        };
    }

    private getOpenPathEndpointRef(
        shapeIndex: number,
        nodeIndex: number
    ): OpenPathEndpointRef | null {
        const currentLayerData = this.getCurrentLayerDataFromStack();
        const contour = getEditableContour(
            currentLayerData?.shapes?.[shapeIndex]
        );

        if (!contour || contour.closed || contour.nodes.length < 1) {
            return null;
        }

        const edge =
            nodeIndex === 0
                ? 'start'
                : nodeIndex === contour.nodes.length - 1
                  ? 'end'
                  : null;
        if (!edge) {
            return null;
        }

        const pathIndex = this.getPathIndexForShapeIndex(shapeIndex);
        if (pathIndex === null) {
            return null;
        }

        return {
            shapeIndex,
            pathIndex,
            nodeIndex,
            edge
        };
    }

    private findCoincidentOpenPathEndpointPairInLayerModel(
        layerModel: Babelfont.Layer
    ): {
        sourceEndpoint: OpenPathEndpointRef;
        targetEndpoint: OpenPathEndpointRef;
    } | null {
        const positionToEndpoints = new Map<
            string,
            Array<OpenPathEndpointRef>
        >();
        const shapes = (layerModel.shapes || []) as Array<
            Babelfont.Shape & {
                isPath?: () => boolean;
                asPath?: () => {
                    closed: boolean;
                    nodes: Babelfont.Node[];
                } | null;
            }
        >;
        let pathIndex = 0;

        for (let shapeIndex = 0; shapeIndex < shapes.length; shapeIndex++) {
            const shape = shapes[shapeIndex];
            if (!shape?.isPath?.()) {
                continue;
            }

            const path = shape.asPath?.();

            if (!path?.closed && path?.nodes.length) {
                const startNode = path.nodes[0];
                const startKey = `${startNode.x},${startNode.y}`;
                const startEndpoints = positionToEndpoints.get(startKey) || [];
                startEndpoints.push({
                    shapeIndex,
                    pathIndex,
                    nodeIndex: 0,
                    edge: 'start'
                });
                positionToEndpoints.set(startKey, startEndpoints);

                const lastIndex = path.nodes.length - 1;
                if (lastIndex > 0) {
                    const endNode = path.nodes[lastIndex];
                    const endKey = `${endNode.x},${endNode.y}`;
                    const endEndpoints = positionToEndpoints.get(endKey) || [];
                    endEndpoints.push({
                        shapeIndex,
                        pathIndex,
                        nodeIndex: lastIndex,
                        edge: 'end'
                    });
                    positionToEndpoints.set(endKey, endEndpoints);
                }
            }

            pathIndex += 1;
        }

        for (const endpoints of positionToEndpoints.values()) {
            if (endpoints.length < 2) {
                continue;
            }

            for (
                let sourceIndex = 0;
                sourceIndex < endpoints.length;
                sourceIndex++
            ) {
                for (
                    let targetIndex = sourceIndex + 1;
                    targetIndex < endpoints.length;
                    targetIndex++
                ) {
                    const sourceEndpoint = endpoints[sourceIndex];
                    const targetEndpoint = endpoints[targetIndex];
                    if (
                        sourceEndpoint.pathIndex === targetEndpoint.pathIndex &&
                        sourceEndpoint.edge === targetEndpoint.edge
                    ) {
                        continue;
                    }

                    return {
                        sourceEndpoint,
                        targetEndpoint
                    };
                }
            }
        }

        return null;
    }

    private getHoveredOpenPathEndpointRef(): OpenPathEndpointRef | null {
        const hoveredPoint = this.hoveredPointIndex;
        if (!hoveredPoint) {
            return null;
        }

        return this.getOpenPathEndpointRef(
            hoveredPoint.contourIndex,
            hoveredPoint.nodeIndex
        );
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

    private getCommandPathPreviewEndpointPoint(): Point | null {
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

        return {
            contourIndex: session.shapeIndex,
            nodeIndex: session.edge === 'start' ? 0 : contour.nodes.length - 1
        };
    }

    private shouldHideCommandPathPreviewWhileHoveringPoint(): boolean {
        if (!this.cmdKeyPressed || !this.hoveredPointIndex) {
            return false;
        }

        if (this.getHoveredOpenPathEndpointRef()) {
            return false;
        }

        const previewEndpoint = this.getCommandPathPreviewEndpointPoint();
        if (!previewEndpoint) {
            return false;
        }

        return (
            this.hoveredPointIndex.contourIndex !==
                previewEndpoint.contourIndex ||
            this.hoveredPointIndex.nodeIndex !== previewEndpoint.nodeIndex
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
            !this.shouldHideCommandPathPreviewWhileHoveringPoint() &&
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

        const previewSnapState =
            this._getCommandPathPreviewSnapVisualizationState();
        const snappedEnd = previewSnapState?.snapTarget
            ? {
                  x: previewSnapState.snapTarget.snappedX,
                  y: previewSnapState.snapTarget.snappedY
              }
            : previewSnapState?.naturalPos ||
              (() => {
                  const { glyphX, glyphY } =
                      this.transformMouseToComponentSpace();
                  return { x: glyphX, y: glyphY };
              })();
        return {
            start,
            end: snappedEnd
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

    private shouldShowCommandCutCrosshair(): boolean {
        if (!this.active || !this.cmdKeyPressed || this.isPreviewMode) {
            return false;
        }

        return this.isCuttablePoint(this.hoveredPointIndex);
    }

    private startNewPathDrawingSession(): boolean {
        const currentLayerData = this.getCurrentLayerDataFromStack();
        const currentLayerModel = this.getCurrentLayerModel();

        if (!currentLayerData || !currentLayerModel) {
            return false;
        }

        const { glyphX, glyphY } = this.transformMouseToComponentSpace();
        const snappedStart = this._snapPointForDrawing({
            x: glyphX,
            y: glyphY
        });
        snappedStart.x = Math.round(snappedStart.x);
        snappedStart.y = Math.round(snappedStart.y);
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
        this.queueStructuralOutlineCompileFromModel(
            'starting command path drawing'
        );
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
        const snappedPoint = this._snapPointForDrawing(
            point,
            this.getCommandPathOriginPoint(session)
        );
        snappedPoint.x = Math.round(snappedPoint.x);
        snappedPoint.y = Math.round(snappedPoint.y);
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
        this.queueStructuralOutlineCompileFromModel(
            'extending command path drawing'
        );
        return true;
    }

    private closeActivePathDrawingSession(
        session: ActivePathDrawingSession
    ): boolean {
        const targetEndpoint = this.getHoveredOpenPathEndpointRef();
        if (!targetEndpoint) {
            return false;
        }

        const currentLayerData = this.getCurrentLayerDataFromStack();
        const contour = getEditableContour(
            currentLayerData?.shapes?.[session.shapeIndex]
        );
        if (!contour?.nodes.length) {
            return false;
        }

        const sourceEndpoint = this.getOpenPathEndpointRef(
            session.shapeIndex,
            session.edge === 'start' ? 0 : contour.nodes.length - 1
        );
        if (!sourceEndpoint) {
            return false;
        }

        return this.completeOpenPathEndpointConnection(
            sourceEndpoint,
            targetEndpoint,
            {
                pendingCommandEdit: true,
                compileReason:
                    sourceEndpoint.pathIndex === targetEndpoint.pathIndex
                        ? 'closing command path drawing'
                        : 'connecting command path drawing'
            }
        );
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
        this.queueStructuralOutlineCompileFromModel(
            'converting line segment to curve'
        );
        return true;
    }

    private cutPathAtNode(point: Point): boolean {
        if (!this.isCuttablePoint(point)) {
            return false;
        }

        const currentLayerData = this.getCurrentLayerDataFromStack();
        const contour = getEditableContour(
            currentLayerData?.shapes?.[point.contourIndex]
        );
        if (!contour) {
            return false;
        }

        return contour.closed
            ? this.openClosedPathAtNode(point)
            : this.splitOpenPathAtNode(point);
    }

    private isCuttablePoint(point: Point | null): boolean {
        if (!point) {
            return false;
        }

        const currentLayerData = this.getCurrentLayerDataFromStack();
        const contour = getEditableContour(
            currentLayerData?.shapes?.[point.contourIndex]
        );
        const node = contour?.nodes?.[point.nodeIndex] as
            | Babelfont.Node
            | undefined;

        return isOnCurveNode(node);
    }

    /**
     * Commit a structural single-path cut or split to the bridge, refresh
     * exact layer data, schedule a structural recompile, select the node
     * produced by the operation, re-render, and queue the deferred cache
     * rebuild.  Used by both openClosedPathAtNode and splitOpenPathAtNode.
     */
    private _finalizePathCutOrSplitEdit(
        label: string,
        currentGlyphModel: any,
        selectedPoint: Point
    ): void {
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
            this.prepareStructuralOutlineCompile();
            void fontManager.updateDirtyIndicator();
        }

        this.suppressSelectedEndpointCommandSeedUntilCommandRelease = true;
        this.selectedPoints = [selectedPoint];
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
                        `[OutlineEditor] Error syncing font JSON after ${label.toLowerCase()}:`,
                        error
                    );
                    return;
                }

                void fontManager.updateWorkerFontCache();
                this.wakeStructuralOutlineCompile();
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

    private openClosedPathAtNode(point: Point): boolean {
        const currentLayerModel = this.getCurrentLayerModel();
        const currentGlyphModel = this.getCurrentGlyphModel();
        if (!currentLayerModel || !currentGlyphModel) {
            return false;
        }

        const pathIndex = this.getPathIndexForShapeIndex(point.contourIndex);
        if (pathIndex === null) {
            return false;
        }

        const activePath = currentLayerModel.paths?.[pathIndex];
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
                const linkedPath = linkedLayer.paths?.[pathIndex];
                linkedPath?._openClosedPathAtNode(point.nodeIndex);
            }
        });

        if (!changed) {
            return false;
        }

        // Select only the new end node (the duplicate at the end)
        const newPath = currentLayerModel.paths?.[point.contourIndex];
        const lastNodeIndex = newPath ? newPath.nodes.length - 1 : 0;
        this._finalizePathCutOrSplitEdit('Open path', currentGlyphModel, {
            contourIndex: point.contourIndex,
            nodeIndex: lastNodeIndex
        });
        return true;
    }

    private splitOpenPathAtNode(point: Point): boolean {
        const currentLayerModel = this.getCurrentLayerModel();
        const currentGlyphModel = this.getCurrentGlyphModel();
        if (!currentLayerModel || !currentGlyphModel) {
            return false;
        }

        const pathIndex = this.getPathIndexForShapeIndex(point.contourIndex);
        if (pathIndex === null) {
            return false;
        }

        const activePath = currentLayerModel.paths?.[pathIndex];
        if (!activePath || activePath.closed) {
            return false;
        }

        const linkedLayers = currentLayerModel._getLinkedLayers?.() || [];
        let splitResult: {
            shapeIndex: number;
            insertedShapeIndex: number;
        } | null = null;

        withSuppressedModelRecording(() => {
            splitResult = currentLayerModel.splitOpenPathAtNode(
                pathIndex,
                point.nodeIndex
            );
            if (!splitResult) {
                return;
            }

            for (const linkedLayer of linkedLayers) {
                linkedLayer.splitOpenPathAtNode(pathIndex, point.nodeIndex);
            }
        });

        if (!splitResult) {
            return false;
        }
        const finalizedSplitResult = splitResult as {
            shapeIndex: number;
            insertedShapeIndex: number;
        };

        this._finalizePathCutOrSplitEdit('Split path', currentGlyphModel, {
            contourIndex: finalizedSplitResult.insertedShapeIndex,
            nodeIndex: 0
        });
        return true;
    }

    private completeOpenPathEndpointConnection(
        sourceEndpoint: OpenPathEndpointRef,
        targetEndpoint: OpenPathEndpointRef,
        options: {
            reuseTransaction?: boolean;
            pendingCommandEdit?: boolean;
            compileReason: string;
            changeLabel?: string;
            cascadeCoincidentConnections?: boolean;
        }
    ): boolean {
        const currentLayerModel = this.getCurrentLayerModel();
        const currentGlyphModel = this.getCurrentGlyphModel();
        if (!currentLayerModel || !currentGlyphModel) {
            return false;
        }

        const linkedLayers = currentLayerModel._getLinkedLayers?.() || [];
        let result: {
            shapeIndex: number;
            boundaryNodeIndex: number;
            closed: boolean;
        } | null = null;

        withSuppressedModelRecording(() => {
            let pendingPair: {
                sourceEndpoint: OpenPathEndpointRef;
                targetEndpoint: OpenPathEndpointRef;
            } | null = {
                sourceEndpoint,
                targetEndpoint
            };

            while (pendingPair) {
                result = currentLayerModel.connectOpenPathEndpoints(
                    pendingPair.sourceEndpoint.pathIndex,
                    pendingPair.sourceEndpoint.edge,
                    pendingPair.targetEndpoint.pathIndex,
                    pendingPair.targetEndpoint.edge
                );
                if (!result) {
                    return;
                }

                for (const linkedLayer of linkedLayers) {
                    linkedLayer.connectOpenPathEndpoints(
                        pendingPair.sourceEndpoint.pathIndex,
                        pendingPair.sourceEndpoint.edge,
                        pendingPair.targetEndpoint.pathIndex,
                        pendingPair.targetEndpoint.edge
                    );
                }

                pendingPair = options.cascadeCoincidentConnections
                    ? this.findCoincidentOpenPathEndpointPairInLayerModel(
                          currentLayerModel
                      )
                    : null;
            }
        });

        if (!result) {
            return false;
        }
        const finalizedResult = result as {
            shapeIndex: number;
            boundaryNodeIndex: number;
            closed: boolean;
        };

        this.syncCurrentExactLayerDataFromModel();

        if (options.pendingCommandEdit) {
            this.notePendingCommandPathEdit('draw');
            this.activePathDrawingSession = null;
            this.selectedPoints = [
                {
                    contourIndex: finalizedResult.shapeIndex,
                    nodeIndex: finalizedResult.boundaryNodeIndex
                }
            ];
            this.selectedAnchors = [];
            this.selectedComponents = [];
            this.selectedGuideHandle = null;
            this.selectedSidebearingHandle = null;
            this.performHitDetection(null);
            this.glyphCanvas.updatePropertyPanel();
            this.glyphCanvas.render();
            this.queueStructuralOutlineCompileFromModel(options.compileReason);
            return true;
        }

        const currentFont = fontManager.currentFont;
        const bboxCenterAnchorScreen =
            this.getBoundingBoxCenterScreenPosition();
        const affectedGlyphNames = this.recomputeMetricsKeysForGlyph(
            currentGlyphModel.name
        );

        if (currentFont) {
            try {
                currentFont.syncJsonFromModel();
            } catch (error) {
                console.error(
                    '[OutlineEditor] Error syncing font JSON after connecting path endpoints:',
                    error
                );
            }
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

        const changeLabel =
            options.changeLabel ||
            (finalizedResult.closed ? 'Close path' : 'Connect path');
        this.syncStructuralGlyphChangeTransaction(
            changeLabel,
            currentGlyphModel.name,
            affectedGlyphNames,
            {
                reuseTransaction: options.reuseTransaction,
                layerId: null
            }
        );

        this.refreshKeyedMetricsViewportAnchor(
            affectedGlyphNames,
            bboxCenterAnchorScreen
        );

        if (currentFont) {
            currentFont.markDirty('keyboard-outline');
            this.prepareStructuralOutlineCompile();
            void fontManager.updateDirtyIndicator();
            this.wakeStructuralOutlineCompile();
        }

        this.selectedPoints = [
            {
                contourIndex: finalizedResult.shapeIndex,
                nodeIndex: finalizedResult.boundaryNodeIndex
            }
        ];
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

        this.syncStructuralGlyphChangeTransaction(
            'Close path',
            currentGlyphModel.name,
            affectedGlyphNames,
            { reuseTransaction, layerId: null }
        );

        this.refreshKeyedMetricsViewportAnchor(
            affectedGlyphNames,
            bboxCenterAnchorScreen
        );

        if (currentFont) {
            currentFont.markDirty('keyboard-outline');
            this.prepareStructuralOutlineCompile();
            void fontManager.updateDirtyIndicator();
            this.wakeStructuralOutlineCompile();
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

    private prepareStructuralOutlineCompile(
        changeSource: 'keyboard-outline' = 'keyboard-outline'
    ): void {
        fontManager.lastChangeSource = changeSource;
        fontManager.lastEditType = 'outline';
        fontManager.forceFullEditingCacheRefresh = true;
        fontManager.scheduleFullCompileDebounce();
    }

    private queueStructuralOutlineCompileFromModel(
        errorLabel: string,
        useFullWorkerCacheUpdate: boolean = false
    ): void {
        const currentFont = fontManager.currentFont;
        if (!currentFont) {
            return;
        }

        currentFont.markDirty('keyboard-outline');
        this.prepareStructuralOutlineCompile();
        void fontManager.updateDirtyIndicator();

        window.setTimeout(() => {
            if (fontManager.currentFont !== currentFont) {
                return;
            }

            try {
                currentFont.syncJsonFromModel();
            } catch (error) {
                console.error(
                    `[OutlineEditor] Error syncing font JSON after ${errorLabel}:`,
                    error
                );
                return;
            }

            if (useFullWorkerCacheUpdate) {
                void fontManager.forceFullWorkerCacheUpdate();
            } else {
                void fontManager.updateWorkerFontCache();
            }
            this.wakeStructuralOutlineCompile();
        }, 0);
    }

    private wakeStructuralOutlineCompile(): void {
        window.autoCompileManager?.checkAndSchedule?.();
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

        this.syncStructuralGlyphChangeTransaction(
            label,
            currentGlyphModel?.name,
            affectedGlyphNames,
            { layerId: null }
        );

        if (currentFont) {
            currentFont.markDirty('keyboard-outline');
            this.prepareStructuralOutlineCompile();
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
                this.wakeStructuralOutlineCompile();
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

        const preferExactComponentTransforms =
            this.shouldPreferExactSelectedLayerComponentTransforms(
                currentLayerModel
            );

        if (exactNormalized.shapes && currentLayerData.shapes?.length) {
            exactNormalized.shapes = this.mergeSelectedLayerShapes(
                exactNormalized.shapes,
                currentLayerData.shapes,
                preferExactComponentTransforms
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

        // Rebuild auto-composites before saving so downstream layer data
        // is current when the Yjs history entry is recorded and the
        // workerReplayTargets are collected for the undo fast path.
        this._anchorAffectedGlyphNames =
            this.rebuildAutomaticCompositesForCurrentEditedGlyph();

        // Save to object model (non-blocking)
        this.saveLayerData('keyboard-anchor');
        void this.syncDependentGlyphsAfterAnchorEdit(
            this.getCurrentGlyphModel()?.name,
            this._anchorAffectedGlyphNames
        ).catch((error) => {
            console.error(
                '[OutlineEditor] Error refreshing anchor-dependent glyphs after keyboard move:',
                error
            );
        });
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

        if (this.isAutomaticComposedLayer()) {
            this.glyphCanvas.updatePropertyPanel();
            this.glyphCanvas.render();
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
        this._sidebearingAffectedGlyphNames =
            metricsUpdate?.affectedGlyphNames ||
            new Set([glyphName].filter(Boolean) as string[]);

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
        if (this.isAutomaticComposedLayer()) {
            return false;
        }

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
        this.syncDependentGlyphsAfterSidebearingEdit(
            this.getCurrentGlyphModel()?.name,
            this._sidebearingAffectedGlyphNames
        );
        this._syncCurrentGlyphToYDoc(
            'Set sidebearing',
            formatSidebearingHistoryValue(side, currentSidebearing),
            formatSidebearingHistoryValue(side, targetValue),
            null,
            this.collectMatchingLayerWorkerReplayTargets(
                this._sidebearingAffectedGlyphNames,
                this.getCurrentLayerId()
            )
        );
        return true;
    }

    private adjustSelectedSidebearing(deltaX: number): boolean {
        if (
            !this.selectedSidebearingHandle ||
            !this.selectedSidebearingHandle.editable ||
            deltaX === 0
        ) {
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
        this.syncDependentGlyphsAfterSidebearingEdit(
            this.getCurrentGlyphModel()?.name,
            this._sidebearingAffectedGlyphNames
        );
        this.glyphCanvas.updatePropertyPanel();
        this.glyphCanvas.render();
    }

    _updateDraggedSidebearing(deltaX: number): void {
        if (!this.isDraggingSidebearing) {
            return;
        }

        this.adjustSelectedSidebearing(deltaX);

        // During sidebearing drag, queue a live downstream refresh so that
        // metrics-key cascades update incrementally without saveLayerData.
        const now = performance.now();
        this.refreshLiveVisibleSidebearingDependents(now);
    }

    private applySelectedPointMove(
        currentLayerData: Babelfont.Layer,
        deltaX: number,
        deltaY: number,
        preserveHandlePositions: boolean = false,
        snapSmoothHandleTriplet: boolean = false,
        pointerX?: number,
        pointerY?: number,
        constrainWithAltModifier: boolean = false,
        allowPointerFallback: boolean = false
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

            const freezeAdjacentHandlesForSmoothAlt =
                constrainWithAltModifier &&
                !!this._smoothOnCurveAltDragConstraint &&
                isOnCurveNode(node) &&
                contourIndex ===
                    this._smoothOnCurveAltDragConstraint.contourIndex &&
                nodeIndex === this._smoothOnCurveAltDragConstraint.nodeIndex;

            let adjustedDelta =
                preserveHandlePositions && isOnCurveNode(node)
                    ? getAltAnchorMoveDelta(contour, nodeIndex, deltaX, deltaY)
                    : { deltaX, deltaY };

            if (
                this._smoothOnCurveAltDragConstraint &&
                isOnCurveNode(node) &&
                this._snapDragStartNodePos &&
                this._snapDragStartMouseX !== null &&
                this._snapDragStartMouseY !== null &&
                contourIndex ===
                    this._smoothOnCurveAltDragConstraint.contourIndex &&
                nodeIndex === this._smoothOnCurveAltDragConstraint.nodeIndex
            ) {
                if (constrainWithAltModifier) {
                    const snappedTargetX = node.x + adjustedDelta.deltaX;
                    const snappedTargetY = node.y + adjustedDelta.deltaY;
                    const projectedPointerDelta = projectDeltaOntoDirection(
                        snappedTargetX -
                            this._smoothOnCurveAltDragConstraint.linePointX,
                        snappedTargetY -
                            this._smoothOnCurveAltDragConstraint.linePointY,
                        this._smoothOnCurveAltDragConstraint.directionX,
                        this._smoothOnCurveAltDragConstraint.directionY
                    );
                    adjustedDelta = {
                        deltaX:
                            this._smoothOnCurveAltDragConstraint.linePointX +
                            projectedPointerDelta.deltaX -
                            node.x,
                        deltaY:
                            this._smoothOnCurveAltDragConstraint.linePointY +
                            projectedPointerDelta.deltaY -
                            node.y
                    };
                } else if (
                    allowPointerFallback &&
                    pointerX !== undefined &&
                    pointerY !== undefined &&
                    adjustedDelta.deltaX === 0 &&
                    adjustedDelta.deltaY === 0
                ) {
                    adjustedDelta = {
                        deltaX: pointerX - node.x,
                        deltaY: pointerY - node.y
                    };
                }
            }

            if (
                this._offCurveAltDragConstraint &&
                isOffCurveNode(node) &&
                pointerX !== undefined &&
                pointerY !== undefined &&
                contourIndex === this._offCurveAltDragConstraint.contourIndex &&
                nodeIndex === this._offCurveAltDragConstraint.nodeIndex
            ) {
                if (constrainWithAltModifier) {
                    const projectedPointerDelta = projectDeltaOntoDirection(
                        pointerX - this._offCurveAltDragConstraint.anchorX,
                        pointerY - this._offCurveAltDragConstraint.anchorY,
                        this._offCurveAltDragConstraint.directionX,
                        this._offCurveAltDragConstraint.directionY
                    );
                    adjustedDelta = {
                        deltaX:
                            this._offCurveAltDragConstraint.anchorX +
                            projectedPointerDelta.deltaX -
                            node.x,
                        deltaY:
                            this._offCurveAltDragConstraint.anchorY +
                            projectedPointerDelta.deltaY -
                            node.y
                    };
                } else if (
                    allowPointerFallback &&
                    pointerX !== undefined &&
                    pointerY !== undefined &&
                    adjustedDelta.deltaX === 0 &&
                    adjustedDelta.deltaY === 0
                ) {
                    adjustedDelta = {
                        deltaX: pointerX - node.x,
                        deltaY: pointerY - node.y
                    };
                }
            }

            if (adjustedDelta.deltaX === 0 && adjustedDelta.deltaY === 0) {
                continue;
            }

            moveNodeByDelta(node, adjustedDelta.deltaX, adjustedDelta.deltaY);

            if (
                isOnCurveNode(node) &&
                node.smooth &&
                !preserveHandlePositions &&
                !freezeAdjacentHandlesForSmoothAlt
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

            if (
                isOffCurveNode(node) ||
                preserveHandlePositions ||
                freezeAdjacentHandlesForSmoothAlt
            ) {
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

            if (
                !node.smooth &&
                !canOnCurvePointBeSmooth(contour, point.nodeIndex)
            ) {
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

        const deletedPathGeometry = pointsByPath.size > 0;
        let affectedGlyphNames = new Set<string>(
            [currentGlyphModel.name].filter(Boolean) as string[]
        );
        let bboxCenterAnchorScreen: { x: number; y: number } | null = null;

        if (deletedPathGeometry) {
            this.syncCurrentExactLayerDataFromModel();
            bboxCenterAnchorScreen = this.getBoundingBoxCenterScreenPosition();
            affectedGlyphNames = this.recomputeMetricsKeysForGlyph(
                currentGlyphModel.name
            );
        }

        this.syncStructuralGlyphChangeTransaction(
            'Delete point(s)',
            currentGlyphModel.name,
            affectedGlyphNames,
            { layerId: null }
        );

        this.syncCurrentExactLayerDataFromModel();

        if (deletedPathGeometry) {
            this.refreshKeyedMetricsViewportAnchor(
                affectedGlyphNames,
                bboxCenterAnchorScreen
            );
        }

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
            this.prepareStructuralOutlineCompile();
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
                    void fontManager.updateWorkerFontCache().then(() => {
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
                    this.wakeStructuralOutlineCompile();
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

                void fontManager.updateWorkerFontCache().then(() => {
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
                this.wakeStructuralOutlineCompile();
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
            const shouldExtrapolate = true;
            const interpolatedLayer = await fontInterpolation.interpolateGlyph(
                rootGlyphName,
                location,
                shouldExtrapolate
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
                // When anchors were nudged, include downstream auto-composite
                // targets so the undo fast path can refresh the worker cache
                // incrementally instead of falling back to storeFontJson.
                const anchorReplayTargets =
                    this.selectedAnchors.length > 0
                        ? this.collectMatchingLayerWorkerReplayTargets(
                              this._anchorAffectedGlyphNames,
                              this.getCurrentLayerId()
                          )
                        : undefined;
                this._syncCurrentGlyphToYDoc(
                    'Arrow key',
                    preMoveDesc,
                    postMoveDesc,
                    visualAnchorSide,
                    anchorReplayTargets
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
        const currentUserspaceLocation = {
            ...this.glyphCanvas.axesManager!.variationSettings
        };
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
        } else {
            this.updateLayerSelection();
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
            // incremental layer-update batches during edits and storeFontJson at font-open time.
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
        visualAnchorSide?: SidebearingSide | null,
        workerReplayTargets?: Array<{ glyphName: string; layerId: string }>
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
            visualAnchorSide,
            workerReplayTargets
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

        const addLayerButton =
            this.glyphCanvas.propertiesSection.querySelector<HTMLButtonElement>(
                '.editor-layer-add-button'
            );
        if (addLayerButton) {
            const glyphName =
                this.getLayerLinkGlyphName() ||
                this.glyphCanvas.getCurrentGlyphName();
            addLayerButton.disabled =
                !glyphName || !!this.findMatchingLayer(glyphName);
        }
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

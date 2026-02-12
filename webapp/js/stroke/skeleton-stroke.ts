import { Bezier } from 'bezier-js';

export type StrokeNode = {
    x: number;
    y: number;
    nodetype?: string;
    type?: string;
    smooth?: boolean;
};

export type StrokePath = {
    nodes: StrokeNode[];
    closed: boolean;
};

export type SkeletonStrokeOptions = {
    maxRayLength?: number;
    collinearEpsilon?: number;
    selfHitMinDistance?: number;
    lineAxisEpsilon?: number;
    fillProbeDistance?: number;
    segmentSampleSteps?: number;
};

type SegmentInfo = {
    pathIndex: number;
    type: 'line' | 'quadratic' | 'cubic';
    points: Array<{ x: number; y: number }>;
};

type TripletConstraint = {
    pathIndex: number;
    onIndex: number;
    prevIndex: number;
    nextIndex: number;
    orientation: 'horizontal' | 'vertical' | 'diagonal';
    direction: { x: number; y: number };
};

type AxisLineConstraint = {
    pathIndex: number;
    startIndex: number;
    endIndex: number;
    orientation: 'horizontal' | 'vertical';
};

type PolySegment = {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
};

type Bounds = {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
};

const EPSILON = 1e-9;

function normalize(x: number, y: number): { x: number; y: number } | null {
    const length = Math.hypot(x, y);
    if (length < EPSILON) return null;
    return { x: x / length, y: y / length };
}

function getBounds(nodes: StrokeNode[]): Bounds {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const node of nodes) {
        if (node.x < minX) minX = node.x;
        if (node.y < minY) minY = node.y;
        if (node.x > maxX) maxX = node.x;
        if (node.y > maxY) maxY = node.y;
    }

    return { minX, minY, maxX, maxY };
}

function isOffCurve(node: StrokeNode | undefined): boolean {
    if (!node) return false;
    const type = (node.type || node.nodetype || '').toString().toLowerCase();
    return type === 'o' || type === 'offcurve';
}

function getNode(
    nodes: StrokeNode[],
    index: number,
    closed: boolean
): StrokeNode | null {
    if (nodes.length === 0) return null;
    if (closed) {
        const wrapped = ((index % nodes.length) + nodes.length) % nodes.length;
        return nodes[wrapped] || null;
    }
    if (index < 0 || index >= nodes.length) return null;
    return nodes[index] || null;
}

function processPathSegments(pathData: {
    nodes: StrokeNode[];
    closed?: boolean;
}): Array<{
    points: Array<{ x: number; y: number }>;
    type: 'line' | 'quadratic' | 'cubic';
}> {
    const segments: Array<{
        points: Array<{ x: number; y: number }>;
        type: 'line' | 'quadratic' | 'cubic';
    }> = [];

    if (!pathData.nodes || pathData.nodes.length < 2) {
        return segments;
    }

    const nodes = pathData.nodes;
    const closed = pathData.closed !== false;

    const isOnCurve = (node: StrokeNode): boolean => !isOffCurve(node);

    let startIdx = 0;
    if (closed) {
        for (let i = 0; i < nodes.length; i++) {
            if (isOnCurve(nodes[i])) {
                startIdx = i;
                break;
            }
        }
    }

    let i = startIdx;
    let processedCount = 0;
    const maxNodes = closed ? nodes.length : nodes.length - 1;

    while (processedCount < maxNodes) {
        const currentIdx = i % nodes.length;
        const current = nodes[currentIdx];

        if (!isOnCurve(current)) {
            i++;
            processedCount++;
            continue;
        }

        const points: Array<{ x: number; y: number }> = [
            { x: current.x, y: current.y }
        ];

        let j = (currentIdx + 1) % nodes.length;
        let offcurveCount = 0;
        while (offcurveCount < nodes.length) {
            if (j >= nodes.length && !closed) break;

            const node = nodes[j % nodes.length];
            if (isOffCurve(node)) {
                points.push({ x: node.x, y: node.y });
                j++;
                offcurveCount++;
            } else {
                points.push({ x: node.x, y: node.y });
                break;
            }
        }

        if (points.length === 2) {
            segments.push({ points, type: 'line' });
            i++;
            processedCount++;
        } else if (points.length === 3) {
            segments.push({ points, type: 'quadratic' });
            i += 1 + offcurveCount;
            processedCount += 1 + offcurveCount;
        } else if (points.length === 4) {
            segments.push({ points, type: 'cubic' });
            i += 1 + offcurveCount;
            processedCount += 1 + offcurveCount;
        } else {
            i += 1 + offcurveCount;
            processedCount += 1 + offcurveCount;
        }

        if (processedCount > nodes.length * 2) {
            break;
        }
    }

    return segments;
}

function collectTripletConstraints(
    paths: StrokePath[],
    collinearEpsilon: number
): TripletConstraint[] {
    const constraints: TripletConstraint[] = [];

    for (let pathIndex = 0; pathIndex < paths.length; pathIndex++) {
        const path = paths[pathIndex];
        const nodes = path.nodes;

        for (let i = 0; i < nodes.length; i++) {
            const onNode = nodes[i];
            if (isOffCurve(onNode)) continue;

            const prevIndex = i - 1;
            const nextIndex = i + 1;
            const prevNode = getNode(nodes, prevIndex, path.closed);
            const nextNode = getNode(nodes, nextIndex, path.closed);

            if (!prevNode || !nextNode) continue;
            if (!isOffCurve(prevNode) || !isOffCurve(nextNode)) continue;

            const v1x = prevNode.x - onNode.x;
            const v1y = prevNode.y - onNode.y;
            const v2x = nextNode.x - onNode.x;
            const v2y = nextNode.y - onNode.y;

            const cross = Math.abs(v1x * v2y - v1y * v2x);
            const scale = Math.max(
                1,
                Math.hypot(v1x, v1y) + Math.hypot(v2x, v2y)
            );
            if (cross > collinearEpsilon * scale) continue;

            const baseDir =
                normalize(nextNode.x - prevNode.x, nextNode.y - prevNode.y) ||
                normalize(v1x + v2x, v1y + v2y) ||
                normalize(1, 0);
            if (!baseDir) continue;

            let orientation: 'horizontal' | 'vertical' | 'diagonal' =
                'diagonal';
            if (Math.abs(baseDir.y) < 0.01) {
                orientation = 'horizontal';
            } else if (Math.abs(baseDir.x) < 0.01) {
                orientation = 'vertical';
            }

            constraints.push({
                pathIndex,
                onIndex: i,
                prevIndex: path.closed
                    ? ((prevIndex % nodes.length) + nodes.length) % nodes.length
                    : prevIndex,
                nextIndex: path.closed
                    ? ((nextIndex % nodes.length) + nodes.length) % nodes.length
                    : nextIndex,
                orientation,
                direction: baseDir
            });
        }
    }

    return constraints;
}

function collectAxisLineConstraints(
    paths: StrokePath[],
    lineAxisEpsilon: number
): AxisLineConstraint[] {
    const constraints: AxisLineConstraint[] = [];

    for (let pathIndex = 0; pathIndex < paths.length; pathIndex++) {
        const path = paths[pathIndex];
        const nodes = path.nodes;
        const maxIndex = path.closed ? nodes.length : nodes.length - 1;

        for (let i = 0; i < maxIndex; i++) {
            const j = (i + 1) % nodes.length;
            const a = nodes[i];
            const b = nodes[j];
            if (!a || !b) continue;
            if (isOffCurve(a) || isOffCurve(b)) continue;

            const dx = b.x - a.x;
            const dy = b.y - a.y;
            if (Math.abs(dx) < EPSILON && Math.abs(dy) < EPSILON) continue;

            if (Math.abs(dy) <= lineAxisEpsilon) {
                constraints.push({
                    pathIndex,
                    startIndex: i,
                    endIndex: j,
                    orientation: 'horizontal'
                });
            } else if (Math.abs(dx) <= lineAxisEpsilon) {
                constraints.push({
                    pathIndex,
                    startIndex: i,
                    endIndex: j,
                    orientation: 'vertical'
                });
            }
        }
    }

    return constraints;
}

function buildSegments(paths: StrokePath[]): SegmentInfo[] {
    const segments: SegmentInfo[] = [];
    for (let pathIndex = 0; pathIndex < paths.length; pathIndex++) {
        const path = paths[pathIndex];
        const pathSegments = processPathSegments({
            nodes: path.nodes,
            closed: path.closed
        });
        for (const segment of pathSegments) {
            segments.push({
                pathIndex,
                type: segment.type,
                points: segment.points
            });
        }
    }
    return segments;
}

function intersectionOnLineSegment(
    segA: { x: number; y: number },
    segB: { x: number; y: number },
    rayOrigin: { x: number; y: number },
    rayDir: { x: number; y: number }
): { x: number; y: number; distance: number } | null {
    const vx = segB.x - segA.x;
    const vy = segB.y - segA.y;
    const denom = rayDir.x * vy - rayDir.y * vx;

    if (Math.abs(denom) < EPSILON) {
        return null;
    }

    const wx = segA.x - rayOrigin.x;
    const wy = segA.y - rayOrigin.y;

    const t = (wx * vy - wy * vx) / denom;
    const u = (wx * rayDir.y - wy * rayDir.x) / denom;

    if (u < -1e-6 || u > 1 + 1e-6) return null;

    return {
        x: rayOrigin.x + rayDir.x * t,
        y: rayOrigin.y + rayDir.y * t,
        distance: t
    };
}

function collectLineIntersections(
    origin: { x: number; y: number },
    normal: { x: number; y: number },
    segments: SegmentInfo[],
    selfHitMinDistance: number,
    maxRayLength: number
): Array<{ x: number; y: number; t: number }> {
    const line = {
        p1: {
            x: origin.x - normal.x * maxRayLength,
            y: origin.y - normal.y * maxRayLength
        },
        p2: {
            x: origin.x + normal.x * maxRayLength,
            y: origin.y + normal.y * maxRayLength
        }
    };

    const intersections: Array<{ x: number; y: number; t: number }> = [];

    for (const segment of segments) {
        if (segment.type === 'line' && segment.points.length === 2) {
            const hit = intersectionOnLineSegment(
                segment.points[0],
                segment.points[1],
                origin,
                normal
            );
            if (!hit) continue;
            if (Math.abs(hit.distance) <= selfHitMinDistance) continue;
            if (Math.abs(hit.distance) > maxRayLength) continue;
            intersections.push({ x: hit.x, y: hit.y, t: hit.distance });
            continue;
        }

        try {
            const curve = new Bezier(segment.points as any);
            const results = curve.intersects(line as any);
            if (!Array.isArray(results)) continue;

            for (const result of results) {
                let point: { x: number; y: number } | null = null;
                if (typeof result === 'string') {
                    const parts = result.split('/');
                    const tLine = parseFloat(parts[1]);
                    if (!isFinite(tLine)) continue;
                    point = {
                        x: line.p1.x + (line.p2.x - line.p1.x) * tLine,
                        y: line.p1.y + (line.p2.y - line.p1.y) * tLine
                    };
                } else if (typeof result === 'number') {
                    const p = curve.get(result);
                    point = { x: p.x, y: p.y };
                }

                if (!point) continue;
                const dx = point.x - origin.x;
                const dy = point.y - origin.y;
                const t = dx * normal.x + dy * normal.y;
                if (Math.abs(t) <= selfHitMinDistance) continue;
                if (Math.abs(t) > maxRayLength) continue;
                intersections.push({ x: point.x, y: point.y, t });
            }
        } catch (_error) {
            continue;
        }
    }

    intersections.sort((a, b) => a.t - b.t);

    const unique: Array<{ x: number; y: number; t: number }> = [];
    for (const hit of intersections) {
        const duplicate = unique.some(
            (u) =>
                Math.abs(u.x - hit.x) < 0.001 &&
                Math.abs(u.y - hit.y) < 0.001 &&
                Math.abs(u.t - hit.t) < 0.001
        );
        if (!duplicate) {
            unique.push(hit);
        }
    }

    return unique;
}

function sampleSegment(segment: SegmentInfo, steps: number): PolySegment[] {
    if (segment.type === 'line') {
        if (segment.points.length !== 2) return [];
        return [
            {
                x1: segment.points[0].x,
                y1: segment.points[0].y,
                x2: segment.points[1].x,
                y2: segment.points[1].y
            }
        ];
    }

    try {
        const curve = new Bezier(segment.points as any);
        const polySegments: PolySegment[] = [];
        let prev = curve.get(0);
        for (let i = 1; i <= steps; i++) {
            const t = i / steps;
            const p = curve.get(t);
            polySegments.push({
                x1: prev.x,
                y1: prev.y,
                x2: p.x,
                y2: p.y
            });
            prev = p;
        }
        return polySegments;
    } catch (_error) {
        return [];
    }
}

function pointInEvenOddFill(
    x: number,
    y: number,
    polySegments: PolySegment[]
): boolean {
    let crossings = 0;
    for (const seg of polySegments) {
        const { x1, y1, x2, y2 } = seg;

        if (y1 > y === y2 > y) continue;
        const dx = x2 - x1;
        const dy = y2 - y1;
        if (Math.abs(dy) < EPSILON) continue;

        const xAtY = x1 + ((y - y1) * dx) / dy;
        if (xAtY > x) crossings++;
    }
    return (crossings & 1) === 1;
}

function pickOppositeHit(
    origin: { x: number; y: number },
    normal: { x: number; y: number },
    intersections: Array<{ x: number; y: number; t: number }>,
    polySegments: PolySegment[],
    fillProbeDistance: number
): { x: number; y: number; distance: number } | null {
    if (intersections.length === 0) return null;

    const probePos = pointInEvenOddFill(
        origin.x + normal.x * fillProbeDistance,
        origin.y + normal.y * fillProbeDistance,
        polySegments
    );
    const probeNeg = pointInEvenOddFill(
        origin.x - normal.x * fillProbeDistance,
        origin.y - normal.y * fillProbeDistance,
        polySegments
    );

    let insideSign = 0;
    if (probePos && !probeNeg) insideSign = 1;
    if (probeNeg && !probePos) insideSign = -1;

    if (insideSign > 0) {
        for (const hit of intersections) {
            if (hit.t > 0) {
                return { x: hit.x, y: hit.y, distance: hit.t };
            }
        }
    } else if (insideSign < 0) {
        for (let i = intersections.length - 1; i >= 0; i--) {
            const hit = intersections[i];
            if (hit.t < 0) {
                return { x: hit.x, y: hit.y, distance: Math.abs(hit.t) };
            }
        }
    }

    let nearest: { x: number; y: number; distance: number } | null = null;
    for (const hit of intersections) {
        const d = Math.abs(hit.t);
        if (!nearest || d < nearest.distance) {
            nearest = { x: hit.x, y: hit.y, distance: d };
        }
    }
    return nearest;
}

function estimateTangent(
    path: StrokePath,
    index: number
): { x: number; y: number } | null {
    const prev = getNode(path.nodes, index - 1, path.closed);
    const curr = getNode(path.nodes, index, path.closed);
    const next = getNode(path.nodes, index + 1, path.closed);
    if (!prev || !curr || !next) return null;

    const tangent = normalize(next.x - prev.x, next.y - prev.y);
    if (tangent) return tangent;

    return normalize(next.x - curr.x, next.y - curr.y);
}

function projectOnDirection(
    point: { x: number; y: number },
    origin: { x: number; y: number },
    direction: { x: number; y: number }
): { x: number; y: number } {
    const vx = point.x - origin.x;
    const vy = point.y - origin.y;
    const t = vx * direction.x + vy * direction.y;
    return {
        x: origin.x + direction.x * t,
        y: origin.y + direction.y * t
    };
}

function enforceAxisLineConstraints(
    paths: StrokePath[],
    constraints: AxisLineConstraint[]
): void {
    for (const constraint of constraints) {
        const path = paths[constraint.pathIndex];
        if (!path) continue;
        const a = path.nodes[constraint.startIndex];
        const b = path.nodes[constraint.endIndex];
        if (!a || !b) continue;

        if (constraint.orientation === 'horizontal') {
            const y = (a.y + b.y) * 0.5;
            a.y = y;
            b.y = y;
        } else {
            const x = (a.x + b.x) * 0.5;
            a.x = x;
            b.x = x;
        }
    }
}

function enforceTripletConstraints(
    paths: StrokePath[],
    constraints: TripletConstraint[],
    horizontalFactor: number,
    verticalFactor: number
): void {
    for (const constraint of constraints) {
        const path = paths[constraint.pathIndex];
        if (!path) continue;

        const onNode = path.nodes[constraint.onIndex];
        const prevNode = path.nodes[constraint.prevIndex];
        const nextNode = path.nodes[constraint.nextIndex];
        if (!onNode || !prevNode || !nextNode) continue;

        if (constraint.orientation === 'horizontal') {
            prevNode.y = onNode.y;
            nextNode.y = onNode.y;
            continue;
        }

        if (constraint.orientation === 'vertical') {
            prevNode.x = onNode.x;
            nextNode.x = onNode.x;
            continue;
        }

        const scaledDir = normalize(
            constraint.direction.x * horizontalFactor,
            constraint.direction.y * verticalFactor
        );
        const direction = scaledDir || constraint.direction;

        const projectedPrev = projectOnDirection(prevNode, onNode, direction);
        const projectedNext = projectOnDirection(nextNode, onNode, direction);

        prevNode.x = projectedPrev.x;
        prevNode.y = projectedPrev.y;
        nextNode.x = projectedNext.x;
        nextNode.y = projectedNext.y;
    }
}

export function applySkeletonStrokeThickness(
    paths: StrokePath[],
    horizontalFactor: number,
    verticalFactor: number,
    options: SkeletonStrokeOptions = {}
): number {
    if (!paths.length) return 0;

    const collinearEpsilon = options.collinearEpsilon ?? 0.01;
    const lineAxisEpsilon = options.lineAxisEpsilon ?? 0.01;
    const selfHitMinDistance = Math.max(0, options.selfHitMinDistance ?? 2);
    const fillProbeDistance = Math.max(0.25, options.fillProbeDistance ?? 1);
    const sampleSteps = Math.max(4, options.segmentSampleSteps ?? 16);

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const path of paths) {
        for (const node of path.nodes) {
            if (node.x < minX) minX = node.x;
            if (node.y < minY) minY = node.y;
            if (node.x > maxX) maxX = node.x;
            if (node.y > maxY) maxY = node.y;
        }
    }

    const autoMaxRayLength = Math.max(
        2000,
        Math.max(maxX - minX, maxY - minY) * 4
    );
    const maxRayLength = options.maxRayLength ?? autoMaxRayLength;

    const segments = buildSegments(paths);
    const polySegments: PolySegment[] = [];
    for (const segment of segments) {
        polySegments.push(...sampleSegment(segment, sampleSteps));
    }

    const tripletConstraints = collectTripletConstraints(
        paths,
        collinearEpsilon
    );
    const axisLineConstraints = collectAxisLineConstraints(
        paths,
        lineAxisEpsilon
    );

    const displacements: Array<Array<{ x: number; y: number }>> = paths.map(
        (path) => path.nodes.map(() => ({ x: 0, y: 0 }))
    );

    const originalPathBounds = paths.map((path) => getBounds(path.nodes));

    for (let pathIndex = 0; pathIndex < paths.length; pathIndex++) {
        const path = paths[pathIndex];

        for (let i = 0; i < path.nodes.length; i++) {
            const curr = path.nodes[i];
            if (!curr) continue;

            const tangent = estimateTangent(path, i);
            if (!tangent) continue;

            const normal = normalize(tangent.y, -tangent.x);
            if (!normal) continue;

            const intersections = collectLineIntersections(
                { x: curr.x, y: curr.y },
                normal,
                segments,
                selfHitMinDistance,
                maxRayLength
            );
            if (!intersections.length) continue;

            const hit = pickOppositeHit(
                { x: curr.x, y: curr.y },
                normal,
                intersections,
                polySegments,
                fillProbeDistance
            );
            if (!hit) continue;

            const vecX = hit.x - curr.x;
            const vecY = hit.y - curr.y;

            const targetX = vecX * horizontalFactor;
            const targetY = vecY * verticalFactor;

            displacements[pathIndex][i] = {
                x: -0.5 * (targetX - vecX),
                y: -0.5 * (targetY - vecY)
            };
        }
    }

    let changedNodes = 0;

    for (let pathIndex = 0; pathIndex < paths.length; pathIndex++) {
        const path = paths[pathIndex];
        for (let i = 0; i < path.nodes.length; i++) {
            const node = path.nodes[i];
            const delta = displacements[pathIndex][i];
            if (!node || !delta) continue;

            if (Math.abs(delta.x) > EPSILON || Math.abs(delta.y) > EPSILON) {
                node.x += delta.x;
                node.y += delta.y;
                changedNodes++;
            }
        }
    }

    enforceAxisLineConstraints(paths, axisLineConstraints);
    enforceTripletConstraints(
        paths,
        tripletConstraints,
        horizontalFactor,
        verticalFactor
    );

    // Rebalance per closed contour to avoid one-sided drift when applying
    // anisotropic thickness. This keeps expansion/contraction distributed
    // around the original contour center.
    for (let pathIndex = 0; pathIndex < paths.length; pathIndex++) {
        const path = paths[pathIndex];
        if (!path.closed || path.nodes.length < 2) continue;

        const before = originalPathBounds[pathIndex];
        const after = getBounds(path.nodes);

        let shiftX = 0;
        let shiftY = 0;

        if (horizontalFactor !== 1) {
            const beforeCenterX = (before.minX + before.maxX) * 0.5;
            const afterCenterX = (after.minX + after.maxX) * 0.5;
            shiftX = beforeCenterX - afterCenterX;
        }

        if (verticalFactor !== 1) {
            const beforeCenterY = (before.minY + before.maxY) * 0.5;
            const afterCenterY = (after.minY + after.maxY) * 0.5;
            shiftY = beforeCenterY - afterCenterY;
        }

        if (Math.abs(shiftX) <= EPSILON && Math.abs(shiftY) <= EPSILON) {
            continue;
        }

        for (const node of path.nodes) {
            node.x += shiftX;
            node.y += shiftY;
        }
    }

    return changedNodes;
}

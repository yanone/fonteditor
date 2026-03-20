/**
 * Babelfont Object Model
 *
 * This module provides an object-oriented facade over the raw babelfontJson data.
 * All objects are lightweight wrappers that read/write directly to the underlying
 * JSON structure using getters and setters - no data duplication.
 *
 * This allows:
 * - Type-safe object manipulation in JavaScript/TypeScript
 * - Rich methods on classes (e.g., path.insertNode())
 * - Direct synchronous access from Python via Pyodide's JsProxy system
 */

import type { Babelfont } from './babelfont';
import { setYPath } from './change-bridge-ydoc';
import { LayerDataNormalizer } from './layer-data-normalizer';
import { designspaceToUserspace } from './locations';
import { Bezier } from 'bezier-js';
import { Logger } from './logger';
import type { ChangeBridge } from './change-bridge';
import {
    interpolate_glyph,
    store_font
} from '../wasm-dist/babelfont_fontc_web';

const console = new Logger('BabelfontModel');

type Unsafe = ReturnType<typeof JSON.parse>;
type PathData = {
    nodes: Babelfont.Node[] | string;
    closed: boolean;
    format_specific?: Record<string, Unsafe>;
};

type ComponentData = {
    reference: string;
    transform: Babelfont.DecomposedAffine;
    location?: Record<string, number>;
    format_specific?: Record<string, Unsafe>;
};

type AnchorData = {
    x: number;
    y: number;
    name?: string;
    format_specific?: Record<string, Unsafe>;
};

type GuideData = {
    pos: Babelfont.Position;
    name?: string;
    color?: Babelfont.Color;
    format_specific?: Record<string, Unsafe>;
};

type SidebearingSide = 'left' | 'right';

type MetricsKeyResolution = {
    input: string;
    value: number | null;
    error: string | null;
    referencedGlyphNames: string[];
    isLocal: boolean;
    updateScope?: 'layer' | 'font';
    affectedGlyphNames?: string[];
};

type ParsedMetricsKey =
    | {
          kind: 'constant';
          value: number;
          referencedGlyphNames: string[];
      }
    | {
          kind: 'automatic-offset';
          delta: number;
          referencedGlyphNames: string[];
      }
    | {
          kind: 'reference';
          glyphName: string | null;
          mirror: boolean;
          offsetY: number | null;
          operation: { operator: '+' | '-' | '*' | '/'; value: number } | null;
          referencedGlyphNames: string[];
      };

const GLYPHS_GLYPH_METRIC_LEFT_KEY = 'metric_left';
const GLYPHS_GLYPH_METRIC_RIGHT_KEY = 'metric_right';
const GLYPHS_LAYER_METRIC_LEFT_KEY = 'com.schriftgestalt.Glyphs.metricLeft';
const GLYPHS_LAYER_METRIC_RIGHT_KEY = 'com.schriftgestalt.Glyphs.metricRight';
const GLYPHS_COMPONENT_ALIGNMENT_KEY = 'com.schriftgestalt.Glyphs.alignment';
const METRIC_UPDATE_EPSILON = 0.01;
let suppressModelRecordingDepth = 0;
let suppressMetricsKeyRecomputeDepth = 0;

type InterpolationFontCacheEntry = {
    serializedFont: string;
    version: number;
};

export function withSuppressedModelRecording<T>(fn: () => T): T {
    suppressModelRecordingDepth++;
    try {
        return fn();
    } finally {
        suppressModelRecordingDepth--;
    }
}

function withSuppressedMetricsKeyRecompute<T>(fn: () => T): T {
    suppressMetricsKeyRecomputeDepth++;
    try {
        return fn();
    } finally {
        suppressMetricsKeyRecomputeDepth--;
    }
}
const interpolationFontCache = new WeakMap<Font, InterpolationFontCacheEntry>();
const interpolationFontVersions = new WeakMap<Font, number>();

function getInterpolationFontVersion(font: Font): number {
    return interpolationFontVersions.get(font) || 0;
}

function markInterpolationFontDirty(font: Font | null | undefined): void {
    if (!font) {
        return;
    }

    interpolationFontVersions.set(font, getInterpolationFontVersion(font) + 1);
}

function getCurrentWindowFontModel(): Font | null {
    if (typeof window === 'undefined') {
        return null;
    }

    const currentFontModel = (window as Unsafe).currentFontModel;
    return currentFontModel instanceof Font ? currentFontModel : null;
}

function findFontForModelObject(
    modelObj: ModelBase | null | undefined
): Font | null {
    let current: unknown = modelObj;
    while (current) {
        if (current instanceof Font) {
            return current;
        }

        if (!(current instanceof ModelBase)) {
            return null;
        }

        current = current.parent();
    }

    return null;
}

function locationsMatch(
    left: Record<string, number> | undefined,
    right: Record<string, number> | undefined,
    axes: Axis[] | undefined
): boolean {
    if (!left || !right) {
        return false;
    }

    const tags = new Set<string>([
        ...(axes || []).map((axis) => axis.tag),
        ...Object.keys(left),
        ...Object.keys(right)
    ]);
    for (const tag of tags) {
        if ((left[tag] ?? 0) !== (right[tag] ?? 0)) {
            return false;
        }
    }

    return true;
}

function ensureFontStoredForInterpolation(font: Font): boolean {
    const version = getInterpolationFontVersion(font);
    const cachedEntry = interpolationFontCache.get(font);

    if (cachedEntry && cachedEntry.version === version) {
        return true;
    }

    try {
        const serializedFont = font.toJSONString();
        if (!cachedEntry || cachedEntry.serializedFont !== serializedFont) {
            store_font(serializedFont);
        }

        interpolationFontCache.set(font, {
            serializedFont,
            version
        });
        return true;
    } catch {
        return Boolean(cachedEntry);
    }
}

/**
 * DecomposedAffine transformation utilities
 * Based on babelfont-ts implementation
 */
export class DecomposedAffineTransform {
    /**
     * Convert DecomposedAffine to affine matrix [a, b, c, d, e, f]
     * Handles the transform order (Glyphs vs RestOfTheWorld)
     */
    static toAffine(
        decomposed: Babelfont.DecomposedAffine
    ): [number, number, number, number, number, number] {
        const translation = decomposed.translation || [0, 0];
        const scale = decomposed.scale || [1, 1];
        const rotation = decomposed.rotation || 0;
        const skew = decomposed.skew || [0, 0];
        const order = decomposed.order || 'RestOfTheWorld';

        // Helper to compose transformations
        const composeTransforms = (...transforms: number[][]): number[] => {
            return transforms.reduce(
                (acc, t) => {
                    const [a1, b1, c1, d1, e1, f1] = acc;
                    const [a2, b2, c2, d2, e2, f2] = t;
                    return [
                        a1 * a2 + c1 * b2,
                        b1 * a2 + d1 * b2,
                        a1 * c2 + c1 * d2,
                        b1 * c2 + d1 * d2,
                        a1 * e2 + c1 * f2 + e1,
                        b1 * e2 + d1 * f2 + f1
                    ];
                },
                [1, 0, 0, 1, 0, 0]
            );
        };

        // Individual transform matrices
        const translateMatrix = [1, 0, 0, 1, translation[0], translation[1]];
        const rotateMatrix = [
            Math.cos(rotation),
            Math.sin(rotation),
            -Math.sin(rotation),
            Math.cos(rotation),
            0,
            0
        ];
        const scaleMatrix = [scale[0], 0, 0, scale[1], 0, 0];
        const skewMatrix = [1, Math.tan(skew[1]), Math.tan(skew[0]), 1, 0, 0];

        if (order === 'Glyphs') {
            // Glyphs order: translate → skew → rotate → scale
            return composeTransforms(
                translateMatrix,
                skewMatrix,
                rotateMatrix,
                scaleMatrix
            ) as [number, number, number, number, number, number];
        } else {
            // RestOfTheWorld order: translate → rotate → scale → skew
            return composeTransforms(
                translateMatrix,
                rotateMatrix,
                scaleMatrix,
                skewMatrix
            ) as [number, number, number, number, number, number];
        }
    }

    /**
     * Create identity transform
     */
    static identity(
        order?: Babelfont.TransformOrder
    ): Babelfont.DecomposedAffine {
        return {
            translation: [0, 0],
            scale: [1, 1],
            rotation: 0,
            skew: [0, 0],
            order: order || ('RestOfTheWorld' as Babelfont.TransformOrder)
        };
    }

    /**
     * Convert an affine matrix [a, b, c, d, e, f] to DecomposedAffine.
     * Mirrors babelfont-rs canonical decomposition for legacy affine input.
     */
    static fromAffine(
        affine: number[],
        order?: Babelfont.TransformOrder
    ): Babelfont.DecomposedAffine {
        const [rawA, rawB, rawC, rawD, rawTx, rawTy] = [
            Number(affine[0]) || 0,
            Number(affine[1]) || 0,
            Number(affine[2]) || 0,
            Number(affine[3]) || 0,
            Number(affine[4]) || 0,
            Number(affine[5]) || 0
        ];

        let a = rawA;
        let b = rawB;
        const c = rawC;
        const d = rawD;
        const sxSign = a === 0 ? 1 : Math.sign(a);

        if (sxSign < 0) {
            a *= sxSign;
            b *= sxSign;
        }

        const delta = a * d - b * c;
        let rotation = 0;
        let scale: [number, number] = [0, 0];
        let skew: [number, number] = [0, 0];

        if (a !== 0 || b !== 0) {
            const r = Math.hypot(a, b);
            rotation = delta >= 0 ? Math.atan2(-b, a) : Math.atan2(b, a);
            scale = [r * sxSign, delta / r];
            skew = [Math.atan((a * c + b * d) / (r * r)) * sxSign, 0];
        } else if (c !== 0 || d !== 0) {
            const s = Math.hypot(c, d);
            rotation = delta >= 0 ? Math.atan2(c, d) : Math.atan2(-c, d);
            scale = [delta / s, s];
        }

        return {
            translation: [rawTx, rawTy],
            scale,
            rotation,
            skew,
            order: order || ('RestOfTheWorld' as Babelfont.TransformOrder)
        };
    }
}

/**
 * Mark the current font as dirty when data is modified
 */
function markFontDirty(): void {
    if (typeof window !== 'undefined' && window.fontManager?.currentFont) {
        window.fontManager.currentFont.markDirty();
        console.log('[BabelfontModel]', '✏️ Font marked as dirty');
    } else {
        console.warn(
            '[BabelfontModel]',
            '⚠️ Cannot mark font dirty - no currentFont'
        );
    }
}

/**
 * Record a property change in the ChangeBridge and mark the font dirty.
 * If no ChangeBridge is available, falls back to just marking dirty.
 */
function recordAndMarkDirty(
    modelObj: ModelBase,
    prop: string,
    oldVal: unknown,
    newVal: unknown
): void {
    if (suppressModelRecordingDepth > 0) {
        return;
    }

    markInterpolationFontDirty(findFontForModelObject(modelObj));

    const bridge = getChangeBridge();
    if (bridge) {
        const path = modelObj.getPath();
        bridge.recordChange(path, prop, oldVal, newVal);
        maybeRecomputeMetricsKeysForModelObject(modelObj, prop);
        return;
    }
    maybeRecomputeMetricsKeysForModelObject(modelObj, prop);
    markFontDirty();
}

function recordPathChangeAndMarkDirty(
    path: (string | number)[],
    oldVal: unknown,
    newVal: unknown
): void {
    if (suppressModelRecordingDepth > 0) {
        return;
    }

    markInterpolationFontDirty(getCurrentWindowFontModel());

    const bridge = getChangeBridge();
    if (bridge && path.length > 0) {
        bridge.recordChange(
            path.slice(0, -1),
            String(path[path.length - 1]),
            oldVal,
            newVal
        );
        maybeRecomputeMetricsKeysForPath(path);
        return;
    }
    maybeRecomputeMetricsKeysForPath(path);
    markFontDirty();
}

function recordAddAndMarkDirty(
    path: (string | number)[],
    value: unknown
): void {
    if (suppressModelRecordingDepth > 0) {
        return;
    }

    markInterpolationFontDirty(getCurrentWindowFontModel());

    const bridge = getChangeBridge();
    if (bridge) {
        bridge.recordAdd(path, cloneForHistory(value));
        maybeRecomputeMetricsKeysForPath(path);
        return;
    }
    maybeRecomputeMetricsKeysForPath(path);
    markFontDirty();
}

function recordRemoveAndMarkDirty(
    path: (string | number)[],
    oldValue: unknown
): void {
    if (suppressModelRecordingDepth > 0) {
        return;
    }

    markInterpolationFontDirty(getCurrentWindowFontModel());

    const bridge = getChangeBridge();
    if (bridge) {
        bridge.recordRemove(path, cloneForHistory(oldValue));
        maybeRecomputeMetricsKeysForPath(path);
        return;
    }
    maybeRecomputeMetricsKeysForPath(path);
    markFontDirty();
}

function shouldRecomputeMetricsKeysForPath(path: (string | number)[]): boolean {
    return path.includes('shapes');
}

function recomputeMetricsKeysForGlyph(
    font: Font | null,
    glyphName: string | null
): void {
    if (!font || !glyphName) {
        return;
    }

    font.recomputeMetricsKeys(new Set([glyphName]));
}

function maybeRecomputeMetricsKeysForModelObject(
    modelObj: ModelBase,
    prop: string
): void {
    if (suppressMetricsKeyRecomputeDepth > 0) {
        return;
    }

    const path = [...modelObj.getPath(), prop];
    if (!shouldRecomputeMetricsKeysForPath(path)) {
        return;
    }

    let current: unknown = modelObj;
    while (current) {
        if (current instanceof Layer) {
            const glyph = current.parent() as Glyph | null;
            const font = glyph?.parent() as Font | null;
            recomputeMetricsKeysForGlyph(font, glyph?.name || null);
            return;
        }

        if (!(current instanceof ModelBase)) {
            return;
        }

        current = current.parent();
    }
}

function maybeRecomputeMetricsKeysForPath(path: (string | number)[]): void {
    if (suppressMetricsKeyRecomputeDepth > 0) {
        return;
    }

    if (!shouldRecomputeMetricsKeysForPath(path)) {
        return;
    }

    const glyphIndex = path.indexOf('glyphs');
    if (glyphIndex === -1 || glyphIndex + 1 >= path.length) {
        return;
    }

    const glyphName = path[glyphIndex + 1];
    if (typeof glyphName !== 'string') {
        return;
    }

    if (typeof window === 'undefined') {
        return;
    }

    const font = (window as Unsafe).currentFontModel as Font | undefined;
    recomputeMetricsKeysForGlyph(font || null, glyphName);
}

function withBridgeTransaction<T>(label: string, fn: () => T): T {
    const bridge = getChangeBridge();
    if (!bridge) {
        return fn();
    }

    bridge.beginTransaction(label);
    try {
        return fn();
    } finally {
        bridge.endTransaction();
    }
}

function getGlyphMetricFormatSpecificKey(side: SidebearingSide): string {
    return side === 'left'
        ? GLYPHS_GLYPH_METRIC_LEFT_KEY
        : GLYPHS_GLYPH_METRIC_RIGHT_KEY;
}

function getLayerMetricFormatSpecificKey(side: SidebearingSide): string {
    return side === 'left'
        ? GLYPHS_LAYER_METRIC_LEFT_KEY
        : GLYPHS_LAYER_METRIC_RIGHT_KEY;
}

function normalizeMetricsKeyValue(
    value: string | undefined | null
): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }

    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
}

function localMetricsKeyStorageToPublic(
    value: string | undefined | null
): string | undefined {
    const normalized = normalizeMetricsKeyValue(value);
    if (!normalized) {
        return undefined;
    }

    return normalized.startsWith('=') ? `=${normalized}` : `==${normalized}`;
}

function localMetricsKeyPublicToStorage(
    value: string | undefined | null,
    font?: Font
): string | undefined {
    const normalized = normalizeMetricsKeyValue(value);
    if (!normalized) {
        return undefined;
    }

    const localBody = normalized.startsWith('==')
        ? normalized.slice(2)
        : normalized;
    if (!localBody) {
        return undefined;
    }

    if (localBody.startsWith('=')) {
        return localBody;
    }

    if (isPlainNumericText(localBody)) {
        return localBody;
    }

    if (font) {
        const glyphMatch = getGlyphNamePrefixMatch(font, localBody);
        if (glyphMatch && glyphMatch.rest === '') {
            return localBody;
        }
    }

    return `=${localBody}`;
}

function isPlainNumericText(value: string): boolean {
    return /^[+-]?\d+(?:\.\d+)?$/.test(value.trim());
}

function roundMetricValue(value: number): number {
    return Math.round(value);
}

function getModelFormatSpecific(
    modelObj: ModelBase
): Record<string, Unsafe> | undefined {
    return (modelObj.toJSON() as { format_specific?: Record<string, Unsafe> })
        .format_specific;
}

function ensureModelFormatSpecific(
    modelObj: ModelBase
): Record<string, Unsafe> {
    const data = modelObj.toJSON() as {
        format_specific?: Record<string, Unsafe>;
    };

    if (!data.format_specific) {
        const oldValue = data.format_specific;
        data.format_specific = {};
        recordAndMarkDirty(
            modelObj,
            'format_specific',
            oldValue,
            data.format_specific
        );
    }

    return data.format_specific;
}

function setFormatSpecificKey(
    modelObj: ModelBase,
    key: string,
    value: string | undefined
): void {
    const data = modelObj.toJSON() as {
        format_specific?: Record<string, Unsafe>;
    };

    if (value === undefined) {
        if (!data.format_specific || !(key in data.format_specific)) {
            return;
        }

        const oldValue = cloneForHistory(data.format_specific[key]);
        delete data.format_specific[key];

        const bridge = getChangeBridge();
        if (bridge) {
            bridge.recordRemove(
                [...modelObj.getPath(), 'format_specific', key],
                oldValue
            );
        }
        markInterpolationFontDirty(findFontForModelObject(modelObj));
        markFontDirty();
        return;
    }

    const formatSpecific = ensureModelFormatSpecific(modelObj);
    const oldValue = cloneForHistory(formatSpecific[key]);
    formatSpecific[key] = value;
    recordPathChangeAndMarkDirty(
        [...modelObj.getPath(), 'format_specific', key],
        oldValue,
        value
    );
}

function getGlyphNamePrefixMatch(
    font: Font,
    text: string
): { glyphName: string; rest: string } | null {
    const glyphNames = font.glyphs
        .map((glyph) => glyph.name)
        .filter(Boolean)
        .sort((a, b) => b.length - a.length);

    for (const glyphName of glyphNames) {
        if (text === glyphName) {
            return { glyphName, rest: '' };
        }

        const nextChar = text[glyphName.length];
        if (
            text.startsWith(glyphName) &&
            ['@', '+', '-', '*', '/'].includes(nextChar)
        ) {
            return { glyphName, rest: text.slice(glyphName.length) };
        }
    }

    return null;
}

function parseMetricsKey(
    font: Font,
    rawKey: string
): ParsedMetricsKey | { error: string } {
    let input = rawKey.trim();
    if (!input) {
        return { error: 'Empty metrics key' };
    }

    if (input.startsWith('==')) {
        input = input.slice(1);
    }

    if (isPlainNumericText(input)) {
        return {
            kind: 'constant',
            value: Number(input),
            referencedGlyphNames: []
        };
    }

    if (/^=\d+(?:\.\d+)?$/.test(input)) {
        return {
            kind: 'constant',
            value: Number(input.slice(1)),
            referencedGlyphNames: []
        };
    }

    if (/^=[+-]\d+(?:\.\d+)?$/.test(input)) {
        return {
            kind: 'automatic-offset',
            delta: Number(input.slice(1)),
            referencedGlyphNames: []
        };
    }

    let body = input;
    if (body.startsWith('=')) {
        body = body.slice(1);
    }

    let mirror = false;
    if (body.startsWith('|')) {
        mirror = true;
        body = body.slice(1);
    }

    if (!body) {
        return {
            kind: 'reference',
            glyphName: null,
            mirror,
            offsetY: null,
            operation: null,
            referencedGlyphNames: []
        };
    }

    const prefixMatch = getGlyphNamePrefixMatch(font, body);
    if (!prefixMatch) {
        return { error: `Unknown glyph reference in metrics key: ${rawKey}` };
    }

    let rest = prefixMatch.rest;
    let offsetY: number | null = null;
    let operation: { operator: '+' | '-' | '*' | '/'; value: number } | null =
        null;

    if (rest.startsWith('@')) {
        const offsetMatch = rest.match(/^@([+-]?\d+(?:\.\d+)?)(.*)$/);
        if (!offsetMatch) {
            return {
                error: `Invalid baseline offset in metrics key: ${rawKey}`
            };
        }
        offsetY = Number(offsetMatch[1]);
        rest = offsetMatch[2] || '';
    }

    if (rest) {
        const operationMatch = rest.match(/^([+\-*/])([+-]?\d+(?:\.\d+)?)$/);
        if (!operationMatch) {
            return {
                error: `Invalid calculation suffix in metrics key: ${rawKey}`
            };
        }
        operation = {
            operator: operationMatch[1] as '+' | '-' | '*' | '/',
            value: Number(operationMatch[2])
        };
    }

    return {
        kind: 'reference',
        glyphName: prefixMatch.glyphName,
        mirror,
        offsetY,
        operation,
        referencedGlyphNames: [prefixMatch.glyphName]
    };
}

function applyMetricOperation(
    value: number,
    operation: { operator: '+' | '-' | '*' | '/'; value: number } | null
): number | null {
    if (!operation) {
        return value;
    }

    switch (operation.operator) {
        case '+':
            return value + operation.value;
        case '-':
            return value - operation.value;
        case '*':
            return value * operation.value;
        case '/':
            if (Math.abs(operation.value) < 1e-8) {
                return null;
            }
            return value / operation.value;
    }
}

const MUTATING_ARRAY_METHODS = new Set([
    'copyWithin',
    'fill',
    'pop',
    'push',
    'reverse',
    'shift',
    'sort',
    'splice',
    'unshift'
]);

const liveMutableProxyTargets = new WeakMap<object, object>();
const readOnlyCollectionProxyCache = new WeakMap<object, object>();

function cloneForHistory<T>(value: T): T {
    if (value === undefined) {
        return value;
    }
    return JSON.parse(JSON.stringify(value));
}

function unwrapLiveMutableValue<T>(value: T): T {
    if (!value || typeof value !== 'object') {
        return value;
    }
    return (liveMutableProxyTargets.get(value as object) as T) ?? value;
}

function getLiveMutableValue<T>(
    modelObj: ModelBase,
    prop: string,
    value: T,
    getCurrentValue: () => T
): T {
    if (!value || typeof value !== 'object') {
        return value;
    }

    const localProxyCache = new WeakMap<object, object>();

    const wrap = (currentValue: unknown): unknown => {
        if (!currentValue || typeof currentValue !== 'object') {
            return currentValue;
        }

        const cachedProxy = localProxyCache.get(currentValue as object);
        if (cachedProxy) {
            return cachedProxy;
        }

        const proxy = new Proxy(currentValue as object, {
            get(target, key, receiver) {
                const result = Reflect.get(target, key, receiver);

                if (
                    Array.isArray(target) &&
                    typeof key === 'string' &&
                    MUTATING_ARRAY_METHODS.has(key) &&
                    typeof result === 'function'
                ) {
                    return (...args: unknown[]) => {
                        const oldValue = cloneForHistory(getCurrentValue());
                        const nextArgs = args.map(unwrapLiveMutableValue);
                        const operationResult = Reflect.apply(
                            result,
                            target,
                            nextArgs
                        );
                        recordAndMarkDirty(
                            modelObj,
                            prop,
                            oldValue,
                            cloneForHistory(getCurrentValue())
                        );
                        return operationResult;
                    };
                }

                if (typeof result === 'function') {
                    return (...args: unknown[]) =>
                        Reflect.apply(
                            result,
                            receiver,
                            args.map(unwrapLiveMutableValue)
                        );
                }

                return wrap(result);
            },

            set(target, key, nextValue, receiver) {
                const oldValue = cloneForHistory(getCurrentValue());
                const success = Reflect.set(
                    target,
                    key,
                    unwrapLiveMutableValue(nextValue),
                    receiver
                );
                recordAndMarkDirty(
                    modelObj,
                    prop,
                    oldValue,
                    cloneForHistory(getCurrentValue())
                );
                return success;
            },

            deleteProperty(target, key) {
                const oldValue = cloneForHistory(getCurrentValue());
                const success = Reflect.deleteProperty(target, key);
                recordAndMarkDirty(
                    modelObj,
                    prop,
                    oldValue,
                    cloneForHistory(getCurrentValue())
                );
                return success;
            }
        });

        liveMutableProxyTargets.set(proxy, currentValue as object);
        localProxyCache.set(currentValue as object, proxy);
        return proxy;
    };

    return wrap(value) as T;
}

function getPreciseLiveMutableValue<T>(
    pathPrefix: (string | number)[],
    value: T,
    getCurrentValue: () => T
): T {
    if (!value || typeof value !== 'object') {
        return value;
    }

    const localProxyCache = new WeakMap<object, object>();

    const wrap = (
        currentValue: unknown,
        currentPath: (string | number)[]
    ): unknown => {
        if (!currentValue || typeof currentValue !== 'object') {
            return currentValue;
        }

        const cachedProxy = localProxyCache.get(currentValue as object);
        if (cachedProxy) {
            return cachedProxy;
        }

        const proxy = new Proxy(currentValue as object, {
            get(target, key, receiver) {
                const result = Reflect.get(target, key, receiver);

                if (
                    Array.isArray(target) &&
                    typeof key === 'string' &&
                    MUTATING_ARRAY_METHODS.has(key) &&
                    typeof result === 'function'
                ) {
                    return (...args: unknown[]) => {
                        const nextArgs = args.map(unwrapLiveMutableValue);
                        return withBridgeTransaction(
                            `Edit ${String(currentPath[currentPath.length - 1] ?? 'array')}`,
                            () => {
                                const oldValue = cloneForHistory(target);
                                const operationResult = Reflect.apply(
                                    result,
                                    target,
                                    nextArgs
                                );
                                recordPathChangeAndMarkDirty(
                                    currentPath,
                                    oldValue,
                                    cloneForHistory(target)
                                );
                                return operationResult;
                            }
                        );
                    };
                }

                if (typeof result === 'function') {
                    return (...args: unknown[]) =>
                        Reflect.apply(
                            result,
                            receiver,
                            args.map(unwrapLiveMutableValue)
                        );
                }

                const nextPath =
                    Array.isArray(target) && isArrayIndexKey(key)
                        ? currentPath.concat(Number(key))
                        : currentPath.concat(String(key));
                return wrap(result, nextPath);
            },

            set(target, key, nextValue, receiver) {
                const unwrappedValue = unwrapLiveMutableValue(nextValue);

                if (Array.isArray(target)) {
                    const oldArray = cloneForHistory(target);
                    const success = Reflect.set(
                        target,
                        key,
                        unwrappedValue,
                        receiver
                    );

                    if (key === 'length') {
                        recordPathChangeAndMarkDirty(
                            currentPath,
                            oldArray,
                            cloneForHistory(target)
                        );
                        return success;
                    }

                    if (isArrayIndexKey(key)) {
                        const index = Number(key);
                        recordPathChangeAndMarkDirty(
                            currentPath.concat(index),
                            cloneForHistory(oldArray[index]),
                            cloneForHistory((target as unknown[])[index])
                        );
                        return success;
                    }

                    recordPathChangeAndMarkDirty(
                        currentPath.concat(String(key)),
                        cloneForHistory((oldArray as Unsafe)[key]),
                        cloneForHistory((target as Unsafe)[key])
                    );
                    return success;
                }

                const propPath = currentPath.concat(String(key));
                const oldValue = cloneForHistory(
                    Reflect.get(target, key, receiver)
                );
                const success = Reflect.set(
                    target,
                    key,
                    unwrappedValue,
                    receiver
                );
                recordPathChangeAndMarkDirty(
                    propPath,
                    oldValue,
                    cloneForHistory(Reflect.get(target, key, receiver))
                );
                return success;
            },

            deleteProperty(target, key) {
                if (Array.isArray(target)) {
                    const oldValue = cloneForHistory(target);
                    const success = Reflect.deleteProperty(target, key);
                    recordPathChangeAndMarkDirty(
                        currentPath,
                        oldValue,
                        cloneForHistory(target)
                    );
                    return success;
                }

                const propPath = currentPath.concat(String(key));
                const oldValue = cloneForHistory(Reflect.get(target, key));
                const success = Reflect.deleteProperty(target, key);
                const bridge = getChangeBridge();
                if (bridge) {
                    bridge.recordRemove(propPath, oldValue);
                }
                markInterpolationFontDirty(getCurrentWindowFontModel());
                markFontDirty();
                return success;
            }
        });

        liveMutableProxyTargets.set(proxy, currentValue as object);
        localProxyCache.set(currentValue as object, proxy);
        return proxy;
    };

    return wrap(getCurrentValue(), pathPrefix) as T;
}

function isArrayIndexKey(key: PropertyKey): boolean {
    return typeof key === 'string' && /^\d+$/.test(key);
}

function getReadOnlyCollectionValue<T>(value: T, errorMessage: string): T {
    if (!Array.isArray(value)) {
        return value;
    }

    const cachedProxy = readOnlyCollectionProxyCache.get(value as object);
    if (cachedProxy) {
        return cachedProxy as T;
    }

    const proxy = new Proxy(value as unknown as object, {
        get(target, key, receiver) {
            const result = Reflect.get(target, key, receiver);

            if (
                typeof key === 'string' &&
                MUTATING_ARRAY_METHODS.has(key) &&
                typeof result === 'function'
            ) {
                return () => {
                    throw new TypeError(errorMessage);
                };
            }

            if (typeof result === 'function') {
                return (...args: unknown[]) =>
                    Reflect.apply(result, target, args);
            }

            return result;
        },

        set(target, key, nextValue, receiver) {
            if (key === 'length' || isArrayIndexKey(key)) {
                throw new TypeError(errorMessage);
            }

            return Reflect.set(target, key, nextValue, receiver);
        },

        deleteProperty(target, key) {
            if (key === 'length' || isArrayIndexKey(key)) {
                throw new TypeError(errorMessage);
            }

            return Reflect.deleteProperty(target, key);
        }
    });

    readOnlyCollectionProxyCache.set(value as object, proxy);
    return proxy as T;
}

function syncNormalizedModelValue(
    modelObj: ModelBase,
    prop: string,
    value: unknown
): void {
    const bridge = getChangeBridge();
    if (!bridge) {
        return;
    }

    bridge.yDoc.transact(() => {
        setYPath(
            bridge.fontMap,
            [...modelObj.getPath(), prop],
            cloneForHistory(value)
        );
    });
}

/**
 * Get the global ChangeBridge instance, if available.
 */
function getChangeBridge(): ChangeBridge | null {
    if (typeof window !== 'undefined') {
        return (window as Unsafe).changeBridge ?? null;
    }
    return null;
}

function isDevelopmentMode(): boolean {
    if (typeof window === 'undefined') {
        return false;
    }

    return typeof window.isDevelopment === 'function'
        ? window.isDevelopment()
        : false;
}

function isTaggedLayerType(value: Unsafe): boolean {
    if (!value || typeof value !== 'object' || !('type' in value)) {
        return false;
    }

    const taggedValue = value as { type?: Unsafe; master?: Unsafe };

    if (taggedValue.type === 'FreeFloating') {
        return !('master' in taggedValue) || taggedValue.master === undefined;
    }

    if (
        (taggedValue.type === 'DefaultForMaster' ||
            taggedValue.type === 'AssociatedWithMaster') &&
        typeof taggedValue.master === 'string'
    ) {
        return true;
    }

    return false;
}

function assertTaggedLayerMaster(master: Unsafe, context: string): void {
    if (!isDevelopmentMode() || master === undefined) {
        return;
    }

    if (!isTaggedLayerType(master)) {
        let formatted = '[unserializable]';
        try {
            formatted = JSON.stringify(master);
        } catch (_error) {
            formatted = '[unserializable]';
        }

        throw new Error(
            `[BabelfontModel] Non-tagged layer.master detected at ${context}. Received: ${formatted}`
        );
    }
}

/**
 * Base class for model objects that wrap JSON data
 */
abstract class ModelBase<TData = Unsafe, TParent = Unsafe> {
    protected _data: TData;
    protected _parentObject: TParent | null = null;

    constructor(data: TData, parentObject: TParent | null = null) {
        this._data = data;
        this._parentObject = parentObject;
    }

    /**
     * Get the underlying JSON data for this object
     */
    toJSON(): TData {
        return this._data;
    }

    /**
     * Get the parent object in the hierarchy
     * @returns The parent object, or null if this is the root Font object
     */
    parent(): TParent | null {
        return this._parentObject;
    }

    /**
     * Get the path segment that identifies this object within its parent.
     * Override in subclasses. Returns an empty array for root objects.
     */
    getPathSegment(): (string | number)[] {
        return [];
    }

    /**
     * Build the full path from the font root to this object by walking
     * the parent chain.
     */
    getPath(): (string | number)[] {
        const segments: (string | number)[][] = [];
        let current: ModelBase | null = this as ModelBase;
        while (current) {
            const seg = current.getPathSegment();
            if (seg.length > 0) {
                segments.push(seg);
            }
            const p = current.parent();
            current = p instanceof ModelBase ? p : null;
        }
        segments.reverse();
        return segments.flat();
    }
}

/**
 * Base class for objects that are elements in an array
 */
abstract class ArrayElementBase<
    TData = Unsafe,
    TParent = Unsafe
> extends ModelBase<TData, TParent> {
    protected _parent: TData[];
    protected _index: number;

    constructor(
        parent: TData[],
        index: number,
        parentObject: TParent | null = null
    ) {
        super(parent[index], parentObject);
        this._parent = parent;
        this._index = index;
    }

    /**
     * Get current data (handles index changes)
     */
    protected get data(): TData {
        return this._parent[this._index];
    }

    /**
     * Update underlying data reference and mark font as dirty
     */
    protected set data(value: TData) {
        this._parent[this._index] = value;
        markInterpolationFontDirty(findFontForModelObject(this));
        markFontDirty();
    }
}

/**
 * Point in a path
 */
export class Node extends ArrayElementBase<Babelfont.Node, Path> {
    getPathSegment(): (string | number)[] {
        return ['nodes', this._index];
    }

    get x(): number {
        return this.data.x;
    }

    set x(value: number) {
        const old = this.data.x;
        this.data.x = value;
        recordAndMarkDirty(this, 'x', old, value);
    }

    get y(): number {
        return this.data.y;
    }

    set y(value: number) {
        const old = this.data.y;
        this.data.y = value;
        recordAndMarkDirty(this, 'y', old, value);
    }

    get nodetype(): Babelfont.NodeType {
        return this.data.nodetype;
    }

    set nodetype(value: Babelfont.NodeType) {
        const old = this.data.nodetype;
        this.data.nodetype = value;
        recordAndMarkDirty(this, 'nodetype', old, value);
    }

    get smooth(): boolean | undefined {
        return this.data.smooth;
    }

    set smooth(value: boolean | undefined) {
        const old = this.data.smooth;
        this.data.smooth = value;
        recordAndMarkDirty(this, 'smooth', old, value);
    }

    toString(): string {
        const smooth = this.smooth ? ' smooth' : '';
        return `<Node (${this.x}, ${this.y}) ${this.nodetype}${smooth}>`;
    }
}

/**
 * Path (contour) in a layer
 */
export class Path extends ArrayElementBase<PathData, Layer | Shape> {
    private _nodeWrappers: Node[] | null = null;

    getPathSegment(): (string | number)[] {
        // When wrapped by Shape.asPath(), Shape already provides ['shapes', idx]
        if (this._parentObject instanceof Shape) return [];
        return ['shapes', this._index];
    }

    private ensureNodesArray(): Babelfont.Node[] {
        let normalizedNodes: Babelfont.Node[] | null = null;

        if (typeof this.data.nodes === 'string') {
            normalizedNodes = Path.parseNodesString(this.data.nodes);
        }

        if (!normalizedNodes && !Array.isArray(this.data.nodes)) {
            normalizedNodes = [];
        }

        if (normalizedNodes) {
            this.data.nodes = normalizedNodes;
            this._nodeWrappers = null;
            syncNormalizedModelValue(this, 'nodes', normalizedNodes);
        }

        if (!Array.isArray(this.data.nodes)) {
            this.data.nodes = [];
        }

        return this.data.nodes;
    }

    get nodes(): Node[] {
        const nodeArray = this.ensureNodesArray();

        // Create wrapper objects if needed
        if (
            !this._nodeWrappers ||
            this._nodeWrappers.length !== nodeArray.length
        ) {
            this._nodeWrappers = nodeArray.map(
                (_: Babelfont.Node, i: number) => new Node(nodeArray, i, this)
            );
        }
        return getReadOnlyCollectionValue(
            this._nodeWrappers!,
            'Path.nodes is a read-only collection view. Use appendNode(), insertNode(), or removeNode() for structural edits.'
        );
    }

    set nodes(value: Babelfont.Node[]) {
        const old = this.data.nodes;
        this.data.nodes = value;
        this._nodeWrappers = null; // Invalidate cache
        recordAndMarkDirty(this, 'nodes', old, value);
    }

    /**
     * Parse nodes from babelfont-rs string format
     * Format: "x1 y1 type x2 y2 type ..."
     * Types: m, l, o, c, q (with optional 's' suffix for smooth)
     */
    static parseNodesString(nodesStr: string): Babelfont.Node[] {
        const trimmed = nodesStr.trim();
        if (!trimmed) return [];

        const tokens = trimmed.split(/\s+/);
        const nodesArray: Babelfont.Node[] = [];

        for (let i = 0; i + 2 < tokens.length; i += 3) {
            const typeStr = tokens[i + 2];
            const smooth = typeStr.endsWith('s');
            const nodetype = Path.mapNodeType(
                smooth ? typeStr.slice(0, -1) : typeStr
            );

            const node: Babelfont.Node = {
                x: parseFloat(tokens[i]),
                y: parseFloat(tokens[i + 1]),
                nodetype: nodetype
            };

            if (smooth) {
                node.smooth = true;
            }

            nodesArray.push(node);
        }

        return nodesArray;
    }

    /**
     * Map short node type to Babelfont.NodeType
     */
    static mapNodeType(shortType: string): Babelfont.NodeType {
        const map = {
            m: 'Move' as const,
            l: 'Line' as const,
            o: 'OffCurve' as const,
            c: 'Curve' as const,
            q: 'QCurve' as const
        };
        return (map[shortType as keyof typeof map] ||
            'Line') as Babelfont.NodeType;
    }

    /**
     * Convert nodes array back to compact string format for serialization
     */
    static nodesToString(nodes: Babelfont.Node[]): string {
        const tokens: string[] = [];

        for (const node of nodes) {
            // Ensure we have valid numbers
            const x =
                typeof node.x === 'number'
                    ? node.x
                    : parseFloat(String(node.x));
            const y =
                typeof node.y === 'number'
                    ? node.y
                    : parseFloat(String(node.y));

            if (isNaN(x) || isNaN(y)) {
                console.error('[Path]', 'Invalid node coordinates:', node);
                continue;
            }

            tokens.push(x.toString());
            tokens.push(y.toString());

            // Get node type - check both 'nodetype' (object model) and 'type' (normalizer)
            const nodeType = (node as Unsafe).nodetype || (node as Unsafe).type;

            // Map nodetype back to short form
            const typeMap: Record<string, string> = {
                Move: 'm',
                Line: 'l',
                OffCurve: 'o',
                Curve: 'c',
                QCurve: 'q',
                // Also handle short forms directly (from normalizer)
                m: 'm',
                l: 'l',
                o: 'o',
                c: 'c',
                q: 'q',
                ms: 'm',
                ls: 'l',
                os: 'o',
                cs: 'c',
                qs: 'q'
            };

            let typeStr = typeMap[nodeType] || 'l';

            // Handle smooth flag - check if it's in the type string or separate property
            const isSmooth =
                node.smooth ||
                (typeof nodeType === 'string' && nodeType.endsWith('s'));
            if (isSmooth) {
                typeStr += 's';
            }

            tokens.push(typeStr);
        }

        return tokens.join(' ');
    }

    get closed(): boolean {
        return !!this.data.closed;
    }

    set closed(value: boolean) {
        const old = this.data.closed;
        this.data.closed = value;
        recordAndMarkDirty(this, 'closed', old, value);
    }

    get format_specific(): Record<string, Unsafe> | undefined {
        return getLiveMutableValue(
            this,
            'format_specific',
            this.data.format_specific,
            () => this.data.format_specific
        );
    }

    set format_specific(value: Record<string, Unsafe> | undefined) {
        const old = this.data.format_specific;
        this.data.format_specific = value;
        recordAndMarkDirty(this, 'format_specific', old, value);
    }

    /**
     * Insert a node at the specified index
     * @example
     * path.insertNode(1, 150, 250, "Line")  # Insert at index 1
     */
    insertNode(
        index: number,
        x: number,
        y: number,
        nodetype: Babelfont.NodeType = 'Line' as Babelfont.NodeType,
        smooth?: boolean
    ): Node {
        const nodeArray = this.ensureNodesArray();
        const nodeData: Babelfont.Node = { x, y, nodetype };
        if (smooth !== undefined) {
            nodeData.smooth = smooth;
        }

        nodeArray.splice(index, 0, nodeData);
        this._nodeWrappers = null; // Invalidate cache
        recordAddAndMarkDirty([...this.getPath(), 'nodes', index], nodeData);
        return new Node(nodeArray, index, this);
    }

    /**
     * Remove a node at the specified index
     * @example
     * path.removeNode(0)  # Remove first node
     */
    removeNode(index: number): void {
        const nodeArray = this.ensureNodesArray();
        const removedNode = nodeArray[index];
        if (removedNode === undefined) {
            return;
        }

        nodeArray.splice(index, 1);
        this._nodeWrappers = null; // Invalidate cache
        recordRemoveAndMarkDirty(
            [...this.getPath(), 'nodes', index],
            removedNode
        );
    }

    /**
     * Append a node to the end of the path
     * @example
     * path.appendNode(100, 200, "Line")
     * path.appendNode(300, 400, "Curve", smooth=True)
     */
    appendNode(
        x: number,
        y: number,
        nodetype: Babelfont.NodeType = 'Line' as Babelfont.NodeType,
        smooth?: boolean
    ): Node {
        return this.insertNode(
            this.ensureNodesArray().length,
            x,
            y,
            nodetype,
            smooth
        );
    }

    toString(): string {
        const closedStr = this.closed ? 'closed' : 'open';
        const nodeCount = Array.isArray(this.data.nodes)
            ? this.data.nodes.length
            : 0;
        return `<Path ${closedStr} ${nodeCount} nodes>`;
    }
}

/**
 * Component reference to another glyph
 */
export class Component extends ArrayElementBase<ComponentData, Shape> {
    getPathSegment(): (string | number)[] {
        // When wrapped by Shape.asComponent(), Shape already provides ['shapes', idx]
        if (this._parentObject instanceof Shape) return [];
        return ['shapes', this._index];
    }

    get reference(): string {
        return this.data.reference;
    }

    set reference(value: string) {
        const old = this.data.reference;
        this.data.reference = value;
        recordAndMarkDirty(this, 'reference', old, value);
    }

    get transform(): Babelfont.DecomposedAffine {
        return getLiveMutableValue(
            this,
            'transform',
            this.data.transform,
            () => this.data.transform
        );
    }

    set transform(value: Babelfont.DecomposedAffine) {
        const old = this.data.transform;
        this.data.transform = value;
        recordAndMarkDirty(this, 'transform', old, value);
    }

    get location(): Record<string, number> | undefined {
        return getLiveMutableValue(
            this,
            'location',
            this.data.location,
            () => this.data.location
        );
    }

    set location(value: Record<string, number> | undefined) {
        const old = this.data.location;
        this.data.location = value;
        recordAndMarkDirty(this, 'location', old, value);
    }

    get format_specific(): Record<string, Unsafe> | undefined {
        return getLiveMutableValue(
            this,
            'format_specific',
            this.data.format_specific,
            () => this.data.format_specific
        );
    }

    set format_specific(value: Record<string, Unsafe> | undefined) {
        const old = this.data.format_specific;
        this.data.format_specific = value;
        recordAndMarkDirty(this, 'format_specific', old, value);
    }

    /**
     * Convert transform to affine matrix array [a, b, c, d, e, f]
     * Uses the proper DecomposedAffineTransform utility
     */
    toAffineArray(): number[] {
        return DecomposedAffineTransform.toAffine(
            this.transform || DecomposedAffineTransform.identity()
        );
    }

    toString(): string {
        const transform = this.transform
            ? ` transform=${JSON.stringify(this.transform)}`
            : '';
        return `<Component ref="${this.reference}"${transform}>`;
    }

    /**
     * Get all paths from this component with transforms applied recursively
     * Automatically determines the correct master by walking up the parent chain
     * @returns Array of transformed path data objects
     */
    getTransformedPaths(): Babelfont.Path[] {
        const paths: Babelfont.Path[] = [];
        const componentTransform =
            this.transform ||
            ({
                translation: [0, 0],
                scale: [1, 1],
                rotation: 0,
                skew: [0, 0]
            } as Babelfont.DecomposedAffine);

        // Get the Font object to look up component glyphs
        // Component -> Shape -> Layer -> Glyph -> Font
        const shape = this.parent() as Shape;
        if (!shape) return paths;

        const layer = shape.parent() as Layer;
        if (!layer) return paths;

        const glyph = layer.parent() as Glyph;
        if (!glyph) return paths;

        const font = glyph.parent() as Font;
        if (!font) return paths;

        // Get the master ID from the layer
        const masterId = (layer.master as Unsafe)?.master;

        // Helper to transform a node
        const transformNode = (node: Unsafe, transform: number[]): Unsafe => {
            const [a, b, c, d, tx, ty] = transform;
            const result: Unsafe = {
                x: a * node.x + c * node.y + tx,
                y: b * node.x + d * node.y + ty
            };
            if (node.type !== undefined) result.type = node.type;
            if (node.nodetype !== undefined) result.nodetype = node.nodetype;
            if (node.smooth !== undefined) result.smooth = node.smooth;
            return result;
        };

        // Helper to combine two transform matrices
        const combineTransforms = (t1: number[], t2: number[]): number[] => {
            const [a1, b1, c1, d1, tx1, ty1] = t1;
            const [a2, b2, c2, d2, tx2, ty2] = t2;
            return [
                a1 * a2 + c1 * b2,
                b1 * a2 + d1 * b2,
                a1 * c2 + c1 * d2,
                b1 * c2 + d1 * d2,
                a1 * tx2 + c1 * ty2 + tx1,
                b1 * tx2 + d1 * ty2 + ty1
            ];
        };

        // Look up the component glyph and get the matching layer
        const componentGlyph = font.findGlyph(this.reference);
        if (!componentGlyph || !componentGlyph.layers) return paths;

        let componentLayer;
        if (masterId) {
            componentLayer = componentGlyph.layers.find(
                (l) => l.master && (l.master as Unsafe).master === masterId
            );
        }
        if (!componentLayer) {
            componentLayer = componentGlyph.layers[0];
        }
        if (!componentLayer) return paths;

        // Process shapes from the component layer
        if (componentLayer.shapes) {
            for (const shape of componentLayer.shapes) {
                if (shape.isComponent()) {
                    // Recursively get paths from nested components
                    const nestedComponent = shape.asComponent();
                    const nestedPaths = nestedComponent.getTransformedPaths();

                    // Apply this component's transform to all nested paths
                    const transformArray =
                        DecomposedAffineTransform.toAffine(componentTransform);
                    for (const nestedPath of nestedPaths) {
                        const transformedNodes = nestedPath.nodes.map(
                            (node: Unsafe) =>
                                transformNode(node, transformArray)
                        );
                        paths.push({
                            nodes: transformedNodes,
                            closed: nestedPath.closed
                        });
                    }
                } else if (shape.isPath()) {
                    // Transform the path nodes
                    const pathData = shape.asPath().toJSON();
                    let nodes = pathData.nodes;

                    // Parse nodes if they're a string
                    if (typeof nodes === 'string') {
                        nodes = LayerDataNormalizer.parseNodes(nodes);
                    }

                    if (nodes && Array.isArray(nodes) && nodes.length > 0) {
                        const transformArray =
                            DecomposedAffineTransform.toAffine(
                                componentTransform
                            );
                        const transformedNodes = nodes.map((node: Unsafe) =>
                            transformNode(node, transformArray)
                        );
                        paths.push({
                            nodes: transformedNodes,
                            closed:
                                pathData.closed !== undefined
                                    ? pathData.closed
                                    : true
                        });
                    }
                }
            }
        }

        return paths;
    }
}

/**
 * Anchor point in a layer
 */
export class Anchor extends ArrayElementBase<AnchorData, Layer> {
    getPathSegment(): (string | number)[] {
        return ['anchors', this._index];
    }

    get x(): number {
        return this.data.x;
    }

    set x(value: number) {
        const old = this.data.x;
        this.data.x = value;
        recordAndMarkDirty(this, 'x', old, value);
    }

    get y(): number {
        return this.data.y;
    }

    set y(value: number) {
        const old = this.data.y;
        this.data.y = value;
        recordAndMarkDirty(this, 'y', old, value);
    }

    get name(): string | undefined {
        return this.data.name;
    }

    set name(value: string | undefined) {
        const old = this.data.name;
        this.data.name = value;
        recordAndMarkDirty(this, 'name', old, value);
    }

    get format_specific(): Record<string, Unsafe> | undefined {
        return getLiveMutableValue(
            this,
            'format_specific',
            this.data.format_specific,
            () => this.data.format_specific
        );
    }

    set format_specific(value: Record<string, Unsafe> | undefined) {
        const old = this.data.format_specific;
        this.data.format_specific = value;
        recordAndMarkDirty(this, 'format_specific', old, value);
    }

    toString(): string {
        const name = this.name ? ` "${this.name}"` : '';
        return `<Anchor${name} (${this.x}, ${this.y})>`;
    }
}

/**
 * Guideline in a layer or master
 */
export class Guide extends ArrayElementBase<GuideData, Layer | Master> {
    getPathSegment(): (string | number)[] {
        return ['guides', this._index];
    }

    get pos(): Babelfont.Position {
        return getLiveMutableValue(
            this,
            'pos',
            this.data.pos,
            () => this.data.pos
        );
    }

    set pos(value: Babelfont.Position) {
        const old = this.data.pos;
        this.data.pos = value;
        recordAndMarkDirty(this, 'pos', old, value);
    }

    get name(): string | undefined {
        return this.data.name;
    }

    set name(value: string | undefined) {
        const old = this.data.name;
        this.data.name = value;
        recordAndMarkDirty(this, 'name', old, value);
    }

    get color(): Babelfont.Color | undefined {
        return getLiveMutableValue(
            this,
            'color',
            this.data.color,
            () => this.data.color
        );
    }

    set color(value: Babelfont.Color | undefined) {
        const old = this.data.color;
        this.data.color = value;
        recordAndMarkDirty(this, 'color', old, value);
    }

    get format_specific(): Record<string, Unsafe> | undefined {
        return getLiveMutableValue(
            this,
            'format_specific',
            this.data.format_specific,
            () => this.data.format_specific
        );
    }

    set format_specific(value: Record<string, Unsafe> | undefined) {
        const old = this.data.format_specific;
        this.data.format_specific = value;
        recordAndMarkDirty(this, 'format_specific', old, value);
    }

    toString(): string {
        const name = this.name ? ` "${this.name}"` : '';
        return `<Guide${name} pos=${JSON.stringify(this.pos)}>`;
    }
}

/**
 * Shape wrapper that can contain either a Component or a Path
 */
export class Shape extends ArrayElementBase {
    getPathSegment(): (string | number)[] {
        return ['shapes', this._index];
    }

    /**
     * Check if this shape is a component
     */
    isComponent(): boolean {
        // Handle both nested {Component: {...}} and flat {reference: ...} formats
        return 'Component' in this.data || 'reference' in this.data;
    }

    /**
     * Check if this shape is a path
     */
    isPath(): boolean {
        // Handle both nested {Path: {...}} and flat {nodes: ...} formats
        return 'Path' in this.data || 'nodes' in this.data;
    }

    /**
     * Get as Component (throws if not a component)
     */
    asComponent(): Component {
        if (!this.isComponent()) {
            throw new Error('Shape is not a Component');
        }
        // Handle both nested {Component: {...}} and flat {reference: ...} formats
        const componentData =
            'Component' in this.data ? this.data.Component : this.data;
        // Create a fake array with single element to satisfy Component's constructor
        const fakeArray = [componentData];
        Object.defineProperty(fakeArray, '0', {
            get: () =>
                'Component' in this.data ? this.data.Component : this.data,
            set: (value) => {
                if ('Component' in this.data) {
                    this.data.Component = value;
                } else {
                    // Update the entire shape data for flat format
                    Object.assign(this.data, value);
                }
            }
        });
        return new Component(fakeArray as Unsafe, 0, this);
    }

    /**
     * Get as Path (throws if not a path)
     */
    asPath(): Path {
        if (!this.isPath()) {
            throw new Error('Shape is not a Path');
        }
        // Handle both nested {Path: {...}} and flat {nodes: ...} formats
        const pathData = 'Path' in this.data ? this.data.Path : this.data;
        // Create a fake array with single element to satisfy Path's constructor
        const fakeArray = [pathData];
        Object.defineProperty(fakeArray, '0', {
            get: () => ('Path' in this.data ? this.data.Path : this.data),
            set: (value) => {
                if ('Path' in this.data) {
                    this.data.Path = value;
                } else {
                    // Update the entire shape data for flat format
                    Object.assign(this.data, value);
                }
            }
        });
        return new Path(fakeArray as Unsafe, 0, this);
    }

    toString(): string {
        if (this.isComponent()) {
            return `<Shape:${this.asComponent().toString()}>`;
        } else if (this.isPath()) {
            return `<Shape:${this.asPath().toString()}>`;
        }
        return '<Shape Unsafe>';
    }
}

/**
 * Layer in a glyph representing a master or intermediate design
 */
export class Layer extends ArrayElementBase {
    private _shapeWrappers: Shape[] | null = null;
    private _anchorWrappers: Anchor[] | null = null;
    private _guideWrappers: Guide[] | null = null;

    private getFont(): Font | undefined {
        const glyph = this.parent() as Glyph;
        return glyph?.parent() as Font | undefined;
    }

    private getLocalSidebearingKey(side: SidebearingSide): string | undefined {
        return normalizeMetricsKeyValue(
            getModelFormatSpecific(this)?.[
                getLayerMetricFormatSpecificKey(side)
            ] as string | undefined
        );
    }

    private setLocalSidebearingKey(
        side: SidebearingSide,
        value: string | undefined
    ): void {
        setFormatSpecificKey(
            this,
            getLayerMetricFormatSpecificKey(side),
            value
        );
    }

    private hasLocalSidebearingKey(side: SidebearingSide): boolean {
        return this.getLocalSidebearingKey(side) !== undefined;
    }

    private getEffectiveSidebearingKey(
        side: SidebearingSide
    ): string | undefined {
        return (
            this.getLocalSidebearingKey(side) ??
            this.getGlobalSidebearingKey(side)
        );
    }

    private clearEffectiveSidebearingKey(side: SidebearingSide): void {
        if (this.hasLocalSidebearingKey(side)) {
            this.setLocalSidebearingKey(side, undefined);
            return;
        }

        const glyph = this.parent() as Glyph;
        if (!glyph) {
            return;
        }

        if (side === 'left') {
            glyph.leftMetricsKey = undefined;
        } else {
            glyph.rightMetricsKey = undefined;
        }
    }

    private setEffectiveSidebearingKey(
        side: SidebearingSide,
        value: string | undefined,
        forceLocal = false
    ): void {
        const normalizedValue = normalizeMetricsKeyValue(value);
        const glyph = this.parent() as Glyph;

        if (forceLocal) {
            this.setLocalSidebearingKey(side, normalizedValue);
            return;
        }

        if (this.hasLocalSidebearingKey(side)) {
            this.setLocalSidebearingKey(side, undefined);
        }

        if (!glyph) {
            return;
        }

        if (side === 'left') {
            glyph.leftMetricsKey = normalizedValue;
        } else {
            glyph.rightMetricsKey = normalizedValue;
        }
    }

    private getDirectSidebearing(side: SidebearingSide): number {
        if (side === 'left') {
            const bbox = this.getBoundingBox(false);
            if (!bbox) {
                return 0;
            }
            return roundMetricValue(bbox.minX);
        }

        const bbox = this.getBoundingBox(false);
        if (!bbox) {
            return roundMetricValue(this.width);
        }
        return roundMetricValue(this.width - bbox.maxX);
    }

    setDirectSidebearing(side: SidebearingSide, value: number): void {
        if (side === 'left') {
            const currentLsb = this.getDirectSidebearing('left');
            const currentRsb = this.getDirectSidebearing('right');
            const offset = value - currentLsb;

            if (offset === 0) {
                return;
            }

            const layerData = this.toJSON();
            const oldShapes = cloneForHistory(layerData.shapes || []);
            const oldAnchors = cloneForHistory(layerData.anchors || []);
            const oldWidth = layerData.width;

            withSuppressedMetricsKeyRecompute(() => {
                withSuppressedModelRecording(() => {
                    for (const shape of this.shapes || []) {
                        if (shape.isPath()) {
                            for (const node of shape.asPath().nodes) {
                                node.x += offset;
                            }
                            continue;
                        }

                        if (shape.isComponent()) {
                            const component = shape.asComponent();
                            if (!component.transform) {
                                component.transform =
                                    DecomposedAffineTransform.identity();
                            }
                            if (!component.transform.translation) {
                                component.transform.translation = [0, 0];
                            }
                            component.transform.translation[0] += offset;
                        }
                    }

                    for (const anchor of this.anchors || []) {
                        anchor.x += offset;
                    }

                    const bbox = this.getBoundingBox(false);
                    this.width = bbox
                        ? roundMetricValue(
                              roundMetricValue(bbox.maxX) + currentRsb
                          )
                        : roundMetricValue(value + currentRsb);
                });

                recordAndMarkDirty(
                    this,
                    'shapes',
                    oldShapes,
                    cloneForHistory(layerData.shapes || [])
                );
                if (oldAnchors.length || (layerData.anchors || []).length) {
                    recordAndMarkDirty(
                        this,
                        'anchors',
                        oldAnchors,
                        cloneForHistory(layerData.anchors || [])
                    );
                }
                recordAndMarkDirty(this, 'width', oldWidth, layerData.width);
            });
            return;
        }

        const bbox = this.getBoundingBox(false);
        const oldWidth = this.toJSON().width;
        if (!bbox) {
            this.toJSON().width = roundMetricValue(value);
        } else {
            this.toJSON().width = roundMetricValue(
                roundMetricValue(bbox.maxX) + value
            );
        }
        recordAndMarkDirty(this, 'width', oldWidth, this.toJSON().width);
    }

    isAutomaticAlignedLayer(): boolean {
        const components = (this.shapes || []).filter((shape) =>
            shape.isComponent()
        );
        if (components.length === 0) {
            return false;
        }

        return components.every((shape) => {
            const component = shape.asComponent();
            return (
                getModelFormatSpecific(component)?.[
                    GLYPHS_COMPONENT_ALIGNMENT_KEY
                ] === 0
            );
        });
    }

    private getPrimaryAutoAlignedComponentLayer(): Layer | undefined {
        const firstComponentShape = (this.shapes || []).find((shape) =>
            shape.isComponent()
        );
        if (!firstComponentShape) {
            return undefined;
        }

        const reference = firstComponentShape.asComponent().reference;
        if (!reference) {
            return undefined;
        }

        return this.getMetricsReferenceLayerOnGlyph(reference);
    }

    private getEffectiveDesignspaceLocation():
        | Record<string, number>
        | undefined {
        if (this.location && Object.keys(this.location).length > 0) {
            return this.location;
        }

        const font = this.getFont();
        const masterId = this.getMasterId();
        if (!font || !masterId) {
            return undefined;
        }

        return font.findMaster(masterId)?.location;
    }

    private getInterpolatedLayerOnGlyph(glyphName: string): Layer | undefined {
        const font = this.getFont();
        const targetGlyph = font?.findGlyph(glyphName);
        const designspaceLocation = this.getEffectiveDesignspaceLocation();
        if (!font || !targetGlyph || !designspaceLocation) {
            return undefined;
        }

        if (!ensureFontStoredForInterpolation(font)) {
            return undefined;
        }

        try {
            const userspaceLocation = designspaceToUserspace(
                designspaceLocation,
                (font.axes || []) as unknown as Babelfont.Axis[]
            );
            const interpolatedLayer = LayerDataNormalizer.normalize(
                JSON.parse(
                    interpolate_glyph(
                        glyphName,
                        JSON.stringify(userspaceLocation)
                    )
                ),
                true
            );
            if (!interpolatedLayer) {
                return undefined;
            }
            return new Layer([interpolatedLayer] as Unsafe, 0, targetGlyph);
        } catch {
            return undefined;
        }
    }

    private getMetricsReferenceLayerOnGlyph(
        glyphName: string
    ): Layer | undefined {
        return (
            this.getMatchingLayerOnGlyph(glyphName) ??
            this.getInterpolatedLayerOnGlyph(glyphName)
        );
    }

    resolveMetricsKey(
        side: SidebearingSide,
        stack: Set<string> = new Set()
    ): MetricsKeyResolution {
        const input = this.getEffectiveSidebearingKey(side);
        if (!input) {
            return {
                input: '',
                value: this.getDirectSidebearing(side),
                error: null,
                referencedGlyphNames: [],
                isLocal: false
            };
        }

        const font = this.getFont();
        if (!font) {
            return {
                input,
                value: null,
                error: 'Layer is not attached to a font',
                referencedGlyphNames: [],
                isLocal: this.hasLocalSidebearingKey(side)
            };
        }

        const cycleKey = `${(this.parent() as Glyph)?.name || ''}:${this.id || ''}:${side}`;
        if (stack.has(cycleKey)) {
            return {
                input,
                value: null,
                error: 'Metrics key cycle detected',
                referencedGlyphNames: [],
                isLocal: this.hasLocalSidebearingKey(side)
            };
        }

        stack.add(cycleKey);

        try {
            const parsed = parseMetricsKey(font, input);
            if ('error' in parsed) {
                return {
                    input,
                    value: null,
                    error: parsed.error,
                    referencedGlyphNames: [],
                    isLocal: this.hasLocalSidebearingKey(side)
                };
            }

            if (parsed.kind === 'constant') {
                return {
                    input,
                    value: roundMetricValue(parsed.value),
                    error: null,
                    referencedGlyphNames: parsed.referencedGlyphNames,
                    isLocal: this.hasLocalSidebearingKey(side)
                };
            }

            if (parsed.kind === 'automatic-offset') {
                if (!this.isAutomaticAlignedLayer()) {
                    return {
                        input,
                        value: roundMetricValue(parsed.delta),
                        error: null,
                        referencedGlyphNames: [],
                        isLocal: this.hasLocalSidebearingKey(side)
                    };
                }

                const baseLayer = this.getPrimaryAutoAlignedComponentLayer();
                const baseSidebearing = baseLayer
                    ? (() => {
                          const componentResolution =
                              baseLayer.resolveMetricsKey(side, stack);
                          return componentResolution.error ||
                              componentResolution.value === null
                              ? baseLayer.getDirectSidebearing(side)
                              : componentResolution.value;
                      })()
                    : this.getDirectSidebearing(side);

                return {
                    input,
                    value: roundMetricValue(baseSidebearing + parsed.delta),
                    error: null,
                    referencedGlyphNames: [],
                    isLocal: this.hasLocalSidebearingKey(side)
                };
            }

            let targetLayer: Layer | undefined;
            if (parsed.glyphName) {
                targetLayer = this.getMetricsReferenceLayerOnGlyph(
                    parsed.glyphName
                );
                if (!targetLayer) {
                    const targetGlyph = font.findGlyph(parsed.glyphName);
                    targetLayer = targetGlyph?.layers?.[0];
                }

                if (!targetLayer) {
                    return {
                        input,
                        value: null,
                        error: `Could not resolve glyph ${parsed.glyphName}`,
                        referencedGlyphNames: parsed.referencedGlyphNames,
                        isLocal: this.hasLocalSidebearingKey(side)
                    };
                }
            } else {
                targetLayer = this;
            }

            const targetSide = parsed.mirror
                ? side === 'left'
                    ? 'right'
                    : 'left'
                : side;

            let baseValue: number | null = null;
            if (parsed.offsetY !== null) {
                const measured = targetLayer.getSidebearingsAtHeight(
                    parsed.offsetY
                );
                if (!measured) {
                    return {
                        input,
                        value: null,
                        error: `Could not measure sidebearings at height ${parsed.offsetY}`,
                        referencedGlyphNames: parsed.referencedGlyphNames,
                        isLocal: this.hasLocalSidebearingKey(side)
                    };
                }
                baseValue =
                    targetSide === 'left' ? measured.left : measured.right;
            } else {
                const targetKey =
                    targetLayer.getLocalSidebearingKey(targetSide) ??
                    targetLayer.getGlobalSidebearingKey(targetSide);

                if (targetKey) {
                    const nested = targetLayer.resolveMetricsKey(
                        targetSide,
                        stack
                    );
                    if (nested.error || nested.value === null) {
                        return {
                            input,
                            value: null,
                            error: nested.error,
                            referencedGlyphNames: parsed.referencedGlyphNames,
                            isLocal: this.hasLocalSidebearingKey(side)
                        };
                    }
                    baseValue = nested.value;
                } else {
                    baseValue = targetLayer.getDirectSidebearing(targetSide);
                }
            }

            const resolvedValue = applyMetricOperation(
                baseValue,
                parsed.operation
            );
            if (resolvedValue === null || !Number.isFinite(resolvedValue)) {
                return {
                    input,
                    value: null,
                    error: 'Invalid metrics-key calculation',
                    referencedGlyphNames: parsed.referencedGlyphNames,
                    isLocal: this.hasLocalSidebearingKey(side)
                };
            }

            return {
                input,
                value: roundMetricValue(resolvedValue),
                error: null,
                referencedGlyphNames: parsed.referencedGlyphNames,
                isLocal: this.hasLocalSidebearingKey(side)
            };
        } finally {
            stack.delete(cycleKey);
        }
    }

    applySidebearingInput(
        side: SidebearingSide,
        rawValue: string
    ): MetricsKeyResolution {
        const input = rawValue.trim();
        const label = side === 'left' ? 'Set LSB' : 'Set RSB';
        const glyphName = (this.parent() as Glyph)?.name;
        const isPlainNumericInput = isPlainNumericText(input);
        const forceLocal = input.startsWith('==');
        const updateScope: 'layer' | 'font' =
            !isPlainNumericInput && !forceLocal ? 'font' : 'layer';

        return withBridgeTransaction(label, () => {
            if (isPlainNumericInput) {
                this.clearEffectiveSidebearingKey(side);
                this.setDirectSidebearing(side, Number(input));
                const affectedGlyphNames = new Set<string>(
                    [glyphName].filter(Boolean) as string[]
                );
                for (const dependentGlyphName of this.getFont()?.recomputeMetricsKeys(
                    affectedGlyphNames
                ) || []) {
                    affectedGlyphNames.add(dependentGlyphName);
                }
                return {
                    input,
                    value: Number(input),
                    error: null,
                    referencedGlyphNames: [],
                    isLocal: false,
                    updateScope,
                    affectedGlyphNames: [...affectedGlyphNames]
                };
            }

            if (forceLocal) {
                if (side === 'left') {
                    this.leftMetricsKey = input;
                } else {
                    this.rightMetricsKey = input;
                }
            } else {
                this.setEffectiveSidebearingKey(side, input, false);
            }
            const resolution = this.resolveMetricsKey(side);
            if (resolution.error || resolution.value === null) {
                return {
                    ...resolution,
                    updateScope,
                    affectedGlyphNames: glyphName ? [glyphName] : []
                };
            }

            const applied = getAppliedMetricsKeySidebearing(
                this,
                side,
                resolution
            );
            if (applied.error || applied.value === null) {
                return {
                    ...resolution,
                    value: null,
                    error: applied.error,
                    updateScope,
                    affectedGlyphNames: glyphName ? [glyphName] : []
                };
            }

            this.setDirectSidebearing(side, applied.value);
            const affectedGlyphNames = new Set<string>(
                [glyphName].filter(Boolean) as string[]
            );
            for (const dependentGlyphName of this.getFont()?.recomputeMetricsKeys(
                affectedGlyphNames
            ) || []) {
                affectedGlyphNames.add(dependentGlyphName);
            }
            return {
                ...resolution,
                updateScope,
                affectedGlyphNames: [...affectedGlyphNames]
            };
        });
    }

    private getGlobalSidebearingKey(side: SidebearingSide): string | undefined {
        const glyph = this.parent() as Glyph;
        if (!glyph) {
            return undefined;
        }

        return side === 'left' ? glyph.leftMetricsKey : glyph.rightMetricsKey;
    }

    get leftMetricsKey(): string | undefined {
        return localMetricsKeyStorageToPublic(
            this.getLocalSidebearingKey('left')
        );
    }

    set leftMetricsKey(value: string | undefined) {
        this.setLocalSidebearingKey(
            'left',
            localMetricsKeyPublicToStorage(value, this.getFont())
        );
    }

    get rightMetricsKey(): string | undefined {
        return localMetricsKeyStorageToPublic(
            this.getLocalSidebearingKey('right')
        );
    }

    set rightMetricsKey(value: string | undefined) {
        this.setLocalSidebearingKey(
            'right',
            localMetricsKeyPublicToStorage(value, this.getFont())
        );
    }

    getPathSegment(): (string | number)[] {
        const layerId = this.data.id;
        return layerId ? ['layers', layerId] : ['layers', this._index];
    }

    private getMasterId(): string | undefined {
        return this.master?.master;
    }

    /**
     * Get the resolved master object for this layer.
     * Returns a Master only when this layer is a DefaultForMaster layer.
     */
    getMaster(): Master | undefined {
        const layerMaster = this.master;
        if (!layerMaster || layerMaster.type !== 'DefaultForMaster') {
            return undefined;
        }

        const glyph = this.parent() as Glyph;
        if (!glyph) return undefined;

        const font = glyph.parent() as Font;
        if (!font) return undefined;

        return font.findMaster(layerMaster.master);
    }

    get width(): number {
        return this.data.width;
    }

    set width(value: number) {
        const old = this.data.width;
        this.data.width = value;
        recordAndMarkDirty(this, 'width', old, value);
    }

    /**
     * Get the left sidebearing (LSB) - the distance from x=0 to the left edge of the bounding box
     * @returns The left sidebearing value, or 0 if no geometry
     */
    get lsb(): number {
        return this.getDirectSidebearing('left');
    }

    /**
     * Set the left sidebearing (LSB) by translating all geometry horizontally
     * This updates the position of all paths, components, and anchors, and adjusts width accordingly
     * @param value - The new left sidebearing value
     */
    set lsb(value: number) {
        withBridgeTransaction('Set LSB', () => {
            this.setDirectSidebearing('left', value);
            this.getFont()?.recomputeMetricsKeys(
                new Set([(this.parent() as Glyph)?.name].filter(Boolean))
            );
        });
    }

    /**
     * Get the right sidebearing (RSB) - the distance from the right edge of the bounding box to the advance width
     * @returns The right sidebearing value, or the width if no geometry
     */
    get rsb(): number {
        return this.getDirectSidebearing('right');
    }

    /**
     * Set the right sidebearing (RSB) by adjusting the advance width
     * This only changes the width, not the geometry position
     * @param value - The new right sidebearing value
     */
    set rsb(value: number) {
        withBridgeTransaction('Set RSB', () => {
            this.setDirectSidebearing('right', value);
            this.getFont()?.recomputeMetricsKeys(
                new Set([(this.parent() as Glyph)?.name].filter(Boolean))
            );
        });
    }

    get name(): string | undefined {
        return this.data.name;
    }

    set name(value: string | undefined) {
        const old = this.data.name;
        this.data.name = value;
        recordAndMarkDirty(this, 'name', old, value);
    }

    get id(): string | undefined {
        return this.data.id;
    }

    set id(value: string | undefined) {
        const old = this.data.id;
        this.data.id = value;
        recordAndMarkDirty(this, 'id', old, value);
    }

    get master(): Babelfont.LayerType | undefined {
        const layerId = this.data.id || '[no-layer-id]';
        assertTaggedLayerMaster(this.data.master, `Layer#${layerId}.master`);
        return getLiveMutableValue(this, 'master', this.data.master, () => {
            const currentLayerId = this.data.id || '[no-layer-id]';
            assertTaggedLayerMaster(
                this.data.master,
                `Layer#${currentLayerId}.master`
            );
            return this.data.master;
        });
    }

    set master(value: Babelfont.LayerType | undefined) {
        const layerId = this.data.id || '[no-layer-id]';
        assertTaggedLayerMaster(value, `Layer#${layerId}.master(set)`);
        const old = this.data.master;
        this.data.master = value;
        recordAndMarkDirty(this, 'master', old, value);
    }

    get smart_component_location(): Record<string, number> | undefined {
        return getLiveMutableValue(
            this,
            'smart_component_location',
            this.data.smart_component_location,
            () => this.data.smart_component_location
        );
    }

    set smart_component_location(value: Record<string, number> | undefined) {
        const old = this.data.smart_component_location;
        this.data.smart_component_location = value;
        recordAndMarkDirty(this, 'smart_component_location', old, value);
    }

    get guides(): Guide[] | undefined {
        if (!this.data.guides) return undefined;
        if (
            !this._guideWrappers ||
            this._guideWrappers.length !== this.data.guides.length
        ) {
            this._guideWrappers = this.data.guides.map(
                (_: Unsafe, i: number) => new Guide(this.data.guides, i, this)
            );
        }
        return getReadOnlyCollectionValue(
            this._guideWrappers!,
            'Layer.guides is a read-only collection view. Use addGuide() or removeGuide() for structural edits.'
        );
    }

    get shapes(): Shape[] | undefined {
        if (!this.data.shapes) return undefined;
        if (
            !this._shapeWrappers ||
            this._shapeWrappers.length !== this.data.shapes.length
        ) {
            this._shapeWrappers = this.data.shapes.map(
                (_: Unsafe, i: number) => new Shape(this.data.shapes, i, this)
            );
        }
        return getReadOnlyCollectionValue(
            this._shapeWrappers!,
            'Layer.shapes is a read-only collection view. Use addPath(), addComponent(), addShape(), or removeShape() for structural edits.'
        );
    }

    get anchors(): Anchor[] | undefined {
        if (!this.data.anchors) return undefined;
        if (
            !this._anchorWrappers ||
            this._anchorWrappers.length !== this.data.anchors.length
        ) {
            this._anchorWrappers = this.data.anchors.map(
                (_: Unsafe, i: number) => new Anchor(this.data.anchors, i, this)
            );
        }
        return getReadOnlyCollectionValue(
            this._anchorWrappers!,
            'Layer.anchors is a read-only collection view. Use addAnchor() or removeAnchor() for structural edits.'
        );
    }

    get color(): Babelfont.Color | undefined {
        return this.data.color;
    }

    set color(value: Babelfont.Color | undefined) {
        const old = this.data.color;
        this.data.color = value;
        recordAndMarkDirty(this, 'color', old, value);
    }

    get layer_index(): number | undefined {
        return this.data.layer_index;
    }

    set layer_index(value: number | undefined) {
        const old = this.data.layer_index;
        this.data.layer_index = value;
        recordAndMarkDirty(this, 'layer_index', old, value);
    }

    get is_background(): boolean | undefined {
        return this.data.is_background;
    }

    set is_background(value: boolean | undefined) {
        const old = this.data.is_background;
        this.data.is_background = value;
        recordAndMarkDirty(this, 'is_background', old, value);
    }

    get background_layer_id(): string | undefined {
        return this.data.background_layer_id;
    }

    set background_layer_id(value: string | undefined) {
        const old = this.data.background_layer_id;
        this.data.background_layer_id = value;
        recordAndMarkDirty(this, 'background_layer_id', old, value);
    }

    get location(): Record<string, number> | undefined {
        return getLiveMutableValue(
            this,
            'location',
            this.data.location,
            () => this.data.location
        );
    }

    set location(value: Record<string, number> | undefined) {
        const old = this.data.location;
        this.data.location = value;
        recordAndMarkDirty(this, 'location', old, value);
    }

    get format_specific(): Record<string, Unsafe> | undefined {
        return getLiveMutableValue(
            this,
            'format_specific',
            this.data.format_specific,
            () => this.data.format_specific
        );
    }

    set format_specific(value: Record<string, Unsafe> | undefined) {
        const old = this.data.format_specific;
        this.data.format_specific = value;
        recordAndMarkDirty(this, 'format_specific', old, value);
    }

    /**
     * Add a new shape to the layer
     */
    addShape(shape: Babelfont.Shape): Shape {
        if (!this.data.shapes) {
            this.data.shapes = [];
        }
        this.data.shapes.push(shape);
        this._shapeWrappers = null; // Invalidate cache
        const index = this.data.shapes.length - 1;
        recordAddAndMarkDirty([...this.getPath(), 'shapes', index], shape);
        return new Shape(this.data.shapes, index, this);
    }

    /**
     * Add a new path to the layer
     * @example
     * path = layer.addPath(closed=True)
     */
    addPath(closed: boolean | Record<string, Unsafe> = true): Path {
        // Pyodide/JS interop can pass keyword arguments as an object,
        // e.g. addPath(closed=True) may arrive as { closed: true }.
        const resolvedClosed =
            typeof closed === 'boolean'
                ? closed
                : !!closed && typeof closed === 'object' && 'closed' in closed
                  ? !!(closed as Unsafe).closed
                  : true;

        const pathData: Babelfont.Path = {
            nodes: [],
            closed: resolvedClosed
        };
        const shapeData: Babelfont.Shape = pathData;
        const shape = this.addShape(shapeData);
        return shape.asPath();
    }

    /**
     * Add a new component to the layer
     * @example
     * component = layer.addComponent("A")
     * # With transformation matrix (legacy 6-element format converted to DecomposedAffine)
     * component = layer.addComponent("acutecomb", [1, 0, 0, 1, 250, 500])
     */
    addComponent(
        reference: string,
        transform?: number[] | Babelfont.DecomposedAffine
    ): Component {
        const componentData: Babelfont.Component = {
            reference,
            transform: this.normalizeTransform(transform)
        };
        const shapeData: Babelfont.Shape = componentData;
        const shape = this.addShape(shapeData);
        return shape.asComponent();
    }

    /**
     * Normalize transform to DecomposedAffine format
     * Converts legacy 6-element affine matrix to DecomposedAffine
     */
    private normalizeTransform(
        transform?: number[] | Babelfont.DecomposedAffine
    ): Babelfont.DecomposedAffine {
        if (!transform) {
            return DecomposedAffineTransform.identity();
        }

        if (Array.isArray(transform)) {
            return DecomposedAffineTransform.fromAffine(transform);
        }

        return transform;
    }

    /**
     * Remove a shape at the specified index
     */
    removeShape(index: number): void {
        if (this.data.shapes) {
            const removedShape = this.data.shapes[index];
            if (removedShape === undefined) {
                return;
            }

            this.data.shapes.splice(index, 1);
            this._shapeWrappers = null; // Invalidate cache
            recordRemoveAndMarkDirty(
                [...this.getPath(), 'shapes', index],
                removedShape
            );
        }
    }

    /**
     * Add a new anchor to the layer
     * @example
     * anchor = layer.addAnchor(250, 700, "top")
     */
    addAnchor(x: number, y: number, name?: string): Anchor {
        if (!this.data.anchors) {
            this.data.anchors = [];
        }
        const anchorData: Babelfont.Anchor = { x, y };
        if (name) {
            anchorData.name = name;
        }
        this.data.anchors.push(anchorData);
        this._anchorWrappers = null; // Invalidate cache
        const index = this.data.anchors.length - 1;
        recordAddAndMarkDirty(
            [...this.getPath(), 'anchors', index],
            anchorData
        );
        return new Anchor(this.data.anchors, index, this);
    }

    addGuide(
        pos: Babelfont.Position,
        name?: string,
        color?: Babelfont.Color
    ): Guide {
        if (!this.data.guides) {
            this.data.guides = [];
        }

        const guideData: Babelfont.Guide = { pos };
        if (name !== undefined) {
            guideData.name = name;
        }
        if (color !== undefined) {
            guideData.color = color;
        }

        this.data.guides.push(guideData);
        this._guideWrappers = null;
        const index = this.data.guides.length - 1;
        recordAddAndMarkDirty([...this.getPath(), 'guides', index], guideData);
        return new Guide(this.data.guides, index, this);
    }

    /**
     * Remove an anchor at the specified index
     */
    removeAnchor(index: number): void {
        if (this.data.anchors) {
            const removedAnchor = this.data.anchors[index];
            if (removedAnchor === undefined) {
                return;
            }

            this.data.anchors.splice(index, 1);
            this._anchorWrappers = null; // Invalidate cache
            recordRemoveAndMarkDirty(
                [...this.getPath(), 'anchors', index],
                removedAnchor
            );
        }
    }

    removeGuide(index: number): void {
        if (this.data.guides) {
            const removedGuide = this.data.guides[index];
            if (removedGuide === undefined) {
                return;
            }

            this.data.guides.splice(index, 1);
            this._guideWrappers = null;
            recordRemoveAndMarkDirty(
                [...this.getPath(), 'guides', index],
                removedGuide
            );
        }
    }

    /**
     * Process a path into Bezier curve segments
     * Handles the babelfont node format where:
     * - Nodes can have 'type' (lowercase: o, c, l, q, etc.) or 'nodetype' (capitalized: OffCurve, Curve, Line, etc.)
     * - Segments are sequences: [oncurve] [offcurve*] [oncurve]
     * - For closed paths, the path can start with offcurve nodes
     *
     * @param pathData - Path data with nodes array and closed flag
     * @returns Array of Bezier curve segments, each with {points, type}
     */
    public static processPathSegments(pathData: {
        nodes: Unsafe[];
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
        const closed = pathData.closed !== false; // Default to true

        // Helper to get node type (handles both 'type' and 'nodetype' fields)
        const getNodeType = (node: Unsafe): string => {
            return (node.type || node.nodetype || '').toString().toLowerCase();
        };

        // Helper to check if node is offcurve
        const isOffCurve = (node: Unsafe): boolean => {
            const type = getNodeType(node);
            return type === 'o' || type === 'offcurve';
        };

        // Helper to check if node is oncurve
        const isOnCurve = (node: Unsafe): boolean => {
            return !isOffCurve(node);
        };

        // Find the first oncurve node to start from
        let startIdx = 0;
        if (closed) {
            // For closed paths, find first oncurve node
            for (let i = 0; i < nodes.length; i++) {
                if (isOnCurve(nodes[i])) {
                    startIdx = i;
                    break;
                }
            }
        }

        // Process segments
        let i = startIdx;
        let processedCount = 0;
        const maxNodes = closed ? nodes.length : nodes.length - 1;

        while (processedCount < maxNodes) {
            const currentIdx = i % nodes.length;
            const current = nodes[currentIdx];

            if (!isOnCurve(current)) {
                // Skip if we somehow landed on an offcurve (shouldn't happen after finding start)
                i++;
                processedCount++;
                continue;
            }

            // Collect points for this segment: [oncurve] [offcurve*] [oncurve]
            const points: Array<{ x: number; y: number }> = [
                { x: current.x, y: current.y }
            ];

            // Collect all following offcurve nodes
            let j = (currentIdx + 1) % nodes.length;
            let offcurveCount = 0;
            while (offcurveCount < nodes.length) {
                // Safety limit
                if (j >= nodes.length && !closed) break;

                const node = nodes[j % nodes.length];
                if (isOffCurve(node)) {
                    points.push({ x: node.x, y: node.y });
                    j++;
                    offcurveCount++;
                } else {
                    // Found next oncurve node
                    points.push({ x: node.x, y: node.y });
                    break;
                }
            }

            // Determine segment type based on number of points
            if (points.length === 2) {
                // Line segment: [oncurve] [oncurve]
                segments.push({ points, type: 'line' });
                i++;
                processedCount++;
            } else if (points.length === 3) {
                // Quadratic Bezier: [oncurve] [offcurve] [oncurve]
                segments.push({ points, type: 'quadratic' });
                i += 1 + offcurveCount;
                processedCount += 1 + offcurveCount;
            } else if (points.length === 4) {
                // Cubic Bezier: [oncurve] [offcurve] [offcurve] [oncurve]
                segments.push({ points, type: 'cubic' });
                i += 1 + offcurveCount;
                processedCount += 1 + offcurveCount;
            } else if (points.length > 4) {
                // Too many control points - skip this malformed segment
                i += 1 + offcurveCount;
                processedCount += 1 + offcurveCount;
            } else {
                // Not enough points (shouldn't happen)
                i++;
                processedCount++;
            }

            // Safety check to prevent infinite loops
            if (processedCount > nodes.length * 2) {
                break;
            }
        }

        return segments;
    }

    private static boundsFromMinMax(
        minX: number,
        minY: number,
        maxX: number,
        maxY: number
    ): {
        minX: number;
        minY: number;
        maxX: number;
        maxY: number;
        width: number;
        height: number;
    } | null {
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
            height: maxY - minY
        };
    }

    private static boundsFromSegments(
        segments: Array<{
            points: Array<{ x: number; y: number }>;
            type: 'line' | 'quadratic' | 'cubic';
        }>
    ): {
        minX: number;
        minY: number;
        maxX: number;
        maxY: number;
        width: number;
        height: number;
    } | null {
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;

        const includePoint = (x: number, y: number) => {
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
        };

        for (const segment of segments) {
            if (
                !segment ||
                !Array.isArray(segment.points) ||
                segment.points.length < 2
            ) {
                continue;
            }

            if (segment.type === 'line' || segment.points.length < 3) {
                for (const point of segment.points) {
                    includePoint(point.x, point.y);
                }
                continue;
            }

            try {
                const bbox = new Bezier(segment.points).bbox();
                includePoint(bbox.x.min, bbox.y.min);
                includePoint(bbox.x.max, bbox.y.max);
            } catch {
                for (const point of segment.points) {
                    includePoint(point.x, point.y);
                }
            }
        }

        return Layer.boundsFromMinMax(minX, minY, maxX, maxY);
    }

    static calculatePathBounds(pathData: {
        nodes?: Unsafe[] | string;
        closed?: boolean;
    }): {
        minX: number;
        minY: number;
        maxX: number;
        maxY: number;
        width: number;
        height: number;
    } | null {
        if (!pathData?.nodes) {
            return null;
        }

        const nodes =
            typeof pathData.nodes === 'string'
                ? LayerDataNormalizer.parseNodes(pathData.nodes)
                : pathData.nodes;

        if (!Array.isArray(nodes) || nodes.length === 0) {
            return null;
        }

        const normalizedNodes = nodes.filter(
            (node) =>
                node && typeof node.x === 'number' && typeof node.y === 'number'
        );
        if (!normalizedNodes.length) {
            return null;
        }

        const segmentBounds = Layer.boundsFromSegments(
            Layer.processPathSegments({
                nodes: normalizedNodes,
                closed: pathData.closed
            })
        );
        if (segmentBounds) {
            return segmentBounds;
        }

        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const node of normalizedNodes) {
            minX = Math.min(minX, node.x);
            minY = Math.min(minY, node.y);
            maxX = Math.max(maxX, node.x);
            maxY = Math.max(maxY, node.y);
        }

        return Layer.boundsFromMinMax(minX, minY, maxX, maxY);
    }

    static calculateShapeBounds(
        shapes: Unsafe[] | undefined,
        parentTransform: number[] = [1, 0, 0, 1, 0, 0]
    ): {
        minX: number;
        minY: number;
        maxX: number;
        maxY: number;
        width: number;
        height: number;
    } | null {
        if (!Array.isArray(shapes) || shapes.length === 0) {
            return null;
        }

        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;

        const includeBounds = (
            bounds:
                | {
                      minX: number;
                      minY: number;
                      maxX: number;
                      maxY: number;
                  }
                | null
                | undefined
        ) => {
            if (!bounds) {
                return;
            }
            minX = Math.min(minX, bounds.minX);
            minY = Math.min(minY, bounds.minY);
            maxX = Math.max(maxX, bounds.maxX);
            maxY = Math.max(maxY, bounds.maxY);
        };

        const composeTransforms = (t1: number[], t2: number[]): number[] => {
            const [a1, b1, c1, d1, tx1, ty1] = t1;
            const [a2, b2, c2, d2, tx2, ty2] = t2;
            return [
                a1 * a2 + c1 * b2,
                b1 * a2 + d1 * b2,
                a1 * c2 + c1 * d2,
                b1 * c2 + d1 * d2,
                a1 * tx2 + c1 * ty2 + tx1,
                b1 * tx2 + d1 * ty2 + ty1
            ];
        };

        const transformNode = (node: Unsafe, transform: number[]): Unsafe => {
            const [a, b, c, d, tx, ty] = transform;
            return {
                ...node,
                x: a * node.x + c * node.y + tx,
                y: b * node.x + d * node.y + ty
            };
        };

        for (const shape of shapes) {
            if (!shape || typeof shape !== 'object') {
                continue;
            }

            const pathData =
                'nodes' in shape
                    ? shape
                    : 'Path' in shape && shape.Path
                      ? shape.Path
                      : 'Contour' in shape && shape.Contour
                        ? shape.Contour
                        : null;

            if (pathData?.nodes) {
                const nodes =
                    typeof pathData.nodes === 'string'
                        ? LayerDataNormalizer.parseNodes(pathData.nodes)
                        : pathData.nodes;
                if (Array.isArray(nodes) && nodes.length > 0) {
                    const transformedNodes = nodes.map((node: Unsafe) =>
                        transformNode(node, parentTransform)
                    );
                    includeBounds(
                        Layer.calculatePathBounds({
                            nodes: transformedNodes,
                            closed: pathData.closed
                        })
                    );
                }
                continue;
            }

            const componentData =
                'reference' in shape
                    ? shape
                    : 'Component' in shape && shape.Component
                      ? shape.Component
                      : null;

            if (!componentData?.layerData?.shapes) {
                continue;
            }

            const componentTransform = Array.isArray(componentData.transform)
                ? componentData.transform
                : Array.from(
                      DecomposedAffineTransform.toAffine(
                          componentData.transform ||
                              DecomposedAffineTransform.identity()
                      )
                  );
            includeBounds(
                Layer.calculateShapeBounds(
                    componentData.layerData.shapes,
                    composeTransforms(parentTransform, componentTransform)
                )
            );
        }

        return Layer.boundsFromMinMax(minX, minY, maxX, maxY);
    }

    static calculateSvgPathBounds(pathData: string): {
        minX: number;
        minY: number;
        maxX: number;
        maxY: number;
        width: number;
        height: number;
    } | null {
        if (!pathData) {
            return null;
        }

        const tokens = pathData.match(/[MLCQZ]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi);
        if (!tokens) {
            return null;
        }

        const isCommand = (token: string): boolean => /^[MLCQZ]$/i.test(token);
        const readNumber = (index: number): number | null => {
            if (index >= tokens.length || isCommand(tokens[index])) {
                return null;
            }
            const value = Number.parseFloat(tokens[index]);
            return Number.isFinite(value) ? value : null;
        };

        const segments: Array<{
            points: Array<{ x: number; y: number }>;
            type: 'line' | 'quadratic' | 'cubic';
        }> = [];
        let currentPoint: { x: number; y: number } | null = null;
        let subpathStart: { x: number; y: number } | null = null;

        for (let index = 0; index < tokens.length; ) {
            const command = tokens[index++].toUpperCase();

            if (command === 'M') {
                const x = readNumber(index);
                const y = readNumber(index + 1);
                if (x === null || y === null) {
                    break;
                }
                currentPoint = { x, y };
                subpathStart = { x, y };
                index += 2;

                while (index < tokens.length && !isCommand(tokens[index])) {
                    const nextX = readNumber(index);
                    const nextY = readNumber(index + 1);
                    if (
                        nextX === null ||
                        nextY === null ||
                        currentPoint === null
                    ) {
                        break;
                    }
                    segments.push({
                        type: 'line',
                        points: [currentPoint, { x: nextX, y: nextY }]
                    });
                    currentPoint = { x: nextX, y: nextY };
                    index += 2;
                }
                continue;
            }

            if (command === 'L') {
                while (index < tokens.length && !isCommand(tokens[index])) {
                    const x = readNumber(index);
                    const y = readNumber(index + 1);
                    if (x === null || y === null || currentPoint === null) {
                        break;
                    }
                    segments.push({
                        type: 'line',
                        points: [currentPoint, { x, y }]
                    });
                    currentPoint = { x, y };
                    index += 2;
                }
                continue;
            }

            if (command === 'Q') {
                while (index < tokens.length && !isCommand(tokens[index])) {
                    const c1x = readNumber(index);
                    const c1y = readNumber(index + 1);
                    const x = readNumber(index + 2);
                    const y = readNumber(index + 3);
                    if (
                        c1x === null ||
                        c1y === null ||
                        x === null ||
                        y === null ||
                        currentPoint === null
                    ) {
                        break;
                    }
                    segments.push({
                        type: 'quadratic',
                        points: [currentPoint, { x: c1x, y: c1y }, { x, y }]
                    });
                    currentPoint = { x, y };
                    index += 4;
                }
                continue;
            }

            if (command === 'C') {
                while (index < tokens.length && !isCommand(tokens[index])) {
                    const c1x = readNumber(index);
                    const c1y = readNumber(index + 1);
                    const c2x = readNumber(index + 2);
                    const c2y = readNumber(index + 3);
                    const x = readNumber(index + 4);
                    const y = readNumber(index + 5);
                    if (
                        c1x === null ||
                        c1y === null ||
                        c2x === null ||
                        c2y === null ||
                        x === null ||
                        y === null ||
                        currentPoint === null
                    ) {
                        break;
                    }
                    segments.push({
                        type: 'cubic',
                        points: [
                            currentPoint,
                            { x: c1x, y: c1y },
                            { x: c2x, y: c2y },
                            { x, y }
                        ]
                    });
                    currentPoint = { x, y };
                    index += 6;
                }
                continue;
            }

            if (
                command === 'Z' &&
                currentPoint &&
                subpathStart &&
                (currentPoint.x !== subpathStart.x ||
                    currentPoint.y !== subpathStart.y)
            ) {
                segments.push({
                    type: 'line',
                    points: [currentPoint, subpathStart]
                });
                currentPoint = subpathStart;
            }
        }

        return Layer.boundsFromSegments(segments);
    }

    /**
     * Flatten all components in the layer to paths with their transforms applied
     * This recursively processes nested components to arbitrary depth
     * @param layerData - Raw layer data object
     * @param font - Font object for looking up component references
     * @returns Array of flattened path data objects with transformed coordinates
     */
    private static flattenComponents(
        layerData: Unsafe,
        font?: Font,
        masterId?: string
    ): Babelfont.Path[] {
        const flattenedPaths: Babelfont.Path[] = [];

        // Helper function to apply transform to a node
        const transformNode = (node: Unsafe, transform: number[]): Unsafe => {
            const [a, b, c, d, tx, ty] = transform;
            const result: Unsafe = {
                x: a * node.x + c * node.y + tx,
                y: b * node.x + d * node.y + ty
            };
            // Preserve node type field (either 'type' or 'nodetype')
            if (node.type !== undefined) result.type = node.type;
            if (node.nodetype !== undefined) result.nodetype = node.nodetype;
            if (node.smooth !== undefined) result.smooth = node.smooth;
            return result;
        };

        // Helper to convert DecomposedAffine to affine matrix array
        const toAffineArray = (
            transform: Babelfont.DecomposedAffine | number[] | undefined
        ): number[] => {
            if (!transform) return [1, 0, 0, 1, 0, 0];
            if (Array.isArray(transform)) return transform;
            // Use the proper transform composition from DecomposedAffineTransform
            return Array.from(DecomposedAffineTransform.toAffine(transform));
        };

        // Helper function to combine two transform matrices
        const combineTransforms = (t1: number[], t2: number[]): number[] => {
            const [a1, b1, c1, d1, tx1, ty1] = t1;
            const [a2, b2, c2, d2, tx2, ty2] = t2;
            return [
                a1 * a2 + c1 * b2,
                b1 * a2 + d1 * b2,
                a1 * c2 + c1 * d2,
                b1 * c2 + d1 * d2,
                a1 * tx2 + c1 * ty2 + tx1,
                b1 * tx2 + d1 * ty2 + ty1
            ];
        };

        // Helper function to process shapes recursively (for components)
        const processShapes = (
            shapes: Unsafe[],
            transform: number[] = [1, 0, 0, 1, 0, 0]
        ) => {
            if (!shapes || !Array.isArray(shapes)) return;

            for (const shape of shapes) {
                // Handle both nested { Component: { reference, transform } } and flat { reference, transform }
                const isNestedComponent = 'Component' in shape;
                const componentData = isNestedComponent
                    ? (shape as Unsafe).Component
                    : shape;

                if ('reference' in componentData) {
                    // Component - recursively process its outline shapes with accumulated transform
                    const compTransform = toAffineArray(
                        componentData.transform
                    );
                    const combinedTransform = combineTransforms(
                        transform,
                        compTransform
                    );

                    // Get component's layer data - either from pre-populated layerData
                    // or by looking up the component glyph in the font
                    let componentLayerData = componentData.layerData;

                    if (!componentLayerData && font) {
                        // Look up the component glyph and get the matching layer for the current master
                        const componentGlyph = font.findGlyph(
                            componentData.reference
                        );
                        if (componentGlyph && componentGlyph.layers) {
                            let layer;
                            if (masterId) {
                                // Find the layer that matches the current master
                                layer = componentGlyph.layers.find(
                                    (l) =>
                                        l.data.master &&
                                        (l.data.master as Unsafe).master ===
                                            masterId
                                );
                            }
                            // Fallback to first layer if no matching master found
                            if (!layer) {
                                layer = componentGlyph.layers[0];
                            }
                            if (layer) {
                                componentLayerData = layer.toJSON();
                            }
                        }
                    }

                    // Recursively process the component's actual outline shapes
                    if (componentLayerData && componentLayerData.shapes) {
                        processShapes(
                            componentLayerData.shapes,
                            combinedTransform
                        );
                    }
                } else if ('Path' in shape && shape.Path?.nodes) {
                    // Path with Babelfont v3.0+ nested structure: { Path: { nodes: "...", closed: bool } }
                    let nodes = shape.Path.nodes;

                    // Parse nodes if they're a string
                    if (typeof nodes === 'string') {
                        nodes = LayerDataNormalizer.parseNodes(nodes);
                    }

                    if (Array.isArray(nodes) && nodes.length > 0) {
                        // Transform all nodes and create a new path
                        const transformedNodes = nodes.map((node: Unsafe) =>
                            transformNode(node, transform)
                        );

                        flattenedPaths.push({
                            nodes: transformedNodes,
                            closed: shape.Path.closed
                        });
                    }
                } else if ('nodes' in shape && shape.nodes) {
                    // Path with legacy flat structure
                    let nodes = shape.nodes;

                    // Parse nodes if they're a string
                    if (typeof nodes === 'string') {
                        nodes = LayerDataNormalizer.parseNodes(nodes);
                    }

                    if (Array.isArray(nodes) && nodes.length > 0) {
                        // Transform all nodes and create a new path
                        const transformedNodes = nodes.map((node: Unsafe) =>
                            transformNode(node, transform)
                        );

                        flattenedPaths.push({
                            nodes: transformedNodes,
                            closed: shape.closed
                        });
                    }
                } else if (
                    'nodes' in shape &&
                    Array.isArray(shape.nodes) &&
                    shape.nodes.length > 0
                ) {
                    // Path with flat structure (parsed format)
                    const transformedNodes = shape.nodes.map((node: Unsafe) =>
                        transformNode(node, transform)
                    );

                    flattenedPaths.push({
                        nodes: transformedNodes,
                        closed: shape.closed !== undefined ? shape.closed : true
                    });
                }
            }
        };

        // Process all shapes
        if (layerData.shapes) {
            processShapes(layerData.shapes);
        }

        return flattenedPaths;
    }

    /**
     * Get only direct paths in this layer (no components)
     * @returns Array of path data objects from shapes that are paths
     */
    private getDirectPaths(): Babelfont.Path[] {
        const paths: Babelfont.Path[] = [];

        if (!this.shapes) return paths;

        for (const shape of this.shapes) {
            if (shape.isPath()) {
                const pathData = shape.asPath().toJSON();
                if (pathData.nodes) {
                    // Parse nodes if they're stored as a string
                    if (typeof pathData.nodes === 'string') {
                        pathData.nodes = LayerDataNormalizer.parseNodes(
                            pathData.nodes
                        );
                    }
                    if (Array.isArray(pathData.nodes)) {
                        paths.push(pathData as Babelfont.Path);
                    }
                }
            }
        }

        return paths;
    }

    /**
     * Get all paths in this layer including transformed paths from components (recursively flattened)
     * @returns Array of path data objects with all components resolved to transformed paths
     */
    getAllPaths(): Babelfont.Path[] {
        const paths: Babelfont.Path[] = [];

        if (!this.shapes) {
            return paths;
        }

        for (const shape of this.shapes) {
            if (shape.isPath()) {
                // Add direct path
                const pathData = shape.asPath().toJSON();
                if (pathData.nodes) {
                    // Parse nodes if they're stored as a string
                    if (typeof pathData.nodes === 'string') {
                        pathData.nodes = LayerDataNormalizer.parseNodes(
                            pathData.nodes
                        );
                    }
                    if (Array.isArray(pathData.nodes)) {
                        paths.push(pathData as Babelfont.Path);
                    }
                }
            } else if (shape.isComponent()) {
                // Get transformed paths from component recursively
                const component = shape.asComponent();
                const componentPaths = component.getTransformedPaths();
                paths.push(...componentPaths);
            }
        }

        return paths;
    }

    /**
     * Calculate bounding box for layer data
     * @param layerData - Raw layer data object
     * @param includeAnchors - If true, include anchors in the bounding box calculation (default: false)
     * @param font - Font object for component lookup (optional)
     * @param masterId - Master ID for finding matching component layers (optional)
     * @returns Bounding box {minX, minY, maxX, maxY, width, height} or null if no geometry
     */
    static calculateBoundingBox(
        layerData: Unsafe,
        includeAnchors: boolean = false,
        font?: Font,
        masterId?: string
    ): {
        minX: number;
        minY: number;
        maxX: number;
        maxY: number;
        width: number;
        height: number;
    } | null {
        let bounds = null;

        // Get all paths (we need to use the static flattenComponents for compatibility)
        // since we're working with raw layer data, not a Layer instance
        const paths = Layer.flattenComponents(layerData, font, masterId);

        // Process all paths
        for (const path of paths) {
            const pathBounds = Layer.calculatePathBounds(path);
            if (pathBounds) {
                bounds = bounds
                    ? {
                          minX: Math.min(bounds.minX, pathBounds.minX),
                          minY: Math.min(bounds.minY, pathBounds.minY),
                          maxX: Math.max(bounds.maxX, pathBounds.maxX),
                          maxY: Math.max(bounds.maxY, pathBounds.maxY),
                          width: 0,
                          height: 0
                      }
                    : { ...pathBounds };
            }
        }

        // Include anchors in bounding box if requested
        if (includeAnchors && layerData.anchors) {
            for (const anchor of layerData.anchors) {
                bounds = bounds
                    ? {
                          minX: Math.min(bounds.minX, anchor.x),
                          minY: Math.min(bounds.minY, anchor.y),
                          maxX: Math.max(bounds.maxX, anchor.x),
                          maxY: Math.max(bounds.maxY, anchor.y),
                          width: 0,
                          height: 0
                      }
                    : {
                          minX: anchor.x,
                          minY: anchor.y,
                          maxX: anchor.x,
                          maxY: anchor.y,
                          width: 0,
                          height: 0
                      };
            }
        }

        if (!bounds) {
            // No points found (e.g., space character) - use glyph width from layer data
            // Create a small bbox: 10 units high, centered on baseline, as wide as the glyph
            const glyphWidth = layerData.width || 250; // Fallback to 250 if no width
            const height = 10;

            return {
                minX: 0,
                minY: -height / 2,
                maxX: glyphWidth,
                maxY: height / 2,
                width: glyphWidth,
                height: height
            };
        }

        return {
            minX: bounds.minX,
            minY: bounds.minY,
            maxX: bounds.maxX,
            maxY: bounds.maxY,
            width: bounds.maxX - bounds.minX,
            height: bounds.maxY - bounds.minY
        };
    }

    /**
     * Calculate bounding box for this layer
     * @param includeAnchors - If true, include anchors in the bounding box calculation (default: false)
     * @returns Bounding box {minX, minY, maxX, maxY, width, height} or null if no geometry
     */
    getBoundingBox(includeAnchors: boolean = false): {
        minX: number;
        minY: number;
        maxX: number;
        maxY: number;
        width: number;
        height: number;
    } | null {
        // Navigate up to Font to enable component lookup
        const glyph = this.parent() as Glyph;
        const font = glyph ? (glyph.parent() as Font) : undefined;

        // Get the master ID from tagged layer data
        const masterId = this.data.master?.master;

        return Layer.calculateBoundingBox(
            this.data,
            includeAnchors,
            font,
            masterId
        );
    }

    /**
     * Calculate intersections between a line segment and all paths in this layer
     * @param p1 - First point {x, y} of the line segment
     * @param p2 - Second point {x, y} of the line segment
     * @param includeComponents - If true, include component paths (default: false)
     * @returns Array of intersection points sorted by distance from p1, each with {x, y, t} where t is the parameter along the line (0 at p1, 1 at p2)
     */
    getIntersectionsOnLine(
        p1: { x: number; y: number },
        p2: { x: number; y: number },
        includeComponents: boolean = false
    ): Array<{ x: number; y: number; t: number }> {
        const intersections: Array<{ x: number; y: number; t: number }> = [];

        // Get all paths including components if requested
        const paths = includeComponents
            ? this.getAllPaths()
            : this.getDirectPaths();

        // Create a line object for intersections
        const line = {
            p1: { x: p1.x, y: p1.y },
            p2: { x: p2.x, y: p2.y }
        };

        // Process each path
        for (const path of paths) {
            if (!path.nodes || !Array.isArray(path.nodes)) continue;

            // Use the reusable segment processor
            const segments = Layer.processPathSegments({
                nodes: path.nodes,
                closed: path.closed
            });

            // Process each segment
            for (const segment of segments) {
                // Validate segment points before creating Bezier
                if (
                    !segment ||
                    !segment.points ||
                    !Array.isArray(segment.points) ||
                    segment.points.length < 2
                ) {
                    continue;
                }

                // Check all points are valid
                let allPointsValid = true;
                for (const pt of segment.points) {
                    if (
                        !pt ||
                        typeof pt.x !== 'number' ||
                        typeof pt.y !== 'number'
                    ) {
                        allPointsValid = false;
                        break;
                    }
                }

                if (!allPointsValid) {
                    continue;
                }

                try {
                    // Handle line-line intersection manually (bezier-js doesn't detect these reliably)
                    if (
                        segment.type === 'line' &&
                        segment.points.length === 2
                    ) {
                        const s1 = segment.points[0];
                        const s2 = segment.points[1];

                        // Line-line intersection formula
                        // Line 1 (segment): s1 to s2
                        // Line 2 (test line): p1 to p2
                        const denom =
                            (p2.y - p1.y) * (s2.x - s1.x) -
                            (p2.x - p1.x) * (s2.y - s1.y);

                        // Check if lines are parallel (or coincident)
                        if (Math.abs(denom) > 1e-10) {
                            const ua =
                                ((p2.x - p1.x) * (s1.y - p1.y) -
                                    (p2.y - p1.y) * (s1.x - p1.x)) /
                                denom;
                            const ub =
                                ((s2.x - s1.x) * (s1.y - p1.y) -
                                    (s2.y - s1.y) * (s1.x - p1.x)) /
                                denom;

                            // Check if intersection is within both line segments (0 <= t <= 1)
                            if (ua >= 0 && ua <= 1 && ub >= 0 && ub <= 1) {
                                const point = {
                                    x: s1.x + ua * (s2.x - s1.x),
                                    y: s1.y + ua * (s2.y - s1.y)
                                };

                                intersections.push({
                                    x: point.x,
                                    y: point.y,
                                    t: ub // t on the test line
                                });
                            }
                        }

                        // Skip bezier-js for line segments
                        continue;
                    }

                    // Create Bezier curve from segment points
                    const curve = new Bezier(segment.points);

                    // Find intersections between this curve segment and the line
                    const curveIntersections = curve.intersects(line as Unsafe);

                    if (Array.isArray(curveIntersections)) {
                        for (const result of curveIntersections) {
                            let point: { x: number; y: number };
                            let tOnLine: number;

                            if (typeof result === 'string') {
                                // Format: "t1/t2" where t1 is t on curve, t2 is t on line
                                const parts = result.split('/');
                                tOnLine = parseFloat(parts[1]);
                                point = {
                                    x: p1.x + tOnLine * (p2.x - p1.x),
                                    y: p1.y + tOnLine * (p2.y - p1.y)
                                };
                            } else {
                                // Single number
                                // For line-line intersections, this is t on the line being tested
                                // For curve-line intersections, this is t on the curve
                                if (segment.type === 'line') {
                                    // Line-line intersection: result is t on the line being tested
                                    tOnLine = result;
                                    point = {
                                        x: p1.x + tOnLine * (p2.x - p1.x),
                                        y: p1.y + tOnLine * (p2.y - p1.y)
                                    };
                                } else {
                                    // Curve-line intersection: result is t on the curve
                                    // Get the point on the curve at this t value
                                    const curvePoint = curve.get(result);
                                    point = {
                                        x: curvePoint.x,
                                        y: curvePoint.y
                                    };

                                    // Calculate t on the line
                                    // For horizontal line: t = (x - x1) / (x2 - x1)
                                    // For vertical line: t = (y - y1) / (y2 - y1)
                                    if (
                                        Math.abs(p2.x - p1.x) >
                                        Math.abs(p2.y - p1.y)
                                    ) {
                                        // More horizontal than vertical
                                        tOnLine =
                                            (point.x - p1.x) / (p2.x - p1.x);
                                    } else {
                                        // More vertical than horizontal
                                        tOnLine =
                                            (point.y - p1.y) / (p2.y - p1.y);
                                    }
                                }
                            }

                            intersections.push({
                                x: point.x,
                                y: point.y,
                                t: tOnLine
                            });
                        }
                    }
                } catch (e) {
                    // Skip segments that cause errors
                    continue;
                }
            }
        }

        // Remove duplicate intersections (can occur when paths share exact endpoints)
        const uniqueIntersections: Array<{ x: number; y: number; t: number }> =
            [];
        for (const intersection of intersections) {
            const isDuplicate = uniqueIntersections.some(
                (existing) =>
                    Math.abs(existing.x - intersection.x) < 0.001 &&
                    Math.abs(existing.y - intersection.y) < 0.001 &&
                    Math.abs(existing.t - intersection.t) < 0.001
            );
            if (!isDuplicate) {
                uniqueIntersections.push(intersection);
            }
        }

        // Sort intersections by t parameter (distance along line from p1)
        uniqueIntersections.sort((a, b) => a.t - b.t);

        return uniqueIntersections;
    }

    /**
     * Calculate sidebearings at a given Y height by measuring distance from glyph edges to first/last outline intersections
     * @param y - Y coordinate at which to measure
     * @returns Object with left and right sidebearing distances, or null if no intersections found at this height. Negative values indicate outline extends beyond glyph edges.
     */
    getSidebearingsAtHeight(y: number): {
        left: number;
        right: number;
    } | null {
        const glyphWidth = this.width;

        // Define horizontal line extending far beyond glyph bounds
        const lineP1 = { x: -10000, y: y };
        const lineP2 = { x: glyphWidth + 10000, y: y };

        // Use existing getIntersectionsOnLine method with components included
        const intersections = this.getIntersectionsOnLine(lineP1, lineP2, true);

        if (intersections.length === 0) {
            return null;
        }

        // Sort by X coordinate
        intersections.sort((a, b) => a.x - b.x);

        const firstIntersection = intersections[0];
        const lastIntersection = intersections[intersections.length - 1];

        // Calculate distances from glyph edges
        const leftSidebearing = firstIntersection.x - 0;
        const rightSidebearing = glyphWidth - lastIntersection.x;

        return {
            left: leftSidebearing,
            right: rightSidebearing
        };
    }

    /**
     * Find the exact matching stored layer on another glyph for this layer's
     * effective designspace location.
     */
    getMatchingLayerOnGlyph(glyphName: string): Layer | undefined {
        const font = this.getFont();
        const designspaceLocation = this.getEffectiveDesignspaceLocation();
        if (!font || !designspaceLocation) {
            return undefined;
        }

        const targetGlyph = font.findGlyph(glyphName);
        if (!targetGlyph || !targetGlyph.layers) {
            return undefined;
        }

        for (const layer of targetGlyph.layers) {
            if (
                locationsMatch(
                    designspaceLocation,
                    layer.getEffectiveDesignspaceLocation(),
                    font.axes
                )
            ) {
                return layer;
            }
        }

        return undefined;
    }

    toString(): string {
        const masterId = this.getMasterId() || 'Unsafe';
        const shapesCount = this.shapes?.length || 0;
        return `<Layer width=${this.width} master="${masterId}" shapes=${shapesCount}>`;
    }
}

function getAppliedMetricsKeySidebearing(
    layer: Layer,
    side: SidebearingSide,
    resolution: MetricsKeyResolution
): { value: number | null; error: string | null } {
    if (resolution.error || resolution.value === null) {
        return {
            value: null,
            error: resolution.error ?? 'Invalid metrics-key calculation'
        };
    }

    const font = (layer.parent() as Glyph | undefined)?.parent() as
        | Font
        | undefined;
    if (!font || !resolution.input) {
        return { value: resolution.value, error: null };
    }

    const parsed = parseMetricsKey(font, resolution.input);
    if (
        'error' in parsed ||
        parsed.kind !== 'reference' ||
        parsed.offsetY === null
    ) {
        return { value: resolution.value, error: null };
    }

    const measured = layer.getSidebearingsAtHeight(parsed.offsetY);
    if (!measured) {
        return {
            value: null,
            error: `Could not measure current sidebearings at height ${parsed.offsetY}`
        };
    }

    const measuredSidebearing =
        side === 'left' ? measured.left : measured.right;
    const directSidebearing = side === 'left' ? layer.lsb : layer.rsb;

    return {
        value: roundMetricValue(
            directSidebearing + (resolution.value - measuredSidebearing)
        ),
        error: null
    };
}

/**
 * Glyph in the font
 */
export class Glyph extends ArrayElementBase {
    private _layerWrappers: Layer[] | null = null;

    private getGlobalSidebearingKey(side: SidebearingSide): string | undefined {
        return normalizeMetricsKeyValue(
            getModelFormatSpecific(this)?.[
                getGlyphMetricFormatSpecificKey(side)
            ] as string | undefined
        );
    }

    private setGlobalSidebearingKey(
        side: SidebearingSide,
        value: string | undefined
    ): void {
        setFormatSpecificKey(
            this,
            getGlyphMetricFormatSpecificKey(side),
            value
        );
    }

    get leftMetricsKey(): string | undefined {
        return this.getGlobalSidebearingKey('left');
    }

    set leftMetricsKey(value: string | undefined) {
        this.setGlobalSidebearingKey('left', normalizeMetricsKeyValue(value));
    }

    get rightMetricsKey(): string | undefined {
        return this.getGlobalSidebearingKey('right');
    }

    set rightMetricsKey(value: string | undefined) {
        this.setGlobalSidebearingKey('right', normalizeMetricsKeyValue(value));
    }

    getPathSegment(): (string | number)[] {
        return ['glyphs', this.data.name || ''];
    }

    private static readonly BUILTIN_CATEGORIES = new Set([
        'Base',
        'Mark',
        'Unknown',
        'Ligature'
    ]);

    static normalizeCategory(
        value: Babelfont.GlyphCategory | string | undefined
    ): Babelfont.GlyphCategory {
        if (
            typeof value === 'object' &&
            value !== null &&
            'Custom' in value &&
            typeof (value as { Custom?: Unsafe }).Custom === 'string'
        ) {
            return value as Babelfont.GlyphCategory;
        }

        if (typeof value === 'string') {
            return Glyph.BUILTIN_CATEGORIES.has(value)
                ? (value as Babelfont.GlyphCategory)
                : { Custom: value };
        }

        return 'Unknown';
    }

    private static normalizeNodeType(nodeType: string | undefined): string {
        switch (nodeType) {
            case 'Move':
            case 'Line':
            case 'OffCurve':
            case 'Curve':
            case 'QCurve':
                return nodeType;
            default:
                return String(nodeType || 'Unknown');
        }
    }

    private getLayerIdentifier(layer: Layer): string {
        return layer.id || layer.master?.master || '[Unsafe-layer]';
    }

    private getNormalizedLayerShapeStructure(layer: Layer): string[] {
        const shapes = layer.shapes || [];
        const componentSignatures: string[] = [];
        const pathSignatures: string[] = [];

        for (const shape of shapes) {
            if (shape.isComponent()) {
                const component = shape.asComponent();
                componentSignatures.push(`C:${component.reference || ''}`);
                continue;
            }

            if (shape.isPath()) {
                const path = shape.asPath();
                const nodeTypes = path.nodes.map((node) =>
                    Glyph.normalizeNodeType(node.nodetype)
                );
                const closedFlag = path.closed === false ? '0' : '1';
                pathSignatures.push(
                    `P:${closedFlag}:${nodeTypes.length}:${nodeTypes.join(',')}`
                );
            }
        }

        // Normalize mixed shape ordering by comparing components first,
        // then paths, while preserving relative order within each type.
        return [...componentSignatures, ...pathSignatures];
    }

    get name(): string {
        return this.data.name;
    }

    set name(value: string) {
        const old = this.data.name;
        this.data.name = value;
        recordAndMarkDirty(this, 'name', old, value);
    }

    get production_name(): string | undefined {
        return this.data.production_name;
    }

    set production_name(value: string | undefined) {
        const old = this.data.production_name;
        this.data.production_name = value;
        recordAndMarkDirty(this, 'production_name', old, value);
    }

    get category(): Babelfont.GlyphCategory {
        return getLiveMutableValue(
            this,
            'category',
            Glyph.normalizeCategory(this.data.category),
            () => Glyph.normalizeCategory(this.data.category)
        );
    }

    set category(value: Babelfont.GlyphCategory | string) {
        const old = this.data.category;
        this.data.category = Glyph.normalizeCategory(value);
        recordAndMarkDirty(this, 'category', old, this.data.category);
    }

    get codepoints(): number[] | undefined {
        return getLiveMutableValue(
            this,
            'codepoints',
            this.data.codepoints,
            () => this.data.codepoints
        );
    }

    set codepoints(value: number[] | undefined) {
        const old = this.data.codepoints;
        this.data.codepoints = value;
        recordAndMarkDirty(this, 'codepoints', old, value);
    }

    get layers(): Layer[] | undefined {
        if (!this.data.layers) return undefined;

        // Get font masters to filter and sort layers
        // Navigate up to Font object via parent chain
        const font = this.parent() as Font;
        const fontMasters = font?.masters;
        if (!fontMasters || fontMasters.length === 0) {
            // Fallback: return all layers if we can't access font data
            if (
                !this._layerWrappers ||
                this._layerWrappers.length !== this.data.layers.length
            ) {
                this._layerWrappers = this.data.layers.map(
                    (_: Unsafe, i: number) =>
                        new Layer(this.data.layers, i, this)
                );
            }
            return getReadOnlyCollectionValue(
                this._layerWrappers!,
                'Glyph.layers is a read-only collection view. Use addLayer() or removeLayer() for structural edits.'
            );
        }

        // Filter: foreground layers that are either
        // - default layers for their master, or
        // - brace layers (AssociatedWithMaster + non-empty location)
        const masterIds = new Set(fontMasters.map((m: Master) => m.id));
        const filteredIndices: number[] = [];

        for (let i = 0; i < this.data.layers.length; i++) {
            const layer = this.data.layers[i];

            const layerId = layer.id || '[no-layer-id]';
            assertTaggedLayerMaster(
                layer.master,
                `Glyph#${this.name}.${layerId}`
            );

            // Skip background layers
            if (layer.is_background) continue;

            const isDefaultLayer =
                layer.master &&
                typeof layer.master === 'object' &&
                'type' in layer.master &&
                layer.master.type === 'DefaultForMaster';

            const isAssociatedLayer =
                layer.master &&
                typeof layer.master === 'object' &&
                'type' in layer.master &&
                layer.master.type === 'AssociatedWithMaster';

            const hasBraceLocation =
                !!layer.location && Object.keys(layer.location).length > 0;

            if (!isDefaultLayer && !(isAssociatedLayer && hasBraceLocation)) {
                continue;
            }

            let masterId: string | undefined;
            if (layer.master && typeof layer.master === 'object') {
                if ('type' in layer.master) {
                    masterId = (layer.master as Unsafe).master;
                }
            }
            if (!masterId) {
                masterId = layer._master || layer.id;
            }

            if (!masterId || !masterIds.has(masterId)) continue;

            filteredIndices.push(i);
        }

        // Create wrappers for filtered layers
        const wrappers = filteredIndices.map(
            (i: number) => new Layer(this.data.layers, i, this)
        );

        // Sort by master order.
        // Within one master, keep default layer first and brace layers after it.
        wrappers.sort((a, b) => {
            const getMasterId = (layer: Layer): string => {
                const masterData = layer.master;
                if (masterData && typeof masterData === 'object') {
                    if ('type' in masterData) {
                        return (masterData as Unsafe).master || '';
                    }
                }
                return layer.id || '';
            };

            const getLayerTypeRank = (layer: Layer): number => {
                const masterData = layer.master;
                if (
                    masterData &&
                    typeof masterData === 'object' &&
                    'type' in masterData &&
                    masterData.type === 'DefaultForMaster'
                ) {
                    return 0;
                }
                return 1;
            };

            const masterIdA = getMasterId(a);
            const masterIdB = getMasterId(b);

            const masterIndexA = fontMasters.findIndex(
                (m: Master) => m.id === masterIdA
            );
            const masterIndexB = fontMasters.findIndex(
                (m: Master) => m.id === masterIdB
            );

            const posA =
                masterIndexA === -1 ? fontMasters.length : masterIndexA;
            const posB =
                masterIndexB === -1 ? fontMasters.length : masterIndexB;

            if (posA !== posB) {
                return posA - posB;
            }

            const typeRankA = getLayerTypeRank(a);
            const typeRankB = getLayerTypeRank(b);
            if (typeRankA !== typeRankB) {
                return typeRankA - typeRankB;
            }

            return 0;
        });

        return getReadOnlyCollectionValue(
            wrappers,
            'Glyph.layers is a read-only collection view. Use addLayer() or removeLayer() for structural edits.'
        );
    }

    get exported(): boolean | undefined {
        return this.data.exported;
    }

    set exported(value: boolean | undefined) {
        const old = this.data.exported;
        this.data.exported = value;
        recordAndMarkDirty(this, 'exported', old, value);
    }

    get direction(): Babelfont.Direction | undefined {
        return this.data.direction;
    }

    set direction(value: Babelfont.Direction | undefined) {
        const old = this.data.direction;
        this.data.direction = value;
        recordAndMarkDirty(this, 'direction', old, value);
    }

    get format_specific(): Record<string, Unsafe> | undefined {
        return getLiveMutableValue(
            this,
            'format_specific',
            this.data.format_specific,
            () => this.data.format_specific
        );
    }

    set format_specific(value: Record<string, Unsafe> | undefined) {
        const old = this.data.format_specific;
        this.data.format_specific = value;
        recordAndMarkDirty(this, 'format_specific', old, value);
    }

    /**
     * Add a new layer to the glyph
     * @example
     * layer = glyph.addLayer(500)  # 500 units wide
     */
    addLayer(width: number, master?: Babelfont.LayerType): Layer {
        if (!this.data.layers) {
            this.data.layers = [];
        }

        // Generate a unique ID for the layer
        let layerId: string;
        const existingIds = new Set(
            this.data.layers.map((l: Unsafe) => l.id).filter((id: Unsafe) => id)
        );
        do {
            layerId = crypto.randomUUID();
        } while (existingIds.has(layerId));

        const layerData: Babelfont.Layer = { width, id: layerId };
        if (master) {
            layerData.master = master;
        }
        this.data.layers.push(layerData);
        this._layerWrappers = null; // Invalidate cache
        recordAddAndMarkDirty(
            [...this.getPath(), 'layers', layerId],
            layerData
        );
        return new Layer(this.data.layers, this.data.layers.length - 1, this);
    }

    /**
     * Remove a layer at the specified index
     */
    removeLayer(index: number): void {
        if (this.data.layers) {
            const removedLayer = this.data.layers[index];
            if (removedLayer === undefined) {
                return;
            }

            this.data.layers.splice(index, 1);
            this._layerWrappers = null; // Invalidate cache
            const layerKey = removedLayer.id ?? index;
            recordRemoveAndMarkDirty(
                [...this.getPath(), 'layers', layerKey],
                removedLayer
            );
        }
    }

    /**
     * Find a layer by ID
     */
    findLayerById(id: string): Layer | undefined {
        const index = this.data.layers.findIndex((l: Unsafe) => l.id === id);
        return index >= 0
            ? new Layer(this.data.layers, index, this)
            : undefined;
    }

    /**
     * Find a layer by master ID
     */
    findLayerByMasterId(masterId: string): Layer | undefined {
        const index = this.data.layers.findIndex((l: Unsafe) => {
            const master = l.master;
            if (!master) return false;
            if (typeof master === 'object') {
                if (
                    master.type === 'DefaultForMaster' &&
                    master.master === masterId
                ) {
                    return true;
                }
                if (
                    master.type === 'AssociatedWithMaster' &&
                    master.master === masterId
                ) {
                    return true;
                }
            }
            return false;
        });
        return index >= 0
            ? new Layer(this.data.layers, index, this)
            : undefined;
    }

    /**
     * Compare outline structure across main layers (the same list shown in the UI).
     *
     * For compatibility checks, mixed shape sequences are normalized by moving
     * components before paths while preserving their relative order inside each type.
     */
    calculateOutlineCompatibility(): {
        compatible: boolean;
        layerCount: number;
        referenceLayerId?: string;
        incompatibleLayerIds: string[];
    } {
        const layers = this.layers || [];
        if (layers.length === 0) {
            return {
                compatible: true,
                layerCount: 0,
                incompatibleLayerIds: []
            };
        }

        if (layers.length === 1) {
            return {
                compatible: true,
                layerCount: 1,
                referenceLayerId: this.getLayerIdentifier(layers[0]),
                incompatibleLayerIds: []
            };
        }

        const referenceLayer = layers[0];
        const referenceLayerId = this.getLayerIdentifier(referenceLayer);
        const referenceSignature =
            this.getNormalizedLayerShapeStructure(referenceLayer);
        const incompatibleLayerIds: string[] = [];

        for (let i = 1; i < layers.length; i++) {
            const layer = layers[i];
            const signature = this.getNormalizedLayerShapeStructure(layer);

            const isCompatible =
                signature.length === referenceSignature.length &&
                signature.every(
                    (item, index) => item === referenceSignature[index]
                );

            if (!isCompatible) {
                incompatibleLayerIds.push(this.getLayerIdentifier(layer));
            }
        }

        return {
            compatible: incompatibleLayerIds.length === 0,
            layerCount: layers.length,
            referenceLayerId,
            incompatibleLayerIds
        };
    }

    toString(): string {
        const codepoints =
            this.codepoints
                ?.map(
                    (cp) =>
                        `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`
                )
                .join(', ') || 'none';
        const layerCount = this.layers?.length || 0;
        return `<Glyph "${this.name}" [${codepoints}] ${layerCount} layers>`;
    }
}

/**
 * Variation axis in a variable font
 */
export class Axis extends ArrayElementBase {
    getPathSegment(): (string | number)[] {
        return ['axes', this._index];
    }

    get name(): Babelfont.I18NDictionary {
        return getLiveMutableValue(
            this,
            'name',
            this.data.name,
            () => this.data.name
        );
    }

    set name(value: Babelfont.I18NDictionary) {
        const old = this.data.name;
        this.data.name = value;
        recordAndMarkDirty(this, 'name', old, value);
    }

    get tag(): string {
        return this.data.tag;
    }

    set tag(value: string) {
        const old = this.data.tag;
        this.data.tag = value;
        recordAndMarkDirty(this, 'tag', old, value);
    }

    get id(): string {
        return this.data.id;
    }

    set id(value: string) {
        const old = this.data.id;
        this.data.id = value;
        recordAndMarkDirty(this, 'id', old, value);
    }

    get min(): number | undefined {
        return this.data.min;
    }

    set min(value: number | undefined) {
        const old = this.data.min;
        this.data.min = value;
        recordAndMarkDirty(this, 'min', old, value);
    }

    get max(): number | undefined {
        return this.data.max;
    }

    set max(value: number | undefined) {
        const old = this.data.max;
        this.data.max = value;
        recordAndMarkDirty(this, 'max', old, value);
    }

    get default(): number | undefined {
        return this.data.default;
    }

    set default(value: number | undefined) {
        const old = this.data.default;
        this.data.default = value;
        recordAndMarkDirty(this, 'default', old, value);
    }

    get map(): [number, number][] | undefined {
        return getLiveMutableValue(
            this,
            'map',
            this.data.map,
            () => this.data.map
        );
    }

    set map(value: [number, number][] | undefined) {
        const old = this.data.map;
        this.data.map = value;
        recordAndMarkDirty(this, 'map', old, value);
    }

    get hidden(): boolean | undefined {
        return this.data.hidden;
    }

    set hidden(value: boolean | undefined) {
        const old = this.data.hidden;
        this.data.hidden = value;
        recordAndMarkDirty(this, 'hidden', old, value);
    }

    get values(): number[] | undefined {
        return getLiveMutableValue(
            this,
            'values',
            this.data.values,
            () => this.data.values
        );
    }

    set values(value: number[] | undefined) {
        const old = this.data.values;
        this.data.values = value;
        recordAndMarkDirty(this, 'values', old, value);
    }

    get format_specific(): Record<string, Unsafe> | undefined {
        return getLiveMutableValue(
            this,
            'format_specific',
            this.data.format_specific,
            () => this.data.format_specific
        );
    }

    set format_specific(value: Record<string, Unsafe> | undefined) {
        const old = this.data.format_specific;
        this.data.format_specific = value;
        recordAndMarkDirty(this, 'format_specific', old, value);
    }

    toString(): string {
        const displayName =
            typeof this.name === 'string'
                ? this.name
                : this.name?.en ||
                  Object.values(this.name || {})[0] ||
                  'Unsafe';
        const range = `${this.min || '?'}-${this.default || '?'}-${this.max || '?'}`;
        return `<Axis "${displayName}" tag="${this.tag}" ${range}>`;
    }
}

/**
 * Master/source in a design space
 */
export class Master extends ArrayElementBase {
    private _guideWrappers: Guide[] | null = null;

    getPathSegment(): (string | number)[] {
        return ['masters', this._index];
    }

    get name(): Babelfont.I18NDictionary {
        return getLiveMutableValue(
            this,
            'name',
            this.data.name,
            () => this.data.name
        );
    }

    set name(value: Babelfont.I18NDictionary) {
        const old = this.data.name;
        this.data.name = value;
        recordAndMarkDirty(this, 'name', old, value);
    }

    get id(): string {
        return this.data.id;
    }

    set id(value: string) {
        const old = this.data.id;
        this.data.id = value;
        recordAndMarkDirty(this, 'id', old, value);
    }

    get location(): Record<string, number> | undefined {
        return getLiveMutableValue(
            this,
            'location',
            this.data.location,
            () => this.data.location
        );
    }

    set location(value: Record<string, number> | undefined) {
        const old = this.data.location;
        this.data.location = value;
        recordAndMarkDirty(this, 'location', old, value);
    }

    get guides(): Guide[] | undefined {
        if (!this.data.guides) return undefined;
        if (
            !this._guideWrappers ||
            this._guideWrappers.length !== this.data.guides.length
        ) {
            this._guideWrappers = this.data.guides.map(
                (_: Unsafe, i: number) => new Guide(this.data.guides, i, this)
            );
        }
        return getReadOnlyCollectionValue(
            this._guideWrappers!,
            'Master.guides is a read-only collection view. Use addGuide() or removeGuide() for structural edits.'
        );
    }

    addGuide(
        pos: Babelfont.Position,
        name?: string,
        color?: Babelfont.Color
    ): Guide {
        if (!this.data.guides) {
            this.data.guides = [];
        }

        const guideData: Babelfont.Guide = { pos };
        if (name !== undefined) {
            guideData.name = name;
        }
        if (color !== undefined) {
            guideData.color = color;
        }

        this.data.guides.push(guideData);
        this._guideWrappers = null;
        const index = this.data.guides.length - 1;
        recordAddAndMarkDirty([...this.getPath(), 'guides', index], guideData);
        return new Guide(this.data.guides, index, this);
    }

    removeGuide(index: number): void {
        if (this.data.guides) {
            const removedGuide = this.data.guides[index];
            if (removedGuide === undefined) {
                return;
            }

            this.data.guides.splice(index, 1);
            this._guideWrappers = null;
            recordRemoveAndMarkDirty(
                [...this.getPath(), 'guides', index],
                removedGuide
            );
        }
    }

    get metrics(): Record<string, number> {
        return getLiveMutableValue(
            this,
            'metrics',
            this.data.metrics,
            () => this.data.metrics
        );
    }

    set metrics(value: Record<string, number>) {
        const old = this.data.metrics;
        this.data.metrics = value;
        recordAndMarkDirty(this, 'metrics', old, value);
    }

    get kerning(): Record<string, Record<string, number>> {
        return getLiveMutableValue(
            this,
            'kerning',
            this.data.kerning,
            () => this.data.kerning
        );
    }

    set kerning(value: Record<string, Record<string, number>>) {
        const old = this.data.kerning;
        this.data.kerning = value;
        recordAndMarkDirty(this, 'kerning', old, value);
    }

    get custom_ot_values(): Unsafe[] | undefined {
        return getLiveMutableValue(
            this,
            'custom_ot_values',
            this.data.custom_ot_values,
            () => this.data.custom_ot_values
        );
    }

    set custom_ot_values(value: Unsafe[] | undefined) {
        const old = this.data.custom_ot_values;
        this.data.custom_ot_values = value;
        recordAndMarkDirty(this, 'custom_ot_values', old, value);
    }

    get format_specific(): Record<string, Unsafe> | undefined {
        return getLiveMutableValue(
            this,
            'format_specific',
            this.data.format_specific,
            () => this.data.format_specific
        );
    }

    set format_specific(value: Record<string, Unsafe> | undefined) {
        const old = this.data.format_specific;
        this.data.format_specific = value;
        recordAndMarkDirty(this, 'format_specific', old, value);
    }

    toString(): string {
        const displayName =
            typeof this.name === 'string'
                ? this.name
                : this.name?.en ||
                  Object.values(this.name || {})[0] ||
                  'Unsafe';
        const location = this.location ? JSON.stringify(this.location) : '{}';
        return `<Master "${displayName}" id="${this.id}" location=${location}>`;
    }
}

/**
 * Named instance in a variable font
 */
export class Instance extends ArrayElementBase {
    getPathSegment(): (string | number)[] {
        return ['instances', this._index];
    }

    get id(): string {
        return this.data.id;
    }

    set id(value: string) {
        const old = this.data.id;
        this.data.id = value;
        recordAndMarkDirty(this, 'id', old, value);
    }

    get name(): Babelfont.I18NDictionary {
        return getLiveMutableValue(
            this,
            'name',
            this.data.name,
            () => this.data.name
        );
    }

    set name(value: Babelfont.I18NDictionary) {
        const old = this.data.name;
        this.data.name = value;
        recordAndMarkDirty(this, 'name', old, value);
    }

    get location(): Record<string, number> | undefined {
        return getLiveMutableValue(
            this,
            'location',
            this.data.location,
            () => this.data.location
        );
    }

    set location(value: Record<string, number> | undefined) {
        const old = this.data.location;
        this.data.location = value;
        recordAndMarkDirty(this, 'location', old, value);
    }

    get custom_names(): Babelfont.Names {
        return getLiveMutableValue(
            this,
            'custom_names',
            this.data.custom_names,
            () => this.data.custom_names
        );
    }

    set custom_names(value: Babelfont.Names) {
        const old = this.data.custom_names;
        this.data.custom_names = value;
        recordAndMarkDirty(this, 'custom_names', old, value);
    }

    get variable(): boolean | undefined {
        return this.data.variable;
    }

    set variable(value: boolean | undefined) {
        const old = this.data.variable;
        this.data.variable = value;
        recordAndMarkDirty(this, 'variable', old, value);
    }

    get linked_style(): string | undefined {
        return this.data.linked_style;
    }

    set linked_style(value: string | undefined) {
        const old = this.data.linked_style;
        this.data.linked_style = value;
        recordAndMarkDirty(this, 'linked_style', old, value);
    }

    get format_specific(): Record<string, Unsafe> | undefined {
        return getLiveMutableValue(
            this,
            'format_specific',
            this.data.format_specific,
            () => this.data.format_specific
        );
    }

    set format_specific(value: Record<string, Unsafe> | undefined) {
        const old = this.data.format_specific;
        this.data.format_specific = value;
        recordAndMarkDirty(this, 'format_specific', old, value);
    }

    toString(): string {
        const displayName =
            typeof this.name === 'string'
                ? this.name
                : this.name?.en ||
                  Object.values(this.name || {})[0] ||
                  'Unsafe';
        const location = this.location ? JSON.stringify(this.location) : '{}';
        return `<Instance "${displayName}" location=${location}>`;
    }
}

/**
 * The main font class representing a complete font
 */
export class Font extends ModelBase {
    private _glyphWrappers: Glyph[] | null = null;
    private _axisWrappers: Axis[] | null = null;
    private _masterWrappers: Master[] | null = null;
    private _instanceWrappers: Instance[] | null = null;
    private _isRecomputingMetricsKeys = false;

    constructor(data: Babelfont.Font) {
        super(data);
    }

    get upm(): number {
        return this._data.upm;
    }

    set upm(value: number) {
        const old = this._data.upm;
        this._data.upm = value;
        recordAndMarkDirty(this, 'upm', old, value);
    }

    get version(): [number, number] {
        return getLiveMutableValue(
            this,
            'version',
            this._data.version,
            () => this._data.version
        );
    }

    set version(value: [number, number]) {
        const old = this._data.version;
        this._data.version = value;
        recordAndMarkDirty(this, 'version', old, value);
    }

    get axes(): Axis[] | undefined {
        if (!this._data.axes) return undefined;
        if (
            !this._axisWrappers ||
            this._axisWrappers.length !== this._data.axes.length
        ) {
            this._axisWrappers = this._data.axes.map(
                (_: Unsafe, i: number) => new Axis(this._data.axes, i, this)
            );
        }
        return getReadOnlyCollectionValue(
            this._axisWrappers!,
            'Font.axes is a read-only collection view. Direct structural mutation is not supported.'
        );
    }

    get instances(): Instance[] | undefined {
        if (!this._data.instances) return undefined;
        if (
            !this._instanceWrappers ||
            this._instanceWrappers.length !== this._data.instances.length
        ) {
            this._instanceWrappers = this._data.instances.map(
                (_: Unsafe, i: number) =>
                    new Instance(this._data.instances, i, this)
            );
        }
        return getReadOnlyCollectionValue(
            this._instanceWrappers!,
            'Font.instances is a read-only collection view. Direct structural mutation is not supported.'
        );
    }

    get masters(): Master[] | undefined {
        if (!this._data.masters) return undefined;
        if (
            !this._masterWrappers ||
            this._masterWrappers.length !== this._data.masters.length
        ) {
            this._masterWrappers = this._data.masters.map(
                (_: Unsafe, i: number) =>
                    new Master(this._data.masters, i, this)
            );
        }
        return getReadOnlyCollectionValue(
            this._masterWrappers!,
            'Font.masters is a read-only collection view. Direct structural mutation is not supported.'
        );
    }

    get glyphs(): Glyph[] {
        if (
            !this._glyphWrappers ||
            this._glyphWrappers.length !== this._data.glyphs.length
        ) {
            this._glyphWrappers = this._data.glyphs.map(
                (_: Unsafe, i: number) => new Glyph(this._data.glyphs, i, this)
            );
        }
        return getReadOnlyCollectionValue(
            this._glyphWrappers!,
            'Font.glyphs is a read-only collection view. Use addGlyph(), removeGlyph(), or duplicateGlyph() for structural edits.'
        );
    }

    recomputeMetricsKeys(changedGlyphNames?: Set<string>): Set<string> {
        if (this._isRecomputingMetricsKeys) {
            return new Set();
        }

        const layersWithKeys: Layer[] = [];
        for (const glyph of this.glyphs) {
            for (const layer of glyph.layers || []) {
                if (
                    layer.leftMetricsKey ||
                    layer.rightMetricsKey ||
                    glyph.leftMetricsKey ||
                    glyph.rightMetricsKey
                ) {
                    layersWithKeys.push(layer);
                }
            }
        }

        if (layersWithKeys.length === 0) {
            return new Set();
        }

        this._isRecomputingMetricsKeys = true;
        const recomputedGlyphNames = new Set<string>();
        try {
            let pendingGlyphNames =
                changedGlyphNames && changedGlyphNames.size > 0
                    ? new Set(changedGlyphNames)
                    : new Set(this.glyphs.map((glyph) => glyph.name));

            const processedGlyphNames = new Set<string>();
            const maxPasses = Math.max(layersWithKeys.length + 2, 4);

            for (
                let pass = 0;
                pass < maxPasses && pendingGlyphNames.size > 0;
                pass++
            ) {
                const autoAlignedDependents = new Set<string>();
                for (const glyphName of pendingGlyphNames) {
                    for (const dependentName of this.findGlyphsUsingComponent(
                        glyphName
                    )) {
                        autoAlignedDependents.add(dependentName);
                    }
                }

                const nextGlyphNames = new Set<string>();

                for (const layer of layersWithKeys) {
                    const glyph = layer.parent() as Glyph;
                    const glyphName = glyph?.name;
                    let layerChanged = false;

                    for (const side of ['left', 'right'] as SidebearingSide[]) {
                        const key =
                            side === 'left'
                                ? layer.leftMetricsKey || glyph.leftMetricsKey
                                : layer.rightMetricsKey ||
                                  glyph.rightMetricsKey;
                        if (!key) {
                            continue;
                        }

                        const parsed = parseMetricsKey(this, key);
                        if ('error' in parsed) {
                            continue;
                        }

                        const currentGlyphChanged =
                            pendingGlyphNames.has(glyphName);
                        const referencedGlyphChanged =
                            parsed.referencedGlyphNames.some((name) =>
                                pendingGlyphNames.has(name)
                            );

                        const shouldRecompute =
                            (parsed.kind === 'automatic-offset' &&
                                (autoAlignedDependents.has(glyphName) ||
                                    currentGlyphChanged)) ||
                            (parsed.kind !== 'automatic-offset' &&
                                (currentGlyphChanged ||
                                    referencedGlyphChanged));

                        if (!shouldRecompute) {
                            continue;
                        }

                        const resolution = layer.resolveMetricsKey(side);
                        const applied = getAppliedMetricsKeySidebearing(
                            layer,
                            side,
                            resolution
                        );
                        const currentValue =
                            side === 'left' ? layer.lsb : layer.rsb;
                        if (
                            applied.error ||
                            applied.value === null ||
                            Math.abs(currentValue - applied.value) <=
                                METRIC_UPDATE_EPSILON
                        ) {
                            continue;
                        }

                        layer.setDirectSidebearing(side, applied.value);
                        layerChanged = true;
                        if (glyphName) {
                            recomputedGlyphNames.add(glyphName);
                        }
                    }

                    if (
                        layerChanged &&
                        glyphName &&
                        !processedGlyphNames.has(glyphName)
                    ) {
                        nextGlyphNames.add(glyphName);
                    }
                }

                for (const glyphName of pendingGlyphNames) {
                    processedGlyphNames.add(glyphName);
                }

                pendingGlyphNames = new Set(
                    [...nextGlyphNames].filter(
                        (glyphName) => !processedGlyphNames.has(glyphName)
                    )
                );
            }

            return recomputedGlyphNames;
        } finally {
            this._isRecomputingMetricsKeys = false;
        }
    }

    get note(): string | undefined {
        return this._data.note;
    }

    set note(value: string | undefined) {
        const old = this._data.note;
        this._data.note = value;
        recordAndMarkDirty(this, 'note', old, value);
    }

    get date(): string {
        return this._data.date;
    }

    set date(value: string) {
        const old = this._data.date;
        this._data.date = value;
        recordAndMarkDirty(this, 'date', old, value);
    }

    get names(): Babelfont.Names {
        return getLiveMutableValue(
            this,
            'names',
            this._data.names,
            () => this._data.names
        );
    }

    set names(value: Babelfont.Names) {
        const old = this._data.names;
        this._data.names = value;
        recordAndMarkDirty(this, 'names', old, value);
    }

    get custom_ot_values(): Unsafe[] | undefined {
        return getLiveMutableValue(
            this,
            'custom_ot_values',
            this._data.custom_ot_values,
            () => this._data.custom_ot_values
        );
    }

    set custom_ot_values(value: Unsafe[] | undefined) {
        const old = this._data.custom_ot_values;
        this._data.custom_ot_values = value;
        recordAndMarkDirty(this, 'custom_ot_values', old, value);
    }

    get variation_sequences():
        | Record<number, Record<number, string>>
        | undefined {
        return getLiveMutableValue(
            this,
            'variation_sequences',
            this._data.variation_sequences,
            () => this._data.variation_sequences
        );
    }

    set variation_sequences(
        value: Record<number, Record<number, string>> | undefined
    ) {
        const old = this._data.variation_sequences;
        this._data.variation_sequences = value;
        recordAndMarkDirty(this, 'variation_sequences', old, value);
    }

    get features(): Babelfont.Features {
        return getPreciseLiveMutableValue(
            this.getPath().concat('features'),
            this._data.features,
            () => this._data.features
        );
    }

    set features(value: Babelfont.Features) {
        const old = this._data.features;
        this._data.features = value;
        recordAndMarkDirty(this, 'features', old, value);
    }

    get first_kern_groups(): Record<string, string[]> | undefined {
        return getLiveMutableValue(
            this,
            'first_kern_groups',
            this._data.first_kern_groups,
            () => this._data.first_kern_groups
        );
    }

    set first_kern_groups(value: Record<string, string[]> | undefined) {
        const old = this._data.first_kern_groups;
        this._data.first_kern_groups = value;
        recordAndMarkDirty(this, 'first_kern_groups', old, value);
    }

    get second_kern_groups(): Record<string, string[]> | undefined {
        return getLiveMutableValue(
            this,
            'second_kern_groups',
            this._data.second_kern_groups,
            () => this._data.second_kern_groups
        );
    }

    set second_kern_groups(value: Record<string, string[]> | undefined) {
        const old = this._data.second_kern_groups;
        this._data.second_kern_groups = value;
        recordAndMarkDirty(this, 'second_kern_groups', old, value);
    }

    get format_specific(): Record<string, Unsafe> | undefined {
        return getLiveMutableValue(
            this,
            'format_specific',
            this._data.format_specific,
            () => this._data.format_specific
        );
    }

    set format_specific(value: Record<string, Unsafe> | undefined) {
        const old = this._data.format_specific;
        this._data.format_specific = value;
        recordAndMarkDirty(this, 'format_specific', old, value);
    }

    get source(): string | null {
        return this._data.source;
    }

    set source(value: string | null) {
        const old = this._data.source;
        this._data.source = value;
        recordAndMarkDirty(this, 'source', old, value);
    }

    /**
     * Find a glyph by name
     * @example
     * glyph = font.findGlyph("A")
     * if glyph:
     *     print(glyph.name)
     */
    findGlyph(name: string): Glyph | undefined {
        const index = this._data.glyphs.findIndex(
            (g: Unsafe) => g.name === name
        );
        return index >= 0 ? this.glyphs[index] : undefined;
    }

    /**
     * Find a glyph by codepoint
     * @example
     * glyph = font.findGlyphByCodepoint(0x0041)  # Find 'A'
     */
    findGlyphByCodepoint(codepoint: number): Glyph | undefined {
        const index = this._data.glyphs.findIndex(
            (g: Unsafe) => g.codepoints && g.codepoints.includes(codepoint)
        );
        return index >= 0 ? this.glyphs[index] : undefined;
    }

    /**
     * Find all glyphs that reference a given glyph as a component
     * This recursively finds glyphs at each nesting level
     * @param componentGlyphName - Name of the component glyph to search for
     * @returns Array of glyph names that contain this component
     * @example
     * glyphs = font.findGlyphsUsingComponent("o")
     * # Returns ["ö", "õ", "ø", ...] if they use "o" as a component
     */
    findGlyphsUsingComponent(componentGlyphName: string): string[] {
        const affectedGlyphs = new Set<string>();

        // Helper function to check if a layer contains the component
        const layerContainsComponent = (layer: Unsafe): boolean => {
            if (!layer || !layer.shapes) return false;

            for (const shape of layer.shapes) {
                // Check if this shape is a component referencing the target
                if (shape && typeof shape === 'object') {
                    // Handle flat format: { reference: "glyphName" }
                    if (shape.reference === componentGlyphName) {
                        return true;
                    }
                    // Handle nested format: { Component: { reference: "glyphName" } }
                    if (
                        shape.Component &&
                        shape.Component.reference === componentGlyphName
                    ) {
                        return true;
                    }
                }
            }
            return false;
        };

        // Search through all glyphs
        for (const glyphData of this._data.glyphs) {
            if (!glyphData.layers) continue;

            // Check all layers of this glyph
            for (const layer of glyphData.layers) {
                if (layerContainsComponent(layer)) {
                    affectedGlyphs.add(glyphData.name);
                    break; // Found in one layer, no need to check others
                }
            }
        }

        return Array.from(affectedGlyphs);
    }

    /**
     * Duplicate a glyph with a new name
     * @example
     * new_glyph = font.duplicateGlyph(glyph, "A.alt")
     */
    duplicateGlyph(glyph: Glyph, newName: string): Glyph {
        // Check if glyph with newName already exists
        if (this.findGlyph(newName)) {
            throw new Error(`Glyph "${newName}" already exists in the font`);
        }

        // Get the source glyph data - access through the internal _data array
        const sourceGlyphIndex = this._data.glyphs.findIndex(
            (g: Unsafe) => g.name === glyph.name
        );
        if (sourceGlyphIndex < 0) {
            throw new Error(`Source glyph "${glyph.name}" not found in font`);
        }

        // Deep clone the glyph data
        const clonedData = JSON.parse(
            JSON.stringify(this._data.glyphs[sourceGlyphIndex])
        );

        // Set the new name
        clonedData.name = newName;

        // Generate new unique IDs for all layers
        if (clonedData.layers) {
            // Collect all layer IDs from the entire font to avoid duplicates
            const allExistingLayerIds = new Set<string>();
            for (const g of this.glyphs) {
                if (g.layers) {
                    for (const layer of g.layers) {
                        if (layer.id) {
                            allExistingLayerIds.add(layer.id);
                        }
                    }
                }
            }

            // Generate new unique IDs for each cloned layer
            for (const layer of clonedData.layers) {
                if (layer.id) {
                    let newId: string;
                    do {
                        newId = crypto.randomUUID();
                    } while (allExistingLayerIds.has(newId));
                    layer.id = newId;
                    allExistingLayerIds.add(newId);
                }
            }
        }

        // Add the cloned glyph to the font
        this._data.glyphs.push(clonedData);
        this._glyphWrappers = null; // Invalidate cache
        recordAddAndMarkDirty(['glyphs', newName], clonedData);

        // Return the newly created glyph
        return new Glyph(this._data.glyphs, this._data.glyphs.length - 1, this);
    }

    /**
     * Find an axis by ID
     */
    findAxis(id: string): Axis | undefined {
        const axes = this.axes;
        if (!axes) return undefined;
        const index = this._data.axes.findIndex((a: Unsafe) => a.id === id);
        return index >= 0 ? axes[index] : undefined;
    }

    /**
     * Find an axis by tag
     * @example
     * weight_axis = font.findAxisByTag("wght")
     */
    findAxisByTag(tag: string): Axis | undefined {
        const axes = this.axes;
        if (!axes) return undefined;
        const index = this._data.axes.findIndex((a: Unsafe) => a.tag === tag);
        return index >= 0 ? axes[index] : undefined;
    }

    /**
     * Find a master by ID
     */
    findMaster(id: string): Master | undefined {
        const masters = this.masters;
        if (!masters) return undefined;
        const index = this._data.masters.findIndex((m: Unsafe) => m.id === id);
        return index >= 0 ? masters[index] : undefined;
    }

    /**
     * Add a new glyph to the font
     * @example
     * glyph = font.addGlyph("myGlyph", "Base")
     */
    addGlyph(
        name: string,
        category: Babelfont.GlyphCategory | string = 'Base'
    ): Glyph {
        const glyphData: Babelfont.Glyph = {
            name,
            category: Glyph.normalizeCategory(category),
            layers: [],
            exported: true
        };
        this._data.glyphs.push(glyphData);
        this._glyphWrappers = null; // Invalidate cache
        recordAddAndMarkDirty(['glyphs', name], glyphData);
        return new Glyph(this._data.glyphs, this._data.glyphs.length - 1, this);
    }

    /**
     * Remove a glyph by name
     * @example
     * font.removeGlyph("oldGlyph")
     */
    removeGlyph(name: string): boolean {
        const index = this._data.glyphs.findIndex(
            (g: Unsafe) => g.name === name
        );
        if (index >= 0) {
            const removedGlyph = this._data.glyphs[index];
            this._data.glyphs.splice(index, 1);
            this._glyphWrappers = null; // Invalidate cache
            recordRemoveAndMarkDirty(['glyphs', name], removedGlyph);
            return true;
        }
        return false;
    }

    /**
     * Serialize the font back to JSON string
     */
    toJSONString(): string {
        return JSON.stringify(
            this._data,
            (key, value) => {
                // When serializing shape objects, normalize normalizer wrappers
                // back to plain (untagged) babelfont Shape objects.
                //
                // Input wrappers can look like:
                //   { Path: {...}, nodes: [...], isInterpolated?: bool }
                //   { Component: {...}, isInterpolated?: bool }
                //
                // Output must be plain shapes for Rust serde untagged enums:
                //   { nodes: ..., closed: ... }  OR  { reference: ..., transform: ... }
                //
                // Additionally, the Path.nodes getter in babelfont-model mutates
                // underlying data from string → array. We must convert array nodes
                // back to compact strings here at serialization time so
                // compile_babelfont() never sees invalid array-format nodes.
                if (
                    value &&
                    typeof value === 'object' &&
                    !Array.isArray(value)
                ) {
                    // Normalize wrapped Path shape to unwrapped Path payload
                    if ('Path' in value && !('Component' in value)) {
                        const pathPayload =
                            value.Path && typeof value.Path === 'object'
                                ? value.Path
                                : null;
                        if (pathPayload) {
                            const result = { ...pathPayload };
                            if (Array.isArray(result.nodes)) {
                                result.nodes = Path.nodesToString(result.nodes);
                            }
                            return result;
                        }
                    }

                    // Normalize wrapped Component shape to unwrapped Component payload
                    if ('Component' in value && !('Path' in value)) {
                        const componentPayload =
                            value.Component &&
                            typeof value.Component === 'object'
                                ? value.Component
                                : null;
                        if (componentPayload) {
                            const result = { ...componentPayload };
                            // Convert array-format transforms to DecomposedAffine objects
                            // Rust expects {translation, scale, rotation, skew, order}, not [a,b,c,d,tx,ty]
                            if (Array.isArray(result.transform)) {
                                result.transform =
                                    DecomposedAffineTransform.fromAffine(
                                        result.transform
                                    );
                            }
                            return result;
                        }
                    }

                    // Normalize flat Component shapes with array transforms
                    if (
                        'reference' in value &&
                        Array.isArray(value.transform)
                    ) {
                        return {
                            ...value,
                            transform: DecomposedAffineTransform.fromAffine(
                                value.transform
                            )
                        };
                    }

                    // Normalize flat Path shapes with array nodes
                    if (
                        'nodes' in value &&
                        Array.isArray(value.nodes) &&
                        !('reference' in value)
                    ) {
                        return {
                            ...value,
                            nodes: Path.nodesToString(value.nodes)
                        };
                    }
                }
                return value;
            },
            2
        ); // Format with 2-space indentation for readable git diffs
    }

    /**
     * Create a Font instance from JSON string
     */
    static fromJSONString(json: string): Font {
        return new Font(JSON.parse(json));
    }

    /**
     * Create a Font instance from parsed JSON data
     */
    static fromData(data: Babelfont.Font): Font {
        return new Font(data);
    }

    toString(): string {
        const familyName =
            this.names?.family_name?.en ||
            Object.values(this.names?.family_name || {})[0] ||
            'Unnamed';
        const glyphCount = this.glyphs?.length || 0;
        const masterCount = this.masters?.length || 0;
        const axisCount = this.axes?.length || 0;
        const info =
            masterCount > 1 ? ` ${axisCount} axes, ${masterCount} masters` : '';
        return `<Font "${familyName}" ${glyphCount} glyphs${info}>`;
    }

    /**
     * Analyze a feature's code to determine if it contains GSUB and/or GPOS rules
     * @param featureTag - The 4-character feature tag (e.g., "liga", "kern")
     * @returns Object with hasGSUB and hasGPOS boolean flags
     * @example
     * const analysis = font.analyzeFeatureTables("liga")
     * if (analysis.hasGSUB) console.log("Feature has substitution rules")
     */
    analyzeFeatureTables(featureTag: string): {
        hasGSUB: boolean;
        hasGPOS: boolean;
    } {
        if (!this.features?.features) {
            return { hasGSUB: false, hasGPOS: false };
        }

        // Find the feature by tag
        const feature = this.features.features.find(
            ([tag]) => tag === featureTag
        );
        if (!feature) {
            return { hasGSUB: false, hasGPOS: false };
        }

        const code = feature[1].code || '';
        // Use a set to track visited features to prevent infinite recursion
        const visitedFeatures = new Set<string>([featureTag]);
        return this._analyzeOpenTypeCodeInternal(code, visitedFeatures);
    }

    /**
     * Analyze OpenType feature code to determine if it contains GSUB and/or GPOS rules
     * This is a general-purpose method that can analyze code from features, prefixes, or other sources
     * @param code - The AFDKO feature code to analyze
     * @returns Object with hasGSUB and hasGPOS boolean flags
     * @example
     * const analysis = font.analyzeOpenTypeCode("substitute a by b;")
     * if (analysis.hasGSUB) console.log("Code contains substitution rules")
     */
    analyzeOpenTypeCode(code: string): {
        hasGSUB: boolean;
        hasGPOS: boolean;
    } {
        // Use an empty set since we're analyzing standalone code without feature references
        return this._analyzeOpenTypeCodeInternal(code, new Set());
    }

    /**
     * Analyze a prefix's code to determine if it contains GSUB and/or GPOS rules
     * @param prefixName - The name of the prefix to analyze
     * @returns Object with hasGSUB and hasGPOS boolean flags
     * @example
     * const analysis = font.analyzePrefix("myLookup")
     * if (analysis.hasGSUB) console.log("Prefix contains substitution rules")
     */
    analyzePrefix(prefixName: string): {
        hasGSUB: boolean;
        hasGPOS: boolean;
    } {
        if (!this.features?.prefixes) {
            return { hasGSUB: false, hasGPOS: false };
        }

        const prefix = this.features.prefixes[prefixName];
        if (!prefix) {
            return { hasGSUB: false, hasGPOS: false };
        }

        const code = prefix.code || '';
        // Use an empty set since prefixes don't have feature tag references
        return this._analyzeOpenTypeCodeInternal(code, new Set());
    }

    /**
     * Internal method to analyze OpenType code for GSUB/GPOS content
     * Handles lookup references and feature references by parsing all features and prefixes
     * @param visitedFeatures - Set of feature tags already visited to prevent infinite recursion
     */
    private _analyzeOpenTypeCodeInternal(
        code: string,
        visitedFeatures: Set<string> = new Set()
    ): {
        hasGSUB: boolean;
        hasGPOS: boolean;
    } {
        // GSUB keywords from OpenType Feature File Specification
        const gsubKeywords = ['substitute', 'sub', 'reversesub', 'rsub'];

        // GPOS keywords from OpenType Feature File Specification
        const gposKeywords = ['position', 'pos', 'valueRecordDef', 'cursive'];

        let hasGSUB = false;
        let hasGPOS = false;

        // Check for direct GSUB keywords
        for (const keyword of gsubKeywords) {
            // Match keyword as whole word (not part of another word)
            const regex = new RegExp(`\\b${keyword}\\b`, 'i');
            if (regex.test(code)) {
                hasGSUB = true;
                break;
            }
        }

        // Check for direct GPOS keywords
        for (const keyword of gposKeywords) {
            const regex = new RegExp(`\\b${keyword}\\b`, 'i');
            if (regex.test(code)) {
                hasGPOS = true;
                break;
            }
        }

        // Check for feature references (e.g., "feature salt;" in aalt)
        const featureRefPattern = /\bfeature\s+([a-zA-Z0-9]{4})\s*;/g;
        const featureRefs: string[] = [];
        let match;
        while ((match = featureRefPattern.exec(code)) !== null) {
            const referencedTag = match[1];
            // Only process if we haven't visited this feature already
            if (!visitedFeatures.has(referencedTag)) {
                featureRefs.push(referencedTag);
            }
        }

        // Recursively analyze referenced features
        if (featureRefs.length > 0 && this.features?.features) {
            for (const refTag of featureRefs) {
                const refFeature = this.features.features.find(
                    ([tag]) => tag === refTag
                );
                if (refFeature) {
                    // Mark this feature as visited to prevent infinite recursion
                    const newVisited = new Set(visitedFeatures);
                    newVisited.add(refTag);
                    const refAnalysis = this._analyzeOpenTypeCodeInternal(
                        refFeature[1].code || '',
                        newVisited
                    );
                    if (refAnalysis.hasGSUB) hasGSUB = true;
                    if (refAnalysis.hasGPOS) hasGPOS = true;
                }
            }
        }

        // Check for lookup references (e.g., "lookup LOOKUP_NAME;")
        const lookupRefPattern = /lookup\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*;/g;
        const lookupRefs: string[] = [];
        while ((match = lookupRefPattern.exec(code)) !== null) {
            lookupRefs.push(match[1]);
        }

        // If we found lookup references, analyze those lookups
        if (lookupRefs.length > 0) {
            for (const lookupName of lookupRefs) {
                const lookupAnalysis = this._analyzeLookupByName(
                    lookupName,
                    visitedFeatures
                );
                if (lookupAnalysis.hasGSUB) hasGSUB = true;
                if (lookupAnalysis.hasGPOS) hasGPOS = true;
            }
        }

        return { hasGSUB, hasGPOS };
    }

    /**
     * Find and analyze a named lookup in features or prefixes
     * @param visitedFeatures - Set of feature tags already visited to prevent infinite recursion
     */
    private _analyzeLookupByName(
        lookupName: string,
        visitedFeatures: Set<string> = new Set()
    ): {
        hasGSUB: boolean;
        hasGPOS: boolean;
    } {
        if (!this.features) {
            return { hasGSUB: false, hasGPOS: false };
        }

        // Search in prefixes
        if (this.features.prefixes) {
            const prefixCode = this.features.prefixes[lookupName];
            if (prefixCode?.code) {
                return this._analyzeOpenTypeCodeInternal(
                    prefixCode.code,
                    visitedFeatures
                );
            }
        }

        // Search in all features for named lookup blocks
        // Pattern: lookup NAME { ... } NAME;
        const lookupPattern = new RegExp(
            `lookup\\s+${lookupName}\\s*\\{([^}]+)\\}\\s*${lookupName}\\s*;`,
            'gs'
        );

        if (this.features.features) {
            for (const [, featureData] of this.features.features) {
                const featureCode = featureData.code || '';
                const lookupMatch = lookupPattern.exec(featureCode);
                if (lookupMatch) {
                    return this._analyzeOpenTypeCodeInternal(
                        lookupMatch[1],
                        visitedFeatures
                    );
                }
            }
        }

        // Also check prefixes for lookup blocks
        if (this.features.prefixes) {
            for (const prefixCode of Object.values(this.features.prefixes)) {
                const code = prefixCode.code || '';
                const lookupMatch = lookupPattern.exec(code);
                if (lookupMatch) {
                    return this._analyzeOpenTypeCodeInternal(
                        lookupMatch[1],
                        visitedFeatures
                    );
                }
            }
        }

        return { hasGSUB: false, hasGPOS: false };
    }
}

import {
    designspaceToUserspace as fonttypesDesignspaceToUserspace,
    normalizeLocation as fonttypesNormalizeLocation,
    normalizeValue as fonttypesNormalizeValue,
    piecewiseLinearMap,
    userspaceToDesignspace as fonttypesUserspaceToDesignspace
} from '@simoncozens/fonttypes';
import type {
    Axis as FonttypesAxis,
    DesignspaceCoordinate,
    DesignspaceLocation,
    NormalizedCoordinate,
    NormalizedLocation,
    UserspaceCoordinate,
    UserspaceLocation,
    UserspaceToDesignspaceMapping
} from '@simoncozens/fonttypes';
import type { Babelfont } from './babelfont';

export {
    piecewiseLinearMap,
    type DesignspaceCoordinate,
    type DesignspaceLocation,
    type NormalizedCoordinate,
    type NormalizedLocation,
    type UserspaceCoordinate,
    type UserspaceLocation
};

export type AxisMap = UserspaceToDesignspaceMapping;

function asUserspaceCoordinate(value: number): UserspaceCoordinate {
    return Number(value) as UserspaceCoordinate;
}

function asDesignspaceCoordinate(value: number): DesignspaceCoordinate {
    return Number(value) as DesignspaceCoordinate;
}

function normalizeAxis(axis: Babelfont.Axis): FonttypesAxis {
    const defaultValue = asUserspaceCoordinate(
        Number(axis.default ?? axis.min ?? axis.max ?? 0)
    );
    const minValue = asUserspaceCoordinate(
        Number(axis.min ?? Number(defaultValue))
    );
    const maxValue = asUserspaceCoordinate(
        Number(axis.max ?? Number(defaultValue))
    );

    return {
        tag: axis.tag,
        name: axis.name?.en || Object.values(axis.name || {})[0] || axis.tag,
        min: minValue,
        max: maxValue,
        default: defaultValue,
        map: axis.map
            ? (axis.map.map(([userspace, designspace]) => [
                  asUserspaceCoordinate(Number(userspace)),
                  asDesignspaceCoordinate(Number(designspace))
              ]) as UserspaceToDesignspaceMapping)
            : undefined,
        hidden: axis.hidden
    };
}

function normalizeAxes(axes: Babelfont.Axis[]): FonttypesAxis[] {
    return axes.map(normalizeAxis);
}

export function userspaceToDesignspace(
    location: UserspaceLocation,
    axes: Babelfont.Axis[]
): DesignspaceLocation {
    return fonttypesUserspaceToDesignspace(location, normalizeAxes(axes));
}

export function designspaceToUserspace(
    location: DesignspaceLocation,
    axes: Babelfont.Axis[]
): UserspaceLocation {
    return fonttypesDesignspaceToUserspace(location, normalizeAxes(axes));
}

export function normalizeLocation(
    location: DesignspaceLocation,
    axes: Babelfont.Axis[]
): NormalizedLocation {
    return fonttypesNormalizeLocation(location, normalizeAxes(axes));
}

export function normalizeValue(
    value: DesignspaceCoordinate,
    axis: Babelfont.Axis,
    extrapolate: boolean = false
): NormalizedCoordinate {
    return fonttypesNormalizeValue(value, normalizeAxis(axis), extrapolate);
}

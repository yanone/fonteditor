/** `format_specific` key for non-destructive path boolean operations. */
export const FIP001_BOOLEAN_KEY = 'fip001-boolean';
/** Value that marks a path as a subtraction cutter. */
export const FIP001_BOOLEAN_SUBTRACTION = 'subtraction';
export const GLYPHS_ATTR_KEY = 'com.schriftgestalt.Glyphs.attr';

type FormatSpecific = Record<string, unknown> | null | undefined;

export function glyphsAttrFromFormatSpecific(
    formatSpecific: FormatSpecific
): Record<string, unknown> | null {
    const attr = formatSpecific?.[GLYPHS_ATTR_KEY];
    if (!attr || typeof attr !== 'object' || Array.isArray(attr)) {
        return null;
    }
    return attr as Record<string, unknown>;
}

export function pathHasSubtractionFlag(
    formatSpecific: FormatSpecific
): boolean {
    if (formatSpecific?.[FIP001_BOOLEAN_KEY] === FIP001_BOOLEAN_SUBTRACTION) {
        return true;
    }
    return (
        glyphsAttrFromFormatSpecific(formatSpecific)?.[FIP001_BOOLEAN_KEY] ===
        FIP001_BOOLEAN_SUBTRACTION
    );
}

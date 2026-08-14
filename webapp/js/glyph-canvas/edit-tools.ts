/**
 * Edit-tool identifiers and pure helpers for the Editor title-bar tool strip.
 */

export type StickyEditTool = 'select' | 'pen' | 'insert' | 'convert' | 'cut';
export type EditToolId = 'text' | StickyEditTool;
export type EditToolPointerBadge = 'insert' | 'convert' | 'cut';

export type EditToolAvailability = {
    text: true;
    select: boolean;
    pen: boolean;
    insert: boolean;
    convert: boolean;
    cut: boolean;
};

export type EditToolUiSnapshot = {
    isEditMode: boolean;
    stickyTool: StickyEditTool;
    highlightedTool: EditToolId;
    availability: EditToolAvailability;
    pointerBadge: EditToolPointerBadge | null;
};

export const EDIT_TOOL_ICONS: Record<
    Exclude<EditToolId, 'text'> | 'text',
    string
> = {
    text: 'title',
    select: 'arrow_selector_tool',
    pen: 'draw',
    insert: 'add',
    convert: 'gesture',
    cut: 'content_cut'
};

export const STICKY_EDIT_TOOLS: StickyEditTool[] = [
    'select',
    'pen',
    'insert',
    'convert',
    'cut'
];

export function resolveHighlightedEditTool(options: {
    isEditMode: boolean;
    stickyTool: StickyEditTool;
    cmdKeyPressed: boolean;
    altKeyPressed: boolean;
    hasAddPointPreview: boolean;
}): EditToolId {
    if (!options.isEditMode) {
        return 'text';
    }

    if (options.altKeyPressed && !options.cmdKeyPressed) {
        return 'convert';
    }

    if (options.cmdKeyPressed && !options.altKeyPressed) {
        return options.hasAddPointPreview ? 'insert' : 'pen';
    }

    return options.stickyTool;
}

export function resolvePointerBadgeTool(
    highlightedTool: EditToolId
): EditToolPointerBadge | null {
    if (
        highlightedTool === 'insert' ||
        highlightedTool === 'convert' ||
        highlightedTool === 'cut'
    ) {
        return highlightedTool;
    }
    return null;
}

export function resolvePointerBadge(options: {
    highlightedTool: EditToolId;
    cmdKeyPressed: boolean;
    hoveringCuttableNode: boolean;
}): EditToolPointerBadge | null {
    if (options.cmdKeyPressed && options.hoveringCuttableNode) {
        return 'cut';
    }
    return resolvePointerBadgeTool(options.highlightedTool);
}

export function chooseDefaultStickyEditTool(
    _availability?: EditToolAvailability
): StickyEditTool {
    return 'select';
}

export function ensureStickyEditToolAvailable(
    stickyTool: StickyEditTool,
    availability: EditToolAvailability
): StickyEditTool {
    if (availability[stickyTool]) {
        return stickyTool;
    }
    return 'select';
}

export function shortcutKeyToStickyEditTool(
    key: string
): StickyEditTool | 'text' | null {
    switch (key.toLowerCase()) {
        case 't':
            return 'text';
        case 'v':
            return 'select';
        case 'p':
            return 'pen';
        case 'i':
            return 'insert';
        case 'c':
            return 'convert';
        default:
            return null;
    }
}

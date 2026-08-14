import {
    type EditToolId,
    type EditToolUiSnapshot,
    type StickyEditTool
} from './glyph-canvas/edit-tools';
import { setToolCursorBadge } from './tool-cursor-badge';
import { Logger } from './logger';

const console = new Logger('EditorEditTools');

const TOOL_BUTTON_IDS: Record<EditToolId, string> = {
    text: 'editor-tool-text',
    select: 'editor-tool-select',
    pen: 'editor-tool-pen',
    insert: 'editor-tool-insert',
    convert: 'editor-tool-convert',
    cut: 'editor-tool-cut'
};

function getEmptySnapshot(): EditToolUiSnapshot {
    return {
        isEditMode: false,
        stickyTool: 'select',
        highlightedTool: 'text',
        availability: {
            text: true,
            select: false,
            pen: false,
            insert: false,
            convert: false,
            cut: false
        },
        pointerBadge: null
    };
}

function readSnapshot(): EditToolUiSnapshot {
    const outlineEditor = window.glyphCanvas?.outlineEditor;
    if (!outlineEditor?.getEditToolUiSnapshot) {
        return getEmptySnapshot();
    }
    return outlineEditor.getEditToolUiSnapshot();
}

function applySnapshot(snapshot: EditToolUiSnapshot): void {
    (Object.keys(TOOL_BUTTON_IDS) as EditToolId[]).forEach((toolId) => {
        const button = document.getElementById(
            TOOL_BUTTON_IDS[toolId]
        ) as HTMLButtonElement | null;
        if (!button) {
            return;
        }

        const available =
            toolId === 'text' ? true : snapshot.availability[toolId];
        const isActive = snapshot.highlightedTool === toolId;

        if (toolId === 'text') {
            button.disabled = false;
            button.classList.toggle('unavailable', false);
        } else {
            button.disabled = !snapshot.isEditMode || !available;
            button.classList.toggle(
                'unavailable',
                !snapshot.isEditMode || !available
            );
        }

        button.classList.toggle('active', isActive);
        button.setAttribute('aria-pressed', String(isActive));
    });

    setToolCursorBadge(snapshot.pointerBadge);
}

export function refreshEditorEditToolsUi(): void {
    applySnapshot(readSnapshot());
}

function handleToolButtonClick(toolId: EditToolId): void {
    const outlineEditor = window.glyphCanvas?.outlineEditor;
    const glyphCanvas = window.glyphCanvas;
    if (!outlineEditor || !glyphCanvas) {
        return;
    }

    if (toolId === 'text') {
        if (outlineEditor.active) {
            void outlineEditor.requestExitGlyphEditMode();
        }
        refreshEditorEditToolsUi();
        return;
    }

    if (!outlineEditor.active) {
        return;
    }

    outlineEditor.setActiveEditTool(toolId as StickyEditTool);
    glyphCanvas.canvas?.focus();
    refreshEditorEditToolsUi();
}

function initEditorEditToolsUi(): void {
    const toolsRoot = document.getElementById('editor-edit-tools');
    if (!toolsRoot) {
        return;
    }

    (Object.keys(TOOL_BUTTON_IDS) as EditToolId[]).forEach((toolId) => {
        const button = document.getElementById(TOOL_BUTTON_IDS[toolId]);
        if (!button) {
            return;
        }

        button.addEventListener('click', (event: Event) => {
            event.preventDefault();
            event.stopPropagation();
            if (button instanceof HTMLButtonElement && button.disabled) {
                return;
            }
            handleToolButtonClick(toolId);
        });
    });

    window.addEventListener('editorModeChanged', () => {
        refreshEditorEditToolsUi();
    });

    window.addEventListener('editorEditToolsChanged', () => {
        refreshEditorEditToolsUi();
    });

    refreshEditorEditToolsUi();
    console.log('Editor edit tools initialized');
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initEditorEditToolsUi);
} else {
    initEditorEditToolsUi();
}

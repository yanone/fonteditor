import tippy, { Instance as TippyInstance } from 'tippy.js';
import 'tippy.js/dist/tippy.css';
import {
    getOrCreateBackdrop,
    addTippyBackdropSupport,
    getTheme,
    setupMenuKeyboardNav
} from './tippy-utils';
import { Logger } from './logger';

const console = new Logger('EditorStackPreviewMenu');

let stackPreviewMenuInstance: TippyInstance | null = null;

function updateStackPreviewButtonVisibility(button: HTMLElement): void {
    const isEditMode = !!window.glyphCanvas?.outlineEditor?.active;

    if (!isEditMode && stackPreviewMenuInstance?.state.isVisible) {
        stackPreviewMenuInstance.hide();
    }

    if (button instanceof HTMLButtonElement) {
        button.disabled = !isEditMode;
    }
    button.setAttribute('aria-disabled', String(!isEditMode));
    button.classList.toggle('inactive', !isEditMode);
    button.style.display = 'flex';
}

function createStackPreviewMenuHtml(): string {
    const stackPreviewActive =
        !!window.glyphCanvas?.stackPreviewAnimator?.isActive &&
        !window.glyphCanvas?.stackPreviewAnimator?.isReversing;
    const stackPreviewCheckmark = stackPreviewActive ? 'check' : '';
    const guidelinesVisible =
        window.glyphCanvas?.outlineEditor?.guidelinesVisible !== false;
    const guidelinesCheckmark = guidelinesVisible ? 'check' : '';
    const pairedLayerVisible =
        window.glyphCanvas?.outlineEditor?.isPairedLayerVisible() ?? false;
    const pairedLayerCheckmark = pairedLayerVisible ? 'check' : '';

    return `
        <div class="plugin-menu" tabindex="0" role="menu" aria-label="Stack preview menu">
            <div class="plugin-menu-item" data-action="toggle-stack-preview" role="menuitemcheckbox" aria-checked="${stackPreviewActive}" tabindex="-1">
                <span class="plugin-menu-check material-symbols-outlined${stackPreviewActive ? '' : ' empty'}">${stackPreviewCheckmark}</span>
                <span>Stack Preview</span>
                <span class="plugin-menu-shortcut">⌘⌥S</span>
            </div>
            <div class="plugin-menu-item" data-action="toggle-guidelines" role="menuitemcheckbox" aria-checked="${guidelinesVisible}" tabindex="-1">
                <span class="plugin-menu-check material-symbols-outlined${guidelinesVisible ? '' : ' empty'}">${guidelinesCheckmark}</span>
                <span>Guidelines</span>
                <span class="plugin-menu-shortcut">⌘⌥G</span>
            </div>
            <div class="plugin-menu-item" data-action="toggle-paired-layer" role="menuitemcheckbox" aria-checked="${pairedLayerVisible}" tabindex="-1">
                <span class="plugin-menu-check material-symbols-outlined${pairedLayerVisible ? '' : ' empty'}">${pairedLayerCheckmark}</span>
                <span>Show Foreground/Background</span>
                <span class="plugin-menu-shortcut">⌘⌥B</span>
            </div>
        </div>
    `;
}

function refreshStackPreviewMenuContent(): void {
    stackPreviewMenuInstance?.setContent(createStackPreviewMenuHtml());
}

function toggleStackPreview(): void {
    const glyphCanvas = window.glyphCanvas;
    if (!glyphCanvas) {
        return;
    }

    const animator = glyphCanvas.stackPreviewAnimator;
    if (!animator) {
        return;
    }

    if (animator.isInputBlocked()) {
        return;
    }

    if (animator.isActive && !animator.isAnimating) {
        animator.reverseAnimation();
        return;
    }

    const editorView = document.querySelector('#view-editor');
    const isEditorFocused =
        !!editorView && editorView.classList.contains('focused');

    if (isEditorFocused && glyphCanvas.outlineEditor.active) {
        animator.startAnimation();
    }
}

function initEditorStackPreviewMenu(): void {
    const menuButton = document.getElementById('editor-stack-preview-menu-btn');
    if (!menuButton) {
        return;
    }

    updateStackPreviewButtonVisibility(menuButton);

    const backdrop = getOrCreateBackdrop('editor-stack-preview-menu-backdrop');

    const tippyResult = tippy(menuButton, {
        content: createStackPreviewMenuHtml(),
        allowHTML: true,
        interactive: true,
        trigger: 'manual',
        theme: getTheme(),
        placement: 'bottom-end',
        arrow: false,
        offset: [0, 4],
        appendTo: document.body,
        hideOnClick: false,
        zIndex: 9999,
        onCreate: (instance) => {
            instance.popper.addEventListener('click', (e) => {
                const item = (e.target as HTMLElement).closest(
                    '.plugin-menu-item'
                );
                if (!item) {
                    return;
                }

                const action = item.getAttribute('data-action');
                instance.hide();

                if (action === 'toggle-stack-preview') {
                    toggleStackPreview();
                } else if (action === 'toggle-guidelines') {
                    window.glyphCanvas?.outlineEditor?.toggleGuidelinesVisible();
                    refreshStackPreviewMenuContent();
                } else if (action === 'toggle-paired-layer') {
                    window.glyphCanvas?.outlineEditor?.togglePairedLayerVisible();
                    refreshStackPreviewMenuContent();
                }
            });
        },
        onShown: (instance) => {
            refreshStackPreviewMenuContent();
            const menu = instance.popper.querySelector('.plugin-menu');
            if (menu) {
                setupMenuKeyboardNav(menu);
            }
        }
    });

    stackPreviewMenuInstance = Array.isArray(tippyResult)
        ? (tippyResult[0] ?? null)
        : tippyResult;

    addTippyBackdropSupport(stackPreviewMenuInstance, backdrop, {
        targetElement: menuButton,
        activeClass: 'editor-stack-preview-menu-active'
    });

    menuButton.addEventListener('click', (e: Event) => {
        e.preventDefault();
        e.stopPropagation();

        if ((menuButton as HTMLButtonElement).disabled) {
            return;
        }

        if (stackPreviewMenuInstance?.state.isVisible) {
            stackPreviewMenuInstance.hide();
        } else {
            refreshStackPreviewMenuContent();
            stackPreviewMenuInstance?.show();
        }
    });

    window.addEventListener('editorModeChanged', () => {
        updateStackPreviewButtonVisibility(menuButton);
        refreshStackPreviewMenuContent();
    });

    window.addEventListener('outlineGuidelinesVisibilityChanged', () => {
        refreshStackPreviewMenuContent();
    });

    window.addEventListener('outlinePairedLayerVisibilityChanged', () => {
        refreshStackPreviewMenuContent();
    });

    console.log('Stack preview menu initialized');
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initEditorStackPreviewMenu);
} else {
    initEditorStackPreviewMenu();
}

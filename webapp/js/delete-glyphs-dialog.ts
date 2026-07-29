/**
 * Confirm dialog for deleting selected glyphs.
 * Reuses .info-popup / .confirm-dialog styling from unsaved-changes.
 *
 * Cleanups (features/classes, metrics keys, components, and always kerning)
 * are mandatory; the dialog only reports what will be cleaned.
 */

import { Logger } from './logger';

const console = new Logger('DeleteGlyphsDialog');

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

export class DeleteGlyphsDialog {
    open(names?: string[]): void {
        const rawNames: unknown[] = Array.isArray(names)
            ? names
            : window.glyphOverviewInstance?.getSelectedGlyphNames?.() || [];
        const selectedNames = rawNames.filter(
            (name): name is string =>
                typeof name === 'string' && name.length > 0
        );
        const font = window.currentFontModel;
        if (!font || selectedNames.length === 0) {
            return;
        }

        const uniqueNames = [...new Set(selectedNames)];
        const preflight = font.preflightDeleteGlyphs(uniqueNames);
        void this.showConfirm(uniqueNames, preflight).then((confirmed) => {
            if (!confirmed) {
                return;
            }
            try {
                font.deleteGlyphs(uniqueNames);
            } catch (error) {
                console.error('Failed to delete glyphs', error);
            }
        });
    }

    private showConfirm(
        names: string[],
        preflight: {
            featureReferences: number;
            metricsKeyReferences: number;
            componentReferences: number;
        }
    ): Promise<boolean> {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'info-popup-overlay';
            overlay.style.display = 'flex';
            overlay.style.zIndex = '10002';

            const title =
                names.length === 1
                    ? `Delete glyph “${names[0]}”?`
                    : `Delete ${names.length} glyphs?`;

            const categories = [
                {
                    label: 'Features & classes',
                    count: preflight.featureReferences
                },
                {
                    label: 'Metrics keys',
                    count: preflight.metricsKeyReferences
                },
                {
                    label: 'Components',
                    count: preflight.componentReferences
                }
            ].filter((category) => category.count > 0);

            const reportHtml =
                categories.length === 0
                    ? ''
                    : `<div class="confirm-dialog-options">
                        <p>Will also clean:</p>
                        <ul class="confirm-dialog-report">
                            ${categories
                                .map(
                                    (category) =>
                                        `<li>${escapeHtml(category.label)} (${category.count})</li>`
                                )
                                .join('')}
                        </ul>
                    </div>`;

            overlay.innerHTML = `
                <div class="info-popup confirm-dialog">
                    <div class="info-popup-header">
                        <h3>Delete Glyph(s)</h3>
                        <button type="button" class="info-popup-close confirm-dialog-close-btn" aria-label="Cancel">
                            <span class="material-symbols-outlined">close</span>
                        </button>
                    </div>
                    <div class="info-popup-content confirm-dialog-content">
                        <p>${escapeHtml(title)} This can be undone.</p>
                        ${reportHtml}
                        <div class="confirm-dialog-actions">
                            <button type="button" class="localized-string-modal-button confirm-dialog-btn" data-action="cancel">Cancel</button>
                            <button type="button" class="localized-string-modal-button confirm-dialog-btn confirm-dialog-danger" data-action="delete">Delete</button>
                        </div>
                    </div>
                </div>
            `;

            document.body.appendChild(overlay);

            const cleanup = () => {
                overlay.remove();
                document.removeEventListener('keydown', onKeyDown, true);
            };

            const finish = (confirmed: boolean) => {
                cleanup();
                resolve(confirmed);
            };

            const onKeyDown = (event: KeyboardEvent) => {
                if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    finish(false);
                }
            };

            overlay.addEventListener('click', (event) => {
                if (event.target === overlay) {
                    finish(false);
                }
            });
            overlay
                .querySelector('.confirm-dialog-close-btn')
                ?.addEventListener('click', () => finish(false));
            overlay
                .querySelector('[data-action="cancel"]')
                ?.addEventListener('click', () => finish(false));
            overlay
                .querySelector('[data-action="delete"]')
                ?.addEventListener('click', () => finish(true));

            document.addEventListener('keydown', onKeyDown, true);

            queueMicrotask(() => {
                (
                    overlay.querySelector(
                        '[data-action="delete"]'
                    ) as HTMLElement | null
                )?.focus();
            });
        });
    }
}

export function canDeleteSelectedGlyphs(): boolean {
    return (
        !!window.fontManager?.currentFont &&
        (window.glyphOverviewInstance?.getSelectedGlyphNames?.().length || 0) >
            0
    );
}

window.deleteGlyphsDialog = new DeleteGlyphsDialog();

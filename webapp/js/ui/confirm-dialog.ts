/**
 * Confirm Dialog — reusable save/discard/cancel dialog
 *
 * Uses the existing .info-popup-overlay + .info-popup pattern (Agent Info /
 * Keyboard Shortcuts modals) and .localized-string-modal-button button styles.
 */

export type ConfirmChoice = 'save' | 'discard' | 'cancel';

/**
 * Show an "Unsaved Changes" dialog with three choices.
 *
 * @param fontName - The name of the font with unsaved changes
 * @returns A promise that resolves with the user's choice
 */
export function showUnsavedChangesDialog(
    fontName: string
): Promise<ConfirmChoice> {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'info-popup-overlay';
        overlay.style.display = 'flex';
        overlay.style.zIndex = '10002';

        const escapedName = fontName
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');

        overlay.innerHTML = `
            <div class="info-popup confirm-dialog">
                <div class="info-popup-header">
                    <h3>Unsaved Changes</h3>
                    <button type="button" class="info-popup-close confirm-dialog-close-btn" aria-label="Cancel">
                        <span class="material-symbols-outlined">close</span>
                    </button>
                </div>
                <div class="info-popup-content confirm-dialog-content">
                    <p>Font <strong>${escapedName}</strong> has unsaved changes. What do you want to do?</p>
                    <div class="confirm-dialog-actions">
                        <button type="button" class="localized-string-modal-button confirm-dialog-btn confirm-dialog-danger" data-action="discard">Don't Save</button>
                        <button type="button" class="localized-string-modal-button confirm-dialog-btn" data-action="cancel">Cancel</button>
                        <button type="button" class="localized-string-modal-button localized-string-modal-button-primary confirm-dialog-btn" data-action="save">Save</button>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        function cleanup() {
            overlay.remove();
            document.removeEventListener('keydown', onKeyDown);
        }

        function handleChoice(choice: ConfirmChoice) {
            cleanup();
            resolve(choice);
        }

        function onKeyDown(e: KeyboardEvent) {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                handleChoice('cancel');
            }
        }

        // Click on backdrop (the overlay itself) → cancel
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                handleChoice('cancel');
            }
        });

        // Close button → cancel
        overlay
            .querySelector('.confirm-dialog-close-btn')
            ?.addEventListener('click', () => {
                handleChoice('cancel');
            });

        // Button clicks
        overlay.querySelectorAll('[data-action]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const action = (btn as HTMLElement).dataset
                    .action as ConfirmChoice;
                handleChoice(action);
            });
        });

        // Escape key → cancel (cleaned up in cleanup())
        document.addEventListener('keydown', onKeyDown);

        // Focus the Save button (primary action)
        queueMicrotask(() => {
            const saveBtn = overlay.querySelector(
                '[data-action="save"]'
            ) as HTMLElement;
            saveBtn?.focus();
        });
    });
}

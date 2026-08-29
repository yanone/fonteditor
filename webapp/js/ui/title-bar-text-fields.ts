function isViewTitleFieldInput(
    target: EventTarget | null
): target is HTMLInputElement {
    return (
        target instanceof HTMLInputElement &&
        target.closest('.view-title-field') !== null
    );
}

function selectViewTitleFieldInput(input: HTMLInputElement): void {
    input.select();
}

/**
 * Select on focus after the focusing click's mouseup has placed a caret.
 * Do not prevent mouseup, so a later click can still set a caret or range.
 */
function initViewTitleFieldSelect(): void {
    document.addEventListener('focusin', (event) => {
        if (!isViewTitleFieldInput(event.target)) {
            return;
        }
        const input = event.target;
        setTimeout(() => {
            if (document.activeElement === input) {
                selectViewTitleFieldInput(input);
            }
        }, 0);
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initViewTitleFieldSelect);
} else {
    initViewTitleFieldSelect();
}

const FONT_EDITOR_READY_EVENT = 'fontEditorReady';
const FONT_EDITOR_READY_FAILED_EVENT = 'fontEditorReadyFailed';

function getStateWindow() {
    return window;
}

function normalizeError(error) {
    return error instanceof Error ? error : new Error(String(error));
}

function ensurePendingState() {
    const stateWindow = getStateWindow();
    if (!stateWindow.__fontEditorReadyState) {
        stateWindow.__fontEditorReadyState = 'pending';
        stateWindow.__fontEditorReadyError = null;
    }
}

ensurePendingState();

function markFontEditorReady() {
    const stateWindow = getStateWindow();
    if (stateWindow.__fontEditorReadyState === 'ready') {
        return;
    }

    stateWindow.__fontEditorReadyState = 'ready';
    stateWindow.__fontEditorReadyError = null;
    window.dispatchEvent(new CustomEvent(FONT_EDITOR_READY_EVENT));
}

function markFontEditorReadyFailed(error) {
    const stateWindow = getStateWindow();
    const normalizedError = normalizeError(error);
    stateWindow.__fontEditorReadyState = 'failed';
    stateWindow.__fontEditorReadyError = normalizedError;
    window.dispatchEvent(
        new CustomEvent(FONT_EDITOR_READY_FAILED_EVENT, {
            detail: { error: normalizedError.message }
        })
    );
}

async function waitForFontEditorReady(timeoutMs = 30000) {
    ensurePendingState();

    const stateWindow = getStateWindow();
    if (stateWindow.__fontEditorReadyState === 'ready') {
        return;
    }

    if (stateWindow.__fontEditorReadyState === 'failed') {
        throw (
            stateWindow.__fontEditorReadyError ||
            new Error('Font editor startup failed')
        );
    }

    await new Promise((resolve, reject) => {
        let settled = false;

        const finish = (callback) => {
            if (settled) {
                return;
            }
            settled = true;
            window.removeEventListener(FONT_EDITOR_READY_EVENT, onReady);
            window.removeEventListener(
                FONT_EDITOR_READY_FAILED_EVENT,
                onFailed
            );
            window.clearTimeout(timeoutId);
            callback();
        };

        const onReady = () => {
            finish(resolve);
        };

        const onFailed = () => {
            finish(() => {
                reject(
                    stateWindow.__fontEditorReadyError ||
                        new Error('Font editor startup failed')
                );
            });
        };

        const timeoutId = window.setTimeout(() => {
            finish(() => {
                reject(
                    new Error(
                        'Timed out waiting for font editor startup readiness'
                    )
                );
            });
        }, timeoutMs);

        window.addEventListener(FONT_EDITOR_READY_EVENT, onReady, {
            once: true
        });
        window.addEventListener(FONT_EDITOR_READY_FAILED_EVENT, onFailed, {
            once: true
        });
    });
}

function __resetFontEditorReadyForTests() {
    const stateWindow = getStateWindow();
    stateWindow.__fontEditorReadyState = 'pending';
    stateWindow.__fontEditorReadyError = null;
}

module.exports = {
    waitForFontEditorReady,
    markFontEditorReady,
    markFontEditorReadyFailed,
    __resetFontEditorReadyForTests
};

// Auto-Compile Manager
// Automatically recompiles the font when data changes (using DIRTY_COMPILE flag)
// Uses continuous loop for instant compilation during editing
import fontManager from './font-manager';

(function () {
    'use strict';

    let isEnabled = true;
    let isCompiling = false; // Prevent overlapping compilations
    let loopRunning = false;
    let animationFrameId: number | null = null;

    /**
     * Continuous check loop using requestAnimationFrame
     * Runs every frame to detect changes and compile immediately
     */
    function checkLoop() {
        if (!isEnabled) {
            loopRunning = false;
            return;
        }

        // Check if font is dirty and we're not already compiling
        if (fontManager.currentFont?.dirty && !isCompiling) {
            // Trigger compilation immediately (non-blocking)
            triggerCompilation().catch((err) => {
                console.error('Compilation error:', err);
                isCompiling = false; // Reset flag on error
            });
            // Continue loop to check again after compilation
            animationFrameId = requestAnimationFrame(checkLoop);
        } else if (isCompiling) {
            // Still compiling, keep checking
            animationFrameId = requestAnimationFrame(checkLoop);
        } else {
            // Nothing to do - stop the loop to save CPU
            loopRunning = false;
            animationFrameId = null;
        }
    }

    /**
     * Start the continuous check loop
     */
    function startLoop() {
        if (loopRunning) {
            return; // Already running
        }
        loopRunning = true;
        checkLoop();
    }

    /**
     * Stop the continuous check loop
     */
    function stopLoop() {
        if (animationFrameId !== null) {
            cancelAnimationFrame(animationFrameId);
            animationFrameId = null;
        }
        loopRunning = false;
    }

    /**
     * Check if font needs compilation and trigger it.
     */
    async function triggerCompilation() {
        if (isCompiling) {
            return;
        }

        if (fontManager.currentFont?.dirty) {
            isCompiling = true;

            // Get the change source for logging
            const changeSource = fontManager.lastChangeSource || 'unknown';

            // Show message in terminal if available
            if (window.term) {
                window.term.echo(
                    `[[;cyan;]🔄 Auto-recompiling editing font after data change (source: ${changeSource})...]`
                );
            }

            try {
                // Trigger recompilation of editing font via font manager
                if (fontManager && fontManager.isReady()) {
                    await fontManager.recompileEditingFont();
                }
            } finally {
                isCompiling = false;
            }
        }
    }

    /**
     * Called when data changes to trigger compilation check.
     * Now just ensures the loop is running.
     */
    function checkAndSchedule() {
        if (!loopRunning) {
            startLoop();
        }
    }

    /**
     * Enable or disable auto-compilation.
     */
    function setEnabled(enabled: boolean) {
        isEnabled = enabled;
        if (!enabled) {
            stopLoop();
        } else if (enabled && !loopRunning) {
            startLoop();
        }
    }

    /**
     * Manual test function to check dirty state without waiting.
     */
    async function testDirtyCheck() {
        return fontManager.currentFont?.dirty;
    }

    /**
     * Force trigger a compilation check immediately (for testing).
     */
    async function forceTrigger() {
        await triggerCompilation();
    }

    // Export API
    window.autoCompileManager = {
        checkAndSchedule,
        setEnabled,
        scheduleCompilation: checkAndSchedule, // Alias for compatibility
        testDirtyCheck,
        forceTrigger,
        getStatus: () => ({
            isEnabled,
            isCompiling,
            loopRunning
        })
    };

    // Start the loop immediately
    startLoop();
})();

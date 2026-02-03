// Auto-Compile Manager
// Automatically recompiles the font when data changes (using DIRTY_COMPILE flag)
// Uses continuous loop for instant compilation during editing
import APP_SETTINGS from './settings';
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
                console.error('[AutoCompile]', 'Compilation error:', err);
                isCompiling = false; // Reset flag on error
            });
        }

        // Continue loop
        animationFrameId = requestAnimationFrame(checkLoop);
    }

    /**
     * Start the continuous check loop
     */
    function startLoop() {
        if (loopRunning) {
            return; // Already running
        }
        loopRunning = true;
        console.log('[AutoCompile]', '▶️ Starting continuous check loop');
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
        console.log('[AutoCompile]', '⏸️ Stopped continuous check loop');
    }

    /**
     * Check if font needs compilation and trigger it.
     */
    async function triggerCompilation() {
        if (isCompiling) {
            console.log(
                '[AutoCompile]',
                '⏭️ Skipping - compilation in progress'
            );
            return;
        }

        console.log(
            '[AutoCompile]',
            'Checking dirty flag:',
            fontManager.currentFont?.dirty
        );

        if (fontManager.currentFont?.dirty) {
            isCompiling = true;

            // Show message in terminal if available
            if (window.term) {
                window.term.echo(
                    '[[;cyan;]🔄 Auto-recompiling editing font after data change...]'
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
        } else {
            console.log(
                '[AutoCompile]',
                'Font not dirty, skipping compilation'
            );
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
        console.log(
            '[AutoCompile]',
            `Auto-compilation ${enabled ? 'enabled' : 'disabled'}`
        );
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
        console.log(
            '[AutoCompile]',
            '🧪 Force triggering auto-compile check...'
        );
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

    console.log(
        '[AutoCompile]',
        '✅ Auto-compile manager initialized with continuous loop'
    );
})();

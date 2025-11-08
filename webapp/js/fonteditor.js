// FontEditor initialization
// Loads and initializes Python packages for font editing

async function initFontEditor() {
    "use strict";

    try {
        // Ensure pyodide is available
        if (!window.pyodide) {
            console.error("Pyodide not available. Make sure it's loaded first.");
            return false;
        }

        console.log("Initializing FontEditor...");

        // First load micropip package
        await window.pyodide.loadPackage("micropip");
        console.log("micropip loaded successfully");

        // Fetch the list of wheel files from the manifest
        const manifestResponse = await fetch('./wheels/wheels.json');
        const manifest = await manifestResponse.json();
        const wheelFiles = manifest.wheels;
        console.log('Found wheel files:', wheelFiles);

        // Install context package from local wheels
        await window.pyodide.runPythonAsync(`
            import micropip
            await micropip.install('fonttools==4.60.1')
            await micropip.install('ufomerge')
        `);

        // Install each wheel file
        for (const wheelFile of wheelFiles) {
            console.log(`Installing wheel: ${wheelFile}`);
            const wheelUrl = `./wheels/${wheelFile}`;
            await window.pyodide.runPythonAsync(`
                import micropip
                print(f"Installing from URL: ${wheelUrl}")
                await micropip.install("${wheelUrl}")
            `);
        }

        // Import context and make it available
        await window.pyodide.runPython(`
            import context
            
            # Make context available globally in Python namespace
            globals()['context'] = context
        `);

        // Load the fonteditor Python module
        const fonteditorModule = await fetch('./py/fonteditor.py');
        const fonteditorCode = await fonteditorModule.text();
        await window.pyodide.runPython(fonteditorCode);
        console.log("fonteditor.py module loaded");

        // Install context package from local wheels
        await window.pyodide.runPythonAsync(`
            await micropip.install('matplotlib')
            await micropip.install('numpy')
            await micropip.install('pandas')
        `);


        console.log("FontEditor initialized successfully");

        // Restore the last active view right away, before animation ends
        const lastActiveView = localStorage.getItem('last_active_view');
        if (lastActiveView && window.focusView) {
            window.focusView(lastActiveView);
        }

        // Hide loading overlay with animation
        const hideLoadingOverlay = () => {
            const loadingOverlay = document.getElementById('loading-overlay');
            if (loadingOverlay) {
                loadingOverlay.classList.add('hidden');
            }
        };

        // Request animation to stop (it will drain particles first, then trigger fade)
        if (window.WarpSpeedAnimation) {
            let callbackFired = false;

            window.WarpSpeedAnimation.requestStop(() => {
                if (!callbackFired) {
                    callbackFired = true;
                    hideLoadingOverlay();
                }
            });

            // Fallback timeout in case animation callback doesn't fire (e.g., particles stuck)
            setTimeout(() => {
                if (!callbackFired) {
                    console.warn("Animation drain timeout, forcing overlay hide");
                    callbackFired = true;
                    hideLoadingOverlay();
                }
            }, 5000); // 5 second timeout
        } else {
            // Fallback if animation not available
            hideLoadingOverlay();
        }

        return true;

    } catch (error) {
        console.error("Error initializing FontEditor:", error);
        if (window.term) {
            window.term.error("Failed to initialize FontEditor: " + error.message);
        }

        // Hide loading overlay even on error
        const loadingOverlay = document.getElementById('loading-overlay');
        if (loadingOverlay) {
            loadingOverlay.classList.add('hidden');
        }

        return false;
    }
}

// Initialize FontEditor when Pyodide is ready
document.addEventListener('DOMContentLoaded', () => {
    // Safety timeout - hide loading screen after 30 seconds no matter what
    setTimeout(() => {
        const loadingOverlay = document.getElementById('loading-overlay');
        if (loadingOverlay && !loadingOverlay.classList.contains('hidden')) {
            console.error("Loading timeout - forcing overlay hide after 30 seconds");
            loadingOverlay.classList.add('hidden');
        }
    }, 30000);

    // Wait for pyodide to be available
    const checkPyodide = () => {
        if (window.pyodide) {
            // Wait a bit more to ensure pyodide is fully initialized
            setTimeout(() => {
                initFontEditor();
            }, 1000);
        } else {
            // Check again in 500ms
            setTimeout(checkPyodide, 500);
        }
    };

    checkPyodide();
});

// Export for manual initialization if needed
window.initFontEditor = initFontEditor;
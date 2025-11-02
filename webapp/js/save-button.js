/**
 * Save Button Management
 * Handles the save button state and save functionality
 */

class SaveButton {
    constructor() {
        this.button = $('#save-font-btn');
        this.isSaving = false;

        // Bind event handlers
        this.button.on('click', () => this.handleSave());

        // Global keyboard shortcut
        $(document).on('keydown', (e) => {
            // Cmd+S (Mac) or Ctrl+S (Windows/Linux)
            if ((e.metaKey || e.ctrlKey) && e.key === 's') {
                e.preventDefault();
                this.handleSave();
            }
        });
    }

    /**
     * Handle save action
     */
    async handleSave() {
        if (this.isSaving || this.button.prop('disabled')) {
            return;
        }

        this.isSaving = true;
        this.button.prop('disabled', true).text('Saving...');

        const startTime = performance.now();

        try {
            // Check if tracking is ready, and wait if needed
            const trackingReady = await window.pyodide.runPythonAsync(`
IsTrackingReady()
            `);

            if (!trackingReady) {
                console.log('Waiting for dirty tracking to initialize...');
                this.button.text('Preparing...');

                // If there's a tracking init promise, wait for it
                if (window._trackingInitPromise) {
                    try {
                        await window._trackingInitPromise;
                        console.log('Tracking ready, proceeding with save');
                        this.button.text('Saving...');
                    } catch (error) {
                        throw new Error('Tracking initialization failed: ' + error.message);
                    }
                } else {
                    // Fallback: poll for tracking readiness
                    let attempts = 0;
                    const maxAttempts = 300; // 30 seconds

                    while (attempts < maxAttempts) {
                        await new Promise(resolve => setTimeout(resolve, 100));

                        const ready = await window.pyodide.runPythonAsync(`
IsTrackingReady()
                        `);

                        if (ready) {
                            console.log('Tracking ready, proceeding with save');
                            this.button.text('Saving...');
                            break;
                        }

                        attempts++;
                    }

                    if (attempts >= maxAttempts) {
                        throw new Error('Timeout waiting for tracking initialization');
                    }
                }
            }

            // Call Python SaveFont() function
            const result = await window.pyodide.runPythonAsync(`
import json
result = SaveFont()
filename = CurrentFont().filename if CurrentFont() else "unknown"
json.dumps({"success": result, "filename": filename})
            `);

            const data = JSON.parse(result);
            const duration = ((performance.now() - startTime) / 1000).toFixed(2);

            if (data.success) {
                const filename = data.filename.split('/').pop();
                console.log(`Font saved successfully: ${filename} (${duration}s)`);

                // Print to Python console
                await window.pyodide.runPythonAsync(`
print(f"Saved font to ${data.filename} in ${duration}s")
                `);

                // Mark font as clean after successful save
                await window.pyodide.runPythonAsync(`
from context import DIRTY_FILE_SAVING
font = CurrentFont()
if font:
    font.mark_clean(DIRTY_FILE_SAVING, recursive=True)
                `);

                // Update dirty indicator
                if (window.fontDropdown) {
                    window.fontDropdown.updateDirtyIndicator();
                }

                // Play done sound
                if (window.playSound) {
                    window.playSound('done');
                }

                // Reset saving state first
                this.isSaving = false;

                // Show success feedback
                this.showSuccess();
            } else {
                console.error('Font save failed');
                this.isSaving = false;
                this.showError();
            }
        } catch (error) {
            console.error('Error saving font:', error);
            this.isSaving = false;
            this.showError();
        }
    }

    /**
     * Update button state based on current font
     */
    updateButtonState() {
        const dropdown = document.getElementById('open-fonts-dropdown');
        const hasFontOpen = dropdown &&
            dropdown.options.length > 0 &&
            dropdown.value !== '' &&
            dropdown.options[0].textContent !== 'No fonts open';

        if (this.isSaving) {
            this.button.prop('disabled', true).text('Saving...');
        } else if (!hasFontOpen) {
            this.button.prop('disabled', true).text('Save');
        } else {
            this.button.prop('disabled', false).text('Save');
        }
    }

    /**
     * Show success feedback
     */
    showSuccess() {
        this.button.text('Saved!');
        setTimeout(() => {
            if (!this.isSaving) {
                this.updateButtonState();
            }
        }, 1500);
    }

    /**
     * Show error feedback
     */
    showError() {
        this.button.text('Save Failed');
        setTimeout(() => {
            if (!this.isSaving) {
                this.updateButtonState();
            }
        }, 2000);
    }
}

// Initialize save button when DOM is ready
$(document).ready(() => {
    window.saveButton = new SaveButton();
});

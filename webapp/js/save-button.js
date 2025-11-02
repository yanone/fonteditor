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

        // Register UI callbacks with Python backend
        this.registerCallbacks();
    }

    /**
     * Register callback functions that Python can call via js module
     */
    registerCallbacks() {
        // Create JavaScript functions that Python can call via js._fontSaveCallbacks
        window._fontSaveCallbacks = {
            beforeSave: (fontId, filename) => {
                console.log(`Starting save: ${filename}`);
            },

            afterSave: (fontId, filename, duration) => {
                const fname = filename.split('/').pop();
                console.log(`✅ Font saved: ${fname} (${duration.toFixed(2)}s)`);

                // Update dirty indicator
                if (window.fontDropdown) {
                    window.fontDropdown.updateDirtyIndicator();
                }

                // Play done sound
                if (window.playSound) {
                    window.playSound('done');
                }

                // Update save button state
                this.isSaving = false;
                this.showSuccess();
            },

            onError: (fontId, filename, error) => {
                console.error(`❌ Save failed: ${error}`);
                this.isSaving = false;
                this.showError();
            }
        };

        console.log('Save callbacks registered (Python will call via js module)');
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

        try {
            // Check if tracking is ready, and wait if needed
            const trackingReady = await window.pyodide.runPythonAsync(`
IsTrackingReady()
            `);

            if (!trackingReady) {
                console.log('Waiting for dirty tracking to initialize...');
                this.button.text('Preparing...');

                // Wait for tracking init promise if available
                if (window._trackingInitPromise) {
                    await window._trackingInitPromise;
                    console.log('Tracking ready, proceeding with save');
                    this.button.text('Saving...');
                }
            }

            // Simply call font.save() - callbacks will handle everything else
            const result = await window.pyodide.runPythonAsync(`
# Get font and call save - this triggers all registered callbacks
font = CurrentFont()
if font:
    font.save()
    "success"  # Return a truthy value
else:
    None
            `);

            if (!result) {
                throw new Error('No font open or save failed');
            }

            // Success - callbacks have already handled UI updates
            // Note: isSaving is set to false by afterSave callback

        } catch (error) {
            console.error('Error saving font:', error);
            // Only show error if callbacks haven't already handled it
            // (callbacks might have been called even if we got an error here)
            if (this.isSaving) {
                this.isSaving = false;
                this.showError();
            }
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

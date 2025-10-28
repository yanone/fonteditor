// Font Dropdown Management
// Synchronizes the open fonts dropdown with Python's __open_fonts list

class FontDropdownManager {
    constructor() {
        this.dropdown = document.getElementById('open-fonts-dropdown');
        this.setupEventListeners();
    }

    setupEventListeners() {
        // Handle dropdown selection changes
        this.dropdown.addEventListener('change', (e) => {
            const selectedFontId = e.target.value;
            if (selectedFontId) {
                this.setCurrentFont(selectedFontId);
            }
        });
    }

    async updateDropdown() {
        if (!window.pyodide) {
            console.warn('Pyodide not yet loaded');
            return;
        }

        try {
            // Get the list of open fonts from Python using GetOpenFonts()
            const fontsJson = await window.pyodide.runPythonAsync(`
import json
fonts_list = GetOpenFonts()
json.dumps(fonts_list)
            `);

            const fonts = JSON.parse(fontsJson);

            // Clear existing options
            this.dropdown.innerHTML = '';

            if (fonts.length === 0) {
                // No fonts open
                const option = document.createElement('option');
                option.value = '';
                option.textContent = 'No fonts open';
                this.dropdown.appendChild(option);
                this.dropdown.disabled = true;
            } else {
                // Add font options
                this.dropdown.disabled = false;
                fonts.forEach((fontInfo) => {
                    const option = document.createElement('option');
                    option.value = fontInfo.id;
                    option.textContent = fontInfo.name;
                    option.title = fontInfo.path; // Show path on hover

                    // Select the current font
                    if (fontInfo.is_current) {
                        option.selected = true;
                    }

                    this.dropdown.appendChild(option);
                });
            }
        } catch (error) {
            console.error('Error updating font dropdown:', error);
        }
    }

    async setCurrentFont(fontId) {
        if (!window.pyodide) {
            console.warn('Pyodide not yet loaded');
            return;
        }

        try {
            // Set the current font using SetCurrentFont()
            const success = await window.pyodide.runPythonAsync(`
SetCurrentFont("${fontId}")
            `);

            if (success) {
                console.log(`Set current font to ID: ${fontId}`);
            } else {
                console.error(`Failed to set current font to ID: ${fontId}`);
            }
        } catch (error) {
            console.error('Error setting current font:', error);
        }
    }    // Method to be called when a font is opened
    async onFontOpened() {
        await this.updateDropdown();
    }
}

// Initialize the font dropdown manager when page loads
document.addEventListener('DOMContentLoaded', () => {
    window.fontDropdownManager = new FontDropdownManager();

    // Poll for updates every 2 seconds
    // (Better approach would be to call updateDropdown() explicitly after OpenFont())
    const checkForUpdates = async () => {
        if (window.pyodide && window.fontDropdownManager) {
            await window.fontDropdownManager.updateDropdown();
        }
    };

    // Initial check after a delay
    setTimeout(checkForUpdates, 2000);

    // Periodic updates
    setInterval(checkForUpdates, 2000);
});

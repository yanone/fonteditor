// Compile Button Handler
// Compiles the current font to TTF using the babelfont-fontc WASM module

(function () {
    'use strict';

    const compileBtn = document.getElementById('compile-font-btn');
    let isCompiling = false;

    // Enable/disable compile button based on font availability
    function updateCompileButtonState() {
        const dropdown = document.getElementById('open-fonts-dropdown');
        const hasFontOpen = dropdown &&
            dropdown.options.length > 0 &&
            dropdown.value !== '' &&
            dropdown.options[0].textContent !== 'No fonts open';

        compileBtn.disabled = !hasFontOpen || isCompiling;
    }

    // Compile the current font
    async function compileFont() {
        if (isCompiling) return;

        if (!window.pyodide) {
            alert('Python environment not ready yet');
            return;
        }

        if (!window.fontCompilation || !window.fontCompilation.isInitialized) {
            alert('Font compilation module not ready. Make sure WASM module is built and loaded.');
            return;
        }

        try {
            isCompiling = true;
            updateCompileButtonState();

            // Update button text to show progress
            const originalText = compileBtn.textContent;
            compileBtn.textContent = 'Compiling...';

            console.log('🔨 Starting font compilation...');
            if (window.term) {
                window.term.echo('');
                window.term.echo('[[;cyan;]🔨 Compiling font to TTF...]');
            }

            // Get the font JSON from Python
            const startTime = performance.now();
            const pythonResult = await window.pyodide.runPythonAsync(`
import orjson

# Get current font using CurrentFont()
font = CurrentFont()
if not font:
    raise ValueError("No font is currently open")

# Get the font's file path for naming the output
font_path = font.path if hasattr(font, 'path') and font.path else 'font.context'

# Export to .babelfont JSON format using orjson (handles datetime objects)
font_dict = font.to_dict()
babelfont_json = orjson.dumps(font_dict).decode('utf-8')

# Return both JSON and path
(babelfont_json, font_path)
            `);

            const babelfontJson = pythonResult[0];
            const fontPath = pythonResult[1];
            const exportTime = performance.now() - startTime;
            console.log(`✅ Exported to JSON in ${exportTime.toFixed(0)}ms (${babelfontJson.length} bytes)`);

            // Compile using the WASM module
            const filename = fontPath.replace(/\.(glyphs|designspace|ufo|babelfont|context)$/, '.ttf').split('/').pop() || 'font.ttf';
            const result = await window.fontCompilation.compileFromJson(babelfontJson, filename);

            const totalTime = performance.now() - startTime;
            console.log(`✅ Total compilation time: ${totalTime.toFixed(0)}ms`);

            // Save to Pyodide's virtual filesystem
            await window.pyodide.runPythonAsync(`
import os

# Convert JavaScript Uint8Array to Python bytes
output_data = bytes(${JSON.stringify(Array.from(result.result))})

# Save to virtual filesystem
output_path = '${filename}'
with open(output_path, 'wb') as f:
    f.write(output_data)

print(f"✅ Compiled font saved to: {output_path} ({len(output_data)} bytes)")
print(f"")
print(f"📊 Compilation timing:")
print(f"   to_dict() export: ${exportTime.toFixed(0)}ms")
print(f"   WASM compilation: ${result.time_taken}ms")
print(f"   Total time: ${totalTime.toFixed(0)}ms")
            `);

            // Trigger download
            window.fontCompilation.downloadFont(result.result, filename);

            // Refresh file browser to show the new file
            if (window.refreshFileSystem) {
                window.refreshFileSystem();
            }

            // Show success message
            if (window.term) {
                window.term.echo(`[[;lime;]✅ Compiled successfully in ${totalTime.toFixed(0)}ms]`);
                window.term.echo(`[[;lime;]📥 Downloaded: ${filename} (${result.result.length} bytes)]`);
                window.term.echo(`[[;gray;]   Export: ${exportTime.toFixed(0)}ms | Compile: ${result.time_taken}ms]`);
                window.term.echo('');
            }

            // Reset button text
            compileBtn.textContent = originalText;

        } catch (error) {
            console.error('❌ Compilation failed:', error);

            if (window.term) {
                window.term.error(`❌ Compilation failed: ${error.message}`);
                window.term.echo('');
            }

            alert(`Compilation failed: ${error.message}`);

        } finally {
            isCompiling = false;
            updateCompileButtonState();
        }
    }

    // Set up event listener
    if (compileBtn) {
        compileBtn.addEventListener('click', compileFont);
    }

    // Keyboard shortcut: Cmd+B / Ctrl+B
    document.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
            e.preventDefault();
            if (!compileBtn.disabled) {
                compileFont();
            }
        }
    });

    // Listen for font changes to update button state
    window.addEventListener('fontLoaded', updateCompileButtonState);
    window.addEventListener('fontClosed', updateCompileButtonState);

    // Initial state
    updateCompileButtonState();

    // Export for external use
    window.compileFontButton = {
        compile: compileFont,
        updateState: updateCompileButtonState
    };

    console.log('✅ Compile button initialized');
})();

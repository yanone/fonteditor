class PythonConsole {
    constructor() {
        this.pyodide = null;
        this.outputElement = document.getElementById('console-output');
        this.inputElement = document.getElementById('console-input');
        this.promptElement = document.getElementById('console-prompt');
        this.inputBuffer = [];
        this.isMultiline = false;
        this.historyIndex = -1;
        this.history = [];

        this.init();
    }

    async init() {
        try {
            // Disable input while loading
            this.inputElement.disabled = true;
            
            this.addOutput('Loading Python console...', 'loading');

            // Load Pyodide
            this.pyodide = await loadPyodide();

            // Load micropip
            this.addOutput('Loading micropip...', 'loading');
            await this.pyodide.loadPackage(['micropip']);
            
            // Show welcome message
            this.addOutput('Python 3.11.3 on Pyodide', 'output');
            this.addOutput('Type "help", "copyright", "credits" or "license" for more information.', 'output');
            this.addOutput('micropip is available for package installation.', 'output');
            this.addOutput('', 'output'); // Empty line

            // Enable input and set up event listeners
            this.inputElement.disabled = false;
            this.inputElement.focus();
            this.inputElement.addEventListener('keydown', (e) => this.handleKeyDown(e));

        } catch (error) {
            this.addOutput('Error loading Python: ' + error.message, 'error');
        }
    }

    addOutput(text, type = 'output') {
        const line = document.createElement('div');
        line.className = `console-line console-${type}-line`;
        line.textContent = text;
        this.outputElement.appendChild(line);
        this.outputElement.scrollTop = this.outputElement.scrollHeight;
    }

    updatePrompt() {
        this.promptElement.textContent = this.isMultiline ? '... ' : '>>> ';
    }

    async handleKeyDown(event) {
        if (event.key === 'Enter') {
            const code = this.inputElement.value.trim();
            
            // Show the input in output
            this.addOutput((this.isMultiline ? '... ' : '>>> ') + this.inputElement.value, 'input');
            
            // Clear the input
            this.inputElement.value = '';
            
            if (!code) {
                if (this.isMultiline && this.inputBuffer.length > 0) {
                    await this.executeMultilineInput();
                }
                return;
            }
            
            // Add to history
            if (!this.isMultiline || this.inputBuffer.length === 0) {
                this.history.push(code);
                if (this.history.length > 100) this.history.shift();
                this.historyIndex = -1;
            }
            
            // Check for multiline input
            if (this.needsMoreInput(code)) {
                this.inputBuffer.push(code);
                this.isMultiline = true;
                this.updatePrompt();
                return;
            }
            
            // Execute the code
            let fullCode = code;
            if (this.isMultiline) {
                this.inputBuffer.push(code);
                fullCode = this.inputBuffer.join('\n');
                this.inputBuffer = [];
                this.isMultiline = false;
            }
            
            await this.executeCode(fullCode);
            this.updatePrompt();
            
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            this.navigateHistory(-1);
        } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            this.navigateHistory(1);
        }
    }

    navigateHistory(direction) {
        if (this.history.length === 0) return;

        this.historyIndex += direction;
        if (this.historyIndex < -1) this.historyIndex = -1;
        if (this.historyIndex >= this.history.length) this.historyIndex = this.history.length - 1;

        if (this.historyIndex === -1) {
            this.inputElement.value = '';
        } else {
            this.inputElement.value = this.history[this.history.length - 1 - this.historyIndex];
        }
    }

    async executeCode(code) {
        try {
            // Capture stdout
            this.pyodide.runPython(`
import sys
from io import StringIO
_old_stdout = sys.stdout
sys.stdout = _captured_stdout = StringIO()
            `);

            // Try to evaluate as expression first, then exec
            this.pyodide.runPython(`
try:
    _result = eval(compile(r"""${code}""", "<console>", "eval"))
    if _result is not None:
        print(repr(_result))
except SyntaxError:
    exec(compile(r"""${code}""", "<console>", "exec"))
            `);

            // Get captured output
            const output = this.pyodide.runPython(`
_captured_output = _captured_stdout.getvalue()
sys.stdout = _old_stdout
_captured_output
            `);

            if (output.trim()) {
                this.addOutput(output.trim(), 'output');
            }

        } catch (error) {
            this.addOutput(error.message, 'error');
        }
    }

    async executeMultilineInput() {
        const code = this.inputBuffer.join('\n');
        this.inputBuffer = [];
        this.isMultiline = false;
        await this.executeCode(code);
        this.updatePrompt();
    }

    needsMoreInput(input) {
        const trimmed = input.trim();
        if (trimmed.endsWith(':')) return true;
        if (trimmed.startsWith('def ') || trimmed.startsWith('class ') || 
            trimmed.startsWith('if ') || trimmed.startsWith('for ') ||
            trimmed.startsWith('while ') || trimmed.startsWith('try:') ||
            trimmed.startsWith('with ') || trimmed === 'else:' ||
            trimmed === 'except:' || trimmed.startsWith('except ') ||
            trimmed === 'finally:') return true;
        return false;
    }
                this.currentInput = '';
                this.inputBuffer = [];
                this.isMultiline = false;
                this.showPrompt();
                continue;
            }
            
            if (char === 4) { // Ctrl+D (EOF)
                if (this.currentInput === '') {
                    this.terminal.writeln('exit()');
                    this.terminal.writeln('Use exit() or Ctrl+Z plus Return to exit');
                    this.showPrompt();
                } else {
                    // In the middle of input, ignore
                }
                continue;
            }
            
            if (char === 13) { // Enter key
                this.terminal.writeln('');
                await this.executeInput();
                continue;
            }
            
            if (char === 127 || char === 8) { // Backspace (DEL or BS)
                if (this.currentInput.length > 0) {
                    this.currentInput = this.currentInput.slice(0, -1);
                    this.terminal.write('\b \b');
                }
                continue;
            }
            
            if (char === 9) { // Tab - for now just insert spaces
                const spaces = '    '; // 4 spaces
                this.currentInput += spaces;
                this.terminal.write(spaces);
                continue;
            }
            
            // Handle printable characters
            if (char >= 32 && char <= 126) {
                const character = String.fromCharCode(char);
                this.currentInput += character;
                this.terminal.write(character);
            }
        }
    }

    navigateHistory(direction) {
        if (this.history.length === 0) return;

        // Clear current input
        for (let i = 0; i < this.currentInput.length; i++) {
            this.terminal.write('\\b \\b');
        }

        // Update history index
        this.historyIndex += direction;
        if (this.historyIndex < -1) this.historyIndex = -1;
        if (this.historyIndex >= this.history.length) this.historyIndex = this.history.length - 1;

        // Set new input
        if (this.historyIndex === -1) {
            this.currentInput = '';
        } else {
            this.currentInput = this.history[this.history.length - 1 - this.historyIndex];
            this.terminal.write(this.currentInput);
        }
    }

    async executeInput() {
        const input = this.currentInput.trim();

        if (input === '') {
            if (this.isMultiline && this.inputBuffer.length > 0) {
                await this.executeMultilineInput();
            } else {
                this.showPrompt();
            }
            return;
        }

        // Add to history
        if (input && (!this.isMultiline || this.inputBuffer.length === 0)) {
            this.history.push(input);
            if (this.history.length > 100) this.history.shift();
            this.historyIndex = -1;
        }

        // Check for multiline input
        if (this.needsMoreInput(input)) {
            this.inputBuffer.push(this.currentInput);
            this.isMultiline = true;
            this.currentInput = '';
            this.showPrompt();
            return;
        }

        // Execute the code
        let code = input;
        if (this.isMultiline) {
            this.inputBuffer.push(this.currentInput);
            code = this.inputBuffer.join('\\n');
            this.inputBuffer = [];
            this.isMultiline = false;
        }

        try {
            // Try to evaluate as expression first
            let result = await this.pyodide.runPython(`
try:
    __result__ = eval(compile(r"""${code}""", "<console>", "eval"))
    if __result__ is not None:
        repr(__result__)
    else:
        None
except SyntaxError:
    exec(compile(r"""${code}""", "<console>", "exec"))
    None
            `);

            if (result !== null) {
                this.terminal.writeln(result);
            }

        } catch (error) {
            this.terminal.writeln('\\x1b[31m' + error.message + '\\x1b[0m');
        }

        this.currentInput = '';
        this.showPrompt();
    }

    async executeMultilineInput() {
        const code = this.inputBuffer.join('\\n');
        this.inputBuffer = [];
        this.isMultiline = false;

        try {
            await this.pyodide.runPython(code);
        } catch (error) {
            this.terminal.writeln('\\x1b[31m' + error.message + '\\x1b[0m');
        }

        this.currentInput = '';
        this.showPrompt();
    }

    needsMoreInput(input) {
        // Simple heuristic for multiline input
        const trimmed = input.trim();
        if (trimmed.endsWith(':')) return true;
        if (trimmed.startsWith('def ') || trimmed.startsWith('class ') ||
            trimmed.startsWith('if ') || trimmed.startsWith('for ') ||
            trimmed.startsWith('while ') || trimmed.startsWith('try:') ||
            trimmed.startsWith('with ') || trimmed === 'else:' ||
            trimmed === 'except:' || trimmed.startsWith('except ') ||
            trimmed === 'finally:') return true;

        return false;
    }
}

// Initialize console when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
        new PythonConsole();
    }, 100);
});
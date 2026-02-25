// @ts-nocheck
// Official Pyodide Console integration
// Based on https://github.com/pyodide/pyodide/blob/main/src/templates/console.html

declare function loadPyodide(options?: unknown): Promise<any>;
declare function showDirectoryPicker(options?: unknown): Promise<any>;

function sleep(s: number) {
    return new Promise((resolve) => setTimeout(resolve, s));
}

async function initPyodideConsole() {
    'use strict';

    // Import dependencies
    const { get, set } = await import('idb-keyval');
    const { showCriticalError, isWebAssemblyMemoryError } =
        await import('./critical-error-handler');

    let term: any;
    let pyodide: any;
    let pyconsole: any;
    let namespace: any;
    let await_fut: any;

    // Hide loading spinner initially
    const loadingEl = document.getElementById('loading') as HTMLElement | null;
    if (loadingEl) {
        loadingEl.style.display = 'block';
    }

    try {
        // Load Pyodide
        pyodide = await loadPyodide({
            stdin: () => {
                let result = prompt();
                echo(result);
                return result;
            }
        });

        // Make pyodide globally available
        window.pyodide = pyodide;
        globalThis.pyodide = pyodide;

        // Import console components
        let { repr_shorten, BANNER, PyodideConsole } =
            pyodide.pyimport('pyodide.console');

        BANNER =
            `Welcome to the Pyodide ${pyodide.version} terminal emulator 🐍\n` +
            BANNER;
        pyconsole = PyodideConsole(pyodide.globals);

        namespace = pyodide.globals.get('dict')();
        await_fut = pyodide.runPython(
            `
      import builtins
      from pyodide.ffi import to_js

      async def await_fut(fut):
          res = await fut
          if res is not None:
              builtins._ = res
          return to_js([res], depth=1)

      await_fut
      `,
            { globals: namespace }
        );
        namespace.destroy();

        const echo = (msg: string, ...opts: unknown[]) =>
            term.echo(
                msg
                    .replaceAll(']]', '&rsqb;&rsqb;')
                    .replaceAll('[[', '&lsqb;&lsqb;'),
                ...opts
            );

        const ps1 = '>>> ';
        const ps2 = '... ';

        async function lock() {
            let resolve: (() => void) | undefined;
            const ready = term.ready;
            term.ready = new Promise((res) => (resolve = res));
            await ready;
            return resolve ?? (() => undefined);
        }

        async function interpreter(command: string) {
            // Call before-execution hook
            if (window.beforePythonExecution) {
                window.beforePythonExecution();
            }

            // Log command to browser console
            if (command && command.trim()) {
                console.group('🐍 Python Console Command');
                console.log('[PyodideConsole]', command);
                console.groupEnd();
            }

            const unlock = await lock();
            term.pause();
            // multiline should be split (useful when pasting)
            for (const c of command.split('\n')) {
                const escaped = c.replaceAll(/\u00a0/g, ' ');
                const fut = pyconsole.push(escaped);
                term.set_prompt(fut.syntax_check === 'incomplete' ? ps2 : ps1);
                switch (fut.syntax_check) {
                    case 'syntax-error':
                        term.error(fut.formatted_error.trimEnd());
                        continue;
                    case 'incomplete':
                        continue;
                    case 'complete':
                        break;
                    default:
                        throw new Error(`Unexpected type ${fut.syntax_check}`);
                }
                // In JavaScript, await automatically also awaits any results of
                // awaits, so if an async function returns a future, it will await
                // the inner future too. This is not what we want so we
                // temporarily put it into a list to protect it.
                const wrapped = await_fut(fut);
                // complete case, get result / error and print it.
                try {
                    const [value] = await wrapped;
                    if (value !== undefined) {
                        echo(
                            repr_shorten.callKwargs(value, {
                                separator: '\n<long output truncated>\n'
                            })
                        );
                    }
                    if (value instanceof pyodide.ffi.PyProxy) {
                        value.destroy();
                    }

                    // Log completion to browser console
                    console.log(
                        '[PyodideConsole]',
                        '✅ Console command completed successfully'
                    );
                } catch (e) {
                    const errorMessage =
                        e instanceof Error ? e.message : String(e);
                    // Log error to browser console
                    console.error(
                        '[PyodideConsole]',
                        '❌ Console command failed:',
                        errorMessage
                    );
                    if (
                        (e as { constructor?: { name?: string } }).constructor
                            ?.name === 'PythonError'
                    ) {
                        const message = fut.formatted_error || errorMessage;
                        const cleanedMessage =
                            window.cleanPythonTraceback(message);
                        term.error(cleanedMessage.trimEnd());
                    } else {
                        throw e;
                    }
                } finally {
                    fut.destroy();
                    wrapped.destroy();
                }
            }
            term.resume();
            await sleep(10);
            unlock();

            // Call after-execution hook (always, after all commands processed)
            if (window.afterPythonExecution) {
                window.afterPythonExecution();
            }
        }

        // Initialize terminal in the console container
        term = $('#console-container').terminal(interpreter, {
            greetings: BANNER,
            prompt: ps1,
            completionEscape: false,
            completion: function (
                command: string,
                callback: (items: any[]) => void
            ) {
                callback(pyconsole.complete(command).toJs()[0]);
            },
            keymap: {
                'CTRL+C': async function (_event: Event, _original: unknown) {
                    pyconsole.buffer.clear();
                    term.enter();
                    echo('KeyboardInterrupt');
                    term.set_command('');
                    term.set_prompt(ps1);
                },
                'CTRL+K': function (_event: Event, _original: unknown) {
                    // Clear the terminal output
                    term.clear();
                    return false;
                },
                'META+K': function (_event: Event, _original: unknown) {
                    // Clear the terminal output (for macOS cmd+k)
                    term.clear();
                    return false;
                },
                'TAB': (event: Event, original: (evt: Event) => unknown) => {
                    const command = term.before_cursor();
                    // Disable completion for whitespaces.
                    if (command.trim() === '') {
                        term.insert('\t');
                        return false;
                    }
                    return original(event);
                }
            }
        });

        window.term = term;

        // Add custom wheel event handler to reduce scrolling speed
        // Wait a bit for terminal to fully initialize
        setTimeout(() => {
            const consoleContainer =
                document.getElementById('console-container');

            console.log(
                '[PyodideConsole]',
                'Setting up wheel handler for console-container'
            );

            if (consoleContainer) {
                consoleContainer.addEventListener(
                    'wheel',
                    function (e: WheelEvent) {
                        e.preventDefault();
                        e.stopPropagation();

                        console.log(
                            '[PyodideConsole]',
                            'Wheel event captured, deltaY:',
                            e.deltaY
                        );

                        // Find the actual scrollable element - could be terminal-scroller or terminal-output
                        let scrollableElement =
                            consoleContainer.querySelector(
                                '.terminal-scroller'
                            );
                        if (
                            !scrollableElement ||
                            scrollableElement.scrollHeight <=
                                scrollableElement.clientHeight
                        ) {
                            scrollableElement =
                                consoleContainer.querySelector(
                                    '.terminal-output'
                                );
                        }
                        if (
                            !scrollableElement ||
                            scrollableElement.scrollHeight <=
                                scrollableElement.clientHeight
                        ) {
                            scrollableElement =
                                consoleContainer.querySelector('.terminal');
                        }

                        if (!scrollableElement) {
                            console.log(
                                '[PyodideConsole]',
                                'No scrollable element found'
                            );
                            return;
                        }

                        console.log(
                            '[PyodideConsole]',
                            'Scrolling element:',
                            scrollableElement.className,
                            'current scrollTop:',
                            scrollableElement.scrollTop
                        );

                        // Reduce scroll speed by dividing deltaY by 20
                        const scrollAmount = e.deltaY / 2;
                        scrollableElement.scrollTop += scrollAmount;
                        console.log(
                            '[PyodideConsole]',
                            'Scrolled to:',
                            scrollableElement.scrollTop
                        );
                    },
                    { passive: false, capture: true }
                );
            }
        }, 500);

        pyconsole.stdout_callback = (s: string) => {
            // Filter system messages from interactive console too
            if (isSystemMessage(s)) {
                console.log(
                    '[PyodideConsole]',
                    '[Pyodide Interactive]:',
                    s.trim()
                );
                return;
            }
            echo(s, { newline: false });
        };
        pyconsole.stderr_callback = (s: string) => {
            // Filter stderr system messages from interactive console
            if (isSystemMessage(s)) {
                console.warn(
                    '[PyodideConsole]',
                    '[Pyodide Interactive]:',
                    s.trim()
                );
                return;
            }
            term.error(s.trimEnd());
        };
        term.ready = Promise.resolve();

        // Make console output functions globally available
        window.consoleEcho = echo;
        window.consoleError = (s: string) => term.error(s);

        // Filter function to identify system messages vs user print output
        function isSystemMessage(message: string): boolean {
            const systemPatterns = [
                /^Loading\s+\w+/i,
                /^Loaded\s+\w+/i,
                /^Installing\s+\w+/i,
                /^Installed\s+\w+/i,
                /^Downloading\s+/i,
                /^Downloaded\s+/i,
                /^Building\s+/i,
                /^Built\s+/i,
                /^Collecting\s+/i,
                /^Successfully\s+installed\s+/i,
                /^Requirement\s+already\s+satisfied/i,
                /^WARNING:\s+/i,
                /^Note:\s+/i,
                /micropip\s+install/i,
                /package\s+installed/i,
                /imported\s+successfully/i,
                /^Initializing/i,
                /^FontEditor/i
            ];

            return systemPatterns.some((pattern) =>
                pattern.test(message.trim())
            );
        }

        // Set global stdout/stderr callbacks for pyodide.runPython() calls
        pyodide.setStdout({
            batched: (s: string) => {
                // Filter out system messages - send them to browser console instead
                if (isSystemMessage(s)) {
                    console.log(
                        '[PyodideConsole]',
                        '[Pyodide System]:',
                        s.trim()
                    );
                    return;
                }

                // Only show user print() output in the Python console
                if (s && !s.endsWith('\n')) {
                    echo(s); // Default behavior adds newline
                } else {
                    echo(s, { newline: false });
                }
            }
        });
        pyodide.setStderr({
            batched: (s: string) => {
                // Filter stderr system messages too
                if (isSystemMessage(s)) {
                    console.warn(
                        '[PyodideConsole]',
                        '[Pyodide System]:',
                        s.trim()
                    );
                    return;
                }
                term.error(s.trimEnd());
            }
        });

        pyodide._api.on_fatal = async (e: any) => {
            if (e?.name === 'Exit') {
                term.error(e);
                term.error('Pyodide exited and can no longer be used.');
            } else {
                term.error(
                    'Pyodide has suffered a fatal error. Please report this to the Pyodide maintainers.'
                );
                term.error('The cause of the fatal error was:');
                term.error(e);
                term.error('Look in the browser console for more details.');
            }
            await term.ready;
            term.pause();
            await sleep(15);
            term.pause();
        };

        // Wrap pyodide.runPython to handle errors properly
        const pyodide_py = pyodide.runPython;
        pyodide.runPython = (...args) => {
            try {
                const result = pyodide_py(...args);
                if (result && typeof result.then !== 'undefined') {
                    return result
                        .then((r: any) => {
                            if (r && r.toJs) {
                                r = r.toJs();
                            }
                            return r;
                        })
                        .catch((e: any) => {
                            // Handle Python exceptions and display in console
                            if (e.constructor.name === 'PythonError') {
                                term.error(e.message);
                            } else {
                                term.error(e.toString());
                            }
                            throw e; // Re-throw for caller to handle if needed
                        });
                } else {
                    if (result && result.toJs) {
                        return result.toJs();
                    }
                    return result;
                }
            } catch (e: any) {
                // Handle synchronous Python exceptions
                if (e.constructor.name === 'PythonError') {
                    term.error(e.message);
                } else {
                    term.error(e.toString());
                }
                throw e; // Re-throw for caller to handle if needed
            }
        };

        // Set up directory mounting if supported
        if ('showDirectoryPicker' in window) {
            async function mountDirectory() {
                const opts = {
                    mode: 'readwrite'
                };
                const pyodideDirectory = '/home/pyodide';
                const directoryKey = 'pyodide-directory-handle';
                let directoryHandle = await get(directoryKey);
                if (!directoryHandle) {
                    directoryHandle = await showDirectoryPicker(opts);
                    await set(directoryKey, directoryHandle);
                }
                const permissionStatus =
                    await directoryHandle.requestPermission(opts);
                if (permissionStatus !== 'granted') {
                    throw new Error(
                        'readwrite access to directory not granted'
                    );
                }
                await pyodide.mountNativeFS(pyodideDirectory, directoryHandle);
            }
            globalThis.mountDirectory = mountDirectory;
            window.mountDirectory = mountDirectory;

            async function getMountedDirectoryInfo() {
                const directoryKey = 'pyodide-directory-handle';
                const directoryHandle = await get(directoryKey);

                if (!directoryHandle) {
                    return {
                        mounted: false,
                        message: 'No directory mounted'
                    };
                }

                const permission = await directoryHandle.queryPermission({
                    mode: 'readwrite'
                });

                return {
                    mounted: true,
                    folderName: directoryHandle.name,
                    permission: permission,
                    message: `Mounted: "${directoryHandle.name}" (${permission})`
                };
            }
            globalThis.getMountedDirectoryInfo = getMountedDirectoryInfo;
            window.getMountedDirectoryInfo = getMountedDirectoryInfo;

            async function unmountDirectory() {
                const directoryKey = 'pyodide-directory-handle';
                const { del } = await import('idb-keyval');
                await del(directoryKey);
                console.log(
                    '[PyodideConsole]',
                    'Directory handle removed from IndexedDB. Reload page to take effect.'
                );
                return 'Directory unmounted. Please reload the page.';
            }
            globalThis.unmountDirectory = unmountDirectory;
            window.unmountDirectory = unmountDirectory;
        } else {
            // Provide helpful error messages when File System Access API is not available
            window.mountDirectory = () => {
                throw new Error(
                    'File System Access API not supported in this browser. Use Chrome or Edge.'
                );
            };
            window.getMountedDirectoryInfo = () => {
                return {
                    mounted: false,
                    message:
                        'File System Access API not supported in this browser'
                };
            };
            window.unmountDirectory = () => {
                throw new Error(
                    'File System Access API not supported in this browser. Use Chrome or Edge.'
                );
            };
        }

        // Hide loading spinner
        if (loadingEl) {
            loadingEl.style.display = 'none';
        }

        // Focus on terminal
        term.focus();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(
            '[PyodideConsole]',
            'Error initializing Pyodide console:',
            error
        );

        // Check if this is a WebAssembly memory error
        if (isWebAssemblyMemoryError(error)) {
            showCriticalError(
                'Memory Allocation Error',
                'The application cannot allocate enough memory to run.',
                'Please close all browser tabs of the editor and reopen the application from scratch.'
            );
        } else {
            // Show regular error message for other errors
            if (loadingEl) {
                loadingEl.innerHTML = `
      <div style="color: red; padding: 20px;">
        Error loading Python console: ${message}
      </div>
    `;
            }
        }
    }
}

// Global function to safely clear the console
window.clearConsole = function () {
    // Try window.term first
    if (window.term && typeof window.term.clear === 'function') {
        window.term.clear();
        return true;
    }

    // Fallback: try to get terminal directly from jQuery
    const terminalElement = $('#console-container');
    if (terminalElement.length && terminalElement.terminal) {
        const term = terminalElement.terminal();
        if (term && typeof term.clear === 'function') {
            term.clear();
            return true;
        }
    }

    console.warn('[PyodideConsole]', 'Console terminal not yet initialized');
    return false;
};

// Global keyboard shortcut for Cmd+K to clear console
document.addEventListener('keydown', (event) => {
    // Skip if event already handled
    if (event.defaultPrevented) return;

    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    const cmdKey = isMac ? event.metaKey : event.ctrlKey;
    const shiftKey = event.shiftKey;
    const code = event.code;

    // Check if Cmd+K (without Shift or Alt) to clear console
    if (cmdKey && !event.altKey && !shiftKey && code === 'KeyK') {
        event.preventDefault();
        event.stopPropagation();
        window.clearConsole();
        return;
    }
});

// Initialize when DOM is ready and container exists
document.addEventListener('DOMContentLoaded', () => {
    // Wait a bit for the view to be properly rendered
    setTimeout(() => {
        if (document.getElementById('console-container')) {
            initPyodideConsole();
        }
    }, 100);

    // Add click handler for Clear button
    const clearButton = document.getElementById('clear-console-btn');
    if (clearButton) {
        clearButton.addEventListener('click', (event) => {
            event.stopPropagation(); // Prevent view focus
            window.clearConsole();
        });
    }
});

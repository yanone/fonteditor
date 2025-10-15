// Official Pyodide Console integration
// Based on https://github.com/pyodide/pyodide/blob/main/src/templates/console.html

function sleep(s) {
    return new Promise((resolve) => setTimeout(resolve, s));
}

async function initPyodideConsole() {
    "use strict";

    let term;
    let pyodide;
    let pyconsole;
    let namespace;
    let await_fut;

    // Hide loading spinner initially
    document.getElementById('loading').style.display = 'block';

    try {
        // Load Pyodide
        pyodide = await loadPyodide({
            stdin: () => {
                let result = prompt();
                echo(result);
                return result;
            },
        });

        // Make pyodide globally available
        window.pyodide = pyodide;
        globalThis.pyodide = pyodide;

        // Import console components
        let { repr_shorten, BANNER, PyodideConsole } = pyodide.pyimport("pyodide.console");

        BANNER = `Welcome to the Pyodide ${pyodide.version} terminal emulator 🐍\n` + BANNER;
        pyconsole = PyodideConsole(pyodide.globals);

        namespace = pyodide.globals.get("dict")();
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
            { globals: namespace },
        );
        namespace.destroy();

        const echo = (msg, ...opts) =>
            term.echo(
                msg
                    .replaceAll("]]", "&rsqb;&rsqb;")
                    .replaceAll("[[", "&lsqb;&lsqb;"),
                ...opts,
            );

        const ps1 = ">>> ";
        const ps2 = "... ";

        async function lock() {
            let resolve;
            const ready = term.ready;
            term.ready = new Promise((res) => (resolve = res));
            await ready;
            return resolve;
        }

        async function interpreter(command) {
            const unlock = await lock();
            term.pause();
            // multiline should be split (useful when pasting)
            for (const c of command.split("\n")) {
                const escaped = c.replaceAll(/\u00a0/g, " ");
                const fut = pyconsole.push(escaped);
                term.set_prompt(fut.syntax_check === "incomplete" ? ps2 : ps1);
                switch (fut.syntax_check) {
                    case "syntax-error":
                        term.error(fut.formatted_error.trimEnd());
                        continue;
                    case "incomplete":
                        continue;
                    case "complete":
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
                                separator: "\n<long output truncated>\n",
                            }),
                        );
                    }
                    if (value instanceof pyodide.ffi.PyProxy) {
                        value.destroy();
                    }
                } catch (e) {
                    if (e.constructor.name === "PythonError") {
                        const message = fut.formatted_error || e.message;
                        term.error(message.trimEnd());
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
        }

        // Initialize terminal in the console container
        term = $("#console-container").terminal(interpreter, {
            greetings: BANNER,
            prompt: ps1,
            completionEscape: false,
            completion: function (command, callback) {
                callback(pyconsole.complete(command).toJs()[0]);
            },
            keymap: {
                "CTRL+C": async function (event, original) {
                    pyconsole.buffer.clear();
                    term.enter();
                    echo("KeyboardInterrupt");
                    term.set_command("");
                    term.set_prompt(ps1);
                },
                TAB: (event, original) => {
                    const command = term.before_cursor();
                    // Disable completion for whitespaces.
                    if (command.trim() === "") {
                        term.insert("\t");
                        return false;
                    }
                    return original(event);
                },
            },
        });

        window.term = term;
        pyconsole.stdout_callback = (s) => echo(s, { newline: false });
        pyconsole.stderr_callback = (s) => {
            term.error(s.trimEnd());
        };
        term.ready = Promise.resolve();

        pyodide._api.on_fatal = async (e) => {
            if (e.name === "Exit") {
                term.error(e);
                term.error("Pyodide exited and can no longer be used.");
            } else {
                term.error(
                    "Pyodide has suffered a fatal error. Please report this to the Pyodide maintainers.",
                );
                term.error("The cause of the fatal error was:");
                term.error(e);
                term.error("Look in the browser console for more details.");
            }
            await term.ready;
            term.pause();
            await sleep(15);
            term.pause();
        };

        // Set up directory mounting if supported
        if ("showDirectoryPicker" in window) {
            const pyodide_py = pyodide.runPython;
            pyodide.runPython = (...args) => {
                const result = pyodide_py(...args);
                if (result && typeof result.then !== "undefined") {
                    return result.then((r) => {
                        if (r && r.toJs) {
                            r = r.toJs();
                        }
                        return r;
                    });
                } else {
                    if (result && result.toJs) {
                        return result.toJs();
                    }
                    return result;
                }
            };

            async function mountDirectory() {
                const opts = {
                    mode: "readwrite",
                };
                const { get, set } = await import("https://cdn.skypack.dev/idb-keyval");
                const pyodideDirectory = "/home/pyodide";
                const directoryKey = "pyodide-directory-handle";
                let directoryHandle = await get(directoryKey);
                if (!directoryHandle) {
                    directoryHandle = await showDirectoryPicker(opts);
                    await set(directoryKey, directoryHandle);
                }
                const permissionStatus =
                    await directoryHandle.requestPermission(opts);
                if (permissionStatus !== "granted") {
                    throw new Error("readwrite access to directory not granted");
                }
                await pyodide.mountNativeFS(pyodideDirectory, directoryHandle);
            }
            globalThis.mountDirectory = mountDirectory;
        }

        // Hide loading spinner
        document.getElementById('loading').style.display = 'none';

        // Focus on terminal
        term.focus();

    } catch (error) {
        console.error("Error initializing Pyodide console:", error);
        document.getElementById('loading').innerHTML = `
      <div style="color: red; padding: 20px;">
        Error loading Python console: ${error.message}
      </div>
    `;
    }
}

// Initialize when DOM is ready and container exists
document.addEventListener('DOMContentLoaded', () => {
    // Wait a bit for the view to be properly rendered
    setTimeout(() => {
        if (document.getElementById('console-container')) {
            initPyodideConsole();
        }
    }, 100);
});
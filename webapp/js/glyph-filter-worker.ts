/// <reference lib="webworker" />

import { Font } from './babelfont-model';

type WorkerRequest =
    | {
          type: 'init';
      }
    | {
          type: 'runBuiltinFilter';
          id: number;
          keyword: string;
          fontJson: string;
          timeoutMs: number;
      }
    | {
          type: 'runUserFilter';
          id: number;
          code: string;
          fontJson: string;
          timeoutMs: number;
      }
    | {
          type: 'installPackages';
          id: number;
          packages: string[];
      }
    | {
          type: 'syncSharedContext';
          id: number;
          context: Record<string, any>;
          version: number;
      };

type FilterExecutionRequest =
    | Extract<WorkerRequest, { type: 'runBuiltinFilter' }>
    | Extract<WorkerRequest, { type: 'runUserFilter' }>;

let pyodide: any = null;
let initPromise: Promise<void> | null = null;
const installedDynamicPackages = new Set<string>();
let sharedContextVersion = 0;
let sharedPluginContext: Record<string, any> = {};
let pendingContextPatch: Record<string, any> | null = null;

async function installWheels(py: any): Promise<void> {
    const manifestResponse = await fetch('/wheels/wheels.json');
    const manifest = await manifestResponse.json();
    const wheelFiles: string[] = manifest.wheels || [];

    await py.loadPackage('micropip');
    await py.runPythonAsync('import micropip');

    for (const wheelFile of wheelFiles) {
        const wheelUrl = `/wheels/${wheelFile}`;
        await py.runPythonAsync(
            `await micropip.install(${JSON.stringify(wheelUrl)})`
        );
    }
}

async function ensureWorkerRuntime(): Promise<void> {
    if (pyodide) {
        return;
    }

    if (initPromise) {
        return initPromise;
    }

    initPromise = (async () => {
        const pyodideModule: any = await (0, eval)(
            'import("https://cdn.jsdelivr.net/pyodide/v0.29.0/full/pyodide.mjs")'
        );

        pyodide = await pyodideModule.loadPyodide({});
        await installWheels(pyodide);

        const fonteditorModule = await fetch('/py/fonteditor.py');
        const fonteditorCode = await fonteditorModule.text();
        await pyodide.runPython(fonteditorCode);

        await pyodide.runPythonAsync(`
import sys
from io import StringIO
import types
from importlib.metadata import entry_points
import js
import pyodide.ffi

_CP_PLUGIN_CACHE = {}
_CP_DISCOVERED = None

def CurrentContext():
    if type(js.self.sharedPluginContext) is pyodide.ffi.JsNull:
        return {}
    return _cp_wrap_js_value(js.self.sharedPluginContext)


def SetContextPatch(patch):
    js.self.setPendingContextPatch(_unwrap_py_value(patch))


def _discover_plugins():
    global _CP_DISCOVERED
    if _CP_DISCOVERED is not None:
        return _CP_DISCOVERED

    discovered = {}
    if sys.version_info >= (3, 10):
        eps = entry_points(group='counterpunch_glyphfilter_plugins')
    else:
        eps = entry_points().get('counterpunch_glyphfilter_plugins', [])

    for ep in eps:
        try:
            plugin_class = ep.load()
            plugin_instance = plugin_class()
            keyword = getattr(plugin_instance, 'keyword', ep.name)
            discovered[keyword] = plugin_instance
        except Exception:
            continue

    _CP_DISCOVERED = discovered
    return discovered


def _get_builtin_plugin(keyword):
    plugin = _CP_PLUGIN_CACHE.get(keyword)
    if plugin is not None:
        return plugin

    discovered = _discover_plugins()
    plugin = discovered.get(keyword)
    if plugin is None:
        raise RuntimeError(f"Glyph filter plugin not found: {keyword}")

    _CP_PLUGIN_CACHE[keyword] = plugin
    return plugin


def _run_builtin_filter(keyword: str):
    plugin = _get_builtin_plugin(keyword)

    groups = {}
    if hasattr(plugin, 'get_groups'):
        groups = plugin.get_groups() or {}

    if not hasattr(plugin, 'filter_glyphs'):
        return {'results': [], 'groups': groups, 'status': 'no_filter_function'}

    _font = CurrentFont()
    _result = plugin.filter_glyphs(_font)
    if isinstance(_result, types.GeneratorType):
        _result = list(_result)

    return {'results': _result or [], 'groups': groups, 'status': 'ok'}


def _run_user_filter(code: str):
    _captured_output = StringIO()
    _old_stdout = sys.stdout
    sys.stdout = _captured_output

    _filter_result = {'results': [], 'groups': {}, 'status': 'ok'}
    try:
        _compiled_code = compile(code, '<filter>', 'exec')
        _user_globals = {}
        exec(_compiled_code, _user_globals)

        _groups = _user_globals.get('GROUPS', {})
        _filter_func = _user_globals.get('filter_glyphs')

        if _filter_func is None:
            _filter_result = {
                'results': [],
                'groups': {},
                'status': 'no_filter_function'
            }
        else:
            _font = CurrentFont()
            _results = _filter_func(_font)
            if isinstance(_results, types.GeneratorType):
                _results = list(_results)

            _filter_result = {
                'results': _results or [],
                'groups': _groups or {},
                'status': 'ok'
            }
    finally:
        sys.stdout = _old_stdout

    return _filter_result
`);
    })();

    try {
        await initPromise;
    } catch (error) {
        initPromise = null;
        pyodide = null;
        throw error;
    }
}

async function runWithTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number
): Promise<T> {
    if (!timeoutMs || timeoutMs <= 0) {
        return promise;
    }

    const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(
            () =>
                reject(
                    new Error(`Filter execution timed out (${timeoutMs}ms)`)
                ),
            timeoutMs
        );
    });

    return Promise.race([promise, timeoutPromise]);
}

async function executeFilter(request: FilterExecutionRequest) {
    await ensureWorkerRuntime();

    const fontModel = Font.fromJSONString(request.fontJson);
    (self as any).currentFontModel = fontModel;
    pendingContextPatch = null;

    try {
        const pythonCode =
            request.type === 'runBuiltinFilter'
                ? `_run_builtin_filter(${JSON.stringify(request.keyword)})`
                : `_run_user_filter(${JSON.stringify(request.code)})`;

        const resultProxy: any = await runWithTimeout<any>(
            pyodide.runPythonAsync(pythonCode),
            request.timeoutMs
        );

        let result: any = {
            results: [],
            groups: {},
            status: 'ok'
        };

        if (resultProxy && resultProxy.toJs) {
            result = resultProxy.toJs({
                dict_converter: Object.fromEntries
            });
            resultProxy.destroy();
        }

        (self as unknown as DedicatedWorkerGlobalScope).postMessage({
            id: request.id,
            ok: true,
            results: result.results || [],
            groups: result.groups || {},
            status: result.status || 'ok',
            contextPatch: pendingContextPatch || undefined
        });
    } catch (error: any) {
        (self as unknown as DedicatedWorkerGlobalScope).postMessage({
            id: request.id,
            ok: false,
            error: error?.message || String(error)
        });
    } finally {
        (self as any).currentFontModel = null;
        pendingContextPatch = null;
    }
}

async function installPackages(
    request: Extract<WorkerRequest, { type: 'installPackages' }>
) {
    await ensureWorkerRuntime();

    const requestedPackages = Array.isArray(request.packages)
        ? request.packages
        : [];
    const uniquePackages = Array.from(
        new Set(requestedPackages.filter((pkg) => typeof pkg === 'string'))
    );
    const packagesToInstall = uniquePackages.filter(
        (pkg) => !installedDynamicPackages.has(pkg)
    );

    try {
        for (const pkg of packagesToInstall) {
            await pyodide.runPythonAsync(
                `await micropip.install(${JSON.stringify(pkg)})`
            );
            installedDynamicPackages.add(pkg);
        }

        (self as unknown as DedicatedWorkerGlobalScope).postMessage({
            id: request.id,
            ok: true,
            installed: packagesToInstall
        });
    } catch (error: any) {
        (self as unknown as DedicatedWorkerGlobalScope).postMessage({
            id: request.id,
            ok: false,
            error: error?.message || String(error)
        });
    }
}

async function syncSharedContext(
    request: Extract<WorkerRequest, { type: 'syncSharedContext' }>
) {
    await ensureWorkerRuntime();

    const incomingVersion =
        typeof request.version === 'number' ? request.version : 0;
    if (incomingVersion <= sharedContextVersion) {
        (self as unknown as DedicatedWorkerGlobalScope).postMessage({
            id: request.id,
            ok: true,
            applied: false,
            version: sharedContextVersion
        });
        return;
    }

    sharedContextVersion = incomingVersion;
    sharedPluginContext =
        request.context && typeof request.context === 'object'
            ? request.context
            : {};
    (self as any).sharedPluginContext = sharedPluginContext;

    (self as unknown as DedicatedWorkerGlobalScope).postMessage({
        id: request.id,
        ok: true,
        applied: true,
        version: sharedContextVersion
    });
}

(self as any).setPendingContextPatch = (patch: any) => {
    if (patch && typeof patch === 'object') {
        pendingContextPatch = patch;
    }
};
(self as any).sharedPluginContext = sharedPluginContext;

(self as unknown as DedicatedWorkerGlobalScope).onmessage = async (event) => {
    const request = event.data as WorkerRequest;

    if (!request || !request.type) {
        return;
    }

    if (request.type === 'init') {
        try {
            await ensureWorkerRuntime();
            (self as unknown as DedicatedWorkerGlobalScope).postMessage({
                type: 'ready'
            });
        } catch (error: any) {
            (self as unknown as DedicatedWorkerGlobalScope).postMessage({
                type: 'error',
                during: 'init',
                error: error?.message || String(error)
            });
        }
        return;
    }

    if (request.type === 'installPackages') {
        await installPackages(request);
        return;
    }

    if (request.type === 'syncSharedContext') {
        await syncSharedContext(request);
        return;
    }

    await executeFilter(request);
};

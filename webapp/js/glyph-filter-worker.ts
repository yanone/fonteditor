/// <reference lib="webworker" />

import { Font } from './babelfont-model';
import { GLYPH_FILTER_EVENT_TYPES } from './glyph-filter-events';
import type { GlyphFilterChangeBatch } from './glyph-filter-events';

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
          changeBatch: GlyphFilterChangeBatch;
      }
    | {
          type: 'runUserFilter';
          id: number;
          code: string;
          fontJson: string;
          timeoutMs: number;
          changeBatch: GlyphFilterChangeBatch;
      }
    | {
          type: 'inspectUserFilterSource';
          id: number;
          code: string;
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
const EMPTY_CHANGE_BATCH: GlyphFilterChangeBatch = { changes: [] };

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
import ast
from io import StringIO
import types
from importlib.metadata import entry_points
import js
import pyodide.ffi

_CP_GLYPH_FILTER_EVENT_TYPES = set(${JSON.stringify(GLYPH_FILTER_EVENT_TYPES)})

_CP_PLUGIN_CACHE = {}
_CP_DISCOVERED = None

def Context():
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


def _run_builtin_filter(keyword: str, change_batch):
    plugin = _get_builtin_plugin(keyword)

    groups = {}
    if hasattr(plugin, 'get_groups'):
        groups = plugin.get_groups() or {}

    if not hasattr(plugin, 'filter_glyphs'):
        return {'results': [], 'groups': groups, 'status': 'no_filter_function'}

    _font = Font()
    if change_batch and not hasattr(plugin, 'needs_rebuild'):
        raise RuntimeError('Glyph filter plugin is missing needs_rebuild(change_batch, font_view)')
    if change_batch:
        _decision = plugin.needs_rebuild(change_batch, _font)
        if not isinstance(_decision, dict) or _decision.get('action') not in {'refresh', 'skip'}:
            raise RuntimeError('needs_rebuild must return {"action": "refresh"} or {"action": "skip"}')
        if _decision['action'] == 'skip':
            return {'results': [], 'groups': groups, 'status': 'not_needed', 'needsRebuild': False}
    _result = plugin.filter_glyphs(_font)
    if isinstance(_result, types.GeneratorType):
        _result = list(_result)

    return {'results': _result or [], 'groups': groups, 'status': 'ok', 'needsRebuild': True}


def _inspect_user_filter_source(code: str):
    try:
        tree = ast.parse(code, '<filter>', 'exec')
    except SyntaxError as error:
        return {'eventTypes': [], 'diagnostic': f'Syntax error: {error.msg} (line {error.lineno})'}

    event_types = None
    functions = {}
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id == 'EVENT_TYPES':
                    if not isinstance(node.value, (ast.List, ast.Tuple, ast.Set)) or not all(
                        isinstance(element, ast.Constant) and isinstance(element.value, str)
                        for element in node.value.elts
                    ):
                        return {'eventTypes': [], 'diagnostic': 'EVENT_TYPES must be a literal list, tuple, or set of registered event strings'}
                    event_types = [element.value for element in node.value.elts]
        elif isinstance(node, ast.FunctionDef):
            functions[node.name] = node

    if event_types is None:
        return {'eventTypes': [], 'diagnostic': 'Missing required literal EVENT_TYPES'}

    unknown_event_types = [event_type for event_type in event_types if event_type not in _CP_GLYPH_FILTER_EVENT_TYPES]
    if unknown_event_types:
        return {'eventTypes': [], 'diagnostic': f'Unknown EVENT_TYPES value: {unknown_event_types[0]}'}

    for name, parameter_name in (('needs_rebuild', 'change_batch'), ('filter_glyphs', 'font')):
        function = functions.get(name)
        if function is None:
            return {'eventTypes': event_types, 'diagnostic': f'Missing required {name}({parameter_name}) function'}
        arguments = function.args
        positional = arguments.posonlyargs + arguments.args
        if (
            len(positional) != 1
            or positional[0].arg != parameter_name
            or arguments.vararg is not None
            or arguments.kwonlyargs
            or arguments.kwarg is not None
            or arguments.defaults
            or arguments.kw_defaults
        ):
            return {'eventTypes': event_types, 'diagnostic': f'{name} must declare exactly one parameter: {parameter_name}'}

    return {'eventTypes': event_types, 'diagnostic': None}


def _run_user_filter(code: str, change_batch):
    _captured_output = StringIO()
    _old_stdout = sys.stdout
    sys.stdout = _captured_output

    _filter_result = {'results': [], 'groups': {}, 'status': 'ok'}
    try:
        _inspection = _inspect_user_filter_source(code)
        if _inspection['diagnostic']:
            raise RuntimeError(_inspection['diagnostic'])

        _compiled_code = compile(code, '<filter>', 'exec')
        _user_globals = {}
        exec(_compiled_code, _user_globals)

        _groups = _user_globals.get('GROUPS', {})
        _needs_rebuild = _user_globals['needs_rebuild']
        _filter_func = _user_globals.get('filter_glyphs')
        _should_rebuild = _needs_rebuild(change_batch)

        if not _should_rebuild:
            _filter_result = {
                'results': [],
                'groups': _groups or {},
                'status': 'not_needed',
                'needsRebuild': False
            }
        else:
            _font = Font()
            _results = _filter_func(_font)
            if isinstance(_results, types.GeneratorType):
                _results = list(_results)

            _filter_result = {
                'results': _results or [],
                'groups': _groups or {},
                'status': 'ok',
                'needsRebuild': True
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
                ? `_run_builtin_filter(${JSON.stringify(request.keyword)}, ${JSON.stringify(request.changeBatch || EMPTY_CHANGE_BATCH)})`
                : `_run_user_filter(${JSON.stringify(request.code)}, ${JSON.stringify(request.changeBatch || EMPTY_CHANGE_BATCH)})`;

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
            needsRebuild: result.needsRebuild,
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

async function inspectUserFilterSource(
    request: Extract<WorkerRequest, { type: 'inspectUserFilterSource' }>
) {
    await ensureWorkerRuntime();

    try {
        const resultProxy: any = await pyodide.runPythonAsync(
            `_inspect_user_filter_source(${JSON.stringify(request.code)})`
        );
        const result = resultProxy.toJs({ dict_converter: Object.fromEntries });
        resultProxy.destroy();
        (self as unknown as DedicatedWorkerGlobalScope).postMessage({
            id: request.id,
            ok: true,
            eventTypes: result.eventTypes || [],
            diagnostic: result.diagnostic || undefined
        });
    } catch (error: any) {
        (self as unknown as DedicatedWorkerGlobalScope).postMessage({
            id: request.id,
            ok: false,
            error: error?.message || String(error)
        });
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

    if (request.type === 'inspectUserFilterSource') {
        await inspectUserFilterSource(request);
        return;
    }

    await executeFilter(request);
};

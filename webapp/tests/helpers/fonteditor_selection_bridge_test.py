import importlib.util
import sys
import types
import unittest
from pathlib import Path


class JsProxy:
    pass


class JsNull:
    pass


class JsUndefined:
    pass


class FakeConstructor:
    def __init__(self, name):
        self.name = name


class FakeJsBase(JsProxy):
    constructor_name = 'Object'

    def __init__(self):
        self.constructor = FakeConstructor(self.constructor_name)


class FakeJsArray(list, JsProxy):
    @property
    def length(self):
        return len(self)

    def splice(self, index, delete_count, *items):
        if index < 0:
            index = max(0, len(self) + index)
        removed = self[index : index + delete_count]
        self[index : index + delete_count] = list(items)
        return FakeJsArray(removed)


class FakeAnchor(FakeJsBase):
    constructor_name = 'Anchor'

    def __init__(self, name):
        super().__init__()
        self.name = name


class FakeLayer(FakeJsBase):
    constructor_name = 'Layer'

    def __init__(self, allowed_items, initial_selection=None):
        super().__init__()
        self._allowed_items = list(allowed_items)
        self._selection = FakeJsArray(initial_selection or [])
        self.get_snapshot_calls = 0
        self.set_selection_calls = 0

    def _getSelectionSnapshotForPython(self):
        self.get_snapshot_calls += 1
        return FakeJsArray(self._selection)

    def _setSelectionFromPython(self, value):
        self.set_selection_calls += 1
        self.selection = value

    @property
    def selection(self):
        return FakeJsArray(self._selection)

    @selection.setter
    def selection(self, value):
        if isinstance(value, FakeJsArray):
            items = list(value)
        elif isinstance(value, list):
            items = list(value)
        else:
            items = [value]

        for item in items:
            if item not in self._allowed_items:
                raise ValueError('Layer.selection can only contain objects from this layer')

        self._selection = FakeJsArray(items)


def _fake_has_own_property(obj, key):
    if isinstance(obj, dict):
        return str(key) in obj
    return hasattr(obj, str(key))


def _fake_to_string(value):
    if isinstance(value, FakeJsArray):
        return '[object Array]'
    return '[object Object]'


def _fake_keys(obj):
    if isinstance(obj, dict):
        return FakeJsArray(list(obj.keys()))
    return FakeJsArray(
        [
            key
            for key in dir(obj)
            if not key.startswith('_') and not callable(getattr(obj, key))
        ]
    )


def _fake_reflect_get(target, key):
    if isinstance(target, (list, FakeJsArray)):
        return target[key]
    if isinstance(target, dict):
        return target[str(key)]
    return getattr(target, str(key))


def _fake_reflect_set(target, key, value):
    if isinstance(target, (list, FakeJsArray)):
        if key == 'length':
            del target[value:]
            return True
        index = int(key)
        while len(target) <= index:
            target.append(None)
        target[index] = value
        return True
    if isinstance(target, dict):
        target[str(key)] = value
        return True
    setattr(target, str(key), value)
    return True


def _install_stub_modules():
    pyodide_module = types.ModuleType('pyodide')
    ffi_module = types.ModuleType('pyodide.ffi')
    ffi_module.JsProxy = JsProxy
    ffi_module.JsNull = JsNull
    ffi_module.JsUndefined = JsUndefined
    ffi_module.to_js = lambda value, dict_converter=None: FakeJsArray(value) if isinstance(value, (list, tuple)) else value
    pyodide_module.ffi = ffi_module
    sys.modules['pyodide'] = pyodide_module
    sys.modules['pyodide.ffi'] = ffi_module

    js_module = types.ModuleType('js')
    js_module.Array = types.SimpleNamespace(isArray=lambda value: isinstance(value, FakeJsArray))
    js_module.Object = types.SimpleNamespace(
        prototype=types.SimpleNamespace(
            hasOwnProperty=types.SimpleNamespace(call=_fake_has_own_property),
            toString=types.SimpleNamespace(call=_fake_to_string),
        ),
        fromEntries=lambda entries: dict(entries),
        keys=_fake_keys,
    )
    js_module.Reflect = types.SimpleNamespace(get=_fake_reflect_get, set=_fake_reflect_set)
    sys.modules['js'] = js_module


def _load_fonteditor_module():
    _install_stub_modules()

    module_path = Path(__file__).resolve().parents[2] / 'py' / 'fonteditor.py'
    spec = importlib.util.spec_from_file_location('fonteditor_under_test', module_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FontEditorSelectionBridgeTest(unittest.TestCase):
    def setUp(self):
        self.fonteditor = _load_fonteditor_module()
        self.anchor_a = FakeAnchor('a')
        self.anchor_b = FakeAnchor('b')
        self.foreign_anchor = FakeAnchor('foreign')
        self.layer = FakeLayer([self.anchor_a, self.anchor_b], [self.anchor_a])
        self.layer_proxy = self.fonteditor.ModelObjectProxy(self.layer)

    def test_layer_selection_proxy_reads_and_mutates_live_selection(self):
        selection = self.layer_proxy.selection

        self.assertEqual(len(selection), 1)
        self.assertGreater(self.layer.get_snapshot_calls, 0)
        self.assertEqual(selection[0]._js_obj, self.anchor_a)
        self.assertEqual([item._js_obj for item in list(selection)], [self.anchor_a])
        self.assertIn('<Anchor>', repr(selection))

        selection.append(self.fonteditor.ModelObjectProxy(self.anchor_b))
        self.assertGreater(self.layer.set_selection_calls, 0)
        self.assertEqual(len(selection), 2)
        self.assertEqual([item._js_obj for item in selection], [self.anchor_a, self.anchor_b])

        del selection[0]
        self.assertEqual([item._js_obj for item in selection], [self.anchor_b])

        selection.insert(0, self.fonteditor.ModelObjectProxy(self.anchor_a))
        self.assertEqual([item._js_obj for item in selection], [self.anchor_a, self.anchor_b])

    def test_layer_selection_assignment_supports_single_objects_and_validation(self):
        self.layer_proxy.selection = self.fonteditor.ModelObjectProxy(self.anchor_b)
        self.assertEqual(
            [item._js_obj for item in self.layer_proxy.selection],
            [self.anchor_b],
        )

        with self.assertRaises(ValueError):
            self.layer_proxy.selection.append(
                self.fonteditor.ModelObjectProxy(self.foreign_anchor)
            )


if __name__ == '__main__':
    unittest.main()
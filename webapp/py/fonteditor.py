# Copyright (C) 2025 Yanone
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.

"""
FontEditor Python Module
Core functionality for font editing operations
"""

from collections.abc import MutableMapping, MutableSequence
from keyword import iskeyword
import json

import js
import pyodide.ffi


_JS_UNDEFINED_TYPE = getattr(pyodide.ffi, 'JsUndefined', None)


_DICT_LIKE_FIELDS_BY_CLASS = {
    'Anchor': {'format_specific'},
    'Axis': {'name', 'format_specific'},
    'Component': {'location', 'format_specific', 'transform'},
    # Features.features is an array and is wrapped via _is_js_array -> LiveListProxy.
    'Features': {'classes', 'prefixes'},
    'Font': {
        'custom_ot_values',
        'features',
        'first_kern_groups',
        'format_specific',
        'names',
        'second_kern_groups',
        'variation_sequences',
    },
    'Glyph': set(),
    'Guide': {'color', 'format_specific', 'pos'},
    'Instance': {'custom_names', 'format_specific', 'location', 'name'},
    'Layer': {
        'color',
        'format_specific',
        'location',
        'smart_component_location',
    },
    'Master': {
        'custom_ot_values',
        'format_specific',
        'kerning',
        'location',
        'metrics',
        'name',
    },
    'Node': {'format_specific'},
    'Path': {'format_specific'},
    'Shape': set(),
}

# Object-valued fields that should wrap as live mappings even when Pyodide
# reports a Proxy constructor (for example Glyph.category's Custom object).
# Keep these out of _DICT_LIKE_FIELDS_BY_CLASS so string assignment still works
# for union types such as Glyph.category.
_WRAPPED_OBJECT_FIELDS_BY_CLASS = {
    'Glyph': {'category', 'glyphData'},
}
_SNAPSHOT_OBJECT_ATTRS = frozenset({'category', 'glyphData'})


def _is_js_null_or_undefined(value):
    if type(value) is pyodide.ffi.JsNull:
        return True
    if _JS_UNDEFINED_TYPE is not None and type(value) is _JS_UNDEFINED_TYPE:
        return True
    return False


def _get_constructor_name(value):
    try:
        return str(value.constructor.name)
    except Exception:
        return ''


def _infer_model_class_name(value):
    name = _get_constructor_name(value)
    if name in _DICT_LIKE_FIELDS_BY_CLASS:
        return name
    try:
        find_glyph = getattr(value, 'findGlyph', None)
        if _is_js_function(find_glyph) or callable(find_glyph):
            return 'Font'
        add_layer = getattr(value, 'addLayer', None)
        if _is_js_function(add_layer) or callable(add_layer):
            return 'Glyph'
    except Exception:
        pass
    return name


def _as_model_proxy(value):
    if value is None or _is_js_null_or_undefined(value):
        return None
    if isinstance(value, ModelObjectProxy):
        return value
    return ModelObjectProxy(_unwrap_py_value(value))


def _get_object_tag(value):
    try:
        return str(js.Object.prototype.toString.call(value))
    except Exception:
        return ''


def _is_js_function(value):
    if isinstance(
        value, (ModelObjectProxy, LiveDictProxy, LiveMapProxy, LiveListProxy)
    ):
        return False
    if isinstance(value, pyodide.ffi.JsProxy):
        try:
            return str(getattr(value, 'typeof', '')) == 'function'
        except Exception:
            return _get_object_tag(value) in (
                '[object Function]',
                '[object AsyncFunction]',
            )
    return callable(value)


def _is_plain_python_json_value(value):
    if value is None or isinstance(value, (str, int, float, bool)):
        return True
    if isinstance(value, dict):
        return all(
            isinstance(key, str) and _is_plain_python_json_value(item)
            for key, item in value.items()
        )
    if isinstance(value, (list, tuple)):
        return all(_is_plain_python_json_value(item) for item in value)
    return False


def _js_proxy_to_py_dict(value):
    candidates = []

    to_py = getattr(value, 'to_py', None)
    if to_py is not None:
        try:
            converted = to_py()
            if isinstance(converted, dict) and _is_plain_python_json_value(
                converted
            ):
                candidates.append(converted)
        except Exception:
            pass

    try:
        json_text = js.JSON.stringify(value)
        if json_text is not None and not _is_js_null_or_undefined(json_text):
            text = str(json_text)
            if text not in ('', 'null', 'undefined'):
                converted = json.loads(text)
                if isinstance(converted, dict):
                    candidates.append(converted)
    except Exception:
        pass

    try:
        keys = js.Object.keys(value).to_py()
        copied = {}
        for key in keys:
            item = _js_get(value, key)
            if _is_js_null_or_undefined(item):
                copied[key] = None
                continue
            nested = (
                _js_proxy_to_py_dict(item)
                if isinstance(item, pyodide.ffi.JsProxy)
                and not _is_js_array(item)
                and not _is_js_function(item)
                else None
            )
            if nested is not None:
                copied[key] = nested
            elif _is_js_array(item) and hasattr(item, 'to_py'):
                copied[key] = item.to_py()
            else:
                copied[key] = item
        candidates.append(copied)
    except Exception:
        pass

    nonempty = [candidate for candidate in candidates if candidate]
    if nonempty:
        return max(nonempty, key=len)
    if candidates:
        return candidates[0]
    return None


def _is_js_array(value):
    try:
        if bool(js.Array.isArray(value)):
            return True
    except Exception:
        pass

    if _get_object_tag(value) == '[object Array]':
        return True

    return _get_constructor_name(value) == 'Array'


def _is_plain_js_object(value):
    if not isinstance(value, pyodide.ffi.JsProxy):
        return False
    if _is_js_array(value):
        return False
    if _is_js_map(value):
        return False

    constructor_name = _get_constructor_name(value)
    if constructor_name == 'Object':
        return True

    if constructor_name not in ('', 'Proxy'):
        return False

    return _get_object_tag(value) == '[object Object]'


def _is_js_map(value):
    if not isinstance(value, pyodide.ffi.JsProxy):
        return False
    if _get_constructor_name(value) == 'Map':
        return True
    return _get_object_tag(value) == '[object Map]'


def _unwrap_py_value(value):
    if isinstance(value, ModelObjectProxy):
        return value._js_obj
    if isinstance(value, LiveDictProxy):
        return value._js_obj
    if isinstance(value, LiveMapProxy):
        return value._js_map
    if isinstance(value, LiveListProxy):
        return value._js_array
    if isinstance(value, (dict, list, tuple)):
        return pyodide.ffi.to_js(
            value,
            dict_converter=js.Object.fromEntries,
        )
    return value


def _materialize_py_value(value):
    if isinstance(value, LiveDictProxy):
        return value.to_py()
    if isinstance(value, LiveMapProxy):
        return value.to_py()
    if isinstance(value, LiveListProxy):
        return value.to_py()
    if isinstance(value, ModelObjectProxy):
        return value._js_obj
    return value


def _js_get(target, key):
    return js.Reflect.get(target, key)


def _js_set(target, key, value):
    js.Reflect.set(target, key, value)


def _is_mapping_assignment_value(value):
    if isinstance(value, (LiveDictProxy, LiveMapProxy, ModelObjectProxy)):
        return True
    if isinstance(value, MutableMapping):
        return True
    if isinstance(value, pyodide.ffi.JsProxy) and (
        _is_plain_js_object(value) or _is_js_map(value)
    ):
        return True
    return False


def _wrap_js_value(value, owner_class_name=None, attr_name=None):
    if _is_js_null_or_undefined(value):
        return None

    if isinstance(value, (ModelObjectProxy, LiveDictProxy, LiveMapProxy, LiveListProxy)):
        return value

    if _is_js_array(value):
        return LiveListProxy(value)

    if not isinstance(value, pyodide.ffi.JsProxy):
        return value

    constructor_name = _infer_model_class_name(value)
    dict_fields = _DICT_LIKE_FIELDS_BY_CLASS.get(constructor_name, set())
    wrap_object_fields = _WRAPPED_OBJECT_FIELDS_BY_CLASS.get(
        owner_class_name or constructor_name, set()
    )
    force_dict_wrap = attr_name in dict_fields
    snapshot_object = (
        attr_name in _SNAPSHOT_OBJECT_ATTRS or attr_name in wrap_object_fields
    )

    if snapshot_object:
        converted = _js_proxy_to_py_dict(value)
        if converted is not None:
            return converted

    if force_dict_wrap and _is_js_map(value):
        return LiveMapProxy(value)

    if force_dict_wrap and _is_plain_js_object(value):
        return LiveDictProxy(value)

    if force_dict_wrap:
        return LiveDictProxy(value)

    if _is_js_map(value):
        return LiveMapProxy(value)

    if _is_plain_js_object(value):
        return LiveDictProxy(value)

    if constructor_name in _DICT_LIKE_FIELDS_BY_CLASS:
        return ModelObjectProxy(value)

    return value


def _unwrap_layer_selection_value(value):
    if value is None:
        items = []
    elif isinstance(value, LayerSelectionProxy):
        items = [item for item in value]
    elif isinstance(value, LiveListProxy):
        items = [value[i] for i in range(len(value))]
    elif isinstance(value, pyodide.ffi.JsProxy) and _is_js_array(value):
        return value
    elif isinstance(value, (list, tuple)):
        items = list(value)
    else:
        items = [value]

    return pyodide.ffi.to_js(
        [_unwrap_py_value(item) for item in items],
        dict_converter=js.Object.fromEntries,
    )


class LiveDictProxy(MutableMapping):
    def __init__(self, js_obj):
        object.__setattr__(self, '_js_obj', js_obj)

    def _is_attr_key(self, name):
        return isinstance(name, str) and name.isidentifier() and not iskeyword(name)

    def __getitem__(self, key):
        key_string = str(key)
        if not bool(js.Object.prototype.hasOwnProperty.call(self._js_obj, key_string)):
            raise KeyError(key)
        return _wrap_js_value(_js_get(self._js_obj, key_string))

    def __setitem__(self, key, value):
        key_string = str(key)

        key_exists = bool(
            js.Object.prototype.hasOwnProperty.call(self._js_obj, key_string)
        )
        if key_exists:
            existing = _js_get(self._js_obj, key_string)
            if _is_plain_js_object(existing) and not _is_mapping_assignment_value(value):
                value_type = type(value).__name__
                raise TypeError(
                    f"Cannot overwrite dictionary entry '{key_string}' with non-dictionary value ({value_type}). "
                    f"Use '{key_string}[\"dflt\"] = ...' for language values, or assign a full mapping like "
                    f"{key_string} = {{\"dflt\": ...}}."
                )

        _js_set(self._js_obj, key_string, _unwrap_py_value(value))

    def __delitem__(self, key):
        key_string = str(key)
        if not bool(js.Object.prototype.hasOwnProperty.call(self._js_obj, key_string)):
            raise KeyError(key)
        js.Reflect.deleteProperty(self._js_obj, key_string)

    def __iter__(self):
        keys = js.Object.keys(self._js_obj).to_py()
        return iter(keys)

    def __len__(self):
        return int(js.Object.keys(self._js_obj).length)

    def to_py(self):
        return {
            key: _materialize_py_value(self[key])
            for key in js.Object.keys(self._js_obj).to_py()
        }

    def as_dict(self):
        return self.to_py()

    def __repr__(self):
        return repr(self.to_py())

    def __getattr__(self, name):
        if self._is_attr_key(name):
            try:
                return self[name]
            except KeyError as error:
                raise AttributeError(name) from error
        raise AttributeError(name)

    def __setattr__(self, name, value):
        if name.startswith('_'):
            object.__setattr__(self, name, value)
            return
        if self._is_attr_key(name):
            self[name] = value
            return
        object.__setattr__(self, name, value)

    def __delattr__(self, name):
        if self._is_attr_key(name):
            try:
                del self[name]
                return
            except KeyError as error:
                raise AttributeError(name) from error
        object.__delattr__(self, name)


class LiveMapProxy(MutableMapping):
    def __init__(self, js_map):
        object.__setattr__(self, '_js_map', js_map)

    def _is_attr_key(self, name):
        return isinstance(name, str) and name.isidentifier() and not iskeyword(name)

    def __getitem__(self, key):
        if not bool(self._js_map.has(key)):
            raise KeyError(key)
        return _wrap_js_value(self._js_map.get(key))

    def __setitem__(self, key, value):
        key_exists = bool(self._js_map.has(key))
        if key_exists:
            existing = self._js_map.get(key)
            if (_is_plain_js_object(existing) or _is_js_map(existing)) and not _is_mapping_assignment_value(value):
                value_type = type(value).__name__
                raise TypeError(
                    f"Cannot overwrite dictionary entry '{key}' with non-dictionary value ({value_type}). "
                    f"Use '{key}[\"dflt\"] = ...' for language values, or assign a full mapping like "
                    f"{key} = {{\"dflt\": ...}}."
                )

        self._js_map.set(key, _unwrap_py_value(value))

    def __delitem__(self, key):
        if not bool(self._js_map.delete(key)):
            raise KeyError(key)

    def __iter__(self):
        keys = getattr(js.Array, 'from')(self._js_map.keys()).to_py()
        return iter(keys)

    def __len__(self):
        return int(self._js_map.size)

    def to_py(self):
        return {key: _materialize_py_value(self[key]) for key in self}

    def as_dict(self):
        return self.to_py()

    def __repr__(self):
        return repr(self.to_py())

    def __getattr__(self, name):
        if self._is_attr_key(name):
            try:
                return self[name]
            except KeyError as error:
                raise AttributeError(name) from error
        raise AttributeError(name)

    def __setattr__(self, name, value):
        if name.startswith('_'):
            object.__setattr__(self, name, value)
            return
        if self._is_attr_key(name):
            self[name] = value
            return
        object.__setattr__(self, name, value)

    def __delattr__(self, name):
        if self._is_attr_key(name):
            try:
                del self[name]
                return
            except KeyError as error:
                raise AttributeError(name) from error
        object.__delattr__(self, name)


class LiveListProxy(MutableSequence):
    def __init__(self, js_array):
        self._js_array = js_array

    def __len__(self):
        return int(self._js_array.length)

    def __getitem__(self, index):
        if isinstance(index, slice):
            start, stop, step = index.indices(len(self))
            return [self[i] for i in range(start, stop, step)]
        return _wrap_js_value(_js_get(self._js_array, index))

    def __setitem__(self, index, value):
        if isinstance(index, slice):
            raise TypeError('Slice assignment is not supported')
        _js_set(self._js_array, index, _unwrap_py_value(value))

    def __delitem__(self, index):
        self._js_array.splice(index, 1)

    def insert(self, index, value):
        self._js_array.splice(index, 0, _unwrap_py_value(value))

    def __iter__(self):
        for i in range(len(self)):
            yield self[i]

    def to_py(self):
        return [_materialize_py_value(item) for item in self]

    def __repr__(self):
        return repr(self.to_py())

    def __str__(self):
        return self.__repr__()


class LayerSelectionProxy:
    def __init__(self, layer_js_obj):
        self._layer_js_obj = layer_js_obj

    def _get_selection(self):
        getter = getattr(self._layer_js_obj, '_getSelectionSnapshotForPython', None)
        if getter is not None:
            return getter()
        return getattr(self._layer_js_obj, 'selection')

    def _replace(self, items):
        setter = getattr(self._layer_js_obj, '_setSelectionFromPython', None)
        unwrapped_items = _unwrap_layer_selection_value(items)
        if setter is not None:
            setter(unwrapped_items)
            return
        setattr(self._layer_js_obj, 'selection', unwrapped_items)

    def __len__(self):
        return int(self._get_selection().length)

    def __getitem__(self, index):
        selection = self._get_selection()
        if isinstance(index, slice):
            start, stop, step = index.indices(len(self))
            return [self[i] for i in range(start, stop, step)]
        return _wrap_js_value(_js_get(selection, index))

    def __setitem__(self, index, value):
        current = self[:]
        if isinstance(index, slice):
            current[index] = list(value)
        else:
            current[index] = value
        self._replace(current)

    def __iter__(self):
        for i in range(len(self)):
            yield self[i]

    def __delitem__(self, index):
        current = self[:]
        del current[index]
        self._replace(current)

    def insert(self, index, value):
        current = self[:]
        current.insert(index, value)
        self._replace(current)

    def append(self, value):
        self.insert(len(self), value)

    def extend(self, values):
        current = self[:]
        current.extend(list(values))
        self._replace(current)

    def clear(self):
        self._replace([])

    def pop(self, index=-1):
        current = self[:]
        value = current.pop(index)
        self._replace(current)
        return value

    def remove(self, value):
        current = self[:]
        for index, item in enumerate(current):
            same_object = (
                item is value
                or (
                    isinstance(item, ModelObjectProxy)
                    and isinstance(value, ModelObjectProxy)
                    and item._js_obj is value._js_obj
                )
            )
            if same_object:
                del current[index]
                self._replace(current)
                return
        raise ValueError('LayerSelectionProxy.remove(x): x not in selection')

    def to_py(self):
        return list(self)

    def __repr__(self):
        return repr(list(self))

    def __str__(self):
        return self.__repr__()


class ModelObjectProxy:
    def __init__(self, js_obj):
        object.__setattr__(self, '_js_obj', js_obj)

    def __getattr__(self, name):
        owner_class_name = _infer_model_class_name(self._js_obj)
        if owner_class_name == 'Layer' and name == 'selection':
            return LayerSelectionProxy(self._js_obj)

        raw = getattr(self._js_obj, name)
        if _is_js_function(raw):
            def method(*args, **kwargs):
                if kwargs:
                    raise TypeError('Keyword arguments are not supported')
                unwrapped = [_unwrap_py_value(arg) for arg in args]
                result = raw(*unwrapped)
                return _wrap_js_value(result)

            return method
        return _wrap_js_value(raw, owner_class_name, name)

    def __setattr__(self, name, value):
        owner_class_name = _infer_model_class_name(self._js_obj)
        if owner_class_name == 'Layer' and name == 'selection':
            setattr(self._js_obj, name, _unwrap_layer_selection_value(value))
            return

        dict_fields = _DICT_LIKE_FIELDS_BY_CLASS.get(owner_class_name, set())
        if name in dict_fields and not _is_mapping_assignment_value(value):
            value_type = type(value).__name__
            raise TypeError(
                f"Cannot assign non-dictionary value ({value_type}) to dict-like field "
                f"'{owner_class_name}.{name}'. Use key assignment (e.g. {name}[\"dflt\"] = ...), "
                f"or assign a full mapping."
            )
        setattr(self._js_obj, name, _unwrap_py_value(value))

    def __getitem__(self, key):
        owner_class_name = _infer_model_class_name(self._js_obj)
        if owner_class_name == 'Layer' and key == 'selection':
            return LayerSelectionProxy(self._js_obj)

        attr_name = key if isinstance(key, str) else None
        return _wrap_js_value(_js_get(self._js_obj, key), owner_class_name, attr_name)

    def __setitem__(self, key, value):
        if isinstance(key, str):
            self.__setattr__(key, value)
            return
        _js_set(self._js_obj, key, _unwrap_py_value(value))

    def __str__(self):
        return self.__repr__()

    def __repr__(self):
        try:
            text = str(self._js_obj.toString())
            if text and text != '[object Object]':
                return text
        except Exception:
            pass
        class_name = _get_constructor_name(self._js_obj)
        return f'<{class_name}>'


def _cp_get_host_object():
    if hasattr(js, 'window') and type(js.window) is not pyodide.ffi.JsNull:
        return js.window
    return js.self


def _cp_wrap_js_value(value):
    return _wrap_js_value(value)


def _cp_get_active_outline_editor():
    host = _cp_get_host_object()
    glyph_canvas = getattr(host, 'glyphCanvas', None)
    if _is_js_null_or_undefined(glyph_canvas):
        raise RuntimeError('Glyph canvas is not available')

    outline_editor = getattr(glyph_canvas, 'outlineEditor', None)
    if _is_js_null_or_undefined(outline_editor) or not bool(outline_editor.active):
        raise RuntimeError('No glyph is currently active in editing mode')

    return outline_editor


def _cp_get_active_stack_entry():
    outline_editor = _cp_get_active_outline_editor()
    parsed_stack = outline_editor.parseGlyphStack()
    if int(parsed_stack.length) == 0:
        raise RuntimeError('Active glyph stack is empty')

    return parsed_stack[int(parsed_stack.length) - 1]


def _cp_get_active_glyph_and_layer_ids():
    stack_entry = _cp_get_active_stack_entry()

    glyph_name = str(stack_entry.glyphName)
    if not glyph_name or glyph_name == 'undefined':
        raise RuntimeError('Active glyph is not available')

    layer_id = str(stack_entry.layerId)
    if not layer_id or layer_id == 'undefined':
        raise RuntimeError('Active layer is not available')

    return glyph_name, layer_id


def Font():
    """
    Get the currently active font.

    Returns:
        Font: The currently active context Font object

    Raises:
        RuntimeError: If no font is currently open

    Example:
        >>> font = Font()
        >>> print(font.info.familyName)
    """
    host = _cp_get_host_object()
    if type(host.currentFontModel) is pyodide.ffi.JsNull:
        raise RuntimeError("No font is currently open")
    return _as_model_proxy(host.currentFontModel)


def Glyph():
    """
    Get the currently active glyph in outline editing mode.

    Returns:
        Glyph: The live Glyph object from the current font model

    Raises:
        RuntimeError: If outline editing is inactive or the glyph cannot be resolved
    """
    glyph_name, _layer_id = _cp_get_active_glyph_and_layer_ids()
    glyph = Font().findGlyph(glyph_name)
    if glyph is None:
        raise RuntimeError(f'Active glyph "{glyph_name}" is not available')
    return _as_model_proxy(glyph)


def Layer():
    """
    Get the currently active layer in outline editing mode.

    Returns:
        Layer: The live Layer object from the current font model

    Raises:
        RuntimeError: If outline editing is inactive or the layer cannot be resolved
    """
    glyph_name, layer_id = _cp_get_active_glyph_and_layer_ids()
    glyph = Font().findGlyph(glyph_name)
    if glyph is None:
        raise RuntimeError(f'Active glyph "{glyph_name}" is not available')

    for layer in glyph.layers:
        if layer.id == layer_id:
            return layer

    raise RuntimeError(
        f'Active layer "{layer_id}" on glyph "{glyph_name}" is not available'
    )


def Master():
    """
    Get the currently selected master.

    In outline editing mode, the master is resolved from the active layer and
    returned only when that layer reflects a stored master. In text mode, the
    selected master is resolved from the text-run editor's selected master ID.

    Returns:
        Master | None: The selected live Master object, or None when the
        current designspace location does not correspond to a stored master.

    Raises:
        RuntimeError: If no font is currently open, or if outline editing is
        active but the active glyph/layer cannot be resolved.
    """
    host = _cp_get_host_object()
    glyph_canvas = getattr(host, 'glyphCanvas', None)
    outline_editor = getattr(glyph_canvas, 'outlineEditor', None)

    if not _is_js_null_or_undefined(outline_editor) and bool(outline_editor.active):
        layer = Layer()
        return layer.getMaster()

    text_run_editor = getattr(glyph_canvas, 'textRunEditor', None)
    if _is_js_null_or_undefined(text_run_editor):
        return None

    selected_master_id = getattr(text_run_editor, 'selectedMasterId', None)
    if _is_js_null_or_undefined(selected_master_id) or selected_master_id is None:
        return None

    selected_master_id = str(selected_master_id)
    if not selected_master_id or selected_master_id == 'undefined':
        return None

    return Font().findMaster(selected_master_id)


def Context():
    host = _cp_get_host_object()
    if not hasattr(host, 'sharedPluginContext'):
        return {}
    if _is_js_null_or_undefined(host.sharedPluginContext):
        return {}
    return _wrap_js_value(host.sharedPluginContext)


def SetContextPatch(patch):
    host = _cp_get_host_object()
    if hasattr(host, 'setPendingContextPatch'):
        host.setPendingContextPatch(_unwrap_py_value(patch))


def Notification(title, body=''):
    """Show an OS system notification.

    The first call may ask the browser for notification permission.
    Use this for a requested action finishing, not as automatic
    confirmation of routine edits.
    """
    host = _cp_get_host_object()
    if host is None or not hasattr(host, 'showSystemNotification'):
        raise RuntimeError('System notifications are not available')

    title_text = '' if title is None else str(title)
    body_text = '' if body is None else str(body)
    host.showSystemNotification(title_text, body_text)


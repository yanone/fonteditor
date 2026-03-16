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
}


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


def _is_js_array(value):
    return isinstance(value, pyodide.ffi.JsProxy) and bool(js.Array.isArray(value))


def _is_plain_js_object(value):
    if not isinstance(value, pyodide.ffi.JsProxy):
        return False
    if _is_js_array(value):
        return False
    return _get_constructor_name(value) == 'Object'


def _unwrap_py_value(value):
    if isinstance(value, ModelObjectProxy):
        return value._js_obj
    if isinstance(value, LiveDictProxy):
        return value._js_obj
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
    if isinstance(value, (LiveDictProxy, ModelObjectProxy)):
        return True
    if isinstance(value, MutableMapping):
        return True
    if isinstance(value, pyodide.ffi.JsProxy) and _is_plain_js_object(value):
        return True
    return False


def _wrap_js_value(value, owner_class_name=None, attr_name=None):
    if _is_js_null_or_undefined(value):
        return None

    if isinstance(value, (ModelObjectProxy, LiveDictProxy, LiveListProxy)):
        return value

    if not isinstance(value, pyodide.ffi.JsProxy):
        return value

    if _is_js_array(value):
        return LiveListProxy(value)

    constructor_name = _get_constructor_name(value)
    dict_fields = _DICT_LIKE_FIELDS_BY_CLASS.get(owner_class_name, set())
    force_dict_wrap = attr_name in dict_fields

    if force_dict_wrap and _is_plain_js_object(value):
        return LiveDictProxy(value)

    if _is_plain_js_object(value):
        return LiveDictProxy(value)

    if constructor_name in _DICT_LIKE_FIELDS_BY_CLASS:
        return ModelObjectProxy(value)

    return value


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


class ModelObjectProxy:
    def __init__(self, js_obj):
        object.__setattr__(self, '_js_obj', js_obj)

    def __getattr__(self, name):
        raw = getattr(self._js_obj, name)
        if callable(raw):
            def method(*args, **kwargs):
                if kwargs:
                    raise TypeError('Keyword arguments are not supported')
                unwrapped = [_unwrap_py_value(arg) for arg in args]
                result = raw(*unwrapped)
                return _wrap_js_value(result)

            return method

        owner_class_name = _get_constructor_name(self._js_obj)
        return _wrap_js_value(raw, owner_class_name, name)

    def __setattr__(self, name, value):
        owner_class_name = _get_constructor_name(self._js_obj)
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
        return _wrap_js_value(_js_get(self._js_obj, key))

    def __setitem__(self, key, value):
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
    return _wrap_js_value(host.currentFontModel)


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
    return glyph


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


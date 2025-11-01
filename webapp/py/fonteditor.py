"""
FontEditor Python Module
Core functionality for font editing operations
"""

from context import load
import uuid


__open_fonts = {}  # Dictionary of {font_id: font_object}
__current_font_id = None  # ID of the currently active font


def OpenFont(path):
    """
    Open a font file and return a Font object.

    Args:
        path (str): Path to the font file (.glyphs, .ufo, .designspace, etc.)

    Returns:
        Font: A context Font object

    Example:
        >>> font = OpenFont("/project/MyFont.glyphs")
        >>> print(font.info.familyName)
    """
    global __current_font_id

    __font_to_load = load(path)

    # Ensure the filename is set (should be done by loader, but make sure)
    if not hasattr(__font_to_load, "filename") or __font_to_load.filename is None:
        __font_to_load.filename = path

    # Generate a unique ID for this font
    font_id = str(uuid.uuid4())

    # Store the font with its ID
    __open_fonts[font_id] = __font_to_load

    # Set as current font
    __current_font_id = font_id

    return __font_to_load


def CurrentFont():
    """
    Get the currently active font.

    Returns:
        Font: The currently active context Font object, or None if no font is open

    Example:
        >>> font = CurrentFont()
        >>> print(font.info.familyName)
    """
    if __current_font_id and __current_font_id in __open_fonts:
        return __open_fonts[__current_font_id]
    return None


def SetCurrentFont(font_id):
    """
    Set the current font by ID.

    Args:
        font_id (str): The ID of the font to set as current

    Returns:
        bool: True if successful, False if font ID not found
    """
    global __current_font_id

    if font_id in __open_fonts:
        __current_font_id = font_id
        return True
    return False


def SaveFont(path=None):
    """
    Save the current font to disk.

    Args:
        path (str, optional): Path to save the font. If not provided,
                             uses the font's stored filename.

    Returns:
        bool: True if successful, False if no font is open

    Example:
        >>> SaveFont()  # Saves to original location
        >>> SaveFont("/path/to/newfont.glyphs")  # Save As
    """
    current_font = CurrentFont()
    if current_font is None:
        return False

    try:
        current_font.save(path)
        return True
    except Exception as e:
        print(f"Error saving font: {e}")
        return False


def GetOpenFonts():
    """
    Get a list of all open fonts with their IDs and display names.

    Returns:
        list: List of dicts with 'id', 'name', and 'path' keys

    Example:
        >>> fonts = GetOpenFonts()
        >>> for font_info in fonts:
        ...     print(font_info['id'], font_info['name'])
    """
    result = []
    for font_id, font in __open_fonts.items():
        # Try to get a display name for the font
        name = "Untitled Font"

        # Try font.names.familyName['dflt'] first (context)
        if (
            hasattr(font, "names")
            and hasattr(font.names, "familyName")
            and isinstance(font.names.familyName, dict)
            and "dflt" in font.names.familyName
        ):
            name = font.names.familyName["dflt"]
        # Fallback to font.info.familyName
        elif (
            hasattr(font, "info")
            and hasattr(font.info, "familyName")
            and font.info.familyName
        ):
            name = font.info.familyName
        # Fallback to filename
        elif hasattr(font, "filename") and font.filename:
            name = font.filename.split("/")[-1]

        # Try to get the path
        path = getattr(font, "filename", "") or ""

        result.append(
            {
                "id": font_id,
                "name": name,
                "path": path,
                "is_current": font_id == __current_font_id,
            }
        )

    return result

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
Unencoded Glyphs Filter - shows glyphs without a Unicode codepoint.
"""


class UnencodedGlyphsFilter:
    """Filter that returns glyphs without any Unicode codepoint."""
    
    path = "basic/glyph_categories"
    keyword = "com.context.unencoded"
    display_name = "Unencoded Glyphs"
    event_types = {"glyph.created", "glyph.deleted", "glyph.unicode.changed"}
    
    def __init__(self):
        pass
    
    def visible(self):
        return True

    def get_groups(self):
        return {}
    
    def filter_glyphs(self, font):
        """Return glyphs that have no Unicode codepoint defined."""
        results = []
        
        glyphs = getattr(font, 'glyphs', None)
        if glyphs is None:
            return results
        
        for glyph in glyphs:
            glyph_name = getattr(glyph, 'name', None)
            if not glyph_name:
                continue
            
            # Check for unicode codepoints
            codepoints = getattr(glyph, 'codepoints', None)
            if not codepoints or len(codepoints) == 0:
                results.append({"glyph_name": glyph_name})
        
        return results

    def apply_changes(self, change_batch, current_results, font):
        """Update unencoded membership from changed glyph identities only."""
        add = []
        remove = []
        for change in change_batch["changes"]:
            metadata = change["metadata"]
            glyph_name = metadata.get("glyphName")
            if change["type"] == "glyph.deleted":
                remove.append(glyph_name)
                continue
            glyph = font.findGlyph(glyph_name)
            if glyph is None or glyph.codepoints:
                remove.append(glyph_name)
            else:
                add.append(glyph_name)
        return {"add": add, "remove": remove}

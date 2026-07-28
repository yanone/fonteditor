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
All Glyphs Filter - shows all glyphs in the font.
"""


class AllGlyphsFilter:
    """Filter that returns all glyphs in the font."""
    
    path = "basic"
    keyword = "com.context.allglyphs"
    display_name = "All Glyphs"
    event_types = set()
    
    def __init__(self):
        pass
    
    def visible(self):
        return True

    def classify_glyph(self, glyph):
        """The host renders this special filter as the unfiltered overview."""
        return True

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
Incompatible Outlines Filter - shows glyphs whose main layers
have incompatible outline structure.
"""

from base_glyph_filter_plugin import BaseGlyphFilterPlugin


class IncompatibleOutlinesFilter(BaseGlyphFilterPlugin):
    """Filter that returns glyphs with outline incompatibilities."""

    path = "basic/debugging"
    keyword = "com.context.incompatible_outlines"
    display_name = "Incompatible Outlines"
    event_types = {"glyph.compatibility.changed"}

    def __init__(self):
        pass

    def visible(self):
        return True

    def is_candidate(self, glyph):
        return not glyph.isCompatible

    def classify_glyph(self, glyph):
        """Classify one glyph whose outline compatibility check fails."""
        return True

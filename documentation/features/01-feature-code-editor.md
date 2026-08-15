# Feature code editor

OpenType feature code lives in Font Info on the **Features** tab (alongside General, Names, Axes, Masters, Instances, and Custom OT Values). The editor is more than a text buffer: it combines syntax-aware editing with shaping preview, glyph search, and feature-order visualization so you can see how code affects rendering.

Write substitutions, positioning rules, class definitions, prefixes, and feature blocks there. Search for a glyph name to highlight every use in rules and classes. That is the fastest way to see the substitution and positioning chain for a character, check class membership, and find a bad reference without scanning the whole file.

The sidebar shaper control chooses an engine such as HarfBuzz and shows the order that engine will apply features. Different shapers can order features differently. Use that list when text does not look the same across environments, or when you suspect a feature-order conflict.

A debugging loop that works: search the problematic glyph, check the active shaper and feature order, verify classes, then try another shaper if the issue looks platform-specific. If a compile error appears, the message usually names a line. Fix that line, compile again, then search the glyph you were shaping.

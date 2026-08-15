# Code-driven user filters

As a font grows, browsing every glyph by hand is a poor way to do targeted QA. Filters let Overview show exactly the subset you care about, including custom Python loaded from your Filters folder.

Built-in filters cover common cases. Custom filters are Python files in the settings folder in `Counterpunch/Filters`. Apply a built-in filter first so you can see the list change, then try a custom script.

A filter only classifies glyphs. It must not edit the font. If a filter errors, read the first line of the message, check syntax and the expected API, fix one thing, and run it again.

The contract for writing a filter is in [Writing glyph overview filters](../python/05-writing-glyph-overview-filters.md). Python setup is in [Python in Counterpunch](../python/01-python-in-counterpunch.md). Recovery notes are in [Common problems](../troubleshooting/common-problems.md).

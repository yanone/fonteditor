# Feature Code Editor

The Feature Code Editor provides a dedicated environment for writing and debugging OpenType feature code. Unlike simple text editing, Counterpunch integrates shaping preview, intelligent search, and feature ordering visualization to help you understand how your code affects text rendering. This makes OpenType development more transparent and debugging significantly faster.

## Summary

The Feature Code Editor combines syntax-aware editing with powerful debugging tools. You can write feature code with immediate shaping feedback, search for glyph usage across all features and classes, and visualize how different text shaping engines order and apply your features.

## Writing Feature Code

The editor provides a focused workspace for OpenType feature development. As you write substitution and positioning rules, class definitions, and feature blocks, the interface helps you maintain valid syntax while keeping track of where glyphs are referenced throughout your code.

## Shaper Selection and Feature Order

Understanding how text shaping engines process your features is essential for reliable OpenType behavior. The sidebar includes a shaper selection control that lets you choose between different shaping engines (such as HarfBuzz or platform-specific shapers). When you select a shaper, Counterpunch displays the resulting feature order—the actual sequence in which features will be applied during text layout.

This visualization helps you identify potential conflicts, verify feature dependencies, and ensure that your code works consistently across different rendering environments. Different shapers may process features in different orders, and seeing these differences directly helps you write more robust feature code.

## Glyph Search Across Features

One of the most powerful debugging capabilities is the glyph search feature. You can search for any glyph name, and the editor will highlight every location where that glyph appears—whether in substitution rules, positioning code, or class definitions. This comprehensive search makes it easy to:

- Track down all references to a specific glyph when debugging unexpected behavior
- Verify that a glyph is correctly included in relevant classes
- Understand the complete substitution and positioning chain for any character
- Identify missing or incorrect glyph references quickly

This is particularly valuable when debugging complex OpenType interactions, where a glyph might be touched by multiple features in ways that aren't immediately obvious from reading the code linearly. Instead of manually scanning through potentially thousands of lines, you can instantly filter to show only the relevant sections.

## Debugging OpenType Behavior

The combination of shaper selection, feature ordering, and glyph search creates a powerful debugging workflow. When text doesn't shape as expected, you can:

1. Search for the problematic glyph to see all features that affect it
2. Check which shaper is active and review the feature application order
3. Verify that classes include the correct glyph set
4. Test with different shapers to identify platform-specific issues

This integrated approach transforms OpenType debugging from a slow, trial-and-error process into a systematic investigation with clear visual feedback.

## Suggested Screenshots

### Screenshot 1 — Feature Code Editor with sidebar

- Filename: `features-01-01-editor-sidebar.png`
- Capture: Full feature editor view showing code panel and sidebar with controls.
- Suggested annotations:
    1. Feature code editing area
    2. Sidebar with shaper selection
    3. Feature order display
- Alt text: Feature Code Editor showing editing area and sidebar controls.

### Screenshot 2 — Shaper selection and feature order

- Filename: `features-01-02-shaper-feature-order.png`
- Capture: Close-up of sidebar showing shaper dropdown and resulting feature order list.
- Suggested annotations:
    1. Shaper selection control
    2. Feature order sequence
    3. Individual feature items
- Alt text: Shaper selection control with resulting OpenType feature application order.

### Screenshot 3 — Glyph search highlighting

- Filename: `features-01-03-glyph-search.png`
- Capture: Search field with glyph name entered and multiple highlighted results in code.
- Suggested annotations:
    1. Glyph search input
    2. Highlighted matches in feature code
    3. Highlighted matches in class definitions
- Alt text: Glyph search showing all references to a specific glyph across feature code and classes.

### Screenshot 4 — Search results in context

- Filename: `features-01-04-search-context.png`
- Capture: Feature code with search filter active showing only relevant sections.
- Suggested annotations:
    1. Active search filter
    2. Visible feature sections containing the glyph
    3. Navigation between results
- Alt text: Filtered feature code view showing only sections where searched glyph appears.

## Related Pages

- [Glyph Editor Basics](../editor/01-glyph-editor-basics.md)
- [Glyph Overview Basics](../overview/01-glyph-overview-basics.md)
- [Python in Counterpunch](../python/01-python-in-counterpunch.md)

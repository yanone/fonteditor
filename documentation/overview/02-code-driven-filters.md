# Code-Driven Glyph Filters

As projects grow, manual browsing becomes inefficient for targeted review tasks. Code-driven filters let you define explicit selection logic so Overview can surface exactly the glyph subset you care about. This makes technical QA and production cleanup significantly faster, especially when paired with repeatable filter scripts.

## Summary

You can narrow glyph lists with filter logic, including custom scripts loaded from your filter workspace. This is particularly useful for focused quality checks, staged release preparation, and repeatable review routines across large fonts.

## Filter Types

- Built-in filters (quick selection helpers).
- Custom filter scripts loaded from your Filters folder.

## Beginner Workflow

1. Start with a built-in filter.
2. Observe which glyphs remain visible.
3. Apply one custom filter script.
4. If filter fails, inspect error and refine script.

## Troubleshooting Filter Errors

- Read the error message first.
- Check syntax and expected API usage in your filter script.
- Re-run after one small fix at a time.

## Suggested Screenshots

### Screenshot 1 — Filter menu in Overview

- Filename: `overview-02-01-filter-menu.png`
- Capture: filter menu open with built-in options.
- Suggested annotations:
    1. Filter trigger
    2. Built-in filter list
    3. Active filter indicator
- Alt text: Glyph Overview filter menu with built-in filter options.

### Screenshot 2 — Custom filter script list

- Filename: `overview-02-02-custom-filter-scripts.png`
- Capture: UI area listing user-provided filter scripts.
- Suggested annotations:
    1. Custom script source/folder
    2. Selected script
    3. Run/apply action
- Alt text: Custom glyph filter scripts available for selection.

### Screenshot 3 — Filter error state

- Filename: `overview-02-03-filter-error.png`
- Capture: failed filter execution with visible error message.
- Suggested annotations:
    1. Error headline
    2. Helpful traceback detail
    3. Retry/edit next step
- Alt text: Error message shown after a glyph filter script fails.

## Related Pages

- [Python in Counterpunch](../python/01-python-in-counterpunch.md)
- [Common Problems and Recovery](../troubleshooting/common-problems.md)

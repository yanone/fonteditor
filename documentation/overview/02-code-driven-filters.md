# Code-Driven Glyph Filters

As projects grow, manual browsing becomes inefficient for targeted review tasks. Code-driven filters let you define explicit selection logic so Overview can surface exactly the glyph subset you care about. This makes technical QA and production cleanup significantly faster, especially when paired with repeatable filter scripts.

## Summary

You can narrow glyph lists with filter logic, including custom scripts loaded from your filter workspace. This is particularly useful for focused quality checks, staged release preparation, and repeatable review routines across large fonts.

## Filter Types

Filters come in two varieties. Built-in filters offer quick selection helpers for common scenarios, while custom filter scripts—loaded from your dedicated Filters folder—enable specialized selection logic tailored to your specific needs.

## Beginner Workflow

When starting with filters, try applying a built-in filter first and observe which glyphs remain visible. Then experiment with a custom filter script to understand how programmable selection works. If a filter encounters an error, read the error message carefully and refine your script incrementally.

## Troubleshooting Filter Errors

When filters fail, the error message typically provides valuable guidance. Begin by checking your syntax and verifying that you're using the expected API patterns. After making corrections, re-run the filter with a single small change at a time to isolate any remaining issues.

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

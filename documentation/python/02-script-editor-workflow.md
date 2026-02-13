# Script Editor Workflow

The Script Editor is the place to turn one-off experiments into reliable, reusable procedures. Instead of repeating manual actions across many glyphs, you can encode intent once and execute it with consistency. This page frames scripting as a production tool for type design, not just a developer feature.

## Summary

Use Scripts view to write reusable Python code for repeatable font operations with clear, reviewable intent. A disciplined script workflow reduces repetitive effort, lowers error rates, and makes complex transformations easier to maintain.

## Recommended Workflow

Developing reliable scripts follows a natural progression. Begin with a small test script to verify basic functionality, then run it and inspect the output carefully. Check that any visual changes appear as expected in the Editor or Overview views before saving the script for future use.

## Beginner Safety Pattern

When you're still learning, certain practices reduce risk and make troubleshooting easier. Focus each script on a single type of change rather than combining multiple operations. Save your font before running scripts that modify data destructively, and maintain different versions of your scripts so you can revert to earlier approaches if needed.

## Suggested Screenshots

### Screenshot 1 — Script editor with run action

- Filename: `python-02-01-script-editor-run.png`
- Capture: script code area and run trigger.
- Suggested annotations:
    1. Script text area
    2. Run shortcut/button
    3. Output/feedback region
- Alt text: Script editor showing Python code and run control.

### Screenshot 2 — Script result reflected in glyph

- Filename: `python-02-02-script-result-glyph.png`
- Capture: before/after state after script run.
- Suggested annotations:
    1. Script operation summary
    2. Changed glyph region
- Alt text: Glyph updated after executing a Python script.

## Related Pages

- [Python in Counterpunch](01-python-in-counterpunch.md)
- [AI Safety and Review](../ai/02-ai-safety-and-review.md)

# AI Safety and Review

AI can dramatically speed up production tasks, but unchecked output can also introduce broad unintended changes. A reliable workflow therefore combines AI generation with explicit review, scoped execution, and predictable rollback habits. This page defines that safety posture so beginners and professionals can both work faster without sacrificing control.

## Summary

Treat AI output as draft work that should be reviewed, constrained, and intentionally applied. In practice, review-first behavior produces higher quality results and significantly lowers correction overhead.

## Review Checklist Before Running AI Output

1. Confirm the task scope is correct.
2. Read generated code or action summary.
3. Check whether it affects one glyph or many.
4. Save your font before applying broad changes.
5. Prefer review-first over auto-run when learning.

## Safe Prompting Tips

- Ask for one operation per request.
- Include concrete constraints (glyph range, axis, layer, naming).
- Ask AI to explain what it will change.

## Suggested Screenshots

### Screenshot 1 — Review Changes mode

- Filename: `ai-02-01-review-changes.png`
- Capture: assistant output in review mode before execution.
- Suggested annotations:
    1. Review summary
    2. Edit/open in script option
    3. Confirm execute action
- Alt text: AI output review screen before applying changes.

### Screenshot 2 — Auto-run toggle state

- Filename: `ai-02-02-auto-run-toggle.png`
- Capture: auto-run option visible and explained by annotation.
- Suggested annotations:
    1. Auto-run toggle
    2. Recommended beginner setting
- Alt text: AI assistant auto-run setting with recommended safe default.

## Related Pages

- [AI Assistant Overview](01-ai-assistant-overview.md)
- [Script Editor Workflow](../python/02-script-editor-workflow.md)

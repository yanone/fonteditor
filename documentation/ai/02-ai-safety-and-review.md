# AI Safety and Review

AI can dramatically speed up production tasks, but unchecked output can also introduce broad unintended changes. Counterpunch's assistant is designed with complete user agency as a core principle—it never automatically modifies your font, executes code without permission, or makes decisions about what to change. A reliable workflow combines AI generation with explicit review, scoped execution, and predictable rollback habits. This page defines that safety posture so beginners and professionals can both work faster without sacrificing control.

## Summary

Treat AI output as draft work that should be reviewed, constrained, and intentionally applied. The assistant generates readable Python scripts you can inspect, modify, and approve before execution. In practice, review-first behavior produces higher quality results, helps you learn Python patterns, and significantly lowers correction overhead.

## Complete Control

Every script the assistant generates is presented for your review before execution. You have several options:

- **Read it** to understand exactly what it does (and potentially learn Python patterns in the process)
- **Modify it** if you want different behavior or want to refine the approach
- **Run it** when you're satisfied with the logic
- **Save it** for reuse on other fonts or future sessions
- **Discard it** if it doesn't meet your needs

This is fundamentally different from AI tools that automatically execute changes or use "tool calling" approaches where the AI can interact with your data autonomously. While those approaches may seem convenient, they sacrifice transparency, control, and the learning opportunities that come from reviewing generated code.

## Review Checklist Before Running AI Output

Before applying AI-generated changes, several verification steps help ensure quality outcomes. Confirm that the task scope matches your intention, read through the generated code or action summary carefully, and understand whether the operation will affect a single glyph or many. Saving your font before applying broad changes provides an easy recovery path. When you're still learning, reviewing proposals before execution generally produces better results than automatic application.

Remember that Counterpunch's undo system will allow you to cleanly revert all changes if the results aren't what you expected.

## Safe Prompting Tips

Effective prompts help the AI understand your needs precisely. Requesting one operation at a time keeps changes manageable and easier to verify. Including concrete constraints—such as specific glyph ranges, axis values, layer names, or naming patterns—helps the AI generate more accurate proposals. You can also ask the AI to explain what it intends to change before it generates the actual code.

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

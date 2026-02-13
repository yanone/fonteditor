# AI Assistant Overview

The AI Assistant is designed to reduce repetitive work while keeping the designer in control of outcomes. Unlike most AI tools that send your data to remote servers for analysis, Counterpunch's assistant generates Python scripts that run entirely on your computer. Your font data never leaves your machine—the AI learns about font structure and APIs, not your specific designs. This page introduces how to use the assistant strategically in type design workflows while understanding its unique privacy-first architecture.

## Summary

The AI Assistant helps generate Python code and guided operations for font-editing tasks across multiple contexts. It is built on a privacy-first design where algorithms are generated remotely but execute locally, keeping your proprietary font data completely private while delivering fast, efficient assistance.

## How It Works

When you ask the assistant for help, it follows a transparent workflow. You describe what you want in plain language, and the AI generates a Python script that performs that task. You can then review the script to see exactly what it will do, modify it if needed, and run it when ready. The script executes locally on your computer without ever sending font data to any external service.

This approach is dramatically more efficient than traditional AI coding assistants. While typical AI sessions might use 500,000+ tokens analyzing your data incrementally, Counterpunch's assistant uses fewer than 8,000 tokens per request by generating algorithms rather than analyzing specific data. The result is faster responses and lower costs.

## What It Can Help With

The AI Assistant is particularly effective for certain categories of work. It can handle repetitive glyph edits that would be tedious to perform manually, generate structured transformations across many glyphs while maintaining consistency, and help draft or refine scripts when you're working with Python automation. Every script it generates becomes a reusable algorithm that works on any font, gradually building your personal library of tools.

## Assistant Contexts

The assistant operates in three distinct contexts, each tailored to different workflows:

### Font Context

In Font context, the assistant generates scripts that modify your font directly. You might ask it to "add 100 units of sidebearing to all glyphs" or "create small caps variants." These scripts can be executed immediately after review, or saved for future use.

### Script Context

Script context helps you develop reusable code in the Script Editor. The assistant can create new scripts from scratch, modify existing ones, or show you a comparison between old and new versions. Scripts in this context are never executed immediately—you review and apply changes deliberately.

### Glyph Filter Context

Filter context enables you to create custom selection criteria for the Overview panel. Instead of predefined filters, you can generate completely custom logic like "show all .swash glyphs wider than 600 units" or any other project-specific filtering needs.

## Suggested Screenshots

### Screenshot 1 — Assistant panel main UI

- Filename: `ai-01-01-assistant-panel.png`
- Capture: Assistant view with prompt area and action controls.
- Suggested annotations:
    1. Prompt input
    2. Context selector
    3. Run/apply control
- Alt text: AI Assistant panel with prompt and context controls.

### Screenshot 2 — AI-generated action result

- Filename: `ai-01-02-generated-result.png`
- Capture: generated script or action output with review options.
- Suggested annotations:
    1. Generated code/output
    2. Review/edit option
    3. Execute option
- Alt text: AI-generated output in assistant with review and run options.

## Privacy and Data Handling

Your font data stays completely private. The AI service receives only your text prompt and, when working in Script context, the current script you're editing. It never receives glyph outlines, metrics, or other font data. The assistant learns about the font object model's structure and API, then generates algorithms based on that knowledge—not by analyzing your specific designs.

Conversations with the assistant can be saved with titles and keywords for future reference. This allows the assistant to understand your preferences and workflow patterns across sessions, similar to how services like ChatGPT maintain memory. However, the crucial difference is that while your conversations are stored as text, your actual font data remains local and is never transmitted.

## Growing Intelligence

As Counterpunch's object model expands with new convenience methods and community-contributed tools, the assistant becomes more capable. Scripts that once required 50 lines of code might eventually become a single method call. This creates a self-reinforcing cycle: useful algorithms get refined and integrated into the core, making future scripts shorter, faster, and more reliable.

Importantly, once you have a working script or know about a method, the assistant is optional. Scripts generated once can be reused indefinitely without ever invoking the AI again—the assistant primarily helps with initial discovery and generation.

## Related Pages

- [AI Safety and Review](02-ai-safety-and-review.md)
- [Subscription, Trial, and Usage](03-subscription-trial-and-usage.md)
- [Python in Counterpunch](../python/01-python-in-counterpunch.md)

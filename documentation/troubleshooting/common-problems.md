# Common Problems and Recovery

Even in stable workflows, complex font projects can surface occasional runtime, permission, or script-related issues. The key is to recover methodically: identify the failure category, apply the shortest reliable fix, and confirm normal behavior before resuming edits. This page is structured for quick triage so users spend less time blocked and more time designing.

## Summary

Use this page when something fails and you need a fast, structured path back to a working state. Recovery steps are organized by symptom so beginners can diagnose issues without deep technical context.

## App Does Not Start Correctly

Several factors can prevent Counterpunch from starting properly. Browser compatibility issues, missing cross-origin isolation requirements, or WebAssembly memory constraints can all interfere with the initial load.

To recover, try refreshing the page once to see if the issue resolves. If problems persist, consider using a current build of Chrome or Edge for better compatibility. You might also try reopening the project with a smaller font file to reduce memory requirements.

## Local Disk Folder Is Not Accessible

Folders may become inaccessible when permissions expire, are revoked, or when your browser session changes in ways that affect stored permissions.

You can restore access by navigating to Files → Disk and clicking the **Re-enable access** button. Select the same folder again and allow read/write permissions in the browser prompt that appears.

## Script or Filter Fails

Script and filter failures typically stem from Python syntax errors, unexpected object or property usage, or executing code in the wrong context.

To diagnose the issue, try re-running the operation with a smaller scope to isolate the problem. Read the first line of the error message carefully, as it often points directly to the issue. You can validate your assumptions about the font model by testing simpler versions of your code in the Konsole.

## AI Assistant Is Unavailable

The AI Assistant may be unavailable if you're not signed in, lack an active Advanced subscription or trial, or have reached your usage limit.

Resolve this by first confirming that you're logged in correctly. Check your subscription status through the account management interface, and review any usage warnings that may explain the limitation.

## Suggested Screenshots

### Screenshot 1 — Critical startup error state

- Filename: `troubleshooting-01-startup-error.png`
- Capture: startup error or failure overlay.
- Suggested annotations:
    1. Error headline
    2. Retry guidance
    3. Browser recommendation
- Alt text: Startup error overlay with recommended recovery actions.

### Screenshot 2 — Disk permission recovery state

- Filename: `troubleshooting-02-disk-permission.png`
- Capture: local disk re-enable access flow.
- Suggested annotations:
    1. Permission warning
    2. Re-enable button
- Alt text: File permission recovery flow for local disk access.

### Screenshot 3 — Script/filter error message

- Filename: `troubleshooting-03-script-filter-error.png`
- Capture: failed script or filter output with traceback.
- Suggested annotations:
    1. Error location
    2. Next debug action
- Alt text: Python script or filter error output in Counterpunch.

### Screenshot 4 — AI access warning state

- Filename: `troubleshooting-04-ai-access-warning.png`
- Capture: assistant not available due to account/usage state.
- Suggested annotations:
    1. Unavailable message
    2. Manage account action
- Alt text: AI assistant unavailable warning with account action.

## Related Pages

- [Local Disk Access](../files/02-local-disk-access.md)
- [AI Subscription, Trial, and Usage](../ai/03-subscription-trial-and-usage.md)

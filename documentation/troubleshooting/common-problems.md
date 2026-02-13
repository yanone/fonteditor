# Common Problems and Recovery

Even in stable workflows, complex font projects can surface occasional runtime, permission, or script-related issues. The key is to recover methodically: identify the failure category, apply the shortest reliable fix, and confirm normal behavior before resuming edits. This page is structured for quick triage so users spend less time blocked and more time designing.

## Summary

Use this page when something fails and you need a fast, structured path back to a working state. Recovery steps are organized by symptom so beginners can diagnose issues without deep technical context.

## App Does Not Start Correctly

Possible causes:

- Browser compatibility issue.
- Missing cross-origin isolation requirements.
- WebAssembly memory or startup failure.

Recovery:

1. Refresh once.
2. Try current Chrome/Edge build.
3. Reopen the project and retry with a smaller file.

## Local Disk Folder Is Not Accessible

Possible causes:

- Permission expired or revoked.
- Browser session changed.

Recovery:

1. Go to Files → Disk.
2. Click re-enable access.
3. Re-select folder and allow read/write.

## Script or Filter Fails

Possible causes:

- Python syntax error.
- Unexpected object/property use.
- Wrong execution context.

Recovery:

1. Re-run with smaller scope.
2. Read first error line carefully.
3. Validate assumptions in Konsole.

## AI Assistant Is Unavailable

Possible causes:

- Not signed in.
- No active Advanced subscription/trial.
- Usage limit reached.

Recovery:

1. Confirm login state.
2. Check subscription status.
3. Review usage warning and manage account.

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

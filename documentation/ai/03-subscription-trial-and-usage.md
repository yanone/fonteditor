# Subscription, Trial, and Usage

Because AI features are account- and plan-aware, users need a clear operational understanding of entitlement states before troubleshooting behavior. In Counterpunch, assistant availability depends on sign-in status, tier eligibility, and usage state. This page explains those mechanics in user-facing terms so access issues can be diagnosed quickly.

## Summary

AI Assistant access is tied to account status, plan level, and usage conditions surfaced in-product. This page explains the practical states users encounter during normal use, trial onboarding, and limit-reached scenarios.

## Access Model

- You need to be signed in.
- AI Assistant features require the Advanced tier.
- A trial period may be offered for eligible users.

## Usage and Billing Signals in the UI

- Remaining usage/credits can be shown in the Assistant panel.
- Low or exhausted balance states may trigger warnings.
- Overage/limit conditions can disable AI actions until resolved.

## Account Management

- Use in-app account management links to update subscription state.
- If AI is unexpectedly unavailable, verify:
    1. login status
    2. active plan
    3. usage balance state

## Important Note About Pricing Numbers

Do not hardcode plan prices or quota numbers in this documentation unless they are maintained as canonical values in this repository. Link to the official pricing/account page for current values.

## Suggested Screenshots

### Screenshot 1 — AI paywall/subscription-required state

- Filename: `ai-03-01-subscription-gate.png`
- Capture: assistant panel when advanced access is required.
- Suggested annotations:
    1. Subscription-required message
    2. Upgrade/start trial button
    3. Sign-in status area
- Alt text: AI Assistant showing that an advanced subscription is required.

### Screenshot 2 — Trial or active subscription status

- Filename: `ai-03-02-trial-active-state.png`
- Capture: UI state indicating trial/active entitlement.
- Suggested annotations:
    1. Trial badge or active status
    2. Manage account link
- Alt text: Account status area showing AI trial or active subscription.

### Screenshot 3 — Low balance or usage limit warning

- Filename: `ai-03-03-usage-warning.png`
- Capture: warning state for low/exhausted usage.
- Suggested annotations:
    1. Warning message
    2. Next action (top up/manage)
- Alt text: AI usage warning indicating low or exhausted credits.

## Related Pages

- [AI Assistant Overview](01-ai-assistant-overview.md)
- [Common Problems and Recovery](../troubleshooting/common-problems.md)

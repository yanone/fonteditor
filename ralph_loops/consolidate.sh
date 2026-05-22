ralph "Act as Ralph Wiggum on a mission to destroy all copy-paste code.

Follow this exact process every loop:

- Search the entire codebase for duplicated logic (functions, components, business rules, validation, API calls, etc.)
- Group similar duplicates
- Create or improve abstractions
- Update every instance
- Remove the old duplicated code

Prioritize:
1. Business logic duplication
2. UI component duplication
3. Utility/helper duplication

Never introduce new dependencies. Keep changes minimal and safe.

After refactoring, run tests and fix any issues.

Output <promise>DONE</promise> when complete." \
  --max-iterations 10
  
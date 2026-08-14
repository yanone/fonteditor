# Common problems

When something fails, identify the category, apply the shortest reliable fix, and confirm the app is healthy before you continue designing.

## App does not start

Browser compatibility, missing cross-origin isolation, or WebAssembly memory limits can block the first load. Refresh once. Use a current Chrome or Edge build. Try a smaller font if memory is tight. SharedArrayBuffer is required.

## Disk folder is not accessible

Permissions expire, get revoked, or fail after a browser session change. In Files → Disk, click **Re-enable access**, select the same folder, and allow read/write. Details are in [Local disk access](../files/02-local-disk-access.md).

## Script or filter fails

Usually a syntax error, an unexpected property, or calling `Glyph()` / `Layer()` outside outline editing. Shrink the test, read the first line of the error, and try the same call in Konsole. Filters must not edit the font.

## AI assistant is unavailable

You may be signed out, missing the Advanced plan or trial, or out of usage. Confirm login, check subscription in account management, and read any usage warning. See [Subscription and usage](../ai/03-subscription-trial-and-usage.md).

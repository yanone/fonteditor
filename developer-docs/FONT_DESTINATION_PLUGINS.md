# Font Destination Plugins

Font Destination plugins let a third-party website receive the binary font that
Counterpunch just exported. The plugin is a small Python package for discovery
and menu metadata; the actual receiver is a normal web page owned by the third
party.

The receiver does not compile fonts, alter the editing worker, or receive data
until the user explicitly opens it from **Tools > Font Destinations** and later
performs **File > Export binary font**.

## Why There Is A Bridge

Counterpunch runs cross-origin isolated so browser WASM features such as
`SharedArrayBuffer` stay available. In that mode, directly opening an arbitrary
cross-origin site and talking to it through `window.opener` is unreliable: the
browser can sever or proxy the relationship to preserve isolation.

Counterpunch therefore opens a small same-origin bridge page and places the
third-party receiver inside a `credentialless` iframe. The bridge keeps the
editor isolated, keeps the destination user-opened, and forwards only the
binary-export message after the receiver says it is ready.

For receiver authors this means: implement one `postMessage` listener and one
ready signal. You do not need to know about the editor internals.

## Discovery

The Plugin Manager uses Counterpunch's reusable editor-origin-gated GitHub code
search API to find global marker matches, then loads each matched manifest
directly from GitHub. A plugin is included only when its manifest carries this
exact marker:

```text
counterpunch-plugin:font-destination:v1
```

A matching manifest uses schema `counterpunch-plugin-manifest:v1` and supplies
the display metadata, Python entry point, receiver URL and exact origin,
repository, and the release wheel asset naming rules. Counterpunch validates
the manifest before downloading any release assets and never executes code as
part of GitHub discovery.

The important manifest fields are:

- `fontDestination.entryPoint`: Python entry point name from the wheel.
- `fontDestination.destinationUrl`: browser receiver page to embed.
- `fontDestination.targetOrigin`: exact origin of that receiver page.
- `release.repository`: GitHub repository that publishes the wheel release.
- `release.wheelAssetPrefix` and `release.checksumAssetSuffix`: asset matching
  rules for the downloadable wheel and SHA-256 checksum.

## Installation

Plugin installation requires a user-selected Disk workspace with granted
read/write File System Access permission. The selected folder is Counterpunch's
root for all app-owned directories; its name and location remain the user's
choice. The installer verifies the SHA-256 release checksum and writes the
wheel to:

```text
<selected Disk folder>/Plugins/<distribution>-<version>-py3-none-any.whl
```

The wheel's presence defines the installed state. During startup, Counterpunch
reinstalls every wheel from this directory into Pyodide when the retained Disk
folder still grants permission. Removing a wheel affects a newly initialized
Pyodide runtime; Python modules already imported in the current runtime remain
loaded until that runtime is recreated.

## Python Contract

Distributions register an entry point in:

```text
counterpunch_font_destination_plugins
```

The entry point constructs a `FontDestinationPlugin` and returns serializable
metadata through `metadata()`. The metadata contains `pluginId`, `name`,
`description`, `destinationUrl`, `targetOrigin`, `repositoryUrl`, and optional
`iconUrl`. The destination URL's origin must exactly equal `targetOrigin`.

Minimal metadata class:

```py
class FontDestinationPlugin:
	def metadata(self):
		return {
			'pluginId': 'my-font-destination',
			'name': 'My Font Destination',
			'description': 'Receives Counterpunch binary-font exports.',
			'destinationUrl': 'https://example.com/counterpunch-receiver/',
			'targetOrigin': 'https://example.com',
			'repositoryUrl': 'https://github.com/example/my-font-destination',
			'iconUrl': None,
		}
```

## Receiver Contract

When the user opens an item from **Tools > Font Destinations**, Counterpunch
opens a same-origin bridge window that embeds the declared URL in a
`credentialless` frame. This keeps the editor cross-origin isolated while
allowing the bridge to forward a later successful **File > Export binary font**
action. No binary data is created when the destination is opened.

After installing its message listener, a receiver must notify its parent frame:

```js
window.parent.postMessage(
    { type: "counterpunch:font-destination-ready", version: 1 },
    "https://editor.counterpunch.space",
);
```

The bridge keeps only the newest export until it receives that ready message.
It then transfers a fresh `ArrayBuffer` with the existing
`counterpunch:binary-font-exported` message. Receivers must accept messages
only from a documented Counterpunch editor origin. Cross-origin isolation can
proxy the sender window, so receivers must not compare `event.source` with
`window.parent`. They should also inspect the message type, protocol version,
and transferred `ArrayBuffer` before reading the binary font.

Export message shape:

```ts
type BinaryFontExportMessage = {
    type: "counterpunch:binary-font-exported";
    version: 1;
    bytes: ArrayBuffer;
    metadata?: {
        filename?: string;
        byteLength?: number;
        format?: "ttf";
        mimeType?: string;
        changeVersion?: number;
        timeTakenMs?: number;
    };
};
```

Minimal receiver code:

```js
const editorOrigins = new Set([
    "https://editor.counterpunch.space",
    "https://preview.editor.counterpunch.space",
]);

window.addEventListener("message", (event) => {
    const message = event.data;
    if (
        !editorOrigins.has(event.origin) ||
        message?.type !== "counterpunch:binary-font-exported" ||
        message.version !== 1 ||
        !(message.bytes instanceof ArrayBuffer)
    ) {
        return;
    }

    // message.bytes is transferable binary font data.
    // message.metadata includes filename, byteLength, format, mimeType,
    // changeVersion, and timeTakenMs when available.
    receiveFont(message.bytes, message.metadata || {});
});

window.parent.postMessage(
    { type: "counterpunch:font-destination-ready", version: 1 },
    "https://editor.counterpunch.space",
);
```

The example receiver wraps this in
`site/counterpunch-font-destination.js`; third-party receivers may copy that
helper and provide only an `onFont({ bytes, metadata })` callback.

## Efficient Receiver Design

- Register the message listener before doing expensive UI work, then send the
  ready message immediately.
- Treat every accepted message as a new receipt, even when the font name and
  table data are unchanged. Show a receipt timestamp, counter, byte hash, or
  exported `changeVersion` so users can see that a new export arrived.
- Keep only the current font unless your product explicitly needs history.
  Counterpunch already transfers a fresh `ArrayBuffer` for each open
  destination.
- Validate by origin, message type, protocol version, and `ArrayBuffer`. Do not
  validate by `event.source`; browser isolation can proxy it.

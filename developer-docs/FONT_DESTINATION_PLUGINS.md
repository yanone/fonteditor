# Font Destination Plugins

Font Destination plugins provide an explicitly opened browser destination for
binary-font exports. They do not compile fonts, alter the editing worker, or
receive data until the user performs a normal binary export.

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

## Delivery

When the user opens an item from **Tools > Font Destinations**, Counterpunch
opens a same-origin bridge window that embeds the declared URL in a
`credentialless` frame. This keeps the editor cross-origin isolated while
allowing the bridge to forward a later successful **File > Export binary font**
action. No binary data is created when the destination is opened.

After installing its message listener, a receiver must notify its parent frame:

```js
window.parent.postMessage(
	{ type: 'counterpunch:font-destination-ready', version: 1 },
	'https://editor.counterpunch.space'
);
```

The bridge keeps only the newest export until it receives that ready message.
It then transfers a fresh `ArrayBuffer` with the existing
`counterpunch:binary-font-exported` message. Receivers must accept messages
only from a documented Counterpunch editor origin. Cross-origin isolation can
proxy the sender window, so receivers must not compare `event.source` with
`window.parent`. They should also inspect the message type, protocol version,
and transferred `ArrayBuffer` before reading the binary font.

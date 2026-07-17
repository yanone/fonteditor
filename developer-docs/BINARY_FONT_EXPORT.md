# Binary Font Export

Binary font export is an explicit user action. It does not run after edits,
while opening a font, or as part of synchronization.

## User actions

- **File > Export binary font** (`Cmd+E` on macOS, `Ctrl+E` elsewhere) compiles
  the current committed font as a TrueType binary and writes it to the most
  recently chosen destination for the currently open font.
- **File > Export binary font as...** (`Cmd+Shift+E` on macOS,
  `Ctrl+Shift+E` elsewhere) always opens the browser's save picker and replaces
  that in-memory destination.

The destination is intentionally retained only for the current browser session
and current font object. Switching fonts or reloading the page requires choosing
a destination again. The browser File System Access API is required.

## Compilation behavior

Before compiling, export waits for the editing worker and pending Yjs update
chain to settle. It snapshots the committed Yjs state, seeds the separate
`fullFontCompilation` worker, and compiles the `user` target. Export never
mutates or recompiles the editing worker.

This same isolated full-font worker is also used by agent binary-analysis tools.
It is not an automatic quality-control or background compilation lane.

## Window notification

After each successful write, the exporting window emits:

```ts
window.postMessage(
    {
        type: "counterpunch:binary-font-exported",
        version: 1,
        bytes: ArrayBuffer,
        metadata: {
            byteLength: number,
            changeVersion: number,
            filename: string,
            format: "ttf",
            mimeType: "font/ttf",
            timeTakenMs: number,
        },
    },
    window.location.origin,
    [bytes],
);
```

`postMessage` notifies listeners in the same window only. It does not broadcast
to independently opened tabs or third-party applications. The bytes buffer is
transferred, so a receiver should consume the supplied `ArrayBuffer` directly.

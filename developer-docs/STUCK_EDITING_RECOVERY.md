# Recovering a stuck editing session

The editor can look broken while the **app version is fine** and the **font file is fine**. Typical signs:

- Switching glyphs does not load the new outlines
- The glyph stack label shows `(none)` while you are clearly editing a glyph
- Local webpack and a hosted build (preview or official) start failing the **same way** even though only one of them changed, or neither did
- A warning icon appears in the Editor title bar. Click it for the specific failure the app detected.

This is a **stuck browser session**, not a corrupt `.glyphs` file and not automatically a bad deploy. Work through the methods in order. Stop when glyph switching works again.

**Use the same window that is stuck.** Official (`https://editor.counterpunch.space`), preview (`https://preview.editor.counterpunch.space`), and a local development server are three different copies. They do not share a service worker or site storage. Closing or updating one copy does not repair another copy’s stored app. It **can** still unblock another copy if Chrome itself is wedged (see method 1).

This is a different problem from “the window is stuck on an old published version.” If Preferences shows the wrong version, use `developer-docs/APP_UPDATE_RECOVERY.md` first.

## 1. Close every Counterpunch window, then reopen one

Close **all** Counterpunch tabs and installed app windows: official, preview, and localhost. Then open **only** the window you need.

A hard reload of one tab (`Cmd+Shift+R` / `Ctrl+Shift+R`) is often **not** enough if another Counterpunch window is still open. In that situation the remaining window can keep the Chrome process wedged, so the reloaded tab comes back already broken.

This is the step that has unstuck a localhost session after a hard reload of localhost alone failed.

You do **not** need to avoid running two copies of the app in one Chrome as everyday practice. Use this close-all step when editing is already dead.

## 2. Hosted builds: force a fresh app copy with `?update`

If the stuck window is preview or official, after method 1 (or if method 1 was not enough), load `?update` on **that** site:

- official: `https://editor.counterpunch.space/?update`
- preview: `https://preview.editor.counterpunch.space/?update`

If the URL already has other parameters, use `&update` instead.

That unregisters the service worker, clears Cache Storage, and reloads from the network. Fonts on disk and usual editor settings stay. Details: `developer-docs/APP_UPDATE_RECOVERY.md`.

Local webpack has no hosted service-worker copy. `?update` does not apply there. Use method 1, then a hard reload of the local tab.

## 3. Quit Chrome fully

Quit Chrome completely (every window, not only the editor tab). Open Chrome again, then open a **single** Counterpunch address.

Do this if method 1 seemed to work and the session dies again as soon as a second copy is open, or if an installed app window (no address bar) was left running in the background.

## 4. Check that it is the browser, not the build

Open the **same** address in a Chrome Guest window (or a fresh profile), with no extra extensions.

- Guest works, your usual profile does not: the profile is the problem (extensions, GPU process, cached code). Stay in Guest until you can restart the normal profile, or disable extensions and try again.
- Guest fails too, and you already ran `?update` on a hosted build: treat it as an app bug and keep a note of Chrome’s version (for example the `Chrome/…` token in `about:version`), how many editor windows were open, and whether stack stayed `(none)` after a glyph switch.

## What not to do

- Do not assume the font on disk is corrupt because preview and localhost failed together. They are separate origins; a shared Chrome process can make both look dead.
- Do not assume the last local commits caused a hosted preview failure if that preview build was already published and had been working.
- Do not use Application → Storage → **Clear site data** unless you intend a full site reset. That wipes more than the cached app. Prefer `?update` (hosted) or closing windows (session).
- Do not keep one “dead” editor open while testing a second copy. The dead window can keep the process wedged.

## How to tell this apart from a stuck app version

| | Stuck **version** | Stuck **editing session** |
| --- | --- | --- |
| Preferences version | Old, not the tag you expect | Current / expected |
| `?update` | Needed to pick up a new deploy | Helps hosted windows; may not be why localhost died |
| Hard reload of one tab | Usually not enough (service worker still serves the old copy) | Usually not enough **if another Counterpunch window is still open** |
| Close every editor window | Extra windows can keep an old worker alive | Often the actual fix |
| Glyph stack `(none)`, outlines not switching | Not the main clue | Main clue |

## Short developer note

The editing UI clears the glyph stack on glyph switch, then rebuilds it during `updatePropertiesUI`. If that update never finishes, later switches skip the rebuild and the stack stays `(none)`. A hung fontc interpolate (a worker reply that never settles a promise) can hold that update open.

That hang lives in **page JavaScript** and **should** clear on a true reload of that tab. When a reload of localhost does **not** help until every other Counterpunch window is gone, treat it as a Chrome-process problem (two heavy WASM editors in one profile), not as shared site storage between localhost and preview. There is no web API to detect “the other origin’s tab wedged Chrome.” Detection, if added, has to watch this page: stack still empty after a glyph switch, or an interpolate / worker ping that does not return.

# Cloud Collaboration Deployment Checklist

This is the operational checklist for the current Cloudflare-native
collaboration stack.

## Components

Production collaboration depends on three deployables:

1. the editor frontend
2. the website Pages project
3. the `website/workers/fonts-room` Worker that owns the Durable Object room
   runtime

## Required Production State

Before smoke testing collaboration, verify all of the following:

1. R2 is enabled on the Cloudflare account. The `fonts-room` worker cannot be
   deployed until the account has R2 access enabled in the Cloudflare
   dashboard.
2. The editor builds successfully from `editor/webapp` with `npm run build`.
3. The website builds successfully from `website` with `npm run build`.
4. The `fonts-room` worker bundles successfully from
   `website/workers/fonts-room` with `npx wrangler deploy --dry-run`.
5. The website Pages project has a production `ROOM_WORKER_URL` variable set to
   the public origin of the deployed `fonts-room` worker.
6. The `fonts-room` worker is deployed with its `FONT_ROOM` Durable Object
   binding and `ROOM_STATE_BUCKET` R2 binding.
7. The website Pages project still has its expected D1 and KV bindings.

## Production Smoke Test

Use this exact sequence after deployment:

1. Open the editor from one browser or computer and authenticate as a cloud-
   enabled user.
2. Open or save a cloud font asset.
3. Copy the resulting `cloud:///...` asset URL or reopen the same asset from the
   file browser in a second browser or computer using the same user account.
4. Confirm both clients reach the connected cloud state.
5. Make a visible glyph edit in client A.
6. Confirm the same glyph data converges in client B without reloading.
7. Reload one client and confirm the asset reopens from the same cloud asset id.

## Local Confidence Gate

Before production deployment, the local stack should stay green via:

1. `npm run test:collab:local` from the editor repo root

That workflow validates:

1. save to local cloud
2. reopen from another page
3. live convergence between connected clients
4. convergence across separate browser contexts

## Current Known Requirement

Production collaboration is not expected to work if `ROOM_WORKER_URL` is
missing from the website deployment. The website will now fail room-token
issuance clearly in that case rather than silently routing clients to a stale
host.

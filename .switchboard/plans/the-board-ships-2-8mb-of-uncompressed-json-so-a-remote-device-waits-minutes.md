# The Board Ships 2.8 MB of Uncompressed JSON on Every Load, So a Remote Device Waits Long Enough to Assume It Is Broken

## Goal

Opening the board from a phone or tablet on the tailnet should show usable cards in about a second, not after a wait long enough that the operator reloads, inspects the icons, and reports a bug. The board must stop sending its entire history, uncompressed, before it renders anything.

### Problem analysis

Reported as: *"over remote, it takes so long to render it looks like a bug. A user should not have to wait 10 minutes just to use this."*

The report arrived as three separate-looking symptoms on an iPad over Tailscale, all of which are the same cause:

1. The board loaded but showed **no cards**. A reload fixed it.
2. The **column header icons were completely missing**, then appeared much later.
3. Overall it was slow enough to look broken.

None of these is a rendering defect. They are what a very large, uncompressed, blocking payload looks like from the far end of a link.

#### Measured on this machine, 2026-09-04

```
GET /kanban/plans?workspaceRoot=…
  HTTP 200
  Content-Type: application/json
  … no Content-Encoding header at all
  2,826,774 bytes            ← 2.8 MB, raw
  2,475 card rows
```

Sent with `Accept-Encoding: gzip, deflate, br`, the server returns the same 2,826,774 bytes. The identical payload gzips to **300,118 bytes** — a 9.4× reduction that costs one middleware.

`grep -nE "gzip|deflate|zlib|content-encoding" src/services/LocalApiServer.ts` returns **nothing**. The server has no compression on any route.

#### Why it looks fine here and terrible on the iPad

On the loopback and LAN paths this is invisible: the fetch completes in 0.16 s and nobody notices 2.8 MB. The cost is entirely on the remote link:

| Link | Time for the board JSON alone |
| :--- | ---: |
| Home wifi over the tailnet | 0.9 s |
| Good 4G | 2.8 s |
| Mediocre 4G | 11.3 s |
| Poor cellular | 32.3 s |
| **Gzipped, poor cellular** | **3.4 s** |

That is one response. It also explains the two symptoms that looked like separate bugs: the board HTML is 29 KB and arrives instantly, so the operator sees a **rendered board with no cards** while the 2.8 MB is still in flight — exactly symptom 1. And the four sub-resources (`shell.js`, `sharedDefaults.js`, the icon, the manifest) queue behind that response on the same connections, so the **icons appear long after the frame does** — symptom 2.

#### The payload is mostly work nobody is looking at

Of the 2,475 rows on the wire:

| Column | Rows | Share |
| :--- | ---: | ---: |
| CODE REVIEWED | 2,038 | 82% |
| PLAN REVIEWED | 268 | 11% |
| CREATED | 105 | 4% |
| BACKLOG | 58 | 2% |
| CODER CODED / INTERN CODED | 6 | <1% |

**82% of the payload is a single archival column.** The operator opening a board on a phone is looking at New, Planned and the coding columns. Every card ever completed is shipped first, ahead of them, on every load.

This also means the problem grows with use. It is not a fixed cost that can be tuned once; a board that has done more work is slower to open, forever.

#### Why this is not covered by existing plans

Two plans touch adjacent ground and neither fixes this:

- *Review Plan Selects The Plan It Was Clicked On, And Stops Refetching The Whole Board To Do It* measured the same class of problem on the **Project panel** (2.1–2.3 s, 1.4 MB, 2,555 plans over the tailnet) and fixes that panel's selection path. It does not touch the board's own load, and its measurement is now a year of cards out of date — the same call returns twice that today.
- *Dispatch-Analysis Reads the Per-Column Board Mirror Instead of Pulling the Whole Board as JSON* fixes the **agent** read path by pointing it at the per-column markdown mirror. The browser board does not use that mirror.

Neither plan proposes compression, and nothing on the board does.

## Metadata

- **Complexity:** 5
- **Tags:** performance, remote-access, standalone, kanban, bugfix

## User Review Required

None.

## Proposed Changes

### 1. Compress every response the board serves

This is the whole fix for most of the symptom and is worth landing on its own, before anything else here.

In `src/services/LocalApiServer.ts`, add response compression negotiated from the request's `Accept-Encoding`: gzip, with deflate as fallback, and no compression when the client asks for none.

- Apply it to JSON and to the static webview assets. Skip anything already compressed (PNG, the icon) and skip bodies below roughly 1 KB, where the framing costs more than it saves.
- Use `zlib.createGzip()` streamed into the response rather than buffering, so a large board does not double in memory on the server.
- Set `Content-Encoding` and `Vary: Accept-Encoding`. Do not set `Content-Length` on a compressed response unless the body is fully buffered first.
- **Both hosts.** `LocalApiServer` is shared, so the change reaches the extension host and the standalone host together. Verify it in both rather than assuming; the two roots construct the server with different options.
- The WebSocket path already has its own deflate configuration and a contract test pinning it. Do not touch it, and do not assume it covers HTTP — it does not.

Expected effect, measured against today's payload: 2,826,774 → about 300,118 bytes on the wire.

### 2. Stop sending the archive to the browser board

Compression makes 2.8 MB cheap to send. It does not make it right to send.

Give `/kanban/plans` an explicit column scope, and have the board request the columns it is about to render rather than everything:

- The board asks for the columns it displays. Completed and archival columns are fetched **on demand**, when the operator scrolls to or expands one, not as part of first paint.
- Default the endpoint to today's behaviour when no scope is passed, so every existing caller — the CLI, the agent skills, the Project panel — keeps working unchanged. This must be additive; several shipped clients read this route.
- Cap what an unscoped request returns and say so in the response, rather than silently truncating. A caller that needs everything can page.

On today's board this takes first paint from 2,475 rows to about 437.

### 3. Render what has arrived, rather than waiting for all of it

Even at 300 KB the board currently paints nothing until the whole response lands. Make the columns render as their data arrives, so the operator sees New and Planned while the rest is still coming. If that proves to need a streaming response shape, treat it as a follow-on rather than widening this plan — changes 1 and 2 together already take the common case under a second.

### 4. Let the operator see this without a stopwatch

Add the payload size and elapsed time of the last board fetch to the status bar or the diagnostics view, behind the existing verbose flag. The reason this survived so long is that it is invisible on loopback, where it is developed and tested. A number on screen makes the next regression a fact rather than a report.

## Edge-Case & Dependency Audit

1. **Do not gzip an already-gzipped body.** Check for an existing `Content-Encoding` before wrapping.
2. **Range requests and streaming routes.** The terminal log endpoints and any `Range` responses must be excluded from compression, or byte offsets stop meaning what the client thinks.
3. **The tailnet listener is a separate `http.Server`.** Compression must be applied at the shared request handler, not on one listener, or the loopback path is fast and the remote path — the only one that needs it — is not. This is the exact shape of defect the tailnet Host-header bug had.
4. **The CLI and the agent skills read this route.** `switchboard plans`, `get-state.js` and the orchestration skills all call it. Additive scoping keeps them working; a required parameter would break them silently.
5. **Proxies.** `Vary: Accept-Encoding` is mandatory, or an intermediary can serve a compressed body to a client that did not ask for one.
6. **Measurement before optimisation.** *Attribute Switchboard's CPU before optimising it* gates the terminal-stream optimisations for good reason. It does **not** gate this: compression is not a guess, the before and after are both measured above, and the change is reversible in one line. Note the relationship so the two are not confused.
7. **Board growth.** After change 2 the archive is still 2,038 rows and still grows. Retention and archival are owned by the storage programme's retention plan; this plan stops the archive being on the critical path, it does not bound it.

## Dependencies

None blocking. Change 1 is independent of every other card on the board and can land alone.

Related, not blocking: *Review Plan Selects The Plan It Was Clicked On* fixes the same class of over-fetching in the Project panel and should adopt whatever column scoping change 2 introduces, rather than inventing a second mechanism.

## Verification Plan

Every step has a measured before-value recorded above.

1. `curl -H 'Accept-Encoding: gzip' -D- .../kanban/plans` returns `Content-Encoding: gzip` and about 300 KB, against 2,826,774 bytes today.
2. `curl` with no `Accept-Encoding` still returns valid uncompressed JSON. Compression is negotiated, never assumed.
3. `Vary: Accept-Encoding` is present on compressed responses.
4. Both hosts: the same check passes against a board served by the extension host and by the standalone host.
5. The static webview assets are compressed too; the PNG icon is not.
6. With change 2, a default board load transfers about 437 rows rather than 2,475, and the Completed column still opens correctly on demand.
7. Existing callers are unaffected: `switchboard plans`, `get-state.js` and a `GET /kanban/plans` with no scope parameter all return what they return today.
8. **The reported scenario.** On an iPad over the tailnet, away from the home network, the board shows cards and column icons together, in about a second. No reload required, and no interval during which a rendered board displays zero cards.
9. The WebSocket deflate contract test still passes, untouched.

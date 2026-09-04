# The Board Renders Every Card It Has Ever Held, So Opening It Takes Long Enough to Look Broken

## Goal

Opening the board on any device should show usable cards in about a second, not after a wait long enough that the operator reloads, inspects the icons and reports a bug. The board must stop building its entire history into the DOM before it shows the columns anyone is looking at.

### Problem analysis

Reported as: *"over remote, it takes so long to render it looks like a bug. A user should not have to wait 10 minutes just to use this."*

It arrived as three symptoms on an iPad over Tailscale, and a fourth that turned out to be the decisive one:

1. The board loaded but showed **no cards**; a reload fixed it.
2. The **column header icons were missing**, then appeared much later.
3. It was slow enough to look broken.
4. **A MacBook Air on the same wifi is also slow** — "not hugely slow, but all the plans are taking forever to load in".

#### The cause is rendering, not transfer

A first pass at this blamed payload size, and that was wrong. The numbers, measured on this machine 2026-09-04:

- The iPad is a **direct** Tailscale peer on the same wifi (`direct 192.168.20.29`), not relayed through DERP.
- The box serves the full board response at **21.9 MB/s** on its own tailnet interface.
- Over that wifi the 2.8 MB response is roughly **1 to 3 seconds** — real, worth fixing, but nowhere near "minutes".

The fourth symptom settles it. A MacBook Air is not a slow client, and it shows the same behaviour. What both devices share is the work the board hands them:

```
GET /kanban/plans  →  2,475 card rows
    CODE REVIEWED   2,038   (82%)
    PLAN REVIEWED     268
    CREATED           105
    BACKLOG            58
    CODER/INTERN        6
```

**The board renders every one of those rows into the DOM, and it does not virtualise.** `grep -oE "virtual|windowing|IntersectionObserver|lazy"` over the shipped board returns nothing. There is no windowing, no lazy column, no cap. Every card in every column becomes real DOM nodes on every full render, and each column body is rebuilt with `innerHTML = ''` followed by a fresh build.

At a conservative dozen-odd DOM operations per card that is on the order of 30,000 to 70,000 operations, synchronously, before the board is usable — and 82% of it is for **Reviewed**, an archival column nobody is reading when they open the board on a phone. That is what "all the plans are taking forever to load in" looks like: the frame paints immediately, then the cards grind in.

It also explains the two symptoms that looked like separate bugs. The board HTML is 29 KB and arrives instantly, so there is a window in which a **fully rendered board displays zero cards** — that is symptom 1, and the reload only appeared to fix it because the second load found a warm cache. The sub-resources, including the icons, compete with that work — symptom 2.

**This grows with use.** It is not a fixed cost to tune once. Every card that reaches Reviewed makes opening the board slower, permanently.

#### Compression is real but secondary

The server sends the response with **no `Content-Encoding` at all**; `grep -nE "gzip|deflate|zlib|content-encoding" src/services/LocalApiServer.ts` returns nothing. Asked explicitly for gzip it still returns all 2,826,774 bytes, where the same payload gzips to **300,118**.

That is worth fixing — it is one middleware for a 9.4x reduction — but it must not be mistaken for the fix. Compression shortens the one-to-three-second transfer. It does nothing about the 2,475 DOM builds, which is the part that reads as broken.

#### Why existing plans do not cover this

- *Review Plan Selects The Plan It Was Clicked On, And Stops Refetching The Whole Board To Do It* fixes the **Project panel's** selection path. Its own tailnet measurement (1.4 MB, 2,555 plans) is now half the current payload. It does not touch the board's render.
- *Dispatch-Analysis Reads the Per-Column Board Mirror* fixes the **agent** read path. The browser board does not use that mirror.

Neither proposes compression, and neither addresses the render volume.

## Metadata

- **Complexity:** 5
- **Tags:** performance, remote-access, standalone, kanban, bugfix

## User Review Required

None.

## Proposed Changes

### 1. Stop rendering the archive — this is the fix

The board must not build 2,038 Reviewed cards to show the operator New and Planned.

- **Scope the fetch by column.** Give `/kanban/plans` an explicit column scope and have the board request only the columns it is about to render. Default to today's behaviour when no scope is passed, so the CLI, `get-state.js` and the agent skills keep working — this must be additive, several shipped clients read this route.
- **Load an archival column on demand.** Reviewed and Completed fetch and render when the operator scrolls to or expands them, not as part of first paint.
- **Cap what one column renders, and say so.** A column holding thousands of cards needs windowing or an explicit "showing N of M" with a way to see the rest. Silently truncating is worse than either.

On today's board this takes first paint from 2,475 cards to about 437, and removes 82% of the DOM work.

### 2. Compress every response

Worth doing on its own merits, and it shortens the transfer from roughly 1–3 seconds to well under one. It does **not** address the render cost above; do not let it be mistaken for the fix or scheduled as a substitute for change 1.

In `src/services/LocalApiServer.ts`, negotiate compression from `Accept-Encoding`: gzip, deflate as fallback, none when the client asks for none.

- Apply to JSON and static webview assets; skip already-compressed formats and bodies under about 1 KB.
- Stream through `zlib.createGzip()` rather than buffering, so a large board does not double in server memory.
- Set `Content-Encoding` and `Vary: Accept-Encoding`; do not set `Content-Length` on a streamed compressed body.
- **Both hosts.** `LocalApiServer` is shared, so this reaches the extension host and standalone together — verify in both rather than assuming, since the two roots construct it with different options.
- The WebSocket path has its own deflate config with a contract test pinning it. Do not touch it, and do not assume it covers HTTP. It does not.

### 3. Paint progressively rather than all at once

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

Every before-value below is measured, on this machine, 2026-09-04.

1. **The reported scenario.** On the MacBook Air and the iPad on the same wifi, the board shows New, Planned and the coding columns with their cards within about a second. No interval in which a rendered board displays zero cards, and no reload needed.
2. **Cards rendered at first paint**: about 437, against 2,475 today. Count DOM nodes matching the card selector after load.
3. **Reviewed opens on demand** and its cards appear when expanded, without blocking anything else.
4. A column holding thousands of cards either windows them or states "showing N of M" with a route to the rest. It never silently truncates.
5. **Compression**: `curl -H 'Accept-Encoding: gzip' -D-` returns `Content-Encoding: gzip` and about 300 KB, against 2,826,774 bytes today; `Vary: Accept-Encoding` is present.
6. `curl` with no `Accept-Encoding` still returns valid uncompressed JSON.
7. **Both hosts** pass 5 and 6 — extension host and standalone.
8. **Existing callers unaffected**: `switchboard plans`, `get-state.js`, and `GET /kanban/plans` with no scope parameter all return what they return today.
9. The WebSocket deflate contract test still passes, untouched.
10. **The growth property is gone**: adding a thousand rows to Reviewed does not change first-paint time. This is the check that proves the cause was the render and not the transfer.

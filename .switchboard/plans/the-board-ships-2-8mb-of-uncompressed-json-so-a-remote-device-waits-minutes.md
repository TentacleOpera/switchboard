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

### 1. Cap what every column sends and renders, and page the rest — this is the fix

**No column is special.** The obvious version of this fix — "don't load the archive" — keys on Reviewed being terminal, which is one operator's habit, not a property of the product. Confirmed against the code: the board has no notion of an archival column at all. Terminality exists only inside the tracker sync services, as a hardcoded `['DONE','COMPLETED','ARCHIVED']` list, and columns carry only an `order` integer. A different operator finishes in Completed, or in Acceptance Tested, or in a custom column, or genuinely works out of a Planned column holding six hundred cards. Any rule that names a column is wrong for someone.

The rule that is right for everyone is uniform:

- **Every column returns its first N rows**, ordered by the board's existing comparator (starred first, then manual `columnOrder`, then the active order-by mode), **plus its true total**. Same N for every column, no exceptions, no per-column configuration.
- **The column header shows the honest count** — the total, not the loaded count — and states "showing N of M" when they differ. A silently truncated column is worse than a slow one, because the operator cannot tell work is missing.
- **Paging is on demand.** Scrolling a column, or an explicit control in it, fetches the next page and appends. Nothing else on the board blocks while it does.
- **N is a single number, not a settings matrix.** Pick a default that makes first paint fast on a phone (50 is a reasonable starting point, to be confirmed by measurement) and expose it as one value if it needs exposing at all. Do not build a per-column policy UI.

This satisfies all three constraints at once. It is **habit-agnostic**, because it never asks which column is terminal. It **assumes no workflow**, because it needs no reviewer, no completion step and no discipline. And it **scales for a genuinely busy board**: an operator with five hundred live cards in Planned gets fifty rendered, a header saying five hundred, and a board that opens as fast as an empty one.

It also fixes the growth property, which is the real defect. First-paint cost stops being a function of how much work you have ever done.

**Explicit non-goals**, because each is a tempting wrong turn:

- Do not key on column id, on `order`, or on the sync services' terminal-column list.
- Do not add a per-column "is archival" flag. That pushes the operator's habit into configuration and produces a board that is fast only when configured correctly.
- Do not make the cap conditional on being remote. A local board with three thousand cards has the same defect; loopback merely hides it.

**Where virtualisation fits.** Rendering only the rows in the viewport is the deeper fix and would make even a single page free. It is deliberately not proposed here: it does nothing for transfer, and it interacts badly with the board's drag-and-drop, which needs real elements as drop targets. If a fifty-card page still feels heavy after this lands, virtualise then, with a measurement to justify it.

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

## Related but deliberately separate: reducing accumulation

The operator's own diagnosis of *why* their Reviewed column holds two thousand cards is that nothing moves a card on from it — and the idea raised is that when the reviewer posts completion, the card could be marked complete automatically.

That is worth doing and it is **not part of this plan**, for two reasons the operator named. It "won't work for everyone": plenty of setups have no reviewer seat, review outside Switchboard, or want a deliberate human gate before a card is called done. And it addresses accumulation, not speed — a board that accumulates more slowly is still unusable once it accumulates.

If it is built, it must be **opt-in**, and this plan must not depend on it. The test is simple and worth stating: with the completion behaviour switched off and a column holding three thousand cards, the board must still open in about a second. If that is not true, this plan has not done its job.

Filed as its own card rather than absorbed here.

## Edge-Case & Dependency Audit

1. **Do not gzip an already-gzipped body.** Check for an existing `Content-Encoding` before wrapping.
2. **Range requests and streaming routes.** The terminal log endpoints and any `Range` responses must be excluded from compression, or byte offsets stop meaning what the client thinks.
3. **The tailnet listener is a separate `http.Server`.** Compression must be applied at the shared request handler, not on one listener, or the loopback path is fast and the remote path — the only one that needs it — is not. This is the exact shape of defect the tailnet Host-header bug had.
4. **The CLI and the agent skills read this route.** `switchboard plans`, `get-state.js` and the orchestration skills all call it. Additive scoping keeps them working; a required parameter would break them silently.
5. **Proxies.** `Vary: Accept-Encoding` is mandatory, or an intermediary can serve a compressed body to a client that did not ask for one.
6. **Measurement before optimisation.** *Attribute Switchboard's CPU before optimising it* gates the terminal-stream optimisations for good reason. It does **not** gate this: compression is not a guess, the before and after are both measured above, and the change is reversible in one line. Note the relationship so the two are not confused.
7. **Board growth.** The archive still grows. Retention and archival are owned by the storage programme's retention plan; this plan stops the archive being on the critical path, it does not bound it.

## Dependencies

None blocking. Change 1 is independent of every other card on the board and can land alone.

Related, not blocking: *Review Plan Selects The Plan It Was Clicked On* fixes the same class of over-fetching in the Project panel and should adopt whatever column scoping change 2 introduces, rather than inventing a second mechanism.

## Verification Plan

Every before-value is measured on this machine, 2026-09-04. The last three are the ones that prove the fix is general rather than fitted to one board.

1. **The reported scenario.** On the MacBook Air and the iPad, on the same wifi, the board shows its columns with cards within about a second. No interval in which a rendered board displays zero cards, and no reload needed.
2. **Rows at first paint**: capped per column, roughly 50 each, against 2,475 total today.
3. **Counts stay honest.** Every column header shows its true total, and a capped column says "showing N of M". Compare each against `SELECT kanban_column, COUNT(*)` in the database.
4. **Paging works** in both directions and appends without re-rendering the board.
5. **Compression**: `curl -H 'Accept-Encoding: gzip' -D-` returns `Content-Encoding: gzip` and about 300 KB against 2,826,774 bytes today, with `Vary: Accept-Encoding`. Without the header, valid uncompressed JSON.
6. **Both hosts** pass 5 — extension host and standalone.
7. **Existing callers unaffected**: `switchboard plans`, `get-state.js`, and `GET /kanban/plans` with no scope parameter return what they return today.
8. The WebSocket deflate contract test still passes, untouched.

**The three that prove it generalises:**

9. **Column-agnostic.** Move the bulk of the cards from Reviewed into Planned and reopen. First-paint time does not change. A fix that only helps when the big column is Reviewed fails here.
10. **Growth-proof.** Add a thousand rows to any column. First-paint time does not change. This is the check that distinguishes the render cause from the transfer cause.
11. **Workflow-independent.** With no reviewer seat configured and no completion automation, a board holding three thousand cards still opens in about a second.

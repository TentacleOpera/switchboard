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

#### Two costs, not one — and the split is not yet measured

This plan has been wrong twice about the cause, so the reasoning is recorded rather than asserted.

The first pass blamed payload size alone. That was wrong: the iPad is a **direct** Tailscale peer on the same wifi, and the box serves the whole response at **21.9 MB/s** on its own tailnet interface.

The second pass blamed rendering alone, on the strength of the MacBook Air also being slow. That over-corrected, and the operator's next observation is the counter-evidence: **the board on localhost is much faster.** Render cost is identical on both paths for a given device, so if rendering were the whole story, localhost would be just as slow. It is not.

**What is measured, on this machine, 2026-09-04:**

| | Loopback | To the iPad over wifi |
| :--- | ---: | ---: |
| Round-trip time | 0.06 ms avg | **109.7 ms avg, 195 ms max, 60.7 ms jitter** |
| All five board requests, server-side | 0.20 s | 0.12 s |
| Board JSON on the wire | 2,826,774 B | 2,826,774 B |

The server is not the problem on either path. What the remote path adds is:

- **Five sequential round trips** — the HTML, `shell.js`, `sharedDefaults.js`, the manifest, then the data — at ~110 ms each, so roughly **0.55 s of pure waiting before any useful byte**, against effectively zero locally.
- **2.8 MB of uncompressed transfer**, which on real wifi to a tablet is **1.1 to 4.5 s**.

That is 1.5 to 5 seconds the local board never pays, which is exactly the difference the operator describes.

**The jitter is the client's radio, and it amplifies both costs.** Re-measured with the iPad on mains power: RTT improved from 109.7 ms average to 62.8 ms, but the spread stayed wide — 4.6 ms minimum, 153 ms maximum, 45 ms deviation. The minimum proves the path is capable; the variance is the device's wifi behaviour and is not Switchboard's to fix. What *is* Switchboard's is how much it exposes itself to that variance: five sequential requests and 2.8 MB across a link that intermittently stalls for 150 ms is the worst possible shape. Fewer round trips and a tenth of the bytes shrink the exposure, which is why both changes below matter more on a jittery link than the averages suggest.

It also explains the intermittency. With RTT swinging between 5 ms and 195 ms, the waterfall is unpredictable, which is why the same load sometimes shows a rendered board with no cards and sometimes does not.

**And the render cost is real and additive.** The board builds every one of 2,475 rows into the DOM and does not virtualise — `grep -oE "virtual|windowing|IntersectionObserver|lazy"` over the shipped board returns nothing, and each column body is wiped with `innerHTML = ''` and rebuilt. 2,038 of those rows are in one column. That cost is paid identically on localhost and remotely, which is why it does not explain the *difference*, and why the MacBook Air is slow even so.

**The honest position: both costs are large, and the split between them has not been measured.** Doing so needs a browser timing on the actual devices, which is change 0 below. Every number above is server-side or network-level; none of it is a render timing.

#### Environment note: the network this was measured on is faulty, and that matters for the next measurement

Every remote number in this plan was taken across a **known-bad router**, which the operator is replacing.

The decisive evidence is a ping to the box's own gateway — one hop, no client device involved:

```
gateway     min 3.5   avg 53.1   max 189.0   jitter 64.0 ms
macbook     min 6.3   avg 56.4   max 168.3   jitter 56.2 ms
ipad        min 4.6   avg 62.8   max 153.5   jitter 45.1 ms
loopback    min 0.03  avg 0.06   max 0.09    jitter 0.03 ms
```

All three remote figures share one profile because they share one cause. The box itself is **on wifi** (`enp0s31f6` down, no cable; `wlp4s0` at 52 Mb/s, −58 dBm, 52/70 quality, 71,111 misc errors), so every byte the board serves crosses that link. The iPad and the MacBook are not slow; they inherit it.

**Two consequences for whoever codes this.**

First, **do not re-derive the cause from these numbers**. They are real and they were the operator's lived experience, but a large share of the remote cost here is environmental. Re-measure on the replacement router before concluding anything about the split between transfer and render.

Second, **this does not retire the plan — it sharpens why it matters**. Five sequential round trips and 2.8 MB of uncompressed JSON is the worst possible shape for a link that intermittently stalls, and a board that is only usable on a good network is not a board you can open from a phone. The fixes below reduce exposure to any bad link, and on a clean one they are what takes first paint from seconds to well under one. What changes after the router is which fix dominates, not whether they are wanted.

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

### 0. Measure the split first — one browser timing, before either fix

Open the board on the MacBook and the iPad with the browser's performance panel, and record three numbers for each: time to first byte of the data response, time until that response has fully arrived, and time from there until the last card is in the DOM.

This is cheap and it settles which of the two changes below matters more on which device. It also gives the regression baseline that change 4 makes permanent. **Do not skip it** — this plan has already been wrong twice by reasoning from server-side numbers about a client-side experience.

**Take this measurement on a healthy network** — see the environment note below. Measured on the network as it was when this plan was written, everything is dominated by the router and the split cannot be seen.

### 1. Cap what every column sends and renders, and page the rest

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

### 2. Compress every response — this is what closes the local-versus-remote gap

Not secondary. Compression is the change that specifically targets the cost the local board does not pay: 2.8 MB becomes about 300 KB, taking the transfer from 1.1–4.5 s to roughly 0.1–0.5 s on the same link. Change 1 helps every device including localhost; this one is why remote feels different from local.

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

## Asked and answered: does the local-replica plan already cover this?

It does not, and the distinction is worth writing down because the idea is a reasonable one to have twice.

Two existing cards are in the neighbourhood, both parked in Backlog behind the storage programme:

- **A libSQL shared store, hosted on Turso or self-hosted sqld** proposes exactly a local database that syncs: an **embedded replica**, a local SQLite file as the read path, writes forwarded to the remote, periodic `.sync()`, with offline as the default mode rather than a degraded one.
- **Make the orphan-branch board snapshot bidirectional** carries board state in a git branch.

Neither helps here, for two independent reasons.

**The replica is on the wrong side of the wire.** That plan's local file lives with the *sidecar*, so the Switchboard process reads locally instead of round-tripping to Turso. Its own text is explicit that the remote's job is "arbitration and durability, not query serving". The iPad and the MacBook are still browsers talking HTTP to that server, and they still receive the same 2,475 rows.

**Even a replica on the device would not fix the symptom.** The measured bottleneck is the browser building every card into the DOM, not the bytes arriving. A local store removes a one-to-three-second transfer and leaves the render untouched — a large piece of machinery that does not fix the reported problem. The same is true of *Board state you can carry*, which is a file export for machine migration, not a live read path.

For completeness: the PWA card, *The board is reachable only by typing a tailnet address into Safari*, deliberately ships **no service worker, no offline and no caching**, with a stated reason — a stale shell served from cache after an update is a nasty failure. So there is no client-side cache to lean on either.

**When a local replica would earn its place:** genuine offline use, a genuinely distant link where round-trip latency dominates, or repeated loads that should not refetch. None of those is the case reported here, where the device is a metre away on the same wifi.

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

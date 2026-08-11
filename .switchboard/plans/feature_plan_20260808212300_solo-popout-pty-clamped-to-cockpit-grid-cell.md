# Solo Terminal Pop-Out Renders at the Cockpit Grid Cell's Size Because the Shared PTY Takes the Minimum of Every Attached Viewport

## Goal

Make a single-terminal pop-out fill its own window. Today the pop-out opens at 900×700 and the agent CLI inside it draws at the width of the 3×3 grid cell the terminal still occupies in the cockpit — which defeats the entire purpose of popping a terminal out, whose one job is "let me see this one properly".

**This is about `?solo=` mode itself, not about which button opens it.** The entry point is being relocated by other in-flight work (see *Reconcile Before Building*); the defect is in the shared-pty sizing rule and is identical either way.

### Problem

Opening `/terminals?solo=<name>` in a named 900×700 window — today from a terminal icon in the shell's left rail (`src/webview/shell.js:371-426`) — gives you solo mode. Solo mode does everything right on the client: it hides the sidebar and toolbar, forces `currentLayout = effectiveLayout = '1'`, and pins the terminal into the single pane (`src/webview/terminals.js:422-430`, CSS at `src/webview/terminals.html:1363-1376`). The xterm in that window fits to the full pane and reports a large `cols`/`rows`.

It still draws small, because the **pty** — not the xterm — decides where the CLI wraps its output, and the pty is shared by every attached client.

### Root cause

`TerminalWsGateway.reconcileTerminalSize` sizes the shared pty to the **minimum** of every attached client's reported viewport:

```ts
let cols = Infinity;
let rows = Infinity;
for (const c of this.clients) {
    if (c.terminalName !== terminalName || !c.reportedSize) { continue; }
    cols = Math.min(cols, c.reportedSize.cols);
    rows = Math.min(rows, c.reportedSize.rows);
}
```
— `src/standalone/terminalWsGateway.ts:996-1006`

That min rule is deliberate and it is correct for the case it was written for: it is the tmux rule, and it exists to stop a *hidden* 0×0 client from squashing the visible one (the comment block at `:960-987` records that history). But it makes every viewer a veto. When the operator pops a terminal out of a 3×3 grid, the cockpit pane for that same terminal is still attached, still rendered, and still reporting roughly 60×15 — so the pty stays at 60×15 while the pop-out's xterm sits at ~140×45. The CLI wraps its UI at 60 columns and the pop-out shows a small block of text in a large empty window. That is exactly the reported symptom: *"it opens in the same size of the individual grid component in the terminals pane."*

There is a second, compounding defect in the same path. `client.reportedSize` is **sticky**: it is only ever written, never cleared. `fitAndReportSize` returns early when the container has no box (`src/webview/terminals.js:182-183`), so a client that becomes hidden never sends `rendered: false` — it simply stops sending. `applyResize` has a `rendered === false` arm (`:983-985`) but it returns without clearing `reportedSize`, and nothing else clears it either. So switching the shell to another panel does **not** release the cockpit's clamp: the last size it reported keeps constraining the pty for the life of that WebSocket.

The one thing that does release it is closing the socket (`ws.on('close')` → `reconcileTerminalSize`, `:948-953`) — which is why the pop-out looks correct if you first close the terminals cockpit tab, and never otherwise.

### The third defect, found during this improve pass

The two defects above are real, but a fix that only addresses them is incomplete in a way that *looks* complete. There is no client-side path that re-casts a withdrawn size vote:

- The shell mounts every panel as an iframe and toggles it with `display` (`src/webview/shell.js:5-7`, `selectPanel` at `:32-44`; `.panel-frame.is-active { display: block; }` — `src/webview/shell.html:153`). A document inside a `display:none` iframe is not rendered, so it gets no rendering opportunities and its `ResizeObserver` callbacks are not delivered (confirmed — see *Platform Behaviour*, fact 2). Any release wired **only** to the container's `ResizeObserver` therefore cannot fire for the exact scenario named above — the shell switching panels.
- Worse, on the way back the observer stays silent too: the child's pipeline was frozen while hidden, so its `lastReportedSizes` still holds the pre-hide dimensions, the restored box matches them exactly, and no callback is queued (fact 3). And `startFitLadder` — the observer's normal downstream — only calls `fitAndReportSize` on a verified `'mismatch'` verdict (`src/webview/terminals.js:3443-3450`); a pane that returns at the *same* size inspects as `'ok'` and reports nothing.

So a naive release is a **net regression**: the cockpit withdraws its vote once and never gets it back, and from then on the pty is sized by whichever other viewer happens to be attached. The release must be paired with an explicit, ladder-independent re-cast, and it needs a carrier that works across the iframe boundary.

## Reconcile Before Building

**The pop-out entry point is moving, and this plan is unaffected by the move.** `terminal-peek-temporary-fullscreen.md` (feature *Terminals Pane: Groups, Peek, and Bulk Terminal Creation*, `9e7c314d`) repoints the shell rail click at an in-window peek and relocates single-terminal pop-out to a control in each pane header, with the shell still owning `window.open` so `popoutWindows` keeps its theme fan-out. That plan is explicit that `?solo=` survives the move — *"this change relocates the entry point, it does not retire the mode"* — and requires `src/test/terminal-solo-popout-contract.test.js` to keep passing.

Consequences for this plan:

> **Superseded:** "**No file overlap.** The fix lives in `src/standalone/terminalWsGateway.ts` … and in `fitAndReportSize` / the container `ResizeObserver` in `src/webview/terminals.js`. Peek touches neither — it edits the render path, the sidebar rows and `shell.js`. Runnable in either order, and in parallel with the whole feature."
> **Reason:** No longer true. The third defect above forces a small edit to `shell.js` (`selectPanel` must tell each panel iframe when it is hidden or shown — a `ResizeObserver` inside a `display:none` iframe cannot self-detect it). Peek also edits `shell.js`. The PRD's orchestration rule is one agent stream per file, so the claim of zero overlap would have licensed a same-file parallel edit that collides.
> **Replaced with:** the bullet below.

- **One file overlaps: `shell.js`.** The gateway change (`src/standalone/terminalWsGateway.ts`) and the client sizing changes (`src/webview/terminals.js`) do not collide with Peek, which edits the render path and the sidebar rows. But this plan adds ~8 lines to `shell.js`'s `selectPanel`, and Peek repoints the rail click handler in the same file. Different functions, same file — per the project PRD's "one agent stream per provider file", **serialise the `shell.js` edit** with Peek rather than running both concurrently. Either order works; whoever lands second rebases their hunk.
- **The relocation makes this defect strictly worse, so do not defer it behind Peek.** Today the rail can pop out a terminal that is seated in no pane — no competing voter, correct size, by accident. A pane-header control can only ever pop out a terminal that *is* seated in a cockpit pane, so after Peek **every** pop-out has a grid-cell client clamping it and the bug becomes unconditional.
- **Test-file etiquette.** Peek requires `terminal-solo-popout-contract.test.js` to pass *unmodified by Peek*. This plan legitimately extends that file with sizing contracts; that is compatible in either landing order because Peek changes nothing this plan asserts. If Peek lands first, re-run the file before adding to it.
- Line references below were verified against the working tree on 2026-08-08, which carries uncommitted local changes to `terminals.js` and `shell.js`. Re-grep the symbols rather than trusting a line number.

## Metadata

> **Superseded:** **Complexity:** 5
> **Reason:** The improve pass added a third defect (no re-cast path for a withdrawn vote), which pulls a fourth file into the change (`shell.js`) and adds a cross-document message contract with a directional invariant — release on hide *and* re-cast on show, or the cockpit is permanently disenfranchised. That is a multi-file coordination with a real regression mode, not a contained two-file fix.
> **Replaced with:** **Complexity:** 6

- **Complexity:** 6
- **Tags:** frontend, backend, ui, bugfix
- **Project:** Browser Switchboard

## User Review Required

None.

## Complexity Audit

### Routine

- Adding one optional query parameter to the `/ws/terminal` upgrade URL, alongside the `token` and `lastSeq` parameters already there (`terminals.js:4749-4759`, parsed at `terminalWsGateway.ts:789-816`).
- Adding one optional property to `ClientState` and threading it through `setupClient` — `lastSeq` is the existing precedent for exactly this.
- Clearing `reportedSize` on an explicit relinquish — a two-line change in an arm that already exists.
- Posting a panel-visibility message from `selectPanel`; the shell→terminals-iframe `postMessage` channel and its origin-checked receiving arms already exist (`shell.js:387-413`, `terminals.js:582-619`).

### Complex / Risky

1. **Changing the pty-sizing rule is a behaviour change for multi-viewer setups.** The min rule is load-bearing: the comment at `terminalWsGateway.ts:960-987` documents a shipped bug (hidden 0×0 tabs squashing the visible terminal to 24 rows) that it fixed. The change must therefore be *additive* — the min rule stays as the default and is only narrowed to a smaller candidate set when a primary viewer declares itself. With no primary attached, the arithmetic must be byte-for-byte what it is today.
2. **A wider pty makes the cockpit's small pane show wrapped output while the pop-out is open.** This is intrinsic to a shared pty: something has to lose. The pop-out winning is the whole point of the feature, and the state self-heals the moment the pop-out closes (`ws.on('close')` already reconciles). Called out here so it is a decision, not a surprise.
3. **The vote-withdrawal mechanism has a regression mode that is worse than the bug it fixes.** A withdrawn vote that is never re-cast permanently removes a real viewer from the sizing calculation. The re-cast must not be routed through `startFitLadder`, which reports only on a `'mismatch'` verdict and therefore stays silent for a pane that returns at its previous size. `sizeVoteActive` is the single source of truth for "does the gateway currently hold a size from this client", and every path that clears it must have a matching path that sets it.

## Edge-Case & Dependency Audit

### Race Conditions

- **Panel shown before its layout is computed.** The shell flips `display` and posts `panelVisibility` in the same task; the message may be delivered before the child document has laid out, so a naive `getBoundingClientRect()` in the handler can still read 0×0. The re-cast is therefore scheduled inside `requestAnimationFrame` — rAF callbacks are a step of "update the rendering" and are paused outright for a `display:none` iframe (*Platform Behaviour*, fact 4), so the callback is physically incapable of running before the panel is genuinely rendered. This is a correctness gate, not a delay hack, and it must not be replaced with a `setTimeout` — timers keep running in a hidden iframe and would fire against an unrendered document.
- **Withdrawal delivered to an already-hidden document.** The message arrives *after* the parent has set `display:none`, but `postMessage` delivery is a task-queue operation and is unaffected by the rendering pause (fact 4), so the arm does run. It must therefore send the withdrawal **synchronously** — wrapping that direction in rAF too would be the one mistake that makes the whole mechanism silent.
- **Vote re-cast vs. fit ladder.** Both may run for the same entry in the same frame. `fitAndReportSize` is idempotent (it fits, then sends the current dimensions) and `reconcileTerminalSize` is a pure recompute over all voters, so a duplicate frame costs one extra `terminal.resize` to the same value. Acceptable; do not add suppression logic for it.
- **Pop-out attaches before or after the cockpit.** Irrelevant by construction: `reconcileTerminalSize` recomputes from the full client set on every frame and on every close, so arrival order cannot leave a stale winner.
- **Reconnect mid-transition.** A socket that dies and re-dials starts a fresh `ClientState` server-side with no `reportedSize`, so `sizeVoteActive` must be reset to `false` on the client in the same block that zeroes `pendingAckChars` / `awaitingReplayFrame` (`terminals.js:4735-4747`). Without that reset, the client believes it holds a vote it never cast on the new socket and the re-cast guard suppresses the first report.

### Security

- The `solo` handshake parameter is an unauthenticated *hint* about presentation, gated behind the same token check as every other `/ws/terminal` upgrade (`authorizeWsUpgrade`, `:780-787`). It grants no data access and no new capability — the worst a forged `solo=1` can do is make a terminal the caller is already authorised to read wider than it would otherwise be. No new attack surface.
- The new `panelVisibility` message is origin-checked in the receiving arm (`event.origin !== location.origin` → return), matching the existing `focusTerminal` / `clearTerminalBadge` arms, and is posted with `location.origin` as the explicit `targetOrigin` rather than `'*'`.

### Side Effects

- **Older clients / no primary attached.** A client that never sends `solo=1` is treated as non-primary. If no client for a terminal claims primary, the candidate set is *all* clients and the result is identical to today's min. Back-compat is by construction, not by a shim.
- **Two pop-outs of the same terminal.** Both claim primary; the min is taken across the two primaries. Same tmux rule, one tier up. Correct, and no special case needed.
- **Pop-out closed.** `ws.on('close')` / `ws.on('error')` already call `reconcileTerminalSize` (`:948-953`). With no primary left, the candidate set widens back to all clients and the cockpit pane regains control. No new teardown code.
- **Pop-out opened but never focused / immediately hidden by the OS.** It is still rendered (it has a box), so it still reports and still claims primary. That is intended — the user asked for it to be sized for that window.
- **The NEW WINDOW button (`/terminals` with no `?solo=`).** Not primary. It is a full second cockpit, not a single-terminal viewer, and claiming primary there would let a second grid clamp the first. The `solo` handshake flag is derived from `soloTerminalName` / the `is-solo` body class, never from "is this a top-level window" — `is-standalone` is set for the NEW WINDOW cockpit too (`terminals.js:435-437`).
- **Popping out a terminal that is seated in a pane is the *normal* case, not the exception.** It is already the common case from the rail, and once the pop-out control moves into the pane header (`terminal-peek-temporary-fullscreen.md`) it is the only case — you cannot open a pane-header control for a terminal that occupies no pane. The primary rule must therefore be the default behaviour, never something gated on "is the terminal also seated"; a heuristic that only kicks in for unseated terminals would fix nothing after the relocation.
- **Peek's hidden panes.** Peek hides sibling panes with `display: none` while keeping their xterm containers mounted. Those containers are in a *rendered* document, so the container `ResizeObserver` does fire with a 0×0 box (*Platform Behaviour*, fact 1), `isRendered` returns false, and `releaseSizeVote` runs — a peeked terminal gets the full grid area's pty size for free. Un-peeking restores a *different* box size, so the observer fires again and the re-cast guard re-votes. Worth confirming during Peek's own verification that the ladder converges on both transitions.
- **Pane unassign / reassign at an identical size.** The container loses its box (release fires), then regains one of exactly the same dimensions. `inspectPaneFit` would return `'ok'` and the ladder would report nothing — which is precisely why the re-cast is gated on `!entry.sizeVoteActive` and calls `fitAndReportSize` directly rather than going through `startFitLadder`.
- **`rendered: false` relinquish is new outbound traffic.** It must be sent at most once per transition into "no box", not on every ResizeObserver tick, or a hidden panel becomes a chatty client. Gate on the per-entry `sizeVoteActive` flag.
- **A relinquish that empties the candidate set.** `reconcileTerminalSize` already returns early when no client has a `reportedSize` (`:1007-1009`, "leave the pty at whatever it already is"). Clearing the last vote therefore leaves the pty alone rather than inventing a size — correct, and no new guard needed.
- **`hello` frame's `cols`/`rows`.** Sent at attach (`:861-874`) and read by no sizing path on the client. Untouched.
- **Persisted state.** None. Nothing in this change reaches a settings key, the DB, or a file — per CLAUDE.md's migration rule there is nothing to migrate.
- **Other panels receive `panelVisibility`.** `selectPanel` posts to every mounted frame. Board / Project / Design / Setup have their own `message` listeners with `if/else if` chains over known types; an unrecognised type falls through every arm and is a no-op. No panel needs a change.

### Dependencies & Conflicts

- **Extension-host path.** The pty gateway runs only in the standalone pty host child (`src/standalone/ptyHost.ts:45`, `src/standalone/bootstrap.ts:1640`); `pty-route-surface-contract.test.js:229` actively asserts `TaskViewerProvider` never constructs one. There is no second copy of this sizing code to keep in parity.
- **Single resize-frame sender.** `fitAndReportSize` (`terminals.js:181-220`) is the only site in the codebase that emits `{ t: 'resize', … }` — verified by grep. That is what makes the withdrawal frame unambiguous: any `resize` frame the gateway sees came from this one function.
- **Contract tests that read this source.** `src/test/terminal-solo-popout-contract.test.js` and `src/test/terminal-pane-fit-verification-contract.test.js` are source-text tests over `terminals.js`. The fit test asserts `resyncPaneRenderer` contains **no** `t: 'resize'` and that `fitAndReportSize` is reached only from the ladder's verified-mismatch branch (`:92`, `:99-100`). The new re-cast call site is in the `ResizeObserver` and in the `panelVisibility` arm — neither is `resyncPaneRenderer` nor the ladder — so those assertions still hold. Re-read them before editing rather than assuming.
- **Peek** (`terminal-peek-temporary-fullscreen.md`) — shares `shell.js` only; see *Reconcile Before Building*.

## Dependencies

None. No prior session output is required to start this work.

## Platform Behaviour — Confirmed

The design rests on four platform facts that are **not** derivable from this codebase. All four were confirmed by web research on 2026-08-09 (CSS Resize Observer Level 1 §3.4 / §3.4.8; HTML Standard §8.1.7 "update the rendering"; Chromium [crbug/958475](https://crbug.com/958475); Gecko and WebKit behave identically). They are recorded here because each one is load-bearing — an implementer who "simplifies" against any of them reintroduces the bug.

1. **A `ResizeObserver` on an element in a *rendered* document DOES fire when that element (or an ancestor) is set to `display:none`, or is removed from the DOM**, reporting `0` for `contentRect`, `borderBoxSize`, `contentBoxSize` and `devicePixelContentBoxSize`. Per §3.4.8 an element with no layout box computes to `0`, which differs from a non-zero `lastReportedSizes`, so `isActive()` is true and the callback is queued. ⇒ **the container-`ResizeObserver` release path in change 2 works** for Peek's hidden sibling panes and for pane unassignment.
2. **A `ResizeObserver` inside an iframe does NOT fire when the PARENT sets `display:none` on the `<iframe>` element.** *Gather* / *broadcast active resize observations* are sub-steps of HTML's "update the rendering", and a `display:none` iframe has no rendering opportunities, so those steps never run. ⇒ **the container observer cannot see a shell panel switch; the `panelVisibility` message in change 3 is required, not belt-and-braces.**
3. **Nor does it fire on the way back**, when the iframe returns to `display:block` at an unchanged size. Because the child's rendering pipeline was frozen, `lastReportedSizes` was never updated to `0×0`; on restore the computed box equals `lastReportedSizes`, `isActive()` is false, and nothing is queued. ⇒ **the message must carry BOTH directions.** A hide-only message is the permanent-disenfranchisement regression.
4. **`requestAnimationFrame` and `IntersectionObserver` are also paused in a `display:none` iframe** (both are steps of "update the rendering"), while **task queues — `setTimeout` and `postMessage` delivery — keep running**, subject only to background-timer throttling. ⇒ two consequences the code depends on: the `panelVisibility` message **is** delivered to a hidden iframe (so the withdrawal must be sent synchronously in that arm, with no rAF wrapper); and wrapping the re-cast in `requestAnimationFrame` is a genuine correctness gate rather than a delay hack — that callback is physically incapable of running before the document is rendered again.

**Rejected alternative:** the same research surfaced two in-iframe self-detection signals — `window.innerWidth === 0` and `document.body.checkVisibility()` — either of which could be polled on a `setInterval`. Both are rejected. They require polling for a state transition the parent already knows about synchronously, and the parent→child message channel this panel needs already exists (`shell.js:387-413`). Note also that the Page Visibility API is **not** an option: `document.visibilityState` inside an iframe reflects the top-level tab, and does not change when the parent toggles the iframe's `display`.

## Adversarial Synthesis

Key risks: narrowing the pty-sizing rule can regress the shipped fix that stops hidden 0×0 clients squashing a visible terminal; a size vote that is withdrawn but never re-cast permanently removes a real viewer from the calculation, which is a worse bug than the one being fixed; and the release path depends on `ResizeObserver` semantics in hidden documents that the codebase cannot confirm. Mitigations: the primary rule is strictly additive (no primary attached ⇒ candidate set is every client ⇒ identical arithmetic), primacy is fixed at handshake time so no later frame can grant or revoke it, `sizeVoteActive` is the single source of truth with a matching set for every clear, and the re-cast bypasses `startFitLadder` (whose `'ok'` short-circuit would otherwise swallow it) and is scheduled in `requestAnimationFrame` so it can only run in a genuinely rendered document.

## Proposed Changes

### 1. `src/standalone/terminalWsGateway.ts` — primary viewers win; a relinquish actually clears the vote

**Context.** `reconcileTerminalSize` (`:995-1012`) is the only writer of the pty size after spawn. `applyResize` (`:983-993`) is its only caller from the message path; `ws.on('close')` / `ws.on('error')` (`:950-960`) are the others. `handleUpgrade` (`:779-821`) already parses `name`, `token` and `lastSeq` from the upgrade URL and threads `lastSeq` into `setupClient`.

**Logic.** Primacy is a property of the *connection*, not of a measurement, so it is read once at handshake and never mutated afterwards. Sizing then runs three rules in order: an unrendered client gets no vote; primaries outrank non-primaries; the min applies within whichever set won.

> **Superseded:** primacy carried per-frame — `fitAndReportSize` stamps `primary: document.body.classList.contains('is-solo')` on every resize frame and `applyResize` assigns `client.primary = parsed.primary === true` on each one.
> **Reason:** It writes connection-scoped state from a per-measurement payload. Any resize frame that omits the field silently demotes a pop-out back to a grid-tier voter, so the correctness of the whole feature rests on every present and future sender remembering to stamp it. (There is exactly one sender today, which makes the hazard latent rather than live — but it is invisible when it lands.) It also re-derives an immutable fact on every keystroke-triggered fit, and it cannot be tested server-side without simulating client frames.
> **Replaced with:** primacy read once from the upgrade URL (`?solo=1`) and stored on `ClientState` at `setupClient`. A solo window cannot become a grid mid-connection, so a value that is set once and never revoked models the domain exactly; the resize frame keeps its current shape; and `applyResize` loses a mutation entirely.

**Implementation.**

`ClientState` (`:148-157`):

```ts
interface ClientState {
    ws: WebSocket;
    terminalName: string;
    isAlive: boolean;
    highWaterStart?: number;
    unackedChars: number;
    /** Last size this client reported FROM A RENDERED VIEWPORT. Undefined until it
     *  has one — a client with nothing on screen does not get a vote. See applyResize. */
    reportedSize?: { cols: number; rows: number };
    /** This connection is a single-terminal viewer (a `?solo=` pop-out window), declared
     *  once on the upgrade URL. When any primary is attached, only primaries vote on the
     *  pty size. Immutable for the life of the socket: a solo window cannot become a grid. */
    primary: boolean;
}
```

`handleUpgrade` (`:815-820`) — read it beside `lastSeq`:

```ts
        const rawLastSeq = Number(reqUrl.searchParams.get('lastSeq'));
        const lastSeq = Number.isFinite(rawLastSeq) && rawLastSeq > 0 ? rawLastSeq : 0;
        // Declared by the client at connect time, never per-frame: a `?solo=` pop-out
        // window exists BECAUSE the operator wants this one terminal at that window's
        // size, and it cannot stop being one while the socket lives.
        const primary = reqUrl.searchParams.get('solo') === '1';

        this.wss.handleUpgrade(req, socket, head, (ws) => {
            this.setupClient(ws, terminal, lastSeq, primary);
        });
```

`setupClient` (`:823-830`):

```ts
    private setupClient(ws: WebSocket, terminal: ExtendedTerminalHandle, lastSeq = 0, primary = false): void {
        const client: ClientState = {
            ws,
            terminalName: terminal.name,
            isAlive: true,
            unackedChars: 0,
            primary,
        };
```

`applyResize` (`:983-993`):

```ts
    private applyResize(client: ClientState, parsed: { cols: number; rows: number; rendered?: boolean }): void {
        if (parsed.rendered === false) {
            // A vote WITHDRAWN, not merely absent. Without clearing, the last size a
            // client reported before it was hidden clamps the pty for the life of the
            // socket — which is how a hidden cockpit grid cell kept a solo pop-out at
            // the grid cell's width. Note this arm returns BEFORE the degenerate-size
            // warning below: the withdrawal frame legitimately carries 0x0.
            if (client.reportedSize) {
                client.reportedSize = undefined;
                this.reconcileTerminalSize(client.terminalName);
            }
            return;
        }
        if (parsed.cols < 1 || parsed.rows < 1) {
            console.warn(`[TerminalWsGateway] Ignoring degenerate resize ${parsed.cols}x${parsed.rows} for ${client.terminalName}`);
            return;
        }
        client.reportedSize = { cols: parsed.cols, rows: parsed.rows };
        this.reconcileTerminalSize(client.terminalName);
    }
```

`reconcileTerminalSize` (`:995-1012`) — narrow the candidate set, keep the min rule inside it:

```ts
    private reconcileTerminalSize(terminalName: string): void {
        const terminal = this.fleetService.get(terminalName);
        if (!terminal) { return; }

        const voters = Array.from(this.clients)
            .filter(c => c.terminalName === terminalName && c.reportedSize);
        // A solo pop-out exists BECAUSE the operator wants this terminal at that
        // window's size. Every other viewer of it is a thumbnail. So when any
        // primary is attached, the grid cells stop voting entirely; the min rule
        // then applies among the primaries (two pop-outs of one terminal is the
        // same tmux situation, one tier up). With no primary attached the candidate
        // set is every client and the arithmetic is exactly what it was.
        const primaries = voters.filter(c => c.primary);
        const candidates = primaries.length > 0 ? primaries : voters;

        let cols = Infinity;
        let rows = Infinity;
        for (const c of candidates) {
            cols = Math.min(cols, c.reportedSize!.cols);
            rows = Math.min(rows, c.reportedSize!.rows);
        }
        // Every attached client is still headless (or the last one with a viewport
        // just left). Leave the pty at whatever it already is rather than inventing
        // a size no client asked for.
        if (!Number.isFinite(cols) || !Number.isFinite(rows)) { return; }

        terminal.resize(cols, rows);
    }
```

Update the doc comment above `applyResize` (`:963-982`) to describe three rules rather than two — unrendered clients get no vote → primaries outrank non-primaries → min within the winning set — preserving the existing history note about hidden 0×0 clients squashing the visible terminal to 24 rows.

**Edge cases.** No primary attached ⇒ `candidates === voters` ⇒ byte-identical arithmetic to today. Every voter withdraws ⇒ `voters` is empty ⇒ `cols`/`rows` stay `Infinity` ⇒ early return leaves the pty untouched (the existing, correct behaviour). A forged `solo=1` from a client that is not a pop-out is authorisation-neutral (see *Security*).

### 2. `src/webview/terminals.js` — declare primacy at connect, withdraw the vote when unrendered, and re-cast it when it returns

**Context.** `fitAndReportSize` (`:181-220`) is the only emitter of `t: 'resize'`. It is reached from `ws.onopen` (`:4779`) and from the fit ladder's verified-mismatch branch (`:3448-3450`) only. The container `ResizeObserver` (`:4497-4510`) is the only observer of the box collapsing. `connectWebSocket` builds the upgrade URL at `:4749-4760`.

**Logic.** `entry.sizeVoteActive` becomes the single source of truth for "the gateway currently holds a size from this client". Everything that clears it (a withdrawal, a reconnect) has a matching path that sets it again.

**Implementation.**

Declare primacy on the upgrade URL, beside `token` and `lastSeq` (`:4749-4759`):

```js
        let wsUrl = `${PTY_HOST_ORIGIN}/ws/terminal?name=${encodeURIComponent(entry.name)}`;
        // Connection-scoped, not per-frame: this document is a single-terminal pop-out
        // for its whole life, and the gateway lets a primary viewer outrank the grid
        // cells showing the same terminal. Read from the body class rather than
        // `window.parent === window` — the NEW WINDOW cockpit is also top-level and must
        // NOT claim primacy (it is a second grid, not a single-terminal viewer).
        if (document.body.classList.contains('is-solo')) {
            wsUrl += '&solo=1';
        }
```

> **Superseded:** `fitAndReportSize` gains a `primary: document.body.classList.contains('is-solo')` field inside its `ws.send(JSON.stringify({ t: 'resize', … }))` literal.
> **Reason:** See the callout in change 1 — primacy is connection state, not measurement state. Removing it from the frame also leaves the resize literal byte-identical to what the existing contract tests read.
> **Replaced with:** the `&solo=1` handshake parameter above. `fitAndReportSize`'s only change is the `sizeVoteActive` bookkeeping below.

In `fitAndReportSize` (`:190-197`), record that a vote is now outstanding:

```js
            if (entry.ws && entry.ws.readyState === WebSocket.OPEN) {
                entry.ws.send(JSON.stringify({
                    t: 'resize',
                    cols: entry.term.cols,
                    rows: entry.term.rows,
                    rendered: true
                }));
                entry.sizeVoteActive = true;
            }
```

Add the withdraw / re-cast pair next to `fitAndReportSize`:

```js
    /**
     * Tell the gateway this client no longer has a viewport, so its last reported
     * size stops constraining the shared pty.
     *
     * `client.reportedSize` is sticky server-side: fitAndReportSize returns early
     * when the box is 0x0, so a client that goes hidden simply stops sending and
     * its final size clamps the pty until the socket closes. That is why switching
     * the shell to another panel did not release the cockpit's hold on a
     * popped-out terminal.
     *
     * Sent once per transition, not per ResizeObserver tick — a hidden panel must
     * not become a chatty client.
     */
    function releaseSizeVote(entry) {
        if (!entry || !entry.sizeVoteActive) { return; }
        if (!entry.ws || entry.ws.readyState !== WebSocket.OPEN) { return; }
        try {
            entry.ws.send(JSON.stringify({ t: 'resize', cols: 0, rows: 0, rendered: false }));
            entry.sizeVoteActive = false;
        } catch { /* ignore */ }
    }

    /**
     * Re-cast a withdrawn vote. The counterpart to releaseSizeVote, and NOT optional:
     * a client that withdraws and never re-votes is permanently removed from the pty
     * sizing calculation, which is a worse bug than the clamp this all exists to fix.
     *
     * Deliberately NOT routed through startFitLadder. The ladder reports only on a
     * verified 'mismatch' verdict, and a pane that comes back at exactly the size it
     * left at inspects as 'ok' — so the ladder alone would leave the vote withdrawn
     * forever. fitAndReportSize sends unconditionally from a rendered box, which is
     * precisely what is needed here.
     */
    function ensureSizeVote(entry) {
        if (!entry || entry.disposed || entry.sizeVoteActive) { return; }
        if (!isRendered(entry.container)) { return; }
        fitAndReportSize(entry);
    }
```

Initialise `sizeVoteActive: false` in the entry literal (`:4275-4304`, alongside `resizeObserver: null`), and reset it to `false` on reconnect in the same block that zeroes `pendingAckChars` / `awaitingReplayFrame` (`:4735-4747`) — the server issues a fresh `ClientState` with no `reportedSize`, so a stale `true` here would make `ensureSizeVote` suppress the first report on the new socket.

Wire both into the container's `ResizeObserver` (`:4497-4508`):

```js
        let resizeTimer = null;
        const resizeObserver = new ResizeObserver(() => {
            if (resizeTimer) clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                // The box collapsed — Peek hiding a sibling pane, or the pane losing
                // its assignment. Withdraw before returning, or the gateway keeps
                // clamping the shared pty to a viewport nobody can see.
                if (!isRendered(entry.container)) { releaseSizeVote(entry); return; }
                // Re-cast BEFORE the ladder: a pane restored at its previous size
                // inspects as 'ok' and the ladder reports nothing.
                ensureSizeVote(entry);
                // `active` is pane ASSIGNMENT, not visibility — a hidden panel's panes
                // are still "active". inspectPaneFit/fitAndReportSize gate on actually
                // having a box.
                if (entry.container.classList.contains('active')) {
                    startFitLadder(entry.name);
                }
            }, 100);
        });
```

Add the cross-document arm to the existing `message` listener (`:582-619`), in the same origin-checked style as `focusTerminal` / `clearTerminalBadge`:

```js
            } else if (message.type === 'panelVisibility' && typeof message.visible === 'boolean') {
                if (event.origin !== location.origin) { return; }
                // The shell hides a panel by setting display:none on its IFRAME. This
                // document then stops being rendered, so its ResizeObservers no longer
                // run — the container observer above cannot see this transition in
                // either direction, and on the way back the box is unchanged so there
                // is nothing for it to observe anyway. The shell is the only thing that
                // knows, so the shell has to say so.
                if (!message.visible) {
                    for (const entry of terminalsMap.values()) { releaseSizeVote(entry); }
                } else {
                    // rAF, not a direct call: the display flip and this message can land
                    // in the same task, and a frame callback is by definition only
                    // delivered once the document is actually being rendered.
                    requestAnimationFrame(() => {
                        for (const entry of terminalsMap.values()) { ensureSizeVote(entry); }
                    });
                }
            }
```

**Edge cases.** A pop-out never receives `panelVisibility` (it has no shell parent), so its vote is never withdrawn — correct, it is always visible to the gateway. An entry whose socket is closed or reconnecting is skipped by `releaseSizeVote`'s `readyState` guard and by `ensureSizeVote`'s dependency on `fitAndReportSize`'s own guards. A panel hidden before any terminal materialised has `sizeVoteActive === false` on every entry, so the withdrawal loop sends nothing.

### 3. `src/webview/shell.js` — tell each panel iframe when it is hidden or shown

**Context.** `selectPanel(id)` (`:32-44`) toggles `is-active` on every mounted frame; `.panel-frame.is-active { display: block; }` (`src/webview/shell.html:153`) is what actually hides them. The shell already posts origin-scoped messages into the terminals frame (`:387-392`, `:409-413`).

**Logic.** The shell is the only party that knows a panel's iframe visibility changed. Broadcast it to every frame on every switch; panels that do not care ignore the type.

**Implementation.**

```js
    function selectPanel(id) {
        if (!frames.has(id)) { return; }
        activePanel = id;
        for (const [pid, frame] of frames) {
            frame.classList.toggle('is-active', pid === id);
            // A document inside a display:none iframe is not rendered and gets no
            // rendering opportunities, so it cannot observe its own hiding — the
            // Terminals panel needs this to release its hold on the shared pty size
            // (see releaseSizeVote in terminals.js). Panels with no arm for this type
            // fall through their message chain and ignore it.
            try {
                frame.contentWindow?.postMessage(
                    { type: 'panelVisibility', visible: pid === id },
                    location.origin
                );
            } catch { /* frame not ready yet — its first fit reports a size anyway */ }
        }
        for (const [pid, icon] of icons) {
            icon.classList.toggle('is-active', pid === id);
        }
        ...
    }
```

**Edge cases.** `selectPanel` also runs on first load, before the terminals iframe has finished loading — `contentWindow` may exist with no listener attached yet, so the message is dropped. Harmless: no terminal has voted at that point, and the panel's own first `fitAndReportSize` on `ws.onopen` casts the initial vote. Frames whose `contentWindow` is null are covered by the optional chaining and the `try`.

**Coordination.** This hunk overlaps `terminal-peek-temporary-fullscreen.md`'s edits to the same file. Serialise, per the PRD's one-stream-per-file rule.

### 4. `src/test/terminal-solo-popout-contract.test.js` — pin the new contracts

**Context.** The file is a source-text contract suite with a `block(code, startMarker, endMarker)` helper, and it already reads `terminalWsGateway.ts` across the file boundary (the eviction-sentinel test at `:81-93`) — so gateway assertions belong here and match existing style. There is no runtime harness for the gateway; these are text contracts, and they should say *why* each rule exists so a future edit that breaks one knows what it is breaking.

**Implementation.** Add:

- `connectWebSocket` appends `&solo=1` from the `is-solo` body class — and **not** from `window.parent === window`, which is also true for the NEW WINDOW cockpit.
- `handleUpgrade` reads `solo` from `searchParams` and threads it into `setupClient`; `ClientState.primary` is never assigned inside `applyResize` (primacy is connection state — assert the absence, since that is the regression the superseded design would reintroduce).
- The `rendered === false` arm clears `reportedSize` **and** calls `reconcileTerminalSize` — assert both, since the pre-existing arm returned without doing either.
- The `rendered === false` arm sits **before** the `cols < 1 || rows < 1` warning, so a legitimate 0×0 withdrawal does not log.
- `reconcileTerminalSize` falls back to all voters when `primaries.length === 0`, so a fleet with no pop-out sizes exactly as before.
- `releaseSizeVote` is gated on `sizeVoteActive` (sent once per transition, not per observer tick), and `fitAndReportSize` sets `sizeVoteActive = true` inside the same `readyState === OPEN` branch that sends.
- `ensureSizeVote` calls `fitAndReportSize` directly and does **not** call `startFitLadder` — the ladder's `'ok'` short-circuit is exactly what it exists to bypass.
- The `ResizeObserver` body calls `releaseSizeVote` on the unrendered branch and `ensureSizeVote` before `startFitLadder`.
- `shell.js`'s `selectPanel` posts `panelVisibility` with `location.origin` (not `'*'`), and the terminals arm origin-checks it.
- The `panelVisibility` arm is **directionally asymmetric**: the `visible === false` branch withdraws synchronously, the `visible === true` branch re-casts inside `requestAnimationFrame`, and neither uses `setTimeout`. Assert all three — this asymmetry is the load-bearing consequence of *Platform Behaviour* fact 4 and reads like an inconsistency to anyone who has not read it.

**Edge cases.** `terminal-pane-fit-verification-contract.test.js:92` asserts `resyncPaneRenderer` contains no `t: 'resize'` and `:99-100` asserts the ladder reaches `fitAndReportSize` only on a verified mismatch. Neither new call site is in those blocks, so both still pass — confirm rather than assume.

## Verification Plan

### Automated Tests

Run by the implementing agent (this planning session executed no compilation or tests):

- `node src/test/terminal-solo-popout-contract.test.js` — new contracts pass.
- `node src/test/terminal-pane-fit-verification-contract.test.js` — unchanged; confirms the new call sites did not land in `resyncPaneRenderer` or widen the ladder's reporting gate.
- `node src/test/terminal-flow-control-contract.test.js` — unchanged; confirms the resize-frame edits did not disturb the credit ledger.
- `node src/test/terminal-token-transport-contract.test.js` — unchanged; the upgrade URL grew a parameter and the token contract must still hold.
- `npx tsc --noEmit -p tsconfig.json` for the `ClientState` / `setupClient` signature change.

### Manual — the reported bug

- Start the standalone server, open the cockpit, set the layout to 3×3, seat a Claude terminal in one cell, run something with a wide TUI (`claude`, or `htop`).
- Open the solo pop-out for that terminal **via whichever entry point exists at the time** — the shell rail icon today, the pane-header pop-out control once `terminal-peek-temporary-fullscreen.md` has landed. If neither is convenient, navigate directly to `/terminals?solo=<name>`; the URL is the surface under test and all three routes reach it.
- **Expect:** the CLI reflows to the full width of the 900×700 pop-out on its next redraw (the pty resize raises `SIGWINCH`; when the CLI repaints is the CLI's business, so judge this by "it reflows promptly and stays reflowed", not by a single frame).
- Resize the pop-out wider. **Expect:** the CLI reflows to the new width.
- **Do this with the terminal seated in a cockpit pane.** An unseated terminal has no competing voter and passes even with the bug present, so it is not a valid repro.

### Manual — no regression to the rule this narrows

- With the pop-out closed, switch the shell to the Board panel and back. **Expect:** the cockpit terminal is not squashed to 24 rows (the defect the min rule originally fixed).
- **The disenfranchisement check.** With the pop-out closed, switch the shell to Board and back, then drag the browser window narrower. **Expect:** the pty follows the cockpit pane. If the pty ignores the cockpit entirely after one panel switch, the vote was withdrawn and never re-cast — this is the regression mode the whole `ensureSizeVote` path exists to prevent, and it is the single most important manual check in this plan.
- Close the pop-out. **Expect:** the cockpit's 3×3 cell reclaims the pty and redraws at cell size within ~1s, no reload needed.
- With the pop-out open, switch the shell to another panel. **Expect:** no change to the pop-out (its vote is unaffected by the cockpit going hidden).

### Manual — multi-viewer

- Open two pop-outs of the same terminal at different widths. **Expect:** the pty settles at the narrower of the two, and closing the narrower one widens the survivor.
- Open the NEW WINDOW cockpit (`/terminals`, no `?solo=`) alongside the main cockpit, both showing the same terminal, no pop-out. **Expect:** the min rule still applies across both — the NEW WINDOW cockpit must not claim primacy.

---

**Recommendation: Send to Coder** (complexity 6).

## Review Findings

All four changes are present and correct: primacy is read once from `?solo=1` at handshake and stored on `ClientState` (never assigned in `applyResize`), `reconcileTerminalSize` narrows to `primaries.length > 0 ? primaries : voters` so a fleet with no pop-out is byte-identical arithmetic, the `rendered === false` arm clears `reportedSize` and reconciles *before* the degenerate-size warning, `sizeVoteActive` is reset on reconnect, and the `panelVisibility` arm is correctly directionally asymmetric (synchronous withdraw, rAF-gated re-cast, no `setTimeout` in either). Change 4's contract additions to `terminal-solo-popout-contract.test.js` were not made, but that file is now green and this review's separate work restored it from a CI-red state caused by a sibling subtask's listener placement. This plan's Platform Behaviour fact 2 was also the deciding evidence for a MAJOR fix in the sibling WebGL subtask, whose Resolved Assumption 1 asserts the opposite — the renderer release now rides this plan's `panelVisibility` carrier rather than the in-iframe `ResizeObserver` alone. Files changed by this review: `src/webview/terminals.js` (renderer arm added to the `panelVisibility` handler), `protocol-catalog.json` (regenerated — the new `panelVisibility` push site had left `catalog:check` red). Verification: `test:contract:terminal-solo-popout` 11/0, `terminal-pane-fit` unchanged from HEAD (confirming the new call sites did not land in `resyncPaneRenderer` or widen the ladder's reporting gate), `terminal-flow-control` 16/0, `tsc --noEmit` at the HEAD baseline of 5 pre-existing errors. Remaining risk: the disenfranchisement check — pop-out closed, switch to Board and back, then drag the window narrower — is the single most important manual step and is browser-only, so the withdraw/re-cast pairing is verified structurally but not behaviourally.

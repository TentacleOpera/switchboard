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

## Reconcile Before Building

**The pop-out entry point is moving, and this plan is unaffected by the move.** `terminal-peek-temporary-fullscreen.md` (feature *Terminals Pane: Groups, Peek, and Bulk Terminal Creation*, `9e7c314d`) repoints the shell rail click at an in-window peek and relocates single-terminal pop-out to a control in each pane header, with the shell still owning `window.open` so `popoutWindows` keeps its theme fan-out. That plan is explicit that `?solo=` survives the move — *"this change relocates the entry point, it does not retire the mode"* — and requires `src/test/terminal-solo-popout-contract.test.js` to keep passing.

Consequences for this plan:

- **No file overlap.** The fix lives in `src/standalone/terminalWsGateway.ts` (`reconcileTerminalSize`, `applyResize`, `ClientState`) and in `fitAndReportSize` / the container `ResizeObserver` in `src/webview/terminals.js`. Peek touches neither — it edits the render path, the sidebar rows and `shell.js`. Runnable in either order, and in parallel with the whole feature.
- **The relocation makes this defect strictly worse, so do not defer it behind Peek.** Today the rail can pop out a terminal that is seated in no pane — no competing voter, correct size, by accident. A pane-header control can only ever pop out a terminal that *is* seated in a cockpit pane, so after Peek **every** pop-out has a grid-cell client clamping it and the bug becomes unconditional.
- **Test-file etiquette.** Peek requires `terminal-solo-popout-contract.test.js` to pass *unmodified by Peek*. This plan legitimately extends that file with sizing contracts; that is compatible in either landing order because Peek changes nothing this plan asserts. If Peek lands first, re-run the file before adding to it.
- Line references below were verified against the working tree on 2026-08-08, which carries uncommitted local changes to `terminals.js` and `shell.js`. Re-grep the symbols rather than trusting a line number.

## Metadata

- **Complexity:** 5
- **Tags:** frontend, backend, ui, bugfix
- **Project:** Browser Switchboard

## User Review Required

None.

## Complexity Audit

**Routine (majority of the work):**
- Adding an optional field to a JSON control frame that already carries optional fields (`rendered`).
- Adding one optional property to `ClientState`.
- Clearing `reportedSize` on an explicit relinquish — a two-line change in an arm that already exists.

**Complex / risky (two items, both contained):**
1. **Changing the pty-sizing rule is a behaviour change for multi-viewer setups.** The min rule is load-bearing: the comment at `terminalWsGateway.ts:960-987` documents a shipped bug (hidden 0×0 tabs squashing the visible terminal to 24 rows) that it fixed. The change must therefore be *additive* — the min rule stays as the default and is only narrowed to a smaller candidate set when a primary viewer declares itself. With no primary attached, the arithmetic must be byte-for-byte what it is today.
2. **A wider pty makes the cockpit's small pane show wrapped output while the pop-out is open.** This is intrinsic to a shared pty: something has to lose. The pop-out winning is the whole point of the feature, and the state self-heals the moment the pop-out closes (`ws.on('close')` already reconciles). Called out here so it is a decision, not a surprise.

## Edge-Case & Dependency Audit

- **Older clients / no primary attached.** A client that never sends `primary` is treated as non-primary. If no client for a terminal claims primary, the candidate set is *all* clients and the result is identical to today's min. Back-compat is by construction, not by a shim.
- **Two pop-outs of the same terminal.** Both claim primary; the min is taken across the two primaries. Same tmux rule, one tier up. Correct, and no special case needed.
- **Pop-out closed.** `ws.on('close')`/`ws.on('error')` already call `reconcileTerminalSize` (`:948-953`). With no primary left, the candidate set widens back to all clients and the cockpit pane regains control. No new teardown code.
- **Pop-out opened but never focused / immediately hidden by the OS.** It is still rendered (it has a box), so it still reports and still claims primary. That is intended — the user asked for it to be sized for that window.
- **The NEW WINDOW button (`/terminals` with no `?solo=`).** Not primary. It is a full second cockpit, not a single-terminal viewer, and claiming primary there would let a second grid clamp the first. Explicitly excluded via the `is-solo` body class rather than by "is this a top-level window".
- **Popping out a terminal that is seated in a pane is the *normal* case, not the exception.** It is already the common case from the rail, and once the pop-out control moves into the pane header (`terminal-peek-temporary-fullscreen.md`) it is the only case — you cannot open a pane-header control for a terminal that occupies no pane. The primary rule must therefore be the default behaviour, never something gated on "is the terminal also seated"; a heuristic that only kicks in for unseated terminals would fix nothing after the relocation.
- **Peek's hidden panes.** Peek hides sibling panes with `display: none` while keeping their xterm containers mounted. Those containers then measure 0×0, `isRendered` returns false, and the new `releaseSizeVote` fires — so a peeked terminal gets the full grid area's pty size for free, and un-peeking restores the votes. That is the correct interaction and needs no coordination, but it is worth confirming during Peek's own verification that the ladder converges on both transitions.
- **`rendered: false` relinquish is new outbound traffic.** It must be sent at most once per transition into "no box", not on every ResizeObserver tick, or a hidden panel becomes a chatty client. Gate on a per-entry `sizeVoteActive` flag.
- **A relinquish that empties the candidate set.** `reconcileTerminalSize` already returns early when no client has a `reportedSize` (`:1007-1009`, "leave the pty at whatever it already is"). Clearing the last vote therefore leaves the pty alone rather than inventing a size — correct, and no new guard needed.
- **`hello` frame's `cols`/`rows`.** Sent at attach (`:861-874`) and read by no sizing path on the client. Untouched.
- **Persisted state.** None. Nothing in this change reaches a settings key, the DB, or a file — per CLAUDE.md's migration rule there is nothing to migrate.
- **Extension-host path.** The pty gateway is standalone-only (`src/standalone/terminalWsGateway.ts`); the VS Code webview terminal path does not share this sizing code. No parity work.
- **Contract tests that read this source.** `src/test/terminal-solo-popout-contract.test.js` and `src/test/terminal-pane-fit-verification-contract.test.js` are source-text tests over `terminals.js`. The change to `fitAndReportSize` adds a field inside the existing `ws.send(JSON.stringify({ t: 'resize', … }))` literal; confirm no test pins that literal's exact shape before editing.

## Proposed Changes

### 1. `src/webview/terminals.js` — declare primacy, and relinquish the vote when unrendered

In `fitAndReportSize` (`:181-220`), stamp the frame:

```js
    function fitAndReportSize(entry) {
        if (!entry || entry.disposed || !entry.term || !entry.fitAddon) { return; }
        if (!isRendered(entry.container)) { return; }
        let resized = false;
        try {
            const colsBefore = entry.term.cols;
            const rowsBefore = entry.term.rows;
            entry.fitAddon.fit();
            resized = entry.term.cols !== colsBefore || entry.term.rows !== rowsBefore;
            if (entry.ws && entry.ws.readyState === WebSocket.OPEN) {
                entry.ws.send(JSON.stringify({
                    t: 'resize',
                    cols: entry.term.cols,
                    rows: entry.term.rows,
                    rendered: true,
                    // A solo pop-out is a window opened for ONE terminal. It outranks
                    // every grid cell showing the same terminal, which is the entire
                    // point of the rail icons. Non-solo clients never claim this, so
                    // with no pop-out attached the gateway's min rule is unchanged.
                    primary: document.body.classList.contains('is-solo')
                }));
                entry.sizeVoteActive = true;
            }
        } catch { /* ignore */ }
        if (resized) { resyncPaneRenderer(entry, 'stale-canvas'); }
    }
```

Add the relinquish, next to `fitAndReportSize`:

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
```

Initialise `sizeVoteActive: false` in the entry literal (`:4279-4293`, alongside `resizeObserver: null`), and reset it to `false` on reconnect in the same block that zeroes `pendingAckChars` / `awaitingReplayFrame` (`:4735-4747`) — a new socket has issued no vote.

Call it from the container's `ResizeObserver` (`:4497-4510`), which is the only place that observes the box collapsing:

```js
        const resizeObserver = new ResizeObserver(() => {
            if (resizeTimer) clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                if (!isRendered(entry.container)) { releaseSizeVote(entry); return; }
                if (entry.container.classList.contains('active')) {
                    startFitLadder(entry.name);
                }
            }, 100);
        });
```

### 2. `src/standalone/terminalWsGateway.ts` — primary viewers win; a relinquish actually clears the vote

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
    /** This client is a single-terminal viewer (a solo pop-out window). When any
     *  primary is attached, only primaries vote on the pty size. */
    primary?: boolean;
}
```

`applyResize` (`:981-993`):

```ts
    private applyResize(client: ClientState, parsed: { cols: number; rows: number; rendered?: boolean; primary?: boolean }): void {
        if (parsed.rendered === false) {
            // A vote WITHDRAWN, not merely absent. Without clearing, the last size a
            // client reported before it was hidden clamps the pty for the life of the
            // socket — which is how a hidden cockpit grid cell kept a solo pop-out at
            // the grid cell's width.
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
        client.primary = parsed.primary === true;
        client.reportedSize = { cols: parsed.cols, rows: parsed.rows };
        this.reconcileTerminalSize(client.terminalName);
    }
```

`reconcileTerminalSize` (`:995-1011`) — narrow the candidate set, keep the min rule inside it:

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
        if (!Number.isFinite(cols) || !Number.isFinite(rows)) { return; }

        terminal.resize(cols, rows);
    }
```

Update the doc comment above the function to describe three rules rather than two (unrendered clients get no vote → primaries outrank non-primaries → min within the winning set), preserving the existing history note about hidden 0×0 clients.

### 3. `src/test/terminal-solo-popout-contract.test.js` — pin the new contracts

Add source-text contracts in the file's existing style:

- `fitAndReportSize` stamps `primary` from the `is-solo` body class, not from `window.parent === window` (the NEW WINDOW cockpit must not claim it).
- A `rendered: false` frame clears `reportedSize` **and** reconciles — assert both, since the pre-existing arm returned without doing either.
- `reconcileTerminalSize` falls back to all voters when `primaries.length === 0`, so a fleet with no pop-out sizes exactly as before.
- `releaseSizeVote` is gated on `sizeVoteActive` (sent once per transition, not per observer tick).

## Verification Plan

1. **Automated**
   - `node src/test/terminal-solo-popout-contract.test.js` — new contracts pass.
   - `node src/test/terminal-pane-fit-verification-contract.test.js` and `node src/test/terminal-flow-control-contract.test.js` — unchanged, confirming the resize-frame edit did not disturb the fit ladder or the credit ledger.
   - `npx tsc --noEmit -p tsconfig.json` for the `ClientState` change.
2. **Manual — the reported bug**
   - Start the standalone server, open the cockpit, set the layout to 3×3, seat a Claude terminal in one cell, run something with a wide TUI (`claude`, or `htop`).
   - Open the solo pop-out for that terminal **via whichever entry point exists at the time** — the shell rail icon today, the pane-header pop-out control once `terminal-peek-temporary-fullscreen.md` has landed. If neither is convenient, navigate directly to `/terminals?solo=<name>`; the URL is the surface under test and all three routes reach it.
   - **Expect:** the CLI redraws to the full width of the 900×700 pop-out within one frame — not a narrow column in a large empty window.
   - Resize the pop-out wider. **Expect:** the CLI reflows to the new width.
   - **Do this with the terminal seated in a cockpit pane.** An unseated terminal has no competing voter and passes even with the bug present, so it is not a valid repro.
3. **Manual — no regression to the rule this narrows**
   - With the pop-out closed, switch the shell to the Board panel and back. **Expect:** the cockpit terminal is not squashed to 24 rows (the defect the min rule originally fixed).
   - Close the pop-out. **Expect:** the cockpit's 3×3 cell reclaims the pty and redraws at cell size within ~1s, no reload needed.
   - With the pop-out open, switch the shell to another panel. **Expect:** no change to the pop-out (its vote is unaffected by the cockpit going hidden).
4. **Manual — multi-viewer**
   - Open two pop-outs of the same terminal at different widths. **Expect:** the pty settles at the narrower of the two, and closing the narrower one widens the survivor.

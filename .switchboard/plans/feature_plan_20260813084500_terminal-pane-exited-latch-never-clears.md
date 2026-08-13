# A Terminal Pane's `exited` Flag Is A One-Way Latch — A Live PTY Renders Read-Only Until The Panel Is Reloaded

## Goal

Make `entry.exited` recoverable in the terminals webview. A pane that has taken one `exit`/`error` frame must return to `accepts input` as soon as the fleet reports that terminal `active` again — without an operator reloading the panel. Also stop `kill()` from being reported to the client as `[Process Exited with code 0]`, which is indistinguishable from an agent exiting cleanly on its own.

### Problem analysis

Observed 2026-08-13. The operator instantiated the **Feature Implementation** agent group (head `lead` + 3 × `coder` delegates). Selecting the coder terminals from the sidebar seated them into panes that showed:

```
[Process Exited with code 0]
```

with the header chip reading **read-only** and the pane refusing keystrokes. The operator's read was that the terminals had never started.

They had. Verified live against the running host at the time of the report:

- `POST /terminals/verb/ptyListTerminals` returned all four with `status: "active"` — `Feature Implementation` (pid 61808), `-coder-1` (61812), `-coder-2` (61861), `-coder-3` (61866).
- `ps` confirmed the processes: head running `claude`, all three coders running `devin --permission-mode bypass`.
- Attaching a fresh WebSocket to `ws://127.0.0.1:<ptyHost>/ws/terminal?name=Feature%20Implementation-coder-1` returned a clean `hello` frame (`seq: 9`, `replayChars: 1850`) and replayed a live Devin CLI prompt. **No exit frame on attach.**

So the pty was alive, the fleet knew it was alive, and a new socket to it worked. Only the already-built pane thought it was dead. **Reloading the Terminals panel fixed it** — which is the confirming signal: the reload drops `terminalsMap`, and every pane rebuilds and reattaches.

What produced the *original* exit frame is not established. The fleet's `recentlyClosed` tombstone map — populated from the `{type:'closed'}` change event, which fires on **both** death paths (`ptyFleetService.ts:222-229` self-exit and `:462` operator kill) — contained only `planner-1`…`planner-6`, `researcher-1`, `coder-1`, an earlier batch that genuinely self-exited at 22:03. It held no `Feature Implementation*` entry. This plan therefore fixes the **latch**, not the trigger: whatever set the flag, the client must be able to leave the state.

### Root cause

**`entry.exited` is written in three places and cleared in none, and every recovery path in the client is gated behind it.**

Set at:
- `src/webview/terminals.js:7570` — `error` frame.
- `src/webview/terminals.js:7586` — `exit` frame (also writes the `[Process Exited with code N]` line and sets `term.options.disableStdin = true`).
- `src/webview/terminals.js:6727` — `destroyTerminalView`, which then deletes the entry, so this one is terminal by construction.

Once latched, four separate mechanisms each decline to recover:

1. **`resolveInputState` (`:3559`)** short-circuits on it — `if (entry.exited || (entry.term && entry.term.options.disableStdin))` returns `read-only` before the socket state is ever consulted. Verified byte-for-byte identical in the shipped bundle (`ht()` in the served `terminals.js`), so this is not a `src`/`dist` drift.
2. **`ws.onclose` (`:7599`)** — `if (entry.exited) { return; }` before the reconnect scheduler. The socket will never be retried.
3. **`sanitizePaneAssignments` (`:1759`)** drops a slot only when its name is **absent** from `fleetList`. A name that is present *and active* keeps both its slot and its poisoned entry. There is no comparison anywhere between "the client thinks this is dead" and "the fleet says it is alive".
4. **`armDetachTimer` (`:351`)** does contain a teardown for exited entries — but it fires only when the terminal is **unassigned** (`!paneAssignments.includes(name)`) and only after `DETACH_GRACE_MS` (5 min). A pane the operator keeps seated, or re-seats within the grace window, is never swept. Its comment even cites `entry.exited` as a trusted death signal, which is exactly the assumption that breaks here.

So assignment does not imply attachment: `renderPaneGrid` (`:3709`) / `updatePaneElement` (`:4307`) reuse whatever `terminalsMap` already holds for a name. Selecting the terminal from the sidebar re-seats the **same latched entry**, which is why the operator saw read-only on a terminal they had just picked.

**Secondary defect — the exit report is dishonest for a kill.** `PtyFleetService.kill()` (`:462`) emits `{ type: 'closed', name }` with **no `code`**. The gateway forwards that as `{ t: 'exit', code: exitCode ?? 0 }` (`terminalWsGateway.ts:728`), so an operator-initiated kill renders as `[Process Exited with code 0]` — identical to an agent exiting successfully. The self-exit path (`ptyFleetService.ts:228`) does pass a real `code`, and the `FleetChangeEvent` type comment (`:75-78`) already documents `code` as *"undefined for an operator-initiated kill()"*, so the distinction exists in the type and is thrown away at the wire.

## Metadata

- **Complexity:** 4
- **Tags:** frontend, terminals, webview, bugfix, reliability

*(No project pin — the request named no project, and the workspace name is not a project. Assign on the board.)*

## User Review Required

- None.

## Complexity Audit

### Routine

- A reconcile pass over `terminalsMap` after `fleetList` is assigned in `fetchTerminalList` (`:1496`).
- Stamping `entry.exitedAt` alongside the two frame-driven `entry.exited = true` writes.
- Recording `agentInstanceId` on the entry when a view is built.
- Passing a kill sentinel through `kill()` → `untrackTerminalData` → the `exit` frame.

### Complex / Risky

- **Do not clear `entry.exited` in place.** Flipping the boolean back to `false` leaves a disposed-or-desynced xterm, a dead socket, `disableStdin` still `true` on the terminal instance, and a stale `lastSeq` that would make the gateway replay from the wrong point. The only correct recovery is a full teardown through `destroyTerminalView` — which disposes the xterm and releases its WebGL context (`MAX_WEBGL_CONTEXTS` is 12 per renderer, `:348`) — and letting the next `renderPaneGrid` build a fresh view. Reuse the existing teardown; do not write a partial reset.

- **Name is not identity.** `PtyFleetService.kill()` deletes the handle from `this.terminals` *before* killing (`:459-462`), so a killed name is immediately free and `create()`'s uniquifier (`:2-7`) will hand the identical name to a new pty. A self-exited handle, by contrast, stays in the map with `status: 'exited'` and forces the next terminal to `${role}-${n+1}`. So "same name" spans two different processes only on the kill path — which is precisely the path this bug rides. Key the reconcile on `agentInstanceId` where available so a same-name replacement is also rebuilt, not just an active-name mismatch.

- **Do not reconcile on `fleetList` alone without an ordering guard.** The fleet list is refreshed on a 5 s poll (`:14694` region in the shipped bundle). A terminal that dies between the fetch and the frame will briefly read `active` in a snapshot that predates its `exit` frame. Reconciling on that snapshot tears down a pane that is correctly showing `[Process Exited]`, reattaches, and `setupClient` immediately re-sends `{t:'exit'}` (`terminalWsGateway.ts:1068-1070`) — the same state, one flicker later. Harmless but avoidable, and it becomes a rebuild loop if the registry is ever stale in the other direction. Gate on the fetch having *started* after `entry.exitedAt`.

## Edge-Case & Dependency Audit

1. **Scrollback is not lost by the rebuild.** `destroyTerminalView` discards the client-side xterm buffer, but the gateway keeps a per-terminal scrollback ring (`MAX_SCROLLBACK_BYTES`, `terminalWsGateway.ts` `scrollbackBuffers`) and replays it on attach as one concatenated frame. The rebuilt pane repaints from the ring. The `[Process Exited with code 0]` line does **not** come back — it is written client-side, never into the ring — which is the desired outcome.
2. **The exit line must stay for a genuinely dead terminal.** `terminal-chrome-not-in-buffer.test.js:67` asserts the exit notice is the only record of the exit code and nothing may redraw over it. The reconcile must fire only when the fleet reports the terminal **not** exited; a dead terminal's pane is untouched.
3. **`error` frames (`code 4404`, "No such terminal") must heal too.** A pane seated before its pty finished spawning gets `{t:'error'}` (`terminalWsGateway.ts:927-930`), which latches `exited` without printing an exit line — the same dead end, reached during the ~750 ms-apart delegate spawn window that this very group creation walks through. Stamp `exitedAt` on that branch as well (`:7570`).
4. **Solo pop-out windows.** `?solo=1` documents share the same `terminalsMap` and `fetchTerminalList`, so the reconcile covers them. `checkSoloNotFound` keys on `fleetList` membership, not on `entry.exited`, and is unaffected — but confirm the rebuild does not race its `paneGridEl.style.display` toggle.
5. **Multi-window cockpit.** Each document owns its own `terminalsMap`; the reconcile is per-document and needs no coordination. A second window that never saw the exit frame was never latched.
6. **`pinnedPanes` / `undoSnapshot`.** Neither is touched — the slot keeps its name, only the view behind it is rebuilt. `sanitizePaneAssignments`' pin-expiry and undo-invalidation blocks key on slot emptiness and name liveness respectively, and this change empties no slot.
7. **`armDetachTimer` still needed.** The 5-minute sweep remains correct for genuinely dead unassigned terminals. Do not remove it; the new reconcile handles the live-but-latched case it deliberately excludes.
8. **`startupCurtains`.** `dismissStartupCurtain` runs on both frame branches before the latch is set. A rebuild after a heal re-enters `createTerminalView` without arming a curtain (curtains are armed only for terminals **this tab** created, `:1600` region), so no curtain can strand.
9. **Kill sentinel is additive.** Adding a field to the `exit` frame is backward compatible: an older client ignores unknown fields and keeps printing its current message. No version negotiation needed, no migration — this is wire shape, not persisted state.
10. **`Lagging client evicted` stays special-cased.** The shipped client already filters that reason out of the exit branch (confirmed present in the served bundle). The kill sentinel is a second `reason`-style discriminator on the same frame and must not disturb the eviction path.
11. **No confirmation dialogs.** Nothing in this change adds an operator prompt. Per `CLAUDE.md`, and because `window.confirm()` is a silent no-op in VS Code webviews.
12. **Testing surface.** `terminal-renderer-lifecycle-contract.test.js` and `terminal-flow-control-contract.test.js` both assert on view teardown/rebuild. A new contract test should assert the invariant directly: *an entry with `exited === true` whose name is `active` in `fleetList` is destroyed on the next fleet refresh.*
13. **`dist/` is not in scope.** Per `CLAUDE.md`, `src/` is the source of truth; the VSIX is rebuilt separately. (Noted only because this bug was diagnosed against the served bundle — the shipped code matched `src` on every line cited here except the delegate-overlay dead code, which is absent from the bundle entirely and is *not* part of this plan.)

## Dependencies

- None. Self-contained in `src/webview/terminals.js`, with two small changes in `src/standalone/ptyFleetService.ts` and `src/standalone/terminalWsGateway.ts`.
- **Shares `terminals.js`** with the link-up preset plan and the teams subtasks. Different regions (fleet refresh + socket handler vs. the link-up modal); they serialise under the project's one-stream-per-file rule.
- **Related but deliberately out of scope:** delegate children (`parentInstanceId` set) are excluded from all five seating/grouping paths in the shipped bundle, and `toggleDelegateView` — the only code that was meant to reach them — has **zero call sites** in `src` and is absent from the built bundle. That is a separate defect with a separate root cause and belongs in its own plan.

## Adversarial Synthesis

The key risk is oscillation: a reconcile that fires on a fleet snapshot older than the exit frame will tear down a correctly-dead pane, reattach, receive `{t:'exit'}` again from `setupClient`, and repeat. Closed by requiring the fleet fetch to have started after `entry.exitedAt`. The second risk is a partial reset leaving a half-lived xterm — closed by routing every heal through the existing `destroyTerminalView` teardown rather than clearing the flag in place. The third is same-name-different-process, which the kill path makes reachable — closed by keying on `agentInstanceId`.

The rejected alternative is healing on the socket instead of on the fleet: retry the connection on a timer whenever `entry.exited` is set, and treat a successful `hello` as proof of life. That inverts the cost — it puts a reconnect storm against a genuinely dead terminal on the hot path, and `setupClient` answers a dead attach with another `exit` frame anyway, so it learns nothing the fleet list does not already say for free on a poll that is already running.

## Proposed Changes

### 1. `src/webview/terminals.js` — stamp when the latch was set

**Context.** The two frame-driven writes at `:7570` (`error`) and `:7586` (`exit`).

**Logic.** Record *when* the client learned the terminal was dead, so a later fleet snapshot can be compared against it. A monotonic timestamp is enough; no new state machine.

```js
    entry.exited = true;
    // When the client learned this terminal was dead. The reconcile in
    // fetchTerminalList only heals from a fleet snapshot fetched AFTER this
    // instant — an older snapshot legitimately still reads `active` and would
    // tear down a pane that is correctly showing its exit notice.
    entry.exitedAt = Date.now();
```

Apply to **both** branches. The `error` branch matters as much as `exit`: a pane seated during the ~750 ms delegate-spawn window takes a `4404` and latches with no visible exit line at all.

### 2. `src/webview/terminals.js` — record process identity on the entry

**Context.** The entry literal built in `createTerminalView` (`:6876` region).

**Logic.** `agentInstanceId` is already in `fleetList`; carry it onto the entry so the reconcile can distinguish "same terminal, still alive" from "same name, different process".

```js
        const fleetItem = fleetList.find(t => t.friendlyName === name);
        const entry = {
            name,
            // Name is NOT identity: kill() deletes the handle before killing
            // (ptyFleetService.ts:459-462), so a killed name is immediately
            // reusable and create()'s uniquifier will hand it to a new pty. Only
            // a self-exited handle blocks its own name. Pin the process here.
            agentInstanceId: fleetItem ? fleetItem.agentInstanceId : null,
            container,
            ...
```

### 3. `src/webview/terminals.js` — reconcile latched entries against the live fleet

**Context.** `fetchTerminalList` (`:1484`), immediately after `fleetList = data.terminals` (`:1496`) and **before** `sanitizePaneAssignments()`.

**Logic.** For every entry the client believes is dead, ask the fleet. If the fleet says that name is alive — or alive under a different `agentInstanceId` — the client's view describes a process that no longer exists behind that name. Tear it down; `renderPaneGrid` on the next line rebuilds it and `connectTerminalSocket` attaches.

```js
    const fetchStartedAt = Date.now();   // captured before the await, above
    ...
    fleetList = data.terminals;

    // Heal panes whose `exited` latch no longer matches reality. entry.exited is
    // set by an exit/error FRAME and never cleared, and every recovery path is
    // gated behind it: resolveInputState short-circuits to read-only (:3559),
    // ws.onclose declines to reconnect (:7599), sanitizePaneAssignments only
    // drops slots whose name is ABSENT (:1759), and armDetachTimer's sweep needs
    // the pane to be unassigned for 5 minutes (:351). A re-seated pane therefore
    // reuses the latched entry and renders read-only over a live pty — which is
    // exactly this bug. Teardown, not an in-place flag reset: the xterm is
    // disposed, disableStdin is on the instance, and lastSeq is stale.
    for (const [name, entry] of Array.from(terminalsMap.entries())) {
        if (!entry.exited) { continue; }
        // Only heal from a snapshot NEWER than the latch. An in-flight fetch that
        // predates the exit still reads `active` and would tear down a pane
        // correctly showing its exit notice, whereupon setupClient re-sends
        // {t:'exit'} (terminalWsGateway.ts:1068-1070) and we oscillate.
        if (entry.exitedAt && entry.exitedAt > fetchStartedAt) { continue; }
        const fleetItem = fleetList.find(t => t.friendlyName === name);
        if (!fleetItem || fleetItem.status === 'exited') { continue; }
        // Alive under this name — either it never died, or a new pty took the
        // name after a kill. Both mean this view is describing nothing.
        destroyTerminalView(name);
    }
```

`fetchStartedAt` is stamped before the `await fetch(...)`, not after — the point is the age of the data, not when it was parsed.

### 4. `src/standalone/ptyFleetService.ts` — mark an operator kill as such

**Context.** `kill()` at `:462`.

**Logic.** The `FleetChangeEvent` comment (`:75-78`) already says `code` is *"undefined for an operator-initiated kill()"*, but undefined is also what a missing code looks like downstream. Make the intent explicit on the event rather than inferring it from an absence.

```js
        this.emitter.emit('change', { type: 'closed', name, killed: true });
```

Extend the `closed` variant of `FleetChangeEvent` with an optional `killed?: boolean`.

### 5. `src/standalone/terminalWsGateway.ts` — stop reporting a kill as exit code 0

**Context.** `untrackTerminalData` (`:704`) and its `exit` send (`:728`); the change-event subscription at `:496-497`.

**Logic.** Forward the flag so the client can say what actually happened. `code: 0` on a kill reads as "your agent finished cleanly", which is the opposite of the truth and sends the operator looking for a completion report that was never written.

```js
            } else if (event.type === 'closed') {
                this.untrackTerminalData(event.name, event.code, event.killed);
            }
```

```js
    private untrackTerminalData(name: string, exitCode?: number, killed?: boolean): void {
        ...
            if (client.terminalName === name) {
                this.safeSend(client.ws, killed
                    ? { t: 'exit', code: -1, reason: 'Closed by operator' }
                    : { t: 'exit', code: exitCode ?? 0 });
```

### 6. `src/webview/terminals.js` — render the kill distinctly

**Context.** The `exit` branch at `:7584-7589`.

**Logic.** One extra reason, handled alongside the existing `Lagging client evicted` filter. The pane still latches and still goes read-only — the terminal really is gone — but the line tells the truth.

```js
                        const line = frame.reason === 'Closed by operator'
                            ? '[Terminal closed]'
                            : `[Process Exited with code ${exitCode}]`;
                        entry.term.write(`\r\n\x1b[31m${line}\x1b[0m\r\n`);
```

Note the existing unguarded `entry.term.write` on this branch — the sibling `error` branch guards with `if (entry.term)` (`:7571`) but this one does not, so an `exit` arriving before the view materialises throws into the `onmessage` catch and the pane latches silently with no visible line. Add the same guard while here.

## Verification Plan

1. **Regression, automated.** New contract test in `src/test/`: build a `terminalsMap` entry with `exited: true` and `exitedAt` in the past, a `fleetList` reporting that name `status: 'active'`, run the reconcile, assert `destroyTerminalView` was called for it. Second case: same entry, `fleetList` reporting `exited` — assert it was **not** called (edge case 2, the exit notice must survive).
2. **Oscillation guard.** Entry with `exitedAt` *after* `fetchStartedAt` and an `active` fleet item — assert no teardown.
3. **Same-name replacement.** Entry with `agentInstanceId: 'A'`, fleet reporting the name `active` with `agentInstanceId: 'B'` — assert teardown.
4. **Manual, against the live host.** Reproduce the original report end-to-end: instantiate an agent group, kill one member from the sidebar, confirm the pane prints `[Terminal closed]` rather than `[Process Exited with code 0]`. Then create a terminal that reuses the freed name and confirm the pane heals on the next 5 s poll **without a panel reload** — the reload was the only cure at time of writing, and its absence is the acceptance criterion.
5. **No `dist/` audit.** Per `CLAUDE.md`, testing is via an installed VSIX; `src/` is the source of truth.

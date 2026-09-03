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

What produced the *original* exit frame is not established. The fleet's `recentlyClosed` tombstone map (`ptyFleetService.ts:130`) — populated from the `{type:'closed'}` change event, which fires on **both** death paths (`ptyFleetService.ts:284-291` self-exit and `:598-613` operator kill) — contained only `planner-1`…`planner-6`, `researcher-1`, `coder-1`, an earlier batch that genuinely self-exited at 22:03. It held no `Feature Implementation*` entry. This plan therefore fixes the **latch**, not the trigger: whatever set the flag, the client must be able to leave the state.

> **Line references in this plan were re-verified against HEAD on 2026-08-14.** The originals were captured on 2026-08-13 and `src/webview/terminals.js` has since drifted by roughly +100 lines in this region. Every `:NNN` below is the HEAD line, not the report-time line.

### Trigger, established 2026-09-03

The original report left this open — *"This plan therefore fixes the latch, not the trigger"*. The trigger is now identified, and it changes the shape of the fix.

**The gateway tells a first-attaching client that its terminal is dead.** `terminalWsGateway.ts:1325`, in the attach path, immediately after scrollback replay:

```ts
if (terminal.status === 'exited') {
    this.safeSend(ws, { t: 'exit', code: terminal.exitCode ?? 0 });
}
```

**That notice is correct for a re-attach and wrong for a first attach, and the code cannot tell them apart.** The scenario it exists for is a pane whose socket dropped (the client has a `reconnectTimer`) reattaching to discover the pty died while it was away — real, and worth a notification. But the same path serves a brand-new pane, and it consults `terminal.status` without ever asking whether *this client* previously saw *this terminal* alive.

**The state it guards is only reachable by racing it.** Exited terminals are removed from the fleet — the `recentlyClosed` tombstone map exists precisely because it covers *"terminals no longer in the fleet"* (`ptyFleetService.ts:165`), and `ptyListTerminals` returns no `exited` entries. So a dead seat is not listed, not selectable, and cannot be seated into a pane. `terminal.status === 'exited'` at attach time is the window between a pty dying and its handle being dropped.

**Why delegates and not the head.** Seats are spawned in order — observed 2026-09-03: head `Coding` (pid 1976821), then `Coding-coder-1` (1977114), `-coder-2` (1977430), `-intern` (1978383). The head's handle exists well before its pane attaches. Delegate panes attach into the spawn sequence, which is where the window is.

**And "code 0" is a manufactured claim, not an observation.** The absent-value default is applied twice on the same field:

```ts
{ t: 'exit', code: terminal.exitCode ?? 0 }                          // gateway :1325
const exitCode = typeof frame.code === 'number' ? frame.code : 0;    // terminals.js :11252
```

A handle that recorded no exit code renders as **"exited cleanly"** — the most reassuring reading of no information at all. This is the same defect as the `kill()` case already noted in this plan (an operator kill reported as code 0), reached by a different route.

### Root cause

**`entry.exited` is written in three places and cleared in none, and every recovery path in the client is gated behind it.**

Set at:
- `src/webview/terminals.js:7667` — `error` frame.
- `src/webview/terminals.js:7683` — `exit` frame (also writes the `[Process Exited with code N]` line at `:7684` and sets `term.options.disableStdin = true` at `:7685`).
- `src/webview/terminals.js:6924` — `destroyTerminalView`, which then deletes the entry (`:6969`), so this one is terminal by construction.

Once latched, four separate mechanisms each decline to recover:

1. **`resolveInputState` (`:3641`)** short-circuits on it — `if (entry.exited || (entry.term && entry.term.options.disableStdin))` at `:3648` returns `read-only` before the socket state is ever consulted. Verified byte-for-byte identical in the shipped bundle (`ht()` in the served `terminals.js`), so this is not a `src`/`dist` drift.
2. **`ws.onclose` (`:7694`)** — `if (entry.exited) { return; }` at `:7696`, before the reconnect scheduler at `:7705-7715`. The socket will never be retried.
3. **`sanitizePaneAssignments` (`:1825`)** drops a slot only when its name is **absent** from `fleetList`. A name that is present *and active* keeps both its slot and its poisoned entry. There is no comparison anywhere between "the client thinks this is dead" and "the fleet says it is alive".
4. **`armDetachTimer` (`:356`)** does contain a teardown for exited entries — but it fires only when the terminal is **unassigned** (`!paneAssignments.includes(name)`, `:360`) and only after `DETACH_GRACE_MS` (5 min, `:345`). A pane the operator keeps seated, or re-seats within the grace window, is never swept. Its comment even cites `entry.exited` as a trusted death signal (`:366`), which is exactly the assumption that breaks here.

So assignment does not imply attachment: `renderPaneGrid` (`:3846`) / `updatePaneElement` (`:4453`) reuse whatever `terminalsMap` already holds for a name — `updatePaneElement` builds a view only when the map has no entry (`if (!entry) { createTerminalView(assignedName, contentEl); }`, `:4680-4682`). Selecting the terminal from the sidebar re-seats the **same latched entry**, which is why the operator saw read-only on a terminal they had just picked.

**Secondary defect — the exit report is dishonest for a kill.** `PtyFleetService.kill()` (`:598`) emits `{ type: 'closed', name }` with **no `code`** (`:612`). The gateway forwards that as `{ t: 'exit', code: exitCode ?? 0 }` (`terminalWsGateway.ts:728`), so an operator-initiated kill renders as `[Process Exited with code 0]` — identical to an agent exiting successfully. The self-exit path (`ptyFleetService.ts:290`) does pass a real `code`, and the `FleetChangeEvent` type comment (`:103-105`) already documents `code` as *"undefined for an operator-initiated kill()"*, so the distinction exists in the type and is thrown away at the wire.

## Metadata

- **Complexity:** 5
- **Tags:** frontend, ui, bugfix, reliability
- **Project:** Browser Switchboard

> **Superseded:** **Complexity:** 4; **Tags:** frontend, terminals, webview, bugfix, reliability; *(No project pin — the request named no project, and the workspace name is not a project.)*
> **Reason:** Three corrections. (a) `terminals` and `webview` are not in the allowed tag list — invented tags are dropped by the parser, so the plan carried two dead tags and lost `ui`. (b) The change is not single-file: it touches `src/webview/terminals.js`, `src/standalone/ptyFleetService.ts`, `src/standalone/terminalWsGateway.ts` **and** `src/test/terminal-chrome-not-in-buffer.test.js` (see §7 — two of its assertions go red on the §6 edit), with one genuine ordering hazard (the oscillation guard). That is the textbook "Mixed (5-6)" profile, not "Routine single-file (1-4)". (c) This subtask belongs to the *Browser Switchboard* project, like both of its siblings in this feature; leaving it unpinned made the feature's three cards inconsistent on the board.
> **Replaced with:** Complexity 5; allowed tags only; pinned to Browser Switchboard. Routing is unchanged (4-6 → Coder).

## User Review Required

- None.

## Complexity Audit

### Routine

- A reconcile pass over `terminalsMap` after `fleetList` is assigned in `fetchTerminalList` (`:1550`, assignment at `:1562`, `sanitizePaneAssignments()` at `:1574`).
- Stamping `entry.exitedAt` alongside the two frame-driven `entry.exited = true` writes.
- Recording `agentInstanceId` on the entry when a view is built.
- Passing a kill sentinel through `kill()` → `untrackTerminalData` → the `exit` frame.

### Complex / Risky

- **Do not clear `entry.exited` in place.** Flipping the boolean back to `false` leaves a disposed-or-desynced xterm, a dead socket, `disableStdin` still `true` on the terminal instance, and a stale `lastSeq` that would make the gateway replay from the wrong point. The only correct recovery is a full teardown through `destroyTerminalView` (`:6915`) — which disposes the xterm and releases its WebGL context through the holder (`MAX_WEBGL_CONTEXTS` is 12 per **document**, `:353`) — and letting the next `renderPaneGrid` build a fresh view. Reuse the existing teardown; do not write a partial reset.

- **Name is not identity.** `PtyFleetService.kill()` deletes the handle from `this.terminals` *before* killing (`:607` then `:609`), so a killed name is immediately free and `create()`'s uniquifier (`:189-193`) will hand the identical name to a new pty. A self-exited handle, by contrast, stays in the map with `status: 'exited'` (`:285-286`) and forces the next terminal to `${role}-${n+1}`. So "same name" spans two different processes only on the kill path — which is precisely the path this bug rides. Carry `agentInstanceId` on the entry so the reconcile can tell the two apart — see §3 for what it is actually used for, which is **not** the teardown decision (the fleet's `status` already covers that) but the ordering guard. `agentInstanceId` is minted per handle (`ptyFleetService.ts:197`) and **is** carried in the fleet-list projection on both hosts — `src/standalone/ptyHost.ts:143-145` and `src/standalone/bootstrap.ts:1223-1234` — so the field is available client-side without a wire change.

- **Do not reconcile on `fleetList` alone without an ordering guard.** The fleet list is refreshed on a 5 s poll. A terminal that dies between the fetch and the frame will briefly read `active` in a snapshot that predates its `exit` frame. Reconciling on that snapshot tears down a pane that is correctly showing `[Process Exited]`, reattaches, and `setupClient` immediately re-sends `{t:'exit'}` (`terminalWsGateway.ts:1069`) — the same state, one flicker later. Harmless but avoidable, and it becomes a rebuild loop if the registry is ever stale in the other direction. Gate on the fetch having *started* after `entry.exitedAt`.

- **The clock for that guard must be monotonic.**

  > **Superseded:** Stamp `entry.exitedAt = Date.now()` and compare against a `Date.now()` taken before the fetch.
  > **Reason:** `Date.now()` is wall-clock. An NTP step or a laptop sleep/resume between the latch and the next poll can move it backwards, which inverts the comparison and silently disables the heal (or fires it against a snapshot that really is older). Both stamps live in the same document and are only ever compared to each other, so there is no reason to use a clock that can jump.
  > **Replaced with:** `performance.now()` for **both** the `exitedAt` stamp and the `fetchStartedAt` capture — monotonic, same time origin, same document, and already the clock this file uses for frame-level timing.

- **`fetchStartedAt` must be stamped at the pty-list request, not at the top of the function.** `fetchTerminalList` opens with `await fetchKanbanColumnStructure()` (`:1551`) before it issues `fetch('/terminals/verb/ptyListTerminals')` (`:1553`). Stamping at the function's first line dates the snapshot *earlier* than it is, which biases the guard toward "too old to heal" and can strand a latched pane for a full extra poll.

## Edge-Case & Dependency Audit

1. **Scrollback is not lost by the rebuild.** `destroyTerminalView` discards the client-side xterm buffer, but the gateway keeps a per-terminal scrollback ring (`MAX_SCROLLBACK_BYTES`, `terminalWsGateway.ts` `scrollbackBuffers`) and replays it on attach as one concatenated frame. The rebuilt pane repaints from the ring. The `[Process Exited with code 0]` line does **not** come back — it is written client-side, never into the ring — which is the desired outcome.
2. **The exit line must stay for a genuinely dead terminal.** `terminal-chrome-not-in-buffer.test.js:65-75` asserts the exit notice is the only record of the exit code and nothing may redraw over it. The reconcile must fire only when the fleet reports the terminal **not** exited; a dead terminal's pane is untouched.
3. **`error` frames (`code 4404`, "No such terminal") must heal too.** A pane seated before its pty finished spawning gets `{t:'error'}` (`terminalWsGateway.ts:932`), which latches `exited` without printing an exit line — the same dead end, reached during the ~750 ms-apart delegate spawn window that this very group creation walks through. Stamp `exitedAt` on that branch as well (`:7667`).
4. **Solo pop-out windows.** `?solo=1` documents share the same `terminalsMap` and `fetchTerminalList`, so the reconcile covers them. `checkSoloNotFound` keys on `fleetList` membership, not on `entry.exited`, and is unaffected — but confirm the rebuild does not race its `paneGridEl.style.display` toggle.
5. **Multi-window cockpit.** Each document owns its own `terminalsMap`; the reconcile is per-document and needs no coordination. A second window that never saw the exit frame was never latched.
6. **`pinnedPanes` / `undoSnapshot`.** Neither is touched — the slot keeps its name, only the view behind it is rebuilt. `sanitizePaneAssignments`' pin-expiry and undo-invalidation blocks key on slot emptiness and name liveness respectively, and this change empties no slot.
7. **`armDetachTimer` still needed.** The 5-minute sweep remains correct for genuinely dead unassigned terminals. Do not remove it; the new reconcile handles the live-but-latched case it deliberately excludes.
8. **`startupCurtains`.** `dismissStartupCurtain` runs on both frame branches before the latch is set. A rebuild after a heal re-enters `createTerminalView` without arming a curtain (curtains are armed only for terminals **this tab** created, `:1600` region), so no curtain can strand.
9. **Kill sentinel is additive.** Adding a field to the `exit` frame is backward compatible: an older client ignores unknown fields and keeps printing its current message. No version negotiation needed, no migration — this is wire shape, not persisted state.
10. **`Lagging client evicted` stays special-cased.** The client filters that reason out of the exit branch (`:7680`). The gateway sends it as `{ t: 'exit', code: -1, reason: 'Lagging client evicted' }` (`terminalWsGateway.ts:853`) — so the kill sentinel proposed in §5 is not a new frame shape at all, it is the **same** `code: -1` + `reason` discriminator this path already established. Reuse it exactly; do not invent a parallel field. The eviction path must keep its existing early-out.
11. **No confirmation dialogs.** Nothing in this change adds an operator prompt. Per `CLAUDE.md`, and because `window.confirm()` is a silent no-op in VS Code webviews.
12. **Testing surface — source-text, not behavioural.**

    > **Superseded:** A new contract test should assert the invariant directly: *an entry with `exited === true` whose name is `active` in `fleetList` is destroyed on the next fleet refresh.*
    > **Reason:** That test cannot be written. `src/webview/terminals.js` is a browser-only IIFE with **no export surface** — `terminalsMap`, `fleetList`, `fetchTerminalList` and `destroyTerminalView` are all closure-local, and there is no jsdom harness in this repo for it. Every one of the 23 terminal suites in `src/test/` is a *source-text* contract (`fs.readFileSync` + `block(startMarker, endMarker)` + regex), including the two this item cites. A plan that promises a behavioural assertion sends a coder to build a harness that does not exist, or — the likelier failure — to quietly write a regex test and report it as the behavioural one.
    > **Replaced with:** A source-text contract in the established style, asserting the *decisions that are invisible on inspection*: the reconcile exists inside `fetchTerminalList`, it runs **before** `sanitizePaneAssignments()`, it heals through `destroyTerminalView` rather than by assigning `entry.exited = false`, it is guarded on both `exitedAt` and the fleet's `status`, and it compares `agentInstanceId`. Spelled out in the Verification Plan.

13. **`dist/` is not in scope.** Per `CLAUDE.md`, `src/` is the source of truth; the VSIX is rebuilt separately. (Noted only because this bug was diagnosed against the served bundle — the shipped code matched `src` on every line cited here except the delegate-overlay dead code, which is absent from the bundle entirely and is *not* part of this plan.)
14. **Hidden terminals are invisible to the reconcile, and that is correct.** `ptyListTerminals` splits the fleet: `terminals` carries only `!hidden` handles, and hidden ones ride a sibling `hiddenTerminals` key (`bootstrap.ts:1221-1222`, `ptyHost.ts:139-145`). A latched entry for a hidden terminal would therefore find no `fleetItem` and be skipped. That is the right outcome and needs no special case: `sanitizePaneAssignments` already drops any slot whose name is absent from `fleetList`, so a hidden terminal cannot stay seated in a pane in the first place. **Do not "fix" this by scanning `hiddenTerminals`** — that would resurrect pool seats into panes.
15. **A latched entry that is not currently seated is torn down and not rebuilt.** `renderPaneGrid` only materialises views for names in the rendered slot slice, so the reconcile's `destroyTerminalView` on an unassigned latched entry drops it from `terminalsMap` with no immediate rebuild. This is correct and cheap: the entry was rendering a lie, the gateway's scrollback ring replays on the next attach, and `armDetachTimer` would have swept it within 5 minutes anyway. Do not add an "only heal seated panes" guard — that reintroduces the re-seat-a-latched-entry path this plan exists to close.
16. **The reconcile must iterate a snapshot of `terminalsMap`, not the live map.** `destroyTerminalView` calls `terminalsMap.delete(name)` (`:6969`); mutating the map inside a `for…of` over its live iterator is the classic skip-the-next-key bug. `Array.from(terminalsMap.entries())` in the proposed code is load-bearing, not stylistic.

## Dependencies

- None external. Four files: `src/webview/terminals.js`, two small changes in `src/standalone/ptyFleetService.ts` and `src/standalone/terminalWsGateway.ts`, and the contract-test repair in `src/test/terminal-chrome-not-in-buffer.test.js` (§7).
- **Shares `terminals.js`** with the link-up preset plan and the teams subtasks. Different regions (fleet refresh + socket handler vs. the link-up modal); they serialise under the project's one-stream-per-file rule.
- **Within this feature — land *Seating a Terminal Corrupts Sibling Pane Glyphs* first.** Two concrete couplings, not a vague "same file":
  - The heal path here calls `destroyTerminalView`, which releases a WebGL context, and it can do so for several panes on a single 5 s poll. The glyph subtask replaces the per-document context budget with a cross-document one and makes `holder.release()` publish the freed slot. Landing that first means this plan's heal path frees budget correctly the moment it ships; landing it second means the heal churns contexts against a ceiling that is still counted per-document.
  - Both plans add a field to the **same entry literal** in `createTerminalView` (`:6989`): `agentInstanceId` here (§2), `needsAtlasRebuild: false` there. Whichever lands second rebases one line. Trivial, but it is the only textual collision between the two.
- **Independent of the pane-header-role subtask.** That plan owns `updatePaneElement`'s title row and reads `fleetItem.status`, never `entry.exited`; nothing here changes what it renders.
- **Related but deliberately out of scope:** delegate children (`parentInstanceId` set) are excluded from all five seating/grouping paths in the shipped bundle, and `toggleDelegateView` — the only code that was meant to reach them — has **zero call sites** in `src` and is absent from the built bundle. That is a separate defect with a separate root cause and belongs in its own plan.

## Adversarial Synthesis

The key risk is oscillation: a reconcile that fires on a fleet snapshot older than the exit frame will tear down a correctly-dead pane, reattach, receive `{t:'exit'}` again from `setupClient`, and repeat. Closed by requiring the fleet fetch to have started after `entry.exitedAt`. The second risk is a partial reset leaving a half-lived xterm — closed by routing every heal through the existing `destroyTerminalView` teardown rather than clearing the flag in place. The third is same-name-different-process, which the kill path makes reachable — closed by keying on `agentInstanceId`.

The rejected alternative is healing on the socket instead of on the fleet: retry the connection on a timer whenever `entry.exited` is set, and treat a successful `hello` as proof of life. That inverts the cost — it puts a reconnect storm against a genuinely dead terminal on the hot path, and `setupClient` answers a dead attach with another `exit` frame anyway, so it learns nothing the fleet list does not already say for free on a poll that is already running.

The fourth risk is the one the original draft missed entirely: §6 changes the exit line from a literal template into a `${line}` interpolation, and `terminal-chrome-not-in-buffer.test.js` matches on the **source text of the write call**. Two of its assertions go red on a change that is behaviourally correct. Closed by §7, which repairs those assertions to encode the new invariant rather than deleting them — the suite's job is to stop a *notice* being spliced into the buffer, and that job survives the edit.

## Proposed Changes

### 1. `src/webview/terminals.js` — stamp when the latch was set

**Context.** The two frame-driven writes at `:7667` (`error`) and `:7683` (`exit`).

**Logic.** Record *when* the client learned the terminal was dead, so a later fleet snapshot can be compared against it. A monotonic timestamp is enough; no new state machine.

```js
    entry.exited = true;
    // When the client learned this terminal was dead. The reconcile in
    // fetchTerminalList only heals from a fleet snapshot fetched AFTER this
    // instant — an older snapshot legitimately still reads `active` and would
    // tear down a pane that is correctly showing its exit notice.
    // performance.now(), NOT Date.now(): both stamps live in this document and
    // are only ever compared to each other, and a wall-clock step (NTP, sleep/
    // resume) between the latch and the next poll would invert the comparison
    // and silently disable the heal.
    entry.exitedAt = performance.now();
```

Apply to **both** branches. The `error` branch matters as much as `exit`: a pane seated during the ~750 ms delegate-spawn window takes a `4404` and latches with no visible exit line at all.

Do **not** stamp it in `destroyTerminalView` (`:6924`). That write is followed by `terminalsMap.delete(name)` four lines later, so no entry survives to be reconciled; adding a stamp there implies a recoverable state that does not exist.

### 2. `src/webview/terminals.js` — record process identity on the entry

**Context.** The entry literal built in `createTerminalView` (`:6989-7020`), alongside the other identity/renderer fields.

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

**Context.** `fetchTerminalList` (`:1550`), immediately after `fleetList = data.terminals` (`:1562`) and **before** `sanitizePaneAssignments()` (`:1574`). Order matters in both directions: after the assignment because the reconcile reads the fresh list, and before the sanitize/`renderPaneGrid()` pair (`:1574-1576`) because `renderPaneGrid` → `updatePaneElement` (`:4680-4682`) is what rebuilds the torn-down view in the same pass — the operator never sees an empty pane.

**Logic.** For every entry the client believes is dead, ask the fleet. If the fleet says that name is alive — or alive under a different `agentInstanceId` — the client's view describes a process that no longer exists behind that name. Tear it down; `renderPaneGrid` on the next line rebuilds it and `connectTerminalSocket` attaches.

```js
    const fetchStartedAt = performance.now();   // stamped immediately before the
                                                // ptyListTerminals fetch — NOT at the
                                                // top of the function, which sits behind
                                                // an awaited fetchKanbanColumnStructure()
    ...
    fleetList = data.terminals;

    // Heal panes whose `exited` latch no longer matches reality. entry.exited is
    // set by an exit/error FRAME and never cleared, and every recovery path is
    // gated behind it: resolveInputState short-circuits to read-only (:3648),
    // ws.onclose declines to reconnect (:7696), sanitizePaneAssignments only
    // drops slots whose name is ABSENT (:1825), and armDetachTimer's sweep needs
    // the pane to be unassigned for 5 minutes (:356). A re-seated pane therefore
    // reuses the latched entry and renders read-only over a live pty — which is
    // exactly this bug. Teardown, not an in-place flag reset: the xterm is
    // disposed, disableStdin is on the instance, and lastSeq is stale.
    // Array.from, NOT the live iterator: destroyTerminalView deletes from
    // terminalsMap (:6969), and mutating a Map mid-for-of skips the next key.
    for (const [name, entry] of Array.from(terminalsMap.entries())) {
        if (!entry.exited) { continue; }
        const fleetItem = fleetList.find(t => t.friendlyName === name);
        if (!fleetItem || fleetItem.status === 'exited') { continue; }
        // Both ids present and DIFFERENT ⇒ kill() freed the name and a new pty took
        // it (ptyFleetService.ts:607 deletes before killing; :189-193 re-mints the
        // same `${role}-${n}`). The latch we hold was set by the OLD process, so the
        // oscillation the age guard exists to prevent is impossible — setupClient
        // cannot re-send an exit for a terminal the fleet reports active. Heal now
        // rather than stranding the pane for another poll. A null id on either side
        // falls through to the age guard: conservative, never "never heal".
        const replaced = entry.agentInstanceId && fleetItem.agentInstanceId
            && entry.agentInstanceId !== fleetItem.agentInstanceId;
        // Otherwise only heal from a snapshot NEWER than the latch. An in-flight
        // fetch that predates the exit still reads `active` and would tear down a
        // pane correctly showing its exit notice, whereupon setupClient re-sends
        // {t:'exit'} (terminalWsGateway.ts:1069) and we oscillate.
        if (!replaced && entry.exitedAt && entry.exitedAt > fetchStartedAt) { continue; }
        // Alive under this name — either it never died, or a new pty took the
        // name after a kill. Both mean this view is describing nothing.
        destroyTerminalView(name);
    }
```

`fetchStartedAt` is stamped before the `await fetch(...)`, not after — the point is the age of the data, not when it was parsed.

**Where `agentInstanceId` actually earns its place — it overrides the ordering guard.**

> **Superseded:** "Key the reconcile on `agentInstanceId` where available so a same-name replacement is also rebuilt, not just an active-name mismatch."
> **Reason:** As written that is a no-op. The loop already tears down on *"the fleet says this name is not exited"*, which is true for a same-name replacement as much as for a never-died terminal — the identity comparison changes no outcome and would ship as decoration. The field is genuinely load-bearing somewhere else: in the **age guard**. On a kill-then-recreate, the fresh `exitedAt` belongs to the *old* process while the fleet item is the *new* one, so `exitedAt > fetchStartedAt` suppresses a heal that carries no oscillation risk at all — the exit frame provably did not come from the process now holding the name. That is a real stranded-pane window of up to one 5 s poll on the exact path this bug rides.
> **Replaced with:** compare identity, and let a mismatch **bypass the ordering guard** — the `replaced` branch in the loop body above. The teardown decision itself stays keyed on the fleet's `status`; identity only decides whether the age guard applies.

### 4. `src/standalone/ptyFleetService.ts` — mark an operator kill as such

**Context.** `kill()` at `:598`; the `closed` emit at `:612`.

**Logic.** The `FleetChangeEvent` comment (`:103-105`) already says `code` is *"undefined for an operator-initiated kill()"*, but undefined is also what a missing code looks like downstream. Make the intent explicit on the event rather than inferring it from an absence.

```js
        this.emitter.emit('change', { type: 'closed', name, killed: true });
```

Extend the `closed` variant of `FleetChangeEvent` with an optional `killed?: boolean`.

### 5. `src/standalone/terminalWsGateway.ts` — stop reporting a kill as exit code 0

**Context.** `untrackTerminalData` (`:704`) and its `exit` send (`:728`); the change-event subscription at `:497`.

**Logic.** Forward the flag so the client can say what actually happened. `code: 0` on a kill reads as "your agent finished cleanly", which is the opposite of the truth and sends the operator looking for a completion report that was never written. The `{ code: -1, reason }` shape below is not new — it is exactly what the lagging-client eviction already sends at `:853`, so the client's existing `frame.reason` discrimination is the mechanism being reused rather than invented.

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

**Context.** The `exit` branch at `:7671-7687`; the write at `:7684`.

**Logic.** One extra reason, handled alongside the existing `Lagging client evicted` filter. The pane still latches and still goes read-only — the terminal really is gone — but the line tells the truth.

```js
                        const line = frame.reason === 'Closed by operator'
                            ? '[Terminal closed]'
                            : `[Process Exited with code ${exitCode}]`;
                        entry.term.write(`\r\n\x1b[31m${line}\x1b[0m\r\n`);
```

Note the existing unguarded `entry.term.write` on this branch — the sibling `error` branch guards with `if (entry.term)` (`:7668`) but this one does not, so an `exit` arriving before the view materialises throws into the `onmessage` catch and the pane latches silently with no visible line. Add the same guard while here. **Guard the write only** — `entry.exited`, `exitedAt` and `refreshInputState` must stay outside it, or an early `exit` frame leaves the pane accepting input into a dead pty.

### 7. `src/test/terminal-chrome-not-in-buffer.test.js` — repair the two assertions §6 turns red

**This is a required part of the change, not follow-up.** The suite matches on the **source text of the write call** (`/entry\.term\.write\(`[^`]*`[^)]*\)/g`), so hoisting the message into a `const line` breaks it even though the behaviour is exactly what the suite is protecting:

- `:49-63` — *"no bracketed connection/throttle notices are written into the buffer"* filters the write calls through `/\\r\\n.*\\x1b\[\d*m.*\[.*\]/` and asserts exactly one survivor matching `/Process Exited with code/`. After §6 the write argument is `` `\r\n\x1b[31m${line}\x1b[0m\r\n` ``, which contains no `[…]` pair — **the filter yields 0 and the assertion fails.**
- `:65-75` — *"the only bracketed buffer write that remains is the process-exit line"* slices the exit arm and asserts its single write matches `/Process Exited with code/`. The literal now lives in the `const line` above the call — **fails.**
- `:77-92` — the call-site count (`exactly 5 entry.term.write(`) is **unaffected**; §6 adds no write site. Leave it alone.

The invariant the suite exists for is *"no client notice is spliced into the pty's screen buffer"*, and that is untouched. Re-point the two assertions at the assembled line rather than the call argument:

```js
test('the only bracketed buffer write that remains is the process/close notice', () => {
    const exitArm = block(terminalsJs, "frame.t === 'exit'", "} catch (err) {");
    const writes = exitArm.match(/entry\.term\.write\(`[^`]*`[^)]*\)/g) || [];
    assert.ok(writes.length === 1, `exactly one write expected in the exit arm, found ${writes.length}`);
    // The message is assembled into `line` above the call so an operator kill can be
    // told apart from a clean exit (the gateway sends code:-1 + reason:'Closed by
    // operator', the same shape the lagging-client eviction uses). Both spellings are
    // notices ABOUT a process that is gone — the prohibition is on notices written
    // over a process that is still running.
    assert.ok(/Process Exited with code/.test(exitArm),
        'the clean-exit line must still carry the exit code — it is the only record of it');
    assert.ok(/\[Terminal closed\]/.test(exitArm),
        'an operator kill must not be reported as "[Process Exited with code 0]"');
    assert.ok(!/Disconnected — reconnecting/.test(exitArm),
        'the [Disconnected — reconnecting…] notice must be gone from the exit arm');
});
```

and, in the first test, filter on the **arm** rather than on the write argument:

```js
    // The exit notice is now assembled above the call, so the bracketed text is not
    // inside the write() argument any more. Scan the exit arm for it instead, and
    // keep asserting that no OTHER bracketed write exists anywhere in the file.
    const writes = terminalsJs.match(/entry\.term\.write\(`[^`]*`[^)]*\)/g) || [];
    const bracketed = writes.filter(w => /\\r\\n.*\\x1b\[\d*m.*\[.*\]/.test(w));
    assert.ok(bracketed.length === 0,
        `no bracketed notice may be written inline any more, found: ${bracketed.join(' | ')}`);
    const exitArm = block(terminalsJs, "frame.t === 'exit'", "} catch (err) {");
    assert.ok(!/Input queue drained|Pasting|Disconnected — reconnecting|Terminal unavailable/.test(exitArm),
        'none of the four removed notices may survive in the buffer');
```

### 8. `src/test/terminal-exited-latch-reconcile-contract.test.js` — new source-text contract

New file, in the established style (`fs.readFileSync` + `block(startMarker, endMarker)` + regex — see `terminal-pane-grid-reconcile-contract.test.js`). It pins the decisions that are invisible on inspection and each of which was wrong in a first pass:

```js
const FETCH = block('async function fetchTerminalList()', 'function checkSoloNotFound(');

test('the reconcile heals by teardown, never by clearing the flag', () => {
    assert.ok(FETCH.includes('destroyTerminalView(name)'),
        'the heal must route through the existing teardown — an in-place reset leaves a disposed xterm, disableStdin on the instance and a stale lastSeq');
    assert.ok(!/entry\.exited\s*=\s*false/.test(terminalsJs),
        'entry.exited must never be cleared in place, anywhere in the file');
});

test('the reconcile runs after the fleet assignment and before the sanitize/render pair', () => {
    const assignAt = FETCH.indexOf('fleetList = data.terminals');
    const healAt = FETCH.indexOf('destroyTerminalView(name)');
    const sanitizeAt = FETCH.indexOf('sanitizePaneAssignments()');
    assert.ok(assignAt < healAt && healAt < sanitizeAt,
        'the heal reads the fresh list and must precede renderPaneGrid, which is what rebuilds the torn-down view in the same pass');
});

test('the ordering guard exists and is bypassed only on a process replacement', () => {
    assert.ok(FETCH.includes('entry.exitedAt > fetchStartedAt'),
        'without the age guard a snapshot older than the exit frame tears down a correctly-dead pane and oscillates');
    assert.ok(/const fetchStartedAt = performance\.now\(\)/.test(FETCH),
        'monotonic clock — a wall-clock step would invert the comparison and disable the heal');
    assert.ok(FETCH.includes('entry.agentInstanceId !== fleetItem.agentInstanceId'),
        'a kill frees the name immediately, so the same name can front a new process; that case must skip the age guard');
});

test('a genuinely dead terminal is left alone', () => {
    assert.ok(/fleetItem\.status === 'exited'.*continue|!fleetItem \|\| fleetItem\.status === 'exited'/s.test(FETCH),
        'the exit notice is the only record of the exit code — a pane whose fleet entry is exited must not be rebuilt over it');
});

test('the map is snapshotted before iteration', () => {
    assert.ok(FETCH.includes('Array.from(terminalsMap.entries())'),
        'destroyTerminalView deletes from terminalsMap; iterating the live map skips the next key');
});

test('an operator kill is distinguishable from a clean exit on the wire', () => {
    const gateway = fs.readFileSync(path.join(__dirname, '../standalone/terminalWsGateway.ts'), 'utf8');
    assert.ok(/reason: 'Closed by operator'/.test(gateway),
        "code:0 on a kill reads as 'your agent finished cleanly' — the opposite of the truth");
    const fleet = fs.readFileSync(path.join(__dirname, '../standalone/ptyFleetService.ts'), 'utf8');
    assert.ok(/type: 'closed', name, killed: true/.test(fleet),
        'the kill path must state the intent on the event rather than leaving it inferred from a missing code');
});
```

**Additional — gate the attach-time exit frame (added 2026-09-03).** Clearing the latch fixes recovery and leaves the cause. Also:

1. **Send the exit frame only to a client that previously saw the terminal live.** Track prior attachment per client/terminal and condition `terminalWsGateway.ts:1325` on it. A first attach must never be told the seat is dead — if the handle is genuinely gone the socket already closes `4404`, which is the honest signal.
2. **Stop defaulting an absent exit code to 0.** Omit `code` when `terminal.exitCode` is null/undefined (the same "omit, do not fabricate" rule this file already applies to `bracketedPaste` and `modes` at `:1306-1307`), and render the client-side unknown case as `[Process Exited (code unknown)]` rather than `code 0`. This also fixes the `kill()` ambiguity named in the Goal.


## Verification Plan

### Automated Tests

1. **`node src/test/terminal-exited-latch-reconcile-contract.test.js`** — the new suite in §8. Source-text, in this repo's established style; a behavioural harness does not exist for `terminals.js` (see Edge-Case 12).
2. **`node src/test/terminal-chrome-not-in-buffer.test.js`** — must be green *after* the §7 repair. Run it **before** the repair too, to confirm the two assertions fail for the reason §7 predicts and not for some other one.
3. **`node src/test/terminal-renderer-lifecycle-contract.test.js`** and **`terminal-flow-control-contract.test.js`** — unchanged by this plan; run them as the regression floor, since the heal path calls `destroyTerminalView` and both suites assert on its teardown ordering.
4. `node --check src/webview/terminals.js` clean.

### Manual

5. **Against the live host — the reported repro.** Instantiate an agent group (head + 3 delegates), seat the coder terminals from the sidebar, and confirm they come up accepting input rather than `[Process Exited with code 0]` + read-only.
6. **The heal, without a reload.** Force the latch (kill a member from the sidebar, then create a terminal that reuses the freed name) and confirm the pane heals on the next 5 s poll **without a panel reload** — the reload was the only cure at time of writing, and its absence is the acceptance criterion.
7. **The kill line.** Kill a seated terminal and confirm the pane prints `[Terminal closed]`, not `[Process Exited with code 0]`.
8. **The dead pane is left dead.** Let an agent exit on its own; confirm `[Process Exited with code N]` stays on screen across at least three fleet polls with no flicker, no reattach, and no rebuild.
9. **No `dist/` audit.** Per `CLAUDE.md`, testing is via an installed VSIX; `src/` is the source of truth.

---

**Recommendation: Send to Coder.** Complexity 5 — the reconcile itself is routine, but it spans four files, changes a wire frame, and carries one genuine ordering hazard (the oscillation guard) plus a contract-test repair that must land in the same commit or the suite ships red.

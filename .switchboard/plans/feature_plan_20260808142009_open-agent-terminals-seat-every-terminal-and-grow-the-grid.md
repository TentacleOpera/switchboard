# OPEN AGENT TERMINALS — seat every terminal it creates, grow the grid to fit, and paint the first curtain

## Goal

Make the browser terminals cockpit's **OPEN AGENT TERMINALS** button produce the result the operator expects: every terminal it creates appears, in one coherent batch, in a grid sized to hold them, each wearing the startup curtain while its CLI boots.

Three defects were reported from the same click, and all three trace back to `openAllTerminals()` in `src/webview/terminals.js`:

1. **The first terminal appears instantly; the rest appear seconds later.**
2. **The first terminal never gets the startup ("loading") curtain**, while later ones do.
3. **Six terminals produce a grid of four** — two terminals are created but never seated, with no explanation on screen.

### Problem analysis / root cause

All three are a consequence of **two independent seating mechanisms with different timing, plus a layout that is never allowed to grow**.

**Root cause A — pane 0 is seated by a different code path than panes 1..N.**

`openAllTerminals()` (`src/webview/terminals.js:3768`) creates terminals **sequentially** (deliberately — `ptyFleetService.create()` allocates `${role}-${n}` off its own map, so concurrent creates for one role can collide on a name). Each create is a full HTTP round trip plus a pty spawn, ~750 ms. Seating only happens **once, after the whole loop**:

```js
await fetchTerminalList();
if (created > 0) { fillEmptyPanes(); }
```

> **Superseded:** "Each create is a full HTTP round trip plus a pty spawn, ~750 ms."
> **Reason:** The magnitude is right but the attribution is wrong, and the wrong attribution is what made root cause B read as a coin-flip race instead of a certainty. The dominant cost is neither HTTP nor spawn: `PtyFleetService.create()` ends with `await this.injectStartupCommand(handle, role)` (`src/standalone/ptyFleetService.ts:208`), and `injectStartupCommand` does `await new Promise(resolve => setTimeout(resolve, SHELL_READINESS_DELAY_MS))` with `SHELL_READINESS_DELAY_MS = 750` (`ptyFleetService.ts:7`) — but **only when the role has a configured startup command**. HTTP-on-loopback plus `node-pty` spawn is single-digit milliseconds by comparison.
> **Replaced with:** Each create for a role **with** a startup command blocks the HTTP response for ≥750 ms *after* the terminal already exists and has already been announced; roles **without** a command return in a few milliseconds (`injectStartupCommand` returns before the sleep when `commands[role]` is empty — the same short-circuit the `NO_ROLE = 'shell'` comment at `terminals.js:3535` documents). Six command-bearing agents therefore take ≈4.5 s of pure deliberate sleep, which is the "seconds later" in defect 1.

But the *first* terminal is seated by a completely different mechanism. `terminalWsGateway.initFleetListeners()` (`src/standalone/terminalWsGateway.ts:372-383`) broadcasts `terminalsChanged` from inside `fleetService.onDidChange` — i.e. synchronously during `create()`, before the `ptyCreateTerminal` HTTP response returns. The webview's message handler (`terminals.js:585`) refetches, and `sanitizePaneAssignments()` (`terminals.js:1098`) hits its seed-on-first-load branch:

```js
// Seed pane 0 on FIRST load only.
if (!initialAssignmentDone && fleetList.length > 0) {
    initialAssignmentDone = true;
    if (!paneAssignments.some(name => name !== null)) {
        paneAssignments[0] = fleetList[0].friendlyName;
        activeTerminalName = fleetList[0].friendlyName;
    }
}
```

With an empty cockpit, `fleetList.length` is 0 on the pre-click fetch, so this branch is still armed. The first create trips it, pane 0 renders immediately — and then the branch latches (`initialAssignmentDone = true`), so terminals 2..N get nothing until `fillEmptyPanes()` fires at the end. Hence: one instant pane, then a long gap, then the rest.

**Confirmed against source (clarification).** The latch is *provably* still armed at click time on an empty cockpit: `initialAssignmentDone` is set in exactly two places — `init()`'s solo branch (`terminals.js:429`, solo only) and this branch, which is gated on `fleetList.length > 0`. The page-load `fetchTerminalList()` on an empty cockpit runs `sanitizePaneAssignments()` with `fleetList.length === 0`, so the flag stays `false` and the branch stays loaded until the first create fires it. There is no third writer.

**Root cause B — `armStartupCurtain()` mutates state but never paints.**

`armStartupCurtain()` (`terminals.js:922`) only writes into the `startupCurtains` map. The curtain DOM is created solely by `updatePaneElement()`'s assigned branch (`terminals.js:2597`):

```js
if (startupCurtains.has(assignedName)) {
    renderStartupCurtain(contentEl, assignedName);
}
```

So a curtain is only ever drawn by a pane render that happens **after** the arm. For terminals 2..N that holds: they are armed in the loop, then seated by `fillEmptyPanes()` → `renderPaneGrid()`. For terminal 1 it does not.

> **Superseded:** "the gateway broadcasts `terminalsChanged` **before** the create response resolves, so pane 0's render is racing the `await res.json()` continuation that calls `armStartupCurtain`. When the render wins — the common case, because the broadcast leaves the server first — the curtain is armed into an already-rendered pane and nothing ever repaints it."
> **Reason:** This is not a race with a common case — it is a **deterministic loss**, and specifically a deterministic loss for exactly the terminals that are curtain-eligible. `armStartupCurtain(name, hasStartupCommand)` no-ops unless `hasCommand[role] === true`, and `hasCommand[role]` is computed as `typeof commands[role] === 'string' && commands[role].trim() !== ''` (`GlobalIntegrationConfigService.getPtyVisibleRoles`, `src/services/GlobalIntegrationConfigService.ts:462-466`) — the *same* predicate that decides whether `injectStartupCommand` takes the 750 ms sleep. So `hasCommand[role] === true` ⟺ the create response is withheld for ≥750 ms after the broadcast. The webview's refetch is two loopback round trips (`fetchKanbanColumnStructure()` then `ptyListTerminals`) and lands in single-digit-to-tens of milliseconds. Calling that a race understates it by two orders of magnitude, and treating it as a race invites a fix that merely narrows the window.
> **Replaced with:** For every curtain-eligible terminal, the broadcast → refetch → `sanitizePaneAssignments()` → `renderPaneGrid()` chain completes ~750 ms *before* `await res.json()` resolves and `armStartupCurtain()` runs. Pane 0 is therefore **always** rendered before its curtain is armed, and the curtain is **always** armed into an already-rendered pane that nothing repaints. It then expires silently on its `noOutputTimer`/`quietTimer`. This is an asymmetry with `dismissStartupCurtain()`, which *does* address its nodes directly (`terminals.js:973-981`) rather than relying on a render.

**Root cause B2 — a second, independent curtain killer: the 4 s no-output cap expires curtains 2..N before the loop ends.**

*(Merged 2026-08-10 from the now-deleted `fix-open-all-startup-curtain-timing.md`, which diagnosed this mechanism and nothing else. Retained because it explains why the bug reads as intermittent across layouts, which root cause B alone does not.)*

Root cause B explains terminal **#1** — armed after its pane already rendered. Terminals **2..N** fail differently: their curtain state is armed on time but **deleted by timer before seating**. `armStartupCurtain` starts a 4 s `noOutputTimer` (`CURTAIN_NO_OUTPUT_MS`, `terminals.js:94-97`), and seating only happens after the whole loop:

| Event | Time |
| :--- | :--- |
| create #k resolves; `armStartupCurtain` runs | ≈750·k ms |
| curtain #k's `noOutputTimer` fires (`sawLiveOutput === false`, no socket yet) | ≈750·k + 4000 ms |
| loop ends; `fetchTerminalList()` + `fillEmptyPanes()` seat panes | ≈750·N ms |

Curtain `k` survives to seating only when `750k + 4000 > 750N`, i.e. **`k > N − 5.3`**. `fillEmptyPanes` seats the *first* `slotCount` unseated terminals in `fleetList` order (fleet Map insertion = creation order), so the seated set is `#1..#slotCount` — precisely the set whose curtain state has already expired.

This is why the failure looks intermittent rather than absolute:

- **N = 12 roles, 1/2/4/6-pane layout** → seated `#1..#6` ∩ surviving `#7..#12` = ∅ → **zero** curtains. The reported symptom.
- **N = 12 roles, 3×3 layout** (`slotCount = 9`) → panes 7, 8, 9 *do* curtain. A reviewer testing on 3×3 sees a partial, not total, failure.

Moving seating inside the creation loop (Proposed Change 2) closes this as well as root cause A: once seated within ~1 RTT of arming, the pty's echo of the typed startup command arrives as **replay** (excluded from `bumpStartupCurtain` by the `awaitingReplayFrame` branch, `terminals.js:4797`), the CLI's first real paint 1–4 s later arrives **live** and bumps the curtain, and the 1.2 s quiet timer dismisses it normally — the individual path's proven sequence.

> **Verification note:** do **not** implement this by adding an `await fetchTerminalList();` inside the loop. `src/test/multi-parent-terminals-contract.test.js:257` uses the *first* `await fetchTerminalList();` as a `block()` end marker; an earlier one truncates the extracted body and fails the test for an unrelated reason. See *Edge-Case & Dependency Audit → Regression surface*.

**Root cause C — the grid never grows; it only ever shrinks.**

`fillEmptyPanes()` (`terminals.js:3819`) seats into `getSlotCount(effectiveLayout)` slots and stops. Nothing in the open-all path raises the layout. `currentLayout` is the operator's persisted pick (`terminals.layoutMode`, default `'1'`), and the only automatic layout movement in the panel is `resolveFlooredLayout()` / `applyLayoutFloor()` (`terminals.js:2630`, `3213`), which walks `LAYOUT_FLOOR_ORDER` **downward** — it exists to prevent unreadable subdivisions and can only demote. So a persisted `2x2` (4 slots) plus six created terminals gives exactly the reported symptom: four panes, two terminals parked in the sidebar, no message.

There is a second, compounding path to "grid of 4": if the layout *is* `2x3`, `LAYOUTS['2x3']` requires `minW: 750, minH: 300`. A grid box narrower than 750 floors `2x3` → `1x3` (also 750) → `2x2` (500), landing on four panes again. That path at least raises `#layout-fallback-banner` (`applyLayoutFloor` toggles it on `effectiveLayout !== currentLayout`); the `currentLayout` path is completely silent, which is why this reads as "why has this failed so hard".

`fillEmptyPanes()` is also silent about the remainder in every case — it seats what fits and returns.

## Metadata

- **Complexity:** 6
- **Tags:** frontend, ui, bugfix
- **Project:** Browser Switchboard

> **Superseded:** **Complexity:** 5
> **Reason:** The improve pass added a change the original scoping did not contain: disarming the `initialAssignmentDone` latch from `openAllTerminals()`. That mutates a module-level latch whose only other writer is `init()`'s solo branch and whose reader decides first-paint seating — a small edit with a state-machine blast radius, not a localised one. It also added a persistence-correctness gate (grow-without-persist) that the original tail did not handle. Both push this past "multi-file changes, moderate logic" into the top of the medium band.
> **Replaced with:** **Complexity:** 6 — still one file and still reusing existing patterns, so still a Coder-tier change, but no longer a plain 5.

## User Review Required

None. Two decisions are made here rather than deferred, and both are called out so a veto is cheap:

1. **Auto-grow writes the operator's persisted layout pick.** Opening six agents raises `terminals.layoutMode` to `2x3` and that survives reload. This is intended — a fleet of six collapsing back to one pane on reload is the same defect wearing a different hat — and it is strictly monotonic (`layoutForFleetCount()` early-returns `currentLayout` whenever the fleet already fits, so the pick is never lowered).
2. **Auto-grow only fires when a create is actually planned.** Pressing the button with a fleet that already exceeds the picked layout does **not** grow the grid; a deliberate manual `1` over six live terminals is respected. See Proposed Change 1 for why this gate is load-bearing rather than cosmetic.

## Complexity Audit

### Routine

- Adding a `layoutForFleetCount()` / `growLayoutForFleet()` pair next to the existing `LAYOUTS` / `getSlotCount()` block. The insertion point (after `getMaxSlotCount()`, `terminals.js:714`) is inside no test's `block()` span: `shell-terminal-strip.test.js` ends its block *at* `const LAYOUTS = {`, and `terminal-pane-pinning-contract.test.js` / `terminal-sidebar-groupings-contract.test.js` start theirs at `loadLayoutSettings`. Verified, not assumed.
- Moving `fillEmptyPanes()` from after the create loop to inside it.
- Emitting a `showPaneToast()` line when terminals remain unseated (helper already exists at `terminals.js:885`; it hides the Undo button when `onUndo` is falsy, `terminals.js:902`, so the no-Undo form is already supported and `#pane-toast` already exists in `terminals.html:1449`).

### Complex / Risky

- **Disarming `initialAssignmentDone` from `openAllTerminals()` is a state-machine edit, not a line edit.** It is a module-level latch with exactly two writers and one reader today. Setting it early is the fix that makes A and B stop being timing problems at all, but it must be placed *after* the `wanted.size === 0` early return, or a cockpit with every agent hidden loses first-paint seeding for the rest of the page's life.
- **Curtain paint-on-arm must not violate the pane-grid reconcile contract.** `updatePaneElement`'s stated invariant is "no move when already in place" (`terminals.js:2573-2574`, pinned by `terminal-pane-grid-reconcile-contract.test.js:41`) — a `renderPaneGrid()` from inside `armStartupCurtain()` would risk re-parenting live xterm DOM for a purely visual change. The fix must address the pane's `.pane-content` node directly, exactly as `dismissStartupCurtain()` already does, and must not call `renderPaneGrid()` or `renderSidebarList()`.
- **Growing the layout writes persisted state.** `terminals.layoutMode` is a saved setting shared with the VS Code panel and any other open cockpit window. It must never *shrink* the pick, and it must leave `syncLayoutPickerUI()` truthful. Note that `setLayoutMode()` itself does **not** persist (`terminals.js:1727-1739`) — the picker's own click handler calls `saveLayoutSettings()` separately (`terminals.js:520-522`) — so the grow's persistence is entirely the caller's responsibility. Getting that gate wrong yields a grid that grew for this session but reverts on reload.
- **Per-create seating multiplies `saveLayoutSettings()` calls.** `fillEmptyPanes()` ends with `saveLayoutSettings()`, which is 11 `saveSetting` POSTs. Calling it once per create turns 11 writes into 66 for a six-agent fleet. The loop must seat without persisting, and persist once at the end — and the *final* `fillEmptyPanes()` must also skip its internal persist, or the tail double-writes 22 POSTs.
- **The floor can still demote below the grown layout.** Growing `currentLayout` to `2x3` in a 600px-wide window still renders `2x2`. The grow must be honest about that: `applyLayoutFloor()` stays authoritative for `effectiveLayout`, the banner keeps explaining it, and the unseated-remainder toast covers the rest.

## Edge-Case & Dependency Audit

### Race conditions

- **The broadcast/response ordering is the whole bug, and it is deterministic (see the superseded callout under root cause B).** Any fix that relies on "arm before render" must control the *ordering*, not shrink a window. Disarming the seed latch does control it; adding a paint to the arm is a belt for paths that cannot.
- **Arm-then-seat ordering inside the new loop.** `armStartupCurtain()` runs *before* `fillEmptyPanes()`, so at arm time the new terminal is not yet in `paneAssignments`: `paneAssignments.indexOf(name)` is `-1` and paint-on-arm is a **deliberate no-op** on the open-all path, with the immediately-following `renderPaneGrid()` doing the painting via `updatePaneElement`'s existing branch. This ordering is load-bearing and must not be flipped "for symmetry" — swapping it would make every open-all curtain arrive via the direct-paint path and bypass the reconcile that also clears a previous occupant's curtain (`terminals.js:2589-2591`).
- **`fetchTerminalList()` replaces `fleetList` wholesale** (`fleetList = data.terminals`, `terminals.js:819`). The in-flight `terminalsChanged` refetch can therefore land between the loop's `fleetList.push(data.terminal)` and the next iteration. Harmless: the refetch's payload already contains the terminal (the fleet map was populated before the broadcast), so the push is only a fast-path for command-less roles whose create returns before the refetch. The `if (!fleetList.some(...))` guard keeps it idempotent either way.
- **The pushed entry is a partial projection.** `ptyCreateTerminal` returns `{ friendlyName, role, status }` only (`bootstrap.ts:1192`, `ptyHost.ts:76-83`), while `ptyListTerminals` returns `pid`, `startTime`, `worktreePath`, `cwd`, `lastDataAt` as well. `renderSidebarList()` groups on `item.parentRoot` and `item.worktreePath` (`terminals.js:1508-1522`) — both absent on the partial entry. Benign **specifically here**: open-all posts `{ role }` with no `cwd`/`worktreePath`, so the real entry has no `worktreePath` either and lands in the same `direct` bucket. Do not generalise the push to the `+`/worktree create path, where it would file a worktree terminal under the wrong group until the next refetch.

### Security

- Nothing new. No payload shape changes (`{ role }` only), no new route, no new setting key, no new HTML injected from server data. `showPaneToast()` writes via `textContent`. `renderStartupCurtain()` builds its DOM node-by-node with `textContent` and takes its icon from the local `brandIconUri()` map, not from fleet data.

### Side effects

- **Persisted layout pick changes.** Covered under User Review Required.
- **Write volume.** Per-create `fillEmptyPanes({ persist: false })` plus one trailing `saveLayoutSettings()` = 11 POSTs per open-all, unchanged from today.
- **Fit ladders restart per create.** `fillEmptyPanes()` ends with `batchFitVisiblePanes()`, so a six-create batch restarts the ladder for every already-seated pane six times. Bounded, not a storm: `startFitLadder()` is generation-guarded per terminal name via `fitLadderGen` (`terminals.js:3236`, pinned by `terminal-pane-fit-verification-contract.test.js:127`), so a newer ladder supersedes the older one rather than stacking. Keep the per-create fit — a newly seated pane needs it, and that is what makes panes appear progressively rather than all at once at the end.
- **No final fit if the tail early-returns.** With per-create seating the trailing `fillEmptyPanes()` normally finds nothing unseated and returns at its first guard — *before* `batchFitVisiblePanes()`. That is correct (each pane was already fitted as it was seated) but it means the tail must not *rely* on the trailing call for anything: `saveLayoutSettings()` has to be called explicitly by `openAllTerminals()`, never left to `fillEmptyPanes()`.

### Dependencies & conflicts

- **Top-up, not a fresh fleet.** `openAllTerminals()` only creates what is *missing*. If five of six roles are already live and seated, `created === 1`; the grow must consider the whole live fleet (existing + new), not just `created`, or the grid stays too small.
- **Pinned panes.** `pinnedPanes[i]` slots are occupied and must not be treated as free. `fillEmptyPanes()` already keys off `!paneAssignments[i]`, and a pinned slot always has an assignment (`sanitizePaneAssignments()` expires pins on empty slots, `terminals.js:1075-1077`), so this is already correct — verify, do not re-implement.
- **Kanban-mode panes.** `fillEmptyPanes()` deliberately refuses to seat into `paneModes[i] === 'kanban'` slots. Per-create seating must preserve that skip verbatim; growing the grid is the right answer for a fleet that no longer fits, not bulldozing a kanban pane.
- **Solo mode.** `soloTerminalName` short-circuits `saveSetting()` entirely (`terminals.js:734`) and solo windows have no layout picker. The open-all button lives in `.sidebar-ops` inside `.terminals-sidebar`, which `body.is-solo` hides (`terminals.html:1363`), so this path is **unreachable** in solo — the `is-solo` guard in `growLayoutForFleet()` is belt-and-braces that keeps the helper safe for any future caller, not a live code path.
- **Groups.** `applyGroup()` calls `setLayoutMode(group.layout)` (`terminals.js:1346`). Auto-grow must not fight a group the operator just applied — it runs only from the open-all path, never from a render or a fetch.
- **`2v` is not a grow target.** `LAYOUT_FLOOR_ORDER` is demand-ordered, not slot-ordered, and both `2h` and `2v` hold two panes. The grow ladder must pick `2h` (wide-first, `minH: 0`) and never auto-select `2v`, which stays a manual pick.
- **Nine-slot ceiling.** `getMaxSlotCount()` is 9 (`3x3`). A fleet larger than nine — plausible with several custom agents plus `plannerTerminalCount > 1` — will still leave a remainder. That is the toast's job, not a new layout.
- **Curtain gating is unchanged.** `armStartupCurtain()` no-ops when `hasStartupCommand` is false; a plain shell has no banner to hide. `hasCommand` comes off the same `ptyVisibleRoles` response as `visibleAgents` (`terminals.js:3735-3740`) and defaults to `{}`. Painting on arm must sit *after* that guard, not before it.
- **`jules_monitor` can never be curtain-eligible — and that is correct, not a bug to fix here.** `resolveGridAgents()` adds `wanted.set('jules_monitor', 1)` when `visible.jules !== false` (`terminals.js:3756`), but `hasCommand` is keyed off `Object.keys(visible)` *after* `SYSTEM_ONLY_ROLES` (which contains `jules_monitor`) has been deleted from it (`GlobalIntegrationConfigService.ts:436, 458-466`). So `hasCommand['jules_monitor']` is always `undefined` and its seat never wears a curtain. It also gets no startup command from `PtyFleetService.injectStartupCommand` (the `jules_monitor → 'jules'` fallback at `TaskViewerProvider.ts:5771` is on the extension's `createAgentGrid` path, not this one), so a curtain there would cover nothing. **Do not "fix" this in scope** — but the verification plan must expect it, or step 2 reads as a failure.
- **Rename mid-boot.** `renameTerminal()` re-keys `startupCurtains` and restamps the curtain node. Paint-on-arm adds no new node identity — same `data-terminal` stamp, same `renderStartupCurtain()` — so that path is unaffected.
- **Idempotency.** `renderStartupCurtain()` returns early if `.startup-curtain` exists in the content element (`terminals.js:995`), so a paint-on-arm followed by a normal render cannot double-insert.
- **Double-click the button.** Open-all is a top-up, so a second press creates nothing and `created === 0`; the grow and the toast must both be gated on there being work to report.
- **Regression surface — a live test-marker hazard.** `src/test/multi-parent-terminals-contract.test.js:257` extracts the open-all body as `block(terminalsJs, 'async function openAllTerminals() {', 'await fetchTerminalList();')` and asserts it contains `body: JSON.stringify({ role })`. The end marker is the **first** `await fetchTerminalList();` after the function opens. The rework must therefore keep the create loop *above* the tail `await fetchTerminalList();` and must not introduce an earlier `await fetchTerminalList();` inside the loop — doing so truncates the extracted block before the `fetch` and fails the test for a reason that has nothing to do with the payload it guards.
- **`fillEmptyPanes()` has exactly one caller today** (`terminals.js:3809`), so the new options bag has no other call site to keep compatible. The optional-arg shape is still the right choice for future callers.
- **No `dist/` involvement.** Per project rules, `src/` is the source of truth; the panel is exercised through the installed VSIX. Do not audit `dist/` staleness as part of this work.

## Dependencies

None. This change is confined to `src/webview/terminals.js` plus new test coverage; it consumes only helpers already present in that module (`setLayoutMode`, `renderStartupCurtain`, `cssAttrEscape`, `showPaneToast`, `paneGridEl`, `listEl`) and reads `hasCommand` off the existing `ptyVisibleRoles` response. No server route, verb, schema, setting key, or migration is touched, so it composes with any concurrent verb-engine work under the Browser Switchboard project (PRD contract: one agent stream per provider file — this file is not a provider and is not in that burndown).

## Adversarial Synthesis

**Risk summary.** The three highest risks are (1) the seed-latch disarm, which fixes A and B at the source but mutates a module-level flag whose reader decides first-paint seating — mis-place it and a cockpit with all agents hidden loses seeding for the page's life; (2) auto-grow writing the operator's persisted `terminals.layoutMode`, where a wrong persist-gate produces a grid that grows in-session and reverts on reload, or silently overrides a deliberate manual pick; (3) per-create seating multiplying `saveLayoutSettings()` 6× and restarting fit ladders per create. Mitigations: place the disarm after the `wanted.size === 0` guard and cover it with a source contract; gate the grow on `plannedNew > 0` and persist once in the tail with the trailing `fillEmptyPanes({ persist: false })`; rely on `fitLadderGen`'s existing supersede semantics for the ladders; and keep the tail's `await fetchTerminalList();` where the `multi-parent-terminals-contract.test.js:257` block marker expects it.

## Proposed Changes

### 1. `src/webview/terminals.js` — add a grow ladder next to `LAYOUTS`

Insert after `getMaxSlotCount()` (line 714). Verified to be outside every existing test `block()` span.

```js
    // Grow ladder for open-all. Slot-ordered, unlike LAYOUT_FLOOR_ORDER (which is
    // demand-ordered for the DOWNWARD floor walk). '2v' is deliberately absent: it
    // holds the same two panes as '2h' but stacks them, and auto-picking a stacked
    // pair over a side-by-side one is a taste call that belongs to the operator.
    const LAYOUT_GROW_ORDER = ['1', '2h', '1x3', '2x2', '2x3', '3x3'];

    /**
     * Smallest layout that seats `count` terminals, never smaller than what the
     * operator already picked. Returns currentLayout when nothing needs to change.
     *
     * Monotonic by construction: the early return covers count <= currentSlots, and
     * LAYOUT_GROW_ORDER is slot-ascending, so the first rung that fits can never have
     * fewer slots than currentLayout.
     *
     * This is the ONLY upward layout movement in the panel. applyLayoutFloor() still
     * owns effectiveLayout and can demote this pick on a small window — that is the
     * fallback banner's job to explain, not this function's to pre-empt.
     */
    function layoutForFleetCount(count) {
        const currentSlots = getSlotCount(currentLayout);
        if (count <= currentSlots) { return currentLayout; }
        for (const mode of LAYOUT_GROW_ORDER) {
            if (LAYOUTS[mode].slots >= count) { return mode; }
        }
        return '3x3';
    }

    /**
     * Widen the grid so a just-created fleet has somewhere to sit.
     *
     * setLayoutMode() does NOT persist (the picker's click handler calls
     * saveLayoutSettings() itself), so the caller owns persistence — see the tail of
     * openAllTerminals().
     *
     * No-op in solo mode. Solo hides .terminals-sidebar, which is where the open-all
     * button lives, so this is unreachable today; the guard keeps the helper safe if a
     * future caller is not so lucky (saveSetting is already suppressed under solo).
     */
    function growLayoutForFleet(count) {
        if (document.body.classList.contains('is-solo')) { return false; }
        const target = layoutForFleetCount(count);
        if (target === currentLayout) { return false; }
        setLayoutMode(target);   // syncs the picker, re-renders, re-applies the floor
        return true;
    }
```

`growLayoutForFleet()` returns whether it moved the pick, so the tail can persist a grow that happened even if every subsequent create failed.

**Clarification — why the caller must gate on "a create is planned".** `growLayoutForFleet()` on its own has no way to distinguish "six terminals are about to be born" from "six terminals already exist and the operator deliberately picked `1`". Only `openAllTerminals()` knows. Without the gate, pressing the button with a full-but-manually-collapsed cockpit silently overrides the operator's pick — and, because the tail persists only on `created > 0`, overrides it *without persisting*, so the grid grows now and reverts on reload. The gate lives in change 3.

### 2. `src/webview/terminals.js` — disarm the seed-on-first-load latch before creating anything

> **Superseded:** the original plan's only remedy for root cause B was paint-on-arm (its change 2), leaving the two-mechanism seating asymmetry of root cause A to be papered over by per-create seating.
> **Reason:** Paint-on-arm treats the symptom. Because the ordering is deterministic (see root cause B's callout), pane 0's curtain would land ~750 ms *after* its xterm is already visible — a flash of raw prompt and startup-command echo, then an opaque curtain dropping over output the operator has already read. That satisfies "every pane shows a curtain" while failing the actual goal, "each wearing the startup curtain **while its CLI boots**". The asymmetry itself is one line to remove.
> **Replaced with:** disarm the latch so pane 0 is seated by the same mechanism as panes 1..N — after its own create resolves and after its curtain is armed — and keep paint-on-arm (change 3) as the belt for the paths that cannot control the ordering.

At the top of `openAllTerminals()`, immediately **after** the `wanted.size === 0` early return (`terminals.js:3770-3773`):

```js
        // Disarm the seed-on-first-load branch in sanitizePaneAssignments() before the
        // first create. That branch exists for page load, where the fleet is fetched in
        // one shot; here it is actively harmful. The gateway broadcasts terminalsChanged
        // from inside fleetService.create() — 750ms before the create response resolves
        // for any role with a startup command (SHELL_READINESS_DELAY_MS) — so the branch
        // fires on the refetch and seats terminal 1 through a completely different path
        // from terminals 2..N, at a completely different time. That is root cause A
        // (one instant pane, then a gap) and root cause B (a curtain armed into an
        // already-rendered pane) in a single line.
        //
        // AFTER the wanted.size guard, deliberately: a cockpit with every agent hidden
        // must not lose first-paint seeding for the rest of the page's life.
        initialAssignmentDone = true;
```

With the latch disarmed, terminal 1 is seated by the loop's own `fillEmptyPanes()` into slot 0 (the first free slot) with `activeTerminalName` set by `fillEmptyPanes`'s `activeTerminalName = paneAssignments[focusedPaneIndex] || null` — `focusedPaneIndex` is 0 by default, so the observable outcome is identical to what the seed branch produced, at the right time and with its curtain already armed.

### 3. `src/webview/terminals.js` — paint the curtain at arm time

Retained as a belt, not the primary fix. It is what protects the **single-create** path (`createTerminal()`, `terminals.js:3656`), which has the same latent asymmetry: on an empty cockpit, `+` → create → gateway broadcast → refetch → seed branch renders pane 0, all before `armStartupCurtain()` runs at line 3683 despite that call site's "BEFORE fetchTerminalList/assign" comment. The comment describes the intent; the broadcast defeats it.

`armStartupCurtain()` (line 922) currently ends at `startupCurtains.set(name, state);`. Append a direct paint, mirroring `dismissStartupCurtain()`'s direct-node removal:

```js
        startupCurtains.set(name, state);

        // Paint NOW rather than waiting for the next pane render. The gateway
        // broadcasts terminalsChanged from inside fleetService.create() — and for any
        // role with a startup command the create response is then withheld for
        // SHELL_READINESS_DELAY_MS (750ms) — so a terminal can already be seated and
        // rendered by the time this runs. Without this, its curtain is armed into a
        // rendered pane that nothing repaints, and it expires invisibly.
        //
        // A no-op on the open-all path by design: there the arm precedes the seat, so
        // indexOf() is -1 and the immediately following renderPaneGrid() paints via
        // updatePaneElement's existing branch. This covers the single-create (+) path,
        // where the seed branch can seat pane 0 before the arm.
        //
        // Direct node addressing, NOT renderPaneGrid(): a full reconcile would risk
        // re-parenting live xterm DOM for a purely visual change, which is exactly
        // what updatePaneElement's "no move when already in place" invariant forbids.
        // renderStartupCurtain() is idempotent, so a later reconcile cannot double it.
        if (paneGridEl) {
            const paneIndex = paneAssignments.indexOf(name);
            if (paneIndex >= 0 && paneIndex < paneGridEl.children.length) {
                const contentEl = paneGridEl.children[paneIndex].querySelector('.pane-content');
                if (contentEl) { renderStartupCurtain(contentEl, name); }
            }
        }
        // Class add, NOT renderSidebarList() — the exact mirror of the class strip in
        // dismissStartupCurtain().
        if (listEl) {
            const sel = `.item-role-icon[data-terminal="${cssAttrEscape(name)}"]`;
            listEl.querySelectorAll(sel).forEach(el => el.classList.add('is-starting'));
        }
```

`renderStartupCurtain`, `cssAttrEscape`, `paneGridEl` and `listEl` are all already in scope at this point in the module (`dismissStartupCurtain()` 40 lines below uses the last three). The `paneIndex < paneGridEl.children.length` bound matters: `paneAssignments` is padded to nine regardless of layout, so a terminal parked beyond the rendered slots has an index with no pane element behind it.

### 4. `src/webview/terminals.js` — seat each terminal as it is created, and size the grid up front

Rework the tail of `openAllTerminals()` (lines 3775-3810). Grow **once, before** the loop (so panes seat into a stable geometry instead of reflowing five times), seat **inside** the loop, and persist **once** at the end.

```js
        const liveByRole = new Map();
        let liveCount = 0;
        for (const t of fleetList) {
            if (t.status === 'exited') { continue; }
            liveByRole.set(t.role, (liveByRole.get(t.role) || 0) + 1);
            liveCount++;
        }

        // Size the grid to the FINAL fleet before creating anything. Growing per
        // create would reflow the grid on every step (1 -> 2h -> 1x3 -> 2x2 -> 2x3),
        // refitting every live xterm each time. Counts existing terminals too: open-all
        // is a top-up, so `created` alone under-sizes the grid whenever the operator
        // already had panes open.
        let plannedTotal = liveCount;
        for (const [role, count] of wanted.entries()) {
            plannedTotal += Math.max(0, count - (liveByRole.get(role) || 0));
        }
        // Gate on there being something to create. Pressing the button on a fleet that
        // already exceeds the picked layout must NOT override that pick: the operator
        // may have collapsed to `1` on purpose, and the tail below persists only when
        // work happened — so an ungated grow would move the grid now and revert it on
        // reload. Grow only when new terminals are actually coming.
        const grew = plannedTotal > liveCount ? growLayoutForFleet(plannedTotal) : false;

        let created = 0;
        for (const [role, count] of wanted.entries()) {
            const missing = count - (liveByRole.get(role) || 0);
            // Sequential, not Promise.all: ptyFleetService.create() picks the next
            // free `${role}-${n}` name off its own map, so concurrent creates for
            // the same role can settle on the same name.
            for (let i = 0; i < missing; i++) {
                try {
                    const res = await fetch('/terminals/verb/ptyCreateTerminal', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ role })
                    });
                    if (res.ok) {
                        const data = await res.json();
                        if (data && data.success) {
                            created++;
                            if (data.terminal) {
                                // Adopt the new terminal into fleetList immediately.
                                // fillEmptyPanes() reads fleetList, and for a role with
                                // no startup command this response can beat the
                                // terminalsChanged refetch. Partial projection
                                // ({friendlyName, role, status}) is safe here only
                                // because open-all posts no cwd/worktreePath — see the
                                // Edge-Case audit before reusing this elsewhere.
                                if (!fleetList.some(t => t.friendlyName === data.terminal.friendlyName)) {
                                    fleetList.push(data.terminal);
                                }
                                // Arm BEFORE seating, so the seat's renderPaneGrid() is
                                // what paints the curtain. Do not flip this order.
                                armStartupCurtain(data.terminal.friendlyName, hasCommand[role] === true);
                                // Seat NOW, so each terminal appears as it is born
                                // instead of the whole batch landing seconds later.
                                // persist:false — saveLayoutSettings() is 11 POSTs and
                                // the single call below covers the whole batch.
                                fillEmptyPanes({ persist: false });
                            }
                        }
                        else if (data && data.error) { console.warn(`[Terminals] Open all: ${role} rejected:`, data.error); }
                    }
                } catch (err) {
                    console.warn(`[Terminals] Open all: failed to create ${role}:`, err);
                }
            }
        }

        // Keep this the FIRST `await fetchTerminalList();` in the function:
        // multi-parent-terminals-contract.test.js:257 slices the open-all body from the
        // function header to this exact line and asserts the create payload inside it.
        await fetchTerminalList();
        if (created > 0 || grew) {
            // persist:false, then one explicit save. The trailing call normally finds
            // nothing unseated (the loop seated everything) and returns at its first
            // guard, so leaving persistence to it would drop the batch entirely; and
            // letting it persist AND calling saveLayoutSettings() would write 22 POSTs.
            const unseated = fillEmptyPanes({ persist: false });
            saveLayoutSettings();
            if (unseated > 0) {
                // Never silent. The old behaviour created six terminals, seated four,
                // and said nothing — which is what "why has this failed so hard" was
                // actually about.
                showPaneToast(`${unseated} terminal${unseated === 1 ? '' : 's'} could not be seated — open from the sidebar or pick a larger layout.`);
            }
        }
```

### 5. `src/webview/terminals.js` — `fillEmptyPanes()` gains an options bag and a return value

```js
    /**
     * Seat unassigned terminals into whatever rendered panes are still empty.
     *
     * Returns the number of terminals still unseated, so the caller can tell the
     * operator instead of dropping them silently.
     *
     * opts.persist === false skips saveLayoutSettings(). Open-all calls this once per
     * create and persists once at the end; 11 setting POSTs per terminal is not a
     * cost worth paying six times over for a batch that settles in one place.
     */
    function fillEmptyPanes(opts) {
        const persist = !opts || opts.persist !== false;
        const slotCount = getSlotCount(effectiveLayout);
        const unseated = fleetList
            .filter(t => t.status !== 'exited' && !paneAssignments.includes(t.friendlyName))
            .map(t => t.friendlyName);
        if (unseated.length === 0) { return 0; }

        let changed = false;
        for (let i = 0; i < slotCount && unseated.length > 0; i++) {
            // A kanban-mode slot has no assignment but is NOT free: it is showing the
            // operator a live board column. Seating into it silently bulldozed that
            // pane on every Open All. Kanban panes are only ever displaced by an
            // explicit sidebar click with nowhere else to go (see the target scan).
            if (!paneAssignments[i] && paneModes[i] !== 'kanban') {
                paneAssignments[i] = unseated.shift();
                changed = true;
            }
        }
        if (!changed) { return unseated.length; }
        if (!activeTerminalName) { activeTerminalName = paneAssignments[focusedPaneIndex] || null; }
        if (persist) { saveLayoutSettings(); }
        renderSidebarList();
        renderPaneGrid();
        batchFitVisiblePanes();
        return unseated.length;
    }
```

> **Superseded:** "The two other `fillEmptyPanes()` call sites (if any remain outside open-all) keep working unchanged."
> **Reason:** Factually wrong — there are no other call sites. `fillEmptyPanes()` is called from exactly one place, `openAllTerminals()` (`terminals.js:3809`), and that call is the one being replaced. The hedged "if any remain" wording would have sent an implementer looking for callers that do not exist.
> **Replaced with:** `openAllTerminals()` is the sole caller, and after change 4 it passes `{ persist: false }` at both sites. The optional-arg shape and ignorable return value are kept for future callers, not for existing ones.

### 6. `src/test/` — contract coverage

Add a `src/test/terminal-open-all-seating-contract.test.js` following the established source-text contract pattern in `terminal-pane-grid-reconcile-contract.test.js` (same `block(startMarker, endMarker)` + `test(name, fn)` helpers, same `process.exit(failed === 0 ? 0 : 1)` tail). A new file rather than an addition to `pty-route-surface-contract.test.js`, which is about route/verb surface and would be the wrong home. Cases:

- `layoutForFleetCount()` exists and `LAYOUT_GROW_ORDER` is slot-ascending and excludes `'2v'` — asserted against the literal, so an edit that reintroduces `2v` or reorders the rungs fails.
- `layoutForFleetCount()` early-returns `currentLayout` when the fleet already fits (`if (count <= currentSlots) { return currentLayout; }` present verbatim) — the monotonicity guarantee.
- `growLayoutForFleet()` guards on `is-solo` and does **not** call `saveLayoutSettings()` — persistence stays the caller's.
- `openAllTerminals()` sets `initialAssignmentDone = true` and does so **after** the `wanted.size === 0` return: assert the `wanted.size === 0` guard appears before the assignment in the extracted block.
- `openAllTerminals()` grows conditionally: the block contains `plannedTotal > liveCount` guarding `growLayoutForFleet(`.
- The loop's inner ordering: `armStartupCurtain(` appears before `fillEmptyPanes({ persist: false })` in the create branch.
- The tail: `fillEmptyPanes({ persist: false })` followed by `saveLayoutSettings()`, and `showPaneToast(` gated on `unseated > 0`.
- `armStartupCurtain()`'s paint path calls neither `renderPaneGrid` nor `renderSidebarList`, and its `if (!name || !hasStartupCommand || ...)` guard still precedes the paint.
- `fillEmptyPanes()` still skips kanban slots (`paneModes[i] !== 'kanban'`) and returns `unseated.length`.
- Re-assert the existing open-all payload contract locally so the two suites fail together rather than one silently: the open-all block posts `body: JSON.stringify({ role })` and contains exactly one `await fetchTerminalList();`.

## Verification Plan

Compilation and automated-test execution are **excluded from this plan's steps** per the dispatching session's SKIP COMPILATION / SKIP TESTS directives. Exercising the panel manually does require a build + VSIX install (the browser cockpit serves the installed extension's bundle, not the repo's `src/`), so treat steps 2-11 as post-build UAT to be run by whoever packages the change; the tests in "Automated Tests" below are to be **authored** as part of this change and run outside it.

### Automated Tests

- **New:** `src/test/terminal-open-all-seating-contract.test.js` — every case listed in Proposed Change 6. Author it in the same change; do not defer it.
- **Must stay green (run separately):** `src/test/multi-parent-terminals-contract.test.js` (line 257's open-all payload block — the marker hazard in the Edge-Case audit), `src/test/terminal-pane-grid-reconcile-contract.test.js`, `src/test/terminal-pane-pinning-contract.test.js`, `src/test/terminal-pane-fit-verification-contract.test.js`, `src/test/shell-terminal-strip.test.js`, `src/test/terminal-sidebar-groupings-contract.test.js`, `src/test/pty-route-surface-contract.test.js`.
- Five tests are known red at HEAD. Stash-verify against a clean tree before attributing any failure to this change.

### Manual UAT

1. **Six-terminal cold open (the reported case).** With the cockpit persisted at `1` or `2x2` and no terminals live, click **OPEN AGENT TERMINALS** with six command-bearing roles visible in the Agents tab. Expect:
   - the layout picker jumps to `2x3` and stays highlighted there;
   - **six** panes render, all seated — not four;
   - panes fill in one at a time, roughly one per ~750 ms, with no long dead gap after the first and no single pane appearing seconds ahead of the others;
   - **every** command-bearing pane — including the first — shows the "Starting <agent>…" curtain with the breathing brand icon **from the moment the pane appears**, not dropping over already-visible output, and each dismisses on its own once that CLI settles.
   - **Expected non-curtain:** if Jules is enabled, the `jules_monitor` pane correctly shows **no** curtain — `hasCommand` is keyed off `visibleAgents`, from which `SYSTEM_ONLY_ROLES` (including `jules_monitor`) is stripped, so it is never curtain-eligible and has no startup command to hide. This is not a failure of this change.
2. **First pane, directly.** With DevTools open on the panel, breakpoint `renderStartupCurtain`. For terminal 1 it must be reached from `updatePaneElement` (via the loop's `fillEmptyPanes` → `renderPaneGrid`) and the curtain must exist in the DOM before the xterm has painted any output. Confirm `sanitizePaneAssignments()`'s seed branch does **not** run: `initialAssignmentDone` is already `true` when the first `terminalsChanged` refetch lands.
3. **Top-up.** With three of six roles already live and seated in a `2x2`, press the button. Expect the grid to grow to `2x3` (the *whole* fleet is counted, not just the three new ones), the three new panes to seat, and the three existing panes to keep their terminals and scrollback — no xterm re-parenting, no cleared buffers.
4. **Deliberate manual collapse is respected.** With all six roles already live, set the layout to `1` by hand, then press the button. Expect: nothing created, **no** layout change, no toast, and `terminals.layoutMode` still `1` after reload.
5. **Narrow window (floor still wins).** Shrink the browser window under 750px wide and repeat step 1. Expect: picker shows `2x3`, `#layout-fallback-banner` reads its too-small message, four panes render, and the pane toast reports the two unseated terminals with no Undo button. Widen the window; the floor lifts and the remaining terminals can be seated from the sidebar.
6. **Kanban pane preserved.** Put a pane into kanban mode, then press the button. Expect the kanban pane to survive untouched and the fleet to seat around it (growing the layout if needed).
7. **Pinned pane preserved.** Pin a pane, press the button, confirm the pinned terminal is not displaced.
8. **Idempotence.** Press the button a second time immediately. Expect: nothing created, no layout change, no toast, no duplicate curtains.
9. **Persistence.** Reload the cockpit after step 1. Expect `2x3` to come back with the six terminals still seated in their slots — the grown layout persisted via the single trailing `saveLayoutSettings()`.
10. **Write volume.** In the Network tab, confirm a six-terminal open-all issues **one** batch of 11 `saveSetting` POSTs at the end — not one batch per create (66), and not two batches at the end (22).
11. **Single-create path (the paint-on-arm belt).** With an empty cockpit, use the sidebar `+` to create one command-bearing agent. Expect its curtain to be present the moment pane 0 appears — this is the path the seed branch still seats, and the one paint-on-arm exists for.
12. **Ten-plus fleet.** Configure `plannerTerminalCount` and/or custom agents so the fleet exceeds nine. Expect `3x3`, nine seated panes, and a toast naming the remainder.

---

**Recommendation: Send to Coder** (complexity 6).

---

## Completion Report

Implemented all six proposed changes in `src/webview/terminals.js`: added `LAYOUT_GROW_ORDER` / `layoutForFleetCount()` / `growLayoutForFleet()` after `getMaxSlotCount()`; disarmed `initialAssignmentDone` after the `wanted.size === 0` guard in `openAllTerminals()`; added direct paint-on-arm to `armStartupCurtain()` (mirroring `dismissStartupCurtain()`'s direct-node addressing); reworked `openAllTerminals()` to grow once before the loop, seat each terminal inside the loop with `persist:false`, and persist once at the tail with an unseated-remainder toast; and reworked `fillEmptyPanes()` to accept an options bag and return the unseated count. Created `src/test/terminal-open-all-seating-contract.test.js` with 10 contract cases. All 9 existing test suites stay green (126 tests total, 0 failures); the 2 pre-existing reds in `terminal-pane-fit-verification-contract.test.js` (`DEFAULT_ROLES` marker) are unrelated to this change. No issues encountered.

## Review Findings

Reviewed against this plan with tests executed independently (this dispatch carried no skip directive, so the plan's SKIP TESTS note was treated as a record, not an instruction). One MAJOR gate-wiring defect fixed: `src/test/terminal-open-all-seating-contract.test.js` was authored and green but invoked by nothing — no `test:contract:*` entry and no CI step — so it is now wired as `test:contract:terminal-open-all-seating` in `package.json` and as a named step in `.github/workflows/integration-tests.yml` (files changed: those two). Regression trace found no correctness defects in the seating rework: paint-on-arm's `paneIndex < paneGridEl.children.length` bound is sound because `renderPaneGrid` keeps `paneGridEl.children` 1:1 with slots (`terminals.js:2240-2248`); the `initialAssignmentDone` disarm does not strand the single-create path, which seats explicitly via `assignToFocusedPane` (`terminals.js:3901`) and never relied on the seed branch; and the tail keeps exactly one `await fetchTerminalList()`, so the `multi-parent-terminals-contract.test.js:257` block marker survives. Validation: open-all-seating 10/10, sidebar-groupings 24/24, role-ordering 7/7, multi-parent 29/29, pane-grid-reconcile 6/6, pane-pinning 15/15, shell-terminal-strip 25/25, pty-route-surface and shim-injection 17/17 all green; `eslint` clean; `terminal-pane-fit-verification` 2 red, confirmed pre-existing (`const DEFAULT_ROLES` absent at HEAD too). Remaining risks are deliberate plan decisions, left as-is: a grow persists even when every create fails (pty host down → grid permanently widened with zero terminals), and the grid is sized to `plannedTotal` so partial create failure leaves empty slots; separately, this repo has no meta-gate asserting every `test:contract:*` script is invoked by CI, which is how this test slipped through in the first place.

# Fix: OPEN AGENT TERMINALS skips startup curtain

## Goal

The startup curtain (the "Starting {agent}…" overlay with brand icon) renders for
individually-created terminals but not for terminals created via the OPEN AGENT
TERMINALS button (`openAllTerminals`). Fix the timing so both paths show the
curtain.

## Problem & Root Cause

`armStartupCurtain(name, hasStartupCommand)` (`src/webview/terminals.js:922-935`)
registers curtain state in the `startupCurtains` map and starts three timers:
1.2s quiet (`CURTAIN_QUIET_MS`), 4s no-output (`CURTAIN_NO_OUTPUT_MS`), 15s hard
cap (`CURTAIN_MAX_MS`) — constants at `terminals.js:94-97`. The curtain overlay
is only painted when `updatePaneElement` runs and finds `startupCurtains.has(name)`
is true (`terminals.js:2597-2599`). A second surface exists: `renderSidebarList`
stamps `.is-starting` on the sidebar role icon from the same map
(`terminals.js:1226`).

**Individual path** (`createTerminal`, `terminals.js:3656`): arms curtain
(line 3683) → immediately calls `fetchTerminalList()` (3684) +
`assignToFocusedPane()` (3685) → pane renders while curtain state is alive →
overlay painted → CLI boots → timers fire → curtain dismissed. Works.

**Open-all path** (`openAllTerminals`, `terminals.js:3768`): arms curtain for each
terminal in a sequential loop (line 3798), but defers `fetchTerminalList()` +
`fillEmptyPanes()` to **after** the loop (lines 3808-3809). The curtain state for
the early terminals is deleted by a timer before the terminal is ever seated in a
pane. When `fillEmptyPanes()` finally runs, `startupCurtains.has(name)` is false,
so no overlay is painted.

> **Superseded:** "The first terminal's CLI boots during the loop, live output arrives,
> `bumpStartupCurtain` sets `sawLiveOutput=true`, the 1.2s quiet timer fires, and
> `dismissStartupCurtain` **deletes the curtain state** — all before the terminal is ever
> seated in a pane."
> **Reason:** Factually impossible. `bumpStartupCurtain` is reached only from
> `scheduleBatchFlush` (`terminals.js:4909-4911`), which is only reached from a terminal's
> own WebSocket `onmessage`. That socket is opened by `connectTerminalSocket`, called from
> `createTerminalView` (`terminals.js:4625`) — i.e. **only when the terminal is seated into
> a pane**. An unseated terminal has no socket, receives no output, and can never be
> bumped, so `sawLiveOutput` stays `false` and the 1.2s quiet timer is *never armed at all*
> (it is armed exclusively inside `bumpStartupCurtain`, line 955). Naming the wrong timer
> matters: it is the difference between "output-driven" and "wall-clock-driven", and the
> wall-clock version has a computable failure boundary (below) that the output-driven story
> does not.
> **Replaced with:** the corrected mechanism below.

### Corrected mechanism — the 4s no-output timer is the killer

The startup command is not typed at spawn. `PtyFleetService.create()`
(`src/standalone/ptyFleetService.ts:163-211`) spawns the pty, then
`await this.injectStartupCommand(handle, role)` (line 209) waits
`SHELL_READINESS_DELAY_MS = 750` (line 7, awaited at line 230) before
`handle.sendText(cmd, true)` (line 232). `create()` only resolves after that, so
**each `POST /terminals/verb/ptyCreateTerminal` takes ≈750 ms** for any role that
has a configured CLI — which is exactly the set of roles that get a curtain
(`hasCommand[role] === true`). This is the wall-clock source the existing comment
at `terminals.js:926-928` already alludes to.

Timeline for the Nth-role open-all, terminal index `k` (1-based):

| Event | Time |
| :--- | :--- |
| create #k resolves; `armStartupCurtain` runs | `≈750·k` ms |
| curtain #k's `noOutputTimer` fires (`sawLiveOutput === false`, no socket) | `≈750·k + 4000` ms |
| loop ends; `await fetchTerminalList()` + `fillEmptyPanes()` seat panes | `≈750·N + ~20` ms |

Curtain `k` survives to seating only when `750k + 4000 > 750N`, i.e.
**`k > N − 5.3`**. `fillEmptyPanes` seats the *first* `slotCount` unseated
terminals in `fleetList` order, and `fleetList` is the fleet's Map insertion
(creation) order — so the terminals that get panes are `#1 … #slotCount`, exactly
the ones whose curtain state has already been deleted.

This also explains why the bug can look intermittent rather than absolute:

- **N = 12 roles, 1/2/4/6-pane layout** → seated set `#1..#6` ∩ surviving set
  `#7..#12` = ∅ → **zero** curtains. This is the reported symptom.
- **N = 12 roles, 3×3 layout** (`slotCount = 9`) → panes 7, 8, 9 *do* curtain.
  A reviewer testing on a 3×3 would see a partial, not a total, failure.

The timers are identical in both paths. The bug is that the open-all path
separates curtain arming from pane seating by enough wall-clock time
(`750 ms` per create) for the 4s no-output cap to fire and delete the state before
rendering can use it.

## Fix

Move `fetchTerminalList()` + `fillEmptyPanes()` inside the creation loop, so
each terminal is seated into a pane immediately after creation — mirroring the
individual path's proven timing.

Once seated within ~1 RTT of arming, the sequence becomes correct end to end: the
pty already echoed the typed startup command, so that echo arrives as **replay**
(excluded from `bumpStartupCurtain` by the `awaitingReplayFrame` branch,
`terminals.js:4797`); the CLI's first real paint 1–4 s later arrives **live**,
bumps the curtain, and arms the 1.2 s quiet timer; the curtain then dismisses
1.2 s after the CLI settles. That is the designed behaviour, and it is what the
individual path already gets.

### Changes (all in `src/webview/terminals.js`)

1. **`openAllTerminals` (line 3768) — seat inside the loop.** Inside the inner
   `for` loop, in the `if (data.terminal)` branch immediately after
   `armStartupCurtain` (line 3798), add `await fetchTerminalList();` then
   `fillEmptyPanes({ persist: false })`.

2. **Keep the post-loop `await fetchTerminalList()` (line 3808); drop the
   `if (created > 0) { fillEmptyPanes(); }` in its current form.** The
   authoritative post-loop refresh must stay **unconditional** — pressing OPEN
   AGENT TERMINALS when every role is already at capacity creates nothing but
   must still re-sync a fleet that other tabs, the board, or the 5 s fleet poll
   may have changed. Retain one trailing `fillEmptyPanes({ persist: false })`
   under `created > 0` to catch a terminal the per-iteration pass could not seat
   (a pane freed mid-loop, or a `success: true` response that carried no
   `terminal` object).

3. **Guard the per-iteration work on the create actually having produced a
   terminal.**

   > **Superseded:** "Guard the per-iteration `fetchTerminalList()` so it only runs when a
   > terminal was actually created (not when the role was already at capacity and
   > `missing === 0`)."
   > **Reason:** `missing === 0` is structurally unreachable as a guard condition. It is the
   > bound of the inner `for (let i = 0; i < missing; i++)` loop (line 3787), so when
   > `missing === 0` the loop body never executes and there is nothing to guard. The real
   > uncovered cases are `!res.ok`, `data.success === false`, and
   > `data.success === true` with no `data.terminal` — all of which currently fall through
   > to `created++` or to the `console.warn` branch.
   > **Replaced with:** place the per-iteration `fetchTerminalList()` + `fillEmptyPanes()`
   > inside the existing `if (data.terminal)` branch (line 3798), which already gates on the
   > only condition that matters — a real terminal came back. `created++` stays where it is
   > (outside that branch) so the post-loop trailing fill still runs for a
   > `success`-without-`terminal` response.

4. **`fillEmptyPanes` (line 3819) — accept an opts bag and return whether it
   seated anything.** Add an optional `opts` parameter; when
   `opts.persist === false`, skip the `saveLayoutSettings()` call at line 3839.
   Return `true` when it changed assignments, `false` otherwise.
   `openAllTerminals` then calls `saveLayoutSettings()` **once** at the end if any
   iteration seated a pane. Default behaviour (no opts) is unchanged, and
   `openAllTerminals` is currently the function's only caller, so nothing else is
   affected.

   Rationale: `saveLayoutSettings()` (`terminals.js:793-805`) issues **11**
   `saveSetting` POSTs, each a `fetch` to `/kanban/verb/saveSetting`
   (`terminals.js:733-742`) → `KanbanProvider._updateScopedSetting`
   (`KanbanProvider.ts:717`) → `KanbanDatabase.setConfig`
   (`KanbanDatabase.ts:5222-5229`) → an `INSERT … ON CONFLICT` plus `_persist()`.
   Calling it once per seated pane turns 11 requests into `11 × slotCount` (66 on
   a 6-pane layout) with 66 SQL writes, for state that is identical at the end.
   Deferring it is ~5 lines and strictly better.

### Sketch

```js
// openAllTerminals
let created = 0;
let seatedAny = false;
for (const [role, count] of wanted.entries()) {
    const missing = count - (liveByRole.get(role) || 0);
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
                        // Arm, then seat in the SAME breath — the individual path's
                        // proven order (createTerminal, terminals.js:3683-3685). Deferred
                        // seating lets the 4s no-output cap delete the curtain state
                        // before updatePaneElement can read it.
                        armStartupCurtain(data.terminal.friendlyName, hasCommand[role] === true);
                        await fetchTerminalList();
                        if (fillEmptyPanes({ persist: false })) { seatedAny = true; }
                    }
                }
                else if (data && data.error) { console.warn(`[Terminals] Open all: ${role} rejected:`, data.error); }
            }
        } catch (err) {
            console.warn(`[Terminals] Open all: failed to create ${role}:`, err);
        }
    }
}

// Unconditional: a no-op top-up must still re-sync a fleet another tab changed.
await fetchTerminalList();
if (created > 0 && fillEmptyPanes({ persist: false })) { seatedAny = true; }
// One flush for the whole operation instead of one per seated pane.
if (seatedAny) { saveLayoutSettings(); }
```

```js
// fillEmptyPanes
function fillEmptyPanes(opts) {
    const slotCount = getSlotCount(effectiveLayout);
    const unseated = fleetList
        .filter(t => t.status !== 'exited' && !paneAssignments.includes(t.friendlyName))
        .map(t => t.friendlyName);
    if (unseated.length === 0) { return false; }

    let changed = false;
    for (let i = 0; i < slotCount && unseated.length > 0; i++) {
        if (!paneAssignments[i] && paneModes[i] !== 'kanban') {
            paneAssignments[i] = unseated.shift();
            changed = true;
        }
    }
    if (!changed) { return false; }
    if (!activeTerminalName) { activeTerminalName = paneAssignments[focusedPaneIndex] || null; }
    // openAllTerminals seats one terminal per ~750ms iteration and passes
    // persist:false, then flushes once at the end: saveLayoutSettings is 11
    // saveSetting POSTs, and paying that per seated pane writes the same final
    // state slotCount times over.
    if (!opts || opts.persist !== false) { saveLayoutSettings(); }
    renderSidebarList();
    renderPaneGrid();
    batchFitVisiblePanes();
    return true;
}
```

### Why not defer timer arming to render time

> **Superseded:** "Rejected because `bumpStartupCurtain` (called on live WebSocket output)
> would fire before the curtain is rendered, setting `sawLiveOutput=true` with no timer to
> act on it — requiring extra state machine logic to handle 'CLI already booted before
> render.'"
> **Reason:** The stated failure cannot happen, for the same reason the original root-cause
> analysis was wrong: no socket exists before render (`connectTerminalSocket` is called only
> from `createTerminalView`, `terminals.js:4625`), so `bumpStartupCurtain` cannot fire
> pre-render. Rejecting the alternative on an impossible failure mode leaves the decision
> unjustified.
> **Replaced with:** the alternative is still rejected, but on real grounds — see below.

Splitting `armStartupCurtain` into register-now / start-timers-at-render phases is
rejected because it converts a *bounded* intent into an *unbounded* one. A
register-only entry has no timer, so nothing expires it: a terminal beyond
`slotCount` that the operator clicks into a pane 30 s later would paint a
"Starting…" curtain over a CLI that finished booting half a minute ago, and
because its entire boot is now replay (excluded from `bumpStartupCurtain`), the
only thing that could clear it is a fresh 4 s no-output cap — a 4 s lie on a ready
terminal. Making that safe needs an `armedAt` timestamp plus an age check at
render, i.e. a second expiry policy alongside the three timers that already exist.
The interleave fix needs none of that: it moves two calls and makes the open-all
path byte-for-byte the same shape as the individual path that already works.

### Performance note

> **Superseded:** "This turns 1 `fetchTerminalList()` call into N (one per created
> terminal). N is typically 6-12, each is a localhost HTTP round-trip (~5ms), and the loop
> is already sequential with ~750ms per `ptyCreateTerminal`. The extra fetches are
> negligible."
> **Reason:** The conclusion (negligible) is right but the accounting is wrong in both
> directions, and the wrong parts are the ones a reviewer would challenge.
> `fetchTerminalList` is not one round-trip — it opens with
> `await fetchKanbanColumnStructure()` (`terminals.js:808`) and then runs
> `sanitizePaneAssignments` + `renderSidebarList` + `renderPaneGrid` +
> `applyLayoutFloor` + `postFleetStateToShell` + `checkSoloNotFound` (lines 827-834).
> Meanwhile the genuinely multiplied cost — `saveLayoutSettings`'s 11 POSTs per seated
> pane — was not counted at all.
> **Replaced with:** the accounting below.

- **`ptyListTerminals` POST × N.** Real, and negligible: localhost, and the loop
  is already paced at ~750 ms per iteration (`SHELL_READINESS_DELAY_MS`). Note
  the panel *already* issues more than this during a long open-all — the 5 s
  `startFleetPoll` (`terminals.js:3118-3128`) and every `terminalsChanged`
  broadcast (`terminalWsGateway.ts:381`, relayed into the iframe at
  `terminals.js:585-586`) each trigger an unawaited `fetchTerminalList()`.
- **`getKanbanStructure` POST × N — does not happen.**
  `fetchKanbanColumnStructure()` self-throttles to 30 s unless forced
  (`terminals.js:3142`), so the loop pays it at most once.
- **`renderSidebarList` + `renderPaneGrid` twice per iteration** (once from
  `fetchTerminalList`, once from `fillEmptyPanes`). Both are reconciles that
  honour `updatePaneElement`'s no-move invariant; two per 750 ms is not a
  refresh storm.
- **`batchFitVisiblePanes` re-ladders panes `1..k` each iteration**, i.e.
  `O(slotCount²/2)` ladder starts (21 on a 6-pane layout). Verified benign and
  requiring **no change**: `startFitLadder` returns early on an already-converged
  pane (`before === 'ok'`, `terminals.js:3443`) before mutating anything, and a
  `{t:'resize'}` frame is only sent on a verified `'mismatch'` (line 3448). No
  spurious SIGWINCH is delivered to a booting CLI.
- **`saveLayoutSettings` × slotCount — mitigated by change 4 above.** 11 POSTs
  per seated pane, each an `INSERT … ON CONFLICT` on `kanban.db`'s `config`
  table. The on-disk cost is smaller than the request count suggests —
  `_persist()` is a 300 ms trailing debounce (`KanbanDatabase.ts:9154-9174`), so
  each iteration's 11 writes coalesce into **one** full `sql.js` export + atomic
  rename (`_doPersist`, line 9197). So the real amplification is
  `1 → slotCount` full DB exports and `11 → 11 × slotCount` HTTP/SQL writes.
  Not dangerous, but pointless — hence the single deferred flush.

## Metadata

- **Tags:** bugfix, ui, frontend, reliability
- **Complexity:** 4
- **Project:** browser-switchboard

## User Review Required

None. Every decision in this plan is settled against read code: the interleave
approach is confirmed, the two alternatives are rejected on cited evidence, and
the deferred settings flush is a strict improvement with a single existing caller.

## Complexity Audit

### Routine

- One function's call ordering changes (`openAllTerminals`, `terminals.js:3768-3810`);
  no new state, no new timers, no new DOM.
- The target ordering already exists and is proven in `createTerminal`
  (`terminals.js:3683-3685`) — this is a copy of a working shape, not a new one.
- `fillEmptyPanes` gains an optional opts bag and a boolean return. It has exactly
  one caller today, and the no-opts default preserves current behaviour.
- Single file. No server-side, verb-schema, or DB change; no `/panels` manifest or
  verb-router touch, so the PRD's two-layer completion model and the
  return-contract ratchet are not in play.

### Complex / Risky

- **Timing-sensitive by nature.** The whole defect is a wall-clock race between
  the 4 s no-output cap and the ~750 ms-per-create loop. The fix is correct
  because it collapses that gap to ~1 RTT, but it cannot be proven by a unit
  test — only by observation, plus a source-level contract test that pins the
  ordering so it cannot silently regress.
- **Amplifies an existing `fetchTerminalList` interleaving race** from one window
  to N (see Race Conditions). Self-healing, but newly reachable N times.
- **Hot render path.** `fillEmptyPanes` → `renderPaneGrid` → `updatePaneElement`
  is governed by the documented "no move when already in place" invariant
  (`terminals.js:2573-2580`). Calling it per iteration is safe only because that
  invariant holds; any change that breaks it turns this fix into visible terminal
  DOM churn mid-boot.

## Edge-Case & Dependency Audit

### Race Conditions

- **Stale-list clobber (amplified, pre-existing, self-healing).**
  `fetchTerminalList` has no in-flight or sequence guard, and three other things
  call it unawaited during a long open-all: the 5 s `startFleetPoll`
  (`terminals.js:3126`), the `terminalsChanged` relay (`terminals.js:585-586`),
  and — importantly — the `'created'` fleet event is emitted at
  `ptyFleetService.ts:207`, *before* the 750 ms readiness wait, so every create
  fires a broadcast ~750 ms before its own HTTP response lands. If a response
  carrying terminals `1..k-1` resolves *after* the loop's awaited response
  carrying `1..k`, then `fleetList` regresses and `sanitizePaneAssignments`
  (`terminals.js:1044-1066`) nulls the slot holding terminal `k`, emptying that
  pane and destroying its curtain node.
  **Decision: document, do not guard.** The window is ~1 RTT; the state recovers
  on the next iteration's fetch because `startupCurtains` still holds terminal
  `k`'s entry (only the DOM node was removed), so the re-seat repaints the
  curtain via `terminals.js:2597`. `terminalsMap` and the WebSocket survive
  (`destroyTerminalView` is not called). Worst case is a sub-second flash.
  Adding a monotonic sequence guard to `fetchTerminalList` would touch a function
  with eight call sites and every refresh path in the panel, and carries its own
  regression (dropping a legitimately newer-but-slower response) — disproportionate
  inside a curtain-timing bugfix.
- **Curtain expiry still races a slow CLI — unchanged, and not this plan's
  scope.** `noOutputTimer` is 4 s from arming. An agent CLI whose first *live*
  paint lands more than 4 s after its startup command is typed dismisses its own
  curtain mid-boot. This is identical on the individual path today; the fix does
  not make it worse and must not be conflated with it.
- **Concurrent open-all.** Two rapid clicks run two `openAllTerminals` bodies
  interleaved at every `await`. Pre-existing (`liveByRole` is snapshotted once at
  entry, before the loop), unchanged by this fix, and bounded by the server-side
  top-up guard. `armStartupCurtain`'s `startupCurtains.has(name)` early return
  (line 923) already makes double-arming a no-op.

### Security

None. No new network surface, no new payload fields, no user-controlled string
reaching a selector. The one string interpolated into a CSS attribute selector
(`name`, via `cssAttrEscape`, `terminals.js:987-989`) is unchanged. No verb, no
schema, no auth path is touched, so the PRD's HTTP-boundary validation contract
(#5) is unaffected.

### Side Effects

- **Panes fill progressively rather than all at once.** Previously the grid stayed
  empty for the whole ~750 ms × N loop and then populated in one frame; now panes
  appear one per ~750 ms. This is a visible behaviour change and it is the
  intended one — it is what makes each pane's curtain cover its own CLI's boot
  rather than covering nothing.
- **Sidebar `.is-starting` icons now light on time (bonus fix).** Today the
  broadcast-driven `renderSidebarList` for terminal `k` runs ~750 ms *before* that
  terminal's curtain is armed (the `'created'` event precedes the readiness wait),
  so the icon only gains `.is-starting` on the *next* create's render. After the
  fix the loop's own `fetchTerminalList()` renders immediately after arming, so
  the icon lights on the correct terminal at the correct moment. No extra work
  needed — call it out so it is not mistaken for a regression.
- **Terminals beyond `slotCount` still never curtain — by design, not a bug.**
  `fillEmptyPanes` deliberately does not displace anything already on screen
  (`terminals.js:3813-3818`). With 12 visible roles on a 4-pane layout, 4 panes
  curtain and 8 terminals show only a ~4 s sidebar `.is-starting` icon. Verification
  must not read that as a partial failure.
- **Kanban-mode panes are still never bulldozed.** The `paneModes[i] !== 'kanban'`
  guard (`terminals.js:3832`) is inside `fillEmptyPanes` and is untouched, so
  calling it N times cannot claim a board pane on any iteration.
- **Settings writes drop from `11 × slotCount` to 11** relative to the naive
  interleave, and are unchanged relative to today's single flush.

### Dependencies & Conflicts

- `src/webview/terminals.js` is the only file changed. Per the PRD's
  one-stream-per-file discipline, no other agent may hold this file concurrently.
- Depends on, and must not alter, three behaviours in code it does not touch:
  `SHELL_READINESS_DELAY_MS = 750` (`ptyFleetService.ts:7`); the replay exclusion
  from `bumpStartupCurtain` (`terminals.js:4797`, `940-948`); and
  `updatePaneElement`'s no-move-when-in-place invariant (`terminals.js:2573-2580`).
- **Must not "fix" the loop by detaching the startup-command injection.** Making
  `PtyFleetService.create()` return before `injectStartupCommand` would collapse
  the loop from ~9 s to ~0.3 s and make the *original* code work — but three call
  sites rely on `await create()` guaranteeing the CLI has been launched before a
  prompt is typed: kanban dispatch (`bootstrap.ts:1397` → `1400`),
  `sendToTerminal` (`1432` → `1434`), and memo → planner (`1541` → `1543`), each
  `await create()` immediately followed by `await sendPromptToPty(...)`. Detaching
  it would type dispatch prompts into a bare shell before the agent CLI exists —
  a core-product regression on the dispatch path. Explicitly out of bounds.
- The webview is served from the shared `headlessPanelHtml.ts` getter
  (`terminals.html`, resolved at `headlessPanelHtml.ts:388-389`), which prefers
  `dist/` over `src/`. Per project rules `dist/` is not audited, but a browser
  verifying this change is served the installed VSIX's build — verify against a
  host running the edited source.

## Dependencies

- `sess_none` — no upstream plan blocks this. Self-contained single-file fix.

## Adversarial Synthesis

**Risk Summary.** Key risks: (1) the fix is wall-clock-timing-dependent and
cannot be proven by unit test, so a source-level contract test pinning the
arm→fetch→fill ordering is the only regression guard; (2) it amplifies an
existing unguarded `fetchTerminalList` interleaving race from one window to N,
where a stale short list can briefly null a just-seated pane; (3) it multiplies
`saveLayoutSettings`' 11 config writes by pane count if the flush is not
deferred. Mitigations: seat inside the loop so arming and rendering are ~1 RTT
apart (matching the already-working `createTerminal` path); accept the stale-list
race as documented and self-healing, since `startupCurtains` survives the DOM
removal and the next iteration repaints; pass `persist: false` per iteration and
flush `saveLayoutSettings()` exactly once at the end.

## Proposed Changes

### `src/webview/terminals.js` — `openAllTerminals` (line 3768)

- **Context.** Sequential top-up loop over `wanted` roles. Arms a curtain per
  created terminal at line 3798, then defers `await fetchTerminalList()` +
  `if (created > 0) { fillEmptyPanes(); }` to lines 3808-3809. Each iteration
  blocks ~750 ms on `SHELL_READINESS_DELAY_MS`, so the early curtains' 4 s
  no-output caps fire before seating.
- **Logic.** Collapse arm→seat to one RTT by moving the refresh and the seat
  inside the `if (data.terminal)` branch. Track `seatedAny` so the layout-settings
  flush happens once. Keep the post-loop `await fetchTerminalList()`
  unconditional, and keep one trailing `fillEmptyPanes` under `created > 0`.
- **Implementation.** As in the Sketch above. Add a `seatedAny` flag beside
  `created`. Inside `if (data.terminal)`: `armStartupCurtain(...)`, then
  `await fetchTerminalList()`, then
  `if (fillEmptyPanes({ persist: false })) { seatedAny = true; }`. After the loop:
  `await fetchTerminalList()`;
  `if (created > 0 && fillEmptyPanes({ persist: false })) { seatedAny = true; }`;
  `if (seatedAny) { saveLayoutSettings(); }`. Update the function's doc comment to
  record *why* seating is interleaved — the 4 s no-output cap versus the 750 ms
  per-create wall clock — so a future refactor does not hoist it back out as an
  "obvious" optimisation.
- **Edge Cases.** `!res.ok` / `success: false` → no arm, no fetch, no fill (the
  existing `console.warn` branch is unchanged). `success: true` without
  `terminal` → `created++` but no per-iteration seat; the trailing
  `fillEmptyPanes` covers it. `missing === 0` → inner loop never runs (nothing to
  guard). All roles already at capacity → `created === 0`, `seatedAny === false`;
  the unconditional post-loop `fetchTerminalList()` still re-syncs, and no
  settings write is issued — matching today.

### `src/webview/terminals.js` — `fillEmptyPanes` (line 3819)

- **Context.** Seats unassigned terminals into empty, non-kanban panes; calls
  `saveLayoutSettings()` (line 3839) then `renderSidebarList` / `renderPaneGrid` /
  `batchFitVisiblePanes`. Returns `void`. `openAllTerminals` is its only caller.
- **Logic.** Add an optional `opts` bag with `persist` (default `true`) and
  return a boolean so the caller knows whether anything was seated and therefore
  whether a deferred flush is owed.
- **Implementation.** Signature `function fillEmptyPanes(opts)`. Return `false`
  from both early exits (`unseated.length === 0`, `!changed`). Gate line 3839 as
  `if (!opts || opts.persist !== false) { saveLayoutSettings(); }`. Return `true`
  at the end. Comment the gate with the reason (11 POSTs × pane count for
  identical final state) so it does not read as an arbitrary flag.
- **Edge Cases.** No-opts call is byte-identical to today (persists, renders, and
  the discarded return value is harmless). `persist: false` with `changed` true
  still mutates `paneAssignments` in memory and still renders — only the DB write
  is deferred, so a tab closed mid-loop loses at most the not-yet-flushed pane
  assignments and `sanitizePaneAssignments` drops the stale slots on next load.
  `activeTerminalName` initialisation (line 3838) stays ahead of the gate so
  focus behaviour is unchanged.

## Verification Plan

### Automated Tests

Add a source-level contract test, `src/test/terminal-open-all-curtain-timing-contract.test.js`,
following the established pattern of reading `src/webview/terminals.js` from disk
and asserting invariants on the source (as
`src/test/terminal-pane-pinning-contract.test.js` and
`src/test/terminal-sidebar-groupings-contract.test.js` already do — never
re-implementing the logic locally). The defect is an *ordering* bug that no
runtime unit test can catch, so pinning the ordering in source is the regression
guard. Assertions:

1. Within the `openAllTerminals` body, `armStartupCurtain` is followed by
   `fetchTerminalList` and then `fillEmptyPanes` **before** the closing brace of
   the inner `for` loop — i.e. seating is interleaved, not deferred.
2. `fillEmptyPanes` is called with `{ persist: false }` inside `openAllTerminals`,
   and `saveLayoutSettings()` appears exactly once in `openAllTerminals`.
3. `fillEmptyPanes`'s body still contains the `paneModes[i] !== 'kanban'` guard
   (a kanban pane is never bulldozed by the now-repeated calls).
4. `fillEmptyPanes` returns a boolean from all three exits.
5. `SHELL_READINESS_DELAY_MS` is still `750` in
   `src/standalone/ptyFleetService.ts` and `CURTAIN_NO_OUTPUT_MS` is still `4000`
   in `terminals.js` — the two constants whose ratio is the whole bug. If either
   moves, this fix's rationale needs re-reading.

Per this session's directives, no compilation step and no test execution were
performed during this planning pass; the coder runs the suite.

### Manual Verification

1. Serve the terminals panel from a host running the **edited source** (not an
   installed VSIX's `dist/`) and open it in a browser.
2. Click OPEN AGENT TERMINALS with agent CLIs configured for several roles.
3. Confirm each pane shows the "Starting {agent}…" curtain overlay during its
   CLI's boot, then dismisses when the CLI settles. Panes should populate
   progressively (~750 ms apart), not all at once.
4. Confirm terminals **beyond** the pane count show a ~4 s `.is-starting` sidebar
   icon and no pane curtain — correct by design (`fillEmptyPanes` does not
   displace), not a partial failure.
5. Test on a 3×3 layout too: before the fix, panes 7-9 curtain while 1-6 do not;
   after the fix, all nine curtain. That asymmetry disappearing is the clearest
   single signal the timing gap is closed.
6. Click OPEN AGENT TERMINALS again (top-up path) — existing terminals must not
   re-curtain; only newly created ones.
7. Set a pane to kanban mode, then click OPEN AGENT TERMINALS — the board pane
   must survive every iteration.
8. Create a single terminal via the role picker — confirm the curtain still works
   (regression check on the path this fix copies).
9. Reload the tab after an open-all and confirm pane assignments persisted (the
   deferred single `saveLayoutSettings()` fired).

---

**Recommendation: Send to Coder** (Complexity 4).

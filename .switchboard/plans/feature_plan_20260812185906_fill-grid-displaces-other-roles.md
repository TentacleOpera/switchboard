# Fill Grid Does Not Displace Panes Held by Other Roles — New Terminals Left Unassigned

## Goal

Fix the "Fill Grid" action so that choosing a role and grid size actually fills the grid with that role, displacing panes that currently show a different role. Today, filling a 1-slot grid with a role that has zero live terminals creates the terminal but cannot seat it — the pane keeps showing the old role and the new terminal is orphaned in the sidebar.

### Problem analysis

The user opened Fill Grid, picked a role, and chose size "1" (the single-pane layout). They expected the grid to become that role. Instead:

1. The single pane continued showing an existing terminal of a *different* role.
2. A new terminal of the chosen role was created but left **unassigned** (visible in the sidebar, not in any pane).

The user described this as "does crap all" — the action appeared to do nothing useful.

### Root cause

`fillGrid(role, mode)` in `src/webview/terminals.js:6474` uses **"top up, never displace"** semantics inherited from its original design plan (`role-grid-fill-terminals.md`):

1. It counts live terminals of the chosen role from `fleetList` (lines 6482-6485). If the chosen role has 0 live terminals and the grid has 1 slot, `need = 1 - 0 = 1` — so it proceeds to create.
2. It calls `setLayoutMode(mode)` (line 6494 → `src/webview/terminals.js:3393`), which calls `sanitizePaneAssignments()` — but that function only drops *stale* (dead) pane assignments, never live terminals of a different role. The pane still holds the old role's terminal.
3. It calls `createTerminalsForRole(role, need, ...)` (line 6495, defined at 6343) — creates the new terminal.
4. It calls `fillEmptyPanes()` (line 6497) — but `fillEmptyPanes` (line 6513) only seats into **empty, non-kanban** panes (`!paneAssignments[i] && paneModes[i] !== 'kanban'`). The single pane is occupied by the old role, so there is nowhere to seat the new terminal.
5. `fillEmptyPanes` returns `unseated.length = 1`, and the toast "1 terminal could not be seated — choose a larger grid" fires. The pane still shows the old role; the new terminal is unassigned.

The fundamental mismatch: **"fill" implies the grid becomes the chosen role**, but the implementation treats it as "add terminals of this role only into empty slots." When every slot is occupied by a different role, the fill creates orphans.

A secondary symptom: the `need <= 0` early return (lines 6487-6490) toasts "already has N live terminals — no grid to fill" and returns *before* `setLayoutMode`, so even if the user has enough terminals of the chosen role but the panes show other roles, the grid is neither switched nor re-seated.

A third, structural cause of orphaning found during this pass: **`need` is computed against `LAYOUTS[mode].slots` without subtracting kanban-mode panes.** A kanban pane occupies a visible slot but is deliberately never seated into (the `paneModes[i] !== 'kanban'` guard at line 6533). So a 2-slot grid with one kanban pane makes `need = 2 - liveCount`, creating one more terminal than the fill can ever seat. That terminal is orphaned by construction, and the toast blames the grid size when the grid size is fine.

> **Superseded:** Line references `fillGrid` at 6277, `fillEmptyPanes` at 6316, count at 6286-6288, `setLayoutMode` at 6297, `createTerminalsForRole` at 6298, `fillEmptyPanes()` at 6300, early return at 6290-6293, form submit handler at 911.
> **Reason:** `src/webview/terminals.js` has grown ~200 lines above these functions since the plan was written; every cited line now points at unrelated code. A coder following stale anchors edits the wrong region or concludes the plan describes a different file.
> **Replaced with:** `fillGrid` at **6474**, `fillEmptyPanes` at **6513**, `createTerminalsForRole` at **6343**, `openAllTerminals` at **6387**, `setLayoutMode` at **3393**, `sanitizePaneAssignments` at **1825**, `getSlotCount` at **1307**. The `fillGridConfirm.disabled` idiom is in the fill-grid form submit handler; locate it by symbol, not by line.

## Metadata

**Tags:** frontend, ui, bugfix
**Complexity:** 4
**Project:** Browser Switchboard

## User Review Required

None.

## Complexity Audit

### Routine

- Adding a `role` option to `fillEmptyPanes` that, when present, frees panes held by other roles before seating.
- Filtering the `unseated` list to the chosen role when the option is active, so displaced terminals of other roles don't reclaim the freed panes.
- Updating `fillGrid` to pass `{ role }` to `fillEmptyPanes` and to handle the `need <= 0` re-seat path.
- Subtracting kanban-mode panes from the seatable slot count before computing `need`, using the established `paneModes.slice(0, slotCount)` idiom (`src/webview/terminals.js:3925`).

### Complex / Risky

- **`paneAssignments` is sized to the MAX layout, not the current one.** `sanitizePaneAssignments` (line 1825) pads/trims `paneAssignments` and `pinnedPanes` to `getMaxSlotCount()` (lines 1828-1836), and `paneModes` is padded to the same and *never* trimmed (line 3853). So `paneAssignments` legitimately holds names in slots the current layout does not render. Any "is this terminal already seated?" test written as an array-wide `paneAssignments.includes(name)` therefore counts terminals parked in **hidden** slots as seated. This is the single most dangerous property of this change — see the superseded code block below, where it produces a silent, self-inconsistent grid.
- **Displacing pinned panes of other roles.** A "fill grid" is a deliberate bulk action — the operator is asking the grid to become one role. Displacing a pinned pane of a different role is the expected behavior here, not a regression. The pin flag must be cleared alongside the pane assignment so `sanitizePaneAssignments`'s invariant (`pinnedPanes[i]` never true while `paneAssignments[i]` is null, enforced at lines 1862-1864) holds.
- **Not regressing `openAllTerminals`.** `openAllTerminals` (line 6387) calls `fillEmptyPanes({ persist: false })` without a `role` option. The displacement path must be gated on `opts.role` being present, so open-all's "fill only empty slots" behavior is unchanged.
- **Existing contract tests are literal-substring scans over a `block()` extraction.** `src/test/terminal-open-all-seating-contract.test.js` extracts `fillGrid` with `block('async function fillGrid(role, mode) {', 'function fillEmptyPanes(')` and `fillEmptyPanes` with `block('function fillEmptyPanes(', 'async function renameTerminal(')`. **The declaration order `fillGrid` → `fillEmptyPanes` → `renameTerminal` is load-bearing** — moving or reordering any of the three silently changes which text each assertion scans, and a further test (line 247) extracts `openAllTerminals` by scanning to `async function fillGrid(`. Restructure the function bodies in place; do not relocate them.
- **Preserved literals.** `fillGrid` must keep `LAYOUTS[mode].slots`, `LAYOUT_MODES.includes(mode)`, `t.status !== 'exited' && t.role === role`, `if (need <= 0)`, `setLayoutMode(mode)`, no `getRoleTerminalSet`, and no `confirm(`. `fillEmptyPanes` must keep `function fillEmptyPanes(opts)`, `opts.persist !== false`, `paneModes[i] !== 'kanban'`, `return unseated.length`, and `return 0`. The `return 0` requirement is why the corrected code keeps an early-return branch rather than deleting it.

## Edge-Case & Dependency Audit

### Race Conditions

- `fleetList` is refreshed by a poll timer and by `terminalsChanged` pushes. The top-up count is computed once at click time (existing behavior); a refresh mid-loop must not re-derive it. The displacement scan in `fillEmptyPanes` runs after `fetchTerminalList`, so it sees the freshly created terminals — no stale-count risk.
- Double-clicking Fill is already covered by the `fillGridConfirm.disabled = true` idiom in the fill-grid form submit handler.
- `setLayoutMode(mode)` itself calls `renderPaneGrid()` (line 3411) **before** `fillEmptyPanes` mutates `paneAssignments`. Any mutation `fillEmptyPanes` makes without re-rendering therefore leaves the DOM showing the pre-fill arrangement until the next poll tick. This is what turns the superseded early return into a visible defect rather than a harmless no-op.

### Security

- Role comes from `fetchPtyVisibleRoles()` (server's own list), not free text. No change.

### Side Effects

- **Displaced terminals are not destroyed.** They remain live in the sidebar and can be re-seated by a sidebar click. "Fill grid" changes *seating*, not *fleet membership*.
- **Layout switch persists.** `setLayoutMode(mode)` writes `currentLayout` and persists via `applyLayoutFloor` → `saveLayoutSettings`. This is the asked-for behavior — the user chose a grid size.
- **Pin clearing.** When a pane holding a different role is freed, its pin flag is cleared. This is deliberate: a pin on a freed slot would reserve it against the fill, and `sanitizePaneAssignments` would expire it on the next refresh anyway. Clearing it explicitly avoids a transient invariant violation.
- **Kanban panes survive a fill.** A kanban-mode pane holds `paneAssignments[i] === null`, so the displacement loop skips it (`if (!name) { continue; }`) and the seating loop skips it (`paneModes[i] !== 'kanban'`). A fill never bulldozes a board pane. With the kanban-aware `need` computation below, it also no longer *over-creates* against those slots.
- **All-kanban grid.** If every visible slot is a kanban pane, `seatableSlots === 0` and `need <= 0`, so the fill switches layout, seats nothing, and reports the role's terminals as left in the sidebar. Correct and non-destructive — there is genuinely nowhere to seat.
- **Pane-0 auto-seed is not affected.** `sanitizePaneAssignments`'s first-load seed (line 1895) is gated on `!paneAssignments.some(name => name !== null)`, i.e. a wholly empty array. A fill always leaves at least the displaced terminals' own slots or the newly seated ones populated, so the seed cannot fire behind a deliberate fill. No `initialAssignmentDone` change is needed in the `need <= 0` path.

### Dependencies & Conflicts

- Shares `src/webview/terminals.js` with its sibling subtask (*Extract the kanban column-set derivation into a shared webview script*) — serialise edits to this file. The two touch non-adjacent regions (~6474-6580 here vs ~4920-5030 there), so the serialisation is a merge-hygiene rule, not a design dependency.
- No backend dependency. The fix is entirely in the webview seating logic.
- No shared test file with the sibling: this plan extends `src/test/terminal-open-all-seating-contract.test.js`; the sibling rewrites `src/test/browser-kanban-pane-order.test.js`.

## Dependencies

- None — no upstream session dependencies.

## Adversarial Synthesis

**Risk summary.** The dominant risk is not the displacement itself but the *seated-set definition*: `paneAssignments` spans the maximum layout, so an array-wide membership test silently classifies terminals in hidden slots as seated, letting the function return "0 unseated" while the visible grid is empty and unpersisted. The second risk is mutation-without-render — freeing panes and then returning early leaves the DOM and the in-memory model disagreeing until the next poll tick, and drops the change entirely on reload. Mitigations: scope the seated set to `paneAssignments.slice(0, slotCount)`, track a `freed` flag so any displacement falls through to the render/persist tail, subtract kanban panes before computing `need`, and keep every literal the contract test scans for.

## Proposed Changes

### `src/webview/terminals.js` — `fillEmptyPanes` (line 6513)

Add a `role` option that, when present, frees panes held by a different role and seats only the chosen role's terminals.

> **Superseded:** The originally proposed `fillEmptyPanes` body, which computed `const unseated = fleetList.filter(t => t.status !== 'exited' && !paneAssignments.includes(t.friendlyName) && (!roleFilter || t.role === roleFilter))` and kept the unconditional `if (unseated.length === 0) { return 0; }` early return ahead of the render/persist tail.
> **Reason:** Two composing defects, both silent.
> **(a) The membership test is array-wide, the loops are slot-bounded.** `sanitizePaneAssignments` sizes `paneAssignments` to `getMaxSlotCount()` (line 1828), so a terminal parked in a slot the current layout does not render still satisfies `paneAssignments.includes(...)`. Concrete failure: layout `2h` with pane 0 = `planner-1` and pane 1 = `coder-1`, exactly one live coder, operator runs Fill Grid → role `coder`, size `1`. `liveCount = 1`, `slots = 1`, `need = 0` → the `need <= 0` branch runs `setLayoutMode('1')` (slot count drops to 1) then `fillEmptyPanes({ role: 'coder' })`. The displacement loop scans slot 0 only, frees `planner-1`, clears its pin. `unseated` is then computed as "live coders not anywhere in `paneAssignments`" — and `coder-1` is still at index 1, in the now-hidden slot. So `unseated` is empty.
> **(b) The early return then skips the tail.** With `unseated.length === 0` the function returns 0 *before* `saveLayoutSettings()`, `renderSidebarList()`, and `renderPaneGrid()`. `setLayoutMode` had already painted the grid, so the DOM keeps showing `planner-1` in pane 0 while `paneAssignments[0]` is `null` and `pinnedPanes[0]` is `false`. The caller sees `0` — "everything seated" — and toasts success. The operator asked for a one-pane coder grid and gets a stale pane that blanks itself on the next poll tick and reverts to `planner-1` on reload, because nothing was persisted. The function passes its own success check while the goal is unmet.
> **Replaced with:** a slot-bounded `seated` set, a `freed` flag so displacement alone still reaches the render/persist tail, and an early return narrowed to the genuinely-nothing-to-do case (which preserves the `return 0` literal the contract test scans for).

```js
function fillEmptyPanes(opts) {
    const persist = !opts || opts.persist !== false;
    const roleFilter = opts && opts.role;
    const slotCount = getSlotCount(effectiveLayout);

    // When filling for a specific role, free panes held by OTHER roles so the
    // chosen role can claim them. The generic fillEmptyPanes never displaces;
    // without this, "fill grid with role X" creates X terminals but cannot seat
    // them when the panes already show a different role — the new terminals are
    // left unassigned while the pane keeps showing the old role.
    let freed = false;
    if (roleFilter) {
        for (let i = 0; i < slotCount && i < paneAssignments.length; i++) {
            const name = paneAssignments[i];
            // Also skips kanban panes: they hold no assignment, so a fill never
            // bulldozes a board pane.
            if (!name) { continue; }
            const term = fleetList.find(t => t.friendlyName === name);
            if (term && term.role !== roleFilter) {
                paneAssignments[i] = null;
                // sanitizePaneAssignments' invariant (line 1862): a pin never
                // outlives its slot's occupant. Clearing here avoids a transient
                // violation, and a live pin would reserve the slot against the fill.
                pinnedPanes[i] = false;
                freed = true;
            }
        }
    }

    // "Seated" must mean seated in a VISIBLE slot. paneAssignments is sized to
    // getMaxSlotCount() (sanitizePaneAssignments:1828), not to the current layout,
    // so an array-wide `includes` counts a terminal parked in a hidden slot as
    // already seated. On a role fill that shrinks the grid that made `unseated`
    // empty while the visible grid was empty — the function returned 0 ("all
    // seated"), skipped its own render and persist, and left the DOM showing a
    // terminal paneAssignments no longer held.
    const seated = new Set(paneAssignments.slice(0, slotCount).filter(Boolean));
    const unseated = fleetList
        .filter(t =>
            t.status !== 'exited' &&
            !seated.has(t.friendlyName) &&
            (!roleFilter || t.role === roleFilter)
        )
        .map(t => t.friendlyName);
    // `!freed` matters: a displacement that seats nothing still mutated
    // paneAssignments and pinnedPanes and MUST reach the render/persist tail.
    if (unseated.length === 0 && !freed) { return 0; }

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
    if (!changed && !freed) { return unseated.length; }
    if (!activeTerminalName) { activeTerminalName = paneAssignments[focusedPaneIndex] || null; }
    if (persist) { saveLayoutSettings(); }
    renderSidebarList();
    renderPaneGrid();
    batchFitVisiblePanes();
    return unseated.length;
}
```

Key changes:
1. **`roleFilter` extraction** from `opts.role` — absent when `openAllTerminals` calls with `{ persist: false }`, so open-all's behaviour is byte-identical.
2. **Displacement loop** — frees panes holding a different role and clears their pins. Runs only when `roleFilter` is set. Sets `freed`.
3. **Slot-bounded `seated` set** — replaces the array-wide `paneAssignments.includes(...)`, so a terminal in a hidden slot is correctly treated as unseated.
4. **`unseated` filter** — adds `(!roleFilter || t.role === roleFilter)` so displaced terminals of other roles don't reclaim the freed panes.
5. **Both early exits are `freed`-aware** — a displacement always reaches `saveLayoutSettings()` / `renderPaneGrid()`, so the DOM, the in-memory model, and the persisted settings never diverge.

**Edge cases.** `openAllTerminals` (no `role`): `roleFilter` is `undefined`, `freed` stays `false`, both guards behave exactly as before — the only behavioural delta on that path is the slot-bounded `seated` set, which is strictly more correct (open-all previously refused to seat a terminal parked in a hidden slot into a visible empty one). A role fill on a grid where every visible pane already holds the chosen role: nothing is freed, `unseated` is the surplus, `changed` is false, the function returns the surplus without touching state.

### `src/webview/terminals.js` — `fillGrid` (line 6474)

Pass `{ role }` to `fillEmptyPanes` so the chosen role claims the panes. Handle the `need <= 0` path by re-seating instead of just toasting. Subtract kanban panes from the seatable slots before computing `need`, so the fill never creates a terminal it cannot seat.

> **Superseded:** The originally proposed `need <= 0` branch, which toasted `"${role} already has ${liveCount} live terminal(s) — grid re-seated."` on `unseated === 0` and otherwise fell back to `"${unseated} terminal(s) could not be seated — choose a larger grid."`
> **Reason:** On the `need <= 0` path `unseated` is by definition the role's **surplus** — the operator deliberately picked a grid smaller than their fleet. Telling them to "choose a larger grid" blames the choice they just made and implies a failure that did not occur; the grid *was* filled with the chosen role.
> **Replaced with:** a surplus-aware toast that reports the re-seat as a success and names the leftovers as sidebar residents. The create path keeps the original "choose a larger grid" wording, where it is still accurate.

> **Superseded:** `const need = slots - liveCount;` where `slots = LAYOUTS[mode].slots`.
> **Reason:** Kanban-mode panes occupy visible slots but are never seated into (`paneModes[i] !== 'kanban'`). Counting them as seatable makes the fill create one terminal per kanban pane that it then cannot place — manufacturing exactly the orphan this plan exists to eliminate, and blaming it on grid size.
> **Replaced with:** `need = seatableSlots - liveCount`, where `seatableSlots` excludes kanban panes, using the established `paneModes.slice(0, n)` idiom (`src/webview/terminals.js:3925`). `paneModes` is padded to `getMaxSlotCount()` and never trimmed (line 3853), so slicing to the *target* layout's slot count is valid before `setLayoutMode` runs.

```js
async function fillGrid(role, mode) {
    if (!role || !LAYOUT_MODES.includes(mode)) {
        console.warn('[Terminals] Fill grid: bad role or mode', role, mode);
        return;
    }
    const slots = LAYOUTS[mode].slots;
    // Kanban panes hold a visible slot but are never seated into (fillEmptyPanes'
    // paneModes guard). Counting them as seatable creates one terminal per kanban
    // pane that the fill then cannot place — the orphan this plan exists to remove.
    // paneModes is padded to getMaxSlotCount() and never trimmed (line 3853), so
    // slicing to the TARGET layout's slot count is valid before setLayoutMode runs.
    const kanbanSlots = paneModes.slice(0, slots).filter(m => m === 'kanban').length;
    const seatableSlots = slots - kanbanSlots;

    // Count live instances of this role from the same list the UI renders.
    let liveCount = 0;
    for (const t of fleetList) {
        if (t.status !== 'exited' && t.role === role) { liveCount++; }
    }
    const need = seatableSlots - liveCount;
    if (need <= 0) {
        // Enough terminals of this role already exist. Still switch the layout
        // and re-seat so the grid shows the chosen role, displacing panes held
        // by other roles. Without this, "fill" on an already-sufficient fleet
        // toasts "no grid to fill" while the panes show something else entirely.
        setLayoutMode(mode);
        const unseated = fillEmptyPanes({ role });
        // `unseated` here is SURPLUS, not failure: the operator picked a grid
        // smaller than their fleet and got exactly that grid. Do not tell them
        // to choose a larger one — the create path's toast still means that.
        showPaneToast(unseated > 0
            ? `${role} grid re-seated — ${unseated} further ${role} terminal${unseated === 1 ? '' : 's'} left in the sidebar.`
            : `${role} already has ${liveCount} live terminal${liveCount === 1 ? '' : 's'} — grid re-seated.`);
        return;
    }

    const { hasCommand } = await fetchPtyVisibleRoles();
    initialAssignmentDone = true;
    setLayoutMode(mode);
    await createTerminalsForRole(role, need, hasCommand[role] === true);
    await fetchTerminalList();
    const unseated = fillEmptyPanes({ role });
    if (unseated > 0) {
        showPaneToast(`${unseated} terminal${unseated === 1 ? '' : 's'} could not be seated — choose a larger grid.`);
    }
}
```

Key changes:
1. **Kanban-aware `need`** — `seatableSlots` excludes kanban panes, so the fill creates only terminals it can actually seat. `LAYOUTS[mode].slots` is still the source of the slot count (contract-test literal preserved).
2. **`need <= 0` path** — now calls `setLayoutMode(mode)` and `fillEmptyPanes({ role })` to re-seat the grid with the chosen role, instead of returning immediately with a "no grid to fill" toast. The `if (need <= 0)` literal is preserved for the contract test.
3. **`fillEmptyPanes({ role })`** — passes the role filter so the chosen role's terminals are seated into panes freed from other roles. The old `fillEmptyPanes()` (no role) call is replaced on both paths.
4. **Surplus-aware toast** on the `need <= 0` path; the create path's "choose a larger grid" wording is unchanged.

**Edge cases.** All-kanban grid: `seatableSlots === 0`, `need <= 0`, the layout switches, nothing is seated, and the toast reports the role's terminals as sidebar residents — correct, since there is nowhere to seat. Fill with a role that has zero live terminals into an all-kanban grid: no terminals are created, which is the desired non-destructive outcome.

### `src/test/terminal-open-all-seating-contract.test.js`

Add tests asserting the fill-grid displacement contract. Extend the file — do not reorder the existing `block()` extractions, which depend on the `fillGrid` → `fillEmptyPanes` → `renameTerminal` declaration order.

```js
test('Fill grid passes a role filter to fillEmptyPanes so it displaces other roles', () => {
    const fill = block('async function fillGrid(role, mode) {', 'function fillEmptyPanes(');
    assert.ok(
        fill.includes('fillEmptyPanes({ role })'),
        'fillGrid must pass { role } to fillEmptyPanes so panes held by other roles are freed and the chosen role is seated'
    );
    assert.ok(
        /paneModes\.slice\(0, slots\)/.test(fill),
        'fillGrid must subtract kanban panes from the seatable slot count — a kanban pane is never seated into, so counting it creates a terminal the fill cannot place'
    );
    assert.ok(
        !/choose a larger grid/.test(fill.split('if (need <= 0)')[1]?.split('const { hasCommand }')[0] || ''),
        'the need<=0 branch reports SURPLUS, not failure — the operator chose that grid size deliberately'
    );
});

test('fillEmptyPanes role filter frees panes of other roles and seats only the chosen role', () => {
    const fn = block('function fillEmptyPanes(', 'async function renameTerminal(');
    assert.ok(
        fn.includes('roleFilter'),
        'fillEmptyPanes must extract a roleFilter from opts'
    );
    assert.ok(
        /paneAssignments\[i\] = null/.test(fn) && /pinnedPanes\[i\] = false/.test(fn),
        'fillEmptyPanes must free pane assignments and clear pins for other-role panes when roleFilter is active'
    );
    assert.ok(
        /!roleFilter \|\| t\.role === roleFilter/.test(fn),
        'fillEmptyPanes must filter unseated terminals to the chosen role when roleFilter is active'
    );
});

test('fillEmptyPanes scopes "already seated" to VISIBLE slots', () => {
    const fn = block('function fillEmptyPanes(', 'async function renameTerminal(');
    assert.ok(
        /paneAssignments\.slice\(0, slotCount\)/.test(fn),
        'the seated set must be bounded by slotCount — paneAssignments is sized to getMaxSlotCount(), so an array-wide includes() counts a terminal in a HIDDEN slot as seated and the fill silently seats nothing'
    );
    assert.ok(
        !/!paneAssignments\.includes\(/.test(fn),
        'the array-wide membership test must be gone — it is the hidden-slot bug'
    );
});

test('a displacement always reaches the render/persist tail', () => {
    const fn = block('function fillEmptyPanes(', 'async function renameTerminal(');
    assert.ok(
        /let freed = false/.test(fn) && /freed = true/.test(fn),
        'fillEmptyPanes must track whether it freed any pane'
    );
    assert.ok(
        /unseated\.length === 0 && !freed/.test(fn) && /!changed && !freed/.test(fn),
        'BOTH early returns must be freed-aware — returning after nulling paneAssignments leaves the DOM (already painted by setLayoutMode) disagreeing with the model, and skips saveLayoutSettings() so the change is lost on reload'
    );
});
```

## Verification Plan

### Automated Tests

1. **Unit — fill displaces other roles.** With a single pane showing `coder-1` and zero live planners, `fillGrid('planner', '1')` must create `planner-1`, free pane 0 from `coder-1`, and seat `planner-1` in pane 0. Assert `paneAssignments[0] === 'planner-1'` and `pinnedPanes[0] === false`.
2. **Unit — displaced terminal is not destroyed.** After the fill in test 1, `coder-1` must still be in `fleetList` with `status !== 'exited'` and must NOT be in `paneAssignments`.
3. **Unit — fill is a no-op on an already-filled grid.** With pane 0 showing `planner-1` and 1 live planner, `fillGrid('planner', '1')` must create 0 terminals and leave `paneAssignments[0] === 'planner-1'`.
4. **Unit — `need <= 0` re-seats.** With 3 live planners, pane 0 showing `coder-1`, and `fillGrid('planner', '2h')`: no terminals are created, layout switches to `2h`, pane 0 is freed from `coder-1`, and planners are seated into panes 0 and 1. Toast must report a re-seat plus surplus — not "choose a larger grid".
5. **Regression — the hidden-slot case.** Layout `2h`, pane 0 = `planner-1`, pane 1 = `coder-1`, exactly one live coder. `fillGrid('coder', '1')` must end with `paneAssignments[0] === 'coder-1'`, `saveLayoutSettings()` called, and `renderPaneGrid()` called. Asserting the render/persist calls is the point — the pre-fix code produced the correct-looking return value (`0`) while doing neither.
6. **Regression — over-creation against kanban panes.** Layout `2h`, pane 1 in kanban mode, zero live planners. `fillGrid('planner', '2h')` must create exactly **one** planner (not two) and seat it in pane 0. Pane 1 must still be in kanban mode.
7. **Unit — open-all is unchanged.** `openAllTerminals` calls `fillEmptyPanes({ persist: false })` without a `role` key. Assert the displacement loop does not run (no panes freed) when `opts.role` is absent.
8. **Unit — kanban panes are still skipped.** A kanban-mode pane is not freed or seated by the fill, matching the existing `paneModes[i] !== 'kanban'` guard.
9. **Unit — no confirm gate.** Static assertion that `fillGrid` introduces no `confirm(` / `window.confirm(` call.
10. **Contract — existing tests still pass.** All assertions in `terminal-open-all-seating-contract.test.js` for `fillGrid` and `fillEmptyPanes` must remain green: `LAYOUTS[mode].slots`, `LAYOUT_MODES.includes(mode)`, `t.status !== 'exited' && t.role === role`, `if (need <= 0)`, `setLayoutMode(mode)`, `opts.persist !== false`, `paneModes[i] !== 'kanban'`, `return unseated.length`, `return 0`. Also confirm the `openAllTerminals` extraction (which scans to `async function fillGrid(`) still finds exactly one `await fetchTerminalList();`.

**Note:** several test suites are red at HEAD in this tree for unrelated reasons (DB init, setup-panel, project-panel, terminal-pane-fit). Baseline them before starting so pre-existing reds are not attributed to this change.

### Manual Verification

1. Open the Terminals tab. Seat a `coder` terminal in the single pane (layout `1`).
2. Click **FILL GRID**, pick `planner`, pick size `1`, click **FILL**.
3. **Expected:** The pane switches to show `planner-1`. The `coder` terminal remains in the sidebar, alive but unseated. No "could not be seated" toast.
4. Click **FILL GRID** again, pick `planner`, pick size `1`, click **FILL**.
5. **Expected:** "planner already has 1 live terminal — grid re-seated." toast. Pane still shows `planner-1`. No new terminal created.
6. Click **FILL GRID**, pick `coder`, pick size `2h`, click **FILL**.
7. **Expected:** Layout switches to `2h`. Pane 0 shows `coder-1` (the existing one, re-seated). Pane 1 shows `planner-1` (displaced from pane 0 but re-seated into the new slot). No new terminals created (both roles already have enough).
8. **Hidden-slot check.** From the `2h` state above, click **FILL GRID**, pick `coder`, size `1`, **FILL**. **Expected:** the single pane shows `coder-1` immediately (not after a poll tick, and not blank). Reload the panel — the pane must still show `coder-1`, proving the arrangement was persisted.
9. **Kanban-pane check.** Set layout `2h`, switch pane 1 to kanban mode, then **FILL GRID** → a role with no live terminals → size `2h`. **Expected:** exactly one terminal is created and seated in pane 0; pane 1 stays on the board; no "could not be seated" toast.

Manual UAT requires a VSIX build — `dist/` is not used during development and the browser cockpit serves the VSIX's `dist`, so `src` edits are invisible until packaged.

## Recommendation

Complexity 4 → **Send to Coder**.

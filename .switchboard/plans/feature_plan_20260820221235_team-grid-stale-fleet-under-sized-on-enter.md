# Team grid shows too few terminals on first click — stale fleet under-sizes the layout

## Goal

When the user clicks a team icon in the shell rail to enter team-scoped mode, the terminal grid must show the correct number of panes for the **full team roster** immediately — not a partial grid that fills in seconds later after a fleet refresh. Today, a 4-agent team shows only 2 panes (with a "Showing 1–2 of 4" shortfall banner), then the remaining 2 panes appear seconds later when the fleet poll catches up. The grid should be sized and seated correctly from the first frame.

### Problem analysis

The shell rail's team button click handler (`src/webview/shell.js:826-834`) calls `selectPanel('terminals')` and posts a `switchToTeam` message to the terminals iframe. The terminals panel's message handler (`src/webview/terminals.js:1181-1187`) calls `enterTeamScope(groupId)`. The handler does not await this call (fire-and-forget), but `enterTeamScope` is itself `async` (`terminals.js:10419`) — it awaits `loadLayoutSettings()` and `loadQueueModeFromOrders()` before calling `switchToGroup(groupId)` at line 10444. The grid sizing therefore happens after those awaits, not synchronously on the click frame. However, these are fast localStorage reads, so the user-perceived delay is negligible.

`enterTeamScope` calls `switchToGroup(groupId)`, which calls `layoutForGroupSwitch(group)` to determine the grid layout:

```js
function layoutForGroupSwitch(group) {
    const stored = getStoredGroupLayout(group);
    if (stored && LAYOUT_MODES.includes(stored)) { return stored; }
    return smallestLayoutFitting(getGroupMembers(group).length);
}
```

The fallback path calls `getGroupMembers(group).length` to size the grid. `getGroupMembers` (`src/webview/terminals.js:3257-3274`) filters the group's member names against a **live set** derived from `fleetList`:

```js
const live = new Set(fleetList.filter(t => t.status !== 'exited').map(t => t.friendlyName));
let names = [];
if (group.source === 'manual') {
    const order = Array.isArray(group.order) ? group.order : (Array.isArray(group.members) ? group.members : []);
    names = order.filter(n => live.has(n));
    // ...
}
```

**Root cause: `fleetList` is stale at click time.** All panel iframes are created upfront when the shell loads (`src/webview/shell.js:1022-1024`), each with its `src` set immediately (`shell.js:622`). The terminals panel's `fleetPollTimer` ticks every 5 s (`terminals.js:6978-6987`), and `terminalsChanged` websocket pushes trigger on-demand `fetchTerminalList()` calls. But between polls, `fleetList` reflects the last fetch — which may predate the spawning of some team members. When `getGroupMembers` runs against this stale list, only 2 of 4 members pass the liveness filter. `smallestLayoutFitting(2)` returns `'2h'` (2 slots), so `setLayoutMode('2h')` and `seatActiveGroupPage()` seat only 2 members.

When the remaining terminals appear (via `terminalsChanged` or the 5 s poll), `fetchTerminalList()` updates `fleetList` but **does not re-seat the group on subsequent fetches**. The `restoredLockOnLoad` gate (`terminals.js:2122`) only fires once:

```js
if (!restoredLockOnLoad && activeGroupId) {
    restoredLockOnLoad = true;
    // ...switchToGroup(savedId, { noSave: true });
}
```

After the first load, `restoredLockOnLoad` is `true` and this block is skipped. `sanitizePaneAssignments()` (`terminals.js:2424`) only drops stale names — it never adds new members to panes. `applyLayoutFloor()` (`terminals.js:7091`) calls `resolveFlooredLayout()` which **only steps DOWN** from `currentLayout` (it walks `LAYOUT_FLOOR_ORDER` descending, never ascending — `terminals.js:6251-6259`). So the grid stays at 2 slots. The shortfall banner appears ("Showing 1–2 of 4") but the grid never auto-grows.

The "other 2 finally show up seconds later" happens only when the `restoredLockOnLoad` path fires — i.e., when the first `fetchTerminalList` with `activeGroupId` set happens to coincide with the fleet already having all 4 members. If `restoredLockOnLoad` already fired before the team icon was clicked (the common case, since the panel loaded with the shell), the grid is stuck at 2 panes with paging until the user manually intervenes.

### Fix shape

Two changes, both in `src/webview/terminals.js`:

1. **Size the grid for the full roster, not just live members.** In `layoutForGroupSwitch`, use the group's `members`/`order` array length (the authored roster) for the `smallestLayoutFitting` fallback, instead of `getGroupMembers(group).length` (which filters by the stale live set). This makes the grid 2×2 for a 4-member team from the first frame, even if only 2 terminals are live yet. The empty panes render as idle slots until the terminals appear.

2. **Re-seat the active group on every fleet update — gated on live-member-count change.** In `fetchTerminalList`, after the `restoredLockOnLoad` first-load path, if `activeGroupId` is set and the live member count has changed since the last seating, call `seatActiveGroupPage()` to seat newly-live members into the already-sized grid. The count-change gate prevents overriding manual pane drags every 5 s — `seatActiveGroupPage` rebuilds `paneAssignments` from scratch, so an unconditional call would wipe a drag on every poll. This is the same function already called on resize and page navigation — it is the canonical re-seating mechanism for a locked group.

## Metadata

- **Complexity:** 4
- **Tags:** bugfix, ui, frontend
- **Project:** Browser Switchboard

## User Review Required

This plan modifies the grid-sizing fallback for all locked groups (not just team-scoped ones) and adds a new re-seat path on every fleet fetch. The re-seat is gated on live-member-count change to avoid overriding manual pane drags, but the user should confirm this gating is sufficient — if pane position within a locked group carries semantic meaning beyond "which terminal is in which slot," a count-change gate may not be enough (the member SET could change without the count changing). Review the proposed code for fix #2 before implementation.

## Complexity Audit

### Routine

- `layoutForGroupSwitch` is a pure function with one call site (`switchToGroup`). Changing the fallback argument from `getGroupMembers(group).length` to the roster length is a one-line edit.
- `fetchTerminalList` already has the `restoredLockOnLoad` re-seat path; adding a subsequent-fetch re-seat is a symmetric addition in the same function.
- `seatActiveGroupPage` is already called from 6 other sites (resize, page nav, group switch, exit scope, `applyLayoutFloor` changed branch, banner page button). Adding one more call site does not change its behaviour.
- The `lastSeatedLiveCount` tracker is a single module-level variable with a simple comparison — no data structure complexity.

### Complex / Risky

- `seatActiveGroupPage()` rebuilds `paneAssignments` from scratch. Calling it on every fleet poll (5 s) without gating would override manual pane drags within a locked group every 5 s. The count-change gate (`lastSeatedLiveCount`) mitigates this, but a set change without a count change (one member exits, another spawns) would not trigger a re-seat. This is an acceptable trade-off: the exited member's pane is nulled by `sanitizePaneAssignments`, and the new member is seated on the next count-changing fetch. If the count stays the same indefinitely, the new member remains unseated until the user manually interacts — but this is a narrow edge case (simultaneous exit + spawn with no net count change).
- `layoutForGroupSwitch` using the full roster means a group with exited/dead members would size for the roster, not the live count. This is correct: the panes for dead members render as empty slots (the stale-slot drop in `sanitizePaneAssignments` nulls them), and the shortfall banner's paging still works. But it means a team with 4 roster entries and 2 exited members shows a 2×2 grid with 2 empty panes. This is better than the current 2h with a confusing warning.

## Edge-Case & Dependency Audit

### Race Conditions

1. **`enterTeamScope` is async — two rapid clicks interleave.** `enterTeamScope` already guards against this: it checks `if (teamScopeId !== groupId) { return; }` after each await (lines 10436, 10443). A stale call that wakes up after a newer click is discarded. The fix does not change this flow — `switchToGroup` at line 10444 runs with the correct `teamScopeId`.

2. **`fetchTerminalList` fires during `enterTeamScope`'s awaits.** If a `terminalsChanged` websocket push triggers `fetchTerminalList` while `enterTeamScope` is awaiting `loadLayoutSettings`, the `restoredLockOnLoad` path may fire first with the stale fleet, sizing the grid to 2. Then `enterTeamScope`'s `switchToGroup` call re-sizes to 4 (with fix #1). The subsequent `fetchTerminalList` calls hit the `else if (activeGroupId)` branch and re-seat if the live count changed. The race is handled — the grid converges to the correct size.

3. **`restoredLockOnLoad` interaction.** The first-load restore path (`terminals.js:2122-2140`) calls `switchToGroup(savedId, { noSave: true })` which calls `layoutForGroupSwitch` → `setLayoutMode` → `seatActiveGroupPage`. With fix #1, this path now also benefits from the full-roster sizing. The subsequent-fetch re-seat (fix #2) is gated on `restoredLockOnLoad` being true (i.e., the first-load path already ran or was skipped), so the two paths don't double-fire.

### Security

- No security implications. All changes are client-side rendering logic within the terminals webview. No new message handlers, no new network requests, no new data exposure.

### Side Effects

4. **`seatActiveGroupPage` resets `activeGroupPage` to 0 when it exceeds the page count** (`terminals.js:3107`). If the user is on page 2 and a re-seat fires, they jump back to page 1. This is acceptable: a fleet update that changes the member count is a structural change, and the existing resize path already does the same thing. The count-change gate reduces the frequency of this reset.

5. **Non-team locked groups.** The fix applies to any locked group (`activeGroupId` set), not just team-scoped groups. This is correct — a hand-saved role group with members that spawn late has the same stale-fleet problem.

6. **Solo mode.** `seatActiveGroupPage` early-returns when `activeGroupId` is null (`terminals.js:3102-3103`). Solo mode never sets `activeGroupId`, so the re-seat is a no-op there.

7. **`enterTeamScope` is async.** The function is `async function enterTeamScope(groupId)` (`terminals.js:10419`). It awaits `loadLayoutSettings()` and `loadQueueModeFromOrders()` before calling `switchToGroup(groupId)` at line 10444. The grid is sized correctly when `switchToGroup` runs (after the awaits), not on the literal click frame. The awaits are fast localStorage reads, so the user-perceived delay is negligible. The fix does not change `enterTeamScope`'s async nature — it doesn't need to. Fix #1 applies inside `switchToGroup` → `layoutForGroupSwitch`, and fix #2 applies in `fetchTerminalList`, both of which run independently of `enterTeamScope`'s async flow.

8. **Group with no `members` or `order` array.** `getGroupMembers` returns `[]` for a group with no members. The roster-length fallback uses `Math.max(rosterSize, getGroupMembers(group).length)`, so if both are 0, `smallestLayoutFitting(0)` returns `'1'` (1 slot) — same as today. For derived groups (role/worktree), `rosterSize` is 0 (no `order`/`members` array), so `Math.max(0, liveCount)` = `liveCount` — the live count is used, which is correct for derived groups since they have no authored roster.

### Dependencies & Conflicts

9. **Stored layout overrides the fallback.** If the group has a stored layout (via `getStoredGroupLayout`), `layoutForGroupSwitch` returns it regardless of member count. A stored `'2h'` for a 4-member team will still produce 2 slots with paging. This is the user's explicit preference and is not changed by this fix. The fix only affects the **fallback** path (no stored layout).

10. **`Math.max(rosterSize, liveCount)` edge case.** For manual groups, `liveCount` can exceed `rosterSize` when `group.members` has live names not present in `group.order` (the `getGroupMembers` function appends such names at line 3272-3274). `Math.max` correctly picks the larger value in this case, sizing the grid for all live members even if the `order` array is incomplete.

## Dependencies

- None. This plan is self-contained within `src/webview/terminals.js` and `src/test/terminal-sidebar-groupings-contract.test.js`.

## Adversarial Synthesis

Key risks: (1) the re-seat path could override manual pane drags if not gated — mitigated by the `lastSeatedLiveCount` count-change gate; (2) `enterTeamScope`'s async nature means the grid sizing happens after localStorage awaits, not on the literal click frame — negligible delay, fix still correct; (3) a set change without a count change (simultaneous exit + spawn) won't trigger a re-seat — narrow edge case, self-corrects on the next count-changing fetch. Mitigations: count-change gate on re-seat, roster-based sizing that doesn't depend on fleet freshness, and the existing `sanitizePaneAssignments` stale-slot drop handles exited members independently.

## Proposed Changes

### 1. `src/webview/terminals.js` — `layoutForGroupSwitch`: use full roster for fallback sizing

**Current** (`terminals.js:3355-3359`):
```js
function layoutForGroupSwitch(group) {
    const stored = getStoredGroupLayout(group);
    if (stored && LAYOUT_MODES.includes(stored)) { return stored; }
    return smallestLayoutFitting(getGroupMembers(group).length);
}
```

**Proposed:**
```js
function layoutForGroupSwitch(group) {
    const stored = getStoredGroupLayout(group);
    if (stored && LAYOUT_MODES.includes(stored)) { return stored; }
    // Size for the full authored roster, not just the live subset. fleetList
    // may be stale at switch time (the panel's 5 s poll hasn't caught up to
    // a recent spawn), so getGroupMembers — which filters by liveness — can
    // under-count and produce a grid too small for the team. The roster
    // (group.order, else group.members) is the operator's authored set and
    // is stable across fleet refreshes. Empty panes for not-yet-live
    // members render as idle slots until the next fetchTerminalList seats
    // them. Math.max with the live count covers the case where group.members
    // has live names not in group.order (getGroupMembers appends them at
    // line 3272-3274), and also falls back to liveCount for derived groups
    // (role/worktree) which have no authored roster.
    const rosterSize = Array.isArray(group.order) ? group.order.length
        : (Array.isArray(group.members) ? group.members.length : 0);
    const liveCount = getGroupMembers(group).length;
    return smallestLayoutFitting(Math.max(rosterSize, liveCount));
}
```

### 2. `src/webview/terminals.js` — module-level tracker for re-seat gating

Add near the `restoredLockOnLoad` declaration (`terminals.js:111`):

```js
let lastSeatedLiveCount = -1; // live member count at last fetchTerminalList re-seat; gates seatActiveGroupPage
```

### 3. `src/webview/terminals.js` — `fetchTerminalList`: re-seat active group on subsequent fetches, gated on live-member-count change

**Current** (`terminals.js:2122-2146`):
```js
if (!restoredLockOnLoad && activeGroupId) {
    restoredLockOnLoad = true;
    const savedId = String(activeGroupId);
    if (getAllGroups().some(g => g.id === savedId)) {
        switchToGroup(savedId, { noSave: true });
    } else if (!groupPrefs.autoRoleGroups && savedId.startsWith('dg_role_')) {
        clearGroupLock();
    }
}
sanitizePaneAssignments();
renderSidebarList();
renderPaneGrid();
applyLayoutFloor();
```

> **Superseded:** Unconditional re-seat on every subsequent fetch:
> ```js
> } else if (activeGroupId) {
>     seatActiveGroupPage();
> }
> ```
> **Reason:** `seatActiveGroupPage` rebuilds `paneAssignments` from scratch (line 3114). An unconditional call on every 5 s poll would override manual pane drags within a locked group every 5 s. The plan's own Complexity Audit identified this risk and proposed gating on live-member-count change, but the original proposed code did not implement the gate.
> **Replaced with:** Gated re-seat that only fires when the live member count has changed, plus a `lastSeatedLiveCount` tracker to detect the change:

**Proposed:**
```js
if (!restoredLockOnLoad && activeGroupId) {
    restoredLockOnLoad = true;
    const savedId = String(activeGroupId);
    if (getAllGroups().some(g => g.id === savedId)) {
        switchToGroup(savedId, { noSave: true });
    } else if (!groupPrefs.autoRoleGroups && savedId.startsWith('dg_role_')) {
        clearGroupLock();
    }
} else if (activeGroupId) {
    // Subsequent fetch: re-seat the locked group so members that became
    // live since the last poll are seated into the grid. The first-load
    // path above calls switchToGroup (which seats); this path handles
    // every fetch after that. Without it, a team whose members spawned
    // after the initial load stay invisible in the pane grid until the
    // user manually clicks the group tab or changes the layout.
    //
    // Gate on live-member-count change so manual pane drags within a
    // locked group are not overridden every 5 s. seatActiveGroupPage
    // rebuilds paneAssignments from scratch, so an unconditional call
    // would wipe a drag on every poll. When the count is unchanged the
    // existing assignments are still valid — sanitizePaneAssignments
    // (below) handles stale-slot drops independently.
    //
    // Edge case: a set change without a count change (one member exits,
    // another spawns) will not trigger a re-seat. The exited member's
    // pane is nulled by sanitizePaneAssignments; the new member is
    // seated on the next count-changing fetch. This is a narrow case
    // and self-corrects.
    const group = getAllGroups().find(g => g.id === activeGroupId);
    const liveCount = group ? getGroupMembers(group).length : 0;
    if (liveCount !== lastSeatedLiveCount) {
        seatActiveGroupPage();
    }
}
// Track the live count after any seating path (first-load or subsequent)
// so the else-if gate above can detect changes on the next fetch.
if (activeGroupId) {
    const g = getAllGroups().find(gg => gg.id === activeGroupId);
    lastSeatedLiveCount = g ? getGroupMembers(g).length : 0;
}
sanitizePaneAssignments();
renderSidebarList();
renderPaneGrid();
applyLayoutFloor();
```

### 4. Test — `src/test/terminal-sidebar-groupings-contract.test.js`

Add a test asserting that `layoutForGroupSwitch` uses the group's roster length, not `getGroupMembers` length, for the `smallestLayoutFitting` fallback:

```js
test('layoutForGroupSwitch sizes for the full roster, not just live members', () => {
    const fn = block(terminalsJs, 'function layoutForGroupSwitch(', 'function findGroupForTerminalName(');
    // The fallback must not call smallestLayoutFitting(getGroupMembers(group).length)
    // directly — it must use the roster size (group.order or group.members).
    assert.ok(
        !/smallestLayoutFitting\(getGroupMembers\(group\)\.length\)/.test(fn),
        'layoutForGroupSwitch must not size the grid by live member count alone — fleetList may be stale'
    );
    assert.ok(
        /rosterSize/.test(fn) && /group\.order|group\.members/.test(fn),
        'layoutForGroupSwitch must compute a roster size from group.order or group.members for the fallback'
    );
});
```

Add a test asserting that `fetchTerminalList` re-seats the active group on subsequent fetches:

```js
test('fetchTerminalList re-seats the active group on subsequent (non-first) fetches', () => {
    const fn = block(terminalsJs, 'async function fetchTerminalList(', 'function checkSoloNotFound(');
    // The else-if branch after the restoredLockOnLoad block must call
    // seatActiveGroupPage so newly-live members are seated.
    assert.ok(
        /else\s+if\s*\(activeGroupId\)/.test(fn) && /seatActiveGroupPage\(\)/.test(fn),
        'fetchTerminalList must re-seat the active group on subsequent fetches, not just the first load'
    );
});
```

Add a test asserting that the re-seat is gated on live-member-count change:

```js
test('fetchTerminalList gates the subsequent re-seat on live-member-count change', () => {
    const fn = block(terminalsJs, 'async function fetchTerminalList(', 'function checkSoloNotFound(');
    assert.ok(
        /lastSeatedLiveCount/.test(fn),
        'fetchTerminalList must track lastSeatedLiveCount to avoid overriding manual pane drags on every poll'
    );
});
```

## Verification Plan

### Automated Tests

1. **Unit tests:** `node --test src/test/terminal-sidebar-groupings-contract.test.js` — existing tests pass, new tests pass.
2. **Shell strip tests:** `node --test src/test/shell-terminal-strip.test.js` — the `switchToTeam` message handler tests still pass (no change to the shell-side click handler).

### Manual Verification

3. **Manual repro:**
   - Start a 4-agent team (head + 3 delegates).
   - Wait for all 4 terminals to be running.
   - Open the shell (or reload it) so the terminals panel's `fleetList` is populated.
   - Click the team icon in the shell rail.
   - **Expected:** the grid shows 4 panes (2×2) immediately, all 4 terminals seated. No shortfall banner.
4. **Manual repro — stale fleet:**
   - Start a 4-agent team.
   - Immediately click the team icon before all members appear in the fleet (race the spawn).
   - **Expected:** the grid shows 4 panes (2×2) immediately. 2 panes may be empty briefly; the remaining 2 fill in within one poll cycle (≤5 s) without manual intervention. No shortfall banner once all members are live.
5. **Manual repro — stored layout:**
   - Manually set a team's layout to 2h (2 slots) via the layout picker.
   - Click away and back to the team.
   - **Expected:** the grid shows 2 panes (stored layout honoured) with the paging banner. This is the user's explicit preference and is not overridden.
6. **Manual repro — non-team group:**
   - Lock onto a role group with 3 members.
   - Spawn a 4th terminal matching the role.
   - **Expected:** the 4th terminal is seated into the grid on the next fleet update without manually re-clicking the group tab.
7. **Manual repro — manual pane drag preservation:**
   - Lock onto a group with 3 members.
   - Manually drag a terminal to a different pane slot.
   - Wait 10 s (two poll cycles).
   - **Expected:** the drag is preserved. The re-seat does not fire because the live member count has not changed.

## Review Findings

Files changed: `src/webview/terminals.js` — roster sizing in `layoutForGroupSwitch` (:4466-4481), the gated re-seat in `fetchTerminalList` (:2558-2585), the `lastSeatedLiveCount` tracker (:151, now stamped in `seatActiveGroupPage` at :4154) — and three new tests in `src/test/terminal-sidebar-groupings-contract.test.js`. **Fix #1 is unreachable and does not change behaviour for any group** (see CRITICAL below), so the plan's headline goal — a team grid sized for the full roster on first click — is not achieved; fix #2 does land and is correct. One MAJOR was fixed during review: the re-seat gate was stamped only in `fetchTerminalList`, leaving it stale after `switchToGroup` and the layout picker (both seat without touching it), so the first poll after a group switch re-seated and wiped the manual pane drag the gate exists to protect — the count is now recorded inside `seatActiveGroupPage`, the one seam every seating path runs through. `npm run compile-tests` is clean and `terminal-sidebar-groupings` is 51 passed / 5 failed, with all 5 failures reproduced unchanged at the parent commit `47c1deca^` (pre-existing, unrelated stale source-text markers).

## Deferred Findings

- CRITICAL `src/webview/terminals.js:4480` — the roster-sizing fallback in `layoutForGroupSwitch` is dead code on every possible input, so fix #1 is a no-op. `getStoredGroupLayout` (:4445) returns `group.layout` for any `source === 'manual'` group and short-circuits before the fallback; every spawned team is `source: 'manual'` with `layout` always written (`src/services/teamWiring.ts:1769-1773`, merge at :1800-1807), both panel load paths drop rows whose layout is not a `LAYOUT_MODE` (:2245, :2458-2461), and `ManualGroupStore` always writes `source: 'manual'` plus `layout: group.layout || '1'` (`src/services/ManualGroupStore.ts:68-72`). The only groups that reach the fallback are derived `role`/`worktree` groups, whose literals (:4305-4327) carry no `order` and no `members`, so `rosterSize` is 0 and `Math.max(0, live)` is identical to the previous expression. Escalated — see **Review Deviations**.
- CRITICAL `src/webview/terminals.js:4200` — the plan's root cause is superseded. `seatActiveGroupPage` already seats a manual/team group by `group.order` with `null` holds for not-yet-live members (:4177-4198, landed in `cb3da221`), so the stale-fleet seating defect the plan describes was fixed before this work. The residual "Showing 1-2 of 4" symptom is produced entirely by `getSlotCount(effectiveLayout)` — i.e. by `group.layout` being smaller than the roster, which happens when a team grows and `teamWiring`'s merge preserves the older `existing.layout`. Escalated — see **Review Deviations**.
- MAJOR `src/webview/terminals.js:910` — `group.layout` is written both by `layoutForTeamSize` (auto-assigned) and by the operator's layout picker, with no field distinguishing them. This is the `CLAUDE.md` "a fallback must never be indistinguishable from a real value" shape on a configuration read, and it is why the CRITICAL above cannot be fixed without an author decision.
- NIT `src/webview/terminals.js:2582` — a member-set change with no count change (one member exits as another spawns) still does not trigger a re-seat. Documented and accepted in the plan.
- NIT `src/webview/terminals.js:2579` — the gate calls `getAllGroups()` on every poll, which rebuilds derived groups over the whole fleet. Cheap today, but it is per-5s work on the Pi.

### Review Deviations

*Inert prose for the author — not a directive to a future agent.*

**What I changed:** nothing about the plan's destination. I implemented no override of the stored layout, and left fix #1 in place as written.

**Why the original destination is a blocker:** the plan sites its primary fix in `layoutForGroupSwitch`'s `smallestLayoutFitting` fallback, but that fallback is unreachable for every group that has a roster (evidence chain in the CRITICAL entries above). A spawned team always carries a valid `group.layout`, so `getStoredGroupLayout` answers first and the new roster code never runs. The plan's own Edge-Case note 9 and Verification step 5 explicitly require the stored layout to be honoured, which means the one change that *would* make the sizing follow the roster — flooring the stored layout at the roster size — is ruled out by the plan itself. The two requirements are not jointly satisfiable, so no implementation in this location can achieve the goal.

**What the author needs to decide:** whether a team's `group.layout` may be floored at its roster size when the stored layout has fewer slots than the team has members. That is a real behaviour change: because the layout picker writes `group.layout` for manual groups (`terminals.js:910`), the same field carries both the auto-assigned team size and a deliberate operator choice, and they are indistinguishable. Flooring would therefore also override an operator who deliberately picked a smaller grid for a large team — reversing Verification step 5. If the answer is yes, the durable fix is probably to separate the auto-assigned team layout from the operator-authored one (e.g. keep the picker's choice in `groupPrefs.layouts[id]` for team groups too, as derived groups already do) so the floor applies only to the auto value. That is a larger change than this subtask scoped, which is why it is returned rather than decided here.

## Resolution — author decision, implemented

The escalation above was answered by the author: the two requirements were never in
conflict, they were two preferences sharing one field. The fix is an **AUTO option in
the layout picker**, on by default for new teams.

- `AUTO_LAYOUT = 'auto'` is now a storable layout *preference*, distinct from the
  rendered modes (`src/webview/terminals.js:2013`, `STORABLE_GROUP_LAYOUTS` at :2042).
  `'auto'` means "size this group to its roster"; a concrete mode means "cap it here".
  `layoutForGroupSwitch` (:4523) returns a concrete stored mode outright and falls
  through to the roster fallback on `'auto'` — which is what finally makes the roster
  code from this plan **reachable**.
- The picker gained an AUTO button (`terminals.html:173`), a store/read pair
  (`setStoredGroupLayout` :4507 mirroring `getStoredGroupLayout` :4491), and an active
  state driven by the stored preference rather than `currentLayout`
  (`syncLayoutPickerUI` :6177). AUTO is disabled when no group is locked — there is
  nothing to store it against.
- New teams register `layout: 'auto'` (`src/services/teamWiring.ts:1758`) and the merge
  preserves a stored `'auto'` via the new `TERMINALS_STORABLE_LAYOUTS` (:98). The
  spawn-time sizer `layoutForTeamSize` and its `TEAM_LAYOUT_LADDER` are removed — nothing
  picks a concrete mode for a team any more.
- Both load-time whitelists now validate against `STORABLE_GROUP_LAYOUTS` (:2289, :2506).
  This was the sharp edge: had they kept filtering on `LAYOUT_MODES`, every auto group
  would have been dropped from the board with no error anywhere.

Verification: `npm run compile-tests` clean; `terminal-sidebar-groupings` 59 passed / 5
failed and `standing-orders-marker` 11 failed, both failure sets **byte-identical to the
parent commit `47c1deca^`**; 13 further team/group suites clean. The new coverage is
behavioural where it matters — `makeLayoutResolver` lifts the real `getStoredGroupLayout`
and `layoutForGroupSwitch` out of the panel and runs them against a real team-group shape,
because source-text assertions are exactly what failed to catch the original dead code.

**Clean slate — author decision, no migration.** Every stored size was produced by the
sizing logic this change replaces, so none of them is carried. The preference moved to a
field those rows do not have — `group.layoutPref` for manual groups,
`groupPrefs.layoutPrefs[id]` for derived — and an absent preference already sizes from
the roster. So every pre-existing group is auto on its next load with **no migration
pass, no one-shot flag and nothing to undo**. `group.layout` and `groupPrefs.layouts` are
retired in place: still carried so rows stay loadable (both load filters require a valid
`layout`), never read for sizing again.

This shape was chosen over flipping the stored values because `loadLayoutSettings` re-runs
on every team-scope entry — anything that rewrote sizes in place would need a durable
one-shot flag, or it would overwrite a cap the operator had picked *since* the migration,
on a timer, forever. Retiring the field cannot re-run, because there is nothing to run.
Two tests pin exactly that: a pre-change row reads as no-preference for all seven stored
modes, and a pick made afterwards is read back from the live field.

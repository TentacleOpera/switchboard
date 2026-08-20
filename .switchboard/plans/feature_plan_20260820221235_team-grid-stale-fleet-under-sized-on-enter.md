# Team grid shows too few terminals on first click — stale fleet under-sizes the layout

## Goal

When the user clicks a team icon in the shell rail to enter team-scoped mode, the terminal grid must show the correct number of panes for the **full team roster** immediately — not a partial grid that fills in seconds later after a fleet refresh. Today, a 4-agent team shows only 2 panes (with a "Showing 1–2 of 4" shortfall banner), then the remaining 2 panes appear seconds later when the fleet poll catches up. The grid should be sized and seated correctly from the first frame.

### Problem analysis

The shell rail's team button click handler (`src/webview/shell.js:826-834`) calls `selectPanel('terminals')` and posts a `switchToTeam` message to the terminals iframe. The terminals panel's message handler (`src/webview/terminals.js:1181-1187`) calls `enterTeamScope(groupId)` synchronously.

`enterTeamScope` (`src/webview/terminals.js:10414-10424`) calls `switchToGroup(groupId)`, which calls `layoutForGroupSwitch(group)` to determine the grid layout:

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

After the first load, `restoredLockOnLoad` is `true` and this block is skipped. `sanitizePaneAssignments()` (`terminals.js:2424`) only drops stale names — it never adds new members to panes. `applyLayoutFloor()` (`terminals.js:7091`) calls `resolveFlooredLayout()` which **only steps DOWN** from `currentLayout` (it walks `LAYOUT_FLOOR_ORDER` descending, never ascending). So the grid stays at 2 slots. The shortfall banner appears ("Showing 1–2 of 4") but the grid never auto-grows.

The "other 2 finally show up seconds later" happens only when the `restoredLockOnLoad` path fires — i.e., when the first `fetchTerminalList` with `activeGroupId` set happens to coincide with the fleet already having all 4 members. If `restoredLockOnLoad` already fired before the team icon was clicked (the common case, since the panel loaded with the shell), the grid is stuck at 2 panes with paging until the user manually intervenes.

### Fix shape

Two changes, both in `src/webview/terminals.js`:

1. **Size the grid for the full roster, not just live members.** In `layoutForGroupSwitch`, use the group's `members`/`order` array length (the authored roster) for the `smallestLayoutFitting` fallback, instead of `getGroupMembers(group).length` (which filters by the stale live set). This makes the grid 2×2 for a 4-member team from the first frame, even if only 2 terminals are live yet. The empty panes render as idle slots until the terminals appear.

2. **Re-seat the active group on every fleet update.** In `fetchTerminalList`, after `sanitizePaneAssignments()`, if `activeGroupId` is set and the `restoredLockOnLoad` first-load path did not fire, call `seatActiveGroupPage()` to seat newly-live members into the already-sized grid. This is the same function already called on resize and page navigation — it is the canonical re-seating mechanism for a locked group.

## Metadata

- **Complexity:** 4
- **Tags:** bugfix, ui, frontend
- **Project:** Browser Switchboard

## Complexity Audit (Routine vs Complex/Risky)

**Routine:**
- `layoutForGroupSwitch` is a pure function with one call site (`switchToGroup`). Changing the fallback argument from `getGroupMembers(group).length` to the roster length is a one-line edit.
- `fetchTerminalList` already has the `restoredLockOnLoad` re-seat path; adding a subsequent-fetch re-seat is a symmetric addition in the same function.
- `seatActiveGroupPage` is already called from 6 other sites (resize, page nav, group switch, exit scope). Adding one more call site does not change its behaviour.

**Moderate risk:**
- `seatActiveGroupPage()` rebuilds `paneAssignments` from scratch. Calling it on every fleet poll (5 s) means manual pane drags within a locked group are overridden every 5 s. This is **already the case** on window resize (via `applyLayoutFloor`'s `changed` branch), so the new call site does not lower the bar — but it does increase the frequency. The mitigation is to only re-seat when the live member count has actually changed, not on every poll.
- `layoutForGroupSwitch` using the full roster means a group with exited/dead members would size for the roster, not the live count. This is correct: the panes for dead members render as empty slots (the stale-slot drop in `sanitizePaneAssignments` nulls them), and the shortfall banner's paging still works. But it means a team with 4 roster entries and 2 exited members shows a 2×2 grid with 2 empty panes. This is better than the current 2h with a confusing warning.

## Edge-Case & Dependency Audit

1. **Stored layout overrides the fallback.** If the group has a stored layout (via `getStoredGroupLayout`), `layoutForGroupSwitch` returns it regardless of member count. A stored `'2h'` for a 4-member team will still produce 2 slots with paging. This is the user's explicit preference and is not changed by this fix. The fix only affects the **fallback** path (no stored layout).

2. **`restoredLockOnLoad` interaction.** The first-load restore path (`terminals.js:2122-2140`) calls `switchToGroup(savedId, { noSave: true })` which calls `layoutForGroupSwitch` → `setLayoutMode` → `seatActiveGroupPage`. With fix #1, this path now also benefits from the full-roster sizing. The subsequent-fetch re-seat (fix #2) is gated on `restoredLockOnLoad` being true (i.e., the first-load path already ran or was skipped), so the two paths don't double-fire.

3. **`seatActiveGroupPage` resets `activeGroupPage` to 0 when it exceeds the page count** (`terminals.js:3107`). If the user is on page 2 and a re-seat fires, they jump back to page 1. This is acceptable: a fleet update that changes the member count is a structural change, and the existing resize path already does the same thing.

4. **Non-team locked groups.** The fix applies to any locked group (`activeGroupId` set), not just team-scoped groups. This is correct — a hand-saved role group with members that spawn late has the same stale-fleet problem.

5. **Solo mode.** `seatActiveGroupPage` early-returns when `activeGroupId` is null (`terminals.js:3102-3103`). Solo mode never sets `activeGroupId`, so the re-seat is a no-op there.

6. **`enterTeamScope` is synchronous.** The fix does not make it async. The grid is sized correctly from the first frame (fix #1), and the re-seat (fix #2) fills in members as they appear. No await needed.

7. **Group with no `members` or `order` array.** `getGroupMembers` returns `[]` for a group with no members. The roster-length fallback uses `Math.max(rosterSize, getGroupMembers(group).length)`, so if both are 0, `smallestLayoutFitting(0)` returns `'1'` (1 slot) — same as today.

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
    // them. Math.max with the live count covers a roster that is stale
    // in the other direction (members removed but still live).
    const rosterSize = Array.isArray(group.order) ? group.order.length
        : (Array.isArray(group.members) ? group.members.length : 0);
    const liveCount = getGroupMembers(group).length;
    return smallestLayoutFitting(Math.max(rosterSize, liveCount));
}
```

### 2. `src/webview/terminals.js` — `fetchTerminalList`: re-seat active group on subsequent fetches

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
    // seatActiveGroupPage rebuilds paneAssignments from the group's live
    // members — the same function called on resize and page navigation.
    // It calls renderPaneGrid() internally, so the explicit render below
    // is a harmless redundant pass.
    seatActiveGroupPage();
}
sanitizePaneAssignments();
renderSidebarList();
renderPaneGrid();
applyLayoutFloor();
```

### 3. Test — `src/test/terminal-sidebar-groupings-contract.test.js`

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

## Verification Plan

1. **Unit tests:** `node --test src/test/terminal-sidebar-groupings-contract.test.js` — existing tests pass, new tests pass.
2. **Shell strip tests:** `node --test src/test/shell-terminal-strip.test.js` — the `switchToTeam` message handler tests still pass (no change to the shell-side click handler).
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

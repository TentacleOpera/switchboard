# Make Peek Non-Destructive: Restore the Exact Grid the Peek Interrupted

## Goal

Peeking an unseated terminal must not evict a seated one. Pressing `restore` must put the grid back byte-for-byte as it was before the peek — same terminals, same slots, same pins, same focus.

### The problem

With four agents filling a 2x2 grid, clicking `peek` on a fifth terminal shows that fifth terminal full-pane. Clicking `restore` returns a 2x2 grid in which the **peeked** terminal now occupies slot 1 and the agent that was in slot 1 is gone from the grid entirely. The peek permanently rewrote the layout it was supposed to be a temporary glance at.

### Root cause — peek seats the terminal through the displacing composer path, and dismiss has nothing to restore from

`peekTerminal` (`src/webview/terminals.js:4019`) can only show a terminal that occupies a pane, because the presentation is CSS-driven (`applyPeekClasses` at line 3965 toggles `.is-peeking` on the grid and `.is-peeked` on the one pane whose assignment matches). So when the target is unseated it seats it first:

```js
if (paneAssignments.indexOf(name) === -1) {
    if (activeGroupId) { handleLockedTerminalClick(name); }
    else { locateTerminal(name); }
}
const index = paneAssignments.indexOf(name);
if (index === -1) { return; }
peekTerminalName = name;
applyPeekClasses();
afterPeekTransition();
```

`locateTerminal` (line 3425) calls `assignToFocusedPane`, which is the **deliberate composer seat** path — the same one a sidebar row click uses. On a full grid it has no free slot, so it falls through to its displacement ladder (lines 3489-3526): `target` becomes the focused pane, or the first open non-kanban pane, and then, at line 3556:

```js
paneAssignments[target] = terminalName;   // the previous occupant is simply overwritten
```

The outgoing terminal's name is read one line earlier (`const displacedName = paneAssignments[target];`, line 3553) but only to dismiss its startup curtain — it is never recorded for restoration. `dismissPeek` (line 4012) then does only:

```js
function dismissPeek() {
    if (!peekTerminalName) { return; }
    peekTerminalName = null;
    applyPeekClasses();
    afterPeekTransition();
}
```

It drops the CSS state and re-renders. There is no snapshot, so the displacement is permanent, and `saveLayoutSettings` (called at line 3573, at the end of `assignToFocusedPane`) has by then persisted it. With `focusedPaneIndex` commonly 0, the peeked agent lands in slot 1 — exactly the reported symptom.

### Why the seat can't simply be skipped

`applyPeekClasses` enforces the inverse invariant on purpose (lines 3980-3990): if a peek is active but the peeked terminal is not seated in a rendered pane, it clears the peek. So "peek without seating" would immediately self-cancel. The correct fix is to keep the seat but make it reversible.

### Verified at HEAD — three mutations the seat performs that a naive snapshot would miss

Re-read of the live code turned up three writers the original analysis did not name. All three are load-bearing for a *correct* restore:

1. **Group membership.** Under a lock, `peekTerminal` routes through `handleLockedTerminalClick` (line 2658), whose free-slot branch calls `addTerminalToActiveGroup(name)` (line 2643) **before** seating. That pushes the name into `group.members` / `group.order` for a manual group, or into `groupPrefs.extras[activeGroupId]` for a derived one, and calls `saveLayoutSettings()`. Restoring `paneAssignments` alone leaves the peeked terminal a permanent member of the group — and worse, the next `seatActiveGroupPage()` (line 2440, an involuntary writer) will reseat it from that membership, silently re-applying the displacement the restore just undid.
2. **The caret.** `locateTerminal` calls `focusPaneTerminal(index)` after seating (lines 3428-3430). So peeking an *unseated* terminal takes the caret, while peeking a seated one does not — and `peekTerminal`'s own comment (line 4049) states the opposite is intended ("Deliberately NOT focusPaneTerminal(index)"). Two consequences: the Escape dismiss at line 1115 stands down whenever the caret is inside the peeked pane, so Escape is dead on precisely the path this plan fixes; and after a restore the caret sits in a pane that now hosts a *different* terminal, so the next keystroke goes to the wrong agent.
3. **Persistence writers.** `saveLayoutSettings` (line 1501) writes `terminals.paneAssignments`, `terminals.pinnedPanes`, `terminals.paneModes`, `terminals.groups`, `terminals.activeGroupId` and `terminals.groupPrefs`. The peek seat therefore persists both the displacement *and* the group enrolment before any restore can run.

There is already a precedent in this file for a name-carrying snapshot: `undoSnapshot` (restored by `undoLastAssignment`, line 3579). It is invalidated in `sanitizePaneAssignments` when any name it would restore is no longer live (lines 1872-1880) and re-keyed by the rename handler (line ~6600). The peek snapshot is the same kind of object and must carry the same two disciplines.

## Metadata

- **Complexity:** 6
- **Tags:** frontend, ui, bugfix
- **Project:** Browser Switchboard

## User Review Required

None. Every open question was decided in this pass: the snapshot rolls back group membership as well as seating; the peek seat no longer takes the caret; the snapshot is invalidated (never applied) on layout change, on terminal death, and on any involuntary reseat.

## Complexity Audit

### Routine

- Capturing `paneAssignments` / `pinnedPanes` / `paneModes` / `focusedPaneIndex` / `activeGroupId` / `activeGroupPage` into a snapshot object.
- Restoring them in `dismissPeek`.
- Nulling the snapshot on the involuntary clear paths.

### Complex / Risky

- **Call ordering is already load-bearing and documented.** `peekTerminal`'s comment (lines 4031-4037) warns that `assignToFocusedPane` itself calls `dismissPeek()` (line 3442, "Rule 1: a deliberate composer seat is a selection, and selecting any terminal other than the peeked one ends the peek"), and that `peekTerminalName = name` must stay **below** the seating block or the inner dismiss cancels the new peek mid-flight. Adding a restore to `dismissPeek` puts a second consumer on that same ordering: the snapshot must be taken **after** the inner dismiss has restored any previous peek, and **before** the new seating mutates the arrays. `terminal-sidebar-groupings-contract.test.js:377-381` asserts that `dismissPeek()` stays above the unlock block in `assignToFocusedPane` and is not gated on `keepLock` — do not reorder it.
- **`dismissPeek` has six callers** — the sidebar row's `restore` button (line 2182), the pane header's `Restore` button (line 4351), the pane `Pop out` button (line 4362), Escape (line 1119), the inbound `peekTerminal` message toggle (line 1021), the group-switch cancel (line 2406), plus the two internal seat-path calls at `assignToFocusedPane` (line 3442) and `handleLockedTerminalClick` (line 2669). Only *some* of these should restore. A deliberate re-composition while peeking (clicking another sidebar row) must NOT be undone by the restore, or the user's new click gets reverted. `assignToFocusedPane`'s dismiss must therefore restore-then-seat, in that order, so the user's intent lands on top of the restored grid — which is already the physical order, since the `dismissPeek()` call is the first statement in the function and `existingIndex` is computed after it.
- **Group membership is a second, persisted mutation.** See "Verified at HEAD" above. Rolling back seating without rolling back membership produces a restore that a later `seatActiveGroupPage` silently reverses. The snapshot must carry the active group's membership array.
- **The involuntary clear inside `applyPeekClasses`** (lines 3980-3990) nulls `peekTerminalName` directly and explicitly does NOT call `afterPeekTransition`. That path must discard the snapshot rather than restore from it: the peeked terminal is gone (exited, or moved by an involuntary layout change), so its pre-peek arrays may reference terminals that no longer exist.
- **Layout changes during a peek.** If the user changes layout while peeking, restoring an old `paneAssignments` sized for the old slot count would resurrect assignments in slots that no longer render. The snapshot must record the layout it was taken under and be discarded (not applied) if the layout changed.
- **Involuntary reseats during a peek.** `sanitizePaneAssignments` runs on the 5s fleet poll and nulls dead names, resizes both arrays to `getMaxSlotCount()`, and expires pins on emptied slots. `seatActiveGroupPage` rebinds `paneAssignments` wholesale. Either can run mid-peek. If the peeked terminal survives the reseat, `applyPeekClasses` will not clear the peek — so a stale snapshot would be applied over a grid it no longer describes. The snapshot needs the same liveness invalidation `undoSnapshot` already gets in `sanitizePaneAssignments`.
- **Renames.** The rename handler (line ~6585-6615) re-keys `paneAssignments`, manual-group `members`/`order`, `activeTerminalName`, `peekTerminalName`, `undoSnapshot.slots`, `terminalBadges` and `terminalReplayGaps`. A snapshot holding names must be re-keyed in the same block, or a restore after a rename seats a name with no session — the exact failure the `undoSnapshot` re-key comment already documents.
- **Persistence.** `saveLayoutSettings` writes the transient displacement to settings. A reload mid-peek would otherwise make it permanent. Suppress the save on the peek seat, or save the snapshot rather than the transient state.

## Edge-Case & Dependency Audit

### Race Conditions

1. **Involuntary reseat mid-peek.** The 5s poll (`sanitizePaneAssignments`) or a window resize (`applyLayoutFloor` → `seatActiveGroupPage`) can rewrite `paneAssignments` while a peek is live. Invalidate the snapshot when any name it would restore is no longer live, mirroring the `undoSnapshot` block at lines 1872-1880. When the peeked terminal itself is evicted, `applyPeekClasses` Rule 2 clears the peek — discard there too.
2. **`renderSidebarList` is called from many paths** — the fleet poll, `terminalsChanged`, `afterPeekTransition`, group switches. `dismissPeek` now performs writes before its `afterPeekTransition()`, so the restore must complete synchronously before any render reads the arrays. It does: all mutations are plain assignments.
3. **Peeking a second terminal while a peek is active.** Restore the first, then snapshot, then seat the second. Sequential `peek A → peek B → restore` must end at the original grid, not at "A seated".

### Security

- None. No new transport, no new input surface, no privileged call. All state is webview-local and already persisted through the existing `saveSetting` path.

### Side Effects

4. **Peeking an already-seated terminal.** No displacement happens (the `paneAssignments.indexOf(name) === -1` guard is false), so no snapshot is taken and `restore` must be a no-op on assignments.
5. **Peeked terminal exits during the peek.** `applyPeekClasses`'s Rule 2 clears the peek and the `sanitizePaneAssignments` check at line 1885 also clears it. Both must discard the snapshot. The grid keeps whatever state it has — do not resurrect an exited terminal's displaced neighbour into a pane it may since have been reassigned to.
6. **Peek under a group lock.** `handleLockedTerminalClick` (line 2658) is the seat path when `activeGroupId` is set. Its free-slot branch calls `addTerminalToActiveGroup` then `assignToFocusedPane(name, { keepLock: true })`; its no-group branch drops the lock outright; its remaining branch falls through to `switchToGroup`. The snapshot must include `activeGroupId`, `activeGroupPage`, **and** the active group's membership list, so restore returns the lock *and* un-enrols the peeked terminal.
7. **Kanban-mode panes.** `paneModes[i] === 'kanban'` panes are occupied-but-unassigned. The displacement ladder prefers displacing terminal panes over kanban panes (lines 3511-3515); restore must put a displaced kanban pane's mode back, so snapshot `paneModes` as well.
8. **Pinned panes.** The ladder's `isOpen` excludes pinned panes when `rendered > 1` (line 3490), and `assignToFocusedPane` clears `pinnedPanes[existingIndex]` when vacating a non-rendered slot (lines 3533-3546). Snapshot `pinnedPanes` too.
9. **Solo popout.** `peekTerminal` early-returns when `soloTerminalName` is set (line 4020), and `saveSetting` is suppressed in solo. No snapshot work needed on that path.
10. **All panes pinned.** `assignToFocusedPane` toasts and returns without seating (lines 3521-3526); `peekTerminal`'s `index === -1` guard then returns. The snapshot must be discarded, not left dangling for the next `dismissPeek` to apply.
11. **The startup curtain of the displaced terminal.** `assignToFocusedPane` calls `dismissStartupCurtain(displacedName)` (line 3554) when it displaces. A restore puts that terminal back in its pane but cannot un-dismiss its curtain. This is accepted: the curtain is a boot presentation, not layout state, and re-arming it would repaint a curtain over a prompt that has since settled — the exact defect the dismissal exists to prevent.
12. **The caret.** Superseded below (item 13 of the original audit). The peek seat must not call `focusPaneTerminal`.

> **Superseded:** "Escape while the caret is inside the peeked pane is deliberately ignored (line 1086). Unchanged."
> **Reason:** Verified at HEAD, the caret is *always* inside the peeked pane on the unseated-peek path, because `locateTerminal` (line 3425) calls `focusPaneTerminal(index)` after seating. So the Escape exit is not a rare deliberate stand-down — it is dead for the entire class of peeks this plan repairs. Worse, after a restore the caret sits in a pane that now hosts a different terminal, so the next keystroke reaches the wrong agent. `peekTerminal`'s own comment at line 4049 already states the caret must not move on a peek; the unseated path contradicts it.
> **Replaced with:** The peek seat must not take the caret. Route the unseated peek through `assignToFocusedPane(name)` directly (not `locateTerminal`) so `focusPaneTerminal` is never called, or give `locateTerminal` an opts flag the peek path sets. The Escape guard at line 1115 then stands down only when the user has deliberately clicked into the peeked pane, which is what it was written for.

13. **No confirm dialogs**, and no "restore discarded your changes" toast — this is a mechanical restore, not a decision (repo rule; and no status UI for non-decisions).

### Dependencies & Conflicts

- **Same file as all three sibling subtasks** (`src/webview/terminals.js`). No overlapping function spans: this plan touches `peekTerminal`, `dismissPeek`, `applyPeekClasses`, `sanitizePaneAssignments`, `assignToFocusedPane`/`handleLockedTerminalClick` (snapshot capture only) and the rename block. Serialise the edit stream with the siblings; no logical dependency in either direction.
- **`src/test/shell-terminal-strip.test.js`** reads three spans this plan edits and must stay green:
  - line 225-227: `block(terminalsJs, 'function peekTerminal(name) {', 'function wireTerminalDropTarget')` must still contain the badge clear — keep the badge block at the top of `peekTerminal`.
  - line 281: asserts the literal regex `/if \(peekTerminalName && !liveNames\.has\(peekTerminalName\)\)/` in `sanitizePaneAssignments` — add the snapshot discard *inside* that block, do not restructure the condition.
  - line 286: asserts the exact literal `if (peekTerminalName === name) { peekTerminalName = next; }` in the rename block — add the snapshot re-key on a new line, do not fold it into that statement.
- **`src/test/terminal-sidebar-groupings-contract.test.js:377-381`** asserts `dismissPeek()` precedes `if (activeGroupId` in `assignToFocusedPane` and is ungated. Preserved.

## Dependencies

- None. This subtask has no prerequisite inside or outside the feature.

## Adversarial Synthesis

Key risks: a snapshot that restores seating but not group membership is silently reversed by the next `seatActiveGroupPage`; a stale snapshot applied after an involuntary reseat or a rename resurrects dead terminals into panes; and the peek seat currently steals the caret, so a restore hands the next keystroke to a different agent and Escape never fires. Mitigations: snapshot the active group's membership alongside the pane arrays and roll both back together; mirror `undoSnapshot`'s existing liveness invalidation in `sanitizePaneAssignments` and its rename re-key; discard (never apply) the snapshot on layout change and on every involuntary peek clear; and stop the peek seat calling `focusPaneTerminal`.

## Proposed Changes

### `src/webview/terminals.js`

**a) Add the snapshot state** beside `peekTerminalName` (line 135):

```js
let peekTerminalName = null;
// Pre-peek grid state, captured ONLY when a peek had to displace a seated
// terminal to show an unseated one. dismissPeek restores it; every involuntary
// peek-clear DISCARDS it (the peeked terminal is gone, so its neighbours'
// pre-peek seats may no longer be valid). Records the layout it was taken
// under: restoring an assignment array sized for a different slot count would
// resurrect seats in panes that no longer render. Carries group membership
// too — handleLockedTerminalClick enrols the peeked terminal in the active
// group BEFORE seating, and a membership left behind is re-applied by the next
// seatActiveGroupPage, silently undoing the restore.
let peekRestoreState = null;
```

**b) Capture in `peekTerminal`** (line 4019), respecting the existing ordering contract:

```js
function peekTerminal(name) {
    if (soloTerminalName || !name) { return; }
    if (terminalBadges.has(name)) { /* unchanged badge clear — shell-terminal-strip.test.js scans this span */ }

    if (paneAssignments.indexOf(name) === -1) {
        // Restore any PREVIOUS peek first, explicitly, so the snapshot below is
        // taken against the user's real grid rather than a peek-displaced one.
        // (assignToFocusedPane and handleLockedTerminalClick also call dismissPeek
        // internally — those early-return once we have already cleared it here.)
        dismissPeek();
        // Snapshot AFTER the restore and BEFORE the seat. This ordering is the
        // whole fix: seating goes through assignToFocusedPane's displacement
        // ladder, which overwrites paneAssignments[target] with no record of the
        // outgoing terminal.
        peekRestoreState = captureGridState();
        if (activeGroupId) {
            handleLockedTerminalClick(name);
        } else {
            // NOT locateTerminal: that calls focusPaneTerminal after seating, which
            // takes the caret. A peek is a glance (see the comment at the foot of
            // this function), and a caret parked in the peeked pane also disables
            // the Escape exit and, after a restore, types into whichever terminal
            // ends up in that pane.
            assignToFocusedPane(name);
        }
    }

    const index = paneAssignments.indexOf(name);
    if (index === -1) {
        // Seat refused (every pane pinned). Drop the snapshot rather than leave it
        // for the next dismissPeek to apply to a grid it no longer describes.
        peekRestoreState = null;
        return;
    }
    peekTerminalName = name;
    applyPeekClasses();
    afterPeekTransition();
}
```

> **Superseded:** `if (activeGroupId) { handleLockedTerminalClick(name); } else { locateTerminal(name); }`
> **Reason:** `locateTerminal` (line 3425) is `assignToFocusedPane` plus `focusPaneTerminal`. The caret move is the half a peek must not do — it is contradicted by `peekTerminal`'s own closing comment, it disables the Escape dismiss (line 1115 stands down when the caret is inside the peeked pane), and after a restore it leaves the caret in a pane hosting a different terminal.
> **Replaced with:** Call `assignToFocusedPane(name)` directly on the unlocked branch. Behaviour is otherwise identical — `locateTerminal` adds nothing else.

**c) The capture/restore helpers**, placed next to `dismissPeek`:

```js
/** Everything a peek's displacing seat can mutate, in one object. */
function captureGridState() {
    const group = activeGroupId ? getAllGroups().find(g => g.id === activeGroupId) : null;
    return {
        layout: effectiveLayout,
        assignments: paneAssignments.slice(),
        pins: pinnedPanes.slice(),
        modes: paneModes.slice(),
        focused: focusedPaneIndex,
        groupId: activeGroupId,
        groupPage: activeGroupPage,
        // addTerminalToActiveGroup writes to ONE of these two, depending on the
        // group's source. Snapshot whichever applies so the peeked terminal is
        // un-enrolled on restore; without this the next seatActiveGroupPage
        // reseats it from membership and reverses the whole restore.
        groupMembers: group && group.source === 'manual' && Array.isArray(group.members)
            ? group.members.slice() : null,
        groupOrder: group && group.source === 'manual' && Array.isArray(group.order)
            ? group.order.slice() : null,
        groupExtras: group && group.source !== 'manual' && groupPrefs.extras
            && Array.isArray(groupPrefs.extras[activeGroupId])
            ? groupPrefs.extras[activeGroupId].slice() : null
    };
}

/** True when every terminal the snapshot would seat is still live. */
function peekSnapshotIsApplicable(snap) {
    if (!snap) { return false; }
    // Only restore a snapshot taken under the CURRENT layout. A layout change
    // mid-peek resizes the grid; replaying an array sized for the old slot count
    // would seat terminals into panes that no longer render.
    if (snap.layout !== effectiveLayout) { return false; }
    const liveNames = new Set(fleetList.map(t => t.friendlyName));
    return snap.assignments.filter(Boolean).every(n => liveNames.has(n));
}
```

**d) Restore in `dismissPeek`** (line 4012):

```js
function dismissPeek() {
    if (!peekTerminalName) { peekRestoreState = null; return; }
    peekTerminalName = null;
    const snap = peekRestoreState;
    peekRestoreState = null;
    if (peekSnapshotIsApplicable(snap)) {
        paneAssignments = snap.assignments.slice();
        pinnedPanes = snap.pins.slice();
        paneModes = snap.modes.slice();
        focusedPaneIndex = snap.focused;
        activeGroupId = snap.groupId;
        activeGroupPage = snap.groupPage;
        const group = snap.groupId ? getAllGroups().find(g => g.id === snap.groupId) : null;
        if (group && snap.groupMembers) { group.members = snap.groupMembers.slice(); }
        if (group && snap.groupOrder) { group.order = snap.groupOrder.slice(); }
        if (snap.groupExtras && groupPrefs.extras) {
            groupPrefs.extras[snap.groupId] = snap.groupExtras.slice();
        }
        saveLayoutSettings();
    }
    applyPeekClasses();
    afterPeekTransition();
}
```

> **Superseded:** "If `paneAssignments` / `pinnedPanes` / `paneModes` are declared `const`, assign element-wise (`arr.length = 0; arr.push(...)`) rather than rebinding — other closures hold the same reference."
> **Reason:** Verified at HEAD: all three are module-scoped `let` (lines 12, 19, 26) inside the panel IIFE, and rebinding is the existing idiom — `seatActiveGroupPage` does `paneAssignments = assignments` (line 2456) and `undoLastAssignment` does `paneAssignments = undoSnapshot.slots` (line 3582). Every reader resolves the binding, not a captured array. The hedge described a hazard that does not exist.
> **Replaced with:** Rebind directly, as `undoLastAssignment` does.

**e) Discard on the involuntary clear** inside `applyPeekClasses` (lines 3986-3989):

```js
if (!seated) {
    peekTerminalName = null;
    peekRestoreState = null;   // the peeked terminal is gone; its neighbours' pre-peek seats may not be valid
    isPeeking = false;
}
```

and inside the exit guard in `sanitizePaneAssignments` (line 1885) — note this lives in `sanitizePaneAssignments`, not `renderSidebarList`, and `shell-terminal-strip.test.js:281` matches its condition literally, so add only the body line:

```js
if (peekTerminalName && !liveNames.has(peekTerminalName)) {
    peekTerminalName = null;
    peekRestoreState = null;
}
```

**f) Invalidate the snapshot on liveness**, immediately after the existing `undoSnapshot` invalidation block in `sanitizePaneAssignments` (lines 1872-1880), and for the same reason spelled out there:

```js
// Same discipline as undoSnapshot above: a snapshot that would seat a name with
// no session opens a WebSocket to a terminal that no longer exists. closeTerminal()
// nulls its own slots BEFORE this refresh lands, so the drop loop above never sees
// the dead name — check the snapshot's own names.
if (peekRestoreState && !peekSnapshotIsApplicable(peekRestoreState)) {
    peekRestoreState = null;
}
```

**g) Re-key the snapshot on rename**, in the same block that re-keys `undoSnapshot` (line ~6600). Add a separate statement — `shell-terminal-strip.test.js:286` asserts the `peekTerminalName` re-key line verbatim, so do not fold this into it:

```js
if (peekTerminalName === name) { peekTerminalName = next; }
if (peekRestoreState) {
    peekRestoreState.assignments = peekRestoreState.assignments.map(n => (n === name ? next : n));
    for (const key of ['groupMembers', 'groupOrder', 'groupExtras']) {
        const arr = peekRestoreState[key];
        if (Array.isArray(arr)) { peekRestoreState[key] = arr.map(n => (n === name ? next : n)); }
    }
}
```

**h) Suppress persistence of the transient displacement.** `assignToFocusedPane` ends by calling `saveLayoutSettings` (line 3573). Pass a `transient: true` option from the peek seat that skips that call, so a reload mid-peek comes back to the user's real grid rather than the peek's. `handleLockedTerminalClick`'s `addTerminalToActiveGroup` also saves (line 2656) — accept that write; `dismissPeek`'s restoring `saveLayoutSettings()` corrects it, and a reload mid-peek under a lock lands on the pre-peek membership because the restore is what persists last.

## Verification Plan

### Automated Tests

Execution is **deferred by session directive (SKIP TESTS)** — do not run the suites in this dispatch. The following existing contract tests read spans this change edits and must be left structurally intact so they pass when the suite is next run. No new test files are required by this plan.

- `src/test/shell-terminal-strip.test.js:225` — the badge-clear block must remain inside the `peekTerminal` … `wireTerminalDropTarget` span.
- `src/test/shell-terminal-strip.test.js:281` — the `if (peekTerminalName && !liveNames.has(peekTerminalName))` condition must survive verbatim in `sanitizePaneAssignments`.
- `src/test/shell-terminal-strip.test.js:286` — the `if (peekTerminalName === name) { peekTerminalName = next; }` statement must survive verbatim in the rename block.
- `src/test/terminal-sidebar-groupings-contract.test.js:377` — `dismissPeek()` must stay above the `if (activeGroupId` unlock block in `assignToFocusedPane`, ungated.

### Static checks

1. `grep -n "peekRestoreState" src/webview/terminals.js` shows exactly the sites in this plan: the declaration, the capture in `peekTerminal`, the two null-outs in `peekTerminal`, the read/clear in `dismissPeek`, the discard in `applyPeekClasses`, the discard in the `sanitizePaneAssignments` exit guard, the liveness invalidation, and the rename re-key.
2. `grep -n "locateTerminal" src/webview/terminals.js` no longer shows a call inside `peekTerminal`.
3. `grep -n "saveLayoutSettings" src/webview/terminals.js` — confirm `assignToFocusedPane`'s call is now conditional on the transient flag.

### Manual UAT

*(The browser panel is served from the installed VSIX's `dist/`, not `src/` — rebuild and reinstall the VSIX before concluding a fix did not land.)*

4. **The reported repro.** Fill a 2x2 grid with four agents; note which is in slot 1. Peek a fifth from the sidebar; press `restore`. All four originals are back in their original slots and the fifth is not on the grid.
5. **Escape path.** Repeat, dismissing with Escape instead of `restore`. Escape now works without clicking away first (the peek no longer takes the caret), and the grid restores identically.
6. **Already-seated peek.** Peek a terminal that is already in a pane, then restore. Nothing moves and focus does not jump.
7. **Chained peeks.** `peek E` → `peek F` → `restore`. The grid is the original four; neither E nor F is seated.
8. **Deliberate recomposition wins.** While peeking E, click another sidebar row (F). The grid shows the restored four with F seated in the focused pane, and E unseated — the click is not reverted.
9. **Group lock.** Activate a group tab, peek a non-member, restore. The lock and its page are back, the grid is the group's original page, and the peeked terminal is **not** listed as a group member (check the group's tab count and re-open the tab — it must not reappear after the next 5s poll).
10. **Pins and kanban modes.** Pin slot 2 and set slot 3 to kanban mode; peek an unseated terminal; restore. The pin and the kanban column are both back.
11. **Layout change mid-peek.** Peek in 2x2, switch to the `1` layout, then restore. Nothing is seated into a slot beyond the rendered count and the panel does not throw (check the browser console).
12. **Peeked terminal exits mid-peek.** Peek a terminal, close it from its own shell. The peek clears, the grid keeps its current state, and a subsequent `restore` click does nothing.
13. **All panes pinned.** Pin every pane in a 2x2, then peek an unseated terminal. Nothing is seated, nothing moves, and a later dismiss does not rewrite assignments.
14. **Reload mid-peek.** Peek a fifth terminal and reload the page without dismissing. The grid comes back as the pre-peek four.

---

**Recommendation:** Complexity 6 — **Send to Coder.**

# Pin Terminals to Panes — Protect a Slot From Sidebar Reassignment

## Goal

Let the operator **pin a terminal to a pane slot** in the Terminals cockpit, so that pinned pane keeps showing the same agent no matter what else is clicked. In a 2-slot layout (`2h`/`2v`), pinning the left pane means every subsequent sidebar click routes the newly selected agent into the *unpinned* pane — the pinned agent is never displaced, never moved, never swapped out.

### Problem analysis

The cockpit's seating rule today is "the focused pane is the target pane". `assignToFocusedPane()` in `src/webview/terminals.js:1049` computes:

```js
let target = focusedPaneIndex;
if (paneAssignments[target]) {
    let free = -1;
    for (let i = 0; i < rendered; i++) { if (!paneAssignments[i]) { free = i; break; } }
    if (free !== -1) { target = free; }
    else if (existingIndex !== -1 && existingIndex < rendered) { /* follow the terminal */ }
}
...
paneAssignments[target] = terminalName;
focusedPaneIndex = target;
```

Every sidebar row click and every `locate` button routes through `locateTerminal()` (`src/webview/terminals.js:1041`) → `assignToFocusedPane()`, and `setFocusedPane()` (`src/webview/terminals.js:1149`) moves `focusedPaneIndex` onto whichever pane the user last **mouse-downed into**.

### Root cause

The two behaviours combine into the exact defect the user hit:

1. Operator runs `2h`. Pane 0 = the agent they want to keep watching. Pane 1 = scratch.
2. Operator clicks *into* pane 0 to type a message to that agent → `setFocusedPane(0)` sets `focusedPaneIndex = 0`.
3. Operator clicks a different agent in the sidebar → `assignToFocusedPane()` targets pane 0. Pane 1 is occupied so `free === -1`, and the newly-clicked terminal is not yet seated so `existingIndex === -1` — the "follow the terminal" escape hatch does not fire. **Pane 0 is overwritten.** The agent they were watching is evicted into the sidebar.

There is no per-slot notion of "this seat is reserved". `paneAssignments` is a flat `[name|null]` array (`src/webview/terminals.js:12`) with no companion state, so the only thing steering placement is transient caret focus — which is precisely the thing the operator changes every time they type into a pane. Focus is the wrong signal for durable seating; the fix is an explicit, persisted, per-slot pin that placement consults *before* focus.

Secondary consequence of the same gap: `createTerminal()` (`src/webview/terminals.js:1473`) also lands new terminals via `assignToFocusedPane`, and the board's inbound `focusTerminal` message (`src/webview/terminals.js:394`) does too — so spawning an agent or clicking a kanban card can evict the watched pane as well.

## Metadata

- **Complexity:** 6
- **Tags:** frontend, ui, ux, feature

> **Superseded:** **Complexity:** 5
> **Reason:** The improve pass added three code sites the original scope missed (the single-slot pin-inert rule, the self-healing empty-slot pin clear that covers `closeTerminal`'s direct slot nulling, and CI registration of the new contract test) and identified one behaviour change to pre-existing unpinned placement. Five files now change (`terminals.js`, `terminals.html`, a new test, `package.json`, `.github/workflows/integration-tests.yml`), and the feature introduces a persisted state invariant ("a pin never sits on an empty slot") that three separate mutation paths must not break. That is a 6, not a 5.
> **Replaced with:** **Complexity:** 6 → route to **Coder**.

## User Review Required

- **Pin glyph vs text label.** This plan replaces the original 📌/📍 emoji toggle with a `pin`/`unpin` text button to match the `clear`/`hide` treatment the pane header deliberately adopted (see the correction in §5). If you want the emoji button anyway, say so — the rest of the plan is unaffected.
- **Behaviour change to unpinned placement.** Making the "follow an already-seated terminal" branch unconditional changes what happens today for users with *no* pins set: clicking a seated terminal while a free pane exists currently *relocates* it into the free pane; after this change it just moves focus to where it already is. This is the right behaviour, but it is a change beyond the pin feature. See §3.
- **Pins are inert in a single-pane layout.** Confirm you want this. Without it, a pin set in `2h` deadlocks the sidebar when the layout is `1` — including when the window shrinks and the pane-size floor drops you to `1` involuntarily.

## Complexity Audit

### Routine

- Adding a `pinnedPanes` boolean array beside `paneAssignments`, persisted through the same `saveSetting`/`loadSetting` pair (`src/webview/terminals.js:499`/`482`). The `saveSetting` verb schema (`src/services/verbSchemas.ts:398`) only requires a `string` key — no backend change is needed. **Verified.**
- Rendering a pin toggle in `pane-actions`, styled with the existing `.btn-unassign-pane` treatment (`src/webview/terminals.html:584`). **Verified — `.btn-unassign-pane` is defined at `terminals.html:584`.**
- A pinned marker on the sidebar chip / pane title.
- Registering the new contract test in `package.json` and in `.github/workflows/integration-tests.yml` (the three sibling terminal-webview contract tests all run in CI at lines 263 / 274 / 283).

### Complex / Risky

- **Placement rewrite in `assignToFocusedPane`.** This function has three pre-existing escape hatches (already-in-focused-pane early return, first-free-slot fallback, follow-the-terminal-when-full) each documented as fixing a prior defect. Pin filtering must be layered on top without re-opening any of them — in particular the "one click clearing two panes for zero gain" case at `src/webview/terminals.js:1066`.
- **Full-pin deadlock.** If every rendered slot is pinned, a sidebar click has nowhere to go. Silently doing nothing is an invisible failure; silently displacing defeats the feature. It needs an explicit toast.
- **Single-slot deadlock — the sharp edge of the above.** `LAYOUTS['1']` has `minW: 0, minH: 0`, so `1` is both a user-selectable layout and the terminal rung of `LAYOUT_FLOOR_ORDER` — `resolveFlooredLayout()` (`src/webview/terminals.js:1299`) can drop *any* layout to `1` on a narrow window. A pin set in `2h` then persists into a one-pane grid where "every rendered slot is pinned" is true by construction, and the entire sidebar goes inert behind a toast. Pins must be **inert whenever `rendered <= 1`**.
- **Pin lifetime vs. terminal lifetime.** `sanitizePaneAssignments()` (`src/webview/terminals.js:643`) nulls slots whose terminal died while the page was closed. A pin left on a now-empty slot would permanently reserve a seat nothing can occupy — a soft-lock that survives reloads because it is persisted. Note that `closeTerminal()` (`src/webview/terminals.js:1696`) nulls its own slots *before* the refresh lands, so the dead name never reaches sanitize's drop loop — the pin clear cannot be coupled to that loop.
- **Undo coherence.** `undoSnapshot` (`src/webview/terminals.js:606`) restores a whole `slots` arrangement. If pins change during a mutation and undo does not restore them, the undo lands the layout in a state the user never had.
- **Index alignment.** Pins are per-slot-index, not per-terminal-name. This is deliberate and it is what makes `renameTerminal()` (`src/webview/terminals.js:1626`) need no pin fixup — but it also means every place that mutates `paneAssignments` by index must be audited for a matching pin mutation. The audited set is: `assignToFocusedPane` (1085/1088), the `hide` handler (1246), `sanitizePaneAssignments` (661), `fillEmptyPanes` (1614), `renameTerminal` (1641), `closeTerminal` (1697), `undoLastAssignment` (1113), and the solo bootstrap (303).

## Edge-Case & Dependency Audit

| Case | Required behaviour |
| :--- | :--- |
| Pinned pane is focused, user clicks a new agent in the sidebar | Agent lands in the first unpinned slot; pinned pane untouched; focus moves to the slot that received the agent. **This is the headline case.** |
| Every rendered slot is pinned (2+ rendered slots), user clicks a new agent | No mutation. Toast: `All panes are pinned — unpin one to switch.` Sidebar/grid unchanged. The operator can see the pinned buttons and unpin one. |
| Layout is `1` (chosen or floored) and that pane is pinned | **Pins are inert.** `rendered <= 1` disables pin filtering entirely, so the click seats normally. A one-pane grid has no other seat to protect the pinned one from, so a pin there can only deadlock. The pinned marker still renders on the pane chip so the state is visible; the toggle button is hidden. |
| Clicked agent is already seated in a rendered slot | Follow it — set `focusedPaneIndex` to that slot and hand it the caret. Never relocate a seated terminal to satisfy a click. Applies whether or not its slot is pinned. **This is a behaviour change for unpinned users — see the callout in §3.** |
| Clicked agent is already seated in a **pinned** slot | Same as above — follow it. Never unseat a pinned occupant even to "re-seat" itself. |
| All unpinned slots occupied, none free | Displace the first **unpinned** slot (existing displace + toast + undo path), never a pinned one. |
| Pinned terminal exits or is closed | The slot is nulled by whichever path noticed (`sanitizePaneAssignments` for a death-while-closed, `closeTerminal` for an explicit close), and the pin is cleared by the unconditional empty-slot rule in sanitize. A pin on an empty slot is meaningless and would reserve a seat forever. |
| `hide` clicked on a pinned pane | Clears the slot and its pin inline; undo restores both. |
| Layout shrinks (`3x3` → `2h`), or the size floor trips via `applyLayoutFloor` (`src/webview/terminals.js:1322`) | Pins on non-rendered indices persist but are inert. Placement only ever consults pins for `i < getSlotCount(effectiveLayout)`, and not at all when that count is 1. |
| `terminals.pinnedPanes` loaded shorter/longer than `getMaxSlotCount()` (= 9, from `3x3`) | Normalised in `sanitizePaneAssignments` alongside `paneAssignments` — pad with `false`, truncate to max. Until that runs, `pinnedPanes[i]` reads `undefined`, which is falsy and therefore fails open (unpinned) — never a spurious lock. |
| Corrupt persisted value (non-array) | `Array.isArray` guard in `loadLayoutSettings`, same shape as the existing `savedPanes` guard (`src/webview/terminals.js:520`). |
| `terminalsChanged` arrives before `loadLayoutSettings()` resolves | Harmless. `init()` gates the first fetch behind `Promise.all([loadLayoutSettings(), ...])` (`src/webview/terminals.js:434`), but an inbound broadcast can still call `fetchTerminalList()` first (line 381). At that point both arrays are `[]`, so the empty-slot rule clears nothing, and `loadLayoutSettings` then overwrites both wholesale. Same risk profile the existing `paneAssignments` already carries. |
| Rename of a pinned terminal | No pin fixup needed — pins are index-keyed. The contract test asserts no pin code is added to the rename block. |
| Solo pop-out mode (`?solo=`) | Covered by the `rendered <= 1` rule: `init()` forces `currentLayout`/`effectiveLayout` to `'1'` in solo (`src/webview/terminals.js:301-302`), so the pin UI is suppressed and pins are inert without a separate solo branch. `saveSetting` also already no-ops when `soloTerminalName` is set (`src/webview/terminals.js:500`). |
| `fillEmptyPanes()` (`src/webview/terminals.js:1604`) | Untouched. It fills `null` slots, and a pinned slot is never `null` because `sanitizePaneAssignments` runs immediately before it on every call path (`fetchTerminalList` → `sanitize`, then `openAllTerminals` → `fillEmptyPanes` at line 1594). |
| Board-driven `focusTerminal` message (`src/webview/terminals.js:394`) | Inherits pin-aware placement for free via `locateTerminal`. Desired: a kanban click must not evict the pinned pane either. |
| `createTerminal` seating (`src/webview/terminals.js:1473`) | Inherits pin-aware placement for free. A newly spawned agent lands in an unpinned slot. |

**Dependencies:** none beyond the existing `getSetting`/`saveSetting` verbs. No DB migration, no extension-host change, no new HTTP route. Webview JS/HTML are copied verbatim into `dist/webview/` by webpack (`webpack.config.js:78-92`), so `npm run compile` plus a panel reload is the whole build path.

## Dependencies

- None.

## Adversarial Synthesis

**Risk summary.** The feature's failure mode is not "the pin does not hold" — it is "the pin holds too well and strands the operator". Two concrete strandings exist: a pin surviving into a single-pane layout (reachable involuntarily via the pane-size floor, since `LAYOUTS['1']` has zero minimums), and a pin outliving its terminal on an empty persisted slot — which `closeTerminal`'s direct slot-nulling would cause, because it runs before the refresh and so bypasses sanitize's dead-name branch entirely. Mitigations: pins are inert whenever `rendered <= 1`; the pin clear is an unconditional "empty slot ⇒ no pin" rule in `sanitizePaneAssignments` rather than a clause bolted onto the dead-name loop, which makes the invariant self-healing from any drift including a torn two-key persistence write; and `undoSnapshot` carries `pins` at both of its construction sites so undo cannot land the layout in a state the operator never had.

## Proposed Changes

### 1. `src/webview/terminals.js` — pin state + persistence

Declare the array beside `paneAssignments` (near line 12):

```js
let paneAssignments = []; // [terminalName or null, ...] length based on currentLayout
// Per-SLOT pin flags, index-aligned with paneAssignments. Index-keyed, not name-keyed:
// that is what lets renameTerminal leave pins alone, and it matches the operator's
// mental model ("the left pane stays put"), which is about the seat, not the occupant.
// Invariant: pinnedPanes[i] is never true while paneAssignments[i] is null. A pin on an
// empty seat reserves a slot nothing can fill, and it is persisted, so the soft-lock
// survives reload. sanitizePaneAssignments enforces this on every list refresh.
let pinnedPanes = [];
```

Load and save it with the rest of the layout settings (`loadLayoutSettings` line 510, `saveLayoutSettings` line 532):

```js
const savedPins = await loadSetting('terminals.pinnedPanes', []);
...
if (Array.isArray(savedPins)) {
    pinnedPanes = savedPins.map(Boolean);
}
```

```js
saveSetting('terminals.pinnedPanes', pinnedPanes);
```

### 2. `src/webview/terminals.js` — normalise and expire pins in `sanitizePaneAssignments`

Extend the existing length normalisation (lines 647-652) and add an **unconditional** empty-slot rule after the stale-slot drop loop (lines 656-663):

```js
while (pinnedPanes.length < maxSlots) { pinnedPanes.push(false); }
if (pinnedPanes.length > maxSlots) { pinnedPanes.length = maxSlots; }

// ...existing stale-slot drop loop, unchanged...

// Pin expiry. Deliberately NOT folded into the drop loop above: closeTerminal()
// nulls its own slots BEFORE this refresh lands (the same reason the undo
// invalidation below cannot rely on the drop loop either), so a pin whose terminal
// was explicitly closed would never be reached by a dead-name check. Keying off the
// slot being empty instead of the occupant being dead covers every path — close,
// death-while-closed, hide, and a torn two-key persistence write where
// terminals.paneAssignments saved and terminals.pinnedPanes did not.
for (let i = 0; i < pinnedPanes.length; i++) {
    if (pinnedPanes[i] && !paneAssignments[i]) { pinnedPanes[i] = false; }
}
```

> **Superseded:** Clear the pin inside the stale-slot drop loop, in the same branch that nulls a dead `paneAssignments[i]`:
> ```js
> if (paneAssignments[i] && !liveNames.has(paneAssignments[i])) {
>     paneAssignments[i] = null;
>     pinnedPanes[i] = false;
> }
> ```
> **Reason:** That branch is unreachable for the most common way a pinned terminal disappears. `closeTerminal()` (`src/webview/terminals.js:1696-1698`) nulls its own slots and then awaits `fetchTerminalList()`, so by the time sanitize runs the slot is already `null` and the dead name is gone — the drop loop never fires and the pin survives on an empty, persisted slot. This is the exact soft-lock the plan set out to prevent, and manual verification step 11 would have failed. The file already documents this ordering hazard for the undo snapshot at lines 1665-1670; the same hazard applies here.
> **Replaced with:** An unconditional `empty slot ⇒ clear pin` pass after the drop loop. It subsumes the dead-name case, covers `closeTerminal` with no change to that function, and self-heals any drift from a torn persistence write.

Note the ordering consequence: `closeTerminal` calls `saveLayoutSettings()` *before* `fetchTerminalList()`, so persistence briefly holds a pin on an empty slot. The load path runs sanitize before the first render, so the stale flag is cleared on the way in and never reaches placement. No extra write is needed.

### 3. `src/webview/terminals.js` — pin-aware placement in `assignToFocusedPane`

Replace the target-selection block (lines 1049-1090). Pin filtering runs **before** focus is consulted:

```js
function assignToFocusedPane(terminalName) {
    const rendered = getSlotCount(effectiveLayout);
    if (focusedPaneIndex < 0 || focusedPaneIndex >= rendered) { focusedPaneIndex = 0; }

    const existingIndex = paneAssignments.indexOf(terminalName);
    if (existingIndex === focusedPaneIndex) { return; }

    // Already on screen? Follow it. Relocating a seated terminal to satisfy a click
    // empties one pane to fill another for zero gain — and if its seat is pinned,
    // relocating would break the pin outright.
    if (existingIndex !== -1 && existingIndex < rendered) {
        focusedPaneIndex = existingIndex;
        activeTerminalName = terminalName;
        terminalBadges.delete(terminalName);
        renderSidebarList();
        renderPaneGrid();
        postFleetStateToShell();
        return;
    }

    // Pins beat focus. This is the whole feature: the focused pane is where the caret
    // happens to be (it moves every time the operator types into a pane), which is far
    // too volatile to decide durable seating.
    //
    // ...except in a one-pane grid, where there is no other seat to protect the pinned
    // one FROM. LAYOUTS['1'] has zero minimums and is the last rung of
    // LAYOUT_FLOOR_ORDER, so a narrow window can drop a pinned 2h layout to a single
    // pane involuntarily — and honouring the pin there turns every sidebar click into
    // a dead click behind a toast. Inert, not enforced.
    const pinsActive = rendered > 1;
    const isOpen = (i) => i < rendered && (!pinsActive || !pinnedPanes[i]);

    let target = -1;
    if (isOpen(focusedPaneIndex)) {
        target = focusedPaneIndex;
    }
    if (target === -1 || paneAssignments[target]) {
        for (let i = 0; i < rendered; i++) {
            if (isOpen(i) && !paneAssignments[i]) { target = i; break; }
        }
    }
    if (target === -1) {
        for (let i = 0; i < rendered; i++) {
            if (isOpen(i)) { target = i; break; }
        }
    }
    if (target === -1) {
        // Every rendered pane is pinned. Displacing one would defeat the pin; doing
        // nothing silently reads as a dead click. Say so.
        showPaneToast('All panes are pinned — unpin one to switch.', null);
        return;
    }

    const displaced = paneAssignments[target] || null;
    undoSnapshot = {
        slots: paneAssignments.slice(),
        pins: pinnedPanes.slice(),
        name: terminalName,
        displaced,
        paneIndex: target
    };
    // ...unchanged from here: seat, focus, badge-clear, toast, save, render
}
```

**Trace of the four target cases**, since the fallthrough is not obvious:

| Focused pane | Free unpinned slot exists? | Target |
| :--- | :--- | :--- |
| Unpinned, empty | — | Focused pane (first block sets it, second block skips because it is empty) |
| Unpinned, occupied | Yes | The free unpinned slot |
| Unpinned, occupied | No | Focused pane — the second block finds nothing so `target` retains the focused index, and the third block is skipped because `target !== -1`. Displaces the focused pane, which is the pre-existing behaviour. |
| Pinned | Yes / No | First free unpinned slot, else first unpinned slot (displaced), else the all-pinned toast |

> **Superseded:** The Edge-Case table row "Clicked agent is already seated in a rendered slot → Follow it (**existing behaviour**)".
> **Reason:** Hoisting the follow-branch out of the `paneAssignments[target]` conditional is a behaviour change, not a preservation. Today (line 1066) the follow only fires when *every* rendered pane is occupied. With a free pane available, current code takes `target = free`, nulls `existingIndex`, and **relocates** the seated terminal into the free pane — e.g. in `2x2` with A in pane 0 (focused) and B in pane 1, clicking B today moves B to pane 2 and empties pane 1. Calling that "existing behaviour" hides a real diff from the reviewer and from anyone bisecting a regression later.
> **Replaced with:** Follow it — a **deliberate change** to unpinned placement, adopted because the relocation is precisely the "one click clearing two panes for zero gain" defect the comment at lines 1067-1070 already names, and because relocation is unimplementable once the source slot may be pinned. Called out in **User Review Required** and covered by manual step 18.

`showPaneToast` currently always wires an Undo button; when `onUndo` is `null` the button must be hidden rather than left as a no-op:

```js
function showPaneToast(text, onUndo) {
    ...
    toastUndoBtn.style.display = onUndo ? '' : 'none';
    ...
}
```

(The `display` is set on the button, not on `#pane-toast` itself, so it does not fight `.pane-toast.visible { display: flex; }` at `terminals.html:638`.)

### 4. `src/webview/terminals.js` — carry pins through undo

`undoSnapshot` gains a `pins` field at **both** of its construction sites — `assignToFocusedPane` (line 1082) and the `hide` handler (line 1244) — and `undoLastAssignment` (line 1110) restores it:

```js
function undoLastAssignment() {
    if (!undoSnapshot) { return; }
    hidePaneToast();
    paneAssignments = undoSnapshot.slots;
    if (Array.isArray(undoSnapshot.pins)) { pinnedPanes = undoSnapshot.pins; }
    ...
}
```

Also update the shape comment at line 606 to `// { slots: [...paneAssignments], pins: [...pinnedPanes], name, displaced, paneIndex }`.

> **Superseded:** "`undoSnapshot` gains a `pins` field at each of its **three** construction sites (`assignToFocusedPane` ~line 1082, the `hide` handler ~line 1244, and any future site)".
> **Reason:** There are exactly two `undoSnapshot = {` literals in the file (1082 and 1244); the third was imagined. The contract test asserts the real invariant — *every* such literal carries `pins:` — which is what actually protects future sites, so the miscount would have made the plan and the test disagree on the expected count.
> **Replaced with:** Two sites, enumerated above, with the "every literal" invariant enforced by contract assertion 6 rather than by a hard-coded count.

`renameTerminal`'s existing snapshot fixup (lines 1647-1651) needs no `pins` handling — pins are index-keyed and a rename does not move a slot.

### 5. `src/webview/terminals.js` — pin toggle in the pane header

In `renderPaneGrid()`'s `if (assignedName)` actions block (line 1222), prepend the toggle so it sits left of `clear`/`hide`. Suppressed in a single-slot grid (which covers solo mode, since `init()` forces `effectiveLayout = '1'` there):

```js
if (slotCount > 1) {
    const pinBtn = document.createElement('button');
    pinBtn.className = 'btn-unassign-pane btn-pin-pane' + (pinnedPanes[i] ? ' is-pinned' : '');
    pinBtn.textContent = pinnedPanes[i] ? (terse ? 'u' : 'unpin') : (terse ? 'p' : 'pin');
    pinBtn.title = pinnedPanes[i]
        ? 'Unpin — this pane can be reassigned again'
        : 'Pin — keep this agent in this pane; other agents go elsewhere';
    pinBtn.setAttribute('aria-pressed', pinnedPanes[i] ? 'true' : 'false');
    pinBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        pinnedPanes[i] = !pinnedPanes[i];
        saveLayoutSettings();
        renderPaneGrid();
        renderSidebarList();
    });
    actionsEl.appendChild(pinBtn);
}
```

> **Superseded:** An emoji toggle — `pinBtn.textContent = pinnedPanes[i] ? '📌' : '📍'` — with the note "The glyph is a single character in both states, so the terse 6-/9-pane fallback needs no variant for it."
> **Reason:** It reinstates the exact defect the pane-header actions were rewritten to remove. `terminals.html:576-579` documents it: *"They were two identically-styled single glyphs (⌫ and ⊟) sitting side by side, one of which sends /clear to the agent and the other of which only unassigns the pane — indistinguishable at a glance."* Adding a third single-glyph button beside `clear` and `hide` puts one emoji next to two text labels, and 📌 vs 📍 differ by a fraction of a glyph at 10px. The "no terse variant needed" claim is also wrong in the other direction: an emoji is not one character in the layout sense — it renders from the emoji font, not the panel's UI font, so it does not share the 10px metrics of its neighbours and will set the header's line box taller in the already-tight `2x3`/`3x3` headers.
> **Replaced with:** Text labels `pin` / `unpin`, terse `p` / `u`, reusing the existing `terse` flag at line 1225 — same treatment as `clear`/`hide`, with the pinned state carried by colour via `.btn-pin-pane.is-pinned` and by `aria-pressed`.

The `hide` handler in the same block clears the pin alongside the slot, so the toast's Undo has a coherent pair to restore:

```js
unassignBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const targetName = paneAssignments[i];
    undoSnapshot = { slots: paneAssignments.slice(), pins: pinnedPanes.slice(), name: null, displaced: targetName, paneIndex: i };
    showPaneToast(`Pane ${i + 1} cleared (${targetName} still running)`, undoLastAssignment);
    paneAssignments[i] = null;
    pinnedPanes[i] = false; // an empty pinned seat reserves a slot nothing can fill
    saveLayoutSettings();
    renderPaneGrid();
    renderSidebarList();
});
```

And the pane title chip marks the pinned state (line 1196). Unlike the button, the chip renders **regardless** of `slotCount`, so a pin that is currently inert in a floored one-pane grid is still visible rather than silently forgotten:

```js
const idxEl = document.createElement('span');
idxEl.className = 'pane-index-chip' + (pinnedPanes[i] ? ' is-pinned' : '');
idxEl.textContent = pinnedPanes[i] ? `📌P${i + 1}` : `P${i + 1}`;
```

### 6. `src/webview/terminals.js` — sidebar chip marks pinned seats

In `renderTerminalRow` (line 720), so the operator can see from the sidebar which agent is nailed down:

```js
if (paneIndex !== -1) {
    const isPinned = Boolean(pinnedPanes[paneIndex]);
    const paneChip = document.createElement('span');
    paneChip.className = 'pane-index-chip' + (isPinned ? ' is-pinned' : '');
    paneChip.textContent = isPinned ? `📌P${paneIndex + 1}` : `P${paneIndex + 1}`;
    paneChip.title = isPinned
        ? `Pinned to pane ${paneIndex + 1}`
        : `Showing in pane ${paneIndex + 1}`;
    info.appendChild(paneChip);
}
```

### 7. `src/webview/terminals.html` — pinned styling

Beside the existing `.btn-unassign-pane` / `.pane-index-chip` rules (lines 584-619):

```css
.btn-pin-pane.is-pinned {
    color: var(--accent-teal);
    border-color: var(--accent-teal);
    background: color-mix(in srgb, var(--accent-teal) 14%, transparent);
}
.pane-index-chip.is-pinned {
    color: var(--accent-teal);
    background: color-mix(in srgb, var(--accent-teal) 30%, transparent);
}
/* A pinned pane is visually distinct from the merely-focused one: focus is a 1px inset
   teal ring, pin is a 3px inset teal edge that survives focus moving away. Both are
   inset shadows, never borders — see the note below. */
.terminal-pane.pinned {
    box-shadow: inset 3px 0 0 var(--accent-teal);
}
.terminal-pane.pinned.focused {
    box-shadow: inset 0 0 0 1px var(--accent-teal), inset 3px 0 0 var(--accent-teal);
}
```

> **Superseded:** `.terminal-pane.pinned { border-left: 3px solid var(--accent-teal); }`
> **Reason:** `.terminal-pane` is `border: 1px solid` at `terminals.html:561-569`; widening one side to 3px shrinks the pane's content box by 2px. Each terminal container carries a debounced `ResizeObserver` (`createTerminalView`), so every pin toggle would fire a fit pass and a `{t:'resize'}` frame to the pty for that terminal — and the pinned pane would sit 2px narrower than its grid neighbours. This is exactly why the adjacent `.terminal-pane.focused` rule uses `box-shadow: inset 0 0 0 1px` instead of a border (line 570-573); the pin rule should not break that convention two lines below it.
> **Replaced with:** `box-shadow: inset 3px 0 0 var(--accent-teal)` — no geometry change, no refit — plus an explicit `.pinned.focused` rule, because a single `box-shadow` property does not merge across two matching class rules and the pinned-and-focused pane would otherwise lose its focus ring.

`renderPaneGrid` adds the class alongside `focused` (line 1179):

```js
paneEl.className = 'terminal-pane'
    + (i === focusedPaneIndex ? ' focused' : '')
    + (pinnedPanes[i] ? ' pinned' : '');
```

### 8. `src/test/terminal-pane-pinning-contract.test.js` — new source-text contract test

Modelled on `src/test/shell-terminal-strip.test.js` (same `block(code, startMarker, endMarker)` helper, same `test(name, fn)` harness, same reason: the cockpit is a browser-only IIFE with no export surface). Reads `../webview/terminals.js` and `../webview/terminals.html` from disk — never re-implements the logic locally, which is the failure the strip test's header documents. Assertions:

1. `assignToFocusedPane` consults `pinnedPanes` **before** it reads `focusedPaneIndex` as a target — i.e. the `isOpen` guard appears above the seating write.
2. Pins are inert in a one-pane grid: the `pinsActive` guard (`rendered > 1`) exists inside `assignToFocusedPane` and gates `isOpen`. This is the single-pane deadlock regression.
3. The all-pinned branch emits a toast and `return`s without writing `paneAssignments`.
4. The already-seated follow-branch returns before any pin logic mutates a slot, and sits **outside** the `if (paneAssignments[target])` conditional (the behaviour change in §3).
5. `sanitizePaneAssignments` contains an unconditional empty-slot pin clear — a loop whose condition tests `!paneAssignments[i]`, not `liveNames`. `closeTerminal`'s body contains no `pinnedPanes` reference, proving the clear is not duplicated there.
6. The `hide` handler clears the pin.
7. `undoLastAssignment` restores `pins`, and **every** `undoSnapshot = {` literal in the file carries a `pins:` key (count-independent, so a future site cannot slip through).
8. `renameTerminal`'s body contains no `pinnedPanes` reference (pins are index-keyed by design; a rename fixup there would be a bug).
9. `saveLayoutSettings` persists `terminals.pinnedPanes` and `loadLayoutSettings` reads it with an `Array.isArray` guard.
10. The pin toggle render is gated on `slotCount > 1` and uses text labels, not an emoji glyph — the pane-header action row stays label-consistent with `clear`/`hide`.
11. `.terminal-pane.pinned` in `terminals.html` uses `box-shadow`, not `border`, and a `.terminal-pane.pinned.focused` rule exists — the geometry/refit regression guard from §7.

Register it in `package.json` beside the sibling terminal contract scripts (line 846-847):

```json
"test:contract:terminal-pane-pinning": "node --require ./src/test/bootstrap/sandboxStateHome.js src/test/terminal-pane-pinning-contract.test.js"
```

And in CI — `.github/workflows/integration-tests.yml`, beside the three existing terminal-webview contract steps (lines 263 / 274 / 283), which is where `test:contract:shell-terminal-strip` and `test:contract:terminal-solo-popout` already run:

```yaml
      - name: Terminal pane pinning contract
        run: npm run test:contract:terminal-pane-pinning
```

> **Superseded:** Registering the new script in `package.json` only.
> **Reason:** Contract tests in this repo are not discovered by a glob — there is no `test:contract:all` aggregator, and `npm test` runs `vscode-test`, not the contract suite. Every contract test that is actually enforced is listed explicitly in `.github/workflows/integration-tests.yml`. A `package.json`-only registration produces a test that exists, passes locally once, and never runs again.
> **Replaced with:** Register in both `package.json` and the CI workflow.

## Verification Plan

### Automated Tests

**Deferred for this session.** The session directives are SKIP COMPILATION and SKIP TESTS, so no compile or test execution forms part of this verification plan. The contract test in §8 remains a **deliverable** — the coder writes and registers it; the operator runs it out of band. For reference, the commands are:

```bash
cd /Users/patrickvuleta/Documents/GitHub/switchboard
npm run lint
npm run test:contract:terminal-pane-pinning
npm run test:contract:shell-terminal-strip     # regression: strip relay + badge-clear paths
npm run test:contract:terminal-solo-popout     # regression: solo mode still suppresses persistence
npm run compile                                 # webpack copies src/webview/* → dist/webview/*
```

### Manual — the headline case (must pass)

1. Reload the Switchboard cockpit; open the Terminals panel; select the `2h` layout.
2. Seat agent **A** in pane 0 and agent **B** in pane 1.
3. Click `pin` in pane 0's header → the label becomes `unpin` and turns teal, pane 0 gains a teal inset left edge, the sidebar row for A shows `📌P1`.
4. **Click inside pane 0** to put the caret there (this is the step that used to poison the next click).
5. Click agent **C** in the sidebar. → **C replaces B in pane 1. A is still in pane 0.** Focus moves to pane 1.
6. Click agent **D** in the sidebar. → D replaces C in pane 1; A untouched.
7. Click agent **A** in the sidebar. → focus moves to pane 0, caret lands there, nothing is relocated.

### Manual — edge cases

8. Pin pane 1 as well, then click agent **E** in the sidebar → toast `All panes are pinned — unpin one to switch.`, no Undo button, both panes unchanged.
9. Unpin pane 1, click `hide` on pane 0 → pane 0 empties **and** unpins; Undo restores both the occupant and the pin.
10. Reload the browser panel → pin state on pane 0 survives (`terminals.pinnedPanes` persisted).
11. With pane 0 pinned, `close` agent A from the sidebar → pane 0 empties, the pin marker clears, and a subsequent sidebar click seats into pane 0 again. **Then reload** — pane 0 must still be unpinned and seatable (this is the `closeTerminal`-bypasses-sanitize path from §2; a stale persisted pin would show up here, not before the reload).
12. With pane 0 pinned, spawn a new terminal via **+ New** → it lands in pane 1, not pane 0.
13. With pane 0 pinned, click a kanban card that focuses a terminal → it lands in pane 1, not pane 0.
14. Rename the pinned agent inline → the pin stays on pane 0 and the renamed terminal keeps its seat.
15. Switch `2h` → `3x3` → back to `2h` → the pane 0 pin is still set and still enforced.
16. With pane 0 pinned in `2h`, **switch the layout picker to `1`** → the pin button disappears, the pane chip still reads `📌P1`, and clicking any agent in the sidebar **seats it normally** (no toast, no dead click). Switch back to `2h` → the pin is still set and enforced again.
17. With pane 0 pinned in `2h`, **narrow the window below 400px** so the floor banner appears and the grid drops to one pane → same as step 16: the sidebar stays fully usable, no `All panes are pinned` toast, no console errors. Widen again → pin re-enforced.
18. **Behaviour-change check (no pins set).** In `2x2`, seat A in pane 0 and B in pane 1, leave panes 2-3 empty, click into pane 0, then click **B** in the sidebar → B stays in pane 1 and focus moves there. (Before this change, B would have been relocated into pane 2, emptying pane 1.)
19. Pop a terminal out with `?solo=` → no pin button renders and no `terminals.pinnedPanes` write is issued.

---

**Recommendation: Send to Coder** (Complexity 6).

## Completion Report

Implemented per-slot terminal pane pinning as specified. Changes: `src/webview/terminals.js` — declared `pinnedPanes` beside `paneAssignments`, persisted it through `loadLayoutSettings`/`saveLayoutSettings` (`terminals.pinnedPanes`, `Array.isArray`-guarded), normalised length and ran an unconditional empty-slot pin clear in `sanitizePaneAssignments`, rewrote `assignToFocusedPane` to consult pins before focus (with the `rendered > 1` inert guard, the all-pinned toast, and the hoisted already-seated follow-branch), carried `pins` through both `undoSnapshot` literals and `undoLastAssignment`, added the `pin`/`unpin` toggle (text labels, `aria-pressed`, `slotCount > 1` gate) in `createPaneElement`/`updatePaneElement`, marked the pane title chip and sidebar chip with `📌P{n}` + `.is-pinned`, toggled a `.terminal-pane.pinned` class, hid the toast Undo button when `onUndo` is null, and cleared the pin in the `hide` handler. `src/webview/terminals.html` — added `.pane-index-chip.is-pinned`, `.btn-pin-pane.is-pinned`, and `.terminal-pane.pinned` / `.terminal-pane.pinned.focused` (box-shadow, not border). New contract test `src/test/terminal-pane-pinning-contract.test.js` (14 assertions, all pass), registered in `package.json` (`test:contract:terminal-pane-pinning`) and `.github/workflows/integration-tests.yml`. Issue encountered: a pre-existing extra `}` at the `renderSidebarList` tail (introduced by commit 7c9a688, present at HEAD) closed the IIFE early and made `terminals.js` fail to parse — `node --check`, eslint, and acorn all reported `Unexpected token 'function'` at `setLayoutMode`. Removed the stray brace so the file parses clean; this unblocks both the pre-existing panel functionality and the new pin feature. Verified: `node --check` passes, `npm run lint` reports 0 errors on `terminals.js`, and all terminal contract tests pass (pinning 14/14, shell-strip 17/17, solo-popout 11/11, pane-grid-reconcile, focus-affordance, pane-fit, answerback, token-transport, flow-control, input-path).

## Review Findings

Reviewed against the plan; one MAJOR defect found and fixed in `src/webview/terminals.js:1149` — the `paneAssignments[existingIndex] = null` write (reachable only for a terminal parked in a non-rendered slot, e.g. a pin set in `3x3` then shrunk to `2h`) vacated the slot but left `pinnedPanes[existingIndex]` true, persisting an invisible reserved seat that the sidebar silently refuses to fill until the next `sanitizePaneAssignments` heals it; this is the index-alignment site the plan's own audit listed as `assignToFocusedPane (1085/1088)` and the implementation missed. Files changed by this review: `src/webview/terminals.js` (pin clear + comment) and `src/test/terminal-pane-pinning-contract.test.js` (new 15th assertion guarding it). The coder's out-of-scope fix to the stray `}` at the `renderSidebarList` tail was independently verified as correct and necessary — `node --check` on `7c9a688:src/webview/terminals.js` fails with `Unexpected token 'function'`, so the whole panel was dead at that commit. Verification run independently (no skip directive in this dispatch): `node --check` OK, `npm run lint` 0 errors, `npm run compile` OK with `dist/webview/` carrying the pin code, all 12 terminal contract suites pass (pinning now 15/15), and the PRD gates `verb-returns:check` / `parity:check` / `push-routing:check` are green; `test:contract:terminal-pane-pinning` is defined at `package.json:855` and actually invoked at `.github/workflows/integration-tests.yml:322`. Remaining risks are accepted, not open: the follow-branch hoist changes unpinned placement for existing installs (plan-flagged under User Review, so not default-OFF per PRD contract #2), `closeTerminal` persists a pin on an empty slot for one write until sanitize heals it in memory on load, and manual steps 1-19 remain unexecuted since pinning is DOM behaviour no headless suite can observe.

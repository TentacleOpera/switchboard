# Stop Losing Browser Terminal Pane Assignments on Layout Switch and Mis-Click

## Goal

Make pane assignment in the browser Terminals panel durable and reversible: switching to a smaller layout must not destroy the assignments of the panes it stops rendering, clicking a sidebar terminal must not silently evict a pane the operator is watching, and the pane-clear control must be visually distinct from the kill-the-terminal control.

### Problem

Terminals fall out of the grid unexpectedly. The operator arranges four agents across a `2x2`, glances at a single terminal, comes back and finds the arrangement gone — panes empty, and the sidebar giving no clue about what was where. Rebuilding the layout by hand is a per-glance tax, and it is not obvious which action caused the loss.

### Root cause

There are three independent mechanisms in `src/webview/terminals.js`, all of which destroy assignments with no confirmation, no signal, and no undo.

**1. Layout downshift truncates the assignment array, then persists the truncation.**

`sanitizePaneAssignments()` (`src/webview/terminals.js:364-377`) slices the array to the *current* layout's slot count:

```js
const slotCount = getSlotCount(currentLayout);
paneAssignments = paneAssignments.slice(0, slotCount);
```

`setLayoutMode()` (`src/webview/terminals.js:554-569`) calls it on every layout pick, and the button handler in `init()` (`src/webview/terminals.js:229-236`) writes the result straight to storage:

```js
setLayoutMode(requested);
saveLayoutSettings();
```

So `2x2` → `1` slices four assignments down to one and immediately persists that. Switching back to `2x2` restores three *empty* panes. The comment above the slice says the sizing is deliberately keyed to `currentLayout` rather than the floored layout so a temporarily-narrow window can't truncate — which correctly protects against the *floor* path, and then the *user pick* path does exactly the thing the comment was guarding against.

**2. A sidebar click silently evicts whatever is in the focused pane.**

`assignToFocusedPane(terminalName)` (`src/webview/terminals.js:571-591`) writes unconditionally into `paneAssignments[focusedPaneIndex]`, overwriting whatever was there, and additionally nulls the terminal's previous slot if it was already on-screen:

```js
const existingIndex = paneAssignments.indexOf(terminalName);
if (existingIndex !== -1 && existingIndex !== focusedPaneIndex) {
    paneAssignments[existingIndex] = null;
}
paneAssignments[focusedPaneIndex] = terminalName;
```

One click can therefore clear *two* panes. It never prefers an empty slot, so with three empty panes available a click still evicts the focused one. And the only cue for which pane is focused is a `.focused` class on the pane border — the pane title says `Pane 3 (Empty)` only when empty, and assigned panes show no index at all.

**3. The pane-clear button and the close-terminal button are visually identical.**

The pane header's clear control (`src/webview/terminals.js:637-648`) and the sidebar's kill control (`src/webview/terminals.js:528-536`) both render `textContent = '×'` with `className = 'btn-close-term'`. Same glyph, same class, same styling — one clears a slot, the other terminates a PTY process. Only the `title` attribute differs.

Compounding all three: the sidebar computes `const isAssigned = paneAssignments.includes(item.friendlyName);` (`src/webview/terminals.js:487`) and then **never uses it** — `itemDiv.className` is built from `isFocused` only. The data needed to show "this terminal is in pane 2" is already there and thrown away, so after any loss the operator cannot see what changed.

## Metadata

- **Complexity:** 4
- **Tags:** frontend, ui, ux, bugfix, reliability

## User Review Required

- **Eviction-policy change is deliberate muscle-memory surgery.** A sidebar click that used to overwrite the focused pane now prefers an empty rendered pane. The fallback (all panes full → replace focused, announced + undoable) preserves the old behaviour only when no empty pane exists.
- **New persisted shape.** `terminals.paneAssignments` grows from ≤4 entries to a fixed 9 (null-padded). Older builds reading it slice to their slot count and are unaffected — confirm on downgrade if that path matters to you.
- **New UI surface:** a transient toast with an `Undo` button over the pane grid, plus `P<n>` chips in the sidebar and pane titles, and a new `⊟` glyph for pane-clear. All reversible styling, but they change the panel's look.

## Complexity Audit (Routine vs Complex/Risky)

**Routine**
- Removing the downward slice in `sanitizePaneAssignments` and padding to a fixed maximum instead.
- Giving the pane-clear button its own class and glyph, plus a CSS rule.
- Using the already-computed `isAssigned` to render a pane-index badge in the sidebar.
- Strengthening the `.terminal-pane.focused` ring and adding a pane-index chip to assigned pane titles.

**Complex / Risky**
- **Changing `assignToFocusedPane` eviction policy.** Preferring an empty pane changes where a click lands, which is muscle memory for the current behaviour. It must stay *predictable*: prefer the focused pane when it is empty, otherwise the lowest-index empty **rendered** pane, otherwise replace the focused pane. Preferring an empty pane that is currently floored-out (index ≥ rendered slot count) would send the terminal somewhere invisible — worse than the bug being fixed.
- **Undo state and the async refresh.** `fetchTerminalList()` fires on every `terminalsChanged` broadcast and calls `sanitizePaneAssignments()`, which nulls slots for dead terminals. An undo snapshot must be invalidated when the terminal it would restore is no longer live, or undo resurrects a name with no session and the pane renders a dead view.
- **Persistence coupling.** `saveLayoutSettings()` writes all three keys together. Once the array is padded to the table maximum, the persisted `terminals.paneAssignments` grows from ≤4 entries to the maximum. Older builds reading it call `slice(0, slotCount)` and are unaffected — but confirm rather than assume.

## Edge-Case & Dependency Audit

**Dependencies**
- `src/webview/terminals.js` and `src/webview/terminals.html`. No provider, server or PTY-host change.
> **Superseded:** Persists through the existing `POST /kanban/verb/setSetting` rail.
> **Reason:** No such endpoint exists. `saveSetting()` (`src/webview/terminals.js:302-310`) posts to `/kanban/verb/saveSetting`; `loadSetting()` posts to `/kanban/verb/getSetting`. Verified against the source.
> **Replaced with:** Persists through the existing `POST /kanban/verb/saveSetting` / `POST /kanban/verb/getSetting` rails (`saveSetting`/`loadSetting`, `src/webview/terminals.js:285-310`, `334-338`) under `terminals.paneAssignments` / `terminals.layoutMode`. No new endpoint or schema.
- **Overlap (reconciled):** the companion plan that expands the grid past 4 panes touches the same `sanitizePaneAssignments` sizing and introduces a `getMaxSlotCount()` derived from its `LAYOUTS` table. **Reconciled end-state:** this plan lands first and pads to a forward-looking `MAX_PANE_SLOTS = 9` constant (the densest layout on the roadmap); when the grid plan lands, it deletes the constant and re-points the pad at `getMaxSlotCount()` — one mechanical substitution, single hunk, single owner (the `LAYOUTS` table). Neither plan re-applies the other's hunk.

**Edge cases**
- **Layout downshift then reload.** Assign 4, switch to `1`, reload. Panes 2-4 must come back when `2x2` is re-picked.
- **Floored layout + assignment.** In a window floored from `2x2` to `2h`, a sidebar click must not land in pane 3 or 4 (not rendered). `assignToFocusedPane` already clamps `focusedPaneIndex` against `getSlotCount(effectiveLayout)`; the new empty-slot search must use the same **effective** bound, not `currentLayout`.
- **Terminal dies while assigned.** `sanitizePaneAssignments` nulls its slot (`src/webview/terminals.js:378-383`). That is correct and must stay — the durability change must not make dead terminals sticky.
- **Rename while assigned.** `renameTerminal` rewrites matching slots to the new name (`src/webview/terminals.js:215-218`). Confirm the pane-index badge and any undo snapshot follow the rename rather than stranding the old name.
- **Same terminal clicked twice.** `existingIndex === focusedPaneIndex` — must be a no-op, not a clear-then-set that flickers the view.
- **Undo after the pane was reassigned twice.** Single-level undo only; the second mutation replaces the snapshot. Do not build a stack.
- **All panes full.** Eviction is then unavoidable; it must be *announced* (transient toast naming the pane and the displaced terminal) and undoable.
- **`initialAssignmentDone` seeding.** The first-load seed of pane 0 (`src/webview/terminals.js:388-396`) only fires when no pane holds anything. With assignments now surviving layout switches, this fires less often — confirm a genuinely fresh page still seeds pane 0.

## Dependencies

- None — no prior session output required. Self-contained within `src/webview/terminals.js` / `terminals.html`. Lands **before** the grid-expansion sibling (feature-level sequencing, not a code dependency).

## Adversarial Synthesis

Key risks: the eviction-policy change alters click behaviour users know; the undo snapshot can resurrect a dead terminal if not invalidated on stale-slot drop; and the fixed 9-slot array must stay compatible with older builds reading the persisted setting. Mitigations: prefer-empty only within *rendered* panes (never floored-out slots), capture the victim name before nulling in the invalidation path, single-level undo only, and older builds provably slice the larger array without harm.

## Proposed Changes

### 1. `src/webview/terminals.js` — stop truncating on layout downshift

`sanitizePaneAssignments()` keeps a fixed-length array; the renderer already draws only the first `getSlotCount(effectiveLayout)` entries.

> **Superseded:** `const MAX_PANE_SLOTS = 4; // raise alongside any new layout entry`
> **Reason:** Two defects. (1) Padding to 4 while the sibling grid plan adds 6- and 9-slot layouts means a first `2x3`/`3x3` pick grows the array mid-render — the exact half-landed-state this plan exists to remove. (2) A hand-maintained constant duplicates what the sibling's `LAYOUTS` table derives, recreating the five-places-to-edit disease in miniature. Reconciled end-state: pad to the roadmap maximum now; the grid plan swaps the constant for `getMaxSlotCount()` when its table lands.
> **Replaced with:** `const MAX_PANE_SLOTS = 9;` (see the comment in the snippet below).

> **Superseded:** the stale-slot drop loop nulled `paneAssignments[i]` and then tested `undoSnapshot.name === paneAssignments[i]`.
> **Reason:** After `paneAssignments[i] = null` the comparison reads `null` and can never match — the undo snapshot would survive the death of the very terminal it restores, and `Undo` would resurrect a dead name into the pane. Capture the evicted name *before* nulling.
> **Replaced with:** the corrected loop below (`const dropped = paneAssignments[i];` captured first).

```js
    /** Widest layout the picker offers. The assignment array is always this long so a
     *  downshift to a smaller layout hides panes instead of deleting them. */
    // RECONCILED with the grid-expansion sibling: 9 is the densest layout on the
    // roadmap (3x3). Padding to 9 now means the sibling's layouts find real slots on
    // day one, and older builds reading the persisted 9-entry array just slice it.
    // The grid plan replaces this constant with getMaxSlotCount() when its LAYOUTS
    // table lands — do not raise this number by hand afterwards.
    const MAX_PANE_SLOTS = 9;

    function sanitizePaneAssignments() {
        const liveNames = new Set(fleetList.map(t => t.friendlyName));

        // Fixed-length, layout-independent. The previous slice() keyed to
        // currentLayout meant setLayoutMode('1') -> saveLayoutSettings() persisted
        // away panes 2..N; switching back restored empty slots. Only DEAD terminals
        // may clear a slot (below) — never a layout pick.
        while (paneAssignments.length < MAX_PANE_SLOTS) { paneAssignments.push(null); }
        if (paneAssignments.length > MAX_PANE_SLOTS) { paneAssignments.length = MAX_PANE_SLOTS; }

        // Stale-slot drop: a persisted layout may name terminals that died while the page
        // was closed. Drop those slots individually — never discard the whole layout.
        for (let i = 0; i < paneAssignments.length; i++) {
            if (paneAssignments[i] && !liveNames.has(paneAssignments[i])) {
                // Capture BEFORE nulling — comparing against the just-nulled slot never
                // matches, which would leave undo able to resurrect a dead terminal.
                const dropped = paneAssignments[i];
                paneAssignments[i] = null;
                if (undoSnapshot && (undoSnapshot.name === dropped || undoSnapshot.displaced === dropped)) { undoSnapshot = null; }
            }
        }
        // ... activeTerminalName check and initialAssignmentDone seed unchanged
    }
```

### 2. `src/webview/terminals.js` — prefer an empty pane, announce and allow undo of an eviction

Replace `assignToFocusedPane` (currently `src/webview/terminals.js:571-591`).

Placement note: declare `undoSnapshot` alongside the other module-level pane state (near `paneAssignments` / `focusedPaneIndex`), **above** `sanitizePaneAssignments` — section 1's stale-drop loop reads it, so the declaration must precede any call path into sanitize.

```js
    /** Single-level undo of the last assignment mutation. Cleared when the terminal it
     *  would restore stops being live (see sanitizePaneAssignments). */
    let undoSnapshot = null; // { slots: [...paneAssignments], name, displaced, paneIndex }

    function assignToFocusedPane(terminalName) {
        const rendered = getSlotCount(effectiveLayout);
        if (focusedPaneIndex < 0 || focusedPaneIndex >= rendered) { focusedPaneIndex = 0; }

        const existingIndex = paneAssignments.indexOf(terminalName);
        // Already in the focused pane — nothing to do. Falling through would clear and
        // re-set the same slot, tearing down and rebuilding the view for no reason.
        if (existingIndex === focusedPaneIndex) { return; }

        // Target selection: the focused pane if it is free, else the lowest-index free
        // RENDERED pane, else the focused pane (an announced, undoable eviction).
        // The bound is `rendered`, not getSlotCount(currentLayout) — parking a terminal
        // in a floored-out pane would hide it, which is the bug we are fixing.
        let target = focusedPaneIndex;
        if (paneAssignments[target]) {
            for (let i = 0; i < rendered; i++) {
                if (!paneAssignments[i]) { target = i; break; }
            }
        }

        const displaced = paneAssignments[target] || null;
        undoSnapshot = { slots: paneAssignments.slice(), name: terminalName, displaced, paneIndex: target };

        if (existingIndex !== -1) { paneAssignments[existingIndex] = null; }
        paneAssignments[target] = terminalName;
        focusedPaneIndex = target;
        activeTerminalName = terminalName;
        terminalBadges.delete(terminalName);

        if (displaced) {
            showPaneToast(`Pane ${target + 1}: ${displaced} → ${terminalName}`, undoLastAssignment);
        }

        saveLayoutSettings();
        renderSidebarList();
        renderPaneGrid();
        batchFitVisiblePanes();
    }

    function undoLastAssignment() {
        if (!undoSnapshot) { return; }
        paneAssignments = undoSnapshot.slots;
        focusedPaneIndex = Math.min(undoSnapshot.paneIndex, getSlotCount(effectiveLayout) - 1);
        activeTerminalName = paneAssignments[focusedPaneIndex] || null;
        undoSnapshot = null;
        saveLayoutSettings();
        renderSidebarList();
        renderPaneGrid();
        batchFitVisiblePanes();
    }
```

`showPaneToast(text, onUndo)` is a small helper: a fixed-position element over the grid with the message and an `Undo` button, auto-hiding after ~6s (mirror the existing 8s banner pattern rather than introducing a new timing convention). It must clear its own timer on re-entry so rapid reassignments do not stack timers.

### 3. `src/webview/terminals.js` — make the pane-clear control distinguishable

In `renderPaneGrid()` (currently `src/webview/terminals.js:637-648`):

```js
             const unassignBtn = document.createElement('button');
-            unassignBtn.className = 'btn-close-term';
-            unassignBtn.textContent = '×';
-            unassignBtn.title = 'Clear pane assignment';
+            // Deliberately NOT btn-close-term/'×' — the sidebar uses that exact class and
+            // glyph to KILL the PTY process. Two different destructive actions must not
+            // share an appearance.
+            unassignBtn.className = 'btn-unassign-pane';
+            unassignBtn.textContent = '⊟';
+            unassignBtn.title = 'Remove from pane (terminal keeps running)';
             unassignBtn.addEventListener('click', (e) => {
                 e.stopPropagation();
+                undoSnapshot = { slots: paneAssignments.slice(), name: null, displaced: paneAssignments[i], paneIndex: i };
+                showPaneToast(`Pane ${i + 1} cleared (${paneAssignments[i]} still running)`, undoLastAssignment);
                 paneAssignments[i] = null;
                 saveLayoutSettings();
                 renderPaneGrid();
                 renderSidebarList();
             });
```

### 4. `src/webview/terminals.js` — show where each terminal lives, and which pane is focused

Sidebar item (currently `src/webview/terminals.js:487-490`) — put the dead `isAssigned` to work:

```js
                 const paneIndex = paneAssignments.indexOf(item.friendlyName);
                 const isFocused = activeTerminalName === item.friendlyName;
                 itemDiv.className = 'terminal-item'
                     + (isFocused ? ' active' : '')
                     + (paneIndex !== -1 ? ' assigned' : '');
                 // ...
                 if (paneIndex !== -1) {
                     const paneChip = document.createElement('span');
                     paneChip.className = 'pane-index-chip';
                     paneChip.textContent = `P${paneIndex + 1}`;
                     paneChip.title = `Showing in pane ${paneIndex + 1}`;
                     info.appendChild(paneChip);
                 }
```

Pane title (currently `src/webview/terminals.js:619-633`) — always carry the index, not only when empty:

```js
             if (assignedName) {
-                titleEl.textContent = assignedName;
+                const idxEl = document.createElement('span');
+                idxEl.className = 'pane-index-chip';
+                idxEl.textContent = `P${i + 1}`;
+                titleEl.appendChild(idxEl);
+                titleEl.appendChild(document.createTextNode(assignedName));
```

### 5. `src/webview/terminals.html` — styling for the new controls

```css
+        /* Clear-pane: muted and square, so it does not read as the sidebar's
+           destructive red '×' kill button. */
+        .btn-unassign-pane {
+            background: transparent;
+            border: 1px solid var(--border-color);
+            color: var(--text-secondary);
+            font-size: 11px;
+            line-height: 1;
+            padding: 1px 4px;
+            border-radius: 3px;
+            cursor: pointer;
+        }
+        .btn-unassign-pane:hover {
+            color: var(--text-primary);
+            border-color: var(--accent-teal);
+        }
+        .pane-index-chip {
+            font-size: 9px;
+            font-weight: 700;
+            padding: 0 3px;
+            margin-right: 4px;
+            border-radius: 2px;
+            color: var(--accent-teal);
+            background: color-mix(in srgb, var(--accent-teal) 18%, transparent);
+        }
+        .terminal-item.assigned .item-name { color: var(--text-primary); }
+
+        /* Focused pane must be unmistakable — a sidebar click lands here. */
+        .terminal-pane.focused {
+            border-color: var(--accent-teal);
+            box-shadow: inset 0 0 0 1px var(--accent-teal);
+        }
+
+        .pane-toast {
+            position: absolute;
+            bottom: 12px;
+            left: 50%;
+            transform: translateX(-50%);
+            display: none;
+            align-items: center;
+            gap: 10px;
+            padding: 6px 10px;
+            font-size: 11px;
+            border: 1px solid var(--border-bright);
+            border-radius: 4px;
+            background: var(--panel-bg2);
+            color: var(--text-primary);
+            z-index: 40;
+        }
+        .pane-toast.visible { display: flex; }
+        .pane-toast button {
+            background: transparent;
+            border: 1px solid var(--accent-teal);
+            color: var(--accent-teal);
+            font-size: 10px;
+            font-weight: 700;
+            padding: 1px 6px;
+            border-radius: 3px;
+            cursor: pointer;
+        }
```

Plus the toast element next to the existing fallback banner (near `src/webview/terminals.html:604-607`):

```html
+        <div id="pane-toast" class="pane-toast"><span id="pane-toast-text"></span><button type="button" id="pane-toast-undo">Undo</button></div>
```

## Verification Plan

**Build**
- *Session directive: no compilation step in this verification plan.* When the change is later built for manual verification, remember the running extension serves from `~/.<ide>/extensions/turnzero.switchboard-*/dist/`, not the repo `dist/` — the built webview assets must be synced there and the window reloaded.

**Manual — layout downshift no longer destroys assignments (primary regression)**
2. Spawn 4 PTY terminals. Pick `2x2` and assign one per pane.
3. Pick `1`. Confirm one pane renders.
4. Pick `2x2` again. **All four original assignments must return**, in their original panes.
5. Repeat step 2-3, then reload the page before switching back. Pick `2x2`. All four must still return — i.e. the persisted array was never truncated.

**Manual — sidebar click prefers an empty pane**
6. Pick `2x2`, assign a terminal to pane 1 only, and leave pane 1 focused. Click a second terminal in the sidebar. It must land in pane 2 (first empty rendered pane), not replace pane 1.
7. Fill all four panes. Focus pane 3, click a fifth terminal. It replaces pane 3, a toast appears naming the displaced terminal, and `Undo` restores the previous arrangement exactly.
8. Click a terminal already shown in the focused pane. Confirm nothing re-renders and the terminal's scrollback/cursor position is untouched.
9. Click a terminal already in pane 4 while pane 1 is focused and empty. Confirm it moves to pane 1 and pane 4 becomes empty (single move, not a duplicate).

**Manual — floored layout bound**
10. Pick `2x2`, then narrow the window until it floors to `2h` (banner visible). Click sidebar terminals. Confirm they only ever land in panes 1-2, never into the unrendered 3-4.
11. Restore the window to `2x2`. Confirm the panes 3-4 assignments from before the narrowing are still present.

**Manual — control disambiguation**
12. Confirm the pane header control is `⊟` with tooltip "Remove from pane (terminal keeps running)", visually distinct from the sidebar's `×`.
13. Click the pane `⊟`. Confirm the pane empties, a toast fires, the terminal is **still listed as active** in the sidebar (status dot not `exited`), and `Undo` restores it to that pane with its scrollback intact.
14. Click the sidebar `×` on the same terminal. Confirm the PTY actually terminates and its pane clears.

**Manual — visibility**
15. Confirm each assigned sidebar entry carries a `P<n>` chip matching its pane, and each assigned pane title carries the same chip.
16. Confirm the focused pane has an unmistakable teal ring, and that clicking a different pane moves the ring.

**Manual — lifecycle interactions**
17. With a terminal assigned to pane 2, close it from the sidebar. Confirm pane 2 clears and any pending undo for it is dropped (clicking `Undo` must not resurrect a dead name).
18. Rename an assigned terminal (double-click its name). Confirm the pane title, the `P<n>` chip and the sidebar entry all follow the new name.
19. Fresh state: clear `terminals.paneAssignments`, reload with terminals live. Confirm pane 0 is still auto-seeded.

**Regression**
20. Confirm the `#layout-fallback-banner` still appears/hides on the floor transitions and that the new toast does not overlap or suppress it.
21. Confirm no console errors across all of the above, and no leaked WebSockets after closing every terminal.

## Completion Report

Prevented layout downshifts from truncating stored pane assignments, updated eviction logic to prefer free rendered slots with transient toast and single-level undo, added distinct `⊟` unassign buttons, and rendered `P<n>` chips on sidebar items and pane headers. Files changed: `src/webview/terminals.js` and `src/webview/terminals.html`. No issues encountered during implementation.

## Review Findings

Reviewed against the plan; the core truncation fix, `⊟` disambiguation and `P<n>` chips are correct, but four undo/eviction defects were found and fixed in `src/webview/terminals.js`: undo could resurrect a terminal closed via the sidebar `×` (verification item 17 — `closeTerminal` nulls its own slots, so the per-slot drop loop never saw the dead name; replaced with a whole-snapshot liveness sweep), a stale toast's `Undo` reverted a *later* mutation than its text described (added `hidePaneToast()` on every unannounced snapshot replacement), `renameTerminal` stranded the snapshot on the old name (snapshot now follows the rename), and a click on an already-visible terminal with all panes full evicted a bystander and left an empty pane (now just moves focus). Validation: `tsc -p tsconfig.test.json` clean, `npm run compile` clean, `npm run lint` clean, `terminals.js` parses, and all 25 CI contract gates pass. Remaining risks: no automated coverage exists for this webview (`eslint.config.js` scopes to `**/*.ts` only, so `src/webview/*.js` is unlinted and untested) — the plan's 21 manual verification steps are still the only proof, and steps 6-19 have not been executed. Pre-existing and unrelated: `npm run test:integration:all` is red on `main` (reproduced identically on a pre-implementation baseline worktree).


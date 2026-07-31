# Expand the Browser Terminals Grid Beyond Four Panes

## Goal

Raise the browser Terminals panel from a hard ceiling of 4 simultaneously-visible agent terminals to 6 and 9, by replacing the four hardcoded layout modes with a layout table that drives the picker, the slot count, the CSS grid and the responsive floor from a single source of truth.

### Problem

Running a fleet of more than four agents in browser mode is impossible to *watch*. The layout picker offers exactly four choices — `1`, `2h`, `2v`, `2x2` — and the largest of them renders 4 panes. Any fifth, sixth or seventh terminal exists in the fleet and appears in the sidebar list, but there is no pane to put it in, so the operator has to keep swapping terminals in and out of the four available slots to see what each agent is doing.

### Root cause

The 4-pane ceiling is purely a **presentation-layer cap in `src/webview/terminals.js`**. It is not a fleet, gateway, or PTY-host limit:

- `PtyFleetService.create()` (`src/standalone/ptyFleetService.ts:73`) has **no count cap** — it auto-uniquifies names (`${role}-${counter}`) and will happily create an unbounded number of terminals.
- `TerminalWsGateway` (`src/standalone/terminalWsGateway.ts`) has **no client/terminal cap** — its only limits are per-terminal byte budgets (`MAX_SCROLLBACK_BYTES` 256 KB, `MAX_FLUSH_BYTES` 128 KB).
- `getRegisteredTerminals()` in `TaskViewerProvider._startLocalApiServer` (`src/services/TaskViewerProvider.ts:1761`) enumerates the whole active fleet with no truncation.

The cap comes from three places in the webview that each hardcode the same four-item list, and one CSS block that defines grid geometry for exactly those four:

1. `getSlotCount(layout)` — `src/webview/terminals.js:275` — a `switch` whose maximum return value is `4` (`case '2x2': return 4;`).
2. `setLayoutMode(mode)` — `src/webview/terminals.js:554` — `if (!['1','2h','2v','2x2'].includes(mode)) return;`.
3. `loadLayoutSettings()` — `src/webview/terminals.js:318` — the same literal array, used to validate the persisted `terminals.layoutMode` setting.
4. `.pane-grid.layout-*` CSS — `src/webview/terminals.html:412-415` — four `grid-template-columns`/`grid-template-rows` rules.

Plus a fifth, `resolveFlooredLayout()` (`src/webview/terminals.js:691`), which hardcodes the responsive step-down chain as an if-ladder over those same four names with inline pixel thresholds.

Because the same list is duplicated in five places with no shared definition, adding a layout today means editing all five and hoping none was missed — which is exactly the kind of change that half-lands. The fix is to introduce the table first, re-point all five consumers at it, and only then add the new entries.

## Metadata

- **Complexity:** 5
- **Tags:** frontend, ui, ux, feature, refactor

## User Review Required

- **Downgrade behaviour.** A user who picks `2x3`/`3x3` and then downgrades the extension hits the old four-item validation list, which silently falls back to `'1'`. A layout reset, not data loss — accepted, stated here so it is not discovered.
- **Blast-radius acknowledgement.** Until the pane-assignment-durability sibling lands, switching `3x3` → `1` persists away eight assignments instead of four. This plan widens that pre-existing bug's magnitude; feature sequencing lands durability first to avoid shipping the window.
- **9 concurrent xterm instances.** Accepted with the existing `webgl.onContextLoss` → canvas fallback and `destroyTerminalView` disposal as the safety net; a per-pane WebGL fallback cascade at `3x3` is a verification failure, not a shrug.

## Complexity Audit (Routine vs Complex/Risky)

**Routine**
- Adding `LAYOUTS` table entries and the two new CSS grid rules.
- Adding two `<button class="btn-layout">` elements to the picker toolbar.
- Re-pointing `getSlotCount`, `setLayoutMode` and `loadLayoutSettings` at the table — all three are single-expression substitutions.

**Complex / Risky**
- **`resolveFlooredLayout()` rewrite.** The existing if-ladder encodes a *branching* step-down (`2x2` falls to `2h` when width ≥ 400, else to `2v`). Replacing it with a linear walk over an ordered list must reproduce that branch exactly, or narrow windows regress from "readable 2-pane" to "unreadable 4-pane" or "pointlessly 1-pane". Behaviour parity for the existing four modes is a hard requirement of this change.
- **Persisted-setting forward compatibility.** `terminals.layoutMode` is stored via `saveSetting` and validated on read. A user who picks `3x3`, then downgrades the extension, hits the old four-item validation list, which silently falls back to `'1'`. Acceptable (a layout reset, not data loss) but must be stated, not discovered.
- **9 concurrent xterm instances.** Each pane gets its own `Terminal`, `FitAddon`, WebSocket and GPU renderer. The renderer chain (`src/webview/terminals.js:86-197`) prefers `WebglAddon`, falls back to `CanvasAddon`, then DOM. Chrome caps live WebGL contexts (~16 per process); at 9 panes the panel is a single page well under that, but the existing `webgl.onContextLoss` → canvas fallback and the `destroyTerminalView` disposal at `src/webview/terminals.js:910-915` are the load-bearing safety net and must not be bypassed.

## Edge-Case & Dependency Audit

**Dependencies**
- `src/webview/terminals.js` and `src/webview/terminals.html` are the only files that need to change. No provider, server, or PTY-host change is required.
> **Superseded:** Reads/writes through the existing `POST /kanban/verb/getSetting` / `setSetting` rails.
> **Reason:** No `setSetting` endpoint exists. `saveSetting()` (`src/webview/terminals.js:302-310`) posts to `/kanban/verb/saveSetting`. Verified against the source.
> **Replaced with:** Reads/writes the `terminals.layoutMode` and `terminals.paneAssignments` settings through the existing `POST /kanban/verb/getSetting` / `POST /kanban/verb/saveSetting` rails (`loadSetting`/`saveSetting`, `src/webview/terminals.js:285-338`). No new endpoint.
- **Sequencing:** `sanitizePaneAssignments()` (`src/webview/terminals.js:364`) currently *slices* `paneAssignments` down to the current layout's slot count, and the layout-button handler (`src/webview/terminals.js:229-236`) persists immediately afterwards. That means switching `3x3` → `1` permanently discards eight assignments instead of four. This plan makes that pre-existing bug **worse in magnitude**; it does not introduce it, and it does not fix it. Land the pane-assignment-durability work first, or accept the larger blast radius in the interim. Call this out in the PR description.

**Edge cases**
- **Small window + large pick.** A 9-pane pick in a 600×400 panel must floor down, show the existing `#layout-fallback-banner`, and re-render with the *floored* pane count — not leave nine pane elements reflowing into an implicit grid (the failure mode the current comment at `src/webview/terminals.js:706-711` documents).
- **Focus index beyond the floored count.** `renderPaneGrid()` already resets `focusedPaneIndex` to 0 when it exceeds `slotCount` (`src/webview/terminals.js:599`); with more slots this path is hit more often (e.g. focus pane 8, shrink window to a 2-pane floor). Verify it still holds after the table swap.
- **Fewer terminals than panes.** 9 panes with 3 terminals must render 6 `.pane-empty-slot` placeholders and not throw. Current code handles this; confirm under the new counts.
- **Zero-size grid box.** `resolveFlooredLayout` returns `currentLayout` unchanged when `rect.width/height <= 0` (panel hidden). The rewritten resolver must keep that early return or a hidden panel floors to `'1'` and loses its layout on the next real resize.
- **`batchFitVisiblePanes()` cost.** It loops `slotCount` and issues a `fit()` + `{t:'resize'}` frame per assigned pane inside one `requestAnimationFrame`. At 9 panes that is 9 fits and 9 resize frames per layout change. Acceptable for a discrete user action; it must **not** be wired to the window `resize` listener, which is already deliberately `{ fit: false }` (`src/webview/terminals.js:266-268`).
- **Header legibility at density.** `.pane-header` is sized for a 2×2 grid. At 3×3 the title plus badge can overflow; the header needs a density-aware font-size/truncation rule so a pane title does not push the terminal body.

## Dependencies

- None — no prior session output required. Self-contained within `src/webview/terminals.js` / `terminals.html`. Lands **after** the pane-assignment-durability sibling (feature-level sequencing: the durability plan removes the truncation bug this plan would otherwise widen).

## Adversarial Synthesis

Key risks: the `resolveFlooredLayout` table walk must reproduce the old ladder's branching step-down exactly for the existing four modes; the assignment-array sizing hunk collides with the durability sibling (reconciled: this plan swaps `MAX_PANE_SLOTS` for `getMaxSlotCount()`, never re-applies the pad); and 9 xterm/WebGL instances stress the renderer fallback chain. Mitigations: explicit parity cases in review and verification, single-owner reconciliation of the shared hunk, and a zero-box early return preserved verbatim.

## Proposed Changes

### 1. `src/webview/terminals.js` — introduce the layout table (single source of truth)

Replace the `getSlotCount` switch with a table declared next to it, and derive everything from it.

```js
    /**
     * Single source of truth for pane layouts. Every consumer — the picker's
     * validation, the slot count, the CSS class, and the responsive floor — reads
     * this table. Adding a layout means adding one row here plus one CSS rule in
     * terminals.html; it must never mean editing a hardcoded name list again.
     *
     * minW/minH are the smallest grid box in which xterm still renders a readable
     * column count for that geometry. Below it, resolveFlooredLayout() steps DOWN
     * the FLOOR_ORDER chain rather than subdividing further.
     */
    const LAYOUTS = {
        '1':   { slots: 1, minW: 0,   minH: 0   },
        '2h':  { slots: 2, minW: 400, minH: 0   },
        '2v':  { slots: 2, minW: 0,   minH: 250 },
        '2x2': { slots: 4, minW: 500, minH: 300 },
        '2x3': { slots: 6, minW: 750, minH: 300 },
        '3x3': { slots: 9, minW: 750, minH: 450 },
    };

    /**
     * Step-down chain, densest first. resolveFlooredLayout() starts at the user's
     * pick and walks FORWARD to the first entry whose minW/minH the grid box
     * satisfies. The 2h-before-2v order reproduces the previous if-ladder exactly:
     * a wide-but-short box floors 2x2 to 2h, a narrow-but-tall box skips 2h (minW
     * 400 unmet) and lands on 2v.
     */
    const LAYOUT_FLOOR_ORDER = ['3x3', '2x3', '2x2', '2h', '2v', '1'];

    const LAYOUT_MODES = Object.keys(LAYOUTS);

    function getSlotCount(layout) {
        return (LAYOUTS[layout] || LAYOUTS['1']).slots;
    }

    function getMaxSlotCount() {
        return Math.max(...LAYOUT_MODES.map(m => LAYOUTS[m].slots));
    }
```

### 2. `src/webview/terminals.js` — re-point the two validation sites

`loadLayoutSettings()` (currently `src/webview/terminals.js:318`):

```js
-        if (['1', '2h', '2v', '2x2'].includes(savedMode)) {
+        if (LAYOUT_MODES.includes(savedMode)) {
             currentLayout = savedMode;
         }
```

`setLayoutMode(mode)` (currently `src/webview/terminals.js:554`):

```js
     function setLayoutMode(mode) {
-        if (!['1', '2h', '2v', '2x2'].includes(mode)) return;
+        if (!LAYOUT_MODES.includes(mode)) return;
         currentLayout = mode;
```

### 3. `src/webview/terminals.js` — rewrite `resolveFlooredLayout()` as a table walk

Replace the whole if-ladder (currently `src/webview/terminals.js:691-704`):

```js
    function resolveFlooredLayout() {
        const rect = paneGridEl.getBoundingClientRect();
        // Zero box = panel hidden or not laid out yet. Assume the user's pick; the next
        // real resize re-evaluates. (Unchanged contract — do not floor a hidden panel,
        // or its layout is lost the moment it becomes visible.)
        if (rect.width <= 0 || rect.height <= 0) { return currentLayout; }

        const start = LAYOUT_FLOOR_ORDER.indexOf(currentLayout);
        if (start === -1) { return '1'; }

        for (let i = start; i < LAYOUT_FLOOR_ORDER.length; i++) {
            const mode = LAYOUT_FLOOR_ORDER[i];
            const spec = LAYOUTS[mode];
            if (rect.width >= spec.minW && rect.height >= spec.minH) { return mode; }
        }
        return '1';
    }
```

Parity note to verify in review: for `currentLayout === '2x2'` and a 450×280 box, the old ladder produced `2h` (width ≥ 400); the walk skips `2x2` (minH 300 unmet), tests `2h` (minW 400 met, minH 0) → `2h`. For a 380×400 box, the old ladder produced `2v`; the walk skips `2x2` (minW 500), skips `2h` (minW 400), tests `2v` (minH 250 met) → `2v`. Matches.

### 4. `src/webview/terminals.html` — picker buttons

Extend the toolbar (currently `src/webview/terminals.html:594-599`):

```html
             <div class="layout-picker">
                 <button type="button" class="btn-layout active" data-layout="1">1</button>
                 <button type="button" class="btn-layout" data-layout="2h">2h</button>
                 <button type="button" class="btn-layout" data-layout="2v">2v</button>
                 <button type="button" class="btn-layout" data-layout="2x2">2x2</button>
+                <button type="button" class="btn-layout" data-layout="2x3">2x3</button>
+                <button type="button" class="btn-layout" data-layout="3x3">3x3</button>
             </div>
```

No JS wiring change is needed — `init()` already binds every `.btn-layout` by `data-layout` (`src/webview/terminals.js:228-236`).

### 5. `src/webview/terminals.html` — grid geometry + density rules

Extend the grid block (currently `src/webview/terminals.html:412-415`):

```css
         .pane-grid.layout-2x2 { grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; }
+        .pane-grid.layout-2x3 { grid-template-columns: repeat(3, 1fr); grid-template-rows: repeat(2, 1fr); }
+        .pane-grid.layout-3x3 { grid-template-columns: repeat(3, 1fr); grid-template-rows: repeat(3, 1fr); }
+
+        /* Density: a 3-column pane header must not steal rows from the terminal body.
+           Shrink the chrome and truncate the title instead of wrapping it. */
+        .pane-grid.layout-2x3 .pane-header,
+        .pane-grid.layout-3x3 .pane-header {
+            padding: 2px 4px;
+            font-size: 10px;
+        }
+        .pane-grid.layout-2x3 .pane-title,
+        .pane-grid.layout-3x3 .pane-title {
+            overflow: hidden;
+            text-overflow: ellipsis;
+            white-space: nowrap;
+            min-width: 0;
+        }
```

### 6. `src/webview/terminals.js` — size the assignment array to the table maximum

`sanitizePaneAssignments()` pads to the *current* layout's slot count. With more layouts available it should pad to the table maximum so switching up to `3x3` finds real slots rather than growing the array mid-render:

```js
     function sanitizePaneAssignments() {
         const liveNames = new Set(fleetList.map(t => t.friendlyName));
-        const slotCount = getSlotCount(currentLayout);
-
-        paneAssignments = paneAssignments.slice(0, slotCount);
-        while (paneAssignments.length < slotCount) {
+        // Pad to the densest layout the table offers, not the current pick — the
+        // renderer already draws only the first getSlotCount(effectiveLayout) slots.
+        const slotCount = getMaxSlotCount();
+        while (paneAssignments.length < slotCount) {
             paneAssignments.push(null);
         }
+        if (paneAssignments.length > slotCount) { paneAssignments.length = slotCount; }
```

> **Superseded:** If the durability plan lands first, this hunk is already in place — reconcile rather than re-apply.
> **Reason:** Vague. The reconciled end-state is now pinned on both sides, so name it exactly.
> **Replaced with:** Reconciled end-state: the durability plan (lands first) introduces `const MAX_PANE_SLOTS = 9` and pads to it. **This plan's section-6 hunk is then exactly one substitution** — delete the constant, call `getMaxSlotCount()` — because the table this plan introduces becomes the single source of truth for slot counts. If this plan somehow lands first, apply the hunk as written and let the durability plan delete the slice/adopt `getMaxSlotCount()` the same way. Either way: one owner (the `LAYOUTS` table), no re-applied hunks.

## Verification Plan

**Build**
- *Session directive: no compilation step in this verification plan.* When the change is later built for manual verification, remember the running extension loads from `~/.<ide>/extensions/turnzero.switchboard-*/dist/`, not the repo `dist/` — sync the built webview assets there and reload the window.

**Manual — pane count**
3. Open the browser Terminals panel. Confirm the picker now shows six buttons: `1 2h 2v 2x2 2x3 3x3`.
4. Spawn 9 PTY terminals (sidebar `+`, or the per-worktree `+`). Confirm all 9 appear in the sidebar list.
5. Pick `3x3` in a maximised window. Confirm 9 panes render, and that clicking each sidebar entry fills a distinct pane until all 9 are assigned.
6. Confirm each of the 9 panes is independently live: type `echo pane-$RANDOM` in three different panes and confirm the output lands only in the pane typed into.

**Manual — responsive floor parity**
7. With `2x2` selected, narrow the window to ~450×280. Confirm it floors to `2h` and the fallback banner appears (pre-existing behaviour, must not regress).
8. With `2x2` selected, resize to ~380×400. Confirm it floors to `2v`.
9. With `3x3` selected, narrow to ~700×400. Confirm it floors to `2x2` (not to `1`), banner visible.
10. Restore to full size. Confirm it returns to `3x3` and the banner hides.
11. Collapse the panel (switch to another panel in the shell) and return. Confirm the layout is still `3x3` — i.e. the zero-box early return held and did not floor it to `1`.

**Manual — persistence**
12. Pick `2x3`, assign 6 terminals, reload the page. Confirm the layout and all 6 assignments restore.

**Manual — density / renderer**
13. At `3x3`, confirm pane headers are single-line and truncated, not wrapped, and that the terminal body still fills the pane.
14. Open devtools console at `3x3`. Confirm no `WebGL context lost` storm and no `WebGL renderer unavailable` spam; an occasional single fallback-to-canvas warning is acceptable, a per-pane cascade is not.
15. Close all 9 terminals from the sidebar. Confirm no leaked WebSocket connections in the devtools Network → WS tab and no `destroyTerminalView` errors.

**Regression**
16. Pick `1` and confirm single-pane behaviour is unchanged.
17. Confirm `POST /terminals/verb/ptyListTerminals` still returns the full fleet and the sidebar worktree grouping/count badges (`Na/Mx`) are correct with 9 terminals across two worktrees.

## Completion Report

Implemented single-source-of-truth `LAYOUTS` table and `LAYOUT_FLOOR_ORDER` supporting 6-slot (`2x3`) and 9-slot (`3x3`) layout options. Updated picker toolbar, validation sites, layout floor walk, assignment sizing, and added dense pane header styling in CSS. Files changed: `src/webview/terminals.js` and `src/webview/terminals.html`. No issues encountered during implementation.


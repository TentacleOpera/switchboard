# Fill Grid mode dropdown should default to 2x2 instead of mirroring current layout

## Goal

The FILL GRID form in the terminals panel (`terminals.html` / `terminals.js`) lets the operator pick a role and a grid layout, then spawns enough agents of that role to fill every pane. The mode `<select>` (`#fill-grid-mode`) is populated with all layout modes and then pre-selected to `currentLayout` — whatever layout is currently rendered on the pane grid.

When the active layout is `2x3` (a common choice for dense workflows), the fill grid form opens with `2x3` pre-selected, which creates **6 agents** and requires a window at least **750px wide × 300px tall**. This is too aggressive a default: on smaller screens the layout-floor logic silently downgrades the grid, and even on large screens spawning 6 terminals of one role is rarely the operator's first intent.

**Root cause:** `terminals.js` line 953 sets `fillGridMode.value = currentLayout`, coupling the fill-grid default to whatever layout the operator happens to be viewing — not to a sensible "fill a grid" starting point.

**Desired behavior:** The fill grid mode dropdown should default to `2x2` (4 panes, 500px × 300px minimum) — a grid that fits comfortably on the vast majority of screens and is a more reasonable starting quantity for batch-spawning a single role. The operator can still pick any other layout from the dropdown.

## Metadata

- **Complexity:** 2
- **Tags:** ui, ux, bugfix
- **Project:** Browser Switchboard

## User Review Required

No user review required. This is a non-destructive UX default change — the operator retains full dropdown control and can select any layout. No data, persistence, or security surface is affected.

## Complexity Audit

### Routine
- Single-line change to the default value of a `<select>` element (`terminals.js` line 953).
- No new state, no new API surface, no persistence changes (the fill-grid mode is read from the dropdown at submit time — it is not persisted independently).
- The layout-floor descent logic and `fillGrid()` function are untouched; only the pre-selection changes.
- Optional: one small source-text contract test following the established `src/test/` pattern.

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None. The `<option>` list is populated synchronously (lines 946–952) before `.value` is set (line 953), all within the same click handler. There is no async gap between population and selection. (Invariant: the populate-block must remain above the value-assignment line.)
- **Security:** None. No user input is trusted here; `'2x2'` is a hardcoded constant matching a `LAYOUTS` key.
- **Side Effects:** None beyond the intended UI change. `fillGrid()` is not called by this change — it only runs on form submit. The default only affects what the dropdown *shows* when the form opens.
- **Dependencies & Conflicts:**
  - **Current layout is `1` (single pane):** Previously the dropdown defaulted to `1`, which is not a "grid" at all — filling a single pane is just "open one terminal." Defaulting to `2x2` is strictly better here.
  - **Current layout is already `2x2`:** No change in behavior — the dropdown still shows `2x2`.
  - **Current layout is `3x3` or `2x3`:** The dropdown now shows `2x2` instead. The operator can still select the larger grid if desired. This is the intended improvement.
  - **Layout-floor interaction:** `fillGrid()` calls `setLayoutMode(mode)` (line 7419) which triggers `applyLayoutFloor()` (line 3958). If the window is too small for `2x2` (minW 500, minH 300), the floor descends to a smaller layout automatically — same behavior as if the operator manually picked `2x2` from the toolbar. No new edge case.
  - **Persistence:** The fill-grid mode selection is not persisted to settings — it is ephemeral, read from the dropdown each time the form opens. No migration needed.
  - **No confirm gate:** This change does not introduce any confirmation dialog (per project rules).
  - **Magic-string coupling:** `'2x2'` is a bare string literal matching a `LAYOUTS` key. If that key is ever renamed, `fillGridMode.value = '2x2'` would find no matching `<option>` and the browser would silently fall back to the first option (`'1'`). Risk is low — `LAYOUTS` keys are referenced by name throughout the floor logic, grow order, and persistence — but a named constant (`const DEFAULT_FILL_GRID_MODE = '2x2'`) co-located with `LAYOUTS` would make the coupling visible. Optional hardening; see Proposed Changes.

## Dependencies

- None. This is a standalone single-line change with no prerequisite plans or sessions.

## Adversarial Synthesis

Key risks: (1) magic-string coupling — a future `LAYOUTS` key rename would silently fall back to the `'1'` option with no error; (2) no automated test — the default is unpinned and could regress unnoticed. Mitigations: the `LAYOUTS` keys are stable and widely referenced (rename would break far more than this line), and an optional source-text contract test (matching the established `src/test/` pattern) can lock the default in. The core approach — hardcode `2x2`, rely on the existing `applyLayoutFloor()` safety net — is sound and correct.

## Proposed Changes

### `src/webview/terminals.js` — line 953

Change the fill-grid mode default from `currentLayout` to the hardcoded sensible default `'2x2'`.

**Context:** Inside the `btnFillGrid` click handler, the `<option>` list is populated from `LAYOUT_MODES` (lines 946–952), then the default is set (line 953). The populate-block MUST remain above the value-assignment — if reordered, the select silently falls back to the first option (`'1'`).

**Before:**
```js
                fillGridMode.value = currentLayout;
```

**After:**
```js
                // Default to 2x2 — a grid that fits most screens (500×300 min).
                // Mirroring currentLayout surfaced 2x3 (6 agents, 750px wide) too
                // often; 2x2 is a safer starting point the operator can grow from.
                fillGridMode.value = '2x2';
```

No other files need changes. The `#fill-grid-mode` `<select>` in `terminals.html` (line 2051) is populated dynamically by the JS and has no hardcoded `selected` attribute, so the HTML is unaffected.

**Optional hardening (Clarification, not a new requirement):** Introduce a named constant co-located with `LAYOUTS` (around line 1478) to make the coupling explicit and grep-able:
```js
const DEFAULT_FILL_GRID_MODE = '2x2';
```
Then reference it at line 953: `fillGridMode.value = DEFAULT_FILL_GRID_MODE;`. This protects against the silent-fallback regression if `LAYOUTS` keys are ever renamed.

### `src/test/terminal-fill-grid-default-contract.test.js` — new file (optional, recommended)

**Context:** The `src/test/` directory contains source-text contract tests that read `terminals.js` as text and assert on invariants (see `terminal-open-all-seating-contract.test.js` for the pattern). A contract test for this default prevents silent regression.

**Implementation:**
```js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'webview', 'terminals.js'), 'utf8');

let failed = 0;
function test(name, fn) {
    try { fn(); console.log(`  ✅ ${name}`); }
    catch (e) { failed++; console.error(`  ❌ ${name}\n     ${e.message}`); }
}

test('fill-grid mode default is 2x2, not currentLayout', () => {
    // Find the line that sets the fill-grid mode default.
    const m = SRC.match(/fillGridMode\.value\s*=\s*([^;]+);/);
    assert.ok(m, 'fillGridMode.value assignment not found');
    const rhs = m[1].trim();
    assert.ok(rhs.includes("'2x2'") || rhs.includes('"2x2"'),
        `fill-grid mode default should be '2x2', found: ${rhs}`);
    assert.ok(!rhs.includes('currentLayout'),
        `fill-grid mode default must not mirror currentLayout, found: ${rhs}`);
});

if (failed > 0) { process.exit(1); }
```

**Edge Cases:** The regex matches the first `fillGridMode.value =` assignment, which is the default-setting line. If a second assignment is added later, the test should be tightened to match the specific line context.

## Verification Plan

### Automated Tests

- **Contract test (optional, recommended):** Run `node src/test/terminal-fill-grid-default-contract.test.js` and confirm the fill-grid mode default assertion passes. This locks the default against silent regression.
- **Existing terminal contract tests:** Run the existing `src/test/terminal-*` suite to confirm no source-text invariant is broken by the line-953 change.

### Manual Verification

1. Open the terminals panel in a VS Code window.
2. Set the active layout to `2x3` (click the `2x3` button in the layout toolbar).
3. Click **FILL GRID** in the sidebar ops.
4. **Verify:** The mode dropdown shows `2x2 — 4 agents` as the pre-selected option (not `2x3 — 6 agents`).
5. Click **CANCEL** (no terminals spawned).
6. Set the active layout to `1` (single pane).
7. Click **FILL GRID** again.
8. **Verify:** The mode dropdown still shows `2x2 — 4 agents`.
9. Select a role, leave the mode at `2x2`, and click **FILL**.
10. **Verify:** Four terminals of the chosen role are created and seated in a 2×2 grid.
11. **Verify:** On a narrow window (under 500px wide), the layout-floor banner appears and the grid descends to a smaller layout — confirming the floor logic still works with the new default.

---

**Recommendation:** Complexity 2 → **Send to Intern**.

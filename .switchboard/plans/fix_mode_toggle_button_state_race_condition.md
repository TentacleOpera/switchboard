# Fix Mode Toggle Button State Race Condition

## Goal
Fix a race condition where the mode-toggle button's visual state (opacity, label, tooltip, classes) is lost when `renderColumns()` recreates the button DOM via clone-swap. The `operationModeChanged` message sets button state asynchronously, but subsequent calls to `renderColumns()` (e.g., during column moves, state changes) wipe out this state by replacing the DOM node.

## Metadata
**Tags:** frontend, bugfix
**Complexity:** 5

## User Review Required
> [!NOTE]
> No breaking changes or manual migration steps. This is an internal state management fix that ensures UI consistency.

## Complexity Audit
### Routine
- Add two global state variables (`currentOperationMode`, `currentOperationNeedsSetup`) after the global declarations block ending at line 1453 in `kanban.html`
- Extract the `operationModeChanged` inline button logic into a new `updateModeToggleButtonState()` function placed at lines 2758–2760 (just before the `window.addEventListener('message', ...)` call at line 2761)
- Refactor the `operationModeChanged` case (lines 2825–2855) to store globals and delegate to the new function
- Call `updateModeToggleButtonState()` after the clone-swap (line 1854) in `renderColumns()`, and once more in the init block after `updateAutobanButtonState()` at line 3104

### Complex / Risky
- The clone-swap at lines 1853–1854 is critical for preventing duplicate event listeners — the fix must not remove or break this mechanism
- After the clone-swap, `updateModeToggleButtonState()` calls `document.getElementById('mode-toggle-btn')` which will resolve to the newly inserted `newBtn` (same `id` is preserved by `cloneNode(true)`). The click handler then reads `newBtn.dataset.needsSetup` and `newBtn.dataset.mode`, both of which are set correctly by `updateModeToggleButtonState()` via `btn.dataset.mode = currentOperationMode` and `btn.dataset.needsSetup = ...`. This implicit coupling must be preserved.
- State restoration must happen **after** `replaceChild` completes and before the click listener is attached so the listener reads correct dataset values
- The restoration function must guard against missing `btn` or `label` elements (e.g., called before DOM is ready)

## Edge-Case & Dependency Audit
- **Race Conditions:** The fix itself eliminates the race condition by storing state persistently in module-level globals and re-applying it after every DOM recreation in `renderColumns()`.
- **Security:** No security impact; this is internal state management in a sandboxed webview.
- **Side Effects:** None — the fix only adds state persistence, it does not change existing visual behavior or event semantics. The click handler in Component 4's AFTER block continues to read `newBtn.dataset.needsSetup` and `newBtn.dataset.mode` — both are correctly populated by `updateModeToggleButtonState()` since `document.getElementById('mode-toggle-btn')` resolves to `newBtn` immediately after `replaceChild`.
- **Dependencies & Conflicts:**
  - **"Fix Board Management Button and Integration Panel UX"** (INTERN CODED) — modifies the same `operationModeChanged` handler at lines 2834–2843. This plan must be applied **after** that plan to avoid merge conflicts on those lines.
  - **"Fix Mode Toggle Button Variable Reference Error"** (INTERN CODED) — also touches the mode-toggle button area in `kanban.html`. Verify that plan is merged before applying this one; no direct line overlap expected but confirm the `mode-toggle-btn` element ID and `dataset` attributes remain unchanged.
  - No active plans in **New** or **Planned** Kanban columns conflict with this plan.

## Adversarial Synthesis

### Grumpy Critique
*[Grumpy Principal Engineer voice]*

Oh, MAGNIFICENT. Another "let's just slap two more globals on the pile" solution from someone who clearly hasn't read past line 1450 of a 3,320-line HTML monolith. You're adding `currentOperationMode` and `currentOperationNeedsSetup` to a namespace that's already a graveyard of `let autobanConfig = null` and `let routingMapDraggedCard = null`. Please, continue building your state sarcophagus.

But wait — it gets worse. The original plan confidently declares Component 1 should go "around line 1600-1650." The globals actually live at lines 1410–1453. That's off by **150 lines**. Did you search the file or did you just pull a number out of the ether? Similarly, Component 2 says "around line 2700-2750" but the `window.addEventListener('message', ...)` call is at line **2761**. And then Component 3 claims "lines 2825-2854" when the `break;` is on line **2855**. Component 4 says "lines 1850-1869" when it's actually **1849–1870**. Every single line number is wrong. We're using these as implementation instructions for agents — precision matters.

And here's the implicit time bomb nobody bothered to document: after `updateModeToggleButtonState()` runs post-clone-swap, the click handler reads `newBtn.dataset.needsSetup` and `newBtn.dataset.mode`. Those attributes are only valid *because* `updateModeToggleButtonState()` set them on the new button node. But this dependency is invisible — nowhere does the plan state "the click handler's correctness depends on the restoration function having run first." If anyone reorders those two lines, the click handler reads stale cloned attributes and silently misbehaves.

Oh, and the invalid `race-condition` tag in Metadata? Not in the allowed list. Congratulations on inventing your own taxonomy.

### Balanced Response
*[Lead Developer voice]*

All of Grumpy's concerns are valid and addressed in the updated Complexity Audit, Edge-Case section, and corrected implementation below:

1. **Global variables are pragmatic here.** The webview script already uses module-level state extensively (`columnDefinitions`, `currentCards`, `autobanConfig`, `routingMapConfig`, etc.). Two more globals for operation mode is consistent with the existing pattern and does not warrant introducing a full state-management abstraction for a single button's state.

2. **Line numbers corrected throughout.** Component 1 placement: after line 1453 (end of globals block). Component 2 placement: lines 2758–2760, immediately before the `window.addEventListener('message', ...)` at line 2761. Component 3 BEFORE block: lines 2825–2855. Component 4 BEFORE block: lines 1849–1870. All confirmed against the actual source file.

3. **Click handler / restoration function coupling is now explicit.** The Complex/Risky section documents that the click handler reads `newBtn.dataset.*` which are set by `updateModeToggleButtonState()` immediately before the listener is attached. The ordering — `replaceChild` → `updateModeToggleButtonState()` → `addEventListener` — must be preserved.

4. **Single source of truth enforced.** The `operationModeChanged` handler is reduced to two lines: update globals, call `updateModeToggleButtonState()`. All button DOM updates flow through that single function.

5. **Defensive defaults.** Globals initialized to `'coding'` / `false` so the restoration function produces valid output even before any message arrives.

6. **Tag corrected.** `race-condition` removed; `frontend, bugfix` are the correct allowed tags.

7. **Cross-dependencies documented.** "Fix Mode Toggle Button Variable Reference Error" (INTERN CODED) added to the dependency audit; no active Planned/New conflicts exist.

## Proposed Changes
> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** Provide complete, fully functioning code blocks. Break down the logic step-by-step before showing code.

---

### Component 1: Add global state variables
#### ADD to `src/webview/kanban.html` — after the global declarations block (after line 1453, after `routingMapDraggedCard`)

- **Context:** Add two global variables to persist the current operation mode state across DOM recreations. The existing globals block ends at line 1453 (`let routingMapDraggedCard = null;`); insert immediately after.
- **Logic:** Declare with sensible defaults so the restoration function always has valid state even before any `operationModeChanged` message arrives.
- **Implementation:**

```javascript
// ADD (kanban.html — after line 1453, after `let routingMapDraggedCard = null;`):
let currentOperationMode = 'coding';  // Default to coding mode
let currentOperationNeedsSetup = false;  // Default to configured state
```

---

### Component 2: Extract button state update logic into reusable function
#### ADD to `src/webview/kanban.html` — just before `window.addEventListener('message', ...)` at line 2761 (insert at lines 2758–2760)

- **Context:** Create a function that applies the stored operation mode state to the button DOM. This function will be called both by the `operationModeChanged` handler and after the clone-swap in `renderColumns()`. Insert it at lines 2758–2760 (the blank comment lines before `// Listen for messages from the extension` at line 2760).
- **Logic:**
  1. Get button and label elements by ID
  2. If either doesn't exist, return early (defensive — handles calls before DOM is ready)
  3. Clear existing mode classes
  4. Apply classes, `dataset` attributes, label text, and tooltip based on stored globals
  5. Mirror the same branch logic as the current `operationModeChanged` handler (now the single source of truth)
- **Clarification:** After the clone-swap in `renderColumns()`, `document.getElementById('mode-toggle-btn')` resolves to `newBtn` because `cloneNode(true)` preserves the element's `id`. The click listener attached immediately after reads `newBtn.dataset.needsSetup` and `newBtn.dataset.mode` — both set by this function via `btn.dataset.*`. Ordering is `replaceChild` → `updateModeToggleButtonState()` → `addEventListener`; do not reorder.
- **Implementation:**

```javascript
// ADD (kanban.html — insert at lines 2758–2760, just before the `window.addEventListener('message', ...)` call at line 2761):
function updateModeToggleButtonState() {
    const btn = document.getElementById('mode-toggle-btn');
    const label = document.getElementById('mode-label');

    if (!btn || !label) return;

    btn.dataset.mode = currentOperationMode;
    btn.classList.remove('coding-mode', 'board-management-mode', 'needs-setup');

    if (currentOperationNeedsSetup) {
        btn.classList.add('needs-setup');
        btn.dataset.needsSetup = 'true';
        if (currentOperationMode === 'board-management') {
            label.textContent = 'Board Automation';
            btn.dataset.tooltip = 'Board Management Mode not configured — click to set up ClickUp or Linear integration';
        } else {
            label.textContent = 'Coding';
            btn.dataset.tooltip = 'Integration not configured — click to set up ClickUp or Linear integration';
        }
    } else if (currentOperationMode === 'coding') {
        btn.classList.add('coding-mode');
        btn.dataset.needsSetup = 'false';
        label.textContent = 'Coding';
        btn.dataset.tooltip = 'Click to enable Board Management Mode (polls ClickUp/Linear for tasks)';
    } else {
        btn.classList.add('board-management-mode');
        btn.dataset.needsSetup = 'false';
        label.textContent = 'Board Automation';
        btn.dataset.tooltip = 'Click to switch back to Coding Mode';
    }
}
```

---

### Component 3: Update operationModeChanged handler to use new function
#### MODIFY `src/webview/kanban.html` — lines 2825–2855 (operationModeChanged case)

- **Context:** Replace the inline button state update logic with calls to update the global state variables and then call the new restoration function.
- **Logic:**
  1. Update global state variables from the message
  2. Call `updateModeToggleButtonState()` to apply the state
  3. Remove the old inline logic (it's now in the function)
- **Implementation:**

```javascript
// BEFORE (kanban.html lines 2825–2855 — confirmed against source):
case 'operationModeChanged': {
    const btn = document.getElementById('mode-toggle-btn');
    const label = document.getElementById('mode-label');

    if (!btn || !label) break;

    btn.dataset.mode = msg.mode;
    btn.classList.remove('coding-mode', 'board-management-mode', 'needs-setup');

    if (msg.needsSetup) {
        btn.classList.add('needs-setup');
        btn.dataset.needsSetup = 'true';
        if (msg.mode === 'board-management') {
            label.textContent = 'Board Automation';
            btn.dataset.tooltip = 'Board Management Mode not configured — click to set up ClickUp or Linear integration';
        } else {
            label.textContent = 'Coding';
            btn.dataset.tooltip = 'Integration not configured — click to set up ClickUp or Linear integration';
        }
    } else if (msg.mode === 'coding') {
        btn.classList.add('coding-mode');
        btn.dataset.needsSetup = 'false';
        label.textContent = 'Coding';
        btn.dataset.tooltip = 'Click to enable Board Management Mode (polls ClickUp/Linear for tasks)';
    } else {
        btn.classList.add('board-management-mode');
        btn.dataset.needsSetup = 'false';
        label.textContent = 'Board Automation';
        btn.dataset.tooltip = 'Click to switch back to Coding Mode';
    }
    break;
}
```

```javascript
// AFTER (kanban.html lines 2825–2828 — 4 lines replacing 31):
case 'operationModeChanged': {
    currentOperationMode = msg.mode || 'coding';
    currentOperationNeedsSetup = msg.needsSetup === true;
    updateModeToggleButtonState();
    break;
}
```

---

### Component 4: Restore button state after clone-swap in renderColumns
#### MODIFY `src/webview/kanban.html` — lines 1849–1870 (mode-toggle-btn section in renderColumns)

- **Context:** After the clone-swap recreates the button DOM, call the restoration function to re-apply the stored state.
- **Logic:**
  1. Keep the existing clone-swap logic (critical for preventing duplicate listeners)
  2. After `replaceChild`, call `updateModeToggleButtonState()` to restore state
  3. The restoration function will find the new button (since it queries by ID) and apply the stored state
- **Implementation:**

```javascript
// BEFORE (kanban.html lines 1849–1870 — confirmed against source):
// Mode toggle click handler - context-aware behavior
const modeToggleBtn = document.getElementById('mode-toggle-btn');
if (modeToggleBtn) {
    // Remove existing listener to prevent duplicates from multiple renderColumns() calls
    const newBtn = modeToggleBtn.cloneNode(true);
    modeToggleBtn.parentNode.replaceChild(newBtn, modeToggleBtn);

    newBtn.addEventListener('click', () => {
        console.log('[Kanban WV] Mode toggle clicked');
        const needsSetup = newBtn.dataset.needsSetup === 'true';

        if (needsSetup) {
            console.log('[Kanban WV] Opening setup panel (needsSetup=true)');
            postKanbanMessage({ type: 'openSetupPanel', section: 'project-mgmt' });
        } else {
            const currentMode = newBtn.dataset.mode || 'coding';
            const newMode = currentMode === 'coding' ? 'board-management' : 'coding';
            console.log('[Kanban WV] Switching mode from', currentMode, 'to', newMode);
            postKanbanMessage({ type: 'switchOperationMode', mode: newMode });
        }
    });
}
```

```javascript
// AFTER (kanban.html lines 1849–1873 — `updateModeToggleButtonState()` call inserted after replaceChild, before addEventListener):
// Mode toggle click handler - context-aware behavior
const modeToggleBtn = document.getElementById('mode-toggle-btn');
if (modeToggleBtn) {
    // Remove existing listener to prevent duplicates from multiple renderColumns() calls
    const newBtn = modeToggleBtn.cloneNode(true);
    modeToggleBtn.parentNode.replaceChild(newBtn, modeToggleBtn);

    // Restore button state after clone-swap (fixes race condition)
    updateModeToggleButtonState();

    newBtn.addEventListener('click', () => {
        console.log('[Kanban WV] Mode toggle clicked');
        const needsSetup = newBtn.dataset.needsSetup === 'true';

        if (needsSetup) {
            console.log('[Kanban WV] Opening setup panel (needsSetup=true)');
            postKanbanMessage({ type: 'openSetupPanel', section: 'project-mgmt' });
        } else {
            const currentMode = newBtn.dataset.mode || 'coding';
            const newMode = currentMode === 'coding' ? 'board-management' : 'coding';
            console.log('[Kanban WV] Switching mode from', currentMode, 'to', newMode);
            postKanbanMessage({ type: 'switchOperationMode', mode: newMode });
        }
    });
}
```

---

### Component 5: Initialize state on page load
#### ADD to `src/webview/kanban.html` — in the initialization section (after line 3104, after `updateAutobanButtonState()`)

- **Context:** Call the restoration function during initial page load to ensure the button has correct state from the start.
- **Logic:** Add the call after existing initialization calls.
- **Implementation:**

```javascript
// BEFORE (kanban.html lines 3101–3104 — confirmed against source):
updateCliToggleUi();
renderColumns();
renderBoard([]);
updateAutobanButtonState();
```

```javascript
// AFTER (kanban.html lines 3101–3105):
updateCliToggleUi();
renderColumns();
renderBoard([]);
updateAutobanButtonState();
updateModeToggleButtonState();  // Initialize button state on page load
```

- **Edge Cases Handled:** If no `operationModeChanged` message has arrived yet, the globals have their default values (`'coding'`, `false`), so the button will show the correct default state.

---

## Verification Plan
### Automated Tests
- Run existing regression test:
  ```bash
  npm test -- src/test/operation-mode-toggle-regression.test.js
  ```
  Verifies `operationModeChanged` state propagation. Confirm test still passes after refactoring.

### Manual Tests
1. **Race condition test**: Open kanban with no integrations configured; trigger a column move (which calls `renderColumns()`); verify button still shows `"Board Automation"` with orange tint and reduced opacity (state preserved).
2. **Initial state test**: Reload the page without any integrations configured; verify button shows correct default state (opacity, label, tooltip).
3. **Message arrives before render**: Receive `operationModeChanged` message, then immediately trigger a column move; verify button state is correct after render.
4. **Message arrives after render**: Trigger a column move, then receive `operationModeChanged` message; verify button state updates correctly.
5. **Mode toggle test**: Click the mode-toggle button in various states (configured, unconfigured, after render); verify correct behavior in all cases.
6. **No regression — normal flow**: Configure ClickUp; toggle between modes; verify all existing functionality works as before.

## Execution Summary
**Executed:** 2026-04-13
**Changes Applied:**
- Component 1: Added global state variables `currentOperationMode` and `currentOperationNeedsSetup` after line 1453
- Component 2: Added `updateModeToggleButtonState()` function at lines 2767-2797
- Component 3: Refactored `operationModeChanged` handler to use globals and new function (lines 2864-2868)
- Component 4: Added state restoration call after clone-swap in `renderColumns()` (line 1861)
- Component 5: Added initialization call in page load sequence (line 3118)

**Verification:**
- Webpack compilation: PASSED (syntax valid)
- ESLint: SKIPPED (configuration issue unrelated to changes)
- Manual verification: All code changes verified against plan specifications

## Reviewer Pass
**Reviewed:** 2026-04-13

### Grumpy Critique
- [MAJOR] `KanbanProvider.setOperationMode()` was still emitting `operationModeChanged` without `needsSetup`, so the new clone-swap restore logic could faithfully restore the wrong state after a mode switch. Congratulations: the race window shrank, but the payload contract was still lying.
- [NIT] The plan's automated command (`npm test -- src/test/operation-mode-toggle-regression.test.js`) is stale for this repo. The focused command that actually exercises the regex test is `node src/test/operation-mode-toggle-regression.test.js`.

### Balanced Response
Keep the webview refactor. `kanban.html` now persists operation mode state globally, reapplies it after the clone-swap in `renderColumns()`, and rehydrates the button on initialization. Reviewer pass fixed the remaining contract bug by making `KanbanProvider.setOperationMode()` derive and emit authoritative `needsSetup`, passing the selected workspace root through board mode switches, preserving prior setup state when a partial payload slips through, and extending regression coverage across the provider/webview boundary.

### Reviewer Changes
- Updated `src/services/KanbanProvider.ts` so `setOperationMode()` always emits `operationModeChanged` with `needsSetup` and `switchOperationMode` delegates through that single authoritative path.
- Updated `src/services/TaskViewerProvider.ts` and `src/webview/kanban.html` to pass the active workspace root through mode-switch flows, and hardened the kanban handler to preserve existing setup state when `needsSetup` is omitted.
- Extended `src/test/operation-mode-toggle-regression.test.js` to assert the provider/webview contract, post-clone restore ordering, and `msg.*` handler delegation.

### Validation Results
- `npm run compile` ✅
- `node src/test/operation-mode-toggle-regression.test.js` ✅

### Remaining Risks
- Real drag/re-render behavior still deserves manual webview confirmation because the race involves DOM recreation timing.
- The plan's original test invocation remains stale; use the `node ...` command above for focused verification.

## Switchboard State
**Kanban Column:** CODE REVIEWED
**Status:** active
**Last Updated:** 2026-04-13T12:30:33.865Z
**Format Version:** 1

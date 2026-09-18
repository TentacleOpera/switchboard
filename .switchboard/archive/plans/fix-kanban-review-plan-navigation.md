# Fix Kanban "Review Plan" Button Navigation to Kanban Tab

## Goal

When a user clicks the **Review Plan** button on a kanban card in `kanban.html`, the Planning Panel (`planning.html`) must open/reveal and **reliably navigate to the Kanban Plans tab**, scroll the target plan into view, and select it — regardless of which tab was previously active in the Planning Panel.

### Problem Analysis

#### Root Cause
The message handler for `activateKanbanTabAndSelectPlan` in `src/webview/planning.js` calls `activateKanbanTab()` at line 3212, but **this function is never defined anywhere in the file**.

```js
// @/src/webview/planning.js:3210-3212
case 'activateKanbanTabAndSelectPlan': {
    _pendingKanbanSelection = { sessionId: msg.sessionId, planFile: msg.planFile, workspaceRoot: msg.workspaceRoot };
    activateKanbanTab(); // ❌ ReferenceError: activateKanbanTab is not defined
    // ... rest of handler never executes
}
```

This throws a `ReferenceError` in the webview, which:
1. Halts execution of the message handler before it reaches the `_pendingKanbanSelection` cache check.
2. Never triggers the `fetchKanbanPlans` request needed to populate the list.
3. Never resolves the pending selection in `handleKanbanPlansReady()`.
4. The Planning Panel simply reveals at whatever tab was previously active (local, research, tickets, etc).

#### Secondary Issue
The existing tab-switching logic is duplicated: the click handler for `.research-tab-btn` already contains all the logic for switching tabs, cleaning up edit/review modes, and fetching plans when entering the kanban tab. There is no reusable `switchToTab(tabName)` or `activateKanbanTab()` abstraction, so every navigation path must manually replicate this logic.

#### Tertiary Issue — Inconsistent Match Logic
The plan-matching logic differs between the two call sites:
- **Message handler** (line 3215-3217): matches on `sessionId || planFile`
- **`handleKanbanPlansReady`** (line 4599-4602): matches on `sessionId || planFile || (workspaceRoot && sessionId)`

These can resolve to **different plans** if sessionId matches plan A but planFile matches plan B, creating a race condition where immediate selection picks A but deferred selection picks B.

#### Quaternary Issue — Redundant Double Fetch
After the extraction, `switchToTab('kanban')` will fire `fetchKanbanPlans` (line 319). The existing code at line 3229 fires it AGAIN. Two round-trips to the extension host, two `handleKanbanPlansReady` calls, two DOM re-renders. The second render can wipe the selection made by the first if `_pendingKanbanSelection` is already null.

## Metadata
- **Tags:** frontend, bugfix, ui
- **Complexity:** 4

## User Review Required
- Confirm that the match logic should be unified (see Step 1.5 below). Currently the two matchers use different criteria; the unified version uses `sessionId` as primary key with `planFile` as fallback.
- Confirm that the redundant `fetchKanbanPlans` at line 3229 should be removed after extraction.

## Complexity Audit

### Routine
- Extract tab-switching logic into a standalone function (mechanical refactoring)
- Replace undefined `activateKanbanTab()` call with `switchToTab('kanban')`
- Move `_pendingKanbanSelection = null` inside the `if (match)` block
- Add stale-selection cleanup on non-kanban tab switch

### Complex / Risky
- Unifying match logic across two call sites (subtle — different match criteria could change which plan is selected)
- Double-fetch removal (must verify that `switchToTab('kanban')` always fires the fetch so the redundant one is truly unnecessary)

## Edge-Case & Dependency Audit

- **Race Conditions**: If `fetchKanbanPlans` response arrives before the immediate cache check runs (unlikely in single-threaded JS but possible if the cache is empty and the response is cached by the extension host), the deferred match in `handleKanbanPlansReady` handles it. With Option B (null inside `if (match)`), the pending selection persists until resolved.
- **Security**: No security implications — all data is local, no user input is interpolated into DOM without escaping.
- **Side Effects**: `switchToTab` calls `exitEditMode` and `exitReviewMode` which modify global state (`state.dirtyFlags`, `state.editMode`, `state.reviewMode`). These are intentional and match existing click handler behavior.
- **Dependencies & Conflicts**: `switchToTab` depends on `tabButtons`, `tabContents`, `state`, `exitEditMode`, `exitReviewMode`, `applySidebarState`, `vscode`, `ticketsInitialized`, `initTicketsTab`, `restoreTicketsState`, `saveTicketsState`, `lastIntegrationProvider`, `ticketsLoadedOnce`, `loadClickUpSpaces`, `loadLinearProject`. All are in scope at the placement point (line ~268). No conflicts with other pending changes.

## Dependencies
- None

## Adversarial Synthesis
Key risks: inconsistent match logic between immediate and deferred selection can cause wrong plan to be selected; redundant double-fetch can wipe selection state on second render; stale `_pendingKanbanSelection` can persist indefinitely if plan is deleted. Mitigations: unify match logic into shared helper, remove redundant fetch, add cleanup on tab switch away from kanban.

## Proposed Changes

### `src/webview/planning.js`

#### Step 1: Extract `switchToTab(tabName)` function (insert before line 272)

Place this function definition before the `tabButtons.forEach(...)` block (around line 268) so it is in scope for both the click handler and the message handler.

```js
function switchToTab(tabName) {
    // 1. Clean up dirty flags and edit/review modes (same logic as click handler)
    if (state.dirtyFlags.local && tabName !== 'local') { exitEditMode('local', true); }
    if (state.dirtyFlags.kanban && tabName !== 'kanban') { exitEditMode('kanban', true); }
    if (state.dirtyFlags.design && tabName !== 'design') { exitEditMode('design', true); }
    if (state.editMode.local && tabName !== 'local') { exitEditMode('local', true); }
    if (state.editMode.kanban && tabName !== 'kanban') { exitEditMode('kanban', true); }
    if (state.editMode.design && tabName !== 'design') { exitEditMode('design', true); }
    if (state.reviewMode.kanban && tabName !== 'kanban') { exitReviewMode('kanban', true); }

    // 2. Clear stale pending selection when navigating away from kanban
    if (tabName !== 'kanban' && _pendingKanbanSelection) {
        _pendingKanbanSelection = null;
    }

    // 3. Update active classes
    tabButtons.forEach(b => b.classList.remove('active'));
    tabContents.forEach(c => c.classList.remove('active'));
    const targetBtn = document.querySelector(`.research-tab-btn[data-tab="${tabName}"]`);
    if (targetBtn) targetBtn.classList.add('active');
    const targetContent = document.getElementById(`${tabName}-content`);
    if (targetContent) targetContent.classList.add('active');

    // 4. Apply sidebar state
    if (tabName === 'html-preview') { applySidebarState('html-preview', state.htmlPreviewCollapsed); }
    else if (tabName === 'design') { applySidebarState('design', state.designPreviewCollapsed); }
    else if (tabName === 'tickets') { applySidebarState('tickets', state.ticketsPreviewCollapsed); }
    else if (tabName === 'local' || tabName === 'research' || tabName === 'online') {
        applySidebarState(tabName, state.docsListCollapsed);
    }

    // 5. Tab-specific initialization
    if (tabName === 'kanban') {
        vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
    }
    if (tabName === 'tickets') {
        if (!ticketsInitialized) { initTicketsTab(); ticketsInitialized = true; }
        restoreTicketsState();
        if (lastIntegrationProvider && !ticketsLoadedOnce) {
            if (lastIntegrationProvider === 'clickup') loadClickUpSpaces();
            else loadLinearProject();
        }
    } else {
        if (ticketsInitialized) { saveTicketsState(); }
    }
}
```

**Clarification**: The kanban tab has no sidebar collapse state, so no `applySidebarState` call is needed for `tabName === 'kanban'`. This matches the existing click handler behavior.

#### Step 1.5: Extract `findPendingKanbanMatch()` helper (insert near `_pendingKanbanSelection` declaration, around line 4006)

Unify the inconsistent match logic into a single function used by both the message handler and `handleKanbanPlansReady`:

```js
function findPendingKanbanMatch(cache) {
    if (!_pendingKanbanSelection || !cache || !cache.length) return null;
    const { sessionId, planFile, workspaceRoot } = _pendingKanbanSelection;
    // Primary match: sessionId (most specific identifier)
    if (sessionId) {
        const bySession = cache.find(p => p.sessionId === sessionId);
        if (bySession) return bySession;
    }
    // Fallback match: planFile
    if (planFile) {
        const byFile = cache.find(p => p.planFile === planFile);
        if (byFile) return byFile;
    }
    // Last resort: workspaceRoot + sessionId compound
    if (workspaceRoot && sessionId) {
        const byCompound = cache.find(p => p.workspaceRoot === workspaceRoot && p.sessionId === sessionId);
        if (byCompound) return byCompound;
    }
    return null;
}
```

This replaces the inline `.find()` calls at lines 3215-3217 and 4599-4602 with a single, deterministic match strategy: sessionId first, planFile second, compound third. No more `||` short-circuiting that could match the wrong plan.

#### Step 2: Refactor the click handler to call `switchToTab` (replace lines 273-340)

Replace the body of the `.research-tab-btn` click handler with a single call:

```js
tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        switchToTab(btn.dataset.tab);
    });
});
```

#### Step 3: Replace the undefined `activateKanbanTab()` call and remove redundant fetch (lines 3210-3231)

Replace the `activateKanbanTabAndSelectPlan` handler:

```js
case 'activateKanbanTabAndSelectPlan': {
    _pendingKanbanSelection = { sessionId: msg.sessionId, planFile: msg.planFile, workspaceRoot: msg.workspaceRoot };
    switchToTab('kanban');
    // Check already-loaded cache for immediate selection
    const immediateMatch = findPendingKanbanMatch(_kanbanPlansCache);
    if (immediateMatch) {
        const itemDiv = kanbanListPane && kanbanListPane.querySelector(`.kanban-plan-item[data-plan-id="${immediateMatch.planId}"]`);
        if (itemDiv) {
            itemDiv.scrollIntoView({ behavior: 'smooth', block: 'center' });
            itemDiv.click();
            _pendingKanbanSelection = null;
        }
    }
    // No redundant fetch — switchToTab('kanban') already fired fetchKanbanPlans.
    // Pending selection will be resolved in handleKanbanPlansReady if not matched immediately.
    break;
}
```

**Key changes from original:**
- `activateKanbanTab()` → `switchToTab('kanban')` (fixes ReferenceError)
- Inline `.find()` → `findPendingKanbanMatch()` (unified match logic)
- Removed `vscode.postMessage({ type: 'fetchKanbanPlans', ... })` at line 3229 (redundant — `switchToTab` already fires it)

#### Step 4: Update `handleKanbanPlansReady` to use unified match and Option B null assignment (lines 4597-4612)

Replace the pending selection resolution block:

```js
// Resolve pending selection (e.g. from kanban board Review button)
if (_pendingKanbanSelection) {
    const match = findPendingKanbanMatch(_kanbanPlansCache);
    if (match) {
        const itemDiv = kanbanListPane.querySelector(`.kanban-plan-item[data-plan-id="${match.planId}"]`);
        if (itemDiv) {
            itemDiv.scrollIntoView({ behavior: 'smooth', block: 'center' });
            itemDiv.click();
        }
        _pendingKanbanSelection = null;  // Option B: only clear on successful match
    }
    // If no match, _pendingKanbanSelection persists for next fetch cycle
}
```

**Key changes:**
- Inline `.find()` → `findPendingKanbanMatch()` (unified match logic)
- `_pendingKanbanSelection = null` moved inside `if (match)` block (Option B — prevents stale selection loss on slow loads)

## Verification Plan

### Automated Tests
- N/A — this is a webview UI fix with no automated test infrastructure for webview message handlers. Verification is manual.

### Manual Verification
1. **Primary flow**: Open Planning Panel → switch to Local tab → click Review Plan on a kanban card.
   - Expected: Planning Panel reveals, switches to Kanban tab, plan list loads, target plan is scrolled into view and selected.
2. **Idempotent flow**: Repeat with Planning Panel already on Kanban tab but with a different plan selected.
   - Expected: Same plan is re-selected and scrolled into view.
3. **Dirty state**: Enter edit mode in Local tab (dirty flag set) → click Review Plan.
   - Expected: Edit mode is exited cleanly, Kanban tab opens.
4. **Review mode**: Enter kanban review mode → click Review Plan on a different card.
   - Expected: Review mode exits, new plan is selected.
5. **Deleted plan**: Click Review Plan for a plan that was just deleted.
   - Expected: Kanban tab opens, plan list refreshes, no crash. Selection remains empty. `_pendingKanbanSelection` is cleared by the next tab switch (stale cleanup in `switchToTab`).
6. **Tab switch cleanup**: Click Review Plan → immediately switch to Local tab before fetch completes → switch back to Kanban.
   - Expected: No stale selection from the original Review click. `_pendingKanbanSelection` was cleared when switching away from kanban.

## Files Changed

- `src/webview/planning.js`

## Risks

- **Low**. The fix is a straightforward extraction and call replacement. No backend or API changes. The only risk is a subtle difference in tab-switching behavior if the extraction misses a side effect (e.g., `saveTicketsState()` being called when leaving a non-tickets tab). Careful 1:1 mapping of the click handler body into `switchToTab` mitigates this.

## Estimated Effort

- ~30 minutes to implement and test.

## Recommendation

- Complexity 4 → **Send to Coder**

## Review Findings

Implementation matches plan. All four steps executed correctly: `switchToTab` extracted, `findPendingKanbanMatch` unified match logic, click handler refactored, `activateKanbanTabAndSelectPlan` handler fixed with redundant fetch removed. One fix applied during review: added null-safety guard on `kanbanListPane` at `handleKanbanPlansReady` (line 4957) to match the guard in the immediate-match path. Syntax check passed. Known dead code: the compound-match branch in `findPendingKanbanMatch` (workspaceRoot+sessionId) is unreachable since sessionId already failed in the primary match — harmless, deferred.

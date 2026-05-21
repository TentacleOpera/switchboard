# Fix Assign to Workspace Button Cross-Workspace Bug

## Goal
Fix the "ASSIGN TO WORKSPACE" button failing silently when cards are selected in one workspace and the user switches to another workspace before clicking the button, by ensuring `selectedCards` always stores sessionIds and all code paths consistently use sessionId-first priority.

## Metadata
- **Tags:** [bugfix, frontend]
- **Complexity:** 4

## User Review Required
- Confirm that changing `selectedCards` to store sessionIds (instead of planIds) is acceptable — this is a semantic change to the Set's contents that affects all selection-related code paths.
- Verify that cards in this deployment always have a `sessionId` populated (i.e., `data-session` is never empty when `data-plan-id` is set).

## Problem
The "ASSIGN TO WORKSPACE" button in kanban.html does not work when:
1. User selects a card in one workspace
2. Switches to another workspace via the dropdown
3. Presses the button
4. Nothing happens

## Root Cause
The button click handler (lines 5004-5037) retrieves sessionIds by querying the DOM for card elements:
```javascript
const sessionIds = Array.from(selectedCards).map(pid => {
    const cardEl = document.querySelector(`.kanban-card[data-plan-id="${pid}"], .kanban-card[data-session="${pid}"]`);
    return cardEl ? (cardEl.dataset.session || cardEl.dataset.planId || pid) : pid;
});
```

When the workspace is switched, the board re-renders with cards from the new workspace. The card elements from the previous workspace are removed from the DOM, so `document.querySelector` returns null. The fallback returns `pid`, which may be a planId rather than a sessionId. The backend expects sessionIds to look up plans via `getPlanBySessionId`, so the operation fails silently.

**Additional latent bug**: The card click handler (line 3774) and `getSelectedInColumn` (line 3159) both use `el.dataset.planId || el.dataset.session` — storing planIds in `selectedCards` and sending them as `sessionIds` to the backend. This works by coincidence when planId === sessionId, but is incorrect when they differ.

## Complexity Audit

### Routine
- Swapping `el.dataset.planId || el.dataset.session` to `el.dataset.session || el.dataset.planId` across 6 locations — mechanical, same pattern each time
- Simplifying the reassign handler's DOM lookup to `Array.from(selectedCards)` — removes dead code
- All changes are in a single file (`kanban.html`)

### Complex / Risky
- Changing the semantic meaning of `selectedCards` (from planIds to sessionIds) affects all code paths that read from or write to the Set — missing any location causes silent mismatches (e.g., `selectedCards.delete(id)` failing, ghost selections accumulating)
- Column operations (`moveSelected`, `promptSelected`, etc.) currently send planIds as `sessionIds` — this change fixes that latent bug but means the backend will now receive actual sessionIds, which could surface issues if any backend handler assumed the old behavior

## Edge-Case & Dependency Audit

- **Race Conditions**: None — the fix is synchronous and the `selectedCards` Set is only accessed from the main thread.
- **Security**: No impact — no auth or data exposure changes.
- **Side Effects**: Column operations (`moveSelected`, `promptSelected`, `julesSelected`, `completeSelected`, etc.) will now send actual sessionIds instead of planIds. The backend handlers all call `db.getPlanBySessionId()` so this is correct, but it's a behavioral change that should be verified.
- **Dependencies & Conflicts**: The drag handler (line 4163) uses `draggedId` to check `selectedCards.has(draggedId)` — must also use sessionId-first priority or multi-card drag will break.

## Dependencies
- None

## Adversarial Synthesis
Key risks: incomplete scope (missing 4 of 6 locations that need the sessionId-first swap), ghost selections from `selectedCards.delete()` mismatches, and latent planId-as-sessionId bug in column operations now being fixed which changes backend input. Mitigations: the fix is a uniform mechanical pattern swap across all 6 locations, and the backend already expects sessionIds so the change aligns frontend with backend contract.

## Solution
Modify all code paths to consistently store and use sessionId (not planId) in the `selectedCards` Set, and use the stored values directly in the reassign handler instead of querying the DOM.

### Changes Required

**File: `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html`**

1. **Update `getSelectedInColumn` (line 3159)** to return sessionId-first:
   - Change from: `ids.push(el.dataset.planId || el.dataset.session || '');`
   - Change to: `ids.push(el.dataset.session || el.dataset.planId || '');`
   - This fixes column operations sending planIds as sessionIds, and ensures `selectedCards.delete(id)` matches

2. **Update `getSelectedInRenderedContainer` (line 3169)** to return sessionId-first:
   - Change from: `.map(el => el.dataset.planId || el.dataset.session || '')`
   - Change to: `.map(el => el.dataset.session || el.dataset.planId || '')`
   - Same rationale as above

3. **Update card selection handler (line 3774)** to always store sessionId:
   - Change from: `const pid = el.dataset.planId || el.dataset.session || '';`
   - Change to: `const pid = el.dataset.session || el.dataset.planId || '';`
   - This prioritizes sessionId over planId when storing in selectedCards

4. **Update re-apply selection state after re-render (line 3791)** to match:
   - Change from: `const pid = el.dataset.planId || el.dataset.session || '';`
   - Change to: `const pid = el.dataset.session || el.dataset.planId || '';`
   - Must match the sessionId-first storage in selectedCards or re-selection after board refresh will fail

5. **Update drag handler (line 4163)** to use sessionId-first:
   - Change from: `const draggedId = draggedCardEl?.dataset.planId || draggedCardEl?.dataset.session;`
   - Change to: `const draggedId = draggedCardEl?.dataset.session || draggedCardEl?.dataset.planId;`
   - Required for `selectedCards.has(draggedId)` at line 4171 to match

6. **Update reassign button handler (lines 5005-5008)** to use selectedCards values directly:
   - Remove the DOM query and fallback logic
   - Change from:
     ```javascript
     const sessionIds = Array.from(selectedCards).map(pid => {
         const cardEl = document.querySelector(`.kanban-card[data-plan-id="${pid}"], .kanban-card[data-session="${pid}"]`);
         return cardEl ? (cardEl.dataset.session || cardEl.dataset.planId || pid) : pid;
     });
     ```
   - Change to:
     ```javascript
     const sessionIds = Array.from(selectedCards);
     ```
   - Since selectedCards now stores sessionIds, no DOM lookup is needed

## Verification Plan

### Automated Tests
- No automated test infrastructure exists for the webview UI. Manual verification required.

### Manual Verification
1. **Cross-workspace reassign (primary bug)**:
   - Select a card in workspace A
   - Switch to workspace B
   - Click "ASSIGN TO WORKSPACE" button
   - Confirm dialog should appear
   - Plan should be reassigned to workspace B
   - Plan should disappear from workspace A board and appear in workspace B board

2. **Column operations (regression)**:
   - Select cards in a column
   - Use column action menu (Move Selected, Prompt Selected, etc.)
   - Verify operations succeed and cards are removed from `selectedCards` (no ghost selections)

3. **Multi-card drag (regression)**:
   - Select multiple cards via shift/cmd+click
   - Drag one of the selected cards to another column
   - Verify all selected cards move together

4. **Single-workspace reassign (regression)**:
   - Select cards in current workspace
   - Click "ASSIGN TO WORKSPACE" without switching
   - Verify reassign still works correctly

## Files Changed
- `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html`

## Recommendation
Complexity 4 → **Send to Coder**

---

## Review Pass — Completed

### Reviewer: Grumpy Principal Engineer (inline adversarial review)
### Date: 2026-05-21

### Implementation Verification (All 6 Changes)

| # | Change | Plan Line | Actual Line | Status |
|---|--------|-----------|-------------|--------|
| 1 | `getSelectedInColumn` sessionId-first | 3159 | 3181 | ✅ DONE — `ids.push(el.dataset.session \|\| el.dataset.planId \|\| '');` |
| 2 | `getSelectedInRenderedContainer` sessionId-first | 3169 | 3191 | ✅ DONE — `.map(el => el.dataset.session \|\| el.dataset.planId \|\| '')` |
| 3 | Card selection handler sessionId-first | 3774 | 3796 | ✅ DONE — `const pid = el.dataset.session \|\| el.dataset.planId \|\| '';` |
| 4 | Re-apply selection state sessionId-first | 3791 | 3816 | ✅ DONE — `const pid = el.dataset.session \|\| el.dataset.planId \|\| '';` |
| 5 | Drag handler sessionId-first | 4163 | 4188 | ✅ DONE — `const draggedId = draggedCardEl?.dataset.session \|\| draggedCardEl?.dataset.planId;` |
| 6 | Reassign handler uses selectedCards directly | 5005-5008 | 5066-5067 | ✅ DONE — `const sessionIds = Array.from(selectedCards);` |

### Consistency Audit

- **`selectedCards` Set semantics**: Now stores sessionIds consistently across all write paths (card click, re-apply selection). All read paths (`has`, `delete`, `Array.from`) match. ✅
- **`selectedCards.delete(id)` paths (7 locations)**: All fed by `getSelectedInColumn()` which returns sessionIds. Match confirmed. ✅
- **`selectedCards.has(draggedId)` at line 4196**: `draggedId` is sessionId-first. Match confirmed. ✅
- **Backend contract**: `reassignPlansWorkspace` handler (KanbanProvider.ts:3917) calls `db.getPlanBySessionId(sessionId)`. All 19 backend uses of `getPlanBySessionId` confirm sessionIds are expected. Frontend now sends sessionIds. ✅
- **Workspace switch does NOT clear `selectedCards`**: Verified — switch handler (line 5098-5107) sends `selectWorkspace` message only. Board re-render calls `updateReassignButtonVisibility()` which reads `selectedCards.size`. Cross-workspace reassign flow works as designed. ✅
- **Drag visual feedback (line 4204-4207)**: Queries by `data-session` with sessionIds. Match confirmed. ✅
- **Drop handler (line 4288)**: `currentCards.find(c => c.sessionId === id)` looks up by sessionId. Match confirmed. ✅
- **Old pattern elimination**: Zero instances of `dataset.planId || dataset.session` (wrong order) remain in DOM read paths. ✅

### Findings

| # | Severity | Finding | Verdict |
|---|----------|---------|---------|
| 1 | NIT | Variable `pid` at lines 3796/3816 is semantically misleading — stores sessionId, not planId | **Defer** — Renaming cascades through 20+ references; not worth risk in bugfix PR |
| 2 | NIT | `data-plan-id` attribute in HTML generation (line 4035) still uses `planId \|\| sessionId` priority | **Defer** — Attribute only used as fallback; selection paths read `data-session` first |
| 3 | NIT | After workspace switch, no visual indication of which cards are selected from old workspace | **Defer** — UX enhancement, not a bug; button count is sufficient per plan spec |

**No CRITICAL or MAJOR findings.** No code fixes required.

### Validation Results

- **Webpack build**: `compiled successfully` — no errors, no warnings related to changes
- **ESLint**: Not configured for this project (no `eslint.config.js`)
- **Old pattern search**: Zero remaining instances of `dataset.planId || dataset.session` in DOM read paths
- **TypeScript**: Changes are in inline JavaScript within HTML; no TS type checking applicable

### Remaining Risks

1. **Cards without sessionId**: If any card in the deployment has `data-session=""` but `data-plan-id` set, the fallback to `data-plan-id` will store a planId in `selectedCards`. This is the correct degradation behavior but means the latent bug could resurface for such cards. The plan's "User Review Required" item #2 addresses this.
2. **Backend behavioral change**: Column operations now send actual sessionIds instead of planIds-as-sessionIds. If any backend handler relied on receiving planIds (despite calling `getPlanBySessionId`), this could surface issues. Verified that all 19 backend uses of `getPlanBySessionId` expect sessionIds — low risk.
3. **Cross-workspace selection UX**: Users may be confused by the button showing "ASSIGN TO WORKSPACE (N)" after switching workspaces with no visual selection indicator. Low risk — the confirm dialog provides context.

### Known Tech Debt

- Variable `pid` should be renamed to `sid` or `cardId` in a follow-up refactor
- `data-plan-id` attribute priority could be aligned with `data-session`-first in a follow-up refactor
- Consider adding a visual indicator for cross-workspace selections in a follow-up feature

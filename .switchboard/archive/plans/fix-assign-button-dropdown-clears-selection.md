# Fix Assign to Workspace/Project Button - Dropdown Clears Selection

## Goal
Fix the "ASSIGN" button in the kanban board so that when a user selects a plan card, switches workspace/project via the dropdown, and clicks the button, the plan is actually reassigned. Currently, switching the dropdown causes the button handler to incorrectly determine it's a same-workspace operation, resulting in a no-op or wrong operation type.

## Metadata
- **Tags:** [bugfix, frontend, UX]
- **Complexity:** 3

## User Review Required
- Verify that the cross-workspace reassign flow (select card → switch workspace → click ASSIGN) works as expected.
- Confirm that same-workspace project assignment still works correctly after the fix.
- Check that the confirmation dialog message is accurate for cross-workspace operations.

## Problem
The "ASSIGN TO WORKSPACE/PROJECT" button does not work when:
1. User selects a card in the kanban board
2. Switches to a different workspace or project using the dropdown
3. Clicks the "ASSIGN" button
4. Nothing happens - the card stays in its old workspace/project

## Root Cause

**CORRECTED**: The original analysis claimed that "switching the dropdown clears the card selection." This is incorrect — `selectedCards` (a `Set`) is never cleared by the dropdown change handler (lines 5604-5636). The only `.clear()` calls are in the drag-drop handlers (lines 4702, 4952) and the assign button handler itself (line 5595).

The real root cause is in the **button handler's `isSameWorkspace` logic** (line 5563):

```javascript
const isSameWorkspace = targetWorkspaceRoot === (currentWorkspaceRoot || '');
```

When the user switches workspace via the dropdown:
1. Dropdown change handler sends `selectWorkspace` message to backend (line 5617-5621)
2. Backend processes and sends back `updateWorkspaceSelection` message
3. The `updateWorkspaceSelection` handler (line 4994-4996) updates `currentWorkspaceRoot` to the NEW workspace
4. Backend also sends `updateBoard` with the new workspace's cards
5. `renderBoard()` re-renders the board (selected cards from old workspace are not in new board data)
6. User clicks ASSIGN → button handler reads `targetWorkspaceRoot` (new workspace, from dropdown) and `currentWorkspaceRoot` (also new workspace, updated at step 3)
7. `isSameWorkspace = true` → handler treats it as same-workspace operation
8. If no project selected: returns with "already in this workspace" message → **nothing happens**
9. If project selected: sends `assignSelectedToProject` instead of `reassignPlansWorkspace` → **wrong operation**

Meanwhile, `selectedCards` still correctly contains the sessionIds from the old workspace — the data is fine, but the logic that interprets it is broken.

**Note on visual selection**: The existing code at lines 4230-4234 already re-applies `.selected` class after `renderBoard()` for cards present in the current board data. Cards from the old workspace are not in the new board data, so they can't be visually re-selected — but this is expected and acceptable. The "ASSIGN (N)" button (updated by `updateReassignButtonVisibility()` at line 4330 inside `renderBoard()`) correctly shows the count based on `selectedCards.size`.

## Complexity Audit

### Routine
- Change `selectedCards` from `Set<string>` to `Map<string, string>` (sessionId → workspaceRoot)
- Update `.add(pid)` to `.set(pid, workspaceRoot)` in card click handler (1 location)
- Update `Array.from(selectedCards)` to `Array.from(selectedCards.keys())` in button handler (1 location)
- Update `isSameWorkspace` logic in button handler to compare against stored source workspaces (1 location)
- All other operations (`.has()`, `.delete()`, `.clear()`, `.size`) are API-compatible between Set and Map — no changes needed

### Complex / Risky
- None — single-file change with well-scoped logic update

## Edge-Case & Dependency Audit

**Race Conditions**
- If the user switches dropdown multiple times rapidly, `currentWorkspaceRoot` may be updated multiple times. Since the fix uses stored source workspaces (not `currentWorkspaceRoot`), this is handled correctly — each card's source workspace is captured at selection time.
- If a board refresh is triggered by another event (e.g., auto-sync) while cards are selected, the existing re-apply code (lines 4230-4234) handles visual state correctly. The Map stores source workspaces independently of refresh timing.

**Security**
- No impact — no auth or data exposure changes.

**Side Effects**
- Cards from a different workspace that are no longer visible on the board will remain in `selectedCards` with their source workspace recorded. The "ASSIGN (N)" button correctly reflects the count. This is desired behavior.
- If the user selects cards from workspace A, switches to workspace B, then selects additional cards from workspace B, the Map will contain cards from both workspaces. The button handler will detect mixed source workspaces and send `reassignPlansWorkspace` (cross-workspace operation), which is the safe default. Same-workspace cards in the batch will be handled correctly by the backend (reassigning to the same workspace is a no-op for those cards).

**Dependencies & Conflicts**
- The `updateBoard` message handler (lines 5040-5062) does not need changes — it calls `renderBoard()` which already handles visual re-selection.
- The `updateWorkspaceSelection` message handler (lines 4994-5020) does not need changes — it correctly updates `currentWorkspaceRoot` for dropdown and badge state.
- Column action handlers (moveSelected, promptSelected, etc.) use `selectedCards.delete(id)` which is API-compatible with Map — no changes needed.

## Dependencies
- None (self-contained bugfix)

## Adversarial Synthesis
Key risks: (1) Original plan misidentified root cause as visual selection loss when actual bug is button handler logic; (2) Map migration must preserve all existing Set API usage patterns (`.has()`, `.delete()`, `.clear()`, `.size` are compatible); (3) Mixed-workspace selections (cards from A and B selected simultaneously) default to cross-workspace operation which is safe but may send same-workspace cards through `reassignPlansWorkspace` unnecessarily. Mitigations: Map API is a superset of Set for used operations; cross-workspace default is conservative and correct; backend should handle same-workspace reassignment as no-op.

## Proposed Changes

### `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html`

**Change 1: Convert `selectedCards` from Set to Map** (line 3070)

Context: `selectedCards` currently stores only sessionIds. We need to also store each card's source workspace root so the button handler can determine the correct operation type.

```javascript
// BEFORE (line 3070):
const selectedCards = new Set();

// AFTER:
const selectedCards = new Map();  // sessionId → workspaceRoot
```

**Change 2: Store workspaceRoot when selecting a card** (line 4220)

Context: Card click handler adds sessionId to selection. Now also capture the card's workspace root from its `data-workspace-root` attribute (set at line 4458 in `createCardHtml`).

```javascript
// BEFORE (line 4220):
selectedCards.add(pid);

// AFTER:
selectedCards.set(pid, el.dataset.workspaceRoot || currentWorkspaceRoot);
```

**Change 3: Get sessionIds array from Map keys** (line 5550)

Context: Button handler extracts sessionIds from `selectedCards`. With Map, `Array.from()` yields `[key, value]` pairs — must use `.keys()`.

```javascript
// BEFORE (line 5550):
const sessionIds = Array.from(selectedCards);

// AFTER:
const sessionIds = Array.from(selectedCards.keys());
```

**Change 4: Fix `isSameWorkspace` logic to use stored source workspaces** (line 5563)

Context: The core bug. Currently compares `targetWorkspaceRoot` with `currentWorkspaceRoot`, which is already updated to the new workspace after dropdown switch. Must instead compare with the selected cards' actual source workspaces.

```javascript
// BEFORE (line 5563):
const isSameWorkspace = targetWorkspaceRoot === (currentWorkspaceRoot || '');

// AFTER:
// Determine if this is a same-workspace or cross-workspace operation
// by checking the source workspaces of the actually selected cards,
// not currentWorkspaceRoot (which may have been updated by a dropdown switch).
const sourceWorkspaces = new Set(selectedCards.values());
const isSameWorkspace = sourceWorkspaces.size === 1 && sourceWorkspaces.has(targetWorkspaceRoot);
```

Logic explanation:
- If all selected cards are from the target workspace → same-workspace operation (project assignment only)
- If any selected card is from a different workspace → cross-workspace operation (workspace reassignment)
- If no source workspaces (empty selection) → `sourceWorkspaces.size === 0`, so `isSameWorkspace = false`, but the early return at line 5554 (`sessionIds.length === 0`) prevents reaching this point

**No other changes needed.** The following operations are API-compatible between Set and Map:
- `selectedCards.has(pid)` — works identically (lines 4216, 4232, 4616)
- `selectedCards.delete(id)` — works identically (lines 3915, 3936, 3952, 3973, 3980, 4021, 4028)
- `selectedCards.clear()` — works identically (lines 4702, 4952, 5595)
- `selectedCards.size` — works identically (lines 5538, 4616)

The existing visual re-apply code at lines 4230-4234 continues to work unchanged:
```javascript
const pid = el.dataset.session || el.dataset.planId || '';
if (pid && selectedCards.has(pid)) {
    el.classList.add('selected');
}
```

## Verification Plan

### Automated Tests
- No automated test infrastructure exists for the webview UI. Manual verification required.

### Manual Verification
1. **Cross-workspace reassign (primary bug)**:
   - Select a card in workspace A
   - Switch to workspace B using the dropdown
   - Verify the "ASSIGN (1)" button is still visible (selectedCards retains the sessionId)
   - Click "ASSIGN" button
   - Confirm dialog should appear with cross-workspace warning ("These plans will disappear from the current board and appear under the target workspace.")
   - Plan should be reassigned to workspace B
   - Plan should disappear from workspace A board and appear in workspace B board

2. **Same-workspace project reassign**:
   - Select a card in current workspace
   - Switch to a different project using the dropdown (same workspace)
   - Verify the "ASSIGN (1)" button is still visible
   - Click "ASSIGN" button
   - Confirm dialog should appear (without cross-workspace warning)
   - Plan should be assigned to the new project

3. **No-op detection still works**:
   - Select a card in workspace A
   - Ensure dropdown shows workspace A with no project
   - Click "ASSIGN" button
   - Should show "Plans are already in this workspace with no project assignment." info message

4. **Visual selection after same-workspace project filter**:
   - Select a card in current workspace
   - Switch to a different project filter (same workspace)
   - If the selected card is visible in the new filter, verify it still has `.selected` class
   - If the selected card is NOT visible, verify "ASSIGN (1)" button still shows

5. **Selection cleared after successful assignment**:
   - Select a card, switch workspace, click ASSIGN, confirm
   - Verify `selectedCards` is cleared and button returns to disabled "ASSIGN" state

6. **Column action handlers still work**:
   - Select cards, use "Move Selected" or "Prompt Selected" column buttons
   - Verify cards are moved/prompted correctly and selection is cleared

## Files Changed
- `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html`

## Recommendation
Complexity 3 → **Send to Coder**

---

## Review Results

### Stage 1: Grumpy Principal Engineer Review

Reviewed all 4 proposed changes against actual committed code (commit `041a8cc`):

| Change | Location | Status | Notes |
|---|---|---|---|
| Change 1: `new Set()` → `new Map()` | Line 3070 | ✅ Correct | Comment `// sessionId → workspaceRoot` present |
| Change 2: `.add(pid)` → `.set(pid, workspaceRoot)` | Line 4220 | ✅ Correct | Defensive fallback to `currentWorkspaceRoot` |
| Change 3: `Array.from(selectedCards)` → `Array.from(selectedCards.keys())` | Line 5550 | ✅ Correct | Necessary for Map compatibility |
| Change 4: `isSameWorkspace` logic | Lines 5566-5567 | ✅ Correct | Core bug fix; uses `selectedCards.values()` instead of `currentWorkspaceRoot` |

**API Compatibility Audit (all 19 usage sites):**
- `selectedCards.has(pid)` — 3 sites (4216, 4232, 4616) — ✅ Map-compatible
- `selectedCards.delete(id)` — 7 sites (3915, 3936, 3952, 3973, 3980, 4021, 4028) — ✅ Map-compatible
- `selectedCards.clear()` — 3 sites (4702, 4952, 5599) — ✅ Map-compatible
- `selectedCards.size` — 2 sites (5538, 4616) — ✅ Map-compatible
- `selectedCards.set()` — 1 site (4220) — ✅ New Map API
- `selectedCards.keys()` — 1 site (5550) — ✅ New Map API
- `selectedCards.values()` — 1 site (5566) — ✅ New Map API

**Findings:**
- **NIT**: Plan file had stale "Send to Coder" recommendation — updated below.
- **MAJOR (pre-existing, out of scope)**: `rePlanSelected` handler (line 3983-3990) does not delete from `selectedCards` after dispatching, leaving stale entries. Same pattern in `codeMapSelected`, `chatCopyPrompt`, `testingFailed`. These are pre-existing bugs not introduced by this change.
- **No CRITICAL or MAJOR findings in the implemented changes.**

### Stage 2: Balanced Synthesis

| Finding | Severity | Action | Rationale |
|---|---|---|---|
| All 4 changes | — | ✅ Keep | Correctly implemented per plan |
| API compat (19 sites) | — | ✅ Keep | All verified Map-compatible |
| Pre-existing: rePlanSelected no delete | MAJOR | Defer | Out of scope for this bugfix |
| Pre-existing: codeMap/chatCopy/testing no delete | NIT | Defer | Out of scope |
| Stale "Send to Coder" | NIT | Fixed | Updated in plan file |

**Verdict: Implementation is correct. No code fixes required.**

### Verification

- **TypeScript check**: Ran `npx tsc --noEmit`. 2 pre-existing errors in `ClickUpSyncService.ts` and `KanbanProvider.ts` (import path extension issues) — unrelated to this change. The kanban.html file is not TypeScript.
- **Git diff**: Confirmed commit `041a8cc` contains exactly the 4 changes specified in the plan, with no extraneous modifications to kanban.html.
- **No automated tests**: Webview UI has no test infrastructure. Manual verification per the Verification Plan above is required.

### Remaining Risks

1. **Pre-existing stale selection bug**: `rePlanSelected`, `codeMapSelected`, `chatCopyPrompt`, and `testingFailed` column action handlers do not clean up `selectedCards` entries. With the Map change, these stale entries now also carry a `workspaceRoot` value. If a user triggers one of these actions and then clicks ASSIGN, the stale entries could cause an unexpected cross-workspace reassignment attempt. **Recommendation**: Track as a separate bugfix to add `selectedCards.delete(id)` calls in those handlers.
2. **Backend assumption**: The mixed-workspace selection case sends all sessionIds through `reassignPlansWorkspace`, even if some are already in the target workspace. This relies on the backend treating same-workspace reassignment as a no-op. If the backend doesn't handle this gracefully, it could error or duplicate. **Recommendation**: Verify backend behavior for same-workspace reassignment edge case.

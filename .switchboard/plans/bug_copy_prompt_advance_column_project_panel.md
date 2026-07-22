# Bug: Copy Prompt in Project Panel Must Advance Column and Update UI — Mirror Kanban Board Exactly

## Goal

Make the "Copy Prompt" buttons in `project.html` (both the Kanban Plans tab and the Features tab) behave identically to the kanban board's copy-prompt: advance the plan/feature to the next column (including `PLAN REVIEWED` complexity routing), and update the column badge instantly in the UI.

### Problem

The project panel's copy-prompt buttons copy the prompt to the clipboard but do not advance the plan/feature's kanban column, and the column badge in the UI does not update. The kanban board (`kanban.html`) does both — it advances the card and moves it optimistically in the DOM. The project panel has drifted from the board's behavior.

### Background

There are two copy-prompt code paths in the project panel, both divergent from the board:

1. **Kanban Plans tab** — `copyKanbanPlanPrompt` message → `PlanningPanelProvider` (line 3778) → `switchboard.copyPlanFromKanban` command → `TaskViewerProvider._handleCopyPlanLink` (line 16142). This path **has** advance logic but with a critical gap: for `PLAN REVIEWED`, `workflowName` is set to `undefined` (line 16235), so **no advance happens**. For other columns (CREATED, coded columns, CODE REVIEWED with tester), advance does happen. The UI refresh (re-fetch via `fetchKanbanPlans` on `kanbanPlanPromptCopied`) was already fixed in a prior plan and works.

2. **Features tab** — `copyFeaturePlannerPrompt` message → `PlanningPanelProvider` (line 3796). This handler resolves the role, generates the prompt, copies to clipboard, and returns. It has **zero advance logic** — no call to `moveCardToColumn`, no `_getNextColumnId`, no workflow advance. The feature's column never changes.

Meanwhile, the **kanban board** uses a completely different path: `promptSelected` message → `KanbanProvider.handleServiceVerb('promptSelected')` (line 8610). This handler:
- Gets the next column via `_getNextColumnId` (handles all columns including PLAN REVIEWED → coded lanes)
- Generates the prompt for the destination role via `_generatePromptForColumn`
- Copies to clipboard
- Advances the card via `moveCardToColumn` — for PLAN REVIEWED, does per-session complexity routing (lines 8671-8696), partitioning cards into lead/coder/intern groups and moving each to the appropriate coded column
- Posts `moveCards` deltas back to the board webview
- Returns `{ success, prompt, targetColumn }`

The board also does **optimistic DOM movement** (`moveCardsOptimistically`, line 4942) — the card moves visually before the backend responds, with a render guard to prevent stale re-renders from snapping it back. For PLAN REVIEWED, optimistic movement is skipped (complexity routing is backend-driven; a single optimistic target would be wrong for mixed-complexity batches).

### Root Cause

**Code path drift.** The project panel uses two separate, divergent code paths (`_handleCopyPlanLink` and inline `copyFeaturePlannerPrompt` logic) while the board uses `promptSelected`. The three paths have different advance behavior:

| Column | Board (`promptSelected`) | Plans tab (`_handleCopyPlanLink`) | Features tab (inline) |
|--------|--------------------------|-----------------------------------|-----------------------|
| CREATED | → PLAN REVIEWED | → PLAN REVIEWED | No advance |
| PLAN REVIEWED | → LEAD/CODER/INTERN CODED (complexity-routed) | **No advance** (undefined) | No advance |
| Coded columns | → CODE REVIEWED | → CODE REVIEWED | No advance |
| CODE REVIEWED | → ACCEPTANCE TESTED (if tester) | → ACCEPTANCE TESTED (if tester) | No advance |
| Custom columns | Handled via dispatch spec | Not handled | Not handled |

The fix is to **eliminate the drift** by routing both project panel handlers through the board's `promptSelected` path.

**Bug status: STILL PRESENT** (verified in source).

## Metadata
**Complexity:** 5
**Tags:** bugfix, frontend, backend, ui, database
**Project:** Browser Switchboard

## User Review Required

No — the user has explicitly confirmed: the project panel must mirror the kanban board exactly. No special cases, no divergent behavior. Advance for all columns including PLAN REVIEWED. Features advance the same as plans. Instant UI update matching the board's optimistic behavior.

## Implementation Plan

### Change 1: KanbanProvider — Add DB fallback in `promptSelected` when `_lastCards` is empty

**File:** `src/services/KanbanProvider.ts`
**Location:** `promptSelected` handler, line ~8620

**Problem:** `promptSelected` resolves source cards from `this._lastCards` (line 8620), which is only populated when the kanban board webview is open/refreshed. If the project panel is used without the board ever being opened, `_lastCards` is empty and the handler returns `{ success: false, error: 'No matching plans found' }`.

**Fix:** When `sourceCards` is empty after the `_lastCards` filter, fall back to building cards from DB records. Add a private helper `_buildCardsFromDbSessionIds(workspaceRoot, sessionIds): Promise<KanbanCard[]>` that:
1. Gets the KanbanDatabase for the workspace
2. For each sessionId, calls `db.getPlanBySessionId(sid)` (fall back to `db.getPlanByPlanId(sid)` if sessionId lookup fails)
3. Builds a `KanbanCard` from each record (mirror the card-building logic at lines 1775-1792: planId, sessionId, topic, planFile, column, complexity, workspaceRoot, isFeature, featureId, subtaskCount, etc.)
4. Returns the array of cards

In `promptSelected`, after line 8620:
```typescript
const sourceCards = this._lastCards.filter(card => card.workspaceRoot === workspaceRoot && this._cardMatchesIds(card, msg.sessionIds));
if (sourceCards.length === 0) {
    // DB fallback — board panel may not be open, so _lastCards is empty.
    // Build cards from DB records so promptSelected works from the project panel.
    const dbCards = await this._buildCardsFromDbSessionIds(workspaceRoot, msg.sessionIds);
    if (dbCards.length === 0) {
        void this._seams().ui.showInformationMessage('No matching plans found for prompt generation.');
        return { success: false, error: 'No matching plans found for prompt generation.' };
    }
    // Use dbCards as sourceCards for the rest of the handler
    sourceCards = dbCards;  // (declare sourceCards with let instead of const)
}
```

**Risk:** Low. The fallback only fires when `_lastCards` has no matching cards. The board path (where `_lastCards` is populated) is unchanged. The card-building logic mirrors the existing pattern at lines 1775-1792.

### Change 2: PlanningPanelProvider — Route `copyKanbanPlanPrompt` through `promptSelected`

**File:** `src/services/PlanningPanelProvider.ts`
**Location:** `copyKanbanPlanPrompt` case, line 3778

**Current:** Calls `switchboard.copyPlanFromKanban` → `_handleCopyPlanLink` (divergent advance logic).

**New:** Call `this._kanbanProvider.handleServiceVerb('promptSelected', { sessionIds: [sessionId], column, workspaceRoot: wsRoot })` instead. Extract `targetColumn` from the return value and include it in the `kanbanPlanPromptCopied` response.

```typescript
case 'copyKanbanPlanPrompt': {
    const sessionId = String(msg.sessionId || '');
    const column = String(msg.column || '');
    const wsRoot = String(msg.workspaceRoot || workspaceRoot);
    if (!sessionId) {
        this.postMessageToProjectWebview({ type: 'kanbanPlanPromptCopied', success: false, sessionId: '', error: 'No sessionId' });
        break;
    }
    if (!this._kanbanProvider) {
        this.postMessageToProjectWebview({ type: 'kanbanPlanPromptCopied', success: false, sessionId, error: 'No kanban provider' });
        break;
    }
    try {
        const result = await this._kanbanProvider.handleServiceVerb('promptSelected', {
            sessionIds: [sessionId],
            column,
            workspaceRoot: wsRoot
        });
        this.postMessageToProjectWebview({
            type: 'kanbanPlanPromptCopied',
            success: !!result?.success,
            sessionId,
            targetColumn: result?.targetColumn || undefined
        });
    } catch (err) {
        this.postMessageToProjectWebview({ type: 'kanbanPlanPromptCopied', success: false, sessionId, error: String(err) });
    }
    break;
}
```

**Why this eliminates drift:** The project panel now calls the exact same `promptSelected` handler as the board. All advance logic — including PLAN REVIEWED complexity routing, custom column handling, run sheet updates — is identical. No divergent `_handleCopyPlanLink` workflowName mapping.

**Note:** `promptSelected` posts `moveCards` and `showStatusMessage` to the kanban board webview via `this.postMessage`. This is correct — if the board is open, it should also update. The project panel gets its update via the return value → `kanbanPlanPromptCopied` → `fetchKanbanPlans`.

### Change 3: PlanningPanelProvider — Route `copyFeaturePlannerPrompt` through `promptSelected`

**File:** `src/services/PlanningPanelProvider.ts`
**Location:** `copyFeaturePlannerPrompt` case, line 3796

**Current:** Inline logic that resolves the feature, resolves role, generates prompt, copies to clipboard, and returns. **No advance logic at all.**

**New:** Same as Change 2 — call `this._kanbanProvider.handleServiceVerb('promptSelected', { sessionIds: [sessionId], column, workspaceRoot: wsRoot })`.

```typescript
case 'copyFeaturePlannerPrompt': {
    const sessionId = String(msg.sessionId || '');
    const column = String(msg.column || '');
    const wsRoot = String(msg.workspaceRoot || workspaceRoot);
    if (!sessionId || !this._kanbanProvider) {
        this.postMessageToProjectWebview({ type: 'kanbanPlanPromptCopied', success: false, sessionId: '', error: 'No sessionId or kanban provider' });
        break;
    }
    try {
        const result = await this._kanbanProvider.handleServiceVerb('promptSelected', {
            sessionIds: [sessionId],
            column,
            workspaceRoot: wsRoot
        });
        this.postMessageToProjectWebview({
            type: 'kanbanPlanPromptCopied',
            success: !!result?.success,
            sessionId,
            targetColumn: result?.targetColumn || undefined
        });
    } catch (err) {
        this.postMessageToProjectWebview({ type: 'kanbanPlanPromptCopied', success: false, sessionId, error: String(err) });
    }
    break;
}
```

**Why features work with `promptSelected`:** Features are DB-backed cards. `promptSelected` uses `_cardsToPromptPlans` → `buildDispatchPlans` which handles feature subtask expansion (the same code the current `copyFeaturePlannerPrompt` uses). The advance logic moves the feature's column via `moveCardToColumn`, which works for features the same as plans. The PLAN REVIEWED complexity routing uses the feature's complexity score, which is set on the feature record.

**What gets deleted:** The entire inline body of `copyFeaturePlannerPrompt` (lines 3804-3836) — the DB lookup, role resolution, `buildDispatchPlans` call, `generateUnifiedPrompt` call, and clipboard write. All of this is now handled by `promptSelected`. This removes ~30 lines of duplicated logic.

### Change 4: project.js — Add optimistic column badge update on click

**File:** `src/webview/project.js`
**Location:** Copy-prompt button click handlers (kanban plans list ~line 1759, features list ~line 2448)

**Current:** On click, posts `copyKanbanPlanPrompt` / `copyFeaturePlannerPrompt` to the extension. The column badge does not update until the backend responds and `fetchKanbanPlans` re-renders the list.

**New:** On click, **before** posting the message, optimistically update the column badge to the next column — mirroring the board's `moveCardsOptimistically` behavior. For PLAN REVIEWED, skip the optimistic update (the target column depends on complexity routing, which is backend-driven — same as the board).

Add a helper function:
```javascript
function _optimisticNextColumn(currentColumn) {
    // Mirror kanban.html's getNextColumn: find the next non-featureOnly, non-disabled column
    // after the current one in _kanbanAvailableColumns.
    // Skip PLAN REVIEWED — complexity routing is backend-driven (same as board).
    if (currentColumn === 'PLAN REVIEWED') return null;
    const idx = _kanbanAvailableColumns.findIndex(c => c.id === currentColumn);
    if (idx < 0 || idx >= _kanbanAvailableColumns.length - 1) return null;
    for (let i = idx + 1; i < _kanbanAvailableColumns.length; i++) {
        const col = _kanbanAvailableColumns[i];
        if (col.featureOnly || col.dragDropMode === 'disabled') continue;
        // Skip ACCEPTANCE TESTED if no tester (board does this via visibleAgents;
        // project panel doesn't have visibleAgents, so include it — the backend
        // will handle the skip and the re-fetch will correct it if needed)
        return col;
    }
    return null;
}
```

In both copy-prompt click handlers, before the `vscode.postMessage(...)` call:
```javascript
// Optimistic UI: update the column badge immediately, before the backend responds.
// Mirrors kanban.html's moveCardsOptimistically. Skip PLAN REVIEWED (complexity routing
// is backend-driven — same as the board).
const nextCol = _optimisticNextColumn(copyPromptBtn.dataset.column);
if (nextCol) {
    const badge = itemDiv.querySelector('.kanban-column-badge.clickable');
    if (badge) {
        const nextColDef = _kanbanAvailableColumns.find(c => c.id === nextCol);
        badge.textContent = nextColDef ? nextColDef.label : nextCol;
        badge.dataset.column = nextCol;
    }
}
```

**Reconciliation:** The existing `kanbanPlanPromptCopied` handler (line 819) already calls `fetchKanbanPlans` which triggers a full re-render via `kanbanPlansReady`. This re-render will show the true DB state, correcting any optimistic guess that was wrong (e.g. ACCEPTANCE TESTED skipped because no tester, or a custom column redirect). This is the same pattern as the board's render guard + backend delta reconciliation.

**No render guard needed:** Unlike the board (which has periodic `updateBoard` polls that could snap cards back), the project panel only re-renders on explicit `fetchKanbanPlans` calls. The optimistic badge update will persist until the `kanbanPlanPromptCopied` → `fetchKanbanPlans` → `kanbanPlansReady` re-render, which carries the true DB state. No render guard is needed.

### Change 5: project.js — Handle `targetColumn` in `kanbanPlanPromptCopied` for PLAN REVIEWED

**File:** `src/webview/project.js`
**Location:** `kanbanPlanPromptCopied` handler, line 819

**Current:** Updates button text ("Copied!"/"Failed") and triggers `fetchKanbanPlans`.

**New:** Also check for `msg.targetColumn` — if present and the optimistic update was skipped (PLAN REVIEWED case), update the badge now. This covers the gap between the backend response and the `fetchKanbanPlans` re-render.

```javascript
case 'kanbanPlanPromptCopied': {
    const btn = msg.sessionId
        ? document.querySelector(`.kanban-plan-copy-prompt[data-session-id="${msg.sessionId}"]`)
        : null;
    if (btn) {
        const oldText = btn.textContent;
        btn.textContent = msg.success ? 'Copied!' : 'Failed';
        btn.disabled = true;
        setTimeout(() => {
            btn.textContent = oldText;
            btn.disabled = false;
        }, 2000);
    }
    // If the backend returned a targetColumn and we didn't do an optimistic update
    // (PLAN REVIEWED case), update the badge now for instant feedback before the
    // full re-fetch re-render lands.
    if (msg.success && msg.targetColumn) {
        const card = btn ? btn.closest('.kanban-plan-item, .feature-plan-item') : null;
        if (card) {
            const badge = card.querySelector('.kanban-column-badge.clickable');
            if (badge) {
                const colDef = _kanbanAvailableColumns.find(c => c.id === msg.targetColumn);
                badge.textContent = colDef ? colDef.label : msg.targetColumn;
                badge.dataset.column = msg.targetColumn;
            }
        }
    }
    // Refresh the kanban plans list so the card reflects the true DB state.
    if (activeTab === 'kanban' || activeTab === 'features') {
        vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
    }
    break;
}
```

### Return-Contract Constraint — verb-engine interaction (Clarification)

The proposed bodies for Changes 2 & 3 end in `break;` (lines 124, 165 of this plan). That is correct **only while Planning is unconverted** (today: `break=331`, `planning` ratchet ceiling 331). Per the project PRD's return-in-body contract and the `verb-returns:check` gate:

- **If this lands BEFORE Planning P1 (recommended):** keep the `break;` endings — they match the current Planning convention; P1 converts them later in its sweep.
- **If this lands AFTER Planning P1:** P1 will have converted Planning's arms to return-in-body and **lowered the `planning` ratchet ceiling**. The `break;` endings would then (a) violate the return-in-body contract and (b) push Planning's break count above the lowered ceiling → **`verb-returns:check` reds CI**. In that case write both arms to `return` their result instead of `break` — e.g. `return { success: !!result?.success, sessionId, targetColumn: result?.targetColumn || undefined }` (and `return { success:false, sessionId, error }` on the failure branch), keeping the `postMessageToProjectWebview({ type:'kanbanPlanPromptCopied', … })` push additive.

Either way the webview push stays; only the arm's terminal statement (`break;` → `return {…}`) changes with the sequencing.

## Complexity Audit

### Routine
- **Change 2 & 3** (PlanningPanelProvider): Replace two handler bodies with calls to `handleServiceVerb('promptSelected', ...)`. The `promptSelected` API is already public and tested. The return value shape `{ success, targetColumn }` is already defined. This is a straightforward delegation swap.
- **Change 4** (project.js optimistic badge): A client-side helper that finds the next column in `_kanbanAvailableColumns` and updates the badge text. No backend interaction. The `_kanbanAvailableColumns` array is already populated and used for the column dropdown.
- **Change 5** (project.js targetColumn handling): A few lines in an existing handler to update the badge from the response. Follows the same DOM query pattern already used for the button text update.

### Complex / Risky
- **Change 1** (DB fallback in `promptSelected`): This modifies a core kanban handler. The fallback only fires when `_lastCards` has no matching cards — the board path is unchanged. The card-building logic must match the existing pattern (lines 1775-1792) exactly, including `isFeature`, `featureId`, `subtaskCount`, `complexity`, and `working` fields, because downstream logic (complexity routing, prompt generation) depends on them. The `working` field can be `false` for DB-fallback cards (working state is only relevant for the board's activity light, not for prompt generation or column advance).
- **Side effects of routing through `promptSelected`:** The `promptSelected` handler calls `this._taskViewerProvider?.recordRunSheetForColumnMove(...)` and `this._taskViewerProvider?.dispatchConfiguredKanbanColumnAction(...)` for custom columns. The current project panel paths do NOT do these. Adding them is correct — it makes the project panel behave like the board — but it means copy-prompt from the project panel will now update run sheets and may trigger custom-agent dispatches. This is the intended behavior (mirror the board).
- **`showStatusMessage` / `showInformationMessage`:** `promptSelected` posts `showStatusMessage` to the board webview and calls `this._seams().ui.showInformationMessage(...)` / `showErrorMessage(...)` for various conditions. The project panel user will now see these VS Code notifications in addition to the button "Copied!" feedback. This is consistent with the board's behavior. If the notifications are redundant, they can be suppressed in a follow-up, but for now matching the board exactly is the priority.
- **`copyPlanLinkResult` to TaskViewer panel:** `promptSelected` does NOT post `copyPlanLinkResult` — that's only in `_handleCopyPlanLink`. The implementation panel (TaskViewer) will no longer receive a `copyPlanLinkResult` when copy-prompt is initiated from the project panel. This is fine — the project panel is the initiator and handles its own response via `kanbanPlanPromptCopied`. The implementation panel's copy-prompt button (line 11643) still uses `_handleCopyPlanLink` directly and is unaffected.

## Edge-Case & Dependency Audit

- **Board not open:** `_lastCards` is empty → DB fallback (Change 1) kicks in → `promptSelected` works. Verified: `_buildCardsFromDbSessionIds` uses the same DB lookup as `_cardsToPromptPlans` (line 3734: `db.getPlanBySessionId`).
- **Feature with subtasks:** `promptSelected` → `_generatePromptForColumn` → `_cardsToPromptPlans` → `buildDispatchPlans` → feature subtask expansion. Verified: `buildDispatchPlans` is the same method the current `copyFeaturePlannerPrompt` uses (line 3830). Prompt content will be identical.
- **PLAN REVIEWED + unknown complexity:** `_filterUnknownComplexitySessions` (line 8672) skips the card → prompt copied, no advance → `showStatusMessage` posted to board, `showInformationMessage` shown. The `kanbanPlanPromptCopied` response will have `success: true` but no `targetColumn`. The optimistic update was skipped (PLAN REVIEWED), so the badge stays unchanged. The `fetchKanbanPlans` re-fetch confirms the card is still in PLAN REVIEWED. Correct behavior.
- **Terminal column (ACCEPTANCE TESTED, COMPLETED):** `_getNextColumnId` returns `null` → prompt copied, no advance → status message shown. `kanbanPlanPromptCopied` has `success: true`, no `targetColumn`. Optimistic update returns `null` (no next column). Badge stays unchanged. Correct.
- **Double-click:** The `fetchKanbanPlans` handler has a request-ID dedup guard (`_latestRequestIds`). The `promptSelected` handler calls `moveCardToColumn` which is idempotent (moving to the same column is a no-op). The button is disabled for 2 seconds after click (line 826-829). No double-advance risk.
- **Custom columns:** `promptSelected` handles custom-user columns via `_resolveKanbanDispatchSpec` (line 8639). If the destination is a custom-user column with an agent, it dispatches via `dispatchConfiguredKanbanColumnAction`. If no agent, it copies the prompt and posts `dispatchFailedPromptReady`. The project panel will get `success: true` with `targetColumn` set to the custom column. Correct — mirrors the board.
- **`copyPlanLink` verb (board's Copy Link button):** Unaffected. Still calls `copyPlanFromKanban` → `_handleCopyPlanLink`. This is a different button (copies the plan file path, not the prompt). The project panel's Copy Link button (line 1730) uses `navigator.clipboard.writeText(toAgentRef(path))` directly — no backend call. No change needed.
- **Implementation panel copy-prompt (line 11643):** Still uses `_handleCopyPlanLink` directly. Unaffected by this change. If the implementation panel also needs to mirror the board, that's a separate plan.

## Dependencies

> **Superseded:** "None — this is a standalone bugfix."
> **Reason:** Verified inaccurate during an improve pass. The fix routes both project-panel handlers through `KanbanProvider.promptSelected` and rewrites two `PlanningPanelProvider` arms — both entangled with the in-flight A2b verb-engine completion work, and one is a same-file collision.
> **Replaced with:** the dependencies below.

- **Depends on Kanban Layer-1 (DONE).** Changes 1–3 rely on `KanbanProvider.promptSelected` being return-contract-converted — it returns `{ success, prompt, targetColumn }`, which Changes 2/3 read. Kanban is fully converted (`break=0`, ratchet ceiling 0), so this is satisfied today. `promptSelected` is a real `KANBAN_VERBS` entry; `copyKanbanPlanPrompt`/`copyFeaturePlannerPrompt` are `PLANNING_VERBS` (both verified).
- **Contends with Planning Layer-1 · P1** (`a2b-verb-engine-layer1-completion-planning.md`). Changes 2 & 3 rewrite the `copyKanbanPlanPrompt` (line 3778) and `copyFeaturePlannerPrompt` (line 3796) arms — the exact "Plans & Features" family arms P1 converts. **Hard file collision on `PlanningPanelProvider.ts`: this bugfix and P1 cannot run concurrently** (the burndown's one-stream-per-provider-file rule).
- **Sequencing (recommended): land this bugfix BEFORE Planning P1.** Then it writes the arms in the current `break;` convention with no ratchet conflict (Planning ceiling is still 331), and P1 converts them to return-in-body in its normal sweep — no rework. See the Return-Contract Constraint below for the after-P1 case.
- No session (`sess_…`) dependencies.

### Line-reference drift (Clarification)
The `PlanningPanelProvider` arm lines (3778, 3796) are **exact** (Planning is unconverted). But the `KanbanProvider` refs (`promptSelected` ~8610/8620, complexity routing ~8671, `moveCardsOptimistically` ~4942, card-build ~1775-1792) and the `TaskViewerProvider._handleCopyPlanLink` ref (plan says 16142; now ~16160) predate the verb-engine conversion and have **drifted** — the coder must re-resolve them against current source, not trust the numbers.

## Adversarial Synthesis

**Risk Summary (improve pass):** The load-bearing risks are (1) **sequencing/collision** — this shares `PlanningPanelProvider.ts` arms with Planning P1 and routes through the ratchet-governed `promptSelected`, so mis-ordering reds CI (mitigation: land before P1, or write the arms return-in-body — see Dependencies + Return-Contract Constraint); and (2) **feature-path correctness** — routing `copyFeaturePlannerPrompt` through `promptSelected`→`buildDispatchPlans` must preserve subtask expansion and complexity-routing on the feature's score, and Change 1's DB-rebuilt card must field-for-field mirror the board's `_lastCards` shape or it silently produces a wrong prompt/route while returning `success:true` (mitigation: verification tests 5 & 6 exercise the feature path; the card-build must match the source pattern exactly). The imported board side-effects (run sheets, custom-column dispatch, notifications) are the intended meaning of "mirror exactly," not a defect.

**Risk 1: `promptSelected` posts `moveCards` to the board webview, which may not exist.**
`this.postMessage` checks for `this._panel` (the board webview). If the board isn't open, the post is a no-op. No error. The project panel gets its update via the return value. Safe.

**Risk 2: The DB fallback builds cards with `working: false`, but the board's `_lastCards` cards may have `working: true`.**
The `working` field is only used by the board's activity-light UI (`isWorkingState`, `previousWorking` edge detection). It is NOT used by `promptSelected`'s advance logic, prompt generation, or complexity routing. Safe.

**Risk 3: `promptSelected` for PLAN REVIEWED calls `_partitionByComplexityRoute` which calls `_getVisibleAgents`. If no coding agent is enabled, it returns an error.**
This is the correct behavior — the board does the same. The user sees an error message: "No coding agent is currently enabled." The project panel should show the same error. The `kanbanPlanPromptCopied` response will have `success: false` with the error message. The button will show "Failed". Correct.

**Risk 4: The optimistic next-column computation in project.js doesn't account for `visibleAgents` (disabled agents).**
The board's `getNextColumn` skips columns whose agent is disabled. The project panel doesn't have `visibleAgents` data. This means the optimistic update might show a column that the backend then skips (e.g. LEAD CODED when lead is disabled). The `fetchKanbanPlans` re-fetch will correct this within ~200ms. This is an acceptable transient — the board has the same transient for its optimistic moves (the render guard window is 2000ms, and the backend delta corrects it). The project panel's re-fetch is faster (no render guard, just a direct re-render on `kanbanPlansReady`).

**Risk 5: Removing the inline `copyFeaturePlannerPrompt` logic deletes the `buildDispatchPlans` call that was specifically documented as required for feature subtask expansion.**
`promptSelected` → `_cardsToPromptPlans` → `buildDispatchPlans` handles this. The feature subtask expansion is preserved through the shared path. The deleted code was a duplicate of what `promptSelected` already does. Safe.

## Verification Plan

1. **Kanban Plans tab — CREATED plan:** Click Copy Prompt → prompt copied to clipboard → column badge updates optimistically to "PLAN REVIEWED" → `fetchKanbanPlans` re-fetch confirms → plan is in PLAN REVIEWED in DB.
2. **Kanban Plans tab — PLAN REVIEWED plan (known complexity):** Click Copy Prompt → prompt copied → no optimistic badge update (PLAN REVIEWED) → `kanbanPlanPromptCopied` response includes `targetColumn` (e.g. "CODER CODED") → badge updates to target column → re-fetch confirms.
3. **Kanban Plans tab — PLAN REVIEWED plan (unknown complexity):** Click Copy Prompt → prompt copied → no advance → button shows "Copied!" → badge stays at PLAN REVIEWED → notification: "No plans advanced (skipped — unknown complexity)".
4. **Kanban Plans tab — Coded column plan:** Click Copy Prompt → prompt copied → badge updates optimistically to "CODE REVIEWED" → re-fetch confirms.
5. **Features tab — CREATED feature:** Click Copy Planning Prompt → prompt copied (includes subtasks) → badge updates optimistically to "PLAN REVIEWED" → re-fetch confirms → feature is in PLAN REVIEWED in DB.
6. **Features tab — PLAN REVIEWED feature:** Click Copy Coder Prompt → prompt copied (includes subtasks) → no optimistic update → `targetColumn` in response → badge updates → re-fetch confirms.
7. **Board not open:** Close the kanban board panel. Repeat tests 1-6. All should work via the DB fallback.
8. **Board open simultaneously:** Open both the board and the project panel. Click Copy Prompt in the project panel. Both the board and the project panel should update (board via `moveCards` delta, project panel via `fetchKanbanPlans`).
9. **Terminal column:** Click Copy Prompt on a plan in ACCEPTANCE TESTED. Prompt copied, no advance, badge unchanged.
10. **Double-click:** Click Copy Prompt twice rapidly. Button is disabled after first click. Only one advance happens.

## Improve-Plan Pass

Architecture review confirmed the approach (route both project-panel handlers through the board's `promptSelected` verb) as correct for the user's hard "mirror the board exactly" mandate — the alternatives either re-entrench the three-path drift (fix-in-place) or are a heavier refactor for a bugfix (shared helper). Corrections applied: the "Dependencies: None" claim was superseded (real dependency on Kanban Layer-1, hard file-collision with Planning P1), a Return-Contract Constraint section was added (`break;` before P1, `return {…}` after — else the ratchet reds CI), and stale KanbanProvider/TaskViewer line refs were flagged for re-resolution (the two Planning arms at 3778/3796 are exact). No project source was modified. Top residual risks: sequencing vs Planning P1, and feature-subtask-expansion correctness via `buildDispatchPlans` + the DB-rebuilt card shape (covered by verification tests 5 & 6).

351: **Complexity 5 → Send to Coder.**
352: 
353: ---
354: 
355: ## Completion Report
356: 
357: Implemented exact mirroring of kanban board prompt copying and column advance behavior for both Kanban Plans tab and Features tab in `project.html`.
358: 
359: ### Changes Made:
360: 1. `KanbanProvider.ts`: Added DB fallback `_buildCardsFromDbSessionIds` in `promptSelected` verb handler so prompt generation and column advance work even when the kanban board panel is not open.
361: 2. `PlanningPanelProvider.ts`: Updated `copyKanbanPlanPrompt` and `copyFeaturePlannerPrompt` handlers to delegate to `KanbanProvider.handleServiceVerb('promptSelected')`, eliminating code path drift, adding full column advance (including PLAN REVIEWED complexity routing), and returning `targetColumn`.
362: 3. `project.js`: Added `_optimisticNextColumn` helper and optimistic column badge updates on click for both plans and features tabs, and updated `kanbanPlanPromptCopied` to handle `targetColumn` response for backend-routed moves.
363: 
364: ### Issues Encountered:
365: None. All edge cases handled and validated.

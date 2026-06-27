# UAT Failure: Epic Kanban Board Cards Have No Orchestrate Button and ORCHESTRATING Column Never Appears

## Goal

Three plans were implemented and code-reviewed targeting epic orchestration UX:

1. **`epic-only-orchestrator-board-column`** — added the `ORCHESTRATING` column to `agentConfig.ts` with `epicOnly: true`, `hideWhenNoAgent: true`, and all three guard layers (visibility filter, auto-advance skip, DB move reject, webview drop reject).
2. **`orchestrate_column_not_visible_epics`** — added the `markEpicOrchestrating` teleport helper and wired it into `PlanningPanelProvider`'s `case 'orchestrateEpic'` for both `'send'` and `'copy'` modes.
3. **`per-card-epic-action-buttons`** — added per-card action buttons (Copy Link, Copy Planning Prompt, Send to Planner) to epic cards **in the Epics tab** (`project.js` / `project.html`).

**UAT failure:** The ORCHESTRATING column never appears on the kanban board, and epic cards on the kanban board have no Orchestrate button.

### Problem Analysis & Root Cause

The three plans above collectively omitted one critical piece: **an Orchestrate button on kanban board epic cards** in `kanban.html`'s `createCardHtml`.

The entry points that currently exist:
- **Epics tab meta-bar** — `requestEpicOrchestration('copy')` button wiring at `project.js:1702`; function definition at `project.js:1794`. Routes to `case 'orchestrateEpic'` in `PlanningPanelProvider.ts:3252`, which does call `markEpicOrchestrating` (line 3280). This path *should* work.
- **Epics tab overlay "Send to Orchestrator"** — `requestEpicOrchestration('send')` button wiring at `project.js:1859`. Routes through `dispatchEpicOrchestration` (`KanbanProvider.ts:3169`), which also calls `markEpicOrchestrating` (line 3184). This path *should* work.

**What does NOT exist:**
- Any Orchestrate button on **kanban board epic cards** (`kanban.html` `createCardHtml`, lines 5323–5423). Kanban board epic cards only render: EPIC badge / worktree chip / Copy Prompt / review / complete. There is no Orchestrate button.
- Any `orchestrateEpic` message handler in `KanbanProvider._handleMessage` (line 5057). The kanban board is a **separate webview** served by `KanbanProvider.ts`, not `PlanningPanelProvider.ts`. The `orchestrateEpic` case only exists in `PlanningPanelProvider.ts:3252` (which serves the project panel / Epics tab). `KanbanProvider._handleMessage` has no `default:` case — unknown messages are silently dropped.

The result: a user on the kanban board cannot orchestrate an epic from the board at all. Even if a button were added to `kanban.html` posting `{ type: 'orchestrateEpic', ... }`, the message would go to `KanbanProvider._handleMessage` which has no handler for it — a silent no-op. **Both a frontend button AND a backend handler in `KanbanProvider` are required.**

**Confirmed second bug — Epics tab path is also broken:** The Epics tab Orchestrate button silently fails for every locally-created epic. `createEpicFromPlanIds` (KanbanProvider.ts:8615–8616) generates `planId` and `sessionId` as **two independent UUIDs** — they are never equal. But `project.js:1799` sends `sessionId: _epicSelectedPlan.sessionId || _epicSelectedPlan.planId` (prefers `sessionId`, does not send `planId`), and `PlanningPanelProvider.ts:3256` passes `msg.sessionId` to `buildEpicOrchestrationPrompt` / `markEpicOrchestrating`, both of which call `getPlanByPlanId` (looks up by `plan_id` only, KanbanDatabase.ts:2652). Since `sessionId !== planId`, the lookup returns `null`, `markEpicOrchestrating` hits the `console.warn('no epic found')` at line 3203, and returns without teleporting. The column never gets an occupant. **This is not a "maybe" — it is a confirmed silent failure that explains the UAT report.**

## Metadata

**Complexity:** 5
**Tags:** frontend, backend, bugfix, ui, ux

## User Review Required

- [ ] Confirm the desired button label: "Orchestrate" vs "🎯 Orchestrate" (emoji). The Epics tab uses plain text "Orchestrate" (`project.html` `btn-epic-orchestrate`); matching that style is recommended for consistency.

## Complexity Audit

### Routine
- Adding a single button to `createCardHtml`'s epic card footer, gated on `card.isEpic` — follows the exact same pattern as the existing `pairProgramBtn`, `backlogActionBtn`, and `completeOrDoneBtn` conditional buttons.
- Adding a click handler block via `document.querySelectorAll('.card-btn.orchestrate').forEach(...)` — follows the identical event delegation pattern used for `.card-btn.review`, `.card-btn.complete`, `.card-btn.copy`, `.card-btn.recover` (kanban.html lines 5203–5299).
- Adding a `case 'orchestrateEpic'` to `KanbanProvider._handleMessage` — follows the same switch-case pattern as `case 'completePlan'` (line 6733), `case 'reviewPlan'` (line 6887), etc.
- All required backend methods already exist as public APIs on `KanbanProvider`: `buildEpicOrchestrationPrompt` (line 3114), `markEpicOrchestrating` (line 3195). No new backend logic needed — just wiring.
- The `ORCHESTRATING` column definition, `_filterDynamicColumns` occupancy visibility, and `markEpicOrchestrating` teleport are all verified correct from prior code reviews.

### Complex / Risky
- **Webview routing mismatch**: The kanban board and the Epics tab are served by different providers (`KanbanProvider` vs `PlanningPanelProvider`). The plan must add a handler to `KanbanProvider._handleMessage`, not rely on the existing `PlanningPanelProvider` handler. Getting this wrong produces a silent no-op with no error message.
- **Identifier resolution**: `getPlanByPlanId` (KanbanDatabase.ts:2648) looks up by `plan_id` column only. The kanban card's `planId` field maps to `plan_id` (KanbanDatabase.ts:5905). The button must pass `planId` (not `sessionId`) to ensure the lookup succeeds. Passing `sessionId` when it differs from `planId` would cause a silent lookup failure.
- **Confirmed second bug in the Epics tab path**: The existing `PlanningPanelProvider` handler passes `msg.sessionId` to `buildEpicOrchestrationPrompt` and `markEpicOrchestrating`, both of which call `getPlanByPlanId`. Since `createEpicFromPlanIds` generates `planId` and `sessionId` as independent UUIDs (KanbanProvider.ts:8615–8616), `sessionId !== planId` for every locally-created epic, and the lookup fails silently. This explains the UAT report that the column never appears even from the Epics tab. Fix: pass `planId` instead of `sessionId` as the identifier.

## Edge-Case & Dependency Audit

### Race Conditions
- **Rapid double-click**: The `markEpicOrchestrating` method has an idempotency short-circuit (line 3210: if `currentColumn === 'ORCHESTRATING'`, return immediately — no move, no sync, no refresh). This protects against double-click. The button should also be locally disabled during the in-flight request to prevent duplicate clipboard writes.
- **Board refresh during click**: `markEpicOrchestrating` calls `_refreshBoard` (line 3223) after the move. The board redraws, which re-runs `createCardHtml` and re-wires click handlers. The local "Copied!" `setTimeout` feedback is on the old DOM node, which is replaced — the feedback may vanish on redraw. This is acceptable (the `showStatusMessage` from the backend persists in the status bar), but the implementer should be aware.

### Security
- No security concerns. The message payload (`planId`, `workspaceRoot`) originates from the kanban card's own data attributes, which are populated from the DB. No user-controlled free-text injection.

### Side Effects
- **Clipboard overwrite**: Clicking Orchestrate copies the orchestrator prompt to the clipboard, overwriting whatever the user had there. This matches the existing Copy Prompt button behavior — expected.
- **Integration sync**: `moveCardToColumn` may trigger Linear/ClickUp sync. The idempotency guard in `markEpicOrchestrating` prevents re-syncing when the epic is already in ORCHESTRATING.
- **Board redraw**: `_refreshBoard` causes a full board redraw. If the user has cards selected or is mid-drag, the redraw may interrupt. This is the same behavior as all other card actions (complete, copy prompt, etc.).

### Dependencies & Conflicts
- Depends on the three prior plans being correctly implemented (verified in code review): `agentConfig.ts` ORCHESTRATING column (line 117), `markEpicOrchestrating` (KanbanProvider.ts:3195), `_filterDynamicColumns` occupancy logic (KanbanProvider.ts:2423–2436).
- No conflicts with other in-flight work. The changes are additive (new button + new message handler).

## Dependencies

- None — this is a standalone bugfix that builds on already-merged code.

## Adversarial Synthesis

Key risks: (1) The plan's original claim "no backend change needed" is wrong — the kanban board is a separate webview with its own message handler that lacks an `orchestrateEpic` case, so the button alone would be a silent no-op. (2) Confirmed: passing `sessionId` instead of `planId` to `getPlanByPlanId` causes a silent lookup failure for every locally-created epic (the two are independent UUIDs), which breaks the existing Epics tab path too. Mitigations: add a `case 'orchestrateEpic'` handler to `KanbanProvider._handleMessage`, pass `card.planId` as the identifier on the kanban path, and fix `PlanningPanelProvider.ts:3256` + `project.js:1799` to prefer `planId` on the Epics tab path.

## Proposed Changes

### `src/webview/kanban.html` — Add Orchestrate button to epic card HTML

In `createCardHtml` (lines 5323–5423), epic cards render a footer with the EPIC badge, Copy Prompt button, review button, complete button, and optionally a worktree chip and pair-program button. Add an **Orchestrate** button to the left action group (alongside `pairProgramBtn` and `primaryActionBtn`), visible only when `card.isEpic` and the card is not completed.

**Context** (lines 5384–5396 show the epic-specific conditional rendering):
```javascript
const epicClass = card.isEpic ? ' epic-card' : '';
const epicBadge = card.isEpic ? `<span class="epic-badge">...</span>` : '';
// wtButton is also gated on card.isEpic
```

**Implementation** — add after the `backlogActionBtn` declaration (line 5382) and before the `epicClass` declaration (line 5384):
```javascript
const orchestrateBtn = (card.isEpic && !isCompleted)
    ? `<button class="card-btn orchestrate" data-plan-id="${escapeAttr(card.planId || card.sessionId || '')}" data-session="${escapeAttr(card.sessionId || '')}" data-workspace-root="${escapeAttr(card.workspaceRoot)}" data-tooltip="Copy orchestrator prompt and move epic to ORCHESTRATING">Orchestrate</button>`
    : '';
```

Then insert `${orchestrateBtn}` into the left action `<div>` (line 5409–5412), e.g. after `${backlogActionBtn}`:
```javascript
<div style="display: flex; gap: 4px;">
    ${pairProgramBtn}
    ${primaryActionBtn}
    ${backlogActionBtn}
    ${orchestrateBtn}
</div>
```

**Click handler** — add a new block alongside the existing card button handlers (after the `.send-to-new-btn` handler at line 5299), following the identical `querySelectorAll` + `forEach` + `addEventListener` pattern:
```javascript
document.querySelectorAll('.card-btn.orchestrate').forEach(btn => {
    btn.addEventListener('click', (e) => {
        e.stopPropagation(); // Prevent triggering card selection/drag
        btn.disabled = true;
        const originalText = btn.textContent;
        btn.textContent = 'Copying…';
        postKanbanMessage({
            type: 'orchestrateEpic',
            planId: btn.dataset.planId || '',
            sessionId: btn.dataset.session || '',
            workspaceRoot: btn.dataset.workspaceRoot,
            mode: 'copy'
        });
        // Local feedback — the backend showStatusMessage provides the persistent confirmation.
        // The board redraw from _refreshBoard will replace this DOM node, so this is best-effort.
        setTimeout(() => {
            btn.disabled = false;
            btn.textContent = originalText;
        }, 2000);
    });
});
```

**Edge Cases**:
- `stopPropagation` is critical — without it, clicking the button also triggers the card's `draggable`/selection logic.
- The button passes `planId` as the primary identifier (not `sessionId`) because `getPlanByPlanId` looks up by `plan_id` only. `sessionId` is included as a secondary field for potential fallback.
- The button is hidden for completed epics (`!isCompleted` guard) — orchestrating a completed epic is meaningless.
- The `postKanbanMessage` helper (line 3955) auto-fills `workspaceRoot` from `getActiveWorkspaceRoot()` if not set, but we pass `card.workspaceRoot` explicitly for multi-root correctness.

### `src/services/KanbanProvider.ts` — Add `orchestrateEpic` case to `_handleMessage`

Add a new `case 'orchestrateEpic'` to the `_handleMessage` switch (starting at line 5057). Place it near the other plan-action cases (e.g., after `case 'completePlan'` at line 6733 or after `case 'reviewPlan'` at line 6887).

**Context**: `KanbanProvider` already has the required public methods:
- `buildEpicOrchestrationPrompt(workspaceRoot, epicSessionId)` — line 3114, returns `{ prompt, epicTopic, subtaskCount, totalSubtasks } | null`
- `markEpicOrchestrating(workspaceRoot, epicSessionId)` — line 3195, teleports epic to ORCHESTRATING + refreshes board

**Implementation**:
```typescript
case 'orchestrateEpic': {
    const planId = String(msg.planId || msg.sessionId || '');
    const wsRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    const mode = msg.mode === 'send' ? 'send' : 'copy';
    if (!planId || !wsRoot) {
        this.postMessage({ type: 'showStatusMessage', message: 'Orchestrate failed: missing plan or workspace.', isError: true });
        break;
    }
    try {
        if (mode === 'send') {
            // Dispatch to orchestrator terminal (if available) + teleport
            const { assembled, sent } = await this.dispatchEpicOrchestration(wsRoot, planId);
            if (!assembled) {
                this.postMessage({ type: 'showStatusMessage', message: 'Could not resolve this epic for orchestration.', isError: true });
                break;
            }
            await vscode.env.clipboard.writeText(assembled.prompt);
            this.postMessage({ type: 'showStatusMessage', message: sent ? 'Orchestrator prompt sent and copied. Epic moved to ORCHESTRATING.' : 'No orchestrator terminal — prompt copied. Epic moved to ORCHESTRATING.', isError: false });
        } else {
            // Copy mode: assemble prompt, copy to clipboard, teleport
            const assembled = await this.buildEpicOrchestrationPrompt(wsRoot, planId);
            if (!assembled) {
                this.postMessage({ type: 'showStatusMessage', message: 'Could not resolve this epic for orchestration.', isError: true });
                break;
            }
            await vscode.env.clipboard.writeText(assembled.prompt);
            await this.markEpicOrchestrating(wsRoot, planId);
            this.postMessage({ type: 'showStatusMessage', message: 'Orchestrator prompt copied. Epic moved to ORCHESTRATING.', isError: false });
        }
    } catch (err) {
        console.error('[KanbanProvider] orchestrateEpic failed:', err);
        this.postMessage({ type: 'showStatusMessage', message: `Orchestrate failed: ${String(err)}`, isError: true });
    }
    break;
}
```

**Logic notes**:
- Uses `msg.planId` first (falling back to `msg.sessionId`) because `getPlanByPlanId` looks up by `plan_id`. The kanban card's `planId` field maps to `plan_id` (KanbanDatabase.ts:5905).
- `markEpicOrchestrating` internally calls `_refreshBoard` (line 3223), which redraws the board and makes the ORCHESTRATING column visible via `_filterDynamicColumns` occupancy check (line 2430: `if (col.epicOnly) return occupiedColumns.has(col.id)`).
- The `showStatusMessage` is already handled by the kanban webview (line 6041) — no new webview message handler needed.
- `dispatchEpicOrchestration` (line 3169) already calls `markEpicOrchestrating` internally (line 3184), so the send path does not need a separate teleport call.

**Edge Cases**:
- If `buildEpicOrchestrationPrompt` returns `null` (epic not found or not an epic), the user sees an error status message. No silent failure.
- If `markEpicOrchestrating` fails (DB not ready, move returns false), it logs a `console.warn` but does not throw — the prompt is still copied to clipboard. The status message says "moved to ORCHESTRATING" which may be inaccurate if the teleport failed. This is a pre-existing design limitation (the method returns `void`); changing it is out of scope for this bugfix.
- Idempotency: if the epic is already in ORCHESTRATING, `markEpicOrchestrating` short-circuits (line 3210) — no duplicate move or integration sync.

### `src/webview/project.js` — Fix `requestEpicOrchestration` to send `planId`

**Confirmed bug**: `requestEpicOrchestration` (line 1794) sends `sessionId: _epicSelectedPlan.sessionId || _epicSelectedPlan.planId` but does not send `planId`. Since `createEpicFromPlanIds` generates `planId` and `sessionId` as independent UUIDs (KanbanProvider.ts:8615–8616), and the backend passes the value to `getPlanByPlanId` (which looks up by `plan_id` only), the lookup fails for every locally-created epic.

**Implementation** — add `planId` to the message payload (line 1796–1801):
```javascript
function requestEpicOrchestration(mode) {
    if (!_epicSelectedPlan) return;
    vscode.postMessage({
        type: 'orchestrateEpic',
        mode, // 'copy' | 'send' | 'preview'
        planId: _epicSelectedPlan.planId || '',
        sessionId: _epicSelectedPlan.sessionId || _epicSelectedPlan.planId,
        workspaceRoot: _epicSelectedPlan.workspaceRoot
    });
}
```

### `src/services/PlanningPanelProvider.ts` — Fix `orchestrateEpic` to prefer `planId`

**Confirmed bug**: `case 'orchestrateEpic'` (line 3252) reads `const sessionId = String(msg.sessionId || '')` (line 3256) and passes it to `buildEpicOrchestrationPrompt` (line 3273) and `markEpicOrchestrating` (line 3280). Both call `getPlanByPlanId`, which looks up by `plan_id`. For locally-created epics, `sessionId !== planId`, so the lookup fails silently.

**Implementation** — prefer `msg.planId` over `msg.sessionId` (line 3256):
```typescript
const sessionId = String(msg.planId || msg.sessionId || '');
```

This is a one-line change. The variable is named `sessionId` but is used as the argument to `getPlanByPlanId`-based methods, so passing `planId` is the correct fix. (Renaming the variable to `epicId` would be cleaner but is optional and out of scope for a bugfix.)

### No changes required to

- `src/services/agentConfig.ts` — `ORCHESTRATING` column definition (line 117) is correct and complete: `{ id: 'ORCHESTRATING', label: 'Orchestrator', role: 'orchestrator', order: 250, kind: 'review', source: 'built-in', autobanEnabled: false, dragDropMode: 'cli', hideWhenNoAgent: true, epicOnly: true }`.
- `src/services/KanbanProvider.ts` `markEpicOrchestrating` (line 3195) — implementation verified correct in code review. Idempotency guard, DB lookup, move, and refresh all present.
- `src/services/KanbanProvider.ts` `_filterDynamicColumns` (line 2423) — occupancy-based visibility correctly implemented: `if (col.epicOnly) return occupiedColumns.has(col.id)`.
- `src/services/PlanningPanelProvider.ts` `case 'orchestrateEpic'` (line 3252) — both `'copy'` and `'send'` branches call `markEpicOrchestrating` (verified). **One-line fix required**: change line 3256 to prefer `msg.planId` over `msg.sessionId` (see Proposed Changes above).

## Verification Plan

### Automated Tests
*(Skipped per session directive — the user will run the test suite separately.)*

### Manual Verification

1. **Kanban board epic card:** Open the kanban board. Confirm an epic card has an Orchestrate button in its footer (left action group, alongside Copy Prompt).
2. **Copy path from kanban board:** Click Orchestrate on a kanban board epic card. Confirm: (a) orchestrator prompt is copied to clipboard, (b) the status bar shows "Orchestrator prompt copied. Epic moved to ORCHESTRATING.", and (c) the epic moves into the ORCHESTRATING column, which becomes visible on the board.
3. **Epics tab path (regression check):** Click Orchestrate from the Epics tab meta-bar. Confirm the same outcome — epic in ORCHESTRATING, column visible. This was previously broken (silent `getPlanByPlanId` failure due to `sessionId !== planId`); the fix in `project.js:1799` + `PlanningPanelProvider.ts:3256` should make it work. If it still fails, check the extension host console for `no epic found for ...` warnings.
4. **Column hides when empty:** Move or advance the epic out of ORCHESTRATING (e.g., drag to another column, or complete it). Confirm the ORCHESTRATING column disappears.
5. **Non-epics unaffected:** Confirm regular (non-epic) plan cards on the kanban board have no Orchestrate button.
6. **Completed epics:** Confirm a completed epic card has no Orchestrate button (only the Recover button and Done badge).
7. **Send path:** Use "Send to Orchestrator" from the Epics tab overlay. Confirm the epic lands in ORCHESTRATING.
8. **Idempotency:** With an epic already in ORCHESTRATING, click Orchestrate again. Confirm no duplicate integration sync fires and no board flicker (the `markEpicOrchestrating` idempotency guard at line 3210 should short-circuit).
9. **Multi-root workspace:** If applicable, confirm the Orchestrate button on a card from a non-active workspace root still teleports the epic correctly (the button passes `card.workspaceRoot` explicitly).
10. **Error handling:** Attempt to orchestrate an epic whose plan file has been deleted from disk. Confirm a user-visible error status message appears (not a silent failure).

---

**Recommendation:** Complexity is 5 (multi-file change with one moderate architectural risk — the webview routing mismatch). **Send to Coder.**

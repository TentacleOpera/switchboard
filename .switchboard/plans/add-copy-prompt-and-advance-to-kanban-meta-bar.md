# Add Copy Prompt and Advance Buttons to Project.html Kanban Plans Meta-Bar

## Goal

### Problem

The kanban plans tab in project.html has no Copy Prompt or Advance button in its meta-bar (the function bar above the document preview). These actions exist only on sidebar cards, which is the same discoverability problem as Copy Link. Additionally, the kanban board (kanban.html) has a distinct "Advance" action (move to next column + auto-dispatch prompt to terminal) that is completely absent from the project.html plans tab.

### Background

The kanban board (kanban.html) has two distinct column-advancement actions per card:
- **Copy Prompt** (`promptSelected` verb): copies the next-stage prompt to clipboard AND advances the card to the next column. Does NOT dispatch to a terminal.
- **Advance / Move** (`moveSelected` verb): advances the card to the next column AND auto-delivers the prompt to the appropriate agent terminal (CLI dispatch). Does NOT copy to clipboard.

The project.html kanban plans tab currently only has Copy Prompt on sidebar cards (which sends `copyKanbanPlanPrompt` → backend calls `promptSelected`). There is no Advance/Move button anywhere — the only way to advance a plan's column from the plans tab is via the column dropdown (which changes the column without dispatching to a terminal or copying a prompt).

### Root Cause

The project.html kanban meta-bar (`renderKanbanMetaBar()` in project.js) was built with management actions (Column, Complexity, Edit, Save, Cancel, Review, Upload, Log, Delete) but was never given the workflow-advancement actions that the kanban board has. The Copy Prompt button was added to sidebar cards as a convenience but never promoted to the meta-bar. The Advance/Move action was never implemented for the plans tab at all — it only exists on the kanban board.

## Metadata

**Complexity:** 5
**Tags:** frontend, backend, ui, ux, feature
**Project:** Browser Switchboard

## User Review Required

This plan adds a new backend verb (`advanceKanbanPlan`) and two new meta-bar buttons. The label derivation strategy (Step 2) and the shared-handler coordination (Step 5) involve design decisions that the user should review before implementation proceeds. No destructive operations are involved.

## Complexity Audit

### Routine

- Adding HTML buttons to an existing `innerHTML` template string in `renderKanbanMetaBar()`
- Wiring click handlers via `addEventListener` after innerHTML render (same pattern as existing meta-bar buttons)
- Removing Copy Prompt button from kanban plan sidebar card template string and its event listener
- Removing Copy Prompt from vestigial planning.js kanban card template and event listener
- Adding a response handler case for `kanbanPlanAdvanced` in the message listener

### Complex / Risky

- **New backend verb registration**: `advanceKanbanPlan` must be added to `protocol-catalog.json` (the source of truth for the auto-generated `verbAllowlist.ts`) AND to the hand-maintained `src/services/verbSchemas.ts`. Editing the auto-generated file directly will be overwritten on the next `npm run catalog:generate`.
- **Shared `kanbanPlanPromptCopied` handler**: this handler currently serves BOTH the kanban sidebar card Copy Prompt button AND the feature card Copy Prompt button (both use `.kanban-plan-copy-prompt[data-session-id]`). Updating it to only check `#kanban-meta-copy-prompt-btn` would silently break feature card feedback.
- **`moveSelected` return value**: the verb returns `{ success: true, column }` where `column` is the SOURCE column, not the target. The response handler must not rely on `targetColumn` being present.
- **Copy Prompt label derivation**: the kanban board derives labels from the NEXT column's role (`_getCopyLabel()` in planning.js). The features tab derives from the CURRENT column's stage (`_featureCopyPromptLabel()` in project.js). For custom columns these yield different labels. The plan must choose one approach and document the trade-off.

## Edge-Case & Dependency Audit

### Race Conditions

- The meta-bar is rebuilt via `innerHTML` on every plan selection. Click handlers must be registered after each render. The existing pattern (register listeners immediately after `metaBar.innerHTML = ...`) is safe — no race.
- The `fetchKanbanPlans` refresh after a successful Copy Prompt / Advance re-fetches the entire plan list. If the user selects a different plan between the action and the refresh, the selection may jump. This is the same behavior as the existing sidebar card Copy Prompt and is acceptable.

### Security

- No new attack surface. The `advanceKanbanPlan` handler calls `handleServiceVerb('moveSelected', ...)` which is an existing, validated verb on the kanban provider. The Planning panel's message handler already validates `sessionId` and `workspaceRoot` as strings.

### Side Effects

- **Copy Prompt** (`promptSelected`): copies prompt to clipboard AND advances the card to the next column. The plan list refreshes after success.
- **Advance** (`moveSelected`): advances the card AND dispatches the prompt to the appropriate agent terminal (CLI dispatch). If no terminal is configured for the next column's role, the column change succeeds but the terminal dispatch is a no-op (the kanban board already handles this gracefully).

### Dependencies & Conflicts

- This plan removes Copy Prompt from the kanban sidebar card template in project.js. Plan "relocate-copy-link-to-preview-meta-bars" removes Copy Link from the same template. Both plans edit the same template string (~line 1715) and the same event listener block. They must be coordinated — if both are implemented, the sidebar card's action row will have neither Copy Link nor Copy Prompt, leaving only the column badge and complexity dot.
- The `kanbanPlanPromptCopied` handler is shared with the feature card Copy Prompt button (which sends `copyFeaturePlannerPrompt`, also responded to with `kanbanPlanPromptCopied`). Any change to this handler must preserve feature card feedback.
- `verbAllowlist.ts` is auto-generated from `protocol-catalog.json`. The catalog must be edited and `npm run catalog:generate` run. Editing the generated file directly will be overwritten.

## Dependencies

- None

## Adversarial Synthesis

Key risks: (1) the shared `kanbanPlanPromptCopied` handler serves both kanban sidebar and feature card Copy Prompt buttons — replacing it to only check the meta-bar button silently breaks feature card feedback; (2) `verbAllowlist.ts` is auto-generated from `protocol-catalog.json` — editing it directly is overwritten on next generation; (3) `moveSelected` returns the source column, not the target — the response handler must not rely on `targetColumn`. Mitigations: handler checks both meta-bar and feature card buttons; catalog is the edit target with `npm run catalog:generate`; `targetColumn` is omitted from the response and the frontend relies on `fetchKanbanPlans` refresh.

## Proposed Changes

### `protocol-catalog.json` (source of truth for verb allowlist)

**Context:** `src/generated/verbAllowlist.ts` is auto-generated from this catalog. The header reads `// AUTO-GENERATED — do not edit; run npm run catalog:generate`. The existing `copyKanbanPlanPrompt` and `moveKanbanPlanColumn` entries are defined here in three places: the PLANNING_VERBS list, the verb definitions array, and the payload-keys map.

> **Superseded:** Edit `src/generated/verbAllowlist.ts` (~line 9) to add `'advanceKanbanPlan'` to the `PLANNING_VERBS` set.
> **Reason:** The file is auto-generated from `protocol-catalog.json`. Any direct edit is overwritten on the next `npm run catalog:generate`. The catalog is the source of truth.
> **Replaced with:** Add `advanceKanbanPlan` to `protocol-catalog.json` in three places, then run `npm run catalog:generate` to regenerate the allowlist.

**Logic:** Add the verb in three locations within `protocol-catalog.json`:

1. **PLANNING_VERBS list** (~line 1080, alphabetical, after `moveKanbanPlanColumn`): Add `"advanceKanbanPlan"` to the array. Actually, alphabetically it comes before `copyKanbanPlanPrompt` — insert at the correct alphabetical position.

2. **Verb definitions array** (~line 5603, near `moveKanbanPlanColumn`): Add:
```json
{
  "verb": "advanceKanbanPlan",
  "direction": "request-response",
  "provider": "Planning",
  "proposedService": "planningService"
}
```

3. **Payload-keys map** (~line 9229, near `moveKanbanPlanColumn`): Add:
```json
"advanceKanbanPlan": {
  "payloadKeys": [
    "type",
    "sessionId",
    "column",
    "workspaceRoot"
  ],
  "siteCount": 1
}
```

**Implementation:** After editing the catalog, run `npm run catalog:generate` to regenerate `src/generated/verbAllowlist.ts`. Verify `advanceKanbanPlan` appears in the `PLANNING_VERBS` set.

**Edge Cases:** The catalog has a call-site tracking section that auto-discovers `vscode.postMessage` calls. After implementation, re-running the catalog generator will pick up the new call site in project.js automatically. The `siteCount` may need to be adjusted after the generator runs — let the generator compute it.

### `src/services/verbSchemas.ts` (hand-maintained schema)

> **Superseded:** Add `advanceKanbanPlan` schema to `src/generated/verbSchemas.ts` (~line 637).
> **Reason:** The file is at `src/services/verbSchemas.ts`, not `src/generated/`. It is hand-maintained (contains code comments and per-field annotations), not auto-generated.
> **Replaced with:** Add the schema to `src/services/verbSchemas.ts` (~line 637, near `moveKanbanPlanColumn`).

**Context:** This file is hand-maintained despite the `generated/` directory name on the allowlist. The existing `moveKanbanPlanColumn` schema (line 637) has detailed comments explaining field accuracy.

**Logic:** Add after the `moveKanbanPlanColumn` entry:
```typescript
advanceKanbanPlan: {
    fields: {
        sessionId: { type: 'string' },
        column: { type: 'string' },
        workspaceRoot: { type: 'string' },
    },
},
```

**Edge Cases:** The `column` field is the CURRENT column (source), not the target. The backend handler passes it to `handleServiceVerb('moveSelected', { column, ... })` which uses it to compute the next column internally.

### `src/services/PlanningPanelProvider.ts` (backend handler)

**Context:** The existing `copyKanbanPlanPrompt` handler (~line 3850) calls `handleServiceVerb('promptSelected', { sessionIds: [sessionId], column, workspaceRoot })` and posts `{ type: 'kanbanPlanPromptCopied', success, sessionId, targetColumn }`. The `moveKanbanPlanColumn` handler (~line 3904) calls a different command (`switchboard.moveKanbanCardByPlanFileWithReason`). The new `advanceKanbanPlan` handler should mirror `copyKanbanPlanPrompt` but call `moveSelected` instead.

**Logic:** Add a new case `advanceKanbanPlan` after the `moveKanbanPlanColumn` case (~line 3930):

```typescript
case 'advanceKanbanPlan': {
    const sessionId = String(msg.sessionId || '');
    const column = String(msg.column || '');
    const wsRoot = String(msg.workspaceRoot || workspaceRoot);
    if (!sessionId) {
        this.postMessageToProjectWebview({ type: 'kanbanPlanAdvanced', success: false, sessionId: '', error: 'No sessionId' });
        break;
    }
    if (!this._kanbanProvider) {
        this.postMessageToProjectWebview({ type: 'kanbanPlanAdvanced', success: false, sessionId, error: 'No kanban provider' });
        break;
    }
    try {
        const result = await this._kanbanProvider.handleServiceVerb('moveSelected', {
            sessionIds: [sessionId],
            column,
            workspaceRoot: wsRoot
        });
        // moveSelected returns { success: true, column } where column is the SOURCE
        // column, not the target. Do not extract targetColumn from the result.
        this.postMessageToProjectWebview({
            type: 'kanbanPlanAdvanced',
            success: !!result?.success,
            sessionId
        });
    } catch (err) {
        this.postMessageToProjectWebview({ type: 'kanbanPlanAdvanced', success: false, sessionId, error: String(err) });
    }
    break;
}
```

> **Superseded:** The response message should include `targetColumn`: `{ type: 'kanbanPlanAdvanced', success, sessionId, targetColumn }`.
> **Reason:** `moveSelected` returns `{ success: true, column }` where `column` is the SOURCE column (KanbanProvider.ts:10768). It does NOT return the target column. The backend handler cannot extract `targetColumn` from the result without an additional `_getNextColumnId` call, which is unnecessary since the frontend refreshes the plan list on success.
> **Replaced with:** Omit `targetColumn` from the response. The frontend handler relies on `fetchKanbanPlans` refresh to show the updated column.

**Edge Cases:**
- `moveSelected` for `PLAN REVIEWED` uses dynamic complexity routing (partitions by complexity into LEAD CODED / CODER CODED / INTERN CODED). The backend handles this internally — the handler just passes `column: 'PLAN REVIEWED'` and `moveSelected` does the routing.
- If no coding agent is enabled, `moveSelected` returns `{ success: false, error: 'No coding agent is currently enabled.' }` and shows a UI error message. The handler passes this through as `success: false`.

### `src/webview/project.js` — `renderKanbanMetaBar()` (add Copy Prompt + Advance buttons)

**Context:** `renderKanbanMetaBar()` (~line 1968) builds the meta-bar via `innerHTML` with three groups: left (Column + Complexity + Edit/Save/Cancel), right (Review/Upload/Log/Delete). The Copy Prompt and Advance buttons should go in the right group, before Review.

**Logic — Copy Prompt button:**

> **Superseded:** Use `_featureCopyPromptLabel()` for the Copy Prompt label derivation, since it's already in the same file.
> **Reason:** The plan's stated goal is to "mirror the kanban board buttons." The kanban board uses `_getCopyLabel()` (planning.js:5381) which derives from the NEXT column's role. `_featureCopyPromptLabel()` (project.js:2318) derives from the CURRENT column's stage. For custom columns these yield different labels. Using a different label derivation does not truly mirror the board.
> **Replaced with:** Port `_getCopyLabel()` from planning.js to project.js (as a private function `_kanbanCopyPromptLabel(plan)`) and use it for the kanban tab's Copy Prompt button. This matches the board's next-column derivation. The features tab continues to use `_featureCopyPromptLabel()` unchanged (it's a management view, not a board column — see the existing comment at project.js:2308).

Port `_getCopyLabel()` from planning.js:5381:
```javascript
function _kanbanCopyPromptLabel(plan) {
    let copyLabel = 'Copy Prompt';
    const cols = _kanbanAvailableColumns.map(c => c.id);
    const idx = cols.indexOf(plan.column);
    if (idx < 0 || idx >= cols.length - 1) return copyLabel;

    const nextDef = _kanbanAvailableColumns[idx + 1];
    if (nextDef) {
        const isCustom = nextDef.kind === 'custom-user' || nextDef.kind === 'custom-agent';
        if (isCustom) {
            copyLabel = 'Copy advance prompt';
        } else if (nextDef.role === 'planner' || nextDef.id === 'PLAN REVIEWED') {
            copyLabel = 'Copy planning prompt';
        } else if (['lead', 'coder', 'intern'].includes(nextDef.role) || nextDef.kind === 'coded') {
            copyLabel = 'Copy coder prompt';
        } else if (nextDef.role === 'reviewer' || nextDef.id === 'CODE REVIEWED') {
            copyLabel = 'Copy review prompt';
        } else {
            copyLabel = 'Copy advance prompt';
        }
    }
    return copyLabel;
}
```

Add the Copy Prompt button to the meta-bar innerHTML, in the right group before Review:
```html
${plan.sessionId && copyPromptLabel ? `<button class="strip-btn" id="kanban-meta-copy-prompt-btn">${escapeHtml(copyPromptLabel)}</button>` : ''}
```

Where `copyPromptLabel` is computed via `_kanbanCopyPromptLabel(plan)` before the innerHTML template.

**Logic — Advance button:**

Compute `nextColumn` via `_optimisticNextColumn(plan.column)` (existing function at line 1608). Note: `_optimisticNextColumn` returns `null` for `PLAN REVIEWED` (line 1609) because the target is complexity-routed. This means plans in PLAN REVIEWED won't get an Advance button. This is acceptable — the user can use Copy Prompt for PLAN REVIEWED (which also advances) or the column dropdown.

> **Superseded:** The Advance button should be hidden when `_optimisticNextColumn()` returns null, and the `kanbanPlanAdvanced` response should include `targetColumn`.
> **Reason:** `_optimisticNextColumn` returns null for PLAN REVIEWED (complexity-routed target), so the Advance button won't appear for PLAN REVIEWED plans. This is a deliberate limitation, not a bug — Copy Prompt still works for PLAN REVIEWED. Additionally, `moveSelected` doesn't return `targetColumn`, so the response can't include it.
> **Replaced with:** The Advance button is hidden when `_optimisticNextColumn()` returns null (same as the plan originally specified). The `kanbanPlanAdvanced` response omits `targetColumn`. The frontend relies on `fetchKanbanPlans` refresh.

Add the Advance button to the meta-bar innerHTML, after Copy Prompt:
```html
${plan.sessionId && nextColumn ? `<button class="strip-btn" id="kanban-meta-advance-btn" title="Advance to ${escapeHtml(nextColumnLabel)} and dispatch to terminal">Advance</button>` : ''}
```

Where `nextColumn` is computed via `_optimisticNextColumn(plan.column)` and `nextColumnLabel` is the label from `_kanbanAvailableColumns.find(c => c.id === nextColumn)?.label || nextColumn`.

**Implementation — wire click handlers after innerHTML render:**

```javascript
const copyPromptBtn = document.getElementById('kanban-meta-copy-prompt-btn');
if (copyPromptBtn) {
    copyPromptBtn.addEventListener('click', () => {
        copyPromptBtn.textContent = 'Copying…';
        vscode.postMessage({
            type: 'copyKanbanPlanPrompt',
            sessionId: plan.sessionId,
            column: plan.column,
            workspaceRoot: plan.workspaceRoot
        });
    });
}

const advanceBtn = document.getElementById('kanban-meta-advance-btn');
if (advanceBtn) {
    advanceBtn.addEventListener('click', () => {
        advanceBtn.textContent = 'Advancing…';
        advanceBtn.disabled = true;
        vscode.postMessage({
            type: 'advanceKanbanPlan',
            sessionId: plan.sessionId,
            column: plan.column,
            workspaceRoot: plan.workspaceRoot
        });
    });
}
```

**Edge Cases:**
- Both buttons require `plan.sessionId`. Plans with only a `planFile` (no sessionId) get neither button.
- Terminal columns (no next column): `_optimisticNextColumn()` returns null → Advance button hidden. `_kanbanCopyPromptLabel()` returns 'Copy Prompt' (default) for the last column — but the Copy Prompt button should also be hidden for terminal columns. Add a guard: only show Copy Prompt when `nextColumn` is non-null OR the column is not terminal. Actually, `promptSelected` on the backend still copies the prompt even when there's no next column (it just doesn't advance — see KanbanProvider.ts:10982). So Copy Prompt CAN be shown for terminal columns — it copies without advancing. Keep the Copy Prompt button visible as long as `sessionId` exists; only hide Advance for terminal columns.

### `src/webview/project.js` — `kanbanPlanPromptCopied` handler (update for meta-bar button)

**Context:** The existing handler (line 879) queries `.kanban-plan-copy-prompt[data-session-id="${msg.sessionId}"]` — this matches BOTH the kanban sidebar card button (line 1727) AND the feature card button (line 2367), since both use the same CSS class and data attribute. The feature card Copy Prompt sends `copyFeaturePlannerPrompt` which also responds with `kanbanPlanPromptCopied` (PlanningPanelProvider.ts:3893).

> **Superseded:** Update the handler to check `#kanban-meta-copy-prompt-btn` instead of `.kanban-plan-copy-prompt[data-session-id]`.
> **Reason:** This would silently break Copy Prompt feedback on every feature card. The feature card button (line 2367) uses `.kanban-plan-copy-prompt[data-session-id]` and sends `copyFeaturePlannerPrompt`, which responds with `kanbanPlanPromptCopied`. If the handler only checks the meta-bar button, feature card clicks would copy the prompt (backend works) but show NO visual feedback.
> **Replaced with:** The handler must check BOTH the meta-bar button (`#kanban-meta-copy-prompt-btn`) AND the sidebar/feature card button (`.kanban-plan-copy-prompt[data-session-id]`). This preserves feature card feedback while adding meta-bar feedback.

**Logic:**
```javascript
case 'kanbanPlanPromptCopied': {
    // Check meta-bar button first (kanban tab)
    const metaBtn = document.getElementById('kanban-meta-copy-prompt-btn');
    if (metaBtn) {
        const oldText = metaBtn.textContent;
        metaBtn.textContent = msg.success ? 'Copied!' : 'Failed';
        metaBtn.disabled = true;
        setTimeout(() => { metaBtn.textContent = oldText; metaBtn.disabled = false; }, 2000);
    }
    // Also check sidebar/feature card button (features tab still uses card-level Copy Prompt)
    const cardBtn = msg.sessionId
        ? document.querySelector(`.kanban-plan-copy-prompt[data-session-id="${msg.sessionId}"]`)
        : null;
    if (cardBtn) {
        const oldText = cardBtn.textContent;
        cardBtn.textContent = msg.success ? 'Copied!' : 'Failed';
        cardBtn.disabled = true;
        setTimeout(() => { cardBtn.textContent = oldText; cardBtn.disabled = false; }, 2000);
        if (msg.success && msg.targetColumn) {
            const card = cardBtn.closest('.kanban-plan-item, .feature-plan-item');
            if (card) {
                const badge = card.querySelector('.kanban-column-badge.clickable');
                if (badge) {
                    const colDef = _kanbanAvailableColumns.find(c => c.id === msg.targetColumn);
                    badge.textContent = colDef ? colDef.label : msg.targetColumn;
                    badge.dataset.column = msg.targetColumn;
                }
            }
        }
    }
    if (msg.success && (activeTab === 'kanban' || activeTab === 'features')) {
        vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
    }
    break;
}
```

**Edge Cases:** When the kanban tab is active, only the meta-bar button exists (the sidebar card button is being removed in Step 4). When the features tab is active, only the card button exists (the feature meta-bar does not have a Copy Prompt button — that's out of scope for this plan). The handler safely checks both — whichever exists gets feedback.

### `src/webview/project.js` — `kanbanPlanAdvanced` response handler (new)

**Context:** Add a new case in the message listener (~line 907, after `kanbanPlanPromptCopied`).

**Logic:**
```javascript
case 'kanbanPlanAdvanced': {
    const btn = document.getElementById('kanban-meta-advance-btn');
    if (btn) {
        btn.textContent = msg.success ? 'Advanced' : 'Failed';
        setTimeout(() => { btn.disabled = false; btn.textContent = 'Advance'; }, 2000);
    }
    if (msg.success) {
        vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
    }
    break;
}
```

**Edge Cases:** The button text restores to 'Advance' after 2s regardless of success/failure. On success, the plan list refreshes via `fetchKanbanPlans`, which will show the updated column.

### `src/webview/project.js` — Remove Copy Prompt from kanban sidebar card

**Context:** The kanban plan card template (~line 1727) has a Copy Prompt button: `${plan.sessionId ? \`<button class="kanban-plan-copy-prompt" ...>Copy Prompt</button>\` : ''}`. Its event listener is at ~lines 1754-1774.

**Logic:** Remove the Copy Prompt button from the template string (line 1727). Remove the `copyPromptBtn` event listener block (lines 1754-1774).

**Edge Cases:** The Copy Link button on the same card (line 1726) is NOT removed by this plan — that's handled by the "relocate-copy-link" plan. If both plans are implemented, coordinate the template edit.

### `src/webview/planning.js` — Remove Copy Prompt from vestigial kanban card

**Context:** planning.js has vestigial kanban plan card rendering (~line 5674) from when the kanban tab lived in planning.html. The Copy Prompt button template is at line 5674-5677 and its event listener at lines 5723-5740.

**Logic:** Remove the Copy Prompt button from the template string (lines 5674-5677). Remove the `copyPromptBtn` event listener block (lines 5723-5740).

**Edge Cases:** This code is dead (the kanban tab has moved to project.html), but editing it keeps the codebase consistent. The Copy Link button on the same vestigial card (line 5673) is removed by the "relocate-copy-link" plan.

## Verification Plan

### Automated Tests

No new automated tests are required for this change. The existing test suite covers verb schema validation and message handler routing. The new verb (`advanceKanbanPlan`) should be picked up by the catalog generator's validation.

### Manual Verification

1. **Copy Prompt in meta-bar**: Select a plan in the kanban tab → verify Copy Prompt button appears in the meta-bar with the correct label (e.g., "Copy coder prompt" for PLAN REVIEWED plans, derived from the NEXT column's role) → click it → verify prompt is on the clipboard → verify the plan's column advances (plan list refreshes) → verify the sidebar card no longer has a Copy Prompt button

2. **Advance in meta-bar**: Select a non-terminal, non-PLAN REVIEWED plan → verify Advance button appears in the meta-bar → click it → verify the plan advances to the next column (plan list refreshes) → verify the prompt was dispatched to the appropriate terminal (check terminal output) → verify the button shows "Advanced" feedback

3. **PLAN REVIEWED**: Select a plan in PLAN REVIEWED → verify Advance button is NOT shown (`_optimisticNextColumn` returns null) → verify Copy Prompt button IS shown (labeled "Copy coder prompt") → click Copy Prompt → verify prompt copied and plan advances to the complexity-routed coder column

4. **Terminal column**: Select a plan in COMPLETED → verify neither Copy Prompt nor Advance buttons appear in the meta-bar (no sessionId for completed plans, or no next column)

5. **No sessionId**: Select a plan with only a planFile (no sessionId) → verify neither Copy Prompt nor Advance buttons appear

6. **Feature card feedback preserved**: Switch to the Features tab → select a feature → click Copy Prompt on the feature sidebar card → verify "Copied!" feedback appears on the card button (the shared handler still checks `.kanban-plan-copy-prompt[data-session-id]`)

7. **Backend handler**: Send `advanceKanbanPlan` message with a valid sessionId → verify the backend calls `moveSelected` on the kanban provider → verify the plan's column changes → verify the response message `kanbanPlanAdvanced` is received with `success: true`

8. **Verb schema/allowlist**: Run `npm run catalog:generate` → verify `advanceKanbanPlan` appears in the `PLANNING_VERBS` set in `src/generated/verbAllowlist.ts` → verify `advanceKanbanPlan` has a valid schema entry in `src/services/verbSchemas.ts`

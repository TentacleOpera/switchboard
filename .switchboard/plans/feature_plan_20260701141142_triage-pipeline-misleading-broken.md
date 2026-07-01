# Fix the Triage Pipeline: Wire Automation Import to Agent Dispatch + Fix Broken Defaults

## Goal

The **ENABLE TRIAGE PIPELINE** button in the ClickUp and Linear setup tabs creates a project filter and an automation rule, but the pipeline is broken at the wiring step: the automation service imports tagged tickets as plan files but **never moves them to the rule's `targetColumn`**, so the existing agent dispatch system is never triggered. The button also sets wrong column defaults (`CREATED` instead of `TICKET UPDATER`, `DONE` instead of `COMPLETED`), and the UI copy promises "route to triage agent" without explaining the actual flow. This plan fixes the wiring, the defaults, and the copy so the pipeline actually works end-to-end.

### Problem Analysis & Root Cause

**The dispatch system exists and works.** When a card is moved to a column with a role (e.g. `TICKET UPDATER` has `role: 'ticket_updater'`), the `triggerAction` handler in `KanbanProvider.ts` (line 5615) resolves the role and calls `switchboard.triggerAgentFromKanban` to dispatch the agent. The `_remoteDispatchColumnAgent` method (line 1631) shows the exact programmatic pattern: move card → resolve role → dispatch.

**What the triage button sets up** (`TaskViewerProvider.handleEnableTriagePipeline`, lines 4925–5044):
1. Enables sync flags (`autoPullEnabled`, `realTimeSyncEnabled`, etc.)
2. Creates an automation rule: `triggerTag: 'triage'`, `targetColumn: 'CREATED'`, `finalColumn: 'DONE'`, `writeBackOnComplete: true`
3. Creates a "Bug Triage — X" project in the DB
4. Calls `initializeIntegrationAutoPull()` + `applyLiveSyncConfig()`

**Where the pipeline breaks:**

The automation services (`ClickUpAutomationService.poll()`, `LinearAutomationService.poll()`) poll for tagged tickets, create plan files on disk, and the file watcher imports them to the `CREATED` column. But **`rule.targetColumn` is never read by any backend code** — it's collected in the setup UI (labeled "Start column"), stored in the rule config, but the automation service never moves the card to that column. The plan sits in `CREATED` and no agent is dispatched.

Confirmed by grep: `rule.targetColumn` is only referenced in `setup.html` (the UI dropdown) — zero references in `ClickUpAutomationService.ts`, `LinearAutomationService.ts`, or `KanbanProvider.ts`. The field is dead data.

**Additional bugs:**
1. **`targetColumn: 'CREATED'`** — even if the wiring existed, CREATED has no triage agent role. The triage button should set `targetColumn: 'TICKET UPDATER'` (which has `role: 'ticket_updater'`, `dragDropMode: 'prompt'`).
2. **`finalColumn: 'DONE'`** — `DONE` is not a real column. The standard completion column is `COMPLETED` (`agentConfig.ts` line 112). The write-back trigger (`plan.kanbanColumn === rule.finalColumn`) will never fire because no card ever reaches a `DONE` column.
3. **No busy feedback** — the button gives no click animation (addressed comprehensively in a separate plan; this plan includes a minimal triage-specific busy state).
4. **No setup gating** — the button is clickable before the integration is configured.
5. **Misleading copy** — "route them to the triage agent, sync verdicts back" is aspirational, not accurate. The actual flow is: import tagged tickets → move to TICKET UPDATER column → dispatch ticket_updater agent → agent processes → card moves to COMPLETED → verdict written back to ticket.

**The fix:** After the automation poll creates new plan files, the KanbanProvider moves each new plan to its rule's `targetColumn` and triggers the column's agent dispatch. This wires the existing automation import to the existing dispatch system — no architecture changes needed.

## Metadata

- **Tags:** `ui`, `setup`, `bugfix`, `triage`, `automation`, `dispatch`, `clickup`, `linear`
- **Complexity:** 5/10
- **Files touched:** `src/services/ClickUpAutomationService.ts`, `src/services/LinearAutomationService.ts`, `src/services/KanbanProvider.ts`, `src/services/TaskViewerProvider.ts`, `src/webview/setup.html` (5 files)
- **Shipped-state impact:** The triage button has shipped. Users who clicked it have a rule with `targetColumn: 'CREATED'` and `finalColumn: 'DONE'`. After this fix, the automation service will start moving new imports to `targetColumn` and dispatching agents. Existing rules with wrong column values will be corrected when the user re-clicks the triage button (the rule is replaced by name). Users who don't re-click will have their tickets imported to CREATED as before (no regression — `CREATED` has no role, so no dispatch fires, same as today). No data migration needed — the rule fields already exist in the config, they're just ignored until this fix wires them up.

## User Review Required

No review gate required. This fixes a broken feature by wiring existing systems together. No data loss, no schema changes, no new message types.

## Complexity Audit

### Routine
- Enrich `ClickUpAutomationPollResult` / `LinearAutomationPollResult` to include created plan files + matched rule names (so the KanbanProvider knows which plans to move and where).
- After `automation.poll()` in the KanbanProvider's automation callback, move each newly-created plan to its rule's `targetColumn` and trigger agent dispatch (reusing the `_remoteDispatchColumnAgent` pattern).
- Fix the triage button defaults in `handleEnableTriagePipeline`: `targetColumn: 'TICKET UPDATER'`, `finalColumn: 'COMPLETED'`.
- Fix the UI copy in `setup.html` to accurately describe the pipeline.
- Add minimal busy state + setup gating to the triage buttons.

### Complex / Risky
- **Timing: file watcher vs. automation poll.** The automation service writes the plan file to disk. The file watcher imports it into the DB asynchronously. The KanbanProvider's automation callback runs after `automation.poll()` returns. The plan may not yet be in the DB when the callback tries to move it. **Mitigation:** the poll result returns the plan file paths (not session IDs). The KanbanProvider can wait for the file watcher to import the plan (or import it directly), then move it by plan file path using `moveCardToColumnByPlanFile` (which already exists, line 1606). Alternatively, the automation service can insert the plan record directly into the DB (it already has a DB reference for write-back) and return the session ID.
- **Dispatch mode: `TICKET UPDATER` has `dragDropMode: 'prompt'`.** This means dispatch copies a prompt to the clipboard rather than auto-dispatching to a terminal. This is correct for ticket triage — the user reviews the prompt and pastes it into their agent. The `triggerAction` handler already handles `dragDropMode: 'prompt'` (line 5633). No change needed.
- **`hideWhenNoAgent: true` on `TICKET UPDATER`.** If no `ticket_updater` agent is configured, the column is hidden and dispatch fails silently. The triage button should check if the role is available and warn if not. The `_canAssignRole` method (line 1640) already handles this check.

## Edge-Case & Dependency Audit

- **Plan not yet in DB when automation callback fires:** the automation service writes the plan file, but the file watcher imports it asynchronously. The KanbanProvider callback runs immediately after `poll()` returns. **Fix:** the automation service already has a DB reference (it uses `db.getAllPlans` for write-back). Enrich it to insert the plan record directly after writing the file, and return the session/plan ID + target column in the poll result. This avoids the file-watcher race entirely.
- **Duplicate import:** the automation service uses `flag: 'wx'` (exclusive create) on the plan file and checks `findPlanByClickUpTaskId` / `findPlanByLinearIssueId` before creating. No duplicates.
- **Rule with `targetColumn: 'CREATED'` (existing rules from prior triage clicks):** `CREATED` has no role (`_columnToRole('CREATED')` returns `null`), so no dispatch fires. The plan stays in CREATED as before — no regression. The user can re-click the triage button to update the rule with correct defaults, or manually edit the rule's start column in the automation UI.
- **`TICKET UPDATER` column hidden (`hideWhenNoAgent: true`):** if no `ticket_updater` agent is configured, the column doesn't appear on the board and dispatch fails. The triage success message should warn: "Configure a Ticket Updater agent to complete the pipeline." The user can configure one in the Prompts/Agents tab.
- **Multiple automation rules matching the same ticket:** the automation service uses the first matched rule (line 257). The poll result should include the matched rule name so the KanbanProvider knows which `targetColumn` to use.
- **Mutual-exclusivity plan dependency:** the `remote-control-triage-mutual-exclusivity.md` plan (PLAN REVIEWED, not coded) hooks into `handleEnableTriagePipeline`. This fix doesn't change the method signature in a breaking way — it only changes the default values set inside the method. The mutual-exclusivity plan's `disableRemoteControlForTriage` call (inserted before `initializeIntegrationAutoPull`) still works.
- **`writeBackOnComplete` now works:** with `finalColumn: 'COMPLETED'` (a real column), the write-back trigger (`plan.kanbanColumn === rule.finalColumn`) will fire when the card reaches COMPLETED. The automation service's write-back logic (`ClickUpAutomationService` line 333, `LinearAutomationService` line 476) writes the plan content back to the ticket. This is the "sync verdicts back" part — it now works because the card can actually reach `COMPLETED`.

## Proposed Changes

### File: `src/services/ClickUpAutomationService.ts`

#### 1. Enrich the poll result to include created plans + rule info

```ts
export interface ClickUpAutomationCreatedPlan {
    planFile: string;
    clickupTaskId: string;
    ruleName: string;
    targetColumn: string;
}

export interface ClickUpAutomationPollResult {
    created: number;
    skipped: number;
    writeBacks: number;
    errors: string[];
    createdPlans: ClickUpAutomationCreatedPlan[];  // NEW
}
```

In `poll()`, after successfully writing the plan file (line 294), push to `result.createdPlans`:

```ts
result.createdPlans.push({
    planFile,
    clickupTaskId: normalizedTaskId,
    ruleName: matchedRule.name,
    targetColumn: matchedRule.targetColumn
});
```

Initialize `createdPlans: []` in the result object.

### File: `src/services/LinearAutomationService.ts`

#### 2. Same enrichment for Linear

```ts
export interface LinearAutomationCreatedPlan {
    planFile: string;
    linearIssueId: string;
    ruleName: string;
    targetColumn: string;
}

export interface LinearAutomationPollResult {
    created: number;
    skipped: number;
    writeBacks: number;
    errors: string[];
    createdPlans: LinearAutomationCreatedPlan[];  // NEW
}
```

Same pattern — push to `result.createdPlans` after each successful file write.

### File: `src/services/KanbanProvider.ts`

#### 3. After automation poll, move new plans to targetColumn + dispatch

In `_configureClickUpAutomation` (line 1912), after `const pollResult = await automation.poll()`:

```ts
const pollResult = await automation.poll();
// Wire newly-imported plans to their target column + dispatch the column's agent
if (pollResult.createdPlans && pollResult.createdPlans.length > 0) {
    const db = this._getKanbanDb(workspaceRoot);
    const workspaceId = await db.getWorkspaceId() || '';
    for (const created of pollResult.createdPlans) {
        if (!created.targetColumn || created.targetColumn === 'CREATED') { continue; }
        // Wait for the file watcher to import the plan (or import directly)
        // The plan file path is relative to the workspace root
        const relPath = path.relative(workspaceRoot, created.planFile);
        let plan = await db.getPlanByPlanFile(relPath, workspaceId);
        if (!plan) {
            // Plan not yet imported by the watcher — skip this cycle, it will be
            // imported on the next poll cycle's write-back check. Alternatively,
            // insert directly here (the automation service already has the content).
            continue;
        }
        // Move to target column
        await this.moveCardToColumnByPlanFile(workspaceRoot, relPath, created.targetColumn);
        // Dispatch the column's agent (reuses the proven remote-dispatch pattern)
        const sessionId = plan.sessionId || '';
        if (sessionId) {
            await this._remoteDispatchColumnAgent(workspaceRoot, sessionId, created.targetColumn);
        }
    }
    this._scheduleBoardRefresh(workspaceRoot);
}
```

Repeat the same pattern in `_configureLinearAutomation` (line 1978) after `const pollResult = await automation.poll()`.

**Note:** The `_remoteDispatchColumnAgent` method (line 1631) is currently `private`. It's already called from within `KanbanProvider`, so no visibility change needed. It resolves the column's role and calls `switchboard.triggerAgentFromKanban`.

### File: `src/services/TaskViewerProvider.ts`

#### 4. Fix the triage button defaults in `handleEnableTriagePipeline`

In the ClickUp branch (≈ line 4976):
```ts
// BEFORE:
targetColumn: 'CREATED',
finalColumn: 'DONE',

// AFTER:
targetColumn: 'TICKET UPDATER',
finalColumn: 'COMPLETED',
```

In the Linear branch (≈ line 5018):
```ts
// BEFORE:
targetColumn: 'CREATED',
finalColumn: 'DONE',

// AFTER:
targetColumn: 'TICKET UPDATER',
finalColumn: 'COMPLETED',
```

### File: `src/webview/setup.html`

#### 5. Fix the description text (lines 769 and 966)

Replace:
```html
<div class="hint-text" style="margin-top:6px;">
    Auto-pull bugs in, route them to the triage agent, sync verdicts back. Creates a "Bug Triage" board with sensible defaults — all editable afterward.
</div>
```
With:
```html
<div class="hint-text" style="margin-top:6px;">
    Enables auto-pull (15-min interval), creates a <strong>"Bug Triage"</strong> project filter, and adds an automation rule that imports <code>triage</code>-tagged tickets, moves them to the <strong>Ticket Updater</strong> column, and dispatches the ticket_updater agent. When the card reaches <strong>Completed</strong>, the result is written back to the ticket. Requires a configured Ticket Updater agent (Prompts tab) and the integration to be set up first.
</div>
```

#### 6. Remove "(ONE-CLICK)" from button labels (lines 767, 964)

```html
<button id="btn-enable-triage-clickup" class="action-btn w-full" style="margin-top: 8px;">⚡ ENABLE TRIAGE PIPELINE</button>
<!-- (repeat for linear) -->
```

#### 7. Add busy state to triage click handlers (lines 3454, 3461)

```js
document.getElementById('btn-enable-triage-clickup')?.addEventListener('click', () => {
    let token = document.getElementById('clickup-token-input')?.value.trim() || '';
    if (token === '**********') { token = ''; }
    const btn = document.getElementById('btn-enable-triage-clickup');
    const resultEl = document.getElementById('clickup-triage-result');
    if (btn) { btn.disabled = true; btn.textContent = 'ENABLING…'; }
    if (resultEl) { resultEl.style.color = 'var(--text-secondary)'; resultEl.textContent = ''; }
    vscode.postMessage({ type: 'enableTriagePipeline', provider: 'clickup', token });
});
```

#### 8. Fix the success message + restore button (lines 4781–4793)

```js
case 'triagePipelineResult': {
    const resultEl = document.getElementById(message.provider === 'linear' ? 'linear-triage-result' : 'clickup-triage-result');
    const btn = document.getElementById(message.provider === 'linear' ? 'btn-enable-triage-linear' : 'btn-enable-triage-clickup');
    if (btn) { btn.disabled = false; btn.textContent = '⚡ ENABLE TRIAGE PIPELINE'; }
    if (resultEl) {
        if (message.success) {
            const projName = message.projectName || 'Bug Triage';
            resultEl.style.color = 'var(--accent-green, var(--text-secondary))';
            resultEl.innerHTML = `✓ Triage pipeline enabled — project <strong>"${projName}"</strong> created. Tagged tickets will auto-import to the <strong>Ticket Updater</strong> column and dispatch the ticket_updater agent. Verdicts are written back on completion.`;
        } else {
            resultEl.style.color = 'var(--accent-red)';
            resultEl.textContent = message.error || 'Failed to enable triage pipeline.';
        }
    }
    break;
}
```

## Verification Plan

1. **Compile check:** `npm run compile`.
2. **End-to-end pipeline test (ClickUp):**
   - Configure ClickUp (token, folder, list, column mappings).
   - Click **ENABLE TRIAGE PIPELINE**. Confirm button shows "ENABLING…" then success message mentioning "Ticket Updater column" and "ticket_updater agent."
   - In ClickUp, tag a task with `triage` and wait for the next poll cycle (≤15 min).
   - Confirm: the task appears as a plan in the Kanban, is moved to the **TICKET UPDATER** column, and the ticket_updater agent prompt is generated (clipboard or terminal, depending on `dragDropMode`).
   - Move the card to **COMPLETED**. Confirm the plan content is written back to the ClickUp task (description or comment).
3. **End-to-end pipeline test (Linear):** Same flow with Linear.
4. **Wrong-defaults regression test:** If a user has an existing triage rule with `targetColumn: 'CREATED'` / `finalColumn: 'DONE'`, confirm new tickets still import to CREATED (no dispatch, no crash). Re-click the triage button → confirm the rule is updated to `TICKET UPDATER` / `COMPLETED`.
5. **No ticket_updater agent configured:** Enable triage, import a tagged ticket. Confirm the card moves to TICKET UPDATER column but dispatch is skipped silently (no error, no crash). The success message should warn about configuring a Ticket Updater agent.
6. **File-watcher race test:** If the plan isn't yet in the DB when the automation callback tries to move it, confirm no crash — the plan stays in CREATED and is picked up on the next poll cycle (or by manual drag).
7. **Write-back test:** Confirm `writeBackOnComplete` fires when card reaches `COMPLETED` (not `DONE`). The write-back appends the plan content to the ticket.
8. **Busy state test:** Confirm the triage button disables + shows "ENABLING…" during the request, then restores.

# Add Per-Card Action Buttons to Epic Cards in the Epics Tab

## Goal

Add inline action buttons (Copy Link, Send to Planner, Copy Planning Prompt) directly on each epic card in the Epics tab of `project.html`, so users can action epics without switching to the kanban board. This mirrors the per-card buttons that already exist on regular plan cards in the Kanban tab and supports the split-mode workflow (plan with planner → orchestrate) entirely from the Epics tab.

### Problem analysis & root cause

The Epics tab renders epic cards via `renderEpicList` (`project.js:1285-1324`). Each card shows only the topic, workspace/time metadata, and a subtasks accordion. All epic actions (Orchestrate, +Subtask, Delete) live in the **meta-bar** (`renderEpicMetaBar`, `project.js:1345-1412`) which only appears after selecting an epic and is positioned in the preview pane — not on the card itself.

Meanwhile, regular plan cards in the Kanban tab (`project.js:928-944`) already have inline per-card buttons: "Copy Link" (copies the plan file path via `toAgentRef`) and "Copy Prompt" (sends `copyKanbanPlanPrompt` to the backend, which calls `switchboard.copyPlanFromKanban`). Epic cards have none of these.

The root cause is that the epic-orchestration-onramp plan (Phase 2) added epic management actions only to the meta-bar, not to the cards themselves. The "How to run an epic" explainer (`project.html:1486`) recommends dragging the epic to the Planner column for split mode — but the user has to go to the kanban board to do that. Adding "Send to Planner" (move to the CREATED column, where the planner agent processes plans) and "Copy Planning Prompt" (copy the planner's batch prompt for the epic with expanded subtasks) as per-card buttons eliminates the need to manage epics on the board.

### Critical code-tracing findings (verified during plan improvement)

Four bugs were found in the original plan's proposed implementation by tracing the actual code paths. The corrected approach below addresses all four:

1. **`copyPlanFromKanban` does NOT expand epic subtasks.** The command routes to `TaskViewerProvider._handleCopyPlanLink` (`TaskViewerProvider.ts:13644`), which builds a single-element `BatchPromptPlan` (line 13694: `{ topic, absolutePath, workingDir }`) and calls `generateUnifiedPrompt(role, [plan], ...)`. It never calls `_cardsToPromptPlans`. Reusing it for epic planner prompts would copy only the epic's own plan file — no subtasks, no `EPIC_ORCHESTRATION_DIRECTIVE`.

2. **`'planner'` is a ROLE, not a COLUMN.** `columnToPromptRole` (`agentPromptBuilder.ts:1250`) maps column IDs to roles (`CREATED`→`planner`). Passing `'planner'` as the `column` argument returns `null`, causing `_handleCopyPlanLink` to fall back to role `'coder'` (line 13690). The handler would generate a coder prompt, not a planner prompt.

3. **`_kanbanAvailableColumns` does NOT include the `role` field.** `PlanningPanelProvider.ts:2549` sends only `{ id, label, kind, order }` to the webview — `role` is stripped. The original plan's `c.role === 'planner'` check would never match.

4. **The CREATED column is labeled 'New', not 'Planner'.** Per `agentConfig.ts:103`, the CREATED column has `label: 'New'`. The fallback regex `/planner/i.test(c.label)` would not match. The correct identifier is `kind === 'created'` (which IS sent to the webview) or the known id `'CREATED'`.

**The correct building block already exists:** `KanbanProvider.buildEpicOrchestrationPrompt` (`KanbanProvider.ts:2985`) expands epic + subtasks into a `BatchPromptPlan[]` with `isSubtask: true`, caps at `epic_max_subtasks`, adds the `[WARNING]` line, and calls `generateUnifiedPrompt`. Furthermore, `generateUnifiedPrompt` auto-detects epic mode from `plans.some(p => p.isSubtask)` (line 2944) and injects `EPIC_ORCHESTRATION_DIRECTIVE` + the epic prompt template for non-orchestrator roles (lines 2944-2967). The corrected plan generalizes this method with a role parameter.

## Metadata

- **Tags:** `feature`, `ui`, `backend`
- **Complexity:** 5/10 (frontend card rendering + one generalized backend method + one new message handler; reuses existing epic-expansion logic)

## User Review Required

Yes — the "Send to Planner" button moves the epic to the CREATED column (labeled 'New' on the board). This is the column where the planner agent processes plans (`columnToPromptRole('CREATED') → 'planner'`). The user should confirm this matches their mental model of "Send to Planner" — the button label says "Planner" but the board column is labeled "New". This label mismatch is pre-existing (the explainer at `project.html:1486` already says "drag the epic to the Planner column" referring to the CREATED column). No code change is needed to the column label, but the user should be aware.

## Complexity Audit

### Routine
- Adding per-card buttons to the epic card `innerHTML` in `renderEpicList` (`project.js:1294-1300`) — follows the exact pattern of regular plan cards (`project.js:934-942`).
- Wiring "Copy Link" — copy epic plan file path via `toAgentRef` (`sharedUtils.js:7`, a passthrough that returns the path as-is), identical to `project.js:955-964`.
- CSS for the action row — reuse `.kanban-plan-actions` / `.kanban-plan-copy-link` / `.kanban-plan-copy-prompt` classes already defined for regular plan cards.
- `escapeHtml` is defined in `project.js:2102`; `showToast` is defined in `project.js:74`; `toAgentRef` is loaded via `sharedUtils.js` (`project.html:1708`). All available in scope.
- Generalizing `buildEpicOrchestrationPrompt` to accept a `role` parameter — the method already builds the expanded `BatchPromptPlan[]` and calls `generateUnifiedPrompt`; only the role string passed to `generateUnifiedPrompt` changes.

### Complex / Risky
- **"Copy Planning Prompt" for an epic** — requires the generalized `buildEpicOrchestrationPrompt` with role `'planner'` and a new `copyEpicPlannerPrompt` message handler that calls it directly (NOT `copyPlanFromKanban`). The original plan's approach of reusing `copyPlanFromKanban` is confirmed broken (see findings #1 and #2 above).
- **Standalone epic documents** — cards with `plan.isEpicDocument === true` have no DB record and no subtasks; the action buttons should be hidden for these (matching the `isManageable` guard at `project.js:1351`).
- **Planner column resolution** — the planner column must be identified by `kind === 'created'` or `id === 'CREATED'`, NOT by `role` (which is not sent to the webview) or by label (which is 'New', not 'Planner'). See finding #3 and #4 above.

## Edge-Case & Dependency Audit

- **Race Conditions:** None significant. "Copy Planning Prompt" is a read-only clipboard operation. "Send to Planner" reuses `moveKanbanCardByPlanFile` which does a single DB column update — no multi-step transaction.
- **Security:** No new attack surface. All inputs are sanitized via `escapeHtml` in the webview. Backend handlers coerce inputs with `String()` and validate presence.
- **Side Effects:** "Send to Planner" moves only the epic card itself to the CREATED column — subtasks are NOT moved (consistent with board drag behavior; `moveCardToColumnByPlanFile` at `KanbanProvider.ts:4610` updates only the plan file's column via `db.updateColumnByPlanFile`). This matches the explainer's split-mode workflow: the epic goes to the planner column, subtasks stay where they are, then the user orchestrates.
- **Dependencies & Conflicts:**
  - `buildEpicOrchestrationPrompt` is already called by the existing `orchestrateEpic` handler (`PlanningPanelProvider.ts:2880`) and `dispatchEpicOrchestration` (`KanbanProvider.ts:3041`). Generalizing it with a `role` parameter (defaulting to `'orchestrator'`) is backward-compatible — existing callers that don't pass the role get the same behavior.
  - `generateUnifiedPrompt` auto-detects epic mode from `plans.some(p => p.isSubtask)` (line 2944) and for non-orchestrator roles prepends the orchestrator prompt template / legacy `epic_prompt_template` (lines 2957-2966). This means the planner prompt will include the epic directive automatically — no manual injection needed.
  - The `EPIC_ORCHESTRATION_DIRECTIVE` is injected by `buildKanbanBatchPrompt` when `options.epicMode && options.epicTopic` (`agentPromptBuilder.ts:485-486`), which `generateUnifiedPrompt` sets automatically when subtasks are present.
- **Standalone epic documents:** `plan.isEpicDocument === true` cards get no action buttons (no sessionId, no DB record — same guard as the meta-bar's `isManageable` check at `project.js:1351`).
- **No planner column configured:** If the kanban board has no CREATED column (user deleted/customized it), "Send to Planner" should show a toast: "No Planner column found on the kanban board." Do not silently fail.
- **Epic not on the kanban board:** If the epic has no `planFile` or no `sessionId`, "Copy Link" and "Copy Planning Prompt" should be hidden (matching the `plan.planFile ?` guard on regular cards at `project.js:939`).
- **No confirmation dialogs** (project rule) — "Send to Planner" moves the epic immediately, like any other column move.
- **Click propagation:** Per-card button clicks must `e.stopPropagation()` to avoid triggering the card's select handler (`project.js:1303-1309`), matching the pattern at `project.js:957-964`.
- **Existing meta-bar buttons:** The meta-bar Orchestrate / +Subtask / Delete buttons remain. The per-card buttons are additive — they provide quick actions without selecting the epic first. The meta-bar still appears on selection for full management.

## Dependencies

- None — this plan is self-contained. It reuses existing epic-expansion logic (`buildEpicOrchestrationPrompt`) and existing column-move logic (`moveKanbanCardByPlanFile`).

## Adversarial Synthesis

Key risks: (1) the original plan's `copyEpicPlannerPrompt` handler reused `copyPlanFromKanban` which neither expands epic subtasks nor correctly maps the `'planner'` role — confirmed broken by code tracing; (2) the webview's `_kanbanAvailableColumns` lacks the `role` field, making the original "Send to Planner" column resolution dead code. Mitigations: the corrected plan generalizes `buildEpicOrchestrationPrompt` with a role parameter (reusing the tested epic-expansion path) and resolves the planner column by `kind === 'created'` / `id === 'CREATED'` (both fields are sent to the webview).

## Proposed Changes

### `src/webview/project.js` — `renderEpicList` (lines 1285-1324)

**1. Add an action row to each epic card's `innerHTML` (after the subtasks accordion, ~line 1300):**

```javascript
const isManageable = plan && !plan.isEpicDocument;
const actionButtons = isManageable ? `
    <div class="kanban-plan-actions" style="margin-top: 6px;">
        ${plan.planFile ? `<button class="kanban-plan-copy-link epic-card-action" data-plan-file="${escapeHtml(plan.planFile)}">Copy Link</button>` : ''}
        ${plan.sessionId ? `<button class="kanban-plan-copy-prompt epic-card-action" data-session-id="${escapeHtml(plan.sessionId || plan.planId)}" data-workspace-root="${escapeHtml(plan.workspaceRoot || '')}">Copy Planning Prompt</button>` : ''}
        ${plan.sessionId ? `<button class="epic-send-to-planner epic-card-action" data-plan-file="${escapeHtml(plan.planFile || '')}" data-workspace-root="${escapeHtml(plan.workspaceRoot || '')}">Send to Planner</button>` : ''}
    </div>
` : '';
```

Insert `${actionButtons}` into the card `innerHTML` after the `</details>` closing tag.

> **Correction from original plan:** Removed the unused `data-epic-id` attribute from the "Copy Planning Prompt" button (the handler only reads `sessionId` and `workspaceRoot`). Changed `data-session-id` to use `plan.sessionId || plan.planId` to match the existing `requestEpicOrchestration` pattern at `project.js:1469`.

**2. Wire the per-card buttons (after the accordion toggle listener, ~line 1321):**

```javascript
// Copy Link — same pattern as regular plan cards (project.js:955-964)
const epicCopyLinkBtn = itemDiv.querySelector('.epic-card-action.kanban-plan-copy-link');
if (epicCopyLinkBtn) {
    epicCopyLinkBtn.addEventListener('click', e => {
        e.stopPropagation();
        const filePath = epicCopyLinkBtn.dataset.planFile;
        navigator.clipboard.writeText(toAgentRef(filePath)).then(() => {
            epicCopyLinkBtn.textContent = 'Copied';
            setTimeout(() => epicCopyLinkBtn.textContent = 'Copy Link', 2000);
        });
    });
}

// Copy Planning Prompt — calls the new copyEpicPlannerPrompt handler which
// uses buildEpicOrchestrationPrompt with role 'planner' (expands subtasks).
// Does NOT reuse copyKanbanPlanPrompt/copyPlanFromKanban — that path does not
// expand epic subtasks (see findings in Goal section).
const epicCopyPromptBtn = itemDiv.querySelector('.epic-card-action.kanban-plan-copy-prompt');
if (epicCopyPromptBtn) {
    epicCopyPromptBtn.addEventListener('click', e => {
        e.stopPropagation();
        vscode.postMessage({
            type: 'copyEpicPlannerPrompt',
            sessionId: epicCopyPromptBtn.dataset.sessionId,
            workspaceRoot: epicCopyPromptBtn.dataset.workspaceRoot
        });
        epicCopyPromptBtn.textContent = 'Copied';
        setTimeout(() => epicCopyPromptBtn.textContent = 'Copy Planning Prompt', 2000);
    });
}

// Send to Planner — move the epic to the CREATED column (where the planner
// agent processes plans). The CREATED column is identified by kind === 'created'
// or id === 'CREATED' — NOT by role (not sent to webview) or label ('New').
const epicSendPlannerBtn = itemDiv.querySelector('.epic-send-to-planner');
if (epicSendPlannerBtn) {
    epicSendPlannerBtn.addEventListener('click', e => {
        e.stopPropagation();
        const planFile = epicSendPlannerBtn.dataset.planFile;
        const wsRoot = epicSendPlannerBtn.dataset.workspaceRoot;
        // Resolve the planner column: CREATED is where the planner processes plans
        // (columnToPromptRole('CREATED') → 'planner'). Identify by kind or id,
        // NOT by role (not sent to webview) or label (CREATED is labeled 'New').
        const plannerCol = _kanbanAvailableColumns.find(c =>
            c.id === 'CREATED' || c.kind === 'created');
        if (!plannerCol) {
            showToast('No Planner column found on the kanban board.', 'error');
            return;
        }
        vscode.postMessage({
            type: 'moveKanbanPlanColumn',
            planFile,
            newColumn: plannerCol.id,
            workspaceRoot: wsRoot
        });
        epicSendPlannerBtn.textContent = 'Sent';
        setTimeout(() => epicSendPlannerBtn.textContent = 'Send to Planner', 2000);
    });
}
```

> **Correction from original plan:** The "Send to Planner" column resolution was rewritten. The original `c.role === 'planner'` check is dead code (role is not sent to the webview — `PlanningPanelProvider.ts:2549` sends only `{id, label, kind, order}`). The fallback regex `/planner/i.test(c.label)` fails because CREATED is labeled 'New'. The corrected code uses `c.id === 'CREATED' || c.kind === 'created'`, both of which ARE sent to the webview.

### `src/services/KanbanProvider.ts` — Generalize `buildEpicOrchestrationPrompt` (line 2985)

**3. Add a `role` parameter to `buildEpicOrchestrationPrompt` (default `'orchestrator'`):**

```typescript
public async buildEpicOrchestrationPrompt(
    workspaceRoot: string,
    epicSessionId: string,
    role: string = 'orchestrator'  // NEW — default preserves existing callers
): Promise<{ prompt: string; epicTopic: string; subtaskCount: number; totalSubtasks: number } | null> {
    const db = this._getKanbanDb(workspaceRoot);
    if (!db || !(await db.ensureReady())) { return null; }
    const epic = await db.getPlanByPlanId(epicSessionId);
    if (!epic || !epic.isEpic) { return null; }

    const maxRaw = await db.getConfig('epic_max_subtasks');
    const maxSubtasks = maxRaw ? parseInt(maxRaw, 10) : 20;
    const subtasks = await db.getSubtasksByEpicId(epic.planId);
    const limited = subtasks.slice(0, maxSubtasks);

    const plans: BatchPromptPlan[] = [{
        topic: epic.topic,
        absolutePath: this._resolvePlanFilePath(workspaceRoot, epic.planFile),
        complexity: epic.complexity,
        sessionId: epic.sessionId || epic.planId,
        epicId: epic.planId || undefined
    }];
    for (const st of limited) {
        plans.push({
            topic: `[SUBTASK] ${st.topic}`,
            absolutePath: this._resolvePlanFilePath(workspaceRoot, st.planFile),
            complexity: st.complexity,
            workingDir: st.repoScope ? resolveWorkingDir(workspaceRoot, st.repoScope) : '',
            sessionId: st.sessionId || st.planId,
            isSubtask: true,
            epicTopic: epic.topic,
            epicId: epic.planId || undefined
        });
    }
    if (subtasks.length > maxSubtasks) {
        plans.push({
            topic: `[WARNING: ${subtasks.length} subtasks exist but only ${maxSubtasks} included. Remaining subtasks stay in column: ${epic.kanbanColumn}]`,
            absolutePath: '',
            sessionId: '',
            isSubtask: true,
            epicTopic: epic.topic
        });
    }

    // CHANGED: use the role parameter instead of hardcoded 'orchestrator'.
    // generateUnifiedPrompt auto-detects epic mode from plans.some(p => p.isSubtask)
    // (line 2944) and injects EPIC_ORCHESTRATION_DIRECTIVE + epic prompt template
    // for non-orchestrator roles (lines 2957-2966).
    const prompt = await this.generateUnifiedPrompt(role, plans, workspaceRoot);
    return { prompt, epicTopic: epic.topic, subtaskCount: limited.length, totalSubtasks: subtasks.length };
}
```

> **Backward compatibility:** The default `role = 'orchestrator'` preserves all existing callers (`PlanningPanelProvider.ts:2880`, `KanbanProvider.ts:3041`) without modification. The only change is the role string passed to `generateUnifiedPrompt`.

### `src/services/PlanningPanelProvider.ts` — New `copyEpicPlannerPrompt` handler

**4. Add a new message handler (near `copyKanbanPlanPrompt` at line 2617):**

```typescript
case 'copyEpicPlannerPrompt': {
    const sessionId = String(msg.sessionId || '');
    const wsRoot = String(msg.workspaceRoot || workspaceRoot);
    if (!sessionId || !this._kanbanProvider) {
        this._projectPanel?.webview.postMessage({ type: 'kanbanPlanPromptCopied', success: false, sessionId: '', error: 'No sessionId or kanban provider' });
        break;
    }
    try {
        // Build the planner's batch prompt for this epic by expanding subtasks
        // (same expansion as buildEpicOrchestrationPrompt, but with role 'planner').
        // generateUnifiedPrompt auto-injects EPIC_ORCHESTRATION_DIRECTIVE for
        // non-orchestrator roles when subtasks are present.
        // Does NOT reuse copyPlanFromKanban — that path does not expand epic subtasks.
        const assembled = await this._kanbanProvider.buildEpicOrchestrationPrompt(wsRoot, sessionId, 'planner');
        if (!assembled) {
            this._projectPanel?.webview.postMessage({ type: 'kanbanPlanPromptCopied', success: false, sessionId, error: 'Could not resolve this epic.' });
            break;
        }
        await vscode.env.clipboard.writeText(assembled.prompt);
        this._projectPanel?.webview.postMessage({ type: 'kanbanPlanPromptCopied', success: true, sessionId });
    } catch (err) {
        this._projectPanel?.webview.postMessage({ type: 'kanbanPlanPromptCopied', success: false, sessionId, error: String(err) });
    }
    break;
}
```

> **Correction from original plan:** The original handler called `switchboard.copyPlanFromKanban(sessionId, 'planner', wsRoot)`, which is confirmed broken: (1) `_handleCopyPlanLink` does not expand epic subtasks, and (2) `columnToPromptRole('planner')` returns null → role defaults to 'coder'. The corrected handler calls `buildEpicOrchestrationPrompt(wsRoot, sessionId, 'planner')` directly, which expands subtasks and generates the correct planner prompt with `EPIC_ORCHESTRATION_DIRECTIVE`.

### `src/webview/project.html` — CSS (optional, if epic cards need action-row styling)

**5. Ensure `.kanban-plan-actions` flex layout applies to epic cards:**

The `.kanban-plan-actions` class is already defined for regular plan cards. If epic cards use a different container class (`.epic-plan-item`), add a rule:

```css
.epic-plan-item .kanban-plan-actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    align-items: center;
}
.epic-card-action {
    font-size: 10px;
    padding: 2px 6px;
    border: 1px solid var(--border-color);
    border-radius: 3px;
    cursor: pointer;
    background: transparent;
    color: var(--text-secondary);
}
.epic-card-action:hover {
    border-color: var(--accent-teal);
    color: var(--text-primary);
}
```

## Verification Plan

> Manual verification against an installed VSIX (per project norm). No compilation or automated tests are run in this session.

### Automated Tests

> Skipped per session directive. The test suite will be run separately by the user.

### Manual Verification

1. **Copy Link:** Click "Copy Link" on an epic card → clipboard contains the epic's plan file path. Button shows "Copied" for 2 seconds. Card is not selected (click does not trigger selection).
2. **Copy Planning Prompt:** Click "Copy Planning Prompt" on an epic card with subtasks → clipboard contains the planner's batch prompt for the epic: `EPIC_ORCHESTRATION_DIRECTIVE` header + epic plan file + each subtask's plan file (capped at `epic_max_subtasks`, default 20) + `[WARNING]` line if subtasks exceed the cap. Button shows "Copied" for 2 seconds. **Verify the prompt includes subtask entries** (the original plan's approach would have copied only the epic's plan file — this is the key correctness check).
3. **Copy Planning Prompt (epic with no subtasks):** Click "Copy Planning Prompt" on an epic with 0 subtasks → clipboard contains the planner prompt for just the epic plan file (no subtask entries, no `EPIC_ORCHESTRATION_DIRECTIVE` since `hasSubtasks` is false).
4. **Send to Planner:** Click "Send to Planner" on an epic card → the epic moves to the CREATED column on the kanban board (labeled 'New'). Button shows "Sent" for 2 seconds. Verify on the kanban board that the epic is now in the CREATED/'New' column. **Subtasks should NOT move** — only the epic card itself.
5. **No Planner column:** If the kanban board has no CREATED column (user customized/deleted it), clicking "Send to Planner" shows a toast error and does not move the epic.
6. **Standalone epic documents:** Cards for standalone epic documents (`.switchboard/epics/*.md` with no DB record, `plan.isEpicDocument === true`) show no action buttons.
7. **Click propagation:** Clicking any per-card button does not select the epic card or open the preview pane (stopPropagation works).
8. **Meta-bar still works:** Selecting an epic still shows the meta-bar with Orchestrate / +Subtask / Delete — the per-card buttons are additive.
9. **Orchestrate still works:** The existing "Orchestrate" meta-bar button still produces the orchestrator prompt (not the planner prompt) — verify the `buildEpicOrchestrationPrompt` generalization didn't break it (default role `'orchestrator'` preserves existing behavior).
10. **Theme check:** Buttons render correctly in afterburner, claudify, and cyber themes.

---

**Recommendation:** Complexity is 5/10 → **Send to Coder**. The frontend changes are routine (mirroring existing patterns), but the backend generalization of `buildEpicOrchestrationPrompt` and the new `copyEpicPlannerPrompt` handler require care to ensure the planner prompt is correctly assembled with epic expansion. The coder should verify findings #1-#4 in the Goal section before implementing.

## Reviewer Pass — 2026-06-26

### Implementation status

Implementation is complete and present in the codebase (introduced in commit `239a82d`; the auto-commit `a12a802` titled "Add Per-Card Action Buttons…" actually captured unrelated PRD-editor changes — the feature code landed earlier). All five proposed changes are implemented:

1. **`src/webview/project.js` — epic card action row** (~lines 1500-1507): `isManageable` guard, three buttons (Copy Link / Copy Planning Prompt / Send to Planner) with correct `escapeHtml` and `data-*` attributes. Matches plan with one beneficial deviation: the guard uses `plan.sessionId || plan.planId` (broader than the plan's `plan.sessionId`), consistent with the `requestEpicOrchestration` pattern. ✓
2. **`src/webview/project.js` — button wiring** (~lines 1529-1579): Copy Link (clipboard + optimistic "Copied"), Copy Planning Prompt (postMessage), Send to Planner (column resolution via `c.id === 'CREATED' || c.kind === 'created'` + `typeof _kanbanAvailableColumns !== 'undefined'` guard). Click propagation blocked via `e.stopPropagation()` + early-return in card click handler (line 1521). ✓
3. **`src/services/KanbanProvider.ts` — `buildEpicOrchestrationPrompt` generalized** (lines 3095-3143): `role: string = 'orchestrator'` default preserves existing callers; `generateUnifiedPrompt(role, plans, …)` uses the parameter. Beneficial addition beyond plan: `await this._regenerateEpicFile(workspaceRoot, epic.planId, db)` at line 3105 ensures the epic file reflects latest subtask state before prompt assembly. ✓
4. **`src/services/PlanningPanelProvider.ts` — `copyEpicPlannerPrompt` handler** (lines 2633-2652): calls `buildEpicOrchestrationPrompt(wsRoot, sessionId, 'planner')` directly (NOT the broken `copyPlanFromKanban` path), writes to clipboard, responds with `kanbanPlanPromptCopied`. ✓
5. **`src/webview/project.html` — CSS** (lines 427-439): `.epic-card-action` added to the existing `.kanban-plan-copy-link` / `.kanban-plan-copy-prompt` rules (shared styling). ✓

### Stage 1 findings (Grumpy)

| # | Severity | Finding | Location |
|---|----------|---------|----------|
| 1 | **MAJOR** | Optimistic "Copied" text on Copy Planning Prompt button races with the backend `kanbanPlanPromptCopied` response handler (which finds the button via `.kanban-plan-copy-prompt[data-session-id]` and captures `oldText` at response time). The backend timer resets to the stale "Copied" text, leaving the button permanently stuck. The regular kanban Copy Prompt button does NOT use optimistic updates. | `project.js:1551-1552` (pre-fix) |
| 2 | NIT | Debug `console.log('[KanbanProvider] createEpic: verify is_epic=…')` left in production code. Outside this plan's scope (createEpic path) but rode in on the same commit. | `KanbanProvider.ts` (createEpic path) |
| 3 | NIT | Plan line numbers stale (`renderEpicList` cited at 1285-1324; actual ~1470-1595). Documentation drift. | plan file |

### Stage 2 synthesis & fixes applied

- **Finding #1 (MAJOR) — FIXED:** Removed the optimistic `textContent = 'Copied'` + `setTimeout` reset from the epic Copy Planning Prompt click handler (`project.js:1542-1558`). The button now relies solely on the backend `kanbanPlanPromptCopied` response handler for "Copied!"/"Failed" feedback with proper reset, exactly matching the regular kanban Copy Prompt pattern (`project.js:1174-1185`). This eliminates the race.
- **Finding #2 (NIT) — Deferred:** Out of scope (createEpic code path, not this plan). Flagged for separate cleanup.
- **Finding #3 (NIT) — FIXED:** Plan file updated with actual line numbers in this review section.

### Files changed by review

- `src/webview/project.js` — removed optimistic "Copied" race in epic Copy Planning Prompt handler (lines 1542-1558).

### Verification

- **Compilation:** Skipped per session directive.
- **Automated tests:** Skipped per session directive.
- **Code-path verification (read-only):** Confirmed `toAgentRef` is loaded via `sharedUtils.js` (`project.html:1713`, `PlanningPanelProvider.ts:405-408`). Confirmed `_kanbanAvailableColumns` is a module-level variable in `project.js:162`, populated at line 320, in scope for the epic render function. Confirmed `generateUnifiedPrompt` has a `role === 'planner'` branch (`KanbanProvider.ts:2979`) and auto-injects `EPIC_ORCHESTRATION_DIRECTIVE` + epic prompt template for non-orchestrator roles when subtasks are present (`agentPromptBuilder.ts:533-534`, `KanbanProvider.ts:3047-3077`). Confirmed `kanbanPlanColumnChanged` handler (`project.js:458`) does NOT touch button text (no race for Send to Planner). Confirmed `kanbanPlanPromptCopied` handler (`project.js:565-578`) queries `.kanban-plan-copy-prompt[data-session-id]` and WILL match the epic button (both class and attribute present).

### Remaining risks

1. **`kanbanPlanPromptCopied` selector ambiguity (pre-existing, NIT):** The response handler uses `document.querySelector('.kanban-plan-copy-prompt[data-session-id="…"]')`, which returns the first DOM match. If the same epic appears as a card in BOTH the Kanban tab and the Epics tab (both panes may be in the DOM), and the kanban card's button precedes the epic's in DOM order, the feedback ("Copied!") may land on the kanban button instead of the epic button. This is a shared-infrastructure design issue, not introduced by this plan. Mitigation would require scoping the selector to the active pane — out of scope for this review.
2. **Debug `console.log` in createEpic path** (NIT, deferred).
3. **Manual verification items 1-10** in the Verification Plan above remain pending — to be run by the user against an installed VSIX.

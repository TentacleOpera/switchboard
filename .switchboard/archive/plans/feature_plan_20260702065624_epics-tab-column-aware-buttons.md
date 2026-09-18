# Epics Tab: Make Action Buttons Column-Aware (Respect Board State)

**Plan ID:** 7a3f2c1e-9b8d-4a2e-8f1c-6d5e4c3b2a19

## Goal

Make the Epics tab's per-card action buttons reflect the epic's current kanban column, so a planned/coded/reviewed epic no longer offers a regressive "Send to Planner" action or a stage-wrong "Copy Planning Prompt" — instead deriving the copy-prompt label and role from the column, mirroring the proven column-aware path the kanban board and kanban plans list already use.

### Problem
The Epics tab in `project.html` renders action buttons on each epic card that are **completely static** — they ignore the epic's current kanban column. When an epic is moved from `CREATED` (New) to `PLAN REVIEWED` (Planned) or any later column, the card still shows "Copy Planning Prompt" and "Send to Planner" buttons, which are only meaningful for the pre-planning stage.

Concretely, after moving an epic to the `PLAN REVIEWED` column:
- The column badge correctly updates to "Planned" (the label for `PLAN REVIEWED`).
- But the buttons still say "Copy Planning Prompt" and "Send to Planner" — a mismatch between the displayed status and the available actions.
- Clicking "Send to Planner" is actively **regressive**: it moves the epic *backwards* to the `CREATED` column (project.js:2055-2067), undoing the user's board progression.
- Clicking "Copy Planning Prompt" generates a **planner**-role prompt (PlanningPanelProvider.ts:3233 — `generateUnifiedPrompt('planner', ...)`), which is the wrong stage for an epic that has already been planned.

### Root Cause
Two layers ignore the column:

1. **Frontend (`src/webview/project.js`, `renderEpicsList`, lines 1962-1969):** The `actionButtons` template is built unconditionally — "Copy Planning Prompt" and "Send to Planner" are emitted whenever `plan.sessionId || plan.planId` is truthy, with no check on `plan.column` or the column's `kind`. Contrast with the kanban board (`kanban.html:5452-5470`), which derives the copy-button label from the *next* column's role, and the regular kanban plans list (`project.js:1506`), which passes `data-column` to the column-aware `copyKanbanPlanPrompt` backend path.

2. **Backend (`src/services/PlanningPanelProvider.ts`, `copyEpicPlannerPrompt` handler, lines 3199-3239):** This handler hardcodes `generateUnifiedPrompt('planner', ...)` at line 3233. It never reads the epic's `kanbanColumn` and never resolves a stage-appropriate role. The column-aware path (`copyKanbanPlanPrompt` → `copyPlanFromKanban` → `_handleCopyPlanLink` in `TaskViewerProvider.ts:14263-14343`) *does* resolve the role from the column (`columnToPromptRole` + complexity routing for `PLAN REVIEWED`) and *does* expand epic subtasks (lines 14321-14334) — but the epics tab bypasses it entirely.

### Background
The kanban pipeline stages and their column `kind` values (from `agentConfig.ts:106-116`):

| Column ID | Label | kind | role | Next-stage role |
|---|---|---|---|---|
| `CREATED` | New | `created` | — | planner |
| `RESEARCHER` | Researcher | `review` | `researcher` | researcher |
| `PLAN REVIEWED` | Planned | `review` | `planner` | lead/coder (complexity-routed) |
| `LEAD CODED` / `CODER CODED` / `INTERN CODED` | Lead/Coder/Intern | `coded` | lead/coder/intern | reviewer |
| `CODE REVIEWED` | Reviewed | `reviewed` | `reviewer` | tester |
| `ACCEPTANCE TESTED` | Acceptance Tested | `reviewed` | `tester` | — |
| `TICKET UPDATER` | Ticket Updater | `reviewed` | `ticket_updater` | — |
| `COMPLETED` | Completed | `completed` | — | — |

The `columnToPromptRole` mapping (`agentPromptBuilder.ts:1235-1251`): `CREATED`→planner, `PLAN REVIEWED`→lead, coded columns→reviewer, `CODE REVIEWED`→tester, `RESEARCHER`→researcher, `TICKET UPDATER`→ticket_updater, `custom_agent_*`→the column id itself, else `null`.

The kanban board's per-card copy button label logic (`kanban.html:5456-5467`) derives the label from the *destination* column's role: planner→"Copy planning prompt", lead/coder/intern→"Copy coder prompt", reviewer→"Copy review prompt", custom→"Copy advance prompt".

**Important payload caveat (verified):** The webview receives column definitions from the backend (`msg.columns`, project.js:466), but the existing regression-test mock (`planning-copy-labels-regression.test.js:43-50`) reflects the *actual* payload shape, which **omits the `role` field** on standard columns. The backend defines `role` in `DEFAULT_KANBAN_COLUMNS` (agentConfig.ts:108-116), but the serialized webview payload does not reliably include it. Therefore the frontend helper must derive labels from the **column `id` and `kind`**, not from `role`. Any `role`-based clause is dead code in practice and must not be load-bearing.

## Metadata
- **Tags:** frontend, ui, ux, bugfix, feature
- **Complexity:** 5/10

## User Review Required

Yes — review the chosen label semantics (current-column derivation vs. the kanban board's next-column derivation) and confirm the RESEARCHER / TICKET UPDATER non-standard lanes are acceptable with a generic "Copy Prompt" label (or specify a preferred label). Also confirm that preserving the existing epic `generateUnifiedPrompt` call *without* the `{ instruction, accurateCodingEnabled: false }` options used by `_handleCopyPlanLink` is intentional (see Proposed Changes §2, "Preserved behavior — options omission").

## Complexity Audit

### Routine
- Frontend conditional button rendering in `renderEpicsList` — mirrors an existing pattern (`kanban.html:5452-5470`).
- Adding a `data-column` attribute to the existing copy-prompt button and forwarding it in the existing `copyEpicPlannerPrompt` message.
- Extending the `kanbanPlanPromptCopied` refresh guard from `activeTab === 'kanban'` to also fire for `'epics'` (the `kanbanPlans` response handler already calls `renderEpicsList()` at project.js:523, so this is a one-line guard widening).
- Adding two imports (`columnToPromptRole`, `parseComplexityScore`) to `PlanningPanelProvider.ts`.

### Complex / Risky
- Backend `copyEpicPlannerPrompt` must become column-aware (resolve role via `columnToPromptRole` + complexity routing for `PLAN REVIEWED`) **without** breaking the epic subtask expansion it already performs, and without diverging from the proven `_handleCopyPlanLink` path. The role-resolution block must mirror TaskViewerProvider.ts:14303-14310 exactly.
- The frontend label helper must produce labels that match the kanban board's labels for every standard column, while deriving from the *current* column rather than the *next* column (semantically justified for a management view, but a divergence that must be inline-documented to prevent a future "alignment" regression).
- RESEARCHER and TICKET UPDATER are non-standard lanes whose `kind` (`review` / `reviewed`) overlaps with standard columns; the helper must not misclassify them.

## Edge-Case & Dependency Audit

1. **Epic with no column (`plan.column` falsy):** Treat as `CREATED` (pre-planning). Show "Copy Planning Prompt" + "Send to Planner". This matches the existing fallback in `_handleCopyPlanLink` (`_normalizeLegacyKanbanColumn(effectiveColumn || 'CREATED')`, TaskViewerProvider.ts:14296).

2. **Epic in `CREATED`:** Current behavior is correct — show "Copy Planning Prompt" + "Send to Planner". No change.

3. **Epic in `PLAN REVIEWED`:** "Send to Planner" must be hidden (regressive). "Copy Planning Prompt" should become "Copy Coder Prompt" (the next stage is a coded column; complexity routing picks lead vs coder on the backend). The backend must resolve the role as `lead` (or complexity-routed coder/intern), not `planner`.

4. **Epic in a coded column (`LEAD CODED` / `CODER CODED` / `INTERN CODED`):** "Send to Planner" hidden. Button label → "Copy Review Prompt" (next stage is `CODE REVIEWED`).

5. **Epic in `CODE REVIEWED`:** "Send to Planner" hidden. Button label → "Copy Acceptance Test Prompt" (next stage is `ACCEPTANCE TESTED`, role `tester`).

6. **Epic in `ACCEPTANCE TESTED` or `COMPLETED`:** "Send to Planner" hidden. No next stage — hide the copy-prompt button entirely (or show a disabled "Completed" state). "Copy Link" remains.

7. **Custom columns (`kind: 'custom-agent'` / `'custom-user'`):** `columnToPromptRole` returns the column id itself for `custom_agent_*` columns, and `null` otherwise. For unknown/custom columns, fall back to "Copy Advance Prompt" and pass the column through — the backend's `generateUnifiedPrompt` handles custom roles.

8. **`_kanbanAvailableColumns` payload omits `role` (verified):** The webview receives columns from the backend (`msg.columns`, project.js:466), but the actual serialized payload does **not** include `role` on standard columns (confirmed via the existing regression-test mock at `planning-copy-labels-regression.test.js:43-50`). The frontend helper must therefore derive labels from `id` + `kind` only; any `role`-based clause is dead code and must not be load-bearing. (The kanban board's `nextDef.role === 'planner'` check at `kanban.html:5459` works there because the board constructs its own `columnDefinitions` with `role` populated; the epics tab consumes the serialized payload, which lacks it.)

9. **RESEARCHER and TICKET UPDATER lanes (non-standard):** `RESEARCHER` has `kind: 'review'` (overlaps PLAN REVIEWED's kind) but `role: 'researcher'`; `columnToPromptRole('RESEARCHER')` returns `'researcher'`. `TICKET UPDATER` has `kind: 'reviewed'` (overlaps CODE REVIEWED's kind) but `role: 'ticket_updater'`; `columnToPromptRole('TICKET UPDATER')` returns `'ticket_updater'`. Because the webview payload omits `role`, the helper cannot distinguish these by role. Decision: handle them by **explicit id** — `RESEARCHER` → "Copy Researcher Prompt", `TICKET UPDATER` → "Copy Ticket Updater Prompt" — and pass the column through so the backend resolves the correct role via `columnToPromptRole`. If a generic label is preferred, fall through to "Copy Prompt" and document it. (User Review Required above covers this choice.)

10. **List refresh after copy-and-advance:** The `kanbanPlanPromptCopied` handler (project.js:795) only fires `fetchKanbanPlans` when `activeTab === 'kanban'`. When the epics tab is active, the epic card will not refresh after a copy-and-advance. Must add an `activeTab === 'epics'` branch (or just fire unconditionally — the backend has a request-ID dedup guard). **Verified safe:** the `kanbanPlans` response handler (project.js:522-523) calls both `renderKanbanPlans()` and `renderEpicsList()`, so firing `fetchKanbanPlans` from the epics tab does refresh the epic cards.

11. **No migration needed:** This is unreleased dev-work UI behavior (the epics tab button rendering). No persisted state format changes. Clean break.

## Dependencies

- None — this plan is self-contained within the existing epics-tab + copy-prompt code paths. It reuses (does not rebuild) `columnToPromptRole` (`agentPromptBuilder.ts`), `parseComplexityScore` (`complexityScale.ts`), `KanbanProvider.resolveRoutedRole` / `getComplexityFromPlan` / `expandEpicSubtaskPlans` / `_resolvePlanFilePath`, and the `kanbanPlanPromptCopied` → `fetchKanbanPlans` → `renderEpicsList` refresh chain. No prior plan session is a prerequisite.

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) the frontend label helper must derive from `id`/`kind`, not `role`, because the webview payload omits `role` — any `role`-based clause is dead code; (2) RESEARCHER/TICKET UPDATER lanes share `kind` with standard columns and need explicit-id handling to avoid a generic-label mismatch with the backend role; (3) the backend role fallback must match the proven `_handleCopyPlanLink` path (`|| 'coder'`, not `|| 'planner'`) to avoid parity drift; (4) the current-column (vs. the board's next-column) label derivation is a semantic divergence that must be inline-documented or it will be "fixed" wrong later. Mitigations: strip dead `role` clauses, add explicit-id branches for non-standard lanes, align the fallback, and inline-comment the current-column rationale. The omitted `generateUnifiedPrompt` options (`{ instruction, accurateCodingEnabled: false }` + `copyInstruction`) are **preserved existing behavior**, not a new gap — documented as intentional.

## Proposed Changes

### 1. `src/webview/project.js` — `renderEpicsList` (lines 1945-2081)

**Add a helper to derive the copy-prompt button label from the epic's column.** This derives from the *current* column's next stage (not the next column itself, as the kanban board does), because the epics tab is a management view, not a board column. For all standard columns the resulting label is identical to the board's next-column derivation. **Inline-comment this rationale** at the helper so a future maintainer does not "align" it to the board and silently flip every label.

The helper derives labels from `id` + `kind` only — **not** `role`, because the webview payload omits `role` (verified, see Edge-Case #8):

```js
// Derive the copy-prompt button label from the epic's CURRENT column.
// NOTE: the kanban board (kanban.html:5452) derives from the NEXT column's role;
// the epics tab is a management view, not a board column, so we derive from the
// current column's stage. For standard columns both approaches yield identical
// labels. Do NOT "align" this to next-column derivation without re-verifying
// every label — it will silently flip them.
//
// IMPORTANT: the webview payload (_kanbanAvailableColumns) does NOT include the
// `role` field on standard columns (see planning-copy-labels-regression.test.js
// mock). Derive from `id` + `kind` only — never from `role`.
function _epicCopyPromptLabel(plan) {
    if (!plan.column) return 'Copy Planning Prompt'; // no column = pre-planning
    const colDef = _kanbanAvailableColumns.find(c => c.id === plan.column);
    const kind = colDef?.kind;
    // CREATED → planner stage
    if (plan.column === 'CREATED' || kind === 'created') return 'Copy Planning Prompt';
    // PLAN REVIEWED → coder stage (complexity-routed on backend)
    if (plan.column === 'PLAN REVIEWED') return 'Copy Coder Prompt';
    // Coded columns → reviewer stage
    if (kind === 'coded') return 'Copy Review Prompt';
    // CODE REVIEWED → tester stage (next is ACCEPTANCE TESTED)
    if (plan.column === 'CODE REVIEWED') return 'Copy Acceptance Test Prompt';
    // Non-standard lanes — handle by explicit id (kind overlaps standard columns)
    if (plan.column === 'RESEARCHER') return 'Copy Researcher Prompt';
    if (plan.column === 'TICKET UPDATER') return 'Copy Ticket Updater Prompt';
    // Terminal lanes — no next stage
    if (plan.column === 'ACCEPTANCE TESTED' || kind === 'completed') return null;
    // Custom columns
    if (kind === 'custom-agent' || kind === 'custom-user') return 'Copy Advance Prompt';
    // Unknown reviewed-kind column that isn't CODE REVIEWED/ACCEPTANCE TESTED/TICKET UPDATER
    if (kind === 'reviewed') return null;
    return 'Copy Prompt';
}
```

**Make the action buttons conditional** (replace lines 1962-1969):

```js
const copyPromptLabel = _epicCopyPromptLabel(plan);
const showSendToPlanner = !plan.column || plan.column === 'CREATED'
    || (_kanbanAvailableColumns.find(c => c.id === plan.column)?.kind === 'created');
const actionButtons = `
    <div class="kanban-plan-actions" style="margin-top: 6px;">
        ${columnBadge}
        ${plan.planFile ? `<button class="kanban-plan-copy-link epic-card-action" data-plan-file="${escapeHtml(plan.planFile)}">Copy Link</button>` : ''}
        ${copyPromptLabel && (plan.sessionId || plan.planId) ? `<button class="kanban-plan-copy-prompt epic-card-action" data-session-id="${escapeHtml(plan.sessionId || plan.planId)}" data-column="${escapeHtml(plan.column || 'CREATED')}" data-workspace-root="${escapeHtml(plan.workspaceRoot || '')}">${escapeHtml(copyPromptLabel)}</button>` : ''}
        ${showSendToPlanner && (plan.sessionId || plan.planId) ? `<button class="epic-send-to-planner epic-card-action" data-plan-file="${escapeHtml(plan.planFile || '')}" data-workspace-root="${escapeHtml(plan.workspaceRoot || '')}">Send to Planner</button>` : ''}
    </div>
`;
```

**Update the Copy Planning Prompt click handler** (lines 2029-2045) to pass the column:

```js
vscode.postMessage({
    type: 'copyEpicPlannerPrompt',
    sessionId: epicCopyPromptBtn.dataset.sessionId,
    column: epicCopyPromptBtn.dataset.column,   // NEW
    workspaceRoot: epicCopyPromptBtn.dataset.workspaceRoot
});
```

**Note on the `kanbanPlanPromptCopied` restore cycle:** the response handler (project.js:775-798) finds the button via `.kanban-plan-copy-prompt[data-session-id]` and restores `oldText` (captured at response time as `btn.textContent`) after 2s. Because the dynamic label is the button's `textContent` at response time, it is preserved correctly through the restore cycle — no change needed.

### 2. `src/services/PlanningPanelProvider.ts` — `copyEpicPlannerPrompt` handler (lines 3199-3239)

**Accept `column` and resolve a stage-appropriate role** instead of hardcoding `'planner'`. Mirror `_handleCopyPlanLink` (TaskViewerProvider.ts:14303-14310). Use the **same fallback** as the proven path (`|| 'coder'`, not `|| 'planner'`) to avoid parity drift — `effectiveColumn` defaults to `CREATED`→`planner` so the fallback rarely fires, but consistency with the proven path matters:

```ts
case 'copyEpicPlannerPrompt': {
    const sessionId = String(msg.sessionId || '');
    const column = String(msg.column || '');
    const wsRoot = String(msg.workspaceRoot || workspaceRoot);
    if (!sessionId || !this._kanbanProvider) {
        this._projectPanel?.webview.postMessage({ type: 'kanbanPlanPromptCopied', success: false, sessionId: '', error: 'No sessionId or kanban provider' });
        break;
    }
    try {
        const kp = this._kanbanProvider;
        const db = (kp as any)._getKanbanDb(wsRoot);
        if (!db || !(await db.ensureReady())) {
            this._projectPanel?.webview.postMessage({ type: 'kanbanPlanPromptCopied', success: false, sessionId, error: 'Could not resolve this epic.' });
            break;
        }
        const epic = await db.getPlanByPlanId(sessionId);
        if (!epic || !epic.isEpic) {
            this._projectPanel?.webview.postMessage({ type: 'kanbanPlanPromptCopied', success: false, sessionId, error: 'Could not resolve this epic.' });
            break;
        }
        // Resolve effective column: explicit param > epic's DB column > CREATED
        const effectiveColumn = column || epic.kanbanColumn || 'CREATED';
        // Resolve role from column (mirror _handleCopyPlanLink, TaskViewerProvider.ts:14303-14310).
        // Fallback is 'coder' to match the proven path (not 'planner') — effectiveColumn
        // defaults to CREATED→planner so this fallback rarely fires, but parity matters.
        let role: string;
        if (effectiveColumn === 'PLAN REVIEWED') {
            const complexity = await kp.getComplexityFromPlan(wsRoot, (kp as any)._resolvePlanFilePath(wsRoot, epic.planFile));
            role = kp.resolveRoutedRole(parseComplexityScore(complexity));
        } else {
            role = columnToPromptRole(effectiveColumn) || 'coder';
        }
        const plans: import('./agentPromptBuilder').BatchPromptPlan[] = [{
            topic: epic.topic,
            absolutePath: (kp as any)._resolvePlanFilePath(wsRoot, epic.planFile),
            complexity: epic.complexity,
            sessionId: epic.sessionId || epic.planId,
            epicId: epic.planId || undefined,
            isEpic: true
        }];
        const subtaskPlans = await kp.expandEpicSubtaskPlans(
            wsRoot, epic.planId, epic.topic, epic.kanbanColumn || '', undefined
        );
        for (const sp of subtaskPlans) { plans.push(sp); }
        // Preserved behavior — options omission: the existing epic handler called
        // generateUnifiedPrompt WITHOUT the { instruction, accurateCodingEnabled: false }
        // options and WITHOUT the 'low-complexity' copyInstruction that _handleCopyPlanLink
        // (TaskViewerProvider.ts:14314-14341) applies for coder/intern roles. This plan
        // preserves that existing behavior intentionally. Do NOT add the options here
        // without a deliberate decision — it would change prompt output for every epic.
        const prompt = await kp.generateUnifiedPrompt(role, plans, wsRoot);
        await vscode.env.clipboard.writeText(prompt);
        this._projectPanel?.webview.postMessage({ type: 'kanbanPlanPromptCopied', success: true, sessionId });
    } catch (err) {
        this._projectPanel?.webview.postMessage({ type: 'kanbanPlanPromptCopied', success: false, sessionId, error: String(err) });
    }
    break;
}
```

**Required imports** at the top of `PlanningPanelProvider.ts` (verified absent — add):
- `columnToPromptRole` from `./agentPromptBuilder` (currently NOT imported; confirmed via grep).
- `parseComplexityScore` from `./complexityScale` (the file already imports `isValidComplexityValue, legacyToScore` from `./complexityScale` at line 25 — add `parseComplexityScore` to that existing import statement).

**Known tech debt (not introduced by this plan):** `(kp as any)._resolvePlanFilePath` and `(kp as any)._getKanbanDb` access `private` members of `KanbanProvider` via `any`-cast. This pattern is already in the existing handler (lines 3211, 3223). This plan continues it rather than refactoring `KanbanProvider`'s visibility, because widening visibility is out of scope for a button-label fix. Flag for a future cleanup pass.

### 3. `src/webview/project.js` — `kanbanPlanPromptCopied` handler (lines 795-797)

**Refresh the epics list too**, so the card reflects any column advance the backend performed after copying. Verified safe: the `kanbanPlans` response handler (project.js:522-523) calls both `renderKanbanPlans()` and `renderEpicsList()`, so firing `fetchKanbanPlans` from the epics tab refreshes the epic cards:

```js
if (activeTab === 'kanban' || activeTab === 'epics') {
    vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
}
```

## Verification Plan

### Automated Tests
- **Unit test:** Add a test verifying `_epicCopyPromptLabel` returns the correct label for each column kind (created→"Copy Planning Prompt", PLAN REVIEWED→"Copy Coder Prompt", coded→"Copy Review Prompt", CODE REVIEWED→"Copy Acceptance Test Prompt", RESEARCHER→"Copy Researcher Prompt", TICKET UPDATER→"Copy Ticket Updater Prompt", ACCEPTANCE TESTED/COMPLETED→null, custom→"Copy Advance Prompt"). Mirror the existing `src/test/planning-copy-labels-regression.test.js` pattern (extract the function by brace-counting, evaluate with mock columns that **omit `role`** to match the real payload). The test suite will be run separately by the user.

### Manual
1. **Manual — CREATED epic:** Create a new epic (lands in `CREATED`). Confirm the card shows "Copy Planning Prompt" + "Send to Planner". Click "Copy Planning Prompt" → clipboard contains a planner-role prompt. Click "Send to Planner" → epic moves to `CREATED` (no-op if already there).

2. **Manual — PLAN REVIEWED epic (the reported bug):** Move an epic to `PLAN REVIEWED`. Confirm:
   - The card shows "Copy Coder Prompt" (NOT "Copy Planning Prompt").
   - "Send to Planner" is **absent**.
   - Click "Copy Coder Prompt" → clipboard contains a coder/lead-role prompt (complexity-routed), with epic subtask expansion (`EPIC MODE` directive present).

3. **Manual — Coded column epic:** Move an epic to `LEAD CODED`. Confirm the card shows "Copy Review Prompt", no "Send to Planner". Click → clipboard contains a reviewer-role prompt.

4. **Manual — CODE REVIEWED epic:** Move an epic to `CODE REVIEWED`. Confirm "Copy Acceptance Test Prompt", no "Send to Planner".

5. **Manual — COMPLETED epic:** Move an epic to `COMPLETED`. Confirm no copy-prompt button and no "Send to Planner" — only "Copy Link" remains.

6. **Manual — RESEARCHER epic:** Move an epic to `RESEARCHER`. Confirm "Copy Researcher Prompt" (or the chosen generic label per User Review). Click → clipboard contains a researcher-role prompt.

7. **Manual — list refresh:** On the epics tab, copy a prompt for a `CREATED` epic. Confirm the epics list refreshes (the card updates if the backend advanced the column).

8. **Regression — regular kanban plans list:** Confirm the kanban plans list "Copy Prompt" button is unchanged (still uses `copyKanbanPlanPrompt`, still column-aware via the existing path).

9. **Regression — kanban board:** Confirm the kanban board's per-card copy buttons are unchanged (this plan does not touch `kanban.html`).

### Build
- `npm run compile` succeeds with no new type errors (verify `columnToPromptRole` and `parseComplexityScore` imports resolve in `PlanningPanelProvider.ts`). Build/compile is run separately by the user; not run as part of this planning session.

---

**Recommendation:** Complexity 5 → **Send to Coder**. Multi-file change (frontend helper + backend role resolution + refresh guard) but mirrors an existing proven pattern (`_handleCopyPlanLink` / `kanban.html` label derivation) with no new architecture, no data-consistency risk, and no migration. The refinements from adversarial review (strip dead `role` clauses, explicit-id handling for RESEARCHER/TICKET UPDATER, align fallback to `|| 'coder'`, inline-document the current-column rationale and the options-omission preservation) are all low-risk hardening of the original design.

## Review Findings

Implementation matches the plan across all three files (`project.js`, `PlanningPanelProvider.ts`). The `_epicCopyPromptLabel` helper, conditional button rendering, `data-column` forwarding, backend role resolution (mirroring `_handleCopyPlanLink` with `|| 'coder'` fallback), and `kanbanPlanPromptCopied` refresh guard widening are all exactly as specified. No CRITICAL or MAJOR findings — no code fixes needed. The `_normalizeLegacyKanbanColumn` omission (vs. the proven path) is safe because `columnToPromptRole` handles the only legacy value (`'CODED'`→`'LEAD CODED'`) internally. The planned unit test for `_epicCopyPromptLabel` was not added (per session directive to skip tests). Remaining risk: backward compat with an old webview sending `copyEpicPlannerPrompt` without `column` — the backend falls back to `epic.kanbanColumn || 'CREATED'`, which is correct but untested in this session.

# Skip /goal & Ultracode Epic Prompt Addons for Planner Dispatches

## Goal

The `/goal` and `ultracode` epic prompt addons must not be prepended when an epic card is dispatched to the **planner** agent. They should continue to apply for all other roles (lead, coder, reviewer, tester, etc.) exactly as today.

### Problem
The board-level epic workflow toggles (`/goal` and `ultracode`) prepend a directive at position-zero of an epic prompt whenever the primary plan is an epic and the corresponding sticky toggle is active. This prepend currently fires for **every** role, including the **planner**.

When an epic card is dispatched to the planner agent, the `/goal` slash command or the `ultracode` workflow directive is injected in front of the improve-plan workflow invocation. This is wrong:

- `/goal` is a host-level slash command that re-purposes the session toward goal-driven execution. Prepending it to a planner dispatch hijacks the improve-plan workflow instead of letting the planner produce a refined plan.
- The `ultracode` directive instructs the agent to "activate your ultracode workflow" — a coding-execution mode. The planner's job is to *plan*, not to execute code, so the directive is meaningless (or harmful) there.

### Root Cause
In `KanbanProvider.generateUnifiedPrompt`, the epic-workflow-mode prepend block (lines 3148–3167) is gated only on `primaryPlan.isEpic` and the stored `epic_workflow_mode` config. It does **not** inspect the `role` argument, so the prepend is applied uniformly to planner, coder, lead, reviewer, etc.

### Desired Behaviour
The `/goal` and `ultracode` epic prompt addons should be **skipped** when `role === 'planner'`. They should continue to apply for all other roles (lead, coder, reviewer, tester, etc.) exactly as today.

## Metadata
- **Tags:** bugfix, backend
- **Complexity:** 2

## User Review Required
Yes — confirm that the planner role should be the *only* role excluded from the epic-workflow addons. If other planning-adjacent roles (e.g. a future "architect" role) should also be excluded, note it now. The current scope excludes exactly `role === 'planner'` and no other role.

## Complexity Audit

### Routine
- Single boolean clause (`&& role !== 'planner'`) added to one `if` condition in `KanbanProvider.ts` (line 3153).
- `role` is already the first parameter of `generateUnifiedPrompt` (line 2984) and is in scope at the prepend block — no new variable, no signature change.
- No data migrations, no schema changes, no UI changes.
- The toggles themselves remain functional for non-planner roles.
- Custom agents return early (line 2989) before reaching the prepend block, so they are unaffected regardless.

### Complex / Risky
- None. The change is localized and the guard cannot leak into other roles because it is a strict equality check on the `role` argument.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. `generateUnifiedPrompt` is async but the prepend block reads `epic_workflow_mode` from the DB after the prompt is built; the `role` guard is evaluated synchronously before any DB access, so adding it cannot introduce ordering issues.
- **Security:** None. No credentials, no user input handling.
- **Side Effects:** The only behavioural change is that planner dispatches for epics no longer receive the `/goal` or `ultracode` prefix. The DB config value `epic_workflow_mode` and the UI sticky buttons (`btn-epic-ultracode`, `btn-epic-goal` in `kanban.html`) remain intact — they simply no longer affect planner dispatches.
- **Dependencies & Conflicts:** None. No other module imports or overrides the prepend block.

### Planner dispatch paths (all covered by the single function-level fix)

The fix is applied inside `generateUnifiedPrompt` itself, so every call site that dispatches to the planner is covered automatically. There are **three** such call sites:

1. **`KanbanProvider.ts:6052`** — `batchPlannerPrompt` handler. Calls `generateUnifiedPrompt('planner', plans, workspaceRoot, { instruction: 'improve-plan' })`. With the fix, the prepend is skipped — correct.
2. **`PlanningPanelProvider.ts:3081`** — per-epic "copy planner prompt" path. This path *explicitly constructs* `[{ isEpic: true }, …subtasks]` and calls `kp.generateUnifiedPrompt('planner', plans, wsRoot)`. This is the canonical epic-to-planner dispatch and is the most directly affected scenario. With the fix, the prepend is skipped — correct.
3. **`TaskViewerProvider.ts:16315`** — TaskViewer dispatch. Calls `this._kanbanProvider.generateUnifiedPrompt('planner', dispatchPlans, effectiveWorkspaceRoot, { instruction, gitProhibitionEnabled })`. With the fix, the prepend is skipped — correct.

- **Epic dispatched to coder/lead:** Unchanged. The `role !== 'planner'` guard preserves existing behaviour for all non-planner roles.
- **Custom agents (`custom_agent_*`):** Custom agents return early (line 2989) before reaching the prepend block, so they are unaffected regardless of this change.
- **`epic_workflow_mode` config value:** Unchanged. The toggle state in the DB and the UI sticky buttons remain as-is; only the planner dispatch path ignores them.
- **Empty plans array / non-epic primary plan:** Already guarded by `primaryPlan && primaryPlan.isEpic`; no change needed.

## Dependencies
- None. This plan has no dependencies on other plans or sessions.

## Adversarial Synthesis
Key risks: (1) the plan originally cited only one of three planner dispatch paths, risking a future mislocalized fix; (2) the prepend block has no existing test coverage, so regressions would be silent. Mitigations: the function-level guard covers all three call sites automatically, and the edge-case audit now enumerates each one; a new unit test (deferred to the user per session directives) is recommended to lock in the planner-exclusion behaviour.

## Proposed Changes

### `src/services/KanbanProvider.ts`

Add a `role !== 'planner'` guard to the epic-workflow-mode prepend condition (line 3153) so the `/goal` and `ultracode` directives are not injected when the card is dispatched to the planner agent.

**Before (lines 3152–3167):**
```ts
const primaryPlan = plans[0];
if (primaryPlan && primaryPlan.isEpic) {
    const db = this._getKanbanDb(workspaceRoot);
    if (db && await db.ensureReady()) {
        const mode = (await db.getConfig('epic_workflow_mode')) || 'none';
        if (mode === 'ultracode') {
            return `${ULTRACODE_EPIC_PREFIX}\n\n${built}`;
        } else if (mode === 'goal') {
            // /goal must be position-zero for the host to parse it as a
            // slash command. Prepending to the outermost return string
            // guarantees no safeguard/authorization wall precedes it.
            return `${GOAL_EPIC_PREFIX}\n${built}`;
        }
    }
}
return built;
```

**After:**
```ts
const primaryPlan = plans[0];
// The /goal and ultracode epic addons are execution-mode directives.
// They must NOT be prepended when the card is dispatched to the planner
// agent — the planner's job is to produce a refined plan, not to enter
// a goal-driven or ultracode execution workflow. Skipping them here
// keeps the improve-plan workflow invocation clean.
if (primaryPlan && primaryPlan.isEpic && role !== 'planner') {
    const db = this._getKanbanDb(workspaceRoot);
    if (db && await db.ensureReady()) {
        const mode = (await db.getConfig('epic_workflow_mode')) || 'none';
        if (mode === 'ultracode') {
            return `${ULTRACODE_EPIC_PREFIX}\n\n${built}`;
        } else if (mode === 'goal') {
            // /goal must be position-zero for the host to parse it as a
            // slash command. Prepending to the outermost return string
            // guarantees no safeguard/authorization wall precedes it.
            return `${GOAL_EPIC_PREFIX}\n${built}`;
        }
    }
}
return built;
```

No other files require changes. The UI toggles (`btn-epic-ultracode`, `btn-epic-goal` in `kanban.html`) and the config persistence (`epic_workflow_mode`) remain intact — they simply no longer affect planner dispatches. The function-level placement of the guard means all three planner dispatch paths (`KanbanProvider.ts:6052`, `PlanningPanelProvider.ts:3081`, `TaskViewerProvider.ts:16315`) are covered by this single edit.

## Verification Plan

> **Session directives:** Compilation (`npm run compile`) and automated tests (`npm test`) are NOT run by the implementing agent. They are deferred to the user. The steps below reflect that constraint.

### Automated Tests
- **Deferred to user.** No existing test in `src/test` references `epic_workflow_mode`, `ULTRACODE_EPIC_PREFIX`, `GOAL_EPIC_PREFIX`, or any planner+epic prepend assertion (confirmed via search). The prepend block is currently untested.
- **Recommended new test (user-run):** Add a unit test that stubs `epic_workflow_mode = 'ultracode'` and asserts `generateUnifiedPrompt('planner', [epicPlan], …)` returns a string that does **not** contain `ULTRACODE_EPIC_PREFIX`, while `generateUnifiedPrompt('coder', [epicPlan], …)` does contain it. This would be net-new test scaffolding (no existing test file covers this block).

### Manual Verification (webview)
1. Set the epic workflow toggle to `ultracode` (or `/goal`) on the board.
2. Select an epic card and dispatch/copy the **planner** prompt → confirm the prompt does **not** start with `This is an epic with multiple subtasks. Activate your ultracode workflow.` (or `/goal`).
3. Dispatch/copy the **coder** (or lead) prompt for the same epic → confirm the directive **is** prepended (unchanged behaviour).
4. Repeat step 2 via the per-epic "copy planner prompt" path in the Planning panel (the `PlanningPanelProvider.ts:3081` code path) to confirm the most directly affected scenario is fixed.

## Recommendation
Complexity is 2 → **Send to Intern**.

---

## Reviewer Pass (2026-06-30)

### Stage 1 — Grumpy Principal Engineer

*"A one-line guard clause. One. And you still managed to half-ass the comment. Let's look."*

**CRITICAL — none.** The guard works. `role !== 'planner'` at `KanbanProvider.ts:3155` is correct, strict equality, cannot leak. Verified.

**MAJOR — none.** All three planner dispatch paths confirmed covered by the function-level fix:
- `KanbanProvider.ts:6054` — `batchPlannerPrompt` → `generateUnifiedPrompt('planner', …)`. ✅
- `PlanningPanelProvider.ts:3081` — per-epic copy planner prompt → `kp.generateUnifiedPrompt('planner', plans, wsRoot)`. ✅
- `TaskViewerProvider.ts:16315` — TaskViewer dispatch → `generateUnifiedPrompt('planner', dispatchPlans, …)`. ✅

Custom-agent early return at `KanbanProvider.ts:2989` confirmed — custom agents never reach the prepend block. ✅

`ULTRACODE_EPIC_PREFIX` (line 52) and `GOAL_EPIC_PREFIX` (line 53) constants intact and referenced correctly. ✅

**NIT-1 (comment deviation — fixed):** The plan's "After" block specified a 4-line explanatory comment documenting *why* the planner is excluded ("execution-mode directives… would hijack the improve-plan workflow"). The implementer kept the original 4-line comment ("prepend the directive at position-zero…") which describes the general prepend behavior but says nothing about the planner exclusion. The original comment is not *wrong*, but a future reader seeing `role !== 'planner'` with no explanation would have to git-blame to understand the intent. The plan explicitly asked for the rationale comment. **Fixed in review** — added a 2-line note to the existing comment block preserving the original context.

**NIT-2 (line drift, expected):** Plan cited line 3153 for the guard; actual code is at 3155 (after the comment addition). Trivial drift, no impact.

### Stage 2 — Balanced Synthesis

**Keep as-is:** The `&& role !== 'planner'` guard clause. The original 4-line comment (still accurate for non-planner roles). The constant definitions. All three dispatch paths funnel through the single guarded function — no per-call-site changes needed or wanted.

**Fix now (applied):** Added a 2-line comment at `KanbanProvider.ts:3152-3153` explaining the planner exclusion rationale, satisfying the plan's "After" block intent without deleting the existing context.

**Defer:** The plan's recommended unit test (stub `epic_workflow_mode = 'ultracode'`, assert planner prompt excludes the prefix, coder prompt includes it) is net-new test scaffolding — deferred to the user per session directives.

### Verification Results

- **Guard clause present:** `KanbanProvider.ts:3155` — `if (primaryPlan && primaryPlan.isEpic && role !== 'planner')`. ✅
- **Planner dispatch path 1:** `KanbanProvider.ts:6054` — `generateUnifiedPrompt('planner', …)` → guard skips prepend. ✅
- **Planner dispatch path 2:** `PlanningPanelProvider.ts:3081` — `kp.generateUnifiedPrompt('planner', plans, wsRoot)` → guard skips prepend. ✅
- **Planner dispatch path 3:** `TaskViewerProvider.ts:16315` — `generateUnifiedPrompt('planner', dispatchPlans, …)` → guard skips prepend. ✅
- **Custom-agent early return:** `KanbanProvider.ts:2989` — `role.startsWith('custom_agent_')` returns before prepend block. ✅
- **Non-planner roles unaffected:** `generateUnifiedPrompt('coder', …)` / `('lead', …)` calls (lines 3574, 3895, 5523, 6082, etc.) — guard evaluates `role !== 'planner'` → `true`, prepend proceeds. ✅
- **Constants intact:** `ULTRACODE_EPIC_PREFIX` (line 52), `GOAL_EPIC_PREFIX` (line 53). ✅
- **Comment rationale added:** `KanbanProvider.ts:3152-3153`. ✅
- **Compilation:** Skipped per session directive.
- **Tests:** Skipped per session directive (user runs separately).

### Files Changed

- `src/services/KanbanProvider.ts` — `&& role !== 'planner'` guard added to epic-workflow prepend condition (line 3155); 2-line rationale comment added (lines 3152-3153).

### Remaining Risks

1. **No automated test coverage** for the planner-exclusion behaviour — the prepend block is entirely untested. The plan's recommended unit test is deferred to the user.
2. **Manual UX verification outstanding** — the 4-step manual checklist (set toggle, dispatch planner, dispatch coder, repeat via Planning panel) has not been run this session.
3. **Future planning-adjacent roles** — the plan's User Review Required flag asks whether roles beyond `'planner'` (e.g. a future "architect") should also be excluded. Current scope excludes exactly `role === 'planner'`. If new planning roles are added later, they will receive the prepend unless separately guarded.

### Summary

| Severity | Finding | Ref |
|----------|---------|-----|
| CRITICAL | none | — |
| MAJOR | none | — |
| NIT | Plan-specified rationale comment missing; original comment didn't explain planner exclusion — **fixed** | `KanbanProvider.ts:3152-3153` |
| NIT | Line drift (plan cited 3153, actual 3155 after comment add) | `KanbanProvider.ts:3155` |

**Fixes applied:** Added 2-line rationale comment at `KanbanProvider.ts:3152-3153` explaining why the planner role is excluded from epic-workflow addons.
**Remaining risks:** No automated test for the exclusion (deferred to user); manual UX verification (4-step checklist) deferred; future planning-adjacent roles would need their own guard.

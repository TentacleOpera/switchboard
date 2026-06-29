# Kanban Plans Tab: Partial-Update Push Clobbers Multi-Workspace Cache

## Goal

The **Kanban Plans** tab in `project.html` shows only 1–2 plans per workspace after any complexity edit, epic subtask add/remove, or epic delete. The user has hundreds of plans across multiple repos but only sees a tiny slice.

### Root Cause

**The initial load is correct.** The `fetchKanbanPlans` handler iterates every registered workspace root, calls `_getKanbanPlans(root)` for each, merges all results, and sends the full list as `kanbanPlansReady`. The frontend caches this at:

```js
// project.js line 389
_kanbanPlansCache = msg.plans || [];  // complete overwrite
```

**The bug is triggered by four mutation handlers** that push a *partial* `kanbanPlansReady` containing only the single workspace that was just mutated:

| Handler | File | Lines |
|---|---|---|
| `kanbanPlanComplexityChanged` | `PlanningPanelProvider.ts` | 3105–3106 |
| `addSubtaskToEpic` | `PlanningPanelProvider.ts` | 3217–3218 |
| `removeSubtaskFromEpic` | `PlanningPanelProvider.ts` | 3233–3234 |
| `deleteEpic` | `PlanningPanelProvider.ts` | 3258–3259 |

Each does:
```typescript
const allPlans = await this._getKanbanPlans(wsRoot);  // only ONE workspace
this._projectPanel?.webview.postMessage({ type: 'kanbanPlansReady', plans: allPlans, requestId: Date.now() });
```

The frontend receives `kanbanPlansReady`, runs `_kanbanPlansCache = msg.plans || []`, and now the cache holds only the plans from the one workspace that was just mutated. All other workspaces vanish.

**Trigger sequence:**
1. Panel opens → all workspaces load (correct, hundreds of plans visible).
2. User edits a plan's complexity (or touches an epic) in workspace A.
3. Backend pushes `kanbanPlansReady` with only workspace A's plans (e.g. 2 plans).
4. Frontend replaces the entire cache with those 2 plans.
5. Every workspace now shows 1–2 plans — specifically, the plans from workspace A that happened to match each workspace's filter.

### Critical Subtlety: `effectiveRoot` vs raw `wsRoot`

Plan objects returned by `_getKanbanPlans` carry `workspaceRoot: effectiveRoot` (line 8635), where `effectiveRoot = this._resolveEffectiveWorkspaceRoot(workspaceRoot)` — the **mapped parent root**, not the raw input root. When workspace database mapping is configured, `wsRoot` (raw) !== `effectiveRoot` (mapped). The frontend merge filter must therefore compare against `effectiveRoot`, not raw `wsRoot`. Passing raw `wsRoot` in the envelope would cause the filter `p.workspaceRoot !== msg.workspaceRoot` to match **nothing** (since cached plans carry `effectiveRoot`), leaving the stale slice in place and appending duplicates.

---

## Metadata

- **Tags:** frontend, backend, ui, bugfix
- **Complexity:** 4/10 — two-file change; backend adds `effectiveRoot` resolution + one field per handler, frontend adds a merge branch. The `effectiveRoot` mapping subtlety elevates this above a trivial copy-paste fix.

---

## User Review Required

Yes — the fix touches the `kanbanPlansReady` message contract (adds a `workspaceRoot` field to partial pushes). Reviewers should confirm that no other frontend consumer of `kanbanPlansReady` (e.g. `planning.js` line 6228, which also does `_kanbanPlansCache = msg.plans || []`) receives these partial pushes. As verified, the four partial-push handlers post exclusively to `this._projectPanel`, not `this._panel`, so `planning.js` is unaffected. But this invariant must be preserved — any future handler that adds `this._panel?.webview.postMessage(...)` for a partial push would inherit the same clobber bug.

---

## Complexity Audit

### Routine
- Backend change: resolve `effectiveRoot` from `wsRoot` and add `workspaceRoot: effectiveRoot` to the four partial-update `postMessage` calls. No logic change, no new DB queries. `_resolveEffectiveWorkspaceRoot` already exists (line 1936).
- Frontend change: in the `kanbanPlansReady` handler (line 389), branch on whether `msg.workspaceRoot` is present — if so, merge (replace only that workspace's slice); if not, full replace (initial load path, unchanged).
- No schema changes, no migrations, no new message types.

### Complex / Risky
- The `workspaceRoot` field on the envelope MUST be the `effectiveRoot` (mapped parent root), not the raw `wsRoot`. If raw `wsRoot` is used, the frontend filter fails to match cached plans (which carry `effectiveRoot`), producing duplicates instead of fixing the clobber. This is the single most important detail in the fix.

---

## Edge-Case & Dependency Audit

| Scenario | Analysis |
|---|---|
| Handler fires before initial load completes | Cache is `[]`; merge produces only the newly-fetched workspace's plans. This is the same as current behavior and is fine — the initial load will shortly overwrite with the full set. |
| Two handlers fire for different workspaces in quick succession | Each does `filter(p => p.workspaceRoot !== msg.workspaceRoot) + msg.plans`. The second merge operates on the cache left by the first, so both workspace slices end up correct. |
| A workspace is added/removed between initial load and a partial push | Workspace metadata (`workspaceItems`) is not included in partial pushes; the merge only touches the `plans` array. No regression. |
| `_getKanbanPlans(wsRoot)` returns an empty array (e.g. all plans deleted) | Merge correctly removes all plans for that workspace and adds nothing — desired behaviour. |
| `deleteKanbanPlan` handler (line 3113) | This handler does NOT push a `kanbanPlansReady` — it pushes `kanbanPlanDeleted` and the frontend removes the plan from the cache client-side. No change needed here. |
| Workspace mapping configured (`wsRoot` !== `effectiveRoot`) | The envelope `workspaceRoot` MUST be `effectiveRoot` to match the `workspaceRoot` field on cached plan objects (line 8635). Using raw `wsRoot` would cause the filter to miss, leaving stale plans and appending duplicates. |
| `createEpic` handler (line 3429) | This handler correctly triggers a full `fetchKanbanPlans` (not a partial push), so it already sends the complete multi-workspace payload. No change needed. |
| Auto-refresh watcher (lines 881–894) | Triggers full `fetchKanbanPlans` for both `_panel` and `_projectPanel`. Not a partial push. No change needed. |

### Race Conditions
- The `fetchKanbanPlans` handler has a `requestId` guard (lines 2882–2985) that drops stale requests. The four partial pushes bypass this guard (they post directly, not through `fetchKanbanPlans`). The frontend `kanbanPlansReady` handler does not check `requestId`, so there is no stale-request risk for partial pushes. A partial push arriving after a full load simply merges its slice — correct.

### Security
- No new attack surface. The `workspaceRoot` field is derived server-side from `_resolveEffectiveWorkspaceRoot(wsRoot)`, not from user input.

### Side Effects
- **Pre-existing, out of scope:** Line 380 (`_orchestratorAvailable = !!msg.orchestratorAvailable`) runs on every `kanbanPlansReady` including partial pushes, setting `_orchestratorAvailable = false` since partial pushes don't include `orchestratorAvailable`. This silently disables the orchestrate button after a complexity edit or epic mutation. This is a pre-existing bug not addressed by this plan. Flagging for a future fix.

### Dependencies & Conflicts
- No dependencies on other plans or sessions. The fix is self-contained within two files.

---

## Dependencies

None — this is a standalone bugfix.

---

## Adversarial Synthesis

Key risks: (1) passing raw `wsRoot` instead of `effectiveRoot` in the envelope would cause duplicate plans in mapped-workspace setups — mitigated by resolving via `_resolveEffectiveWorkspaceRoot`; (2) the `planning.js` cache (line 6228) has the same overwrite pattern but is currently safe only because partial pushes target `_projectPanel` exclusively — mitigated by documenting the invariant; (3) the pre-existing `_orchestratorAvailable` reset on partial pushes is out of scope but flagged for future work.

---

## Proposed Changes

### 1. `src/services/PlanningPanelProvider.ts` — add `workspaceRoot: effectiveRoot` to partial pushes

Four locations — same pattern each. **Critical:** use `this._resolveEffectiveWorkspaceRoot(wsRoot)`, NOT raw `wsRoot`, so the envelope key matches the `workspaceRoot` field on plan objects (line 8635).

**Line 3105–3106** (`kanbanPlanComplexityChanged`):
```typescript
// before
const allPlans = await this._getKanbanPlans(wsRoot);
this._projectPanel?.webview.postMessage({ type: 'kanbanPlansReady', plans: allPlans, requestId: Date.now() });

// after
const allPlans = await this._getKanbanPlans(wsRoot);
const effectiveRoot = this._resolveEffectiveWorkspaceRoot(wsRoot);
this._projectPanel?.webview.postMessage({ type: 'kanbanPlansReady', plans: allPlans, workspaceRoot: effectiveRoot, requestId: Date.now() });
```

**Line 3217–3218** (`addSubtaskToEpic`):
```typescript
// before
const allPlans = await this._getKanbanPlans(wsRoot);
this._projectPanel?.webview.postMessage({ type: 'kanbanPlansReady', plans: allPlans, requestId: Date.now() });

// after
const allPlans = await this._getKanbanPlans(wsRoot);
const effectiveRoot = this._resolveEffectiveWorkspaceRoot(wsRoot);
this._projectPanel?.webview.postMessage({ type: 'kanbanPlansReady', plans: allPlans, workspaceRoot: effectiveRoot, requestId: Date.now() });
```

**Line 3233–3234** (`removeSubtaskFromEpic`):
```typescript
// before
const allPlans = await this._getKanbanPlans(wsRoot);
this._projectPanel?.webview.postMessage({ type: 'kanbanPlansReady', plans: allPlans, requestId: Date.now() });

// after
const allPlans = await this._getKanbanPlans(wsRoot);
const effectiveRoot = this._resolveEffectiveWorkspaceRoot(wsRoot);
this._projectPanel?.webview.postMessage({ type: 'kanbanPlansReady', plans: allPlans, workspaceRoot: effectiveRoot, requestId: Date.now() });
```

**Line 3258–3259** (`deleteEpic`):
```typescript
// before
const allPlans = await this._getKanbanPlans(wsRoot);
this._projectPanel?.webview.postMessage({ type: 'kanbanPlansReady', plans: allPlans, requestId: Date.now() });

// after
const allPlans = await this._getKanbanPlans(wsRoot);
const effectiveRoot = this._resolveEffectiveWorkspaceRoot(wsRoot);
this._projectPanel?.webview.postMessage({ type: 'kanbanPlansReady', plans: allPlans, workspaceRoot: effectiveRoot, requestId: Date.now() });
```

### 2. `src/webview/project.js` — merge partial updates instead of full replace

**Line 389** — replace the unconditional overwrite with a merge branch:

```js
// before
_kanbanPlansCache = msg.plans || [];

// after
if (msg.workspaceRoot) {
    // Partial push from a single-workspace mutation — splice in the updated slice,
    // leaving all other workspaces' plans untouched. The workspaceRoot field is
    // the effective (mapped parent) root, matching the workspaceRoot on each plan
    // object set by _getKanbanPlans (PlanningPanelProvider.ts line 8635).
    _kanbanPlansCache = [
        ..._kanbanPlansCache.filter(p => p.workspaceRoot !== msg.workspaceRoot),
        ...(msg.plans || [])
    ];
} else {
    // Full multi-workspace load — replace entire cache.
    _kanbanPlansCache = msg.plans || [];
}
```

**Context:** The surrounding code (lines 390–415) that conditionally updates `allWorkspaceProjects`, `workspaceItems`, `columns`, and `kanbanWorkspaceRoot` via `if (msg.xxx)` guards is already correct for partial pushes — those fields are absent, so the guards skip them. No changes needed there.

---

## Verification Plan

### Automated Tests

No automated tests required — this is a webview message-contract change verified via manual UI testing. The test suite will be run separately by the user.

### Manual Verification

1. Open the Kanban Plans tab — verify all plans from all workspaces appear (hundreds, not dozens).
2. Edit the complexity of a plan in workspace A → tab refreshes → verify plans from all other workspaces are still present.
3. Add a subtask to an epic in workspace A → verify other workspaces' plans survive the refresh.
4. Remove a subtask from an epic in workspace A → same check.
5. Delete an epic in workspace A → same check.
6. Switch workspace filter to workspace B → verify workspace B's full plan list appears (not just the 1–2 that previously leaked through).
7. Regression: confirm the initial full-load path (reopening the panel) still loads all plans correctly.
8. **Workspace mapping test:** If workspace database mapping is configured (where `wsRoot` !== `effectiveRoot`), repeat steps 2–5 and verify NO duplicate plans appear for the mutated workspace.
9. **Empty-result test:** Delete all plans from a workspace, then trigger a mutation in that workspace → verify the workspace's plans are correctly removed from the cache (no stale entries, no duplicates).

---

## Recommendation

**Complexity: 4/10 → Send to Coder.**

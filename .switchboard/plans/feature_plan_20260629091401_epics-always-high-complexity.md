# Epic Complexity Is the Max of Its Subtasks (Derived, Never Unknown)

## Metadata
**Complexity:** 3
**Tags:** backend, bugfix

## Goal

Make an epic's complexity a **derived value: the maximum complexity score among its active subtasks** — stored in the DB `complexity` column and kept current as subtasks are added, removed, or rescored. Once any subtask is scored, the epic is never `'Unknown'`. This makes epic routing both **deterministic** and **right-sized**: a cleanup epic of three score-3 subtasks routes to the cheap lane, while an epic containing a score-8 subtask routes to the lead — without inventing complexity that batching alone does not justify.

### Problem Analysis

An epic's `complexity` is stored as `'Unknown'` at creation (`KanbanProvider.ts:8669`, `createEpicFromPlanIds`). That `'Unknown'` causes two problems, and the obvious "fix" causes a third:

1. **Wrong + divergent lane.** The frontend lane resolver (`kanban.html:5652`, `resolveCodedAutoTarget`) does `parseInt('Unknown')` → `NaN` → returns **`CODER CODED`**. The backend role resolvers (`scoreToRoutingRole`) map `'Unknown'`→score `0`→**`lead`** (`complexityScale.ts:64`). So the *same* epic routes to **Coder** when dragged onto AUTOCODE but to **Lead** when advanced via the column button. Same card, two destinations.

2. **Pinning every epic to High is wrong in the other direction.** Forcing an epic to High (score 8) would make routing deterministic but would ship an all-cleanup epic — three score-3 subtasks — straight to the lead. Batching low-complexity work does not make it high-complexity work.

3. **The correct value is the maximum, not a constant or an average.** An epic dispatches the whole batch (epic + all subtasks) to **one** agent/lane. That single agent must be able to handle the **hardest** subtask in the batch — so the right complexity is the **max**. An average is unsafe: `[3,3,10]` averages to ~5 → coder, and the coder can't do the 10.

### Root Cause

Three complexity *sources* feed routing — frontend `card.complexity` (DB), backend batch filters reading `c.complexity` (DB, `KanbanProvider.ts:2681,7426`), and backend per-session/role resolvers via `getComplexityFromPlan` (`KanbanProvider.ts:4432`), which **falls back to the DB complexity** when the plan file has no explicit complexity line. Therefore **storing a real numeric value in the DB `complexity` column fixes all three read paths at once** — exactly as a constant-High would have, but with the *right* value.

The only requirements beyond a constant are (a) **keeping the stored value current** as subtasks change, and (b) **stopping the auto-generated epic file from clobbering it back to `'Unknown'`**. The epic `.md` is produced by `_regenerateEpicFile` with no `Complexity:` line, so `parsePlanMetadata` returns `'Unknown'`, and `isValidComplexityValue('Unknown')` is `true` — so the staging watcher's `updateComplexityByPlanFile` would happily write `'Unknown'` over the computed max unless guarded.

## Decision (no open product questions)

- **Epic complexity = `max(parseComplexityScore(subtask))` over active subtasks**, stored as the numeric string (e.g. `'8'`) in the DB `complexity` column.
- **Bundled-by-max is the only dispatch model.** The epic + its subtasks dispatch to one lane, sized to the hardest subtask. No fan-out / per-subtask routing — explicitly out of scope (it would need per-subtask worktree isolation, and epics are intentionally worktree-free).
- **Recompute, don't pin.** A single helper `recomputeEpicComplexity(epicPlanId)` is the source of truth, invoked at every point an epic's inputs change:
  1. **Membership change** — inside `updateEpicStatus` (covers creation linking, assign, remove).
  2. **Subtask rescore** — inside `updateComplexityByPlanFile` / `updateComplexityByPlanId`, the chokepoint the **planner-agent file-watch reparse** and the review-panel edit both funnel through. A write to a row with `epic_id` set bubbles up and recomputes its parent.
- **Epic rows never accept an incoming complexity write.** In the same two write methods, a target row with `is_epic = 1` is redirected to `recomputeEpicComplexity` and the incoming value is ignored. This is the clobber-guard for the regenerated epic file.
- **Reads are untouched.** Storing the numeric max makes frontend `card.complexity`, backend batch filters, and `getComplexityFromPlan` (DB fallback) all agree — no `isEpic` checks scattered through routing.
- **No manual epic-level override.** Epic complexity is purely derived. The lever for influencing it is rescoring a **subtask** (which flows up). This matches the "auto-pull from subtasks" intent.
- **Unscored fallback is left as `'Unknown'`.** When no active subtask carries a parseable score (max = 0), the epic stores `'Unknown'` and falls through the **existing** "Unknown → High (8)" batch-move threshold (`kanban.html:8032/8420`), which stays as-is per decision. Not specially handled.

### Rejected Alternatives
- *Pin every epic to High (8)* — rejected: ships all-cleanup epics to the lead. Batching ≠ higher complexity.
- *Aggregate by average* — unsafe: `[3,3,10]`→~5→coder, which cannot do the 10. The batch needs the **max**.
- *Compute lazily at dispatch time* — rejected: the AUTOCODE lane is chosen **in the browser** by `resolveCodedAutoTarget` from the *stored* `card.complexity`, before any backend dispatch code runs. A dispatch-time pull can't serve the drag path and would re-create the frontend/backend split. Storing + recomputing serves every read path.
- *Put the recompute in a UI handler* — rejected: the dominant rescore path is the **planner-agent file-watch reparse** (`TaskViewerProvider.ts:10485/10543` → `updateComplexityByPlanFile`), which never touches a UI handler. The recompute must live in the DB write method or it silently fails for exactly that path.

## User Review Required

No open product questions. The user has confirmed: epic complexity = max of subtask scores (not a constant, not an average). No manual epic-level override. Unscored fallback remains 'Unknown'. Proceed without further review.

## Complexity Audit

### Routine
- New `recomputeEpicComplexity` helper (SELECT active subtasks → max via `parseComplexityScore` → UPDATE epic row).
- Migration: one idempotent correlated UPDATE.

### Complex / Risky
- The redirect + bubble-up branches inside `updateComplexityByPlanFile` / `updateComplexityByPlanId`. This is the enforcement chokepoint and must be correct: epic rows recompute (never accept), subtask rows write-then-bubble, plain plans unchanged.

## Edge-Case & Dependency Audit

- **Completed subtasks** drop out of the max (`getSubtasksByEpicId` filters `status='active'`). Intended: once the hard subtask is done, the remaining batch may legitimately route lighter.
- **Legacy `Low`/`High` string scores** on subtasks: runtime `parseComplexityScore` handles them via `legacyToScore`. The migration SQL treats non-numeric as `0` (best-effort); the first runtime recompute self-heals.
- **`getComplexityFromPlan` precedence:** a `**Manual Complexity Override:**` line wins over the DB, but epic files are auto-regenerated without one, so this does not apply to epics in practice.
- **Membership churn during creation:** the `createEpicFromPlanIds` link loop recomputes once per subtask link; intermediate values are transient, and the final link yields the full max. Idempotent and cheap.
- **`clearEpicIdForEpic` (epic dissolution):** the epic is going away; no recompute needed.
- **Display:** the board epic card shows `EPIC: N SUBTASKS` (no chip) today and is unaffected by *this* plan. A companion plan (`feature_plan_20260629124815_epic-card-complexity-display.md`) replaces the timestamp on the epic card with the derived score and depends on this plan landing first.

### Migration safety (per CLAUDE.md — epics shipped in a released version)
- Backfill is idempotent and best-effort (mirrors the V3 zombie-plan `UPDATE` precedent at `KanbanDatabase.ts:4303-4308`).
- Only epics whose active-subtask max ≥ 1 are updated; `'Unknown'`/unscored epics are left untouched.
- No keys or rows dropped; subtasks and non-epic plans untouched.

## Dependencies
- Epic: `epic-model-and-dispatch-correctness-efcf9b43` — sibling plans `remove-epic-max-subtasks-cap` and `remove-standalone-epics` compose cleanly. This plan touches `KanbanDatabase.ts` (recompute helper, write-method guards, migration) and `KanbanProvider.ts` (creation stops asserting Unknown); Plan 1 touches `KanbanProvider.ts` (cap removal in `_cardsToPromptPlans` / `buildEpicOrchestrationPrompt`) and `KanbanDatabase.ts` (no changes) — different methods, no conflict.
- Companion: `feature_plan_20260629124815_epic-card-complexity-display.md` — depends on this plan landing first (replaces the timestamp on the epic card with the derived score).

## Adversarial Synthesis

Key risks: the `updateComplexityByPlanFile` bubble-up requires a target-row lookup that the method doesn't currently perform (must add `getPlanByPlanFile` call before the UPDATE); the per-link recompute during `createEpicFromPlanIds` does N recomputes for N subtasks (acceptable for typical epics, ~300 DB ops for a 100-subtask epic); manual complexity edits to epic files are silently ignored by the clobber-guard (correct per design — epic complexity is purely derived). Mitigations: the `getPlanByPlanFile` accessor already exists (used in `getComplexityFromPlan`); the per-link cost is idempotent and cheap; the clobber-guard is the intended behavior.

## Proposed Changes

### 1. `src/services/KanbanDatabase.ts` — `recomputeEpicComplexity` helper
```ts
/** Recompute an epic's stored complexity as the max score among its active subtasks.
 *  Writes the numeric string (e.g. '8'), or 'Unknown' when no subtask carries a score. */
public async recomputeEpicComplexity(epicPlanId: string): Promise<boolean> {
    if (!epicPlanId || !(await this.ensureReady()) || !this._db) return false;
    const { parseComplexityScore } = require('./complexityScale');
    const subtasks = await this.getSubtasksByEpicId(epicPlanId);
    const max = subtasks.reduce(
        (m, s) => Math.max(m, parseComplexityScore(s.complexity || '')), 0);
    const value = max >= 1 ? String(max) : 'Unknown';
    return this._persistedUpdate(
        'UPDATE plans SET complexity = ?, updated_at = ? WHERE plan_id = ? AND is_epic = 1',
        [value, new Date().toISOString(), epicPlanId]
    );
}
```

### 2. `src/services/KanbanDatabase.ts` — bubble-up + epic clobber-guard in the two write methods
In `updateComplexityByPlanId` (`:1630`) and `updateComplexityByPlanFile` (`:1609`), after validation, branch on the target row before/after the UPDATE:
```ts
// updateComplexityByPlanId
const target = await this.getPlanByPlanId(planId);
if (target?.isEpic) {
    // Epic complexity is derived — ignore the incoming (file-parsed) value; recompute.
    return this.recomputeEpicComplexity(planId);
}
const ok = await this._persistedUpdate(
    'UPDATE plans SET complexity = ?, updated_at = ? WHERE plan_id = ?',
    [complexity, new Date().toISOString(), planId]);
if (ok && target?.epicId) { await this.recomputeEpicComplexity(target.epicId); }
return ok;
```
`updateComplexityByPlanFile` mirrors this, resolving the target row by `(plan_file, workspace_id)` via the existing `getPlanByPlanFile(normalized, workspaceId)` accessor (already used in `getComplexityFromPlan` at `KanbanProvider.ts:4461`, defined at `KanbanDatabase.ts:2709`). The full implementation:

```ts
// updateComplexityByPlanFile
const normalized = this._ensureRelativePlanFile(planFile);
const target = await this.getPlanByPlanFile(normalized, workspaceId);
if (target?.isEpic) {
    // Epic complexity is derived — ignore the incoming (file-parsed) value; recompute.
    return this.recomputeEpicComplexity(target.planId);
}
const ok = await this._persistedUpdate(
    'UPDATE plans SET complexity = ?, updated_at = ? WHERE plan_file = ? AND workspace_id = ?',
    [complexity, new Date().toISOString(), normalized, workspaceId]);
if (ok && target?.epicId) { await this.recomputeEpicComplexity(target.epicId); }
return ok;
```

**Note:** Manual complexity edits to epic files are intentionally ignored — the clobber-guard redirects epic rows to `recomputeEpicComplexity`, which always derives from subtasks. This is the designed behavior: epic complexity is purely derived, and the lever for influencing it is rescoring a subtask (which flows up).

### 3. `src/services/KanbanDatabase.ts` — recompute on membership change in `updateEpicStatus` (`:1510`)
```ts
const oldEpicId = plan.epicId;            // plan already fetched via getPlanByPlanId above
const ok = await this._persistedUpdate(/* existing is_epic/epic_id UPDATE */);
if (ok) {
    if (oldEpicId && oldEpicId !== epicId) await this.recomputeEpicComplexity(oldEpicId);
    if (epicId && isEpic === 0)            await this.recomputeEpicComplexity(epicId);
}
return ok;
```
This covers creation (the `createEpicFromPlanIds` link loop at `:8705`), assign, and remove with no call-site changes.

### 4. `src/services/KanbanProvider.ts` — creation stops asserting Unknown
`createEpicFromPlanIds` keeps the `'Unknown'` placeholder at upsert (`:8669`); the subtask-link loop (`:8705`) now drives `recomputeEpicComplexity` via `updateEpicStatus` (#3), leaving the epic at the true max once all subtasks are linked. Optionally add an explicit `await db.recomputeEpicComplexity(planId);` after the loop for clarity.

### 5. `src/services/KanbanDatabase.ts` — backfill existing epics
In `_runMigrations` (`:4291`), append alongside the other data fixes:
```ts
// V-epic-complexity: epics derive complexity = max(active subtask score). Backfill legacy epics.
try {
    this._db.exec(`
        UPDATE plans SET complexity = CAST(
            (SELECT MAX(CAST(s.complexity AS INTEGER)) FROM plans s
             WHERE s.epic_id = plans.plan_id AND s.status = 'active') AS TEXT)
        WHERE is_epic = 1
          AND (SELECT MAX(CAST(s.complexity AS INTEGER)) FROM plans s
               WHERE s.epic_id = plans.plan_id AND s.status = 'active') >= 1
    `);
} catch { /* best effort */ }
```
(Non-numeric legacy subtask scores cast to `0` here; the first runtime recompute corrects them.)

## Verification Plan

### Automated Tests
- **Helper:** epic with subtasks `[3,3,3]` → `recomputeEpicComplexity` stores `'3'`; `[3,3,8]` → `'8'`; all-`Unknown` → `'Unknown'`.
- **Bubble-up:** `updateComplexityByPlanFile` on a subtask (`epic_id` set) `5`→`9` recomputes the parent epic to `'9'`.
- **Clobber-guard:** `updateComplexityByPlanFile` on the epic row with `'Unknown'` (simulating the regenerated epic file) leaves the epic at its computed max.
- **Membership:** assigning an `8` subtask to an epic of `[3,3]` lifts it to `'8'`; removing it drops it back to `'3'`.
- **Creation:** `createEpicFromPlanIds` over plans `[5,6]` yields epic `'6'` (not `'Unknown'`).
- **Migration:** seed a legacy `'Unknown'` epic with subtasks `[4,7]` + a non-epic `'Unknown'` plan; run `_runMigrations`; only the epic becomes `'7'`.
- **Routing:** `resolveCodedAutoTarget` for an epic card `complexity='3'` returns the intern/coder lane; `'8'` returns `'LEAD CODED'` (default map).
- `npm test` green.

### Manual (installed VSIX — dev does not use `dist/`)
1. Create an epic from three score-3 plans → routes to the cheap lane on AUTOCODE drop (dynamic routing on).
2. Create an epic containing one score-8 plan → routes to LEAD CODED.
3. Have a planner agent rescore a subtask's plan file upward → after the watcher reparse, the epic's complexity rises to match (file-watch path propagates, not a UI action).
4. Advance the same epic via the column button and via AUTOCODE drag → same destination both ways (divergence gone).
5. On an upgraded install, a pre-existing epic recomputes to its subtask max after the backfill.

---

## Code Review (Reviewer Pass)

### Stage 1 — Grumpy Principal Engineer

> **The clobber-guard is correct.** I traced every write path. `updateComplexityByPlanFile` (`KanbanDatabase.ts:1645-1667`) looks up the target row via `getPlanByPlanFile`, redirects epic rows to `recomputeEpicComplexity` (ignoring the incoming file-parsed value), and bubbles up subtask rescoring to the parent epic. `updateComplexityByPlanId` (`:1677-1695`) mirrors this exactly. The auto-regenerated epic file (no `Complexity:` line → `parsePlanMetadata` returns `'Unknown'` → `isValidComplexityValue('Unknown')` is `true`) would have clobbered the computed max — but the guard catches it. Good.

> **The membership-change recompute is correct.** `updateEpicStatus` (`:1519-1535`) recomputes both the old epic (if the subtask moved from one epic to another) and the new epic (if a subtask was assigned). The `createEpicFromPlanIds` link loop (`KanbanProvider.ts:8563-8570`) drives `updateEpicStatus` per subtask, and the explicit `recomputeEpicComplexity` at `:8580` guarantees the final value is the true max regardless of intermediate write order. The per-link N-recomputes for N subtasks is acknowledged in the plan and acceptable.

> **The migration is idempotent and gated.** V41 (`KanbanDatabase.ts:5156-5170`) checks `getMigrationVersion() < 41`, runs the correlated UPDATE (only epics whose active-subtask max ≥ 1), and sets version 41. Non-numeric legacy scores cast to 0; the first runtime recompute self-heals. Best-effort try/catch. This mirrors the V3 zombie-plan precedent. Clean.

> **`parseComplexityScore` handles all cases.** Numeric strings ("7" → 7), `'Unknown'` → 0, legacy strings via `legacyToScore`. The `recomputeEpicComplexity` helper stores `String(max)` when max ≥ 1, `'Unknown'` otherwise. The unscored fallback is left as `'Unknown'` per the decision — the existing Unknown→High batch-move threshold handles it. Correct.

> **NIT — `recomputeEpicComplexity` uses `require('./complexityScale')` at call time instead of a top-level import.** This is a runtime `require` inside the method (`KanbanDatabase.ts:1545`). It works (Node CommonJS), but it's a pattern inconsistency — the file uses ES module imports elsewhere. Not a correctness issue; the `require` is cached after first call. Cosmetic.

### Stage 2 — Balanced Synthesis

**Keep:**
- `recomputeEpicComplexity` helper — correct max-of-subtasks logic, stores `'Unknown'` when unscored.
- Clobber-guard in both `updateComplexityByPlanFile` and `updateComplexityByPlanId` — epic rows redirect to recompute, subtask rows write-then-bubble.
- Membership-change recompute in `updateEpicStatus` — covers creation, assign, remove.
- Explicit `recomputeEpicComplexity` call in `createEpicFromPlanIds` after the link loop.
- V41 migration — idempotent, gated, best-effort.
- `parseComplexityScore` integration — handles numeric, Unknown, and legacy strings.

**Fix now:** None required. The `require` vs `import` pattern is a NIT — the codebase mixes both patterns elsewhere, and the runtime `require` is functionally correct and cached.

**Defer:** None.

### Files Changed (Verified)
- `src/services/KanbanDatabase.ts` — `recomputeEpicComplexity` helper (`:1543-1554`); clobber-guard + bubble-up in `updateComplexityByPlanFile` (`:1645-1667`); clobber-guard + bubble-up in `updateComplexityByPlanId` (`:1677-1695`); membership-change recompute in `updateEpicStatus` (`:1530-1533`); V41 migration backfill (`:5156-5170`).
- `src/services/KanbanProvider.ts` — `createEpicFromPlanIds` explicit `recomputeEpicComplexity` call after link loop (`:8580`).

### Validation Results
- **Grep verification:** `recomputeEpicComplexity` — 7 hits, all in `KanbanDatabase.ts` (definition + call sites) and `KanbanProvider.ts:8580`. No orphaned references.
- **Migration gating:** V41 check at `:5156` — `if (v41 < 41)` → `setMigrationVersion(41)` at `:5168`. Idempotent.
- **`getSubtasksByEpicId` filter:** `WHERE epic_id = ? AND status = 'active'` (`:3925`). Completed subtasks drop out of the max. Correct.
- **Compilation:** Skipped per session directive.
- **Tests:** Skipped per session directive.

### Remaining Risks
- **NIT:** `require('./complexityScale')` runtime require in `recomputeEpicComplexity` instead of top-level import. Functionally correct, cached after first call. Cosmetic inconsistency.
- **Per-link recompute cost:** N recomputes for N subtasks during `createEpicFromPlanIds`. Acceptable for typical epics (~300 DB ops for 100 subtasks). The explicit final recompute guarantees correctness.

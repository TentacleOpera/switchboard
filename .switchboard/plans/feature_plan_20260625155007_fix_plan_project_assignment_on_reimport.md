# Fix: Plans Lose Active Project Assignment on Re-Import (Watcher Overwrites Project to Empty)

## Goal

Ensure that plans created by agents (written directly to `.switchboard/plans/`) reliably retain the active kanban project assignment through file-watcher re-import cycles, instead of having their project field silently overwritten to empty on every file-change event.

## Problem Analysis & Root Cause

### What the user sees

When a project (e.g. "v5 funnel") is selected in the kanban dropdown and an agent creates a new plan file on disk, the plan initially appears on the correct project board but then **disappears** — it falls back to the unassigned/base workspace board. Or it never appears on the project board at all. The user must manually reassign it.

### How plan creation actually works (agent path)

Agent-created plans (memo processing, external tools, file drops) are written directly to `.switchboard/plans/`. The `GlobalPlanWatcherService` detects the file via VS Code's `FileSystemWatcher` or native `fs.watch`, debounces for 300ms, then calls `_handlePlanFile()`. This is the **only** import path for agent-created plans — `_createInitiatedPlan` (UI path) calls `registerPendingCreation()` which makes the watcher skip the file.

### Three-layer root cause

**Layer 1 (PRIMARY — data loss): `insertFileDerivedPlan` ON CONFLICT unconditionally overwrites `project`**

`KanbanDatabase.insertFileDerivedPlan()` uses an `INSERT ... ON CONFLICT(plan_file, workspace_id) DO UPDATE SET` clause. The current clause sets:

```sql
project = excluded.project,
project_id = COALESCE(excluded.project_id, plans.project_id),
```

`project_id` is safely preserved via `COALESCE`, but `project` is **unconditionally overwritten** with whatever the re-import carries. If the re-import resolves `project = ''` (which happens whenever the live resolver returns null — see Layer 3), the existing project text is wiped to `''`. This is the mechanism by which a correctly-assigned plan **loses** its project on the next file-change event.

**Layer 2 (SECONDARY — stuck empty): existing-plan re-import path never re-resolves the active project**

In `_handlePlanFile()`, the existing-plan branch (line ~584) builds the update record as:

```typescript
const updatedRecord: KanbanPlanRecord = {
    ...plan,                    // ← preserves existing project (which may be '')
    topic: metadata.topic,
    complexity: metadata.complexity,
    tags: metadata.tags,
    updatedAt: fileMtime
};
```

If the plan was **initially** imported with `project = ''` (because the live resolver returned null at that moment), `...plan` carries forward the empty project. The existing-plan path **never** attempts to resolve the active project from the live resolver or `_currentProjects` fallback — only the new-plan branch does. So once a plan is stuck with `project = ''`, every subsequent re-import preserves the empty value. The plan is permanently orphaned unless manually reassigned.

**Layer 3 (TERTIARY — timing gap): live resolver and fallback map can be empty at import time**

The project resolution in the new-plan path is:

```typescript
const liveProject = this._resolveDisplayedProject?.(workspaceRoot) || '';
const project = metadata.project || liveProject || this._currentProjects.get(effectiveRoot) || '';
```

The live resolver (`getDisplayedProjectForRoot`) returns `null` when:
- `_currentWorkspaceRoot` is not set (kanban panel never opened this session)
- `_projectFilter` is `null` or `UNASSIGNED_PROJECT_FILTER`

The `_currentProjects` fallback map is:
- Empty on startup (only populated by `setCurrentProject`)
- **Cleared** by `refreshWatchers({ clearProjectFilters: true })` — fired on `mappingsChanged`
- Only repopulated by `setProjectFilter` (user dropdown interaction) or the validation path in `_refreshBoardImpl` (first board refresh, line ~2060-2076)

If a plan is created during the gap between map clearance and repopulation (e.g. right after a mappings change, or before the first board refresh on startup), the first import gets `project = ''`, and Layer 2 ensures it stays empty forever.

### Why the prior fix (fix-plan-watcher-project-context.md) didn't solve it

The prior plan aligned the `_currentProjects` lookup key with `setCurrentProject`'s storage key (both now use `resolveEffectiveWorkspaceRootFromMappings`). This fixed the key mismatch but did NOT address:
- The ON CONFLICT clause overwriting `project` to `''` on re-import (Layer 1)
- The existing-plan path never re-resolving the project (Layer 2)
- The startup/mappings-change timing gap leaving `_currentProjects` empty (Layer 3)

## Metadata

- **Tags:** bugfix, reliability, database
- **Complexity:** 5

(Complexity raised 4→5: the work is mostly routine, but the `ON CONFLICT` change touches *all* callers of `insertFileDerivedPlan` and Layer 2 introduces a genuine **semantics change** to re-import — an orphaned plan now adopts the active project on any subsequent file event, not just at creation. That is one moderate, well-scoped risk extending an existing pattern → "Mixed (5)". Routing is unchanged: 4–6 → Send to Coder.)

## User Review Required

No — mechanical bugfix with no product or UX change.

## Complexity Audit

### Routine
- `insertFileDerivedPlan` ON CONFLICT clause: single SQL keyword change (`COALESCE` wrapper)
- `_handlePlanFile` existing-plan path: add project re-resolution (reuse existing logic from new-plan path)
- KanbanProvider constructor: add early `setCurrentProject` call for restored filter

### Complex / Risky
- The ON CONFLICT change affects ALL callers of `insertFileDerivedPlan` (watcher, registry, Notion restore). The change is strictly more conservative (never overwrites a non-empty project with empty), so it cannot cause data loss. But it means a plan whose project was deliberately cleared (e.g. by a project deletion that set `project = ''`) would NOT be re-cleared by a re-import. This is acceptable — project deletion uses a dedicated `DELETE FROM projects` + `UPDATE plans SET project = ''` path that doesn't go through `insertFileDerivedPlan`.
- **Layer 2 changes re-import semantics (the one genuine behavioral expansion).** Today the existing-plan branch is a pure metadata refresh — it *never* touches `project`. After the fix, any re-import of a plan whose `project` is currently empty will adopt the active project. Re-imports fire on file save, mtime bumps, periodic scans, and manual triggers — not just at creation. Consequence: a plan the user intentionally left unassigned (visible on the base board) will be silently pulled into whatever project is selected the next time its file is touched. This is **bounded** — it only happens while a project filter is active (otherwise `liveProject` and the `_currentProjects` fallback both resolve `''`, leaving the plan unchanged) — and it aligns with the established product contract (plans belong to the active project at write time; see the watcher project-assignment contract). It is accepted intentionally, but it is a real semantics change, not pure data-loss prevention.
- **Change #3 propagates an *un-validated* persisted filter at construction.** If the persisted project was deleted between sessions, a plan created in the startup gap (before the first board refresh runs the validation at line ~2061) is imported with a stale `project` name and `project_id = NULL` (the name lookup at `KanbanDatabase.ts:1307-1319` finds no row). With Layer 1 now making non-empty text sticky, that stale name persists and Layer 2 will not re-resolve it (text is non-empty). The validation path corrects the *filter* to UNASSIGNED but does not rewrite the already-imported plan. Net effect: the plan still lands on the base board (the board JOINs on `project_id`, which is NULL), so it is cosmetic, not a display bug. Narrow and low-severity, but explicitly noted.

## Edge-Case & Dependency Audit

### Race Conditions
- Two concurrent `_handlePlanFile` calls for the same file (VS Code watcher + native watcher). Both resolve the project independently. With the COALESCE fix, even if one resolves `''` and the other resolves "v5 funnel", the non-empty value wins. No data loss.
- Layer 2 re-resolution reads `_currentProjects` / the live resolver at re-import time. Rapid project switching during a debounced file event could pull an orphaned plan into whichever project is active at the moment the event drains, rather than the one active when the file was saved. Worst case is a transient mis-assignment, correctable from the dropdown — acceptable for a UI-driven toggle (same accepted race documented in the prior fix).

### Side Effects
- **Project text vs. `project_id` (important — do not assume Layer 1 alone fixes display).** The board filter JOINs on `project_id`, not the `project` text column (see the companion plan's `getBoardFilteredByProject` analysis). Layer 1 protects the *text*; the FK is protected separately and already correctly: `insertFileDerivedPlan` keeps `project_id = COALESCE(excluded.project_id, plans.project_id)` (line 1333) AND re-resolves `project_id` from the `projects` table whenever a non-empty `project` is supplied but `project_id` is null (lines 1307-1319). So Layer 2 supplying a non-empty `project` for an orphaned plan also backfills its `project_id` — both columns end consistent. The implementer must NOT remove the existing `project_id` COALESCE while editing the same clause.
- **Explicit project in frontmatter:** `metadata.project` (from a `**Project:**` line) takes priority in the new-plan path. The existing-plan path now honors it too: if the file has an explicit project, it overrides the DB value (highest-priority source). This is a deliberate, additive behavior — a plan that gains an explicit `**Project:**` line will be reassigned on its next re-import.
- **Layer 2 unassigned-plan adoption:** see Complexity Audit → Complex / Risky. Re-import is no longer idempotent w.r.t. `project` for plans with empty project while a filter is active.

### Security
- None — no auth, input, or network surface touched. No new SQL string interpolation (`NULLIF`/`COALESCE` operate on bound parameters / column refs only).

### Dependencies & Conflicts
- `resolveEffectiveWorkspaceRootFromMappings` already imported in both `GlobalPlanWatcherService.ts` (line 11) and used in `KanbanProvider.ts`. No new imports.
- **`KanbanDatabase.ts` is edited by both this plan and the companion plan** (`feature_plan_20260625155416_fix_plans_fall_out_of_project_kanban.md`). This plan edits the `insertFileDerivedPlan` ON CONFLICT clause (~line 1328); the companion edits the separate `UPSERT_PLAN_SQL` ON CONFLICT clause (~line 557/583). Different SQL statements → no logical conflict, but they apply the *same* `COALESCE(NULLIF(excluded.project, ''), plans.project)` pattern and should land together (or in close sequence) so the two import paths stay consistent. See `## Dependencies`.
- **Project deletion:** Uses `db.deleteProject()` which runs `UPDATE plans SET project = '', project_id = NULL` directly — does NOT go through `insertFileDerivedPlan`. The COALESCE fix does not interfere.
- **`assignPlansToProject` (UI creation path):** Calls `setProjectForPlans` which runs a direct `UPDATE plans SET project = ?, project_id = ?` — does NOT go through `insertFileDerivedPlan`. The COALESCE fix does not interfere.

## Dependencies

No hard blocking session dependency. The following are related work items that should be coordinated:

- `companion plan — fix_plans_fall_out_of_project_kanban` (`feature_plan_20260625155416_fix_plans_fall_out_of_project_kanban.md`) — fixes the *other* wipe path (`upsertPlans` / run-sheet events strip `project_id`). Same file (`KanbanDatabase.ts`), same COALESCE pattern, different SQL statement. **Should be implemented together** so both import paths preserve project assignment consistently; otherwise the symptom recurs via whichever path is left unpatched.
- `prior fix — fix-plan-watcher-project-context` (`fix-plan-watcher-project-context.md`, complexity 2, completed) — aligned the `_currentProjects` lookup/storage key. This plan builds directly on it (Layers 1–3 address what that fix did not). No conflict; this plan assumes that fix is already merged (the effective-root resolution it added is present in the new-plan path at line 521).

## Adversarial Synthesis

Key risks: (1) **Layer 2 semantics change** — re-import now adopts the active project onto any empty-project plan on every file event, which can silently move an intentionally-unassigned plan into the selected project (bounded to "a filter is active"). (2) **Multi-caller blast radius** — the `ON CONFLICT` change affects every `insertFileDerivedPlan` caller, and the file is co-edited by the companion plan. (3) **Stale-filter startup gap** — an un-validated persisted filter for a deleted project can stamp a stale, sticky `project` name during the startup window. Mitigations: accept (1) as matching the product contract and gate it on an active filter (already the case); land with the companion plan and keep the existing `project_id` COALESCE intact (2); accept (3) as cosmetic since the board JOINs on `project_id` (NULL → base board) and the validation path corrects the filter. The full Grumpy/Balanced critique is in the chat response.

## Proposed Changes

### 1. `src/services/KanbanDatabase.ts` — Fix ON CONFLICT to preserve non-empty project

**File:** `src/services/KanbanDatabase.ts` (~line 1332)
**Context:** The `insertFileDerivedPlan` method's `ON CONFLICT` clause.

**Before (broken):**
```sql
ON CONFLICT(plan_file, workspace_id) DO UPDATE SET
    topic = excluded.topic,
    complexity = excluded.complexity,
    tags = excluded.tags,
    project = excluded.project,
    project_id = COALESCE(excluded.project_id, plans.project_id),
    updated_at = excluded.updated_at
```

**After (fixed):**
```sql
ON CONFLICT(plan_file, workspace_id) DO UPDATE SET
    topic = excluded.topic,
    complexity = excluded.complexity,
    tags = excluded.tags,
    project = COALESCE(NULLIF(excluded.project, ''), plans.project),
    project_id = COALESCE(excluded.project_id, plans.project_id),
    updated_at = excluded.updated_at
```

`COALESCE(NULLIF(excluded.project, ''), plans.project)` means: if the new import carries a non-empty project, use it; otherwise preserve the existing project. This prevents re-imports from wiping a previously-assigned project.

### 2. `src/services/GlobalPlanWatcherService.ts` — Re-resolve active project on existing-plan re-import

**File:** `src/services/GlobalPlanWatcherService.ts` (~line 584)
**Context:** The `_handlePlanFile` existing-plan branch.

**Before (broken):**
```typescript
} else {
    // Existing plan - update metadata
    const updatedRecord: KanbanPlanRecord = {
        ...plan,
        topic: metadata.topic,
        complexity: metadata.complexity,
        tags: metadata.tags,
        updatedAt: fileMtime
    };
    await db.insertFileDerivedPlan(updatedRecord);
```

**After (fixed):**
```typescript
} else {
    // Existing plan - update metadata.
    // Re-resolve the active project if the plan currently has none.
    // Priority: explicit frontmatter project > live displayed project >
    // _currentProjects fallback > existing DB project (preserved by COALESCE).
    let resolvedProject = plan.project;
    if (metadata.project) {
        // Frontmatter explicitly sets a project — honor it (overrides everything)
        resolvedProject = metadata.project;
    } else if (!resolvedProject) {
        // Plan has no project and frontmatter doesn't set one — try the active
        // project sources that the new-plan path uses. Without this, a plan
        // initially imported with project='' (timing gap) is stuck empty forever.
        const effectiveRoot = resolveEffectiveWorkspaceRootFromMappings(workspaceRoot);
        const liveProject = this._resolveDisplayedProject?.(workspaceRoot) || '';
        resolvedProject = liveProject || this._currentProjects.get(effectiveRoot) || '';
    }
    const updatedRecord: KanbanPlanRecord = {
        ...plan,
        topic: metadata.topic,
        complexity: metadata.complexity,
        tags: metadata.tags,
        project: resolvedProject,
        updatedAt: fileMtime
    };
    await db.insertFileDerivedPlan(updatedRecord);
```

This ensures that every re-import is an opportunity to assign the active project to a plan that was previously missed — not just the first import.

**Clarification (project_id backfill):** `updatedRecord` spreads `...plan`, so `projectId` carries the existing (possibly NULL) FK. When Layer 2 sets a non-empty `project: resolvedProject` for a previously-orphaned plan, `insertFileDerivedPlan` re-resolves `project_id` from the `projects` table (KanbanDatabase.ts:1307-1319, because `record.projectId` is null and `record.project` is now non-empty). So both `project` text and `project_id` end consistent and the plan appears on the board. No extra code is required here — but do not "optimize away" the existing `project_id` resolution block.

**Clarification (guard, not new scope):** the `else if (!resolvedProject)` guard is essential — re-resolution must fire ONLY when the plan currently has no project. Re-resolving unconditionally would let a stale active filter overwrite a plan that already carries a *different*, correct project. The guard keeps the change additive for already-assigned plans.

### 3. `src/services/KanbanProvider.ts` — Propagate restored project filter to watcher immediately on construction

**File:** `src/services/KanbanProvider.ts` (~line 290-297)
**Context:** The constructor restores `_projectFilter` from `workspaceState` but only propagates it to the watcher during the first `_refreshBoardImpl` (line ~2060-2076, gated on `_projectFilterNeedsValidation`). If a plan is created before the first board refresh, the watcher's `_currentProjects` map is empty.

**Before (broken):**
```typescript
if (this._currentWorkspaceRoot) {
    const resolvedRoot = path.resolve(this._currentWorkspaceRoot);
    const persistedFilter = this._context.workspaceState.get<string | null>(`kanban.projectFilter.${resolvedRoot}`, null);
    if (persistedFilter !== null) {
        this._projectFilter = persistedFilter;
        this._projectFilterNeedsValidation = true;
    }
}
```

**After (fixed):**
```typescript
if (this._currentWorkspaceRoot) {
    const resolvedRoot = path.resolve(this._currentWorkspaceRoot);
    const persistedFilter = this._context.workspaceState.get<string | null>(`kanban.projectFilter.${resolvedRoot}`, null);
    if (persistedFilter !== null) {
        this._projectFilter = persistedFilter;
        this._projectFilterNeedsValidation = true;
        // Propagate the restored filter to the watcher immediately so plans
        // created before the first board refresh still get the active project.
        // The validation path in _refreshBoardImpl will correct this if the
        // project no longer exists.
        this._globalPlanWatcher?.setCurrentProject(resolvedRoot, persistedFilter);
    }
}
```

This closes the startup timing gap: the watcher's `_currentProjects` map is populated at construction time, not deferred to the first board refresh.

## Scope

- **3 files changed:** `KanbanDatabase.ts`, `GlobalPlanWatcherService.ts`, `KanbanProvider.ts`
- **~15 lines changed total:** one SQL clause modification, one project re-resolution block, one early propagation call
- No schema changes, no UI changes, no new dependencies

## Verification Plan

### Manual Tests
1. Open the Autism360App workspace (or any workspace with projects defined).
2. Select a project (e.g. "v5 funnel") in the kanban dropdown.
3. Create a new plan file directly in `.switchboard/plans/` (simulating an agent write — `touch .switchboard/plans/test_plan.md` with some content).
4. Confirm the plan card appears on the "v5 funnel" project board, not the base workspace board.
5. **Critical regression test:** Modify the plan file (save it again). Confirm the plan STAYS on the "v5 funnel" board — it does not fall back to unassigned.
6. Switch to a different project (e.g. "Automated Testing"). Create another plan file. Confirm it appears on "Automated Testing".
7. Restart VS Code. Before opening the kanban panel, create a plan file. Open the kanban and confirm the plan is on the last-selected project board.
8. Confirm plans created with no project selected still land on the base workspace board.
9. Confirm plans with an explicit `**Project:** X` in their content are assigned to X regardless of the active filter.
10. **Layer 2 recovery test:** Force-orphan a plan (assign it, then clear its project via a direct DB update so `project = ''`, `project_id = NULL`) while "v5 funnel" is selected. Re-save the plan file. Confirm it now appears on the "v5 funnel" board (re-import adopted the active project).
11. **Layer 2 semantics check (accepted behavior):** With "v5 funnel" selected, re-save a plan that has *no* project and was intentionally left on the base board. Confirm it moves to "v5 funnel" — verify this matches the intended contract and is not a surprise to the user.

### Automated Tests
> Tests are written here but executed separately by the user (per session directive); this plan does not run a build/compile or the suite itself.

- `insertFileDerivedPlan` — empty does not wipe: insert a plan with `project = "v5 funnel"`, then call again with `project = ''` for the same `plan_file` + `workspace_id`. Assert the `project` column remains `"v5 funnel"`.
- `insertFileDerivedPlan` — non-empty overrides: insert with `project = "v5 funnel"`, then call again with `project = "Automated Testing"`. Assert `project` updates to `"Automated Testing"`.
- `insertFileDerivedPlan` — project_id preserved on empty re-import: insert with `project = "v5 funnel"`, `projectId = <id>`, then call again with `project = ''`, `projectId = null`. Assert `project_id` is unchanged (regression guard for the un-touched `project_id` COALESCE).
- `GlobalPlanWatcherService._handlePlanFile` (Layer 2) — orphan recovery: pre-seed `_currentProjects` (resolved key) with `"v5 funnel"`, stub an existing DB plan with `project = ''`, drive a re-import (mtime bumped), and assert the persisted record ends with `project = "v5 funnel"`. Then assert that an existing plan already carrying `project = "other"` is **not** changed (guard verification).

## Recommendation

**Send to Coder.** Complexity 5 (Mixed): the diff is small and the COALESCE/re-resolution changes reuse an existing, proven pattern, but the Layer 2 semantics change and the shared-file coordination with the companion plan warrant a coder's judgment rather than a purely mechanical pass. Land alongside `feature_plan_20260625155416_fix_plans_fall_out_of_project_kanban.md`.

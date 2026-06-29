# Consolidate the Five Prompt-Dispatch Plan Builders into One

## Goal

Collapse the extension's five separate ways of building the `BatchPromptPlan[]` array (the input to `generateUnifiedPrompt`) into a **single canonical builder**, so that epic-subtask bundling, working-directory resolution, worktree resolution, and plan-file fallback logic exist in exactly one place and cannot drift between entry points.

### Background & root-cause analysis

`generateUnifiedPrompt(role, plans, workspaceRoot, opts)` is the single chokepoint for all prompt **text**. It is called from **22 sites** across `KanbanProvider`, `TaskViewerProvider`, and `PlanningPanelProvider`. Epic mode is not a flag the caller sets directly — it is *inferred* inside `generateUnifiedPrompt`:

```ts
const hasSubtasks = plans.some(p => p.isSubtask);
if (hasSubtasks) { resolvedOptions.epicMode = true; /* + epicTopic, subtaskCount, template */ }
```

So whether an epic is treated as an epic depends entirely on whether the **caller's `plans` array already contains the subtask entries**. That array is built in five different places, each with its own copy of "resolve plan record → primary `BatchPromptPlan` → if epic, append subtasks":

1. `KanbanProvider._cardsToPromptPlans(cards, workspaceRoot, repoScopeMap)` — board/`promptSelected`/drop family. Input: in-memory `KanbanCard[]` + a `repoScopeMap`. Builds an epic→worktree map itself. **Expands subtasks** (gated on `card.isEpic`).
2. `TaskViewerProvider._resolveKanbanDispatchPlans(sessionIds, workspaceRoot)` — configured-column + batch dispatch. Input: `sessionId[]`, DB lookup per id with `mirror_path`/`brain_source_path` fallbacks, worktree via `TaskViewerProvider.resolveWorktreePathForPlan`. **Expands subtasks** (gated on `plan.isEpic`).
3. `PlanningPanelProvider` `copyEpicPlannerPrompt` handler — Epics-tab planner copy. Builds `[epic]` inline, then calls `kp.expandEpicSubtaskPlans`. **Expands subtasks.**
4. `TaskViewerProvider._handleTriggerAgentActionInternal` — single-card drag→column CLI dispatch. **Originally did NOT expand** (the reported bug; patched 2026-06-30 to add `isEpic` + `expandEpicSubtaskPlans`).
5. `TaskViewerProvider._handleCopyPlanLink` — project.html Plans-tab copy button. **Originally did NOT expand** (latent identical bug; patched 2026-06-30).

The root cause of the recurring "epic dispatched as a plain plan" bug is **duplication, not logic**: the subtask-expansion step (`expandEpicSubtaskPlans`) already exists as a shared helper, but the *array construction around it* is copy-pasted across five sites. Every new dispatch entry point is a fresh opportunity to forget the expansion — which is exactly what happened twice. Two of the five were silently wrong until a user dragged an epic and noticed it lost its `EPIC MODE` directive and subtask list.

The two builders also diverge in incidental ways that should converge:
- **Input type**: `_cardsToPromptPlans` takes in-memory `KanbanCard[]`; `_resolveKanbanDispatchPlans` takes `sessionId[]` and hits the DB. The inline sites take a single `sessionId`/`planId`.
- **Worktree resolution**: card path builds a `worktreePathMap` from the active-worktrees table once; sessionId path calls `TaskViewerProvider.resolveWorktreePathForPlan(db, {epicId, project})` per plan; inline copy path passes `undefined`.
- **Plan-file resolution**: only `_resolveKanbanDispatchPlans` has the `mirror_path` / `brain_source_path` fallbacks; the others trust `record.planFile` via `_resolvePlanFilePath`.
- **`epicTopic` label**: none of the five sets `epicTopic` on the *primary* epic plan object, so the epic line renders as `- [topic]` instead of `- [EPIC: topic]` in `buildPromptDispatchContext`. Cosmetic, but it should be fixed once, centrally.

## Decisions (no open questions)

- **One canonical builder, on `KanbanProvider`.** It already owns `expandEpicSubtaskPlans`, `_resolvePlanFilePath`, the worktree-map construction, and `generateUnifiedPrompt`. `TaskViewerProvider` and `PlanningPanelProvider` already hold a `_kanbanProvider`/`kp` reference and call into it. Putting the builder anywhere else would force the DB handle and three private helpers to be threaded out; this is the lowest-coupling home. **Not** creating a new standalone module — that would require passing `KanbanDatabase` + relocating `_resolvePlanFilePath`/worktree logic, a larger blast radius for no functional gain.
- **The builder is record-driven.** Canonical input is `KanbanPlanRecord` (the DB row), because it carries every field needed (`planId`, `topic`, `complexity`, `repoScope`, `epicId`, `isEpic`, `planFile`, `mirrorPath`, `brainSourcePath`, `project`, `kanbanColumn`). Callers that start from `sessionId[]` resolve records first; callers that start from `KanbanCard[]` resolve the record by `sessionId` (the card's in-memory fields are a strict subset of the record, so a DB read loses nothing and gains `repoScope`/fallbacks). Dispatch is not a hot path — one DB read per dispatched card is acceptable and removes the separate `repoScopeMap` plumbing entirely.
- **Worktree resolution moves into the builder.** It accepts an optional pre-built `worktreePathMap` (the board path already has one cheaply); when absent, it resolves per-record via the same logic as `resolveWorktreePathForPlan`. `resolveWorktreePathForPlan` is promoted/duplicated as needed so `KanbanProvider` does not import `TaskViewerProvider` (avoid a circular module reference — see Edge Cases).
- **`epicTopic` is set on the primary epic plan** inside the builder, so the `[EPIC: …]` label renders correctly everywhere at once. This is safe: `generateUnifiedPrompt` already derives `epicTopic` from `plans.find(p => !p.isSubtask)?.topic`, so setting it on the object only improves the rendered label and does not change epic-mode detection.
- **Plan-file fallbacks (`mirror_path`, `brain_source_path`) become universal** by living in the builder, so the copy/drag paths gain the same resilience the batch path already had.
- **Behavioral parity is the success bar, not behavioral change.** The five sites must emit byte-identical prompts to today for non-epic plans, and correctly-bundled prompts for epics. This is a refactor; no prompt-text semantics change.

## Current State

- `src/services/agentPromptBuilder.ts` — `buildKanbanBatchPrompt` (prompt **text**), `BatchPromptPlan` interface (`topic, absolutePath, complexity?, workingDir?, sessionId?, worktreePath?, epicId?, isSubtask?, epicTopic?, isEpic?`), `buildPromptDispatchContext` (renders `[EPIC: …]` / `[SUBTASK] …` / `[topic]`). **No change needed here** beyond confirming the contract.
- `src/services/KanbanProvider.ts`
  - `generateUnifiedPrompt(role, plans, workspaceRoot, opts)` — public chokepoint (KanbanProvider.ts:2957). Already infers `epicMode` from `isSubtask` entries. **Unchanged.**
  - `expandEpicSubtaskPlans(workspaceRoot, epicPlanId, epicTopic, epicColumn, worktreePath?, worktreePathMap?)` — public (2566). The shared subtask expander; the new builder calls it. `epicColumn` param is currently unused inside it — keep or drop as part of cleanup.
  - `_cardsToPromptPlans(cards, workspaceRoot, repoScopeMap?)` — private (2490). Builds the worktree map and per-card plans; **to be reduced to a thin adapter** over the new builder.
  - `_resolvePlanFilePath(workspaceRoot, planFile)` — private (2476). Reused by the builder.
- `src/services/TaskViewerProvider.ts`
  - `_resolveKanbanDispatchPlans(sessionIds, workspaceRoot)` — private (2959). **To be reduced to a thin adapter** (resolve records → call builder).
  - `resolveWorktreePathForPlan(db, {epicId, project})` — public static (7272). Source of the worktree-resolution logic to centralize.
  - `_handleTriggerAgentActionInternal` (~15754) and `_handleCopyPlanLink` (~13929) — inline builders, **to call the adapter/builder** instead of constructing arrays by hand.
- `src/services/PlanningPanelProvider.ts`
  - `copyEpicPlannerPrompt` handler (~3030) — inline builder, **to call the builder**.
- Tests: `src/test/` (the deleted `orchestrator-prompt.test.js` is gone; epic dispatch has no direct unit coverage today — this plan adds it).

## Proposed Changes

### 1. Add the canonical builder to `KanbanProvider`

```ts
/**
 * THE single place that turns plan records into the BatchPromptPlan[] passed to
 * generateUnifiedPrompt. Resolves plan-file path (with mirror/brain fallbacks),
 * working dir (repoScope), worktree path, isEpic, and — for epics — appends the
 * full active-subtask bundle so generateUnifiedPrompt enters epic mode.
 * Every dispatch/copy entry point MUST funnel through this. Do not build a
 * BatchPromptPlan array anywhere else.
 */
public async buildDispatchPlans(
    workspaceRoot: string,
    records: KanbanPlanRecord[],
    opts?: { worktreePathMap?: Map<string, string> }
): Promise<Array<BatchPromptPlan & { sessionId: string }>> {
    const out: Array<BatchPromptPlan & { sessionId: string }> = [];
    const db = this._getKanbanDb(workspaceRoot);
    const hasDb = !!db && await db.ensureReady();
    for (const rec of records) {
        const planFileRel = this._resolveDispatchPlanFile(workspaceRoot, rec); // planFile → mirror → brain
        if (!planFileRel) { console.warn(`[KanbanProvider] buildDispatchPlans: no plan file for ${rec.planId}`); continue; }
        const absolutePath = this._resolvePlanFilePath(workspaceRoot, planFileRel);
        const worktreePath = await this._resolveWorktreeForRecord(workspaceRoot, rec, opts?.worktreePathMap);
        const isEpic = !!rec.isEpic;
        out.push({
            sessionId: rec.sessionId || rec.planId,
            topic: rec.topic || planFileRel || 'Untitled',
            absolutePath,
            complexity: rec.complexity,
            workingDir: resolveWorkingDir(workspaceRoot, rec.repoScope || ''),
            worktreePath,
            epicId: rec.epicId ?? undefined,
            isEpic,
            ...(isEpic ? { epicTopic: rec.topic } : {}),   // primary epic gets [EPIC: …] label
        });
        if (isEpic && hasDb && rec.planId) {
            const subs = await this.expandEpicSubtaskPlans(
                workspaceRoot, rec.planId, rec.topic || 'Untitled', rec.kanbanColumn || '',
                worktreePath, opts?.worktreePathMap
            );
            for (const sp of subs) { out.push({ ...sp, sessionId: sp.sessionId || rec.sessionId || rec.planId }); }
        }
    }
    return out;
}
```

Helpers extracted into `KanbanProvider` (private):
- `_resolveDispatchPlanFile(workspaceRoot, rec)` — returns the first of `rec.planFile` / `rec.mirrorPath` (under `.switchboard/plans/`) / `rec.brainSourcePath` that exists on disk, as a workspace-relative path. This is the logic currently inline only in `_resolveKanbanDispatchPlans`.
- `_resolveWorktreeForRecord(workspaceRoot, rec, map?)` — `map?.get(rec.planId) ?? map?.get(String(rec.epicId)) ?? (map size 1 ? sole value) ?? <DB resolve by {epicId, project}>`. Folds together the card path's map lookup and the sessionId path's `resolveWorktreePathForPlan`. Move the worktree-table query body here (or have both call a shared free function) so `KanbanProvider` does not depend on `TaskViewerProvider`.

### 2. Reduce the two main builders to adapters

`KanbanProvider._cardsToPromptPlans` becomes:
```ts
private async _cardsToPromptPlans(cards: KanbanCard[], workspaceRoot: string, _legacyRepoScopeMap?: Map<string,string>): Promise<BatchPromptPlan[]> {
    const db = this._getKanbanDb(workspaceRoot);
    if (!(db && await db.ensureReady())) return [];
    const worktreePathMap = await this._buildActiveWorktreePathMap(workspaceRoot); // existing map logic, extracted
    const records: KanbanPlanRecord[] = [];
    for (const card of cards) {
        const rec = await db.getPlanBySessionId(this._cardId(card));
        if (rec) records.push(rec);
    }
    return this.buildDispatchPlans(workspaceRoot, records, { worktreePathMap });
}
```
(The `repoScopeMap` parameter is retained but ignored, then deleted from call sites in a follow-up pass to keep this diff reviewable. Mark it `_legacyRepoScopeMap` and add a one-line deprecation comment.)

`TaskViewerProvider._resolveKanbanDispatchPlans` becomes:
```ts
private async _resolveKanbanDispatchPlans(sessionIds: string[], workspaceRoot: string): Promise<Array<BatchPromptPlan & { sessionId: string }>> {
    const db = await this._getKanbanDb(workspaceRoot);
    if (!db) return [];
    const records: KanbanPlanRecord[] = [];
    for (const sid of sessionIds) {
        const rec = await db.getPlanBySessionId(sid);
        if (rec) records.push({ ...rec, sessionId: rec.sessionId || sid });
    }
    return this._kanbanProvider!.buildDispatchPlans(workspaceRoot, records);
}
```

### 3. Route the three inline sites through the builder

- `_handleTriggerAgentActionInternal`: replace the hand-built `dispatchPlan` + the (just-added) expansion block with `const dispatchPlans = await this._kanbanProvider.buildDispatchPlans(resolvedWorkspaceRoot, [plan], {...})` where `plan` is the already-fetched record. Keep the `effectiveWorkingDir`/`options.workingDirectory` override by applying it to the returned primary plan if `options.workingDirectory` is set (rare path — preserve exactly).
- `_handleCopyPlanLink`: replace the hand-built `[plan]` + expansion with a `buildDispatchPlans(resolvedWorkspaceRoot, [planRecord])` call.
- `PlanningPanelProvider` `copyEpicPlannerPrompt`: replace the `[epic] + expandEpicSubtaskPlans` block with `kp.buildDispatchPlans(wsRoot, [epic])`.

After this, **`expandEpicSubtaskPlans` has exactly one caller** (`buildDispatchPlans`), and **no file constructs a `BatchPromptPlan` literal for dispatch** except the builder and the two Setup/preamble previews (which are intentionally synthetic and document why with a comment).

### 4. Guardrail comment + lint note

At each former builder site and at `generateUnifiedPrompt`, add a short comment: `// Plan arrays for dispatch MUST come from KanbanProvider.buildDispatchPlans — do not hand-roll (epic subtasks get silently dropped otherwise).` Optionally add a unit test (below) that fails if a known epic dispatch loses its subtasks.

## Edge-Case & Dependency Audit

- **Circular import (KanbanProvider ↔ TaskViewerProvider).** `resolveWorktreePathForPlan` is a static on `TaskViewerProvider`. `KanbanProvider` must not import `TaskViewerProvider` (they already have a one-way `_kanbanProvider` reference the other direction). **Resolution:** move the worktree-table query into a free function (e.g. in `KanbanDatabase` as `getActiveWorktreePathFor({epicId, project})`, or a small `worktreeResolver.ts`) and have both `KanbanProvider._resolveWorktreeForRecord` and the existing `TaskViewerProvider.resolveWorktreePathForPlan` delegate to it. Verify no new import cycle with `madge`/tsc.
- **Optimistic board state vs DB.** `_cardsToPromptPlans` currently reads `card.column`/`card.isEpic` from in-memory `_lastCards`, which during an optimistic drag may be a step ahead of the DB. Switching to a DB read per card means the builder sees committed state. Dispatch persists the column move to the DB *before* prompt generation in the existing flows, so this is safe — **but verify** the `promptOnDrop`/`triggerAction` ordering still persists-then-builds (it does today: `moveCardToColumn`/`_updateKanbanColumnForSession` run before/around prompt gen). Add a regression check for an epic dragged from `CODER CODED`.
- **`isEpic` staleness / sticky flag.** `upsertPlan` keeps `is_epic` sticky (`CASE WHEN excluded.is_epic > 0 …`). The builder reads `rec.isEpic` straight from the row, so a freshly-promoted epic is correctly detected as long as `getPlanBySessionId` returns the post-promotion row. No change to promotion logic.
- **Subtask with no plan file / archived subtask.** `expandEpicSubtaskPlans` already filters to `status='active'` and resolves paths via `_resolvePlanFilePath`; preserve that. A subtask whose file is missing should be skipped, not abort the whole epic — confirm `buildDispatchPlans` keeps the epic + remaining subtasks if one subtask path is bad.
- **Empty result.** If `records` is empty or every plan file is missing, `buildDispatchPlans` returns `[]`; callers already handle the empty case (`if (validPlans.length === 0) return false`). Preserve those guards.
- **`workingDirectory` override** (CLI dispatch `options.workingDirectory`) and **repoScope** — the override currently replaces both `effectiveWorkspaceRoot` and `effectiveWorkingDir` in `_handleTriggerAgentActionInternal`. The builder computes `workingDir` from `repoScope`; when `options.workingDirectory` is set it must still win for the primary plan. Apply the override after the builder returns, on the primary entry only (subtasks keep their own repoScope-derived dirs, matching today).
- **Multi-repo working dirs.** `buildPromptDispatchContext` switches between single shared `WORKING DIRECTORY` and `MULTI-REPO BATCH` based on distinct `workingDir`s. Since the builder sets `workingDir` exactly as before, this output is unchanged.
- **`sessionId` on returned plans.** Batch/dispatch callers depend on `sessionId` being present on every returned entry (for run-sheet updates, column cascades). The builder must stamp `sessionId` on both primary and subtask entries (subtasks: `sp.sessionId || epicSessionId`) — matching current `_resolveKanbanDispatchPlans` behavior.
- **`~4000 installs` / shipped state.** This is pure in-memory dispatch logic — no persisted format, settings, or files change. No migration required.
- **Published prompt text.** Because the goal is byte-identical non-epic prompts, snapshot a few prompts (planner/coder/reviewer for a normal plan; coder/reviewer for an epic) **before** the refactor and diff after. The only intended diff: epics now show `[EPIC: …]` and the `EPIC MODE` block in the two previously-broken paths, plus the `[EPIC: …]` label improvement everywhere.

## Verification Plan

1. `npx tsc --noEmit -p tsconfig.json` → no new errors (baseline currently has 2 pre-existing `TS2835` module-resolution warnings unrelated to this work).
2. Add `src/test/dispatch-plan-builder.test.js` (or `.ts`) asserting:
   - A non-epic record → single-element array, `isEpic` falsy, no `isSubtask` entries.
   - An epic record with 2 active subtasks → 3 entries: primary `isEpic:true` + `epicTopic` set, two `isSubtask:true` entries with `epicTopic`.
   - Feeding the epic array through `buildKanbanBatchPrompt` yields a prompt containing `EPIC MODE` and both subtask paths.
   - An epic whose one subtask file is missing → primary + remaining subtasks, no throw.
3. Manual (VSIX): for the artifact-round-trip epic (`a8af9501…`), confirm **all four** of {board "Copy review prompt" card button, project.html Plans-tab copy button, single-card drag→column, multi-card drag} produce a prompt with `EPIC MODE` + both subtasks. Confirm a non-epic plan is unchanged across the same four.
4. `grep` audit: after the refactor, `expandEpicSubtaskPlans(` has exactly one caller (`buildDispatchPlans`), and no `BatchPromptPlan` array literal is built for dispatch outside `buildDispatchPlans` and the two documented previews.

## Metadata

**Complexity:** 6
**Tags:** refactor, backend, reliability

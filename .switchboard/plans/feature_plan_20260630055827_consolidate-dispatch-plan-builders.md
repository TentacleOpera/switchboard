# Consolidate the Five Prompt-Dispatch Plan Builders into One

## Goal

Collapse the extension's five separate ways of building the `BatchPromptPlan[]` array (the input to `generateUnifiedPrompt`) into a **single canonical builder**, so that epic-subtask bundling, working-directory resolution, worktree resolution, and plan-file fallback logic exist in exactly one place and cannot drift between entry points.

### Background & root-cause analysis

`generateUnifiedPrompt(role, plans, workspaceRoot, opts)` is the single chokepoint for all prompt **text**. It is called from **22 sites** across `KanbanProvider`, `TaskViewerProvider`, and `PlanningPanelProvider` (verified: 23 `generateUnifiedPrompt(` matches in `src/`, minus the one definition = 22 call sites). Epic mode is not a flag the caller sets directly — it is *inferred* inside `generateUnifiedPrompt` (KanbanProvider.ts:3098):

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
- **Worktree resolution (the difference is the *heuristic*, NOT a status filter)**: both paths read active worktrees only — `getWorktrees()` filters `WHERE status='active'` in SQL (KanbanDatabase.ts:2462), and `resolveWorktreePathForPlan` then re-filters `w.status === 'active'` redundantly (a no-op). They diverge in *how they match*: the board map keys on `epic_id` and adds a "if exactly one active worktree, use it" sole-entry fallback (no `project` match); the sessionId path matches `epic_id` then `project` (no sole-entry fallback); the inline copy path passes `undefined`.
- **Plan-file resolution**: only `_resolveKanbanDispatchPlans` has the `mirror_path` / `brain_source_path` fallbacks; the others trust `record.planFile` via `_resolvePlanFilePath`.
- **`epicTopic` label**: none of the five sets `epicTopic` on the *primary* epic plan object, so the epic line renders as `- [topic]` instead of `- [EPIC: topic]` in `buildPromptDispatchContext`. Cosmetic, but it should be fixed once, centrally.

### Out-of-scope construction sites (explicitly excluded — Clarification)

A complete audit of every `BatchPromptPlan` literal in `src/` (verified via grep) found **two additional construction sites** that are intentionally **excluded** from this consolidation because they bypass `generateUnifiedPrompt`:

- **`chatCopyPrompt` handler** (KanbanProvider.ts:6365) — builds a minimal `chatPlans` array (`topic, absolutePath, sessionId` only) from in-memory cards and calls `buildKanbanBatchPrompt('chat', chatPlans, …)` **directly**, never `generateUnifiedPrompt`. Chat is a consultation role, not an agent dispatch — epic expansion, worktree resolution, and repoScope are correctly irrelevant. **No change.**
- **`handleGetDefaultPromptPreviews`** (TaskViewerProvider.ts:4093) — builds a single synthetic `placeholder: BatchPromptPlan` (`{ topic: '[your selected plans]', absolutePath: '/path/to/plan.md' }`) to preview default role prompts with no real plans selected. Intentionally synthetic. **No change.**
- **`copyGeneralChatPrompt`** (KanbanProvider.ts:734) — calls `buildKanbanBatchPrompt('chat', [], …)` with an **empty** array. Not a construction site. **No change.**

The grep audit in the Verification Plan lists these three as known exceptions so it does not false-positive.

## Metadata

**Tags:** refactor, backend, reliability
**Complexity:** 6

## User Review Required

**None.** The adversarial review framed two items as "behavioral choices to confirm"; both are decided below, with no open product call remaining.

1. **Worktree resolution** — the review framed this as a *status-filter* convergence ("board path is unfiltered, CLI path filters active"). **That premise is false:** `getWorktrees()` already filters `status='active'` in SQL (KanbanDatabase.ts:2462) and `resolveWorktreePathForPlan`'s extra `.filter(w => w.status==='active')` (TaskViewerProvider.ts:7283) is a redundant no-op — both paths are already active-only. There is no status decision. The *real* difference is the matching heuristic (sole-entry fallback vs `project` match); it is **decided** in the Decisions section (**preserve both exactly** via the resolver's map/no-map mode — no proven path changes) and **gated** by a mandatory non-epic worktree snapshot in the Edge-Case audit. No user sign-off required.
2. **`[EPIC: …]` label on currently-working paths** — **decided: intended.** Setting `epicTopic` on the primary epic plan renders `- [EPIC: topic]` instead of `- [topic]` in *all* epic paths (including the ones that already work). It is a pure cosmetic improvement that does not affect epic-mode detection (which keys on `isSubtask`). Covered by the before/after snapshot in the Verification Plan.

## Complexity Audit

### Routine
- Reducing `_cardsToPromptPlans` and `_resolveKanbanDispatchPlans` to thin adapters that resolve records then delegate to `buildDispatchPlans` — mechanical, reuses existing DB methods (`getPlanBySessionId`, `getSubtasksByEpicId`, `getWorktrees`).
- Routing the three inline sites (`_handleTriggerAgentActionInternal`, `_handleCopyPlanLink`, `copyEpicPlannerPrompt`) through the builder — each already fetches the `KanbanPlanRecord`; the change replaces a hand-built literal + expansion block with one call.
- Extracting `_resolveDispatchPlanFile` (the `planFile → mirror → brain` fallback chain) — already written inline in `_resolveKanbanDispatchPlans` (lines 2984–3012); extraction is copy-into-method.
- Adding guardrail comments at former builder sites and `generateUnifiedPrompt`.
- Removing the now-dead `_buildRepoScopeMap` method and its call sites (follow-up pass).
- Halving per-card DB reads on the board path (current flow calls `getPlanBySessionId` twice per card — once in `_buildRepoScopeMap`, once in `_cardsToPromptPlans` for `epicId`; the record-driven builder calls it once).

### Complex / Risky
- **Worktree-resolution heuristics** — two divergent matching heuristics (board: `epic_id` + sole-entry fallback; CLI: `epic_id` + `project`). NOT a status-filter issue (both already active-only). **De-risked by preserving both exactly** via the resolver's map/no-map mode (see Decisions): the board and CLI paths keep their current behavior verbatim, so no proven path changes. The residual risk is now confined to the two copy paths gaining record-based resolution — a small, intended improvement on low-traffic paths, still snapshot-checked.
- **Error-contract unification** — today the five sites are inconsistent: three wrap `expandEpicSubtaskPlans` in `try/catch` (log + continue), two do not (would throw). The builder must pick one contract and adapters must not double-handle.
- **`options.workingDirectory` override preservation** in `_handleTriggerAgentActionInternal` — the override replaces both `effectiveWorkspaceRoot` and `effectiveWorkingDir`; the builder must use the real root for path resolution, then the override is applied to the primary plan's `workingDir` after the builder returns. Applying it before would resolve paths against the wrong root.
- **Circular-import avoidance** — `KanbanProvider` must not import `TaskViewerProvider` to reach `resolveWorktreePathForPlan`; the worktree query must move to a shared location.

## Decisions (no open questions)

- **One canonical builder, on `KanbanProvider`.** It already owns `expandEpicSubtaskPlans`, `_resolvePlanFilePath`, the worktree-map construction, and `generateUnifiedPrompt`. `TaskViewerProvider` and `PlanningPanelProvider` already hold a `_kanbanProvider`/`kp` reference and call into it. Putting the builder anywhere else would force the DB handle and three private helpers to be threaded out; this is the lowest-coupling home. **Not** creating a new standalone module — that would require passing `KanbanDatabase` + relocating `_resolvePlanFilePath`/worktree logic, a larger blast radius for no functional gain.
- **The builder is record-driven.** Canonical input is `KanbanPlanRecord` (the DB row), because it carries every field needed (`planId`, `topic`, `complexity`, `repoScope`, `epicId`, `isEpic` [number 0/1, coerced via `!!`], `planFile`, `mirrorPath`, `brainSourcePath`, `project`, `kanbanColumn`). Callers that start from `sessionId[]` resolve records first; callers that start from `KanbanCard[]` resolve the record by `sessionId` (the card's in-memory fields are a strict subset of the record, so a DB read loses nothing and gains `repoScope`/fallbacks). Dispatch is not a hot path — one DB read per dispatched card is acceptable and removes the separate `repoScopeMap` plumbing entirely. Note: `_buildRepoScopeMap` already does this same `getPlanBySessionId` read to source `repoScope`, so the builder **halves** the per-card DB reads on the board path (from 2 to 1), not adds one.
- **Worktree resolution moves into the builder, preserving each path's exact current heuristic (conservative — no path gains the union).** Both existing paths are already active-only (`getWorktrees()` filters `status='active'` in SQL), so there is no status-filter change. The two paths use *different* matching heuristics, and the **decision is to preserve both exactly** rather than unify on a superset — the superset would change worktree resolution for non-epic plans on the proven, heavily-used board and CLI paths, which is precisely the risk we are de-risking. The resolver selects mode by the presence of the `worktreePathMap`:
  - **`map` provided (board adapter)** → map heuristic only: `map.get(planId)` → `map.get(epicId)` → sole-active-worktree fallback. **No `project` match.** Byte-identical to today's board path.
  - **`map` absent (CLI / batch / single-card-trigger adapters)** → record heuristic: `epic_id` match → `project` match. **No sole-entry fallback.** Byte-identical to today's `resolveWorktreePathForPlan` consumers.
  - The proven high-traffic paths (board copy/drop, CLI dispatch, batch dispatch, single-card drag→column) therefore change **zero** worktree behavior. The only delta is the two **copy** paths (`_handleCopyPlanLink`, `copyEpicPlannerPrompt`), which today resolve **no** worktree at all (they pass `undefined`); routed through the builder with no map, they gain the record heuristic (`epic_id`/`project`). This is a strict improvement on two low-traffic, recently-fixed paths — not a change to any proven flow. (If you want even those two byte-identical, the builder takes a `skipWorktree` flag; **not recommended** — it would perpetuate the inconsistency where copying an epic omits its safety-session block.)
  - The record-heuristic query (`epic_id` → `project`) moves to a shared free function so `KanbanProvider` does not import `TaskViewerProvider` (circular-import avoidance — see Edge-Cases). `_buildActiveWorktreePathMap` is a straight extraction of the existing board map-building over `getWorktrees()` — no filter change.
- **`epicTopic` is set on the primary epic plan** inside the builder, so the `[EPIC: …]` label renders correctly everywhere at once. This is safe: `generateUnifiedPrompt` already derives `epicTopic` from `plans.find(p => !p.isSubtask)?.topic` (KanbanProvider.ts:3103), so setting it on the object only improves the rendered label and does not change epic-mode detection (which keys on `isSubtask`).
- **Plan-file fallbacks (`mirror_path`, `brain_source_path`) become universal** by living in the builder, so the copy/drag paths gain the same resilience the batch path already had.
- **Error contract: catch + continue.** The builder wraps `expandEpicSubtaskPlans` in `try/catch` and keeps the primary epic + any already-resolved subtasks on failure (matching the majority behavior and the edge-case note about missing subtask files). Adapters drop their own `try/catch` around the builder call to avoid double-handling.
- **Behavioral parity is the success bar for non-epic prompts, with one narrow documented exception.** The board, CLI, batch, and single-card-trigger paths must emit **byte-identical** non-epic prompts to today (their worktree behavior is preserved verbatim). The *only* permitted non-epic delta is on the two **copy** paths (`_handleCopyPlanLink`, `copyEpicPlannerPrompt`), which may newly gain a record-resolved worktree path + safety-session block where they previously had none — a strict improvement on low-traffic paths. Epics get correctly-bundled prompts; the two intended epic diffs are (a) the two previously-broken paths now show `EPIC MODE` + subtask list, and (b) **all** epic paths now render `- [EPIC: topic]` instead of `- [topic]` (cosmetic label improvement to working paths too).

## Current State

- `src/services/agentPromptBuilder.ts` — `buildKanbanBatchPrompt` (prompt **text**), `BatchPromptPlan` interface (`topic, absolutePath, complexity?, workingDir?, sessionId?, worktreePath?, epicId?, isSubtask?, epicTopic?, isEpic?` — verified at line 28), `buildPromptDispatchContext` (renders `[EPIC: …]` / `[SUBTASK] …` / `[topic]` — verified at line 253). **No change needed here** beyond confirming the contract.
- `src/services/KanbanProvider.ts`
  - `generateUnifiedPrompt(role, plans, workspaceRoot, opts)` — public chokepoint (line 2957). Already infers `epicMode` from `isSubtask` entries (line 3098) and derives `epicTopic` from the primary non-subtask plan's `topic` (line 3103). **Unchanged.**
  - `expandEpicSubtaskPlans(workspaceRoot, epicPlanId, epicTopic, epicColumn, worktreePath?, worktreePathMap?)` — public (line 2566). The shared subtask expander; the new builder calls it. `epicColumn` param is currently **unused** inside the body (verified) — keep or drop as part of cleanup.
  - `_cardsToPromptPlans(cards, workspaceRoot, repoScopeMap?)` — private (line 2490). Builds the worktree map over `getWorktrees()` (already `status='active'`-filtered in SQL; the map keys on `epic_id` only) and per-card plans; **to be reduced to a thin adapter** over the new builder.
  - `_resolvePlanFilePath(workspaceRoot, planFile)` — private (line 2476). Reused by the builder.
  - `_buildRepoScopeMap(cards, workspaceRoot)` — private (line 2671). Reads `plan.repoScope` via `getPlanBySessionId` per card; **becomes dead code** after the adapter switch (the builder sources `repoScope` from the record directly). Delete in the follow-up pass.
  - `chatCopyPrompt` handler (line 6365) — builds `chatPlans` and calls `buildKanbanBatchPrompt('chat', …)` directly. **Out of scope** (see Goal exclusions). No change.
- `src/services/TaskViewerProvider.ts`
  - `_resolveKanbanDispatchPlans(sessionIds, workspaceRoot)` — private (line 2967). **To be reduced to a thin adapter** (resolve records → call builder).
  - `resolveWorktreePathForPlan(db, {epicId, project})` — public static (line 7275). Source of the worktree-resolution logic to centralize. Matches `epic_id` then `project`. Its `.filter(w => w.status === 'active')` (line 7283) is redundant — `getWorktrees()` already filters active in SQL.
  - `_handleTriggerAgentActionInternal` (line 15780) and `_handleCopyPlanLink` (line 13932) — inline builders, **to call the adapter/builder** instead of constructing arrays by hand.
  - `handleGetDefaultPromptPreviews` (line 4093) — synthetic placeholder preview. **Out of scope.** No change.
- `src/services/PlanningPanelProvider.ts`
  - `copyEpicPlannerPrompt` handler (line 3030) — inline builder, **to call the builder**.
- `src/services/KanbanDatabase.ts` — `KanbanPlanRecord` interface (line 32; `isEpic?: number`, `mirrorPath`, `brainSourcePath`, `repoScope`, `project?`, `kanbanColumn` all present), `getPlanBySessionId` (line 2689), `getSubtasksByEpicId` (line 3944; filters `status = 'active'`), `getWorktrees` — all verified, no change.
- Tests: `src/test/` (the deleted `orchestrator-prompt.test.js` is gone; epic dispatch has no direct unit coverage today — this plan adds it).

## Edge-Case & Dependency Audit

- **Circular import (KanbanProvider ↔ TaskViewerProvider).** `resolveWorktreePathForPlan` is a static on `TaskViewerProvider`. `KanbanProvider` must not import `TaskViewerProvider` (they already have a one-way `_kanbanProvider` reference the other direction). **Resolution:** move the worktree-table query into a free function (e.g. in `KanbanDatabase` as `getActiveWorktreePathFor({epicId, project})`, or a small `worktreeResolver.ts`) and have both `KanbanProvider._resolveWorktreeForRecord` and the existing `TaskViewerProvider.resolveWorktreePathForPlan` delegate to it. Verify no new import cycle with `madge`/tsc.
- **Worktree-resolution preservation + the non-epic invariant (correctness gate).** There is **no status divergence** — `getWorktrees()` filters `status='active'` in SQL (line 2462), so both `_cardsToPromptPlans` (via `getWorktrees()`) and `resolveWorktreePathForPlan` (whose extra `.filter(active)` at line 7283 is a no-op) already see active-only worktrees. The two heuristics differ (board = `epic_id` + sole-entry fallback; CLI = `epic_id` + `project`), and the resolver **preserves both exactly** via its map/no-map mode (see Decisions). **Mandatory verification:** (1) board, CLI, batch, and single-card-trigger paths must be **byte-identical** before/after for both epic and non-epic plans — including in project-worktree and single-worktree workspaces (this is the proof that the proven paths' worktree behavior is unchanged). (2) The two copy paths (`_handleCopyPlanLink`, `copyEpicPlannerPrompt`) are the *only* permitted non-epic delta: a plan there may newly gain a record-resolved (`epic_id`/`project`) worktree path + safety-session block where it previously had none. Any worktree change on a proven path means the map/no-map wiring is wrong — stop and fix.
- **Optimistic board state vs DB.** `_cardsToPromptPlans` currently reads `card.column`/`card.isEpic` from in-memory `_lastCards`, which during an optimistic drag may be a step ahead of the DB. Switching to a DB read per card means the builder sees committed state. Dispatch persists the column move to the DB *before* prompt generation in the existing flows, so this is safe — **but verify** the `promptOnDrop`/`triggerAction` ordering still persists-then-builds (it does today: `moveCardToColumn`/`_updateKanbanColumnForSession` run before/around prompt gen). Add a regression check for an epic dragged from `CODER CODED`.
- **`isEpic` staleness / sticky flag.** `upsertPlan` keeps `is_epic` sticky (`CASE WHEN excluded.is_epic > 0 …`). The builder reads `rec.isEpic` (a `number`, coerced via `!!`) straight from the row, so a freshly-promoted epic is correctly detected as long as `getPlanBySessionId` returns the post-promotion row. No change to promotion logic.
- **Subtask with no plan file / archived subtask.** `expandEpicSubtaskPlans` already filters to `status='active'` (verified, KanbanDatabase.ts:3947) and resolves paths via `_resolvePlanFilePath`; preserve that. A subtask whose file is missing should be skipped, not abort the whole epic — the builder's `try/catch` around `expandEpicSubtaskPlans` ensures the primary + remaining subtasks survive if one subtask path is bad.
- **Empty result.** If `records` is empty or every plan file is missing, `buildDispatchPlans` returns `[]`; callers already handle the empty case (`if (validPlans.length === 0) return false`). Preserve those guards.
- **`workingDirectory` override** (CLI dispatch `options.workingDirectory`) and **repoScope** — the override currently replaces both `effectiveWorkspaceRoot` and `effectiveWorkingDir` in `_handleTriggerAgentActionInternal` (lines 15957–15958). The builder computes `workingDir` from `repoScope` and resolves paths against the **real** `workspaceRoot`; when `options.workingDirectory` is set it must still win for the primary plan's `workingDir` only. Apply the override **after** the builder returns, on the primary entry only (subtasks keep their own repoScope-derived dirs, matching today). `generateUnifiedPrompt` is then called with `effectiveWorkspaceRoot` as today.
- **`sessionId` stamping (minor contract change).** `_handleTriggerAgentActionInternal` currently builds its primary `dispatchPlan` with **no** `sessionId` (line 15961); the builder forces `sessionId: rec.sessionId || rec.planId` on every entry. This does not affect prompt text (sessionId is not rendered), but it does change the returned array structure. **Verify** no downstream drag-path consumer assumes the primary's `sessionId` is absent (run-sheet/column-cascade code iterates these arrays). The current `_resolveKanbanDispatchPlans` already stamps `sessionId` on every entry, so this aligns the drag path with the batch path.
- **Multi-repo working dirs.** `buildPromptDispatchContext` switches between single shared `WORKING DIRECTORY` and `MULTI-REPO BATCH` based on distinct `workingDir`s. Since the builder sets `workingDir` exactly as before, this output is unchanged.
- **`sessionId` on returned plans.** Batch/dispatch callers depend on `sessionId` being present on every returned entry (for run-sheet updates, column cascades). The builder must stamp `sessionId` on both primary and subtask entries (subtasks: `sp.sessionId || epicSessionId`) — matching current `_resolveKanbanDispatchPlans` behavior.
- **`~4000 installs` / shipped state.** This is pure in-memory dispatch logic — no persisted format, settings, or files change. No migration required.
- **Published prompt text.** Because the goal is byte-identical non-epic prompts (modulo the documented worktree-heuristic exception above), snapshot prompts **before** the refactor and diff after. Snapshot coverage: (a) planner/coder/reviewer for a normal non-epic plan with no project/sole worktree across all four entry points — byte-identical; (b) a non-epic plan in a project with an active worktree (and a single-worktree workspace) — only the new worktree path/safety-session block may differ; (c) coder/reviewer for an epic across **all four** entry points (board "Copy review prompt", project.html Plans-tab copy, single-card drag→column, multi-card drag) — not only the two previously-broken ones, because the `[EPIC: …]` label change touches the working paths too. Intended diffs: epics show `[EPIC: …]` and the `EPIC MODE` block in the two previously-broken paths, plus the `[EPIC: …]` label improvement in all epic paths.

## Dependencies

- None. This is a self-contained internal refactor of `src/services/KanbanProvider.ts`, `src/services/TaskViewerProvider.ts`, and `src/services/PlanningPanelProvider.ts`. No external library, API, or sibling-plan dependency.

## Adversarial Synthesis

Key risks: (1) the `chatCopyPrompt` sixth construction site was unacknowledged and would false-positive the grep audit — now explicitly documented as out-of-scope; (2) **worktree resolution is NOT a status-filter divergence** (an earlier review claim, checked against source and found false — `getWorktrees()` filters `status='active'` in SQL, so both paths are already active-only). The real difference is the matching *heuristic* (board: `epic_id` + sole-entry; CLI: `epic_id` + `project`); **de-risked by preserving both exactly** via the resolver's map/no-map mode so no proven path changes worktree behavior — the only delta is the two low-traffic copy paths gaining record-based resolution, snapshot-checked; (3) the `epicTopic` label fix changes prompt text in currently-working epic paths, not just the two broken ones — the snapshot diff covers all four entry points. Highest-leverage de-risker: the `buildDispatchPlans` unit test is a **prerequisite** (Step 0), turning the manual snapshot discipline into an automated regression net before any call site is rewired. Mitigations: record-driven builder halves DB reads and eliminates `repoScopeMap` plumbing; error contract unified to catch+continue; circular import avoided by extracting the worktree query to a shared free function; staged rollout (consolidate behavior-preserving first, copy-path worktree delta is the only intended non-epic change).

## Proposed Changes

### 0. Prerequisite — land the acceptance test FIRST (do not rewire any call site until this exists)

This is the single highest-leverage de-risker. Because prompt regressions fail *quietly* (a slightly-wrong prompt, not a crash) and epic dispatch has **no** automated coverage today, the unit test is written **before** the call sites are rewired and serves as the executable spec for `buildDispatchPlans`. Add `src/test/dispatch-plan-builder.test.js` asserting the contract in the Verification Plan (non-epic → single entry + stamped `sessionId`; epic → primary `isEpic` + `epicTopic` + N `isSubtask` subtasks; missing-subtask-file → primary + survivors, no throw; epic array → `buildKanbanBatchPrompt` emits `EPIC MODE` + subtask paths). Implement the builder to satisfy it, then rewire call sites one at a time, re-running the test after each. No call site is migrated while the test is red.

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
            try {
                const subs = await this.expandEpicSubtaskPlans(
                    workspaceRoot, rec.planId, rec.topic || 'Untitled', rec.kanbanColumn || '',
                    worktreePath, opts?.worktreePathMap
                );
                for (const sp of subs) { out.push({ ...sp, sessionId: sp.sessionId || rec.sessionId || rec.planId }); }
            } catch (err) {
                console.warn(`[KanbanProvider] epic subtask expansion failed for ${rec.planId}:`, err);
                // keep primary + any already-pushed subtasks; do not abort
            }
        }
    }
    return out;
}
```

Helpers extracted into `KanbanProvider` (private):
- `_resolveDispatchPlanFile(workspaceRoot, rec)` — returns the first of `rec.planFile` / `rec.mirrorPath` (under `.switchboard/plans/`) / `rec.brainSourcePath` that exists on disk, as a workspace-relative path. This is the logic currently inline only in `_resolveKanbanDispatchPlans` (lines 2984–3012).
- `_resolveWorktreeForRecord(workspaceRoot, rec, map?)` — **mode-selected to preserve each path exactly (no union):**
  - if `map` is provided → **map mode** (board): `map.get(rec.planId) ?? map.get(String(rec.epicId)) ?? (map.size === 1 ? sole value : undefined)`. No `project` match. Identical to today's board logic (KanbanProvider.ts:2525–2535).
  - if `map` is absent → **record mode** (CLI/batch/trigger/copy): delegate to the shared `getActiveWorktreePathFor({epicId, project})` — `epic_id` match → `project` match. No sole-entry fallback. Identical to today's `resolveWorktreePathForPlan`.
  Move the record-mode query into a shared free function (e.g. `KanbanDatabase.getActiveWorktreePathFor({epicId, project})`, or a small `worktreeResolver.ts`) so both `KanbanProvider._resolveWorktreeForRecord` and `TaskViewerProvider.resolveWorktreePathForPlan` delegate to it. No status-filter parameter needed — `getWorktrees()` already filters active. `KanbanProvider` does not depend on `TaskViewerProvider`.
- `_buildActiveWorktreePathMap(workspaceRoot)` — straight extraction of the current inline map logic (lines 2499–2507) over `getWorktrees()`. No filter change (already active-only in SQL); rename keeps the intent explicit.

### 2. Reduce the two main builders to adapters

`KanbanProvider._cardsToPromptPlans` becomes:
```ts
private async _cardsToPromptPlans(cards: KanbanCard[], workspaceRoot: string, _legacyRepoScopeMap?: Map<string,string>): Promise<BatchPromptPlan[]> {
    const db = this._getKanbanDb(workspaceRoot);
    if (!(db && await db.ensureReady())) return [];
    const worktreePathMap = await this._buildActiveWorktreePathMap(workspaceRoot); // extracted, now filters by active
    const records: KanbanPlanRecord[] = [];
    for (const card of cards) {
        const rec = await db.getPlanBySessionId(this._cardId(card));
        if (rec) records.push(rec);
    }
    return this.buildDispatchPlans(workspaceRoot, records, { worktreePathMap });
}
```
(The `repoScopeMap` parameter is retained but ignored, then deleted from call sites in a follow-up pass to keep this diff reviewable. Mark it `_legacyRepoScopeMap` and add a one-line deprecation comment. **Also delete `_buildRepoScopeMap` itself** in that pass — it becomes dead code since the builder sources `repoScope` from the record. This halves per-card DB reads: the old flow called `getPlanBySessionId` in both `_buildRepoScopeMap` and `_cardsToPromptPlans`; the new flow calls it once.)

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
(Drop the existing `try/catch` around `expandEpicSubtaskPlans` — the builder now owns the catch+continue contract.)

### 3. Route the three inline sites through the builder

- `_handleTriggerAgentActionInternal`: replace the hand-built `dispatchPlan` + the (just-added) expansion block with `const dispatchPlans = await this._kanbanProvider.buildDispatchPlans(resolvedWorkspaceRoot, [plan], {...})` where `plan` is the already-fetched record (line 15836). Keep the `effectiveWorkingDir`/`options.workingDirectory` override by applying it to the returned primary plan's `workingDir` **after** the builder returns if `options.workingDirectory` is set (rare path — preserve exactly: builder uses real `resolvedWorkspaceRoot` for path resolution, override only rewrites the primary plan's `workingDir`, then `generateUnifiedPrompt` is called with `effectiveWorkspaceRoot`). Drop the existing `try/catch` around expansion — the builder owns it. Note: the builder stamps `sessionId` on the primary (previously absent); verify no downstream run-sheet/column-cascade consumer assumed an absent primary `sessionId` in this path.
- `_handleCopyPlanLink`: replace the hand-built `[plan]` + expansion with a `buildDispatchPlans(resolvedWorkspaceRoot, [planRecord])` call. Drop the existing `try/catch` around expansion.
- `PlanningPanelProvider` `copyEpicPlannerPrompt`: replace the `[epic] + expandEpicSubtaskPlans` block with `kp.buildDispatchPlans(wsRoot, [epic])`.

After this, **`expandEpicSubtaskPlans` has exactly one caller** (`buildDispatchPlans`), and **no file constructs a `BatchPromptPlan` literal for dispatch through `generateUnifiedPrompt`** except the builder. The two intentionally-excluded sites (`chatCopyPrompt`, `handleGetDefaultPromptPreviews`) bypass `generateUnifiedPrompt` and are documented in the Goal section.

### 4. Guardrail comment + lint note

At each former builder site and at `generateUnifiedPrompt`, add a short comment: `// Plan arrays for dispatch MUST come from KanbanProvider.buildDispatchPlans — do not hand-roll (epic subtasks get silently dropped otherwise).` Add a unit test (below) that fails if a known epic dispatch loses its subtasks.

## Verification Plan

> **Session directives:** SKIP COMPILATION (no `tsc`/build) and SKIP TESTS (no automated test execution) — the user runs these separately. The steps below describe what to verify; the implementer should run the typecheck/test commands only if the user requests it.

### Automated Tests
1. **PREREQUISITE — `src/test/dispatch-plan-builder.test.js` (Step 0). This is the acceptance spec and is written/landed BEFORE any call site is rewired.** It must assert:
   - A non-epic record → single-element array, `isEpic` falsy, no `isSubtask` entries, `sessionId` stamped on the primary (drag-path contract alignment).
   - An epic record with 2 active subtasks → 3 entries: primary `isEpic:true` + `epicTopic` set, two `isSubtask:true` entries with `epicTopic`.
   - Feeding the epic array through `buildKanbanBatchPrompt` yields a prompt containing `EPIC MODE` and both subtask paths.
   - An epic whose one subtask file is missing → primary + remaining subtasks, no throw (catch+continue contract).
   - Worktree mode selection: with a `worktreePathMap` provided → map heuristic (no `project` match); without → record heuristic (no sole-entry). Each asserted against a fixture so the preserve-exact wiring is locked by a test, not just by the snapshot.
   Implement `buildDispatchPlans` to green this test, then migrate call sites one at a time, re-running it after each.
2. `npx tsc --noEmit -p tsconfig.json` → no new errors (baseline currently has 2 pre-existing `TS2835` module-resolution warnings unrelated to this work).
   *(Per the SKIP TESTS / SKIP COMPILATION session directives the **user** runs these commands; the implementer authors the test and keeps it green locally as the gate, but does not invoke the runner unless asked.)*
3. Manual (VSIX): for the artifact-round-trip epic (`a8af9501…`), confirm **all four** of {board "Copy review prompt" card button, project.html Plans-tab copy button, single-card drag→column, multi-card drag} produce a prompt with `EPIC MODE` + both subtasks. Confirm a non-epic plan is unchanged across the same four.
4. `grep` audit: after the refactor, `expandEpicSubtaskPlans(` has exactly one caller (`buildDispatchPlans`), and no `BatchPromptPlan` array literal is built for dispatch through `generateUnifiedPrompt` outside `buildDispatchPlans`. **Known exceptions** (intentionally excluded — bypass `generateUnifiedPrompt`): `chatCopyPrompt` (KanbanProvider.ts:6365), `handleGetDefaultPromptPreviews` (TaskViewerProvider.ts:4093). `copyGeneralChatPrompt` (KanbanProvider.ts:734) uses an empty array and is not a construction site.
5. Before/after prompt snapshot diff:
   - (a) a non-epic plan across all four entry points (board copy, plans-tab copy, single-card drag, multi-card drag), in a plain workspace **and** in a project-worktree / single-worktree workspace — the board, drag, and batch paths must be **byte-identical** in every case (proves preserved worktree behavior).
   - (b) the two **copy** paths only (`_handleCopyPlanLink`, `copyEpicPlannerPrompt`): the sole permitted non-epic delta is a newly record-resolved worktree path + safety-session block where there was none. Any change on a board/drag/batch path means the map/no-map wiring is wrong.
   - (c) an epic across **all four** entry points — intended diffs are the `[EPIC: …]` label in the plan list (all four) and the `EPIC MODE` block + subtask list (the two previously-broken paths: drag→column and plans-tab copy). Confirm the board-copy and batch-dispatch epic paths show the new `[EPIC: …]` label and nothing else changed.
6. Confirm no new circular import between `KanbanProvider` and `TaskViewerProvider` (the worktree query moved to a shared free function).

---

**Recommendation:** Complexity 6 → **Send to Coder.**

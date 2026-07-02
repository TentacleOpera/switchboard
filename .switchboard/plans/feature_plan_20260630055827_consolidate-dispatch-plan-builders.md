# Consolidate the Five Prompt-Dispatch Plan Builders into One

## Goal

Collapse the extension's five separate ways of building the `BatchPromptPlan[]` array (the input to `generateUnifiedPrompt`) into a **single canonical builder**, so that epic-subtask bundling, working-directory resolution, worktree resolution, and plan-file fallback logic exist in exactly one place and cannot drift between entry points.

### Background & root-cause analysis

`generateUnifiedPrompt(role, plans, workspaceRoot, opts)` is the single chokepoint for all prompt **text**. It is called from **22 sites** across `KanbanProvider`, `TaskViewerProvider`, and `PlanningPanelProvider` (re-verified 2026-07-03: 23 `generateUnifiedPrompt(` matches in `src/`, minus the one definition = 22 call sites — count is unchanged since authoring). Epic mode is not a flag the caller sets directly — it is *inferred* inside `generateUnifiedPrompt` (KanbanProvider.ts:3468 as of 2026-07-03; was :3098 at authoring — this file churns fast, re-grep before trusting any line number in this plan):

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
- **Worktree resolution is now THREE-tier, not two (correction, 2026-07-03 — see Post-authoring drift below)**: both paths read active worktrees only — `getWorktrees()` filters `WHERE status='active'` in SQL (KanbanDatabase.ts:2664) — that part is unchanged. But the "Epic Worktree Modes" feature (landed 2026-07-01, after this plan was authored) added a *per-subtask dedicated worktree* tier that outranks both existing heuristics: `worktrees` gained a `subtask_plan_id` column, and `TaskViewerProvider.resolveWorktreePathForPlan(db, {epicId, project, planId})` now checks `planId` against `subtask_plan_id` **first**, then `epic_id`, then `project` (no sole-entry fallback). The board's map-mode path (`_cardsToPromptPlans`) similarly now builds a *second* map — `subtaskWorktreePathMap` (keyed by `subtask_plan_id`) — alongside the existing epic-keyed map, and threads both into `expandEpicSubtaskPlans` so each subtask can resolve to its own dedicated worktree ahead of the shared epic/sole-entry fallback. The primary (non-subtask) card's own resolution in map-mode is unaffected by this — it still only checks its own `planId`/`epic_id` then sole-entry fallback. Net: **map mode gains a pass-through map, record mode gains a top-priority tier** — both described precisely in Decisions below.
- **Plan-file resolution**: `_resolveKanbanDispatchPlans` has full `mirror_path` → `brain_source_path` fallbacks; `_handleCopyPlanLink`'s primary path (`_resolvePlanContextForSession`) has a *partial* fallback to `brain_source_path` only (no `mirror_path`); `_cardsToPromptPlans`, `_handleTriggerAgentActionInternal`, and `copyEpicPlannerPrompt` trust `record.planFile` via `_resolvePlanFilePath` with no fallback at all. The consolidated builder's universal `planFile → mirror_path → brain_source_path` chain is a strict superset of all five, so this doesn't change the design — just corrects the "only one site has fallbacks" oversimplification.
- **`epicTopic` label**: none of the five sets `epicTopic` on the *primary* epic plan object, so the epic line renders as `- [topic]` instead of `- [EPIC: topic]` in `buildPromptDispatchContext`. Cosmetic, but it should be fixed once, centrally.
- **`project` field (new dependency, added after authoring — see Post-authoring drift below)**: all five sites already stamp `project` on every plan entry (primary and subtask). The consolidated builder MUST preserve this — it's no longer optional cosmetic parity, it's load-bearing for per-project PRD injection (see below).

### Post-authoring drift (accuracy audit, 2026-07-03)

This plan was authored 2026-06-30. Two features landed on `main` in the three days since and change contracts this plan depends on. Both are folded into the corrected text throughout (Decisions, Current State, Proposed Changes §1, Edge-Case audit, Verification Plan), but are called out here explicitly since they were invisible at authoring time:

1. **Per-project PRD injection** (landed ~2026-07-01/02, "Project Context" work). `generateUnifiedPrompt` now derives `prdReferences` by collecting `plans.map(p => p.project)` across the whole array (both the custom-agent branch and the built-in branch do this independently) and resolving each distinct project's PRD link into the prompt prefix. This makes `project` a **required-for-correctness** field on every `BatchPromptPlan`, not a nice-to-have — the original Proposed Changes §1 code below omitted it, which would have silently broken PRD injection on every consolidated path. Fixed below.
2. **Per-subtask dedicated worktrees** ("Epic Worktree Modes", landed 2026-07-01). See the worktree-resolution bullet above. This adds a third precedence tier that the original two-tier (map vs record) design didn't anticipate. Fixed below.

Every other line-number citation in this plan was re-verified against `main` as of 2026-07-03 and updated where cited concretely; this file churns at roughly 10+ commits/day (auto-commit-before-review is enabled workspace-wide), so treat any line number here as approximate and re-grep before editing rather than trusting it verbatim.

### Out-of-scope construction sites (explicitly excluded — Clarification)

A complete audit of every `BatchPromptPlan` literal in `src/` (verified via grep, re-verified 2026-07-03 — still exactly these two, no new site has appeared) found **two additional construction sites** that are intentionally **excluded** from this consolidation because they bypass `generateUnifiedPrompt`:

- **`chatCopyPrompt` handler** (KanbanProvider.ts:6875 as of 2026-07-03; was :6365 at authoring) — builds a minimal `chatPlans` array (`topic, absolutePath, sessionId` only) from in-memory cards and calls `buildKanbanBatchPrompt('chat', chatPlans, …)` **directly**, never `generateUnifiedPrompt`. Chat is a consultation role, not an agent dispatch — epic expansion, worktree resolution, and repoScope are correctly irrelevant. **No change.**
- **`handleGetDefaultPromptPreviews`** (TaskViewerProvider.ts:4240 as of 2026-07-03; was :4093 at authoring) — builds a single synthetic `placeholder: BatchPromptPlan` (`{ topic: '[your selected plans]', absolutePath: '/path/to/plan.md' }`) to preview default role prompts with no real plans selected. Intentionally synthetic. **No change.**
- **`copyGeneralChatPrompt`** (KanbanProvider.ts:791 as of 2026-07-03; was :734 at authoring) — calls `buildKanbanBatchPrompt('chat', [], …)` with an **empty** array. Not a construction site. **No change.**

The grep audit in the Verification Plan lists these three as known exceptions so it does not false-positive.

## Metadata

**Tags:** refactor, backend, reliability
**Complexity:** 6

## User Review Required

**None.** The adversarial review framed two items as "behavioral choices to confirm"; both are decided below, with no open product call remaining.

1. **Worktree resolution** — the review framed this as a *status-filter* convergence ("board path is unfiltered, CLI path filters active"). **That premise is false:** `getWorktrees()` already filters `status='active'` in SQL (KanbanDatabase.ts:2664) and `resolveWorktreePathForPlan`'s extra `.filter(w => w.status==='active')` (TaskViewerProvider.ts:7497) is a redundant no-op — both paths are already active-only. There is no status decision. The *real* difference is the matching heuristic, which as of 2026-07-01 is **three-tier, not two** (per-subtask dedicated worktree → `epic_id` → `project`/sole-entry, see Post-authoring drift above); it is **decided** in the Decisions section (**preserve both exactly, including the newer per-subtask tier** via the resolver's map/no-map mode — no proven path changes) and **gated** by a mandatory non-epic worktree snapshot in the Edge-Case audit. No user sign-off required.
2. **`[EPIC: …]` label on currently-working paths** — **decided: intended.** Setting `epicTopic` on the primary epic plan renders `- [EPIC: topic]` instead of `- [topic]` in *all* epic paths (including the ones that already work). It is a pure cosmetic improvement that does not affect epic-mode detection (which keys on `isSubtask`). Covered by the before/after snapshot in the Verification Plan.

## Complexity Audit

### Routine
- Reducing `_cardsToPromptPlans` and `_resolveKanbanDispatchPlans` to thin adapters that resolve records then delegate to `buildDispatchPlans` — mechanical, reuses existing DB methods (`getPlanBySessionId`, `getSubtasksByEpicId`, `getWorktrees`).
- Routing the three inline sites (`_handleTriggerAgentActionInternal`, `_handleCopyPlanLink`, `copyEpicPlannerPrompt`) through the builder — each already fetches the `KanbanPlanRecord`; the change replaces a hand-built literal + expansion block with one call.
- Extracting `_resolveDispatchPlanFile` (the `planFile → mirror → brain` fallback chain) — already written inline in `_resolveKanbanDispatchPlans` (~lines 3125–3143 as of 2026-07-03); extraction is copy-into-method.
- Adding guardrail comments at former builder sites and `generateUnifiedPrompt`.
- Removing the now-dead `_buildRepoScopeMap` method and its call sites (follow-up pass).
- Halving per-card DB reads on the board path (current flow calls `getPlanBySessionId` twice per card — once in `_buildRepoScopeMap`, once in `_cardsToPromptPlans` for `epicId`; the record-driven builder calls it once).

### Complex / Risky
- **Worktree-resolution heuristics** — two divergent matching modes, each now three-tier as of 2026-07-01 (board/map mode: primary checks its own `planId`/`epic_id` then sole-entry fallback, while subtasks additionally get a per-subtask dedicated-worktree check via a threaded `subtaskWorktreePathMap`; CLI/record mode: per-subtask dedicated worktree (`planId` vs `subtask_plan_id`) → `epic_id` → `project`). NOT a status-filter issue (both already active-only). **De-risked by preserving both exactly, including the newer per-subtask tier** via the resolver's map/no-map mode (see Decisions): the board and CLI paths keep their current behavior verbatim, so no proven path changes. The residual risk is now confined to (a) the two copy paths gaining record-based resolution — a small, intended improvement on low-traffic paths, still snapshot-checked — and (b) correctly threading the newer `subtaskWorktreePathMap` through the consolidated builder so per-subtask worktree isolation isn't silently dropped.
- **Error-contract unification** — today the five sites are inconsistent: three wrap `expandEpicSubtaskPlans` in `try/catch` (log + continue), two do not (would throw). The builder must pick one contract and adapters must not double-handle.
- **`options.workingDirectory` override preservation** in `_handleTriggerAgentActionInternal` — the override replaces both `effectiveWorkspaceRoot` and `effectiveWorkingDir`; the builder must use the real root for path resolution, then the override is applied to the primary plan's `workingDir` after the builder returns. Applying it before would resolve paths against the wrong root.
- **Circular-import avoidance** — `KanbanProvider` must not import `TaskViewerProvider` to reach `resolveWorktreePathForPlan`; the worktree query must move to a shared location.

## Decisions (no open questions)

- **One canonical builder, on `KanbanProvider`.** It already owns `expandEpicSubtaskPlans`, `_resolvePlanFilePath`, the worktree-map construction, and `generateUnifiedPrompt`. `TaskViewerProvider` and `PlanningPanelProvider` already hold a `_kanbanProvider`/`kp` reference and call into it. Putting the builder anywhere else would force the DB handle and three private helpers to be threaded out; this is the lowest-coupling home. **Not** creating a new standalone module — that would require passing `KanbanDatabase` + relocating `_resolvePlanFilePath`/worktree logic, a larger blast radius for no functional gain.
- **The builder is record-driven.** Canonical input is `KanbanPlanRecord` (the DB row), because it carries every field needed (`planId`, `topic`, `complexity`, `repoScope`, `epicId`, `isEpic` [number 0/1, coerced via `!!`], `planFile`, `mirrorPath`, `brainSourcePath`, `project`, `kanbanColumn`). Callers that start from `sessionId[]` resolve records first; callers that start from `KanbanCard[]` resolve the record by `sessionId` (the card's in-memory fields are a strict subset of the record, so a DB read loses nothing and gains `repoScope`/fallbacks). Dispatch is not a hot path — one DB read per dispatched card is acceptable and removes the separate `repoScopeMap` plumbing entirely. Note: `_buildRepoScopeMap` already does this same `getPlanBySessionId` read to source `repoScope`, so the builder **halves** the per-card DB reads on the board path (from 2 to 1), not adds one.
- **Worktree resolution moves into the builder, preserving each path's exact current heuristic (conservative — no path gains the union). Updated 2026-07-03 for the per-subtask dedicated-worktree tier that landed 2026-07-01 (see Post-authoring drift).** Both existing paths are already active-only (`getWorktrees()` filters `status='active'` in SQL), so there is no status-filter change. The two paths use *different* matching heuristics — each now three-tier — and the **decision is to preserve both exactly** rather than unify on a superset — the superset would change worktree resolution for non-epic plans on the proven, heavily-used board and CLI paths, which is precisely the risk we are de-risking. The resolver selects mode by the presence of the `worktreePathMap`:
  - **`map` provided (board adapter)** → map heuristic only, unchanged for the primary entry: `map.get(planId)` → `map.get(epicId)` → sole-active-worktree fallback. **No `project` match.** Byte-identical to today's board path. The adapter additionally builds and threads a *second* map, `subtaskWorktreePathMap` (keyed by `subtask_plan_id`), through to `expandEpicSubtaskPlans` unchanged — this only affects subtask entries (handled inside `expandEpicSubtaskPlans` itself, not `_resolveWorktreeForRecord`), so it does not add a tier to the primary's own resolution.
  - **`map` absent (CLI / batch / single-card-trigger / copy adapters)** → record heuristic, **now three-tier**: `rec.planId` match against `subtask_plan_id` (per-subtask dedicated worktree) → `epic_id` match → `project` match. **No sole-entry fallback.** Byte-identical to today's `resolveWorktreePathForPlan(db, {epicId, project, planId})` consumers — the shared free function's signature must include `planId`, not just `{epicId, project}` as originally scoped, or dispatching a lone subtask card directly (not as part of its epic's bundle) through a consolidated adapter would silently lose its dedicated worktree.
  - The proven high-traffic paths (board copy/drop, CLI dispatch, batch dispatch, single-card drag→column) therefore change **zero** worktree behavior. The only delta is the two **copy** paths (`_handleCopyPlanLink`, `copyEpicPlannerPrompt`), which today resolve **no** worktree at all (they pass `undefined`); routed through the builder with no map, they gain the record heuristic (`planId`/`epic_id`/`project`). This is a strict improvement on two low-traffic, recently-fixed paths — not a change to any proven flow. (If you want even those two byte-identical, the builder takes a `skipWorktree` flag; **not recommended** — it would perpetuate the inconsistency where copying an epic omits its safety-session block.)
  - The record-heuristic query (`planId`/`subtask_plan_id` → `epic_id` → `project`) moves to a shared free function so `KanbanProvider` does not import `TaskViewerProvider` (circular-import avoidance — see Edge-Cases). `_buildActiveWorktreePathMap` is a straight extraction of the existing board epic-level map-building over `getWorktrees()` — no filter change — and must also expose (or a sibling helper must build) the `subtaskWorktreePathMap` so the builder can pass it to `expandEpicSubtaskPlans`.
- **`epicTopic` is set on the primary epic plan** inside the builder, so the `[EPIC: …]` label renders correctly everywhere at once. This is safe: `generateUnifiedPrompt` already derives its own `epicTopic` independently from `plans.find(p => !p.isSubtask)?.topic` (KanbanProvider.ts:3468 area), so setting the field on the object only improves `buildPromptDispatchContext`'s per-plan `[EPIC: …]` label rendering and does not change epic-mode detection (which keys on `isSubtask`).
- **`project` is set on every output entry — primary and subtask (new, required — see Post-authoring drift).** The builder must set `project: rec.project || undefined` on the primary plan and pass `rec.project` through as the `epicProject` argument to `expandEpicSubtaskPlans` (which already stamps it on each subtask as `st.project || epicProject`). All five existing sites already do this. Omitting it would silently break the per-project PRD injection that `generateUnifiedPrompt` now performs by collecting `plans.map(p => p.project)` — exactly the class of silent, per-path regression this consolidation exists to prevent.
- **Plan-file fallbacks (`mirror_path`, `brain_source_path`) become universal** by living in the builder, so the copy/drag paths gain the same resilience the batch path already had (today `_handleCopyPlanLink` has a partial `brain_source_path`-only fallback via a different code path, `_resolvePlanContextForSession`; the others have none).
- **Error contract: catch + continue.** The builder wraps `expandEpicSubtaskPlans` in `try/catch` and keeps the primary epic + any already-resolved subtasks on failure (matching the majority behavior and the edge-case note about missing subtask files). Adapters drop their own `try/catch` around the builder call to avoid double-handling.
- **Behavioral parity is the success bar for non-epic prompts, with one narrow documented exception.** The board, CLI, batch, and single-card-trigger paths must emit **byte-identical** non-epic prompts to today (their worktree behavior is preserved verbatim). The *only* permitted non-epic delta is on the two **copy** paths (`_handleCopyPlanLink`, `copyEpicPlannerPrompt`), which may newly gain a record-resolved worktree path + safety-session block where they previously had none — a strict improvement on low-traffic paths. Epics get correctly-bundled prompts; the two intended epic diffs are (a) the two previously-broken paths now show `EPIC MODE` + subtask list, and (b) **all** epic paths now render `- [EPIC: topic]` instead of `- [topic]` (cosmetic label improvement to working paths too).

## Current State

- `src/services/agentPromptBuilder.ts` — `buildKanbanBatchPrompt` (prompt **text**), `BatchPromptPlan` interface (line 28; fields as of 2026-07-03: `topic, absolutePath, complexity?, workingDir?, sessionId?, worktreePath?, epicId?, isSubtask?, epicTopic?, isEpic?, hasOwnWorktree?, project?` — the last two were added after this plan was authored and are both load-bearing for the consolidated builder, see Post-authoring drift), `buildPromptDispatchContext` (renders `[EPIC: …]` / `[SUBTASK] …` / `[topic]` — line 335). **No change needed here** beyond confirming the contract.
- `src/services/KanbanProvider.ts` (line numbers below are as of 2026-07-03; this file moves fast — re-grep before editing)
  - `generateUnifiedPrompt(role, plans, workspaceRoot, opts)` — public chokepoint (line 3311). Infers `epicMode` from `isSubtask` entries and derives its own internal `epicTopic` from the primary non-subtask plan's `topic` (~line 3468). Since authoring, it also independently collects `plans.map(p => p.project)` to resolve per-project PRD links into the prompt prefix (~lines 3341, 3408) — this is why `project` must be carried on every output entry. **Unchanged by this refactor, but now has a hard dependency on `project` being set.**
  - `expandEpicSubtaskPlans(workspaceRoot, epicPlanId, epicTopic, epicColumn, worktreePath?, worktreePathMap?, subtaskWorktreePathMap?, epicProject?)` — public (line 2882). **Signature grew from 6 to 8 params since authoring** (the last two, `subtaskWorktreePathMap` and `epicProject`, landed with the per-subtask-worktree and per-project-PRD features — see Post-authoring drift). The shared subtask expander; the new builder must call it with all 8 args. `epicColumn` param is still currently **unused** inside the body — keep or drop as part of cleanup.
  - `_cardsToPromptPlans(cards, workspaceRoot, repoScopeMap?)` — private (line 2787). Builds **two** worktree maps over `getWorktrees()` (already `status='active'`-filtered in SQL): an epic-keyed map for the primary card's own resolution, and a `subtaskWorktreePathMap` keyed by `subtask_plan_id` that it threads into `expandEpicSubtaskPlans` for per-subtask dedicated-worktree resolution (added 2026-07-01, not present when this plan was authored). **To be reduced to a thin adapter** over the new builder — the adapter must build and pass both maps.
  - `_resolvePlanFilePath(workspaceRoot, planFile)` — private (line 2773). Reused by the builder.
  - `_buildRepoScopeMap(cards, workspaceRoot)` — private (line 3028). Reads `plan.repoScope` via `getPlanBySessionId` per card; **becomes dead code** after the adapter switch (the builder sources `repoScope` from the record directly). Delete in the follow-up pass. Still has 4 call sites today — all follow-up-pass deletions.
  - `chatCopyPrompt` handler (line 6875) — builds `chatPlans` and calls `buildKanbanBatchPrompt('chat', …)` directly. **Out of scope** (see Goal exclusions). No change. Re-verified 2026-07-03: still the only construction site of its kind, no new 6th site has appeared.
- `src/services/TaskViewerProvider.ts`
  - `_resolveKanbanDispatchPlans(sessionIds, workspaceRoot)` — private (line 3098). Already calls `resolveWorktreePathForPlan(db, {epicId, project, planId})` (note the `planId` param, added with the per-subtask-worktree feature) and passes `epicProject` to `expandEpicSubtaskPlans`. **To be reduced to a thin adapter** (resolve records → call builder).
  - `resolveWorktreePathForPlan(db, {epicId, project, planId})` — public static (line 7495). **Signature and logic changed since authoring**: now checks `planId` against `subtask_plan_id` FIRST (per-subtask dedicated worktree), then `epic_id`, then `project` — three tiers, not two. Its `.filter(w => w.status === 'active')` (line 7497) is still redundant — `getWorktrees()` already filters active in SQL.
  - `_handleTriggerAgentActionInternal` (line 16336) and `_handleCopyPlanLink` (line 14407) — inline builders, already patched to expand subtasks and to set `project`/pass `epicProject`; **to call the adapter/builder** instead of constructing arrays by hand.
  - `handleGetDefaultPromptPreviews` (line 4240) — synthetic placeholder preview. **Out of scope.** No change.
- `src/services/PlanningPanelProvider.ts`
  - `copyEpicPlannerPrompt` handler (line 3368) — inline builder, already sets `project` on the primary and passes `epicProject` to `expandEpicSubtaskPlans`; **to call the builder**.
- `src/services/KanbanDatabase.ts` — `KanbanPlanRecord` interface (line 35; `isEpic?: number`, `mirrorPath`, `brainSourcePath`, `repoScope`, `project?`, `kanbanColumn` all present), `getPlanBySessionId` (line 2903), `getSubtasksByEpicId` (line 4159; filters `status = 'active'`), `getWorktrees` (line 2664; the `worktrees` table now also carries `subtask_plan_id`, `base_branch`, `tier` columns, added post-authoring) — all re-verified 2026-07-03, no change.
- Tests: `src/test/` (the deleted `orchestrator-prompt.test.js` is gone; epic dispatch has no direct unit coverage today — this plan adds it).

## Edge-Case & Dependency Audit

- **Circular import (KanbanProvider ↔ TaskViewerProvider).** `resolveWorktreePathForPlan` is a static on `TaskViewerProvider`. `KanbanProvider` must not import `TaskViewerProvider` (they already have a one-way `_kanbanProvider` reference the other direction). **Resolution:** move the worktree-table query into a free function (e.g. in `KanbanDatabase` as `getActiveWorktreePathFor({epicId, project, planId})`, or a small `worktreeResolver.ts`) and have both `KanbanProvider._resolveWorktreeForRecord` and the existing `TaskViewerProvider.resolveWorktreePathForPlan` delegate to it. **The `planId` param is required, not optional** — it carries the per-subtask dedicated-worktree check (`planId` vs `subtask_plan_id`) that now runs before the `epic_id`/`project` tiers. Verify no new import cycle with `madge`/tsc.
- **Worktree-resolution preservation + the non-epic invariant (correctness gate).** There is **no status divergence** — `getWorktrees()` filters `status='active'` in SQL (line 2664), so both `_cardsToPromptPlans` (via `getWorktrees()`) and `resolveWorktreePathForPlan` (whose extra `.filter(active)` at line 7497 is a no-op) already see active-only worktrees. The two heuristics differ and, as of the 2026-07-01 per-subtask-worktree feature, are each three-tier (board/map = primary's own `planId`/`epic_id` then sole-entry fallback, with a separately-threaded `subtaskWorktreePathMap` for subtask entries; CLI/record = `planId` vs `subtask_plan_id` → `epic_id` → `project`), and the resolver **preserves both exactly** via its map/no-map mode (see Decisions). **Mandatory verification:** (1) board, CLI, batch, and single-card-trigger paths must be **byte-identical** before/after for both epic and non-epic plans — including in project-worktree, single-worktree, and per-subtask-dedicated-worktree workspaces (this is the proof that the proven paths' worktree behavior, including the newer per-subtask tier, is unchanged). (2) The two copy paths (`_handleCopyPlanLink`, `copyEpicPlannerPrompt`) are the *only* permitted non-epic delta: a plan there may newly gain a record-resolved (`planId`/`epic_id`/`project`) worktree path + safety-session block where it previously had none. Any worktree change on a proven path means the map/no-map wiring is wrong — stop and fix.
- **`project` propagation (new correctness gate, added 2026-07-03 — see Post-authoring drift).** Every output entry — primary and subtask — must carry `project` (sourced from `rec.project`, with subtasks falling back to the epic's project via the `epicProject` argument to `expandEpicSubtaskPlans`, matching all five existing sites today). `generateUnifiedPrompt` now derives its per-project PRD `prdReferences` block by scanning `plans.map(p => p.project)`; dropping this field on any path would silently omit PRD context from that path's prompts with no error or warning. Add an explicit assertion in the Step 0 test (below) that `project` survives the builder for both primary and subtask entries.
- **Optimistic board state vs DB.** `_cardsToPromptPlans` currently reads `card.column`/`card.isEpic` from in-memory `_lastCards`, which during an optimistic drag may be a step ahead of the DB. Switching to a DB read per card means the builder sees committed state. Dispatch persists the column move to the DB *before* prompt generation in the existing flows, so this is safe — **but verify** the `promptOnDrop`/`triggerAction` ordering still persists-then-builds (it does today: `moveCardToColumn`/`_updateKanbanColumnForSession` run before/around prompt gen). Add a regression check for an epic dragged from `CODER CODED`.
- **`isEpic` staleness / sticky flag.** `upsertPlan` keeps `is_epic` sticky (`CASE WHEN excluded.is_epic > 0 …`). The builder reads `rec.isEpic` (a `number`, coerced via `!!`) straight from the row, so a freshly-promoted epic is correctly detected as long as `getPlanBySessionId` returns the post-promotion row. No change to promotion logic.
- **Subtask with no plan file / archived subtask.** `expandEpicSubtaskPlans` already filters to `status='active'` (verified, `getSubtasksByEpicId` at KanbanDatabase.ts:4159 as of 2026-07-03) and resolves paths via `_resolvePlanFilePath`; preserve that. A subtask whose file is missing should be skipped, not abort the whole epic — the builder's `try/catch` around `expandEpicSubtaskPlans` ensures the primary + remaining subtasks survive if one subtask path is bad.
- **Empty result.** If `records` is empty or every plan file is missing, `buildDispatchPlans` returns `[]`; callers already handle the empty case (`if (validPlans.length === 0) return false`). Preserve those guards.
- **`workingDirectory` override** (CLI dispatch `options.workingDirectory`) and **repoScope** — the override currently replaces both `effectiveWorkspaceRoot` and `effectiveWorkingDir` in `_handleTriggerAgentActionInternal` (~lines 16530–16531 as of 2026-07-03). The builder computes `workingDir` from `repoScope` and resolves paths against the **real** `workspaceRoot`; when `options.workingDirectory` is set it must still win for the primary plan's `workingDir` only. Apply the override **after** the builder returns, on the primary entry only (subtasks keep their own repoScope-derived dirs, matching today). `generateUnifiedPrompt` is then called with `effectiveWorkspaceRoot` as today.
- **`sessionId` stamping (minor contract change).** `_handleTriggerAgentActionInternal` currently builds its primary `dispatchPlan` with **no** `sessionId` (~line 16537 as of 2026-07-03); the builder forces `sessionId: rec.sessionId || rec.planId` on every entry. This does not affect prompt text (sessionId is not rendered), but it does change the returned array structure. **Verify** no downstream drag-path consumer assumes the primary's `sessionId` is absent (run-sheet/column-cascade code iterates these arrays). The current `_resolveKanbanDispatchPlans` already stamps `sessionId` on every entry, so this aligns the drag path with the batch path.
- **Multi-repo working dirs.** `buildPromptDispatchContext` switches between single shared `WORKING DIRECTORY` and `MULTI-REPO BATCH` based on distinct `workingDir`s. Since the builder sets `workingDir` exactly as before, this output is unchanged.
- **`sessionId` on returned plans.** Batch/dispatch callers depend on `sessionId` being present on every returned entry (for run-sheet updates, column cascades). The builder must stamp `sessionId` on both primary and subtask entries (subtasks: `sp.sessionId || epicSessionId`) — matching current `_resolveKanbanDispatchPlans` behavior.
- **`~4000 installs` / shipped state.** This is pure in-memory dispatch logic — no persisted format, settings, or files change. No migration required.
- **Published prompt text.** Because the goal is byte-identical non-epic prompts (modulo the documented worktree-heuristic exception above), snapshot prompts **before** the refactor and diff after. Snapshot coverage: (a) planner/coder/reviewer for a normal non-epic plan with no project/sole worktree across all four entry points — byte-identical; (b) a non-epic plan in a project with an active worktree (and a single-worktree workspace) — only the new worktree path/safety-session block may differ; (c) coder/reviewer for an epic across **all four** entry points (board "Copy review prompt", project.html Plans-tab copy, single-card drag→column, multi-card drag) — not only the two previously-broken ones, because the `[EPIC: …]` label change touches the working paths too. Intended diffs: epics show `[EPIC: …]` and the `EPIC MODE` block in the two previously-broken paths, plus the `[EPIC: …]` label improvement in all epic paths.

## Dependencies

- None. This is a self-contained internal refactor of `src/services/KanbanProvider.ts`, `src/services/TaskViewerProvider.ts`, and `src/services/PlanningPanelProvider.ts`. No external library, API, or sibling-plan dependency.

## Adversarial Synthesis

Key risks: (1) the `chatCopyPrompt` sixth construction site was unacknowledged and would false-positive the grep audit — now explicitly documented as out-of-scope (re-verified 2026-07-03: still the only exception, no new site has appeared); (2) **worktree resolution is NOT a status-filter divergence** (an earlier review claim, checked against source and found false — `getWorktrees()` filters `status='active'` in SQL, so both paths are already active-only). The real difference is the matching *heuristic*, which as of a feature that landed 2026-07-01 (after this plan's original authoring — see Post-authoring drift) is **three-tier on both sides**, not two (board/map: primary's own `planId`/`epic_id` + sole-entry, subtasks additionally get a per-subtask dedicated-worktree map; CLI/record: per-subtask dedicated worktree (`planId` vs `subtask_plan_id`) → `epic_id` → `project`); **de-risked by preserving both exactly, including the newer tier,** via the resolver's map/no-map mode so no proven path changes worktree behavior — the only delta is the two low-traffic copy paths gaining record-based resolution, snapshot-checked; (3) the `epicTopic` label fix changes prompt text in currently-working epic paths, not just the two broken ones — the snapshot diff covers all four entry points; (4) **`project` propagation was missing from the original builder code** (added 2026-07-03 audit) — a second feature landed post-authoring (per-project PRD injection, ~2026-07-01/02) made `project` load-bearing on every plan entry, and the original Section 1 code below did not set it; this would have been a sixth silent per-path regression of exactly the kind this plan exists to eliminate, now fixed in the code sample. Highest-leverage de-risker: the `buildDispatchPlans` unit test is a **prerequisite** (Step 0), turning the manual snapshot discipline into an automated regression net before any call site is rewired — it must assert `project` and the three-tier worktree precedence explicitly (see Verification Plan). Mitigations: record-driven builder halves DB reads and eliminates `repoScopeMap` plumbing; error contract unified to catch+continue; circular import avoided by extracting the worktree query to a shared free function; staged rollout (consolidate behavior-preserving first, copy-path worktree delta is the only intended non-epic change).

## Proposed Changes

### 0. Prerequisite — land the acceptance test FIRST (do not rewire any call site until this exists)

This is the single highest-leverage de-risker. Because prompt regressions fail *quietly* (a slightly-wrong prompt, not a crash) and epic dispatch has **no** automated coverage today, the unit test is written **before** the call sites are rewired and serves as the executable spec for `buildDispatchPlans`. Add `src/test/dispatch-plan-builder.test.js` asserting the contract in the Verification Plan (non-epic → single entry + stamped `sessionId`; epic → primary `isEpic` + `epicTopic` + N `isSubtask` subtasks; missing-subtask-file → primary + survivors, no throw; epic array → `buildKanbanBatchPrompt` emits `EPIC MODE` + subtask paths). Implement the builder to satisfy it, then rewire call sites one at a time, re-running the test after each. No call site is migrated while the test is red.

### 1. Add the canonical builder to `KanbanProvider`

> **Corrected 2026-07-03** — the version below fixes two omissions found by accuracy audit against `main` as it stands three days after authoring (see Post-authoring drift): it now stamps `project` on every entry (required for per-project PRD injection) and calls `expandEpicSubtaskPlans` with its full current 8-arg signature (the original sample used the 6-arg signature that existed at authoring time; `subtaskWorktreePathMap` and `epicProject` were added 2026-07-01/02).

```ts
/**
 * THE single place that turns plan records into the BatchPromptPlan[] passed to
 * generateUnifiedPrompt. Resolves plan-file path (with mirror/brain fallbacks),
 * working dir (repoScope), worktree path, isEpic, project, and — for epics —
 * appends the full active-subtask bundle so generateUnifiedPrompt enters epic mode.
 * Every dispatch/copy entry point MUST funnel through this. Do not build a
 * BatchPromptPlan array anywhere else.
 */
public async buildDispatchPlans(
    workspaceRoot: string,
    records: KanbanPlanRecord[],
    opts?: { worktreePathMap?: Map<string, string>; subtaskWorktreePathMap?: Map<string, string> }
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
            project: rec.project || undefined,   // REQUIRED — drives per-project PRD injection in generateUnifiedPrompt
            ...(isEpic ? { epicTopic: rec.topic } : {}),   // primary epic gets [EPIC: …] label
        });
        if (isEpic && hasDb && rec.planId) {
            try {
                const subs = await this.expandEpicSubtaskPlans(
                    workspaceRoot, rec.planId, rec.topic || 'Untitled', rec.kanbanColumn || '',
                    worktreePath, opts?.worktreePathMap, opts?.subtaskWorktreePathMap, rec.project || undefined
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
- `_resolveDispatchPlanFile(workspaceRoot, rec)` — returns the first of `rec.planFile` / `rec.mirrorPath` (under `.switchboard/plans/`) / `rec.brainSourcePath` that exists on disk, as a workspace-relative path. This is the logic currently inline only in `_resolveKanbanDispatchPlans` (~lines 3125–3143 as of 2026-07-03).
- `_resolveWorktreeForRecord(workspaceRoot, rec, map?)` — **mode-selected to preserve each path exactly (no union). Updated for the per-subtask-worktree tier that landed 2026-07-01 (see Post-authoring drift):**
  - if `map` is provided → **map mode** (board), unchanged from authoring: `map.get(rec.planId) ?? map.get(String(rec.epicId)) ?? (map.size === 1 ? sole value : undefined)`. No `project` match. Identical to today's board logic for the primary entry (KanbanProvider.ts:2820–2838 as of 2026-07-03). Subtasks' own dedicated-worktree resolution happens *inside* `expandEpicSubtaskPlans` via the separately-passed `subtaskWorktreePathMap` (see `buildDispatchPlans` above), not here — this function is only ever called for the primary/non-subtask entry.
  - if `map` is absent → **record mode** (CLI/batch/trigger/copy), **now three-tier**: delegate to the shared `getActiveWorktreePathFor({epicId, project, planId})` — `rec.planId` match against `subtask_plan_id` (per-subtask dedicated worktree) → `epic_id` match → `project` match. No sole-entry fallback. Identical to today's `resolveWorktreePathForPlan(db, {epicId, project, planId})`. **The `planId` argument must not be dropped** — omitting it would silently break dedicated-worktree resolution for a subtask dispatched on its own (not as part of an epic bundle) through any of the CLI/batch/trigger/copy adapters.
  Move the record-mode query into a shared free function (e.g. `KanbanDatabase.getActiveWorktreePathFor({epicId, project, planId})`, or a small `worktreeResolver.ts`) so both `KanbanProvider._resolveWorktreeForRecord` and `TaskViewerProvider.resolveWorktreePathForPlan` delegate to it. No status-filter parameter needed — `getWorktrees()` already filters active. `KanbanProvider` does not depend on `TaskViewerProvider`.
- `_buildActiveWorktreePathMap(workspaceRoot)` — straight extraction of the current inline epic-keyed map logic over `getWorktrees()` (KanbanProvider.ts:2796–2810 as of 2026-07-03, which today also builds a second `subtaskWorktreePathMap` keyed by `subtask_plan_id` in the same pass). **This helper must return or expose both maps** (e.g. `{ worktreePathMap, subtaskWorktreePathMap }`) so the board adapter (Section 2) can pass `subtaskWorktreePathMap` through to `buildDispatchPlans`'s `opts` and on into `expandEpicSubtaskPlans` — omitting it would regress per-subtask dedicated-worktree resolution on the board path, a working feature today. No filter change (already active-only in SQL); rename keeps the intent explicit.

### 2. Reduce the two main builders to adapters

`KanbanProvider._cardsToPromptPlans` becomes (**corrected 2026-07-03** to also build and thread `subtaskWorktreePathMap` — the original sample only carried the epic-keyed map, which would have silently dropped per-subtask dedicated-worktree resolution on the board path, a feature that landed 2026-07-01 and works today):
```ts
private async _cardsToPromptPlans(cards: KanbanCard[], workspaceRoot: string, _legacyRepoScopeMap?: Map<string,string>): Promise<BatchPromptPlan[]> {
    const db = this._getKanbanDb(workspaceRoot);
    if (!(db && await db.ensureReady())) return [];
    const { worktreePathMap, subtaskWorktreePathMap } = await this._buildActiveWorktreePathMap(workspaceRoot); // extracted, now filters by active
    const records: KanbanPlanRecord[] = [];
    for (const card of cards) {
        const rec = await db.getPlanBySessionId(this._cardId(card));
        if (rec) records.push(rec);
    }
    return this.buildDispatchPlans(workspaceRoot, records, { worktreePathMap, subtaskWorktreePathMap });
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

- `_handleTriggerAgentActionInternal`: replace the hand-built `dispatchPlan` + the (already-patched) expansion block with `const dispatchPlans = await this._kanbanProvider.buildDispatchPlans(resolvedWorkspaceRoot, [plan], {...})` where `plan` is the already-fetched record (`db.getPlanBySessionId(sessionId)`, ~line 16393 as of 2026-07-03). This adapter is in **record mode** (no `worktreePathMap`), so worktree resolution falls to `_resolveWorktreeForRecord`'s three-tier path — matching today's `resolveWorktreePathForPlan(db, {epicId, project, planId: plan.planId})` call at ~line 16403, which already includes the per-subtask dedicated-worktree tier. Keep the `effectiveWorkingDir`/`options.workingDirectory` override by applying it to the returned primary plan's `workingDir` **after** the builder returns if `options.workingDirectory` is set (rare path — preserve exactly: builder uses real `resolvedWorkspaceRoot` for path resolution, override only rewrites the primary plan's `workingDir`, then `generateUnifiedPrompt` is called with `effectiveWorkspaceRoot`). Drop the existing `try/catch` around expansion — the builder owns it. Note: the builder stamps `sessionId` on the primary (previously absent); verify no downstream run-sheet/column-cascade consumer assumed an absent primary `sessionId` in this path.
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
   - **`project` propagation (added 2026-07-03 audit — see Post-authoring drift):** a record with `project: 'Acme'` → the primary output entry has `project: 'Acme'`; for an epic, every subtask entry also has `project` set (either its own or the epic's, via the `epicProject` fallback). Assert this for both the primary and subtask paths — this is a required field for per-project PRD injection, not cosmetic.
   - Worktree mode selection, **now three-tier on both sides:** with a `worktreePathMap` provided → map heuristic on the primary (`planId` → `epicId` → sole-entry, no `project` match); without → record heuristic (`planId` vs `subtask_plan_id` → `epicId` → `project`, no sole-entry). Add a fixture where a record's `planId` matches a `subtask_plan_id`-tagged worktree and assert it wins over an `epic_id` match in record mode (proves the new top tier isn't dropped). Each mode asserted against a fixture so the preserve-exact wiring is locked by a test, not just by the snapshot.
   Implement `buildDispatchPlans` to green this test, then migrate call sites one at a time, re-running it after each.
2. `npx tsc --noEmit -p tsconfig.json` → no new errors (baseline had 2 pre-existing `TS2835` module-resolution warnings unrelated to this work at authoring time — re-check the current baseline count before treating any warning as new).
   *(Per the SKIP TESTS / SKIP COMPILATION session directives the **user** runs these commands; the implementer authors the test and keeps it green locally as the gate, but does not invoke the runner unless asked.)*
3. Manual (VSIX): for a real epic with active subtasks on the board, confirm **all four** of {board "Copy review prompt" card button, project.html Plans-tab copy button, single-card drag→column, multi-card drag} produce a prompt with `EPIC MODE` + both subtasks. Confirm a non-epic plan is unchanged across the same four. Also confirm the prompt's PRD-reference block (if the project-context toggle is on and the plan has an assigned project) is present on all four — this is the manual check for the `project`-propagation fix.
4. `grep` audit: after the refactor, `expandEpicSubtaskPlans(` has exactly one caller (`buildDispatchPlans`), and no `BatchPromptPlan` array literal is built for dispatch through `generateUnifiedPrompt` outside `buildDispatchPlans`. **Known exceptions** (intentionally excluded — bypass `generateUnifiedPrompt`): `chatCopyPrompt` (KanbanProvider.ts, `chatCopyPrompt` case in the message handler), `handleGetDefaultPromptPreviews` (TaskViewerProvider.ts). `copyGeneralChatPrompt` (KanbanProvider.ts) uses an empty array and is not a construction site. Re-grep for exact current line numbers before running this audit — they drift fast in this file (see Post-authoring drift).
5. Before/after prompt snapshot diff:
   - (a) a non-epic plan across all four entry points (board copy, plans-tab copy, single-card drag, multi-card drag), in a plain workspace, a project-worktree / single-worktree workspace, **and** a workspace where the dispatched plan itself has a dedicated per-subtask worktree — the board, drag, and batch paths must be **byte-identical** in every case (proves preserved worktree behavior across all three tiers, not just the two that existed at authoring time).
   - (b) the two **copy** paths only (`_handleCopyPlanLink`, `copyEpicPlannerPrompt`): the sole permitted non-epic delta is a newly record-resolved worktree path + safety-session block where there was none. Any change on a board/drag/batch path means the map/no-map wiring is wrong.
   - (c) an epic across **all four** entry points — intended diffs are the `[EPIC: …]` label in the plan list (all four) and the `EPIC MODE` block + subtask list (the two previously-broken paths: drag→column and plans-tab copy). Confirm the board-copy and batch-dispatch epic paths show the new `[EPIC: …]` label and nothing else changed.
6. Confirm no new circular import between `KanbanProvider` and `TaskViewerProvider` (the worktree query moved to a shared free function).

---

**Recommendation:** Complexity 6 → **Send to Coder.**

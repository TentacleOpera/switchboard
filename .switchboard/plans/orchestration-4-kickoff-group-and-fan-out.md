# Orchestration Kickoff — Auto-Group into Features (+ Miscellaneous) and Fan Out to Worktrees

## Goal

Implement what happens when the user presses **Start orchestrator**: the orchestrator batches all eligible plans into features (with the confirm gate off and a `Miscellaneous` sweep so nothing is left loose), the system auto-creates each feature's worktrees and terminals, and the orchestrator dispatches each feature's subtasks by stage, then goes to sleep.

### Problem / background / root cause

Grouping, worktree creation, and dispatch all exist as separate operations today, driven by a human. `group-into-features` (`.agents/skills/group-into-features/SKILL.md`) clusters loose plans but has a **load-bearing confirm gate** (step 4 CONFIRM, `SKILL.md:89-91`, reinforced by the "never create any feature before the user approves" note at `:127`) that blocks unattended use, and it leaves genuinely standalone plans ungrouped by design. Worktree-per-feature creation and terminal provisioning already fire off feature/card operations. Kickoff's job is to sequence these into one unattended pass so a batch goes from "20 loose cards in Plan Reviewed" to "every card in a feature, worktrees up, coders dispatched" without a human clicking through each step.

**What code-reading resolved (corrections to the draft's open questions):**

- **Programmatic feature creation already provisions worktrees — no wiring needed.** `createFeatureFromPlanIds` (`src/services/KanbanProvider.ts:10722-10727`) snapshots `feature_worktree_mode` and, in `per-subtask` mode, calls `_ensureFeatureIntegrationWorktree` (`:9734-9766`) up front, then `_provisionSubtaskWorktreeIfNeeded` (`:9860-9895`) for every linked subtask (`:10736`). `assignPlansToFeature` does the same per assigned plan (`:10801`, `:10811`). Both are reached from the API routes the verb scripts call (`/kanban/feature` → LocalApiServer.ts:1346, `/kanban/feature/assign` → `:1348`). Worktree rows are written via `db.addWorktree` and terminals via `ensureWorktreeTerminals`, so the Worktrees tab (DB-backed, no reconciliation) stays truthful. The orchestrator never runs raw `git worktree add`.
- **The "established per-column dispatch" does not route to worktree terminals on its own.** The autoban tick path (`_autobanTickColumn`, `src/services/TaskViewerProvider.ts:8836-8984`) selects a terminal by pool round-robin (`_selectAutobanTerminal`, `:6873-6908` — least-send-count + cursor, **not worktree-aware**) and passes it as `targetTerminalOverride` (`:8890-8896`), which suppresses the worktree-terminal resolution that only runs in the no-override path (`handleKanbanBatchTrigger` `:3743-3747` → `_resolveAgentTerminalForPlan` `:6539-6549` → `_findTerminalNameByWorktreePathAndRole` `:6551-6582`). Kickoff therefore needs an explicit worktree-aware fan-out entry (see Proposed Changes §3) rather than "just let the tick do it".
- **`/kanban/move` does not dispatch, and feature-card cascades don't even fire arrival events.** Dispatch fires *from* a source column (PLAN REVIEWED) via the tick or watch-arrival; the dispatch itself moves the card to the role's coded column *before* sending the prompt (`_targetColumnForRole` `:2278-2298` → LEAD/CODER/INTERN CODED; pre-dispatch move at `:3769-3786`). Watch arrival (`_notifyAutobanWatchArrival` `:8818-8833`) is fed by `db.onColumnChanged`, which `updateColumn` fires (`KanbanDatabase.ts:1741`) but `cascadeFeatureByPlanId` (`:4602-4642`, used for feature-card moves at `KanbanProvider.ts:6092-6097`) does **not**. So moving a feature card via `/kanban/move` can never trigger subtask dispatch.
- **A Start-time ordering race exists.** `_startAutobanEngine` fires an immediate tick per enabled column (`TaskViewerProvider.ts:8754-8755`). If orchestration mode armed the standard PLAN REVIEWED rule, loose plans would be dispatched *before* the orchestrator groups them into features/worktrees. Orchestration mode must not arm the per-column timers; kickoff dispatch is explicit (§3).

## Metadata
**Complexity:** 7
**Tags:** backend, feature, api
**Project:** Switchboard

## User Review Required

None. (Design decisions settled below: unattended grouping lives as an explicit "Unattended mode" section in the existing skill file; fan-out is a new authenticated localhost route `POST /kanban/orchestration/dispatch` handled by a worktree-aware dispatcher; kickoff dispatches PLAN REVIEWED subtasks only — CREATED subtasks stay for human planning per the feature's scope discipline; when a subtask's worktree terminal is missing the fan-out skips it and logs rather than falling back to the main checkout.)

## Complexity Audit

### Routine
- Adding the `Unattended mode (orchestration)` section to `.agents/skills/group-into-features/SKILL.md` — pure prompt text, no code.
- The `Miscellaneous` sweep procedure — reuses `create-feature.js` / `assign-to-feature.js` verbatim (both already skip-and-report and have no direct-DB fallback).
- New LocalApiServer route registration — copies the `_handleKanbanMove` pattern (`LocalApiServer.ts:322-361`, dispatch table `:1344-1355`); auth is the localhost boundary (`_checkAuth` `:219-222`), same as every other route.
- Kickoff prompt assembly — extends the existing `_buildSuggestFeaturesPrompt` injection pattern (`KanbanProvider.ts:10944-10984`) with the active project filter read from DB config `kanban.activeProjectFilter` (same key `createFeatureFromPlanIds` falls back to at `:10611`).

### Complex / Risky
- The worktree-aware fan-out dispatcher: complexity routing, per-worktree terminal resolution, feature-card/subtask dedupe, concurrency cap, and in-flight locking all interact; the existing tick path solves each differently and none solves all of them together.
- Start-time gating: suppressing per-column autoban timers in orchestration mode without disturbing the other three modes' engine behavior.
- Terminal volume: per-subtask mode provisions (1 integration + N subtask) worktrees per feature × one terminal per enabled agent role (`ensureWorktreeTerminals`, `TaskViewerProvider.ts:7669-7756`) — a large batch can create dozens of terminals and pin the extension host (known refresh-storm failure mode).

## Edge-Case & Dependency Audit

**Race Conditions**
- *Immediate tick before grouping:* solved structurally — orchestration mode never arms the per-column rule timers (Proposed Changes §4); dispatch happens only via the explicit route after grouping completes.
- *Concurrent integration-worktree creation:* already guarded — `_ensureFeatureIntegrationWorktree` uses check-then-create with a race fallback re-read (`KanbanProvider.ts:9729-9732`, `:9762-9764`).
- *Plan watcher vs feature-file write:* already guarded — `registerPendingCreation` is called before the file write (`:10712-10715`).
- *User drags cards / edits the board mid-kickoff:* the orchestrator works from a one-shot board snapshot; stale planIds are tolerated — `createFeatureFromPlanIds` warns and creates with fewer subtasks (`:10592-10598`), `assignPlansToFeature` skips-and-reports (`:10807-10809`).
- *Double dispatch (manual + fan-out):* reuse the `_activeDispatchSessions` lock exactly as the tick does (`TaskViewerProvider.ts:8889`), released by `_releaseSettledDispatchLocks`.
- *Feature card + subtask cards both eligible:* `db.getBoard` returns feature rows and subtask rows alike (`KanbanDatabase.ts:2753-2762`) and `_collectKanbanCardsInColumns` (`TaskViewerProvider.ts:7969-8001`) does not filter `isFeature` — a naive column sweep would dispatch a feature card (which `buildDispatchPlans` expands to all subtasks, `KanbanProvider.ts:3671`) *and* the same subtasks individually. The fan-out dispatches via `db.getSubtasksByFeatureId` filtered to PLAN REVIEWED, never via raw column sweep, so feature cards are structurally excluded.
- *Active project filter changes mid-run:* snapshot `kanban.activeProjectFilter` once at Start and inject it into the kickoff prompt; do not re-read at grouping time (project-pinning rule).

**Security**
- The API is localhost-only; `_checkAuth` trusts the localhost boundary (`LocalApiServer.ts:219-222`) — the new route follows suit, no token plumbing needed (the verb scripts send none today).
- Shell-metacharacter injection through feature names/goal text is a real hazard the skill already documents (`SKILL.md:96-98` — escape `"`; avoid `$`, backticks, backslashes). The unattended section must repeat this rule since no human reviews the generated commands.
- No path traversal surface: the new route takes planIds/feature ids, not paths.

**Side Effects**
- **Feature creation DOES sync outbound to Linear/ClickUp when real-time sync is enabled** — `createFeatureFromPlanIds` ends with `_syncFeatureOutbound` (`KanbanProvider.ts:10753-10760`), gated on `realTimeSyncEnabled` (`:10904-10910`). The header comments in `create-feature.js` (lines 9-11) and the skill's Notes (`SKILL.md:125`) claiming "does NOT sync" are stale; an unattended batch run can create a burst of external tracker items. Documented as expected behavior, not suppressed.
- Each feature creation triggers a board refresh (`:10751-10752`); creating features sequentially (as the skill already does) keeps this to N refreshes for N features.
- Terminal creation: `ensureWorktreeTerminals` makes one terminal per enabled agent role per worktree, warns at the per-worktree per-role cap (`TaskViewerProvider.ts:7714`, `MAX_AUTOBAN_TERMINALS_PER_ROLE = 5`, `autobanState.ts:16`) and appends new names to the autoban pools with a 5-per-role slice (`:7743-7744`, `_limitAutobanPool` `:6626-6632`). Pool overflow beyond 5 is harmless to the fan-out (it resolves terminals by worktree path, not pool rotation) but means pool bookkeeping under-counts — cosmetic only.
- Dispatch moves cards to the role's coded column before the prompt is sent (`:3769-3786`) — the board will show subtasks in LEAD/CODER/INTERN CODED while agents work; this is existing behavior, unchanged.

**Dependencies & Conflicts**
- **Blocked by subtask 1** (mode foundation): the `'orchestration'` enum value, `OrchestrationConfig`, the Start button, the `startOrchestrator` handler, and the coupling that sets `feature_worktree_mode` (valid values `'none' | 'per-subtask' | 'high-low'`, validated at `KanbanProvider.ts:9176`; the "worktree-per-feature" coupling must set **`'per-subtask'`** — that is the mode that provisions an integration worktree per feature plus one worktree per subtask, matching this plan's fan-out topology).
- **Coordinates with subtask 2** (persona workflow): the kickoff procedure the orchestrator terminal *follows* lives in `.agents/workflows/orchestrator.md`; this plan owns the system-side machinery and the skill's unattended section that the persona references. No file overlap: this plan does not write `orchestrator.md`.
- **Feeds subtask 5** (wake/triage): subtasks beyond the concurrency cap stay in PLAN REVIEWED for later wake ticks to fan out; the "dispatched and sleeping" end state is subtask 5's starting contract.
- Independent of subtask 3 (inbox/session log), except that fan-out skip events should be written where the session log will live (append-only file write; safe even if subtask 3 lands later — the wake loop just finds a pre-existing log).
- Conflict watch: `assignPlansToFeature` honors `feature_lock_columns` (default `'IN PROGRESS,CODE REVIEW,REVIEWED,DONE'`, `:10793-10797`) — a pre-existing `Miscellaneous` feature in a locked column will refuse assignment; the sweep handles this (see §1 Edge Cases).

## Dependencies

None (no `sess_` dependencies known). Sibling ordering: depends on subtask 1 (orchestration-1-automation-mode-foundation — enum, config, Start button, worktree-mode coupling) landing first; the grouping procedure text is referenced from subtask 2's persona doc (orchestration-2-persona-workflow); the fan-out's "remainder queues in PLAN REVIEWED" contract is consumed by subtask 5 (orchestration-5-wake-triage-and-merge-back).

## Adversarial Synthesis

The two ways this plan fails are (1) trusting the existing autoban tick to deliver coders into worktree terminals — it provably does not (pool round-robin overrides worktree resolution), and (2) letting the engine's immediate Start tick dispatch loose plans before grouping runs. Both are closed structurally: orchestration mode arms no column timers, and dispatch goes through a new worktree-resolving route that skips (never falls back to the main checkout) when a worktree terminal is missing. Residual risk concentrates in terminal volume on large batches and in the unattended shell-command generation from plan-title text, both mitigated but not eliminated.

## Proposed Changes

### 1. `.agents/skills/group-into-features/SKILL.md` — Unattended mode + `Miscellaneous` sweep

**Context.** The skill's flow is SCAN (`:15-36`, board snapshot read; skip lines tagged `feature` or `subtask-of:` per `:34-36`) → DETERMINE PROJECT SCOPE (`:38-58`, `{{ACTIVE_PROJECT_FILTER}}` semantics: named project / `__unassigned__` / empty = all) → READ PLAN BODIES (`:60-66`) → PROPOSE (`:68-87`) → CONFIRM (`:89-91`) → EXECUTE (`:93-114`, `create-feature.js` invocation at `:100-101`) → optional BACKLOG (`:116-121`). The board snapshot is now a link table: `.switchboard/kanban-board.md` links per-column `kanban-state-*.md` files (verified in-repo); plan lines carry `planId:` / `feature` / `subtask-of:"..."` / `project:"..."` HTML-comment tags. The confirm gate is documented load-bearing at `:127`.

**Logic.** The orchestrator (via its persona, subtask 2) runs SCAN → READ → PROPOSE → EXECUTE **without CONFIRM** — the gate-off decision is intentional and documented in the feature (users who want to curate groupings do so manually before starting). Reuse `create-feature.js` / `assign-to-feature.js` exactly as the skill documents. After real groups are created, **sweep all remaining standalone in-scope plans into a single `Miscellaneous` feature** so the batch has no ungrouped remainder, handling the already-exists case by reusing the existing `Miscellaneous` feature. Scope matches the skill: pre-coding columns (CREATED, PLAN REVIEWED), respecting any active project filter.

**Implementation.**
- Append a new section `## Unattended mode (orchestration)` to the skill. It applies only when the invoking prompt contains the directive `UNATTENDED=true` (which the kickoff prompt injects — §2). Contents:
  - Follow steps 1, 1a, 2, 3 as written, but step 3's proposal is written to the reply for the session log, not for approval; **skip step 4 (CONFIRM) entirely** and proceed to step 5 EXECUTE immediately. Never skip step 4 outside unattended mode.
  - After EXECUTE: the **Miscellaneous sweep**. Every in-scope plan that ended up standalone (including the PROPOSE step's "Standalone" section) is assigned to a feature named `Miscellaneous`:
    - Search the in-scope column snapshots for an existing line `— Miscellaneous <!-- planId:<id> feature ... -->` whose project scope matches the active filter. If found, run `node .agents/skills/kanban_operations/assign-to-feature.js "<featurePlanId>" '["id1","id2",...]' "{{WORKSPACE_ROOT}}"`.
    - If not found (or assignment fails with the locked-column error), run `node .agents/skills/kanban_operations/create-feature.js "Miscellaneous" '["id1","id2",...]' "{{WORKSPACE_ROOT}}" "Catch-all feature for standalone plans swept during orchestration kickoff."`
    - Zero leftovers → skip the sweep entirely (the `/kanban/feature` route rejects empty `planIds`, `LocalApiServer.ts:397-400` — do not attempt a blank `Miscellaneous`).
  - Repeat the EXECUTE shell-safety rules (`:96-98`) verbatim in this section: escape `"` in goal text; avoid `$`, backticks, backslashes.
  - Skip step 6 (BACKLOG) in unattended mode — BACKLOG stays human-curated.
- Amend the `:127` note to read that the confirm gate is load-bearing **in interactive mode**; unattended mode's authorization comes from the user pressing Start orchestrator.

**Edge Cases.**
- **Empty / already-grouped board:** nothing loose → no features created, `Miscellaneous` not created; kickoff is a clean no-op that still leaves the mode armed for the wake loop (subtask 5).
- **Plans already in a feature or a subtask** are skipped by the grouping scan (respect the `feature` / `subtask-of:` tags, `:34-36`).
- **`Miscellaneous` naming collision across runs** → reuse, don't duplicate. If the existing one is unassignable (locked column per `feature_lock_columns`), creating a second `Miscellaneous` is acceptable — feature files embed the planId in the filename (`KanbanProvider.ts:10651-10655`) so there is no file collision; only the display name repeats.
- **`__unassigned__` filter:** the sweep must respect it — only untagged plans are candidates, matching `:44-53`.

### 2. `src/services/KanbanProvider.ts` — kickoff prompt assembly + provisioning verification (no new provisioning code)

**Context.** Subtask 1's `startOrchestrator` handler launches the orchestrator terminal with the persona workflow. The Suggest Features board button already assembles a skill-based prompt with placeholder injection: `_buildSuggestFeaturesPrompt(workspaceRoot, projectFilter)` reads the skill file, strips frontmatter, and substitutes `{{WORKSPACE_ROOT}}` / `{{ACTIVE_PROJECT_FILTER}}` (`:10944-10984`). Feature creation stamps the project from subtasks or falls back to DB config `kanban.activeProjectFilter` and resolves `project_id` (`:10608-10618`) — agent-created features land on the open project board with no extra work.

**Logic.** With `feature_worktree_mode` set to `per-subtask` by the mode coupling (subtask 1), each feature created during kickoff **already** gets its integration worktree + per-subtask worktrees and their terminals via the existing creation path — confirmed for the programmatic path, not just UI creation: `createFeatureFromPlanIds` `:10717-10727` (integration / high-low tiers) and `:10736` (per-subtask, inside the link loop), `assignPlansToFeature` `:10801`/`:10811`. **The draft's "wire it if the programmatic path doesn't already provision worktrees" contingency is resolved: no wiring is needed.** What kickoff adds here is only the prompt plumbing.

**Implementation.**
- Extend the Start-orchestrator launch (handler from subtask 1) to compose the kickoff segment of the orchestrator's first prompt:
  - Read `kanban.activeProjectFilter` from the workspace DB config **once** and inject it, plus the workspace root, using the same substitution mechanics as `_buildSuggestFeaturesPrompt` (`:10979-10983`). Refactor that method minimally so both callers share the read-skill-and-substitute core (add an options arg rather than duplicating the file read/fallback logic, including the legacy `.agent/` fallback at `:10950-10952`).
  - Prepend the directive line `UNATTENDED=true` so the skill's unattended section (§1) activates.
  - Append the fan-out instruction: after grouping completes, for each created/updated feature call `POST /kanban/orchestration/dispatch` (§3) with the feature's planId (`create-feature.js` prints `featurePlanId` on success — `create-feature.js:125`), one call per feature, then report "kickoff complete, sleeping" and stop. The orchestrator does not poll; the system wakes it later (subtask 5).
- No changes to `_ensureFeatureIntegrationWorktree` / `_provisionSubtaskWorktreeIfNeeded` / `_createSafetyWorktree` (`:10004`) — reused as-is. The orchestrator is never instructed to run raw `git worktree add` (DB-backed Worktrees tab has no reconciliation; raw worktrees are invisible orphans).

**Edge Cases.**
- Extension unreachable is impossible in this flow (Start is an extension action), but the verb scripts still carry their own "extension not reachable" failure text (`create-feature.js:132-137`) — acceptable defense in depth.
- Worktree creation failure inside `createFeatureFromPlanIds` is logged-and-continued by the existing code (`:9760-9765`, `:9892-9894`); the fan-out's missing-terminal skip (§3) is the backstop that prevents dispatch into nowhere.
- Blank feature (all planIds stale) → `createFeatureFromPlanIds` warns and creates it anyway (`:10597-10598`); it simply has nothing to fan out.

### 3. `src/services/TaskViewerProvider.ts` + `src/services/LocalApiServer.ts` — worktree-aware fan-out route

**Context.** This is the dispatch path kickoff relies on, named precisely: **`handleKanbanBatchTrigger` (`TaskViewerProvider.ts:3722`) fed by `_resolveKanbanDispatchPlans` (`:3298-3312`), which delegates to the consolidated `KanbanProvider.buildDispatchPlans` (`KanbanProvider.ts:3633`)** — the single builder that expands feature subtasks (`expandFeatureSubtaskPlans` call at `:3671`) and resolves each record's worktree (`:3648`, `_resolveWorktreeForRecord` `:3720-3762`, per-subtask dedicated worktree taking precedence over the shared feature worktree per the precedence doc at `:3551-3554`). The historical "5 duplicated dispatch-array builders dropping feature handling per-path" problem is closed — every call site now routes through this builder (enforcement comments at `TaskViewerProvider.ts:3302-3303`, `:14664`, `:16787`; `KanbanProvider.ts:3532`, `:4175`). The prompt's working directory becomes the worktree via `resolveWorkingDirForWorktree` (`agentPromptBuilder.ts:93-109`).

**Logic.** The orchestrator advances each feature's subtasks into the coding stage through board operations, letting the established dispatch machinery send the coder into the worktree terminal — i.e. the orchestrator drives the board the way a human does, rather than inventing a separate dispatch path. **Corrected mechanics:** the "established per-column dispatch" fires *from* PLAN REVIEWED and itself moves cards to the role's coded column (`:2278-2298`, `:3769-3786`); and its autoban-tick entry selects terminals by pool rotation, not worktree (`:6873-6908`, override at `:8890-8896`). So kickoff gets one new, small board op that reuses the batch-trigger internals with worktree routing intact. After dispatching the batch, the orchestrator **stops and sleeps** — it does not poll. The system wakes it later (subtask 5).

**Implementation.**
- **New route** `POST /kanban/orchestration/dispatch` in `LocalApiServer.ts`: register in the dispatch table beside `/kanban/feature/split` (`:1354`); handler follows `_handleKanbanMove`'s shape (`:322-361`) — `_checkAuth(req, true)` (localhost trust, `:219-222`), body `{ workspaceRoot?: string, featurePlanId: string }`, 503 when the callback option is unwired, 400 on missing `featurePlanId`. New optional `orchestrationDispatch` callback on `LocalApiServerOptions`, wired in `TaskViewerProvider`'s server construction next to `moveCard` (`:1020-1066`).
- **New method** `TaskViewerProvider.orchestrationFanOutFeature(workspaceRoot, featurePlanId)`:
  1. Guard: `this._autobanState.automationMode === 'orchestration'`, else return `{ success: false, error: 'Not in orchestration mode' }` (no dialogs — API error only).
  2. Load subtasks via `db.getSubtasksByFeatureId(featurePlanId)`; filter `status === 'active' && kanbanColumn === 'PLAN REVIEWED'`. Dispatching from the subtask list (not a column sweep) structurally excludes the feature card and prevents the feature+subtask double-dispatch (`getBoard` returns both, `KanbanDatabase.ts:2753-2762`). **CREATED subtasks are not dispatched** — planning stays human-in-the-loop per the feature's scope discipline; they wait for the wake loop after a human reviews them.
  3. Skip subtasks already locked in `_activeDispatchSessions` (same lock discipline as the tick, `:8889`); release settled locks via `_releaseSettledDispatchLocks` first.
  4. Respect the global session cap via `_getAutobanRemainingSessionCapacity()` (default cap 200, `autobanState.ts:15`) and a per-call concurrency budget: dispatch at most `orchestrationConfig.maxConcurrentSubtasks` (new field on subtask 1's `OrchestrationConfig`; default 5, aligned with `MAX_AUTOBAN_TERMINALS_PER_ROLE`, `autobanState.ts:16`) minus currently in-flight orchestration dispatches. **The remainder stays in PLAN REVIEWED and queues for later wake ticks** — this is the documented answer to "how many run at once and how the rest queue."
  5. For each selected subtask: route the role by complexity exactly as the tick does (reuse `_autobanRoutePlanReviewedCard` + the complexity read used at `:8920-8941`); resolve its worktree via `buildDispatchPlans` output; resolve the terminal with `_findTerminalNameByWorktreePathAndRole(worktreePath, role)` (`:6551-6582`, non-strict so any same-worktree terminal can serve). **If no worktree terminal resolves, skip the subtask and append a skip line to the orchestrator session log — never fall back to a main-checkout pool terminal** (parallel agents colliding on the main tree is worse than a delayed subtask; `_resolveAgentTerminalForPlan`'s `_getAgentNameForRole` fallback at `:6548` must not be reached, which is why the fan-out resolves the terminal itself and passes it as `targetTerminalOverride`).
  6. Dispatch each subtask via `handleKanbanBatchTrigger(role, [sessionId], 'orchestration-kickoff', workspaceRoot, resolvedWorktreeTerminal)` — in per-subtask mode each subtask has its own worktree, so batches are singletons and the batch path's "all same worktree" invariant (`:3743-3745`) holds trivially. The trigger performs the pre-dispatch column move, dispatch identity recording, and board refresh (`:3769-3796`) unchanged.
  7. Return `{ success, dispatched: string[], skipped: Array<{ planId, reason }> }` so the orchestrator can log the fan-out outcome before sleeping.
- Confirmed: the coding-column machinery delivers the agent into the correct per-feature (per-subtask) worktree terminal via this path — `buildDispatchPlans` worktree precedence (`KanbanProvider.ts:3551-3554`) plus `_findTerminalNameByWorktreePathAndRole`, with the prompt's working dir set to the worktree (`agentPromptBuilder.ts:93-109`).

**Edge Cases.**
- **Concurrency ceiling.** Fanning out N features × their subtasks respects `MAX_AUTOBAN_TERMINALS_PER_ROLE` (per-worktree per-role terminal cap, `TaskViewerProvider.ts:7714`), the `maxConcurrentSubtasks` budget, and the global session cap — no unbounded terminal spawning. Pool-slice overflow (`_limitAutobanPool`, `:6626-6632`) is cosmetic for fan-out since selection is worktree-keyed, not pool-keyed.
- Feature has zero PLAN REVIEWED subtasks → `{ success: true, dispatched: [] }`; not an error (all-CREATED features are legitimate).
- A subtask dispatched here that later fails mid-flight is subtask 5's triage concern; kickoff's contract ends at "prompt delivered, card in coded column".
- Duplicate route calls for the same feature are idempotent-ish: already-dispatched subtasks are lock-skipped, already-moved cards no longer match the PLAN REVIEWED filter.

### 4. `src/services/TaskViewerProvider.ts` — engine gating for orchestration mode

**Context.** `_startAutobanEngine` (`:8740-8788`) registers a per-column interval timer for every enabled rule, fires an **immediate tick per column** (`:8754-8755`), and subscribes watch-arrival to `db.onColumnChanged` (`:8767-8770`). In orchestration mode the interval tick's job is to *wake the orchestrator* (subtask 5), not to run column dispatch.

**Logic.** Prevent the Start-time race (immediate PLAN REVIEWED tick dispatching loose plans before grouping) and keep column automation out of orchestration mode entirely.

**Implementation.** In `_startAutobanEngine`, when `this._autobanState.automationMode === 'orchestration'`, skip registering the per-column timers, the immediate ticks, and the watch subscription (mirror the existing single-column special case at `:8747-8750`, which already establishes the mode-conditional pattern). The orchestration wake timer itself is subtask 5's deliverable; kickoff only guarantees no column dispatch fires in this mode.

**Edge Cases.** Switching modes while the engine runs already funnels through `_stopAutobanEngine` → `_startAutobanEngine`, so the gate applies on every mode change; the empty-column auto-stop sweep (`:8777-8784`) must also be skipped in orchestration mode (an empty PLAN REVIEWED column mid-batch is normal, not a stop condition).

## Verification Plan

Manual/behavioral only — per session directive, no compilation runs and no automated test suites are executed as part of this plan's verification.

1. **Grouping + sweep.** Seed a board with ~8 loose plans across CREATED and PLAN REVIEWED (some tagged `project:"Switchboard"`, some untagged), plus one plan already inside a feature. Select Orchestration, press Start. Verify: coherent features are created plus a `Miscellaneous` feature covering the leftovers; no in-scope plan is left ungrouped; the already-grouped plan is untouched; every new feature carries the active project stamp (visible on the project-filtered board). Re-run kickoff with new loose plans → the existing `Miscellaneous` is reused, not duplicated.
2. **Worktree provisioning (programmatic path).** After grouping, open the Worktrees tab: each feature shows one integration worktree plus one worktree per subtask, all as DB rows (no orphans); terminals exist for each enabled agent role per worktree. Confirm no raw `git worktree add` appears in the orchestrator terminal's transcript.
3. **Fan-out.** Verify each PLAN REVIEWED subtask is dispatched into *its own* worktree terminal (prompt visible in that terminal, working directory = the worktree), its card moves to the dispatching role's coded column, and complexity routing sends low-complexity plans to intern/coder and high to lead per the configured routing mode. CREATED subtasks remain in CREATED. The orchestrator then reports sleeping.
4. **Concurrency cap.** With more eligible subtasks than `maxConcurrentSubtasks`, verify only the cap is dispatched and the rest remain in PLAN REVIEWED (queued for the wake loop).
5. **Missing-terminal skip.** Kill one subtask's worktree terminal before fan-out; verify that subtask is skipped with a session-log entry and is *not* dispatched into a main-checkout terminal.
6. **Start-time race.** With loose plans in PLAN REVIEWED and orchestration mode selected, press Start and confirm nothing is dispatched before grouping completes (no immediate-tick dispatch).
7. **Empty board.** Start with nothing loose → clean no-op: no features, no `Miscellaneous`, no dispatches; mode remains armed.
8. **Other modes unaffected.** Switch to single-column mode and confirm the classic tick/watch dispatch still fires normally (gating is orchestration-only).

### Automated Tests (deferred per session directive)

Would cover: `normalize`/round-trip of the new `maxConcurrentSubtasks` config field; `orchestrationFanOutFeature` unit behavior (feature-card exclusion, PLAN REVIEWED filter, cap arithmetic, lock skip, missing-terminal skip); `_startAutobanEngine` gating matrix across the four modes; and the sweep's reuse-vs-create branch against a mocked `/kanban/feature/assign` locked-column failure. Deferred — not run as part of this plan.

## Out of scope

- Wake, progress verification, triage, and merge-back (subtask 5). Kickoff ends at "dispatched and sleeping."

## Research Findings Applied (2026-07-07)

External-mechanism research (run per the review's advisory) reinforced two points in this plan:

- **The shell-escaping requirement is load-bearing, not hygiene.** Injecting plan-derived text into a pty/shell stream is a recognized attack class (CVE-2025-54795 — command injection via whitelisted-command string escapes against a terminal-hosted agent). The unattended skill section's restated escaping rules and the sanitization of any plan-title/description interpolation are mandatory.
- **Prompt delivery is a solved problem — reuse it.** The research's raw-`sendText` multiline/truncation hazard does not apply: the extension delivers all prompts via `sendRobustText` (`terminalUtils.ts:118` — clipboard-paste for payloads >100 chars, chunked send with CLI newline-flattening as fallback), which is what the dispatch path this plan reuses already calls (`TaskViewerProvider.ts:16588`). Kickoff dispatch must go through that existing path; no new delivery code and no prompt-format constraints.

## Uncertain Assumptions

The user was advised to run a verification/research pass on these before implementation:

1. **Subtask 1's landed interface.** The `startOrchestrator` handler shape, the exact `OrchestrationConfig` fields (this plan adds `maxConcurrentSubtasks` to it), and the coupling writing `feature_worktree_mode='per-subtask'` are specified in the sibling plan but not yet in code — anchors in §2/§3 must be re-checked against the merged foundation.
2. **`_updateKanbanColumnForSession` internals** (used by the pre-dispatch move at `TaskViewerProvider.ts:3775`) were verified only at the call-site level, not audited end-to-end for subtask-row moves triggered with a terminal override in play.
3. **Prompt ergonomics in-worktree.** Whether `generateUnifiedPrompt`'s worktree directive reads correctly when the receiving terminal's cwd already *is* the worktree (directive says "you're in a worktree at <path>" — believed correct per the one-line-directive convention, but this exact combination is untested).

Recommendation: Send to Lead Coder

**Stage Complete:** PLAN REVIEWED

## Review Findings

Reviewed against commit `fcd9846`. Files changed by this review: `src/services/TaskViewerProvider.ts` (`_orchestrationDispatchFeature`). **CRITICAL (fixed):** fan-out resolved terminals via `_resolveAgentTerminalForPlan`, which falls back to `_getAgentNameForRole` (a main-checkout pool terminal) when no worktree terminal exists — directly violating §3's "never fall back to the main checkout" rule and risking parallel agents colliding on the main tree; replaced with a direct `_findTerminalNameByWorktreePathAndRole` + skip-on-null (also skips when the subtask has no worktree row). **MAJOR (fixed):** role routing was a hardcoded `complexity>=7?lead:coder`, ignoring `routingMode` and the configured intern/coder/lead thresholds; now uses `_autobanRoutePlanReviewedCard(...)` exactly as the tick does. The grouping SKILL.md unattended section, `Miscellaneous` sweep, PLAN-REVIEWED-only filter, concurrency cap, and worktree provisioning reuse all match the plan. Validation: static/caller-trace only (compile+tests skipped). Remaining risks (deferred, MINOR): the fan-out does not check the global session cap (`_getAutobanRemainingSessionCapacity`), does not use the `_activeDispatchSessions` lock (duplicate-call idempotency leans on `handleKanbanBatchTrigger` moving the card out of PLAN REVIEWED first), and has no `automationMode==='orchestration'` guard.

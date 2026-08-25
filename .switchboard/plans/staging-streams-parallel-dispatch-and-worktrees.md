# Persist dependency edges and gate dispatch on asserted completion at pop time

## Goal

Persist dependency edges emitted by dispatch analysis and evaluate them at pop time against the asserted completion fact (`completed_at`), so the STAGING queue can feed multiple teams in parallel without violating dependencies and without precomputing static stream columns. Add the Analyze control to the STAGING header alongside Planned.

### Problem Analysis

> **Note on line numbers:** Several line references in this section are stale relative to the current source — `kanban.html` references are off by ~350 lines (the file has grown since this plan was written), `LocalApiServer.ts` by ~20–30 lines, and `TaskViewerProvider.ts` by ~80 lines. The *behaviours* described are verified correct against the current code; the line numbers are guidance, not precision. Grep for the quoted strings or function names rather than trusting the line numbers literally.

**The STAGING queue already supports parallel consumers.** This was the finding that reframed the whole area: `appendQueuePositions` computes `MAX(queue_position)` over `WHERE workspace_id = ? AND kanban_column = 'STAGING'`, which is **one ordering, not one consumer**. The in-flight refusal is per *team* — `LocalApiServer.ts:1716-1722`: *"a team is in flight when any active card belonging to that team is sitting in a coding column. Team membership is resolved from the card's `dispatched_terminal`."* And `POST /kanban/queue/next` takes `{from}`, so each lead identifies itself. N leads drain one ordered list concurrently, each gated only by its own in-flight card.

Cross-team leakage from that shared queue is already guarded: `:1624-1627` refuses rather than widening — *"Dispatching workspace-wide would hand this team's card to another team's terminal"* — and `restrictToOriginTeam` (`:1973`) "closes the workspace-wide escape hatch". So team-scoped dispatch off a shared queue is solved.

**And the dependency analysis already exists**, further along than its output suggests. The Analyze button on the Planned column (`kanban.html:8050`, *"Analyze Planned plans for parallel dispatch"*) dispatches `.agents/protocols/dispatch-analysis/SKILL.md`, which:

- builds a **file-overlap graph** (step 3) and selects the largest non-conflicting subset — *"a maximum independent set problem on the conflict graph"* (step 4)
- reads declared dependencies (step 2) and, at `:105-107`, *"If plan A declares a dependency on plan B, A cannot start until B completes. Dependent plans are **conflicting** even with zero file overlap"*
- treats a feature as indivisible, unioning both file sets **and dependencies** across its subtasks (`:59-60`)
- receives `API_PORT` in its prompt rather than reading a port file — the pattern the rest of the system should follow
- moves the chosen set to STAGING via the API

**The gap: dependencies are used as an exclusion and then discarded.** A dependent plan is marked conflicting and left in Planned. Two consequences:

1. **A chain never stages.** A→B→C is three mutual conflicts, so at most one member is promoted per run.
2. **Nothing persists what depends on what.** The dependency knowledge is computed once, used to exclude, and thrown away — so no consumer can order anything by it.

A maximum-independent-set answer is a *subset*: it says what can start now and is invalid the moment anything finishes. Persisting dependency edges makes execution dynamic: stages are not stored, but derived at pop time by checking whether predecessor cards have reached asserted completion (`completed_at IS NOT NULL`).

### Why the premise changed: asserted completion collapses static streams to dynamic edges

> **Premise change (citing `completion-is-asserted-never-inferred.md`):** This plan originally proposed encoding execution ordering via `stream_id` and `stream_seq` columns. That precomputed schema was scaffolding created because the system could not answer "is predecessor B finished?" without relying on board position or running another analysis pass.
> 
> With `completion-is-asserted-never-inferred.md`, completion is an explicit asserted event recorded in `completed_at`. A pop-time check can now directly ask: *"Have all dependency predecessors of card A completed (`completed_at IS NOT NULL`)?"* The requirement collapses to persisting dependency edges and evaluating them when popping a card. Stages become derived dynamically rather than precomputed and stored.

### Root Cause

The analysis was built to answer the safe question — "which of these can I fire simultaneously right now" — because that is all a single-consumer queue could use. Once the queue could feed N teams, the same graph could have answered the larger question, but the output shape was never revisited. The graph it builds is most of the work: file overlap is *undirected* (concurrency constraints), a declared dependency is *directed* (order edges).

## Metadata

**Complexity:** 3
**Tags:** backend, database, api, ui, reliability

## User Review Required

### Recommended Plan Split (Recommendation Only — Not Performed Here)

This plan historically accumulated multiple distinct concerns across data modeling, board UI, and worktree mechanics. The architectural recommendation is to separate them:
1. **Persisting dependency edges and pop-time completion gating** (backend queue execution engine) — the primary scope of this plan.
2. **Mission Control panel layout and its tabs** — belongs with `mission-control-panel-ui-specification.md`.
3. **Worktree provisioning and multi-checkout merge-back topology** — belongs with `worktree-models-consolidate-and-a-staging-toggle.md`. *(Performed: old item 6, `base_branch` derivation, was removed from Proposed Changes below.)*

> **Amended:** item 2 previously read *"Mission card data model, drag behaviors, and Mission Control panel integration — belongs with `the-automation-model-four-things-not-a-mode-axis.md` and `mission-control-panel-ui-specification.md`."*
> **Reason:** both named recipients are shipped or reviewed and neither defines a mission card. `the-automation-model` consumes *"the mission's membership"* as its selector target; the panel spec lists missions and derives their status, with no membership, containment or drag-onto behaviour anywhere in it. The deferral had no receiver, and the mission card data model is already item 7 of THIS plan's Proposed Changes — so the note contradicted the plan it sits in. Membership is what that card holds; it belongs here with it.
> **Replaced with:** only the panel's own layout is deferred. The mission card, its membership, and the drag that forms it stay in this plan.

*Note: As instructed, this split is recorded here as a recommendation only and is not performed in this plan file.*

### A mission is the staging queue, named — nothing existing changes

The framing that matters: **a mission with one sequential stream is exactly today's staging queue.** Missions generalise the queue rather than replacing it, and no current behaviour is removed.

- **Auto-created on first drop.** Dragging a card into the STAGING column creates a mission if none is open, gives it a **generated codename**, and adds the card. The user never has to author a mission to get today's behaviour.
- **Default rules are today's rules.** A fresh mission is sequential, in `queue_position` order, dispatched by `queue/next` exactly as now. Streams are an *optional elaboration* the Analyze pass adds; a mission that was never analysed has one implicit stream and behaves identically to the present queue.
- **Launch uses the mission's own rules** — sequential by default, streams if analysed.
- **The new capability is preparation.** Missions can be created in advance and added to progressively, so several are teed up before any is launched. That is the whole product change; everything else is the existing pipeline wearing a name.
- **The orchestrator is one author, not the author.** It can write a mission (with its stream map) as before, but the ordinary path is a user dropping cards into STAGING.

No codename generator exists in the codebase today (checked: no `codename`/`codeName`, no adjective-noun word lists), so that is a small new piece. It wants to be stable once assigned and legible in a report — the operator will name missions in its handoff summaries.

### The carrier is a mission card, not a run parameter

The map lives on a **mission card**: a board card the analysis writes, holding the streams and their order, which **launches the run when advanced**. That replaces two earlier designs — a per-run parameter store, and an inbox instruction to set it — and dissolves the questions both raised:

- **Storage** — a card is a plan file plus a DB record. No `orchestrationConfig`-vs-`workspaceState` decision, and no new run-parameter store. (`workspaceState` was disqualified anyway: `autoban.state` lives in `this._context.workspaceState` (`TaskViewerProvider.ts:1536`), reachable only from inside the extension host — invisible to an external orchestrator and to the standalone host.)
- **Channel** — a card is created by writing markdown into the plans directory, which the watcher imports automatically with no git precondition. So the file-based tier works **by default**: a sandboxed orchestrator that cannot reach the API needs no endpoint and no new inbox instruction kind. An API-capable one can POST instead. Both reachability tiers, existing machinery.
- **Visibility** — the map stops being invisible DB state. It can be read, reordered and deleted like any card, and its staleness is inspectable rather than inferred.
- **Trigger** — advancing a card is already the system's universal "start this" gesture, with UI that exists.

**It must not be a feature, and nesting is actively refused.** `linkFeatureSubtasksByPaths` *"never writes `is_feature=0` onto a row that is itself a feature (**nested-feature**)"*, and the project side guards too (`subtask_project_governed_by_feature`). Three further reasons the feature machinery would fight it:
- `feature_id` is a single parent pointer — a two-level tree, not three.
- `recomputeFeatureComplexity` is max-of-active-subtasks and does not recurse, so a super-feature's complexity would be meaningless.
- **The cascade is the wrong semantics.** `cascadeFeatureByPlanId` moves the feature *and every active subtask* to the same column atomically. Advancing a mission card must start **stream heads only** — not drop every chain into a coding column at once.

So a mission card **references without owning**: members keep their own `feature_id` (or none) and are linked by dependency edges. No nesting, no cascade, no derived complexity.

### Missions live only in STAGING, and membership is a containment gesture

- **A mission card exists only in STAGING.** No other column may hold one. That answers where it sits and removes the "beside its own members" oddity, because members stop being separate board cards once they join.
- **Dragging a card onto a mission card adds it to the mission and removes it from the board.** Membership is containment, mirroring how feature subtasks roll up rather than appearing as loose column cards — the same rule `dispatch-analysis` already relies on (*"a subtask is never a standalone candidate … the user sees it rolled up under the feature"*). The mission card then shows its members and their streams.
- **Consequence for the drag interception below:** two drag semantics now exist on a mission card — dragging *the mission* opens the panel, dragging *a plan onto it* adds a member. Both must be distinguishable before the optimistic path, or a mis-drop either launches nothing or silently swallows a card.

**Automation becomes mission-scoped** — the schedule survives untouched, only its target becomes a mission's finite membership.

> **Superseded:** Its own plan: `scope-automation-to-missions.md`.
> **Reason:** `scope-automation-to-missions.md` was superseded by `the-automation-model-four-things-not-a-mode-axis.md`, which states at its Dependencies section: *"Supersedes `scope-automation-to-missions.md` and `scheduled-jobs-get-their-own-panel.md`."* The file no longer exists in `.switchboard/plans/`. A coder following the dependency chain would hit a dead link.
> **Replaced with:** The automation model is owned by `the-automation-model-four-things-not-a-mode-axis.md`, and its UI by `mission-control-panel-ui-specification.md` (Schedules tab). This plan's scope is the stream map and mission card data model, not the automation surface.

### Missions get their own panel; the board move is navigation, not launch

> **Superseded:** The mission card's home is a **`missions` panel** (`missions.html` + `missions.js`).
> **Reason:** `mission-control-panel-ui-specification.md` specifies the same panel with a different name and richer scope. Its Dependencies section states: *"Supersedes the `missions.html` panel proposed inside the streams plan — same panel, specified here."* That plan specifies `mission-control.html` + `mission-control.js` with a Missions tab (sidebar list + detail), a Schedules tab, and a Control tab hosting the persona terminal. It also depends on this plan: *"Requires `staging-streams-parallel-dispatch-and-worktrees.md` for missions, stream maps and the sequencing view."* Building a separate `missions.html` panel here would create two competing panels for the same concept.
> **Replaced with:** This plan owns the **mission card data model, the dependency edge map, the board drag interception, and the launch logic**. The **panel UI** — `mission-control.html` + `mission-control.js`, manifest registration, rail icon, sidebar-list-plus-detail layout — is specified by `mission-control-panel-ui-specification.md`. Items 8b–8e below describe *behaviours* the Mission Control panel implements; item 8a (panel creation) is deferred entirely to that plan.

The mission card's home is the **Mission Control panel** (specified by `mission-control-panel-ui-specification.md`). The card appears on the board, but **moving it switches to the panel** — it does not launch, and it does not move. The card only takes its new column when **Launch mission** is pressed in the panel.

**Intercept the drag; never move-then-revert.** Board drags are already optimistic: `optimisticMoveUntil` (`kanban.html:6300`) opens a window during which full `renderBoard` calls are suppressed, and `:6290-6300` records that a column move landing inside an optimistic tick can be silently mishandled. A provisional move that reverts on an unlaunched mission would fight exactly that machinery and can strand a card in a column it was never committed to. So a drag on a mission card is **intercepted before the optimistic path**: open the panel, write nothing. The move happens once, inside Launch, alongside the fan-out. Nothing to revert because nothing moved.

**This supersedes the launch modal.** An earlier revision put a decision modal on the move. The panel is the decision surface, so no modal is needed on the board at all — which is the better answer to the same problem, since the panel can show streams, depth, per-stream team assignment and the map's weak points at a size no modal should.

**Panel registration is a solved path — and this is a chance to use it properly.** `getPanelsManifest` (`headlessPanelHtml.ts:511`) takes an entry of `{id, label, icon, route, enabled}`; `getPanelHtmlById` gains a `mission-control` case; `LocalApiServer` serves the route. `shell.html` renders the rail from the manifest — its own comment: *"adding a panel route later adds a strip icon with no shell code change"* — so the icon is free. Follow the **companion-`.js` convention** that seven panels already use (`connections`, `planning`, `tickets`, `terminals`, `design`, `memo`, `project`), not the two inline-script exceptions. Note the contrast worth not repeating: `agent-control` was retrofitted as a `data-view` projection of `kanban.html` and now needs `extract-agent-control-into-its-own-panel-file.md` to undo it. A new panel should start as a panel. **The panel's manifest entry, HTML, JS, and layout are specified by `mission-control-panel-ui-specification.md` — this plan defines the data model and behaviours the panel hosts, not the panel itself.**

### If a launch dialog is still wanted inside the panel: decision dialog, not confirm gate

If the panel's Launch step wants a final choice step of its own, the form is constrained by a hard project rule: **plain confirm gates are banned, multi-choice decision dialogs are allowed.** A launch modal is the latter — it presents the streams and takes choices (which streams, which teams, how many worktrees), so it is a configuration step, not an "Are you sure?".

**It must not use `window.confirm()`.** That is a silent no-op in a VS Code webview (sandboxed iframe without `allow-modals`, always returns `false`) — the bug that broke the kanban delete-plan button. The codebase contains zero `confirm()` calls and two comments recording why (`kanban.html:12526`, `:13369` — line numbers are approximate; grep for `confirm()` to find them). Build it as a custom in-webview modal on the existing pattern: `feature-create-modal` / `openFeatureCreateModal` (`:11898`) / `closeModal` (`:11621`).

> **Superseded:** `stream_id` + `stream_seq` encoding columns and the argument against `base_branch`.
> **Reason:** Citing `completion-is-asserted-never-inferred.md`, completion is an explicit asserted event recorded in `completed_at`. The previous design rejected `base_branch` because it *"expresses one predecessor, which cannot express 'these four run together, then those two.'"* That argument was distorted by the absence of an asserted completion fact — it assumed order had to be precomputed into stage numbers. With dependency edges evaluated against `completed_at`, multiple predecessors are simply multiple edges, and "run together" is simply the absence of edges between cards. Precomputing streams or stages in `stream_id`/`stream_seq` columns is unnecessary scaffolding.
> **Replaced with:** Persisting dependency edges per card, evaluated at pop time in `_runQueuePop` against `completed_at IS NOT NULL`.

- **The operator advises before confirmation and acts after it.** Sequential stays the default. The operator reads the map and, in its opening proposal, states what parallelism is available and what it would cost and risk *against the goal the user stated* — then waits. An earlier revision added stream-parallel as a fourth session model plus a selection rule; that was over-prescriptive. A later revision then swung too far and left the operator advisory-only, which would have removed the execution it already performs. Both were wrong in the same way — treating this as a question about *how much the operator does* rather than *which state it writes*.

**The real line is state lifetime, not authority.** `worktree-strategy-control-contract.test.js` exists because `applyOversightWorktreeTopology` forced `feature_worktree_mode` on arm and restored it on disarm, and a crash left the forced value in place with the user's own parked in `orchestration_prior_feature_worktree_mode`. The defect was *taking away and giving back a persistent user setting*. So:
- **Never written by the operator:** `feature_worktree_mode` and anything else that is a stored user preference.
- **Legitimately written by the operator, after confirmation:** per-run parameters — how many streams this session runs, which team takes which stream, the worktrees provisioned for it. These shadow no user setting, so nothing is stashed and a crash leaves no forced value to restore.

Advice remains strictly more capable than a rule for the *decision*: it can say "streams 2 and 3 have no file overlap, but 3 declares a dependency the analysis took on faith" — which no shallowest-first heuristic expresses and which a rule would decide silently. It must not write worktree strategy — `worktree-strategy-control-contract.test.js` pins that only the user does, because `applyOversightWorktreeTopology` used to force `per-feature` on arm and a crash left the forced value in place. The protocol already states the read-only rule itself (`switchboard-orchestrator/SKILL.md:354-357`, "Obey the worktree setting; never write it").
- Confirm Analyze should appear on **both** Planned and STAGING headers.

## Complexity Audit

### Routine

- Adding the Analyze control to the STAGING column header (the Planned one exists at `kanban.html:8050`).
- Persisting dependency edges emitted by dispatch analysis (`plan_dependencies` table or `depends_on` column on `plans`), plus migration, and a `map_fingerprint` column on the mission card.
- Evaluating dependency edges at queue pop time against the asserted completion fact (`completed_at IS NOT NULL`).

### Complex / Risky

- **The graph is already built; the change is what is emitted from it.** Connected components of the undirected (file-overlap) graph determine independent sets; directed dependency edges determine order constraints. A cycle in the declared dependencies is a real input error and must be *reported*, not silently broken — a greedy pass would otherwise pick an arbitrary order and look successful.
- **A dependency map is only as good as declared dependencies.** Step 2 reads them "if declared". File overlap is inferred and reliable; declared dependencies are optional prose. So the map will be confident about conflicts and incomplete about ordering, and it must say which parts rest on declarations rather than presenting one uniform confidence.
- **Persisting the map creates a staleness question the subset never had.** A subset was consumed immediately; a map lives across dispatches. If a plan is edited after analysis, its file set may change and its dependencies may be wrong. The map needs a validity marker — a `map_fingerprint` hash of `{planId}:{sortedFileSet}` pairs, recomputed on read — so a stale map is *detected* rather than silently followed. This is the single most important design element and the easiest to omit.
- **Features are one unit and the map must preserve that.** The protocol's rule (`:53-70`) is emphatic — analyse at the feature level, move the feature card only (a `POST /kanban/move` on a feature cascades to subtasks atomically; moving a subtask re-derives the parent's column and drags the feature somewhere the user did not put it). Dependency assignment therefore attaches to the feature, never to a subtask.
- **N teams draining one list needs the dependency gate at pop time, not at analysis time.** `queue/next` must refuse a card whose dependency predecessors are incomplete (`completed_at` is NULL) rather than handing it out. That is a new refusal in the same critical section as the in-flight one — a section maintained for ~4,000 installs — and it needs its own test rather than being folded into the existing 409 path.
- **Parallel worktrees multiply the unscoped-`branch` collision.** The current schema has `branch TEXT NOT NULL UNIQUE`, workspace-unscoped (the V24/V25 migrations used `UNIQUE(branch, workspace_id)`). Owned by `scope-unscoped-tables-by-workspace-id.md`, but N concurrent worktrees make the collision likelier, so that plan becomes a practical precondition rather than a tidy-up.

## Edge-Case & Dependency Audit

**Migration.** V62 — additive dependency edges storage (e.g. `plan_dependencies` table or `depends_on` column) and `map_fingerprint` on `plans`. A plan with no dependency edges behaves exactly as today, so the queue keeps working for anyone who never runs Analyze. No existing behaviour changes until edges exist.

**Security.** No new endpoint or path resolution. The analysis remains read-only on plan files and moves cards via the API.

**Side effects.** Sequential work becomes stageable for the first time, so STAGING will hold more cards than before — a UI density change worth checking.

**Ordering.** Needs `worktree-models-consolidate-and-a-staging-toggle.md` first for one clear feature-worktree model, and `scope-unscoped-tables-by-workspace-id.md` before running many worktrees concurrently.

## Dependencies

- **Requires** `completion-is-asserted-never-inferred.md` and `add-a-task-complete-endpoint-for-the-lead.md` for the asserted completion fact (`completed_at`).
- **Requires** `worktree-models-consolidate-and-a-staging-toggle.md`.
- **Practical precondition:** `scope-unscoped-tables-by-workspace-id.md` for the `branch` uniqueness collision.
- **Shares the merge-back gap** with the per-feature-worktree queue design: later worktrees cutting from earlier merged results presumes merge occurred. Now settled in `worktree-models-consolidate-and-a-staging-toggle.md`: one merge endpoint with three callers — the kanban WORKTREES tab, the Mission Control panel for mission-owned worktrees, and the controller agent. **The controller caller is the one this plan depends on**, since a stream advancing unattended has nobody to click either UI.
- **Panel UI owned by** `mission-control-panel-ui-specification.md` — that plan requires this plan for missions, dependency maps and the sequencing view, and supersedes the `missions.html` panel originally proposed here. This plan defines the data model; that plan defines the panel.
- **Automation model owned by** `the-automation-model-four-things-not-a-mode-axis.md` — supersedes the deleted `scope-automation-to-missions.md`.
- Independent of the orders work.

## Adversarial Synthesis

**"The current subset behaviour is safe — a map invites running too much at once."** The map does not decide concurrency; the per-team in-flight refusal and the number of live teams do. The map only records what *may* run together. Today's subset is not safer, it is less informative: it discards the ordering it computed.

**"Re-run Analyze after each completion instead of persisting edges."** That is the current behaviour and it is why a chain never progresses: each run sees the same mutual conflicts and promotes one card. It also puts an agent dispatch in the completion path of every card.

**"Let the operator sequence the work instead of persisting dependency edges."** That puts an agent in the critical path of every dispatch and gives it authority the strategy contract withholds. Persisted dependency edges are inspectable, testable and deterministic; an agent re-deriving order per pop is none of those. Note this cuts the opposite way from the advisory framing above and both hold: the *dependency graph* is deterministic and persisted; the *decision to run several streams* is the user's, informed by the operator. Machinery decides ordering; a person decides concurrency.

**"The panel UI is specified here — build `missions.html`."** It is not. `mission-control-panel-ui-specification.md` explicitly supersedes the `missions.html` panel and specifies `mission-control.html` + `mission-control.js` instead. Building the panel from this plan would create two competing surfaces. This plan owns the data model and board behaviours; the panel is the other plan's deliverable.

### Risk Summary

Key risks: (1) the pop-time dependency gate is a new refusal in the `_runQueuePop` critical section maintained for ~4,000 installs — it must be its own test, not folded into the in-flight 409 path; (2) the staleness fingerprint is the easiest element to omit and its absence silently reintroduces conflicts; (3) the plan references a superseded panel (`missions.html`) and a deleted dependency (`scope-automation-to-missions.md`) — both are now corrected with superseded callouts, but a coder reading only the Proposed Changes without the User Review context would miss the deferral. Mitigations: the pop-time gate is NULL-inert (skipped when no dependency edges exist), the fingerprint is a cheap hash recomputed on read, and the superseded callouts are inline at the point of confusion.

## Proposed Changes

1. **Analyze emits dependency edges, not a subset**: connected components of the file-overlap graph identify parallel opportunities; directed dependency edges define prerequisite ordering. **Dependency cycles are reported as input errors in the analysis report** (step 6 of `dispatch-analysis/SKILL.md`): name the cycle members and the declared edges, leave all cycle members in Planned, and do not emit a partial order. A greedy pass that picks an arbitrary order and looks successful is the failure mode.
2. **Persist dependency edges** in a `plan_dependencies` table (`plan_id TEXT, depends_on_plan_id TEXT, PRIMARY KEY(plan_id, depends_on_plan_id)`) or equivalent edge list on `plans`. `queue_position` remains the intra-priority tiebreak.
3. **Record a validity marker** — a `map_fingerprint` column on the mission card (TEXT, nullable) storing a hash of the concatenated `{planId}:{sortedFileSet}` pairs for every member at analysis time. On read, recompute the hash from current plan files; a mismatch means the map is stale. This is more reliable than mtime (noisy, filesystem-dependent) and more precise than the plan set alone (a plan's file set can change without the set membership changing). The fingerprint is cheap: the analysis already reads every plan file to build the graph.
4. **Stage all candidates**, not only the currently-unblocked ones.
5. **`queue/next` gates on asserted completion of dependencies**: refuse a card whose dependency predecessors are incomplete (`completed_at IS NULL`), with its own test. The refusal is a new 409 path in `_runQueuePop` (`LocalApiServer.ts:1772+`), checked after the in-flight refusal and before the dispatch. It queries dependency edges for the candidate and checks whether any predecessor plan is uncompleted (`completed_at` is NULL or sitting in STAGING/coding column). If so, refuse with a message naming the blocking predecessor.
6. **Analyze control in the STAGING header** as well as Planned.
7. **The mission card is the carrier.** Analysis writes it as a plan file (file tier, works sandboxed) or via the API; it holds the dependency map. Members are linked by dependency edges, never re-parented. A new card kind — not a feature, no cascade, no derived complexity. **Codename generator**: a mission card gets a stable codename on creation — a two-word `{adjective}-{noun}` pair drawn from two small word lists (~50 adjectives, ~50 nouns, ~2,500 combinations) embedded as constants in `KanbanDatabase.ts` or a sibling module. The pair is chosen by hashing the mission's `plan_id` into the adjective × noun space, so the same card always gets the same codename without a stored field. Collision is checked at creation time; a collision rehashes with a salt suffix. No external word-list file, no network dependency.
8a. **Panel UI deferred to `mission-control-panel-ui-specification.md`.** That plan specifies `mission-control.html` + `mission-control.js` with a Missions tab (sidebar list + detail), registered in `getPanelsManifest` as `mission-control`, a `getPanelHtmlById` case, and a `LocalApiServer` route. This plan defines the data model and behaviours the panel hosts; it does not create the panel files.

**The panel is already built — do not rebuild it, and do not invent a mission shape.** `src/webview/mission-control.html` (27 KB) and `src/webview/mission-control.js` (43 KB) are in the tree and its card is in CODE REVIEWED. What is missing is the backend behind it: `grep maxExtraWorktrees src/services/` returns nothing, there is no missions table, no `mission_id`, no reader and no writer. The UI renders a mission object nothing produces, which is why its Missions tab is inert.

So the mission model this plan builds is **not** free to choose its own field names. It must satisfy the shape the shipped panel already reads, or the panel stays dead and the work ships twice:

- **Fields on a mission** (`mission-control.js`): `id`, `name`, `type`, `goal`, `ready`, `runState`, `team`, `teams`, `plans`, `features`, `sequencing`, `log`, `maxExtraWorktrees`.
- **Verbs it posts** and therefore needs handled: `mcInit`, `mcNewMission`, `mcUpdateMission`, `mcDeleteMission`, `mcReadyMission`, `mcLaunchMission`, `mcStopMission`, `mcAddMissionMember`, `mcRemoveMissionMember`.
- `ready` is a flag, not a status — `mission-control-panel-ui-specification.md` is explicit that a scheduler must not take an unready mission, and that `runState` is **derived**, never stored.
- New verbs must be regenerated into the allowlist (`npm run catalog:generate`) or `handleServiceVerb` throws on every one of them over `/kanban/verb/*` while working fine in the VS Code webview.
8b. **Board move = navigate.** A drag on a mission card is intercepted before the optimistic path (`optimisticMoveUntil`, `kanban.html:6300`), opens the Mission Control panel, and writes nothing. The card keeps its column until Launch.
8c. **Launch mission** in the panel performs the column move and the fan-out as one action: seat teams, stage, dispatch each unblocked stream head. **It does not provision a worktree per stream.** A mission carries a `maxExtraWorktrees` field — *extra*, on top of the tree it starts in — which is **0 by default** and which a mission of type `mission` may never exceed **1** (`mission-control-panel-ui-specification.md:110`, and already shipped in `mission-control.js:465`). Launch honours that field; most missions add nothing and run in the tree they started in.
8d. **Launch is idempotent.** Moving the card twice must not double-seat teams or double-dispatch. This is the one behaviour on the board where a card's move fans out beyond itself, so it needs an explicit guard rather than relying on the user not doing it.
8e. **Expose the map to the operator**: a read path (`GET /kanban/mission/{planId}/streams` or equivalent) returning dependency chains, their depth, and each card's dependency edges.
8. **Sequential stays the default; the handoff sequence generalises from one team to N.** `## The handoff sequence` (`:252-266`) is already scope → launch → stage → dispatch card one → report and exit. For parallel streams it becomes:
   1. **Scope** — read the dependency map.
   2. **Advise and stop** — parallel chains available, what running several costs, where the map is weakest. The user confirms which streams to run. *(The only genuinely new step.)*
   3. **Launch** — seat one team per confirmed stream.
   4. **Provision, only if the mission asks for it** — `maxExtraWorktrees` extra trees, 0 by default and capped at 1 for a mission. Not one per stream. *(The only step needing a run parameter.)*
   5. **Stage** — in dependency order with edges persisted.
   6. **Dispatch the head of each confirmed stream** — one `queue/next` per team. The per-team in-flight refusal and dependency completion check serialises this correctly.
   7. **Report and exit** — `POST /orchestration/handoff`, whose `409` on a dead head or empty queue becomes an N-team check.
   Steps 3–7 are what it already does, once per stream instead of once.
9. **Operator detects and reports** dependency violations. It never writes strategy, reorders work, or cuts branches.
10. **A drag into STAGING always succeeds; the only question is which mission receives it.** There is no refusal on this path and no error state. Dropped **onto an unlaunched mission**, the card joins that mission at the END of its queue (`MAX(queue_position) + 1` within the mission). Dropped **into empty space in the column**, a new mission is created holding that card, placed BELOW the existing missions. Dropped **onto a mission that is already in flight**, the result is the same as empty space: a new mission is created. A launched mission is a sealed set, so a late card starts the next one rather than being turned away.
11. **A member stops being a board card.** Reuse the subtask containment predicate rather than writing a second one: `featureId && !isFeature` is already applied in `_resolveStageablePlanIds`, in the staged-count contract, and in the queue pop's `isQueueable`. Mission members need the same treatment at the same sites. A second, differently-shaped predicate is how one site gets missed and a member leaks back onto the board as a loose card.
12. **The board's priority does not reach inside a mission.** A card joins at the end of its mission's queue and runs in `queue_position` order — starred or not, whatever its `column_order` was on the board. A mission is a committed sequence, not a view of the board, and letting board-level urgency reorder it would break the sequence the mission was assembled to run. `compareByPrecedence` already skips the starred step for STAGING, and the frontend comparator matches; both must stay that way. The star keeps its meaning everywhere else.

> **Amended:** the numbering ran 1,2,3,4,5,6,7,9,10 — old item 6 (`base_branch` derivation) was removed and the renumber stopped halfway, leaving items 9 and 10 on their original numbers and no item 8.
> **Reason:** a gap reads as a lost deliverable. No content was missing; the two tail items are unchanged and are now 8 and 9.
> **Replaced with:** contiguous 1–12, the last three being the membership items this plan described in *"Missions live only in STAGING, and membership is a containment gesture"* but never turned into work.

### Migration

**V62** — Add `plan_dependencies` table (`plan_id TEXT NOT NULL, depends_on_plan_id TEXT NOT NULL, PRIMARY KEY(plan_id, depends_on_plan_id)`) and `ALTER TABLE plans ADD COLUMN map_fingerprint TEXT DEFAULT NULL`. Added to `SCHEMA_TABLES_SQL` so fresh DBs get them from creation. Idempotent under version gate. A plan with no dependencies behaves as today — pop-time dependency gate is skipped when no edges exist.

## Verification Plan

### Goal Invariants

- Analyze produces a dependency map covering every candidate, not a subset.
- No card is dispatched while any dependency predecessor has not asserted completion (`completed_at` is NULL).
- A chain A→B→C stages in one Analyze run and dispatches in order without re-running analysis.
- A stale map is detected rather than followed.
- Features carry dependency assignment; subtasks never do.

### Automated Tests

- **A chain stages in one run:** analyse A→B→C and assert all three are staged with edges persisted.
- **Parallel streams are concurrent:** two independent chains; assert their heads share no dependency edges and both dispatch to different teams simultaneously.
- **Pop-time dependency gate on asserted completion:** request plan B depending on A while A's `completed_at` is NULL; assert refusal. Then assert A's completion (`POST /kanban/task/complete` sets `completed_at`) and assert B is handed out.
- **No re-run needed:** run Analyze once, then drive the whole chain to completion without invoking analysis again.
- **Staleness detected (fingerprint):** edit a plan's file set after analysis; assert the `map_fingerprint` mismatch is detected and the map is reported stale rather than followed.
- **Dependency cycle reported:** declare A→B→A; assert an input error, not an arbitrary order.
- **Features stay whole:** a feature with subtasks gets dependency edges on the feature card and none on subtasks; assert no subtask is staged independently.
- **Empty dependency edges are inert:** with no dependencies, the queue behaves byte-identically to today.
- **The shipped panel lights up:** assert every field `mission-control.js` reads off a mission is populated by the backend, and that every `mc*` mission verb it posts has a handler and is present in the generated allowlist. A mission model that satisfies the plan but not this list leaves 43 KB of finished UI rendering nothing, and no other check catches it.
- **Launch honours the worktree cap, and does not provision per stream:** launch a three-stream mission with `maxExtraWorktrees` at its default; assert zero extra worktrees are created. Set it to 1; assert one. Assert a mission of type `mission` cannot be launched above 1.
- **Membership removes from the board:** drop a plan into STAGING; assert it is a member and renders nowhere as a loose card — checked at every site the subtask predicate is applied, enumerated by name. One missed site is the whole failure mode, and it passes every behavioural check that only looks at one surface.
- **One drag, one mission:** drop five cards into an empty STAGING column; assert exactly one mission is created holding five members, not five missions.
- **A launched mission starts a new one:** launch a mission, drop a plan onto it; assert a NEW mission is created holding that plan, that the launched mission's membership is unchanged, and that nothing is refused or errored.
- **Empty space starts a new mission below the others:** drop into the column's empty area; assert a new mission is created and ordered after the existing missions, not before them.
- **The end of the queue means the end:** drop onto an unlaunched mission; assert the card takes `MAX(queue_position) + 1` within that mission — not position 1, and not a position derived from where the pointer was released.
- **The star does not reach inside a mission:** star a card, drop it onto an unlaunched mission holding three cards; assert it runs fourth. Assert the same card still sorts first in a board column.
- **Launched-ness has one implementation:** assert the drop routing and the Mission Control panel both call the same derivation rather than deriving locally. Two derivations agree until the first time they do not, and the symptom — a drop opening a new mission while the panel shows the old one as open — is very hard to read from the board.
- **Status is never stored:** assert no column or config key persists launched-ness; kill a run mid-flight and assert the mission does not remain launched.
- **Membership survives a file re-import:** re-import a member's plan file; assert `mission_id` is preserved, i.e. it is absent from `UPSERT_PLAN_SQL`'s column list and its ON CONFLICT SET list.
- **Existing staged cards migrate intact:** a board with staged cards and no missions migrates to one unlaunched mission per workspace, membership in `queue_position` order, nothing lost from the board and nothing swept into a mission the user never made.
- **No confirm gate, and the modal is not `confirm()`:** assert the launch path contains no `window.confirm(`/`confirm(` call and that the modal is a real in-webview element.
- **Launch is idempotent:** press Launch twice; assert one set of teams and one dispatch per stream.
- **A board move launches nothing and persists nothing:** drag a mission card to another column; assert the panel opens, the card's stored column is unchanged, and no team was seated.
- **Panel registered in both hosts:** assert `/mission-control` serves the panel over HTTP and the rail renders its icon from the manifest, with no `shell.html` edit.
- **Missions are STAGING-only:** assert a mission card cannot be created in, or moved to, any other column.
- **Membership removes from the board:** drop a plan onto a mission card; assert it becomes a member and no longer renders as a loose column card.
- **The two drags are distinguishable:** assert dragging the mission opens the panel and dragging a plan onto it adds a member.
- **An unanalysed mission behaves exactly as today's queue:** create a mission by dropping cards into STAGING, never run Analyze, launch it; assert the dispatch sequence is byte-identical to the current staging-queue behaviour.
- **Auto-create on first drop:** drop a card into STAGING with no mission open; assert one mission is created with a codename and the card is a member.
- **Codenames are stable and unique:** assert a mission's codename does not change across reloads and two missions never collide.
- **Mission card is not a feature:** assert it does not set `feature_id` on its members, does not cascade on move, and is not counted in feature complexity derivation.
- **Sandboxed creation path:** create a mission card by writing only a plan file, with no API call; assert it imports and is launchable.
- **Advice degrades to a question:** with no map, assert the opening proposal says so and offers to run Analyze. With a map, assert it states stream count and depth.
- **Operator writes run state, never user settings:** assert no operator path writes `feature_worktree_mode` or `orchestration_prior_feature_worktree_mode`.
- **Nothing to restore after a crash:** kill the session mid-run and assert no user setting was changed and no stash key is populated.
- **N-team handoff refusal:** assert `POST /orchestration/handoff` still refuses when any confirmed stream has no live head.

### Manual Verification

- Analyze from the STAGING header; confirm the map appears and the control behaves as on Planned.
- Run two teams against one staged map and confirm they take different streams.

## Outstanding Questions

- **[user]** Analyze on both headers confirmed? — proceeding on the assumption that yes, Analyze appears on both Planned and STAGING headers.
- **[user]** Should this plan be split? It covers 3+ distinct deliverables (persisting dependency edges + analysis rewrite, pop-time completion gate, mission card data model + board drag interception, operator protocol changes). Recommended split is recorded in User Review Required; proceeding on the recommendation that this plan retains its backend scope.
- With several streams free and the user having approved parallel work, does the operator still pick per wake, or does the user name the streams up front? Proceeding on the assumption that the user names streams up front at confirmation, and the operator dispatches the confirmed set per wake.
- Does anything today read `queue_position` in a way that assumes uniqueness? Proceeding on the assumption that `queue_position` consumers treat it as a sort key only.

**Routing: Complexity 3 → Send to Intern.**

## Implementation Summary

Implemented pop-time dependency gating in `LocalApiServer._runQueuePop` evaluating prerequisite completion (`completed_at IS NOT NULL`) with a 409 refusal for uncompleted blockers. Added `plan_dependencies`, `missions`, `mission_members` tables, `map_fingerprint` column, and V64 migration in `KanbanDatabase`. Added Analyze button to STAGING column header in `kanban.html` and updated `dispatchAnalyze` to target STAGING or Planned. Updated `dispatch-analysis/SKILL.md` for graph edge emission, cycle reporting, map fingerprint calculation, and whole-set staging. Added `codenameGenerator` and wired `mc*` mission control verb handlers into `KanbanProvider`, `LocalApiServer`, and `verbSchemas`.

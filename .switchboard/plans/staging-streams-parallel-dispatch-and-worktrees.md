# Mission cards: turn dispatch analysis into a stream map on a card, launched from the board

## Goal

Change the Analyze pass from emitting "the largest set that can start now" to emitting a **persisted stage map** of all candidate work — ordered streams that run in parallel with each other — so the STAGING queue can feed several teams at once, each in its own worktree, without violating a dependency. Add the Analyze control to the STAGING header alongside Planned.

### Problem Analysis

**The STAGING queue already supports parallel consumers.** This was the finding that reframed the whole area: `appendQueuePositions` computes `MAX(queue_position)` over `WHERE workspace_id = ? AND kanban_column = 'STAGING'`, which is **one ordering, not one consumer**. The in-flight refusal is per *team* — `LocalApiServer.ts:1695-1697`: *"a team is in flight when any active card belonging to that team is sitting in a coding column. Team membership is resolved from the card's `dispatched_terminal`."* And `POST /kanban/queue/next` takes `{from}`, so each lead identifies itself. N leads drain one ordered list concurrently, each gated only by its own in-flight card.

Cross-team leakage from that shared queue is already guarded: `:1605` refuses rather than widening — *"Dispatching workspace-wide would hand this team's card to another team's terminal"* — and `restrictToOriginTeam` (`:1951`) "closes the workspace-wide escape hatch". So team-scoped dispatch off a shared queue is solved.

**And the dependency analysis already exists**, further along than its output suggests. The Analyze button on the Planned column (`kanban.html:7693`, *"Analyze Planned plans for parallel dispatch"*) dispatches `.agents/protocols/dispatch-analysis/SKILL.md`, which:

- builds a **file-overlap graph** (step 3) and selects the largest non-conflicting subset — *"a maximum independent set problem on the conflict graph"* (step 4)
- reads declared dependencies (step 2) and, at `:105-107`, *"If plan A declares a dependency on plan B, A cannot start until B completes. Dependent plans are **conflicting** even with zero file overlap"*
- treats a feature as indivisible, unioning both file sets **and dependencies** across its subtasks (`:59-60`)
- receives `API_PORT` in its prompt rather than reading a port file — the pattern the rest of the system should follow
- moves the chosen set to STAGING via the API

**The gap: dependencies are used as an exclusion and then discarded.** A dependent plan is marked conflicting and left in Planned. Two consequences:

1. **A chain never stages.** A→B→C is three mutual conflicts, so at most one member is promoted per run.
2. **Nothing persists what depends on what.** The dependency knowledge is computed once, used to exclude, and thrown away — so no consumer can order anything by it.

A maximum-independent-set answer is a *subset*: it says what can start now and is invalid the moment anything finishes. A **stage map** is a plan of execution: stage 1 runs concurrently, stage 2 follows, and it stays valid until the inputs change — a plan added, edited, removed, or its file set altered. Never on completion. That is the difference between re-running Analyze after every card and running it once.

### Streams are information the operator reports, not a mode it enters

The orchestrator protocol already has this vocabulary, which makes exposing the map an extension rather than an addition:

- **`## Handoff, or arm?` (`:240-250`)** already lists the three session models, and **none of them changes**. A map makes the existing "arm" choice better-informed rather than adding a fourth: arm's stated trigger is *"Multiple teams across worktrees or separate repos requiring persistent coordination"*, and today the operator has to judge that from the plan list. With a map it can say how many independent streams actually exist, so arming is a decision with evidence instead of an inference.
- **`### One dispatch per lane per wake` (`:329-332`)** — *"A wake may feed both lanes, never the same lane twice. Assess both, act on what is free, and stop."* Lanes already exist as the unit of parallel progress. A stream **is** a lane, with the difference that its order is persisted rather than inferred per wake.
- **`### Propose a goal, then stop` (`:206-211`)** is the first message, and it already offers *"cap it at one lane"* — so the shape for discussing parallelism with the user exists. The addition is one or two sentences of advice: how many streams, how deep, what running more than one would require, and where the map's confidence is weakest. Then it stops, as it already does.
- **`### Obey the worktree setting; never write it` (`:354-357`)** already states the constraint, and names what stream-parallel changes: *"The default is `none` — one checkout, one team at a time."*

This is why `stream_id` matters over a bare stage number: the operator's report, its lane assignment and its violation detection all need to name *which chain*.

### Root Cause

The analysis was built to answer the safe question — "which of these can I fire simultaneously right now" — because that is all a single-consumer queue could use. Once the queue could feed N teams, the same graph could have answered the larger question, but the output shape was never revisited. The graph it builds is most of the work: file overlap is *undirected* (same stream), a declared dependency is *directed* (order within a stream).

## Metadata

**Complexity:** 6
**Tags:** backend, database, api, ui, reliability

## User Review Required

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

- **Storage** — a card is a plan file plus a DB record. No `orchestrationConfig`-vs-`workspaceState` decision, and no new run-parameter store. (`workspaceState` was disqualified anyway: `autoban.state` lives in `this._context.workspaceState` (`TaskViewerProvider.ts:1452`), reachable only from inside the extension host — invisible to an external orchestrator and to the standalone host.)
- **Channel** — a card is created by writing markdown into the plans directory, which the watcher imports automatically with no git precondition. So the file-based tier works **by default**: a sandboxed orchestrator that cannot reach the API needs no endpoint and no new inbox instruction kind. An API-capable one can POST instead. Both reachability tiers, existing machinery.
- **Visibility** — the map stops being invisible DB state. It can be read, reordered and deleted like any card, and its staleness is inspectable rather than inferred.
- **Trigger** — advancing a card is already the system's universal "start this" gesture, with UI that exists.

**It must not be a feature, and nesting is actively refused.** `linkFeatureSubtasksByPaths` *"never writes `is_feature=0` onto a row that is itself a feature (**nested-feature**)"*, and the project side guards too (`subtask_project_governed_by_feature`). Three further reasons the feature machinery would fight it:
- `feature_id` is a single parent pointer — a two-level tree, not three.
- `recomputeFeatureComplexity` is max-of-active-subtasks and does not recurse, so a super-feature's complexity would be meaningless.
- **The cascade is the wrong semantics.** `cascadeFeatureByPlanId` moves the feature *and every active subtask* to the same column atomically. Advancing a mission card must start **stream heads only** — not drop every chain into a coding column at once.

So a mission card **references without owning**: members keep their own `feature_id` (or none) and are linked by `stream_id`. No nesting, no cascade, no derived complexity.

### Missions live only in STAGING, and membership is a containment gesture

- **A mission card exists only in STAGING.** No other column may hold one. That answers where it sits and removes the "beside its own members" oddity, because members stop being separate board cards once they join.
- **Dragging a card onto a mission card adds it to the mission and removes it from the board.** Membership is containment, mirroring how feature subtasks roll up rather than appearing as loose column cards — the same rule `dispatch-analysis` already relies on (*"a subtask is never a standalone candidate … the user sees it rolled up under the feature"*). The mission card then shows its members and their streams.
- **Consequence for the drag interception below:** two drag semantics now exist on a mission card — dragging *the mission* opens the panel, dragging *a plan onto it* adds a member. Both must be distinguishable before the optimistic path, or a mis-drop either launches nothing or silently swallows a card.

**Automation becomes mission-scoped** — the schedule survives untouched, only its target becomes a mission's finite membership. Its own plan: `scope-automation-to-missions.md`.

### Missions get their own panel; the board move is navigation, not launch

The mission card's home is a **`missions` panel** (`missions.html` + `missions.js`). The card appears on the board, but **moving it switches to the panel** — it does not launch, and it does not move. The card only takes its new column when **Launch mission** is pressed in the panel.

**Intercept the drag; never move-then-revert.** Board drags are already optimistic: `optimisticMoveUntil` (`kanban.html:6225`) opens a window during which full `renderBoard` calls are suppressed, and `:6215-6222` records that a column move landing inside an optimistic tick can be silently mishandled. A provisional move that reverts on an unlaunched mission would fight exactly that machinery and can strand a card in a column it was never committed to. So a drag on a mission card is **intercepted before the optimistic path**: open the panel, write nothing. The move happens once, inside Launch, alongside the fan-out. Nothing to revert because nothing moved.

**This supersedes the launch modal.** An earlier revision put a decision modal on the move. The panel is the decision surface, so no modal is needed on the board at all — which is the better answer to the same problem, since the panel can show streams, depth, per-stream team assignment and the map's weak points at a size no modal should.

**Panel registration is a solved path — and this is a chance to use it properly.** `getPanelsManifest` (`headlessPanelHtml.ts:511`) takes an entry of `{id, label, icon, route, enabled}`; `getPanelHtmlById` gains a `missions` case; `LocalApiServer` serves the route. `shell.html` renders the rail from the manifest — its own comment: *"adding a panel route later adds a strip icon with no shell code change"* — so the icon is free. Follow the **companion-`.js` convention** that seven panels already use (`connections`, `planning`, `tickets`, `terminals`, `design`, `memo`, `project`), not the two inline-script exceptions. Note the contrast worth not repeating: `agent-control` was retrofitted as a `data-view` projection of `kanban.html` and now needs `extract-agent-control-into-its-own-panel-file.md` to undo it. A new panel should start as a panel.

### If a launch dialog is still wanted inside the panel: decision dialog, not confirm gate

If the panel's Launch step wants a final choice step of its own, the form is constrained by a hard project rule: **plain confirm gates are banned, multi-choice decision dialogs are allowed.** A launch modal is the latter — it presents the streams and takes choices (which streams, which teams, how many worktrees), so it is a configuration step, not an "Are you sure?".

**It must not use `window.confirm()`.** That is a silent no-op in a VS Code webview (sandboxed iframe without `allow-modals`, always returns `false`) — the bug that broke the kanban delete-plan button. The codebase contains zero `confirm()` calls and two comments recording why (`kanban.html:12121`, `:12964`). Build it as a custom in-webview modal on the existing pattern: `feature-create-modal` / `openFeatureCreateModal` (`:11493`) / `closeModal` (`:11216`).

- **Decided: stream id + sequence**, not a single stage number. Records the chain identity as well as the order, which is what the operator's detection and reporting need — "stream 3 is blocked at step 2" is answerable; "stage 2 is blocked" is not.
- **A stream/sequence pair is the recommendation, not `base_branch`.** `queue_position` is documented as "a 1-based sort key" assigned append-from-`MAX+1` (`KanbanDatabase.ts:508-516`) — a total order that never ties by construction, so encoding stages as equal positions would overload a sort key with grouping semantics nothing reads. And `base_branch` expresses *one* predecessor, which cannot express "these four run together, then those two." So: `stream_id` + `stream_seq` columns carry the map, `queue_position` remains the tiebreak among cards at the same sequence, and `base_branch` becomes **derived** — a card at sequence *n* cuts from the merged result of sequence *n-1* in its own stream. This reverses an earlier recommendation of `base_branch` as the encoding.
- **The operator advises before confirmation and acts after it.** Sequential stays the default. The operator reads the map and, in its opening proposal, states what parallelism is available and what it would cost and risk *against the goal the user stated* — then waits. An earlier revision added stream-parallel as a fourth session model plus a selection rule; that was over-prescriptive. A later revision then swung too far and left the operator advisory-only, which would have removed the execution it already performs. Both were wrong in the same way — treating this as a question about *how much the operator does* rather than *which state it writes*.

**The real line is state lifetime, not authority.** `worktree-strategy-control-contract.test.js` exists because `applyOversightWorktreeTopology` forced `feature_worktree_mode` on arm and restored it on disarm, and a crash left the forced value in place with the user's own parked in `orchestration_prior_feature_worktree_mode`. The defect was *taking away and giving back a persistent user setting*. So:
- **Never written by the operator:** `feature_worktree_mode` and anything else that is a stored user preference.
- **Legitimately written by the operator, after confirmation:** per-run parameters — how many streams this session runs, which team takes which stream, the worktrees provisioned for it. These shadow no user setting, so nothing is stashed and a crash leaves no forced value to restore.

Advice remains strictly more capable than a rule for the *decision*: it can say "streams 2 and 3 have no file overlap, but 3 declares a dependency the analysis took on faith" — which no shallowest-first heuristic expresses and which a rule would decide silently. It must not write worktree strategy — `worktree-strategy-control-contract.test.js` pins that only the user does, because `applyOversightWorktreeTopology` used to force `per-feature` on arm and a crash left the forced value in place. The protocol already states the read-only rule itself (`switchboard-orchestrator/SKILL.md:354-357`, "Obey the worktree setting; never write it").
- Confirm Analyze should appear on **both** Planned and STAGING headers.

## Complexity Audit

### Routine

- Adding the Analyze control to the STAGING column header (the Planned one exists at `kanban.html:7693`).
- A stage column on `plans`, plus migration.
- Rewriting `dispatch-analysis`'s output section to emit and persist stages.

### Complex / Risky

- **The graph is already built; the change is what is emitted from it.** Connected components of the undirected (file-overlap) graph are streams; topological order within a component, from the directed dependency edges, is the sequence. A cycle in the declared dependencies is a real input error and must be *reported*, not silently broken — a greedy pass would otherwise pick an arbitrary order and look successful.
- **A stage map is only as good as declared dependencies.** Step 2 reads them "if declared". File overlap is inferred and reliable; declared dependencies are optional prose. So the map will be confident about conflicts and incomplete about ordering, and it must say which parts rest on declarations rather than presenting one uniform confidence.
- **Persisting the map creates a staleness question the subset never had.** A subset was consumed immediately; a map lives across dispatches. If a plan is edited after analysis, its file set may change and its stage may be wrong. The map needs a validity marker — the set of plans and a content signal it was computed from — so a stale map is *detected* rather than silently followed. This is the single most important design element and the easiest to omit.
- **Features are one unit and the map must preserve that.** The protocol's rule (`:53-70`) is emphatic — analyse at the feature level, move the feature card only (a `POST /kanban/move` on a feature cascades to subtasks atomically; moving a subtask re-derives the parent's column and drags the feature somewhere the user did not put it). Stage assignment therefore attaches to the feature, never to a subtask.
- **N teams draining one list needs the stage gate at pop time, not at analysis time.** `queue/next` must refuse a card whose stage predecessors are incomplete rather than handing it out. That is a new refusal in the same critical section as the in-flight one — a section maintained for ~4,000 installs — and it needs its own test rather than being folded into the existing 409 path.
- **Parallel worktrees multiply the unscoped-`branch` collision.** The current schema has `branch TEXT NOT NULL UNIQUE`, workspace-unscoped (the V24/V25 migrations used `UNIQUE(branch, workspace_id)`). Owned by `scope-unscoped-tables-by-workspace-id.md`, but N concurrent worktrees make the collision likelier, so that plan becomes a practical precondition rather than a tidy-up.

## Edge-Case & Dependency Audit

**Migration.** Additive stage column, nullable — a plan with no stage behaves exactly as today, so the queue keeps working for anyone who never runs Analyze. No existing behaviour changes until a map exists.

**Security.** No new endpoint or path resolution. The analysis remains read-only on plan files and moves cards via the API.

**Side effects.** Sequential work becomes stageable for the first time, so STAGING will hold more cards than before — a UI density change worth checking.

**Ordering.** Needs `worktree-models-consolidate-and-a-staging-toggle.md` first for one clear feature-worktree model, and `scope-unscoped-tables-by-workspace-id.md` before running many worktrees concurrently.

## Dependencies

- **Requires** `worktree-models-consolidate-and-a-staging-toggle.md`.
- **Practical precondition:** `scope-unscoped-tables-by-workspace-id.md` for the `branch` uniqueness collision.
- **Shares the merge-back gap** with the per-feature-worktree queue design: a stage-2 worktree cutting from "stage 1's merged result" presumes stage 1 merged, and nothing merges today. Now settled in `worktree-models-consolidate-and-a-staging-toggle.md`: one merge endpoint with three callers — the kanban WORKTREES tab, the Mission Control panel for mission-owned worktrees, and the controller agent. **The controller caller is the one this plan depends on**, since a stream advancing unattended has nobody to click either UI.
- Independent of the orders work.

## Adversarial Synthesis

**"The current subset behaviour is safe — a map invites running too much at once."** The map does not decide concurrency; the per-team in-flight refusal and the number of live teams do. The map only records what *may* run together. Today's subset is not safer, it is less informative: it discards the ordering it computed.

**"Re-run Analyze after each completion instead of persisting a map."** That is the current behaviour and it is why a chain never progresses: each run sees the same mutual conflicts and promotes one card. It also puts an agent dispatch in the completion path of every card.

**"Use `base_branch` and skip the schema change."** `base_branch` names one predecessor branch. Stages are sets, and the relationship is many-to-many across streams. It is the right field for *deriving* where a worktree cuts from, and the wrong one for carrying the map.

**"Let the operator sequence the work instead of persisting stages."** That puts an agent in the critical path of every dispatch and gives it authority the strategy contract withholds. A persisted map is inspectable, testable and deterministic; an agent re-deriving order per pop is none of those. Note this cuts the opposite way from the advisory framing above and both hold: the *map* is deterministic and persisted; the *decision to run several streams* is the user's, informed by the operator. Machinery decides ordering; a person decides concurrency.

## Proposed Changes

1. **Analyze emits streams, not a subset**: connected components of the file-overlap graph become streams; topological order within a component becomes the sequence. Report dependency cycles as input errors.
2. **Persist the map** in a nullable stage column on `plans`, with `queue_position` as the intra-stage tiebreak.
3. **Record a validity marker** — the plan set and a content signal the map was computed from — so a stale map is detected.
4. **Stage all candidates**, not only the currently-unblocked ones.
5. **`queue/next` gates on stage**: refuse a card whose stage predecessors are incomplete, with its own test.
6. **Derive `base_branch`** from the stage: a later stage's worktree cuts from the previous stage's merged result.
7. **Analyze control in the STAGING header** as well as Planned.
8. **The mission card is the carrier.** Analysis writes it as a plan file (file tier, works sandboxed) or via the API; it holds the streams and their order. Members are linked by `stream_id`, never re-parented. A new card kind — not a feature, no cascade, no derived complexity.
8a. **`missions` panel** — `missions.html` + `missions.js`, registered in `getPanelsManifest`, a `getPanelHtmlById` case, and a `LocalApiServer` route. The rail icon follows from the manifest. Companion-`.js` convention, not an inline-script monolith.
8b. **Board move = navigate.** A drag on a mission card is intercepted before the optimistic path (`optimisticMoveUntil`, `kanban.html:6225`), opens the panel, and writes nothing. The card keeps its column until Launch.
8c. **Launch mission** in the panel performs the column move and the fan-out as one action: seat teams, provision worktrees, stage, dispatch each stream head.
8d. **Launch is idempotent.** Moving the card twice must not double-seat teams or double-dispatch. This is the one behaviour on the board where a card's move fans out beyond itself, so it needs an explicit guard rather than relying on the user not doing it.
8e. **Expose the map to the operator**: a read path returning streams, their depth, and each card's `stream_id` / `stream_seq`.
9. **Sequential stays the default; the handoff sequence generalises from one team to N.** `## The handoff sequence` (`:252-266`) is already scope → launch → stage → dispatch card one → report and exit. For streams it becomes:
   1. **Scope** — read the map.
   2. **Advise and stop** — streams available, what running several costs, where the map is weakest. The user confirms which streams to run. *(The only genuinely new step.)*
   3. **Launch** — seat one team per confirmed stream.
   4. **Provision** — one worktree per stream, host-owned as today. *(The only step needing a run parameter.)*
   5. **Stage** — in the map's order; `stream_id`/`stream_seq` are already persisted.
   6. **Dispatch the head of each confirmed stream** — one `queue/next` per team. The per-team in-flight refusal already serialises this correctly.
   7. **Report and exit** — `POST /orchestration/handoff`, whose `409` on a dead head or empty queue becomes an N-team check.
   Steps 3–7 are what it already does, once per stream instead of once.
10. **Operator detects and reports** stream violations. It never writes strategy, reorders work, or cuts branches.

### Migration

Additive nullable column. A plan with no stage behaves as today.

## Verification Plan

### Goal Invariants

- Analyze produces a stage map covering every candidate, not a subset.
- No card is dispatched while a stage predecessor is incomplete.
- A chain A→B→C stages in one Analyze run and dispatches in order without re-running it.
- A stale map is detected rather than followed.
- Features carry stage assignment; subtasks never do.

### Automated Tests

- **A chain stages in one run:** analyse A→B→C and assert all three are staged with ascending stages. This is the behaviour today's implementation cannot produce, so it is the test that proves the change landed rather than being described.
- **Parallel streams are concurrent:** two independent chains; assert their heads share a stage and both dispatch to different teams simultaneously.
- **Pop-time stage gate:** request a stage-2 card while its stage-1 predecessor is in flight; assert refusal. Then complete the predecessor and assert it is handed out. Its own test, not folded into the in-flight 409 path.
- **No re-run needed:** run Analyze once, then drive the whole map to completion without invoking it again. Directly pins the map-versus-subset distinction.
- **Staleness detected:** edit a plan's file set after analysis; assert the map is reported stale rather than followed. The easiest requirement to omit and the one whose absence silently reintroduces conflicts.
- **Dependency cycle reported:** declare A→B→A; assert an input error, not an arbitrary order.
- **Features stay whole:** a feature with subtasks gets one stage on the feature card and none on subtasks; assert no subtask is staged independently.
- **Nullable columns are inert:** with no map, the queue behaves byte-identically to today.
- **No confirm gate, and the modal is not `confirm()`:** assert the launch path contains no `window.confirm(`/`confirm(` call and that the modal is a real in-webview element. Both halves — a `confirm()` implementation would pass a "modal exists" check while doing literally nothing, which is precisely the shipped bug this rule was written from.
- **Launch is idempotent:** press Launch twice; assert one set of teams, one set of worktrees, one dispatch per stream.
- **A board move launches nothing and persists nothing:** drag a mission card to another column; assert the panel opens, the card's stored column is unchanged, and no team was seated. Then assert the same for a drag that is abandoned — the failure mode the optimistic window makes possible.
- **Panel registered in both hosts:** assert `/missions` serves the panel over HTTP and the rail renders its icon from the manifest, with no `shell.html` edit.
- **Missions are STAGING-only:** assert a mission card cannot be created in, or moved to, any other column.
- **Membership removes from the board:** drop a plan onto a mission card; assert it becomes a member and no longer renders as a loose column card. Then assert the reverse — removing it from the mission returns it to its column rather than orphaning it.
- **The two drags are distinguishable:** assert dragging the mission opens the panel and dragging a plan onto it adds a member, with no path where a mis-drop both moves the mission and swallows the card.
- **An unanalysed mission behaves exactly as today's queue:** create a mission by dropping cards into STAGING, never run Analyze, launch it; assert the dispatch sequence is byte-identical to the current staging-queue behaviour. This is the test that proves missions generalise rather than replace, and its failure means the change is not backward-compatible however good the map is.
- **Auto-create on first drop:** drop a card into STAGING with no mission open; assert one mission is created with a codename and the card is a member. Drop a second card; assert it joins the same mission rather than creating another.
- **Codenames are stable and unique:** assert a mission's codename does not change across reloads and two missions never collide.
- **Mission card is not a feature:** assert it does not set `feature_id` on its members, does not cascade on move, and is not counted in feature complexity derivation.
- **Sandboxed creation path:** create a mission card by writing only a plan file, with no API call; assert it imports and is launchable. This is the tier that makes the design work for a sandboxed client, and it is the one nobody will test by hand.
- **Advice degrades to a question:** with no map, assert the opening proposal says so and offers to run Analyze, rather than silently omitting the subject. With a map, assert it states stream count and depth. There is no mode to assert, which is the point — advice has no dead-control failure mode.
- **Operator writes run state, never user settings:** assert no operator path writes `feature_worktree_mode` or `orchestration_prior_feature_worktree_mode`, and that the run parameters it *does* write do not persist past the session. This is the test that distinguishes legitimate execution from the deleted forcing machinery, and asserting "writes nothing" instead would forbid the handoff the operator already performs.
- **Nothing to restore after a crash:** kill the session mid-run and assert no user setting was changed and no stash key is populated. The precise failure the strategy contract was written for, checked against the new run parameters rather than the old forced setting.
- **N-team handoff refusal:** assert `POST /orchestration/handoff` still refuses when any confirmed stream has no live head, rather than reporting a partial handoff as complete.

### Manual Verification

- Analyze from the STAGING header; confirm the map appears and the control behaves as on Planned.
- Run two teams against one staged map and confirm they take different streams.

## Outstanding Questions

- **[user]** Analyze on both headers confirmed?
- Does the panel list *all* mission cards or only the selected one? A list makes past missions inspectable — useful for the staleness question — but the board card is the entry point, so a detail view may be the whole panel.
- With several streams free and the user having approved parallel work, does the operator still pick per wake, or does the user name the streams up front? The protocol's *"assess both, act on what is free"* was written for two lanes; at five it is ambiguous. Naming them up front keeps the choice with the user and needs no rule.
- What content signal makes the staleness check reliable — plan-file mtime, a hash of the declared file sets, or the plan set alone? mtime is cheap and noisy; a hash is accurate and needs the analysis to record more.
- Does anything today read `queue_position` in a way that assumes uniqueness? The migration comment calls it a 1-based sort key; if a consumer assumes no gaps or no ties, adding a stage dimension beside it needs that consumer checked.

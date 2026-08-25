# Missions: finish the card, the drag, and the operator's binding

## Goal

Finish missions so the two formats the operator actually wants both run:
**operations** — the user defines a mission and the Mission Control persona
oversees it — and **missions** — the user drags cards into STAGING, they form a
mission, and it is launched. The backend, the reachability, the producer, the
containment grouping and a single-head launch have landed. What remains is the
mission *card* (so a mission is a thing on the board, not a label above a group),
the *drag* that chooses which mission receives a card, per-mission queue scoping,
multi-stream launch, and the mission id the persona needs to know what it is
overseeing.

### Problem Analysis

Missions were built across two cards in one feature, plus a review pass. What
exists now, verified against the tree:

| Piece | State |
|---|---|
| `missions` / `mission_members` tables, V64 | live |
| `runState` and `sequencing` derived, never stored | live |
| nine `mc*` verbs: handlers, schemas, allowlist, catalog | live |
| `/mission-control/verb/*` route | live — added because every verb 404'd without it |
| staging resolves-or-creates a mission and adds members | live (`stageForQueue`) |
| mission identity on every board card | **partial** — `_buildBoardCards` stamps `missionId` / `missionName` (lines 2215-2216), but `_refreshBoardImpl` — the primary board refresh path — builds cards inline (lines 4035-4062) WITHOUT mission fields. See item 1 correction. |
| STAGING groups members under a mission label | live (`kanban.html:2957`, the group render) |
| launch: one head, idempotent, via `dispatchNextFromQueue` | live (`KanbanProvider.ts:14479`) |
| stop: releases the in-flight holder | live |
| `GET /kanban/mission/active` | live |
| **a mission as a board card** | **absent** |
| **drag onto a mission to choose the receiver** | **absent** |
| **per-mission `queue_position` scoping** | **absent** |
| **missions-only-in-STAGING enforcement** | **absent** |
| **board move on a mission = navigate, not launch** | **absent** |
| **multi-stream launch (one team per stream)** | **absent** |
| **`maxExtraWorktrees` run provisioning** | **absent — launch refuses rather than ignoring the field** |
| **mission id in the operator's prompt** | **absent** |

**1. A mission is a label, not a card.** `staging-streams-parallel-dispatch-and-worktrees.md`
says a member "stops being a board card" and the mission card shows its members
instead. The review pass grouped members under a mission label rather than
replacing them, for a stated reason: every STAGING action — advance, Prompt all,
Run queue, reorder, star — targets card elements, so swapping them for one
mission card without rebuilding those actions leaves a column you can see and
cannot operate. The grouping is honest containment, but it is not the card, and
the card is what item 8b's drag, item 12's ordering and the panel's Launch all
refer to.

**2. `missions` is not a `plans` table.** This is the reason the card is real work
rather than a rendering tweak. The board renders rows from `plans`;
a mission is a row in `missions`. The subtask containment it is modelled on —
`displayCards = displayCards.filter(card => !card.featureId)` (`kanban.html:8806`
and `:8952`, two sites) — works because a feature IS a plan row, so hiding
subtasks still leaves a card to click. Hiding mission members leaves nothing
unless missions are pushed to the webview as first-class board items.

**3. The drag has no receiver choice.** Item 10 specifies three outcomes: dropped
onto an unlaunched mission → join at the end of its queue; dropped into empty
space → a new mission below the existing ones; dropped onto a launched mission →
a new mission, because a launched mission is a sealed set. Today every drop joins
whatever open mission exists, resolved by `resolveOrCreateOpenMission`
(`KanbanDatabase.ts:11483`). That is correct for one mission at a time and cannot
express "this card belongs to that mission" when several are teed up — which is
the whole product change the plan names ("missions can be created in advance and
added to progressively").

**4. `queue_position` is column-wide, not per-mission.** `appendQueuePositions`
(`KanbanDatabase.ts:10250`) computes `MAX(queue_position)` over the STAGING column
for the workspace. With one open mission that is exactly the mission's order. With
two, their positions interleave, and item 12's rule — "a card joins at the END of
its mission's queue" — cannot be honoured, nor can its test ("assert the card
takes `MAX(queue_position) + 1` within that mission — not position 1, and not a
position derived from where the pointer was released").

**5. The persona does not know which mission it is overseeing.** `adopt`, `start`,
`confirm`, `handoff` and `stop` all take `{ workspaceRoot }`. `GET
/kanban/mission/active` now lets an operator *ask*, which unblocks the format,
but nothing puts the mission in the prompt, so the persona has to know to ask.
For an unsupervised `mission` that is fine; for a supervised `operation` the
binding is the point.

**6. Launch dispatches one head.** Item 8c is "seat one team per confirmed
stream". `launchMission` calls `dispatchNextFromQueue` once. For a sequential
mission — the default, and identical to today's queue — that is complete and
correct. For an analysed mission with independent chains it under-delivers: the
dependency edges and the pop-time gate already make N concurrent dispatches safe,
and nothing uses that capacity.

**7. Two routing defects of the same class keep CI red, so this cannot be proven.**
`browser-panel-verb-routing` fails on `connections.js:523` and `:528` posting
`copyTextToClipboard` — handled in `TaskViewerProvider` and in the
`TASKVIEWER_VERBS` allowlist, and **reachable** on `/connections/verb` (the route
checks `TASKVIEWER_VERBS` at `LocalApiServer.ts:7174`). The test's reachable set
for the connections panel (`browser-panel-verb-routing.test.js:165`) omits
`TASKVIEWER_VERBS`, so it flags the verb as unreachable when the runtime
dispatches it correctly. `staging-column` fails because commit `684643c3` removed
the **entire `runSheet` block** from `kanban.html` — the declaration, the
`sourceColumn: 'STAGING'` entry, and the `forEach` rendering loop — not just the
one field. Both are in CI, and a plan that finishes missions while two gates are
red cannot demonstrate it finished anything.

### Root Cause

The feature was split across two cards on a theme rather than on a runnable unit,
and the seam between them — which namespace the panel posts to, what produces a
mission, what a mission looks like on the board — belonged to neither. Each card
was complete against its own plan and the composite did nothing. The mission
*model* was specified in detail; the mission *card* was described by reference
("a board card the analysis writes") without anyone noticing that missions are
not plan rows and therefore cannot be board cards without new plumbing.

## Metadata

**Complexity:** 6
**Tags:** backend, frontend, ui, database, api, reliability

## User Review Required

None. Every open question from the source plans has been settled in conversation
and is recorded below as a decision:

- **A mission renders as a board card in STAGING, and its members do not.** The
  grouping shipped in the review pass is the interim, not the destination.
- **Both worktree creators stay** in the WORKTREES tab (project and unbound), and
  feature worktrees are never auto-provisioned per feature. Owned by
  `worktrees-tab-is-a-list-not-a-console.md`; noted here because item 7 below
  touches run provisioning.
- **`maxExtraWorktrees` is the only opt-in for a worktree on a run** — 0 by
  default, never above 1 for a `mission`. Launch currently refuses when it is
  above 0; item 7 makes it work rather than relaxing the cap.
- **`feature_worktree_mode` is now inert** and its last surface, the WORKTREES tab
  strategy radio, writes a key nothing reads. Item 8 retires it. This is a
  behaviour removal on a released setting and is deliberate: per-feature
  provisioning cut one branch per staged feature off the default branch, which
  clashes, and it contradicted the mission worktree cap.

## Complexity Audit

### Routine

- Per-mission `queue_position` (a `WHERE mission_id` scope on one MAX query).
- `UNIQUE(member_id)` on `mission_members` so a plan cannot be in two missions.
- The two red-gate fixes.

### Complex / Risky

- **The mission card is new board plumbing, not a render change.** Missions must
  reach the webview as board items, be rendered by a distinct renderer (a mission
  is not a plan: no complexity, no role routing, no advance), and every STAGING
  action must be re-pointed at the mission or explicitly scoped to members. The
  failure mode is a column that renders correctly and cannot be operated.
- **The drag must be intercepted BEFORE the optimistic path.** `optimisticMoveUntil`
  (`kanban.html:6376`, set at `:6391`) opens a window during which `renderBoard`
  is suppressed. A provisional move that reverts can strand a card in a column it
  was never committed to. A drag *of* a mission opens the panel and writes
  nothing; a drag *onto* a mission adds a member. Both must be distinguishable
  before that window opens, or a mis-drop either launches nothing or silently
  swallows a card.
- **Two drag semantics on one element.** Dragging the mission card navigates;
  dragging a plan onto it adds a member. Getting this wrong is not a visual bug —
  a swallowed card is invisible until someone counts the queue.
- **Launched-ness must have exactly one derivation.** The drop routing and the
  panel both decide whether a mission is open. Two derivations agree until they
  do not, and the symptom — a drop opening a new mission while the panel shows the
  old one as open — is very hard to read from the board. `_deriveMissionRunState`
  is that one derivation; nothing may re-derive it locally.
- **Nothing may store launched-ness.** Already true and pinned by
  `dependency-gate-contract.test.js`. Multi-stream launch is the change most
  likely to reintroduce a stored flag as a convenience.
- **Retiring `feature_worktree_mode` must not take the drain with it.** ~4,000
  installs hold the key. The radio and the broadcast field go; the key stays in the
  DB, and `_drainRetiredWorktreeModeStash` plus `normalizeFeatureWorktreeMode` MUST
  survive — the drain restores a user's real mode from
  `mission-control_prior_feature_worktree_mode` after a session that crashed while
  forcing `'per-feature'`, and it calls the normaliser. Deleting the normaliser as
  "unused" breaks a data-integrity path for every install that never drained.
  `worktree-strategy-control-contract.test.js` exists because that forcing defect
  happened once; retire it deliberately and keep the drain assertion, rather than
  editing it into vacuity.

## Edge-Case & Dependency Audit

**Migration.** V65: `UNIQUE(member_id)` on `mission_members`, and a backfill that
assigns any STAGING card with no mission to one mission per workspace in
`queue_position` order — the plan's own rule: "nothing lost from the board and
nothing swept into a mission the user never made". Cards staged before missions
existed currently render under a "no mission" group; after the backfill they
belong to a real one. `feature_worktree_mode` is not deleted from the DB.

**Security.** None. No new path resolution. The mission card is created through
the existing plans-directory watcher or the existing API.

**Side effects.** STAGING's appearance changes materially: one card per mission
instead of one per plan. That is the intended change and is worth a release note.

**Ordering.** Item 10 (the red gates) first — without it nothing downstream can
be shown to work. Then 1–4 (the card and the drag), then 5–8.

## Dependencies

- **Requires** the landed mission backend: tables, derived `runState`, the nine
  verbs, `/mission-control/verb/*`, `stageForQueue` membership, `launchMission`.
- **Requires** the pop-time dependency gate for multi-stream launch — a second
  concurrent dispatch is only safe because the gate filters blocked members.
- **Blocks** `the-automation-model-four-things-not-a-mode-axis.md` from being true:
  that plan's Implementation Summary claims completion, but the ten Schedules and
  Control verbs its panel tabs post (`mcNewSchedule`, `mcUpdateSchedule`,
  `mcDeleteSchedule`, `mcStartSchedule`, `mcStopSchedule`, `mcScheduleLoadLog`,
  `mcScheduleExternalCopy`, `mcControllerStop`, `mcControllerRestart`,
  `mcControllerAck`) have no handlers and are absent from the allowlist. They are
  ratcheted by name in `browser-panel-verb-routing.test.js`. **That plan needs a
  correction, not this one** — but its two tabs are dead in the panel this plan
  finishes, so it should be re-opened alongside.
- **Adjacent, owned elsewhere:** `worktrees-tab-is-a-list-not-a-console.md` (the
  tab's chrome).
- **Not fixed here, and not owned by anyone:** the subtask runsheet fan-out in
  `KanbanProvider`'s column-move path no-ops for `planId` keys, because
  `SessionActionLog._resolvePlan` resolves by `plan_file` or `session_id` and never
  by `plan_id` — so the case its comment names (file-based plans with
  `session_id=''`) is exactly the case it cannot serve. Small, unrelated, needs a
  home.

## Adversarial Synthesis

**"The grouping already gives containment — leave it."** It gives visibility, not
containment, and it cannot carry the drag. Item 10's three outcomes all name a
mission card as the drop target; a label has nothing to drop onto. The grouping
was the right interim because it kept the column operable, and it is the wrong
destination for the same reason it was a good interim: it changed nothing about
what the cards are.

**"Make a mission a plan row and get the card for free."** No. `feature_id` is a
single parent pointer, `recomputeFeatureComplexity` does not recurse, and
`cascadeFeatureByPlanId` moves a feature *and every active subtask* to the same
column atomically — advancing a mission must start stream heads only, not drop
every chain into a coding column at once. `linkFeatureSubtasksByPaths` already
refuses nested features. The cascade is the wrong semantics, which is why the
mission references without owning.

**"Multi-stream launch is the valuable part — do it first."** It is the least
valuable part. A sequential mission is identical to today's queue and already
works; the operator's stated bottleneck is that missions do not exist as objects
they can assemble and point at, not that one runs at a time.

**"Fix the two red gates separately."** They are the same defect class as the bug
that made this whole feature dead, in the same test file, and they are why "all
gates green" could not be claimed for the last three commits. Fixing them here is
what makes this plan verifiable.

### Risk Summary

Key risks: (1) **`_refreshBoardImpl` does not stamp `missionId`/`missionName`** —
the containment filter `!card.missionId` filters `undefined` and hides nothing;
the mission card renders alongside its unhidden members (the exact failure this
plan exists to clean up); mitigation: fix the inline card builder at
`KanbanProvider.ts:4035-4062` first, as item 1 now states explicitly; (2) the drag
is wired after the optimistic-move window and strands or swallows cards;
(3) launched-ness gets a second derivation, or a stored flag returns via
multi-stream launch; (4) retiring `feature_worktree_mode` deletes
`normalizeFeatureWorktreeMode` as "unused" and silently breaks the stash drain;
(5) **the `copyTextToClipboard` red gate is a test-reachable-set omission, not a
routing defect** — fixing the route is a no-op; the test at
`browser-panel-verb-routing.test.js:165` needs `...TASKVIEWER_VERBS` added;
(6) **the `runSheet` red gate requires restoring a ~15-line block, not one line**
— commit `684643c3` deleted the entire rendering loop. Mitigations: fix
`_refreshBoardImpl` first (item 1), assert interception order (item 2), assert
one derivation and no stored state (items 3 and 7), preserve all surviving
drain/normaliser assertions in the test retirement (item 8), and correct both
red-gate diagnoses (item 9).

## Proposed Changes

### 1. A mission is a board card; its members are not — `src/services/KanbanProvider.ts`, `src/webview/kanban.html`

**Context:** `_buildBoardCards` already resolves mission identity and stamps
`missionId` / `missionName` on every card. `renderBoard` hides subtasks with
`displayCards.filter(card => !card.featureId)` at `kanban.html:8806` and `:8952`
— two sites, and a third predicate would be how one gets missed.

**Logic:** Push missions to the webview alongside cards in the `updateBoard`
payload. In STAGING, render one mission card per mission, showing its codename,
member count, derived `runState` and — when a map exists — its stream depth.
Filter members out of the card list with the same shape as the subtask filter.
Replace the mission group label shipped in the review pass.

**Implementation:**

> **Superseded:** "Add `missions` to the `updateBoard` payload from `_refreshBoard`" — stated as if mission identity is already live on every board card.
> **Reason:** The Problem Analysis table claimed mission identity is live on every board card via `_buildBoardCards`. It is not. `_refreshBoardImpl` (the primary board refresh, called from `_refreshBoard` at line 3884) builds cards inline at lines 4035-4062 WITHOUT `missionId` / `missionName`. Only `_buildBoardCards` (lines 2215-2216, used by `getBoardCards` and three other paths) stamps them. The containment filter `!card.missionId` filters `undefined` (falsy → `!undefined` is `true` → every card passes), so members would NOT be hidden. The mission card would render alongside its unhidden members — the exact "column that renders correctly and cannot be operated" failure this plan exists to clean up.
> **Replaced with:** The implementation below, which fixes BOTH card-building paths.

- **Fix `_refreshBoardImpl` first** — the inline card builder at
  `KanbanProvider.ts:4035-4062` must stamp `missionId` / `missionName` from the
  same `missionByMember` map `_buildBoardCards` uses. Without this, the
  containment filter in the webview sees `undefined` on every board-refresh card
  and filters nothing. This is the load-bearing prerequisite for item 1 — the
  mission card cannot contain members whose identity is absent from the payload.
- Add `missions` to the `updateBoard` payload from `_refreshBoardImpl` (the same
  broadcast that carries `cards` at line 4155, so one snapshot, not two). The
  `missions` array carries each mission's `id`, `name`, `runState` (derived),
  member count, and — when a map exists — stream depth.
- `renderBoard`: extend the containment filter to
  `!card.featureId && !card.missionId`, applied at **both** sites
  (`kanban.html:8806` and `:8952`).
- Add `createMissionCardHtml(mission)` — a distinct renderer. A mission has no
  complexity, no role routing and no advance affordance; reusing `createCardHtml`
  would inherit all three.
- **Re-point every STAGING action, by name:** `advance` / `promptAll` /
  `runQueue` / `reorderColumn` / `setPriorityStarred` / `moveSelected` /
  `completeSelected`. Each either targets the mission (Run queue → launch) or is
  removed from the column with its reason recorded. An action left targeting a
  card selector in a column that no longer renders cards is a dead control.
- Delete `.mission-group-label` and its CSS (`kanban.html:2957-2968`) and the
  grouping branch in the column render.

**Edge Cases:** A mission with zero members renders with an empty state rather
than vanishing — otherwise deleting the last member makes the mission
unreachable. A STAGING card with no `missionId` (staged before missions, before
the V65 backfill) keeps rendering as a loose card so nothing disappears.

### 2. The drag chooses the receiver — `src/webview/kanban.html`

**Context:** `optimisticMoveUntil` (`:6376`, set `:6391`) suppresses `renderBoard`
for a window after a drag. Drops into STAGING route through `stageForQueue`
(cross-column) or `reorderQueue` (same-column), pinned by
`staging-column-contract.test.js`.

**Logic:** Three drop outcomes, per item 10, and no refusal on any of them:
onto an **unlaunched** mission card → join that mission at the end of its queue;
into **empty space** in the column → a new mission holding that card, ordered
below the existing missions; onto a **launched** mission → a new mission, because
a launched mission is sealed. Separately, a drag *of* a mission card opens Mission
Control and writes nothing.

**Implementation:**
- Interception happens in the dragstart/dragover path, **before**
  `optimisticMoveUntil` is set. Distinguish by the dragged element's kind, not by
  the drop target alone.
- Extend the `stageForQueue` verb with an optional `missionId`; when present,
  membership goes to that mission instead of `resolveOrCreateOpenMission`.
  **Update the verb schema** at `verbSchemas.ts:456` — add `missionId` as an
  optional field (`{ type: 'string', required: false }`). Without this, the
  schema validator silently drops the field on POST and the membership routes to
  `resolveOrCreateOpenMission` regardless of the drop target. Run
  `npm run catalog:generate` after the schema change.
- Launched-ness comes from the broadcast mission's derived `runState`, never from
  a local computation.

**Edge Cases:** A drop onto a mission from another column both stages the card and
adds it to that mission — one gesture, one write path. A drop onto a mission the
card already belongs to is a reorder, not a second membership row (item 3's
`UNIQUE(member_id)` makes that structural).

### 3. `queue_position` is per mission — `src/services/KanbanDatabase.ts`

**Context:** `appendQueuePositions` (`:10250`) takes `MAX(queue_position)` over
`workspace_id` + `kanban_column = 'STAGING'`. `mission_members` has
`PRIMARY KEY (mission_id, member_id)` (`:289`, `:639`), which permits one plan in
two missions.

**Logic:** Scope the MAX to the receiving mission's membership, so a card joins the
end of *its* mission's queue. Add `UNIQUE(member_id)` so membership is single.

**Implementation:**
- `appendQueuePositions` gains an optional `missionId`; when present, MAX is taken
  over that mission's members.
- V65: `CREATE UNIQUE INDEX idx_mission_members_member ON mission_members(member_id)`,
  after de-duplicating any existing double membership (keep the earliest).
- The queue pop is unchanged: it orders by `queue_position` across STAGING, which
  remains globally monotonic.

**Edge Cases:** Two missions can now hold the same position number. The pop's
comparator must stay a total order — `compareByPrecedence` already falls through
to `column_entered_at` then `createdAt`, so equal positions do not tie.

### 4. Missions live only in STAGING — `src/services/KanbanProvider.ts`, `src/webview/kanban.html`

**Logic:** A mission cannot be created in, or moved to, any other column. A board
move on a mission card opens Mission Control and does not move it (item 8b) — the
card takes its new column only when Launch runs.

**Implementation:** Refuse a mission move server-side as well as intercepting it
in the webview; a UI-only guard is bypassable through the API.

**Edge Cases:** None — there is no legitimate mission outside STAGING.

### 5. The operator is told which mission it oversees — `src/services/LocalApiServer.ts`, `src/services/TaskViewerProvider.ts`

**Context:** `GET /kanban/mission/active` answers the question; `adopt`, `start`,
`confirm`, `handoff` and `stop` still take `{ workspaceRoot }` only.

**Logic:** Accept an optional `missionId` on those routes, thread it to the prompt
builder, and name the mission and its membership in the persona's opening context.
A supervised `operation` gets it; an unsupervised `mission` runs with no persona
and needs nothing.

**Implementation:** Extend the `missionControl*` option callbacks with
`missionId`. Absent, behaviour is exactly as now — the persona asks.

**Edge Cases:** A mission that completes mid-session must not leave the persona
bound to it; the binding is a run parameter, never a stored user setting, so a
crash leaves nothing to restore.

### 6. Launch seats one team per confirmed stream — `src/services/KanbanProvider.ts`

**Context:** `launchMission` (`:14479`) calls `dispatchNextFromQueue` once, guarded
on derived in-flight state.

**Logic:** Accept the confirmed stream count. Call the pop once per stream, each
with its own team's head. The per-team in-flight refusal and the pop-time
dependency gate serialise this correctly — that is why N concurrent pops are safe.

**Implementation:** Resolve one head per confirmed stream, then one pop each.
Idempotency stays derived: a mission with any held member refuses.

**Edge Cases:** Fewer live teams than confirmed streams dispatches what it can and
reports the shortfall — it must not silently run one stream and report success for
three.

### 7. Launch honours `maxExtraWorktrees` by provisioning — `src/services/KanbanProvider.ts`

**Context:** Launch currently refuses when `maxExtraWorktrees > 0`, because run
provisioning was removed with the per-feature model.

**Logic:** Provision that many extra worktrees for the run — 0 by default, never
above 1 for a `mission`. One tree shared by the run, cut at launch from the
default branch as it is then. Not one per member, not one per stream.

**Implementation:** A run-scoped worktree row (no `feature_id`), recorded so
cleanup and the merge prompt reach it. Removed when the mission completes.

**Edge Cases:** A shared tree cannot clash with itself, which is why this is safe
where per-feature was not. A launch that cannot cut the tree refuses rather than
running in the wrong checkout.

### 8. Retire `feature_worktree_mode` — `src/services/KanbanProvider.ts`, `src/webview/kanban.html`, `src/test/worktree-strategy-control-contract.test.js`

**Context:** Nothing provisions per feature any more. The key's last surface is the
WORKTREES tab strategy radio, writing a value no code reads — a dead control.

**Logic:** Remove the radio and the broadcast field. **Keep
`normalizeFeatureWorktreeMode` and keep the drain.** Remove the
`getFeatureWorktreeMode` and `setFeatureWorktreeMode` verb arms
(`KanbanProvider.ts:13843-13864`), their schema entries (`verbSchemas.ts`), and
regenerate the allowlist (`npm run catalog:generate`) so the generated
`KANBAN_VERBS` set no longer carries dead verbs that 404 on a panel that no
longer posts them.

**The drain is live and must not be collateral.** `_drainRetiredWorktreeModeStash`
(`KanbanProvider.ts` — `PRIOR_KEY = 'mission-control_prior_feature_worktree_mode'`)
restores a user's real worktree mode from the stash that prior versions parked it
in while forcing `'per-feature'` during an armed session, and consumes the key as
its own idempotency latch. It calls `normalizeFeatureWorktreeMode(savedPrior)`, so
deleting the normaliser breaks it. Any install that crashed under the old forcing
behaviour still holds a stashed value; the drain is the only thing that gives it
back. It runs whether or not anything reads the mode afterwards, and it stays.

**The stash key was renamed and the source plan's test never existed.**
`worktree-models-consolidate-and-a-staging-toggle.md` asked for an assertion that
`orchestration_prior_feature_worktree_mode` is "still referenced in exactly one
place". That key name is pre-rename: the live key is
`mission-control_prior_feature_worktree_mode`, renamed by
`rename-the-orchestrator-to-mission-control.md`. `grep` for the old name returns
zero across `src/`, and no such assertion was ever added to
`worktree-strategy-control-contract.test.js`. A test written literally from that
plan would have passed vacuously on a key that does not exist — so write it
against the real key, and pin the rename in the message.

> **Superseded:** "replace it with one assertion that survives the setting: the drain exists, reads the key, consumes it, and is referenced in exactly one place."
> **Reason:** The existing test file has 232 lines of assertions. The drain tests alone (lines 113-135) assert five properties: falsy-prior early return, normaliser clamping on restore, key consumption (idempotency latch), re-broadcast ordering, and no in-memory latch. The normaliser tests (lines 139-174) assert legacy clamping for seven values and a read-routing count. Collapsing these into "one assertion" replaces behavioural contracts with a presence check — a drain that restores without consuming the key re-runs on every restart and overwrites the user's later choice, and only the key-consumption assertion catches that.
> **Replaced with:** The retirement below, which deletes only the dead-control assertions and preserves every surviving drain/normaliser assertion.

**Retire the contract test deliberately.** Delete the radio/control assertions
from `worktree-strategy-control-contract.test.js` (lines 178-228 — the
`strategyBlock` extraction and the four control tests) and the
`setFeatureWorktreeMode` arm test (lines 94-109, since the arm itself is being
removed). **Keep** the forcing-machinery-gone tests (lines 62-84), the stash-key
count test (lines 86-92), the drain tests (lines 113-135), and the normaliser
tests (lines 139-174). Update the `setFeatureWorktreeMode` arm test's assertion
count if the arm removal changes the drain call-site count (currently 3:
declaration + constructor + `setCurrentWorkspaceRoot`). The drain's idempotency
(key consumption), normaliser routing, and no-in-memory-latch assertions are the
exact properties that prevent the original defect — a drain that restores
without consuming re-runs on every activation and overwrites the user's later
choice. That outlives the radio.

**Edge Cases:** Installs holding `'per-feature'` lose auto-provisioning. Intended:
it clashed. `maxExtraWorktrees` is the replacement and is opt-in per run. Installs
holding a stashed prior value still get it restored, because the drain survives.

### 9. Fix the two red gates — `src/test/browser-panel-verb-routing.test.js`, `src/webview/kanban.html`

> **Superseded:** "`connections.js:523` and `:528` post `copyTextToClipboard`, which is handled in `TaskViewerProvider` but unreachable on `/connections/verb` — the same defect class as the mission panel's. Route it, or post a verb the connections route can reach."
> **Reason:** `copyTextToClipboard` IS reachable on `/connections/verb`. The connections route at `LocalApiServer.ts:7153` checks three allowlists in order: `SETUP_VERBS`, `PLANNING_VERBS`, `TASKVIEWER_VERBS`. `copyTextToClipboard` is in `TASKVIEWER_VERBS` (line 7174 dispatches to `_handleTaskViewerVerb`, which has `case 'copyTextToClipboard'` at line 15215). The verb works at runtime. The TEST is wrong: `browser-panel-verb-routing.test.js:165` defines the connections panel's reachable set as `new Set([...SETUP_VERBS, ...PLANNING_VERBS])`, omitting `...TASKVIEWER_VERBS`. The test flags `copyTextToClipboard` as an offender because it is not in the test's reachable set, not because it is unreachable on the route. "Route it" solves a problem that does not exist.
> **Replaced with:** Add `...TASKVIEWER_VERBS` to the connections panel's reachable set in the test.

> **Superseded:** "restore `sourceColumn: 'STAGING'` in the autoban schedule run sheet, removed by `684643c3`."
> **Reason:** Commit `684643c3` removed the entire `runSheet` block — the `const runSheet = [{ sourceColumn: 'STAGING', headRole: 'coding' }]` declaration, the `forEach` rendering loop that drew the schedule steps in the panel, and all associated DOM construction. "Restore one line" leaves the test still failing at the `runSheet` body extraction (`staging-column-contract.test.js:227`), because `const runSheet = [` does not exist either. The fix restores a ~15-line rendering block, not a single field.
> **Replaced with:** Restore the entire `runSheet` block (declaration + `forEach` rendering loop) that commit `684643c3` deleted from `kanban.html`. The test at `staging-column-contract.test.js:222-232` asserts both `sourceColumn: 'STAGING'` exists AND that no `sourceColumn: 'CREATED'` or `sourceColumn: 'PLAN REVIEWED'` entries appear in the `runSheet` body — both must pass.

**Logic:** Fix the `browser-panel-verb-routing` test by adding
`...TASKVIEWER_VERBS` to the connections panel's reachable set at line 165:
`new Set([...SETUP_VERBS, ...PLANNING_VERBS, ...TASKVIEWER_VERBS])`. This matches
the server's actual routing (which already checks all three). Separately,
restore the entire `runSheet` block (the `const runSheet = […]` declaration and
its `forEach` rendering loop) that commit `684643c3` removed from `kanban.html`.
The block is the autoban schedule's visual run sheet — it renders the steps the
schedule walks, and the `staging-column` contract test asserts its shape.

**Edge Cases:** None. The first is a test correction (the runtime is already
correct). The second is a block restoration (the run sheet is display-only; no
behaviour depends on it beyond the test's structural assertion).

### Migration

**V65** — `UNIQUE(member_id)` on `mission_members` after de-duplicating, and a
backfill assigning STAGING cards with no mission to one mission per workspace in
`queue_position` order. No worktree is destroyed. `feature_worktree_mode` stays in
the DB, unread.

## Verification Plan

### Goal Invariants

- STAGING renders one card per mission; members render nowhere as loose cards.
  This requires `_refreshBoardImpl` to stamp `missionId`/`missionName` — the
  containment filter depends on it.
- A drop into STAGING always succeeds, and which mission receives it follows
  item 10's three outcomes exactly.
- A card joins at `MAX(queue_position) + 1` **within its mission**.
- A plan belongs to at most one mission.
- A mission exists only in STAGING; a board move opens the panel and moves nothing.
- Launched-ness has exactly one derivation and is stored nowhere.
- Launch is idempotent, dispatches one team per confirmed stream, and provisions
  no more than `maxExtraWorktrees` trees.
- No control in STAGING or the Mission Control panel reports a write it did not
  perform.
- Every gate in CI is green.

### Automated Tests

- **Members render nowhere:** assert the containment filter is applied at **both**
  `renderBoard` sites, enumerated by line, and that no STAGING card element is
  emitted for a member. One missed site is the whole failure mode.
- **`_refreshBoardImpl` stamps mission identity:** assert the inline card builder
  at `KanbanProvider.ts:4035-4062` includes `missionId` and `missionName` from the
  `missionByMember` map — the same fields `_buildBoardCards` stamps at lines
  2215-2216. Without this, the containment filter sees `undefined` on every
  board-refresh card and filters nothing.
- **Every re-pointed action still works:** for each of `advance`, `promptAll`,
  `runQueue`, `reorderColumn`, `setPriorityStarred`, `moveSelected`,
  `completeSelected`, assert it targets a mission or is absent with a recorded
  reason. A dead control in a rebuilt column is the predictable regression.
- **The three drop outcomes:** onto unlaunched → joins it; empty space → new
  mission ordered after the others; onto launched → new mission, launched
  membership unchanged, nothing refused or errored.
- **`stageForQueue` schema carries `missionId`:** assert `verbSchemas.ts` defines
  `missionId` as an optional field on `stageForQueue`. Without it, the validator
  silently drops the field and the drag's receiver choice is lost.
- **Interception precedes the optimistic window:** assert the mission branch is
  reached before `optimisticMoveUntil` is set. Source-order, because the symptom
  is a stranded card nothing else can see.
- **The two drags are distinguishable:** dragging a mission opens the panel;
  dragging a plan onto it adds a member.
- **A board move launches nothing:** drag a mission to another column; assert the
  panel opens, its stored column is unchanged, and no team was seated.
- **End of the queue means the end:** drop onto a mission holding three; assert
  position 4 within that mission, not 1, and not derived from the pointer.
- **The star does not reach inside:** star a card, drop it onto a mission holding
  three; assert it runs fourth, and still sorts first in a board column.
- **One plan, one mission:** assert the unique index, and that a double-membership
  insert is refused rather than silently creating a second row.
- **Missions are STAGING-only:** assert refusal both in the webview and over the
  API — a UI-only guard is bypassable.
- **Launched-ness has one implementation:** assert the drop routing and the panel
  both call `_deriveMissionRunState` rather than deriving locally.
- **Status is never stored:** kill a run mid-flight; assert the mission does not
  remain launched. Already covered; must keep passing through the multi-stream
  change.
- **Launch is idempotent:** press Launch twice; one set of teams, one dispatch per
  stream.
- **Launch reports a shortfall:** confirm three streams with two live teams;
  assert two dispatches and an explicit shortfall, not a success.
- **Worktree cap:** launch a three-stream mission at the default; assert zero trees.
  Set 1; assert one, shared. Assert a `mission` cannot exceed 1.
- **Migration:** a board with staged cards and no missions backfills to one mission
  per workspace in `queue_position` order — nothing lost, nothing swept into a
  mission the user never made.
- **No refusal-free dead controls:** assert no `mc*` arm and no STAGING action
  returns success on a path where nothing was written.
- **The retired strategy test is retired, not weakened:** assert the
  radio/control assertions and the `setFeatureWorktreeMode` arm test are ABSENT
  from `worktree-strategy-control-contract.test.js`, and that the stash drain
  tests SURVIVE — `_drainRetiredWorktreeModeStash` present, reading and consuming
  `mission-control_prior_feature_worktree_mode`, referenced in exactly one place,
  and still routing through `normalizeFeatureWorktreeMode`. The drain's
  idempotency (key consumption), re-broadcast ordering, and no-in-memory-latch
  assertions must all remain. Assert against the REAL key: the source plan named
  `orchestration_prior_...`, which is pre-rename and matches nothing, so an
  assertion copied from it passes vacuously.
- **The drain still drains after the retirement:** seed the stash key, run the
  drain, assert `feature_worktree_mode` is restored and the key is consumed. This
  is the one behaviour in item 8 that has a user's data on the other end of it.
- **Retired verbs are gone:** assert `getFeatureWorktreeMode` and
  `setFeatureWorktreeMode` are absent from `KANBAN_VERBS` in the generated
  allowlist, from `verbSchemas.ts`, and from the `handleServiceVerb` switch in
  `KanbanProvider.ts`. Dead verbs in the catalog 404 on a panel that no longer
  posts them.
- **CI is green:** `browser-panel-verb-routing` passes after adding
  `...TASKVIEWER_VERBS` to the connections panel's reachable set (test fix, not
  a routing change). `staging-column` passes after restoring the entire
  `runSheet` block (declaration + `forEach` rendering loop), not just the
  `sourceColumn: 'STAGING'` field.

### Manual Verification

- Drag four cards into an empty STAGING; confirm one mission card with four
  members and a codename.
- Tee up two missions; drop a card onto the second and confirm it joins that one.
- Launch the first; drop a card onto it and confirm a third mission appears.
- Drag a mission card to another column; confirm the panel opens and the card does
  not move.
- Launch a mission with `Max extra worktrees` at 0 and confirm no tree; set 1 and
  confirm one shared tree, merged from the WORKTREES tab.
- Start an `operation` and confirm the persona names the mission it is overseeing.

**Routing: Complexity 6 → decompose into a feature before dispatch.** Items 1–2
are one unit (the card and its drag are meaningless apart), 3–4 one unit
(membership integrity and column scoping), 5–7 one unit (the run), 8–9 one unit
(retirement and the red gates). Do not dispatch this as a single card.

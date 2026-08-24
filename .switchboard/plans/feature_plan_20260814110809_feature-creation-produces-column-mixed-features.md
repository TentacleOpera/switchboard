# Feature Creation Can Produce a Column-Mixed Feature — Propagate the Column to the Subtasks, Not Just the Feature Card

## Goal

Make it impossible for `createFeatureFromPlanIds` to leave a feature whose subtasks sit in
different kanban columns. After this change, creating a feature from plans in CREATED and
PLAN REVIEWED resolves one column for the whole set and **writes it back to every subtask**,
exactly as the same function already does for `project`. The advisory "⚠ CROSS-COLUMN
warning + press Replan afterwards" guidance in two skills is replaced by a guarantee, because
a warning that the human has to act on is not a guard.

> **Superseded:** The goal sentence above, read together with the body's framing ("One feature
> = one column is derived and then dropped"), as establishing a standing **system invariant**.
> **Reason:** The changes close the **creation** door (change 1), the **assignment** door
> (change 2), and repair **pre-existing** state (change 3). They do not close the third door:
> `moveCardToColumnByPlanFileWithReason` (`KanbanProvider.ts:7176`) writes an individual
> subtask's column via `db.updateColumnByPlanFileWithReason` with **no feature check of any
> kind**. Dragging one subtask card on the board re-mixes the feature immediately, and change 3
> is specified as running "once per workspace on startup", so a mid-session re-mix survives
> until restart. Every verification step below can pass while column-mixed features still appear
> on the board in normal use — a green check that does not mean the goal is met.
> **Replaced with:** the goal is scoped to what the changes actually guarantee — **no creation,
> assignment, or split path can produce a column-mixed feature, and existing mixed features are
> repaired once** — with the remaining door named as a deliberate exclusion rather than left as
> an unstated gap (below).

### Known non-goal: the manual subtask move stays open, on purpose

Moving a single subtask card by hand is left unguarded deliberately. It is the operator's repair
tool — the observed incident was fixed exactly that way, and edge case 10 cites it as the
evidence that the regeneration path is sound ("moving a subtask regenerated the block
correctly"). Blocking it to enforce the invariant would delete the only escape hatch from a bad
automated grouping, which is a worse product than the bug being fixed. The consequence is stated
rather than hidden: **the invariant is enforced at every automated entry point and is advisory
for a deliberate human drag.** The skills must say so too (changes 4 and 5), or an agent reading
board state will assume a guarantee the system does not make.

### The problem, as observed

On 2026-08-14 a `SUGGEST FEATURES` run over 17 candidate plans produced seven features. Three
of them contained one PLAN REVIEWED subtask and one CREATED subtask. In every one of those
three, the **feature card itself landed in CREATED** while holding a PLAN REVIEWED child:

```
Controls That Produce Nothing                | feature card: CREATED
  ├─ link button is inert                    | PLAN REVIEWED   ← stranded above its parent
  └─ agent visibility forces a column        | CREATED
```

That is not a cosmetic inconsistency. Three things break:

1. **The feature card's column misrepresents its contents.** An operator reading the board
   sees a CREATED feature and reasonably concludes nothing in it has been planned.
2. **Dragging the feature to a coder column dispatches an unreviewed plan.** Subtasks cascade
   with the feature, so the CREATED subtask skips plan review entirely and goes straight to
   coding — the failure the Replan guidance exists to prevent, dependent on a human
   remembering to press a button.
3. **A subtask sits in a column its own parent has not reached.** Nothing in the system
   reconciles this, and no automation pass looks for it.

The operator's verdict on the state: *"it breaks the workflow. or at least, when it happens,
the entire feature needs to go back to created."* That is the rule this plan implements in
code rather than in prose.

**Claim 2 verified end to end.** `moveCardToColumnByPlanFileWithReason` detects
`previousRecord.isFeature` and calls `db.cascadeFeatureByPlanId(planId, targetColumn)`
(`KanbanProvider.ts:7203`), which moves the feature **and every `status='active'` subtask** to
the target column inside one transaction. The drag-drop arm then dispatches the expanded set —
`buildDispatchPlans` appends the full subtask bundle via `expandFeatureSubtaskPlans` for any
`isFeature` record. A CREATED subtask inside a dragged feature is delivered to a coder with no
plan review, exactly as described. This is a mechanical consequence, not a theoretical one.

### Root cause — the derive half shipped, the propagate half did not

`KanbanProvider.createFeatureFromPlanIds` (`src/services/KanbanProvider.ts:13212`) resolves
the feature's column by taking the **earliest** subtask column in board order
(`:13285-13295`):

```ts
resolvedColumn = subtasks
     .map((st: any) => this._normalizeLegacyKanbanColumn(st.kanbanColumn))
     .filter((col: string | null): col is string => !!col)
     .sort((a, b) => (ordinalMap.get(a) ?? Infinity) - (ordinalMap.get(b) ?? Infinity))[0]
     || this._normalizeLegacyKanbanColumn(subtasks[0].kanbanColumn) || 'CREATED';
const effectiveColumn = resolvedColumn === 'BACKLOG' ? 'CREATED' : resolvedColumn;
```

`effectiveColumn` is then written to the **feature row only**. No subsequent statement writes
it to the subtasks. The subtask loop at `:13386-13393` calls `updateFeatureStatus`, which sets
parentage — not column.

**The identical defect was already found and fixed for `project`, eleven lines further down**
(`:13394-13405`), and the comment there states the rule this plan is applying to column:

> NOTE: this method DERIVES the feature's project FROM the subtasks (featureProject above),
> then this propagate forces ALL subtasks to that chosen project — so if the source subtasks
> disagreed (pre-fix divergent state), the divergent ones are normalized to the feature's
> final project. That direction flip (subtasks→feature, then feature→subtasks) is the correct
> post-fix behavior: one feature = one project.

One feature = one project is enforced. One feature = one column is derived and then dropped.
The fix is to mirror the propagate that is already sitting next to it.

Choosing the *earliest* column is already the correct resolution — it is the conservative
direction, and it is what makes the normalisation safe: a plan can always be demoted to a
column it has already passed, whereas promoting an unreviewed plan to PLAN REVIEWED would
assert a review that never happened. Only the write-back is missing.

**Confirmed verbatim against `src/services/KanbanProvider.ts` at HEAD.** The subtask loop
performs exactly two writes — `db.updateFeatureStatus(...)` (parentage) and
`db.setProjectForPlansInvariant(..., { bypassSubtaskGuard: true })` (project). There is no
column write anywhere on this path.

### There is a fourth resolution site the plan did not account for

`KanbanProvider.recomputeFeatureColumnFromSubtasks` (`:6936`) performs the **same**
earliest-ordinal resolution — its own doc comment says so: *"Mirrors createFeatureFromPlanIds'
resolution exactly so the two never disagree."* The file watcher calls it to self-heal the
`insertFileDerivedPlan` `'CREATED'` clobber on feature re-import.

It also carries a guard that a shared helper **must not swallow**:

```ts
// A feature is a container: once it has a real column, that column is
// authoritative and must NOT be re-derived from its subtasks. […]
// Subtask progress never drags the feature backward.
if (current !== 'CREATED') return;
```

Change 2's instruction to "extract the resolution into one private helper so creation,
assignment and split cannot drift apart" is right but under-counted: there are **four** sites,
not three, and the fourth wraps the shared resolution in a caller-specific early-return. The
helper must return the resolved column and nothing else; `recomputeFeatureColumnFromSubtasks`
keeps its guard at its own call site. Absorbing that early-return into the helper would make
feature-file re-import start yanking advanced features backward to their least-progressed
subtask — a regression the guard's comment records as already having been fixed once.

### Secondary cause — two skills teach a warning where a guard belongs

Both `.agents/skills/group-into-features/SKILL.md` (steps 3 and 5) and
`.agents/skills/kanban_operations/SKILL.md` (the `assign-to-feature.js` cross-column warning
at `:127-131`, and the Suggest Features Workflow at `:189-191`) instruct the agent to *create
the mixed feature anyway* and then write a ⚠ note telling the human to press **Replan**.

That guidance was followed exactly on the observed run and still produced a broken board. It
fails for three reasons:

- It is **advisory at the wrong moment**. The agent is told to warn, not to avoid, so the bad
  state is created by design and the remedy is deferred to a human.
- The note it prescribes says *"Only review/refine the CREATED subtasks — the PLAN REVIEWED
  subtasks have already been reviewed"*, which requires Replan to have per-subtask
  granularity that the feature-level button does not obviously offer.
- It leaves the **feature card's own column** — the actual inconsistency — entirely
  unaddressed. Neither skill mentions it.

> **Superseded:** "`_buildSuggestFeaturesPrompt` (`KanbanProvider.ts:13901`) reads the
> `group-into-features` skill body verbatim into the clipboard prompt, so a fix to the skill
> file reaches the board button with no separate prompt edit."
> **Reason:** Wrong about the mechanism. `_buildSuggestFeaturesPrompt` never reads the skill
> file. It builds ``const skillPath = `${workspaceRoot}/.agents/skills/group-into-features/SKILL.md` ``
> and emits the instruction **"Read and execute the skill at ${skillPath}"** alongside the
> candidate-card list and a placeholder map. The prompt carries a *path*, not a *body*. The
> conclusion drawn from this — that skill edits reach the board button with no prompt edit — is
> true, and in fact more robust than assumed, because the agent reads the file live and there is
> no staleness window at all. But one instruction derived from the wrong mechanism is
> unrunnable: verification step 12 as originally written ("confirm the copied prompt carries the
> rewritten step 3/step 5 text") can **never** pass, because the prompt will never contain that
> text. An unpassable check gets quietly weakened or reported as blocked.
> **Replaced with:** the prompt passes a path; skill edits reach the button at agent-execution
> time. Verification step 12 is rewritten to assert what is actually observable — that the
> copied prompt contains the correct `skillPath` and per-card columns, and that the file at that
> path no longer teaches the warning.

**A related doc error to fix in the same pass.** `.agents/skills/group-into-features/SKILL.md:8`
carries the identical wrong claim — *"OR by clicking the **Suggest Features** board button
(which copies this skill's text with the workspace root injected)"*. That sentence is the likely
origin of the misconception and is corrected in change 4.

`_buildSuggestFeaturesPrompt` does emit each candidate's current column into the prompt
(`column: ${c.column}` per card), which is what makes an agent-side pre-check possible at
propose time. That half of the original analysis is correct and verified.

### Background context

- **Column ordinals come from `_buildKanbanColumns`**, and `BACKLOG` is special-cased to
  ordinal `-1` (`:13282-13284`) then re-mapped to `CREATED` (`:13295`). Any normalisation must
  reuse that same resolution rather than introducing a second notion of "earliest", or a
  BACKLOG member will resolve differently in the two places.
- **Custom columns participate.** `_getCustomKanbanColumns` feeds `columnDefs`, so the ordinal
  map is workspace-specific and cannot be replaced with a hardcoded column order.
- **`move-card.js` already cascades feature → subtasks** (`kanban_operations/SKILL.md:82`:
  *"When the card is a feature, all of its subtasks cascade to the same column automatically"*).
  The cascade machinery exists; creation simply never invokes it.
- **Callers of `createFeatureFromPlanIds`** are the webview `createFeature` message
  (`:12119-12126`), the HTTP route `POST /kanban/feature` (`LocalApiServer.ts:3876`), the
  `splitFeature` path (`:13550`, `:13554`), and `reconcile-features` (`:13743`). All four
  inherit the fix from one place; that is the reason to fix it here and not at a call site.
- **`splitFeature` is a real case, not a theoretical one.** It re-creates two features from an
  existing subtask set, so a feature that is already column-mixed splits into two features
  that are each still mixed unless the normalisation lives in the shared primitive.
- **Unreleased dev work.** The board's column-mixing behaviour is not persisted user state that
  shipped in a released version; no migration is required. Existing mixed features on a user's
  board are pre-existing data, addressed by the one-shot reconcile in Proposed Change 3 rather
  than by a schema migration.

**Added during this pass:**

- **There is a fifth caller.** `src/standalone/bootstrap.ts:1880` wires
  `createFeatureFromPlanIds` into the standalone host's verb router. Fixing the shared provider
  satisfies PRD contract #1 (*never fork the UI/engine — both hosts share one module*) and #7
  (*two-layer completion*) for free: the browser cockpit inherits the guard with no second edit.
  An implementer who puts the guard in `TaskViewerProvider` or `LocalApiServer` instead breaks
  exactly that property and produces a headless host that still creates mixed features.
- **The exact atomic write primitive already exists.**
  `KanbanDatabase.cascadeFeatureByPlanId(featurePlanId, targetColumn, targetStatus?, includeAllSubtasks = false)`
  writes the feature row and every `status='active'` subtask to one column inside a single
  `BEGIN`/`COMMIT`, validates the column against `VALID_KANBAN_COLUMNS` / `SAFE_COLUMN_NAME_RE`,
  and performs exactly one `_persist()`. Its default subtask filter (`status = 'active'`) is
  byte-identical to `getSubtasksByFeatureId`'s, so it selects exactly the set
  `_regenerateFeatureFile` will render. This is the primitive the propagate should use.
- **The `onColumnChanged` event has zero subscribers.** `KanbanDatabase._fireColumnChanged`
  fires from three column-write sites; nothing in `src/` subscribes to `onColumnChanged`. A
  column write therefore has no observers beyond the explicit calls the writing method makes.
  This is the evidence behind the dispatch correction in the Complexity Audit.
- **`feature_lock_columns` is an existing refusal precedent whose default is inert.**
  `assignPlansToFeature` reads `feature_lock_columns` (default
  `'IN PROGRESS,CODE REVIEW,REVIEWED,DONE'`) and refuses when the feature's column is in the
  list. None of those four strings is a real built-in column id (the real ids are `LEAD CODED`,
  `CODER CODED`, `INTERN CODED`, `CODE REVIEWED`, `ACCEPTANCE TESTED`, `COMPLETED`), so the
  default never matches and the guard is dead in a default workspace. Change 2's refusal must be
  ordinal-driven and must not be layered on this as though it worked.

## Metadata

- **Complexity:** 6
- **Tags:** backend, database, bugfix, reliability, docs
- **Project:** Browser Switchboard

> **Superseded:** **Complexity:** 4. **Tags:** backend, agent-protocol, bugfix, reliability.
> **Reason:** Two corrections. (a) `agent-protocol` is not in the permitted tag vocabulary;
> the skill edits are documentation changes, so `docs` is the correct tag, and the DB-layer work
> earns `database`. (b) 4 is "routine single-file changes". This plan changes behaviour in a
> shared primitive with **five** callers including the standalone host, adds a second behavioural
> change plus a refusal branch on the assignment path, introduces a **new startup reconcile pass
> over existing user data**, rewrites two agent skill files, and regenerates three generated
> mirrors. A new refusal that returns an error where the system previously always succeeded is a
> breaking change for any caller that assumed success. That is squarely 5–6 ("multi-file changes,
> moderate logic", with one or two well-scoped risks extending existing patterns).
> **Replaced with:** **Complexity: 6.**

## User Review Required

None. The resolution direction (earliest column wins, subtasks demote to match) is the
operator's stated rule and is also the only safe direction.

## Complexity Audit

### Routine

- The column propagate itself: one call to an existing atomic primitive
  (`cascadeFeatureByPlanId`), guarded by a pre-computed "does anything actually differ" check,
  placed exactly where the `project` propagate already sits.
- The two skill edits, plus their `.claude/` mirror regeneration.

### Complex / Risky

- **This is a write to every subtask's column, on a path that currently writes none.** A bug
  here moves cards, and card movement is a dispatch trigger in this product.

  > **Superseded:** "The propagate must write the DB column only — it must **not** route through
  > `moveCardToColumn`, which auto-dispatches the destination column's agent. Creating a feature
  > must never dispatch anything."
  > **Reason:** `moveCardToColumn` does **not** dispatch. `moveCardToColumnWithReason`
  > (`KanbanProvider.ts:7099`) does exactly four things: `_autoCommitIfCodeReviewTransition`, the
  > column write (cascade for features, `updateColumnWithReason` otherwise), integration-sync
  > fan-out, and `_regenerateFeatureFile`. `moveCardToColumnByPlanFileWithReason` adds
  > `_refreshBoard` and a Project-panel push. Neither calls any dispatch command. Dispatch is a
  > **separate step performed by the drag-drop arms** — `triggerAction`, `triggerBatchAction`,
  > and `promptOnDrop` each move the card and *then* call
  > `executeCommand('switchboard.trigger…AgentFromKanban')`, the ordering that
  > `src/test/kanban-drag-confirm-before-dispatch.test.js` pins. Corroborating evidence: the
  > `onColumnChanged` event a column write fires has **zero subscribers** anywhere in `src/`. A
  > column write, by itself, cannot dispatch anything. The risk of moving cards is real; the
  > stated mechanism is not, and an implementer who trusts it will hand-roll a row loop to dodge
  > a danger that does not exist — losing atomicity and column validation in the process.
  > **Replaced with:** No column-write path dispatches. The real reasons not to loop
  > `moveCardToColumnByPlanFile` per subtask are cost and side-effects: N board refreshes, N
  > feature-file regenerations, and N Project-panel pushes for one logical operation. Use
  > `cascadeFeatureByPlanId` — one transaction, one persist, column validated — and fan out the
  > integration sync explicitly (next bullet).

- **Demotion is destructive to review state and must be logged.** A plan losing PLAN REVIEWED
  is the intended behaviour, but it is invisible after the fact unless the creation path says
  what it demoted and why. Without that line, the next report is "my reviewed plan went back
  to New and I don't know who did it".
- **External tracker parity.**

  > **Superseded:** "Feature creation already syncs the feature and its subtasks to
  > Linear/ClickUp. Subtask status is part of that sync, so a column change at creation time must
  > be applied before the sync fires, not after, or the local board and the tracker disagree."
  > **Reason:** Subtask status is **not** part of that sync, so the prescribed ordering fix is a
  > no-op. `_syncFeatureOutbound` passes `featureColumn` for the feature and a subtask array of
  > `{ planFile, planId, topic, complexity }` — **no column, no status field**.
  > `LinearSyncService.syncFeatureWithSubtasks` calls `syncPlan(feature…, params.featureColumn)`
  > for the parent and then only `updateIssueParent(subIssueId, featureIssueId)` per child; it
  > never touches a child's state. `ClickUpSyncService.syncFeatureWithSubtasks` has the same
  > shape. Ordering the propagate before the sync changes nothing at all.
  > **Replaced with:** The parity gap is real but it is a **missing write**, not a wrong order.
  > After normalisation the subtask's local column changes and **nothing ever syncs it outbound**,
  > so the tracker keeps the pre-normalisation status indefinitely. The fix is to fan out
  > `queueIntegrationSyncForPlanFile(workspaceRoot, st.planFile, effectiveColumn)` for each
  > demoted subtask — the identical call `moveCardToColumnByPlanFileWithReason` already makes for
  > a normal move. Fire it only for subtasks that actually changed, so the uniform case stays a
  > true no-op.

- **The forward direction must stay forbidden.** Resolution takes the earliest column, so
  normalisation only ever demotes. An implementer "simplifying" this to *latest* column, or to
  the feature card's column without regard to ordinal, would silently promote unreviewed plans
  into PLAN REVIEWED — strictly worse than the bug being fixed.
- **The refusal is a new failure mode on a path that always succeeded.** Every existing caller
  of `createFeatureFromPlanIds` and `assignPlansToFeature` must handle `success: false`
  gracefully. `reconcile-features` currently does not (see edge case 12) — it hard-returns
  mid-batch. Auditing the callers is part of the work, not a follow-up.
- **Do not add a confirmation dialog.** Per `CLAUDE.md`, and because `window.confirm()` is a
  silent no-op in a VS Code webview. The demotion is reported, not confirmed.

## Edge-Case & Dependency Audit

### Race Conditions

- **Watcher re-import vs. the propagate.** `registerPendingCreation` makes the watcher skip the
  new *feature* file for 3000 ms, but the *subtask* files are not registered. A subtask file
  re-imported inside that window runs through `insertFileDerivedPlan`, whose fresh-INSERT path
  hardcodes `kanban_column = 'CREATED'` — the exact clobber
  `recomputeFeatureColumnFromSubtasks` exists to heal. Because normalisation always demotes
  *toward* CREATED, a clobber during the window is at worst equal to the intended result, and at
  worst leaves the feature one step ahead of a subtask — which change 3 repairs. Do not add a
  lock; do assert the direction in verification.
- **Concurrent `createFeatureFromPlanIds` calls** (reconcile creating several features in a
  loop) share one `KanbanDatabase` sql.js instance and one debounced `_persist`. Using
  `cascadeFeatureByPlanId` keeps each feature's normalisation inside its own transaction rather
  than as N interleaved row writes competing with the debounce.

### Security

- No new external input surface. `cascadeFeatureByPlanId` validates the target column against
  `VALID_KANBAN_COLUMNS` / `SAFE_COLUMN_NAME_RE` before any UPDATE, so the propagate cannot be
  used to inject a column name. The refusal message interpolates `st.topic` and
  `st.kanbanColumn` into a string returned over HTTP — both are DB-resident values already
  echoed by existing error paths, so no new escaping requirement.

### Side Effects

1. **All subtasks already in one column.** The overwhelmingly common case. `effectiveColumn`
   equals every subtask's existing column, so the propagate is a no-op write. It must not log a
   demotion line, and must not touch `updated_at` in a way that disturbs the completion
   handshake (plan-file mtime advance is the completion authority; a DB `updated_at` bump is
   not, but a needless write is still noise).
   **Resolution:** compute the differing set *before* writing and skip the
   `cascadeFeatureByPlanId` call entirely when it is empty. That primitive writes `updated_at` on
   every matched row unconditionally, so the guard must live in the caller — it cannot be
   delegated downward.
2. **Zero subtasks (blank feature).** `subtasks.length === 0` short-circuits `resolvedColumn`
   to `CREATED` at `:13286-13288`. The propagate loop iterates nothing. No special-casing
   needed, but confirm the guard is on the loop, not on the resolution.
3. **A subtask in BACKLOG.** BACKLOG has ordinal `-1`, so a mixed set containing a BACKLOG plan
   resolves to BACKLOG, which `effectiveColumn` then re-maps to CREATED. The propagate must use
   `effectiveColumn`, never `resolvedColumn`, or subtasks land in BACKLOG while the feature
   card sits in CREATED — reintroducing the exact inconsistency in a new place.
4. **A subtask in a post-coding column.** Grouping a CODE REVIEWED plan with a CREATED plan
   would demote finished work back to CREATED, discarding real progress. This is materially
   different from demoting PLAN REVIEWED and must not be done silently: the creation path
   should **refuse** the mix when any subtask is at or beyond the first coding column, return
   an explicit error naming the offending plans, and create nothing. Grouping finished work
   with unstarted work is a mistake in the grouping, not something to normalise.
5. **Custom columns between CREATED and PLAN REVIEWED.** A workspace can define custom agent
   columns with arbitrary ordinals. Resolution must stay ordinal-driven off `ordinalMap`; do
   not hardcode a CREATED/PLAN REVIEWED pair anywhere in the fix.
6. **`splitFeature`.** Both new features are created through this same primitive, so each is
   normalised independently. A split of an already-mixed legacy feature therefore produces two
   uniform features — a quiet improvement, and it must be verified rather than assumed.
7. **`reconcile-features.js` / `POST /kanban/features/reconcile`.** It documents a cross-column
   `warnings[]` entry today (`kanban_operations/SKILL.md:252`). After this change the warning
   text is wrong — it should report what was **normalised**, not what to go fix by hand.
8. **Assignment after creation.** `assign-to-feature.js` adds a plan to an existing feature and
   can re-introduce a mix. It must apply the same normalisation: an assigned plan takes the
   feature's column if the feature is earlier, and triggers the same refuse-on-post-coding rule.
   Fixing creation alone leaves the second door open.
9. **The Replan button keeps its job.** After normalisation the whole feature is uniformly in
   an early column, so Replan operates on a uniform set — which is what it is good at. Nothing
   about Replan needs changing; it stops being a manual repair step and goes back to being a
   deliberate action.
10. **Feature file regeneration.** `_regenerateFeatureFile` rewrites the auto-generated
    `## Subtasks` block with each subtask's column. The propagate must land **before** the file
    is written, or the file records the pre-normalisation columns and disagrees with the DB.
    (Observed during the manual repair: moving a subtask regenerated the block correctly, so the
    regeneration path itself is sound.)
    **Verified:** `_regenerateFeatureFile` emits
    `` - [ ] [${topic}](../plans/${basename}) — **${column}** `` per subtask, sourced from
    `getSubtasksByFeatureId` at call time, and in `createFeatureFromPlanIds` it runs at `:13406`
    — immediately after the project propagate. Inserting the column propagate at the same point
    as the project propagate therefore satisfies the ordering requirement automatically.
11. **Idempotency.** Re-running creation or reconcile over an already-uniform feature performs
    no writes and logs nothing. This matters because `reconcile-features.js` is documented as
    safe to retry.
12. **The reconcile batch can half-apply on a refusal (new).** The reconcile loop **hard-returns**
    when `createFeatureFromPlanIds` fails (`KanbanProvider.ts:13744-13746`:
    `return { success: false, error: …, mutations, warnings }`) *after* earlier features in the
    same batch have already been created. A change-1 refusal raised inside reconcile therefore
    aborts a **partially applied** converge, leaving the board in a state neither the caller nor
    the user asked for. Reconcile must catch the refusal, convert it to a `warnings[]` entry plus
    a skip, and continue. This is a behaviour decision the plan owns, not an implementation
    detail to discover mid-change.
13. **Demotion erases the only record that plan review happened (new, accepted consequence).**
    A plan's kanban column is currently the sole evidence it passed plan review — nothing else
    records the fact. `improve-feature` never reads a column (its only column logic moves
    **newly created** cards to PLAN REVIEWED; *"In-place rewrites keep their existing column"*),
    and the dispatch path does not filter either: `getSubtasksByFeatureId` is
    `WHERE feature_id = ? AND status = 'active'` — parentage plus archival status, no column
    predicate. So after a normalising creation, dragging the feature to PLAN REVIEWED re-runs
    `improve-feature` over the whole set including plans that were already deeply refined, and
    that skill is **authorised to cut** ("merge overlapping plans, delete superseded ones,
    rewrite contradictory ones") with no per-run gate.
    **This hazard is pre-existing, not created here** — dragging any feature to PLAN REVIEWED
    twice today does the same thing. Normalisation raises its *frequency*. It is recorded as an
    accepted consequence of this plan and as the case for a **separate follow-up plan**
    (persist the review fact outside the column, e.g. a nullable `plan_reviewed_at` field, and
    teach `improve-feature` to consistency-pass a stamped subtask instead of re-authoring it).
    It is deliberately **not** in this plan's scope.
14. **The manual subtask drag re-mixes silently (new).** See *Known non-goal* in the Goal
    section. Not fixed here; must be stated in the change-4 and change-5 skill notes so the
    skills do not over-claim an invariant the system does not maintain.

### Dependencies & Conflicts

- **`recomputeFeatureColumnFromSubtasks` must keep its `if (current !== 'CREATED') return;`
  guard** when adopting the shared helper (see "fourth resolution site" above).
- **`verbSchemas.ts:193`** notes `name` is required for `createFeature` because
  `createFeatureFromPlanIds` rejects an empty name. Adding a refusal branch does not change the
  schema, but the new failure must be returned as `{ success: false, error }` in the HTTP body
  per PRD contract #4 — which this function's existing return shape already supports. Do not
  throw.
- **PRD contract #6 (capability-gating honesty).** The refusal is a real, reported failure, not
  a silent no-op and not a warn-then-create-anyway. Return the error.
- No cross-plan dependency on other in-flight work was found.

## Dependencies

- None. No prior session's output is required to start this work.

## Adversarial Synthesis

**Risk Summary.** The mechanical fix is small and safe — the atomic primitive
(`cascadeFeatureByPlanId`) already exists and is the same one a board drag uses — but three of
the plan's stated justifications were verified wrong (`moveCardToColumn` does not dispatch;
`_buildSuggestFeaturesPrompt` passes a path, not the skill body; subtask status is not synced
outbound), and an implementer trusting them would hand-roll an unnecessary non-atomic loop,
write an unpassable verification step, and leave the external tracker permanently stale. The
larger risk is scope framing: the goal reads as a system invariant while the changes close only
the automated doors, so every listed check can pass with mixed features still appearing on the
board. **Mitigations:** use `cascadeFeatureByPlanId` guarded by a pre-computed diff (idempotent,
one transaction, column-validated); fan out `queueIntegrationSyncForPlanFile` per demoted
subtask; narrow the goal to the automated entry points and document the manual-drag door as a
deliberate non-goal; convert the reconcile-path refusal into skip-and-warn so a batch converge
cannot half-apply; and record the review-provenance loss as an accepted consequence with a named
follow-up rather than leaving it unstated.

## Proposed Changes

### 1. `src/services/KanbanProvider.ts` — propagate the resolved column to every subtask

**Context.** `createFeatureFromPlanIds` derives `effectiveColumn` at `:13295` and writes it to
the feature row only. The `project` propagate at `:13394-13405` is the shape to mirror — same
function, same direction flip, same invariant, already commented.

**Logic.** Insert immediately **after** the project propagate and **before**
`_regenerateFeatureFile` (`:13406`). Refuse the creation outright if some — but not all —
subtasks are at or beyond the first coding column; otherwise, if any subtask's column differs
from `effectiveColumn`, write the whole set through the existing atomic cascade, log each
demotion by name, and fan out integration sync for the changed subtasks only.

> **Superseded:** a hand-rolled per-subtask loop calling
> `await db.updatePlanColumn(st.planId || st.sessionId, effectiveColumn)`.
> **Reason:** Two problems. (a) `db.updatePlanColumn` **does not exist**. The real column-write
> API is `updateColumnByPlanFile(planFile, workspaceId, column)`,
> `updateColumnWithReason(sessionId, column)` — which is marked **`@deprecated`** and resolves
> via `getPlanBySessionId`, so it silently no-ops for file-imported plans whose `session_id` is
> `''`, which is exactly what these subtasks are — and `cascadeFeatureByPlanId(featurePlanId,
> column)`. Naming a non-existent method invites an implementer to reach for the deprecated
> session-keyed one and ship a silent no-op that passes review because the code "looks right".
> (b) Even with a correct method, a per-row loop is N writes with no transaction and no
> column-name validation, where `cascadeFeatureByPlanId` is one `BEGIN`/`COMMIT`, one
> `_persist()`, and validates the column — and its `status='active'` subtask filter is
> byte-identical to `getSubtasksByFeatureId`'s, so it selects exactly the set
> `_regenerateFeatureFile` will render.
> **Replaced with:** the guarded single-cascade form below.

```ts
// One feature = one column, enforced the same way one feature = one project is
// enforced eleven lines above. effectiveColumn is DERIVED from the subtasks (the
// earliest in board order); this writes it BACK so the set cannot straddle the
// plan-review boundary. Without it, a feature card landed in CREATED holding a
// PLAN REVIEWED child: the card misrepresented its contents, and dragging the
// feature to a coder column cascaded the CREATED subtask straight past plan
// review into coding.
//
// Earliest-wins is the only safe direction. Demoting a plan to a column it has
// already passed asserts nothing; promoting an unreviewed plan to PLAN REVIEWED
// asserts a review that never happened. Do NOT "simplify" this to latest-wins.
//
// NOTE: no column-write path in this codebase dispatches. moveCardToColumn* does
// move + integration-sync + feature-file regen only; dispatch is a separate step
// the drag-drop arms (triggerAction / triggerBatchAction / promptOnDrop) perform
// AFTER the move. cascadeFeatureByPlanId is used here for atomicity and column
// validation, not to dodge a dispatch that does not exist.
if (subtasks.length > 0) {
    const firstCodingOrdinal = /* min ordinal over coding columns in columnDefs — see below */;
    const tooFarAlong = subtasks.filter(st => {
        const col = this._normalizeLegacyKanbanColumn(st.kanbanColumn);
        return col !== null && (ordinalMap.get(col) ?? Infinity) >= firstCodingOrdinal;
    });
    if (tooFarAlong.length > 0 && tooFarAlong.length < subtasks.length) {
        // Refuse rather than normalise: demoting CODE REVIEWED work back to CREATED
        // discards real progress. This is a bad grouping, not a state to repair.
        // Returned in-body per PRD contract #4 — never thrown.
        return {
            success: false,
            error: `Cannot create a feature mixing in-progress work with unstarted plans. `
                 + `These subtasks are already past planning: `
                 + tooFarAlong.map(st => `"${st.topic}" (${st.kanbanColumn})`).join(', ')
                 + `. Group them separately, or move them back first.`
        };
    }

    // Compute the differing set BEFORE writing. cascadeFeatureByPlanId bumps
    // updated_at on every matched row unconditionally, so the "already uniform =>
    // zero writes" guarantee has to live here; it cannot be delegated downward.
    const demoted = subtasks
        .filter(st => (this._normalizeLegacyKanbanColumn(st.kanbanColumn) || 'CREATED') !== effectiveColumn)
        .map(st => ({ planFile: st.planFile, label: `"${st.topic}" ${st.kanbanColumn} -> ${effectiveColumn}` }));

    if (demoted.length > 0) {
        const ok = await db.cascadeFeatureByPlanId(effectiveFeaturePlanId, effectiveColumn);
        if (!ok) {
            console.warn(`[KanbanProvider] createFeatureFromPlanIds: column normalisation cascade `
                       + `failed for feature ${effectiveFeaturePlanId}; subtasks may straddle columns.`);
        } else {
            // Say what moved and why. A plan losing PLAN REVIEWED is intended here, but
            // it is invisible afterwards without this line.
            console.log(`[KanbanProvider] createFeatureFromPlanIds: normalised ${demoted.length} `
                      + `subtask column(s) to ${effectiveColumn} so the feature advances as one `
                      + `unit: ${demoted.map(d => d.label).join('; ')}`);
            // Outbound parity: _syncFeatureOutbound below syncs only the FEATURE's state
            // and re-parents children — it never writes a child's status. Without this
            // fan-out the tracker keeps the pre-normalisation subtask status forever.
            // Same call moveCardToColumnByPlanFileWithReason makes for a normal move.
            await Promise.allSettled(
                demoted.map(d => this.queueIntegrationSyncForPlanFile(workspaceRoot, d.planFile, effectiveColumn))
            );
        }
    }
}
```

**Resolving `firstCodingOrdinal`.** Derive it from `columnDefs`, never a hardcoded list —
custom agent columns are coding columns too. The built-in defs in `src/services/agentConfig.ts`
carry a `kind` discriminator (`'created' | 'review' | 'coded' | 'reviewed' | 'completed'`, plus
`'custom-user'`), and every dispatching column also carries a `role`. Take the minimum ordinal
over defs whose `kind` is `'coded'` / `'reviewed'` / `'completed'`, unioned with any custom
column declaring a coding role. Fall back to `Infinity` (refuse nothing) when that set is empty,
so an unrecognised column layout degrades to today's behaviour rather than refusing every
creation.

**Edge Cases.** No-op when already uniform — zero writes, zero log lines, zero sync calls (edge
cases 1 and 11). Loop is inside the `subtasks.length > 0` guard (edge case 2). Uses
`effectiveColumn`, never `resolvedColumn`, so a BACKLOG member cannot strand subtasks below the
feature card (edge case 3). Placed after the project propagate and before
`_regenerateFeatureFile`, so the feature file records post-normalisation columns (edge case 10).
The refusal fires only on a **mix** — an all-post-coding set is created normally (edge case 4).

### 2. `src/services/KanbanProvider.ts` — same normalisation on the assignment path

Apply the identical resolution and refusal in the batch-assign path used by
`assign-to-feature.js` / `POST /kanban/feature/assign`. Extract the resolution into one private
helper so creation, assignment and split cannot drift apart.

> **Superseded:** "an assigned plan later than the feature is demoted to the feature's column;
> an assigned plan earlier than the feature demotes the **feature and all its existing
> subtasks** to the earlier column, because the same earliest-wins rule applies to the enlarged
> set."
> **Reason:** Earliest-wins is correct at *creation*, where every member is unstarted and a
> demotion costs nothing. Applied to *assignment* it destroys finished work, and it contradicts
> this plan's own edge case 4. The live board proves it: `Tickets Panel Extraction` holds four
> CODE REVIEWED subtasks (created 2026-08-02) and two CREATED ones added a day later. Under the
> superseded rule, assigning those two would have demoted four completed plans back to CREATED
> — silently discarding a coding pass and a code review. The rule was written from the creation
> case and never re-tested against the assignment case.
> **Replaced with:** **a feature that has advanced past the incoming plan's column does not
> accept it. Refuse.** Two arms, and the boundary is the plan-review line:
>
> - **Feature is past PLAN REVIEWED** (any coding column or later) → **refuse the assignment,
>   and redirect it.** Once a feature is in flight its composition is frozen. But refusing
>   alone is a dead end: the work that triggered the assignment is usually *real* — a reviewer
>   finding follow-up work while reviewing the feature is the expected outcome of a review, not
>   an error. So the refusal must carry the sanctioned alternative, and change 6 wires it:
>   the plan lands in a **follow-up feature at CREATED** (`<feature name> — Follow-ups`,
>   created on demand), or as a standalone plan. Return
>   `{ success: false, assigned: [], skipped: [], error, suggestedFeature }` where the error
>   names the feature's column and `suggestedFeature` is the follow-up feature to use instead.
>   Do not demote, and do not attach-and-warn.
> - **Feature is still pre-coding** (CREATED or PLAN REVIEWED) → normalise by earliest-wins:
>   a later plan demotes to the feature's column; an earlier plan demotes the feature and its
>   existing subtasks. Both are safe because nothing in the set has been coded, and the whole
>   set then takes one plan-review pass together.
>
> This is simpler than a directional matrix and it is the actual rule: *never add a card to a
> feature that has advanced beyond it.* Every divergence on the live board is one violation of
> it — and note the violation is **not** confined to coded features. A board-wide scan
> classifying every feature by direction returned three, all of them subtasks lagging their
> feature, at two different stages:
>
> ```
> feature[CODE REVIEWED]  | 6 subtasks CREATED–CODE REVIEWED       | Tickets Panel Extraction
> feature[CODE REVIEWED]  | 7 subtasks PLAN REVIEWED–CODE REVIEWED | Connections — External AI Surfaces
> feature[PLAN REVIEWED]  | 6 subtasks CREATED–PLAN REVIEWED       | Defects the Parity Audits Could Not See
> ```
>
> Zero features hold a subtask *ahead* of themselves, which rules out a dragged subtask or a
> partial forward cascade and leaves exactly one mechanism: a plan authored later and attached
> to a feature that had already moved on. `Defects` is the proof that the pre-coding case is
> real and not a rounding error — its five original subtasks were authored and reviewed
> together on 2026-08-10, and a sixth was written on 2026-08-14 and attached to the
> already-reviewed feature. `improve-feature` never saw it; there was nothing to skip, because
> it did not exist when the feature was reviewed.

**Concrete shape.** `assignPlansToFeature` already ends its `assigned.length > 0` branch with
`_regenerateFeatureFile` → `_refreshBoard` → `_syncFeatureOutbound`. Insert the normalisation
immediately before `_regenerateFeatureFile`:

1. Build the enlarged column set = `feature.kanbanColumn` ∪ existing subtask columns
   (`getSubtasksByFeatureId(feature.planId)`) ∪ newly-assigned subtask columns.
2. Resolve `effectiveColumn` via the shared helper.
3. Apply the refusal — but note the assignment loop writes as it goes
   (`updateFeatureStatus` and `setProjectForPlansInvariant` run per plan **inside** the loop).
   Put the check **before** the loop so nothing is written when it fires, and return
   `{ success: false, assigned: [], skipped: [], error }`. The condition is a single ordinal
   comparison: **the feature is past PLAN REVIEWED** → refuse, whatever the incoming plan's
   column. No exception for an incoming plan that happens to match — a feature in flight does
   not grow.
4. Otherwise, if anything differs from `effectiveColumn`, call
   `db.cascadeFeatureByPlanId(feature.planId, effectiveColumn)` — one call covers the
   demote-the-feature-and-all-its-existing-subtasks case that a per-plan loop would miss.
   By this point the refusals have already excluded every case where that cascade would move
   coded work backwards, so the cascade only ever runs over a pre-coding set.
5. Fan out `queueIntegrationSyncForPlanFile` for the changed rows only.

**The shared helper.**
`private async _resolveFeatureColumn(workspaceRoot: string, columns: Array<string | null | undefined>): Promise<string>`
— builds `columnDefs` + `ordinalMap` (including the `BACKLOG → -1` special case), sorts by
ordinal, applies the `BACKLOG → CREATED` remap, returns `effectiveColumn`. Four call sites adopt
it: `createFeatureFromPlanIds`, `assignPlansToFeature`, the change-3 reconcile pass, and
`recomputeFeatureColumnFromSubtasks` (`:6936`).

**Do not move `recomputeFeatureColumnFromSubtasks`' guard into the helper.** Its
`if (current !== 'CREATED') return;` early-return is caller-specific — it exists so subtask
progress never drags an advanced feature backward on feature-file re-import. The helper returns a
column and nothing else; that guard stays at its call site.

**Do not layer this on `feature_lock_columns`.** That existing refusal reads a config whose
default (`'IN PROGRESS,CODE REVIEW,REVIEWED,DONE'`) matches no real built-in column id and is
therefore inert in a default workspace. Leave it in place (legacy keys are never dropped) but
implement the post-coding refusal independently and ordinal-driven.

### 3. One-shot reconcile for features that are already mixed

Existing boards carry mixed features created before this change. Add a normalisation pass that
runs once per workspace on startup (or on the next board refresh), applying the same
earliest-wins rule and logging every demotion. Skip — and log — any feature caught by the
post-coding refusal rule rather than demoting finished work.

**Additions from this pass:**

- Guard the pass with a DB `config` key (e.g. `feature_column_reconcile_v1`) so it runs once and
  is not re-executed on every startup. The `config` table is the blessed home for this kind of
  flag; do not add a state file.
- Use `cascadeFeatureByPlanId` per mixed feature, guarded by the same pre-computed diff, so
  already-uniform features are untouched (edge case 11).
- The pass is a **repair**, not the invariant. Because the manual subtask drag remains open (see
  *Known non-goal*), a one-shot pass will not keep the board clean forever. Log the result count
  so a growing number on later runs is visible rather than silent.
- Fan out `queueIntegrationSyncForPlanFile` for the rows it changes, for the same reason as
  change 1 — otherwise the repair fixes the board and leaves the tracker wrong.

### 4. `.agents/skills/group-into-features/SKILL.md` — propose uniform groups, stop teaching the warning

> **Superseded:** the target file named in this change's heading and used throughout its bullets —
> `.agents/skills/group-into-features/SKILL.md` — and the `:8` line anchor for the doc-error fix.
> **Reason:** that directory no longer exists. Its body was merged into the consolidated
> `manage-features` skill (Create / Create from Plans / Group / Rearrange), and neither
> `.agents/skills/group-into-features` nor `.claude/skills/group-into-features` is present. Every
> edit specified below is unrunnable as written. `_buildSuggestFeaturesPrompt` has already been
> repointed and now emits `${workspaceRoot}/.agents/skills/manage-features/SKILL.md`
> (`src/services/KanbanProvider.ts:15411`), so the board button is current — only this plan's
> target is stale.
> **Replaced with:** the same edits, unchanged in substance, applied to
> `.agents/skills/manage-features/SKILL.md` in its **Group** section:
> - **Step 3 (PROPOSE)** — the ⚠ CROSS-COLUMN warning block is at `:325-336`, running from
>   `**Cross-column warning:**` through `to a coder column.` and stopping before
>   `For each proposed feature, write:`.
> - **Step 5 (EXECUTE)** — the ⚠ Cross-Column Review Note template is at `:378-392`, ending with
>   the sentence stating the note is preserved by `_regenerateFeatureFile`.
> - **The doc error** is at `:274`, not `:8` — the "copies this skill's text with the workspace
>   root injected" claim now sits in the Group section's **When to Use** paragraph. The mirror
>   carries it at `.claude/skills/manage-features/SKILL.md:280`. Locate it by wording, not by line.
>
> The rule this change installs is unaltered: prefer uniform groupings; when a cross-column
> grouping is the genuine capability fit, proceed and state plainly that creation demotes the later
> plans to the earliest member's column, naming which. That decision was re-confirmed on
> 2026-08-24 against the alternative of forbidding a mixed proposal outright; see
> `one-feature-one-column-forbid-mixed-column-grouping.md` (withdrawn) for why the prohibition was
> rejected.

- **Step 3 (PROPOSE):** replace the ⚠ CROSS-COLUMN warning block. New rule: prefer groupings
  whose members share a column. When a cross-column grouping is genuinely the best capability
  fit, state plainly that **creating it will demote the later plans to the earliest member's
  column**, name which plans will be demoted, and let the user approve that with everything
  else. Say it as a consequence of proceeding, not as a chore to do afterwards.
- **Step 5 (EXECUTE):** delete the "⚠ Cross-Column Review Note" template and the instruction to
  write it into the feature file. It documents a state that can no longer exist. Replace with a
  short **Plan Review Status** note recording what was normalised, for the features where a
  demotion actually occurred.
- **New — fix the "When to Use" doc error at `:8`.** The line *"OR by clicking the **Suggest
  Features** board button (which copies this skill's text with the workspace root injected)"* is
  wrong and is the likely source of the same error elsewhere. The button copies a prompt
  containing a **path to this file** plus the candidate-card list; the agent reads the file
  itself. Correct the sentence.
- **New — teach the post-coding refusal.** The agent must know that proposing a group which
  mixes a post-coding plan with an unstarted one will be **rejected by the server**, not
  normalised, so it does not propose a grouping that cannot be created.
- Add to Notes: *one feature = one column at every automated entry point — creation, assignment,
  split and the startup reconcile all enforce it. A deliberate manual drag of a single subtask
  card can still re-mix a feature; that is the operator's escape hatch, not a bug to work around.*

`_buildSuggestFeaturesPrompt` emits this file's **path**, so the board button's clipboard prompt
picks up skill edits at agent-execution time with no separate prompt edit — but confirm the path
in the copied prompt still resolves, do not assume it.

### 5. `.agents/skills/kanban_operations/SKILL.md` — align the sibling guidance

> **Superseded:** the four line anchors in this change, and the two pointers to
> `group-into-features/SKILL.md` that its bullets rely on.
> **Reason:** the file has shifted since this plan was written, and the path those pointers name
> was deleted (see change 4). Current anchors: the `assign-to-feature.js` cross-column warning is
> at `:131-135` (was `:127-131`); the Suggest Features Workflow steps are at `:193` and `:195`
> (was `:189-191`); the declarative `reconcile-features.js` cross-column line is at `:256`
> (was `:252`), under `## Reorganize Features`.
> **Replaced with:** the same four edits at those anchors, plus one addition this change did not
> account for — `:135`, `:193` and `:195` each defer to `group-into-features/SKILL.md` for the
> warning text or the note template. Repoint all three at `.agents/skills/manage-features/SKILL.md`
> (its **Group** section) in the same pass; as written they send a reader to a directory that is
> not there.
>
> The `.claude/` mirror carries the same three dangling pointers at
> `.claude/skills/kanban-operations/SKILL.md:142`, `:200` and `:202`. Change 7 regenerates them and
> both skills are already in `MIRROR_MANIFEST` (`src/services/ClaudeCodeMirrorService.ts:47`), so
> no manifest edit is needed — but note the source-to-target rename: `skills/kanban_operations`
> mirrors to `kanban-operations`.

- Rewrite the `assign-to-feature.js` cross-column warning (`:127-131`) to describe the new
  demote-on-assign behaviour instead of the Replan-afterwards remedy.
- Update the Suggest Features Workflow step 2/4 text (`:189-191`) to match the rewritten
  `group-into-features` flow.
- Update the `reconcile-features.js` cross-column line (`:252`) — it reports a warning about a
  state the server now normalises. Document the **new** semantics from edge case 12: a grouping
  refused for spanning the coding boundary produces a `warnings[]` entry and is **skipped**, and
  the converge continues; it no longer aborts the batch.
- Note under **Create a Feature** that the feature and its subtasks always share a column, and
  that creation refuses a mix spanning the coding boundary.
- **New — same honesty note as change 4.** State that a manual single-subtask move is not
  guarded, so an agent reading board state does not assume the invariant always holds.

### 6. Two writers add subtasks to a feature. Fix each at its own defect.

Adding a subtask to a feature is legitimate in one case and wrong in the other, and the live
board has one of each. They need different fixes and must not be collapsed into one rule.

#### 6a. `improve-feature` does not move every plan it creates (the `Defects` case)

**Context.** During a feature's plan-review pass, the planner may author a *new* subtask — new
scope it discovered while making the set coherent. That is correct and expected: the feature is
pre-coding and is being planned right then. The `Defects` feature shows it happening, with the
new plan created **eight seconds before** the pass advanced its last sibling:

```
23:59:52  sibling -> PLAN REVIEWED
00:01:28  sibling -> PLAN REVIEWED
00:02:54  sibling -> PLAN REVIEWED
00:05:19  sibling -> PLAN REVIEWED
00:19:43  new subtask CREATED + linked to the feature   <- mid-run
00:19:51  sibling -> PLAN REVIEWED
```

Nothing about that is a violation. The single error is that the new plan was left at CREATED
while every sibling went to PLAN REVIEWED, producing a column-mixed feature from an otherwise
correct pass.

**Root cause — the rule enumerates two cases and the third is uncovered.**
`.agents/skills/improve-feature/SKILL.md` states the requirement twice, and the two statements
do not agree in scope:

- `:19-22` — general: *"you MUST move newly created cards to `PLAN REVIEWED`"*.
- `:51` — narrowed: *"you MUST move each **newly created** plan file (merges, splits) to
  `PLAN REVIEWED`"*.

A plan that is neither a merge nor a split — a brand-new subtask added as new scope — is not
named by `:51`, and `:51` is the statement that sits in the restructuring step where the agent
is actually working. An agent that reads the parenthetical as the definition of "newly created"
correctly concludes the rule does not apply to it.

**Logic.** Delete the narrowing. `:51` becomes *"every plan file this pass creates — merged,
split, or newly authored as additional scope — moves to `PLAN REVIEWED`"*, matching `:19-22`.
Keep *"In-place rewrites keep their existing columns"* and *"Do not move deleted plans"*
verbatim; both are correct and neither is implicated.

**Edge Cases.** Do not turn this into "move everything" — an in-place rewrite of an existing
subtask must still keep its column, or a pass over a partly-advanced feature would drag rows
backwards. The rule is about plans the pass *creates*, which by definition have no prior state
to preserve. The change-3 reconcile is the backstop that would have surfaced this without
anyone noticing the wording gap.

#### 6b. New work attached to an in-flight feature (the `Tickets Panel Extraction` case)

**Context.** The other writer, and the genuinely wrong one. A feature already at a coding
column receives a new subtask — from a conversation about the work, or from a review that turned
up something out of scope. Commit `30d82f81` shows it in one write: four subtasks advanced
LEAD CODED -> CODE REVIEWED, two fresh subtasks added at CREATED, `## Review Findings` appended.

**Nobody involved is doing anything wrong.** New work surfacing while a feature is in flight is
the normal output of paying attention, and it must not be suppressed. What is wrong is only the
destination: attached to an in-flight feature, the plan makes the feature card assert something
false — `Tickets Panel Extraction` reads CODE REVIEWED while its dead-code sweep is verifiably
untouched (`grep -c "stub — real impl in tickets.js" src/webview/planning.js` returns **11**,
the exact count that plan predicted for the undone state) — **and** strands the work, because
the feature has passed the planning and dispatch stages and nothing will pick that subtask up.

**Logic.** The actor varies (planner in conversation, reviewer mid-run, an operator), so the
guidance cannot live in any one prompt. Name the destination where every actor passes through:

- **The API is the enforcement point.** `POST /kanban/feature/assign`'s refusal (change 2)
  returns `suggestedFeature` naming `<feature name> — Follow-ups`. An agent taking the old path
  is *routed*, not merely rejected — which is what keeps the finding from being lost. This is
  actor-agnostic by construction and is the load-bearing half.
- **The skills carry the rule**, because they are what an agent reads before acting:
  `kanban_operations` (both the `assign-to-feature.js` and `reconcile-features.js` sections),
  `create-feature-from-plans`, and `group-into-features`. *(Superseded: the latter two are no
  longer separate skills — both are sections of `manage-features` (**Create from Plans** and
  **Group**). The rule goes into those two sections of that one file, so "state it once and
  identically" now means two sections in `manage-features` plus two sections in
  `kanban_operations`, not three files.)* State it once and identically: *work
  that surfaces while a feature is in flight goes to `<feature name> — Follow-ups` at CREATED,
  never onto the feature itself.* With no parent feature, it is a standalone plan at CREATED.
- **Record provenance** in the new plan's body (`Discovered during work on <feature>`), so the
  association survives without the parentage that breaks the board.
- **Add the clause to the reviewer and acceptance/intent branches** (`agentPromptBuilder.ts`
  around `:1440-1560`). Both currently say nothing about creating plans at all — there is no
  rule to violate, which is why the agent improvised. Reinforcement for one known actor, not
  the fix.

**Edge Cases.** Work genuinely *in* scope for the plan under review is still fixed inline — this
is for out-of-scope discoveries only, and must say so, or reviewers will file follow-ups instead
of doing their job. An existing follow-up feature is reused, never duplicated. The follow-up
feature is an ordinary feature and flows normally, which is the whole point. When the actor is a
planner in conversation the operator is right there, so the agent should say where it filed the
plan and why rather than silently redirecting.

### 7. Regenerate the `.claude/` mirrors

Skill discovery is host-split: Claude Code resolves through `MIRROR_MANIFEST`
(`ClaudeCodeMirrorService.ts:167` lists `group-into-features`), Antigravity reads the
filesystem. Edit `.agents/` and regenerate; do not hand-edit the mirror, and do not edit only
one — a stale mirror leaves one host proposing mixed features.

**Corrected mirror inventory (verified against `MIRROR_MANIFEST`).** Two source directories are
touched by changes 4 and 5, and they produce **three** mirrors, because
`skills/kanban_operations` is listed **twice** under two different names:

| `.agents/` source | `.claude/skills/` mirror | manifest line |
| --- | --- | --- |
| `skills/group-into-features` | `group-into-features` | `:167` |
| `skills/kanban_operations` | `kanban-operations` | `:154` |
| `skills/kanban_operations` | `switchboard-kanban` | `:251` |

A regeneration that updates `kanban-operations` but not `switchboard-kanban` leaves a stale copy
under a name the model can still resolve — the failure this change exists to prevent, reproduced
inside a single host.

> **Superseded:** the mirror inventory table above, its three-mirror count, the
> `switchboard-kanban` duplicate hazard, this section's opening `ClaudeCodeMirrorService.ts:167`
> reference, and the `diff against group-into-features` example in the paragraph that follows.
> **Reason:** `MIRROR_MANIFEST` has changed on all three rows. `skills/group-into-features` is
> gone entirely (merged into `manage-features`); `skills/kanban_operations` has moved to `:87`;
> and the second `kanban_operations` entry that produced a `switchboard-kanban` mirror **no longer
> exists** — there is no such manifest row and no `.claude/skills/switchboard-kanban` directory on
> disk. The duplicate-name hazard this section warns about cannot occur, so a verification step
> written to catch it will look for a mirror that is not there and report blocked.
> **Replaced with** — two source directories, **two** mirrors:
>
> | `.agents/` source | `.claude/skills/` mirror | manifest line |
> | --- | --- | --- |
> | `skills/manage-features` | `manage-features` | `:75` |
> | `skills/kanban_operations` | `kanban-operations` | `:87` |
>
> Neither is a move, so no manifest edit is required — regenerate and compare bodies. The
> source-to-target rename `kanban_operations` → `kanban-operations` still holds and is still the
> thing a naive path-equality check gets wrong.

**Mirrors are not byte-identical to their sources.** The generator prepends a YAML frontmatter
block (`name`, `description`, `allowed-tools`, `user-invokable`) and leaves the body verbatim —
`diff` against `group-into-features` today shows exactly `0a1,7` and nothing else. Any
verification must compare **bodies**, not whole files.

## Verification Plan

Session directive: compilation and automated-test execution were **not** run during this
planning pass. The steps below are the acceptance criteria to execute at implementation time.

### Manual Verification

1. **The reported repro.** With plans in CREATED and PLAN REVIEWED, create a feature from one
   of each. Expect: feature card and both subtasks all in CREATED, one log line naming the
   demoted plan and its old column, and no dispatch of any kind.
2. **Uniform creation is a no-op.** Create a feature from four CREATED plans. Expect no column
   writes, no demotion log line, no integration-sync fan-out, and behaviour byte-identical to
   today. Assert each subtask's `updated_at` is unchanged — this is the assertion that the
   pre-computed diff guard exists and `cascadeFeatureByPlanId` was not called unconditionally.
3. **BACKLOG member.** Create a feature from a BACKLOG plan and a PLAN REVIEWED plan. Expect
   everything — card and both subtasks — in CREATED, not BACKLOG. This is the
   `effectiveColumn` vs `resolvedColumn` assertion.
4. **Post-coding refusal.** Attempt to create a feature from a CODE REVIEWED plan and a CREATED
   plan. Expect creation to fail with the error naming the CODE REVIEWED plan, and expect **no**
   feature row, no feature file, and no column change to either plan. Assert the failure arrives
   as `{ success: false, error }` in the HTTP response **body** (PRD contract #4), not as a
   thrown 500.
5. **All-post-coding is allowed.** Create a feature from two CODE REVIEWED plans. Expect
   success — the refusal is about *mixing* across the coding boundary, not about grouping
   finished work.
6. **Assignment into a pre-coding feature normalises.** (a) Assign a PLAN REVIEWED plan to a
   CREATED feature: expect the assigned plan demoted. (b) Assign a BACKLOG plan to a PLAN
   REVIEWED feature: expect the feature and all its existing subtasks demoted to CREATED —
   safe, because nothing in the set has been coded.
7. **Assignment into an in-flight feature is refused, whatever the incoming column.**
   (a) Reproduce `Tickets Panel Extraction` — a CODE REVIEWED feature with four CODE REVIEWED
   subtasks — and assign a CREATED plan. Expect a refusal naming the feature's column, and
   expect all four subtasks to still read CODE REVIEWED. This is the regression test for the
   rule this plan originally got wrong: earliest-wins would have demoted four completed plans.
   (b) Assign a **CODE REVIEWED** plan to that same feature. Expect the same refusal — a
   matching column is not an exemption; a feature in flight does not grow.
   (c) Confirm the refusal payload carries `suggestedFeature` naming
   `Tickets Panel Extraction — Follow-ups`. A refusal with no redirect loses a real finding,
   which is worse than the mixed feature it prevents.
7z. **`improve-feature` moves every plan it creates.** Run a feature plan-review pass that
   authors a brand-new subtask as additional scope — not a merge, not a split. Expect the new
   plan to land in **PLAN REVIEWED** alongside its siblings, and the feature to be column-uniform
   when the pass ends. Reproduce the `Defects` shape first at HEAD to confirm the new plan is
   left at CREATED, so the fix is anchored on observed behaviour. Then re-run the pass over a
   feature with an in-place-rewritten subtask and confirm that subtask **keeps** its column —
   the rule must not widen into "move everything".
7a. **The conversational path — the common one.** In a chat with a planner, discuss a feature
   that is already at a coding column and ask for a new plan covering something it missed.
   Expect the plan to land in `<feature> — Follow-ups` at CREATED with its
   `Discovered during work on …` provenance line, the in-flight feature's subtask set
   **unchanged**, and the agent to say in its reply where it filed the plan and why. Then
   confirm the follow-up feature plans, dispatches and completes like any other — the assertion
   that the work is queued rather than stranded.
7b. **The review path — same destination, different actor.** Run a review over a feature whose
   implementation reveals out-of-scope work. Expect the same outcome as 7a.
7c. **In-scope findings are still fixed inline.** Run a review whose findings are within the
   plan under review. Expect them fixed in place and summarised under `## Review Findings`,
   with **no** follow-up plan created. The clause must not become an escape hatch from doing
   the review's actual job.
7d. **An agent that ignores the guidance is still caught.** Call
   `POST /kanban/feature/assign` directly against an in-flight feature, as an agent following
   none of the updated skills would. Expect the refusal plus `suggestedFeature`. This is the
   assertion that the fix does not depend on any prompt being read.
7. **Assignment refusal is atomic.** Attempt to assign a CODE REVIEWED plan to a CREATED
   feature. Expect the refusal, and expect **no** partial application — the plan must not have
   been re-parented or re-projected. This is the assertion that the refusal check sits *before*
   the assignment loop, not after it.
8. **Split.** Take a legacy mixed feature (construct one directly in the DB), split it. Expect
   both resulting features uniform.
9. **Reconcile pass.** Construct two mixed features in the DB, restart. Expect both normalised
   and both logged; expect a feature mixing post-coding work to be skipped and logged, not
   demoted. Restart a second time and expect the pass to no-op (the `config` guard key).
10. **Reconcile does not half-apply.** Drive `POST /kanban/features/reconcile` with a batch where
    the second of three groups spans the coding boundary. Expect groups 1 and 3 created, group 2
    reported in `warnings[]`, and `ok: true` — not an abort after group 1.
11. **Feature file agrees with the DB.** After a normalising creation, read the feature file's
    auto-generated `## Subtasks` block. Every entry must show the normalised column — proving
    the propagate ran before regeneration.
12. **No dispatch on creation.** Create a normalising feature while watching the terminals
    fleet and the extension log. Expect zero prompts delivered and zero agent terminals
    touched.
13. **Tracker parity.** With real-time sync enabled, create a normalising feature and confirm
    the external issue/task statuses match the normalised local columns, not the pre-creation
    ones. **This is the step that fails today and would still fail without the explicit fan-out**
    — `syncFeatureWithSubtasks` never writes a child's state, so it passes only if the
    `queueIntegrationSyncForPlanFile` calls in changes 1 and 3 are present. Also confirm the
    uniform case fires **zero** sync calls.
14. **Skill round trip.** Press **SUGGEST FEATURES** on the board and inspect the copied prompt.
    Confirm it contains the correct
    `<workspaceRoot>/.agents/skills/manage-features/SKILL.md` path and the candidate-card
    list with each card's column. Then confirm the file at that path no longer contains the
    "⚠ CROSS-COLUMN" / "press Replan afterwards" instructions, and that its Group **When to Use**
    paragraph (`:274`) no longer claims the button copies the skill's text.
    *(Two earlier forms of this step were unrunnable. "Confirm the copied prompt carries the
    rewritten step 3 / step 5 text" — the prompt passes a path, never the skill body. And the path
    it asserted, `group-into-features/SKILL.md`, no longer exists;
    `_buildSuggestFeaturesPrompt` emits `manage-features/SKILL.md` at
    `src/services/KanbanProvider.ts:15411`.)*
15. **All skill copies agree.** Compare each `.agents/` source against its `.claude/` mirror
    **body**, skipping the generated YAML frontmatter block. Cover **both** mirrors from the
    corrected change-7 inventory: `manage-features` and `kanban-operations`.
    *(This step previously said "all three mirrors from the change-6 table" — the table is in
    change 7, not 6, and the third mirror, `switchboard-kanban`, no longer exists.)*
16. **Agent-level replay.** Re-run the grouping task that produced the observed failure (17
    candidates, three of them in PLAN REVIEWED) against the rewritten skill. The proposal must
    either group by column or state the demotion up front; the resulting board must contain no
    feature whose subtasks span two columns.
17. **No confirm gate.** Grep the diff for `confirm(`, `window.confirm`, `showWarningMessage`
    and any two-click pattern. Expect zero hits — the demotion is reported, never confirmed.
18. **The documented non-goal is still true.** After a normalising creation, drag one subtask
    card to PLAN REVIEWED by hand. Expect it to move and the feature to become mixed — this is
    the deliberate escape hatch, and the check exists so a future reader does not file it as a
    regression of this plan.

### Automated Tests

Not executed during this planning pass (session directive: skip tests). The suite to add at
implementation time:

- **`createFeatureFromPlanIds` column normalisation** — unit tests over a seeded in-memory
  `KanbanDatabase`: mixed set normalises to earliest; uniform set performs zero writes (assert
  `updated_at` unchanged on every subtask); BACKLOG member resolves to CREATED for both card and
  subtasks; zero-subtask feature untouched; post-coding mix returns `{ success: false, error }`
  with the offending topics in the message and creates no row.
- **`assignPlansToFeature` normalisation** — earlier assignee demotes the feature and its
  existing subtasks; later assignee is demoted; post-coding assignee is refused **before** any
  parentage or project write lands.
- **Reconcile pass** — normalises pre-existing mixed features, skips post-coding mixes with a
  `warnings[]` entry, continues the batch rather than aborting, and no-ops on a second run.
- **Idempotency** — running creation and the reconcile pass twice over the same uniform feature
  produces no writes and no log output on the second run.
- **Shared-helper drift guard** — a regression test asserting all four resolution sites call
  `_resolveFeatureColumn`, and that `recomputeFeatureColumnFromSubtasks` still contains its
  `current !== 'CREATED'` early-return. Written in the style of the existing
  `src/test/*-regression.test.js` source-pinning tests.
- **Skill-text regression** — assert `.agents/skills/manage-features/SKILL.md` and
  `.agents/skills/kanban_operations/SKILL.md` contain no `CROSS-COLUMN` or `press the **Replan**`
  strings, mirroring how `kanban-coded-auto-batching-regression.test.js` pins prompt text. Assert
  the same for the two `.claude/` mirrors, and additionally that neither source nor mirror contains
  the string `group-into-features` — that path is deleted, and a surviving reference is a dangling
  pointer rather than merely stale prose.
  *(This test named `group-into-features/SKILL.md` as a target file; it does not exist.)*

---

**Recommendation: Send to Coder** (complexity 6).

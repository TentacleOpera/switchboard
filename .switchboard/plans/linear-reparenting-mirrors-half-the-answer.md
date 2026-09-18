# Reparenting an issue in Linear mirrors half the answer, and the half it writes is structurally invalid

## Goal

A card's feature structure can be changed from Linear — promote an issue to a
parent, move a sub-issue out, strip a parent's children. Switchboard mirrors
**one** of those three, and the one it mirrors it writes into a state the board's
own storage rule says cannot exist: `is_feature = 1` on a plan whose file is not
in `.switchboard/features/`. The other two are silently dropped, one of them
behind a log line that claims success.

### Problem analysis

`RemoteControlService._mirrorFeatureStructure` (`:905-937`) is the whole of the
inbound feature-structure path. It is fed by `LinearRemoteProvider.fetchStateDeltas`
(`:109`), whose selection carries `parent { id }` and `children { nodes { id } }`,
and whose delta carries `parentRemoteId` (`:141`) and `isFeatureCandidate`
(`:142`). The delta arrives correctly — a `parentId` change is an issue property
update, so `updatedAt` bumps and the card is in the window. **The read side is
fine. The write side is the defect.**

Three transitions, three outcomes:

1. **A sub-issue is moved out of its parent.** `parentRemoteId === ''` → step 2
   (`:918`) calls `updateFeatureStatus(plan.planId, 0, '')`, clearing `feature_id`.
   The card becomes a standalone plan. **This works.**

2. **An issue becomes a parent** (gains sub-issues). `isFeatureCandidate === true`
   → step 1 (`:911`) calls `updateFeatureStatus(plan.planId, 1, '')`, setting
   `is_feature = 1`. **Nothing moves the file.** The card is now a feature whose
   `plan_file` is still `.switchboard/plans/…`.

   That is not a cosmetic difference. `KanbanDatabase.updateFeatureStatus`'s own
   guard (`:3505-3507`) states the rule: *"A feature file in `.switchboard/features/`
   is structurally a feature. Refuse to clear is_feature for it — callers must
   move the file first (promoteToFeature does this)."* The board agrees with the
   rule today — measured 2026-09-18 against the live board, **113 of 113 active
   `is_feature = 1` rows have a `plan_file` under `.switchboard/features/`, with
   zero exceptions.** This path is the one way to mint the first exception.

   The consequence is not hypothetical. `promoteToFeature`
   (`KanbanProvider.ts:15599-15601`) explains what the location buys: the feature's
   filename ends in its `planId`, and *"the watcher derives plan_id back from this
   trailing UUID"* — which is what makes a subtask's `feature_id` still resolve
   after a re-import. A feature left at `feature_plan_<ts>_<slug>.md` has no id in
   its name, so a re-import mints it a new one and every child's `feature_id`
   dangles.

3. **A parent stops being a parent** (its children are removed or reparented
   away). `isFeatureCandidate` is `false` — and step 1 only ever promotes:
   `if (delta.isFeatureCandidate === true && !plan.isFeature)`. **There is no
   demotion branch at all.** A card that is no longer a parent in Linear stays a
   feature on the board forever.

**And a refusal is logged as a success.** `_mirrorFeatureStructure` ignores
`updateFeatureStatus`'s return value everywhere it calls it. That return is a
four-way `'applied' | 'refused' | 'not_found' | 'error'` (`KanbanDatabase.ts:3453`),
and `'refused'` is reachable from this path: a card whose file **is** in
`.switchboard/features/` — every imported parent, after
`fix(linear-import)` `7acd64d5` — that is then made a sub-issue of another issue
in Linear takes the `:3506` branch, which sets `feature_id` but leaves
`is_feature = 1` and returns `'refused'`. The board then holds a row that is both
a feature and a subtask, and `:923`'s log line says
`Feature mirror: <planId> linked to feature <planId>.` as though it had worked.

This is the quiet-wrong-answer shape CLAUDE.md names: the failure and the success
are the same value at the call site, because the call site never looks.

## Metadata

- **Tags:** backend, database, reliability, bugfix
- **Complexity:** 6
- **Project:** Trackers & Tickets

## User Review Required

One decision, and it does not block the other three fixes — **what a demotion
should do to the file.** Marking `is_feature = 0` on a card whose file sits in
`.switchboard/features/` is refused by `KanbanDatabase` unless the file moves back
to `.switchboard/plans/` first, and a move is destructive in a way promotion is
not: the feature file may carry an auto-generated `<!-- BEGIN SUBTASKS -->` block
and any subtasks still pointing at it are orphaned by the demotion. See
`## Outstanding Questions`. The plan proceeds on the stated assumption that
demotion **does not** move the file and instead surfaces the divergence, which is
reversible and loses nothing; if review decides it should move, that replaces one
branch rather than the design.

## Complexity Audit

### Routine

- Reading `updateFeatureStatus`'s return value and logging the four outcomes
  distinctly. The method already returns them; no new signature.
- The demotion detection itself: `isFeatureCandidate === false && plan.isFeature`
  is the mirror of a condition already written one line above.

### Complex / Risky

- **Promotion has to move a file, and the mirror runs on a poll.** The existing
  move (`promoteToFeature`, `KanbanProvider.ts:15600-15625`) is eight ordered
  steps — DB `plan_file` updated **before** the rename so the watcher's delete
  handler finds no row, `registerPendingCreation` on the new path,
  `registerRename` on the old, rename, then regenerate and refresh — and it lives
  **inline inside the `_handleMessage` switch**, not in a reusable method. It is
  reachable publicly only as `handleServiceVerb('promoteToFeature', …)`
  (`KanbanProvider.ts:10453`), which also calls `_syncFeatureOutbound` — an
  **outbound push to the very tracker the delta just came from**. Calling it from
  the inbound mirror without suppressing that is a feedback loop.
- **`promoteToFeature` refuses a plan that is already a feature** (`:15571`) and
  returns `{ success: false }`. The mirror must not treat that as an error when it
  is simply already in the right state.
- **The planId is not always a UUID.** `_createInitiatedPlan` keys a local plan by
  its **file path** (`TaskViewerProvider.ts`, `planId: planFileRelative`) — four
  such rows exist on the live board today. `promoteToFeature` builds the feature
  filename as `${slug}-${plan.planId}.md`, so promoting one of those produces a
  filename containing path separators. This is pre-existing, and this plan makes
  it reachable from a *remote* trigger rather than only a deliberate click.
- **Ordering against the rest of the poll.** `_mirrorFeatureStructure` is called
  per-delta from the state loop (`:717`), inside the same pass that moves cards
  and can dispatch agents. A file move mid-pass changes `plan_file` under any
  later delta in the same batch that resolved its row earlier.
- **This is shipped state.** `is_feature`/`feature_id` and the `features/`
  directory all exist in released versions, so a demotion or a move touches real
  user data. Per the repo's migration rule, nothing here may assume a prior
  normalisation ran, and no existing row may be rewritten on a guess.

## Edge-Case & Dependency Audit

### Race Conditions

- **The mirror vs. the plan watcher.** A file moved by the mirror while
  `GlobalPlanWatcherService` is scanning produces a delete on the old path and a
  create on the new. `promoteToFeature`'s existing suppression pair
  (`registerPendingCreation` + `registerRename`) is what prevents a duplicate
  card, and any new mover must use both or inherit the bug.
- **The mirror vs. its own next poll.** A promotion that moves a file bumps the
  row's `updated_at`. If that is ever pushed back out, the next inbound delta is
  self-caused. The seed's cursor re-baseline
  (`.switchboard/plans/seed-board-projects-to-linear-projects.md`) is the
  precedent for not replaying your own writes.
- **Two hosts polling one board.** Remote Control has a sync-ownership lease for
  outbound work; the inbound mirror does not check it. Two hosts mirroring the
  same delta both attempt the same move; the second finds the old path gone.

### Security

- No new credential surface: this path reads deltas Remote Control already
  fetches with the stored token.
- A file **move** driven by a remote field is a new class of remote-triggered
  filesystem write. The destination must be constrained to
  `.switchboard/features/` under the workspace root and the filename derived from
  the local `planId` and topic — never from Linear-supplied text, which would let
  an issue title steer a path.

### Side Effects

- Promotion regenerates the feature file's auto-block
  (`_regenerateFeatureFile`), which rewrites file content. For a card imported
  from Linear the body is the issue's imported content; confirm regeneration
  augments rather than replaces it before wiring the mirror to call it.
- A demotion that leaves `is_feature = 1` (the assumption below) means the board
  and Linear disagree, deliberately. That divergence must be visible — a log line
  and a surfaced state, not silence.

### Dependencies & Conflicts

- **`fix(linear-import)` `7acd64d5` is what makes case 3's refusal reachable.**
  Imported parents now land in `.switchboard/features/`; before it, no
  Linear-imported card had a file there, so the `:3506` guard never fired from
  this path. The two changes must be reasoned about together.
- `NotionRemoteProvider` populates `parentRemoteId` too
  (`NotionRemoteProvider.ts:132`), so every fix here applies to the Notion mirror
  unchanged — `_mirrorFeatureStructure` is provider-agnostic and must stay so.
- **Composition root.** `RemoteControlService` and `KanbanProvider` are both
  constructed by `src/standalone/bootstrap.ts`. If the fix needs a mover seam
  handed to `RemoteControlService`, that seam **is** a composition-root wiring and
  its absence and its presence look identical at runtime — the exact trap
  CLAUDE.md documents. Per the cutover, wire standalone only; the extension is out
  of scope.

## Dependencies

No `sess_` session dependencies. File dependencies in this repo:

- `src/services/RemoteControlService.ts` — `_mirrorFeatureStructure`, the subject.
- `src/services/KanbanProvider.ts` — `promoteToFeature`, the only existing correct
  file move; currently inline in `_handleMessage`.
- `src/services/KanbanDatabase.ts` — `updateFeatureStatus` and its structural
  guard; the four-way return this plan starts reading.
- `7acd64d5` `fix(linear-import)` — already landed; makes case 3 reachable.

## Adversarial Synthesis

**Key risks:** (1) the fix's centre of gravity is a **file move driven by a remote
field**, and the only correct mover is eight ordered steps buried inline in a
webview switch whose public entry also pushes outbound — extracting it wrong
reintroduces duplicate cards or a sync loop; (2) promotion-without-a-move is
already writing rows the storage layer calls invalid, so there may be existing
rows to reconcile, and per the repo's migration rule they must be migrated, not
assumed absent; (3) demotion has no safe automatic answer, because the reverse
move orphans subtasks and rewrites a file. **Mitigations:** extract
`promoteToFeature`'s move into a public method on `KanbanProvider` that takes an
explicit `suppressOutboundSync` flag, call that from the mirror, and leave the
webview verb calling the same method so one implementation serves both; make
demotion non-destructive (record and surface, do not move) under the stated
assumption; and read `updateFeatureStatus`'s return at every call site so a
refusal can never again be logged as a link.

## Proposed Changes

### `src/services/KanbanProvider.ts` — one mover, two callers

**Context.** The move lives inline at `:15600-15625` inside the
`promoteToFeature` arm of `_handleMessage`. Its public entry, `handleServiceVerb`
(`:10453`), also runs `_regenerateFeatureFile`, `_refreshBoard` and
`_syncFeatureOutbound`. The last is an outbound push and must not run when the
trigger was an inbound delta.

**Logic.** Extract the ordered move into
`public async promotePlanToFeature(workspaceRoot, planId, options?: { suppressOutboundSync?: boolean; name?: string })`.
The existing verb arm calls it with outbound sync on; the mirror calls it with
`suppressOutboundSync: true`.

**Implementation.**
- Move the body verbatim — DB `plan_file` before rename, `updateFeatureStatus`,
  `registerPendingCreation` + `registerRename`, rename with the existing revert on
  failure, regenerate, refresh. Do not re-derive the ordering; it encodes two
  separate watcher bugs.
- Return a discriminated result — `'promoted' | 'already-feature' | 'failed'` —
  so "already a feature" is not reported as an error.
- Keep the `is_feature` set inside the mover, so the DB write and the file move
  cannot be performed by different callers in different orders.

**Edge cases.** A plan whose `planId` contains a path separator must **fail
loudly** rather than build a filename from it. That is the four live rows named
above; a silent `${slug}-${planId}.md` there writes a nested path.

### `src/services/RemoteControlService.ts` — `_mirrorFeatureStructure`

**Context.** `:905-937`, called per-delta from `:717`.

**Logic.** Four changes, in order of independence:

1. **Read every return.** Each `updateFeatureStatus` call gets its outcome logged
   with its own wording. `'refused'` and `'not_found'` must never produce the
   current past-tense success line.
2. **Promotion moves the file.** When `isFeatureCandidate === true && !plan.isFeature`,
   call `promotePlanToFeature(..., { suppressOutboundSync: true })` instead of
   `updateFeatureStatus(plan.planId, 1, '')`.
3. **Demotion is detected and surfaced, not silently dropped.** When
   `isFeatureCandidate === false && plan.isFeature`, log that the remote no longer
   considers this card a parent, and record the divergence. Per the assumption
   below, do **not** move the file back.
4. **A card cannot be both.** When a card whose file is in `.switchboard/features/`
   is given a parent remotely, the `:3506` branch sets `feature_id` and refuses
   the `is_feature` clear. Detect that outcome explicitly and log it as the
   unresolved state it is.

**Edge cases.**
- A delta for a card with no local row is already handled (`:934`) and stays so.
- `parentPlan.planId === plan.planId` (self-parent) is guarded today (`:926`);
  keep it.
- The mirror must stay provider-agnostic — Notion feeds the same fields.

### `src/services/KanbanDatabase.ts` — no schema change

**Context.** `updateFeatureStatus` already returns the four outcomes and already
guards the structural rule. Nothing here is wrong.

**Logic.** No change. This section exists to record the decision: the fix is at
the **call sites that ignore the return**, not in the storage layer. Widening the
guard to allow `is_feature = 1` outside `features/` would delete the invariant
rather than honour it.

### `src/standalone/bootstrap.ts` — composition root

**Logic.** `RemoteControlService` needs to reach `KanbanProvider.promotePlanToFeature`.
If that arrives as a callback or service seam rather than an existing reference,
it is a composition-root wiring whose absence is invisible at runtime — verify by
diffing what the standalone root hands `RemoteControlService` today.

**Scope.** Standalone only. The extension is not wired for this and that is the
intended state, not a divergence.

## Verification Plan

### Automated Tests

1. An issue that gains sub-issues remotely produces a local card with
   `is_feature = 1` **and** a `plan_file` under `.switchboard/features/` — both
   halves asserted, since the row alone is the bug.
2. That promoted feature's filename ends in its `planId`, and the `planId` is not
   a file path.
3. Promotion triggered by the mirror performs **no** outbound push — assert the
   provider's push/sync surface is not called during the mirror pass.
4. A sub-issue moved out of its parent remotely clears `feature_id` and leaves
   `is_feature` untouched (today's working case — a regression guard).
5. A card whose file is in `.switchboard/features/` that is given a parent
   remotely is reported as the unresolved feature-and-subtask state, and the log
   does **not** claim the link was applied.
6. A parent that loses all its children remotely is detected and surfaced; the
   card's file is not moved (the stated assumption — change this test when the
   assumption is decided otherwise).
7. `updateFeatureStatus` returning `'not_found'` or `'error'` is logged as such,
   distinctly from `'applied'`.
8. A plan whose `planId` contains `/` fails promotion loudly and writes no file.
9. The Notion provider's deltas drive the identical behaviour — the mirror is not
   Linear-specific.

### Goal Invariants

- `grep -n "updateFeatureStatus" src/services/RemoteControlService.ts` — every hit
  assigns the result; a bare `await db.updateFeatureStatus(` with no binding is
  the defect this plan exists to remove.
- `_mirrorFeatureStructure` contains a branch on `isFeatureCandidate === false`;
  zero occurrences means demotion is still silently dropped.
- The promotion arm of `_mirrorFeatureStructure` resolves to
  `promotePlanToFeature`, and `grep -c "updateFeatureStatus(plan.planId, 1, '')"`
  in that file is **0** — a bare mark with no move is the invalid-row bug.
- `KanbanProvider` exposes exactly one public method performing the features/
  rename, and the `promoteToFeature` verb arm calls it (paired positive: one
  implementation, two callers) — a second inline `fs.promises.rename` into
  `.switchboard/features/` is a divergence.
- A query for `is_feature = 1 AND plan_file NOT LIKE '.switchboard/features/%'`
  returns **0** rows after the mirror has run in the test fixtures. This is the
  measured live invariant (113/113 on 2026-09-18) and is the single clearest
  statement of what "correct" means here.
- `src/extension.ts` contains zero references to the new mover (paired positive:
  `src/standalone/bootstrap.ts` resolves it).

## Outstanding Questions

- **[user]** When Linear says a card is no longer a parent, should Switchboard
  move its file back out of `.switchboard/features/` and clear `is_feature`, or
  keep the local feature and surface the divergence? *Proceeding on the assumption
  that it keeps the feature and surfaces the divergence:* the reverse move orphans
  any subtasks still pointing at it, rewrites a file whose auto-block Switchboard
  generated, and is the one transition here that destroys local structure on a
  remote edit — while keeping it costs nothing but a disagreement the operator can
  see and resolve. If the answer is "move it back", that replaces the demotion
  branch and adds a reverse mover; the rest of this plan is unchanged.
- **[user]** Should the inbound mirror respect the sync-ownership lease? It does
  not today, so two hosts polling one board both attempt the same move.
  *Proceeding on the assumption that it should not:* on the Pi appliance there is
  one host, and requiring the lease would stop the only machine that can mirror if
  a stale lease is held — the same reasoning the seed plan records. Log the lease
  holder when a move is performed so a surprise is diagnosable.

---

**Recommendation: Send to Coder.** (Complexity 6.)

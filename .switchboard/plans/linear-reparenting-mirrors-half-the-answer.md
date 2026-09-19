# Reparenting an issue in Linear mirrors half the answer, and the half it writes is structurally invalid

## Goal

A card's feature structure can be changed from Linear — promote an issue to a
parent, move a sub-issue out, strip a parent's children. Switchboard mirrors
**one** of those three, and the one it mirrors it writes into a state the board's
own storage rule says cannot exist: `is_feature = 1` on a plan whose file is not
in `.switchboard/features/`. The other two are silently dropped, one of them
behind a log line that claims success.

### Problem analysis

`RemoteControlService._mirrorFeatureStructure` (`:904-938`) is the whole of the
inbound feature-structure path. It is fed by `LinearRemoteProvider.fetchStateDeltas`
(`:109`), whose selection carries `parent { id }` and `children { nodes { id } }`,
and whose delta carries `parentRemoteId` (`:141`) and `isFeatureCandidate`
(`:142`). The delta arrives correctly for the card whose own `parentId` changed —
that is an issue property update, so its `updatedAt` bumps and the card is in the
window. (Whether the *parent's* `updatedAt` bumps when it gains or loses a child
is asserted for the child's side only — see `## Uncertain Assumptions`. The
write-side fixes below are correct either way.) **The write side is the defect.**

Three transitions, three outcomes:

1. **A sub-issue is moved out of its parent.** `parentRemoteId === ''` → step 2
   (`:921`) calls `updateFeatureStatus(plan.planId, 0, '')`, clearing `feature_id`.
   The card becomes a standalone plan. **This works.**

2. **An issue becomes a parent** (gains sub-issues). `isFeatureCandidate === true`
   → step 1 (`:912`) calls `updateFeatureStatus(plan.planId, 1, '')`, setting
   `is_feature = 1`. **Nothing moves the file.** The card is now a feature whose
   `plan_file` is still `.switchboard/plans/…`.

   That is not a cosmetic difference. `KanbanDatabase.updateFeatureStatus`'s own
   guard (`:3510-3529`) states the rule: *"A feature file in `.switchboard/features/`
   is structurally a feature. Refuse to clear is_feature for it — callers must
   move the file first (promoteToFeature does this)."* The board agreed with the
   rule when first measured — 2026-09-18, 113 of 113 active `is_feature = 1` rows
   had a `plan_file` under `.switchboard/features/`. **Re-measured 2026-09-20:
   147 feature rows, and the first exception now exists** —
   `plan_id 946b24db-8b67-4d10-ad5d-a2d5067d6b9a` ("Standalone Board Parity",
   PLAN REVIEWED) has `is_feature = 1` on
   `.switchboard/plans/standalone-board-parity-946b24db-….md`. The row has no
   `linear_issue_id`/`notion_page_id`, so the mirror will never see it — only an
   explicit reconcile heals it (see `## Proposed Changes`).

   The consequence is not hypothetical. `promoteToFeature`
   (`KanbanProvider.ts:16204-16213`) explains what the location buys: the feature's
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
in Linear takes the `:3513` branch, which sets `feature_id` but leaves
`is_feature = 1` and returns `'refused'`. The board then holds a row that is both
a feature and a subtask, and `:930`'s log line says
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
  move (`promoteToFeature`, `KanbanProvider.ts:16204-16238`) is eight ordered
  steps — DB `plan_file` updated **before** the rename so the watcher's delete
  handler finds no row, `registerPendingCreation` on the new path,
  `registerRename` on the old, rename, then regenerate and refresh — and it lives
  **inline inside the `_handleMessage` switch** (`:16166-16240`), not in a
  reusable method. It is reachable publicly only as
  `handleServiceVerb('promoteToFeature', …)` (`KanbanProvider.ts:10994`, which
  delegates into `_handleMessage` at `:11025`), which also calls
  `_syncFeatureOutbound` (`:16238`) — an **outbound push to the very tracker the
  delta just came from**. Calling it from the inbound mirror without suppressing
  that is a feedback loop.
- **`promoteToFeature` refuses a plan that is already a feature** (`:16177-16180`)
  and returns `{ success: false }` **with a `showWarningMessage` toast**. The
  mirror must not treat that as an error when it is simply already in the right
  state — and the extracted method must not emit UI toasts at all; they belong to
  the verb arm.
- **The planId is not always a UUID.** `_createInitiatedPlan` keys a local plan by
  its **file path** (`TaskViewerProvider.ts:24597`, `planId: planFileRelative`) —
  four such rows existed on the live board at the first measurement; re-measured
  2026-09-20 there are **zero**, but the code path still produces them.
  `promoteToFeature` builds the feature filename as `${slug}-${plan.planId}.md`,
  so promoting one of those produces a filename containing path separators. This
  is pre-existing, and this plan makes it reachable from a *remote* trigger rather
  than only a deliberate click.
- **Ordering against the rest of the poll.** `_mirrorFeatureStructure` is called
  per-delta from the state loop (`:717`), inside the same pass that moves cards
  and can dispatch agents. A file move mid-pass changes `plan_file` under any
  later delta in the same batch that resolved its row earlier — and under the
  **same** delta: the loop hands the pre-move `plan` record to
  `_applyStateMirror` at `:733`, so the record's `planFile` must be refreshed
  after a move.
- **A single delta can mint the both-state through the front door.** A card that
  is a parent *and* a sub-issue (legal in Linear) arrives with
  `isFeatureCandidate === true` **and** a non-empty `parentRemoteId`. Step 1
  promotes it — moving its file into `features/` — then step 2 links it under its
  parent, which hits the `:3513` guard: `feature_id` set, `is_feature` kept,
  `'refused'` returned. One poll, one invalid row, all through legal calls. The
  link call's return must be read in the same pass that just promoted.
- **This is shipped state.** `is_feature`/`feature_id` and the `features/`
  directory all exist in released versions, so a demotion or a move touches real
  user data. Per the repo's migration rule, nothing here may assume a prior
  normalisation ran, and no existing row may be rewritten on a guess.

## Edge-Case & Dependency Audit

### Race Conditions

- **The mirror vs. its own stale record.** After a promotion moves the file, the
  `plan` object the state loop holds still carries the old `planFile`. The same
  iteration passes it to `_applyStateMirror` (`:733`) — refresh or mutate
  `plan.planFile` immediately after the move so nothing downstream acts on a
  ghost path.
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
  `.switchboard/features/` under the workspace root. The filename is
  `${slug}-${planId}.md`: the `planId` is local, and the slug is the *sanitized*
  topic — remote text (a Linear issue title becomes `plan.topic`) reaches the
  filename only after `[^a-z0-9]+ → '-'`, so it can carry no separators or
  traversal. What must never reach the path unsanitized is remote-supplied
  text — the existing slug transform is the whole guard and the mover must not
  bypass it.

### Side Effects

- Promotion regenerates the feature file's auto-block
  (`_regenerateFeatureFile`, `KanbanProvider.ts:17183-17345`). **Confirmed
  2026-09-20: it augments, never replaces** — it splices the SUBTASKS/WORKTREES
  auto-blocks into the existing body, preserves authored content, skips the write
  entirely when the result is byte-identical (`:17340`), and refuses to write a
  bodyless husk (`:17327`). A Linear-imported body survives regeneration intact.
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
- **Composition root.**

> **Superseded:** `RemoteControlService` and `KanbanProvider` are both
> constructed by `src/standalone/bootstrap.ts`; a mover seam handed to
> `RemoteControlService` is a composition-root wiring whose absence is invisible
> at runtime — wire standalone only.
> **Reason:** Verified against the code 2026-09-20 — `RemoteControlService` is
> constructed in exactly **one** place, `KanbanProvider._getRemoteControl`
> (`:3139`), lazily per workspace root. `bootstrap.ts` never references it. A
> `RemoteControlDeps` callback wired at that site is shared code: **both**
> composition roots get it automatically, so there is no cross-root divergence to
> audit and no `bootstrap.ts` change at all. The real trap is narrower — making
> the dep *optional*, where "absent" and "working" are again the same value.
> **Replaced with:** Add `onPromoteToFeature` to `RemoteControlDeps` as a
> **required** dep (the `getColumns` precedent at `RemoteControlService.ts:136-143`
> — required precisely so "absent" cannot look like "working"), wired at
> `_getRemoteControl` to call the extracted `promotePlanToFeature` with
> `suppressOutboundSync: true`. The only other constructor is the test harness
> (`src/test/integrations/shared/remote-control-service.test.js:50`), which gains
> a stub. The mirror must **never** fall back to the mark-only
> `updateFeatureStatus(1, '')` write when the dep is missing or fails — that
> fallback is the bug this plan exists to remove.

## Dependencies

No `sess_` session dependencies. File dependencies in this repo:

- `src/services/RemoteControlService.ts` — `_mirrorFeatureStructure`, the subject.
- `src/services/KanbanProvider.ts` — `promoteToFeature`, the only existing correct
  file move; currently inline in `_handleMessage`.
- `src/services/KanbanDatabase.ts` — `updateFeatureStatus` and its structural
  guard; the four-way return this plan starts reading.
- `src/services/TaskViewerProvider.ts` — the deferred self-heal block
  (`:7234-7240`) the reconcile call rides on, and `_createInitiatedPlan`'s
  path-shaped `planId` (`:24597`).
- `src/test/integrations/shared/remote-control-service.test.js` — the other
  `RemoteControlService` constructor; gains the required-dep stub.
- `7acd64d5` `fix(linear-import)` — already landed; makes case 3 reachable.

## Adversarial Synthesis

**Key risks:** (1) the fix's centre of gravity is a **file move driven by a
remote field**, and the only correct mover is eight ordered steps buried inline
in a webview switch whose public entry also pushes outbound — extracting it
wrong reintroduces duplicate cards or a sync loop; (2) the invalid state is no
longer hypothetical — one `is_feature = 1` row outside `features/` exists on the
live board today with no remote link, so a reconcile pass (not just a fixed
writer) is required; (3) an *optional* mover dep recreates the absent-looks-like-
working trap, so the dep is required and never falls back to the mark-only write;
(4) demotion has no safe automatic answer, because the reverse move orphans
subtasks and rewrites a file; (5) a single delta for a card that is both parent
and sub-issue can mint the invalid row through legal calls. **Mitigations:**
extract `promoteToFeature`'s move into a public `promotePlanToFeature` on
`KanbanProvider` taking `suppressOutboundSync`, with UI toasts kept at the verb
arm; wire it as a required `onPromoteToFeature` dep at `_getRemoteControl`
(shared code — both hosts inherit it); add a startup reconcile over
`is_feature = 1` rows whose `plan_file` is not under `features/`; refresh the
in-memory `plan.planFile` after a move; make demotion non-destructive (record
and surface, do not move) under the stated assumption; and read
`updateFeatureStatus`'s return at every call site so a refusal can never again
be logged as a link.

## Proposed Changes

### `src/services/KanbanProvider.ts` — one mover, two callers, plus reconcile

**Context.** The move lives inline at `:16204-16238` inside the
`promoteToFeature` arm of `_handleMessage` (`:16166-16240`). Its public entry,
`handleServiceVerb` (`:10994`), delegates to `_handleMessage` (`:11025`) and the
arm also runs `_regenerateFeatureFile`, `_refreshBoard` and
`_syncFeatureOutbound` (`:16238`). The last is an outbound push and must not run
when the trigger was an inbound delta. The arm also owns two webview-only
behaviours the shared method must **not** inherit: `showWarningMessage` toasts
(`:16174`, `:16178`) and the custom `name`/H1 rewrite (`:16187-16202`).

**Logic.** Extract the ordered move into
`public async promotePlanToFeature(workspaceRoot, planId, options?: { suppressOutboundSync?: boolean; name?: string })`
returning `Promise<{ outcome: 'promoted' | 'already-feature' | 'moved' | 'failed'; featureFile?: string; error?: string }>`.
The existing verb arm calls it with outbound sync on and maps outcomes to its
toasts; the mirror calls it with `suppressOutboundSync: true` via the dep below.

**Implementation.**
- Move the body verbatim — DB `plan_file` before rename, `updateFeatureStatus`,
  `registerPendingCreation` + `registerRename`, rename with the existing revert on
  failure, `_markConfigDirty`, regenerate, refresh, conditional
  `_syncFeatureOutbound`. Do not re-derive the ordering; it encodes two separate
  watcher bugs.
- The "already a feature" early-return (`:16177-16180`) becomes **three-way**:
  (a) `isFeature` and `planFile` already under `features/` → `'already-feature'`
  no-op; (b) `isFeature` but `planFile` **not** under `features/` → perform the
  move and return `'moved'` — this heals the pre-existing exception row. The
  `is_feature` write is already correct and can be skipped, but the call it
  replaces (`updateFeatureStatus(planId, 1, '')`) also clears `feature_id` — a
  misplaced feature may still carry a link, and `'moved'` must not leave a
  both-state row behind, so the `feature_id` clear still runs; (c) not a
  feature → full promote. A row in state (b) is exactly the invalid state this
  plan exists to eliminate; treating it as "already correct" leaves the bug in
  place.
- Keep the `is_feature` set inside the mover, so the DB write and the file move
  cannot be performed by different callers in different orders.
- The verb arm keeps `showWarningMessage` for `Plan not found.` /
  `Plan is already a feature.` — the shared method returns outcomes only.
- Keep the `name`/H1-rewrite inside the shared method (it is promotion
  semantics); the mirror simply never passes `name`.

**Reconcile existing rows (Clarification — required by this plan's own
invariant).** Add `public async reconcileFeatureFileLocations(workspaceRoot)`:
for every `is_feature = 1` row whose `plan_file` is not under
`.switchboard/features/`, call `promotePlanToFeature` (outcome (b) performs the
move). This is what heals the live `946b24db-…` row: it has no remote link, so
the mirror can never reach it.

> **Superseded:** Invoke it from the deferred-startup self-heal block that
> already calls `regenerateAllFeatureFiles` (`TaskViewerProvider.ts:7234-7240`)
> — "both composition roots construct `TaskViewerProvider` (`bootstrap.ts:1678`),
> so a single call site serves both hosts."
> **Reason:** Verified against the code 2026-09-20 — that block lives inside
> `initializeKanbanDbOnStartup` (`TaskViewerProvider.ts:7175`), whose **only**
> caller in the repo is `extension.ts:1359`. `bootstrap.ts` constructs
> `TaskViewerProvider` but never invokes the method, so on the standalone host —
> the primary host — the self-heal block, and therefore the reconcile, never
> runs. Construction is not invocation: this is the same trap the
> `_getRemoteControl` callout above names, one level up. Worse, the site picked
> would run the heal only in the legacy host this product is removing.
> **Replaced with:** Wire the call in the standalone root — a deferred
> invocation of `kanbanProvider.reconcileFeatureFileLocations(workspaceRoot)`
> in `bootstrap.ts` beside the startup DB-init block (`:1783-1793`), mirroring
> the extension's `setTimeout` pattern so it does not block startup. The shared
> `:7238` block may carry the same call for free (it is shared code, not new
> extension wiring, and the legacy host running the heal is harmless), but the
> **load-bearing call site is `bootstrap.ts`** — the invariant below asserts
> that, not the shared block.

**Edge cases.** A plan whose `planId` contains a path separator (`/` or `\`) or
other filename-unsafe characters must **fail loudly** (`'failed'`, log, no file
write, no DB write) rather than build a filename from it. `planFile` must also
be validated to stay inside `.switchboard/features/` under the workspace root —
the destination derives from local `planId` + local topic slug only, never from
remote-supplied text.

### `src/services/RemoteControlService.ts` — `_mirrorFeatureStructure` + deps

**Context.** `:904-938`, called per-delta from `:717-718`, inside the state loop
whose `plan` record then flows to `_applyStateMirror` at `:733`.

**Deps.** Add to `RemoteControlDeps` (`:129-195`):

```ts
/**
 * Promote a plan to a feature: mark is_feature AND move its file into
 * .switchboard/features/ (the mover is KanbanProvider.promotePlanToFeature,
 * called with suppressOutboundSync — an inbound delta must never trigger an
 * outbound push). REQUIRED, deliberately — see getColumns above: an optional
 * seam here means "absent" and "working" look the same, and the mark-only
 * fallback would recreate the invalid row this fix exists to remove.
 */
onPromoteToFeature: (plan: KanbanPlanRecord) =>
    Promise<{ outcome: 'promoted' | 'already-feature' | 'moved' | 'failed'; featureFile?: string; error?: string }>;
```

Wired at `KanbanProvider._getRemoteControl` (`:3139`) as
`(p) => this.promotePlanToFeature(resolved, p.planId, { suppressOutboundSync: true })`.
One construction site in shared code — both composition roots get the seam with
no bootstrap or extension wiring. The test harness
(`src/test/integrations/shared/remote-control-service.test.js:50`) supplies a
stub; a stub returning `'failed'` is the honest shape.

**Logic.** Changes to `_mirrorFeatureStructure`, in order of independence:

1. **Read every return.** Each `updateFeatureStatus` call gets its outcome logged
   with its own wording. `'refused'` and `'not_found'` must never produce the
   current past-tense success line.
2. **Promotion moves the file.** When `isFeatureCandidate === true`, call
   `this._deps.onPromoteToFeature(plan)`:
   - `!plan.isFeature` → full promotion (outcome `'promoted'`).
   - `plan.isFeature` but `plan.planFile` not under `features/` → outcome
     `'moved'` — the mirror heals a misplaced feature opportunistically on its
     next delta.
   - After any outcome that moved the file, refresh `plan.planFile` in place
     (from the returned `featureFile`) so the same-iteration `_applyStateMirror`
     does not act on a ghost path. A `'failed'` outcome logs loudly and writes
     nothing — **no fallback to `updateFeatureStatus(1, '')`**.
3. **Demotion is detected and surfaced, not silently dropped.** When
   `isFeatureCandidate === false && plan.isFeature`, `_log` that the remote no
   longer considers this card a parent, and surface the divergence on the remote
   issue via `provider.postAgentActivity?.(delta.remoteId, …)` (the existing
   narration seam used at `:710-713`; a no-op on providers without it). Per the
   assumption below, do **not** move the file back.
4. **A card cannot be both.** When a card whose file is in `.switchboard/features/`
   is given a parent remotely, the `:3513` branch sets `feature_id` and refuses
   the `is_feature` clear. Detect that `'refused'` outcome explicitly — including
   when the same delta just promoted the card in step 2 — and log it as the
   unresolved state it is, with a `postAgentActivity` note.

**Edge cases.**
- A delta for a card with no local row is already handled (`:934`) and stays so.
- `parentPlan.planId === plan.planId` (self-parent) is guarded today (`:927`);
  keep it.
- The mirror must stay provider-agnostic — Notion feeds the same fields.

### `src/services/KanbanDatabase.ts` — no schema change

**Context.** `updateFeatureStatus` already returns the four outcomes and already
guards the structural rule. Nothing here is wrong.

**Logic.** No change. This section exists to record the decision: the fix is at
the **call sites that ignore the return**, not in the storage layer. Widening the
guard to allow `is_feature = 1` outside `features/` would delete the invariant
rather than honour it.

### `src/standalone/bootstrap.ts` — one change: the reconcile invocation

> **Superseded:** `RemoteControlService` needs a composition-root wiring in
> `bootstrap.ts` to reach `KanbanProvider.promotePlanToFeature`; verify by
> diffing what the standalone root hands `RemoteControlService` today. Standalone
> only; the extension is out of scope.
> **Reason:** `bootstrap.ts` never constructs `RemoteControlService` — the only
> construction site is `KanbanProvider._getRemoteControl` (`:3139`), shared code
> reached identically from both roots. The dep is wired there once; there is no
> per-root wiring to diverge.
> **Replaced with:** No `bootstrap.ts` change *for the dep*. The seam audit for
> the dep is a single site: the `onPromoteToFeature` dep inside the
> `_getRemoteControl` deps object — present or absent in one place, not two.

The file **does** gain one call: the deferred
`reconcileFeatureFileLocations` invocation in the startup sequence (see the
reconcile section under `KanbanProvider` — the shared `TaskViewerProvider`
self-heal block is extension-only because `bootstrap.ts` never calls
`initializeKanbanDbOnStartup`).

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
10. **Reconcile heals a pre-existing exception row.** Seed a row with
    `is_feature = 1` and `plan_file` under `.switchboard/plans/` (the live
    `946b24db-…` shape, no remote link), run `reconcileFeatureFileLocations`,
    assert the file moved into `features/` with the `planId`-suffixed name and
    the `plans/` query returns 0 rows.
11. **A mirror delta over a misplaced feature heals it.** `isFeatureCandidate`
    true on a card already `is_feature = 1` with a `plans/` file → outcome
    `'moved'`, file under `features/`, no second `is_feature` write needed.
12. **No mark-only fallback.** If `onPromoteToFeature` returns `'failed'`, the
    mirror logs loudly and `is_feature` remains unset — assert zero calls to
    `updateFeatureStatus` in that path.
13. **Post-move record freshness.** After a mirror-driven move, the same-iteration
    `_applyStateMirror` receives a `plan` whose `planFile` is the new path —
    assert no downstream read of the old path.
14. **One delta, both states.** A delta with `isFeatureCandidate === true` and a
    non-empty `parentRemoteId` for a card whose file ends up in `features/`
    produces a logged `'refused'` on the link step — and no success line.

### Goal Invariants

- `grep -n "updateFeatureStatus" src/services/RemoteControlService.ts` — every hit
  assigns the result; a bare `await db.updateFeatureStatus(` with no binding is
  the defect this plan exists to remove.
- `_mirrorFeatureStructure` contains a branch on `isFeatureCandidate === false`;
  zero occurrences means demotion is still silently dropped.
- The promotion arm of `_mirrorFeatureStructure` resolves to
  `onPromoteToFeature`, and `grep -c "updateFeatureStatus(plan.planId, 1, '')"`
  in `RemoteControlService.ts` is **0** — a bare mark with no move is the
  invalid-row bug.
- `KanbanProvider` exposes exactly one public method performing the features/
  rename (`promotePlanToFeature`), and the `promoteToFeature` verb arm calls it
  (paired positive: one implementation, two callers) — a second inline
  `fs.promises.rename` into `.switchboard/features/` is a divergence.
- `RemoteControlDeps` declares `onPromoteToFeature` as **required** (no `?`), and
  `_getRemoteControl`'s deps object supplies it — assert by source grep, since
  its absence and presence are otherwise identical at runtime.
- A query for `is_feature = 1 AND plan_file NOT LIKE '.switchboard/features/%'`
  returns **0** rows after the mirror has run in the test fixtures. This is the
  measured live invariant (113/113 on 2026-09-18; **146/147 with one exception
  on 2026-09-20** — the reconcile step exists precisely to restore it) and is
  the single clearest statement of what "correct" means here.
- `reconcileFeatureFileLocations` is invoked from `bootstrap.ts`'s startup
  sequence — the orphan row with no remote link is healed on the standalone
  host without the mirror. Assert by source grep: a call site inside
  `initializeKanbanDbOnStartup` alone does **not** satisfy this invariant —
  standalone never calls that method.

## Uncertain Assumptions

- **Whether Linear bumps a parent issue's `updatedAt` when it gains or loses a
  sub-issue** — **answered 2026-09-20** by Planning-researcher
  (`.switchboard/docs/linear-updatedat-hierarchy-semantics.md`): undocumented,
  and every checkable fact points to **no** — the hierarchy edge lives on the
  child (`parentId` on `IssueUpdateInput`), the parent has no child-derived
  stored field and gains no history row, and `updatedAt` is already known to
  skip state changes (archival does not move it). Verdict: ~80% the parent's
  timestamp does not move, and even if it did, relying on an undocumented bump
  is unsafe. The residual 20% is resolvable only by the empirical probe in the
  doc's Trade-off section (five minutes, needs an API key).
  **Consequence for this plan:** for **Linear**, the `isFeatureCandidate`
  promotion arm and the new demotion-detection arm are very probably
  unreachable for Linear-initiated hierarchy edits — the parent's row never
  re-enters the `updatedAt > cursor` window. They stay live for **Notion**
  (`isFeatureCandidate` is a real page property, `NotionRemoteProvider.ts:133`,
  so checking it bumps the page's own timestamp) and for any Linear parent
  whose `updatedAt` moves for other reasons. The write-side fixes are
  unchanged and still required — but the reconcile pass and the child-side
  inference follow-up (below) are the *primary* Linear mechanisms, not
  backstops.

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
- **[research — answered]** Does Linear bump a parent issue's `updatedAt` when
  a sub-issue is added or removed? **Very probably not** (~80%, undocumented —
  see `## Uncertain Assumptions` and
  `.switchboard/docs/linear-updatedat-hierarchy-semantics.md`). The read-side
  gap this creates is a follow-up plan, not this one, and the research names
  its shape: **child-side inference** — a child's `parentRemoteId` delta
  already carries "P gained a child" / "P′ lost a child" (the mirror sees the
  parent in `byRemoteId` today, so promoting P opportunistically at link time
  is a small step), with a single confirming read of P′
  (`issue(id) { children(first:1) { nodes { id } } }`, ~2 complexity points)
  to detect "lost its **last** child", plus a **periodic full reconcile** as
  the only mechanism that closes the archive/deletion hole. Widening the
  delta filter to `children: { some: { updatedAt: { gt } } }` was evaluated
  and rejected — it breaks the cursor invariant and buys nothing child-side
  inference doesn't. The empirical probe in the doc settles the residual 20%
  before that follow-up is written.

---

**Recommendation: Send to Coder.** (Complexity 6.)

---

*Improve-pass summary (2026-09-20):* Verified every claim against the live code
and board; updated all drifted line references and re-measured the invariants
(147 feature rows, one live exception — `946b24db-…` — which the mirror can never
reach, so a `reconcileFeatureFileLocations` startup pass was added). Corrected
the composition-root analysis with a superseded callout: `RemoteControlService`
is built only inside `KanbanProvider._getRemoteControl` (:3139), so the new
required `onPromoteToFeature` dep lands in both hosts from one shared site and
`bootstrap.ts` needs no change. Strengthened the spec: three-way mover outcome
(`'moved'` heals misplaced features), no mark-only fallback, post-move record
refresh, demotion surfaced via `postAgentActivity`, and a named single-delta
both-state hazard. Flagged the plan's load-bearing external uncertainty —
whether Linear bumps a parent's `updatedAt` on sub-issue add/remove — as a
`[research]` question and Uncertain Assumptions entry.

*Review pass (2026-09-20, Planning):* Re-verified the new claims against code
and the live board DB. Two corrections folded in: (1) the reconcile call site —
the `:7234-7240` self-heal block sits inside `initializeKanbanDbOnStartup`,
whose only caller is `extension.ts:1359`; `bootstrap.ts` never invokes it, so
the site chosen would have run the heal only in the legacy host. The
load-bearing invocation moves to `bootstrap.ts`'s startup sequence; the
`bootstrap.ts` change section and the goal invariant were updated to match.
(2) The `[research]` question is answered: the parent's `updatedAt` very
probably does not bump on sub-issue add/remove (~80%, undocumented), so the
`isFeatureCandidate`/demotion arms are likely unreachable for Linear-initiated
edits — the Uncertain Assumptions entry and the Outstanding Question now record
the answer and the child-side-inference + periodic-reconcile follow-up shape
(`.switchboard/docs/linear-updatedat-hierarchy-semantics.md`). Also: the `'moved'`
outcome now keeps the `feature_id` clear from the write it replaces (verified the
live `946b24db` row carries none — a misplaced feature with a link must not stay
both-state), and the Security note now states the slug transform is the guard
rather than claiming the topic is never remote-derived. Recommendation
unchanged: Send to Coder (6).

# A completed card is not in flight

## Goal

Make the queue stall watch and the escalation ladder read the completion fact, the
same one `dispatchNextFromQueue` reads. Three predicates in the stall/escalation path
currently treat a completed card as live work: one because it reads the column, two
because they read a dispatch stamp that completion never clears. Delete
`CODING_COLUMNS` from `PlanIngestionEngine.ts` entirely.

### Problem Analysis

**What completion actually writes.** `setCompletedAt` (`KanbanDatabase.ts:3057`) runs one
statement:

```sql
UPDATE plans SET completed_at = ?, updated_at = ? WHERE plan_id = ?
```

It does not touch `status`, `kanban_column`, `dispatched_terminal`, or `dispatched_at`.
The head prompt tells the lead "The card stays where it is." So after a lead posts
completion for a subtask, the row reads: `status='active'`, column still the coding
column, holder still set, `dispatched_at` still set, `completed_at` set. It is still on
`getBoard` (which filters `status='active'`), and it looks — to anything that does not
read `completed_at` — exactly like a card being actively worked.

**Defect 1 — the queue stall watch goes permanently silent.**
`PlanIngestionEngine.ts:1742`:

```js
const inFlight = board.some(p =>
    p && CODING_COLUMNS.has(String(p.kanbanColumn || ''))
    && typeof p.dispatchedTerminal === 'string'
    && p.dispatchedTerminal.length > 0
    && headTeamSet.has(p.dispatchedTerminal)
);
```

No `completed_at`. No `dispatched_at`. A card resting in `LEAD CODED` with a holder
satisfies it forever, and that is where every completed subtask sits. From the team's
first completion onward the sweep takes the `inFlight` branch on every tick: it resets
`nudgeCount`, `lastNudgedAt` and `escalatedAt`, keeps the watch, and continues. It never
nudges and never escalates again. The only backstop for a genuinely stalled queue is
switched off by the first piece of work that succeeds.

The same file already documents this exact failure mode for the sibling sweep
(`:1140-1150`): the feature nudge once carried a `stopColumns` read, "so this watch — the
only backstop for a lead that never posts — deleted itself before observing anything. Do
not reintroduce a column read here." The queue sweep is the same defect mirrored: instead
of terminating on tick one it stays alive and mute.

**Defect 2 — a completed card can be resolved as the pacer.**
`PlanIngestionEngine.ts:1466` picks the seat-pacing pacer as the first board row with
`dispatchedAt` and a team holder. Completion does not clear `dispatched_at`, so a
completed card matches. If that holder's seat is absent or `exited`, the sweep takes the
dead-pacer branch and calls `_queueEscalationRecorder`.

**Defect 3 — the ladder re-stages it.** The recorder reaches
`LocalApiServer.reportQueueDone(outcome: 'failed')`. The failed branch's re-stage guard
(`LocalApiServer.ts:2994`) is `stillCoding = currentDispatchedTerminal.length > 0` — the
holder only. A completed card still has its holder, so the ladder moves it back to
`STAGING`, puts it at the front of the queue, and carries a role override. Completed work
is re-dispatched to a stronger seat.

Defects 2 and 3 compose into one reachable sequence with nothing unusual in it: lead posts
completion for subtask 1; the operator closes the coder seat that worked it; the queue
still holds cards. That is a re-dispatch of finished work, and the board shows the card
back in `STAGING` with no explanation.

**The through-line.** `kanban_column` records where a card is. It never records whether
work is done, and a team never moves a card, so within one run it is constant and carries
no information. `dispatched_at` records that a turn is in flight, not that work remains.
`completed_at` is the only fact that means finished, and it is the fact these three
predicates do not read.

## Metadata

**Tags:** backend, bugfix, reliability

**Complexity:** 5

## User Review Required

None. The replacement predicate is not a new rule — it is the one the feature sweep in the
same file already uses and documents, applied to the sweep that missed it.

## Complexity Audit

### Routine

- Delete one constant and its single use.
- Add one clause to two predicates.

### Complex / Risky

- `inFlight` is a SUPPRESSION gate. Getting it wrong in the loose direction wakes a
  working lead mid-turn; wrong in the tight direction restores the silence. The
  replacement must suppress on an outstanding dispatch and on nothing else.
- The queue sweep has no test harness. It is reached through `_sweepQueueWatches` with a
  turn-end notifier, a liveness snapshot, a pacing resolver, a team-members resolver and
  an escalation recorder. Building that harness is most of this work, and without it the
  fix is unverifiable — which is how the defect shipped.
- `PlanIngestionEngine.ts` reads `kanbanColumn === 'STAGING'` at `:1416` to build
  `queueCards`. That is the QUEUE DEFINITION — STAGING is where the queue lives, the same
  read `dispatchNextFromQueue` performs — not a progress inference. It must survive. Only
  the busy/done inferences change.

## Edge-Case & Dependency Audit

### Race Conditions

- The sweep reads a board snapshot per tick and writes only the watch record in
  `kanban.queueWatches`. Adding a clause to a read predicate opens no new window.
- A completion posted between the board read and the predicate evaluation reads as still
  in flight for one tick, then resolves on the next. One extra tick of silence is the
  safe direction; the sweep is idempotent across ticks by construction.

### Security

None. No endpoint, payload, or persisted authority is touched.

### Side Effects

- Teams that have completed at least one subtask start receiving queue nudges again. On
  an install that has been running teams this will look like new behaviour; it is the
  watch resuming the job it was written for.
- A completed card with a dead holder no longer escalates. It rests where it is, which is
  correct — it is finished.

### Dependencies & Conflicts

- Touches `PlanIngestionEngine.ts` and `LocalApiServer.ts`. No overlap with the head-prompt
  or migration surfaces.
- No persisted state changes shape or meaning, so no migration: this is predicate logic
  over columns that already exist and are already populated.

## Dependencies

None. The single-release-signal work is already committed; this closes the sweep side of
the same contract.

## Adversarial Synthesis

Key risks: (1) replacing the column read with `!completedAt` alone, dropping the
`dispatchedAt` condition — a team between dispatches then reads as in flight on any
un-posted card and the silence returns under a new predicate; (2) deleting the `STAGING`
read at `:1416` along with `CODING_COLUMNS`, which empties `queueCards` and drops every
watch as "queue empty"; (3) fixing the sweep and leaving `stillCoding` alone, so the
dead-pacer path still re-dispatches completed work through the ladder; (4) shipping
without a sweep harness, which is exactly how this reached production the first time; (5)
landing changes 2 and 4 without 3 — the pacer predicate still matches completed cards and
feeds the dead-pacer branch, which without 4 re-stages finished work. Mitigations: the
replacement predicate is stated in full below and mirrors the feature sweep's
`remaining`/`outstanding` pair verbatim; the `STAGING` read is named as retained with its
reason; all three sites are enumerated; the harness is built first and changes applied
against it; the landing-together set is {2, 3, 4}, not {2, 4}.

## Proposed Changes

### 1. `src/services/PlanIngestionEngine.ts:1392-1393` — delete `CODING_COLUMNS`

Remove the constant and the stale comment claiming it "Matches subtask 1's
`CODING_COLUMNS` exactly" — the constant it names was deleted from `LocalApiServer.ts`.
`:1743` is its only use and change 2 removes it, so nothing references it afterwards.

### 2. `src/services/PlanIngestionEngine.ts:1742` — `inFlight` reads the facts

```js
const inFlight = board.some(p =>
    p && !!p.dispatchedAt
    && !p.completedAt
    && typeof p.dispatchedTerminal === 'string'
    && p.dispatchedTerminal.length > 0
    && headTeamSet.has(p.dispatchedTerminal)
);
```

`dispatchedAt` set and `completedAt` NULL is "a dispatch is outstanding". This is the
feature sweep's own pair — `remaining` excludes completed rows (`:1164`), `outstanding` is
`remaining.some(s => !!s.dispatchedAt)` (`:1177`) — not a new rule. Board position leaves
the predicate.

The subsequent team-liveness gate (`:1768`) is unchanged and still suppresses a nudge
while any team member is producing output, which is what covers the window between a
`clearWorkingState` and the lead's next dispatch.

### 3. `src/services/PlanIngestionEngine.ts:1466` — the pacer is not a finished card

Add `&& !p.completedAt` to the `heldCard` predicate. A completed card is not the pacer;
resolving it as one is what lets the dead-pacer branch feed finished work to the ladder.
Update the comment above it, which currently justifies the "One condition: `dispatched_at`
set" that this change makes two.

### 4. `src/services/LocalApiServer.ts:2994` — `stillCoding` requires no completion

The failed branch already performs a fresh canonical read into `fresh`
(LocalApiServer.ts:3038). Extend BOTH the `currentDispatchedTerminal` extraction and the
guard to also carry `currentCompletedAt` off the same read:

```js
let currentDispatchedTerminal = typeof held.dispatchedTerminal === 'string' ? held.dispatchedTerminal : '';
let currentCompletedAt = held.completedAt ?? null;
try {
    const fresh: any = await db.getPlanByPlanId?.(held.planId);
    if (fresh) {
        currentDispatchedTerminal = typeof fresh.dispatchedTerminal === 'string' ? fresh.dispatchedTerminal : '';
        currentCompletedAt = fresh.completedAt ?? null;
    }
} catch { /* fall back to held */ }
const stillCoding = currentDispatchedTerminal.length > 0 && !currentCompletedAt;
```

`getPlanByPlanId` returns `completedAt` (row mapping at KanbanDatabase.ts:10827), so
`fresh.completedAt` is populated on the same read that already supplies
`currentDispatchedTerminal`. The fallback to `held.completedAt` when the read faults
mirrors the existing `currentDispatchedTerminal` fallback to `held.dispatchedTerminal`.
A `failed` report against a card that carries a completion post is a no-op that falls
through to the pop, the same contract as a duplicate report. This is the backstop for
change 3: even if some future caller reports `failed` on a completed card, the ladder
does not re-stage it.

### 5. Tests (BUILD FIRST — execution order: harness, then changes 1–4 against it)

A harness for `_sweepQueueWatches` is the prerequisite deliverable, not a follow-up. The
numbered changes above are change *sites*, not execution order — the harness is built
first and changes 1–4 are applied and verified against it. It
needs stub seams for the turn-end notifier, the liveness snapshot, the pacing resolver,
the team-members resolver and the escalation recorder — the same stub-seam style
`queue-pipeline-contract.test.js` uses for `LocalApiServer`.

- Head pacing: a team whose only held card carries `completed_at` is NOT in flight — the
  sweep nudges rather than falling silent. Run two consecutive ticks and assert the second
  still nudges; one tick cannot distinguish this defect from a slow start.
- Head pacing: a team with an outstanding dispatch (`dispatched_at` set, no
  `completed_at`) IS in flight and the sweep stays silent.
- Seat pacing: a completed card with a dead holder does not resolve as the pacer and the
  escalation recorder is not called.
- Ladder: `reportQueueDone(outcome:'failed')` against a card carrying `completed_at`
  re-stages nothing and moves no column.
- Source pin: `CODING_COLUMNS` does not appear in `PlanIngestionEngine.ts`, and the
  `STAGING` queue read at `:1416` still does.

## Verification Plan

### Automated Tests

- New queue-sweep contract (the four behavioural cases plus the source pin above).
- Existing `queue-pipeline`, `queue-done-relay`, `task-complete`, `atomic-team-lifecycle`,
  `completion-asserted` — the ladder change touches the path all five exercise.

### Gate Wiring

The new suite gets a `package.json` script AND a step in
`.github/workflows/integration-tests.yml` in the same change. A suite that is defined but
not invoked is the same hole as no suite at all.

### Goal Invariants

- `CODING_COLUMNS` does not exist in `PlanIngestionEngine.ts`.
- No busy/done inference in `PlanIngestionEngine.ts` reads `kanbanColumn`; the only
  surviving column read is `=== 'STAGING'`, which defines where the queue is.
- A card carrying `completed_at` never satisfies `inFlight`, never resolves as the pacer,
  and never re-stages through the ladder.
- The queue stall watch still nudges after a team has completed a subtask.

### Manual Verification

1. Run a team through one subtask to a completion post. Leave cards staged and the lead
   idle. The queue nudge fires; before this change it never fires again.
2. With an outstanding dispatch on a team member, confirm the sweep stays silent.
3. Post completion for a subtask, close the seat that worked it, leave the queue
   non-empty. The completed card stays where it is — no re-stage, no re-dispatch.

## Recommendation

Send to Lead Coder. Changes 2, 3, and 4 must land together: change 2 alone restores the
nudge while leaving the ladder able to re-dispatch completed work; change 3 alone feeds
completed cards to the dead-pacer branch with no guard at the ladder; change 4 alone
leaves the watch mute so the ladder is never reached. The full set {2, 3, 4} closes the
loop — any two without the third leave a reachable re-dispatch or a silent watch. Build
the sweep harness first — without it none of the three is verifiable, and the absence of
that harness is why the defect shipped.

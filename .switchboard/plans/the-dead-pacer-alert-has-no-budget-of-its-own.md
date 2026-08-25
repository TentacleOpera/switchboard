# The Dead-Pacer Alert Has No Budget of Its Own

## Goal

In `_runQueueNudgeSweep`'s seat-pacing branch there are two operator alerts. The
no-pacer alert is one-shot: it guards on `!watch.escalatedAt`. The dead-pacer
alert next to it has no guard at all — it writes `escalatedAt` and never reads
it. It also spends `nudgeCount`, which is the *agent* nudge's budget, not the
operator alert's.

The result is two failures in one block, pointing opposite ways. When the card
release that follows the alert fails, the same notice repeats every tick. When
the release succeeds, the watch has spent both one-shot budgets on a single
event and goes permanently silent until a real dispatch re-arms it — so a queue
that never gets re-dispatched has no backstop left at all.

This plan fixes the block so the dead-pacer alert has a budget of its own, keyed
on which seat and which card it is about. It deliberately does **not** pick
between the four candidate designs — see `## User Review Required`.

### Root Cause Analysis

**Layer 1 — the alert has no one-shot test.**

`src/services/PlanIngestionEngine.ts` seat-pacing branch, two sibling blocks:

| Block | Line | Guard |
|---|---|---|
| no-pacer (nothing is running at all) | `:1476` → `:1492` | `if (!watch.escalatedAt)` |
| dead-pacer (a seat died holding a card) | `:1528` | **none** |

The dead-pacer block sets `watch.escalatedAt = nowMs` on the way out, so the
field is written on this path — it is simply never tested on it. The sibling
twelve lines up does test it. This reads as a copy of the no-pacer block with
the guard dropped, not as a deliberate decision to alert repeatedly.

**Layer 2 — the alert spends the agent nudge's budget.**

Both blocks also do `watch.nudgeCount = (watch.nudgeCount ?? 0) + 1`. Downstream
in the same branch, the gate-(8) stop-guard is `if (watch.nudgeCount >= 1)`. So
one dead-pacer event muzzles the *pacer nudge* — a message addressed to an
agent, about a different condition — for the rest of the watch's life.

The seat-pacing branch has **no** `nudgeCount` reset. The only resets in the file
are the feature sweep's gate 4a (`:1188`) and the queue sweep's **head-pacing**
in-flight gate (`:1759`). Neither runs in seat-paced mode. The sole re-arm is
`armQueueWatch`'s `onDispatch` path (`:320–329`), which resets
`lastNudgedAt`/`nudgeCount` and deletes `escalatedAt` — and its own comment is
explicit that a **re-stage is not a dispatch** and is a no-op on nudge state.

That closes a trap. A dead pacer's card is re-staged by the escalation ladder,
not re-dispatched. If nothing subsequently pops that card from STAGING (the
lead-paced case where the lead is the thing that died), the watch now has
`escalatedAt` set and `nudgeCount >= 1`, which suppresses the no-pacer alert
*and* the pacer nudge. The watch survives, observes a non-empty queue every
tick, and says nothing, forever.

**Layer 3 — why the repeat is intermittent rather than constant.**

The dead-pacer block calls `_queueEscalationRecorder(folder, heldCard.planId,
pacerSeat)`, wired at `src/extension.ts:1134` to
`LocalApiServer.reportQueueDone({outcome: 'failed'})` → `_runQueueDone`, which
locates the card by `dispatchedTerminal === from && dispatchedAt set` and calls
`clearWorkingState` (`LocalApiServer.ts:2832`). `pacerSeat` *is*
`heldCard.dispatchedTerminal`, so the latch is normally released. On the next
tick `heldCard` is undefined and control falls into the no-pacer branch, which
is guarded — so the alert usually fires once.

It fires repeatedly only when that release does not land:

- `taskViewerProvider._localApiServer` is unset — the wiring at
  `extension.ts:1136` duck-types it and silently no-ops if absent.
- `reportQueueDone` throws — caught and discarded at `extension.ts:1139`.
- `clearWorkingState` fails — caught and logged at `LocalApiServer.ts:2834`.
- the lookup misses `from`, e.g. a terminal rename changed the recorded
  `dispatchedTerminal` after dispatch.

In each case the condition persists and the notice re-fires every
`scanIntervalMs` (default 10s, `PlanIngestionEngine.ts:500`).

Note the shape of this: the alert repeats **precisely when its own recovery
failed**, and the message it repeats says "The card will be re-staged to a
stronger seat" — which by then is false. The noise is a symptom of a silent
failure wearing the wrong text.

### Background

The nudge-noise plan
(`fix-silent-nudge-noise-to-team-lead-in-team-coding-mode.md`) named this block
and put it out of scope on the grounds that it notifies the operator rather than
the team lead. That scoping was right for that plan — its subject was noise
delivered *to a lead* — and its throttles genuinely do not reach here: the
`nudgeSilenceMs` pacing floor and the gate-(8) stop-guard are gates 7 and 8, and
both alert blocks end in `continue` well above them. The plan's parenthetical
claim that the block "fires every 10s tick" is however too strong; Layer 3 above
is the corrected account.

## Metadata

**Complexity:** 4
**Tags:** bugfix, backend, reliability

## User Review Required

**Which guard shape.** This is the one real decision and it is yours, because
the four options trade operator noise against operator blindness in different
directions and the plan has no evidence about which the operator prefers. The
options are fully specified in `## Proposed Changes`; the recommendation is
**Option B + B2**, and Option A is the one to actively avoid.

Everything else in this plan is settled and needs no review: the `nudgeCount`
decoupling (Layer 2) is a defect under every option, the new field's absent-reads-
as-unnotified semantics are the only safe direction, and the clearing sites are
determined by the existing re-arm contract.

## Complexity Audit

### Routine

- Adding an optional field to `QueueWatchRecord` (`:133–150`) — mirrors the
  existing `noHeadNotifiedAt` / `escalatedAt` optional stamps exactly.
- Adding the guard condition to the dead-pacer block (`:1528`).
- Clearing the new field in `armQueueWatch`'s `onDispatch` branch (`:326–328`),
  alongside the two `delete` calls already there.
- Contract-test assertions in `queue-pipeline-contract.test.js`.

### Complex / Risky

- **Decoupling `nudgeCount` from the operator alerts.** Both alert blocks
  currently increment it, and the gate-(8) guard reads it. Removing the
  increments changes which watches the pacer nudge can still reach — this is
  the ~4,000-install nudge path, and the change is in the *permissive*
  direction (a watch that was muzzled now speaks), which is the correct
  direction but is still a behaviour change on a shipped path.
- **Option B2 widens a `Promise<void>` seam.** `setQueueEscalationRecorder`
  (`:417`) is typed `Promise<void>`, so a recorder that silently does nothing is
  indistinguishable from one that released the card. Any option that reports
  "could not release" must change that signature and both call sites.
- **Seat-pacing is extension-only.** `setQueuePacingResolver` is wired at
  `extension.ts:1125–1134` and nowhere in `src/standalone/bootstrap.ts`, so
  `pacing` stays `'head'` in standalone and this entire branch is unreachable
  there. A behavioural test cannot exercise it through the standalone shim; the
  coverage has to be source-text or a directly-invoked sweep with the resolvers
  stubbed.

## Proposed Changes

### The four options, and what each costs

**Option A — guard on the existing `escalatedAt`.**

```ts
if ((!pacerLive || pacerLive.status === 'exited') && !watch.escalatedAt) {
```

One line, no new state, no migration.

*Cost, and it is disqualifying:* `escalatedAt` is a single shared boolean across
both alerts. Sharing it means a re-stage to a new seat that **also** dies
produces no notice — and the dead-pacer message names a specific seat and a
specific card, so the second event carries information the first did not. Worse,
Option A makes Layer 2 harder to see rather than fixing it: the watch is still
spending `nudgeCount` on an operator alert. **Recommend against.**

**Option B — guard on identity, not on a boolean.**

Add to `QueueWatchRecord`:

```ts
/** `${pacerSeat}:${planId}` of the last dead-pacer alert. The alert is about a
 *  specific seat holding a specific card, so the one-shot budget is keyed on
 *  that pair, not on the shared `escalatedAt` boolean: a re-stage to a second
 *  seat that also dies is new information, and a repeat about the same dead
 *  seat and card is not. Absent (old records, first alert) reads as
 *  "not yet alerted" — the safe direction. */
deadPacerAlertedFor?: string;
```

Guard:

```ts
const deadPacerKey = `${pacerSeat}:${heldCard.planId}`;
if ((!pacerLive || pacerLive.status === 'exited') && watch.deadPacerAlertedFor !== deadPacerKey) {
    …notify, record…
    watch.deadPacerAlertedFor = deadPacerKey;
    mutated = true;
}
kept.push(watch);
continue;
```

Note the `continue` moves **outside** the guard: the block must still short-circuit
the rest of the gates on every tick where the pacer is dead, alert or no alert.
Getting this wrong falls through to the pacer nudge and messages a dead terminal.

Clear it in `armQueueWatch`'s `onDispatch` branch next to the existing deletes:

```ts
delete rearmed.deadPacerAlertedFor;
```

*Cost:* one new persisted field, and a watch that cycles seat A → seat B → seat A
within a single stall alerts a third time on A. That is arguably correct, and it
requires two deaths and a re-dispatch to reach.

**Option B2 — B, plus report the release failure as its own fact.**

Layer 3 says the repeat happens exactly when the card release fails, and that
the repeated text ("will be re-staged") is false by then. So: widen
`setQueueEscalationRecorder` from `Promise<void>` to `Promise<boolean>`
(released / not), and when it returns false or is absent, emit a *different*
one-shot notice naming what could not be released, rather than repeating a
now-false claim. Requires touching the seam (`:417`), the extension wiring
(`extension.ts:1134–1141`), and `reportQueueDone`'s return handling.

*Cost:* the largest change here, and it is the only option that fixes the
underlying failure rather than muting its symptom. A `Promise<void>` seam where
"did nothing" and "worked" are the same value is the reason this was invisible.

**Option C — decouple `nudgeCount` (required under every option above).**

Remove `watch.nudgeCount = (watch.nudgeCount ?? 0) + 1` from **both** alert
blocks (`:1509` no-pacer, `:1553` dead-pacer). `nudgeCount` is the agent nudge's
one-shot budget, read by the gate-(8) guard; an operator alert must not spend it.
Each alert already has, or gains, its own stamp: `escalatedAt` for no-pacer,
`deadPacerAlertedFor` for dead-pacer. Keep the `lastNudgedAt = nowMs` writes —
those are the shared pacing floor and are legitimately shared.

This is not optional and is not a matter of taste: without it, the trap in
Layer 2 stands (one dead-pacer event permanently silences a seat-paced watch
that never gets re-dispatched) whichever guard shape is chosen.

**Option D — drop the alert to a log line.**

Argue that the ladder already re-stages the card, so the operator does not need
telling about a failure the system recovers from.

*Cost, and it is disqualifying:* it removes the only signal for the case where
that recovery **silently fails** — which is the same case that currently
produces the noise. Trading noise for blindness on the one code path where the
noise was actually load-bearing. **Recommend against.**

### Recommendation

**Option B + B2 + C.** B gives the alert a budget matched to what the alert is
about. B2 makes the failing-release case say what is true, once, instead of
repeating a false claim forever — and closes a `Promise<void>` seam where a
no-op is indistinguishable from success. C is mandatory under all options.

If B2 is judged too wide for one pass, ship **B + C** and leave B2 as a
follow-up; B alone already converts an unbounded repeat into one notice per
(seat, card), and C alone removes the permanent-silence trap. Do not ship A, and
do not ship D.

## Edge-Case & Dependency Audit

**Migration.** `kanban.queueWatches` is a shipped config key — persisted watch
records exist on installs going back several versions. `deadPacerAlertedFor` is
optional and absent-reads-as-unnotified, so an old record's first dead-pacer
event alerts normally. No migration needed, and the failure direction if this is
wrong is one extra notice, never a lost one. Do **not** make the field required:
`QueueWatchRecord.nudgeCount` is required today and survives only because
`undefined >= 1` and `undefined > 0` are both false — a required string field
has no such accident to rely on.

**Race conditions.** The sweep is serialised by `_scanInProgress` (`:508`), and
the write-back goes through the same `updateConfigJson` tail as `lastNudgedAt`
and `escalatedAt`, so no new write race. The `_queueEscalationRecorder` call
already awaits inside the per-watch loop; B2 changes its return type, not its
timing. `_runQueueDone` serialises on `_queueNextChain`, unchanged.

**The `continue` placement.** Under Option B the `continue` must stay outside the
alert guard. If it moves inside, a tick that suppresses the alert falls through
to gates 6/7/8 and can deliver the *pacer nudge* to the dead terminal it just
declined to alert about. This is the single most likely way to implement B
incorrectly and every gate would stay green.

**Standalone — larger than this block, and larger than first written here.** The
whole queue-watch backstop is extension-only. All four queue seams
(`setQueueHeadResolver`, `setQueuePacingResolver`, `setQueueTeamMembersResolver`,
`setQueueEscalationRecorder`) are wired at `src/extension.ts:1109–1141` and
nowhere else. `src/standalone/bootstrap.ts` wires five *other* engine seams
(`setOnWorkingStateCleared`, `setFeatureColumnRecomputer`,
`setFeatureFileRegenerator`, `setTerminalLivenessProvider`,
`setTurnEndNotifier`) and none of these. It also never references
`globalPlanWatcher`, so `KanbanProvider`'s two `armQueueWatch` call sites
(`:2745`, `:8508`) no-op there, and its `LocalApiServer` options object
(`bootstrap.ts:2910`) carries no `armQueueWatch`, so the two arm guards at
`LocalApiServer.ts:2230` / `:3182` are dead too.

Net: **no queue watch is ever armed in standalone.** The sweep runs each tick and
reads an empty list. Seat pacing being unreachable is a consequence of that, not
a separate gap — and the nudge plan's team-wide in-flight and team-liveness
fixes are inert there for the same reason. Nothing in this plan changes that;
it is recorded here because the nudge plan's edge-case audit describes an absent
resolver as the "headless/test harness" case, which reads as a test condition
rather than as the entire standalone host.

**This is a scoping question, not a defect finding.** Whether standalone is meant
to run lead-paced or seat-paced team pipelines at all is a product decision, and
no test, doc, or plan in the repo pins these seams either way. If it is meant to,
that is a separate parity plan and it is bigger than this one. If it is not, the
absence should be pinned by a parity test so it reads as intent rather than as
four wires someone forgot.

**Existing contract tests.** `queue-pipeline-contract.test.js:724` asserts
`/watch\.escalatedAt/` still appears in the sweep body — Option B keeps
`escalatedAt` (the no-pacer alert still uses it), so this holds. The gate-(8)
notifier scan (`:740–753`) keys on `if (watch.nudgeCount >= 1)` and walks to the
next `continue;`, so it does not reach either alert block — removing the
`nudgeCount` increments under Option C does not disturb it. The
`/nudgeCount >= 1/` assertion at `:726` refers to the stop-guard, which stays.

**Interaction with the re-stage ladder.** `_queueEscalationRecorder` feeds the
attempt counter that re-stages a card to a stronger seat. None of these options
change that call or its arguments — B2 only reads its result. A card that
re-stages and is popped goes through `armQueueWatch({onDispatch: true})`, which
clears every stamp including the new one, so a genuinely new stall alerts again.

## Dependencies

None. `fix-silent-nudge-noise-to-team-lead-in-team-coding-mode.md` has landed and
is what makes this the remaining gap in the block; nothing here depends on
further work from it.

## Adversarial Synthesis

Key risks. (1) The obvious one-line fix (Option A) is the wrong fix — it shares a
boolean between two alerts that carry different information, and it leaves the
`nudgeCount` trap standing; a coder reaching for the cheapest diff will land on
it, which is why it is written out and rejected explicitly rather than omitted.
(2) The `continue`-inside-the-guard error delivers a nudge to a dead terminal
and no gate would catch it. (3) The `nudgeCount` decoupling is a permissive
behaviour change on the ~4,000-install nudge path — correct in direction, but it
means some watches that were silent will now nudge, and that should be expected
rather than diagnosed as a regression. (4) Seat-pacing is extension-only, so a
behavioural test written against the standalone shim will pass without ever
entering the branch — a false green. Mitigations: Options A and D are stated with
their disqualifying costs so the choice is informed; the `continue` placement has
its own audit entry; the test plan pins the branch by direct sweep invocation
with the resolvers stubbed, not through the shim.

## Verification Plan

### Automated

1. `npm run compile-tests` — the new optional field must not make any
   `QueueWatchRecord` literal invalid.
2. `npm run test:contract:queue-pipeline` — existing assertions stay green (see
   the audit above for why each holds), plus new ones:
   - the dead-pacer block is guarded: the source between `pacerLive.status ===
     'exited'` and its `continue` contains a `deadPacerAlertedFor` comparison;
   - neither alert block increments `nudgeCount` (Option C);
   - `armQueueWatch`'s `onDispatch` branch deletes `deadPacerAlertedFor`
     alongside `escalatedAt` and `noHeadNotifiedAt`;
   - the `continue` is reached on every dead-pacer tick, alerted or not.
3. Behavioural test of the sweep itself, invoked directly with
   `_queuePacingResolver` stubbed to `'seat'`, `_queueTeamMembersResolver`
   stubbed to a roster, and `_turnEndNotifier` counting calls:
   - dead pacer, three consecutive ticks, release stubbed to fail → **one**
     notification, not three;
   - dead pacer A released, card re-staged to B, B also dies → **two**
     notifications, one per seat;
   - dead pacer alerted, then a live pacer appears → the pacer nudge still fires
     (this is the Layer 2 regression, and it fails today);
   - old persisted record with no `deadPacerAlertedFor` → alerts once.
4. `npm run test:contract:mission-control-tick` — unchanged, regression check on
   the shared `notifiedSeatsThisTick` set.

**Gate wiring:** `test:contract:queue-pipeline` and
`test:contract:mission-control-tick` are both invoked by
`.github/workflows/integration-tests.yml` (lines 920 and 901). Any new test file
must be added to `package.json` **and** to that workflow — a script defined but
not invoked is the green-while-incomplete hole.

### Manual

5. Seat-paced team, extension host. Dispatch a card to a seat, kill that
   terminal. Confirm exactly one operator notice naming the seat and the card,
   and that the card is re-staged.
6. Same, with the release path broken (temporarily unset
   `taskViewerProvider._localApiServer`). Confirm one notice, not one per 10s —
   and under B2, that the notice says the card could not be released rather than
   that it will be re-staged.
7. After a dead-pacer event, dispatch a fresh card to a live seat and let it go
   idle past `nudgeSilenceMs`. Confirm the pacer nudge fires — today it does not.

## Recommendation

Send to Coder. The diff is small but it turns on the semantics of a shared
persisted field with four writers and two readers, and the two ways to get it
wrong (`continue` inside the guard, required-instead-of-optional field) both
leave every gate green.

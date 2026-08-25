# A comment on a card cannot reach the seat holding the work, and the stall the system already detected is never shown

## Goal

Make a tracker card a two-way channel to the agent actually holding its work: route an inbound
comment to the card's `dispatched_terminal` through the existing relay, and surface the feature-stall
evidence the engine already computes as a comment. Together these let the operator see a stall and
break it from a phone, using two mechanisms that are already built.

### Problem Analysis

**Inbound comments reach the column, not the worker.** A comment on a synced card is routed to the
card's *current column agent*. That is correct for a planning conversation and wrong for waking a
worker: the seat holding an in-flight subtask is not necessarily the column's agent, and on a
feature card there may be no single agent at all. So the operator's natural move — see a silence,
reply on the card — reaches the wrong place or nowhere.

**But the card already records exactly which seat holds it.** `plans.dispatched_terminal` is a
persisted column (V57 migration, `KanbanDatabase.ts:8673`, added for "completion-broadcast pane
targeting"), written at dispatch (`:10117`). `src/services/teamWiring.ts:2183` states the property
that makes it safe to target: **"`dispatched_terminal` is only ever a real name"** — it is written
by the dispatch path, never guessed. `TaskViewerProvider.ts:10683` already resolves team membership
"from a card's `dispatched_terminal` identically to dispatch routing", and
`LocalApiServer.ts:334-336` documents an optional resolver that degrades to a
`dispatched_terminal === from` head-only match. Self-target guards against this field already exist
at `TaskViewerProvider.ts:7569` and `:22446`.

**And delivery into a named seat is a solved, guarded operation.** `POST /terminals/relay`
(`LocalApiServer.ts:3867`) validates the target against the live fleet via `ptyListTerminals`, calls
`ptySendPrompt` with `clearBeforePrompt: false` **hardcoded** — "there is no field to omit and no
field to get wrong" — and wraps the text with a provenance header so the recipient knows who is
talking. A stale seat name therefore fails cleanly rather than delivering somewhere wrong.

**So the wake-up path is a field the card already holds plus a route that already exists.**

**Separately: the stall the operator wants to notice has already been noticed.**
`PlanIngestionEngine` (`:1219-1270`) watches features with un-accepted subtasks, holds a liveness
snapshot keyed by seat name (`livenessByName`, `lastDataAt`), and composes an evidence body naming
each remaining subtask, its seat, how long that seat has been silent, and how long ago its plan file
was written. The mtime clause is deliberate and load-bearing: a comment records that it catches "a
seat that has been quiet for minutes but whose plan file was written seconds ago finished and never
reported". The engine then nudges the head **once** — `:1246-1250`, "A head that didn't respond to
the first nudge won't respond to a second — repeating every window is the noise this fix exists to
eliminate."

**That nudge is invisible to the operator, and its one-shot design is exactly why they need to see
it.** The system's own position is that if one nudge fails, more nudges will not help. The next
escalation is a human — but the human is not told there was a stall, that evidence was gathered, or
that an automatic attempt was already made and did not work. From a phone, the run simply stays
quiet.

### Root Cause

Stall handling was built as a *self-healing* loop: the engine detects, composes evidence, nudges the
head, and gives up deliberately. It is complete as a local mechanism and has no notion of an
operator who is elsewhere. Inbound comment routing, meanwhile, was built for the planning
conversation, where the card's column *is* the right addressee. Neither considered the case this
plan covers: a remote operator as the escalation target after the automatic attempt has been spent.

### Non-goals

- **No new stall detection.** The engine's evidence composition, its gates, and its one-nudge policy
  are used as they are. This plan does not add a watchdog, change a threshold, or re-derive
  liveness — `:1252-1255` is explicit that "the host must not re-derive it".
- **No second nudge.** The one-shot policy stands. Surfacing the stall to the operator is not a
  retry.
- **No change to relay send semantics.** `clearBeforePrompt: false` stays hardcoded and the
  provenance header stays. Waking a seat must never reset it — a seat mid-task that gets cleared
  loses the work.
- **Not replacing column routing.** Comments on cards with no in-flight seat keep routing to the
  column agent exactly as they do now.
- **No new auth, no new exposure, no new primitive.**

## Metadata

**Complexity:** 3
**Tags:** backend, feature, reliability, ux, api

## User Review Required

Yes — two decisions.

1. **When does a comment go to the seat rather than the column?** Recommendation: **seat when the
   card has a live `dispatched_terminal` and no completion post; column otherwise.** That is the
   same in-flight condition `LocalApiServer.ts:1932` already uses to refuse a team its next card, so
   the two agree by construction rather than by coincidence. The alternative — an explicit prefix or
   command in the comment — puts a syntax burden on someone typing one-handed.
2. **Does the operator's reply reach the seat, the lead, or both?** Recommendation: **the seat that
   holds the card**, with the lead's name in the provenance header so the seat knows the operator
   went around it. Routing to the lead re-introduces the indirection that lost the message in the
   first place; routing to the seat is what the field means.

## Complexity Audit

### Routine

- Resolving `dispatched_terminal` for a commented card and choosing the seat or column path.
- Delivering through the existing relay with a provenance header naming the operator.
- Posting the engine's already-composed stall body as a comment.

### Complex / Risky

- **Staleness is real but fails safely, and must be seen to.** `dispatched_terminal` persists after
  a seat dies, is closed, or is renamed. The relay's `ptyListTerminals` validation means a stale
  name is refused rather than misdelivered — but the operator must be told the reply did not land.
  A silently dropped wake-up is the worst outcome of this plan, because the operator will believe
  they have pinged.
- **The clear policy is the sharp edge.** `ptyClearPolicy.ts` exists because clearing is a real
  event with real rules. A woken seat must keep its context; a relay that reset it would destroy the
  in-flight work the operator was trying to rescue. The hardcoded flag protects this, and no path
  added here may route around it.
- **Feature cards have no single seat.** A comment on a feature card must resolve to the subtasks'
  seats or explicitly to the lead — not silently pick one. `PlanIngestionEngine.ts:1468-1470` and
  `:1744-1746` already filter subtasks by `dispatchedTerminal` against team membership; reuse that
  shape rather than inventing a selection rule.
- **Self-target.** Guards already exist at `TaskViewerProvider.ts:7569`/`:22446`; the new path needs
  the same one, or an agent's own comment could be relayed back to itself.
- **Operator text is untrusted-adjacent in an agent's context.** The comment body reaches a working
  agent. It must not be able to forge the provenance header or a standing-orders marker
  (`=== STANDING ORDERS ===`). The relay's existing wrapping is the pattern; it must be
  injection-resistant, not merely present.
- **Stall comments must not become noise.** The engine nudges once per watch, re-armed by a
  dispatch. The comment must follow the same cadence exactly — one per stall, not one per poll
  window — or a stalled feature posts every cycle and gets muted.

## Edge-Case & Dependency Audit

**Race conditions**
- Seat completes between the comment arriving and the relay firing: the relay validates at delivery
  time and refuses a departed seat, which is correct; the operator still needs to be told the work
  finished rather than that their ping failed.
- Card re-dispatched to a different seat while a comment is in flight: resolve at delivery, never
  from a cached name.
- Stall comment and completion notification landing together: the operator sees a stall alert for
  work that just finished. Suppress the stall comment when a completion post arrives in the same
  window.
- Two instances both surfacing one stall: needs a durable dedupe, as the notification plan's events
  do.

**Security**
- The relay's guarantees are the safety model here: live-fleet validation, never clearing, provenance
  wrapping. Do not add a path that skips them.
- The stall body names seats, plan files and timings. Posting it publishes that to everyone with
  tracker project access — same audience consideration as the other outbound events.
- No new exposure; existing host-side bridge, existing token.

**Side effects**
- Comment routing behaviour changes for in-flight cards, which is a behaviour change on a shipped
  path. An operator commenting on an in-flight card today reaches the column agent; afterwards they
  reach the seat. That is the point, but it is a change and should be visible in the UI and the
  remote skill, not silent.
- The remote skill's guidance that "your comment is routed to the card's current column agent" needs
  updating, or it will actively mislead.

**Migration**
- No schema change: `dispatched_terminal` already exists (V57) and is already populated on shipped
  installs. No stored shapes change. Routing behaviour changes only for cards that are in flight,
  and only where remote control is on.

## Dependencies

- **Depends on** `the-queue-is-invisible-unless-an-agent-remembers-to-narrate-it.md`. The stall
  comment is a fourth event type on that plan's notification bridge and should reuse its gating,
  toggles, dedupe, best-effort delivery and mention handling rather than building a parallel path.
  It also supplies the visibility that makes a manual wake-up worth having.
- **Reuses** `POST /terminals/relay`, `dispatched_terminal`, the engine's stall evidence, and the
  existing self-target guards.
- **Absorbs the surviving fragment** of `a-message-to-a-terminal-has-no-return-path.md`. That plan
  was withdrawn from the phone feature, and what remained of it — relaying to a named terminal with
  no card involved — has its justification here: the card supplies the addressing, so the operator
  never names a terminal.

## Adversarial Synthesis

Key risks: (1) a stale `dispatched_terminal` silently swallowing a wake-up, leaving the operator
believing they pinged; (2) any path that clears the woken seat, destroying the work being rescued;
(3) a feature card silently resolving to one arbitrary subtask's seat; (4) stall comments posting
per poll window instead of per stall, so the card gets muted; (5) operator text forging a provenance
header or standing-orders marker in an agent's context; (6) re-deriving liveness instead of using
the engine's snapshot, producing a second and disagreeing definition of "silent". Mitigations: report
undelivered wake-ups explicitly on the card; never route around the hardcoded no-clear flag; reuse
the existing subtask/seat filters for feature cards; bind the stall comment to the engine's existing
one-nudge cadence; wrap operator text injection-resistantly; and take liveness only from the engine,
which `:1252-1255` already insists on.

## Proposed Changes

1. **Route an inbound comment to the seat** when the card has a live `dispatched_terminal` and no
   completion post — the same in-flight condition `LocalApiServer.ts:1932` uses — and to the column
   agent otherwise.
2. **Deliver through `POST /terminals/relay`** unchanged, with a provenance header naming the
   operator and the card, and the lead named so the seat knows it was reached directly.
3. **Report an undelivered wake-up back on the card** when the seat is gone, stating why — departed,
   renamed, or already complete.
4. **Feature-card resolution** reusing the existing subtask/seat filters, with an explicit rule
   rather than an arbitrary pick.
5. **Surface the engine's stall evidence as a comment**, verbatim from the body it already composes,
   on the engine's existing one-nudge cadence, as a fourth event type on the notification bridge —
   including the fact that the head was already nudged, so the operator knows the automatic attempt
   is spent.
6. **Self-target guard** on the new path, matching the existing ones.
7. **Update the remote skill**, whose current text says a comment reaches the card's current column
   agent — true today, wrong after this.

### Migration

No schema or stored-shape change. `dispatched_terminal` is already present and populated. Inbound
routing changes only for in-flight cards under remote control.

## Verification Plan

1. **The whole loop, from a phone.** Dispatch a card, let its seat go quiet, receive the stall
   comment, reply on the card, and confirm the reply arrives in that seat's terminal — never having
   named a terminal.
2. **Context survives.** Assert the woken seat's prior context is intact. A relay that cleared it
   would destroy the work being rescued; this is the most damaging possible regression.
3. **Stale seat is reported, not swallowed.** Close the seat, then reply. Assert the card carries an
   explicit "not delivered, seat gone" rather than silence.
4. **Completed seat.** Reply after the completion post; assert the operator is told the work
   finished, not that their ping failed.
5. **Column routing unregressed.** Comment on a card with no in-flight seat and assert it reaches the
   column agent exactly as today.
6. **Feature card.** Comment on a feature card and assert the documented resolution, never an
   arbitrary subtask.
7. **One stall comment per stall.** Hold a feature stalled across many poll windows; assert exactly
   one comment, re-armed only by a dispatch — matching the engine's `nudgeCount` policy.
8. **Stall suppressed by completion.** Have a subtask complete in the same window a stall is
   detected; assert no misleading stall alert.
9. **Comment text is data.** Reply with a forged provenance header, a fake
   `=== STANDING ORDERS ===` marker, and instruction-shaped text. Assert none of it changes what the
   agent is told to do.
10. **Self-target refused.** Assert an agent's own comment cannot be relayed back to itself.
11. **Liveness has one definition.** Assert the stall comment's "silent Ns" comes from the engine's
    snapshot, not a second computation.
12. **Two instances, one comment.** Assert no duplicate stall alerts.

## Stall surfacing withdrawn — the manual path stands, the automatic one does not

*Appended after review.*

This plan carried two halves. The **inbound wake-up** — an operator's comment routed to the card's
`dispatched_terminal` through the relay — stands unchanged, and is now the whole plan. It is
operator-initiated, keyed on a field written by the dispatch path, and involves no inference
whatsoever.

**Proposed change 5 is withdrawn**: surfacing `PlanIngestionEngine`'s stall evidence as a comment.
Its inputs are PTY silence and plan-file mtime, both of which the project has decided against —
see the companion notification plan's appended section for the citations, chiefly that silence
"cries wolf" and that an mtime advance cannot be distinguished from a mid-work edit. Pushing that
to a phone is worse than the board badge being removed, not better.

**What this simplifies.** The plan no longer touches `PlanIngestionEngine` at all:

- No dependency on `livenessByName` or `lastDataAt`, so no second definition of "silent".
- No coupling to the engine's `nudgeCount` cadence — the risk about "one stall comment per stall,
  not one per poll window" disappears with the event.
- No plan-file `stat` calls.
- Verification steps 7, 8 and 11 (one-comment-per-stall, stall-suppressed-by-completion, liveness
  has one definition) are withdrawn along with it.

**The escalation story is unchanged and simpler.** The notification plan makes dispatch and
completion visible; the operator reads a dispatch followed by silence and decides for themselves
that it is suspicious; this plan gives them a way to act on that judgement by replying on the card.
No detector, no threshold, no badge. The human is the detector — which is what was asked for.

**Reduced scope:** complexity 4 → 3. One route change, one resolution rule, one relay call, and an
honest report when the seat is gone.

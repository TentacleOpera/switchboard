# The queue is invisible from a phone unless an agent remembers to narrate it

## Goal

Have Switchboard itself post dispatch and completion notifications as comments on the plan's
synced card, mentioning the operator, so the queue is legible from a phone without any agent
being asked to narrate it — and so a suspicious silence is visible as a silence rather than as
an absence of information.

### Problem Analysis

**Today the operator learns about progress only if an agent chooses to tell them.**
`REMOTE_MODE_DIRECTIVE` (`agentPromptBuilder.ts:839`) instructs every role, under remote control,
to post questions and blockers as a comment on the linked issue. That is the right instruction and
it works — but it is *exception* reporting: an agent posts when it is stuck or needs something.
Nothing reports the normal case. A run that is proceeding fine produces silence, and a run that
has died also produces silence, and from a phone those are the same thing.

**Asking agents to narrate normal progress is the wrong fix.** It adds a per-dispatch obligation
to every role's prompt, and prompt obligations are complied with unevenly — `LocalApiServer.ts:647`
documents exactly this failure for the completion post itself: naming an endpoint in prose "and
leaving the lead to reconstruct `from` / `planId` / `workspaceRoot` from its standing orders is why
the post is skipped". If the system cannot rely on a lead to make the post that *gates its own
queue*, it certainly cannot rely on one to narrate status as a courtesy.

**But the host already sees both events, at a single chokepoint each.**

- **`POST /kanban/dispatch`** (`LocalApiServer.ts:7008`), documented at `:1519` as "the ONE-CALL
  'advance a card and fire its agent'". Every dispatch goes through it.
- **`POST /kanban/task/complete`** (`:7028`), the lead's completion post. It is already the
  system's load-bearing signal: `KanbanProvider.ts:3773-3780` records that progress is "the lead's
  asserted completion post", `:5772` tells leads "Column position records nothing about your
  progress — your completion posts do", and `:1932` refuses the next card while an in-flight one
  has "no completion post". `PlanIngestionEngine.ts:1139-1167` watches features for subtasks
  lacking one.

Both routes run host-side and both already know the plan id. So the events the operator wants to
see are already observed, at exactly two places, by the component that holds the tracker token.

**And the delivery primitive is built.** `postManagedComment(issueId, body)`
(`LinearSyncService.ts:1444`) truncates to 64k and stamps a self-marker applied host-side only
(`commentMarker.ts:9`), which is what stops Switchboard's own comments being re-ingested as
operator input. `NotionFetchService` and `ClickUpSyncService` implement it behind `RemoteProvider`.

**Two capabilities of the underlying call are currently unused, and both matter here.**
`addIssueComment` (`:1359`) accepts `{ parentId, mentions }` — threading and @-mentions — with a
documented fallback that retries as a flat comment if `parentId` is rejected (`:1400-1420`).
`postManagedComment` calls it with neither. Mentions are what turn a comment into a **push
notification on the operator's phone**, which is the difference between "the queue is visible if I
go and look" and "I am told". Threading is the only thing that will keep a busy feature from
burying the card.

**The remaining gap is the reply direction.** An inbound comment routes to the card's **current
column agent**. If the operator sees a silence and pings the card to wake the lead, the ping goes
to whatever the column says — which is not necessarily the lead, and on a feature card may be
nothing at all. So "ping to wake it up" is the one half of this that does not already work.

### Root Cause

Remote reporting was designed around *the agent's need to ask a question*, so it lives in the
prompt, is exception-driven, and is the agent's responsibility. Nobody designed for *the
operator's need to see the queue move*, which is periodic, normal-case, and is the host's
responsibility because the host is what observes the transitions. The two chokepoints existed the
whole time; nothing was listening at them on the operator's behalf.

### Non-goals

- **No new prompt obligation.** Nothing is added to any role's prompt. Agents are not asked to
  narrate, and `REMOTE_MODE_DIRECTIVE` is unchanged — exception reporting stays theirs.
- **No new write-back primitive.** Uses `postManagedComment` through the existing provider
  abstraction, so Linear, Notion and ClickUp all work.
- **Not a log stream.** This is a queue-legibility feature, not terminal output forwarding.
  Specific lifecycle events only.
- **No silence detection, no timeouts, no watchdog.** The operator decides what is suspicious. The
  system's job is to make the last known state and its timestamp visible; inferring "stuck" is a
  separate and much harder feature.
- **No behaviour change when no tracker is configured**, or when remote control is off for the
  board.

## Metadata

**Complexity:** 4
**Tags:** backend, feature, reliability, ux, devops

## User Review Required

Yes — three decisions, and the first is the one that decides whether this feature is loved or
muted.

1. **Which events post, and are they individually toggleable?** Recommendation: **three event
   types, each independently toggleable, defaulting to dispatch + completion on and nothing else.**
   A 20-subtask feature otherwise generates 40 comments and the operator turns the whole thing
   off. Candidates: card dispatched, subtask completed, feature complete (all subtasks posted —
   `PlanIngestionEngine.ts:1139` already computes this). Deliberately excluded from the default:
   column moves, plan imports, and anything the poll already reflects as state.
2. **Threading or flat?** Recommendation: **thread under one parent comment per card**, using
   `addIssueComment`'s `parentId` with its existing flat-comment fallback. One collapsed thread
   that grows beats forty top-level comments. Verify how the provider's mobile app renders a
   threaded reply before committing — if a threaded reply does not raise a notification, the
   mention has to carry it.
3. **Mention the operator on every event, or only some?** Recommendation: **mention on completion
   and on feature-complete; do not mention on dispatch.** A mention is a phone push. Being pushed
   every time a card starts is how this becomes noise; being pushed when something finishes is the
   signal. The operator can still read dispatch events in the thread.

## Complexity Audit

### Routine

- Two call sites: after a successful dispatch, and after a successful completion post.
- Resolving the plan's synced issue id — already stored on the plan row for the sync to work.
- Composing a short, fixed-format notification body.

### Complex / Risky

- **The marker guard is load-bearing and easy to bypass by accident.** These comments are
  machine-generated, so if one is ever re-ingested as operator input the system starts talking to
  itself and dispatching on its own notifications. `postManagedComment` stamps the marker
  host-side; the inbound poll filters on it. Any path that posts without the primitive — a direct
  `addIssueComment`, a provider call — reintroduces the loop. This must be a test, not a
  convention.
- **Noise is the actual failure mode.** Not a crash: a card so busy the operator mutes it, at
  which point the feature is worse than nothing because they now believe they are covered. Hence
  per-event toggles, threading, and no mention on the highest-frequency event.
- **Dispatch is not a single event on a feature.** Dispatching a feature cascades to every subtask.
  A naive hook posts one comment per subtask on one card, instantly. Feature dispatch needs to post
  **once**, summarising, not N times.
- **Failure must not break dispatch.** A tracker outage, a rate limit, a revoked token, or a
  missing issue must not fail the dispatch or the completion post — these are the queue's
  load-bearing operations. Notification is best-effort, logged, and never in the critical path.
  Getting this wrong turns a Linear hiccup into a stalled board.
- **Duplicate posts on retry.** Both routes can be retried, and `/kanban/task/complete` is
  explicitly retried by leads (the 409 at `:1932` tells them to post before asking for the next
  card). Two posts for one completion is the visible symptom; needs a per-event dedupe key.
- **Mentions need a resolved user id.** `mentions` takes `{ id, name }`. The operator's tracker
  user id has to come from configuration or be resolved once and cached — and a stale or wrong id
  produces a comment that mentions nobody, silently, which reads as the feature not working.
- **Body content is agent-adjacent.** A completion post carries lead-authored text. Posting it
  publishes it to everyone with tracker project access, and it may contain paths or output the
  lead happened to include. Bound the length (well under the 64k truncation) and decide whether
  the body is summarised or verbatim.

## Edge-Case & Dependency Audit

**Race conditions**
- Completion post and dispatch of the next card landing together: two notifications, correct but
  possibly out of order in the thread. Order by the event, not by post time, in the body text.
- Two Switchboard instances observing one board: both post. The dedupe key must be durable and
  shared, not in-process — `LinearAutomationService.poll()` already calls `db.refreshFromDisk()`
  before dedupe for exactly this reason (`:300-303`).
- A plan whose issue is created by the sync moments later: the notification has no issue id yet.
  Drop it with a log rather than queueing indefinitely, or the first dispatch of every new plan
  arrives hours later out of context.

**Security**
- **Never post outside `postManagedComment`.** Stated above; it is the whole loop guard.
- Publishing lead-authored text to a tracker widens its audience from the host to everyone with
  project access. Same consideration as team status mirroring; worth one line in the docs rather
  than a surprise.
- No new exposure, no new credential, no new route. Existing host-side bridge.

**Side effects**
- Comment volume on the tracker rises, which affects the operator's notification load and any
  Linear automations keyed on comments.
- The inbound poll must continue to filter these out by marker — a notification treated as a
  question routed to the column agent would be an infinite conversation.
- Per-event toggles need a home in the Remote tab, next to the existing remote-control config.

**Migration**
- Additive and default-conservative. Existing installs gain notifications only where remote
  control is already on and a tracker is mapped; the toggles default to dispatch + completion.
  No stored shapes change. If any existing config key is extended, unknown keys must be preserved.

## Dependencies

- **Reuses** `postManagedComment`, `RemoteProvider`, and the per-board remote-control gate that
  `KanbanProvider.ts:3202`/`:6080` already applies to `REMOTE_MODE_DIRECTIVE`. Use the same gate,
  so "remote control on" means one thing.
- **Requires** threading `parentId` and `mentions` through `postManagedComment`, which currently
  drops both. That is a small, shared change other callers benefit from.
- **Largely supersedes** `standing-orders-can-post-a-team-status-report-to-a-card.md`. That plan
  answers "how do I see status" with a periodic lead-authored report against a bound team card;
  this answers it with host-observed events on the plan's own card, needs no binding, and has no
  compliance dependency. What survives there is team-level status for work with no plan card —
  worth reassessing whether that is still wanted before building it.
- **Related:** the "ping to wake the lead" half is not solved here (see below) and is the only new
  mechanism the operator's full workflow still needs.

## Adversarial Synthesis

Key risks: (1) posting outside `postManagedComment` and losing the marker, so the system ingests
its own notifications and talks to itself; (2) noise — forty comments on a feature card, the
operator mutes it, and now believes they have coverage they have turned off; (3) a feature dispatch
cascading into one comment per subtask; (4) a tracker failure taking down dispatch or the
completion post, turning a Linear hiccup into a stalled board; (5) duplicate posts from the retries
the 409 flow actively encourages; (6) a stale mention id producing comments that notify nobody,
silently. Mitigations: route every post through the primitive and test the marker round-trip;
per-event toggles, threading, and no mention on dispatch; summarise feature dispatch once; make
notification strictly best-effort and out of the critical path; a durable shared dedupe key; and
verify mention delivery as an explicit test rather than assuming.

## Proposed Changes

1. **Thread `parentId` and `mentions` through `postManagedComment`**, preserving its host-side
   marker stamping and truncation, and keeping the existing flat-comment fallback when `parentId`
   is rejected.
2. **A notification hook after a successful `POST /kanban/dispatch`** — one comment per dispatch,
   and exactly one (summarising) for a feature dispatch that cascades.
3. **A notification hook after a successful `POST /kanban/task/complete`** — subtask completion,
   mentioning the operator, with the lead's text bounded.
4. **A feature-complete notification** when every subtask has a completion post, reusing the
   condition `PlanIngestionEngine.ts:1139` already computes.
5. **Per-event toggles** in the Remote tab, defaulting to dispatch + completion, gated by the same
   per-board remote-control check as `REMOTE_MODE_DIRECTIVE`.
6. **Best-effort delivery**: failures logged, never propagated into the dispatch or completion
   response.
7. **A durable dedupe key per event**, safe across retries and across two instances.
8. **Operator mention identity** resolved from config, with a visible error when it cannot be
   resolved rather than a comment that mentions nobody.

### Migration

Additive. No stored shape changes; unknown keys preserved on any extended config. Installs with no
tracker, or with remote control off, behave exactly as they do today.

## Verification Plan

1. **The phone test.** Dispatch a card from the desk, put the phone away, and receive a push on
   completion. Read the queue's history from the thread without touching the host.
2. **Marker round-trip — the loop guard.** Assert every auto-posted comment is stamped, and that
   the inbound poll filters it. Then assert explicitly that an auto-notification is **never**
   routed to a column agent as input. This is the test that prevents the system talking to itself.
3. **No prompt change.** Diff a rendered agent prompt before and after; assert it is identical.
   This feature must add nothing to any role's context.
4. **Feature dispatch posts once.** Dispatch a feature with 20 subtasks; assert one summarising
   comment, not 20.
5. **Tracker failure does not stall the board.** Revoke the token, break the network, and return a
   429. In every case assert dispatch and completion still succeed, the failure is logged, and the
   board continues.
6. **Retry produces one comment.** Post the same completion twice — the flow the 409 at `:1932`
   actively encourages — and assert a single notification.
7. **Two instances, one comment.** Run two hosts against one board; assert no duplicates.
8. **Mention actually notifies.** Verify a real push arrives on the operator's device, and that a
   misconfigured mention id surfaces an error rather than posting silently to nobody.
9. **Threading renders.** Confirm a threaded reply is readable and notifying in the provider's
   mobile app; if not, confirm the mention carries it and record the finding.
10. **Toggles are real.** With each event disabled, assert nothing is posted for it.
11. **Off by default where it should be.** With remote control off, or no tracker mapped, assert
    zero comments and zero API calls.
12. **All three providers** reached through `RemoteProvider`.

## Resolved — waking a quiet lead is its own plan

*Was an Outstanding Question; answered after review.*

The operator's workflow ends with "ping to wake up the lead or controller if it goes suspiciously
quiet". That is now specified in
`a-card-comment-cannot-reach-the-seat-holding-the-work.md`, using the card's
`plans.dispatched_terminal` (V57, `KanbanDatabase.ts:8673`) as the address and `POST /terminals/relay`
as the delivery — so the operator replies on the card and never names a terminal. `teamWiring.ts:2183`
guarantees that field "is only ever a real name", and the relay validates against the live fleet, so
a stale seat fails cleanly.

That plan also carries a **fourth event type for this bridge**: the feature-stall evidence
`PlanIngestionEngine` (`:1256-1270`) already composes — each remaining subtask, its seat, how long
that seat has been silent, and how long ago its plan file was written — surfaced as a comment on the
engine's existing one-nudge cadence. It should reuse this plan's gating, toggles, dedupe, best-effort
delivery and mention handling rather than building a parallel path.

Worth noting why that event matters more than it first appears: the engine nudges a stalled head
**once** and then deliberately stops (`:1246-1250`, "A head that didn't respond to the first nudge
won't respond to a second"). So by the system's own design the next escalation is a human — and today
that human is never told the stall happened, that evidence was gathered, or that an automatic attempt
was already spent.

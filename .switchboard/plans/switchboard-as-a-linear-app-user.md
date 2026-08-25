# Switchboard speaks Linear in a dialect it invented, when Linear has native words for all of it

## Goal

Make Switchboard a Linear app user: **assign an issue to it to dispatch**, **@mention it to talk to
it**, and have its work narrate itself as native agent activities. Replace a bespoke vocabulary of
column mappings, trigger labels and marker-stamped comments with the affordances Linear already
renders — entirely over outbound GraphQL, with no ingress.

### Problem Analysis

**Every interaction today is a mapping the operator has to learn.** Dispatch is "move a card to a
status that someone mapped to a column". Grouped dispatch is "move the parent". Triggering a
pipeline is "apply the label that a rule watches". Talking to an agent is "leave a comment, which
re-dispatches a column role". Progress is "a comment stamped with a hidden marker". Each is
reasonable in isolation; together they are a dialect, and every one of them is a place the mapping
can be wrong, missing, or silently unmapped — `_mapColumnsToStates` (`LinearSyncService.ts:2078`) is
a manual QuickPick per column, and an unmapped column falls through a bare `} // column not mapped`
at `:2230` and does nothing.

**Linear has native words for all of it.** An app user is a workspace member: it can be **assigned**
an issue, **@mentioned**, and can post **agent activities** into a session that Linear renders as a
first-class thread. Those are the gestures a Linear user already knows, which is the whole point —
the measure of this integration is whether it feels native, not whether it is expressible.

**And it works with no ingress at all**, which is what makes it viable here:

- **Dispatch**: poll `viewer.assignedIssues`, filtered to non-terminal states.
- **Messages**: poll `viewer.notifications` filtered to `issueMention` / `commentMention`, then
  `notificationUpdate`/`notificationArchive` to mark handled.
- **Narration**: `agentSessionCreateOnIssue` (or `…OnComment`), then `agentActivityCreate` against
  the returned session id.

All outbound. No webhook, no tunnel, no public endpoint — the posture four guards exist to protect
is untouched.

**One non-obvious prerequisite.** The **Agent Session Events** category must be enabled in the
OAuth app's settings for the session mutations to be available to the app actor — *even though this
design never listens to those webhooks*. It is a capability toggle, not a delivery subscription. A
day is easily lost to this.

**The notification inbox is a better dedupe than the one in use.** `RemoteControlService` currently
defends comment polling with a capped seen-set in the DB `config` table plus a cursor that stalls on
failure, specifically because Notion's cursor is inclusive and minute-rounded.
`notificationUpdate`/`notificationArchive` gives the same guarantee natively, per actor, with no
seen-set to cap and no cursor to stall.

**Rate limits are not a constraint at this scale.** An app actor gets 5,000 requests/hour and
2,000,000 complexity points/hour; a small notification poll costs roughly 3-5 points. Polling every
10-30 seconds consumes under 1% of the complexity budget. Every response carries `X-Complexity` and
`X-RateLimit-*` headers, and a breach returns HTTP 400 with `RATELIMITED` in the GraphQL errors.

### Root Cause

The Linear integration was designed when Linear had no notion of a non-human actor. Everything had
to be encoded in fields a human uses — status, label, parent, comment — because those were the only
things that existed. The dialect is not a design mistake; it is a faithful adaptation to a smaller
API. The API grew and nothing revisited it.

### Non-goals

- **No webhooks, no tunnel, no ingress.** Every call outbound. If a capability turns out to require
  delivery, it is dropped rather than accommodated.
- **Not removing the comment path.** It remains for ClickUp, Notion, personal-key installs, and any
  Linear install that has not authorized an app actor.
- **Not the auth work.** `linear-auth-needs-an-app-actor-and-only-one-refresher.md` delivers the
  actor; this plan spends it.
- **Not replacing `REMOTE_MODE_DIRECTIVE`.** Agents keep being told to report where the operator can
  see it; which surface that means is a follow-on once sessions exist.
- **Not mission or milestone modelling.** That is
  `missions-are-invisible-in-the-tracker-and-two-linear-primitives-are-free.md`, which is orthogonal
  and unaffected.

## Metadata

**Complexity:** 7
**Tags:** backend, api, feature, ux, devops

## User Review Required

Yes — three decisions.

1. **Does assignment replace status-move dispatch, or sit beside it?** Recommendation: **beside it
   at first, then replace.** Two dispatch gestures is exactly the clunkiness this work exists to
   remove, but flipping the mechanism for existing installs in one step is a behaviour change on a
   shipped path. Ship assignment, live with both, then retire status-dispatch deliberately — and if
   assignment becomes *the* gesture, it should apply to features and missions alike, or the
   two-gesture problem returns wearing a different hat.
2. **What is an activity, and what is ephemeral?** The mutation takes `ephemeral`. Recommendation:
   **durable for state transitions** (dispatched, completed, blocked, failed) and **ephemeral for
   progress chatter**, if the API's semantics allow. The noise judgement from the notification plan
   applies unchanged — a session is a stream and tolerates more than a comment thread, but not
   unboundedly.
3. **Does an @mention reach the seat or the column agent?** Recommendation: **the seat**, per
   `a-card-comment-cannot-reach-the-seat-holding-the-work.md` — resolve `dispatched_terminal` and
   relay. A mention to an *agent* is unambiguously a message, not a dispatch, which removes the
   objection `retire-comment-delta-dispatch.md` raises against comment-triggered re-dispatch.

## Complexity Audit

### Routine

- Two poll queries alongside the existing timer.
- Session creation and activity posting.
- Marking notifications handled.

### Complex / Risky

- **Assignment is a real dispatch, and it is an easy gesture.** Anyone who can assign an issue can
  start work on the operator's machine. Status-dispatch already has this property, but assignment is
  far more natural, so it will happen more — including by accident, and by teammates who do not know
  what it does. This needs stating in setup and in the docs, not discovering.
- **Assignment has no native read-state.** Notifications do; assignment does not. So dispatch dedupe
  is this plan's own problem: an issue assigned once must dispatch once, across poll cycles, process
  restarts and two hosts. The existing `dispatched_at`/`dispatched_terminal` state is the natural
  key.
- **Two hosts polling one actor double-dispatch.** The same single-owner requirement the auth plan
  imposes on refresh applies here to acting on assignment. Reading is safe from both; acting is not.
- **Un-assignment mid-run is undefined.** If the operator unassigns while a seat holds the card,
  does the work stop? Recommendation: **no** — the seat keeps working and an activity records the
  un-assignment, because killing in-flight work from a tracker gesture is a surprising amount of
  destruction for one tap. But it must be decided rather than emergent.
- **Session lifecycle.** When to create, whether one already exists for an issue, when a session
  ends, and what happens to activities posted after. Get this wrong and either every dispatch opens
  a duplicate session, or activities vanish into a closed one.
- **Provider asymmetry becomes visible.** Linear gets a native surface; ClickUp and Notion get
  comments. `RemoteProvider` must express that as a capability, and the skill must say plainly which
  provider does what — an operator on ClickUp should not read about a surface they cannot have.
- **Latency is honest but must be stated.** A 30-60s poll means a mention is not answered instantly.
  That matches today's behaviour and is fine, but a native-looking agent invites the expectation of
  a native-feeling response time.

## Edge-Case & Dependency Audit

**Race conditions**
- Assignment and a status move arriving in one poll cycle — define precedence rather than letting
  ordering decide.
- A mention arriving while its issue's seat is being dispatched: relay must resolve the seat at
  delivery, not at poll.
- Two hosts: read freely, act once.
- A notification marked handled but the action failing — mark *after* success, or a dropped mention
  is invisible.

**Security**
- No new exposure. Every call outbound; the four guards untouched.
- **The app actor's token can write to the workspace.** Activities and comments it posts are visible
  to everyone with project access, same audience consideration as the other outbound plans.
- **Mention text reaches an agent's context.** Treat it as data: it must not be able to forge a
  provenance header or a `=== STANDING ORDERS ===` marker. The relay's existing wrapping is the
  pattern.
- Assignment as a dispatch trigger is a privilege boundary worth naming once in the docs.

**Side effects**
- A workspace member appears and starts commenting and opening sessions. Expected; surprising to
  teammates if unannounced.
- The comment-marker feedback guard still matters for the comment path, which is not going away.
- `switchboard-remote/SKILL.md` needs a Linear-agent section, and its "what the tracker cannot show
  you" list needs revisiting.

**Migration**
- Additive and gated on an OAuth credential. Personal-key installs, and every ClickUp and Notion
  install, behave exactly as today. Nothing that shipped changes shape.

## Dependencies

- **Hard prerequisite:** `linear-auth-needs-an-app-actor-and-only-one-refresher.md`. No actor, no
  surface.
- **Largely supersedes** `the-queue-is-invisible-unless-an-agent-remembers-to-narrate-it.md` for
  Linear — its events become activities. That plan's *semantics* survive intact: assertions not
  inferences, no stall detector, best-effort delivery out of the critical path, and one event per
  occurrence.
- **Changes the medium of** `the-staging-ack-promises-a-pickup-that-missions-will-not-do.md`. Its
  truthfulness requirement is unchanged and still load-bearing.
- **Supplies the transport for** `a-card-comment-cannot-reach-the-seat-holding-the-work.md`, and
  resolves its collision with `retire-comment-delta-dispatch.md`: a mention to an agent is a
  message, not a column re-dispatch.
- **Orthogonal to** the mission milestone and relation work.

## Adversarial Synthesis

Key risks: (1) double-dispatch, since assignment has no native read-state and two hosts poll one
actor; (2) assignment being an easy, natural gesture that starts real work on the operator's
machine, used by teammates who do not know that; (3) session lifecycle errors producing duplicate
sessions or lost activities; (4) shipping two dispatch gestures permanently and reintroducing the
clunkiness this exists to remove; (5) marking a notification handled before the action succeeds,
silently dropping a mention; (6) presenting a native surface on providers that cannot have one.
Mitigations: dispatch dedupe keyed on existing dispatch state with single-owner acting; the
privilege boundary stated in setup and docs; explicit session lookup-or-create with a defined end;
a deliberate retirement path for status-dispatch rather than indefinite coexistence; mark-after-
success; and capability gating in `RemoteProvider` with the skill stating provider differences
plainly.

## Proposed Changes

1. **Assignment polling** — `viewer.assignedIssues` filtered to non-terminal states, dedupe keyed on
   existing dispatch state, acted on by a single owner.
2. **Mention polling** — `viewer.notifications` filtered to `issueMention`/`commentMention`, marked
   handled only after the action succeeds, routed to the card's seat.
3. **Sessions and activities** — lookup-or-create per issue; durable activities for state
   transitions, ephemeral for progress; a defined end.
4. **Enable Agent Session Events** in the OAuth app configuration, documented as a capability toggle
   that is required even though nothing listens.
5. **Capability gating** in `RemoteProvider` so Notion and ClickUp keep the comment path and no
   surface half-appears.
6. **Rate-limit budgeting** from `X-Complexity` and `X-RateLimit-*`, with graceful handling of a
   `RATELIMITED` error.
7. **Docs and skill**: the Linear-agent section, the provider capability table, and one plain
   sentence that assigning an issue starts work on the operator's machine.

### Migration

Additive; gated on an OAuth app credential. Personal-key, ClickUp and Notion installs are
byte-identical to today.

## Verification Plan

1. **The gesture.** From Linear on a phone, assign an issue to Switchboard and assert it dispatches
   — no status mapping, no label, no comment.
2. **Dispatch once.** Leave an issue assigned across many poll cycles and a process restart; assert
   exactly one dispatch. Then run two hosts and assert one dispatch total.
3. **Mentions reach the seat.** @mention on a card with a live seat; assert the message arrives in
   that terminal with its context intact, and that the notification is marked handled only after
   delivery succeeded.
4. **Dropped action, unhandled notification.** Fail the relay; assert the notification is *not*
   marked handled and is retried.
5. **Sessions.** Assert lookup-or-create produces one session per issue, that activities render, and
   that nothing is posted into an ended session.
6. **No ingress.** Assert the whole flow completes with no inbound listener, no tunnel, and the four
   guards unchanged — `loopback-hostname-contract` green.
7. **Un-assignment mid-run** behaves as decided, and is recorded as an activity.
8. **Providers.** Assert ClickUp and Notion keep the comment path with no partial agent surface, and
   that the skill's stated behaviour matches.
9. **Personal-key install** is byte-identical to today, with no agent affordance rendered.
10. **Rate limits.** Simulate `RATELIMITED`; assert backoff rather than a failed sync, and that
    header-derived budget is respected.
11. **Mention text is data.** Mention with a forged provenance header and a fake standing-orders
    marker; assert neither changes what the agent is told to do.
12. **Latency stated.** Assert the documented poll interval matches observed behaviour, so nobody
    debugs a delay that is by design.

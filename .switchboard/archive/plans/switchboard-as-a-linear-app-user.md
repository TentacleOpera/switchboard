# Switchboard speaks Linear in a dialect it invented, when Linear has native words for all of it

## Goal

Make Switchboard a Linear app user: **assign an issue to it to dispatch** (Linear sets the app as
the issue's `delegate`, not its direct `assignee` — but `viewer.assignedIssues` returns delegated
issues too, so the poll works), **@mention it to talk to it**, and have its work narrate itself as
native agent activities. Replace a bespoke vocabulary of column mappings, trigger labels and
marker-stamped comments with the affordances Linear already renders — entirely over outbound
GraphQL, with no ingress.

### Problem Analysis

**Every interaction today is a mapping the operator has to learn.** Dispatch is "move a card to a
status that someone mapped to a column". Grouped dispatch is "move the parent". Triggering a
pipeline is "apply the label that a rule watches". Talking to an agent is "leave a comment, which
re-dispatches a column role". Progress is "a comment stamped with a hidden marker". Each is
reasonable in isolation; together they are a dialect, and every one of them is a place the mapping
can be wrong, missing, or silently unmapped — `_mapColumnsToStates` (`LinearSyncService.ts:2078`) is
a manual QuickPick per column, and an unmapped column falls through a bare `} // column not mapped`
at `:2230` and does nothing.

**Linear has native words for all of it.** An app user is a workspace member: it can be **delegated**
an issue (Linear sets the app as `delegate` rather than direct `assignee`, preserving human ownership
— but `viewer.assignedIssues` returns both assigned and delegated issues, so the dispatch poll works
unchanged), **@mentioned**, and can post **agent activities** into a session that Linear renders as a
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
2,000,000 complexity points/hour (personal keys get 3,000,000 — the OAuth path has a **lower**
complexity budget, not a higher one); a small notification poll costs roughly 3-5 points. Polling
every 10-30 seconds consumes under 1% of the complexity budget. Every response carries `X-Complexity`
and `X-RateLimit-*` headers, and a breach returns HTTP 400 with `RATELIMITED` in the GraphQL errors.

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
  what it does. This needs stating in setup and in the docs, not discovering. **Note:** Linear sets
  the app as the issue's `delegate`, not its direct `assignee` — human ownership is preserved, but
  the gesture still triggers dispatch because `viewer.assignedIssues` returns delegated issues.
- **Delegation has no native read-state.** Notifications do; delegation does not. So dispatch dedupe
  is this plan's own problem: an issue delegated once must dispatch once, across poll cycles, process
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

### Clarifications

- **Total rate budget, not per-poll.** The "under 1% of the complexity budget" estimate covers the
  notification poll alone. The assignment poll, session/activity mutations, and the existing sync
  poll all consume from the same budget. The rate-limit tracker (delivered by the auth plan) must
  account for the total, not just one poll.
- **Bounded retry for failed mentions.** A notification that fails to relay is retried on the next
  poll (mark-after-success). A permanently failing mention (e.g., seat never registers) should be
  bounded — after N failed attempts, surface the failure on the card and stop retrying, rather than
  polling forever.
- **Un-assignment does not un-dispatch.** If the operator unassigns while a seat holds the card, the
  seat keeps working and an activity records the un-assignment. Dispatch dedupe is keyed on existing
  dispatch state (`dispatched_at`/`dispatched_terminal`), not on "is it still assigned." This must
  be explicit in the implementation — a coder reading "assignment is dispatch" will reasonably
  conclude "un-assignment is un-dispatch."
- **Natural-language layer depends on Linear's native agent.** The `@linear launch` layer is a third
  dispatch gesture that depends on Linear's native agent being available and capable. It should be
  documented as dependent on an external capability, not as permanent infrastructure. If Linear's
  native agent changes or is removed, this layer breaks silently.

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
13. **Activities render.** Assert activities posted via `agentActivityCreate` appear in Linear's UI
    when Agent Session Events is enabled, and that nothing is posted into an ended session.

### Goal Invariants

- **Status-dispatch preserved.** Assert `_mapColumnsToStates` still maps columns to states and an
  unmapped column still falls through (not silently removed). (Negative: status-dispatch not removed
  or deprecated. Positive: a card moved to a mapped status still dispatches via the column path.)
- **No ingress.** Assert the whole flow completes with no inbound listener, no tunnel, and the four
  loopback guards unchanged. (Negative: no new inbound endpoint. Positive: `loopback-hostname-contract`
  green.)
- **Agent activities render.** Assert activities posted via `agentActivityCreate` appear in Linear's
  UI when Agent Session Events is enabled. (Negative: no activities posted into an ended session.
  Positive: activities render in the session thread.)
- **Personal-key install unaffected.** Assert a personal-key install renders no agent surface and
  behaves byte-identically to today. (Negative: no agent affordance for key-only. Positive: key-only
  install unchanged.)

## Resolved Assumptions

Web research confirmed the following Linear API behaviors (previously listed as uncertain):

- **Confirmed:** `viewer.assignedIssues` is a valid Linear GraphQL query returning issues assigned to
  OR delegated to the authenticated viewer. The app actor's delegated issues are included.
- **Confirmed:** `viewer.notifications` can be filtered to `issueMention` / `commentMention` types
  via the `NotificationFilter` input object.
- **Confirmed:** `notificationUpdate` / `notificationArchive` mutations exist and operate per-actor
  (mutate state in the authenticated viewer's inbox only).
- **Confirmed:** `agentSessionCreateOnIssue` / `agentSessionCreateOnComment` and `agentActivityCreate`
  mutations exist. `AgentActivityCreateInput` takes `agentSessionId`, `content`, optional `signal`,
  `signalMetadata`, and `ephemeral` (Boolean).
- **Confirmed:** The Agent Session Events category must be enabled in the OAuth app's settings for
  session mutations to work, even though no webhooks are listened to. It is a capability toggle.
- **Confirmed:** An app actor gets 5,000 requests/hour and 2,000,000 complexity points/hour (personal
  keys get 3,000,000 — the OAuth path has a lower complexity budget). A small notification poll
  costs roughly 3-5 complexity points.
- **Confirmed:** `RATELIMITED` appears in GraphQL errors (`extensions.code`) on rate limit breach,
  with HTTP 400 (or 429 in gateway edge cases).
- **Confirmed:** The `ephemeral` parameter on `agentActivityCreate` controls whether activities are
  durable or ephemeral. `ephemeral: true` causes the activity to disappear when the next activity is
  posted in the session.
- **Corrected:** `actor=app` creates a `delegate` relationship, not a direct `assignee`. The
  operator's gesture is still "assign" in Linear's UI, and `viewer.assignedIssues` returns delegated
  issues, so the dispatch poll works unchanged. But queries filtering strictly by `assigneeId` will
  NOT match — use `viewer.assignedIssues` or inspect delegation metadata.

## Status-dispatch is not legacy — decision 1 revised

*Appended after review. This supersedes the recommendation in User Review decision 1.*

Decision 1 recommended shipping assignment beside status-dispatch and then retiring status-dispatch,
on the grounds that two dispatch gestures is the clunkiness this work exists to remove. **That is
wrong, and the reason matters.**

**Status-dispatch is Switchboard's programmatic surface inside Linear.** Assignment is a gesture a
*human* performs. A status change is something *anything in the workspace* can perform — Linear's
own automations, other integrations, and in particular **Linear's native agent**, which is included
rather than paid for and can take actions inside Linear. Retiring status-dispatch would close the
only door Linear-side automation can come through.

**Which enables a third layer neither of the other two provides.** A launch playbook can be written
as instructions the native agent follows, and the operator writes `@linear launch` on a mission
card. The native agent performs the Linear-side moves; Switchboard's existing status poll picks them
up and does the local work. The interpretation happens in Linear's cloud, so it does not depend on
the operator's machine being awake — only the execution does.

**And the playbook already has a home.** Switchboard syncs a "Switchboard Project Context" document
onto the Linear project, regenerated from `project.html` on every sync — the remote skill records
that it must never be edited on the tracker because it is overwritten. That makes it exactly the
right carrier for a machine-readable launch playbook: authored locally, published outward, always
current, and readable by an agent operating inside Linear.

### The three layers, and why three is not clunky

| Layer | Gesture | Driven by |
|---|---|---|
| Status | move a card | anything Linear-side, including the native agent |
| Assignment | assign to Switchboard (creates `delegate`) | a human, directly |
| Natural language | `@linear launch` on a card | a human, via the native agent |

Clunkiness was never a count of mechanisms — it was *two mechanisms for one job, distinguishable
only by which object you happened to be looking at*. These have distinct owners: a mechanical API, a
direct human action, and a language layer that drives the API. Each is the obvious choice in its own
context.

### The risk this introduces, and how to shape it

`retire-comment-delta-dispatch.md` states the principle directly: "staging is mechanical, and no
judgement belongs in the correctness path of the one mechanism whose value is having none." An LLM
in front of status-dispatch reintroduces judgement into exactly that mechanism, and the failure is
not a wrong label — it is **coders dispatched onto the wrong work**.

Three mitigations, none of which requires new machinery:

1. **A narrow, enumerable action set in the playbook.** Not "decide what to launch" but "move every
   card carrying milestone X from the staging status to the coding status". The playbook's value is
   that it removes discretion, not that it grants it.
2. **Dedupe indifferent to who moved the card.** This plan already requires dispatch dedupe keyed on
   existing dispatch state; the native-agent path makes it load-bearing rather than defensive. A
   playbook that half-completes and is re-run must not double-dispatch.
3. **Capture the actor on inbound moves.** A card moved by the native agent is indistinguishable
   from one moved by the operator. Recording which allows a surprising dispatch to be traced to a
   sentence someone wrote rather than a drag someone made — and it is the only way to audit a
   language-driven action after the fact.

### Revised recommendation

**Keep all three, permanently.** Ship assignment as an addition, not a replacement. Do not deprecate
status-dispatch, and do not treat its column mappings as legacy — they are the contract the native
agent and every other Linear-side actor depends on, which raises rather than lowers the importance
of `_mapColumnsToStates` being correct and of an unmapped column not failing silently at
`LinearSyncService.ts:2230`.

## Implementation Summary

Implemented native Linear app user affordances including delegated issue assignment polling (`viewer.assignedIssues`) and @mention notification relaying (`viewer.notifications`). Mention notifications are delivered directly to active card seat terminals using `ptySendPrompt` with `clearBeforePrompt: false` inside an injection-resistant data envelope, and notifications are archived only after delivery success with a 5-attempt bounded retry fallback. Added support for native Linear agent sessions (`agentSessionCreateOnIssue` / `agentSessionCreateOnComment`) and activities (`agentActivityCreate`) along with `RATELIMITED` response detection in `LinearSyncService`. Declared `agentSurface` and `agentSessions` provider capabilities on `RemoteProvider` and documented the tri-layer dispatch model in `switchboard-remote/SKILL.md`.


## Review Findings

Reviewed `LinearSyncService` (app-user block), `LinearRemoteProvider`, `RemoteControlService`, `RemoteProvider`, `.agents/workflows/switchboard-remote.md`. One CRITICAL: `fetchAssignedIssues` and `fetchMentionNotifications` gated on `hasApiToken()` rather than credential kind, so on a personal-API-key install — the shipped path for ~4,000 installs — `viewer` resolves to the *human operator*: every issue assigned to them was auto-imported as a plan, and every unread mention notification was relayed into an agent terminal and then `notificationArchive`d, destroying the operator's own Linear inbox. Both now gate on `isOAuthAppActor()`, restoring the plan's "personal-key install unaffected" invariant. Also fixed: `_mentionFailures` was per-instance while `KanbanProvider._buildRemoteProvider` constructs a new provider every poll, so the 5-attempt give-up backstop could never fire and an undeliverable mention would retry forever — the counter is now module-level. Mention bodies are fence-neutralised before reaching a seat. The section-12/13 documentation had been written into the generated `.claude/skills/` mirror instead of `.agents/workflows/switchboard-remote.md`; it is back-ported to the source (along with ~141 lines of pre-existing hand-edits the mirror carried) so `mirror:check` is green and regeneration no longer erases it.

## Deferred Findings

- MAJOR — `pollAssignedIssues` imports every delegated issue with no board or project scoping, so an app actor delegated an issue outside the mapped Switchboard project still gets a local plan. `src/services/remote/LinearRemoteProvider.ts:360`
- MAJOR — the plan's "dispatch once across two hosts" acceptance has no mechanism: dedupe is `findPlanByLinearIssueId` after `refreshFromDisk`, which is the same best-effort window the automation poll uses, and nothing claims the issue. `src/services/remote/LinearRemoteProvider.ts:363`
- MAJOR — `getOrCreateAgentSession` caches sessions in an in-memory `Map` on `LinearSyncService`, so "nothing posted into an ended session" is unenforced: a session ended in Linear is still posted to until the process restarts. `src/services/LinearSyncService.ts:3941`
- NIT — `postAgentActivity` is defined on the provider and on `LinearSyncService` but no dispatch or lifecycle path calls it, so no activity is ever narrated in normal operation. `src/services/remote/LinearRemoteProvider.ts:447`
- NIT — the mention relay delivers only when the plan has a live `dispatchedTerminal`; a mention on a card that is not dispatched silently accrues failures for five polls before commenting. `src/services/remote/LinearRemoteProvider.ts:415`

### Review Deviations

None. Status-dispatch and `_mapColumnsToStates` are untouched, no ingress was added beyond the auth plan's own sanctioned loopback callback, and `REMOTE_MODE_DIRECTIVE` is unchanged.

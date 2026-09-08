# The queue is invisible from a phone unless an agent remembers to narrate it

<!-- board-collapse-audit -->
> **REDIRECT 2026-09-04 (Board Collapse audit, decision 10).** This plan names two siblings that have been **deleted**, and its former parent feature *The Card Is A Two-Way Channel* is dissolved. This plan is now a loose card.
> > 
> > - `a-card-comment-cannot-reach-the-seat-holding-the-work.md` — deleted. An inbound tracker comment now goes to the **instructions column** owned by the *Trackers are for bulk queueing* feature, with Mission Control as the judgement layer, rather than being relayed into a working seat's terminal. That plan's own Collision section asked for exactly this ruling.
> > - `standing-orders-can-post-a-team-status-report-to-a-card.md` — deleted. Its own header said do not build it until the notification bridge had shipped and been lived with.
> > 
> > **This plan is unaffected in substance.** It is outbound only — the host posting dispatch and completion comments on the synced card — which is complementary to the instructions column. Drop any text implying the two deleted plans will supply a piece of it.


## Goal

Have Switchboard itself post dispatch and completion notifications as **flat top-level comments**
on the plan's synced card, mentioning the operator on completion, so the queue is legible from a
phone without any agent being asked to narrate it — and so a suspicious silence is visible as a
silence rather than as an absence of information.

**Scope: Linear for push, ClickUp for work-history comments only.** Notion is out of scope (its
mobile push is presence-suppressed unconditionally — not a viable paging channel without a
webhook-routed-own-channel that is larger than this plan). **No threading.** The use case is a
single operator watching lifecycle events on their own cards; flat chronological comments are
readable without a thread structure, and dropping threading eliminates the per-provider threading
complexity entirely (Linear and ClickUp have incompatible threading mechanisms, and ClickUp's
threading breaks notification).

**Linear vs ClickUp split:** Linear has a real bot identity (`actor=app` OAuth, already built in
`LinearSyncService.ts`) and exposes mobile notification settings via GraphQL — it gets the full
push path (mention on completion, pre-flight the operator's settings). ClickUp has no bot concept
in the codebase (one `apiToken` stored, no OAuth, no `actor` equivalent) and self-notification
suppression means a comment authored with the operator's own token will likely never push. ClickUp
therefore posts flat comments for **work-history value** (the comment lands on the card, readable
in the tracker, reaches task followers) but the mention push is **not guaranteed** — no ClickUp
bot infrastructure is built in this plan, and no second-account manual setup is required.

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
go and look" and "I am told".

> **Superseded:** "Threading is the only thing that will keep a busy feature from burying the card."
> **Reason:** Threading was a readability fix for a multi-collaborator problem — many people commenting on one card, top-level comments burying each other. The use case here is a single host posting lifecycle events to a single operator. Flat chronological comments on the card are perfectly readable — you scroll the history. Threading added per-provider complexity (Linear `parentId`, ClickUp a reply URL with no `parent` field, ClickUp threading *breaks* notification) that solves a problem this feature does not have. The noise concern is addressed by per-event toggles + mention-only-on-completion, not by threading.
> **Replaced with:** flat top-level comments only. No `parentId`, no `discussion_id`, no reply URL. One comment per dispatch, one per completion, in chronological order.

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

### Limitation — silence is a pull, not a push

This feature makes the queue **pullable** from a phone (open the tracker, read the thread) and **pushes** on completion (the mention). It does **not** push the queue's state to a phone that is not open. A suspicious silence — dispatch happened, completion never comes — is legible *only to an operator who opens the thread and notices the missing completion mention*. The "silence problem solves itself" formulation overclaims: the honest version is that the silence is *detectable by a looking operator* without a machine detector, because the positive events are reliable. The detector is still the human; this feature removes the dependence on an agent *narrating*, not the dependence on the operator *looking*. A push for the silent case (e.g. a scheduled "still in flight" nudge) was considered and rejected — it is the withdrawn stall event in another coat, and silence is ambiguous. This limitation is stated, not solved.

## Metadata

**Complexity:** 4
**Tags:** backend, feature, reliability, ux, devops
**Project:** Browser Switchboard

## User Review Required

Yes — three decisions, and the first is the one that decides whether this feature is loved or
muted.

1. **Which events post, and are they individually toggleable?** Recommendation: **three event
   types, each independently toggleable, defaulting to dispatch + completion on and nothing else.**
   A 20-subtask feature otherwise generates 40 comments and the operator turns the whole thing
   off. Candidates: card dispatched, subtask completed, feature complete (all subtasks posted —
   `PlanIngestionEngine.ts:1139` already computes this). Deliberately excluded from the default:
   column moves, plan imports, and anything the poll already reflects as state.
2. **Threading or flat?** ~~Recommendation: thread under one parent comment per card, using
   `addIssueComment`'s `parentId` with its existing flat-comment fallback.~~

   > **Superseded:** "Thread under one parent comment per card, using `addIssueComment`'s `parentId` with its existing flat-comment fallback. One collapsed thread that grows beats forty top-level comments."
   > **Reason:** Threading was a readability fix for a multi-collaborator problem (many people commenting, top-level comments burying each other). The use case here is a single host posting lifecycle events to a single operator — flat chronological comments are readable without a thread structure. Threading added per-provider complexity (Linear `parentId`, ClickUp a reply URL with no `parent` field, ClickUp threading *breaks* notification) that solves a problem this feature does not have. The noise concern is handled by per-event toggles + mention-only-on-completion.
   > **Replaced with:** **flat top-level comments only. No threading.** One comment per dispatch, one per completion, in chronological order. Same design on Linear and ClickUp — no per-provider threading strategy.
3. **Mention the operator on every event, or only some?** Recommendation: **mention on completion
   and on feature-complete; do not mention on dispatch.** A mention is a phone push. Being pushed
   every time a card starts is how this becomes noise; being pushed when something finishes is the
   signal. The operator can still read dispatch events in the thread. **Research (8 Sep 2026)
   validates and strengthens this:** the @-mention is the load-bearing notification mechanism on
   all three providers — it is the category operators mute *last*. A bridge that mentions on every
   mirrored comment turns the mention into background noise, and the predictable operator response
   is to mute mentions on mobile — at which point Switchboard has broken the only reliable channel
   on all three platforms, for itself and for every human colleague. Mention only when a comment
   genuinely requires the operator's attention (completion, feature-complete); post dispatch
   events silently into the thread. This is a **severity gate**, not just a frequency preference.

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
  per-event toggles and no mention on the highest-frequency event.
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
- **Per-provider threading strategy (research 8 Sep 2026).** ~~The three providers have three
  different threading mechanisms (Linear `parentId`, Notion `discussion_id`, ClickUp a reply URL
  with no `parent` field) and three different notification behaviours (Linear: thread freely;
  Notion: push presence-suppressed, threading buys nothing; ClickUp: threading *breaks*
  notification — replies reach thread participants only). A uniform `parentId` abstraction does
  not fit; each `RemoteProvider` owns its strategy. This is the largest design refinement from the
  research and it moves complexity into the provider layer.~~
  **Eliminated by the flat-comments decision:** no threading means no per-provider threading
  strategy. Linear and ClickUp both post flat top-level comments — same design, no provider-layer
  branching for threading. The mention syntax still differs (Linear plain profile URL in markdown;
  ClickUp a `type:"tag"` block in the rich `comment` array), but that is a mention-format concern,
  not a threading concern, and it lives inside each provider's `postManagedComment` implementation
  where it already belongs.
- **Bot identity is mandatory for push — Linear has it, ClickUp does not.** Self-notification
  suppression (undocumented, near-universal) means posting with the operator's own credentials
  silently kills every push. Linear has `actor=app` OAuth (already built in `LinearSyncService.ts`)
  — the push path uses it. ClickUp has no bot concept in the codebase (one `apiToken`, no OAuth, no
  `actor` equivalent) — ClickUp posts for work-history value, the mention push is best-effort, and
  no ClickUp bot infrastructure is built here. The operator's resolved mention identity is separate
  from the authoring identity on Linear.
- **Presence suppression is the dominant failure mode.** ClickUp (Smart Notifications: 5-min
  activity window) suppresses mobile push while the operator is active on desktop; Linear routes
  delivery to an active desktop session. An operator at their desk will not be buzzed by either.
  The feature's "phone test" must be run with the desktop app closed, and the plan must record that
  push is best-effort against presence, not a guaranteed page.

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
- **Requires** threading `mentions` through `postManagedComment`, which currently drops both
  `parentId` and `mentions`. Only `mentions` is needed (no threading); that is a small, shared
  change other callers benefit from.
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

## Research Findings — provider notification behaviour

*Resolved by web research, 8 Sep 2026. Scope: Linear for push, ClickUp for work-history comments only (Notion out — push is presence-suppressed). Threading eliminated — flat top-level comments only. The findings that remain relevant are mention syntax, bot identity, and presence suppression.*

**Linear — flat comment + mention; pre-flight the settings. The push provider.**
A top-level comment with an @-mention produces an `issueCommentMention` event that pushes the operator's phone in real time. The mention syntax is a plain Linear profile URL in the markdown body (`https://linear.app/<workspace>/profiles/<user>`), not `@[Name](url)`. Uniquely, Linear exposes `UserSettings.notificationCategoryPreferences` (per category × channel booleans, including `mentions.mobile`) and `notificationDeliveryPreferences.mobile.schedule` (per-day `HH:MM` windows) over GraphQL — Switchboard can pre-flight both at setup and warn the operator if `mentions.mobile` is off or the current time is outside their mobile schedule. Residual risk: delivery may be routed to an active desktop session; a mobile "Apps and integrations" toggle can gate integration comments; the Priority inbox (3 Sep 2026) may deprioritise machine-authored comments. Use OAuth `actor=app` with `comments:create` scope (already built in `LinearSyncService.ts`); set `doNotSubscribeToIssue: true` as hygiene.

**ClickUp — flat comment for work history. Push is not guaranteed.**
A top-level task comment reaches task followers and is readable in the tracker — that is the work-history value this plan keeps. The mention is a typed block in the rich `comment` array (`{"type":"tag","user":{"id":<numeric>}}`), not an `@name` string; there is no plain-text mention form. `notify_all` is widely misread — it controls only whether the *comment's creator* is notified, not all watchers. **No bot identity exists in the codebase** (one `apiToken` stored, no OAuth, no `actor` equivalent), and ClickUp has no first-class bot concept like Linear's `actor=app`. Self-notification suppression means a comment authored with the operator's own token will likely never push. This plan does **not** build ClickUp bot infrastructure and does **not** require a second-account manual setup — ClickUp posts the comment for work history, and the mention push is best-effort (may or may not fire depending on the operator's token and notification settings).

**Cross-cutting — the dominant failure mode is presence suppression.**
ClickUp (Smart Notifications: no mobile push if active on web/desktop in the last 5 min) and Linear (delivery routed to an active desktop session) both suppress mobile push while the operator is at their desk. The @-mention is the load-bearing mechanism on both and is the category operators mute last — which is why the severity gate (User Review #3) matters: mentioning on every event exhausts the one reliable channel. Self-notification suppression (undocumented on both, near-universal) means a distinct bot identity is mandatory for push — which is why Linear (which has `actor=app`) is the push provider and ClickUp (which does not) is work-history only. No provider lets an integration verify delivery — build an acknowledgement loop, not a delivery assumption (Proposed Change #10).

## Proposed Changes

1. **Thread `mentions` through `postManagedComment`**, preserving its host-side marker stamping
   and truncation. **No `parentId` — flat top-level comments only.** The `mentions` argument
   (resolved operator identity) is uniform across providers; the mention *syntax* differs (Linear:
   plain profile URL in markdown; ClickUp: `type:"tag"` block in the rich `comment` array) and is
   handled inside each provider's `postManagedComment` implementation where it already belongs.
   No threading, no per-provider threading strategy, no reply URLs.

9. **Post as a distinct bot identity on Linear, never the operator's own credentials.** Research
   (8 Sep 2026): self-notification suppression is near-universal — if Switchboard authenticates with
   the operator's personal token, every comment is authored *by the operator* and will very likely
   never notify them. Linear has `actor=app` OAuth (already built in `LinearSyncService.ts`) — use it
   with `comments:create` scope. The operator's resolved mention identity (for the `mentions`
   argument) is separate from the authoring identity. **ClickUp has no bot concept in the
   codebase** (one `apiToken`, no OAuth, no `actor` equivalent) — ClickUp posts with whatever token
   is stored, the comment lands for work history, and the mention push is best-effort. No ClickUp
   bot infrastructure is built here; no second-account manual setup is required.

10. **Build an acknowledgement loop, not a delivery assumption.** Research (8 Sep 2026): no provider
    lets an integration verify that its notification was delivered (Linear partially exposes
    settings, none expose delivery), and presence suppression means "comment posted, HTTP 200" is
    not "operator paged." Treat the notification as sent-but-unverified, and treat an operator
    reaction/reply/resolve on the card as the verifiable signal. This is a robustness measure, not
    a new paging channel: if a completion notification goes unacknowledged past a threshold, the
    system's existing evidence (the completion post is on record; the next dispatch hasn't been
    pulled) is what the operator reads — not a delivery receipt. Do not build a watchdog or
    silence detector (withdrawn, see below); build an *acknowledgement* affordance that makes the
    operator's response the verifiable half of the loop. Scope this as a follow-up if it grows
    beyond the notification hook itself.
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
7. **A durable dedupe key per event**, safe across retries and across two instances. The key lives in the **same DB `config`-table seen-set mechanism the inbound poll uses** (`retire-comment-delta-dispatch.md` documents it: a capped seen-set in the DB `config` table, with `db.refreshFromDisk()` called before the dedupe check so two instances share state) — **not** a new in-process store, and **not** a wave at "use the existing machinery." A new outbound dedupe set under its own `config` key namespace (e.g. `outboundNotifySeen`) is acceptable if the inbound set's semantics do not fit; either way the store is on disk, shared, and refreshed-from-disk before the check. The key itself is `{planId, eventType, attemptFingerprint}` where `attemptFingerprint` identifies the originating transition (not the retry), so the 409-encouraged double-post produces one comment.
8. **Operator mention identity** resolved from config, with a visible error when it cannot be
   resolved rather than a comment that mentions nobody.

### Migration

Additive. No stored shape changes; unknown keys preserved on any extended config. Installs with no
tracker, or with remote control off, behave exactly as they do today.

## Resolved Assumptions

- **Provider mobile-app notification behaviour** (Linear, ClickUp) — **resolved by web research, 8 Sep 2026.** Threading is eliminated (flat top-level comments — the use case is a single operator, not a multi-collaborator card). Notion is out of scope (push is presence-suppressed unconditionally; the reliable fallback is a webhook-routed-own-channel larger than this plan). The findings that shaped the plan: the @-mention is the load-bearing push mechanism on both Linear and ClickUp; self-notification suppression means a distinct bot identity is mandatory; presence suppression means push is best-effort while the operator is at their desk; Linear uniquely exposes mobile notification settings via GraphQL for pre-flight. Recorded in the "Research Findings" section below.

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
8. **Mention actually notifies — Linear, with the desktop closed.** Verify a real push
   arrives on the operator's device **with the Linear desktop app/browser closed** (presence
   suppression is the dominant failure mode — an open session captures or suppresses the push).
   Confirm a misconfigured mention id surfaces an error rather than posting silently to nobody.
   **Linear** — confirm a flat top-level comment with a mention pushes, and that pre-flighting
   `notificationCategoryPreferences.mentions.mobile` + the mobile schedule warns correctly when
   off/out-of-window. **ClickUp** — confirm the flat top-level comment lands on the card and is
   readable in the tracker (work-history value). The mention push is best-effort; do not fail the
   test if ClickUp does not push (no bot identity exists in the codebase).
9. **Flat comments render.** Confirm flat top-level comments are readable in both providers'
   mobile apps — chronological history on the card. No threading to verify.
10. **Toggles are real.** With each event disabled, assert nothing is posted for it.
11. **Off by default where it should be.** With remote control off, or no tracker mapped, assert
    zero comments and zero API calls.
12. **Both providers** (Linear, ClickUp) reached through `RemoteProvider`.

### Goal Invariants

- **Positive:** a successful `POST /kanban/dispatch` for a single plan posts exactly one flat top-level comment on the plan's synced card (and a feature dispatch posts exactly one summarising comment, not one per subtask).
- **Positive:** a successful `POST /kanban/task/complete` posts exactly one flat top-level comment mentioning the operator, even when the completion is retried (the 409-encouraged double-post yields one comment).
- **Positive:** every auto-posted comment is stamped with the self-marker and is filtered by the inbound poll — never routed to a column agent as input (the loop guard).
- **Positive:** with remote control off, or no tracker mapped, zero comments and zero tracker API calls are made.
- **Negative:** no role's rendered agent prompt changes — diff a rendered prompt before and after and assert it is identical (the feature adds nothing to any role's context).
- **Negative:** a tracker failure (revoked token, network break, 429) does not fail dispatch or completion — the board continues and the failure is logged (notification is never in the critical path).
- **Negative:** no notification is posted via a path that bypasses `postManagedComment` (grep-asserted) — the marker stamping is load-bearing and a bypass reintroduces the self-ingestion loop.
- **Negative:** no notification is authored with the operator's own credentials on Linear — the Linear path uses `actor=app` OAuth (already built in `LinearSyncService.ts`), because self-notification suppression would silently kill every push. ClickUp posts with the stored `apiToken` (no bot concept in the codebase) — the comment lands for work history, the mention push is best-effort.
- **Negative:** no notification uses threading — no `parentId`, no `discussion_id`, no reply URL. All comments are flat top-level (grep-asserted: no `parentId` argument passed on the notification path).

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

## The stall event is withdrawn — silence and mtime are both retired inputs

*Appended after review. This supersedes the "Resolved — waking a quiet lead" section above, which
specified a fourth event type that must not be built.*

That section proposed surfacing `PlanIngestionEngine`'s feature-stall evidence — each remaining
subtask, its seat, how long that seat has been silent, and its plan-file mtime — as a comment that
mentions the operator. **Withdrawn.** Both of its inputs are inference the project has already
decided against, and pushing them to a phone is a worse version of a signal being removed from the
board.

**Silence.** `feature_plan_20260819160000_remove-silence-based-blocked-state-from-kanban.md` removes
the PTY-silence-driven "Waiting on you" badge, and its reasoning applies verbatim here: "Silence is
ambiguous — it cannot distinguish 'agent asked a question' from 'agent is thinking,' 'agent is
running a build,' 'agent crashed'… The result is a board that cries wolf." It records the operator's
own verdict: *"I don't want to be spammed with a hundred different bling."* A phone push is a louder
bling than a yellow ring, so the objection is stronger here, not weaker.

**mtime.** The four-part feature "Replace mtime-based completion detection with explicit API-based
completion" has landed for its main path — `PlanIngestionEngine.ts:623` now reads "mtime-based
completion detection is retired — the API POST…", and `POST /kanban/queue/done` is live at
`LocalApiServer.ts:7022`. `remove-mtime-based-completion-detection.md` states why: the assumption
that an mtime advance means completion "is wrong — the agent can edit the plan file mid-work for
many reasons (partial completion reports, plan updates, notes). The file watcher has no way to
distinguish a mid-work edit from a completion edit."

### What this leaves, and why it is better

The events this plan actually posts are **assertions, not inferences**. `POST /kanban/dispatch` is a
dispatch happening. `POST /kanban/task/complete` and `POST /kanban/queue/done` are a lead asserting
completion. There is no threshold to tune, no false-positive class, and nothing to mute.

And the silence problem solves itself without a detector: "dispatched X" followed by an hour of
nothing is legible to the operator precisely *because* the positive events are reliable. The human
is the detector, which is what the original requirement said — see a suspicious quiet, then ping.
Adding a machine detector was scope this plan invented, and it would have converted a clean signal
into a noisy one.

**No stall event, no liveness read, no mtime, no thresholds.** Dispatch and completion only.

### A finding worth its own decision

The mtime removal retired mtime as a *completion signal* but left it as *evidence in the stall
wake* (`PlanIngestionEngine.ts:98`, `:1253`, `:1261`, `:1269`, `:1079`). That is a defensible scope
boundary for that feature and a residue of a mechanism the project has otherwise abandoned. Given
the operator's position that the nudges were not worth their cost — the observed plan failure rate
being far lower than the machinery assumed — the live question is whether the feature-stall nudge
should exist at all, not whether to surface it. `fix-silent-nudge-noise-to-team-lead-in-team-coding-mode.md`
and `feature_plan_20260816170000_head-agent-wake-safeguard.md` (whose own risk list includes "the
nudge interrupting a working head, turning a safeguard into the cause of a broken turn") are the
right place to settle that. It is explicitly **not** in scope here.

## Corroboration and reuse notes from a plan sweep

*Appended after a sweep of existing plans.*

**The hook point was built for exactly this reason.**
`add-a-task-complete-endpoint-for-the-lead.md` is the plan that created
`POST /kanban/task/complete`, and its stated goal is this plan's premise in different words: give
the lead an explicit endpoint "so completion is an asserted signal rather than a file write the
orchestrator may or may not read, or a board state inferred from column position." Hooking that
route is therefore reading a signal designed to be authoritative, not inferring one — which is the
distinction the withdrawn stall event failed.

**Reuse the existing outbound/inbound discipline rather than writing new plumbing.**
`retire-comment-delta-dispatch.md` records that the comment-polling machinery is well built and
worth keeping even as the dispatch it feeds is retired: `authoredBySelf` against feedback loops, a
capped seen-set in the DB `config` table (against Notion's inclusive, minute-rounded cursor), and
at-least-once delivery that deliberately stalls the cursor on failure (`:909-912`). This plan's
dedupe requirement — durable, shared across two instances, safe across the retries the 409 flow
encourages — is the same problem that machinery already solves. Use it.

**Note the neighbouring retirement.** That plan removes comment-driven *dispatch*, not comment
polling, and is explicit that polling stays if any consumer needs it. This plan is a new outbound
consumer and does not depend on inbound dispatch, so the two do not conflict — but they touch the
same seam, and `orchestrator-instructions-column.md` is the designated inbound channel going
forward. If this plan's notifications ever want a reply affordance, that column is where it belongs,
not a revived comment trigger.
